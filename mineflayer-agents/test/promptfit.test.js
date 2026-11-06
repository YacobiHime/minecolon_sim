'use strict';
const test = require('node:test');
const assert = require('node:assert');
const promptfit = require('../src/promptfit');
const { GoalPath, rankPeople } = require('../src/goalpath');
const knowledge = require('../src/knowledge');
const { mockRaw } = require('./fixtures');

test('promptfit: 見積もりが予算を超えると steps の順に削る。あふれの数を読む。比は少ない側へすぐ寄せる', () => {
  const ratio = new promptfit.TokenRatio({ initial: 2 });
  const build = (L) => [{ role: 'user', content: 'a'.repeat(L.a) + 'b'.repeat(L.b) }];
  const r = promptfit.fit(build, { lim: { a: 1000, b: 1000 }, steps: [['a', 500], ['b', 100], ['a', 0]], budget: 400, ratio });
  assert.deepStrictEqual(r.applied, ['a=500', 'b=100']);
  assert.strictEqual(r.over, false);
  assert.deepStrictEqual(promptfit.overflowTokens('request (4136 tokens) exceeds the available context size (4096 tokens), try increasing it'), { request: 4136, ctx: 4096 });
  ratio.observe(1500, 1000);
  assert.strictEqual(ratio.value, 1.5);
  assert.strictEqual(promptfit.capSectionLines('## A\n1\n2\n3\n## B\nx', 1), '## A\n1\n## B\nx');
  assert.strictEqual(promptfit.capSectionLines('## A\n1\n## B\nx', 0), '');
  assert.ok(promptfit.capLineChars('やったこと: ' + 'x'.repeat(100) + 'END', 30).endsWith('END'));
});

test('rankPeople: 話した・助け合った・近い人が先。同点は元の順', () => {
  const r = rankPeople([{ name: 'A' }, { name: 'B', talks: 3 }, { name: 'C', d: 2 }, { name: 'D' }]);
  assert.deepStrictEqual(r.map((p) => p.name), ['B', 'C', 'A', 'D']);
});

test('GoalPath: 人の候補は maxPeople 人。予算が小さいと欄を削り、schema の enum も見せた候補だけ。毎回の入力と finishReason を記録', async () => {
  const seen = [];
  const llm = { complete: async (messages, schema) => { seen.push({ messages, schema }); return { text: '{"kind":"item","target":"jungle_log","count":2,"why":"w","need":"空腹"}', promptTokens: 2000, completionTokens: 30, finishReason: 'stop' }; } };
  const ev = [];
  const people = Array.from({ length: 19 }, (_, i) => ({ name: `P${i}`, relation: '知り合い', seen: null, talks: i === 7 ? 5 : 0 }));
  const gp = new GoalPath({ llm, log: (e) => ev.push(e), cfg: { prompt: { maxPeople: 5, ctxTokens: 1500, margin: 0 } } });
  const raw = mockRaw({ inventory: [], blocks: [{ name: 'jungle_log', nearest: { x: 3, y: 64, z: 0, d: 3 } }], entities: [], heard: [] });
  const ctx = { persona: { name: 'Yuki' }, goalText: '', obsText: '見えるブロック: jungle_log', raw, facts: () => [], allFacts: knowledge.loadFacts(),
    memText: 'やったこと: ' + 'collect→成功 / '.repeat(200), socialText: '空腹', worst: null, peopleText: people.map((p) => `${p.name}: 知り合い`).join('\n'), people,
    places: [], placeKinds: [], base: null, needNow: () => 0.5, board: { text: '## 全体に届いた話\n' + Array.from({ length: 10 }, (_, i) => `P${i}「${'あ'.repeat(40)}」`).join('\n') } };
  await gp.update(ctx, 1);
  const g = ev.find((e) => e.kind === 'goal');
  assert.ok(g && g.ok);
  assert.strictEqual(g.finishReason, 'stop');
  assert.strictEqual(g.promptTokens, 2000);
  assert.ok(g.fit.applied.length > 0, '削った欄がある');
  assert.ok(g.fit.est <= g.fit.budget || g.fit.over);
  const user = seen[0].messages[1].content;
  assert.ok(user.includes('P7: '), '話した人は残る');
  const enumNames = seen[0].schema.properties.target.enum;
  const shownPeople = enumNames.filter((n) => /^P\d+$/.test(n));
  assert.ok(shownPeople.length <= 5);
  for (const n of shownPeople) assert.ok(user.includes(`${n}: `));
  // 比を実測から学ぶ (2000 トークン)
  assert.ok(gp.ratio.samples === 1);
});

test('GoalPath: 文脈あふれ (HTTP 400) は予算を減らして1回作り直す', async () => {
  let n = 0;
  const llm = { complete: async () => { n += 1; if (n === 1) throw new Error('LLM HTTP 400: {"error":{"code":400,"message":"request (4300 tokens) exceeds the available context size (4096 tokens), try increasing it"}}'); return { text: '{"kind":"item","target":"jungle_log","count":2,"why":"w","need":"空腹"}', promptTokens: 3000, completionTokens: 30, finishReason: 'stop' }; } };
  const ev = [];
  const gp = new GoalPath({ llm, log: (e) => ev.push(e), cfg: { prompt: { ctxTokens: 8192 } } });
  const raw = mockRaw({ inventory: [], blocks: [{ name: 'jungle_log', nearest: { x: 3, y: 64, z: 0, d: 3 } }], entities: [], heard: [] });
  await gp.update({ persona: { name: 'Yuki' }, obsText: 'x', raw, facts: () => [], allFacts: knowledge.loadFacts(), memText: 'なし', people: [], places: [], placeKinds: [], needNow: () => 0.5 }, 1);
  assert.strictEqual(n, 2);
  assert.ok(ev.some((e) => e.kind === 'prompt_overflow' && e.promptTokens === 4300));
  const g = ev.find((e) => e.kind === 'goal');
  assert.ok(g.ok && g.fit.try === 1 && g.fit.budget < 8192 - 120 - 256);
});
