'use strict';
// 道筋 (プログラム): 物のゴールから、要る物の連なりを逆にたどる (bot に依存しない。minecraft-data だけを使う)。
//   入手のしかたは4つ: 作る (minecraft-data のレシピ。3x3 は作業台が要る)・焼く (かまど + 燃料)・
//   掘る (blockLoot。シルクタッチの要らない落とし物。道具が要るブロックは道具も要る物に入れる)・倒す (entityLoot)。
//   持ち物・見えている物・覚えている場所に合うやり方を選ぶ (見えている物ほど手間が小さいとみなす)。
//   代わりのレシピ (どの木の板材でもよい等) も同じ手間の比べ方で選ぶ。
// 返り値: { ok, steps: [{ item, count, how, from, ings, station, tool, where }], next, reason }
//   steps は手に入れる順 (要る物が先)。持っている分は除く。next = steps[0]
// 2B・Jev には pathText() の短い文だけを渡す (手間の数値は渡さない)。
const { SMELTABLE } = require('./actions');
const farmwater = require('./farmwater');

const DEFAULT_VERSION = '1.20.1';
// rebreak / rekill: 落ちる確率が低い物を、同じ所でもう1回壊す・もう1匹倒す手間 (1回目は探して歩く手間を含むので、2回目からは小さい)
const COST = { visible: 1, known: 2, unseen: 6, unseenRare: 12, mobVisible: 2, mobUnseen: 6, mobRare: Infinity, craft: 0.3, smelt: 0.6, toolShare: 0.5, stationShare: 0.5,
  rebreak: 0.25, rekill: 1, farmPlant: 0.3, farmWait: 3, farmGrowing: 1.5,
  treePlant: 0.3, treeWait: 6, treeGrowing: 2, treeCut: 1, treeGround: { visible: 0, known: 0.5, unknown: 1 } };
// 木を育てる (仕様、1.20.1): 苗木を土・草の生えた土など (TREE_GROUND) に植える (use_on) → 明るい所 (明るさ 9 以上) で上に空きがあれば
//   育って木になる (sapling_time の事実: およそ10〜20分) → 原木を切る (掘る)。苗木は葉を壊すとときどき落ちる (dropFix: 5%、ジャングル 2.5%)。
//   logs: 苗木から育つふつうの大きさの木1本の原木の数の目安 (幹の高さ。オーク 4〜6、シラカバ 5〜7 など。大きく育つ枝分かれの木は数えない)。
//   k: 1本の木に要る苗木の数。ダークオークは 2x2 に4本植えたときだけ育つ (1本では育たない)。
//   トウヒ・ジャングルも 2x2 に植えると大きい木になるが、1本でも小さい木に育つので、ここでは1本で植える。
//   手間 (1個あたり): (苗木の手間 × k + 植える × k + 待つ + 植える場所) / logs + 切る。待つ (treeWait) は1本の木で1回なので、原木の数で分ける。
//   見えている木 (1)・前に見た木 (2) より大きく、まだ見ていない木 (6) より小さいことが多い = 見えている木・覚えている木が無いときに選ばれうる。
//   苗木の入手元が「まだ見ていない葉」だけのときは選ばない (葉を探しに行けば木も見つかる)
const TREE = {
  oak_log: { sapling: 'oak_sapling', logs: 5, k: 1 },
  birch_log: { sapling: 'birch_sapling', logs: 6, k: 1 },
  spruce_log: { sapling: 'spruce_sapling', logs: 7, k: 1 },
  jungle_log: { sapling: 'jungle_sapling', logs: 6, k: 1 },
  acacia_log: { sapling: 'acacia_sapling', logs: 5, k: 1 },
  cherry_log: { sapling: 'cherry_sapling', logs: 7, k: 1 },
  dark_oak_log: { sapling: 'dark_oak_sapling', logs: 24, k: 4 },
};
const SAPLING_LOG = Object.fromEntries(Object.entries(TREE).map(([log, t]) => [t.sapling, log]));
// 苗木を植えられる地面 (1.20.1。耕地にも植わるが、畑と混ざるので道筋には出さない)
const TREE_GROUND = ['grass_block', 'dirt', 'podzol', 'coarse_dirt', 'rooted_dirt', 'mud', 'moss_block'];
const TREE_WAIT_MIN = [10, 20]; // sapling_time の事実 (分)
// 畑 (仕様、1.20.1): 種を耕地に使う (use_on) と植わる → 明るい所で育つ (crop_time の事実: 湿った耕地でおよそ20〜30分) → 育ちきった作物を壊すと
//   収穫物と種が落ちる。yield: 育ちきった1本から落ちる収穫物の平均 (小麦・ビートルート 1、にんじん・じゃがいも 1〜4 の平均)。
//   にんじん・じゃがいもは収穫物そのものが種なので、持っている (共有のチェストにある) ときだけ畑の道筋にする
const FARM = {
  wheat: { crop: 'wheat', seed: 'wheat_seeds', yield: 1 },
  beetroot: { crop: 'beetroots', seed: 'beetroot_seeds', yield: 1 },
  carrot: { crop: 'carrots', seed: 'carrot', yield: 2.71 },
  potato: { crop: 'potatoes', seed: 'potato', yield: 2.71 },
};
const FARM_CROPS = /^(wheat|beetroots|carrots|potatoes)$/;
const HOES = ['wooden_hoe', 'stone_hoe', 'iron_hoe', 'golden_hoe', 'diamond_hoe', 'netherite_hoe'];
// 期待値で 1/期待値 回壊す (倒す) ときの手間: 1回目の手間 + 2回目からの手間 × (1/期待値 − 1)。1回で1個以上落ちる物は1回分
function chanceCost(base, expect, again) { const e = expect || 1; return base + again * Math.max(0, 1 / e - 1); }
// 地上・浅い所でふつうに見つかるブロックと生き物 (まだ見ていなくても、探せば見つかるとみなす手間を小さくする)。
// それ以外の自然のブロックは手間を大きく見る。それ以外の生き物は、見えていなければ入手元にしない (ネザーにしかいない・村のゴーレム等)
//   (小麦・にんじん・じゃがいも・ビートルートの作物は村の畑のほかには生えていないので、ここに入れない = まだ見ていなければ手間が大きい)
const COMMON_BLOCKS = /_log$|_leaves$|^(stone|deepslate|sand|gravel|clay|grass|tall_grass|fern|coal_ore|iron_ore|copper_ore|sugar_cane|pumpkin|melon|sweet_berry_bush|andesite|diorite|granite|water)$/;
const COMMON_MOBS = /^(cow|pig|sheep|chicken|rabbit|zombie|skeleton|spider|creeper|cod|salmon|squid|horse|llama)$/;
// 作物 (レシピのある物と同じ名前のブロックでも、育っている所を探せる)
const CROP_BLOCKS = /^(wheat|carrots|potatoes|beetroots|sweet_berry_bush|melon|pumpkin|sugar_cane)$/;
const MAX_DEPTH = 12; // 道筋の深さの上限
// 燃料 (1個で焼ける数)
const FUELS = [['coal', 8], ['charcoal', 8], [/_planks$/, 1.5], [/_log$/, 1.5], ['stick', 0.5]];
// 地面そのもの (collect の候補から外す物と同じ。掘る道筋にも使わない)
const GROUND = /^(dirt|grass_block|coarse_dirt|podzol|mycelium|rooted_dirt|dirt_path|farmland|mud)$/;
// entityLoot に無い落とし物 (仕様の補い): 羊は倒すとその色の羊毛を落とす
const EXTRA_MOB_DROPS = { sheep: ['white_wool'] };
// 1回で落ちる数の期待値がこれより小さい物は入手元にしない (ほぼ出ない物)
const MIN_DROP_CHANCE = 0.001;
// 2B に見せる「見えている物から取れる物」(vocab.js) は前と同じく dropChance 0.05 以上だけ
const VOCAB_MIN_CHANCE = 0.05;
// blockLoot の dropChance は、シルクタッチの有無・育ち具合などの分かれ道を等分した値 (0.5・0.33) が入っていて、
// 本当の確率ではないことが多い。0.3 以上は分かれ道とみなして 1 (その道ではかならず落ちる) として扱い、
// それより小さい値 (草の種など) は確率として使う。そのうえで、minecraft-data の値が仕様と違う物は下の表で補う
const BRANCH_CHANCE = 0.3;
// 仕様の補い (1.20.1 のバニラ、幸運なし): (ブロック, 落ちる物) → { chance: 1回で落ちる確率, avg: 落ちたときの平均の数, tools: 要る道具 }
//   葉: 苗木 5% (ジャングル 2.5%)・棒 2% (1〜2本)・りんご 0.5% (オーク・ダークオーク)。葉そのものはハサミのときだけ
//   砂利: 火打石 10%。草・シダ: 小麦の種 12.5%、草・シダそのものはハサミのときだけ。ツタ・枯れ木・クモの巣・海草そのものもハサミ
const SHEARS_ONLY = /_leaves$|^(grass|short_grass|tall_grass|fern|large_fern|dead_bush|vine|cobweb|seagrass|tall_seagrass|hanging_roots|glow_lichen)$/;
const SAPLING_DROP = /_sapling$|^(azalea|flowering_azalea)$/;
function dropFix(block, item) {
  if (/_leaves$/.test(block)) {
    if (SAPLING_DROP.test(item)) return { chance: block === 'jungle_leaves' ? 0.025 : 0.05, avg: 1 };
    if (item === 'stick') return { chance: 0.02, avg: 1.5 };
    if (item === 'apple') return { chance: 0.005, avg: 1 };
  }
  if (block === 'gravel' && item === 'flint') return { chance: 0.1, avg: 1 };
  if (block === 'gravel' && item === 'gravel') return { chance: 0.9, avg: 1 };
  if (/^(grass|short_grass|tall_grass|fern|large_fern)$/.test(block) && item === 'wheat_seeds') return { chance: 0.125, avg: 1 };
  if (block === 'gilded_blackstone' && item === 'gold_nugget') return { chance: 0.1, avg: 3.5 };
  if (block === 'melon' && item === 'melon_slice') return { chance: 1, avg: 5 };
  if (block === 'glowstone' && item === 'glowstone_dust') return { chance: 1, avg: 3 };
  if (block === 'dead_bush' && item === 'stick') return { chance: 1, avg: 1 };
  // ハサミのときだけ落ちるブロックそのもの (草は2マスの草も「grass」「fern」が落ちる)
  if (SHEARS_ONLY.test(block) && (item === block || (block === 'tall_grass' && item === 'grass') || (block === 'large_fern' && item === 'fern')
    || (block === 'tall_seagrass' && item === 'seagrass'))) return { chance: 1, avg: block === 'tall_grass' || block === 'large_fern' ? 2 : 1, tools: ['shears'] };
  return null;
}
// stackSizeRange の平均 (無い・壊れている所は 1)
function avgCount(range) {
  const r = (range || []).filter((x) => Number.isFinite(x));
  if (!r.length) return 1;
  return Math.max(1, (Math.min(...r) + Math.max(...r)) / 2);
}
// 1回 (1つのブロックを壊す・1匹倒す) で落ちる数の期待値 (1 が上限の目安。手間は 1/期待値 倍になる)
function blockDropExpect(block, d) {
  const fx = dropFix(block, d.item);
  if (fx) return { expect: fx.chance * fx.avg, tools: fx.tools || null };
  const p = d.dropChance ?? 1;
  return { expect: (p >= BRANCH_CHANCE ? 1 : p) * avgCount(d.stackSizeRange), tools: null };
}
function mobDropExpect(d) { return (d.dropChance ?? 1) * 1; } // entityLoot の数の幅は [1,1] が多い (実際は 0〜2 などで平均 1 前後)

