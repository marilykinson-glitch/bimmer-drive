'use strict';
/**
 * bimmer-drive.js - Unified Root Cluster & Camera Coordinator for BMW MGU iDrive 7 (`1.0.0`).
 *
 * Replaces THREE separate 24/7 systemd services (`xinhan-cam`, `vietmap-signs`, `vietmap-cluster`)
 * and TWO child Node workers (`nav.js`, `probe.js` unless diagnostic probing is explicitly enabled)
 * with ONE unified event-driven coordinator:
 *   1. Supervises `mgu-sidecam` (`1.0.0`) with idle H.264 loop-filter sleep & half-frame smart pairing.
 *   2. Listens on Unix control socket `/run/bimmer-drive/app/ctl.sock` (`<1ms` zero-polling IPC from `apps/bimmer_drive`)
 *      with automatic fallback to `/run/bimmer-drive/app/control.json`.
 *   3. Coordinates `cluster-render` speed-limit sign layers (`map`, `panel`, `hud`, Vietnam P.127 + OEM BMW `---` 3-dash)
 *      synchronously in-memory with `mgu-sidecam`'s front camera state and `waze-on-cluster`.
 *   4. Serves UDP `8471` (`vmsign` Android phone app pairing & instant speed-limit updates) + `nftables` rule.
 *   5. Embeds `woc-mirror` (`VietMap trên đồng hồ`) with zero overhead when off.
 *   6. Wakes `anh-dai-dien.service` (`MGU Studio`) on-demand only when the user opens `MGU Studio` on iDrive!
 *
 * Node 8 (ES2017) compatible, zero external npm dependencies.
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const dgram = require('dgram');
const zlib = require('zlib');

const jpeg = require('./jpeg');
const signread = require('./signread');
const signsCam = require('./signs-cam');
const wocMirror = require('./woc-mirror');

const VERSION = '1.0.2';
const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);

const CFG = {
    oap: env('BD_OAP', '/var/opt/public/oap'),
    proc: env('BD_PROC', '/proc'),
    run: env('BD_RUN', '/run/bimmer-drive'),
    compatSignRun: env('BD_COMPAT_SIGN_RUN', '/run/vietmap-signs'),
    state: env('BD_STATE', '/var/opt/bimmer-drive'),
    legacySignState: env('BD_LEGACY_SIGN_STATE', '/var/opt/vietmap-signs'),
    bin: env('BD_BIN', path.join(__dirname, 'mgu-sidecam')),
    args: env('BD_ARGS', '').split(' ').filter(Boolean),
    staleMs: Number(env('BD_STALE_MS', 2500)),
    pollMs: Number(env('BD_POLL_MS', 400)),
    log: env('BD_LOG', '/var/opt/bimmer-drive/bimmer-drive.log'),
    pairing: env('BD_PAIRING', '1') !== '0',
    port: Number(env('BD_PORT', 8471)),
    ifaces: env('BD_IFACES', 'wlan_bridge,wlan0').split(',').map((s) => s.trim()).filter(Boolean),
    nft: env('BD_NFT', 'nft'),
    systemctl: env('BD_SYSTEMCTL', 'systemctl'),
    wocRun: env('BD_WOC_RUN', '/run/waze-on-cluster'),
    wocDir: env('BD_WOC_DIR', '/var/opt/waze-on-cluster'),
    crClient: env('BD_CR_CLIENT', '/var/opt/cluster-render/current/cluster_render_client.js'),
    crSocket: env('BD_CR_SOCKET', ''),
    phoneStaleMs: Number(env('BD_PHONE_STALE_MS', 5000)),
    wocStaleMs: Number(env('BD_WOC_STALE_MS', 30000)),
    ruleMs: Number(env('BD_RULE_MS', 30000)),
    loopback: env('BD_LOOPBACK', '') === '1',
    grabber: env('BD_GRABBER', '/usr/bin/winston-grabber'),
    wayland: env('BD_XDG_RUNTIME_DIR', '/run/wayland'),
    screenMs: Number(env('BD_SCREEN_MS', 1000)),
    screenGeometry: env('BD_SCREEN_GEOMETRY', '960x360'),
    screenStaleMs: Number(env('BD_SCREEN_STALE_MS', 4000)),
    camera: env('BD_CAMERA', '1') !== '0',
    someip: env('BD_SOMEIP', '/usr/lib/someip.node'),
    catalog: env('BD_CATALOG', '/etc/oap/someip/someip-interfaces.json'),
    gen: env('BD_GEN', path.join(__dirname, 'oapgen-gen.js')),
    camHoldKm: Number(env('BD_CAMERA_HOLD_KM', signsCam.DEFAULT_HOLD_KM)),
    anhRun: env('BD_ANH_RUN', '/run/anh-dai-dien'),
    anhUnit: env('BD_ANH_UNIT', 'anh-dai-dien.service'),
};

const APP = /^bimmer_drive\d*$/;
const ANH_APP = /^anh_dai_dien\d*$/;
const VIEWS = ['none', 'left', 'right', 'all', 'front'];
const NFT_COMMENT = 'bimmer-drive';
const RESTART_MS = 2000, RESTART_MAX_MS = 60000, YOUNG_MS = 10000, LOG_MAX = 512 * 1024;
const STATUS_FILE = () => path.join(CFG.run, 'status.json');
const APP_RUN = () => path.join(CFG.run, 'app');
const CTL_SOCK = () => path.join(APP_RUN(), 'ctl.sock');

const MAP_W = 1088, MAP_H = 480, PANEL_W = 1920, PANEL_H = 720, PANEL_MAP_X = 416, PANEL_MAP_Y = 120, HUD_W = 800, HUD_H = 480;
const SIZES = { small: { map: 96, hud: 64 }, medium: { map: 128, hud: 80 }, large: { map: 160, hud: 100 } };
const HUD_SEEN = { x: 80, y: 90, w: 640, h: 300 };
const MAP_EDGE_X = 200, MAP_TOP = 36;
const PREVIEW_LIMIT = 60;
const STRIKES = 20;

const SIGN_DEFAULTS = {
    mode: 'on', show: 'both', side: 'right', hudSide: 'left', size: 'medium',
    source: 'auto', screen: 'off', warn: '5', camera: 'on', probe: 'off', bmwmap: 'on',
    empty: 'dashes', frontcam: 'on', minLimit: '10',
};
const WARN_MAP = { off: null, '0': 0, '5': 5, '10': 10 };

function log(m) {
    const line = new Date().toISOString() + ' ' + m;
    process.stdout.write(line + '\n');
    try { if (fs.statSync(CFG.log).size > LOG_MAX) fs.renameSync(CFG.log, CFG.log + '.1'); } catch (e) {}
    try { fs.appendFileSync(CFG.log, line + '\n'); } catch (e) {}
}

function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } }
function readJson(p) { const t = readText(p); try { return t === null ? null : JSON.parse(t); } catch (e) { return null; } }
function mtime(p) { try { return fs.statSync(p).mtime.getTime(); } catch (e) { return 0; } }
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function mkdirp(d, mode) {
    if (!d || fs.existsSync(d)) return;
    mkdirp(path.dirname(d), mode);
    try { fs.mkdirSync(d, mode || 0o755); } catch (e) { if (e.code !== 'EEXIST') throw e; }
}

function writeAtomic(p, text, mode) {
    mkdirp(path.dirname(p));
    const tmp = p + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, text, { mode: mode || 0o644 });
    fs.renameSync(tmp, p);
}

function readSmall(p) {
    let fd = -1;
    try {
        fd = fs.openSync(p, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
        const st = fs.fstatSync(fd);
        if (!st.isFile() || st.size > 16384) return null;
        const b = Buffer.alloc(st.size);
        const n = st.size ? fs.readSync(fd, b, 0, st.size, 0) : 0;
        return { text: b.slice(0, n).toString('utf8'), mtime: st.mtime.getTime() };
    } catch (e) { return null; } finally { if (fd >= 0) try { fs.closeSync(fd); } catch (e) {} }
}

function readSmallJson(p) {
    const r = readSmall(p);
    if (!r) return null;
    try { const j = JSON.parse(r.text); return j && typeof j === 'object' ? { j, mtime: r.mtime } : null; } catch (e) { return null; }
}

function writeInto(p, text, mode, uid, gid) {
    const tmp = p + '.tmp';
    try { fs.unlinkSync(tmp); } catch (e) {}
    const fd = fs.openSync(tmp, 'wx', mode);
    try {
        fs.writeSync(fd, text);
        if (uid !== null && uid !== undefined) fs.fchownSync(fd, uid, gid === null || gid === undefined ? -1 : gid);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, p);
}

/* ---------------- Speed-Limit Sign Renderer (Vietnam P.127 + OEM BMW "---") ---------------- */

let DIGITS = null;
function digits() {
    if (DIGITS) return DIGITS;
    const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'digits.json'), 'utf8'));
    Object.keys(d.glyphs).forEach((k) => {
        const g = d.glyphs[k];
        g.mask = zlib.inflateSync(Buffer.from(g.data, 'base64'));
        g.h = d.height;
        if (g.mask.length !== g.w * g.h) throw new Error('digits.json: digit ' + k + ' has wrong size');
    });
    DIGITS = d;
    return d;
}

function sampleGlyph(g, u, v) {
    const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0;
    const at = (x, y) => (x < 0 || y < 0 || x >= g.w || y >= g.h ? 0 : g.mask[y * g.w + x]);
    return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
}

