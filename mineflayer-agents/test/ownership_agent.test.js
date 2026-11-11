'use strict';
// 所有のつなぎ (src/ownership_agent.js): 台帳への記録・天然と誤認/誤って壊した の ground truth・行動の前の意図の記録・
//   部分的な知識 (自分で置いた・見た・聞いた)・社会的な結果 (目撃・後で気づいた・説明・返却・噂)・許可のやりとり・planner への見方
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Vec3 } = require('vec3');
const { OwnershipCtl } = require('../src/ownership_agent');
const { Memory } = require('../src/memory');
const { Social } = require('../src/social');
const O = require('../src/ownership');

const DIM = 'minecraft:overworld';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'own-'));

// 1つの世界 (ブロック) を何人かで共有する模擬
function world() { return new Map(); }
function mkBot(name, blocks, { pos = new Vec3(0.5, 64, 0.5), held = null } = {}) {
  const chat = [];
  const bot = {
    username: name, chat: (t) => chat.push(t), _chat: chat,
    game: { dimension: 'overworld' },
    entity: { position: pos, height: 1.62 },
    heldItem: held ? { name: held } : null,
    entities: {}, players: {},
    registry: { blocksByName: { torch: { id: 1 }, oak_log: { id: 2 } } },
    blockAt: (p) => {
      if (typeof p.floored !== 'function') throw new Error('mineflayer の blockAt は Vec3 が要る');
      const n = blocks.get(`${p.x},${p.y},${p.z}`) || 'air';
      const v = new Vec3(p.x, p.y, p.z);
      return { name: n, position: v, boundingBox: /air|torch/.test(n) ? 'empty' : 'block', getProperties: () => (n.endsWith('_bed') ? { part: blocks.get(`part:${p.x},${p.y},${p.z}`) || 'foot', occupied: 'false' } : {}) };
    },
    findBlocks: ({ matching }) => [...blocks.entries()].filter(([k, n]) => !k.startsWith('part:') && (typeof matching === 'number' ? matching === (bot.registry.blocksByName[n] || {}).id : matching({ name: n }))).map(([k]) => new Vec3(...k.split(',').map(Number))),
    dig: async (b) => { blocks.delete(`${b.position.x},${b.position.y},${b.position.z}`); },
    placeBlock: async (ref, face) => { const t = ref.position.plus(face); blocks.set(`${t.x},${t.y},${t.z}`, bot.heldItem.name); },
  };
  return bot;
}
function mkAgent(name, blocks, { dir = null, prov = { actions: true, penalty: true }, temperament = {}, botOpts = {} } = {}) {
  const writes = []; const logs = [];
  const memory = new Memory({});
  const social = new Social({ temperament: { empathy: 0.5, obedience: 0.5, greed: 0.5, sociability: 0.7, ...temperament } });
  const agent = { cfg: { persona: { name }, provenance: { speech: 'template', askWaitMs: 2000, ...prov }, perception: { visionRadius: 16, hearRadius: 48 } }, memory, social,
    recorder: { write: (o) => writes.push(o) }, log: (l) => logs.push(l), talker: null, others: {}, stopped: false, goalPath: null };
  agent.bot = mkBot(name, blocks, botOpts);
  const ctl = new OwnershipCtl(agent, { recordDir: dir });
  ctl.attach(agent.bot);
  return { agent, ctl, writes, logs, bot: agent.bot };
}
const ev = (writes, e) => writes.filter((w) => w.event === e);
const rawAt = (over = {}) => ({ self: { name: 'X', pos: { x: 0, y: 64, z: 0 }, timeOfDay: 6000 }, inventory: [], blocks: [], entities: [], ...over });
const placeTorch = async (a, p) => { a.ctl.cur = { action: 'place', choice: {} }; a.bot.heldItem = { name: 'torch' }; await a.bot.placeBlock({ position: new Vec3(p[0], p[1] - 1, p[2]) }, new Vec3(0, 1, 0)); a.ctl.cur = null; };