const caches = new Map();

// minecraft-data から、物 → 入手のしかた の表を作る (版ごとに1回)
function index(version = DEFAULT_VERSION) {
  if (caches.has(version)) return caches.get(version);
  const md = require('minecraft-data')(version);
  const name = (id) => (md.items[id] ? md.items[id].name : null);
  const recipes = new Map(); // item → [{ ings: {name: n}, count, table }]
  for (const [rid, list] of Object.entries(md.recipes || {})) {
    const out = name(Number(rid));
    if (!out) continue;
    for (const r of list) {
      const ings = {};
      let table = false;
      if (r.inShape) {
        const rows = r.inShape.length;
        const cols = Math.max(...r.inShape.map((row) => row.length));
        table = rows > 2 || cols > 2;
        for (const row of r.inShape) for (const id of row) if (id != null && id >= 0) { const n = name(id); if (n) ings[n] = (ings[n] || 0) + 1; }
      } else if (r.ingredients) {
        table = r.ingredients.length > 4;
        for (const id of r.ingredients) { const n = name(typeof id === 'object' && id ? id.id : id); if (n) ings[n] = (ings[n] || 0) + 1; }
      }
      if (!Object.keys(ings).length || ings[out]) continue; // 自分を材料にするもの (色を変えるだけ等) は使わない
      recipes.set(out, [...(recipes.get(out) || []), { ings, count: (r.result && r.result.count) || 1, table }]);
    }
  }
  const smelt = new Map(); // 焼いてできる物 → [焼く物]
  for (const [inp, out] of Object.entries(SMELTABLE)) smelt.set(out, [...(smelt.get(out) || []), inp]);
  for (const it of md.itemsArray) if (/_log$/.test(it.name)) smelt.set('charcoal', [...(smelt.get('charcoal') || []), it.name]);
  const blocks = new Map(); // 物 → [{ block, tools: [道具の名前] | null }]
  for (const bl of md.blockLootArray || []) {
    const b = md.blocksByName[bl.block];
    if (!b) continue;
    const harvest = b.harvestTools ? Object.keys(b.harvestTools).map((id) => name(Number(id))).filter(Boolean) : null;
    const best = new Map(); // 落ちる物 → いちばん期待値の大きい落ち方 (同じ物が分かれ道ごとに何行もある)
    for (const d of bl.drops || []) {
      if (d.silkTouch || !md.itemsByName[d.item]) continue;
      const e = { ...blockDropExpect(bl.block, d), rawChance: d.dropChance ?? 1 };
      if (e.expect < MIN_DROP_CHANCE) continue;
      const prev = best.get(d.item);
      if (!prev || e.expect > prev.expect) best.set(d.item, { ...e, rawChance: Math.max(e.rawChance, prev ? prev.rawChance : 0) });
    }
    // rawChance: minecraft-data の dropChance そのもの (vocab.js の「見えている物から取れる」の判断は前と同じ 0.05 以上で)
    for (const [item, e] of best) blocks.set(item, [...(blocks.get(item) || []), { block: bl.block, tools: e.tools || harvest, expect: e.expect, rawChance: e.rawChance }]);
  }
  const mobs = new Map(); // 物 → [{ mob, expect }]
  const addMob = (item, mob, expect) => {
    const l = mobs.get(item) || [];
    const o = l.find((x) => x.mob === mob);
    if (!o) mobs.set(item, [...l, { mob, expect, rawChance: expect }]); else { o.expect = Math.max(o.expect, expect); o.rawChance = o.expect; }
  };
  for (const el of md.entityLootArray || []) {
    for (const d of el.drops || []) {
      const e = mobDropExpect(d);
      if (e < MIN_DROP_CHANCE || !md.itemsByName[d.item]) continue;
      addMob(d.item, el.entity, e);
    }
  }
  for (const [mob, items] of Object.entries(EXTRA_MOB_DROPS)) for (const it of items) addMob(it, mob, 1);
  const ix = { md, recipes, smelt, blocks, mobs, version };
  caches.set(version, ix);
  return ix;
}

