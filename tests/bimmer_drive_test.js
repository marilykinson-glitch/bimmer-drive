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
const VH = require('../tools/bimmer-drive/vm-hud');
const DBH = require('../tools/bimmer-drive/dbus-bluez-hud');
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

    // Test vmhud priority in decideSigns & signReport/ui rendering
    Object.assign(BD.vmhud, { transport: 'ble', connected: true, model: 'H1N', at: now, limit: 80, next: 60, hint: 'Khu dân cư', bleState: 'advertising', bleAdapter: 'hci0' });
    Object.assign(BD.phone, { from: '172.16.222.50', at: now, limit: 50 });
    const dVmHud = BD.decideSigns(mkCtrl('vietmap'), null, false, false, now);
    ok(dVmHud.limit === 80 && dVmHud.source === 'vmhud', 'signSource=vietmap prioritizes VietMap HUD BLE (80) over UDP phone (50)');
    const repVm = L.signReport({
        limit: 80, symbol: 80, source: 'vmhud', shown: ['map'],
        vmhud: { transport: 'ble', connected: true, model: 'H1N', at: now, ago_ms: 100, limit: 80, next: 60, hint: 'Khu dân cư', bleState: 'advertising', bleAdapter: 'hci0' },
        phone: {}, pairing: {}, camera: {}, bmwmap: {}, renderer: { installed: true }, vmc: {},
    }, { signMode: 'on', signEmpty: 'dashes', signSource: 'vietmap' });
    ok(repVm.vmhudLimit === 80 && repVm.lines.some((l) => l.text.indexOf('VietMap HUD (BLE): đã nối H1N') >= 0),
        'signReport renders VietMap HUD BLE live connection line and next-limit alert');
    BD._reset();
}

