'use strict';
// 人としての欲求とストレス。空腹だけはマイクラの満腹度 (food 0〜20・saturation) を基準にする (2026-11-05 ユーザー決定)。
//   人は食べる・寝る・安心できることが必要で、できないと相当ストレスになる。マイクラで寝なくても困らない・
//   安全が仕組みの上で要らないのとは関係なく、人としての欲求を持たせ、マイクラはそれを満たす手段にする。
//
// 欲求はどれも 0〜1 の「足りなさ」(大きいほどつらい)。時間はゲームの tick (1日 = 24000 tick = 等倍で20分) で進める。
//   基本: hunger (空腹)・sleep (眠気)・safety (不安 = 安心の足りなさ)
//   その上: connection (つながり)・recognition (認められたい)・性格ごと: curiosity (好奇心)・greed (欲)・care (世話)
//   上の欲求は、基本の欲求が満たされていないほど弱く出る (マズロー的な重み gate)。
// ストレス 0〜1: しきい値を超えた欲求があるとたまり、長く満たされないほど急に大きくなる (非線形)。満たされれば少しずつ抜ける。
// 数値はここで持ち、2B と Jev には words() の言葉だけを渡す。係数はすべて cfg.needs (全員) と persona.needs (人ごと) で変えられる。

const { Anticipation, ANTICIPATE_DEFAULTS } = require('./anticipate');

const BASIC = ['hunger', 'sleep', 'safety'];
const HIGHER = ['connection', 'recognition', 'curiosity', 'greed', 'care'];
const NEEDS = [...BASIC, ...HIGHER];
// 欲求の英語の名前 (Jev の state のキー)
const NEED_EN = { hunger: 'hunger', sleep: 'sleep', safety: 'safety', connection: 'connection', recognition: 'recognition', curiosity: 'curiosity', greed: 'possessions', care: 'helping_others' };
const NEED_LABEL = {
  hunger: '空腹', sleep: '眠気', safety: '安心', connection: '人とのつながり', recognition: '認められたい',
  curiosity: '好奇心', greed: '物が欲しい', care: '人の役に立ちたい',
};
const LABEL_TO_NEED = Object.fromEntries(Object.entries(NEED_LABEL).map(([k, v]) => [v, k]));
const NIGHT = (t) => t >= 13000 && t < 23000;
const KANJI = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

