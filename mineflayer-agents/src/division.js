'use strict';
// 分業をメンタルモデルの側で生ませる (2026-11-06 ユーザー決定: 「必要なものに対して欲求を上げる」)。bot に依存しない部品 (つなぎは agent.js・goalpath.js・reflect.js)。
//   1. 慣れ (経験): 活動の種類ごとに、やった回数・うまくいった回数を数える (ゴールの結果と行動の結果)。
//      慣れ fam = exp / (exp + halfExp)、exp = うまくいったゴール + actWeight × うまくいった行動。
//      言葉 (「畑のことは慣れている」「石掘りはまだ不慣れ」) を体と心の言葉に足す (英語も)。
//      慣れている活動は、ゴール選びで感じる手間を小さくする: 手間' = 手間 × (1 − skillCut × fam) (心の中の手間。ゲームの速さは変えない)
//   2. 集団の必要 (刺激 s): 本人が見聞きした範囲だけから作る。
//      共有のチェストの中身 (全体チャットの【箱】で届いた物)・聞いた依頼の形の発言 (近くの声・全体チャット)・
//      自分の拠点の様子 (暗い・囲まれていない)・取り決め / 共同の目標の残り。
//      ほかの人がその活動をしているのを見た/聞いた (others.js の拾った・壊した、発言) ほど下がる: s = 生の刺激 ÷ (1 + coverW × 見た人数)
//   3. 反応しきい値 θ (腰の上げやすさ): 性格 (TRAIT_ACT の表) と慣れから。
//      θ = theta0 × (1 − traitScale × z) × (1 − famCut × fam)、z = Σ w_k (2 × 性格_k − 1) / Σ w_k (−1〜1)。
//      反応の強さ T = s² / (s² + θ²) (Bonabeau, Theraulaz & Deneubourg 1996 の反応しきい値モデル)
//   4. ゴールの点 (goalpath.js selectScores): 点 = (Σ つらさ × P × (1 + beta × T) + gamma × T) ÷ (1 + alpha × 手間')。
//      gamma の項があるので、刺激の大きい活動のゴールは、いまのつらさが小さくても点が付く。
//      案を作る 2B には「みんなに足りていない物 (見聞きした範囲)」として刺激の材料の言葉を渡す (stimulusText)。
//   5. 役回りの認識: 振り返り (reflect.js) に自分の活動の回数を事実として渡し、自分がよくしていることを書かせる。
//      ほかの人については、見聞きしたこと (拾った・壊した・発言) から「Kaori は最近、畑のことをよくしている」を覚え、人の言葉に出す。
//   6. 他人のための必要 (道具。2026-11-07 ユーザー決定): ほかの人が何の活動を何の道具でしていたか (others.js の壊した・耕したとその時の手の物、発言) を覚え、
//      道具の段階 (素手 < 木 < 石 < 鉄) と仕様 (掘る速さ・耐久値の事実、TOOL_FACTS) から「石の道具ならどれだけ効率が上がるか」(gain 0〜1) を見積もり、
//      その人たちの分の和を 石掘り (丸石が要る) と 物を作ること (道具を作る) の刺激に足す: 生の刺激 += toolW × min(toolCap, Σ_人 薄れ × gain)。
//      言葉は事実だけ (「Ken・Mai が素手や木の道具で木を切り、畑を耕しているのを見た」)。「石の道具を作ると良い」とは書かない。
// 研究方針: 仕様・事実は見せるが、使い方は書かない。役割の名前は与えない (活動の種類の言葉だけ)。評価語を入れない。
//   数値はここで持ち、モデルには言葉だけ (Jev は英語、2B は日本語)。全員の状態は見せない (見聞きした範囲だけ)。

const TF = require('./toolfacts');

const ACTIVITIES = ['farming', 'wood', 'mining', 'hunting', 'exploring', 'building', 'cooking', 'crafting', 'social'];
// 活動の言葉 (役割の名前ではなく、することの言葉)
const ACT_JA = { farming: '畑のこと', wood: '木を切ること', mining: '石掘り', hunting: '狩り', exploring: '知らない所を見て回ること', building: '建てること', cooking: '料理', crafting: '物を作ること', social: '人と関わること' };
const ACT_EN = { farming: 'farming', wood: 'cutting wood', mining: 'mining stone', hunting: 'hunting', exploring: 'exploring', building: 'building', cooking: 'cooking', crafting: 'crafting', social: 'dealing with people' };
// 刺激の行の頭 (足りていない物の種類)
const STUFF_JA = { farming: '畑の作物', wood: '木材', mining: '石や鉱石', hunting: '肉や羊毛', exploring: 'まだ知らない場所', building: '明かりや壁', cooking: '料理した食べ物', crafting: '道具や作った物', social: '人の手' };
const STUFF_EN = { farming: 'crops', wood: 'wood', mining: 'stone and ore', hunting: 'meat and wool', exploring: 'unknown places', building: 'lights and walls', cooking: 'cooked food', crafting: 'tools and crafted things', social: 'help from people' };
// 食べ物 (共有のチェストの食べ物は 畑・狩り・料理 のどれにも数える)
const FOOD_ACTS = ['farming', 'hunting', 'cooking'];
const FOOD = /^(bread|apple|golden_apple|carrot|potato|baked_potato|beetroot|melon_slice|sweet_berries|glow_berries|pumpkin_pie|cookie|cake|mushroom_stew|beetroot_soup|rabbit_stew|dried_kelp|beef|porkchop|mutton|chicken|rabbit|cod|salmon|tropical_fish|cooked_[a-z_]+)$/;

// ---- 分類表 (物・ブロック・生き物の名前 → 活動)。上から順に見る ----
const ITEM_ACT = [
  ['cooking', /^(cooked_[a-z_]+|bread|baked_potato|[a-z_]+_stew|cake|cookie|pumpkin_pie|beetroot_soup|dried_kelp|smoker|campfire)$/],
  ['farming', /^(wheat|wheat_seeds|carrot|carrots|potato|potatoes|beetroot|beetroots|beetroot_seeds|pumpkin|pumpkin_seeds|melon|melon_slice|melon_seeds|sugar_cane|bone_meal|cocoa_beans|sweet_berries|sweet_berry_bush|hay_block|composter|farmland|water_bucket|[a-z_]+_hoe|grass|tall_grass|short_grass)$/],
  ['building', /^([a-z_]+_door|[a-z_]+_fence|[a-z_]+_fence_gate|[a-z_]+_slab|[a-z_]+_stairs|[a-z_]+_wall|glass|glass_pane|torch|wall_torch|lantern|ladder|[a-z_]+_trapdoor|bricks|stone_bricks|[a-z_]+_carpet)$/],
  ['crafting', /^([a-z_]+_pickaxe|[a-z_]+_axe|[a-z_]+_shovel|[a-z_]+_sword|crafting_table|furnace|chest|barrel|[a-z_]+_bed|bowl|bucket|shears|fishing_rod|bow|arrow|shield|[a-z_]+_helmet|[a-z_]+_chestplate|[a-z_]+_leggings|[a-z_]+_boots|paper|book|[a-z_]+_boat|charcoal)$/],
  ['wood', /^([a-z_]+_log|[a-z_]+_wood|[a-z_]+_planks|[a-z_]+_sapling|stick|apple|[a-z_]+_leaves)$/],
  ['mining', /^(cobblestone|stone|cobbled_deepslate|deepslate|coal|coal_ore|raw_iron|raw_copper|raw_gold|iron_ingot|copper_ingot|gold_ingot|diamond|redstone|lapis_lazuli|emerald|flint|gravel|[a-z_]+_ore|andesite|diorite|granite|clay_ball|clay|sand)$/],
  ['hunting', /^(beef|porkchop|mutton|chicken|rabbit|cod|salmon|tropical_fish|leather|[a-z_]+_wool|feather|egg|string|bone|rotten_flesh|spider_eye|gunpowder|rabbit_hide|ink_sac|cow|pig|sheep|rabbit|zombie|skeleton|spider|creeper)$/],
];
function itemActivity(name) {
  const n = String(name || '').replace(/^minecraft:/, '');
  if (!n) return null;
  for (const [a, re] of ITEM_ACT) if (re.test(n)) return a;
  return null;
}

