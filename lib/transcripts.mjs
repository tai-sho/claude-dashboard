// ~/.claude/projects 配下の会話記録（jsonl）を差分で読み、セッションごとの要約を保持する索引
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

const TEXT_CAP = 1200;      // 検索・表示用に保持する1件あたりの文字数
const TIMELINE_CAP = 600;   // 1セッションで保持するタイムライン件数
const BEAT_CAP = 80;        // 心電図用に保持する直近の動きの件数
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const HANDOFF_TOOL = /__wrap_up$/; // デスクトップアプリの wrap_up の recap を引き継ぎ文として使う

// cwd → projects 配下のディレクトリ名
export function projectDirFor(cwd) {
  return path.join(PROJECTS_DIR, cwd.replace(/[^A-Za-z0-9-]/g, '-'));
}

// ---------- 行の解釈 ----------
export function humanPromptText(row) {
  if (row.type !== 'user' || row.isMeta || row.isSidechain) return null;
  const c = row.message?.content;
  let text = null;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    if (c.some(x => x.type === 'tool_result')) return null;
    text = c.filter(x => x.type === 'text').map(x => x.text).join('\n');
  }
  if (!text) return null;
  text = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<(command-name|command-message|command-args|local-command-stdout|local-command-caveat)>[\s\S]*?<\/\1>/g, m => {
      const name = m.match(/<command-name>([\s\S]*?)<\/command-name>/);
      return name ? name[1] + ' ' : '';
    })
    .replace(/<([a-z_-]+-event|cross-session-message|task-notification)[^>]*>[\s\S]*?<\/\1>/g, '')
    .trim();
  if (!text || text.startsWith('Caveat:') || text.startsWith('[Request interrupted')) return null;
  return text;
}

function assistantText(row) {
  const c = row.message?.content;
  if (!Array.isArray(c)) return null;
  const t = c.filter(x => x.type === 'text').map(x => x.text).join('\n').trim();
  return t || null;
}

export function describeTool(t) {
  const i = t.input || {};
  const name = t.name.replace(/^mcp__.*?__/, 'mcp:');
  const detail = i.description || i.command || i.file_path || i.notebook_path || i.pattern || i.url || i.query || i.skill || i.prompt || '';
  return { name, detail: String(detail).split('\n')[0].slice(0, 160) };
}

const cap = (s, n = TEXT_CAP) => (s && s.length > n ? s.slice(0, n) + '…' : s);

// ---------- 1 セッション分の積み上げ ----------
function emptyAcc(file) {
  return {
    file, sessionId: path.basename(file, '.jsonl'), offset: 0, partial: null, mtimeMs: 0,
    cwd: null, gitBranch: null, model: null, title: null, entrypoint: null,
    firstPrompt: null, firstPromptAt: null, lastPrompt: null, lastPromptAt: null,
    lastReply: null, lastReplyAt: null, lastActivityAt: null, lastRowKind: null,
    promptCount: 0, toolCount: 0,
    pendingTools: new Map(), recentTools: [], beats: [],
    timeline: [], files: new Map(), skills: new Map(),
    handoff: null, // { text, at }
  };
}

function pushTimeline(acc, item) {
  acc.timeline.push(item);
  if (acc.timeline.length > TIMELINE_CAP) {
    // 依頼は残し、古いツール行から捨てる
    const i = acc.timeline.findIndex(x => x.kind === 'tool');
    acc.timeline.splice(i >= 0 ? i : 0, 1);
  }
}

// 心電図用の動き。[時刻, 種類] 種類は p: 依頼 / r: 返答 / t: ツール
function pushBeat(acc, at, kind) {
  if (!at) return;
  acc.beats.push([at, kind]);
  if (acc.beats.length > BEAT_CAP) acc.beats.shift();
}

