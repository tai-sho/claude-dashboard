// 眺めるモード: プロジェクトを惑星、セッションを衛星にした 3D の画面。
// 依存を入れないため、ライブラリは使わず WebGL 2 を直接使って描く。名前や観測の印は上に重ねた Canvas 2D に描く。
// - 惑星の表面はシェーダーの中でノイズから作る（寄っても粗くならない）。雲は流れ、ガス惑星の縞は緯度ごとにずれて回る
// - 光は世界に固定した太陽ひとつ。回すと昼と夜の側が入れ替わり、太陽が画面に入るとまぶしさと光の輪が出る
// - 衛星の影と環の影が惑星に、惑星の影が環と衛星に落ちる（衛星は惑星の影に入ると暗くなる）
// - 待たせている衛星は、待ち時間に応じて公転面から浮き上がる（15分・30分・1時間・2時間に目盛り）
// - 観測している天体にピントを合わせ、前後をぼかす
// ドラッグで回し、ホイールで寄る。天体を押すとカメラが寄り、右に観測カードを出す。呼ばれても閉じず、画面の中で知らせる。
(() => {
  const CB = window.CB = window.CB || { views: {} };
  const TAU = Math.PI * 2;
  let el, glCanvas, canvas, g2, gl = null, glError = '', open = false, raf = 0, clockTimer = 0;
  let planets = [], sats = [], stars = null, dust = [], orbitsDirty = true;
  let cam = { yaw: 0, pitch: .36, dist: 0, t: [0, 0, 0], ox: 0, oy: 0 }, hoverSat = null, hoverPlanet = null;
  let lastT = 0, clock = 0, focal = 1, ringR = 0, W = 1, H = 1, dpr = 1, colors = {}, colorsAt = 0;
  // 観測の対象（{ kind: 'planet' | 'sat', key, planet }）と、ホイールで決めた寄り具合（1 で画面に収まる距離）
  let focus = null, zoom = 1, drag = null, cardHtml = '', note = null, noteHtml = '', meteor = null, nextMeteor = 0;
  const dof = { fd: 1000, k: 0, max: 0 };
  const ZOOM_MIN = .25, ZOOM_MAX = 3, PITCH_MIN = -.6, PITCH_MAX = 1.2;
  const SAT_BODY = 2.6; // 衛星の影の大きさ（世界の長さ）
  let nebula = null;

  const hash = (s, k = 0) => { let h = 2166136261 ^ k; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0) / 4294967296; };
  const short = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
  const rootOf = cwd => (cwd || '').replace(/\/\.claude\/worktrees\/[^/]+.*$/, '');
  const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
  const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
  const rgb = hex => { const n = parseInt(hex.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
  const rgbf = hex => rgb(hex).map(v => v / 255);
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  function rng(seed) { let a = (seed * 4294967296) >>> 0 || 1; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const gauss = r => r() + r() + r() - 1.5;

  // ---------- 値ノイズと fBm（背景のパノラマを焼くときだけ使う） ----------
  function makeNoise(seed) {
    const r = rng(seed), a = [...Array(256).keys()];
    for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    const p = new Uint8Array(512);
    for (let i = 0; i < 512; i++) p[i] = a[i & 255];
    const f = t => t * t * (3 - 2 * t);
    const noise = (x, y, z) => {
      const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
      const X = xi & 255, Y = yi & 255, Z = zi & 255;
      const u = f(x - xi), v = f(y - yi), w = f(z - zi);
      const h = (i, j, k) => p[p[p[X + i] + Y + j] + Z + k];
      const l = (a, b, t) => a + (b - a) * t;
      return l(l(l(h(0, 0, 0), h(1, 0, 0), u), l(h(0, 1, 0), h(1, 1, 0), u), v),
               l(l(h(0, 0, 1), h(1, 0, 1), u), l(h(0, 1, 1), h(1, 1, 1), u), v), w) / 255;
    };
    return (x, y, z, oct = 5) => {
      let s = 0, amp = .5, n = 0;
      for (let o = 0; o < oct; o++) { s += noise(x, y, z) * amp; n += amp; x *= 2.03; y *= 2.03; z *= 2.03; amp *= .5; }
      return s / n;
    };
  }

  // ---------- 星雲と天の川（全天の正距円筒パノラマ） ----------
  const NW = 768, NH = 384;
  const bandY = th => .32 * Math.sin(th + 1.3) - .12;
  function makeNebula() {
    const fbm = makeNoise(.4242), fbm2 = makeNoise(.9191);
    const cv = document.createElement('canvas'); cv.width = NW; cv.height = NH;
    const g = cv.getContext('2d'), img = g.createImageData(NW, NH), d = img.data;
    const deep = rgb('#03060c'), indigo = rgb('#1c2850'), violet = rgb('#3b2350'), teal = rgb('#12363f'), milk = rgb('#d9d2c4');
    for (let j = 0; j < NH; j++) {
      const e = (j / (NH - 1) - .5) * Math.PI, ce = Math.cos(e), se = Math.sin(e);
      for (let i = 0; i < NW; i++) {
        const th = i / NW * TAU, x = Math.cos(th) * ce, z = Math.sin(th) * ce;
        const n = fbm(x * 1.6, se * 1.6, z * 1.6, 6), m = fbm2(x * 2.4 + 5, se * 2.4, z * 2.4, 5);
        const band = Math.exp(-Math.pow(e - bandY(th), 2) / .028);
        let c = deep;
        c = mix(c, m > .5 ? violet : teal, smooth(.42, .78, n) * .55);
        c = mix(c, indigo, smooth(.5, .85, m) * .35);
        c = mix(c, milk, band * (.12 + .3 * smooth(.35, .8, n)));
        c = mix(c, deep, band * smooth(.52, .7, m) * .75); // 天の川の暗い塵の筋
        const k = (j * NW + i) * 4;
        d[k] = c[0]; d[k + 1] = c[1]; d[k + 2] = c[2]; d[k + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return cv;
  }
  function makeStars() {
    const r = rng(.777), temps = ['#9bb0ff', '#cad7ff', '#f4f3ff', '#f4f3ff', '#fff4ea', '#ffd9b0', '#ffc27a'];
    const N = 2600, out = new Float32Array(N * 8);
    for (let i = 0; i < N; i++) {
      const th = r() * TAU;
      // 4割は天の川に沿って集める
      const e = r() < .4 ? bandY(th) + gauss(r) * .16 : Math.asin(r() * 2 - 1);
      const c = rgbf(temps[Math.floor(r() * temps.length)]);
      out.set([Math.cos(th) * Math.cos(e), Math.sin(e), Math.sin(th) * Math.cos(e), Math.pow(r(), 4), ...c, r() * TAU], i * 8);
    }
    return out;
  }

  // ---------- 世界の組み立て ----------
  const TYPES = ['gas', 'terran', 'ice', 'rock'];
  const GAS_PALETTES = [
    [[0, '#7a4a2e'], [.25, '#c9935e'], [.45, '#ead3ae'], [.6, '#b37a4b'], [.8, '#e3c9a0'], [1, '#8a5634']],
    [[0, '#2f4a73'], [.3, '#7f9fc4'], [.5, '#d5e2ee'], [.7, '#5b7ba3'], [1, '#a9bfd8'], [1, '#a9bfd8']],
    [[0, '#4d5a3b'], [.3, '#a9a46a'], [.55, '#e2dcb4'], [.75, '#8c8550'], [1, '#c8c08a'], [1, '#c8c08a']],
  ];
  const ATM = { gas: rgbf('#e8c79a'), terran: rgbf('#6fa8ff'), ice: rgbf('#bfe8ff'), rock: rgbf('#d9a77a') };
  const ATM_STRENGTH = { gas: .45, terran: .9, ice: .55, rock: .18 };

  function build(data) {
    const groups = new Map();
    for (const s of data.sessions) {
      const key = rootOf(s.cwd) || s.project || '不明';
      if (!groups.has(key)) groups.set(key, { key, name: s.project || '不明', sessions: [] });
      groups.get(key).sessions.push(s);
    }
    const list = [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
    ringR = list.length > 1 ? 190 + 60 * list.length : 0;
    const old = new Map(planets.map(p => [p.key, p]));
    planets = list.map((g, i) => {
      const a = i / list.length * TAU, prev = old.get(g.key);
      const type = TYPES[Math.floor(hash(g.key, 7) * TYPES.length)];
      const r = 22 + Math.min(18, g.sessions.length * 3.5);
      const ring = type === 'gas' && hash(g.key, 8) > .35;
      const pal = GAS_PALETTES[Math.floor(hash(g.key, 13) * GAS_PALETTES.length)];
      return {
        ...g, type, r, ring,
        x: Math.cos(a) * ringR, y: (hash(g.key) - .5) * 70, z: Math.sin(a) * ringR,
        tilt: (hash(g.key, 9) - .5) * .7, spinRate: .05 + hash(g.key, 10) * .07,
        spin: prev?.spin ?? hash(g.key, 11) * TAU,
        seed: [hash(g.key, 20) * 97, hash(g.key, 21) * 97, hash(g.key, 22) * 97],
        pal: pal.flatMap(([, c]) => rgbf(c)), palT: pal.map(([t]) => t),
        storm: [hash(g.key, 23) * TAU, (hash(g.key, 24) - .5) * .8], ringSeed: hash(g.key, 25),
      };
    });
    const oldSats = new Map(sats.map(s => [s.id, s]));
    sats = [];
    for (const p of planets) {
      p.sessions.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
      const base = (p.ring ? p.r * 2.25 : p.r * 1.45) + 22;
      p.sessions.forEach((s, i) => {
        const prev = oldSats.get(s.sessionId);
        sats.push({
          id: s.sessionId, s, planet: p, r: base + i * 24,
          inc: (hash(s.sessionId, 1) - .5) * 1.1, node: hash(s.sessionId, 2) * TAU,
          theta: prev ? prev.theta : hash(s.sessionId, 3) * TAU, lift: prev ? prev.lift : 0, seen: !!prev,
        });
      });
    }
    // 惑星の並ぶ輪の外側を回る、小さな岩の帯（回すと手前と奥で流れる速さが違って見える）
    if (planets.length > 1 && dust.R !== ringR) {
      const r = rng(.31337);
      dust = Array.from({ length: 700 }, () => {
        const rad = ringR * 1.3 + gauss(r) * ringR * .07;
        return { a: r() * TAU, rad, y: gauss(r) * 9, w: .018 * Math.pow(ringR * 1.3 / rad, 1.5), s: .7 + r() * 1.2, b: .25 + r() * .45 };
      });
      dust.R = ringR;
    } else if (planets.length <= 1) dust = [];
    orbitsDirty = true;
    // 観測していたセッションが終わったら、その惑星の観測に切り替える。惑星もなくなったら観測をやめる
    if (focus?.kind === 'sat' && !sats.some(x => x.id === focus.key)) focus = { kind: 'planet', key: focus.planet, planet: focus.planet };
    if (focus && !planets.some(p => p.key === focus.planet)) focus = null;
  }

  // ---------- 座標 ----------
  // 太陽は世界に固定する。最初のカメラから見て左上の手前にある
  const SUN = (() => {
    const v = [-.62, -.42, -.66], n = Math.hypot(...v), [x, y, z] = v.map(c => c / n), cp = Math.cos(.36), sp = Math.sin(.36);
    return [x, y * cp + z * sp, -y * sp + z * cp];
  })();
  function basis() {
    const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    return [[cy, 0, -sy], [-sy * sp, cp, -cy * sp], [sy * cp, sp, cy * cp]]; // 行ごと（世界 → カメラ）
  }
  let R = basis();
  const rot = (x, y, z) => [R[0][0] * x + R[0][1] * y + R[0][2] * z, R[1][0] * x + R[1][1] * y + R[1][2] * z, R[2][0] * x + R[2][1] * y + R[2][2] * z];
  // カメラから見た位置（目が原点、奥が +z）
  function camPos(x, y, z) { const c = rot(x - cam.t[0], y - cam.t[1], z - cam.t[2]); c[2] += cam.dist; return c; }
  function project(pt) {
    const [x, y, d] = camPos(pt.x, pt.y, pt.z);
    if (d < 20) return null;
    const k = focal / d;
    return { x: W / 2 + cam.ox + x * k, y: H * .55 + cam.oy + y * k, k, z: d };
  }
  function satPos(sat, theta, lift = sat.lift) {
    const p = sat.planet;
    let x = Math.cos(theta) * sat.r, y = 0, z = Math.sin(theta) * sat.r;
    const ci = Math.cos(sat.inc), si = Math.sin(sat.inc);
    [y, z] = [y * ci - z * si, y * si + z * ci];
    const cn = Math.cos(sat.node), sn = Math.sin(sat.node);
    [x, z] = [x * cn + z * sn, -x * sn + z * cn];
    return { x: p.x + x, y: p.y + y - lift, z: p.z + z }; // 浮き上がりは画面の上（世界の -y）
  }

  // ---------- 状態と色 ----------
  const STATE_VARS = { call: '--beacon-call', turn: '--beacon-turn', work: '--beacon-work', rest: '--beacon-rest' };
  function readColors() {
    if (Date.now() - colorsAt < 1000) return colors;
    const cs = getComputedStyle(el), v = n => cs.getPropertyValue(n).trim();
    colors = { ink: v('--hud'), ink2: v('--hud-2'), ink3: v('--hud-3'), f: {} };
    for (const [k, n] of Object.entries(STATE_VARS)) { colors[k] = v(n); colors.f[k] = rgbf(colors[k]); }
    colors.f.ink2 = rgbf(colors.ink2);
    colorsAt = Date.now();
    return colors;
  }
  const laneOf = s => CB.laneOf(s);
  const called = s => laneOf(s) === 'you' && s.state.key !== 'yours';
  const TONE = s => { const lane = laneOf(s); return lane === 'you' ? (s.state.key === 'yours' ? 'turn' : 'call') : lane === 'work' ? 'work' : 'rest'; };
  // 1秒あたりの公転角。作業中は速く回り、呼んでいるものはほぼ止まって待つ
  function speed(s) {
    const lane = laneOf(s);
    if (lane === 'work') return .5;
    if (lane === 'you') return s.state.key === 'yours' ? .1 : .025;
    return .04;
  }
  // 待たせている衛星の高さ。2時間でいちばん高くなる（平方根で、最初の数十分の差がよく見えるように）
  const WAIT_FULL = 120 * 60000;
  const liftAt = (p, ms) => 6 + p.r * 2.2 * Math.sqrt(clamp(ms / WAIT_FULL));
  const TICKS = [15, 30, 60, 120].map(m => m * 60000);
  const liftGoal = sat => (laneOf(sat.s) === 'you' ? liftAt(sat.planet, Date.now() - CB.since(sat.s)) : 0);
  // 衛星が惑星の影に入っている度合い（1 で日なた）
  function sunlit(pos, p) {
    const v = [pos.x - p.x, pos.y - p.y, pos.z - p.z], along = v[0] * SUN[0] + v[1] * SUN[1] + v[2] * SUN[2];
    if (along > 0) return 1;
    const perp = Math.hypot(v[0] - along * SUN[0], v[1] - along * SUN[1], v[2] - along * SUN[2]);
    return .2 + .8 * smooth(p.r * .85, p.r * 1.15, perp);
  }

  // ---------- WebGL のシェーダー ----------
  const CAMERA_GLSL = `
uniform mat3 uRot; uniform vec3 uTarget; uniform float uDist; uniform vec4 uProj; uniform vec2 uDepth;
vec3 toCam(vec3 p) { vec3 c = uRot * (p - uTarget); c.z += uDist; return c; }
vec4 clipOf(vec3 c) { return vec4(uProj.x * c.x + uProj.z * c.z, -uProj.y * c.y + uProj.w * c.z, uDepth.x * c.z + uDepth.y, c.z); }`;
  const NOISE_GLSL = `
uint hsh(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y; v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v.x ^ v.y ^ v.z;
}
float rnd(vec3 i) { return float(hsh(uvec3(ivec3(i) + 32768)) & 0xffffffu) / 16777215.0; }
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(rnd(i), rnd(i + vec3(1, 0, 0)), u.x), mix(rnd(i + vec3(0, 1, 0)), rnd(i + vec3(1, 1, 0)), u.x), u.y),
             mix(mix(rnd(i + vec3(0, 0, 1)), rnd(i + vec3(1, 0, 1)), u.x), mix(rnd(i + vec3(0, 1, 1)), rnd(i + vec3(1, 1, 1)), u.x), u.y), u.z);
}
float fbm(vec3 p, int oct) {
  float s = 0.0, a = 0.5, n = 0.0;
  for (int o = 0; o < 6; o++) { if (o >= oct) break; s += vnoise(p) * a; n += a; p *= 2.03; a *= 0.5; }
  return s / n;
}
float ringA(float rho, float seed) {
  if (rho < 1.28 || rho > 2.05) return 0.0;
  float x = (rho - 1.28) / 0.77;
  float d = 0.45 + 0.25 * sin(x * 46.0 + seed * 10.0) + 0.2 * sin(x * 131.0 + seed * 30.0);
  d *= 0.55 + 0.45 * smoothstep(0.0, 0.25, x);
  d *= smoothstep(0.015, 0.04, abs(x - 0.58));
  d *= smoothstep(0.0, 0.03, x) * smoothstep(1.0, 0.93, x);
  return clamp(d, 0.0, 1.0) * 0.8;
}`;
  const V_QUAD = `#version 300 es
in vec2 aCorner; out vec2 vUv;
void main() { vUv = aCorner * 0.5 + 0.5; gl_Position = vec4(aCorner, 0.0, 1.0); }`;
  const F_SKY = `#version 300 es
precision highp float;
uniform mat3 uRot; uniform vec4 uView; uniform float uDpr; uniform sampler2D uNeb; uniform float uHasNeb;
uniform vec4 uMeteor; uniform float uMeteorA;
out vec4 o;
void main() {
  float sx = gl_FragCoord.x / uDpr, sy = uView.w - gl_FragCoord.y / uDpr;
  vec3 dw = transpose(uRot) * normalize(vec3((sx - uView.x) / uView.z, (sy - uView.y) / uView.z, 1.0));
  vec3 col = vec3(3.0, 6.0, 12.0) / 255.0;
  if (uHasNeb > 0.5) col = texture(uNeb, vec2(fract(atan(dw.z, dw.x) / 6.2831853), asin(clamp(dw.y, -1.0, 1.0)) / 3.1415927 + 0.5)).rgb;
  if (uMeteorA > 0.0) {
    vec2 p = vec2(sx, sy), a = uMeteor.xy, ab = uMeteor.zw - a;
    float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1.0), 0.0, 1.0), d = length(p - (a + ab * t));
    col += vec3(0.9, 0.95, 1.0) * uMeteorA * t * t * exp(-d * d * 0.8);
  }
  o = vec4(col, 1.0);
}`;
  const V_STAR = `#version 300 es
in vec3 aDir; in float aMag; in vec3 aColor; in float aPh;
uniform mat3 uRot; uniform vec4 uProj; uniform float uDpr, uTime;
out vec3 vCol; out float vMag, vSize;
void main() {
  vec3 c = uRot * aDir;
  if (c.z < 0.05) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  gl_Position = vec4(uProj.x * c.x + uProj.z * c.z, -uProj.y * c.y + uProj.w * c.z, 0.0, c.z);
  vSize = aMag > 0.55 ? 10.0 + aMag * 10.0 : 4.0;
  gl_PointSize = vSize * uDpr;
  float tw = aMag > 0.3 ? 0.85 + 0.15 * sin(uTime * 1.1 + aPh) : 1.0;
  vCol = aColor * (0.25 + 0.75 * aMag) * tw; vMag = aMag;
}`;
  const F_STAR = `#version 300 es
precision highp float;
in vec3 vCol; in float vMag, vSize; out vec4 o;
void main() {
  vec2 p = (gl_PointCoord - 0.5) * vSize;
  float core = clamp(0.45 + vMag * 1.4 + 0.5 - length(p), 0.0, 1.0);
  float h = vSize * 0.5;
  float sp = vMag > 0.55 ? (exp(-abs(p.y) * 2.5) * max(0.0, 1.0 - abs(p.x) / h) + exp(-abs(p.x) * 2.5) * max(0.0, 1.0 - abs(p.y) / h)) * 0.2 * vMag : 0.0;
  o = vec4(vCol * (core + sp), 0.0);
}`;
  const V_PLANET = `#version 300 es
in vec2 aCorner; uniform vec3 uCenterC; uniform float uExt; uniform vec4 uProj; uniform vec2 uDepth; out vec3 vRay;
void main() {
  vec3 c = uCenterC + vec3(aCorner * uExt, 0.0); vRay = c;
  gl_Position = vec4(uProj.x * c.x + uProj.z * c.z, -uProj.y * c.y + uProj.w * c.z, uDepth.x * c.z + uDepth.y, c.z);
}`;
  const F_PLANET = `#version 300 es
precision highp float;
in vec3 vRay; out vec4 o;
uniform mat3 uRot; uniform vec2 uDepth;
uniform vec3 uCenterC, uCenterW, uSun, uSeed, uAtm;
uniform float uR, uSpin, uTilt, uTime, uDim, uAtmK, uRingSeed;
uniform int uMode, uType, uRing, uSatN;
uniform vec3 uPal[6]; uniform float uPalT[6]; uniform vec2 uStorm; uniform vec4 uSats[12];
${NOISE_GLSL}
vec3 ramp(float t) {
  t = clamp(t, 0.0, 1.0);
  for (int i = 1; i < 6; i++) if (t <= uPalT[i]) return mix(uPal[i - 1], uPal[i], (t - uPalT[i - 1]) / max(1e-4, uPalT[i] - uPalT[i - 1]));
  return uPal[5];
}
vec3 rotY(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(p.x * c - p.z * s, p.y, p.x * s + p.z * c); }
void main() {
  vec3 dir = normalize(vRay);
  float b = dot(dir, uCenterC), cc = dot(uCenterC, uCenterC) - uR * uR, disc = b * b - cc;
  mat3 inv = transpose(uRot);
  if (uMode == 1) { // 大気の外側の光（加算）
    if (disc > 0.0) discard;
    float m = sqrt(max(0.0, dot(uCenterC, uCenterC) - b * b)), rim = (m - uR) / uR;
    if (rim > 0.4) discard;
    float lam = dot(inv * normalize(dir * b - uCenterC), uSun);
    float a = pow(1.0 - rim / 0.4, 2.2) * uAtmK * 0.5 * clamp(lam * 0.9 + 0.3, 0.0, 1.0);
    gl_FragDepth = (uDepth.x + uDepth.y / uCenterC.z) * 0.5 + 0.5;
    o = vec4(uAtm * a * uDim, 0.0);
    return;
  }
  if (disc <= 0.0) discard;
  vec3 P = dir * (b - sqrt(disc)), N = (P - uCenterC) / uR;
  gl_FragDepth = (uDepth.x + uDepth.y / P.z) * 0.5 + 0.5;
  vec3 Nw = inv * N, Vw = inv * -dir, Pw = uCenterW + Nw * uR;
  // 地軸に合わせた向き（傾きを戻してから自転を戻す）
  float ct = cos(-uTilt), st = sin(-uTilt);
  vec3 ob = rotY(vec3(Nw.x * ct - Nw.y * st, Nw.x * st + Nw.y * ct, Nw.z), uSpin);
  float lam = dot(Nw, uSun), shade = 1.0;
  // 衛星の影
  for (int i = 0; i < 12; i++) {
    if (i >= uSatN) break;
    vec3 v = uSats[i].xyz - Pw; float t = dot(v, uSun);
    if (t > 0.0) shade *= mix(0.22, 1.0, smoothstep(uSats[i].w * 0.6, uSats[i].w * 1.25, length(v - uSun * t)));
  }
  // 環の影
  if (uRing == 1) {
    vec3 n = vec3(-sin(uTilt), cos(uTilt), 0.0); float den = dot(uSun, n);
    if (abs(den) > 1e-3) {
      float s = dot(uCenterW - Pw, n) / den;
      if (s > 0.0) shade *= 1.0 - ringA(length(Pw + uSun * s - uCenterW) / uR, uRingSeed) * 0.85;
    }
  }
  float light = 0.03 + 0.97 * smoothstep(-0.12, 0.55, lam) * clamp(lam * 0.6 + 0.55, 0.0, 1.0) * shade;
  vec3 col; float spec = 0.0, cloud = 0.0; vec3 glow = vec3(0.0);
  float lat = asin(clamp(ob.y, -1.0, 1.0));
  if (uType == 0) { // ガス: 緯度に沿った縞を乱流でゆがめ、緯度ごとに少しずつずらして回す。大きな渦がひとつ
    vec3 q = rotY(ob, uTime * 0.02 * sin(lat * 7.0));
    float v = q.y * 5.5 + (fbm(q * 2.2 + uSeed, 5) - 0.5) * 1.4 + (fbm(q * vec3(7.0, 14.0, 7.0) + uSeed.zxy, 3) - 0.5) * 0.35;
    float lon = atan(ob.z, ob.x), dl = atan(sin(lon - uStorm.x), cos(lon - uStorm.x)), dy = lat - uStorm.y;
    float sd = length(vec2(dl * 0.55, dy * 1.6));
    if (sd < 0.18) v += sin(atan(dy, dl) * 2.0 + sd * 30.0 - uTime * 0.6) * (1.0 - sd / 0.18) * 0.6;
    col = ramp((sin(v * 3.1415927) + 1.0) / 2.0);
    if (sd < 0.12) col = mix(col, vec3(0.71, 0.33, 0.18), (1.0 - sd / 0.12) * 0.55);
    col *= 0.6 + 0.4 * sqrt(max(0.0, dot(N, -dir))); // 周辺減光
  } else if (uType == 1) { // 地球型: 海と陸、極の氷、流れる雲、夜の街の灯
    float h = fbm(ob * 1.8 + uSeed + vec3(3.0, 0.0, 0.0), 6), moist = fbm(ob * 2.5 + uSeed.yzx, 4), sea = 0.52;
    bool land = h >= sea;
    if (!land) { col = mix(vec3(0.024, 0.13, 0.25), vec3(0.11, 0.36, 0.53), smoothstep(sea - 0.18, sea, h)); spec = 1.0; }
    else {
      float e = (h - sea) / (1.0 - sea);
      col = moist < 0.45 ? mix(vec3(0.72, 0.6, 0.38), vec3(0.55, 0.44, 0.27), clamp(e * 2.0, 0.0, 1.0))
                         : mix(vec3(0.18, 0.37, 0.17), vec3(0.43, 0.44, 0.27), clamp(e * 2.2, 0.0, 1.0));
      col = mix(col, vec3(0.93, 0.95, 0.96), smoothstep(0.42, 0.6, e));
    }
    float cap = abs(ob.y) + (fbm(ob * 4.0 + uSeed.zyx, 3) - 0.5) * 0.25;
    if (cap > 0.82) { col = mix(col, vec3(0.93, 0.96, 0.97), smoothstep(0.82, 0.88, cap)); spec = 0.0; land = false; }
    cloud = smoothstep(0.5, 0.72, fbm(rotY(ob, uTime * 0.012) * vec3(3.0, 5.0, 3.0) + uSeed + 9.0, 5)) * 0.92;
    if (land) glow = vec3(1.0, 0.78, 0.45) * smoothstep(0.6, 0.72, fbm(ob * 22.0 + uSeed.yxz, 3)) * smoothstep(0.05, -0.25, lam) * (1.0 - cloud) * 0.9;
  } else if (uType == 2) { // 氷
    float n = fbm(ob * 2.0 + uSeed, 5), ridge = 1.0 - abs(fbm(ob * 6.0 + uSeed.yzx, 4) * 2.0 - 1.0);
    col = mix(mix(vec3(0.61, 0.76, 0.85), vec3(0.92, 0.96, 0.97), n), vec3(0.37, 0.56, 0.68), pow(ridge, 10.0) * 0.7);
    spec = 0.35;
  } else { // 岩石: 斑とクレーター
    float n = fbm(ob * 2.4 + uSeed, 6);
    col = mix(vec3(0.31, 0.27, 0.25), vec3(0.66, 0.57, 0.46), smoothstep(0.3, 0.75, n));
    col = mix(col, vec3(0.48, 0.42, 0.35), fbm(ob * 9.0 + uSeed.zxy, 3) * 0.4);
    vec3 p = ob * 3.2 + uSeed, ip = floor(p), fp = fract(p); float best = 9.0;
    for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      vec3 g = vec3(x, y, z), cell = ip + g;
      float r4 = rnd(cell + 47.0);
      if (r4 < 0.35) continue;
      vec3 pt = g + vec3(rnd(cell), rnd(cell + 17.0), rnd(cell + 31.0)) - fp;
      best = min(best, length(pt) / (0.1 + pow(r4, 3.0) * 0.4));
    }
    if (best < 1.0) col = mix(col, best > 0.82 ? vec3(0.77, 0.69, 0.59) : vec3(0.23, 0.2, 0.18), best > 0.82 ? 0.5 : (1.0 - best) * 0.55);
  }
  col = mix(col, vec3(0.96), cloud);
  vec3 c = col * light + glow;
  if (spec > 0.0) c += vec3(1.0, 0.95, 0.85) * pow(max(0.0, dot(Nw, normalize(uSun + Vw))), 60.0) * 0.7 * spec * (1.0 - cloud) * smoothstep(0.0, 0.2, lam) * shade;
  c += uAtm * pow(1.0 - max(0.0, dot(N, -dir)), 2.6) * uAtmK * clamp(lam * 0.9 + 0.35, 0.0, 1.0); // 大気: ふちほど濃く、昼側で明るい
  o = vec4(c * uDim, 1.0);
}`;
  const V_RING = `#version 300 es
in vec2 aCorner; uniform vec3 uCenterW; uniform float uR, uTilt; out vec2 vLocal; out vec3 vW;
${CAMERA_GLSL}
void main() {
  vec2 l = aCorner * 2.1; vLocal = l;
  vW = uCenterW + vec3(l.x * cos(uTilt), l.x * sin(uTilt), l.y) * uR;
  gl_Position = clipOf(toCam(vW));
}`;
  const F_RING = `#version 300 es
precision highp float;
in vec2 vLocal; in vec3 vW; out vec4 o;
uniform vec3 uCenterW, uSun; uniform float uR, uTilt, uRingSeed, uDim;
${NOISE_GLSL}
void main() {
  float a = ringA(length(vLocal), uRingSeed);
  if (a < 0.01) discard;
  vec3 oc = vW - uCenterW; float bb = dot(oc, uSun), m = sqrt(max(0.0, dot(oc, oc) - bb * bb));
  float lit = bb < 0.0 ? mix(0.12, 1.0, smoothstep(uR * 0.97, uR * 1.03, m)) : 1.0; // 惑星の影
  vec3 n = vec3(-sin(uTilt), cos(uTilt), 0.0);
  vec3 col = vec3(0.87, 0.8, 0.69) * (0.35 + 0.65 * abs(dot(n, uSun))) * lit;
  o = vec4(col * uDim, a * (0.55 + 0.45 * uDim));
}`;
  const V_LINE = `#version 300 es
in vec3 aPos; in float aT; out float vT;
${CAMERA_GLSL}
void main() { vT = aT; gl_Position = clipOf(toCam(aPos)); }`;
  const F_LINE = `#version 300 es
precision highp float;
in float vT; uniform vec4 uColor; uniform float uDash; out vec4 o;
void main() { if (uDash > 0.0 && fract(vT / uDash) > 0.55) discard; o = uColor; }`;
  // 衛星の灯り・尾・波紋・目盛り・岩の帯をまとめて描く（1つ10個の数: 位置3, 色4, 大きさ, 種類, 明るさ）
  const V_SPRITE = `#version 300 es
in vec2 aCorner; in vec3 aPos; in vec4 aCol; in float aSize, aKind, aBright;
uniform vec2 uScreen;
${CAMERA_GLSL}
out vec2 vUv; out vec4 vCol; out float vKind, vSize, vBright;
void main() {
  vec4 c = clipOf(toCam(aPos));
  if (c.w < 20.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  c.xy += aCorner * aSize * 2.0 / uScreen * c.w;
  gl_Position = c; vUv = aCorner; vCol = aCol; vKind = aKind; vSize = aSize; vBright = aBright;
}`;
  const F_SPRITE = `#version 300 es
precision highp float;
in vec2 vUv; in vec4 vCol; in float vKind, vSize, vBright; out vec4 o;
void main() {
  float d = length(vUv);
  if (d > 1.0) discard;
  if (vKind < 0.5) { // 衛星: 淡い光、色の芯、白い中心
    float glow = pow(1.0 - d, 2.0) * vCol.a, core = smoothstep(0.24, 0.16, d), white = smoothstep(0.1, 0.06, d) * 0.85;
    o = vec4((vCol.rgb * (glow + core) + white) * vBright, 0.0);
  } else if (vKind < 1.5) { // 波紋
    float a = 1.0 - smoothstep(0.0, 1.0, abs(d * vSize - (vSize - 2.0)) - 0.25);
    o = vec4(vCol.rgb * vCol.a * a * vBright, 0.0);
  } else {
    o = vec4(vCol.rgb * pow(1.0 - d, 1.6) * vCol.a * vBright, 0.0);
  }
}`;
  // 仕上げ: ピント（奥行きでぼかす）、太陽のまぶしさと光の輪、四隅を少し落とす
  const F_POST = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uColor, uDepthTex; uniform vec2 uRes, uDepth;
uniform float uFocusD, uK, uMaxCoc, uTime; uniform vec3 uSun;
float coc(float z) {
  if (z >= 0.99999) return 0.0;
  float d = uDepth.y / ((z * 2.0 - 1.0) - uDepth.x);
  return min(uMaxCoc, uK * abs(d - uFocusD) / d);
}
void main() {
  vec2 px = gl_FragCoord.xy;
  float zc = texture(uDepthTex, vUv).r, cc = coc(zc);
  vec3 acc = texture(uColor, vUv).rgb; float ws = 1.0;
  if (uMaxCoc > 0.5) {
    // 標本の数はぼけの大きさに合わせる（軽くぼかすだけのときは少なく）
    int n = int(clamp(uMaxCoc * 1.5, 8.0, 32.0));
    for (int i = 0; i < 32; i++) {
      if (i >= n) break;
      float r = sqrt((float(i) + 0.5) / float(n)) * uMaxCoc, a = float(i) * 2.39996;
      vec2 uv = (px + vec2(cos(a), sin(a)) * r) / uRes;
      float z = texture(uDepthTex, uv).r, ci = coc(z);
      if (z > zc) ci = min(ci, cc); // 奥のぼけが手前にかぶらないように
      float w = clamp(ci - r + 1.0, 0.0, 1.0);
      acc += texture(uColor, uv).rgb * w; ws += w;
    }
  }
  vec3 col = acc / ws;
  if (uSun.z > 0.0) {
    vec2 d = (px - uSun.xy) / uRes.y; float r = length(d), ang = atan(d.y, d.x);
    vec3 sc = vec3(1.0, 0.86, 0.68);
    float g = exp(-r * 12.0) * 0.6 + exp(-r * 3.5) * 0.08 + smoothstep(0.012, 0.006, r) * 1.2;
    float st = pow(abs(cos(ang * 3.0 + uTime * 0.03)), 80.0) * exp(-r * 7.0) * 0.22 + pow(abs(cos(ang * 2.0 - uTime * 0.02 + 0.7)), 160.0) * exp(-r * 4.0) * 0.08;
    col += sc * (g + st) * uSun.z;
    vec2 v = uRes * 0.5 - uSun.xy;
    float tk[4] = float[4](0.45, 0.8, 1.25, 1.7);
    float rk[4] = float[4](0.035, 0.06, 0.025, 0.09);
    vec3 ck[4] = vec3[4](vec3(0.5, 0.7, 1.0), vec3(1.0, 0.7, 0.4), vec3(0.6, 1.0, 0.8), vec3(0.6, 0.5, 1.0));
    for (int k = 0; k < 4; k++) col += ck[k] * smoothstep(rk[k], rk[k] * 0.7, length(px - (uSun.xy + v * tk[k])) / uRes.y) * 0.05 * uSun.z;
  }
  col *= 1.0 - 0.28 * pow(length(vUv - 0.5) * 1.3, 2.5);
  o = vec4(col, 1.0);
}`;

  // ---------- WebGL の準備 ----------
  let P = {}, B = {}, V = {}, fbo = null, nebTex = null, starCount = 0, lineVerts = new Float32Array(0), spriteData = new Float32Array(0);
  function initGL() {
    gl = glCanvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, preserveDrawingBuffer: false });
    if (!gl) { glError = 'この画面を描くには WebGL 2 が必要です'; return; }
    try {
      const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
      const prog = (vs, fs) => {
        const p = gl.createProgram();
        gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
        const u = {};
        return { p, u: n => (n in u ? u[n] : (u[n] = gl.getUniformLocation(p, n))), a: n => gl.getAttribLocation(p, n) };
      };
      P = {
        sky: prog(V_QUAD, F_SKY), star: prog(V_STAR, F_STAR), planet: prog(V_PLANET, F_PLANET), ring: prog(V_RING, F_RING),
        line: prog(V_LINE, F_LINE), sprite: prog(V_SPRITE, F_SPRITE), post: prog(V_QUAD, F_POST),
      };
    } catch (e) { console.error(e); glError = 'この画面を描けませんでした'; gl = null; return; }
    glError = '';
    const buf = data => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); return b; };
    // [バッファ, 属性, 個数, 1つの長さ, 先頭, 図形ごとに進むか]
    const vao = (p, list) => {
      const v = gl.createVertexArray(); gl.bindVertexArray(v);
      for (const [b, name, size, stride, off, inst] of list) {
        const loc = p.a(name); if (loc < 0) continue;
        gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride * 4, off * 4);
        gl.vertexAttribDivisor(loc, inst ? 1 : 0);
      }
      gl.bindVertexArray(null);
      return v;
    };
    B.quad = buf(new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]));
    stars ||= makeStars(); starCount = stars.length / 8;
    B.star = buf(stars);
    B.orbit = gl.createBuffer(); B.line = gl.createBuffer(); B.sprite = gl.createBuffer();
    for (const k of ['sky', 'planet', 'ring', 'post']) V[k] = vao(P[k], [[B.quad, 'aCorner', 2, 2, 0]]);
    V.star = vao(P.star, [[B.star, 'aDir', 3, 8, 0], [B.star, 'aMag', 1, 8, 3], [B.star, 'aColor', 3, 8, 4], [B.star, 'aPh', 1, 8, 7]]);
    V.orbit = vao(P.line, [[B.orbit, 'aPos', 3, 4, 0], [B.orbit, 'aT', 1, 4, 3]]);
    V.line = vao(P.line, [[B.line, 'aPos', 3, 4, 0], [B.line, 'aT', 1, 4, 3]]);
    V.sprite = vao(P.sprite, [[B.quad, 'aCorner', 2, 2, 0], [B.sprite, 'aPos', 3, 10, 0, 1], [B.sprite, 'aCol', 4, 10, 3, 1],
      [B.sprite, 'aSize', 1, 10, 7, 1], [B.sprite, 'aKind', 1, 10, 8, 1], [B.sprite, 'aBright', 1, 10, 9, 1]]);
    fbo = null; nebTex = null; orbitsDirty = true;
  }
  function uploadNebula() {
    if (nebTex || !nebula) return;
    nebTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, nebTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, nebula);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  function ensureFbo(w, h) {
    if (fbo && fbo.w === w && fbo.h === h) return;
    if (fbo) { gl.deleteFramebuffer(fbo.fb); gl.deleteTexture(fbo.color); gl.deleteTexture(fbo.depth); }
    const tex = (ifmt, fmt, type, filter) => {
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, fmt, type, null);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, filter], [gl.TEXTURE_MAG_FILTER, filter], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      return t;
    };
    const color = tex(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR), depth = tex(gl.DEPTH_COMPONENT24, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, gl.NEAREST);
    const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    fbo = { fb, color, depth, w, h };
  }
  // 公転の輪は惑星が動かないので、組み立て直したときだけ作る
  function uploadOrbits() {
    const N = 97, data = new Float32Array(sats.length * N * 4);
    sats.forEach((sat, j) => {
      sat.orbitAt = j * N;
      for (let i = 0; i < N; i++) { const p = satPos(sat, i / (N - 1) * TAU, 0); data.set([p.x, p.y, p.z, 0], (j * N + i) * 4); }
    });
    gl.bindBuffer(gl.ARRAY_BUFFER, B.orbit); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    orbitsDirty = false;
  }
  function setCamera(p, A, Bd) {
    gl.uniformMatrix3fv(p.u('uRot'), false, [R[0][0], R[1][0], R[2][0], R[0][1], R[1][1], R[2][1], R[0][2], R[1][2], R[2][2]]);
    gl.uniform3fv(p.u('uTarget'), cam.t);
    gl.uniform1f(p.u('uDist'), cam.dist);
    gl.uniform4f(p.u('uProj'), 2 * focal / W, 2 * focal / H, 2 * cam.ox / W, -.1 - 2 * cam.oy / H);
    gl.uniform2f(p.u('uDepth'), A, Bd);
  }

  // ---------- カメラ ----------
  const focusPlanet = () => (focus ? planets.find(p => p.key === focus.planet) : null);
  const focusSat = () => (focus?.kind === 'sat' ? sats.find(x => x.id === focus.key) : null);
  // 観測カードの置き場所（幅が狭いときは下）。カメラはカードを除いた残りの真ん中に天体を置く
  function cardBox() {
    const card = CB.$('amb-card');
    if (!focus || card.hidden) return null;
    const r = card.getBoundingClientRect(), c = canvas.getBoundingClientRect();
    return { x: r.left - c.left, y: r.top - c.top, w: r.width, h: r.height, below: W <= 720 };
  }
  // カメラの行き先とピントを決め、a（0〜1）の割合だけ近づける
  function settle(a) {
    const box = cardBox(), fp = focusPlanet();
    let want, tgt = [0, 0, 0], ox = 0, oy = 0;
    if (fp) {
      const availW = box && !box.below ? W - box.w - 24 : W, availH = box?.below ? H - box.h - 16 : H;
      const outer = Math.max(fp.r * (fp.ring ? 2.1 : 1.4), ...sats.filter(x => x.planet === fp).map(x => x.r)) + 18;
      want = Math.max(fp.r * 2.6 + 40, outer * focal / (Math.min(availW, availH) * .42) + outer) * zoom;
      tgt = [fp.x, fp.y, fp.z];
      if (box && !box.below) ox = -(box.w + 24) / 2;
      if (box?.below) oy = (H - box.h - 16) / 2 - H * .55;
    } else {
      // 惑星の並ぶ輪が画面の幅と高さに収まる距離までカメラを引く
      const outer = ringR + 120;
      want = Math.max(300, Math.max(600, ringR * 1.45 + 420, outer * focal / (W * .4) + outer * .5, outer * focal * Math.sin(Math.max(.2, Math.abs(cam.pitch))) / (H * .3) + outer) * zoom);
    }
    if (!cam.dist) a = 1;
    cam.dist += (want - cam.dist) * a;
    for (let i = 0; i < 3; i++) cam.t[i] += (tgt[i] - cam.t[i]) * a;
    cam.ox += (ox - cam.ox) * a; cam.oy += (oy - cam.oy) * a;
    R = basis();
    // ピント: 観測中はその惑星に合わせて前後を強くぼかす。全体を見ているときは注視点に合わせて軽く
    const goal = fp ? { fd: camPos(fp.x, fp.y, fp.z)[2], k: 16, max: 12 } : { fd: cam.dist, k: 6, max: 5 };
    const b = dof.k ? a : 1;
    for (const k of ['fd', 'k', 'max']) dof[k] += (goal[k] - dof[k]) * b;
  }
  const cocAt = d => Math.min(dof.max, dof.k * Math.abs(d - dof.fd) / d);

  // ---------- 描画 ----------
  function render(t, a = 0) {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = canvas.clientWidth; H = canvas.clientHeight;
    if (!W || !H) return;
    const cw = Math.round(W * dpr), ch = Math.round(H * dpr);
    for (const cv of [glCanvas, canvas]) if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
    focal = Math.min(W, H) * 1.2;
    const reduce = CB.reduceMotion.matches;
    settle(reduce ? 1 : a);
    const c = readColors();
    for (const sat of sats) { sat.lift += (liftGoal(sat) - sat.lift) * (reduce || !sat.seen ? 1 : a); sat.seen = true; }

    // 画面上の位置（押す判定と名前の置き場所にも使う）
    for (const p of planets) { const q = project(p); p.q = q && q.z > p.r * 2 ? q : null; }
    for (const sat of sats) { sat.w = satPos(sat, sat.theta); sat.q = project(sat.w); sat.lit = sunlit(sat.w, sat.planet); }
    const fp = focusPlanet(), dim = p => (fp && p !== fp ? .4 : 1);

    if (gl && !gl.isContextLost()) drawGL(t, c, dim, reduce);
    drawOverlay(c, dim);
  }

  function drawGL(t, c, dim, reduce) {
    const cw = glCanvas.width, ch = glCanvas.height, time = clock;
    ensureFbo(cw, ch); uploadNebula();
    if (orbitsDirty) uploadOrbits();
    const near = 10, far = cam.dist * 3 + ringR * 4 + 4000, A = (far + near) / (far - near), Bd = -2 * far * near / (far - near);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fb); gl.viewport(0, 0, cw, ch);
    gl.clearColor(0, 0, 0, 1); gl.clearDepth(1); gl.depthMask(true); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);

    // 空
    let p = P.sky; gl.useProgram(p.p); gl.bindVertexArray(V.sky); setCamera(p, A, Bd);
    gl.uniform4f(p.u('uView'), W / 2 + cam.ox, H * .55 + cam.oy, focal, H); gl.uniform1f(p.u('uDpr'), dpr);
    gl.uniform1f(p.u('uHasNeb'), nebTex ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, nebTex); gl.uniform1i(p.u('uNeb'), 0);
    const m = meteor && !reduce ? meteorAt(t) : null;
    gl.uniform4f(p.u('uMeteor'), ...(m ? m.seg : [0, 0, 0, 0])); gl.uniform1f(p.u('uMeteorA'), m ? m.a : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    p = P.star; gl.useProgram(p.p); gl.bindVertexArray(V.star); setCamera(p, A, Bd);
    gl.uniform1f(p.u('uDpr'), dpr); gl.uniform1f(p.u('uTime'), time);
    gl.drawArrays(gl.POINTS, 0, starCount);

    // 惑星（不透明。奥行きを書く）
    gl.disable(gl.BLEND); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
    p = P.planet; gl.useProgram(p.p); gl.bindVertexArray(V.planet); setCamera(p, A, Bd);
    gl.uniform3fv(p.u('uSun'), SUN); gl.uniform1f(p.u('uTime'), time);
    const planetUniforms = (pl, mode) => {
      const cc = camPos(pl.x, pl.y, pl.z), d = cc[2];
      gl.uniform3fv(p.u('uCenterC'), cc); gl.uniform3f(p.u('uCenterW'), pl.x, pl.y, pl.z);
      gl.uniform1f(p.u('uExt'), pl.r * 1.5 * d / Math.sqrt(Math.max(1, d * d - pl.r * pl.r)));
      gl.uniform1f(p.u('uR'), pl.r); gl.uniform1i(p.u('uMode'), mode); gl.uniform1i(p.u('uType'), TYPES.indexOf(pl.type));
      gl.uniform3fv(p.u('uSeed'), pl.seed); gl.uniform1f(p.u('uSpin'), pl.spin); gl.uniform1f(p.u('uTilt'), pl.tilt);
      gl.uniform1f(p.u('uDim'), mode ? dim(pl) : dim(pl) === 1 ? 1 : .55);
      gl.uniform3fv(p.u('uPal'), pl.pal); gl.uniform1fv(p.u('uPalT'), pl.palT); gl.uniform2fv(p.u('uStorm'), pl.storm);
      gl.uniform3fv(p.u('uAtm'), ATM[pl.type]); gl.uniform1f(p.u('uAtmK'), ATM_STRENGTH[pl.type]);
      gl.uniform1i(p.u('uRing'), pl.ring ? 1 : 0); gl.uniform1f(p.u('uRingSeed'), pl.ringSeed);
      const mine = sats.filter(x => x.planet === pl).slice(0, 12), arr = new Float32Array(48);
      mine.forEach((x, i) => arr.set([x.w.x, x.w.y, x.w.z, SAT_BODY], i * 4));
      gl.uniform4fv(p.u('uSats'), arr); gl.uniform1i(p.u('uSatN'), mine.length);
    };
    for (const pl of planets) if (pl.q) { planetUniforms(pl, 0); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); }

    // ここから半透明（奥行きは書かない。惑星の奥にあるものは隠れる）
    gl.depthMask(false); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    p = P.ring; gl.useProgram(p.p); gl.bindVertexArray(V.ring); setCamera(p, A, Bd); gl.uniform3fv(p.u('uSun'), SUN);
    for (const pl of planets.filter(x => x.ring && x.q).sort((x, y) => y.q.z - x.q.z)) {
      gl.uniform3f(p.u('uCenterW'), pl.x, pl.y, pl.z); gl.uniform1f(p.u('uR'), pl.r); gl.uniform1f(p.u('uTilt'), pl.tilt);
      gl.uniform1f(p.u('uRingSeed'), pl.ringSeed); gl.uniform1f(p.u('uDim'), dim(pl));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    // 公転の輪と、浮いた衛星から公転面へ下ろす点線
    p = P.line; gl.useProgram(p.p); setCamera(p, A, Bd);
    gl.bindVertexArray(V.orbit); gl.uniform1f(p.u('uDash'), 0);
    for (const sat of sats) {
      const col = called(sat.s) ? c.f.call : c.f.ink2;
      gl.uniform4f(p.u('uColor'), ...col, (called(sat.s) ? .5 : .2) * dim(sat.planet));
      gl.drawArrays(gl.LINE_STRIP, sat.orbitAt, 97);
    }
    const lifted = sats.filter(x => x.lift > 1);
    if (lifted.length) {
      if (lineVerts.length < lifted.length * 8) lineVerts = new Float32Array(lifted.length * 8);
      lifted.forEach((sat, i) => { const f = satPos(sat, sat.theta, 0); lineVerts.set([sat.w.x, sat.w.y, sat.w.z, 0, f.x, f.y, f.z, sat.lift], i * 8); });
      gl.bindVertexArray(V.line); gl.bindBuffer(gl.ARRAY_BUFFER, B.line); gl.bufferData(gl.ARRAY_BUFFER, lineVerts, gl.DYNAMIC_DRAW);
      gl.uniform1f(p.u('uDash'), 3.5);
      lifted.forEach((sat, i) => { gl.uniform4f(p.u('uColor'), ...c.f[TONE(sat.s)], .6 * dim(sat.planet)); gl.drawArrays(gl.LINES, i * 2, 2); });
    }

    // 光るもの（加算）: 大気の外側、衛星、尾、波紋、目盛り、岩の帯
    gl.blendFunc(gl.ONE, gl.ONE);
    p = P.planet; gl.useProgram(p.p); gl.bindVertexArray(V.planet); setCamera(p, A, Bd);
    for (const pl of planets) if (pl.q) { planetUniforms(pl, 1); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); }
    const n = buildSprites(t, c, dim);
    if (n) {
      p = P.sprite; gl.useProgram(p.p); gl.bindVertexArray(V.sprite); setCamera(p, A, Bd); gl.uniform2f(p.u('uScreen'), W, H);
      gl.bindBuffer(gl.ARRAY_BUFFER, B.sprite); gl.bufferData(gl.ARRAY_BUFFER, spriteData.subarray(0, n * 10), gl.DYNAMIC_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
    }
    gl.depthMask(true);

    // 仕上げ
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, cw, ch);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    p = P.post; gl.useProgram(p.p); gl.bindVertexArray(V.post);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, fbo.color); gl.uniform1i(p.u('uColor'), 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, fbo.depth); gl.uniform1i(p.u('uDepthTex'), 1);
    gl.uniform2f(p.u('uRes'), cw, ch); gl.uniform2f(p.u('uDepth'), A, Bd);
    gl.uniform1f(p.u('uFocusD'), dof.fd); gl.uniform1f(p.u('uK'), dof.k * dpr); gl.uniform1f(p.u('uMaxCoc'), dof.max * dpr);
    gl.uniform1f(p.u('uTime'), time); gl.uniform3fv(p.u('uSun'), sunOnScreen());
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.activeTexture(gl.TEXTURE0);
  }

  // 太陽の画面上の位置（端末の画素、下が原点）と強さ。惑星に隠れると弱まる
  function sunOnScreen() {
    const s = rot(...SUN);
    if (s[2] < .05) return [0, 0, 0];
    const sx = W / 2 + cam.ox + s[0] / s[2] * focal, sy = H * .55 + cam.oy + s[1] / s[2] * focal;
    const out = Math.max(0, -sx, sx - W, -sy, sy - H);
    let k = 1 - smooth(0, Math.max(W, H) * .6, out);
    for (const p of planets) if (p.q) k *= 1 - smooth(p.r * p.q.k * 1.05, p.r * p.q.k * .85, Math.hypot(sx - p.q.x, sy - p.q.y));
    return [sx * dpr, (H - sy) * dpr, k];
  }
  function meteorAt(t) {
    const p = (t - meteor.t0) / meteor.dur;
    if (p >= 1 || p < 0) { meteor = null; return null; }
    const hx = meteor.x + meteor.dx * meteor.len * p, hy = meteor.y + meteor.dy * meteor.len * p, tl = Math.min(p, .4) * meteor.len;
    return { seg: [hx - meteor.dx * tl, hy - meteor.dy * tl, hx, hy], a: Math.sin(p * Math.PI) };
  }

  function buildSprites(t, c, dim) {
    const out = [];
    const put = (pos, col, a, size, kind, bright) => out.push(pos.x, pos.y, pos.z, col[0], col[1], col[2], a, size, kind, bright);
    for (const sat of sats) {
      if (!sat.q) continue;
      const s = sat.s, col = c.f[TONE(s)], lane = laneOf(s), dk = dim(sat.planet), br = sat.lit;
      const r = clamp((lane === 'you' ? 4.2 : lane === 'work' ? 3.4 : 2.4) * sat.q.k * 1.4, 1.8, 9);
      if (lane === 'work') for (let i = 1; i <= 16; i++) put(satPos(sat, sat.theta - i * .03), col, (1 - i / 17) * .35 * dk, r * (1 - i / 20) * 1.2, 2, br); // 尾
      put(sat.w, col, (lane === 'rest' ? .2 : .55) * dk, r * 5, 0, br * (.4 + .6 * dk));
      if (lane === 'you') { // 呼んでいる衛星は波紋を出す
        const ph = (t / (called(s) ? 1100 : 2400)) % 1;
        put(sat.w, col, (1 - ph) * .9 * dk, r + 5 + ph * 24, 1, 1);
      }
      if (sat.lift > 1) { // 公転面の足もとと、待ち時間の目盛り
        put(satPos(sat, sat.theta, 0), col, .6 * dk, 3.5, 2, 1);
        for (const ms of TICKS) { const h = liftAt(sat.planet, ms); if (h < sat.lift - 1) put(satPos(sat, sat.theta, h), col, .55 * dk, 2.6, 2, 1); }
      }
    }
    const k = focusPlanet() ? .35 : 1;
    for (const d of dust) {
      const a = d.a + clock * d.w;
      put({ x: Math.cos(a) * d.rad, y: d.y, z: Math.sin(a) * d.rad }, [.62, .56, .5], d.b * k, d.s, 2, 1);
    }
    if (spriteData.length < out.length) spriteData = new Float32Array(Math.ceil(out.length * 1.5));
    spriteData.set(out);
    return out.length / 10;
  }

  // 名前・呼んでいる印・観測の印（Canvas 2D）
  function drawOverlay(c, dim) {
    const g = g2;
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const message = glError || (!planets.length ? '稼働中のセッションはありません' : '');
    if (message) {
      g.fillStyle = c.ink2; g.font = '16px "IBM Plex Sans JP", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(message, W / 2, H / 2);
      return;
    }
    const fp = focusPlanet(), sharp = q => 1 - clamp(cocAt(q.z) / 12) * .7; // ぼけている天体の名前は薄く
    g.shadowColor = 'rgba(0,0,0,.8)';
    for (const p of planets) {
      const q = p.q; if (!q) continue;
      const r = p.r * q.k, a = dim(p) * sharp(q);
      if (p.sessions.some(called)) { g.strokeStyle = c.call; g.globalAlpha = a * .7; g.lineWidth = 1.5; g.beginPath(); g.arc(q.x, q.y, r + 6, 0, TAU); g.stroke(); }
      g.globalAlpha = a;
      g.fillStyle = c.ink; g.font = `600 ${Math.round(clamp(13 * q.k * 1.3, 12, 22))}px "IBM Plex Sans JP", sans-serif`; g.textAlign = 'center'; g.textBaseline = 'top';
      g.shadowBlur = 6;
      g.fillText(short(p.name, 26), q.x, q.y + r * (p.ring ? 1.25 : 1) + 10);
      g.shadowBlur = 0;
    }
    for (const sat of sats) {
      const q = sat.q, s = sat.s, lane = laneOf(s), dk = dim(sat.planet);
      if (!q) continue;
      if (!((lane === 'you' && dk === 1) || hoverSat === sat || (fp === sat.planet && focus.kind === 'planet'))) continue;
      // 手前の惑星に隠れている衛星の名前は出さない
      if (hidden(q)) continue;
      const r = clamp((lane === 'you' ? 4.2 : 3) * q.k * 1.4, 1.8, 9);
      // 惑星より左にいるときは名前を左側に出し、同じ惑星の衛星どうしで重なりにくくする
      const left = sat.planet.q && q.x < sat.planet.q.x;
      const lx = left ? q.x - r - 12 : q.x + r + 12;
      const e = CB.elapsed(Date.now() - CB.since(s));
      g.globalAlpha = sharp(q); g.shadowBlur = 6;
      g.font = `600 ${lane === 'you' ? 14 : 12}px "IBM Plex Sans JP", sans-serif`; g.textAlign = left ? 'right' : 'left'; g.textBaseline = 'middle';
      g.fillStyle = c.ink; g.fillText(short(s.name, 26), lx, q.y - 7);
      g.fillStyle = c[TONE(s)]; g.font = '500 12px "IBM Plex Sans JP", sans-serif'; g.fillText(`${s.state.label}　${e.n}${e.u}`, lx, q.y + 10);
      g.shadowBlur = 0;
    }
    g.globalAlpha = 1;
    if (focus) drawLeader(g, c);
  }
  // 観測中の天体を四隅の括弧で囲み、カードまで細い線を引く
  function drawLeader(g, c) {
    const box = cardBox(), fp = focusPlanet(), fs = focusSat();
    const q = fs ? fs.q : fp?.q;
    if (!q) return;
    const col = fs ? c[TONE(fs.s)] : c.ink2;
    const rr = fs ? 13 : fp.r * q.k * (fp.ring ? 1.3 : 1) + 12, arm = Math.min(10, rr * .5);
    g.strokeStyle = col; g.lineWidth = 1.5; g.globalAlpha = .9;
    g.beginPath();
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      g.moveTo(q.x + sx * rr, q.y + sy * (rr - arm)); g.lineTo(q.x + sx * rr, q.y + sy * rr); g.lineTo(q.x + sx * (rr - arm), q.y + sy * rr);
    }
    g.stroke();
    if (box) {
      g.lineWidth = 1; g.globalAlpha = .5; g.beginPath();
      if (box.below) {
        const ex = clamp(q.x, box.x + 24, box.x + box.w - 24), ey = box.y - 1;
        g.moveTo(q.x, q.y + rr); g.lineTo(q.x, ey - 18); g.lineTo(ex, ey - 18); g.lineTo(ex, ey);
      } else {
        const ex = box.x - 1, ey = box.y + 30;
        g.moveTo(q.x + rr, q.y - rr); g.lineTo(ex - 28, ey); g.lineTo(ex, ey);
      }
      g.stroke();
    }
    g.globalAlpha = 1;
  }

  function frame(t) {
    raf = 0;
    if (!open || document.hidden) return;
    const dt = Math.min(.1, lastT ? (t - lastT) / 1000 : 0);
    lastT = t; clock += dt;
    if (!drag?.moved) cam.yaw += dt * .03; // つかんで回している間は自転を止める
    for (const sat of sats) sat.theta += dt * speed(sat.s);
    for (const p of planets) p.spin += dt * p.spinRate;
    // ときどき流れ星
    if (!meteor && t > nextMeteor) {
      if (nextMeteor) {
        const ang = .35 + Math.random() * .4, side = Math.random() < .5 ? -1 : 1;
        meteor = { x: W * (.15 + Math.random() * .7), y: H * (.05 + Math.random() * .3), dx: side * Math.cos(ang), dy: Math.sin(ang), len: 160 + Math.random() * 140, t0: t, dur: 700 + Math.random() * 400 };
      }
      nextMeteor = t + 9000 + Math.random() * 16000;
    }
    render(t, 1 - Math.exp(-dt * 4));
    raf = requestAnimationFrame(frame);
  }
  function kick() {
    if (!open) return;
    if (CB.reduceMotion.matches) { render(0, 1); return; } // 動きを減らす設定では1枚だけ描く
    render(performance.now()); // 次のフレームを待たずに1枚描いておく
    if (!raf) { lastT = 0; raf = requestAnimationFrame(frame); }
  }
  const redraw = () => { if (CB.reduceMotion.matches && open) render(0, 1); };

  function hud() {
    CB.$('amb-clock').textContent = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    const v = CB.$('verdict'), av = CB.$('amb-verdict');
    av.textContent = v.textContent; av.dataset.tone = v.dataset.tone || 'calm';
    tickCard(); renderNote();
    redraw();
  }

  // ---------- 観測カード ----------
  const sinceHtml = s => `<span class="num" data-since="${CB.esc(CB.since(s))}"></span>`;
  function satCard(sat) {
    const { esc } = CB, s = sat.s, st = s.state;
    const prompt = CB.plain(s.lastPrompt), handoffFresh = s.handoff && s.handoff.at >= (s.lastPromptAt || 0);
    const reply = handoffFresh || st.key === 'working' ? '' : CB.plain(s.lastReply);
    const say = [
      prompt && ['依頼', prompt],
      handoffFresh && st.key !== 'working' && ['引き継ぎ', s.handoff.text],
      reply && ['返答', reply],
    ].filter(Boolean);
    const tools = st.key === 'working' ? (s.recentTools || []).slice(0, 3) : [];
    return `
      <div class="ac-top"><button class="ac-crumb" data-planet="${esc(sat.planet.key)}" title="このプロジェクトのセッション一覧">${esc(sat.planet.name)}</button>
        <button class="ac-x" data-unfocus aria-label="観測をやめる">閉じる</button></div>
      <h2 class="ac-name">${esc(s.name)}</h2>
      <p class="ac-state" data-tone="${TONE(s)}">${sinceHtml(s)}<span>${esc(st.label)}</span></p>
      ${CB.where(s, true) ? `<p class="ac-where">${CB.where(s, true)}</p>` : ''}
      ${st.key !== 'yours' && st.reason && !tools.length ? `<p class="ac-reason">${esc(st.reason)}</p>` : ''}
      ${tools.length ? `<ul class="ac-tools">${tools.map(t => `<li><b>${esc(t.name)}</b>${esc(t.detail)}</li>`).join('')}</ul>` : ''}
      ${say.length ? `<dl class="ac-say">${say.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}
      <div class="ac-actions">${CB.openActions(s)}<button class="act" data-detail="${esc(s.sessionId)}">経緯をすべて見る</button></div>`;
  }
  function planetCard(p) {
    const { esc } = CB;
    const order = { call: 0, turn: 1, work: 2, rest: 3 };
    // 並びは状態と名前で決める（時刻で並べると更新のたびに入れ替わり、押そうとした行がずれる）
    const list = sats.filter(x => x.planet === p).sort((a, b) => order[TONE(a.s)] - order[TONE(b.s)] || a.s.name.localeCompare(b.s.name, 'ja'));
    return `
      <div class="ac-top"><span class="ac-count num">${esc(list.length)}件のセッション</span>
        <button class="ac-x" data-unfocus aria-label="観測をやめる">閉じる</button></div>
      <h2 class="ac-name">${esc(p.name)}</h2>
      <ul class="ac-list">${list.map(x => `<li><button data-sat="${esc(x.id)}" data-tone="${TONE(x.s)}">
        <span class="ac-l-name">${esc(x.s.name)}</span><span class="ac-l-state">${esc(x.s.state.label)}　${sinceHtml(x.s)}</span></button></li>`).join('')}</ul>`;
  }
  function renderCard() {
    const card = CB.$('amb-card');
    const fs = focusSat(), fp = focusPlanet();
    const html = !focus ? '' : fs ? satCard(fs) : fp ? planetCard(fp) : '';
    card.hidden = !html;
    if (html !== cardHtml) { // 変わったときだけ差し替える（押しかけのボタンやスクロール位置を保つ）
      const keep = card.contains(document.activeElement) ? document.activeElement.dataset : null;
      card.innerHTML = cardHtml = html;
      if (keep) card.querySelector(keep.sat ? `[data-sat="${CSS.escape(keep.sat)}"]` : keep.planet ? '[data-planet]' : '[data-unfocus]')?.focus();
      if (!(keep?.sat)) card.scrollTop = 0;
    }
    tickCard();
  }
  function tickCard() {
    for (const n of CB.$('amb-card').querySelectorAll('[data-since]')) {
      const e = CB.elapsed(Date.now() - Number(n.dataset.since));
      n.textContent = `${e.n}${e.u}`;
    }
  }
  function setFocus(f) {
    if ((f?.planet || null) !== (focus?.planet || null)) zoom = 1; // 別の天体に移ったら寄り具合を戻す
    focus = f;
    renderCard(); renderNote();
    if (CB.reduceMotion.matches) redraw(); else kick();
  }

  // ---------- 呼ばれたときの知らせ（画面は閉じない） ----------
  function renderNote() {
    const box = CB.$('amb-call');
    const s = note && CB.getData()?.sessions.find(x => x.sessionId === note.id);
    const stale = !s || laneOf(s) !== 'you' || Date.now() - note.at > 90000 || (focus?.kind === 'sat' && focus.key === note.id);
    if (stale) { note = null; if (!box.hidden) { box.hidden = true; box.innerHTML = noteHtml = ''; } return; }
    const { esc } = CB, more = note.more ? `<span class="amb-call-more">ほか${esc(note.more)}件</span>` : '';
    const html = `<i aria-hidden="true"></i><p><b>${esc(s.name)}</b><span>${esc(s.state.label)}</span>${more}</p>
      <button class="ctl" data-sat="${esc(s.sessionId)}">近くで見る</button><button class="ac-x" data-dismiss aria-label="知らせを閉じる">閉じる</button>`;
    box.dataset.tone = TONE(s);
    if (noteHtml !== html) box.innerHTML = noteHtml = html;
    box.hidden = false;
  }

  // ---------- 操作 ----------
  function pointer(ev) { const r = canvas.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; }
  // 手前の惑星に隠れているか（名前を出すかと、押せるかの判定に使う）
  const hidden = q => planets.some(p => p.q && p.q.z < q.z && Math.hypot(p.q.x - q.x, p.q.y - q.y) < p.r * p.q.k);
  function pickSat(ev) {
    const [mx, my] = pointer(ev);
    let best = null, bd = 22;
    for (const sat of sats) { if (!sat.q || hidden(sat.q)) continue; const d = Math.hypot(sat.q.x - mx, sat.q.y - my); if (d < bd) { bd = d; best = sat; } }
    return best;
  }
  function pickPlanet(ev) {
    const [mx, my] = pointer(ev);
    let best = null, bz = Infinity;
    for (const p of planets) { if (!p.q) continue; if (Math.hypot(p.q.x - mx, p.q.y - my) < p.r * p.q.k + 8 && p.q.z < bz) { bz = p.q.z; best = p; } }
    return best;
  }
  function focusSession(id) {
    const sat = sats.find(x => x.id === id);
    if (sat) setFocus({ kind: 'sat', key: sat.id, planet: sat.planet.key });
  }
  function pick(ev) {
    const sat = pickSat(ev);
    if (sat) return setFocus({ kind: 'sat', key: sat.id, planet: sat.planet.key });
    const p = pickPlanet(ev);
    if (p) return setFocus({ kind: 'planet', key: p.key, planet: p.key });
    if (focus) setFocus(null); // 何もないところを押したら観測をやめて全体に戻る
  }
  function zoomBy(f) { zoom = clamp(zoom * f, ZOOM_MIN, ZOOM_MAX); redraw(); }
  function turn(dyaw, dpitch) { cam.yaw += dyaw; cam.pitch = clamp(cam.pitch + dpitch, PITCH_MIN, PITCH_MAX); redraw(); }

  const api = {
    init(cb) {
      el = cb.$('ambient'); glCanvas = cb.$('ambient-canvas'); canvas = cb.$('ambient-overlay'); g2 = canvas.getContext('2d');
      cb.$('ambient-open').onclick = () => api.open();
      cb.$('ambient-close').onclick = () => api.close();
      glCanvas.addEventListener('webglcontextlost', e => e.preventDefault());
      glCanvas.addEventListener('webglcontextrestored', () => { initGL(); kick(); });
      document.addEventListener('keydown', e => {
        if (!open || cb.$('detail').open) return; // 詳細パネルが開いているときはそちらが先
        if (e.target.closest?.('input, textarea')) return;
        if (e.key === 'Escape') { if (focus) setFocus(null); else api.close(); return; }
        const k = { '+': () => zoomBy(1 / 1.25), '=': () => zoomBy(1 / 1.25), '-': () => zoomBy(1.25),
          ArrowLeft: () => turn(.12, 0), ArrowRight: () => turn(-.12, 0), ArrowUp: () => turn(0, -.08), ArrowDown: () => turn(0, .08) }[e.key];
        // カードや知らせの中ではスクロールなどに矢印キーを使うので取らない（閉じるボタンにいるときは取る）
        if (k && !e.target.closest?.('.amb-card, .amb-call')) { e.preventDefault(); k(); }
      });
      // ドラッグで回す。ほとんど動かさずに離したらクリックとして扱う。指2本ではつまんで寄る
      const touches = new Map();
      const spread = () => { const [a, b] = [...touches.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
      canvas.addEventListener('pointerdown', ev => {
        if (ev.button !== 0) return;
        touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        try { canvas.setPointerCapture(ev.pointerId); } catch {} // 捕まえられなくても操作は続ける
        if (touches.size === 2) { drag = { pinch: spread(), moved: true }; return; }
        if (touches.size > 2) return;
        drag = { x: ev.clientX, y: ev.clientY, lx: ev.clientX, ly: ev.clientY, moved: false };
      });
      canvas.addEventListener('pointermove', ev => {
        if (touches.has(ev.pointerId)) touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        if (drag?.pinch) {
          if (touches.size === 2) { const d = spread(); if (d > 0) zoomBy(drag.pinch / d); drag.pinch = d; }
          return;
        }
        if (drag) {
          if (!drag.moved && Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y) > 4) { drag.moved = true; hoverSat = null; canvas.style.cursor = 'grabbing'; }
          if (drag.moved) turn((ev.clientX - drag.lx) * .005, (ev.clientY - drag.ly) * .004);
          drag.lx = ev.clientX; drag.ly = ev.clientY;
          return;
        }
        hoverSat = pickSat(ev); hoverPlanet = hoverSat ? null : pickPlanet(ev);
        canvas.style.cursor = hoverSat || hoverPlanet ? 'pointer' : 'grab';
        redraw();
      });
      const endDrag = ev => {
        touches.delete(ev.pointerId);
        if (drag?.pinch) { if (!touches.size) { drag = null; canvas.style.cursor = 'grab'; } return; } // 2本とも離すまで回さない
        if (!drag) return;
        const click = !drag.moved && ev.type === 'pointerup';
        drag = null; canvas.style.cursor = 'grab';
        if (click) pick(ev);
      };
      canvas.addEventListener('pointerup', endDrag);
      canvas.addEventListener('pointercancel', endDrag);
      canvas.addEventListener('wheel', ev => {
        ev.preventDefault();
        const dy = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaY;
        zoomBy(Math.exp(clamp(dy, -120, 120) * (ev.ctrlKey ? .01 : .0015))); // ctrlKey はトラックパッドのつまむ操作
      }, { passive: false });
      cb.$('amb-card').addEventListener('click', ev => {
        const b = ev.target.closest('[data-sat],[data-planet],[data-unfocus]');
        if (!b) return;
        if (b.dataset.sat) focusSession(b.dataset.sat);
        else if (b.dataset.planet) setFocus({ kind: 'planet', key: b.dataset.planet, planet: b.dataset.planet });
        else setFocus(null);
      });
      cb.$('amb-call').addEventListener('click', ev => {
        const b = ev.target.closest('[data-sat],[data-dismiss]');
        if (!b) return;
        if (b.dataset.sat) focusSession(b.dataset.sat);
        note = null; renderNote();
      });
      document.addEventListener('visibilitychange', kick);
      window.addEventListener('resize', kick);
      const cs = getComputedStyle(el);
      cb.$('amb-legend').innerHTML = [['call', '承認待ちや停滞'], ['turn', 'あなたの番'], ['work', '作業中'], ['rest', '寝かせている']]
        .map(([k, l]) => `<li><i style="background:${cb.esc(cs.getPropertyValue(STATE_VARS[k]).trim())}"></i>${cb.esc(l)}</li>`).join('');
      // 背景のパノラマは重いので、手が空いたときに先に作っておく
      (window.requestIdleCallback || setTimeout)(() => { nebula ||= makeNebula(); });
    },
    open() {
      nebula ||= makeNebula();
      if (!gl && !glError) initGL();
      const d = CB.getData();
      if (d) build(d);
      open = true; el.hidden = false;
      focus = null; zoom = 1; note = null; cam.dist = 0; cam.t = [0, 0, 0]; cam.ox = cam.oy = 0; dof.k = 0;
      renderCard(); renderNote();
      canvas.style.cursor = 'grab';
      hud(); clearInterval(clockTimer); clockTimer = setInterval(hud, 1000);
      CB.$('ambient-close').focus();
      kick();
    },
    close() {
      if (!open) return;
      open = false; el.hidden = true; clearInterval(clockTimer);
      focus = null; drag = null; note = null; renderCard(); renderNote();
      // 画面いっぱいの描画先は大きいので、閉じたら手放す（次に開いたときに作り直す）
      if (fbo && gl && !gl.isContextLost()) { gl.deleteFramebuffer(fbo.fb); gl.deleteTexture(fbo.color); gl.deleteTexture(fbo.depth); }
      fbo = null;
      CB.$('ambient-open').focus();
    },
    update(d) { if (open) { build(d); renderCard(); hud(); kick(); } },
    // 眺めている最中に呼ばれたら、閉じずに画面の中で知らせる（波紋と浮き上がりは衛星そのものに出る）
    notify(list) {
      if (!open || !list.length) return;
      note = { id: list[0].sessionId, at: Date.now(), more: list.length - 1 };
      renderNote();
    },
  };
  CB.ambient = api;
})();
