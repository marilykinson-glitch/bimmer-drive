'use strict';
/**
 * dbus-bluez-hud.js - Pure Node 8 D-Bus + BlueZ 5 GATT Server & LE Advertiser for VietMap HUD (`HUD(BLE)`).
 *
 * Connects directly to `/var/run/dbus/system_bus_socket`, authenticates via SASL EXTERNAL,
 * queries `org.bluez` managed objects, and if an adapter exposes BOTH `GattManager1` and
 * `LEAdvertisingManager1`, registers the `0000fff0-...` VietMap HUD GATT peripheral (`FFF1` notify,
 * `FFF2` write) and advertises LocalName `HUD(BLE)` WITHOUT touching `Adapter1.Alias` or `Discoverable`.
 *
 * Prefers secondary USB BLE dongles (`hci1`, `hci2`, ...) over built-in `hci0` when available.
 * Fails gracefully (`no_bluez` / `no_adapter`) on units without BlueZ BLE server exposure.
 *
 * Node 8.16 (ES2017) compatible, zero external dependencies.
 */
const net = require('net');
const vmHud = require('./vm-hud');

const APP_PATH = '/dev/mgu/vmhud';
const SVC_PATH = '/dev/mgu/vmhud/svc0';
const CHR_TX_PATH = '/dev/mgu/vmhud/svc0/chr_tx';
const CHR_RX_PATH = '/dev/mgu/vmhud/svc0/chr_rx';
const ADV_PATH = '/dev/mgu/vmhud/adv0';

/* ---------------- Little-Endian D-Bus Binary Wire Protocol Codec ---------------- */

function alignOffset(off, a) {
    return a <= 1 ? off : (off + a - 1) & ~(a - 1);
}

function splitTopSignatures(sig) {
    const out = [];
    let i = 0;
    while (i < sig.length) {
        const start = i;
        const ch = sig[i];
        if (ch === 'a') {
            i++;
            const sub = readOneSig(sig, i);
            i += sub.length;
        } else if (ch === '(') {
            let depth = 1;
            i++;
            while (i < sig.length && depth > 0) {
                if (sig[i] === '(') depth++;
                else if (sig[i] === ')') depth--;
                i++;
            }
        } else if (ch === '{') {
            let depth = 1;
            i++;
            while (i < sig.length && depth > 0) {
                if (sig[i] === '{') depth++;
                else if (sig[i] === '}') depth--;
                i++;
            }
        } else {
            i++;
        }
        out.push(sig.slice(start, i));
    }
    return out;
}

function readOneSig(sig, pos) {
    return splitTopSignatures(sig.slice(pos))[0] || '';
}

function typeAlignment(sig) {
    if (!sig) return 1;
    const ch = sig[0];
    if (ch === 'y' || ch === 'g' || ch === 'v') return 1;
    if (ch === 'n' || ch === 'q') return 2;
    if (ch === 'b' || ch === 'i' || ch === 'u' || ch === 'h' || ch === 's' || ch === 'o' || ch === 'a') return 4;
    if (ch === 'x' || ch === 't' || ch === 'd' || ch === '(' || ch === '{') return 8;
    return 1;
}

function v(sig, val) {
    return { __dbusVariant: true, sig, val };
}

function Writer() {
    this.chunks = [];
    this.len = 0;
}
Writer.prototype.pad = function (a) {
    const target = alignOffset(this.len, a);
    const n = target - this.len;
    if (n > 0) {
        this.chunks.push(Buffer.alloc(n));
        this.len += n;
    }
};
Writer.prototype.push = function (buf) {
    if (!buf.length) return;
    this.chunks.push(buf);
    this.len += buf.length;
};
Writer.prototype.u8 = function (n) {
    const b = Buffer.allocUnsafe(1);
    b[0] = n & 0xFF;
    this.push(b);
};
Writer.prototype.u32 = function (n) {
    this.pad(4);
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32LE(n >>> 0, 0);
    this.push(b);
    return this.chunks.length - 1;
};
Writer.prototype.i32 = function (n) {
    this.pad(4);
    const b = Buffer.allocUnsafe(4);
    b.writeInt32LE(n | 0, 0);
    this.push(b);
};
Writer.prototype.str = function (s) {
    const raw = Buffer.from(String(s), 'utf8');
    this.u32(raw.length);
    this.push(raw);
    this.u8(0);
};
Writer.prototype.sig = function (s) {
    const raw = Buffer.from(String(s), 'ascii');
    this.u8(raw.length);
    this.push(raw);
    this.u8(0);
};
Writer.prototype.toBuffer = function () {
    return Buffer.concat(this.chunks, this.len);
};

