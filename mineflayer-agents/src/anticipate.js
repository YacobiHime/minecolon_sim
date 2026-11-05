'use strict';
// 予期される欲求 (先のつらさ)。needs.js の「いまのつらさ」とは別に、この先に来るつらさを見込む (2026-11-05 ユーザー決定: 「備える」概念)。
//   先の不安 (night): 夜までの近さ × 夜に危ない目に遭う見込み × (1 − いまの備え) × 性格 (bravery)
//     夜までの近さ prox = clamp(1 − 夜までの tick / horizon)^power。夜のあいだは 1 (夜明けまで続く)
//     見込み risk = base + (1 − base) × (1 − exp(−経験))。経験 = Σ_夜 (死んだ回数×perDeath + 傷を受けた回数×perHurt + 敵が近くに来た回数×perAttack) × nightDecay^(何夜前か)
//       base: 夜が来ること・夜に敵が出ることは知っている (1日の長さの事実) ので、経験が無くても少しはある
//     備え prep = 武器 (いちばん強い武器の傷 / weaponRef × weapon) + 防具 (防御の値 × armorPerPoint。持っているだけは carriedMul 倍)
//       + 盾 + 松明 (torchMin 本以上) + 囲まれた寝床/拠点を知っている (shelter) + ベッド (bed)。合計は max で頭打ち
//     fearMul = 1 + braveryScale × (0.5 − bravery) × 2 (needs.js の不安と同じ形)
//     night = clamp(prox × risk × (1 − prep) × fearMul × sensitivity)
//   先の空腹 (food): (1 − 手持ちの食べ物の回数 / wantMeals) × (入手元を知っていれば sourceMul) × (いまの空腹で強まる)
//     回数 = Σ 個数 × 満腹度 (foodPoints) / mealPoints。入手元: 食べられる動物・作物・実が見えている、か sourceMemory tick 以内に見た
//     強まり = lowMul + (1 − lowMul) × clamp(いまの空腹 / hungerRef)
// つらさの点 (ゴールの選び方): distress = (値 / threshold) × weight。数値はここで持ち、モデルには words() の言葉だけ。
// 係数は cfg.needs.anticipate (全員) と persona.needs.anticipate (人ごと) で変えられる。

const NIGHT_START = 13000;
const NIGHT_END = 23000;
const TICKS_PER_MIN = 1200; // 等倍 (20 tick/秒) の1分

const ANTICIPATE_DEFAULTS = {
  enabled: true,
  night: {
    horizon: 9000, power: 1.5, base: 0.3,
    perDeath: 0.5, perHurt: 0.08, perAttack: 0.05, nightDecay: 0.6, attackRadius: 8,
    weapon: 0.25, weaponRef: 6, armorPerPoint: 0.015, carriedMul: 0.5, shield: 0.15, torch: 0.1, torchMin: 4, shelter: 0.3, bed: 0.15, prepMax: 0.85,
    braveryScale: 0.6, sensitivity: 1, threshold: 0.3, weight: 1.2, wordMin: 0.08,
  },
  food: {
    mealPoints: 6, wantMeals: 3, sourceMul: 0.5, sourceMemory: 6000, lowMul: 0.5, hungerRef: 0.5,
    sensitivity: 1, threshold: 0.5, weight: 0.8, wordMin: 0.2,
  },
  maxNights: 6, // 覚えておく夜の数
};

// 1回の攻撃の傷 (facts.json の weapon_damage と同じ。弓・クロスボウは矢があるとき)
const WEAPON_DAMAGE = {
  wooden_sword: 4, golden_sword: 4, stone_sword: 5, iron_sword: 6, diamond_sword: 7, netherite_sword: 8,
  wooden_axe: 7, golden_axe: 7, stone_axe: 9, iron_axe: 9, diamond_axe: 9, netherite_axe: 10, trident: 9, bow: 6, crossbow: 6,
};
const ARMOR_POINTS = {
  leather_helmet: 1, leather_chestplate: 3, leather_leggings: 2, leather_boots: 1,
  golden_helmet: 2, golden_chestplate: 5, golden_leggings: 3, golden_boots: 1,
  chainmail_helmet: 2, chainmail_chestplate: 5, chainmail_leggings: 4, chainmail_boots: 1,
  iron_helmet: 2, iron_chestplate: 6, iron_leggings: 5, iron_boots: 2,
  diamond_helmet: 3, diamond_chestplate: 8, diamond_leggings: 6, diamond_boots: 3,
  netherite_helmet: 3, netherite_chestplate: 8, netherite_leggings: 6, netherite_boots: 3, turtle_helmet: 2,
};
const FOOD_ANIMALS = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom', 'cod', 'salmon']);
const FOOD_BLOCKS = /^(wheat|carrots|potatoes|beetroots|sweet_berry_bush|melon|pumpkin)$/;
const FOOD_SOURCE_JA = { cow: '牛', pig: '豚', sheep: '羊', chicken: '鶏', rabbit: 'ウサギ', mooshroom: 'ムーシュルーム', cod: 'タラ', salmon: '鮭',
  wheat: '小麦', carrots: 'にんじん', potatoes: 'じゃがいも', beetroots: 'ビートルート', sweet_berry_bush: 'スイートベリー', melon: 'スイカ', pumpkin: 'カボチャ' };