// 既定値 (全員同じ)。fullAfter は 0 から 1 (いちばんつらい) まで増えるのにかかる tick (増える速さ = 1/fullAfter。rate で直接も書ける)
const NEEDS_DEFAULTS = {
  start: { hunger: 0.2, sleep: 0.1, safety: 0.1, connection: 0.2, recognition: 0.2, curiosity: 0.3, greed: 0.2, care: 0.2 },
  // 空腹 (source 'food'): 空腹 = (1 − food/20 + 隠し満腹度 (saturation) が 0 なら satZero) × sensitivity。
  //   food はマイクラの満腹度 (bot.food)。食べた分は満腹度の回復でそのまま減る (食べた直後は foodPoints と saturation から見積もる)。
  //   人ごとの差: sensitivity (空腹の感じやすさ。大きいほど早くつらい) と threshold。
  //   満腹度が分からないとき (bot なしのテストなど) だけ、前の方式: 約7時間 (fullAfter) でいちばんつらくなり、食べると foodPoints × perFoodPoint 減る
  hunger: { source: 'food', satZero: 0.1, sensitivity: 1, fullAfter: 7000, threshold: 0.5, perFoodPoint: 0.1, minEat: 0.1 },
  // 眠気: 起きている間ずっと増え、夜は nightMult 倍。ベッドで夜を越すと bedTo まで、途中で起きたら bedPartial だけ減る。
  //       床で休む (rest の行動) と rest だけ減る。寝ないで夜を越すと翌日まで残る (自然には減らない)
  sleep: { fullAfter: 30000, nightMult: 2.5, threshold: 0.55, bedTo: 0, bedPartial: 0.35, bedHunger: 0.15, rest: 0.03, restActions: ['wait', 'look_around'] },
  // 不安: 下の要素の和を目標に、上がるときは up、下がるときは down の割合で近づく。
  //       気質の bravery が低いほど、上げる要素が大きく効く (×(1 + braveryScale×(0.5−bravery)×2))
  safety: {
    threshold: 0.5, up: 0.6, down: 0.3, braveryScale: 0.5,
    dark: 0.25, darkLight: 8, nightOutside: 0.2, hostile: 0.35, hostileRadius: 16, alone: 0.15, aloneRadius: 16,
    home: 0.2, homeRadius: 8, enclosed: 0.25, trusted: 0.15, trustedRadius: 8, trustedAffinity: 58, bright: 0.05,
    // 殺された怖さ (なかなか消えない) と、痛い目にあった怖さ (早く消える)。半減期は tick
    deathShock: 0.7, deathHalfLife: 36000, hurtPerHp: 0.04, hurtHalfLife: 3000,
  },
  // つながり: 時間で増える (sociability が高いほど速い ×(0.5 + sociability))。話しただけでは減らない。
  //   一緒に行動した (follow など)・助けた/助けられた で減る。近くに人がいると少しずつ減る。関係の良い人がいると、その分だけ軽い
  connection: { fullAfter: 12000, threshold: 0.6, together: 0.2, helped: 0.25, near: 0.015, nearRadius: 6, bond: 0.3, togetherActions: ['follow', 'give', 'call'] },
  // 認められたい: 頼られた (聞かれて答えた)・物をあげた・感謝された・作った/置いた で減る。持ち物の種類が多いと少し軽い
  recognition: { fullAfter: 16000, threshold: 0.6, asked: 0.2, gave: 0.2, thanked: 0.3, crafted: 0.04, placed: 0.02, possession: 0.1, possessionKinds: 12,
    thanksPattern: 'ありがと|助か|サンキュ|感謝', thanksWindow: 20 },
  // 性格ごとの欲求: 増える速さ = (1/fullAfter) × 重み × 2。重みは drives (persona で上書き) か、気質から (greed→greed、empathy→care、curiosity は 0.5)
  curiosity: { fullAfter: 12000, threshold: 0.6, newPlace: 0.2 },
  greed: { fullAfter: 16000, threshold: 0.6, perItem: 0.01, maxPerTick: 0.2 },
  care: { fullAfter: 16000, threshold: 0.6, helped: 0.35 },
  drives: {},
  // 基本の欲求 (最大のもの) が gateFrom から gateTo にかけて上がるほど、上の欲求を gateMin まで弱める
  gate: { from: 0.35, to: 0.8, min: 0.2 },
  // ストレス: dS = k × Σ 重み × 超えた分 × (1 + (満たされない時間 / T)^power) × dt/1000。
  //   (1 + …) は maxMul (上の欲求は maxMulHigher) で頭打ち。満たされない欲求が無ければ recover × dt/1000 ずつ抜ける。
  //   満たされた欲求の「満たされない時間」は unmetDecay 倍の速さで戻る
  stress: {
    k: 0.012, T: 6000, power: 2, maxMul: 6, maxMulHigher: 2, recover: 0.03, unmetDecay: 2,
    weights: { hunger: 1, sleep: 1.2, safety: 1.5, connection: 0.4, recognition: 0.25, curiosity: 0.2, greed: 0.2, care: 0.2 },
    // 感情への出方: ストレスが from を超えると、毎判断 S × gain × 性格の傾き × (0.3 + 出どころの割合) だけ怒り・悲しみ・恐れを上げる
    from: 0.15, gain: 1.2,
  },
  maxDt: 6000, defaultDt: 200,
  // 予期される欲求 (先のつらさ: 先の不安・先の空腹)。式と係数は anticipate.js
  anticipate: ANTICIPATE_DEFAULTS,
};

function clamp(v, lo = 0, hi = 1) { return Math.max(lo, Math.min(hi, v)); }
function r3(v) { return Math.round(v * 1000) / 1000; }
function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function merge(a, b) {
  if (!isObj(a) || !isObj(b)) return b === undefined ? a : b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(a[k]) ? merge(a[k], v) : v;
  return out;
}
const rateOf = (c) => (Number.isFinite(c.rate) ? c.rate : 1 / Math.max(1, c.fullAfter || 1e9));
const halve = (v, dt, half) => (half > 0 ? v * Math.pow(0.5, dt / half) : 0);

// 食べ物の満腹度 (minecraft-data の foodPoints)。無ければ 4
let foodsCache = null;
function foodPoints(name) {
  if (!foodsCache) {
    try { foodsCache = require('minecraft-data')('1.20.1').foodsByName || {}; } catch (_) { foodsCache = {}; }
  }
  const f = foodsCache[name];
  return f && Number.isFinite(f.foodPoints) ? f.foodPoints : 4;
}
// 食べ物の隠し満腹度 (minecraft-data の saturation)。無ければ foodPoints × 1.2
function foodSaturation(name) {
  foodPoints(name);
  const f = foodsCache[name];
  return f && Number.isFinite(f.saturation) ? f.saturation : foodPoints(name) * 1.2;
}
// 満腹度から空腹 (0〜1)。c = cfg.hunger
function hungerFromFood(food, saturation, c = NEEDS_DEFAULTS.hunger) {
  const base = 1 - clamp(food / 20) + (Number.isFinite(saturation) && saturation <= 0 ? (c.satZero ?? 0.1) : 0);
  return clamp(base * (c.sensitivity ?? 1));
}

