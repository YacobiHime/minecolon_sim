'use strict';
// 分業をメンタルモデルの側で生ませる (division.js): 慣れ・刺激・反応しきい値・ゴールの点・役回りの認識・分業の指標
const test = require('node:test');
const assert = require('node:assert');
const { Division, itemActivity, goalActivity, actionActivity, textActivities, response, dolIndex, gini, countsText, TRAIT_ACT, ACTIVITIES } = require('../src/division');
const { selectScores, GoalPath } = require('../src/goalpath');
const { personCandidates } = require('../src/vocab');
const { Reflect } = require('../src/reflect');
const { mockRaw } = require('./fixtures');
const knowledge = require('../src/knowledge');

const ADVICE = /(とよい|といい|べき|優先|ほうが|方が|おすすめ|勧め|まず|先に|良い|よい|大切|重要|should|better)/;
const ROLE_NAMES = /(農家|木こり|鉱夫|狩人|料理人|大工|職人|farmer|woodcutter|miner|hunter|cook\b|builder)/;

test('分類表: 物・ゴール・行動・発言 → 活動', () => {
  assert.strictEqual(itemActivity('wheat_seeds'), 'farming');
  assert.strictEqual(itemActivity('wooden_hoe'), 'farming');
  assert.strictEqual(itemActivity('bread'), 'cooking');
  assert.strictEqual(itemActivity('cooked_beef'), 'cooking');
  assert.strictEqual(itemActivity('oak_log'), 'wood');
  assert.strictEqual(itemActivity('jungle_planks'), 'wood');
  assert.strictEqual(itemActivity('cobblestone'), 'mining');
  assert.strictEqual(itemActivity('iron_ore'), 'mining');
  assert.strictEqual(itemActivity('mutton'), 'hunting');
  assert.strictEqual(itemActivity('white_wool'), 'hunting');
  assert.strictEqual(itemActivity('torch'), 'building');
  assert.strictEqual(itemActivity('oak_door'), 'building');
  assert.strictEqual(itemActivity('stone_pickaxe'), 'crafting');
  assert.strictEqual(itemActivity('crafting_table'), 'crafting');
  assert.strictEqual(itemActivity('dirt'), null);
  assert.strictEqual(goalActivity({ kind: 'person', target: 'Ken' }), 'social');
  assert.strictEqual(goalActivity({ kind: 'state', target: 'planted_wheat' }), 'farming');
  assert.strictEqual(goalActivity({ kind: 'state', target: 'lit_base' }), 'building');
  assert.strictEqual(goalActivity({ kind: 'state', target: 'chest_cobblestone' }), 'mining');
  assert.strictEqual(goalActivity({ kind: 'place', target: '北の方', place: { type: 'dir' } }), 'exploring');
  assert.strictEqual(goalActivity({ kind: 'place', target: 'M1', place: { type: 'memory', kind: 'oak_log' } }), 'wood');
  assert.strictEqual(goalActivity({ kind: 'place', target: '拠点', place: { type: 'base' } }), null);
  assert.strictEqual(actionActivity('use_on', 'farmland_spot'), 'farming');
  assert.strictEqual(actionActivity('collect', 'stone'), 'mining');
  assert.strictEqual(actionActivity('attack', 'sheep'), 'hunting');
  assert.strictEqual(actionActivity('craft', 'bread'), 'cooking');
  assert.strictEqual(actionActivity('craft', 'oak_planks'), 'crafting');
  assert.strictEqual(actionActivity('place', 'torch'), 'building');
  assert.strictEqual(actionActivity('ask', 'Ken'), 'social');
  assert.strictEqual(actionActivity('go_to', 'M1'), null);
  assert.strictEqual(actionActivity('eat', 'bread'), null);
  assert.deepStrictEqual(textActivities('誰か石が足りない?'), ['mining']);
  assert.ok(textActivities('食べ物がない').includes('farming') && textActivities('食べ物がない').includes('hunting'));
});

