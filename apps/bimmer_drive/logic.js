'use strict';
/**
 * logic.js - Pure decision & geometry logic for Camera & VietMap (`bimmer_drive`).
 * Includes all 0.8.1 blinker/camera/AR stability rules + Vietnamese speed-sign & WOC mirror reporting.
 * Node 8 (ES2017) compatible.
 */

const CONTROL = {
    BLINKEN_AUS: 0, KEIN_BLINKEN: 0, AUS: 0, OFF: 0, NONE: 0, INAKTIV: 0, INACTIVE: 0,
    TIPP_BLINKEN_LINKS_EIN: 1, TIPP_BLINKEN_RECHTS_EIN: 2,
    DAUER_BLINKEN_LINKS_EIN: 3, DAUER_BLINKEN_RECHTS_EIN: 4,
    BEIDSEITIGES_BLINKEN_EIN: 8, WARNBLINKEN_EIN: 8,
};
const CONTROL_DIR = { 0: 'OFF', 1: 'LEFT', 2: 'RIGHT', 3: 'LEFT', 4: 'RIGHT', 8: 'HAZARD' };
const CONTROL_KIND = { 1: 'tip', 2: 'tip', 3: 'steady', 4: 'steady' };
const ACTIVE_DIR = { 0: 'OFF', 6: 'HAZARD', 7: 'LEFT', 8: 'RIGHT', 9: 'LEFT', 10: 'RIGHT' };

function field(value, key) {
    if (!value || typeof value !== 'object') return undefined;
    if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];
    const keys = Object.keys(value);
    for (let i = 0; i < keys.length; i++) {
        const found = field(value[keys[i]], key);
        if (found !== undefined) return found;
    }
    return undefined;
}

function decode(value) {
    const command = field(value, 'controlIndicateDirection');
    const active = field(value, 'activeFunctionIndicateDirection');
    const cStr = command === undefined || command === null ? '' : String(command).trim();
    const cUpper = cStr.toUpperCase();
    const code = Object.prototype.hasOwnProperty.call(CONTROL, command) ? CONTROL[command]
        : Object.prototype.hasOwnProperty.call(CONTROL, cUpper) ? CONTROL[cUpper]
            : /^-?\d+$/.test(cStr) ? Number(cStr) : command;
    let commanded = CONTROL_DIR[code];
    if (!commanded && typeof command === 'string' && cStr) {
        commanded = /^(?:BLINKEN_AUS|KEIN_BLINKEN|AUS|OFF|NONE|INAKTIV|INACTIVE)$/i.test(cStr) ? 'OFF'
            : /^(?:WARN_?BLINK|BEIDSEITIG|HAZARD)/i.test(cStr) ? 'HAZARD'
                : /(?:BLINKEN|INDICAT).*(?:LINKS|LEFT)|^(?:LINKS|LEFT)$/i.test(cStr) ? 'LEFT'
                    : /(?:BLINKEN|INDICAT).*(?:RECHTS|RIGHT)|^(?:RECHTS|RIGHT)$/i.test(cStr) ? 'RIGHT' : undefined;
    }
    const a = active === undefined || active === null ? '' : String(active).trim();
    const aKey = a && /^-?\d+$/.test(a) ? Number(a) : active;
    const observed = (active !== undefined && active !== null ? ACTIVE_DIR[aKey] : undefined)
        || (a && /^(?:BLINKEN_AUS|KEIN_BLINKEN|AUS|OFF|NONE|INAKTIV|INACTIVE)$/i.test(a) ? 'OFF' : undefined)
        || (a && /^(?:DAUER_?BLINKEN|TIPP_?BLINKEN|BLINKEN)_?(?:LINKS|LEFT)(?:_EIN)?$/i.test(a) ? 'LEFT' : undefined)
        || (a && /^(?:DAUER_?BLINKEN|TIPP_?BLINKEN|BLINKEN)_?(?:RECHTS|RIGHT)(?:_EIN)?$/i.test(a) ? 'RIGHT' : undefined)
        || (a && /^(?:WARN_?BLINK|BEIDSEITIG|HAZARD)/i.test(a) ? 'HAZARD' : undefined);
    const direction = commanded && commanded !== 'OFF' ? commanded : observed || commanded;
    let kind = null;
    if (direction === 'LEFT' || direction === 'RIGHT') {
        kind = CONTROL_KIND[code] || (/TIPP_?BLINKEN/i.test(cStr) || /^TIPP_?BLINKEN/i.test(a) ? 'tip'
            : /DAUER_?BLINKEN/i.test(cStr) || /^DAUER_?BLINKEN/i.test(a) ? 'steady' : null);
    }
    return { direction, kind, raw: String(command === undefined || command === null ? '-' : command) + ' / ' + String(active === undefined || active === null ? '-' : active) };
}

