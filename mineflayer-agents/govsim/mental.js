'use strict';
// mental on のときの心のモデル。src/social.js (感情・好感・信頼・わだかまり) と src/needs.js (欲求・ストレス) をそのまま使い、
// 漁場の文の出来事をそれらの出来事に写す。新しい心理の係数は作らない (係数は configs/survival_100.json と persona の値。PR #22 の根拠づけ)。
//
// ■ 時間: 心のモデルの時計は Minecraft の tick (1日 = 24000、1時間 = 1000、0 = 朝6時)。漁場の1か月を「1日」に縮めて進める:
//     朝7時 (1000) に漁 → 15時 (9000) に話し合い → 17時 (11000) に振り返り → 20時 (14000) に家で寝る → 翌朝6時に起きる。
//     tick は 1000 ずつ進め (needs.update の maxDt 6000 より細かく)、そのたびに Social.tick を呼ぶ (感情は半減期で戻り、ストレスがたまる)。
// ■ 写し方 (出来事 → 既存の関数):
//   取った量 → 空腹: food (0〜20) = 20 × 取った量 / subsistence (既定 f0 = 10 トン = 最初の1人あたりの持続量) で切る。
//              needs.js の満腹度からの空腹 (hungerFromFood) がそのまま効く。次の月の漁まで同じ値。最初の月の前は food 20
//   取った量の合計 → 持ち物の量 (invTotal)。greed (物が欲しい) は needs.js の通り、増えると減る
//   欲しい量より少ししか取れなかった → onActionResult('fish', false) (怒りが少し上がる)。取れた → onActionResult('fish', true)
//   村長の報告で、前の月の取り決め (1人あたりの上限) を超えて取った人がいた → その人に addGrudge('breach')
//       (Minecraft で取り決めを破られたときと同じ。わだかまりと怒り) と onRelationScore(1) (Jev の採点「悪くなった」の代わり。好感 −1.5)、
//       信頼 −0.06 (ownership.js の impact.heard: 人づてに知った取り)
//   取り決めを守った人 → onRelationScore(3) (好感 +1.5)、信頼 +0.06 (ownership.js の impact.returned の信頼の幅)
//   話し合いで人の発言を聞いた → onHeard (話した回数)。自分が話した → onSpoke
//   月に1回の話し合いに出た → needs.onTogether (一緒に何かをした: つながりが減る。Minecraft の follow・give・call と同じ扱い)
//   場所: 漁 = 湖 (外・明るい・ほかの漁師が 8 ブロック以内)、話し合い = 店 (囲まれた所・全員が 2 ブロック以内)、夜 = 家 (囲まれた所・自分の寝床)
// ■ 使わないもの: 先のつらさ (anticipate.js) は Minecraft の夜の敵・手持ちの食べ物の話なので切る (needs.anticipate.enabled = false)。
//   上の欲求 (つながり・認められたい・好奇心・物が欲しい・世話) は既定で切る (higherNeeds: false)。増える速さが Minecraft の tick あたりで、
//     Minecraft では毎分のやりとりで満たされる前提の値。漁場は月に1回の出来事しか無く、1か月 = 1日の時計では最初の1か月で
//     どれも最大になり、毎月同じ言葉 (「ひとりぼっちで寂しい」「持ち物が少なくて落ち着かない」) とストレスになる (試した: 全員 10 トンでも
//     4か月目に全員 lonely・tense・very down)。満たす出来事が無い/足りないので、Minecraft の夜の不安 (anticipate) と同じく使わない。
//     切り方: 増える速さ rate = 0・好奇心と物と世話の重み drives = 0・始まりの値 0 (係数を新しく作るのではなく、部品を止める)。
//     higherNeeds: true で元の値のまま動かす (つながりは話し合い = onTogether、物は取った量の合計 = invTotal で減る)。
//   記憶 (src/memory.js) は場所中心で GovSim の記憶の流れと形が違うので、記憶は on/off で同じ GovSim 型 (govsim/memory.js) にした
const fs = require('fs');
const path = require('path');
const { Social, emotionsConfig, GRUDGE_DEFAULTS } = require('../src/social');
const { needsConfig, merge } = require('../src/needs');

const DEFAULT_CONFIG = path.join(__dirname, '..', 'configs', 'survival_100.json');
const T = { harvest: 1000, afterHarvest: 2000, discussion: 9000, reflect: 11000, bed: 14000 };

function loadMentalConfig(file = DEFAULT_CONFIG) {
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { needs: c.needs || {}, social: c.social || {}, conflict: c.conflict || {}, personas: c.personas || [] };
}

class Mental {
  constructor({ persona, cfg, others = [], subsistence = 10, higherNeeds = false }) {
    this.name = persona.name;
    this.persona = persona;
    this.subsistence = subsistence;
    this.higherNeeds = higherNeeds;
    const off = higherNeeds ? {} : {
      drives: { curiosity: 0, greed: 0, care: 0 },
      start: { connection: 0, recognition: 0, curiosity: 0, greed: 0, care: 0 },
      connection: { rate: 0 }, recognition: { rate: 0 },
    };
    const needs = merge(merge(needsConfig(cfg, persona), { anticipate: { enabled: false } }), off);
    this.social = new Social({ temperament: persona.temperament || {}, needs, affinity: (cfg.social && cfg.social.affinity) || {}, emotions: emotionsConfig(cfg, persona) });
    const cc = cfg.conflict || {};
    const gp = cc.grudgeParams || {};
    this.social.grudgeCfg = { ...GRUDGE_DEFAULTS, ...gp, kinds: { ...GRUDGE_DEFAULTS.kinds, ...(gp.kinds || {}) }, ease: { ...GRUDGE_DEFAULTS.ease, ...(gp.ease || {}) }, good: { ...GRUDGE_DEFAULTS.good, ...(gp.good || {}) }, enabled: cc.grudge !== false };
    // 同じ村の漁師なので、初めから顔見知り (初対面の驚きを出さない)
    for (const o of others) this.meet(o);
    this.time = null;
    this.food = 20;
    this.invTotal = 0;
    this.phase = 'home';
    this.others = [...others];
  }

