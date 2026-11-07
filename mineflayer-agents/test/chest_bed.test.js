'use strict';
// チェストの「見る」と「取る」が同じチェストを開くこと・古い画面の中身を取り違えないこと・ラージチェスト、
// ベッドを置けなかったときの置き直しと「まだ置いていない」の観察 (2026-11-06T06-05-27 の実行の Daiki・Jiro・Mai)
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { Vec3 } = require('vec3');
const { moreActions, visibleContainers } = require('../src/actions_more');
const { handlers } = require('../src/act');
const { chestPair } = require('../src/act_more');
const { summarizeObservation, observationEn } = require('../src/observe');
const { Memory } = require('../src/memory');
const { mockRaw } = require('./fixtures');

const all = () => true;
// 縦に2つ並んだチェスト (下 (-263,64,67) が近い、上 (-263,66,67) が遠い)。自分は (-261.5,64,68.6)
const twoChests = () => mockRaw({
  self: { name: 'Daiki', pos: { x: -261.5, y: 64, z: 68.6 }, health: 20, food: 13, phase: '昼' },
  inventory: [{ name: 'stick', count: 4 }],
  blocks: [{ name: 'chest', notable: false, diggable: true, seen: 2, nearest: { x: -263, y: 64, z: 67, d: 2.2 },
    positions: [{ x: -263, y: 64, z: 67, d: 2.2 }, { x: -263, y: 66, z: 67, d: 3.0 }] }],
});

test('chest: 最後に開けたチェストが見えていれば、近い方でなくそのチェストから取り出す候補を出す (Daiki)', () => {
  const containers = {
    '-263,64,67': { name: 'chest', items: [{ name: 'jungle_planks', count: 1 }, { name: 'stick', count: 10 }] }, // 前に見た (古い) 中身
    '-263,66,67': { name: 'chest', items: [{ name: 'jungle_planks', count: 8 }] }, // いま中を見たチェスト
  };
  const acts = moreActions(twoChests(), { containers, lastContainer: '-263,66,67' }, all);
  const take = acts.find((a) => a.name === 'chest_take');
  const planks = take.choices.find((c) => c.id === 'jungle_planks');
  assert.deepStrictEqual(planks.pos, { x: -263, y: 66, z: 67 });
  assert.match(planks.label, /x8/);
  // 近い方のチェストの中身は、場所を付けた別の候補
  const other = take.choices.find((c) => c.id === 'stick@-263,64,67');
  assert.ok(other);
  assert.deepStrictEqual(other.pos, { x: -263, y: 64, z: 67 });
  // 入れるのも同じチェスト
  assert.deepStrictEqual(acts.find((a) => a.name === 'chest_put').choices[0].pos, { x: -263, y: 66, z: 67 });
});

test('chest: 最後に開けたチェストが無ければ近い順。中を知らないほかのチェストは場所付きの「中を見る」', () => {
  const take = moreActions(twoChests(), {}, all).find((a) => a.name === 'chest_take');
  assert.deepStrictEqual(take.choices.map((c) => c.id), ['look', 'look@-263,66,67']);
  assert.deepStrictEqual(take.choices[0].pos, { x: -263, y: 64, z: 67 });
  assert.deepStrictEqual(take.choices[1].pos, { x: -263, y: 66, z: 67 });
  assert.ok(take.choices[1].look);
});

test('chest: ラージチェストの片割れ (覚えた中身の pair) は1つにまとめる', () => {
  const raw = mockRaw({ blocks: [{ name: 'chest', notable: false, diggable: true, seen: 2, nearest: { x: 2, y: 64, z: 0, d: 2 }, positions: [{ x: 2, y: 64, z: 0, d: 2 }, { x: 3, y: 64, z: 0, d: 3 }] }] });
  const items = [{ name: 'bread', count: 3 }];
  const containers = { '2,64,0': { name: 'chest', items, pair: '3,64,0' }, '3,64,0': { name: 'chest', items, pair: '2,64,0' } };
  assert.strictEqual(visibleContainers(raw, { containers }).length, 1);
  const take = moreActions(raw, { containers }, all).find((a) => a.name === 'chest_take');
  assert.deepStrictEqual(take.choices.map((c) => c.id), ['bread']);
});