function drawSign(limit, S, warn) {
    const px = Buffer.alloc(S * S * 4);
    const c = S / 2, R = S / 2 - 0.5;
    const rim = Math.max(1.5, S * 0.035), ring = S * 0.12;
    const rRed = R - rim, rIn = warn ? -1 : rRed - ring;
    const RED = [215, 25, 32], WHITE = [255, 255, 255], INK = warn ? [255, 255, 255] : [17, 17, 17];
    for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
            const dx = x + 0.5 - c, dy = y + 0.5 - c, d = Math.sqrt(dx * dx + dy * dy);
            const a = clamp01(R - d + 0.5);
            if (a <= 0) continue;
            const red = clamp01(rRed - d + 0.5) * (1 - clamp01(rIn - d + 0.5));
            const o = (y * S + x) * 4;
            for (let i = 0; i < 3; i++) px[o + i] = Math.round(WHITE[i] * (1 - red) + RED[i] * red);
            px[o + 3] = Math.round(a * 255);
        }
    }
    if (!limit || limit === '---' || limit === 'none') {
        const spanW = 2 * (rRed - ring) * 0.72;
        const dashW = spanW / 3.9, gapW = dashW * 0.45;
        const dashH = Math.max(2.4, S * 0.062), rad = dashH * 0.25;
        const hw = Math.max(0, dashW / 2 - rad), hh = Math.max(0, dashH / 2 - rad);
        const y0 = Math.max(0, Math.floor(c - dashH / 2 - 1)), y1 = Math.min(S, Math.ceil(c + dashH / 2 + 1));
        for (let k = -1; k <= 1; k++) {
            const dcx = c + k * (dashW + gapW);
            const x0 = Math.max(0, Math.floor(dcx - dashW / 2 - 1)), x1 = Math.min(S, Math.ceil(dcx + dashW / 2 + 1));
            for (let y = y0; y < y1; y++) {
                const qy = Math.max(0, Math.abs(y + 0.5 - c) - hh);
                for (let x = x0; x < x1; x++) {
                    const qx = Math.max(0, Math.abs(x + 0.5 - dcx) - hw);
                    const dist = Math.sqrt(qx * qx + qy * qy) - rad;
                    const t = clamp01(0.5 - dist);
                    if (t <= 0) continue;
                    const o = (y * S + x) * 4;
                    for (let i = 0; i < 3; i++) px[o + i] = Math.round(px[o + i] * (1 - t) + INK[i] * t);
                }
            }
        }
        return px;
    }
    const text = String(limit);
    const D = digits();
    const gs = text.split('').map((ch) => D.glyphs[ch]).filter(Boolean);
    if (!gs.length) return px;
    let pen = 0;
    const placed = gs.map((g) => { const p = { g, x: pen + g.left }; pen += g.adv; return p; });
    const inkL = placed[0].x, inkR = placed[placed.length - 1].x + placed[placed.length - 1].g.w;
    const inkW = inkR - inkL, H = D.height;
    const cond = gs.length >= 3 ? 0.82 : 0.92;
    const k = Math.min((S * 0.44) / H, (2 * (rRed - ring) * 0.80) / (inkW * cond));
    const sx = k * cond, sy = k;
    const ox = c - (inkW * sx) / 2 - inkL * sx, oy = c - (H * sy) / 2;
    const SUB = [0.25, 0.75];
    placed.forEach((p) => {
        const x0 = Math.max(0, Math.floor(ox + p.x * sx)), x1 = Math.min(S, Math.ceil(ox + (p.x + p.g.w) * sx));
        const y0 = Math.max(0, Math.floor(oy)), y1 = Math.min(S, Math.ceil(oy + H * sy));
        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
                let cov = 0;
                SUB.forEach((qy) => SUB.forEach((qx) => {
                    cov += sampleGlyph(p.g, (x + qx - ox) / sx - p.x - 0.5, (y + qy - oy) / sy - 0.5);
                }));
                const t = cov / (4 * 255);
                if (t <= 0) continue;
                const o = (y * S + x) * 4;
                for (let i = 0; i < 3; i++) px[o + i] = Math.round(px[o + i] * (1 - t) + INK[i] * t);
            }
        }
    });
    return px;
}

const signCache = new Map();
function signPixels(limit, S) {
    const key = limit + '@' + S;
    if (!signCache.has(key)) {
        if (signCache.size > 40) signCache.clear();
        signCache.set(key, drawSign(limit, S, false));
    }
    return signCache.get(key);
}

/* ---------------- Installed App Discovery & RAM Folder ---------------- */

let appCache = null, appScanAt = 0;
let anhCache = null, anhScanAt = 0;

function scanOapApp(re, now) {
    let dirs = [];
    try { dirs = fs.readdirSync(CFG.oap).filter((d) => /^oap_\d+$/.test(d)); } catch (e) { return null; }
    for (let i = 0; i < dirs.length; i++) {
        const rels = ['source/javascript/kit/app-spec.json', 'javascript/kit/app-spec.json'];
        for (let k = 0; k < rels.length; k++) {
            const spec = path.join(CFG.oap, dirs[i], rels[k]);
            const s = readJson(spec);
            if (s && typeof s.id === 'string' && re.test(s.id)) {
                return { id: s.id, root: path.join(CFG.oap, dirs[i]), spec, at: now };
            }
        }
    }
    return null;
}

function findApp(now) {
    if (appCache && fs.existsSync(appCache.spec)) return appCache;
    if (appCache === null && appScanAt && now - appScanAt < 5000 && now >= appScanAt) return null;
    appScanAt = now;
    appCache = scanOapApp(APP, now);
    return appCache;
}

function findAnhApp(now) {
    if (anhCache && fs.existsSync(anhCache.spec)) return anhCache;
    if (anhCache === null && anhScanAt && now - anhScanAt < 10000 && now >= anhScanAt) return null;
    anhScanAt = now;
    anhCache = scanOapApp(ANH_APP, now);
    return anhCache;
}

const appRun = { dir: null, uid: null, gid: null, by: null, error: null, checkedAt: 0, procAt: 0, proc: null };

function appProcess(app, now) {
    if (appRun.proc && appRun.proc.root === app.root && now - appRun.procAt < 30000 && now >= appRun.procAt
        && fs.existsSync(path.join(CFG.proc, String(appRun.proc.pid)))) return appRun.proc;
    appRun.procAt = now;
    let found = null, pids = [];
    try { pids = fs.readdirSync(CFG.proc).filter((d) => /^\d+$/.test(d) && Number(d) !== process.pid); } catch (e) { return null; }
    const inApp = (s) => !!s && (s === app.root || s.indexOf(app.root + '/') >= 0 || s.indexOf(app.root + '\0') >= 0);
    for (let i = 0; i < pids.length; i++) {
        const pid = pids[i];
        const base = path.join(CFG.proc, pid);
        let cmd = null, cwd = null;
        try { cmd = fs.readFileSync(path.join(base, 'cmdline'), 'latin1'); } catch (e) { continue; }
        try { cwd = fs.readlinkSync(path.join(base, 'cwd')); } catch (e) {}
        if (!inApp(cmd) && !inApp(cwd)) continue;
        const st = readText(path.join(base, 'status')) || '';
        const u = /^Uid:\s+(\d+)/m.exec(st), g = /^Gid:\s+(\d+)/m.exec(st);
        if (!u || !g || Number(u[1]) === 0) continue;
        found = { root: app.root, uid: Number(u[1]), gid: Number(g[1]), pid: Number(pid) };
        break;
    }
    appRun.proc = found;
    return found;
}

function ensureAppRunDir(now, onOwnerChanged) {
    const app = findApp(now);
    if (!app) return null;
    if (appRun.dir && now - appRun.checkedAt < 5000 && now >= appRun.checkedAt) return appRun.dir;
    appRun.checkedAt = now;
    const dir = APP_RUN();
    try {
        const proc = appProcess(app, now);
        const data = fs.statSync(path.join(app.root, 'data'));
        const owner = proc ? { uid: proc.uid, gid: proc.gid } : { uid: data.uid, gid: data.gid };
        let st = null;
        try { st = fs.lstatSync(dir); } catch (e) {}
        if (st && !st.isDirectory()) { fs.unlinkSync(dir); st = null; }
        if (!st) fs.mkdirSync(dir, 0o770);
        st = fs.lstatSync(dir);
        if (st.uid !== owner.uid || st.gid !== owner.gid) fs.chownSync(dir, owner.uid, owner.gid);
        if ((st.mode & 0o777) !== 0o770) fs.chmodSync(dir, 0o770);
        const changed = appRun.uid !== owner.uid || appRun.gid !== owner.gid;
        appRun.dir = dir; appRun.uid = owner.uid; appRun.gid = owner.gid; appRun.by = proc ? 'process' : 'data'; appRun.error = null;
        if (changed) {
            log('app RAM dir ' + dir + ': ' + owner.uid + ':' + owner.gid + ' (' + appRun.by + ')');
            pair.written = null;
            if (onOwnerChanged) onOwnerChanged(owner);
        }
    } catch (e) {
        if (appRun.error !== e.message) log('app RAM dir: ' + e.message);
        appRun.dir = null; appRun.error = e.message;
    }
    return appRun.dir;
}

/* ---------------- Camera Decoder (`mgu-sidecam`) Line Builders ---------------- */

