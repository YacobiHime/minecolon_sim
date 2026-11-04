'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadConfig } = require('../src/config');
const { buildContext } = require('../src/agent');
const { Memory } = require('../src/memory');
const { GoalPlan, parseSteps, parseGoalText, timeText } = require('../src/goalplan');
const { OthersLog } = require('../src/others');
const { rankPairs } = require('../src/actions_more');
const { JevDecider, actionOptions } = require('../src/deciders/jev');
const { JevClient } = require('../src/jev_client');
const { mockRaw } = require('./fixtures');

const CFG = path.join(__dirname, '..', 'configs', 'survival_3days.json');
const ADVICE = /(とよい|といい|べき|優先|ほうが|方が|おすすめ|勧め|まず|先に|良い|よい|大切|重要)/;

// ---- ほかの人が拾った・壊したこと ----

test('OthersLog: 行動の間に近くでほかの人が拾った物・壊したブロックを、結果の文にそのまま足す', () => {
  const o = new OthersLog({ radius: 16, nearDist: 5 });
  const me = { x: 0, y: 64, z: 0 };
  o.notePickup({ who: 'Ken', self: 'Taro', me, item: 'oak_log', count: 1, pos: { x: 1, y: 64, z: 0 }, t: 1 }); // mark の前
  const m = o.mark();
  o.notePickup({ who: 'Ken', self: 'Taro', me, item: 'jungle_log', count: 1, pos: { x: 3, y: 64, z: 0 }, t: 10 });
  o.notePickup({ who: 'Ken', self: 'Taro', me, item: 'jungle_log', count: 1, pos: { x: 3, y: 64, z: 1 }, t: 11 });
  assert.strictEqual(o.notePickup({ who: 'Taro', self: 'Taro', me, item: 'jungle_log', pos: me, t: 12 }), false); // 自分
  assert.strictEqual(o.notePickup({ who: 'Yuki', self: 'Taro', me, item: 'dirt', pos: { x: 40, y: 64, z: 0 }, t: 12 }), false); // 遠い
  // 掘っている途中の様子が見えていたマスが空気になった → その人が壊した
  o.noteBreakProgress({ who: 'Ken', self: 'Taro', pos: { x: 4, y: 65, z: 0 }, t: 20 });
  assert.strictEqual(o.noteBlockGone({ pos: { x: 4, y: 65, z: 0 }, oldName: 'jungle_log', newName: 'air', me, players: [], t: 21 }), 'Ken');
  // 途中の様子が無い (すぐ壊れる草): すぐ近くに1人だけ居ればその人
  assert.strictEqual(o.noteBlockGone({ pos: { x: 6, y: 64, z: 0 }, oldName: 'short_grass', me, players: [{ name: 'Hanako', pos: { x: 7, y: 64, z: 0 } }, { name: 'Jiro', pos: { x: 15, y: 64, z: 0 } }], t: 22 }), 'Hanako');
  // 葉は自然に消えるので、途中の様子が無ければ数えない。自分が掘ったマスも数えない
  assert.strictEqual(o.noteBlockGone({ pos: { x: 6, y: 70, z: 0 }, oldName: 'jungle_leaves', me, players: [{ name: 'Hanako', pos: { x: 6, y: 69, z: 0 } }], t: 23 }), null);
  o.noteMyDig({ x: 2, y: 64, z: 0 }, 24);
  assert.strictEqual(o.noteBlockGone({ pos: { x: 2, y: 64, z: 0 }, oldName: 'dirt', me, players: [{ name: 'Hanako', pos: { x: 2, y: 64, z: 1 } }], t: 24 }), null);
  // 空気になっていない (水が流れ込んだ) ものは数えない
  assert.strictEqual(o.noteBlockGone({ pos: { x: 6, y: 63, z: 0 }, oldName: 'dirt', newName: 'water', me, players: [{ name: 'Hanako', pos: { x: 6, y: 64, z: 0 } }], t: 25 }), null);
  const seen = o.since(m);
  assert.deepStrictEqual(seen, [
    { who: 'Ken', kind: 'pickup', name: 'jungle_log', count: 2 },
    { who: 'Ken', kind: 'break', name: 'jungle_log', count: 1 },
    { who: 'Hanako', kind: 'break', name: 'short_grass', count: 1 },
  ]);
  assert.strictEqual(OthersLog.appendTo('jungle_logを3個掘って0個拾った', seen),
    'jungle_logを3個掘って0個拾った。Kenがjungle_logを2個拾った。Kenがjungle_logを1個壊した。Hanakoがshort_grassを1個壊した');
  assert.strictEqual(OthersLog.appendTo('x', []), 'x');
  assert.doesNotMatch(OthersLog.text(seen), ADVICE);
});