// 周りがブロックで囲まれているか (頭の上に屋根・4方向の壁)。blockAt(x,y,z) → { boundingBox } | null
function senseShelter(blockAt, pos, { roofUp = 5, wallDist = 3 } = {}) {
  const solid = (b) => !!(b && b.boundingBox === 'block');
  const x = Math.floor(pos.x); const y = Math.floor(pos.y); const z = Math.floor(pos.z);
  let roof = false;
  for (let dy = 2; dy <= roofUp && !roof; dy++) roof = solid(blockAt(x, y + dy, z));
  let walls = 0;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    let hit = false;
    for (let d = 1; d <= wallDist && !hit; d++) hit = solid(blockAt(x + dx * d, y, z + dz * d)) || solid(blockAt(x + dx * d, y + 1, z + dz * d));
    if (hit) walls += 1;
  }
  return { roof, walls, enclosed: roof && walls >= 3 };
}

// 明るさ: ブロックの光と空の光 (夜は空の光が弱い)。0〜15
function effectiveLight({ blockLight = 0, skyLight = 15 }, timeOfDay) {
  const t = ((timeOfDay % 24000) + 24000) % 24000;
  let f = 1;
  if (t >= 12000 && t < 13800) f = 1 - ((t - 12000) / 1800) * 0.73;
  else if (NIGHT(t)) f = 0.27;
  else if (t >= 23000) f = 0.27 + ((t - 23000) / 1000) * 0.73;
  return Math.max(blockLight, Math.round(skyLight * f));
}

class Needs {
  constructor(opts = {}) {
    this.cfg = merge(NEEDS_DEFAULTS, opts.cfg || {});
    const t = opts.temperament || {};
    this.temperament = { bravery: 0.5, empathy: 0.5, obedience: 0.5, greed: 0.5, sociability: 0.5, ...t };
    const d = this.cfg.drives || {};
    this.drives = { curiosity: d.curiosity ?? 0.5, greed: d.greed ?? this.temperament.greed, care: d.care ?? this.temperament.empathy };
    this.v = { ...NEEDS_DEFAULTS.start, ...(this.cfg.start || {}) };
    this.stress = 0;
    this.unmet = Object.fromEntries(NEEDS.map((k) => [k, 0])); // 満たされない時間 (tick)
    this.inflow = Object.fromEntries(NEEDS.map((k) => [k, 0])); // 直近のストレスの出どころ
    this.shock = { death: 0, hurt: 0 };
    this.lastTime = null; // ゲームの通しの時間 (day×24000 + timeOfDay)
    this.lastHealth = null;
    this.lastInvTotal = null;
    this.lastAte = null; // 最後に食べた通しの時間
    this.food = null; // 最後に見たマイクラの満腹度 (0〜20。分からなければ null)
    this.saturation = null;
    this.sleptThisNight = false;
    this.wasNight = null;
    this.missedNights = 0; // 続けて寝られなかった夜の数
    this.helpedAt = {}; // 名前 → 自分が助けた判断 (感謝の判定)
    this.reasons = []; // 直近の不安の理由 [{ key, w, text }]
    this.comfort = []; // 直近の安心の理由
    this.counts = { ate: 0, slept: 0, rested: 0, deaths: 0, hurt: 0 };
    this.ant = new Anticipation({ cfg: this.cfg.anticipate, temperament: this.temperament });
  }

  static fromJSON(d, opts = {}) {
    const n = new Needs(opts);
    if (d && isObj(d) && isObj(d.v)) {
      for (const k of ['v', 'unmet', 'shock', 'counts']) if (isObj(d[k])) Object.assign(n[k], d[k]);
      for (const k of ['stress', 'lastTime', 'lastAte', 'missedNights', 'sleptThisNight', 'wasNight', 'food', 'saturation']) if (d[k] !== undefined) n[k] = d[k];
      if (isObj(d.ant)) n.ant = Anticipation.fromJSON(d.ant, { cfg: n.cfg.anticipate, temperament: n.temperament });
    }
    return n;
  }

