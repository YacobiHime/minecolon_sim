'use strict';
// 道筋の「苗木を植える → 育つ → 切る」(planner の how: 'tree')・植えたらゴールは済んだ扱い・あとでやること (prospect の sapling)
const test = require('node:test');
const assert = require('node:assert');
const { Planner, plan, pathText, pathEn, COST, TREE, SAPLING_LOG } = require('../src/planner');
const { waitOnly, GoalPath } = require('../src/goalpath');
const { Prospects, TPM } = require('../src/prospect');
const { pathFacts } = require('../src/vocab');
const knowledge = require('../src/knowledge');
const { mockRaw } = require('./fixtures');

const ADVICE = /べき|しよう|した方が|がよい|が良い|おすすめ|大切|重要|should|must|better|recommend/i;
const SAP1 = [{ name: 'oak_sapling', count: 1 }];

test('planner: 見えている木・前に見た木があれば切る。木が見えず苗木を持っていれば「植える → 育つ → 切る」', () => {
  const c = (w) => new Planner(w).cost('oak_log');
  // 見えている木 (1) < 前に見た木 (2) < 苗木を植えて育てる < まだ見ていない木 (6)
  const vis = c({ visibleBlocks: ['oak_log', 'grass_block'], inventory: SAP1 });
  const known = c({ knownBlocks: ['oak_log'], visibleBlocks: ['grass_block'], inventory: SAP1 });
  const tree = c({ visibleBlocks: ['grass_block'], inventory: SAP1 });
  const unseen = c({});
  assert.deepStrictEqual([vis.how, known.how, tree.how, unseen.how], ['collect', 'collect', 'tree', 'collect']);
  assert.ok(vis.c < known.c && known.c < tree.c && tree.c < unseen.c, [vis.c, known.c, tree.c, unseen.c].join(' '));
  // 手間: (苗木 0 + 植える + 待つ + 植える場所 0) / 原木の数 + 切る
  assert.ok(Math.abs(tree.c - ((COST.treePlant + COST.treeWait) / TREE.oak_log.logs + COST.treeCut)) < 1e-9, String(tree.c));
  // 道筋の文 (日本語・英語)
  const p = plan('oak_log', 4, { visibleBlocks: ['grass_block'], inventory: SAP1 });
  assert.strictEqual(p.steps.length, 1);
  assert.deepStrictEqual([p.next.how, p.next.sapling, p.next.plants, p.next.growing, p.next.ground], ['tree', 'oak_sapling', 1, 0, 'grass_block']);
  assert.strictEqual(pathText(p), '道筋: oak_log 4 ← oak_sapling 1 を植える (grass_block の上・明るい所・上に空き) → 育つ (約15分) → 切る / 次: oak_sapling を grass_block に植える (明るい所・上に空き)');
  assert.deepStrictEqual(pathEn(p), { path: ['oak_log x4 <- plant 1 oak_sapling (on grass_block, in light, space above) -> grows (about 15 min) -> cut'], next: 'plant oak_sapling on grass_block (in light, space above)' });
  for (const s of [pathText(p), ...pathEn(p).path]) assert.doesNotMatch(s, ADVICE);
  // 地面が見えていなければ草の生えた土とみなす。前に見たポドゾルならそれ
  assert.match(pathText(plan('oak_log', 2, { knownBlocks: ['podzol'], inventory: SAP1 })), /前に見たpodzol の上/);
  assert.ok(new Planner({ inventory: SAP1 }).cost('oak_log').c > tree.c);
});

