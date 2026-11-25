'use strict';
/**
 * ui.js - Unified 5-Tab iDrive 7 GPU Interface for Camera & VietMap (`apps/bimmer_drive`, 1600x520).
 *
 * Tabs:
 *   0 "Tổng quan"        Live cluster schematic showing BOTH camera views AND speed-limit sign + 6 status rows + quick controls
 *   1 "Biển báo & AA"    Vietnam speed sign / "---", 6-digit Pairing Code, sign source diagnostics & Center-Screen Mirror controls
 *   2 "Vị trí"           Interactive drag-and-drop & arrow placement for BOTH Mirror Cameras AND Speed Sign (Cluster & HUD)
 *   3 "Canh chỉnh"       Mirror camera pan/zoom + 8-parameter Front Camera AR road perspective calibration
 *   4 "Dẫn đường"        Live Navigation / CarPlay / Android Auto next-turn status, AR mode & 25s demo
 *
 * Node 8 (ES2017) compatible.
 */
const W = 1600, H = 520;
const TABS = ['Tổng quan', 'Biển báo & AA', 'Vị trí', 'Canh chỉnh', 'Dẫn đường'];
const STEP = 10;
const PANEL = { w: 1920, h: 720 };
const MAP = { x: 416, y: 120, w: 1088, h: 480 };
const PICS = [{ x: 48, y: 90, k: 0.39 }, { x: 48, y: 92, k: 0.49 }];
const SIGN_PICS = { map: { x: 52, y: 128, k: 0.46 }, hud: { x: 604, y: 128, k: 0.46 } };
const SIGN_TARGETS = { map: { w: 1088, h: 480 }, hud: { w: 800, h: 480 } };

const nop = () => {};
const kindColor = (t, kind) => (kind === 'go' ? (t.go || '#2fd27a') : kind === 'warn' ? (t.warn || '#ffb020') : kind === 'crit' ? (t.crit || '#ef2b2d') : t.dim);

function hitCluster(px, py) {
    const p = PICS[1];
    const x = (px - p.x) / p.k, y = (py - p.y) / p.k;
    return x >= 0 && y >= 0 && x <= PANEL.w && y <= PANEL.h ? { x, y } : null;
}

function hitSign(px, py) {
    const list = ['map', 'hud'];
    for (let i = 0; i < list.length; i++) {
        const tg = list[i], p = SIGN_PICS[tg], T = SIGN_TARGETS[tg];
        const x = (px - p.x) / p.k, y = (py - p.y) / p.k;
        if (x >= 0 && y >= 0 && x <= T.w && y <= T.h) return { target: tg, x, y };
    }
    return null;
}

function drawSignDisc(cv, cx, cy, R, limit, t, G, dashes) {
    const num = !!limit;
    const on = num || !!dashes;
    cv.circle(cx, cy, R, on ? '#ffffff' : G.withAlpha('#ffffff', 0.25));
    cv.circle(cx, cy, R * 0.93, on ? '#d71920' : G.withAlpha('#ffffff', 0.18));
    cv.circle(cx, cy, R * 0.69, on ? '#ffffff' : (t.bg || '#101418'));
    if (num) {
        const text = String(limit);
        const size = text.length >= 3 ? R * 0.62 : R * 0.78;
        cv.text(text, cx, cy + size * 0.36, size, '#111111', { literal: true, align: 'center', font: 'bold' });
        return;
    }
    const rIn = R * 0.69;
    const spanW = 2 * rIn * 0.72, dashW = spanW / 3.9, gapW = dashW * 0.45;
    const dashH = Math.max(2.5, R * 0.125), rad = Math.max(1, dashH * 0.25);
    const ink = on ? '#111111' : (t.dim || G.withAlpha('#ffffff', 0.4));
    for (let k = -1; k <= 1; k++) {
        const dx = cx + k * (dashW + gapW) - dashW / 2;
        cv.roundRect(dx, cy - dashH / 2, dashW, dashH, rad, ink);
    }
}

