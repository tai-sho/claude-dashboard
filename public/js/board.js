// 呼び出し盤: 稼働中のセッションを伝票として並べる。
// 前回届いた状態との違い（新しく呼ばれた、閉じてよくなった、ツールを呼んだ、返答が来た、待ち時間の桁）もここで覚え、
// 伝票の移動・吊り下がり・判子・縁の光・めくれ・タイプライターに使う。
// 盤面は描くたびに作り直すので、一度きりの動きは「始まった時刻」で覚え、描き直しても続きから動かす（負の animation-delay）。
import { $, store, reduceMotion } from './dom.js';
import { esc, plain, elapsed, ago, where, gitFlag, openActions, dayKey, daypart } from './format.js';
import { since, sortLanes, groupByProject, projectKey } from './lanes.js';
import { getData, laneOf, ack } from './live.js';
import { hash, planetOf } from './planet.js';
import { motionOK, snapshot, flip, tearOff, fadeOut, crumpleTo, confetti } from './fx.js';

let arrange = store.get('arrange', 'project') === 'state' ? 'state' : 'project'; // 盤面の並べ方
let prevStates = null;
let prevClosable = null;
let prevAllClear = null;
const prevBeat = new Map();   // セッションごとに前回見た最後の動きの時刻
const prevSaid = new Map();   // セッションごとに前回見た返答（引き継ぎ文）の時刻
const prevTool = new Map();   // セッションごとに前回見た最新のツール
const shownClock = new Map(); // セッションごとに前回表示した待ち時間（変わった桁だけめくる）
const shownVerdict = new Map();
let called = new Set();       // 今回新しく呼ばれたセッション（伝票を揺らす）
const skipFlip = new Set();   // 今回は動かさない伝票（「確認した」で伝票刺しへ飛ばしたもの）
let rendered = false;         // 盤面を一度でも見える状態で描いたか（初回は登場の動きを出さない）
let celebrate = false;        // すべて閉じてよくなった（紙吹雪）

// ---------- 一度きりの動き ----------
const FX_MS = { fresh: 2400, stamp: 600, zap: 1100, tool: 1400, verdict: 1400 };
const fx = new Map(); // `${id}|${種類}` → 始まった時刻
const startFx = (id, kind) => fx.set(`${id}|${kind}`, Date.now());
function fxAge(id, kind) {
  const t = fx.get(`${id}|${kind}`);
  if (t == null) return -1;
  const e = Date.now() - t;
  if (e > FX_MS[kind]) { fx.delete(`${id}|${kind}`); return -1; }
  return e;
}
const fxOn = (id, kind) => fxAge(id, kind) >= 0;
// 描き直しても続きから動くよう、経過した分だけ animation-delay を負にする
const fxDelay = (name, id, kind) => { const e = fxAge(id, kind); return e >= 0 ? `--${name}:-${e}ms;` : ''; };

