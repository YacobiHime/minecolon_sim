'use strict';
// GovSim の漁場 (govsim/): 環境の動き・割り当て・崩壊・指標・読めなかったときの扱い・種の再現
const test = require('node:test');
const assert = require('node:assert');
const { FisheryEnv, scaleConfig, sustainableShare, assignStochastic, assignProportional } = require('../govsim/env');
const { computeMetrics } = require('../govsim/metrics');
const { parseHarvest, parseLimit, parseUtterance, parseInsights, firstSentence } = require('../govsim/parse');
const { GovMemory } = require('../govsim/memory');
const { Rng } = require('../govsim/rng');
const { runSim } = require('../govsim/sim');
const { Mental, loadMentalConfig } = require('../govsim/mental');
const P = require('../govsim/prompts');

const NAMES = ['A', 'B', 'C', 'D', 'E'];
const want = (v) => Object.fromEntries(NAMES.map((n, i) => [n, Array.isArray(v) ? v[i] : v]));

test('規模: N=5 で capacity 100・崩壊 5・f0 10。N=10 で 200・10・10', () => {
  const c5 = scaleConfig({ agents: 5 });
  assert.deepStrictEqual([c5.capacity, c5.initial, c5.collapseBelow], [100, 100, 5]);
  const c10 = scaleConfig({ agents: 10 });
  assert.deepStrictEqual([c10.capacity, c10.collapseBelow], [200, 10]);
  assert.strictEqual(sustainableShare(100, 5), 10);
  assert.strictEqual(sustainableShare(200, 10), 10);
  assert.strictEqual(sustainableShare(70, 5), 7); // int((70//2)//5)
  assert.strictEqual(sustainableShare(38, 5), 3);
});

test('環境: 全員 10 なら毎月 100 に戻り、12 か月で終わる (崩壊しない)', () => {
  const env = new FisheryEnv({ agents: 5, seed: 1 });
  while (!env.done) {
    assert.strictEqual(env.threshold(5), 10);
    const r = env.harvest(NAMES, want(10));
    assert.deepStrictEqual(r.caught, want(10));
    assert.strictEqual(r.poolAfter, 50);
    env.endMonth();
    assert.strictEqual(env.pool, 100);
  }
  assert.strictEqual(env.history.length, 12);
  assert.strictEqual(env.collapsed, false);
});

test('環境: 増えるのは2倍・上限まで。f(t) は増えたあとの量から', () => {
  const env = new FisheryEnv({ agents: 5 });
  env.harvest(NAMES, want(14)); // 70 取る → 30
  env.endMonth();
  assert.strictEqual(env.pool, 60);
  assert.strictEqual(env.threshold(5), 6);
  env.harvest(NAMES, want(2)); // 10 → 50
  env.endMonth();
  assert.strictEqual(env.pool, 100);
});

test('環境: 取ったあと 5 未満なら崩壊 (増える前に判定)。4 → 崩壊、5 → 続く', () => {
  const e1 = new FisheryEnv({ agents: 5 });
  const r = e1.harvest(NAMES, want([20, 20, 20, 20, 16])); // 96 → 4
  assert.strictEqual(r.poolAfter, 4);
  assert.strictEqual(r.collapsed, true);
  e1.endMonth();
  assert.strictEqual(e1.done, true);
  assert.strictEqual(e1.collapsed, true);
  const e2 = new FisheryEnv({ agents: 5 });
  assert.strictEqual(e2.harvest(NAMES, want([20, 20, 20, 20, 15])).collapsed, false);
  e2.endMonth();
  assert.strictEqual(e2.done, false);
  assert.strictEqual(e2.pool, 10);
});