function configLine(config) {
    if (!config) return null;
    const out = { op: 'config' };
    const str = ['target', 'klass', 'left', 'right', 'all', 'front'];
    const num = ['w', 'h', 'x', 'y', 'fps', 'exclusive', 'contend', 'persist', 'left_rot', 'right_rot', 'all_rot',
        'left_flip', 'right_flip', 'all_flip', 'left_sar', 'right_sar', 'all_sar', 'pair', 'pair_swap', 'left_round', 'right_round', 'left_rim', 'right_rim', 'front_rot', 'front_flip', 'front_sar', 'front_round'];
    str.forEach((k) => { if (typeof config[k] === 'string' && /^[a-z0-9_,]{1,40}$/i.test(config[k])) out[k] = config[k]; });
    num.forEach((k) => { if (Number.isFinite(config[k])) out[k] = Math.round(config[k]); });
    return JSON.stringify(out);
}

function auxLine(aux) {
    const out = { op: 'aux', side: 'none' };
    if (!aux || (aux.side !== 'left' && aux.side !== 'right')) return JSON.stringify(out);
    out.side = aux.side;
    if (typeof aux.target === 'string' && /^[a-z]{1,12}$/i.test(aux.target)) out.target = aux.target;
    if (typeof aux.crop === 'string' && /^[0-9,]{7,24}$/.test(aux.crop)) out.crop = aux.crop;
    ['w', 'h', 'x', 'y', 'fps', 'rot', 'flip', 'sar', 'round', 'rim'].forEach((k) => { if (Number.isFinite(aux[k])) out[k] = Math.round(aux[k]); });
    return JSON.stringify(out);
}

let labelSeq = null;
function copyLabel(from, bytes, seq) {
    if (seq === labelSeq) return true;
    let fd = -1;
    try {
        fd = fs.openSync(from, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const st = fs.fstatSync(fd);
        if (!st.isFile() || st.size !== bytes) return false;
        const buf = Buffer.alloc(bytes);
        if (fs.readSync(fd, buf, 0, bytes, 0) !== bytes) return false;
        const to = path.join(CFG.run, 'label.bin');
        fs.writeFileSync(to + '.tmp', buf);
        fs.renameSync(to + '.tmp', to);
        labelSeq = seq;
        return true;
    } catch (e) { return false; } finally { if (fd >= 0) try { fs.closeSync(fd); } catch (e) {} }
}

function arLine(ar, nav, now, dataDir) {
    const out = { op: 'ar', mode: 'off' };
    if (!ar || typeof ar !== 'object') return JSON.stringify(out);
    const n = (k, lo, hi, d) => (Number.isFinite(ar[k]) ? Math.max(lo, Math.min(hi, Math.round(ar[k]))) : d);
    out.height_cm = n('height_cm', 20, 200, 70);
    out.pitch_x10 = n('pitch_x10', -200, 600, 80);
    out.fov = n('fov', 30, 200, 100);
    out.yaw_x10 = n('yaw_x10', -300, 300, 0);
    out.shift_cm = n('shift_cm', -150, 150, 0);
    out.curve = n('curve', 0, 100, 40);
    out.card = ar.card === 0 ? 0 : 1;
    out.white = ar.white === 0 ? 0 : 1;
    out.style = ar.style === 1 ? 1 : 0;
    out.fade = ar.fade === 1 ? 1 : 0;
    if (ar.mode === 'marks') { out.mode = 'marks'; return JSON.stringify(out); }
    if (ar.mode === 'demo') {
        const T = 13000, k = Math.floor(now / T) % 3, t = (now % T) / 1000;
        out.mode = 'route';
        out.kind = k === 2 ? 'roundabout' : 'turn';
        out.angle = k === 0 ? 90 : k === 1 ? -90 : 45;
        out.exit = k === 2 ? 2 : 0;
        out.meters = Math.max(0, Math.round(90 - t * 8.3));
        return JSON.stringify(out);
    }
    if (ar.mode !== 'route' || !nav || !nav.active || !nav.kind) return JSON.stringify(out);
    out.mode = 'route';
    out.kind = nav.kind;
    out.angle = Math.round(Number(nav.angle) || 0);
    out.exit = Math.round(Number(nav.exit) || 0);
    let m = Number.isFinite(nav.meters) ? nav.meters : -1;
    if (m >= 0 && Number.isFinite(ar.speed) && ar.speed > 0 && Number.isFinite(nav.at)) {
        const dt = Math.max(0, Math.min(8000, now - nav.at));
        m = Math.max(0, m - ar.speed / 3.6 * dt / 1000);
    }
    out.meters = m < 0 ? -1 : Math.round(m);
    const l = ar.label;
    if (dataDir && l && typeof l === 'object' && Number.isFinite(l.w) && Number.isFinite(l.h) && Number.isFinite(l.seq) && l.street === nav.street &&
        l.w >= 8 && l.w <= 1920 && l.h >= 8 && l.h <= 96 && copyLabel(path.join(dataDir, 'label.bin'), Math.round(l.w) * Math.round(l.h), l.seq)) {
        out.label = path.join(CFG.run, 'label.bin');
        out.label_w = Math.round(l.w);
        out.label_h = Math.round(l.h);
        out.label_seq = Math.round(l.seq);
    }
    return JSON.stringify(out);
}

/* ---------------- Pairing & UDP 8471 Phone Protocol (`vmsign` 100% Compatible) ---------------- */

const pair = { code: null, error: null, made: null, refused: 0, from: null, at: 0, strikes: {}, newAt: 0, written: null };
function pairFile() { return path.join(CFG.state, 'pair.json'); }
function newCode() {
    const n = crypto.randomBytes(4).readUInt32BE(0);
    return String(100000 + (n % 900000));
}

function pairCode() {
    if (pair.code) return pair.code;
    const saved = readJson(pairFile());
    if (saved && /^\d{6}$/.test(String(saved.code))) {
        pair.code = String(saved.code);
        pair.made = saved.made || null;
        return pair.code;
    }
    // Seamless migration if the user previously paired with standalone vietmap-signs
    const legacy = CFG.legacySignState ? readJson(path.join(CFG.legacySignState, 'pair.json')) : null;
    if (legacy && /^\d{6}$/.test(String(legacy.code))) {
        return setCode(String(legacy.code), 'migrated from vietmap-signs');
    }
    return setCode(newCode(), 'first start');
}

function setCode(code, why) {
    pair.code = code;
    pair.made = new Date().toISOString();
    try {
        mkdirp(CFG.state, 0o755);
        writeAtomic(pairFile(), JSON.stringify({ code, made: pair.made }) + '\n', 0o600);
        pair.error = null;
    } catch (e) { pair.error = e.message; log('pairing code not saved: ' + e.message); }
    log('pairing code: new (' + why + ')');
    pair.written = null;
    return code;
}

function pairToApp(now) {
    const dir = appRun.dir;
    if (!dir || !CFG.pairing) return;
    const app = findApp(now);
    const asks = [path.join(dir, 'pair-new')].concat(app ? [path.join(app.root, 'data', 'pair-new')] : []);
    const ask = asks.filter((f) => readSmall(f));
    if (ask.length) {
        ask.forEach((f) => { try { fs.unlinkSync(f); } catch (e) {} });
        if (now - pair.newAt > 3000 || now < pair.newAt) { pair.newAt = now; setCode(newCode(), 'asked in the app'); }
    }
    const f = path.join(dir, 'pair.json');
    const want = JSON.stringify({ code: pairCode(), made: pair.made });
    if (pair.written === want && fs.existsSync(f)) return;
    try {
        writeInto(f, want + '\n', 0o640, appRun.uid, appRun.gid);
        pair.written = want;
    } catch (e) { log('pairing code to app: ' + e.message); }
}

function paired(p, addr, now) {
    if (!CFG.pairing) return true;
    const s = pair.strikes[addr];
    if (s && s.n >= STRIKES && now - s.at < 60000) return false;
    const want = Buffer.from(pairCode()), got = Buffer.from(typeof p.code === 'string' ? p.code : '');
    const ok = got.length === want.length && crypto.timingSafeEqual(got, want);
    if (ok) { delete pair.strikes[addr]; return true; }
    pair.strikes[addr] = s && now - s.at < 60000 ? { n: s.n + 1, at: s.at } : { n: 1, at: now };
    const keys = Object.keys(pair.strikes);
    if (keys.length > 64) delete pair.strikes[keys[0]];
    if (pair.from !== addr) log('phone ' + addr + ': wrong pairing code');
    pair.refused++; pair.from = addr; pair.at = now;
    return false;
}

const phone = { from: null, at: 0, seq: null, limit: null, next: null, hint: null, test: false, ver: null, packets: 0, ignored: 0, bad: 0 };

function ipv4ToInt(a) { return a.split('.').reduce((n, x) => ((n << 8) >>> 0) + (Number(x) & 255), 0) >>> 0; }
function allowedSender(addr) {
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(addr)) return false;
    if (CFG.loopback && /^127\./.test(addr)) return true;
    const nets = os.networkInterfaces();
    const a = ipv4ToInt(addr);
    return CFG.ifaces.some((name) => (nets[name] || []).some((n) => {
        if (n.family !== 'IPv4' && n.family !== 4) return false;
        const m = ipv4ToInt(n.netmask || '255.255.255.255');
        return ((a & m) >>> 0) === ((ipv4ToInt(n.address) & m) >>> 0);
    }));
}