function createBlinker(opts) {
    let o = Object.assign({ holdMs: 2000, tip: true, maxMs: 0, tipMaxMs: 0, maxKm: 0, moveMaxMs: 20000 }, opts || {});
    let dir = 'WAITING', side = null, activeKind = null, onAt = 0, offAt = null;
    let km = 0, speedKmh = null, speedAt = 0;
    const clear = () => { side = null; activeKind = null; offAt = null; km = 0; };
    return {
        configure(next) { o = Object.assign({}, o, next || {}); },
        event(direction, kind, now) {
            if (!direction) return;
            dir = direction;
            if (direction === 'LEFT' || direction === 'RIGHT') {
                if (kind === 'tip' && !o.tip) {
                    if (side && offAt === null) offAt = now;
                    return;
                }
                const s = direction === 'LEFT' ? 'left' : 'right';
                if (s !== side || offAt !== null) { onAt = now; km = 0; activeKind = kind || null; }
                else if (kind) activeKind = kind;
                side = s;
                offAt = null;
            } else if (direction === 'HAZARD') {
                clear();
            } else if (side && offAt === null) {
                offAt = now;
            }
        },
        travel(kmh, now) {
            if (!Number.isFinite(kmh) || kmh < 0) return;
            if (side && offAt === null && speedKmh !== null && now > speedAt && now - speedAt < 5000 && (kmh > 3 || speedKmh > 3)) {
                km += ((speedKmh + kmh) / 2) * (now - speedAt) / 3600000;
            }
            speedKmh = kmh;
            speedAt = now;
        },
        side(now) {
            if (!side) return null;
            if (offAt !== null && now - offAt >= o.holdMs) { clear(); return null; }
            if (offAt === null && activeKind === 'tip' && o.tipMaxMs && now - onAt >= o.tipMaxMs) { clear(); dir = 'OFF'; return null; }
            if (offAt === null && o.maxKm && km >= o.maxKm && (!o.moveMaxMs || now - onAt >= o.moveMaxMs)) { clear(); dir = 'OFF'; return null; }
            if (offAt === null && o.maxMs && now - onAt >= o.maxMs) { clear(); dir = 'OFF'; return null; }
            return side;
        },
        state() { return dir; },
    };
}

function decodeReverse(value) {
    const sel = field(value, 'statusGearSelectionDrive');
    if (sel !== undefined) {
        if (sel === 'R' || sel === 2 || /^REVERSE/i.test(String(sel))) return true;
        if (sel === 'N' || sel === 'P' || sel === 'NP' || /^_\d+$/.test(String(sel)) || (typeof sel === 'number' && sel >= 1 && sel <= 13)) return false;
    }
    const stage = field(value, 'statusActualStageDrive');
    if (stage !== undefined) {
        if (stage === 'R' || stage === 2 || /^REVERSE/i.test(String(stage))) return true;
        if (stage === 'P' || stage === 'N' || stage === 'D' || stage === 1 || stage === 3 || stage === 4) return false;
    }
    const gear = field(value, 'statusActualGearDrive');
    if (gear !== undefined) {
        if (gear === 'R' || gear === 1) return true;
        if (gear === 'N_OR_P' || /^G\d+$/.test(String(gear)) || (typeof gear === 'number' && gear >= 2 && gear <= 12)) return false;
    }
    return null;
}

function decodeNight(value) {
    const raw = field(value, 'dayNightChangeOver');
    const v = raw !== undefined ? raw : value;
    if (v === 2 || v === 'NACHT' || v === 'NIGHT') return true;
    if (v === 1 || v === 'TAG' || v === 'DAY') return false;
    return null;
}

const PARKING = /^(TOPREARVIEW|SIDEVIEW|RFK|OFFROAD|REMOTE360|1|2|3|20|60)$/;
const DR = /^(DR_ACTIVE|51)$/;
const ALL4 = [7, 9, 10], FRONT_REAR = [5, 6];