// ゴール { kind, target, place? } → 活動 | null
function goalActivity(g) {
  if (!g) return null;
  const t = String(g.target || '');
  if (g.kind === 'person') return 'social';
  if (g.kind === 'item') return itemActivity(t);
  if (g.kind === 'state') {
    if (/^(farmland|planted_[a-z_]+)$/.test(t)) return 'farming';
    if (/^(lit_base|walled_base)$/.test(t)) return 'building';
    if (/^pen_[a-z_]+$/.test(t)) return 'farming'; // 囲いで動物を飼う
    const m = t.match(/^(?:chest_|shared_[A-Za-z0-9_]+-\d+__)([a-z0-9_]+)$/);
    return m ? itemActivity(m[1]) : null;
  }
  if (g.kind === 'place') {
    const pl = g.place || {};
    if (pl.type === 'dir' || /の方$/.test(t)) return 'exploring';
    if (pl.type === 'later') return /sapling|_log/.test(pl.laterKind || '') ? 'wood' : /furnace|smelt/.test(pl.laterKind || '') ? 'cooking' : 'farming';
    if (pl.kind) return itemActivity(pl.kind);
    return null;
  }
  return null;
}

// 行動 (action, arg) → 活動 | null (移動・待つ・食べる・寝るなどは数えない)
function actionActivity(action, arg) {
  const a = String(action || '');
  const x = String(arg || '').split(':')[0];
  if (['ask', 'say', 'broadcast', 'call', 'follow', 'give', 'trade', 'propose', 'report_find', 'share_chest'].includes(a)) return 'social';
  if (a === 'explore' || a === 'search') return 'exploring';
  if (['attack', 'hunt', 'lure'].includes(a)) return 'hunting';
  if (a === 'use_on') return itemActivity(x) === 'farming' || /farmland|seed|wheat|carrot|potato|beetroot|bone_meal|dirt|grass/.test(x) || !x ? 'farming' : itemActivity(x) || 'farming';
  if (['place', 'build', 'enclose'].includes(a)) { const k = itemActivity(x); return k === 'building' || !k || k === 'wood' || k === 'mining' ? 'building' : k === 'crafting' ? 'building' : k; }
  if (a === 'craft') { const k = itemActivity(x); return k === 'cooking' || k === 'building' ? k : 'crafting'; }
  if (a === 'smelt' || a === 'furnace_take') return FOOD.test(x) || /^(beef|porkchop|mutton|chicken|rabbit|cod|salmon|potato|kelp)$/.test(x) ? 'cooking' : 'crafting';
  if (a === 'collect' || a === 'pick_up') return itemActivity(x);
  return null;
}

// 言葉 (発言) → 活動。物の名前 (英語) と日本語のことば
const WORD_ACT = [
  ['farming', /畑|耕|小麦|種|作物|にんじん|人参|じゃがいも|ジャガイモ|収穫|植え|wheat|seed|farmland|carrot|potato/],
  ['cooking', /パン|料理|焼い|焼く|かまど|bread|cooked/],
  ['hunting', /羊|牛|豚|鶏|ニワトリ|にわとり|肉|狩|魚|釣|羊毛|mutton|beef|porkchop|chicken|wool|sheep|cow|pig/],
  ['wood', /木|丸太|原木|板|伐|_log|planks/],
  ['mining', /石|掘|鉱|鉄|石炭|洞窟|cobblestone|stone|iron|coal|ore/],
  ['building', /建て|家|壁|屋根|松明|たいまつ|明かり|囲|torch|fence|door/],
  ['crafting', /道具|ツルハシ|つるはし|斧|剣|作業台|チェスト|ベッド|pickaxe|axe|sword|crafting_table|chest|bed/],
  ['exploring', /探検|見て回|遠く|知らない所|探しに/],
];
const FOOD_WORD = /食べ物|食料|食糧|お腹|腹が|ご飯|ごはん|food/;
// 依頼・不足の形 (聞いた人の「足りていない感じ」になる)。それ以外の形は「その人がしていること」として数える
const REQUEST = /足りな|ないか|無いか|ない[。!！?？]?$|無い[。!！?？]?$|欲しい|ほしい|くれ|ちょうだい|ください|誰か|見た[?？]|見なかった|どこ|ある[?？]|持って(る|い)[?？]|必要|頼む|お願い|手伝|need|anyone|short of|out of/i;

function textActivities(text) {
  const t = String(text || '');
  const out = new Set();
  for (const [a, re] of WORD_ACT) if (re.test(t)) out.add(a);
  for (const w of t.match(/[a-z][a-z0-9_]{2,}/g) || []) { const a = itemActivity(w); if (a) out.add(a); }
  if (FOOD_WORD.test(t)) for (const a of FOOD_ACTS) out.add(a);
  return [...out];
}

// ---- 道具 (仕様の事実、1.20.1) ----
//   掘る速さの倍率 (正しい種類の道具のとき): 素手 1・木 2・石 4・鉄 6・ダイヤ 8・ネザライト 9・金 12。耐久値: 木 59・石 131・鉄 250・金 32・ダイヤ 1561・ネザライト 2031。
//   原木 (硬さ 2) は素手でも取れるが、斧の速さで掘る時間が変わる (素手 3秒・木の斧 1.5秒・石の斧 0.75秒)。
//   石・丸石・鉱石はツルハシが無いと何も落ちない (素手では取れない)。耕す (クワを土に使う) はクワの種類で速さは変わらない (耐久値だけ違う)
const TOOL_FACTS = {
  speed: { hand: 1, wooden: 2, stone: 4, iron: 6, diamond: 8, netherite: 9, golden: 12 },
  durability: { wooden: 59, stone: 131, iron: 250, golden: 32, diamond: 1561, netherite: 2031 },
};
const TOOL_MATS = ['wooden', 'stone', 'iron', 'golden', 'diamond', 'netherite'];
// 道具で効率が変わる仕事: 何の道具か・どのブロックか・素手では取れないか
const TOOL_TASKS = {
  wood: { tool: 'axe', blocks: /^([a-z_]+_log|[a-z_]+_wood|[a-z_]+_stem)$/, needsTool: false },
  mining: { tool: 'pickaxe', blocks: /^(stone|cobblestone|deepslate|cobbled_deepslate|andesite|diorite|granite|tuff|[a-z_]*_ore)$/, needsTool: true },
  farming: { tool: 'hoe', till: true },
};
const TOOL_TASK_JA = { wood: ['木を切り', '木を切っている'], mining: ['石を掘り', '石を掘っている'], farming: ['畑を耕し', '畑を耕している'] };
const TOOL_TASK_EN = { wood: 'cutting wood', mining: 'mining stone', farming: 'tilling farmland' };
const TOOL_MAT_JA = { hand: '素手', wooden: '木の道具', stone: '石の道具', iron: '鉄の道具', golden: '金の道具', diamond: 'ダイヤの道具', netherite: 'ネザライトの道具' };
const TOOL_MAT_EN = { hand: 'bare hands', wooden: 'wooden tools', stone: 'stone tools', iron: 'iron tools', golden: 'golden tools', diamond: 'diamond tools', netherite: 'netherite tools' };
// 発言の中の道具の言葉 (素手 / 木の斧 など) と仕事の言葉
const SAID_MAT = [
  ['hand', /素手|手で(切|掘|木)/],
  ['wooden', /木の(斧|おの|ツルハシ|つるはし|クワ|くわ|道具)|wooden_(axe|pickaxe|hoe)/],
  ['stone', /石の(斧|おの|ツルハシ|つるはし|クワ|くわ|道具)|stone_(axe|pickaxe|hoe)/],
  ['iron', /鉄の(斧|おの|ツルハシ|つるはし|クワ|くわ|道具)|iron_(axe|pickaxe|hoe)/],
];
const SAID_TASK = [['wood', /木を切|伐|原木|丸太|_log/], ['mining', /石を掘|掘って|採掘|丸石|cobblestone/], ['farming', /耕/]];

