'use strict';
/**
 * signs-cam.js - Unified Root SOME/IP Hub for Bimmer Drive (`1.0.0`).
 *
 * Replaces THREE separate SOME/IP connections / processes (`camera.js`, `nav.js`, and duplicate speed readers)
 * with ONE serialized `/usr/lib/someip.node` engine in a single V8 process:
 *   1. BMW Front Camera Traffic Sign Recognition (`SignRecognitionFrontCamera`)
 *   2. BMW Vehicle Speed & Odometer Distance Integration (`Vehicle2.statusCarSpeed2`)
 *   3. BMW Map / Camera-Matched Speed Limit (`dass.TrafficSignRecognition`, filtering 5 km/h garage codes)
 *   4. Dynamic Navigation / CarPlay / Android Auto Next-Turn Reader (`Guidance` + `GuidanceEventList`),
 *      active ONLY while AR arrows or the Navigation page want it (zero background RPC polling when AR is off).
 *
 * Node 8 (ES2017) compatible, zero external dependencies.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const oapgen = require('./oapgen-gen');

const DEFAULT_HOLD_KM = 0.5;
const DEFAULT_MIN_LIMIT = 10;
const ERR_LIMIT = Math.max(3, Number(process.env.BD_NAV_ERR_LIMIT) || 8);
const EMPTY_LIMIT = Math.max(1, Number(process.env.BD_NAV_EMPTY_LIMIT) || 5);

const TARGETS = {
    camera: { iface: 'de.bmw.environmentalmodel.SignRecognitionFrontCamera', broadcasts: ['TrafficSignRecognitionFrontCamera'] },
    speed: { iface: 'de.bmw.infotainment.vehicle.Vehicle2', attributes: { statusCarSpeed2: 's' } },
    map: { iface: 'de.bmw.dass.TrafficSignRecognition', broadcasts: ['TrafficSignRecognition'] },
};

const MAP_NONE = 254, MAP_MAX_CLASS = 30, MAP_HOLD_KM = 1, MAP_STALE_MS = 10000;
const WITHDRAWN = /^(WITHDRAW|CANCEL|END|DERESTRICT|UNLIMITED)/i;
const OFF_ROAD = /(OFF_?ROAD|PARKING|GARAGE|UNPAVED|NO_?MATCH|INVALID)/i;
const CAM_ONLY_MATCH = /CAMERA_?ONLY/i;

function mapPick(v, minLimit) {
    if (!v || typeof v !== 'object') return null;
    const min = Number.isFinite(minLimit) && minLimit >= 5 ? minLimit : DEFAULT_MIN_LIMIT;
    const cls = Number(v.presentClassLimitSpeed), unit = Number(v.unitOfMeasurementSpeedLimit);
    if (!Number.isFinite(cls)) return null;
    const wd = v.presentWithdrawalLimitSpeed, stType = v.statusStreetTyp, dm = v.statusDataMatchingCameraADAS;
    const withdrawn = typeof wd === 'string' && !/^(NO_|NOT_|NONE|SIGNAL_UNFILLED)/i.test(wd) && WITHDRAWN.test(wd);
    const offRoad = (typeof stType === 'string' && OFF_ROAD.test(stType)) || (typeof dm === 'string' && OFF_ROAD.test(dm)) || dm === 0;
    const raw = !withdrawn && !offRoad && Number.isInteger(cls) && cls >= 1 && cls <= MAP_MAX_CLASS && (!Number.isFinite(unit) || unit === 0) ? cls * 5 : 0;
    const kmh = raw >= min ? raw : 0;
    const low = raw > 0 && raw < min ? raw : 0;
    const next = Number.isFinite(Number(v.nextClassLimitSpeed)) ? Number(v.nextClassLimitSpeed) : null;
    const nextRaw = next !== null && Number.isInteger(next) && next >= 1 && next <= MAP_MAX_CLASS && (!Number.isFinite(unit) || unit === 0) ? next * 5 : 0;
    const matchVal = Number.isFinite(Number(dm)) ? Number(dm) : (typeof dm === 'string' ? dm : null);
    return { cls, limit: kmh, low, unit: Number.isFinite(unit) ? unit : null, match: matchVal,
        next, nextLimit: nextRaw >= min ? nextRaw : 0 };
}

function onMap(st, v, now, log) {
    const p = mapPick(v, st.minLimit);
    if (!p) return;
    const m = st.map;
    if (m.at && now - m.at < 3000 && now > m.at) { if (++m.quick >= 5) m.periodic = true; } else m.quick = 0;
    if (p.cls !== m.cls && log) {
        log('map: class ' + p.cls + (p.limit ? ' = ' + p.limit + ' km/h' : p.low ? ' (' + p.low + ' km/h inner/parking, ignored)'
            : p.cls === MAP_NONE ? ' (no sign)' : ' (not a limit known here)'));
    }
    m.cls = p.cls; m.limit = p.limit; m.low = p.low; m.unit = p.unit; m.match = p.match; m.next = p.next; m.nextLimit = p.nextLimit;
    m.raw = v; m.at = now; m.odo = st.odo; m.events++;
}

function mapCurrent(st, now, cameraAllowed) {
    const m = st.map;
    if (!m.at) return 0;
    const p = m.raw ? mapPick(m.raw, st.minLimit) : null;
    const lim = p ? p.limit : m.limit;
    if (!lim) return 0;
    if (cameraAllowed === false && typeof m.match === 'string' && CAM_ONLY_MATCH.test(m.match)) return 0;
    if (st.up.map === false) return 0;
    if (now < m.at - 5000) return 0;
    if (m.periodic) return now - m.at <= MAP_STALE_MS ? lim : 0;
    if (st.odo - m.odo > MAP_HOLD_KM || now - m.at > st.holdMin * 60000) return 0;
    return lim;
}

const NOT_FOR_US = /TRUCK|TRAILER|BUS|LORRY|HGV|WEIGHT|TONN|TRACTOR|HAZARD|DANGEROUS|RAIN|SNOW|FOG|WET|ICE|TIME|DISTANCE|EXIT|SCHOOL|WORK|NIGHT|DAY|ARROW/;
const PLAIN = /^(SIGNAL_UNFILLED|NO_ADDITIONAL_RESTRICTION|GENERIC_SUPPLEMENTAL|NONE|NO_SUPPLEMENTAL.*)?$/;
const SPEED = /SPEED_LIMIT/, NOT_A_LIMIT = /END|CANCEL|MINIMUM|RECOMMEND|ADVIS|ZONE_END/;
const END = /(END|CANCEL|DERESTRICT)/, ENDS_WHAT = /(SPEED|LIMIT|ALL_RESTRICTION|RESTRICTIONS)/;

function pick(v, minLimit) {
    if (!v || typeof v !== 'object' || !Array.isArray(v.trafficSign)) return null;
    if (v.eventDataQualifier && v.eventDataQualifier !== 'EVENT_DATA_AVAILABLE') return null;
    const min = Number.isFinite(minLimit) && minLimit >= 5 ? minLimit : DEFAULT_MIN_LIMIT;
    const r = v.trafficSignRecognition || {};
    if (r.speedLimitUnit && r.speedLimitUnit !== 'KM_H') return null;
    const n = Number.isFinite(r.numberSigns) ? r.numberSigns : v.trafficSign.length;
    const signs = v.trafficSign.slice(0, n);
    const count = {}, values = [];
    let end = false, low = 0;
    signs.forEach((g) => {
        const type = String((g && g.type) || '');
        if (END.test(type) && ENDS_WHAT.test(type)) { end = true; return; }
        if (!SPEED.test(type) || NOT_A_LIMIT.test(type)) return;
        const value = Number(g.value);
        if (!(value >= 5 && value <= 150 && value % 5 === 0)) return;
        if (value < min) { low = value; return; }
        values.push(value);
        const plates = [g.firstSupplementalType, g.secondSupplementalType, g.additionalInfo].map((x) => String(x || ''));
        if (plates.some((x) => !PLAIN.test(x) && NOT_FOR_US.test(x))) return;
        count[value] = (count[value] || 0) + 1;
    });
    const kept = Object.keys(count).map(Number);
    if (!kept.length) {
        if (low && !values.length && !end) return { limit: 0, end: false, values: [], single: false, low };
        return values.length || end ? { limit: 0, end, values, single: false } : null;
    }
    kept.sort((a, b) => count[b] - count[a] || b - a);
    return { limit: kept[0], end: false, values, single: kept.length === 1 };
}

function createState(opts) {
    opts = opts || {};
    return {
        holdKm: Number.isFinite(opts.holdKm) && opts.holdKm > 0 ? opts.holdKm : DEFAULT_HOLD_KM,
        holdMin: opts.holdMin || 15, parkMin: opts.parkMin || 3, confirmMs: opts.confirmMs || 8000,
        minLimit: Number.isFinite(opts.minLimit) && opts.minLimit >= 5 ? opts.minLimit : DEFAULT_MIN_LIMIT,
        limit: 0, low: 0, at: 0, km: 0, candidate: 0, candidateAt: 0, events: 0, signs: '', lastEventAt: 0,
        speed: null, speedAt: 0, stillAt: 0, up: { camera: null, speed: null, map: null }, error: null, ready: false,
        odo: 0,
        map: { cls: null, limit: 0, low: 0, unit: null, match: null, next: null, nextLimit: 0, raw: null, at: 0, odo: 0, events: 0, quick: 0, periodic: false, error: null, ready: false },
    };
}

function onEvent(st, v, now, log) {
    st.events++;
    st.lastEventAt = now;
    const p = pick(v, st.minLimit);
    if (!p) return st.limit;
    st.low = p.low || 0;
    st.signs = p.values.join(',') + (p.end ? ' end' : '');
    if (p.limit) {
        const take = !st.limit || p.limit === st.limit || p.single
            || (st.candidate === p.limit && now - st.candidateAt < st.confirmMs);
        if (take) {
            if (p.limit !== st.limit && log) log('camera: sign ' + p.limit + ' (saw ' + p.values.join(', ') + ')');
            st.limit = p.limit; st.at = now; st.km = 0; st.candidate = 0;
        } else { st.candidate = p.limit; st.candidateAt = now; }
    } else if (p.end && st.limit) {
        if (log) log('camera: end of ' + st.limit);
        st.limit = 0; st.at = now; st.km = 0; st.candidate = 0;
    }
    return st.limit;
}

function onSpeed(st, v, now) {
    const raw = v && v.speedVehicleCentreOfGravity;
    if (!Number.isFinite(raw) || raw === 65535) return;
    const kmh = raw * 0.015625;
    if (st.speed !== null && now - st.speedAt < 2000 && now > st.speedAt) {
        const d = (st.speed + kmh) / 2 * (now - st.speedAt) / 3600000;
        st.km += d;
        st.odo += d;
    }
    st.speed = Math.round(kmh * 10) / 10;
    st.speedAt = now;
    if (st.speed <= 1) { if (!st.stillAt) st.stillAt = now; } else st.stillAt = 0;
}

function current(st, now, log) {
    if (!st.limit) return 0;
    if (st.limit < (st.minLimit || DEFAULT_MIN_LIMIT)) {
        st.low = st.limit; st.limit = 0; st.km = 0;
        return 0;
    }
    const driven = st.km + 1e-9 >= st.holdKm;
    const stale = now - st.at > st.holdMin * 60000;
    const parked = !!(st.stillAt && now - st.stillAt > (st.parkMin || 3) * 60000 && now - st.at > (st.parkMin || 3) * 60000);
    if (driven || stale || parked) {
        if (log) log('camera: ' + st.limit + ' dropped (' + (driven ? st.km.toFixed(1) + ' km driven' : parked ? 'parked ' + (st.parkMin || 3) + ' min' : 'held ' + st.holdMin + ' min') + ')');
        st.limit = 0; st.km = 0;
    }
    return st.limit;
}

function speed(st, now) { return st.speed !== null && now - st.speedAt < 2000 ? st.speed : null; }

/* ---------------- Navigation / CarPlay / Android Auto Next-Turn Pure Parsers ---------------- */

