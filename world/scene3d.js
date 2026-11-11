/* Wimbleton 3D world. Basic shapes only, flat Lambert colours, no textures or shadows.
   The world is a set of regions on a 3D grid (S.places: gx east, gy north, gz up; a cell is 14 x 14 units, 5 tall).
   Only regions near him or me are built (and merged into one mesh each); distant ones are disposed.
   Modes: Watch (pulled-back follow camera), Walk (my avatar: WASD, mouse look, jump, V first/third person), Fly (free camera, invisible to him).
   window.PUBLIC_VIEW = true makes it a read-only follow camera with no input and no network calls. */
(() => {
if (typeof THREE === 'undefined') return;
const PUBLIC = !!window.PUBLIC_VIEW;
const cv = document.getElementById('cv3'), stage = document.getElementById('stage');
if (!cv || !stage) return;

let R;
try { R = new THREE.WebGLRenderer({ canvas: cv, antialias: false, alpha: false, powerPreference: 'low-power' }); }
catch (e) {                                           // no WebGL: fall back to the 2D view
  window.VIEW3D = false; cv.style.display = 'none'; const c2 = document.getElementById('cv'); if (c2) c2.style.display = 'block';
  const b = document.getElementById('viewbtn'); if (b) b.style.display = 'none';
  return;
}
cv.style.touchAction = 'none';

const hash = s => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const rnd = s => (hash(s) % 10000) / 10000;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const C = h => new THREE.Color(h);
const hsl = (h, s, l) => new THREE.Color().setHSL(h, s, l).getHex();
const store = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) {} return null; };

const CELL = 14, HT = 5, SLAB = 0.3, WT = 0.25, DW = 4.4, DH = 3.7, LOWW = 1.2, K = 3.0, KW = 3.8;
const AV = { r: 0.35, h: 1.75, eye: 1.6, step: 0.55 };

// ------------------------------------------------------------------ shared geometry / materials
const BOX = new THREE.BoxGeometry(1, 1, 1), CYL = new THREE.CylinderGeometry(1, 1, 1, 10), CONE = new THREE.ConeGeometry(1, 1, 10), SPH = new THREE.SphereGeometry(1, 10, 7);
const ROBE = new THREE.CylinderGeometry(0.1, 0.2, 0.36, 10);
const matCache = {};
function mat(hex, basic) {
  const k = (basic ? 'b' : 'l') + hex;
  return matCache[k] || (matCache[k] = basic ? new THREE.MeshBasicMaterial({ color: hex }) : new THREE.MeshLambertMaterial({ color: hex }));
}
function add(g, geo, hex, x, y, z, sx, sy, sz, basic) {
  const m = new THREE.Mesh(geo, mat(hex, basic)); m.position.set(x, y, z); m.scale.set(sx, sy === undefined ? sx : sy, sz === undefined ? sx : sz); g.add(m); return m;
}
const VMAT = new THREE.MeshLambertMaterial({ vertexColors: true }), VMATB = new THREE.MeshBasicMaterial({ vertexColors: true });
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _v = new THREE.Vector3(), _n3 = new THREE.Matrix3();
const mk = (x, y, z, sx, sy, sz, rx, ry, rz) => { _e.set(rx || 0, ry || 0, rz || 0); _q.setFromEuler(_e); return new THREE.Matrix4().compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz)); };

// a Batch bakes many simple shapes into one vertex-coloured mesh (one draw call per region)
class Batch {
  constructor(basic) { this.pos = []; this.nor = []; this.col = []; this.idx = []; this.n = 0; this.basic = basic; }
  addM(geo, hex, m4) {
    const p = geo.attributes.position, nr = geo.attributes.normal, ix = geo.index, c = C(hex);
    _n3.getNormalMatrix(m4);
    for (let i = 0; i < p.count; i++) {
      _v.fromBufferAttribute(p, i).applyMatrix4(m4); this.pos.push(_v.x, _v.y, _v.z);
      _v.fromBufferAttribute(nr, i).applyMatrix3(_n3).normalize(); this.nor.push(_v.x, _v.y, _v.z);
      this.col.push(c.r, c.g, c.b);
    }
    for (let j = 0; j < ix.count; j++) this.idx.push(ix.getX(j) + this.n);
    this.n += p.count;
  }
  box(hex, x, y, z, sx, sy, sz, ry) { this.addM(BOX, hex, mk(x, y, z, sx, sy, sz, 0, ry || 0, 0)); }
  mesh() {
    if (!this.n) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3)); g.setIndex(this.n > 65000 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    return new THREE.Mesh(g, this.basic ? VMATB : VMAT);
  }
}

// ------------------------------------------------------------------ scene, lights, camera
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xbfe0f5, 90, 300);
const hemi = new THREE.HemisphereLight(0xffffff, 0x9aa57a, 1.0), sun = new THREE.DirectionalLight(0xfff2d0, 0.55), lamp = new THREE.PointLight(0xffd29a, 0.7, 26, 1.0);
sun.position.set(-20, 30, 20);
scene.add(hemi, sun, lamp);
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 700);
camera.rotation.order = 'YXZ';
const world = new THREE.Group(); scene.add(world);

// ------------------------------------------------------------------ quality (the brain shares the GPU: degrade the view before the brain)
// level 0 best; 1 pixel ratio 1.0; 2 pixel ratio 0.75 and no extra effects (clouds, particles, smoke, fireflies); 3 one light; 4 smaller chunk radius; 5 no scenery
const Q = { level: 0, mode: store('wimbleton.q3') || 'auto', pr: 1.25, lights: 3, radDrop: 0, scenery: true, fx: true };
function applyQuality(level) {
  const dpr = Math.min(window.devicePixelRatio || 1, 1.25);
  Q.level = level;
  Q.pr = level >= 2 ? Math.min(dpr, 0.75) : level >= 1 ? Math.min(dpr, 1.0) : dpr;
  Q.fx = level < 2; Q.lights = level >= 3 ? 1 : 3; Q.radDrop = level >= 4 ? 1 : 0; const sc = level < 5;
  const rebuild = sc !== Q.scenery; Q.scenery = sc;
  sun.visible = Q.lights >= 2; lamp.visible = Q.lights >= 3;
  R.setPixelRatio(Q.pr); if (W) R.setSize(W, H, false);
  if (rebuild) { for (const id in loaded) dropRegion(id); need = true; }
  fxGroup.visible = Q.fx; dirty = true;
}
function setQualityMode(m) { Q.mode = m; store('wimbleton.q3', m); applyQuality(m === 'low' ? 3 : m === 'high' ? 0 : Q.level); }

let W = 0, H = 0, dirty = true, need = true;
function resize() {
  const r = cv.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return;
  W = r.width; H = r.height; R.setPixelRatio(Q.pr); R.setSize(W, H, false); camera.aspect = W / H; camera.updateProjectionMatrix(); dirty = true;
}
new ResizeObserver(resize).observe(cv); addEventListener('resize', resize);

// ------------------------------------------------------------------ helpers over S
let byId = {}, lastS = null, lastSeq = null, mode = 'watch', avatarOn = false;
const season = () => (S.world && S.world.season) || ['winter', 'winter', 'spring', 'spring', 'spring', 'summer', 'summer', 'summer', 'autumn', 'autumn', 'autumn', 'winter'][new Date().getMonth()];
const tower = () => Object.assign({ dust: 0, cold: 0, mess: 0 }, (S.world && S.world.tower) || {});
const wilt = () => (S.world && +S.world.garden_wilt) || 0;
const hourNow = () => (typeof S.hour === 'number' ? S.hour : 12);
const isNight = () => { const h = hourNow(); return h < 5.5 || h >= 19.5; };
const weather = () => { const t = (S.growth && S.growth.sky && S.growth.sky.weather) || (S.sky && S.sky.weather) || ''; return /snow/i.test(t) ? 'snow' : /rain|storm|thunder|drizzle/i.test(t) ? 'rain' : season() === 'winter' && /cold|grey/i.test(t) ? 'snow' : ''; };
const SEA = {
  spring: { ground: 0x78bb55, leaf: 0x8fd96e }, summer: { ground: 0x5aa844, leaf: 0x3f9a45 },
  autumn: { ground: 0x8ea34f, leaf: 0xe0792c }, winter: { ground: 0xeef4f7, leaf: null },
};
const FLOOR = { stone: 0xbab3aa, wood: 0xc79a64, dirt: 0xa5845a, sand: 0xe8d4a0, snow: 0xf3f8fb };

function rb(r) {                                           // a region's box in world units
  const sp = r.span || [1, 1, 1], w = sp[0] * CELL, d = sp[1] * CELL, h = sp[2] * HT;
  const x0 = (r.gx || 0) * CELL - CELL / 2, z1 = -(r.gy || 0) * CELL + CELL / 2, y0 = (r.gz || 0) * HT;
  return { x0, x1: x0 + w, z0: z1 - d, z1, y0, y1: y0 + h, h, cx: x0 + w / 2, cz: z1 - d / 2, w, d };
}
function sideOf(A, B) {
  const e = 0.01;
  if (B.x0 >= A.x1 - e) return 'E'; if (B.x1 <= A.x0 + e) return 'W'; if (B.z1 <= A.z0 + e) return 'N'; if (B.z0 >= A.z1 - e) return 'S';
  return B.y0 > A.y0 + e ? 'U' : B.y0 < A.y0 - e ? 'D' : null;
}
const rank = { open: 0, locked: 1, blocked: 2, hidden: 3 };
function pairState(a, b) {                                 // the most closed state among the exits joining two regions (either direction)
  let st = 'open', any = false;
  for (const [x, y] of [[a, b], [b, a]]) for (const e of x.exits || []) if (e.to === y.id) { any = true; const s = e.hidden ? 'hidden' : e.blocked ? 'blocked' : e.locked ? 'locked' : 'open'; if (rank[s] > rank[st]) st = s; }
  return any ? st : null;
}
const exitKindOf = (a, b) => { for (const [x, y] of [[a, b], [b, a]]) for (const e of x.exits || []) if (e.to === y.id && e.kind) return e.kind; return ''; };
function gapPos(A, B, side, key) {                         // where along the shared wall the opening is (the same from both sides)
  const ew = side === 'E' || side === 'W';
  let lo = ew ? Math.max(A.z0, B.z0) : Math.max(A.x0, B.x0), hi = ew ? Math.min(A.z1, B.z1) : Math.min(A.x1, B.x1);
  if (hi <= lo) { lo = ew ? A.z0 : A.x0; hi = ew ? A.z1 : A.x1; }
  return (lo + hi) / 2 + (rnd(key) - 0.5) * Math.min(Math.max(0, hi - lo - DW - 1.6), 4);
}
const pairKey = (a, b) => [a.id, b.id].sort().join('|');

// stairs or a ladder between two stacked regions: the same answer from both sides
const vcache = {};
function vspec(a, b) {
  const A = rb(a), B = rb(b), ck = pairKey(a, b) + JSON.stringify([A, B, exitKindOf(a, b)]);
  if (vcache[ck] !== undefined) return vcache[ck];
  let out = null;
  const ox = Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0), oz = Math.min(A.z1, B.z1) - Math.max(A.z0, B.z0);
  if (ox > 2 && oz > 2 && Math.abs(A.y0 - B.y0) >= 1) {
    const lo = B.y0 < A.y0 ? b : a, hi = lo === a ? b : a, LO = lo === a ? A : B, HI = lo === a ? B : A, rise = HI.y0 - LO.y0, key = pairKey(a, b);
    const I = { x0: Math.max(A.x0, B.x0) + 0.6, x1: Math.min(A.x1, B.x1) - 0.6, z0: Math.max(A.z0, B.z0) + 0.6, z1: Math.min(A.z1, B.z1) - 0.6 };
    const kind = exitKindOf(a, b), sides = ['N', 'S', 'E', 'W'], rot = hash(key) % 4, W2 = 3.2, len = Math.max(6, rise * 1.7);
    out = { lo: { id: lo.id }, hi: { id: hi.id }, LO, HI, rise, key, I };
    if (kind !== 'ladder' && kind !== 'hole') {
      for (let i = 0; i < 4 && !out.ramp; i++) {
        const sd = sides[(rot + i) % 4], dir = rnd(key + 'd') < 0.5 ? 1 : -1;
        if ((sd === 'N' || sd === 'S') && I.x1 - I.x0 >= len + 0.2 && I.z1 - I.z0 >= W2) {
          const z0 = sd === 'N' ? I.z0 : I.z1 - W2, x0 = dir > 0 ? I.x0 : I.x1 - len; out.ramp = { x0, x1: x0 + len, z0, z1: z0 + W2, axis: 'x', dir, y0: LO.y0, rise };
        } else if ((sd === 'E' || sd === 'W') && I.z1 - I.z0 >= len + 0.2 && I.x1 - I.x0 >= W2) {
          const x0 = sd === 'W' ? I.x0 : I.x1 - W2, z0 = dir > 0 ? I.z0 : I.z1 - len; out.ramp = { x0, x1: x0 + W2, z0, z1: z0 + len, axis: 'z', dir, y0: LO.y0, rise };
        }
      }
    }
    if (out.ramp) {
      const r = out.ramp, h = { x0: r.x0 - 0.1, x1: r.x1 + 0.1, z0: r.z0 - 0.1, z1: r.z1 + 0.1 };
      if (r.axis === 'x') { if (r.dir > 0) h.x1 -= 1.0; else h.x0 += 1.0; } else { if (r.dir > 0) h.z1 -= 1.0; else h.z0 += 1.0; }
      out.hole = h;
    } else {
      const sd = sides[rot], t = 0.25 + 0.5 * rnd(key + 'l'); let cx, cz;
      if (sd === 'N') { cx = lerp(I.x0, I.x1, t); cz = I.z0 + 0.9; } else if (sd === 'S') { cx = lerp(I.x0, I.x1, t); cz = I.z1 - 0.9; }
      else if (sd === 'E') { cx = I.x1 - 0.9; cz = lerp(I.z0, I.z1, t); } else { cx = I.x0 + 0.9; cz = lerp(I.z0, I.z1, t); }
      out.ladder = { cx, cz, side: sd, y0: LO.y0, y1: HI.y0 }; out.hole = { x0: cx - 0.95, x1: cx + 0.95, z0: cz - 0.95, z1: cz + 0.95 };
    }
  }
  vcache[ck] = out; return out;
}
const rampH = (r, x, z) => r.y0 + r.rise * clamp(r.axis === 'x' ? (r.dir > 0 ? (x - r.x0) / (r.x1 - r.x0) : (r.x1 - x) / (r.x1 - r.x0)) : (r.dir > 0 ? (z - r.z0) / (r.z1 - r.z0) : (r.z1 - z) / (r.z1 - r.z0)), 0, 1);
function subRect(rc, h) {                                  // rectangle minus a hole: up to four rectangles
  if (h.x1 <= rc.x0 || h.x0 >= rc.x1 || h.z1 <= rc.z0 || h.z0 >= rc.z1) return [rc];
  const o = [], hx0 = Math.max(h.x0, rc.x0), hx1 = Math.min(h.x1, rc.x1);
  if (h.z0 > rc.z0) o.push({ x0: rc.x0, x1: rc.x1, z0: rc.z0, z1: h.z0 }); if (h.z1 < rc.z1) o.push({ x0: rc.x0, x1: rc.x1, z0: h.z1, z1: rc.z1 });
  if (h.x0 > rc.x0) o.push({ x0: rc.x0, x1: hx0, z0: Math.max(h.z0, rc.z0), z1: Math.min(h.z1, rc.z1) }); if (h.x1 < rc.x1) o.push({ x0: hx1, x1: rc.x1, z0: Math.max(h.z0, rc.z0), z1: Math.min(h.z1, rc.z1) });
  return o.filter(r => r.x1 - r.x0 > 0.01 && r.z1 - r.z0 > 0.01);
}

