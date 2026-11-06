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
// 研究方針: 仕様・事実は見せるが、使い方は書かない。役割の名前は与えない (活動の種類の言葉だけ)。評価語を入れない。
//   数値はここで持ち、モデルには言葉だけ (Jev は英語、2B は日本語)。全員の状態は見せない (見聞きした範囲だけ)。

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
  if (a === 'explore') return 'exploring';
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
};

const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function merge(a, b) { if (!isObj(a) || !isObj(b)) return b === undefined ? a : b; const o = { ...a }; for (const [k, v] of Object.entries(b)) o[k] = merge(a[k], v); return o; }
const decayed = (n, from, to, half) => n * Math.pow(0.5, Math.max(0, to - from) / half);

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
    this.s = {}; this.theta = {}; this.T = {}; this.evidence = {};
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
    }
    return x;
  }

  toJSON() { return { exp: this.exp, roles: this.roles, heard: this.heard.slice(-40), seen: this.seen.slice(-80), tick: this.tick }; }

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
  noteHeard(from, text, tick = this.tick) {
    if (!from || from === this.me || from === '自分') return [];
    const acts = textActivities(text);
    if (!acts.length) return [];
    if (REQUEST.test(String(text))) {
      for (const a of acts) this.heard.push({ tick, act: a, from, text: String(text).slice(0, 30), w: FOOD_ACTS.includes(a) && FOOD_WORD.test(text) && acts.length > 1 ? 0.6 : 1 });
      const cut = tick - this.cfg.stimulus.heardKeep;
      this.heard = this.heard.filter((h) => h.tick >= cut).slice(-60);
      return acts.map((a) => ({ act: a, kind: 'request' }));
    }
    for (const a of acts) this.noteDoing(from, a, tick, 'said', this.cfg.others.sayW);
    return acts.map((a) => ({ act: a, kind: 'doing' }));
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
      if (a) this.noteDoing(e.who, a, tick, e.kind === 'pickup' ? 'saw_pickup' : 'saw_break');
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
    return this.snapshot();
  }

  // ゴール選び (goalpath.js) に渡すもの
  view() {
    return { T: { ...this.T }, s: { ...this.s }, theta: { ...this.theta }, fam: this.fam(), score: { ...this.cfg.score }, activityOf: goalActivity };
  }

  // 記録 (毎判断)
  snapshot(act = undefined) {
    const nz = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v > 0));
    const out = { s: nz(this.s), theta: { ...this.theta }, T: nz(this.T), fam: nz(this.fam()) };
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
    return [...lines].map(([body, as]) => `${as.map((a) => (en ? STUFF_EN[a] : STUFF_JA[a])).join(en ? ', ' : '・')}: ${body}`).join('\n');
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

module.exports = { Division, DEFAULTS, ACTIVITIES, ACT_JA, ACT_EN, STUFF_JA, TRAIT_ACT, itemActivity, goalActivity, actionActivity, textActivities, response, countsText, dolIndex, entropy, gini, REQUEST };
