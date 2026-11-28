'use strict';
const fs = require('fs');
const cp = require('child_process');

function tailFile(label, p, maxBytes) {
    process.stdout.write('\n=== ' + label + ' (' + p + ') ===\n');
    try {
        const st = fs.statSync(p);
        const sz = st.size;
        const start = Math.max(0, sz - (maxBytes || 24576));
        const fd = fs.openSync(p, 'r');
        const b = Buffer.alloc(sz - start);
        fs.readSync(fd, b, 0, b.length, start);
        fs.closeSync(fd);
        process.stdout.write(b.toString('utf8') + '\n');
    } catch (e) {
        process.stdout.write('(none: ' + e.message + ')\n');
    }
}

tailFile('LIVE STATUS', '/run/bimmer-drive/status.json', 32768);
tailFile('DAEMON LOG', '/var/opt/bimmer-drive/bimmer-drive.log', 24576);
tailFile('PROBE LOG', '/var/opt/bimmer-drive/probe.log', 24576);
tailFile('VIETMAP HUD RAW', '/var/opt/bimmer-drive/vmhud-raw.log', 16384);
try {
    const j = cp.execFileSync('journalctl', ['-u', 'bimmer-drive.service', '-n', '60', '--no-pager'], { encoding: 'utf8', timeout: 5000 });
    process.stdout.write('\n=== JOURNAL (bimmer-drive.service) ===\n' + j + '\n');
} catch (e) {}