function camState(xv, icam) {
    const states = [xv, icam].filter((s) => s && typeof s === 'object');
    if (!states.length) return { known: false, text: 'không đọc được', ready: false, parking: false, dr: false, perspective: null, kind: 'unknown' };
    const one = (s) => {
        const app = String(s.application), p = Number(s.perspective);
        const starting = /SIGNAL_UNFILLED|^255$/.test(app) || p === 255;
        const dr = DR.test(app);
        let kind = 'other';
        if (starting) kind = 'starting';
        else if (PARKING.test(app)) kind = 'parking';
        else if (dr && ALL4.indexOf(p) >= 0) kind = 'all4';
        else if (dr && p === 3) kind = 'left';
        else if (dr && p === 4) kind = 'right';
        else if (dr && p === 1) kind = 'front';
        else if (dr && p === 2) kind = 'rear';
        else if (dr && FRONT_REAR.indexOf(p) >= 0) kind = 'frontrear';
        return { known: true, text: s.application + '/' + s.mode + '/' + s.perspective, ready: !starting, parking: kind === 'parking', dr, perspective: Number.isFinite(p) ? p : null, kind };
    };
    const all = states.map(one);
    const useful = all.filter((s) => ['all4', 'left', 'right'].indexOf(s.kind) >= 0)[0];
    const parking = all.filter((s) => s.parking)[0];
    return parking || useful || all[0];
}

const QUADS = { tl: [0, 0], tr: [500, 0], bl: [0, 500], br: [500, 500] };
const HEIGHTS = { small: 288, fit: 320, medium: 384, large: 480 };
const GAUGE = { cx: 380, cy: 400 };

function parseTargets(text) {
    const out = {};
    String(text || '').split(',').forEach((part) => {
        const m = /^([a-z0-9_]+):(\d+)x(\d+)$/i.exec(part.trim());
        if (m) out[m[1]] = { w: Number(m[2]), h: Number(m[3]) };
    });
    return out;
}

function zoomCrop(x, y, w, h, zoom) {
    const z = Math.max(100, Math.min(400, Number(zoom) || 100));
    const nw = Math.max(50, Math.round(w * 100 / z)), nh = Math.max(50, Math.round(h * 100 / z));
    return [Math.round(x + (w - nw) / 2), Math.round(y + (h - nh) / 2), nw, nh].join(',');
}

const CALIB = {
    calH: { d: 70, min: 30, max: 150, step: 5 },
    calPitch: { d: 8, min: -10, max: 45, step: 1 },
    calFov: { d: 100, min: 40, max: 190, step: 5 },
    calYaw: { d: 0, min: -20, max: 20, step: 1 },
    calShift: { d: 0, min: -100, max: 100, step: 5 },
    calCurve: { d: 40, min: 0, max: 100, step: 10 },
    frontZoom: { d: 100, min: 100, max: 300, step: 10 },
    frontPanY: { d: 0, min: -200, max: 200, step: 10 },
};

const calib = (s, k) => {
    const c = CALIB[k], v = Number(s && s[k]);
    return Number.isFinite(v) && s[k] !== '' && s[k] !== null && s[k] !== undefined ? Math.max(c.min, Math.min(c.max, v)) : c.d;
};

const FRONT_CROP = '0,0,500,500';
function frontCrop(s) {
    const z = Math.max(100, Math.min(300, Number(s && s.frontZoom) || 100));
    if (s && (s.frontSize === 'wide' || s.frontSize === 'sharp')) {
        const w = 500 * 100 / z, h = w * 0.6;
        const y = Math.max(0, Math.min(500 - h, 250 - h / 2 + calib(s, 'frontPanY') * 500 / 1000));
        return [Math.round((500 - w) / 2), Math.round(y), Math.round(w), Math.round(h)].join(',');
    }
    return z === 100 ? FRONT_CROP : zoomCrop(0, 0, 500, 500, z);
}

const FRONT_SIZES = { small: [384, 288], medium: [512, 384], large: [640, 480], sharp: [640, 288], wide: [960, 432] };

function frontConfig(s, targets, dual) {
    const t = (targets && targets.map) || { w: 1088, h: 480 };
    const size = FRONT_SIZES[s.frontSize] || FRONT_SIZES.medium;
    let w = Math.min(size[0], t.w), h = Math.min(size[1], t.h);
    w -= w % 4;
    h -= h % 2;
    let x = Math.round((t.w - w) / 2), y = Math.round((t.h - h) / 2);
    x -= x % 2;
    y -= y % 2;
    const fps = [8, 10, 12, 15].indexOf(Number(s.fps)) >= 0 ? Math.min(Number(s.fps), 10) : 10;
    let target = 'map';
    if (dual && s.dualTarget === 'panel') {
        const p = (targets && targets.panel) || { w: 1920, h: 720 };
        target = 'panel';
        x += Math.round((p.w - t.w) / 2);
        y += Math.round((p.h - t.h) / 2);
        x -= x % 2;
        y -= y % 2;
    }
    return {
        op: 'config', target, w, h, x, y, fps, klass: 'overlay', exclusive: 1, contend: 1, persist: s.layer === 'keep' ? 1 : 0,
        front: frontCrop(s), front_rot: 0, front_flip: 0, front_sar: 100, front_round: 0,
        all: '0,0,1000,1000', all_rot: 0, all_flip: 0, all_sar: 100,
        pair: 1, pair_swap: s.pairSwap === 'on' ? 1 : 0,
    };
}