function findInterfaces(db) {
    const all = (db && db.interfaces) || {};
    return Object.keys(all).filter((n) => /(^|\.)Guidance[A-Za-z0-9]*$/.test(n) || /guiding/i.test(n)).map((name) => {
        const i = all[name] || {};
        return { name, fields: Object.keys(i.fields || {}), broadcasts: Object.keys(i.broadcasts || i.events || {}), methods: Object.keys(i.methods || {}) };
    });
}

function pickFields(iface) {
    const f = iface.fields || [];
    const first = (re) => f.filter((n) => re.test(n))[0];
    const out = {};
    const dart = first(/^conclusiveDart$/i) || first(/conclusive/i) || first(/dart/i) || first(/maneuver|manoeuvre/i);
    const state = first(/^guidanceStateWithReason$/i) || first(/^guidanceState$/i) || first(/guidanceState/i);
    const provider = first(/guidingProvider/i) || first(/provider/i);
    if (dart) out.dart = dart;
    if (state) out.state = state;
    if (provider) out.provider = provider;
    return out;
}

function enumTables(db) {
    const types = (db && db.datatypes) || {};
    const out = { direction: {}, unit: {}, any: {} };
    Object.keys(types).forEach((k) => {
        const d = types[k];
        if (!d || d.type !== 'enum' || !d.items) return;
        const names = Object.keys(d.items);
        const table = {};
        names.forEach((n) => { const v = d.items[n]; table[typeof v === 'object' && v ? v.value : v] = n; });
        if (names.indexOf('SLIGHT_LEFT') >= 0 && names.indexOf('UTURN_LEFT') >= 0 && !Object.keys(out.direction).length) out.direction = table;
        if (names.indexOf('METER') >= 0 && names.indexOf('KM') >= 0 && !Object.keys(out.unit).length) out.unit = table;
    });
    return out;
}

