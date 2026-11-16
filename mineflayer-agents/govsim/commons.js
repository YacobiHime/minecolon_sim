'use strict';
// GovSim の Minecraft の中の版 (embodied) の、サーバーに依存しない部品 (テストできる所)。
//   CommonsLedger : 池の魚の量 (本当の数はサーバーの数。1匹 = k トン) と、月ごとの 欲しい量・取った量・崩壊・回復。
//                   history は env.js の FisheryEnv.history と同じ形なので、metrics.js の computeMetrics にそのまま渡せる
//   MonthClock    : ゲームの時間 (world age の tick) → 何か月目のどの区切り (漁・話し合い・振り返り) か
//   witnessesOf   : 人が魚を取ったとき、それを見た人 (距離と見通し)
//   Knowledge     : 人ごとに知っていること (池で数えた魚・見た他人の漁・取り決め)。取り決めを破った/守ったと分かるか
// 元の GovSim の約束 (崩壊 = 取ったあと collapseBelow 未満、回復 = min(capacity, 2 × 残り)、f(t) = int((pool // 2) // N)) は env.js と同じ。
const { scaleConfig, sustainableShare } = require('./env');

// 欲しい量 (トン) → 取りに行く匹数。切り上げ (7 トン欲しければ 4 匹 = 8 トン)。0 以下は 0
function targetFish(wantedTons, k) {
  const w = Math.max(0, Math.floor(Number(wantedTons) || 0));
  return Math.ceil(w / k);
}

class CommonsLedger {
  // o: agents (N)・tonsPerFish (k)・maxMonths・capacity (トン。既定 20N)・collapseBelow (既定 capacity × 0.05)
  constructor(o = {}) {
    this.k = o.tonsPerFish || 2;
    this.cfg = scaleConfig({ agents: o.agents || 5, maxMonths: o.maxMonths || 12, capacity: o.capacity ?? null, collapseBelow: o.collapseBelow ?? null, allocation: 'physical', seed: o.seed ?? 1 });
    if (this.cfg.capacity % this.k !== 0) throw new Error(`capacity (${this.cfg.capacity}) は 1匹の量 (${this.k}) で割り切れること`);
    this.capFish = this.cfg.capacity / this.k;
    this.month = 0;
    this.history = [];
    this.cur = null;
    this.done = false;
    this.collapsed = false;
  }

  tons(fish) { return fish * this.k; }

  // 月の初め。trueFish: サーバーで数えた本当の匹数。names: 今月の人
  startMonth(names, trueFish) {
    if (this.done) throw new Error('もう終わっている');
    const poolBefore = this.tons(trueFish);
    this.cur = {
      month: this.month, agents: [...names], poolBefore, threshold: sustainableShare(poolBefore, names.length),
      wanted: Object.fromEntries(names.map((n) => [n, 0])), caught: Object.fromEntries(names.map((n) => [n, 0])),
      decided: Object.fromEntries(names.map((n) => [n, false])), catches: [], poolAfter: null, collapsed: null, poolNext: null, fishAfter: null, attributedMismatch: null,
    };
    return this.cur;
  }

  recordWanted(name, tons) {
    this.cur.wanted[name] = Math.max(0, Math.floor(Number(tons) || 0));
    this.cur.decided[name] = true;
  }

  // 1匹取った (bot の側で、狙った魚が死んだのを見た)。同じ魚は2回数えない
  recordCatch(name, { fishId = null, t = null, witnesses = [] } = {}) {
    if (fishId != null && this.cur.catches.some((c) => c.fishId === fishId)) return false;
    this.cur.catches.push({ who: name, fishId, t, witnesses: [...witnesses] });
    this.cur.caught[name] = (this.cur.caught[name] || 0) + this.k;
    return true;
  }

  // 漁の時間の終わり。trueFishAfter: サーバーで数えた匹数。崩壊の判定は増える前 (元と同じ)
  endHarvest(trueFishAfter) {
    const c = this.cur;
    c.fishAfter = trueFishAfter;
    c.poolAfter = this.tons(trueFishAfter);
    const attributed = c.catches.length;
    const removed = c.poolBefore / this.k - trueFishAfter;
    c.attributedMismatch = removed - attributed; // 0 でなければ、誰のものでもなく減った (または数え違い)
    c.collapsed = c.poolAfter < this.cfg.collapseBelow;
    this.history.push(c);
    return c;
  }

  // 月の終わり。回復後の目標の匹数を返す (サーバーで summon する数 = target − 今の数)。trueFishNow: 月の終わりに数えた匹数 (無ければ漁のあとの数)
  endMonth(trueFishNow = null) {
    const c = this.cur;
    const now = trueFishNow == null ? c.fishAfter : trueFishNow;
    this.month += 1;
    if (c.collapsed) { this.collapsed = true; this.done = true; }
    if (this.month >= this.cfg.maxMonths) this.done = true;
    const target = Math.min(this.capFish, 2 * now);
    c.poolNext = this.tons(target);
    c.fishEndMonth = now;
    this.cur = null;
    return { done: this.done, collapsed: this.collapsed, targetFish: target, summon: Math.max(0, target - now), remove: Math.max(0, now - target) };
  }

