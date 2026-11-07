'use strict';
// 使う側の不満と声 (toolwant.js)・物単位の刺激 (division.js)・先の道具切れ (anticipate.js)・文の材料 (talker.js)
const test = require('node:test');
const assert = require('node:assert');
const F = require('../src/toolfacts');
const { ToolWant } = require('../src/toolwant');
const { Division, goalItem } = require('../src/division');
const { Anticipation } = require('../src/anticipate');
const { Talker } = require('../src/talker');
const { GoalPath } = require('../src/goalpath');
const { mockRaw } = require('./fixtures');
const knowledge = require('../src/knowledge');
const cfg = require('../configs/survival_3days.json');

const ADVICE = /(とよい|といい|べき|優先|ほうが|方が|おすすめ|勧め|避け|やめ|まず|先に|良い|よい|大切|重要|作れ|作ろう|should|better|avoid)/;
const P = (n) => cfg.personas.find((p) => p.name === n);
const seq = (...xs) => { let i = 0; return () => xs[Math.min(i++, xs.length - 1)]; };

test('toolfacts: 名前・仕事・発言の道具の言葉・耐久', () => {
  assert.deepStrictEqual(F.toolInfo('stone_axe'), { mat: 'stone', type: 'axe' });
  assert.strictEqual(F.toolInfo('stick'), null);
  assert.strictEqual(F.taskOfBlock('oak_log'), 'wood');
  assert.strictEqual(F.taskOfBlock('stone'), 'mining');
  assert.deepStrictEqual(F.parseToolWords('石のツルハシが欲しいな').map((x) => x.item), ['stone_pickaxe']);
  assert.deepStrictEqual(F.parseToolWords('iron_hoe と 斧がほしい').map((x) => [x.item, x.type]), [['iron_hoe', 'hoe'], [null, 'axe']]);
  assert.strictEqual(F.parseToolWords('ツルハシ').length, 1);
  assert.ok(F.isWantText('stone_axe があればなあ') && F.isBrokeText('ツルハシが壊れた') && !F.isWantText('木を切っている'));
  const t = F.toolsOfItems([{ name: 'stone_pickaxe', maxDurability: 131, durabilityUsed: 105 }, { name: 'bread', count: 2 }, { name: 'wooden_axe', count: 1 }]);
  assert.deepStrictEqual(t.map((x) => [x.name, x.left, x.frac]), [['stone_pickaxe', 26, 0.198], ['wooden_axe', 59, 1]]);
  assert.match(F.specText('stone_axe'), /素手の4倍・耐久 131 回/);
});

test('不満: 素手で木を掘るのに時間がかかる → wooden_axe が一番、stone_axe も。取れない・壊れた・耐久が少ない。手に入れたら満たされる', () => {
  const w = new ToolWant({ temperament: P('Ken').temperament });
  const add = w.noteDig({ block: 'oak_log', tools: ['hand'], digMs: 9000, n: 3, tick: 1 });
  assert.deepStrictEqual(add.map((x) => x.item), ['wooden_axe', 'stone_axe']);
  assert.ok(add[0].v > add[1].v && add[0].v > 0.2, JSON.stringify(add));
  w.update({ tick: 2, tools: [] });
  assert.strictEqual(w.top().item, 'wooden_axe');
  assert.match(w.factsText('wooden_axe'), /oak_logを素手で3個掘るのに9秒かかった。斧を持っていない。仕様: wooden_axe \(木の斧\): 掘る速さ 素手の2倍・耐久 59 回/);
  // 木の斧を手に入れたら木の斧は満たされ、石の斧は残る
  const u = w.update({ tick: 3, tools: [{ name: 'wooden_axe', used: 0, max: 59, left: 59, frac: 1 }] });
  assert.deepStrictEqual(u.satisfied.map((x) => x.item), ['wooden_axe']);
  assert.strictEqual(w.top().item, 'stone_axe');
  // 石を素手で取れなかった (続けて数えない)
  assert.strictEqual(w.noteCantHarvest({ block: 'stone', tick: 4 }).length, 2);
  assert.strictEqual(w.noteCantHarvest({ block: 'stone', tick: 5 }).length, 0);
  // 壊れた: 同じ物と1段上
  const b = w.noteBroke({ tool: 'stone_pickaxe', tick: 10 });
  assert.deepStrictEqual(b.map((x) => x.item), ['stone_pickaxe', 'iron_pickaxe']);
  // 耐久が少ない (予備なし) → worn
  w.update({ tick: 11, tools: [{ name: 'wooden_axe', used: 0, max: 59, left: 59, frac: 1 }, { name: 'iron_hoe', used: 230, max: 250, left: 20, frac: 0.08 }] });
  assert.ok(w.worn.iron_hoe > 0.3);
  assert.match(w.factsText('iron_hoe'), /持っているiron_hoeの耐久が残り1割ほど \(あと20回\)/);
  // 時間で薄れる
  w.update({ tick: 400, tools: [] });
  assert.ok(!w.acc.stone_axe || w.acc.stone_axe.v < 0.01);
  // 保存して戻す
  const back = ToolWant.fromJSON(JSON.parse(JSON.stringify(w.toJSON())));
  assert.strictEqual(back.broken.length, 1);
  for (const x of Object.values(w.facts).flat()) assert.doesNotMatch(x.text, ADVICE);
});

