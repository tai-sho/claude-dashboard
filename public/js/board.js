// 呼び出し盤: 稼働中のセッションを伝票として並べる。
// 前回届いた状態との違い（新しく呼ばれた、閉じてよくなった、待ち時間の桁）もここで覚え、強調・判子・めくれに使う。
import { $, store } from './dom.js';
import { esc, plain, elapsed, ago, where, gitFlag, openActions } from './format.js';
import { since, sortLanes, groupByProject } from './lanes.js';
import { getData, laneOf } from './live.js';

let arrange = store.get('arrange', 'project') === 'state' ? 'state' : 'project'; // 盤面の並べ方
let prevStates = null;
let prevClosable = null;
const fresh = new Set();      // 今回新しく呼ばれたセッション（伝票を強調する）
const stamped = new Set();    // 今回「閉じてよい」になったセッション（判子を一度だけ押す）
const shownClock = new Map(); // セッションごとに前回表示した待ち時間（変わった桁だけめくる）

// 発車標のように、前回から変わった桁だけをめくる
function flaps(id, text) {
  const prev = shownClock.get(id);
  shownClock.set(id, text);
  const cur = [...text], old = prev == null ? null : [...prev];
  let k = 0;
  return cur.map((c, i) => {
    const j = old ? old.length - (cur.length - i) : -1;
    const flip = old && (j < 0 || old[j] !== c);
    return `<span class="flap${flip ? ' flip' : ''}"${flip ? ` style="animation-delay:${k++ * 70}ms"` : ''}>${esc(c)}</span>`;
  }).join('');
}

// 待たせている時間で伝票の紙が焼けていく（2時間でいちばん濃くなる）
const ageOf = s => Math.min(1, Math.sqrt(Math.max(0, Date.now() - since(s)) / (120 * 60000)));

// ---------- 心電図（直近10分の動き） ----------
const ECG_SPAN = 10 * 60000, ECG_W = 240, ECG_BASE = 19;
function ecgPath(beats, now) {
  const pts = [];
  for (const [at, kind] of beats || []) {
    const x = ECG_W * (1 - (now - at) / ECG_SPAN);
    if (x < -4 || x > ECG_W + 4) continue;
    const h = kind === 't' ? 15 : kind === 'r' ? 10 : 7;
    const last = pts.at(-1);
    if (last && x - last.x < 4) { last.h = Math.max(last.h, h); continue; } // 近すぎる拍はまとめる
    pts.push({ x, h });
  }
  let d = `M0 ${ECG_BASE}`;
  for (const { x, h } of pts) {
    const f = n => (x + n).toFixed(1);
    d += ` L${f(-4)} ${ECG_BASE} L${f(-2)} ${ECG_BASE + 3} L${f(0)} ${ECG_BASE - h} L${f(2)} ${ECG_BASE + 4} L${f(4)} ${ECG_BASE}`;
  }
  return d + ` L${ECG_W} ${ECG_BASE}`;
}
function ecg(s) {
  if (s.state.key !== 'working' && s.state.key !== 'stalled') return '';
  return `<div class="ecg" title="直近10分の動き（高い山がツール、低い山が返答）">
    <svg viewBox="0 0 ${ECG_W} 26" preserveAspectRatio="none" aria-hidden="true"><path data-ecg="${esc(s.sessionId)}" d="${ecgPath(s.beats, Date.now())}"/></svg>
    <span class="ecg-head" aria-hidden="true"></span></div>`;
}
function tickEcg() {
  const data = getData();
  if (!data || document.hidden) return;
  const now = Date.now();
  const byId = new Map(data.sessions.map(s => [s.sessionId, s]));
  for (const p of document.querySelectorAll('path[data-ecg]')) p.setAttribute('d', ecgPath(byId.get(p.dataset.ecg)?.beats, now));
}

// ---------- 伝票と行 ----------
const clearFlag = s => `<span class="flag clear stamp${stamped.has(s.sessionId) ? ' pressed' : ''}">閉じてよい</span>`;

