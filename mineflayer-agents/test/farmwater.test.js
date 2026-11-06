'use strict';
// 耕地と水: 耕す候補は水から4マス以内 (同じ高さか1つ上) の耕せるマスだけ・覚えている水場を行き先に・耕地の様子の観察・道筋の水の段・
//   育つのを待つ間・聞いた話の座標の読み方・行けなかった場所・summarize_run の畑
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const fw = require('../src/farmwater');
const states = require('../src/states');
const { Planner, pathText, pathEn } = require('../src/planner');
const { moreActions, useTargets } = require('../src/actions_more');
const { listActions } = require('../src/actions');
const { summarizeObservation, observationEn } = require('../src/observe');
const { parsePlaces } = require('../src/places');
const { Memory } = require('../src/memory');
const { pathMatch } = require('../src/deciders/jev');
const { GoalPath } = require('../src/goalpath');
const { loadConfig } = require('../src/config');
const { buildContext } = require('../src/agent');
const { mockRaw } = require('./fixtures');

const blk = (name, x, y, z, d, extra = {}) => ({ name, notable: false, diggable: true, seen: 1, nearest: { x, y, z, d }, positions: [{ x, y, z, d }], ...extra });
const all = () => true;

// 平らな草地 (y=63 が grass_block、その上は空気) に、指定した所だけ別のブロック
function world(over = {}) {
  return (x, y, z) => {
    const k = `${x},${y},${z}`;
    if (k in over) return over[k] ? { name: over[k] } : null;
    if (y === 63) return { name: 'grass_block' };
    if (y < 63) return { name: 'stone' };
    return { name: 'air' };
  };
}

test('farmwater: 耕せるマスは水から水平4マス以内で、水が同じ高さか1つ上のときだけ (2段下の水では耕す所にならない)', () => {
  // 同じ高さ (y=63) の水が x=10
  const same = fw.tillSpots(world({ '10,63,0': 'water' }), { x: 8, y: 64, z: 0 }, { radius: 8 });
  assert.ok(same.spots.length > 0);
  for (const s of same.spots) assert.ok(Math.abs(s.x - 10) <= 4 && Math.abs(s.z) <= 4, JSON.stringify(s));
  // 2段下 (y=61) の水だけ → 耕す所なし (水は見つかっている)
  const low = fw.tillSpots(world({ '10,61,0': 'water' }), { x: 8, y: 64, z: 0 }, { radius: 8 });
  assert.strictEqual(low.spots.length, 0);
  assert.ok(low.water > 0);
  // 1つ上 (y=64) の水 → 耕せる
  const up = fw.tillSpots(world({ '10,64,0': 'water' }), { x: 8, y: 64, z: 0 }, { radius: 8 });
  assert.ok(up.spots.length > 0);
  // 真上が空いていない所は耕せない
  const blocked = {};
  for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) blocked[`${10 + dx},64,${dz}`] = 'oak_planks';
  blocked['10,63,0'] = 'water';
  assert.strictEqual(fw.tillSpots(world(blocked), { x: 8, y: 64, z: 0 }, { radius: 8 }).spots.length, 0);
  // 位置の並びで同じこと
  assert.strictEqual(fw.nearWaterPts({ x: 0, y: 63, z: 0 }, [{ x: 4, y: 63, z: -4 }]), true);
  assert.strictEqual(fw.nearWaterPts({ x: 0, y: 63, z: 0 }, [{ x: 5, y: 63, z: 0 }]), false);
  assert.strictEqual(fw.nearWaterPts({ x: 0, y: 63, z: 0 }, [{ x: 1, y: 61, z: 0 }]), false);
});

