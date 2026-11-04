'use strict';
// 道筋つきの候補 (vocab.js)・状態のゴール (states.js)・振り返りと方針 (reflect.js)・lure / enclose (act_pen.js)・知識の選び方 (knowledge.js)
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { Vec3 } = require('vec3');
const { itemCandidates, dir8 } = require('../src/vocab');
const states = require('../src/states');
const { GoalPath } = require('../src/goalpath');
const { Reflect } = require('../src/reflect');
const { lureChoices, encloseChoices, moreActions } = require('../src/actions_more');
const { penHandlers, ringCells } = require('../src/act_pen');
const { handlers } = require('../src/act');
const { effortWord, Planner } = require('../src/planner');
const knowledge = require('../src/knowledge');
const { loadConfig } = require('../src/config');
const { buildContext } = require('../src/agent');
const { Memory } = require('../src/memory');
const { buildState } = require('../src/deciders/jev');
const { mockRaw } = require('./fixtures');

const CFG = path.join(__dirname, '..', 'configs', 'survival_3days.json');
const ADVICE = /(とよい|といい|べき|優先|ほうが|方が|おすすめ|勧め|まず|先に|良い|よい|大切|重要|しよう|しなさい)/;
const blk = (name, x, z, y = 64) => ({ name, notable: false, diggable: true, seen: 1, nearest: { x, y, z, d: Math.hypot(x, z) }, positions: [] });

// ---- 1. 道筋をたどってから候補に添える ----

test('vocab: 物の候補に、仕様の事実と道筋の事実 (入手元が見えるか・要る物・手間 小/中/大) を添える', () => {
  const raw = { self: { pos: { x: 0, y: 64, z: 0 } }, inventory: [{ name: 'jungle_log', count: 2 }],
    blocks: [blk('jungle_log', 8, -6), blk('oak_leaves', -7, 3), blk('grass', 2, 1), blk('stone', 10, 4)], entities: [{ kind: 'mob', name: 'cow', pos: { x: 12, y: 64, z: 1 }, d: 12 }] };
  const c = itemCandidates({ raw, facts: knowledge.loadFacts(), maxItems: 40 });
  const d = (n) => (c.find((x) => x.name === n) || {}).desc || '';
  assert.match(d('cooked_beef'), /^ステーキ・食べ物 \(満腹度\+8\)。cow が東に見える。.*furnace が要る.*。手間: 中$/);
  assert.match(d('apple'), /食べ物 \(満腹度\+4\)。oak_leaves からまれに落ちる \(oak_leaves は南西に見える\)。手間: 大$/);
  assert.match(d('white_bed'), /寝られる。sheep はまだ見ていない/);
  assert.match(d('wheat_seeds'), /grass からときどき落ちる/);
  assert.match(d('torch'), /明かり \(明るさ14\)/);
  assert.match(d('jungle_log'), /持っている2$/); // 持っている物には道筋を添えない
  for (const x of c) assert.doesNotMatch(x.desc, ADVICE, x.desc);
  // 欲求 → 物の対応は書かない
  for (const x of c) assert.doesNotMatch(x.desc, /空腹|眠気|不安/, x.desc);
  // annotate: false なら前と同じ短い説明
  const plain = itemCandidates({ raw, facts: [], maxItems: 10, annotate: false });
  assert.ok(plain.every((x) => !/手間/.test(x.desc)));
});

test('vocab: 方角は 8 方位の言葉、手間は 小/中/大 の言葉 (数値は出さない)', () => {
  assert.strictEqual(dir8({ x: 0, z: 0 }, { x: 10, z: 0 }), '東');
  assert.strictEqual(dir8({ x: 0, z: 0 }, { x: 0, z: -10 }), '北');
  assert.strictEqual(dir8({ x: 0, z: 0 }, { x: -7, z: 7 }), '南西');
  assert.strictEqual(dir8({ x: 0, z: 0 }, { x: 1, z: 1 }), 'すぐそば');
  assert.deepStrictEqual([effortWord(1), effortWord(10), effortWord(50), effortWord(0), effortWord(Infinity)], ['小', '中', '大', 'なし', null]);
});

