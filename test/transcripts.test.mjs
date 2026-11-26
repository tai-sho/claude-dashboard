import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandboxEnv, row, jsonl } from './helpers.mjs';

const sb = sandboxEnv();
const { humanPromptText, describeTool, projectDirFor, TranscriptIndex, summarize, detail, PROJECTS_DIR } = await import('../lib/transcripts.mjs');
after(() => sb.cleanup());

const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);
let n = 0;
const newFile = () => path.join(sb.base, `s${++n}-0000.jsonl`);

describe('humanPromptText', () => {
  test('文字列の依頼をそのまま返す', () => {
    assert.equal(humanPromptText(row.prompt('こんにちは', T0)), 'こんにちは');
  });

  test('配列の text 要素をつなぐ', () => {
    const r = { type: 'user', message: { content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] } };
    assert.equal(humanPromptText(r), 'a\nb');
  });

  test('ツール結果・メタ・サイドチェーン・assistant は依頼ではない', () => {
    assert.equal(humanPromptText(row.result('t1', T0)), null);
    assert.equal(humanPromptText(row.prompt('x', T0, { isMeta: true })), null);
    assert.equal(humanPromptText(row.prompt('x', T0, { isSidechain: true })), null);
    assert.equal(humanPromptText(row.reply('x', T0)), null);
  });

  test('system-reminder や各種イベントのタグを取り除く', () => {
    const text = '<system-reminder>内部</system-reminder>本文<task-notification id="1">通知</task-notification><side-sessions-event>e</side-sessions-event>';
    assert.equal(humanPromptText(row.prompt(text, T0)), '本文');
  });

  test('スラッシュコマンドはコマンド名だけ残す', () => {
    const text = '<command-name>/review</command-name><command-message>review</command-message><command-args></command-args>';
    assert.equal(humanPromptText(row.prompt(text, T0)), '/review');
  });

  test('Caveat や中断の行、タグだけの行は捨てる', () => {
    assert.equal(humanPromptText(row.prompt('Caveat: something', T0)), null);
    assert.equal(humanPromptText(row.prompt('[Request interrupted by user]', T0)), null);
    assert.equal(humanPromptText(row.prompt('<system-reminder>only</system-reminder>', T0)), null);
  });
});

describe('describeTool', () => {
  test('MCP のツール名を短くし、詳細は1行目だけ', () => {
    const d = describeTool({ name: 'mcp__server__do_thing', input: { query: 'line1\nline2' } });
    assert.deepEqual(d, { name: 'mcp:do_thing', detail: 'line1' });
  });

  test('description を優先し、160文字で切る', () => {
    const d = describeTool({ name: 'Bash', input: { description: 'x'.repeat(300), command: 'ls' } });
    assert.equal(d.name, 'Bash');
    assert.equal(d.detail.length, 160);
  });

  test('input が無くても落ちない', () => {
    assert.deepEqual(describeTool({ name: 'Read' }), { name: 'Read', detail: '' });
  });
});

test('projectDirFor は英数字とハイフン以外を - に置き換える', () => {
  assert.equal(projectDirFor('/tmp/a b/c.d_e'), path.join(PROJECTS_DIR, '-tmp-a-b-c-d-e'));
});

