'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Planner, pathText, pathEn } = require('../src/planner');
const states = require('../src/states');
const { itemCandidates } = require('../src/vocab');
const { useTargets } = require('../src/actions_more');
const knowledge = require('../src/knowledge');

const W = { inventory: [], visibleBlocks: ['grass', 'jungle_log', 'water'], visibleMobs: [], knownBlocks: [], stations: {} };

test('planner: bread は 種 → 耕す → 植える → 育ったら取る → 作る の道筋。育ち途中が植わっていれば待つだけ、育ちきった分は取る', () => {
  const p = new Planner(W).plan('bread', 1);
  assert.ok(p.ok);
  const farm = p.steps.find((s) => s.how === 'farm');
  assert.deepStrictEqual({ item: farm.item, count: farm.count, plants: farm.plants, till: farm.till, seed: farm.seed, tool: farm.tool }, { item: 'wheat', count: 3, plants: 3, till: 3, seed: 'wheat_seeds', tool: 'wooden_hoe' });
  const seeds = p.steps.find((s) => s.item === 'wheat_seeds');
  assert.strictEqual(seeds.from, 'grass');
  assert.ok(p.steps.indexOf(seeds) < p.steps.indexOf(farm));
  assert.match(pathText(p, { maxShown: 20 }), /wheat 3 ← 耕す 3 \(wooden_hoe を土に\) → wheat_seeds 3 を耕地に植える → 育ったら wheat を壊して取る/);
  // 種とクワを持っていて、空いた耕地が2マス → 耕すのは1
  const q = new Planner({ ...W, inventory: [{ name: 'wheat_seeds', count: 3 }, { name: 'wooden_hoe', count: 1 }], farm: { empty: 2 } }).plan('wheat', 3);
  const f2 = q.steps.find((s) => s.how === 'farm');
  assert.strictEqual(f2.till, 1);
  assert.strictEqual(q.next.how, 'farm');
  assert.match(pathEn(q).next, /till dirt into farmland with wooden_hoe/);
  // 植わっている (育ち途中) → 待つだけ
  const g = new Planner({ ...W, visibleBlocks: [...W.visibleBlocks, 'wheat'], farm: { growing: { wheat: 3 } } }).plan('wheat', 3);
  assert.strictEqual(g.steps.length, 1);
  assert.match(pathText(g), /植わっている wheat 3 → 育ったら wheat を壊して取る/);
  // 育ちきった1本 + 育ち途中2本
  const r = new Planner({ ...W, visibleBlocks: [...W.visibleBlocks, 'wheat'], farm: { growing: { wheat: 2 }, ripe: { wheat: 1 } } }).plan('wheat', 3);
  assert.deepStrictEqual(r.steps.map((s) => [s.how, s.count]), [['collect', 1], ['farm', 2]]);
  // 育ち途中しか見えていない作物を「掘って取る」にはしない
  const v = new Planner({ ...W, visibleBlocks: [...W.visibleBlocks, 'wheat'], farm: { growing: { wheat: 1 } } }).plan('wheat', 3);
  assert.ok(!v.steps.some((s) => s.how === 'collect' && s.from === 'wheat'));
});

test('planner: にんじんは持っているときだけ畑の道筋 (植えて増やす回数)', () => {
  const none = new Planner(W).plan('carrot', 5);
  assert.ok(!none.ok || !none.steps.some((s) => s.how === 'farm'));
  const p = new Planner({ ...W, inventory: [{ name: 'carrot', count: 1 }, { name: 'wooden_hoe', count: 1 }] }).plan('carrot', 5);
  const f = p.steps.find((s) => s.how === 'farm');
  assert.ok(f && f.plants === 1 && f.rounds >= 2, JSON.stringify(f));
});

function fakeWorld(map) { return (x, y, z) => map.get(`${x},${y},${z}`) || null; }

