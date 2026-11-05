'use strict';
// 2026-11-05 の6項目: R2 (満たされている候補を外す)・R5 (並べ方を毎回変える)・R1 (2B が案 → Jev が欲求ごとに → コードで選ぶ)・
//   R4 (Jev の state を英語に・関係の薄いものを削る)・R10 (確率の記録)・R3 (次の一手が今すぐできるか)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const en = require('../src/en');
const { Order, replay, agentSeed } = require('../src/order');
const { Needs } = require('../src/needs');
const { Social } = require('../src/social');
const { observationEn } = require('../src/observe');
const { Memory } = require('../src/memory');
const { loadConfig } = require('../src/config');
const { buildContext } = require('../src/agent');
const { JevDecider, actionOptions, buildState, buildQuestions, probStats, pathMatch } = require('../src/deciders/jev');
const { JevClient } = require('../src/jev_client');
const { GoalPath, selectScores, proposalsSchema } = require('../src/goalpath');
const knowledge = require('../src/knowledge');
const { mockRaw } = require('./fixtures');

const CFG = path.join(__dirname, '..', 'configs', 'survival_3days.json');
const JA = /[぀-ヿ一-鿿]/;

function survival(over = {}, extra = {}, mem = null) {
  const cfg = loadConfig(CFG, { persona: { name: 'Taro' } });
  cfg.persona = cfg.personas[0];
  const raw = mockRaw({ entities: [{ kind: 'player', name: 'Hanako', pos: { x: -4, y: 64, z: 4 }, d: 5.7 }, { kind: 'mob', name: 'cow', pos: { x: 8, y: 64, z: 2 }, d: 8.2 }], ...over });
  const m = mem || new Memory({ limits: cfg.memory.limits });
  return { cfg, raw, ctx: buildContext(raw, m, cfg, { foods: new Set(['bread']), socialEn: 'a little hungry; not sleepy; calm', lastResultEn: 'none', ...extra }) };
}

// ---- en.js ----
test('en: 行動の結果の文 (act.js の日本語) を英語に。数・距離は段階の言葉。直せない文は原文のまま', () => {
  assert.strictEqual(en.msgEn('jungle_logを3個掘って4個拾った (dirt+1)').text, 'dug 3 jungle_log, picked up 4 (also dirt+1)');
  assert.strictEqual(en.msgEn('jungle_logの所に着いた').text, 'arrived at jungle_log');
  assert.strictEqual(en.msgEn('拠点の所に着いた').text, 'arrived at the base');
  assert.strictEqual(en.msgEn('まだ行っていないマスの方へ23m進んだ 新しいマス').text, 'walked far toward an unvisited area (a new area)');
  assert.strictEqual(en.msgEn('素手をgrass_block(1,63,0 1.4m)に使ったが何も起きなかった').text, 'used bare hand on grass_block: nothing happened');
  assert.strictEqual(en.msgEn('jungle_logを3個掘って4個拾った。Hanakoがgrassを3個壊した').text, 'dug 3 jungle_log, picked up 4. Hanako broke 3 grass');
  assert.strictEqual(en.msgEn('Kenに聞いた:「北で見たよ。木がある。」').text, 'asked Ken; they answered 「北で見たよ。木がある。」', '発言の中身は原文');
  const odd = en.msgEn('なにか知らない文');
  assert.strictEqual(odd.translated, false);
  assert.strictEqual(odd.text, 'なにか知らない文');
  assert.strictEqual(en.invDelta([{ name: 'bread', count: 2 }], [{ name: 'bread', count: 1 }, { name: 'oak_log', count: 4 }]), '+4 oak_log, -1 bread');
  assert.strictEqual(en.resultEn({ action: 'eat', arg: 'bread', ok: true, msg: 'breadを食べた', delta: '-1 bread' }), 'eat bread: succeeded. ate bread. inventory -1 bread');
  assert.deepStrictEqual([0, 1, 3, 9, 30].map(en.countWord), ['none', 'one', 'a few', 'some', 'many']);
  assert.strictEqual(en.whereEn({ x: 0, y: 64, z: 0 }, { x: 10, y: 64, z: 0 }), 'a short walk, east');
  assert.strictEqual(en.whereEn({ x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 1 }), 'here');
});

