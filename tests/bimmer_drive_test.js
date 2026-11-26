'use strict';
/**
 * bimmer_drive_test.js - Comprehensive Unit & Integration Test Suite for Bimmer Drive v1.0.1.
 *
 * Verifies:
 *   1. Turn-signal decoding, string/numeric OFF variants, comfort-tap ceiling, distance cap, reverse release & speed hysteresis.
 *   2. Streamlined 5-row grouped `Cài đặt` menu (`apps/bimmer_drive/app.json` + `kit/runtime/sheet.js`), conditional `"when"` filtering,
 *      hidden tab-managed settings persistence, and `signPosReset` (`null`/`undefined`) safety.
 *   3. Unified SOME/IP signs & navigation parsers (`signs-cam.js`: 5 km/h garage filter, BMW map classes, KAFAS hold) + `signSource` priority modes
 *      (`auto`, `vietmap`, `vietmap_only`, `bmw_only`).
 *   4. Vietnam P.127 & OEM BMW `---` 3-dash sign pixel rendering (`drawSign`) + `MGU Studio` smooth on-demand `waking` UI state.
 *   5. Live `bimmer-drive.js` coordinator: Unix `ctl.sock` `<1ms` IPC, `mgu-sidecam` supervision, front-cam `map`/`panel` sign layer handoff,
 *      leftover `/run/vietmap-signs` directory replacement with symlink, UDP `8471` `vmsign` phone pairing & acks, and `MGU Studio` `wake.json` wakeup + auto-sleep.
 */
const assert = require('assert');
const dgram = require('dgram');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const L = require('../apps/bimmer_drive/logic');
const UI = require('../apps/bimmer_drive/ui');
const AnhUI = require('../apps/anh_dai_dien/ui');
const SC = require('../tools/bimmer-drive/signs-cam');
const WOC = require('../tools/bimmer-drive/woc-mirror');
const { Recorder } = require('../kit/runtime/record');
const { listSheet } = require('../kit/runtime/sheet');
const G = require('../kit/runtime/gauges');
const themes = require('../kit/runtime/themes');

let passed = 0;
function ok(cond, msg) {
    assert.ok(cond, msg);
    passed++;
}

/* ---- 1. Blinker, Hysteresis & Camera Plan Stability ---- */
{
    assert.strictEqual(L.decode({ controlIndicateDirection: 'BLINKEN_AUS', activeFunctionIndicateDirection: 0 }).direction, 'OFF');
    assert.strictEqual(L.decode({ controlIndicateDirection: 'KEIN_BLINKEN', activeFunctionIndicateDirection: 'AUS' }).direction, 'OFF');
    assert.strictEqual(L.decode({ controlIndicateDirection: 'TIPP_BLINKEN_LINKS_EIN' }).kind, 'tip');
    assert.strictEqual(L.decode({ controlIndicateDirection: 'DAUER_BLINKEN_RECHTS_EIN' }).direction, 'RIGHT');

    const b = L.createBlinker({ holdMs: 2000, tip: true, tipMaxMs: 6000, maxKm: 0.35, moveMaxMs: 20000 });
    b.event('LEFT', 'tip', 1000);
    ok(b.side(5000) === 'left', 'comfort tap active before 6s cap');
    ok(b.side(7100) === null && b.state() === 'OFF', 'comfort tap auto-clears at 6s cap if final OFF was missed');

    b.event('RIGHT', 'steady', 10000);
    b.travel(72, 10000);
    b.travel(72, 14000);
    b.travel(72, 18000);
    b.travel(72, 22000);
    b.travel(72, 26000);
    b.travel(72, 30000);
    ok(b.side(30500) === null, 'steady blinker missed-OFF clears after 350 m + 20 s');

    const pRev = L.plan({ enabled: true, reverse: true, side: 'left', mode: 'mosaic', source: 'auto', helper: { ok: true, pictureAge: 50, pictureH: 960 } });
    ok(pRev.view === 'none' && pRev.want === null, 'reverse gear releases camera immediately');

    const p32Cold = L.plan({ enabled: true, reverse: false, front: 'slow30', frontLatched: false, speed: 32, mode: 'mosaic', source: 'auto', cam: { kind: 'all4' }, helper: { ok: true, pictureAge: 50, pictureH: 960 } });
    const p32Warm = L.plan({ enabled: true, reverse: false, front: 'slow30', frontLatched: true, speed: 32, mode: 'mosaic', source: 'auto', cam: { kind: 'all4' }, helper: { ok: true, pictureAge: 50, pictureH: 960 } });
    ok(p32Cold.view === 'none' && p32Warm.view === 'front', 'slow30 hysteresis prevents flapping around 30 km/h');

    const vc = L.viewConfig({ layer: 'make' }, null, 'left', 'left', false);
    ok(vc.persist === 0, 'layer=make sets persist=0 so idle holds zero video slots');

    // Verify signPosReset null & undefined never coerce to x=0,y=0
    const gNull = L.signGeometry(null, { signMapX: null, signMapY: null, signSide: 'right' }, 'map');
    const gUndef = L.signGeometry(null, { signSide: 'right' }, 'map');
    ok(gNull.placed === false && gNull.x > 500 && gUndef.placed === false && gNull.x === gUndef.x, 'signGeometry ignores null/undefined saved coordinates cleanly');
}