// act の mock: world は "x,y,z" -> block
function chestBot(world, { client = null } = {}) {
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5), height: 1.62 },
    inventory: { items: () => [], slots: [] },
    registry: { itemsByName: { bread: { id: 1, name: 'bread' } } },
    pathfinder: { goto: async () => {}, setGoal: () => {} },
    clearControlStates: () => {},
    blockAt: (p) => world.get(`${p.x},${p.y},${p.z}`) || null,
    findBlocks: () => [...world.values()].map((b) => b.position),
    world: null,
  };
  if (client) bot._client = client;
  return bot;
}
const chestBlock = (x, y, z, props = null) => ({ name: 'chest', position: new Vec3(x, y, z), boundingBox: 'block', ...(props ? { getProperties: () => props } : {}) });

test('chest: 選んだ位置にチェストが無くなっていたら、近くの別のチェストは開けない', async () => {
  const world = new Map([['3,64,0', chestBlock(3, 64, 0)]]);
  const bot = chestBot(world);
  let opened = 0;
  bot.openContainer = async () => { opened += 1; return { containerItems: () => [], close: () => {} }; };
  const mem = new Memory();
  mem.extra.containers = { '2,64,0': { name: 'chest', items: [] } };
  const r = await handlers.chest_take(bot, { look: true, pos: { x: 2, y: 64, z: 0 }, block: 'chest' }, { memory: mem });
  assert.ok(!r.ok);
  assert.match(r.msg, /入れ物が無くなっていた/);
  assert.strictEqual(opened, 0);
  assert.ok(!mem.extra.containers['2,64,0']);
});

test('chest: 開いた画面の中身が古い (前の命の作業台の中身) とき、サーバーから新しい中身が届くのを待つ (Jiro)', async () => {
  const world = new Map([['2,64,0', chestBlock(2, 64, 0)]]);
  const client = new EventEmitter();
  const bot = chestBot(world, { client });
  let cur = [{ name: 'wooden_sword', count: 1 }, { name: 'oak_planks', count: 7 }]; // mineflayer が覚えていた古い window_items
  bot.openContainer = async () => {
    const w = { id: 1, containerItems: () => cur, close: () => {} };
    client.emit('open_window', { windowId: 1 });
    setTimeout(() => { cur = [{ name: 'wheat', count: 1 }, { name: 'stick', count: 10 }]; client.emit('window_items', { windowId: 1 }); }, 80);
    return w;
  };
  const mem = new Memory();
  const r = await handlers.chest_take(bot, { look: true, pos: { x: 2, y: 64, z: 0 }, block: 'chest' }, { memory: mem });
  assert.ok(r.ok, r.msg);
  assert.match(r.msg, /中身: wheatx1, stickx10/);
  assert.deepStrictEqual(mem.extra.containers['2,64,0'].items, [{ name: 'wheat', count: 1 }, { name: 'stick', count: 10 }]);
  assert.strictEqual(mem.extra.lastContainer, '2,64,0');
  assert.strictEqual(client.listenerCount('window_items'), 0); // 待ち受けは外す
});

test('chest: ラージチェストは両方の半分の位置で同じ中身を覚える', async () => {
  // 北向き・left の半分 → もう半分は東 (+x)
  const world = new Map([['2,64,0', chestBlock(2, 64, 0, { facing: 'north', type: 'left' })], ['3,64,0', chestBlock(3, 64, 0, { facing: 'north', type: 'right' })]]);
  const bot = chestBot(world);
  assert.deepStrictEqual(chestPair(bot, world.get('2,64,0')), { x: 3, y: 64, z: 0 });
  assert.deepStrictEqual(chestPair(bot, world.get('3,64,0')), { x: 2, y: 64, z: 0 });
  bot.openContainer = async () => ({ containerItems: () => [{ name: 'bread', count: 3 }], close: () => {} });
  const mem = new Memory();
  await handlers.chest_take(bot, { look: true, pos: { x: 2, y: 64, z: 0 }, block: 'chest' }, { memory: mem });
  assert.deepStrictEqual(mem.extra.containers['3,64,0'].items, [{ name: 'bread', count: 3 }]);
  assert.strictEqual(mem.extra.containers['3,64,0'].pair, '2,64,0');
});

