// 使用枠: 見出しの下の小さなメーターと、使用枠の画面（今の値、リセット時の見込み、7日間の推移）。
import { $, getJson } from './dom.js';
import { esc, ago } from './format.js';
import { WINDOWS, levelOf, parseReset, untilText, projection } from './quota.js';
import { getData } from './live.js';

export function renderMeters() {
  const u = getData()?.usage, el = $('meters');
  if (!u?.rate_limits) { el.hidden = true; return; }
  const stale = Date.now() - u.at > 30 * 60000 ? `（${ago(u.at)}の値）` : '';
  el.innerHTML = WINDOWS.filter(w => u.rate_limits[w.key]).map(w => {
    const cur = u.rate_limits[w.key], p = Math.round(cur.used_percentage ?? 0), reset = parseReset(cur.resets_at);
    return `<div class="meter" data-level="${levelOf(p)}"><span>${w.label}</span>
      <span class="track" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p}" aria-label="${w.label}"><span class="fill" style="display:block;width:${Math.min(100, p)}%"></span></span>
      <b class="num">${p}%</b>
      <span class="sub">${reset ? esc(untilText(reset)) : ''}${esc(stale)}</span></div>`;
  }).join('');
  el.hidden = false;
}

function chartSvg(history) {
  const W = 760, H = 220, L = 44, R = 10, T = 12, B = 26;
  const now = Date.now(), from = now - 7 * 86400000;
  const x = t => L + (W - L - R) * (t - from) / (now - from);
  const y = p => T + (H - T - B) * (1 - Math.min(100, p) / 100);
  const grid = [0, 50, 100].map(p => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(p)}" y2="${y(p)}"/><text x="${L - 6}" y="${y(p) + 4}" text-anchor="end">${p}%</text>`).join('');
  const days = [];
  for (let d = new Date(from); d <= now; d.setDate(d.getDate() + 1)) {
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    if (t > now) break;
    days.push(`<line class="grid" x1="${x(t)}" x2="${x(t)}" y1="${T}" y2="${H - B}" stroke-dasharray="2 4"/><text x="${x(t) + 4}" y="${H - 8}">${new Date(t).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })}</text>`);
  }
  const lines = WINDOWS.map(w => {
    const pts = history.filter(r => r.at >= from && r.rate_limits?.[w.key]?.used_percentage != null);
    if (!pts.length) return '';
    // 値は次の記録まで続くので階段状に結ぶ
    let d = '';
    pts.forEach((r, i) => {
      const px = x(r.at), py = y(r.rate_limits[w.key].used_percentage);
      d += i ? ` H${px.toFixed(1)} V${py.toFixed(1)}` : `M${px.toFixed(1)} ${py.toFixed(1)}`;
    });
    d += ` H${x(now).toFixed(1)}`;
    return `<path d="${d}" fill="none" stroke="${w.color}" stroke-width="2" stroke-linejoin="round"/>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="この7日間の使用枠の推移">${grid}${days.join('')}${lines}</svg>`;
}

async function render() {
  const { installed, current, history } = await getJson('/api/usage?days=8');
  const body = $('usage-body');
  if (!current?.rate_limits) {
    body.innerHTML = `<p class="lane-empty">${installed
      ? 'まだ記録がありません。Claude Code の statusline が表示されると記録されます。デスクトップアプリのセッションでは statusline が動かないことがあるため、ターミナルで claude を一度動かすと確実です。'
      : '使用枠の記録が設定されていません。<code>npm run usage:install</code> を実行してください。'}</p>`;
    return;
  }
  const cards = WINDOWS.filter(w => current.rate_limits[w.key]).map(w => {
    const cur = current.rate_limits[w.key], p = Math.round(cur.used_percentage ?? 0), reset = parseReset(cur.resets_at);
    const pj = projection(w, cur, history);
    return `<div class="ucard" data-level="${levelOf(p)}"><h3>${w.label}</h3>
      <p class="big num">${p}<small>%</small></p>
      <p>${reset ? esc(untilText(reset)) : 'リセット時刻は不明'}</p>
      ${pj ? `<p class="proj">${esc(pj.text)}</p>` : '<p>見込みを出すには、もう少し記録が必要です</p>'}</div>`;
  }).join('');
  const keys = WINDOWS.map(w => `<span class="key"><i style="background:${w.color}"></i>${w.label}</span>`).join('');
  body.innerHTML = `<div class="usage-cards">${cards}</div>
    <div class="chart"><h3>この7日間の推移${keys}</h3>${chartSvg(history)}</div>
    <p class="usage-note">値は Claude Code の statusline に渡される使用率を、変化したときだけ記録したものです。最終記録は ${esc(new Date(current.at).toLocaleString('ja-JP'))}（${esc(ago(current.at))}）。</p>`;
}

export const usageView = {
  show() { render().catch(() => {}); },
  update() { render().catch(() => {}); },
};