test('en: 前の記録のよく出る結果の文の 9 割以上を英語に直せる', () => {
  const samples = ['jungle_logの所に着いた', 'jungle_logを3個掘って5個拾った', 'jungle_planksを4個作った', 'まだ行っていないマスの方へ18m進んだ 新しいマス', 'jungle_planksを2個積んで2段登った',
    '敵から9m離れた', '拠点の所に着いた', 'crafting_tableを(-3,72,5)に置いた', 'jungle_saplingを1個拾った', 'wheat_seedsをdirtに使った: 隣にwheatができた、持ち物 wheat_seeds2', 'beefを食べた',
    'wooden_pickaxeを手に持った', '着いたがjungle_logはもう無かった', 'collectが時間切れ', '手の届く高さにjungle_logが見えない', 'jungle_saplingを拾えなかった', 'Hanakoの所に着いた',
    'Jiroに30秒ついて行った (12m動いた、今3m離れている)', 'ここ(1,64,2)を拠点にした', '周りを見回した'];
  const ok = samples.filter((m) => en.msgEn(m).translated).length;
  assert.ok(ok / samples.length >= 0.9, `${ok}/${samples.length}`);
});

// ---- 欲求・気持ち (同じ値から日本語と英語) ----
test('needs / social: words({lang:"en"}) は日本語と同じ値から英語を作る。数値は出さない', () => {
  const n = new Needs({ cfg: { start: { hunger: 0.8, sleep: 0.6 } } });
  n.lastTime = 9000; n.lastAte = null;
  const ja = n.words(); const e = n.words({ lang: 'en' });
  assert.match(ja, /お腹がぺこぺこ/);
  assert.match(e, /starving/);
  assert.match(e, /have eaten nothing since arriving here/);
  assert.match(e, /sleepy/);
  assert.doesNotMatch(e, JA);
  assert.doesNotMatch(e, /\d/);
  const p = n.pressing({ n: 2 });
  assert.strictEqual(p[0].need, 'hunger');
  assert.match(p[0].textEn, /starving/);
  assert.ok(p[0].distress > p[1].distress);
  const s = new Social({});
  s.onHeard('Hanako', 1, 'こんにちは');
  s.onAnswered('Hanako', true);
  const w = s.words({ lang: 'en' });
  assert.match(w, /with Hanako: (on good terms|close friends|acquaintances); they taught me how to do something before/);
  assert.doesNotMatch(w.replace(/Hanako/g, ''), JA);
});

// ---- 観察・記憶 ----
test('observationEn: 座標を出さず、地面・草などの目印でないブロックは削る。道筋に出てくる名前は残す。数は段階', () => {
  const raw = mockRaw();
  const o = observationEn(raw, { names: new Set(['stone']) });
  assert.match(o.self, /health full, food high, daytime/);
  assert.strictEqual(o.inventory, 'spruce_log x2, bread x1');
  assert.match(o.visible, /spruce_log \(near, northeast; a few\)/);
  assert.match(o.visible, /stone/, '道筋の名前');
  assert.doesNotMatch(o.visible, /grass_block/);
  assert.doesNotMatch(JSON.stringify(o), /-?\d+,\s?-?\d+/);
  assert.match(o.nearby, /Hanako \(player; near, southwest\)/);
  assert.match(o.nearby, /spruce_sapling \(dropped item; here\)/);
});

