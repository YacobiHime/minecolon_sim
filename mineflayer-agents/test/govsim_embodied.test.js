'use strict';
// GovSim の Minecraft の中の版 (govsim/commons.js・embodied_sim.js): 池の帳簿 (数・回復・崩壊)・月の時計・見た人・破りの判定・
// 文字の版と同じ指標になること・偽物の world での1回の実行 (知ることの決まり・物理の割り当て・summary の形)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { CommonsLedger, MonthClock, witnessesOf, Knowledge, targetFish } = require('../govsim/commons');
const { FisheryEnv } = require('../govsim/env');
const { computeMetrics } = require('../govsim/metrics');
const { runEmbodied, groupChat, chatChunks, choosePersonas } = require('../govsim/embodied_sim');
const { FakeWorld } = require('../govsim/embodied_fake');
const { runSim } = require('../govsim/sim');
const { loadMentalConfig } = require('../govsim/mental');
const { Layout, lineOfSight } = require('../govsim/embodied_world');

const NAMES = ['A', 'B', 'C', 'D', 'E'];
const GOV = ['John', 'Kate', 'Jack', 'Emma', 'Luke'];

test('取りに行く匹数: 欲しいトンを 1匹の量で切り上げ', () => {
  assert.strictEqual(targetFish(10, 2), 5);
  assert.strictEqual(targetFish(7, 2), 4);
  assert.strictEqual(targetFish(0, 2), 0);
  assert.strictEqual(targetFish(-3, 2), 0);
  assert.strictEqual(targetFish('x', 2), 0);
  assert.strictEqual(targetFish(5, 1), 5);
});

test('帳簿: 50 匹 = 100 トン、f(t) = 10。半分取ると 50 トン、回復は 2 倍で上限 50 匹', () => {
  const L = new CommonsLedger({ agents: 5, tonsPerFish: 2 });
  assert.strictEqual(L.capFish, 50);
  const rec = L.startMonth(NAMES, 50);
  assert.strictEqual(rec.poolBefore, 100);
  assert.strictEqual(rec.threshold, 10);
  for (const n of NAMES) { L.recordWanted(n, 10); for (let i = 0; i < 5; i++) L.recordCatch(n, { fishId: `${n}${i}` }); }
  const h = L.endHarvest(25);
  assert.strictEqual(h.poolAfter, 50);
  assert.strictEqual(h.collapsed, false);
  assert.strictEqual(h.attributedMismatch, 0);
  assert.deepStrictEqual(h.caught, Object.fromEntries(NAMES.map((n) => [n, 10])));
  const g = L.endMonth(25);
  assert.deepStrictEqual([g.targetFish, g.summon, g.remove, g.done], [50, 25, 0, false]);
  assert.strictEqual(L.history[0].poolNext, 100);
});

test('帳簿: 回復は min(上限, 2S)。10 匹 → 20 匹、30 匹 → 50 匹', () => {
  const L = new CommonsLedger({ agents: 5, tonsPerFish: 2 });
  L.startMonth(NAMES, 50); L.endHarvest(10);
  assert.strictEqual(L.endMonth(10).targetFish, 20);
  L.startMonth(NAMES, 20); L.endHarvest(20);
  const g = L.endMonth(30); // 月の終わりに数えた数で回復 (取ったあとに増えていたら、その数から)
  assert.deepStrictEqual([g.targetFish, g.summon], [50, 20]);
});

test('帳簿: 崩壊は取ったあと 5 トン未満 (増える前)。2 匹 = 4 トンで崩壊、3 匹 = 6 トンなら続く', () => {
  const a = new CommonsLedger({ agents: 5, tonsPerFish: 2 });
  a.startMonth(NAMES, 50);
  assert.strictEqual(a.endHarvest(2).collapsed, true);
  const g = a.endMonth(2);
  assert.strictEqual(g.done, true);
  assert.strictEqual(a.collapsed, true);
  assert.throws(() => a.startMonth(NAMES, 4));
  const b = new CommonsLedger({ agents: 5, tonsPerFish: 2 });
  b.startMonth(NAMES, 50);
  assert.strictEqual(b.endHarvest(3).collapsed, false);
  assert.strictEqual(b.endMonth(3).done, false);
});