function writeValue(w, sig, val) {
    const ch = sig[0];
    if (ch === 'y') { w.u8(Number(val) & 0xFF); return; }
    if (ch === 'b') { w.u32(val ? 1 : 0); return; }
    if (ch === 'u') { w.u32(Number(val) >>> 0); return; }
    if (ch === 'i') { w.i32(Number(val) | 0); return; }
    if (ch === 's' || ch === 'o') { w.str(val); return; }
    if (ch === 'g') { w.sig(val); return; }
    if (ch === 'v') {
        const vsig = val && val.__dbusVariant ? val.sig : 's';
        const vval = val && val.__dbusVariant ? val.val : val;
        w.sig(vsig);
        writeValue(w, vsig, vval);
        return;
    }
    if (ch === 'a') {
        const elemSig = sig.slice(1);
        const lenChunkIdx = w.u32(0);
        w.pad(typeAlignment(elemSig));
        const startLen = w.len;
        if (elemSig === 'y') {
            const raw = Buffer.isBuffer(val) ? val : Buffer.from(val || []);
            w.push(raw);
        } else if (elemSig[0] === '{') {
            const inner = elemSig.slice(1, -1);
            const parts = splitTopSignatures(inner);
            if (Array.isArray(val)) {
                for (let i = 0; i < val.length; i++) {
                    writeValue(w, elemSig, val[i]);
                }
            } else if (val && typeof val === 'object') {
                const keys = Object.keys(val);
                for (let i = 0; i < keys.length; i++) {
                    w.pad(8);
                    writeValue(w, parts[0], keys[i]);
                    writeValue(w, parts[1], val[keys[i]]);
                }
            }
        } else {
            const arr = Array.isArray(val) ? val : [];
            for (let i = 0; i < arr.length; i++) {
                writeValue(w, elemSig, arr[i]);
            }
        }
        const byteLen = (w.len - startLen) >>> 0;
        w.chunks[lenChunkIdx].writeUInt32LE(byteLen, 0);
        return;
    }
    if (ch === '(' || ch === '{') {
        const inner = sig.slice(1, -1);
        const parts = splitTopSignatures(inner);
        const arr = Array.isArray(val) ? val : [];
        w.pad(8);
        for (let i = 0; i < parts.length; i++) {
            writeValue(w, parts[i], arr[i]);
        }
    }
}

function Reader(buf, off) {
    this.buf = buf;
    this.off = off || 0;
}
Reader.prototype.pad = function (a) {
    this.off = alignOffset(this.off, a);
};
Reader.prototype.u8 = function () {
    return this.buf[this.off++];
};
Reader.prototype.u16 = function () {
    this.pad(2);
    const val = this.buf.readUInt16LE(this.off);
    this.off += 2;
    return val;
};
Reader.prototype.u32 = function () {
    this.pad(4);
    const val = this.buf.readUInt32LE(this.off);
    this.off += 4;
    return val;
};
Reader.prototype.i32 = function () {
    this.pad(4);
    const val = this.buf.readInt32LE(this.off);
    this.off += 4;
    return val;
};
Reader.prototype.u64 = function () {
    this.pad(8);
    const lo = this.buf.readUInt32LE(this.off);
    const hi = this.buf.readUInt32LE(this.off + 4);
    this.off += 8;
    return hi * 4294967296 + lo;
};
Reader.prototype.str = function () {
    const len = this.u32();
    const s = this.buf.toString('utf8', this.off, this.off + len);
    this.off += len + 1;
    return s;
};
Reader.prototype.sig = function () {
    const len = this.u8();
    const s = this.buf.toString('ascii', this.off, this.off + len);
    this.off += len + 1;
    return s;
};

