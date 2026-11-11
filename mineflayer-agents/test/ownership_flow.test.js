'use strict';
// 所有の仕組みを、本物の Agent・planner・goalpath・act・others・集計・run.js の切り替えとつないで確かめる (サーバーなし・API なし)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Vec3 } = require('vec3');
const { Agent, buildContext } = require('../src/agent');
const { loadConfig } = require('../src/config');
const { Talker } = require('../src/talker');
const { UsageMeter } = require('../src/usage');
const { Planner } = require('../src/planner');
const { GoalPath } = require('../src/goalpath');
const { handlers } = require('../src/act');
const { OthersLog } = require('../src/others');
const { pathMatch } = require('../src/deciders/jev');
const { provenanceStats, lines } = require('../tools/provenance_stats');
const { provenanceOverrides } = require('../run');
const O = require('../src/ownership');

const CFG = path.join(__dirname, '..', 'configs', 'survival_3days.json');
const DIM = 'minecraft:overworld';

function makeAgent(name, dir, deps = {}, prov = {}) {
  const cfg = loadConfig(CFG, { persona: { name, temperament: { empathy: 0.8, obedience: 0.6, greed: 0.2, sociability: 0.6, bravery: 0.5 } }, memory: { file: null }, provenance: { askWaitMs: 3000, ...prov } });
  cfg.memory.file = null;
  const a = new Agent(cfg, { decider: { kind: 'none' }, recordDir: dir, log: () => {}, ...deps });
  a.bot = { username: name, entity: { position: { x: 0, y: 64, z: 0 } }, players: {}, time: { timeOfDay: 3000, day: 0 }, said: [] };
  return a;
}
function link(a, b, d = 5) {
  a.bot.players[b.bot.username] = { entity: { position: { x: d, y: 64, z: 0 } } };
  b.bot.players[a.bot.username] = { entity: { position: { x: d, y: 64, z: 0 } } };
  a.bot.chat = (t) => { a.bot.said.push(t); setImmediate(() => b.onChat(a.bot.username, t)); };
  b.bot.chat = (t) => { b.bot.said.push(t); setImmediate(() => a.onChat(b.bot.username, t)); };
}

test('survival の設定は所有の仕組みが on (survival_100 も同じ)。first_setting は台帳だけ', () => {
  for (const f of ['survival_3days.json', 'survival_100.json']) {
    const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'configs', f), 'utf8'));
    assert.deepStrictEqual([c.provenance.ledger, c.provenance.actions, c.provenance.penalty], [true, true, true], f);
  }
  const fsCfg = loadConfig(path.join(__dirname, '..', 'configs', 'first_setting.json'));
  const c = O.cfgOf(fsCfg.provenance);
  assert.deepStrictEqual([c.ledger, c.actions, c.penalty], [true, false, false]);
});

test('run.js: --provenance on|off・--ownership-penalty on|off・--ledger on|off', () => {
  assert.deepStrictEqual(provenanceOverrides({ provenance: 'off', 'ownership-penalty': 'on' }), { actions: false, penalty: true });
  assert.deepStrictEqual(provenanceOverrides({ ledger: 'off' }), { ledger: false });
  assert.strictEqual(provenanceOverrides({}), null);
  assert.throws(() => provenanceOverrides({ provenance: 'maybe' }), /on か off/);
});

test('Agent どうしの許可のやりとり: 発話は LLM (模擬) で、印は機械が読む。持ち主の答えは決定的。記録に残る', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownflow-'));
  const meter = new UsageMeter();
  const llm = { model: 'fake', complete: async () => ({ text: JSON.stringify({ say: '松明、少し借りてもいい?' }), promptTokens: 10, completionTokens: 5 }) };
  const yua = makeAgent('Yua', dir, { talker: new Talker({ llm, meter }) });
  const miho = makeAgent('Miho', dir, { talker: new Talker({ llm: { model: 'fake', complete: async () => ({ text: '{"say":"いいよ"}' }) }, meter }) });
  link(yua, miho);
  miho.social.rel('Yua').affinity = 70;
  const r = await yua.own.askPermission({ player: 'Miho', block: 'torch', pos: { x: 2, y: 64, z: 0 }, own: { emergency: false } });
  assert.strictEqual(r.permission, 'granted');
  assert.match(yua.bot.said[0], /^【許可\? Yua-0 torch 2,64,0 Miho】松明、少し借りてもいい\?$/);
  assert.match(miho.bot.said[0], /^【許可 Yua-0 yes】いいよ$/);
  // 印は近くの声 (heardBuf) から外れ、発話だけが残る
  assert.deepStrictEqual(miho.heardBuf.map((h) => h.text), ['松明、少し借りてもいい?']);
  // 聞いた人 (Miho 以外も含め) は、そこが Miho の物だと知る
  assert.strictEqual(yua.own.knowledge.get(DIM, [2, 64, 0]), null);
  assert.strictEqual(miho.own.knowledge.get(DIM, [2, 64, 0]).source, 'heard'); // 自分で置いた記録が無いので、聞いた知識
  await yua.recorder.close(); await miho.recorder.close();
  const rows = (n) => fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((f) => f.startsWith(n))), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(rows('Yua').find((x) => x.event === 'ownership_ask').via, 'llm');
  assert.strictEqual(rows('Miho').find((x) => x.event === 'ownership_permission').yes, true);
});