/* ---- 2. Streamlined 5-Row Grouped Settings Menu & Manifest Validation (`app.json` + `sheet.js`) ---- */
{
    const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '../apps/bimmer_drive/app.json'), 'utf8'));
    ok(spec.startType === 'autostart', 'bimmer_drive declares startType=autostart so turn signals work immediately on car boot');
    ok((spec.screens[0].buttons || []).some((b) => b[0] === 'BTN_SETTINGS'), 'MAIN screen declares BTN_SETTINGS so GPU header renders CÀI ĐẶT tab');
    ok(spec.signals['de.bmw.body.Light'].StatusFunctionsIndicators === 's' && spec.signals['de.bmw.body.Light'].StatusFunctionsIndicators2 === 's',
        'Light indicators use subscribe-only ("s") matching MGU getterless SOME/IP fields');
    ok(spec.signals['de.bmw.infrastructure.VehicleInformation'].statusGearboxDrive === 's' && spec.signals['de.bmw.infrastructure.VehicleInformation'].DataPowerTrain2 === 's',
        'Gearbox signals use subscribe-only ("s") matching MGU getterless SOME/IP fields');
    ok(spec.signals['de.bmw.infotainment.video.cameraproxy.ICAM2Proxy'] === '*' && spec.signals['de.bmw.dass.XView3D'] === '*',
        'Camera proxies use "*" wildcard for cross-SP18/SP21 compatibility');
    const vals = {};
    spec.settings.forEach((s) => { vals[s.key] = s.default; });
    const mockSettings = {
        schema: spec.settings,
        values: vals,
        get(k) { return this.values[k]; },
        set(k, v) { this.values[k] = v; },
        shown(s) {
            if (!s || s.hidden) return false;
            return !s.when || Object.keys(s.when).every((k) => [].concat(s.when[k]).indexOf(this.values[k]) >= 0);
        },
        display(k) {
            const s = this.schema.find((x) => x.key === k);
            const o = s && (s.options || []).find((x) => x[0] === this.values[k]);
            return o ? o[1] : String(this.values[k]);
        },
        cycle(k) {
            const s = this.schema.find((x) => x.key === k);
            const list = s.options.map((o) => o[0]);
            this.values[k] = list[(list.indexOf(this.values[k]) + 1) % list.length];
        },
    };
    const sh = listSheet(mockSettings, 'Cài đặt', { version: spec.version });
    const topRows = sh.rows();
    ok(topRows.length === 5, 'Top-level Cài đặt has exactly 5 clean rows (4 groups + Màu giao diện), zero scrolling needed');
    ok(topRows[0].label === 'Camera gương xi nhan' && topRows[1].label === 'Camera trước & Mũi tên AR' && topRows[2].label === 'Biển báo tốc độ', 'Group labels match clean Vietnamese categories');

    // Open group 1 ("Camera trước & Mũi tên AR"): with ar='near' (default), 6 rows; when ar='off', AR style/color/street auto-hide to 3 rows!
    sh.focus = 1;
    sh.choose();
    ok(sh.group === 'Camera trước & Mũi tên AR' && sh.rows().length === 6, 'Front & AR group shows 6 items when AR is enabled');
    mockSettings.set('ar', 'off');
    ok(sh.rows().length === 3, 'Front & AR group dynamically hides AR style/color/street when AR is turned off');
    mockSettings.set('ar', 'near');
    sh.back();
    ok(sh.group === null && sh.focus === 1, 'Back from group restores top-level focus');

    // Open group 3 ("Tương thích phần cứng camera"): switching mode='single' hides mosaic-only pairSwap/quadLeft/quadRight
    sh.focus = 3;
    sh.choose();
    const mosaicRows = sh.rows().length;
    mockSettings.set('mode', 'single');
    const singleRows = sh.rows().length;
    ok(mosaicRows === 9 && singleRows === 6, 'Hardware compatibility group hides 3 mosaic-only settings when mode=single');
    mockSettings.set('mode', 'mosaic');

    // Draw sheet onto Recorder to verify GPU rendering of sheet
    const rec = new Recorder(UI.W, UI.H);
    const targets = sh.draw(rec, themes.theme('m_tricolour'));
    ok(Array.isArray(targets) && targets.length > 0, 'GPU Settings sheet renders cleanly with touch targets');
}

