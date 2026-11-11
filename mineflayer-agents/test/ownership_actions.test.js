'use strict';
// 所有を考えた行動の候補 (src/ownership_actions.js と actions.js の collect の分け方)
const test = require('node:test');
const assert = require('node:assert');
const { listActions, resolveDecision } = require('../src/actions');
const O = require('../src/ownership');
const { ADVICE_EN } = require('../src/en');
const { actionOptions } = require('../src/deciders/jev');

const DIM = 'minecraft:overworld';
const pos = (x, y, z, d) => ({ x, y, z, d: d ?? Math.round(Math.hypot(x, y - 64, z) * 10) / 10 });

function raw(over = {}) {
  return {
    self: { name: 'Yua', pos: { x: 0, y: 64, z: 0 }, health: 20, food: 20, timeOfDay: 6000, phase: '昼' },
    inventory: [],
    blocks: [
      { name: 'torch', notable: false, diggable: true, seen: 2, nearest: pos(2, 64, 0), positions: [pos(2, 64, 0), pos(5, 64, 0)] },
      { name: 'oak_log', notable: true, diggable: true, seen: 1, nearest: pos(4, 64, 3), positions: [pos(4, 64, 3)] },
      { name: 'cobblestone', notable: true, diggable: true, seen: 2, nearest: pos(-3, 64, 0), positions: [pos(-3, 64, 0), pos(-6, 64, 0)] },
      { name: 'crafting_table', notable: true, diggable: true, seen: 1, nearest: pos(0, 64, 4), positions: [pos(0, 64, 4)] },
    ],
    entities: [{ kind: 'player', name: 'Miho', pos: { x: 6, y: 64, z: 0 }, d: 6 }],
    heard: [], craft: { now: [], withTable: [] }, tableNearby: null,
    ...over,
  };
}

function view(k, over = {}) {
  return {
    me: 'Yua', dim: DIM, knowledge: k, cfg: O.cfgOf({ actions: true, penalty: true, ...(over.cfg || {}) }), hearRadius: 48, witnessRadius: 16,
    permit: over.permit || (() => null), askedRecently: over.askedRecently || (() => false),
    needs: { safety: 0.2, greed: 0.5, sleep: 0.1, hunger: 0.2, ...(over.needs || {}) }, temperament: { empathy: 0.6, obedience: 0.5, greed: 0.4 },
    affinity: () => 60, harmFacts: () => ({}),
    altView: { inventory: [], natural: new Set(['oak_log']), mobs: new Set(), hasPickaxe: false },
    owe: over.owe || [], base: over.base || null, goalNames: new Set(),
  };
}

function know() {
  const k = new O.OwnKnowledge({}, { me: 'Yua' });
  k.learn(DIM, [2, 64, 0], { block: 'torch', owner: 'Miho', source: 'seen', tick: 1 }); // ほかの人の物
  k.learn(DIM, [5, 64, 0], { block: 'torch', owner: 'Yua', source: 'self', tick: 1 }); // 自分の物
  k.learn(DIM, [-3, 64, 0], { block: 'cobblestone', owner: 'Ken', kind: 'group', source: 'project', tick: 1 }); // みんなの物 (天然と同じ見た目)
  return k;
}

const names = (acts) => acts.map((a) => a.name);
const ids = (acts, n) => (acts.find((a) => a.name === n) || { choices: [] }).choices.map((c) => c.id);

test('所有を考えない (provenance off): 今までどおり、見えて掘れる物は全部 collect', () => {
  const acts = listActions(raw());
  assert.deepStrictEqual(ids(acts, 'collect').sort(), ['cobblestone', 'crafting_table', 'oak_log', 'torch']);
  assert.ok(!names(acts).includes('take_placed'));
  assert.ok(!acts.ownWeights);
});

test('天然 → collect、自分の物 → dismantle_own、ほかの人・みんなの物 → take_placed、見た目で人工物 (知らない) → take_placed (所有者不明)', () => {
  const acts = listActions(raw(), { own: view(know()) });
  // torch は2か所とも置かれた物 (Miho の・自分の) → collect に出ない。作業台は見た目で人工物。丸石は1か所が天然と見ている
  assert.deepStrictEqual(ids(acts, 'collect').sort(), ['cobblestone', 'oak_log']);
  assert.deepStrictEqual(ids(acts, 'dismantle_own'), ['torch']);
  assert.deepStrictEqual(ids(acts, 'take_placed').sort(), ['cobblestone@group', 'crafting_table@unknown', 'torch@Miho']);
  const t = acts.find((a) => a.name === 'take_placed').choices.find((c) => c.id === 'torch@Miho');
  assert.deepStrictEqual(t.pos, { x: 2, y: 64, z: 0 });
  assert.strictEqual(t.own.owner, 'Miho');
  assert.strictEqual(t.own.category, 'other');
  assert.match(t.labelEn, /placed by Miho; Miho is within earshot/);
  assert.match(t.labelEn, /no other source of this seen/);
  const ct = acts.find((a) => a.name === 'take_placed').choices.find((c) => c.id === 'crafting_table@unknown');
  assert.match(ct.labelEn, /you do not know who/);
  // 重み (reweight のとき agent が掛ける) と判断材料
  assert.ok(acts.ownWeights['take_placed:torch@Miho'] < 1);
  assert.strictEqual(acts.ownInfos['take_placed:torch@Miho'].reason.reasonCode, 'selfish_acquisition');
  assert.strictEqual(acts.ownInfos['take_placed:crafting_table@unknown'].reason.reasonCode, 'unknown_ownership');
  // 選んだら一覧と突き合わせられる
  const r = resolveDecision(acts, 'take_placed', 'torch@Miho');
  assert.ok(r.ok);
  assert.strictEqual(r.choice.block, 'torch');
  // Jev に見せる文に評価語を入れない
  for (const a of acts.filter((x) => ['take_placed', 'dismantle_own', 'ask_permission'].includes(x.name))) {
    assert.ok(!ADVICE_EN.test(a.descEn), a.descEn);
    for (const c of a.choices) assert.ok(!ADVICE_EN.test(c.labelEn), c.labelEn);
  }
});