test('帳簿: 同じ魚は2回数えない。誰のものでもなく減った数を残す。12 か月で終わる', () => {
  const L = new CommonsLedger({ agents: 5, tonsPerFish: 2, maxMonths: 12 });
  L.startMonth(NAMES, 50);
  assert.strictEqual(L.recordCatch('A', { fishId: 7 }), true);
  assert.strictEqual(L.recordCatch('B', { fishId: 7 }), false);
  const h = L.endHarvest(47); // 3 匹減ったが、手柄は 1 匹
  assert.strictEqual(h.caught.A, 2);
  assert.strictEqual(h.caught.B, 0);
  assert.strictEqual(h.attributedMismatch, 2);
  L.endMonth(47);
  for (let m = 1; m < 12; m++) { L.startMonth(NAMES, 50); L.endHarvest(50); L.endMonth(50); }
  assert.strictEqual(L.done, true);
  assert.strictEqual(L.collapsed, false);
  assert.throws(() => new CommonsLedger({ agents: 5, tonsPerFish: 3 }), /割り切れる/);
});

test('月の時計: 6000 tick の月を 漁 50%・話し合い 30%・振り返り 20% に分ける', () => {
  const c = new MonthClock({ t0: 1000, monthTicks: 6000 });
  assert.deepStrictEqual(c.at(500), { month: -1, phase: 'before', start: null, end: 1000 });
  assert.deepStrictEqual(c.at(1000), { month: 0, phase: 'harvest', start: 1000, end: 4000 });
  assert.strictEqual(c.at(3999).phase, 'harvest');
  assert.deepStrictEqual(c.at(4000), { month: 0, phase: 'discussion', start: 4000, end: 5800 });
  assert.deepStrictEqual(c.at(5800), { month: 0, phase: 'reflection', start: 5800, end: 7000 });
  assert.deepStrictEqual(c.at(7000), { month: 1, phase: 'harvest', start: 7000, end: 10000 });
  assert.strictEqual(c.at(1000 + 11 * 6000 + 5999).month, 11);
  assert.strictEqual(c.phaseStart(2, 'end'), c.monthStart(3));
  assert.throws(() => new MonthClock({ harvest: 0.8, discussion: 0.3 }));
});

test('見た人: 見分けられる距離の中で、見通しがある人だけ。本人は入れない', () => {
  const ev = { who: 'A', pos: { x: 0, y: 64, z: 0 } };
  const obs = [{ name: 'A', pos: { x: 0, y: 64, z: 0 } }, { name: 'B', pos: { x: 5, y: 64, z: 0 } }, { name: 'C', pos: { x: 20, y: 64, z: 0 } }, { name: 'D', pos: { x: 0, y: 64, z: 10 } }, { name: 'E', pos: null }];
  assert.deepStrictEqual(witnessesOf(ev, obs, { range: 16 }), ['B', 'D']);
  assert.deepStrictEqual(witnessesOf(ev, obs, { range: 16, los: (o) => o.name !== 'D' }), ['B']);
  assert.deepStrictEqual(witnessesOf(ev, obs, { range: 25 }), ['B', 'C', 'D']);
});

test('見通し: 固いブロックがあると見えない。水は通す', () => {
  const { Vec3 } = require('vec3');
  const wall = (v) => (v.x === 2 ? { boundingBox: 'block' } : v.y < 64 ? { boundingBox: 'empty', name: 'water' } : null);
  assert.strictEqual(lineOfSight(wall, new Vec3(0.5, 65.6, 0.5), new Vec3(4.5, 65, 0.5)), false);
  assert.strictEqual(lineOfSight(wall, new Vec3(0.5, 65.6, 0.5), new Vec3(1.5, 62.5, 0.5)), true);
});

test('場所: 池の中かどうか・縁の立つ所・家は池から見分けられる距離 (16) の外', () => {
  const L = new Layout({ x0: 100, y0: 64, z0: 200, n: 5 });
  assert.strictEqual(L.inPond({ x: 100.5, y: 62.5, z: 200.5 }), true);
  assert.strictEqual(L.inPond({ x: 105.5, y: 62.5, z: 200.5 }), false);
  assert.strictEqual(L.rimCells().length, 32);
  for (const c of L.rimCells()) assert.strictEqual(Math.max(Math.abs(c.x - 100.5), Math.abs(c.z - 200.5)), 4);
  for (const h of [...L.homes, L.meeting]) for (const c of L.rimCells()) assert.ok(Math.hypot(h.x - c.x, h.z - c.z) > 16);
  assert.ok(L.buildCommands().every((c) => c.startsWith('fill ')));
});