test('慣れ: 回数で言葉が変わる (日本語・英語)。やっていない活動は出さない。役割の名前・評価語を入れない', () => {
  const d = new Division({ me: 'Taro' });
  assert.strictEqual(d.famWords(), '');
  d.noteAction('collect', 'stone', false);
  assert.strictEqual(d.famWords(), '石掘りはまだ不慣れ');
  for (let i = 0; i < 10; i++) d.noteAction('use_on', 'farmland_spot', true);
  for (let i = 0; i < 4; i++) d.noteGoal({ kind: 'goal_done', goalKind: 'state', target: 'farmland', result: 'done' });
  d.noteGoal({ kind: 'reselect', goalKind: 'item', target: 'cobblestone', result: 'stuck' });
  assert.strictEqual(d.exp.farming.goalsOk, 4);
  assert.strictEqual(d.exp.mining.goals, 1);
  assert.strictEqual(d.exp.mining.goalsOk, 0);
  const w = d.famWords();
  assert.match(w, /畑のことは慣れている/);
  assert.match(w, /石掘りはまだ不慣れ/);
  assert.match(d.famWords({ lang: 'en' }), /used to farming/);
  assert.doesNotMatch(w, ADVICE); assert.doesNotMatch(w, ROLE_NAMES);
  assert.ok(d.famOf('farming') > 0.4 && d.famOf('farming') < 0.65);
  // 保存して戻せる
  const e = Division.fromJSON(JSON.parse(JSON.stringify(d.toJSON())), { me: 'Taro' });
  assert.strictEqual(e.famWords(), w);
});

test('しきい値: 性格の表で決まり (高いほど低い)、慣れるほど下がる。T = s²/(s²+θ²)', () => {
  assert.strictEqual(response(0, 0.5), 0);
  assert.strictEqual(response(0.5, 0.5), 0.5);
  assert.ok(response(1, 0.3) > 0.9);
  const brave = new Division({ temperament: { bravery: 0.95 } });
  const timid = new Division({ temperament: { bravery: 0.2 } });
  brave.update({ tick: 1 }); timid.update({ tick: 1 });
  assert.ok(brave.theta.hunting < timid.theta.hunting, `${brave.theta.hunting} < ${timid.theta.hunting}`);
  const kind = new Division({ temperament: { empathy: 0.9 } });
  kind.update({ tick: 1 });
  assert.ok(kind.theta.cooking < brave.theta.cooking);
  const cur = new Division({ drives: { curiosity: 0.9 } });
  cur.update({ tick: 1 });
  assert.ok(cur.theta.exploring < brave.theta.exploring + 0.2 && cur.theta.exploring < new Division().update({ tick: 1 }).theta.exploring);
  const before = kind.theta.farming;
  for (let i = 0; i < 6; i++) kind.noteGoal({ kind: 'goal_done', goalKind: 'item', target: 'wheat', result: 'done' });
  kind.update({ tick: 2 });
  assert.ok(kind.theta.farming < before);
  // 表の全部の活動に重みがある
  for (const a of ACTIVITIES) assert.ok(TRAIT_ACT[a] && Object.keys(TRAIT_ACT[a]).length, a);
});