function drawCluster(cv, G, t, p, v, editingSide) {
    const k = p.k, X = (x) => p.x + x * k, Y = (y) => p.y + y * k;
    const acc = t.accent2 || '#81c4ff', go = t.go || '#2fd27a', line = G.withAlpha('#ffffff', 0.28);
    cv.roundRect(p.x, p.y, PANEL.w * k, PANEL.h * k, 16, G.withAlpha('#ffffff', 0.04));
    cv.strokeRoundRect(p.x, p.y, PANEL.w * k, PANEL.h * k, 16, 1.5, G.withAlpha('#ffffff', 0.2));
    cv.roundRect(X(MAP.x + 150), Y(MAP.y), (MAP.w - 300) * k, MAP.h * k, 10, G.withAlpha(v.vmcRunning ? go : acc, v.vmcRunning ? 0.14 : 0.07));
    if (!v.frontRect && v.shown !== 'all') {
        cv.text(v.vmcRunning ? 'VIETMAP MÀN GIỮA' : 'BẢN ĐỒ ĐỒNG HỒ', X(PANEL.w / 2), Y(PANEL.h / 2) + 6, 14, G.withAlpha('#ffffff', 0.28), { literal: true, align: 'center', font: 'bold', spacing: 1.5 });
    }
    const r = 300 * k, w = 5;
    cv.arc(X(430), Y(380), r - w, r, 200, 395, line, { round: true });
    cv.arc(X(PANEL.w - 430), Y(380), r - w, r, -35, 160, line, { round: true });
    cv.text('km/h', X(430), Y(170), 12, G.withAlpha('#ffffff', 0.3), { literal: true, align: 'center', font: 'label' });
    cv.text('1/min', X(PANEL.w - 430), Y(170), 12, G.withAlpha('#ffffff', 0.3), { literal: true, align: 'center', font: 'label' });

    if (v.frontRect) {
        const f = v.frontRect, on = v.shown === 'front';
        cv.roundRect(X(f.x), Y(f.y), f.w * k, f.h * k, 8, G.withAlpha(on ? go : '#ffffff', on ? 0.3 : 0.06));
        cv.strokeRoundRect(X(f.x), Y(f.y), f.w * k, f.h * k, 8, on ? 3 : 1.5, on ? go : G.withAlpha('#ffffff', 0.3));
        cv.text('CAMERA TRƯỚC', X(f.x + f.w / 2), Y(f.y + f.h / 2) + 5, 13, on ? '#ffffff' : G.withAlpha('#ffffff', 0.45), { literal: true, align: 'center', font: 'bold', spacing: 1.2 });
    }

    ['left', 'right'].forEach((side) => {
        const d = v.discs && v.discs[side];
        if (!d) return;
        const on = v.shown === side || v.shownAux === side, ed = editingSide === side;
        const c = on ? go : ed ? acc : G.withAlpha('#ffffff', 0.4);
        const cx = X(d.x + d.w / 2), cy = Y(d.y + d.h / 2), rw = d.w * k / 2, rh = d.h * k / 2;
        if (v.round) {
            cv.circle(cx, cy, rw, G.withAlpha(on ? go : ed ? acc : '#ffffff', on ? 0.35 : ed ? 0.2 : 0.08));
            cv.arc(cx, cy, rw - (on || ed ? 3.5 : 2), rw, 0, 360, c);
        } else {
            cv.roundRect(cx - rw, cy - rh, rw * 2, rh * 2, 6, G.withAlpha(on ? go : ed ? acc : '#ffffff', on ? 0.35 : ed ? 0.2 : 0.08));
            cv.strokeRoundRect(cx - rw, cy - rh, rw * 2, rh * 2, 6, on || ed ? 3 : 1.5, c);
        }
        const s = Math.min(rw, rh) * 0.45, dir = side === 'left' ? -1 : 1, ac = on ? '#ffffff' : c;
        cv.quad([[cx + dir * s, cy], [cx, cy - s * 0.8], [cx, cy + s * 0.8], [cx, cy + s * 0.8]], ac);
        cv.quad([[cx + dir, cy - s * 0.35], [cx + dir, cy + s * 0.35], [cx - dir * s, cy + s * 0.35], [cx - dir * s, cy - s * 0.35]], ac);
    });

    if (v.shown === 'all') {
        cv.strokeRoundRect(X(MAP.x + 224), Y(MAP.y), 640 * k, 480 * k, 8, 3, go);
        cv.text('4 CAMERA', X(PANEL.w / 2), Y(MAP.y + 60), 15, go, { literal: true, align: 'center', font: 'bold', spacing: 1.5 });
    }

    // Draw live speed sign on the cluster schematic when enabled!
    if (v.signOn && v.signMap) {
        const sm = v.signMap;
        const sr = Math.max(12, sm.size * k / 2);
        drawSignDisc(cv, X(MAP.x + sm.x + sm.size / 2), Y(MAP.y + sm.y + sm.size / 2), sr, v.signLimit, t, G, v.signDashes);
    }
}