// ---- 選択肢を絞る (1段) ----

test('rankPairs: 順位の和の小さい順', () => {
  assert.deepStrictEqual(rankPairs(2, 3), [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2], [1, 2]]);
});

function survivalCtx(over = {}, extra = {}, cfgOver = {}) {
  const cfg = loadConfig(CFG, { persona: { name: 'Taro' }, ...cfgOver });
  return buildContext(mockRaw(over), new Memory({ limits: cfg.memory.limits }), cfg, { foods: new Set(['bread']), ...extra });
}

test('survival: use_on は12個・give は8個まで。近い対象・数の多い持ち物から。2段にせず1段で全部並べる', () => {
  const inv = [{ name: 'dirt', count: 5 }, { name: 'oak_log', count: 30 }, { name: 'stick', count: 2 }, { name: 'bread', count: 1 }, { name: 'oak_planks', count: 12 }, { name: 'wheat_seeds', count: 3 }];
  const blk = (name, x, d, notable = false) => ({ name, notable, diggable: true, seen: 2, nearest: { x, y: 64, z: 0, d }, positions: [{ x, y: 64, z: 0, d }] });
  const blocks = [blk('stone', 8, 8), blk('grass_block', 1, 1), blk('dirt', 3, 3), blk('oak_log', 5, 5, true), blk('sand', 6, 6), blk('gravel', 7, 7), blk('water', 9, 9, true)];
  const players = ['Hanako', 'Ken', 'Jiro'].map((n, i) => ({ kind: 'player', name: n, pos: { x: -(i + 2), y: 64, z: 0 }, d: i + 2 }));
  const c = survivalCtx({ inventory: inv, blocks, entities: players, heard: [] });
  const use = c.actions.find((a) => a.name === 'use_on');
  assert.strictEqual(use.choices.length, 12);
  assert.strictEqual(use.choices[0].id, 'hand>grass_block'); // 素手 × 一番近い対象
  // 置けるブロック (oak_log・oak_planks・dirt) は持ち物の側から外す (act.useOnPlaceable: false)。種は残す。棒は置けないので残る
  assert.strictEqual(use.choices[1].id, 'wheat_seeds>grass_block'); // 一番多い持ち物 (置ける物を除く) × 一番近い対象
  assert.strictEqual(use.choices[2].id, 'hand>dirt');
  assert.ok(!use.choices.some((x) => ['oak_log', 'oak_planks', 'dirt'].includes(x.item)));
  assert.ok(!use.choices.some((x) => x.target === 'water')); // 遠い対象は落ちる
  // collect の候補から地面そのもの (dirt・grass_block) を外す。sand・gravel は残す
  const coll = c.actions.find((a) => a.name === 'collect').choices.map((x) => x.id);
  assert.ok(!coll.includes('dirt') && !coll.includes('grass_block'));
  assert.ok(coll.includes('sand') && coll.includes('gravel'));
  const give = c.actions.find((a) => a.name === 'give');
  assert.strictEqual(give.choices.length, 8);
  assert.deepStrictEqual(give.choices.slice(0, 4).map((x) => x.id), ['Hanako:oak_log:1', 'Hanako:oak_log:all', 'Ken:oak_log:1', 'Ken:oak_log:all']);
  // 1段: 分類 ("行動:*") の選択肢は作らない
  const cfg = loadConfig(CFG);
  const d = new JevDecider({ client: new JevClient({ apiKey: 'k', fetch: async () => ({}) }), ...cfg.decider.jev });
  assert.strictEqual(d.twoStage.enabled, false);
  const opts = actionOptions(c.actions, { twoStage: false });
  assert.ok(!Object.keys(opts.criteria).some((k) => k.endsWith(':*')));
  assert.ok(Object.keys(opts.criteria).includes('use_on:hand>grass_block'));
});

// ---- ゴールと手順 ----

