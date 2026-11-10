/* Wimbleton scene renderer. Reads the global S (state from /api/state) and draws the tower cutaway.
   All positions are in "grid units" (1 unit = one room-height) so layout survives resizing. */
(() => {
const cv = document.getElementById('cv'), ctx = cv.getContext('2d');
let W = 0, H = 0, DPR = 1;
function fit() { const r = cv.getBoundingClientRect(); DPR = devicePixelRatio || 1; W = r.width; H = r.height; cv.width = Math.max(1, W * DPR); cv.height = Math.max(1, H * DPR); }
addEventListener('resize', fit); new ResizeObserver(fit).observe(cv); fit();

const hash = s => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const rnd = s => (hash(s) % 10000) / 10000;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const mixc = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const rgb = (c, a) => a === undefined ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const WS = 0.62;                                    // wizard height in grid units

// ------------------------------------------------------------------ layout
const L = { u: 100, u0: 100, uq: 100, ox: 0, oy: 0, byId: {}, groundY: 0, sky: 0, maxy: 0, minx: 0, maxx: 0, miny: 0 };
const X = gx => L.ox + gx * L.u, Y = gy => L.oy + gy * L.u;
// camera: mode 'follow' (tracks the wizard), 'free' (you panned it), 'fit' (whole world in view)
const cam = { mode: 'follow', u: 0, fx: 0, fy: 0, tu: 0, followU: 0, init: false };
try { const m = localStorage.getItem('wimbleton.cam'); if (m === 'fit' || m === 'follow') cam.mode = m; } catch (e) {}
{ const q = new URLSearchParams(location.search).get('cam'); if (q === 'fit' || q === 'follow') cam.mode = q; }
cam.pendingFocus = new URLSearchParams(location.search).get('focus');
function setMode(m) { cam.mode = m; if (m !== 'free') { try { localStorage.setItem('wimbleton.cam', m); } catch (e) {} } syncButtons(); }
function layout(dt) {
  const P = S.places; L.byId = {}; P.forEach(p => L.byId[p.id] = p);
  const minx = Math.min(...P.map(p => p.x)), maxx = Math.max(...P.map(p => p.x + p.w));
  const miny = Math.min(...P.map(p => p.y)), maxy = Math.max(...P.map(p => p.y + p.h));
  const ground = H * 0.86;
  L.u0 = Math.min((W - 40) / (maxx - minx), (ground - 28) / (maxy - miny));
  L.minx = minx; L.maxx = maxx; L.miny = miny; L.maxy = maxy;
  if (cam.pendingFocus && L.byId[cam.pendingFocus]) {                      // ?focus=<place id>: open the camera on a place
    const q = L.byId[cam.pendingFocus]; cam.pendingFocus = null; cam.mode = 'free'; cam.fx = q.x + q.w / 2; cam.fy = q.y + q.h * 0.5;
    cam.u = cam.tu = cam.followU = clamp(H * 0.3, 110, 200); cam.init = true; syncButtons();
  }
  const f0x = (minx + maxx) / 2, f0y = (H / 2 - (ground - maxy * L.u0)) / L.u0;      // focus of the "fit" view
  if (!cam.followU) cam.followU = clamp(H * 0.3, 110, 200);
  let tu, tx, ty;
  if (cam.mode === 'fit') { tu = L.u0; tx = f0x; ty = f0y; }
  else if (cam.mode === 'follow') { tu = cam.followU; tx = wiz.x + wiz.face * 0.25; ty = wiz.y - 0.5; }
  else { tu = cam.tu || cam.u; tx = cam.fx; ty = cam.fy; }
  cam.tu = tu;
  if (!cam.init) { if (wiz.room !== null || cam.mode === 'fit') { cam.u = tu; cam.fx = tx; cam.fy = ty; cam.init = true; } else { cam.u = L.u0; cam.fx = f0x; cam.fy = f0y; } }
  else { const k = 1 - Math.exp(-dt * (cam.mode === 'follow' ? 3.2 : 6)); cam.u += (tu - cam.u) * k; if (cam.mode !== 'free') { cam.fx += (tx - cam.fx) * k; cam.fy += (ty - cam.fy) * k; } }
  if (cam.mode !== 'fit') { cam.fx = clamp(cam.fx, minx - 1.5, maxx + 1.5); cam.fy = clamp(cam.fy, miny - 0.6, maxy + 1.2); }
  L.u = cam.u; L.ox = W / 2 - cam.fx * L.u; L.oy = H / 2 - cam.fy * L.u;
  L.uq = Math.min(360, Math.ceil(L.u / 40) * 40);                                        // room backgrounds are cached at stepped sizes
  L.groundY = Y(maxy); L.sky = clamp(L.groundY, H * 0.5, H);
}
const floorY = p => p.y + p.h - 0.1;                // floor line in grid units
function exitFrac(p, q) {
  if (q.y !== p.y) return 0.14 + 0.72 * rnd([p.id, q.id].sort().join('|'));
  return q.x < p.x ? 0.045 : 0.955;
}
const exitPt = (p, q) => ({ x: p.x + p.w * exitFrac(p, q), y: floorY(p) });
const isIndoor = p => !p.outdoor;

// ------------------------------------------------------------------ time / sky
function dayInfo() {
  const q = new URLSearchParams(location.search).get('hour'), hr = q !== null ? +q : S.hour, el = Math.sin((hr - 6) / 12 * Math.PI);
  return { hr, el, dl: clamp(el * 1.7 + 0.3, 0, 1), warm: clamp(1 - Math.abs(el) * 3.2, 0, 1) };
}
function drawSky(T, D) {
  const top = mixc([6, 5, 24], [64, 118, 214], D.dl), bot = mixc([24, 15, 48], [176, 208, 242], D.dl);
  const botW = D.warm > 0 ? mixc(bot, [244, 136, 92], D.warm * 0.75) : bot;
  const g = ctx.createLinearGradient(0, 0, 0, L.sky); g.addColorStop(0, rgb(top)); g.addColorStop(1, rgb(botW));
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  if (D.dl < 0.6) {                                  // stars
    for (let i = 0; i < 110; i++) {
      const x = rnd('sx' + i) * W, y = rnd('sy' + i) * L.sky * 0.8, tw = 0.5 + 0.5 * Math.sin(T / 700 + i * 3.1);
      ctx.fillStyle = `rgba(255,255,240,${(0.85 - D.dl * 1.4) * (0.4 + 0.6 * tw)})`; const s = 1 + (i % 7 === 0);
      ctx.fillRect(x, y, s, s);
    }
  }
  const body = (h, r, col, glow) => {
    const e = Math.sin((h - 6) / 12 * Math.PI); if (e < -0.05) return;
    const x = W * (0.08 + 0.84 * ((h - 6) / 12)), y = lerp(L.sky - 10, H * 0.1, clamp(e, 0, 1));
    const rg = ctx.createRadialGradient(x, y, r * 0.5, x, y, r * 4.5); rg.addColorStop(0, rgb(glow, 0.55)); rg.addColorStop(1, rgb(glow, 0));
    ctx.fillStyle = rg; ctx.fillRect(x - r * 5, y - r * 5, r * 10, r * 10);
    ctx.fillStyle = rgb(col); ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  };
  body(D.hr, 24, [255, 236, 170], [255, 214, 120]);
  body(((D.hr + 12) % 24), 17, [236, 240, 255], [150, 170, 255]);
  // clouds
  for (let i = 0; i < 6; i++) {
    const sp = 6 + i * 2.5, x = ((T / 1000 * sp + i * 260) % (W + 300)) - 150, y = L.sky * (0.1 + 0.5 * rnd('cy' + i)), s = 0.7 + rnd('cs' + i) * 0.9;
    const c = mixc([58, 54, 92], [255, 255, 255], D.dl), a = 0.22 + 0.4 * D.dl;
    ctx.fillStyle = rgb(c, a);
    for (const [dx, dy, r] of [[0, 0, 26], [28, -8, 32], [60, 0, 26], [30, 8, 28]]) { ctx.beginPath(); ctx.ellipse(x + dx * s, y + dy * s, r * s * 1.2, r * s * 0.7, 0, 0, 7); ctx.fill(); }
  }
  // far hills + trees
  for (const [k, col, amp, base] of [[0, [34, 52, 74], 40, 0.0], [1, [24, 52, 44], 28, 0.0]]) {
    const c = mixc(mixc(col, [8, 12, 24], 0.55), col, D.dl);
    if (L.groundY - 36 - amp * 1.5 > H) continue;
    const po = L.ox * (0.25 + 0.15 * k);
    ctx.fillStyle = rgb(c); ctx.beginPath(); ctx.moveTo(0, H + 60);
    for (let x = 0; x <= W; x += 14) { const xx = x - po; ctx.lineTo(x, L.groundY - 36 - amp * (0.5 + 0.5 * Math.sin(xx / (170 + k * 90) + k * 2)) - 14 * Math.sin(xx / 53 + k)); }
    ctx.lineTo(W, H + 60); ctx.fill();
  }
}
function drawGround(T, D) {
  if (L.groundY >= H) return;
  const g = ctx.createLinearGradient(0, L.groundY - 4, 0, Math.max(H, L.groundY + 40));
  g.addColorStop(0, rgb(mixc([14, 34, 28], [66, 130, 62], D.dl))); g.addColorStop(1, rgb(mixc([6, 16, 14], [38, 88, 44], D.dl)));
  ctx.fillStyle = g; ctx.fillRect(0, L.groundY - 3, W, H - L.groundY + 3);
  const span = W * 1.6;
  ctx.strokeStyle = rgb(mixc([18, 44, 34], [90, 160, 80], D.dl), 0.8); ctx.lineWidth = 1.3;
  for (let i = 0; i < 120; i++) {                     // grass tufts, scrolling with the camera
    const x = (((rnd('gx' + i) * span + L.ox) % span) + span) % span - W * 0.3, y = L.groundY + 6 + rnd('gy' + i) * (H - L.groundY - 8), sway = Math.sin(T / 600 + i) * 2;
    if (x < -10 || x > W + 10 || y > H) continue;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + sway - 3, y - 7); ctx.moveTo(x, y); ctx.lineTo(x + sway + 3, y - 6); ctx.stroke();
  }
  for (let i = 0; i < 16; i++) {                      // pines beyond the edges of the world, in world space
    const gx = i % 2 ? L.maxx + 0.6 + rnd('pr' + i) * 4 : L.minx - 0.6 - rnd('pl' + i) * 4, x = X(gx);
    if (x < -60 || x > W + 60) continue;
    const sc = L.u / 100, h = (70 + rnd('t' + i) * 50) * sc, c = mixc([10, 30, 26], [30, 84, 52], D.dl), gy = L.groundY;
    ctx.fillStyle = '#3a2a1e'; ctx.fillRect(x - 3 * sc, gy - 10 * sc, 6 * sc, 14 * sc);
    for (let k = 0; k < 4; k++) { ctx.fillStyle = rgb(mixc(c, [0, 0, 0], k * 0.07)); ctx.beginPath(); const w = (34 - k * 6) * sc, y = gy - 10 * sc - k * h / 5; ctx.moveTo(x - w, y); ctx.lineTo(x, y - h / 3); ctx.lineTo(x + w, y); ctx.fill(); }
  }
}

// ------------------------------------------------------------------ rooms (cached backgrounds)
const cache = new Map();
const PAL = [[62, 48, 90], [74, 54, 70], [48, 60, 92], [70, 60, 50], [46, 66, 76]];
function drawTrees(g, p, w, h, fl) {
  const glade = p.biome === 'glade', base = h - fl * 1.2;
  const bg = g.createLinearGradient(0, 0, 0, h);
  if (glade) { bg.addColorStop(0, 'rgba(18,30,64,.6)'); bg.addColorStop(1, 'rgba(30,70,80,.15)'); } else { bg.addColorStop(0, 'rgba(8,24,18,.85)'); bg.addColorStop(1, 'rgba(12,38,24,.5)'); }
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  if (glade) { const mg = g.createRadialGradient(w * 0.5, h * 0.22, 4, w * 0.5, h * 0.22, h * 0.5); mg.addColorStop(0, 'rgba(230,240,255,.55)'); mg.addColorStop(1, 'rgba(230,240,255,0)'); g.fillStyle = mg; g.fillRect(0, 0, w, h); }
  const n = Math.max(4, Math.round(w / (h * (glade ? 0.45 : 0.22))));
  for (let layer = 0; layer < 2; layer++) for (let i = 0; i < n; i++) {
    const x = (i + rnd(p.id + 'tx' + layer + i)) * w / n, th = h * (glade ? 0.4 : 0.6 + 0.3 * rnd(p.id + 'th' + layer + i)) * (layer ? 0.8 : 1), tw = h * 0.055 * (layer ? 0.8 : 1), dk = layer ? 0.55 : 1;
    g.fillStyle = `rgb(${(40 * dk) | 0},${(28 * dk) | 0},${(20 * dk) | 0})`; g.fillRect(x - tw / 2, base - th * 0.55, tw, th * 0.55 + 4);
    for (let k = 0; k < 4; k++) {
      const cw = h * (0.2 - k * 0.032) * (layer ? 0.85 : 1), cy = base - th * 0.35 - k * th * 0.2;
      g.fillStyle = `rgb(${((18 + k * 5) * dk) | 0},${((58 + k * 9) * dk) | 0},${((36 + k * 4) * dk) | 0})`; g.beginPath(); g.moveTo(x - cw, cy); g.lineTo(x, cy - th * 0.32); g.lineTo(x + cw, cy); g.fill();
    }
  }
}
function roomBG(p, w, h, platform) {
  const farm = !!p.outdoor && p.items.some(i => i.kind === 'plot');
  const key = [p.id, Math.round(w), Math.round(h), p.outdoor, platform, farm, p.biome, p.style, DPR].join('|');
  if (cache.has(key)) return cache.get(key);
  const c = document.createElement('canvas'); c.width = Math.ceil(w * DPR); c.height = Math.ceil(h * DPR);
  const g = c.getContext('2d'); g.scale(DPR, DPR);
  const fl = h * 0.1;
  if (isIndoor(p)) {
    const pal = PAL[hash(p.id) % PAL.length];
    const wg = g.createLinearGradient(0, 0, 0, h); wg.addColorStop(0, rgb(mixc(pal, [255, 255, 255], 0.06))); wg.addColorStop(1, rgb(mixc(pal, [0, 0, 0], 0.35)));
    g.fillStyle = wg; g.fillRect(0, 0, w, h);
    const bh = Math.max(8, h * 0.07), bw = bh * 2.4;       // bricks
    for (let r = 0, y = 0; y < h - fl; y += bh, r++) for (let x = (r % 2 ? -bw / 2 : 0); x < w; x += bw) {
      const k = 0.86 + rnd(p.id + r + ':' + Math.round(x)) * 0.28;
      g.fillStyle = `rgba(${Math.min(255, pal[0] * k) | 0},${Math.min(255, pal[1] * k) | 0},${Math.min(255, pal[2] * k) | 0},0.34)`; g.fillRect(x + 1, y + 1, bw - 2, bh - 2);
    }
    if (p.style === 'wood') {                                              // plank walls
      const pw = Math.max(10, w / 16), top = h * 0.055;
      for (let x = 0, i = 0; x < w; x += pw, i++) {
        const k = 0.85 + rnd(p.id + 'pl' + i) * 0.3; g.fillStyle = `rgb(${(128 * k) | 0},${(90 * k) | 0},${(56 * k) | 0})`; g.fillRect(x, top, pw - 1, h - fl - top);
        g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(x + pw - 1, top, 1, h - fl - top);
        g.strokeStyle = 'rgba(60,36,18,.35)'; g.lineWidth = 1; for (let j = 0; j < 3; j++) { const gx = x + pw * (0.2 + 0.3 * j); g.beginPath(); g.moveTo(gx, top); g.bezierCurveTo(gx + 3, h * 0.3, gx - 3, h * 0.6, gx, h - fl); g.stroke(); }
      }
    }
    g.fillStyle = '#2a1d16'; g.fillRect(0, 0, w, h * 0.055); g.fillStyle = '#3d2a1f'; g.fillRect(0, h * 0.055, w, 2);   // ceiling beam
    for (let i = 1; i < 4; i++) { g.fillStyle = '#2f2118'; g.fillRect(w * i / 4 - 4, 0, 8, h * 0.07); }
    const fg = g.createLinearGradient(0, h - fl, 0, h); fg.addColorStop(0, '#5a3f2b'); fg.addColorStop(1, '#2d1f15');   // floor boards
    g.fillStyle = fg; g.fillRect(0, h - fl, w, fl); g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(0, h - fl, w, 2);
    g.strokeStyle = 'rgba(0,0,0,.3)'; for (let x = 0; x < w; x += w / 9) { g.beginPath(); g.moveTo(x, h - fl); g.lineTo(x - 6, h); g.stroke(); }
    for (const [x0, x1, d] of [[0, 1, 1], [1, 0, -1]]) {                  // inner shadow
      const sg = g.createLinearGradient(w * x0, 0, w * x0 + d * w * 0.16, 0); sg.addColorStop(0, 'rgba(0,0,0,.5)'); sg.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = sg; g.fillRect(d > 0 ? 0 : w * 0.84, 0, w * 0.16, h);
    }
    g.strokeStyle = '#1a1226'; g.lineWidth = 5; g.strokeRect(0, 0, w, h);
    g.strokeStyle = 'rgba(190,170,240,.18)'; g.lineWidth = 1; g.strokeRect(3, 3, w - 6, h - 6);
  } else {
    const gg = g.createLinearGradient(0, h - fl * 1.4, 0, h);
    if (platform) {                                                       // stone roof platform with merlons
      gg.addColorStop(0, '#6a6076'); gg.addColorStop(1, '#3a3345'); g.fillStyle = gg; g.fillRect(0, h - fl * 1.4, w, fl * 1.4);
      g.fillStyle = '#7a708a'; const m = Math.max(10, w / 16);
      for (let x = 0; x < w; x += m * 2) g.fillRect(x + 2, h - fl * 1.4 - h * 0.1, m, h * 0.1);
      g.fillStyle = 'rgba(0,0,0,.25)'; for (let x = 0; x < w; x += m * 2) g.fillRect(x + m + 2, h - fl * 1.4 - h * 0.1, m, 2);
      g.fillStyle = '#4a4058'; g.fillRect(0, h - fl * 1.4 - h * 0.1, 6, h * 0.1 + fl * 1.4); g.fillRect(w - 6, h - fl * 1.4 - h * 0.1, 6, h * 0.1 + fl * 1.4);
    } else {
      if (p.biome) drawTrees(g, p, w, h, fl);
      const fo = p.biome === 'forest', gl = p.biome === 'glade';
      gg.addColorStop(0, fo ? '#1f4a2a' : gl ? '#3b7a6a' : '#2f6b3a'); gg.addColorStop(1, fo ? '#10301a' : gl ? '#245a50' : '#1c4426'); g.fillStyle = gg; g.fillRect(0, h - fl * 1.2, w, fl * 1.2);
      if (farm) {                                                       // wooden fence along the back of the field
        const top = h - fl * 1.2, ph = h * 0.15, n = Math.max(4, Math.round(w / (h * 0.2)));
        g.fillStyle = '#7a5a3a'; for (const ry of [0.35, 0.7]) g.fillRect(0, top - ph * ry - 2, w, 4);
        for (let i = 0; i <= n; i++) { const x = i * w / n; g.fillStyle = '#8a6844'; g.fillRect(x - 3, top - ph, 6, ph + 3); g.fillStyle = '#5c4228'; g.fillRect(x + 1, top - ph, 2, ph + 3); }
      }
      for (let i = 0; i < 26; i++) { const x = rnd(p.id + 'f' + i) * w, y = h - fl * 1.1 + rnd(p.id + 'g' + i) * fl;
        g.fillStyle = ['#ffd96a', '#ff9bd0', '#ffffff', '#a8c8ff'][i % 4]; g.beginPath(); g.arc(x, y, 2, 0, 7); g.fill(); g.strokeStyle = '#2f8a44'; g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + 5); g.stroke(); }
    }
  }
  cache.set(key, c); if (cache.size > 160) cache.delete(cache.keys().next().value);
  return c;
}

