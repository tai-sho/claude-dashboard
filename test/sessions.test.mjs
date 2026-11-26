import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandboxEnv, row, jsonl } from './helpers.mjs';

const sb = sandboxEnv();
const { deriveState, projectLabel, closeChecks, collectSessions, gitStatus, SESSIONS_DIR, HOOK_EVENTS_DIR } = await import('../lib/sessions.mjs');
const { TranscriptIndex, projectDirFor } = await import('../lib/transcripts.mjs');
after(() => sb.cleanup());

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const MIN = 60 * 1000;

describe('deriveState', () => {
  const tr = (extra = {}) => ({ lastActivityAt: NOW - MIN, lastRowKind: 'reply', lastReplyAt: NOW - MIN, ...extra });

  test('作業中は保留中のツールを理由に出す', () => {
    const s = deriveState({ status: 'busy', statusUpdatedAt: NOW - MIN }, tr({ pendingTool: { name: 'Bash', detail: 'npm test' } }), null, NOW);
    assert.equal(s.key, 'working');
    assert.equal(s.reason, 'Bash npm test');
  });

  test('ツールが無ければ「考え中」', () => {
    assert.equal(deriveState({ status: 'busy', statusUpdatedAt: NOW }, tr(), null, NOW).reason, '考え中');
  });

  test('busy のまま3分以上動きがなければ停滞', () => {
    const s = deriveState({ status: 'busy', statusUpdatedAt: NOW - 10 * MIN }, tr({ lastActivityAt: NOW - 5 * MIN }), null, NOW);
    assert.equal(s.key, 'stalled');
    assert.equal(s.reason, '5分動きがありません');
  });

  test('idle で最後が返答ならあなたの番、依頼のままなら待機', () => {
    assert.equal(deriveState({ status: 'idle' }, tr(), null, NOW).key, 'yours');
    assert.equal(deriveState({ status: 'idle' }, tr({ lastRowKind: 'prompt' }), null, NOW).key, 'idle');
  });

  test('会話記録より新しい通知があれば承認待ち', () => {
    const hook = { notification: { type: 'permission_prompt', message: 'Bash を実行しますか', at: NOW } };
    const s = deriveState({ status: 'busy', statusUpdatedAt: NOW - 10 * MIN }, tr(), hook, NOW);
    assert.equal(s.key, 'waiting');
    assert.equal(s.reason, 'Bash を実行しますか');
  });

  test('PermissionRequest でも承認待ちになる', () => {
    const s = deriveState({ status: 'busy' }, tr(), { permissionRequest: { tool: 'Write', at: NOW } }, NOW);
    assert.equal(s.key, 'waiting');
    assert.equal(s.reason, 'Write の実行許可');
  });

  test('会話記録が進んだ後の古い通知・idle_prompt・idle 中の通知は無視する', () => {
    const old = { notification: { type: 'permission_prompt', at: NOW - 10 * MIN } };
    assert.equal(deriveState({ status: 'busy', statusUpdatedAt: NOW }, tr(), old, NOW).key, 'working');
    const idlePrompt = { notification: { type: 'idle_prompt', at: NOW } };
    assert.equal(deriveState({ status: 'idle' }, tr(), idlePrompt, NOW).key, 'yours');
    const fresh = { notification: { type: 'permission_prompt', at: NOW } };
    assert.equal(deriveState({ status: 'idle' }, tr(), fresh, NOW).key, 'yours');
  });

  test('知らない状態は other', () => {
    assert.equal(deriveState({ status: 'paused' }, null, null, NOW).key, 'other');
  });
});

describe('projectLabel', () => {
  test('worktree の場合は元のプロジェクト名と worktree 名', () => {
    assert.deepEqual(projectLabel('/src/app/.claude/worktrees/feature-x/sub'), { project: 'app', worktree: 'feature-x' });
  });

  test('ホーム配下はフォルダ名、それ以外はパスそのまま', () => {
    assert.deepEqual(projectLabel(path.join(sb.home, 'work', 'proj')), { project: 'proj', worktree: null });
    assert.deepEqual(projectLabel('/opt/other'), { project: '/opt/other', worktree: null });
  });

  test('scratch-workspaces と未設定', () => {
    assert.equal(projectLabel('/x/scratch-workspaces/abc').project, 'No folder');
    assert.equal(projectLabel(null).project, '不明');
  });
});

