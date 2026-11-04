'use strict';
// ゴールの候補 (2B に見せる語彙)。物・人・場所。bot に依存しない。
//   物: 持ち物・見えているブロック/生き物から手に入る物・知っていること (facts.json) に出てくる物・覚えている場所の物・
//       これまでのゴールの物・それらからレシピで1〜2段で作れる物。種類違い (木の種類・色) は1つにまとめる。
//       道筋 (planner) でたどれない物は入れない。maxItems 個まで。説明は日本語名と、持っている/見える/食べ物 (仕様) だけ。
//   「この欲求にはこの物」という対応はここでは作らない (2B が選ぶ)。
//   人: 知っている人・見えている人。場所: 拠点・覚えている場所 (M番号)・8方位の遠く (行ったことがあるか)。
const { index, Planner, GROUND } = require('./planner');
const { jaName, WOOD, COLOR } = require('./names_ja');
const { matchName } = require('./knowledge');

const DIRS8 = [['north', '北', 0, -1], ['northeast', '北東', 1, -1], ['east', '東', 1, 0], ['southeast', '南東', 1, 1],
  ['south', '南', 0, 1], ['southwest', '南西', -1, 1], ['west', '西', -1, 0], ['northwest', '北西', -1, -1]];
const PREFIXES = [...Object.keys(WOOD), ...Object.keys(COLOR)].sort((a, b) => b.length - a.length);
// 候補にしない物 (地面そのもの・作れない/使わない物)
const SKIP = /^stripped_|^(bedrock|barrier|command_block|structure_.*|jigsaw|debug_stick|spawner|.*_spawn_egg|knowledge_book|air|light|petrified_oak_slab|player_head)$/;

// 種類違いをまとめるキー: "jungle_planks" → "*_planks"、"white_wool" → "*_wool"
function familyKey(name) {
  for (const p of PREFIXES) if (name.startsWith(`${p}_`)) return `*_${name.slice(p.length + 1)}`;
  return name;
}

// items: [{ name, have, seen, src }]。同じ種類違いは、持っている → 見える → 好みの木 (見えている原木の種類)・白 の順に1つ
function collapse(list, woodPref) {
  const by = new Map();
  const rank = (x) => (x.have ? 0 : x.seen ? 1 : x.name.startsWith(`${woodPref}_`) || x.name.startsWith('white_') ? 2 : x.name.startsWith('oak_') ? 3 : 4);
  for (const x of list) {
    const k = familyKey(x.name);
    const cur = by.get(k);
    if (!cur || rank(x) < rank(cur) || (rank(x) === rank(cur) && x.order < cur.order)) by.set(k, { ...x, order: Math.min(x.order, cur ? cur.order : x.order) });
  }
  return [...by.values()].sort((a, b) => a.order - b.order);
}