  toJSON() {
    return { v: this.v, stress: this.stress, unmet: this.unmet, shock: this.shock, counts: this.counts, lastTime: this.lastTime, lastAte: this.lastAte,
      missedNights: this.missedNights, sleptThisNight: this.sleptThisNight, wasNight: this.wasNight, food: this.food, saturation: this.saturation, ant: this.ant.toJSON() };
  }

  threshold(k) { return this.cfg[k].threshold; }

  // 上の欲求の重み (基本の欲求が満たされていないほど小さい)
  gate() {
    const g = this.cfg.gate;
    const basic = Math.max(...BASIC.map((k) => this.v[k]));
    return 1 - (1 - g.min) * clamp((basic - g.from) / Math.max(1e-6, g.to - g.from));
  }

  // 実際に効いている強さ (上の欲求は gate を掛け、つながり・認められたいは関係・持ち物の分だけ軽い)
  effective(extra = this.lastExtra || {}) {
    const g = this.gate();
    const e = {};
    for (const k of BASIC) e[k] = this.v[k];
    e.connection = clamp(this.v.connection - (extra.bond || 0)) * g;
    e.recognition = clamp(this.v.recognition - (extra.possession || 0)) * g;
    for (const k of ['curiosity', 'greed', 'care']) e[k] = this.v[k] * g;
    return e;
  }

  // 満腹度で空腹を決めているか
  foodBased() { return this.cfg.hunger.source === 'food' && Number.isFinite(this.food); }

