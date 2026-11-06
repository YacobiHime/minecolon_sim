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
// scope: 'self' (自分が行ったマスで「行ったか」を決める) | 'all' (全員の踏破。allCells = explored.js の merge())
// extra: 近さだけで選ばない候補 (拠点から離れる方・踏破したマスが少ない方・人の少ない方) を足す。sectorRing: 方角ごとに数えるマスの範囲
const DEFAULTS = { mode: 'basic', distance: 20, near: 12, far: 35, randomMin: 15, randomMax: 35, maxRing: 6, scope: 'self', extra: false, sectorRing: 12, peopleRange: 200 };

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

// 全員の踏破のとき: 「誰も行ったことなし」「2人が行った (5回)」
function visitTextAll(c) {
  if (!c || !c.n) return '誰も行ったことなし';
  return `${(c.who || []).length || 1}人が行った (${c.n}回)`;
}
function visitTextAllEn(c) {
  if (!c || !c.n) return 'nobody has been there';
  const k = (c.who || []).length || 1;
  return `${k === 1 ? 'one person has' : k <= 3 ? 'a few people have' : 'many people have'} been there`;
}

// 8方位のどれに入るか (dx, dz から。DIRS8 の id)
function sectorOf(dx, dz) {
  const a = Math.atan2(dz, dx);
  const order = ['east', 'southeast', 'south', 'southwest', 'west', 'northwest', 'north', 'northeast'];
  return order[((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8];
}

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
  const all = o.scope === 'all' && Array.isArray(o.allCells);
  const idx = cellIndex(all ? o.allCells : o.cells);
  const vText = (c) => (all ? visitTextAll(c) : visitText(c, tick));
  const vTextEn = (c) => (all ? visitTextAllEn(c) : visitTextEn(c, tick));
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
      out.push({ id, label: `${JP[d]}へ${dist}m ${vText(c)}`, labelEn: `${DIR_EN[d]}, ${DIST_EN(dist)} (${vTextEn(c)})`, dir: d, kind: 'dir', vec: [vx, vz], dist });
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
      out.push({ id: 'unvisited', label: `${all ? '誰も行っていない' : 'まだ行っていない'}マスへ (${dirJp(best.tx - here.x, best.tz - here.z)}へ約${Math.round(best.d)}m)`,
        labelEn: `to the nearest ${all ? 'area nobody has visited' : 'unvisited area'} (${JP_EN[dirJp(best.tx - here.x, best.tz - here.z)]}, ${DIST_EN(best.d)})`,
        kind: 'unvisited', target: { x: best.tx, z: best.tz }, dist: Math.round(best.d), cell: [best.cx, best.cz] });
    }
  }
  if (o.extra) out.push(...extraChoices(here, o, idx, vText, vTextEn, blocked));
  if (!blocked.has('explore:random')) {
    out.push({ id: 'random', label: `でたらめな方へ (${o.randomMin}〜${o.randomMax}m)`, labelEn: 'in a random direction', kind: 'random', randomMin: o.randomMin, randomMax: o.randomMax });
  }
  return out;
}

// 近さだけで選ばない候補 (事実だけを添える): 拠点から離れる方・踏破したマスが少ない方・人の少ない方。行き先は far m 先
function extraChoices(here, o, idx, vText, vTextEn, blocked) {
  const size = o.cellSize || 16;
  const dist = o.far;
  const out = [];
  const at = (vx, vz) => idx.get(`${Math.floor((here.x + vx * dist) / size)},${Math.floor((here.z + vz * dist) / size)}`);
  const push = (id, d, head, headEn, fact, factEn) => {
    if (blocked.has(`explore:${id}`)) return;
    const [vx, vz] = VEC[d];
    const c = at(vx, vz);
    out.push({ id, label: `${head} (${JP[d]}へ${dist}m・${fact}・${vText(c)})`, labelEn: `${headEn} (${DIR_EN[d]}, ${DIST_EN(dist)}; ${factEn}; ${vTextEn(c)})`, dir: d, kind: 'dir', vec: [vx, vz], dist });
  };
  if (o.base && Math.hypot(here.x - o.base.x, here.z - o.base.z) >= 4) {
    const d = sectorOf(here.x - o.base.x, here.z - o.base.z);
    const bd = Math.round(Math.hypot(here.x - o.base.x, here.z - o.base.z));
    push('away_base', d, '拠点から離れる方', 'away from the base', `今は拠点から${bd}m`, `${bd}m from the base now`);
  }
  // 方角ごとの踏破したマスの数 (今いるマスから sectorRing マス以内)
  const hx = Math.floor(here.x / size); const hz = Math.floor(here.z / size);
  const cnt = Object.fromEntries(DIRS8.map(([id]) => [id, 0]));
  for (const c of idx.values()) {
    const dx = c.cx - hx; const dz = c.cz - hz;
    if ((!dx && !dz) || Math.max(Math.abs(dx), Math.abs(dz)) > o.sectorRing || !c.n) continue;
    cnt[sectorOf(dx, dz)] += 1;
  }
  const least = DIRS8.map(([id]) => id).sort((a, b) => cnt[a] - cnt[b])[0];
  push('least_explored', least, o.scope === 'all' ? 'みんなの踏破したマスが少ない方' : '自分の踏破したマスが少ない方', o.scope === 'all' ? 'the direction with the fewest areas anyone has visited' : 'the direction with the fewest areas I have visited',
    `その方角の踏破したマス${cnt[least]}`, `${cnt[least]} visited areas that way`);
  // 人の少ない方 (ほかの人の今いる所が分かるとき。explored.js の positions)
  if (Array.isArray(o.others) && o.others.length) {
    const pc = Object.fromEntries(DIRS8.map(([id]) => [id, 0]));
    for (const p of o.others) {
      const dx = p.pos.x - here.x; const dz = p.pos.z - here.z;
      if (Math.hypot(dx, dz) > o.peopleRange) continue;
      if (Math.hypot(dx, dz) >= 1) pc[sectorOf(dx, dz)] += 1;
    }
    const few = DIRS8.map(([id]) => id).sort((a, b) => pc[a] - pc[b])[0];
    push('few_people', few, '人の少ない方', 'the direction with the fewest people', `その方角にいる人${pc[few]}`, `${pc[few]} people that way`);
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

module.exports = { sectorOf, visitTextAll, extraChoices, visitTextEn, exploreChoices, exploreTarget, visitText, dirJp, DEFAULTS, DIRS8, DIRS4, VEC };