test('planner: 苗木を持っていなければ、見えている葉から苗木を取って植える。葉がまだ見ていない所だけなら木を探す (植える道は選ばない)', () => {
  const p = plan('oak_log', 4, { visibleBlocks: ['oak_leaves', 'grass_block'] });
  assert.deepStrictEqual(p.steps.map((s) => [s.item, s.how, s.from || s.sapling]), [['oak_sapling', 'collect', 'oak_leaves'], ['oak_log', 'tree', 'oak_sapling']]);
  assert.match(pathText(p), /^道筋: oak_sapling 1 ← oak_leaves\(見える\)、oak_log 4 ← oak_sapling 1 を植える/);
  const t = new Planner({ visibleBlocks: ['oak_leaves', 'grass_block'] }).cost('oak_log');
  assert.strictEqual(t.how, 'tree');
  assert.ok(t.c < COST.unseen, String(t.c));
  // 何も見えていない: まだ見ていない葉から苗木を取って植えるより、木を探して切る
  assert.deepStrictEqual(plan('oak_log', 4, {}).steps.map((s) => s.how), ['collect']);
  // 原木が多く要れば木の本数ぶん植える (オーク 1本で原木 5 の目安 → 12 なら 3本)
  const m = plan('oak_log', 12, { visibleBlocks: ['oak_leaves', 'grass_block'], inventory: SAP1 });
  const st = m.steps.find((s) => s.how === 'tree');
  assert.deepStrictEqual([st.plants, st.trees], [3, 3]);
  assert.strictEqual(m.steps.find((s) => s.item === 'oak_sapling').count, 2); // 持っている 1 + 葉から 2
});

test('planner: 原木から作る物 (作業台) も、木が見えなければ苗木を植える道筋になる', () => {
  const p = plan('crafting_table', 1, { visibleBlocks: ['grass_block'], inventory: [{ name: 'birch_sapling', count: 1 }] });
  assert.ok(p.ok);
  assert.deepStrictEqual(p.steps.map((s) => `${s.item}:${s.how}`), ['birch_log:tree', 'birch_planks:craft', 'crafting_table:craft']);
  assert.strictEqual(p.next.sapling, 'birch_sapling');
  // 見えている木があれば切る
  assert.strictEqual(plan('crafting_table', 1, { visibleBlocks: ['oak_log'], inventory: [{ name: 'birch_sapling', count: 1 }] }).next.how, 'collect');
});

test('planner: ダークオークは 2x2 に4本植えたときだけ育つ (4本無ければ、葉が見えていなければ植える道にしない)', () => {
  const p = plan('dark_oak_log', 8, { visibleBlocks: ['grass_block'], inventory: [{ name: 'dark_oak_sapling', count: 4 }] });
  assert.deepStrictEqual([p.next.how, p.next.plants, p.next.k], ['tree', 4, 4]);
  assert.match(pathText(p), /dark_oak_sapling 4 を2x2 で植える/);
  assert.match(pathEn(p).path[0], /plant 4 dark_oak_sapling in a 2x2/);
  assert.strictEqual(new Planner({ visibleBlocks: ['grass_block'], inventory: [{ name: 'dark_oak_sapling', count: 1 }] }).cost('dark_oak_log').how, 'collect');
  // 足りない分は見えている葉から
  const q = plan('dark_oak_log', 8, { visibleBlocks: ['grass_block', 'dark_oak_leaves'], inventory: [{ name: 'dark_oak_sapling', count: 1 }] });
  assert.deepStrictEqual(q.steps.map((s) => `${s.item}:${s.how}:${s.count}`), ['dark_oak_sapling:collect:3', 'dark_oak_log:tree:8']);
});

test('planner: 植わっている苗木があれば「育つのを待つ → 切る」。その苗木は壊して苗木を取る入手元にしない。waitOnly', () => {
  const w = { visibleBlocks: ['grass_block', 'oak_sapling'], saplings: { oak_sapling: 1 }, treePlaces: { oak_sapling: { id: 'M3' } } };
  const pl = new Planner(w);
  assert.deepStrictEqual([pl.cost('oak_log').how, pl.cost('oak_log').where], ['tree', 'growing']);
  assert.notStrictEqual(pl.cost('oak_sapling').from, 'oak_sapling');
  const p = plan('oak_log', 4, w);
  assert.strictEqual(pathText(p), '道筋: oak_log 4 ← 植わっている oak_sapling 1 (M3) → 育つのを待つ → 切る / 次: 育つのを待つ (植わっている oak_sapling 1、M3)');
  assert.strictEqual(pathEn(p).next, 'wait for it to grow (1 oak_sapling planted, M3)');
  assert.strictEqual(waitOnly(p), true);
  // 植わっている分で足りなければ、残りを植える (待つだけではない)
  const q = plan('oak_log', 8, { ...w, inventory: SAP1 });
  assert.deepStrictEqual([q.next.growing, q.next.plants], [1, 1]);
  assert.strictEqual(waitOnly(q), false);
  // 見えている木があれば、植わっている苗木を待つより切る
  assert.strictEqual(plan('oak_log', 4, { ...w, visibleBlocks: [...w.visibleBlocks, 'oak_log'] }).next.how, 'collect');
});