/* ---- 3b. VietMap HUD Protocol (`vm-hud.js`) ---- */
{
    const txLog = [];
    const rxEvents = [];
    const proto = VH.createProtocol({
        subscribeDelayMs: 0,
        onTx: (chunks, label) => txLog.push({ label, full: Buffer.concat(chunks), chunkLens: chunks.map((c) => c.length) }),
        onUpdate: (ev) => rxEvents.push(ev),
    });

    // Feed 0x0E getHUDInfo in tiny split chunks
    const reqInfo = VH.buildC3Frame(0x0E, Buffer.from([0x00]), 1700000000);
    proto.feed(reqInfo.slice(0, 5));
    proto.feed(reqInfo.slice(5, 14));
    proto.feed(reqInfo.slice(14));
    ok(rxEvents.some((e) => e.kind === 'handshake' && e.connected === true && e.model === 'H1N'), '0x0E handshake decoded across chunked BLE writes');
    const hs = txLog.find((x) => x.label === 'HUDInfo');
    ok(hs && hs.chunkLens.every((l) => l <= 20), 'HUDInfo response is chunked to <=20 bytes per BLE notification');
    ok(hs.full[0] === 0xA5 && hs.full[1] === 0x5A && hs.full[2] === 0x37 && hs.full[3] === 0xC3, 'HUDInfo starts with A5 5A 37 C3 magic');
    const hsLen = hs.full.readUInt32BE(4);
    ok(hs.full.length === hsLen + 8 && hs.full[12] === 0x0E && hs.full.slice(13, hs.full.length - 8).toString('utf8') === VH.HUD_INFO_STR,
        'HUDInfo matches P7/a.java byte offsets (len, cmd 0x0E, MODEL:H1N...PROTOCOL:2.2.2)');

    // Feed C5 single camera (speed = 60, dist = 150, type = 1)
    const c5 = VH.buildC5Frame(0x01, Buffer.from([1, 0x00, 0x96, 60]));
    proto.feed(c5);
    const ev60 = rxEvents[rxEvents.length - 1];
    ok(ev60.kind === 'camera' && ev60.limit === 60 && ev60.camDist === 150 && ev60.camType === 1, 'C5 cmd 0x01 extracts speed 60 km/h and distance 150 m');

    // Feed C3 multi camera tuple (current speed=50 dist=0, upcoming speed=80 dist=300)
    const c3Cam = VH.buildC3Frame(0x01, Buffer.from([4, 0, 0, 50, 1, 0x01, 0x2C, 80]), 1700000001);
    proto.feed(c3Cam);
    const evMulti = rxEvents[rxEvents.length - 1];
    ok(evMulti.kind === 'camera' && evMulti.limit === 50 && evMulti.next === 80 && evMulti.nextDist === 300,
        'C3 cmd 0x01 extracts active limit 50 and upcoming limit 80 at 300 m');

    // Test 0x50, 0x51, 0x53 queries and 0x40 heartbeat without clearing active limit
    proto.feed(VH.buildC3Frame(0x50, Buffer.alloc(0)));
    proto.feed(VH.buildC3Frame(0x51, Buffer.alloc(0)));
    proto.feed(VH.buildC3Frame(0x53, Buffer.alloc(0)));
    proto.feed(VH.buildC3Frame(0x40, Buffer.from([1, 2, 3, 4])));
    ok(txLog.some((x) => x.label === 'SpeedRate') && txLog.some((x) => x.label === 'HUDLight') && txLog.some((x) => x.label === 'BuzzerSwitch'),
        '0x50/0x51/0x53 queries receive valid C3 replies');
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

    // MGU Studio smooth on-demand waking & starting states + Orphan/Vault recovery tests
    const cvAnh = new Recorder(AnhUI.W, AnhUI.H);
    const seenTexts = [];
    const origText = cvAnh.text.bind(cvAnh);
    cvAnh.text = function (s) { seenTexts.push(String(s)); return origText.apply(cvAnh, arguments); };
    AnhUI.draw(cvAnh, G, theme, { state: 'down', waking: true, version: 'Bản 1.0.3' }, {});
    AnhUI.draw(cvAnh, G, theme, { state: 'starting', waking: true, version: 'Bản 1.0.3' }, {});
    ok(seenTexts.some((s) => s.indexOf('Đang đánh thức trợ thủ') >= 0) && seenTexts.some((s) => s.indexOf('ĐANG ĐỌC GÓI ẢNH') >= 0),
        'MGU Studio renders both waking and starting states cleanly without false error');

    const W = require('../tools/anh-dai-dien/wbm');
    const BOOT = require('../tools/anh-dai-dien/boot');
    const CAR3D = require('../tools/anh-dai-dien/car3d');
    const bootVid = BOOT.openingVideo(Buffer.alloc(320 * 160 * 4, 180), 320, 160, { frames: 20 });
    ok(BOOT.isOurVideo(bootVid) === true && BOOT.isOurVideo(Buffer.from([0, 0, 0, 1, 0x67, 100, 0, 31])) === false,
        'BOOT.isOurVideo accurately distinguishes MGU Studio startup videos from compressed H.264');
    const vOrig = '#version 300 es\nin vec3 a_Position;\nuniform mat4 u_MVPMatrix;\nvoid main() {\n\tgl_Position = u_MVPMatrix * vec4(a_Position, 1.);\n}';
    const vPatched = CAR3D.billboard(vOrig, { x: 0, y: 0, z: 0, w: 100, h: 40 }, [[0, 0, 0], [1, 0, 0], [0, 1, 0], [2, 0, 0], [0, 2, 0], [2, 2, 0]]);
    ok(CAR3D.unpatchShader(vPatched) === vOrig && CAR3D.unpatchShader(CAR3D.hide(vOrig)) === vOrig,
        'CAR3D.unpatchShader reverses billboard and hide shaders back to exact original GLSL');
    ok(typeof W.isOurEncoded === 'function', 'W.isOurEncoded exported for orphan avatar detection');

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

    fs.writeFileSync(path.join(appRoot, 'source/javascript/kit/app-spec.json'), JSON.stringify({ id: 'bimmer_drive', version: '1.1.3' }));
    fs.writeFileSync(path.join(anhRoot, 'source/javascript/kit/app-spec.json'), JSON.stringify({ id: 'anh_dai_dien', version: '1.0.3' }));
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
    const mockDbusSock = path.join(tmp, 'system_bus_socket');
    const mockDevDir = path.join(tmp, 'dev');
    mkp(mockDevDir);
    const seenAliasWrites = [];
    const seenNotifyChunks = [];
    let selectedAdapter = null;

    // Real Unix socket mock BlueZ 5 D-Bus daemon verifying wire alignment, hci1 preference, and GATT roundtrip!
    const dbusSrv = net.createServer((c) => {
        let authed = false;
        let rx = Buffer.alloc(0);
        let srvSerial = 100;
        c.on('data', (chunk) => {
            rx = Buffer.concat([rx, chunk]);
            if (!authed) {
                const nl = rx.indexOf('\r\n');
                if (nl < 0) return;
                const line = rx.slice(0, nl).toString('utf8');
                rx = rx.slice(nl + 2);
                if (line.indexOf('AUTH ') >= 0) {
                    c.write('OK 1234567890abcdef\r\n');
                } else if (line.indexOf('BEGIN') === 0) {
                    authed = true;
                } else {
                    const nl2 = rx.indexOf('\r\n');
                    if (nl2 >= 0) { rx = rx.slice(nl2 + 2); authed = true; }
                }
                if (!authed) return;
            }
            while (rx.length >= 16) {
                const dec = DBH.tryDecodeMessage(rx);
                if (!dec) break;
                rx = rx.slice(dec.total);
                const m = dec.msg;
                if (m.type === 4 && m.member === 'PropertiesChanged') {
                    const chg = m.args[1] || {};
                    if (Buffer.isBuffer(chg.Value)) seenNotifyChunks.push(chg.Value);
                    continue;
                }
                if (m.type !== 1) continue;
                if (m.member === 'Set' && m.args[1] === 'Alias') seenAliasWrites.push(m.path);
                if (m.member === 'Hello') {
                    c.write(DBH.encodeMessage({ type: 2, serial: srvSerial++, replySerial: m.serial, sig: 's', args: [':1.99'] }));
                } else if (m.member === 'GetManagedObjects') {
                    const managed = {
                        '/org/bluez/hci0': {
                            'org.bluez.Adapter1': { Powered: DBH.v('b', true) },
                            'org.bluez.GattManager1': {},
                            'org.bluez.LEAdvertisingManager1': {},
                        },
                        '/org/bluez/hci1': {
                            'org.bluez.Adapter1': { Powered: DBH.v('b', true) },
                            'org.bluez.GattManager1': {},
                            'org.bluez.LEAdvertisingManager1': {},
                        },
                    };
                    c.write(DBH.encodeMessage({ type: 2, serial: srvSerial++, replySerial: m.serial, sig: 'a{oa{sa{sv}}}', args: [managed] }));
                } else if (m.member === 'RegisterApplication') {
                    selectedAdapter = m.path;
                    c.write(DBH.encodeMessage({ type: 2, serial: srvSerial++, replySerial: m.serial, sig: '', args: [] }));
                    // Ask client for its GATT objects just like bluetoothd does
                    c.write(DBH.encodeMessage({ type: 1, serial: srvSerial++, dest: ':1.99', path: m.args[0], iface: 'org.freedesktop.DBus.ObjectManager', member: 'GetManagedObjects', sig: '', args: [] }));
                } else if (m.member === 'RegisterAdvertisement') {
                    c.write(DBH.encodeMessage({ type: 2, serial: srvSerial++, replySerial: m.serial, sig: '', args: [] }));
                    c.write(DBH.encodeMessage({ type: 1, serial: srvSerial++, dest: ':1.99', path: m.args[0], iface: 'org.freedesktop.DBus.Properties', member: 'GetAll', sig: 's', args: ['org.bluez.LEAdvertisement1'] }));
                    // Simulate phone subscribing to FFF1 and sending 0x0E + 0x01(speed=80)
                    c.write(DBH.encodeMessage({ type: 1, serial: srvSerial++, dest: ':1.99', path: DBH.CHR_TX_PATH, iface: 'org.bluez.GattCharacteristic1', member: 'StartNotify', sig: '', args: [] }));
                    c.write(DBH.encodeMessage({ type: 1, serial: srvSerial++, dest: ':1.99', path: DBH.CHR_RX_PATH, iface: 'org.bluez.GattCharacteristic1', member: 'WriteValue', sig: 'aya{sv}', args: [VH.buildC3Frame(0x0E, Buffer.from([0])), {}] }));
                    c.write(DBH.encodeMessage({ type: 1, serial: srvSerial++, dest: ':1.99', path: DBH.CHR_RX_PATH, iface: 'org.bluez.GattCharacteristic1', member: 'WriteValue', sig: 'aya{sv}', args: [VH.buildC5Frame(0x01, Buffer.from([1, 0, 200, 80])), {}] }));
                } else {
                    c.write(DBH.encodeMessage({ type: 2, serial: srvSerial++, replySerial: m.serial, sig: '', args: [] }));
                }
            }
        });
    });
    await new Promise((r) => dbusSrv.listen(mockDbusSock, r));

    // Also test no_bluez graceful fallback with sysBtDir bleDetail diagnostics
    const mockSysBt = path.join(tmp, 'sys-bt');
    mkp(path.join(mockSysBt, 'hci0'));
    let noBluezEv = null;
    const probeNoBluez = DBH.createBluezHud({
        socketPath: path.join(tmp, 'missing_dbus'),
        sysBtDir: mockSysBt,
        onState: (s) => { noBluezEv = s; },
    });
    await new Promise((r) => setTimeout(r, 80));
    probeNoBluez.stop();
    ok(noBluezEv && noBluezEv.bleState === 'no_bluez' && typeof noBluezEv.bleDetail === 'string' &&
        noBluezEv.bleDetail.indexOf('ENOENT') >= 0 && noBluezEv.bleDetail.indexOf('hci:hci0') >= 0,
        'dbus-bluez-hud fails gracefully with bleState=no_bluez and exposes bleDetail (ENOENT + hci0)');

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
    process.env.BD_DBUS_SOCK = mockDbusSock;
    process.env.BD_VMHUD_DEV_DIR = mockDevDir;
    process.env.BD_VMHUD_SYS_TTY = path.join(tmp, 'sys-tty');
    process.env.BD_VMHUD_SYS_BT = mockSysBt;
    process.env.BD_NFT = '/nonexistent-nft';
    process.env.BD_POLL_MS = '120';

    delete require.cache[require.resolve('../tools/bimmer-drive/bimmer-drive')];
    const BD = require('../tools/bimmer-drive/bimmer-drive');
    const svc = BD.run();

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await sleep(400);

    const st0 = JSON.parse(fs.readFileSync(path.join(runDir, 'status.json'), 'utf8'));
    ok(st0.version === '1.1.3' && st0.shown.indexOf('map') >= 0, 'v1.1.3 coordinator renders map layer while waze-on-cluster is suspended');
    ok(selectedAdapter === '/org/bluez/hci1' && seenAliasWrites.length === 0, 'dbus-bluez-hud prefers secondary hci1 over hci0 and never renames Adapter1.Alias');
    const fullHudReply = Buffer.concat(seenNotifyChunks);
    ok(fullHudReply.toString('utf8').indexOf('MODEL:H1N,HW:1.0,FW:1.0,PROTOCOL:2.2.2') >= 0, 'dbus-bluez-hud emits chunked PropertiesChanged HUDInfo reply over D-Bus');
    ok(st0.vmhud && st0.vmhud.connected === true && st0.vmhud.bleState === 'advertising' && st0.vmhud.bleDetail === 'hci1 ok' && st0.vmhud.limit === 80 && st0.limit === 80 && st0.source === 'vmhud',
        'Live BlueZ GATT VietMap HUD connection updates cluster sign to 80 km/h with source=vmhud');
    ok(fs.lstatSync(compatDir).isSymbolicLink() && JSON.parse(fs.readFileSync(path.join(compatDir, 'status.json'), 'utf8')).version === '1.1.3', 'leftover /run/vietmap-signs directory replaced cleanly with symlink');

    // Test ESP32 USB Serial Bridge: must IGNORE BMW internal ttyACM0 (no allowlisted idVendor) and ACCEPT ESP32 VID 303a
    const mockSysTty = path.join(tmp, 'sys-tty');
    const internalTty = path.join(mockDevDir, 'ttyACM0');
    const espTty = path.join(mockDevDir, 'ttyACM1');
    fs.writeFileSync(internalTty, '{"t":"vmhud","limit":99}\n');
    fs.writeFileSync(espTty, '{"t":"vmhud","v":1,"limit":120,"next":100,"dist":250,"camType":1,"connected":true,"model":"H1N"}\n');
    mkp(path.join(mockSysTty, 'ttyACM0', 'device'));
    mkp(path.join(mockSysTty, 'ttyACM1', 'device'));
    fs.writeFileSync(path.join(mockSysTty, 'ttyACM1', 'idVendor'), '303a\n');

    const serialEvs = [];
    const openedDevs = [];
    const sb = VH.createSerialBridge({
        devDir: mockDevDir,
        sysTtyDir: mockSysTty,
        scanMs: 500,
        onState: (st) => { if (st.usbDev) openedDevs.push(st.usbDev); },
        onJson: (m) => serialEvs.push(m),
    });
    await sleep(120);
    sb.stop();
    ok(openedDevs.indexOf(internalTty) < 0 && openedDevs.indexOf(espTty) >= 0 && serialEvs.length === 1 && serialEvs[0].limit === 120 && serialEvs[0].next === 100,
        'USB serial bridge ignores internal ttyACM0 and opens ESP32 (VID 303a) ttyACM1');

    // The BLE name VietMap Live 3.4.5 lists AND connects over BLE GATT (measured on a phone)
    ok(VH.ADV_NAME === 'vietmap-HUD_V3(BLE)', 'bridge advertises the name VietMap Live connects to over BLE');

    // Raw byte log filter: keeps events and changed frames, drops pictures / repeats / replies
    const rf = VH.createRawFilter({ repeatMs: 30000 });
    const camA = 'a55a37c3000000156b0af008010186a00000006432a0d6d1ffe56be6ec';
    const camA2 = 'a55a37c3000000156b0af00b010186a00000006432c5f48081f8c5ae5f';
    const camB = 'a55a37c3000000156b0af00c010186a00000003c3cada2fc9254c17949';
    const t0 = Date.UTC(2026, 10, 29, 1, 0, 0);
    const l1 = rf({ t: 'raw', dir: 'rx', hex: camA }, t0);
    ok(/ rx 01 0186a00000006432$/.test(l1), 'raw filter keeps a camera frame as "rx <cmd> <body>"');
    ok(rf({ t: 'raw', dir: 'rx', hex: camA2 }, t0 + 1000) === null, 'raw filter drops a repeat of the same body (other timestamp / trailer)');
    ok(/ rx 01 0186a00000003c3c$/.test(rf({ t: 'raw', dir: 'rx', hex: camB }, t0 + 2000)), 'raw filter keeps a frame whose body changed');
    ok(rf({ t: 'raw', dir: 'rx', hex: camB }, t0 + 40000) !== null, 'raw filter writes an unchanged frame again after repeatMs');
    ok(rf({ t: 'raw', dir: 'rx', hex: 'a55a37c3000009f16b0af00740fe000009bfffd8' }, t0) === null
        && rf({ t: 'raw', dir: 'rx', hex: '0047006f006f0067006c006500200049006e0063' }, t0) === null
        && rf({ t: 'raw', dir: 'tx', hex: camA }, t0) === null, 'raw filter drops picture frames, their chunks and the bridge replies');
    ok(/ evt connect$/.test(rf({ t: 'raw', dir: 'evt', hex: '', evt: 'connect' }, t0)), 'raw filter keeps connect / disconnect events');

    // Serial bridge hands raw lines to onRaw and still parses vmhud lines
    const rawTty = path.join(mockDevDir, 'ttyACM2');
    fs.writeFileSync(rawTty, '{"t":"raw","dir":"rx","ms":1,"n":29,"hex":"' + camA + '"}\n{"t":"vmhud","v":1,"limit":50,"connected":true,"camAgeMs":0}\n');
    mkp(path.join(mockSysTty, 'ttyACM2', 'device'));
    fs.writeFileSync(path.join(mockSysTty, 'ttyACM2', 'idVendor'), '303a\n');
    const rawSeen = [], jsonSeen = [];
    const sb2 = VH.createSerialBridge({ device: rawTty, sysTtyDir: mockSysTty, scanMs: 500, onRaw: (m) => rawSeen.push(m), onJson: (m) => jsonSeen.push(m) });
    await sleep(120);
    sb2.stop();
    ok(rawSeen.length === 1 && rawSeen[0].hex === camA && jsonSeen.length === 1 && jsonSeen[0].limit === 50, 'serial bridge passes raw lines to onRaw next to vmhud JSON');

    // Verify logic.signReport always displays VietMap HUD (BLE) line with bleDetail even if usbDev is set
    const rep = L.signReport({
        vmhud: { connected: false, bleState: 'no_bluez', bleDetail: 'ServiceUnknown · hci:hci0', usbDev: '/dev/ttyACM9' },
        phone: {}, pairing: {}, camera: {}, bmwmap: {}, shown: [], vmc: {},
    }, { signMode: 'on', signEmpty: 'dashes' });
    ok(rep.lines.some((l) => l.text.indexOf('VietMap HUD (BLE):') === 0 && l.text.indexOf('ServiceUnknown · hci:hci0') >= 0),
        'signReport always shows VietMap HUD (BLE) diagnostics alongside usbDev');

    // Verify existing UDP 8471 compatibility remains intact alongside BLE HUD
    const code = st0.pairing.code;
    ok(/^\d{6}$/.test(code), '6-digit pairing code generated');
    const ack = await new Promise((resolve, reject) => {
        const u = dgram.createSocket('udp4');
        u.on('message', (msg) => { u.close(); resolve(JSON.parse(msg.toString('utf8'))); });
        u.on('error', reject);
        const pkt = Buffer.from(JSON.stringify({ t: 'vms', v: 1, seq: 7, limit: 70, next: 60, hint: 'Khu dân cư', code }));
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
    dbusSrv.close();
    console.log('bimmer_drive_test: all ' + passed + ' assertions passed!');
}

runIntegration().catch((e) => {
    console.error(e);
    process.exit(1);
});
