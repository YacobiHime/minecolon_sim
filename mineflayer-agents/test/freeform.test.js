'use strict';
// 自由記述のゴール (goalpath の freeform・resolve.js。2026-11-07): luna では案を自由に書かせ、正式名に直し、直せない案は書き直させる。案の数は提供元ごと
const test = require('node:test');
const assert = require('node:assert');
const resolve = require('../src/resolve');
const { GoalPath, kOf, chunkQuestions, goalSchemaFree, proposalsSchemaFree, DEFAULTS } = require('../src/goalpath');
const { strictSchema } = require('../src/llm_provider');
const { loadConfig } = require('../src/config');
const knowledge = require('../src/knowledge');
const { mockRaw } = require('./fixtures');
const path = require('path');

test('resolveItem: 日本語名・表記ゆれ・表示名・複数形・種類の名前・打ち間違い', () => {
  const r = (s, o) => resolve.resolveItem(s, o);
  for (const [s, name, via] of [
    ['石の斧', 'stone_axe', 'ja'], ['石斧', 'stone_axe', 'ja'], ['stone axe', 'stone_axe', 'normalized'], ['Stone_Axe', 'stone_axe', 'normalized'], ['minecraft:stone_axe', 'stone_axe', 'normalized'],
    ['stone_axe', 'stone_axe', 'exact'], ['Steak', 'cooked_beef', 'display'], ['torches', 'torch', 'plural'], ['potatoes', 'potato', 'plural'], ['ぱん', 'bread', 'ja'],
    ['牛肉', 'beef', 'ja_partial'], ['bread x3', 'bread', 'exact'], ['丸石 16個', 'cobblestone', 'ja'], ['作業台 (crafting table)', 'crafting_table', 'ja'], ['iron_pickax', 'iron_pickaxe', 'fuzzy'],
    ['wood', 'oak_log', 'family'], ['板材', 'oak_planks', 'family'],
  ]) {
    const x = r(s);
    assert.ok(x.ok, `${s}: ${x.why}`);
    assert.deepStrictEqual([x.name, x.via], [name, via], s);
  }
});

test('resolveItem: 種類違い (木・色) は 持っている > 見えている > 例 の順。たどれる種類違いを探せる', () => {
  assert.strictEqual(resolve.resolveItem('planks', { prefer: { have: ['jungle_planks'] } }).name, 'jungle_planks');
  assert.strictEqual(resolve.resolveItem('原木', { prefer: { seen: ['birch_log'] } }).name, 'birch_log');
  assert.strictEqual(resolve.resolveItem('bed', { prefer: { shown: ['red_bed'] } }).name, 'red_bed');
  assert.strictEqual(resolve.resolveItem('ベッド').name, 'white_bed');
  assert.ok(resolve.siblings('oak_planks').includes('jungle_planks'));
  const { Planner } = require('../src/planner');
  const pl = new Planner({ inventory: [], visibleBlocks: ['jungle_log'], visibleMobs: [] });
  assert.strictEqual(resolve.plannableVariant('mangrove_planks', pl) != null, true);
});

test('resolveItem: 直せない名前は理由と近い名前。生き物・持てないブロックは落とす物を添える', () => {
  const cow = resolve.resolveItem('牛');
  assert.strictEqual(cow.ok, false);
  assert.match(cow.why, /cow は生き物.*beef.*pen_cow/);
  const w = resolve.resolveItem('water');
  assert.strictEqual(w.ok, false);
  assert.match(w.why, /ブロック/);
  const u = resolve.resolveItem('flubber');
  assert.strictEqual(u.ok, false);
  assert.match(u.why, /知らない/);
});