  // 1判断に1回。s = { time (通しの tick), timeOfDay, food (0〜20), saturation, light, shelter: { enclosed, roof }, hostiles: [{ name, d }],
  //   players: [{ name, d, affinity }], atHome, unfamiliar, health, invTotal, invKinds, newCell }
  update(s = {}) {
    const c = this.cfg;
    const tod = ((Number(s.timeOfDay ?? 6000) % 24000) + 24000) % 24000;
    let dt = c.defaultDt;
    if (Number.isFinite(s.time)) {
      dt = this.lastTime == null ? 0 : clamp(s.time - this.lastTime, 0, c.maxDt);
      this.lastTime = s.time;
    }
    const night = NIGHT(tod);
    // 夜が明けた: その夜に寝られなかったら数える
    if (this.wasNight === true && !night) {
      this.missedNights = this.sleptThisNight ? 0 : this.missedNights + 1;
      this.sleptThisNight = false;
    }
    this.wasNight = night;
    const v = this.v;
    // 空腹 (満腹度が分かれば満腹度から。分からなければ時間で増える)・眠気
    if (c.hunger.source === 'food' && Number.isFinite(s.food)) {
      this.food = s.food;
      this.saturation = Number.isFinite(s.saturation) ? s.saturation : null;
      v.hunger = hungerFromFood(this.food, this.saturation, c.hunger);
    } else v.hunger = clamp(v.hunger + rateOf(c.hunger) * dt);
    v.sleep = clamp(v.sleep + rateOf(c.sleep) * (night ? c.sleep.nightMult : 1) * dt);
    // ダメージ
    let hurtNow = 0;
    if (Number.isFinite(s.health)) {
      if (this.lastHealth != null && s.health < this.lastHealth) { hurtNow = this.lastHealth - s.health; this.shock.hurt = clamp(this.shock.hurt + (this.lastHealth - s.health) * c.safety.hurtPerHp); this.counts.hurt += 1; }
      this.lastHealth = s.health;
    }
    this.shock.death = halve(this.shock.death, dt, c.safety.deathHalfLife);
    this.shock.hurt = halve(this.shock.hurt, dt, c.safety.hurtHalfLife);
    // 不安
    const sc = c.safety;
    const fearMul = 1 + sc.braveryScale * (0.5 - this.temperament.bravery) * 2;
    const up = []; const down = [];
    const shelter = s.shelter || {};
    const light = Number.isFinite(s.light) ? s.light : (night ? 4 : 15);
    if (light < sc.darkLight) up.push({ key: 'dark', w: sc.dark, text: '周りが暗い', en: 'it is dark around here' });
    if (night && !shelter.enclosed) up.push({ key: 'nightOutside', w: sc.nightOutside, text: '夜なのに外にいる', en: 'it is night and I am outside' });
    const hs = (s.hostiles || []).filter((h) => h.d <= sc.hostileRadius).sort((a, b) => a.d - b.d);
    if (hs.length) {
      const w = sc.hostile * clamp(0.3 + (1 - hs[0].d / sc.hostileRadius) + 0.15 * (hs.length - 1), 0, 1.5);
      up.push({ key: 'hostile', w, text: `近くに${[...new Set(hs.map((h) => h.name))].slice(0, 2).join('や')}がいる`, en: `${[...new Set(hs.map((h) => h.name))].slice(0, 2).join(' and ')} nearby` });
    }
    const players = s.players || [];
    const anyone = players.some((p) => p.d <= sc.aloneRadius);
    if (!anyone && s.unfamiliar) up.push({ key: 'alone', w: sc.alone, text: '知らない場所に一人でいる', en: 'alone in an unfamiliar place' });
    const raise = up.reduce((t, x) => t + x.w, 0) * fearMul;
    if (s.atHome) down.push({ key: 'home', w: sc.home, text: '自分の寝床の近くにいる', en: 'I am near my own bed' });
    if (shelter.enclosed) down.push({ key: 'enclosed', w: sc.enclosed, text: '周りを囲まれた場所にいる', en: 'I am in an enclosed place' });
    const trusted = players.filter((p) => p.d <= sc.trustedRadius && (p.affinity ?? 50) >= sc.trustedAffinity);
    if (trusted.length) down.push({ key: 'trusted', w: sc.trusted, text: `${trusted.map((p) => p.name).slice(0, 2).join('と')}が近くにいる`, en: `${trusted.map((p) => p.name).slice(0, 2).join(' and ')} nearby` });
    if (light >= 12) down.push({ key: 'bright', w: sc.bright, text: '明るい', en: 'it is bright' });
    const lower = down.reduce((t, x) => t + x.w, 0);
    const shock = this.shock.death + this.shock.hurt;
    const target = clamp(raise - lower + shock);
    v.safety = clamp(v.safety + (target - v.safety) * (target > v.safety ? sc.up : sc.down));
    if (this.shock.death >= 0.15) up.push({ key: 'death', w: this.shock.death, text: '前に殺されたことが頭から離れない', en: 'I cannot stop thinking about being killed before' });
    if (this.shock.hurt >= 0.1) up.push({ key: 'hurt', w: this.shock.hurt, text: 'さっき痛い目にあった', en: 'I just got hurt' });
    this.reasons = up.sort((a, b) => b.w - a.w);
    this.comfort = down.sort((a, b) => b.w - a.w);
    // つながり・認められたい・性格ごと
    const cc = c.connection;
    v.connection = clamp(v.connection + rateOf(cc) * (0.5 + this.temperament.sociability) * dt);
    if (players.some((p) => p.d <= cc.nearRadius)) v.connection = clamp(v.connection - cc.near * (dt / 200));
    v.recognition = clamp(v.recognition + rateOf(c.recognition) * dt);
    v.curiosity = clamp(v.curiosity + rateOf(c.curiosity) * this.drives.curiosity * 2 * dt);
    v.greed = clamp(v.greed + rateOf(c.greed) * this.drives.greed * 2 * dt);
    v.care = clamp(v.care + rateOf(c.care) * this.drives.care * 2 * dt);
    if (s.newCell) v.curiosity = clamp(v.curiosity - c.curiosity.newPlace);
    if (Number.isFinite(s.invTotal)) {
      if (this.lastInvTotal != null) {
        const diff = s.invTotal - this.lastInvTotal;
        v.greed = clamp(v.greed + clamp(-diff * c.greed.perItem, -c.greed.maxPerTick, c.greed.maxPerTick));
      }
      this.lastInvTotal = s.invTotal;
    }
    const bestAff = Math.max(50, ...players.map((p) => p.affinity ?? 50), s.bestAffinity ?? 50);
    this.lastExtra = {
      bond: cc.bond * clamp((bestAff - 50) / 50),
      possession: c.recognition.possession * clamp((s.invKinds || 0) / c.recognition.possessionKinds),
    };
    // ストレス
    const e = this.effective();
    const st = c.stress;
    let dS = 0;
    let anyUnmet = false;
    for (const k of NEEDS) {
      const thr = this.threshold(k);
      if (e[k] >= thr) {
        anyUnmet = true;
        this.unmet[k] += dt;
        const over = (e[k] - thr) / Math.max(1e-6, 1 - thr);
        const inc = st.k * (st.weights[k] ?? 0) * over * Math.min(BASIC.includes(k) ? st.maxMul : st.maxMulHigher, 1 + Math.pow(this.unmet[k] / st.T, st.power)) * (dt / 1000);
        this.inflow[k] = inc;
        dS += inc;
      } else {
        this.unmet[k] = Math.max(0, this.unmet[k] - dt * st.unmetDecay);
        this.inflow[k] = 0;
      }
    }
    this.stress = clamp(anyUnmet ? this.stress + dS : this.stress - st.recover * (dt / 1000));
    for (const k of NEEDS) v[k] = r3(v[k]);
    this.stress = r3(this.stress);
    // 先のつらさ (anticipate.js)
    this.ant.update({ ...s, timeOfDay: tod }, { hurt: hurtNow, hunger: v.hunger });
    return { dt, dS };
  }

