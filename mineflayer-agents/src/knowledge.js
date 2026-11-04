'use strict';
// 知っていること (仕様の事実) から、今に関係するものだけを選ぶ部品 (bot に依存しない)。
//   knowledge/facts.json: [{ id, text, items: ["oak_log", "*_planks", "wooden_*"], actions: ["craft"], always: false }]
//     items   : minecraft のアイテム・ブロック・生き物の名前。先頭の * は後方一致 (*_planks)、末尾の * は前方一致 (wooden_*)
//     actions : 関係する行動の名前 (2段目でその行動が選ばれたときに当たる)
//     always  : true なら常に出す (今の facts.json では使っていない。状況で出す when に移した)
//     when    : 出す状況 (situations() の名前: night・dusk・hostile・hungry・hurt・died・start)。当たると強めに数える
//   当たるもの: 持ち物・見えているブロック/生き物/落ちている物・選択肢の対象・plan の文に出てくる名前・選ばれた行動の名前
// 研究の方針: 仕様 (事実) は見せてよいが、どう使うかは教えない (評価語・使い方の指示は facts.json に書かない)。
const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, '..', 'knowledge', 'facts.json');
const DEFAULTS = { max: 8, stage2Max: 4 };
// 選ぶときの重み: 道筋 (plan) やゴールに出てくる名前は、持ち物・見えている物より強く数える。状況 (when) に当たったものはさらに強く
const WEIGHT = { name: 1, strong: 3, action: 2, when: 4 }; // stage2Max: 2段目 (対象を選ぶ) に出す数

const cache = new Map();

// 無い・空・壊れているときは [] (動き続ける)。同じファイルは1回だけ読む
function loadFacts(file = DEFAULT_FILE, { reload = false } = {}) {
  const f = path.resolve(path.join(__dirname, '..'), file);
  if (!reload && cache.has(f)) return cache.get(f);
  let facts = [];
  try {
    const txt = fs.readFileSync(f, 'utf8').trim();
    const d = txt ? JSON.parse(txt) : [];
    facts = (Array.isArray(d) ? d : []).filter((x) => x && typeof x.text === 'string' && x.text.trim())
      .map((x, i) => ({ id: x.id || `f${i}`, text: x.text.trim(), items: Array.isArray(x.items) ? x.items : [], actions: Array.isArray(x.actions) ? x.actions : [], when: Array.isArray(x.when) ? x.when : [], always: !!x.always }));
  } catch (_) {
    facts = [];
  }
  cache.set(f, facts);
  return facts;
}

function matchName(pattern, name) {
  const p = String(pattern);
  if (p.startsWith('*') && p.endsWith('*') && p.length > 2) return name.includes(p.slice(1, -1));
  if (p.startsWith('*')) return name.endsWith(p.slice(1));
  if (p.endsWith('*')) return name.startsWith(p.slice(0, -1));
  return name === p;
}

// 観測・行動の一覧・plan から、今出てくる名前の集合
function namesInView({ raw = null, actions = [], plan = '' } = {}) {
  const s = new Set();
  if (raw) {
    for (const i of raw.inventory || []) s.add(i.name);
    for (const b of raw.blocks || []) s.add(b.name);
    for (const e of raw.entities || []) if (e.kind !== 'player') s.add(e.name);
  }
  for (const a of actions || []) for (const c of a.choices || []) { s.add(c.id); if (c.item) s.add(c.item); if (c.block) s.add(c.block); if (c.mob) s.add(c.mob); }
  for (const w of String(plan || '').match(/[a-z][a-z0-9_]+/g) || []) s.add(w);
  return s;
}

// 今の状況の名前 (facts.json の when に当たる): 夜・夕方・敵が見える・お腹が空いた・傷が多い・死んだばかり・始まったばかり
//   raw: 観測、opts: { tick, diedAt (最後に死んだ判断の番号), hungryBelow, hurtBelow, startTicks, diedTicks }
function situations(raw, { tick = null, diedAt = null, hungryBelow = 15, hurtBelow = 12, startTicks = 5, diedTicks = 10 } = {}) {
  const s = new Set();
  if (!raw || !raw.self) return s;
  const t = (((raw.self.timeOfDay ?? 6000) % 24000) + 24000) % 24000;
  if (t >= 13000 && t < 23000) s.add('night');
  if (t >= 11000 && t < 13000) s.add('dusk');
  if ((raw.entities || []).some((e) => e.kind === 'hostile')) s.add('hostile');
  if (raw.self.food != null && raw.self.food < hungryBelow) s.add('hungry');
  if (raw.self.health != null && raw.self.health < hurtBelow) s.add('hurt');
  if (tick != null && tick <= startTicks) s.add('start');
  if (tick != null && diedAt != null && tick - diedAt <= diedTicks) s.add('died');
  return s;
}

// facts から当たるものを選ぶ。点 = 名前の当たり (道筋・ゴールの名前 strong は強く) + 行動の当たり + 状況 (when) の当たり。
// always は常に (いちばん強く)。点の高い順に max 個まで (同じなら facts.json の順)。出す並びは facts.json の順
// always: false なら always・when の事実も名前・行動に当たったときだけ (2段目用)
function selectFacts(facts, { names = new Set(), strong = new Set(), actions = new Set(), situations: sit = new Set(), max = DEFAULTS.max, exclude = new Set(), always = true } = {}) {
  const scored = [];
  const nameList = [...names];
  const strongList = [...strong];
  (facts || []).forEach((f, i) => {
    if (exclude.has(f.text)) return;
    const itemHits = f.items.filter((p) => nameList.some((n) => matchName(p, n))).length;
    const strongHits = f.items.filter((p) => strongList.some((n) => matchName(p, n))).length;
    const actHits = f.actions.filter((a) => actions.has(a)).length;
    const whenHits = always ? (f.when || []).filter((w) => sit.has(w)).length : 0;
    const alw = always && f.always;
    if (!alw && !itemHits && !strongHits && !actHits && !whenHits) return;
    const score = (alw ? 1000 : 0) + WEIGHT.name * Math.max(itemHits, strongHits) + (WEIGHT.strong - WEIGHT.name) * strongHits + WEIGHT.action * actHits + WEIGHT.when * whenHits;
    scored.push({ f, i, score });
  });
  scored.sort((a, b) => (b.score - a.score) || (a.i - b.i));
  return scored.slice(0, Math.max(0, max)).sort((a, b) => a.i - b.i).map((x) => x.f);
}

// 文の中の英語名 (道筋・ゴールの文から strong の名前を作る)
function namesInText(text) { return new Set(String(text || '').match(/[a-z][a-z0-9_]+/g) || []); }

module.exports = { loadFacts, selectFacts, namesInView, namesInText, situations, matchName, DEFAULT_FILE, DEFAULTS, WEIGHT };