test('resolveState: 今の型に当てはめる。当てはまらない文は text。チェストの物は正式名に', () => {
  const id = (s) => resolve.resolveState(s).id;
  assert.strictEqual(id('囲いの中に牛が2頭'), 'pen_cow');
  assert.strictEqual(id('sheep in a pen'), 'pen_sheep');
  assert.strictEqual(id('拠点に松明'), 'lit_base');
  assert.strictEqual(id('小麦を植える'), 'planted_wheat');
  assert.strictEqual(id('water near farmland'), 'farmland');
  assert.strictEqual(id('拠点を柵で囲う'), 'walled_base');
  assert.strictEqual(id('拠点のチェストにパンがある'), 'chest_bread');
  assert.strictEqual(id('chest with bread'), 'chest_bread');
  assert.strictEqual(id('pen_cow'), 'pen_cow');
  const t = resolve.resolveState('みんなで焚き火を囲む');
  assert.deepStrictEqual([t.ok, t.state.type, t.via], [true, 'text', 'text']);
  assert.strictEqual(resolve.resolveState('みんなで焚き火を囲む', { allowText: false }).ok, false);
});

test('resolvePlace・resolvePerson: 方角・拠点・M番号・覚えている場所の種類、敬称', () => {
  const pl = [{ name: '拠点', type: 'base', pos: { x: 1, y: 64, z: 1 } }, { name: '北の方', type: 'dir' }, { name: 'M2', type: 'memory', kind: 'water', pos: { x: 9, y: 64, z: 9 } }];
  assert.strictEqual(resolve.resolvePlace('home', pl).name, '拠点');
  assert.strictEqual(resolve.resolvePlace('north', pl).name, '北の方');
  assert.strictEqual(resolve.resolvePlace('北', pl).name, '北の方');
  assert.strictEqual(resolve.resolvePlace('m2', pl).name, 'M2');
  assert.strictEqual(resolve.resolvePlace('水', pl).name, 'M2');
  assert.strictEqual(resolve.resolvePlace('M7', pl, [{ id: 'M7', kind: 'coal_ore', label: '石炭', pos: { x: 0, y: 60, z: 0 } }]).place.kind, 'coal_ore');
  assert.strictEqual(resolve.resolvePlace('village', pl).ok, false);
  assert.strictEqual(resolve.resolvePerson('kenさん', ['Ken', 'Taro']).name, 'Ken');
  assert.strictEqual(resolve.resolvePerson('Bob', ['Ken']).ok, false);
});

test('案の数は提供元ごと (luna 10・local 4)。config も同じ', () => {
  assert.strictEqual(kOf(DEFAULTS.select.k, 'luna'), 10);
  assert.strictEqual(kOf(DEFAULTS.select.k, 'local'), 4);
  assert.strictEqual(kOf(6, 'luna'), 6);
  const cfg = loadConfig(path.join(__dirname, '..', 'configs', 'survival_3days.json'));
  assert.strictEqual(kOf(cfg.goalPath.select.k, 'luna'), 10);
  assert.strictEqual(kOf(cfg.goalPath.select.k, 'local'), 4);
  assert.strictEqual(cfg.goalPath.freeform.enabled, 'auto');
});

test('自由記述の schema は target が文字列 (enum なし)。OpenAI の strict に直せる', () => {
  const s = proposalsSchemaFree(10);
  assert.strictEqual(s.properties.goals.minItems, 10);
  assert.strictEqual(s.properties.goals.items.properties.target.enum, undefined);
  const st = strictSchema(s);
  assert.deepStrictEqual(st.properties.goals.items.required, ['kind', 'target', 'count', 'give', 'why', 'need']);
  assert.strictEqual(goalSchemaFree().properties.target.type, 'string');
});

test('chunkQuestions: 質問の数・本文の大きさの上限で案を分ける', () => {
  const groups = Array.from({ length: 10 }, (_, i) => ({ id: i, s: { [`p${i + 1}`]: 'x'.repeat(100) }, q: Object.fromEntries(Array.from({ length: 5 }, (_, j) => [`p${i + 1}_q${j}`, { type: 'noul', instructions: 'y' }])) }));
  assert.strictEqual(chunkQuestions(groups, {}, { maxQuestions: 60 }).length, 1);
  assert.deepStrictEqual(chunkQuestions(groups, {}, { maxQuestions: 20 }).map((c) => c.length), [4, 4, 2]);
  assert.ok(chunkQuestions(groups, {}, { maxQuestions: 999, maxBodyBytes: 1200 }).length > 1);
});