function ticket(s, big, inProject) {
  const e = elapsed(Date.now() - since(s));
  const aged = laneOf(s) === 'you' ? ` style="--age:${ageOf(s).toFixed(2)}"` : '';
  const place = where(s, inProject);
  const st = s.state;
  const stateText = st.key === 'working' ? `<span class="pulse" aria-hidden="true"></span>${esc(st.label)}` : esc(st.label);
  const prompt = plain(s.lastPrompt);
  const handoffFresh = s.handoff && s.handoff.at >= (s.lastPromptAt || 0);
  const reply = handoffFresh ? '' : plain(s.lastReply);
  const tools = st.key === 'working' && s.recentTools.length
    ? `<ul class="tools">${s.recentTools.slice(0, big ? 3 : 2).map(t => `<li><b>${esc(t.name)}</b>${esc(t.detail)}</li>`).join('')}</ul>` : '';
  const ack = st.key === 'yours' ? `<button class="act" data-ack="${esc(s.sessionId)}">確認した</button>` : '';
  return `
  <article class="ticket${big ? '' : ' compact'}${fresh.has(s.sessionId) ? ' fresh' : ''}${aged ? ' aged' : ''}" data-state="${esc(st.key)}"${aged}>
    <div>
      <h3 class="t-name"><button data-detail="${esc(s.sessionId)}">${esc(s.name)}</button></h3>
      ${place ? `<p class="t-where">${place}</p>` : ''}
    </div>
    <div class="clock num" title="${esc(new Date(since(s)).toLocaleString('ja-JP'))}">
      <span class="elapsed" aria-label="${e.n}${e.u}">${flaps(s.sessionId, String(e.n))}<small>${e.u}</small></span>
      <span class="state">${stateText}</span>
    </div>
    ${st.key !== 'yours' && st.reason && !tools ? `<p class="reason">${esc(st.reason)}</p>` : ''}
    <dl class="exchange">
      ${prompt ? `<div class="say"><dt>依頼</dt><dd>${esc(prompt)}</dd></div>` : ''}
      ${handoffFresh && st.key !== 'working' ? `<div class="say handoff"><dt>引き継ぎ</dt><dd>${esc(s.handoff.text)}</dd></div>` : ''}
      ${reply && st.key !== 'working' ? `<div class="say"><dt>返答</dt><dd>${esc(reply)}</dd></div>` : ''}
      ${s.skills?.length ? `<div class="say skills"><dt>スキル</dt><dd>${esc(s.skills.join('、'))}</dd></div>` : ''}
    </dl>
    ${tools}
    ${ecg(s)}
    <div class="foot">
      ${gitFlag(s)}${s.closable ? clearFlag(s) : ''}
      <span class="spacer"></span>
      ${openActions(s)}
      ${ack}
      <button class="act" data-detail="${esc(s.sessionId)}">詳細</button>
    </div>
  </article>`;
}

function closeFlag(s) {
  if (s.closable) return clearFlag(s);
  return gitFlag(s) || `<span class="flag">${esc(s.state?.label || '')}</span>`;
}

function restRow(s, inProject) {
  return `<li><button class="row-btn" data-detail="${esc(s.sessionId)}">
    <span class="r-name">${esc(s.name)}</span>
    <span class="r-where">${where(s, inProject)}</span>
    <span class="r-age num">${ago(s.lastActivityAt)}</span>
    <span class="r-flag">${closeFlag(s)}</span>
  </button></li>`;
}

// プロジェクト別: プロジェクトの中は 待っている → 作業中 → 寝かせている
function renderProjects(lanes) {
  const list = groupByProject(lanes);
  if (!list.length) return '<p class="lane-empty">稼働中のセッションはありません。</p>';
  return list.map((g, i) => {
    const tally = [
      g.you.length ? `<span class="pc" data-tone="${g.calls ? 'call' : 'turn'}">待っている <b class="num">${g.you.length}</b></span>` : '',
      g.work.length ? `<span class="pc" data-tone="work">作業中 <b class="num">${g.work.length}</b></span>` : '',
      g.rest.length ? `<span class="pc">寝かせている <b class="num">${g.rest.length}</b></span>` : '',
    ].join('');
    const cards = [...g.you.map(s => ticket(s, true, true)), ...g.work.map(s => ticket(s, false, true))].join('');
    return `<section class="proj" data-rank="${g.rank}" aria-labelledby="p-${i}">
      <h2><span class="p-name" id="p-${i}"${g.root ? ` title="${esc(g.root)}"` : ''}>${esc(g.label)}</span><span class="p-tally">${tally}</span></h2>
      ${cards ? `<div class="grid-proj">${cards}</div>` : ''}
      ${g.rest.length ? `<ul class="rows">${g.rest.map(s => restRow(s, true)).join('')}</ul>` : ''}
    </section>`;
  }).join('');
}

