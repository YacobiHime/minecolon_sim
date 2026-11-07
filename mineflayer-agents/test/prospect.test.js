'use strict';
// あとでやること (prospect.js)・植えたらゴールは済んだ扱い・育っている頃の候補・続けて耕す/植える数・M 番号の置き換え・
//   耕地に乗らない (pathfinder)・summarize_run のあとでやること/置き換え/土に戻った原因
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Prospects, TPM } = require('../src/prospect');
const { Memory } = require('../src/memory');
const { GoalPath } = require('../src/goalpath');
const { replaceMRefs } = require('../src/places');
const { moreActions, farmCount } = require('../src/actions_more');
const knowledge = require('../src/knowledge');
const { mockRaw } = require('./fixtures');

const ADVICE = /べき|しよう|した方が|がよい|が良い|おすすめ|大切|重要|should|must|better|recommend/i;
const P2 = [{ id: 'M2', pos: { x: 10, y: 63, z: 0 } }];

test('Prospects: 植えた → 「M2に小麦を3本植えた (約8分前。育つのはあと15分ほど)」(ゲーム内の時刻で数える)。英語も。同じ畑はまとめる', () => {
  const store = {};
  const pr = new Prospects(store);
  const t0 = 100000;
  const a = pr.add('crop', { pos: { x: 10, y: 63, z: 0 }, now: t0, n: 2, what: { crop: 'wheat', wet: true } });
  assert.strictEqual(a.merged, false);
  const b = pr.add('crop', { pos: { x: 11, y: 63, z: 1 }, now: t0, n: 1, what: { crop: 'wheat', wet: true } });
  assert.strictEqual(b.merged, true);
  assert.strictEqual(store.prospects.length, 1);
  const x = store.prospects[0];
  assert.deepStrictEqual([x.n, x.dueMin - t0, x.dueMax - t0], [3, 20 * TPM, 30 * TPM]);
  const now = t0 + 8 * TPM;
  assert.strictEqual(pr.textJa(x, now, { places: P2 }), 'M2に小麦を3本植えた (約8分前。育つのはあと15分ほど)');
  assert.strictEqual(pr.textEn(x, now, { places: P2 }), 'planted 3 wheat at M2 (about 8 min ago; expected to be fully grown in about 15 min)');
  // 乾いた耕地は倍
  const d = new Prospects({}).add('crop', { pos: { x: 0, y: 63, z: 0 }, now: 0, what: { crop: 'carrots', wet: false } }).item;
  assert.deepStrictEqual([d.dueMin, d.dueMax], [40 * TPM, 60 * TPM]);
  // M 番号が無い所は自分からの方角
  assert.match(pr.textJa(x, now, { here: { x: 0, y: 63, z: 0 }, places: [] }), /^東10\(10m\)に小麦を3本植えた/);
  for (const s of [pr.textJa(x, now, { places: P2 }), pr.textEn(x, now, { places: P2 })]) assert.doesNotMatch(s, ADVICE);
});

