#!/usr/bin/env node
// Claude Code セッションダッシュボード（Node 標準機能のみ）
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TranscriptIndex, summarize, detail } from './lib/transcripts.mjs';
import { segmentsOf, blocksOf, peakConcurrency, weekStats } from './lib/review.mjs';
import { collectSessions, SESSIONS_DIR, PROJECTS_DIR, HOOK_EVENTS_DIR, STATE_DIR, CLAUDE_DIR, projectLabel, hostIdFor, appSessionFor, loadAppSessions, gitStatus } from './lib/sessions.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4317);
const HOST = '127.0.0.1'; // 外部には公開しない
let includeSdk = process.env.INCLUDE_SDK === '1';

const index = new TranscriptIndex();
const indexStatus = { ready: false, done: 0, total: 0 };

// ---------- 使用枠（statusline の入力から記録したもの） ----------
function readUsage() {
  try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'usage.json'), 'utf8')); } catch { return null; }
}
// settings.json にこのダッシュボードの登録があるか。install-*.mjs がコマンド末尾に付ける印で見分ける
// （印の無い以前の版の登録は、フォルダ名が claude-dashboard の場合だけ見分けられる）
function settingsMention(marks) {
  try {
    const text = fs.readFileSync(path.join(CLAUDE_DIR, 'settings.json'), 'utf8');
    return marks.some(m => text.includes(m));
  } catch { return false; }
}
const usageTapInstalled = () => settingsMention(['# claude-dashboard:statusline-tap', 'hooks/statusline-tap.mjs']);
async function apiUsage(url) {
  const days = Math.min(30, Number(url.searchParams.get('days') || 8));
  const since = Date.now() - days * 86400000;
  let rows = [];
  try {
    const text = await fsp.readFile(path.join(STATE_DIR, 'usage-history.jsonl'), 'utf8');
    for (const line of text.split('\n')) {
      if (!line) continue;
      try { const r = JSON.parse(line); if (r.at >= since) rows.push(r); } catch {}
    }
  } catch {}
  return { installed: usageTapInstalled(), current: readUsage(), history: rows };
}

const hooksInstalled = () => settingsMention(['# claude-dashboard:record', 'claude-dashboard/hooks/record.mjs']);

// ---------- ライブ状態の配信 ----------
const clients = new Set();
let lastJson = '';
let liveSessions = [];

async function snapshot() {
  liveSessions = await collectSessions(index, { includeSdk });
  return JSON.stringify({ generatedAt: Date.now(), hooksInstalled: hooksInstalled(), usage: readUsage(), usageTapInstalled: usageTapInstalled(), index: indexStatus, sessions: liveSessions });
}

let refreshing = false, again = false;
async function refresh() {
  if (refreshing) { again = true; return; }
  refreshing = true;
  try {
    const json = await snapshot();
    if (json.replace(/"generatedAt":\d+/, '') !== lastJson.replace(/"generatedAt":\d+/, '')) {
      lastJson = json;
      for (const res of clients) res.write(`data: ${json}\n\n`);
    }
  } catch (e) { console.error('refresh failed:', e.message); }
  finally {
    refreshing = false;
    if (again) { again = false; setTimeout(refresh, 50); }
  }
}

let debounce;
const kick = () => { clearTimeout(debounce); debounce = setTimeout(refresh, 250); };
for (const dir of [SESSIONS_DIR, HOOK_EVENTS_DIR]) {
  try { fs.mkdirSync(dir, { recursive: true }); fs.watch(dir, kick); } catch {}
}
try { fs.watch(STATE_DIR, (_, f) => { if (f === 'usage.json') kick(); }); } catch {}
try {
  fs.watch(PROJECTS_DIR, { recursive: true }, (_, f) => {
    if (!f || !f.endsWith('.jsonl') || f.includes('subagents')) return;
    if (indexStatus.ready) index.update(path.join(PROJECTS_DIR, f)).catch(() => {});
    kick();
  });
} catch {}
setInterval(refresh, 5000);