test('置いた物: 台帳 (目的・所有) と自分の知識 (self) に入る。ベッドは頭の側も自分の物', async () => {
  const w = world();
  const m = mkAgent('Miho', w);
  await placeTorch(m, [2, 64, 0]);
  const e = m.ctl.ledger.lookup(DIM, [2, 64, 0]);
  assert.deepStrictEqual([e.block, e.placedBy, e.purpose, e.ownership.kind, e.ownership.owner], ['torch', 'Miho', 'lighting', 'personal', 'Miho']);
  assert.strictEqual(m.ctl.knowledge.classify(DIM, [2, 64, 0], 'torch').category, 'own');
  // 足場 (pillar) は abandoned
  m.ctl.cur = { action: 'pillar', choice: {} }; m.bot.heldItem = { name: 'dirt' };
  await m.bot.placeBlock({ position: new Vec3(0, 64, 0) }, new Vec3(0, 1, 0));
  assert.strictEqual(m.ctl.ledger.lookup(DIM, [0, 65, 0]).status, 'abandoned');
  // ベッド (頭の側が隣にできる)
  w.set('4,64,1', 'white_bed'); w.set('part:4,64,1', 'head');
  m.ctl.cur = { action: 'place', choice: {} }; m.bot.heldItem = { name: 'white_bed' };
  await m.bot.placeBlock({ position: new Vec3(4, 63, 0) }, new Vec3(0, 1, 0));
  assert.strictEqual(m.ctl.knowledge.classify(DIM, [4, 64, 1], 'white_bed').category, 'own');
  assert.strictEqual(m.ctl.ledger.lookup(DIM, [4, 64, 0]).purpose, 'sleeping');
  const pv = m.ctl.plannerView(rawAt({ blocks: [{ name: 'white_bed', nearest: { x: 4, y: 64, z: 0 }, positions: [] }, { name: 'oak_log', nearest: { x: 9, y: 64, z: 0 }, positions: [] }] }));
  assert.deepStrictEqual(pv.ownedPlaced, { torch: 1, white_bed: 1 }); // 足場は数えない。ベッドは1つ
  assert.deepStrictEqual(pv.naturalVisible, ['oak_log']);
  assert.deepStrictEqual(pv.placed, { white_bed: 'own' });
});

test('ほかの人の置いた物を、置かれた物と知らずに collect で掘った → ground truth の記録 mistaken_as_natural (台帳の remove に意図の id)', async () => {
  const dir = tmp();
  const w = world();
  const m = mkAgent('Miho', w, { dir });
  const y = mkAgent('Yua', w, { dir });
  m.ctl.cur = { action: 'place', choice: {} }; m.bot.heldItem = { name: 'cobblestone' };
  await m.bot.placeBlock({ position: new Vec3(3, 63, 0) }, new Vec3(0, 1, 0));
  y.ctl.cur = { action: 'collect', choice: { block: 'cobblestone' } };
  await y.bot.dig(y.bot.blockAt(new Vec3(3, 64, 0)));
  const it = ev(y.writes, 'intent')[0];
  assert.strictEqual(it.reasonCode, 'mistaken_as_natural');
  assert.strictEqual(it.perspective, 'ground_truth');
  assert.strictEqual(it.truth.placedBy, 'Miho');
  const g = y.ctl.ledger.get(DIM, [3, 64, 0]);
  assert.strictEqual(g.status, 'removed');
  assert.strictEqual(g.history[1].intentId, it.id);
  assert.match(y.logs[0], /^Yua collect\(cobblestone owner unknown\) reason=mistaken_as_natural .*ground truth/);
  // 行動とは別の掘り (go_to の途中で pathfinder が掘った) → accidental。自分の物を自分で → 記録しない
  await placeTorch(m, [6, 64, 0]);
  y.ctl.cur = { action: 'go_to', choice: {} };
  await y.bot.dig(y.bot.blockAt(new Vec3(6, 64, 0)));
  assert.strictEqual(ev(y.writes, 'intent')[1].reasonCode, 'accidental');
  await placeTorch(y, [7, 64, 0]);
  y.ctl.cur = { action: 'go_to', choice: {} };
  await y.bot.dig(y.bot.blockAt(new Vec3(7, 64, 0)));
  assert.strictEqual(ev(y.writes, 'intent').length, 2);
  // 台帳に無い人工物 (村の松明): 持ち主の無い置かれた物 (world) として記録する
  w.set('8,64,0', 'torch');
  y.ctl.cur = { action: 'go_to', choice: {} };
  await y.bot.dig(y.bot.blockAt(new Vec3(8, 64, 0)));
  assert.deepStrictEqual(ev(y.writes, 'intent')[2].truth.ownership, { kind: 'public', owner: null, world: true });
  // provenance off (知識なし) の collect は unmodeled
  const z = mkAgent('Ken', w, { dir, prov: { actions: false } });
  await placeTorch(m, [9, 64, 0]);
  z.ctl.cur = { action: 'collect', choice: {} };
  await z.bot.dig(z.bot.blockAt(new Vec3(9, 64, 0)));
  assert.strictEqual(ev(z.writes, 'intent')[0].reasonCode, 'unmodeled');
  assert.strictEqual(z.ctl.knowledge, null);
});