function readValue(r, sig) {
    const ch = sig[0];
    if (ch === 'y') return r.u8();
    if (ch === 'b') return !!r.u32();
    if (ch === 'n') return (r.u16() << 16) >> 16;
    if (ch === 'q') return r.u16();
    if (ch === 'u' || ch === 'h') return r.u32();
    if (ch === 'i') return r.i32();
    if (ch === 't' || ch === 'x') return r.u64();
    if (ch === 'd') {
        r.pad(8);
        const val = r.buf.readDoubleLE(r.off);
        r.off += 8;
        return val;
    }
    if (ch === 's' || ch === 'o') return r.str();
    if (ch === 'g') return r.sig();
    if (ch === 'v') {
        const vsig = r.sig();
        return readValue(r, vsig);
    }
    if (ch === 'a') {
        const elemSig = sig.slice(1);
        const byteLen = r.u32();
        r.pad(typeAlignment(elemSig));
        const end = r.off + byteLen;
        if (elemSig === 'y') {
            const raw = Buffer.from(r.buf.slice(r.off, end));
            r.off = end;
            return raw;
        }
        if (elemSig[0] === '{') {
            const inner = elemSig.slice(1, -1);
            const parts = splitTopSignatures(inner);
            const obj = {};
            while (r.off < end) {
                r.pad(8);
                const k = readValue(r, parts[0]);
                const val = readValue(r, parts[1]);
                obj[k] = val;
            }
            return obj;
        }
        const arr = [];
        while (r.off < end) {
            arr.push(readValue(r, elemSig));
        }
        return arr;
    }
    if (ch === '(' || ch === '{') {
        const inner = sig.slice(1, -1);
        const parts = splitTopSignatures(inner);
        r.pad(8);
        const arr = [];
        for (let i = 0; i < parts.length; i++) {
            arr.push(readValue(r, parts[i]));
        }
        return arr;
    }
    return null;
}

function encodeMessage(msg) {
    const bodyW = new Writer();
    if (msg.sig && Array.isArray(msg.args)) {
        const parts = splitTopSignatures(msg.sig);
        for (let i = 0; i < parts.length; i++) {
            writeValue(bodyW, parts[i], msg.args[i]);
        }
    }
    const body = bodyW.toBuffer();

    const fields = [];
    if (msg.path) fields.push([1, v('o', msg.path)]);
    if (msg.iface) fields.push([2, v('s', msg.iface)]);
    if (msg.member) fields.push([3, v('s', msg.member)]);
    if (msg.errorName) fields.push([4, v('s', msg.errorName)]);
    if (msg.replySerial) fields.push([5, v('u', msg.replySerial)]);
    if (msg.dest) fields.push([6, v('s', msg.dest)]);
    if (msg.sig) fields.push([8, v('g', msg.sig)]);

    const hdrW = new Writer();
    hdrW.u8(0x6C); // 'l' little-endian
    hdrW.u8(msg.type || 1);
    hdrW.u8(msg.flags || 0);
    hdrW.u8(1); // D-Bus protocol v1
    hdrW.u32(body.length);
    hdrW.u32(msg.serial || 1);
    writeValue(hdrW, 'a(yv)', fields);
    hdrW.pad(8);

    return Buffer.concat([hdrW.toBuffer(), body]);
}

function tryDecodeMessage(buf) {
    if (buf.length < 16) return null;
    if (buf[0] !== 0x6C) throw new Error('dbus endianness != little');
    const type = buf[1];
    const flags = buf[2];
    const bodyLen = buf.readUInt32LE(4);
    const serial = buf.readUInt32LE(8);
    const fieldsByteLen = buf.readUInt32LE(12);
    const hdrEnd = alignOffset(16 + fieldsByteLen, 8);
    const total = hdrEnd + bodyLen;
    if (buf.length < total) return null;

    const r = new Reader(buf, 12);
    const rawFields = readValue(r, 'a(yv)');
    const headers = {};
    for (let i = 0; i < rawFields.length; i++) {
        headers[rawFields[i][0]] = rawFields[i][1];
    }
    const sig = headers[8] || '';
    const args = [];
    if (sig && bodyLen > 0) {
        const br = new Reader(buf, hdrEnd);
        const parts = splitTopSignatures(sig);
        for (let i = 0; i < parts.length; i++) {
            args.push(readValue(br, parts[i]));
        }
    }
    return {
        total,
        msg: {
            type,
            flags,
            serial,
            path: headers[1] || '',
            iface: headers[2] || '',
            member: headers[3] || '',
            errorName: headers[4] || '',
            replySerial: headers[5] || 0,
            dest: headers[6] || '',
            sender: headers[7] || '',
            sig,
            args,
        },
    };
}

