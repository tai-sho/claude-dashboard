// 画面のモジュールのうち DOM に触らないもの（文字の整形、盤面の並べ方、使用枠の計算、カレンダーの計算）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { esc, highlight, where, openActions, shQuote, elapsed, rootOf, plain, daypart } from '../public/js/format.js';
import { laneFor, sortLanes, groupByProject, projectKey, REST_AFTER_MS } from '../public/js/lanes.js';
import { planetOf, TYPES } from '../public/js/planet.js';
import { rangeOf, shift, piecesByDay, layout, hourRange, daySummary, colorSlots, PALETTE_SIZE, durText } from '../public/js/calendar.js';
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

  test('projectKey は worktree を元のリポジトリにまとめ、フォルダのないセッションはプロジェクト名でまとめる', () => {
    assert.equal(projectKey({ project: 'app', cwd: '/work/app/.claude/worktrees/x/src' }), '/work/app');
    assert.equal(projectKey({ project: 'No folder', cwd: '/tmp/scratch-workspaces/a' }), 'No folder');
    assert.equal(projectKey({}), '不明');
    // groupByProject の鍵と同じ
    const g = groupByProject({ you: [session('a', 'waiting', { cwd: '/work/app/.claude/worktrees/x' })], work: [], rest: [] });
    assert.equal(g[0].key, '/work/app');
  });
});

