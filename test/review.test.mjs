// ふりかえりの集計（稼働帯・同時作業の本数・週のまとめ）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { segmentsOf, blocksOf, peakConcurrency, weekStats } from '../lib/review.mjs';

const M = 60000;
const T0 = Date.UTC(2026, 0, 5, 1, 0, 0);
const tl = [
  { kind: 'prompt', at: T0, text: '依頼1' },
  { kind: 'tool', at: T0 + 2 * M, text: 'Edit /a.ts' },
  { kind: 'tool', at: T0 + 4 * M, text: 'Skill dataviz' },
  { kind: 'reply', at: T0 + 10 * M, text: 'できました' },
  { kind: 'prompt', at: T0 + 30 * M, text: '依頼2' },
  { kind: 'reply', at: T0 + 40 * M, text: 'できました' },
];

describe('segmentsOf', () => {
  test('依頼から最後の動きまでを作業中、次の依頼までをあなたの番にする', () => {
    assert.deepEqual(segmentsOf(tl, { to: T0 + 60 * M }), [
      [T0, T0 + 10 * M, 'w'],
      [T0 + 10 * M, T0 + 30 * M, 't'],
      [T0 + 30 * M, T0 + 40 * M, 'w'],
    ]);
  });

  test('稼働中なら最後の区間を今まで伸ばす', () => {
    const to = T0 + 60 * M;
    assert.deepEqual(segmentsOf(tl, { to, live: 'yours' }).at(-1), [T0 + 40 * M, to, 't']);
    assert.deepEqual(segmentsOf(tl, { to, live: 'working' }).at(-1), [T0 + 30 * M, to, 'w']);
  });

  test('期間の外は切り落とす', () => {
    assert.deepEqual(segmentsOf(tl, { from: T0 + 35 * M, to: T0 + 60 * M }), [[T0 + 35 * M, T0 + 40 * M, 'w']]);
  });

  test('8時間以上返事をしなかった区間は描かない', () => {
    const long = [{ kind: 'prompt', at: T0 }, { kind: 'reply', at: T0 + M }, { kind: 'prompt', at: T0 + 9 * 60 * M }, { kind: 'reply', at: T0 + 9 * 60 * M + M }];
    assert.deepEqual(segmentsOf(long, { to: T0 + 10 * 60 * M }).map(s => s[2]), ['w', 'w']);
  });
});

test('blocksOf は30分未満のあなたの番でつながる作業をひとまとまりにする', () => {
  const segs = [
    [0, 10 * M, 'w'], [10 * M, 25 * M, 't'], [25 * M, 40 * M, 'w'], // 15分の間 → つなげる
    [40 * M, 100 * M, 't'], [100 * M, 110 * M, 'w'],                  // 60分の間 → 分ける
  ];
  assert.deepEqual(blocksOf(segs), [
    { start: 0, end: 40 * M, work: [[0, 10 * M], [25 * M, 40 * M]] },
    { start: 100 * M, end: 110 * M, work: [[100 * M, 110 * M]] },
  ]);
  assert.deepEqual(blocksOf([[0, M, 't']]), []);
});

test('peakConcurrency は同時に作業していた本数の最大を返す', () => {
  const r = peakConcurrency([
    [[0, 10, 'w']],
    [[5, 15, 'w'], [15, 20, 't']],
    [[10, 12, 'w']], // 0〜10 の終わりと同時に始まるので 3 本にはならない
  ]);
  assert.deepEqual(r, { peak: 2, at: 5 });
});

test('weekStats は期間内の依頼・ツール・スキルを数える', () => {
  const w = weekStats([{ sessionId: 'a', name: '合成', project: 'proj', timeline: tl, live: null }], { from: T0, to: T0 + 60 * M });
  assert.equal(w.sessions, 1);
  assert.equal(w.prompts, 2);
  assert.equal(w.toolCalls, 2);
  assert.equal(w.edits, 1);
  assert.deepEqual(w.skills, [{ name: 'dataviz', count: 1 }]);
  assert.deepEqual(w.projects, [{ name: 'proj', count: 2 }]);
  assert.equal(w.longest.ms, 10 * M);
  assert.equal(w.hours.flat().reduce((a, b) => a + b, 0), 2);
  assert.equal(weekStats([{ sessionId: 'a', name: '合成', project: 'proj', timeline: tl }], { from: T0 + 2 * 3600000 }).sessions, 0);
});
