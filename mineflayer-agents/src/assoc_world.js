'use strict';
// 連想の記憶 (assoc.js) が使う「意味の線」: 全員に共通で、忘れない。保存もしない (毎回 minecraft-data と表から作る)。
//   - 物の点 item:<名前> と、種類違いをまとめた分類の点 item:*_log など (vocab.familyKey。日本語名は「原木」)
//   - 作り方の線: 作る物 → 材料 (planner.index のレシピ・焼いて作る・ブロックから落ちる)。向きは「作る物 → 材料」だけ
//     (逆向きは板材 → 階段・ドア… と扇が大きすぎるので張らない)
//   - 欲求の線: need:<欲求> → それを満たす物・分類 (needs.js の安心の要素と anticipate.js の備え、寝床、食べ物の表から)
//   - 概念の点: cat:home (拠点)・cat:enclosure (囲い)・cat:village (村)
//   - 言葉 → 点: 話・質問の中の日本語 (名前・「寝る」「怖い」など) を点に直す (lexicon)
// ここは「自分で見聞きしたこと」ではなく、全員が知っている一般の知識 (仕様の事実と同じ扱い)。部分観測には触れない。
const { index } = require('./planner');
const { familyKey } = require('./vocab');
const { jaName, SUFFIX, DIRECT } = require('./names_ja');

const NEED_JA = { hunger: '空腹', sleep: '眠気', safety: '不安', connection: '寂しさ', recognition: '認められたい', curiosity: '好奇心', greed: '物欲', care: '人の役に立ちたい' };
const NEED_REASON_JA = { hunger: 'お腹が空いて', sleep: '眠くて', safety: '不安で', connection: '寂しくて', recognition: '認められたくて', curiosity: '知らない所が気になって', greed: '物が欲しくて', care: '人の役に立ちたくて' };
const NEED_REASON_EN = { hunger: 'you are hungry', sleep: 'you are sleepy', safety: 'you feel unsafe', connection: 'you feel lonely', recognition: 'you want recognition', curiosity: 'you are curious', greed: 'you want things', care: 'you want to help' };
const CAT_JA = { 'cat:home': '拠点', 'cat:enclosure': '囲い', 'cat:village': '村' };
const CAT_EN = { 'cat:home': 'your base', 'cat:enclosure': 'an enclosure', 'cat:village': 'a village' };
const PHASE_EN = { 朝: 'morning', 昼: 'daytime', 夕方: 'evening', 夜: 'night', 明け方: 'dawn' };

// 欲求 → 満たす物 (needs.js: 安心 = 家 home・囲まれている enclosed・仲の良い人 trusted・明るい bright、
//   anticipate.js の備え = 武器・防具・盾・松明・囲まれた寝床・ベッド。眠気 = ベッド (bedTo)。空腹 = 食べ物 (foods) と、肉の取れる生き物・畑)
//   仲の良い人への線 (安心・つながり) は、関係の値を social から参照して毎回張る (assoc.js の relationEdges)
const NEED_LINKS = {
  safety: ['item:torch', 'item:lantern', 'item:*_bed', 'cat:home', 'cat:enclosure', 'item:*_sword', 'item:shield', 'item:*_helmet', 'item:*_chestplate', 'item:*_door'],
  sleep: ['item:*_bed', 'cat:home'],
  hunger: ['item:cow', 'item:pig', 'item:chicken', 'item:sheep', 'item:farmland', 'item:wheat', 'item:*_bed:no'], // 食べ物は下で足す
  connection: [],
  curiosity: [],
};
NEED_LINKS.hunger = NEED_LINKS.hunger.filter((x) => !x.endsWith(':no'));
// 分類の点 (cat:) に入る物の分類
const CAT_MEMBERS = {
  'cat:enclosure': ['item:*_fence', 'item:*_fence_gate', 'item:*_wall', 'item:cobblestone_wall'],
  'cat:village': ['item:villager', 'item:bell', 'item:wandering_trader'],
  'cat:home': [],
};
// 行動 → 概念 (その行動の出来事を概念の点にもつなぐ)
const ACTION_CAT = { enclose: 'cat:enclosure', set_base: 'cat:home', sleep: 'item:*_bed', trade: 'cat:village', eat: 'need:hunger' };
// 場所の種類 (memory.places の kind) → 点
const PLACE_KIND_NODE = { 拠点: 'cat:home' };

