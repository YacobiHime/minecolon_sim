'use strict';
// 探しながら歩く (search.js・act.js の search)・割り込み・方角の散らし方・選択肢の重み (choice_weight.js)・動き方の集計 (tools/search_stats.js)
const test = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('events');
const { Vec3 } = require('vec3');
const search = require('../src/search');
const cw = require('../src/choice_weight');
const { handlers } = require('../src/act');
const { HOSTILE } = require('../src/observe');
const unstuck = require('../src/unstuck');
const en = require('../src/en');
const { Memory } = require('../src/memory');
const { Agent } = require('../src/agent');
const { exploreChoices } = require('../src/explore');
const { JevDecider, actionOptions } = require('../src/deciders/jev');
const { JevClient } = require('../src/jev_client');
const { movementStats, lines, near16 } = require('../tools/search_stats');

const here = { x: 8, y: 64, z: 8 };

test('searchTargets: 道筋の次に要る物が見えていなければ primary、見えていれば出さない。割り込みの名前は道筋の全部', () => {
  const path = { ok: true, next: { item: 'wheat_seeds', how: 'collect', from: 'grass', where: 'unseen' },
    steps: [{ item: 'wheat_seeds', how: 'collect', from: 'grass' }, { item: 'cobblestone', how: 'collect', from: 'stone' }, { item: 'leather', how: 'kill', from: 'cow' }, { item: 'stick', how: 'craft' }] };
  const t = search.searchTargets(path, new Set(['oak_log']));
  assert.strictEqual(t.primary, 'grass');
  assert.deepStrictEqual(t.names, ['grass', 'stone', 'cow']);
  // 次の物が見えている: ほかに見えていない物があれば、それを primary にする
  assert.strictEqual(search.searchTargets(path, new Set(['grass'])).primary, 'stone');
  // 全部見えていれば出さない
  assert.strictEqual(search.searchTargets(path, new Set(['grass', 'stone', 'cow'])), null);
  // 畑の水がまだ無い
  const farm = { ok: true, next: { how: 'farm', water: { ready: false, where: 'unknown' } }, steps: [] };
  assert.strictEqual(search.searchTargets(farm, new Set()).primary, 'water');
  assert.strictEqual(search.searchTargets({ ok: false }), null);
});

test('searchDistance: 探検の T で minDist〜maxDist', () => {
  assert.strictEqual(search.searchDistance(0, { minDist: 24, maxDist: 80 }), 24);
  assert.strictEqual(search.searchDistance(1, { minDist: 24, maxDist: 80 }), 80);
  assert.strictEqual(search.searchDistance(0.5, { minDist: 24, maxDist: 80 }), 52);
  assert.strictEqual(search.searchDistance(undefined, { minDist: 24, maxDist: 80 }), 24);
});

test('directionScores: 自分が行った方・ほかの人が行ったと分かっている方を避け、人ごとの好みでずれる', () => {
  // 東 (cx 1..3) は自分が行った、北 (cz -1..-3) はほかの人が行った (聞いた・見かけた)
  const cells = [1, 2, 3].map((cx) => ({ cx, cz: 0, n: 1, t: 1 }));
  const oc = new Map([[`0,-1`, { heard: new Set(['Ken']), seen: new Set() }], [`0,-2`, { heard: new Set(), seen: new Set(['Mai']) }], [`0,-3`, { heard: new Set(['Ken']), seen: new Set() }]]);
  const sc = search.directionScores(here, { cells, othersCells: oc, cellSize: 16, dist: 48, name: 'Taro', jitter: 0 });
  const by = Object.fromEntries(sc.map((s) => [s.dir, s]));
  assert.strictEqual(by.east.fresh, 0);
  assert.strictEqual(by.north.fresh, 0);
  assert.strictEqual(by.south.fresh, 1);
  assert.deepStrictEqual(by.north.heard, ['Ken']);
  assert.deepStrictEqual(by.north.seen, ['Mai']);
  assert.ok(!['east', 'north'].includes(sc[0].dir));
  // 何も知らないとき、名前で一番の方角が変わる (同じ所から出た人がばらける)
  const tops = new Set(['Aoi', 'Daiki', 'Emi', 'Goro', 'Hanako', 'Haruto', 'Jiro', 'Kaori', 'Ken', 'Mai'].map((n) => search.directionScores(here, { cellSize: 16, dist: 48, name: n })[0].dir));
  assert.ok(tops.size >= 4, `一番の方角の種類 ${tops.size}`);
});