function reduceRow(acc, r) {
  const ts = r.timestamp ? Date.parse(r.timestamp) : null;
  if (r.type === 'custom-title' && r.customTitle) { acc.title = r.customTitle; return; }
  if (r.isSidechain) return;
  if (r.type !== 'user' && r.type !== 'assistant') return;
  if (r.cwd) acc.cwd = r.cwd;
  if (r.gitBranch) acc.gitBranch = r.gitBranch;
  if (r.entrypoint) acc.entrypoint = r.entrypoint;
  if (ts) acc.lastActivityAt = ts;

  if (r.type === 'user') {
    const p = humanPromptText(r);
    if (p) {
      if (!acc.firstPrompt) { acc.firstPrompt = cap(p); acc.firstPromptAt = ts; }
      acc.lastPrompt = cap(p); acc.lastPromptAt = ts; acc.promptCount++; acc.lastRowKind = 'prompt';
      acc.pendingTools.clear();
      pushTimeline(acc, { kind: 'prompt', at: ts, text: cap(p) });
      pushBeat(acc, ts, 'p');
    } else if (Array.isArray(r.message?.content)) {
      for (const x of r.message.content) if (x.type === 'tool_result') acc.pendingTools.delete(x.tool_use_id);
    }
    return;
  }

  // assistant
  if (r.message?.model && r.message.model !== '<synthetic>') acc.model = r.message.model;
  const a = assistantText(r);
  if (a) {
    acc.lastReply = cap(a); acc.lastReplyAt = ts; acc.lastRowKind = 'reply';
    pushBeat(acc, ts, 'r');
    const last = acc.timeline.at(-1);
    if (last?.kind === 'reply' && ts - last.at < 2000) last.text = cap(last.text + '\n' + a);
    else pushTimeline(acc, { kind: 'reply', at: ts, text: cap(a) });
  }
  const c = r.message?.content;
  if (!Array.isArray(c)) return;
  for (const t of c) {
    if (t.type !== 'tool_use') continue;
    const d = { ...describeTool(t), at: ts };
    acc.toolCount++;
    acc.pendingTools.set(t.id, d);
    acc.recentTools.push(d);
    if (acc.recentTools.length > 8) acc.recentTools.shift();
    acc.lastRowKind = 'tool';
    pushBeat(acc, ts, 't');
    const fp = t.input?.file_path || t.input?.notebook_path;
    if (FILE_TOOLS.has(t.name) && fp) {
      const f = acc.files.get(fp) || { edits: 0, at: 0 };
      f.edits++; if (ts) f.at = ts;
      acc.files.delete(fp); acc.files.set(fp, f); // 最後に触った順に並べておく
    }
    if (t.name === 'Skill' && t.input?.skill) acc.skills.set(t.input.skill, ts);
    if (HANDOFF_TOOL.test(t.name) && t.input?.recap) {
      acc.handoff = { text: String(t.input.recap), at: ts, ask: t.input.ask || null };
      pushTimeline(acc, { kind: 'handoff', at: ts, text: String(t.input.recap) });
    } else {
      pushTimeline(acc, { kind: 'tool', at: ts, text: `${d.name} ${d.detail}`.trim() });
    }
  }
}

// ---------- 索引 ----------
export class TranscriptIndex {
  constructor() { this.byFile = new Map(); this.bySession = new Map(); this.locks = new Map(); }