function viewConfig(settings, targets, side, view, dual) {
    const s = settings || {};
    if (view === 'front') return frontConfig(s, targets, dual);
    const gauge = s.place === 'gauge' || s.place === undefined;
    const target = gauge ? 'panel' : ['map', 'panel', 'hud'].indexOf(s.target) >= 0 ? s.target : 'map';
    const t = (targets && targets[target]) || { map: { w: 1088, h: 480 }, panel: { w: 1920, h: 720 }, hud: { w: 800, h: 480 } }[target];
    const single = s.mode === 'single';
    const stretch = [100, 150, 200].indexOf(Number(s.stretch)) >= 0 ? Number(s.stretch) : 100;
    const rot = (k) => ([0, 90, 180, 270].indexOf(Number(s[k])) >= 0 ? Number(s[k]) : 0);
    const quad = (k, d) => QUADS[s[k]] || QUADS[d];
    const round = s.shape !== 'square';
    const ql = quad('quadLeft', 'bl'), qr = quad('quadRight', 'br');
    const base = single ? 8 / 3 : 4 / 3;
    const wide = base * stretch / 100;
    const aim = s.aim === 'side' || s.aim === 'front' ? s.aim : 'rear';
    const fine = (k) => Math.max(-500, Math.min(500, Number(s[k]) || 0));
    const part = (x, y, w, h, isLeft) => {
        const z = Math.max(100, Math.min(400, (Number(s.zoom) || 100) * Math.max(100, Math.min(300, Number(s[isLeft ? 'zoomL' : 'zoomR']) || 100)) / 100));
        let nw = (round && wide > 1 ? w / wide : w) * 100 / z;
        const nh = Math.max(50, h * 100 / z);
        nw = Math.max(50, nw);
        const slack = w - nw;
        const towardsLeft = (aim === 'rear') === isLeft;
        let nx = aim === 'side' ? x + slack / 2 : towardsLeft ? x : x + slack;
        let ny = y + (h - nh) / 2;
        nx = Math.max(x, Math.min(x + w - nw, nx + fine(isLeft ? 'panLx' : 'panRx') * w / 1000));
        ny = Math.max(y, Math.min(y + h - nh, ny + fine(isLeft ? 'panLy' : 'panRy') * h / 1000));
        return [Math.round(nx), Math.round(ny), Math.round(nw), Math.round(nh)].join(',');
    };
    const left = single ? part(0, 0, 1000, 1000, true) : part(ql[0], ql[1], 500, 500, true);
    const right = single ? part(0, 0, 1000, 1000, false) : part(qr[0], qr[1], 500, 500, false);
    const turned = (r) => r === 90 || r === 270;
    const shape = (r) => (round ? 1 : turned(r) ? 1 / wide : wide);
    const aspect = Math.max(shape(rot('rotLeft')), shape(rot('rotRight')));
    let h = HEIGHTS[s.size] || (gauge ? HEIGHTS.fit : HEIGHTS.medium);
    if (h > t.h) h = t.h;
    let w = Math.round(h * aspect);
    if (w > t.w) { w = t.w; h = Math.round(w / aspect); }
    w = Math.max(64, w - (w % 4));
    h = Math.max(64, h - (h % 2));
    let x = Math.round((t.w - w) / 2), y = Math.round((t.h - h) / 2);
    if (s.place === 'side' && side === 'left') x = Math.min(x, 16);
    if (s.place === 'side' && side === 'right') x = Math.max(x, t.w - w - 16);
    if (s.place === 'top') y = 0;
    if (s.place === 'bottom') y = t.h - h;
    if (gauge) {
        const dx = Math.max(-400, Math.min(400, Number(s.gaugeDx) || 0)), dy = Math.max(-200, Math.min(200, Number(s.gaugeDy) || 0));
        const cx = side === 'right' ? t.w - GAUGE.cx - dx : GAUGE.cx + dx;
        x = Math.round(cx - w / 2);
        y = Math.round(GAUGE.cy + dy - h / 2);
        x = Math.max(0, Math.min(t.w - w, x));
        y = Math.max(0, Math.min(t.h - h, y));
    }
    x -= x % 2;
    y -= y % 2;
    const fps = [8, 10, 12, 15].indexOf(Number(s.fps)) >= 0 ? Number(s.fps) : 12;
    const flip = s.mirror === 'on' ? 1 : 0;
    const out = {
        op: 'config', target, w, h, x, y, fps, klass: 'overlay', exclusive: 1, contend: 1, persist: s.layer === 'keep' ? 1 : 0,
        left, left_rot: rot('rotLeft'), left_flip: flip, left_sar: stretch, left_round: round ? 1 : 0,
        right, right_rot: rot('rotRight'), right_flip: flip, right_sar: stretch, right_round: round ? 1 : 0,
        all: '0,0,1000,1000', all_rot: 0, all_flip: 0, all_sar: 100,
        front: frontCrop(s), front_rot: 0, front_flip: 0, front_sar: 100, front_round: 0,
        pair: single ? 0 : 1, pair_swap: s.pairSwap === 'on' ? 1 : 0,
    };
    if (s.night !== undefined && s.night !== null) {
        const rim = s.night && s.nightRim !== 'bright' ? 95 : 200;
        out.left_rim = rim;
        out.right_rim = rim;
    }
    return out;
}