// 発車標のように、前回から変わった桁だけをめくる
function flaps(id, text, memo = shownClock) {
  const prev = memo.get(id);
  memo.set(id, text);
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

// プロジェクトの印（眺めるモードの惑星と同じ種類と色）
function planetGlyph(key) {
  const p = planetOf(key);
  const land = p.land ? `;--pl-d:${p.land[0]};--pl-e:${p.land[1]}` : '';
  return `<i class="planet${p.ring ? ' ringed' : ''}" data-type="${p.type}" style="--pl-a:${p.glyph[0]};--pl-b:${p.glyph[1]};--pl-c:${p.glyph[2]}${land}" aria-hidden="true"></i>`;
}

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

// ---------- 電光掲示（最近のツール） ----------
// 内容が同じあいだは、描き直しても同じ位置から流れ続けるよう、時計から位置を決める
function ticker(s) {
  const tools = s.recentTools.slice(0, 5);
  const items = tools.map(t => `<span class="tk-item"><b>${esc(t.name)}</b>${esc(t.detail)}</span>`).join('<i class="tk-sep" aria-hidden="true">▸</i>');
  const chars = tools.reduce((n, t) => n + String(t.name).length + String(t.detail).length + 3, 0);
  const dur = Math.max(12, chars * .24) * 1000;
  const id = s.sessionId;
  return `<div class="ticker${fxOn(id, 'tool') ? ' new' : ''}" style="${fxDelay('kd', id, 'tool')}" role="group" aria-label="最近のツール">
    <div class="tk-track" style="--dur:${dur.toFixed(0)}ms;--off:-${(Date.now() % dur).toFixed(0)}ms"><span class="tk-run">${items}</span><span class="tk-run" aria-hidden="true">${items}</span></div></div>`;
}

// ---------- タイプライター（新しく届いた返答と引き継ぎ文） ----------
const typing = new Map(); // id → { start, text }
let typingRaf = 0;
const typeDur = n => Math.min(1800, Math.max(500, n * 22));
function typeFrame() {
  typingRaf = 0;
  const now = Date.now();
  let more = false;
  for (const el of document.querySelectorAll('[data-typing]')) {
    const id = el.dataset.typing, t = typing.get(id);
    if (!t) { el.removeAttribute('data-typing'); continue; }
    t.text ??= el.textContent;
    const k = (now - t.start) / typeDur(t.text.length);
    if (k >= 1) { el.textContent = t.text; el.removeAttribute('data-typing'); typing.delete(id); continue; }
    el.textContent = t.text.slice(0, Math.ceil(t.text.length * k));
    more = true;
  }
  if (more) typingRaf = requestAnimationFrame(typeFrame);
}
const typeAttr = id => (typing.has(id) ? ` data-typing="${esc(id)}"` : '');

// ---------- 伝票と行 ----------
function clearFlag(s) {
  const id = s.sessionId;
  return `<span class="flag clear stamp${fxOn(id, 'stamp') ? ' pressed' : ''}" style="${fxDelay('sd', id, 'stamp')}">閉じてよい</span>`;
}

function ticket(s, big, inProject) {
  const id = s.sessionId;
  const e = elapsed(Date.now() - since(s));
  const waitingOnYou = laneOf(s) === 'you';
  const plan = planetOf(projectKey(s));
  const fxStyle = `--proj:${plan.glyph[1]};${fxDelay('fd', id, 'fresh')}${fxDelay('zd', id, 'zap')}`;
  const aged = waitingOnYou ? `--age:${ageOf(s).toFixed(2)};--tilt:${hash(id, 31) > .5 ? 1 : -1};` : '';
  const place = where(s, inProject);
  const st = s.state;
  const stateText = st.key === 'working' ? `<span class="pulse" aria-hidden="true"></span>${esc(st.label)}` : esc(st.label);
  const prompt = plain(s.lastPrompt);
  const handoffFresh = s.handoff && s.handoff.at >= (s.lastPromptAt || 0);
  const reply = handoffFresh ? '' : plain(s.lastReply);
  const tools = st.key === 'working' && s.recentTools.length ? ticker(s) : '';
  const ack = st.key === 'yours' ? `<button class="act" data-ack="${esc(id)}">確認した</button>` : '';
  const cls = ['ticket', big ? '' : 'compact', fxOn(id, 'fresh') ? 'fresh' : '', fxOn(id, 'zap') ? 'zap' : '', waitingOnYou ? 'aged' : ''].filter(Boolean).join(' ');
  return `
  <article class="${cls}" data-id="${esc(id)}" data-state="${esc(st.key)}" style="${aged}${fxStyle}">
    <i class="ptab" aria-hidden="true"></i>
    ${waitingOnYou ? '<i class="pin" aria-hidden="true"></i><i class="curl" aria-hidden="true"></i>' : ''}
    <div>
      <h3 class="t-name"><button data-detail="${esc(id)}">${esc(s.name)}</button></h3>
      ${place || !inProject ? `<p class="t-where">${inProject ? '' : planetGlyph(projectKey(s))}${place}</p>` : ''}
    </div>
    <div class="clock num" title="${esc(new Date(since(s)).toLocaleString('ja-JP'))}">
      <span class="elapsed" aria-label="${e.n}${e.u}">${flaps(id, String(e.n))}<small>${e.u}</small></span>
      <span class="state">${stateText}</span>
    </div>
    ${st.key !== 'yours' && st.reason && !tools ? `<p class="reason">${esc(st.reason)}</p>` : ''}
    <dl class="exchange">
      ${prompt ? `<div class="say"><dt>依頼</dt><dd>${esc(prompt)}</dd></div>` : ''}
      ${handoffFresh && st.key !== 'working' ? `<div class="say handoff"><dt>引き継ぎ</dt><dd${typeAttr(id)}>${esc(s.handoff.text)}</dd></div>` : ''}
      ${reply && st.key !== 'working' ? `<div class="say"><dt>返答</dt><dd${typeAttr(id)}>${esc(reply)}</dd></div>` : ''}
      ${s.skills?.length ? `<div class="say skills"><dt>スキル</dt><dd>${esc(s.skills.join('、'))}</dd></div>` : ''}
    </dl>
    ${tools}
    ${ecg(s)}
    <div class="foot">
      ${gitFlag(s)}${s.closable ? clearFlag(s) : ''}
      <span class="spacer"></span>
      ${openActions(s)}
      ${ack}
      <button class="act" data-detail="${esc(id)}">詳細</button>
    </div>
  </article>`;
}

function closeFlag(s) {
  if (s.closable) return clearFlag(s);
  return gitFlag(s) || `<span class="flag">${esc(s.state?.label || '')}</span>`;
}

function restRow(s, inProject) {
  return `<li data-id="${esc(s.sessionId)}"><button class="row-btn" data-detail="${esc(s.sessionId)}">
    <span class="r-name">${esc(s.name)}</span>
    <span class="r-where">${inProject ? '' : planetGlyph(projectKey(s))}${where(s, inProject)}</span>
    <span class="r-age num">${ago(s.lastActivityAt)}</span>
    <span class="r-flag">${closeFlag(s)}</span>
  </button></li>`;
}

// 凪: あなたを待っているものがないとき。空の伝票掛けと、作業中のセッションの灯り（ツールを呼ぶたびに光る）
function calm(work) {
  const lights = work.map(s => `<span class="calm-light${fxOn(s.sessionId, 'zap') ? ' beat' : ''}" style="--ph:-${(hash(s.sessionId, 3) * 2.4).toFixed(2)}s;${fxDelay('bd', s.sessionId, 'zap')}" title="${esc(s.name)}"></span>`).join('');
  return `<div class="calm">
    <div class="calm-rail" aria-hidden="true">${'<i></i>'.repeat(5)}</div>
    <p>${work.length ? `呼び出しはありません。<b class="num">${work.length}</b>件を Claude が進めています` : '呼び出しはありません。'}</p>
    ${lights ? `<div class="calm-lights" aria-hidden="true">${lights}</div>` : ''}
  </div>`;
}

// プロジェクト別: プロジェクトの中は 待っている → 作業中 → 寝かせている
function renderProjects(lanes) {
  const list = groupByProject(lanes);
  if (!list.length) return '<p class="lane-empty">稼働中のセッションはありません。</p>';
  return (lanes.you.length ? '' : calm(lanes.work)) + list.map((g, i) => {
    const tally = [
      g.you.length ? `<span class="pc" data-tone="${g.calls ? 'call' : 'turn'}">待っている <b class="num">${g.you.length}</b></span>` : '',
      g.work.length ? `<span class="pc" data-tone="work">作業中 <b class="num">${g.work.length}</b></span>` : '',
      g.rest.length ? `<span class="pc">寝かせている <b class="num">${g.rest.length}</b></span>` : '',
    ].join('');
    const cards = [...g.you.map(s => ticket(s, true, true)), ...g.work.map(s => ticket(s, false, true))].join('');
    return `<section class="proj" data-rank="${g.rank}" aria-labelledby="p-${i}">
      <h2>${planetGlyph(g.key)}<span class="p-name" id="p-${i}"${g.root ? ` title="${esc(g.root)}"` : ''}>${esc(g.label)}</span><span class="p-tally">${tally}</span></h2>
      ${cards ? `<div class="grid-proj">${cards}</div>` : ''}
      ${g.rest.length ? `<ul class="rows">${g.rest.map(s => restRow(s, true)).join('')}</ul>` : ''}
    </section>`;
  }).join('');
}

// 見出しの一行: 件数は発車標のようにめくり、文が変わったときは一文字ずつめくれて出る
function renderVerdict(n, text, tone) {
  const v = $('verdict');
  if (v.dataset.text !== text) startFx('verdict', 'verdict');
  v.dataset.text = text;
  v.dataset.tone = tone;
  const anim = fxOn('verdict', 'verdict');
  const chars = anim ? [...text].map((c, i) => `<span class="vch" style="--i:${i}">${esc(c)}</span>`).join('') : esc(text);
  v.style.cssText = fxDelay('vd', 'verdict', 'verdict');
  v.setAttribute('aria-label', n == null ? text : `${n}${text}`);
  v.innerHTML = (n == null ? '' : `<span class="v-num num" aria-hidden="true">${flaps('verdict', String(n), shownVerdict)}</span>`) + `<span aria-hidden="true">${chars}</span>`;
}

// ---------- 伝票刺し（今日「確認した」を押した数） ----------
function spikeCount() {
  const v = store.get('spike', null);
  return v && v.day === dayKey(Date.now()) ? v.n : 0;
}
function renderSpike(bump) {
  const n = spikeCount();
  $('spike-stack').innerHTML = Array.from({ length: Math.min(n, 9) }, (_, i) => {
    const h = k => hash(`spike${i}`, k);
    return `<i style="--k:${i};--r:${((h(2) - .5) * 70).toFixed(0)}deg;--x:${((h(3) - .5) * 5).toFixed(1)}px;--w:${(12 + h(4) * 6).toFixed(1)}px"></i>`;
  }).join('');
  $('spike-n').textContent = n || '';
  $('spike').setAttribute('aria-label', n ? `今日確認した伝票 ${n}枚` : '今日確認した伝票はまだありません');
  if (bump && motionOK()) $('spike').animate([{ transform: 'none' }, { transform: 'translateY(3px) scaleY(.92)' }, { transform: 'none' }], { duration: 320, easing: 'ease-out' });
}

// 「確認した」: 伝票を丸めて伝票刺しへ放り、寝かせている列に移す
export function ackTicket(id) {
  // 並べ方を切り替えると、隠れた方の盤面に前の伝票が残っているので、見えている伝票を選ぶ
  const el = [...document.querySelectorAll(`.ticket[data-id="${CSS.escape(id)}"]`)].find(x => x.getBoundingClientRect().width);
  ack(id);
  skipFlip.add(id);
  const day = dayKey(Date.now());
  store.set('spike', { day, n: spikeCount() + 1 });
  if (el) crumpleTo(el, $('spike'), () => renderSpike(true)); else renderSpike(true);
}

// ---------- 時間帯の空 ----------
function syncSky() { document.documentElement.dataset.daypart = daypart(new Date().getHours()); }

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
  const root = $('view-board');
  const live = !root.hidden && $('ambient').hidden && motionOK(); // 眺めるモードで覆われているあいだは動かさない
  const before = live ? snapshot(root) : new Map();
  syncArrange();
  const data = getData();
  if (!data) return;
  const lanes = sortLanes(data.sessions, laneOf);

  // 終わったセッションの伝票は、描き直す前にちぎって落とす
  if (live && rendered) {
    const ids = new Set(data.sessions.map(s => s.sessionId));
    for (const [id, b] of before) if (!ids.has(id)) (b.el.matches('.ticket') ? tearOff : fadeOut)(b.el, b.r);
  }

  if (arrange === 'project') {
    $('board-projects').innerHTML = renderProjects(lanes);
  } else {
    $('lane-you').innerHTML = lanes.you.map(s => ticket(s, true)).join('') || calm(lanes.work);
    $('lane-work').innerHTML = lanes.work.map(s => ticket(s, false)).join('') || '<p class="lane-empty">作業中のセッションはありません。</p>';
    $('lane-rest').innerHTML = lanes.rest.map(s => restRow(s)).join('');
    $('c-you').textContent = lanes.you.length; $('c-work').textContent = lanes.work.length; $('c-rest').textContent = lanes.rest.length;
  }

  const calls = lanes.you.filter(s => s.state.key !== 'yours').length;
  const turns = lanes.you.length - calls;
  if (calls) renderVerdict(calls, '件が承認や確認を求めています', 'call');
  else if (turns) renderVerdict(turns, '件があなたの返事を待っています', 'calm');
  else if (lanes.work.length) renderVerdict(null, 'すべて Claude が進めています', 'calm');
  else renderVerdict(null, '待っているセッションはありません', 'calm');
  $('tally').innerHTML = `稼働 <b class="num">${esc(data.sessions.length)}</b> セッション　作業中 <b class="num">${esc(lanes.work.length)}</b>　閉じてよい <b class="num">${esc(data.sessions.filter(s => s.closable).length)}</b>`;
  $('nav-calls').textContent = lanes.you.length || '';
  document.title = lanes.you.length ? `(${lanes.you.length}) Claude 呼び出し盤` : 'Claude 呼び出し盤';
  $('hint').innerHTML = data.hooksInstalled ? '' :
    `<p class="hint">「承認待ち」の検知には hooks の登録が必要です。登録するには <code>npm run hooks:install</code> を実行してください。</p>`;

  if (live) flip(root, before, { called, skip: skipFlip, enter: rendered });
  called = new Set();
  skipFlip.clear();
  if (live) rendered = true;
  if (typing.size && !typingRaf) typingRaf = requestAnimationFrame(typeFrame);
  if (celebrate) { celebrate = false; if (live) confetti(); }
}