test('vocab: 道筋の説明に「苗木を土・草の生えた土に植えると木に育つ」/「植わっている」', () => {
  const raw = mockRaw({ inventory: SAP1, blocks: [{ name: 'grass_block', nearest: { x: 1, y: 63, z: 0, d: 1 } }], entities: [], heard: [] });
  const ex = new Planner({ visibleBlocks: ['grass_block'], inventory: SAP1 }).explain('oak_log');
  assert.strictEqual(ex.how, 'tree');
  assert.deepStrictEqual(pathFacts(ex, raw, { target: 'oak_log' }), ['oak_sapling を土・草の生えた土に植えると木に育つ']);
  assert.deepStrictEqual(pathFacts(ex, raw, { target: 'oak_log', lang: 'en' }), ['grows from oak_sapling planted on dirt or grass_block']);
  const ex2 = new Planner({ saplings: { oak_sapling: 1 } }).explain('oak_log');
  assert.deepStrictEqual(pathFacts(ex2, raw, { target: 'oak_log' }), ['oak_sapling が近くに植わっている (木に育ったら切れる)']);
});

test('Prospects: 苗木を植えた → 「M3にオークの苗木を1本植えた (約5分前。木に育つのはあと10分ほど)」→ 10分で「オークの原木を切りに行く@M3」の候補。育った・切った・無くなった', () => {
  const P3 = [{ id: 'M3', pos: { x: 20, y: 64, z: 0 } }];
  const pr = new Prospects({});
  const a = pr.add('sapling', { pos: { x: 20, y: 64, z: 0 }, now: 0, n: 1, what: { sapling: 'oak_sapling', log: SAPLING_LOG.oak_sapling } }).item;
  assert.deepStrictEqual([a.dueMin, a.dueMax, a.what.log], [10 * TPM, 20 * TPM, 'oak_log']);
  assert.strictEqual(pr.textJa(a, 5 * TPM, { places: P3 }), 'M3にオークの苗木を1本植えた (約5分前。木に育つのはあと10分ほど)');
  assert.strictEqual(pr.textEn(a, 5 * TPM, { places: P3 }), 'planted 1 oak_sapling at M3 (about 5 min ago; expected to grow into a tree in about 10 min)');
  // 近くに植えた苗木はまとめ、植えた所を全部見る
  assert.strictEqual(pr.add('sapling', { pos: { x: 22, y: 64, z: 0 }, now: 0, n: 1, what: { sapling: 'oak_sapling', log: 'oak_log' } }).merged, true);
  assert.strictEqual(a.positions.length, 2);
  assert.deepStrictEqual(pr.goalCandidates(9 * TPM, { places: P3 }), []);
  const c = pr.goalCandidates(11 * TPM, { places: P3 });
  assert.deepStrictEqual(c.map((x) => [x.name, x.desc, x.laterKind]), [['オークの原木を切りに行く@M3', 'M3、オークの苗木を植えてから約10分。木に育っている頃', 'sapling']]);
  assert.match(c[0].descEn, /^go cut the tree grown from the oak_sapling planted at M3/);
  for (const s of [c[0].desc, c[0].descEn, pr.textJa(a, 11 * TPM, { places: P3 })]) assert.doesNotMatch(s, ADVICE);
  // 見る: 苗木のまま → そのまま。1本が原木 → 育ったのを見た
  const world = new Map([['20,64,0', 'oak_sapling'], ['22,64,0', 'oak_sapling']]);
  const at = (x, y, z) => ({ name: world.get(`${x},${y},${z}`) || 'air' });
  assert.deepStrictEqual(pr.observeSaplings(at, { x: 20, y: 64, z: 3 }, 8 * TPM), []);
  assert.deepStrictEqual(pr.observeSaplings(at, { x: 100, y: 64, z: 0 }, 8 * TPM), []); // 遠い
  world.set('20,64,0', 'oak_log');
  const ev = pr.observeSaplings(at, { x: 20, y: 64, z: 3 }, 12 * TPM, 7);
  assert.deepStrictEqual(ev.map((e) => [e.op, e.count]), [['ripe_seen', 1]]);
  assert.strictEqual(pr.textJa(a, 12 * TPM, { places: P3 }), 'M3にオークの苗木を2本植えた (約10分前。木に育っているのを見た)');
  // 原木が増えた (近くで) → 切った
  const h = pr.harvested({ x: 20, y: 64, z: 2 }, { oak_log: 4 }, 13 * TPM, 8);
  assert.deepStrictEqual(h.map((e) => [e.op, e.how, e.kind]), [['done', 'harvested', 'sapling']]);
  assert.strictEqual(pr.textJa(a, 13 * TPM, { places: P3 }), 'M3にオークの苗木を2本植えた (約15分前。切った)');
  // 育つ前に原木が増えても (ほかの木を切った) 済んだにしない。植えた所が苗木でも原木でもなくなったら無くなった
  const pr2 = new Prospects({});
  const b = pr2.add('sapling', { pos: { x: 0, y: 64, z: 0 }, now: 0, what: { sapling: 'birch_sapling', log: 'birch_log' } }).item;
  assert.deepStrictEqual(pr2.harvested({ x: 0, y: 64, z: 1 }, { birch_log: 3 }, TPM), []);
  const g = pr2.observeSaplings(() => ({ name: 'air' }), { x: 0, y: 64, z: 1 }, 2 * TPM);
  assert.deepStrictEqual(g.map((e) => [e.op, e.how]), [['done', 'gone']]);
  assert.match(pr2.textJa(b, 2 * TPM, {}), /見に行ったら無くなっていた/);
  // 読み込まれていない所は何もしない
  const pr3 = new Prospects({});
  pr3.add('sapling', { pos: { x: 0, y: 64, z: 0 }, now: 0, what: { sapling: 'oak_sapling', log: 'oak_log' } });
  assert.deepStrictEqual(pr3.observeSaplings(() => null, { x: 0, y: 64, z: 1 }, 2 * TPM), []);
  assert.strictEqual(pr3.open().length, 1);
});

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
const GRASS = { name: 'grass_block', nearest: { x: 2, y: 63, z: 0, d: 2 } };

