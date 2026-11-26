// install-*.mjs を一時ディレクトリの settings.json に対して動かし、追加と --remove の往復を確かめる
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandboxEnv, runNode, ROOT } from './helpers.mjs';

const sb = sandboxEnv();
after(() => sb.cleanup());
const env = { HOME: sb.home, CLAUDE_CONFIG_DIR: sb.claude };
const SETTINGS = path.join(sb.claude, 'settings.json');
const readSettings = () => JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
const backups = () => fs.readdirSync(sb.claude).filter(f => f.startsWith('settings.json.bak.dashboard-'));

beforeEach(() => {
  for (const f of fs.readdirSync(sb.claude)) if (f.startsWith('settings.json')) fs.rmSync(path.join(sb.claude, f));
  fs.rmSync(path.join(sb.home, '.claude-dashboard'), { recursive: true, force: true });
});

describe('install-hooks.mjs', () => {
  const INSTALL = path.join(ROOT, 'install-hooks.mjs');
  const mine = h => String(h.command).includes('claude-dashboard/hooks/record.mjs') || String(h.command).includes('/hooks/record.mjs');
  const other = { hooks: [{ type: 'command', command: 'echo other' }] };

  test('既存の hooks を残して追加し、--remove で元に戻す', async () => {
    const original = { model: 'x', hooks: { Notification: [other], Stop: [other] } };
    fs.writeFileSync(SETTINGS, JSON.stringify(original));

    assert.equal((await runNode(INSTALL, { env })).code, 0);
    let s = readSettings();
    assert.equal(s.model, 'x');
    for (const ev of ['Notification', 'PermissionRequest', 'SessionEnd']) {
      assert.equal(s.hooks[ev].flatMap(g => g.hooks).filter(mine).length, 1, ev);
    }
    assert.deepEqual(s.hooks.Notification[0], other);
    assert.deepEqual(s.hooks.Stop, [other]);
    const hook = s.hooks.SessionEnd[0].hooks[0];
    assert.equal(hook.async, true);
    assert.match(hook.command, /^node '.*record\.mjs' # claude-dashboard:record$/);
    assert.equal(backups().length, 1);

    assert.equal((await runNode(INSTALL, { env, args: ['--remove'] })).code, 0);
    assert.deepEqual(readSettings(), original);
  });

  test('二度実行しても重複しない', async () => {
    await runNode(INSTALL, { env });
    await runNode(INSTALL, { env });
    const s = readSettings();
    assert.equal(s.hooks.Notification.flatMap(g => g.hooks).filter(mine).length, 1);
  });

  test('以前の版で登録したイベントは取り除く', async () => {
    const legacy = { hooks: [{ type: 'command', command: "node '/x/claude-dashboard/hooks/record.mjs'" }] };
    fs.writeFileSync(SETTINGS, JSON.stringify({ hooks: { PreToolUse: [legacy, other] } }));
    await runNode(INSTALL, { env });
    assert.deepEqual(readSettings().hooks.PreToolUse, [other]);
  });

  test('別の場所から登録した印付きの hooks も置き換える', async () => {
    const elsewhere = { hooks: [{ type: 'command', command: "node '/elsewhere/dash/hooks/record.mjs' # claude-dashboard:record" }] };
    fs.writeFileSync(SETTINGS, JSON.stringify({ hooks: { Notification: [elsewhere, other] } }));
    await runNode(INSTALL, { env });
    const cmds = readSettings().hooks.Notification.flatMap(g => g.hooks).map(h => h.command);
    assert.ok(!cmds.some(c => c.includes('/elsewhere/')));
    assert.ok(cmds.includes('echo other'));
    await runNode(INSTALL, { env, args: ['--remove'] });
    assert.deepEqual(readSettings().hooks, { Notification: [other] });
  });

  test('settings.json が無くても作る', async () => {
    assert.equal((await runNode(INSTALL, { env })).code, 0);
    assert.ok(readSettings().hooks.Notification);
  });
});

describe('install-usage.mjs', () => {
  const INSTALL = path.join(ROOT, 'install-usage.mjs');
  const ORIGINAL = path.join(sb.home, '.claude-dashboard', 'statusline-original.json');

  test('元の statusLine を退避して挟み、--remove で元に戻す', async () => {
    const original = { theme: 'dark', statusLine: { type: 'command', command: 'my-statusline --flag', padding: 1 } };
    fs.writeFileSync(SETTINGS, JSON.stringify(original));

    assert.equal((await runNode(INSTALL, { env })).code, 0);
    const s = readSettings();
    assert.match(s.statusLine.command, /^node '.*statusline-tap\.mjs' # claude-dashboard:statusline-tap$/);
    assert.equal(s.statusLine.padding, 1);
    assert.equal(s.theme, 'dark');
    assert.equal(JSON.parse(fs.readFileSync(ORIGINAL, 'utf8')).command, 'my-statusline --flag');

    const again = await runNode(INSTALL, { env });
    assert.match(again.stdout, /すでに挟まっています/);
    assert.equal(backups().length, 1);

    assert.equal((await runNode(INSTALL, { env, args: ['--remove'] })).code, 0);
    assert.deepEqual(readSettings(), original);
  });

  test('statusLine が無かった場合は --remove で消す', async () => {
    fs.writeFileSync(SETTINGS, JSON.stringify({ theme: 'dark' }));
    await runNode(INSTALL, { env });
    assert.ok(readSettings().statusLine);
    await runNode(INSTALL, { env, args: ['--remove'] });
    assert.deepEqual(readSettings(), { theme: 'dark' });
  });

  test('別の場所の tap が挟まっていれば、それを元の statusline として退避しない', async () => {
    fs.writeFileSync(SETTINGS, JSON.stringify({ statusLine: { type: 'command', command: "node '/elsewhere/dash/hooks/statusline-tap.mjs'" } }));
    const r = await runNode(INSTALL, { env });
    assert.match(r.stdout, /すでに挟まっています/);
    assert.ok(!fs.existsSync(ORIGINAL));
  });

  test('挟まっていなければ --remove は何もしない', async () => {
    fs.writeFileSync(SETTINGS, JSON.stringify({ theme: 'dark' }));
    const r = await runNode(INSTALL, { env, args: ['--remove'] });
    assert.match(r.stdout, /挟まっていません/);
    assert.equal(backups().length, 0);
  });
});