test('刺激: 共有のチェスト・聞いた依頼・拠点・取り決めから。ほかの人がしているのを見聞きすると下がる。依頼は時間で薄れる', () => {
  const d = new Division({ me: 'Mai' });
  let s = d.update({ tick: 1 });
  assert.deepStrictEqual(s.s, {}); // 何も見聞きしていなければ刺激は無い
  d.noteHeard('Ken', '誰か石が足りないんだけど', 1);
  d.noteHeard('Mai', '石が欲しい', 1); // 自分の発言は数えない
  s = d.update({ tick: 1, chests: [{ id: 'Ken-1', items: [{ name: 'bread', count: 20 }], known: true }], shared: [{ item: 'torch', add: 8, note: '共同の目標 torch 8' }], base: { dark: true, enclosed: false } });
  assert.ok(s.s.mining > 0.9, JSON.stringify(s.s)); // 共有のチェストに石が無い + Ken の依頼
  assert.ok(!s.s.cooking && !s.s.farming); // 食べ物は足りている
  assert.ok(s.s.building > 0.9);
  const txt = d.stimulusText();
  assert.match(txt, /石や鉱石: 共有のチェスト Ken-1に石や鉱石が無い。Ken「誰か石が足りないんだけど」/);
  assert.match(txt, /自分の拠点が暗い/);
  assert.doesNotMatch(txt, ADVICE); assert.doesNotMatch(txt, ROLE_NAMES);
  assert.match(d.stimulusText({ lang: 'en' }), /Ken said「誰か石が足りないんだけど」/);
  const m0 = d.s.mining;
  // ほかの人が石を掘っているのを見た
  d.noteOthers([{ seq: 1, who: 'Jiro', kind: 'break', name: 'stone' }, { seq: 2, who: 'Goro', kind: 'pickup', name: 'cobblestone' }], 2);
  d.update({ tick: 2, chests: [{ id: 'Ken-1', items: [{ name: 'bread', count: 20 }], known: true }] });
  assert.ok(d.s.mining < m0 * 0.6, `${d.s.mining} < ${m0}`);
  assert.match(d.stimulusText(), /最近Jiro・Goroが石掘りをしているのを見聞きした/);
  // 依頼は半減期で薄れる
  const d2 = new Division({ me: 'Mai' });
  d2.noteHeard('Ken', '羊を見た?', 0);
  d2.update({ tick: 0 }); const h0 = d2.s.hunting;
  d2.update({ tick: 40 });
  assert.ok(d2.s.hunting < h0 / 3);
});

test('ほかの人の役回り: 見聞きした回数から「最近畑のことをよくしている」。人の候補の説明にも出る', () => {
  const d = new Division({ me: 'Taro' });
  d.noteOthers([1, 2, 3, 4].map((i) => ({ seq: i, who: 'Kaori', kind: i % 2 ? 'break' : 'pickup', name: 'wheat' })), 10);
  d.noteHeard('Kaori', '畑を耕してるよ', 11);
  assert.deepStrictEqual(d.rolesOf('Kaori').map((x) => x.act), ['farming']);
  assert.strictEqual(d.othersDoing('Kaori'), '最近畑のことをよくしている (見聞きした)');
  assert.match(d.othersDoing('Kaori', { lang: 'en' }), /often farming lately/);
  assert.strictEqual(d.othersDoing('Ken'), '');
  const c = personCandidates([{ name: 'Kaori', relation: '知り合い', seen: null, doing: d.othersDoing('Kaori'), doingEn: d.othersDoing('Kaori', { lang: 'en' }) }]);
  assert.match(c[0].desc, /最近畑のことをよくしている/);
  assert.match(c[0].descEn, /often farming/);
});

test('selectScores: 分業の T で点が上がり、つらさが無くても gamma × T で点が付く', () => {
  const needs = [{ need: 'hunger', distress: 1 }];
  const P = [{ hunger: 0.8 }, { hunger: 0.7 }];
  const a = selectScores(P, needs, {}, null);
  assert.strictEqual(a.index, 0);
  const b = selectScores(P, needs, {}, null, { T: [0, 0.8], beta: 0.5, gamma: 0.4 });
  assert.strictEqual(b.index, 1);
  assert.strictEqual(b.scores[1], Math.round((0.7 * 1.4 + 0.32) * 1000) / 1000);
  const c = selectScores([{}, {}], [], {}, null, { T: [0.1, 0.6], beta: 0.5, gamma: 0.4 });
  assert.strictEqual(c.index, 1);
});