function drawOverview(cv, G, t, v, act) {
    const bottom = G.pageBottom(cv) - (cv.own ? G.MARGIN : 0);
    const go = t.go || '#2fd27a', red = t.crit || '#ef2b2d';
    const p = PICS[0];
    drawCluster(cv, G, t, p, v, null);
    cv.text('Tích hợp đồng bộ Camera xi nhan + Camera trước AR + Biển báo VietMap + Chiếu màn giữa trên 1 dịch vụ duy nhất.',
        p.x, p.y + PANEL.h * p.k + 28, 15, t.dim, { literal: true, font: 'label' });

    const rx = 828;
    cv.text(String(v.title || '').toUpperCase(), rx, G.TOP + 76, 36, v.titleKind === 'go' ? go : v.titleKind === 'warn' ? (t.warn || '#ffb020') : t.text, { literal: true, font: 'bold', spacing: 1.3 });
    if (v.subtitle) cv.text(v.subtitle, rx, G.TOP + 108, 17, t.dim, { literal: true, font: 'label' });
    (v.rows || []).slice(0, 6).forEach((r, i) => {
        const y = G.TOP + 144 + i * 36;
        cv.circle(rx + 8, y - 6, 6.5, kindColor(t, r.kind));
        cv.text(r.label, rx + 28, y, 17, t.text, { literal: true, font: 'bold' });
        cv.text(r.text, rx + 166, y, r.text.length > 48 ? 14.5 : 17, r.kind === 'warn' || r.kind === 'crit' ? kindColor(t, r.kind) : t.dim, { literal: true, font: 'label' });
    });
    if (v.version) cv.text(v.version, W - 52, G.TOP + 32, 14, G.withAlpha('#ffffff', 0.35), { literal: true, align: 'right', font: 'label' });

    const specs = [
        ['Thử trái', act.left, v.shown === 'left', 175],
        ['Thử phải', act.right, v.shown === 'right', 175],
        ['4 cam', act.all, v.shown === 'all', 150],
        ['Cam trước: ' + (v.front || 'tắt'), act.front, v.shown === 'front', 360],
        ['Xi nhan: ' + (v.enabled ? 'Bật' : 'Tắt'), act.toggle, false, 240, v.enabled ? go : red],
        ['Biển báo: ' + (v.signOn ? 'Bật' : 'Tắt'), act.signToggle, false, 250, v.signOn ? go : red],
    ];
    const bh = 52, gap = 14, by = bottom - bh;
    const totalW = specs.reduce((a, s) => a + s[3], 0) + (specs.length - 1) * gap;
    let bx = (W - totalW) / 2;
    specs.forEach((s, i) => {
        const opts = { key: 'ov' + i };
        if (s[2]) Object.assign(opts, { color: go, primary: true });
        else if (s[4]) Object.assign(opts, { color: s[4] });
        G.button(cv, t, bx, by, s[3], bh, s[0], s[1] || nop, opts);
        bx += s[3] + gap;
    });
    return cv;
}