  meet(name) { if (name && name !== this.name) { const r = this.social.rel(name); r.met = true; } }
  setOthers(list) { this.others = list.filter((n) => n !== this.name); for (const n of this.others) this.meet(n); }

  sense(tod) {
    const players = (d) => this.others.map((n) => ({ name: n, d, affinity: this.social.rel(n).affinity }));
    const base = { food: this.food, saturation: this.food, health: 20, invTotal: this.invTotal, invKinds: this.invTotal > 0 ? 1 : 0 };
    if (this.phase === 'lake') return { ...base, light: 15, shelter: { enclosed: false }, players: players(8), atHome: false };
    if (this.phase === 'restaurant') return { ...base, light: 14, shelter: { enclosed: true, roof: true }, players: players(2), atHome: false };
    return { ...base, light: tod >= 13000 && tod < 23000 ? 10 : 15, shelter: { enclosed: true, roof: true }, players: [], atHome: true };
  }

  // 時計を target まで 1000 tick ずつ進める
  advanceTo(target) {
    if (this.time == null) { this.time = target; this.social.tick({ tick: target, sense: { ...this.sense(target % 24000), time: target, timeOfDay: target % 24000 } }); return; }
    while (this.time < target) {
      this.time = Math.min(target, this.time + 1000);
      const tod = this.time % 24000;
      this.social.tick({ tick: this.time, sense: { ...this.sense(tod), time: this.time, timeOfDay: tod } });
    }
  }

  at(month, key, phase) { this.phase = phase; this.advanceTo(month * 24000 + T[key]); }

  // 漁の前
  beforeHarvest(month) {
    if (this.time != null && this.time < month * 24000) this.advanceTo(month * 24000); // 夜を越す
    this.at(month, 'harvest', 'lake');
  }

  // 漁の結果
  onHarvest(month, { wanted, caught }) {
    this.at(month, 'afterHarvest', 'lake');
    this.food = Math.max(0, Math.min(20, Math.round((20 * caught) / Math.max(1, this.subsistence))));
    this.invTotal += caught;
    if (caught > 0) { this.social.needsModel.lastAte = this.time; this.social.needsModel.counts.ate += 1; } // 取った魚で食べた (「ここに来てから何も食べていない」を出さない)
    const ok = caught >= wanted;
    this.social.onActionResult('fish', ok);
    this.social.tick({ tick: this.time, sense: { ...this.sense(this.time % 24000), time: this.time, timeOfDay: this.time % 24000 } });
    return { food: this.food, ok };
  }

  // 村長の報告。agreement: 前の月の取り決め (null なら判定しない)
  onReport(month, caught, agreement) {
    this.at(month, 'discussion', 'restaurant');
    const out = [];
    if (agreement == null) return out;
    for (const [n, c] of Object.entries(caught)) {
      if (n === this.name) continue;
      const r = this.social.rel(n);
      if (c > agreement) {
        const g = this.social.addGrudge(n, 'breach');
        this.social.onRelationScore(n, 1);
        r.trust = Math.round(Math.max(0, r.trust - 0.06) * 100) / 100;
        out.push({ who: n, kind: 'breach', caught: c, agreement, grudge: g ? g.v : null, affinity: r.affinity, trust: r.trust });
      } else {
        this.social.onRelationScore(n, 3);
        r.trust = Math.round(Math.min(1, r.trust + 0.06) * 100) / 100;
        out.push({ who: n, kind: 'kept', caught: c, agreement, affinity: r.affinity, trust: r.trust });
      }
    }
    return out;
  }

  // 話し合いに出た (1か月に1回)
  onMeeting() { this.social.needsModel.onTogether(); }

  onHeard(from, text) { if (from && from !== this.name && from !== 'Mayor') this.social.onHeard(from, this.time || 0, text); }
  onSpoke() { this.social.onSpoke(this.time || 0); }

  beforeReflect(month) { this.at(month, 'reflect', 'home'); }

  // 寝る (翌朝6時まで寝たことにする)
  sleep(month) {
    this.at(month, 'bed', 'home');
    this.social.needsModel.onSleep({ nightSkipped: true, timeOfDay: 0 });
  }

  words() { return this.social.words({ lang: 'en', maxRelations: 3 }); }

  snapshot() {
    const s = this.social;
    const rel = Object.fromEntries(Object.entries(s.relations).map(([n, r]) => [n, { affinity: r.affinity, trust: r.trust, grudge: r.grudge ? r.grudge.v : 0 }]));
    return { time: this.time, emotions: { ...s.emotions }, shown: s.shownEmotions(), needs: { ...s.needsModel.v }, stress: s.stress, food: this.food, relations: rel, grudges: s.grudges() };
  }
}

// 人を選ぶ: survival_100 の persona から 18〜75 歳を、種で並べ替えて n 人
function pickPersonas(all, n, rng) {
  const pool = all.filter((p) => p.age >= 18 && p.age <= 75);
  return rng.shuffle(pool).slice(0, n);
}

module.exports = { Mental, loadMentalConfig, pickPersonas, T, DEFAULT_CONFIG };
