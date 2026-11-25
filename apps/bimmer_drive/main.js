'use strict';
/**
 * main.js - Unified iDrive 7 App Controller for Camera & VietMap (`apps/bimmer_drive`, v1.0.0).
 *
 * Communicates with `bimmer-drive.service` over `/run/bimmer-drive/app/ctl.sock` (`<1ms` event-driven IPC,
 * zero flash writes; falls back seamlessly to `/run/bimmer-drive/app/control.json` -> `data/control.json`).
 *
 * Node 8 (ES2017) compatible.
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { Canvas } = require('./kit/canvas');
const L = require('./logic');
const camera = require('./camera');
const UI = require('./ui');

const STATUS = process.env.BD_STATUS || '/run/bimmer-drive/status.json';
const STATUS_STALE_MS = 4500;
const SPEED_STALE_MS = 8000;
const TICK_MS = 100;
const HEARTBEAT_MS = 500;
const CAM_TICK_MS = 500;
const CAM_IDLE_MS = 1500;
const CAM_CACHE_MS = 8000;
const BLINKER_MAX_MS = 120000;
const BLINKER_TIP_MAX_MS = 6000;
const BLINKER_MAX_KM = 0.35;
const BLINKER_MOVE_MS = 20000;
const AR_HOLD_MS = 3500;
const FRONT_HOLD_MS = 1500;

const IF = {
    light: 'de.bmw.body.Light',
    speed: 'de.bmw.infotainment.vehicle.Vehicle2',
    gear: 'de.bmw.infrastructure.VehicleInformation',
    icam: 'de.bmw.infotainment.video.cameraproxy.ICAM2Proxy',
    cam: 'de.bmw.infotainment.video.cameraproxy.CameraProxy',
    xv: 'de.bmw.dass.XView3D',
};
const WIRE = { CLIENT_INDIRECT: 1, DR_ACTIVE: 51, MODE_MOSAIK: 50 };
const errText = (e) => String((e && e.message) || e).slice(0, 120);

const WHY_VI = {
    'no camera picture yet': 'chưa có hình từ hộp camera',
    'the camera pictures stopped': 'hình camera đã ngừng (đã ẩn)',
    'one of the two camera pictures stopped': 'một trong hai nhóm hình ngừng đến',
    'the cluster renderer is not connected': 'chưa nối được cluster-render',
    'the app stopped asking': 'app ngừng yêu cầu',
    'no view asked for': 'chưa yêu cầu camera nào',
    'the setting changed': 'đang đổi cài đặt',
};

mgu.run({
    async start(ctx) {
        const { ui, settings, log, signals } = ctx;
        const RUN_DIR = path.join(path.dirname(STATUS), 'app');
        const SOCK_PATH = path.join(RUN_DIR, 'ctl.sock');
        let runOk = false, runTriedAt = -1e9;
        let ctlSock = null, ctlReady = false, ctlTriedAt = -1e9;

        function ensureSocket(now) {
            if (ctlReady || now - ctlTriedAt < 3000) return ctlReady;
            if (!fs.existsSync(SOCK_PATH)) return false;
            ctlTriedAt = now;
            try {
                const s = net.createConnection(SOCK_PATH);
                ctlSock = s;
                s.on('connect', () => { if (ctlSock === s) { ctlReady = true; log.info('connected to ctl.sock'); } });
                s.on('error', () => { if (ctlSock === s) { ctlReady = false; ctlSock = null; } });
                s.on('close', () => { if (ctlSock === s) { ctlReady = false; ctlSock = null; } });
            } catch (e) { ctlReady = false; ctlSock = null; }
            return ctlReady;
        }

        const ctlDir = (now) => (runOk || now - runTriedAt >= 30000 || (now - runTriedAt >= 2000 && fs.existsSync(RUN_DIR)) ? RUN_DIR : ctx.dataDir);
        function putFile(name, data, now) {
            const dir = ctlDir(now);
            if (dir === RUN_DIR) {
                try {
                    fs.writeFileSync(path.join(dir, name + '.tmp'), data);
                    fs.renameSync(path.join(dir, name + '.tmp'), path.join(dir, name));
                    if (!runOk) {
                        runOk = true;
                        ['control.json', 'label.bin'].forEach((f) => { try { fs.unlinkSync(path.join(ctx.dataDir, f)); } catch (e) {} });
                    }
                    return dir;
                } catch (e) {
                    runOk = false;
                    runTriedAt = now;
                }
            }
            fs.writeFileSync(path.join(ctx.dataDir, name + '.tmp'), data);
            fs.renameSync(path.join(ctx.dataDir, name + '.tmp'), path.join(ctx.dataDir, name));
            return ctx.dataDir;
        }

        function sendPayload(payloadObj, now) {
            const line = JSON.stringify(payloadObj);
            if (ensureSocket(now) && ctlSock) {
                try { ctlSock.write(line + '\n'); return RUN_DIR; } catch (e) { ctlReady = false; ctlSock = null; }
            }
            return putFile('control.json', line, now);
        }

        const EXTRA = ['gaugeDx', 'gaugeDy', 'panLx', 'panLy', 'panRx', 'panRy', 'zoomL', 'zoomR', 'signMapX', 'signMapY', 'signHudX', 'signHudY'].concat(Object.keys(L.CALIB));
        let dragCam = null, dragSign = null, reverse = false;
        const nightAt = (now) => { const h = new Date(now).getHours(); return h >= 18 || h < 6; };

        const cfg = (now) => {
            const t = now || Date.now();
            const o = {};
            settings.schema.forEach((s) => { o[s.key] = settings.get(s.key); });
            EXTRA.forEach((k) => { o[k] = settings.get(k); });
            if (o.nightRim === 'dim' || o.nightRim === 'bright') o.night = nightAt(t);
            if (dragCam && t - dragCam.at > 10000) dragCam = null;
            if (dragSign && t - dragSign.at > 10000) dragSign = null;
            if (dragCam) { o.gaugeDx = dragCam.dx; o.gaugeDy = dragCam.dy; o.place = 'gauge'; }
            return o;
        };

        /* ---- Turn signals ---- */
        const blinker = L.createBlinker({ maxMs: BLINKER_MAX_MS, tipMaxMs: BLINKER_TIP_MAX_MS, maxKm: BLINKER_MAX_KM, moveMaxMs: BLINKER_MOVE_MS });
        const applyBlinker = () => blinker.configure({
            holdMs: (Number(settings.get('hold')) || 2) * 1000,
            tip: settings.get('tip') !== 'off',
            maxMs: BLINKER_MAX_MS,
            tipMaxMs: BLINKER_TIP_MAX_MS,
            maxKm: BLINKER_MAX_KM,
            moveMaxMs: BLINKER_MOVE_MS,
        });
        applyBlinker();

        let lightState = 'Đang kết nối', lastRaw = ['-', '-'], lastDir = [null, null], stream0OffAt = -1e9, stream0OffDir = null;
        const onLight = (index, value) => {
            const now = Date.now();
            const ev = L.decode(value);
            const rawSame = ev.raw === lastRaw[index];
            if (!rawSame) { lastRaw[index] = ev.raw; log.info('indicators ' + (index + 1) + ': ' + ev.raw + ' -> ' + (ev.direction || '-')); }
            if (rawSame && blinker.side(now) !== null) return;
            if (index === 0) {
                if (ev.direction === 'OFF' && (lastDir[0] === 'LEFT' || lastDir[0] === 'RIGHT')) { stream0OffAt = now; stream0OffDir = lastDir[0]; }
                else if (ev.direction === 'LEFT' || ev.direction === 'RIGHT') { stream0OffAt = -1e9; stream0OffDir = null; }
            } else if (ev.direction === stream0OffDir && lastDir[0] === 'OFF' && now >= stream0OffAt && now - stream0OffAt < 350) {
                lastDir[1] = ev.direction;
                return;
            }
            if (ev.direction) lastDir[index] = ev.direction;
            blinker.event(ev.direction, ev.kind, now);
            tick();
        };
        signals.watch(IF.light, '1', {
            StatusFunctionsIndicators: (v) => onLight(0, v),
            StatusFunctionsIndicators2: (v) => onLight(1, v),
        }, log).then((sub) => { lightState = sub.error ? 'Lỗi: ' + errText(sub.error) : 'Đã kết nối'; })
            .catch((e) => { lightState = 'Lỗi: ' + errText(e); });

        /* ---- Speed ---- */
        let speed = null, speedAt = 0;
        signals.watch(IF.speed, '1', {
            statusCarSpeed2: (v) => {
                const raw = v && v.speedVehicleCentreOfGravity;
                if (!Number.isFinite(raw) || raw === 65535) return;
                const now = Date.now();
                speed = raw * 0.015625;
                speedAt = now;
                blinker.travel(speed, now);
            },
        }, log, { pollMs: 1000 }).then((sub) => { if (sub.error) log.warn('speed: ' + sub.error); }).catch((e) => log.warn('speed: ' + e));

        /* ---- Reverse gear ---- */
        const onGear = (v) => {
            const r = L.decodeReverse(v);
            if (r !== null && r !== reverse) { reverse = r; log.info('reverse gear: ' + (r ? 'on' : 'off')); tick(); }
        };
        signals.watch(IF.gear, '1', { statusGearboxDrive: onGear, DataPowerTrain2: onGear }, log)
            .then((sub) => { if (sub.error) log.info('gearbox: ' + sub.error); }).catch((e) => log.info('gearbox: ' + e));

        /* ---- ICAM2 / XView3D Camera Proxy ---- */
        const px = {}, link = {}, tries = {}, camCache = {};
        const connect = (name) => {
            if (px[name] || link[name] === 'connecting') return;
            link[name] = 'connecting';
            tries[name] = (tries[name] || 0) + 1;
            Promise.resolve().then(() => signals.proxy(IF[name], '1'))
                .then((p) => { px[name] = p; link[name] = 'ok'; log.info(name + ' connected'); },
                    (e) => {
                        const why = errText(e);
                        if (tries[name] === 1) log.warn(name + ': ' + why);
                        link[name] = why;
                        setTimeout(() => connect(name), tries[name] < 10 ? 30000 : 300000);
                    });
        };
        ['icam', 'xv'].forEach(connect);

        const get = (name, fld) => (px[name] ? Promise.resolve().then(() => px[name].getValue(fld, 3000)).then((v) => {
            if (v !== undefined) camCache[name] = { v, at: Date.now() };
            return v;
        }, () => {
            const c = camCache[name];
            return c && Date.now() - c.at < CAM_CACHE_MS ? c.v : undefined;
        }) : Promise.resolve(undefined));

        const named = (fn, byName, byNumber) => Promise.resolve().then(() => fn(byName)).catch(() => fn(byNumber));
        const camCall = (method, args) => {
            if (!px.icam && !px.cam) return Promise.reject(new Error('camera service not connected'));
            const first = px.icam || px.cam;
            return signals.call(first, method, args, 10000).catch((e) => {
                if (px.cam && first !== px.cam) return signals.call(px.cam, method, args, 10000);
                connect('cam');
                throw e;
            });
        };

        const cam = camera.create({
            log,
            io: {
                read: () => Promise.all([get('xv', 'CurrentState'), get('icam', 'currentState')]).then((r) => ({ xv: r[0], icam: r[1] })),
                attach: () => named((a) => camCall('clientAttach', a), { type: 'CLIENT_INDIRECT' }, { type: WIRE.CLIENT_INDIRECT })
                    .then((r) => (r && typeof r === 'object' ? r.cookie : r)),
                request: (cookie, perspective) => {
                    if (!px.icam) return Promise.reject(new Error('camera service not connected'));
                    const st = (a, m) => ({ cookie, desiredState: { application: a, mode: m, perspective } });
                    return named((a) => signals.call(px.icam, 'changeState', a, 10000), st('DR_ACTIVE', 'MODE_MOSAIK'), st(WIRE.DR_ACTIVE, WIRE.MODE_MOSAIK));
                },
                detach: (cookie) => camCall('clientDetach', { cookie }),
            },
        });

        /* ---- Unified Helper Status ---- */
        let status = null, statusReadAt = 0;
        const readStatus = (now) => {
            if (now - statusReadAt < 200) return status;
            statusReadAt = now;
            try {
                const s = JSON.parse(fs.readFileSync(STATUS, 'utf8'));
                status = now - Date.parse(s.at) < STATUS_STALE_MS ? s : null;
            } catch (e) { status = null; }
            return status;
        };

        /* ---- Decision & Control Loop ---- */
        let test = null, testUntil = 0;
        let page = 0, posMode = 'cam', edit = 'left', signEditing = 'map', calCam = 'left';
        let lastControlBody = '', lastWriteAt = 0, seq = 0;
        let lastPlan = { view: 'none', why: 'Đang khởi động', want: null }, lastSide = null;
        let camTickAt = 0, lastWant, lastBusy, auxRefusedAt = -1e9, auxReason = '';
        let arHoldUntil = 0, arLatched = false, frontHoldUntil = 0, frontLatched = false;
        let labelFor = null, streetPic = null, labelSeq = 0;

        function streetLabel(street, s, now) {
            const size = s.frontSize === 'small' ? 15 : 19;
            const key = street + '|' + size;
            if (key === labelFor) return streetPic;
            labelFor = key;
            streetPic = null;
            try {
                const probe = new Canvas(8, 8);
                const tw = Math.ceil(probe.textWidth(street, size, { literal: true, font: 'bold' }));
                const w = Math.min(640, (tw + 16 + 3) & ~3), h = (size + 12) & ~1;
                const cv = new Canvas(w, h);
                cv.clear('#000000');
                cv.text(street, w / 2, Math.round(h / 2 + size * 0.36), size, '#ffffff', { literal: true, font: 'bold', align: 'center' });
                const out = Buffer.alloc(w * h);
                for (let i = 0; i < w * h; i++) out[i] = cv.d[i * 4 + 1];
                const dir = putFile('label.bin', out, now);
                streetPic = { w, h, seq: ++labelSeq, street, dir };
            } catch (e) { log.warn('street label: ' + errText(e)); }
            return streetPic;
        }

        const camPositioning = () => page === 2 && posMode === 'cam' && ui.isVisible('MAIN');
        const signPositioning = () => page === 2 && posMode === 'sign' && ui.isVisible('MAIN');
        const calibrating = () => page === 3 && ui.isVisible('MAIN');
        const navNow = (st) => (st && st.nav && st.nav.last && st.nav.last.active ? st.nav.last : null);

        function buildSignPayload(s) {
            return {
                mode: s.signMode, show: s.signShow, empty: s.signEmpty, frontcam: s.signFrontcam,
                side: s.signSide, hudSide: s.signHudSide, size: s.signSize, source: s.signSource,
                camera: s.signCamera, bmwmap: s.signBmwMap, minLimit: s.signMinLimit, screen: s.signScreen,
                warn: s.signWarn, probe: s.signProbe, mapX: s.signMapX, mapY: s.signMapY, hudX: s.signHudX, hudY: s.signHudY,
            };
        }

        function tick() {
            const now = Date.now();
            if (camPositioning()) { test = edit; testUntil = now + 1500; }
            if (calibrating()) { test = calCam === 'front' ? 'calfront' : calCam; testUntil = now + 1500; }
            if (test && now >= testUntil) { test = null; log.info('test ended'); }
            const side = blinker.side(now);
            if (side) lastSide = side;
            const s = cfg(now);
            const st = readStatus(now);
            const n = st && st.native;
            const kmhNow = speed !== null && now - speedAt < SPEED_STALE_MS ? speed : null;
            const nvNow = navNow(st);

            if (s.ar === 'off' || s.enabled === 'off' || !nvNow) { arHoldUntil = 0; arLatched = false; }
            else if (L.arWanted({ arMode: s.ar, nav: nvNow, speed: kmhNow, arLatched })) { arHoldUntil = now + AR_HOLD_MS; arLatched = true; }
            else if (now >= arHoldUntil) { arLatched = false; }

            if (s.front === 'off' || s.enabled === 'off') { frontHoldUntil = 0; frontLatched = false; }
            else if (s.front === 'always' || (kmhNow !== null && /^slow(\d+)$/.test(String(s.front)) && kmhNow <= Number(RegExp.$1) + (frontLatched ? 4 : 0))) {
                frontHoldUntil = now + FRONT_HOLD_MS;
                frontLatched = true;
            } else if (now >= frontHoldUntil) {
                frontLatched = false;
            }

            if (n && n.aux_state === 'refused' && now - auxRefusedAt >= 15000) {
                auxRefusedAt = now;
                auxReason = String(n.aux_reason || '').slice(0, 80);
                log.warn('second view refused (' + (n.aux_reason || '') + ')');
            }

            const p = L.plan({
                enabled: s.enabled !== 'off', reverse, mode: s.mode, source: s.source, side, test, front: s.front,
                frontLatched, frontHold: now < frontHoldUntil,
                arMode: s.ar, nav: nvNow, arLatched, arHold: now < arHoldUntil,
                dual: s.blinkFront, auxRefused: now - auxRefusedAt < 15000,
                speed: kmhNow, maxSpeed: Number(s.maxSpeed) || 0,
                cam: cam.info().cam,
                helper: { ok: !!n, pictureAge: n ? n.picture_age_ms : null, pictureW: n ? n.picture_w : 0, pictureH: n ? n.picture_h : 0, pair: n ? n.pair : null },
            });
            if (p.view !== lastPlan.view || p.why !== lastPlan.why) log.info('view ' + p.view + (p.why ? ' (' + p.why + ')' : ''));
            lastPlan = p;

            const targets = L.parseTargets(n && n.targets);
            const shownSide = p.view === 'left' || p.view === 'right' ? p.view : test === 'left' || test === 'right' ? test : lastSide;
            const kmh = p.ar === 'route' && kmhNow !== null ? Math.round(kmhNow / 5) * 5 : -1;
            const ar = Object.assign(
                L.arConfig(s, p.view === 'front' ? p.ar : 'off', kmh),
                p.ar === 'route' && nvNow && nvNow.street && s.arStreet !== 'off' && streetLabel(nvNow.street, s, now)
                    ? { label: { w: streetPic.w, h: streetPic.h, seq: streetPic.seq, street: streetPic.street } } : {},
                { nav: s.ar === 'near' || s.ar === 'always' || page === 4 ? 1 : 0 }
            );

            const signs = buildSignPayload(s);
            const vmc = { mode: s.vmcMode, view: s.vmcView };
            const preview = signPositioning() ? Object.assign({ at: new Date(now).toISOString() }, dragSign ? { drag: { t: dragSign.t, x: dragSign.x, y: dragSign.y } } : {}) : null;
            const viewCfg = L.viewConfig(s, targets, shownSide, p.view, !!p.aux);
            const auxCfg = p.aux ? L.auxConfig(s, targets, p.aux) : null;
            const appSpd = st && st.speed_own === false && kmhNow !== null ? Math.round(kmhNow * 10) / 10 : undefined;

            const body = JSON.stringify({ view: p.view, config: viewCfg, ar, aux: auxCfg, signs, vmc, preview: preview ? (dragSign || 1) : 0 });
            const active = p.view !== 'none' || !!preview;
            const intervalMs = dragSign ? 80 : HEARTBEAT_MS;
            if (body !== lastControlBody || (active && now - lastWriteAt >= intervalMs)) {
                if (body !== lastControlBody) seq++;
                lastControlBody = body;
                lastWriteAt = now;
                try {
                    const dir = sendPayload({
                        at: new Date(now).toISOString(), seq, view: p.view, config: viewCfg, ar, aux: auxCfg,
                        signs, vmc, preview, speed: appSpd,
                    }, now);
                    if (streetPic && streetPic.dir !== dir && dir !== RUN_DIR) labelFor = null;
                } catch (e) { log.warn('control send: ' + errText(e)); }
            }

            const busy = !!(side || test) || cam.info().phase !== 'on';
            if (p.want !== lastWant || busy !== lastBusy || now - camTickAt >= (busy ? CAM_TICK_MS : CAM_IDLE_MS)) {
                lastWant = p.want;
                lastBusy = busy;
                camTickAt = now;
                cam.tick(p.want);
            }
        }
        setInterval(tick, TICK_MS);

        /* ---- UI Model ---- */
        const SIDE = { LEFT: 'Trái', RIGHT: 'Phải', HAZARD: 'Đèn khẩn cấp', OFF: 'Tắt', WAITING: 'Chưa nhận tín hiệu' };
        const VIEW = { left: 'Camera trái', right: 'Camera phải', all: 'Cả 4 camera', front: 'Camera trước' };
        const PHASE = { on: 'đúng chế độ', idle: 'chưa yêu cầu', asked: 'đã yêu cầu', waiting: 'chờ thử lại', starting: 'đang khởi động', 'parking view': 'camera đỗ xe', 'asked (state unreadable)': 'đã yêu cầu' };
        const label = (key) => settings.display(key);

        let perfPrev = null, perfOut = { text: 'đang đo', warn: false }, heat = null, heatAt = 0;
        function cpuHeat(now) {
            if (now - heatAt < 5000) return heat;
            heatAt = now; heat = null;
            try {
                fs.readdirSync('/sys/class/thermal').filter((d) => /^thermal_zone\d+$/.test(d)).forEach((d) => {
                    const t = Number(fs.readFileSync('/sys/class/thermal/' + d + '/temp', 'utf8')) / 1000;
                    if (t > 0 && t < 150 && (heat === null || t > heat)) heat = t;
                });
            } catch (e) {}
            return heat;
        }
        function perf(now, n) {
            const cur = { t: now, sent: n.frames_sent || 0, aux: n.aux_frames || 0, dropped: n.dropped || 0, lost: n.lost || 0, pics: n.pictures || 0 };
            if (!perfPrev || cur.sent < perfPrev.sent || cur.pics < perfPrev.pics) { perfPrev = cur; return perfOut; }
            const dt = (now - perfPrev.t) / 1000;
            if (dt < 2) return perfOut;
            const r = (k) => Math.round((cur[k] - perfPrev[k]) / dt * 10) / 10;
            const sent = r('sent'), aux = r('aux'), drop = r('dropped'), lost = r('lost');
            const h = cpuHeat(now);
            const ms = (us) => (us / 1000).toFixed(1).replace('.', ',');
            perfOut = {
                warn: drop > 0 || lost > 2 || (h !== null && h >= 90),
                text: 'giải mã ' + ms(n.decode_us || 0) + ' · vẽ ' + ms(n.view_us || 0) + (n.aux_us ? '+' + ms(n.aux_us) : '') + ' ms · ' + Math.round(sent) + (aux ? '+' + Math.round(aux) : '') +
                    ' hình/s · rớt ' + drop + (lost ? ' · mất ' + lost : '') + (h !== null ? ' · CPU ' + Math.round(h) + '°C' : ''),
            };
            perfPrev = cur;
            return perfOut;
        }

        function model() {
            const now = Date.now();
            const s = cfg(now), st = readStatus(now), n = st && st.native, info = cam.info();
            const targets = L.parseTargets(n && n.targets);
            const sr = L.signReport(st, s);
            const geoMapBase = L.signGeometry(st, s, 'map');
            const geoHudBase = L.signGeometry(st, s, 'hud');
            const signMap = dragSign && dragSign.t === 'map' ? Object.assign({}, geoMapBase, { x: dragSign.x, y: dragSign.y, placed: true }) : geoMapBase;
            const signHud = dragSign && dragSign.t === 'hud' ? Object.assign({}, geoHudBase, { x: dragSign.x, y: dragSign.y, placed: true }) : geoHudBase;

            const frontShort = { off: s.ar === 'off' ? 'tắt' : 'theo AR', slow30: '< 30 km/h', slow60: '< 60 km/h', always: 'luôn bật' };
            const v = {
                page, posMode, edit, signEditing,
                enabled: s.enabled !== 'off', round: s.shape !== 'square', gauge: s.place === 'gauge' || s.place === undefined,
                sizeLabel: label('size'), front: frontShort[s.front] || 'tắt',
                signOn: s.signMode !== 'off', signEmpty: s.signEmpty, signShowLabel: label('signShow'),
                signShowShort: s.signShow === 'cluster' ? 'Đồng hồ' : s.signShow === 'hud' ? 'HUD' : 'Cả hai',
                signSizeLabel: label('signSize'),
                signLimit: sr.limit || sr.phoneLimit, signDashes: sr.dashes, signReport: sr,
                signMap, signHud, signDragging: !!dragSign,
                hudBox: st && st.waze && st.waze.hudBox,
                pairCode: st && st.pairing && st.pairing.code ? String(st.pairing.code) : null,
                vmcOn: s.vmcMode === 'on', vmcRunning: !!(st && st.vmc && st.vmc.running), vmcViewLabel: label('vmcView'),
            };

            v.discs = {};
            ['left', 'right'].forEach((side) => {
                const c = L.viewConfig(s, targets, side);
                if (c.target === 'panel') v.discs[side] = { x: c.x, y: c.y, w: c.w, h: c.h };
                else if (c.target === 'map') v.discs[side] = { x: UI.MAP.x + c.x, y: UI.MAP.y + c.y, w: c.w, h: c.h };
            });
            if (s.front !== 'off' || lastPlan.view === 'front') {
                const f = L.frontConfig(s, targets);
                v.frontRect = { x: UI.MAP.x + f.x, y: UI.MAP.y + f.y, w: f.w, h: f.h };
            }

            const showing = lastPlan.view !== 'none' && n && n.shown;
            v.shown = showing ? lastPlan.view : null;
            v.shownAux = showing && lastPlan.aux && n.aux_shown ? lastPlan.aux : null;
            if (lastPlan.view !== 'none') {
                if (showing && n.layer === 'shown') { v.title = 'Đang hiện ' + VIEW[lastPlan.view].toLowerCase(); v.titleKind = 'go'; }
                else if (showing) { v.title = VIEW[lastPlan.view]; v.titleKind = 'warn'; v.subtitle = 'Đang gửi hình (' + n.layer + ')'; }
                else { v.title = VIEW[lastPlan.view]; v.titleKind = 'warn'; v.subtitle = 'Đang bật' + (n && n.why ? ': ' + (WHY_VI[n.why] || n.why) : ''); }
            } else {
                v.title = lastPlan.why;
                v.titleKind = lastPlan.why === 'Chờ xi nhan' ? 'dim' : 'warn';
                if (lastPlan.why === 'Chờ xi nhan') v.subtitle = 'Sẵn sàng camera gương xi nhan · ' + (v.signOn ? ('biển tốc độ: ' + (sr.limit ? sr.limit + ' km/h' : sr.dashes ? '---' : 'chờ')) : 'biển báo tắt');
            }

            const fresh = n && n.picture_age_ms >= 0 && n.picture_age_ms < 1500;
            const signalOk = lightState === 'Đã kết nối';
            const signTxt = !v.signOn ? 'Đang tắt'
                : sr.limit ? ('Biển ' + sr.limit + ' km/h (' + (sr.source === 'camera' ? 'Camera BMW' : sr.source === 'phone' ? 'VietMap ĐT' : sr.source === 'bmwmap' ? 'Bản đồ BMW' : 'Màn giữa') + ')' + (st && st.over ? ' · VƯỢT TỐC' : ''))
                    : sr.dashes ? 'Đang hiện --- (chưa có biển)' : 'Chưa có biển';
            v.rows = [
                { label: 'Xi nhan', text: SIDE[blinker.state()] + (signalOk ? '' : ' (' + lightState + ')'), kind: signalOk ? (blinker.state() === 'WAITING' ? 'dim' : 'go') : 'warn' },
                { label: 'Hộp camera', kind: info.phase === 'on' ? 'go' : info.phase === 'idle' ? 'dim' : 'warn',
                    text: (info.cam.known ? info.cam.text : link.icam === 'ok' || link.xv === 'ok' ? 'chưa đọc được' : 'chưa nối') + ' · ' + (PHASE[info.phase] || info.phase) },
                { label: 'Luồng hình', kind: fresh ? 'go' : 'warn',
                    text: !st ? 'Trợ thủ bimmer-drive chưa chạy' : !n ? 'Trợ thủ: ' + (st.note || 'đang khởi động') : fresh
                        ? n.picture_w + 'x' + n.picture_h + ' · ' + (st.fps || 0) + ' hình/s' + (lastPlan.view === 'none' ? ' · ngủ giải mã' : '')
                        : 'chưa có hình (' + (n.avb === 'ok' ? 'hộp camera chưa phát' : (n.avb || 'đang nối')) + ')' },
                { label: 'Biển tốc độ', kind: !v.signOn ? 'dim' : st && st.over ? 'warn' : (st && st.shown && st.shown.length) ? 'go' : 'dim', text: signTxt },
                { label: 'Đồng hồ/HUD', kind: n && n.cr === 'connected' && n.layer !== 'refused' ? 'go' : 'warn',
                    text: !n ? 'chờ trợ thủ' : n.cr !== 'connected' ? 'chưa nối cluster-render' : 'sẵn sàng' + (v.vmcRunning ? ' · đang chiếu màn giữa AA' : st && st.waze && st.waze.map ? ' · có bản đồ' : '') },
            ];
            if (n) {
                const pf = perf(now, n);
                v.rows.push({ label: 'Hiệu năng', kind: pf.warn ? 'warn' : 'dim', text: pf.text });
            }
            v.version = 'Bản ' + ctx.spec.version + (st && st.version ? ' · trợ thủ ' + st.version : '');
            if (page === 2 || page === 3) {
                v.note = showing ? 'Đang hiện trực tiếp trên đồng hồ' : lastPlan.why || '';
                v.noteKind = showing ? 'go' : 'warn';
                v.signPosNote = st && st.placing && st.shown && st.shown.length ? 'Đang hiện biển thử trên ' + st.shown.map((x) => (x === 'map' ? 'đồng hồ' : 'HUD')).join(' & ') : '';
            }
            if (page === 3) {
                v.calCam = calCam;
                if (calCam === 'front') {
                    const U = { calH: ' cm', calPitch: '°', calFov: '°', calYaw: '°', calShift: ' cm', calCurve: '', frontZoom: ' %', frontPanY: '' };
                    const N = { calH: 'Độ cao camera', calPitch: 'Chúc xuống', calFov: 'Góc nhìn', calYaw: 'Lệch trái / phải', calShift: 'Dịch ngang', calCurve: 'Độ cong (mắt cá)', frontZoom: 'Phóng to', frontPanY: 'Dịch hình xuống' };
                    v.calRows = Object.keys(L.CALIB).map((k) => ({ key: k, label: N[k], text: L.calib(s, k) + U[k] }));
                } else {
                    const isL = calCam === 'left';
                    v.calText = 'Dịch ngang ' + (Number(s[isL ? 'panLx' : 'panRx']) || 0) + ' · dọc ' + (Number(s[isL ? 'panLy' : 'panRy']) || 0) + ' · phóng ' + (Number(s[isL ? 'zoomL' : 'zoomR']) || 100) + ' %';
                }
            }
            if (page === 4) {
                const nv = (st && st.nav) || null, last = nv && nv.last;
                const PROV = { NONE: 'Bản đồ BMW', CAR_PLAY: 'Apple CarPlay', CARPLAY: 'Apple CarPlay', ANDROID_AUTO: 'Android Auto' };
                const KIND = { turn: 'Rẽ', roundabout: 'Vòng xuyến', destination: 'Đến nơi', straight: 'Đi thẳng' };
                const turnText = !last || !last.kind ? 'chưa có' : KIND[last.kind] + (last.kind === 'turn' ? (last.angle < 0 ? ' trái' : ' phải') + (Math.abs(last.angle) <= 45 ? ' nhẹ' : Math.abs(last.angle) >= 170 ? ' (quay đầu)' : '') : last.kind === 'roundabout' && last.exit ? ', lối ra ' + last.exit : '') +
                    (last.street ? ' vào ' + last.street : '') + (last.meters >= 0 ? ' · còn ' + (last.meters >= 1000 ? (last.meters / 1000).toFixed(1).replace('.', ',') + ' km' : last.meters + ' m') : '');
                const NS = { 'not started': 'đang tạm nghỉ (bật khi cần)', starting: 'đang mở', found: 'đã thấy dịch vụ', reading: 'đang đọc trực tiếp', 'no interface': 'xe không có dịch vụ dẫn đường', ended: 'sẽ thử lại', 'failed to start': 'chưa mở được' };
                v.navRows = [
                    { label: 'Đọc dẫn đường', text: !st ? 'Trợ thủ chưa chạy' : (NS[nv && nv.state] || (nv && nv.state) || '-') + (nv && nv.note ? ' · ' + nv.note : ''), kind: nv && nv.state === 'reading' ? 'go' : 'dim' },
                    { label: 'Nguồn', text: last ? (PROV[last.provider] || last.provider || 'Bản đồ') : (nv && nv.proxies && nv.proxies.length ? nv.proxies.join(' · ') : 'chưa có'), kind: last ? 'go' : 'dim' },
                    { label: 'Lệnh kế tiếp', text: turnText, kind: last && last.active ? 'go' : 'dim' },
                    { label: 'Dữ liệu thô', text: nv && nv.raw ? String(nv.raw).slice(0, 110) : 'chưa có', kind: 'dim' },
                ];
                v.arLabel = label('ar');
                v.arCard = s.arCard !== 'off';
                v.demo = test === 'ardemo';
            }
            return v;
        }

        /* ---- Interactive Actions ---- */
        const startTest = (view, secs) => () => {
            if (test === view && !camPositioning()) { test = null; testUntil = 0; }
            else { test = view; testUntil = Date.now() + secs * 1000; log.info('test ' + view + ' for ' + secs + ' s'); }
            tick(); repaint();
        };
        const cycle = (key) => () => { settings.cycle(key); };
        const num = (key) => Number(settings.get(key)) || 0;
        const moveCam = (dx, dy) => () => {
            if (settings.get('place') !== 'gauge') settings.set('place', 'gauge');
            settings.set('gaugeDx', Math.max(-400, Math.min(400, num('gaugeDx') + dx)));
            settings.set('gaugeDy', Math.max(-200, Math.min(200, num('gaugeDy') + dy)));
        };
        const sizes = settings.item('size').options.map((o) => o[0]);
        const resizeCam = (d) => () => { const i = Math.max(0, Math.min(sizes.length - 1, sizes.indexOf(settings.get('size')) + d)); settings.set('size', sizes[i]); };

        const signKeys = (tg) => (tg === 'map' ? ['signMapX', 'signMapY'] : ['signHudX', 'signHudY']);
        const clampSign = (tg, x, y) => {
            const g = L.signGeometry(readStatus(Date.now()), cfg(), tg);
            return { x: Math.round(Math.max(0, Math.min(g.w - g.size, x))), y: Math.round(Math.max(0, Math.min(g.h - g.size, y))) };
        };
        const placeSign = (tg, x, y) => {
            const at = clampSign(tg, x, y);
            const k = signKeys(tg);
            settings.set(k[0], at.x);
            settings.set(k[1], at.y);
            tick(); repaint();
        };
        const stepSign = (dx, dy) => () => {
            const g = L.signGeometry(readStatus(Date.now()), cfg(), signEditing);
            placeSign(signEditing, g.x + dx, g.y + dy);
        };

        const acts = {
            left: startTest('left', 8), right: startTest('right', 8), all: startTest('all', 15),
            front: cycle('front'),
            toggle: () => settings.set('enabled', settings.get('enabled') === 'off' ? 'on' : 'off'),
            signToggle: () => settings.set('signMode', settings.get('signMode') === 'off' ? 'on' : 'off'),
            signShowCycle: cycle('signShow'),
            signEmptyCycle: cycle('signEmpty'),
            signSizeCycle: cycle('signSize'),
            vmcToggle: () => settings.set('vmcMode', settings.get('vmcMode') === 'on' ? 'off' : 'on'),
            vmcViewCycle: cycle('vmcView'),
            newCode: () => {
                const now = Date.now();
                if (ensureSocket(now) && ctlSock) { try { ctlSock.write(JSON.stringify({ cmd: 'pair-new' }) + '\n'); } catch (e) {} }
                else { try { putFile('pair-new', '1', now); } catch (e) {} }
                setTimeout(repaint, 250);
            },
            // Position tab
            posModeToggle: () => { posMode = posMode === 'cam' ? 'sign' : 'cam'; test = null; tick(); repaint(); },
            side: () => { edit = edit === 'left' ? 'right' : 'left'; tick(); repaint(); },
            up: moveCam(0, -UI.STEP), down: moveCam(0, UI.STEP),
            moveLeft: () => moveCam(edit === 'left' ? -UI.STEP : UI.STEP, 0)(),
            moveRight: () => moveCam(edit === 'left' ? UI.STEP : -UI.STEP, 0)(),
            smaller: resizeCam(-1), larger: resizeCam(1), shape: cycle('shape'),
            reset: () => { settings.set('gaugeDx', 0); settings.set('gaugeDy', 0); settings.set('place', 'gauge'); settings.set('size', 'fit'); },
            signTargetToggle: () => { signEditing = signEditing === 'map' ? 'hud' : 'map'; tick(); repaint(); },
            signUp: stepSign(0, -UI.STEP), signDown: stepSign(0, UI.STEP),
            signLeft: stepSign(-UI.STEP, 0), signRight: stepSign(UI.STEP, 0),
            signPosReset: () => { const k = signKeys(signEditing); settings.set(k[0], null); settings.set(k[1], null); tick(); repaint(); },
            // Calibrate tab
            camL: () => { calCam = 'left'; tick(); repaint(); },
            camR: () => { calCam = 'right'; tick(); repaint(); },
            camF: () => { calCam = 'front'; tick(); repaint(); },
            panL: () => pan(-20, 0), panR: () => pan(20, 0), panU: () => pan(0, -20), panD: () => pan(0, 20),
            zoomIn: () => zoomCam(10), zoomOut: () => zoomCam(-10),
            calReset: () => {
                if (calCam === 'front') Object.keys(L.CALIB).forEach((k) => settings.set(k, L.CALIB[k].d));
                else { const S = calCam === 'left' ? 'L' : 'R'; settings.set('pan' + S + 'x', 0); settings.set('pan' + S + 'y', 0); settings.set('zoom' + S, 100); }
            },
            // Navigation tab
            arMode: cycle('ar'), arCard: cycle('arCard'), demo: startTest('ardemo', 26),
        };

        function pan(dx, dy) {
            const S = calCam === 'left' ? 'L' : 'R';
            settings.set('pan' + S + 'x', Math.max(-500, Math.min(500, num('pan' + S + 'x') + dx)));
            settings.set('pan' + S + 'y', Math.max(-500, Math.min(500, num('pan' + S + 'y') + dy)));
        }
        function zoomCam(d) {
            const k = calCam === 'left' ? 'zoomL' : 'zoomR';
            settings.set(k, Math.max(100, Math.min(300, (num(k) || 100) + d)));
        }
        Object.keys(L.CALIB).forEach((k) => {
            const c = L.CALIB[k];
            acts[k + '-'] = () => settings.set(k, Math.max(c.min, L.calib(cfg(), k) - c.step));
            acts[k + '+'] = () => settings.set(k, Math.min(c.max, L.calib(cfg(), k) + c.step));
        });

        ctx.onTab((i) => { page = i; tick(); repaint(); });

        ctx.onTap((x, y) => {
            if (page !== 2) return;
            if (posMode === 'sign') {
                const hs = UI.hitSign(x, y);
                if (!hs) return;
                signEditing = hs.target;
                const g = L.signGeometry(readStatus(Date.now()), cfg(), hs.target);
                placeSign(hs.target, hs.x - g.size / 2, hs.y - g.size / 2);
                return;
            }
            const h = UI.hitCluster(x, y);
            if (!h) return;
            edit = h.x < UI.PANEL.w / 2 ? 'left' : 'right';
            const cx = edit === 'left' ? h.x : UI.PANEL.w - h.x;
            if (settings.get('place') !== 'gauge') settings.set('place', 'gauge');
            settings.set('gaugeDx', Math.round(Math.max(-400, Math.min(400, cx - L.GAUGE.cx))));
            settings.set('gaugeDy', Math.round(Math.max(-200, Math.min(200, h.y - L.GAUGE.cy))));
            tick(); repaint();
        });

        if (ctx.onDrag) ctx.onDrag((phase, x, y) => {
            if (phase === 'start') {
                if (page !== 2) return false;
                if (posMode === 'sign') {
                    const hs = UI.hitSign(x, y);
                    if (!hs) return false;
                    const g = L.signGeometry(readStatus(Date.now()), cfg(), hs.target);
                    const grab = Math.max(g.size, 90);
                    if (Math.abs(hs.x - (g.x + g.size / 2)) > grab || Math.abs(hs.y - (g.y + g.size / 2)) > grab) return false;
                    signEditing = hs.target;
                    dragSign = { t: hs.target, offX: g.x - hs.x, offY: g.y - hs.y, x: g.x, y: g.y, at: Date.now() };
                    tick(); repaint();
                    return true;
                }
                const h = UI.hitCluster(x, y);
                if (!h) return false;
                const st0 = readStatus(Date.now()), s = cfg(), targets = L.parseTargets(st0 && st0.native && st0.native.targets);
                const side = ['left', 'right'].find((sd) => {
                    const v = L.viewConfig(s, targets, sd);
                    if (v.target !== 'panel') return false;
                    const cx = v.x + v.w / 2, cy = v.y + v.h / 2, r = Math.max(v.w, v.h) / 2 + 60;
                    return Math.abs(h.x - cx) <= r && Math.abs(h.y - cy) <= r;
                });
                if (!side) return false;
                const v = L.viewConfig(s, targets, side);
                edit = side;
                dragCam = { side, dx: Number(s.gaugeDx) || 0, dy: Number(s.gaugeDy) || 0, offX: v.x + v.w / 2 - h.x, offY: v.y + v.h / 2 - h.y, at: Date.now() };
                return true;
            }
            if (dragSign) {
                if (phase === 'move' || phase === 'end') {
                    const P = UI.SIGN_PICS[dragSign.t];
                    const tx = (x - P.x) / P.k, ty = (y - P.y) / P.k;
                    const at = clampSign(dragSign.t, tx + dragSign.offX, ty + dragSign.offY);
                    dragSign.x = at.x; dragSign.y = at.y; dragSign.at = Date.now();
                }
                if (phase === 'end') { const d = dragSign; dragSign = null; placeSign(d.t, d.x, d.y); return true; }
                if (phase === 'cancel') dragSign = null;
                tick(); repaint();
                return true;
            }
            if (!dragCam) return false;
            const h = UI.hitCluster(x, y);
            if ((phase === 'move' || phase === 'end') && h) {
                const cx = h.x + dragCam.offX, cy = h.y + dragCam.offY;
                const dx = dragCam.side === 'left' ? cx - L.GAUGE.cx : UI.PANEL.w - L.GAUGE.cx - cx;
                dragCam.dx = Math.round(Math.max(-400, Math.min(400, dx)));
                dragCam.dy = Math.round(Math.max(-200, Math.min(200, cy - L.GAUGE.cy)));
                dragCam.at = Date.now();
            }
            if (phase === 'end' || phase === 'cancel') {
                const d = dragCam;
                dragCam = null;
                if (phase === 'end') {
                    if (settings.get('place') !== 'gauge') settings.set('place', 'gauge');
                    settings.set('gaugeDx', d.dx);
                    settings.set('gaugeDy', d.dy);
                }
            }
            tick(); repaint();
            return true;
        });

        const render = async () => {
            const cv = ctx.canvas(UI.W, UI.H) || new Canvas(UI.W, UI.H);
            UI.draw(cv, G, ctx.theme(), model(), acts);
            await ui.image('MAIN_GFX', cv);
        };
        const loop = ctx.loop('MAIN', 4, render);
        function repaint() { return loop && loop.kick ? loop.kick() : render(); }
        ['BTN_LEFT', 'BTN_RIGHT', 'BTN_FRONT', 'BTN_SIGN'].forEach((b) => { if (ctx.hideButton) ctx.hideButton(b); });
        ui.onClick('BTN_LEFT', acts.left);
        ui.onClick('BTN_RIGHT', acts.right);
        ui.onClick('BTN_FRONT', acts.front);
        ui.onClick('BTN_SIGN', acts.signToggle);
        settings.onChange(() => { applyBlinker(); tick(); repaint(); });

        if (ctx.app && ctx.app.on) ctx.app.on('shutdown', () => {
            try { sendPayload({ at: new Date().toISOString(), seq: ++seq, view: 'none', config: null, signs: buildSignPayload(cfg()), vmc: { mode: settings.get('vmcMode'), view: settings.get('vmcView') } }, Date.now()); } catch (e) {}
            if (ctlSock) { try { ctlSock.end(); } catch (e) {} }
            cam.release();
        });
        tick();
        await render();
        log.info('bimmer_drive ready (cam=' + settings.get('enabled') + ', signs=' + settings.get('signMode') + ', vmc=' + settings.get('vmcMode') + ')');
    },
});