  // ---- 出来事 ----
  onEat(item) {
    const c = this.cfg.hunger;
    if (this.foodBased()) {
      // 次の観測で満腹度から決め直す。それまでは食べ物の量から見積もる (マイクラと同じく food と saturation が増える)
      this.food = Math.min(20, this.food + foodPoints(item));
      this.saturation = Math.min(this.food, (this.saturation || 0) + foodSaturation(item));
      this.v.hunger = r3(hungerFromFood(this.food, this.saturation, c));
    } else this.v.hunger = r3(clamp(this.v.hunger - Math.max(c.minEat, foodPoints(item) * c.perFoodPoint)));
    this.lastAte = this.lastTime;
    this.counts.ate += 1;
  }

  // ベッドで寝た。nightSkipped: 夜を越した
  onSleep({ nightSkipped = false } = {}) {
    const c = this.cfg.sleep;
    this.v.sleep = r3(nightSkipped ? Math.min(this.v.sleep, c.bedTo) : clamp(this.v.sleep - c.bedPartial));
    // 寝て夜を飛ばしても、そのあいだにお腹は空く (ゲームの通しの時間は進まないので、ここで足す)
    //  (満腹度で決めているときは足さない。マイクラでは寝て飛ばした夜に満腹度は減らない)
    if (nightSkipped && !this.foodBased()) this.v.hunger = r3(clamp(this.v.hunger + c.bedHunger));
    this.sleptThisNight = true;
    if (nightSkipped) { this.missedNights = 0; this.wasNight = false; this.ant.closeNight(); }
    this.counts.slept += 1;
  }

  onRest() { this.v.sleep = r3(clamp(this.v.sleep - this.cfg.sleep.rest)); this.counts.rested += 1; }

  onDeath() {
    this.shock.death = clamp(this.shock.death + this.cfg.safety.deathShock);
    this.v.safety = clamp(this.v.safety + this.cfg.safety.deathShock * 0.5);
    this.lastHealth = null;
    this.counts.deaths += 1;
  }

  // 一緒に行動した (follow・give・call が成功)
  onTogether() { this.v.connection = r3(clamp(this.v.connection - this.cfg.connection.together)); }

  // 助けられた (聞いて答えてもらえた・物をもらった)
  onHelpedBy() { this.v.connection = r3(clamp(this.v.connection - this.cfg.connection.helped)); }

  // 人を助けた (聞かれて答えた・物をあげた)。tick は感謝の判定用
  onHelpedOther(name, { tick = 0, gave = false, asked = false } = {}) {
    const c = this.cfg;
    this.v.connection = r3(clamp(this.v.connection - c.connection.helped));
    this.v.care = r3(clamp(this.v.care - c.care.helped));
    if (gave) this.v.recognition = r3(clamp(this.v.recognition - c.recognition.gave));
    if (asked) this.v.recognition = r3(clamp(this.v.recognition - c.recognition.asked));
    if (name) this.helpedAt[name] = tick;
  }

  // 聞こえた話: 自分が最近助けた人からの感謝の言葉なら、認められた
  onHeard(from, text, tick = 0) {
    const c = this.cfg.recognition;
    const at = this.helpedAt[from];
    if (at == null || tick - at > c.thanksWindow) return false;
    if (!new RegExp(c.thanksPattern).test(String(text || ''))) return false;
    this.v.recognition = r3(clamp(this.v.recognition - c.thanked));
    delete this.helpedAt[from];
    return true;
  }

  onMade(kind) {
    const c = this.cfg.recognition;
    this.v.recognition = r3(clamp(this.v.recognition - (kind === 'craft' ? c.crafted : c.placed)));
  }

  // 行動の結果から (agent.js が毎判断の後に呼ぶ)
  onAction(action, arg, result = {}, { tick = 0 } = {}) {
    if (!result || !result.ok) return;
    if (action === 'eat') this.onEat(String(arg || '').split(':')[0] || 'bread');
    else if (action === 'sleep' && result.sleep && result.sleep.slept) this.onSleep({ nightSkipped: !!result.sleep.nightSkipped });
    else if (this.cfg.sleep.restActions.includes(action)) this.onRest();
    if (action === 'craft') this.onMade('craft');
    if (action === 'place') this.onMade('place');
    if (this.cfg.connection.togetherActions.includes(action)) this.onTogether();
    if (action === 'give') this.onHelpedOther(String(arg || '').split(':')[0], { tick, gave: true });
  }

