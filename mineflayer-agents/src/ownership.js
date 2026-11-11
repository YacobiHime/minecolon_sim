'use strict';
// 所有・機能損害・取得の理由・社会的な結果 (bot に依存しない部品。つなぎは ownership_agent.js)。
//
// 研究の要望 (2026-11-10 引き継ぎ): 他人の物を取らせないのではなく、取ったときの理由が
//   利己心・必要性・許可・誤認などとして観察・検証できること。物理的な取得を社会的な出来事に変える。
//
// 1. 部分的な知識 (OwnKnowledge): エージェントが所有者を知るのは、自分で置いた (self)・置くところを見た (seen)・
//    聞いた (heard)・共有にされた/共同のもの (project) だけ。それ以外は「所有者が分からない」。
//    見た目で人の置いた物と分かる種類 (松明・作業台・ベッド・板材など ARTIFACT) は、所有者が分からなくても置かれた物と認識する。
//    見た目が天然と同じ物 (丸石・土・原木など) は、知らなければ天然として collect に残る (台帳と突き合わせて「天然と誤認」になる)。
// 2. 理由 (decideReason): 行動の前に、欲求の値・代替手段の有無・所有の知識・許可・機能損害・性格から決定的に決める。
//    LLM は確定した記録を発話にするだけ (ownership_agent.js の phrase)。
// 3. 社会的な結果 (socialImpact): 目撃・後で気づいた・伝聞・説明・返却・補修で、関係 (好感・信頼) と感情の変化量を決める。
// 数値はここと config (cfg.provenance) だけで持ち、モデルには事実の言葉だけを見せる。

const { keyOf, normDim, posArr, sameFamily } = require('./provenance');

const DEFAULTS = {
  ledger: true, // 台帳 (ground truth) を書く。観察だけで、行動は変えない
  actions: false, // 部分的な知識と行動の分離 (collect / dismantle_own / take_placed / ask_permission / make_amends / repair_or_relocate_public)。比較実験の provenance on/off
  penalty: false, // 所有のペナルティ (判断の重み + 関係の変化)。比較実験の ownership penalty on/off
  reweight: null, // 判断の重みだけを切り替える (null なら penalty に従う)
  social: null, // 関係の変化だけを切り替える (null なら penalty に従う)
  syncMs: 2000, // ほかのプロセスの台帳を読み足す間隔
  countPlaced: true, // 物のゴールで、自分で置いて今も機能している物を「持っている」に数える (actions が on のとき。比較実験で off にできる)
  emergencyNeed: 0.8, // この値以上の関係する欲求 (安心・眠気・空腹) があり、代わりの手段が無ければ「緊急」
  askInEmergency: false, // 緊急のときも ask_permission を候補に出すか (引き継ぎ: 緊急でなければ出す)
  permitTicks: 30, // 許可が有効な判断の数
  askCooldown: 12, // 同じ相手・同じ物に続けて許可を求めない判断の数
  askWaitMs: 20000, // 許可の答えを待つ時間
  witnessRadius: 16, // 置く・取るところを見られる距離
  nearDist: 5, // 置いた人・取った人とみなす距離 (others.js と同じ考え)
  maxChoices: 6, // 行動ごとの候補の数
  speech: 'llm', // 説明・許可の発話: 'llm' (talker があれば確定した記録から発話を作る) | 'template'
  knowledge: { max: 200, imp: { self: 0.95, project: 0.85, seen: 0.6, heard: 0.5 } },
  weights: { harm: 0.6, social: 0.5, alt: 0.6, unknown: 0.85, denied: 0.5, greed: 0.2, floor: 0.15 },
  permission: { base: 0.2, empathy: 0.35, obedience: 0.2, affinity: 0.25, greed: 0.3, harm: 0.4, emergency: 0.3, threshold: 0.35 },
  impact: {
    witnessed: { affinity: -6, trust: -0.12, anger: 1.5 },
    heard: { affinity: -3, trust: -0.06, anger: 0.6 },
    told: { affinity: -3, trust: -0.05, anger: 0.4 }, // 取った本人から聞いて初めて知った
    discovered: { sadness: 0.6, anger: 0.6 }, // 無くなっているのに気づいた (誰かは分からない)
    third: { affinity: -1.5, trust: -0.04 }, // ほかの人の物を取るのを見た
    rumor: { affinity: -1, trust: -0.03 }, // 噂で聞いた (× 聞いた回数、3まで)
    apology: { affinity: 2, trust: 0.04 },
    returned: { affinity: 3, trust: 0.06, joy: 0.5 },
    repaired: { affinity: 3, trust: 0.06, joy: 0.5 },
    mitigate: { emergency_need: 0.4, unknown_ownership: 0.5, mistaken_as_natural: 0.5, accidental: 0.3, permission_granted: 0, own_relocation: 0, public_repair: 0.3, selfish_acquisition: 1, unmodeled: 1 },
    denied: 1.3, // 断られたのに取った
    explained: 0.7, // 説明があった
    repeatStep: 0.25, // 同じ相手に取られた回数ごと (4回まで)
  },
  relocate: { minFromBase: 24, nearBase: 8 },
  village: { radius: 32, keep: 60 }, // 村人を見かけた所から radius 以内の、所有者を知らない人工物を村の物 (public) とみなす。覚える所の数 keep
  gossip: { minSociability: 0.4, cooldownTicks: 20 },
};

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function merge(a, b) {
  if (!isObj(a) || !isObj(b)) return b === undefined ? a : b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(a[k]) ? merge(a[k], v) : v;
  return out;
}
function cfgOf(c) {
  const m = merge(DEFAULTS, c || {});
  if (c === false) { m.ledger = false; m.actions = false; m.penalty = false; }
  m.reweight = m.reweight == null ? !!m.penalty : !!m.reweight;
  m.social = m.social == null ? !!m.penalty : !!m.social;
  return m;
}
const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