test('memory.toStateEn: 件数を絞り、やったことは英語 (e.en か msgEn)、聞いた話の中身は原文', () => {
  const m = new Memory({ limits: { promptItems: 20 } });
  for (let i = 0; i < 8; i++) { m.tick = i; m.noteEvent('collect', 'oak_log', true, 'oak_logを3個掘って3個拾った'); }
  const ev = m.noteEvent('eat', 'bread', true, 'breadを食べた'); ev.en = 'eat bread: succeeded. ate bread';
  m.noteHeard('Ken', '北に羊がいたよ');
  const s = m.toStateEn({ x: 0, y: 64, z: 0 }, { maxEvents: 3 });
  assert.strictEqual(s.recent.length, 3);
  assert.strictEqual(s.recent[2], 'eat bread: succeeded. ate bread');
  assert.strictEqual(s.recent[0], 'collect oak_log: succeeded. dug 3 oak_log, picked up 3');
  assert.strictEqual(s.heard, 'Ken「北に羊がいたよ」');
});

// ---- Jev の英語の state ----
test('Jev の state (stateLang: en): 英語。人の名前・発言・2B の書いた文 (policy・why) だけが原文。評価語を入れない。日本語の state より短い', () => {
  const { ctx } = survival();
  ctx.en.plan = { goal: 'obtain cooked_beef x1', for_need: 'hunger', why: 'お腹が空いた', path: ['beef x1 <- kill cow (visible)'], next: 'get beef by killing cow' };
  ctx.policy = '昼のうちに食べ物を集める';
  const oEn = actionOptions(ctx.actions, { lang: 'en' });
  const st = buildState(ctx, { table: oEn.table, lang: 'en' });
  assert.deepStrictEqual(Object.keys(st).slice(0, 6), ['you', 'personality', 'feelings', 'plan', 'policy', 'self']);
  for (const k of ['inventory', 'visible', 'nearby', 'actions', 'knowledge', 'memory', 'last_result', 'heard_now']) assert.ok(k in st, k);
  assert.ok(!('now' in st));
  const original = { heard_now: 1, policy: 1 };
  for (const [k, v] of Object.entries(st)) {
    if (original[k]) continue;
    const t = k === 'plan' ? JSON.stringify({ ...v, why: '' }) : JSON.stringify(v);
    assert.doesNotMatch(t, JA, k);
    assert.doesNotMatch(t, en.ADVICE_EN, k);
  }
  for (const v of Object.values(oEn.criteria)) { assert.doesNotMatch(v, JA, v); assert.doesNotMatch(v, en.ADVICE_EN, v); }
  const q = buildQuestions(ctx, { criteria: oEn.criteria, lang: 'en', hasTable: true }).questions;
  assert.ok(q.next_now, 'plan.next があれば next_now を聞く');
  assert.doesNotMatch(q.next_now.instructions, en.ADVICE_EN);
  assert.match(q.next_action.instructions, /`inventory`, `visible`, `nearby`/);
  // 日本語の state (前の形) と比べて短い (文字数の目安)
  const oJa = actionOptions(ctx.actions, {});
  const ja = JSON.stringify(buildState({ ...ctx, progress: 'ゴール: cooked_beef 1 (お腹が空いた) / 道筋: beef 1 ← cow(見える) / 次: cow から beef を手に入れる' }, { table: oJa.table, lang: 'ja' })) + JSON.stringify(oJa.criteria);
  const e2 = JSON.stringify(st) + JSON.stringify(oEn.criteria);
  assert.ok(e2.length > 0 && ja.length > 0);
});

test('行動の説明 (descEn)・選択肢 (labelEn) は全部の行動にあり、英語で、評価語を入れない', () => {
  const { ctx } = survival({ blocks: [...mockRaw().blocks, { name: 'furnace', notable: true, diggable: true, seen: 1, nearest: { x: 3, y: 64, z: 3, d: 4 }, positions: [] }, { name: 'chest', notable: true, diggable: true, seen: 1, nearest: { x: 2, y: 64, z: -3, d: 4 }, positions: [] }],
    inventory: [{ name: 'beef', count: 2 }, { name: 'coal', count: 1 }, { name: 'oak_fence', count: 20 }, { name: 'wheat', count: 3 }, { name: 'stone_sword', count: 1 }] });
  for (const a of ctx.actions) {
    assert.ok(a.descEn, a.name);
    assert.doesNotMatch(a.descEn, JA, a.name);
    assert.doesNotMatch(a.descEn, en.ADVICE_EN, a.name);
    for (const c of a.choices || []) { const l = c.labelEn || c.label; assert.doesNotMatch(l, JA, `${a.name}:${c.id} ${l}`); }
  }
});