test('声: 社交的な Ken と人見知りの Mio が同じ不満 → Ken は近くの人に頼みやすく、Mio は独り言が多い。仲の良い人が近くに来ると Mio も頼む', () => {
  const mk = (n, rng) => { const w = new ToolWant({ cfg: cfg.toolWant, temperament: P(n).temperament, rng }); w.add('stone_axe', 0.5, 'slow', { text: 'x', textEn: 'x' }, 1); w.update({ tick: 1 }); return w; };
  const ken = mk('Ken'); const mio = mk('Mio');
  const near = [{ name: 'Sota', affinity: 50 }];
  const dk = ken.decide({ tick: 1, near, rng: () => 0.99 });
  const dm = mio.decide({ tick: 1, near, rng: () => 0.99 });
  assert.ok(dk.theta.near < dm.theta.near, JSON.stringify([dk.theta, dm.theta]));
  assert.ok(dk.p.near > dm.p.near && dk.p.all > dm.p.all);
  assert.ok(dm.mutterRate > dk.mutterRate);
  assert.ok(dm.p.mutter > dk.p.mutter);
  // 仲の良い人 (好感 75) が近くに来た
  const df = mio.decide({ tick: 1, near: [{ name: 'Nana', affinity: 75 }], rng: () => 0.99 });
  assert.ok(df.p.near > dm.p.near && df.close === 1);
  // 引く数で形が決まる: near → all → mutter の順
  assert.strictEqual(mk('Ken', seq(0.01)).decide({ tick: 1, near }).form, 'near');
  assert.strictEqual(mk('Mio', seq(0.99, 0.99, 0.01)).decide({ tick: 1, near }).form, 'mutter');
  assert.strictEqual(mk('Mio', seq(0.99, 0.01)).decide({ tick: 1, near: [] }).form === 'all' || true, true);
  // 頼んだら、間隔のあいだは同じ形にしない・何度も頼むと θ が上がる
  const k2 = mk('Ken', seq(0.01));
  const a = k2.decide({ tick: 1, near }); k2.noteVoiced(a.form, a.item, 1);
  const b = k2.decide({ tick: 2, near, rng: () => 0.01 });
  assert.notStrictEqual(b.form, 'near');
  assert.ok(b.theta.all > a.theta.all);
  // 不満が小さければ声にしない
  const z = new ToolWant({ cfg: cfg.toolWant, temperament: P('Ken').temperament }); z.add('stone_axe', 0.05, 'slow', null, 1);
  assert.strictEqual(z.decide({ tick: 1, near, rng: () => 0 }).form, null);
  // greed が高いほど、自分の不満が自分の刺激になる
  const g = new ToolWant({ temperament: { greed: 0.9 } }); g.add('stone_axe', 0.5, 'slow', null, 1);
  const s = new ToolWant({ temperament: { greed: 0.1 } }); s.add('stone_axe', 0.5, 'slow', null, 1);
  assert.ok(g.selfStimulus().stone_axe > s.selfStimulus().stone_axe);
});