test('searchAction: 方角 choices 個と「このまま進む」、文は事実だけ (評価語なし)', () => {
  const targets = { primary: 'grass', names: ['grass', 'stone'] };
  const oc = new Map([[`0,-2`, { heard: new Set(['Ken']), seen: new Set() }]]);
  const a = search.searchAction({ cfg: { enabled: true, choices: 3, jitter: 0 }, targets, here, cells: [], othersCells: oc, cellSize: 16, dist: 40, name: 'Taro' });
  assert.strictEqual(a.name, 'search');
  assert.strictEqual(a.choices.length, 3);
  assert.ok(a.choices.every((c) => c.target && c.dist === 40 && c.what === 'grass'));
  assert.match(a.choices[0].label, /^grassを探しながら.+へ歩く \(約40m・行ったことなし\)$/);
  assert.match(a.choices[0].labelEn, /^look for grass while walking \w+, a long way \(never been there\)$/);
  for (const t of [a.descEn, ...a.choices.map((c) => c.labelEn)]) assert.ok(!en.ADVICE_EN.test(t), t);
  // 北にほかの人の聞いた場所があれば、その事実を書く (choices を 8 にして北も出す)
  const all = search.searchAction({ cfg: { enabled: true, choices: 8, jitter: 0 }, targets, here, cells: [], othersCells: oc, cellSize: 16, dist: 40, name: 'Taro' });
  const north = all.choices.find((c) => c.id === 'north');
  assert.match(north.label, /Kenが言っていた場所がある/);
  assert.match(north.labelEn, /Ken spoke of a place that way/);
  // 続き
  const b = search.searchAction({ cfg: { enabled: true, choices: 2 }, targets, here, dist: 40, name: 'Taro', active: { dir: 'east', target: { x: 48, z: 8 }, what: 'grass' } });
  assert.strictEqual(b.choices[0].id, 'continue');
  assert.match(b.choices[0].label, /^このまま東へgrassを探しながら歩く \(残り約40m\)$/);
  assert.strictEqual(b.choices[0].labelEn, 'keep walking east looking for grass (a long way left)');
  // 残りが短ければ続きを出さない・無効なら null
  const c = search.searchAction({ cfg: { enabled: true, choices: 2 }, targets, here, dist: 40, name: 'Taro', active: { dir: 'east', target: { x: 12, z: 8 }, what: 'grass' } });
  assert.ok(!c.choices.some((x) => x.id === 'continue'));
  assert.strictEqual(search.searchAction({ cfg: { enabled: false }, targets, here }), null);
  assert.strictEqual(search.searchAction({ cfg: { enabled: true }, targets: null, here }), null);
});

test('pickInterrupt: 敵 → 呼ばれた → 道筋の物 → しばらく見ていなかった人 の順。歩き始めに見えていた物・最近見た人は数えない', () => {
  const hits = [{ kind: 'person', what: 'Ken', id: 'Ken', d: 5 }, { kind: 'goal', what: 'grass', id: 'block:grass', d: 9 }, { kind: 'hostile', what: 'zombie', id: 7, d: 10 }];
  assert.strictEqual(search.pickInterrupt(hits).kind, 'hostile');
  assert.strictEqual(search.pickInterrupt(hits, { ignore: new Set([7]) }).kind, 'goal');
  assert.strictEqual(search.pickInterrupt(hits, { ignore: new Set([7, 'block:grass']) }).kind, 'person');
  assert.strictEqual(search.pickInterrupt(hits, { ignore: new Set([7, 'block:grass']), known: new Set(['Ken']) }), null);
  assert.strictEqual(search.pickInterrupt(hits, { kinds: ['goal'] }).what, 'grass');
  assert.strictEqual(search.interruptText({ kind: 'called', what: 'Ken' }), 'Kenに呼ばれた');
});