function parsePacket(buf) {
    if (!buf || buf.length > 2048) return null;
    let m;
    try { m = JSON.parse(buf.toString('utf8')); } catch (e) { return null; }
    if (!m || m.t !== 'vms') return null;
    const limit = Number(m.limit);
    if (!(Number.isInteger(limit) && limit >= 0 && limit <= 199)) return null;
    const out = {
        seq: Number.isFinite(Number(m.seq)) ? Number(m.seq) : null,
        limit: limit || null,
        test: !!m.test,
        ver: typeof m.app === 'string' ? m.app.slice(0, 40) : null,
        code: typeof m.code === 'string' ? m.code.slice(0, 16) : typeof m.code === 'number' ? String(m.code) : null,
    };
    const next = Number(m.next);
    if (Number.isInteger(next) && next >= 5 && next <= 199) out.next = next;
    if (typeof m.hint === 'string' && m.hint.trim()) out.hint = m.hint.trim().slice(0, 40);
    return out;
}

/* ---------------- Firewall (`nftables`) ---------------- */

const fw = { rules: [], checkedAt: 0, error: null, present: null };
function nft(args) {
    const r = cp.spawnSync(CFG.nft, args, { timeout: 10000, encoding: 'utf8' });
    if (r.error || r.status !== 0) throw new Error('nft ' + args.join(' ') + ': ' + String((r.error && r.error.message) || r.stderr || ('exit ' + r.status)).trim().slice(0, 200));
    return r.stdout || '';
}

function ourRules() {
    let out;
    try { out = nft(['-a', 'list', 'chain', 'ip', 'filter', 'input']); } catch (e) { return null; }
    return out.split('\n').filter((l) => l.indexOf('comment "' + NFT_COMMENT + '"') >= 0 || l.indexOf('comment "vietmap-signs"') >= 0).map((l) => {
        const h = /# handle (\d+)\s*$/.exec(l), i = /iifname "([^"]+)"/.exec(l), p = /dport (\d+)/.exec(l), c = /comment "([^"]+)"/.exec(l);
        return h ? { handle: h[1], iface: i ? i[1] : null, port: p ? Number(p[1]) : null, comment: c ? c[1] : '' } : null;
    }).filter(Boolean);
}

function removeRules() {
    const rs = ourRules() || [];
    rs.forEach((r) => { try { nft(['delete', 'rule', 'ip', 'filter', 'input', 'handle', r.handle]); } catch (e) { log(e.message); } });
    return rs.length;
}

function ensureRules(now) {
    fw.checkedAt = now;
    try {
        const rs = ourRules();
        fw.present = rs !== null;
        if (rs === null) { fw.rules = []; fw.error = null; return; }
        const ok = rs.length === CFG.ifaces.length && CFG.ifaces.every((i) => rs.some((r) => r.iface === i && r.port === CFG.port && r.comment === NFT_COMMENT));
        if (!ok) {
            if (rs.length) removeRules();
            CFG.ifaces.forEach((i) => nft(['insert', 'rule', 'ip', 'filter', 'input', 'iifname', '"' + i + '"', 'udp', 'dport', String(CFG.port), 'accept', 'comment', '"' + NFT_COMMENT + '"']));
            log('firewall: udp ' + CFG.port + ' accepted on ' + CFG.ifaces.join(', '));
        }
        fw.rules = CFG.ifaces.slice();
        fw.error = null;
    } catch (e) {
        fw.error = e.message;
        log('firewall: ' + e.message);
    }
}

/* ---------------- Waze on Cluster & Geometry ---------------- */

function wocStatus(now) {
    const f = path.join(CFG.wocRun, 'status.json');
    const s = readJson(f);
    if (!s) return { known: false, map: false, hud: false };
    const fresh = now - mtime(f) < CFG.wocStaleMs;
    const pct = Math.min(Number(s.hud_width_pct) || 0, 85);
    let bw = 453, bh = 200;
    if (pct > 0) {
        bw = Math.floor(HUD_W * pct / 100);
        bh = Math.floor((bw * 480 + 544) / 1088);
        if (bh > HUD_H) { bh = HUD_H; bw = Math.floor((bh * 1088 + 240) / 480); }
    }
    const ox = isFinite(Number(s.hud_x)) ? Number(s.hud_x) : 0, oy = isFinite(Number(s.hud_y)) ? Number(s.hud_y) : 0;
    const bx = Math.max(0, Math.min(HUD_W - bw, Math.floor((HUD_W - bw) / 2) + ox));
    const by = Math.max(0, Math.min(HUD_H - bh, Math.floor((HUD_H - bh) / 2) + oy));
    const suspended = s.state === 'starting' && s.reason === 'under an alert on the cluster';
    return {
        known: true, fresh, state: s.state || null, reason: s.reason || null,
        map: fresh && (s.state === 'showing' || suspended) && s.target !== 'hud' && Number(s.cluster) !== 0,
        hud: fresh && Number(s.hud) === 1 && s.hud_state === 'showing',
        guideHold: Number(s.hide_bmw_guidance) === 0 ? 0 : 1,
        hudBox: { x: bx, y: by, w: bw, h: bh },
    };
}

function geometry(d, woc) {
    const s = SIZES[d.size] || SIZES.medium;
    const map = { size: s.map, y: MAP_TOP, x: d.side === 'left' ? MAP_EDGE_X : MAP_W - MAP_EDGE_X - s.map };
    const b = (woc && woc.hudBox) || { x: 173, y: 140, w: 453, h: 200 };
    let x0 = Math.max(b.x, HUD_SEEN.x), y0 = Math.max(b.y, HUD_SEEN.y);
    let x1 = Math.min(b.x + b.w, HUD_SEEN.x + HUD_SEEN.w), y1 = Math.min(b.y + b.h, HUD_SEEN.y + HUD_SEEN.h);
    if (x1 - x0 < s.hud + 16 || y1 - y0 < s.hud + 16) {
        x0 = HUD_SEEN.x; y0 = HUD_SEEN.y; x1 = HUD_SEEN.x + HUD_SEEN.w; y1 = HUD_SEEN.y + HUD_SEEN.h;
    }
    const hud = { size: s.hud, y: y0 + 8, x: d.hudSide === 'right' ? x1 - s.hud - 8 : x0 + 8 };
    if (d.mapPos) { map.x = d.mapPos.x; map.y = d.mapPos.y; }
    if (d.hudPos) { hud.x = d.hudPos.x; hud.y = d.hudPos.y; }
    map.x = Math.max(0, Math.min(MAP_W - s.map, map.x));
    map.y = Math.max(0, Math.min(MAP_H - s.map, map.y));
    hud.x = Math.max(0, Math.min(HUD_W - s.hud, hud.x));
    hud.y = Math.max(0, Math.min(HUD_H - s.hud, hud.y));
    return { map, hud };
}

/* ---------------- cluster-render Sign Overlay Layers & Overspeed Opacity Pulse ---------------- */

const renderer = { installed: false, connected: false, backend: null, error: null, layers: {}, targets: {} };
let cr = null;
const layers = {};
const BLINK = { frameMs: 50, cycleMs: 1000, minOpacity: 0.25 };
const flash = { timer: null, opacity: 1 };

function setSignOpacity(opacity) {
    if (flash.opacity === opacity) return;
    flash.opacity = opacity;
    Object.keys(layers).forEach((t) => {
        const L = layers[t];
        if (L && L.visible && cr) cr.set(L.ref, { opacity });
    });
}

function flashing(on) {
    if (on && !flash.timer) {
        const started = process.hrtime();
        flash.timer = setInterval(() => {
            const elapsed = process.hrtime(started);
            const ms = elapsed[0] * 1000 + elapsed[1] / 1e6;
            const phase = (ms % BLINK.cycleMs) / BLINK.cycleMs;
            const brightness = (1 + Math.cos(2 * Math.PI * phase)) / 2;
            const opacity = BLINK.minOpacity + (1 - BLINK.minOpacity) * brightness;
            if (cr) setSignOpacity(Math.round(opacity * 100) / 100);
        }, BLINK.frameMs);
    } else if (!on && flash.timer) {
        clearInterval(flash.timer);
        flash.timer = null;
        if (cr) setSignOpacity(1);
    }
}

function startRenderer() {
    if (cr) return true;
    if (!fs.existsSync(CFG.crClient)) { renderer.installed = false; renderer.error = 'cluster-render is not installed'; return false; }
    let ClusterRender;
    try { ClusterRender = require(CFG.crClient).ClusterRender; } catch (e) { renderer.error = 'cluster-render client: ' + e.message; return false; }
    renderer.installed = true;
    renderer.error = null;
    cr = new ClusterRender('bimmer-drive-signs', CFG.crSocket || undefined);
    cr.on('ready', () => { renderer.connected = true; renderer.backend = cr.backend || null; log('cluster-render: connected (' + cr.backend + ', ' + cr.targets + ')'); });
    cr.on('disconnected', () => { renderer.connected = false; log('cluster-render: disconnected'); });
    cr.on('layer', (ref, state, reason) => {
        Object.keys(layers).forEach((t) => { if (layers[t].ref === ref) renderer.layers[t] = { state, reason: reason || null }; });
    });
    cr.on('target', (name, state, holder, reason) => { renderer.targets[name] = { state, holder: holder || null, reason: reason || null }; });
    cr.on('refused', (op, ref, reason) => { renderer.error = 'cluster-render refused ' + op + ': ' + reason; log(renderer.error); });
    cr.connect();
    return true;
}

