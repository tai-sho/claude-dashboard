// server.mjs を合成データで起動し、HTTP の振る舞いを確かめる
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { sandboxEnv, freePort, row, jsonl, ROOT } from './helpers.mjs';

const sb = sandboxEnv();
let port, child;

function request(pathname, { host } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, headers: { host: host ?? `localhost:${port}` } }, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}
const getJson = async p => { const r = await request(p); return { ...r, json: JSON.parse(r.body) }; };

before(async () => {
  const now = Date.now();
  const cwd = path.join(sb.base, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const projDir = path.join(sb.claude, 'projects', cwd.replace(/[^A-Za-z0-9-]/g, '-'));
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 'live-1.jsonl'), jsonl([
    row.prompt('グラフの色を直して', now - 60000, { cwd, gitBranch: 'main' }),
    row.reply('色を <b>修正</b> しました', now - 30000),
  ]));
  fs.writeFileSync(path.join(projDir, 'old-1.jsonl'), jsonl([
    row.prompt('READMEを書いて', now - 3600000, { cwd }),
    row.reply('書きました', now - 3500000),
  ]));
  // 履歴に出さない: SDK 起動のセッション
  fs.writeFileSync(path.join(projDir, 'sdk-1.jsonl'), jsonl([row.prompt('グラフ 自動処理', now - 1000, { cwd, entrypoint: 'sdk-ts' })]));
  fs.writeFileSync(path.join(sb.claude, 'sessions', 'live.json'), JSON.stringify({ pid: process.pid, sessionId: 'live-1', cwd, status: 'idle', statusUpdatedAt: now - 30000 }));

  port = await freePort();
  child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  // 索引ができるまで待つ
  for (let i = 0; i < 100; i++) {
    try { if ((await getJson('/api/history')).json.index.ready) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`server did not become ready (exit ${child.exitCode})\n${stderr}`);
});

after(() => { child?.kill(); sb.cleanup(); });

describe('Host ヘッダーの検査', () => {
  test('localhost / 127.0.0.1 は通す', async () => {
    assert.equal((await request('/api/history')).status, 200);
    assert.equal((await request('/api/history', { host: `127.0.0.1:${port}` })).status, 200);
  });

  test('それ以外の Host は 403', async () => {
    assert.equal((await request('/api/history', { host: 'evil.example' })).status, 403);
    assert.equal((await request('/api/history', { host: 'localhost.evil.example' })).status, 403);
  });

  test('Host ヘッダーが無いリクエストも 403', async () => {
    const res = await new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1', () => sock.write('GET / HTTP/1.0\r\n\r\n'));
      let buf = '';
      sock.on('data', d => { buf += d; });
      sock.on('end', () => resolve(buf));
      sock.on('error', reject);
    });
    assert.match(res, /^HTTP\/1\.[01] 403/);
  });
});

describe('静的ファイル', () => {
  test('/ は index.html を返す', async () => {
    const r = await request('/');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/html/);
  });

  test('public の外は読めない', async () => {
    for (const p of ['/../server.mjs', '/%2e%2e/server.mjs', '/..%2fserver.mjs', '/%2e%2e%2fpackage.json']) {
      const r = await request(p);
      assert.notEqual(r.status, 200, p);
      assert.ok(!r.body.includes('createServer'), p);
    }
  });

  test('無いファイルは 404', async () => {
    assert.equal((await request('/nope.js')).status, 404);
  });
});

describe('API', () => {
  test('/api/state は稼働中のセッションを返す', async () => {
    const { status, json } = await getJson('/api/state');
    assert.equal(status, 200);
    assert.equal(json.hooksInstalled, false);
    assert.deepEqual(json.sessions.map(s => [s.sessionId, s.state.key]), [['live-1', 'yours']]);
  });

  test('/api/history は会話のあるセッションを新しい順に返し、SDK 起動を除く', async () => {
    const { json } = await getJson('/api/history');
    assert.deepEqual(json.sessions.map(s => s.sessionId), ['live-1', 'old-1']);
    assert.equal(json.sessions[0].live, true);
    assert.equal(json.sessions[1].live, false);
  });

  test('/api/search は本文に一致したセッションを返す', async () => {
    const { json } = await getJson('/api/search?q=' + encodeURIComponent('グラフ'));
    assert.deepEqual(json.sessions.map(s => s.sessionId), ['live-1']);
    assert.ok(json.sessions[0].matches[0].snippet.includes('グラフ'));
  });

  test('/api/search はフォルダ名にだけ含まれる語では本文を一致扱いにしない', async () => {
    const { json } = await getJson('/api/search?q=' + encodeURIComponent('work README'));
    assert.deepEqual(json.sessions.map(s => s.sessionId), ['old-1']);
    assert.equal(json.sessions[0].matchCount, 1);
  });

  test('/api/search は空の検索語で空配列', async () => {
    assert.deepEqual((await getJson('/api/search?q=%20')).json.sessions, []);
  });

  test('/api/session は詳細を返し、無い ID は 404', async () => {
    const ok = await getJson('/api/session?id=old-1');
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.timeline.map(t => t.kind), ['prompt', 'reply']);
    assert.equal((await request('/api/session?id=missing')).status, 404);
  });

  test('/api/usage は記録が無ければ空', async () => {
    const { json } = await getJson('/api/usage');
    assert.deepEqual(json, { installed: false, current: null, history: [] });
  });
});