test('buildContext: ctx.own があれば collect から置かれた物が外れ、take_placed が出る', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownctx-'));
  const a = makeAgent('Yua', dir);
  a.own.knowledge.learn(DIM, [2, 64, 0], { block: 'oak_planks', owner: 'Miho', source: 'seen', tick: 0 });
  const raw = { self: { name: 'Yua', pos: { x: 0, y: 64, z: 0 }, timeOfDay: 6000, food: 20, health: 20 }, inventory: [], entities: [], heard: [], craft: { now: [], withTable: [] }, tableNearby: null,
    blocks: [{ name: 'oak_planks', diggable: true, notable: false, seen: 2, nearest: { x: 2, y: 64, z: 0, d: 2 }, positions: [{ x: 2, y: 64, z: 0, d: 2 }, { x: 3, y: 64, z: 5, d: 5.8 }] }] };
  const ctx = buildContext(raw, a.memory, a.cfg, { own: a.own.view(raw) });
  const take = ctx.actions.find((x) => x.name === 'take_placed');
  assert.deepStrictEqual(take.choices.map((c) => c.id), ['oak_planks@Miho', 'oak_planks@unknown']);
  assert.ok(!ctx.actions.some((x) => x.name === 'collect' && x.choices.some((c) => c.id === 'oak_planks')));
  const off = buildContext(raw, a.memory, a.cfg, {});
  assert.ok(off.actions.find((x) => x.name === 'collect').choices.some((c) => c.id === 'oak_planks'));
});

test('planner: 置かれた物は collect の入手元にしない。天然の入手元があればそちら、無ければ手間を足した「取る」(take_placed / dismantle_own)', () => {
  // 作業台: 置かれた作業台しか見えず、原木も見えない → 取る (でも作る道もある: 原木がまだ見ていない入手元)
  const onlyPlaced = new Planner({ inventory: [], visibleBlocks: [], placedBlocks: { crafting_table: 'other' } }).plan('crafting_table', 1);
  assert.ok(onlyPlaced.ok);
  assert.strictEqual(onlyPlaced.steps[0].where, 'placed');
  assert.strictEqual(onlyPlaced.steps[0].take, 'take_placed');
  assert.strictEqual(pathMatch(onlyPlaced.steps[0], 'take_placed', 'crafting_table@Miho'), 'step');
  // 原木が見える → 作る (置かれた作業台より安い)
  const withLog = new Planner({ inventory: [], visibleBlocks: ['oak_log'], placedBlocks: { crafting_table: 'other' } }).plan('crafting_table', 1);
  assert.ok(!withLog.steps.some((s) => s.where === 'placed'), JSON.stringify(withLog.steps));
  // 前の動き: 置かれた作業台が「見える」入手元 (掘る) になっていた
  const old = new Planner({ inventory: [], visibleBlocks: ['oak_log', 'crafting_table'] }).plan('crafting_table', 1);
  assert.strictEqual(old.steps[0].how, 'collect');
  assert.strictEqual(old.steps[0].where, 'visible');
  // 置かれた作業台は「使える作業台」としては数える (作業台が要るレシピ)
  const pick = new Planner({ inventory: [{ name: 'oak_planks', count: 3 }, { name: 'stick', count: 2 }], visibleBlocks: [], placedBlocks: { crafting_table: 'other' } }).plan('wooden_pickaxe', 1);
  assert.ok(!pick.steps.some((s) => s.item === 'crafting_table'), JSON.stringify(pick.steps));
  // 自分の物は dismantle_own
  const mine = new Planner({ inventory: [], visibleBlocks: [], placedBlocks: { crafting_table: 'own' } }).plan('crafting_table', 1);
  assert.strictEqual(mine.steps.find((s) => s.where === 'placed').take, 'dismantle_own');
});