test('use_on: クワ・シャベルを土に使う候補は水から4マス以内だけ。耕地にクワは出さない。ほかの持ち物の use_on は変えない', () => {
  const raw = mockRaw({
    inventory: [{ name: 'wooden_hoe', count: 1 }, { name: 'wooden_shovel', count: 1 }, { name: 'bone_meal', count: 2 }, { name: 'wheat_seeds', count: 3 }],
    blocks: [
      { ...blk('grass_block', 1, 63, 0, 1.4), positions: [{ x: 1, y: 63, z: 0, d: 1.4 }, { x: 8, y: 63, z: 0, d: 8 }] },
      blk('farmland', 2, 63, 1, 2.2),
      blk('water', 11, 63, 0, 11, { notable: true }),
    ],
    entities: [],
  });
  // 見えているブロックだけから: grass_block (8,63,0) は水 (11,63,0) から3マス → farmland_spot
  const spots = fw.tillSpotsFromRaw(raw);
  assert.deepStrictEqual(spots.map((s) => [s.x, s.z]), [[8, 0]]);
  const farmTargets = [{ name: fw.SPOT, idName: fw.SPOT, pos: { x: 8, y: 63, z: 0 }, note: '水から4マス以内のgrass_block' },
    { name: fw.SPOT, idName: `${fw.SPOT}@M3`, pos: { x: 40, y: 63, z: -40 }, note: '覚えている水場 M3 の近く' }];
  const a = moreActions(raw, { farmTargets }, all).find((x) => x.name === 'use_on');
  const ids = a.choices.map((c) => c.id);
  assert.ok(ids.includes('wooden_hoe>farmland_spot'));
  assert.ok(ids.includes('wooden_hoe>farmland_spot@M3'));
  assert.ok(ids.includes('wooden_shovel>farmland_spot'));
  assert.ok(!ids.includes('wooden_hoe>grass_block'));
  assert.ok(!ids.includes('wooden_shovel>grass_block'));
  assert.ok(!ids.includes('wooden_hoe>farmland'));
  // farmland_spot はクワ・シャベルとだけ
  assert.ok(!ids.some((id) => /^(hand|bone_meal|wheat_seeds)>farmland_spot/.test(id)));
  // ほかの持ち物は今まで通り
  assert.ok(ids.includes('bone_meal>grass_block'));
  assert.ok(ids.includes('wheat_seeds>farmland'));
  const sp = a.choices.find((c) => c.id === 'wooden_hoe>farmland_spot@M3');
  assert.strictEqual(sp.till, true);
  assert.deepStrictEqual(sp.pos, { x: 40, y: 63, z: -40 });
  for (const c of a.choices) assert.doesNotMatch(c.label, /耕す|植える|とよい|べき/);
});

test('buildContext: 覚えている・聞いた水場が use_on の行き先 (farmland_spot@M) と go_to に出る。行けなかった場所は出さない', () => {
  const cfg = loadConfig(path.join(__dirname, '..', 'configs', 'survival_3days.json'), { persona: { name: 'Taro' } });
  const mem = new Memory({ limits: cfg.memory.limits });
  mem.notePlace('water', { x: 0, y: 63, z: -40 });
  mem.notePlace('water', { x: 60, y: 63, z: 0 }, { from: 'Hanako', imp: 0.6 });
  const raw = mockRaw({ inventory: [{ name: 'wooden_hoe', count: 1 }], blocks: [blk('grass_block', 1, 63, 0, 1.4)], entities: [] });
  const ctx = buildContext(raw, mem, cfg, { farm: { farmland: 0, empty: 0, emptyPos: [], cropPos: {}, till: [] } });
  const use = ctx.actions.find((a) => a.name === 'use_on');
  const spotIds = use.choices.filter((c) => /farmland_spot@M\d+$/.test(c.id)).map((c) => c.label);
  assert.strictEqual(spotIds.length, 2, JSON.stringify(spotIds));
  assert.ok(spotIds.some((l) => /Hanakoが言っていた水場/.test(l)));
  const go = ctx.actions.find((a) => a.name === 'go_to');
  assert.ok(go.choices.some((c) => c.kind === 'water'));
  // 続けて行けなかった → 印が付き、go_to・耕す行き先から外れる
  mem.noteUnreachable({ x: 0, y: 63, z: -40 });
  mem.noteUnreachable({ x: 0, y: 63, z: -40 });
  const ctx2 = buildContext(raw, mem, cfg, { farm: { farmland: 0, empty: 0, emptyPos: [], cropPos: {}, till: [] } });
  const go2 = ctx2.actions.find((a) => a.name === 'go_to');
  assert.ok(!go2.choices.some((c) => c.kind === 'water' && c.pos && c.pos.z === -40));
  const use2 = ctx2.actions.find((a) => a.name === 'use_on');
  assert.strictEqual(use2.choices.filter((c) => /farmland_spot@M\d+$/.test(c.id)).length, 1);
  // 印は unreachableTicks ループで消える
  mem.tick += 61;
  assert.ok(!mem.placesForPrompt(raw.self.pos).some((p) => p.unreachable));
});