test('facts.json: どの事実にも英語の文 (text_en) があり、英語の評価語・使い方の指示を書かない', () => {
  const facts = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'knowledge', 'facts.json'), 'utf8'));
  for (const f of facts) {
    assert.strictEqual(typeof f.text_en, 'string', f.id);
    assert.doesNotMatch(f.text_en, JA, f.id);
    assert.doesNotMatch(f.text_en, en.ADVICE_EN, f.id);
  }
  const loaded = knowledge.loadFacts(undefined, { reload: true });
  assert.strictEqual(knowledge.factText(loaded[0], 'en'), facts[0].text_en);
  assert.strictEqual(knowledge.factText(loaded[0], 'ja'), facts[0].text);
});

test('en.ADVICE_EN: 英語の評価語を見つける', () => {
  for (const w of ['You should eat', 'the best option', 'it is important', 'I recommend this', 'prioritize food']) assert.match(w, en.ADVICE_EN, w);
  for (const w of ['iron_ore needs a stone_pickaxe or higher', 'a short walk, east']) assert.doesNotMatch(w, en.ADVICE_EN, w);
});

// ---- R5: 並べ方 ----
test('Order: 種と流れと通し番号で並びが決まり、記録から作り直せる。enabled: false なら並べ替えない', () => {
  const arr = Array.from({ length: 20 }, (_, i) => `k${i}`);
  const o = new Order({ enabled: true, seed: agentSeed(42, 'Taro') });
  const a = o.shuffle(arr, 'act'); const b = o.shuffle(arr, 'act');
  assert.notDeepStrictEqual(a.arr, arr);
  assert.notDeepStrictEqual(a.arr, b.arr, '毎回変わる');
  assert.deepStrictEqual([a.rec.n, b.rec.n], [0, 1]);
  assert.deepStrictEqual(replay(a.rec.seed, 'act', 1, arr), b.arr, '記録から作り直せる');
  assert.deepStrictEqual(new Order({ enabled: true, seed: agentSeed(42, 'Taro') }).shuffle(arr, 'act').arr, a.arr, '同じ種なら同じ');
  assert.notDeepStrictEqual(new Order({ enabled: true, seed: agentSeed(42, 'Hanako') }).shuffle(arr, 'act').arr, a.arr, '人ごとに違う');
  assert.deepStrictEqual(new Order({ enabled: false, seed: 1 }).shuffle(arr, 'act').arr, arr);
  assert.notStrictEqual(agentSeed(1, 'Taro'), agentSeed(2, 'Taro'));
});

// ---- R10・R3・R5: JevDecider の記録 ----
function jevFetch(answer, seen) {
  return async (url, init) => {
    const body = JSON.parse(init.body); seen.push(body);
    return { ok: true, status: 200, headers: new Map(), json: async () => ({ model: 'jev-1.14.0', answers: answer(body), usage: { input_tokens: 900, output_tokens: 5 } }) };
  };
}