test('noteOthersSeen / othersCells: 見かけた人の居たマスと聞いた場所を「ほかの人が行った」マスにする', () => {
  const m = new Memory();
  m.notePlace('iron_ore', { x: 40, y: 60, z: 8 }, { from: 'Ken' });
  search.noteOthersSeen(m, [{ name: 'Mai', pos: { x: 8, y: 64, z: -30 } }, { name: 'Taro', pos: { x: 0, y: 0, z: 0 } }], { cellSize: 16, tick: 3, me: 'Taro' });
  const oc = search.othersCells(m, 16);
  assert.deepStrictEqual([...oc.get('2,0').heard], ['Ken']);
  assert.deepStrictEqual([...oc.get('0,-2').seen], ['Mai']);
  assert.ok(!oc.has('0,0'), '自分は入れない');
  // 古いものは ttl で消える
  search.noteOthersSeen(m, [], { cellSize: 16, tick: 1000, ttl: 400 });
  assert.strictEqual(m.extra.othersSeen.length, 0);
});

test('exploreChoices: 行き先のマスにほかの人が行ったと分かっていれば事実を足し、least_explored はそのマスも数える', () => {
  const oc = new Map([['0,-1', { heard: new Set(), seen: new Set(['Mai']) }]]);
  const ch = exploreChoices(here, { mode: 'varied', cellSize: 16, othersCells: oc, extra: true, near: 12, far: 35 });
  const n = ch.find((c) => c.id === 'north_near');
  assert.strictEqual(n.label, '北へ12m 行ったことなし・Maiを見かけた');
  assert.match(n.labelEn, /; saw Mai there\)$/);
  const le = ch.find((c) => c.id === 'least_explored');
  assert.match(le.label, /^自分が行った・ほかの人が行ったと見聞きしたマスが少ない方/);
  assert.notStrictEqual(le.dir, 'north');
});

// 模擬の bot: goto は目標へ少しずつ進む (setGoal(null) で GoalChanged)
function walkBot({ entities = {}, blocks = [] } = {}) {
  const bot = new EventEmitter();
  bot.username = 'Taro';
  bot.entity = { position: new Vec3(8, 64, 8), onGround: true };
  bot.entities = entities;
  let rej = null; let timer = null;
  bot.pathfinder = {
    goto: (g) => new Promise((res, r) => {
      rej = r;
      timer = setInterval(() => {
        const p = bot.entity.position;
        const dx = g.x - p.x; const dz = g.z - p.z; const d = Math.hypot(dx, dz);
        if (d <= 3) { clearInterval(timer); res(); return; }
        bot.entity.position = new Vec3(p.x + (dx / d) * 1.5, p.y, p.z + (dz / d) * 1.5);
      }, 10);
    }),
    setGoal: (g) => { if (g === null && rej) { clearInterval(timer); const e = new Error('goal changed'); e.name = 'GoalChanged'; rej(e); rej = null; } },
    isMining: () => false, isBuilding: () => false, isMoving: () => true,
  };
  bot.clearControlStates = () => {};
  const reg = require('minecraft-data')('1.20.1');
  bot.registry = reg;
  bot.findBlocks = ({ matching }) => blocks.filter((b) => matching.includes(reg.blocksByName[b.name].id) && b.pos.distanceTo(bot.entity.position) <= 16).map((b) => b.pos);
  bot.blockAt = (p) => { const b = blocks.find((x) => x.pos.equals(p)); return b ? { name: b.name, position: b.pos } : null; };
  bot.__unstuckCfg = { ...unstuck.UNSTUCK_DEFAULTS, noProgressMs: 2000, sampleMs: 30 };
  return bot;
}