function invMap(inventory) {
  const m = {};
  for (const i of inventory || []) m[i.name] = (m[i.name] || 0) + (i.count || 0);
  return m;
}

// world = { inventory: [{name,count}], visibleBlocks: [名前], visibleMobs: [名前], knownBlocks: [覚えている場所の種類],
//           stations: { crafting_table: bool, furnace: bool } (見えている・覚えている), excludeBlocks: RegExp,
//           sharedChests: [{ id, items: [{name,count}] }] (共有のチェスト。board.js。中身は全員に見えている),
//           farm: { empty: 空いている耕地の数, growing: { wheat: 育ち途中の本数 }, ripe: { wheat: 育ちきった本数 } } (近くの畑。states.farmStatus) }
//   畑の作物 (wheat・carrots 等) のブロックは、育ちきった物が見えているときだけ「見える」(掘れば収穫物が落ちる)。育ち途中は farm.growing
// 共有のチェストにある物は、作る・掘るより先にそこから出す (手順 how: 'chest'、from: チェストの id)。足りない分だけほかの入手元から
class Planner {
  constructor(world = {}, opts = {}) {
    this.ix = opts.index || index(opts.version || DEFAULT_VERSION);
    this.inv0 = invMap(world.inventory);
    this.vis = new Set(world.visibleBlocks || []);
    this.mobsVis = new Set(world.visibleMobs || []);
    this.known = new Set(world.knownBlocks || []);
    this.stations0 = { crafting_table: false, furnace: false, ...(world.stations || {}) };
    this.exclude = world.excludeBlocks || GROUND;
    this.chests0 = (world.sharedChests || []).map((c) => ({ id: c.id, items: Object.fromEntries((c.items || []).filter((i) => i.count > 0).map((i) => [i.name, i.count])) }));
    const fm = world.farm || {};
    // tillCount: 水から4マス以内の耕せるマスの数 (farmwater.tillSpots。分からなければ null = 数えない)
    this.farm = { empty: fm.empty || 0, growing: { ...(fm.growing || {}) }, ripe: { ...(fm.ripe || {}) },
      tillCount: Number.isFinite(fm.tillCount) ? fm.tillCount : (Array.isArray(fm.till) && fm.till.length < 4 ? fm.till.length : null) };
    // 耕す前の水の段 (farmwater.waterInfo)。無ければ見えている・覚えているブロックの名前から (見えていれば済んだとみなす)
    this.water = world.water || (this.vis.has('water') ? { where: 'visible', ready: true } : this.known.has('water') ? { where: 'known', id: null, ready: false } : { where: 'unknown', ready: false });
    this.cropPlaces = world.cropPlaces || {};
    // 近くに植わっている (育ち途中の) 苗木の数 { oak_sapling: 2 } と、その覚えている場所 { oak_sapling: { id: 'M3' } }
    this.saplings = { ...(world.saplings || {}) };
    this.treePlaces = world.treePlaces || {};
    // 育ち途中しか見えていない作物は「見える」から外す (掘っても種しか落ちない)
    for (const c of Object.keys(this.farm.growing)) if (this.vis.has(c) && !(this.farm.ripe[c] > 0)) this.vis.delete(c);
    this.reach = null; this.costCache = null; this.dirty = true;
  }

  isItem(n) { return !!this.ix.md.itemsByName[n]; }

  // 道筋を作っている途中の持ち物 (使った分を引いたもの)。plan() の外では最初の持ち物
  curInv() { return this.sim ? this.sim.inv : this.inv0; }

  hasTool(t) { return this.sim ? this.sim.tools.has(t) : (this.inv0[t] || 0) > 0; }

  curStations() { return this.sim ? this.sim.stations : this.stations0; }

  curChests() { return this.sim ? this.sim.chests : this.chests0; }

  // 共有のチェストにある item の数 (いちばん多いチェスト)
  chestFor(item) {
    let best = null;
    for (const c of this.curChests()) { const n = c.items[item] || 0; if (n > 0 && (!best || n > best.n)) best = { c, n }; }
    return best;
  }

  // 自然にある (レシピの無い) ブロックなら、まだ見ていなくても探せばあるとみなす
  natural(block) { return !this.ix.recipes.has(block) || CROP_BLOCKS.test(block); }

  stationAvail(st, stations = this.curStations()) { return stations[st] || (this.curInv()[st] || 0) > 0 || this.vis.has(st) || this.known.has(st); }

  // target から材料・道具・作業台・かまど・燃料をたどって届く物の集まり (持ち物には関係しない)
  reachFrom(target) {
    const seen = new Set();
    const q = [target, 'crafting_table', 'furnace', 'coal', 'charcoal', ...[...this.vis].filter((n) => /_log$|_planks$/.test(n)), 'oak_planks'];
    while (q.length) {
      const it = q.pop();
      if (seen.has(it) || !this.isItem(it)) continue;
      seen.add(it);
      for (const s of this.ix.blocks.get(it) || []) for (const t of s.tools || []) q.push(t);
      for (const r of this.ix.recipes.get(it) || []) q.push(...Object.keys(r.ings));
      for (const inp of this.ix.smelt.get(it) || []) q.push(inp);
      if (FARM[it]) q.push(FARM[it].seed, ...HOES);
      if (TREE[it]) q.push(TREE[it].sapling);
    }
    return seen;
  }

