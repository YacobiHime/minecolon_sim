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

const DEFAULT_VERSION = '1.20.1';
const COST = { visible: 1, known: 2, unseen: 6, unseenRare: 12, mobVisible: 2, mobUnseen: 6, mobRare: Infinity, craft: 0.3, smelt: 0.6, toolShare: 0.5, stationShare: 0.5 };
// 地上・浅い所でふつうに見つかるブロックと生き物 (まだ見ていなくても、探せば見つかるとみなす手間を小さくする)。
// それ以外の自然のブロックは手間を大きく見る。それ以外の生き物は、見えていなければ入手元にしない (ネザーにしかいない・村のゴーレム等)
const COMMON_BLOCKS = /_log$|_leaves$|^(stone|deepslate|sand|gravel|clay|grass|tall_grass|fern|coal_ore|iron_ore|copper_ore|sugar_cane|pumpkin|melon|wheat|carrots|potatoes|beetroots|sweet_berry_bush|andesite|diorite|granite|water)$/;
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
// 落ちる物のうち、とても出にくいもの (ゾンビの鉄など) は入手元にしない
const MIN_DROP_CHANCE = 0.05;

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
    const tools = b.harvestTools ? Object.keys(b.harvestTools).map((id) => name(Number(id))).filter(Boolean) : null;
    const seen = new Set();
    for (const d of bl.drops || []) {
      if (d.silkTouch || seen.has(d.item) || !md.itemsByName[d.item] || (d.dropChance ?? 1) < MIN_DROP_CHANCE) continue;
      seen.add(d.item);
      blocks.set(d.item, [...(blocks.get(d.item) || []), { block: bl.block, tools }]);
    }
  }
  const mobs = new Map(); // 物 → [生き物]
  for (const el of md.entityLootArray || []) {
    for (const d of el.drops || []) {
      if ((d.dropChance ?? 1) < MIN_DROP_CHANCE || !md.itemsByName[d.item]) continue;
      const l = mobs.get(d.item) || [];
      if (!l.includes(el.entity)) mobs.set(d.item, [...l, el.entity]);
    }
  }
  for (const [mob, items] of Object.entries(EXTRA_MOB_DROPS)) for (const it of items) { const l = mobs.get(it) || []; if (!l.includes(mob)) mobs.set(it, [...l, mob]); }
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
//           stations: { crafting_table: bool, furnace: bool } (見えている・覚えている), excludeBlocks: RegExp }
class Planner {
  constructor(world = {}, opts = {}) {
    this.ix = opts.index || index(opts.version || DEFAULT_VERSION);
    this.inv0 = invMap(world.inventory);
    this.vis = new Set(world.visibleBlocks || []);
    this.mobsVis = new Set(world.visibleMobs || []);
    this.known = new Set(world.knownBlocks || []);
    this.stations0 = { crafting_table: false, furnace: false, ...(world.stations || {}) };
    this.exclude = world.excludeBlocks || GROUND;
    this.reach = null; this.costCache = null; this.dirty = true;
  }

  isItem(n) { return !!this.ix.md.itemsByName[n]; }

  // 道筋を作っている途中の持ち物 (使った分を引いたもの)。plan() の外では最初の持ち物
  curInv() { return this.sim ? this.sim.inv : this.inv0; }

  hasTool(t) { return this.sim ? this.sim.tools.has(t) : (this.inv0[t] || 0) > 0; }