// 手の物 → その仕事の道具の素材 (正しい種類の道具でなければ素手と同じ)
function toolMat(held, task) {
  const t = TOOL_TASKS[task]; if (!t) return null;
  const m = String(held || '').match(/^([a-z]+)_(axe|pickaxe|hoe|shovel|sword)$/);
  return m && m[2] === t.tool && TOOL_MATS.includes(m[1]) ? m[1] : 'hand';
}

// その素材で仕事をしている人に、target の素材の道具があったら効率がどれだけ上がるか (0〜1。仕様の事実から)
//   掘る: 1 − 今の速さ ÷ target の速さ (素手で取れないブロックは 1)。耕す: 速さは同じなので、耐久値の差 × durW
function toolGain(task, mat, { target = 'stone', durW = 0.3 } = {}) {
  const t = TOOL_TASKS[task]; if (!t || !mat) return 0;
  const S = TOOL_FACTS.speed; const D = TOOL_FACTS.durability;
  if (t.till) return mat === 'hand' || !D[mat] ? 0 : Math.max(0, durW * (1 - D[mat] / D[target]));
  if (t.needsTool && mat === 'hand') return 1;
  return Math.max(0, 1 - (S[mat] || 1) / S[target]);
}

// ---- 性格 → 活動のしきい値の表 (w: その性格が高いほど θ が下がる = 腰が上がりやすい) ----
//   論拠 (研究室の personas.js の temperament と needs.js の drives.curiosity から):
//   farming  : empathy (皆の食べ物を育てる世話) + obedience (決まった世話を毎日続ける地道さ)
//   wood     : greed (材料を蓄えたい) + obedience (地道な作業)
//   mining   : greed (鉱石・物への欲) + bravery (暗い所・洞窟に入る)
//   hunting  : bravery (生き物と戦う)
//   exploring: curiosity (知らない所を見たい) + bravery (遠くの危険)
//   building : obedience (取り決め・共同の目標に沿う) + empathy (皆の拠点) + sociability (一緒に建てる)
//   cooking  : empathy (人に食べさせる)
//   crafting : greed (道具を持ちたい) + curiosity (作り方を試す)
//   social   : sociability (人と話したい) + empathy (人を気にかける)
const TRAIT_ACT = {
  farming: { empathy: 0.5, obedience: 0.5 },
  wood: { greed: 0.6, obedience: 0.4 },
  mining: { greed: 0.7, bravery: 0.3 },
  hunting: { bravery: 1.0 },
  exploring: { curiosity: 0.7, bravery: 0.3 },
  building: { obedience: 0.4, empathy: 0.3, sociability: 0.3 },
  cooking: { empathy: 1.0 },
  crafting: { greed: 0.5, curiosity: 0.5 },
  social: { sociability: 0.7, empathy: 0.3 },
};

const DEFAULTS = {
  enabled: true,
  // 慣れ: exp = うまくいったゴール + actWeight × うまくいった行動。fam = exp / (exp + halfExp)
  experience: { actWeight: 0.2, halfExp: 6, levels: [0.15, 0.4, 0.65], maxWords: 3 },
  // 刺激 (0〜sMax): 材料ごとの重み。heardHalfLife: 聞いた依頼が半分になる判断の数。chestEnough: 共有のチェストにこれだけあれば足りている
  stimulus: {
    chestW: 0.6, chestEnough: 16, heardW: 0.5, heardHalfLife: 20, heardKeep: 80, baseW: 0.3, projectW: 0.6, projectEnough: 8,
    coverW: 0.5, coverHalfLife: 30, coverKeep: 90, sMax: 1.5, showMin: 0.2, maxLines: 3, maxEvidence: 3,
  },
  // しきい値: θ = theta0 × (1 − traitScale × z) × (1 − famCut × fam)
  threshold: { theta0: 0.5, traitScale: 0.5, famCut: 0.5, min: 0.05, max: 1, traits: TRAIT_ACT },
  // ゴールの点: (Σ つらさ × P × (1 + beta × T) + gamma × T) ÷ (1 + alpha × 手間 × (1 − skillCut × fam))
  score: { beta: 0.5, gamma: 0.4, skillCut: 0.3 },
  // ほかの人の役回り: 見た/聞いた回数 (半減期 roleHalfLife 判断) が roleMin 以上で、その人の見た活動の roleShare 以上
  others: { roleHalfLife: 120, roleMin: 3, roleShare: 0.4, sayW: 0.5 },
  // 他人のための道具 (6): toolW: 刺激の重み。toolCap: 人の和の上限。toolHalfLife: 見たことが半分になる判断の数。target: 比べる道具の素材。
  //   durW: 耕すときの耐久値の差の重み。showMin: 言葉に出す (薄れ × gain) の下限。acts: 刺激を足す活動。sayW: 聞いた (発言) の重み
  //   (2026-11-07 使う側の声を足したので、見て察する分は 0.4 → 0.2 に弱めて残す)
  tools: { enabled: true, toolW: 0.2, toolCap: 1, toolHalfLife: 60, keep: 150, target: 'stone', durW: 0.3, showMin: 0.1, acts: ['mining', 'crafting'], sayW: 0.7 },
  // 物単位の刺激 (7。2026-11-07 ユーザー決定「使う側の声から刺激を生む」): 聞いた頼みごと・独り言・自分の不満・共有のチェストの道具の数から、物ごと (stone_axe など) の刺激 sItem。
  //   s_item[x] = min(sMax, heardW × Σ_人 min(1, Σ 薄れ × 形の重み) + selfW × 自分の不満の刺激 + stockW × 足りなさ × min(1, 使う人 / usersRef))
  //   形の重み: 近くで頼まれた near 1・全体チャット all allW・独り言 mutter mutterW。半減期 halfLife 判断。
  //   足りなさ (道具の種類ごと、共有のチェストがあるときだけ): 1 − チェストの数 ÷ (使う人 × perUser × (1 + breakK × 壊れたのを見聞きした回数 (薄れ)))
  //   ゴールの T は、活動の刺激と物の刺激の和で: T = (s_act + s_item)² / ((s_act + s_item)² + θ_act²)。物を作るゴールにも渡すゴール (give) にも、共有のチェストに入れる状態のゴールにも同じ s_item が効く
  items: { enabled: true, heardW: 0.6, mutterW: 0.6, allW: 0.8, halfLife: 30, keep: 120, selfW: 1, sMax: 1.5,
    stockW: 0.5, perUser: 0.5, usersRef: 2, breakK: 0.5, breakHalfLife: 60, usersHalfLife: 120, target: 'stone', showMin: 0.1, maxLines: 3 },
};

const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function merge(a, b) { if (!isObj(a) || !isObj(b)) return b === undefined ? a : b; const o = { ...a }; for (const [k, v] of Object.entries(b)) o[k] = merge(a[k], v); return o; }
const decayed = (n, from, to, half) => n * Math.pow(0.5, Math.max(0, to - from) / half);

