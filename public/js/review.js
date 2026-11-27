// ふりかえり: セッションが動いていた時間のカレンダー（日・週・月）と、この7日間のまとめ
import { $, getJson, store, reduceMotion } from './dom.js';
import { esc, hhmm, dayKey, dayLabel } from './format.js';
import { MODES, rangeOf, shift, startOfDay, piecesByDay, layout, hourRange, daySummary, projectsIn, colorSlots, durText, workOf } from './calendar.js';

let visible = false, seq = 0, weekSeq = 0, timer = 0, counted = false;
let mode = MODES.includes(store.get('cal-mode', 'day')) ? store.get('cal-mode', 'day') : 'day';
let anchor = Date.now();
let follow = true; // 今を含む期間を見ている（日付が変わったら今に合わせて進める）
let slots = new Map(); // プロジェクト → 色の番号（描くたびに決め直す）
const DOW = ['日', '月', '火', '水', '木', '金', '土'];
const H = 3600000;
const HOUR_PX = { day: 56, week: 44 };
const MIN_PX = { day: 22, week: 18 };
const MONTH_LIST = 4; // 月の1日に名前を並べるセッションの数
const UNIT = { day: '日', week: '週', month: '月' };

// ---------- カレンダーの見出し ----------
function title(days) {
  if (mode === 'day') return dayLabel(dayKey(days[0]));
  if (mode === 'week') {
    const a = new Date(days[0]), b = new Date(days.at(-1));
    return `${a.getMonth() + 1}月${a.getDate()}日〜${a.getMonth() === b.getMonth() ? '' : `${b.getMonth() + 1}月`}${b.getDate()}日`;
  }
  const m = new Date(anchor);
  return `${m.getFullYear()}年${m.getMonth() + 1}月`;
}
const dayTone = t => ({ 0: 'sun', 6: 'sat' }[new Date(t).getDay()] || '');
const projStyle = key => `--proj:var(--cal-${slots.get(key) ?? 0})`;
// 押す前に見える説明。work: Claude が作業していた時間（ミリ秒）
const tip = (p, work) => `${p.name}\n${p.project}\n${hhmm(p.start)}〜${p.running ? '作業中' : hhmm(p.end)}　作業 ${durText(work)}`;

// ---------- 日と週: 時刻の目盛りに沿ってまとまりを置く ----------
function timeGrid(r, days, byDay) {
  const hpx = HOUR_PX[mode], minMs = MIN_PX[mode] / hpx * H;
  const today = startOfDay(r.now);
  const shown = days.includes(today);
  const [lo, hi] = hourRange([...byDay.values()].flat(), shown ? r.now : null);
  const y = (t, d) => ((t - d) / H - lo) * hpx;
  const axis = Array.from({ length: hi - lo }, (_, i) => `<li style="top:${i * hpx}px">${lo + i}時</li>`).join('');
  const head = mode === 'week' ? `<div class="cal-head"><span></span>${days.map(d => {
    const dt = new Date(d);
    return `<button class="cal-dh ${dayTone(d)}${d === today ? ' today' : ''}" data-cal-day="${d}" title="この日を開く"${d > r.now ? ' disabled' : ''}><b class="num">${dt.getDate()}</b>${DOW[dt.getDay()]}</button>`;
  }).join('')}</div>` : '';
  const cols = days.map(d => {
    const evs = layout(byDay.get(d), minMs).map(p => {
      const top = y(p.start, d), h = Math.max(MIN_PX[mode], (p.end - p.start) / H * hpx);
      const span = p.end - p.start || 1;
      const rail = p.work.map(([s, e]) => `<i style="top:${((s - p.start) / span * 100).toFixed(2)}%;height:${Math.max(.5, (e - s) / span * 100).toFixed(2)}%"></i>`).join('');
      const meta = mode === 'day' ? `<span class="ev-meta"><span class="num">${esc(hhmm(p.start))}〜${p.running ? '作業中' : esc(hhmm(p.end))}</span>　${esc(p.project)}</span>` : '';
      return `<button class="cal-ev${p.running ? ' running' : ''}${h < 34 ? ' tight' : ''}" data-detail="${esc(p.sessionId)}" title="${esc(tip(p, workOf(p)))}"
        style="${projStyle(p.key)};top:${top.toFixed(1)}px;height:${(h - 2).toFixed(1)}px;left:calc(${p.col} * 100% / ${p.cols} + 2px);width:calc(100% / ${p.cols} - 4px)">
        <span class="rail" aria-hidden="true">${rail}</span><span class="ev-name">${esc(p.name)}</span>${meta}</button>`;
    }).join('');
    const now = d === today && r.now >= d + lo * H && r.now <= d + hi * H ? `<span class="cal-now" style="top:${y(r.now, d).toFixed(1)}px" aria-hidden="true"></span>` : '';
    return `<div class="cal-col${d === today ? ' today' : ''}">${evs}${now}</div>`;
  }).join('');
  const empty = r.sessions.length ? '' : `<p class="cal-empty">${mode === 'day' ? 'この日' : 'この週'}はセッションが動いていません。</p>`;
  return `<div class="cal-scroll"><div class="cal-grid ${mode}" style="--cols:${days.length};--hpx:${hpx}px">${head}
    <div class="cal-main" style="height:${(hi - lo) * hpx}px"><ol class="cal-axis" aria-hidden="true">${axis}</ol>${cols}${empty}</div></div></div>`;
}