test('GoalPath: 苗木を植えて道筋の残りが「育つのを待つ」だけになったら、ゴールは済んだ扱い (planted)', async () => {
  const llm = mockLLM([
    '{"kind":"item","target":"oak_log","count":4,"why":"家を建てたい","need":"安全"}',
    '{"kind":"place","target":"北の方","why":"見てみたい","need":"好奇心"}',
  ]);
  const ev = [];
  const gp = new GoalPath({ llm, log: (e) => ev.push(e) });
  const r1 = mockRaw({ inventory: SAP1, blocks: [GRASS], entities: [], heard: [] });
  assert.strictEqual(await gp.update(gctx(r1), 1), 'goal');
  assert.strictEqual(gp.goal.target, 'oak_log');
  assert.match(gp.planText(), /oak_sapling 1 を植える \(grass_block の上・明るい所・上に空き\) → 育つ \(約15分\) → 切る/);
  // 植えた (苗木が見えている・覚えている M3) → 済んだ扱い
  const r2 = mockRaw({ inventory: [], blocks: [GRASS, { name: 'oak_sapling', seen: 1, nearest: { x: 3, y: 64, z: 0, d: 3 } }], entities: [], heard: [] });
  const places = [{ id: 'M3', kind: 'oak_sapling', pos: { x: 3, y: 64, z: 0 }, d: 3 }];
  assert.strictEqual(gp.waitingGrowth(), false);
  assert.strictEqual(await gp.update(gctx(r2, { places, placeKinds: ['oak_sapling'] }), 2), 'planted');
  assert.strictEqual(gp.history[0].result, 'planted');
  const done = ev.find((e) => e.kind === 'goal_done' && e.result === 'planted');
  assert.ok(done);
  assert.strictEqual(done.crop, 'oak_sapling');
});