function clamp(v, lo = 0, hi = 1) { return Math.max(lo, Math.min(hi, v)); }
function r3(v) { return Math.round(v * 1000) / 1000; }
function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function merge(a, b) {
  if (!isObj(a) || !isObj(b)) return b === undefined ? a : b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(a[k]) ? merge(a[k], v) : v;
  return out;
}
const isNightTod = (t) => t >= NIGHT_START && t < NIGHT_END;
const tod0 = (t) => (((Number(t ?? 6000)) % 24000) + 24000) % 24000;

let foods = null;
function foodPointsOf(name) {
  if (!foods) { try { foods = require('minecraft-data')('1.20.1').foodsByName || {}; } catch (_) { foods = {}; } }
  const f = foods[name];
  return f && Number.isFinite(f.foodPoints) ? f.foodPoints : null;
}
// 死んだときのメッセージから、殺したもの (zombie など)。分からなければ null
function killerOf(message, cause = '') {
  const m = String(message || '');
  const by = m.match(/(?:escape|by) ([A-Z][A-Za-z ]*?)(?: using .*)?$/);
  if (by) return by[1].trim().toLowerCase().replace(/ /g, '_');
  if (/drown/.test(m) || /drown/.test(cause)) return 'water';
  if (/fell|fall/.test(m) || /fall/.test(cause)) return 'fall';
  if (/lava/.test(m) || /lava/.test(cause)) return 'lava';
  if (/starv/.test(m) || /starve/.test(cause)) return 'hunger';
  return null;
}

// いまの備え (持ち物・着けている物・知っている寝床) → { parts: { weapon, armor, shield, torch, shelter, bed }, total, have: {...} }
function preparedness(s = {}, c = ANTICIPATE_DEFAULTS.night) {
  const inv = s.inventory || [];
  const worn = s.worn || [];
  const count = (re) => inv.filter((i) => re.test(i.name)).reduce((t, i) => t + i.count, 0);
  const arrows = count(/arrow$/);
  let best = null;
  for (const i of [...inv, ...worn.map((n) => ({ name: n, count: 1 }))]) {
    const d = WEAPON_DAMAGE[i.name];
    if (!d || ((i.name === 'bow' || i.name === 'crossbow') && !arrows)) continue;
    if (!best || d > best.d) best = { name: i.name, d };
  }
  const wornArmor = worn.filter((n) => ARMOR_POINTS[n]);
  const carriedArmor = inv.filter((i) => ARMOR_POINTS[i.name]).map((i) => i.name);
  const armorPts = wornArmor.reduce((t, n) => t + ARMOR_POINTS[n], 0) + carriedArmor.reduce((t, n) => t + ARMOR_POINTS[n] * c.carriedMul, 0);
  const shield = worn.includes('shield') || count(/^shield$/) > 0;
  const torches = count(/^torch$/);
  const bedHave = !!s.bedKnown || count(/_bed$/) > 0;
  const shelter = !!s.shelterKnown || !!(s.shelter && s.shelter.enclosed); // 囲まれた拠点を知っている・いま囲まれた所にいる
  const parts = {
    weapon: best ? c.weapon * clamp(best.d / c.weaponRef) : 0,
    armor: armorPts * c.armorPerPoint,
    shield: shield ? c.shield : 0,
    torch: torches >= c.torchMin ? c.torch : 0,
    shelter: shelter ? c.shelter : 0,
    bed: bedHave ? c.bed : 0,
  };
  const total = Math.min(c.prepMax, Object.values(parts).reduce((t, v) => t + v, 0));
  return { parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, r3(v)])), total: r3(total),
    have: { weapon: best ? best.name : null, wornArmor, carriedArmor, shield, torches, shelter, bed: bedHave } };
}