// ------------------------------------------------------------------ building one region
function groundColor(p, sea) {
  const b = (p.biome || '') + ' ' + (p.style || '') + ' ' + p.name, fl = p.terrain && p.terrain.floor;
  if (/water|lake|river|pond|sea|shore/i.test(b)) return 0x4a8fd8;
  if (fl === 'sand' || /sand|desert|beach|dune/i.test(b)) return 0xe8d4a0;
  if (fl === 'snow' || /snow|ice|frost/i.test(b)) return 0xf3f8fb;
  if (fl === 'stone' || /cave|rock|mountain|cliff|ruin/i.test(b)) return 0xa9a7ad;
  if (fl === 'dirt') return 0xa5845a;
  if (/glade/i.test(b)) { const c = C(SEA[sea].ground); c.offsetHSL(0.02, 0.05, 0.06); return c.getHex(); }
  const c = C(SEA[sea].ground); c.offsetHSL((rnd(p.id) - 0.5) * 0.03, 0, (rnd(p.id + 'l') - 0.5) * 0.05); return c.getHex();
}
// items are placed on a grid of slots so nothing overlaps; the order is stable
function slotsFor(B, blocked, seed) {
  const cols = Math.max(2, Math.floor((B.w - 3.4) / 3.6)), rows = Math.max(2, Math.floor((B.d - 3.4) / 3.6)), out = [];
  for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
    const x = B.x0 + 1.8 + (B.w - 3.6) * (i + 0.5) / cols, z = B.z0 + 1.8 + (B.d - 3.6) * (j + 0.5) / rows;
    if (!blocked.some(h => x > h.x0 - 1.4 && x < h.x1 + 1.4 && z > h.z0 - 1.4 && z < h.z1 + 1.4) && !(Math.abs(x - B.cx) < 2.4 && Math.abs(z - B.cz) < 2.4 && false)) out.push({ x, z, k: rnd(seed + i + ',' + j) });
  }
  return out.sort((a, b) => a.k - b.k);
}
function addItem(L, G, p, it, B, sea, spot, extra) {
  const nm = (it.name || '').toLowerCase(), x = spot.x, z = spot.z, y = B.y0 + (it.floating ? 0.7 : 0);
  const col = hsl(rnd(nm || it.id), 0.5, 0.6), om = mk(x, y, z, K, K, K, 0, spot.ry || 0, it.broken ? 0.45 : 0);
  const A = (geo, hex, px, py, pz, sx, sy, sz, basic) => (basic ? G : L).addM(geo, hex, new THREE.Matrix4().multiplyMatrices(om, mk(px, py, pz, sx, sy === undefined ? sx : sy, sz === undefined ? sx : sz)));
  const WOOD = 0x9a6a3c, DARK = 0x6b4a2e;
  if (it.kind === 'plot') {
    A(BOX, 0x7a5233, 0, 0.04, 0, 0.95, 0.08, 0.6);
    for (let r = -1; r <= 1; r++) A(BOX, 0x5c3b22, 0, 0.085, r * 0.17, 0.9, 0.025, 0.07);
    if (it.icon) {
      const ripe = !/[\u{1F331}\u{1F33F}]/u.test(it.icon), dry = wilt() > 0.5;
      for (let r = -1; r <= 1; r++) for (let k = 0; k < 4; k++) {
        const px = -0.33 + k * 0.22, pz = r * 0.17;
        A(CONE, dry ? 0x9a7a3a : 0x4fc35a, px, ripe ? 0.2 : 0.14, pz, 0.05, ripe ? 0.26 : 0.16, 0.05);
        if (ripe && !dry) A(SPH, 0xf08a3a, px, 0.1, pz, 0.05, 0.07, 0.05);
      }
    }
  } else if (/bookcase|bookshelf|library|shelf|shelves/.test(nm)) {
    A(BOX, 0x8a5a34, 0, 0.55, 0, 0.9, 1.1, 0.2);
    for (let s = 0; s < 4; s++) A(BOX, 0x6b4527, 0, 0.12 + s * 0.3, 0.02, 0.86, 0.04, 0.2);
    for (let s = 0; s < 3; s++) for (let b = 0; b < 9; b++) A(BOX, hsl(rnd(it.id + s + b), 0.55, 0.55), -0.38 + b * 0.095, 0.27 + s * 0.3, 0.04, 0.07, 0.2 + rnd(it.id + b + s) * 0.06, 0.13);
  } else if (/bed|cot|bunk/.test(nm)) {
    A(BOX, WOOD, 0, 0.12, 0, 1.0, 0.12, 0.56); A(BOX, 0xf4eee2, 0, 0.2, 0, 0.94, 0.08, 0.5); A(BOX, 0x7a5ac0, 0.12, 0.26, 0, 0.62, 0.06, 0.52); A(BOX, 0xffffff, -0.36, 0.28, 0, 0.2, 0.07, 0.34);
    A(BOX, DARK, -0.5, 0.3, 0, 0.04, 0.4, 0.58); A(BOX, DARK, 0.5, 0.2, 0, 0.04, 0.2, 0.58);
  } else if (/table|desk|bench|counter/.test(nm)) {
    A(BOX, 0xb07840, 0, 0.36, 0, 1.0, 0.06, 0.55); for (const [dx, dz] of [[-0.42, -0.2], [0.42, -0.2], [-0.42, 0.2], [0.42, 0.2]]) A(BOX, DARK, dx, 0.17, dz, 0.06, 0.34, 0.06);
  } else if (/chair|stool|seat/.test(nm)) {
    A(BOX, 0x9a6a3c, 0, 0.22, 0, 0.32, 0.05, 0.32); for (const [dx, dz] of [[-0.12, -0.12], [0.12, -0.12], [-0.12, 0.12], [0.12, 0.12]]) A(BOX, DARK, dx, 0.1, dz, 0.04, 0.2, 0.04); A(BOX, 0x9a6a3c, 0, 0.42, -0.14, 0.32, 0.3, 0.04);
  } else if (/chest|trunk/.test(nm)) {
    A(BOX, 0x9a5f2e, 0, 0.17, 0, 0.6, 0.3, 0.38); A(BOX, 0xb26f36, 0, 0.36, 0, 0.62, 0.1, 0.4); A(BOX, 0xe2c04a, 0, 0.26, 0.2, 0.08, 0.14, 0.02, false);
  } else if (/crate|box\b|barrel/.test(nm)) {
    if (/barrel/.test(nm)) { A(CYL, 0x8a5a2e, 0, 0.22, 0, 0.22, 0.44, 0.22); A(CYL, 0x4a3a2a, 0, 0.14, 0, 0.235, 0.03, 0.235); A(CYL, 0x4a3a2a, 0, 0.32, 0, 0.235, 0.03, 0.235); } else A(BOX, 0xa87a44, 0, 0.2, 0, 0.42, 0.4, 0.42);
  } else if (/telescope|spyglass/.test(nm)) {
    for (const a of [0, 2.1, 4.2]) A(CYL, DARK, Math.cos(a) * 0.14, 0.25, Math.sin(a) * 0.14, 0.015, 0.5, 0.015);
    const t = new THREE.Matrix4().multiplyMatrices(om, mk(0, 0.62, 0, 1, 1, 1, 0, 0, -0.7)); L.addM(CYL, 0xe0b44a, new THREE.Matrix4().multiplyMatrices(t, mk(0, 0, 0, 0.06, 0.7, 0.06))); L.addM(CYL, 0x3a3a44, new THREE.Matrix4().multiplyMatrices(t, mk(0, 0.38, 0, 0.075, 0.06, 0.075)));
  } else if (/orb|crystal|gem|sphere/.test(nm)) {
    A(CYL, 0x6b4a2e, 0, 0.1, 0, 0.14, 0.2, 0.14); A(CYL, 0xc9a24a, 0, 0.22, 0, 0.18, 0.03, 0.18); A(SPH, 0xa58cff, 0, 0.4, 0, 0.17, 0.17, 0.17, true); A(SPH, 0xe9e0ff, 0, 0.42, 0.02, 0.08, 0.08, 0.08, true);
  } else if (/cauldron|pot\b|pan\b|kettle/.test(nm)) {
    A(SPH, 0x2c2c34, 0, 0.2, 0, 0.26, 0.2, 0.26); A(CYL, 0x5fe06a, 0, 0.32, 0, 0.2, 0.02, 0.2, true); for (const a of [0, 2.1, 4.2]) A(CYL, 0x2c2c34, Math.cos(a) * 0.18, 0.05, Math.sin(a) * 0.18, 0.03, 0.1, 0.03);
  } else if (/hearth|fireplace|stove|oven/.test(nm)) {
    A(BOX, 0xa7a29a, 0, 0.35, 0, 1.1, 0.7, 0.4); A(BOX, 0x2a1d16, 0, 0.26, 0.12, 0.6, 0.42, 0.2); if (S.world && S.world.fire) { A(CONE, 0xff9a2a, 0, 0.18, 0.12, 0.2, 0.3, 0.2, true); A(CONE, 0xffe36a, 0, 0.14, 0.12, 0.1, 0.18, 0.1, true); }
    A(BOX, 0x8f8a82, 0, 0.78, -0.05, 0.5, 0.35, 0.3); extra.hearth = { x, y: y + 1.9 * K / 3, z: z + 0.1 };
  } else if (/torch|lamp|candle|lantern/.test(nm)) {
    A(CYL, DARK, 0, 0.2, 0, 0.03, 0.4, 0.03); A(SPH, 0xffb24a, 0, 0.45, 0, 0.07, 0.09, 0.07, true);
  } else if (/scarecrow/.test(nm)) {
    A(CYL, DARK, 0, 0.5, 0, 0.03, 1.0, 0.03); A(BOX, DARK, 0, 0.75, 0, 0.7, 0.03, 0.03); A(SPH, 0xe8d5a0, 0, 0.96, 0, 0.1, 0.1, 0.1); A(CONE, 0x6b4a2e, 0, 1.12, 0, 0.14, 0.2, 0.14); A(BOX, 0xc7a040, 0, 0.62, 0, 0.3, 0.3, 0.1);
  } else if (/book|tome|grimoire/.test(nm) || it.kind === 'book') {
    A(BOX, col, 0, 0.05, 0, 0.34, 0.09, 0.25); A(BOX, 0xf7efd8, 0.02, 0.055, 0, 0.3, 0.07, 0.22);
  } else if (it.kind === 'letter' || /letter|scroll|note|slate|phone|bulletin/.test(nm)) {
    A(BOX, 0xfbf6ea, 0, 0.02, 0, 0.22, 0.03, 0.16);
  } else if (/tree|oak|stump|log/.test(nm)) {
    A(CYL, 0x7a5535, 0, 0.35, 0, 0.18, 0.7, 0.18); if (!/stump|log/.test(nm)) A(SPH, SEA[sea].leaf || 0xf4f8fb, 0, 0.95, 0, 0.5, 0.45, 0.5);
  } else if (it.kind === 'plant' || /plant|flower|bush|herb|mushroom|sprout|fern|moss|lichen|petal|berr/.test(nm)) {
    A(CYL, 0x3f8a3f, 0, 0.14, 0, 0.02, 0.28, 0.02); A(SPH, wilt() > 0.5 ? 0xa08040 : (/mushroom|glowcap/.test(nm) ? 0xf2e0c0 : hsl(rnd(nm), 0.65, 0.62)), 0, 0.3, 0, 0.13, 0.1, 0.13); A(CONE, wilt() > 0.5 ? 0x9a7a3a : 0x4fc35a, 0.1, 0.1, 0.05, 0.06, 0.2, 0.06); A(CONE, 0x4fc35a, -0.1, 0.09, -0.04, 0.06, 0.18, 0.06);
  } else {
    const v = hash(it.id) % 3;
    if (v === 0) A(BOX, col, 0, 0.12, 0, 0.26, 0.24, 0.26); else if (v === 1) { A(SPH, col, 0, 0.14, 0, 0.15, 0.15, 0.15); } else { A(CYL, col, 0, 0.14, 0, 0.1, 0.28, 0.1); A(SPH, 0xffffff, 0, 0.3, 0, 0.06, 0.06, 0.06); }
  }
  if (it.price) A(SPH, 0xffd34d, 0, 0.9, 0, 0.06, 0.06, 0.06, true);
}
// varied trees: pine, round, birch, bush
function tree(L, x, y, z, sea, r, kind) {
  const leaf = SEA[sea].leaf, h = 3 + r * 3.2, k = kind || (r < 0.35 ? 'pine' : r < 0.7 ? 'round' : r < 0.85 ? 'birch' : 'bush');
  const tint = (hex, d) => { const c = C(hex); c.offsetHSL((r - 0.5) * 0.04, 0, d); return c.getHex(); };
  if (k === 'bush') { L.addM(SPH, leaf ? tint(leaf, -0.05) : 0xe8eef2, mk(x, y + 0.5, z, 0.9 + r * 0.4, 0.65, 0.9 + r * 0.4)); return; }
  L.addM(CYL, k === 'birch' ? 0xe8e4d8 : 0x7a5535, mk(x, y + h * 0.28, z, k === 'pine' ? 0.18 : 0.22, h * 0.56, k === 'pine' ? 0.18 : 0.22));
  if (k === 'pine') for (let i = 0; i < 3; i++) L.addM(CONE, leaf ? tint(sea === 'autumn' ? 0x3f7a45 : 0x2f8a4a, -0.04 * i) : 0xe8f0f3, mk(x, y + h * 0.5 + i * h * 0.22, z, 1.5 - i * 0.38, h * 0.38, 1.5 - i * 0.38));
  else if (k === 'birch') { if (leaf) L.addM(SPH, tint(leaf, 0.08), mk(x, y + h * 0.7, z, 1.0, 1.25, 1.0)); else L.addM(CONE, 0xf4f8fb, mk(x, y + h * 0.8, z, 0.5, 0.5, 0.5)); }
  else if (leaf) { L.addM(SPH, tint(leaf, 0), mk(x, y + h * 0.72, z, 1.55, 1.25, 1.55)); L.addM(SPH, tint(leaf, 0.06), mk(x + 0.7, y + h * 0.58, z + 0.3, 1.0, 0.85, 1.0)); L.addM(SPH, tint(leaf, -0.05), mk(x - 0.6, y + h * 0.62, z - 0.4, 0.9, 0.8, 0.9)); }
  else { L.addM(CONE, 0xf4f8fb, mk(x, y + h * 0.78, z, 0.6, 0.5, 0.6)); L.addM(CYL, 0x7a5535, mk(x + 0.5, y + h * 0.6, z, 0.06, 0.9, 0.06, 0, 0, -0.9)); }
}

