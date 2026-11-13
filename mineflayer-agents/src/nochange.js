'use strict';
// 成功しても状態が変わらない繰り返しを「困っている」と見なす部品 (実験的。help.noChange で切り替える)。
//   状態 = 持ち物・位置 (1ブロック以内は同じ)・小屋の埋まった数。行動の前と後で比べる。
//   ① 同じ行動・引数で状態が変わらなかったことが直近 window 回で repeat 回 → 困っている (failRepeat と同じく「周りに聞く」へ)
//   ② 直近 weightWindow 回で状態が変わらなかった回数 n だけ、その行動の Jev の確率に weight^n を掛けて選び直す
// bot に依存しない (テストできるように)。
const EXEMPT = new Set(['say', 'ask']); // 話す・聞くは状態を変えない行動なので数えない

// net*: 直近 netWindow 回をさかのぼった正味の変化で見る (下の netNoChange)。net: false で使わない
const DEFAULTS = {
  window: 4, repeat: 2, weight: 0.5, weightWindow: 6,
  net: true, netWindow: 10, netRepeat: 2, netMinLoops: 4, invTol: 1, moveDist: 8, blockTol: 1,
  netExempt: ['say', 'ask', 'attack', 'flee', 'sleep'],
};

function invKey(inventory) {
  const m = new Map();
  for (const i of inventory || []) m.set(i.name, (m.get(i.name) || 0) + i.count);
  return [...m].sort(([a], [b]) => (a < b ? -1 : 1)).map(([n, c]) => `${n}x${c}`).join(',');
}

// { inventory: [{name,count}], pos: {x,y,z}, hutFilled: number|null }
function snapshot({ inventory, pos, hutFilled = null }) {
  return { inv: invKey(inventory), pos: pos ? { x: pos.x, y: pos.y, z: pos.z } : null, hut: hutFilled };
}

function changed(a, b) {
  if (!a || !b) return true;
  if (a.inv !== b.inv) return true;
  if (a.hut !== b.hut) return true;
  if (a.pos && b.pos) {
    const d = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y, a.pos.z - b.pos.z);
    if (d > 1) return true;
  }
  return false;
}

function counts(events, window) {
  const cnt = new Map();
  for (const e of (events || []).slice(-window)) {
    if (!e.nc || EXEMPT.has(e.action)) continue;
    const k = `${e.action}:${e.arg}`;
    cnt.set(k, (cnt.get(k) || 0) + 1);
  }
  return cnt;
}

// ① 困っている key の集合
function noChangeKeys(events, window = DEFAULTS.window, repeat = DEFAULTS.repeat) {
  return new Set([...counts(events, window)].filter(([, n]) => n >= repeat).map(([k]) => k));
}

// ② key ("action:arg") → 状態が変わらなかった回数
function penalties(events, weightWindow = DEFAULTS.weightWindow) {
  return Object.fromEntries(counts(events, weightWindow));
}

// probabilities: { optionKey: p }、keyOf(optionKey) → "action:arg"
// 返り値 { choice, changed, probs } (probs は掛け直して足して 1 にしたもの)
function reweight(probabilities, keyOf, pens, weight = DEFAULTS.weight) {
  const entries = Object.entries(probabilities || {});
  if (!entries.length) return null;
  const orig = entries.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  const w = entries.map(([k, p]) => [k, p * Math.pow(weight, (pens && pens[keyOf(k)]) || 0)]);
  const sum = w.reduce((t, [, p]) => t + p, 0) || 1;
  const probs = Object.fromEntries(w.map(([k, p]) => [k, p / sum]));
  const choice = w.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  return { choice, original: orig, changed: choice !== orig, probs };
}

// ---- 直近 N 回をさかのぼった正味の変化 ----
// 1回ごとの「変わったか」(changed) は、毎回 持ち物±1・高さ±1 変わる繰り返し (足場を積む → その足場を掘る、
// 作業台を置く → 掘る) をすり抜ける。そこで netWindow 回前と今を比べ、正味がほぼ0なら、
// その間に繰り返し出た行動を「何度やっても何も変わらなかった」扱いにする。
//   履歴の1件 = 1回の行動の後の状態 { key: "action:arg", inv: {name: count}, pos, newCell, blocks }
//     blocks = 置いた数 − 掘った数 (blockDelta)。newCell = 行動の後に、まだ覚えていないマスに入った
//   (a) 窓全体: 持ち物の差の合計 ≤ invTol、位置の差 < moveDist、新しいマスなし、|置いた−掘った| ≤ blockTol
//       → 窓の中で netRepeat 回以上出た行動 (netExempt を除く) すべて
//   (b) 窓全体では何か変わっていても、繰り返した行動 1つか2つの組だけを足し合わせると正味0
//       (その行動の回数の合計が netMinLoops 以上) → その行動
//       例: 作業台を置く・掘るを3回ずつ繰り返す間に、チェストを1個作った