test('take_placed: 行動の前に意図を書き、取った結果 (take) と返す相手 (owe) を残す', async () => {
  const w = world();
  const y = mkAgent('Yua', w);
  w.set('2,64,0', 'torch');
  y.ctl.knowledge.learn(DIM, [2, 64, 0], { block: 'torch', owner: 'Miho', source: 'seen', tick: 0 });
  const info = { block: 'torch', pos: { x: 2, y: 64, z: 0 }, category: 'other', owner: 'Miho', permission: 'not_requested', alternatives: [], harm: O.functionalHarm('torch', { night: true }), socialCost: 0.5,
    reason: O.decideReason({ action: 'take_placed', category: 'other', block: 'torch', needs: { safety: 0.95 }, alternatives: [] }), weight: { w: 0.4, factors: { harm: 0.5 } } };
  const resolved = { action: 'take_placed', arg: 'torch@Miho', choice: { id: 'torch@Miho', block: 'torch', pos: info.pos, own: info } };
  const it = y.ctl.beforeAct(resolved, { ownWeightInfo: { 'take_placed:torch@Miho': info.weight } });
  assert.strictEqual(it.reasonCode, 'emergency_need');
  assert.deepStrictEqual(it.weight, { w: 0.4, factors: { harm: 0.5 } });
  assert.strictEqual(it.intendedRestitution, 'replace_after_need');
  assert.match(y.logs[0], /^Yua take_placed\(torch owned by Miho\) reason=emergency_need need=safety:0.95 alternatives=0 harm=light:14 permission=no$/);
  await y.bot.dig(y.bot.blockAt(new Vec3(2, 64, 0)));
  y.ctl.afterAct(resolved, { ok: true, msg: 'x', taken: { block: 'torch', got: 1 } });
  const order = y.writes.map((x) => x.event);
  assert.ok(order.indexOf('intent') < order.indexOf('take'));
  assert.strictEqual(ev(y.writes, 'intent').length, 1, '意図の通りの掘りは ground truth を二重に書かない');
  const tk = ev(y.writes, 'take')[0];
  assert.deepStrictEqual([tk.ok, tk.intentId, tk.reasonCode], [true, it.id, 'emergency_need']);
  assert.strictEqual(y.ctl.store.owe[0].owner, 'Miho');
  assert.strictEqual(y.ctl.knowledge.get(DIM, [2, 64, 0]).status, 'taken');
  // 返す: ふつうの give で同じ物を渡しても返したことになる
  y.ctl.cur = { action: 'give', choice: {} };
  y.ctl.afterAct({ action: 'give' }, { ok: true, gave: { to: 'Miho', item: 'torch', n: 1 } });
  assert.strictEqual(y.ctl.store.owe[0].returned, true);
  assert.strictEqual(ev(y.writes, 'ownership_amends')[0].kind, 'return');
});

