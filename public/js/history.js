// 履歴と検索: この2週間のセッションを日ごとに並べる。検索語があれば、依頼・返答・引き継ぎ文から探す。
import { $, getJson } from './dom.js';
import { esc, plain, hhmm, dayKey, dayLabel, whereText, highlight } from './format.js';

function histRow(s) {
  const range = `${hhmm(s.firstPromptAt || s.lastActivityAt)}–${hhmm(s.lastActivityAt)}`;
  const side = s.live ? `<span class="st" data-state="${esc(s.state?.key)}">${esc(s.state?.label || '稼働中')}</span>` : `<span class="flag">依頼 ${esc(s.promptCount)}　編集 ${esc(s.fileCount)}</span>`;
  return `<li><button class="row-btn" data-detail="${esc(s.sessionId)}">
    <span class="r-time num">${range}</span>
    <span class="r-name">${esc(s.name)}</span>
    <span class="r-where">${esc(whereText(s))}</span>
    <span class="r-flag">${side}</span>
  </button></li>`;
}

async function render() {
  const q = $('q').value.trim();
  if (q) return renderSearch(q);
  const { sessions, index } = await getJson('/api/history?days=14');
  $('hist-meta').textContent = index.ready ? `この2週間 ${sessions.length} セッション` : `索引を作成中 ${index.done}/${index.total}`;
  const groups = new Map();
  for (const s of sessions) { const k = dayKey(s.lastActivityAt); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); }
  $('history-body').innerHTML = [...groups].map(([k, list]) => `
    <section class="day"><h3>${esc(dayLabel(k))}<span class="num">${list.length} セッション</span></h3>
    <ul class="rows hist">${list.map(histRow).join('')}</ul></section>`).join('') || '<p class="lane-empty">この2週間のセッションはありません。</p>';
}

async function renderSearch(q) {
  const { sessions, index } = await getJson('/api/search?q=' + encodeURIComponent(q));
  if ($('q').value.trim() !== q) return; // 待っているあいだに検索語が変わった
  const terms = q.split(/\s+/);
  $('hist-meta').textContent = `${sessions.length} セッションが見つかりました${sessions.length >= 60 ? '（新しい60件）' : ''}${index.ready ? '' : '　索引を作成中'}`;
  $('history-body').innerHTML = sessions.length ? `<ul class="rows hits" style="margin-top:20px">${sessions.map(s => `
    <li><button class="row-btn" data-detail="${esc(s.sessionId)}" data-q="${esc(q)}">
      <span class="r-name">${highlight(s.name, terms)}</span>
      <span class="r-where">${esc(whereText(s))}</span>
      <span class="r-age num">${new Date(s.lastActivityAt).toLocaleDateString('ja-JP')}</span>
    </button>
    <ul class="snips">${s.matches.map(m => `<li><span>${{ prompt: '依頼', reply: '返答', handoff: '引き継ぎ' }[m.kind] || ''}</span><div>${highlight(plain(m.snippet), terms)}</div></li>`).join('')}</ul></li>`).join('')}</ul>`
    : `<p class="lane-empty" style="margin-top:20px">「${esc(q)}」を含む会話は見つかりませんでした。語を減らすか、別の言い方で探してください。</p>`;
}

export const historyView = {
  init() {
    let timer;
    $('q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => render().catch(() => {}), 220); });
  },
  show() { render().catch(() => {}); },
};
