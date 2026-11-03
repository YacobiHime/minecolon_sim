'use strict';
// 成功しても状態が変わらない繰り返しを「困っている」と見なす部品 (実験的。help.noChange で切り替える)。
//   状態 = 持ち物・位置 (1ブロック以内は同じ)・小屋の埋まった数。行動の前と後で比べる。
//   ① 同じ行動・引数で状態が変わらなかったことが直近 window 回で repeat 回 → 困っている (failRepeat と同じく「周りに聞く」へ)
//   ② 直近 weightWindow 回で状態が変わらなかった回数 n だけ、その行動の Jev の確率に weight^n を掛けて選び直す
// bot に依存しない (テストできるように)。
const EXEMPT = new Set(['say', 'ask']); // 話す・聞くは状態を変えない行動なので数えない

const DEFAULTS = { window: 4, repeat: 2, weight: 0.5, weightWindow: 6 };

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

module.exports = { snapshot, changed, noChangeKeys, penalties, reweight, invKey, DEFAULTS, EXEMPT };