  // 1つの物の、今の手間の表 (costs) から見たいちばん小さいやり方
  bestOption(item, costs) {
    if ((this.curInv()[item] || 0) > 0) return { c: 0, how: 'have' };
    if (this.chestFor(item)) return { c: COST.known, how: 'chest' };
    const cOf = (n) => (costs.has(n) ? costs.get(n).c : Infinity);
    let best = { c: Infinity };
    const consider = (o) => { if (o.c < best.c) best = o; };
    for (const s of this.ix.blocks.get(item) || []) {
      if (this.exclude.test(s.block)) continue;
      // 植わっている (育てている) 苗木は、壊して苗木を取る入手元にしない
      if (SAPLING_DROP.test(s.block) && (this.saplings[s.block] || 0) > 0) continue;
      // 植えた苗木 (ブロック) は、自然には生えていないので、見えている・覚えている所だけ
      const where = this.vis.has(s.block) ? 'visible' : this.known.has(s.block) ? 'known' : (this.natural(s.block) && !SAPLING_DROP.test(s.block) ? 'unseen' : null);
      if (!where) continue;
      // 落ちる確率が低い物は、期待値で 1/確率 回壊す手間を足す (りんご 0.5% → 200 回壊す)
      let c = chanceCost(where === 'unseen' && !COMMON_BLOCKS.test(s.block) ? COST.unseenRare : COST[where], s.expect, COST.rebreak);
      let tool = null;
      if (s.tools && !s.tools.some((t) => this.hasTool(t))) {
        let tb = { c: Infinity };
        for (const t of s.tools) { const tc = cOf(t); if (tc < tb.c) tb = { c: tc, t }; }
        if (!Number.isFinite(tb.c)) continue;
        c += tb.c * COST.toolShare; tool = tb.t;
      }
      consider({ c, how: 'collect', from: s.block, where, tool, expect: s.expect || 1 });
    }
    for (const { mob: m, expect } of this.ix.mobs.get(item) || []) {
      const where = this.mobsVis.has(m) ? 'visible' : 'unseen';
      const base = where === 'visible' ? COST.mobVisible : COMMON_MOBS.test(m) ? COST.mobUnseen : COST.mobRare;
      consider({ c: chanceCost(base, expect, COST.rekill), how: 'kill', from: m, where, expect: expect || 1 });
    }
    const tableC = this.stationAvail('crafting_table') ? 0 : cOf('crafting_table') * COST.stationShare;
    for (const r of this.ix.recipes.get(item) || []) {
      let c = 0;
      for (const [ing, n] of Object.entries(r.ings)) c += cOf(ing) * n;
      if (r.table) c += tableC;
      if (Number.isFinite(c)) consider({ c: c / r.count + COST.craft, how: 'craft', recipe: r });
    }
    const furnC = this.stationAvail('furnace') ? 0 : cOf('furnace') * COST.stationShare;
    for (const inp of this.ix.smelt.get(item) || []) {
      const c = cOf(inp) + COST.smelt + furnC;
      if (Number.isFinite(c)) consider({ c, how: 'smelt', from: inp });
    }
    const fo = this.farmOption(item, cOf);
    if (fo) consider(fo);
    const to = this.treeOption(item, cOf, costs);
    if (to) consider(to);
    return best;
  }

  // 苗木を植えて育てて切る (1個あたりの手間)。植わっている苗木があれば待って切るだけ
  treeOption(item, cOf, costs) {
    const t = TREE[item];
    if (!t) return null;
    if ((this.saplings[t.sapling] || 0) >= t.k) return { c: COST.treeGrowing / t.logs + COST.treeCut, how: 'tree', sapling: t.sapling, where: 'growing' };
    const sc = cOf(t.sapling);
    if (!Number.isFinite(sc)) return null;
    const so = costs.get(t.sapling);
    if (so && so.how === 'collect' && so.where === 'unseen') return null;
    // 2x2 の木 (k = 4) は、持っている・チェストの数で足りない分を、葉から取る手間で数える
    let sapC = sc * t.k;
    if (t.k > 1) {
      const ch = this.chestFor(t.sapling);
      const have = (this.curInv()[t.sapling] || 0) + (ch ? ch.n : 0);
      if (have < t.k) {
        const leaf = this.leafSaplingCost(t.sapling);
        if (!Number.isFinite(leaf)) return null;
        sapC = (have > 0 ? sc : 0) + leaf * (t.k - have);
      } else sapC = sc;
    }
    const g = this.treeGround();
    const c = (sapC + COST.treePlant * t.k + COST.treeWait + COST.treeGround[g.where]) / t.logs + COST.treeCut;
    return { c, how: 'tree', sapling: t.sapling, where: 'plant' };
  }

  // 見えている・覚えている葉から苗木を1本取る手間 (持ち物を数えない)
  leafSaplingCost(sapling) {
    let best = Infinity;
    for (const s of this.ix.blocks.get(sapling) || []) {
      if (!/_leaves$/.test(s.block)) continue;
      const where = this.vis.has(s.block) ? 'visible' : this.known.has(s.block) ? 'known' : null;
      if (where) best = Math.min(best, chanceCost(COST[where], s.expect, COST.rebreak));
    }
    return best;
  }

  // 苗木を植える地面: 見えている → 覚えている → 知らない (草の生えた土とする)
  treeGround() {
    const v = TREE_GROUND.find((g) => this.vis.has(g));
    if (v) return { where: 'visible', block: v };
    const k = TREE_GROUND.find((g) => this.known.has(g));
    if (k) return { where: 'known', block: k };
    return { where: 'unknown', block: 'grass_block' };
  }

  // 畑で育てる (1個あたりの手間): 育ち途中の作物があれば待つだけ。なければ 種 + 耕す (クワ) + 植える + 待つ
  farmOption(item, cOf) {
    const fm = FARM[item];
    if (!fm) return null;
    if ((this.farm.growing[fm.crop] || 0) > 0) return { c: COST.farmGrowing / fm.yield, how: 'farm', crop: fm.crop };
    let seedC;
    if (fm.seed === item) seedC = (this.inv0[item] || 0) > 0 || this.chestFor(item) ? 0 : Infinity;
    else seedC = cOf(fm.seed);
    if (!Number.isFinite(seedC)) return null;
    let hoeC = 0;
    if (!(this.farm.empty > 0) && !HOES.some((h) => this.hasTool(h))) {
      hoeC = Math.min(...HOES.map((h) => cOf(h)));
      if (!Number.isFinite(hoeC)) return null;
      hoeC *= COST.toolShare;
    }
    // 耕すなら水の近くへ (見えている・覚えている距離・知らない)。道具と同じく分けて持つ
    const waterC = !(this.farm.empty > 0) ? farmwater.waterCost(this.water) * COST.toolShare : 0;
    return { c: (seedC + COST.farmPlant + COST.farmWait) / fm.yield + hoeC + waterC, how: 'farm', crop: fm.crop };
  }

  // 届く物すべての手間を、変わらなくなるまで繰り返して求める (材料の輪があっても止まる)
  costs() {
    if (this.costCache && !this.dirty) return this.costCache;
    const costs = new Map();
    const reach = this.reach || this.reachFrom('crafting_table');
    for (let iter = 0; iter < 60; iter++) {
      let changed = false;
      for (const it of reach) {
        const o = this.bestOption(it, costs);
        const prev = costs.get(it);
        if (!prev || o.c < prev.c - 1e-9) { costs.set(it, o); changed = true; }
      }
      if (!changed) break;
    }
    this.costCache = costs; this.dirty = false;
    return costs;
  }

  cost(item) {
    if (!this.reach || !this.reach.has(item)) { this.reach = new Set([...(this.reach || []), ...this.reachFrom(item)]); this.dirty = true; }
    return this.costs().get(item) || { c: Infinity };
  }