test('知っていること: 見た量が取り決めを超えたら 破った。全部見ていて上限以下なら 守った。取り決めが無ければ何も言えない', () => {
  const kn = new Knowledge('A');
  for (let i = 0; i < 6; i++) kn.sawCatch(0, 'B'); // 12 トン見た
  for (let i = 0; i < 3; i++) kn.sawCatch(0, 'C'); // 6 トン見た (C は本当は 4 匹)
  for (let i = 0; i < 5; i++) kn.sawCatch(0, 'D'); // 10 トン (全部)
  const total = { B: 7, C: 4, D: 5 };
  assert.deepStrictEqual(kn.judge(0, null, 2, (w) => total[w]), []);
  const j = kn.judge(0, 10, 2, (w) => total[w]);
  assert.deepStrictEqual(j.map((x) => [x.who, x.kind]), [['B', 'breach'], ['D', 'kept']]);
  assert.deepStrictEqual(kn.judge(1, 10, 2, (w) => total[w]), []); // 次の月は何も見ていない
});

test('指標: 帳簿の history を computeMetrics に通すと、同じ取り方の文字の版 (FisheryEnv) と同じ指標になる', () => {
  for (const [k, wantFn] of [[1, (m, i) => [12, 9, 15, 10, 7][i] + (m % 3)], [2, (m, i) => 2 * ([5, 6, 4, 7, 5][i] + (m % 2))]]) {
    const env = new FisheryEnv({ agents: 5, seed: 4 });
    const L = new CommonsLedger({ agents: 5, tonsPerFish: k });
    while (!env.done) {
      const m = env.month;
      const wanted = Object.fromEntries(NAMES.map((n, i) => [n, wantFn(m, i)]));
      const r = env.harvest(NAMES, wanted);
      L.startMonth(NAMES, r.poolBefore / k);
      let id = 0;
      for (const n of NAMES) { L.recordWanted(n, wanted[n]); for (let c = 0; c < r.caught[n] / k; c++) L.recordCatch(n, { fishId: id++ }); }
      L.endHarvest(r.poolAfter / k);
      env.endMonth();
      L.endMonth(r.poolAfter / k);
      if (k === 2 && env.pool % 2) break; // 1匹 2 トンでは奇数のトンは作れない
    }
    const o = { maxMonths: 12, capacity: 100, agents: NAMES, collapseBelow: 5, initialAgents: 5 };
    const a = computeMetrics(env.history.slice(0, L.history.length), o);
    const b = computeMetrics(L.metricsHistory(), o);
    assert.deepStrictEqual(b, a);
    assert.deepStrictEqual(L.metricsHistory().map((h) => h.caught), env.history.slice(0, L.history.length).map((h) => h.caught));
  }
});

test('チャット: 長い発言は語の切れ目で 240 字以下に分け、続きの印 " ~" でつなぎ直す。人が替われば分ける', () => {
  const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
  const parts = chatChunks(long);
  assert.ok(parts.length >= 2);
  assert.ok(parts.every((p) => p.length <= 240));
  assert.ok(parts.slice(0, -1).every((p) => p.endsWith(' ~')));
  assert.deepStrictEqual(chatChunks('/kill @e'), ['kill @e']); // コマンドにしない
  assert.deepStrictEqual(chatChunks('  '), []);
  const msgs = [...parts.map((text) => ({ from: 'A', text })), { from: 'B', text: 'ok' }, { from: 'A', text: 'again' }, { from: 'A', text: 'short' }];
  assert.deepStrictEqual(groupChat(msgs), [['A', long], ['B', 'ok'], ['A', 'again'], ['A', 'short']]);
});

// 偽物の LLM: 収穫は harvest(agent, month, prompt)、話し合いは3発言で終わる
function fakeLlm({ harvest = 10, limit = 10 } = {}) {
  const calls = [];
  const fn = async ({ kind, prompt, agent }) => {
    calls.push({ kind, agent, prompt });
    const month = (prompt.match(/Date: 2024-(\d\d)/) || [0, '01'])[1] - 1;
    if (kind === 'harvest') return { text: `Reasoning.\nAnswer: ${typeof harvest === 'function' ? harvest(agent, month, prompt) : harvest} tons.` };
    if (kind === 'utterance') return { text: `Response: I suggest ${limit} tons each, ${'and I mean it '.repeat(20)}\nConversation conclusion by me: ${calls.filter((c) => c.kind === 'utterance').length % 3 === 0 ? 'yes' : 'no'}\nNext speaker: John` };
    if (kind === 'summary') return { text: 'They agreed on a limit. More.' };
    if (kind === 'limit') return { text: `Answer: ${limit}` };
    if (kind === 'insight') return { text: '1. Keep the lake healthy (because of 1)' };
    return { text: 'I should remember the limit.' };
  };
  fn.calls = calls;
  return fn;
}

