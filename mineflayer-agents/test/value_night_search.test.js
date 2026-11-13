'use strict';
// 2026-11-07 ユーザー決定: 珍しさ・大事さ (scarcity.js)・探検の T と夜の外歩きの手間 (planner の costScale)・探索を倍以上 (search・explore・choice_weight)・
//   発言の M 番号 (記録・ログ・聞く/答えるの古い番号・自分の記憶の文)
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const scarcity = require('../src/scarcity');
const { Planner } = require('../src/planner');
const { selectScores, GoalPath } = require('../src/goalpath');
const search = require('../src/search');
const cw = require('../src/choice_weight');
const { Memory } = require('../src/memory');
const { Agent } = require('../src/agent');
const ask = require('../src/ask');

const cfgFile = path.join(__dirname, '..', 'configs', 'survival_3days.json');
const blk = (name, x, z, seen) => ({ name, seen, nearest: { x, y: 64, z } });

// ---- 珍しさ ----
test('Sightings: どこでも一度にたくさん見える物 (草) は a が 1 に近く、たまに少しだけ見える物 (羊) は小さい。既定の一覧は持たない', () => {
  const sg = new scarcity.Sightings({}, { k0: 24, tau: 12000 });
  for (let i = 0; i < 6; i++) sg.note({ blocks: [blk('grass', i * 20, 0, 12)], entities: [] }, 100 + i);
  sg.note({ blocks: [], entities: [{ kind: 'mob', name: 'sheep', pos: { x: 5, y: 64, z: 5 } }, { kind: 'mob', name: 'sheep', pos: { x: 6, y: 64, z: 5 } }, { kind: 'player', name: 'Ken', pos: { x: 0, y: 64, z: 0 } }] }, 106);
  const g = sg.availability('grass', 106); const s = sg.availability('sheep', 106);
  assert.ok(g.a > 0.9, `grass a=${g.a}`);
  assert.ok(s.a < 0.1, `sheep a=${s.a}`);
  assert.strictEqual(sg.availability('Ken', 106).seen, false); // 人は数えない
  assert.deepStrictEqual(sg.availability('coal_ore', 106), { a: 0, S: 0, cells: 0, ago: null, seen: false });
  // 同じマスで何度見ても S は増えない (そこに居続けても「どこにでもある」にならない)
  for (let i = 0; i < 10; i++) sg.note({ blocks: [], entities: [{ kind: 'mob', name: 'sheep', pos: { x: 5, y: 64, z: 5 } }, { kind: 'mob', name: 'sheep', pos: { x: 6, y: 64, z: 5 } }] }, 110 + i);
  assert.strictEqual(sg.availability('sheep', 120).S, 2);
  // 最後に見てから時間が経つと下がる (recencyFloor まで)
  assert.ok(sg.availability('grass', 106 + 24000).a < g.a * 0.7);
});

test('rarityFactor・itemRarity: 直接取る物は入手元の R、作る物は珍しい材料のときだけ上げる', () => {
  const c = { rho: 0.5, rhoNow: 0.5 };
  assert.strictEqual(scarcity.rarityFactor(1, false, c), 0.5);
  assert.strictEqual(scarcity.rarityFactor(0, false, c), 1.5);
  assert.strictEqual(scarcity.rarityFactor(0, true, c), 2);
  const pl = new Planner({ inventory: [], visibleBlocks: ['oak_log', 'grass', 'crafting_table'], visibleMobs: [], knownBlocks: [] }, {});
  const av = (n) => ({ a: { grass: 0.95, oak_log: 0.9, sheep: 0.05 }[n] ?? 0 });
  const seeds = scarcity.itemRarity('wheat_seeds', pl.plan('wheat_seeds', 2), av, new Set(['grass']), c);
  assert.deepStrictEqual([seeds.kind, seeds.source], ['raw', 'grass']);
  assert.ok(seeds.R < 0.6);
  const wool = scarcity.itemRarity('white_wool', pl.plan('white_wool', 1), av, new Set(), c);
  assert.ok(wool.R > 1.4 && wool.source === 'sheep');
  const bed = scarcity.itemRarity('white_bed', pl.plan('white_bed', 1), av, new Set(), c);
  assert.deepStrictEqual([bed.kind, bed.source], ['crafted', 'sheep']);
  assert.ok(bed.R > 1.4);
  const planks = scarcity.itemRarity('oak_planks', pl.plan('oak_planks', 4), av, new Set(['oak_log']), c);
  assert.strictEqual(planks.R, 1); // ありふれた材料だけの作る物は下げない
});

