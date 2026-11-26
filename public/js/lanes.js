// セッションを盤面のどこに置くか。DOM に触らないので、node:test から直接読み込んで確かめられる。
import { rootOf } from './format.js';

export const REST_AFTER_MS = 8 * 60 * 60 * 1000; // 8時間触っていない「あなたの番」は寝かせる扱い

// you: あなたを待っている、work: Claude が作業中、rest: 寝かせている
// acks: セッションごとに「確認した」を押したときの返答の時刻
export function laneFor(s, acks, now) {
  const k = s.state.key;
  if (k === 'waiting' || k === 'stalled') return 'you';
  if (k === 'working') return 'work';
  if (k === 'yours') {
    if (acks[s.sessionId] && acks[s.sessionId] >= (s.lastReplyAt || 0)) return 'rest';
    if (now - s.lastActivityAt > REST_AFTER_MS) return 'rest';
    return 'you';
  }
  return 'rest';
}
// 今の状態になった時刻（待ち時間の起点）
export const since = s => s.state.since || s.lastActivityAt;

// 列ごとに分けて並べる。待っている列は承認や確認を求めているものを先に、その中は長く待たせている順
export function sortLanes(sessions, laneOf) {
  const lanes = { you: [], work: [], rest: [] };
  for (const s of sessions) lanes[laneOf(s)].push(s);
  lanes.you.sort((a, b) => ((a.state.key === 'yours') - (b.state.key === 'yours')) || since(a) - since(b));
  lanes.rest.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return lanes;
}

// プロジェクト別: 呼ばれている度合いの高いプロジェクトを上に。
// 表示名（フォルダ名）が同じでも別のリポジトリは分け、見出しに親フォルダ名を添える。worktree は元のリポジトリにまとめる
export function groupByProject(lanes) {
  const groups = new Map();
  const at = s => {
    const root = s.cwd && s.project !== 'No folder' ? rootOf(s.cwd) : '', key = root || s.project || '不明';
    if (!groups.has(key)) groups.set(key, { name: s.project || '不明', root, you: [], work: [], rest: [], calls: 0, last: 0 });
    return groups.get(key);
  };
  for (const lane of ['you', 'work', 'rest']) {
    for (const s of lanes[lane]) {
      const g = at(s);
      g[lane].push(s);
      if (lane === 'you' && s.state.key !== 'yours') g.calls++;
      g.last = Math.max(g.last, s.lastActivityAt || 0);
    }
  }
  const rank = g => (g.calls ? 0 : g.you.length ? 1 : g.work.length ? 2 : 3);
  const list = [...groups.values()].sort((a, b) => rank(a) - rank(b) || b.last - a.last);
  const named = {};
  for (const g of list) named[g.name] = (named[g.name] || 0) + 1;
  for (const g of list) {
    const parent = g.root.split('/').slice(-2, -1)[0];
    g.rank = rank(g);
    g.label = named[g.name] > 1 && parent ? `${g.name}（${parent}）` : g.name;
  }
  return list;
}
