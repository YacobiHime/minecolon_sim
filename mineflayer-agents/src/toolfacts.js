'use strict';
// 道具の仕様の事実 (1.20.1) と、名前・言葉の読み取り。bot に依存しない部品。
//   division.js (他人のための道具・物単位の刺激)・toolwant.js (使う側の不満と声)・anticipate.js (先の道具切れ) が使う。
//   数値は仕様の事実だけ (掘る速さの倍率・耐久値)。「どの道具を作るとよい」は書かない (研究方針)。
const { jaName } = require('./names_ja');

// 掘る速さの倍率 (正しい種類の道具のとき): 素手 1・木 2・石 4・鉄 6・ダイヤ 8・ネザライト 9・金 12。耐久値: 木 59・石 131・鉄 250・金 32・ダイヤ 1561・ネザライト 2031。
//   原木 (硬さ 2) は素手でも取れるが、斧の速さで掘る時間が変わる (素手 3秒・木の斧 1.5秒・石の斧 0.75秒)。
//   石・丸石・鉱石はツルハシが無いと何も落ちない (素手では取れない)。耕す (クワを土に使う) はクワの種類で速さは変わらない (耐久値だけ違う)
const TOOL_FACTS = {
  speed: { hand: 1, wooden: 2, stone: 4, iron: 6, diamond: 8, netherite: 9, golden: 12 },
  durability: { wooden: 59, stone: 131, iron: 250, golden: 32, diamond: 1561, netherite: 2031 },
};
const TOOL_MATS = ['wooden', 'stone', 'iron', 'golden', 'diamond', 'netherite'];
const TOOL_TYPES = ['pickaxe', 'axe', 'shovel', 'hoe', 'sword'];
// 欲しがる段の並び (金・ダイヤ・ネザライトは入れない: 序盤の生活で手の届く段だけ)
const LADDER = ['hand', 'wooden', 'stone', 'iron'];
const TYPE_JA = { pickaxe: 'ツルハシ', axe: '斧', shovel: 'シャベル', hoe: 'クワ', sword: '剣' };
const TYPE_EN = { pickaxe: 'pickaxe', axe: 'axe', shovel: 'shovel', hoe: 'hoe', sword: 'sword' };
const MAT_JA = { hand: '素手', wooden: '木', stone: '石', iron: '鉄', golden: '金', diamond: 'ダイヤ', netherite: 'ネザライト' };

// 仕事 → 道具の種類とブロック。needsTool: 道具が無いと何も落ちない
const TASKS = {
  wood: { tool: 'axe', blocks: /^([a-z_]+_log|[a-z_]+_wood|[a-z_]+_stem|[a-z_]+_planks)$/, needsTool: false },
  mining: { tool: 'pickaxe', blocks: /^(stone|cobblestone|deepslate|cobbled_deepslate|andesite|diorite|granite|tuff|sandstone|[a-z_]*_ore|furnace)$/, needsTool: true },
  digging: { tool: 'shovel', blocks: /^(dirt|grass_block|coarse_dirt|rooted_dirt|sand|red_sand|gravel|clay|mud|snow_block|snow|farmland|dirt_path|podzol|mycelium)$/, needsTool: false },
  farming: { tool: 'hoe', till: true },
};
const TASK_OF_TYPE = Object.fromEntries(Object.entries(TASKS).map(([k, t]) => [t.tool, k]));

// 'stone_axe' → { mat: 'stone', type: 'axe' } | null
function toolInfo(name) {
  const m = String(name || '').replace(/^minecraft:/, '').match(/^([a-z]+)_(pickaxe|axe|shovel|hoe|sword)$/);
  return m && TOOL_MATS.includes(m[1]) ? { mat: m[1], type: m[2] } : null;
}
const isTool = (name) => !!toolInfo(name);
const tierOf = (mat) => LADDER.indexOf(mat); // 段 (素手 0・木 1・石 2・鉄 3。金・ダイヤは -1)
// 段の比較 (金は木と同じ段、ダイヤ・ネザライトは鉄より上として扱う)
function rank(mat) { return mat === 'golden' ? 1 : mat === 'diamond' ? 4 : mat === 'netherite' ? 5 : Math.max(0, LADDER.indexOf(mat)); }

// ブロック → 仕事 | null
function taskOfBlock(block) {
  const b = String(block || '').replace(/^minecraft:/, '');
  for (const [k, t] of Object.entries(TASKS)) if (t.blocks && t.blocks.test(b)) return k;
  return null;
}

// 手の物 → その仕事の道具の素材 (正しい種類の道具でなければ素手と同じ)
function toolMat(held, task) {
  const t = TASKS[task]; if (!t) return null;
  const i = toolInfo(held);
  return i && i.type === t.tool ? i.mat : 'hand';
}

// 素材 mat の人に target の素材の道具があったら、掘る速さがどれだけ上がるか (0〜1。1 − 今の速さ ÷ target の速さ)
function speedGain(mat, target) { const S = TOOL_FACTS.speed; return Math.max(0, 1 - (S[mat] || 1) / (S[target] || 1)); }
// 耐久の伸び (0〜1。素手は壊れないので 0)
function durGain(mat, target) { const D = TOOL_FACTS.durability; return mat === 'hand' || !D[mat] || !D[target] ? 0 : Math.max(0, 1 - D[mat] / D[target]); }

