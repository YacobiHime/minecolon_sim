'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { listActions, actionsToText, resolveDecision } = require('../src/actions');
const { mockRaw } = require('./fixtures');

const names = (acts) => acts.map((a) => a.name);

test('listActions: 掘れるものだけ collect の候補に入る', () => {
  const acts = listActions(mockRaw(), { foods: new Set(['bread']) });
  const coll = acts.find((a) => a.name === 'collect');
  assert.deepStrictEqual(coll.choices.map((c) => c.id), ['spruce_log', 'grass_block']); // stone (道具なし)・water は入らない
});

test('listActions: 作業台が見えないときは作業台の要るレシピを出さない', () => {
  const acts = listActions(mockRaw());
  const craft = acts.find((a) => a.name === 'craft');
  assert.deepStrictEqual(craft.choices.map((c) => c.id), ['spruce_planks']);
  const acts2 = listActions(mockRaw({ tableNearby: { x: 3, y: 64, z: 0, d: 3 } }));
  const craft2 = acts2.find((a) => a.name === 'craft');
  assert.deepStrictEqual(craft2.choices.map((c) => c.id), ['spruce_planks', 'wooden_pickaxe']);
  assert.strictEqual(craft2.choices[1].needsTable, true);
});

test('listActions: 空腹で食べ物があるときだけ eat', () => {
  assert.ok(names(listActions(mockRaw(), { foods: new Set(['bread']) })).includes('eat'));
  const full = mockRaw();
  full.self.food = 20;
  assert.ok(!names(listActions(full, { foods: new Set(['bread']) })).includes('eat'));
});

test('listActions: go_to に見えている目印・記憶の場所・人が入る', () => {
  const mem = [{ id: 'M1', kind: 'crafting_table', pos: { x: 30, y: 64, z: 0 }, d: 30, label: 'crafting_table 東30(30m)' }];
  const go = listActions(mockRaw(), { memPlaces: mem }).find((a) => a.name === 'go_to');
  assert.deepStrictEqual(go.choices.map((c) => c.id), ['spruce_log', 'water', 'M1', 'Hanako']);
});

test('listActions: 常にある行動と、置ける物がないときの place', () => {
  const acts = listActions(mockRaw({ inventory: [] }));
  for (const n of ['explore', 'say', 'look_around', 'wait']) assert.ok(names(acts).includes(n), n);
  assert.ok(!names(acts).includes('place'));
  const acts2 = listActions(mockRaw({ inventory: [{ name: 'crafting_table', count: 1 }] }));
  assert.ok(names(acts2).includes('place'));
});

test('actionsToText: 候補が引数として並ぶ', () => {
  const txt = actionsToText(listActions(mockRaw()));
  assert.match(txt, /- collect: .*arg: spruce_log\(東5北3 6m\) \| grass_block\(東1 1m\)/);
  assert.ok(txt.startsWith('- craft:'), '手元でできる行動が先頭');
  assert.match(txt, /- explore: .*north \| south \| east \| west/);
});

test('listActions: 手の届かない高さだけにあるブロックは collect に出さない', () => {
  const raw = mockRaw();
  raw.blocks[1] = { ...raw.blocks[1], positions: [{ x: 5, y: 70, z: -3, d: 8 }], nearest: { x: 5, y: 70, z: -3, d: 8 } };
  const coll = listActions(raw).find((a) => a.name === 'collect');
  assert.deepStrictEqual(coll.choices.map((c) => c.id), ['grass_block']);
});

test('listActions: 最近続けて失敗した選択は候補から外し、空になった行動は消す', () => {
  const blocked = new Set(['collect:spruce_log', 'collect:grass_block', 'explore:north']);
  const acts = listActions(mockRaw(), { blocked });
  assert.ok(!names(acts).includes('collect'));
  assert.deepStrictEqual(acts.find((a) => a.name === 'explore').choices.map((c) => c.id), ['south', 'east', 'west']);
});

test('resolveDecision: 完全一致・表記ゆれ・候補外・未知の行動', () => {
  const acts = listActions(mockRaw());
  assert.strictEqual(resolveDecision(acts, 'collect', 'spruce_log').choice.block, 'spruce_log');
  const r = resolveDecision(acts, 'Collect', 'minecraft:Spruce_Log');
  assert.ok(r.ok && r.fixed && r.arg === 'spruce_log');
  assert.ok(resolveDecision(acts, 'collect', 'spruce').ok); // 部分一致で1つに決まる
  assert.strictEqual(resolveDecision(acts, 'collect', 'spruce_log[spruce_log 東5北3(6m)]').arg, 'spruce_log'); // 表示を写した
  assert.ok(!resolveDecision(acts, 'collect', 'diamond_ore').ok);
  assert.ok(!resolveDecision(acts, 'fly', '').ok);
  assert.ok(!resolveDecision(acts, 'say', '').ok);
  assert.strictEqual(resolveDecision(acts, 'wait', 'abc').arg, '3');
  assert.strictEqual(resolveDecision(acts, 'wait', '99').arg, '10');
  assert.strictEqual(resolveDecision(acts, 'look_around', 'whatever').arg, '');
});