function regionSig(p) {
  const t = tower(), nb = p.exits.map(e => { const q = byId[e.to]; return [e.to, e.dir, e.kind, !!e.locked, !!e.hidden, !!e.blocked, q ? [q.gx, q.gy, q.gz, q.span] : 0]; });
  return JSON.stringify([p.id, p.gx, p.gy, p.gz, p.span, p.outdoor, p.biome, p.style, p.terrain, p.ambient, p.lit, p.scenery, !!p.under_construction, !!p.damaged, nb,
    p.items.map(i => [i.id, i.name, i.icon, i.broken, i.floating, i.kind, i.price, i.pos]), season(), p.outdoor ? 0 : Math.round(t.dust / 10), p.outdoor ? 0 : Math.round(t.mess / 10), p.outdoor ? 0 : Math.round(t.cold / 10),
    Math.round(wilt() * 5), Q.scenery, isNight(), !!(S.world && S.world.fire)]);
}
const loaded = {};                                         // id -> {group, sig, col, B, roof, hearth}
function dropRegion(id) {
  const r = loaded[id]; if (!r) return;
  world.remove(r.group); r.group.traverse(o => { if (o.geometry && !o.userData.shared) o.geometry.dispose(); });
  delete loaded[id];
}
function buildRegion(p) {
  const sea = season(), tw = tower(), B = rb(p), L = new Batch(false), G = new Batch(true), extra = new THREE.Group(), meta = {};
  const col = { walls: [], floors: [], ramps: [], ladders: [], blocked: [] };      // blocked: rects where things must not be placed
  const indoor = !p.outdoor, gray = C(0x9a9a9d), cold = C(0xb8d0ff), night = isNight();
  let floorHex = p.outdoor ? groundColor(p, sea) : (FLOOR[p.terrain && p.terrain.floor] || (p.style === 'wood' ? FLOOR.wood : FLOOR.stone));
  let wallC = p.style === 'wood' ? C(0xc58f5a) : C(hsl(0.09 + 0.04 * rnd(p.id), 0.22, 0.74));
  if (p.terrain && p.terrain.shape === 'cave') wallC = C(0x9a95a0);
  if (p.damaged) wallC.lerp(C(0x6a5e52), 0.5);
  if (indoor) { const f = C(floorHex); f.lerp(gray, tw.dust / 100 * 0.3); f.lerp(cold, tw.cold / 100 * 0.15); floorHex = f.getHex(); wallC.lerp(gray, tw.dust / 100 * 0.3); wallC.lerp(cold, tw.cold / 100 * 0.2); }
  const wallHex = wallC.getHex(), trim = C(wallHex).offsetHSL(0, 0, -0.1).getHex();
  // floor, with holes where stairs or ladders come up from a region below
  const holes = [], ups = [];
  for (const e of p.exits) {
    const q = byId[e.to]; if (!q) continue;
    const A = B, T = rb(q); if (sideOf(A, T) !== 'U' && sideOf(A, T) !== 'D') continue;
    const v = vspec(p, q), st = pairState(p, q); if (!v) continue;
    if (v.hi.id === p.id && st === 'open') holes.push(v.hole);
    if (v.hi.id === p.id && st !== 'open' && st !== null) { const h = v.hole, cxh = (h.x0 + h.x1) / 2, czh = (h.z0 + h.z1) / 2;       // a closed way down: a plate, rubble or a seam
      if (st === 'locked') L.box(0xa03a3a, cxh, B.y0 + 0.05, czh, h.x1 - h.x0, 0.1, h.z1 - h.z0);
      else if (st === 'blocked') for (let k = 0; k < 4; k++) L.box(0x8a867e, cxh + (rnd(p.id + 'rb' + k) - 0.5) * 1.2, B.y0 + 0.2, czh + (rnd(p.id + 'rz' + k) - 0.5) * 1.2, 0.7, 0.4, 0.6, rnd(p.id + 'rr' + k) * 3);
      else L.box(0xd8d0c0, cxh, B.y0 + 0.01, czh, h.x1 - h.x0, 0.02, 0.05); }
    if (v.lo.id === p.id && st === 'open') ups.push(v);
  }
  let rects = [{ x0: B.x0, x1: B.x1, z0: B.z0, z1: B.z1 }];
  for (const h of holes) rects = rects.flatMap(r => subRect(r, h));
  for (const r of rects) { L.box(floorHex, (r.x0 + r.x1) / 2, B.y0 - SLAB / 2, (r.z0 + r.z1) / 2, r.x1 - r.x0, SLAB, r.z1 - r.z0); col.floors.push({ ...r, top: B.y0 }); }
  if (indoor) for (const r of rects) { const k = 3; for (let i = 0; i < k; i++) L.box(C(floorHex).offsetHSL(0, 0, -0.025).getHex(), r.x0 + (r.x1 - r.x0) * (i + 0.5) / k, B.y0 + 0.006, (r.z0 + r.z1) / 2, (r.x1 - r.x0) / k - 0.1, 0.012, r.z1 - r.z0 - 0.1); }   // plank/flag lines
  for (const h of holes) col.blocked.push(h);
  // stairs and ladders going up from here
  for (const v of ups) {
    col.blocked.push({ x0: v.hole.x0 - 0.4, x1: v.hole.x1 + 0.4, z0: v.hole.z0 - 0.4, z1: v.hole.z1 + 0.4 });
    if (v.ramp) {
      const r = v.ramp, n = Math.max(6, Math.min(16, Math.round(v.rise / 0.45))); col.ramps.push(r);
      for (let i = 0; i < n; i++) {
        const t0 = i / n, t1 = (i + 1) / n, top = r.y0 + v.rise * (i + 0.5) / n, hgt = top - r.y0;
        if (r.axis === 'x') { const a0 = r.dir > 0 ? lerp(r.x0, r.x1, t0) : lerp(r.x1, r.x0, t0), a1 = r.dir > 0 ? lerp(r.x0, r.x1, t1) : lerp(r.x1, r.x0, t1); L.box(i % 2 ? 0xa8856a : 0xb8957a, (a0 + a1) / 2, r.y0 + hgt / 2, (r.z0 + r.z1) / 2, Math.abs(a1 - a0), hgt, r.z1 - r.z0); }
        else { const a0 = r.dir > 0 ? lerp(r.z0, r.z1, t0) : lerp(r.z1, r.z0, t0), a1 = r.dir > 0 ? lerp(r.z0, r.z1, t1) : lerp(r.z1, r.z0, t1); L.box(i % 2 ? 0xa8856a : 0xb8957a, (r.x0 + r.x1) / 2, r.y0 + hgt / 2, (a0 + a1) / 2, r.x1 - r.x0, hgt, Math.abs(a1 - a0)); }
      }
    } else {
      const l = v.ladder, top = v.HI.y0 + 1.1; col.ladders.push(l);
      for (const dx of [-0.45, 0.45]) L.box(0xa87a44, l.cx + (l.side === 'N' || l.side === 'S' ? dx : 0), (B.y0 + top) / 2, l.cz + (l.side === 'E' || l.side === 'W' ? dx : 0), 0.08, top - B.y0, 0.08);
      for (let y = B.y0 + 0.5; y < top; y += 0.5) L.box(0xa87a44, l.cx, y, l.cz, l.side === 'N' || l.side === 'S' ? 0.9 : 0.06, 0.06, l.side === 'E' || l.side === 'W' ? 0.9 : 0.06);
    }
  }
  // walls (indoor regions and caves), thin, with openings per exit and windows
  if (indoor) {
    const gaps = { N: [], S: [], E: [], W: [] };
    for (const e of p.exits) {
      const q = byId[e.to]; if (!q) continue;
      const T = rb(q), sd = sideOf(B, T); if (!gaps[sd]) continue;
      if (gaps[sd].some(g => g.to === q.id)) continue;
      const st = pairState(p, q) || 'open';
      gaps[sd].push({ to: q.id, st, at: gapPos(B, T, sd, pairKey(p, q)), wide: e.kind === 'arch' || e.kind === 'path' ? 6 : DW });
    }
    const wallH = sd => (sd === 'S' ? Math.min(LOWW, B.h) : sd === 'N' ? B.h : Math.min(B.h, 3.4));
    for (const sd of ['N', 'S', 'E', 'W']) {
      const ew = sd === 'E' || sd === 'W', lo = ew ? B.z0 : B.x0, hi = ew ? B.z1 : B.x1, fix = sd === 'N' ? B.z0 + WT / 2 : sd === 'S' ? B.z1 - WT / 2 : sd === 'E' ? B.x1 - WT / 2 : B.x0 + WT / 2, wh = wallH(sd);
      const gs = gaps[sd].slice().sort((a, b) => a.at - b.at);
      const seg = (a, b, y0, y1) => {
        if (b - a < 0.02 || y1 - y0 < 0.02) return;
        const cx = ew ? fix : (a + b) / 2, cz = ew ? (a + b) / 2 : fix, sx = ew ? WT : b - a, sz = ew ? b - a : WT;
        L.box(wallHex, cx, B.y0 + (y0 + y1) / 2, cz, sx, y1 - y0, sz);
        if (y0 === 0) { L.box(trim, cx, B.y0 + y1 - 0.06, cz, sx + (ew ? 0.08 : 0), 0.12, sz + (ew ? 0 : 0.08)); col.walls.push({ x0: cx - sx / 2, x1: cx + sx / 2, z0: cz - sz / 2, z1: cz + sz / 2, y0: B.y0, y1: B.y0 + y1 }); }
      };
      let cur = lo;
      for (const g of gs) {
        const a = g.at - g.wide / 2, b = g.at + g.wide / 2;
        if (g.st === 'hidden') continue;                    // looks like solid wall; the seam is drawn below
        seg(cur, a, 0, wh); if (wh > DH) seg(a, b, DH, wh);
        const gc = ew ? [fix, (a + b) / 2] : [(a + b) / 2, fix];
        if (g.st === 'locked') { L.box(0x9a3a3a, gc[0], B.y0 + Math.min(DH, wh) / 2, gc[1], ew ? WT * 0.7 : g.wide, Math.min(DH, wh), ew ? g.wide : WT * 0.7); L.box(0xe2c04a, gc[0], B.y0 + 1.4, gc[1], ew ? 0.4 : 0.35, 0.3, ew ? 0.35 : 0.4); col.walls.push({ x0: gc[0] - (ew ? WT / 2 : g.wide / 2), x1: gc[0] + (ew ? WT / 2 : g.wide / 2), z0: gc[1] - (ew ? g.wide / 2 : WT / 2), z1: gc[1] + (ew ? g.wide / 2 : WT / 2), y0: B.y0, y1: B.y0 + Math.min(DH, wh) }); }
        if (g.st === 'blocked') { for (let k = 0; k < 7; k++) L.box(0x8a867e, gc[0] + (ew ? (rnd(p.id + 'q' + k) - 0.5) * 0.8 : (rnd(p.id + 'q' + k) - 0.5) * g.wide * 0.8), B.y0 + 0.4 + rnd(p.id + 'qy' + k) * 0.9, gc[1] + (ew ? (rnd(p.id + 'qz' + k) - 0.5) * g.wide * 0.8 : (rnd(p.id + 'qz' + k) - 0.5) * 0.8), 0.9, 0.7, 0.9, rnd(p.id + 'qr' + k) * 3);
          col.walls.push({ x0: gc[0] - (ew ? WT : g.wide / 2), x1: gc[0] + (ew ? WT : g.wide / 2), z0: gc[1] - (ew ? g.wide / 2 : WT), z1: gc[1] + (ew ? g.wide / 2 : WT), y0: B.y0, y1: B.y0 + 3 }); }
        cur = b;
      }
      for (const g of gs) if (g.st === 'hidden') { const gc = ew ? [fix, g.at] : [g.at, fix]; L.box(0xcfc4b4, gc[0], B.y0 + 1.8, gc[1], ew ? WT + 0.04 : 0.05, 3.2, ew ? 0.05 : WT + 0.04); }
      seg(cur, hi, 0, wh);
      // windows (glow warm at night, pale sky by day) on tall walls without a gap there
      if (wh >= 3.4 && !(p.terrain && p.terrain.shape === 'cave')) for (let k = 0; k < 2; k++) {
        const at = lo + (hi - lo) * (k ? 0.76 : 0.24); if (gs.some(g => Math.abs(g.at - at) < g.wide / 2 + 1)) continue;
        const gc = ew ? [fix + (sd === 'E' ? -0.02 : 0.02), at] : [at, fix + (sd === 'N' ? 0.02 : -0.02)];
        G.box(night ? 0xffd27a : 0xa8d8f2, gc[0], B.y0 + 2.5, gc[1], ew ? 0.06 : 1.3, 1.5, ew ? 1.3 : 0.06); L.box(0x8a5a34, gc[0], B.y0 + 2.5, gc[1], ew ? 0.04 : 1.5, 1.7, ew ? 1.5 : 0.04);
      }
    }
    if (p.lit || night) { const m = new THREE.Mesh(SPH, new THREE.MeshBasicMaterial({ color: 0xffd98a, transparent: true, opacity: p.lit ? 0.14 : 0.07, depthWrite: false })); m.userData.shared = true; m.position.set(B.cx, B.y0 + B.h * 0.5, B.cz); m.scale.set(B.w * 0.42, B.h * 0.42, B.d * 0.42); extra.add(m); }
    const tx = B.x0 + B.w * (0.3 + 0.4 * rnd(p.id + 'torch'));                                     // a wall torch
    L.box(0x5a4a3a, tx, B.y0 + 2.6, B.z0 + 0.45, 0.1, 0.5, 0.1); G.addM(SPH, 0xffb24a, mk(tx, B.y0 + 3.0, B.z0 + 0.45, 0.14, 0.2, 0.14));
    const nd = Math.round(tw.dust / 100 * 10), nm = Math.round(tw.mess / 100 * 12);
    for (let k = 0; k < nd; k++) L.box(0x9a9890, B.x0 + 1 + (B.w - 2) * rnd(p.id + 'd' + k), B.y0 + 0.015, B.z0 + 1 + (B.d - 2) * rnd(p.id + 'dz' + k), 0.8 + rnd(p.id + 'ds' + k), 0.02, 0.6 + rnd(p.id + 'dt' + k));
    for (let k = 0; k < nm; k++) L.box(hsl(rnd(p.id + 'mc' + k), 0.4, 0.55), B.x0 + 1 + (B.w - 2) * rnd(p.id + 'm' + k), B.y0 + 0.1, B.z0 + 1 + (B.d - 2) * rnd(p.id + 'mz' + k), 0.2 + rnd(p.id + 'ms' + k) * 0.25, 0.12, 0.2 + rnd(p.id + 'mt' + k) * 0.2, rnd(p.id + 'mr' + k) * 3);
    // a pitched roof for a house with nothing above it (hidden while he is inside)
    const stacked = Object.values(byId).some(q => q.gx === p.gx && q.gy === p.gy && q.gz > p.gz);
    if (!stacked && p.gz >= 0 && B.h <= HT + 0.1) {
      const roof = new THREE.Group(), rc = p.style === 'wood' ? 0x9a4a32 : 0x8f5a48, ang = Math.atan2(2.4, B.d / 2);
      for (const sgn of [-1, 1]) { const m = new THREE.Mesh(BOX, mat(rc)); m.userData.shared = true; m.scale.set(B.w + 1, 0.25, Math.hypot(B.d / 2, 2.4) + 0.6); m.position.set(B.cx, B.y0 + B.h + 1.25, B.cz + sgn * (B.d / 4 + 0.1)); m.rotation.x = sgn * ang; roof.add(m); }
      const gb = new THREE.Mesh(BOX, mat(wallHex)); gb.userData.shared = true; gb.scale.set(B.w + 0.9, 0.3, 0.3); gb.position.set(B.cx, B.y0 + B.h + 2.35, B.cz); roof.add(gb);
      meta.roof = roof;
    }
  } else {
    // a road where there is a way on, and a gate or rubble where there is not
    for (const e of p.exits) {
      const q = byId[e.to]; if (!q) continue; const T = rb(q), sd = sideOf(B, T); if (!'NSEW'.includes(sd || '-')) continue;
      const st = pairState(p, q); if (!st || st === 'hidden') continue; const at = gapPos(B, T, sd, pairKey(p, q)), ew = sd === 'E' || sd === 'W';
      const bx = sd === 'E' ? B.x1 - 0.3 : sd === 'W' ? B.x0 + 0.3 : at, bz = sd === 'N' ? B.z0 + 0.3 : sd === 'S' ? B.z1 - 0.3 : at;
      if (st === 'open') { const x1 = ew ? bx : at, z1 = ew ? at : bz, len = Math.hypot(x1 - B.cx, z1 - B.cz); L.box(0xc4ad7a, (x1 + B.cx) / 2, B.y0 + 0.015, (z1 + B.cz) / 2, ew ? len : 2.6, 0.03, ew ? 2.6 : len, 0); continue; }
      if (st === 'locked') { L.box(0x9a3a3a, bx, B.y0 + 1.2, bz, ew ? 0.3 : DW, 2.4, ew ? DW : 0.3); col.walls.push({ x0: bx - (ew ? 0.2 : DW / 2), x1: bx + (ew ? 0.2 : DW / 2), z0: bz - (ew ? DW / 2 : 0.2), z1: bz + (ew ? DW / 2 : 0.2), y0: B.y0, y1: B.y0 + 2.4 }); }
      else if (st === 'blocked') { for (let k = 0; k < 6; k++) L.box(0x8a867e, bx + (ew ? (rnd(p.id + 'q' + k) - 0.5) * 0.8 : (rnd(p.id + 'q' + k) - 0.5) * DW), B.y0 + 0.4 + rnd(p.id + 'qy' + k) * 0.8, bz + (ew ? (rnd(p.id + 'qz' + k) - 0.5) * DW : (rnd(p.id + 'qz' + k) - 0.5) * 0.8), 1, 0.8, 1, rnd(p.id + 'qr' + k) * 3);
        col.walls.push({ x0: bx - (ew ? 0.5 : DW / 2), x1: bx + (ew ? 0.5 : DW / 2), z0: bz - (ew ? DW / 2 : 0.5), z1: bz + (ew ? DW / 2 : 0.5), y0: B.y0, y1: B.y0 + 2.4 }); }
    }
    // a raised roof platform gets a little canopy on posts
    if (/roof/i.test(p.name + p.id) && p.gz > 0) {
      for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) L.box(0xa8856a, B.cx + dx * B.w * 0.36, B.y0 + 2.2, B.cz + dz * B.d * 0.36, 0.3, 4.4, 0.3);
      L.addM(CONE, 0xb5523b, mk(B.cx, B.y0 + 6.6, B.cz, B.w * 0.62, 4.2, B.w * 0.62, 0, 0.78, 0));
    }
    if (Q.scenery && !(p.gz > 0)) {
      const wood = /forest|wood|grove|jungle|pines|hollow|oak/i.test((p.biome || '') + p.name);
      const sc = p.scenery && p.scenery.length ? p.scenery : null;
      if (sc) for (const s of sc) {
        const x = B.x0 + 1 + (B.w - 2) * (s.pos ? s.pos[0] : rnd(p.id + s.shape)), z = B.z0 + 1 + (B.d - 2) * (s.pos ? s.pos[1] : rnd(p.id + s.shape + 'z')), z3 = s.size || [1, 1, 1];
        if (s.shape === 'tree') tree(L, x, B.y0, z, sea, rnd(p.id + x));
        else if (s.shape === 'rock') L.addM(SPH, s.color || 0x9a9aa0, mk(x, B.y0 + z3[1] * 0.3, z, z3[0], z3[1] * 0.6, z3[2]));
        else if (s.shape === 'pillar') L.addM(CYL, s.color || 0xd0cac0, mk(x, B.y0 + z3[1] / 2, z, z3[0] * 0.5, z3[1], z3[2] * 0.5));
        else if (s.shape === 'cone') L.addM(CONE, s.color || 0x9a9aa0, mk(x, B.y0 + z3[1] / 2, z, z3[0], z3[1], z3[2]));
        else L.box(s.color || 0x9a6a40, x, B.y0 + z3[1] / 2, z, z3[0], z3[1], z3[2]);
      } else {
        const n = wood ? 12 : /farm|meadow/i.test(p.name + p.id) ? 3 : 5;
        for (let k = 0; k < n; k++) {
          let x = B.x0 + 1.6 + (B.w - 3.2) * rnd(p.id + 'tx' + k), z = B.z0 + 1.6 + (B.d - 3.2) * rnd(p.id + 'tz' + k);
          if (Math.abs(x - B.cx) < 3.4) x += x < B.cx ? -3.4 : 3.4; if (Math.abs(z - B.cz) < 3.4) z += z < B.cz ? -3.4 : 3.4;     // keep the roads between regions clear
          if (x > B.x0 + 0.8 && x < B.x1 - 0.8 && z > B.z0 + 0.8 && z < B.z1 - 0.8) tree(L, x, B.y0, z, sea, rnd(p.id + 'th' + k), wood ? undefined : (k % 3 ? 'bush' : 'round'));
        }
        for (let k = 0; k < (wood ? 7 : 12); k++) {            // grass tufts, flowers and little rocks
          const x = B.x0 + 1 + (B.w - 2) * rnd(p.id + 'fx' + k), z = B.z0 + 1 + (B.d - 2) * rnd(p.id + 'fz' + k);
          if (k % 3 === 0) L.addM(SPH, 0x9a9aa0, mk(x, B.y0 + 0.15, z, 0.4, 0.25, 0.35)); else { L.addM(CONE, hsl(0.28, 0.5, 0.5), mk(x, B.y0 + 0.2, z, 0.12, 0.4, 0.12)); if (sea !== 'winter') L.addM(SPH, hsl(rnd(p.id + 'fc' + k), 0.8, 0.65), mk(x + 0.15, B.y0 + 0.3, z, 0.1, 0.1, 0.1)); }
        }
      }
    }
  }
  if (p.under_construction) {                              // scaffolding: posts and cross beams
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) L.box(0xb88a52, B.cx + dx * B.w * 0.3, B.y0 + 1.6, B.cz + dz * B.d * 0.3, 0.2, 3.2, 0.2);
    L.box(0xb88a52, B.cx, B.y0 + 3.2, B.cz - B.d * 0.3, B.w * 0.6, 0.15, 0.15); L.box(0xb88a52, B.cx, B.y0 + 3.2, B.cz + B.d * 0.3, B.w * 0.6, 0.15, 0.15);
  }
  if (p.damaged) for (let k = 0; k < 6; k++) L.box(0x6a645a, B.x0 + 1.5 + (B.w - 3) * rnd(p.id + 'x' + k), B.y0 + 0.2, B.z0 + 1.5 + (B.d - 3) * rnd(p.id + 'y' + k), 0.7, 0.4, 0.6, rnd(p.id + 'c' + k) * 3);
  // items on a grid of slots; big furniture goes against a wall
  const slots = slotsFor(B, col.blocked.concat(col.ramps.map(r => ({ x0: r.x0, x1: r.x1, z0: r.z0, z1: r.z1 }))), p.id);
  let si = 0;
  for (const it of p.items) {
    let spot;
    const nm = (it.name || '').toLowerCase();
    if (it.pos) spot = { x: B.x0 + 1.8 + (B.w - 3.6) * it.pos[0], z: B.z0 + 1.8 + (B.d - 3.6) * it.pos[1] };
    else if (indoor && /bookcase|bookshelf|library|shelf/.test(nm)) { const s = slots[si++ % Math.max(1, slots.length)] || { x: B.cx, z: B.cz }; spot = { x: s.x, z: B.z0 + 0.8, ry: 0 }; }
    else if (indoor && /bed|cot|bunk/.test(nm)) spot = { x: B.x1 - 2.6, z: B.z0 + 2.0 };
    else spot = slots[si++ % Math.max(1, slots.length)] || { x: B.cx, z: B.cz };
    addItem(L, G, p, it, B, sea, spot, meta);
  }
  const group = new THREE.Group(), m1 = L.mesh(), m2 = G.mesh();
  if (m1) group.add(m1); if (m2) group.add(m2); group.add(extra);
  if (meta.roof) group.add(meta.roof);
  group.userData.id = p.id; world.add(group);
  return { group, col, B, id: p.id, roof: meta.roof || null, hearth: meta.hearth || null };
}