// 独り言の印 (agent.js が文の頭に付ける)
const MUTTER_MARK = /^\s*[(（]ひとりごと[)）]\s*/;

// ゴールの物 (物のゴール: target、渡すゴール: give、状態 chest_<物>・shared_<チェスト>__<物>: その物)
function goalItem(g) {
  if (!g) return null;
  if (g.kind === 'item') return String(g.target || '') || null;
  if (g.kind === 'person') return g.give || null;
  if (g.kind === 'state') { const m = String(g.target || '').match(/^(?:chest_|shared_[A-Za-z0-9_]+-\d+__)([a-z0-9_]+)$/); return m ? m[1] : null; }
  return null;
}

// 反応の強さ (Bonabeau の反応しきい値モデル)
function response(s, theta) { if (!(s > 0)) return 0; return (s * s) / (s * s + theta * theta); }

class Division {
  constructor({ cfg = {}, temperament = {}, drives = {}, me = null } = {}) {
    this.cfg = merge(DEFAULTS, cfg || {});
    this.me = me;
    this.traits = { bravery: 0.5, empathy: 0.5, obedience: 0.5, greed: 0.5, sociability: 0.5, ...temperament, curiosity: drives.curiosity ?? temperament.curiosity ?? 0.5 };
    this.exp = Object.fromEntries(ACTIVITIES.map((a) => [a, { goals: 0, goalsOk: 0, acts: 0, actsOk: 0 }]));
    this.heard = []; // 聞いた依頼 [{ tick, act, from, text, w }]
    this.seen = []; // 見た/聞いた、ほかの人がしていること [{ tick, who, act, how }]
    this.roles = {}; // 名前 → { 活動: { n, t } } (半減期で薄れる)
    this.othersSeq = 0;
    this.toolUse = {}; // 名前 → { 仕事: { mat, t, how } } (いちばん新しく見た/聞いた道具)
    this.s = {}; this.theta = {}; this.T = {}; this.evidence = {};
    this.itemHeard = []; // 聞いた道具の頼みごと・独り言 [{ tick, item, from, form, text }]
    this.itemBreaks = []; // ほかの人の道具が壊れたのを見聞きした [{ tick, who, tool, type, how }]
    this.sItem = {}; this.itemEvidence = {}; this.stock = {};
    this.tick = 0;
  }

  static fromJSON(d, opts = {}) {
    const x = new Division(opts);
    if (isObj(d)) {
      if (isObj(d.exp)) for (const a of ACTIVITIES) if (isObj(d.exp[a])) Object.assign(x.exp[a], d.exp[a]);
      if (isObj(d.roles)) x.roles = d.roles;
      if (Array.isArray(d.heard)) x.heard = d.heard;
      if (Array.isArray(d.seen)) x.seen = d.seen;
      if (Number.isFinite(d.tick)) x.tick = d.tick;
      if (isObj(d.toolUse)) x.toolUse = d.toolUse;
      if (Array.isArray(d.itemHeard)) x.itemHeard = d.itemHeard;
      if (Array.isArray(d.itemBreaks)) x.itemBreaks = d.itemBreaks;
    }
    return x;
  }

  toJSON() { return { exp: this.exp, roles: this.roles, heard: this.heard.slice(-40), seen: this.seen.slice(-80), tick: this.tick, toolUse: this.toolUse, itemHeard: this.itemHeard.slice(-40), itemBreaks: this.itemBreaks.slice(-30) }; }

  // ---- 慣れ ----
  noteAction(action, arg, ok) {
    const a = actionActivity(action, arg);
    if (!a) return null;
    this.exp[a].acts += 1; if (ok) this.exp[a].actsOk += 1;
    return a;
  }

  // goalpath.js の log (goal_done / reselect) を受ける。達成・植えた・手に入れたが欲求は変わらなかった をうまくいったに数える
  noteGoal(e) {
    if (!e || !['goal_done', 'reselect'].includes(e.kind)) return null;
    const a = goalActivity({ kind: e.goalKind, target: e.target, place: e.place || null });
    if (!a) return null;
    this.exp[a].goals += 1;
    if (['done', 'planted', 'need_unmet'].includes(e.result)) this.exp[a].goalsOk += 1;
    return a;
  }

  famOf(a) {
    const x = this.exp[a]; if (!x) return 0;
    const c = this.cfg.experience;
    const e = x.goalsOk + c.actWeight * x.actsOk;
    return e / (e + c.halfExp);
  }

  fam() { return Object.fromEntries(ACTIVITIES.map((a) => [a, r3(this.famOf(a))])); }

  levelOf(a) {
    const f = this.famOf(a); const L = this.cfg.experience.levels;
    const tried = this.exp[a].goals + this.exp[a].acts > 0;
    if (!tried) return -1;
    return f >= L[2] ? 3 : f >= L[1] ? 2 : f >= L[0] ? 1 : 0;
  }

  // 慣れの言葉。慣れている順に、慣れているもの (段階1以上) を2つまで + やったことはあるがまだ不慣れなもの1つ
  famWords({ lang = 'ja' } = {}) {
    const en = lang === 'en';
    const W = en ? ['still new to', 'getting used to', 'used to', 'well used to'] : ['まだ不慣れ', '少し慣れてきた', '慣れている', 'すっかり慣れている'];
    const lv = ACTIVITIES.map((a) => ({ a, l: this.levelOf(a), f: this.famOf(a), n: this.exp[a].goals + this.exp[a].acts })).filter((x) => x.l >= 0);
    const good = lv.filter((x) => x.l >= 1).sort((p, q) => q.f - p.f).slice(0, Math.max(0, this.cfg.experience.maxWords - 1));
    const raw = lv.filter((x) => x.l === 0).sort((p, q) => q.n - p.n).slice(0, 1);
    const out = [...good, ...raw].slice(0, this.cfg.experience.maxWords);
    return out.map((x) => (en ? `${W[x.l]} ${ACT_EN[x.a]}` : `${ACT_JA[x.a]}は${W[x.l]}`)).join(en ? '; ' : '。');
  }

  // ---- 見聞き ----
  // 聞いた発言 (近くの声・全体チャット)。依頼の形なら刺激に、それ以外はその人がしていることに数える
  noteHeard(from, text, tick = this.tick, { form = null } = {}) {
    if (!from || from === this.me || from === '自分') return [];
    this.noteToolWords(from, text, tick, { form });
    const acts = textActivities(text);
    if (!acts.length) return [];
    if (REQUEST.test(String(text))) {
      for (const a of acts) this.heard.push({ tick, act: a, from, text: String(text).slice(0, 30), w: FOOD_ACTS.includes(a) && FOOD_WORD.test(text) && acts.length > 1 ? 0.6 : 1 });
      const cut = tick - this.cfg.stimulus.heardKeep;
      this.heard = this.heard.filter((h) => h.tick >= cut).slice(-60);
      return acts.map((a) => ({ act: a, kind: 'request' }));
    }
    for (const a of acts) this.noteDoing(from, a, tick, 'said', this.cfg.others.sayW);
    // 「石の斧があればなあ」は使っている道具ではない (欲しい形の文は道具の使い方に数えない。壊れた話は数える)
    if (!(TF.isWantText(text) && !TF.isBrokeText(text))) this.noteToolSaid(from, text, tick);
    return acts.map((a) => ({ act: a, kind: 'doing' }));
  }