// ---- ブロックの種類 ----
// 見た目で人の置いた物と分かる種類 (天然にはほぼ無い。村・遺跡の物は「所有者が分からない置かれた物」になる)
const ARTIFACT = /^((soul_)?(wall_)?torch|lantern|soul_lantern|crafting_table|furnace|blast_furnace|smoker|chest|trapped_chest|barrel|ladder|glass|glass_pane|anvil|smithing_table|cartography_table|loom|stonecutter|grindstone|enchanting_table|brewing_stand|bookshelf|farmland|hay_block|campfire|composter|jack_o_lantern|wheat|carrots|potatoes|beetroots)$|_bed$|_planks$|_door$|_trapdoor$|_fence$|_fence_gate$|_slab$|_stairs$|_wool$|_carpet$|_sign$|_wall_sign$|_banner$/;
const LIGHT = { torch: 14, wall_torch: 14, soul_torch: 10, soul_wall_torch: 10, lantern: 15, soul_lantern: 10, glowstone: 15, campfire: 15, jack_o_lantern: 15, sea_lantern: 15, shroomlight: 15 };
const STATION = /^(crafting_table|furnace|smoker|blast_furnace|chest|trapped_chest|barrel|anvil|smithing_table|cartography_table|loom|stonecutter|grindstone|enchanting_table|brewing_stand|composter)$/;
const CONTAINER = /^(chest|trapped_chest|barrel)$/;
const FARM = /^(farmland|wheat|carrots|potatoes|beetroots|melon_stem|pumpkin_stem|hay_block)$/;
const WALLISH = /_planks$|^cobblestone$|_log$|^stone_bricks$|_fence$|_fence_gate$|_door$|_trapdoor$|^glass$|^glass_pane$|_wool$|^dirt$|_slab$|_stairs$|bricks$|^stone$|^cobbled_deepslate$/;
const TAKE_ACTIONS = new Set(['collect', 'take_placed', 'dismantle_own', 'repair_or_relocate_public']);

// その物が満たす欲求 (緊急の判定に使う)。無ければ null (緊急にはならない)
function needOf(block) {
  const b = String(block || '');
  if (LIGHT[b] != null) return 'safety';
  if (/_bed$/.test(b)) return 'sleep';
  if (/^(wheat|carrots|potatoes|beetroots|hay_block|cake|furnace|smoker|campfire)$/.test(b)) return 'hunger';
  if (WALLISH.test(b)) return 'safety'; // 囲い・足場 (夜の身を守る)
  return null;
}

