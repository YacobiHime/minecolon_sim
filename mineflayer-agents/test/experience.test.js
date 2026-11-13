'use strict';
// 経験から確実さと効率を学ぶ (experience.js)・他人のための道具 (division.js の 6)・好感の上がり幅 (social.js)・persona (2026-11-07 ユーザー決定)
const test = require('node:test');
const assert = require('node:assert');
const { Experience, expKey, saidExperience } = require('../src/experience');
const { selectScores, GoalPath } = require('../src/goalpath');
const { Division, toolGain, toolMat } = require('../src/division');
const { OthersLog } = require('../src/others');
const { Social } = require('../src/social');
const { Reflect } = require('../src/reflect');
const { buildStateEn } = require('../src/deciders/jev');
const { mockRaw } = require('./fixtures');
const knowledge = require('../src/knowledge');

const ADVICE = /(とよい|といい|べき|優先|ほうが|方が|おすすめ|勧め|避け|やめ|まず|先に|良い|よい|大切|重要|should|better|avoid)/;

function fails(x, target, n, { kind = 'item', start = 0, ticks = 20, game = 2400 } = {}) {
  for (let i = 0; i < n; i++) x.noteResult({ kind, target, result: 'stuck', from: start + i * ticks, to: start + i * ticks + ticks, gameFrom: (start + i * ticks) * 120, gameTo: (start + i * ticks) * 120 + game, why: '15判断、道筋が縮まなかった' });
}

test('Experience: 試した回数・達成・時間を数え、ベータの事後で見込みを、判断の数で手間を直す', () => {
  const x = new Experience();
  assert.deepStrictEqual(x.success({ kind: 'item', target: 'salmon' }), { q: 0.8, factor: 1, n: 0 }); // 経験が無ければ今までと同じ
  fails(x, 'salmon', 3);
  const s = x.success({ kind: 'item', target: 'salmon', count: 2 }); // 数は見ない
  assert.strictEqual(s.n, 3);
  assert.strictEqual(s.q, 0.4); // (k0 m0 + 0) / (k0 + 3) = 2.4 / 6
  assert.strictEqual(s.factor, 0.5);
  // 手間: (kc 2 × 1.5 + 3 × 20判断 × 0.25) / (2 + 3) = 3.6
  assert.strictEqual(x.cost({ kind: 'item', target: 'salmon' }, 1.5), 3.6);
  assert.strictEqual(x.cost({ kind: 'item', target: 'bread' }, 1.5), 1.5); // 経験の無い物は planner のまま
  // 達成すると上がる (選べる行動が無くて失敗したのも、下手で失敗したのも、同じ1回)
  x.noteResult({ kind: 'item', target: 'bread', result: 'done', from: 0, to: 6, gameFrom: 0, gameTo: 3600 });
  x.noteResult({ kind: 'item', target: 'bread', result: 'need_unmet', from: 10, to: 16, gameFrom: 5000, gameTo: 8600 });
  assert.ok(x.success({ kind: 'item', target: 'bread' }).factor > 1);
  assert.strictEqual(x.items['item:salmon'].reasons.stuck, 3);
  // 待っている (waiting)・満たされている (satisfied) は試しに数えない
  assert.strictEqual(x.noteResult({ kind: 'item', target: 'wheat', result: 'satisfied' }), null);
  // 保存して戻す
  const back = Experience.fromJSON(JSON.parse(JSON.stringify(x.toJSON())));
  assert.deepStrictEqual(back.success({ kind: 'item', target: 'salmon' }), x.success({ kind: 'item', target: 'salmon' }));
  assert.strictEqual(expKey({ kind: 'person', target: 'Ken', give: 'bread' }), 'person:Ken');
});