function applyLayers(want) {
    if (!cr) return;
    ['map', 'panel', 'hud'].forEach((t) => {
        const w = want[t];
        if (!w) return;
        let L = layers[t];
        if (!w.visible || !want.symbol) {
            if (t === 'panel' && L) { cr.drop(L.ref); delete layers.panel; delete renderer.layers.panel; return; }
            if (L && L.visible) { cr.set(L.ref, { visible: false, opacity: 1 }); L.visible = false; }
            return;
        }
        if (!L || L.size !== w.size) {
            if (L) cr.drop(L.ref);
            const z = t === 'hud' ? 10 : 950;
            const opts = { target: t, klass: 'overlay', z, x: w.x, y: w.y, w: w.size, h: w.size, iw: w.size, ih: w.size,
                visible: false, fps: 4, contend: false };
            if (t !== 'panel') opts.guide_hold = w.guide;
            const ref = cr.image(opts);
            if (!ref) { renderer.error = 'cluster-render client refused the ' + t + ' layer'; return; }
            L = layers[t] = { ref, size: w.size, x: w.x, y: w.y, limit: null, visible: false, guide: w.guide };
            renderer.layers[t] = { state: 'made', reason: null };
        }
        if (L.limit !== want.symbol) { cr.pixels(L.ref, null, signPixels(want.symbol, w.size)); L.limit = want.symbol; }
        if (L.x !== w.x || L.y !== w.y) { cr.set(L.ref, { x: w.x, y: w.y }); L.x = w.x; L.y = w.y; }
        if (t !== 'panel' && L.guide !== w.guide) { cr.set(L.ref, { guide_hold: w.guide }); L.guide = w.guide; }
        if (!L.visible) { cr.set(L.ref, { visible: true, opacity: flash.opacity }); L.visible = true; }
    });
    flashing(!!want.warn && (want.map.visible || (want.panel && want.panel.visible) || want.hud.visible));
}

/* ---------------- Optional Center Screen OCR & Diagnostic Probe ---------------- */

const screen = { running: false, startedAt: 0, at: 0, limit: 0, candidate: 0, misses: 0, shots: 0, fails: 0,
    ms: null, decodeMs: null, rings: [], error: null, geometry: CFG.screenGeometry, child: null };
function screenFile() { return path.join(CFG.run, 'centre.jpg'); }
function screenGrabArgs() {
    const a = ['--screen=center'];
    if (screen.geometry) a.push('--geometry=' + screen.geometry);
    return a.concat(['--num-frames=1', '-p', 'jpeg_msdk(num_frames=1),file', screenFile()]);
}
function shootScreen(now) {
    screen.running = true;
    screen.startedAt = now;
    try { fs.unlinkSync(screenFile()); } catch (e) {}
    let child, done = false, tail = '';
    const finish = (code, err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        screen.child = null;
        screen.running = false;
        const t = Date.now();
        screen.ms = t - now;
        let img = null;
        try {
            if (err) throw err;
            const buf = fs.readFileSync(screenFile());
            const t0 = Date.now();
            const r = signread.read(jpeg.decode(buf));
            screen.decodeMs = Date.now() - t0;
            screen.shots++; screen.fails = 0; screen.error = null;
            screen.rings = r.rings.slice(0, 3);
            img = r;
        } catch (e) {
            screen.fails++;
            screen.error = String(e.message || e).slice(0, 160) + (code ? ' (exit ' + code + ')' : '') + (tail ? ': ' + tail.trim().split('\n').pop().slice(0, 120) : '');
            if (screen.fails >= 2 && screen.geometry) screen.geometry = '';
        }
        if (img) {
            const n = img.limit;
            if (n && (n === screen.limit || n === screen.candidate)) {
                screen.limit = n; screen.candidate = 0; screen.misses = 0; screen.at = t;
            } else if (n) {
                screen.candidate = n;
                if (screen.limit) screen.at = t;
            } else {
                screen.candidate = 0;
                if (++screen.misses >= 2) screen.limit = 0;
                screen.at = t;
            }
        }
        try { fs.unlinkSync(screenFile()); } catch (e) {}
    };
    try {
        child = cp.spawn(CFG.grabber, screenGrabArgs(), { env: Object.assign({}, process.env, { XDG_RUNTIME_DIR: CFG.wayland }), stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) { finish(null, e); return; }
    screen.child = child;
    child.stderr.on('data', (d) => { tail = (tail + d).slice(-400); });
    child.on('error', (e) => finish(null, e));
    child.on('exit', (code) => finish(code, code ? new Error('grabber failed') : null));
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} finish(null, new Error('grabber timeout')); }, 5000);
}

const probe = { child: null, startedAt: 0, exits: 0 };
function probeLog() { return path.join(CFG.state, 'probe.log'); }
function manageProbe(want, now) {
    if (want && !probe.child && (now - probe.startedAt > 60000 || now < probe.startedAt)) {
        probe.startedAt = now;
        mkdirp(CFG.state, 0o755);
        try {
            const child = cp.spawn(process.execPath, [path.join(__dirname, 'probe.js'), 'run', probeLog(), path.join(CFG.run, 'probe-tmp')],
                { stdio: 'ignore', env: Object.assign({}, process.env, { VMS_CATALOG: CFG.catalog, VMS_GEN: CFG.gen, VMS_SOMEIP: typeof CFG.someip === 'string' ? CFG.someip : '' }) });
            probe.child = child;
            log('probe: started (pid ' + child.pid + ')');
            child.on('exit', (code) => { if (probe.child === child) probe.child = null; probe.exits++; log('probe: ended (' + code + ')'); });
            child.on('error', () => { if (probe.child === child) probe.child = null; });
        } catch (e) { log('probe: ' + e.message); }
    } else if (!want && probe.child) {
        try { probe.child.kill('SIGTERM'); } catch (e) {}
        probe.child = null;
    }
}

/* ---------------- On-Demand Wakeup for MGU Studio (`anh-dai-dien.service`) ---------------- */

let anhWakeTriedAt = 0;
function checkAnhOnDemand(now) {
    if (now - anhWakeTriedAt < 2500) return;
    const anh = findAnhApp(now);
    if (!anh) return;
    const w = readSmallJson(path.join(anh.root, 'data', 'wake.json'));
    if (!w) return;
    const wakeAt = Number(w.j.at) || w.mtime;
    if (now - wakeAt > 8000 || now < wakeAt - 5000) return;
    const st = readJson(path.join(CFG.anhRun, 'status.json'));
    if (st && typeof st.at === 'number' && Math.abs(now - st.at) < 5000) return;
    anhWakeTriedAt = now;
    log('anh-dai-dien: waking on demand (MGU Studio opened)');
    cp.execFile(CFG.systemctl, ['start', CFG.anhUnit], { timeout: 10000 }, (err) => {
        if (err) log('anh-dai-dien wake: ' + err.message);
    });
}

/* ---------------- Unified Control State Parsing ---------------- */

let liveControl = null, liveControlDir = null;