// 取ったときに手に入る物 (掘ると落ちる物)。台帳の照合・返却の物の名前
function itemOf(block) {
  const b = String(block || '');
  if (/^(soul_)?wall_torch$/.test(b)) return b.replace('wall_', '');
  if (/_wall_sign$/.test(b)) return b.replace('_wall_sign', '_sign');
  if (b === 'farmland') return 'dirt';
  if (b === 'wheat') return 'wheat_seeds';
  if (b === 'carrots') return 'carrot';
  if (b === 'potatoes') return 'potato';
  if (b === 'beetroots') return 'beetroot_seeds';
  return b;
}

// 代わりの手段 (同じ物・同じ働きを、人の物を取らずに得る道)。view = { inventory, natural: Set (天然と見ている、掘れる種類), mobs: Set, hasPickaxe }
const has = (inv, re, n = 1) => (inv || []).filter((i) => re.test(i.name)).reduce((s, i) => s + i.count, 0) >= n;
function alternatives(block, view = {}) {
  const b = String(block || '');
  const inv = view.inventory || [];
  const nat = view.natural || new Set();
  const natHas = (re) => [...nat].some((n) => re.test(n));
  const mobs = view.mobs || new Set();
  const out = [];
  const add = (kind, target, available) => out.push({ kind, target, available: !!available });
  if (LIGHT[b] != null) {
    add('have_own', 'torch', has(inv, /^(torch|lantern|soul_torch)$/));
    add('craft', 'torch', has(inv, /^(coal|charcoal)$/) && has(inv, /^stick$|_planks$|_log$/));
    add('collect_natural', 'coal_ore', natHas(/^(deepslate_)?coal_ore$/) && view.hasPickaxe);
  } else if (/_bed$/.test(b)) {
    add('have_own', 'bed', has(inv, /_bed$/));
    add('craft', 'bed', has(inv, /_wool$/, 3) && has(inv, /_planks$|_log$/, 1));
    add('hunt', 'sheep', mobs.has('sheep'));
  } else if (/^(crafting_table|chest|barrel|ladder)$|_planks$|_fence$|_fence_gate$|_door$|_trapdoor$|_sign$|_slab$|_stairs$|_log$/.test(b)) {
    add('have_own', b, has(inv, new RegExp(`^${itemOf(b)}$`)));
    add('craft', b, has(inv, /_log$|_planks$/));
    add('collect_natural', 'log', natHas(/_log$/));
  } else if (/^(furnace|smoker|blast_furnace|cobblestone|stone|stone_bricks|cobbled_deepslate)$/.test(b)) {
    add('have_own', b, has(inv, new RegExp(`^${itemOf(b)}$`)));
    add('craft', b, b === 'cobblestone' || b === 'stone' ? false : has(inv, /^(cobblestone|cobbled_deepslate|blackstone)$/, 8));
    add('collect_natural', 'stone', natHas(/^(stone|cobblestone|deepslate|andesite|diorite|granite)$/) && view.hasPickaxe);
  } else if (FARM.test(b)) {
    add('have_own', 'food', !!view.hasFood);
    add('collect_natural', 'short_grass', natHas(/^(short_grass|grass|tall_grass)$/));
    add('hunt', 'animal', [...mobs].some((m) => /^(cow|pig|sheep|chicken|rabbit)$/.test(m)));
  } else {
    add('have_own', b, has(inv, new RegExp(`^${itemOf(b)}$`)));
    add('collect_natural', b, nat.has(b));
  }
  // 同じ種類の、天然と見ている物 (置かれた物でない所) が見えている
  if (nat.has(b) && !out.some((a) => a.kind === 'collect_natural' && a.target === b)) add('collect_natural', b, true);
  if (view.ownerKnown) add('ask_permission', view.owner || 'owner', !!view.ownerNear && !view.askedRecently);
  return out;
}
const hasAlternative = (alts) => (alts || []).some((a) => a.available && a.kind !== 'ask_permission');