// ---------- 履歴・検索・台帳 ----------
// 履歴に出さないもの: Agent SDK から起動された自動処理と、claude-mem などのツールが裏で動かす観測用セッション
const isNoise = a => String(a.entrypoint || '').startsWith('sdk-') || (a.cwd || '').includes('/.claude-mem/');
const liveById = () => new Map(liveSessions.map(s => [s.sessionId, s]));

function historyItem(a, live) {
  const s = summarize(a);
  const { project, worktree } = projectLabel(s.cwd);
  const app = appSessionFor(s.sessionId);
  return {
    sessionId: s.sessionId,
    hostSessionId: live?.hostSessionId || hostIdFor(s.sessionId),
    name: live?.name || app?.title || s.title || (s.firstPrompt || '').split('\n')[0].slice(0, 60) || '(無題)',
    project, worktree, cwd: s.cwd, gitBranch: s.gitBranch,
    firstPromptAt: s.firstPromptAt, lastActivityAt: s.lastActivityAt,
    firstPrompt: s.firstPrompt?.slice(0, 300) || null,
    lastPrompt: s.lastPrompt?.slice(0, 300) || null,
    promptCount: s.promptCount, toolCount: s.toolCount, fileCount: s.fileCount, skills: s.skills,
    handoff: s.handoff, handoffStale: !!(s.handoff && s.lastPromptAt > s.handoff.at),
    archived: app?.archived ?? null,
    live: !!live, state: live?.state || null, closable: live?.closable ?? null, closeChecks: live?.closeChecks || null,
  };
}

function apiHistory(url) {
  const days = Math.min(90, Number(url.searchParams.get('days') || 14));
  const since = Date.now() - days * 86400000;
  const live = liveById();
  return index.all()
    .filter(a => !isNoise(a) && a.promptCount > 0 && a.lastActivityAt >= since)
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .map(a => historyItem(a, live.get(a.sessionId)));
}

function apiLedger() {
  const live = liveById();
  const since = Date.now() - 14 * 86400000;
  return index.all()
    .filter(a => !isNoise(a) && (live.has(a.sessionId) || (a.handoff && a.handoff.at >= since)))
    .map(a => historyItem(a, live.get(a.sessionId)))
    .sort((a, b) => (b.live - a.live) || ((b.handoff?.at || 0) - (a.handoff?.at || 0)));
}

function apiSearch(url) {
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/).filter(Boolean);
  const live = liveById();
  const hits = [];
  for (const a of index.all()) {
    if (isNoise(a)) continue;
    const head = `${a.title || ''}\n${a.cwd || ''}\n${a.gitBranch || ''}`.toLowerCase();
    const matched = [];
    for (const t of a.timeline) {
      if (t.kind === 'tool') continue;
      const lower = t.text.toLowerCase();
      // 少なくとも1語は本文に含まれていること（フォルダ名などにだけ含まれる語で全件一致させない）
      if (terms.some(term => lower.includes(term)) && terms.every(term => lower.includes(term) || head.includes(term))) {
        const pos = Math.max(0, lower.indexOf(terms.find(term => lower.includes(term)) ?? terms[0]));
        matched.push({ kind: t.kind, at: t.at, snippet: (pos > 40 ? '…' : '') + t.text.slice(Math.max(0, pos - 40), pos + 140) });
      }
    }
    if (!matched.length && !terms.every(term => head.includes(term))) continue;
    hits.push({ ...historyItem(a, live.get(a.sessionId)), matches: matched.slice(-3).reverse(), matchCount: matched.length });
  }
  return hits.sort((x, y) => y.lastActivityAt - x.lastActivityAt).slice(0, 60);
}

async function apiSession(url) {
  const id = url.searchParams.get('id') || '';
  const a = index.get(id);
  if (!a) return null;
  const live = liveById().get(id);
  const d = detail(a);
  return { ...historyItem(a, live), timeline: d.timeline, files: d.files, git: live?.git ?? await gitStatus(a.cwd), recentTools: d.recentTools, model: d.model };
}