test('states.farmStatus と planted のゴール: 空いた耕地・育ち途中・育ちきった を数え、足りない分を 種 + 耕す + 植える の道筋に', () => {
  const m = new Map();
  for (let i = 0; i < 4; i++) m.set(`${i},63,0`, { name: 'farmland' });
  m.set('0,64,0', { name: 'wheat', getProperties: () => ({ age: 7 }) });
  m.set('1,64,0', { name: 'wheat', getProperties: () => ({ age: 3 }) });
  m.set('2,64,0', { name: 'air' });
  const blockAt = fakeWorld(m);
  const f = states.farmStatus(blockAt, { x: 0, y: 64, z: 0 });
  assert.strictEqual(f.farmland, 4);
  assert.strictEqual(f.empty, 2);
  assert.deepStrictEqual(f.ripe, { wheat: 1 });
  assert.deepStrictEqual(f.growing, { wheat: 1 });
  const st = states.parseStateId('planted_wheat');
  assert.deepStrictEqual(st, { type: 'planted', crop: 'wheat', seed: 'wheat_seeds' });
  const status = states.senseState(st, { blockAt, here: { x: 0, y: 64, z: 0 } });
  assert.strictEqual(status.have, 2);
  const p = states.planState(st, 5, W, status);
  assert.ok(p.ok);
  const acts = p.acts.map((a) => a.how);
  assert.deepStrictEqual(acts, ['till', 'plant']);
  assert.strictEqual(p.acts[0].count, 1); // 3本足りない、空き2 → 耕すのは1
  assert.ok(p.items.steps.some((s) => s.item === 'wheat_seeds' && s.count === 3));
  assert.match(states.actText(p.acts[1]), /wheat_seeds 3 を耕地に植える/);
  // 候補: 種を持っていれば planted_carrots も出る
  const cands = states.stateCandidates({ world: W, sense: { blockAt, here: { x: 0, y: 64, z: 0 } }, raw: { inventory: [{ name: 'carrot', count: 2 }], entities: [] } });
  const pw = cands.find((c) => c.name === 'planted_wheat');
  assert.match(pw.desc, /近くの耕地に wheat が8本植わっている。今2本。空いている耕地2マス/);
  assert.ok(cands.some((c) => c.name === 'planted_carrots'));
});

test('use_on の対象に、空いた耕地・育ちきった作物・覚えている耕地 (M番号) が入る (id は name@所)', () => {
  const raw = { self: { pos: { x: 0, y: 64, z: 0 } }, blocks: [], entities: [] };
  const t = useTargets(raw, { farmTargets: [{ name: 'farmland', idName: 'farmland@empty', pos: { x: 2, y: 63, z: 0 }, note: '空いている' }, { name: 'farmland', idName: 'farmland@M2', pos: { x: 20, y: 63, z: 5 }, note: '覚えている所 M2' }] });
  assert.deepStrictEqual(t.map((x) => x.idName), ['farmland@empty', 'farmland@M2']);
  assert.match(t[1].label, /farmland\(覚えている所 M2\)/);
});

test('物の候補: 草が見える・種を持つと wheat と bread が入る。知っていること: 種を持つ人に farm_plant・crop_time', () => {
  const raw = { self: { pos: { x: 0, y: 64, z: 0 } }, inventory: [{ name: 'wheat_seeds', count: 2 }], blocks: [{ name: 'grass', nearest: { x: 2, y: 64, z: 0, d: 2 } }], entities: [] };
  const c = itemCandidates({ raw, facts: knowledge.loadFacts(), maxItems: 40 });
  const bread = c.find((x) => x.name === 'bread');
  assert.ok(bread, c.map((x) => x.name).join(','));
  assert.match(bread.desc, /wheat_seeds を耕地に植えると育つ/);
  const facts = knowledge.selectFacts(knowledge.loadFacts(), { names: knowledge.namesInView({ raw }), max: 12 }).map((f) => f.id);
  for (const id of ['farm_plant', 'crop_time']) assert.ok(facts.includes(id), facts.join(','));
  // 耕地を覚えている人 (名前に farmland が入る) にも畑の事実
  const f2 = knowledge.selectFacts(knowledge.loadFacts(), { names: new Set(['farmland']), max: 12 }).map((f) => f.id);
  assert.ok(f2.includes('farm_plant') && f2.includes('crop_time'));
});
