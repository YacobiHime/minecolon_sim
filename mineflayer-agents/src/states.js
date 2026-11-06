'use strict';
// 状態のゴール (goalpath.js の kind: 'state')。bot に依存しない (ブロックは blockAt(x, y, z) で見る)。
//   型 (STATE_TYPES):
//     pen      : 拠点の近くに、囲いの中の <動物> が N 頭いる            (target: pen_cow など)
//     farmland : 今いる所の近く (見える所) に、湿った耕地が N マスある   (target: farmland)
//     lit      : 拠点の近くに松明などの明かりが N 個ある               (target: lit_base)
//     walled   : 拠点の真ん中が壁 (高さ2) か柵で囲われている            (target: walled_base)
//     chest    : 拠点の近くのチェストに <物> が N 個ある (開けて見た中身) (target: chest_<物>)
//     planted  : 今いる所の近くの耕地に <作物> が N 本植わっている (育ち途中も含む) (target: planted_wheat など)
//   済んだかはプログラムが確かめる (checkState)。道筋は仕様だけで作る (planState): 要る物は planner でたどり、
//   そのあとに行動の手順 (囲う・連れてくる・増やす・耕す・置く・入れる) を並べる。
//   研究方針: 仕様・事実は見せるが、どう使うとよいかは書かない。数値はここで持ち、モデルには言葉だけ (手間は 小/中/大)。
const { Planner, effortWord, EFFORT_EN, FARM, FARM_CROPS } = require('./planner');
const { dist3 } = require('./util');
const { chestLabelEn } = require('./board');

const { BREED_FOOD } = require('./animals');
const PEN_ANIMALS = ['cow', 'sheep', 'pig', 'chicken'];
// 囲いの境 (人・動物が越えられない): 柵・塀・閉じた柵の門
const BARRIER = /_fence$|_wall$|_fence_gate$|^iron_bars$/;
const LIGHTS = /^(torch|wall_torch|soul_torch|soul_wall_torch|lantern|soul_lantern|glowstone|jack_o_lantern|sea_lantern|shroomlight|campfire|soul_campfire|redstone_lamp)$/;
const DEFAULTS = { penSize: 5, wallSize: 3, radius: 8, maxCells: 160, farmRadius: 8, hydrate: 4, chestItems: 2, near: 16, counts: { pen: 2, farmland: 8, lit: 4, walled: 1, chest: 8, planted: 8 } };
// 行動の手順の手間 (planner の手間と同じ尺度。数値はモデルに見せない)
const ACT_COST = { enclose: 3, encloseEach: 0.1, lure: 4, lureUnseen: 10, breed: 3, till: 0.3, findWater: 6, place: 0.3, chestPut: 1, plant: 0.3 };
// 作物 (ブロック) → 種 (植える物)
const CROP_SEED = Object.fromEntries(Object.values(FARM).map((f) => [f.crop, f.seed]));
const SEED_CROP = Object.fromEntries(Object.values(FARM).map((f) => [f.seed, f.crop]));

const isSolid = (b) => !!b && b.boundingBox === 'block' && !BARRIER.test(b.name);
const isOpenGate = (b) => !!b && /_fence_gate$/.test(b.name) && (b.open === true || (typeof b.getProperties === 'function' && (() => { try { return b.getProperties().open === true; } catch (_) { return false; } })()));
const isBarrier = (b) => !!b && BARRIER.test(b.name) && !isOpenGate(b);
const passable = (b) => !b || (!isSolid(b) && !isBarrier(b));