test('割り当て stochastic: 足りるなら欲しい量どおり、足りなければ合計 = 量で、誰も欲しい量を超えない。種が同じなら同じ', () => {
  const r1 = assignStochastic(NAMES, want([10, 20, 30, 0, 5]), 100, new Rng(3));
  assert.deepStrictEqual(r1.got, want([10, 20, 30, 0, 5]));
  assert.strictEqual(r1.remaining, 35);
  const w = want([50, 50, 50, 0, 10]);
  const a = assignStochastic(NAMES, w, 100, new Rng(7));
  const b = assignStochastic(NAMES, w, 100, new Rng(7));
  assert.deepStrictEqual(a, b);
  assert.strictEqual(Object.values(a.got).reduce((x, y) => x + y, 0), 100);
  for (const n of NAMES) assert.ok(a.got[n] <= w[n]);
  assert.strictEqual(a.got.D, 0);
  const c = assignStochastic(NAMES, w, 100, new Rng(8));
  assert.notDeepStrictEqual(a.got, c.got);
});

test('割り当て proportional: 比例で切り捨て、余りを切り捨てられた人へ。合計 = 量', () => {
  const r = assignProportional(['A', 'B'], { A: 60, B: 60 }, 100, new Rng(1));
  assert.deepStrictEqual(r.got, { A: 50, B: 50 });
  const r2 = assignProportional(['A', 'B', 'C'], { A: 50, B: 30, C: 20 }, 50, new Rng(1));
  assert.deepStrictEqual(r2.got, { A: 25, B: 15, C: 10 });
  const r3 = assignProportional(['A', 'B', 'C'], { A: 10, B: 10, C: 10 }, 20, new Rng(2));
  assert.strictEqual(r3.got.A + r3.got.B + r3.got.C, 20);
  for (const n of ['A', 'B', 'C']) assert.ok(r3.got[n] >= 6 && r3.got[n] <= 7);
  const r4 = assignProportional(['A', 'B'], { A: 5, B: 5 }, 100, new Rng(2));
  assert.deepStrictEqual(r4.got, { A: 5, B: 5 });
  assert.strictEqual(r4.remaining, 90);
});

// 手で計算した例
function hist(rows) {
  return rows.map((r, month) => ({ month, agents: NAMES, poolBefore: r.pb, threshold: r.f, caught: want(r.c), wanted: want(r.c), poolAfter: r.pa, collapsed: r.pa < 5 }));
}

test('指標: 全員が毎月 10 (崩壊なし) → m 12・Gain 120・効率 1・平等 1・使いすぎ 0', () => {
  const h = hist(Array.from({ length: 12 }, () => ({ pb: 100, f: 10, c: 10, pa: 50 })));
  const m = computeMetrics(h, { maxMonths: 12, capacity: 100 });
  assert.strictEqual(m.survivalMonths, 12);
  assert.strictEqual(m.survived, true);
  assert.strictEqual(m.gain, 120);
  assert.strictEqual(m.efficiency, 1);
  assert.strictEqual(m.equality, 1);
  assert.strictEqual(m.overUsage, 0);
});

test('指標: 効率 = Gain / 120 (論文の表の逆算と同じ)。1人あたりの平均で入れる', () => {
  // 2か月目で崩壊。1か月目: 各 16 (> f 10)・2か月目 [8,8,8,8,4]
  const h = hist([{ pb: 100, f: 10, c: 16, pa: 20 }, { pb: 40, f: 4, c: [8, 8, 8, 8, 4], pa: 4 }]);
  const m = computeMetrics(h, { maxMonths: 12, capacity: 100 });
  assert.strictEqual(m.survivalMonths, 2);
  assert.strictEqual(m.collapsed, true);
  assert.strictEqual(m.survived, false);
  assert.deepStrictEqual(m.gains, { A: 24, B: 24, C: 24, D: 24, E: 20 });
  assert.strictEqual(m.gain, 23.2);
  assert.ok(Math.abs(m.efficiency - 23.2 / 120) < 1e-12);
  // 平等: ΣΣ|Ri−Rj| = 2 × 4 × 4 = 32、ΣR = 116 → 1 − 32 / (2·5·116)
  assert.ok(Math.abs(m.equality - (1 - 32 / 1160)) < 1e-12);
  // 使いすぎ: 1か月目 5人とも > 10、2か月目 4人 > 4 → 9 / (5 × 2)
  assert.strictEqual(m.overUsage, 0.9);
  // 論文の表の例 (GPT-4o の fishery: Gain 66.0 → 効率 55.0) と同じ関係
  assert.ok(Math.abs((1 - Math.max(0, 120 - 66) / 120) - 0.55) < 1e-12);
});