test('goalpath: 物のゴールで、自分で置いて機能している物を「持っている」に数える (countPlaced)。off なら前のまま', () => {
  const gp = new GoalPath({ llm: { complete: async () => ({ text: '{}' }) } });
  const raw = { self: { pos: { x: 0, y: 64, z: 0 } }, inventory: [{ name: 'torch', count: 1 }], blocks: [], entities: [] };
  const own = (on) => ({ ownPlanner: { naturalVisible: [], placed: {}, ownedPlaced: { torch: 3 }, countPlaced: on, artifact: (k) => O.ARTIFACT.test(k) } });
  assert.strictEqual(gp.satisfiedNow({ raw, ...own(true) }, { kind: 'item', target: 'torch', count: 4 }).met, true);
  assert.match(gp.satisfiedNow({ raw, ...own(true) }, { kind: 'item', target: 'torch', count: 4 }).why, /自分で置いた物 3/);
  assert.strictEqual(gp.satisfiedNow({ raw, ...own(false) }, { kind: 'item', target: 'torch', count: 4 }).met, false);
  assert.strictEqual(gp.satisfiedNow({ raw }, { kind: 'item', target: 'torch', count: 4 }).met, false);
  // world: 覚えている場所のうち見た目で人工物の種類 (作業台) は入手元にしない
  const w = gp.world({ raw: { ...raw, blocks: [{ name: 'crafting_table', nearest: { x: 1, y: 64, z: 0 } }] }, placeKinds: ['crafting_table', 'oak_log'], ...own(true) });
  assert.deepStrictEqual(w.knownBlocks, ['oak_log']);
  assert.deepStrictEqual(w.visibleBlocks, []);
  assert.strictEqual(w.stations.crafting_table, true);
});

test('act collect: 掘っても拾えなかった (ほかの人が先に壊した・拾われた) ら失敗。死んで持ち物が減っても負の数にしない', async () => {
  const blocks = new Map([['1,64,0', 'jungle_log']]);
  let inv = [{ name: 'jungle_log', count: 5, type: 5 }];
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5), height: 1.62 }, registry: { blocksByName: { jungle_log: { id: 5 } } }, heldItem: null, entities: {},
    inventory: { items: () => inv },
    findBlocks: () => [...blocks.keys()].map((k) => new Vec3(...k.split(',').map(Number))),
    blockAt: (p) => { const name = blocks.get(`${p.x},${p.y},${p.z}`); return name ? { name, position: p, boundingBox: 'block', digTime: () => 1 } : null; },
    canDigBlock: () => true, pathfinder: { goto: async () => {}, setGoal: () => {} }, clearControlStates: () => {},
    equip: async () => {}, unequip: async () => {},
    dig: async (b) => { blocks.delete(`${b.position.x},${b.position.y},${b.position.z}`); inv = []; }, // 掘ったが、拾う前に (死んで) 持ち物を失った
  };
  const r = await handlers.collect(bot, { block: 'jungle_log' }, { collectCount: 1 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.notPicked, true);
  assert.strictEqual(r.invLost, true);
  assert.match(r.msg, /1個掘って0個拾った/);
  // 置かれた物と認識している所は掘らない
  blocks.set('2,64,0', 'jungle_log');
  inv = [];
  const r2 = await handlers.collect(bot, { block: 'jungle_log' }, { collectCount: 1, ownRecognized: () => true });
  assert.strictEqual(r2.ok, false);
  assert.ok(blocks.has('2,64,0'));
});

