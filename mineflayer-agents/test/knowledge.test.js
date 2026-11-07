'use strict';
// 知っていること (knowledge/facts.json) から、今に関係するものだけを選ぶ仕組み
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const knowledge = require('../src/knowledge');
const { loadConfig } = require('../src/config');
const { buildContext } = require('../src/agent');
const { Memory } = require('../src/memory');
const { mockRaw } = require('./fixtures');

const CFG = path.join(__dirname, '..', 'configs', 'survival_3days.json');
const ADVICE = /(とよい|といい|べき|優先|ほうが|方が|おすすめ|勧め|まず|先に|使え|使うと|しよう|しなさい)/;
const F = (id, items = [], actions = [], always = false) => ({ id, text: `${id}の事実。`, items, actions, always });

test('matchName: 完全一致・先頭 * は後方一致・末尾 * は前方一致', () => {
  assert.ok(knowledge.matchName('oak_log', 'oak_log'));
  assert.ok(!knowledge.matchName('oak_log', 'oak_log_x'));
  assert.ok(knowledge.matchName('*_planks', 'jungle_planks'));
  assert.ok(!knowledge.matchName('*_planks', 'planks_box'));
  assert.ok(knowledge.matchName('wooden_*', 'wooden_pickaxe'));
  assert.ok(!knowledge.matchName('wooden_*', 'stone_pickaxe'));
});

test('selectFacts: always は常に、名前・行動に当たったものだけ。上限を超えたら always と当たりの多いものを残す (並びはファイルの順)', () => {
  const facts = [F('a', ['*_log']), F('b', ['stone']), F('c', [], [], true), F('d', ['*_planks', 'stick']), F('e', [], ['smelt'])];
  const names = new Set(['oak_log', 'oak_planks', 'stick']);
  assert.deepStrictEqual(knowledge.selectFacts(facts, { names }).map((f) => f.id), ['a', 'c', 'd']);
  assert.deepStrictEqual(knowledge.selectFacts(facts, { names, actions: new Set(['smelt']) }).map((f) => f.id), ['a', 'c', 'd', 'e']);
  assert.deepStrictEqual(knowledge.selectFacts(facts, { names, max: 2 }).map((f) => f.id), ['c', 'd']);
  assert.deepStrictEqual(knowledge.selectFacts(facts, { names: new Set() }).map((f) => f.id), ['c']);
});

test('namesInView: 持ち物・見えているブロック・生き物 (人は除く)・選択肢の対象・plan の英語名', () => {
  const raw = mockRaw({ entities: [{ kind: 'player', name: 'Hanako' }, { kind: 'mob', name: 'cow' }] });
  const s = knowledge.namesInView({ raw, actions: [{ name: 'craft', choices: [{ id: 'wooden_pickaxe', item: 'wooden_pickaxe' }] }], plan: '(1) furnace を作る' });
  for (const n of ['spruce_log', 'bread', 'grass_block', 'cow', 'wooden_pickaxe', 'furnace']) assert.ok(s.has(n), n);
  assert.ok(!s.has('Hanako'));
});

test('loadFacts: 無い・空・壊れたファイルでも [] で動く', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facts-'));
  assert.deepStrictEqual(knowledge.loadFacts(path.join(dir, 'none.json')), []);
  fs.writeFileSync(path.join(dir, 'empty.json'), '');
  assert.deepStrictEqual(knowledge.loadFacts(path.join(dir, 'empty.json')), []);
  fs.writeFileSync(path.join(dir, 'bad.json'), '{oops');
  assert.deepStrictEqual(knowledge.loadFacts(path.join(dir, 'bad.json')), []);
  fs.writeFileSync(path.join(dir, 'ok.json'), JSON.stringify([{ id: 'x', text: 'X。' }, { id: 'y' }]));
  const f = knowledge.loadFacts(path.join(dir, 'ok.json'));
  assert.strictEqual(f.length, 1);
  assert.deepStrictEqual(f[0].items, []);
});

test('knowledge/facts.json: 形式が合っていて、使い方の指示・評価語を書いていない', () => {
  const facts = JSON.parse(fs.readFileSync(knowledge.DEFAULT_FILE, 'utf8'));
  assert.ok(Array.isArray(facts) && facts.length);
  const ids = new Set();
  for (const f of facts) {
    assert.strictEqual(typeof f.id, 'string');
    assert.ok(!ids.has(f.id), `id が重複: ${f.id}`);
    ids.add(f.id);
    assert.strictEqual(typeof f.text, 'string');
    assert.doesNotMatch(f.text, ADVICE, f.text);
    assert.doesNotMatch(f.text, /小屋|協力/, f.text);
    for (const k of ['items', 'actions']) if (f[k] !== undefined) assert.ok(Array.isArray(f[k]), `${f.id}.${k}`);
  }
});

test('survival_3days: goal.hints は facts.json に移し、二重に出さない。持ち物・見えている物に当たる事実だけ state.knowledge に入る', () => {
  const cfg = loadConfig(CFG, { persona: { name: 'Taro' } });
  assert.deepStrictEqual(cfg.goal.hints, []);
  const ctx = buildContext(mockRaw(), new Memory({ limits: cfg.memory.limits }), cfg, { foods: new Set(['bread']) });
  const texts = ctx.goal.hints;
  assert.ok(texts.length <= cfg.knowledge.max);
  assert.strictEqual(new Set(texts).size, texts.length);
  assert.ok(texts.some((t) => t.includes('原木1個から板材')), '持ち物の spruce_log に当たる');
  assert.ok(texts.some((t) => t.includes('1日はおよそ20分')), 'always');
  assert.ok(!texts.some((t) => t.includes('かまどに燃料')), 'かまど・生の肉が無いので出さない');
  assert.ok(ctx.factsShown.includes('planks_from_log'));
  // knowledge の設定が無い (first_setting など) なら facts.json は使わない
  const cfg2 = loadConfig(null, { persona: { name: 'Taro' }, goal: { text: 'x', hints: ['h1'] } });
  const ctx2 = buildContext(mockRaw(), new Memory(), cfg2, { foods: new Set() });
  assert.deepStrictEqual(ctx2.goal.hints, ['h1']);
  // help.hints false なら出さない
  const cfg3 = loadConfig(CFG, { persona: { name: 'Taro' }, help: { hints: false } });
  assert.deepStrictEqual(buildContext(mockRaw(), new Memory(), cfg3, { foods: new Set() }).goal.hints, []);
});