// start (足の位置) から、人・動物が歩いて行ける所を数える (平らな地面を前提に、1段の上り・3段までの下りを歩ける)。
// 境: 柵・塀・閉じた門 (足か頭の高さ)、高さ2以上のブロック。maxCells を超えたら囲われていない
function enclosedArea(blockAt, start, { maxCells = DEFAULTS.maxCells } = {}) {
  const sx = Math.floor(start.x); const sy = Math.floor(start.y); const sz = Math.floor(start.z);
  const seen = new Map(); // "x,z" → y
  const q = [[sx, sy, sz]];
  seen.set(`${sx},${sz}`, sy);
  while (q.length) {
    const [x, y, z] = q.shift();
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx; const nz = z + dz;
      const k = `${nx},${nz}`;
      if (seen.has(k)) continue;
      const feet = blockAt(nx, y, nz); const head = blockAt(nx, y + 1, nz);
      if (isBarrier(feet) || isBarrier(head) || isBarrier(blockAt(nx, y - 1, nz))) continue; // 柵の上も (1.5 の高さ) 越えられない
      let ny = null;
      if (isSolid(feet)) {
        if (isSolid(head) || !passable(blockAt(nx, y + 2, nz)) || !passable(blockAt(x, y + 2, z))) continue; // 高さ2以上の壁
        ny = y + 1;
      } else if (!passable(head)) continue;
      else {
        ny = y;
        let drop = 0;
        while (drop < 4 && !isSolid(blockAt(nx, ny - 1, nz)) && !isBarrier(blockAt(nx, ny - 1, nz))) { ny -= 1; drop += 1; }
        if (drop >= 4) return { enclosed: false, cells: seen.size }; // 崖・穴の先は外とみなす
      }
      seen.set(k, ny);
      if (seen.size > maxCells) return { enclosed: false, cells: seen.size };
      q.push([nx, ny, nz]);
    }
  }
  return { enclosed: true, cells: seen.size, keys: [...seen.keys()] };
}

// 湿った耕地: 4ブロック以内 (横) の同じ高さか1つ上に水がある、または moisture が 7
function hydratedFarmland(blockAt, center, { radius = DEFAULTS.farmRadius, hydrate = DEFAULTS.hydrate, down = 3, up = 2 } = {}) {
  const cx = Math.floor(center.x); const cy = Math.floor(center.y); const cz = Math.floor(center.z);
  let all = 0; let wet = 0;
  const waterNear = (x, y, z) => {
    for (let dx = -hydrate; dx <= hydrate; dx++) for (let dz = -hydrate; dz <= hydrate; dz++) for (const dy of [0, 1]) {
      const b = blockAt(x + dx, y + dy, z + dz);
      if (b && b.name === 'water') return true;
    }
    return false;
  };
  for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) for (let dy = -down; dy <= up; dy++) {
    const b = blockAt(cx + dx, cy + dy, cz + dz);
    if (!b || b.name !== 'farmland') continue;
    all += 1;
    let m = null;
    try { m = typeof b.getProperties === 'function' ? Number(b.getProperties().moisture) : (b.moisture ?? null); } catch (_) { m = null; }
    if (m === 7 || waterNear(cx + dx, cy + dy, cz + dz)) wet += 1;
  }
  return { all, wet };
}

// 近くの畑の様子: 耕地 (上が空いている = 空き)・作物 (育ち途中 / 育ちきった)。age が最大なら育ちきった
//   返り値 { farmland, empty, emptyPos: [近い順に数個], growing: { wheat: n }, ripe: { wheat: n }, cropPos: { wheat: [...] } }
function farmStatus(blockAt, center, { radius = DEFAULTS.farmRadius, down = 3, up = 2, keep = 4 } = {}) {
  const cx = Math.floor(center.x); const cy = Math.floor(center.y); const cz = Math.floor(center.z);
  const out = { farmland: 0, empty: 0, emptyPos: [], growing: {}, ripe: {}, cropPos: {} };
  for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) for (let dy = -down; dy <= up; dy++) {
    const b = blockAt(cx + dx, cy + dy, cz + dz);
    if (!b || b.name !== 'farmland') continue;
    out.farmland += 1;
    const above = blockAt(cx + dx, cy + dy + 1, cz + dz);
    const pos = { x: cx + dx, y: cy + dy, z: cz + dz, d: Math.round(Math.hypot(dx, dz, dy) * 10) / 10 };
    if (!above || above.name === 'air' || above.name === 'cave_air') { out.empty += 1; out.emptyPos.push(pos); continue; }
    if (!FARM_CROPS.test(above.name)) continue;
    let age = null;
    try { age = typeof above.getProperties === 'function' ? Number(above.getProperties().age) : (above.age ?? null); } catch (_) { age = null; }
    const max = above.name === 'beetroots' ? 3 : 7;
    const k = age != null && age >= max ? 'ripe' : 'growing';
    out[k][above.name] = (out[k][above.name] || 0) + 1;
    (out.cropPos[above.name] = out.cropPos[above.name] || []).push({ ...pos, y: pos.y + 1, ripe: k === 'ripe' });
  }
  out.emptyPos.sort((a, b) => a.d - b.d).splice(keep);
  for (const c of Object.keys(out.cropPos)) out.cropPos[c].sort((a, b) => a.d - b.d).splice(keep);
  return out;
}