/* ---------------- BlueZ GATT Server & LE Advertiser ---------------- */

function gattManagedObjects(localName) {
    return {
        [SVC_PATH]: {
            'org.bluez.GattService1': {
                UUID: v('s', vmHud.SERVICE_UUID),
                Primary: v('b', true),
            },
        },
        [CHR_TX_PATH]: {
            'org.bluez.GattCharacteristic1': {
                UUID: v('s', vmHud.NOTIFY_UUID),
                Service: v('o', SVC_PATH),
                Flags: v('as', ['notify', 'read']),
                Value: v('ay', Buffer.alloc(0)),
            },
        },
        [CHR_RX_PATH]: {
            'org.bluez.GattCharacteristic1': {
                UUID: v('s', vmHud.WRITE_UUID),
                Service: v('o', SVC_PATH),
                Flags: v('as', ['write', 'write-without-response']),
            },
        },
    };
}

function advProps(localName) {
    return {
        Type: v('s', 'peripheral'),
        LocalName: v('s', localName || vmHud.ADV_NAME),
        ServiceUUIDs: v('as', [vmHud.SERVICE_UUID]),
    };
}

function pickAdapter(managed) {
    if (!managed || typeof managed !== 'object') return null;
    const paths = Object.keys(managed).filter((p) => {
        const ifaces = managed[p] || {};
        return /^\/org\/bluez\/hci\d+$/.test(p) &&
            Object.prototype.hasOwnProperty.call(ifaces, 'org.bluez.GattManager1') &&
            Object.prototype.hasOwnProperty.call(ifaces, 'org.bluez.LEAdvertisingManager1');
    });
    if (!paths.length) return null;
    // Prefer secondary USB BLE dongles (hci1+) over built-in hci0 if present
    paths.sort((a, b) => {
        const na = Number(a.replace('/org/bluez/hci', ''));
        const nb = Number(b.replace('/org/bluez/hci', ''));
        if (na === 0 && nb > 0) return 1;
        if (nb === 0 && na > 0) return -1;
        return na - nb;
    });
    return paths[0];
}