const DIR = {
    NONE: 0, STRAIGHT_ON: 0, STRAIGHT: 0, SLIGHT_LEFT: -30, LEFT: -90, HARD_LEFT: -135, SHARP_LEFT: -135, UTURN_LEFT: -180,
    SLIGHT_RIGHT: 30, RIGHT: 90, HARD_RIGHT: 135, SHARP_RIGHT: 135, UTURN_RIGHT: 180, UTURN: -180,
};
const TO_M = { METER: 1, M: 1, KM: 1000, KILOMETER: 1000, FEET: 0.3048, FT: 0.3048, YARD: 0.9144, YD: 0.9144, MILE_UK: 1609.344, MILE_US: 1609.344, MILE: 1609.344 };
const KINDS = { intersection: 'turn', branch: 'turn', roundabout: 'roundabout', destinationManeuver: 'destination', alongMainRoad: 'straight', tunnel: 'straight' };

function enumName(v, table) {
    if (typeof v === 'string') return v.toUpperCase();
    if (v && typeof v === 'object') {
        if (typeof v.name === 'string') return v.name.toUpperCase();
        if (typeof v.value === 'string') return v.value.toUpperCase();
        if (typeof v.value === 'number') v = v.value;
    }
    if (typeof v === 'number' && table && table[v] !== undefined) return String(table[v]).toUpperCase();
    return null;
}

