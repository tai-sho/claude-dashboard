// 呼び出し盤: 稼働中のセッションを伝票として並べる。
// 前回届いた状態との違い（新しく呼ばれた、閉じてよくなった、待ち時間の桁）もここで覚え、強調・判子・めくれに使う。
// 並びや状態が変わったときは View Transitions で描き替え、伝票が裏返りながら新しい場所へ動くようにする。
import { $, store, reduceMotion } from './dom.js';
import { esc, plain, elapsed, ago, where, gitFlag, openActions } from './format.js';
import { since, sortLanes, groupByProject } from './lanes.js';
import { getData, laneOf } from './live.js';
import { setBadge } from './alerts.js';

let arrange = store.get('arrange', 'project') === 'state' ? 'state' : 'project'; // 盤面の並べ方
let prevStates = null;
let prevClosable = null;
const fresh = new Set();      // 今回新しく呼ばれたセッション（伝票を強調する）
const stamped = new Set();    // 今回「閉じてよい」になったセッション（判子を一度だけ押す）
const shownClock = new Map(); // セッションごとに前回表示した待ち時間（変わった桁だけめくる）
const shownState = new Map(); // セッションごとに前回描いた状態（変わった伝票を裏返す）
const flipped = new Set();    // 今回の描き替えで状態が変わったセッション
let shownLayout = '';         // 前回描いた並び（変わったときだけ動かして描き替える）

// 発車標のように、前回から変わった桁だけをめくる。
// めくる桁は、新しい字の上に古い下半分・倒れる古い上半分・落ちてくる新しい下半分を重ねる
function flaps(id, text) {
  const prev = shownClock.get(id);
  shownClock.set(id, text);
  const cur = [...text], old = prev == null ? null : [...prev];
  let k = 0;
  return cur.map((c, i) => {
    const j = old ? old.length - (cur.length - i) : -1;
    if (!old || (j >= 0 && old[j] === c)) return `<span class="flap">${esc(c)}</span>`;
    const was = esc(j >= 0 ? old[j] : '');
    return `<span class="flap" style="--d:${k++ * 70}ms">${esc(c)}<span class="f-old" aria-hidden="true">${was}</span><span class="f-top" aria-hidden="true">${was}</span><span class="f-bot" aria-hidden="true">${esc(c)}</span></span>`;
  }).join('');
}