// 話・質問の言葉 → 点 (長い語から当てる)。物の日本語名は names_ja から作る
const EXTRA_WORDS = [
  ['寝床', ['need:sleep', 'item:*_bed']], ['寝る', ['need:sleep']], ['寝れ', ['need:sleep']], ['寝ら', ['need:sleep']], ['寝', ['need:sleep']], ['眠', ['need:sleep']], ['ベッド', ['item:*_bed']],
  ['食べ物', ['need:hunger']], ['食べ', ['need:hunger']], ['食料', ['need:hunger']], ['ご飯', ['need:hunger']], ['腹', ['need:hunger']], ['肉', ['need:hunger']],
  ['怖', ['need:safety']], ['不安', ['need:safety']], ['危な', ['need:safety']], ['危険', ['need:safety']], ['安全', ['need:safety']], ['夜', ['time:夜']], ['ゾンビ', ['item:zombie']], ['クモ', ['item:spider']], ['スケルトン', ['item:skeleton']],
  ['明かり', ['item:torch']], ['灯り', ['item:torch']], ['松明', ['item:torch']], ['たいまつ', ['item:torch']],
  ['囲い', ['cat:enclosure']], ['囲', ['cat:enclosure']], ['柵', ['item:*_fence', 'cat:enclosure']], ['塀', ['item:*_wall', 'cat:enclosure']],
  ['村人', ['item:villager', 'cat:village']], ['村', ['cat:village']],
  ['拠点', ['cat:home']], ['家', ['cat:home']], ['小屋', ['cat:home']], ['うち', ['cat:home']],
  ['寂し', ['need:connection']], ['一人', ['need:connection']], ['ひとり', ['need:connection']],
  ['木', ['item:*_log']], ['原木', ['item:*_log']], ['板', ['item:*_planks']], ['石炭', ['item:coal', 'item:coal_ore']], ['鉄', ['item:iron_ingot', 'item:iron_ore']], ['水', ['item:water']],
  ['牛', ['item:cow']], ['豚', ['item:pig']], ['羊', ['item:sheep']], ['鶏', ['item:chicken']], ['ニワトリ', ['item:chicken']], ['畑', ['item:farmland']], ['耕地', ['item:farmland']], ['小麦', ['item:wheat']],
];

let LEX = null;
function lexicon() {
  if (LEX) return LEX;
  const m = new Map();
  const add = (w, ids) => { if (!w || w.length < 1) return; m.set(w, [...new Set([...(m.get(w) || []), ...ids])]); };
  for (const [suf, ja] of SUFFIX) add(ja, [`item:*${suf}`]);
  for (const [name, ja] of Object.entries(DIRECT)) add(ja, [`item:${familyKey(name)}`]);
  for (const [w, ids] of EXTRA_WORDS) add(w, ids);
  LEX = [...m].sort((a, b) => b[0].length - a[0].length);
  return LEX;
}

// 文の中の言葉 → [{ node, word }]。英語の名前 (oak_log) は物の点 (と分類の点)。日本語は長い語から当てて、当たった所は消す
function nodesInText(text, { version, people = [] } = {}) {
  const s = String(text || '');
  const out = [];
  const seen = new Set();
  const push = (node, word) => { if (!seen.has(node)) { seen.add(node); out.push({ node, word }); } };
  for (const p of people) if (p && s.includes(p)) push(`person:${p}`, p);
  let md = null;
  try { md = index(version).md; } catch (_) { md = null; }
  for (const w of s.match(/[a-z][a-z0-9_]{2,}/g) || []) {
    if (md && !(md.blocksByName[w] || md.itemsByName[w] || (md.entitiesByName && md.entitiesByName[w]))) continue;
    push(`item:${w}`, w);
  }
  let rest = s;
  for (const p of people) if (p) rest = rest.split(p).join(' '.repeat(p.length));
  for (const [w, ids] of lexicon()) {
    if (!rest.includes(w)) continue;
    for (const id of ids) push(id, w);
    rest = rest.split(w).join(' '.repeat(w.length));
  }
  return out;
}

// 物の名前 → 点の id (種類違いは分類の点も)。返り値 [id]
function itemNodes(name) {
  if (!name) return [];
  const n = String(name).replace(/^minecraft:/, '');
  const fam = familyKey(n);
  return fam !== n ? [`item:${n}`, `item:${fam}`] : [`item:${n}`];
}