function findBody(v, depth, tag) {
    if (!v || typeof v !== 'object' || depth > 6) return null;
    if (!Array.isArray(v) && (v.formattedDistance !== undefined || v.rawDistance !== undefined || v.distanceToDestination !== undefined) &&
        (v.direction !== undefined || v.branchType !== undefined || v.exitNumber !== undefined || v.isCheckeredFlag !== undefined ||
            v.mainRoadDirection !== undefined || v.guidingStep !== undefined)) {
        return { tag: tag || null, body: v };
    }
    const named = typeof v.type === 'string' ? v.type : typeof v.member === 'string' ? v.member : typeof v.selected === 'string' ? v.selected : null;
    const keys = Array.isArray(v) ? v.map((x, i) => i) : Object.keys(v);
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const child = v[k];
        if (!child || typeof child !== 'object') continue;
        const t = KINDS[k] ? k : named && (k === 'value' || k === 'data') ? named : tag;
        const hit = findBody(child, depth + 1, t);
        if (hit) return hit;
    }
    return null;
}

function maneuver(dart, tables, textOnly) {
    const t = tables || {};
    const hit = findBody(dart, 0, null);
    if (!hit) return { kind: null, angle: 0, meters: -1, exit: 0 };
    const b = hit.body;
    let kind = hit.tag ? KINDS[hit.tag] || null : null;
    if (!hit.tag) {
        kind = b.direction !== undefined || b.branchType !== undefined ? 'turn' : b.exitNumber !== undefined ? 'roundabout'
            : b.isCheckeredFlag !== undefined ? 'destination' : b.mainRoadDirection !== undefined ? 'straight' : null;
    }
    if (!kind) return { kind: null, angle: 0, meters: -1, exit: 0 };
    let angle = 0, exit = 0;
    if (kind === 'turn') {
        const d = enumName(b.direction !== undefined ? b.direction : b.branchType, t.direction);
        const SLIGHT = /SLIGHT|KEEP|BEAR|HALF|EASY|LIGHT|FORK|RAMP|EXIT|MERGE|FORWARD|DIAGONAL|BRANCH/;
        if (d && DIR[d] !== undefined) angle = DIR[d];
        else if (d && /LEFT/.test(d)) angle = SLIGHT.test(d) ? -30 : /SHARP|HARD/.test(d) ? -135 : -90;
        else if (d && /RIGHT/.test(d)) angle = SLIGHT.test(d) ? 30 : /SHARP|HARD/.test(d) ? 135 : 90;
        const fork = hit.tag === 'branch' || (b.direction === undefined && b.branchType !== undefined);
        if (fork && Math.abs(angle) > 30 && Math.abs(angle) < 180) angle = angle < 0 ? -30 : 30;
        if (!angle) kind = 'straight';
    } else if (kind === 'roundabout') {
        exit = Number(b.exitNumber) || 0;
        angle = enumName(b.driveDirection, null) === 'LEFT' ? -45 : 45;
    }
    let meters = -1;
    const fd = b.formattedDistance;
    if (fd && typeof fd === 'object') {
        if (!textOnly && typeof fd.rawDistance === 'number' && fd.rawDistance >= 0 && fd.rawDistance < 1e7) meters = fd.rawDistance;
        else {
            const n = parseFloat(String(fd.distance || '').replace(',', '.'));
            const u = enumName(fd.unit, t.unit);
            if (Number.isFinite(n) && u && TO_M[u]) meters = n * TO_M[u];
        }
    }
    if (meters < 0 && !textOnly && typeof b.rawDistance === 'number' && b.rawDistance >= 0) meters = b.rawDistance;
    const out = { kind, angle, meters: meters < 0 ? -1 : Math.round(meters), exit };
    if (kind === 'turn') Object.defineProperty(out, 'named', { value: (hit.tag || '?') + ':' + enumName(b.direction !== undefined ? b.direction : b.branchType, t.direction), enumerable: false });
    const desc = b['description'];
    const els = desc && Array.isArray(desc.elements) ? desc.elements : [];
    const street = els.map((e) => (e && typeof e.text === 'string' ? e.text : e && typeof e.value === 'string' && (e.type === undefined || e.type === 'text') ? e.value : '')).filter(Boolean).join(' ').trim().slice(0, 60);
    if (street) out.street = street;
    return out;
}