test('act search: 道筋の物が見えたら区切り、場所として覚える。歩き始めに見えていた物では止まらない', async () => {
  // 東へ 60m。x=40 に grass、x=10 (歩き始めから見える) に stone
  const bot = walkBot({ blocks: [{ name: 'grass', pos: new Vec3(40, 64, 8) }, { name: 'stone', pos: new Vec3(10, 63, 8) }] });
  const m = new Memory();
  const ch = { id: 'east', dir: 'east', target: { x: 68, z: 8 }, what: 'grass', dist: 60 };
  const r = await handlers.search(bot, ch, { memory: m, visionRadius: 16, search: { scanMs: 20 }, searchWatch: () => ({ names: new Set(['grass', 'stone']), me: 'Taro', known: new Set(), heard: () => [], blockVisible: () => true }) });
  assert.ok(r.ok, r.msg);
  assert.strictEqual(r.search.interrupt.kind, 'goal');
  assert.strictEqual(r.search.interrupt.what, 'grass');
  assert.ok(r.search.moved >= 4 && r.search.moved < 60, `moved ${r.search.moved}`);
  assert.ok(r.search.left > 8);
  assert.match(r.msg, /^grassを探して東へ\d+m進んだ 新しいマス。grassが見えた$/);
  assert.ok(m.places.some((p) => p.kind === 'grass' && p.x === 40), '見つけた grass を場所として覚えた');
  assert.match(en.resultEn({ action: 'search', arg: 'east', ok: true, msg: r.msg }), /looking for grass \(a new area\)\. saw grass$/);
});

test('act search: 敵が近くに来た・名前を呼ばれたら区切る。何も無ければ行き先まで歩く', async () => {
  const zombie = { id: 9, name: 'zombie', position: new Vec3(200, 64, 8) };
  const bot = walkBot({ entities: { 9: zombie } });
  const heard = [];
  setTimeout(() => { zombie.position = new Vec3(30, 64, 8); }, 60);
  const watch = () => ({ names: new Set(['grass']), me: 'Taro', known: new Set(), heard: () => heard, hostile: HOSTILE, hostileRadius: 12, blockVisible: () => true });
  const r = await handlers.search(bot, { dir: 'east', target: { x: 100, z: 8 }, what: 'grass', dist: 92 }, { search: { scanMs: 20 }, searchWatch: watch });
  assert.strictEqual(r.search.interrupt.kind, 'hostile');
  assert.match(r.msg, /。敵のzombieが見えた$/);
  // 呼ばれた
  const bot2 = walkBot();
  const heard2 = [];
  setTimeout(() => heard2.push({ from: 'Ken', text: 'Taro、来て (1,2,3)', d: 10 }), 50);
  const r2 = await handlers.search(bot2, { dir: 'south', target: { x: 8, z: 100 }, what: 'grass', dist: 92 }, { search: { scanMs: 20 }, searchWatch: () => ({ names: new Set(), me: 'Taro', known: new Set(), heard: () => heard2 }) });
  assert.strictEqual(r2.search.interrupt.kind, 'called');
  assert.strictEqual(r2.search.interrupt.what, 'Ken');
  // 何も無い
  const bot3 = walkBot();
  const r3 = await handlers.search(bot3, { dir: 'west', target: { x: -22, z: 8 }, what: 'grass', dist: 30 }, { search: { scanMs: 20 }, searchWatch: () => ({ names: new Set(['grass']), me: 'Taro', known: new Set(), heard: () => [] }) });
  assert.ok(r3.ok);
  assert.strictEqual(r3.search.interrupt, null);
  assert.ok(r3.search.left <= 4);
});