function countLights(blockAt, center, { radius = DEFAULTS.radius - 2, down = 2, up = 4 } = {}) {
  const cx = Math.floor(center.x); const cy = Math.floor(center.y); const cz = Math.floor(center.z);
  let n = 0;
  for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) for (let dy = -down; dy <= up; dy++) {
    const b = blockAt(cx + dx, cy + dy, cz + dz);
    if (b && LIGHTS.test(b.name)) n += 1;
  }
  return n;
}

// ---- 候補 ----

// 状態の id → { type, animal?, item? }
function parseStateId(id) {
  const s = String(id || '');
  let m = s.match(/^pen_([a-z_]+)$/);
  if (m && BREED_FOOD[m[1]]) return { type: 'pen', animal: m[1] };
  if (s === 'farmland') return { type: 'farmland' };
  if (s === 'lit_base') return { type: 'lit' };
  if (s === 'walled_base') return { type: 'walled' };
  m = s.match(/^chest_([a-z0-9_]+)$/);
  if (m) return { type: 'chest', item: m[1] };
  m = s.match(/^planted_([a-z_]+)$/);
  if (m && CROP_SEED[m[1]]) return { type: 'planted', crop: m[1], seed: CROP_SEED[m[1]] };
  m = s.match(/^shared_([A-Za-z0-9_]+-\d+)__([a-z0-9_]+)$/);
  if (m) return { type: 'shared', chest: m[1], item: m[2] };
  return null;
}

// 2B に見せる文 (count は 2B が選んだ数)
function stateGoalText(st, count) {
  const n = count ?? DEFAULTS.counts[st.type];
  if (st.type === 'pen') return `拠点の近くの囲いの中に ${st.animal} が${n}頭いる`;
  if (st.type === 'farmland') return `水の近くに耕地が${n}マスある`;
  if (st.type === 'lit') return `拠点の近くに明かりが${n}個ある`;
  if (st.type === 'walled') return '拠点の真ん中が囲われている';
  if (st.type === 'chest') return `拠点の近くのチェストに ${st.item} が${n}個ある`;
  if (st.type === 'planted') return `近くの耕地に ${st.crop} が${n}本植わっている`;
  if (st.type === 'shared') return `共有のチェスト ${st.chest} に ${st.item} が${n}個ある`;
  return '';
}

// 英語 (Jev 用)
function stateGoalTextEn(st, count) {
  const n = count ?? DEFAULTS.counts[st.type];
  if (st.type === 'pen') return `${n} ${st.animal} inside an enclosure near the base`;
  if (st.type === 'farmland') return `${n} farmland near water`;
  if (st.type === 'lit') return `${n} lights near the base`;
  if (st.type === 'walled') return 'the center of the base is enclosed';
  if (st.type === 'chest') return `${n} ${st.item} in a chest near the base`;
  if (st.type === 'planted') return `${n} ${st.crop} planted on farmland nearby`;
  if (st.type === 'shared') return `${n} ${st.item} in ${chestLabelEn(st.chest)}`;
  return '';
}

