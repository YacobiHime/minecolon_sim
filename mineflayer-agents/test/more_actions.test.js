'use strict';
// 右クリックで使う・GUI の出し入れ・協力の行動 (actions_more.js / act_more.js) と knowledge/facts.json
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { Vec3 } = require('vec3');
const { listActions } = require('../src/actions');
const { moreActions, useTargets, MORE_ACTIONS, MAX_CHOICES } = require('../src/actions_more');
const { handlers, DEFAULT_TIMEOUTS } = require('../src/act');
const { changeText } = require('../src/act_more');
const { Memory } = require('../src/memory');
const { loadConfig } = require('../src/config');
const { buildContext } = require('../src/agent');
const { mockRaw } = require('./fixtures');

const all = () => true;
const blk = (name, x, y, z, d, extra = {}) => ({ name, notable: false, diggable: true, seen: 1, nearest: { x, y, z, d }, positions: [{ x, y, z, d }], ...extra });

test('more: 新しい行動はどれも実行の handler とタイムアウトを持つ', () => {
  for (const n of MORE_ACTIONS) {
    assert.strictEqual(typeof handlers[n], 'function', n);
    assert.ok(DEFAULT_TIMEOUTS[n] > 0, n);
  }
});

test('more: 設定の act.enable に入れたものだけ出る (first_setting の一覧は変わらない)', () => {
  const raw = mockRaw();
  const plain = listActions(raw, {});
  assert.ok(!plain.some((a) => MORE_ACTIONS.includes(a.name)));
  const on = listActions(raw, { enable: new Set(['use_on', 'give', 'follow', 'call']) });
  for (const n of ['use_on', 'give', 'follow', 'call']) assert.ok(on.some((a) => a.name === n), n);
});

test('more: use_on は 持ち物と素手 × 見えている対象。近い物 + 目印 + 生き物で、作物は育ちきった所を指す', () => {
  const raw = mockRaw({
    inventory: [{ name: 'wooden_hoe', count: 1 }, { name: 'wheat_seeds', count: 3 }],
    blocks: [
      blk('grass_block', 1, 63, 0, 1.4),
      { ...blk('wheat', 3, 64, 0, 3), positions: [{ x: 3, y: 64, z: 0, d: 3, ripe: false }, { x: 4, y: 64, z: 0, d: 4, ripe: true }], ripe: 1 },
      blk('water', -9, 63, 0, 9, { notable: true }),
      blk('stone', 0, 70, 0, 6), // 手の届かない高さ
    ],
    entities: [{ kind: 'mob', name: 'cow', id: 7, pos: { x: 5, y: 64, z: 5 }, d: 7 }, { kind: 'mob', name: 'cow', id: 8, pos: { x: 9, y: 64, z: 5 }, d: 10 }, { kind: 'player', name: 'Hanako', pos: { x: 1, y: 64, z: 1 }, d: 1.4 }],
  });
  const t = useTargets(raw, {});
  assert.deepStrictEqual(t.map((x) => x.name), ['grass_block', 'wheat', 'water', 'cow']);
  assert.deepStrictEqual(t.find((x) => x.name === 'wheat').pos, { x: 4, y: 64, z: 0 });
  assert.match(t.find((x) => x.name === 'wheat').label, /育ちきった/);
  const a = moreActions(raw, {}, all).find((x) => x.name === 'use_on');
  assert.strictEqual(a.choices.length, 3 * 4); // 素手 + 2種 × 4
  const c = a.choices.find((x) => x.id === 'wooden_hoe>grass_block');
  assert.strictEqual(c.targetKind, 'block');
  assert.strictEqual(a.choices.find((x) => x.id === 'wheat_seeds>cow').entityId, 7);
  assert.ok(a.choices.some((x) => x.id === 'hand>wheat'));
  // 使い方を教える言葉は書かない
  for (const x of a.choices) assert.doesNotMatch(x.label, /耕す|植える|とよい|べき/);
});