// ---------- 月: 日ごとに動いたセッションを並べる ----------
function monthGrid(r, days, byDay) {
  const month = new Date(anchor).getMonth(), today = startOfDay(r.now);
  const cells = days.map(d => {
    const dt = new Date(d), sum = daySummary(byDay.get(d));
    const list = sum.sessions.slice(0, MONTH_LIST).map(s => `<li><button class="cell-ev${s.running ? ' running' : ''}" data-detail="${esc(s.sessionId)}" style="${projStyle(s.key)}" title="${esc(tip(s, s.work))}"><i aria-hidden="true"></i><span>${esc(s.name)}</span></button></li>`).join('');
    const rest = sum.sessions.length - MONTH_LIST;
    const more = rest > 0 ? `<li><button class="cell-more" data-cal-day="${d}">ほか<span class="num">${rest}</span>件</button></li>` : '';
    const future = d > r.now;
    return `<div class="cal-cell${dt.getMonth() !== month ? ' out' : ''}${d === today ? ' today' : ''}">
      <div class="cell-top"><button class="cell-day num ${dayTone(d)}" data-cal-day="${d}" title="この日を開く"${future ? ' disabled' : ''}>${dt.getDate()}</button>${sum.work ? `<span class="cell-work num" title="Claude が作業していた時間（のべ）">${esc(durText(sum.work))}</span>` : ''}</div>
      ${list || more ? `<ul class="cell-list">${list}${more}</ul>` : ''}</div>`;
  }).join('');
  return `<div class="cal-month"><div class="cal-dow" aria-hidden="true">${DOW.map((w, i) => `<span class="${{ 0: 'sun', 6: 'sat' }[i] || ''}">${w}</span>`).join('')}</div><div class="cal-cells">${cells}</div></div>`;
}

function calendar(r) {
  const { days } = rangeOf(mode, anchor);
  const byDay = piecesByDay(r.sessions, days, r.now);
  const projects = projectsIn(r.sessions);
  slots = colorSlots(projects.map(p => p.key));
  const grid = mode === 'month' ? monthGrid(r, days, byDay) : timeGrid(r, days, byDay);
  const nextFrom = rangeOf(mode, shift(mode, anchor, 1)).from;
  const tally = r.sessions.length
    ? `Claude が作業していた時間 <b class="num">${esc(durText(r.work))}</b>（のべ）　動いたセッション <b class="num">${esc(r.sessions.length)}</b>本${r.peak.peak > 1 ? `　いちばん多いときで <b class="num">${esc(r.peak.peak)}</b>本同時` : ''}`
    : '';
  const { from, to } = rangeOf(mode, anchor);
  const inRange = r.now >= from && r.now < to;
  return `<div class="cal-bar">
      <h2 id="h-cal" class="cal-title">${esc(title(days))}</h2>
      <div class="cal-nav">
        <button class="ctl" data-cal-go="-1">前の${UNIT[mode]}</button>
        <button class="ctl" data-cal-go="0"${inRange ? ' disabled' : ''}>${{ day: '今日', week: '今週', month: '今月' }[mode]}</button>
        <button class="ctl" data-cal-go="1"${nextFrom > r.now ? ' disabled' : ''}>次の${UNIT[mode]}</button>
      </div>
      <div class="arrange cal-modes" role="group" aria-label="表示の単位">${MODES.map(m => `<button data-cal-mode="${m}" aria-pressed="${m === mode}">${UNIT[m]}</button>`).join('')}</div>
    </div>
    ${tally ? `<p class="cal-tally">${tally}</p>` : ''}
    ${projects.length ? `<ul class="cal-legend" aria-label="プロジェクト">${projects.map(p => `<li title="${esc(p.key)}"><i style="${projStyle(p.key)}" aria-hidden="true"></i>${esc(p.name)}</li>`).join('')}</ul>` : ''}
    ${grid}
    <p class="cal-help">${mode === 'month' ? '日付を押すとその日の時間割を、セッション名を押すと会話を開きます。' : '左の帯の濃いところが Claude が作業していた時間です。押すと会話を開きます。'}${r.index.ready ? '' : '　索引を作成中のため、一部だけ表示しています。'}</p>`;
}