// ---- 大事さ ----
test('importanceWeights: ベッドの道筋の材料に羊毛 (1)、入手元が同じ羊肉 (sourceShare)。種は関係なし', () => {
  const pl = new Planner({ inventory: [], visibleBlocks: ['oak_log', 'grass', 'crafting_table'], visibleMobs: [], knownBlocks: [] }, {});
  const props = [['white_bed', 1], ['white_wool', 3], ['mutton', 2], ['wheat_seeds', 4]].map(([t, n]) => ({ kind: 'item', target: t, path: pl.plan(t, n) }));
  props.push({ kind: 'person', target: 'Ken', path: null });
  const W = scarcity.importanceWeights(props, { sourceShare: 0.5 });
  assert.strictEqual(W[1][0], 1);
  assert.strictEqual(W[2][0], 0.5);
  assert.strictEqual(W[3][0], 0);
  assert.deepStrictEqual(W[4], [0, 0, 0, 0, 0]); // 人の案には足さない
  assert.strictEqual(W[0][1], 0); // ベッドは羊毛の材料ではない
});

test('selectScores: 珍しさ・大事さで、ありふれた種より羊毛が上になる (同じ P・同じ手間)', () => {
  const needs = [{ need: 'safety', distress: 2 }, { need: 'sleep', distress: 2 }, { need: 'hunger', distress: 1 }];
  // 案: 0 ベッド・1 羊毛・2 種
  const P = [{ safety: 0.6, sleep: 0.9, hunger: 0 }, { safety: 0.2, sleep: 0.2, hunger: 0 }, { safety: 0.1, sleep: 0, hunger: 0.6 }];
  const costs = [20, 6, 3];
  const sc = { effort: { alpha: 0.04 } };
  const before = selectScores(P, needs, sc, costs);
  assert.ok(before.scores[2] > before.scores[1], JSON.stringify(before.scores));
  const value = { W: [[0, 0, 0], [1, 0, 0], [0, 0, 0]], lambda: 0.3, R: [1.45, 1.45, 0.53], S: [0.95, 0.95, 0.05] };
  const after = selectScores(P, needs, sc, costs, null, null, value);
  assert.ok(after.scores[1] > after.scores[2], JSON.stringify(after.scores));
  assert.ok(after.imp[1] > 0 && after.imp[2] === 0);
  // value なしは前と同じ
  assert.deepStrictEqual(selectScores(P, needs, sc, costs, null, null, null).scores, before.scores);
});

// ---- 手間の感じ方 ----
test('Planner costScale: まだ見ていない入手元の手間 × unseen、見えていない入手元へ出かける手間 × travel。見えている物・作るは変わらない', () => {
  const w = { inventory: [{ name: 'oak_planks', count: 4 }], visibleBlocks: ['grass'], knownBlocks: ['oak_log'] };
  const e = (scale, item, n = 1) => new Planner({ ...w, costScale: scale }, {}).effort([{ item, count: n }]);
  assert.strictEqual(e({ unseen: 0.5 }, 'mutton'), e({}, 'mutton') / 2);
  assert.strictEqual(e({ travel: 2 }, 'mutton'), e({}, 'mutton') * 2);
  assert.strictEqual(e({ travel: 2 }, 'oak_log'), e({}, 'oak_log') * 2); // 前に見た
  assert.strictEqual(e({ travel: 2, unseen: 0.5 }, 'wheat_seeds'), e({}, 'wheat_seeds')); // 見えている草
  assert.strictEqual(e({ travel: 2 }, 'crafting_table'), e({}, 'crafting_table')); // 手元の板で作る
});