// 意味の線 (向きつき)。from → [{ to, w, rel }]。作り方は1段だけ (多段は広げる段数で届く)
const edgeCache = new Map();
function semanticEdges(id, version) {
  const key = `${version || ''}|${id}`;
  if (edgeCache.has(key)) return edgeCache.get(key);
  const out = [];
  const add = (to, w, rel) => { if (to && to !== id && !out.some((e) => e.to === to)) out.push({ to, w, rel }); };
  if (id.startsWith('need:')) {
    const k = id.slice(5);
    for (const t of NEED_LINKS[k] || []) add(t, 0.8, 'satisfies');
    if (k === 'hunger') {
      let md = null;
      try { md = index(version).md; } catch (_) { md = null; }
      for (const f of Object.keys((md && md.foodsByName) || {})) if (!/rotten|poison|spider_eye|pufferfish|chorus|suspicious|golden/.test(f)) add(`item:${familyKey(f)}`, 0.6, 'satisfies');
    }
  } else if (id.startsWith('cat:')) {
    for (const t of CAT_MEMBERS[id] || []) add(t, 0.8, 'member');
  } else if (id.startsWith('item:')) {
    const n = id.slice(5);
    if (n.startsWith('*_')) {
      // 分類の点 → 作り方 (分類の代表の物のレシピで)。例 *_planks → *_log
      const rep = representative(n, version);
      if (rep) for (const e of semanticEdges(`item:${rep}`, version)) if (e.rel !== 'isa') add(e.to, e.w, e.rel);
      for (const [cat, members] of Object.entries(CAT_MEMBERS)) if (members.includes(id)) add(cat, 0.6, 'isa');
    } else {
      const fam = familyKey(n);
      if (fam !== n) add(`item:${fam}`, 0.9, 'isa');
      for (const [cat, members] of Object.entries(CAT_MEMBERS)) if (members.includes(id)) add(cat, 0.6, 'isa');
      let ix = null;
      try { ix = index(version); } catch (_) { ix = null; }
      if (ix) {
        const rs = ix.recipes.get(n) || [];
        // 材料は分類の点へ。ただし同じ木の種類・色の材料 (acacia_planks ← acacia_log) は、その物の点にも強めに
        const pre = fam !== n ? n.slice(0, n.length - fam.length + 1) : null;
        for (const r of rs.filter((x) => (x.count || 1) < 9).slice(0, 3)) {
          for (const ing of Object.keys(r.ings)) {
            if (pre && ing.startsWith(`${pre}_`) && familyKey(ing) !== ing) add(`item:${ing}`, 0.8, 'made_from');
            add(`item:${familyKey(ing)}`, 0.7, 'made_from');
          }
        }
        for (const s of (ix.smelt.get(n) || []).slice(0, 3)) add(`item:${familyKey(s)}`, 0.6, 'made_from');
        for (const b of (ix.blocks.get(n) || []).filter((x) => x.block !== n && x.expect >= 0.5).slice(0, 3)) add(`item:${familyKey(b.block)}`, 0.6, 'dropped_by');
      }
    }
  }
  edgeCache.set(key, out);
  return out;
}

const repCache = new Map();
function representative(fam, version) {
  const key = `${version || ''}|${fam}`;
  if (repCache.has(key)) return repCache.get(key);
  let rep = null;
  try {
    const md = index(version).md;
    const suf = fam.slice(1); // "_planks"
    rep = md.itemsByName[`oak${suf}`] ? `oak${suf}` : (md.itemsArray.find((it) => it.name.endsWith(suf)) || {}).name || null;
  } catch (_) { rep = null; }
  repCache.set(key, rep);
  return rep;
}

// 点の日本語・英語の呼び方 (なぜ思い出したかの文に使う)
function nodeLabel(id, lang = 'ja') {
  const [k, ...rest] = String(id).split(':');
  const v = rest.join(':');
  if (k === 'person') return v;
  if (k === 'item') {
    if (lang === 'en') return v.startsWith('*_') ? v.slice(2).replace(/_/g, ' ') : v;
    if (v.startsWith('*_')) { const s = SUFFIX.find(([suf]) => `*${suf}` === v); return s ? s[1] : v; }
    return jaName(v) || v;
  }
  if (k === 'need') return lang === 'en' ? v : (NEED_JA[v] || v);
  if (k === 'cat') return lang === 'en' ? (CAT_EN[id] || v) : (CAT_JA[id] || v);
  if (k === 'time') return lang === 'en' ? (PHASE_EN[v] || v) : v;
  if (k === 'area') return lang === 'en' ? 'that area' : 'その辺り';
  if (k === 'lm') { const kind = v.split('@')[0]; return kind === '拠点' ? (lang === 'en' ? 'your base' : '拠点') : nodeLabel(`item:${kind}`, lang); }
  return v;
}

module.exports = { semanticEdges, nodesInText, itemNodes, nodeLabel, lexicon, NEED_LINKS, CAT_MEMBERS, ACTION_CAT, PLACE_KIND_NODE, NEED_JA, NEED_REASON_JA, NEED_REASON_EN, CAT_JA };