test('memory.placesForPrompt: ensure の種類 (water) は近い順の枠から漏れても1つ入れる', () => {
  const mem = new Memory({ limits: { promptPlaces: 3 } });
  for (let i = 1; i <= 5; i++) mem.notePlace('oak_log', { x: i * 10, y: 64, z: 0 });
  mem.notePlace('water', { x: 0, y: 63, z: 90 });
  const here = { x: 0, y: 64, z: 0 };
  assert.ok(!mem.placesForPrompt(here).some((p) => p.kind === 'water'));
  const ps = mem.placesForPrompt(here, new Set(), { ensure: ['water'] });
  assert.strictEqual(ps.length, 3);
  assert.ok(ps.some((p) => p.kind === 'water'));
  assert.deepStrictEqual(ps.map((p) => p.id), ['M1', 'M2', 'M3']);
});

test('farmStatus と観察の文: 耕地の数・湿っている/乾いている・植わっている・乾いていて空き (日本語・英語)', () => {
  const over = { '0,63,0': 'water' };
  // 水の近く (湿る): (1,63,0) 植わっている、(2,63,0) 空き。遠く (乾く): (10,63,0) 空き、(11,63,0) 植わっている
  for (const x of [1, 2, 10, 11]) over[`${x},63,0`] = 'farmland';
  over['1,64,0'] = 'wheat'; over['11,64,0'] = 'wheat';
  const f = states.farmStatus(world(over), { x: 5, y: 64, z: 0 }, { radius: 8 });
  assert.deepStrictEqual({ farmland: f.farmland, wet: f.wet, dry: f.dry, planted: f.planted, dryEmpty: f.dryEmpty, empty: f.empty }, { farmland: 4, wet: 2, dry: 2, planted: 2, dryEmpty: 1, empty: 2 });
  // moisture が読めれば、それで (7 = 湿っている)
  const m = states.farmStatus((x, y, z) => (x === 0 && y === 63 && z === 0 ? { name: 'farmland', getProperties: () => ({ moisture: 3 }) } : null), { x: 0, y: 64, z: 0 });
  assert.strictEqual(m.dry, 1);
  assert.strictEqual(fw.farmText(f), '近くの耕地: 4 (湿っている 2、乾いている 2、植わっている 2、乾いていて空き 1)');
  assert.strictEqual(fw.farmTextEn(f), '4 farmland (2 moist, 2 dry, 2 planted, 1 dry and empty)');
  const raw = mockRaw({ farm: f });
  assert.match(summarizeObservation(raw), /近くの耕地: 4 \(湿っている 2/);
  assert.match(observationEn(raw).farmland, /4 farmland \(2 moist/);
  assert.ok(!('farmland' in observationEn(mockRaw())));
  assert.strictEqual(fw.farmText({ farmland: 0 }), '');
});

test('道筋の水の段: 見えていて耕せる所がある (済んだ) / 水は見えるが耕せる所がない / 覚えている (M 番号と距離) / 知らない (探す)', () => {
  const here = { x: 0, y: 64, z: 0 };
  const known = fw.waterInfo(here, { raw: { blocks: [] }, places: [{ id: 'M3', kind: 'water', pos: { x: 0, y: 63, z: -40 }, d: 40 }], ready: false });
  assert.strictEqual(fw.waterText(known), '水 (覚えている M3、北に40m)');
  assert.strictEqual(fw.waterTextEn(known), 'water (remembered M3; very far, north)');
  const heard = fw.waterInfo(here, { raw: { blocks: [] }, places: [{ id: 'M2', kind: 'water', pos: { x: 30, y: 63, z: 0 }, d: 30, from: 'Hanako' }], ready: false });
  assert.strictEqual(fw.waterText(heard), '水 (Hanakoが言っていた M2、東に30m)');
  const unknown = fw.waterInfo(here, { raw: { blocks: [] }, places: [], ready: false });
  assert.strictEqual(fw.waterText(unknown), '水を探す (まだ知らない)');
  const low = fw.waterInfo(here, { raw: { blocks: [blk('water', 5, 61, 0, 5.4)] }, ready: false });
  assert.match(fw.waterText(low), /^水 \(見えている、東に5m。水から4マス以内で高さの合う/);
  const ready = fw.waterInfo(here, { raw: { blocks: [blk('water', 5, 63, 0, 5)] }, ready: true });
  assert.ok(fw.waterCost(ready) < fw.waterCost(low));
  assert.ok(fw.waterCost(low) <= fw.waterCost(known));
  assert.ok(fw.waterCost(known) < fw.waterCost(unknown));
  // 遠いほど手間が大きい (知らないより大きくはならない)
  assert.ok(fw.waterCost({ where: 'known', d: 20 }) < fw.waterCost({ where: 'known', d: 60 }));
  assert.strictEqual(fw.waterCost({ where: 'known', d: 1000 }), fw.waterCost(unknown));

  // 状態のゴール (耕地): 済んでいれば水の段は出さない、覚えていれば「水 (覚えている M3、北に40m) → 耕す」
  const W = { inventory: [{ name: 'wooden_hoe', count: 1 }], visibleBlocks: ['water'], visibleMobs: [], knownBlocks: [], stations: {} };
  const st = { type: 'farmland' };
  const pReady = states.planState(st, 4, { ...W, water: ready }, { have: 0 });
  assert.ok(!pReady.acts.some((a) => a.how === 'water'));
  const pLow = states.planState(st, 4, { ...W, water: low }, { have: 0 });
  assert.strictEqual(pLow.next.how, 'water');
  const pKnown = states.planState(st, 4, { ...W, visibleBlocks: [], water: known }, { have: 0 });
  assert.deepStrictEqual(pKnown.acts.map((a) => states.actText(a)), ['水 (覚えている M3、北に40m)', '耕す 4 (wooden_hoe を水の近くの土に)']);
  assert.strictEqual(states.actTextEn(pKnown.acts[0]), 'water (remembered M3; very far, north)');
  const pUnknown = states.planState(st, 4, { ...W, visibleBlocks: [], water: unknown }, { have: 0 });
  assert.ok(pUnknown.effort > pKnown.effort);
  assert.ok(pKnown.effort > pReady.effort);
});

test('planner (item: wheat / bread): 耕すなら「水 (…) → 水から4マス以内の土を耕す → 植える」。済んでいれば水は出さない。手間は水場の距離で', () => {
  const base = { inventory: [], visibleBlocks: ['grass', 'jungle_log'], visibleMobs: [], knownBlocks: [], stations: {} };
  const known = { where: 'known', id: 'M3', pos: { x: 0, y: 63, z: -40 }, d: 40, dir: 6, ready: false };
  const p = new Planner({ ...base, water: known }).plan('bread', 1);
  assert.ok(p.ok);
  const farm = p.steps.find((s) => s.how === 'farm');
  assert.strictEqual(farm.water.id, 'M3');
  assert.match(pathText(p, { maxShown: 20 }), /wheat 3 ← 水 \(覚えている M3、北に40m\) → 耕す 3 \(wooden_hoe を水から4マス以内の土に\) → wheat_seeds 3 を耕地に植える/);
  assert.match([].concat(pathEn(p, { maxShown: 20 }).path).join(' / '), /water \(remembered M3; very far, north\) -> till 3/);
  // 種とクワを持っていて次が畑の段: 次の文に水が出る
  const inv = [{ name: 'wheat_seeds', count: 3 }, { name: 'wooden_hoe', count: 1 }];
  const q = new Planner({ ...base, inventory: inv, water: known }).plan('wheat', 3);
  assert.match(pathText(q), /次: 水 \(覚えている M3、北に40m\) → 水から4マス以内の土を wooden_hoe で耕す/);
  // 済んでいる (水から4マス以内の耕せるマスが近くにある) → 水の段なし
  const r = new Planner({ ...base, inventory: inv, water: { where: 'visible', ready: true } }).plan('wheat', 3);
  assert.ok(!r.steps.find((s) => s.how === 'farm').water);
  assert.doesNotMatch(pathText(r), /水 \(/);
  // 手間: 済んだ < 覚えている (近い) < 覚えている (遠い) < 知らない
  const eff = (w) => new Planner({ ...base, inventory: inv, water: w }).effort([{ item: 'wheat', count: 3 }]);
  const near = eff({ where: 'known', id: 'M1', d: 10, ready: false });
  const far = eff({ where: 'known', id: 'M1', d: 80, ready: false });
  assert.ok(eff({ where: 'visible', ready: true }) < near);
  assert.ok(near < far);
  assert.ok(far <= eff({ where: 'unknown', ready: false }));
});

test('育つのを待つ: 道筋の次は「育つのを待つ (植わっている n、M2)」、goalPath.waitingGrowth は true', () => {
  const W = { inventory: [], visibleBlocks: ['grass', 'water'], visibleMobs: [], knownBlocks: ['wheat'], stations: {}, farm: { growing: { wheat: 3 } }, cropPlaces: { wheat: { id: 'M2', d: 5 } } };
  const p = new Planner(W).plan('wheat', 3);
  assert.match(pathText(p), /次: 育つのを待つ \(植わっている wheat 3、M2\)/);
  assert.match(pathEn(p).next, /wait for it to grow \(3 wheat planted, M2\)/);
  assert.strictEqual(GoalPath.prototype.waitingGrowth.call({ path: p }), true);
  const q = new Planner({ ...W, farm: {} }).plan('wheat', 3);
  assert.strictEqual(GoalPath.prototype.waitingGrowth.call({ path: q }), false);
});

test('耕せるだけ植える: 持っている種の数まで・空いている耕地 + 水の近くの耕せるマスの数まで (要る数より多くても)', () => {
  const base = { visibleBlocks: ['grass', 'water'], visibleMobs: [], knownBlocks: [], stations: {}, water: { where: 'visible', ready: true } };
  const inv = [{ name: 'wheat_seeds', count: 7 }, { name: 'wooden_hoe', count: 1 }];
  // 種 7・耕せるマス 10・空き 0 → 7 植える (要るのは 3)
  let f = new Planner({ ...base, inventory: inv, farm: { empty: 0, tillCount: 10 } }).plan('wheat', 3).steps.find((s) => s.how === 'farm');
  assert.strictEqual(f.plants, 7); assert.strictEqual(f.till, 7);
  // 耕せるマス 4・空き 1 → 5 植える (耕す 4)
  f = new Planner({ ...base, inventory: inv, farm: { empty: 1, tillCount: 4 } }).plan('wheat', 3).steps.find((s) => s.how === 'farm');
  assert.strictEqual(f.plants, 5); assert.strictEqual(f.till, 4);
  // 植わっている 3 (要る数を満たす) でも、種があれば植える。種が無ければ待つ
  f = new Planner({ ...base, inventory: inv, farm: { growing: { wheat: 3 }, empty: 0, tillCount: 10 } }).plan('wheat', 3).steps.find((s) => s.how === 'farm');
  assert.strictEqual(f.plants, 7); assert.strictEqual(f.growing, 3);
  const w = new Planner({ ...base, inventory: [{ name: 'wooden_hoe', count: 1 }], farm: { growing: { wheat: 3 }, tillCount: 10 } }).plan('wheat', 3);
  assert.strictEqual(GoalPath.prototype.waitingGrowth.call({ path: w }), true);
  // 種が要る数より少ない → 要る数 (足りない種を手に入れる道筋)
  f = new Planner({ ...base, inventory: [{ name: 'wheat_seeds', count: 1 }, { name: 'wooden_hoe', count: 1 }], farm: { tillCount: 10 } }).plan('wheat', 3).steps.find((s) => s.how === 'farm');
  assert.strictEqual(f.plants, 3);
});

test('jev.pathMatch: 耕す段に farmland_spot のクワ、水の段に覚えている水場への go_to', () => {
  const farm = { how: 'farm', item: 'wheat', crop: 'wheat', seed: 'wheat_seeds', till: 3, plants: 3, tool: 'wooden_hoe' };
  assert.strictEqual(pathMatch(farm, 'use_on', 'wooden_hoe>farmland_spot'), 'step');
  assert.strictEqual(pathMatch(farm, 'use_on', 'wooden_hoe>farmland_spot@M3'), 'step');
  const farmW = { ...farm, water: { where: 'known', id: 'M3', ready: false } };
  assert.strictEqual(pathMatch(farmW, 'go_to', 'M3'), 'step');
  assert.strictEqual(pathMatch({ act: true, how: 'water', water: { where: 'known', id: 'M3' } }, 'go_to', 'M3'), 'step');
  assert.strictEqual(pathMatch({ act: true, how: 'water', water: { where: 'unknown' } }, 'explore', 'north'), 'step');
  assert.strictEqual(pathMatch({ act: true, how: 'till', count: 2, tool: 'wooden_hoe' }, 'use_on', 'wooden_hoe>farmland_spot'), 'step');
});

test('places.parsePlaces: 質問の中に引いた失敗の文の座標と、閉じかっこの無い (切れた) 座標は取り込まない', () => {
  const o = { x: 0, y: 64, z: 0 };
  assert.deepStrictEqual(parsePlaces('Hanakoさん、教えて: use_on(wooden_hoe>farmland)のやり方が分からない(「farmland(-330,72,7」で失敗した)', o), []);
  assert.deepStrictEqual(parsePlaces('水は (-250, 70, 13', o), []);
  assert.deepStrictEqual(parsePlaces('水は (-250, 70, 130) にあるよ', o).map((p) => p.pos), [{ x: -250, y: 70, z: 130 }]);
  assert.strictEqual(parsePlaces('出現地点から北に40mに水がある', o)[0].kind, 'water');
  // memory も同じ (聞いた話から覚えない)
  const mem = new Memory({});
  mem.origin = o;
  mem.noteHeard('Rin', 'Taroさん、教えて: go_toのやり方が分からない(「farmland(-330,72,7」で失敗した)');
  assert.strictEqual(mem.places.length, 0);
});

test('summarize_run: 畑 (耕した回数と水から4マス以内の割合・植えた・土に戻った・収穫・パン・クワを耕地に・育つのを待った)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-farm-'));
  const t = (s) => `2026-11-06T01:00:${String(s).padStart(2, '0')}.000Z`;
  let n = 0;
  const step = (action, arg, result, extra = {}) => JSON.stringify({ ts: t(++n), loop: n, action, arg, result: { ok: true, msg: 'ok', ...result }, decideMs: 100, inventory: [], ...extra });
  fs.writeFileSync(path.join(dir, 'Taro-x.jsonl'), [
    JSON.stringify({ ts: t(0), event: 'start', persona: { name: 'Taro' }, decider: 'jev', day: 0 }),
    step('use_on', 'wooden_hoe>farmland_spot', { farm: { till: true, nearWater: true } }),
    step('use_on', 'wooden_hoe>farmland_spot@M3', { farm: { till: true, nearWater: true } }),
    step('use_on', 'wooden_hoe>grass_block', { farm: { till: true, nearWater: false } }),
    step('use_on', 'wooden_hoe>farmland', { ok: false, msg: '何も起きなかった' }),
    step('use_on', 'wheat_seeds>farmland', { farm: { plant: 'wheat' } }),
    step('wait', '3', {}, { growWait: true }),
    step('collect', 'wheat', {}),
    step('craft', 'bread', {}),
    JSON.stringify({ ts: t(30), event: 'farmland_reverted', loop: 9, pos: { x: 1, y: 63, z: 0 }, nearWater: false }),
  ].join('\n'));
  const out = JSON.parse(execFileSync('node', [path.join(__dirname, '..', 'tools', 'summarize_run.js'), dir], { encoding: 'utf8' }));
  const f = out.farm;
  assert.deepStrictEqual({ till: f.till, near: f.tillNearWater, known: f.tillNearWaterKnown, rate: f.tillNearWaterRate, plant: f.plant, reverted: f.reverted, harvest: f.harvest, bread: f.bread, hoeOnFarmland: f.hoeOnFarmland, growWait: f.growWait, spot: f.tillToSpot },
    { till: 3, near: 2, known: 3, rate: 0.667, plant: 1, reverted: 1, harvest: 1, bread: 1, hoeOnFarmland: 1, growWait: 1, spot: 2 });
  assert.deepStrictEqual(f.perAgent.Taro, { till: 3, plant: 1, reverted: 1, harvest: 1, bread: 1 });
});

test('facts: 耕地と水の事実 (湿る範囲・高さ・乾くと土に戻る・植わっていれば戻らない・跳ぶと戻る)。評価語なし', () => {
  const facts = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'knowledge', 'facts.json'), 'utf8'));
  const f = facts.find((x) => x.id === 'farm_water');
  assert.match(f.text, /水平に4ブロック以内/);
  assert.match(f.text, /同じ高さか1つ上/);
  assert.match(f.text, /何も植わっていないと、しばらくして土\(dirt\)に戻る/);
  assert.match(f.text, /植わっていれば土に戻らない/);
  assert.match(f.text, /跳ぶと土に戻る/);
  assert.match(f.text_en, /same level or one block above/);
  for (const s of [f.text, f.text_en]) assert.doesNotMatch(s, /とよい|べき|おすすめ|should|better|best/i);
});