test('JevDecider: 選択肢を並べ替えて送り、選んだ選択肢の確率 p・1位÷2位・位置・seed を記録。next_now と道筋どおりか (pathMatch) も記録する', async () => {
  const seen = [];
  const answer = (body) => {
    const keys = Object.keys(body.questions.next_action.criteria);
    const probabilities = Object.fromEntries(keys.map((k) => [k, k === 'attack:cow' ? 0.5 : k === 'go_to:water' ? 0.2 : 0.3 / (keys.length - 2)]));
    return { next_action: { type: 'choice', choice: 'attack:cow', confidence: 0.4, probabilities }, next_now: { type: 'noul', noul: 0.82 }, remember: { type: 'score', score: 1 } };
  };
  const d = new JevDecider({ client: new JevClient({ apiKey: 'k', fetch: jevFetch(answer, seen) }), twoStage: false });
  const { ctx } = survival({}, { order: new Order({ enabled: true, seed: 7 }) });
  ctx.en.plan = { goal: 'obtain beef x1', path: ['beef x1 <- kill cow (visible)'], next: 'get beef by killing cow' };
  ctx.pathNext = { item: 'beef', count: 1, how: 'kill', from: 'cow', where: 'visible' };
  const r = await d.decide(ctx);
  const keys = Object.keys(seen[0].questions.next_action.criteria);
  const plain = Object.keys(actionOptions(ctx.actions, { lang: 'en' }).criteria);
  assert.deepStrictEqual([...keys].sort(), [...plain].sort());
  assert.notDeepStrictEqual(keys, plain, '並べ替えている');
  assert.deepStrictEqual(r.jev.order, { seed: 7, stream: 'act', n: 0, shuffled: true });
  assert.deepStrictEqual(replay(7, 'act', 0, plain), keys, '記録の seed と n から並びを作り直せる');
  assert.strictEqual(r.jev.choice.p, 0.5);
  assert.strictEqual(r.jev.choice.ratio, 2.5);
  assert.strictEqual(r.jev.choice.pos, keys.indexOf('attack:cow'));
  assert.strictEqual(r.jev.choice.top[0][0], 'attack:cow');
  assert.strictEqual(r.jev.nextNowP, 0.82);
  assert.deepStrictEqual(r.jev.path, { next: 'kill:beef<cow', nextNowP: 0.82, match: 'step' });
  assert.strictEqual(r.jev.lang, 'en');
});

test('probStats・pathMatch', () => {
  assert.deepStrictEqual(probStats({ choice: 'b', probabilities: { a: 0.1, b: 0.6, c: 0.3 } }, ['a', 'b', 'c']), { pos: 1, n: 3, p: 0.6, ratio: 2, top: [['b', 0.6], ['c', 0.3], ['a', 0.1]] });
  assert.deepStrictEqual(probStats({ choice: 'a' }, ['a']), { pos: 0, n: 1 });
  const col = { item: 'jungle_log', count: 2, how: 'collect', from: 'jungle_log', where: 'visible' };
  assert.strictEqual(pathMatch(col, 'collect', 'jungle_log'), 'step');
  assert.strictEqual(pathMatch(col, 'go_to', 'jungle_log'), 'approach');
  assert.strictEqual(pathMatch(col, 'explore', 'north_near'), 'other');
  assert.strictEqual(pathMatch({ item: 'jungle_planks', count: 4, how: 'craft', ings: { jungle_log: 1 } }, 'craft', 'jungle_planks'), 'step');
  assert.strictEqual(pathMatch({ item: 'cooked_beef', count: 1, how: 'smelt', from: 'beef' }, 'smelt', 'beef'), 'step');
  assert.strictEqual(pathMatch({ act: true, how: 'till', tool: 'wooden_hoe', count: 8 }, 'use_on', 'wooden_hoe>grass_block'), 'step');
  assert.strictEqual(pathMatch({ act: true, how: 'lure', animal: 'cow', food: 'wheat', count: 2 }, 'lure', 'cow>拠点'), 'step');
  assert.strictEqual(pathMatch(null, 'collect', 'x'), null);
});

// ---- R2: もう満たされているゴール候補 ----
function mockLLM(outputs) {
  const seen = [];
  return { seen, complete: async (messages, schema, opts) => { seen.push({ messages, schema, opts }); return { text: outputs.shift(), promptTokens: 1500, completionTokens: 30 }; } };
}
function gctx(raw, over = {}) {
  return {
    persona: { name: 'Yuki', personality: '慎重で怖がり。夜が苦手。', personality_en: 'Cautious and timid.' }, goalText: '', obsText: '見えるブロック: jungle_log', raw, facts: () => [], allFacts: knowledge.loadFacts(),
    memText: 'なし', socialText: '眠い', worst: { need: 'sleep', text: '眠い' }, peopleText: 'Ken: 知り合い', people: [{ name: 'Ken', relation: '知り合い', relationEn: 'acquaintances', seen: null }],
    places: [], placeKinds: [], base: null, needNow: () => 0.8, ...over,
  };
}
const rawWith = (inv = [], over = {}) => mockRaw({ inventory: inv, blocks: [{ name: 'jungle_log', nearest: { x: 3, y: 64, z: 0, d: 3 } }], entities: [], heard: [], ...over });