function eventsOf(reply, depth) {
    if (!reply || typeof reply !== 'object' || (depth || 0) > 5) return [];
    if (Array.isArray(reply.eventsInView)) return reply.eventsInView;
    const keys = Object.keys(reply);
    for (let i = 0; i < keys.length; i++) {
        const v = reply[keys[i]];
        if (v && typeof v === 'object') { const e = eventsOf(v, (depth || 0) + 1); if (e.length) return e; }
    }
    return [];
}

function eventManeuver(reply, tables) {
    const list = eventsOf(reply, 0);
    for (let i = 0; i < list.length; i++) {
        const m = maneuver({ maneuver: list[i] }, tables, true);
        if (m.kind && m.meters >= 0) return m;
    }
    return { kind: null, angle: 0, meters: -1, exit: 0 };
}

function queryRequest(shape, numeric) {
    const E = numeric ? { CCP: 0, INCLUDE_ACTIVE_MANEUVERS: 1, INCLUDE_DESTINATIONS: 2, INCLUDE_TUNNELS: 7, INCLUDE_ALONG_MAIN_ROAD: 18 } : null;
    const e = (n) => (E ? E[n] : n);
    const anchor = shape === 'typed' ? { type: 'standardReferencePoint', value: e('CCP') } : { standardReferencePoint: e('CCP') };
    return { viewConfigs: [{
        viewport: { startPoint: { anchorPoint: anchor, offsets: [] }, maxElementCount: 4, endPoints: [],
            includedTypes: ['INCLUDE_ACTIVE_MANEUVERS', 'INCLUDE_DESTINATIONS', 'INCLUDE_TUNNELS', 'INCLUDE_ALONG_MAIN_ROAD'].map(e) },
        options: [], minimumUpdateIntervalMs: 0, segmentItemRasterLength: 0,
    }] };
}

function navOf(values, tables) {
    let m = maneuver(values.dart, tables);
    if (!m.kind && values.events) m = eventManeuver(values.events, tables);
    const state = enumName(values.state && typeof values.state === 'object' && values.state.state !== undefined ? values.state.state : values.state, null);
    const provider = enumName(values.provider, null);
    const off = state && /INACTIVE|NOT_ACTIVE|OFF|STOPPED|NONE/.test(state);
    const active = !!m.kind && (m.meters >= 0 || !off);
    return Object.assign({ active, kind: m.kind, angle: m.angle, meters: m.meters, exit: m.exit, provider: provider || '', state: state || '' }, m.street ? { street: m.street } : {});
}

/* ---------------- Single-Process Serialized SOME/IP Binding Hub ---------------- */

let chain = Promise.resolve();
function nativeTick(fn) {
    const run = () => new Promise((resolve, reject) => setImmediate(() => {
        try { Promise.resolve(fn()).then(resolve, reject); } catch (e) { reject(e); }
    }));
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
}

const within = (p, ms, what) => Promise.race([
    p,
    new Promise((r, j) => setTimeout(() => j(new Error(what + ': no answer in ' + ms + ' ms')), ms)),
]);