function readControlState(app, now) {
    let c = liveControl, dir = liveControlDir || APP_RUN();
    const fRam = readSmallJson(path.join(APP_RUN(), 'control.json'));
    const fData = app ? readSmallJson(path.join(app.root, 'data', 'control.json')) : null;
    const ts = (x) => (x && x.j ? Date.parse(x.j.at) || x.mtime || 0 : -1);
    const fileBest = fRam && ts(fRam) >= ts(fData) ? { c: fRam.j, dir: APP_RUN(), at: ts(fRam) }
        : fData ? { c: fData.j, dir: path.join(app.root, 'data'), at: ts(fData) } : null;
    const sockAt = c ? Date.parse(c.at) || 0 : -1;
    if (fileBest && fileBest.at > sockAt) {
        c = fileBest.c;
        dir = fileBest.dir;
    }
    const saved = app ? (readJson(path.join(app.root, 'data', 'settings.json')) || {}) : {};
    const signsRaw = (c && c.signs && typeof c.signs === 'object') ? c.signs : {
        mode: saved.signMode, show: saved.signShow, empty: saved.signEmpty, frontcam: saved.signFrontcam,
        side: saved.signSide, hudSide: saved.signHudSide, size: saved.signSize, source: saved.signSource,
        camera: saved.signCamera, bmwmap: saved.signBmwMap, minLimit: saved.signMinLimit, screen: saved.signScreen,
        warn: saved.signWarn, probe: saved.signProbe, mapX: saved.signMapX, mapY: saved.signMapY, hudX: saved.signHudX, hudY: saved.signHudY,
    };
    const sv = Object.assign({}, SIGN_DEFAULTS);
    Object.keys(SIGN_DEFAULTS).forEach((k) => { if (signsRaw[k] !== undefined && signsRaw[k] !== null) sv[k] = signsRaw[k]; });
    const pos = (x, y) => (Number.isFinite(Number(signsRaw[x])) && signsRaw[x] !== null && Number.isFinite(Number(signsRaw[y])) && signsRaw[y] !== null
        ? { x: Math.round(Number(signsRaw[x])), y: Math.round(Number(signsRaw[y])) } : null);

    const hasExplicitSource = signsRaw.source !== undefined && signsRaw.source !== null;
    const srcMode = ['auto', 'vietmap', 'vietmap_only', 'bmw_only'].indexOf(sv.source) >= 0 ? sv.source : 'auto';
    const allowCam = srcMode === 'vietmap_only' ? false : (hasExplicitSource ? true : sv.camera !== 'off');
    const allowBmwMap = srcMode === 'vietmap_only' ? false : (hasExplicitSource ? true : sv.bmwmap !== 'off');
    const allowPhone = srcMode !== 'bmw_only';

    const signDesired = {
        app: app ? app.id : null,
        on: sv.mode !== 'off',
        show: ['both', 'cluster', 'hud'].indexOf(sv.show) >= 0 ? sv.show : 'both',
        side: sv.side === 'left' ? 'left' : 'right',
        hudSide: sv.hudSide === 'right' ? 'right' : 'left',
        size: SIZES[sv.size] ? sv.size : 'medium',
        source: srcMode,
        phone: allowPhone,
        screen: sv.screen === 'on',
        camera: allowCam,
        probe: sv.probe === 'on',
        bmwMap: allowBmwMap,
        empty: sv.empty === 'hide' ? 'hide' : 'dashes',
        frontcam: sv.frontcam !== 'off',
        minLimit: Number(sv.minLimit) === 5 ? 5 : 10,
        warn: Object.prototype.hasOwnProperty.call(WARN_MAP, String(sv.warn)) ? WARN_MAP[String(sv.warn)] : 5,
        mapPos: pos('mapX', 'mapY'),
        hudPos: pos('hudX', 'hudY'),
    };

    // Sign placement preview / live drag
    const pv = c && c.preview && typeof c.preview === 'object' ? c.preview : null;
    const pvFresh = !!(pv && pv.at && now - Date.parse(pv.at) < 4000 && now >= Date.parse(pv.at) - 2000);
    const pvDrag = pvFresh && pv.drag && (pv.drag.t === 'map' || pv.drag.t === 'hud') && Number.isFinite(pv.drag.x) && Number.isFinite(pv.drag.y)
        ? { t: pv.drag.t, x: Math.round(pv.drag.x), y: Math.round(pv.drag.y) } : null;

    // VietMap Center Screen Mirror desired state
    const vmcRaw = (c && c.vmc && typeof c.vmc === 'object') ? c.vmc : { mode: saved.vmcMode, view: saved.vmcView };
    const vmcDesired = {
        on: vmcRaw.mode === 'on',
        view: wocMirror.VIEWS[vmcRaw.view] ? vmcRaw.view : 'fit',
    };

    // Camera view & heartbeat freshness
    let view = 'none', why = '';
    const config = c && c.config && typeof c.config === 'object' ? c.config : null;
    const ar = c && c.ar && typeof c.ar === 'object' ? c.ar : null;
    const aux = c && c.aux && typeof c.aux === 'object' ? c.aux : null;
    const appSpeed = c && Number.isFinite(c.speed) && c.speed >= 0 && c.speed < 400 && c.at && (now - Date.parse(c.at) < 3000) ? c.speed : null;

    if (!app) why = 'the app is not installed';
    else if (!c) why = 'the app has not started yet';
    else {
        const wantView = VIEWS.indexOf(c.view) >= 0 ? c.view : 'none';
        if (wantView !== 'none') {
            const age = now - (Date.parse(c.at) || 0);
            if (age >= -1500 && age <= CFG.staleMs) view = wantView;
            else why = 'the app stopped confirming the view';
        }
    }

    return { view, why, config, ar, aux, dir, signDesired, pvFresh, pvDrag, vmcDesired, appSpeed, snapPath: c && typeof c.snap === 'string' ? c.snap : '' };
}

/* ---------------- Main Service Loop ---------------- */

const camState = signsCam.createState({ holdKm: CFG.camHoldKm });
let lastSignSummary = { shown: [], why: '', limit: null, symbol: null };

function ownSpeed(now) {
    const s = signsCam.speed(camState, now);
    if (s !== null) return s;
    return camState.speed !== null && camState.speed <= 3 && now - camState.speedAt < 60000 && now >= camState.speedAt ? camState.speed : null;
}

function decideSigns(ctrl, nativeState, nativeFresh, isVmcGrabbing, now) {
    const d = Object.assign({}, ctrl.signDesired);
    camState.minLimit = d.minLimit;
    if (ctrl.pvDrag) d[ctrl.pvDrag.t === 'map' ? 'mapPos' : 'hudPos'] = { x: ctrl.pvDrag.x, y: ctrl.pvDrag.y };
    const woc = wocStatus(now);
    const frontCamShown = !!(nativeFresh && nativeState && Number(nativeState.shown) === 1 && nativeState.view === 'front' && (!nativeState.layer || nativeState.layer === 'shown'));
    const frontTarget = frontCamShown ? (nativeState.target === 'panel' ? 'panel' : 'map') : null;
    const frontOn = d.on && d.frontcam && frontCamShown;
    const clusterSurface = woc.map || frontOn;
    const phoneFresh = !!(d.phone !== false && phone.at && now - phone.at < CFG.phoneStaleMs);
    const phoneLimit = phoneFresh && phone.limit ? phone.limit : 0;
    const placing = ctrl.pvFresh;

    const camLimit = d.on && d.camera ? signsCam.current(camState, now, log) : 0;
    const reading = d.on && d.screen && !isVmcGrabbing && !camLimit && !phoneFresh && !placing && (clusterSurface || woc.hud) && renderer.installed !== false
        && (fs.existsSync(CFG.grabber) || !path.isAbsolute(CFG.grabber));
    if (reading && !screen.running && now - screen.startedAt >= CFG.screenMs) shootScreen(now);
    const onScreen = reading && screen.at && now - screen.at < CFG.screenStaleMs ? screen.limit : 0;
    const mapLimit = d.on && d.bmwMap ? signsCam.mapCurrent(camState, now, d.camera) : 0;

    const preferPhone = d.source === 'vietmap' || d.source === 'vietmap_only';
    const source = preferPhone
        ? (phoneLimit ? 'phone' : camLimit ? 'camera' : onScreen ? 'screen' : mapLimit ? 'bmwmap' : placing ? 'preview' : null)
        : (camLimit ? 'camera' : phoneLimit ? 'phone' : onScreen ? 'screen' : mapLimit ? 'bmwmap' : placing ? 'preview' : null);
    const limit = preferPhone
        ? (phoneLimit || camLimit || onScreen || mapLimit || (placing ? PREVIEW_LIMIT : null))
        : (camLimit || phoneLimit || onScreen || mapLimit || (placing ? PREVIEW_LIMIT : null));
    const symbol = limit || (d.on && d.empty !== 'hide' && !placing ? '---' : null);
    const g = geometry(d, woc);
    const wantMap = d.on && d.show !== 'hud', wantHud = d.on && d.show !== 'cluster';
    const showOk = renderer.installed !== false && !!symbol;
    const spd = ownSpeed(now) !== null ? ownSpeed(now) : ctrl.appSpeed;
    const over = !!limit && !placing && d.warn !== null && spd !== null && spd > limit + d.warn;
    const onPanel = frontOn && frontTarget === 'panel';
    const guideHold = woc.known && woc.guideHold === 0 ? 0 : 1;

    const map = Object.assign({ visible: showOk && wantMap && clusterSurface && !onPanel, guide: guideHold }, g.map);
    const panel = {
        visible: showOk && wantMap && onPanel, guide: 1, size: g.map.size,
        x: Math.max(0, Math.min(PANEL_W - g.map.size, PANEL_MAP_X + g.map.x)),
        y: Math.max(0, Math.min(PANEL_H - g.map.size, PANEL_MAP_Y + g.map.y)),
    };
    const hud = Object.assign({ visible: showOk && wantHud && woc.hud, guide: guideHold }, g.hud);

    let why = '';
    if (!d.on) why = 'off in the app';
    else if (placing && !limit) why = '';
    else if (placing) why = !renderer.installed ? 'cluster-render is not installed' : !woc.known && !frontCamShown ? 'Waze on cluster is not installed'
        : !(wantMap && clusterSurface) && !(wantHud && woc.hud) ? 'Waze on cluster shows no map there' : '';
    else if (!renderer.installed) why = 'cluster-render is not installed';
    else if (limit && !woc.known && !frontCamShown) why = 'Waze on cluster is not installed';
    else if (limit && !(wantMap && clusterSurface) && !(wantHud && woc.hud)) why = 'Waze on cluster shows no map there';
    else if (reading && !limit) why = screen.error ? 'the centre screen cannot be read' : 'no sign on the centre screen';
    else if (!limit && d.phone === false) why = 'no sign on this road';
    else if (!limit && !phone.at) why = d.bmwMap && camState.map.ready ? 'no sign on this road' : 'no phone yet';
    else if (!limit && !phoneFresh) why = d.bmwMap && camState.map.ready ? 'no sign on this road' : 'the phone stopped sending';
    else if (!limit) why = 'no sign in VietMap';

    return {
        d, woc, frontCamShown, frontTarget, placing, reading, speed: spd, over, source, limit, symbol, map, panel, hud, why,
    };
}

let udpSock = null;
function listenUdp(onPacket) {
    udpSock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    udpSock.on('error', (e) => log('udp: ' + e.message));
    udpSock.on('message', (buf, rinfo) => {
        if (!allowedSender(rinfo.address)) { phone.ignored++; return; }
        const p = parsePacket(buf);
        if (!p) { phone.bad++; return; }
        const now = Date.now();
        if (!paired(p, rinfo.address, now)) {
            const s = pair.strikes[rinfo.address];
            if (!s || s.n <= STRIKES) {
                udpSock.send(Buffer.from(JSON.stringify({ t: 'vms-ack', v: 1, seq: p.seq, car: VERSION, paired: false, why: 'wrong code' })), rinfo.port, rinfo.address, () => {});
            }
            if (onPacket) onPacket();
            return;
        }
        if (phone.from !== rinfo.address) log('phone: ' + rinfo.address + ':' + rinfo.port + (p.ver ? ' (' + p.ver + ')' : ''));
        if (phone.limit !== p.limit) log('sign: ' + (p.limit || 'none') + (p.test ? ' (test)' : ''));
        const ver = p.ver || (phone.from === rinfo.address ? phone.ver : null);
        Object.assign(phone, { from: rinfo.address, at: now, seq: p.seq, limit: p.limit, next: p.next || null, hint: p.hint || null, test: p.test, ver });
        phone.packets++;
        if (onPacket) onPacket();
        const ack = Buffer.from(JSON.stringify({ t: 'vms-ack', v: 1, seq: p.seq, car: VERSION, paired: true, shown: lastSignSummary.shown, why: lastSignSummary.why }));
        udpSock.send(ack, rinfo.port, rinfo.address, () => {});
    });
    udpSock.bind(CFG.port, '0.0.0.0');
    return udpSock;
}