test('Experience の言葉: 事実だけ (日本語・英語)。ゲーム内の分、無ければ判断の数。評価語なし', () => {
  const x = new Experience();
  fails(x, 'salmon', 3);
  x.noteResult({ kind: 'item', target: 'bread', result: 'done', from: 0, to: 6, gameFrom: 0, gameTo: 3600 });
  x.noteResult({ kind: 'item', target: 'bread', result: 'done', from: 100, to: 106, gameFrom: 9000, gameTo: 12600 });
  x.noteResult({ kind: 'place', target: '北の方', result: 'stuck', from: 200, to: 230 }); // 時刻なし
  const ja = x.lines();
  assert.ok(ja.includes('生の鮭は3回試して、手に入らなかった (計約6分)'), ja.join('\n'));
  assert.ok(ja.includes('パンは2回手に入れた (平均約3分)'), ja.join('\n'));
  assert.ok(ja.includes('北の方へ行くことは1回試して、着かなかった (計30判断)'), ja.join('\n'));
  const en = x.lines({ lang: 'en' });
  assert.ok(en.includes('salmon: tried 3 times, did not get it (about 6 min in total)'), en.join('\n'));
  assert.ok(en.includes('bread: got it 2 times (about 3 min on average)'), en.join('\n'));
  for (const l of [...ja, ...en]) assert.doesNotMatch(l, ADVICE);
  // 今のゴールを先に
  assert.match(x.lines({ lang: 'en', max: 1, first: ['item:salmon'] })[0], /^salmon/);
});

test('Experience: 聞いた経験は自分の経験より弱く、同じ人からは2回まで。問いの形は数えない', () => {
  assert.deepStrictEqual(saidExperience('鮭は全然取れないな'), [{ item: 'salmon', ok: false }]);
  assert.deepStrictEqual(saidExperience('パンが作れた！'), [{ item: 'bread', ok: true }]);
  assert.deepStrictEqual(saidExperience('鮭って取れない？'), []);
  assert.deepStrictEqual(saidExperience('こんにちは'), []);
  const x = new Experience();
  for (let i = 0; i < 4; i++) x.noteHeard('Ken', '鮭は取れないな', i, 'Aoi');
  x.noteHeard('Aoi', '鮭は取れない', 5, 'Aoi'); // 自分の発言は数えない
  const h = x.success({ kind: 'item', target: 'salmon' });
  assert.strictEqual(h.heard, 2);
  const own = new Experience(); fails(own, 'salmon', 2);
  assert.ok(h.factor < 1 && h.factor > own.success({ kind: 'item', target: 'salmon' }).factor, '聞いた2回は自分の2回より弱い');
  assert.strictEqual(x.lines()[0], '生の鮭はKenから手に入らなかったと聞いた');
  x.noteHeard('Mai', '鮭は取れなかった', 9, 'Aoi');
  assert.strictEqual(x.lines()[0], '生の鮭はMai・Kenから手に入らなかったと聞いた');
});

test('selectScores: 経験の比 (q ÷ m0) を分子に掛ける (分業の gamma × T の項にも)', () => {
  const P = [{ hunger: 0.9 }, { hunger: 0.6 }];
  const needs = [{ need: 'hunger', distress: 1 }];
  assert.strictEqual(selectScores(P, needs).index, 0);
  assert.strictEqual(selectScores(P, needs, {}, null, null, { factor: [0.4, 1] }).index, 1);
  const g = selectScores([{}, {}], [], {}, null, { T: [0.8, 0.5], beta: 0.5, gamma: 0.4 }, { factor: [0.4, 1] });
  assert.strictEqual(g.index, 1);
});