function createBluezHud(opts) {
    const o = opts || {};
    const socketPath = o.socketPath || '/var/run/dbus/system_bus_socket';
    const localName = o.localName || vmHud.ADV_NAME;
    const log = typeof o.log === 'function' ? o.log : () => {};
    const onState = typeof o.onState === 'function' ? o.onState : () => {};
    const onUpdate = typeof o.onUpdate === 'function' ? o.onUpdate : () => {};

    let sock = null;
    let closed = false;
    let authed = false;
    let authStage = 0; // 0: wait EXTERNAL OK, 1: wait ANONYMOUS OK
    let rxBuf = Buffer.alloc(0);
    let nextSerial = 1;
    const pending = {};
    let adapterPath = null;
    let appRegistered = false;
    let advRegistered = false;
    let notifying = false;
    let lastTxChunk = Buffer.alloc(0);

    const proto = vmHud.createProtocol({
        mtuPayload: 20,
        subscribeDelayMs: o.subscribeDelayMs !== undefined ? o.subscribeDelayMs : 250,
        log,
        onUpdate,
        onTx: (chunks) => {
            if (!notifying || closed || !sock || !authed) return;
            for (let i = 0; i < chunks.length; i++) {
                lastTxChunk = chunks[i];
                sendRaw(encodeMessage({
                    type: 4,
                    serial: nextSerial++,
                    path: CHR_TX_PATH,
                    iface: 'org.freedesktop.DBus.Properties',
                    member: 'PropertiesChanged',
                    sig: 'sa{sv}as',
                    args: ['org.bluez.GattCharacteristic1', { Value: v('ay', chunks[i]) }, []],
                }));
            }
        },
    });

    function setState(st) {
        onState(st);
    }

    function failAllPending(err) {
        Object.keys(pending).forEach((k) => {
            const fn = pending[k];
            delete pending[k];
            try { fn(err); } catch (e) {}
        });
    }

    function sendRaw(buf) {
        if (closed || !sock) return false;
        try { sock.write(buf); return true; } catch (e) { return false; }
    }

    function callMethod(dest, objPath, iface, member, sig, args) {
        return new Promise((resolve, reject) => {
            if (closed || !sock || !authed) {
                reject(new Error('dbus not connected'));
                return;
            }
            const serial = nextSerial++;
            const timer = setTimeout(() => {
                if (pending[serial]) {
                    delete pending[serial];
                    reject(new Error('dbus timeout: ' + member));
                }
            }, 6000);
            pending[serial] = (err, reply) => {
                clearTimeout(timer);
                if (err) reject(err);
                else resolve(reply);
            };
            sendRaw(encodeMessage({
                type: 1,
                serial,
                dest,
                path: objPath,
                iface,
                member,
                sig: sig || '',
                args: args || [],
            }));
        });
    }

    function replyMethod(req, sig, args) {
        sendRaw(encodeMessage({
            type: 2,
            serial: nextSerial++,
            replySerial: req.serial,
            dest: req.sender || undefined,
            sig: sig || '',
            args: args || [],
        }));
    }

    function replyError(req, errName, text) {
        sendRaw(encodeMessage({
            type: 3,
            serial: nextSerial++,
            replySerial: req.serial,
            dest: req.sender || undefined,
            errorName: errName || 'org.freedesktop.DBus.Error.Failed',
            sig: 's',
            args: [String(text || 'error')],
        }));
    }

    function handleMethodCall(req) {
        if (req.path === APP_PATH && req.member === 'GetManagedObjects') {
            replyMethod(req, 'a{oa{sa{sv}}}', [gattManagedObjects(localName)]);
            return;
        }
        if (req.path === ADV_PATH && req.iface === 'org.freedesktop.DBus.Properties') {
            const props = advProps(localName);
            if (req.member === 'GetAll') {
                replyMethod(req, 'a{sv}', [props]);
                return;
            }
            if (req.member === 'Get') {
                const prop = req.args[1];
                if (Object.prototype.hasOwnProperty.call(props, prop)) {
                    replyMethod(req, 'v', [props[prop]]);
                } else {
                    replyError(req, 'org.freedesktop.DBus.Error.UnknownProperty', 'unknown property ' + prop);
                }
                return;
            }
        }
        if (req.path === ADV_PATH && req.iface === 'org.bluez.LEAdvertisement1' && req.member === 'Release') {
            advRegistered = false;
            replyMethod(req, '', []);
            return;
        }
        if (req.path === CHR_TX_PATH && req.iface === 'org.bluez.GattCharacteristic1') {
            if (req.member === 'StartNotify') {
                notifying = true;
                replyMethod(req, '', []);
                proto.onSubscribe();
                return;
            }
            if (req.member === 'StopNotify') {
                notifying = false;
                proto.reset();
                replyMethod(req, '', []);
                return;
            }
            if (req.member === 'ReadValue') {
                replyMethod(req, 'ay', [lastTxChunk]);
                return;
            }
        }
        if (req.path === CHR_RX_PATH && req.iface === 'org.bluez.GattCharacteristic1' && req.member === 'WriteValue') {
            const raw = Buffer.isBuffer(req.args[0]) ? req.args[0] : Buffer.from(req.args[0] || []);
            replyMethod(req, '', []);
            proto.feed(raw);
            return;
        }
        if (!(req.flags & 1)) {
            replyError(req, 'org.freedesktop.DBus.Error.UnknownMethod', 'unhandled ' + req.iface + '.' + req.member);
        }
    }

    function handleMessage(msg) {
        if (msg.type === 2 || msg.type === 3) {
            const cb = pending[msg.replySerial];
            if (cb) {
                delete pending[msg.replySerial];
                if (msg.type === 3) cb(new Error(msg.errorName + ': ' + (msg.args[0] || '')));
                else cb(null, msg);
            }
            return;
        }
        if (msg.type === 1) {
            handleMethodCall(msg);
        }
    }

    function onSocketData(chunk) {
        rxBuf = rxBuf.length ? Buffer.concat([rxBuf, chunk]) : chunk;
        while (!authed) {
            const crlf = rxBuf.indexOf('\r\n');
            if (crlf < 0) return;
            const line = rxBuf.slice(0, crlf).toString('utf8');
            rxBuf = rxBuf.slice(crlf + 2);
            if (line.indexOf('OK ') === 0) {
                authed = true;
                sendRaw(Buffer.from('BEGIN\r\n', 'ascii'));
                onAuthed();
            } else if (authStage === 0) {
                authStage = 1;
                sendRaw(Buffer.from('AUTH ANONYMOUS\r\n', 'ascii'));
            } else {
                setState({ bleState: 'no_bluez', bleError: 'dbus auth rejected: ' + line });
                cleanupSocket();
                return;
            }
        }
        while (rxBuf.length >= 16) {
            const dec = tryDecodeMessage(rxBuf);
            if (!dec) break;
            rxBuf = rxBuf.slice(dec.total);
            handleMessage(dec.msg);
        }
    }

    function onAuthed() {
        callMethod('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'Hello', '', [])
            .then(() => callMethod('org.bluez', '/', 'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects', '', []))
            .then((reply) => {
                const managed = reply.args && reply.args[0] ? reply.args[0] : {};
                adapterPath = pickAdapter(managed);
                if (!adapterPath) {
                    setState({ bleState: 'no_adapter', bleAdapter: null, bleError: null });
                    log('vm-hud ble: no BlueZ GattManager1+LEAdvertisingManager1 adapter');
                    return null;
                }
                const shortName = adapterPath.split('/').pop();
                return callMethod('org.bluez', adapterPath, 'org.bluez.GattManager1', 'RegisterApplication', 'oa{sv}', [APP_PATH, {}])
                    .then(() => {
                        appRegistered = true;
                        return callMethod('org.bluez', adapterPath, 'org.bluez.LEAdvertisingManager1', 'RegisterAdvertisement', 'oa{sv}', [ADV_PATH, {}]);
                    })
                    .then(() => {
                        advRegistered = true;
                        setState({ bleState: 'advertising', bleAdapter: shortName, bleError: null });
                        log('vm-hud ble: advertising "' + localName + '" via BlueZ on ' + shortName);
                    });
            })
            .catch((err) => {
                if (closed) return;
                const msg = String((err && err.message) || err);
                const noService = msg.indexOf('ServiceUnknown') >= 0 || msg.indexOf('NameHasNoOwner') >= 0 || msg.indexOf('AccessDenied') >= 0;
                setState({
                    bleState: noService ? 'no_bluez' : 'error',
                    bleAdapter: adapterPath ? adapterPath.split('/').pop() : null,
                    bleError: noService ? null : msg.slice(0, 140),
                });
                log('vm-hud ble: ' + (noService ? 'BlueZ unavailable (' + msg + ')' : msg));
            });
    }

    function cleanupSocket() {
        failAllPending(new Error('closed'));
        if (sock) {
            try { sock.destroy(); } catch (e) {}
            sock = null;
        }
    }

    function start() {
        try {
            sock = net.createConnection(socketPath);
        } catch (e) {
            setState({ bleState: 'no_bluez', bleError: null });
            return;
        }
        sock.on('connect', () => {
            const uid = typeof process.getuid === 'function' ? String(process.getuid()) : '0';
            const hexUid = Buffer.from(uid, 'ascii').toString('hex');
            sendRaw(Buffer.from('\0AUTH EXTERNAL ' + hexUid + '\r\n', 'ascii'));
        });
        sock.on('data', onSocketData);
        sock.on('error', (e) => {
            if (!authed && !closed) {
                setState({ bleState: 'no_bluez', bleError: null });
                log('vm-hud ble: dbus socket unavailable (' + e.message + ')');
            }
            cleanupSocket();
        });
        sock.on('close', () => {
            cleanupSocket();
        });
    }

    function stop() {
        if (closed) return;
        closed = true;
        proto.reset();
        const done = () => cleanupSocket();
        if (sock && authed && adapterPath && (advRegistered || appRegistered)) {
            let p = Promise.resolve();
            if (advRegistered) {
                p = p.then(() => callMethod('org.bluez', adapterPath, 'org.bluez.LEAdvertisingManager1', 'UnregisterAdvertisement', 'o', [ADV_PATH]).catch(() => {}));
            }
            if (appRegistered) {
                p = p.then(() => callMethod('org.bluez', adapterPath, 'org.bluez.GattManager1', 'UnregisterApplication', 'o', [APP_PATH]).catch(() => {}));
            }
            p.then(done, done);
            setTimeout(done, 250);
        } else {
            done();
        }
    }

    start();
    return { stop, proto };
}

module.exports = {
    APP_PATH,
    SVC_PATH,
    CHR_TX_PATH,
    CHR_RX_PATH,
    ADV_PATH,
    v,
    encodeMessage,
    tryDecodeMessage,
    pickAdapter,
    gattManagedObjects,
    createBluezHud,
};