class Anticipation {
  constructor(opts = {}) {
    this.cfg = merge(ANTICIPATE_DEFAULTS, opts.cfg || {});
    this.temperament = { bravery: 0.5, ...(opts.temperament || {}) };
    this.nights = []; // 越した夜 [{ day, deaths, hurts, attacks, killers: { zombie: 2 } }] (古い順)
    this.cur = null; // いまの夜 (夜のあいだだけ)
    this.lastTod = null;
    this.lastDay = null;
    this.sourceSeen = null; // { name, time } 最後に見た食べ物の入手元
    this.nearHostile = false;
    this.v = { night: 0, food: 0 };
    this.detail = null; // 記録用 (数値)
  }

  static fromJSON(d, opts = {}) {
    const a = new Anticipation(opts);
    if (isObj(d)) {
      if (Array.isArray(d.nights)) a.nights = d.nights;
      for (const k of ['cur', 'sourceSeen', 'lastTod', 'lastDay']) if (d[k] !== undefined) a[k] = d[k];
      if (isObj(d.v)) Object.assign(a.v, d.v);
    }
    return a;
  }

  toJSON() { return { nights: this.nights, cur: this.cur, sourceSeen: this.sourceSeen, lastTod: this.lastTod, lastDay: this.lastDay, v: this.v }; }

  // 夜が明けた (か寝て夜を飛ばした): いまの夜を越した夜に入れる
  closeNight() {
    if (!this.cur) return;
    this.nights.push(this.cur);
    if (this.nights.length > this.cfg.maxNights) this.nights.splice(0, this.nights.length - this.cfg.maxNights);
    this.cur = null;
  }

  openNight(day) { if (!this.cur) this.cur = { day: day ?? null, deaths: 0, hurts: 0, attacks: 0, killers: {} }; }

  // 死んだ (agent が死亡メッセージを拾ってから呼ぶ)。夜なら、いまの夜に数える
  noteDeath({ timeOfDay = null, day = null, cause = '', message = '' } = {}) {
    const t = timeOfDay == null ? this.lastTod : tod0(timeOfDay);
    if (t == null || !isNightTod(t)) return false;
    this.openNight(day ?? this.lastDay);
    this.cur.deaths += 1;
    const k = killerOf(message, cause) || 'unknown';
    this.cur.killers[k] = (this.cur.killers[k] || 0) + 1;
    return true;
  }

  // 1判断に1回 (Needs.update から)。s = { timeOfDay, day, inventory, worn, hostiles, entities, blocks, shelterKnown, bedKnown, time },
  //   o = { hurt (この判断で減った体力), hunger (いまの空腹 0〜1) }
  update(s = {}, o = {}) {
    const c = this.cfg;
    const t = tod0(s.timeOfDay);
    const night = isNightTod(t);
    if (this.cur && !night) this.closeNight();
    if (night) this.openNight(s.day);
    this.lastTod = t;
    if (s.day != null) this.lastDay = s.day;
    // 夜のあいだの出来事: 傷を受けた・敵が近くに来た (来た回数。いたままなら数えない)
    const near = (s.hostiles || []).some((h) => h.d <= c.night.attackRadius);
    if (night) {
      if (o.hurt > 0) this.cur.hurts += 1;
      if (near && !this.nearHostile) this.cur.attacks += 1;
    }
    this.nearHostile = near;
    // 食べ物の入手元: 見えている動物・作物・実
    const seen = (s.entities || []).find((e) => FOOD_ANIMALS.has(e.name)) || (s.blocks || []).find((b) => FOOD_BLOCKS.test(b.name));
    if (seen) this.sourceSeen = { name: seen.name, time: Number.isFinite(s.time) ? s.time : null };

    // 先の不安
    const cn = c.night;
    const ttn = night ? 0 : (NIGHT_START - t + 24000) % 24000;
    const prox = night ? 1 : Math.pow(clamp(1 - ttn / cn.horizon), cn.power);
    const exp = this.experience();
    const risk = cn.base + (1 - cn.base) * (1 - Math.exp(-exp));
    const prep = preparedness(s, cn);
    const fearMul = 1 + cn.braveryScale * (0.5 - this.temperament.bravery) * 2;
    const nightV = c.enabled ? clamp(prox * risk * (1 - prep.total) * fearMul * cn.sensitivity) : 0;
    // 先の空腹
    const cf = c.food;
    const meals = (s.inventory || []).reduce((tt, i) => { const p = foodPointsOf(i.name); return tt + (p ? (p * i.count) / cf.mealPoints : 0); }, 0);
    const srcAge = this.sourceSeen && this.sourceSeen.time != null && Number.isFinite(s.time) ? s.time - this.sourceSeen.time : null;
    const knowsSource = !!(seen || (this.sourceSeen && (srcAge == null || srcAge <= cf.sourceMemory)));
    const hNow = Number.isFinite(o.hunger) ? o.hunger : 0;
    const foodV = c.enabled ? clamp((1 - clamp(meals / cf.wantMeals)) * (knowsSource ? cf.sourceMul : 1) * (cf.lowMul + (1 - cf.lowMul) * clamp(hNow / cf.hungerRef)) * cf.sensitivity) : 0;
    this.v = { night: r3(nightV), food: r3(foodV) };
    this.detail = {
      night: { v: r3(nightV), ttn, prox: r3(prox), risk: r3(risk), exp: r3(exp), prep: prep.total, prepParts: prep.parts, fearMul: r3(fearMul), isNight: night },
      food: { v: r3(foodV), meals: Math.round(meals * 10) / 10, knowsSource, source: this.sourceSeen ? this.sourceSeen.name : null },
      have: prep.have,
    };
    return this.v;
  }