// ---- GoalPath (luna を模擬) ----
const raw0 = () => mockRaw({ inventory: [{ name: 'bread', count: 2 }], blocks: [{ name: 'jungle_log', nearest: { x: 3, y: 64, z: 0, d: 3 } }, { name: 'stone', nearest: { x: 6, y: 63, z: 0, d: 6 } }],
  entities: [{ kind: 'player', name: 'Ken', pos: { x: 20, y: 64, z: 0 }, d: 20 }], heard: [] });
const ctx0 = (over = {}) => ({ persona: { name: 'Taro', personality: 'のんびり' }, obsText: '見えるブロック: jungle_log, stone', raw: raw0(), facts: () => [], allFacts: knowledge.loadFacts(), memText: 'なし',
  people: [{ name: 'Ken', relation: '知り合い', seen: '東20m' }], places: [], placeKinds: [], needNow: () => 0.7,
  pressing: () => [{ need: 'hunger', distress: 1.5, ratio: 1.2, textEn: 'hungry' }, { need: 'safety', distress: 1.1, ratio: 1, textEn: 'night is coming' }], ...over });

function lunaLLM(outputs) {
  const seen = [];
  return { provider: 'luna', ctxTokens: 272000, seen, complete: async (messages, schema, opts) => { seen.push({ messages, schema, opts }); return { text: outputs.shift(), promptTokens: 9000, completionTokens: 700, finishReason: 'stop' }; } };
}
const G = (kind, target, extra = {}) => ({ kind, target, count: 1, give: '', why: 'x', need: '空腹', ...extra });