test('listActions: 行けなかった場所は go_to に出さない', () => {
  const raw = mockRaw({ blocks: [], entities: [] });
  const memPlaces = [{ id: 'M1', kind: 'water', pos: { x: 0, y: 63, z: -40 }, d: 40, label: 'water', unreachable: true }, { id: 'M2', kind: 'water', pos: { x: 30, y: 63, z: 0 }, d: 30, label: 'water' }];
  const go = listActions(raw, { memPlaces }).find((a) => a.name === 'go_to');
  assert.deepStrictEqual(go.choices.filter((c) => c.fromMemory).map((c) => c.id), ['M2']);
});

// 作物の collect 用の模擬 bot: (x,64,0) に wheat (age は ages[i])。掘ると消えて wheat_seeds が増える
function cropBot(ages) {
  const { Vec3 } = require('vec3');
  const blocks = new Map(ages.map((a, i) => [`${i + 1},64,0`, a]));
  const inv = [];
  const dug = [];
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5), height: 1.62 },
    registry: { blocksByName: { wheat: { id: 9, states: [{ name: 'age', num_values: 8 }] } }, itemsByName: {} },
    heldItem: null, entities: {},
    inventory: { items: () => inv },
    findBlocks: () => [...blocks.keys()].map((k) => new Vec3(...k.split(',').map(Number))),
    blockAt: (p) => {
      const k = `${p.x},${p.y},${p.z}`;
      return blocks.has(k) ? { name: 'wheat', position: p, boundingBox: 'empty', getProperties: () => ({ age: blocks.get(k) }), digTime: () => 0 } : null;
    },
    canDigBlock: () => true,
    pathfinder: { goto: async () => {}, setGoal: () => {} },
    clearControlStates: () => {},
    equip: async () => {}, unequip: async () => {},
    dig: async (b) => { dug.push(blocks.get(`${b.position.x},${b.position.y},${b.position.z}`)); blocks.delete(`${b.position.x},${b.position.y},${b.position.z}`); inv.push({ name: 'wheat', count: 1, type: 9 }); },
  };
  return { bot, dug };
}