// ---------- この7日間 ----------
function dur(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}<small>分</small>`;
  return `${Math.floor(m / 60)}<small>時間</small>${m % 60 ? `${m % 60}<small>分</small>` : ''}`;
}
function bars(list, color) {
  if (!list.length) return '<p>記録がありません</p>';
  const max = list[0].count;
  return `<ul class="bars">${list.map(x => `<li><span title="${esc(x.name)}">${esc(x.name)}</span><i style="width:${(x.count / max * 100).toFixed(1)}%;${color ? `background:${color}` : ''}"></i><b class="num">${esc(x.count)}</b></li>`).join('')}</ul>`;
}
function heatmap(hours) {
  const max = Math.max(1, ...hours.flat());
  const order = [1, 2, 3, 4, 5, 6, 0];
  let html = '<span></span>' + Array.from({ length: 24 }, (_, h) => `<span>${h % 6 === 0 ? h : ''}</span>`).join('');
  for (const d of order) {
    html += `<span class="hl">${DOW[d]}</span>` + hours[d].map((v, h) => `<i style="--v:${(v / max).toFixed(2)}" title="${DOW[d]}曜 ${h}時台 依頼 ${esc(v)}件"></i>`).join('');
  }
  return `<div class="heat" role="img" aria-label="曜日と時間帯ごとの依頼の数">${html}</div>`;
}
function week(w) {
  const n = (v, u) => `<span class="num" data-count="${esc(v)}">${esc(v)}</span><small>${u}</small>`;
  const peakAt = w.peak.at ? new Date(w.peak.at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  return `<div class="wrap-grid">
    <div class="wcard"><h3>動かしたセッション</h3><p class="big">${n(w.sessions, '本')}</p><p>依頼 ${esc(w.prompts)}件</p></div>
    <div class="wcard"><h3>ツールの呼び出し</h3><p class="big">${n(w.toolCalls, '回')}</p><p>そのうちファイルの編集 ${esc(w.edits)}回</p></div>
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
  if (counted || reduceMotion.matches) return;
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

// ---------- 描画 ----------
async function renderCalendar() {
  const my = ++seq;
  const { from, to } = rangeOf(mode, anchor);
  let r;
  try { r = await getJson(`/api/calendar?from=${from}&to=${to}`); } catch { return; }
  if (my !== seq || !visible) return;
  const el = $('cal');
  // 描き直しで押していたボタンを見失わないよう、フォーカスの場所を覚えておく
  const focus = document.activeElement && el.contains(document.activeElement) ? document.activeElement.dataset : null;
  el.innerHTML = calendar(r);
  if (focus) {
    const sel = ['calGo', 'calMode', 'calDay', 'detail'].find(k => focus[k] != null);
    if (sel) el.querySelector(`[data-${sel.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}="${CSS.escape(focus[sel])}"]:not(:disabled)`)?.focus();
  }
}
async function renderWeek() {
  const my = ++weekSeq;
  const from = startOfDay(Date.now());
  let r;
  try { r = await getJson(`/api/review?from=${from}&days=7`); } catch { return; }
  if (my !== weekSeq || !visible) return;
  const el = $('rv-week');
  el.innerHTML = `<h2 id="h-week">この7日間 <span>${r.index.ready ? '' : '索引を作成中のため、一部だけの集計です'}</span></h2>${week(r.week)}`;
  countUp(el);
}

// 見る期間を変える。今を含む期間なら、日付が変わったときに今へ合わせて進める
function moveTo(t) {
  const now = Date.now();
  anchor = Math.min(t, now);
  const { from, to } = rangeOf(mode, anchor);
  follow = now >= from && now < to;
  renderCalendar();
}
const go = dir => moveTo(dir === 0 ? Date.now() : shift(mode, anchor, dir));

export const reviewView = {
  init() {
    $('review-body').innerHTML = `<section class="rv-sec cal" id="cal" aria-labelledby="h-cal"></section><section class="rv-sec" id="rv-week" aria-labelledby="h-week"></section>`;
    $('cal').addEventListener('click', e => {
      const b = e.target.closest('[data-cal-go],[data-cal-mode],[data-cal-day]');
      if (!b || b.disabled) return;
      if (b.dataset.calGo) go(Number(b.dataset.calGo));
      else if (b.dataset.calMode) { mode = b.dataset.calMode; store.set('cal-mode', mode); moveTo(anchor); }
      else { mode = 'day'; store.set('cal-mode', mode); moveTo(Number(b.dataset.calDay)); }
    });
  },
  show() {
    visible = true;
    renderCalendar(); renderWeek();
    clearInterval(timer);
    // 今を含む期間を見ているときだけ、作業中のまとまりを伸ばすために描き直す
    timer = setInterval(() => {
      if (document.hidden) return;
      if (follow) anchor = Date.now();
      const { from, to } = rangeOf(mode, anchor);
      if (Date.now() >= from && Date.now() < to + 60000) renderCalendar();
      renderWeek();
    }, 60000);
  },
  hide() { visible = false; clearInterval(timer); },
};
