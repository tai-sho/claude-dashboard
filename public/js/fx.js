// 盤面の上に重ねる演出: 伝票の移動、新しく来た伝票の登場、ちぎれて落ちる伝票、伝票刺しへ飛ぶ伝票、紙吹雪。
// 盤面は描くたびに DOM を作り直すので、描く前に位置を覚えておき（snapshot）、描いた後にその差を埋めるように動かす（flip）。
// 消える伝票は、描き直す前に複製を重ねの層に置いて動かす。
import { reduceMotion, cssVar } from './dom.js';
import { hash } from './planet.js';

const TAU = Math.PI * 2;
let layer = null;
// 登場の動きの途中で描き直されたら、続きから動かす（id → { kf, opt, start }）
const entering = new Map();

export const motionOK = () => !reduceMotion.matches && !document.hidden;

function fxLayer() {
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'fx-layer';
    layer.setAttribute('aria-hidden', 'true');
    document.body.append(layer);
  }
  return layer;
}

// 伝票と行（data-id を持つもの）の今の位置
export function snapshot(root) {
  const out = new Map();
  for (const el of root.querySelectorAll('[data-id]')) {
    const r = el.getBoundingClientRect();
    if (r.width) out.set(el.dataset.id, { el, r });
  }
  return out;
}

// 元の要素は描き直しで消えるので、見た目だけの複製を同じ位置に置く
function ghost(el, r) {
  const g = el.cloneNode(true);
  g.removeAttribute('data-id');
  g.classList.remove('fresh', 'zap');
  for (const x of g.querySelectorAll('[id]')) x.removeAttribute('id');
  g.classList.add('ghost');
  g.inert = true;
  Object.assign(g.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  fxLayer().append(g);
  return g;
}
const drop = (g, anim) => { anim.finished.then(() => g.remove(), () => g.remove()); };

// 描き直した後、前の位置から今の位置へ滑らせる。新しく来たものは登場させる
// called: 今回呼ばれた伝票（揺れながら止まる）、skip: 動かさないもの、enter: 新しいものを登場させるか（初回の描画では出さない）
export function flip(root, before, { called = new Set(), skip = new Set(), enter = true } = {}) {
  if (!motionOK()) return;
  const now = performance.now();
  for (const el of root.querySelectorAll('[data-id]')) {
    const id = el.dataset.id;
    if (skip.has(id)) continue;
    const run = entering.get(id);
    if (run) {
      if (now - run.start < run.opt.duration) { el.animate(run.kf, run.opt).currentTime = now - run.start; continue; }
      entering.delete(id);
    }
    const b = before.get(id);
    const r = el.getBoundingClientRect();
    if (!r.width) continue;
    if (!b) {
      if (!enter) continue;
      const kf = called.has(id)
        // 上から吊られて落ちてきて、少し揺れて止まる
        ? [{ transform: 'translateY(-56px) rotate(-5deg)', opacity: 0 }, { transform: 'translateY(6px) rotate(2.5deg)', opacity: 1, offset: .45 },
          { transform: 'translateY(-2px) rotate(-1.2deg)', offset: .72 }, { transform: 'none' }]
        : [{ transform: 'translateY(12px) scale(.98)', opacity: 0 }, { transform: 'none', opacity: 1 }];
      const opt = { duration: called.has(id) ? 950 : 460, easing: 'cubic-bezier(.2,.8,.25,1)' };
      entering.set(id, { kf, opt, start: now });
      el.animate(kf, opt);
      continue;
    }
    const dx = b.r.left - r.left, dy = b.r.top - r.top;
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) {
      // 同じ場所で呼ばれた: ピンを支点に揺れる
      if (called.has(id)) el.animate([{ transform: 'none' }, { transform: 'rotate(3deg)', offset: .25 }, { transform: 'rotate(-2deg)', offset: .55 }, { transform: 'rotate(.8deg)', offset: .8 }, { transform: 'none' }], { duration: 900, easing: 'ease-out' });
      continue;
    }
    const from = { transform: `translate(${dx}px, ${dy}px)` };
    if (called.has(id)) {
      // 別の列から呼ばれて移ってきた: 滑ってきて、着いたところで揺れる
      el.animate([from, { transform: 'rotate(2.4deg)', offset: .62 }, { transform: 'rotate(-1.4deg)', offset: .8 }, { transform: 'none' }],
        { duration: 980, easing: 'cubic-bezier(.3,.7,.3,1)' });
    } else {
      el.animate([from, { transform: 'none' }], { duration: 560, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
  }
  for (const [id, run] of entering) if (now - run.start > run.opt.duration) entering.delete(id);
}

// 終わったセッションの伝票: 切り取り線でちぎれ、下の部分が落ちていく
export function tearOff(el, r) {
  if (!motionOK()) return;
  const cut = Math.min(34, r.height * .24);
  const teeth = Math.max(8, Math.round(r.width / 12));
  const edge = Array.from({ length: teeth + 1 }, (_, i) => `${(i / teeth * 100).toFixed(2)}% ${(cut + (i % 2 ? 3 : -3)).toFixed(1)}px`);
  const dir = hash(el.dataset.id || '', 5) > .5 ? 1 : -1;
  const stub = ghost(el, r), body = ghost(el, r);
  stub.style.clipPath = `polygon(0 0, 100% 0, ${[...edge].reverse().join(', ')})`;
  body.style.clipPath = `polygon(${edge.join(', ')}, 100% 100%, 0 100%)`;
  drop(stub, stub.animate([{ opacity: 1 }, { opacity: 1, offset: .55 }, { opacity: 0, transform: 'translateY(-4px)' }], { duration: 1100, easing: 'ease-out' }));
  const fall = Math.max(220, innerHeight - r.top + 40);
  drop(body, body.animate([
    { transform: 'none', opacity: 1 },
    { transform: `translate(${dir * 5}px, 8px) rotate(${dir * 2.5}deg)`, opacity: 1, offset: .22 },
    { transform: `translate(${dir * 46}px, ${fall}px) rotate(${dir * 16}deg)`, opacity: 0 },
  ], { duration: 1300, easing: 'cubic-bezier(.45,0,.8,.35)' }));
}

// 終わったセッションの行: 横へ抜けて消える
export function fadeOut(el, r) {
  if (!motionOK()) return;
  const g = ghost(el, r);
  drop(g, g.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateX(32px)' }], { duration: 520, easing: 'ease-in' }));
}

// 「確認した」: 伝票を丸めて伝票刺しまで放る。着いたら done を呼ぶ
export function crumpleTo(el, target, done) {
  const r = el.getBoundingClientRect(), t = target.getBoundingClientRect();
  if (!motionOK() || !r.width || !t.width) { done(); return; }
  const g = ghost(el, r);
  g.classList.add('crumple');
  const dx = t.left + t.width / 2 - (r.left + r.width / 2), dy = t.top + t.height * .3 - (r.top + r.height / 2);
  const s = 16 / r.width;
  const anim = g.animate([
    { transform: 'none', borderRadius: '4px', filter: 'none' },
    { transform: 'scale(.5, .42) rotate(-10deg)', borderRadius: '38%', filter: 'contrast(.85) brightness(.97)', offset: .28 },
    { transform: `translate(${dx * .7}px, ${dy - 90}px) scale(${s * 2.2}) rotate(220deg)`, borderRadius: '50%', offset: .7 },
    { transform: `translate(${dx}px, ${dy}px) scale(${s}) rotate(340deg)`, borderRadius: '50%', opacity: .9 },
  ], { duration: 860, easing: 'cubic-bezier(.45,.05,.35,1)' });
  drop(g, anim);
  anim.finished.then(done, done);
}

// 紙吹雪（Canvas）。画面が隠れたら止めて消す
export function confetti() {
  if (!motionOK()) return;
  const c = document.createElement('canvas');
  c.className = 'confetti';
  fxLayer().append(c);
  const dpr = Math.min(2, devicePixelRatio || 1), W = innerWidth, H = innerHeight;
  c.width = W * dpr; c.height = H * dpr;
  const g = c.getContext('2d');
  g.scale(dpr, dpr);
  const colors = ['--call', '--turn', '--work', '--ok', '--mark'].map(cssVar);
  const ps = Array.from({ length: Math.round(Math.min(220, W / 6)) }, (_, i) => ({
    x: Math.random() * W, y: -20 - Math.random() * H * .6, vx: (Math.random() - .5) * 1.4, vy: 1.6 + Math.random() * 2.6,
    w: 6 + Math.random() * 6, h: 3 + Math.random() * 4, a: Math.random() * TAU, va: (Math.random() - .5) * .3, ph: Math.random() * TAU,
    col: colors[i % colors.length],
  }));
  const t0 = performance.now(), END = 3600;
  let last = t0;
  const frame = t => {
    const e = t - t0, k = Math.min(3, (t - last) / 16.7);
    last = t;
    g.clearRect(0, 0, W, H);
    g.globalAlpha = e > END - 900 ? Math.max(0, (END - e) / 900) : 1;
    for (const p of ps) {
      p.ph += .08 * k; p.x += (p.vx + Math.sin(p.ph) * .9) * k; p.y += p.vy * k; p.a += p.va * k;
      g.save(); g.translate(p.x, p.y); g.rotate(p.a); g.scale(1, Math.cos(p.ph * 1.3));
      g.fillStyle = p.col; g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      g.restore();
    }
    if (e < END && !document.hidden) requestAnimationFrame(frame); else c.remove();
  };
  requestAnimationFrame(frame);
}