test('collect (作物): 育ちきった物だけ掘る。育ち途中しか無ければ何も掘らず「まだ育ち途中」。候補にも出さない', async () => {
  const { handlers } = require('../src/act');
  const a = cropBot([3, 5]);
  const r = await handlers.collect(a.bot, { block: 'wheat' }, { collectCount: 3 });
  assert.strictEqual(r.ok, false);
  assert.match(r.msg, /wheatはまだ育ち途中/);
  assert.deepStrictEqual(a.dug, []);
  const b = cropBot([3, 7, 7]);
  const r2 = await handlers.collect(b.bot, { block: 'wheat' }, { collectCount: 3 });
  assert.deepStrictEqual(b.dug, [7, 7]); // 育ちきった2つだけ。育ち途中は残す
  assert.match(r2.msg, /2個掘って/);
  // 候補: 育ちきった物が無い作物は collect に出さない。あれば育ちきった所を指す
  const unripe = mockRaw({ blocks: [{ ...blk('wheat', 2, 64, 0, 2), positions: [{ x: 2, y: 64, z: 0, d: 2, ripe: false }], ripe: 0 }, blk('oak_log', 3, 64, 0, 3)], entities: [] });
  const c1 = listActions(unripe, {}).find((x) => x.name === 'collect');
  assert.deepStrictEqual(c1.choices.map((c) => c.id), ['oak_log']);
  const ripe = mockRaw({ blocks: [{ ...blk('wheat', 2, 64, 0, 2), positions: [{ x: 2, y: 64, z: 0, d: 2, ripe: false }, { x: 5, y: 64, z: 0, d: 5, ripe: true }], ripe: 1 }], entities: [] });
  const c2 = listActions(ripe, {}).find((x) => x.name === 'collect');
  assert.match(c2.choices.find((c) => c.id === 'wheat').label, /wheat 東5/);
});
