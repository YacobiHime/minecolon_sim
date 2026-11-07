'use strict';
// 珍しさ・大事さ (2026-11-07 ユーザー決定 2「どこにでもある物より、探す必要がある大事な物を重く見る」)。bot に依存しない部分。
//   珍しさ: 物の入手元 (ブロック・生き物) ごとに、自分がどれだけ見かけたか (見えた数・場所の数・最後に見てからの時間) から
//     「いつでも手に入る度合い」a (0〜1) を持つ。草・葉・土のように、どこへ行っても一度にたくさん見える物は a が速く 1 に近づき、
//     羊のように、たまにしか・少しずつしか見えない物は a が小さいまま。ありふれた物を既定で決めた一覧は持たない (初めは見えた数で決まる)。
//       S = Σ_マス (そのマスで一度に見えた数の最大)、abundance = 1 − exp(−S / k0)
//       recency = exp(−最後に見てからの時間 / tau)、a = abundance × (recencyFloor + (1 − recencyFloor) × recency)
//     珍しさの係数 R = 1 + rho × (1 − 2a) + rhoNow × (1 − a) × (今見えている ? 1 : 0)
//       (ありふれた物 a≈1 → 1 − rho。見つけにくい物 a≈0 → 1 + rho。見つけにくい物が今見えている → さらに + rhoNow: 今見つけないと手に入らない)
//     ゴールの物の道筋の最後が掘る・倒す (入手元から直接取る物。種・羊肉・羊毛・原木など) なら、その入手元の R をそのまま掛ける。
//     作る物 (道筋の最後が作る・焼く) は、まだ取りに行く材料の入手元のうち a のいちばん小さいものの R を、1 より大きいときだけ掛ける
//     (珍しい材料が要る物は上げるが、ありふれた材料だけでできる物は下げない)。
//   大事さ: 同じ選び直しのほかの案 j の道筋 (planner。レシピ・仕様からの手順) を逆にたどり、案 i の物がその材料として出てくれば
//     案 j の欲求の点 N_j = Σ つらさ × P_j を数える: Imp_i = Σ_j w_ij × N_j (w = 1: 物そのものが材料、sourceShare: 入手元だけが同じ)。
//     例: 白いベッドの案 (眠気・夜の安心の P が高い) の道筋に white_wool ← 羊 があれば、羊毛の案・羊肉の案 (入手元が羊) に足される。
//     欲求 → 物の対応表は持たない。点の分子に lambda × (1 − a_i) × Imp_i を足す (探す必要のある物ほど効く。ありふれた材料・手元で作れる物には効かない)。
// 研究方針: 数値はここと config だけで持ち、モデルには見せない。
const DEFAULTS = {
  enabled: false,
  cellSize: 16,
  k0: 24,
  tau: 12000, // ゲーム内の tick (半日)
  recencyFloor: 0.5,
  rho: 0.5,
  rhoNow: 0.5,
  lambda: 0.3,
  sourceShare: 0.5,
  maxCells: 64,
  maxNames: 400,
};

function cfgOf(c) { return { ...DEFAULTS, ...(c || {}) }; }

// 見かけた記録。store は memory.extra.sightings (保存される) を渡す: { names: { 名前: { S, cells: { "cx,cz": 最大数 }, nc, views, first, last } } }
class Sightings {
  constructor(store, cfg = {}) {
    this.cfg = cfgOf(cfg);
    this.store = store && typeof store === 'object' ? store : {};
    if (!this.store.names || typeof this.store.names !== 'object') this.store.names = {};
  }

  // 1つの入手元を、あるマスで n 個見た
  add(name, pos, n, now) {
    if (!name || !pos || !(n > 0)) return;
    const c = this.cfg;
    const names = this.store.names;
    let r = names[name];
    if (!r) {
      if (Object.keys(names).length >= c.maxNames) return;
      r = names[name] = { S: 0, cells: {}, nc: 0, views: 0, first: now, last: now };
    }
    const k = `${Math.floor(pos.x / c.cellSize)},${Math.floor(pos.z / c.cellSize)}`;
    const old = r.cells[k];
    if (old == null) {
      r.nc += 1;
      if (Object.keys(r.cells).length < c.maxCells) r.cells[k] = n; // 入りきらないマスは S にだけ足す
      r.S += n;
    } else if (n > old) { r.S += n - old; r.cells[k] = n; }
    r.views += 1;
    r.last = now;
  }

  // 1回の観測 (observe.collectRaw の raw)。ブロックは種類ごとの見えた数 (seen) を、近いブロックのマスで。生き物は名前ごとに数えて、それぞれのマスで
  note(raw, now) {
    if (!raw) return;
    for (const b of raw.blocks || []) this.add(b.name, b.nearest || (raw.self && raw.self.pos), b.seen || 1, now);
    const byCell = new Map();
    for (const e of raw.entities || []) {
      if (!e || !e.name || e.kind === 'player' || e.kind === 'item' || !e.pos) continue;
      const k = `${e.name}|${Math.floor(e.pos.x / this.cfg.cellSize)},${Math.floor(e.pos.z / this.cfg.cellSize)}`;
      const x = byCell.get(k) || { name: e.name, pos: e.pos, n: 0 };
      x.n += 1; byCell.set(k, x);
    }
    for (const x of byCell.values()) this.add(x.name, x.pos, x.n, now);
  }