function ensureCompatSymlink() {
    if (!CFG.compatSignRun || CFG.compatSignRun === CFG.run) return;
    try {
        let st = null;
        try { st = fs.lstatSync(CFG.compatSignRun); } catch (e) {}
        if (st && st.isDirectory() && !st.isSymbolicLink()) {
            try { fs.unlinkSync(path.join(CFG.compatSignRun, 'status.json')); } catch (e) {}
            try { fs.rmdirSync(CFG.compatSignRun); st = null; } catch (e) {}
        }
        if (!st) fs.symlinkSync(CFG.run, CFG.compatSignRun);
    } catch (e) {}
}

function systemStopping() {
    const r = cp.spawnSync(CFG.systemctl, ['is-system-running'], { timeout: 3000, encoding: 'utf8' });
    return /stopping/.test(String(r.stdout || ''));
}

function run() {
    mkdirp(CFG.run, 0o755);
    mkdirp(CFG.state, 0o755);
    ensureCompatSymlink();
    log('bimmer-drive ' + VERSION + ' (node ' + process.version + ')');

    let child = null, out = '', startedAt = 0, delay = 0, restartTimer = null, quitting = false;
    let native = null, nativeAt = 0, note = 'starting the decoder', lastSnap = null;
    let sentConfig = null, sentView = null, sentViewAt = 0, sentAr = null, sentArAt = 0, sentAux = null, sentAuxAt = 0, lastSnapReq = '';
    let pictures = null, picturesAt = 0, fps = 0;
    let ctlServer = null, ctlBoundOwner = '';

    const mirror = wocMirror.createMirror({
        run: CFG.run, grabber: CFG.grabber, systemctl: CFG.systemctl, wocDir: CFG.wocDir, wayland: CFG.wayland, log,
    });

    const someipHub = CFG.camera ? signsCam.start(camState, {
        run: CFG.run, catalog: CFG.catalog, gen: CFG.gen, someip: CFG.someip, log,
        onNav: () => { try { coordinate(Date.now()); } catch (e) {} },
    }) : null;

    if (CFG.pairing) pairCode();

    function sendSidecam(line) {
        if (!child) return false;
        try { child.stdin.write(line + '\n'); return true; } catch (e) { return false; }
    }

    function openControlSocket(owner) {
        if (!appRun.dir) return;
        const ownerKey = (owner ? owner.uid + ':' + owner.gid : '') + '@' + CTL_SOCK();
        if (ctlServer && ctlBoundOwner === ownerKey && fs.existsSync(CTL_SOCK())) return;
        if (ctlServer) { try { ctlServer.close(); } catch (e) {} ctlServer = null; }
        try { fs.unlinkSync(CTL_SOCK()); } catch (e) {}
        const srv = net.createServer((conn) => {
            let buf = '';
            conn.on('data', (chunk) => {
                buf += chunk.toString('utf8');
                if (buf.length > 131072) buf = '';
                let nl;
                while ((nl = buf.indexOf('\n')) >= 0) {
                    const line = buf.slice(0, nl);
                    buf = buf.slice(nl + 1);
                    if (!line) continue;
                    let j = null;
                    try { j = JSON.parse(line); } catch (e) { continue; }
                    if (!j || typeof j !== 'object') continue;
                    if (j.cmd === 'pair-new') {
                        const t = Date.now();
                        if (t - pair.newAt > 3000) { pair.newAt = t; setCode(newCode(), 'asked over socket'); pairToApp(t); }
                    } else {
                        liveControl = j;
                        liveControlDir = APP_RUN();
                    }
                    try { coordinate(Date.now()); } catch (e) { log('ctl tick: ' + e.message); }
                }
            });
            conn.on('error', () => {});
        });
        srv.on('error', (e) => log('ctl.sock: ' + e.message));
        srv.listen(CTL_SOCK(), () => {
            try {
                if (owner) fs.chownSync(CTL_SOCK(), owner.uid, owner.gid);
                fs.chmodSync(CTL_SOCK(), 0o660);
                ctlBoundOwner = ownerKey;
            } catch (e) { log('ctl.sock perm: ' + e.message); }
        });
        ctlServer = srv;
    }

    function startSidecam() {
        restartTimer = null;
        if (quitting || child) return;
        if (!fs.existsSync(CFG.bin)) {
            note = 'mgu-sidecam is missing (' + CFG.bin + ')';
            log(note);
            restartTimer = setTimeout(startSidecam, RESTART_MAX_MS);
            return;
        }
        startedAt = Date.now();
        sentConfig = null; sentView = null; sentAr = null; sentAux = null; native = null; pictures = null; fps = 0;
        if (!/\.js$/.test(CFG.bin)) {
            const pr = cp.spawnSync(CFG.bin, ['--version'], { timeout: 10000, encoding: 'utf8' });
            if (pr.error || pr.status !== 0) {
                const said = String((pr.stderr || '') + (pr.error ? pr.error.message : '')).split('\n').filter(Boolean)[0] || 'exit ' + pr.status;
                note = 'mgu-sidecam cannot start: ' + said.slice(0, 200);
                log(note);
                restartTimer = setTimeout(startSidecam, RESTART_MAX_MS);
                return;
            }
            if (!startSidecam.said) { startSidecam.said = true; log('mgu-sidecam ' + String(pr.stdout).trim()); }
        }
        let c;
        try {
            c = /\.js$/.test(CFG.bin) ? cp.spawn(process.execPath, [CFG.bin].concat(CFG.args), { stdio: ['pipe', 'pipe', 'inherit'] })
                : cp.spawn(CFG.bin, CFG.args, { stdio: ['pipe', 'pipe', 'inherit'] });
        } catch (e) { ended('spawn: ' + e.message); return; }
        child = c;
        log('mgu-sidecam started (pid ' + c.pid + ')');
        c.on('error', (e) => { if (child === c) ended('error: ' + e.message); });
        c.on('close', (code, sig) => { if (child === c) ended('exit ' + code + (sig ? ' ' + sig : '')); });
        c.stdin.on('error', () => {});
        c.stdout.on('data', (d) => {
            out += d;
            if (out.length > 262144 && out.indexOf('\n') < 0) out = '';
            for (let n; (n = out.indexOf('\n')) >= 0; out = out.slice(n + 1)) {
                let j = null;
                try { j = JSON.parse(out.slice(0, n)); } catch (e) { continue; }
                if (!j) continue;
                const t = Date.now();
                if (j.ev === 'status') {
                    native = j;
                    nativeAt = t;
                    if (typeof j.pictures === 'number') {
                        if (pictures !== null && t - picturesAt >= 900) {
                            fps = Math.max(0, Math.round((j.pictures - pictures) * 1000 / (t - picturesAt)));
                            pictures = j.pictures; picturesAt = t;
                        } else if (pictures === null) { pictures = j.pictures; picturesAt = t; }
                    }
                    try { coordinate(t); } catch (e) { log('status coordinate: ' + e.message); }
                } else if (j.ev === 'snap') {
                    lastSnap = { at: new Date(t).toISOString(), ok: !!j.ok, w: j.w || 0, h: j.h || 0, path: j.path || '' };
                }
            }
        });
    }

    function ended(why) {
        const now = Date.now();
        child = null; out = ''; native = null;
        delay = now - startedAt < YOUNG_MS ? Math.min(RESTART_MAX_MS, (delay || RESTART_MS / 2) * 2) : RESTART_MS;
        note = 'decoder ended (' + why + '), again in ' + Math.round(delay / 1000) + ' s';
        log('mgu-sidecam ended (' + why + '): again in ' + delay + ' ms');
        if (!quitting) restartTimer = setTimeout(startSidecam, delay);
    }

    let lastWriteAt = 0, lastStatusKey = '';

    function coordinate(now) {
        if (now - fw.checkedAt >= CFG.ruleMs) ensureRules(now);
        if (!cr) startRenderer();
        const app = findApp(now);
        ensureAppRunDir(now, (owner) => openControlSocket(owner));
        if (appRun.dir && !ctlServer) openControlSocket({ uid: appRun.uid, gid: appRun.gid });
        pairToApp(now);
        checkAnhOnDemand(now);

        const ctrl = readControlState(app, now);
        const navInfo = someipHub ? someipHub.navState(now) : { wanted: false, state: 'not started', ifaces: [], proxies: [], note: '', raw: '', last: null, age: -1 };
        if (someipHub) someipHub.setNavWanted(!!(ctrl.ar && ctrl.ar.nav), now);

        if (child) {
            const cl = configLine(ctrl.config);
            if (cl && cl !== sentConfig && sendSidecam(cl)) sentConfig = cl;
            const al = arLine(ctrl.view === 'front' ? ctrl.ar : null, navInfo.last, now, ctrl.dir || null);
            if (al !== sentAr && now - sentArAt >= 180 && sendSidecam(al)) { sentAr = al; sentArAt = now; }
            const xl = auxLine(ctrl.view === 'front' ? ctrl.aux : null);
            if (xl !== sentAux || (ctrl.view === 'front' && ctrl.aux && now - sentAuxAt >= 1000)) {
                if (sendSidecam(xl)) { sentAux = xl; sentAuxAt = now; }
            }
            if (ctrl.view !== sentView || (ctrl.view !== 'none' && now - sentViewAt >= 1000)) {
                if (sendSidecam(JSON.stringify({ op: 'view', side: ctrl.view }))) {
                    if (ctrl.view !== sentView) log('camera view -> ' + ctrl.view);
                    sentView = ctrl.view; sentViewAt = now;
                }
            }
            if (ctrl.snapPath && ctrl.snapPath !== lastSnapReq) {
                lastSnapReq = ctrl.snapPath;
                sendSidecam(JSON.stringify({ op: 'snap', path: ctrl.snapPath }));
            }
        }

        const vmc = mirror.update(ctrl.vmcDesired.on, ctrl.vmcDesired.view, now);
        const nativeFresh = !!(child && native && now - nativeAt < 3000);
        const s = decideSigns(ctrl, nativeFresh ? native : null, nativeFresh, mirror.isGrabbing(), now);
        if (CFG.camera) manageProbe(s.d.probe, now);
        applyLayers({ symbol: s.symbol, map: s.map, panel: s.panel, hud: s.hud, warn: s.over });

        const shown = [];
        if (s.map.visible || s.panel.visible) shown.push('map');
        if (s.hud.visible) shown.push('hud');
        lastSignSummary = { shown, why: s.why, limit: s.limit, symbol: shown.length ? s.symbol : null };

        const statusKey = JSON.stringify([
            sentView, fps, nativeFresh ? native.shown : 0, nativeFresh ? native.layer : '', nativeFresh ? native.aux_shown : 0,
            lastSignSummary, s.over, s.source, phone.from, phone.packets, vmc.on, vmc.running, vmc.error, navInfo.state, navInfo.last,
        ]);
        if (statusKey !== lastStatusKey || now - lastWriteAt >= 950) {
            lastStatusKey = statusKey;
            lastWriteAt = now;
            writeUnifiedStatus(app, s, vmc, navInfo, nativeFresh ? native : null, now);
        }
        return s;
    }

    function writeUnifiedStatus(app, s, vmc, navInfo, nativeObj, now) {
        const st = {
            at: new Date(now).toISOString(),
            version: VERSION,
            tool: VERSION,
            app: app ? app.id : null,
            view: sentView || 'none',
            fps,
            note: child ? '' : note,
            native: nativeObj,
            snap: lastSnap,
            nav: navInfo,
            vmc,
            // Speed-limit sign fields (100% compatible with vietmap-signs & Bimmer AI co-pilot)
            settings: s.d,
            port: CFG.port,
            phone: {
                from: phone.from, at: phone.at ? new Date(phone.at).toISOString() : null, ago_ms: phone.at ? now - phone.at : null,
                seq: phone.seq, limit: phone.limit, next: phone.next || null, hint: phone.hint || null, test: phone.test,
                app: phone.ver, packets: phone.packets, ignored: phone.ignored, bad: phone.bad,
            },
            limit: s.limit,
            symbol: lastSignSummary.symbol,
            shown: lastSignSummary.shown,
            cluster_target: s.panel.visible ? 'panel' : s.map.visible ? 'map' : null,
            why: s.why,
            waze: { known: s.woc.known, fresh: s.woc.fresh, state: s.woc.state || null, map: s.woc.map, hud: s.woc.hud, hudBox: s.woc.hudBox || null },
            xinhan: { known: !!nativeObj, fresh: !!nativeObj, front: s.frontCamShown, target: s.frontTarget },
            placing: s.placing,
            geometry: {
                map: { x: s.map.x, y: s.map.y, size: s.map.size, w: MAP_W, h: MAP_H, placed: !!s.d.mapPos },
                hud: { x: s.hud.x, y: s.hud.y, size: s.hud.size, w: HUD_W, h: HUD_H, placed: !!s.d.hudPos, seen: HUD_SEEN },
            },
            renderer: {
                installed: renderer.installed, connected: renderer.connected, backend: renderer.backend, error: renderer.error,
                layers: renderer.layers, targets: renderer.targets,
            },
            firewall: { present: fw.present, rules: fw.rules, error: fw.error },
            source: s.source,
            speed: s.speed,
            over: s.over,
            speed_own: ownSpeed(now) !== null,
            pairing: { on: CFG.pairing, code: CFG.pairing ? pairCode() : null, refused: pair.refused, from: pair.from, ago_ms: pair.at ? now - pair.at : null, error: pair.error },
            probe: { on: s.d.probe, running: !!probe.child, bytes: (() => { try { return fs.statSync(probeLog()).size; } catch (e) { return 0; } })() },
            camera: {
                on: s.d.camera, ready: camState.ready, error: camState.error, up: camState.up, limit: camState.limit, low: camState.low || 0,
                at: camState.at ? new Date(camState.at).toISOString() : null, km: Math.round(camState.km * 10) / 10, seen: camState.signs,
                events: camState.events, last_event: camState.lastEventAt ? new Date(camState.lastEventAt).toISOString() : null,
            },
            bmwmap: {
                on: s.d.bmwMap, ready: camState.map.ready, error: camState.map.error, up: camState.up.map, cls: camState.map.cls,
                limit: signsCam.mapCurrent(camState, now, s.d.camera), read: camState.map.limit, low: camState.map.low || 0,
                unit: camState.map.unit, match: camState.map.match, next: camState.map.next, next_limit: camState.map.nextLimit || 0,
                ago_ms: camState.map.at ? now - camState.map.at : null, events: camState.map.events, periodic: camState.map.periodic,
            },
            screen: {
                on: s.d.screen, reading: s.reading, limit: screen.limit, at: screen.at ? new Date(screen.at).toISOString() : null,
                shots: screen.shots, ms: screen.ms, decode_ms: screen.decodeMs, rings: screen.rings, error: screen.error, geometry: screen.geometry || 'full',
            },
        };
        try { writeAtomic(STATUS_FILE(), JSON.stringify(st) + '\n', 0o644); } catch (e) {}
    }

    listenUdp(() => { try { coordinate(Date.now()); } catch (e) { log('udp tick: ' + e.message); } });
    startSidecam();
    const timer = setInterval(() => { try { coordinate(Date.now()); } catch (e) { log('tick: ' + e.message); } }, CFG.pollMs);
    coordinate(Date.now());

    const quit = (sig) => {
        if (quitting) return;
        quitting = true;
        log('stopping (' + (sig || 'quit') + ')');
        clearInterval(timer);
        if (restartTimer) clearTimeout(restartTimer);
        flashing(false);
        manageProbe(false, Date.now());
        if (someipHub) someipHub.stop();
        mirror.shutdown(systemStopping());
        if (ctlServer) { try { ctlServer.close(); } catch (e) {} }
        if (child) { try { child.stdin.end(); } catch (e) {} }
        if (cr) { try { cr.close(); } catch (e) {} }
        if (udpSock) { try { udpSock.close(); } catch (e) {} }
        try { removeRules(); } catch (e) {}
        try { fs.unlinkSync(STATUS_FILE()); } catch (e) {}
        setTimeout(() => process.exit(0), 250);
    };
    process.on('SIGTERM', () => quit('SIGTERM'));
    process.on('SIGINT', () => quit('SIGINT'));
    return { stop: () => quit('stop'), coordinate };
}