test('指標: 最後の月に崩壊しても m = 12 (元の plots.py と同じ)、collapsed は true', () => {
  const rows = Array.from({ length: 11 }, () => ({ pb: 100, f: 10, c: 10, pa: 50 }));
  rows.push({ pb: 100, f: 10, c: 20, pa: 0 });
  const m = computeMetrics(hist(rows), { maxMonths: 12, capacity: 100 });
  assert.strictEqual(m.survivalMonths, 12);
  assert.strictEqual(m.collapsed, true);
  assert.strictEqual(m.survived, true);
  assert.strictEqual(m.survivedNoCollapse, false);
});

test('読む: 収穫の答え', () => {
  assert.deepStrictEqual(parseHarvest('I think 10 is fair.\nAnswer: 12 tons.'), { ok: true, value: 12 });
  assert.deepStrictEqual(parseHarvest('blah **Answer**: 7 tons'), { ok: true, value: 7 });
  assert.deepStrictEqual(parseHarvest('Answer: **9 tons**'), { ok: true, value: 9 });
  assert.strictEqual(parseHarvest('I will catch 10 tons.').ok, false);
  assert.strictEqual(parseHarvest('Answer: none').ok, false);
  assert.deepStrictEqual(parseLimit('reasoning... Answer: N/A'), { ok: true, value: null });
  assert.deepStrictEqual(parseLimit('Answer: 10 tons per person'), { ok: true, value: 10 });
  assert.strictEqual(parseLimit('they agreed on 10').ok, false);
});

test('読む: 発言・終わり・次の話し手', () => {
  const opts = ['Akira', 'Kenji', 'Yui'];
  const u = parseUtterance('Response: Let us keep to 10 tons.\nConversation conclusion by me: no\nNext speaker: Kenji', opts);
  assert.deepStrictEqual([u.ok, u.utterance, u.end, u.next], [true, 'Let us keep to 10 tons.', false, 'Kenji']);
  const e = parseUtterance('Response: "Agreed."\nConversation conclusion by me: yes\nNext speaker: N/A', opts);
  assert.deepStrictEqual([e.ok, e.utterance, e.end], [true, 'Agreed.', true]);
  const bad = parseUtterance('I think we should fish less.', opts);
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.end, true); // 元の既定
  const nn = parseUtterance('Response: hi\nConversation conclusion by me: no\nNext speaker: someone', opts);
  assert.deepStrictEqual([nn.ok, nn.next], [false, 'Akira']); // 元の既定 = 最初の人
  assert.strictEqual(firstSentence('I will remember this. And more.'), 'I will remember this.');
  assert.deepStrictEqual(parseInsights('1. Fish is limited (because of 1,2)\n2. Trust matters'), ['Fish is limited', 'Trust matters']);
});

test('記憶: 必ず入れる項目が先、期限切れは出さない、話し合いの記録は出さない、古い順に並ぶ', () => {
  const m = new GovMemory();
  const d = (s) => new Date(`2024-${s}T01:00:00Z`);
  m.addEvent('lake 100', d('01-01'), d('01-31'), true);
  for (let i = 0; i < 12; i++) m.addThought(`t${i}`, d('01-30'));
  m.addChat('summary', d('01-30'));
  const r = m.retrieve(d('01-30'), 10);
  assert.strictEqual(r.length, 10);
  assert.strictEqual(r[0].text, 'lake 100');
  assert.ok(!r.some((x) => x.text === 'summary'));
  assert.ok(r.some((x) => x.text === 't11') && !r.some((x) => x.text === 't0'));
  assert.ok(!m.retrieve(d('01-31'), 10).some((x) => x.text === 'lake 100')); // 期限の当日は出ない (元: expiration > now)
});