// 並べ方の表示は、データが届く前（接続できないときも含む）から合わせておく
function syncArrange() {
  for (const b of document.querySelectorAll('[data-arrange]')) b.setAttribute('aria-pressed', b.dataset.arrange === arrange);
  $('board-lanes').hidden = arrange !== 'state';
  $('board-projects').hidden = arrange !== 'project';
}

export function setArrange(a) {
  arrange = a === 'state' ? 'state' : 'project';
  store.set('arrange', arrange);
  renderBoard();
}

export function renderBoard() {
  syncArrange();
  const data = getData();
  if (!data) return;
  const lanes = sortLanes(data.sessions, laneOf);

  if (arrange === 'project') {
    $('board-projects').innerHTML = renderProjects(lanes);
  } else {
    $('lane-you').innerHTML = lanes.you.map(s => ticket(s, true)).join('') || '<p class="lane-empty">いま、あなたの返事を待っているセッションはありません。</p>';
    $('lane-work').innerHTML = lanes.work.map(s => ticket(s, false)).join('') || '<p class="lane-empty">作業中のセッションはありません。</p>';
    $('lane-rest').innerHTML = lanes.rest.map(s => restRow(s)).join('');
    $('c-you').textContent = lanes.you.length; $('c-work').textContent = lanes.work.length; $('c-rest').textContent = lanes.rest.length;
  }

  const calls = lanes.you.filter(s => s.state.key !== 'yours').length;
  const turns = lanes.you.length - calls;
  const v = $('verdict');
  if (calls) { v.textContent = `${calls}件が承認や確認を求めています`; v.dataset.tone = 'call'; }
  else if (turns) { v.textContent = `${turns}件があなたの返事を待っています`; v.dataset.tone = 'calm'; }
  else if (lanes.work.length) { v.textContent = 'すべて Claude が進めています'; v.dataset.tone = 'calm'; }
  else { v.textContent = '待っているセッションはありません'; v.dataset.tone = 'calm'; }
  $('tally').innerHTML = `稼働 <b class="num">${esc(data.sessions.length)}</b> セッション　作業中 <b class="num">${esc(lanes.work.length)}</b>　閉じてよい <b class="num">${esc(data.sessions.filter(s => s.closable).length)}</b>`;
  $('nav-calls').textContent = lanes.you.length || '';
  document.title = lanes.you.length ? `(${lanes.you.length}) Claude 呼び出し盤` : 'Claude 呼び出し盤';
  $('hint').innerHTML = data.hooksInstalled ? '' :
    `<p class="hint">「承認待ち」の検知には hooks の登録が必要です。登録するには <code>npm run hooks:install</code> を実行してください。</p>`;
}

// ---------- 状態変化の検知 ----------
// 前回と比べて新しく呼ばれたセッションを返す。閉じてよくなったセッションには判子を押す
export function detectChanges() {
  const data = getData();
  const now = {};
  for (const s of data.sessions) now[s.sessionId] = laneOf(s) === 'you' ? s.state.key : 'other';
  let called = [];
  if (prevStates) {
    called = data.sessions.filter(s => now[s.sessionId] !== 'other' && prevStates[s.sessionId] !== now[s.sessionId]);
    for (const s of called) fresh.add(s.sessionId);
  }
  prevStates = now;
  const closable = new Map(data.sessions.map(s => [s.sessionId, s.closable]));
  if (prevClosable) for (const [id, ok] of closable) if (ok && prevClosable.get(id) === false) stamped.add(id);
  prevClosable = closable;
  for (const id of shownClock.keys()) if (!closable.has(id)) shownClock.delete(id); // 終わったセッションの分は忘れる
  return called;
}
// 強調と判子は、届いた直後の1回の描画だけに付ける
export function settle() { fresh.clear(); stamped.clear(); }

export function initBoard() {
  syncArrange();
  setInterval(tickEcg, 1000);
}
