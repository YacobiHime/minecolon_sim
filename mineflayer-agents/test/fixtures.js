'use strict';
// テスト用の模擬の観測と、模擬の bot (collectRaw 用の最小限)
const { Vec3 } = require('vec3');

function mockRaw(over = {}) {
  return {
    self: { name: 'Taro', pos: { x: 0, y: 64, z: 0 }, health: 20, food: 18, timeOfDay: 6000, phase: '昼' },
    inventory: [{ name: 'spruce_log', count: 2 }, { name: 'bread', count: 1 }],
    blocks: [
      { name: 'grass_block', notable: false, diggable: true, seen: 5, nearest: { x: 1, y: 63, z: 0, d: 1.4 }, positions: [] },
      { name: 'spruce_log', notable: true, diggable: true, seen: 3, nearest: { x: 5, y: 64, z: -3, d: 5.8 }, positions: [] },
      { name: 'stone', notable: false, diggable: false, seen: 2, nearest: { x: 3, y: 60, z: 3, d: 5.7 }, positions: [] },
      { name: 'water', notable: true, diggable: false, seen: 1, nearest: { x: -10, y: 63, z: 2, d: 10.2 }, positions: [] },
    ],
    entities: [{ kind: 'player', name: 'Hanako', pos: { x: -4, y: 64, z: 4 }, d: 5.7 }, { kind: 'item', name: 'spruce_sapling', pos: { x: 2, y: 64, z: 0 }, d: 2 }],
    heard: [{ from: 'Hanako', text: 'こんにちは', d: 6 }],
    craft: { now: ['spruce_planks'], withTable: ['wooden_pickaxe'] },
    tableNearby: null,
    ...over,
  };
}

// blocks: Map "x,y,z" -> name。raycast は「from から dir に進んで最初の固体ブロック」を返す簡易版
function mockBot({ blocks, pos = new Vec3(0.5, 64, 0.5), entities = {} }) {
  const get = (p) => blocks.get(`${p.x},${p.y},${p.z}`);
  const mkBlock = (p, name) => ({ name, position: new Vec3(p.x, p.y, p.z), diggable: name !== 'bedrock', hardness: name === 'bedrock' ? null : 1, harvestTools: name === 'stone' ? { 999: true } : undefined });
  const bot = {
    username: 'Taro',
    entity: { position: pos, height: 1.62 },
    health: 20, food: 20, time: { timeOfDay: 14000 },
    inventory: { items: () => [{ name: 'stick', count: 2, type: 1 }] },
    entities,
    blockAt: (p) => { const n = get(p); return n ? mkBlock(p, n) : null; },
    findBlocks: ({ matching, maxDistance, count }) => {
      const out = [];
      for (const [k, name] of blocks) {
        const [x, y, z] = k.split(',').map(Number);
        const p = new Vec3(x, y, z);
        if (p.distanceTo(pos) <= maxDistance && matching({ name })) out.push(p);
      }
      return out.sort((a, b) => a.distanceTo(pos) - b.distanceTo(pos)).slice(0, count);
    },
    world: {
      raycast(from, dir, range) {
        for (let t = 0; t <= range; t += 0.05) {
          const p = from.plus(dir.scaled(t)).floored();
          const n = get(p);
          if (n && n !== 'air') return { position: p, name: n };
        }
        return null;
      },
    },
  };
  return bot;
}

module.exports = { mockRaw, mockBot };
