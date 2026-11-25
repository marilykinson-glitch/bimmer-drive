'use strict';
/**
 * camera.js - keeps the car's camera unit sending the picture Camera & VietMap needs.
 * Node 8 compatible.
 */
const { camState } = require('./logic');

const MAX_TRIES = 4;
const BACKOFF_MS = 60000;
const ASK_GAP_MS = 3000;
const STARTING_GAP_MS = 4000;
const BLIND_GAP_MS = 30000;
const STEP_TIMEOUT_MS = 30000;

const KIND = { 7: 'all4', 3: 'left', 4: 'right' };
const errText = (e) => String((e && e.message) || e).slice(0, 120);

function create(o) {
    const io = o.io, log = o.log || { info() {}, warn() {} }, now = o.now || Date.now;
    const setTimer = o.setTimer || setTimeout, clearTimer = o.clearTimer || clearTimeout;
    let cam = camState(), cookie = null, busy = false;
    let lastWant = null, lastAskAt = -Infinity, tries = 0, backoffUntil = 0, phase = 'idle';

    function setPhase(p) {
        if (p !== phase) { log.info('camera: ' + p + (cam.known ? ' (' + cam.text + ')' : '')); phase = p; }
    }

    function detach() {
        if (cookie === null) return Promise.resolve();
        const c = cookie;
        cookie = null;
        return Promise.resolve().then(() => io.detach(c))
            .then(() => log.info('camera: released (cookie ' + c + ')'), (e) => log.warn('camera: release failed: ' + errText(e)));
    }

    function ask(want) {
        lastAskAt = now();
        const attached = cookie !== null ? Promise.resolve(cookie)
            : Promise.resolve().then(() => io.attach()).then((c) => { cookie = c; log.info('camera: attached, cookie ' + c); return c; });
        return attached
            .then((c) => io.request(c, want))
            .then(() => log.info('camera: asked for view ' + want + ' (try ' + tries + ')'),
                (e) => log.warn('camera: ask for view ' + want + ' failed: ' + errText(e)));
    }

    function step(want) {
        return Promise.resolve().then(() => io.read()).catch(() => ({})).then((s) => {
            cam = camState(s && s.xv, s && s.icam);
            if (want === null || want === undefined) {
                lastWant = null; tries = 0;
                setPhase('idle');
                return detach();
            }
            if (want !== lastWant) { lastWant = want; tries = 0; backoffUntil = 0; lastAskAt = -Infinity; }
            const t = now();
            if (cam.kind === KIND[want]) { tries = 0; backoffUntil = 0; setPhase('on'); return null; }
            if (cam.kind === 'parking') { setPhase('parking view'); return null; }
            if (t < backoffUntil) { setPhase('waiting'); return null; }
            if (!cam.known) {
                setPhase('asked (state unreadable)');
                return t - lastAskAt >= BLIND_GAP_MS ? ask(want) : null;
            }
            const gap = cam.kind === 'starting' ? STARTING_GAP_MS : ASK_GAP_MS;
            if (t - lastAskAt < gap) return null;
            if (tries >= MAX_TRIES) {
                backoffUntil = t + BACKOFF_MS;
                tries = 0;
                log.warn('camera: view ' + want + ' not given after ' + MAX_TRIES + ' asks (' + cam.text + '): next try in ' + BACKOFF_MS / 1000 + ' s');
                setPhase('waiting');
                return null;
            }
            if (cam.kind !== 'starting') tries++;
            setPhase(cam.kind === 'starting' ? 'starting' : 'asked');
            return ask(want);
        });
    }

    const within = (p, ms) => new Promise((resolve, reject) => {
        const timer = setTimer(() => reject(new Error('no answer in ' + ms / 1000 + ' s')), ms);
        Promise.resolve(p).then((v) => { clearTimer(timer); resolve(v); }, (e) => { clearTimer(timer); reject(e); });
    });

    return {
        tick(want) {
            if (busy) return Promise.resolve();
            busy = true;
            return within(step(want), STEP_TIMEOUT_MS).catch((e) => log.warn('camera: ' + errText(e))).then(() => { busy = false; });
        },
        info() { return { cam, attached: cookie !== null, phase, tries }; },
        release() { return detach(); },
    };
}

module.exports = { create, MAX_TRIES, BACKOFF_MS, ASK_GAP_MS, STARTING_GAP_MS, BLIND_GAP_MS };