test('more: use_on の候補は上限を超えない (遠い対象から落とす)', () => {
  const inventory = Array.from({ length: 40 }, (_, i) => ({ name: `item${i}`, count: 1 }));
  const blocks = Array.from({ length: 12 }, (_, i) => blk(`b${i}`, i, 64, 0, i + 1, { notable: i % 2 === 0 }));
  const raw = mockRaw({ inventory, blocks, entities: [] });
  const a = moreActions(raw, { maxUseChoices: 300 }, all).find((x) => x.name === 'use_on');
  assert.ok(a.choices.length <= MAX_CHOICES);
  const a2 = moreActions(raw, { maxUseChoices: 100 }, all).find((x) => x.name === 'use_on');
  assert.ok(a2.choices.length <= 100);
  assert.ok(a2.choices.some((x) => x.target === 'b0'));
});

test('more: chest_take は中身を知らなければ「中を見る」、知っていればその中身。空と分かったかまどは出さない', () => {
  const raw = mockRaw({ blocks: [blk('chest', 2, 64, 0, 2), blk('furnace', -2, 64, 0, 2)], inventory: [{ name: 'beef', count: 2 }] });
  let acts = moreActions(raw, {}, all);
  assert.deepStrictEqual(acts.find((a) => a.name === 'chest_take').choices.map((c) => c.id), ['look']);
  assert.deepStrictEqual(acts.find((a) => a.name === 'chest_put').choices.map((c) => c.id), ['beef']);
  assert.deepStrictEqual(acts.find((a) => a.name === 'furnace_take').choices.map((c) => c.id), ['output', 'all']);
  const containers = { '2,64,0': { name: 'chest', items: [{ name: 'bread', count: 3 }] }, '-2,64,0': { name: 'furnace', items: [] } };
  acts = moreActions(raw, { containers }, all);
  assert.deepStrictEqual(acts.find((a) => a.name === 'chest_take').choices.map((c) => c.id), ['bread']);
  assert.ok(!acts.some((a) => a.name === 'furnace_take'));
});

test('more: trade は一覧を見る → 覚えた取引を選ぶ。follow / give / call は見えている人', () => {
  const ents = [{ kind: 'mob', name: 'villager', id: 42, pos: { x: 3, y: 64, z: 0 }, d: 3 }, { kind: 'player', name: 'Hanako', pos: { x: -4, y: 64, z: 4 }, d: 5.7 }];
  const raw = mockRaw({ entities: ents, inventory: [{ name: 'emerald', count: 2 }, { name: 'bread', count: 1 }] });
  let acts = moreActions(raw, {}, all);
  assert.deepStrictEqual(acts.find((a) => a.name === 'trade').choices.map((c) => c.id), ['42:look']);
  const trades = { 42: { trades: [{ i: 0, in1: { name: 'emerald', count: 1 }, in2: null, out: { name: 'bread', count: 6 } }, { i: 1, in1: { name: 'emerald', count: 5 }, out: { name: 'bell', count: 1 } }, { i: 2, in1: { name: 'wheat', count: 20 }, out: { name: 'emerald', count: 1 }, disabled: true }] } };
  acts = moreActions(raw, { trades }, all);
  const tr = acts.find((a) => a.name === 'trade');
  assert.deepStrictEqual(tr.choices.map((c) => c.id), ['42:0', '42:1']);
  assert.match(tr.choices[0].label, /emeraldx1 → breadx6/);
  assert.match(tr.choices[1].label, /材料が足りない/);
  assert.deepStrictEqual(acts.find((a) => a.name === 'follow').choices.map((c) => c.id), ['Hanako']);
  assert.deepStrictEqual(acts.find((a) => a.name === 'give').choices.map((c) => c.id), ['Hanako:emerald:1', 'Hanako:emerald:all', 'Hanako:bread:1']);
  assert.deepStrictEqual(acts.find((a) => a.name === 'call').choices.map((c) => c.id), ['Hanako']);
  // 聞こえない所の人は呼べない
  const far = moreActions(mockRaw({ entities: [{ kind: 'player', name: 'Ken', pos: { x: 30, y: 64, z: 0 }, d: 30 }] }), { hearRadius: 24 }, all);
  assert.ok(!far.some((a) => a.name === 'call'));
});