// 機能損害。facts: { night, otherLightNear, placedNeighbors, bedOccupied, otherBedsKnown, altStationDist, containerItems }
function functionalHarm(block, facts = {}) {
  const b = String(block || '');
  const h = { score: 0 };
  const comp = [];
  if (LIGHT[b] != null) {
    h.light = LIGHT[b];
    h.darkens = !facts.otherLightNear; // 近く (7 以内) に別の明かりが無い → そこが暗くなる
    h.night = !!facts.night;
    comp.push(0.35 + (h.darkens ? 0.25 : 0) + (h.night ? 0.2 : 0));
  }
  if (WALLISH.test(b) && (facts.placedNeighbors || 0) >= 2) { h.opensWall = true; comp.push(0.5); }
  if (/_bed$/.test(b)) {
    h.bed = { occupied: !!facts.bedOccupied, night: !!facts.night, otherBeds: facts.otherBedsKnown || 0 };
    comp.push(facts.bedOccupied ? 1 : Math.max(0.1, (facts.night ? 0.6 : 0.3) - (facts.otherBedsKnown ? 0.2 : 0)));
  }
  if (STATION.test(b)) {
    h.station = { altDist: facts.altStationDist ?? null };
    let s = facts.altStationDist == null ? 0.5 : facts.altStationDist > 16 ? 0.35 : 0.15;
    if (CONTAINER.test(b) && facts.containerItems) { h.station.items = facts.containerItems; s += 0.2; }
    comp.push(s);
  }
  if (FARM.test(b)) { h.farm = true; comp.push(0.3); }
  h.score = r2(clamp(comp.length ? Math.max(...comp) : 0));
  return h;
}
function harmText(h) {
  if (!h) return 'none';
  const p = [];
  if (h.light) p.push(`light:${h.light}${h.darkens ? '' : '(other light near)'}`);
  if (h.opensWall) p.push('wall_hole');
  if (h.bed) p.push(`bed:${h.bed.occupied ? 'occupied' : h.bed.night ? 'night' : 'free'}`);
  if (h.station) p.push(`station:${h.station.altDist == null ? 'no_alt' : `alt_${Math.round(h.station.altDist)}m`}`);
  if (h.farm) p.push('farm');
  return p.length ? p.join(',') : 'none';
}
// Jev に見せる損害の事実 (英語。評価語は入れない)
function harmFactsEn(h) {
  if (!h) return [];
  const p = [];
  if (h.light) p.push(h.darkens ? 'it is the only light nearby; the spot goes dark without it' : 'there is other light nearby');
  if (h.opensWall) p.push('it is joined to other placed blocks; taking it leaves a gap');
  if (h.bed) p.push(h.bed.occupied ? 'someone is sleeping in it now' : h.bed.night ? 'it is night' : 'nobody is in it now');
  if (h.station) p.push(h.station.altDist == null ? 'no other one of these is known nearby' : `another one is about ${Math.round(h.station.altDist)} m away`);
  if (h.station && h.station.items) p.push('it has things stored in it');
  if (h.farm) p.push('it is part of a farm');
  return p;
}

// 取る側が見込む社会的な損 (0〜1)
function socialCost({ kind, affinity = null, witnesses = 0, temperament = {}, permission = 'not_requested' } = {}) {
  if (permission === 'granted' || kind === 'own' || kind === 'natural') return 0;
  const kw = { personal: 1, other: 1, group: 0.7, public: 0.5, unknown: 0.4 }[kind] ?? 0.6;
  const t = { empathy: 0.5, obedience: 0.5, ...temperament };
  const rel = affinity == null ? 1 : 0.8 + 0.4 * (affinity / 100);
  let c = kw * (0.3 + 0.35 * t.empathy + 0.35 * t.obedience) * rel * (1 + 0.15 * Math.min(witnesses, 3));
  if (permission === 'denied') c *= 1.3;
  return r2(clamp(c));
}