// ------------------------------------------------------------------ which regions are built
const focus = { x: 0, y: 0, z: 0 };
let CO = { walls: [], floors: [], ramps: [], ladders: [] }, coSig = '';
function ensureRegions() {
  const P = S.places || []; if (!P.length) return;
  const fp = byId[S.place], pts = [];
  if (fp) pts.push(fp);
  const av = mode !== 'watch' && cam3.init ? regionAt(cam3.pos.x, cam3.pos.y, cam3.pos.z) : null; if (av) pts.push(av);
  else if (mode !== 'watch' && cam3.init) pts.push({ gx: Math.round(cam3.pos.x / CELL), gy: Math.round(-cam3.pos.z / CELL), gz: Math.floor(cam3.pos.y / HT) });
  const rad = Math.max(1, (mode === 'watch' ? 3 : 2) - Q.radDrop);
  const want = new Set();
  for (const p of P) for (const f of pts) if (Math.abs(p.gx - f.gx) <= rad && Math.abs(p.gy - f.gy) <= rad && Math.abs(p.gz - f.gz) <= Math.min(rad, 3)) { want.add(p.id); break; }
  for (const id in loaded) if (!want.has(id) && !pts.some(f => { const p = byId[id]; return p && Math.abs(p.gx - f.gx) <= rad + 1 && Math.abs(p.gy - f.gy) <= rad + 1 && Math.abs(p.gz - f.gz) <= 3; })) dropRegion(id);
  let changed = false;
  for (const id of want) {
    const p = byId[id], sg = regionSig(p);
    if (!loaded[id] || loaded[id].sig !== sg) { dropRegion(id); const r = buildRegion(p); r.sig = sg; loaded[id] = r; changed = true; }
  }
  const sig = Object.keys(loaded).sort().join(',') + changed;
  if (changed || sig !== coSig) { CO = { walls: [], floors: [], ramps: [], ladders: [] }; for (const id in loaded) for (const k in CO) CO[k].push(...loaded[id].col[k]); coSig = sig; dirty = true; }
  cutaway();
}
// the regions stacked above where he (or I) stand hide only when the camera looks down steeply or is inside; the roof of the house he is in is always lifted off
function cutaway() {
  const fp = byId[S.place], av = mode !== 'watch' && cam3.init ? regionAt(cam3.pos.x, cam3.pos.y, cam3.pos.z) : null, f0 = mode === 'watch' || PUBLIC ? fp : (av || fp);
  const steep = (mode === 'watch' || PUBLIC) ? watch.el > 0.72 : mode === 'walk';
  for (const id in loaded) {
    const p = byId[id], r = loaded[id];
    r.group.visible = !(f0 && mode !== 'fly' && steep && p.gz > f0.gz && Math.abs(p.gx - f0.gx) < 1.01 && Math.abs(p.gy - f0.gy) < 1.01);
    if (r.roof) r.roof.visible = !(f0 && Math.abs(p.gx - f0.gx) <= 1 && Math.abs(p.gy - f0.gy) <= 1);
  }
}
function regionAt(x, y, z) {
  let best = null, bd = 1e9;
  for (const id in byId) { const B = rb(byId[id]); if (x >= B.x0 && x <= B.x1 && z >= B.z0 && z <= B.z1 && y >= B.y0 - 0.6 && y <= B.y1 + 0.6) { const d = Math.abs(y - B.y0 - 0.6); if (d < bd) { bd = d; best = byId[id]; } } }
  return best;
}