test('目撃: 自分の物を取られるのを見た → 取った人への好感・信頼が下がる。後から説明されると少し戻る', () => {
  const w = world();
  const m = mkAgent('Miho', w);
  m.ctl.knowledge.learn(DIM, [2, 64, 0], { block: 'torch', owner: 'Miho', source: 'self', tick: 0 });
  m.ctl.onBlockChange({ pos: { x: 2, y: 64, z: 0 }, oldName: 'torch', newName: 'air', who: 'Yua', how: 'swing', players: [], me: { x: 0, y: 64, z: 0 } });
  const s = ev(m.writes, 'ownership_social')[0];
  assert.strictEqual(s.kind, 'witnessed');
  assert.ok(m.agent.social.relations.Yua.affinity < 50);
  assert.ok(m.agent.social.relations.Yua.trust < 0.5);
  assert.strictEqual(m.agent.social.relations.Yua.note, '前に物を取られた');
  assert.strictEqual(ev(m.writes, 'ownership_loss')[0].seenBy, 'swing');
  const after = m.agent.social.relations.Yua.affinity;
  m.ctl.onLine('Yua', O.parseLine(O.line.explain({ block: 'torch', pos: [2, 64, 0], owner: 'Miho', reasonCode: 'emergency_need' }, '借りた、ごめん')));
  assert.ok(m.agent.social.relations.Yua.affinity > after);
  assert.strictEqual(ev(m.writes, 'ownership_social')[1].kind, 'apology');
  // 返された
  const a2 = m.agent.social.relations.Yua.affinity;
  m.ctl.onLine('Yua', O.parseLine(O.line.returned({ item: 'torch', n: 1, owner: 'Miho' })));
  assert.ok(m.agent.social.relations.Yua.affinity > a2);
  assert.strictEqual(m.agent.social.relations.Yua.note, '取った物を返してくれた');
});

test('後で気づいた: 見える所の自分の物が無い → 誰か分からない損 (関係は変えず、気持ちだけ)。取った本人の説明で相手を知る (緊急なら軽い)', () => {
  const run = (reasonCode) => {
    const w = world();
    const m = mkAgent('Miho', w);
    m.ctl.knowledge.learn(DIM, [2, 64, 0], { block: 'torch', owner: 'Miho', source: 'self', tick: 0 });
    m.ctl.observe(rawAt()); // 世界に torch が無い
    assert.strictEqual(ev(m.writes, 'ownership_loss')[0].kind, 'discovered');
    assert.strictEqual(ev(m.writes, 'ownership_social')[0].who, null);
    assert.deepStrictEqual(Object.keys(m.agent.social.relations), []);
    m.ctl.onLine('Yua', O.parseLine(O.line.explain({ block: 'torch', pos: [2, 64, 0], owner: 'Miho', reasonCode }, '')));
    const s = ev(m.writes, 'ownership_social')[1];
    assert.strictEqual(s.kind, 'told');
    return m.agent.social.relations.Yua.affinity;
  };
  const em = run('emergency_need');
  const sel = run('selfish_acquisition');
  assert.ok(em < 50 && sel < em, `${sel} < ${em} < 50`);
  // 戻っていた (補修された) のを見た
  const w = world();
  const m = mkAgent('Miho', w);
  m.ctl.knowledge.learn(DIM, [2, 64, 0], { block: 'torch', owner: 'Miho', source: 'self', tick: 0 });
  m.ctl.observe(rawAt());
  w.set('2,64,0', 'torch');
  m.ctl.observe(rawAt());
  assert.strictEqual(ev(m.writes, 'ownership_loss')[1].kind, 'restored_seen');
});

test('第三者: 持ち主の分かる物を取るのを見た → 取った人への見方が下がり、持ち主が近くにいれば伝える (噂)。聞いた人も見方が下がる', () => {
  const w = world();
  const k = mkAgent('Ken', w, { temperament: { sociability: 0.8 } });
  k.ctl.knowledge.learn(DIM, [2, 64, 0], { block: 'torch', owner: 'Miho', source: 'seen', tick: 0 });
  k.ctl.onBlockChange({ pos: { x: 2, y: 64, z: 0 }, oldName: 'torch', newName: 'air', who: 'Yua', players: [], me: { x: 0, y: 64, z: 0 } });
  assert.strictEqual(ev(k.writes, 'ownership_social')[0].kind, 'third');
  assert.ok(k.agent.social.relations.Yua.trust < 0.5);
  const r = k.ctl.maybeGossip(rawAt({ entities: [{ kind: 'player', name: 'Miho', pos: { x: 3, y: 64, z: 0 }, d: 3 }] }));
  assert.deepStrictEqual(r, { taker: 'Yua', block: 'torch', owner: 'Miho', n: 1 });
  assert.strictEqual(k.ctl.maybeGossip(rawAt({ entities: [{ kind: 'player', name: 'Miho', pos: { x: 3, y: 64, z: 0 }, d: 3 }] })), null, '同じことは二度言わない');
  return new Promise((res) => setTimeout(() => {
    const line = k.bot._chat[0];
    assert.match(line, /^【噂 Yua torch Miho 1】/);
    // 持ち主 Miho: 無くなったのに気づいていた → 相手が分かる (伝聞)
    const m = mkAgent('Miho', w);
    m.ctl.knowledge.learn(DIM, [2, 64, 0], { block: 'torch', owner: 'Miho', source: 'self', tick: 0 });
    m.ctl.observe(rawAt());
    m.ctl.onLine('Ken', O.parseLine(line));
    assert.strictEqual(ev(m.writes, 'ownership_social').pop().kind, 'heard');
    assert.ok(m.agent.social.relations.Yua.affinity < 50);
    // 近くで聞いた別の人: 評判として下がる
    const a = mkAgent('Aoi', w);
    a.ctl.onLine('Ken', O.parseLine(line));
    assert.strictEqual(ev(a.writes, 'ownership_social')[0].kind, 'rumor');
    assert.strictEqual(a.agent.social.relations.Yua.note, '人の物を取ったと聞いた');
    res();
  }, 30));
});