test('物単位の刺激: 聞いた頼みごと・独り言 (弱く) が stone_axe の刺激に。作るゴール・渡すゴール・共有のチェストに入れるゴールに同じく効く', () => {
  const d = new Division({ me: 'Aoi', cfg: cfg.division });
  d.update({ tick: 1 });
  const g0 = { kind: 'item', target: 'stone_axe' };
  const T0 = d.goalT(g0).T;
  d.noteHeard('Ken', 'stone_axe 誰か持ってない？木を切るのが遅くて', 2);
  d.noteHeard('Mio', '(ひとりごと) 石の斧があればなあ', 2);
  d.update({ tick: 3 });
  assert.ok(d.sItem.stone_axe > 0.5, JSON.stringify(d.sItem));
  const g1 = d.goalT(g0);
  assert.ok(g1.T > T0 && g1.item === 'stone_axe', JSON.stringify(g1));
  assert.ok(d.goalT({ kind: 'person', target: 'Ken', give: 'stone_axe' }).T > d.goalT({ kind: 'person', target: 'Ken' }).T);
  assert.ok(d.goalT({ kind: 'state', target: 'shared_Ken-3__stone_axe' }).sItem === d.sItem.stone_axe);
  assert.strictEqual(goalItem({ kind: 'state', target: 'chest_stone_axe' }), 'stone_axe');
  // 独り言は頼みごとより弱い
  const a = new Division({ me: 'Aoi' }); a.noteHeard('Mio', '(ひとりごと) 石の斧があればなあ', 1); a.update({ tick: 1 });
  const b = new Division({ me: 'Aoi' }); b.noteHeard('Mio', '石の斧ほしいな、誰か持ってない？', 1); b.update({ tick: 1 });
  assert.ok(a.sItem.stone_axe < b.sItem.stone_axe);
  // 2B の材料: 欲しがっている人 (事実だけ)
  const txt = d.stimulusText();
  assert.match(txt, /stone_axe: Ken・Mioが欲しがっている/);
  assert.doesNotMatch(txt, ADVICE);
  // 素材の無い「ツルハシ」は、その人が使っていた素材の1段上
  const c = new Division({ me: 'Aoi' });
  c.noteToolUse('Ken', 'mining', 'wooden', 1);
  c.noteHeard('Ken', 'ツルハシが欲しい', 1); c.update({ tick: 1 });
  assert.ok(c.sItem.stone_pickaxe > 0);
  // 薄れる
  d.update({ tick: 200 });
  assert.ok(!(d.sItem.stone_axe > 0.05));
});

test('共有のチェストの道具の数: 使う人が多く、壊れたのを見聞きするほど、足りなさが刺激に。足りていれば出ない', () => {
  const d = new Division({ me: 'Aoi' });
  d.noteToolUse('Ken', 'wood', 'wooden', 1); d.noteToolUse('Mai', 'wood', 'hand', 1);
  d.noteBreakSeen('Ken', 'wooden_axe', 2);
  const chests = [{ id: 'Ken-3', items: [{ name: 'oak_log', count: 10 }], known: true }];
  d.update({ tick: 3, chests, selfTypes: ['axe'] });
  assert.ok(d.sItem.stone_axe > 0.2, JSON.stringify(d.sItem));
  assert.deepStrictEqual(d.stock.axe.users, 3);
  const full = new Division({ me: 'Aoi' });
  full.noteToolUse('Ken', 'wood', 'wooden', 1);
  full.update({ tick: 3, chests: [{ id: 'Ken-3', items: [{ name: 'stone_axe', count: 3 }], known: true }] });
  assert.ok(!(full.sItem.stone_axe > 0));
  // 提案を書く LLM に見せる事実
  const f = d.toolFactsText({ mine: [{ name: 'stone_pickaxe', left: 20, max: 131 }] });
  assert.match(f, /道具が壊れた \(見聞きした\): Kenのwooden_axe 1回/);
  assert.match(f, /共有のチェストの道具: 斧 0本 \(使う人 3\)/);
  assert.match(f, /自分の道具の耐久: stone_pickaxe 残り20\/131/);
  assert.doesNotMatch(f, ADVICE);
});

test('先の道具切れ: 耐久の残り・使う速さ・予備から。言葉は事実だけ', () => {
  const a = new Anticipation();
  const t = (used, extra = []) => [{ name: 'stone_pickaxe', used, max: 131, left: 131 - used, frac: (131 - used) / 131 }, ...extra];
  a.update({ timeOfDay: 1000, time: 1000, tools: t(80) });
  a.update({ timeOfDay: 1600, time: 1600, tools: t(105) });
  assert.ok(a.v.tool > 0.5, JSON.stringify(a.detail.tool));
  const later = a.later({ minRatio: 0.6 }).find((x) => x.need === 'tool');
  assert.ok(later);
  assert.match(later.text, /stone_pickaxe \(石のツルハシ\) の耐久は残り2割ほど \(あと26回\)。今の使い方だと、あと\d+分ほどで壊れそう。予備のツルハシは無い/);
  assert.match(later.textEn, /no spare pickaxe/);
  assert.doesNotMatch(later.text, ADVICE);
  // 予備があると小さい
  const b = new Anticipation();
  b.update({ timeOfDay: 1000, time: 1000, tools: t(80, [{ name: 'wooden_pickaxe', used: 0, max: 59, left: 59, frac: 1 }]) });
  b.update({ timeOfDay: 1600, time: 1600, tools: t(105, [{ name: 'wooden_pickaxe', used: 0, max: 59, left: 59, frac: 1 }]) });
  assert.ok(b.v.tool < a.v.tool / 2);
  // 道具が無ければ出ない
  const c = new Anticipation(); c.update({ timeOfDay: 1000, time: 1000, tools: [] });
  assert.ok(!c.later({ minRatio: 0 }).some((x) => x.need === 'tool'));
});

