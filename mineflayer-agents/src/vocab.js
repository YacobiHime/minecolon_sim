'use strict';
// ゴールの候補 (2B に見せる語彙)。物・人・場所。bot に依存しない。
//   物: 持ち物・見えているブロック/生き物から手に入る物・知っていること (facts.json) に出てくる物・覚えている場所の物・
//       これまでのゴールの物・それらからレシピで1〜2段で作れる物。種類違い (木の種類・色) は1つにまとめる。
//       道筋 (planner) でたどれない物は入れない。maxItems 個まで。
//       説明は、日本語名・仕様の事実 (食べ物と満腹度・寝られる・明るさ など。USE_SPEC)・持っている数と、
//       先にたどった道筋 (planner) から言葉にした事実 (入手元が見えるか・まれに落ちるか・作業台/かまど/道具が要るか・手間 小/中/大)。
//   「この欲求にはこの物」という対応はここでは作らない (2B が選ぶ)。
//   人: 知っている人・見えている人。場所: 拠点・覚えている場所 (M番号)・8方位の遠く (行ったことがあるか)。
const { commonRef } = require('./places');
const { index, Planner, GROUND, VOCAB_MIN_CHANCE, effortWord, CROP_BLOCKS, EFFORT_EN, FARM } = require('./planner');
const { dir8En } = require('./en');
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
function foodsOf(md) { return md.foodsByName || {}; }

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
    for (const [item, srcs] of ix.blocks) if (srcs.some((s) => s.block === b.name && (s.rawChance ?? 1) >= VOCAB_MIN_CHANCE)) add(item, 'block');
  }
  for (const e of raw.entities || []) {
    if (e.kind === 'item') add(e.name, 'dropped');
    else if (e.kind !== 'player') for (const [item, mobs] of ix.mobs) if (mobs.some((m) => m.mob === e.name && (m.rawChance ?? 1) >= VOCAB_MIN_CHANCE)) add(item, 'mob');
  }
  for (const k of ctx.placeKinds || []) add(k, 'place');
  // 焼いてできる食べ物: 持ち物・見える物・見える生き物から取れる物を焼いた物 (beef → cooked_beef)
  for (const x of [...list]) {
    if (!['inventory', 'block', 'mob', 'dropped'].includes(x.src)) continue;
    for (const [out, ins] of ix.smelt) if (foodsOf(md)[out] && ins.includes(x.name)) add(out, 'smelt');
  }
  // 畑: 候補にある種 (植える物) から、育てて取れる物と、それを材料にする食べ物 (wheat_seeds → wheat → bread)
  const foodsBy = md.foodsByName || {};
  for (const x of [...list]) {
    const prod = Object.entries(FARM).find(([, f]) => f.seed === x.name);
    if (!prod) continue;
    add(prod[0], 'farm');
    for (const [out, rs] of ix.recipes) if (foodsBy[out] && rs.some((r) => Object.keys(r.ings).length === 1 && r.ings[prod[0]])) add(out, 'farm'); // 収穫物だけで作れる食べ物 (bread)
  }
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
  const planner = new Planner(ctx.world || {
    inventory: raw.inventory, visibleBlocks: (raw.blocks || []).map((b) => b.name),
    visibleMobs: (raw.entities || []).filter((e) => e.kind !== 'item' && e.kind !== 'player').map((e) => e.name), knownBlocks: ctx.placeKinds || [],
  }, { index: ix });
  const out = collapse(list, woodPref).filter((x) => x.have || Number.isFinite(planner.cost(x.name).c));
  // 段の順 (持ち物・見える物 → 知っていること → レシピで近い物) を保ったまま maxItems まで
  const pri = { inventory: 0, dropped: 1, block: 1, mob: 1, place: 2, history: 2, smelt: 2, farm: 2, facts: 3, recipe1: 4, recipe2: 5 };
  out.sort((a, b) => (pri[a.src] - pri[b.src]) || (a.order - b.order));
  const foods = md.foodsByName || {};
  const annotate = ctx.annotate !== false;
  // 持っている物は「もう持っている n」を事実として付ける (R2。2B が選んだ数が持っている数以下なら goalpath が外す)
  // descEn: Jev に渡す英語 (同じ値から)
  return out.slice(0, ctx.maxItems ?? 40).map((x) => {
    const head = [jaName(x.name), useSpec(x.name, md, foods), x.have ? `もう持っている${x.have}` : null, !annotate && x.seen ? '見える' : null].filter(Boolean).join('・');
    const headEn = [x.name, useSpec(x.name, md, foods, 'en'), x.have ? `already have ${x.have}` : null, !annotate && x.seen ? 'visible' : null].filter(Boolean).join('; ');
    if (!annotate || x.have) return { name: x.name, desc: head, descEn: headEn, have: x.have };
    const ex = planner.explain(x.name);
    const ann = ex.ok ? pathFacts(ex, raw, { target: x.name }) : [];
    const annEn = ex.ok ? pathFacts(ex, raw, { target: x.name, lang: 'en' }) : [];
    const eff = ex.ok ? effortWord(ex.c) : null;
    return { name: x.name, desc: [head, ...ann, eff ? `手間: ${eff}` : null].filter(Boolean).join('。'), descEn: [headEn, ...annEn, eff ? `effort ${EFFORT_EN[eff] || eff}` : null].filter(Boolean).join('; '), effort: eff, have: 0 };
  });
}

