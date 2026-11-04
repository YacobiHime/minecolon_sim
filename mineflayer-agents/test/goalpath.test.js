'use strict';
// ゴール (2B) → 道筋 (planner) → 行動 (Jev) の3つの層 (help.goalPath)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { plan, pathText, Planner } = require('../src/planner');
const { itemCandidates, placeCandidates, familyKey } = require('../src/vocab');
const { GoalPath, parseGoal, goalSchema } = require('../src/goalpath');
const { baseSite, baseSiteText } = require('../src/basesite');
const { loadConfig } = require('../src/config');
const { buildContext } = require('../src/agent');
const { Memory } = require('../src/memory');
const { JevDecider } = require('../src/deciders/jev');
const { JevClient } = require('../src/jev_client');
const knowledge = require('../src/knowledge');
const { jaName } = require('../src/names_ja');
const { mockRaw } = require('./fixtures');

const CFG = path.join(__dirname, '..', 'configs', 'survival_3days.json');
const ADVICE = /(とよい|といい|べき|優先|ほうが|方が|おすすめ|勧め|まず|先に|良い|よい|大切|重要)/;

const items = (p) => p.steps.map((s) => s.item);
const idx = (p, name) => items(p).indexOf(name);
const step = (p, name) => p.steps.find((s) => s.item === name);
const JUNGLE = { inventory: [], visibleBlocks: ['jungle_log', 'grass_block', 'grass'], visibleMobs: [] };

// ---- 道筋 (planner) ----

test('planner: bed は 原木 → 板材 → 作業台、羊毛 ← sheep を要る物に入れ、見えている木の板材を選ぶ', () => {
  const p = plan('white_bed', 1, JUNGLE);
  assert.ok(p.ok);
  assert.deepStrictEqual(items(p), ['jungle_log', 'jungle_planks', 'crafting_table', 'white_wool', 'white_bed']);
  assert.strictEqual(step(p, 'jungle_log').how, 'collect');
  assert.strictEqual(step(p, 'jungle_log').where, 'visible');
  assert.strictEqual(step(p, 'jungle_planks').count, 7); // 作業台 4 + ベッド 3
  assert.deepStrictEqual(step(p, 'white_wool'), { item: 'white_wool', count: 3, how: 'kill', from: 'sheep', where: 'unseen', ings: undefined });
  assert.deepStrictEqual(step(p, 'white_bed').ings, { white_wool: 3, jungle_planks: 3 });
  assert.strictEqual(step(p, 'white_bed').station, 'crafting_table');
  assert.strictEqual(p.next.item, 'jungle_log');
  // 種類の名前 "bed" も、いちばん手間の小さい … _bed にする
  assert.strictEqual(plan('bed', 1, JUNGLE).target, 'white_bed');
});

test('planner: 作業台を持っている・見えているなら作業台は要る物に入れない。持ち物の分は引く', () => {
  const p = plan('white_bed', 1, { inventory: [{ name: 'crafting_table', count: 1 }, { name: 'white_wool', count: 3 }], visibleBlocks: ['oak_log'] });
  assert.deepStrictEqual(items(p), ['oak_log', 'oak_planks', 'white_bed']);
  const q = plan('white_bed', 1, { inventory: [{ name: 'oak_planks', count: 3 }], visibleBlocks: ['crafting_table'], visibleMobs: ['sheep'] });
  assert.deepStrictEqual(items(q), ['white_wool', 'white_bed']);
  assert.strictEqual(step(q, 'white_wool').where, 'visible');
  // 全部持っている → 揃っている
  const r = plan('white_bed', 1, { inventory: [{ name: 'white_bed', count: 1 }] });
  assert.ok(r.ok && r.done);
  assert.strictEqual(pathText(r), '道筋: 揃っている');
});