  // ---- 物単位の刺激 (7) ----
  // 発言の中の道具の言葉: 欲しい・困っている形なら itemHeard に、壊れた形なら itemBreaks に。form: near | all | mutter (独り言は文の頭の印でも分かる)
  noteToolWords(from, text, tick = this.tick, { form = null } = {}) {
    const t = String(text || '');
    const words = TF.parseToolWords(t);
    if (!words.length) return [];
    const f = form || (MUTTER_MARK.test(t) ? 'mutter' : 'near');
    const out = [];
    if (TF.isBrokeText(t)) for (const w of words) { this.itemBreaks.push({ tick, who: from, tool: w.item, type: w.type, how: 'said' }); out.push({ kind: 'broke', type: w.type }); }
    if (TF.isWantText(t)) {
      for (const w of words) {
        // 素材の無い言葉 (「ツルハシが欲しい」) は、その人が使っているのを見た素材の1段上、分からなければ target (石)
        let item = w.item;
        if (!item) {
          const task = TF.TASK_OF_TYPE[w.type];
          const seenMat = task && this.toolUse[from] && this.toolUse[from][task] ? this.toolUse[from][task].mat : null;
          const up = seenMat ? TF.LADDER[Math.min(TF.LADDER.length - 1, Math.max(0, TF.LADDER.indexOf(seenMat)) + 1)] : this.cfg.items.target;
          item = `${up === 'hand' ? this.cfg.items.target : up}_${w.type}`;
        }
        this.itemHeard.push({ tick, item, from, form: f, text: t.replace(MUTTER_MARK, '').trim().slice(0, 30) });
        out.push({ kind: 'want', item, form: f });
      }
    }
    const cut = tick - this.cfg.items.keep;
    this.itemHeard = this.itemHeard.filter((h) => h.tick >= cut).slice(-60);
    this.itemBreaks = this.itemBreaks.filter((h) => h.tick >= tick - 3 * this.cfg.items.breakHalfLife).slice(-40);
    return out;
  }

  // ほかの人の道具が壊れたのを見た (entity_status 47。その時の手の物)
  noteBreakSeen(who, tool, tick = this.tick) {
    if (!who || who === this.me) return;
    const i = TF.toolInfo(tool);
    this.itemBreaks.push({ tick, who, tool: tool || null, type: i ? i.type : null, how: 'saw' });
    if (i) { const task = TF.TASK_OF_TYPE[i.type]; if (task && TOOL_TASKS[task]) this.noteToolUse(who, task, i.mat, tick, 'saw'); }
  }

  // 物単位の刺激を作る。selfWant: { 物: 自分の不満の刺激 } (toolwant.selfStimulus)、selfTypes: 自分が使っている道具の種類、chests: 共有のチェスト
  updateItems({ tick = this.tick, selfWant = {}, selfTypes = [], chests = [] } = {}) {
    const c = this.cfg.items;
    const s = {}; const ev = {};
    const put = (x, v, ja, en) => { if (!(v > 0)) return; s[x] = (s[x] || 0) + v; const e = ev[x] || (ev[x] = { ja: [], en: [], who: new Set() }); if (ja && !e.ja.includes(ja)) { e.ja.push(ja); e.en.push(en); } };
    if (!c || c.enabled === false) { this.sItem = {}; this.itemEvidence = {}; return {}; }
    // 聞いた頼みごと・独り言 (人ごとに 1 まで)
    const per = {};
    for (const h of this.itemHeard) {
      const fw = h.form === 'mutter' ? c.mutterW : h.form === 'all' ? c.allW : 1;
      const w = decayed(fw, h.tick, tick, c.halfLife);
      if (w < 0.03) continue;
      const k = `${h.item}|${h.from}`;
      per[k] = Math.min(1, (per[k] || 0) + w);
      const e = ev[h.item] || (ev[h.item] = { ja: [], en: [], who: new Set() });
      e.who.add(h.from);
      const q = `${h.from}${h.form === 'mutter' ? 'のつぶやき' : ''}「${h.text}」`;
      if (!e.ja.includes(q)) { e.ja.push(q); e.en.push(`${h.from}${h.form === 'mutter' ? ' muttered' : ' said'}「${h.text}」`); }
    }
    this.sItemBy = {}; // 物 → { 人: その人の頼みごと・独り言の分 } (渡すゴールは、渡す相手の分だけ)
    for (const [k, v] of Object.entries(per)) { const [x, who] = k.split('|'); s[x] = (s[x] || 0) + c.heardW * v; (this.sItemBy[x] || (this.sItemBy[x] = {}))[who] = r3(c.heardW * v); }
    this.sItemStock = {};
    // 自分の不満
    for (const [x, v] of Object.entries(selfWant || {})) put(x, c.selfW * v, null, null);
    // 共有のチェストの道具の数と、使う人・壊れた回数 (共有のチェストの中身が見えているときだけ)
    this.stock = {};
    const known = (chests || []).filter((ch) => ch && Array.isArray(ch.items) && ch.known !== false);
    if (known.length) {
      for (const type of ['pickaxe', 'axe', 'shovel', 'hoe']) {
        const task = TF.TASK_OF_TYPE[type];
        const users = new Set();
        for (const [who, r] of Object.entries(this.toolUse)) if (r[task] && decayed(1, r[task].t, tick, c.usersHalfLife) >= 0.25) users.add(who);
        for (const b of this.itemBreaks) if (b.type === type && decayed(1, b.tick, tick, c.usersHalfLife) >= 0.25) users.add(b.who);
        if (selfTypes.includes(type)) users.add('自分');
        const stock = known.reduce((t, ch) => t + ch.items.filter((it) => { const i = TF.toolInfo(it.name); return i && i.type === type; }).reduce((u, it) => u + (it.count || 1), 0), 0);
        const breaks = this.itemBreaks.filter((b) => b.type === type).reduce((t, b) => t + decayed(1, b.tick, tick, c.breakHalfLife), 0);
        this.stock[type] = { stock, users: users.size, breaks: r2(breaks) };
        if (!users.size) continue;
        const need = users.size * c.perUser * (1 + c.breakK * breaks);
        const lack = Math.max(0, 1 - stock / need);
        if (lack <= 0) continue;
        const x = `${c.target}_${type}`;
        const ids = known.map((ch) => ch.id).filter(Boolean).slice(0, 2).join('・');
        const who = [...users].slice(0, 4).join('・');
        this.sItemStock[x] = r3(c.stockW * lack * Math.min(1, users.size / c.usersRef));
        put(x, c.stockW * lack * Math.min(1, users.size / c.usersRef),
          `共有のチェスト${ids ? ` ${ids}` : ''}の${TF.TYPE_JA[type]}は${stock}本。${TF.TYPE_JA[type]}を使っているのを見聞きした人: ${who}${breaks >= 0.5 ? `。${TF.TYPE_JA[type]}が壊れたのを見聞きした: ${Math.round(breaks)}回` : ''}`,
          `${type}s in the shared chests: ${stock}; people seen or heard using a ${type}: ${[...users].slice(0, 4).join(', ')}${breaks >= 0.5 ? `; ${type}s seen or heard breaking: ${Math.round(breaks)}` : ''}`);
      }
    }
    this.sItem = Object.fromEntries(Object.entries(s).map(([x, v]) => [x, r3(Math.min(c.sMax, v))]));
    this.itemEvidence = Object.fromEntries(Object.entries(ev).map(([x, e]) => [x, { ja: e.ja, en: e.en, who: [...e.who] }]));
    return this.sItem;
  }