// 2B の案 (固定): 鮭 と パン。Jev は鮭の方が空腹に効くと答える
async function pickFood(experience, { jevP = { p1: 0.95, p2: 0.7 } } = {}) {
  const goals = JSON.stringify({ goals: [
    { kind: 'item', target: 'salmon', count: 1, why: '食べる', need: '空腹' },
    { kind: 'item', target: 'mutton', count: 1, why: '食べる', need: '空腹' },
  ] });
  const prompts = [];
  const llm = { complete: async (m) => { prompts.push(m); return { text: goals, promptTokens: 100, completionTokens: 50, finishReason: 'stop' }; } };
  const jev = { call: async (state, q) => ({ r: { ok: true, answers: Object.fromEntries(Object.keys(q).map((k) => [k, { noul: jevP[k.split('_')[0]] ?? 0.5 }])) } }) };
  const ev = [];
  const gp = new GoalPath({ llm, jev, experience, log: (e) => ev.push(e), cfg: { select: { enabled: true, k: 2, later: false } } });
  const raw = mockRaw({ inventory: [{ name: 'wheat', count: 3 }], blocks: [{ name: 'crafting_table', nearest: { x: 1, y: 64, z: 0, d: 1 } }], entities: [{ kind: 'mob', name: 'salmon', pos: { x: 4, y: 62, z: 0 }, d: 4 }, { kind: 'mob', name: 'sheep', pos: { x: 5, y: 64, z: 2 }, d: 5.4 }], heard: [] });
  raw.tableNearby = { x: 1, y: 64, z: 0 };
  raw.self.age = 24000;
  await gp.update({ persona: { name: 'Aoi' }, obsText: 'x', raw, facts: () => [], allFacts: knowledge.loadFacts(), memText: 'なし', people: [], places: [], placeKinds: [], needNow: () => 0.6,
    pressing: () => [{ need: 'hunger', distress: 0.7, ratio: 1.2, textEn: 'hungry' }] }, 1);
  return { goal: ev.find((e) => e.kind === 'goal'), prompt: prompts[0], gp };
}