// その素材で仕事をしている人に、target の素材の道具があったら効率がどれだけ上がるか (0〜1。仕様の事実から)
//   掘る: 1 − 今の速さ ÷ target の速さ (素手で取れないブロックは 1)。耕す: 速さは同じなので、耐久値の差 × durW
function toolGain(task, mat, { target = 'stone', durW = 0.3 } = {}) {
  const t = TASKS[task]; if (!t || !mat) return 0;
  if (t.till) return mat === 'hand' || !TOOL_FACTS.durability[mat] ? 0 : durW * durGain(mat, target);
  if (t.needsTool && mat === 'hand') return 1;
  return speedGain(mat, target);
}

// 日本語の物の名前 (石の斧)。道具以外は names_ja の名前
function itemJa(name) { return jaName(name) || name; }

// 仕様の言葉 (事実だけ): 「stone_axe (石の斧): 掘る速さ 素手の4倍・耐久 131 回」
function specText(item, lang = 'ja') {
  const i = toolInfo(item); if (!i) return '';
  const S = TOOL_FACTS.speed[i.mat]; const D = TOOL_FACTS.durability[i.mat];
  const task = TASK_OF_TYPE[i.type];
  if (lang === 'en') return `${item}: ${task === 'farming' || i.type === 'sword' ? '' : `digs ${S}x as fast as bare hands, `}lasts ${D} uses`;
  return `${item} (${itemJa(item)}): ${task === 'farming' || i.type === 'sword' ? '' : `掘る速さ 素手の${S}倍・`}耐久 ${D} 回`;
}

// prismarine-item の持ち物 → 道具の耐久 [{ name, used, max, left, frac }] (耐久の分からない物は仕様の値)
function toolsOfItems(items = []) {
  const out = [];
  for (const it of items || []) {
    if (!it || !isTool(it.name)) continue;
    const max = Number.isFinite(it.maxDurability) && it.maxDurability > 0 ? it.maxDurability : TOOL_FACTS.durability[toolInfo(it.name).mat];
    let used = 0;
    try { used = Number(it.durabilityUsed) || 0; } catch (_) { used = 0; }
    const left = Math.max(0, max - used);
    out.push({ name: it.name, used, max, left, frac: Math.round((left / max) * 1000) / 1000, slot: it.slot ?? null });
  }
  return out;
}

// ---- 発言の中の道具の言葉 ----
const SAID_MAT = [['wooden', /木の|木製|wooden_/], ['stone', /石の|stone_/], ['iron', /鉄の|iron_/], ['golden', /金の|golden_/], ['diamond', /ダイヤの|diamond_/]];
const SAID_TYPE = [['pickaxe', /ツルハシ|つるはし|ピッケル|pickaxe/], ['axe', /斧|おの|オノ|(?<!pick)axe/], ['shovel', /シャベル|スコップ|shovel/], ['hoe', /クワ|くわ|鍬|hoe/], ['sword', /剣|sword/]];
// 欲しい・困っている形 (頼みごと・独り言の両方)
const WANT_RE = /欲しい|ほしい|あれば|あったら|あったらなあ|くれ|ちょうだい|ください|貸して|譲って|無いか|ないか|足りな|必要|頼む|お願い|作って|壊れ|折れ|遅い|遅く|時間がかか|持ってない|持ってる[?？]|誰か|取れな|掘れな|もっといい|いい(斧|ツルハシ|クワ|シャベル|剣|道具)|need|want|anyone|broke|broken/i;
const BROKE_RE = /壊れ|折れ|broke|broken/i;

// 文 → 道具の言葉 [{ item | null, type, mat | null }] (重ならないよう、英語の名前を先に)
function parseToolWords(text) {
  const t = String(text || '');
  const out = [];
  const seen = new Set();
  for (const m of t.matchAll(/\b(wooden|stone|iron|golden|diamond|netherite)_(pickaxe|axe|shovel|hoe|sword)\b/g)) {
    const k = `${m[1]}_${m[2]}`; if (seen.has(k)) continue; seen.add(k); out.push({ item: k, type: m[2], mat: m[1] });
  }
  // 日本語: 「石のツルハシ」「鉄のクワ」「ツルハシ」
  const ja = t.replace(/\b[a-z_]+_(pickaxe|axe|shovel|hoe|sword)\b/g, '');
  for (const [type, re] of SAID_TYPE) {
    const r = new RegExp(re.source, 'g');
    for (const m of ja.matchAll(r)) {
      const before = ja.slice(Math.max(0, m.index - 4), m.index);
      const mat = (SAID_MAT.find(([, mre]) => mre.test(before)) || [])[0] || null;
      const item = mat ? `${mat}_${type}` : null;
      const k = item || `?_${type}`;
      if (seen.has(k) || (!item && out.some((x) => x.type === type))) continue;
      seen.add(k); out.push({ item, type, mat });
    }
  }
  return out;
}

const isWantText = (text) => WANT_RE.test(String(text || ''));
const isBrokeText = (text) => BROKE_RE.test(String(text || ''));

module.exports = { TOOL_FACTS, TOOL_MATS, TOOL_TYPES, LADDER, TYPE_JA, TYPE_EN, MAT_JA, TASKS, TASK_OF_TYPE, toolInfo, isTool, tierOf, rank, taskOfBlock, toolMat, speedGain, durGain, toolGain, itemJa, specText, toolsOfItems, parseToolWords, isWantText, isBrokeText, WANT_RE };