// ------------------------------------------------------------------ sky, ground, clouds, stars, weather (the sky follows the hour)
const SKY = {
  night: [C(0x0b1236), C(0x24336a)], dawn: [C(0x6a8ad0), C(0xffb88a)], day: [C(0x4f9fe6), C(0xcfe9fa)], dusk: [C(0x5a62b8), C(0xff9a62)],
};
const skyGeo = new THREE.SphereGeometry(450, 18, 12), skyCol = new Float32Array(skyGeo.attributes.position.count * 3);
skyGeo.setAttribute('color', new THREE.BufferAttribute(skyCol, 3));
const skyMesh = new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false })); skyMesh.renderOrder = -10; scene.add(skyMesh);
const starGeo = new THREE.BufferGeometry(), starPos = []; for (let i = 0; i < 260; i++) { const u = rnd('s' + i) * 6.283, v = 0.08 + rnd('t' + i) * 0.92, r = Math.sqrt(1 - v * v) * 430; starPos.push(Math.cos(u) * r, v * 430, Math.sin(u) * r); }
starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false })); scene.add(stars);
const sunMesh = new THREE.Mesh(SPH, new THREE.MeshBasicMaterial({ color: 0xfff0b0, fog: false })); sunMesh.scale.setScalar(16); scene.add(sunMesh);
const moonMesh = new THREE.Mesh(SPH, new THREE.MeshBasicMaterial({ color: 0xf2f2e6, fog: false })); moonMesh.scale.setScalar(11); scene.add(moonMesh);
const groundGeo = new THREE.PlaneGeometry(1200, 1200, 40, 40); groundGeo.rotateX(-Math.PI / 2);
const gcol = new Float32Array(groundGeo.attributes.position.count * 3); groundGeo.setAttribute('color', new THREE.BufferAttribute(gcol, 3));
const ground = new THREE.Mesh(groundGeo, new THREE.MeshLambertMaterial({ vertexColors: true })); ground.position.y = -0.45; scene.add(ground);
let groundSea = '';
function paintGround() {
  const sea = season(); if (sea === groundSea) return; groundSea = sea;
  const base = C(SEA[sea].ground), c = new THREE.Color(), pa = groundGeo.attributes.position;
  for (let i = 0; i < pa.count; i++) { const x = pa.getX(i), z = pa.getZ(i), n = Math.sin(x * 0.045) * Math.cos(z * 0.05) * 0.5 + Math.sin(x * 0.13 + z * 0.09) * 0.3 + rnd('g' + i) * 0.2; c.copy(base).offsetHSL(n * 0.025, n * 0.04, n * 0.07 - 0.03); gcol[i * 3] = c.r; gcol[i * 3 + 1] = c.g; gcol[i * 3 + 2] = c.b; }
  groundGeo.attributes.color.needsUpdate = true;
}
const fxGroup = new THREE.Group(); scene.add(fxGroup);                // clouds, smoke, fireflies, rain/snow: all dropped on Low
const clouds = []; for (let i = 0; i < 9; i++) { const g = new THREE.Group(); for (let k = 0; k < 4; k++) add(g, SPH, 0xffffff, (k - 1.5) * 6, rnd('c' + i + k) * 2, rnd('d' + i + k) * 4, 7 + rnd('e' + i + k) * 3, 2.6, 5); g.position.set(-260 + i * 65, 55 + rnd('h' + i) * 25, -200 + rnd('z' + i) * 400); g.userData.v = 1.2 + rnd('v' + i) * 1.5; fxGroup.add(g); clouds.push(g); }
const FF = 28, ffPos = new Float32Array(FF * 3), ffGeo = new THREE.BufferGeometry(); ffGeo.setAttribute('position', new THREE.BufferAttribute(ffPos, 3));
const fireflies = new THREE.Points(ffGeo, new THREE.PointsMaterial({ color: 0xf4ff7a, size: 5, sizeAttenuation: false, transparent: true, opacity: 0.9, depthWrite: false })); fireflies.frustumCulled = false; fxGroup.add(fireflies);
const NP = 380, pPos = new Float32Array(NP * 3), pGeo = new THREE.BufferGeometry(); pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
const precip = new THREE.Points(pGeo, new THREE.PointsMaterial({ color: 0xcfe4ff, size: 2.5, sizeAttenuation: false, transparent: true, opacity: 0.8, depthWrite: false })); precip.frustumCulled = false; precip.visible = false; fxGroup.add(precip);
for (let i = 0; i < NP; i++) { pPos[i * 3] = (rnd('px' + i) - 0.5) * 60; pPos[i * 3 + 1] = rnd('py' + i) * 30; pPos[i * 3 + 2] = (rnd('pz' + i) - 0.5) * 60; }
const smoke = []; for (let i = 0; i < 6; i++) { const m = new THREE.Mesh(SPH, new THREE.MeshBasicMaterial({ color: 0xb8b8bc, transparent: true, opacity: 0.4, depthWrite: false })); m.userData.shared = true; m.visible = false; fxGroup.add(m); smoke.push(m); }
const cold3 = C(0xb8d0ff), tmpc = new THREE.Color(), tmpc2 = new THREE.Color();
function skyColors(h) {                                       // [zenith, horizon] for the hour, blended between night, dawn, day and dusk
  const pick = (a, b, t) => [tmpc.clone().copy(a[0]).lerp(b[0], t), tmpc2.clone().copy(a[1]).lerp(b[1], t)];
  if (h < 4.5 || h >= 21) return [SKY.night[0].clone(), SKY.night[1].clone()];
  if (h < 6.5) return pick(SKY.night, SKY.dawn, (h - 4.5) / 2); if (h < 8.5) return pick(SKY.dawn, SKY.day, (h - 6.5) / 2);
  if (h < 17) return [SKY.day[0].clone(), SKY.day[1].clone()];
  if (h < 19) return pick(SKY.day, SKY.dusk, (h - 17) / 2); return pick(SKY.dusk, SKY.night, (h - 19) / 2);
}
function applyLight() {
  const h = hourNow(), tw = tower(), dayf = clamp(Math.sin((h - 6) / 12 * Math.PI) * 1.4, 0, 1), sea = season();
  paintGround();
  const [zen, hor] = skyColors(h), pa = skyGeo.attributes.position;
  for (let i = 0; i < pa.count; i++) { const t = clamp(pa.getY(i) / 450, 0, 1), c = tmpc.copy(hor).lerp(zen, Math.pow(t, 0.6)); skyCol[i * 3] = c.r; skyCol[i * 3 + 1] = c.g; skyCol[i * 3 + 2] = c.b; }
  skyGeo.attributes.color.needsUpdate = true;
  scene.background = hor.clone(); scene.fog.color.copy(hor); scene.fog.near = 90; scene.fog.far = 320;
  stars.material.opacity = clamp(1 - dayf * 3, 0, 1) * 0.95;
  const ang = (h - 6) / 12 * Math.PI, sx = Math.cos(Math.PI - ang) * 330, sy = Math.sin(ang) * 300;
  sunMesh.position.set(sx, sy, -60); sunMesh.visible = sy > -20; moonMesh.position.set(-sx, -sy, -60); moonMesh.visible = -sy > -20;
  const focusP = mode === 'watch' || PUBLIC ? byId[S.place] : (regionAt(cam3.pos.x, cam3.pos.y, cam3.pos.z) || byId[S.place]);
  const under = focusP && focusP.exposure && focusP.exposure.sky === false ? 0.8 : 1;
  hemi.intensity = (0.62 + 0.3 * dayf) * under + (Q.lights < 3 ? 0.25 : 0); hemi.color.setHex(0xffffff).lerp(hor, 0.25).lerp(cold3, clamp(tw.cold / 100 * 0.25, 0, 0.25)); hemi.groundColor.setHex(sea === 'winter' ? 0xc0c8d0 : 0x8a9a6a);
  sun.intensity = (0.12 + 0.4 * dayf) * under; sun.color.setHex(0xfff2d0).lerp(SKY.dusk[1], clamp(1 - Math.abs(h - 12) / 6, 0, 1) < 0.4 ? 0.5 : 0);
  sun.position.set(lerp(-30, 30, clamp((h - 6) / 12, 0, 1)), 40, 25);
  lamp.intensity = (focusP && !focusP.outdoor ? 0.6 : 0.05 + 0.5 * (1 - dayf)) + (focusP && focusP.lit ? 0.35 : 0);
  lamp.color.setHex(0xffd29a).lerp(cold3, clamp((tw.cold - 40) / 100, 0, 0.5));
  ground.visible = !(focusP && focusP.gz < 0);
}

// ------------------------------------------------------------------ the wizard
const wiz = { x: 0, y: 0, z: 0, yaw: 0, region: null, wp: [], moving: false, phase: 0, climbing: false, spotKey: '', spot: null, speed: 3.2 };
const wizG = new THREE.Group(), body = new THREE.Group(); wizG.add(body); wizG.scale.setScalar(KW); scene.add(wizG);
add(body, ROBE, 0x5a46c8, 0, 0.18, 0, 1, 1, 1);
add(body, CYL, 0xe8c15a, 0, 0.19, 0, 0.17, 0.02, 0.17);                       // belt
add(body, SPH, 0xf0c9a0, 0, 0.45, 0, 0.09);
add(body, BOX, 0xf4f4f4, 0.07, 0.36, 0, 0.05, 0.14, 0.1);                      // beard
add(body, CYL, 0x4a37b0, 0, 0.535, 0, 0.2, 0.02, 0.2);                         // hat brim
const hat = add(body, CONE, 0x4a37b0, 0, 0.69, 0, 0.13, 0.3, 0.13); hat.rotation.z = -0.15;
const armL = new THREE.Group(), armR = new THREE.Group(); body.add(armL, armR); armL.position.set(0, 0.32, 0.12); armR.position.set(0, 0.32, -0.12);
add(armL, CYL, 0x4a37b0, 0, -0.07, 0, 0.03, 0.14, 0.03); add(armR, CYL, 0x4a37b0, 0, -0.07, 0, 0.03, 0.14, 0.03);
const staff = new THREE.Group(); body.add(staff); staff.position.set(0.05, 0, 0.17);
add(staff, CYL, 0x8a5a34, 0, 0.3, 0, 0.012, 0.62, 0.012); add(staff, SPH, 0xb48cff, 0, 0.63, 0, 0.035, 0.035, 0.035, true);
const bub = new THREE.Group(); wizG.add(bub);
const dots = [-0.12, 0, 0.12].map(x => add(bub, SPH, 0xffffff, x, 0, 0, 0.045, 0.045, 0.045, true)); bub.position.y = 1.15; bub.scale.setScalar(1.8);
const zz = new THREE.Group(); wizG.add(zz);
const zs = [0, 1, 2].map(() => add(zz, BOX, 0xbcd0ff, 0, 0, 0, 0.06, 0.06, 0.012, true));
const breath = add(wizG, SPH, 0xffffff, 0.14, 0.4, 0, 0.05); breath.material = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false });
const blob = new THREE.Mesh(CYL, new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false })); blob.scale.set(0.28 * KW, 0.01, 0.28 * KW); blob.userData.shared = true; scene.add(blob);
const ring = new THREE.Mesh(new THREE.RingGeometry(0.75, 1.0, 28), new THREE.MeshBasicMaterial({ color: 0xc9b0ff, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide })); ring.rotation.x = -Math.PI / 2; ring.userData.shared = true; scene.add(ring);
const beacon = new THREE.Mesh(CONE, new THREE.MeshBasicMaterial({ color: 0xffd34d, depthTest: false, transparent: true, opacity: 0.95 })); beacon.rotation.x = Math.PI; beacon.scale.set(0.55, 1.0, 0.55); beacon.renderOrder = 20; beacon.userData.shared = true; scene.add(beacon);
const pulse = add(scene, SPH, 0xb48cff, 0, 0, 0, 0.2); pulse.material = new THREE.MeshBasicMaterial({ color: 0xb48cff, transparent: true, opacity: 0, depthWrite: false }); pulse.visible = false;
let fx = null;