// View Transitions の名前。セッション ID やプロジェクトのパスを、CSS の識別子に使える短いハッシュにする
const vtName = id => {
  let h = 2166136261;
  for (const c of String(id)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return 't-' + (h >>> 0).toString(36);
};
const vtStyle = s => `view-transition-name:${vtName(s.sessionId)}${flipped.has(s.sessionId) ? ';view-transition-class:flip' : ''}`;

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
  const aged = laneOf(s) === 'you';
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
  <article class="ticket${big ? '' : ' compact'}${fresh.has(s.sessionId) ? ' fresh' : ''}${stamped.has(s.sessionId) ? ' thud' : ''}${aged ? ' aged' : ''}" data-state="${esc(st.key)}" data-id="${esc(s.sessionId)}" style="${esc(vtStyle(s))}${aged ? `;--age:${ageOf(s).toFixed(2)}` : ''}">
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
  return `<li style="${esc(vtStyle(s))}"><button class="row-btn" data-detail="${esc(s.sessionId)}">
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
      <h2 style="view-transition-name:${vtName('p' + (g.root || g.label))}"><span class="p-name" id="p-${i}"${g.root ? ` title="${esc(g.root)}"` : ''}>${esc(g.label)}</span><span class="p-tally">${tally}</span></h2>
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

// 動かして描き替えてよいか。盤面が見えていて、動きを減らす設定でないときだけ
const canMove = () => !!document.startViewTransition && !reduceMotion.matches && !document.hidden
  && !$('view-board').hidden && !document.querySelector('.ambient:not([hidden])');

export function renderBoard() {
  const data = getData();
  if (!data) { syncArrange(); return; }
  const lanes = sortLanes(data.sessions, laneOf);
  flipped.clear();
  for (const s of data.sessions) { const k = shownState.get(s.sessionId); if (k && k !== s.state.key) flipped.add(s.sessionId); }

  // 盤面の HTML は今の状態（強調・判子・めくれ）で先に組み立てる。描き替えは apply でまとめて行う
  const html = {};
  if (arrange === 'project') {
    html.projects = renderProjects(lanes);
  } else {
    html.you = lanes.you.map(s => ticket(s, true)).join('') || '<p class="lane-empty">いま、あなたの返事を待っているセッションはありません。</p>';
    html.work = lanes.work.map(s => ticket(s, false)).join('') || '<p class="lane-empty">作業中のセッションはありません。</p>';
    html.rest = lanes.rest.map(s => restRow(s)).join('');
  }
  const layout = arrange + '|' + ['you', 'work', 'rest'].map(l => lanes[l].map(s => `${s.sessionId}:${s.state.key}:${s.closable ? 1 : 0}`).join(',')).join('|');
  shownState.clear();
  for (const s of data.sessions) shownState.set(s.sessionId, s.state.key);

  const calls = lanes.you.filter(s => s.state.key !== 'yours').length;
  const turns = lanes.you.length - calls;
  const arriving = lanes.you.some(s => s.state.key !== 'yours' && fresh.has(s.sessionId));
  const apply = () => {
    syncArrange();
    if (arrange === 'project') {
      $('board-projects').innerHTML = html.projects;
      $('lane-you').innerHTML = $('lane-work').innerHTML = $('lane-rest').innerHTML = ''; // 隠れた側に同じ名前の伝票を残さない
    } else {
      $('lane-you').innerHTML = html.you; $('lane-work').innerHTML = html.work; $('lane-rest').innerHTML = html.rest;
      $('c-you').textContent = lanes.you.length; $('c-work').textContent = lanes.work.length; $('c-rest').textContent = lanes.rest.length;
      $('board-projects').innerHTML = '';
    }
    restoreTilt();

    const v = $('verdict');
    if (calls) { v.textContent = `${calls}件が承認や確認を求めています`; v.dataset.tone = 'call'; }
    else if (turns) { v.textContent = `${turns}件があなたの返事を待っています`; v.dataset.tone = 'calm'; }
    else if (lanes.work.length) { v.textContent = 'すべて Claude が進めています'; v.dataset.tone = 'calm'; }
    else { v.textContent = '待っているセッションはありません'; v.dataset.tone = 'calm'; }
    $('tally').innerHTML = `稼働 <b class="num">${esc(data.sessions.length)}</b> セッション　作業中 <b class="num">${esc(lanes.work.length)}</b>　閉じてよい <b class="num">${esc(data.sessions.filter(s => s.closable).length)}</b>`;
    $('nav-calls').textContent = lanes.you.length || '';
    document.title = lanes.you.length ? `(${lanes.you.length}) Claude 呼び出し盤` : 'Claude 呼び出し盤';
    setBadge(calls, turns);
    // 承認や確認を求めているあいだは画面の上の縁を灯す。新しく呼ばれたときは一度だけ強く光らせる
    document.body.toggleAttribute('data-calling', calls > 0);
    if (arriving) {
      document.body.classList.remove('arrive'); void document.body.offsetWidth;
      document.body.classList.add('arrive');
    }
    $('hint').innerHTML = data.hooksInstalled ? '' :
      `<p class="hint">「承認待ち」の検知には hooks の登録が必要です。登録するには <code>npm run hooks:install</code> を実行してください。</p>`;
  };
  const moved = shownLayout && layout !== shownLayout;
  shownLayout = layout;
  if (moved && canMove()) document.startViewTransition(apply).ready.catch(() => {}); // 飛ばされても描き替え自体は行われる
  else apply();
}

// ---------- 指した伝票の傾き ----------
// 指した位置に向けて伝票を少し傾け、光をそこに映す。描き替えで伝票が作り直されても傾きを引き継ぐ
const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
let tilt = null; // { id, vars }
function setTilt(el, vars) { for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v); }
function onPointer(e) {
  const t = e.target.closest?.('.ticket');
  if (!t || !finePointer.matches) { tilt = null; return; }
  const r = t.getBoundingClientRect();
  const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
  const vars = { '--rx': `${((.5 - y) * 5).toFixed(2)}deg`, '--ry': `${((x - .5) * 6).toFixed(2)}deg`, '--gx': `${(x * 100).toFixed(1)}%`, '--gy': `${(y * 100).toFixed(1)}%` };
  tilt = { id: t.dataset.id, vars };
  setTilt(t, vars);
}
function restoreTilt() {
  if (!tilt) return;
  const t = document.querySelector(`.ticket[data-id="${CSS.escape(tilt.id)}"]`);
  if (t) setTilt(t, tilt.vars);
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
  document.body.addEventListener('animationend', e => { if (e.target === document.body && e.animationName === 'edge-arrive') document.body.classList.remove('arrive'); });
  setInterval(tickEcg, 1000);
  const board = $('view-board');
  board.addEventListener('pointermove', onPointer);
  board.addEventListener('pointerleave', () => { tilt = null; });
}