  // 経験 (前の夜といまの夜の出来事の重さ)。いまの夜は重さ 1、越した夜は nightDecay^(何夜前か)
  experience() {
    const cn = this.cfg.night;
    const w = (n) => n.deaths * cn.perDeath + n.hurts * cn.perHurt + n.attacks * cn.perAttack;
    let e = this.cur ? w(this.cur) : 0;
    const L = this.nights.length;
    this.nights.forEach((n, i) => { e += w(n) * Math.pow(cn.nightDecay, L - 1 - i); });
    return e;
  }

  // 夜に死んだ・襲われた・傷を受けたことがあるか (いまの夜か、覚えている夜)。knowledge の night_harm に使う
  harmed() { return [...this.nights, ...(this.cur ? [this.cur] : [])].some((n) => n.deaths || n.hurts || n.attacks); }

  // 夜に殺したもの (覚えている夜の合計、多い順)
  killers() {
    const m = {};
    for (const n of [...this.nights, ...(this.cur ? [this.cur] : [])]) for (const [k, v] of Object.entries(n.killers || {})) m[k] = (m[k] || 0) + v;
    return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  }

  distress(k) { const c = this.cfg[k]; return (this.v[k] / c.threshold) * c.weight; }

  // 先のつらさの一覧 (ゴールの選び方)。[{ need: 'night'|'food', later: true, distress, ratio, text, textEn }] ratio ≥ minRatio だけ
  later({ minRatio = 0.6 } = {}) {
    return ['night', 'food'].map((k) => ({ need: k, later: true, distress: r3(this.distress(k)), ratio: r3(this.v[k] / this.cfg[k].threshold) }))
      .filter((x) => x.ratio >= minRatio).sort((a, b) => b.distress - a.distress)
      .map((x) => ({ ...x, text: this.wordsOf(x.need, 'ja'), textEn: this.wordsOf(x.need, 'en') }));
  }

  // ---- 言葉 (数値は出さない) ----
  words({ lang = 'ja' } = {}) {
    const out = [];
    if (this.v.night >= this.cfg.night.wordMin) out.push(this.wordsOf('night', lang));
    if (this.v.food >= this.cfg.food.wordMin) out.push(this.wordsOf('food', lang));
    return out.filter(Boolean);
  }

  wordsOf(k, lang = 'ja') {
    const en = lang === 'en';
    const d = this.detail;
    if (!d) return '';
    const J = en ? '; ' : '。';
    if (k === 'night') {
      const n = d.night;
      const parts = [];
      if (n.isNight) {
        const left = NIGHT_END - this.lastTod;
        const m = Math.max(1, Math.round(left / TICKS_PER_MIN));
        parts.push(en ? `it is night; about ${m} minutes until dawn` : `今は夜。夜明けまであと${m}分ほど`);
      } else if (n.ttn <= 600) parts.push(en ? 'night is about to fall' : 'もうすぐ夜');
      else {
        const m = Math.max(1, Math.round(n.ttn / TICKS_PER_MIN));
        parts.push(en ? `about ${m} minutes until night` : `あと${m}分ほどで夜`);
      }
      parts.push(this.experienceText(lang));
      parts.push(...this.prepText(lang));
      const v = this.v.night;
      const feel = n.isNight
        ? (v < 0.15 ? ['夜のあいだが少し気になる', 'a little uneasy about the rest of the night'] : v < 0.4 ? ['夜明けまでが不安', 'anxious about the rest of the night'] : ['夜明けまでが怖い', 'afraid of the rest of the night'])
        : (v < 0.15 ? ['夜が来るのが少し気になる', 'a little uneasy that night is coming'] : v < 0.4 ? ['夜が来るのが不安', 'anxious that night is coming'] : ['夜が来るのが怖い', 'afraid of the coming night']);
      parts.push(en ? feel[1] : feel[0]);
      return parts.filter(Boolean).join(J);
    }
    const f = d.food;
    const parts = [];
    const meals = Math.floor(f.meals);
    parts.push(f.meals <= 0 ? (en ? 'I have no food with me' : '食べ物を持っていない') : meals < 1 ? (en ? 'the food I have is less than one meal' : '手持ちの食べ物は1回分に足りない') : (en ? `the food I have is enough for about ${meals} meal${meals > 1 ? 's' : ''}` : `手持ちの食べ物は${meals}回分ほど`));
    if (f.knowsSource && f.source) parts.push(en ? `I have seen ${f.source} recently` : `最近${FOOD_SOURCE_JA[f.source] || f.source}を見た`);
    else parts.push(en ? 'I do not know where to get food' : '食べ物が手に入る所を知らない');
    const v = this.v.food;
    parts.push(v < 0.5 ? (en ? 'a little worried about food later' : 'この先の食べ物が少し気になる') : (en ? 'worried about food later' : 'この先の食べ物が心配'));
    return parts.join(J);
  }

