'use strict';
// 行動の選択肢の重み (2026-11-07 ユーザー決定 3): 人の所へ行く・ついて行くは消さずに、Jev の選択確率に係数を掛けて下げる。
//   go_to(人)・follow(人) × people (既定 0.4)。ただし次の人は別:
//     - ゴールがその人 (goalpath の kind: 'person') → 重み 1 (下げない)
//     - 最近 (exemptTicks 判断以内) その人に名前を呼ばれた・頼まれた・誘われた (isCalled。名前が入っているだけの発言は数えない) → called (既定 1)
//   go_to(覚えている場所 M) × memPlace (既定 0.7)。ただしゴール・道筋に関係する場所 (種類が道筋の物、ゴールの場所) は下げない。
//   掛けたあと足して 1 にし、一番大きいものを選ぶ (noChange の重みと同じ所。deciders/jev.js)。
// 数値はここと config だけで持ち、モデルには見せない。
//   explore (方角・遠く・拠点から離れる方など、行き先のある explore の選択肢) × (1 − (1 − visited) × 行き先までの道のりのうち自分が行ったマスの割合)。
//     よく行った範囲 (出現地点のまわりなど) を通るだけの方角ほど下げる (自分の踏破 memory.cells から)。visited: 1 で下げない
const DEFAULTS = { enabled: false, people: 0.4, memPlace: 0.7, called: 1, exemptTicks: 10, visited: 1, cellSize: 16 };

// here から vec の向きに dist m 先までの道のりのマス (cellSize ごと) のうち、自分が行ったマス (cells の n > 0) の割合
function visitedFrac(here, vec, dist, cells, size = 16) {
  if (!here || !vec || !dist) return 0;
  const own = cells instanceof Map ? cells : new Map((cells || []).filter((c) => c && c.n).map((c) => [`${c.cx},${c.cz}`, c]));
  const keys = new Set(); let n = 0; let mine = 0;
  for (let s = size; s <= dist + 1e-6; s += size) {
    const k = `${Math.floor((here.x + vec[0] * s) / size)},${Math.floor((here.z + vec[1] * s) / size)}`;
    if (keys.has(k)) continue;
    keys.add(k); n += 1;
    if (own.has(k)) mine += 1;
  }
  return n ? mine / n : 0;
}

function cfgOf(c) { return { ...DEFAULTS, ...(c || {}) }; }

// 呼ばれた・頼まれた・誘われた: 自分の名前が入っていて、呼ぶ (call の「X、来て」)・聞く (ask の「X、…?」)・頼む (division の REQUEST)・誘う 形の発言。
//   名前が入っているだけ (「Ken、木集め助かる」) は数えない
const INVITE = /来て|来い|おいで|ついて(来|き)|集ま|一緒|行こう|しよう|しません|やろう|手伝|[?？]$/;
function isCalled(text, me) {
  const t = String(text || '');
  if (!me || !t.includes(me)) return false;
  const { REQUEST } = require('./division');
  return INVITE.test(t) || REQUEST.test(t);
}

// actions: listActions の一覧。返り値 { weights: { "action:arg": 係数 }, exempt: [名前] }
//   o: { exemptPeople: Set(名前。重み 1), calledPeople: Set(名前。重み called), relatedKinds: Set(場所の種類・物の名前), relatedIds: Set(M番号), relatedPos: [位置] }
function choiceWeights(actions, o = {}, cfg = {}) {
  const c = cfgOf(cfg);
  const out = {};
  if (!c.enabled) return out;
  const ex = o.exemptPeople || new Set();
  const called = o.calledPeople || new Set();
  const pw = (n) => (ex.has(n) ? 1 : called.has(n) ? c.called : c.people);
  const rel = o.relatedKinds || new Set();
  const relIds = o.relatedIds || new Set();
  const relPos = o.relatedPos || [];
  const near = (p) => !!p && relPos.some((q) => q && Math.hypot(p.x - q.x, p.z - q.z) <= (c.relatedDist ?? 4));
  for (const a of actions || []) {
    if (!Array.isArray(a.choices)) continue;
    if (a.name === 'follow') {
      for (const ch of a.choices) { const w = pw(ch.player || ch.id); if (w !== 1) out[`follow:${ch.id}`] = w; }
    } else if (a.name === 'explore' && c.visited !== 1 && o.here && o.cells) {
      const own = new Map((o.cells || []).filter((x) => x && x.n).map((x) => [`${x.cx},${x.cz}`, x]));
      for (const ch of a.choices) {
        if (!ch.vec || !ch.dist) continue; // でたらめ・まだ行っていないマスは下げない
        const fr = visitedFrac(o.here, ch.vec, ch.dist, own, o.cellSize || c.cellSize);
        const w = Math.round((1 - (1 - c.visited) * fr) * 1000) / 1000;
        if (w !== 1) out[`explore:${ch.id}`] = w;
      }
    } else if (a.name === 'go_to') {
      for (const ch of a.choices) {
        if (ch.player) { const w = pw(ch.player); if (w !== 1) out[`go_to:${ch.id}`] = w; } else if (ch.fromMemory) {
          const related = relIds.has(ch.id) || (ch.kind && rel.has(ch.kind)) || near(ch.pos);
          if (!related && c.memPlace !== 1) out[`go_to:${ch.id}`] = c.memPlace;
        }
      }
    }
  }
  return out;
}

// probabilities: { key: p }、mult: { key: 係数 } → { choice, original, changed, probs }
function reweightMult(probabilities, mult) {
  const entries = Object.entries(probabilities || {});
  if (!entries.length) return null;
  const orig = entries.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  const w = entries.map(([k, p]) => [k, p * (mult && mult[k] != null ? mult[k] : 1)]);
  const sum = w.reduce((t, [, p]) => t + p, 0) || 1;
  const probs = Object.fromEntries(w.map(([k, p]) => [k, p / sum]));
  const choice = w.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  return { choice, original: orig, changed: choice !== orig, probs };
}

module.exports = { visitedFrac, DEFAULTS, cfgOf, choiceWeights, reweightMult, isCalled, INVITE };