const FRONT_HYST_KMH = 4;
function frontWanted(i) {
    const f = i.front;
    if (f === 'always') return true;
    const m = /^slow(\d+)$/.exec(String(f || ''));
    if (!m) return false;
    if (i.speed === null || i.speed === undefined) return false;
    const lim = Number(m[1]);
    if (i.frontHold && i.speed <= lim + FRONT_HYST_KMH * 2) return true;
    return i.speed <= lim + (i.frontLatched ? FRONT_HYST_KMH : 0);
}

const AR_NEAR_M = 250;
const AR_SECONDS = 12, AR_MIN_M = 80, AR_MAX_M = 400;
function arNearM(speed) {
    if (typeof speed !== 'number' || !(speed >= 0)) return AR_NEAR_M;
    return Math.round(Math.max(AR_MIN_M, Math.min(AR_MAX_M, speed / 3.6 * AR_SECONDS)));
}
const isTurn = (n) => !!n && (n.kind === 'roundabout' || n.kind === 'destination' || (n.kind === 'turn' && !!n.angle));

function arWanted(i) {
    if (i.arHold && i.nav && i.nav.active) return true;
    const n = i.nav;
    if (!n || !n.active || (i.arMode !== 'near' && i.arMode !== 'always')) return false;
    if (i.arMode === 'always') return true;
    if (!isTurn(n)) return false;
    const limit = arNearM(i.speed) * (i.arLatched ? 1.6 : 1);
    return typeof n.meters === 'number' && n.meters >= 0 && n.meters <= limit;
}

function auxConfig(s, targets, side) {
    if (side !== 'left' && side !== 'right') return null;
    const c = viewConfig(Object.assign({}, s, { mode: 'mosaic' }), targets, side, side);
    const out = { side, target: c.target, w: c.w, h: c.h, x: c.x, y: c.y, fps: Math.min(c.fps, 10), crop: c[side], rot: c[side + '_rot'],
        flip: c[side + '_flip'], sar: c[side + '_sar'], round: c[side + '_round'] };
    if (s && s.night !== undefined && s.night !== null) out.rim = c[side + '_rim'];
    return out;
}

function arConfig(s, mode, speed) {
    return {
        mode: ['marks', 'route', 'demo'].indexOf(mode) >= 0 ? mode : 'off',
        height_cm: calib(s, 'calH'), pitch_x10: Math.round(calib(s, 'calPitch') * 10), fov: calib(s, 'calFov'),
        yaw_x10: Math.round(calib(s, 'calYaw') * 10), shift_cm: calib(s, 'calShift'), curve: calib(s, 'calCurve'),
        card: s && s.arCard === 'off' ? 0 : 1,
        white: s && s.arColor === 'blue' ? 0 : 1,
        style: s && s.arStyle === 'road' ? 1 : 0, fade: s && (s.frontSize === 'wide' || s.frontSize === 'sharp') ? 1 : 0,
        speed: typeof speed === 'number' && speed >= 0 ? Math.round(speed) : -1,
    };
}

