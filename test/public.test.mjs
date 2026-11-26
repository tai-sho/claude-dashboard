// 画面のモジュールのうち DOM に触らないもの（文字の整形、盤面の並べ方、使用枠の計算）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { esc, highlight, where, openActions, shQuote, elapsed, rootOf, plain } from '../public/js/format.js';
import { laneFor, sortLanes, groupByProject, REST_AFTER_MS } from '../public/js/lanes.js';
import { parseReset, untilText, projection, WINDOWS } from '../public/js/quota.js';

const M = 60000;
const NOW = Date.UTC(2026, 0, 5, 3, 0, 0);
const session = (id, key, extra = {}) => ({ sessionId: id, name: id, project: 'app', state: { key, label: key }, lastActivityAt: NOW - M, ...extra });

describe('format', () => {
  test('esc は HTML の特殊文字をすべて置き換え、null は空にする', () => {
    assert.equal(esc(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
    assert.equal(esc(null), '');
    assert.equal(esc(0), '0');
  });

  test('highlight は一致部分だけを囲み、残りはエスケープする', () => {
    assert.equal(highlight('a <b> c', ['b']), 'a &lt;<mark>b</mark>&gt; c');
    // エスケープ後の &amp; の中に一致させない
    assert.equal(highlight('x & y', ['amp']), 'x &amp; y');
    // 正規表現の記号を含む語もそのまま探す
    assert.equal(highlight('a.b axb', ['a.b']), '<mark>a.b</mark> axb');
    assert.equal(highlight('<i>', []), '&lt;i&gt;');
  });

  test('where はブランチを優先し、HEAD のときは worktree 名を出す', () => {
    assert.equal(where({ project: 'a<b', gitBranch: 'feat/x' }), 'a&lt;b / <span class="branch">feat/x</span>');
    assert.equal(where({ project: 'app', gitBranch: 'HEAD', worktree: 'wt-1' }), 'app / wt-1');
    assert.equal(where({ project: 'app', gitBranch: 'main' }, true), '<span class="branch">main</span>');
  });

  test('openActions はアプリのセッションならアプリで開くリンク、そうでなければ再開コマンドを出す', () => {
    assert.match(openActions({ hostSessionId: 'local_a b', cwd: '/work/app' }), /href="claude:\/\/code\/continue\?session=local_a%20b&amp;source=url_external"/);
    const html = openActions({ sessionId: 's1', cwd: `/work/it's` });
    assert.match(html, /data-copy="cd &#39;\/work\/it&#39;\\&#39;&#39;s&#39; &amp;&amp; claude --resume &#39;s1&#39;"/);
    assert.equal(openActions({}), '');
  });

  test('shQuote は単一引用符を閉じて逃がす', () => {
    assert.equal(shQuote(`it's`), `'it'\\''s'`);
  });

  test('elapsed は秒・分・時間・日で丸める', () => {
    assert.deepEqual(elapsed(30 * 1000), { n: 30, u: '秒' });
    assert.deepEqual(elapsed(5 * M), { n: 5, u: '分' });
    assert.deepEqual(elapsed(47 * 60 * M), { n: 47, u: '時間' });
    assert.deepEqual(elapsed(49 * 60 * M), { n: 2, u: '日' });
    assert.deepEqual(elapsed(-5), { n: 0, u: '秒' });
  });

  test('rootOf は worktree を元のリポジトリにまとめる', () => {
    assert.equal(rootOf('/work/app/.claude/worktrees/feat-x/src'), '/work/app');
    assert.equal(rootOf('/work/app'), '/work/app');
    assert.equal(rootOf(undefined), '');
  });

  test('plain はコードブロックを省き、Markdown の記号を落とす', () => {
    assert.equal(plain('**done**\n\n```js\nx\n```'), 'done\n［コード省略］');
  });
});

describe('lanes', () => {
  test('承認待ちと停滞はあなたを待っている、作業中は作業中に置く', () => {
    assert.equal(laneFor(session('a', 'waiting'), {}, NOW), 'you');
    assert.equal(laneFor(session('a', 'stalled'), {}, NOW), 'you');
    assert.equal(laneFor(session('a', 'working'), {}, NOW), 'work');
    assert.equal(laneFor(session('a', 'idle'), {}, NOW), 'rest');
  });

  test('あなたの番は、確認したか8時間触っていなければ寝かせる', () => {
    const s = session('a', 'yours', { lastReplyAt: NOW - 2 * M });
    assert.equal(laneFor(s, {}, NOW), 'you');
    assert.equal(laneFor(s, { a: NOW - 2 * M }, NOW), 'rest');
    // 確認したあとに新しい返答が来たら、また待っている側に戻す
    assert.equal(laneFor(s, { a: NOW - 3 * M }, NOW), 'you');
    assert.equal(laneFor(session('a', 'yours', { lastActivityAt: NOW - REST_AFTER_MS - 1 }), {}, NOW), 'rest');
  });

  test('待っている列は、承認や確認を求めているものを先に、長く待たせている順に並べる', () => {
    const list = [
      session('turn-old', 'yours', { state: { key: 'yours', since: NOW - 50 * M } }),
      session('call-new', 'waiting', { state: { key: 'waiting', since: NOW - 1 * M } }),
      session('call-old', 'waiting', { state: { key: 'waiting', since: NOW - 9 * M } }),
    ];
    const lanes = sortLanes(list, s => laneFor(s, {}, NOW));
    assert.deepEqual(lanes.you.map(s => s.sessionId), ['call-old', 'call-new', 'turn-old']);
  });

  test('プロジェクト別では worktree をまとめ、同じ名前の別リポジトリには親フォルダ名を添える', () => {
    const lanes = {
      you: [session('a', 'waiting', { cwd: '/work/team/app/.claude/worktrees/x' })],
      work: [session('b', 'working', { cwd: '/work/team/app' })],
      rest: [session('c', 'idle', { cwd: '/work/solo/app' }), session('d', 'idle', { project: 'tool', cwd: '/work/tool' })],
    };
    const groups = groupByProject(lanes);
    assert.deepEqual(groups.map(g => [g.label, g.rank, g.you.length + g.work.length + g.rest.length]), [
      ['app（team）', 0, 2],
      ['app（solo）', 3, 1],
      ['tool', 3, 1],
    ]);
  });
});

describe('quota', () => {
  test('リセット時刻は秒・ミリ秒・ISO 文字列のどれでも読む', () => {
    assert.equal(parseReset(1767582000), 1767582000000);
    assert.equal(parseReset(1767582000000), 1767582000000);
    assert.equal(parseReset('2026-01-05T03:00:00Z'), NOW);
    assert.equal(parseReset('soon'), null);
    assert.equal(parseReset(null), null);
  });

  test('リセットまでの残りを分・時間で言う', () => {
    assert.equal(untilText(NOW + 30 * M, NOW), 'あと30分でリセット');
    assert.equal(untilText(NOW + 90 * M, NOW), 'あと1時間30分でリセット');
    assert.equal(untilText(NOW - M, NOW), 'まもなくリセット');
  });

  test('窓の中での増え方から、リセット時の見込みを出す', () => {
    const w = WINDOWS.find(x => x.key === 'five_hour');
    const reset = NOW + 2 * 60 * M;
    const rec = (at, p) => ({ at, rate_limits: { five_hour: { used_percentage: p } } });
    // 記録が1つだけでは出さない
    assert.equal(projection(w, { used_percentage: 20, resets_at: reset }, [rec(NOW - 60 * M, 10)], NOW), null);
    // 1時間で10%増えている → 2時間後のリセット時に約40%
    const slow = projection(w, { used_percentage: 20, resets_at: reset }, [rec(NOW - 60 * M, 10), rec(NOW, 20)], NOW);
    assert.equal(slow.text, 'このペースだとリセット時に約40%');
    // 1時間で50%増えている → リセット前に上限に届く
    const fast = projection(w, { used_percentage: 60, resets_at: reset }, [rec(NOW - 60 * M, 10), rec(NOW, 60)], NOW);
    assert.equal(fast.over, true);
  });
});
