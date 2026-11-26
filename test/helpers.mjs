// テスト共通の道具。実際の ~/.claude や ~/.claude-dashboard には触れず、一時ディレクトリに合成データを作る。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// HOME と CLAUDE_CONFIG_DIR を一時ディレクトリに向ける。モジュールを import する前に呼ぶこと
export function sandboxEnv() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-dashboard-test-')));
  const home = path.join(base, 'home');
  const claude = path.join(base, 'claude');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(claude, 'projects'), { recursive: true });
  fs.mkdirSync(path.join(claude, 'sessions'), { recursive: true });
  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = claude;
  process.env.GIT_CEILING_DIRECTORIES = base; // 一時ディレクトリが Git 管理下にあっても、その外のリポジトリを見に行かない
  return { base, home, claude, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

export const iso = ms => new Date(ms).toISOString();

// 会話記録の1行を作る
export const row = {
  prompt: (text, at, extra = {}) => ({ type: 'user', timestamp: iso(at), message: { role: 'user', content: text }, ...extra }),
  reply: (text, at, extra = {}) => ({ type: 'assistant', timestamp: iso(at), message: { model: 'claude-test', content: [{ type: 'text', text }] }, ...extra }),
  tool: (id, name, input, at) => ({ type: 'assistant', timestamp: iso(at), message: { model: 'claude-test', content: [{ type: 'tool_use', id, name, input }] } }),
  result: (id, at) => ({ type: 'user', timestamp: iso(at), message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }),
};

export const jsonl = rows => rows.map(r => JSON.stringify(r)).join('\n') + '\n';

// スクリプトを子プロセスで実行し、標準入力を渡して終了を待つ
export function runNode(script, { args = [], input = '', env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}