test('planner: planMany は持ち物を分け合って、いくつかの物をまとめてたどる。explain は主な入手元・要る作業台/かまど/道具', () => {
  const p = new Planner({ inventory: [{ name: 'oak_planks', count: 4 }], visibleBlocks: ['oak_log'] });
  const r = p.planMany([{ item: 'oak_fence', count: 3 }, { item: 'oak_fence_gate', count: 1 }]);
  assert.ok(r.ok);
  assert.ok(r.steps.some((s) => s.item === 'oak_fence' && s.count === 3));
  const ex = new Planner({ visibleBlocks: ['oak_log', 'stone'], visibleMobs: ['cow'] }).explain('cooked_beef');
  assert.strictEqual(ex.main.from, 'cow');
  assert.ok(ex.stations.includes('furnace'));
});

// ---- 3. 状態のゴール ----

// 模擬の世界: Map "x,y,z" → name。y=63 は草の土 (x, z は -12〜12)
function world(extra = {}) {
  const m = new Map();
  for (let x = -12; x <= 12; x++) for (let z = -12; z <= 12; z++) m.set(`${x},63,${z}`, 'grass_block');
  for (const [k, v] of Object.entries(extra)) m.set(k, v);
  const blockAt = (x, y, z) => {
    if (Math.abs(x) > 12 || Math.abs(z) > 12 || y < 60) return null;
    const n = m.get(`${x},${y},${z}`) || 'air';
    return { name: n, boundingBox: n === 'air' || /_fence$|_fence_gate$/.test(n) ? (n === 'air' ? 'empty' : 'block') : 'block' };
  };
  return { m, blockAt };
}
function ring(m, size, name = 'oak_fence', y = 64, cx = 0, cz = 0) {
  for (const c of ringCells({ x: cx, y, z: cz }, size)) m.set(`${c.x},${y},${c.z}`, name);
}

test('states.enclosedArea: 柵の1周の中は囲われている。すき間・1段のブロックは越えられる、2段は越えられない', () => {
  const w = world(); ring(w.m, 5);
  const r = states.enclosedArea(w.blockAt, { x: 0, y: 64, z: 0 });
  assert.ok(r.enclosed); assert.strictEqual(r.cells, 25);
  w.m.set('0,64,3', 'air'); // 門の所が空いている
  assert.ok(!states.enclosedArea(w.blockAt, { x: 0, y: 64, z: 0 }).enclosed);
  w.m.set('0,64,3', 'oak_fence_gate');
  assert.ok(states.enclosedArea(w.blockAt, { x: 0, y: 64, z: 0 }).enclosed);
  const w2 = world(); ring(w2.m, 3, 'cobblestone');
  assert.ok(!states.enclosedArea(w2.blockAt, { x: 0, y: 64, z: 0 }).enclosed, '1段は跳び越えられる');
  ring(w2.m, 3, 'cobblestone', 65);
  assert.ok(states.enclosedArea(w2.blockAt, { x: 0, y: 64, z: 0 }).enclosed, '2段は越えられない');
});

test('states.senseState: 囲いの中の動物・湿った耕地・明かり・チェストの中身を数える', () => {
  const w = world({ '5,63,5': 'water', '6,63,5': 'farmland', '7,63,5': 'farmland', '-10,63,-10': 'farmland', '1,64,1': 'torch', '-1,65,0': 'wall_torch' });
  ring(w.m, 5);
  const ents = [{ kind: 'mob', name: 'cow', pos: { x: 0.5, y: 64, z: 1.5 } }, { kind: 'mob', name: 'cow', pos: { x: 8.5, y: 64, z: 8.5 } }];
  const sense = { blockAt: w.blockAt, here: { x: 2, y: 64, z: 2 }, anchor: { x: 0, y: 64, z: 0 }, entities: ents, containers: { '1,64,-1': { name: 'chest', items: [{ name: 'wheat', count: 5 }] } } };
  const pen = states.senseState({ type: 'pen', animal: 'cow' }, sense);
  assert.deepStrictEqual([pen.have, pen.seen, pen.known], [1, 2, true]);
  assert.strictEqual(states.senseState({ type: 'farmland' }, sense).have, 2); // 水から4以内の2マスだけ
  assert.strictEqual(states.senseState({ type: 'lit' }, sense).have, 2);
  assert.strictEqual(states.senseState({ type: 'walled' }, sense).have, 1);
  assert.strictEqual(states.senseState({ type: 'chest', item: 'wheat' }, sense).have, 5);
  // 拠点が無い・遠いときは確かめられない
  assert.ok(states.senseState({ type: 'pen', animal: 'cow' }, { ...sense, anchor: null }).noBase);
  assert.strictEqual(states.senseState({ type: 'lit' }, { ...sense, here: { x: 100, y: 64, z: 0 } }).known, false);
});