  // 燃料: 持っている物か、いちばん手間の小さい物
  fuelChoice(sim, n) {
    for (const [re, burns] of FUELS) {
      const have = Object.keys(sim.inv).find((k) => (typeof re === 'string' ? k === re : re.test(k)) && sim.inv[k] > 0);
      if (have) return { item: have, count: Math.min(sim.inv[have], Math.ceil(n / burns)) };
    }
    let best = null;
    for (const cand of ['coal', 'oak_planks', ...this.vis]) {
      if (!FUELS.some(([re]) => (typeof re === 'string' ? cand === re : re.test(cand)))) continue;
      const burns = FUELS.find(([re]) => (typeof re === 'string' ? cand === re : re.test(cand)))[1];
      const c = this.cost(cand).c * Math.ceil(n / burns);
      if (Number.isFinite(c) && (!best || c < best.c)) best = { item: cand, count: Math.ceil(n / burns), c };
    }
    return best;
  }

  // n 個を手に入れる手順を sim.out に足す。成功なら true
  expand(item, n, sim, stack = []) {
    const have = Math.min(sim.inv[item] || 0, n);
    if (have) { sim.inv[item] -= have; n -= have; this.dirty = true; }
    if (n <= 0) return true;
    // 共有のチェストにあれば、まずそこから出す (足りない分は下でほかの入手元から)
    for (let ch = this.chestFor(item); ch && n > 0; ch = this.chestFor(item)) {
      const k = Math.min(n, ch.n);
      ch.c.items[item] -= k; n -= k; this.dirty = true;
      sim.out.push({ item, count: k, how: 'chest', from: ch.c.id, where: 'shared' });
    }
    if (n <= 0) return true;
    if (stack.includes(item) || stack.length > MAX_DEPTH * 2) return false;
    const st = [...stack, item];
    const best = this.cost(item);
    if (!Number.isFinite(best.c)) { sim.fail = sim.fail || item; return false; }
    if (best.how === 'collect') {
      if (best.tool && !sim.tools.has(best.tool)) {
        if (!this.expand(best.tool, 1, sim, st)) return false;
        sim.tools.add(best.tool); this.dirty = true;
      }
      // 見えている育ちきった作物は、その本数ぶんだけ取る。足りない分は畑 (植わっている分を待つ・植える)
      if (FARM[item] && best.from === FARM[item].crop && best.where === 'visible' && this.farm.ripe[best.from] > 0) {
        const take = Math.min(n, Math.ceil(this.farm.ripe[best.from] * FARM[item].yield));
        sim.out.push({ item, count: take, how: 'collect', from: best.from, where: best.where, tool: null, tries: this.farm.ripe[best.from] });
        return take >= n || this.expandFarm(item, n - take, sim, st);
      }
      // tries: 期待値で何回壊すか (落ちる数の期待値から)。文 (pathText) には出さない
      sim.out.push({ item, count: n, how: 'collect', from: best.from, where: best.where, tool: best.tool || null, tries: Math.ceil(n / (best.expect || 1)) });
      return true;
    }
    if (best.how === 'farm') return this.expandFarm(item, n, sim, st);
    if (best.how === 'tree') return this.expandTree(item, n, sim, st);
    if (best.how === 'kill') { sim.out.push({ item, count: n, how: 'kill', from: best.from, where: best.where, tries: Math.ceil(n / (best.expect || 1)) }); return true; }
    if (best.how === 'craft') {
      const r = best.recipe;
      const k = Math.ceil(n / r.count);
      if (r.table && !this.stationAvail('crafting_table', sim.stations)) {
        if (!this.expand('crafting_table', 1, sim, st)) return false;
        sim.stations.crafting_table = true; this.dirty = true;
      }
      const ings = {};
      for (const [ing, c] of Object.entries(r.ings)) { ings[ing] = c * k; if (!this.expand(ing, c * k, sim, st)) return false; }
      sim.out.push({ item, count: n, how: 'craft', ings, station: r.table ? 'crafting_table' : null });
      const left = k * r.count - n;
      if (left > 0) { sim.inv[item] = (sim.inv[item] || 0) + left; this.dirty = true; }
      return true;
    }
    if (best.how === 'smelt') {
      if (!this.stationAvail('furnace', sim.stations)) {
        if (!this.expand('furnace', 1, sim, st)) return false;
        sim.stations.furnace = true; this.dirty = true;
      }
      const fuel = this.fuelChoice(sim, n);
      if (!fuel) { sim.fail = sim.fail || 'fuel'; return false; }
      if (!this.expand(fuel.item, fuel.count, sim, st)) return false;
      if (!this.expand(best.from, n, sim, st)) return false;
      sim.out.push({ item, count: n, how: 'smelt', from: best.from, fuel: fuel.item, station: 'furnace' });
      return true;
    }
    return false;
  }

  // 畑の手順: 種 (・クワ) を先に手に入れ、最後に { how: 'farm', plants (これから植える本数), growing (もう植わっている本数), till (耕すマス), seed, crop, tool, rounds }
  expandFarm(item, n, sim, st) {
    const fm = FARM[item];
    const plantsAll = Math.ceil(n / fm.yield);
    const growing = Math.min(plantsAll, sim.farmGrowing[fm.crop] || 0);
    sim.farmGrowing[fm.crop] = (sim.farmGrowing[fm.crop] || 0) - growing;
    let plants = plantsAll - growing;
    // 耕せるだけ植える (2026-11-06): 種が収穫物と別の作物は、持っている種の数まで、空いている耕地 + 水から4マス以内の耕せるマスの数まで植える
    //   (要る数より多くても。要る数より少なければ要る数のまま = 足りない種は手に入れる道筋になる)
    if (fm.seed !== item) {
      const held = sim.inv[fm.seed] || 0;
      const cap = sim.farmEmpty + (Number.isFinite(this.farm.tillCount) ? this.farm.tillCount : Infinity);
      const more = Math.min(held, cap);
      if (more > plants) plants = more;
    }
    let rounds = 1;
    if (plants > 0 && fm.seed === item) {
      // 収穫物そのものが種: 持っている数 (道筋の初めの持ち物) を植え、増やして戻す
      const seeds = Math.max(1, Math.min(plants, this.inv0[item] || 0));
      rounds = Math.max(1, Math.ceil(Math.log((n + seeds) / seeds) / Math.log(fm.yield)));
      plants = seeds;
    } else if (plants > 0 && !this.expand(fm.seed, plants, sim, st)) return false;
    const empty = Math.min(plants, sim.farmEmpty);
    sim.farmEmpty -= empty;
    const till = plants - empty;
    let tool = null;
    if (till > 0) {
      tool = HOES.find((h) => sim.tools.has(h)) || null;
      if (!tool) {
        const costs = this.costs();
        const h = HOES.map((x) => ({ x, c: costs.has(x) ? costs.get(x).c : this.cost(x).c })).sort((a, b) => a.c - b.c)[0];
        if (!h || !Number.isFinite(h.c) || !this.expand(h.x, 1, sim, st)) { sim.fail = sim.fail || 'wooden_hoe'; return false; }
        sim.tools.add(h.x); this.dirty = true; tool = h.x;
      }
    }
    const water = till > 0 && !this.water.ready ? { ...this.water } : null; // 耕す前に水の近くへ行く段 (済んでいれば出さない)
    const at = this.cropPlaces[fm.crop] ? this.cropPlaces[fm.crop].id : null; // 植えた所 (覚えている M 番号)
    sim.out.push({ item, count: n, how: 'farm', crop: fm.crop, seed: fm.seed, plants, growing, till, tool, rounds, ...(water ? { water } : {}), ...(at ? { at } : {}) });
    return true;
  }