test('choiceWeights: go_to(人)・follow を下げ、ゴールの人・呼んだ人は下げない。道筋に関係しない M は少し下げる', () => {
  const actions = [
    { name: 'go_to', argType: 'choice', choices: [{ id: 'Ken', player: 'Ken' }, { id: 'Mai', player: 'Mai' }, { id: 'M1', kind: 'jungle_log', fromMemory: true, pos: { x: 0, y: 0, z: 0 } }, { id: 'M2', kind: 'stone', fromMemory: true, pos: { x: 50, y: 0, z: 0 } }, { id: 'water', kind: 'water' }] },
    { name: 'follow', argType: 'choice', choices: [{ id: 'Ken', player: 'Ken' }, { id: 'Mai', player: 'Mai' }] },
  ];
  const w = cw.choiceWeights(actions, { exemptPeople: new Set(['Mai']), relatedKinds: new Set(['stone']) }, { enabled: true, people: 0.4, memPlace: 0.7 });
  assert.deepStrictEqual(w, { 'go_to:Ken': 0.4, 'go_to:M1': 0.7, 'follow:Ken': 0.4 });
  // 呼んだ・頼んだ人は called (既定 1)
  assert.deepStrictEqual(cw.choiceWeights(actions, { calledPeople: new Set(['Mai']) }, { enabled: true, memPlace: 1 }), { 'go_to:Ken': 0.4, 'follow:Ken': 0.4 });
  assert.deepStrictEqual(cw.choiceWeights(actions, { calledPeople: new Set(['Mai']) }, { enabled: true, memPlace: 1, called: 0.7 }), { 'go_to:Ken': 0.4, 'go_to:Mai': 0.7, 'follow:Ken': 0.4, 'follow:Mai': 0.7 });
  // 位置がゴールの場所に近い M は下げない
  const w2 = cw.choiceWeights(actions, { relatedPos: [{ x: 1, y: 0, z: 1 }] }, { enabled: true });
  assert.ok(!('go_to:M1' in w2));
  assert.deepStrictEqual(cw.choiceWeights(actions, {}, { enabled: false }), {});
  const rw = cw.reweightMult({ a: 0.5, b: 0.3, c: 0.2 }, { a: 0.4 });
  assert.strictEqual(rw.choice, 'b');
  assert.ok(rw.changed);
  assert.ok(Math.abs(Object.values(rw.probs).reduce((x, y) => x + y, 0) - 1) < 1e-9);
});

function jevFetch(probsOf) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    const keys = Object.keys(body.questions.next_action.criteria);
    const probabilities = probsOf(keys);
    const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
    return { ok: true, status: 200, headers: new Map(), json: async () => ({ answers: { next_action: { type: 'choice', choice, confidence: probabilities[choice], probabilities } }, usage: { input_tokens: 10, output_tokens: 1 } }) };
  };
}

test('JevDecider: ctx.choiceWeights を確率に掛けて選び直し、記録に残す (noChange の重みと一緒に)', async () => {
  const actions = [
    { name: 'go_to', desc: '歩く', descEn: 'walk', argType: 'choice', choices: [{ id: 'Ken', label: 'Ken', player: 'Ken' }] },
    { name: 'collect', desc: '掘る', descEn: 'dig', argType: 'choice', choices: [{ id: 'oak_log', label: 'oak_log', block: 'oak_log' }] },
    { name: 'look_around', desc: '見回す', descEn: 'look around', argType: 'none' },
  ];
  const ctx = { persona: { name: 'Taro' }, goal: { text: '' }, actions, raw: { heard: [] }, en: {}, choiceWeights: { 'go_to:Ken': 0.4 } };
  const fetch = jevFetch((keys) => Object.fromEntries(keys.map((k) => [k, k === 'go_to:Ken' ? 0.5 : k === 'collect:oak_log' ? 0.3 : 0.2])));
  const d = new JevDecider({ client: new JevClient({ apiKey: 'k', fetch }), twoStage: false });
  const r = await d.decide(ctx);
  assert.strictEqual(`${r.action}:${r.arg}`, 'collect:oak_log');
  assert.strictEqual(r.jev.reweight.from, 'go_to:Ken');
  assert.deepStrictEqual(r.jev.reweight.choiceWeights, { 'go_to:Ken': 0.4 });
  // 下げても一番なら、そのまま
  const fetch2 = jevFetch((keys) => Object.fromEntries(keys.map((k) => [k, k === 'go_to:Ken' ? 0.9 : 0.05])));
  const r2 = await new JevDecider({ client: new JevClient({ apiKey: 'k', fetch: fetch2 }), twoStage: false }).decide(ctx);
  assert.strictEqual(`${r2.action}:${r2.arg}`, 'go_to:Ken');
  assert.strictEqual(r2.jev.reweight.changed, false);
  // 2段: 分類 go_to:* の中の対象にも掛ける
  const acts2 = [{ name: 'go_to', desc: '歩く', descEn: 'walk', argType: 'choice', choices: ['Ken', 'Mai', 'Aoi', 'Rin'].map((n) => ({ id: n, label: n, player: n })).concat([{ id: 'M1', label: 'M1', kind: 'stone', fromMemory: true }]) }, actions[2]];
  const opts = actionOptions(acts2, { twoStage: true, lang: 'en' });
  assert.ok(opts.criteria['go_to:*']);
});