function plan(i) {
    const none = (why, want) => ({ view: 'none', why, want: want === undefined ? null : want });
    if (!i.enabled && !i.test) return none('Đang tắt');
    if (i.reverse && !i.test) return none('Xe đang cài số lùi', null);
    const fast = !i.test && i.maxSpeed && i.speed !== null && i.speed !== undefined && i.speed > i.maxSpeed;
    if (fast && i.side) return plan(Object.assign({}, i, { side: null, frontWhy: 'Xe chạy nhanh hơn ' + i.maxSpeed + ' km/h' }));
    const keepFront = !i.auxRefused && !i.test && !!i.side && i.enabled &&
        ((i.dual === 'nav' && arWanted(i)) || (i.dual === 'always' && (arWanted(i) || frontWanted(i))));
    const single = i.mode === 'single' && !keepFront;
    const ask = i.source !== 'passive';
    const side = i.test === 'left' || i.test === 'right' ? i.test : i.test === 'all' ? null : i.side;
    const want = !ask ? null : single && side ? (side === 'left' ? 3 : 4) : 7;
    const arOn = !i.test && !side && i.enabled && arWanted(i);
    const frontTest = i.test === 'front' || i.test === 'calfront' || i.test === 'ardemo';
    const frontOn = frontTest || arOn || (!i.test && !side && i.enabled && frontWanted(i));
    const dualAr = !!i.side && !i.test && i.enabled && !single && arWanted(i);
    const dual = !i.auxRefused && !i.test && !!i.side && !single && i.enabled &&
        ((i.dual === 'nav' && dualAr) || (i.dual === 'always' && (dualAr || frontWanted(i))));
    const ar = i.test === 'calfront' ? 'marks' : i.test === 'ardemo' ? 'demo' : arOn ? 'route' : 'off';
    if (!side && i.test !== 'all' && !frontOn) return none(i.frontWhy || 'Chờ xi nhan', want);
    const h = i.helper || {};
    if (!h.ok) return none('Trợ thủ bimmer-drive chưa chạy', want);
    const cam = i.cam || { kind: 'unknown' };
    if (cam.kind === 'parking') return none('Xe đang hiện camera đỗ xe', want);
    if (cam.kind === 'starting') return none('Hộp camera đang khởi động', want);
    if (h.pictureAge === null || h.pictureAge === undefined || h.pictureAge < 0) return none('Chưa có hình từ camera', want);
    if (h.pictureAge > 2200) return none('Luồng camera đang dừng', want);
    if (i.test === 'all') return { view: 'all', why: '', want };
    if (frontOn) {
        const four = (i.cam || {}).kind === 'all4' || ((i.cam || {}).kind === 'unknown' && (h.pictureH >= 800 || (!!h.pair && h.pair !== 'off')));
        if (!four) return none('Chờ xi nhan', want);
        return { view: 'front', why: '', want, ar };
    }
    const tall = h.pictureH >= 800 || (!!h.pair && h.pair !== 'off');
    if (single) {
        const on = cam.kind === side || (cam.kind === 'unknown' && !tall);
        if (!on) return none('Chờ hộp camera chuyển sang camera ' + (side === 'left' ? 'trái' : 'phải'), want);
        return { view: side, why: '', want };
    }
    const on = cam.kind === 'all4' || (cam.kind === 'unknown' && tall);
    if (!on) {
        if (cam.kind === 'unknown') return none('Hình camera không phải dạng ghép 4 camera', want);
        return none('Hộp camera chưa ở chế độ 4 camera (' + cam.text + ')', want);
    }
    if (dual) return { view: 'front', why: '', want, ar: dualAr ? 'route' : 'off', aux: side };
    const dualWhy = i.test || !i.side || i.dual === undefined ? '' : i.dual !== 'nav' && i.dual !== 'always' ? 'đang chọn "Chỉ hiện cam gương"'
        : i.auxRefused ? 'bộ vẽ từ chối hình thứ hai, thử lại sau 15 giây'
            : !dualAr && i.dual === 'nav' ? 'không có mũi tên dẫn đường lúc này' : !dualAr ? 'camera trước không đang hiện' : '';
    return dualWhy ? { view: side, why: '', want, dualWhy } : { view: side, why: '', want };
}

/* ---------------- Vietnamese Speed-Sign & WOC Mirror Status Helpers ---------------- */

const SIGN_SIZES = { small: { map: 96, hud: 64 }, medium: { map: 128, hud: 80 }, large: { map: 160, hud: 100 } };
const SIGN_TARGETS = { map: { w: 1088, h: 480 }, hud: { w: 800, h: 480 } };