test('置くところを見た: すぐ近くにほかの人が1人だけで、手の物が合う → その人の物と知る (seen)。合わない・2人いる → 知らない', async () => {
  const w = world();
  const y = mkAgent('Yua', w);
  const me = { x: 0, y: 64, z: 0 };
  // 自分が置いている所の知らせ (placeBlock の途中で来る) は、近くの人の物にしない
  w.set('6,63,0', 'dirt');
  y.bot.heldItem = { name: 'torch' };
  y.ctl.cur = { action: 'place', choice: {} };
  await y.bot.placeBlock({ position: new Vec3(6, 63, 0) }, new Vec3(0, 1, 0));
  assert.strictEqual(y.ctl.knowledge.get(DIM, [6, 64, 0]).source, 'self');
  y.ctl.onBlockChange({ pos: { x: 6, y: 64, z: 0 }, oldName: 'air', newName: 'torch', players: [{ name: 'Miho', pos: { x: 6, y: 64, z: 1 }, held: null }], me });
  assert.strictEqual(y.ctl.knowledge.get(DIM, [6, 64, 0]).owner, 'Yua');
  y.ctl.onBlockChange({ pos: { x: 2, y: 64, z: 0 }, oldName: 'air', newName: 'wall_torch', players: [{ name: 'Miho', pos: { x: 3, y: 64, z: 0 }, held: 'torch' }], me });
  assert.deepStrictEqual([y.ctl.knowledge.get(DIM, [2, 64, 0]).owner, y.ctl.knowledge.get(DIM, [2, 64, 0]).source], ['Miho', 'seen']);
  y.ctl.onBlockChange({ pos: { x: 4, y: 64, z: 0 }, oldName: 'air', newName: 'crafting_table', players: [{ name: 'Miho', pos: { x: 3, y: 64, z: 0 }, held: 'stick' }], me });
  assert.strictEqual(y.ctl.knowledge.get(DIM, [4, 64, 0]), null);
  y.ctl.onBlockChange({ pos: { x: 5, y: 64, z: 0 }, oldName: 'air', newName: 'oak_planks', players: [{ name: 'Miho', pos: { x: 5, y: 64, z: 1 } }, { name: 'Ken', pos: { x: 5, y: 64, z: -1 } }], me });
  assert.strictEqual(y.ctl.knowledge.get(DIM, [5, 64, 0]), null);
  // 遠すぎて見えない
  y.ctl.onBlockChange({ pos: { x: 40, y: 64, z: 0 }, oldName: 'air', newName: 'torch', players: [{ name: 'Miho', pos: { x: 41, y: 64, z: 0 }, held: 'torch' }], me });
  assert.strictEqual(y.ctl.knowledge.get(DIM, [40, 64, 0]), null);
  // 聞いた: 許可を求める行から、持ち主を知る
  y.ctl.onLine('Ken', O.parseLine(O.line.ask({ id: 'Ken-3', block: 'chest', pos: [7, 64, 0], owner: 'Aoi' }, '')));
  assert.deepStrictEqual([y.ctl.knowledge.get(DIM, [7, 64, 0]).owner, y.ctl.knowledge.get(DIM, [7, 64, 0]).source, y.ctl.knowledge.get(DIM, [7, 64, 0]).from], ['Aoi', 'heard', 'Ken']);
  // 共有のチェスト (board): public
  y.ctl.onShare({ x: 8, y: 64, z: 0 }, 'Aoi');
  assert.strictEqual(y.ctl.knowledge.classify(DIM, [8, 64, 0], 'chest').category, 'public');
});

