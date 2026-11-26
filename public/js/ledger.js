// 引き継ぎ台帳: 稼働中のセッションと、この2週間に引き継ぎ文を残したセッション。
import { $, getJson } from './dom.js';
import { esc, ago, where } from './format.js';

async function render() {
  const { sessions } = await getJson('/api/ledger');
  $('c-ledger').textContent = sessions.length;
  $('ledger-list').innerHTML = sessions.map(s => {
    const st = s.live ? `<span class="st" data-state="${esc(s.state?.key)}">${esc(s.state?.label)}</span>` : `<span class="st">${s.archived ? 'アーカイブ済み' : '終了'}</span>`;
    const text = s.handoff ? `<p class="l-text">${esc(s.handoff.text)}</p>` : '<p class="l-text none">引き継ぎ文はまだありません。</p>';
    const note = s.handoffStale ? '<p class="l-note">引き継ぎ文のあとに新しい依頼があります</p>' : '';
    return `<li>
      <div class="l-head"><button class="l-name" data-detail="${esc(s.sessionId)}">${esc(s.name)}</button><span class="l-where">${where(s)}</span></div>
      ${text}${note}
      <div class="l-side">${st}<span class="num">${esc(ago(s.handoff ? s.handoff.at : s.lastActivityAt))}</span>${s.live && s.closable ? '<span class="flag clear">閉じてよい</span>' : ''}</div>
    </li>`;
  }).join('') || '<li class="lane-empty">表示できるセッションがありません。</li>';
}

export const ledgerView = {
  show() { render().catch(() => {}); },
  update() { render().catch(() => {}); },
};