// ---- 理由 (行動の前に決定的に決める) ----
//   o: { action, category ('natural'|'own'|'other'|'group'|'public'|'unknown'), permission, block, needs (0〜1、効いている値), alternatives, modelOn, emergencyNeed }
//   返り値: { reasonCode, motive, need: {type, value}, emergency, rule (どの規則で決まったか) }
function decideReason(o = {}) {
  const needs = o.needs || {};
  const thr = o.emergencyNeed ?? DEFAULTS.emergencyNeed;
  const needType = needOf(o.block);
  const needVal = needType ? r3(needs[needType] ?? 0) : null;
  const greed = r3(needs.greed ?? 0);
  const noAlt = !hasAlternative(o.alternatives);
  const emergency = !!(needType && needVal >= thr && noAlt);
  const motive = emergency ? needType : o.goalRelated ? 'goal' : 'greed';
  const need = emergency ? { type: needType, value: needVal } : motive === 'greed' ? { type: 'greed', value: greed } : { type: needType || 'greed', value: needType ? needVal : greed };
  const out = (reasonCode, rule) => ({ reasonCode, rule, motive, need, emergency });
  if (o.action === 'repair_or_relocate_public') return out('public_repair', 'action=repair_or_relocate_public');
  if (!TAKE_ACTIONS.has(o.action)) return out('accidental', `dig during ${o.action || 'no action'}`);
  if (o.action === 'collect') return o.modelOn === false ? out('unmodeled', 'ownership model off') : out('mistaken_as_natural', 'collect of a placed block the agent did not recognize');
  if (o.action === 'dismantle_own') return out('own_relocation', 'own placed block');
  if (o.permission === 'granted') return out('permission_granted', 'owner said yes');
  if (o.category === 'unknown') return out('unknown_ownership', 'placed block, owner unknown to the agent');
  if (emergency) return out('emergency_need', `${needType}=${needVal}>=${thr} and no alternative`);
  return out('selfish_acquisition', `known owner, ${needType ? `${needType}=${needVal}<${thr} or alternative exists` : 'no need served'}`);
}

function intendedRestitution(reasonCode, temperament = {}) {
  const e = temperament.empathy ?? 0.5;
  return {
    emergency_need: 'replace_after_need', unknown_ownership: 'repair_if_owner_found', selfish_acquisition: e >= 0.65 ? 'apologize' : 'none',
    public_repair: 'relocate',
  }[reasonCode] || 'none';
}

// 判断の重み (Jev の確率に掛ける。0 にはしない = 取れなくはしない)。返り値 { w, factors }
function choiceWeight(info, cfg = DEFAULTS) {
  const W = { ...DEFAULTS.weights, ...((cfg && cfg.weights) || {}) };
  const f = {};
  if (info.harm && info.harm.score > 0) f.harm = r3(1 - W.harm * info.harm.score);
  if (info.permission !== 'granted' && info.socialCost > 0) f.social = r3(1 - W.social * info.socialCost);
  if (info.permission !== 'granted' && hasAlternative(info.alternatives) && !info.emergency) f.alt = W.alt;
  if (info.category === 'unknown') f.unknown = W.unknown;
  if (info.permission === 'denied') f.denied = W.denied;
  // 性格の欲 (greed、0〜1) が強いほど取る方へ (0.8〜1.2 倍。引き継ぎの「greed pressure」)。許可があるときは掛けない
  if (info.permission !== 'granted' && Number.isFinite(info.greedTrait)) { const g = r3(1 - W.greed + 2 * W.greed * clamp(info.greedTrait)); if (g !== 1) f.greed = g; }
  const prod = Object.values(f).reduce((a, b) => a * b, 1);
  return { w: r3(Math.max(W.floor, prod)), factors: f };
}

// 許可を求められた持ち主の答え (決定的)。o: { temperament, affinity (持ち主 → 頼んだ人), harm, emergency }
function permissionAnswer(o = {}, cfg = DEFAULTS) {
  const P = { ...DEFAULTS.permission, ...((cfg && cfg.permission) || {}) };
  const t = { empathy: 0.5, obedience: 0.5, greed: 0.5, ...(o.temperament || {}) };
  const harm = o.harm ? o.harm.score || 0 : 0;
  if (o.harm && o.harm.bed && o.harm.bed.occupied) return { yes: false, score: 0, why: 'in use' };
  const score = r3(P.base + P.empathy * t.empathy + P.obedience * t.obedience + P.affinity * ((o.affinity ?? 50) / 100) - P.greed * t.greed - P.harm * harm + (o.emergency ? P.emergency : 0));
  return { yes: score >= P.threshold, score, why: score >= P.threshold ? 'ok' : harm >= 0.5 ? 'needed' : 'no' };
}