function deactivate() {
    let rules = 0;
    try { rules = removeRules(); } catch (e) {}
    const mirror = wocMirror.createMirror({ run: CFG.run, systemctl: CFG.systemctl, wocDir: CFG.wocDir });
    const hadWoc = mirror.deactivate();
    process.stdout.write(JSON.stringify({ status: 'deactivated (rules=' + rules + ', woc=' + hadWoc + ')' }) + '\n');
}

if (require.main === module) {
    const cmd = process.argv[2] || 'run';
    if (cmd === 'run') run();
    else if (cmd === 'deactivate') deactivate();
    else if (cmd === 'status') process.stdout.write((readText(STATUS_FILE()) || '{}\n'));
    else if (cmd === 'sign') {
        const raw = process.argv[3] || '60', n = raw === '---' ? '---' : Number(raw), S = Number(process.argv[4] || 128);
        fs.writeFileSync('sign-' + raw + '.rgba', drawSign(n, S, false));
        process.stdout.write('sign-' + raw + '.rgba: ' + S + 'x' + S + ' RGBA\n');
    } else {
        process.stderr.write('usage: node bimmer-drive.js run|deactivate|status|sign <limit> <size>\n');
        process.exit(2);
    }
}

module.exports = {
    VERSION, CFG, SIZES, BLINK, drawSign, configLine, auxLine, arLine, geometry, wocStatus,
    parsePacket, allowedSender, paired, pairCode, setCode, pair, phone, decideSigns, camState,
    ensureRules, removeRules, ourRules, listenUdp, readControlState, run, deactivate,
    _reset: () => {
        appCache = null; appScanAt = 0; anhCache = null; anhScanAt = 0;
        appRun.dir = null; appRun.checkedAt = 0; appRun.proc = null; appRun.procAt = 0;
        liveControl = null; liveControlDir = null; labelSeq = null;
    },
};