function drawSignsAndMirror(cv, G, t, v, act) {
    const bottom = G.pageBottom(cv) - (cv.own ? G.MARGIN : 0);
    const go = t.go || '#2fd27a', red = t.crit || '#ef2b2d', acc = t.accent2 || '#81c4ff';
    const sr = v.signReport || {};

    // Left column: Speed Sign + Pairing Code Box
    const cx = 250, cy = G.TOP + 132, R = 86;
    drawSignDisc(cv, cx, cy, R, sr.limit || sr.phoneLimit, t, G, sr.dashes && v.signOn);
    const srcLabel = sr.limit
        ? (sr.source === 'camera' ? 'Nguồn: Camera KAFAS BMW' : sr.source === 'phone' ? 'Nguồn: VietMap Live (ĐT)' : sr.source === 'bmwmap' ? 'Nguồn: Bản đồ BMW' : 'Đang hiện trên đồng hồ')
        : sr.dashes && v.signOn ? 'Chưa có biển · hiện --- chuẩn BMW' : 'Chưa có giới hạn tốc độ';
    cv.text(srcLabel, cx, cy + R + 28, 16, t.dim, { literal: true, align: 'center', font: 'label' });

    // Pairing card directly below the sign
    const px = 56, py = G.TOP + 262, pw = 388, ph = 110;
    cv.roundRect(px, py, pw, ph, 14, G.withAlpha('#ffffff', 0.05));
    cv.strokeRoundRect(px, py, pw, ph, 14, 1, G.withAlpha(acc, 0.28));
    cv.text('MÃ GHÉP ĐÔI ĐIỆN THOẠI (UDP 8471)', px + 18, py + 28, 13.5, acc, { literal: true, font: 'bold' });
    cv.text(v.pairCode ? (v.pairCode.slice(0, 3) + ' ' + v.pairCode.slice(3)) : '--- ---', px + 18, py + 76, 40, t.text, { literal: true, font: 'bold', spacing: 3 });
    G.button(cv, t, px + pw - 134, py + 40, 118, 48, 'Đổi mã', act.newCode || nop, { key: 'vmNewCode' });

    // Right column: Detailed diagnostics & Center-screen mirror status
    const rx = 488;
    cv.text(v.signOn ? 'BIỂN BÁO ĐANG BẬT' : 'BIỂN BÁO ĐANG TẮT', rx, G.TOP + 72, 34, v.signOn ? go : t.dim, { literal: true, font: 'bold', spacing: 1.2 });
    cv.text('Vùng hiện: ' + (v.signShowLabel || '') + '  ·  Khi trống: ' + (v.signEmpty === 'hide' ? 'Ẩn biển' : 'Hiện --- giống BMW'), rx, G.TOP + 104, 18, t.text, { literal: true, font: 'label' });

    (sr.lines || []).slice(0, 7).forEach((l, i) => {
        const y = G.TOP + 144 + i * 31;
        cv.circle(rx + 8, y - 6, 6, kindColor(t, l.kind));
        cv.text(l.text, rx + 26, y, 17.5, l.kind === 'warn' ? (t.warn || '#ffb020') : l.kind === 'go' ? go : t.dim, { literal: true, font: 'label' });
    });

    if (sr.note) {
        cv.text(sr.note, rx, G.TOP + 372, 16.5, kindColor(t, sr.noteKind), { literal: true, font: 'label' });
    }

    const specs = [
        ['Biển báo: ' + (v.signOn ? 'Bật' : 'Tắt'), act.signToggle, v.signOn, 240, v.signOn ? go : red],
        ['Hiện: ' + (v.signShowShort || ''), act.signShowCycle, false, 270],
        ['Trống: ' + (v.signEmpty === 'hide' ? 'Ẩn' : '---'), act.signEmptyCycle, false, 200],
        ['Chiếu màn giữa: ' + (v.vmcOn ? 'Bật' : 'Tắt'), act.vmcToggle, v.vmcOn, 310, v.vmcOn ? go : null],
        ['Khung: ' + (v.vmcViewLabel || 'Toàn bản đồ'), act.vmcViewCycle, false, 330],
    ];
    const bh = 52, gap = 14, by = bottom - bh;
    const totalW = specs.reduce((a, s) => a + s[3], 0) + (specs.length - 1) * gap;
    let bx = (W - totalW) / 2;
    specs.forEach((s, i) => {
        const opts = { key: 'sm' + i };
        if (s[4]) Object.assign(opts, { color: s[4], primary: !!s[2] });
        G.button(cv, t, bx, by, s[3], bh, s[0], s[1] || nop, opts);
        bx += s[3] + gap;
    });
    return cv;
}