// ---------- ふりかえり ----------
// from: 週のまとめの最終日の始まり（画面側の時刻で 0 時）。days: 週のまとめの日数
function apiReview(url) {
  const now = Date.now();
  const from = Number(url.searchParams.get('from')) || now - 86400000;
  const days = Math.min(30, Math.max(1, Number(url.searchParams.get('days') || 7)));
  const weekFrom = from - (days - 1) * 86400000;
  const live = liveById();
  const items = index.all()
    .filter(a => !isNoise(a) && a.promptCount > 0 && a.lastActivityAt >= weekFrom)
    .map(a => {
      const l = live.get(a.sessionId);
      const h = historyItem(a, l);
      return { sessionId: a.sessionId, name: h.name, project: h.project, timeline: a.timeline, live: l?.state?.key || null };
    });
  return { week: weekStats(items, { from: weekFrom, to: now }) };
}

// カレンダー: 期間内にセッションが動いていたひとまとまり。from / to は画面側の日の区切り（最長で約6週間）
const CAL_MAX_MS = 45 * 86400000;
function apiCalendar(url) {
  const now = Date.now();
  const to = Math.min(Number(url.searchParams.get('to')) || now, now);
  const from = Math.max(Number(url.searchParams.get('from')) || to - 86400000, to - CAL_MAX_MS);
  const live = liveById();
  const sessions = [];
  for (const a of index.all()) {
    if (isNoise(a) || !a.promptCount || a.lastActivityAt < from || a.firstPromptAt > to) continue;
    const l = live.get(a.sessionId);
    const segs = segmentsOf(a.timeline, { from, to, live: l?.state?.key || null });
    const blocks = blocksOf(segs);
    if (!blocks.length) continue;
    const h = historyItem(a, l);
    sessions.push({ sessionId: a.sessionId, name: h.name, project: h.project, cwd: h.cwd, live: !!l, segs, blocks });
  }
  sessions.sort((x, y) => x.blocks[0].start - y.blocks[0].start);
  const work = sessions.reduce((n, s) => n + s.blocks.reduce((m, b) => m + b.work.reduce((k, [ws, we]) => k + we - ws, 0), 0), 0);
  const peak = peakConcurrency(sessions.map(s => s.segs));
  for (const s of sessions) delete s.segs;
  return { from, to, now, work, peak, sessions };
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const sendJson = (res, body, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };

const server = http.createServer(async (req, res) => {
  // DNS rebinding 対策: localhost 以外の Host は拒否（URL を組み立てる前に確かめる）
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '')) { res.writeHead(403); return res.end(); }
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end(); }
  try {
    switch (url.pathname) {
      case '/api/state':
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(lastJson || await snapshot());
      case '/api/events': {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(`data: ${lastJson || await snapshot()}\n\n`);
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 20000);
        req.on('close', () => { clients.delete(res); clearInterval(ping); });
        return;
      }
      case '/api/history': return sendJson(res, { index: indexStatus, sessions: apiHistory(url) });
      case '/api/usage': return sendJson(res, await apiUsage(url));
      case '/api/ledger': return sendJson(res, { index: indexStatus, sessions: apiLedger() });
      case '/api/search': return sendJson(res, { index: indexStatus, sessions: apiSearch(url) });
      case '/api/review': return sendJson(res, { index: indexStatus, ...apiReview(url) });
      case '/api/calendar': return sendJson(res, { index: indexStatus, ...apiCalendar(url) });
      case '/api/session': {
        const s = await apiSession(url);
        return s ? sendJson(res, s) : sendJson(res, { error: 'not found' }, 404);
      }
    }
  } catch (e) {
    console.error(e);
    return sendJson(res, { error: e.message }, 500);
  }

  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const publicDir = path.join(ROOT, 'public');
  const file = path.join(publicDir, path.normalize(rel));
  const inside = path.relative(publicDir, file);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) { res.writeHead(403); return res.end(); }
  try {
    const body = await fsp.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});

server.listen(PORT, HOST, async () => {
  console.log(`Claude dashboard: http://localhost:${PORT}`);
  await refresh();
  const t = Date.now();
  await index.scanAll((done, total) => { indexStatus.done = done; indexStatus.total = total; });
  indexStatus.ready = true;
  console.log(`indexed ${index.all().length} sessions in ${Date.now() - t}ms`);
  lastJson = '';
  refresh();
});