test('others: すぐ壊れる物 (途中の様子が無い) を誰が壊したか: 1人だけ・直前に腕を振った人・はっきり一番近い人', () => {
  const o = new OthersLog();
  const p = { x: 0, y: 64, z: 0 };
  const two = [{ name: 'Yua', pos: { x: 1.5, y: 64, z: 0.5 } }, { name: 'Ken', pos: { x: 0.5, y: 64, z: 3 } }];
  // 2人いて、どちらも腕を振っていない・近さも決め手にならない (前はここで記録が漏れた)
  assert.strictEqual(o.noteBlockGone({ pos: p, oldName: 'torch', players: [{ name: 'Yua', pos: { x: 1.5, y: 64, z: 0.5 } }, { name: 'Ken', pos: { x: -0.5, y: 64, z: 0.5 } }], me: p }), null);
  o.noteSwing('Ken');
  assert.strictEqual(o.noteBlockGone({ pos: p, oldName: 'torch', players: two, me: p }), 'Ken');
  assert.strictEqual(o.lastHow, 'swing');
  const o2 = new OthersLog();
  assert.strictEqual(o2.noteBlockGone({ pos: p, oldName: 'torch', players: two, me: p }), 'Yua');
  assert.strictEqual(o2.lastHow, 'nearest');
  assert.strictEqual(o2.noteBlockGone({ pos: p, oldName: 'torch', players: [two[0]], me: p }), 'Yua');
  assert.strictEqual(o2.lastHow, 'only');
  // 壊した直後の人の近くで拾った物は「もらった」にしない (agent.js の collect の見張り)
  assert.strictEqual(o2.brokeRecently('Yua'), true);
  assert.strictEqual(o2.brokeRecently('Ken'), false);
  assert.strictEqual(o2.brokeRecently('Yua', 4000, Date.now() + 10000), false);
});

test('provenance_stats: 意図・取得・許可・償い・関係の変化・台帳から、引き継ぎの指標を出す', () => {
  const it = (id, o) => ({ event: 'intent', id, _name: 'Yua', action: 'take_placed', perspective: 'agent', target: { block: 'torch', owner: 'Miho', ownerKind: 'personal' }, permission: 'not_requested',
    functionalHarm: O.functionalHarm('torch', { night: true }), truth: { placedBy: 'Miho', ownership: { kind: 'personal', owner: 'Miho' }, ownerMatches: true }, ...o });
  const step = (n) => ({ loop: n, action: 'explore', result: { ok: true }, _name: 'Yua' });
  const all = [
    ...Array.from({ length: 98 }, (_, i) => step(i + 1)),
    it('Yua-i1', { reasonCode: 'selfish_acquisition' }),
    { event: 'take', intentId: 'Yua-i1', ok: true, _name: 'Yua' },
    it('Yua-i2', { reasonCode: 'emergency_need', truthAlternatives: { available: false } }),
    { event: 'take', intentId: 'Yua-i2', ok: true, _name: 'Yua' },
    it('Yua-i3', { reasonCode: 'permission_granted', permission: 'granted' }),
    { event: 'take', intentId: 'Yua-i3', ok: true, _name: 'Yua' },
    it('Yua-i4', { reasonCode: 'selfish_acquisition' }),
    { event: 'take', intentId: 'Yua-i4', ok: false, gone: true, _name: 'Yua' },
    it('Yua-i5', { action: 'collect', perspective: 'ground_truth', reasonCode: 'mistaken_as_natural', target: { block: 'cobblestone', ownerKind: 'natural' }, functionalHarm: { score: 0 }, truth: { placedBy: 'Ken', ownership: { kind: 'personal', owner: 'Ken' } } }),
    it('Yua-i6', { action: 'dismantle_own', reasonCode: 'own_relocation' }),
    { event: 'take', intentId: 'Yua-i6', ok: true, _name: 'Yua' },
    { event: 'ownership_ask', answer: 'granted', _name: 'Yua' },
    { event: 'ownership_amends', kind: 'explain', ok: true, intentId: 'Yua-i2', _name: 'Yua' },
    { event: 'ownership_amends', kind: 'return', ok: true, intentId: 'Yua-i2', _name: 'Yua' },
    { event: 'ownership_social', kind: 'witnessed', who: 'Yua', affinity: -6, trust: -0.12, _name: 'Miho' },
    { event: 'ownership_social', kind: 'returned', who: 'Yua', affinity: 3, trust: 0.06, _name: 'Miho' },
  ];
  const p = provenanceStats(all);
  assert.strictEqual(p.decisions, 98);
  assert.strictEqual(p.placedTakes, 4); // i1・i2・i3・i5 (i4 は失敗、i6 は自分の物)
  assert.strictEqual(p.ownTakes, 1);
  assert.strictEqual(p.per1000Decisions, 40.8);
  assert.deepStrictEqual(p.byReason, { selfish_acquisition: 1, emergency_need: 1, permission_granted: 1, mistaken_as_natural: 1 });
  assert.deepStrictEqual(p.byTruthOwnerKind, { personal: 4 });
  assert.strictEqual(p.permission.takenWithoutPermission, 2);
  assert.strictEqual(p.permission.askRate, 0.333);
  assert.deepStrictEqual([p.emergency.takes, p.emergency.trulyNoAlternative, p.emergency.trulyNoAlternativeRate], [1, 1, 1]);
  assert.strictEqual(p.harm.lightLost, 3);
  assert.deepStrictEqual([p.restitution.owing, p.restitution.explained, p.restitution.returned, p.restitution.restoredRate], [2, 1, 1, 0.5]);
  assert.deepStrictEqual([p.relation.affinity, p.relation.trust], [-3, -0.06]);
  assert.deepStrictEqual([p.accidental.failedTakes, p.accidental.failWhy], [1, { already_gone: 1 }]);
  assert.deepStrictEqual([p.knowledge.attributed, p.knowledge.accuracy], [3, 1]);
  assert.ok(lines(p).length >= 6);
});

