// 使用枠の計算。DOM に触らないので、node:test から直接読み込んで確かめられる。
// 値は statusline の入力の rate_limits.<窓> を hooks/statusline-tap.mjs が記録したもの（非公開の形式）。

export const WINDOWS = [
  { key: 'five_hour', label: '5時間枠', span: 5 * 3600000, color: 'var(--work)' },
  { key: 'seven_day', label: '週の枠', span: 7 * 86400000, color: 'var(--turn)' },
];
export const levelOf = p => (p >= 80 ? 'high' : p >= 50 ? 'mid' : 'low');

// resets_at は秒・ミリ秒・ISO 文字列のどれでも読む
export function parseReset(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(v); return Number.isNaN(t) ? null : t;
}
export function untilText(t, now = Date.now()) {
  const ms = t - now;
  if (ms <= 0) return 'まもなくリセット';
  const m = Math.round(ms / 60000);
  if (m < 60) return `あと${m}分でリセット`;
  const h = Math.floor(m / 60);
  if (h < 48) return `あと${h}時間${m % 60 ? (m % 60) + '分' : ''}でリセット`;
  return `${new Date(t).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' })} にリセット`;
}
// 今の窓の中での増え方から、リセット時点の見込みを出す
export function projection(w, cur, history, now = Date.now()) {
  const pct = cur?.used_percentage, reset = parseReset(cur?.resets_at);
  if (pct == null || !reset) return null;
  const start = reset - w.span;
  const pts = history.filter(r => r.at >= start && r.rate_limits?.[w.key]?.used_percentage != null)
    .map(r => ({ t: r.at, p: r.rate_limits[w.key].used_percentage }));
  if (pts.length < 2) return null;
  const first = pts[0], last = pts.at(-1);
  if (last.t - first.t < (w.key === 'five_hour' ? 20 : 120) * 60000) return null;
  const slope = (last.p - first.p) / (last.t - first.t);
  if (slope <= 0) return { text: 'この窓ではほとんど増えていません' };
  const atReset = pct + slope * Math.max(0, reset - now);
  if (atReset >= 100) {
    const hit = now + (100 - pct) / slope;
    return { text: `このペースだと ${new Date(hit).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} ごろ上限に届きます`, over: true };
  }
  return { text: `このペースだとリセット時に約${Math.round(atReset)}%` };
}