function mockLLM(script) {
  const seen = [];
  return {
    seen,
    maxTokens: 96,
    complete: async (messages, schema) => {
      const sys = messages[0].content;
      const kind = /JSON \{"goal"/.test(sys) ? 'goal' : /1つの手順だけを書き直す/.test(sys) ? 'rewrite' : /進まなかった手順/.test(messages[1].content) ? 'rebuild' : 'steps';
      seen.push({ kind, messages, schema });
      const q = script[kind];
      const text = Array.isArray(q) ? q.shift() : q;
      return { text, promptTokens: 500, completionTokens: 50 };
    },
  };
}

function mockJev(fn) {
  const calls = [];
  return { calls, call: async (state, questions, stage) => { calls.push({ state, questions, stage }); return { r: { ok: true, answers: fn(questions, calls.length) }, inputTokens: 900 }; } };
}

const gctx = (over = {}) => ({
  persona: { name: 'Taro', personality: 'まじめ' }, goalText: 'この世界で3日生き延びる。',
  obsText: '自分: Taro 体力20/20 満腹18/20\n持ち物: なし', raw: { self: { timeOfDay: 1000, day: 0 } },
  facts: (t) => (/log|板材|作業台/.test(t) ? ['原木1個から板材(_planks)が4個作れる(作業台は要らない)。'] : ['1日はおよそ20分。']),
  actions: [{ name: 'collect', desc: 'ブロックを掘って拾う', argType: 'choice', choices: [] }, { name: 'craft', desc: '物を作る', argType: 'choice', choices: [] }, { name: 'say', desc: '話す', argType: 'text' }],
  memText: 'やったこと: まだ何もしていない', troubles: [], ...over,
});

test('GoalPlan: ゴール → 逆向きの手順 → Jev で確かめ、落ちた手順だけ書き直す → 1段ずつ進む → 全部済んだら新しいゴール', async () => {
  const llm = mockLLM({
    goal: ['{"goal":"作業台を置く"}', '{"goal":"木のツルハシを持つ"}'],
    steps: ['{"needs":["作業台","板材4個","原木1個"],"steps":["jungle_logを1個持っている","空を飛んだ","作業台を置いた"]}', '{"needs":["x"],"steps":["木のツルハシを持っている"]}'],
    rewrite: ['{"steps":["jungle_planksを4個持っている","crafting_tableを持っている"]}'],
  });
  const logs = [];
  // 1回目: 手順2 が 0.1 で落ちる。2回目 (書き直した2つだけ): どちらも通る
  const jev = mockJev((q) => Object.fromEntries(Object.keys(q).map((k) => [k, { type: 'noul', noul: Object.keys(q).length === 3 && k === 'step_2' ? 0.1 : 0.9 }])));
  const g = new GoalPlan({ llm, jev, log: (e) => logs.push(e), cfg: { stepPatience: 50, rewriteMax: 2 } });
  assert.strictEqual(await g.update(gctx(), 1), 'goal');
  assert.strictEqual(g.goal.text, '作業台を置く');
  assert.deepStrictEqual(g.steps.map((s) => s.text), ['jungle_logを1個持っている', 'jungle_planksを4個持っている', 'crafting_tableを持っている', '作業台を置いた']);
  assert.strictEqual(g.planText(), 'ゴール: 作業台を置く / 今の手順 (1/4): jungle_logを1個持っている');
  // 確認: 1回目は3手順まとめて、2回目は書き直した2手順だけ
  assert.deepStrictEqual(jev.calls.map((c) => Object.keys(c.questions)), [['step_1', 'step_2', 'step_3'], ['step_2', 'step_3']]);
  assert.strictEqual(jev.calls[0].stage, 'plan');
  assert.ok(jev.calls[0].state.knowledge.includes('板材'));
  assert.ok(jev.calls[0].state.actions.collect && !jev.calls[0].state.actions.say);
  const check = logs.find((e) => e.kind === 'check');
  assert.deepStrictEqual(check.failed, [1]);
  const rw = logs.find((e) => e.kind === 'rewrite');
  assert.strictEqual(rw.before, '空を飛んだ');
  // 2B の材料: 今の様子・夜までの目安・知っていること・できる行動・これまでのゴール。使い方の誘導・評価語は書かない
  const stepsMsg = llm.seen.find((x) => x.kind === 'steps').messages;
  assert.match(stepsMsg[0].content, /逆向きにさかのぼって/);
  assert.match(stepsMsg[1].content, /夜まであと約10分/);
  assert.match(stepsMsg[1].content, /## できる行動\ncollect: ブロックを掘って拾う/);
  assert.match(stepsMsg[1].content, /## これまでのゴール\nまだない/);
  for (const x of llm.seen) assert.doesNotMatch(x.messages[0].content, ADVICE, x.messages[0].content);
  assert.deepStrictEqual(llm.seen[1].schema.required, ['needs', 'steps']);
  // 進む: step_done が閾値未満なら進まない、以上なら次の手順
  assert.strictEqual(await g.update(gctx(), 2, { stepDoneP: 0.3 }), null);
  assert.strictEqual(await g.update(gctx(), 3, { stepDoneP: 0.8 }), 'advance');
  assert.strictEqual(g.idx, 1);
  for (let t = 4; t <= 6; t++) await g.update(gctx(), t, { stepDoneP: 0.9 });
  // 全部済んだ → ゴール達成 → 新しいゴール (これまでのゴールが材料に入る)
  assert.strictEqual(g.history[0].result, 'done');
  assert.strictEqual(g.history[0].stepsDone, 4);
  assert.strictEqual(g.goal.text, '木のツルハシを持つ');
  assert.match(llm.seen.filter((x) => x.kind === 'goal')[1].messages[1].content, /作業台を置く \(達成した。手順 4\/4\)/);
  assert.strictEqual(g.counts.advanced, 4);
});

test('GoalPlan: 詰まったら残りの手順だけ作り直す (ゴールは変えない)。作り直しが続いたらゴールを捨てる。一定判断ごとの書き直しはしない', async () => {
  const llm = mockLLM({
    goal: ['{"goal":"食べ物を集める"}', '{"goal":"寝る場所を作る"}'],
    steps: '{"needs":["a"],"steps":["牛を見つけた","beefを3個持っている","cooked_beefを持っている"]}',
    rebuild: '{"needs":["a"],"steps":["羊を見つけた","muttonを2個持っている"]}',
  });
  const logs = [];
  const g = new GoalPlan({ llm, jev: null, log: (e) => logs.push(e), cfg: { stepPatience: 5, troubleTicks: 3, abandonAfter: 2 } });
  await g.update(gctx(), 1);
  await g.update(gctx(), 2, { stepDoneP: 0.9 });
  assert.strictEqual(g.idx, 1);
  // 困りごとが3判断続く → 残りを作り直す。済んだ手順は残る
  const tr = [{ key: 'attack:cow', about: 'cowの倒し方' }];
  assert.strictEqual(await g.update(gctx(), 3, { troubles: tr }), null);
  assert.strictEqual(await g.update(gctx(), 4, { troubles: tr }), null);
  assert.strictEqual(await g.update(gctx(), 5, { troubles: tr }), 'rebuild');
  assert.strictEqual(g.goal.text, '食べ物を集める');
  assert.deepStrictEqual(g.steps.map((s) => s.text), ['牛を見つけた', '羊を見つけた', 'muttonを2個持っている']);
  assert.strictEqual(g.idx, 1);
  const rb = llm.seen.find((x) => x.kind === 'rebuild').messages[1].content;
  assert.match(rb, /## 済んだ手順\n牛を見つけた/);
  assert.match(rb, /## 進まなかった手順\nbeefを3個持っている \(困りごとが3判断続いた: cowの倒し方\)/);
  // 今の手順が stepPatience 判断進まない → 作り直し (2回目)。3回目でゴールを捨てる
  assert.strictEqual(await g.update(gctx(), 9), null);
  assert.strictEqual(await g.update(gctx(), 10), 'rebuild');
  assert.strictEqual(await g.update(gctx(), 15), 'abandon');
  assert.strictEqual(g.history[0].result, 'abandoned');
  assert.strictEqual(g.goal.text, '寝る場所を作る');
  assert.ok(['goal', 'steps', 'plan', 'advance', 'rebuild', 'abandon'].every((k) => logs.some((e) => e.kind === k)));
  // 読めない出力: ゴールが無いまま、retryAfter 判断のあとにもう一度
  const g2 = new GoalPlan({ llm: mockLLM({ goal: ['こわれた', '{"goal":"x"}'], steps: '{"needs":["a"],"steps":["y"]}' }), cfg: { retryAfter: 3 } });
  await g2.update(gctx(), 1);
  assert.strictEqual(g2.goal, null);
  assert.strictEqual(await g2.update(gctx(), 2), null);
  assert.strictEqual(await g2.update(gctx(), 4), 'goal');
  assert.strictEqual(g2.goal.text, 'x');
});

test('parseSteps / parseGoalText / timeText', () => {
  assert.deepStrictEqual(parseSteps('{"needs":["a"],"steps":["x","","y","z","w","v","u","t"]}').steps, ['x', 'y', 'z', 'w', 'v', 'u']);
  assert.strictEqual(parseSteps('{"steps":[]}'), null);
  assert.strictEqual(parseGoalText('{"goal":"  "}'), null);
  assert.strictEqual(timeText(1000, 0), '時間: 昼 1日目 (夜まであと約10分)');
  assert.strictEqual(timeText(14000, 1), '時間: 夜 2日目 (朝まであと約8分)');
});

test('JevDecider: goalPlan のとき plan はゴールと今の手順。step_done (noul) を聞いて読む。goal_done は聞かない', async () => {
  const c = survivalCtx({}, { planText: 'ゴール: 作業台を置く / 今の手順 (1/3): jungle_logを1個持っている' }, { help: { goalPlan: true, goalPath: false } });
  assert.ok(c.goalPlan && !c.selfGoal);
  const bodies = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body); bodies.push(body);
    const k = Object.keys(body.questions.next_action.criteria)[0];
    return { ok: true, status: 200, headers: new Map(), json: async () => ({ answers: { next_action: { type: 'choice', choice: k, confidence: 0.6 }, remember: { type: 'score', score: 1 }, step_done: { type: 'noul', noul: 0.75 } }, usage: { input_tokens: 2000, output_tokens: 10 } }) };
  };
  const d = new JevDecider({ client: new JevClient({ apiKey: 'k', fetch }), twoStage: false });
  const r = await d.decide(c);
  assert.strictEqual(r.jev.stepDoneP, 0.75);
  assert.strictEqual(r.jev.calls, 1);
  assert.ok(bodies[0].questions.step_done && !bodies[0].questions.goal_done);
  assert.match(bodies[0].questions.next_action.instructions, /the step `you` are on now/);
  assert.strictEqual(bodies[0].state.plan, c.progress);
});

test('summarize_run: ゴールの数・手順の進み・作り直しの回数・確認で落ちた手順', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-'));
  const t = (s) => new Date(Date.UTC(2026, 10, 3, 1, 0, 0) + s * 1000).toISOString();
  const L = (o) => JSON.stringify(o);
  const step = (loop, s, extra = {}) => ({ ts: t(s), loop, day: 0, timeOfDay: 1000, pos: { x: 0, y: 64, z: 0 }, action: 'collect', arg: 'jungle_log', result: { ok: true, msg: 'ok' }, decideMs: 300, parseOk: true, valid: true, inventory: [], foodCount: 0, jev: { inputTokens: 2500, inputChars: 4000, ms: 300 }, ...extra });
  fs.writeFileSync(path.join(dir, 'Taro-x.jsonl'), [
    L({ ts: t(0), event: 'start', persona: { name: 'Taro' }, help: { goalPlan: true }, day: 0 }),
    L({ ts: t(1), event: 'goal_plan', kind: 'goal', tick: 1, goal: '作業台を置く', ok: true }),
    L({ ts: t(1), event: 'goal_plan', kind: 'steps', tick: 1, goal: '作業台を置く', steps: ['a', 'b'], ok: true }),
    L({ ts: t(1), event: 'goal_plan', kind: 'check', tick: 1, asked: [0, 1], failed: [1], p: { 0: 0.9, 1: 0.2 } }),
    L({ ts: t(1), event: 'goal_plan', kind: 'rewrite', tick: 1, index: 1, before: 'b', after: ['c'], ok: true }),
    L({ ts: t(1), event: 'goal_plan', kind: 'plan', tick: 1, steps: [{ text: 'a', p: 0.9 }, { text: 'c', p: 0.8 }] }),
    L(step(1, 2, { result: { ok: true, msg: 'jungle_logを3個掘って0個拾った。Kenがjungle_logを2個拾った', others: [{ who: 'Ken', kind: 'pickup', name: 'jungle_log', count: 2 }] } })),
    L({ ts: t(3), event: 'goal_plan', kind: 'advance', tick: 2, step: 'a', index: 0, p: 0.8, took: 1 }),
    L({ ts: t(4), event: 'goal_plan', kind: 'rebuild', tick: 3, why: '15判断進まなかった', steps: ['a', 'd'], from: 1, ok: true }),
    L(step(2, 5)),
  ].join('\n'));
  const out = JSON.parse(execFileSync('node', [path.join(__dirname, '..', 'tools', 'summarize_run.js'), dir], { encoding: 'utf8' }));
  assert.strictEqual(out.goalPlan.goals, 1);
  assert.strictEqual(out.goalPlan.stepsAdvanced, 1);
  assert.strictEqual(out.goalPlan.rebuilds, 1);
  assert.strictEqual(out.goalPlan.checkFailed, 1);
  assert.strictEqual(out.goalPlan.rewrites, 1);
  assert.strictEqual(out.others.appended, 1);
  assert.ok(out.goalPlan.timeline.some((l) => /rewrite \(2\) b → c/.test(l)));
  const txt = execFileSync('node', [path.join(__dirname, '..', 'tools', 'summarize_run.js'), dir, '--text'], { encoding: 'utf8' });
  assert.match(txt, /ゴール 1 個 \(達成 0・捨てた 0\)、手順を進めた 1 回/);
});
