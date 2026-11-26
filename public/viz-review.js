// ふりかえり: 今日の稼働帯（セッションごとの作業中とあなたの番の帯）と、この7日間のまとめ
(() => {
  const CB = window.CB = window.CB || { views: {} };
  let visible = false, seq = 0, timer = 0, counted = false;
  const DOW = ['日', '月', '火', '水', '木', '金', '土'];

  function dur(ms) {
    const m = Math.round(ms / 60000);
    if (m < 60) return `${m}<small>分</small>`;
    return `${Math.floor(m / 60)}<small>時間</small>${m % 60 ? `${m % 60}<small>分</small>` : ''}`;
  }
  const short = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);

  // ---------- 今日の稼働帯 ----------
  function gantt(r) {
    const { esc, hhmm } = CB;
    const rows = r.today.slice(-40);
    if (!rows.length) return '<p class="lane-empty">今日はまだセッションが動いていません。</p>';
    const H = 3600000;
    let from = Math.floor(Math.min(...rows.map(x => x.segs[0][0])) / H) * H;
    const to = Math.max(r.now, from + 4 * H);
    from = Math.max(from, r.from);
    const W = 960, L = 190, R = 12, T = 44, RH = 20, B = 24;
    const Hh = T + rows.length * RH + B;
    const x = t => L + (W - L - R) * (t - from) / (to - from);

    // 同時に作業していた本数（上の帯）
    const ev = [];
    for (const row of rows) for (const [s, e, k] of row.segs) if (k === 'w') ev.push([s, 1], [e, -1]);
    ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const maxC = Math.max(1, r.todayPeak.peak);
    let cur = 0, d = `M${x(from)} ${T - 8}`;
    for (const [t, dv] of ev) { d += ` H${x(t).toFixed(1)}`; cur += dv; d += ` V${(T - 8 - cur / maxC * 26).toFixed(1)}`; }
    d += ` H${x(to)} V${T - 8} Z`;

    const grid = [];
    for (let t = Math.ceil(from / H) * H; t <= to; t += H) {
      grid.push(`<line class="grid" x1="${x(t)}" x2="${x(t)}" y1="${T - 36}" y2="${Hh - B}" stroke-dasharray="2 4"/>${x(t) < W - 30 ? `<text x="${x(t) + 3}" y="${Hh - 8}">${new Date(t).getHours()}時</text>` : ''}`);
    }
    const bars = rows.map((row, i) => {
      const y = T + i * RH;
      const segs = row.segs.map(([s, e, k]) => `<rect class="${k}" x="${x(s).toFixed(1)}" y="${y + 4}" width="${Math.max(1.5, x(e) - x(s)).toFixed(1)}" height="${RH - 8}" rx="2"><title>${k === 'w' ? '作業中' : 'あなたの番'} ${hhmm(s)}–${hhmm(e)}</title></rect>`).join('');
      return `<text class="g-name" x="${L - 10}" y="${y + RH / 2 + 4}" text-anchor="end" data-detail="${esc(row.sessionId)}">${esc(short(row.name, 18))}<title>${esc(row.name)}（${esc(row.project)}）</title></text>${segs}`;
    }).join('');
    return `<div class="gantt"><svg viewBox="0 0 ${W} ${Hh}" role="img" aria-label="今日のセッションごとの稼働帯">
      <path class="conc" d="${d}"/><text x="${L - 10}" y="${T - 18}" text-anchor="end">同時に作業</text>
      ${grid.join('')}${bars}<line class="now" x1="${x(r.now)}" x2="${x(r.now)}" y1="${T - 36}" y2="${Hh - B}"/>
    </svg></div>`;
  }

  // ---------- この7日間 ----------
  function bars(list, color) {
    const { esc } = CB;
    if (!list.length) return '<p>記録がありません</p>';
    const max = list[0].count;
    return `<ul class="bars">${list.map(x => `<li><span title="${esc(x.name)}">${esc(x.name)}</span><i style="width:${(x.count / max * 100).toFixed(1)}%;${color ? `background:${color}` : ''}"></i><b class="num">${x.count}</b></li>`).join('')}</ul>`;
  }
  function heatmap(hours) {
    const max = Math.max(1, ...hours.flat());
    const order = [1, 2, 3, 4, 5, 6, 0];
    let html = '<span></span>' + Array.from({ length: 24 }, (_, h) => `<span>${h % 6 === 0 ? h : ''}</span>`).join('');
    for (const d of order) {
      html += `<span class="hl">${DOW[d]}</span>` + hours[d].map((v, h) => `<i style="--v:${(v / max).toFixed(2)}" title="${DOW[d]}曜 ${h}時台 依頼 ${v}件"></i>`).join('');
    }
    return `<div class="heat" role="img" aria-label="曜日と時間帯ごとの依頼の数">${html}</div>`;
  }
  function week(w) {
    const { esc, dayLabel } = CB;
    const n = (v, u) => `<span class="num" data-count="${v}">${v}</span><small>${u}</small>`;
    const peakAt = w.peak.at ? new Date(w.peak.at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    return `<div class="wrap-grid">
      <div class="wcard"><h3>動かしたセッション</h3><p class="big">${n(w.sessions, '本')}</p><p>依頼 ${w.prompts}件</p></div>
      <div class="wcard"><h3>ツールの呼び出し</h3><p class="big">${n(w.toolCalls, '回')}</p><p>そのうちファイルの編集 ${w.edits}回</p></div>
      <div class="wcard"><h3>いちばん並列だったとき</h3><p class="big">${n(w.peak.peak, '本同時')}</p><p>${esc(peakAt)}</p></div>
      <div class="wcard"><h3>いちばん長く走り続けた作業</h3><p class="big num">${w.longest ? dur(w.longest.ms) : '―'}</p>${w.longest ? `<p><button class="act" data-detail="${esc(w.longest.sessionId)}">${esc(w.longest.name)}</button></p>` : ''}</div>
      <div class="wcard"><h3>いちばん依頼した日</h3><p class="big">${w.busiestDay ? n(w.busiestDay.prompts, '件') : '―'}</p><p>${w.busiestDay ? esc(dayLabel(w.busiestDay.day)) : ''}</p></div>
      <div class="wcard"><h3>よく使ったツール</h3>${bars(w.tools)}</div>
      <div class="wcard"><h3>よく使ったスキル</h3>${bars(w.skills, 'var(--turn)')}</div>
      <div class="wcard"><h3>依頼の多かったプロジェクト</h3>${bars(w.projects, 'var(--ok)')}</div>
      <div class="wcard wide"><h3>依頼した時間帯</h3>${heatmap(w.hours)}</div>
    </div>`;
  }

  // 初めて開いたときだけ、大きな数字を数え上げる
  function countUp(root) {
    if (counted || CB.reduceMotion.matches) return;
    counted = true;
    const els = [...root.querySelectorAll('[data-count]')];
    const t0 = performance.now();
    const tick = t => {
      const p = Math.min(1, (t - t0) / 900), e = 1 - Math.pow(1 - p, 3);
      for (const el of els) el.textContent = Math.round(Number(el.dataset.count) * e);
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  async function render() {
    const my = ++seq;
    const from = new Date(); from.setHours(0, 0, 0, 0);
    let r;
    try { r = await CB.getJson(`/api/review?from=${from.getTime()}&days=7`); } catch { return; }
    if (my !== seq || !visible) return;
    const peak = r.todayPeak.peak ? `いちばん多いときで ${r.todayPeak.peak}本が同時に作業` : '';
    const body = CB.$('review-body');
    body.innerHTML = `
      <section class="rv-sec" aria-labelledby="h-today"><h2 id="h-today">今日の稼働帯 <span>青が Claude の作業中、黄色があなたの番です。${CB.esc(peak)}</span></h2>${gantt(r)}</section>
      <section class="rv-sec" aria-labelledby="h-week"><h2 id="h-week">この7日間 <span>${r.index.ready ? '' : '索引を作成中のため、一部だけの集計です'}</span></h2>${week(r.week)}</section>`;
    countUp(body);
  }

  CB.views.review = {
    show() { visible = true; render(); clearInterval(timer); timer = setInterval(() => { if (!document.hidden) render(); }, 60000); },
    hide() { visible = false; clearInterval(timer); },
  };
})();