test('GoalPath.costScale: 探検の T でまだ見ていない手間が下がり、夜の危なさの見込みで出かける手間が上がる。人・場所の手間も × travel', () => {
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  const gp = new GoalPath({ cfg: cfg.goalPath, llm: { complete: async () => ({ text: '{}' }) } });
  const ef = cfg.goalPath.select.effort;
  assert.deepStrictEqual(gp.costScale({ division: { T: { exploring: 0.5 } }, nightRisk: 0 }), { unseen: 1 - ef.unseenT * 0.5, travel: 1 });
  assert.deepStrictEqual(gp.costScale({ nightRisk: 0.3 }), { unseen: 1, travel: Math.round((1 + ef.nightTravel * 0.3) * 1000) / 1000 });
  const raw = { self: { pos: { x: 0, y: 64, z: 0 } }, entities: [{ kind: 'player', name: 'Ken', pos: { x: 16, y: 64, z: 0 }, d: 16 }], blocks: [], inventory: [] };
  const day = gp.moveCost({ raw, nightRisk: 0 }, { kind: 'person', target: 'Ken' });
  const night = gp.moveCost({ raw, nightRisk: 0.5 }, { kind: 'person', target: 'Ken' });
  assert.ok(Math.abs(night - day * (1 + ef.nightTravel * 0.5)) < 1e-9);
});

test('GoalPath.valueOf: 案の道筋から珍しさ R・探す要る度合い S・大事さの重み W を作る (select.value.enabled のときだけ)', () => {
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  const gp = new GoalPath({ cfg: cfg.goalPath, llm: { complete: async () => ({ text: '{}' }) } });
  const pl = new Planner({ inventory: [], visibleBlocks: ['oak_log', 'grass', 'crafting_table'] }, {});
  const sg = new scarcity.Sightings({}, cfg.goalPath.select.value);
  for (let i = 0; i < 8; i++) sg.note({ blocks: [blk('grass', i * 20, 0, 12), blk('oak_log', i * 20, 5, 12)], entities: [] }, i);
  const valid = ['white_bed', 'white_wool', 'wheat_seeds'].map((t) => ({ pg: { kind: 'item', target: t }, path: pl.plan(t, 1) }));
  const raw = { blocks: [{ name: 'grass' }, { name: 'oak_log' }], entities: [] };
  const v = gp.valueOf({ raw, sightings: sg, gameNow: 8 }, valid);
  assert.ok(v.R[1] > 1.4 && v.R[2] < 0.6, JSON.stringify(v.R));
  assert.ok(v.S[1] > 0.9 && v.S[2] < 0.1);
  assert.strictEqual(v.W[1][0], 1);
  assert.deepStrictEqual(v.record.usedBy[1], ['white_bed']);
  const off = new GoalPath({ cfg: { ...cfg.goalPath, select: { ...cfg.goalPath.select, value: { enabled: false } } }, llm: { complete: async () => ({ text: '{}' }) } });
  assert.strictEqual(off.valueOf({ raw, sightings: sg }, valid), null);
});

// ---- 探索を倍以上 ----
test('survival_3days: search 50〜160m・explore 遠く 160m・でたらめ 120m・時間切れ 150 秒・よく行った範囲を下げる', () => {
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  const s = cfg.act.search;
  assert.deepStrictEqual([s.minDist, s.maxDist], [50, 160]);
  assert.strictEqual(search.searchDistance(0.5, s), 105);
  assert.ok(s.outward > 0);
  assert.ok(cfg.act.explore.far >= 160 && cfg.act.explore.randomMax >= 120);
  assert.ok(cfg.act.timeouts.search >= 150000 && cfg.act.timeouts.explore >= 150000);
  assert.ok(cfg.choiceWeights.visited < 1);
});