  // 1ファイルを差分で読み進める。同じファイルへの読み込みは1本ずつ順に行う
  // （fs.watch・定期更新・全件走査が重なると、読んだ位置を二重に進めてしまうため）
  update(file) {
    const prev = this.locks.get(file) || Promise.resolve();
    const run = prev.then(() => this.#updateOnce(file));
    const tail = run.catch(() => {});
    this.locks.set(file, tail);
    tail.then(() => { if (this.locks.get(file) === tail) this.locks.delete(file); });
    return run;
  }

  async #updateOnce(file) {
    let st;
    try { st = await fsp.stat(file); } catch { return this.byFile.get(file) || null; }
    let acc = this.byFile.get(file);
    if (!acc || st.size < acc.offset) acc = emptyAcc(file);
    if (st.size > acc.offset) {
      const fh = await fsp.open(file, 'r');
      try {
        const CHUNK = 4 * 1024 * 1024;
        while (acc.offset < st.size) {
          const len = Math.min(CHUNK, st.size - acc.offset);
          const buf = Buffer.alloc(len);
          const { bytesRead } = await fh.read(buf, 0, len, acc.offset);
          if (!bytesRead) break;
          acc.offset += bytesRead;
          const merged = acc.partial ? Buffer.concat([acc.partial, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
          const lastNl = merged.lastIndexOf(0x0a);
          if (lastNl < 0) { acc.partial = Buffer.from(merged); continue; }
          acc.partial = lastNl + 1 < merged.length ? Buffer.from(merged.subarray(lastNl + 1)) : null;
          for (const line of merged.subarray(0, lastNl).toString('utf8').split('\n')) {
            // user / assistant / custom-title 以外の巨大な行はパースしない
            if (!line || !(line.includes('"type":"user"') || line.includes('"type":"assistant"') || line.includes('"custom-title"'))) continue;
            let r; try { r = JSON.parse(line); } catch { continue; }
            reduceRow(acc, r);
          }
        }
      } finally { await fh.close(); }
    }
    acc.mtimeMs = st.mtimeMs;
    if (!acc.lastActivityAt) acc.lastActivityAt = st.mtimeMs;
    this.byFile.set(file, acc);
    this.bySession.set(acc.sessionId, acc);
    return acc;
  }

  // projects 配下を全部なめる（初回は数十秒かかる）。onProgress(done, total)
  async scanAll(onProgress) {
    const files = [];
    let dirs = [];
    try { dirs = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true }); } catch { return; }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      let names = [];
      try { names = await fsp.readdir(path.join(PROJECTS_DIR, d.name)); } catch { continue; }
      for (const n of names) if (n.endsWith('.jsonl')) files.push(path.join(PROJECTS_DIR, d.name, n));
    }
    let done = 0;
    for (const f of files) {
      await this.update(f);
      done++;
      if (onProgress && done % 25 === 0) onProgress(done, files.length);
      if (done % 10 === 0) await new Promise(r => setImmediate(r)); // ライブ更新を止めない
    }
    onProgress?.(done, files.length);
  }

  get(sessionId) { return this.bySession.get(sessionId) || null; }
  all() { return [...this.bySession.values()]; }
}

// 外へ出す要約（タイムラインなどの重いものは含めない）
export function summarize(acc) {
  if (!acc) return null;
  return {
    sessionId: acc.sessionId, cwd: acc.cwd, gitBranch: acc.gitBranch, model: acc.model, title: acc.title,
    entrypoint: acc.entrypoint,
    firstPrompt: acc.firstPrompt, firstPromptAt: acc.firstPromptAt,
    lastPrompt: acc.lastPrompt, lastPromptAt: acc.lastPromptAt,
    lastReply: acc.lastReply, lastReplyAt: acc.lastReplyAt,
    lastActivityAt: acc.lastActivityAt, lastRowKind: acc.lastRowKind,
    promptCount: acc.promptCount, toolCount: acc.toolCount,
    pendingTool: [...acc.pendingTools.values()].at(-1) || null,
    recentTools: acc.recentTools.slice(-6).reverse(),
    skills: [...acc.skills.keys()].slice(-6),
    fileCount: acc.files.size,
    handoff: acc.handoff,
    beats: acc.beats.slice(),
    recentFiles: [...acc.files.entries()].slice(-12).reverse().map(([p, f]) => ({ path: p, edits: f.edits, at: f.at })),
  };
}

export function detail(acc) {
  if (!acc) return null;
  return {
    ...summarize(acc),
    timeline: acc.timeline,
    files: [...acc.files.entries()].map(([p, f]) => ({ path: p, edits: f.edits })).sort((a, b) => b.edits - a.edits),
  };
}