function drawPosition(cv, G, t, v, act) {
    const acc = t.accent2 || '#81c4ff', go = t.go || '#2fd27a';
    const bx = 1094, bw = 138, bh = 48, gap = 14, y0 = G.TOP + 36;

    G.button(cv, t, bx, y0, 444, bh, 'Đối tượng: ' + (v.posMode === 'sign' ? 'Biển tốc độ' : 'Camera gương'), act.posModeToggle || nop, { key: 'pmMode', color: acc, primary: true });

    if (v.posMode === 'sign') {
        cv.text(v.signDragging ? 'Đang kéo biển trực tiếp trên đồng hồ · thả tay để lưu' : 'Kéo biển tốc độ bằng ngón tay hoặc chạm vào khung Đồng hồ / HUD bên dưới để đặt tâm biển.',
            52, G.TOP + 36, 17, v.signDragging ? acc : t.dim, { literal: true, font: 'label' });
        ['map', 'hud'].forEach((tg) => {
            const p = SIGN_PICS[tg], T = SIGN_TARGETS[tg], g = tg === 'map' ? v.signMap : v.signHud, on = v.signEditing === tg;
            const w = T.w * p.k, h = T.h * p.k;
            cv.text(tg === 'map' ? 'Vùng bản đồ đồng hồ' : 'Kính lái HUD', p.x, p.y - 12, 17, on ? acc : t.text, { literal: true, font: 'bold' });
            cv.roundRect(p.x, p.y, w, h, 8, G.withAlpha('#ffffff', 0.05));
            if (tg === 'map') {
                cv.roundRect(p.x + 120 * p.k, p.y, (T.w - 240) * p.k, h, 8, G.withAlpha('#ffffff', 0.06));
            } else {
                const seen = { x: 80, y: 90, w: 640, h: 300 };
                cv.roundRect(p.x + seen.x * p.k, p.y + seen.y * p.k, seen.w * p.k, seen.h * p.k, 6, G.withAlpha('#ffffff', 0.08));
                const box = v.hudBox;
                if (box) cv.strokeRoundRect(p.x + box.x * p.k, p.y + box.y * p.k, box.w * p.k, box.h * p.k, 4, 1.5, G.withAlpha(acc, 0.5));
            }
            cv.strokeRoundRect(p.x, p.y, w, h, 8, on ? 3 : 1.5, on ? acc : G.withAlpha('#ffffff', 0.25));
            if (g) {
                drawSignDisc(cv, p.x + (g.x + g.size / 2) * p.k, p.y + (g.y + g.size / 2) * p.k, g.size * p.k / 2, v.signLimit || 60, t, G, false);
                cv.text((g.placed ? 'Tự đặt' : 'Mặc định') + ' · ' + g.x + ', ' + g.y + ' · cỡ ' + g.size + ' px', p.x, p.y + h + 26, 15.5, t.dim, { literal: true, font: 'label' });
            }
        });
        G.button(cv, t, bx, y0 + 62, 444, bh, 'Đang chỉnh: ' + (v.signEditing === 'map' ? 'Đồng hồ' : 'HUD'), act.signTargetToggle || nop, { key: 'psEd' });
        G.button(cv, t, bx + bw + gap, y0 + 126, bw, bh, 'Lên', act.signUp || nop, { key: 'psUp' });
        G.button(cv, t, bx, y0 + 186, bw, bh, 'Trái', act.signLeft || nop, { key: 'psL' });
        G.button(cv, t, bx + 2 * (bw + gap), y0 + 186, bw, bh, 'Phải', act.signRight || nop, { key: 'psR' });
        G.button(cv, t, bx + bw + gap, y0 + 246, bw, bh, 'Xuống', act.signDown || nop, { key: 'psDn' });
        G.button(cv, t, bx, y0 + 314, 215, bh, 'Cỡ biển: ' + (v.signSizeLabel || ''), act.signSizeCycle || nop, { key: 'psSz' });
        G.button(cv, t, bx + 229, y0 + 314, 215, bh, 'Về mặc định', act.signPosReset || nop, { key: 'psRs' });
        if (v.signPosNote) cv.text(v.signPosNote, 52, G.TOP + 424, 16, go, { literal: true, font: 'label' });
        return cv;
    }

    const p = PICS[1];
    cv.text('Kéo vòng camera hoặc chạm vào hình để đặt camera ' + (v.edit === 'left' ? 'TRÁI' : 'PHẢI') + '. Đồng hồ xe hiện trực tiếp.',
        p.x, G.TOP + 34, 17, t.dim, { literal: true, font: 'label' });
    drawCluster(cv, G, t, p, v, v.edit);
    const d = v.discs && v.discs[v.edit];
    if (d) {
        cv.text((v.gauge ? 'Trong vòng đồng hồ' : 'Vị trí cố định') + ' · ' + Math.round(d.x + d.w / 2) + ', ' + Math.round(d.y + d.h / 2) + ' · ' + (v.sizeLabel || ''),
            p.x, p.y + PANEL.h * p.k + 26, 15.5, t.dim, { literal: true, font: 'label' });
    }
    if (v.note) cv.text(v.note, p.x + PANEL.w * p.k, p.y + PANEL.h * p.k + 26, 15.5, kindColor(t, v.noteKind), { literal: true, align: 'right', font: 'label' });

    G.button(cv, t, bx, y0 + 62, 444, bh, 'Đang chỉnh: ' + (v.edit === 'left' ? 'Gương trái' : 'Gương phải'), act.side || nop, { key: 'xcSide' });
    G.button(cv, t, bx + bw + gap, y0 + 126, bw, bh, 'Lên', act.up || nop, { key: 'xcUp' });
    G.button(cv, t, bx, y0 + 186, bw, bh, v.edit === 'left' ? 'Ra ngoài' : 'Vào giữa', act.moveLeft || nop, { key: 'xcL' });
    G.button(cv, t, bx + 2 * (bw + gap), y0 + 186, bw, bh, v.edit === 'left' ? 'Vào giữa' : 'Ra ngoài', act.moveRight || nop, { key: 'xcR' });
    G.button(cv, t, bx + bw + gap, y0 + 246, bw, bh, 'Xuống', act.down || nop, { key: 'xcDn' });
    G.button(cv, t, bx, y0 + 314, 215, bh, 'Nhỏ hơn', act.smaller || nop, { key: 'xcSm' });
    G.button(cv, t, bx + 229, y0 + 314, 215, bh, 'Lớn hơn', act.larger || nop, { key: 'xcLg' });
    G.button(cv, t, bx, y0 + 374, 215, bh, v.round ? 'Hình: Tròn' : 'Hình: Chữ nhật', act.shape || nop, { key: 'xcSh' });
    G.button(cv, t, bx + 229, y0 + 374, 215, bh, 'Mặc định', act.reset || nop, { key: 'xcRs' });
    return cv;
}