  // ---- 言葉 (数値は出さない) ----
  // 体と心の状態。毎回必ず返す。lang: 'ja' (2B と記録) | 'en' (Jev)。同じ値から両方の言葉を作る
  words({ lang = 'ja' } = {}) {
    const L = (ja, en) => (lang === 'en' ? en : ja);
    const v = this.v;
    const out = [];
    const h = v.hunger;
    out.push(h < 0.2 ? L('お腹は空いていない', 'not hungry') : h < 0.45 ? L('少しお腹が空いた', 'a little hungry') : h < 0.7 ? L('お腹が空いた', 'hungry') : L('お腹がぺこぺこ', 'starving'));
    if (h >= 0.5 && this.lastAte == null && this.lastTime != null) out.push(L('ここに来てから何も食べていない', 'have eaten nothing since arriving here'));
    else if (h >= 0.5 && this.lastTime != null && this.lastAte != null && this.lastTime - this.lastAte >= 8000) out.push(L('長いこと何も食べていない', 'have not eaten for a long time'));
    const nights = this.missedNights;
    if (nights >= 2) out.push(L(`${KANJI[Math.min(10, nights)]}晩ちゃんと寝ていない`, `have not slept properly for ${nights >= 4 ? 'many' : 'several'} nights`));
    else if (nights === 1) out.push(L('昨夜は寝られなかった', 'could not sleep last night'));
    const sl = v.sleep;
    out.push(sl < 0.3 ? L('眠くない', 'not sleepy') : sl < 0.55 ? L('少し眠い', 'a little sleepy') : sl < 0.8 ? L('眠い', 'sleepy') : L('眠くてたまらない', 'desperately sleepy'));
    out.push(this.safetyWords({ lang }));
    out.push(...this.ant.words({ lang })); // 先のつらさ (夜・この先の食べ物)
    const e = this.effective();
    const hi = [
      ['connection', ['誰かと一緒に何かしたい', 'ひとりぼっちで寂しい'], ['want to do something together with someone', 'lonely, all by myself']],
      ['recognition', ['誰かに頼られたい', '誰にも認められていない気がする'], ['want someone to rely on me', 'feel that nobody appreciates me']],
      ['curiosity', ['知らない所が気になる', '知らない所を見てみたくてうずうずする'], ['curious about unknown places', 'itching to see places I have never been']],
      ['greed', ['もっと物が欲しい', '持ち物が少なくて落ち着かない'], ['want more things', 'uneasy about having so few things']],
      ['care', ['誰かの役に立ちたい', '誰の役にも立てていなくてもどかしい'], ['want to help someone', 'frustrated at not helping anyone']],
    ].filter(([k]) => e[k] >= 0.35).sort((a, b) => e[b[0]] - e[a[0]]).slice(0, 2);
    for (const [k, ja, en] of hi) out.push((lang === 'en' ? en : ja)[e[k] >= 0.65 ? 1 : 0]);
    const S = this.stress;
    if (S >= 0.2) out.push(S < 0.45 ? L('気が張っている', 'tense') : S < 0.7 ? L('かなり参っている', 'quite worn down') : L('もう限界に近い', 'close to the breaking point'));
    return out.filter(Boolean).join(lang === 'en' ? '; ' : '。');
  }

  safetyWords({ lang = 'ja' } = {}) {
    const en = lang === 'en';
    const a = this.v.safety;
    const why = this.reasons.slice(0, 2).map((r) => (en ? r.en || r.text : r.text));
    if (a < 0.25) {
      const ok = this.comfort.filter((x) => x.key !== 'bright').slice(0, 1).map((x) => (en ? x.en || x.text : x.text));
      if (en) return ok.length ? `feel safe because ${ok[0]}` : 'calm';
      return ok.length ? `${ok[0]}ので安心している` : '落ち着いている';
    }
    if (en) {
      const w = a < 0.5 ? 'a little uneasy' : a < 0.75 ? 'uneasy' : 'scared';
      return why.length ? `${w} because ${why.join(' and ')}` : w;
    }
    const reason = why.length ? `${why.join('し、')}ので` : '';
    return `${reason}${a < 0.5 ? '少し落ち着かない' : a < 0.75 ? '落ち着かない' : '怖い'}`;
  }