test('planner: cooked_beef は 木のツルハシ → 丸石 (stone を掘る) → かまど → beef ← cow → 焼く。燃料も要る物に入れる', () => {
  const p = plan('cooked_beef', 1, JUNGLE);
  assert.ok(p.ok);
  assert.ok(idx(p, 'wooden_pickaxe') < idx(p, 'cobblestone'));
  assert.ok(idx(p, 'cobblestone') < idx(p, 'furnace'));
  assert.strictEqual(step(p, 'cobblestone').from, 'stone');
  assert.strictEqual(step(p, 'cobblestone').tool, 'wooden_pickaxe');
  assert.strictEqual(step(p, 'beef').from, 'cow');
  const last = p.steps[p.steps.length - 1];
  assert.deepStrictEqual([last.item, last.how, last.from, last.station], ['cooked_beef', 'smelt', 'beef', 'furnace']);
  assert.match(last.fuel, /_planks$|_log$|coal/);
  // かまどが見えていて、生の肉と燃料を持っていれば焼くだけ
  const q = plan('cooked_beef', 2, { inventory: [{ name: 'beef', count: 2 }, { name: 'coal', count: 1 }], visibleBlocks: ['furnace'] });
  assert.deepStrictEqual(q.steps.map((s) => [s.item, s.how]), [['cooked_beef', 'smelt']]);
});

test('planner: stone_sword・furnace・torch・bread の連なり', () => {
  const sword = plan('stone_sword', 1, JUNGLE);
  assert.deepStrictEqual(items(sword), ['jungle_log', 'jungle_planks', 'crafting_table', 'stick', 'wooden_pickaxe', 'cobblestone', 'stone_sword']);
  assert.strictEqual(step(sword, 'cobblestone').count, 2);
  assert.deepStrictEqual(step(sword, 'stone_sword').ings, { cobblestone: 2, stick: 1 });
  const furn = plan('furnace', 1, JUNGLE);
  assert.strictEqual(step(furn, 'cobblestone').count, 8);
  assert.strictEqual(furn.steps[furn.steps.length - 1].item, 'furnace');
  // 松明: 石炭の鉱石が見えていて木のツルハシを持っていれば、石炭を掘って棒と合わせる
  const torch = plan('torch', 4, { inventory: [{ name: 'wooden_pickaxe', count: 1 }, { name: 'stick', count: 1 }], visibleBlocks: ['coal_ore'] });
  assert.deepStrictEqual(torch.steps.map((s) => [s.item, s.how, s.from || null]), [['coal', 'collect', 'coal_ore'], ['torch', 'craft', null]]);
  // 何も無ければ、ツルハシから
  const t2 = plan('torch', 4, JUNGLE);
  assert.ok(t2.ok && idx(t2, 'wooden_pickaxe') < idx(t2, 'coal'));
  const bread = plan('bread', 1, { inventory: [{ name: 'crafting_table', count: 1 }], visibleBlocks: ['wheat'] });
  assert.deepStrictEqual(bread.steps.map((s) => [s.item, s.count, s.how]), [['wheat', 3, 'collect'], ['bread', 1, 'craft']]);
});

test('planner: たどれない物は ok: false。地面そのもの (dirt) は掘る道筋にしない。めずらしい生き物は見えていなければ入手元にしない', () => {
  assert.strictEqual(plan('dirt', 1, JUNGLE).ok, false);
  assert.strictEqual(plan('cake', 1, JUNGLE).ok, false); // 牛乳・卵 (生き物に使う・産む) はたどらない
  assert.strictEqual(plan('nonexistent_thing', 1, JUNGLE).reason, 'unknown');
  const ip = plan('iron_pickaxe', 1, JUNGLE);
  assert.ok(ip.ok && !ip.steps.some((s) => s.from === 'iron_golem'));
  assert.strictEqual(step(ip, 'raw_iron').from, 'iron_ore');
  assert.strictEqual(step(ip, 'raw_iron').tool, 'stone_pickaxe');
});

