// ふりかえり用の集計。会話記録のタイムラインから「Claude が作業していた区間」と「あなたの番だった区間」を組み立てる
const TURN_CAP_MS = 8 * 60 * 60 * 1000; // これより長く返事をしなかった区間は「寝かせていた」とみなして描かない

// タイムライン → [[開始, 終了, 'w' | 't'], ...]（w: 作業中 / t: あなたの番）
// live: 稼働中セッションの状態キー（最後の区間を今まで伸ばすのに使う）
export function segmentsOf(timeline, { from = 0, to = Date.now(), live = null } = {}) {
  const segs = [];
  let workStart = null, lastAt = null;
  const push = (a, b, k) => {
    const s = Math.max(a, from), e = Math.min(b, to);
    if (e > s) segs.push([s, e, k]);
  };
  for (const t of timeline) {
    if (!t.at) continue;
    if (t.kind === 'prompt') {
      if (workStart != null) {
        push(workStart, lastAt, 'w');
        if (t.at - lastAt < TURN_CAP_MS) push(lastAt, t.at, 't');
      }
      workStart = t.at;
    } else if (workStart == null) {
      continue; // 依頼より前の行（再開直後など）は数えない
    }
    lastAt = t.at;
  }
  if (workStart != null) {
    if (live === 'working' || live === 'stalled' || live === 'waiting') push(workStart, to, 'w');
    else {
      push(workStart, lastAt, 'w');
      if (live === 'yours' && to - lastAt < TURN_CAP_MS) push(lastAt, to, 't');
    }
  }
  // 1分未満の隙間でつながる同じ種類の区間はまとめる
  const out = [];
  for (const s of segs) {
    const p = out.at(-1);
    if (p && p[2] === s[2] && s[0] - p[1] < 60000) p[1] = Math.max(p[1], s[1]);
    else out.push([...s]);
  }
  return out;
}

// 区間の集まりから、同時に作業していた本数の最大とその時刻
export function peakConcurrency(segLists) {
  const ev = [];
  for (const segs of segLists) for (const [s, e, k] of segs) if (k === 'w') ev.push([s, 1], [e, -1]);
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, peak = 0, at = null;
  for (const [t, d] of ev) { cur += d; if (cur > peak) { peak = cur; at = t; } }
  return { peak, at };
}

const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));
const inc = (map, k, by = 1) => map.set(k, (map.get(k) || 0) + by);

// 期間内の集計。items: [{ sessionId, name, project, timeline, live }]
export function weekStats(items, { from, to = Date.now() }) {
  const tools = new Map(), skills = new Map(), projects = new Map(), days = new Map();
  const hours = Array.from({ length: 7 }, () => new Array(24).fill(0)); // [曜日][時]
  let prompts = 0, toolCalls = 0, edits = 0, sessions = 0;
  let longest = null;
  const segLists = [];
  for (const it of items) {
    let touched = false;
    for (const t of it.timeline) {
      if (!t.at || t.at < from || t.at > to) continue;
      touched = true;
      if (t.kind === 'prompt') {
        prompts++;
        inc(projects, it.project || '不明');
        const d = new Date(t.at);
        hours[d.getDay()][d.getHours()]++;
        inc(days, d.toLocaleDateString('sv-SE'));
      } else if (t.kind === 'tool') {
        toolCalls++;
        const [name, ...rest] = t.text.split(' ');
        inc(tools, name);
        if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) edits++;
        if (name === 'Skill' && rest[0]) inc(skills, rest[0]);
      }
    }
    if (!touched) continue;
    sessions++;
    const segs = segmentsOf(it.timeline, { from, to, live: it.live });
    segLists.push(segs);
    for (const [s, e, k] of segs) {
      if (k === 'w' && (!longest || e - s > longest.ms)) longest = { ms: e - s, at: s, name: it.name, sessionId: it.sessionId };
    }
  }
  const busiest = top(days, 1)[0] || null;
  return {
    from, to, sessions, prompts, toolCalls, edits,
    peak: peakConcurrency(segLists), longest,
    busiestDay: busiest ? { day: busiest.name, prompts: busiest.count } : null,
    tools: top(tools, 6), skills: top(skills, 5), projects: top(projects, 5), hours,
  };
}