test('directionScores outward: よく行った範囲 (踏破の重心) から外へ向かう方角が上がり、内へ向かう方角が下がる', () => {
  // 出現地点のまわり (0,0 付近の 3x3 マス) をよく歩いた人が、重心の東 40m にいる
  const cells = [];
  for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) cells.push({ cx, cz, n: 10 });
  const here = { x: 40, y: 64, z: 8 };
  const base = { cells, cellSize: 16, dist: 80, name: 'X', jitter: 0 };
  const off = search.directionScores(here, { ...base, outward: 0 });
  const on = search.directionScores(here, { ...base, outward: 0.3 });
  const sc = (arr, d) => arr.find((x) => x.dir === d);
  assert.ok(sc(on, 'east').score > sc(off, 'east').score);
  assert.ok(sc(on, 'west').score < sc(off, 'west').score);
  assert.ok(sc(on, 'east').outward > 0.9 && sc(on, 'west').outward < -0.9);
  // 重心の上にいるときは足さない
  const atHome = search.directionScores({ x: 8, y: 64, z: 8 }, { ...base, outward: 0.3 });
  assert.ok(atHome.every((x) => x.outward === 0));
});

test('choiceWeights visited: よく行ったマスだけを通る explore の方角を下げ、まだ行っていない方角・でたらめは下げない', () => {
  const cells = [{ cx: -1, cz: 0, n: 5 }, { cx: -2, cz: 0, n: 3 }, { cx: -3, cz: 0, n: 2 }];
  const actions = [{ name: 'explore', choices: [
    { id: 'west_far', vec: [-1, 0], dist: 48 }, { id: 'east_far', vec: [1, 0], dist: 48 }, { id: 'random', kind: 'random' }] }];
  const w = cw.choiceWeights(actions, { here: { x: 8, z: 8 }, cells, cellSize: 16 }, { enabled: true, visited: 0.5 });
  assert.strictEqual(w['explore:west_far'], 0.5);
  assert.strictEqual(w['explore:east_far'], undefined);
  assert.strictEqual(w['explore:random'], undefined);
  assert.deepStrictEqual(cw.choiceWeights(actions, { here: { x: 8, z: 8 }, cells, cellSize: 16 }, { enabled: true }), {}); // visited 1 (既定) で下げない
});

// ---- 発言の M 番号 ----
function fakeAgent(over = {}) {
  const sent = []; const rec = [];
  const self = Object.create(Agent.prototype);
  Object.assign(self, {
    bot: { chat: (t) => sent.push(t) }, cfg: { loop: { chatMinIntervalMs: 0 }, persona: { name: 'Taro' }, ask: { waitMs: 20 } }, lastChat: { t: 0, text: '' },
    memory: new Memory({ origin: { x: 0, y: 64, z: 0 } }), social: { onSpoke: () => {}, onIgnored: () => {}, onAsked: () => {} }, recorder: { write: (r) => rec.push(r) },
    lastMemPlaces: [{ id: 'M1', pos: { x: 0, y: 64, z: 60 } }], askedAt: {}, stopped: false, help: {}, cfgGoal: {}, ...over,
  });
  return { self, sent, rec };
}

test('聞く: 困りごとの M 番号は、その失敗をしたときの場所 (出来事の mpos) で置き換え、記録の question も送った文 (元の文は questionRaw)', async () => {
  const { self, sent, rec } = fakeAgent();
  // 失敗したとき M1 は北に 60m の所。今の一覧の M1 は南に 60m (番号は判断ごとに付け直す)
  const ev = self.memory.noteEvent('go_to', 'M1', false, '時間切れ');
  ev.mpos = { M1: { x: 0, y: 64, z: -60 } };
  self.memory.noteEvent('go_to', 'M1', false, '時間切れ').mpos = { M1: { x: 0, y: 64, z: -60 } };
  await self.doAsk({ player: 'Ken', trouble: { key: 'go_to:M1', kind: 'fail', about: ask.aboutText('go_to:M1'), lastMsg: '時間切れ' } });
  assert.match(sent[0], /^Kenさん、教えて: 出現地点から北に60mの所への行き方が分からない/);
  const a = rec.find((r) => r.event === 'ask');
  assert.strictEqual(a.question, sent[0]);
  assert.match(a.questionRaw, /M1への行き方/);
});