const GOVP = GOV.map((name) => ({ name }));

test('実行 (偽物の world): 全員 10 トンなら 12 か月。指標は文字の版と同じ。summary の形は文字の版を含む', async () => {
  const llm = fakeLlm();
  const world = new FakeWorld({ names: GOV });
  const s = await runEmbodied({ world, llm, personas: GOVP, seed: 1 });
  const t = await runSim({ agents: 5, seed: 1, llm: fakeLlm(), names: 'govsim' });
  assert.deepStrictEqual(s.metrics, t.metrics);
  assert.strictEqual(s.metrics.survivalMonths, 12);
  for (const key of Object.keys(t)) assert.ok(key in s, `summary に ${key} が無い`);
  for (const key of Object.keys(t.months_detail[0])) assert.ok(key in s.months_detail[0], `months_detail に ${key} が無い`);
  assert.strictEqual(s.mode, 'embodied');
  assert.strictEqual(s.allocation, 'physical');
  assert.strictEqual(s.agreements.length, 12);
  assert.deepStrictEqual(world.commands.filter((c) => c[0] !== 'announce').slice(0, 2), [['set', 50], ['summon', 25]]);
  const inf = s.embodied.information;
  assert.strictEqual(inf.lookedShare, 1);
  assert.strictEqual(inf.wantedTotal, inf.caughtTotal);
  assert.strictEqual(inf.unattributedFish, 0);
});

test('知ることの決まり: 村長の報告も「湖に何トン」の文も無い。池で数えた数と、見た他人の漁だけが記憶に入る', async () => {
  const llm = fakeLlm();
  await runEmbodied({ world: new FakeWorld({ names: GOV, hide: 3 }), llm, personas: GOVP, seed: 2, months: 2 });
  const h = llm.calls.filter((c) => c.kind === 'harvest');
  assert.ok(h.every((c) => !c.prompt.includes('Before everyone fishes')));
  assert.ok(h.every((c) => !c.prompt.includes('monthly fishing report')));
  assert.ok(h.every((c) => /counted \d+ fish in it/.test(c.prompt)));
  assert.ok(h[0].prompt.includes('John counted 47 fish in it (about 94 tons)')); // 3 匹見えない
  assert.ok(h[0].prompt.includes('Nobody tells you how many fish are in the lake'));
  assert.ok(llm.calls.filter((c) => c.kind === 'utterance').every((c) => !c.prompt.includes('Mayor')));
  // 池で見た他人の漁は、その月の話し合いの記憶に入る (文字の版の「取った量」と同じく、月の終わりで期限切れ)
  assert.ok(llm.calls.filter((c) => c.kind === 'utterance').some((c) => /saw \w+ catch \d+ fish/.test(c.prompt)));
  // 見る人がいなければ他人の漁は分からない
  const l2 = fakeLlm();
  await runEmbodied({ world: new FakeWorld({ names: GOV, witness: 'none' }), llm: l2, personas: GOVP, seed: 2, months: 2 });
  assert.ok(l2.calls.every((c) => !/saw \w+ catch/.test(c.prompt)));
});

test('--mayor-report on: 話し合いの初めに文字の版と同じ報告が入る', async () => {
  const llm = fakeLlm();
  const world = new FakeWorld({ names: GOV });
  await runEmbodied({ world, llm, personas: GOVP, seed: 1, months: 1, mayorReport: true });
  const u = llm.calls.find((c) => c.kind === 'utterance');
  assert.ok(u.prompt.includes('-Mayor: Ladies and gentlemen, let me give you the monthly fishing report. John caught 10 tons of fish.'));
  assert.ok(world.commands.some((c) => c[0] === 'announce'));
});

test('物理の割り当て: 先に来た人が取る。欲しい量と取れた量の両方を残す', async () => {
  const llm = fakeLlm({ harvest: (agent) => (agent === 'John' ? 90 : 10) });
  const s = await runEmbodied({ world: new FakeWorld({ names: GOV }), llm, personas: GOVP, seed: 1, months: 1 });
  const d = s.months_detail[0];
  assert.strictEqual(d.wanted.John, 90);
  const total = Object.values(d.caught).reduce((a, b) => a + b, 0);
  assert.strictEqual(total, 100); // 池が空になるまで
  assert.ok(Object.values(d.caught).some((c, i) => c < Object.values(d.wanted)[i]));
  assert.strictEqual(s.metrics.collapsed, true);
  assert.ok(s.embodied.information.caughtLessThanWanted >= 1);
});