test('Agent: search の候補を足し、割り込みの次の判断で寄り道/そのまま進んだを返し、重みの材料 (ゴールの人・呼んだ人・道筋の物) を作る', () => {
  const memory = new Memory();
  const self = {
    cfg: { persona: { name: 'Taro' }, perception: { visionRadius: 16 } },
    searchCfg: search.cfgOf({ enabled: true, choices: 2 }), cwCfg: cw.cfgOf({ enabled: true }),
    memory, division: { T: { exploring: 0.5 } }, searchState: null, peopleSeenAt: { Ken: 5, Mai: 1 }, calledBy: { Rin: 9, Aoi: 1 }, heardBuf: [],
    goalPath: { pathNext: () => ({ how: 'collect', from: 'grass' }), path: { ok: true, next: { item: 'wheat_seeds', how: 'collect', from: 'grass' }, steps: [{ item: 'wheat_seeds', how: 'collect', from: 'grass' }, { item: 'bread', how: 'craft', station: 'crafting_table' }] }, goal: { kind: 'item', target: 'bread', metAt: null } },
  };
  const ctx = { actions: [{ name: 'look_around', argType: 'none' }] };
  const raw = { self: { pos: here }, blocks: [{ name: 'oak_log' }], entities: [] };
  const info = Agent.prototype.addSearchAction.call(self, ctx, raw, 10);
  assert.strictEqual(info.primary, 'grass');
  assert.strictEqual(info.dist, 52);
  const sa = ctx.actions.find((a) => a.name === 'search');
  assert.strictEqual(sa.choices.length, 2);
  // 見えていれば出さない
  const ctx2 = { actions: [] };
  assert.strictEqual(Agent.prototype.addSearchAction.call(self, ctx2, { ...raw, blocks: [{ name: 'grass' }] }, 10), null);
  assert.ok(!ctx2.actions.some((a) => a.name === 'search'));
  // 割り込み → 続きの状態 → 次の判断で寄り道
  const res = { ok: true, search: { dir: 'east', target: { x: 60, z: 8 }, what: 'grass', left: 30, interrupt: { kind: 'goal', what: 'grass' } } };
  assert.strictEqual(Agent.prototype.afterSearch.call(self, { action: 'search', arg: 'east' }, res, 10), null);
  assert.ok(self.searchState.awaiting);
  const ctx3 = { actions: [] };
  const info3 = Agent.prototype.addSearchAction.call(self, ctx3, raw, 11);
  assert.ok(info3.hasContinue);
  const after = Agent.prototype.afterSearch.call(self, { action: 'collect', arg: 'grass' }, { ok: true }, 11);
  assert.deepStrictEqual(after, { interrupt: 'goal', what: 'grass', choice: 'detour', action: 'collect:grass' });
  // 続きは continueTicks のあいだ残る。そのまま進んだ
  self.searchState.awaiting = true;
  const after2 = Agent.prototype.afterSearch.call(self, { action: 'search', arg: 'continue' }, { ok: true, search: { left: 2, interrupt: null } }, 12);
  assert.strictEqual(after2.choice, 'continue');
  assert.strictEqual(self.searchState, null);
  // 見張りの材料: 最近見た人 (newPersonTicks)、歩き始めより後に聞いた声だけ
  self.heardBuf = [{ from: 'Ken', text: 'old' }];
  const w = Agent.prototype.searchWatch.call(self, { names: ['grass'] }, 12);
  assert.deepStrictEqual([...w.known].sort(), ['Ken', 'Mai']);
  self.heardBuf.push({ from: 'Ken', text: 'Taro、来て' });
  assert.deepStrictEqual(w.heard().map((h) => h.text), ['Taro、来て']);
  // 重みの材料
  const wc = Agent.prototype.weightContext.call(self, 12);
  assert.deepStrictEqual([...wc.calledPeople], ['Rin']);
  assert.deepStrictEqual([...wc.exemptPeople], []);
  for (const k of ['bread', 'wheat_seeds', 'grass', 'crafting_table']) assert.ok(wc.relatedKinds.has(k), k);
  self.goalPath.goal = { kind: 'person', target: 'Mai', metAt: null };
  assert.ok(Agent.prototype.weightContext.call(self, 12).exemptPeople.has('Mai'));
});