test('Prospects: 見込みの時刻になったら記録 (due) とゴールの候補「小麦を取りに行く@M2」(植えてから約25分。育っている頃)。済んだら候補から消える', () => {
  const pr = new Prospects({});
  pr.add('crop', { pos: { x: 10, y: 63, z: 0 }, now: 0, n: 3, what: { crop: 'wheat', wet: true } });
  assert.deepStrictEqual(pr.tick(19 * TPM), []);
  assert.deepStrictEqual(pr.goalCandidates(19 * TPM, { places: P2 }), []);
  const ev = pr.tick(25 * TPM, 40);
  assert.deepStrictEqual(ev.map((e) => [e.op, e.kind, e.sinceStartMin]), [['due', 'crop', 25]]);
  assert.deepStrictEqual(pr.tick(26 * TPM), []); // 1回だけ
  const c = pr.goalCandidates(25 * TPM, { places: P2 });
  assert.deepStrictEqual(c.map((x) => [x.name, x.desc, x.type]), [['小麦を取りに行く@M2', 'M2、植えてから約25分。育っている頃', 'later']]);
  assert.match(c[0].descEn, /planted about 25 min ago; expected to be fully grown by now/);
  assert.doesNotMatch(c[0].desc, ADVICE);
  assert.strictEqual(pr.textJa(pr.list[0], 25 * TPM, { places: P2 }), 'M2に小麦を3本植えた (約25分前。育っている頃)');
  // 取った (近くで wheat が増えた) → 済んだ。見込みの時刻のあと何分か
  const h = pr.harvested({ x: 11, y: 64, z: 0 }, { wheat: 3 }, 31 * TPM, 50);
  assert.deepStrictEqual(h.map((e) => [e.op, e.how, e.afterDue, e.overdueMin]), [['done', 'harvested', true, 11]]);
  assert.deepStrictEqual(pr.goalCandidates(32 * TPM, { places: P2 }), []);
  assert.match(pr.textsJa(32 * TPM, { places: P2 })[0], /取った\)$/);
});

test('Prospects: 作物の育ち (age) を見て見込みを直す (骨粉で早まる)・全部育ちきった → ripe_seen・無くなった → gone', () => {
  const pr = new Prospects({});
  pr.add('crop', { pos: { x: 0, y: 64, z: 0 }, now: 0, n: 2, what: { crop: 'wheat', wet: true } });
  const blocks = new Map();
  const at = (x, y, z) => blocks.get(`${x},${y},${z}`) || { name: 'air' };
  const wheat = (age) => ({ name: 'wheat', getProperties: () => ({ age }) });
  blocks.set('0,63,0', { name: 'farmland', getProperties: () => ({ moisture: 7 }) });
  blocks.set('1,63,0', { name: 'farmland', getProperties: () => ({ moisture: 7 }) });
  blocks.set('0,64,0', wheat(7)); blocks.set('1,64,0', wheat(7)); // 骨粉で育ちきった
  const now = 2 * TPM;
  const ev = pr.observeCrops(at, { x: 0, y: 64, z: 0 }, now, 3);
  assert.deepStrictEqual(ev.map((e) => e.op), ['ripe_seen']);
  assert.strictEqual(pr.goalCandidates(now, {}).length, 0); // 見込みはまだ (候補は見込みの時刻のあと)
  // 半分 (age 3〜4) → 残り半分の見込み
  const pr2 = new Prospects({});
  pr2.add('crop', { pos: { x: 0, y: 64, z: 0 }, now: 0, n: 2, what: { crop: 'wheat', wet: true } });
  blocks.set('0,64,0', wheat(3)); blocks.set('1,64,0', wheat(4));
  pr2.observeCrops(at, { x: 0, y: 64, z: 0 }, now, 3);
  const x = pr2.list[0];
  assert.strictEqual(x.dueMin, now + 10 * TPM); assert.strictEqual(x.dueMax, now + 15 * TPM);
  // 遠くにいるときは見ない
  assert.deepStrictEqual(pr2.observeCrops(at, { x: 100, y: 64, z: 0 }, now, 3), []);
  // 作物が無くなった → gone
  blocks.delete('0,64,0'); blocks.delete('1,64,0');
  const g = pr2.observeCrops(at, { x: 0, y: 64, z: 0 }, now + TPM, 4);
  assert.deepStrictEqual(g.map((e) => [e.op, e.how]), [['done', 'gone']]);
});