// ---- 今の様子 ----
// sense = { blockAt, here, anchor (拠点 | null), entities: raw.entities, containers: {"x,y,z": {name, items}}, near }
// 返り値 { have (今の数)、known (確かめられたか)、... 型ごとの様子 }
function senseState(st, sense, cfg = DEFAULTS) {
  const c = { ...DEFAULTS, ...cfg };
  const { blockAt, here, anchor } = sense;
  const near = anchor && here ? dist3(here, anchor) <= (sense.near ?? c.near) : false;
  if (st.type === 'farmland') {
    if (!blockAt || !here) return { have: 0, known: false };
    const f = hydratedFarmland(blockAt, here, { radius: c.farmRadius, hydrate: c.hydrate });
    return { have: f.wet, all: f.all, known: true };
  }
  if (st.type === 'planted') {
    if (!blockAt || !here) return { have: 0, known: false };
    const f = farmStatus(blockAt, here, { radius: c.farmRadius });
    return { have: (f.growing[st.crop] || 0) + (f.ripe[st.crop] || 0), empty: f.empty, farmland: f.farmland, ripe: f.ripe[st.crop] || 0, known: true };
  }
  // 共有のチェスト: 中身は全員に見えている (board.js。sense.shared = [{ id, items, known }])
  if (st.type === 'shared') {
    const ch = (sense.shared || []).find((x) => x.id === st.chest);
    if (!ch) return { have: 0, known: false, noChest: true };
    return { have: (ch.items || []).filter((i) => i.name === st.item).reduce((t, i) => t + i.count, 0), known: ch.known !== false, chests: 1 };
  }
  if (!anchor) return { have: 0, known: false, noBase: true };
  if (st.type === 'chest') {
    let have = 0; let chests = 0;
    for (const [k, v] of Object.entries(sense.containers || {})) {
      const [x, y, z] = k.split(',').map(Number);
      if (!v || !/chest|barrel/.test(v.name || 'chest') || dist3({ x, y, z }, anchor) > c.radius) continue;
      chests += 1;
      for (const it of v.items || []) if (it.name === st.item) have += it.count;
    }
    return { have, chests, known: chests > 0 };
  }
  if (!blockAt) return { have: 0, known: false };
  if (!near) return { have: 0, known: false, far: true };
  if (st.type === 'lit') return { have: countLights(blockAt, anchor), known: true };
  if (st.type === 'walled') {
    const a = enclosedArea(blockAt, { x: anchor.x, y: anchor.y, z: anchor.z }, { maxCells: c.maxCells });
    return { have: a.enclosed ? 1 : 0, cells: a.cells, known: true };
  }
  if (st.type === 'pen') {
    const animals = (sense.entities || []).filter((e) => e.name === st.animal && e.kind !== 'player' && e.pos && dist3(e.pos, anchor) <= c.radius + 4);
    let have = 0; let pen = null;
    const cache = new Map();
    for (const e of animals) {
      const key = `${Math.floor(e.pos.x)},${Math.floor(e.pos.z)}`;
      let r = cache.get(key);
      if (!r) {
        r = enclosedArea(blockAt, e.pos, { maxCells: c.maxCells });
        if (r.enclosed) for (const kk of r.keys) cache.set(kk, r);
        else cache.set(key, r);
      }
      if (r.enclosed) { have += 1; pen = pen || r.cells; }
    }
    const seen = (sense.entities || []).filter((e) => e.name === st.animal && e.kind !== 'player').length;
    return { have, seen, penCells: pen, known: true };
  }
  return { have: 0, known: false };
}