test('more: enchant / brew / anvil / dismount は道具と台がそろったときだけ', () => {
  const raw = mockRaw({
    self: { ...mockRaw().self, vehicle: 'oak_boat', level: 5 },
    blocks: [blk('enchanting_table', 2, 64, 0, 2), blk('brewing_stand', 3, 64, 0, 3), blk('anvil', 4, 64, 0, 4)],
    inventory: [{ name: 'iron_sword', count: 1 }, { name: 'lapis_lazuli', count: 2 }, { name: 'potion', count: 2 }, { name: 'nether_wart', count: 1 }, { name: 'enchanted_book', count: 1 }],
  });
  const acts = moreActions(raw, {}, all);
  assert.deepStrictEqual(acts.find((a) => a.name === 'enchant').choices.map((c) => c.id), ['iron_sword:1', 'iron_sword:2']);
  assert.deepStrictEqual(acts.find((a) => a.name === 'brew').choices.map((c) => c.id), ['nether_wart']);
  assert.match(acts.find((a) => a.name === 'brew').desc, /ブレイズパウダーを持っていない/);
  assert.deepStrictEqual(acts.find((a) => a.name === 'anvil').choices.map((c) => c.id), ['iron_sword+enchanted_book']);
  assert.ok(acts.some((a) => a.name === 'dismount'));
  const none = moreActions(mockRaw({ inventory: [{ name: 'iron_sword', count: 1 }] }), {}, all);
  assert.ok(!none.some((a) => ['enchant', 'brew', 'anvil', 'dismount'].includes(a.name)));
});

test('more: 続けて失敗した組み合わせ (blocked) は出さない', () => {
  const raw = mockRaw({ inventory: [{ name: 'bread', count: 1 }] });
  const acts = moreActions(raw, { blocked: new Set(['give:Hanako:bread:1', 'follow:Hanako']) }, all);
  assert.ok(!acts.some((a) => a.name === 'give'));
  assert.ok(!acts.some((a) => a.name === 'follow'));
});

test('more: changeText はブロック・持ち物・乗り物の変わりようを書く', () => {
  const a = { block: { name: 'grass_block', state: 1, props: {} }, nb: 'air', inv: { wooden_hoe: 1 }, vehicle: null, food: 10, health: 20 };
  assert.strictEqual(changeText(a, { ...a, block: { name: 'farmland', state: 2, props: {} } }), 'grass_blockがfarmlandになった');
  const door = { ...a, block: { name: 'oak_door', state: 5, props: { open: false } } };
  assert.match(changeText(door, { ...door, block: { name: 'oak_door', state: 6, props: { open: true } } }), /open:false→true/);
  assert.strictEqual(changeText(a, { ...a, inv: { wooden_hoe: 1, white_wool: 2 } }), '持ち物 white_wool+2');
  assert.strictEqual(changeText(a, { ...a, vehicle: 'oak_boat' }), 'oak_boatに乗った');
  assert.strictEqual(changeText(a, { ...a, nb: 'water' }), '隣にwaterができた');
  assert.strictEqual(changeText(a, a), '');
});

// act の mock
function mkBot(over = {}) {
  let items = over.items || [];
  const reg = { itemsByName: {}, blocksByName: {} };
  for (const [i, n] of ['bread', 'beef', 'emerald', 'cooked_beef', 'coal', 'wheat'].entries()) reg.itemsByName[n] = { id: i + 1, name: n };
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5), height: 1.62 },
    inventory: { items: () => items, slots: [], emptySlotCount: () => 30 },
    setItems: (x) => { items = x; },
    registry: reg,
    entities: {},
    players: {},
    world: null,
    pathfinder: { goto: async () => {}, setGoal: () => {} },
    clearControlStates: () => {},
    equip: async () => {},
    lookAt: async () => {},
    findBlocks: () => [],
    ...over,
  };
  return bot;
}