test('GoalPath: 鮭を何回か失敗した経験があると、鮭のゴールが選ばれにくくなる。2B に経験の言葉', async () => {
  const none = await pickFood(new Experience());
  assert.strictEqual(none.goal.target, 'salmon', JSON.stringify(none.goal.select.scores));
  assert.strictEqual(none.goal.select.experience.changed, false);
  const x = new Experience(); fails(x, 'salmon', 3);
  const r = await pickFood(x);
  const s = r.goal.select;
  assert.strictEqual(r.goal.target, 'mutton', JSON.stringify(s.scores));
  assert.strictEqual(s.experience.changed, true);
  assert.match(s.decidedBy, /\+experience/);
  assert.match(s.formula, /\(q \/ 0\.8\)/);
  assert.ok(s.scores[0].expFactor <= 0.5 && s.scores[0].noExperience > s.scores[1].noExperience);
  assert.ok(s.scores[0].cost > s.scores[0].planCost, '手間も実際にかかった判断の数で大きくなる');
  const user = r.prompt[1].content;
  assert.match(user, /## やってみたこと \(自分の経験と、聞いたこと\)\n生の鮭は3回試して、手に入らなかった \(計約6分\)/);
  // 1回だけの失敗では、まだ鮭 (見込みの事前が効く)
  const one = new Experience(); fails(one, 'salmon', 1);
  assert.strictEqual((await pickFood(one)).goal.target, 'salmon');
});

test('GoalPath: ゴールが終わると経験に入る (判断の数とゲーム内の時間)', async () => {
  const x = new Experience();
  const { gp } = await pickFood(x);
  gp.lastAge = (gp.goal.gameAt ?? 0) + 3000;
  gp.finish('stuck', 20, '15判断、道筋が縮まなかった');
  const r = x.items['item:salmon'];
  assert.strictEqual(r.tries, 1); assert.strictEqual(r.ok, 0); assert.strictEqual(r.decisions, 19);
  assert.strictEqual(r.gameTicks, 3000);
});

test('振り返り・Jev の state に経験の言葉', async () => {
  const llm = { complete: async () => ({ text: JSON.stringify({ policy: 'p', why: 'w' }) }) };
  const rf = new Reflect({ llm });
  const recs = []; rf.log = (e) => recs.push(e);
  await rf.run({ persona: { name: 'Aoi' }, experienceFacts: ['生の鮭は3回試して、手に入らなかった (計約6分)'] }, 1, 'goals');
  assert.ok(recs[0].facts.includes('やってみたこと: 生の鮭は3回試して、手に入らなかった (計約6分)'), JSON.stringify(recs[0].facts));
  const st = buildStateEn({ persona: { name: 'Aoi' }, en: { experience: ['salmon: tried 3 times, did not get it (about 6 min in total)'] }, raw: { heard: [] } });
  assert.deepStrictEqual(st.experience, ['salmon: tried 3 times, did not get it (about 6 min in total)']);
});

test('道具の仕様: 素手 < 木 < 石。原木は斧の速さ、石は素手で取れない、耕すは耐久値だけ', () => {
  assert.strictEqual(toolMat(null, 'wood'), 'hand');
  assert.strictEqual(toolMat('wooden_axe', 'wood'), 'wooden');
  assert.strictEqual(toolMat('wooden_pickaxe', 'wood'), 'hand'); // 種類が違えば素手と同じ
  assert.strictEqual(toolGain('wood', 'hand'), 0.75);
  assert.strictEqual(toolGain('wood', 'wooden'), 0.5);
  assert.strictEqual(toolGain('wood', 'stone'), 0);
  assert.strictEqual(toolGain('wood', 'iron'), 0);
  assert.strictEqual(toolGain('mining', 'hand'), 1);
  assert.ok(Math.abs(toolGain('farming', 'wooden') - 0.3 * (1 - 59 / 131)) < 1e-9);
  assert.strictEqual(toolGain('farming', 'stone'), 0);
});

test('others.js: 壊した・耕したときの手の物 (tool) を残す。自分が近くにいる耕地は数えない', () => {
  const o = new OthersLog();
  o.noteBreakProgress({ who: 'Ken', pos: { x: 1, y: 64, z: 1 }, tool: null, t: 0 });
  o.noteBlockGone({ pos: { x: 1, y: 64, z: 1 }, oldName: 'oak_log', me: { x: 10, y: 64, z: 10 }, players: [], t: 100 });
  o.noteTill({ pos: { x: 5, y: 63, z: 5 }, oldName: 'grass_block', newName: 'farmland', me: { x: 15, y: 64, z: 15 }, players: [{ name: 'Mai', pos: { x: 5.5, y: 64, z: 6 }, held: 'wooden_hoe' }], t: 200 });
  assert.strictEqual(o.noteTill({ pos: { x: 5, y: 63, z: 6 }, oldName: 'dirt', newName: 'farmland', me: { x: 5, y: 64, z: 7 }, players: [{ name: 'Mai', pos: { x: 5.5, y: 64, z: 6 }, held: 'wooden_hoe' }], t: 300 }), null);
  assert.deepStrictEqual(o.events.map((e) => [e.who, e.kind, e.name, e.tool]), [['Ken', 'break', 'oak_log', null], ['Mai', 'till', 'farmland', 'wooden_hoe']]);
  assert.strictEqual(OthersLog.text(o.since(0)), 'Kenがoak_logを1個壊した。Maiが土を1マス耕した');
});

// 見て察する分は 2026-11-07 に既定 toolW 0.2 に弱めた (使う側の声を足したので)。仕組みの試験は前の 0.4 で
const TOOLW = { tools: { toolW: 0.4 } };
test('分業: ほかの人が素手・木の道具で木を切る・耕すのを見ると、石掘り・物を作ることの刺激が上がる。言葉は事実だけ', () => {
  const d = new Division({ me: 'Aoi', cfg: TOOLW });
  d.noteOthers([
    { seq: 1, who: 'Ken', kind: 'break', name: 'oak_log', tool: null },
    { seq: 2, who: 'Mai', kind: 'break', name: 'birch_log', tool: 'wooden_axe' },
    { seq: 3, who: 'Mai', kind: 'till', name: 'farmland', tool: 'wooden_hoe' },
    { seq: 4, who: 'Sota', kind: 'break', name: 'oak_log', tool: 'stone_axe' }, // 石の斧ならもう伸びない
    { seq: 5, who: 'Rin', kind: 'pickup', name: 'oak_log' }, // 手の物の分からない拾っただけは数えない
  ], 10);
  d.update({ tick: 12 });
  const base = new Division({ me: 'Aoi' }); base.update({ tick: 12 });
  assert.ok(d.s.mining > base.s.mining && d.s.crafting > base.s.crafting);
  assert.ok(d.T.crafting > 0.3);
  const tn = d.toolNeed(12);
  assert.deepStrictEqual(tn.people.map((x) => x.who).sort(), ['Ken', 'Mai', 'Sota']);
  assert.strictEqual(tn.people.find((x) => x.who === 'Sota').v, 0);
  const ja = d.stimulusText();
  assert.match(ja, /Ken・Maiが素手や木の道具で木を切り、畑を耕しているのを見た/);
  assert.doesNotMatch(ja, /Sota/);
  assert.doesNotMatch(ja, ADVICE); assert.doesNotMatch(ja, /石の(斧|ツルハシ|クワ|道具)を作/);
  assert.match(d.stimulusText({ lang: 'en' }), /saw Ken, Mai cutting wood and tilling farmland with bare hands or wooden tools/);
  // 時間で薄れる
  d.update({ tick: 400 });
  assert.ok(d.s.crafting < 0.05);
  // 保存して戻す
  const back = Division.fromJSON(JSON.parse(JSON.stringify(d.toJSON())), { me: 'Aoi' });
  assert.strictEqual(Object.keys(back.toolUse).length, 3);
});

test('分業: 発言の「素手で木を切ってる」「木のツルハシしかない」も (見たより弱く)', () => {
  const d = new Division({ me: 'Aoi', cfg: TOOLW });
  d.noteHeard('Ken', '素手で木を切ってるよ', 1);
  d.noteHeard('Mai', '木のツルハシしかないけど石を掘ってる', 1);
  assert.deepStrictEqual(d.toolUse.Ken.wood, { mat: 'hand', t: 1, how: 'said' });
  assert.deepStrictEqual(d.toolUse.Mai.mining, { mat: 'wooden', t: 1, how: 'said' });
  d.update({ tick: 2 });
  assert.match(d.stimulusText(), /Mai・Kenが素手や木の道具で木を切り、石を掘っているのを聞いた|Ken・Maiが素手や木の道具で木を切り、石を掘っているのを聞いた/);
});

// 2B の案: 石の斧 (物を作る)・丸石 (石掘り)・原木 (木)。Jev はどれも同じ P
async function pickTool(division) {
  const goals = JSON.stringify({ goals: [
    { kind: 'item', target: 'oak_log', count: 2, why: '木', need: '物が欲しい' },
    { kind: 'item', target: 'stone_axe', count: 1, why: '道具', need: '物が欲しい' },
    { kind: 'item', target: 'cobblestone', count: 3, why: '石', need: '物が欲しい' },
  ] });
  const llm = { complete: async () => ({ text: goals, promptTokens: 100, completionTokens: 50, finishReason: 'stop' }) };
  const jev = { call: async (state, q) => ({ r: { ok: true, answers: Object.fromEntries(Object.keys(q).map((k) => [k, { noul: 0.6 }])) } }) };
  const ev = [];
  const gp = new GoalPath({ llm, jev, log: (e) => ev.push(e), cfg: { select: { enabled: true, k: 3, later: false } } });
  const raw = mockRaw({ inventory: [{ name: 'oak_planks', count: 4 }, { name: 'stick', count: 2 }, { name: 'wooden_pickaxe', count: 1 }], blocks: [{ name: 'oak_log', nearest: { x: 3, y: 64, z: 0, d: 3 } }, { name: 'stone', nearest: { x: 4, y: 63, z: 0, d: 4 } }, { name: 'crafting_table', nearest: { x: 1, y: 64, z: 0, d: 1 } }], entities: [], heard: [] });
  raw.tableNearby = { x: 1, y: 64, z: 0 };
  await gp.update({ persona: { name: 'Aoi' }, obsText: 'x', raw, facts: () => [], allFacts: knowledge.loadFacts(), memText: 'なし', people: [], places: [], placeKinds: [], needNow: () => 0.5,
    pressing: () => [{ need: 'greed', distress: 0.5, ratio: 0.9, textEn: 'few things' }], division: division.view(), shortage: division.stimulusText() }, 1);
  return ev.find((e) => e.kind === 'goal');
}

test('GoalPath: 他人が素手で木を切るのを見た人では、石・石の道具のゴールの点が上がる', async () => {
  const none = new Division({ me: 'Aoi' }); none.update({ tick: 12 });
  const seen = new Division({ me: 'Aoi' });
  seen.noteOthers([{ seq: 1, who: 'Ken', kind: 'break', name: 'oak_log', tool: null }, { seq: 2, who: 'Mai', kind: 'break', name: 'oak_log', tool: 'wooden_axe' }], 10);
  seen.update({ tick: 12 });
  const a = await pickTool(none); const b = await pickTool(seen);
  const sc = (g, t) => g.select.scores.find((x) => x.target === t).score;
  assert.ok(sc(b, 'stone_axe') > sc(a, 'stone_axe'), JSON.stringify([a.select.scores, b.select.scores]));
  assert.ok(sc(b, 'cobblestone') > sc(a, 'cobblestone'));
  assert.strictEqual(sc(b, 'oak_log'), sc(a, 'oak_log'));
});

test('好感: 1回の幅は小さく (Score 1段 1.5)、端に近いほど動きにくい。下がる方向も同じ形', () => {
  const s = new Social();
  s.onRelationScore('Ken', 4);
  assert.strictEqual(s.rel('Ken').affinity, 53);
  for (let i = 0; i < 200; i++) s.onRelationScore('Ken', 4);
  assert.ok(s.rel('Ken').affinity < 100 && s.rel('Ken').affinity > 95);
  const before = s.rel('Ken').affinity;
  s.onRelationScore('Ken', 0); // 上の端の近くでも、下がる方向は残りの幅 (好感 − 0) が大きいので基の幅のまま
  assert.strictEqual(Math.round((before - s.rel('Ken').affinity) * 10) / 10, 3);
  for (let i = 0; i < 200; i++) s.onRelationScore('Mai', 0);
  assert.ok(s.rel('Mai').affinity > 0 && s.rel('Mai').affinity < 5);
  // 前の形にも戻せる
  const old = new Social({ affinity: { scoreStep: 6, roomScale: false } });
  old.onRelationScore('Ken', 4);
  assert.strictEqual(old.rel('Ken').affinity, 62);
  // 出来事も同じ形 (物をもらった +3)
  const t = new Social(); t.onReceived('Ken'); assert.strictEqual(t.rel('Ken').affinity, 53);
});

test('persona: 性格の文に職業・役割の語が無い (Taro の木こりを外した)', () => {
  const cfg = require('../configs/survival_3days.json');
  const ROLE = /(木こり|農家|狩人|猟師|鉱夫|職人|大工|料理人|商人|[^役]屋|係|woodcutter|farmer|hunter|miner|builder|cook\b|merchant)/;
  for (const p of cfg.personas) {
    assert.doesNotMatch(p.personality, ROLE, p.name);
    assert.doesNotMatch(p.personality_en || '', ROLE, p.name);
  }
  assert.strictEqual(cfg.personas[0].personality, 'まじめで少しのんびりしている。');
});