describe('TranscriptIndex', () => {
  test('依頼・返答・ツールを集計する', async () => {
    const file = newFile();
    fs.writeFileSync(file, jsonl([
      { type: 'custom-title', customTitle: '合成セッション' },
      row.prompt('最初の依頼', T0, { cwd: '/tmp/proj', gitBranch: 'main', entrypoint: 'cli' }),
      row.tool('t1', 'Edit', { file_path: '/tmp/proj/a.txt' }, T0 + 1000),
      row.result('t1', T0 + 2000),
      row.tool('t2', 'Edit', { file_path: '/tmp/proj/a.txt' }, T0 + 3000),
      row.tool('t3', 'Write', { file_path: '/tmp/proj/b.txt' }, T0 + 4000),
      row.tool('t4', 'Skill', { skill: 'demo-skill' }, T0 + 5000),
      row.reply('完了しました', T0 + 6000),
      row.prompt('次の依頼', T0 + 7000),
      row.reply('サブエージェント', T0 + 8000, { isSidechain: true }),
      { type: 'system', content: 'ignored' },
    ]));
    const idx = new TranscriptIndex();
    const acc = await idx.update(file);
    const s = summarize(acc);
    assert.equal(s.sessionId, path.basename(file, '.jsonl'));
    assert.equal(s.title, '合成セッション');
    assert.equal(s.cwd, '/tmp/proj');
    assert.equal(s.gitBranch, 'main');
    assert.equal(s.entrypoint, 'cli');
    assert.equal(s.model, 'claude-test');
    assert.equal(s.firstPrompt, '最初の依頼');
    assert.equal(s.lastPrompt, '次の依頼');
    assert.equal(s.promptCount, 2);
    assert.equal(s.toolCount, 4);
    assert.equal(s.lastReply, '完了しました');
    assert.equal(s.lastRowKind, 'prompt');
    assert.equal(s.lastActivityAt, T0 + 7000); // サイドチェーンの行は数えない
    assert.equal(s.fileCount, 2);
    assert.deepEqual(s.skills, ['demo-skill']);
    assert.equal(s.pendingTool, null); // 新しい依頼で保留中のツールは消える

    // 心電図用の動き（依頼・ツール・返答）と、最後に編集した順のファイル
    assert.deepEqual(s.beats.map(b => b[1]), ['p', 't', 't', 't', 't', 'r', 'p']);
    assert.equal(s.beats[0][0], T0);
    assert.deepEqual(s.recentFiles, [
      { path: '/tmp/proj/b.txt', edits: 1, at: T0 + 4000 },
      { path: '/tmp/proj/a.txt', edits: 2, at: T0 + 3000 },
    ]);

    const d = detail(acc);
    assert.deepEqual(d.files[0], { path: '/tmp/proj/a.txt', edits: 2 });
    assert.deepEqual(d.timeline.map(t => t.kind), ['prompt', 'tool', 'tool', 'tool', 'tool', 'reply', 'prompt']);
    assert.equal(idx.get(s.sessionId), acc);
    assert.equal(idx.all().length, 1);
  });

  test('結果が返っていないツールを pendingTool として出す', async () => {
    const file = newFile();
    fs.writeFileSync(file, jsonl([
      row.prompt('依頼', T0),
      row.tool('t1', 'Bash', { command: 'npm test' }, T0 + 1000),
      row.result('t1', T0 + 2000),
      row.tool('t2', 'Bash', { command: 'npm run build' }, T0 + 3000),
    ]));
    const s = summarize(await new TranscriptIndex().update(file));
    assert.equal(s.pendingTool.detail, 'npm run build');
    assert.equal(s.lastRowKind, 'tool');
    assert.equal(s.recentTools[0].detail, 'npm run build'); // 新しい順
  });

  test('wrap_up の recap を引き継ぎ文として残す', async () => {
    const file = newFile();
    fs.writeFileSync(file, jsonl([
      row.prompt('依頼', T0),
      row.tool('t1', 'mcp__ccd_turn__wrap_up', { recap: '終わりました', ask: '次は？' }, T0 + 1000),
    ]));
    const acc = await new TranscriptIndex().update(file);
    assert.deepEqual(acc.handoff, { text: '終わりました', at: T0 + 1000, ask: '次は？' });
    assert.equal(acc.timeline.at(-1).kind, 'handoff');
  });

  test('近接した返答はタイムライン上で1件にまとめる', async () => {
    const file = newFile();
    fs.writeFileSync(file, jsonl([row.prompt('依頼', T0), row.reply('前半', T0 + 100), row.reply('後半', T0 + 500), row.reply('別件', T0 + 10000)]));
    const acc = await new TranscriptIndex().update(file);
    const replies = acc.timeline.filter(t => t.kind === 'reply');
    assert.deepEqual(replies.map(r => r.text), ['前半\n後半', '別件']);
  });

  test('長い本文は切り詰める', async () => {
    const file = newFile();
    fs.writeFileSync(file, jsonl([row.prompt('あ'.repeat(5000), T0)]));
    const acc = await new TranscriptIndex().update(file);
    assert.ok(acc.firstPrompt.length <= 1201);
    assert.ok(acc.firstPrompt.endsWith('…'));
  });

  test('追記分だけを読み、書きかけの行は次回に回す', async () => {
    const file = newFile();
    const idx = new TranscriptIndex();
    fs.writeFileSync(file, jsonl([row.prompt('一つ目', T0)]));
    assert.equal((await idx.update(file)).promptCount, 1);

    const line = JSON.stringify(row.prompt('二つ目', T0 + 1000));
    fs.appendFileSync(file, line.slice(0, 20)); // 改行まで書かれていない
    let acc = await idx.update(file);
    assert.equal(acc.promptCount, 1);
    assert.ok(acc.partial);

    fs.appendFileSync(file, line.slice(20) + '\n');
    acc = await idx.update(file);
    assert.equal(acc.promptCount, 2);
    assert.equal(acc.lastPrompt, '二つ目');
    assert.equal(acc.partial, null);

    acc = await idx.update(file); // 変化が無ければ数は変わらない
    assert.equal(acc.promptCount, 2);
  });

  test('ファイルが短くなったら最初から読み直す', async () => {
    const file = newFile();
    const idx = new TranscriptIndex();
    fs.writeFileSync(file, jsonl([row.prompt('一つ目', T0), row.prompt('二つ目', T0 + 1)]));
    assert.equal((await idx.update(file)).promptCount, 2);
    fs.writeFileSync(file, jsonl([row.prompt('別', T0 + 2)]));
    const acc = await idx.update(file);
    assert.equal(acc.promptCount, 1);
    assert.equal(acc.firstPrompt, '別');
  });

  test('同じファイルへの同時更新で二重に数えない', async () => {
    const file = newFile();
    const rows = Array.from({ length: 50 }, (_, i) => row.prompt(`依頼${i}`, T0 + i));
    fs.writeFileSync(file, jsonl(rows));
    const idx = new TranscriptIndex();
    const results = await Promise.all(Array.from({ length: 5 }, () => idx.update(file)));
    assert.equal(results.at(-1).promptCount, 50);
    await new Promise(r => setImmediate(r));
    assert.equal(idx.locks.size, 0); // 終わったロックは残らない
  });

  test('壊れた行は飛ばし、存在しないファイルは null', async () => {
    const file = newFile();
    fs.writeFileSync(file, '{"type":"user", broken\n' + jsonl([row.prompt('正常', T0)]));
    const idx = new TranscriptIndex();
    assert.equal((await idx.update(file)).promptCount, 1);
    assert.equal(await idx.update(path.join(sb.base, 'missing.jsonl')), null);
  });

  test('scanAll は projects 配下の jsonl をすべて読む', async () => {
    for (const [dir, id] of [['-p1', 'aaa'], ['-p2', 'bbb']]) {
      fs.mkdirSync(path.join(PROJECTS_DIR, dir), { recursive: true });
      fs.writeFileSync(path.join(PROJECTS_DIR, dir, `${id}.jsonl`), jsonl([row.prompt(id, T0)]));
    }
    fs.writeFileSync(path.join(PROJECTS_DIR, '-p1', 'note.txt'), 'x');
    const idx = new TranscriptIndex();
    const progress = [];
    await idx.scanAll((done, total) => progress.push([done, total]));
    assert.deepEqual(idx.all().map(a => a.sessionId).sort(), ['aaa', 'bbb']);
    assert.deepEqual(progress.at(-1), [2, 2]);
  });

  test('summarize / detail は null をそのまま返す', () => {
    assert.equal(summarize(null), null);
    assert.equal(detail(null), null);
  });
});