test('search_stats: 行動の割合・search の距離と割り込み・寄り道/そのまま・1人でいた割合・踏破したマス', () => {
  const row = (name, loop, action, arg, extra = {}) => ({ _name: name, loop, action, arg, result: { ok: true, ...(extra.result || {}) }, pos: extra.pos || { x: loop * 20, y: 64, z: 0 }, ...extra.row });
  const all = [
    row('Taro', 1, 'search', 'east', { result: { search: { moved: 30, newCell: true, interrupt: { kind: 'goal', what: 'grass' }, place: { kind: 'grass' } } }, row: { nearPeople: { n8: 0, n16: 0, n48: 1 }, searchOffer: { what: 'grass' } } }),
    row('Taro', 2, 'collect', 'grass', { row: { searchAfter: { interrupt: 'goal', choice: 'detour' }, nearPeople: { n16: 0 } } }),
    row('Taro', 3, 'go_to', 'Ken', { row: { nearPeople: { n16: 2 }, jev: { reweight: { choiceWeights: { 'go_to:Ken': 0.4 }, changed: false } } } }),
    row('Ken', 1, 'follow', 'Taro', { row: { obs: '近くの人・生き物・落ちている物: プレイヤーTaro 西7南1(7m)' } }),
  ];
  const m = movementStats(all, { names: ['Taro', 'Ken'] });
  assert.strictEqual(m.decisions, 4);
  assert.strictEqual(m.share.search.n, 1);
  assert.strictEqual(m.goToPersonPlusFollowPct, 50);
  assert.strictEqual(m.search.moved.sum, 30);
  assert.deepStrictEqual(m.search.byKind, { goal: 1 });
  assert.deepStrictEqual(m.search.found, { grass: 1 });
  assert.strictEqual(m.search.placesNoted, 1);
  assert.deepStrictEqual(m.search.after, { detour: 1 });
  assert.strictEqual(m.alonePct, 50);
  assert.strictEqual(m.perAgent.Taro.cells, 3);
  assert.strictEqual(m.reweight.byChoiceWeights, 1);
  assert.strictEqual(near16(all[3]), 1, '前の記録は観察の文から数える');
  assert.ok(lines(m).length >= 4);
});

test('isCalled: 名前が入っていて、呼ぶ・聞く・頼む・誘う形のときだけ (名前が入っているだけは数えない)', () => {
  assert.ok(cw.isCalled('Taro、来て (1,2,3)', 'Taro'));
  assert.ok(cw.isCalled('Taroさん、食料探しをご一緒しませんか？', 'Taro'));
  assert.ok(cw.isCalled('Taro、木が足りない', 'Taro'));
  assert.ok(!cw.isCalled('Taro、木集め助かる', 'Taro'));
  assert.ok(!cw.isCalled('みんな、来て', 'Taro'));
});