  // 欲求ごとのつらさの点 (worst と、ゴールを選ぶときの重み)。大きいほどつらい
  distress(k) {
    const e = this.effective();
    const w = this.cfg.stress.weights;
    return (e[k] / this.threshold(k)) * (w[k] ?? 0.3) * (1 + this.unmet[k] / this.cfg.stress.T);
  }

  // いちばんつらいこととその理由 (ゴール作りに渡す)。{ need, label, text } | null
  worst() {
    const e = this.effective();
    const k = [...NEEDS].sort((a, b) => this.distress(b) - this.distress(a))[0];
    if (!k || e[k] < this.threshold(k) * 0.6) return null;
    return { need: k, label: NEED_LABEL[k], text: this.whyText(k) };
  }

  // つらい順の上位 n 個 [{ need, distress, ratio (しきい値に対する割合), text, textEn }]。ratio が minRatio 未満のものは入れない
  pressing({ n = 3, minRatio = 0.6 } = {}) {
    const e = this.effective();
    return [...NEEDS].map((k) => ({ need: k, distress: r3(this.distress(k)), ratio: r3(e[k] / this.threshold(k)) }))
      .filter((x) => x.ratio >= minRatio).sort((a, b) => b.distress - a.distress).slice(0, n)
      .map((x) => ({ ...x, text: this.whyText(x.need), textEn: this.whyText(x.need, { lang: 'en' }) }));
  }

  whyText(k, { lang = 'ja' } = {}) {
    const L = (ja, en) => (lang === 'en' ? en : ja);
    const v = this.v;
    if (k === 'hunger') {
      const long = this.lastAte == null ? L('ここに来てから何も食べていない', 'have eaten nothing since arriving here') : this.lastTime - this.lastAte >= 8000 ? L('長いこと何も食べていない', 'have not eaten for a long time') : '';
      return [v.hunger >= 0.7 ? L('お腹がぺこぺこ', 'starving') : L('お腹が空いた', 'hungry'), long].filter(Boolean).join(L('。', '; '));
    }
    if (k === 'sleep') {
      const n = this.missedNights;
      const nights = n >= 2 ? L(`${KANJI[Math.min(10, n)]}晩ちゃんと寝ていない`, `have not slept properly for ${n >= 4 ? 'many' : 'several'} nights`) : n === 1 ? L('昨夜は寝られなかった', 'could not sleep last night') : '';
      return [nights, v.sleep >= 0.8 ? L('眠くてたまらない', 'desperately sleepy') : L('眠い', 'sleepy')].filter(Boolean).join(L('。', '; '));
    }
    if (k === 'safety') return this.safetyWords({ lang });
    const e = this.effective();
    const t = {
      connection: e.connection >= 0.65 ? L('ずっと誰とも一緒に何もしていなくて寂しい', 'lonely; have not done anything with anyone for a long time') : L('誰かと一緒に何かしたい', 'want to do something together with someone'),
      recognition: e.recognition >= 0.65 ? L('誰にも頼られず、認められていない気がする', 'nobody relies on me; I feel unappreciated') : L('誰かに頼られたい', 'want someone to rely on me'),
      curiosity: L('知らない所を見てみたい', 'want to see places I have never been'),
      greed: L('持ち物が少なくて落ち着かない', 'uneasy about having so few things'),
      care: L('誰の役にも立てていなくてもどかしい', 'frustrated at not helping anyone'),
    };
    return t[k];
  }

  // 先のつらさの上位 (ゴールの選び方)。[{ need: 'night'|'food', later: true, distress, ratio, text, textEn }]
  later(o = {}) { return this.ant.later(o); }

  // 数値 (記録用)。ant: 先のつらさ (night・food と、夜までの tick・見込み・備え・経験・食べ物の回数)
  values() { const e = this.effective(); return { ...this.v, eff: Object.fromEntries(NEEDS.map((k) => [k, r3(e[k])])), stress: this.stress, missedNights: this.missedNights, ant: this.ant.values() }; }
}

// 人ごとの設定: cfg.needs (全員) に persona.needs (人ごと) を重ねる
function needsConfig(cfg = {}, persona = {}) { return merge(merge({}, cfg.needs || {}), persona.needs || {}); }

module.exports = { hungerFromFood, foodSaturation, NEED_EN, Needs, NEEDS, BASIC, HIGHER, NEED_LABEL, LABEL_TO_NEED, NEEDS_DEFAULTS, senseShelter, effectiveLight, foodPoints, needsConfig, merge };