// 持ち主の側の関係と感情の変化 (決定的)。kind: impact の名前。o: { reasonCode, temperament (持ち主), times (この相手に取られた回数), explained, denied, n (噂の回数) }
function socialImpact(kind, o = {}, cfg = DEFAULTS) {
  const I = merge(DEFAULTS.impact, (cfg && cfg.impact) || {});
  const base = I[kind];
  if (!base) return null;
  const t = { empathy: 0.5, ...(o.temperament || {}) };
  let m = 1;
  const negative = (base.affinity || 0) < 0 || (base.trust || 0) < 0;
  const why = [];
  if (negative) {
    if (o.reasonCode && I.mitigate[o.reasonCode] != null) { m *= I.mitigate[o.reasonCode]; why.push(`reason ${o.reasonCode}×${I.mitigate[o.reasonCode]}`); }
    if (o.explained) { m *= I.explained; why.push(`explained×${I.explained}`); }
    if (o.denied) { m *= I.denied; why.push(`denied×${I.denied}`); }
    const e = 1.15 - 0.3 * t.empathy; m *= e; why.push(`empathy×${r2(e)}`);
    if (o.times > 1) { const r = 1 + I.repeatStep * Math.min(o.times - 1, 4); m *= r; why.push(`repeat×${r2(r)}`); }
    if (kind === 'rumor' && o.n) { const r = Math.min(o.n, 3); m *= r; why.push(`rumors×${r}`); }
  } else if (kind === 'apology' && o.reasonCode === 'emergency_need') { m *= 1.5; why.push('emergency apology×1.5'); }
  const out = { kind, mult: r3(m), why };
  for (const k of ['affinity', 'trust', 'anger', 'sadness', 'joy']) {
    if (!base[k]) continue;
    const v = k === 'trust' ? r3(base[k] * m) : r2(base[k] * m);
    if (v !== 0) out[k] = v; // 0 (許可ありなど) は書かない
  }
  return out;
}

// ---- 部分的な知識 ----
const SOURCE_RANK = { heard: 1, seen: 2, project: 3, self: 4 };
class OwnKnowledge {
  // store: memory.extra.owned (保存される)。me: 自分の名前
  constructor(store = {}, { me, cfg = DEFAULTS } = {}) {
    this.store = store;
    this.me = me;
    this.cfg = cfgOf(cfg);
    this.publicNear = null; // (dim, pos) → 村の中か (村人を見かけた所の近く)。無ければ村の見分けはしない
  }

  learn(dim, pos, info = {}) {
    const k = keyOf(dim, pos);
    const old = this.store[k];
    const src = info.source || 'heard';
    const imp = info.imp ?? this.cfg.knowledge.imp[src] ?? 0.5;
    if (old && old.status === 'present' && sameFamily(old.block, info.block || old.block) && (SOURCE_RANK[old.source] || 0) > (SOURCE_RANK[src] || 0) && !info.force) {
      old.t = Math.max(old.t || 0, info.tick ?? 0); // 弱い知らせは、強い知識を新しくするだけ
      return old;
    }
    const e = {
      dim: normDim(dim), pos: posArr(pos), block: info.block || (old && old.block) || null,
      owner: info.owner === undefined ? (old ? old.owner : null) : info.owner,
      kind: info.kind || (info.owner ? 'personal' : 'unknown'),
      source: src, ...(info.from ? { from: info.from } : {}), t: info.tick ?? 0, imp,
      status: info.status || 'present', ...(info.purpose ? { purpose: info.purpose } : {}), ...(info.projectId ? { projectId: info.projectId } : {}),
    };
    this.store[k] = e;
    this.enforce();
    return e;
  }

  get(dim, pos) { return this.store[keyOf(dim, pos)] || null; }
  mark(dim, pos, status, extra = {}) { const e = this.get(dim, pos); if (e) Object.assign(e, { status }, extra); return e; }
  remove(dim, pos) { delete this.store[keyOf(dim, pos)]; }

  // 今そこに見えているブロック name について、自分がどう見ているか
  //   category: own (自分の物) | other (ほかの人の物) | group | public | unknown (置かれた物だが所有者が分からない) | natural (天然と見ている)
  classify(dim, pos, name) {
    const e = this.get(dim, pos);
    if (e && e.status === 'present' && e.block && sameFamily(e.block, name)) {
      if (e.kind === 'group' || e.kind === 'public') return { category: e.kind, owner: e.owner || null, entry: e };
      if (!e.owner) return { category: 'unknown', owner: null, entry: e };
      return { category: e.owner === this.me ? 'own' : 'other', owner: e.owner, entry: e };
    }
    // 村の物 (2026-11-11 ユーザー決定: 台帳に無い外界の人工物はみんなの物 = public)。見分けは見た事実だけ:
    //   村人を見かけた所 (publicNear。ownership_agent.js が覚える) の近くの、所有者を知らない人工物は村の物とみなす
    if (ARTIFACT.test(String(name))) {
      if (this.publicNear && this.publicNear(dim, pos)) return { category: 'public', owner: null, entry: null, village: true };
      return { category: 'unknown', owner: null, entry: null };
    }
    return { category: 'natural', owner: null, entry: null };
  }