  // ゴールの反応の強さ (活動の刺激 + 物の刺激)。返り値 { T, act, item, sAct, sItem, theta }
  goalT(g) {
    const a = goalActivity(g);
    const item = goalItem(g);
    const sA = (a && this.s[a]) || 0;
    // 渡すゴール: 渡す相手の頼みごと・独り言の分と、共有のチェストの足りなさの分 (ほかの人の頼みは、その人に渡す理由にならない)
    const sI = !item ? 0 : g.kind === 'person'
      ? Math.min(this.cfg.items.sMax, (((this.sItemBy || {})[item] || {})[g.target] || 0) + ((this.sItemStock || {})[item] || 0))
      : (this.sItem[item] || 0);
    const theta = (a && this.theta[a]) || this.cfg.threshold.theta0;
    const T = sI > 0 ? response(sA + sI, theta) : (a && this.T[a]) || 0;
    return { T: r3(T), act: a, item: sI > 0 ? item : null, sAct: sA, sItem: sI, theta };
  }

  // 2B に渡す「欲しがっている人がいる物 (見聞きした範囲)」
  itemText({ lang = 'ja' } = {}) {
    const c = this.cfg.items;
    const en = lang === 'en';
    const rows = Object.entries(this.sItem).filter(([x, v]) => v >= c.showMin && this.itemEvidence[x] && (this.itemEvidence[x].ja.length || this.itemEvidence[x].who.length))
      .sort((p, q) => q[1] - p[1]).slice(0, c.maxLines);
    return rows.map(([x]) => {
      const e = this.itemEvidence[x];
      const who = e.who.length ? (en ? `wanted by ${e.who.join(', ')}` : `${e.who.join('・')}が欲しがっている`) : '';
      return `${x}: ${[who, ...(en ? e.en : e.ja).slice(-2)].filter(Boolean).join(en ? '; ' : '。')}`;
    }).join('\n');
  }

  // 提案を書く LLM に見せる道具の事実: 誰が何を使っているか・壊れた回数・共有のチェストの道具の数・仕様
  toolFactsText({ tick = this.tick, mine = [] } = {}) {
    const lines = [];
    const use = [];
    for (const [who, r] of Object.entries(this.toolUse)) for (const [task, x] of Object.entries(r)) if (decayed(1, x.t, tick, this.cfg.items.usersHalfLife) >= 0.25) use.push(`${who}: ${TOOL_TASK_JA[task] ? TOOL_TASK_JA[task][1] : task} (${TOOL_MAT_JA[x.mat] || x.mat})`);
    if (use.length) lines.push(`見聞きした道具の使い方: ${use.slice(0, 6).join('・')}`);
    const br = {};
    for (const b of this.itemBreaks) { const k = `${b.who}の${b.tool || TF.TYPE_JA[b.type] || '道具'}`; br[k] = (br[k] || 0) + 1; }
    if (Object.keys(br).length) lines.push(`道具が壊れた (見聞きした): ${Object.entries(br).slice(0, 5).map(([k, n]) => `${k} ${n}回`).join('・')}`);
    if (mine.length) lines.push(`自分の道具の耐久: ${mine.map((t) => `${t.name} 残り${t.left}/${t.max}`).join('・')}`);
    const st = Object.entries(this.stock).filter(([, v]) => v.users || v.stock);
    if (st.length) lines.push(`共有のチェストの道具: ${st.map(([type, v]) => `${TF.TYPE_JA[type]} ${v.stock}本 (使う人 ${v.users})`).join('・')}`);
    const wants = Object.entries(this.sItem).filter(([x]) => this.itemEvidence[x] && this.itemEvidence[x].who.length).map(([x]) => `${x} (${this.itemEvidence[x].who.join('・')})`);
    if (wants.length) lines.push(`道具の頼みごと・つぶやき・壊れた話をしていた人: ${wants.slice(0, 4).join('・')}`);
    if (lines.length) lines.push(`仕様: 耐久 木 ${TF.TOOL_FACTS.durability.wooden}・石 ${TF.TOOL_FACTS.durability.stone}・鉄 ${TF.TOOL_FACTS.durability.iron} 回、掘る速さ 素手1・木2・石4・鉄6`);
    return lines.join('\n');
  }

  // ---- 他人のための道具 (6) ----
  // who が task (wood・mining・farming) を mat (hand・wooden・stone…) でしていた
  noteToolUse(who, task, mat, tick = this.tick, how = 'saw') {
    if (!who || who === this.me || who === '自分' || !TOOL_TASKS[task] || !mat) return;
    const r = this.toolUse[who] || (this.toolUse[who] = {});
    r[task] = { mat, t: tick, how };
  }

  // 発言の中の「素手で木を切ってる」「木のツルハシしかない」など
  noteToolSaid(from, text, tick = this.tick) {
    const t = String(text || '');
    const mat = (SAID_MAT.find(([, re]) => re.test(t)) || [])[0];
    if (!mat) return;
    const tasks = SAID_TASK.filter(([, re]) => re.test(t)).map(([k]) => k);
    // 道具の種類から仕事が分かるとき (木のツルハシ → 石掘り)
    const tm = t.match(/(斧|おの|_axe)|(ツルハシ|つるはし|_pickaxe)|(クワ|くわ|_hoe)/);
    if (tm) tasks.push(tm[1] ? 'wood' : tm[2] ? 'mining' : 'farming');
    for (const k of new Set(tasks)) this.noteToolUse(from, k, mat, tick, 'said');
  }

  // 見込み: [{ who, task, mat, w (薄れ), gain, v = w × gain (発言は × sayW), how }]
  toolGaps(tick = this.tick) {
    const c = this.cfg.tools;
    const out = [];
    for (const [who, r] of Object.entries(this.toolUse)) {
      for (const [task, x] of Object.entries(r)) {
        const w = decayed(1, x.t, tick, c.toolHalfLife) * (x.how === 'said' ? c.sayW : 1);
        const gain = toolGain(task, x.mat, { target: c.target, durW: c.durW });
        out.push({ who, task, mat: x.mat, how: x.how, w: r3(w), gain: r3(gain), v: r3(w * gain) });
      }
    }
    return out;
  }

  // 人ごとの和 (人の中では仕事の最大)。返り値 { total, people: [{ who, v }], rows }
  toolNeed(tick = this.tick) {
    const rows = this.toolGaps(tick);
    const per = {};
    for (const x of rows) per[x.who] = Math.max(per[x.who] || 0, x.v);
    const total = Object.values(per).reduce((t, v) => t + v, 0);
    return { total: r3(total), people: Object.entries(per).map(([who, v]) => ({ who, v: r3(v) })), rows };
  }

  // 言葉 (事実だけ): 「Ken・Maiが素手や木の道具で木を切り、畑を耕しているのを見た」
  toolText({ lang = 'ja', tick = this.tick } = {}) {
    const c = this.cfg.tools;
    const rows = this.toolGaps(tick).filter((x) => x.v >= c.showMin);
    if (!rows.length) return '';
    const en = lang === 'en';
    const who = [...new Set(rows.sort((a, b) => b.v - a.v).map((x) => x.who))].slice(0, 3);
    const mats = ['hand', ...TOOL_MATS].filter((m) => rows.some((x) => x.mat === m));
    const tasks = ['wood', 'mining', 'farming'].filter((k) => rows.some((x) => x.task === k));
    const seen = rows.some((x) => x.how !== 'said'); const said = rows.some((x) => x.how === 'said');
    if (en) return `${seen && said ? 'saw or heard' : said ? 'heard' : 'saw'} ${who.join(', ')} ${tasks.map((k) => TOOL_TASK_EN[k]).join(' and ')} with ${mats.map((m) => TOOL_MAT_EN[m]).join(' or ')}`;
    const tj = tasks.map((k, i) => TOOL_TASK_JA[k][i === tasks.length - 1 ? 1 : 0]).join('、');
    return `${who.join('・')}が${mats.map((m) => TOOL_MAT_JA[m]).join('や')}で${tj}のを${seen && said ? '見聞きした' : said ? '聞いた' : '見た'}`;
  }