function signGeometry(status, s, target) {
    const T = SIGN_TARGETS[target];
    const k = target === 'map' ? ['signMapX', 'signMapY'] : ['signHudX', 'signHudY'];
    const szKey = (s && s.signSize) || 'medium';
    const size = (SIGN_SIZES[szKey] || SIGN_SIZES.medium)[target];
    const g = status && status.geometry && status.geometry[target];
    const hasSaved = s && Number.isFinite(Number(s[k[0]])) && s[k[0]] !== null && Number.isFinite(Number(s[k[1]])) && s[k[1]] !== null;
    let x, y;
    if (hasSaved) { x = Math.round(Number(s[k[0]])); y = Math.round(Number(s[k[1]])); }
    else if (g) { x = g.x; y = g.y; }
    else if (target === 'map') { x = s && s.signSide === 'left' ? 200 : T.w - 200 - size; y = 36; }
    else { x = s && s.signHudSide === 'right' ? 720 - size - 8 : 88; y = 98; }
    return { x, y, size, w: T.w, h: T.h, placed: !!hasSaved };
}

const SIGN_WHY_VI = {
    'off in the app': 'Đang tắt biển báo',
    'no phone yet': 'Chưa kết nối điện thoại VietMap',
    'the phone stopped sending': 'Điện thoại ngừng gửi dữ liệu',
    'no sign in VietMap': 'VietMap hiện không báo biển',
    'no sign on the centre screen': 'Màn giữa không có biển',
    'the centre screen cannot be read': 'Không đọc được màn giữa',
    'no sign on this road': 'Đoạn đường chưa có giới hạn tốc độ',
    'cluster-render is not installed': 'Chưa cài cluster-render trên MGU Store',
    'Waze on cluster is not installed': 'Cần cài Waze on cluster để hiện trên bản đồ',
    'Waze on cluster shows no map there': 'Hiện ngay khi có bản đồ hoặc Cam trước trên đồng hồ',
};