  // 木の手順: 苗木を先に手に入れ、最後に { how: 'tree', sapling, plants (これから植える本数), growing (もう植わっている本数), k, trees, ground, wait, at }
  expandTree(item, n, sim, st) {
    const t = TREE[item];
    const trees = Math.ceil(n / t.logs);
    const growTrees = Math.min(trees, Math.floor((sim.saplings[t.sapling] || 0) / t.k));
    sim.saplings[t.sapling] = (sim.saplings[t.sapling] || 0) - growTrees * t.k;
    const plants = (trees - growTrees) * t.k;
    if (plants > 0 && !this.expand(t.sapling, plants, sim, st)) return false;
    const g = this.treeGround();
    const at = this.treePlaces[t.sapling] ? this.treePlaces[t.sapling].id : null;
    sim.out.push({ item, count: n, how: 'tree', sapling: t.sapling, plants, growing: growTrees * t.k, k: t.k, trees, ground: g.block, groundWhere: g.where,
      waitMin: TREE_WAIT_MIN, ...(at ? { at } : {}) });
    return true;
  }

  newSim() {
    return { inv: { ...this.inv0 }, out: [], stations: { ...this.stations0 }, tools: new Set(Object.keys(this.inv0).filter((k) => this.inv0[k] > 0)),
      farmEmpty: this.farm.empty, farmGrowing: { ...this.farm.growing }, saplings: { ...this.saplings },
      chests: this.chests0.map((c) => ({ id: c.id, items: { ...c.items } })) };
  }

  plan(target, count = 1) {
    const item = this.resolve(target);
    if (!item) return { ok: false, target, reason: 'unknown', text: `${target} という物は知らない` };
    const sim = this.newSim();
    const n = Math.max(1, Math.floor(count) || 1);
    this.sim = sim; this.dirty = true;
    let ok;
    try { ok = this.expand(item, n, sim); } finally { this.sim = null; this.dirty = true; }
    if (!ok) return { ok: false, target: item, count: n, reason: 'untraceable', missing: sim.fail || item, steps: sim.out };
    const steps = mergeSteps(sim.out);
    return { ok: true, target: item, count: n, steps, next: steps[0] || null, done: steps.length === 0 };
  }

  // 道筋の中身を軽くたどる (持ち物の使い分けはしない。候補の説明用。vocab.js)。
  //   返り値 { ok, how, leaves: [{ item, how, from, where, expect, depth }], stations: [要る作業台・かまど], tools: [要る道具], main: 主な入手元 }
  //   main: ゴールの物そのものの入手元、焼く物ならその焼く前の物の入手元
  explain(item) {
    const top = this.cost(item);
    if (!Number.isFinite(top.c)) return { ok: false };
    const costs = this.costs();
    const leaves = []; const stations = new Set(); const tools = new Map(); // 道具 → いちばん浅い深さ
    const seen = new Set();
    const walk = (it, depth) => {
      if (seen.has(it) || depth > MAX_DEPTH) return;
      seen.add(it);
      const o = costs.get(it) || this.bestOption(it, costs);
      if (!o || o.how === 'have' || o.how === 'chest' || !Number.isFinite(o.c)) return;
      if (o.how === 'collect' || o.how === 'kill') {
        leaves.push({ item: it, how: o.how, from: o.from, where: o.where, expect: o.expect || 1, depth });
        if (o.tool) { if (!tools.has(o.tool)) tools.set(o.tool, depth); walk(o.tool, depth + 1); }
        return;
      }
      if (o.how === 'craft') {
        if (o.recipe.table && !this.stationAvail('crafting_table')) { stations.add('crafting_table'); walk('crafting_table', depth + 1); }
        for (const ing of Object.keys(o.recipe.ings)) walk(ing, depth + 1);
        return;
      }
      if (o.how === 'smelt') {
        if (!this.stationAvail('furnace')) { stations.add('furnace'); walk('furnace', depth + 1); }
        walk(o.from, depth + 1);
      }
      if (o.how === 'tree') {
        leaves.push({ item: it, how: 'tree', from: o.sapling, where: o.where, expect: 1, depth });
        if (o.where !== 'growing') walk(o.sapling, depth + 1);
        return;
      }
      if (o.how === 'farm') {
        leaves.push({ item: it, how: 'farm', from: o.crop, where: (this.farm.growing[o.crop] || 0) > 0 ? 'growing' : 'plant', expect: 1, depth });
        if ((this.farm.growing[o.crop] || 0) === 0 && FARM[it].seed !== it) walk(FARM[it].seed, depth + 1);
        if ((this.farm.growing[o.crop] || 0) === 0 && !(this.farm.empty > 0) && !HOES.some((h) => this.hasTool(h))) {
          const h = HOES.map((x) => ({ x, c: costs.has(x) ? costs.get(x).c : Infinity })).sort((a, b) => a.c - b.c)[0];
          if (h && Number.isFinite(h.c)) { if (!tools.has(h.x)) tools.set(h.x, depth); walk(h.x, depth + 1); }
        }
      }
    };
    walk(item, 0);
    let main = leaves.find((l) => l.item === item) || null;
    if (!main && top.how === 'smelt') main = leaves.find((l) => l.item === top.from) || null;
    // 道具は浅い順 (ゴールに近い所で要る物から)
    return { ok: true, how: top.how, c: top.c, leaves, stations: [...stations], tools: [...tools].sort((a, b) => a[1] - b[1]).map(([t]) => t), main };
  }

  // いくつかの物をまとめて手に入れる道筋 (状態のゴール用。states.js)。list = [{ item, count }]。持ち物・作った余りは前の物と分け合う
  planMany(list) {
    const sim = this.newSim();
    this.sim = sim; this.dirty = true;
    let ok = true; let missing = null;
    try {
      for (const x of list || []) {
        const item = this.resolve(x.item);
        const n = Math.max(0, Math.floor(x.count) || 0);
        if (!n) continue;
        if (!item) { ok = false; missing = x.item; break; }
        if (!this.expand(item, n, sim)) { ok = false; missing = sim.fail || item; break; }
      }
    } finally { this.sim = null; this.dirty = true; }
    const steps = mergeSteps(sim.out);
    return ok ? { ok: true, steps, next: steps[0] || null, done: steps.length === 0 } : { ok: false, reason: 'untraceable', missing, steps };
  }

  // 手間の目安 (持ち物を引いたあとの、1個あたりの手間 × 数 の和)。言葉にするのは effortWord()
  effort(list) {
    let c = 0;
    const inv = { ...this.inv0 };
    for (const x of list || []) {
      const item = this.resolve(x.item);
      if (!item) return Infinity;
      const have = Math.min(inv[item] || 0, x.count);
      inv[item] = (inv[item] || 0) - have;
      const left = x.count - have;
      if (left > 0) {
        // 持ち物を引いた状態では cost() は 0 を返すので、足りない分は持っていないときの手間で数える
        const per = (this.inv0[item] || 0) > 0 ? this.costWithout(item) : this.cost(item).c;
        c += per * left;
      }
    }
    return c;
  }