test('states.planState: 仕様だけで道筋 (柵 ← 板材・棒、囲う、餌を持って連れてくる、増やす、耕す、置く、入れる)', () => {
  const w = { inventory: [{ name: 'oak_planks', count: 4 }], visibleBlocks: ['oak_log', 'grass', 'water'], visibleMobs: ['cow'] };
  const p = states.planState({ type: 'pen', animal: 'cow' }, 4, w, { have: 0 });
  assert.ok(p.ok);
  const acts = p.acts.map((a) => a.how);
  assert.deepStrictEqual(acts, ['enclose', 'lure', 'breed']);
  assert.strictEqual(p.acts[0].count, 24); // 5x5 の1周 = 4×5+4
  assert.ok(p.items.steps.some((s) => s.item === 'oak_fence' && s.count === 23));
  assert.ok(p.items.steps.some((s) => s.item === 'wheat' && s.count === 5)); // 連れてくる 1 + 増やす 2頭×2
  assert.strictEqual(p.effortWord, '大');
  // 囲いがもうあり、中に2頭いれば、残りは増やすだけ
  const p2 = states.planState({ type: 'pen', animal: 'cow' }, 3, w, { have: 2, penCells: 25 });
  assert.deepStrictEqual(p2.acts.map((a) => a.how), ['breed']);
  // 済んでいれば道筋は空
  assert.ok(states.planState({ type: 'pen', animal: 'cow' }, 2, w, { have: 2, penCells: 25 }).done);
  const f = states.planState({ type: 'farmland' }, 8, w, { have: 3 });
  assert.deepStrictEqual(f.acts.map((a) => states.actText(a)), ['耕す 5 (wooden_hoe を水の近くの土に)']);
  assert.match(states.actText(states.planState({ type: 'lit' }, 4, w, { have: 0 }).acts[0]), /torch 4 を置く/);
  assert.deepStrictEqual(states.planState({ type: 'chest', item: 'wheat' }, 8, w, { have: 0 }).acts.map((a) => a.how), ['place', 'chest_put']);
  for (const a of p.acts) assert.doesNotMatch(states.actText(a), ADVICE);
});

test('states.stateCandidates: 型と対象・今の数・要る物・手間の言葉 (評価語なし)', () => {
  const w = { inventory: [{ name: 'oak_planks', count: 4 }, { name: 'wheat', count: 3 }, { name: 'wooden_axe', count: 1 }], visibleBlocks: ['oak_log', 'water', 'grass'], visibleMobs: ['cow'] };
  const raw = { inventory: w.inventory, entities: [{ kind: 'mob', name: 'cow', pos: { x: 10, y: 64, z: 0 } }] };
  const c = states.stateCandidates({ world: w, raw, sense: { blockAt: world().blockAt, here: { x: 0, y: 64, z: 0 }, anchor: { x: 0, y: 64, z: 0 } }, dir: () => '東' });
  const names = c.map((x) => x.name);
  for (const n of ['pen_cow', 'pen_sheep', 'pen_pig', 'pen_chicken', 'farmland', 'lit_base', 'walled_base', 'chest_oak_planks', 'chest_wheat']) assert.ok(names.includes(n), n);
  assert.ok(!names.includes('chest_wooden_axe'));
  const pen = c.find((x) => x.name === 'pen_cow').desc;
  assert.match(pen, /^状態: 拠点の近くの囲いの中に cow が2頭いる。今0頭。cow が東に見える。要る物: oak_fence 23・oak_fence_gate 1・wheat 1。手間: 大$/);
  assert.match(c.find((x) => x.name === 'pen_chicken').desc, /wheat_seeds/); // 餌は仕様の一覧の順 (手間が大きく違わなければ)
  for (const x of c) assert.doesNotMatch(x.desc, ADVICE, x.desc);
});

function mockLLM(outputs) {
  const seen = [];
  return { seen, complete: async (messages, schema) => { seen.push({ messages, schema }); return { text: outputs.shift(), promptTokens: 1500, completionTokens: 30 }; } };
}

