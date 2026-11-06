'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { selectScores, effortFactor, GoalPath } = require('../src/goalpath');
const { proposeSchema, parseProposal, Talker } = require('../src/talker');
const { Board } = require('../src/board');
const { mockRaw } = require('./fixtures');
const knowledge = require('../src/knowledge');

test('selectScores: 点 = Σ つらさ × P ÷ (1 + alpha × 手間)。手間の大きい案は同じ P でも下がる', () => {
  const needs = [{ need: 'hunger', distress: 2 }];
  const P = [{ hunger: 0.9 }, { hunger: 0.7 }]; // apple (葉から0.5%) / beef (牛が見える)
  const costs = [50.75, 2];
  const a = selectScores(P, needs, { effort: { alpha: 0 } }, costs);
  assert.strictEqual(a.index, 0);
  const b = selectScores(P, needs, { effort: { alpha: 0.04 } }, costs);
  assert.strictEqual(b.index, 1);
  assert.strictEqual(b.scores[0], Math.round(1.8 * effortFactor(50.75, 0.04) * 1000) / 1000);
  assert.strictEqual(effortFactor(null, 0.04), 1);
});

test('GoalPath: 案ごとに手間 (cost) を出し、record に式・手間・割る前の点・手間で案が変わったかを残す', async () => {
  const goals = JSON.stringify({ goals: [
    { kind: 'item', target: 'apple', count: 1, why: '食べる', need: '空腹' },
    { kind: 'item', target: 'jungle_log', count: 2, why: '木', need: '空腹' },
  ] });
  const llm = { complete: async () => ({ text: goals, promptTokens: 100, completionTokens: 50, finishReason: 'stop' }) };
  const jev = { call: async (state, q) => ({ r: { ok: true, answers: Object.fromEntries(Object.keys(q).map((k) => [k, { noul: state.proposals[k.split('_')[0]].startsWith('obtain apple') ? 0.9 : 0.5 }])) } }) };
  const ev = [];
  const gp = new GoalPath({ llm, jev, log: (e) => ev.push(e), cfg: { select: { enabled: true, k: 2, later: false } } });
  const raw = mockRaw({ inventory: [], blocks: [{ name: 'jungle_log', nearest: { x: 3, y: 64, z: 0, d: 3 } }, { name: 'oak_leaves', nearest: { x: 4, y: 66, z: 0, d: 4 } }], entities: [], heard: [] });
  await gp.update({ persona: { name: 'Taro' }, obsText: 'x', raw, facts: () => [], allFacts: knowledge.loadFacts(), memText: 'なし', people: [], places: [], placeKinds: [], needNow: () => 0.5,
    pressing: () => [{ need: 'hunger', distress: 1.5, ratio: 1.2, textEn: 'hungry' }] }, 1);
  const g = ev.find((e) => e.kind === 'goal');
  const s = g.select;
  assert.match(s.formula, /\/ \(1 \+ 0\.04 \* cost\)/);
  const apple = s.scores.find((x) => x.target === 'apple');
  const log = s.scores.find((x) => x.target === 'jungle_log');
  assert.ok(apple.cost > log.cost * 5, JSON.stringify(s.scores));
  assert.strictEqual(apple.effort, '大');
  assert.ok(apple.noEffort > log.noEffort);
  assert.strictEqual(g.target, 'jungle_log');
  assert.strictEqual(s.effortChanged, true);
});

test('提案: 共有のチェストが無いと kind に rule を出さない。物の名前に手間を添える。物があって集める形は project', () => {
  assert.deepStrictEqual(proposeSchema({ items: ['bread'], chests: [] }).properties.kind.enum, ['project', 'other']);
  assert.deepStrictEqual(proposeSchema({ items: ['bread'], chests: [{ id: 'Ken-1' }] }).properties.kind.enum, ['rule', 'project', 'other']);
  const t = new Talker({ llm: { model: 'm', complete: async () => ({}) } });
  const m = t.proposeMessages({ persona: { name: 'Ken' }, items: ['bread', 'jungle_log'], chests: [], itemEffort: { bread: '中', jungle_log: '小' } });
  assert.match(m[1].content, /bread \(手間: 中\), jungle_log \(手間: 小\)/);
  assert.doesNotMatch(m[0].content, /kind: rule/);
  assert.match(m[1].content, /共有のチェストはまだない/);
  const p = parseProposal('{"kind":"other","item":"jungle_log","chest":"","count":16,"say":"みんなで jungle_log を集めよう"}', { items: ['jungle_log'] });
  assert.deepStrictEqual(p.spec, { type: 'project', item: 'jungle_log', count: 16 });
  const q = parseProposal('{"kind":"rule","item":"bread","chest":"","count":3,"say":"パンを持ち寄ろう"}', { items: ['bread'] });
  assert.strictEqual(q.spec.type, 'project');
  assert.strictEqual(parseProposal('{"kind":"other","item":"","chest":"","count":1,"say":"夜は拠点にいよう"}', {}).spec.type, 'text');
});

test('board: 賛成を聞く提案に、自分がその物を手に入れる手間を事実として添える (評価語なし)', () => {
  const b = new Board({ cfg: { enabled: true }, me: 'Taro' });
  b.receive('Ken', { type: 'propose', id: 'Ken#3', n: 5, spec: { type: 'project', item: 'apple', count: 4 }, text: 'りんごを集めよう' }, { tick: 1 });
  const st = b.stateEn({ me: 'Taro', tick: 2, open: [b.proposals.get('Ken#3')], effortEn: (item, n) => (item === 'apple' && n === 4 ? 'large' : null) });
  assert.match(st.open.q1, /effort for you to get apple x4: large/);
  assert.doesNotMatch(st.open.q1, /should|better|worth/);
});