function torchPoints(p) { const n = 1 + hash(p.id + 't') % 2; return Array.from({ length: n }, (_, i) => 0.2 + 0.6 * rnd(p.id + 'torch' + i)); }

function flame(x, y, s, T, seed) {
  const f = 0.85 + 0.15 * Math.sin(T / 90 + seed * 7) + 0.07 * Math.sin(T / 37 + seed);
  ctx.fillStyle = '#3a2a22'; ctx.fillRect(x - s * 0.1, y, s * 0.2, s * 0.8);
  ctx.fillStyle = '#ff7a2a'; ctx.beginPath(); ctx.moveTo(x - s * 0.22, y); ctx.quadraticCurveTo(x - s * 0.3, y - s * 0.6 * f, x, y - s * 1.1 * f); ctx.quadraticCurveTo(x + s * 0.3, y - s * 0.6 * f, x + s * 0.22, y); ctx.fill();
  ctx.fillStyle = '#ffd86a'; ctx.beginPath(); ctx.moveTo(x - s * 0.1, y); ctx.quadraticCurveTo(x - s * 0.12, y - s * 0.4 * f, x, y - s * 0.65 * f); ctx.quadraticCurveTo(x + s * 0.12, y - s * 0.4 * f, x + s * 0.1, y); ctx.fill();
}
function glowAt(x, y, r, col, a) {
  const rg = ctx.createRadialGradient(x, y, 0, x, y, r); rg.addColorStop(0, rgb(col, a)); rg.addColorStop(1, rgb(col, 0));
  ctx.fillStyle = rg; ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

function drawWindow(p, px, py, w, h, D) {
  const wx = px + w * (0.28 + 0.4 * rnd(p.id + 'win')), ww = h * 0.2, wy = py + h * 0.17, wh = h * 0.36;
  ctx.save(); ctx.beginPath(); ctx.moveTo(wx - ww / 2, wy + wh); ctx.lineTo(wx - ww / 2, wy + ww / 2); ctx.arc(wx, wy + ww / 2, ww / 2, Math.PI, 0); ctx.lineTo(wx + ww / 2, wy + wh); ctx.closePath(); ctx.clip();
  const top = mixc([6, 5, 24], [64, 118, 214], D.dl), bot = mixc([24, 15, 48], [176, 208, 242], D.dl);
  const g = ctx.createLinearGradient(0, wy, 0, wy + wh); g.addColorStop(0, rgb(top)); g.addColorStop(1, rgb(D.warm > 0 ? mixc(bot, [244, 136, 92], D.warm * .7) : bot));
  ctx.fillStyle = g; ctx.fillRect(wx - ww, wy, ww * 2, wh);
  if (D.dl < 0.6) { ctx.fillStyle = `rgba(255,255,240,${0.9 - D.dl})`; for (let i = 0; i < 6; i++) ctx.fillRect(wx - ww / 2 + rnd(p.id + 'ws' + i) * ww, wy + rnd(p.id + 'wt' + i) * wh * 0.7, 1.5, 1.5); }
  ctx.restore();
  ctx.strokeStyle = '#1a1226'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(wx - ww / 2, wy + wh); ctx.lineTo(wx - ww / 2, wy + ww / 2); ctx.arc(wx, wy + ww / 2, ww / 2, Math.PI, 0); ctx.lineTo(wx + ww / 2, wy + wh); ctx.closePath(); ctx.stroke();
  ctx.strokeStyle = '#4a3a2a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(wx, wy); ctx.lineTo(wx, wy + wh); ctx.moveTo(wx - ww / 2, wy + wh * 0.55); ctx.lineTo(wx + ww / 2, wy + wh * 0.55); ctx.stroke();
  return { wx, wy, ww, wh };
}

function drawLadder(x, topY, botY, locked) {
  const u = L.u, hw = u * 0.055;
  if (locked) {                                           // planked, padlocked hatch
    ctx.fillStyle = '#4b3524'; ctx.fillRect(x - hw * 1.4, botY - u * 0.12, hw * 2.8, u * 0.12);
    ctx.strokeStyle = '#2a1c12'; ctx.lineWidth = 1; for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(x - hw * 1.4 + i * hw * 0.7, botY - u * 0.12); ctx.lineTo(x - hw * 1.4 + i * hw * 0.7, botY); ctx.stroke(); }
    padlock(x, botY - u * 0.06, u * 0.05); return;
  }
  ctx.strokeStyle = '#6b4a2e'; ctx.lineWidth = Math.max(2, u * 0.016);
  ctx.beginPath(); ctx.moveTo(x - hw, topY); ctx.lineTo(x - hw, botY); ctx.moveTo(x + hw, topY); ctx.lineTo(x + hw, botY); ctx.stroke();
  ctx.lineWidth = Math.max(1.5, u * 0.011); ctx.strokeStyle = '#8a6440';
  for (let y = botY - u * 0.07; y > topY; y -= u * 0.085) { ctx.beginPath(); ctx.moveTo(x - hw, y); ctx.lineTo(x + hw, y); ctx.stroke(); }
}
function padlock(x, y, s) {
  ctx.strokeStyle = '#c9b06a'; ctx.lineWidth = Math.max(1.5, s * 0.22); ctx.beginPath(); ctx.arc(x, y - s * 0.25, s * 0.38, Math.PI, 0); ctx.stroke();
  ctx.fillStyle = '#d9b84a'; ctx.beginPath(); ctx.roundRect(x - s * 0.55, y - s * 0.25, s * 1.1, s * 0.9, 2); ctx.fill();
  ctx.fillStyle = '#4a3410'; ctx.beginPath(); ctx.arc(x, y + s * 0.15, s * 0.14, 0, 7); ctx.fill();
}
function drawDoor(x, floor, side, locked, T) {
  const u = L.u, w = u * 0.2, h = u * 0.5, left = side < 0 ? x : x - w;
  ctx.fillStyle = '#1a1226'; ctx.beginPath(); ctx.moveTo(left - 3, floor); ctx.lineTo(left - 3, floor - h * 0.7); ctx.arc(left + w / 2, floor - h * 0.7, w / 2 + 3, Math.PI, 0); ctx.lineTo(left + w + 3, floor); ctx.fill();
  const g = ctx.createLinearGradient(left, 0, left + w, 0); g.addColorStop(0, '#6e4a2c'); g.addColorStop(1, '#4a301c'); ctx.fillStyle = g;
  ctx.beginPath(); ctx.moveTo(left, floor); ctx.lineTo(left, floor - h * 0.7); ctx.arc(left + w / 2, floor - h * 0.7, w / 2, Math.PI, 0); ctx.lineTo(left + w, floor); ctx.fill();
  ctx.strokeStyle = '#2a1c12'; ctx.lineWidth = 1.5; for (let i = 1; i < 3; i++) { ctx.beginPath(); ctx.moveTo(left + w * i / 3, floor); ctx.lineTo(left + w * i / 3, floor - h * 0.9); ctx.stroke(); }
  ctx.fillStyle = '#3a3a48'; ctx.fillRect(left, floor - h * 0.55, w, 3); ctx.fillRect(left, floor - h * 0.2, w, 3);
  ctx.fillStyle = '#d9b84a'; ctx.beginPath(); ctx.arc(left + w * (side < 0 ? 0.75 : 0.25), floor - h * 0.38, 2.5, 0, 7); ctx.fill();
  if (locked) { const p = 0.6 + 0.4 * Math.sin(T / 500); glowAt(left + w / 2, floor - h * 0.42, u * 0.18, [255, 90, 90], 0.25 * p); padlock(left + w / 2, floor - h * 0.42, u * 0.06); }
}