test('GoalPath: 状態のゴール (pen_cow) を候補から選び、道筋 (物 → 囲う → 連れてくる) を出し、囲いの中に2頭いれば済む。worst と need の一致を数える', async () => {
  const llm = mockLLM(['{"kind":"state","target":"pen_cow","count":2,"why":"いつでも肉が手に入るように","need":"空腹"}']);
  const ev = [];
  const gp = new GoalPath({ llm, log: (e) => ev.push(e) });
  const w = world();
  let ents = [{ kind: 'mob', name: 'cow', pos: { x: 8, y: 64, z: 0 }, d: 8 }];
  const raw = () => mockRaw({ inventory: [{ name: 'oak_planks', count: 8 }, { name: 'wheat', count: 2 }], blocks: [blk('oak_log', 3, 0)], entities: ents, heard: [] });
  let need = 0.8;
  const ctx = () => ({ persona: { name: 'Taro', personality: 'まじめ' }, obsText: 'x', raw: raw(), facts: () => [], allFacts: [], memText: 'なし', socialText: 'お腹が空いた',
    worst: { need: 'hunger', text: 'お腹が空いた' }, people: [], places: [], placeKinds: [], base: { x: 0, y: 64, z: 0 }, blockAt: w.blockAt, needNow: () => need, policy: '肉をいつでも食べられるようにする' });
  assert.strictEqual(await gp.update(ctx(), 1), 'goal');
  const user = llm.seen[0].messages[1].content;
  assert.match(user, /## めざせる状態\npen_cow: 状態: 拠点の近くの囲いの中に cow が2頭いる/);
  assert.match(user, /## 自分の方針 \(前に自分で決めたこと\)\n肉をいつでも食べられるようにする/);
  assert.match(user, /\nbeef: 生の牛肉・食べ物 \(満腹度\+3\)。cow が東に見える。手間: 小\n/);
  assert.ok(llm.seen[0].schema.properties.kind.enum.includes('state'));
  assert.ok(llm.seen[0].schema.properties.target.enum.includes('pen_cow'));
  assert.strictEqual(gp.goal.kind, 'state');
  assert.match(gp.planText(), /^ゴール: 拠点の近くの囲いの中に cow が2頭いる \(いつでも肉が手に入るように\) \/ 今0 \/ 道筋: .*囲う \(内側5x5・oak_fence・門 oak_fence_gate\)、cow 2 を連れてくる \(wheat を持って\) \/ 次: /);
  const g = ev.find((e) => e.kind === 'goal');
  assert.strictEqual(g.needMatchesWorst, true);
  assert.deepStrictEqual([gp.counts.worstJudged, gp.counts.worstMatched], [1, 1]);
  assert.ok(g.path.steps.some((s) => s.act === 'enclose'));
  // 囲いを作って2頭が中にいる → そうなった → 空腹が下がって達成
  ring(w.m, 5);
  ents = [{ kind: 'mob', name: 'cow', pos: { x: 0.5, y: 64, z: 0.5 }, d: 1 }, { kind: 'mob', name: 'cow', pos: { x: 1.5, y: 64, z: -1.5 }, d: 2 }];
  assert.strictEqual(await gp.update(ctx(), 2), null);
  assert.ok(ev.some((e) => e.kind === 'reached'));
  assert.match(gp.planText(), /そうなった$/);
  need = 0.2;
  llm.seen.length = 0;
  await gp.update({ ...ctx(), worst: { need: 'sleep', text: '眠い' } }, 3);
  assert.ok(ev.some((e) => e.kind === 'goal_done'));
});

// ---- 2. 振り返りと方針 ----

test('Reflect: 1日の終わり・寝る前・死んだあと・ゴールをいくつか終えたあとに振り返る (minGap あける)', () => {
  const r = new Reflect({ llm: mockLLM([]), cfg: { minGap: 5, afterGoals: 2 } });
  assert.strictEqual(r.due({ tick: 1, timeOfDay: 11000, day: 0 }), null);
  assert.strictEqual(r.due({ tick: 20, timeOfDay: 11900, day: 0 }), null);
  assert.strictEqual(r.due({ tick: 21, timeOfDay: 12100, day: 0 }), 'day_end');
  assert.strictEqual(r.due({ tick: 22, timeOfDay: 13000, day: 0, canSleep: true }), 'before_sleep');
  assert.strictEqual(r.due({ tick: 23, timeOfDay: 13100, day: 0, canSleep: true }), null, '同じ夜は1回');
  r.noteEvent({ kind: 'death', tick: 23, timeOfDay: 15000, cause: 'death.attack.zombie' });
  assert.strictEqual(r.due({ tick: 24, timeOfDay: 15000, day: 0 }), 'death');
  r.lastAt.tick = 24; r.pending = null;
  assert.strictEqual(r.due({ tick: 26, timeOfDay: 15000, day: 0 }), null, 'minGap');
  r.noteGoal({ kind: 'goal_done', tick: 30, target: 'beef', goalKind: 'item', result: 'done', from: 20, to: 30 });
  r.noteGoal({ kind: 'reselect', tick: 31, target: 'apple', goalKind: 'item', result: 'stuck', from: 30, to: 31 });
  assert.strictEqual(r.due({ tick: 32, timeOfDay: 16000, day: 0 }), 'goals');
});

test('Reflect: 材料は記録から数えた事実 (時間・歩いた距離・死んだ・食べた・寝た・ゴールの結果・人とのこと)。2B の方針を event にし、ゴール選び・Jev に出す', async () => {
  const llm = mockLLM(['{"policy":"昼のうちに食べ物を集めて、夜は拠点で寝る","why":"夜に死なないため"}']);
  const ev = [];
  const r = new Reflect({ llm, log: (e) => ev.push(e) });
  let x = 0;
  for (let i = 0; i < 10; i++) {
    r.note({ tick: i + 1, day: 0, timeOfDay: 2000 + i * 600, pos: { x, y: 64, z: 0 }, action: i === 3 ? 'eat' : i === 4 ? 'sleep' : 'collect', arg: i === 3 ? 'beef' : 'oak_log', ok: i !== 5, goal: 'beef', need: 'hunger', near: i < 6 ? ['Ken'] : [] });
    x += 25;
  }
  r.noteEvent({ kind: 'death', tick: 8, timeOfDay: 15000, cause: 'death.attack.zombie' });
  r.noteEvent({ kind: 'death', tick: 9, timeOfDay: 16000, cause: 'death.attack.skeleton' });
  r.noteEvent({ kind: 'received', tick: 5, from: 'Ken', item: 'bread', count: 2 });
  r.noteEvent({ kind: 'heard', tick: 6, from: 'Hanako', text: 'こっちに来て' });
  r.noteGoal({ kind: 'goal_done', tick: 9, target: 'beef', goalKind: 'item', count: 1, result: 'done', from: 1, to: 9 });
  const facts = r.factsSince();
  const all = facts.join('\n');
  assert.match(all, /ゴール \(beef、need: 空腹\) に約5分かかった/); // 9 区間 × 600 tick = 4.5 分
  assert.match(all, /beef をめざして225m歩いた/);
  assert.match(all, /夜に2回死んだ \(zombie・skeleton\)/);
  assert.match(all, /1回食べた \(beef\)/);
  assert.match(all, /1回寝た/);
  assert.match(all, /ゴール beef 1: 達成した \(8判断\)/);
  assert.match(all, /近くにいた人: Ken \(判断6回\)/);
  assert.match(all, /Ken から bread を2個もらった/);
  assert.match(all, /Hanako に「こっちに来て」と言われた/);
  for (const f of facts) assert.doesNotMatch(f, ADVICE, f);
  const pol = await r.run({ persona: { name: 'Yuki', personality: '怖がり' }, socialText: '怖い' }, 10, 'death');
  assert.strictEqual(pol.text, '昼のうちに食べ物を集めて、夜は拠点で寝る');
  assert.doesNotMatch(llm.seen[0].messages[0].content, ADVICE);
  assert.match(llm.seen[0].messages[1].content, /## 振り返ること \(死んだあと\)\n- /);
  assert.ok(llm.seen[0].schema.properties.policy);
  assert.deepStrictEqual([ev[0].reason, ev[0].ok, ev[0].policy, ev[0].why], ['death', true, pol.text, '夜に死なないため']);
  assert.ok(ev[0].prompt && ev[0].facts.length);
  assert.strictEqual(r.policyText(), '昼のうちに食べ物を集めて、夜は拠点で寝る (何のため: 夜に死なないため)');
  // 振り返ったあとは、その後の分だけを数える
  assert.deepStrictEqual(r.factsSince(), []);
  // Jev の state.policy
  const cfg = loadConfig(CFG, { persona: { name: 'Yuki' } });
  const ctx = buildContext(mockRaw(), new Memory({ limits: cfg.memory.limits }), cfg, { foods: new Set(['bread']) });
  ctx.policy = r.stateText();
  assert.strictEqual(buildState(ctx).policy, '昼のうちに食べ物を集めて、夜は拠点で寝る');
});

// ---- 4. lure / enclose ----

test('lure / enclose の候補: 見えている動物 × 持っている餌 × 行き先、場所 × 大きさ × 持っている柵・ブロック', () => {
  const raw = mockRaw({ inventory: [{ name: 'wheat', count: 3 }, { name: 'oak_fence', count: 20 }, { name: 'oak_fence_gate', count: 1 }, { name: 'cobblestone', count: 40 }],
    entities: [{ kind: 'mob', name: 'cow', id: 3, pos: { x: 6, y: 64, z: 0 }, d: 6 }, { kind: 'mob', name: 'pig', id: 4, pos: { x: 4, y: 64, z: 0 }, d: 4 }] });
  const base = { x: 20, y: 64, z: 0 };
  const lu = lureChoices(raw, { base, memPlaces: [{ id: 'M2', kind: 'water', label: 'water 西10', pos: { x: -10, y: 63, z: 0 }, d: 10 }] });
  assert.deepStrictEqual(lu.map((c) => c.id), ['cow>拠点', 'cow>M2']); // pig の餌 (にんじん等) は持っていない
  assert.match(lu[0].label, /^wheat を持って cow \(東6\(6m\)・見えている1頭\) を拠点 \(東20\(20m\)\)へ$/);
  const en = encloseChoices(raw, { base });
  assert.strictEqual(en.length, 2 * 3 * 2); // 拠点・ここ × 3x3/5x5/7x7 × 柵・丸石
  const c5 = en.find((c) => c.id === '拠点:5x5:oak_fence');
  assert.deepStrictEqual([c5.need, c5.gate, c5.height], [24, 'oak_fence_gate', 1]);
  assert.match(c5.label, /要る数24・うち1つ oak_fence_gate/);
  assert.strictEqual(en.find((c) => c.id === 'ここ:3x3:cobblestone').need, 32);
  // act.enable に入れたときだけ
  assert.ok(!moreActions(raw, { base }, (n) => n !== 'lure' && n !== 'enclose').some((a) => a.name === 'lure' || a.name === 'enclose'));
  assert.ok(moreActions(raw, { base }, () => true).some((a) => a.name === 'lure'));
  assert.strictEqual(typeof handlers.lure, 'function');
  assert.strictEqual(typeof handlers.enclose, 'function');
});

// 模擬の bot: ブロックの Map・持ち物・置く・歩く (lib.gotoGoal で目標へ瞬間移動し、餌を持っていれば近くの動物も付いてくる)
function mockPenBot(w, inv, { animals = [] } = {}) {
  const items = inv.map((i, k) => ({ ...i, type: k + 1 }));
  let held = null;
  const bot = {
    entity: { position: new Vec3(0.5, 64, 8.5), id: 0 },
    entities: {},
    inventory: { items: () => items.filter((i) => i.count > 0) },
    blockAt: (p) => { const b = w.blockAt(p.x, p.y, p.z); return b ? { ...b, position: new Vec3(p.x, p.y, p.z) } : null; },
    equip: async (it) => { held = it; },
    placeBlock: async (ref, face) => {
      const t = ref.position.plus(face);
      const cur = w.blockAt(t.x, t.y, t.z);
      if (cur && cur.name !== 'air') throw new Error('occupied');
      w.m.set(`${t.x},${t.y},${t.z}`, held.name); held.count -= 1;
    },
  };
  for (const a of animals) bot.entities[a.id] = { id: a.id, name: a.name, position: new Vec3(a.x, 64, a.z) };
  const lib = {
    gotoGoal: async (b, goal) => {
      const to = new Vec3(goal.x + 0.5, goal.y ?? 64, goal.z + 0.5);
      if (to.y !== 64) to.y = 64;
      b.entity.position = to;
      if (held && held.name === 'wheat') {
        let k = 0;
        for (const e of Object.values(b.entities)) if (e.name === 'cow' && e.position.distanceTo(to) <= 14) { e.position = to.offset(1 + (k++ % 2), 0, 1); }
      }
    },
    haltPath: () => {},
  };
  return { bot, lib };
}

test('enclose (模擬): 1周に柵を置き、南の真ん中を門にする。囲えたか・置いた数を結果に書く。足りなければ置けた所まで', async () => {
  const w = world();
  const { bot, lib } = mockPenBot(w, [{ name: 'oak_fence', count: 23 }, { name: 'oak_fence_gate', count: 1 }]);
  const h = penHandlers(lib);
  const r = await h.enclose(bot, { center: { x: 0, y: 64, z: 0 }, size: 5, item: 'oak_fence', gate: 'oak_fence_gate', height: 1, place: '拠点' }, {});
  assert.ok(r.ok, r.msg);
  assert.deepStrictEqual([r.enclose.placed, r.enclose.existed, r.enclose.gate, r.enclose.enclosed], [24, 0, true, true]);
  assert.strictEqual(w.m.get('0,64,3'), 'oak_fence_gate');
  assert.match(r.msg, /oak_fenceで拠点の周り \(内側5x5\) を囲った: 24か所のうち24個置いた/);
  // 足りないとき
  const w2 = world();
  const m2 = mockPenBot(w2, [{ name: 'cobblestone', count: 20 }]);
  const r2 = await penHandlers(m2.lib).enclose(m2.bot, { center: { x: 0, y: 64, z: 0 }, size: 3, item: 'cobblestone', gate: null, height: 2, place: 'ここ' }, {});
  assert.ok(r2.ok);
  assert.deepStrictEqual([r2.enclose.placed, r2.enclose.total, r2.enclose.enclosed], [20, 32, false]);
  assert.match(r2.msg, /すき間が残っている/);
});

test('lure (模擬): 餌を持って歩き、付いてきた頭数・行き先に着いた頭数を書く。付いてこなければ失敗', async () => {
  const w = world();
  const m = mockPenBot(w, [{ name: 'wheat', count: 2 }], { animals: [{ id: 5, name: 'cow', x: 3, z: 8 }, { id: 6, name: 'cow', x: 5, z: 9 }, { id: 7, name: 'pig', x: 2, z: 8 }] });
  const r = await penHandlers(m.lib).lure(m.bot, { animal: 'cow', food: 'wheat', dest: { x: 0, y: 64, z: -10 }, destId: '拠点' }, { lureWaitMs: 10, lureSettleMs: 0 });
  assert.ok(r.ok, r.msg);
  assert.deepStrictEqual([r.lure.followed, r.lure.arrived, r.lure.reached], [2, 2, true]);
  assert.match(r.msg, /^wheatを持って\d+m歩いた: cowが2頭付いてきて、拠点の近くに2頭いる$/);
  const m2 = mockPenBot(world(), [{ name: 'carrot', count: 2 }], { animals: [{ id: 5, name: 'cow', x: 3, z: 8 }] });
  const r2 = await penHandlers(m2.lib).lure(m2.bot, { animal: 'cow', food: 'wheat', dest: { x: 0, y: 64, z: -10 } }, {});
  assert.ok(!r2.ok);
  assert.match(r2.msg, /wheatを持っていない/);
});

// ---- 5. 知識の選び方 ----

test('knowledge: 状況 (夜・敵・空腹・死んだばかり・始まったばかり) で出し、道筋の名前を強く数える。always は使っていない', () => {
  const facts = knowledge.loadFacts();
  assert.ok(!facts.some((f) => f.always));
  const s = knowledge.situations({ self: { timeOfDay: 15000, food: 10, health: 8 }, entities: [{ kind: 'hostile' }] }, { tick: 20, diedAt: 15 });
  for (const k of ['night', 'hostile', 'hungry', 'hurt', 'died']) assert.ok(s.has(k), k);
  assert.ok(!s.has('start'));
  const ids = (o) => knowledge.selectFacts(facts, o).map((f) => f.id);
  assert.ok(ids({ situations: s }).includes('hostile'));
  assert.ok(!ids({ situations: new Set() }).includes('hostile'));
  // 同じ名前の当たりでも、道筋に出る名前 (strong) を含む事実が上に来る
  const names = new Set(['oak_log', 'oak_planks', 'oak_leaves', 'apple', 'grass', 'stick']);
  const strong = knowledge.namesInText('ゴール: apple 1 / 道筋: apple 1 ← oak_leaves(見える)');
  const top = ids({ names, strong, max: 3 });
  assert.ok(top.includes('food_apple') && top.includes('drop_leaves'), top.join(','));
  // 新しい事実 (柵・繁殖・育つ時間) も評価語なし
  for (const id of ['fence_recipe', 'fence_count', 'mob_breed_how', 'mob_baby', 'crop_time', 'sapling_time', 'torch_light']) assert.ok(facts.some((f) => f.id === id), id);
});