  // 前の夜・いまの夜の出来事 (事実)
  experienceText(lang = 'ja') {
    const en = lang === 'en';
    const killedText = (n, when) => {
      const ks = Object.entries(n.killers || {}).filter(([k]) => k !== 'unknown');
      const kt = ks.map(([k, c]) => (en ? `${k}${c > 1 ? ` ${c} times` : ''}` : `${k}に${c}回`));
      if (en) return `${when} I was killed ${n.deaths > 1 ? `${n.deaths} times` : 'once'}${kt.length ? ` (by ${kt.join(', ')})` : ''}`;
      return kt.length ? `${when}${kt.join('、')}殺された` : `${when}${n.deaths}回殺された`;
    };
    const harmText = (n, when) => {
      if (n.deaths) return killedText(n, when);
      if (n.hurts) return en ? `${when} I was hurt by enemies` : `${when}敵に傷を負わされた`;
      if (n.attacks) return en ? `${when} enemies came close to me` : `${when}敵が近くまで来た`;
      return null;
    };
    if (this.cur) {
      const t = harmText(this.cur, en ? 'tonight' : '今夜はもう');
      if (t) return t;
    }
    const last = this.nights[this.nights.length - 1];
    if (!last) return this.cur ? (en ? 'this is my first night here' : 'ここで過ごす初めての夜') : (en ? 'I have not spent a night here yet' : 'まだここで夜を越したことがない');
    const yesterday = last.day != null && this.lastDay != null && this.lastDay - last.day <= 1;
    const when = en ? (yesterday ? 'last night' : 'on an earlier night') : (yesterday ? '昨夜は' : '前の夜は');
    return harmText(last, when) || (en ? `${when} nothing happened to me` : `${when}何事もなかった`);
  }

  // いまの備え (事実だけ。良い・悪いは書かない)
  prepText(lang = 'ja') {
    const en = lang === 'en';
    const h = this.detail.have;
    const out = [];
    out.push(h.weapon ? (en ? `I have a ${h.weapon}` : `${h.weapon}を持っている`) : (en ? 'I have no weapon' : '武器を持っていない'));
    if (h.wornArmor.length) out.push(en ? `I am wearing ${h.wornArmor.join(', ')}` : `${h.wornArmor.join('・')}を着けている`);
    else if (h.carriedArmor.length) out.push(en ? `I carry ${h.carriedArmor.join(', ')} but am not wearing it` : `${h.carriedArmor.join('・')}を持っているが着けていない`);
    else out.push(en ? 'I am wearing no armor' : '防具を着けていない');
    if (h.shield) out.push(en ? 'I have a shield' : '盾を持っている');
    if (h.torches) out.push(en ? `I have ${h.torches} torches` : `松明を${h.torches}本持っている`);
    if (h.shelter) out.push(en ? 'I know an enclosed place to stay' : '囲まれた寝床がある');
    else if (h.bed) out.push(en ? 'I have a bed' : 'ベッドがある');
    else out.push(en ? 'I have no enclosed place to stay' : '囲まれた寝床は無い');
    return out;
  }

  values() { return this.detail ? { night: this.v.night, food: this.v.food, ttn: this.detail.night.ttn, risk: this.detail.night.risk, prep: this.detail.night.prep, exp: this.detail.night.exp, meals: this.detail.food.meals } : { ...this.v }; }
}

module.exports = { Anticipation, ANTICIPATE_DEFAULTS, preparedness, killerOf, WEAPON_DAMAGE, ARMOR_POINTS, NIGHT_START, NIGHT_END };
