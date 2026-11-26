// hooks/ のスクリプトを子プロセスで動かし、記録内容と「どんな失敗でも exit 0」を確かめる
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandboxEnv, runNode, ROOT } from './helpers.mjs';

const sb = sandboxEnv();
after(() => sb.cleanup());
const env = { HOME: sb.home, CLAUDE_CONFIG_DIR: sb.claude };
const STATE = path.join(sb.home, '.claude-dashboard');
const EVENTS = path.join(STATE, 'events');
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));

describe('hooks/record.mjs', () => {
  const RECORD = path.join(ROOT, 'hooks', 'record.mjs');
  const send = input => runNode(RECORD, { env, input: typeof input === 'string' ? input : JSON.stringify(input) });

  test('Notification と PermissionRequest を別ファイルに記録する', async () => {
    assert.equal((await send({ session_id: 'abc-1', hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'm'.repeat(500) })).code, 0);
    assert.equal((await send({ session_id: 'abc-1', hook_event_name: 'PermissionRequest', tool_name: 'Bash' })).code, 0);
    const n = readJson(path.join(EVENTS, 'abc-1.notification.json'));
    assert.equal(n.type, 'permission_prompt');
    assert.equal(n.message.length, 200);
    assert.equal(typeof n.at, 'number');
    assert.equal(readJson(path.join(EVENTS, 'abc-1.permission.json')).tool, 'Bash');
    assert.deepEqual(fs.readdirSync(EVENTS).filter(f => f.endsWith('.tmp')), []);
  });

  test('SessionEnd でそのセッションの記録を消す', async () => {
    await send({ session_id: 'abc-2', hook_event_name: 'PermissionRequest', tool_name: 'Write' });
    await send({ session_id: 'abc-3', hook_event_name: 'PermissionRequest', tool_name: 'Write' });
    assert.equal((await send({ session_id: 'abc-2', hook_event_name: 'SessionEnd' })).code, 0);
    assert.ok(!fs.existsSync(path.join(EVENTS, 'abc-2.permission.json')));
    assert.ok(fs.existsSync(path.join(EVENTS, 'abc-3.permission.json')));
  });

  test('session_id のパス区切りなどは取り除く', async () => {
    await send({ session_id: '../../evil/x', hook_event_name: 'PermissionRequest', tool_name: 'Bash' });
    assert.ok(fs.existsSync(path.join(EVENTS, 'evilx.permission.json')));
    assert.ok(!fs.existsSync(path.join(sb.home, 'evil')));
  });

  test('壊れた入力・空入力・未知のイベントでも exit 0', async () => {
    assert.equal((await send('{not json')).code, 0);
    assert.equal((await send('')).code, 0);
    assert.equal((await send({ session_id: 'abc-4', hook_event_name: 'Stop' })).code, 0);
    assert.ok(!fs.existsSync(path.join(EVENTS, 'abc-4.notification.json')));
  });
});

describe('hooks/statusline-tap.mjs', () => {
  const TAP = path.join(ROOT, 'hooks', 'statusline-tap.mjs');
  const limits = (five, seven) => ({ five_hour: { used_percentage: five, resets_at: 1767225600 }, seven_day: { used_percentage: seven, resets_at: 1767830400 } });
  const tap = d => runNode(TAP, { env, input: typeof d === 'string' ? d : JSON.stringify(d) });
  const historyLines = () => fs.readFileSync(path.join(STATE, 'usage-history.jsonl'), 'utf8').trim().split('\n');

  test('元の statusline が無ければ何も表示せず exit 0', async () => {
    const r = await tap({ session_id: 's1', model: { display_name: 'Test' }, rate_limits: limits(10, 20) });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    const u = readJson(path.join(STATE, 'usage.json'));
    assert.equal(u.session_id, 's1');
    assert.equal(u.model, 'Test');
    assert.equal(u.rate_limits.five_hour.used_percentage, 10);
  });

  test('推移は値が変わったときだけ追記する', async () => {
    await tap({ rate_limits: limits(10, 20) });
    assert.equal(historyLines().length, 1);
    await tap({ rate_limits: limits(11, 20) });
    assert.equal(historyLines().length, 2);
    assert.equal(JSON.parse(historyLines().at(-1)).rate_limits.five_hour.used_percentage, 11);
  });

  test('元の statusline に同じ入力を渡して表示させる', async () => {
    fs.writeFileSync(path.join(STATE, 'statusline-original.json'), JSON.stringify({ command: `${JSON.stringify(process.execPath)} -e "process.stdin.pipe(process.stdout)"` }));
    const input = JSON.stringify({ rate_limits: limits(12, 20), cwd: '/tmp' });
    const r = await tap(input);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, input);
  });

  test('入力が壊れていても元の statusline は動かす', async () => {
    const r = await tap('not json');
    assert.equal(r.code, 0);
    assert.equal(r.stdout, 'not json');
  });

  test('元の statusline が tap 自身でも呼び続けない', async () => {
    const self = `${JSON.stringify(process.execPath)} ${JSON.stringify(TAP)}`;
    fs.writeFileSync(path.join(STATE, 'statusline-original.json'), JSON.stringify({ command: self }));
    const r = await tap({ rate_limits: limits(12, 20) });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
  });

  test('元のコマンドが失敗しても exit 0', async () => {
    fs.writeFileSync(path.join(STATE, 'statusline-original.json'), JSON.stringify({ command: 'exit 3' }));
    assert.equal((await tap({ rate_limits: limits(12, 20) })).code, 0);
  });

  test('元のコマンドが入力を読まずに終わっても exit 0', async () => {
    fs.writeFileSync(path.join(STATE, 'statusline-original.json'), JSON.stringify({ command: 'exit 0' }));
    const r = await tap({ rate_limits: limits(12, 20), padding: 'x'.repeat(200000) }); // パイプの容量を超える入力
    assert.equal(r.code, 0);
    assert.equal(r.stderr, '');
  });
});
