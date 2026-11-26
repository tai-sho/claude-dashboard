// 詳細パネル: 1つのセッションの、閉じる前の確認・引き継ぎ文・触ったファイル・経緯。
import { $, getJson } from './dom.js';
import { esc, plain, ago, hhmm, dayKey, dayLabel, where, openActions, highlight } from './format.js';
import { getData } from './live.js';

let seq = 0;

// q: 検索から開いたときの検索語。経緯の中の一致を強調し、最初の一致まで送る
export async function openDetail(id, q) {
  const my = ++seq; // 後から開いたものだけを描く
  const dlg = $('detail');
  $('d-title').textContent = '読み込み中';
  $('d-where').textContent = ''; $('d-actions').innerHTML = ''; $('d-body').innerHTML = '';
  if (!dlg.open) dlg.showModal();
  let s;
  try { s = await getJson('/api/session?id=' + encodeURIComponent(id)); }
  catch { if (my === seq) $('d-title').textContent = 'このセッションの記録が見つかりません'; return; }
  if (my !== seq) return;
  const live = getData()?.sessions.find(x => x.sessionId === id);
  $('d-title').textContent = s.name;
  $('d-where').innerHTML = `${where(s)}　${s.live ? esc(s.state?.label) : s.archived ? 'アーカイブ済み' : '終了'}　${esc(new Date(s.firstPromptAt || s.lastActivityAt).toLocaleString('ja-JP'))} 開始`;
  $('d-actions').innerHTML = openActions(s);

  const checks = live?.closeChecks || s.closeChecks;
  const terms = q ? q.split(/\s+/) : [];
  const sections = [];
  if (checks) sections.push(`<section class="d-sec"><h3>${checks.every(c => c.ok) ? '閉じてよい状態です' : '閉じる前に'}</h3>
    <ul class="checks">${checks.map(c => `<li class="${c.ok ? '' : 'ng'}">${esc(c.label)}</li>`).join('')}</ul></section>`);
  if (s.handoff) sections.push(`<section class="d-sec"><h3>引き継ぎ文　<span class="num" style="color:var(--ink-3);font-weight:500;font-size:13px">${esc(ago(s.handoff.at))}</span></h3>
    <p class="handoff-box">${esc(s.handoff.text)}</p>${s.handoffStale ? '<p class="l-note" style="color:var(--turn);font-size:13px">このあとに新しい依頼があります</p>' : ''}</section>`);
  if (s.files.length) sections.push(`<section class="d-sec"><h3>触ったファイル <span class="num" style="color:var(--ink-3);font-weight:500">${s.files.length}</span></h3>
    <ul class="files">${s.files.slice(0, 40).map(f => `<li><span>${esc(s.cwd && f.path.startsWith(s.cwd + '/') ? f.path.slice(s.cwd.length + 1) : f.path)}</span><span class="num">${esc(f.edits)}回</span></li>`).join('')}</ul></section>`);
  sections.push(`<section class="d-sec"><h3>経緯</h3><ol class="timeline">${timelineHtml(s.timeline, terms)}</ol></section>`);
  $('d-body').innerHTML = sections.join('');
  if (q) $('d-body').querySelector('mark')?.scrollIntoView({ block: 'center' });
}

// 続けて呼んだツールは1行にまとめ、日付が変わるところに区切りを入れる
function timelineHtml(items, terms) {
  const out = [];
  let lastDay = null, tools = [];
  const flushTools = () => {
    if (!tools.length) return;
    const names = [...new Set(tools.map(t => t.text.split(' ')[0]))];
    out.push(`<li class="tools"><time class="num">${hhmm(tools[0].at)}</time><div class="tl-text">ツール ${tools.length}回（${esc(names.slice(0, 5).join('、'))}${names.length > 5 ? ' ほか' : ''}）</div></li>`);
    tools = [];
  };
  for (const t of items) {
    const d = t.at ? dayKey(t.at) : lastDay;
    if (d !== lastDay) { flushTools(); out.push(`<li class="day-sep">${esc(dayLabel(d))}</li>`); lastDay = d; }
    if (t.kind === 'tool') { tools.push(t); continue; }
    flushTools();
    const label = { prompt: '依頼', reply: '返答', handoff: '引き継ぎ' }[t.kind];
    const text = t.kind === 'reply' ? plain(t.text) : t.text;
    out.push(`<li class="${t.kind}"><time class="num" title="${esc(label)}">${t.at ? hhmm(t.at) : ''}</time><div class="tl-text">${terms.length ? highlight(text, terms) : esc(text)}</div></li>`);
  }
  flushTools();
  return out.join('');
}

export function initDetail() {
  $('d-close').onclick = () => $('detail').close();
  $('detail').addEventListener('click', e => { if (e.target === $('detail')) $('detail').close(); });
}