// ベッドを置く mock: y<=63 は石、それより上は空気。placeBlock(ref, face) で ref+face に置く (fail で投げる)
function bedBot({ fails = 0, lateOk = false } = {}) {
  const world = new Map();
  const name = (p) => world.get(`${p.x},${p.y},${p.z}`) || (p.y <= 63 ? 'stone' : 'air');
  let left = fails;
  const items = [{ name: 'white_bed', count: 1 }];
  const tried = [];
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5), height: 1.62 },
    inventory: { items: () => items, slots: [] },
    blockAt: (p) => { const n = name(p); return { name: n, position: new Vec3(p.x, p.y, p.z), boundingBox: n === 'air' ? 'empty' : 'block' }; },
    equip: async () => {},
    world: null,
    placeBlock: async (ref, face) => {
      const t = ref.position.plus(face);
      tried.push(`${t.x},${t.y},${t.z}`);
      if (lateOk) { world.set(`${t.x},${t.y},${t.z}`, 'white_bed'); throw new Error(`Event blockUpdate:(${t.x}, ${t.y}, ${t.z}) did not fire within timeout of 5000ms`); }
      if (left > 0) { left -= 1; throw new Error(`Event blockUpdate:(${t.x}, ${t.y}, ${t.z}) did not fire within timeout of 5000ms`); }
      world.set(`${t.x},${t.y},${t.z}`, 'white_bed');
    },
  };
  return { bot, tried, world };
}

test('place: ベッドを置けなかったら (時間切れで置けていない)、別の向きで置き直す (Mai)', async () => {
  const { bot, tried } = bedBot({ fails: 1 });
  const mem = new Memory();
  const r = await handlers.place(bot, { item: 'white_bed' }, { memory: mem, placeCheckMs: 0 });
  assert.ok(r.ok, r.msg);
  assert.strictEqual(tried.length, 2);
  // 1回目と2回目は向きが違う (足の位置が自分から見て別の方向)
  const d = tried.map((k) => k.split(',').map(Number)).map(([x, , z]) => `${Math.sign(x)},${Math.sign(z)}`);
  assert.notStrictEqual(d[0], d[1]);
  assert.match(r.msg, /置き直した/);
  assert.strictEqual(r.retries, 1);
  assert.strictEqual(mem.extra.myBed.name, 'white_bed');
});

test('place: 時間切れでも実際に置けていれば、置けたとする (置き直さない)', async () => {
  const { bot, tried } = bedBot({ lateOk: true });
  const mem = new Memory();
  const r = await handlers.place(bot, { item: 'white_bed' }, { memory: mem, placeCheckMs: 0 });
  assert.ok(r.ok, r.msg);
  assert.strictEqual(tried.length, 1);
  assert.ok(mem.extra.myBed);
});

test('place: 何度試しても置けなければ、試した回数を付けて失敗', async () => {
  const { bot, tried } = bedBot({ fails: 99 });
  const r = await handlers.place(bot, { item: 'white_bed' }, { placeCheckMs: 0, placeTries: 3 });
  assert.ok(!r.ok);
  assert.ok(tried.length <= 3 && tried.length >= 2, String(tried.length));
  assert.match(r.msg, /か所で試した/);
});

test('observe: ベッドを持っていて自分のベッドを置いていなければ「まだ置いていない」(誘導の文は無い)', () => {
  const raw = mockRaw({ inventory: [{ name: 'white_bed', count: 1 }, { name: 'bread', count: 1 }] });
  const ja = summarizeObservation(raw, {});
  assert.match(ja, /white_bed を持っている \(まだ置いていない\)/);
  assert.doesNotMatch(ja, /置くとよい|べき|置こう/);
  assert.doesNotMatch(summarizeObservation(raw, { bedPlaced: true }), /まだ置いていない/);
  assert.match(observationEn(raw, {}).not_placed, /holding white_bed \(not placed yet\)/);
  assert.ok(!('not_placed' in observationEn(raw, { bedPlaced: true })));
  assert.doesNotMatch(summarizeObservation(mockRaw(), {}), /まだ置いていない/);
});