function drawCalibrate(cv, G, t, v, act) {
    const acc = t.accent2 || '#81c4ff', go = t.go || '#2fd27a';
    const x0 = 56, y0 = G.TOP + 24;
    [['left', 'Gương trái', act.camL], ['right', 'Gương phải', act.camR], ['front', 'Camera trước', act.camF]].forEach((b, i) => {
        const on = v.calCam === b[0];
        G.button(cv, t, x0 + i * 256, y0, 240, 50, b[1], b[2] || nop, on ? { key: 'cc' + i, color: go, primary: true } : { key: 'cc' + i });
    });
    if (v.note) cv.text(v.note, x0 + 3 * 256 + 16, y0 + 32, 16, kindColor(t, v.noteKind), { literal: true, font: 'label' });
    G.button(cv, t, W - 56 - 220, y0, 220, 50, 'Mặc định', act.calReset || nop, { key: 'ccReset' });
    const ty = y0 + 92;
    if (v.calCam === 'front') {
        cv.text('Đậu xe trên đường thẳng, phẳng. Chỉnh đến khi hai vạch vàng nằm trên mép làn (rộng 3 m) và các vạch ngang đúng 5, 10, 20 m.',
            x0, ty, 17, t.dim, { literal: true, font: 'label' });
        (v.calRows || []).forEach((r, i) => {
            const col = i < 4 ? 0 : 1, row = i < 4 ? i : i - 4;
            const x = x0 + col * 760, y = ty + 30 + row * 72;
            cv.roundRect(x, y, 728, 60, 12, G.withAlpha('#ffffff', 0.05));
            cv.text(r.label, x + 20, y + 38, 19, t.text, { literal: true, font: 'bold' });
            cv.text(r.text, x + 440, y + 38, 22, acc, { literal: true, font: 'bold', align: 'right' });
            G.button(cv, t, x + 470, y + 6, 112, 48, 'Giảm', act[r.key + '-'] || nop, { key: 'cm' + i });
            G.button(cv, t, x + 598, y + 6, 112, 48, 'Tăng', act[r.key + '+'] || nop, { key: 'cp' + i });
        });
        return cv;
    }
    cv.text('Camera ' + (v.calCam === 'left' ? 'gương trái' : 'gương phải') + ' đang hiện trên đồng hồ. Dịch vùng cắt đến đúng điểm mù phía sau, rồi phóng to nếu muốn.',
        x0, ty, 17, t.dim, { literal: true, font: 'label' });
    const bw = 220, bh = 56, gx = 20, cx = x0 + 240, cy = ty + 44;
    G.button(cv, t, cx + bw + gx, cy, bw, bh, 'Nhìn lên', act.panU || nop, { key: 'cU' });
    G.button(cv, t, cx, cy + 76, bw, bh, 'Sang trái', act.panL || nop, { key: 'cL' });
    G.button(cv, t, cx + 2 * (bw + gx), cy + 76, bw, bh, 'Sang phải', act.panR || nop, { key: 'cR' });
    G.button(cv, t, cx + bw + gx, cy + 152, bw, bh, 'Nhìn xuống', act.panD || nop, { key: 'cD' });
    G.button(cv, t, cx + 3 * (bw + gx) + 60, cy + 38, bw, bh, 'Phóng to', act.zoomIn || nop, { key: 'cZi' });
    G.button(cv, t, cx + 3 * (bw + gx) + 60, cy + 114, bw, bh, 'Thu nhỏ', act.zoomOut || nop, { key: 'cZo' });
    if (v.calText) cv.text(v.calText, x0, cy + 260, 18, acc, { literal: true, font: 'label' });
    cv.text('Hướng nhìn chung (chếch về sau / ngang / chếch về trước) nằm trong Cài đặt; trang này tinh chỉnh riêng từng gương.', x0, cy + 296, 16, t.dim, { literal: true, font: 'label' });
    return cv;
}