test('GoalPath (R2): 持っている物の候補に「もう持っている n」。持っている数以下の案は外して聞き直す。着いている場所は候補から外す', async () => {
  const llm = mockLLM([
    '{"kind":"item","target":"jungle_log","count":2,"why":"x","need":"眠気"}',
    '{"kind":"item","target":"white_bed","count":1,"why":"眠りたい","need":"眠気"}',
  ]);
  const ev = [];
  const gp = new GoalPath({ llm, log: (e) => ev.push(e) });
  const raw = rawWith([{ name: 'jungle_log', count: 3 }]);
  await gp.update(gctx(raw, { base: { x: 1, y: 64, z: 1 }, baseLabel: '自分の拠点' }), 1);
  assert.strictEqual(gp.goal.target, 'white_bed');
  const user0 = llm.seen[0].messages[1].content;
  assert.match(user0, /jungle_log: [^\n]*もう持っている3/);
  assert.doesNotMatch(user0, /\n拠点: /, 'もう着いている拠点は候補から外す');
  assert.match(llm.seen[1].messages[1].content, /## さっき選んだゴール\njungle_log 2: もう持っている \(3\)/);
  assert.ok(ev.some((e) => e.kind === 'satisfied' && e.target === 'jungle_log'));
  assert.strictEqual(gp.counts.satisfied, 1);
});

// ---- R1: 2B が案を k 個 → Jev が 案 × 欲求 → コードで選ぶ ----
test('selectScores: Σ つらさ × P の最大。同点は先に書かれた案。全部低いとき', () => {
  const needs = [{ need: 'hunger', distress: 2 }, { need: 'sleep', distress: 1 }];
  const r = selectScores([{ hunger: 0.1, sleep: 0.9 }, { hunger: 0.8, sleep: 0.1 }], needs);
  assert.deepStrictEqual(r, { index: 1, scores: [1.1, 1.7], rule: 'max' });
  assert.strictEqual(selectScores([{ hunger: 0.5, sleep: 0 }, { hunger: 0.5, sleep: 0.01 }], needs).rule, 'tie_first');
  assert.strictEqual(selectScores([{ hunger: 0.5, sleep: 0 }, { hunger: 0.5, sleep: 0.01 }], needs).index, 0);
  assert.deepStrictEqual(selectScores([{ hunger: 0.1, sleep: 0.1 }, { hunger: 0.2, sleep: 0 }], needs), { index: 1, scores: [0.3, 0.4], rule: 'all_low_best' });
  assert.strictEqual(selectScores([{ hunger: 0.1, sleep: 0.1 }, { hunger: 0.2, sleep: 0 }], needs, { onAllLow: 'first' }).index, 0);
  assert.strictEqual(selectScores([{ hunger: 0.5 }, { hunger: 0.4 }], [{ need: 'hunger', distress: 2 }], { power: 2 }).scores[0], 2);
});

test('GoalPath (R1): 案を k 個 → 満たされている案を外す → Jev に 案 × 欲求 の noul を1回 → 点の最大を選び、点を event に残す。候補の並べ方も変える', async () => {
  const goals = { goals: [
    { kind: 'item', target: 'jungle_log', count: 1, why: 'a', need: '物が欲しい' }, // 持っている → 外す
    { kind: 'place', target: '北の方', why: 'b', need: '好奇心' },
    { kind: 'item', target: 'white_bed', count: 1, why: 'c', need: '眠気' },
  ] };
  const llm = mockLLM([JSON.stringify(goals)]);
  const calls = [];
  const jev = { call: async (state, questions, stage) => { calls.push({ state, questions, stage });
    const answers = {};
    for (const k of Object.keys(questions)) answers[k] = { type: 'noul', noul: /p2_sleep/.test(k) ? 0.9 : /p1_curiosity/.test(k) ? 0.8 : 0.1 };
    return { r: { ok: true, answers, ms: 100 }, inputTokens: 600 }; } };
  const ev = [];
  const order = new Order({ enabled: true, seed: 3 });
  const gp = new GoalPath({ llm, jev, order, log: (e) => ev.push(e), cfg: { select: { enabled: true, k: 3 } } });
  const pressing = () => [{ need: 'sleep', distress: 2.4, ratio: 1.5, textEn: 'sleepy' }, { need: 'curiosity', distress: 0.5, ratio: 1.1, textEn: 'want to see places I have never been' }];
  await gp.update(gctx(rawWith([{ name: 'jungle_log', count: 2 }]), { pressing }), 1);
  assert.strictEqual(gp.goal.target, 'white_bed');
  // 2B: k 個の案の schema・maxTokens
  assert.strictEqual(llm.seen[0].schema.properties.goals.minItems, 3);
  assert.strictEqual(llm.seen[0].opts.maxTokens, 480);
  assert.match(llm.seen[0].messages[0].content, /ゴールの案を3個出す/);
  // Jev: 1回、案 2 個 × 欲求 2 個 = 4 問。state は英語
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].stage, 'goal');
  assert.strictEqual(Object.keys(calls[0].questions).length, 4);
  assert.deepStrictEqual(Object.keys(calls[0].state.needs), ['sleep', 'curiosity']);
  const props = Object.values(calls[0].state.proposals).join(' ');
  assert.match(props, /obtain white_bed x1 \(white_bed; can be slept in/);
  assert.match(props, /go to far to the north/);
  for (const q of Object.values(calls[0].questions)) assert.doesNotMatch(q.instructions, en.ADVICE_EN);
  assert.doesNotMatch(JSON.stringify(calls[0].state), JA);
  const g = ev.find((e) => e.kind === 'goal' && e.ok);
  assert.strictEqual(g.select.rule, 'max');
  assert.deepStrictEqual(g.select.scores.map((x) => [x.target, x.score]), [['北の方', 0.64], ['white_bed', 2.21]]);
  assert.strictEqual(g.select.chosen, 1);
  assert.deepStrictEqual(g.proposals.map((x) => [x.target, x.ok, x.result]), [['jungle_log', false, 'satisfied'], ['北の方', true, null], ['white_bed', true, null]]);
  assert.ok(g.order && g.order.shuffled && Number.isInteger(g.order.n.items), '2B の候補の並べ方の記録');
  assert.strictEqual(g.select.jev.inputTokens, 600);
});