/* ---- 3. Signs & Navigation Unified Parsers + `signSource` Priority Modes ---- */
{
    const mGarage = SC.mapPick({ presentClassLimitSpeed: 1, unitOfMeasurementSpeedLimit: 0 }, 10);
    ok(mGarage.limit === 0 && mGarage.low === 5, 'BMW map class 1 (5 km/h garage) filtered when minLimit=10');
    const mGarageKeep = SC.mapPick({ presentClassLimitSpeed: 1, unitOfMeasurementSpeedLimit: 0 }, 5);
    ok(mGarageKeep.limit === 5, 'BMW map class 1 allowed when minLimit=5');
    const m60 = SC.mapPick({ presentClassLimitSpeed: 12, unitOfMeasurementSpeedLimit: 0, nextClassLimitSpeed: 16 }, 10);
    ok(m60.limit === 60 && m60.nextLimit === 80, 'BMW map class 12 = 60 km/h, next 16 = 80 km/h');

    const camEvt = {
        eventDataQualifier: 'EVENT_DATA_AVAILABLE',
        trafficSignRecognition: { numberSigns: 2, speedLimitUnit: 'KM_H' },
        trafficSign: [
            { type: 'SPEED_LIMIT', value: 50, firstSupplementalType: 'SS_TRUCK' },
            { type: 'SPEED_LIMIT', value: 70, firstSupplementalType: 'NONE' },
        ],
    };
    const picked = SC.pick(camEvt, 10);
    ok(picked && picked.limit === 70, 'KAFAS picks passenger car speed limit 70 over truck 50');

    const rbt = SC.maneuver({ roundabout: { exitNumber: 2, formattedDistance: { rawDistance: 120 }, description: { elements: [{ text: 'Võ Nguyên Giáp' }] } } }, {});
    ok(rbt.kind === 'roundabout' && rbt.exit === 2 && rbt.meters === 120 && rbt.street === 'Võ Nguyên Giáp', 'roundabout exit & street parsed');

    // Test signSource priority modes in decideSigns (`auto` vs `vietmap` vs `vietmap_only` vs `bmw_only`)
    const BD = require('../tools/bimmer-drive/bimmer-drive');
    const now = Date.now();
    SC.onEvent(BD.camState, {
        eventDataQualifier: 'EVENT_DATA_AVAILABLE',
        trafficSignRecognition: { numberSigns: 1, speedLimitUnit: 'KM_H' },
        trafficSign: [{ type: 'SPEED_LIMIT', value: 70, firstSupplementalType: 'NONE' }],
    }, now);
    Object.assign(BD.phone, { from: '172.16.222.50', at: now, limit: 50 });

    const mkCtrl = (source) => ({
        pvFresh: false, pvDrag: null, appSpeed: 40,
        signDesired: {
            on: true, show: 'both', side: 'right', hudSide: 'left', size: 'medium',
            source, phone: source !== 'bmw_only', camera: source !== 'vietmap_only', bmwMap: source !== 'vietmap_only',
            screen: false, empty: 'dashes', frontcam: true, minLimit: 10, warn: 5, mapPos: null, hudPos: null,
        },
    });
    const dAuto = BD.decideSigns(mkCtrl('auto'), null, false, false, now);
    ok(dAuto.limit === 70 && dAuto.source === 'camera', 'signSource=auto prioritizes BMW KAFAS camera (70) over phone (50)');

    const dVm = BD.decideSigns(mkCtrl('vietmap'), null, false, false, now);
    ok(dVm.limit === 50 && dVm.source === 'phone', 'signSource=vietmap prioritizes VietMap phone (50) over BMW KAFAS camera (70)');

    // When phone goes stale in signSource=vietmap, it seamlessly falls back to BMW KAFAS camera (70)!
    BD.phone.at = now - 20000;
    const dVmFallback = BD.decideSigns(mkCtrl('vietmap'), null, false, false, now);
    ok(dVmFallback.limit === 70 && dVmFallback.source === 'camera', 'signSource=vietmap falls back to BMW camera (70) when phone disconnects');

    // In vietmap_only, stale phone falls back to --- (ignores BMW camera)
    const dVmOnly = BD.decideSigns(mkCtrl('vietmap_only'), null, false, false, now);
    ok(dVmOnly.limit === null && dVmOnly.symbol === '---', 'signSource=vietmap_only shows --- when phone has no sign');

    // In bmw_only, connected phone is ignored in favor of BMW camera
    BD.phone.at = now;
    const dBmwOnly = BD.decideSigns(mkCtrl('bmw_only'), null, false, false, now);
    ok(dBmwOnly.limit === 70 && dBmwOnly.source === 'camera', 'signSource=bmw_only ignores phone and uses BMW camera');

    // Reset shared state before integration test
    BD.camState.limit = 0;
    BD.phone.at = 0;
    BD.phone.limit = null;
}