function colBlocked(B, x, z) {                              // is (x,z) over a hole, a stair, a ladder?
  const r = loaded[B.id]; if (!r) return false;
  for (const h of r.col.blocked) if (x > h.x0 && x < h.x1 && z > h.z0 && z < h.z1) return true;
  for (const m of r.col.ramps) if (x > m.x0 - 0.5 && x < m.x1 + 0.5 && z > m.z0 - 0.5 && z < m.z1 + 0.5) return true;
  return false;
}
function spotIn(p, key) {                                   // a stable place to stand in a region
  const B = rb(p); B.id = p.id;
  if (S.sleeping) { const bed = p.items.find(i => /bed|cot|bunk/i.test(i.name)); if (bed && !p.outdoor) return { x: B.x1 - 2.6, y: B.y0 + 0.75, z: B.z0 + 2.0, bed: true }; }
  for (let k = 0; k < 14; k++) {
    const x = B.x0 + 2.4 + (B.w - 4.8) * rnd(key + 'sx' + k), z = B.z0 + 2.4 + (B.d - 4.8) * rnd(key + 'sz' + k);
    if (!colBlocked(B, x, z)) return { x, y: B.y0, z };
  }
  return { x: B.cx, y: B.y0, z: B.cz };
}
function hopPoints(a, b) {                                  // waypoints for one step between two neighbouring regions
  const A = rb(a), T = rb(b), sd = sideOf(A, T), out = [];
  if (sd === 'U' || sd === 'D') {
    const v = vspec(a, b); if (!v) return [{ x: T.cx, y: T.y0, z: T.cz }];
    const up = v.hi.id === b.id, LO = v.LO, HI = v.HI;
    if (v.ramp) {
      const r = v.ramp, lowE = r.axis === 'x' ? (r.dir > 0 ? [r.x0, (r.z0 + r.z1) / 2] : [r.x1, (r.z0 + r.z1) / 2]) : (r.dir > 0 ? [(r.x0 + r.x1) / 2, r.z0] : [(r.x0 + r.x1) / 2, r.z1]);
      const hiE = r.axis === 'x' ? (r.dir > 0 ? [r.x1, (r.z0 + r.z1) / 2] : [r.x0, (r.z0 + r.z1) / 2]) : (r.dir > 0 ? [(r.x0 + r.x1) / 2, r.z1] : [(r.x0 + r.x1) / 2, r.z0]);
      const away = r.axis === 'x' ? [r.dir > 0 ? 1.8 : -1.8, 0] : [0, r.dir > 0 ? 1.8 : -1.8], before = [-away[0], -away[1]];
      const lo = { x: lowE[0] + before[0] * 0.5, y: LO.y0, z: lowE[1] + before[1] * 0.5 }, hi = { x: hiE[0] + away[0] * 0.6, y: HI.y0, z: hiE[1] + away[1] * 0.6 };
      if (up) out.push(lo, { x: lowE[0], y: LO.y0, z: lowE[1] }, { x: hiE[0], y: HI.y0, z: hiE[1] }, hi); else out.push(hi, { x: hiE[0], y: HI.y0, z: hiE[1] }, { x: lowE[0], y: LO.y0, z: lowE[1] }, lo);
    } else {
      const l = v.ladder, off = { N: [0, 1.4], S: [0, -1.4], E: [-1.4, 0], W: [1.4, 0] }[l.side];
      const base = { x: l.cx + off[0], y: LO.y0, z: l.cz + off[1] }, at = { x: l.cx + off[0] * 0.3, y: LO.y0, z: l.cz + off[1] * 0.3 }, topP = { x: at.x, y: HI.y0 + 0.1, z: at.z }, out2 = { x: l.cx + off[0] * 1.4, y: HI.y0, z: l.cz + off[1] * 1.4 };
      if (up) out.push(base, at, topP, out2); else out.push(out2, topP, at, base);
    }
    return out;
  }
  if (!sd) return [{ x: T.cx, y: T.y0, z: T.cz }];
  const at = gapPos(A, T, sd, pairKey(a, b)), bx = sd === 'E' ? A.x1 : sd === 'W' ? A.x0 : at, bz = sd === 'N' ? A.z0 : sd === 'S' ? A.z1 : at;
  const dx = sd === 'E' ? 1 : sd === 'W' ? -1 : 0, dz = sd === 'S' ? 1 : sd === 'N' ? -1 : 0;
  return [{ x: bx - dx * 1.8, y: A.y0, z: bz - dz * 1.8 }, { x: bx, y: (A.y0 + T.y0) / 2, z: bz }, { x: bx + dx * 1.8, y: T.y0, z: bz + dz * 1.8 }];
}
function route(fromId, toId) {                              // breadth-first over the exits; S.path wins when it fits
  if (Array.isArray(S.path) && S.path.length > 1 && S.path[0] === fromId && S.path[S.path.length - 1] === toId && S.path.every(id => byId[id])) return S.path;
  const prev = { [fromId]: null }, q = [fromId];
  while (q.length) { const c = q.shift(); if (c === toId) break; for (const e of byId[c].exits) if (byId[e.to] && !(e.to in prev)) { prev[e.to] = c; q.push(e.to); } }
  if (!(toId in prev)) return null;
  const out = []; for (let c = toId; c; c = prev[c]) out.unshift(c); return out;
}
function updateWizard(dt) {
  const p = byId[S.place]; if (!p) return;
  const key = p.id + '|' + (S.stats && S.stats.turns) + '|' + (S.sleeping ? 's' : 'a');
  if (wiz.region === null || !byId[wiz.region]) { wiz.region = p.id; wiz.spotKey = key; wiz.spot = spotIn(p, key); wiz.x = wiz.spot.x; wiz.y = wiz.spot.y; wiz.z = wiz.spot.z; wiz.wp = []; }
  if (wiz.region !== p.id) {
    const r = route(wiz.region, p.id), here = loaded[wiz.region];
    wiz.wp = [];
    if (r && r.length <= 8 && here) { for (let i = 0; i + 1 < r.length; i++) wiz.wp.push(...hopPoints(byId[r[i]], byId[r[i + 1]])); }
    wiz.region = p.id; wiz.spotKey = key; wiz.spot = spotIn(p, key); wiz.wp.push(wiz.spot);
    if (!wiz.wp.length || wiz.wp.length === 1) { wiz.x = wiz.spot.x; wiz.y = wiz.spot.y; wiz.z = wiz.spot.z; wiz.wp = []; }
    let len = 0, lx = wiz.x, ly = wiz.y, lz = wiz.z; for (const w of wiz.wp) { len += Math.hypot(w.x - lx, w.y - ly, w.z - lz); lx = w.x; ly = w.y; lz = w.z; }
    wiz.speed = clamp(len / 9, 3.2, 9);                      // long routes are hurried so they stay short
  } else if (wiz.spotKey !== key && !S.thinking) { wiz.spotKey = key; wiz.spot = spotIn(p, key); }
  const goal = wiz.wp.length ? wiz.wp[0] : wiz.spot; if (!goal) return;
  const dx = goal.x - wiz.x, dy = goal.y - wiz.y, dz = goal.z - wiz.z, d = Math.hypot(dx, dy, dz), sp = (S.sleeping ? 6 : wiz.wp.length ? wiz.speed : 2.4) * dt;
  wiz.moving = d > 0.02;
  if (d > sp) { wiz.x += dx / d * sp; wiz.y += dy / d * sp; wiz.z += dz / d * sp; if (Math.hypot(dx, dz) > 0.05) wiz.yaw = angTo(wiz.yaw, Math.atan2(-dz, dx), 1 - Math.exp(-dt * 10)); wiz.phase += dt * 9; }
  else { wiz.x = goal.x; wiz.y = goal.y; wiz.z = goal.z; if (wiz.wp.length) wiz.wp.shift(); else wiz.moving = false; }
}
const angTo = (a, b, k) => { const d = ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI; return a + d * k; };

// ------------------------------------------------------------------ crow, creature, familiar
const crowG = new THREE.Group(); crowG.scale.setScalar(K); scene.add(crowG);
add(crowG, SPH, 0x1a1a22, 0, 0.09, 0, 0.09, 0.07, 0.12); add(crowG, SPH, 0x1a1a22, 0.08, 0.17, 0, 0.05); add(crowG, CONE, 0xe0a030, 0.14, 0.17, 0, 0.02, 0.07, 0.02).rotation.z = -Math.PI / 2;
crowG.visible = false;
const monG = new THREE.Group(); scene.add(monG);
add(monG, SPH, 0xc04a4a, 0, 0.25, 0, 0.28, 0.22, 0.22); add(monG, SPH, 0xffe060, -0.1, 0.34, 0.16, 0.04, 0.04, 0.04, true); add(monG, SPH, 0xffe060, 0.06, 0.34, 0.16, 0.04, 0.04, 0.04, true);
monG.visible = false;
const famG = new THREE.Group(), famBody = new THREE.Group(); famG.add(famBody); famG.scale.setScalar(K); scene.add(famG);
const famMat = new THREE.MeshLambertMaterial({ color: 0xb08a5a });
const fm = (geo, x, y, z, sx, sy, sz) => { const m = new THREE.Mesh(geo, famMat); m.position.set(x, y, z); m.scale.set(sx, sy, sz); famBody.add(m); return m; };
fm(SPH, 0, 0.09, 0, 0.14, 0.09, 0.09); fm(SPH, 0.13, 0.15, 0, 0.065, 0.065, 0.065); fm(CONE, 0.13, 0.24, 0.035, 0.025, 0.06, 0.025); fm(CONE, 0.13, 0.24, -0.035, 0.025, 0.06, 0.025); fm(SPH, -0.15, 0.12, 0, 0.04, 0.04, 0.04);
famG.visible = false;
const fam = { x: 0, z: 0, y: 0, yaw: 0, kind: '', init: false };