// ---- 道筋 ----
// world: planner の world (goalpath.world())。status: senseState の返り値。count: めざす数
// 返り値 { ok, items: planMany の結果, acts: [{ how, ... }], steps (物の手順 + 行動の手順), next, effort, missing }
function planState(st, count, world, status = { have: 0 }, opts = {}) {
  const c = { ...DEFAULTS, ...(opts.cfg || {}) };
  // 共有のチェストに入れるゴールは、そのチェストから出す道筋を作らない
  if (st.type === 'shared' && (world.sharedChests || []).some((x) => x.id === st.chest)) world = { ...world, sharedChests: world.sharedChests.filter((x) => x.id !== st.chest) };
  const planner = (st.type === 'shared' ? null : opts.planner) || new Planner(world, { version: opts.version });
  const n = Math.max(1, Math.floor(count) || DEFAULTS.counts[st.type] || 1);
  const left = Math.max(0, n - (status.have || 0));
  const need = []; const acts = [];
  const visMobs = new Set(world.visibleMobs || []);
  const visBlocks = new Set(world.visibleBlocks || []);
  // 手間のいちばん小さい物。prefer なら、一覧の先の物を手間が最小の2倍までなら選ぶ (餌は仕様の一覧の順)
  const cheapest = (cands, prefer = false) => {
    const l = [];
    for (const x of cands) { const it = planner.resolve(x); if (!it) continue; const cc = planner.cost(it).c; if (Number.isFinite(cc)) l.push({ item: it, c: cc }); }
    if (!l.length) return null;
    const min = Math.min(...l.map((x) => x.c));
    return (prefer ? l.find((x) => x.c <= min * 2 + 1e-9) : l.find((x) => x.c === min)).item;
  };
  if (st.type === 'pen' && left > 0) {
    const food = cheapest(BREED_FOOD[st.animal] || [], true);
    if (!food) return { ok: false, missing: (BREED_FOOD[st.animal] || ['?'])[0], acts, steps: [] };
    if (!status.penCells) {
      const k = c.penSize;
      const fence = cheapest(['fence']);
      const gate = cheapest(['fence_gate']);
      need.push({ item: fence, count: 4 * k + 4 - 1 }, { item: gate, count: 1 });
      acts.push({ how: 'enclose', size: k, item: fence, gate, count: 4 * k + 4 });
    }
    const lureN = Math.min(left, Math.max(0, 2 - (status.have || 0))); // 2頭までは連れてくる、それより多い分は増やす
    const breedN = Math.max(0, left - lureN);
    need.push({ item: food, count: 1 + breedN * 2 });
    if (lureN > 0) acts.push({ how: 'lure', animal: st.animal, food, count: lureN, seen: visMobs.has(st.animal) });
    if (breedN > 0) acts.push({ how: 'breed', animal: st.animal, food, count: breedN });
  } else if (st.type === 'farmland' && left > 0) {
    const hoe = cheapest(['hoe']);
    need.push({ item: hoe, count: 1 });
    if (!visBlocks.has('water')) acts.push({ how: 'find', block: 'water' });
    acts.push({ how: 'till', count: left, tool: hoe });
  } else if (st.type === 'planted' && left > 0) {
    need.push({ item: st.seed, count: left });
    const till = Math.max(0, left - (status.empty || 0));
    if (till > 0) {
      const hoe = cheapest(['hoe']);
      need.push({ item: hoe, count: 1 });
      if (!visBlocks.has('water') && !(status.farmland > 0)) acts.push({ how: 'find', block: 'water' });
      acts.push({ how: 'till', count: till, tool: hoe });
    }
    acts.push({ how: 'plant', seed: st.seed, crop: st.crop, count: left });
  } else if (st.type === 'lit' && left > 0) {
    need.push({ item: 'torch', count: left });
    acts.push({ how: 'place', item: 'torch', count: left, where: '拠点' });
  } else if (st.type === 'walled' && left > 0) {
    const k = c.wallSize;
    const block = cheapest(['cobblestone', 'planks', 'fence']);
    const per = /_fence$|_wall$/.test(block || '') ? 1 : 2; // 柵・塀は1段、ブロックは2段
    need.push({ item: block, count: (4 * k + 4) * per });
    acts.push({ how: 'enclose', size: k, item: block, count: (4 * k + 4) * per, height: per });
  } else if (st.type === 'chest' && left > 0) {
    if (!status.chests) { need.push({ item: 'chest', count: 1 }); acts.push({ how: 'place', item: 'chest', count: 1, where: '拠点' }); }
    need.push({ item: st.item, count: left });
    acts.push({ how: 'chest_put', item: st.item, count: left });
  } else if (st.type === 'shared' && left > 0) {
    need.push({ item: st.item, count: left });
    acts.push({ how: 'chest_put', item: st.item, count: left, chest: st.chest });
  }
  const items = planner.planMany(need);
  if (!items.ok) return { ok: false, missing: items.missing, acts, steps: items.steps || [] };
  let effort = planner.effort(need);
  for (const a of acts) {
    if (a.how === 'enclose') effort += ACT_COST.enclose + ACT_COST.encloseEach * a.count;
    else if (a.how === 'lure') effort += (a.seen ? ACT_COST.lure : ACT_COST.lureUnseen) * a.count;
    else if (a.how === 'breed') effort += ACT_COST.breed * a.count;
    else if (a.how === 'till') effort += ACT_COST.till * a.count;
    else if (a.how === 'find') effort += ACT_COST.findWater;
    else if (a.how === 'place') effort += ACT_COST.place * a.count;
    else if (a.how === 'chest_put') effort += ACT_COST.chestPut;
    else if (a.how === 'plant') effort += ACT_COST.plant * a.count;
  }
  const steps = [...items.steps, ...acts.map((a) => ({ ...a, act: true }))];
  return { ok: true, items, acts, steps, next: steps[0] || null, done: left === 0, left, effort, effortWord: left === 0 ? 'なし' : effortWord(effort) };
}

