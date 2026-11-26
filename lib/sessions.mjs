// 稼働中セッション（~/.claude/sessions）と会話記録の索引を合わせて、表示用の状態を組み立てる
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { CLAUDE_DIR, PROJECTS_DIR, projectDirFor, summarize } from './transcripts.mjs';

export { CLAUDE_DIR, PROJECTS_DIR };
export const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
export const STATE_DIR = path.join(os.homedir(), '.claude-dashboard');
export const HOOK_EVENTS_DIR = path.join(STATE_DIR, 'events');
const HOST_IDS_FILE = path.join(STATE_DIR, 'host-ids.json');

const STALL_MS = 3 * 60 * 1000; // busy なのに3分記録が増えない → 停滞

// PID が生きていて、かつ記録された起動時刻と一致するか（異常終了後に PID が別のプロセスへ再利用された場合を除く）
const aliveCache = new Map(); // pid → { procStart, ok }
function isAlive(pid, procStart) {
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') { aliveCache.delete(pid); return false; } }
  if (!procStart) return true;
  const c = aliveCache.get(pid);
  if (c && c.procStart === procStart) return c.ok;
  let ok = true;
  try {
    const lstart = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000, env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } }); // procStart は UTC で記録されている
    const norm = s => String(s).trim().replace(/\s+/g, ' ');
    if (lstart.trim()) ok = norm(lstart) === norm(procStart);
  } catch { /* ps が使えなければ PID の生存だけで判断する */ }
  aliveCache.set(pid, { procStart, ok });
  return ok;
}

// デスクトップアプリのセッションID（local_…）は終了後に分からなくなるので覚えておく
let hostIds = {};
try { hostIds = JSON.parse(fs.readFileSync(HOST_IDS_FILE, 'utf8')); } catch {}
function rememberHostId(sessionId, hostId) {
  if (!hostId || hostIds[sessionId] === hostId) return;
  hostIds[sessionId] = hostId;
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(HOST_IDS_FILE, JSON.stringify(hostIds)); } catch {}
}
// デスクトップアプリ自身のセッション記録（cliSessionId → local_… / タイトル / アーカイブ）を読む
const APP_SESSIONS_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
let appSessions = new Map();
let appSessionsAt = 0;
export async function loadAppSessions() {
  if (Date.now() - appSessionsAt < 60000) return appSessions;
  appSessionsAt = Date.now();
  const next = new Map();
  const walk = async (dir, depth) => {
    let ents = [];
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) await walk(p, depth + 1);
      else if (e.isFile() && /^local_.*\.json$/.test(e.name)) {
        try {
          const d = JSON.parse(await fsp.readFile(p, 'utf8'));
          const info = { hostId: d.sessionId, title: d.title || null, archived: !!d.isArchived };
          for (const id of [d.cliSessionId, ...(d.priorCliSessionIds || [])]) if (id && !next.has(id)) next.set(id, info);
        } catch {}
      }
    }
  };
  await walk(APP_SESSIONS_DIR, 0);
  appSessions = next;
  return appSessions;
}
export function appSessionFor(sessionId) { return appSessions.get(sessionId) || null; }
export function hostIdFor(sessionId) { return appSessions.get(sessionId)?.hostId || hostIds[sessionId] || null; }

// --- git の未コミット変更（cwd ごとに 20 秒キャッシュ） ---
const gitCache = new Map();
export function gitStatus(cwd) {
  const c = gitCache.get(cwd);
  if (c && Date.now() - c.at < 20000) return c.value;
  const p = new Promise(resolve => {
    if (!cwd || !fs.existsSync(cwd)) return resolve(null);
    execFile('git', ['-C', cwd, 'status', '--porcelain=v1', '-b'], { timeout: 4000 }, (err, stdout) => {
      if (err) return resolve(/not a git repository/i.test(String(err.message) + stdout) ? { notRepo: true, changed: 0, ahead: 0 } : null);
      const lines = stdout.split('\n').filter(Boolean);
      const head = lines.shift() || '';
      const ahead = Number(head.match(/ahead (\d+)/)?.[1] || 0);
      resolve({ changed: lines.length, ahead });
    });
  });
  gitCache.set(cwd, { at: Date.now(), value: p });
  return p;
}

async function readHookEvents(sessionId) {
  const read = async name => {
    try { return JSON.parse(await fsp.readFile(path.join(HOOK_EVENTS_DIR, `${sessionId}.${name}.json`), 'utf8')); }
    catch { return null; }
  };
  const [notification, permissionRequest] = await Promise.all([read('notification'), read('permission')]);
  return { notification, permissionRequest };
}