function drawRoom(p, T, D) {
  const u = L.u, px = X(p.x), py = Y(p.y), w = p.w * u, h = p.h * u, here = p.id === S.place, fy = Y(floorY(p));
  if (px > W + 20 || px + w < -20 || py > H + 20 || py + h < -20) return;
  const platform = p.outdoor && S.places.some(q => q.y === p.y + p.h && q.x < p.x + p.w && q.x + q.w > p.x);
  ctx.drawImage(roomBG(p, p.w * L.uq, p.h * L.uq, platform), px, py, w, h);
  if (isIndoor(p)) drawWindow(p, px, py, w, h, D);
  // exits
  const hasDown = [];
  p.exits.forEach(e => {
    const q = L.byId[e.to]; if (!q) return; const f = exitFrac(p, q), ex = px + w * f;
    if (q.y !== p.y) {
      if (q.y < p.y) { ctx.fillStyle = '#0a0612'; ctx.fillRect(ex - u * 0.08, py + h * 0.055, u * 0.16, u * 0.03); drawLadder(ex, py + h * 0.07, fy, e.locked); }
      else { ctx.fillStyle = '#0a0612'; ctx.beginPath(); ctx.ellipse(ex, fy + u * 0.035, u * 0.1, u * 0.025, 0, 0, 7); ctx.fill(); if (e.locked) drawLadder(ex, 0, fy + u * 0.03, true); else { ctx.save(); ctx.beginPath(); ctx.rect(ex - u * 0.2, py, u * 0.4, fy + u * 0.03); ctx.clip(); drawLadder(ex, fy - u * 0.02, fy + u * 0.07, false); ctx.restore(); } }
    } else drawDoor(q.x < p.x ? px + 6 : px + w - 6, fy + u * 0.02, q.x < p.x ? -1 : 1, e.locked, T);
  });
  // items
  p.items.forEach((it, i) => {
    const fx = it.slot != null ? it.slot : 0.12 + 0.76 * rnd(it.id), ix = px + fx * w, bob = it.floating ? Math.sin(T / 450 + i) * u * 0.03 - u * 0.09 : 0, iy = fy + u * 0.02;
    if (it.kind === 'plot') {                         // a tilled mound with furrows
      const mw = u * 0.3, mh = u * 0.075, sg = ctx.createLinearGradient(0, iy - mh, 0, iy + mh * 0.4); sg.addColorStop(0, '#6b4a2c'); sg.addColorStop(1, '#3b2616');
      ctx.fillStyle = sg; ctx.beginPath(); ctx.ellipse(ix, iy - mh * 0.2, mw, mh, 0, 0, 7); ctx.fill();
      ctx.strokeStyle = 'rgba(20,10,4,.45)'; ctx.lineWidth = 1.2; for (let r = -1; r <= 1; r++) { ctx.beginPath(); ctx.moveTo(ix - mw * 0.8, iy - mh * 0.2 + r * mh * 0.36); ctx.lineTo(ix + mw * 0.8, iy - mh * 0.2 + r * mh * 0.36); ctx.stroke(); }
    } else { ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.ellipse(ix, iy, u * 0.075, u * 0.02, 0, 0, 7); ctx.fill(); }
    if (it.kind === 'orb_search') glowAt(ix, iy - u * 0.08, u * 0.25, [110, 170, 255], 0.30 + 0.15 * Math.sin(T / 600));
    if (it.kind === 'stone') glowAt(ix, iy - u * 0.06, u * 0.22, [255, 220, 130], 0.22 + 0.12 * Math.sin(T / 900));
    if (it.kind === 'library_wiki') glowAt(ix, iy - u * 0.15, u * 0.3, [150, 230, 190], 0.10 + 0.06 * Math.sin(T / 1100));
    ctx.globalAlpha = it.broken ? 0.4 : 1; ctx.font = `${Math.round(u * (it.kind === 'library_wiki' ? 0.34 : it.kind === 'plot' ? 0.26 : 0.2))}px "Segoe UI Emoji","Apple Color Emoji",sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(it.icon, ix, iy + bob - (it.kind === 'plot' ? u * 0.05 : 0)); ctx.globalAlpha = 1;
    if (it.price) { ctx.font = `700 ${Math.max(9, Math.round(u * 0.07))}px "Segoe UI",sans-serif`; ctx.fillStyle = '#ffd96a'; ctx.strokeStyle = 'rgba(20,10,0,.8)'; ctx.lineWidth = 3; ctx.strokeText(it.price + 'g', ix, iy + u * 0.09); ctx.fillText(it.price + 'g', ix, iy + u * 0.09); }
    it._x = ix; it._y = iy;
  });
  if (p.biome === 'forest') { ctx.fillStyle = `rgba(3,10,8,${0.16 + 0.34 * (1 - D.dl)})`; ctx.fillRect(px, py, w, h); }
  // darkness + lights
  const lit = p.lit ? 1 : 0;
  if (isIndoor(p)) {
    const dark = (0.05 + 0.3 * (1 - D.dl)) * (here ? 0.75 : 1.2) * (1 - lit * 0.7);
    ctx.fillStyle = `rgba(6,4,22,${clamp(dark, 0, 0.75)})`; ctx.fillRect(px, py, w, h);
    ctx.globalCompositeOperation = 'lighter';
    torchPoints(p).forEach((tf, i) => { const tx = px + tf * w, ty = py + h * 0.36; glowAt(tx, ty, u * (0.55 + 0.05 * Math.sin(T / 110 + i)), [255, 150, 70], here ? 0.5 : 0.38); });
    if (D.dl > 0.25) { const wx = px + w * (0.28 + 0.4 * rnd(p.id + 'win')); const sg = ctx.createLinearGradient(wx, py + h * 0.4, wx + w * 0.15, fy); sg.addColorStop(0, `rgba(255,240,190,${0.18 * D.dl})`); sg.addColorStop(1, 'rgba(255,240,190,0)'); ctx.fillStyle = sg; ctx.beginPath(); ctx.moveTo(wx - w * 0.04, py + h * 0.4); ctx.lineTo(wx + w * 0.04, py + h * 0.4); ctx.lineTo(wx + w * 0.26, fy); ctx.lineTo(wx + w * 0.1, fy); ctx.fill(); }
    if (p.lit) { glowAt(px + w / 2, py + h * 0.45, w * 0.55, [255, 226, 140], 0.5); }
    ctx.globalCompositeOperation = 'source-over';
    torchPoints(p).forEach((tf, i) => { const tx = px + tf * w, ty = py + h * 0.36; ctx.fillStyle = '#51413a'; ctx.fillRect(tx - u * 0.025, ty + u * 0.06, u * 0.05, u * 0.012); flame(tx, ty + u * 0.06, u * 0.06, T, i + hash(p.id)); });
  }
  // frame + label
  ctx.strokeStyle = here ? '#f5c96a' : 'rgba(0,0,0,0)'; ctx.lineWidth = 3; if (here) { ctx.shadowColor = '#f5c96a'; ctx.shadowBlur = 14; ctx.strokeRect(px + 1.5, py + 1.5, w - 3, h - 3); ctx.shadowBlur = 0; }
  if (u < 55) return;                                 // too far out for labels
  ctx.font = `600 ${Math.max(10, u * 0.075)}px "Segoe UI",sans-serif`; ctx.textAlign = 'left';
  if (p.outdoor) { const tw = ctx.measureText(p.name.toUpperCase()).width; ctx.fillStyle = 'rgba(10,8,28,.55)'; ctx.beginPath(); ctx.roundRect(px + 6, py + h * 0.14 - u * 0.08, tw + 10, u * 0.11, 6); ctx.fill(); }
  ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fillText(p.name.toUpperCase(), px + 11, py + h * 0.14 + 1);
  ctx.fillStyle = here ? '#ffe7a8' : 'rgba(225,215,255,.72)'; ctx.fillText(p.name.toUpperCase(), px + 10, py + h * 0.14);
}

// ------------------------------------------------------------------ wizard
const wiz = { x: 3, y: 2.9, face: 1, moving: false, path: [], tx: null, phase: 0, cast: 0, room: null, blink: 0 };
function wizardTarget() {
  const p = L.byId[S.place]; if (!p) return;
  if (S.sleeping) { const bed = p.items.find(i => /bed|cot|bunk/i.test(i.name)); return { x: p.x + p.w * (bed ? rnd(bed.id) * 0.64 + 0.12 : 0.5), y: floorY(p) }; }
  if (wiz.tx === null || wiz.tx < 0) wiz.tx = 0.15 + rnd(p.id + S.stats.turns) * 0.7;
  return { x: p.x + p.w * wiz.tx, y: floorY(p) };
}
function updateWizard(dt) {
  const p = L.byId[S.place]; if (!p) return;
  if (wiz.room === null) { wiz.room = S.place; const t = wizardTarget(); wiz.x = t.x; wiz.y = t.y; }
  if (wiz.room !== S.place) {                         // walk through the exits to the new room
    const a = L.byId[wiz.room], b = p;
    if (a && a.exits.some(e => e.to === b.id)) { wiz.path = [exitPt(a, b), exitPt(b, a), { ...wizardTarget(), warp: false }]; } else { const t = wizardTarget(); wiz.x = t.x; wiz.y = t.y; wiz.path = []; }
    wiz.room = S.place; wiz.pendingRoom = true;
  }
  let goal = wiz.path.length ? wiz.path[0] : wizardTarget();
  const dx = goal.x - wiz.x, dy = goal.y - wiz.y, d = Math.hypot(dx, dy), sp = (S.sleeping ? 1.6 : 0.8) * dt;
  wiz.moving = d > 0.01 && !S.sleeping || (S.sleeping && d > 0.05);
  if (d > sp) { wiz.x += dx / d * sp; wiz.y += dy / d * sp; if (Math.abs(dx) > 0.01) wiz.face = Math.sign(dx); wiz.phase += dt * 9; }
  else { wiz.x = goal.x; wiz.y = goal.y; if (wiz.path.length) wiz.path.shift(); else wiz.moving = false; }
  wiz.climbing = wiz.path.length && Math.abs(dy) > Math.abs(dx) * 2 && d > 0.01;
  wiz.cast = Math.max(0, wiz.cast - dt); wiz.blink -= dt; if (wiz.blink < -3.2) wiz.blink = 0.14;
}
function drawWizard(T) {
  const u = L.u, s = u * WS, x = X(wiz.x), y = Y(wiz.y) + u * 0.03;
  const bob = wiz.moving ? Math.abs(Math.sin(wiz.phase)) * s * 0.035 : (S.thinking ? 0 : Math.sin(T / 500) * s * 0.012);
  ctx.fillStyle = 'rgba(0,0,0,.4)'; ctx.beginPath(); ctx.ellipse(x, y, s * (S.sleeping ? 0.5 : 0.3), s * 0.05, 0, 0, 7); ctx.fill();
  ctx.save(); ctx.translate(x, y - bob);
  if (S.sleeping) { ctx.rotate(-Math.PI / 2 * wiz.face); ctx.translate(0, s * 0.2 * wiz.face * 0); }
  ctx.scale(wiz.face * (wiz.climbing ? 1 : 1), 1);
  const sw = Math.sin(wiz.phase) * (wiz.moving ? 1 : 0);
  // staff
  const lift = wiz.cast > 0 ? -s * 0.12 : 0, sx = s * 0.3, tipY = -s * 0.95 + lift;
  ctx.strokeStyle = '#6b4a2e'; ctx.lineWidth = Math.max(2, s * 0.035); ctx.beginPath(); ctx.moveTo(sx + sw * s * 0.03, 0); ctx.lineTo(sx, tipY + s * 0.05); ctx.stroke();
  const tg = 0.5 + 0.5 * Math.sin(T / 400) + (wiz.cast > 0 ? 1.2 : 0);
  ctx.globalCompositeOperation = 'lighter'; glowAt(sx, tipY, s * (0.28 + 0.12 * tg), [150, 190, 255], 0.5 + 0.2 * tg); ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#bcd6ff'; ctx.beginPath(); ctx.arc(sx, tipY, s * 0.055, 0, 7); ctx.fill();
  // boots
  ctx.fillStyle = '#2a1f3a'; ctx.beginPath(); ctx.ellipse(-s * 0.1 + sw * s * 0.07, -s * 0.015, s * 0.085, s * 0.04, 0, 0, 7); ctx.fill(); ctx.beginPath(); ctx.ellipse(s * 0.1 - sw * s * 0.07, -s * 0.015, s * 0.085, s * 0.04, 0, 0, 7); ctx.fill();
  // robe
  const rg = ctx.createLinearGradient(-s * 0.3, -s * 0.5, s * 0.3, 0); rg.addColorStop(0, '#6c4cf0'); rg.addColorStop(1, '#3b2792');
  ctx.fillStyle = rg; ctx.beginPath(); ctx.moveTo(-s * 0.17, -s * 0.56); ctx.quadraticCurveTo(-s * 0.3, -s * 0.2, -s * 0.31, -s * 0.03 + sw * s * 0.01); for (let i = 0; i <= 6; i++) ctx.lineTo(-s * 0.31 + s * 0.62 * i / 6, -s * 0.03 + (i % 2 ? s * 0.025 : 0)); ctx.quadraticCurveTo(s * 0.3, -s * 0.2, s * 0.17, -s * 0.56); ctx.closePath(); ctx.fill();
  ctx.fillStyle = 'rgba(255,230,140,.7)'; for (let i = 0; i < 6; i++) { ctx.beginPath(); ctx.arc(-s * 0.15 + rnd('rs' + i) * s * 0.3, -s * 0.12 - rnd('rt' + i) * s * 0.3, s * 0.014, 0, 7); ctx.fill(); }
  ctx.fillStyle = '#d9b84a'; ctx.fillRect(-s * 0.2, -s * 0.37, s * 0.4, s * 0.04);
  // arm holding staff
  ctx.strokeStyle = '#5a3cc8'; ctx.lineWidth = s * 0.07; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(s * 0.14, -s * 0.5); ctx.lineTo(sx, -s * 0.34 + lift * 0.6); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-s * 0.14, -s * 0.5); ctx.lineTo(-s * 0.2 - sw * s * 0.05, -s * 0.28); ctx.stroke();
  ctx.fillStyle = '#f1cfae'; ctx.beginPath(); ctx.arc(sx, -s * 0.34 + lift * 0.6, s * 0.04, 0, 7); ctx.fill();
  // head
  const hy = -s * 0.66, tilt = S.thinking ? 0.12 : 0; ctx.save(); ctx.translate(0, hy); ctx.rotate(tilt);
  ctx.fillStyle = '#f1cfae'; ctx.beginPath(); ctx.arc(0, 0, s * 0.14, 0, 7); ctx.fill();
  ctx.fillStyle = '#ececf4'; ctx.beginPath(); ctx.moveTo(-s * 0.13, s * 0.02); ctx.quadraticCurveTo(-s * 0.15, s * 0.3, 0, s * 0.34); ctx.quadraticCurveTo(s * 0.15, s * 0.3, s * 0.13, s * 0.02); ctx.quadraticCurveTo(0, s * 0.09, -s * 0.13, s * 0.02); ctx.fill();
  ctx.fillStyle = '#e9b99a'; ctx.beginPath(); ctx.arc(s * 0.1, s * 0.0, s * 0.035, 0, 7); ctx.fill();            // nose
  if (S.sleeping || wiz.blink > 0) { ctx.strokeStyle = '#2a2030'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(-s * 0.01, -s * 0.03); ctx.lineTo(s * 0.05, -s * 0.03); ctx.moveTo(s * 0.065, -s * 0.03); ctx.lineTo(s * 0.12, -s * 0.03); ctx.stroke(); }
  else { ctx.fillStyle = '#241c30'; ctx.beginPath(); ctx.arc(s * 0.02, -s * 0.03, s * 0.02, 0, 7); ctx.arc(s * 0.09, -s * 0.03, s * 0.02, 0, 7); ctx.fill(); }
  ctx.strokeStyle = '#d8d8e4'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(-s * 0.01, -s * 0.07); ctx.lineTo(s * 0.06, -s * 0.085); ctx.moveTo(s * 0.07, -s * 0.085); ctx.lineTo(s * 0.13, -s * 0.07); ctx.stroke();
  // hat
  const glow = S.hat_glow;
  if (glow) { ctx.globalCompositeOperation = 'lighter'; glowAt(0, -s * 0.2, s * 0.6, [255, 226, 120], 0.55 + 0.2 * Math.sin(T / 160)); ctx.globalCompositeOperation = 'source-over'; }
  const hg = ctx.createLinearGradient(0, -s * 0.5, 0, -s * 0.05); hg.addColorStop(0, glow ? '#ffe9a0' : '#4a35c8'); hg.addColorStop(1, glow ? '#ffd45a' : '#2c1f78');
  ctx.fillStyle = hg; ctx.beginPath(); ctx.moveTo(-s * 0.17, -s * 0.07); ctx.quadraticCurveTo(-s * 0.06, -s * 0.28, -s * 0.0, -s * 0.46); ctx.quadraticCurveTo(s * 0.12, -s * 0.5, s * 0.2, -s * 0.4); ctx.quadraticCurveTo(s * 0.08, -s * 0.28, s * 0.17, -s * 0.07); ctx.closePath(); ctx.fill();
  ctx.fillStyle = glow ? '#ffd45a' : '#2a1d6a'; ctx.beginPath(); ctx.ellipse(0, -s * 0.07, s * 0.27, s * 0.05, 0, 0, 7); ctx.fill();
  ctx.fillStyle = '#d9b84a'; ctx.fillRect(-s * 0.15, -s * 0.12, s * 0.3, s * 0.03);
  ctx.fillStyle = '#ffe27a'; ctx.font = `${s * 0.13}px sans-serif`; ctx.textAlign = 'center'; ctx.fillText('★', -s * 0.01, -s * 0.2);
  ctx.restore(); ctx.restore();
  wiz._sx = x; wiz._sy = y - s * 1.05; wiz._s = s;
}

// ------------------------------------------------------------------ crow
const crow = { x: 0, hop: 0 };
function drawCrow(T) {
  if (!S.crow) { crow.x = 0; return; }
  const u = L.u, p = L.byId[S.place]; if (!p) return;
  const tx = clamp(wiz.x + (wiz.face > 0 ? 0.45 : -0.45) * 1, p.x + 0.12, p.x + p.w - 0.12);
  crow.x = crow.x ? lerp(crow.x, tx, 0.04) : tx; const s = u * 0.3, x = X(crow.x), y = Y(floorY(p)) + u * 0.03;
  const hop = Math.max(0, Math.sin(T / 400 + 1)) > 0.97 ? Math.abs(Math.sin(T / 60)) * s * 0.2 : 0, f = crow.x < wiz.x ? 1 : -1;
  ctx.save(); ctx.translate(x, y - hop); ctx.scale(f, 1);
  ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.ellipse(0, hop, s * 0.22, s * 0.04, 0, 0, 7); ctx.fill();
  ctx.strokeStyle = '#3a2f2a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(-s * 0.05, -s * 0.15); ctx.lineTo(-s * 0.05, 0); ctx.moveTo(s * 0.06, -s * 0.15); ctx.lineTo(s * 0.06, 0); ctx.stroke();
  ctx.fillStyle = '#15121c'; ctx.beginPath(); ctx.moveTo(-s * 0.2, -s * 0.3); ctx.lineTo(-s * 0.42, -s * 0.22); ctx.lineTo(-s * 0.18, -s * 0.2); ctx.fill();                 // tail
  ctx.beginPath(); ctx.ellipse(0, -s * 0.3, s * 0.22, s * 0.15, -0.2, 0, 7); ctx.fill();                                                                                         // body
  ctx.beginPath(); ctx.arc(s * 0.17, -s * 0.46, s * 0.1, 0, 7); ctx.fill();                                                                                                      // head
  ctx.fillStyle = '#2a2438'; ctx.beginPath(); ctx.ellipse(-s * 0.02, -s * 0.31, s * 0.12, s * 0.07, -0.3 + Math.sin(T / 700) * 0.05, 0, 7); ctx.fill();                          // wing
  ctx.fillStyle = '#e8a23a'; ctx.beginPath(); ctx.moveTo(s * 0.25, -s * 0.5); ctx.lineTo(s * 0.4, -s * 0.45); ctx.lineTo(s * 0.25, -s * 0.42); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(s * 0.2, -s * 0.49, s * 0.025, 0, 7); ctx.fill(); ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(s * 0.205, -s * 0.49, s * 0.012, 0, 7); ctx.fill();
  ctx.restore();
}

// ------------------------------------------------------------------ particles & effects
const parts = []; let flash = null, lastSeq = null;
function spawn(n, gx, gy, o) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * 6.283, v = (o.v || 0.5) * (0.3 + Math.random());
    parts.push({ x: gx + (Math.random() - 0.5) * (o.spread || 0), y: gy + (Math.random() - 0.5) * (o.spread || 0), vx: Math.cos(a) * v * (o.flat ? 1 : 1), vy: o.up ? -Math.random() * v - 0.2 : Math.sin(a) * v,
      g: o.g || 0, life: 0, max: (o.life || 1.2) * (0.6 + Math.random() * 0.8), size: (o.size || 3) * (0.6 + Math.random() * 0.8), col: o.col || [255, 220, 120], kind: o.kind || 'spark', rot: Math.random() * 6 });
  }
}
function onAction(la) {
  const r = la.result || '', cx = wiz.x, cy = wiz.y - WS * 0.9;
  if (la.action === 'cast' || la.action === 'practice') {
    wiz.cast = 0.9;
    if (/goes wrong/.test(r)) { spawn(14, cx + 0.15 * wiz.face, cy, { v: 0.35, col: [150, 140, 160], kind: 'smoke', size: 9, life: 1.8, up: true }); spawn(6, cx, cy, { v: 0.5, col: [255, 120, 80], size: 2.5 }); }
    else if (/^You cast/.test(r)) spawn(36, cx + 0.15 * wiz.face, cy, { v: 0.9, col: [255, 225, 130], size: 3, life: 1.4 });
    if (/scorches|crumbles|Your head swims/.test(r)) flash = { col: [255, 60, 40], t: 0.7 };
  }
  if (/You have learned a spell/.test(r)) { spawn(70, cx, cy, { v: 1.1, col: [190, 150, 255], size: 3.5, life: 2 }); flash = { col: [190, 150, 255], t: 0.8 }; }
  if (la.action === 'use' && /clarity|mind go/.test(r)) { spawn(50, cx, cy, { v: 0.9, col: [255, 226, 140], size: 3.5, life: 2 }); flash = { col: [255, 226, 140], t: 0.6 }; }
  else if (la.action === 'use' && /Pictures|mist|glass/.test(r)) spawn(26, cx, cy, { v: 0.4, col: [120, 180, 255], size: 3, life: 1.6, up: true });
  else if (la.action === 'use' && /book opens|shelves/.test(r)) spawn(18, cx, cy, { v: 0.4, col: [150, 235, 190], size: 3, life: 1.6, up: true });
  if (/ you for \d+ damage/.test(r)) { flash = { col: [255, 50, 40], t: 0.35 }; }
  if (la.action === 'attack' || la.action === 'cast') { if (/You strike .+ for \d+ damage|bolt of light hits .+ for \d+ damage/.test(r)) { mon.shake = 0.35; if (mon.last) spawn(14, mon.last.x, mon.last.y - 0.3, { v: 0.8, col: [255, 230, 150], size: 3, life: 0.8 }); } wiz.cast = 0.5; }
  if (/You defeated/.test(r)) { flash = { col: [255, 220, 120], t: 0.5 }; spawn(30, cx, cy, { v: 0.9, col: [255, 215, 90], size: 3, life: 1.6 }); }
  if (/gold tumbles|gold on the counter/.test(r)) spawn(20, cx, cy, { v: 0.7, col: [255, 215, 90], size: 3, life: 1.4, up: true });
  if (/You gather your will and shape/.test(r)) { spawn(40, cx, cy, { v: 0.8, col: [170, 255, 200], size: 3.5, life: 1.8 }); flash = { col: [170, 255, 200], t: 0.5 }; }
  if (/Something quietly unfolds/.test(r)) { spawn(80, cx, cy, { v: 1.2, col: [255, 150, 200], size: 4, life: 2.4 }); flash = { col: [255, 150, 200], t: 0.9 }; }
  if (/folds up like a page/.test(r)) flash = { col: [200, 220, 255], t: 0.7 };
  if (la.action === 'read') spawn(8, cx, cy + 0.1, { v: 0.25, col: [255, 250, 230], kind: 'paper', size: 5, life: 2, up: true });
  if (la.action === 'train') spawn(12, cx, wiz.y, { v: 0.3, col: [190, 170, 140], kind: 'smoke', size: 7, life: 1, up: true });
  if (la.action === 'wish') spawn(10, cx, cy, { v: 0.4, col: [255, 240, 160], kind: 'star', size: 6, life: 2.4, up: true });
  if (la.action === 'tell_creator') spawn(5, cx, cy, { v: 0.3, col: [180, 200, 255], kind: 'note', size: 14, life: 2.6, up: true });
  if (la.action === 'move' || la.action === 'look' || la.action === 'rest' || la.action === 'write' || la.action === 'talk') wiz.tx = -1;   // wander to a new spot
  if (la.action === 'talk' && S.crow) spawn(4, crow.x, wiz.y - 0.3, { v: 0.2, col: [255, 255, 255], kind: 'note', size: 12, life: 2, up: true });
}
function updateParts(dt) {
  for (let i = parts.length - 1; i >= 0; i--) { const q = parts[i]; q.life += dt; if (q.life > q.max) { parts.splice(i, 1); continue; } q.vy += q.g * dt; q.x += q.vx * dt; q.y += q.vy * dt; q.vx *= 0.99; if (q.kind === 'smoke' || q.kind === 'paper' || q.kind === 'star' || q.kind === 'note') q.vy -= 0.06 * dt; }
}
function drawParts() {
  for (const q of parts) {
    const k = 1 - q.life / q.max, x = X(q.x), y = Y(q.y);
    if (q.kind === 'spark') { ctx.globalCompositeOperation = 'lighter'; glowAt(x, y, q.size * 3.5, q.col, 0.7 * k); ctx.fillStyle = rgb(q.col, k); ctx.beginPath(); ctx.arc(x, y, q.size * k, 0, 7); ctx.fill(); ctx.globalCompositeOperation = 'source-over'; }
    else if (q.kind === 'smoke') { ctx.fillStyle = rgb(q.col, 0.45 * k); ctx.beginPath(); ctx.arc(x, y, q.size * (2 - k), 0, 7); ctx.fill(); }
    else if (q.kind === 'paper') { ctx.save(); ctx.translate(x, y); ctx.rotate(q.rot + q.life * 3); ctx.fillStyle = rgb(q.col, k); ctx.fillRect(-q.size, -q.size * 0.6, q.size * 2, q.size * 1.2); ctx.restore(); }
    else { ctx.globalAlpha = k; ctx.fillStyle = rgb(q.col); ctx.font = `${q.size * 2}px sans-serif`; ctx.textAlign = 'center'; ctx.fillText(q.kind === 'note' ? '✉' : '★', x, y); ctx.globalAlpha = 1; }
  }
}
function ambient(T, D) {
  const p = L.byId[S.place]; if (!p) return;
  if (Math.random() < 0.18 && isIndoor(p)) spawn(1, p.x + Math.random() * p.w, p.y + 0.15 + Math.random() * 0.6, { v: 0.015, col: [255, 235, 200], size: 1.4, life: 6, kind: 'mote' });
  if (D.dl < 0.35 && Math.random() < 0.05) spawn(1, L.minx + Math.random() * (L.maxx - L.minx + 2) - 1, L.maxy - 0.1 - Math.random() * 0.4, { v: 0.04, col: [220, 255, 130], size: 2.5, life: 5 });
}

// ------------------------------------------------------------------ monsters + HUD
const mon = { x: null, key: '', shake: 0, last: null };
function drawMonster(T, dt) {
  const f = S.fight, p = L.byId[S.place];
  if (!f || !p) { if (mon.key && mon.last) { spawn(16, mon.last.x, mon.last.y - 0.25, { v: 0.4, col: [190, 180, 200], kind: 'smoke', size: 10, life: 1.4, up: true }); } mon.key = ''; mon.x = null; return; }
  const u = L.u, key = f.name + f.maxhp, sz = u * (f.boss ? 0.9 : 0.5), side = wiz.face >= 0 ? 1 : -1, gap = f.boss ? 1.0 : 0.78;
  let tx = clamp(wiz.x + side * gap, p.x + 0.25, p.x + p.w - 0.25);
  if (Math.abs(tx - wiz.x) < 0.5) tx = clamp(wiz.x - side * gap, p.x + 0.25, p.x + p.w - 0.25);
  if (mon.key !== key || mon.x === null) { mon.key = key; mon.x = tx + (tx > wiz.x ? 2.2 : -2.2); }
  mon.x += (tx - mon.x) * Math.min(1, dt * 5); mon.shake = Math.max(0, mon.shake - dt);
  const fy = floorY(p), bx = X(mon.x) + (mon.shake > 0 ? Math.sin(T / 25) * u * 0.03 : 0), by = Y(fy) + u * 0.03, bob = Math.abs(Math.sin(T / 260)) * u * 0.02;
  mon.last = { x: mon.x, y: fy };
  ctx.fillStyle = 'rgba(0,0,0,.4)'; ctx.beginPath(); ctx.ellipse(bx, by, sz * 0.4, sz * 0.07, 0, 0, 7); ctx.fill();
  ctx.save(); ctx.translate(bx, by - bob); if (mon.x > wiz.x) ctx.scale(-1, 1);
  ctx.font = `${Math.round(sz)}px "Segoe UI Emoji","Apple Color Emoji",sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  if (mon.shake > 0) ctx.globalAlpha = 0.65; ctx.fillText(f.icon, 0, 0); ctx.globalAlpha = 1; ctx.restore();
  const bw = sz * 0.95, bh = Math.max(5, u * 0.035), hx = bx - bw / 2, hy = by - sz * 1.15;           // health bar
  ctx.fillStyle = 'rgba(10,6,20,.7)'; ctx.beginPath(); ctx.roundRect(hx - 2, hy - 2, bw + 4, bh + 4, 4); ctx.fill();
  ctx.fillStyle = f.boss ? '#d9a441' : '#e0524a'; ctx.beginPath(); ctx.roundRect(hx, hy, bw * clamp(f.hp / f.maxhp, 0, 1), bh, 3); ctx.fill();
}
function drawHUD(T) {
  let y = 12;
  const pill = (txt, frac, col) => {
    ctx.font = '600 12px "Segoe UI",sans-serif'; const tw = ctx.measureText(txt).width + 22, h = frac === null ? 24 : 34;
    ctx.fillStyle = 'rgba(14,10,30,.74)'; ctx.beginPath(); ctx.roundRect(12, y, tw, h, 9); ctx.fill();
    ctx.fillStyle = '#efe8ff'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillText(txt, 23, y + 16);
    if (frac !== null) { ctx.fillStyle = 'rgba(255,255,255,.15)'; ctx.fillRect(23, y + 23, tw - 22, 5); ctx.fillStyle = col; ctx.fillRect(23, y + 23, (tw - 22) * clamp(frac, 0, 1), 5); }
    y += h + 6;
  };
  if (S.fight) pill(`${S.fight.icon} ${S.fight.name}  ${Math.max(0, S.fight.hp)}/${S.fight.maxhp}`, S.fight.hp / S.fight.maxhp, S.fight.boss ? '#d9a441' : '#e0524a');
  if (S.trail) pill(`Trail  ${S.trail.n}/${S.trail.need}`, S.trail.n / S.trail.need, '#7bd88f');
}

// ------------------------------------------------------------------ bubbles / overlays
function wrap(text, maxW) { const words = text.split(' '), lines = []; let cur = ''; for (const w of words) { const t = cur ? cur + ' ' + w : w; if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t; } if (cur) lines.push(cur); return lines.slice(0, 3); }
function bubble(x, y, lines, dots, T) {
  ctx.font = '13px "Segoe UI",sans-serif'; ctx.textAlign = 'left';
  const w = dots ? 54 : Math.min(250, Math.max(...lines.map(l => ctx.measureText(l).width)) + 22), h = dots ? 28 : lines.length * 17 + 14;
  const bx = clamp(x - w / 2, 8, W - w - 8), by = y - h - 12;
  ctx.fillStyle = 'rgba(255,255,255,.96)'; ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 8; ctx.beginPath(); ctx.roundRect(bx, by, w, h, 12); ctx.fill();
  ctx.beginPath(); ctx.moveTo(x - 6, by + h - 1); ctx.lineTo(x, by + h + 11); ctx.lineTo(x + 7, by + h - 1); ctx.fill(); ctx.shadowBlur = 0;
  ctx.fillStyle = '#2d2445';
  if (dots) for (let i = 0; i < 3; i++) { ctx.globalAlpha = 0.3 + 0.7 * (((T / 300 | 0) % 3) === i); ctx.beginPath(); ctx.arc(bx + 15 + i * 12, by + 14, 3.4, 0, 7); ctx.fill(); } else lines.forEach((l, i) => ctx.fillText(l, bx + 11, by + 19 + i * 17));
  ctx.globalAlpha = 1;
}

// ------------------------------------------------------------------ camera controls (drag = pan, wheel = zoom, buttons, keys)
const bar = document.createElement('div'); bar.id = 'camBar';
bar.innerHTML = '<button data-m="follow" title="Follow Wimbleton (F)">&#127919; Follow</button><button data-m="fit" title="Show the whole world (0)">&#128506; Whole world</button><button data-z="1" title="Zoom in (+)">+</button><button data-z="-1" title="Zoom out (-)">&minus;</button>';
const st = document.createElement('style');
st.textContent = '#camBar{position:absolute;right:10px;bottom:10px;display:flex;gap:6px;z-index:5}#camBar button{background:rgba(20,14,40,.72);backdrop-filter:blur(6px);color:#e6defc;border:1px solid rgba(180,160,255,.25);border-radius:8px;padding:5px 10px;font:600 12px "Segoe UI",sans-serif;cursor:pointer}#camBar button:hover{border-color:#9b7bff}#camBar button.on{background:rgba(110,80,230,.65);border-color:#b9a4ff}#stage canvas{touch-action:none;cursor:grab}#stage canvas.drag{cursor:grabbing}';
document.head.appendChild(st); (cv.parentElement || document.body).appendChild(bar);
function syncButtons() { bar.querySelectorAll('[data-m]').forEach(b => b.classList.toggle('on', b.dataset.m === cam.mode)); }
function toFree() { cam.fx = (W / 2 - L.ox) / L.u; cam.fy = (H / 2 - L.oy) / L.u; cam.tu = cam.u; setMode('free'); }
function zoomBy(f, mx, my) {
  const nu = clamp((cam.mode === 'follow' ? cam.followU : (cam.tu || cam.u)) * f, Math.min(L.u0 * 0.8, 60), 360);
  if (cam.mode === 'follow') { cam.followU = nu; return; }
  if (cam.mode === 'fit') toFree();
  const cx = mx === undefined ? W / 2 : mx, cy = my === undefined ? H / 2 : my, wx = (cx - L.ox) / L.u, wy = (cy - L.oy) / L.u;   // keep the point under the cursor fixed
  cam.tu = nu; cam.fx = wx - (cx - W / 2) / nu; cam.fy = wy - (cy - H / 2) / nu;
}
bar.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.m) setMode(b.dataset.m); else zoomBy(b.dataset.z > 0 ? 1.3 : 1 / 1.3); });
const ptrs = new Map(); let pinch0 = 0;
cv.addEventListener('pointerdown', e => { cv.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y); } cv.classList.add('drag'); });
cv.addEventListener('pointermove', e => {
  const q = ptrs.get(e.pointerId); if (!q) return;
  const dx = e.clientX - q.x, dy = e.clientY - q.y; q.x = e.clientX; q.y = e.clientY;
  if (ptrs.size === 2) { const [a, b] = [...ptrs.values()], d = Math.hypot(a.x - b.x, a.y - b.y); if (pinch0) zoomBy(d / pinch0); pinch0 = d; return; }
  if (cam.mode !== 'free') { if (Math.abs(dx) + Math.abs(dy) < 1) return; toFree(); }
  cam.fx -= dx / L.u; cam.fy -= dy / L.u;
});
const endp = e => { ptrs.delete(e.pointerId); pinch0 = 0; if (!ptrs.size) cv.classList.remove('drag'); };
cv.addEventListener('pointerup', endp); cv.addEventListener('pointercancel', endp);
cv.addEventListener('wheel', e => { e.preventDefault(); const r = cv.getBoundingClientRect(); zoomBy(Math.exp(-e.deltaY * 0.0012), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
cv.addEventListener('dblclick', () => setMode('follow'));
addEventListener('keydown', e => {
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName || '')) return;
  const k = e.key.toLowerCase(), step = 0.35;
  if (k === 'f') setMode('follow'); else if (k === '0' || k === 'home') setMode('fit');
  else if (k === '+' || k === '=') zoomBy(1.2); else if (k === '-' || k === '_') zoomBy(1 / 1.2);
  else if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'a', 'd', 'w', 's'].includes(k)) {
    if (cam.mode !== 'free') toFree();
    cam.fx += step * ((k === 'arrowright' || k === 'd') - (k === 'arrowleft' || k === 'a')); cam.fy += step * ((k === 'arrowdown' || k === 's') - (k === 'arrowup' || k === 'w')); e.preventDefault();
  }
});
syncButtons();

