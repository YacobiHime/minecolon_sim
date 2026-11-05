'use strict';
// explore の選択肢を作る (純粋な関数。bot に依存しない)。
//   mode 'basic'  : 東西南北 × 20m (段階1と同じ)
//   mode 'varied' : 8方位 × 近く (near) / 遠く (far)、まだ行っていない一番近いマスへ (unvisited)、でたらめな方へ (random)
// 行ったことのあるマス (memory.cells、exploreCell 四方) は、選択肢の文に「行ったか・何回・いつごろ」として短く入れるだけ。
// マスの件数そのものはプロンプトに入れない。

const DIRS8 = [
  ['north', '北', 0, -1], ['northeast', '北東', 1, -1], ['east', '東', 1, 0], ['southeast', '南東', 1, 1],
  ['south', '南', 0, 1], ['southwest', '南西', -1, 1], ['west', '西', -1, 0], ['northwest', '北西', -1, -1],
];
const DIRS4 = ['north', 'south', 'east', 'west'];
const DEFAULTS = { mode: 'basic', distance: 20, near: 12, far: 35, randomMin: 15, randomMax: 35, maxRing: 6 };

function unit(dx, dz) { const l = Math.hypot(dx, dz) || 1; return [dx / l, dz / l]; }
const VEC = Object.fromEntries(DIRS8.map(([id, , dx, dz]) => [id, unit(dx, dz)]));
const JP = Object.fromEntries(DIRS8.map(([id, jp]) => [id, jp]));

// 8方位の日本語 (dx, dz から)
function dirJp(dx, dz) {
  const a = Math.atan2(dz, dx); // 東 = 0、南 = +π/2
  const order = ['東', '南東', '南', '南西', '西', '北西', '北', '北東'];
  return order[((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8];
}

function cellIndex(cells) {
  const m = new Map();
  for (const c of cells || []) m.set(`${c.cx},${c.cz}`, c);
  return m;
}

// 「行ったことなし」「行った 3回・12回前」
function visitTextEn(c, tick) {
  if (!c || !c.n) return 'never been there';
  const ago = Math.max(0, tick - c.t);
  return `been there ${c.n === 1 ? 'once' : c.n <= 4 ? 'a few times' : 'many times'}, ${ago === 0 ? 'now' : ago <= 5 ? 'recently' : ago <= 30 ? 'a while ago' : 'long ago'}`;
}
const DIST_EN = (d) => (d < 20 ? 'a short way' : d < 50 ? 'a long way' : 'a very long way');
const DIR_EN = Object.fromEntries(DIRS8.map(([id]) => [id, id]));
const JP_EN = { 東: 'east', 南東: 'southeast', 南: 'south', 南西: 'southwest', 西: 'west', 北西: 'northwest', 北: 'north', 北東: 'northeast' };

function visitText(c, tick) {
  if (!c || !c.n) return '行ったことなし';
  const ago = Math.max(0, tick - c.t);
  return `行った ${c.n}回・${ago === 0 ? '今いる' : ago + '回前'}`;
}

// here = {x,y,z}。返り値は actions.js の choice の配列
function exploreChoices(here, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const blocked = o.blocked || new Set();
  const size = o.cellSize || 16;
  const tick = o.tick || 0;
  const idx = cellIndex(o.cells);
  const cellAtPos = (x, z) => idx.get(`${Math.floor(x / size)},${Math.floor(z / size)}`);
  const out = [];
  if (o.mode !== 'varied') {
    for (const d of DIRS4) {
      if (blocked.has(`explore:${d}`)) continue;
      out.push({ id: d, label: d, labelEn: `${d}, about 20 blocks`, dir: d, kind: 'dir', vec: VEC[d], dist: o.distance });
    }
    return out;
  }
  for (const [range, dist] of [['near', o.near], ['far', o.far]]) {
    for (const [d] of DIRS8) {
      const id = `${d}_${range}`;
      if (blocked.has(`explore:${id}`)) continue;
      const [vx, vz] = VEC[d];
      const c = cellAtPos(here.x + vx * dist, here.z + vz * dist);
      out.push({ id, label: `${JP[d]}へ${dist}m ${visitText(c, tick)}`, labelEn: `${DIR_EN[d]}, ${DIST_EN(dist)} (${visitTextEn(c, tick)})`, dir: d, kind: 'dir', vec: [vx, vz], dist });
    }
  }
  // まだ行っていない一番近いマス (今いるマスから maxRing マス以内)
  if (!blocked.has('explore:unvisited')) {
    const hx = Math.floor(here.x / size); const hz = Math.floor(here.z / size);
    let best = null;
    for (let r = 1; r <= o.maxRing && !best; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const c = idx.get(`${hx + dx},${hz + dz}`);
          if (c && c.n) continue;
          const tx = (hx + dx + 0.5) * size; const tz = (hz + dz + 0.5) * size;
          const d = Math.hypot(tx - here.x, tz - here.z);
          if (!best || d < best.d) best = { tx, tz, d, cx: hx + dx, cz: hz + dz };
        }
      }
    }
    if (best) {
      out.push({ id: 'unvisited', label: `まだ行っていないマスへ (${dirJp(best.tx - here.x, best.tz - here.z)}へ約${Math.round(best.d)}m)`,
        labelEn: `to the nearest unvisited area (${JP_EN[dirJp(best.tx - here.x, best.tz - here.z)]}, ${DIST_EN(best.d)})`,
        kind: 'unvisited', target: { x: best.tx, z: best.tz }, dist: Math.round(best.d), cell: [best.cx, best.cz] });
    }
  }
  if (!blocked.has('explore:random')) {
    out.push({ id: 'random', label: `でたらめな方へ (${o.randomMin}〜${o.randomMax}m)`, labelEn: 'in a random direction', kind: 'random', randomMin: o.randomMin, randomMax: o.randomMax });
  }
  return out;
}

// 実行時に行き先を決める。rand は [0,1) を返す関数 (テストで差し替える)
function exploreTarget(start, ch, rand = Math.random) {
  if (ch.kind === 'unvisited' && ch.target) {
    return { x: ch.target.x, z: ch.target.z, dist: Math.round(Math.hypot(ch.target.x - start.x, ch.target.z - start.z)), dirJp: dirJp(ch.target.x - start.x, ch.target.z - start.z) };
  }
  if (ch.kind === 'random') {
    const a = rand() * Math.PI * 2;
    const dist = Math.round(ch.randomMin + rand() * (ch.randomMax - ch.randomMin));
    const vx = Math.cos(a); const vz = Math.sin(a);
    return { x: start.x + vx * dist, z: start.z + vz * dist, dist, dirJp: dirJp(vx, vz) };
  }
  const [vx, vz] = ch.vec || VEC[ch.dir] || [0, -1];
  const dist = ch.dist || DEFAULTS.distance;
  return { x: start.x + vx * dist, z: start.z + vz * dist, dist, dirJp: ch.dir ? (JP[ch.dir] || ch.dir) : dirJp(vx, vz) };
}

module.exports = { visitTextEn, exploreChoices, exploreTarget, visitText, dirJp, DEFAULTS, DIRS8, DIRS4, VEC };