// ------------------------------------------------------------------ my avatar and camera
const cam3 = { pos: new THREE.Vector3(), vy: 0, vx: 0, vz: 0, yaw: 0, pitch: -0.15, grounded: false, first: false, init: false, climbing: false };
const watch = { az: 0.55, el: 0.4, dist: 30, tAz: 0.55, tEl: 0.4, zoom: 1, tZoom: 1, t: new THREE.Vector3(), init: false, drag: false, moving: false, size: 30 };
const avG = new THREE.Group(); scene.add(avG); avG.visible = false;
add(avG, CYL, 0x3d7be8, 0, 0.7, 0, 0.3, 0.7, 0.3); add(avG, SPH, 0xf0c9a0, 0, 1.5, 0, 0.22); add(avG, BOX, 0x27407a, 0.2, 1.52, 0, 0.12, 0.08, 0.26); add(avG, CONE, 0x3d7be8, 0, 0.95, 0, 0.36, 0.2, 0.36);
const keys = {};
let nearHim = false, lastPost = 0, lastPostSig = '';
const hudEl = document.createElement('div'), hintEl = document.createElement('div'), uiEl = document.createElement('div'), crossEl = document.createElement('div');
if (!PUBLIC) {
  hudEl.style.cssText = 'position:absolute;left:8px;top:38px;z-index:4;pointer-events:none;color:#e9e3ff;font:11px/1.35 "Segoe UI",sans-serif;background:rgba(15,12,30,.5);padding:4px 8px;border-radius:6px;display:none;white-space:pre';
  hintEl.style.cssText = 'position:absolute;left:50%;transform:translateX(-50%);bottom:46px;z-index:5;pointer-events:none;color:#fff;font:13px "Segoe UI",sans-serif;background:rgba(60,40,120,.8);padding:5px 12px;border-radius:99px;display:none';
  hintEl.textContent = 'He notices you. Talk in the chat (press T).';
  crossEl.style.cssText = 'position:absolute;left:50%;top:50%;width:14px;height:14px;margin:-7px 0 0 -7px;z-index:4;pointer-events:none;display:none;background:radial-gradient(circle,#fff 1.5px,transparent 2px),linear-gradient(#fff,#fff) center/1px 100% no-repeat,linear-gradient(#fff,#fff) center/100% 1px no-repeat;opacity:.55;mix-blend-mode:difference';
  uiEl.style.cssText = 'position:absolute;right:8px;top:8px;z-index:5;display:none;gap:4px;font:12px "Segoe UI",sans-serif';
  uiEl.innerHTML = '<button data-m="watch">Watch</button> <button data-m="walk">Walk</button> <button data-m="fly">Fly</button> <select id="q3" title="Quality"><option value="auto">Auto</option><option value="low">Low</option><option value="high">High</option></select>';
  uiEl.querySelectorAll('button').forEach(b => { b.style.cssText = 'padding:3px 9px;font-size:12px;opacity:.9'; b.onclick = () => setMode(b.dataset.m); });
  const sel = uiEl.querySelector('select'); sel.style.cssText = 'font-size:12px;background:#1f1a36;color:#e9e3ff;border:1px solid #35294f;border-radius:6px'; sel.value = Q.mode; sel.onchange = () => setQualityMode(sel.value);
  stage.append(hudEl, hintEl, uiEl, crossEl);
}
const HELP = { watch: 'Watching him. Drag to orbit, wheel to zoom, double-click to reset.', walk: 'WASD move · mouse look (click to capture, Esc to release) · Space jump · V first/third person · hold W at a ladder to climb · T chat · F fly', fly: 'Free camera (he cannot see you): WASD move · Q/E down/up · Shift fast · F back to walking · T chat' };
function setMode(m) {
  if (PUBLIC) return;
  if (m === 'walk' && !cam3.init) spawnAvatar();
  if (m === 'fly') { if (mode === 'watch') { cam3.pos.copy(camera.position); const d = camera.getWorldDirection(new THREE.Vector3()); cam3.yaw = Math.atan2(-d.x, -d.z); cam3.pitch = Math.asin(clamp(d.y, -1, 1)); cam3.init = true; } cam3.vy = 0; }
  if (m === 'walk' && mode === 'fly') { cam3.pos.y = Math.max(cam3.pos.y - 0.5, groundAt(cam3.pos.x, cam3.pos.z, cam3.pos.y + 50) + 0.1); cam3.vy = 0; }
  if (m === 'watch' && document.pointerLockElement) document.exitPointerLock();
  mode = m; store('wimbleton.mode3', m); avatarOn = m === 'walk';
  uiEl.querySelectorAll('button').forEach(b => b.style.outline = b.dataset.m === m ? '2px solid #8f6bff' : 'none');
  hudEl.style.display = m === 'watch' ? 'none' : 'block'; hudEl.textContent = HELP[m]; crossEl.style.display = m === 'watch' ? 'none' : 'block';
  cv.style.cursor = m === 'watch' ? 'grab' : 'crosshair'; postAvatar(true); need = true; dirty = true;
}
function spawnAvatar() {
  const hall = byId.hall || (S.places || []).find(p => p.gx === 0 && p.gy === 0 && p.gz === 0) || (S.places || [])[0]; if (!hall) return;
  const B = rb(hall); let x = B.cx + 3, z = B.cz + 1; const g = hall.exits.map(e => byId[e.to]).filter(Boolean).find(q => { const sd = sideOf(B, rb(q)); return 'NSEW'.includes(sd || '-'); });
  if (g) { const T = rb(g), sd = sideOf(B, T), at = gapPos(B, T, sd, pairKey(hall, g)); x = sd === 'E' ? B.x1 - 2.2 : sd === 'W' ? B.x0 + 2.2 : at; z = sd === 'N' ? B.z0 + 2.2 : sd === 'S' ? B.z1 - 2.2 : at; }
  cam3.pos.set(x, B.y0 + 0.05, z); cam3.vy = 0; cam3.vx = cam3.vz = 0; cam3.yaw = 0; cam3.pitch = -0.15; cam3.init = true; need = true;
}
function groundAt(x, z, y) {
  let best = -1e9;
  for (const f of CO.floors) if (x > f.x0 && x < f.x1 && z > f.z0 && z < f.z1 && f.top <= y + AV.step) best = Math.max(best, f.top);
  for (const r of CO.ramps) if (x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1) { const h = rampH(r, x, z); if (h <= y + AV.step + 0.25) best = Math.max(best, h); }
  return best;
}
function hitsWall(x, y, z) {
  for (const w of CO.walls) if (x + AV.r > w.x0 && x - AV.r < w.x1 && z + AV.r > w.z0 && z - AV.r < w.z1 && y + AV.h > w.y0 && y + AV.step < w.y1) return true;
  return false;
}
function stepAvatar(dt) {
  const p = cam3.pos, f = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0), s = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0), fast = keys.ShiftLeft || keys.ShiftRight;
  const sinY = Math.sin(cam3.yaw), cosY = Math.cos(cam3.yaw);
  if (mode === 'fly') {
    const cp = Math.cos(cam3.pitch), v = (fast ? 26 : 9) * dt;
    p.x += (-sinY * cp * f + cosY * s) * v; p.z += (-cosY * cp * f - sinY * s) * v; p.y += (Math.sin(cam3.pitch) * f + (keys.KeyE ? 1 : 0) - (keys.KeyQ ? 1 : 0)) * v; return;
  }
  const top = (fast ? 8 : 4.8);
  // ladders: hold W facing the ladder to go up, S to go down
  let lad = null;
  for (const l of CO.ladders) if (Math.abs(p.x - l.cx) < 0.9 && Math.abs(p.z - l.cz) < 0.9 && p.y >= l.y0 - 0.1 && p.y < l.y1 + 0.05) { const dx = l.cx - p.x, dz = l.cz - p.z, dl = Math.hypot(dx, dz) || 1; if ((-sinY * dx - cosY * dz) / dl > 0.2 || dl < 0.5) lad = l; }
  if (lad && (f || cam3.climbing) && !keys.Space) {
    cam3.climbing = true; cam3.vy = 0; cam3.vx = cam3.vz = 0; p.y += (f > 0 ? 3 : f < 0 ? -3 : 0) * dt; p.y = Math.max(lad.y0, p.y);
    if (p.y >= lad.y1 + 0.02) { p.y = lad.y1 + 0.02; cam3.climbing = false; p.x += -sinY * 0.9; p.z += -cosY * 0.9; }
    avG.visible = !cam3.first; return;
  }
  cam3.climbing = false;
  let mx = (-sinY * f + cosY * s), mz = (-cosY * f - sinY * s); const ml = Math.hypot(mx, mz); if (ml > 1) { mx /= ml; mz /= ml; }
  const acc = 1 - Math.exp(-dt * (cam3.grounded ? 14 : 3)); cam3.vx += (mx * top - cam3.vx) * acc; cam3.vz += (mz * top - cam3.vz) * acc;   // smooth start and stop
  let nx = p.x + cam3.vx * dt; if (!hitsWall(nx, p.y, p.z)) p.x = nx; else cam3.vx = 0; let nz = p.z + cam3.vz * dt; if (!hitsWall(p.x, p.y, nz)) p.z = nz; else cam3.vz = 0;
  const g = groundAt(p.x, p.z, p.y);
  if (cam3.grounded && keys.Space) { cam3.vy = 6.8; cam3.grounded = false; }
  if (cam3.grounded && p.y - g < 0.35 && cam3.vy <= 0 && g > -1e8) { p.y = g; }
  else {
    const head0 = p.y + AV.h; cam3.vy -= 18 * dt; p.y += cam3.vy * dt;
    if (cam3.vy > 0) for (const fl of CO.floors) if (p.x > fl.x0 && p.x < fl.x1 && p.z > fl.z0 && p.z < fl.z1 && head0 <= fl.top - SLAB + 0.02 && p.y + AV.h > fl.top - SLAB) { p.y = fl.top - SLAB - AV.h; cam3.vy = 0; break; }
    cam3.grounded = false;
    if (g > -1e8 && p.y <= g && cam3.vy <= 0) { p.y = g; cam3.vy = 0; cam3.grounded = true; }
  }
  if (p.y - g < 0.04 && g > -1e8 && cam3.vy <= 0) cam3.grounded = true;
  if (p.y < -60) spawnAvatar();
}
function lookDir(out) { const cp = Math.cos(cam3.pitch); return out.set(-Math.sin(cam3.yaw) * cp, Math.sin(cam3.pitch), -Math.cos(cam3.yaw) * cp); }

// ------------------------------------------------------------------ input
if (!PUBLIC) {
  const typing = e => { const t = e.target; return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable); };
  addEventListener('keydown', e => {
    if (typing(e) || !window.VIEW3D) return;
    if (mode !== 'watch') {
      if (e.code === 'KeyT') { e.preventDefault(); if (document.pointerLockElement) document.exitPointerLock(); const c = document.getElementById('chatin'); if (c) c.focus(); return; }
      if (e.code === 'KeyV' && mode === 'walk') cam3.first = !cam3.first;
      else if (e.code === 'KeyF') setMode(mode === 'fly' ? 'walk' : 'fly');
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      keys[e.code] = true; dirty = true;
    }
  });
  addEventListener('keyup', e => { keys[e.code] = false; });
  addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
  cv.addEventListener('pointerdown', e => {
    if (mode !== 'watch') { if (cv.requestPointerLock && !document.pointerLockElement) { try { cv.requestPointerLock(); } catch (er) {} } watch.lx = e.clientX; watch.ly = e.clientY; watch.drag = true; return; }
    watch.drag = true; watch.lx = e.clientX; watch.ly = e.clientY; cv.setPointerCapture(e.pointerId); cv.style.cursor = 'grabbing';
  });
  cv.addEventListener('pointermove', e => {
    if (mode !== 'watch') {
      const dx = document.pointerLockElement === cv ? e.movementX : (watch.drag ? e.clientX - watch.lx : 0), dy = document.pointerLockElement === cv ? e.movementY : (watch.drag ? e.clientY - watch.ly : 0);
      watch.lx = e.clientX; watch.ly = e.clientY; cam3.yaw -= dx * 0.0027; cam3.pitch = clamp(cam3.pitch - dy * 0.0027, -1.45, 1.45); dirty = true; return;
    }
    if (!watch.drag) return;
    watch.tAz -= (e.clientX - watch.lx) * 0.008; watch.tEl = clamp(watch.tEl + (e.clientY - watch.ly) * 0.006, 0.05, 1.45); watch.lx = e.clientX; watch.ly = e.clientY; dirty = true;
  });
  const endDrag = () => { watch.drag = false; if (mode === 'watch') cv.style.cursor = 'grab'; };
  cv.addEventListener('pointerup', endDrag); cv.addEventListener('pointercancel', endDrag);
  cv.addEventListener('wheel', e => { e.preventDefault(); if (mode === 'watch') watch.tZoom = clamp(watch.tZoom * Math.exp(e.deltaY * 0.001), 0.25, 2.2); dirty = true; }, { passive: false });
  cv.addEventListener('dblclick', () => { if (mode === 'watch') { watch.tAz = 0.55; watch.tEl = 0.4; watch.tZoom = 1; dirty = true; } });
}
const cap = document.createElement('div');
cap.style.cssText = 'position:absolute;left:8px;right:8px;bottom:8px;z-index:4;pointer-events:none;background:rgba(15,12,30,.6);color:#e9e3ff;font:13px/1.4 "Segoe UI",sans-serif;padding:6px 10px;border-radius:8px;display:none';
stage.appendChild(cap);

function postAvatar(force) {
  if (PUBLIC) return;
  const now = Date.now(), free = mode !== 'walk', reg = mode === 'walk' && cam3.init ? regionAt(cam3.pos.x, cam3.pos.y, cam3.pos.z) : null;
  const near = mode === 'walk' && nearHim, sig = (reg ? reg.id : '') + '|' + near + '|' + free;
  if (!force && sig === lastPostSig && now - lastPost < 20000) return;
  if (!force && now - lastPost < 1500) return;
  lastPost = now; lastPostSig = sig;
  try { fetch('/api/avatar', { method: 'POST', body: JSON.stringify({ region: reg ? reg.id : '', near, free }) }).catch(() => {}); } catch (e) {}
}