  // いつでも手に入る度合い。返り値 { a, S, cells, ago, seen }
  availability(name, now) {
    const c = this.cfg;
    const r = this.store.names[name];
    if (!r) return { a: 0, S: 0, cells: 0, ago: null, seen: false };
    const abundance = 1 - Math.exp(-r.S / c.k0);
    const ago = Number.isFinite(now) && Number.isFinite(r.last) ? Math.max(0, now - r.last) : 0;
    const rec = Math.exp(-ago / c.tau);
    const a = abundance * (c.recencyFloor + (1 - c.recencyFloor) * rec);
    return { a: r3(a), S: r.S, cells: r.nc, ago, seen: true };
  }
}

function r3(x) { return Math.round(x * 1000) / 1000; }

// 珍しさの係数 R (a: いつでも手に入る度合い、now: 今見えている)
function rarityFactor(a, now, cfg = {}) {
  const c = cfgOf(cfg);
  return r3(1 + c.rho * (1 - 2 * a) + (now ? c.rhoNow * (1 - a) : 0));
}

// 道筋 (planner の path) の、まだ取りに行く入手元 (掘る・倒す の from)
function rawSources(path) {
  const out = [];
  for (const s of (path && path.steps) || []) if ((s.how === 'collect' || s.how === 'kill') && s.from && !out.includes(s.from)) out.push(s.from);
  return out;
}

// ゴールの物の珍しさ。target: 物の名前、path: planner の path、avail(name) → { a }、visible: Set(今見えている入手元の名前)
//   返り値 { R, source, a, kind: 'raw' | 'crafted' | null, now }
function itemRarity(target, path, avail, visible = new Set(), cfg = {}) {
  if (!path || !path.ok || !path.steps || !path.steps.length) return { R: 1, source: null, a: null, kind: null, now: false };
  const own = path.steps.find((s) => s.item === target);
  if (own && (own.how === 'collect' || own.how === 'kill') && own.from) {
    const a = avail(own.from).a;
    const now = visible.has(own.from);
    return { R: rarityFactor(a, now, cfg), source: own.from, a, kind: 'raw', now };
  }
  const srcs = rawSources(path);
  if (!srcs.length) return { R: 1, source: null, a: null, kind: 'crafted', now: false };
  let best = null;
  for (const s of srcs) { const a = avail(s).a; if (!best || a < best.a) best = { s, a }; }
  const now = visible.has(best.s);
  const R = rarityFactor(best.a, now, cfg);
  return { R: Math.max(1, R), source: best.s, a: best.a, kind: 'crafted', now };
}

// 道筋に出てくる物の名前 (材料・途中の物) と入手元。返り値 { items: Set, sources: Set }
function pathMaterials(path) {
  const items = new Set(); const sources = new Set();
  const steps = (path && path.steps) || [];
  for (const s of steps) {
    if (s.item) items.add(s.item);
    if (s.from && (s.how === 'collect' || s.how === 'kill')) sources.add(s.from);
    if (s.seed) items.add(s.seed);
    if (s.ings) for (const k of Object.keys(s.ings)) items.add(k);
  }
  // 状態の道筋 (states.planState): 物の手順は items.steps にある
  if (path && path.items && path.items.steps) { const m = pathMaterials(path.items); for (const x of m.items) items.add(x); for (const x of m.sources) sources.add(x); }
  return { items, sources };
}

// 大事さの重み W[i][j] (案 i の物が、案 j の道筋の材料に出てくるか)。props: [{ kind, target, path }]
//   i が物の案のときだけ: 物そのものが j の材料 → 1、i の入手元 (道筋の最後の掘る・倒す の from) だけが j の入手元 → sourceShare
function importanceWeights(props, cfg = {}) {
  const c = cfgOf(cfg);
  const mats = props.map((p) => pathMaterials(p.path));
  return props.map((pi, i) => props.map((pj, j) => {
    if (i === j || pi.kind !== 'item' || !pi.target) return 0;
    if (pj.kind === 'item' && pj.target === pi.target) return 0;
    if (mats[j].items.has(pi.target)) return 1;
    const own = pi.path && pi.path.steps ? pi.path.steps.find((s) => s.item === pi.target && (s.how === 'collect' || s.how === 'kill')) : null;
    if (own && own.from && mats[j].sources.has(own.from)) return c.sourceShare;
    return 0;
  }));
}

module.exports = { DEFAULTS, cfgOf, Sightings, rarityFactor, itemRarity, rawSources, pathMaterials, importanceWeights };