test('許可のやりとり: 頼む → 持ち主が決定的に答える → 許可が残り、次の候補の理由は permission_granted', async () => {
  const w = world();
  w.set('2,64,0', 'torch');
  const y = mkAgent('Yua', w);
  const m = mkAgent('Miho', w, { temperament: { empathy: 0.9, obedience: 0.7, greed: 0.1 } });
  m.agent.social.rel('Yua').affinity = 70;
  y.ctl.knowledge.learn(DIM, [2, 64, 0], { block: 'torch', owner: 'Miho', source: 'seen', tick: 0 });
  const p = y.ctl.askPermission({ player: 'Miho', block: 'torch', pos: { x: 2, y: 64, z: 0 }, own: { emergency: false } });
  await new Promise((r) => setTimeout(r, 20));
  const askLine = y.bot._chat[0];
  assert.match(askLine, /^【許可\? Yua-0 torch 2,64,0 Miho】/);
  assert.match(m.ctl.onLine('Yua', O.parseLine(askLine)), /使わせて/);
  await new Promise((r) => setTimeout(r, 20));
  const ans = m.bot._chat[0];
  assert.match(ans, /^【許可 Yua-0 yes】/);
  assert.strictEqual(ev(m.writes, 'ownership_permission')[0].yes, true);
  y.ctl.onLine('Miho', O.parseLine(ans));
  const r = await p;
  assert.strictEqual(r.permission, 'granted');
  assert.strictEqual(ev(y.writes, 'ownership_ask')[0].answer, 'granted');
  const v = y.ctl.view(rawAt());
  assert.strictEqual(v.permit({ x: 2, y: 64, z: 0 }).granted, true);
  assert.ok(v.askedRecently('Miho', 'torch'));
  // 返事が無い
  const r2 = await y.ctl.askPermission({ player: 'Ken', block: 'torch', pos: { x: 2, y: 64, z: 0 }, own: {} });
  assert.strictEqual(r2.permission, 'no_answer');
  assert.ok(!r2.ok);
});

test('説明 (make_amends explain): 返す相手の記録から説明の行を送り、説明済みにする', async () => {
  const w = world();
  const y = mkAgent('Yua', w);
  y.ctl.store.owe.push({ id: 'Yua-i1', owner: 'Miho', block: 'torch', pos: [2, 64, 0], reasonCode: 'unknown_ownership', explained: false });
  const r = await y.ctl.explainTake({ player: 'Miho' });
  assert.ok(r.ok);
  assert.match(y.bot._chat[0], /^【説明 torch 2,64,0 Miho unknown_ownership】Mihoさん、torchを、誰の物か知らずに取ってしまった/);
  assert.strictEqual(y.ctl.store.owe[0].explained, true);
  assert.strictEqual(ev(y.writes, 'ownership_amends')[0].kind, 'explain');
  assert.ok(!(await y.ctl.explainTake({ player: 'Miho' })).ok);
});

test('自分で掘った物の場所は、近くに同じ物が残っていなければ記憶から消す', async () => {
  const w = world();
  w.set('2,64,0', 'torch');
  const y = mkAgent('Yua', w);
  y.agent.memory.notePlace('torch', { x: 2, y: 64, z: 0 });
  y.ctl.cur = { action: 'collect', choice: {} };
  await y.bot.dig(y.bot.blockAt(new Vec3(2, 64, 0)));
  assert.ok(!y.agent.memory.places.some((q) => q.kind === 'torch'));
  assert.strictEqual(ev(y.writes, 'place_forgotten')[0].why, 'dug_by_me');
  // 残っていれば消さない
  w.set('3,64,0', 'torch'); w.set('4,64,0', 'torch');
  y.agent.memory.notePlace('torch', { x: 3, y: 64, z: 0 });
  await y.bot.dig(y.bot.blockAt(new Vec3(3, 64, 0)));
  assert.ok(y.agent.memory.places.some((q) => q.kind === 'torch'));
});

