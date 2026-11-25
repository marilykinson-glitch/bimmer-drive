'use strict';
/**
 * check_node8.js - the head unit runs Node 8.16: every script that runs there must parse as ES2017
 * and use nothing newer from the library.
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const ROOT = path.join(__dirname, '..');
const DIRS = ['apps', 'tools', 'kit/runtime', 'kit/tools/oapgen'];
const NEWER = [/\.finally\(/, /\.flat\(/, /\.flatMap\(/, /Object\.fromEntries/, /recursive:\s*true/, /\.matchAll\(/, /\.trimStart\(|\.trimEnd\(/,
    /globalThis/, /\bBigInt\b/, /\.allSettled\(/, /\.replaceAll\(/, /\.at\(-?\d/, /fs\.promises|require\('fs\/promises'\)/, /\.rmSync\(/, /queueMicrotask/,
    /TextDecoder|TextEncoder/, /new URL\(/, /worker_threads/, /\.description\b/];

const files = [];
function walk(rel) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) return;
    fs.readdirSync(abs).forEach((name) => {
        const subRel = path.join(rel, name);
        const st = fs.statSync(path.join(ROOT, subRel));
        if (st.isDirectory()) walk(subRel);
        else if (name.endsWith('.js')) files.push(subRel);
    });
}
DIRS.forEach(walk);

let bad = 0;
files.forEach((f) => {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^#!.*\n/, '');
    try { acorn.parse(src, { ecmaVersion: 2017, sourceType: 'script' }); } catch (e) { console.log(f + ': not ES2017: ' + e.message); bad++; }
    src.split('\n').forEach((line, i) => NEWER.forEach((re) => {
        if (re.test(line.replace(/\/\/.*$/, ''))) { console.log(f + ':' + (i + 1) + ': newer than Node 8: ' + line.trim().slice(0, 100)); bad++; }
    }));
});
console.log(bad ? 'check_node8: ' + bad + ' problem(s)' : 'check_node8: ' + files.length + ' files ok for Node 8');
process.exit(bad ? 1 : 0);