describe('planet', () => {
  test('同じプロジェクトにはいつも同じ惑星を返し、環はガス惑星だけに付く', () => {
    const seen = new Set();
    for (let i = 0; i < 60; i++) {
      const p = planetOf(`/work/project-${i}`);
      assert.deepEqual(planetOf(`/work/project-${i}`), p);
      assert.ok(TYPES.includes(p.type));
      if (p.ring) assert.equal(p.type, 'gas');
      assert.equal(p.glyph.length, 3);
      for (const c of p.glyph) assert.match(c, /^#[0-9a-f]{6}$/);
      seen.add(p.type);
    }
    assert.equal(seen.size, TYPES.length); // どの種類も出る
  });
});

describe('daypart', () => {
  test('時刻から空の色の時間帯を決める', () => {
    assert.deepEqual([0, 4, 5, 9, 10, 15, 16, 18, 19, 23].map(daypart),
      ['night', 'night', 'morning', 'morning', 'day', 'day', 'evening', 'evening', 'night', 'night']);
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

describe('calendar', () => {
  // 画面側の時刻で組み立てる（テストを動かす場所のタイムゾーンに左右されないように）
  const at = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime(); // 2026年11月
  const sess = (id, blocks, extra = {}) => ({ sessionId: id, name: id, project: 'app', cwd: '/work/app', live: false, blocks, ...extra });

  test('rangeOf は日・日曜始まりの週・月を含む週をすべて返す', () => {
    const fri = at(27, 15);
    assert.deepEqual(rangeOf('day', fri), { days: [at(27, 0)], from: at(27, 0), to: at(28, 0) });
    const w = rangeOf('week', fri);
    assert.equal(w.days.length, 7);
    assert.equal(w.from, at(22, 0)); // 日曜
    assert.equal(w.to, at(29, 0));
    const m = rangeOf('month', fri);
    assert.equal(m.from, at(1, 0)); // 2026年11月1日は日曜
    assert.equal(m.days.length, 35); // 30日（月）を含む週の土曜 12月5日まで
    assert.equal(m.to, new Date(2026, 11, 6).getTime());
  });

  test('shift は前後の期間へ移り、月は1日に揃える', () => {
    assert.equal(shift('day', at(27, 15), -1), at(26, 0));
    assert.equal(shift('week', at(27, 15), 1), new Date(2026, 11, 4).getTime());
    assert.equal(shift('month', new Date(2026, 0, 31).getTime(), 1), new Date(2026, 1, 1).getTime()); // 2月31日にならない
  });

  test('piecesByDay は日をまたぐまとまりを日ごとに切り、作業中の区間も切る', () => {
    const days = rangeOf('week', at(27, 0)).days;
    const blocks = [{ start: at(26, 22), end: at(27, 2), work: [[at(26, 23), at(27, 1)]] }];
    const by = piecesByDay([sess('a', blocks, { live: true, working: true })], days, at(27, 2));
    const [p26] = by.get(at(26, 0)), [p27] = by.get(at(27, 0));
    assert.deepEqual([p26.start, p26.end, p26.work], [at(26, 22), at(27, 0), [[at(26, 23), at(27, 0)]]]);
    assert.deepEqual([p27.start, p27.end, p27.work], [at(27, 0), at(27, 2), [[at(27, 0), at(27, 1)]]]);
    assert.equal(p26.running, false); // 続いているのは最後の切れ端だけ
    assert.equal(p27.running, true);
    assert.equal(p27.key, '/work/app');
    assert.deepEqual(by.get(at(25, 0)), []);
    // 稼働中でも、返事を待っている（作業していない）なら続いている扱いにしない
    assert.equal(piecesByDay([sess('a', blocks, { live: true, working: false })], days, at(27, 2)).get(at(27, 0))[0].running, false);
  });

  test('layout は重なるものを横に並べ、空いた列は使い回す', () => {
    const p = (id, s, e) => ({ sessionId: id, start: s, end: e });
    const out = layout([p('a', at(1, 9), at(1, 11)), p('b', at(1, 10), at(1, 12)), p('c', at(1, 11, 30), at(1, 12, 30)), p('d', at(1, 14), at(1, 15))]);
    assert.deepEqual(out.map(x => [x.sessionId, x.col, x.cols]), [['a', 0, 2], ['b', 1, 2], ['c', 0, 2], ['d', 0, 1]]);
    // 短いまとまりは画面でとる高さで重なりを判断する
    const short = [p('x', at(1, 9), at(1, 9, 1)), p('y', at(1, 9, 5), at(1, 9, 6))];
    assert.deepEqual(layout(short).map(x => x.cols), [1, 1]);
    assert.deepEqual(layout(short, 20 * M).map(x => [x.col, x.cols]), [[0, 2], [1, 2]]);
  });

  test('hourRange はまとまりと今を含み、少なくとも8時間にする', () => {
    assert.deepEqual(hourRange([]), [9, 18]);
    assert.deepEqual(hourRange([{ start: at(1, 10, 30), end: at(1, 13, 10) }]), [10, 18]); // 足りない分は先へ広げる
    assert.deepEqual(hourRange([{ start: at(1, 1), end: at(2, 0) }]), [1, 24]); // 日の終わりは24時
    assert.deepEqual(hourRange([{ start: at(1, 20), end: at(1, 23) }], at(1, 23, 30)), [16, 24]);
  });

  test('daySummary は同じセッションをまとめて作業時間を足す', () => {
    const w = (s, e) => ({ sessionId: 'a', name: 'a', project: 'app', key: 'k', start: s, end: e, work: [[s, e]], running: false });
    const sum = daySummary([w(at(1, 9), at(1, 10)), { ...w(at(1, 8), at(1, 8, 30)), sessionId: 'b' }, w(at(1, 13), at(1, 13, 30))]);
    assert.equal(sum.work, 2 * 3600000);
    assert.deepEqual(sum.sessions.map(s => [s.sessionId, s.work / M]), [['b', 30], ['a', 90]]);
  });

  test('durText', () => {
    assert.equal(durText(20000), '1分未満');
    assert.equal(durText(45 * M), '45分');
    assert.equal(durText(120 * M), '2時間');
    assert.equal(durText(130 * M), '2時間10分');
  });

  test('colorSlots は同じ画面のプロジェクトに別々の色を割り当て、同じ鍵には同じ色を返す', () => {
    const keys = Array.from({ length: PALETTE_SIZE }, (_, i) => `/work/project-${i}`);
    const a = colorSlots(keys);
    assert.equal(new Set(a.values()).size, PALETTE_SIZE);
    assert.deepEqual(colorSlots(keys), a);
    // 1つだけなら、ほかとの兼ね合いに関係なく鍵から決まる色
    assert.equal(colorSlots(['/work/x']).get('/work/x'), colorSlots(['/work/x', '/work/y']).get('/work/x'));
  });
});