// ------------------------------------------------------------------ per-frame update
function onNewState() {
  byId = {}; S.places.forEach(p => { p.exits = p.exits || []; p.items = p.items || []; byId[p.id] = p; });
  need = true; ensureRegions(); applyLight();
  if (S.last_action) {
    if (lastSeq === null) lastSeq = S.last_action.seq;
    else if (S.last_action.seq !== lastSeq) { lastSeq = S.last_action.seq; const la = S.last_action; if (/cast|practice|design/.test(la.action) || /learned a spell/.test(la.result || '')) fx = { t: 0.7 }; }
  }
  const p = byId[S.place], la = S.last_action, fresh = la && la.thought && Date.now() / 1000 - la.ts < 25;
  cap.textContent = (p ? p.name : '') + (S.sleeping ? ' · asleep' : S.thinking ? ' · thinking…' : fresh ? ' · “' + la.thought + '”' : '');
  dirty = true;
}
// the frame for the Watch camera: the whole stack of rooms he is in (all floors of the tower) plus a little of what is beside it
function frameTarget() {
  const p = byId[S.place]; if (!p) return { c: new THREE.Vector3(wiz.x, wiz.y, wiz.z), size: 24 };
  const stack = Object.values(byId).filter(q => q.gx === p.gx && q.gy === p.gy && loaded[q.id]);
  let y0 = 1e9, y1 = -1e9; for (const q of stack.length ? stack : [p]) { const B = rb(q); y0 = Math.min(y0, B.y0); y1 = Math.max(y1, B.y1 + (/roof/i.test(q.name + q.id) ? 6 : 0)); }
  const B = rb(p), h = y1 - y0, cx = lerp(B.cx, wiz.x, 0.35), cz = lerp(B.cz, wiz.z, 0.35), cy = lerp((y0 + y1) / 2, wiz.y + 2, stack.length > 1 ? 0.25 : 0.6);
  return { c: new THREE.Vector3(cx, cy, cz), size: Math.max(h * 1.2, 21) };
}
function update(dt, now) {
  const t = now / 1000, tw = tower();
  if (need) { need = false; ensureRegions(); applyLight(); }
  updateWizard(dt);
  const wx = wiz.x, wy = wiz.y, wz = wiz.z, still = !wiz.moving, think = S.thinking && !S.sleeping && still;
  wizG.position.set(wx, wy, wz); wizG.rotation.y = wiz.yaw;
  blob.position.set(wx, wy + 0.03, wz); blob.visible = !S.sleeping; ring.position.set(wx, wy + 0.06, wz); ring.visible = !S.sleeping; ring.scale.setScalar(1.8 + Math.sin(t * 2.2) * 0.08);
  if (S.sleeping) { body.rotation.z = Math.PI / 2; body.position.y = 0.12; wizG.rotation.y = 0; staff.visible = false; }
  else {
    staff.visible = true; body.rotation.z = Math.sin(wiz.phase * 0.5) * (wiz.moving ? 0.06 : 0); body.position.y = wiz.moving ? Math.abs(Math.sin(wiz.phase)) * 0.035 : (think ? 0 : Math.sin(t * 1.6) * 0.006);
    const sw = wiz.moving ? Math.sin(wiz.phase) * 0.6 : Math.sin(t * 1.3) * 0.05; armL.rotation.z = sw; armR.rotation.z = -sw;
  }
  { const far = camera.position.distanceTo(wizG.position) > 20 && !S.sleeping; beacon.visible = far; if (far) { beacon.position.set(wx, wy + (think ? 6.4 : 4.6) + Math.sin(t * 3) * 0.2, wz); beacon.scale.setScalar(clamp(camera.position.distanceTo(wizG.position) / 40, 0.5, 1.1)); beacon.scale.y *= 1.8; } }
  bub.visible = think; if (think) dots.forEach((d, i) => d.position.y = Math.sin(t * 4 + i * 0.8) * 0.05);
  zz.visible = !!S.sleeping; if (S.sleeping) zs.forEach((z, i) => { const k = ((t * 0.5 + i / 3) % 1); z.position.set(0.1 + k * 0.1, 0.55 + k * 0.55, 0); z.scale.setScalar(0.06 * (1 - k * 0.4)); });
  const cold = tw.cold > 50 && !S.sleeping; breath.visible = cold; if (cold) { const k = Math.max(0, Math.sin(t * 1.4)); breath.position.set(0.14 + k * 0.08, 0.4, 0); breath.scale.setScalar(0.02 + k * 0.05); breath.material.opacity = 0.35 * (1 - k * 0.5); }
  if (fx) { fx.t -= dt; pulse.visible = fx.t > 0; if (pulse.visible) { const k = 1 - fx.t / 0.7; pulse.position.set(wx, wy + 1.2, wz); pulse.scale.setScalar(0.6 + k * 2.6); pulse.material.opacity = 0.45 * (1 - k); } else fx = null; }
  crowG.visible = !!S.crow; if (S.crow) { crowG.position.set(wx + 1.6, wy + Math.max(0, Math.sin(t * 3.1)) * 0.12, wz + 0.5); crowG.rotation.y = Math.PI; }
  const f = S.fight; monG.visible = !!f; if (f) { monG.scale.setScalar(K * (f.boss ? 1.8 : 1)); monG.position.set(wx + (f.boss ? 3.4 : 2.4), wy + Math.abs(Math.sin(t * 5)) * 0.12, wz); monG.rotation.y = Math.PI; }
  const fa = S.world && S.world.familiar, show = !!(fa && fa.here && (!fa.place || fa.place === S.place));
  famG.visible = show;
  if (show) {
    if (fa.kind !== fam.kind) { fam.kind = fa.kind; famMat.color.setHSL(rnd(fa.kind || 'x'), 0.35, 0.5); }
    const gx = wx - 1.3, gz = wz + 0.9;
    if (!fam.init || Math.hypot(fam.x - gx, fam.z - gz) > 12) { fam.x = gx; fam.z = gz; fam.init = true; }
    const k = 1 - Math.exp(-dt * 2.5), dx = gx - fam.x, dz = gz - fam.z; fam.x += dx * k; fam.z += dz * k; fam.y += (wy - fam.y) * k;
    if (Math.hypot(dx, dz) > 0.05) fam.yaw = Math.atan2(-dz, dx);
    famG.position.set(fam.x, fam.y + Math.abs(Math.sin(t * 6)) * (Math.hypot(dx, dz) > 0.1 ? 0.08 : 0), fam.z); famG.rotation.y = fam.yaw; famBody.scale.y = S.sleeping ? 0.6 : 1;
  }
  const watching = mode === 'watch' || PUBLIC;
  lamp.position.set(watching ? wx : cam3.pos.x, (watching ? wy : cam3.pos.y) + 3.4, (watching ? wz : cam3.pos.z) + 1.2);
  // camera
  if (watching) {
    const fr = frameTarget(), kk = 1 - Math.exp(-dt * 2.2);
    if (!watch.init) { watch.t.copy(fr.c); watch.size = fr.size; watch.init = true; }
    if (PUBLIC) watch.tAz += dt * 0.05;
    watch.t.lerp(fr.c, kk); watch.size += (fr.size - watch.size) * kk;
    const ks = 1 - Math.exp(-dt * 8); watch.az += (watch.tAz - watch.az) * ks; watch.el += (watch.tEl - watch.el) * ks; watch.zoom += (watch.tZoom - watch.zoom) * ks;
    const dist = watch.size / (2 * Math.tan(camera.fov * Math.PI / 360)) * watch.zoom;
    watch.moving = PUBLIC || watch.t.distanceTo(fr.c) > 0.03 || Math.abs(watch.size - fr.size) > 0.05 || Math.abs(watch.tAz - watch.az) > 0.002 || Math.abs(watch.tEl - watch.el) > 0.002 || Math.abs(watch.tZoom - watch.zoom) > 0.004;
    camera.position.set(watch.t.x + dist * Math.cos(watch.el) * Math.sin(watch.az), watch.t.y + dist * Math.sin(watch.el), watch.t.z + dist * Math.cos(watch.el) * Math.cos(watch.az));
    camera.lookAt(watch.t); avG.visible = false;
    if (Math.abs(watch.el - 0.72) < 0.02 || update.steep !== (watch.el > 0.72)) { update.steep = watch.el > 0.72; cutaway(); }
  } else {
    stepAvatar(dt);
    const d = lookDir(new THREE.Vector3());
    if (mode === 'fly') { camera.position.copy(cam3.pos); camera.lookAt(cam3.pos.clone().add(d)); avG.visible = false; }
    else if (cam3.first) { camera.position.set(cam3.pos.x, cam3.pos.y + AV.eye, cam3.pos.z); camera.lookAt(camera.position.clone().add(d)); avG.visible = false; }
    else {
      const eye = new THREE.Vector3(cam3.pos.x, cam3.pos.y + 1.5, cam3.pos.z); camera.position.copy(eye).addScaledVector(d, -4.2); camera.lookAt(eye);
      avG.visible = true; avG.position.set(cam3.pos.x, cam3.pos.y, cam3.pos.z); avG.rotation.y = cam3.yaw;
    }
    const was = nearHim, hp = new THREE.Vector3(wx, wy, wz);
    nearHim = mode === 'walk' && cam3.init && cam3.pos.distanceTo(hp) < 6.5 && Math.abs(cam3.pos.y - wy) < 3;
    if (!nearHim && mode === 'walk' && cam3.init) { const a = regionAt(cam3.pos.x, cam3.pos.y, cam3.pos.z), b = byId[S.place]; if (a && b && a.id !== b.id && pairState(a, b) === 'open' && cam3.pos.distanceTo(hp) < 8.5) nearHim = true; }
    hintEl.style.display = nearHim ? 'block' : 'none'; if (was !== nearHim) postAvatar(true);
    postAvatar(false);
    const reg = regionAt(cam3.pos.x, cam3.pos.y, cam3.pos.z); if (reg && reg.id !== update.lastReg) { update.lastReg = reg.id; need = true; }
  }
  // the sky follows the camera; clouds drift, smoke rises, fireflies drift at night, rain or snow falls around the view
  skyMesh.position.copy(camera.position); stars.position.copy(camera.position); ground.position.x = camera.position.x; ground.position.z = camera.position.z;
  const hour = hourNow(), nightf = clamp(1 - Math.sin((hour - 6) / 12 * Math.PI) * 2, 0, 1);
  if (Q.fx) {
    for (const c of clouds) { c.position.x += c.userData.v * dt; if (c.position.x > camera.position.x + 300) c.position.x -= 600; if (c.position.x < camera.position.x - 300) c.position.x += 600; c.visible = nightf < 0.8; }
    const fp = byId[S.place], out = fp && fp.outdoor;
    fireflies.visible = out && nightf > 0.5 && !weather(); if (fireflies.visible) for (let i = 0; i < FF; i++) { ffPos[i * 3] = wx + Math.sin(t * 0.4 + i * 1.7) * 9 + (rnd('fa' + i) - 0.5) * 8; ffPos[i * 3 + 1] = wy + 1 + rnd('fb' + i) * 3 + Math.sin(t * 0.9 + i) * 0.5; ffPos[i * 3 + 2] = wz + Math.cos(t * 0.35 + i * 2.3) * 9 + (rnd('fc' + i) - 0.5) * 8; } ffGeo.attributes.position.needsUpdate = fireflies.visible;
    const wthr = weather(), inRoom = fp && !fp.outdoor; precip.visible = !!wthr && !inRoom;
    if (precip.visible) { precip.material.size = wthr === 'snow' ? 4 : 2; const sp = wthr === 'snow' ? 3 : 24; for (let i = 0; i < NP; i++) { pPos[i * 3 + 1] -= sp * dt; if (pPos[i * 3 + 1] < 0) pPos[i * 3 + 1] += 30; } pGeo.attributes.position.needsUpdate = true; precip.position.set(wx, wy - 2, wz); }
    let hr = null; for (const id in loaded) if (loaded[id].hearth && S.world && S.world.fire && (id === S.place)) hr = loaded[id].hearth;
    smoke.forEach((m, i) => { m.visible = !!hr; if (hr) { const k = ((t * 0.35 + i / smoke.length) % 1); m.position.set(hr.x + Math.sin(t + i) * 0.2, hr.y + k * 3.2, hr.z); m.scale.setScalar(0.25 + k * 0.7); m.material.opacity = 0.4 * (1 - k); } });
  }
}

// ------------------------------------------------------------------ loop: on demand, throttled, self-degrading
let last = 0, shown = null, lastRender = 0; const ft = []; let evalAt = 0, goodSince = 0, penalty = 0;
function showCap() {
  const on = !!window.VIEW3D;
  if (on !== shown) { shown = on; const cb = document.getElementById('camBar'); if (cb) cb.style.display = on ? 'none' : ''; cap.style.display = on && !PUBLIC ? 'block' : 'none'; if (!PUBLIC) { uiEl.style.display = on ? 'flex' : 'none'; if (on) { const m = store('wimbleton.mode3'); if (m && m !== mode && ['watch', 'walk', 'fly'].includes(m) && !showCap.once) setMode(m); showCap.once = true; } } if (on) { resize(); dirty = true; } }
}
addEventListener('viewchange', showCap); document.addEventListener('visibilitychange', () => { dirty = true; });
function autoQuality(now, busy) {
  if (Q.mode !== 'auto' || !busy) { ft.length = 0; return; }
  if (lastRender) { ft.push(now - lastRender); if (ft.length > 90) ft.shift(); }
  if (now - evalAt < 3000 || ft.length < 45) return; evalAt = now;
  const avg = ft.reduce((a, b) => a + b, 0) / ft.length;
  if (avg > 42 && Q.level < 3) { applyQuality(Q.level + 1); penalty = now; goodSince = now; ft.length = 0; }
  else if (avg < 35) { if (!goodSince) goodSince = now; if (now - goodSince > 45000 && now - penalty > 120000 && Q.level > 0) { applyQuality(Q.level - 1); goodSince = now; ft.length = 0; } }
  else goodSince = now;
}
function loop(now) {
  requestAnimationFrame(loop);
  showCap();
  if (!window.VIEW3D || document.hidden || typeof S === 'undefined' || !S || !S.places || !S.places.length) return;
  if (!W) resize(); if (!W) return;
  if (S !== lastS) { lastS = S; try { onNewState(); } catch (e) { console.error(e); } }
  const interactive = mode !== 'watch' && !PUBLIC;
  const busy = wiz.moving || S.thinking || fx || watch.drag || watch.moving || dirty || interactive || (Q.fx && (weather() || isNight()));
  const gap = busy ? 33 : (S.sleeping || S.crow || S.fight || (S.world && S.world.familiar && S.world.familiar.here)) ? 66 : 600;
  if (now - last < gap) return;
  const dt = Math.min(0.1, (now - last) / 1000); last = now; dirty = false;
  autoQuality(now, busy);
  try { update(dt, now); R.render(scene, camera); lastRender = now; } catch (e) { console.error(e); }
}
applyQuality(Q.mode === 'low' ? 3 : 0);
resize(); requestAnimationFrame(loop);
window.__w3d = { info: () => ({ calls: R.info.render.calls, tris: R.info.render.triangles, geos: R.info.memory.geometries }), camera, scene, CO: () => CO, loaded, Q, get mode() { return mode; }, setMode, cam3, wiz, watch, applyQuality, renderNow(dt) { if (S !== lastS) { lastS = S; onNewState(); } update(dt || 0.033, performance.now()); R.render(scene, camera); }, resize };   // for testing
})();