// ---------- 状態変化の検知 ----------
// 前回と比べて新しく呼ばれたセッションを返す。ほかの変化（閉じてよくなった、ツールを呼んだ、返答が来た）は動きの印として覚える
export function detectChanges() {
  const data = getData();
  const first = prevStates == null;
  const now = {};
  for (const s of data.sessions) now[s.sessionId] = laneOf(s) === 'you' ? s.state.key : 'other';
  let calledNow = [];
  if (!first) {
    calledNow = data.sessions.filter(s => now[s.sessionId] !== 'other' && prevStates[s.sessionId] !== now[s.sessionId]);
    for (const s of calledNow) { startFx(s.sessionId, 'fresh'); called.add(s.sessionId); }
  }
  prevStates = now;

  const closable = new Map(data.sessions.map(s => [s.sessionId, s.closable]));
  if (prevClosable) for (const [id, ok] of closable) if (ok && prevClosable.get(id) === false) startFx(id, 'stamp');
  prevClosable = closable;
  // すべてのセッションが閉じてよくなった瞬間に紙吹雪
  const allClear = data.sessions.length > 0 && data.sessions.every(s => s.closable);
  if (allClear && prevAllClear === false) celebrate = true;
  prevAllClear = allClear;

  const motion = !reduceMotion.matches;
  for (const s of data.sessions) {
    const id = s.sessionId;
    const beat = s.beats?.at(-1);
    if (beat && !first && prevBeat.has(id) && beat[0] > prevBeat.get(id) && beat[1] === 't') startFx(id, 'zap');
    prevBeat.set(id, beat ? beat[0] : 0);
    const tool = s.recentTools?.[0] ? `${s.recentTools[0].name} ${s.recentTools[0].detail}` : '';
    if (tool && !first && prevTool.has(id) && prevTool.get(id) !== tool) startFx(id, 'tool');
    prevTool.set(id, tool);
    const said = Math.max(s.lastReplyAt || 0, s.handoff?.at || 0);
    if (motion && said && !first && prevSaid.has(id) && said > prevSaid.get(id)) typing.set(id, { start: Date.now(), text: null });
    prevSaid.set(id, said);
  }
  // 終わったセッションの分は忘れる
  for (const m of [shownClock, prevBeat, prevTool, prevSaid, typing]) for (const id of m.keys()) if (!closable.has(id)) m.delete(id);
  for (const [id, t] of typing) if (Date.now() - t.start > 2500) typing.delete(id);
  // 一度きりの動きの印も、終わったものと、終わったセッションの分は消す（見出しの印は残す）
  for (const [key, t] of fx) {
    const id = key.split('|')[0];
    if (Date.now() - t > 5000 || (id !== 'verdict' && !closable.has(id))) fx.delete(key);
  }
  return calledNow;
}

export function initBoard() {
  syncArrange();
  syncSky();
  renderSpike(false);
  setInterval(tickEcg, 1000);
  setInterval(() => { syncSky(); renderSpike(false); }, 60000); // 日付が変わったら伝票刺しも空にする
}