  // 置かれた物と認識しているか (collect から外す)
  recognized(dim, pos, name) { return this.classify(dim, pos, name).category !== 'natural'; }

  list() { return Object.values(this.store); }
  near(dim, pos, r = 16) {
    const [x, y, z] = posArr(pos);
    const d = normDim(dim);
    return this.list().filter((e) => e.dim === d && Math.hypot(e.pos[0] - x, e.pos[1] - y, e.pos[2] - z) <= r);
  }

  // 忘れる: strength(e) (memory.strength と同じ式) が below を下回ったら。自分の物は大事さが高いので長く残る
  forget(strength, below = 0.08) {
    let n = 0;
    for (const [k, e] of Object.entries(this.store)) if (strength(e) < below) { delete this.store[k]; n += 1; }
    return n;
  }

  enforce() {
    const max = this.cfg.knowledge.max || 200;
    const ks = Object.keys(this.store);
    if (ks.length <= max) return;
    const sorted = ks.map((k) => [k, this.store[k]]).sort((a, b) => ((a[1].imp || 0) * 1000 + (a[1].t || 0)) - ((b[1].imp || 0) * 1000 + (b[1].t || 0)));
    for (const [k] of sorted.slice(0, ks.length - max)) delete this.store[k];
  }
}

// ---- 発話の行 (チャットで届く。近くの声 hearRadius の中だけ) ----
//   行の頭の【…】は機械が読む部分 (2B・Jev の発話の中身とは別)。後ろの文は確定した記録から作った発話
const TAG = /^【(許可\?|許可|説明|返却|補修|噂) ([^】]*)】(.*)$/;
const NAME = /^[A-Za-z0-9_]{1,16}$/;
const ID = /^[A-Za-z0-9_-]+$/;
const BLOCK = /^[a-z0-9_]+$/;
const REASONS = new Set(['selfish_acquisition', 'emergency_need', 'own_relocation', 'permission_granted', 'public_repair', 'unknown_ownership', 'mistaken_as_natural', 'accidental', 'unmodeled']);
function pstr(p) { const [x, y, z] = posArr(p); return `${x},${y},${z}`; }
function pparse(s) { const m = String(s || '').match(/^(-?\d+),(-?\d+),(-?\d+)$/); return m ? [+m[1], +m[2], +m[3]] : null; }
function clean(s, n = 80) { return String(s || '').replace(/[【】\n\r]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n); }
const line = {
  ask: ({ id, block, pos, owner, emergency }, text = '') => `【許可? ${id} ${block} ${pstr(pos)} ${owner}${emergency ? ' 急' : ''}】${clean(text)}`,
  answer: ({ id, yes }, text = '') => `【許可 ${id} ${yes ? 'yes' : 'no'}】${clean(text)}`,
  explain: ({ block, pos, owner, reasonCode }, text = '') => `【説明 ${block} ${pstr(pos)} ${owner || '-'} ${reasonCode}】${clean(text)}`,
  returned: ({ item, n, owner }, text = '') => `【返却 ${item} ${n} ${owner}】${clean(text)}`,
  repaired: ({ block, pos, owner }, text = '') => `【補修 ${block} ${pstr(pos)} ${owner || '-'}】${clean(text)}`,
  rumor: ({ taker, block, owner, n }, text = '') => `【噂 ${taker} ${block} ${owner} ${n}】${clean(text)}`,
};
function parseLine(text) {
  const m = String(text || '').match(TAG);
  if (!m) return null;
  const [, tag, head, body] = m;
  const h = head.trim().split(/\s+/);
  const opt = (s) => (s === '-' ? null : s);
  if (tag === '許可?') {
    const [id, block, ps, owner, em] = h;
    const pos = pparse(ps);
    if (!ID.test(id || '') || !BLOCK.test(block || '') || !pos || !NAME.test(owner || '')) return null;
    return { type: 'ask', id, block, pos, owner, emergency: em === '急', text: body.trim() };
  }
  if (tag === '許可') {
    const [id, yn] = h;
    if (!ID.test(id || '') || !/^(yes|no)$/.test(yn || '')) return null;
    return { type: 'answer', id, yes: yn === 'yes', text: body.trim() };
  }
  if (tag === '説明' || tag === '補修') {
    const [block, ps, owner, rc] = h;
    const pos = pparse(ps);
    if (!BLOCK.test(block || '') || !pos || !(owner === '-' || NAME.test(owner || ''))) return null;
    if (tag === '説明' && !REASONS.has(rc)) return null;
    return { type: tag === '説明' ? 'explain' : 'repaired', block, pos, owner: opt(owner), ...(tag === '説明' ? { reasonCode: rc } : {}), text: body.trim() };
  }
  if (tag === '返却') {
    const [item, n, owner] = h;
    if (!BLOCK.test(item || '') || !/^\d+$/.test(n || '') || !NAME.test(owner || '')) return null;
    return { type: 'returned', item, n: +n, owner, text: body.trim() };
  }
  if (tag === '噂') {
    const [taker, block, owner, n] = h;
    if (!NAME.test(taker || '') || !BLOCK.test(block || '') || !NAME.test(owner || '') || !/^\d+$/.test(n || '')) return null;
    return { type: 'rumor', taker, block, owner, n: +n, text: body.trim() };
  }
  return null;
}

