'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { Vec3 } = require('vec3');
const { loadConfig } = require('../src/config');
const { buildContext } = require('../src/agent');
const { Memory } = require('../src/memory');
const { SelfGoal, parseGoal } = require('../src/selfgoal');
const { JevDecider } = require('../src/deciders/jev');
const { JevClient } = require('../src/jev_client');
const { handlers, bestWeapon } = require('../src/act');
const { mockRaw } = require('./fixtures');

const CFG = path.join(__dirname, '..', 'configs', 'survival_3days.json');
const ADVICE = /(とよい|といい|べき|優先|ほうが|方が|おすすめ|勧め|まず|先に)/;

test('survival_3days.json: 全体の目標は渡さない。小屋・手順・進み具合は切り、自分で目標を決める', () => {
  const cfg = loadConfig(CFG);
  assert.strictEqual(cfg.goal.text, ''); // 全体の目標は渡さない (3日は実験の長さだけ)
  assert.ok(!cfg.goal.steps || !cfg.goal.steps.length);
  assert.strictEqual(cfg.help.hut, false);
  assert.strictEqual(cfg.help.steps, false);
  assert.strictEqual(cfg.help.progress, false);
  assert.strictEqual(cfg.help.selfGoal, false);
  assert.strictEqual(cfg.help.goalPlan, true);
  assert.strictEqual(cfg.decider.jev.twoStage.enabled, false);
  assert.strictEqual(cfg.act.maxUseChoices, 12);
  assert.strictEqual(cfg.act.maxGiveChoices, 8);
  assert.strictEqual(cfg.world.base, 'self');
  assert.strictEqual(cfg.usage.maxJevInputTokens, 12000000);
  assert.strictEqual(cfg.loop.minutes, 60);
  assert.strictEqual(cfg.personas.length, 5);
  for (const h of cfg.goal.hints) assert.doesNotMatch(h, ADVICE, h);
  for (const h of cfg.goal.hints) assert.doesNotMatch(h, /小屋|協力/, h);
});

function survivalCtx(over = {}, extra = {}, memory = null, cfgOver = {}) {
  const cfg = loadConfig(CFG, { persona: { name: 'Taro' }, ...cfgOver });
  return buildContext(mockRaw(over), memory || new Memory({ limits: cfg.memory.limits }), cfg, { foods: new Set(['bread', 'beef']), ...extra });
}
const names = (acts) => acts.map((a) => a.name);

test('survival の行動一覧: hunt・build は出ず、attack・flee・set_base が出る', () => {
  const ents = [{ kind: 'hostile', name: 'zombie', pos: { x: 6, y: 64, z: 0 }, d: 6 }, { kind: 'mob', name: 'cow', pos: { x: -5, y: 64, z: 0 }, d: 5 }];
  const c = survivalCtx({ entities: ents, inventory: [{ name: 'oak_planks', count: 8 }] });
  const n = names(c.actions);
  assert.ok(!n.includes('hunt') && !n.includes('build'));
  const att = c.actions.find((a) => a.name === 'attack');
  assert.deepStrictEqual(att.choices.map((x) => x.label), ['敵zombie 東6(6m)', 'cow 西5(5m)']);
  assert.match(c.actions.find((a) => a.name === 'flee').choices[0].label, /zombie/);
  assert.ok(n.includes('set_base'));
  // 拠点の近くでは set_base を出さない
  const c2 = survivalCtx({ entities: [] }, { base: { x: 3, y: 64, z: 0 } });
  assert.ok(!names(c2.actions).includes('set_base'));
  // 敵が遠ければ flee は出ない
  const c3 = survivalCtx({ entities: [{ kind: 'hostile', name: 'skeleton', pos: { x: 15, y: 64, z: 0 }, d: 15 }] });
  assert.ok(!names(c3.actions).includes('flee'));
});

test('survival の行動一覧: smelt (かまど・焼ける物・燃料)、sleep (ベッドと夜)、equip (道具・防具)', () => {
  const furnace = { name: 'furnace', notable: true, diggable: false, seen: 1, nearest: { x: 2, y: 64, z: 0, d: 2 }, positions: [] };
  const bed = { name: 'red_bed', notable: true, diggable: false, seen: 1, nearest: { x: -2, y: 64, z: 0, d: 2 }, positions: [] };
  const inv = [{ name: 'beef', count: 3 }, { name: 'oak_planks', count: 4 }, { name: 'stone_sword', count: 1 }, { name: 'leather_helmet', count: 1 }];
  const day = survivalCtx({ blocks: [furnace, bed], inventory: inv, entities: [] });
  const sm = day.actions.find((a) => a.name === 'smelt');
  assert.deepStrictEqual(sm.choices.map((x) => x.id), ['beef']); // 板材は焼く物ではない (燃料になる)
  assert.strictEqual(sm.choices[0].fuel, 'oak_planks');
  assert.ok(!names(day.actions).includes('sleep'), '昼は寝られない');
  const night = survivalCtx({ blocks: [furnace, bed], inventory: inv, entities: [], self: { ...mockRaw().self, timeOfDay: 14000, phase: '夜' } });
  assert.ok(names(night.actions).includes('sleep'));
  const eq = day.actions.find((a) => a.name === 'equip');
  assert.deepStrictEqual(eq.choices.map((x) => x.id), ['stone_sword', 'leather_helmet']);
  // first_setting では survival の行動は出ない
  const fs = loadConfig(path.join(__dirname, '..', 'configs', 'first_setting.json'));
  const cf = buildContext(mockRaw({ blocks: [furnace, bed], inventory: inv }), new Memory({ limits: fs.memory.limits }), fs, { foods: new Set(['bread']) });
  for (const n of ['attack', 'flee', 'smelt', 'sleep', 'equip', 'set_base']) assert.ok(!names(cf.actions).includes(n), n);
});

