'use strict';
/**
 * vm-hud.js - VietMap Live Hardware HUD (`HUD(BLE)` / H1N / H2AS / H1AS) Protocol & USB Serial Bridge.
 *
 * Extracted from `vn.vietmap.live` (`P7/a.java`, `R7/d.java`, `V7/c.java`, `Da/c.java`):
 *   - Advertised BLE LocalName: `HUD(BLE)`
 *   - GATT Service: `0000fff0-0000-1000-8000-00805f9b34fb`
 *   - Notify Characteristic (HUD -> Phone): `0000fff1-0000-1000-8000-00805f9b34fb`
 *   - Write Characteristic  (Phone -> HUD): `0000fff2-0000-1000-8000-00805f9b34fb`
 *   - Framing:
 *       `A5 5A 37 C3` + uint32BE(body.length + 12) + uint32BE(ts) + body([cmd, ...]) + 8 trailer bytes
 *       `A5 5A 37 C5` + payload(uint32BE(payloadLen) + [cmd, ...]) + uint16BE(crc16_modbus(payload))
 *
 * Node 8.16 (ES2017) compatible, zero external dependencies.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const SERVICE_UUID = '0000fff0-0000-1000-8000-00805f9b34fb';
const NOTIFY_UUID = '0000fff1-0000-1000-8000-00805f9b34fb';
const WRITE_UUID = '0000fff2-0000-1000-8000-00805f9b34fb';
const ADV_NAME = 'HUD(BLE)';
const HUD_INFO_STR = 'MODEL:H1N,HW:1.0,FW:1.0,PROTOCOL:2.2.2,OBDV:1_1,SID:0';

const USB_BRIDGE_VIDS = {
    '303a': 'ESP32',
    '10c4': 'CP210x',
    '1a86': 'CH34x',
    '0403': 'FTDI',
    '2341': 'Arduino',
};

function readUsbVendor(devName, sysTtyDir) {
    const base = sysTtyDir || '/sys/class/tty';
    const devPath = path.join(base, devName, 'device');
    try {
        let cur = fs.realpathSync(devPath);
        for (let i = 0; i < 4; i++) {
            cur = path.dirname(cur);
            const vPath = path.join(cur, 'idVendor');
            if (fs.existsSync(vPath)) {
                const raw = fs.readFileSync(vPath, 'utf8').trim().toLowerCase();
                if (raw) return raw;
            }
        }
    } catch (e) {}
    const fallbacks = [
        path.join(devPath, '..', 'idVendor'),
        path.join(devPath, '..', '..', 'idVendor'),
    ];
    for (let i = 0; i < fallbacks.length; i++) {
        try {
            if (fs.existsSync(fallbacks[i])) {
                const raw = fs.readFileSync(fallbacks[i], 'utf8').trim().toLowerCase();
                if (raw) return raw;
            }
        } catch (e) {}
    }
    return null;
}

const CAM_TYPE_HINTS = {
    1: 'Camera tốc độ',
    2: 'Camera đèn đỏ',
    3: 'Khu dân cư',
    4: 'Biển tốc độ',
};

function camTypeHint(type) {
    return Object.prototype.hasOwnProperty.call(CAM_TYPE_HINTS, type) ? CAM_TYPE_HINTS[type] : null;
}

function crc16Modbus(buf) {
    let crc = 0xFFFF;
    for (let i = 0; i < buf.length; i++) {
        crc ^= (buf[i] & 0xFF);
        for (let b = 0; b < 8; b++) {
            if (crc & 1) crc = (crc >>> 1) ^ 0xA001;
            else crc = crc >>> 1;
        }
    }
    return crc & 0xFFFF;
}

function buildC3Frame(cmd, bodyBuf, unixSec) {
    const body = Buffer.isBuffer(bodyBuf) ? bodyBuf : Buffer.alloc(0);
    const lenField = body.length + 13;
    const total = lenField + 8;
    const frame = Buffer.alloc(total);
    frame[0] = 0xA5;
    frame[1] = 0x5A;
    frame[2] = 0x37;
    frame[3] = 0xC3;
    frame.writeUInt32BE(lenField >>> 0, 4);
    const sec = unixSec !== undefined ? (Number(unixSec) >>> 0) : (Math.floor(Date.now() / 1000) >>> 0);
    frame.writeUInt32BE(sec, 8);
    frame[12] = cmd & 0xFF;
    if (body.length) body.copy(frame, 13);
    return frame;
}

function buildC5Frame(cmd, bodyBuf) {
    const body = Buffer.isBuffer(bodyBuf) ? bodyBuf : Buffer.alloc(0);
    const payloadLen = 5 + body.length;
    const payload = Buffer.alloc(payloadLen);
    payload.writeUInt32BE(payloadLen >>> 0, 0);
    payload[4] = cmd & 0xFF;
    if (body.length) body.copy(payload, 5);
    const crc = crc16Modbus(payload);
    const frame = Buffer.alloc(4 + payloadLen + 2);
    frame[0] = 0xA5;
    frame[1] = 0x5A;
    frame[2] = 0x37;
    frame[3] = 0xC5;
    payload.copy(frame, 4);
    frame.writeUInt16BE(crc, 4 + payloadLen);
    return frame;
}

function chunkBuffer(buf, mtuPayload) {
    const size = Math.max(20, Number(mtuPayload) || 20);
    const out = [];
    for (let off = 0; off < buf.length; off += size) {
        out.push(buf.slice(off, Math.min(off + size, buf.length)));
    }
    return out;
}

function createProtocol(opts) {
    const o = opts || {};
    const onUpdate = typeof o.onUpdate === 'function' ? o.onUpdate : () => {};
    const onTx = typeof o.onTx === 'function' ? o.onTx : () => {};
    const log = typeof o.log === 'function' ? o.log : () => {};
    const model = o.model || 'H1N';
    const mtuPayload = Number(o.mtuPayload) || 20;
    const subscribeDelayMs = o.subscribeDelayMs !== undefined ? Number(o.subscribeDelayMs) : 250;

    let rx = Buffer.alloc(0);
    let subscribed = false;
    let subTimer = null;

    function txFrame(frame, label) {
        onTx(chunkBuffer(frame, mtuPayload), label);
    }

    function sendHudInfo() {
        const str = 'MODEL:' + model + ',HW:1.0,FW:1.0,PROTOCOL:2.2.2,OBDV:1_1,SID:0';
        txFrame(buildC3Frame(0x0E, Buffer.from(str, 'utf8')), 'HUDInfo');
    }

    function handleCameraTuples(tuples) {
        if (!tuples.length) return;
        const valid = tuples.filter((t) => t.speed >= 5 && t.speed <= 199);
        if (!valid.length) {
            onUpdate({ kind: 'camera', limit: 0, camType: tuples[0].camType, camDist: tuples[0].dist, next: null, nextDist: null, hint: null });
            return;
        }
        let chosen = valid.find((t) => t.dist === 0);
        if (!chosen) {
            chosen = valid.slice().sort((a, b) => a.dist - b.dist)[0];
        }
        let nextItem = null;
        for (let i = 0; i < valid.length; i++) {
            const t = valid[i];
            if (t !== chosen && t.dist > 0 && t.speed !== chosen.speed) {
                if (!nextItem || t.dist < nextItem.dist) nextItem = t;
            }
        }
        onUpdate({
            kind: 'camera',
            limit: chosen.speed,
            camType: chosen.camType,
            camDist: chosen.dist,
            next: nextItem ? nextItem.speed : null,
            nextDist: nextItem ? nextItem.dist : null,
            hint: camTypeHint(chosen.camType),
        });
    }

    function handleC5(payload) {
        const cmd = payload[4];
        const body = payload.slice(5);
        if (cmd === 0x01 && body.length >= 4) {
            const camType = body[0];
            const dist = body.readUInt16BE(1);
            const speed = body[3];
            handleCameraTuples([{ camType, dist, speed }]);
            return;
        }
        onUpdate({ kind: 'cmd', cmd, bytes: body.length });
    }

    function handleC3(frame) {
        if (frame.length < 21) return;
        const cmd = frame[12];
        const body = frame.slice(13, frame.length - 8);
        if (cmd === 0x01) {
            const tuples = [];
            for (let off = 0; off + 3 < body.length; off += 4) {
                tuples.push({
                    camType: body[off],
                    dist: body.readUInt16BE(off + 1),
                    speed: body[off + 3],
                });
            }
            handleCameraTuples(tuples);
            return;
        }
        if (cmd === 0x0E) {
            sendHudInfo();
            onUpdate({ kind: 'handshake', connected: true, model });
            return;
        }
        if (cmd === 0x50) {
            txFrame(buildC3Frame(0x50, Buffer.from([0x64])), 'SpeedRate');
            onUpdate({ kind: 'heartbeat' });
            return;
        }
        if (cmd === 0x51) {
            txFrame(buildC3Frame(0x51, Buffer.from([0x03])), 'HUDLight');
            onUpdate({ kind: 'heartbeat' });
            return;
        }
        if (cmd === 0x53) {
            txFrame(buildC3Frame(0x53, Buffer.from([0x01, 0x00, 0x07])), 'BuzzerSwitch');
            onUpdate({ kind: 'heartbeat' });
            return;
        }
        if (cmd === 0x40 || cmd === 0x08) {
            onUpdate({ kind: 'heartbeat' });
            return;
        }
        onUpdate({ kind: 'cmd', cmd, bytes: body.length });
    }

    function feed(chunk) {
        if (!chunk || !chunk.length) return;
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        rx = rx.length ? Buffer.concat([rx, buf]) : buf;
        if (rx.length > 32768) rx = rx.slice(-16384);

        while (rx.length >= 4) {
            let syncIdx = -1;
            for (let i = 0; i <= rx.length - 4; i++) {
                if (rx[i] === 0xA5 && rx[i + 1] === 0x5A && rx[i + 2] === 0x37 && (rx[i + 3] === 0xC3 || rx[i + 3] === 0xC5)) {
                    syncIdx = i;
                    break;
                }
            }
            if (syncIdx < 0) {
                if (rx.length > 3) rx = rx.slice(rx.length - 3);
                return;
            }
            if (syncIdx > 0) rx = rx.slice(syncIdx);
            if (rx.length < 8) return;

            const kind = rx[3];
            if (kind === 0xC5) {
                const payloadLen = rx.readUInt32BE(4);
                if (payloadLen < 5 || payloadLen > 8192) {
                    rx = rx.slice(1);
                    continue;
                }
                const total = 4 + payloadLen + 2;
                if (rx.length < total) return;
                const payload = rx.slice(4, 4 + payloadLen);
                rx = rx.slice(total);
                handleC5(payload);
            } else {
                const lenField = rx.readUInt32BE(4);
                if (lenField < 13 || lenField > 16384) {
                    rx = rx.slice(1);
                    continue;
                }
                const total = lenField + 8;
                if (rx.length < total) return;
                const frame = rx.slice(0, total);
                rx = rx.slice(total);
                handleC3(frame);
            }
        }
    }

    function onSubscribe() {
        subscribed = true;
        if (subTimer) { clearTimeout(subTimer); subTimer = null; }
        if (subscribeDelayMs <= 0) {
            sendHudInfo();
            return;
        }
        subTimer = setTimeout(() => {
            subTimer = null;
            if (subscribed) {
                log('vm-hud: sending post-subscribe HUDInfo');
                sendHudInfo();
            }
        }, subscribeDelayMs);
    }

    function reset() {
        subscribed = false;
        if (subTimer) { clearTimeout(subTimer); subTimer = null; }
        rx = Buffer.alloc(0);
    }

    return { feed, onSubscribe, reset, sendHudInfo };
}

function createSerialBridge(opts) {
    const o = opts || {};
    const devDir = o.devDir || '/dev';
    const sysTtyDir = o.sysTtyDir || '/sys/class/tty';
    const overrideDev = o.device || '';
    const scanMs = Number(o.scanMs) || 5000;
    const log = typeof o.log === 'function' ? o.log : () => {};
    const onJson = typeof o.onJson === 'function' ? o.onJson : () => {};
    const onState = typeof o.onState === 'function' ? o.onState : () => {};
    const onFrame = typeof o.onFrame === 'function' ? o.onFrame : () => {};

    const proto = createProtocol({ onUpdate: onFrame, log });
    let timer = null;
    let stream = null;
    let activeDev = null;
    let lineBuf = '';
    let stopped = false;

    function listCandidates() {
        if (overrideDev) return fs.existsSync(overrideDev) ? [overrideDev] : [];
        let names = [];
        try { names = fs.readdirSync(devDir); } catch (e) { return []; }
        return names
            .filter((n) => {
                if (!/^tty(ACM|USB)\d+$/.test(n)) return false;
                const vid = readUsbVendor(n, sysTtyDir);
                return !!(vid && Object.prototype.hasOwnProperty.call(USB_BRIDGE_VIDS, vid));
            })
            .sort()
            .map((n) => path.join(devDir, n));
    }

    function closeStream() {
        if (stream) {
            try { stream.destroy(); } catch (e) {}
            stream = null;
        }
        if (activeDev) {
            activeDev = null;
            lineBuf = '';
            proto.reset();
            onState({ usbDev: null });
        }
    }

    function openDevice(devPath) {
        if (stopped || stream) return;
        if (devPath.indexOf('/dev/') === 0) {
            try {
                cp.spawnSync('stty', ['-F', devPath, '115200', 'raw', '-echo'], { timeout: 1500 });
            } catch (e) {}
        }
        let s;
        try {
            s = fs.createReadStream(devPath);
        } catch (e) {
            return;
        }
        stream = s;
        activeDev = devPath;
        lineBuf = '';
        onState({ usbDev: devPath });
        log('vm-hud serial: opened ' + devPath);

        s.on('data', (chunk) => {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            if (!lineBuf && buf.length && buf[0] === 0xA5) {
                proto.feed(buf);
                return;
            }
            lineBuf += buf.toString('utf8');
            if (lineBuf.length > 16384) lineBuf = lineBuf.slice(-4096);
            let nl;
            while ((nl = lineBuf.indexOf('\n')) >= 0) {
                const line = lineBuf.slice(0, nl).trim();
                lineBuf = lineBuf.slice(nl + 1);
                if (!line || line[0] !== '{') continue;
                let msg = null;
                try { msg = JSON.parse(line); } catch (e) { continue; }
                if (msg && (msg.t === 'vmhud' || msg.t === 'vms')) {
                    onJson(msg, devPath);
                }
            }
        });
        s.on('error', () => { closeStream(); });
        s.on('close', () => { closeStream(); });
    }

    function scan() {
        if (stopped || stream) return;
        const cands = listCandidates();
        if (cands.length) openDevice(cands[0]);
    }

    scan();
    timer = setInterval(scan, scanMs);

    return {
        scan,
        stop: () => {
            stopped = true;
            if (timer) { clearInterval(timer); timer = null; }
            closeStream();
        },
        device: () => activeDev,
    };
}

module.exports = {
    SERVICE_UUID,
    NOTIFY_UUID,
    WRITE_UUID,
    ADV_NAME,
    HUD_INFO_STR,
    USB_BRIDGE_VIDS,
    camTypeHint,
    readUsbVendor,
    crc16Modbus,
    buildC3Frame,
    buildC5Frame,
    chunkBuffer,
    createProtocol,
    createSerialBridge,
};