  // 持ち物に item が無いとしたときの1個の手間
  costWithout(item) {
    const save = this.inv0[item];
    this.inv0[item] = 0; this.dirty = true;
    try { return this.cost(item).c; } finally { this.inv0[item] = save; this.dirty = true; }
  }

  // 名前の正規化: アイテム名そのもの / "bed" のような種類の名前 (… _bed のうち手間の小さいもの)
  resolve(name) {
    const s = String(name || '').trim().toLowerCase().replace(/\s+/g, '_');
    if (!s) return null;
    if (this.isItem(s)) return s;
    const fam = this.ix.md.itemsArray.filter((it) => it.name.endsWith(`_${s}`)).map((it) => it.name);
    if (!fam.length) return null;
    let best = null;
    for (const f of fam) { const c = this.cost(f).c; if (!best || c < best.c) best = { f, c }; }
    return best && Number.isFinite(best.c) ? best.f : fam[0];
  }
}

// 同じ物を同じやり方で手に入れる手順は1つにまとめる (最初に出た所に、数を足して)
function mergeSteps(out) {
  const res = [];
  for (const s of out) {
    const same = res.find((r) => r.item === s.item && r.how === s.how && r.from === s.from);
    if (same) {
      same.count += s.count;
      if (s.tries != null) same.tries = (same.tries || 0) + s.tries;
      if (s.how === 'tree') for (const k of ['plants', 'growing', 'trees']) same[k] = (same[k] || 0) + (s[k] || 0);
      if (s.ings) for (const [k, v] of Object.entries(s.ings)) same.ings[k] = (same.ings[k] || 0) + v;
    } else res.push({ ...s, ings: s.ings ? { ...s.ings } : undefined });
  }
  return res;
}

const WHERE_JA = { visible: '見える', known: '前に見た', unseen: 'まだ見ていない' };

// 1つの手順の短い文: "oak_log 2 ← 掘る(見える)"、"oak_planks 4 ← oak_log 1"、"white_bed 1 ← white_wool 3 + oak_planks 3 (crafting_table)"
function stepText(s) {
  const n = `${s.item} ${s.count}`;
  if (s.how === 'chest') return `${n} ← 共有のチェスト ${s.from}`;
  if (s.how === 'collect') return `${n} ← ${s.from === s.item ? (CROP_BLOCKS.test(s.from) ? '取る' : '掘る') : s.from}(${WHERE_JA[s.where] || ''}${s.tool ? `・${s.tool}` : ''})`;
  if (s.how === 'kill') return `${n} ← ${s.from}(${WHERE_JA[s.where] || ''})`;
  if (s.how === 'craft') return `${n} ← ${Object.entries(s.ings).map(([k, v]) => `${k} ${v}`).join(' + ')}${s.station ? ` (${s.station})` : ''}`;
  if (s.how === 'smelt') return `${n} ← ${s.from} ${s.count} を焼く (furnace・${s.fuel})`;
  if (s.how === 'farm') return `${n} ← ${farmText(s)}`;
  if (s.how === 'tree') return `${n} ← ${treeText(s)}`;
  return n;
}

// 畑の手順の文: 耕す → 植える → 育つ → 取る のうち、残っている所から
function farmText(s) {
  const parts = [];
  if (s.till > 0 && s.water) parts.push(farmwater.waterText(s.water));
  if (s.till > 0) parts.push(`耕す ${s.till} (${s.tool} を水から4マス以内の土に)`);
  if (s.plants > 0) parts.push(`${s.seed} ${s.plants} を耕地に植える`);
  if (s.growing > 0) parts.push(`植わっている ${s.crop} ${s.growing}${s.at ? ` (${s.at})` : ''}`);
  parts.push(`育ったら ${s.crop} を壊して取る${s.rounds > 1 ? ` (植えて取るのを${s.rounds}回)` : ''}`);
  return parts.join(' → ');
}
// 木の手順の文: 植える → 育つ → 切る のうち、残っている所から。
//   「oak_log 4 ← oak_sapling 1 を植える (grass_block の上・明るい所・上に空き) → 育つ (約15分) → 切る」
const GROUND_WHERE_JA = { visible: '', known: '前に見た', unknown: '' };
function waitWord(s) { const [a, b] = s.waitMin || TREE_WAIT_MIN; return `約${Math.round((a + b) / 2)}分`; }
function treeText(s) {
  const parts = [];
  if (s.growing > 0) parts.push(`植わっている ${s.sapling} ${s.growing}${s.at ? ` (${s.at})` : ''}`);
  if (s.plants > 0) parts.push(`${s.sapling} ${s.plants} を${s.k > 1 ? '2x2 で' : ''}植える (${GROUND_WHERE_JA[s.groundWhere] || ''}${s.ground} の上・明るい所・上に空き)`);
  parts.push(s.plants > 0 ? `育つ (${waitWord(s)})` : '育っている頃に戻る');
  parts.push('切る');
  return parts.join(' → ');
}
function treeNext(s) {
  if (s.plants > 0) return `${s.sapling} を ${s.ground} に${s.k > 1 ? '2x2 で' : ''}植える (明るい所・上に空き)`;
  if (s.growing > 0) return `育っている頃に戻る (植わっている ${s.sapling} ${s.growing}${s.at ? `、${s.at}` : ''})`;
  return `木に育ったら ${s.item} を切る`;
}
function treeTextEn(s) {
  const parts = [];
  if (s.growing > 0) parts.push(`${s.growing} ${s.sapling} planted already${s.at ? ` (${s.at})` : ''}`);
  if (s.plants > 0) parts.push(`plant ${s.plants} ${s.sapling}${s.k > 1 ? ' in a 2x2' : ''} (on ${s.groundWhere === 'known' ? 'seen-before ' : ''}${s.ground}, in light, space above)`);
  const [a, b] = s.waitMin || TREE_WAIT_MIN;
  parts.push(s.plants > 0 ? `grows (about ${Math.round((a + b) / 2)} min)` : 'come back once it has grown');
  parts.push('cut');
  return parts.join(' -> ');
}
function treeNextEn(s) {
  if (s.plants > 0) return `plant ${s.sapling}${s.k > 1 ? ' in a 2x2' : ''} on ${s.ground} (in light, space above)`;
  if (s.growing > 0) return `come back once it has grown (${s.growing} ${s.sapling} planted${s.at ? `, ${s.at}` : ''})`;
  return `when it has grown into a tree, cut it for ${s.item}`;
}
function farmNext(s) {
  if (s.till > 0 && s.water) return `${farmwater.waterText(s.water)} → 水から4マス以内の土を ${s.tool} で耕す`;
  if (s.till > 0) return `${s.tool} で水から4マス以内の土を耕して耕地にする`;
  if (s.plants > 0) return `${s.seed} を耕地に植える`;
  if (s.growing > 0) return `育っている頃に戻る (植わっている ${s.crop} ${s.growing}${s.at ? `、${s.at}` : ''})`;
  return `${s.crop} が育ちきったら壊して ${s.item} を取る`;
}
function farmTextEn(s) {
  const parts = [];
  if (s.till > 0 && s.water) parts.push(farmwater.waterTextEn(s.water));
  if (s.till > 0) parts.push(`till ${s.till} (${s.tool} on dirt within 4 blocks of water)`);
  if (s.plants > 0) parts.push(`plant ${s.plants} ${s.seed} on farmland`);
  if (s.growing > 0) parts.push(`${s.growing} ${s.crop} planted already${s.at ? ` (${s.at})` : ''}`);
  parts.push(`break fully grown ${s.crop}${s.rounds > 1 ? ` (plant and harvest ${s.rounds} times)` : ''}`);
  return parts.join(' -> ');
}
function farmNextEn(s) {
  if (s.till > 0 && s.water) return `${farmwater.waterTextEn(s.water)} -> till dirt within 4 blocks of water with ${s.tool}`;
  if (s.till > 0) return `till dirt within 4 blocks of water into farmland with ${s.tool}`;
  if (s.plants > 0) return `plant ${s.seed} on farmland`;
  if (s.growing > 0) return `come back once it has grown (${s.growing} ${s.crop} planted${s.at ? `, ${s.at}` : ''})`;
  return `when ${s.crop} is fully grown, break it for ${s.item}`;
}