test('provenance を全部切る (cfg.provenance: false 相当) と、bot を包まず何も書かない', async () => {
  const w = world();
  w.set('2,64,0', 'torch');
  const x = mkAgent('Ken', w, { prov: { ledger: false, actions: false } });
  assert.strictEqual(x.bot.__provenance, undefined);
  await x.bot.dig(x.bot.blockAt(new Vec3(2, 64, 0)));
  assert.deepStrictEqual(x.writes, []);
  assert.strictEqual(x.ctl.view(rawAt()), null);
  assert.strictEqual(x.ctl.plannerView(rawAt()), null);
});

test('通しの場面: 置く → 誤認で掘る・意図して取る → 持ち主が見る → 説明 → 集計 (台帳のファイルから)', async () => {
  const { provenanceStats } = require('../tools/provenance_stats');
  const dir = tmp();
  const w = world();
  const m = mkAgent('Miho', w, { dir });
  const y = mkAgent('Yua', w, { dir });
  await placeTorch(m, [2, 64, 0]);
  m.ctl.cur = { action: 'build', choice: {} }; m.bot.heldItem = { name: 'cobblestone' };
  await m.bot.placeBlock({ position: new Vec3(3, 63, 0) }, new Vec3(0, 1, 0));
  // Yua: 丸石を天然と思って掘る (誤認)。松明は Miho の物と知っていて取る
  y.ctl.cur = { action: 'collect', choice: {} };
  await y.bot.dig(y.bot.blockAt(new Vec3(3, 64, 0)));
  y.ctl.knowledge.learn(DIM, [2, 64, 0], { block: 'torch', owner: 'Miho', source: 'seen', tick: 0 });
  const raw = { self: { name: 'Yua', pos: { x: 0, y: 64, z: 0 }, timeOfDay: 6000 }, inventory: [{ name: 'coal', count: 1 }, { name: 'stick', count: 1 }], entities: [{ kind: 'player', name: 'Miho', pos: { x: 3, y: 64, z: 0 }, d: 3 }], heard: [], craft: { now: [], withTable: [] }, tableNearby: null,
    blocks: [{ name: 'torch', diggable: true, nearest: { x: 2, y: 64, z: 0, d: 2 }, positions: [{ x: 2, y: 64, z: 0, d: 2 }] }] };
  const { listActions } = require('../src/actions');
  const acts = listActions(raw, { own: y.ctl.view(raw) });
  const ch = acts.find((a) => a.name === 'take_placed').choices[0];
  const resolved = { action: 'take_placed', arg: ch.id, choice: ch };
  y.ctl.beforeAct(resolved, {});
  await y.bot.dig(y.bot.blockAt(new Vec3(2, 64, 0)));
  y.ctl.afterAct(resolved, { ok: true, taken: { block: 'torch', got: 1 } });
  m.ctl.onBlockChange({ pos: { x: 2, y: 64, z: 0 }, oldName: 'torch', newName: 'air', who: 'Yua', players: [], me: { x: 0, y: 64, z: 0 } });
  await y.ctl.explainTake({ player: 'Miho' });
  m.ctl.onLine('Yua', O.parseLine(y.bot._chat[0]));
  const all = [...y.writes.map((x) => ({ ...x, _name: 'Yua' })), ...m.writes.map((x) => ({ ...x, _name: 'Miho' })), { loop: 1, action: 'explore', result: { ok: true }, _name: 'Yua' }];
  const p = provenanceStats(all, { ledgerDir: path.join(dir, 'provenance') });
  assert.deepStrictEqual(p.byReason, { mistaken_as_natural: 1, selfish_acquisition: 1 });
  assert.deepStrictEqual(p.byTruthOwnerKind, { group: 1, personal: 1 });
  assert.strictEqual(p.restitution.explained, 1);
  assert.deepStrictEqual(p.relation.byKind, { witnessed: 1, apology: 1 });
  assert.strictEqual(p.ledger.removedByOther, 2);
  assert.strictEqual(p.knowledge.accuracy, 1);
});