// 行動の手順の短い文
function actText(a) {
  if (a.how === 'enclose') return `囲う (内側${a.size}x${a.size}・${a.item}${a.height === 2 ? '・2段' : ''}${a.gate ? `・門 ${a.gate}` : ''})`;
  if (a.how === 'lure') return `${a.animal} ${a.count} を連れてくる (${a.food} を持って)`;
  if (a.how === 'breed') return `${a.animal} を${a.count}頭増やす (${a.food} を2頭に)`;
  if (a.how === 'till') return `耕す ${a.count} (${a.tool} を水の近くの土に)`;
  if (a.how === 'find') return `${a.block} を探す`;
  if (a.how === 'plant') return `${a.seed} ${a.count} を耕地に植える`;
  if (a.how === 'place') return `${a.item} ${a.count} を置く (${a.where})`;
  if (a.how === 'chest_put') return a.chest ? `共有のチェスト ${a.chest} に ${a.item} ${a.count} を入れる` : `chest に ${a.item} ${a.count} を入れる`;
  return a.how;
}

function actTextEn(a) {
  if (a.how === 'enclose') return `enclose (inside ${a.size}x${a.size}, ${a.item}${a.height === 2 ? ', 2 high' : ''}${a.gate ? `, gate ${a.gate}` : ''})`;
  if (a.how === 'lure') return `lead ${a.count} ${a.animal} here (holding ${a.food})`;
  if (a.how === 'breed') return `breed ${a.count} more ${a.animal} (${a.food} to two of them)`;
  if (a.how === 'till') return `till ${a.count} (${a.tool} on dirt near water)`;
  if (a.how === 'find') return `find ${a.block}`;
  if (a.how === 'plant') return `plant ${a.count} ${a.seed} on farmland`;
  if (a.how === 'place') return `place ${a.count} ${a.item} (${a.where === '拠点' ? 'at the base' : a.where})`;
  if (a.how === 'chest_put') return a.chest ? `put ${a.count} ${a.item} into ${chestLabelEn(a.chest)}` : `put ${a.count} ${a.item} into a chest`;
  return a.how;
}

const UNIT = { pen: '頭', farmland: 'マス', lit: '個', walled: '', chest: '個', shared: '個', planted: '本' };
const GEAR = /_(sword|axe|pickaxe|shovel|hoe|helmet|chestplate|leggings|boots)$|^(shield|bow|crossbow|fishing_rod|shears)$/;