  curStations() { return this.sim ? this.sim.stations : this.stations0; }

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
    }
    return seen;
  }

  // 1つの物の、今の手間の表 (costs) から見たいちばん小さいやり方
  bestOption(item, costs) {
    if ((this.curInv()[item] || 0) > 0) return { c: 0, how: 'have' };
    const cOf = (n) => (costs.has(n) ? costs.get(n).c : Infinity);
    let best = { c: Infinity };
    const consider = (o) => { if (o.c < best.c) best = o; };
    for (const s of this.ix.blocks.get(item) || []) {
      if (this.exclude.test(s.block)) continue;
      const where = this.vis.has(s.block) ? 'visible' : this.known.has(s.block) ? 'known' : (this.natural(s.block) ? 'unseen' : null);
      if (!where) continue;
      let c = where === 'unseen' && !COMMON_BLOCKS.test(s.block) ? COST.unseenRare : COST[where];
      let tool = null;
      if (s.tools && !s.tools.some((t) => this.hasTool(t))) {
        let tb = { c: Infinity };
        for (const t of s.tools) { const tc = cOf(t); if (tc < tb.c) tb = { c: tc, t }; }
        if (!Number.isFinite(tb.c)) continue;
        c += tb.c * COST.toolShare; tool = tb.t;
      }
      consider({ c, how: 'collect', from: s.block, where, tool });
    }
    for (const m of this.ix.mobs.get(item) || []) {
      const where = this.mobsVis.has(m) ? 'visible' : 'unseen';
      consider({ c: where === 'visible' ? COST.mobVisible : COMMON_MOBS.test(m) ? COST.mobUnseen : COST.mobRare, how: 'kill', from: m, where });
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
    return best;
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
    if (stack.includes(item) || stack.length > MAX_DEPTH * 2) return false;
    const st = [...stack, item];
    const best = this.cost(item);
    if (!Number.isFinite(best.c)) { sim.fail = sim.fail || item; return false; }
    if (best.how === 'collect') {
      if (best.tool && !sim.tools.has(best.tool)) {
        if (!this.expand(best.tool, 1, sim, st)) return false;
        sim.tools.add(best.tool); this.dirty = true;
      }
      sim.out.push({ item, count: n, how: 'collect', from: best.from, where: best.where, tool: best.tool || null });
      return true;
    }
    if (best.how === 'kill') { sim.out.push({ item, count: n, how: 'kill', from: best.from, where: best.where }); return true; }
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

  plan(target, count = 1) {
    const item = this.resolve(target);
    if (!item) return { ok: false, target, reason: 'unknown', text: `${target} という物は知らない` };
    const sim = { inv: { ...this.inv0 }, out: [], stations: { ...this.stations0 }, tools: new Set(Object.keys(this.inv0).filter((k) => this.inv0[k] > 0)) };
    const n = Math.max(1, Math.floor(count) || 1);
    this.sim = sim; this.dirty = true;
    let ok;
    try { ok = this.expand(item, n, sim); } finally { this.sim = null; this.dirty = true; }
    if (!ok) return { ok: false, target: item, count: n, reason: 'untraceable', missing: sim.fail || item, steps: sim.out };
    const steps = mergeSteps(sim.out);
    return { ok: true, target: item, count: n, steps, next: steps[0] || null, done: steps.length === 0 };
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
      if (s.ings) for (const [k, v] of Object.entries(s.ings)) same.ings[k] = (same.ings[k] || 0) + v;
    } else res.push({ ...s, ings: s.ings ? { ...s.ings } : undefined });
  }
  return res;
}

const WHERE_JA = { visible: '見える', known: '前に見た', unseen: 'まだ見ていない' };

// 1つの手順の短い文: "oak_log 2 ← 掘る(見える)"、"oak_planks 4 ← oak_log 1"、"white_bed 1 ← white_wool 3 + oak_planks 3 (crafting_table)"
function stepText(s) {
  const n = `${s.item} ${s.count}`;
  if (s.how === 'collect') return `${n} ← ${s.from === s.item ? (CROP_BLOCKS.test(s.from) ? '取る' : '掘る') : s.from}(${WHERE_JA[s.where] || ''}${s.tool ? `・${s.tool}` : ''})`;
  if (s.how === 'kill') return `${n} ← ${s.from}(${WHERE_JA[s.where] || ''})`;
  if (s.how === 'craft') return `${n} ← ${Object.entries(s.ings).map(([k, v]) => `${k} ${v}`).join(' + ')}${s.station ? ` (${s.station})` : ''}`;
  if (s.how === 'smelt') return `${n} ← ${s.from} ${s.count} を焼く (furnace・${s.fuel})`;
  return n;
}

function nextText(s) {
  if (!s) return '';
  if (s.how === 'craft') return `${s.item} を作る`;
  if (s.how === 'smelt') return `${s.from} を焼いて ${s.item} にする`;
  if ((s.how === 'kill' || s.how === 'collect') && s.from && s.from !== s.item) return `${s.from} から ${s.item} を手に入れる`;
  return `${s.item} を手に入れる`;
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

module.exports = { Planner, plan, isPlaceableBlockItem, PLANTABLE, index, pathText, stepText, nextText, remaining, mergeSteps, GROUND, FUELS, COST };
