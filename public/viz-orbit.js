// 眺めるモード: プロジェクトを惑星、セッションを衛星にした 3D の画面。
// 依存を入れないため、Three.js ではなく Canvas 2D に透視投影を自前でかけて描く。
// 惑星の表面は手続き的に作った模様を球に貼り、太陽ひとつの光で照らす（昼夜の境目・大気・雲・海の照り返し・環）。
// 背景は星雲と天の川の全天パノラマで、カメラの回転と同じ角度で流れる。
// 誰かに呼ばれたら（app.js の detectChanges）自動で閉じて盤面に戻る。
(() => {
  const CB = window.CB = window.CB || { views: {} };
  const TAU = Math.PI * 2;
  let el, canvas, open = false, raf = 0, clockTimer = 0;
  let planets = [], sats = [], stars = [], colors = {}, colorsAt = 0;
  let cam = { yaw: 0, pitch: .36, dist: 0 }, hoverSat = null, lastT = 0, focal = 1, ringR = 0;
  const textures = new Map(); // プロジェクト → 表面の模様（作るのに時間がかかるので覚えておく）
  let nebula = null;

  const hash = (s, k = 0) => { let h = 2166136261 ^ k; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0) / 4294967296; };
  const short = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
  const rootOf = cwd => (cwd || '').replace(/\/\.claude\/worktrees\/[^/]+.*$/, '');
  const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
  const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
  const rgb = hex => { const n = parseInt(hex.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  function ramp(stops, t) { // stops: [[位置, [r,g,b]], ...]
    t = clamp(t);
    for (let i = 1; i < stops.length; i++) if (t <= stops[i][0]) return mix(stops[i - 1][1], stops[i][1], (t - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0] || 1));
    return stops.at(-1)[1];
  }
  function rng(seed) { let a = (seed * 4294967296) >>> 0 || 1; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  // ---------- 値ノイズと fBm ----------
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

  // ---------- 惑星の表面（正距円筒の模様） ----------
  const TW = 320, TH = 160;
  const TYPES = ['gas', 'terran', 'ice', 'rock'];
  const GAS_PALETTES = [
    [[0, '#7a4a2e'], [.25, '#c9935e'], [.45, '#ead3ae'], [.6, '#b37a4b'], [.8, '#e3c9a0'], [1, '#8a5634']],
    [[0, '#2f4a73'], [.3, '#7f9fc4'], [.5, '#d5e2ee'], [.7, '#5b7ba3'], [1, '#a9bfd8']],
    [[0, '#4d5a3b'], [.3, '#a9a46a'], [.55, '#e2dcb4'], [.75, '#8c8550'], [1, '#c8c08a']],
  ].map(s => s.map(([t, c]) => [t, rgb(c)]));
  const ATM = { gas: rgb('#e8c79a'), terran: rgb('#6fa8ff'), ice: rgb('#bfe8ff'), rock: rgb('#d9a77a') };
  const ATM_STRENGTH = { gas: .45, terran: .9, ice: .55, rock: .18 };

  function makeTexture(type, seed) {
    const fbm = makeNoise(seed), fbm2 = makeNoise(seed + .37);
    const col = new Uint8ClampedArray(TW * TH * 3), cloud = new Uint8Array(TW * TH), spec = new Uint8Array(TW * TH);
    const r = rng(seed + .11);
    const pal = GAS_PALETTES[Math.floor(r() * GAS_PALETTES.length)];
    const craters = type === 'rock' ? Array.from({ length: 46 }, () => {
      const u = r() * 2 - 1, a = r() * TAU, s = Math.sqrt(1 - u * u);
      return { x: s * Math.cos(a), y: u, z: s * Math.sin(a), cr: Math.cos(.03 + Math.pow(r(), 3) * .22) };
    }) : [];
    const storm = { lon: r() * TAU, lat: (r() - .5) * .8 };
    for (let j = 0; j < TH; j++) {
      const lat = (j / (TH - 1) - .5) * Math.PI, cy = Math.sin(lat), cl = Math.cos(lat);
      for (let i = 0; i < TW; i++) {
        const lon = i / TW * TAU;
        const x = cl * Math.cos(lon), z = cl * Math.sin(lon), y = cy;
        const k = j * TW + i;
        let c;
        if (type === 'gas') {
          // 緯度に沿った縞を乱流でゆがめ、大きな渦をひとつ置く
          const warp = fbm(x * 2.2, y * 2.2, z * 2.2, 5) - .5;
          let v = cy * 5.5 + warp * 1.4 + (fbm2(x * 7, y * 14, z * 7, 3) - .5) * .35;
          const dl = Math.atan2(Math.sin(lon - storm.lon), Math.cos(lon - storm.lon)), dy = lat - storm.lat;
          const sd = Math.hypot(dl * .55, dy * 1.6);
          if (sd < .18) v += Math.sin(Math.atan2(dy, dl) * 2 + sd * 30) * (1 - sd / .18) * .6;
          c = ramp(pal, (Math.sin(v * Math.PI) + 1) / 2);
          if (sd < .12) c = mix(c, rgb('#b5532e'), (1 - sd / .12) * .55);
        } else if (type === 'terran') {
          const h = fbm(x * 1.8 + 3, y * 1.8, z * 1.8, 6);
          const moist = fbm2(x * 2.5, y * 2.5, z * 2.5, 4);
          const sea = .52;
          if (h < sea) { c = mix(rgb('#06213f'), rgb('#1d5c88'), smooth(sea - .18, sea, h)); spec[k] = 255; }
          else {
            const e = (h - sea) / (1 - sea);
            c = moist < .45 ? mix(rgb('#b89a62'), rgb('#8d6f45'), e * 2) : mix(rgb('#2f5e2c'), rgb('#6d7044'), e * 2.2);
            if (e > .42) c = mix(c, rgb('#eef2f4'), smooth(.42, .6, e));
          }
          const cap = Math.abs(cy) + (fbm2(x * 4, y * 4, z * 4, 3) - .5) * .25;
          if (cap > .82) { c = mix(c, rgb('#eef4f8'), smooth(.82, .88, cap)); spec[k] = 0; }
          const cv = fbm2(x * 3 + 9, y * 5, z * 3, 5);
          cloud[k] = smooth(.5, .72, cv) * 235;
        } else if (type === 'ice') {
          const n = fbm(x * 2, y * 2, z * 2, 5);
          const ridge = 1 - Math.abs(fbm2(x * 6, y * 6, z * 6, 4) * 2 - 1);
          c = mix(rgb('#9cc3d8'), rgb('#eaf4f8'), n);
          c = mix(c, rgb('#5f8fae'), Math.pow(ridge, 10) * .7);
        } else {
          const n = fbm(x * 2.4, y * 2.4, z * 2.4, 6);
          c = mix(rgb('#4f463f'), rgb('#a89276'), smooth(.3, .75, n));
          c = mix(c, rgb('#7a6a5a'), fbm2(x * 9, y * 9, z * 9, 3) * .4);
          for (const cr of craters) {
            const d = x * cr.x + y * cr.y + z * cr.z;
            if (d < cr.cr) continue;
            const t = (1 - d) / (1 - cr.cr); // 中心 0 → ふち 1
            c = mix(c, t > .82 ? rgb('#c4b196') : rgb('#3a332d'), t > .82 ? .5 : (1 - t) * .55);
          }
        }
        col[k * 3] = c[0]; col[k * 3 + 1] = c[1]; col[k * 3 + 2] = c[2];
      }
    }
    return { col, cloud, spec, hasCloud: type === 'terran' };
  }

  // ---------- 星雲と天の川（全天パノラマ） ----------
  const NW = 640, NH = 220, N_ELEV = 1.1; // 仰角 ±1.1 rad を描く
  const bandY = th => .32 * Math.sin(th + 1.3) - .12;
  function makeNebula() {
    const fbm = makeNoise(.4242), fbm2 = makeNoise(.9191);
    const cv = document.createElement('canvas'); cv.width = NW; cv.height = NH;
    const g = cv.getContext('2d'), img = g.createImageData(NW, NH), d = img.data;
    const deep = rgb('#03060c'), indigo = rgb('#1c2850'), violet = rgb('#3b2350'), teal = rgb('#12363f'), milk = rgb('#d9d2c4');
    for (let j = 0; j < NH; j++) {
      const e = (j / (NH - 1) - .5) * 2 * N_ELEV;
      for (let i = 0; i < NW; i++) {
        const th = i / NW * TAU, x = Math.cos(th), z = Math.sin(th);
        const n = fbm(x * 1.6, e * 1.6, z * 1.6, 6), m = fbm2(x * 2.4 + 5, e * 2.4, z * 2.4, 5);
        const band = Math.exp(-Math.pow(e - bandY(th), 2) / .028);
        let c = deep;
        c = mix(c, m > .5 ? violet : teal, smooth(.42, .78, n) * .55);
        c = mix(c, indigo, smooth(.5, .85, m) * .35);
        c = mix(c, milk, band * (.12 + .3 * smooth(.35, .8, n)));
        c = mix(c, deep, band * smooth(.52, .7, m) * .75); // 天の川の暗い塵の筋
        c = mix(c, deep, smooth(.78, 1, Math.abs(e) / N_ELEV)); // 上下の端は宇宙の地の色に溶かす（縦長の画面で継ぎ目を見せない）
        const k = (j * NW + i) * 4;
        d[k] = c[0]; d[k + 1] = c[1]; d[k + 2] = c[2]; d[k + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return cv;
  }
  function makeStars() {
    const r = rng(.777), temps = ['#9bb0ff', '#cad7ff', '#f4f3ff', '#f4f3ff', '#fff4ea', '#ffd9b0', '#ffc27a'];
    const out = [];
    for (let i = 0; i < 1100; i++) {
      const th = r() * TAU;
      // 4割は天の川に沿って集める
      const e = r() < .4 ? bandY(th) + (r() + r() + r() - 1.5) * .16 : (r() * 2 - 1) * N_ELEV;
      out.push({ th, e, m: Math.pow(r(), 4), c: temps[Math.floor(r() * temps.length)], ph: r() * TAU });
    }
    return out;
  }

  // ---------- 世界の組み立て ----------
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
      return {
        ...g, type, r, ring,
        x: Math.cos(a) * ringR, y: (hash(g.key) - .5) * 70, z: Math.sin(a) * ringR,
        tilt: (hash(g.key, 9) - .5) * .7, spinRate: .05 + hash(g.key, 10) * .07,
        spin: prev?.spin ?? hash(g.key, 11) * TAU, sprite: prev?.sprite || null,
      };
    });
    const oldSats = new Map(sats.map(s => [s.id, s]));
    sats = [];
    for (const p of planets) {
      p.sessions.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
      const base = (p.ring ? p.r * 2.05 : p.r * 1.45) + 22;
      p.sessions.forEach((s, i) => {
        const prev = oldSats.get(s.sessionId);
        sats.push({
          id: s.sessionId, s, planet: p, r: base + i * 24,
          inc: (hash(s.sessionId, 1) - .5) * 1.1, node: hash(s.sessionId, 2) * TAU,
          theta: prev ? prev.theta : hash(s.sessionId, 3) * TAU,
        });
      });
    }
    if (!stars.length) stars = makeStars();
  }
  // 表面の模様は、1フレームに1つずつ作る（開いた瞬間に固まらないように）
  function bakeOne() {
    for (const p of planets) {
      if (textures.has(p.key)) continue;
      textures.set(p.key, makeTexture(p.type, hash(p.key, 12)));
      return;
    }
  }

  // ---------- 座標 ----------
  // 光はカメラから見て左上の手前から当てる（カメラが回っても惑星がいつも4分の3ほど照らされて見える）。
  // SUN は世界座標での光の向きで、毎フレーム draw() で更新する
  const LIGHT_CAM = (() => { const v = [-.62, -.42, -.66], n = Math.hypot(...v); return v.map(x => x / n); })();
  let SUN = LIGHT_CAM;
  function toCam(x, y, z) {
    const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    const x1 = x * cy - z * sy, z1 = x * sy + z * cy;
    return [x1, y * cp - z1 * sp, y * sp + z1 * cp];
  }
  function fromCam(x, y, z) {
    const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    const y1 = y * cp + z * sp, z1 = -y * sp + z * cp;
    return [x * cy + z1 * sy, y1, -x * sy + z1 * cy];
  }
  function project(pt, w, h) {
    const [x, y, z] = toCam(pt.x, pt.y, pt.z);
    const d = z + cam.dist;
    if (d < 40) return null;
    const k = focal / d;
    return { x: w / 2 + x * k, y: h * .55 + y * k, k, z: d };
  }
  function satPos(sat, theta) {
    const p = sat.planet;
    let x = Math.cos(theta) * sat.r, y = 0, z = Math.sin(theta) * sat.r;
    const ci = Math.cos(sat.inc), si = Math.sin(sat.inc);
    [y, z] = [y * ci - z * si, y * si + z * ci];
    const cn = Math.cos(sat.node), sn = Math.sin(sat.node);
    [x, z] = [x * cn + z * sn, -x * sn + z * cn];
    return { x: p.x + x, y: p.y + y, z: p.z + z };
  }
  // 惑星の赤道面（傾き付き）の点
  function ringPoint(p, rad, a) {
    let x = Math.cos(a) * rad, y = 0, z = Math.sin(a) * rad;
    const ct = Math.cos(p.tilt), st = Math.sin(p.tilt);
    [x, y] = [x * ct - y * st, x * st + y * ct];
    return { x: p.x + x, y: p.y + y, z: p.z + z };
  }

  // ---------- 惑星を1枚の絵に焼く ----------
  function renderPlanet(p, rPx) {
    const tex = textures.get(p.key);
    const size = Math.ceil(rPx * 2) + 2, c0 = size / 2;
    let sp = p.sprite;
    // 回転やカメラの動きが半画素に満たなければ前の絵を使う
    if (sp && sp.size === size && sp.tex === tex && Math.abs(sp.spin - p.spin) * rPx < .5 && Math.abs(sp.yaw - cam.yaw) * rPx < .5) return sp.cv;
    if (!sp || sp.size !== size) {
      const cv = document.createElement('canvas'); cv.width = cv.height = size;
      sp = p.sprite = { cv, g: cv.getContext('2d'), img: null, size };
      sp.img = sp.g.createImageData(size, size);
    }
    sp.spin = p.spin; sp.yaw = cam.yaw; sp.tex = tex;
    const d = sp.img.data;
    const atm = ATM[p.type], atmK = ATM_STRENGTH[p.type];
    const ct = Math.cos(-p.tilt), st = Math.sin(-p.tilt), cs = Math.cos(-p.spin), ss = Math.sin(-p.spin);
    const cloudShift = Math.floor(((p.spin * .18) % TAU) / TAU * TW);
    const V = fromCam(0, 0, -1); // 見ている向き（世界座標、惑星からカメラへ）
    const H = (() => { const v = [SUN[0] + V[0], SUN[1] + V[1], SUN[2] + V[2]], n = Math.hypot(...v); return v.map(x => x / n); })();
    const flat = rgb(p.type === 'gas' ? '#b88a5c' : p.type === 'terran' ? '#2a5a7a' : p.type === 'ice' ? '#bcd6e3' : '#7d6d5d');
    for (let y = 0; y < size; y++) {
      const ny = (y + .5 - c0) / rPx;
      for (let x = 0; x < size; x++) {
        const nx = (x + .5 - c0) / rPx, d2 = nx * nx + ny * ny, k = (y * size + x) * 4;
        if (d2 >= 1) { d[k + 3] = 0; continue; }
        const nz = Math.sqrt(1 - d2);
        const [wx, wy, wz] = fromCam(nx, ny, -nz); // 表面の向き（世界座標）
        const lambert = wx * SUN[0] + wy * SUN[1] + wz * SUN[2];
        const light = .035 + .965 * smooth(-.12, .55, lambert) * clamp(lambert * .6 + .55);
        let c;
        if (tex) {
          // 世界 → 惑星の地軸に合わせた向き（傾きを戻してから自転を戻す）
          const lx = wx * ct - wy * st, ly = wx * st + wy * ct;
          const ux = lx * cs - wz * ss, uz = lx * ss + wz * cs;
          let u = Math.atan2(uz, ux) / TAU; if (u < 0) u += 1;
          const v = Math.asin(clamp(ly, -1, 1)) / Math.PI + .5;
          const ti = Math.min(TW - 1, (u * TW) | 0), tj = Math.min(TH - 1, (v * TH) | 0), tk = tj * TW + ti;
          c = [tex.col[tk * 3], tex.col[tk * 3 + 1], tex.col[tk * 3 + 2]];
          c = [c[0] * light, c[1] * light, c[2] * light];
          if (tex.spec[tk]) { // 海の照り返し
            const hs = Math.max(0, wx * H[0] + wy * H[1] + wz * H[2]);
            const s = Math.pow(hs, 60) * 180 * smooth(0, .2, lambert);
            c = [c[0] + s, c[1] + s * .95, c[2] + s * .85];
          }
          if (tex.hasCloud) {
            const ca = tex.cloud[tj * TW + ((ti + cloudShift) % TW)] / 255;
            const cl = 245 * light;
            c = [c[0] + (cl - c[0]) * ca, c[1] + (cl - c[1]) * ca, c[2] + (cl - c[2]) * ca];
          }
        } else {
          c = [flat[0] * light, flat[1] * light, flat[2] * light];
        }
        if (p.type === 'gas') { const ld = .6 + .4 * Math.sqrt(nz); c = [c[0] * ld, c[1] * ld, c[2] * ld]; } // 周辺減光
        // 大気: ふちほど濃く、昼側で明るい
        const rim = Math.pow(1 - nz, 2.6) * atmK * clamp(lambert * .9 + .35);
        c = [c[0] + atm[0] * rim, c[1] + atm[1] * rim, c[2] + atm[2] * rim];
        d[k] = c[0]; d[k + 1] = c[1]; d[k + 2] = c[2];
        d[k + 3] = d2 > 1 - 2 / rPx ? 255 * clamp((1 - Math.sqrt(d2)) * rPx) : 255; // ふちのなめらかさ
      }
    }
    sp.g.putImageData(sp.img, 0, 0);
    return sp.cv;
  }

  // ---------- 描画 ----------
  const STATE_VARS = { call: '--beacon-call', turn: '--beacon-turn', work: '--beacon-work', rest: '--beacon-rest' };
  function readColors() {
    if (Date.now() - colorsAt < 1000) return colors;
    const cs = getComputedStyle(el), v = n => cs.getPropertyValue(n).trim();
    colors = { ink: v('--hud'), ink2: v('--hud-2'), ink3: v('--hud-3') };
    for (const [k, n] of Object.entries(STATE_VARS)) colors[k] = v(n);
    colorsAt = Date.now();
    return colors;
  }
  const laneOf = s => CB.laneOf(s);
  const called = s => laneOf(s) === 'you' && s.state.key !== 'yours';
  function satColor(c, s) {
    const lane = laneOf(s);
    if (lane === 'you') return s.state.key === 'yours' ? c.turn : c.call;
    return lane === 'work' ? c.work : c.rest;
  }
  // 1秒あたりの公転角。作業中は速く回り、呼んでいるものはほぼ止まって待つ
  function speed(s) {
    const lane = laneOf(s);
    if (lane === 'work') return .5;
    if (lane === 'you') return s.state.key === 'yours' ? .1 : .025;
    return .04;
  }

  function drawSky(g, w, h, t) {
    g.fillStyle = '#03060c'; g.fillRect(0, 0, w, h);
    // 角度1ラジアン = focal 画素。カメラが回った分だけ空も流れる
    const hy = h * .55 - Math.tan(cam.pitch) * focal; // 地平の高さ
    if (nebula) {
      const pw = TAU * focal, ph = 2 * N_ELEV * focal;
      let ox = -((cam.yaw / TAU) % 1) * pw; if (ox > 0) ox -= pw;
      g.globalAlpha = 1; g.imageSmoothingEnabled = true;
      for (let x = ox; x < w; x += pw) g.drawImage(nebula, x, hy - ph / 2, pw, ph);
    }
    for (const s of stars) {
      let sx = ((s.th - cam.yaw) % TAU + TAU) % TAU * focal;
      if (sx > w + 4) continue;
      const sy = hy + s.e * focal;
      if (sy < -4 || sy > h + 4) continue;
      const tw = s.m > .3 ? .85 + .15 * Math.sin(t / 900 + s.ph) : 1;
      g.globalAlpha = (.25 + .75 * s.m) * tw;
      g.fillStyle = s.c;
      const r = .45 + s.m * 1.4;
      g.beginPath(); g.arc(sx, sy, r, 0, TAU); g.fill();
      if (s.m > .55) { // 明るい星には淡い光芒
        g.globalAlpha = .18 * s.m * tw;
        g.fillRect(sx - r * 5, sy - .4, r * 10, .8); g.fillRect(sx - .4, sy - r * 5, .8, r * 10);
      }
    }
    g.globalAlpha = 1;
  }
  // 画面の外（左上）にある恒星の光が、うっすら差し込んでいるように見せる
  function drawLightLeak(g, w, h) {
    const x = -w * .08, y = -h * .12;
    g.globalCompositeOperation = 'lighter';
    for (const [r, a, col] of [[Math.max(w, h) * .75, .07, '255,196,140'], [Math.max(w, h) * .32, .06, '255,226,190']]) {
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, `rgba(${col},${a})`); gr.addColorStop(1, `rgba(${col},0)`);
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
    }
    g.globalCompositeOperation = 'source-over';
  }
  // 輪を奥半分と手前半分に分けて描く。境目で途切れないよう、隣の点を1つ重ねる
  function strokeHalf(g, pts, cz, front) {
    const side = pts.map(s => s && (s.z < cz) === front);
    g.beginPath();
    let pen = false;
    for (let i = 0; i < pts.length; i++) {
      const on = side[i] || side[i - 1] || side[i + 1];
      if (!pts[i] || !on) { pen = false; continue; }
      pen ? g.lineTo(pts[i].x, pts[i].y) : g.moveTo(pts[i].x, pts[i].y); pen = true;
    }
    g.stroke();
  }
  // 惑星の環（奥半分と手前半分に分け、惑星の前後に描く）
  function drawRing(g, p, q, w, h, front) {
    const bands = 7;
    for (let b = 0; b < bands; b++) {
      const rad = p.r * (1.32 + b * .1), a = .1 + .32 * Math.abs(Math.sin(b * 2.3 + p.r));
      g.strokeStyle = `rgba(222,205,175,${a})`;
      g.lineWidth = Math.max(.6, p.r * .085 * q.k);
      strokeHalf(g, Array.from({ length: 97 }, (_, i) => project(ringPoint(p, rad, i / 96 * TAU), w, h)), q.z, front);
    }
  }
  function drawOrbit(g, sat, q, w, h, front, c) {
    g.strokeStyle = called(sat.s) ? c.call : c.ink2;
    g.globalAlpha = called(sat.s) ? .5 : front ? .22 : .1;
    g.lineWidth = 1;
    strokeHalf(g, Array.from({ length: 97 }, (_, i) => project(satPos(sat, i / 96 * TAU), w, h)), q.z, front);
    g.globalAlpha = 1;
  }

  function draw(t) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    focal = Math.min(w, h) * 1.2;
    // 惑星の並ぶ輪が画面の幅と高さに収まる距離までカメラを引く（変わるときはなめらかに）
    const outer = ringR + 120;
    const want = Math.max(600, ringR * 1.45 + 420, outer * focal / (w * .4) + outer * .5, outer * focal * Math.sin(cam.pitch) / (h * .3) + outer);
    cam.dist = cam.dist ? cam.dist + (want - cam.dist) * .08 : want;
    SUN = fromCam(...LIGHT_CAM);
    const g = canvas.getContext('2d');
    const c = readColors();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawSky(g, w, h, t);
    drawLightLeak(g, w, h);

    if (!planets.length) {
      g.fillStyle = c.ink2; g.font = '16px "IBM Plex Sans JP", sans-serif'; g.textAlign = 'center';
      g.fillText('稼働中のセッションはありません', w / 2, h / 2);
      return;
    }

    // 奥から順に描く
    const items = [];
    for (const p of planets) { const q = project(p, w, h); if (q) { p.q = q; items.push({ z: q.z, kind: 'planet', p, q }); } }
    for (const sat of sats) { const q = project(satPos(sat, sat.theta), w, h); if (q) { sat.q = q; items.push({ z: q.z, kind: 'sat', sat, q }); } }
    items.sort((a, b) => b.z - a.z);
    const sunCam = toCam(...SUN);
    const sunDir = (() => { const n = Math.hypot(sunCam[0], sunCam[1]) || 1; return [sunCam[0] / n, sunCam[1] / n]; })();

    for (const it of items) {
      if (it.kind === 'planet') {
        const { p, q } = it, r = p.r * q.k;
        for (const sat of sats) if (sat.planet === p && sat.q) drawOrbit(g, sat, p.q, w, h, false, c);
        if (p.ring) drawRing(g, p, q, w, h, false);
        // 大気の外側の光（太陽の側に少し寄せる）
        const atm = ATM[p.type], ak = ATM_STRENGTH[p.type];
        const gx = q.x + sunDir[0] * r * .12, gy = q.y + sunDir[1] * r * .12;
        const glow = g.createRadialGradient(gx, gy, r * .9, gx, gy, r * 1.35);
        glow.addColorStop(0, `rgba(${atm.join(',')},${.28 * ak})`); glow.addColorStop(1, `rgba(${atm.join(',')},0)`);
        g.fillStyle = glow; g.beginPath(); g.arc(gx, gy, r * 1.35, 0, TAU); g.fill();
        const sprite = renderPlanet(p, r * dpr);
        g.drawImage(sprite, q.x - sprite.width / dpr / 2, q.y - sprite.height / dpr / 2, sprite.width / dpr, sprite.height / dpr);
        if (p.ring) drawRing(g, p, q, w, h, true);
        for (const sat of sats) if (sat.planet === p && sat.q) drawOrbit(g, sat, p.q, w, h, true, c);
        if (p.sessions.some(called)) { g.strokeStyle = c.call; g.globalAlpha = .7; g.lineWidth = 1.5; g.beginPath(); g.arc(q.x, q.y, r + 6, 0, TAU); g.stroke(); g.globalAlpha = 1; }
        g.fillStyle = c.ink; g.font = `600 ${Math.round(Math.max(12, 13 * q.k * 1.3))}px "IBM Plex Sans JP", sans-serif`; g.textAlign = 'center'; g.textBaseline = 'top';
        g.shadowColor = 'rgba(0,0,0,.8)'; g.shadowBlur = 6;
        g.fillText(short(p.name, 26), q.x, q.y + r * (p.ring ? 1.25 : 1) + 10);
        g.shadowBlur = 0;
        continue;
      }
      // 衛星は状態の色で光る灯り
      const { sat, q } = it, s = sat.s, col = satColor(c, s), lane = laneOf(s);
      const r = Math.max(1.8, (lane === 'you' ? 4.2 : lane === 'work' ? 3.4 : 2.4) * q.k * 1.4);
      g.globalCompositeOperation = 'lighter';
      if (lane === 'work') { // 尾を引く
        for (let i = 1; i <= 16; i++) {
          const tq = project(satPos(sat, sat.theta - i * .03), w, h);
          if (!tq) continue;
          g.globalAlpha = (1 - i / 17) * .35; g.fillStyle = col;
          g.beginPath(); g.arc(tq.x, tq.y, r * (1 - i / 20), 0, TAU); g.fill();
        }
      }
      const glow = g.createRadialGradient(q.x, q.y, 0, q.x, q.y, r * 5);
      glow.addColorStop(0, col); glow.addColorStop(1, 'rgba(0,0,0,0)');
      g.globalAlpha = lane === 'rest' ? .2 : .55; g.fillStyle = glow;
      g.beginPath(); g.arc(q.x, q.y, r * 5, 0, TAU); g.fill();
      g.globalAlpha = 1; g.fillStyle = col; g.beginPath(); g.arc(q.x, q.y, r, 0, TAU); g.fill();
      g.fillStyle = 'rgba(255,255,255,.85)'; g.beginPath(); g.arc(q.x, q.y, r * .45, 0, TAU); g.fill();
      g.globalCompositeOperation = 'source-over';
      if (lane === 'you') { // 呼んでいる衛星は波紋を出す
        const ph = (t / (called(s) ? 1100 : 2400)) % 1;
        g.strokeStyle = col; g.lineWidth = 1.5; g.globalAlpha = (1 - ph) * .9;
        g.beginPath(); g.arc(q.x, q.y, r + 3 + ph * 24, 0, TAU); g.stroke(); g.globalAlpha = 1;
      }
      if (lane === 'you' || hoverSat === sat) {
        // 惑星より左にいるときは名前を左側に出し、同じ惑星の衛星どうしで重なりにくくする
        const left = sat.planet.q && q.x < sat.planet.q.x;
        const lx = left ? q.x - r - 12 : q.x + r + 12;
        const e = CB.elapsed(Date.now() - CB.since(s));
        g.shadowColor = 'rgba(0,0,0,.85)'; g.shadowBlur = 6;
        g.font = `600 ${lane === 'you' ? 14 : 12}px "IBM Plex Sans JP", sans-serif`; g.textAlign = left ? 'right' : 'left'; g.textBaseline = 'middle';
        g.fillStyle = c.ink; g.fillText(short(s.name, 26), lx, q.y - 7);
        g.fillStyle = col; g.font = '500 12px "IBM Plex Sans JP", sans-serif'; g.fillText(`${s.state.label}　${e.n}${e.u}`, lx, q.y + 10);
        g.shadowBlur = 0;
      }
    }
  }

  function frame(t) {
    raf = 0;
    if (!open || document.hidden) return;
    const dt = Math.min(.1, lastT ? (t - lastT) / 1000 : 0);
    lastT = t;
    cam.yaw += dt * .03;
    for (const sat of sats) sat.theta += dt * speed(sat.s);
    for (const p of planets) p.spin += dt * p.spinRate;
    bakeOne();
    draw(t);
    raf = requestAnimationFrame(frame);
  }
  function kick() {
    if (!open) return;
    if (CB.reduceMotion.matches) {
      // 動きを減らす設定では、模様を全部作ってから1枚だけ描く
      while (planets.some(p => !textures.has(p.key))) bakeOne();
      draw(0); return;
    }
    bakeOne(); draw(performance.now()); // 次のフレームを待たずに1枚描いておく
    if (!raf) { lastT = 0; raf = requestAnimationFrame(frame); }
  }

  function hud() {
    CB.$('amb-clock').textContent = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    const v = CB.$('verdict'), av = CB.$('amb-verdict');
    av.textContent = v.textContent; av.dataset.tone = v.dataset.tone || 'calm';
    if (CB.reduceMotion.matches) draw(0);
  }

  function pickSat(ev) {
    const r = canvas.getBoundingClientRect();
    const mx = ev.clientX - r.left, my = ev.clientY - r.top;
    let best = null, bd = 22;
    for (const sat of sats) { if (!sat.q) continue; const d = Math.hypot(sat.q.x - mx, sat.q.y - my); if (d < bd) { bd = d; best = sat; } }
    return best;
  }

  const api = {
    init(cb) {
      el = cb.$('ambient'); canvas = cb.$('ambient-canvas');
      cb.$('ambient-open').onclick = () => api.open();
      cb.$('ambient-close').onclick = () => api.close();
      document.addEventListener('keydown', e => { if (open && e.key === 'Escape') api.close(); });
      canvas.addEventListener('mousemove', ev => { hoverSat = pickSat(ev); canvas.style.cursor = hoverSat ? 'pointer' : 'default'; if (CB.reduceMotion.matches) draw(0); });
      canvas.addEventListener('click', ev => { const s = pickSat(ev); if (s) { api.close(); cb.openDetail(s.id); } });
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
      const d = CB.getData();
      if (d) build(d);
      open = true; el.hidden = false;
      hud(); clearInterval(clockTimer); clockTimer = setInterval(hud, 1000);
      CB.$('ambient-close').focus();
      kick();
    },
    close() {
      if (!open) return;
      open = false; el.hidden = true; clearInterval(clockTimer);
      CB.$('ambient-open').focus();
    },
    update(d) { if (open) { build(d); hud(); kick(); } },
  };
  CB.ambient = api;
})();
