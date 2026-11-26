// つながり: 稼働中セッションと最近編集したファイルを、ばねで引き合う星座図として描く。
// 同じリポジトリの同じファイル（worktree が違っても同じ相対パス）を複数のセッションが編集していれば赤く結ぶ。
(() => {
  const CB = window.CB = window.CB || { views: {} };
  const FILE_WINDOW = 48 * 3600000; // これより前に編集したファイルは描かない
  const RECENT = 10 * 60000;        // 直近として光らせる範囲
  let ctx, canvas, tip, visible = false, raf = 0;
  let nodes = new Map(), edges = [], clashes = [];
  let heat = 1, view = { s: 1, x: 0, y: 0 }, hover = null, colors = {}, colorsAt = 0;

  const rootOf = cwd => (cwd || '').replace(/\/\.claude\/worktrees\/[^/]+.*$/, '');
  const base = p => p.split('/').pop();
  const short = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
  const hash = s => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return (h >>> 0) / 4294967296; };

  function readColors() {
    if (Date.now() - colorsAt < 1000) return colors;
    const v = CB.cssVar;
    colors = { bg: v('--surface'), ink: v('--ink'), ink2: v('--ink-2'), ink3: v('--ink-3'), rule: v('--rule'), call: v('--call'), turn: v('--turn'), work: v('--work'), rest: v('--rest'), ok: v('--ok') };
    colorsAt = Date.now();
    return colors;
  }
  const stateColor = (c, s) => {
    const lane = CB.laneOf(s);
    if (lane === 'you') return s.state.key === 'yours' ? c.turn : c.call;
    if (lane === 'work') return c.work;
    return c.rest;
  };

  // ---------- データ → 節点と辺 ----------
  function build(data) {
    const now = Date.now();
    const next = new Map(), nextEdges = [];
    const keep = (id, make, near) => {
      const old = nodes.get(id);
      const n = old ? Object.assign(old, make) : { ...make, x: (near?.x ?? 0) + (Math.random() - .5) * 60, y: (near?.y ?? 0) + (Math.random() - .5) * 60, vx: 0, vy: 0 };
      next.set(id, n);
      return n;
    };
    const fileOwners = new Map();
    for (const s of data.sessions) {
      const root = rootOf(s.cwd) || s.project || '不明';
      // リポジトリは最初から円周上に散らしておくと、まとまりが分かれやすい
      const ang = hash(root) * Math.PI * 2;
      const repo = keep('r:' + root, { kind: 'repo', label: s.project || '不明', root }, { x: Math.cos(ang) * 180, y: Math.sin(ang) * 180 });
      const sn = keep('s:' + s.sessionId, { kind: 'session', s, label: s.name }, repo);
      nextEdges.push({ a: repo, b: sn, len: 64, k: .09, type: 'repo' });
      for (const f of s.files || []) {
        if (!f.at || now - f.at > FILE_WINDOW) continue;
        const rel = s.cwd && f.path.startsWith(s.cwd + '/') ? f.path.slice(s.cwd.length + 1) : f.path;
        const key = 'f:' + root + '::' + rel;
        const fn = keep(key, { kind: 'file', rel, root, label: base(rel) }, sn);
        if (!fileOwners.has(key)) fileOwners.set(key, new Map());
        const owners = fileOwners.get(key);
        owners.set(s.sessionId, { s, edits: f.edits, at: f.at });
        nextEdges.push({ a: sn, b: fn, len: 46, k: .06, type: 'file', at: f.at, edits: f.edits });
      }
    }
    for (const [key, owners] of fileOwners) {
      const fn = next.get(key);
      fn.owners = [...owners.values()];
      fn.edits = fn.owners.reduce((a, o) => a + o.edits, 0);
      fn.at = Math.max(...fn.owners.map(o => o.at));
      fn.clash = owners.size > 1;
    }
    for (const e of nextEdges) if (e.type === 'file') e.clash = e.b.clash;
    nodes = next; edges = nextEdges;
    clashes = [...next.values()].filter(n => n.kind === 'file' && n.clash).sort((a, b) => b.at - a.at);
    heat = Math.max(heat, .6);
  }

  // ---------- ばねのシミュレーション ----------
  function step() {
    const list = [...nodes.values()];
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        let dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy || .01;
        if (d2 > 160000) continue;
        const f = (a.kind === 'repo' && b.kind === 'repo' ? 5200 : 900) / d2;
        const d = Math.sqrt(d2); dx /= d; dy /= d;
        a.vx -= dx * f; a.vy -= dy * f; b.vx += dx * f; b.vy += dy * f;
      }
    }
    for (const e of edges) {
      const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y, d = Math.hypot(dx, dy) || .01;
      const f = (d - e.len) * e.k;
      e.a.vx += dx / d * f; e.a.vy += dy / d * f; e.b.vx -= dx / d * f; e.b.vy -= dy / d * f;
    }
    let moved = 0;
    for (const n of list) {
      const g = n.kind === 'repo' ? .012 : .004;
      n.vx -= n.x * g; n.vy -= n.y * g;
      n.vx *= .82; n.vy *= .82;
      n.x += n.vx * heat; n.y += n.vy * heat;
      moved += Math.abs(n.vx) + Math.abs(n.vy);
    }
    heat = Math.max(.08, heat * .995);
    return moved / Math.max(1, list.length);
  }

  // 全体が画面に収まるよう、なめらかに寄せる
  function fit(w, h, instant) {
    if (!nodes.size) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes.values()) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
    const pad = 70;
    const s = Math.min(2, (w - pad * 2) / Math.max(1, x1 - x0), (h - pad * 2) / Math.max(1, y1 - y0));
    const tx = w / 2 - (x0 + x1) / 2 * s, ty = h / 2 - (y0 + y1) / 2 * s;
    const k = instant ? 1 : .06;
    view.s += (s - view.s) * k; view.x += (tx - view.x) * k; view.y += (ty - view.y) * k;
  }

  // ---------- 描画 ----------
  function draw(t) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    const g = canvas.getContext('2d');
    const c = readColors();
    const still = CB.reduceMotion.matches;
    const now = Date.now();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    if (!nodes.size) {
      g.fillStyle = c.ink3; g.font = '14px "IBM Plex Sans JP", sans-serif'; g.textAlign = 'center';
      g.fillText('稼働中のセッションはありません', w / 2, h / 2);
      return;
    }
    const P = n => [n.x * view.s + view.x, n.y * view.s + view.y];

    // 辺
    for (const e of edges) {
      const [ax, ay] = P(e.a), [bx, by] = P(e.b);
      const recent = e.at && now - e.at < RECENT;
      g.strokeStyle = e.clash ? c.call : recent ? c.work : e.type === 'repo' ? c.ink3 : c.rule;
      g.globalAlpha = e.type === 'repo' ? .55 : e.clash ? .9 : recent ? .75 : .6;
      g.lineWidth = e.clash ? 2 : e.type === 'repo' ? 1 : 1 + Math.min(2, (e.edits || 1) / 6);
      if (e.type === 'repo') g.setLineDash([2, 4]); else g.setLineDash([]);
      g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
      // 作業中のセッションから、編集中のファイルへ光が流れる
      if (!still && e.type === 'file' && e.a.s && CB.laneOf(e.a.s) === 'work' && now - e.at < 30 * 60000) {
        const p = (t / 1600 + hash(e.b.rel)) % 1;
        g.globalAlpha = 1; g.fillStyle = e.clash ? c.call : c.work;
        g.beginPath(); g.arc(ax + (bx - ax) * p, ay + (by - ay) * p, 2.4, 0, Math.PI * 2); g.fill();
      }
    }
    g.setLineDash([]); g.globalAlpha = 1;

    // 節点
    g.textBaseline = 'middle';
    for (const n of nodes.values()) {
      const [x, y] = P(n);
      if (n.kind === 'repo') {
        g.strokeStyle = c.ink3; g.lineWidth = 1.2; g.fillStyle = c.bg;
        g.beginPath(); g.arc(x, y, 11, 0, Math.PI * 2); g.fill(); g.stroke();
        g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2); g.fillStyle = c.ink3; g.fill();
        g.fillStyle = c.ink; g.font = '600 13px "IBM Plex Sans JP", sans-serif'; g.textAlign = 'center';
        g.fillText(short(n.label, 28), x, y - 22);
      } else if (n.kind === 'session') {
        const col = stateColor(c, n.s);
        if (!still && CB.laneOf(n.s) === 'you' && n.s.state.key !== 'yours') {
          const r = 10 + ((t / 900) % 1) * 14;
          g.strokeStyle = col; g.globalAlpha = 1 - ((t / 900) % 1); g.lineWidth = 2;
          g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke(); g.globalAlpha = 1;
        }
        g.fillStyle = col; g.beginPath(); g.arc(x, y, 8, 0, Math.PI * 2); g.fill();
        g.strokeStyle = c.bg; g.lineWidth = 2; g.stroke();
        g.fillStyle = c.ink2; g.font = '500 12px "IBM Plex Sans JP", sans-serif'; g.textAlign = 'left';
        g.fillText(short(n.label, 22), x + 12, y);
      } else {
        const recent = now - n.at < RECENT;
        const r = 3 + Math.min(5, Math.log2(1 + n.edits));
        g.fillStyle = n.clash ? c.call : recent ? c.work : c.ink3;
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
        if (n.clash) { g.strokeStyle = c.call; g.lineWidth = 1.5; g.beginPath(); g.arc(x, y, r + 4, 0, Math.PI * 2); g.stroke(); }
        if (n.clash || recent || hover === n) {
          g.fillStyle = n.clash ? c.call : c.ink2; g.font = `${n.clash ? 600 : 400} 11.5px "IBM Plex Sans JP", sans-serif`; g.textAlign = 'left';
          g.fillText(short(n.label, 30), x + r + 5, y);
        }
      }
    }
  }

  function frame(t) {
    raf = 0;
    if (!visible || document.hidden) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const motion = step();
    fit(w, h);
    draw(t);
    // 落ち着いても、作業中の光や呼び出しの波紋があるあいだは描き続ける
    const alive = motion > .02 || [...nodes.values()].some(n => n.kind === 'session' && CB.laneOf(n.s) !== 'rest');
    if (alive && !CB.reduceMotion.matches) raf = requestAnimationFrame(frame);
  }
  function settleAndDraw() {
    for (let i = 0; i < 400; i++) step();
    fit(canvas.clientWidth, canvas.clientHeight, true);
    draw(0);
  }
  function kick() {
    if (!visible) return;
    if (CB.reduceMotion.matches) return settleAndDraw();
    if (!raf) raf = requestAnimationFrame(frame);
  }

  // ---------- 文字での一覧（衝突と凡例） ----------
  function renderSide() {
    const { esc, ago } = CB;
    const list = clashes.length
      ? `<ul class="clash">${clashes.map(n => `<li><div class="c-file">${esc(n.rel)}</div><div class="c-who">${n.owners.map(o => `${esc(o.s.name)}（${esc(o.edits)}回、${esc(ago(o.at))}）`).join('、')}</div></li>`).join('')}</ul>`
      : '<p class="lane-empty">いま、同じファイルを編集しているセッションはありません。</p>';
    const c = readColors();
    CB.$('map-side').innerHTML = `<div><h3>同じファイルを編集しているセッション</h3>${list}</div>
      <div><h3>見方</h3><ul class="map-key">
        <li><i style="background:${esc(c.call)}"></i>承認待ちや停滞</li><li><i style="background:${esc(c.turn)}"></i>あなたの番</li>
        <li><i style="background:${esc(c.work)}"></i>作業中、10分以内に編集</li><li><i style="background:${esc(c.rest)}"></i>寝かせている</li>
        <li><i style="background:${esc(c.ink3)}"></i>48時間以内に編集したファイル</li></ul>
        <p class="lane-empty" style="margin-top:8px">点の大きさは編集回数です。セッションの点を押すと詳細を開きます。</p></div>`;
  }

  // ---------- 操作 ----------
  function pick(ev) {
    const r = canvas.getBoundingClientRect();
    const mx = ev.clientX - r.left, my = ev.clientY - r.top;
    let best = null, bd = 14;
    for (const n of nodes.values()) {
      const d = Math.hypot(n.x * view.s + view.x - mx, n.y * view.s + view.y - my);
      if (d < bd) { bd = d; best = n; }
    }
    return { n: best, mx, my };
  }
  function showTip(ev) {
    const { n, mx, my } = pick(ev);
    hover = n;
    canvas.style.cursor = n?.kind === 'session' ? 'pointer' : 'default';
    if (!n) { tip.hidden = true; if (CB.reduceMotion.matches) draw(0); return; }
    const { esc, ago } = CB;
    tip.innerHTML = n.kind === 'file'
      ? `<b>${esc(n.rel)}</b><br>${n.owners.map(o => `${esc(o.s.name)}　${esc(o.edits)}回、${esc(ago(o.at))}`).join('<br>')}`
      : n.kind === 'session' ? `<b>${esc(n.s.name)}</b><br>${esc(n.s.state.label)}　編集したファイル ${esc((n.s.files || []).length)}件`
      : `<b>${esc(n.label)}</b><br>${esc(n.root)}`;
    tip.hidden = false;
    tip.style.left = Math.min(mx + 14, canvas.clientWidth - tip.offsetWidth - 8) + 'px';
    tip.style.top = (my + 14) + 'px';
    if (CB.reduceMotion.matches) draw(0);
  }

  CB.views.map = {
    init(cb) {
      canvas = cb.$('map-canvas'); tip = cb.$('map-tip');
      canvas.addEventListener('mousemove', showTip);
      canvas.addEventListener('mouseleave', () => { hover = null; tip.hidden = true; });
      canvas.addEventListener('click', ev => { const { n } = pick(ev); if (n?.kind === 'session') cb.openDetail(n.s.sessionId); });
      document.addEventListener('visibilitychange', kick);
      window.addEventListener('resize', kick);
    },
    show() {
      visible = true;
      const d = CB.getData();
      if (d) { build(d); renderSide(); }
      heat = 1; kick();
    },
    hide() { visible = false; tip.hidden = true; },
    update(d) { build(d); renderSide(); kick(); },
  };
})();