/* ---- 4. UI Rendering Across All 5 Tabs + MGU Studio Waking State ---- */
{
    const BD = require('../tools/bimmer-drive/bimmer-drive');
    const px60 = BD.drawSign(60, 128, false);
    const pxDash = BD.drawSign('---', 128, false);
    ok(px60.length === 128 * 128 * 4 && pxDash.length === 128 * 128 * 4, 'drawSign produces 128x128 RGBA buffers');
    const mid = (64 * 128 + 64) * 4;
    ok(pxDash[mid] < 40 && pxDash[mid + 3] === 255, 'OEM 3-dash sign draws crisp dark middle dash');

    const theme = themes.theme('m_tricolour');
    for (let page = 0; page < 5; page++) {
        const cv = new Recorder(UI.W, UI.H);
        UI.draw(cv, G, theme, {
            page, posMode: page === 2 ? 'sign' : 'cam', edit: 'left', signEditing: 'map',
            enabled: true, round: true, gauge: true, front: 'theo AR', signOn: true, signEmpty: 'dashes',
            signLimit: 60, signDashes: false, pairCode: '482915',
            signMap: { x: 760, y: 36, size: 128, w: 1088, h: 480, placed: false },
            signHud: { x: 88, y: 98, size: 80, w: 800, h: 480, placed: false },
            discs: { left: { x: 220, y: 240, w: 320, h: 320 }, right: { x: 1380, y: 240, w: 320, h: 320 } },
            rows: [{ label: 'Xi nhan', text: 'Tắt', kind: 'dim' }],
            signReport: { limit: 60, source: 'phone', lines: [{ text: 'Điện thoại: 60', kind: 'go' }], note: 'Đang hiện' },
            calCam: 'front', calRows: [{ key: 'calH', label: 'Độ cao', text: '70 cm' }],
            navRows: [{ label: 'Nguồn', text: 'Apple CarPlay', kind: 'go' }],
        }, {});
        ok(cv.w === UI.W && cv.h === UI.H, 'UI tab ' + page + ' renders cleanly');
    }

    // MGU Studio smooth on-demand waking state
    const cvAnh = new Recorder(AnhUI.W, AnhUI.H);
    const seenTexts = [];
    const origText = cvAnh.text.bind(cvAnh);
    cvAnh.text = function (s) { seenTexts.push(String(s)); return origText.apply(cvAnh, arguments); };
    AnhUI.draw(cvAnh, G, theme, { state: 'down', waking: true, version: 'Bản 1.0.1' }, {});
    ok(seenTexts.some((s) => s.indexOf('Đang đánh thức trợ thủ') >= 0) && seenTexts.some((s) => s.indexOf('ĐANG BẬT TRỢ THỦ') >= 0), 'MGU Studio shows friendly waking message instead of error during on-demand startup');

    ok(WOC.envLine('zoom1').indexOf('1600x600:308,60,1088,480') >= 0, 'WOC mirror crop line matches zoom1');
}

