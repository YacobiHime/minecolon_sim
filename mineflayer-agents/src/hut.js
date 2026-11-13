'use strict';
// 拠点の小屋の設計図 (決まった形) と、どこまでできたかの判定。
// エージェントは座標を計算しない: build を選ぶと、プログラムが設計図の「次に置く所」を決めて置く。
// 判定は、拠点が近くに見えているとき (visionRadius 以内) だけ行う (遠くからは分からない)。

const REPLACEABLE = new Set(['air', 'cave_air', 'snow', 'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush',
  'dandelion', 'poppy', 'azure_bluet', 'oxeye_daisy', 'cornflower', 'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip', 'allium', 'lily_of_the_valley']);
const BUILD_MATERIAL = /(_planks|_log|^cobblestone|^dirt|^stone|_wood)$/;

// base = 小屋の床の中心 (足の高さ)。size = 外のりの一辺 (奇数)、height = 壁の高さ、door = 入口の向き
function hutSlots(base, { size = 5, height = 2, roof = true, door = 'south' } = {}) {
  const h = Math.floor(size / 2);
  const bx = Math.floor(base.x); const by = Math.floor(base.y); const bz = Math.floor(base.z);
  const doorAt = { south: [0, h], north: [0, -h], east: [h, 0], west: [-h, 0] }[door] || [0, h];
  const out = [];
  for (let y = 0; y < height; y++) {
    for (let dx = -h; dx <= h; dx++) {
      for (let dz = -h; dz <= h; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== h) continue;
        if (dx === doorAt[0] && dz === doorAt[1]) continue; // 入口 (高さ2まで空ける)
        out.push({ x: bx + dx, y: by + y, z: bz + dz, part: 'wall', layer: y });
      }
    }
  }
  if (roof) {
    // 外側から内側へ (どれも隣に支えがある順)
    const ring = [];
    for (let dx = -h; dx <= h; dx++) for (let dz = -h; dz <= h; dz++) ring.push({ dx, dz, r: Math.max(Math.abs(dx), Math.abs(dz)) });
    ring.sort((a, b) => b.r - a.r);
    for (const c of ring) out.push({ x: bx + c.dx, y: by + height, z: bz + c.dz, part: 'roof', layer: height });
  }
  return out;
}

function isFilled(name) { return !!name && !REPLACEABLE.has(name) && name !== 'water' && name !== 'lava'; }

// blockName(pos) -> ブロック名 | null (読み込まれていない)
function hutStatus(slots, blockName) {
  let filled = 0;
  let unknown = 0;
  const empty = [];
  for (const s of slots) {
    const n = blockName(s);
    if (n == null) { unknown += 1; continue; }
    if (isFilled(n)) filled += 1; else empty.push(s);
  }
  const known = slots.length - unknown;
  return { total: slots.length, filled, empty, ratio: known ? filled / slots.length : null };
}

module.exports = { hutSlots, hutStatus, isFilled, REPLACEABLE, BUILD_MATERIAL };