// 2B に見せる状態の候補 [{ name, desc, state, count }]。
// ctx = { world (planner の world), sense (senseState の材料), raw, cfg, dir (pos → 方角の言葉),
//         shared: [{ chest, item, add, note, noteEn }] (取り決め・共同の目標から: 共有のチェストに item を add 個入れる。board.js) }
function stateCandidates(ctx) {
  const c = { ...DEFAULTS, ...(ctx.cfg || {}) };
  const raw = ctx.raw || { inventory: [], entities: [] };
  const sense = ctx.sense || {};
  const planner = new Planner(ctx.world || {}, { version: ctx.version });
  const ids = [...PEN_ANIMALS.map((a) => `pen_${a}`), 'farmland', 'lit_base', 'walled_base'];
  const inv = new Map();
  for (const i of raw.inventory || []) if (!GEAR.test(i.name)) inv.set(i.name, (inv.get(i.name) || 0) + i.count);
  // 植わっている作物: 小麦 (種は草から) と、種を持っている作物
  const crops = new Set(['wheat']);
  for (const [n] of inv) if (SEED_CROP[n]) crops.add(SEED_CROP[n]);
  for (const cr of crops) ids.push(`planted_${cr}`);
  for (const [n] of [...inv].sort((a, b) => b[1] - a[1]).slice(0, c.chestItems)) ids.push(`chest_${n}`);
  const extra = new Map();
  for (const x of ctx.shared || []) {
    const id = `shared_${x.chest}__${x.item}`;
    if (extra.has(id) || !parseStateId(id)) continue;
    extra.set(id, x); ids.push(id);
  }
  const out = [];
  for (const id of ids) {
    const st = parseStateId(id);
    if (!st) continue;
    const ex = extra.get(id) || null;
    const status = senseState(st, sense, c);
    // 共有のチェスト: 今ある数 + 入れる数 (add)
    const n = ex ? (status.have || 0) + Math.max(1, ex.add || 1) : c.counts[st.type];
    const p = planState(st, n, ctx.world || {}, status, { planner, cfg: c });
    const facts = [];
    const fe = []; // 英語 (Jev 用。同じ値から)
    if (ex && ex.note) { facts.push(ex.note); fe.push(ex.noteEn || ex.note); }
    if (status.noBase) { facts.push('拠点はまだない'); fe.push('no base yet'); }
    else if (st.type === 'farmland' || st.type === 'planted' || status.known) {
      facts.push(st.type === 'walled' ? (status.have ? '今は囲われている' : '今は囲われていない') : `今${status.have}${UNIT[st.type]}`);
      fe.push(st.type === 'walled' ? (status.have ? 'enclosed now' : 'not enclosed now') : `${status.have} now`);
    } else { facts.push(status.far ? '拠点から離れているので今は数えられない' : '今は数えられない'); fe.push('cannot be counted now'); }
    if (st.type === 'pen') {
      const e = (raw.entities || []).find((x) => x.name === st.animal && x.kind !== 'player');
      facts.push(e ? `${st.animal} が${ctx.dir ? ctx.dir(e.pos) : ''}に見える` : `${st.animal} はまだ見ていない`);
      fe.push(e ? `${st.animal} visible` : `${st.animal} not seen yet`);
    }
    if (st.type === 'planted' && status.known) { facts.push(`空いている耕地${status.empty || 0}マス`); fe.push(`${status.empty || 0} empty farmland`); }
    if (st.type === 'farmland') { const w = (ctx.world && (ctx.world.visibleBlocks || []).includes('water')); facts.push(w ? 'water が見える' : 'water は見えない'); fe.push(w ? 'water visible' : 'no water visible'); }
    if (p.ok && p.acts.length) {
      const needs = p.acts.flatMap((a) => (a.how === 'enclose' ? [`${a.item} ${a.count - (a.gate ? 1 : 0)}${a.gate ? `・${a.gate} 1` : ''}`] : a.how === 'lure' || a.how === 'breed' ? [] : a.how === 'till' ? [`${a.tool} 1`] : a.how === 'plant' ? [`${a.seed} ${a.count}`] : a.how === 'place' || a.how === 'chest_put' ? [`${a.item} ${a.count}`] : []));
      const food = p.acts.find((a) => a.how === 'lure' || a.how === 'breed');
      if (food) needs.push(`${food.food} ${p.items.steps.filter((x) => x.item === food.food).reduce((t, x) => t + x.count, 0) || 1}`);
      if (needs.length) { facts.push(`要る物: ${[...new Set(needs)].join('・')}`); fe.push(`needs ${[...new Set(needs)].join(', ')}`); }
    }
    if (!p.ok) { facts.push(`${p.missing} の手に入れ方が分からない`); fe.push(`no known way to get ${p.missing}`); }
    out.push({ name: id, state: st, count: n, have: status.known ? status.have : null, desc: `状態: ${stateGoalText(st, n)}。${facts.join('。')}${p.ok && p.effortWord ? `。手間: ${p.effortWord}` : ''}`,
      descEn: `state: ${stateGoalTextEn(st, n)}; ${fe.join('; ')}${p.ok && p.effortWord ? `; effort ${EFFORT_EN[p.effortWord] || p.effortWord}` : ''}` });
  }
  return out;
}

module.exports = { farmStatus, CROP_SEED, SEED_CROP, stateGoalTextEn, actTextEn, stateCandidates, UNIT,  BREED_FOOD, PEN_ANIMALS, BARRIER, LIGHTS, DEFAULTS, ACT_COST, enclosedArea, hydratedFarmland, countLights, parseStateId, stateGoalText, senseState, planState, actText, isBarrier, isSolid };
