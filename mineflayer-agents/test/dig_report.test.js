'use strict';
// 掘った結果の文に、使った道具とかかった時間を書く (act.js の collect・置く所をどける)
const test = require('node:test');
const assert = require('node:assert');
const { Vec3 } = require('vec3');
const { handlers, toolText, digTimeText } = require('../src/act');
const nochange = require('../src/nochange');

// collect 用の最小の模擬 bot。digMs: 道具ごとの1個を掘る時間 (ms)。掘ると持ち物に1個増える
function digBot({ items = [], digMs = { hand: 30, wooden_axe: 10 }, n = 3 } = {}) {
  const blocks = new Map();
  for (let i = 0; i < n; i++) blocks.set(`${i + 1},64,0`, 'jungle_log');
  const inv = items.map((name, i) => ({ name, count: 1, type: 100 + i }));
  const typeName = (t) => (t == null ? 'hand' : (inv.find((x) => x.type === t) || {}).name);
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5), height: 1.62 },
    registry: { blocksByName: { jungle_log: { id: 5 } } },
    heldItem: null,
    entities: {},
    inventory: { items: () => inv },
    findBlocks: () => [...blocks.keys()].map((k) => new Vec3(...k.split(',').map(Number))),
    blockAt: (p) => {
      const name = blocks.get(`${p.x},${p.y},${p.z}`);
      return name ? { name, position: p, boundingBox: 'block', digTime: (t) => digMs[typeName(t)] ?? digMs.hand } : null;
    },
    canDigBlock: () => true,
    pathfinder: { goto: async () => {}, setGoal: () => {} },
    clearControlStates: () => {},
    equip: async (it) => { bot.heldItem = it; },
    unequip: async () => { bot.heldItem = null; },
    dig: async (b) => {
      const t = bot.heldItem ? bot.heldItem.type : null;
      await new Promise((r) => setTimeout(r, digMs[typeName(t)] ?? digMs.hand));
      blocks.delete(`${b.position.x},${b.position.y},${b.position.z}`);
      const have = inv.find((x) => x.name === 'jungle_log');
      if (have) have.count += 1; else inv.push({ name: 'jungle_log', count: 1, type: 5 });
      bot.entities[Math.random()] = { name: 'item', position: b.position.offset(0.5, 0, 0.5) };
    },
  };
  return bot;
}

test('toolText / digTimeText: 素手・道具の名前、秒 (1秒未満)', () => {
  assert.strictEqual(toolText([null, null]), '素手で');
  assert.strictEqual(toolText(['wooden_axe', null]), 'wooden_axe・素手で');
  assert.strictEqual(toolText([]), '');
  assert.strictEqual(digTimeText(12400), '掘るのに12秒');
  assert.strictEqual(digTimeText(300), '掘るのに1秒未満');
});

test('collect: 結果の文に、使った道具 (一番速い物を自動で持つ) と掘るのにかかった時間を書く', async () => {
  const r1 = await handlers.collect(digBot({ items: ['stick'] }), { block: 'jungle_log' }, { collectCount: 3 });
  assert.match(r1.msg, /^jungle_logを素手で3個掘って3個拾った \(掘るのに(1秒未満|\d+秒)\)/);
  assert.deepStrictEqual(r1.tools, ['hand']);
  const r2 = await handlers.collect(digBot({ items: ['stick', 'wooden_axe'] }), { block: 'jungle_log' }, { collectCount: 3 });
  assert.match(r2.msg, /^jungle_logをwooden_axeで3個掘って3個拾った/);
  assert.deepStrictEqual(r2.tools, ['wooden_axe']);
  assert.ok(r2.digMs < r1.digMs, `${r2.digMs} < ${r1.digMs}`);
  // 置いた数 − 掘った数 の読み取りは、道具の入った文でも数える
  assert.strictEqual(nochange.blockDelta('collect', r2), -3);
});
