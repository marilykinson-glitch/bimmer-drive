'use strict';
/**
 * oapgen-gen.js - generate SOME/IP interface configs (+ acl.json) using BMW's
 * firmware generator modules (SP18 oap-mainapp or SP21 oap-mainapp21).
 *
 * Supports both in-process `generateInMemory(db, manifest)` (zero child-process spawn)
 * and CLI `node oapgen-gen.js <someip-interfaces.json> <manifest.json> <userId> <outDir>`.
 * Node 8 compatible.
 */
const fs = require('fs');
const path = require('path');

const APPMGMTS = (process.env.OAP_APPMGMT ? [process.env.OAP_APPMGMT] : []).concat([
    '/usr/lib/oap-mainapp/src/AppManagement/AppManagement.js',
    '/usr/lib/oap-mainapp21/src/AppManagement/AppManagement.js',
]);

let bundleReq = null, bundleText = null;
function findAppMgmt() {
    for (let i = 0; i < APPMGMTS.length; i++) {
        if (APPMGMTS[i] && fs.existsSync(APPMGMTS[i])) return APPMGMTS[i];
    }
    return APPMGMTS[0];
}

function fromFirmware(name) {
    const appMgmt = findAppMgmt();
    if (!bundleText) bundleText = fs.readFileSync(appMgmt, 'utf8');
    const m = new RegExp('"someip-interfaces-generator/' + name + '(?:\\.js)?":(\\d+)').exec(bundleText);
    if (!m) throw new Error(name + ' not found in ' + appMgmt);
    if (!bundleReq) {
        const tail = /,\{\},\[\d+\]\)\s*;?\s*$/;
        if (!tail.test(bundleText)) throw new Error('unexpected AppManagement bundle format');
        bundleReq = new Function('require', 'return ' + bundleText.replace(tail, ',{},[])'))(require);
    }
    return bundleReq(m[1]);
}

function load(name) {
    const local = path.join(__dirname, name + '.js');
    if (!fs.existsSync(local)) return fromFirmware(name);
    const m = { exports: {} };
    const src = fs.readFileSync(local, 'utf8');
    new Function('require', 'module', 'exports', src)(require, m, m.exports);
    return m.exports;
}

function generateInMemory(db, manifest) {
    return load('IFConfigGenerator').generate(db, manifest);
}

function main(argv) {
    if (argv.length < 4) {
        console.error('usage: node oapgen-gen.js <someip-interfaces.json> <manifest.json> <userId> <outDir>');
        process.exit(2);
    }
    const dbPath = argv[0], manifestPath = argv[1], userId = argv[2], outDir = argv[3];
    const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/\${userId}/g, String(userId)));
    const ifs = load('IFConfigGenerator').generate(db, manifest);
    const acl = load('AclGenerator').generate(db, manifest);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
    let n = 0;
    Object.keys(ifs).forEach((id) => {
        fs.writeFileSync(path.join(outDir, id.replace(/\./g, '_') + '.json'), JSON.stringify(ifs[id]));
        n++;
    });
    fs.writeFileSync(path.join(outDir, 'acl.json'), JSON.stringify(acl));
    console.log('generated ' + n + ' interface configs + acl.json (' + acl.offers.length + ' offers, ' + acl.requests.length + ' requests)');
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { main, load, generateInMemory };