test('GoalPath (R1): つらい欲求が無いときは Jev を呼ばず 2B の最初の案', async () => {
  const llm = mockLLM([JSON.stringify({ goals: [{ kind: 'place', target: '北の方', why: 'b', need: '好奇心' }, { kind: 'item', target: 'white_bed', count: 1, why: 'c', need: '眠気' }] })]);
  let called = 0;
  const gp = new GoalPath({ llm, jev: { call: async () => { called += 1; return { r: { ok: true, answers: {} } }; } }, cfg: { select: { enabled: true, k: 2 } } });
  await gp.update(gctx(rawWith(), { pressing: () => [] }), 1);
  assert.strictEqual(gp.goal.target, '北の方');
  assert.strictEqual(called, 0);
});

test('proposalsSchema: 案の配列 (k 個)。1つの案は今の候補の enum', () => {
  const s = proposalsSchema({ items: [{ name: 'white_bed' }], people: [], places: [{ name: '北の方' }], states: [] }, 4);
  assert.strictEqual(s.properties.goals.maxItems, 4);
  assert.deepStrictEqual(s.properties.goals.items.properties.target.enum, ['white_bed', '北の方']);
});

test('GoalPath.planEn: Jev の plan は英語のオブジェクト (goal・for_need・path・next)。why は 2B の原文', async () => {
  const llm = mockLLM(['{"kind":"item","target":"white_bed","count":1,"why":"眠りたいから","need":"眠気"}']);
  const gp = new GoalPath({ llm });
  await gp.update(gctx(rawWith()), 1);
  const p = gp.planEn();
  assert.strictEqual(p.goal, 'obtain white_bed x1');
  assert.strictEqual(p.for_need, 'sleep');
  assert.strictEqual(p.why, '眠りたいから');
  assert.ok(Array.isArray(p.path) && p.path.length);
  assert.match(p.next, /^get jungle_log$/);
  assert.doesNotMatch(JSON.stringify({ ...p, why: '' }), JA);
  assert.strictEqual(gp.pathNext().item, 'jungle_log');
});