  noteDoing(who, act, tick = this.tick, how = 'saw', w = 1) {
    if (!who || who === this.me || !act) return;
    this.seen.push({ tick, who, act, how });
    const cut = tick - this.cfg.stimulus.coverKeep;
    if (this.seen.length > 200 || (this.seen[0] && this.seen[0].tick < cut)) this.seen = this.seen.filter((s) => s.tick >= cut).slice(-200);
    const r = this.roles[who] || (this.roles[who] = {});
    const x = r[act] || { n: 0, t: tick };
    r[act] = { n: r3(decayed(x.n, x.t, tick, this.cfg.others.roleHalfLife) + w), t: tick };
  }

  // others.js の events (拾った・壊した) のうち、まだ見ていないもの
  noteOthers(events = [], tick = this.tick) {
    for (const e of events) {
      if (!(e.seq > this.othersSeq)) continue;
      this.othersSeq = e.seq;
      const a = itemActivity(e.name);
      if (a) this.noteDoing(e.who, a, tick, e.kind === 'pickup' ? 'saw_pickup' : e.kind === 'till' ? 'saw_till' : 'saw_break');
      // 道具 (6): 壊した・耕したときの手の物 (見えていたときだけ tool がある)
      if (e.tool !== undefined && (e.kind === 'break' || e.kind === 'till')) {
        const task = e.kind === 'till' ? 'farming' : Object.keys(TOOL_TASKS).find((k) => TOOL_TASKS[k].blocks && TOOL_TASKS[k].blocks.test(e.name));
        if (task) this.noteToolUse(e.who, task, toolMat(e.tool, task), tick, 'saw');
      }
    }
  }

  // ほかの人がよくしていること [{ act, n }] (多い順)
  rolesOf(name, tick = this.tick) {
    const r = this.roles[name]; if (!r) return [];
    const c = this.cfg.others;
    const xs = Object.entries(r).map(([act, x]) => ({ act, n: decayed(x.n, x.t, tick, c.roleHalfLife) }));
    const tot = xs.reduce((s, x) => s + x.n, 0);
    return xs.filter((x) => x.n >= c.roleMin && x.n / tot >= c.roleShare).sort((p, q) => q.n - p.n).map((x) => ({ act: x.act, n: r2(x.n) }));
  }

  // 「最近、畑のことをよくしている (見た)」/ "often farming lately (seen or heard)"
  othersDoing(name, { lang = 'ja', tick = this.tick } = {}) {
    const rs = this.rolesOf(name, tick).slice(0, 2);
    if (!rs.length) return '';
    return lang === 'en' ? `often ${rs.map((x) => ACT_EN[x.act]).join(' and ')} lately (seen or heard)` : `最近${rs.map((x) => ACT_JA[x.act]).join('と')}をよくしている (見聞きした)`;
  }

  // ---- 刺激・しきい値・反応 ----
  // view = { tick, chests: [{ id, items, known }], shared: [{ item, add, note }], base: { dark, enclosed } | null }
  update(view = {}) {
    const tick = Number.isFinite(view.tick) ? view.tick : this.tick;
    this.tick = tick;
    const c = this.cfg.stimulus;
    const raw = Object.fromEntries(ACTIVITIES.map((a) => [a, 0]));
    const ev = Object.fromEntries(ACTIVITIES.map((a) => [a, { ja: [], en: [] }]));
    // 共有のチェスト (中身が届いているもの)
    const chests = (view.chests || []).filter((ch) => ch && Array.isArray(ch.items) && ch.known !== false);
    if (chests.length) {
      const have = Object.fromEntries(ACTIVITIES.map((a) => [a, 0]));
      for (const ch of chests) for (const it of ch.items) {
        const a = itemActivity(it.name);
        if (a) have[a] += it.count || 0;
        if (FOOD.test(it.name)) for (const f of FOOD_ACTS) if (f !== a) have[f] += it.count || 0;
      }
      const ids = chests.map((ch) => ch.id).filter(Boolean).slice(0, 2).join('・');
      for (const a of ['farming', 'wood', 'mining', 'hunting', 'cooking']) {
        const lack = Math.max(0, 1 - have[a] / c.chestEnough);
        if (lack <= 0) continue;
        raw[a] += c.chestW * lack;
        const what = FOOD_ACTS.includes(a) ? '食べ物' : STUFF_JA[a];
        ev[a].ja.push(`共有のチェスト${ids ? ` ${ids}` : ''}に${what}が${have[a] === 0 ? '無い' : '少ない'}`);
        ev[a].en.push(`${FOOD_ACTS.includes(a) ? 'food' : STUFF_EN[a]}: ${have[a] === 0 ? 'none' : 'little'} in the shared chests`);
      }
    }
    // 聞いた依頼 (半減期で薄れる)
    for (const h of this.heard) {
      const w = decayed(h.w, h.tick, tick, c.heardHalfLife);
      if (w < 0.05) continue;
      raw[h.act] += c.heardW * w;
      const q = `${h.from}「${h.text}」`;
      if (!ev[h.act].ja.includes(q)) { ev[h.act].ja.push(q); ev[h.act].en.push(`${h.from} said「${h.text}」`); }
    }
    // 自分の拠点の様子
    if (view.base) {
      if (view.base.dark) { raw.building += c.baseW; ev.building.ja.push('自分の拠点が暗い'); ev.building.en.push('my base is dark'); }
      if (view.base.enclosed === false) { raw.building += c.baseW; ev.building.ja.push('自分の拠点が囲まれていない'); ev.building.en.push('my base is not enclosed'); }
    }
    // 取り決め・共同の目標の残り
    for (const sh of view.shared || []) {
      const a = itemActivity(sh.item);
      if (!a) continue;
      raw[a] += c.projectW * Math.min(1, (sh.add || 1) / c.projectEnough);
      ev[a].ja.push(`${sh.note || '取り決め'}: ${sh.item} あと${sh.add || 1}`);
      ev[a].en.push(`${sh.noteEn || 'agreement'}: ${sh.item}, ${sh.add || 1} more`);
    }
    // 他人のための道具 (6): ほかの人が素手・木の道具でしていた仕事の、石の道具での効率の伸び
    const tc = this.cfg.tools;
    if (tc && tc.enabled) {
      const tn = this.toolNeed(tick);
      const add = tc.toolW * Math.min(tc.toolCap, tn.total);
      if (add > 0) {
        const tj = this.toolText({ tick }); const te = this.toolText({ lang: 'en', tick });
        for (const a of tc.acts) { raw[a] += add; if (tj) { ev[a].ja.push(tj); ev[a].en.push(te); } }
      }
      this.toolAdd = r3(add);
    }
    // ほかの人がしているのを見た/聞いた (人ごとに1まで、半減期で薄れる)
    const cover = Object.fromEntries(ACTIVITIES.map((a) => [a, {}]));
    for (const s of this.seen) {
      const w = decayed(1, s.tick, tick, c.coverHalfLife);
      cover[s.act][s.who] = Math.min(1, (cover[s.act][s.who] || 0) + w);
    }
    const th = this.cfg.threshold;
    for (const a of ACTIVITIES) {
      const cv = Object.values(cover[a]).reduce((t, x) => t + x, 0);
      const s = Math.min(c.sMax, raw[a]) / (1 + c.coverW * cv);
      this.s[a] = r3(s);
      const who = Object.entries(cover[a]).filter(([, x]) => x >= 0.3).map(([n]) => n).slice(0, 3);
      if (who.length && raw[a] > 0) { ev[a].ja.push(`最近${who.join('・')}が${ACT_JA[a]}をしているのを見聞きした`); ev[a].en.push(`lately saw or heard ${who.join(', ')} ${ACT_EN[a]}`); }
      // しきい値
      const w = th.traits[a] || {};
      const wsum = Object.values(w).reduce((t, x) => t + Math.abs(x), 0) || 1;
      const z = Object.entries(w).reduce((t, [k, x]) => t + x * (2 * (this.traits[k] ?? 0.5) - 1), 0) / wsum;
      this.theta[a] = r3(clamp(th.theta0 * (1 - th.traitScale * z) * (1 - th.famCut * this.famOf(a)), th.min, th.max));
      this.T[a] = r3(response(this.s[a], this.theta[a]));
      ev[a].cover = r2(cv); ev[a].raw = r3(raw[a]);
    }
    this.evidence = ev;
    this.updateItems({ tick, selfWant: view.selfWant || {}, selfTypes: view.selfTypes || [], chests: view.chests || [] });
    return this.snapshot();
  }