function generateTarget(o, key, customEntry) {
    const t = customEntry || TARGETS[key];
    const dir = path.join(o.run, 'someip', key);
    const out = path.join(dir, t.iface.replace(/\./g, '_') + '.json');
    return new Promise((resolve, reject) => {
        try { return resolve(JSON.parse(fs.readFileSync(out, 'utf8'))); } catch (e) { /* generate below */ }
        [o.run, path.join(o.run, 'someip'), dir].forEach((d) => { try { fs.mkdirSync(d); } catch (e) { /* exists */ } });
        const entry = { instances: t.instances || '1' };
        if (t.attributes) entry.attributes = t.attributes;
        if (t.broadcasts) entry.broadcasts = t.broadcasts;
        if (t.methods) entry.methods = t.methods;
        const proxies = {};
        proxies[t.iface] = entry;
        const manifest = { proxies, services: {} };
        // Prefer fast in-memory generation if no custom generator script override was passed (tests may pass custom gen)
        if (!o.customGen) {
            try {
                const db = o.dbCache || JSON.parse(fs.readFileSync(o.catalog, 'utf8'));
                const ifs = oapgen.generateInMemory(db, manifest);
                if (ifs && ifs[t.iface]) {
                    fs.writeFileSync(out, JSON.stringify(ifs[t.iface]));
                    return resolve(ifs[t.iface]);
                }
            } catch (e) { /* fall back to CLI generator */ }
        }
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
        cp.execFile(process.execPath, [o.gen, o.catalog, path.join(dir, 'manifest.json'), '0', path.join(dir, 'gen')], { timeout: 30000 }, (err, so, se) => {
            if (err) {
                const line = String(se || so || err.message).split('\n').filter((l) => /Error/.test(l) && l.length < 400)[0];
                return reject(new Error('generator: ' + (line || err.message)));
            }
            try {
                const text = fs.readFileSync(path.join(dir, 'gen', path.basename(out)), 'utf8');
                fs.writeFileSync(out, text);
                resolve(JSON.parse(text));
            } catch (e) { reject(new Error('generator made nothing: ' + e.message)); }
        });
    });
}

/**
 * Starts the unified SOME/IP hub for signs, speed, map speed limit, and dynamic navigation turns.
 * Returns controller `{ held, setNavWanted(bool), navState() }`.
 */