test('GoalPath (luna): 自由記述の案 10 個 → 正式名に直す → 直せない・満たされている・重複は理由を添えて書き直させる → Jev で選ぶ', async () => {
  const first = { goals: [
    G('item', '石の斧'), G('item', 'Stone_Axe'), G('item', 'bread'), G('item', '牛'), G('item', 'flubber'), G('item', 'Steak'), G('person', 'kenさん'),
    G('place', 'north'), G('state', '囲いの中に牛が2頭', { count: 2 }), G('item', 'torches', { count: 4 }),
  ] };
  const second = { goals: [G('item', 'cooked_porkchop'), G('item', '木のクワ'), G('item', 'oak planks', { count: 4 }), G('state', 'lit_base')] };
  const llm = lunaLLM([JSON.stringify(first), JSON.stringify(second)]);
  const jevCalls = [];
  const jev = { call: async (state, q) => { jevCalls.push({ state, q }); return { inputTokens: 1000, r: { ok: true, ms: 200, answers: Object.fromEntries(Object.keys(q).map((k) => [k, { noul: /cooked_beef/.test(state.proposals[k.split('_')[0]]) ? 0.95 : 0.4 }])) } }; } };
  const ev = [];
  const gp = new GoalPath({ llm, jev, log: (e) => ev.push(e), cfg: { select: { enabled: true, later: false } } });
  assert.strictEqual(gp.freeform, true);
  assert.strictEqual(gp.k, 10);
  await gp.update(ctx0(), 1);
  // 1回目: 自由記述の schema・例の見出し
  assert.strictEqual(llm.seen[0].schema.properties.goals.minItems, 10);
  assert.strictEqual(llm.seen[0].schema.properties.goals.items.properties.target.enum, undefined);
  assert.match(llm.seen[0].messages[1].content, /## 知っている物の例 \(このほかの物でもよい\)/);
  assert.match(llm.seen[0].messages[0].content, /選択肢ではない/);
  assert.ok(llm.seen[0].opts.maxTokens >= 1100);
  // 書き直し: 4つ (重複・もう持っている・生き物・知らない) を理由付きで、同じ会話に続けて
  const rw = llm.seen[1];
  assert.strictEqual(rw.schema.properties.goals.minItems, 4);
  const fb = rw.messages[rw.messages.length - 1].content;
  assert.match(fb, /Stone_Axe.*同じ案がもうある/);
  assert.match(fb, /bread.*もう持っている/);
  assert.match(fb, /牛.*生き物/);
  assert.match(fb, /flubber.*知らない/);
  assert.strictEqual(rw.messages[rw.messages.length - 2].role, 'assistant');
  const g = ev.find((e) => e.kind === 'goal');
  assert.ok(g, JSON.stringify(ev.map((e) => e.kind)));
  assert.strictEqual(g.target, 'cooked_beef');
  assert.strictEqual(g.written, 'Steak');
  const byWritten = Object.fromEntries(g.proposals.filter((p) => p.written).map((p) => [p.written, p]));
  assert.deepStrictEqual([byWritten['石の斧'].target, byWritten['石の斧'].via], ['stone_axe', 'ja']);
  assert.strictEqual(byWritten['kenさん'].target, 'Ken');
  assert.strictEqual(byWritten.north.target, '北の方');
  assert.strictEqual(byWritten['囲いの中に牛が2頭'].target, 'pen_cow');
  assert.strictEqual(byWritten['木のクワ'].target, 'wooden_hoe');
  assert.strictEqual(byWritten['oak planks'].round, 1);
  assert.ok(g.diversity.valid >= 9, JSON.stringify(g.diversity));
  assert.ok(g.diversity.distinctValid === g.diversity.valid);
  assert.ok(g.diversity.kinds.item && g.diversity.kinds.person && g.diversity.kinds.place && g.diversity.kinds.state);
  assert.strictEqual(g.rewrites.length, 1);
  assert.strictEqual(g.rewrites[0].asked, 4);
  // Jev: 案 × 欲求 を1回に (10 案 × 2 = 20 問 ≤ 60)。自由な物にも英語の説明が付く
  assert.strictEqual(jevCalls.length, 1);
  assert.strictEqual(g.select.jev.calls, 1);
  assert.ok(Object.values(jevCalls[0].state.proposals).some((t) => /obtain cooked_beef x1 \(cooked_beef; food/.test(t)), JSON.stringify(jevCalls[0].state.proposals));
});

test('GoalPath (luna): Jev の質問が上限を超えると案を分けて並列に呼び、答えを合わせる', async () => {
  const goals = ['bread', 'apple', 'stick', 'torch', 'cooked_beef', 'jungle_planks', 'crafting_table', 'stone_pickaxe', 'cobblestone', 'chest'].map((t) => G('item', t, { count: t === 'bread' ? 5 : 1 }));
  const llm = lunaLLM([JSON.stringify({ goals })]);
  const calls = [];
  const jev = { call: async (state, q) => { calls.push(Object.keys(q).length); return { inputTokens: 500, r: { ok: true, ms: 100, answers: Object.fromEntries(Object.keys(q).map((k) => [k, { noul: /torch/.test(state.proposals[k.split('_')[0]]) ? 0.9 : 0.2 }])) } }; } };
  const ev = [];
  const gp = new GoalPath({ llm, jev, log: (e) => ev.push(e), cfg: { select: { enabled: true, later: false, maxQuestions: 6 } } });
  await gp.update(ctx0(), 1);
  const g = ev.find((e) => e.kind === 'goal');
  assert.deepStrictEqual(calls, [6, 6, 6, 2]);
  assert.strictEqual(g.select.jev.calls, 4);
  assert.strictEqual(g.select.jev.questions, 20);
  assert.strictEqual(g.target, 'torch');
});

test('GoalPath (luna): 文の状態は Jev に「見て確かめられるか」を聞き、ゴールにしたら「そうなったか」を判断ごとに聞く', async () => {
  const goals = [G('state', 'みんなで焚き火を囲んでいる'), G('state', 'みんなが幸せ'), G('item', 'stick')];
  const llm = lunaLLM([JSON.stringify({ goals })]);
  let doneP = 0.2;
  const jev = { call: async (state, q) => {
    const ans = {};
    for (const k of Object.keys(q)) {
      if (k.endsWith('_checkable')) ans[k] = { noul: /幸せ/.test(state.states[k.split('_')[0]]) ? 0.1 : 0.8 };
      else if (k.endsWith('_done')) ans[k] = { noul: 0.1 };
      else if (k === 'done') ans[k] = { noul: doneP };
      else ans[k] = { noul: /焚き火/.test(state.proposals[k.split('_')[0]]) ? 0.9 : 0.3 };
    }
    return { inputTokens: 300, r: { ok: true, ms: 50, answers: ans } };
  } };
  const ev = [];
  const gp = new GoalPath({ llm, jev, log: (e) => ev.push(e), cfg: { select: { enabled: true, k: 3, later: false } } });
  await gp.update(ctx0(), 1);
  const g = ev.find((e) => e.kind === 'goal');
  assert.strictEqual(g.target, 'みんなで焚き火を囲んでいる');
  assert.strictEqual(g.proposals.find((p) => p.target === 'みんなが幸せ').result, 'uncheckable');
  assert.strictEqual(gp.goal.state.type, 'text');
  assert.match(gp.planText(), /まだ \(見て確かめる\)$/);
  assert.strictEqual(gp.planEn().check, 'not yet (judged by looking around)');
  assert.strictEqual(await gp.update(ctx0(), 2), null);
  assert.ok(ev.some((e) => e.kind === 'text_check' && e.p === 0.2));
  doneP = 0.9;
  await gp.update(ctx0(), 6);
  assert.ok(ev.some((e) => e.kind === 'reached'), JSON.stringify(ev.map((e) => e.kind)));
});

test('GoalPath (local): 今のまま (enum の縛り・案 4 個)', async () => {
  const llm = { seen: [], complete: async (m, schema) => { llm.seen.push(schema); return { text: JSON.stringify({ goals: [G('item', 'stick'), G('item', 'jungle_planks'), G('item', 'crafting_table'), G('item', 'torch')] }), promptTokens: 1, completionTokens: 1 }; } };
  const jev = { call: async (state, q) => ({ r: { ok: true, answers: Object.fromEntries(Object.keys(q).map((k) => [k, { noul: 0.5 }])) } }) };
  const gp = new GoalPath({ llm, jev, cfg: { select: { enabled: true, later: false } } });
  assert.strictEqual(gp.freeform, false);
  assert.strictEqual(gp.k, 4);
  await gp.update(ctx0(), 1);
  assert.ok(Array.isArray(llm.seen[0].properties.goals.items.properties.target.enum));
  assert.strictEqual(llm.seen[0].properties.goals.minItems, 4);
});

test('GoalPath (luna, 1案): 直せない名前は理由を添えて聞き直す', async () => {
  const llm = lunaLLM([JSON.stringify(G('item', 'flubber')), JSON.stringify(G('item', 'パン', { count: 3 }))]);
  const ev = [];
  const gp = new GoalPath({ llm, log: (e) => ev.push(e) });
  await gp.update(ctx0(), 1);
  assert.ok(ev.some((e) => e.kind === 'unresolved' && /知らない/.test(e.why)));
  assert.match(llm.seen[1].messages[1].content, /flubber: 「flubber」という物は知らない/);
  assert.deepStrictEqual([gp.goal.target, gp.goal.count], ['bread', 3]);
});

test('summarize_run: 案の広がり (種類の数・kind・直し方・書き直し) を出す', () => {
  const fs = require('fs'); const os = require('os'); const { execFileSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-ff-'));
  const L = (o) => JSON.stringify(o);
  const prop = (target, written, via, ok = true, kind = 'item') => ({ kind, target, ok, written, via, result: ok ? null : 'unresolved' });
  fs.writeFileSync(path.join(dir, 'Taro-x.jsonl'), [
    L({ ts: '2026-11-07T01:00:00.000Z', event: 'start', persona: { name: 'Taro' }, decider: 'jev', day: 0 }),
    L({ ts: '2026-11-07T01:00:01.000Z', event: 'goal_path', kind: 'goal', ok: true, tick: 1, k: 10, freeform: true, target: 'stone_axe', goalKind: 'item',
      proposals: [prop('stone_axe', '石の斧', 'ja'), prop('cooked_beef', 'Steak', 'display'), prop('北の方', 'north', 'dir', true, 'place'), { ok: false, result: 'unresolved', written: 'flubber', reason: '知らない' }],
      diversity: { written: 4, rewritten: 1, resolved: 3, valid: 3, distinct: 3, distinctValid: 3, kinds: { item: 2, place: 1 }, outsideExamples: 1, via: { ja: 1, display: 1, dir: 1 }, dropped: { unresolved: 1 } },
      rewrites: [{ round: 1, asked: 1, got: 1, ok: 1 }], select: { rule: 'max', chosen: 0, scores: [], needs: [], jev: { calls: 1, inputTokens: 900 } } }),
  ].join('\n'));
  const out = JSON.parse(execFileSync('node', [path.join(__dirname, '..', 'tools', 'summarize_run.js'), dir], { encoding: 'utf8' }));
  const sp = out.goalSelect.spread;
  assert.strictEqual(sp.freeform, 1);
  assert.strictEqual(sp.perRound.distinctValid, 3);
  assert.deepStrictEqual(sp.kinds, { item: 2, place: 1 });
  assert.strictEqual(sp.distinctTargetsAll, 3);
  assert.strictEqual(sp.rewrites.asked, 1);
  assert.ok(sp.resolvedExamples.includes('石の斧 → stone_axe (ja)'));
  const txt = execFileSync('node', [path.join(__dirname, '..', 'tools', 'summarize_run.js'), dir, '--text'], { encoding: 'utf8' });
  assert.match(txt, /案の広がり: 1 回 \(自由記述 1/);
});

test('自由記述: 着いている場所の名前は「もう着いている」。状態の文の数を count に', () => {
  const r = resolve.resolvePlace('拠点 (M1)', [{ name: '北の方', type: 'dir' }], [], { arrived: [{ name: '拠点', type: 'base' }] });
  assert.deepStrictEqual([r.ok, r.why], [false, 'もう着いている']);
  assert.strictEqual(resolve.resolvePlace('home', [], [], { arrived: [{ name: '拠点', type: 'base' }] }).why, 'もう拠点に着いている');
  const gp = new GoalPath({ llm: { provider: 'luna', complete: async () => ({}) } });
  const cands = { items: [], people: [], places: [], states: [] };
  const x = gp.resolveFree({ kind: 'state', target: '拠点の近くに明かりが4個ある', count: 1, give: '', why: 'w', need: '安心' }, cands, { raw: null }, { have: [] });
  assert.deepStrictEqual([x.pg.target, x.pg.count], ['lit_base', 4]);
});

test('resolveState: 物を持っている様子の文は物のゴールに直す (asItem)。「手に入れ」はチェストにしない', () => {
  assert.strictEqual(resolve.resolveState('近くの草から小麦の種を1個手に入れている').asItem, 'wheat_seeds');
  assert.strictEqual(resolve.resolveState('have 3 bread').asItem, 'bread');
  assert.strictEqual(resolve.resolveState('拠点のチェストに小麦の種が8個ある').id, 'chest_wheat_seeds');
});

test('resolvePlace: 全角の括弧・「拠点の近く」も拠点', () => {
  const arrived = { arrived: [{ name: '拠点', type: 'base' }] };
  assert.strictEqual(resolve.resolvePlace('拠点（M1）', [], [], arrived).why, 'もう着いている');
  assert.strictEqual(resolve.resolvePlace('拠点の近く', [], [], arrived).why, 'もう拠点に着いている');
  assert.strictEqual(resolve.resolvePlace('拠点の近く', [{ name: '拠点', type: 'base' }]).name, '拠点');
});