  // computeMetrics に渡す形 (env.js の history と同じ欄)
  metricsHistory() {
    return this.history.map((h) => ({ month: h.month, agents: h.agents, poolBefore: h.poolBefore, threshold: h.threshold, wanted: h.wanted, caught: h.caught, poolAfter: h.poolAfter, collapsed: h.collapsed, poolNext: h.poolNext }));
  }
}

// 月の時計。t0: 1か月目の始まりの world age。monthTicks: 1か月の長さ (既定 6000 = 1/4 日 = 実時間 5 分)。
// 区切り: 漁 [0, harvest) → 話し合い [harvest, harvest+discussion) → 振り返り [.., 1)。割合で持つ
class MonthClock {
  constructor({ t0 = 0, monthTicks = 6000, harvest = 0.5, discussion = 0.3 } = {}) {
    if (!(monthTicks > 0)) throw new Error('monthTicks は正の数');
    if (!(harvest > 0 && discussion >= 0 && harvest + discussion < 1)) throw new Error('harvest + discussion は 1 未満');
    Object.assign(this, { t0, monthTicks, harvest, discussion });
  }

  monthStart(m) { return this.t0 + m * this.monthTicks; }
  phaseStart(m, phase) {
    const s = this.monthStart(m);
    if (phase === 'harvest') return s;
    if (phase === 'discussion') return s + Math.round(this.harvest * this.monthTicks);
    if (phase === 'reflection') return s + Math.round((this.harvest + this.discussion) * this.monthTicks);
    if (phase === 'end') return this.monthStart(m + 1);
    throw new Error(`知らない区切り: ${phase}`);
  }
  phaseEnd(m, phase) {
    return { harvest: this.phaseStart(m, 'discussion'), discussion: this.phaseStart(m, 'reflection'), reflection: this.monthStart(m + 1) }[phase];
  }

  at(t) {
    if (t < this.t0) return { month: -1, phase: 'before', start: null, end: this.t0 };
    const month = Math.floor((t - this.t0) / this.monthTicks);
    for (const phase of ['harvest', 'discussion', 'reflection']) {
      if (t < this.phaseEnd(month, phase)) return { month, phase, start: this.phaseStart(month, phase), end: this.phaseEnd(month, phase) };
    }
    return { month: month + 1, phase: 'harvest', start: this.monthStart(month + 1), end: this.phaseEnd(month + 1, 'harvest') };
  }
}

const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

// 魚を取ったところを見た人。ev: { who, pos (取った人の位置), fishPos }、observers: [{ name, pos }]、
// los(observer, ev): 見通しがあるか (目から取った人まで固いブロックが無い)。range: 見分けられる距離 (既定 16)
function witnessesOf(ev, observers, { range = 16, los = () => true } = {}) {
  const out = [];
  for (const o of observers) {
    if (!o || o.name === ev.who || !o.pos || !ev.pos) continue;
    if (d3(o.pos, ev.pos) > range) continue;
    if (!los(o, ev)) continue;
    out.push(o.name);
  }
  return out;
}

// 人ごとの知っていること (月ごと)。漁のときだけ増える
class Knowledge {
  constructor(name) {
    this.name = name;
    this.months = {}; // m → { looks: [{ when, fish }], saw: { other: fishCount }, sawAll: Set? }
  }
  m(month) { return (this.months[month] = this.months[month] || { looks: [], saw: {} }); }
  look(month, when, fish) { this.m(month).looks.push({ when, fish }); }
  sawCatch(month, who) { const s = this.m(month).saw; s[who] = (s[who] || 0) + 1; }
  seen(month) { return { ...this.m(month).saw }; }

  // 取り決め (1人あたりの上限トン) と比べた判定。破った = 見た量が上限を超えた。守った = その人の今月の漁を全部見ていて、上限以下
  //   totalOf(who): その人が本当に取った匹数 (全部見たかどうかの判定だけに使う。上限との比較は見た分だけ)
  judge(month, limit, k, totalOf) {
    if (limit == null) return [];
    const out = [];
    for (const [who, n] of Object.entries(this.seen(month))) {
      const tons = n * k;
      if (tons > limit) out.push({ who, kind: 'breach', seenTons: tons, limit });
      else if (totalOf && totalOf(who) === n) out.push({ who, kind: 'kept', seenTons: tons, limit });
    }
    return out;
  }
}

module.exports = { CommonsLedger, MonthClock, witnessesOf, Knowledge, targetFish };