  // ゴール選び (goalpath.js) に渡すもの
  view() {
    return { T: { ...this.T }, s: { ...this.s }, theta: { ...this.theta }, fam: this.fam(), score: { ...this.cfg.score }, activityOf: goalActivity,
      sItem: { ...this.sItem }, goalT: (g) => this.goalT(g), Tof: (g) => this.goalT(g).T };
  }

  // 記録 (毎判断)
  snapshot(act = undefined) {
    const nz = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v > 0));
    const out = { s: nz(this.s), theta: { ...this.theta }, T: nz(this.T), fam: nz(this.fam()) };
    if (this.toolAdd > 0) out.tool = this.toolAdd;
    if (Object.keys(this.sItem || {}).length) out.sItem = { ...this.sItem };
    if (Object.keys(this.stock || {}).length) out.stock = this.stock;
    if (act !== undefined) out.act = act;
    return out;
  }

  // 2B に渡す「みんなに足りていない物 (見聞きした範囲)」。刺激の大きい順に maxLines 行。材料の事実だけ
  stimulusText({ lang = 'ja' } = {}) {
    const c = this.cfg.stimulus;
    const en = lang === 'en';
    const rows = ACTIVITIES.filter((a) => this.s[a] >= c.showMin && this.evidence[a]).sort((p, q) => this.s[q] - this.s[p]).slice(0, c.maxLines);
    // 材料が同じ行 (共有のチェストの食べ物だけ、など) は1行にまとめる
    const lines = new Map();
    for (const a of rows) {
      const e = this.evidence[a][en ? 'en' : 'ja'];
      const sorted = [...e.filter((x) => !/^最近|^lately/.test(x)).slice(-c.maxEvidence), ...e.filter((x) => /^最近|^lately/.test(x))];
      const body = sorted.join(en ? '; ' : '。');
      if (!lines.has(body)) lines.set(body, []);
      lines.get(body).push(a);
    }
    const out = [...lines].map(([body, as]) => `${as.map((a) => (en ? STUFF_EN[a] : STUFF_JA[a])).join(en ? ', ' : '・')}: ${body}`);
    const it = this.itemText({ lang });
    if (it) out.push(it);
    return out.join('\n');
  }

  // 振り返りに渡す事実: 自分の活動の回数 (前の振り返りから。since = 前の exp の写し)
  countsSince(prev = null) {
    const out = [];
    for (const a of ACTIVITIES) {
      const x = this.exp[a]; const p = (prev && prev[a]) || { goals: 0, goalsOk: 0, acts: 0, actsOk: 0 };
      const n = (x.acts - p.acts) + (x.goals - p.goals);
      if (n > 0) out.push({ act: a, acts: x.acts - p.acts, actsOk: x.actsOk - p.actsOk, goals: x.goals - p.goals, goalsOk: x.goalsOk - p.goalsOk, n });
    }
    return out.sort((p, q) => q.n - p.n);
  }

  copyExp() { return JSON.parse(JSON.stringify(this.exp)); }
}

// 振り返りの事実の文: 「最近やったこと: 畑のこと (行動 6回・ゴール 2個)・木を切ること (行動 2回)」
function countsText(list, max = 4) {
  if (!list.length) return '';
  return `最近やったこと: ${list.slice(0, max).map((x) => `${ACT_JA[x.act]} (${[x.acts ? `行動${x.acts}回` : '', x.goals ? `ゴール${x.goals}個` : ''].filter(Boolean).join('・')})`).join('・')}`;
}

// ---- 分業の指標 (summarize_run 用。counts = { 名前: { 活動: 回数 } }) ----
function entropy(ps) { return -ps.filter((p) => p > 0).reduce((t, p) => t + p * Math.log2(p), 0); }
function gini(xs) {
  const v = xs.slice().sort((a, b) => a - b); const n = v.length; const s = v.reduce((a, b) => a + b, 0);
  if (!n || !s) return 0;
  let cum = 0; for (let i = 0; i < n; i++) cum += (i + 1) * v[i];
  return (2 * cum) / (n * s) - (n + 1) / n;
}
// Gorelick, Bertram, Killeen & Fewell (2004) の DOL 指数: D = I(人; 活動) / H(活動) (0: 皆が同じ割合、1: 人ごとに活動が分かれている)。
//   あわせて人ごとの偏り (正規化エントロピー 1 − H(活動|人) / log2 K)、活動ごとの担い手の偏り (Gini)、集団の活動の広がり (H(活動) / log2 K)
function dolIndex(counts, acts = ACTIVITIES) {
  const names = Object.keys(counts).filter((n) => acts.some((a) => (counts[n][a] || 0) > 0));
  const tot = names.reduce((t, n) => t + acts.reduce((s, a) => s + (counts[n][a] || 0), 0), 0);
  if (!tot) return { n: 0, total: 0, dol: null, meanSpecialization: null, groupSpread: null, giniByActivity: {}, perAgent: {} };
  const pAct = acts.map((a) => names.reduce((t, n) => t + (counts[n][a] || 0), 0) / tot);
  const Hact = entropy(pAct);
  const K = Math.log2(acts.length);
  let Hcond = 0;
  const perAgent = {};
  for (const n of names) {
    const row = acts.map((a) => counts[n][a] || 0); const s = row.reduce((x, y) => x + y, 0);
    const p = row.map((x) => x / s); const h = entropy(p);
    Hcond += (s / tot) * h;
    const top = acts.map((a, i) => [a, p[i]]).sort((x, y) => y[1] - x[1]);
    perAgent[n] = { total: s, entropy: r3(h), specialization: r3(1 - h / K), top: top.slice(0, 3).filter(([, v]) => v > 0).map(([a, v]) => `${a} ${Math.round(v * 100)}%`) };
  }
  const giniByActivity = Object.fromEntries(acts.map((a) => [a, r3(gini(names.map((n) => counts[n][a] || 0)))]).filter(([a]) => pAct[acts.indexOf(a)] > 0));
  return { n: names.length, total: tot, dol: Hact > 0 ? r3((Hact - Hcond) / Hact) : 0, meanSpecialization: r3(names.reduce((t, n) => t + perAgent[n].specialization, 0) / names.length),
    groupSpread: r3(Hact / K), activityShare: Object.fromEntries(acts.map((a, i) => [a, r3(pAct[i])]).filter(([, v]) => v > 0)), giniByActivity, perAgent };
}

module.exports = { MUTTER_MARK, goalItem, TOOL_FACTS, TOOL_TASKS, toolMat, toolGain, Division, DEFAULTS, ACTIVITIES, ACT_JA, ACT_EN, STUFF_JA, TRAIT_ACT, itemActivity, goalActivity, actionActivity, textActivities, response, countsText, dolIndex, entropy, gini, REQUEST };