test('act more: chest_take は開けて中身を覚え、選んだ物を取り出す / 見るだけもできる', async () => {
  let content = [{ name: 'bread', count: 3 }];
  const bot = mkBot({
    blockAt: (p) => ({ name: 'chest', position: new Vec3(p.x, p.y, p.z), boundingBox: 'block' }),
  });
  bot.openContainer = async () => ({
    containerItems: () => content,
    withdraw: async (id, md, n) => { content = []; bot.setItems([{ name: 'bread', count: n }]); },
    close: () => {},
  });
  const mem = new Memory();
  const look = await handlers.chest_take(bot, { look: true, pos: { x: 2, y: 64, z: 0 }, block: 'chest' }, { memory: mem });
  assert.ok(look.ok);
  assert.match(look.msg, /中身: breadx3/);
  assert.deepStrictEqual(mem.extra.containers['2,64,0'].items, [{ name: 'bread', count: 3 }]);
  const r = await handlers.chest_take(bot, { item: 'bread', pos: { x: 2, y: 64, z: 0 }, block: 'chest' }, { memory: mem });
  assert.ok(r.ok, r.msg);
  assert.match(r.msg, /breadを3個取り出した/);
  assert.deepStrictEqual(mem.extra.containers['2,64,0'].items, []);
});

test('act more: furnace_take は出来上がった物を取り出し、残りを覚える', async () => {
  let out = { name: 'cooked_beef', count: 2 };
  const bot = mkBot({ blockAt: (p) => ({ name: 'furnace', position: new Vec3(p.x, p.y, p.z), boundingBox: 'block' }) });
  bot.openFurnace = async () => ({
    outputItem: () => out, inputItem: () => ({ name: 'beef', count: 1 }), fuelItem: () => null,
    takeOutput: async () => { bot.setItems([{ name: 'cooked_beef', count: 2 }]); out = null; },
    close: () => {},
  });
  const mem = new Memory();
  const r = await handlers.furnace_take(bot, { what: 'output', pos: { x: 1, y: 64, z: 0 } }, { memory: mem });
  assert.ok(r.ok, r.msg);
  assert.match(r.msg, /cooked_beef\+2/);
  assert.match(r.msg, /焼く前:beefx1/);
  assert.deepStrictEqual(mem.extra.containers['1,64,0'].items, [{ slot: '焼く前', name: 'beef', count: 1 }]);
});

test('act more: give は近くへ行って投げる、call は名前と場所を言う、follow は見えない人には失敗', async () => {
  const tossed = [];
  const hanako = { id: 5, name: 'player', position: new Vec3(2, 64, 0) };
  const bot = mkBot({ items: [{ name: 'bread', count: 3 }], toss: async (id, md, n) => { tossed.push([id, n]); } });
  bot.players = { Hanako: { entity: hanako } };
  bot.entities = { 5: hanako };
  const r = await handlers.give(bot, { player: 'Hanako', item: 'bread', count: 2 }, {});
  assert.ok(r.ok, r.msg);
  assert.deepStrictEqual(tossed, [[1, 2]]);
  const said = [];
  const c = await handlers.call(bot, { player: 'Hanako' }, { chat: (t, o) => { said.push([t, o]); return true; } });
  assert.ok(c.ok);
  assert.match(said[0][0], /^Hanako、来て \(0,64,0\)$/);
  assert.deepStrictEqual(said[0][1], { force: true });
  const f = await handlers.follow(bot, { player: 'Ken' }, {});
  assert.ok(!f.ok);
});