// ctx = { raw, facts: [{items}], placeKinds: [覚えている場所の種類], history: [{kind,target}], version, maxItems, recipeHops }
function itemCandidates(ctx) {
  const ix = index(ctx.version);
  const md = ix.md;
  const raw = ctx.raw || { inventory: [], blocks: [], entities: [] };
  const inv = new Map((raw.inventory || []).map((i) => [i.name, i.count]));
  const seenNames = new Set([...(raw.blocks || []).map((b) => b.name), ...(raw.entities || []).filter((e) => e.kind === 'item').map((e) => e.name)]);
  const list = [];
  let order = 0;
  const add = (name, src) => {
    if (!md.itemsByName[name] || SKIP.test(name) || GROUND.test(name) || list.some((x) => x.name === name)) return;
    list.push({ name, have: inv.get(name) || 0, seen: seenNames.has(name), src, order: order++ });
  };
  for (const i of raw.inventory || []) add(i.name, 'inventory');
  for (const b of raw.blocks || []) {
    if (GROUND.test(b.name)) continue;
    for (const [item, srcs] of ix.blocks) if (srcs.some((s) => s.block === b.name)) add(item, 'block');
  }
  for (const e of raw.entities || []) {
    if (e.kind === 'item') add(e.name, 'dropped');
    else if (e.kind !== 'player') for (const [item, mobs] of ix.mobs) if (mobs.includes(e.name)) add(item, 'mob');
  }
  for (const k of ctx.placeKinds || []) add(k, 'place');
  for (const h of ctx.history || []) if (h.kind === 'item') add(h.target, 'history');
  const allNames = md.itemsArray.map((it) => it.name);
  for (const f of ctx.facts || []) for (const p of f.items || []) for (const n of allNames) if (matchName(p, n)) add(n, 'facts');
  // レシピで近い物: 今の集まりの物を材料に使うレシピの出来上がり (recipeHops 段まで)
  const hops = ctx.recipeHops ?? 1;
  for (let h = 0; h < hops; h++) {
    const have = new Set(list.map((x) => familyKey(x.name)));
    for (const [out, rs] of ix.recipes) {
      if (rs.some((r) => Object.keys(r.ings).some((ing) => have.has(familyKey(ing))))) add(out, `recipe${h + 1}`);
    }
  }
  const woodPref = ((raw.blocks || []).find((b) => /_log$/.test(b.name)) || { name: 'oak_log' }).name.replace(/_log$/, '');
  const planner = new Planner({
    inventory: raw.inventory, visibleBlocks: (raw.blocks || []).map((b) => b.name),
    visibleMobs: (raw.entities || []).filter((e) => e.kind !== 'item' && e.kind !== 'player').map((e) => e.name), knownBlocks: ctx.placeKinds || [],
  }, { index: ix });
  const out = collapse(list, woodPref).filter((x) => x.have || Number.isFinite(planner.cost(x.name).c));
  // 段の順 (持ち物・見える物 → 知っていること → レシピで近い物) を保ったまま maxItems まで
  const pri = { inventory: 0, dropped: 1, block: 1, mob: 1, place: 2, history: 2, facts: 3, recipe1: 4, recipe2: 5 };
  out.sort((a, b) => (pri[a.src] - pri[b.src]) || (a.order - b.order));
  const foods = md.foodsByName || {};
  return out.slice(0, ctx.maxItems ?? 40).map((x) => ({
    name: x.name,
    desc: [jaName(x.name), foods[x.name] ? '食べ物' : null, x.have ? `持っている${x.have}` : null, x.seen ? '見える' : null].filter(Boolean).join('・'),
  }));
}

// 人: { name, desc }。people = [{ name, relation, seen }]
function personCandidates(people) {
  return (people || []).map((p) => ({ name: p.name, desc: [p.relation, p.seen ? `今は${p.seen}にいる` : '今は見えない'].filter(Boolean).join('・') }));
}

// 場所: 拠点・覚えている場所 (M番号、拠点以外)・8方位の遠く。cellAt(x, z) → 行ったマス | null
function placeCandidates({ here, base = null, baseLabel = null, places = [], cellAt = null, far = 48, maxPlaces = 4 } = {}) {
  const out = [];
  if (base) out.push({ name: '拠点', desc: baseLabel || '自分の拠点', pos: base, type: 'base' });
  for (const p of places.filter((q) => q.kind !== '拠点').slice(0, maxPlaces)) out.push({ name: p.id, desc: p.label, pos: p.pos, type: 'memory' });
  for (const [id, ja, dx, dz] of DIRS8) {
    const l = Math.hypot(dx, dz);
    const x = here ? here.x + (dx / l) * far : 0; const z = here ? here.z + (dz / l) * far : 0;
    const c = cellAt && here ? cellAt(x, z) : null;
    out.push({ name: `${ja}の方`, desc: c ? `${far}mほど先・行ったことがある` : `${far}mほど先・行ったことがない`, dir: id, vec: [dx / l, dz / l], type: 'dir' });
  }
  return out;
}

module.exports = { itemCandidates, personCandidates, placeCandidates, familyKey, collapse, DIRS8 };