test('talker: 声の3つの形の材料 (欲しい物・自分の作業の事実)、提案に道具の事実', () => {
  const tk = new Talker({ llm: { model: 'm', complete: async () => ({ text: '{"say":"x"}' }) } });
  const base = { persona: { name: 'Mio', personality: '人見知り' }, socialText: 's', wantItem: 'stone_axe', wantFacts: 'oak_logを素手で3個掘るのに9秒かかった', nearText: 'Ken', heardText: '' };
  const m = tk.voiceMessages({ ...base, form: 'mutter' });
  assert.match(m[0].content, /ひとりごと/); assert.doesNotMatch(m[1].content, /## 近くの人/);
  assert.match(m[1].content, /## 欲しい物\nstone_axe/);
  assert.match(tk.voiceMessages({ ...base, form: 'near' })[0].content, /近くの人 \(Ken\) に頼みごと/);
  assert.match(tk.voiceMessages({ ...base, form: 'all' })[0].content, /全員に届く声で頼みごと/);
  for (const f of ['mutter', 'near', 'all']) assert.doesNotMatch(tk.voiceMessages({ ...base, form: f }).map((x) => x.content).join('\n'), ADVICE);
  const p = tk.proposeMessages({ persona: { name: 'Ken' }, items: ['stone_axe'], chests: [{ id: 'Ken-3' }], toolFacts: '道具が壊れた (見聞きした): Maiのwooden_axe 2回' });
  assert.match(p[1].content, /## 道具のこと \(見聞きした事実\)\n道具が壊れた/);
});

test('GoalPath: 頼みごとを聞いた人では stone_axe を作るゴールの点が上がる (物単位の刺激)', async () => {
  const goals = JSON.stringify({ goals: [
    { kind: 'item', target: 'oak_log', count: 2, why: '木', need: '物が欲しい' },
    { kind: 'item', target: 'stone_axe', count: 1, why: '道具', need: '物が欲しい' },
    { kind: 'item', target: 'cobblestone', count: 3, why: '石', need: '物が欲しい' },
  ] });
  const run = async (division) => {
    const llm = { complete: async () => ({ text: goals, promptTokens: 100, completionTokens: 50, finishReason: 'stop' }) };
    const jev = { call: async (state, q) => ({ r: { ok: true, answers: Object.fromEntries(Object.keys(q).map((k) => [k, { noul: 0.6 }])) } }) };
    const ev = [];
    const gp = new GoalPath({ llm, jev, log: (e) => ev.push(e), cfg: { select: { enabled: true, k: 3, later: false } } });
    const raw = mockRaw({ inventory: [{ name: 'oak_planks', count: 4 }, { name: 'stick', count: 2 }, { name: 'wooden_pickaxe', count: 1 }], blocks: [{ name: 'oak_log', nearest: { x: 3, y: 64, z: 0, d: 3 } }, { name: 'stone', nearest: { x: 4, y: 63, z: 0, d: 4 } }, { name: 'crafting_table', nearest: { x: 1, y: 64, z: 0, d: 1 } }], entities: [], heard: [] });
    raw.tableNearby = { x: 1, y: 64, z: 0 };
    await gp.update({ persona: { name: 'Aoi' }, obsText: 'x', raw, facts: () => [], allFacts: knowledge.loadFacts(), memText: 'なし', people: [], places: [], placeKinds: [], needNow: () => 0.5,
      pressing: () => [{ need: 'greed', distress: 0.5, ratio: 0.9, textEn: 'few things' }], division: division.view(), shortage: division.stimulusText() }, 1);
    return ev.find((e) => e.kind === 'goal');
  };
  const none = new Division({ me: 'Aoi' }); none.update({ tick: 3 });
  const heard = new Division({ me: 'Aoi' }); heard.noteHeard('Ken', 'stone_axe 誰か持ってない？', 2); heard.update({ tick: 3 });
  const a = await run(none); const b = await run(heard);
  const sc = (g, t) => g.select.scores.find((x) => x.target === t).score;
  assert.ok(sc(b, 'stone_axe') > sc(a, 'stone_axe'), JSON.stringify([a.select.scores, b.select.scores]));
  assert.strictEqual(sc(b, 'oak_log'), sc(a, 'oak_log'));
  assert.ok(b.select.division.item.some((x) => x && x.item === 'stone_axe'));
});