test('Prospects: かまど (1個10秒)・子ども (20分で大人)・繁殖 (5分) も同じ形。取り出したら済んだ', () => {
  const pr = new Prospects({});
  const f = { x: 5, y: 64, z: 5 };
  pr.add('smelt', { pos: f, now: 0, n: 6, what: { input: 'raw_iron', output: 'iron_ingot' } });
  pr.add('grow_up', { pos: { x: 20, y: 64, z: 0 }, now: 0, n: 1, what: { animal: 'cow' } });
  pr.add('breed_again', { pos: { x: 20, y: 64, z: 0 }, now: 0, n: 1, what: { animal: 'cow' } });
  const byKind = Object.fromEntries(pr.list.map((x) => [x.kind, x]));
  assert.strictEqual(byKind.smelt.dueMin, 6 * 200);
  assert.strictEqual(byKind.grow_up.dueMin, 20 * TPM);
  assert.strictEqual(byKind.breed_again.dueMin, 5 * TPM);
  const t = 30 * 20; // 30秒
  assert.strictEqual(pr.textJa(byKind.smelt, t, {}), '(5, 64, 5)のかまどに鉄の原石を6個入れた (約1分足らず前。焼き上がるのはあと1分足らずほど)');
  assert.match(pr.textJa(byKind.grow_up, 6 * TPM, {}), /牛の子どもが1匹生まれた \(約6分前。大人になるのはあと15分ほど\)/);
  assert.match(pr.textJa(byKind.breed_again, 6 * TPM, {}), /牛に餌をやって繁殖させた \(約6分前。次に繁殖できる頃\)/);
  const names = pr.goalCandidates(6 * TPM, {}).map((c) => c.name);
  assert.deepStrictEqual(names, ['かまどの鉄インゴットを取りに行く@(5, 64, 5)', '牛の所へ行く@(20, 64, 0)']);
  assert.deepStrictEqual(pr.furnaceTaken(f, 6 * TPM).map((e) => [e.how, e.afterDue]), [['taken', true]]);
  assert.deepStrictEqual(pr.counts(), { smelt: 1, grow_up: 1, breed_again: 1 });
});

test('Memory: あとでやることが 2B の記憶の文と Jev の英語の記憶に出る。保存・読み込みで残る', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-later-'));
  const file = path.join(dir, 'm.json');
  const m = new Memory({ file, limits: { promptItems: 12 } });
  m.notePlace('wheat', { x: 10, y: 63, z: 0 });
  m.gameNow = 5000;
  m.prospects.add('crop', { pos: { x: 10, y: 63, z: 0 }, now: 5000, n: 3, what: { crop: 'wheat', wet: true } });
  m.gameNow = 5000 + 8 * TPM;
  const here = { x: 0, y: 63, z: 0 };
  assert.match(m.toPromptText(here), /あとでやること: M1に小麦を3本植えた \(約8分前。育つのはあと15分ほど\)/);
  assert.deepStrictEqual(m.toStateEn(here).later, ['planted 3 wheat at M1 (about 8 min ago; expected to be fully grown in about 15 min)']);
  m.save();
  const m2 = Memory.load(file);
  m2.gameNow = 5000 + 26 * TPM;
  assert.match(m2.toPromptText(here), /M1に小麦を3本植えた \(約25分前。育っている頃\)/);
  // ゲーム内の時刻が分からなければ出さない
  m2.gameNow = null;
  assert.doesNotMatch(m2.toPromptText(here), /あとでやること/);
});

// ---- GoalPath ----
function mockLLM(outputs) {
  const seen = [];
  return { seen, complete: async (messages, schema) => { seen.push({ messages, schema }); return { text: outputs.shift(), promptTokens: 1500, completionTokens: 30 }; } };
}
function gctx(raw, over = {}) {
  return {
    persona: { name: 'Yuki', personality: '' }, goalText: '', obsText: '', raw, facts: () => [], allFacts: knowledge.loadFacts(),
    memText: 'なし', socialText: '', worst: null, peopleText: '', people: [], places: [], placeKinds: [], base: null, needNow: () => 0.8, ...over,
  };
}
const farmRaw = (inv) => mockRaw({ inventory: inv, blocks: [{ name: 'grass', nearest: { x: 2, y: 64, z: 0, d: 2 } }, { name: 'water', notable: true, nearest: { x: 3, y: 63, z: 0, d: 3 } }], entities: [], heard: [] });