export function deriveState(meta, tr, hook, now) {
  const lastAt = Math.max(tr?.lastActivityAt || 0, meta.statusUpdatedAt || 0);
  const n = hook?.notification;
  if (n && n.type !== 'idle_prompt' && n.at > (tr?.lastActivityAt || 0) - 1000 && meta.status !== 'idle') {
    return { key: 'waiting', label: '承認待ち', reason: n.message || '許可の確認が出ています', since: n.at };
  }
  const pr = hook?.permissionRequest;
  if (pr && pr.at > (tr?.lastActivityAt || 0) - 1000 && meta.status !== 'idle') {
    return { key: 'waiting', label: '承認待ち', reason: pr.tool ? `${pr.tool} の実行許可` : '許可の確認が出ています', since: pr.at };
  }
  if (meta.status === 'busy') {
    if (now - lastAt > STALL_MS) return { key: 'stalled', label: '停滞', reason: `${Math.round((now - lastAt) / 60000)}分動きがありません`, since: lastAt };
    const reason = tr?.pendingTool ? `${tr.pendingTool.name} ${tr.pendingTool.detail}`.trim() : '考え中';
    return { key: 'working', label: '作業中', reason, since: meta.statusUpdatedAt };
  }
  if (meta.status === 'idle') {
    if (tr?.lastRowKind === 'prompt') return { key: 'idle', label: '待機', reason: '応答なしで止まりました', since: lastAt };
    return { key: 'yours', label: 'あなたの番', reason: '返答済み', since: tr?.lastReplyAt || lastAt };
  }
  return { key: 'other', label: meta.status || '不明', reason: '', since: lastAt };
}

export function projectLabel(cwd) {
  if (!cwd) return { project: '不明', worktree: null };
  const m = cwd.match(/^(.*?)\/\.claude\/worktrees\/([^/]+)/);
  if (m) return { project: path.basename(m[1]), worktree: m[2] };
  if (cwd.includes('/scratch-workspaces/')) return { project: 'No folder', worktree: null };
  return { project: cwd.startsWith(os.homedir()) ? path.basename(cwd) : cwd, worktree: null };
}

// 「閉じてよい」の4条件。満たしていないものを返す
export function closeChecks(stateKey, git, tr) {
  const handoffFresh = !!(tr?.handoff && tr.handoff.at >= (tr.lastPromptAt || 0));
  return [
    { ok: stateKey !== 'waiting', label: '承認待ちではない' },
    { ok: stateKey !== 'working' && stateKey !== 'stalled', label: '裏で作業していない' },
    { ok: handoffFresh, label: '最新の依頼に対する引き継ぎ文がある' },
    { ok: !!git && git.changed === 0 && !git.ahead, label: git?.notRepo ? '未コミットの変更がない（Git 管理外）' : '未コミット・未プッシュの変更がない' },
  ];
}

export async function collectSessions(index, { includeSdk = false } = {}) {
  const now = Date.now();
  await loadAppSessions();
  let files = [];
  try { files = (await fsp.readdir(SESSIONS_DIR)).filter(f => f.endsWith('.json')); } catch { return []; }

  const metas = [];
  for (const f of files) {
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(SESSIONS_DIR, f), 'utf8'));
      if (!meta.sessionId || !meta.pid || !isAlive(meta.pid, meta.procStart)) continue;
      if (!includeSdk && String(meta.entrypoint || '').startsWith('sdk-')) continue;
      metas.push(meta);
    } catch { /* 書き込み途中 */ }
  }

  const results = await Promise.all(metas.map(async meta => {
    rememberHostId(meta.sessionId, meta.hostSessionId);
    const file = path.join(projectDirFor(meta.cwd), meta.sessionId + '.jsonl');
    const [acc, hook, git] = await Promise.all([index.update(file), readHookEvents(meta.sessionId), gitStatus(meta.cwd)]);
    const tr = summarize(acc);
    const state = deriveState(meta, tr, hook, now);
    const { project, worktree } = projectLabel(meta.cwd);
    const checks = closeChecks(state.key, git, tr);
    return {
      live: true,
      pid: meta.pid,
      sessionId: meta.sessionId,
      hostSessionId: meta.hostSessionId || null,
      name: meta.name || tr?.title || (tr?.firstPrompt || '').slice(0, 40) || '(無題)',
      cwd: meta.cwd, project, worktree,
      entrypoint: meta.entrypoint,
      startedAt: meta.startedAt,
      statusUpdatedAt: meta.statusUpdatedAt,
      state,
      lastActivityAt: Math.max(tr?.lastActivityAt || 0, meta.statusUpdatedAt || 0),
      firstPrompt: tr?.firstPrompt?.slice(0, 400) || null,
      lastPrompt: tr?.lastPrompt?.slice(0, 600) || null,
      lastPromptAt: tr?.lastPromptAt || null,
      lastReply: tr?.lastReply?.slice(0, 900) || null,
      lastReplyAt: tr?.lastReplyAt || null,
      recentTools: tr?.recentTools || [],
      skills: tr?.skills || [],
      handoff: tr?.handoff || null,
      gitBranch: tr?.gitBranch || null,
      git,
      model: tr?.model || null,
      promptCount: tr?.promptCount || 0,
      closeChecks: checks,
      closable: checks.every(c => c.ok),
    };
  }));

  const order = { waiting: 0, stalled: 1, yours: 2, working: 3, idle: 4, other: 5 };
  return results.sort((a, b) => (order[a.state.key] - order[b.state.key]) || (b.lastActivityAt - a.lastActivityAt));
}