test('SelfGoal: 最初・済んだ・困った・一定ループで書き直す。2B の出力を json_schema の形で読む', async () => {
  const outs = ['{"goal":"木を集めて道具を作る","steps":["原木を4個集める","板材と棒を作る","木のツルハシを作る"]}', 'こわれた出力', '{"goal":"夜に備えて食べ物を集める","steps":["牛を倒す","肉を焼く"]}'];
  const seen = [];
  const llm = { complete: async (messages, schema) => { seen.push({ messages, schema }); return { text: outs.shift(), promptTokens: 300, completionTokens: 40 }; } };
  const g = new SelfGoal({ llm, cfg: { every: 30 } });
  assert.strictEqual(g.needs(1), 'start');
  const ctx = { persona: { name: 'Taro', personality: 'まじめ' }, goalText: 'この世界で3日生き延びる。', hints: ['原木1個から板材が4個'], obsText: '自分: Taro', memText: '覚えている場所: なし', troubles: [] };
  const u1 = await g.update(ctx, 'start', 1);
  assert.ok(u1.ok);
  assert.strictEqual(g.planText(), '目標: 木を集めて道具を作る / 段取り: (1)原木を4個集める (2)板材と棒を作る (3)木のツルハシを作る');
  assert.deepStrictEqual(seen[0].schema.required, ['goal', 'steps']);
  assert.match(seen[0].messages[0].content, /全体の目標: この世界で3日生き延びる。/);
  assert.strictEqual(g.needs(5, { doneP: 0.2 }), null);
  assert.strictEqual(g.needs(5, { doneP: 0.8 }), 'done');
  assert.strictEqual(g.needs(5, { troubles: [{ key: 'collect:stone' }] }), 'trouble');
  assert.strictEqual(g.needs(31), 'interval');
  // 読めない出力のときは前の目標を続ける
  const u2 = await g.update(ctx, 'interval', 31);
  assert.ok(!u2.ok);
  assert.match(g.planText(), /木を集めて道具を作る/);
  assert.strictEqual(g.needs(40), null); // setAt を更新したので、すぐには書き直さない
  const u3 = await g.update({ ...ctx, troubles: [{ key: 'collect:stone', about: 'stoneの取り方' }] }, 'trouble', 41);
  assert.strictEqual(u3.prev.goal, '木を集めて道具を作る');
  assert.strictEqual(u3.goal, '夜に備えて食べ物を集める');
  assert.match(seen[2].messages[1].content, /## 前の目標\n木を集めて道具を作る \(困っている\)/);
  assert.match(seen[2].messages[1].content, /## 困っていること\nstoneの取り方/);
  assert.strictEqual(g.needs(42, { troubles: [{ key: 'collect:stone' }] }), null); // 同じ困りごとでは書き直さない
  assert.strictEqual(g.history.length, 2);
  assert.strictEqual(parseGoal('{"goal":"","steps":[]}'), null);
});

test('JevDecider: selfGoal のとき plan は自分の目標と書き、goal_done (noul) を聞いて読む', async () => {
  const c = survivalCtx({}, { planText: '目標: 木を集める / 段取り: (1)原木 (2)板材' }, null, { help: { selfGoal: true, goalPlan: false } });
  assert.strictEqual(c.progress, '目標: 木を集める / 段取り: (1)原木 (2)板材');
  const bodies = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body); bodies.push(body);
    const k = Object.keys(body.questions.next_action.criteria)[0];
    return { ok: true, status: 200, headers: new Map(), json: async () => ({ answers: { next_action: { type: 'choice', choice: k, confidence: 0.6 }, remember: { type: 'score', score: 1 }, goal_done: { type: 'noul', noul: 0.85 } }, usage: { input_tokens: 2000, output_tokens: 10 } }) };
  };
  const d = new JevDecider({ client: new JevClient({ apiKey: 'k', fetch }) });
  const r = await d.decide(c);
  assert.strictEqual(r.jev.goalDoneP, 0.85);
  assert.ok(bodies[0].questions.goal_done);
  assert.match(bodies[0].questions.next_action.instructions, /the goal `you` set for yourself/);
  assert.doesNotMatch(bodies[0].questions.next_action.instructions, /次はこれ/);
  assert.strictEqual(bodies[0].state.plan, c.progress);
});