test('pathText: 「ゴール / 道筋 / 次」の短い文。評価語を入れない', () => {
  const t = pathText(plan('white_bed', 1, JUNGLE));
  assert.strictEqual(t, '道筋: jungle_log 2 ← 掘る(見える)、jungle_planks 7 ← jungle_log 2、crafting_table 1 ← jungle_planks 4、white_wool 3 ← sheep(まだ見ていない)、white_bed 1 ← white_wool 3 + jungle_planks 3 (crafting_table) / 次: jungle_log を手に入れる');
  assert.doesNotMatch(t, ADVICE);
  const long = pathText(plan('iron_pickaxe', 1, JUNGLE), { maxShown: 3 });
  assert.match(long, /ほか\d+ \/ 次:/);
});

// ---- 候補 (vocab) ----

test('itemCandidates: 持ち物・見える物から手に入る物・知っていること・レシピで近い物を数十個。種類違いはまとめる。dirt は入れない', () => {
  const raw = mockRaw({ inventory: [{ name: 'jungle_log', count: 3 }], blocks: [{ name: 'jungle_log' }, { name: 'grass' }, { name: 'grass_block' }, { name: 'dirt' }, { name: 'stone' }], entities: [{ kind: 'mob', name: 'cow' }] });
  const c = itemCandidates({ raw, facts: knowledge.loadFacts(), maxItems: 40 });
  const names = c.map((x) => x.name);
  assert.ok(c.length <= 40 && c.length >= 20);
  assert.strictEqual(names[0], 'jungle_log');
  assert.match(c[0].desc, /持っている3/);
  for (const n of ['beef', 'jungle_planks', 'crafting_table', 'white_bed', 'furnace', 'torch', 'stone_sword']) assert.ok(names.includes(n), n);
  assert.ok(!names.includes('dirt') && !names.includes('grass_block'));
  assert.ok(!names.includes('oak_planks')); // 板材は見えている木の種類1つに
  assert.strictEqual(new Set(names.map(familyKey)).size, names.length);
  assert.match(c.find((x) => x.name === 'beef').desc, /食べ物/);
  for (const x of c) assert.doesNotMatch(x.desc, ADVICE, x.desc);
  assert.strictEqual(jaName('white_bed'), '白のベッド');
});

test('placeCandidates: 拠点・覚えている場所・8方位の遠く (行ったことがあるか)', () => {
  const pl = placeCandidates({ here: { x: 0, y: 64, z: 0 }, base: { x: 10, y: 64, z: 0 }, places: [{ id: 'M1', kind: '拠点' }, { id: 'M2', kind: 'chest', label: 'chest 北20m', pos: { x: 0, y: 64, z: -20 } }], cellAt: (x, z) => (z < -10 ? { n: 1 } : null) });
  assert.deepStrictEqual(pl.slice(0, 3).map((p) => p.name), ['拠点', 'M2', '北の方']);
  assert.match(pl[2].desc, /行ったことがある/);
  assert.match(pl.find((p) => p.name === '南の方').desc, /行ったことがない/);
});

test('parseGoal: target は候補から。kind が合わなければ target の種類に直す。count は 1〜64', () => {
  const cands = { items: [{ name: 'white_bed' }], people: [{ name: 'Ken' }], places: [{ name: '北の方', type: 'dir', vec: [0, -1] }] };
  assert.deepStrictEqual(parseGoal('{"kind":"item","target":"white_bed","count":200,"why":"眠りたいから","need":"眠気"}', cands),
    { kind: 'item', target: 'white_bed', count: 64, give: null, why: '眠りたいから', need: 'sleep', kindFixed: false, place: null });
  const p = parseGoal('{"kind":"item","target":"Ken","why":"会いたい","need":"人とのつながり"}', cands);
  assert.strictEqual(p.kind, 'person');
  assert.strictEqual(p.kindFixed, true);
  assert.strictEqual(parseGoal('{"kind":"place","target":"北の方","why":"x","need":"好奇心"}', cands).place.type, 'dir');
  assert.strictEqual(parseGoal('{"kind":"item","target":"diamond_hoe","why":"x","need":"眠気"}', cands), null);
  const s = goalSchema(cands, { giveItems: ['bread'] });
  assert.deepStrictEqual(s.properties.target.enum, ['white_bed', 'Ken', '北の方']);
  assert.deepStrictEqual(s.properties.give.enum, ['', 'bread']);
});