function invCounts(inventory) {
  const m = {};
  for (const i of inventory || []) m[i.name] = (m[i.name] || 0) + i.count;
  return m;
}

function invDiff(a, b) {
  let d = 0;
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) d += Math.abs((a[k] || 0) - (b[k] || 0));
  return d;
}

// 行動の結果の文から、置いた数 − 掘った数 (act.js の文: 「…を3個積んで」「…を(x,y,z)に置いた」「小屋に…を2個置いた」「…を2個掘って」)
function blockDelta(action, result) {
  if (!result || !result.ok) return 0;
  if (Number.isFinite(result.placed)) return result.placed;
  const msg = String(result.msg || '');
  let m;
  if ((m = msg.match(/を(\d+)個積んで/))) return Number(m[1]);
  if ((m = msg.match(/(\d+)個掘って/))) return -Number(m[1]); // 「…を素手で3個掘って」も
  if (action === 'place' && /に置いた/.test(msg)) return 1;
  return 0;
}

function histEntry({ action, arg, inventory, pos, newCell = false, result = null }) {
  return { key: `${action}:${arg ?? ''}`, action, inv: invCounts(inventory), pos: pos ? { x: pos.x, y: pos.y, z: pos.z } : null, newCell: !!newCell, blocks: blockDelta(action, result) };
}

const dist = (a, b) => (a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : 0);

// hist: histEntry の配列 (古い順)。最後の netWindow + 1 件を使う (先頭は窓の前の状態)
// 返り値 { keys: Set, counts: {key: 窓の中の回数}, scope: 'window'|'subset'|null }
function netNoChange(hist, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const W = o.netWindow;
  const none = { keys: new Set(), counts: {}, scope: null };
  if (!hist || hist.length < W + 1) return none;
  const h = hist.slice(-(W + 1));
  const base = h[0];
  const win = h.slice(1);
  const exempt = new Set(o.netExempt || []);
  const cnt = new Map();
  for (const e of win) if (!exempt.has(e.action)) cnt.set(e.key, (cnt.get(e.key) || 0) + 1);
  const rep = [...cnt].filter(([, n]) => n >= o.netRepeat).map(([k]) => k);
  if (!rep.length) return none;
  const last = win[win.length - 1];
  const blocksSum = (es) => es.reduce((t, e) => t + (e.blocks || 0), 0);
  const flat = (keys, scope) => ({ keys: new Set(keys), counts: Object.fromEntries(keys.map((k) => [k, cnt.get(k)])), scope });
  // (a) 窓全体
  if (invDiff(base.inv, last.inv) <= o.invTol && dist(base.pos, last.pos) < o.moveDist && !win.some((e) => e.newCell) && Math.abs(blocksSum(win)) <= o.blockTol) {
    return flat(rep, 'window');
  }
  // (b) 繰り返した行動 1つ・2つの組ごとに、その回だけの差を足し合わせる
  const steps = win.map((e, i) => {
    const prev = h[i];
    const d = {};
    for (const k of new Set([...Object.keys(prev.inv), ...Object.keys(e.inv)])) { const x = (e.inv[k] || 0) - (prev.inv[k] || 0); if (x) d[k] = x; }
    const mv = prev.pos && e.pos ? { x: e.pos.x - prev.pos.x, y: e.pos.y - prev.pos.y, z: e.pos.z - prev.pos.z } : { x: 0, y: 0, z: 0 };
    return { e, d, mv };
  });
  const sets = [];
  for (let i = 0; i < rep.length; i++) { sets.push([rep[i]]); for (let j = i + 1; j < rep.length; j++) sets.push([rep[i], rep[j]]); }
  const hit = new Set();
  for (const set of sets) {
    const ss = steps.filter((s) => set.includes(s.e.key));
    if (ss.length < o.netMinLoops) continue;
    const inv = {};
    const mv = { x: 0, y: 0, z: 0 };
    for (const s of ss) { for (const [k, x] of Object.entries(s.d)) inv[k] = (inv[k] || 0) + x; mv.x += s.mv.x; mv.y += s.mv.y; mv.z += s.mv.z; }
    const invNet = Object.values(inv).reduce((t, x) => t + Math.abs(x), 0);
    if (invNet <= o.invTol && Math.hypot(mv.x, mv.y, mv.z) < o.moveDist && !ss.some((s) => s.e.newCell) && Math.abs(blocksSum(ss.map((s) => s.e))) <= o.blockTol) {
      for (const k of set) hit.add(k);
    }
  }
  return hit.size ? flat([...hit], 'subset') : none;
}

// 1回ごとの penalties と、正味の変化で見た回数を合わせる (多い方)
function mergePenalties(a, b) {
  const out = { ...(a || {}) };
  for (const [k, n] of Object.entries(b || {})) out[k] = Math.max(out[k] || 0, n);
  return out;
}

module.exports = { snapshot, changed, noChangeKeys, penalties, reweight, invKey, DEFAULTS, EXEMPT, invCounts, invDiff, blockDelta, histEntry, netNoChange, mergePenalties };