// act の mock: pathfinder はすぐ着く
function actBot(over = {}) {
  const items = over.items || [];
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5), height: 1.62 },
    inventory: { items: () => items },
    registry: { itemsByName: { beef: { id: 1 }, oak_planks: { id: 2 }, cooked_beef: { id: 3 } } },
    pathfinder: { goto: async () => {}, setGoal: () => {} },
    clearControlStates: () => {},
    equipped: [],
    equip: async (it, dest) => { bot.equipped.push([it.name, dest]); },
    ...over,
  };
  return bot;
}

test('act: bestWeapon は剣 > 斧・素材の順、equip は防具を体に・道具を手に', async () => {
  const bot = actBot({ items: [{ name: 'wooden_sword', count: 1 }, { name: 'stone_axe', count: 1 }, { name: 'stone_sword', count: 1 }, { name: 'iron_helmet', count: 1 }] });
  assert.strictEqual(bestWeapon(bot).name, 'stone_sword');
  assert.ok((await handlers.equip(bot, { item: 'iron_helmet' })).ok);
  assert.ok((await handlers.equip(bot, { item: 'stone_axe' })).ok);
  assert.deepStrictEqual(bot.equipped, [['iron_helmet', 'head'], ['stone_axe', 'hand']]);
  assert.ok(!(await handlers.equip(bot, { item: 'diamond_sword' })).ok);
});

test('act: smelt はかまどに燃料と焼く物を入れ、焼けたら取り出し、かまどの場所を覚える', async () => {
  const calls = [];
  let out = null;
  const furnace = {
    fuelItem: () => null,
    putFuel: async (id, md, n) => { calls.push(['fuel', id, n]); },
    putInput: async (id, md, n) => { calls.push(['input', id, n]); setTimeout(() => { out = { name: 'cooked_beef', count: n }; }, 50); },
    outputItem: () => out,
    takeOutput: async () => { calls.push(['take']); },
    close: () => calls.push(['close']),
  };
  const bot = actBot({ items: [{ name: 'beef', count: 2 }, { name: 'oak_planks', count: 4 }], blockAt: (p) => ({ name: 'furnace', position: new Vec3(p.x, p.y, p.z) }), openFurnace: async () => furnace });
  const mem = new Memory();
  const r = await handlers.smelt(bot, { item: 'beef', fuel: 'oak_planks', burns: 1.5, furnace: { x: 2, y: 64, z: 0 } }, { memory: mem, smeltWaitMs: 2000 });
  assert.ok(r.ok, r.msg);
  assert.match(r.msg, /cooked_beefを2個取り出した/);
  assert.deepStrictEqual(calls, [['fuel', 2, 2], ['input', 1, 2], ['take'], ['close']]);
  assert.ok(mem.places.some((p) => p.kind === 'furnace'));
  // 焼けないうちに時間切れ → 入れたまま離れる
  out = null;
  const furnace2 = { ...furnace, putInput: async () => {}, outputItem: () => null };
  const r2 = await handlers.smelt({ ...bot, openFurnace: async () => furnace2 }, { item: 'beef', fuel: 'oak_planks', burns: 1.5, furnace: { x: 2, y: 64, z: 0 } }, { smeltWaitMs: 600 });
  assert.ok(!r2.ok);
  assert.match(r2.msg, /まだ焼けていない/);
});

test('act: sleep はベッドで寝て、起きたら夜が明けたと返す。明けなければ起きて戻る', async () => {
  const mk = (wakeAfter) => {
    const bot = actBot({ blockAt: (p) => ({ name: 'red_bed', position: new Vec3(p.x, p.y, p.z) }), isABed: () => true, isSleeping: false, time: { timeOfDay: 100 } });
    bot.sleep = async () => { bot.isSleeping = true; if (wakeAfter) setTimeout(() => { bot.isSleeping = false; }, wakeAfter); };
    bot.wake = async () => { bot.isSleeping = false; bot.woke = true; };
    return bot;
  };
  const r = await handlers.sleep(mk(100), { pos: { x: 1, y: 64, z: 0 } }, { sleepWaitMs: 2000, wakeTimeWaitMs: 10 });
  assert.ok(r.ok);
  assert.strictEqual(r.sleep.nightSkipped, true);
  const b2 = mk(0);
  const r2 = await handlers.sleep(b2, { pos: { x: 1, y: 64, z: 0 } }, { sleepWaitMs: 600 });
  assert.strictEqual(r2.sleep.nightSkipped, false);
  assert.ok(b2.woke);
});

test('act: set_base は agent の setBase を呼ぶ', async () => {
  const r = await handlers.set_base({}, {}, { setBase: () => ({ x: 1, y: 64, z: 2 }) });
  assert.ok(r.ok);
  assert.match(r.msg, /ここ\(1,64,2\)を拠点にした/);
});