function start(st, o) {
    const log = o.log || (() => {});
    const held = [], done = {};
    let binding = null;
    const nav = { wanted: false, started: false, starting: false, state: 'not started', ifaces: [], proxies: [], note: '', last: null, raw: '', at: 0 };
    const navTimers = [];
    const navValues = {};
    let navTables = { direction: {}, unit: {}, any: {} };
    let navLastJson = '';

    const getBinding = () => {
        if (!binding) binding = typeof o.someip === 'string' ? require(o.someip) : o.someip;
        return binding;
    };

    const attempt = () => {
        try { getBinding(); } catch (e) { st.error = 'no SOME/IP binding: ' + e.message; return; }
        const one = (key, member, handler) => (done[key] ? Promise.resolve() : generateTarget(o, key)
            .then((cfg) => nativeTick(() => binding.buildProxy(cfg, '1').then((p) => p.init().then(() => p))))
            .then((p) => {
                held.push(p);
                return nativeTick(() => {
                    try { p.subscribeToAvailability((a) => { if (st.up[key] !== !!a) log(key + ': ' + (a ? 'available' : 'not available')); st.up[key] = !!a; }); } catch (e) {}
                }).then(() => nativeTick(() => p.subscribe({ name: member, onReceive: (v) => { try { handler(v, Date.now()); } catch (e) { log(key + ': ' + e.message); } } })))
                    .then(() => { done[key] = true; });
            }));
        Promise.all([
            one('camera', 'TrafficSignRecognitionFrontCamera', (v, now) => onEvent(st, v, now, log)),
            one('speed', 'statusCarSpeed2', (v, now) => onSpeed(st, v, now)),
        ]).then(() => { st.ready = true; st.error = null; log('camera & speed: listening'); })
            .catch((e) => { st.error = String((e && e.message) || e).slice(0, 200); log('camera: ' + st.error + ' (again in 60 s)'); setTimeout(attempt, 60000); });
    };
    attempt();

    const mapAttempt = () => {
        if (!binding) { setTimeout(mapAttempt, 5000); return; }
        generateTarget(o, 'map')
            .then((cfg) => nativeTick(() => binding.buildProxy(cfg, '1').then((p) => p.init().then(() => p))))
            .then((p) => {
                held.push(p);
                return nativeTick(() => {
                    try { p.subscribeToAvailability((a) => { if (st.up.map !== !!a) log('map: ' + (a ? 'available' : 'not available')); st.up.map = !!a; }); } catch (e) {}
                }).then(() => nativeTick(() => p.subscribe({ name: 'TrafficSignRecognition', onReceive: (v) => { try { onMap(st, v, Date.now(), log); } catch (e) { log('map: ' + e.message); } } })));
            })
            .then(() => { st.map.ready = true; st.map.error = null; log('map: listening'); })
            .catch((e) => { st.map.error = String((e && e.message) || e).slice(0, 200); log('map: ' + st.map.error + ' (again in 60 s)'); setTimeout(mapAttempt, 60000); });
    };
    if (o.map !== false) mapAttempt();

    const emitNavChanged = () => {
        const cur = navOf(navValues, navTables);
        const s = JSON.stringify(cur);
        if (s !== navLastJson) {
            navLastJson = s;
            const now = Date.now();
            nav.last = Object.assign({}, cur, { at: now });
            nav.at = now;
            if (o.onNav) { try { o.onNav(nav.last, now); } catch (e) {} }
        }
    };

    async function initNavOnce() {
        if (nav.started || nav.starting) return;
        nav.starting = true;
        nav.state = 'starting';
        let db;
        try { db = JSON.parse(fs.readFileSync(o.catalog, 'utf8')); } catch (e) {
            nav.starting = false;
            nav.state = 'failed to start';
            nav.note = 'no catalog: ' + String(e.message || e).slice(0, 140);
            return;
        }
        const ifaces = findInterfaces(db);
        nav.ifaces = ifaces.map((i) => i.name);
        navTables = enumTables(db);
        if (!ifaces.length) {
            nav.starting = false;
            nav.started = true;
            nav.state = 'no interface';
            db = null;
            return;
        }
        nav.state = 'found';
        try { getBinding(); } catch (e) {
            nav.starting = false;
            nav.state = 'failed to start';
            nav.note = 'no someip: ' + String(e.message || e).slice(0, 140);
            db = null;
            return;
        }
        let idx = 0, upCount = 0;
        for (let ii = 0; ii < ifaces.length; ii++) {
            const iface = ifaces[ii];
            const picked = pickFields(iface);
            const fNames = Object.keys(picked);
            const qm = /EventList/i.test(iface.name) ? ((iface.methods || []).filter((x) => /^queryContent$/i.test(x))[0] || (iface.methods || []).filter((x) => /query/i.test(x))[0]) : null;
            if (qm) {
                let cfg;
                try { cfg = await generateTarget(Object.assign({}, o, { dbCache: db }), 'nav_' + (idx++), { iface: iface.name, instances: '*', methods: [qm] }); } catch (e) {
                    nav.proxies.push('failed ' + iface.name.split('.').pop() + ': ' + String(e.message || e).slice(0, 120));
                    continue;
                }
                const instKeys = Object.keys(cfg.instances || { 1: 1 });
                for (let ki = 0; ki < instKeys.length; ki++) {
                    const inst = instKeys[ki];
                    let p;
                    try {
                        p = await within(nativeTick(() => binding.buildProxy(cfg, String(inst)).then((px) => px.init().then(() => px))), 6000, 'proxy');
                    } catch (e) {
                        nav.proxies.push('failed ' + iface.name.split('.').pop() + '@' + inst);
                        continue;
                    }
                    held.push(p);
                    upCount++;
                    nav.proxies.push('ok ' + iface.name.split('.').pop() + '@' + inst);
                    nav.state = 'reading';
                    const tries = [['keyed', false], ['typed', false], ['keyed', true], ['typed', true]];
                    let good = -1, at = 0, busy = false, fails = 0, errStreak = 0, emptyStreak = 0, lastReply = '';
                    const iv = setInterval(() => {
                        if (!nav.wanted || busy) return;
                        if (maneuver(navValues.dart, navTables).kind) return;
                        const d = navValues.dart && navValues.dart.maneuver;
                        const first = d && typeof d === 'object' && typeof d.type === 'string' ? 1 : 0;
                        const k = good >= 0 ? good : (at + first) % tries.length;
                        busy = true;
                        within(nativeTick(() => p.callMethod(qm, queryRequest(tries[k][0], tries[k][1]), 3000)), 4500, qm).then((r) => {
                            busy = false;
                            fails = 0;
                            errStreak = 0;
                            if (good < 0) good = k;
                            const s = String(JSON.stringify(r) || '').slice(0, 400);
                            const same = s.replace(/"uid":"?\d+"?/g, '');
                            if (same !== lastReply) { lastReply = same; nav.raw = s; }
                            const m = eventManeuver(r, navTables);
                            if (m.kind) {
                                emptyStreak = 0;
                                navValues.events = r;
                                emitNavChanged();
                            } else if (!navValues.events || !eventManeuver(navValues.events, navTables).kind || ++emptyStreak >= EMPTY_LIMIT) {
                                emptyStreak = 0;
                                navValues.events = r;
                                emitNavChanged();
                            }
                        }, () => {
                            busy = false;
                            if (good < 0) at++;
                            else if (++fails > 20) { good = -1; fails = 0; }
                            if (++errStreak >= ERR_LIMIT && navValues.events) {
                                navValues.events = null;
                                emptyStreak = 0;
                                lastReply = '';
                                emitNavChanged();
                            }
                        });
                    }, 1000);
                    navTimers.push(iv);
                }
                continue;
            }
            if (!picked.dart) continue;
            const rawFields = (db.interfaces && db.interfaces[iface.name] && db.interfaces[iface.name].fields) || {};
            const attributes = {};
            fNames.forEach((k) => {
                const fd = rawFields[picked[k]] || {};
                attributes[picked[k]] = (fd.noGetter || fd.getter === null) ? 's' : 'rs';
            });
            let cfg;
            try { cfg = await generateTarget(Object.assign({}, o, { dbCache: db }), 'nav_' + (idx++), { iface: iface.name, instances: '*', attributes }); } catch (e) {
                nav.proxies.push('failed ' + iface.name.split('.').pop() + ': ' + String(e.message || e).slice(0, 120));
                continue;
            }
            const instKeys = Object.keys(cfg.instances || { 1: 1 });
            for (let ki = 0; ki < instKeys.length; ki++) {
                const inst = instKeys[ki];
                let p;
                try {
                    p = await within(nativeTick(() => binding.buildProxy(cfg, String(inst)).then((px) => px.init().then(() => px))), 6000, 'proxy');
                } catch (e) {
                    nav.proxies.push('failed ' + iface.name.split('.').pop() + '@' + inst);
                    continue;
                }
                held.push(p);
                upCount++;
                nav.proxies.push('ok ' + iface.name.split('.').pop() + '@' + inst);
                nav.state = 'reading';
                fNames.forEach((k) => {
                    const got = (v) => {
                        navValues[k] = v;
                        if (/dart|maneuver/i.test(picked[k])) nav.raw = String(JSON.stringify(v) || '').slice(0, 400);
                        emitNavChanged();
                    };
                    nativeTick(() => p.subscribe({ name: picked[k], onReceive: got })).catch(() => {});
                    const pollField = () => {
                        if (!nav.wanted) return;
                        nativeTick(() => p.getValue(picked[k], 3000)).then(got, () => {});
                    };
                    setTimeout(pollField, 500);
                    navTimers.push(setInterval(pollField, 5000));
                });
            }
        }
        db = null;
        nav.starting = false;
        nav.started = upCount > 0;
        if (!upCount) {
            nav.state = 'ended';
            nav.note = 'no guidance interface opened';
        }
    }

    let navRetryAfter = 0;
    function setNavWanted(want, now) {
        const t = now || Date.now();
        nav.wanted = !!want;
        if (nav.wanted && !nav.started && !nav.starting && t >= navRetryAfter) {
            navRetryAfter = t + 30000;
            initNavOnce().catch((e) => {
                nav.starting = false;
                nav.state = 'ended';
                nav.note = String((e && e.message) || e).slice(0, 160);
            });
        }
    }

    function stop() {
        nav.wanted = false;
        while (navTimers.length) clearInterval(navTimers.pop());
    }

    return {
        held,
        setNavWanted,
        navState: (now) => ({
            wanted: nav.wanted,
            state: nav.state,
            ifaces: nav.ifaces.slice(0, 6),
            proxies: nav.proxies.slice(-4),
            note: nav.note,
            raw: nav.raw,
            last: nav.last,
            age: nav.last ? (now || Date.now()) - nav.last.at : -1,
        }),
        stop,
    };
}

module.exports = {
    mapPick, onMap, mapCurrent, MAP_NONE, DEFAULT_HOLD_KM, DEFAULT_MIN_LIMIT,
    pick, createState, onEvent, onSpeed, current, speed, start, TARGETS,
    findInterfaces, pickFields, enumTables, maneuver, navOf, eventManeuver, queryRequest,
};
