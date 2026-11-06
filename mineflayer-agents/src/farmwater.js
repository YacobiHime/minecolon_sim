'use strict';
// 耕地と水 (マイクラの仕様。bot に依存しない純粋な関数)。
//   湿る範囲: 耕地から水平に4マス以内 (9x9)、耕地と同じ高さか1つ上に水があると湿る (moisture 7)。
//   耕せるもの: クワを dirt・grass_block・dirt_path に使うと耕地になる (真上が空いているときだけ)。
// 使い道:
//   - use_on の候補: クワ・シャベルを土に使う候補は、水から4マス以内の耕せるマスだけにする (actions_more.js)。
//     行き先の候補 farmland_spot (見えている所) / farmland_spot@M3 (覚えている・聞いた水場の近く)
//   - 近くの耕地の様子 (湿っている/乾いている・植わっている/空き) は states.farmStatus。観察の文はここの farmText / farmTextEn
//   - 道筋の水の段: 見えている (小)・覚えている (距離)・知らない (探す)。waterInfo・waterCost・waterText
// 研究方針: 仕様と事実だけ。どう使うと良いかは書かない。

const TILLABLE = /^(dirt|grass_block|dirt_path)$/;
const TILL_TOOL = /_(hoe|shovel)$/;
const HYDRATE = 4;
const AIRISH = /^(air|cave_air|void_air)$/;
const SPOT = 'farmland_spot';

// 耕地の位置 p から見て、湿らせる水があるか (水の位置の並び)。水平に r 以内、同じ高さか1つ上
function nearWaterPts(p, waterPts, r = HYDRATE) {
  const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z);
  for (const w of waterPts || []) {
    const wy = Math.floor(w.y);
    if (Math.abs(Math.floor(w.x) - x) <= r && Math.abs(Math.floor(w.z) - z) <= r && (wy === y || wy === y + 1)) return true;
  }
  return false;
}

// blockAt で同じことを確かめる
function waterWithin(blockAt, p, r = HYDRATE) {
  const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z);
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      for (const dy of [0, 1]) {
        const b = blockAt(x + dx, y + dy, z + dz);
        if (b && b.name === 'water') return true;
      }
    }
  }
  return false;
}

// 近くの、水から4マス以内の耕せるマス (真上が空いている dirt・grass_block・dirt_path)。近い順に keep 個
//   返り値 { spots: [{ x, y, z, name, d }], water: 見つけた水のマスの数, tillable: 耕せるマス (水に関係なく) の数 }
function tillSpots(blockAt, center, { radius = 8, down = 3, up = 2, keep = 4, hydrate = HYDRATE } = {}) {
  const cx = Math.floor(center.x); const cy = Math.floor(center.y); const cz = Math.floor(center.z);
  const water = new Set();
  const R = radius + hydrate;
  for (let dx = -R; dx <= R; dx++) {
    for (let dz = -R; dz <= R; dz++) {
      for (let dy = -down; dy <= up + 1; dy++) {
        const b = blockAt(cx + dx, cy + dy, cz + dz);
        if (b && b.name === 'water') water.add(`${cx + dx},${cy + dy},${cz + dz}`);
      }
    }
  }
  const wet = (x, y, z) => {
    for (let dx = -hydrate; dx <= hydrate; dx++) for (let dz = -hydrate; dz <= hydrate; dz++) for (const dy of [0, 1]) if (water.has(`${x + dx},${y + dy},${z + dz}`)) return true;
    return false;
  };
  const spots = [];
  let tillable = 0;
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dy = -down; dy <= up; dy++) {
        const x = cx + dx; const y = cy + dy; const z = cz + dz;
        const b = blockAt(x, y, z);
        if (!b || !TILLABLE.test(b.name)) continue;
        const above = blockAt(x, y + 1, z);
        if (above && !AIRISH.test(above.name)) continue;
        tillable += 1;
        if (!water.size || !wet(x, y, z)) continue;
        spots.push({ x, y, z, name: b.name, d: Math.round(Math.hypot(dx, dy, dz) * 10) / 10 });
      }
    }
  }
  spots.sort((a, b) => a.d - b.d);
  return { spots: spots.slice(0, keep), water: water.size, tillable };
}

// 見えているブロック (raw.blocks) だけから、水から4マス以内の耕せるマス (blockAt が無いとき)
function tillSpotsFromRaw(raw, { keep = 4 } = {}) {
  const w = raw.blocks.find((b) => b.name === 'water');
  if (!w) return [];
  const pts = w.positions && w.positions.length ? w.positions : [w.nearest];
  const out = [];
  for (const b of raw.blocks.filter((x) => TILLABLE.test(x.name))) {
    for (const p of b.positions && b.positions.length ? b.positions : [b.nearest]) if (nearWaterPts(p, pts)) out.push({ x: p.x, y: p.y, z: p.z, name: b.name, d: p.d });
  }
  return out.sort((a, b) => (a.d ?? 0) - (b.d ?? 0)).slice(0, keep);
}

// ---- 道筋の水の段 ----
const DIR_JA = ['東', '南東', '南', '南西', '西', '北西', '北', '北東'];
const DIR_EN = ['east', 'southeast', 'south', 'southwest', 'west', 'northwest', 'north', 'northeast'];
function dirIdx(from, to) { const a = Math.atan2(to.z - from.z, to.x - from.x); return ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8; }