test('プロンプト: N=5・100 で GovSim の文と同じ (要所)', () => {
  const s = P.systemPrompt({ name: 'John', others: ['Kate', 'Jack', 'Emma', 'Luke'] });
  assert.ok(s.startsWith('You are John, a fisherman, and you fish every month in a lake along with four other fishermen (Kate, Jack, Emma, Luke). The lake has a carrying capacity of 100 tons of fish.'));
  assert.ok(s.includes('if there are 90 tons of fish at the beginning of the month and the five fishermen catch a total of 30 fish, there will be 60 tons of fish left'));
  assert.ok(s.includes('will have the opportunity to communicate'));
  assert.ok(!P.systemPrompt({ name: 'John', others: ['Kate'], language: false }).includes('communicate'));
  assert.strictEqual(P.tonsInLake(100), 'Before everyone fishes, there are 100 tons of fish in the lake.');
  assert.strictEqual(P.univ(10), 'Given the current situation, if everyone fishes more than 10 tons, the lake population will shrink next month.');
});

// 偽の LLM: 種類ごとに決まった答え。fail に入れた種類は読めない答えを返す
function fakeLlm({ harvest = 10, fail = {}, limit = 10 } = {}) {
  const calls = [];
  const fn = async ({ kind, prompt, agent }) => {
    calls.push({ kind, agent, prompt });
    const fk = fail[kind] && fail[kind][agent];
    if (fk > 0) { fail[kind][agent] -= 1; return { text: 'I am not sure.' }; }
    if (kind === 'harvest') return { text: `Reasoning.\nAnswer: ${typeof harvest === 'function' ? harvest(agent, prompt) : harvest} tons.` };
    if (kind === 'utterance') return { text: `Response: I suggest ${limit} tons each.\nConversation conclusion by me: ${calls.filter((c) => c.kind === 'utterance').length % 3 === 0 ? 'yes' : 'no'}\nNext speaker: ${agent}` };
    if (kind === 'summary') return { text: 'They agreed to fish less. More text.' };
    if (kind === 'limit') return { text: `Step by step.\nAnswer: ${limit}` };
    if (kind === 'insight') return { text: '1. The lake must be kept above half (because of 1)\n2. Others cooperate' };
    return { text: 'I should remember the limit. Extra.' };
  };
  fn.calls = calls;
  return fn;
}

test('実行: 全員 10 なら 12 か月生き残る。話し合い・取り決め・振り返りが流れる', async () => {
  const llm = fakeLlm();
  const s = await runSim({ agents: 5, seed: 1, llm });
  assert.strictEqual(s.metrics.survivalMonths, 12);
  assert.strictEqual(s.metrics.gain, 120);
  assert.strictEqual(s.metrics.efficiency, 1);
  assert.deepStrictEqual(s.parseFailures, {});
  assert.strictEqual(s.agreements.length, 12);
  assert.ok(llm.calls.some((c) => c.kind === 'harvest' && c.prompt.includes('The community agreed on a maximum limit of 10 tons of fish per person.')));
  assert.ok(llm.calls.some((c) => c.kind === 'utterance' && c.prompt.includes('-Mayor: Ladies and gentlemen, let me give you the monthly fishing report.')));
});

test('実行: 読めない答えは1回だけ聞き直し、だめなら 0 トン・失敗として数える', async () => {
  const llm = fakeLlm({ fail: { harvest: { John: 2, Kate: 1 } } }); // John: 2回とも失敗、Kate: 1回目だけ失敗
  const s = await runSim({ agents: 5, seed: 1, months: 1, llm, names: 'govsim' });
  assert.strictEqual(s.parseFailures.harvest, 1);
  assert.strictEqual(s.reasked.harvest, 2);
  const caught = s.months_detail[0].caught;
  assert.strictEqual(caught.John, 0);
  assert.strictEqual(caught.Kate, 10);
});

