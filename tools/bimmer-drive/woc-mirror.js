'use strict';
/**
 * woc-mirror.js - Embedded Center-Screen Mirror ("VietMap trên đồng hồ") controller for Bimmer Drive.
 *
 * Streams the center CID screen (e.g. VietMap Live on Android Auto) into Waze on cluster via BMW's
 * native `winston-grabber` ONLY when `on` is true. Uses zero processes, zero timers, and zero CPU
 * when `on` is false.
 *
 * Node 8 (ES2017) compatible.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const VIEWS = {
    fit: { geometry: '1280x480', crop: '1280x480:136,0,1088,480', cbr: '2M' },
    zoom1: { geometry: '1600x600', crop: '1600x600:308,60,1088,480', cbr: '3M' },
    zoom2: { geometry: '1920x720', crop: '1920x720:480,120,1088,480', cbr: '4M' },
};
const FPS = 15;

function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } }
function writeAtomic(p, text, mode) {
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, text, { mode: mode || 0o644 });
    fs.renameSync(tmp, p);
}

function envLine(view) {
    const v = VIEWS[view] || VIEWS.fit;
    return 'WOC_SRC_CROP=-s avb_stream= -s src_crop=' + v.crop + '\n';
}

function grabArgs(view, port) {
    const v = VIEWS[view] || VIEWS.fit;
    return ['--screen=center', '--geometry=' + v.geometry, '--fps=' + FPS, '--num-frames=0',
        '--pipeline=h264_msdk(gop=' + FPS + ',gop_ref_dist=1,cbr=' + v.cbr + '), rtp, udp', 'udp://127.0.0.1:' + port];
}

function createMirror(opts) {
    const o = Object.assign({
        run: '/run/bimmer-drive',
        grabber: '/usr/bin/winston-grabber',
        systemctl: 'systemctl',
        wocDir: '/var/opt/waze-on-cluster',
        wocUnit: 'waze-on-cluster.service',
        wayland: '/run/wayland',
        log: () => {},
    }, opts || {});

    const envFile = () => path.join(o.run, 'woc.env');
    let grab = null;
    let failures = 0, nextStart = 0, restarts = 0, lastExit = null, lastWanted = null;
    let lastRestart = { at: null, ok: null, error: null };
    const tail = [];

    const wocInstalled = () => fs.existsSync(path.join(o.wocDir, 'current'));

    function udpPort() {
        let port = 20557;
        [path.join(o.wocDir, 'current', 'waze-on-cluster.conf'), path.join(o.wocDir, 'waze-on-cluster.local.conf')].forEach((f) => {
            (readText(f) || '').split('\n').forEach((line) => {
                const m = /^\s*udp_port\s*=\s*(\d+)\s*(#.*)?$/.exec(line);
                if (m && Number(m[1]) > 0 && Number(m[1]) < 65536) port = Number(m[1]);
            });
        });
        return port;
    }

    function restartWoc(why) {
        o.log('vmc: restarting ' + o.wocUnit + ' (' + why + ')');
        const r = cp.spawnSync(o.systemctl, ['restart', o.wocUnit], { timeout: 30000, encoding: 'utf8' });
        const ok = r.status === 0 && !r.error;
        lastRestart = {
            at: new Date().toISOString(),
            ok,
            error: ok ? null : String((r.error && r.error.message) || r.stderr || ('exit ' + r.status)).trim().slice(0, 200),
        };
        if (!ok) o.log('vmc: restart failed: ' + lastRestart.error);
        return ok;
    }

    function applyEnv(view) {
        const want = view ? envLine(view) : null;
        const have = readText(envFile());
        if (have === want) return false;
        if (want) writeAtomic(envFile(), want, 0o644);
        else { try { fs.unlinkSync(envFile()); } catch (e) {} }
        if (wocInstalled()) restartWoc(view ? 'centre screen, view ' + view : 'back to phone cluster map');
        return true;
    }

    function backoff() { return Math.min(60000, 3000 * Math.pow(2, Math.max(0, failures - 1))); }

    function startGrab(view, now) {
        const args = grabArgs(view, udpPort());
        o.log('vmc grabber: ' + o.grabber + ' ' + args.join(' '));
        let child;
        try {
            child = cp.spawn(o.grabber, args, { env: Object.assign({}, process.env, { XDG_RUNTIME_DIR: o.wayland }), stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) {
            lastExit = { at: new Date().toISOString(), error: e.message };
            failures++; nextStart = now + backoff();
            return;
        }
        const g = { child, view, since: now, stopping: false };
        grab = g;
        const keep = (d) => String(d).split('\n').forEach((l) => { if (l.trim()) { tail.push(l.trim().slice(0, 200)); if (tail.length > 8) tail.shift(); } });
        child.stdout.on('data', keep);
        child.stderr.on('data', keep);
        child.on('error', (e) => keep('error: ' + e.message));
        child.on('exit', (code, signal) => {
            if (grab === g) grab = null;
            const t = Date.now();
            lastExit = { at: new Date(t).toISOString(), code, signal, line: tail.length ? tail[tail.length - 1] : null };
            if (g.stopping) return;
            if (t - g.since > 60000) failures = 0;
            failures++; restarts++;
            nextStart = t + backoff();
            o.log('vmc grabber ended (' + (signal || 'exit ' + code) + '); again in ' + Math.round((nextStart - t) / 1000) + ' s');
        });
    }

    function stopGrab() {
        const g = grab;
        if (!g) return;
        g.stopping = true;
        grab = null;
        try { g.child.kill('SIGTERM'); } catch (e) {}
        const t = setTimeout(() => { try { g.child.kill('SIGKILL'); } catch (e) {} }, 3000);
        if (t.unref) t.unref();
        o.log('vmc grabber stopped');
    }

    function update(wantOn, rawView, now) {
        const view = VIEWS[rawView] ? rawView : 'fit';
        const on = !!wantOn;
        const key = (on ? '1:' : '0:') + view;
        if (key !== lastWanted) {
            lastWanted = key;
            failures = 0;
            nextStart = 0;
        }
        let error = null;
        if (on) {
            const woc = wocInstalled();
            const grabberThere = fs.existsSync(o.grabber) || !path.isAbsolute(o.grabber);
            if (!woc) error = 'Waze on cluster chưa được cài đặt';
            else if (!grabberThere) error = 'Không tìm thấy winston-grabber';
            if (!error) {
                applyEnv(view);
                if (grab && grab.view !== view) stopGrab();
                if (!grab && now >= nextStart) startGrab(view, now);
                if (!grab && failures) error = 'Bộ chụp màn hình dừng' + (lastExit && lastExit.line ? ': ' + lastExit.line : '');
            } else {
                stopGrab();
                applyEnv(null);
            }
        } else {
            if (grab) stopGrab();
            if (readText(envFile()) !== null) applyEnv(null);
        }
        return {
            on,
            view,
            applied: readText(envFile()) !== null,
            installed: wocInstalled(),
            restart: lastRestart,
            running: !!grab,
            pid: grab ? grab.child.pid : null,
            restarts,
            error,
        };
    }

    function shutdown(systemIsStopping) {
        stopGrab();
        if (readText(envFile()) !== null) {
            try { fs.unlinkSync(envFile()); } catch (e) {}
            if (!systemIsStopping && wocInstalled()) restartWoc('bimmer-drive stopped');
        }
    }

    function deactivate() {
        const had = readText(envFile()) !== null;
        try { fs.unlinkSync(envFile()); } catch (e) {}
        if (had && wocInstalled()) restartWoc('bimmer-drive deactivated');
        return had;
    }

    return {
        update,
        isGrabbing: () => !!grab,
        shutdown,
        deactivate,
        udpPort,
    };
}

module.exports = { VIEWS, FPS, envLine, grabArgs, createMirror };