// 水場の知り方: { where: 'visible', pos, d, dir, ready } / { where: 'known', id, pos, d, dir, from, ready } / { where: 'unknown', ready }
//   here: 自分の位置。raw: 見えている物 (water があれば visible)。places: memory.placesForPrompt (M 番号の付いた場所)
//   ready: 近くに、水から4マス以内 (同じ高さか1つ上) の耕せるマスがある (tillSpots)。水が見えているだけ (2段下など) では ready にならない
//   ready が分からない (undefined) ときは raw だけから (tillSpotsFromRaw)
function waterInfo(here, { raw = null, places = [], ready } = {}) {
  const rd = ready != null ? !!ready : !!(raw && raw.blocks && tillSpotsFromRaw(raw).length);
  const w = raw && raw.blocks ? raw.blocks.find((b) => b.name === 'water') : null;
  if (w && here) {
    const p = w.nearest;
    return { where: 'visible', pos: { x: p.x, y: p.y, z: p.z }, d: Math.round(Math.hypot(p.x - here.x, p.z - here.z)), dir: dirIdx(here, p), ready: rd };
  }
  if (rd) return { where: 'visible', ready: true };
  const k = (places || []).filter((p) => p.kind === 'water' && p.pos && !p.unreachable).sort((a, b) => (a.d ?? 0) - (b.d ?? 0))[0];
  if (k && here) return { where: 'known', id: k.id, pos: k.pos, d: Math.round(Math.hypot(k.pos.x - here.x, k.pos.z - here.z)), dir: dirIdx(here, k.pos), from: k.from || null, ready: false };
  return { where: 'unknown', ready: false };
}

// 水の段の手間 (planner の COST と同じ尺度): 見えている 0.3、覚えている 1 + 距離/20 (最大 6)、知らない 6 (探す)
const WATER_COST = { ready: 0, visible: 1, knownBase: 1, knownPerM: 1 / 20, unknown: 6 };
// 水の段の手間: 耕せる所が近くにある 0、水は見えるが耕せる所がない (高さが合わないなど) 1、覚えている 1 + 距離/20 (最大 6)、知らない 6 (探す)
function waterCost(w) {
  if (!w || w.where === 'unknown') return WATER_COST.unknown;
  if (w.ready) return WATER_COST.ready;
  if (w.where === 'visible') return WATER_COST.visible;
  return Math.min(WATER_COST.unknown, WATER_COST.knownBase + WATER_COST.knownPerM * (w.d || 0));
}

function distEn(d) { return d < 8 ? 'near' : d < 16 ? 'a short walk' : d < 40 ? 'far' : 'very far'; }
// 「水 (覚えている M3、北に40m)」「水 (見えている、東に5m)」「水を探す (まだ知らない)」
function waterText(w) {
  if (!w || w.where === 'unknown') return '水を探す (まだ知らない)';
  const where = w.d != null && w.dir != null ? (w.d < 3 ? 'すぐそば' : `${DIR_JA[w.dir]}に${w.d}m`) : '';
  if (w.where === 'visible') return `水 (見えている${where ? `、${where}` : ''}${w.ready === false ? '。水から4マス以内で高さの合う (同じか1つ上) 耕せるマスは近くにない' : ''})`;
  return `水 (${w.from ? `${w.from}が言っていた` : '覚えている'}${w.id ? ` ${w.id}` : ''}${where ? `、${where}` : ''})`;
}
function waterTextEn(w) {
  if (!w || w.where === 'unknown') return 'find water (not known yet)';
  const where = w.d != null && w.dir != null ? (w.d < 3 ? 'here' : `${distEn(w.d)}, ${DIR_EN[w.dir]}`) : '';
  if (w.where === 'visible') return `water (visible${where ? `; ${where}` : ''}${w.ready === false ? '; no tillable block within 4 blocks of it at the same level or one below nearby' : ''})`;
  return `water (${w.from ? `${w.from} said so` : 'remembered'}${w.id ? ` ${w.id}` : ''}${where ? `; ${where}` : ''})`;
}

// ---- 観察の文 (近くの耕地の様子。farm = states.farmStatus の返り値) ----
// 「耕地 6 (湿っている 4、乾いている 2、植わっている 3、乾いていて空き 1)」。耕地が無ければ ''
function farmText(farm) {
  if (!farm || !(farm.farmland > 0)) return '';
  const parts = [`湿っている ${farm.wet || 0}`, `乾いている ${farm.dry || 0}`, `植わっている ${farm.planted || 0}`];
  if (farm.dryEmpty > 0) parts.push(`乾いていて空き ${farm.dryEmpty}`);
  return `近くの耕地: ${farm.farmland} (${parts.join('、')})`;
}
function farmTextEn(farm) {
  if (!farm || !(farm.farmland > 0)) return '';
  const parts = [`${farm.wet || 0} moist`, `${farm.dry || 0} dry`, `${farm.planted || 0} planted`];
  if (farm.dryEmpty > 0) parts.push(`${farm.dryEmpty} dry and empty`);
  return `${farm.farmland} farmland (${parts.join(', ')})`;
}

module.exports = { TILLABLE, TILL_TOOL, HYDRATE, SPOT, nearWaterPts, waterWithin, tillSpots, tillSpotsFromRaw, waterInfo, waterCost, waterText, waterTextEn, farmText, farmTextEn, WATER_COST, DIR_JA, DIR_EN };