/* ---- 5. Live Coordinator + Socket IPC + UDP 8471 + MGU Studio On-Demand Integration ---- */
async function runIntegration() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bimmer-drive-test-'));
    const oapDir = path.join(tmp, 'oap');
    const appRoot = path.join(oapDir, 'oap_101');
    const anhRoot = path.join(oapDir, 'oap_102');
    const runDir = path.join(tmp, 'run');
    const compatDir = path.join(tmp, 'compat-vms');
    const stateDir = path.join(tmp, 'state');
    const wocRun = path.join(tmp, 'woc-run');
    const anhRun = path.join(tmp, 'anh-run');
    const wakeFlag = path.join(tmp, 'systemctl.called');

    const mkp = (d) => { if (!fs.existsSync(d)) { mkp(path.dirname(d)); fs.mkdirSync(d); } };
    [oapDir, path.join(appRoot, 'source/javascript/kit'), path.join(appRoot, 'data'),
        path.join(anhRoot, 'source/javascript/kit'), path.join(anhRoot, 'data'),
        runDir, compatDir, stateDir, wocRun, anhRun].forEach(mkp);

    // Pre-populate leftover stale file in compatDir to verify ensureCompatSymlink replaces leftover directory cleanly
    fs.writeFileSync(path.join(compatDir, 'status.json'), '{}');

    fs.writeFileSync(path.join(appRoot, 'source/javascript/kit/app-spec.json'), JSON.stringify({ id: 'bimmer_drive', version: '1.0.2' }));
    fs.writeFileSync(path.join(anhRoot, 'source/javascript/kit/app-spec.json'), JSON.stringify({ id: 'anh_dai_dien', version: '1.0.2' }));
    fs.writeFileSync(path.join(wocRun, 'status.json'), JSON.stringify({ state: 'starting', reason: 'under an alert on the cluster', target: 'map', cluster: 1, hud: 1, hud_state: 'showing', hide_bmw_guidance: 1 }));

    const fakeCrPath = path.join(tmp, 'fake_cr_client.js');
    fs.writeFileSync(fakeCrPath, `'use strict';
const EventEmitter = require('events');
const instances = [];
class ClusterRender extends EventEmitter {
    constructor(name) { super(); this.name = name; this.backend = 'id7'; this.targets = 'map:1088x480,panel:1920x720,hud:800x480'; this.ops = []; this.nextRef = 1; instances.push(this); }
    connect() { setImmediate(() => this.emit('ready')); }
    image(opts) { const ref = this.nextRef++; this.ops.push({ op: 'image', ref, opts }); setImmediate(() => this.emit('layer', ref, 'shown', '')); return ref; }
    pixels(ref, rects, buf) { this.ops.push({ op: 'pixels', ref, bytes: buf.length }); return true; }
    set(ref, opts) { this.ops.push({ op: 'set', ref, opts }); }
    drop(ref) { this.ops.push({ op: 'drop', ref }); }
    close() {}
}
module.exports = { ClusterRender, instances };
`);

    const fakeSidecam = path.join(tmp, 'fake_sidecam.js');
    fs.writeFileSync(fakeSidecam, `'use strict';
process.stdout.on('error', () => process.exit(0));
process.stdin.on('end', () => process.exit(0));
let view = 'none', target = 'map';
process.stdin.on('data', (d) => {
    String(d).split('\\n').filter(Boolean).forEach((line) => {
        const j = JSON.parse(line);
        if (j.op === 'config' && j.target) target = j.target;
        if (j.op === 'view') {
            view = j.side;
            process.stdout.write(JSON.stringify({ ev: 'status', version: '1.0.1', avb: 'ok', pictures: 30, picture_w: 1280, picture_h: 960, picture_age_ms: 20, source_age_ms: 20, cr: 'connected', targets: 'map:1088x480,panel:1920x720,hud:800x480', target, layer: view === 'none' ? 'none' : 'shown', layer_w: 640, layer_h: 288, layer_x: 224, layer_y: 96, view, shown: view === 'none' ? 0 : 1, frames_sent: 10 }) + '\\n');
        }
    });
});
setInterval(() => {
    process.stdout.write(JSON.stringify({ ev: 'status', version: '1.0.1', avb: 'ok', pictures: 60, picture_w: 1280, picture_h: 960, picture_age_ms: 20, source_age_ms: 20, cr: 'connected', targets: 'map:1088x480,panel:1920x720,hud:800x480', target, layer: view === 'none' ? 'none' : 'shown', layer_w: 640, layer_h: 288, layer_x: 224, layer_y: 96, view, shown: view === 'none' ? 0 : 1, frames_sent: 20 }) + '\\n');
}, 250);
`);

    const fakeSystemctl = path.join(tmp, 'fake_systemctl.sh');
    fs.writeFileSync(fakeSystemctl, '#!/bin/sh\necho "$@" >> "' + wakeFlag + '"\nexit 0\n', { mode: 0o755 });

    const port = 29471 + (process.pid % 1000);
    process.env.BD_OAP = oapDir;
    process.env.BD_RUN = runDir;
    process.env.BD_COMPAT_SIGN_RUN = compatDir;
    process.env.BD_STATE = stateDir;
    process.env.BD_BIN = fakeSidecam;
    process.env.BD_CR_CLIENT = fakeCrPath;
    process.env.BD_WOC_RUN = wocRun;
    process.env.BD_ANH_RUN = anhRun;
    process.env.BD_SYSTEMCTL = fakeSystemctl;
    process.env.BD_CAMERA = '0';
    process.env.BD_LOOPBACK = '1';
    process.env.BD_PORT = String(port);
    process.env.BD_NFT = '/nonexistent-nft';
    process.env.BD_POLL_MS = '120';

    delete require.cache[require.resolve('../tools/bimmer-drive/bimmer-drive')];
    const BD = require('../tools/bimmer-drive/bimmer-drive');
    const svc = BD.run();

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await sleep(300);

    const st0 = JSON.parse(fs.readFileSync(path.join(runDir, 'status.json'), 'utf8'));
    ok(st0.version === '1.0.2' && st0.symbol === '---' && st0.shown.indexOf('map') >= 0, 'OEM --- sign shown while waze-on-cluster is suspended under alert');
    ok(fs.lstatSync(compatDir).isSymbolicLink() && JSON.parse(fs.readFileSync(path.join(compatDir, 'status.json'), 'utf8')).version === '1.0.2', 'leftover /run/vietmap-signs directory replaced cleanly with symlink');

    const code = st0.pairing.code;
    ok(/^\d{6}$/.test(code), '6-digit pairing code generated');
    const ack = await new Promise((resolve, reject) => {
        const u = dgram.createSocket('udp4');
        u.on('message', (msg) => { u.close(); resolve(JSON.parse(msg.toString('utf8'))); });
        u.on('error', reject);
        const pkt = Buffer.from(JSON.stringify({ t: 'vms', v: 1, seq: 7, limit: 80, next: 60, hint: 'Khu dân cư', code }));
        u.send(pkt, port, '127.0.0.1');
    });
    ok(ack.paired === true && ack.shown.indexOf('map') >= 0, 'UDP 8471 phone packet paired and acked immediately');

    const sockPath = path.join(runDir, 'app', 'ctl.sock');
    ok(fs.existsSync(sockPath), 'Unix control socket ctl.sock created');
    await new Promise((resolve, reject) => {
        const cl = net.createConnection(sockPath, () => {
            cl.write(JSON.stringify({
                at: new Date().toISOString(), seq: 1, view: 'front',
                config: { target: 'panel', w: 640, h: 288, x: 640, y: 216, fps: 10 },
                signs: { mode: 'on', show: 'both', empty: 'dashes', frontcam: 'on', source: 'vietmap' },
                vmc: { mode: 'off', view: 'fit' },
            }) + '\n');
            cl.end(resolve);
        });
        cl.on('error', reject);
    });
    await sleep(300);
    const st1 = JSON.parse(fs.readFileSync(path.join(runDir, 'status.json'), 'utf8'));
    ok(st1.limit === 80 && st1.settings.source === 'vietmap' && st1.cluster_target === 'panel' && st1.xinhan.front === true, 'front camera on panel seamlessly moves speed sign to panel target in <1ms');

    fs.writeFileSync(path.join(anhRoot, 'data', 'wake.json'), JSON.stringify({ at: Date.now() }));
    for (let i = 0; i < 30 && !fs.existsSync(wakeFlag); i++) await sleep(50);
    const sysCalls = fs.existsSync(wakeFlag) ? fs.readFileSync(wakeFlag, 'utf8') : '';
    ok(sysCalls.indexOf('start anh-dai-dien.service') >= 0, 'MGU Studio wake.json triggers systemctl start anh-dai-dien.service on demand');

    process.env.AVATAR_RUN = anhRun;
    process.env.AVATAR_STATE = path.join(tmp, 'anh-state');
    process.env.AVATAR_OAP = oapDir;
    process.env.AVATAR_PORT = String(port + 10);
    process.env.AVATAR_NFT = '/nonexistent-nft';
    process.env.AVATAR_FW_MS = '0';
    process.env.AVATAR_BOOT_IDLE_MS = '200';
    process.env.AVATAR_IDLE_MS = '200';
    fs.unlinkSync(path.join(anhRoot, 'data', 'wake.json'));
    delete require.cache[require.resolve('../tools/anh-dai-dien/anh-dai-dien')];
    const ANH = require('../tools/anh-dai-dien/anh-dai-dien');
    const sleptWhy = await new Promise((resolve) => {
        ANH.start({ autoSleep: true, onSleep: (why) => resolve(why) });
    });
    ok(typeof sleptWhy === 'string' && sleptWhy.length > 0 && !fs.existsSync(path.join(anhRun, 'status.json')), 'anh-dai-dien cleanly sleeps to 0 MB RAM and removes status.json when idle');

    svc.stop();
    console.log('bimmer_drive_test: all ' + passed + ' assertions passed!');
}

runIntegration().catch((e) => {
    console.error(e);
    process.exit(1);
});