// 2B が出す案 (固定) と Jev (どの案も同じ P) で、刺激だけを変えたときの選ばれ方
async function pick(division, pressing) {
  const goals = JSON.stringify({ goals: [
    { kind: 'item', target: 'mutton', count: 1, why: '食べる', need: '空腹' },
    { kind: 'item', target: 'jungle_log', count: 2, why: '木', need: '物が欲しい' },
    { kind: 'state', target: 'lit_base', count: 4, why: '明るく', need: '安心' },
  ] });
  const prompts = [];
  const llm = { complete: async (m) => { prompts.push(m); return { text: goals, promptTokens: 100, completionTokens: 50, finishReason: 'stop' }; } };
  const jev = { call: async (state, q) => ({ r: { ok: true, answers: Object.fromEntries(Object.keys(q).map((k) => [k, { noul: 0.6 }])) } }) };
  const ev = [];
  const gp = new GoalPath({ llm, jev, log: (e) => ev.push(e), cfg: { select: { enabled: true, k: 3, later: false, effort: { alpha: 0 } } } });
  const raw = mockRaw({ inventory: [{ name: 'wheat', count: 3 }, { name: 'torch', count: 1 }], blocks: [{ name: 'jungle_log', nearest: { x: 3, y: 64, z: 0, d: 3 } }], entities: [], heard: [] });
  await gp.update({ persona: { name: 'Taro' }, obsText: 'x', raw, facts: () => [], allFacts: knowledge.loadFacts(), memText: 'なし', people: [], places: [], placeKinds: [], needNow: () => 0.5,
    base: { x: 2, y: 64, z: 2 }, pressing: () => pressing, division: division.view(), shortage: division.stimulusText(), role: '畑の世話' }, 1);
  return { goal: ev.find((e) => e.kind === 'goal'), prompt: prompts[0] };
}