test('ask_permission: 所有者が分かっていて声の届く所にいる。緊急なら出さない (askInEmergency で出す)。聞いたばかり・答えをもらったら出さない', () => {
  const acts = listActions(raw(), { own: view(know()) });
  assert.deepStrictEqual(ids(acts, 'ask_permission'), ['Miho:torch']);
  const ch = acts.find((a) => a.name === 'ask_permission').choices[0];
  assert.strictEqual(ch.player, 'Miho');
  // 持ち主が遠い
  const far = listActions(raw({ entities: [{ kind: 'player', name: 'Miho', pos: { x: 90, y: 64, z: 0 }, d: 90 }] }), { own: view(know()) });
  assert.deepStrictEqual(ids(far, 'ask_permission'), []);
  assert.doesNotMatch(far.find((a) => a.name === 'take_placed').choices.find((c) => c.id === 'torch@Miho').labelEn, /earshot/);
  // 緊急 (安心 0.95・代わりなし)
  const em = listActions(raw(), { own: view(know(), { needs: { safety: 0.95 } }) });
  assert.deepStrictEqual(ids(em, 'ask_permission'), []);
  assert.strictEqual(em.ownInfos['take_placed:torch@Miho'].reason.reasonCode, 'emergency_need');
  assert.deepStrictEqual(ids(listActions(raw(), { own: view(know(), { needs: { safety: 0.95 }, cfg: { askInEmergency: true } }) }), 'ask_permission'), ['Miho:torch']);
  // 聞いたばかり
  assert.deepStrictEqual(ids(listActions(raw(), { own: view(know(), { askedRecently: () => true }) }), 'ask_permission'), []);
  // 許可をもらった → 理由は permission_granted、文に「取ってよいと言った」
  const ok = listActions(raw(), { own: view(know(), { permit: (p) => (p.x === 2 ? { granted: true, owner: 'Miho' } : null) }) });
  assert.deepStrictEqual(ids(ok, 'ask_permission'), []);
  assert.strictEqual(ok.ownInfos['take_placed:torch@Miho'].reason.reasonCode, 'permission_granted');
  assert.match(ok.find((a) => a.name === 'take_placed').choices.find((c) => c.id === 'torch@Miho').labelEn, /said you may take it/);
  assert.ok(ok.ownWeights['take_placed:torch@Miho'] > acts.ownWeights['take_placed:torch@Miho']);
  // 断られた → 重みがさらに下がる
  const no = listActions(raw(), { own: view(know(), { permit: (p) => (p.x === 2 ? { granted: false, owner: 'Miho' } : null) }) });
  assert.ok(no.ownWeights['take_placed:torch@Miho'] < acts.ownWeights['take_placed:torch@Miho']);
});

test('make_amends: 取った相手が近くにいれば説明・持っていれば返す・取った所に戻す', () => {
  const owe = [{ id: 'Yua-i1', owner: 'Miho', block: 'torch', pos: [1, 64, 1], reasonCode: 'emergency_need', explained: false, returned: false, repaired: false }];
  const acts = listActions(raw({ inventory: [{ name: 'torch', count: 2 }] }), { own: view(know(), { owe }) });
  assert.deepStrictEqual(ids(acts, 'make_amends'), ['explain:Miho', 'return:Miho:torch', 'repair:torch@1,64,1']);
  const none = listActions(raw(), { own: view(know(), { owe: [{ ...owe[0], explained: true }] }) });
  assert.deepStrictEqual(ids(none, 'make_amends'), []); // 説明済み・持っていない
});

test('repair_or_relocate_public: 無くなった共同の物を戻す・拠点から遠い共同の設備を移す', () => {
  const k = know();
  k.learn(DIM, [3, 64, 3], { block: 'torch', owner: 'Ken', kind: 'group', source: 'project', tick: 1, status: 'missing' });
  k.learn(DIM, [0, 64, 4], { block: 'crafting_table', owner: 'Ken', kind: 'public', source: 'project', tick: 1 });
  const acts = listActions(raw({ inventory: [{ name: 'torch', count: 1 }] }), { own: view(k, { base: { x: 60, y: 64, z: 0 } }) });
  assert.deepStrictEqual(ids(acts, 'repair_or_relocate_public').sort(), ['relocate:crafting_table@0,64,4', 'repair:torch@3,64,3']);
  // 拠点の近くに同じ設備がある → 移さない
  k.learn(DIM, [58, 64, 0], { block: 'crafting_table', owner: 'Ken', kind: 'public', source: 'project', tick: 1 });
  assert.deepStrictEqual(ids(listActions(raw(), { own: view(k, { base: { x: 60, y: 64, z: 0 } }) }), 'repair_or_relocate_public'), []);
});

test('Jev の選択肢: take_placed も同じ形 ("行動:引数") で並ぶ', () => {
  const acts = listActions(raw(), { own: view(know()) });
  const { criteria, map } = actionOptions(acts, { twoStage: false, lang: 'en' });
  assert.ok(criteria['take_placed:torch@Miho'].startsWith('take_placed: torch ('));
  assert.deepStrictEqual(map['take_placed:torch@Miho'], { action: 'take_placed', arg: 'torch@Miho' });
  assert.ok(criteria['ask_permission:Miho:torch']);
});