test('collect の途中で、対象でない置かれた物 (道をふさぐ壁) を掘った → 誤認ではなく accidental (collect_path)', async () => {
  const w = world();
  const m = mkAgent('Miho', w);
  const y = mkAgent('Yua', w, { dir: null });
  y.ctl.ledger = m.ctl.ledger; // 同じ台帳
  m.ctl.cur = { action: 'build', choice: {} }; m.bot.heldItem = { name: 'oak_planks' };
  await m.bot.placeBlock({ position: new Vec3(3, 63, 0) }, new Vec3(0, 1, 0));
  y.ctl.cur = { action: 'collect', choice: { block: 'oak_log' } };
  await y.bot.dig(y.bot.blockAt(new Vec3(3, 64, 0)));
  const it = ev(y.writes, 'intent')[0];
  assert.strictEqual(it.reasonCode, 'accidental');
  assert.strictEqual(it.action, 'collect_path');
  assert.strictEqual(it.truth.ownership.kind, 'group');
});

test('村の物 (2026-11-11 ユーザー決定): 村人を見かけた所の近くの、所有者を知らない人工物は public (みんなの物)。天然と同じ見た目の家の原木は collect のまま、評価上は public の誤認', async () => {
  const { listActions } = require('../src/actions');
  const w = world();
  const y = mkAgent('Yua', w);
  const raw = { self: { name: 'Yua', pos: { x: 0, y: 64, z: 0 }, timeOfDay: 6000 }, inventory: [], heard: [], craft: { now: [], withTable: [] }, tableNearby: null,
    entities: [], blocks: [{ name: 'white_bed', diggable: true, nearest: { x: 3, y: 64, z: 0, d: 3 }, positions: [{ x: 3, y: 64, z: 0, d: 3 }] },
      { name: 'oak_log', diggable: true, nearest: { x: 5, y: 64, z: 0, d: 5 }, positions: [{ x: 5, y: 64, z: 0, d: 5 }] }] };
  // 村人を見る前: 所有者不明
  assert.strictEqual(y.ctl.knowledge.classify(DIM, [3, 64, 0], 'white_bed').category, 'unknown');
  y.ctl.observe({ ...raw, entities: [{ kind: 'mob', name: 'villager', pos: { x: 10, y: 64, z: 4 }, d: 10 }] });
  const c = y.ctl.knowledge.classify(DIM, [3, 64, 0], 'white_bed');
  assert.deepStrictEqual([c.category, c.owner, c.village], ['public', null, true]);
  assert.strictEqual(y.ctl.knowledge.classify(DIM, [300, 64, 0], 'white_bed').category, 'unknown'); // 村から遠い
  assert.strictEqual(y.ctl.knowledge.classify('minecraft:the_nether', [3, 64, 0], 'white_bed').category, 'unknown');
  const acts = listActions(raw, { own: y.ctl.view(raw) });
  const t = acts.find((a) => a.name === 'take_placed').choices[0];
  assert.strictEqual(t.id, 'white_bed@village');
  assert.match(t.labelEn, /part of the village; not anyone's own/);
  assert.strictEqual(t.own.source, 'village');
  assert.ok(acts.find((a) => a.name === 'collect').choices.some((x) => x.id === 'oak_log'));
  // 村の家の原木 (隣に台帳に無い人工物) を collect → 評価上は public の物を天然と誤認
  w.set('5,64,0', 'oak_log'); w.set('5,65,0', 'oak_planks'); w.set('9,64,0', 'oak_log');
  y.ctl.cur = { action: 'collect', choice: { block: 'oak_log' } };
  await y.bot.dig(y.bot.blockAt(new Vec3(5, 64, 0)));
  const it = ev(y.writes, 'intent')[0];
  assert.strictEqual(it.reasonCode, 'mistaken_as_natural');
  assert.deepStrictEqual(it.truth.ownership, { kind: 'public', owner: null, world: true });
  assert.strictEqual(it.truth.purpose, 'world_structure_natural_looking');
  // 森の原木 (隣に人工物なし) は記録しない
  await y.bot.dig(y.bot.blockAt(new Vec3(9, 64, 0)));
  assert.strictEqual(ev(y.writes, 'intent').length, 1);
  // 村の物を取る理由: 持ち主のいない public。緊急でなければ selfish_acquisition (罰の相手はいない)
  assert.strictEqual(acts.ownInfos['take_placed:white_bed@village'].reason.reasonCode, 'selfish_acquisition');
});