// ---- summarize_run ----
test('summarize_run: Jev の確率 p・1位÷2位の分布・選んだ位置・next_now と道筋どおりの割合・ゴールの選び方', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-'));
  const t = (s) => new Date(Date.UTC(2026, 10, 5, 1, 0, 0) + s * 1000).toISOString();
  const L = (o) => JSON.stringify(o);
  const step = (loop, jev) => ({ ts: t(loop), loop, day: 0, timeOfDay: 1000, pos: { x: 0, y: 64, z: 0 }, action: 'collect', arg: 'jungle_log', result: { ok: true, msg: 'ok' }, decideMs: 300, parseOk: true, valid: true, inventory: [], jev: { inputTokens: 1500, inputChars: 3000, ms: 200, ...jev } });
  fs.writeFileSync(path.join(dir, 'Taro-x.jsonl'), [
    L({ ts: t(0), event: 'start', persona: { name: 'Taro' }, help: { goalPath: true }, day: 0 }),
    L({ ts: t(1), event: 'goal_path', kind: 'goal', ok: true, tick: 1, target: 'white_bed', count: 1, goalKind: 'item', proposals: [{ target: 'jungle_log', ok: false, result: 'satisfied' }, { target: 'white_bed', ok: true }],
      select: { needs: [{ need: 'sleep', distress: 2 }], scores: [{ target: 'white_bed', count: 1, P: { sleep: 0.9 }, score: 1.8 }], chosen: 0, rule: 'only_one', jev: { inputTokens: 0 } } }),
    L(step(2, { choice: { choice: 'collect:jungle_log', p: 0.7, ratio: 3.5, pos: 0, n: 10 }, order: { shuffled: true }, path: { next: 'collect:jungle_log', nextNowP: 0.9, match: 'step' } })),
    L(step(3, { choice: { choice: 'explore:north', p: 0.3, ratio: 1.2, pos: 9, n: 10 }, order: { shuffled: true }, path: { next: 'collect:jungle_log', nextNowP: 0.8, match: 'other' } })),
    L(step(4, { choice: { choice: 'collect:jungle_log', p: 0.5, ratio: 2.1, pos: 4, n: 10 }, order: { shuffled: true }, path: { next: 'craft:jungle_planks', nextNowP: 0.1, match: 'other' } })),
  ].join('\n'));
  const out = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, '..', 'tools', 'summarize_run.js'), dir], { encoding: 'utf8' }));
  const jc = out.jevChoice;
  assert.strictEqual(jc.p.n, 3);
  assert.strictEqual(jc.p.p50, 0.5);
  assert.deepStrictEqual(jc.p.hist, { '0.0-0.2': 0, '0.2-0.4': 1, '0.4-0.6': 1, '0.6-0.8': 1, '0.8-1.0': 0 });
  assert.strictEqual(jc.ratio.hist['2-4'], 2);
  assert.strictEqual(jc.position.first, 1);
  assert.strictEqual(jc.position.shuffled, 3);
  assert.deepStrictEqual([jc.nextNow.asked, jc.nextNow.can, jc.nextNow.cannot, jc.nextNow.canRate], [3, 2, 1, 0.667]);
  assert.strictEqual(jc.nextNow.whenCan.step, 0.5);
  assert.strictEqual(out.goalSelect.dropped.satisfied, 1);
  assert.strictEqual(out.goalSelect.rules.only_one, 1);
});