test('話し合い: 発言はチャットで送り、その人が受け取ったチャットがプロンプトに入る (行に分かれても1発言)', async () => {
  const llm = fakeLlm();
  const world = new FakeWorld({ names: GOV });
  await runEmbodied({ world, llm, personas: GOVP, seed: 1, months: 1 });
  const u = llm.calls.filter((c) => c.kind === 'utterance');
  assert.strictEqual(u.length, 3);
  assert.ok(u[1].prompt.includes('-John: I suggest 10 tons each, and I mean it'));
  assert.strictEqual((u[2].prompt.match(/^-John: /gm) || []).length, 2);
  assert.ok(world.heardBy.Kate.length > 3); // 長い発言は分かれて届いた
  assert.ok(world.heardBy.Kate.some((m) => m.text.endsWith(' ~')));
});

test('取り決めを破った人: 見た人だけが知る (mental on で わだかまり)。見なかった人の心は動かない', async () => {
  const mc = loadMentalConfig();
  const ps = choosePersonas({ seed: 1, agents: 5, mentalConfig: mc });
  const greedy = ps[4].name;
  const llm = fakeLlm({ harvest: (agent, month) => (agent === greedy && month === 1 ? 20 : 6) });
  const events = [];
  // 1回目: 全員が見る (witness all)、2回目: だれも見ない
  for (const witness of ['all', 'none']) {
    const ev = [];
    await runEmbodied({ world: new FakeWorld({ names: ps.map((p) => p.name), witness }), llm, personas: ps, mentalConfig: mc, mental: true, seed: 1, months: 2, log: (e) => ev.push(e) });
    events.push(ev);
  }
  const judged = (ev) => ev.filter((e) => e.type === 'mental' && e.month === 1).flatMap((e) => Object.values(e.events).flatMap((x) => x.judged || []));
  const seenBreach = judged(events[0]).filter((j) => j.kind === 'breach');
  assert.ok(seenBreach.length >= 1);
  assert.ok(seenBreach.every((j) => j.who === greedy && j.seenTons > 10 && j.grudge > 0));
  assert.deepStrictEqual(judged(events[1]), []);
  const st = events[0].filter((e) => e.type === 'mental' && e.month === 1).flatMap((e) => Object.entries(e.events)).filter(([n]) => n !== greedy);
  assert.ok(st.some(([, x]) => x.state.relations[greedy].grudge > 0));
});

test('mental on: 本物の材料 (満腹度・近くの人) で心が動き、食べた魚は needs の onEat に入る', async () => {
  const mc = loadMentalConfig();
  const ps = choosePersonas({ seed: 3, agents: 5, mentalConfig: mc });
  const llm = fakeLlm({ harvest: 0 });
  const ev = [];
  await runEmbodied({ world: new FakeWorld({ names: ps.map((p) => p.name), hungerPerMonth: 12 }), llm, personas: ps, mentalConfig: mc, mental: true, seed: 3, months: 2, log: (e) => ev.push(e) });
  const m1 = ev.find((e) => e.type === 'mental' && e.month === 1);
  for (const x of Object.values(m1.events)) assert.ok(x.state.needs.hunger > 0.5); // 0 トンで2か月 → 満腹度 0
  const h = llm.calls.filter((c) => c.kind === 'harvest' && /How \w+ feels right now/.test(c.prompt));
  assert.ok(h.length >= 5);
  assert.ok(h.slice(5).some((c) => /starving|hungry/.test(c.prompt)));
});

test('集計 (tools/govsim_aggregate.js): 文字の版と Minecraft の中の版の summary.json を、別の行にまとめる', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'govsim-agg-'));
  const t = await runSim({ agents: 5, seed: 1, llm: fakeLlm(), names: 'govsim', months: 2 });
  const s = await runEmbodied({ world: new FakeWorld({ names: GOV }), llm: fakeLlm(), personas: GOVP, seed: 1, months: 2 });
  for (const [n, x] of [['t', t], ['e', s]]) { fs.mkdirSync(path.join(dir, n)); fs.writeFileSync(path.join(dir, n, 'summary.json'), JSON.stringify({ ...x, llm: { provider: 'fake', model: 'm' } })); }
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'tools', 'govsim_aggregate.js'), dir], { encoding: 'utf8' });
  assert.ok(out.includes('fake/m | text | default | mental off'));
  assert.ok(out.includes('fake/m | embodied | default | mental off'));
  assert.ok(out.includes('lookedShare'));
  fs.rmSync(dir, { recursive: true, force: true });
});