// ------------------------------------------------------------------ main loop
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  try {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.clearRect(0, 0, W, H);
    if (typeof S === 'undefined' || !S || !S.places) return;
    if (new URLSearchParams(location.search).get('demo') === 'fight') { S.place = new URLSearchParams(location.search).get('at') || 'f3'; S.sleeping = false; S.fight = { name: 'a grey wolf', icon: String.fromCodePoint(0x1F43A), hp: 13, maxhp: 22, boss: false }; S.trail = { n: 4, need: 10 }; }
    layout(dt); const D = dayInfo();
    if (S.last_action) { if (lastSeq === null) lastSeq = S.last_action.seq; else if (S.last_action.seq !== lastSeq) { lastSeq = S.last_action.seq; onAction(S.last_action); } }
    updateWizard(dt); updateParts(dt); ambient(now, D);
    drawSky(now, D); drawGround(now, D);
    S.places.slice().sort((a, b) => (a.id === S.place) - (b.id === S.place)).forEach(p => drawRoom(p, now, D));
    drawCrow(now); drawMonster(now, dt); drawWizard(now); drawParts();
    // bubbles
    if (!S.sleeping) {
      if (S.thinking) bubble(wiz._sx + wiz._s * 0.2, wiz._sy, [], true, now);
      else if (S.last_action && Date.now() / 1000 - S.last_action.ts < 25 && S.last_action.thought) { ctx.font = '13px "Segoe UI",sans-serif'; bubble(wiz._sx + wiz._s * 0.2, wiz._sy, wrap(S.last_action.thought, 220), false, now); }
    } else { ctx.fillStyle = '#dbe4ff'; ctx.font = 'bold 15px "Segoe UI",sans-serif'; ctx.textAlign = 'left'; const k = (now / 800 | 0) % 3; ctx.fillText('Z'.repeat(k + 1), X(wiz.x) + 8, Y(wiz.y) - L.u * 0.4 - k * 7); }
    drawHUD(now);
    if (flash) { flash.t -= dt; ctx.fillStyle = rgb(flash.col, Math.max(0, flash.t) * 0.35); ctx.fillRect(0, 0, W, H); if (flash.t <= 0) flash = null; }
    const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.45, W / 2, H / 2, Math.max(W, H) * 0.8); vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,10,.5)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
  } catch (e) { console.error(e); window.__err = String(e && e.stack || e); document.title = "ERR " + String(e && e.message).slice(0, 120); try { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = "#fff"; ctx.font = "13px monospace"; ctx.textAlign = "left"; window.__err.split(String.fromCharCode(10)).slice(0, 5).forEach((l, i) => ctx.fillText(l.slice(0, 110), 10, 24 + i * 16)); } catch (e2) {} }
}
requestAnimationFrame(frame);
if (location.search.includes('demo')) {          // preview effects: ?demo=cast|fail|learn
  const k = new URLSearchParams(location.search).get('demo');
  const R = { cast: 'You cast Glow. Warm light fills the room.', fail: 'You cast Glow, but it goes wrong. Your hat glows softly. A bolt of wild magic scorches a narrow bed!', learn: 'Something clicks. You have learned a spell, and you decide to call it X.' };
  setTimeout(() => onAction({ action: 'cast', result: R[k] || R.cast, thought: 'Here goes nothing' }), 1500);
}
})();