test('GoalPath: 植えて道筋の残りが「育つのを待つ」だけになったら、ゴールは済んだ扱い (planted) で次のゴールを選ぶ。待つだけの案は外して聞き直す', async () => {
  const llm = mockLLM([
    '{"kind":"item","target":"wheat","count":3,"why":"パンにしたい","need":"空腹"}',
    '{"kind":"item","target":"wheat","count":3,"why":"パンにしたい","need":"空腹"}',
    '{"kind":"place","target":"北の方","why":"見てみたい","need":"好奇心"}',
  ]);
  const ev = [];
  const gp = new GoalPath({ llm, log: (e) => ev.push(e) });
  const water = { where: 'visible', ready: true };
  // 種とクワがあり、空いている耕地 3 → 植える道筋
  const c1 = gctx(farmRaw([{ name: 'wheat_seeds', count: 3 }, { name: 'wooden_hoe', count: 1 }]), { _farm: { empty: 3, growing: {}, ripe: {}, tillCount: 0, till: [] } });
  assert.strictEqual(await gp.update(c1, 1), 'goal');
  assert.strictEqual(gp.goal.target, 'wheat');
  assert.match(gp.planText(), /wheat_seeds 3 を耕地に植える/);
  // 植えた (種なし、育ち途中 3) → 済んだ扱い。次の案 wheat は「待つだけ」で外され、場所のゴールに
  const c2 = gctx(farmRaw([{ name: 'wooden_hoe', count: 1 }]), { _farm: { empty: 0, growing: { wheat: 3 }, ripe: {}, tillCount: 0, till: [] } });
  void water;
  assert.strictEqual(await gp.update(c2, 2), 'planted');
  assert.strictEqual(gp.goal.kind, 'place');
  // 道筋の次が「育つのを待つ」のまま止まらない: 次のゴールに移り、道筋に待つの意味が出ない
  assert.strictEqual(gp.waitingGrowth(), false);
  assert.doesNotMatch(gp.planText() || '', /待つ/);
  assert.strictEqual(gp.history[0].result, 'planted');
  assert.strictEqual(gp.history[0].resultText, '植えた (育っている頃に戻る。あとでやること)');
  assert.strictEqual(gp.counts.planted, 1);
  assert.strictEqual(gp.counts.waiting, 1);
  assert.ok(ev.some((e) => e.kind === 'goal_done' && e.result === 'planted'));
  assert.ok(ev.some((e) => e.kind === 'waiting'));
  assert.match(llm.seen[2].messages[1].content, /## さっき選んだゴール\nwheat 3: もう植えてある。育っている頃に戻る \(あとでやること\)/);
});

test('GoalPath: 育っている頃のあとでやることが場所の候補に出る。選ぶと「小麦を取りに行く (M2)」のゴール。記録に later', async () => {
  const pr = new Prospects({});
  pr.add('crop', { pos: { x: 30, y: 64, z: 0 }, now: 0, n: 3, what: { crop: 'wheat', wet: true } });
  const laterPlaces = pr.goalCandidates(26 * TPM, { places: [{ id: 'M2', pos: { x: 30, y: 64, z: 0 } }] });
  const llm = mockLLM(['{"kind":"place","target":"小麦を取りに行く@M2","why":"食べ物","need":"空腹"}']);
  const ev = [];
  const gp = new GoalPath({ llm, log: (e) => ev.push(e) });
  const raw = farmRaw([]);
  assert.strictEqual(await gp.update(gctx(raw, { laterPlaces }), 1), 'goal');
  const user = llm.seen[0].messages[1].content;
  assert.match(user, /## 場所\n小麦を取りに行く@M2: M2、植えてから約25分。育っている頃\n/);
  assert.ok(llm.seen[0].schema.properties.target.enum.includes('小麦を取りに行く@M2'));
  assert.match(gp.planText(), /^ゴール: 小麦を取りに行く \(M2\) \(食べ物\) \/ 次: 小麦を取りに行く \(M2\) \(東30\(30m\)\)$/);
  assert.match(gp.planEn().goal, /^go to the wheat planted at M2/);
  assert.deepStrictEqual(ev.find((e) => e.kind === 'goal').later, { id: 'L1', kind: 'crop' });
  // 着いたら済んだ
  const near = mockRaw({ ...raw, self: { ...raw.self, pos: { x: 28, y: 64, z: 0 } } });
  await gp.update(gctx(near, { laterPlaces }), 2);
  assert.ok(gp.goal.metAt != null);
});

// ---- 続けて耕す・植える ----
test('use_on: 続けて耕す数 = 持っている種 − 空いている耕地 (水の近くの耕せるマスまで)・続けて植える数 = 種と空いている耕地。ラベルに「続けてnマスまで」', () => {
  const inv = [{ name: 'wooden_hoe', count: 1 }, { name: 'wheat_seeds', count: 6 }];
  assert.strictEqual(farmCount(inv, 'wooden_hoe', { till: true, tillCount: 10, emptyCount: 2 }), 4);
  assert.strictEqual(farmCount(inv, 'wooden_hoe', { till: true, tillCount: 3, emptyCount: 0 }), 3);
  assert.strictEqual(farmCount([{ name: 'wooden_hoe', count: 1 }], 'wooden_hoe', { till: true, tillCount: 3, emptyCount: 0 }), 1);
  assert.strictEqual(farmCount(inv, 'wooden_hoe', { till: true, tillCount: null }), 1); // 数が分からない所 (覚えている水場)
  assert.strictEqual(farmCount(inv, 'wheat_seeds', { name: 'farmland', emptyCount: 4 }), 4);
  assert.strictEqual(farmCount(inv, 'wheat_seeds', { name: 'farmland', emptyCount: 20 }, { plantMax: 5 }), 5);
  assert.strictEqual(farmCount(inv, 'hand', { name: 'farmland', emptyCount: 4 }), 1);
  const raw = mockRaw({ inventory: inv, blocks: [], entities: [] });
  const acts = moreActions(raw, { farmTargets: [
    { name: 'farmland_spot', idName: 'farmland_spot', pos: { x: 2, y: 63, z: 0 }, note: '水から4マス以内のdirt', noteEn: 'dirt', tillCount: 10, emptyCount: 2 },
    { name: 'farmland', idName: 'farmland@empty', pos: { x: 1, y: 63, z: 0 }, note: '空いている', noteEn: 'empty', emptyCount: 2 },
  ] });
  const ch = acts.find((a) => a.name === 'use_on').choices;
  const till = ch.find((c) => c.id === 'wooden_hoe>farmland_spot');
  assert.strictEqual(till.count, 4);
  assert.match(till.label, /続けて4マスまで/);
  assert.match(till.labelEn, /up to 4 blocks in a row/);
  const plant = ch.find((c) => c.id === 'wheat_seeds>farmland@empty');
  assert.strictEqual(plant.count, 2);
});

test('use_on (続けて): 1マス目のあと近くの空いている耕地に count まで植え、1つの結果にまとめる。途中で失敗したらやめる', async () => {
  const { moreHandlers, wrapMany } = require('../src/act_more');
  assert.strictEqual(typeof moreHandlers({}).use_on, 'function');
  let calls = 0;
  const bot = { inventory: { items: () => [{ name: 'wheat_seeds', count: 5 }] }, entity: { position: { x: 0, y: 64, z: 0, distanceTo: () => 1 } },
    findBlocks: () => [{ x: 1, y: 63, z: 0, distanceTo: () => 1, offset: () => ({}) }, { x: 2, y: 63, z: 0, distanceTo: () => 2, offset: () => ({}) }], blockAt: () => ({ name: 'air' }) };
  // 元の1回分 (act_more の use_on) を真似る関数を包む
  const once = async (b, ch) => { calls += 1; return calls <= 3 ? { ok: true, msg: `植えた${calls}`, farm: { plant: 'wheat', pos: { x: calls, y: 64, z: 0 }, wet: true } } : { ok: false, msg: '何も起きなかった' }; };
  const wrapped = wrapMany(once);
  const r = await wrapped(bot, { item: 'wheat_seeds', target: 'farmland', targetKind: 'block', pos: { x: 1, y: 63, z: 0 }, count: 5 }, {});
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual([r.farm.plant, r.farm.n, r.farm.positions.length], ['wheat', 3, 3]);
  assert.match(r.msg, /^wheat_seedsを3マスの耕地に使った: wheatが3本植わった、持ち物 wheat_seeds-3。4マス目: 何も起きなかった$/);
});

// ---- M 番号の置き換え ----
test('replaceMRefs: 発言の中の M 番号を共通の呼び方に置き換える。一覧に無い番号・M12 と M1 の取り違えはしない', () => {
  const origin = { x: 0, y: 64, z: 0 };
  const places = [{ id: 'M1', pos: { x: 28, y: 64, z: -28 } }, { id: 'M2', pos: { x: 0, y: 64, z: 3 } }];
  const r = replaceMRefs('M1に行くよ！M2の作業台も。M9とM12は知らない', places, origin);
  assert.strictEqual(r.text, '出現地点から北東に40mの所に行くよ！出現地点のすぐ近くの所の作業台も。M9とM12は知らない');
  assert.deepStrictEqual([r.n, r.ids], [2, ['M1', 'M2']]);
  assert.strictEqual(replaceMRefs('ＭＭ２へ', places, origin).text, 'ＭＭ２へ'); // 前が英字なら番号ではない
  assert.strictEqual(replaceMRefs('Ｍ２へ', places, origin).text, '出現地点のすぐ近くの所へ');
  assert.strictEqual(replaceMRefs('M1へ', places, null).text, '(28, 64, -28)の所へ');
  assert.deepStrictEqual(replaceMRefs('ITEM1 と M3', places, origin), { text: 'ITEM1 と M3', n: 0, ids: [] });
});

test('agent.chat / 全体チャット: M 番号を置き換えてから送り、元の文と置き換え後を記録 (m_replaced)', () => {
  const { Agent } = require('../src/agent');
  const sent = []; const rec = [];
  const self = Object.create(Agent.prototype);
  Object.assign(self, {
    bot: { chat: (t) => sent.push(t) }, cfg: { loop: { chatMinIntervalMs: 0 }, persona: { name: 'Taro' } }, lastChat: { t: 0, text: '' },
    memory: new Memory({ origin: { x: 0, y: 64, z: 0 } }), social: { onSpoke: () => {} }, recorder: { write: (r) => rec.push(r) },
    lastMemPlaces: [{ id: 'M2', pos: { x: 40, y: 64, z: 0 } }],
  });
  assert.strictEqual(self.chat('M2に小麦を植えたよ'), true);
  assert.deepStrictEqual(sent, ['出現地点から東に40mの所に小麦を植えたよ']);
  assert.deepStrictEqual(rec.map((r) => [r.event, r.via, r.original, r.replaced, r.n]), [['m_replaced', 'chat', 'M2に小麦を植えたよ', '出現地点から東に40mの所に小麦を植えたよ', 1]]);
  assert.strictEqual(self.memory.heard[0].text, '出現地点から東に40mの所に小麦を植えたよ');
  // 文を作ったときの一覧を渡せばそれを使う
  self.chat('M1を見て', { places: [{ id: 'M1', pos: { x: 0, y: 64, z: -40 } }] });
  assert.strictEqual(sent[1], '出現地点から北に40mの所を見て');
});

// ---- 耕地に乗らない ----
test('setupPathfinder: 耕地は乗らない・通らない・掘らない (踏まれて土に戻るのを避ける)', () => {
  const { Movements } = require('mineflayer-pathfinder');
  const { Vec3 } = require('vec3');
  const EventEmitter = require('events');
  const unstuck = require('../src/unstuck');
  const registry = require('minecraft-data')('1.20.1');
  const bot = new EventEmitter();
  Object.assign(bot, { registry, version: '1.20.1', pathfinder: {}, entity: { position: new Vec3(0, 64, 0) }, entities: {}, world: {}, game: { minY: -64 } });
  const mv = new Movements(bot);
  unstuck.setupPathfinder(bot, mv);
  const id = registry.blocksByName.farmland.id;
  assert.ok(mv.fences.has(id) && mv.blocksCantBreak.has(id));
  bot.blockAt = () => ({ type: id, name: 'farmland', boundingBox: 'block', shapes: [[0, 0, 0, 1, 0.9375, 1]] });
  const gb = mv.getBlock(new Vec3(0, 63, 0), 0, 0, 0);
  assert.deepStrictEqual([gb.physical, gb.safe], [false, false]);
  assert.strictEqual(mv.safeToBreak(gb), false);
  const off = new Movements(bot);
  unstuck.setupPathfinder(bot, off, { avoidFarmland: false });
  assert.ok(!off.fences.has(id));
});

// ---- summarize_run ----
test('summarize_run: あとでやること (種類ごと・見込みのあとに取った数と時間・候補をゴールに)・M 番号の置き換え・続けて耕した数・土に戻った原因', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-later-'));
  const t = (s) => `2026-11-06T01:00:${String(s).padStart(2, '0')}.000Z`;
  let n = 0;
  const step = (action, arg, result) => JSON.stringify({ ts: t(++n), loop: n, action, arg, result: { ok: true, msg: 'ok', ...result }, decideMs: 100, inventory: [] });
  fs.writeFileSync(path.join(dir, 'Taro-x.jsonl'), [
    JSON.stringify({ ts: t(0), event: 'start', persona: { name: 'Taro' }, decider: 'jev', day: 0 }),
    step('use_on', 'wooden_hoe>farmland_spot', { farm: { till: true, n: 3, nearWater: true } }),
    step('use_on', 'wheat_seeds>farmland@empty', { farm: { plant: 'wheat', n: 3 } }),
    JSON.stringify({ ts: t(10), event: 'prospect', op: 'add', kind: 'crop', id: 'L1' }),
    JSON.stringify({ ts: t(11), event: 'prospect', op: 'merge', kind: 'crop', id: 'L1' }),
    JSON.stringify({ ts: t(12), event: 'prospect', op: 'add', kind: 'smelt', id: 'L2' }),
    JSON.stringify({ ts: t(13), event: 'prospect', op: 'due', kind: 'crop', id: 'L1' }),
    JSON.stringify({ ts: t(14), event: 'goal_path', kind: 'goal', ok: true, target: '小麦を取りに行く@M2', later: { id: 'L1', kind: 'crop' } }),
    JSON.stringify({ ts: t(15), event: 'prospect', op: 'done', how: 'harvested', kind: 'crop', id: 'L1', afterDue: true, overdueMin: 6, sinceStartMin: 31 }),
    JSON.stringify({ ts: t(16), event: 'prospect', op: 'done', how: 'taken', kind: 'smelt', id: 'L2', afterDue: false, overdueMin: null, sinceStartMin: 0.5 }),
    JSON.stringify({ ts: t(17), event: 'm_replaced', via: 'chat', original: 'M2へ', replaced: '出現地点から東に40mの所へ', n: 1 }),
    JSON.stringify({ ts: t(18), event: 'm_replaced', via: 'board', original: 'M1とM2', replaced: '…', n: 2 }),
    JSON.stringify({ ts: t(19), event: 'farmland_reverted', pos: { x: 1, y: 63, z: 0 }, nearWater: true, above: 'dirt', near: [] }),
    JSON.stringify({ ts: t(20), event: 'farmland_reverted', pos: { x: 2, y: 63, z: 0 }, nearWater: true, above: 'air', selfOnTop: false, near: [{ name: 'Ken', d: 0.5, dy: 1 }] }),
    JSON.stringify({ ts: t(21), event: 'farmland_reverted', pos: { x: 3, y: 63, z: 0 }, nearWater: true }),
  ].join('\n'));
  const out = JSON.parse(execFileSync('node', [path.join(__dirname, '..', 'tools', 'summarize_run.js'), dir], { encoding: 'utf8' }));
  const p = out.prospects;
  assert.deepStrictEqual({ added: p.added, byKind: p.byKind, merged: p.merged, due: p.due, done: p.done, collected: p.collected, after: p.collectedAfterDue, over: p.overdueMin, goals: p.laterGoals },
    { added: 2, byKind: { crop: 1, smelt: 1 }, merged: 1, due: 1, done: { harvested: 1, taken: 1 }, collected: 2, after: 1, over: { p50: 6, max: 6 }, goals: 1 });
  assert.deepStrictEqual([out.mRefs.texts, out.mRefs.refs, out.mRefs.byVia], [2, 3, { chat: 1, board: 1 }]);
  assert.deepStrictEqual([out.farm.tillBlocks, out.farm.plantBlocks, out.farm.batched], [3, 3, 2]);
  assert.deepStrictEqual(out.farm.revertedCause, { block_on_top: 1, stood_on: 1, unknown_old_record: 1 });
});

test('agent.noteProspects: 植えた・かまどに入れたまま・繁殖・子ども → 足す。作物を取った・取り出した → 済んだ (記録 prospect)', () => {
  const { Agent } = require('../src/agent');
  const rec = [];
  const self = Object.create(Agent.prototype);
  Object.assign(self, { memory: new Memory({}), recorder: { write: (r) => rec.push(r) }, bot: { entity: { position: { x: 10, y: 64, z: 0 } } } });
  self.memory.gameNow = 1000;
  self.noteProspects({ action: 'use_on', arg: 'wheat_seeds>farmland@empty' }, { ok: true, farm: { plant: 'wheat', n: 3, pos: { x: 10, y: 64, z: 0 }, wet: false } }, [], [], 5);
  self.noteProspects({ action: 'smelt', arg: 'raw_iron' }, { ok: false, smelt: { input: 'raw_iron', n: 3, took: 0, output: 'iron_ingot', at: { x: 0, y: 64, z: 0 } } }, [], [], 6);
  self.noteProspects({ action: 'use_on', arg: 'wheat>cow' }, { ok: true, bred: { animal: 'cow', adult: true, babies: 1, pos: { x: 5, y: 64, z: 5 } } }, [], [], 7);
  assert.deepStrictEqual(rec.map((r) => [r.op, r.kind]), [['add', 'crop'], ['add', 'smelt'], ['add', 'breed_again'], ['add', 'grow_up']]);
  const crop = self.memory.prospects.list.find((x) => x.kind === 'crop');
  assert.strictEqual(crop.dueMin - crop.start, 40 * TPM); // 乾いた耕地
  self.memory.gameNow = 1000 + 50 * TPM;
  self.noteProspects({ action: 'collect', arg: 'wheat' }, { ok: true }, [{ name: 'wheat', count: 1 }], [{ name: 'wheat', count: 4 }], 8);
  self.noteProspects({ action: 'furnace_take', arg: 'output' }, { ok: true, furnace: { at: { x: 0, y: 64, z: 0 }, taken: 3 } }, [], [], 9);
  assert.deepStrictEqual(rec.slice(4).map((r) => [r.op, r.kind, r.how, r.afterDue]), [['done', 'crop', 'harvested', true], ['done', 'smelt', 'taken', true]]);
  // ほかの行動 (チェストから出したなど) で増えても取ったにしない
  self.memory.prospects.add('crop', { pos: { x: 10, y: 64, z: 0 }, now: self.memory.gameNow, what: { crop: 'carrots' } });
  self.noteProspects({ action: 'chest_take', arg: 'carrot' }, { ok: true }, [], [{ name: 'carrot', count: 2 }], 10);
  assert.ok(self.memory.prospects.open().some((x) => x.what.crop === 'carrots'));
});
