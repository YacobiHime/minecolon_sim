'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { exploreChoices, exploreTarget, visitText, dirJp } = require('../src/explore');
const { Memory } = require('../src/memory');
const { listActions } = require('../src/actions');
const { mockRaw } = require('./fixtures');

const here = { x: 8, y: 64, z: 8 }; // マス (0,0) の真ん中

test('exploreChoices basic: 東西南北だけ (段階1と同じ)', () => {
  assert.deepStrictEqual(exploreChoices(here).map((c) => c.id), ['north', 'south', 'east', 'west']);
});

test('exploreChoices varied: 8方位 x 近く/遠く + まだ行っていないマス + でたらめ = 18 個', () => {
  const ch = exploreChoices(here, { mode: 'varied' });
  assert.strictEqual(ch.length, 18);
  assert.strictEqual(ch[0].id, 'north_near');
  assert.strictEqual(ch[0].label, '北へ12m 行ったことなし');
  assert.ok(ch.some((c) => c.id === 'southwest_far' && c.label === '南西へ35m 行ったことなし'));
  assert.ok(ch.some((c) => c.id === 'unvisited'));
  assert.ok(ch.some((c) => c.id === 'random'));
  // 止められたものは出さない
  assert.ok(!exploreChoices(here, { mode: 'varied', blocked: new Set(['explore:random']) }).some((c) => c.id === 'random'));
});

test('exploreChoices varied: 行ったことのあるマスは回数といつごろを書き、未訪問は一番近いマスを選ぶ', () => {
  // 今いるマス (0,0) と、東 (1,0)・北 (0,-1) に行ったことがある
  const cells = [{ cx: 0, cz: 0, n: 2, t: 10 }, { cx: 1, cz: 0, n: 3, t: 4 }, { cx: 0, cz: -1, n: 1, t: 9 }];
  const ch = exploreChoices(here, { mode: 'varied', cells, cellSize: 16, tick: 10 });
  const east = ch.find((c) => c.id === 'east_near'); // x=20 → マス (1,0)
  assert.strictEqual(east.label, '東へ12m 行った 3回・6回前');
  assert.strictEqual(ch.find((c) => c.id === 'north_near').label, '北へ12m 行った 1回・1回前');
  const un = ch.find((c) => c.id === 'unvisited');
  // 隣の未訪問のうち一番近い (西 (-1,0) か 南 (0,1)、どちらも 16m)。行ったマスは選ばない
  assert.ok(!['1,0', '0,-1', '0,0'].includes(un.cell.join(',')));
  assert.strictEqual(un.dist, 16);
  assert.match(un.label, /^まだ行っていないマスへ \((南|西)へ約16m\)$/);
});

test('visitText / dirJp', () => {
  assert.strictEqual(visitText(null, 5), '行ったことなし');
  assert.strictEqual(visitText({ n: 1, t: 5 }, 5), '行った 1回・今いる');
  assert.strictEqual(dirJp(1, 0), '東');
  assert.strictEqual(dirJp(-1, -1), '北西');
  assert.strictEqual(dirJp(0, 1), '南');
});

test('exploreTarget: 方角・未訪問・でたらめの行き先', () => {
  const s = { x: 0, z: 0 };
  const ne = exploreChoices({ x: 0, y: 64, z: 0 }, { mode: 'varied' }).find((c) => c.id === 'northeast_far');
  const t = exploreTarget(s, ne);
  assert.ok(Math.abs(Math.hypot(t.x, t.z) - 35) < 1e-9 && t.x > 0 && t.z < 0);
  assert.strictEqual(t.dirJp, '北東');
  const r = exploreTarget(s, { kind: 'random', randomMin: 15, randomMax: 35 }, () => 0.5); // 角度 π (西)、距離 25
  assert.strictEqual(r.dist, 25);
  assert.strictEqual(r.dirJp, '西');
  const u = exploreTarget(s, { kind: 'unvisited', target: { x: 24, z: 8 } });
  assert.strictEqual(u.dirJp, '東');
});

test('Memory.noteCell: 違うマスに入ったときだけ数え、保存・読み込みで残り、時間で忘れる', () => {
  const m = new Memory({ limits: { promptItems: 20, halfLife: 2, impBoost: 0, forgetBelow: 0.3 } });
  m.noteCell({ x: 1, y: 64, z: 1 });
  m.noteCell({ x: 5, y: 64, z: 3 }); // 同じマス
  m.noteCell({ x: 20, y: 64, z: 1 }); // 東のマス
  m.noteCell({ x: 2, y: 64, z: 1 }); // 戻る
  assert.deepStrictEqual(m.cells.map((c) => [c.cx, c.cz, c.n]), [[0, 0, 2], [1, 0, 1]]);
  // 時間がたつと忘れる (forget は promptItems > 0 のとき)
  m.tick = 10;
  m.forget();
  assert.strictEqual(m.cells.length, 0);
  assert.strictEqual(m.forgotten, 0); // 記憶の項目の忘れた数には入れない
  assert.strictEqual(m.cellsForgotten, 2);
});

test('listActions: ctx.explore の mode で explore の選択肢が変わる (プロンプトにはマスの件数を入れない)', () => {
  const basic = listActions(mockRaw()).find((a) => a.name === 'explore');
  assert.strictEqual(basic.choices.length, 4);
  const v = listActions(mockRaw(), { explore: { mode: 'varied', cells: [{ cx: 0, cz: 0, n: 1, t: 0 }], cellSize: 16, tick: 3 } }).find((a) => a.name === 'explore');
  assert.strictEqual(v.choices.length, 18);
  assert.strictEqual(v.desc, '歩いて新しい場所を見る');
});