function signReport(st, s) {
    const lines = [];
    const on = !s || s.signMode !== 'off';
    const empty = (s && s.signEmpty) || 'dashes';
    if (!st) {
        return {
            on, limit: null, dashes: false, symbol: null, phoneLimit: null, source: null, unpaired: false,
            lines: [{ text: 'Trợ thủ bimmer-drive chưa chạy', kind: 'warn' }],
            note: 'Kiểm tra trợ thủ trong MGU Store', noteKind: 'warn',
        };
    }
    const p = st.phone || {}, vh = st.vmhud || {}, pr = st.pairing || {}, c = st.camera || {}, bm = st.bmwmap || {};
    const unpaired = !!(pr.on && pr.refused && pr.ago_ms !== null && pr.ago_ms < 10000 && !(p.at && p.ago_ms < pr.ago_ms));
    const ago = (ms) => (ms === null || ms === undefined ? '' : ms < 2000 ? 'vừa xong' : Math.round(ms / 1000) + ' giây trước');

    const usbTag = (!vh.connected && vh.usbDev) ? (' · USB ' + String(vh.usbDev).split('/').pop()) : '';
    if (vh.connected) {
        const via = vh.transport === 'usb' ? 'USB' : 'BLE';
        lines.push({ text: 'VietMap HUD (' + via + '): đã nối ' + (vh.model || 'H1N') + (vh.limit ? ' · biển ' + vh.limit : ''), kind: 'go' });
    } else if (vh.bleState === 'advertising') {
        lines.push({ text: 'VietMap HUD (BLE): đang phát HUD(BLE) trên ' + (vh.bleAdapter || 'hci0') + usbTag, kind: 'go' });
    } else if (vh.bleState === 'no_bluez' || vh.bleState === 'no_adapter') {
        const det = vh.bleDetail ? ' (' + vh.bleDetail + ')' : '';
        lines.push({ text: 'VietMap HUD (BLE): xe không mở BlueZ' + det + usbTag, kind: 'dim' });
    } else if (vh.bleError || vh.bleDetail) {
        lines.push({ text: 'VietMap HUD (BLE): ' + (vh.bleDetail || vh.bleError) + usbTag, kind: 'warn' });
    } else {
        lines.push({ text: 'VietMap HUD (BLE): đang khởi tạo…' + usbTag, kind: 'dim' });
    }

    const srcMode = (s && s.signSource) || (st.settings && st.settings.source) || 'auto';
    if (srcMode === 'bmw_only') lines.push({ text: 'Điện thoại VietMap: đang chọn chỉ dùng nguyên bản BMW', kind: 'dim' });
    else if (unpaired) lines.push({ text: 'Điện thoại ' + pr.from + ': sai mã ghép 6 số', kind: 'warn' });
    else if (p.at) lines.push({ text: 'Điện thoại VietMap: ' + p.from + ' · ' + ago(p.ago_ms) + (p.limit ? ' · biển ' + p.limit : ''), kind: p.ago_ms < 5000 ? 'go' : 'warn' });
    else lines.push({ text: 'Điện thoại VietMap: chưa kết nối', kind: (vh.connected || (bm.on && bm.ready)) ? 'dim' : 'warn' });

    if (c.on) {
        lines.push(c.error ? { text: 'Camera KAFAS BMW: ' + c.error, kind: 'warn' }
            : !c.ready ? { text: 'Camera KAFAS BMW: đang mở…', kind: 'dim' }
                : c.limit ? { text: 'Camera KAFAS BMW: biển ' + c.limit + (c.seen ? ' (thấy ' + c.seen + ')' : ''), kind: 'go' }
                    : c.low ? { text: 'Camera KAFAS BMW: bỏ biển ' + c.low + ' (nội bộ)', kind: 'dim' }
                        : { text: 'Camera KAFAS BMW: chưa gặp biển', kind: 'dim' });
    }
    if (bm.on) {
        const nextTxt = bm.next_limit ? ' · sắp tới ' + bm.next_limit : '';
        lines.push(bm.error ? { text: 'Bản đồ BMW: ' + bm.error, kind: 'warn' }
            : !bm.ready ? { text: 'Bản đồ BMW: đang mở…', kind: 'dim' }
                : bm.limit ? { text: 'Bản đồ BMW: biển ' + bm.limit + ' · mã ' + bm.cls + nextTxt, kind: 'go' }
                    : bm.low ? { text: 'Bản đồ BMW: bỏ mã ' + bm.cls + ' (' + bm.low + ' km/h hầm/nội bộ)', kind: 'dim' }
                        : { text: 'Bản đồ BMW: không có biển' + (bm.cls !== null && bm.cls !== undefined ? ' · mã ' + bm.cls : ''), kind: 'dim' });
    }
    const vhFresh = !!(vh.at && vh.ago_ms !== null && vh.ago_ms < 15000);
    const pFresh = !!(p.at && p.ago_ms !== null && p.ago_ms < 5000);
    const nextVal = (vhFresh && vh.next) || (pFresh && p.next) || null;
    const hintVal = (vhFresh && vh.hint) || (pFresh && p.hint) || null;
    if (nextVal || hintVal) {
        const parts = [];
        if (nextVal) parts.push('sắp tới ' + nextVal);
        if (hintVal) parts.push(hintVal);
        lines.push({ text: 'Cảnh báo VietMap: ' + parts.join(' · '), kind: 'go' });
    }
    const shown = st.shown || [];
    const xcFront = !!(st.xinhan && st.xinhan.front);
    lines.push({
        text: 'Hiển thị: ' + (shown.length ? shown.map((x) => (x === 'map' ? ('đồng hồ' + (xcFront ? ' (trên cam trước)' : '')) : 'HUD')).join(' + ') : 'chưa hiện trên đồng hồ/HUD'),
        kind: shown.length ? 'go' : 'dim',
    });

    const vmc = st.vmc || {};
    lines.push({
        text: 'Chiếu màn giữa (AA): ' + (!vmc.on ? 'đang tắt (giữ bản đồ gốc)' : vmc.error ? vmc.error : vmc.running ? 'đang phát lên đồng hồ (' + vmc.view + ')' : 'đang khởi động…'),
        kind: !vmc.on ? 'dim' : vmc.error ? 'warn' : vmc.running ? 'go' : 'warn',
    });

    let note = '', noteKind = 'dim';
    if (st.renderer && st.renderer.error && st.renderer.installed !== false) { note = st.renderer.error; noteKind = 'warn'; }
    else if (shown.length) { note = 'Đang hiện trên ' + shown.map((x) => (x === 'map' ? 'đồng hồ' : 'HUD')).join(' và '); noteKind = 'go'; }
    else if (unpaired) { note = 'Nhập đúng mã 6 số bên trái vào app VietMap Helper trên điện thoại'; noteKind = 'warn'; }
    else note = SIGN_WHY_VI[st.why] || st.why || '';

    const dashes = !st.limit && (st.symbol === '---' || (on && empty !== 'hide'));
    return {
        on, unpaired, limit: st.limit || null, dashes, symbol: st.symbol || null,
        vmhudLimit: vh.limit || null, phoneLimit: p.limit || null, source: st.source || null, lines, note, noteKind,
    };
}

module.exports = {
    decode, decodeReverse, decodeNight, field, createBlinker, camState, parseTargets, zoomCrop,
    viewConfig, frontConfig, plan, CONTROL, HEIGHTS, GAUGE, FRONT_SIZES, frontCrop, auxConfig,
    arWanted, arConfig, calib, CALIB, AR_NEAR_M, arNearM,
    SIGN_SIZES, SIGN_TARGETS, signGeometry, signReport,
};
