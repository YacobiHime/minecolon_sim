'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { stepStatus, progressText } = require('../src/progress');
const { mockRaw } = require('./fixtures');

const steps = require(path.join(__dirname, '..', 'configs', 'wood_pickaxe.json')).goal.steps;

test('持ち物と見えているものだけで手順の進み具合を判定する', () => {
  const st0 = stepStatus(steps, mockRaw({ inventory: [] }));
  assert.deepStrictEqual(st0.map((s) => s.done), [false, false, false, false, false, false]);
  // 作業台を持っている (置いていない): 1〜3 が済み、次は 4 (置く)
  const raw = mockRaw({ inventory: [{ name: 'spruce_log', count: 1 }, { name: 'crafting_table', count: 1 }] });
  assert.deepStrictEqual(stepStatus(steps, raw).map((s) => s.done), [true, true, true, false, false, false]);
  assert.match(progressText(steps, raw), /\(4\)place で crafting_table を置く…← 次はこれ/);
  // 作業台が見えていて棒もある: 次は 6
  const raw2 = mockRaw({ inventory: [{ name: 'stick', count: 4 }] });
  raw2.blocks.push({ name: 'crafting_table', notable: true, diggable: true, seen: 1, nearest: { x: 1, y: 64, z: 1, d: 1.4 }, positions: [] });
  assert.match(progressText(steps, raw2), /\(6\)craft で wooden_pickaxe を作る…← 次はこれ/);
});

test('steps がなければ空', () => {
  assert.strictEqual(progressText(undefined, mockRaw()), '');
});