test('provenance_stats: 記録の時点で台帳が届いていなかった (world) 意図も、台帳の全部の出来事から本当の持ち主を作り直す', () => {
  const { Ledger } = require('../src/provenance');
  const l = new Ledger({ now: () => 1000 });
  l.record('Hina', { type: 'place', pos: [5, 64, 5], block: 'crafting_table', by: 'Hina', purpose: 'crafting', ownership: { kind: 'personal', owner: 'Hina' } });
  const all = [{ _name: 'Koji', event: 'intent', id: 'Koji-i1', ts: new Date(1500).toISOString(), action: 'take_placed', perspective: 'agent', reasonCode: 'unknown_ownership', permission: 'not_requested',
    target: { block: 'crafting_table', pos: { x: 5, y: 64, z: 5 }, owner: null, ownerKind: 'unknown' }, truth: { placedBy: null, ownership: { kind: 'public', owner: null, world: true } }, functionalHarm: {} },
  { _name: 'Koji', event: 'take', intentId: 'Koji-i1', ok: true }];
  const p = provenanceStats(all, { ledger: l });
  assert.strictEqual(p.truthFixedFromLedger, 1);
  assert.deepStrictEqual(p.byTruthOwnerKind, { personal: 1 });
});

test('replay_provenance:前の記録 (台帳なし) から、place の位置で台帳を作り、collect を近い置かれた物の取得と推定する', () => {
  const { replay } = require('../tools/replay_provenance');
  const st = (name, ms, o) => ({ _name: name, ts: new Date(1e12 + ms).toISOString(), loop: ms, ...o });
  const all = [
    st('Miho', 1, { action: 'place', arg: 'torch', pos: { x: 0, y: 64, z: 0 }, result: { ok: true, msg: 'torchを(2,64,0)に置いた' }, inventory: [] }),
    st('Yua', 2, { action: 'explore', arg: 'n', pos: { x: 0, y: 64, z: 0 }, result: { ok: true }, inventory: [{ name: 'stick', count: 1 }] }),
    st('Yua', 3, { action: 'collect', arg: 'torch', pos: { x: 1, y: 64, z: 0 }, timeOfDay: 14000, obs: '見えるブロック: torch 東1(1m), dirt 下1', social: { needs: { eff: { safety: 0.95, greed: 0.3 } } },
      result: { ok: true, block: 'torch', dug: 2, msg: 'torchを素手で2個掘って2個拾った' }, inventory: [{ name: 'torch', count: 2 }] }),
  ];
  const { synthetic, ledger, stat } = replay(all);
  assert.strictEqual(synthetic.length, 1); // 台帳にあるのは1個 (2個目は台帳に無い = 村の物など)
  assert.deepStrictEqual([stat.matched, stat.unmatched, stat.otherMatched], [1, 1, 1]);
  assert.strictEqual(synthetic[0].truth.placedBy, 'Miho');
  assert.strictEqual(synthetic[0].wouldBe, 'emergency_need'); // 夜・安心 0.95・掘る前は松明も石炭も持っていない
  assert.strictEqual(ledger.get(DIM, [2, 64, 0]).status, 'removed');
});