// 仕様の事実 (物の働き。どう使うとよいかは書かない): 食べ物と満腹度・寝られる・明るさ・入れられる数・柵の高さ・耕せる
function useSpec(name, md, foods = md.foodsByName || {}, lang = 'ja') {
  const en = lang === 'en';
  if (foods[name]) return en ? `food (restores ${foods[name].foodPoints} food points)` : `食べ物 (満腹度+${foods[name].foodPoints})`;
  if (/_bed$/.test(name)) return en ? 'can be slept in' : '寝られる';
  const b = md.blocksByName[name];
  if (b && b.emitLight > 0 && !/^(lava|fire|soul_fire|magma_block)$/.test(name)) return en ? `light source (light level ${b.emitLight})` : `明かり (明るさ${b.emitLight})`;
  if (/^(chest|barrel|trapped_chest)$/.test(name)) return en ? 'holds items (27 slots)' : '物を入れられる (27マス)';
  if (/_fence$|_fence_gate$|_wall$/.test(name)) return en ? '1.5 blocks high (cannot be jumped over)' : '高さ1.5 (跳び越えられない)';
  if (/_hoe$/.test(name)) return en ? 'used on dirt, makes farmland' : '土に使ったとき耕地になる';
  return null;
}

const DIR8 = ['東', '南東', '南', '南西', '西', '北西', '北', '北東'];
// 8方位の言葉 (x+ = 東, z+ = 南)。近ければ「すぐそば」
function dir8(from, to) {
  if (!from || !to) return null;
  const dx = to.x - from.x; const dz = to.z - from.z;
  if (Math.hypot(dx, dz) < 3) return 'すぐそば';
  const a = Math.atan2(dz, dx); // 0 = 東、π/2 = 南
  return DIR8[((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8];
}

function rareWord(expect, lang = 'ja') { return lang === 'en' ? (expect < 0.05 ? 'rarely' : expect < 0.5 ? 'sometimes' : '') : expect < 0.05 ? 'まれに' : expect < 0.5 ? 'ときどき' : ''; }

// 道筋 (planner.explain の結果) から、入手元・要る物を言葉にする (最大 maxFacts 個)。順は
//   主な入手元 (ゴールの物そのもの・焼く前の物の入手元) → 要る道具 → かまど → まだ見ていない・まれにしか落ちない入手元 → 作業台
//   (道具・かまど・作業台は、持っていない・見えていない・覚えていないときだけ)
function pathFacts(ex, raw, { maxFacts = 3, target = null, lang = 'ja' } = {}) {
  if (lang === 'en') return pathFactsEn(ex, raw, { maxFacts, target });
  const here = raw && raw.self ? raw.self.pos : null;
  const posOf = (s) => {
    if (s.how === 'kill') { const e = (raw.entities || []).find((x) => x.name === s.from && x.kind !== 'player' && x.kind !== 'item'); return e ? e.pos : null; }
    const b = (raw.blocks || []).find((x) => x.name === s.from); return b ? b.nearest : null;
  };
  const vis = (s) => {
    if (s.where === 'visible') { const d = dir8(here, posOf(s)); return d ? (d === 'すぐそば' ? 'すぐそばに見える' : `${d}に見える`) : '見える'; }
    return s.where === 'known' ? '前に見た' : 'まだ見ていない';
  };
  const say = (s) => {
    const rare = rareWord(s.expect);
    if (s.how === 'farm') return s.where === 'growing' ? `${s.from} が近くの耕地に植わっている (育ちきったら取れる)` : `${FARM[s.item].seed} を耕地に植えると育つ`;
    if (s.how === 'tree') return s.where === 'growing' ? `${s.from} が近くに植わっている (木に育ったら切れる)` : `${s.from} を土・草の生えた土に植えると木に育つ`;
    if (s.how === 'kill') return `${s.from} ${s.where === 'visible' ? 'が' : 'は'}${vis(s)}${rare ? ` (${rare}落とす)` : ''}`;
    if (s.from === s.item) return CROP_BLOCKS.test(s.from) ? `育った所が${vis(s)}` : vis(s);
    return `${s.item === target ? '' : `${s.item} は `}${s.from} から${rare}落ちる (${s.from} は${vis(s)})`;
  };
  const out = [];
  if (ex.main) out.push(say(ex.main));
  // 道具はいちばん浅い所で要る1つだけ (その道具を作るのに要る道具は書かない)。作業台は最後 (多くの物で要る)
  if (ex.tools.length) out.push(`${ex.tools[0]} が要る`);
  if (ex.stations.includes('furnace')) out.push('furnace が要る');
  for (const l of ex.leaves) if (l !== ex.main && (l.where !== 'visible' || l.expect < 0.5)) out.push(say(l));
  if (ex.stations.includes('crafting_table')) out.push('crafting_table が要る');
  return [...new Set(out)].slice(0, maxFacts);
}

// pathFacts の英語 (同じ道筋から)
function pathFactsEn(ex, raw, { maxFacts = 3, target = null } = {}) {
  const here = raw && raw.self ? raw.self.pos : null;
  const posOf = (s) => {
    if (s.how === 'kill') { const e = (raw.entities || []).find((x) => x.name === s.from && x.kind !== 'player' && x.kind !== 'item'); return e ? e.pos : null; }
    const b = (raw.blocks || []).find((x) => x.name === s.from); return b ? b.nearest : null;
  };
  const vis = (s) => {
    if (s.where === 'visible') { const d = dir8En(here, posOf(s)); return d ? (d === 'here' ? 'visible right here' : `visible to the ${d}`) : 'visible'; }
    return s.where === 'known' ? 'seen before' : 'not seen yet';
  };
  const say = (s) => {
    const rare = rareWord(s.expect, 'en');
    if (s.how === 'farm') return s.where === 'growing' ? `${s.from} planted on farmland nearby (can be taken when fully grown)` : `grows from ${FARM[s.item].seed} planted on farmland`;
    if (s.how === 'tree') return s.where === 'growing' ? `${s.from} planted nearby (can be cut when it has grown into a tree)` : `grows from ${s.from} planted on dirt or grass_block`;
    if (s.how === 'kill') return `${s.from} ${vis(s)}${rare ? ` (${rare} drops it)` : ''}`;
    if (s.from === s.item) return CROP_BLOCKS.test(s.from) ? `grown ones ${vis(s)}` : vis(s);
    return `${s.item === target ? 'it' : s.item} ${rare ? `${rare} ` : ''}drops from ${s.from} (${s.from} ${vis(s)})`;
  };
  const out = [];
  if (ex.main) out.push(say(ex.main));
  if (ex.tools.length) out.push(`needs ${ex.tools[0]}`);
  if (ex.stations.includes('furnace')) out.push('needs furnace');
  for (const l of ex.leaves) if (l !== ex.main && (l.where !== 'visible' || l.expect < 0.5)) out.push(say(l));
  if (ex.stations.includes('crafting_table')) out.push('needs crafting_table');
  return [...new Set(out)].slice(0, maxFacts);
}

// 人: { name, desc }。people = [{ name, relation, seen }]
function personCandidates(people) {
  return (people || []).map((p) => ({ name: p.name, desc: [p.relation, p.seen ? `今は${p.seen}にいる` : '今は見えない'].filter(Boolean).join('・'),
    descEn: [p.relationEn || null, p.seenEn ? `now ${p.seenEn}` : p.seen ? 'visible now' : 'not visible now'].filter(Boolean).join('; '), near: !!p.near }));
}

// 場所: 拠点・覚えている場所 (M番号、拠点以外)・8方位の遠く。cellAt(x, z) → 行ったマス | null
function placeCandidates({ here, base = null, baseLabel = null, places = [], cellAt = null, far = 48, maxPlaces = 4, origin = null } = {}) {
  const out = [];
  if (base) out.push({ name: '拠点', desc: baseLabel || '自分の拠点', descEn: 'my base', pos: base, type: 'base' });
  for (const p of places.filter((q) => q.kind !== '拠点').slice(0, maxPlaces)) out.push({ name: p.id, desc: p.label, descEn: `a remembered place: ${p.kind}`, pos: p.pos, type: 'memory' });
  for (const [id, ja, dx, dz] of DIRS8) {
    const l = Math.hypot(dx, dz);
    const x = here ? here.x + (dx / l) * far : 0; const z = here ? here.z + (dz / l) * far : 0;
    const c = cellAt && here ? cellAt(x, z) : null;
    const ref = origin && here ? commonRef({ x, z }, origin) : null;
    out.push({ name: `${ja}の方`, desc: `${far}mほど先${ref ? ` (${ref})` : ''}・${c ? '行ったことがある' : '行ったことがない'}`, descEn: `far to the ${id}; ${c ? 'been there before' : 'never been there'}`, dir: id, vec: [dx / l, dz / l], type: 'dir' });
  }
  return out;
}

module.exports = { pathFactsEn, itemCandidates, personCandidates, placeCandidates, familyKey, collapse, DIRS8, useSpec, pathFacts, dir8, rareWord };