test('act more: use_on (ブロック) は使って何が変わったかを返し、変わらなければ持ち物そのものを使う', async () => {
  let name = 'water';
  let items = [{ name: 'bucket', count: 1, type: 9 }];
  const bot = mkBot({
    blockAt: (p) => (p.y === 63 ? { name, position: new Vec3(p.x, p.y, p.z), boundingBox: 'empty', stateId: name === 'water' ? 1 : 2, getProperties: () => ({}) } : { name: 'air', position: new Vec3(p.x, p.y, p.z), boundingBox: 'empty' }),
  });
  bot.inventory.items = () => items;
  const calls = [];
  bot.activateBlock = async () => { calls.push('block'); };
  bot.activateItem = () => { calls.push('item'); items = [{ name: 'water_bucket', count: 1, type: 10 }]; name = 'air'; };
  bot.deactivateItem = () => {};
  const r = await handlers.use_on(bot, { item: 'bucket', target: 'water', targetKind: 'block', pos: { x: 2, y: 63, z: 0 } }, {});
  assert.ok(r.ok, r.msg);
  assert.deepStrictEqual(calls, ['block', 'item']);
  assert.match(r.msg, /waterがairになった/);
  assert.match(r.msg, /water_bucket\+1/);
  // 何も起きなければ失敗
  const bot2 = mkBot({ items: [{ name: 'bread', count: 1 }], blockAt: (p) => ({ name: 'stone', position: new Vec3(p.x, p.y, p.z), boundingBox: 'block', stateId: 1, getProperties: () => ({}) }) });
  bot2.activateBlock = async () => {}; bot2.activateItem = () => {}; bot2.deactivateItem = () => {};
  const r2 = await handlers.use_on(bot2, { item: 'bread', target: 'stone', targetKind: 'block', pos: { x: 1, y: 64, z: 0 } }, {});
  assert.ok(!r2.ok);
  assert.match(r2.msg, /何も起きなかった/);
});

test('survival_3days: 新しい行動を enable し、作れる物・置ける物は全部', () => {
  const cfg = loadConfig(path.join(__dirname, '..', 'configs', 'survival_3days.json'), { persona: { name: 'Taro' } });
  for (const n of MORE_ACTIONS) assert.ok(cfg.act.enable.includes(n), n);
  assert.strictEqual(cfg.craftables, 'all');
  const raw = mockRaw({ entities: [{ kind: 'player', name: 'Hanako', pos: { x: -4, y: 64, z: 4 }, d: 5.7 }] });
  const ctx = buildContext(raw, new Memory({ limits: cfg.memory.limits }), cfg, { foods: new Set(['bread']) });
  for (const n of ['use_on', 'use_item', 'give', 'follow', 'call']) assert.ok(ctx.actions.some((a) => a.name === n), n);
  for (const a of ctx.actions) if (a.choices) assert.ok(a.choices.length <= MAX_CHOICES, a.name);
});

test('knowledge/facts.json: 形式・id が重ならない・評価語や使い方の指示を書かない', () => {
  const facts = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'knowledge', 'facts.json'), 'utf8'));
  assert.ok(Array.isArray(facts) && facts.length >= 50);
  const ids = new Set();
  const ADVICE = /(とよい|といい|べき|優先|ほうが|方が|おすすめ|勧め|まず|先に|しよう|しましょう|大切|重要)/;
  for (const f of facts) {
    assert.match(f.id, /^[a-z][a-z0-9_]*$/, f.id);
    assert.ok(!ids.has(f.id), `id が重なる: ${f.id}`);
    ids.add(f.id);
    assert.strictEqual(typeof f.text, 'string');
    assert.doesNotMatch(f.text, ADVICE, f.id);
    assert.ok(Array.isArray(f.items) && Array.isArray(f.actions) && typeof f.always === 'boolean', f.id);
    for (const it of f.items) assert.match(it, /^\*?[a-z0-9_]+\*?$/, `${f.id}: ${it}`);
  }
});