test('GoalPath: 同じ案・同じ P でも、刺激が違うと選ぶゴールが変わる。record に活動・T・分業なしの点・変わったか', async () => {
  const food = new Division({ me: 'Taro', temperament: { empathy: 0.8 } });
  food.noteHeard('Ken', '肉が欲しい、食べ物がない', 1);
  food.update({ tick: 1, chests: [{ id: 'Ken-1', items: [], known: true }] });
  const wood = new Division({ me: 'Taro', temperament: { greed: 0.8 } });
  wood.noteHeard('Ken', '誰か木材が足りないんだけど', 1);
  wood.update({ tick: 1, chests: [{ id: 'Ken-1', items: [{ name: 'bread', count: 30 }], known: true }] });
  const pressing = [{ need: 'hunger', distress: 0.5, ratio: 0.8, textEn: 'a little hungry' }, { need: 'greed', distress: 0.5, ratio: 0.8, textEn: 'few things' }, { need: 'safety', distress: 0.5, ratio: 0.8, textEn: 'uneasy' }];
  const a = await pick(food, pressing);
  const b = await pick(wood, pressing);
  assert.strictEqual(a.goal.target, 'mutton', JSON.stringify(a.goal.select.scores));
  assert.strictEqual(b.goal.target, 'jungle_log', JSON.stringify(b.goal.select.scores));
  assert.strictEqual(a.goal.activity, 'hunting');
  const s = b.goal.select;
  assert.match(s.formula, /\(1 \+ 0\.5 \* T\) \+ 0\.4 \* T/);
  assert.deepStrictEqual(s.division.acts, ['hunting', 'wood', 'building']);
  assert.ok(s.scores[1].T > 0.5 && s.scores[1].noDivision != null);
  // 2B に「みんなに足りていない物」と自分のよくしていることを渡す (評価語・役割の名前なし)
  const user = a.prompt[1].content;
  assert.match(user, /## みんなに足りていない物 \(自分が見聞きした範囲\)\n.*Ken「肉が欲しい、食べ物がない」/);
  assert.match(user, /## 自分が最近よくしていること \(振り返りで自分が書いたこと\)\n畑の世話/);
  const sec = user.split('## みんなに足りていない物')[1].split('\n## ')[0];
  assert.doesNotMatch(sec, ADVICE); assert.doesNotMatch(sec, ROLE_NAMES);
});

test('GoalPath: つらい欲求が無くても、刺激のある活動の案を選ぶ (rule division_only、Jev は呼ばない)', async () => {
  const d = new Division({ me: 'Taro' });
  d.noteHeard('Ken', '誰か木材が足りないんだけど', 1);
  d.update({ tick: 1 });
  const r = await pick(d, []);
  assert.strictEqual(r.goal.select.rule, 'division_only');
  assert.strictEqual(r.goal.target, 'jungle_log');
  assert.strictEqual(r.goal.select.division.changed, true);
});

test('振り返り: 自分の活動の回数を事実に足し、role (自分が最近よくしていること) を書かせて覚える', async () => {
  const d = new Division({ me: 'Taro' });
  const at = d.copyExp();
  for (let i = 0; i < 5; i++) d.noteAction('use_on', 'farmland_spot', true);
  d.noteGoal({ kind: 'goal_done', goalKind: 'state', target: 'farmland', result: 'done' });
  d.noteAction('collect', 'oak_log', true);
  const facts = countsText(d.countsSince(at));
  assert.strictEqual(facts, '最近やったこと: 畑のこと (行動5回・ゴール1個)・木を切ること (行動1回)');
  let msgs = null; let schema = null;
  const llm = { complete: async (m, sc) => { msgs = m; schema = sc; return { text: '{"policy":"畑を続ける","why":"食べるため","role":"畑の世話をよくしている"}' }; } };
  const r = new Reflect({ llm });
  await r.run({ persona: { name: 'Taro' }, activityFacts: facts }, 5, 'goals');
  assert.ok(schema.required.includes('role'));
  assert.match(msgs[1].content, /- 最近やったこと: 畑のこと/);
  assert.match(msgs[0].content, /role には、自分が最近よくしていることを自分の言葉で短く書く/);
  assert.doesNotMatch(msgs[0].content, ROLE_NAMES);
  assert.strictEqual(r.roleText(), '畑の世話をよくしている');
});

test('Jev の state: role と others_doing (英語) を入れ、説明の文を足す', () => {
  const { buildStateEn, buildQuestionsEn } = require('../src/deciders/jev');
  if (!buildStateEn) return; // 出していない版では見ない
  const ctx = { persona: { name: 'Taro' }, role: '畑の世話', policy: 'p', goalPath: true, en: { obs: {}, othersDoing: { Kaori: 'often farming lately (seen or heard)' } }, raw: { entities: [], heard: [] } };
  const st = buildStateEn(ctx, {});
  assert.strictEqual(st.role, '畑の世話');
  assert.deepStrictEqual(st.others_doing, { Kaori: 'often farming lately (seen or heard)' });
  const q = buildQuestionsEn(ctx, { criteria: {} }).questions.next_action.instructions;
  assert.match(q, /`role` is what `you` wrote/);
  assert.match(q, /`others_doing` is what `you` have seen or heard/);
});

test('分業の指標: 皆が同じなら DOL 0、人ごとに分かれていれば 1。Gini', () => {
  const same = dolIndex({ A: { farming: 5, wood: 5 }, B: { farming: 5, wood: 5 } });
  assert.strictEqual(same.dol, 0);
  const split = dolIndex({ A: { farming: 10 }, B: { wood: 10 } });
  assert.strictEqual(split.dol, 1);
  assert.strictEqual(split.perAgent.A.specialization, 1);
  assert.strictEqual(gini([1, 1, 1, 1]), 0);
  assert.ok(gini([0, 0, 0, 10]) > 0.7);
  assert.strictEqual(dolIndex({}).dol, null);
});

test('division_stats: 前の形の記録 (division の記録なし) にも分類表で当てる', () => {
  const { divisionStats } = require('../tools/division_stats');
  const t = (i) => new Date(Date.UTC(2026, 10, 6, 0, i)).toISOString();
  const all = [
    ...[1, 2, 3, 4].map((i) => ({ _name: 'A', ts: t(i), loop: i, action: 'use_on', arg: 'farmland_spot', result: { ok: true } })),
    ...[1, 2, 3, 4].map((i) => ({ _name: 'B', ts: t(i), loop: i, action: 'collect', arg: 'oak_log', result: { ok: true } })),
    { _name: 'A', ts: t(1), event: 'goal_path', kind: 'goal', goalKind: 'item', target: 'wheat' },
    { _name: 'B', ts: t(1), event: 'goal_path', kind: 'goal', goalKind: 'item', target: 'oak_log' },
    { _name: 'A', ts: t(4), event: 'reflect', role: '畑の世話' },
  ];
  const d = divisionStats(all, { bins: 2 });
  assert.strictEqual(d.acts.overall.dol, 1);
  assert.strictEqual(d.goals.overall.dol, 1);
  assert.deepStrictEqual(d.roles, ['A: 畑の世話']);
  assert.strictEqual(d.timeline.length, 2);
});