// ---- GoalPath (2B を模擬) ----

function mockLLM(outputs) {
  const seen = [];
  return { seen, complete: async (messages, schema) => { seen.push({ messages, schema }); return { text: outputs.shift(), promptTokens: 1500, completionTokens: 30 }; } };
}

function gctx(raw, over = {}) {
  return {
    persona: { name: 'Yuki', personality: '慎重で怖がり。夜が苦手。' }, goalText: '', obsText: '見えるブロック: jungle_log', raw, facts: () => [], allFacts: knowledge.loadFacts(),
    memText: 'なし', socialText: '眠い', worst: { need: 'sleep', text: '眠い (昨夜は寝ていない)' }, peopleText: 'Ken: 知り合い', people: [{ name: 'Ken', relation: '知り合い', seen: null }],
    places: [], placeKinds: [], base: null, needNow: () => 0.8, ...over,
  };
}

const rawWith = (inv = [], over = {}) => mockRaw({ inventory: inv, blocks: [{ name: 'jungle_log', nearest: { x: 3, y: 64, z: 0, d: 3 } }], entities: [], heard: [], ...over });

test('GoalPath: 物のゴール → 道筋を毎判断作り直す → 持ったら着いた → 欲求が下がれば達成して次のゴール', async () => {
  const llm = mockLLM(['{"kind":"item","target":"white_bed","count":1,"why":"眠りたいから","need":"眠気"}', '{"kind":"place","target":"北の方","why":"見てみたい","need":"好奇心"}']);
  const ev = [];
  const gp = new GoalPath({ llm, log: (e) => ev.push(e) });
  let need = 0.8;
  const ctx = (raw) => gctx(raw, { needNow: () => need });
  assert.strictEqual(await gp.update(ctx(rawWith()), 1), 'goal');
  assert.match(gp.planText(), /^ゴール: white_bed 1 \(眠りたいから\) \/ 道筋: jungle_log 2 ← 掘る\(見える\)、.* \/ 次: jungle_log を手に入れる$/);
  // 2B へのプロンプト: 候補・材料。評価語・欲求と物の対応は書かない
  const sys = llm.seen[0].messages[0].content; const user = llm.seen[0].messages[1].content;
  assert.match(user, /## めざせる物\n/);
  assert.match(user, /white_bed: 白のベッド/);
  assert.match(user, /## 人\nKen: 知り合い・今は見えない/);
  assert.match(user, /## いちばんつらいこと\n眠い/);
  assert.doesNotMatch(sys, ADVICE);
  assert.ok(llm.seen[0].schema.properties.target.enum.includes('white_bed'));
  // 原木を持つと次は板材を作る
  await gp.update(ctx(rawWith([{ name: 'jungle_log', count: 2 }])), 2);
  assert.match(gp.planText(), /次: jungle_planks を作る$/);
  assert.ok(ev.filter((e) => e.kind === 'path').length >= 2);
  // ベッドを持った: 着いた (欲求はまだ下がらない → 待つ)
  assert.strictEqual(await gp.update(ctx(rawWith([{ name: 'white_bed', count: 1 }])), 3), null);
  assert.ok(ev.some((e) => e.kind === 'reached'));
  assert.match(gp.planText(), /手に入れた$/);
  // 置いて持ち物から消えても済んだまま。眠気が下がったら達成 → 次のゴール (場所)
  assert.strictEqual(await gp.update(ctx(rawWith()), 4), null);
  need = 0.2;
  assert.strictEqual(await gp.update(ctx(rawWith()), 5), 'goal_done');
  assert.strictEqual(gp.goal.kind, 'place');
  assert.match(gp.planText(), /^ゴール: 北の方へ行く \(見てみたい\) \/ 次: 北の方へ \(あと48mほど\)$/);
  assert.match(llm.seen[1].messages[1].content, /## これまでのゴール\nwhite_bed 1 \(何のため: 眠りたいから\): 達成した/);
  const goalEv = ev.find((e) => e.kind === 'goal');
  assert.deepStrictEqual([goalEv.goalKind, goalEv.target, goalEv.count, goalEv.why, goalEv.need, goalEv.needAt], ['item', 'white_bed', 1, '眠りたいから', 'sleep', 0.8]);
  assert.ok(goalEv.path.steps.length === 5 && goalEv.prompt);
  assert.strictEqual(gp.counts.done, 1);
});

test('GoalPath: 手に入れても欲求が下がらなければ needWait 判断後に選び直し。道筋が縮まなければ stuck で選び直し', async () => {
  const llm = mockLLM([
    '{"kind":"item","target":"jungle_log","count":1,"why":"x","need":"眠気"}',
    '{"kind":"item","target":"white_bed","count":1,"why":"眠りたい","need":"眠気"}',
    '{"kind":"item","target":"white_bed","count":1,"why":"眠りたい","need":"眠気"}',
  ]);
  const ev = [];
  const gp = new GoalPath({ llm, log: (e) => ev.push(e), cfg: { needWait: 3, patience: 4 } });
  const have = rawWith([{ name: 'jungle_log', count: 1 }]);
  await gp.update(gctx(have), 1);
  assert.strictEqual(gp.goal.target, 'jungle_log');
  for (let t = 2; t <= 3; t++) assert.strictEqual(await gp.update(gctx(have), t), null);
  assert.strictEqual(await gp.update(gctx(have), 4), 'need_unmet');
  assert.match(llm.seen[1].messages[1].content, /jungle_log 1 \(何のため: x\): 手に入れた\/着いたが、眠気のつらさは変わらなかった/);
  // white_bed: 持ち物が変わらないまま patience 判断 → stuck
  const none = rawWith();
  let r = null;
  for (let t = 5; t <= 10 && r !== 'stuck'; t++) r = await gp.update(gctx(none), t);
  assert.strictEqual(r, 'stuck');
  const st = ev.find((e) => e.kind === 'reselect' && e.result === 'stuck');
  assert.match(st.reason, /判断、道筋が縮まなかった/);
  assert.strictEqual(st.next, 'jungle_log');
  assert.strictEqual(gp.counts.needUnmet, 1);
  assert.strictEqual(gp.counts.stuck, 1);
});

test('GoalPath: 困りごとが troubleTicks 判断続くと選び直し。人のゴールは近くに来たら着いた', async () => {
  const llm = mockLLM(['{"kind":"person","target":"Ken","why":"話したい","need":"人とのつながり"}', '{"kind":"person","target":"Ken","why":"話したい","need":"人とのつながり"}']);
  const gp = new GoalPath({ llm, cfg: { troubleTicks: 2 } });
  await gp.update(gctx(rawWith()), 1);
  assert.match(gp.planText(), /^ゴール: Ken の近くにいる \(話したい\) \/ 次: Ken の所へ行く \(今は見えない\)$/);
  const tr = [{ key: 'go_to:Ken', about: 'go_to(Ken)' }];
  assert.strictEqual(await gp.update(gctx(rawWith()), 2, { troubles: tr }), null);
  assert.strictEqual(await gp.update(gctx(rawWith()), 3, { troubles: tr }), 'stuck');
  const near = rawWith([], { entities: [{ kind: 'player', name: 'Ken', pos: { x: 2, y: 64, z: 0 }, d: 2 }] });
  await gp.update(gctx(near, { needNow: () => 0.8 }), 4);
  assert.ok(gp.goal.metAt === 4);
  assert.match(gp.planText(), /近くにいる$/);
});

test('GoalPath: たどれない物を選んだら、その旨を添えて聞き直す (maxTries 回まで)', async () => {
  // 候補はたどれる物だけなので、ここでは planner が cake をたどれなかったことにする
  const llm = mockLLM(['{"kind":"item","target":"white_bed","count":1,"why":"眠りたい","need":"眠気"}', '{"kind":"item","target":"bread","count":1,"why":"食べたい","need":"空腹"}']);
  const ev = [];
  const gp = new GoalPath({ llm, log: (e) => ev.push(e) });
  const orig = gp.planItem.bind(gp);
  gp.planItem = (c, target, n) => (target === 'white_bed' ? { ok: false, target, reason: 'untraceable', missing: 'white_wool', steps: [] } : orig(c, target, n));
  const ctx = gctx(rawWith(), { allFacts: [{ items: ['white_bed', 'bread'] }] });
  await gp.update(ctx, 1);
  assert.strictEqual(gp.goal.target, 'bread');
  assert.ok(ev.some((e) => e.kind === 'unplannable' && e.target === 'white_bed' && e.missing === 'white_wool'));
  assert.match(llm.seen[1].messages[1].content, /## さっき選んだゴール\nwhite_bed 1: white_wool の作り方も手に入れ方も分からなかった/);
  assert.strictEqual(gp.counts.unplannable, 1);
});

// ---- agent / Jev ----

function survivalCtx(over = {}, extra = {}) {
  const cfg = loadConfig(CFG, { persona: { name: 'Taro' } });
  return buildContext(mockRaw(over), new Memory({ limits: cfg.memory.limits }), cfg, { foods: new Set(['bread']), ...extra });
}

test('Jev: goalPath のとき plan は道筋の文。step_done は聞かない。拠点の様子は now に入る', async () => {
  const plan = 'ゴール: white_bed 1 (眠りたいから) / 道筋: jungle_log 2 ← 掘る(見える) / 次: jungle_log を手に入れる';
  const c = survivalCtx({}, { planText: plan, baseText: '拠点 (M1) の近く: chest 1、明るい、囲まれていない' });
  assert.ok(c.goalPath && !c.goalPlan && !c.selfGoal);
  assert.strictEqual(c.progress, plan);
  assert.match(c.obsText, /\n拠点 \(M1\) の近く: chest 1/);
  const bodies = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body); bodies.push(body);
    const k = Object.keys(body.questions.next_action.criteria)[0];
    return { ok: true, status: 200, headers: new Map(), json: async () => ({ answers: { next_action: { type: 'choice', choice: k, confidence: 0.6 }, remember: { type: 'score', score: 1 } }, usage: { input_tokens: 2000, output_tokens: 10 } }) };
  };
  const d = new JevDecider({ client: new JevClient({ apiKey: 'k', fetch }), twoStage: false });
  await d.decide(c);
  assert.strictEqual(bodies[0].state.plan, plan);
  assert.ok(!bodies[0].questions.step_done && !bodies[0].questions.goal_done);
  assert.match(bodies[0].questions.next_action.instructions, /"X n ← Y"/);
});

// ---- 拠点の様子 ----

test('baseSite: 拠点の近くに置かれた物を数える (自然のブロックは数えない・ベッドは2マスで1つ・壁の松明は松明)', () => {
  const m = new Map();
  for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) m.set(`${x},63,${z}`, 'grass_block');
  m.set('1,64,0', 'chest'); m.set('2,64,0', 'white_bed'); m.set('2,64,1', 'white_bed'); m.set('-1,64,0', 'furnace');
  m.set('0,65,2', 'wall_torch'); m.set('0,64,3', 'torch'); m.set('3,64,3', 'oak_log');
  const at = (x, y, z) => { const n = m.get(`${x},${y},${z}`); return n ? { name: n, boundingBox: 'block', light: 0 } : { name: 'air', boundingBox: 'empty', light: 12 }; };
  const s = baseSite(at, { x: 0, y: 64, z: 0 });
  assert.deepStrictEqual(s.counts, { chest: 1, white_bed: 1, furnace: 1, torch: 2 });
  assert.strictEqual(s.enclosed, false);
  const t = baseSiteText(s, { label: '拠点 (M1)' });
  assert.strictEqual(t, '拠点 (M1)の近く: torch 2、chest 1、furnace 1、white_bed 1、明るい、囲まれていない');
  assert.doesNotMatch(t, ADVICE);
  assert.match(baseSiteText(s, { label: '拠点', near: false, dirText: '北20m' }), /^拠点 \(北20m\) 前に見たとき: /);
});

// ---- 記録のまとめ ----

test('summarize_run: goal_path のゴールの一覧・達成・選び直し・道筋の進み・拠点に集まった物', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-'));
  const t = (s) => new Date(Date.UTC(2026, 10, 4, 1, 0, 0) + s * 1000).toISOString();
  const L = (o) => JSON.stringify(o);
  const step = (loop, s) => ({ ts: t(s), loop, day: 0, timeOfDay: 1000, pos: { x: 0, y: 64, z: 0 }, action: 'collect', arg: 'jungle_log', result: { ok: true, msg: 'ok' }, decideMs: 300, parseOk: true, valid: true, inventory: [], foodCount: 0, jev: { inputTokens: 2500, inputChars: 4000, ms: 300 } });
  fs.writeFileSync(path.join(dir, 'Yuki-x.jsonl'), [
    L({ ts: t(0), event: 'start', persona: { name: 'Yuki' }, help: { goalPath: true }, day: 0 }),
    L({ ts: t(1), event: 'goal_path', kind: 'unplannable', ok: false, tick: 1, goalKind: 'item', target: 'cake', count: 1, missing: 'cake' }),
    L({ ts: t(1), event: 'goal_path', kind: 'goal', ok: true, tick: 1, goalKind: 'item', target: 'white_bed', count: 1, why: '眠りたい', need: 'sleep', reason: 'start', path: { ok: true, steps: [{ item: 'jungle_log', count: 2 }, { item: 'white_bed', count: 1 }], next: 'jungle_log' } }),
    L({ ts: t(1), event: 'goal_path', kind: 'path', tick: 1, next: 'jungle_log' }),
    L(step(1, 2)),
    L({ ts: t(3), event: 'goal_path', kind: 'path', tick: 2, next: 'jungle_planks' }),
    L({ ts: t(4), event: 'goal_path', kind: 'reached', tick: 5, goal: 'white_bed 1', took: 4 }),
    L({ ts: t(5), event: 'goal_path', kind: 'reselect', result: 'need_unmet', goalKind: 'item', tick: 9, target: 'white_bed', count: 1 }),
    L({ ts: t(6), event: 'base_site', loop: 9, center: { x: 0, y: 64, z: 0 }, isBase: true, counts: { chest: 1, white_bed: 1 }, text: '拠点の近く: chest 1、white_bed 1' }),
    L(step(2, 7)),
  ].join('\n'));
  const out = JSON.parse(execFileSync('node', [path.join(__dirname, '..', 'tools', 'summarize_run.js'), dir], { encoding: 'utf8' }));
  const g = out.goalPath;
  assert.strictEqual(g.goals, 1);
  assert.deepStrictEqual(g.byKind, { item: 1 });
  assert.strictEqual(g.unplannable, 1);
  assert.strictEqual(g.reached, 1);
  assert.deepStrictEqual(g.reselect, { need_unmet: 1 });
  assert.deepStrictEqual(g.progress, ['Yuki white_bed 1: jungle_log → jungle_planks']);
  assert.ok(g.timeline.some((l) => /goal item:white_bed 1 \(何のため: 眠りたい/.test(l)));
  assert.deepStrictEqual(out.baseSite.Yuki.max, { chest: 1, white_bed: 1 });
  const txt = execFileSync('node', [path.join(__dirname, '..', 'tools', 'summarize_run.js'), dir, '--text'], { encoding: 'utf8' });
  assert.match(txt, /ゴール 1 個 \(item 1、読めなかった 0、たどれなかった 1\)/);
  assert.match(txt, /拠点 Yuki: 拠点の近く: chest 1、white_bed 1/);
});