describe('closeChecks', () => {
  const clean = { changed: 0, ahead: 0 };
  const tr = { handoff: { at: 200 }, lastPromptAt: 100 };

  test('すべて満たせば閉じてよい', () => {
    assert.ok(closeChecks('yours', clean, tr).every(c => c.ok));
  });

  test('各条件が個別に効く', () => {
    const failing = (...args) => closeChecks(...args).filter(c => !c.ok).map(c => c.label);
    assert.deepEqual(failing('waiting', clean, tr), ['承認待ちではない']);
    assert.deepEqual(failing('stalled', clean, tr), ['裏で作業していない']);
    assert.deepEqual(failing('yours', clean, { handoff: { at: 100 }, lastPromptAt: 200 }), ['最新の依頼に対する引き継ぎ文がある']);
    assert.deepEqual(failing('yours', { changed: 2, ahead: 0 }, tr), ['未コミット・未プッシュの変更がない']);
    assert.deepEqual(failing('yours', { changed: 0, ahead: 1 }, tr), ['未コミット・未プッシュの変更がない']);
    assert.equal(failing('yours', null, tr).length, 1);
  });

  test('Git 管理外ならラベルで分かるようにする', () => {
    const c = closeChecks('yours', { notRepo: true, changed: 0, ahead: 0 }, tr).at(-1);
    assert.equal(c.label, '未コミットの変更がない（Git 管理外）');
  });
});

describe('gitStatus', () => {
  test('存在しないフォルダは null、Git 管理外は notRepo', async () => {
    assert.equal(await gitStatus(path.join(sb.base, 'nope')), null);
    const dir = path.join(sb.base, 'plain');
    fs.mkdirSync(dir);
    assert.deepEqual(await gitStatus(dir), { notRepo: true, changed: 0, ahead: 0 });
  });
});

describe('collectSessions', () => {
  const cwd = path.join(sb.base, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const now = Date.now();

  const addSession = (sessionId, meta, rows) => {
    fs.writeFileSync(path.join(SESSIONS_DIR, `${sessionId}.json`), JSON.stringify({ pid: process.pid, sessionId, cwd, ...meta }));
    const dir = projectDirFor(cwd);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), jsonl(rows));
  };

  addSession('sess-yours', { status: 'idle', statusUpdatedAt: now - 60000 }, [
    row.prompt('調べて', now - 120000),
    row.tool('t1', 'mcp__ccd_turn__wrap_up', { recap: '調べました' }, now - 60000),
    row.reply('結果です', now - 60000),
  ]);
  addSession('sess-busy', { status: 'busy', statusUpdatedAt: now - 1000, name: '作業用' }, [
    row.prompt('直して', now - 5000),
    row.tool('t1', 'Bash', { command: 'npm test' }, now - 1000),
  ]);
  addSession('sess-wait', { status: 'busy', statusUpdatedAt: now - 1000 }, [row.prompt('消して', now - 5000)]);
  fs.mkdirSync(HOOK_EVENTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(HOOK_EVENTS_DIR, 'sess-wait.permission.json'), JSON.stringify({ at: now, tool: 'Bash' }));
  // 対象外: 終了したプロセス、SDK 起動、壊れた JSON
  addSession('sess-dead', { status: 'idle', pid: 2 ** 22 + 12345 }, [row.prompt('x', now)]);
  addSession('sess-sdk', { status: 'idle', entrypoint: 'sdk-ts' }, [row.prompt('x', now)]);
  fs.writeFileSync(path.join(SESSIONS_DIR, 'broken.json'), '{');

  test('生きているセッションを状態の優先順に並べる', async () => {
    const list = await collectSessions(new TranscriptIndex());
    assert.deepEqual(list.map(s => [s.sessionId, s.state.key]), [
      ['sess-wait', 'waiting'],
      ['sess-yours', 'yours'],
      ['sess-busy', 'working'],
    ]);
    const yours = list.find(s => s.sessionId === 'sess-yours');
    assert.equal(yours.name, '調べて');
    assert.equal(yours.handoff.text, '調べました');
    assert.equal(yours.git.notRepo, true);
    assert.equal(yours.closable, true);
    const busy = list.find(s => s.sessionId === 'sess-busy');
    assert.equal(busy.name, '作業用');
    assert.equal(busy.state.reason, 'Bash npm test');
    assert.equal(busy.closable, false);
  });

  test('includeSdk で SDK 起動のセッションも含める', async () => {
    const list = await collectSessions(new TranscriptIndex(), { includeSdk: true });
    assert.ok(list.some(s => s.sessionId === 'sess-sdk'));
    assert.ok(!list.some(s => s.sessionId === 'sess-dead'));
  });
});