test('実行: 種が同じなら同じ結果 (割り当ても)。取りすぎると崩壊する', async () => {
  const greedy = (agent) => (agent === 'John' ? 40 : 25);
  const a = await runSim({ agents: 5, seed: 3, llm: fakeLlm({ harvest: greedy }), names: 'govsim' });
  const b = await runSim({ agents: 5, seed: 3, llm: fakeLlm({ harvest: greedy }), names: 'govsim' });
  assert.deepStrictEqual(a.months_detail.map((m) => m.caught), b.months_detail.map((m) => m.caught));
  assert.strictEqual(a.metrics.collapsed, true);
  assert.strictEqual(a.metrics.survivalMonths, 1);
});

test('変種: no-language は話し合いなし・村長の報告なし。universalization は文が入る。outsider は4か月目に5人目', async () => {
  const l1 = fakeLlm();
  await runSim({ agents: 5, months: 2, variant: 'no-language', llm: l1 });
  assert.ok(!l1.calls.some((c) => c.kind === 'utterance'));
  assert.ok(!l1.calls.some((c) => c.prompt.includes('communicate with each other')));
  const l2 = fakeLlm();
  await runSim({ agents: 5, months: 1, variant: 'universalization', llm: l2 });
  assert.ok(l2.calls.some((c) => c.kind === 'harvest' && c.prompt.includes('if everyone fishes more than 10 tons')));
  const l3 = fakeLlm();
  const s3 = await runSim({ agents: 5, variant: 'outsider', months: 5, llm: l3, names: 'govsim' });
  assert.deepStrictEqual(s3.months_detail.map((m) => Object.keys(m.caught).length), [4, 4, 4, 5, 5]);
  assert.ok(l3.calls.some((c) => c.agent === 'Luke' && c.prompt.includes("You don't care if in the future there is no fish")));
  assert.strictEqual(s3.months_detail[0].threshold, 12); // 4人: int(50 // 4)
  assert.strictEqual(s3.months_detail[3].threshold, 10); // 5人
});

test('mental on: 取り決めを破った人へのわだかまりが、破りが分かった話し合いのプロンプトに入る。off には入らない', async () => {
  const cfg = loadMentalConfig();
  // 2人だけで、y が2か月目に取り決め (10) を超えて取る
  const personas = cfg.personas.filter((p) => p.age >= 18).slice(0, 2);
  const [x, y] = personas.map((p) => p.name);
  const llm = fakeLlm({ harvest: (agent, prompt) => (agent === y && /Date: 2024-02/.test(prompt) ? 18 : 10) });
  const s = await runSim({ agents: 2, months: 3, mental: true, mentalConfig: cfg, personas, llm });
  const talk = llm.calls.find((c) => c.kind === 'utterance' && c.agent === x && /Date: 2024-02/.test(c.prompt));
  assert.ok(talk, 'x の2か月目の発言');
  assert.ok(talk.prompt.includes(`How ${x} feels right now`));
  assert.ok(talk.prompt.includes(`with ${y}:`) && talk.prompt.includes('they broke an agreement; I have not forgiven it yet'), talk.prompt.split('How')[1]);
  assert.ok(talk.prompt.includes(`${x}'s personality:`));
  const ev = s.months_detail.length;
  assert.strictEqual(ev, 3);
  assert.ok(s.mentalContribution.harvestDecisions >= 6);
  const off = fakeLlm();
  await runSim({ agents: 2, months: 1, mental: false, mentalConfig: cfg, personas, llm: off });
  assert.ok(!off.calls.some((c) => c.prompt.includes('feels right now') || c.prompt.includes('personality:')));
});

test('mental: 取った量が少ないと空腹になり、持続量どおりなら満たされる', () => {
  const cfg = loadMentalConfig();
  const p = cfg.personas.find((q) => q.age >= 30 && q.age < 60);
  const m = new Mental({ persona: p, cfg, others: ['Z'], subsistence: 10 });
  m.beforeHarvest(0);
  m.onHarvest(0, { wanted: 10, caught: 10 });
  assert.ok(m.social.needsModel.v.hunger < 0.2);
  m.sleep(0);
  m.beforeHarvest(1);
  m.onHarvest(1, { wanted: 10, caught: 2 });
  assert.ok(m.social.needsModel.v.hunger >= 0.7, String(m.social.needsModel.v.hunger));
  assert.ok(/starving/.test(m.words()));
});