function nextText(s) {
  if (!s) return '';
  if (s.how === 'craft') return `${s.item} を作る`;
  if (s.how === 'chest') return `共有のチェスト ${s.from} から ${s.item} を出す`;
  if (s.how === 'smelt') return `${s.from} を焼いて ${s.item} にする`;
  if (s.how === 'farm') return farmNext(s);
  if (s.how === 'tree') return treeNext(s);
  if ((s.how === 'kill' || s.how === 'collect') && s.from && s.from !== s.item) return `${s.from} から ${s.item} を手に入れる`;
  return `${s.item} を手に入れる`;
}

// 英語 (Jev 用。同じ手順から)
function chestEn(id) { const m = String(id).match(/^(.+)-(\d+)$/); return m ? `${m[1]}'s chest ${m[2]} (shared)` : `${id} (shared chest)`; }
const WHERE_EN = { visible: 'visible', known: 'seen before', unseen: 'not seen yet' };
function stepTextEn(s) {
  const n = `${s.item} x${s.count}`;
  const w = [WHERE_EN[s.where], s.tool ? `with ${s.tool}` : ''].filter(Boolean).join(', ');
  if (s.how === 'chest') return `${n} <- take from ${chestEn(s.from)}`;
  if (s.how === 'collect') return `${n} <- ${s.from === s.item ? (CROP_BLOCKS.test(s.from) ? 'harvest' : 'dig') : `from ${s.from}`}${w ? ` (${w})` : ''}`;
  if (s.how === 'kill') return `${n} <- kill ${s.from}${w ? ` (${w})` : ''}`;
  if (s.how === 'craft') return `${n} <- ${Object.entries(s.ings).map(([k, v]) => `${k} x${v}`).join(' + ')}${s.station ? ` (at ${s.station})` : ''}`;
  if (s.how === 'smelt') return `${n} <- smelt ${s.from} x${s.count} (furnace, fuel ${s.fuel})`;
  if (s.how === 'farm') return `${n} <- ${farmTextEn(s)}`;
  if (s.how === 'tree') return `${n} <- ${treeTextEn(s)}`;
  return n;
}
function nextTextEn(s) {
  if (!s) return '';
  if (s.how === 'craft') return `make ${s.item}`;
  if (s.how === 'chest') return `take ${s.item} out of ${chestEn(s.from)}`;
  if (s.how === 'smelt') return `smelt ${s.from} into ${s.item}`;
  if (s.how === 'farm') return farmNextEn(s);
  if (s.how === 'tree') return treeNextEn(s);
  if (s.how === 'kill' && s.from) return `get ${s.item} by killing ${s.from}`;
  if (s.how === 'collect' && s.from && s.from !== s.item) return `get ${s.item} from ${s.from}`;
  return `get ${s.item}`;
}
// Jev の state.plan.path (配列) と next
function pathEn(p, { maxShown = 5 } = {}) {
  if (!p || !p.ok) return null;
  if (p.done) return { path: 'everything is in hand', next: null };
  const shown = p.steps.slice(0, maxShown).map(stepTextEn);
  if (p.steps.length > maxShown) shown.push(`and ${p.steps.length - maxShown} more`);
  return { path: shown, next: nextTextEn(p.next) };
}

// Jev の state.plan に出す道筋の文 (短く。maxShown 手順まで)
function pathText(p, { maxShown = 5 } = {}) {
  if (!p || !p.ok) return '';
  if (p.done) return '道筋: 揃っている';
  const shown = p.steps.slice(0, maxShown).map(stepText);
  const more = p.steps.length > maxShown ? ` ほか${p.steps.length - maxShown}` : '';
  return `道筋: ${shown.join('、')}${more} / 次: ${nextText(p.next)}`;
}

// 残っている量の目安 (詰まりの判断用): 手順の数 × 100 + 次の物の残りの数
function remaining(p) {
  if (!p || !p.ok) return Infinity;
  return p.steps.reduce((t, s) => t + s.count, 0) + p.steps.length * 100;
}

// 植える・使うことに意味のある、ブロックとしても置ける物 (苗木・サトウキビなど。use_on の持ち物の側に残す)
const PLANTABLE = /_sapling$|_propagule$|^(sugar_cane|bamboo|cactus|nether_wart|kelp|sea_pickle|lily_pad|brown_mushroom|red_mushroom|crimson_fungus|warped_fungus|azalea|flowering_azalea|.*_seeds|sweet_berries|glow_berries|cocoa_beans|pitcher_pod)$/;
// minecraft-data でブロックとして置ける物か (植える物は除く)。use_on の持ち物の側から外すのに使う
function isPlaceableBlockItem(name, version = DEFAULT_VERSION) {
  const md = index(version).md;
  return !!md.blocksByName[name] && !!md.itemsByName[name] && !PLANTABLE.test(name);
}

function plan(target, count, world, opts) { return new Planner(world, opts).plan(target, count); }

// 手間の言葉 (数値はモデルに渡さない): 小 < 5 ≤ 中 < 20 ≤ 大
const EFFORT_WORDS = [[5, '小'], [20, '中'], [Infinity, '大']];
const EFFORT_EN = { なし: 'none', 小: 'small', 中: 'medium', 大: 'large' };
function effortWord(c) {
  if (!Number.isFinite(c)) return null;
  if (c <= 0) return 'なし';
  return EFFORT_WORDS.find(([lim]) => c < lim)[1];
}

module.exports = { TREE, SAPLING_LOG, TREE_GROUND, TREE_WAIT_MIN, treeText, FARM, FARM_CROPS, HOES, farmText, EFFORT_EN, stepTextEn, nextTextEn, pathEn, WHERE_EN, Planner, plan, effortWord, EFFORT_WORDS, CROP_BLOCKS, SAPLING_DROP, isPlaceableBlockItem, PLANTABLE, index, pathText, stepText, nextText, remaining, mergeSteps, GROUND, FUELS, COST, dropFix, blockDropExpect, chanceCost, VOCAB_MIN_CHANCE };