function drawNav(cv, G, t, v, act) {
    const go = t.go || '#2fd27a';
    const x0 = 56, y0 = G.TOP + 44;
    cv.text('MŨI TÊN AR DẪN ĐƯỜNG TRÊN CAMERA TRƯỚC', x0, y0, 26, t.text, { literal: true, font: 'bold', spacing: 1.2 });
    cv.text('Khi bản đồ BMW, Apple CarPlay hoặc Android Auto đang dẫn đường, camera trước tự hiện ở ngã rẽ kèm dải mũi tên AR và biển tốc độ.',
        x0, y0 + 34, 17, t.dim, { literal: true, font: 'label' });
    (v.navRows || []).forEach((r, i) => {
        const y = y0 + 92 + i * 46;
        cv.circle(x0 + 8, y - 7, 7, kindColor(t, r.kind));
        cv.text(r.label, x0 + 30, y, 18, t.text, { literal: true, font: 'bold' });
        cv.text(r.text, x0 + 220, y, 18, r.kind === 'warn' ? kindColor(t, r.kind) : t.dim, { literal: true, font: 'label' });
    });
    const by = G.pageBottom(cv) - (cv.own ? G.MARGIN : 0) - 58;
    G.button(cv, t, x0, by, 520, 54, 'Hiện mũi tên: ' + String(v.arLabel || '').toLowerCase(), act.arMode || nop, { key: 'nvMode' });
    G.button(cv, t, x0 + 540, by, 300, 54, 'Thẻ rẽ: ' + (v.arCard ? 'hiện' : 'ẩn'), act.arCard || nop, { key: 'nvCard' });
    G.button(cv, t, x0 + 860, by, 380, 54, v.demo ? 'Đang xem thử (bấm để tắt)' : 'Xem thử 25 giây', act.demo || nop, v.demo ? { key: 'nvDemo', color: go, primary: true } : { key: 'nvDemo' });
    return cv;
}

function draw(cv, G, t, v, act) {
    act = act || {};
    cv.clear(t.bg);
    G.frame(cv, t, TABS, v.page || 0, []);
    G.panel(cv, t, 24, G.TOP, W - 48, G.BOTTOM - G.TOP, null);
    if (v.page === 1) return drawSignsAndMirror(cv, G, t, v, act);
    if (v.page === 2) return drawPosition(cv, G, t, v, act);
    if (v.page === 3) return drawCalibrate(cv, G, t, v, act);
    if (v.page === 4) return drawNav(cv, G, t, v, act);
    return drawOverview(cv, G, t, v, act);
}

module.exports = { draw, hitCluster, hitSign, drawSignDisc, W, H, TABS, STEP, PICS, SIGN_PICS, SIGN_TARGETS, PANEL, MAP };
