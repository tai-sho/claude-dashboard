// ふりかえりのカレンダーの計算（期間、日ごとの切り分け、重なりの並べ方、目盛りの範囲）。
// DOM に触らないので、node:test から直接読み込んで確かめられる。
import { projectKey } from './lanes.js';
import { hash } from './planet.js';

export const MODES = ['day', 'week', 'month'];
const H = 3600000;

export const startOfDay = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const addDays = (t, n) => { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); };
const firstOfMonth = t => { const d = new Date(startOfDay(t)); d.setDate(1); return d; };

// 表示する日の並び。週は日曜から土曜、月はその月を含む週をすべて（日曜始まり）
export function rangeOf(mode, anchor) {
  const a = startOfDay(anchor);
  let first = a, n = 1;
  if (mode === 'week') { first = addDays(a, -new Date(a).getDay()); n = 7; }
  else if (mode === 'month') {
    const m = firstOfMonth(a);
    first = addDays(m.getTime(), -m.getDay());
    const next = new Date(m); next.setMonth(m.getMonth() + 1);
    const last = addDays(next.getTime(), -1);
    const end = addDays(last, 6 - new Date(last).getDay());
    n = Math.round((end - first) / 86400000) + 1;
  }
  const days = Array.from({ length: n }, (_, i) => addDays(first, i));
  return { days, from: days[0], to: addDays(days.at(-1), 1) };
}

// 前（dir = -1）か次（dir = 1）の期間へ移る。月は1日に揃える
export function shift(mode, anchor, dir) {
  if (mode === 'day') return addDays(startOfDay(anchor), dir);
  if (mode === 'week') return addDays(startOfDay(anchor), 7 * dir);
  const m = firstOfMonth(anchor); m.setMonth(m.getMonth() + dir);
  return m.getTime();
}

// セッションのまとまりを日ごとに切り分ける → Map(日の始まり → [まとまり])
// まとまり: { sessionId, name, project, key, start, end, work: [[開始, 終了]], running }
// running: 稼働中で、今も作業が続いているもの
export function piecesByDay(sessions, days, now = Date.now()) {
  const out = new Map(days.map(d => [d, []]));
  for (const s of sessions) {
    const key = projectKey(s);
    for (const b of s.blocks) {
      for (const d of days) {
        const e = addDays(d, 1);
        if (b.end <= d || b.start >= e) continue;
        const start = Math.max(b.start, d), end = Math.min(b.end, e);
        const work = b.work.filter(([ws, we]) => we > start && ws < end).map(([ws, we]) => [Math.max(ws, start), Math.min(we, end)]);
        out.get(d).push({ sessionId: s.sessionId, name: s.name, project: s.project, key, start, end, work, running: !!s.live && b.end >= now - 60000 && end === b.end });
      }
    }
  }
  for (const list of out.values()) list.sort((a, b) => a.start - b.start || b.end - a.end);
  return out;
}

// 重なるまとまりを横に並べる。重なりがつながっている間は同じ組とし、組の中で空いている列に入れる。
// minMs: 画面で最低限とる高さに当たる時間（短いまとまりの文字が下と重ならないように）
// → 各まとまりに col（何列目か）と cols（その組の列の数）を足したもの
export function layout(pieces, minMs = 0) {
  const vis = p => Math.max(p.end, p.start + minMs);
  const out = [];
  let group = [], cols = [], groupEnd = -Infinity;
  const close = () => { for (const p of group) p.cols = cols.length; group = []; cols = []; };
  for (const src of [...pieces].sort((a, b) => a.start - b.start || vis(b) - vis(a))) {
    const p = { ...src };
    if (p.start >= groupEnd) { close(); groupEnd = -Infinity; }
    let c = cols.findIndex(end => end <= p.start);
    if (c < 0) { c = cols.length; cols.push(0); }
    cols[c] = vis(p);
    p.col = c;
    group.push(p); out.push(p);
    groupEnd = Math.max(groupEnd, vis(p));
  }
  close();
  return out;
}

// 時刻の目盛りの範囲 [始まりの時, 終わりの時]。now を渡すと今の時刻も入れる。
// 何も無ければ 9〜18時。少なくとも8時間は見せる
export function hourRange(pieces, now = null) {
  let lo = Infinity, hi = -Infinity;
  const at = (t, d) => (t - d) / H;
  for (const p of pieces) {
    const d = startOfDay(p.start);
    lo = Math.min(lo, at(p.start, d)); hi = Math.max(hi, at(p.end, d));
  }
  if (now != null) { const h = at(now, startOfDay(now)); lo = Math.min(lo, h); hi = Math.max(hi, h); }
  if (lo > hi) return [9, 18];
  lo = Math.max(0, Math.floor(lo)); hi = Math.min(24, Math.ceil(hi));
  while (hi - lo < 8) { if (hi < 24) hi++; else lo--; } // 足りない分は先の時刻へ広げる
  return [lo, hi];
}

// まとまりのうち Claude が作業していた時間
export const workOf = p => p.work.reduce((n, [s, e]) => n + e - s, 0);

// 月の1日分: セッションごとにまとめて最初に動いた順に並べ、作業していた時間の合計を添える
export function daySummary(pieces) {
  const by = new Map();
  let work = 0;
  for (const p of pieces) {
    const w = workOf(p);
    work += w;
    let x = by.get(p.sessionId);
    if (!x) by.set(p.sessionId, x = { sessionId: p.sessionId, name: p.name, project: p.project, key: p.key, start: p.start, end: p.end, work: 0, running: false });
    x.end = Math.max(x.end, p.end); x.work += w; x.running ||= p.running;
  }
  return { work, sessions: [...by.values()].sort((a, b) => a.start - b.start) };
}

// 期間に出てくるプロジェクト（最初に動いた順）
export function projectsIn(sessions) {
  const seen = new Map();
  for (const s of sessions) { const key = projectKey(s); if (!seen.has(key)) seen.set(key, { key, name: s.project || '不明' }); }
  return [...seen.values()];
}

// プロジェクトの色の番号（app.css の --cal-0〜7）。鍵から決まる番号を使い、
// 同じ画面のほかのプロジェクトと重なったら次の空きへずらす（並べた順に決める）
export const PALETTE_SIZE = 8;
export function colorSlots(keys, n = PALETTE_SIZE) {
  const out = new Map(), used = new Set();
  for (const k of keys) {
    if (out.has(k)) continue;
    let c = Math.floor(hash(k, 41) * n);
    for (let i = 0; i < n && used.has(c); i++) c = (c + 1) % n;
    used.add(c); out.set(k, c);
  }
  return out;
}

// 時間の長さを「2時間10分」「45分」の形にする
export function durText(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return '1分未満';
  if (m < 60) return `${m}分`;
  return `${Math.floor(m / 60)}時間${m % 60 ? `${m % 60}分` : ''}`;
}