// 確定した記録 → 発話の文 (LLM を使わないとき・失敗したときの文)。内容は記録の値だけから作る
function templateText(kind, r = {}) {
  const o = r.owner ? `${r.owner}さん、` : '';
  const b = r.block || r.item || '物';
  if (kind === 'ask') return `${o}そこの${b}を使わせてもらってもいい?${r.emergency ? ' 今どうしても要るんだ' : ''}`;
  if (kind === 'answer') return r.yes ? 'いいよ、使って' : 'ごめん、それは今使っているんだ';
  if (kind === 'explain') {
    if (r.reasonCode === 'emergency_need') return `${o}${b}を借りた。どうしても必要だったんだ、ごめん`;
    if (r.reasonCode === 'unknown_ownership' || r.reasonCode === 'mistaken_as_natural') return `${o}${b}を、誰の物か知らずに取ってしまった。ごめん`;
    if (r.reasonCode === 'permission_granted') return `${o}${b}、ありがとう`;
    return `${o}${b}をもらった。ごめん`;
  }
  if (kind === 'returned') return `${o}${b}を返すね`;
  if (kind === 'repaired') return `${o}${b}を元の所に戻しておいた`;
  if (kind === 'rumor') return `${o}${r.taker}が${r.owner}さんの${b}を取っていたよ`;
  return '';
}

// console の1行。例: Yua take_placed(torch owned by Miho) reason=selfish_acquisition need=greed:0.93 alternatives=2 harm=light:14 permission=no
function consoleLine(name, it) {
  const t = it.target || {};
  const own = t.ownerKind === 'unknown' || !t.owner ? `${t.block} owner unknown` : t.ownerKind === 'group' || t.ownerKind === 'public' ? `${t.block} ${t.ownerKind}${t.owner ? ` by ${t.owner}` : ''}` : `${t.block} owned by ${t.owner}`;
  const alts = (it.alternatives || []).filter((a) => a.available).length;
  const perm = { granted: 'yes', denied: 'denied', no_answer: 'no_answer', not_requested: 'no', not_applicable: '-' }[it.permission] || it.permission;
  return `${name} ${it.action}(${own}) reason=${it.reasonCode} need=${it.need ? `${it.need.type}:${it.need.value}` : '-'} alternatives=${alts} harm=${harmText(it.functionalHarm)} permission=${perm}${it.perspective === 'ground_truth' ? ' (ground truth: agent saw it as natural)' : ''}`;
}

module.exports = {
  DEFAULTS, cfgOf, ARTIFACT, LIGHT, STATION, CONTAINER, FARM, WALLISH, TAKE_ACTIONS, needOf, itemOf, alternatives, hasAlternative,
  functionalHarm, harmText, harmFactsEn, socialCost, decideReason, intendedRestitution, choiceWeight, permissionAnswer, socialImpact,
  OwnKnowledge, SOURCE_RANK, line, parseLine, templateText, consoleLine, REASONS, pstr,
};