test('答える: 思い出した出来事の M 番号は、その出来事のときの場所で置き換える。記録の answer は送った文 (元の文は answerRaw)', async () => {
  const { self, sent, rec } = fakeAgent();
  self.memory.noteEvent('go_to', 'M2', true, 'jungle_logの所に着いた').mpos = { M2: { x: 40, y: 64, z: 0 } };
  self.questionQueue = [{ from: 'Ken', question: '出現地点から東に40mの所への行き方が分からない', t: Date.now() }];
  self.talker = { answer: async () => ({ say: 'M2で取れたよ', promptChars: 1, promptTokens: 1, ms: 1, error: null, rawOutput: '' }) };
  self.help = { hints: false };
  self.knowledge = null;
  await self.answerQueued();
  assert.strictEqual(sent[0], 'Kenさん、答え: 出現地点から東に40mの所で取れたよ');
  const a = rec.find((r) => r.event === 'answer');
  assert.strictEqual(a.answer, '出現地点から東に40mの所で取れたよ');
  assert.strictEqual(a.answerRaw, 'M2で取れたよ');
});

test('talk: 記録の say とログは送った文 (置き換えたあと)、元の文は sayRaw', async () => {
  const logs = [];
  const { self, sent, rec } = fakeAgent({ talking: false, log: (s) => logs.push(s), cfg: { loop: { chatMinIntervalMs: 0 }, persona: { name: 'Kaori' }, talk: { threshold: 0.6 } } });
  self.social.temperament = { sociability: 0.5 };
  self.talker = { talk: async () => ({ say: 'M1へ向かいます。原木を探しましょう。', rawOutput: '', promptChars: 1, promptTokens: 1, ms: 1, error: null }) };
  self.talkCtx = () => ({});
  self.maybeTalk({}, { jev: { talkP: 0.9 } }, 'go_to(M1)');
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(sent[0], '出現地点から南に60mの所へ向かいます。原木を探しましょう。');
  const t = rec.find((r) => r.event === 'talk');
  assert.strictEqual(t.say, sent[0]);
  assert.strictEqual(t.sayRaw, 'M1へ向かいます。原木を探しましょう。');
  assert.ok(logs.some((l) => l.includes('出現地点から南に60mの所へ向かいます')) && !logs.some((l) => /M1へ/.test(l)));
});

test('say の行動: 送った文 (置き換えたあと) を結果の文と said に', async () => {
  const { handlers } = require('../src/act');
  const r = await handlers.say({}, {}, { arg: 'M1に来て', chat: () => '出現地点から南に60mの所に来て' });
  assert.strictEqual(r.said, '出現地点から南に60mの所に来て');
  assert.match(r.msg, /出現地点から南に60m/);
});

test('自分の記憶の文: 出来事の M 番号を今の一覧の同じ場所の番号に付け直し、無ければ共通の呼び方にする', () => {
  const m = new Memory({ origin: { x: 0, y: 64, z: 0 } });
  const e1 = m.noteEvent('go_to', 'M1', true, 'jungle_logの所に着いた'); e1.mpos = { M1: { x: 40, y: 64, z: 0 } };
  const e2 = m.noteEvent('go_to', 'M3', false, '時間切れ'); e2.mpos = { M3: { x: 0, y: 64, z: -80 } };
  const now = [{ id: 'M2', pos: { x: 40, y: 64, z: 0 } }];
  assert.strictEqual(m.relabelM('go_to(M1)→成功', e1, now), 'go_to(M2)→成功');
  assert.strictEqual(m.relabelM('go_to(M3)→失敗', e2, now), 'go_to((出現地点から北に80mの所))→失敗');
  assert.strictEqual(m.relabelM('go to M3: failed', e2, now, 'en'), 'go to (80m north of the spawn point): failed');
  assert.strictEqual(m.relabelM('go_to(M4)', { mpos: null }, now), 'go_to(M4)');
});
