#!/usr/bin/env node
'use strict';
// 欲求とストレスのシミュレーション (bot なし)。ゲームの時間を進めて、食べない・寝ない・夜に外 でどう変わるかを見る。
//   node tools/sim_needs.js [--days 1] [--step 200] [--persona Taro] [--config configs/survival_3days.json] [--json]
//   step: 1判断で進むゲームの tick (等倍で 200 tick = 10秒)。表はゲームの2時間 (2000 tick) ごと
//   空腹はマイクラの満腹度から (needs.js)。ここでは満腹度もまねる: 動いている間は疲れ (exhaustion) がたまり、4 たまるごとに
//   隠し満腹度 (saturation)、それが0なら満腹度 (food) が1減る。昼は --exhaust (既定 4/280 tick ≈ 走りながら歩き回る)、
//   夜に起きている間はその nightRest 倍、ベッドで飛ばした夜は減らない。食べると foodPoints と saturation だけ増える
const path = require('path');
const { Social } = require('../src/social');
const { needsConfig, foodPoints, foodSaturation } = require('../src/needs');

// マイクラの満腹度のまね
class FoodSim {
  constructor({ food = 20, saturation = 5, exhaust = 4 / 280, nightRest = 0.25 } = {}) { Object.assign(this, { food, saturation, exhaust, nightRest, ex: 0 }); }
  tick(dt, { night = false } = {}) {
    this.ex += this.exhaust * (night ? this.nightRest : 1) * dt;
    while (this.ex >= 4) {
      this.ex -= 4;
      if (this.saturation > 0) this.saturation = Math.max(0, this.saturation - 1);
      else this.food = Math.max(0, this.food - 1);
    }
  }
  eat(item) { this.food = Math.min(20, this.food + foodPoints(item)); this.saturation = Math.min(this.food, this.saturation + foodSaturation(item)); }
}
const { loadConfig } = require('../src/config');

const SCENARIOS = {
  normal: { label: 'ふつう (お腹が空いたら食べる・夜はベッド・夜は囲まれた所・昼は人と一緒に動くことがある)', eat: true, bed: true, shelter: true, social: true },
  alone: { label: 'ひとり (食べる・寝る・安全だが、人と何もしない・何も作らない)', eat: true, bed: true, shelter: true, social: false, solo: true },
  noFood: { label: '食べない (ほかはふつう)', eat: false, bed: true, shelter: true, social: true },
  noSleep: { label: '寝ない (夜は囲まれた所で起きている。ほかはふつう)', eat: true, bed: false, shelter: true, social: true },
  nightOut: { label: '夜に外 (寝ない・夜は暗い外でゾンビが近い時間あり。ほかはふつう)', eat: true, bed: false, shelter: false, zombie: true, social: true },
  all: { label: '食べない・寝ない・夜に外', eat: false, bed: false, shelter: false, zombie: true, social: true },
};

function simulate(sc, { days = 1, step = 200, persona = {}, cfg = {}, exhaust = 4 / 280 } = {}) {
  const s = new Social({ temperament: persona.temperament, needs: needsConfig(cfg, persona) });
  const fs = new FoodSim({ exhaust });
  const rows = [];
  let age = 0; let tod = 0; let lastEat = -1e9; let inv = 3;
  const end = days * 24000;
  let nextRow = 0;
  while (age <= end) {
    const night = tod >= 13000 && tod < 23000;
    const zombie = sc.zombie && tod >= 15000 && tod < 20000;
    const enclosed = night && sc.shelter;
    const players = !night && !sc.solo ? [{ name: 'Hanako', d: tod % 6000 < 2000 ? 5 : 30, affinity: 60 }] : [];
    // ふつうの一日: 昼のあいだ、ゲームの1.5時間ごとに何か作り、2時間ごとに知らない所へ行く
    const awake = !night || !sc.bed;
    const newCell = sc.social && !night && age % 2000 === 0 && age > 0;
    if (sc.social && awake && age % 1500 === 0 && age > 0) s.onActionNeeds('craft', 'stick', { ok: true });
    if (sc.social && !night && age % 1000 === 0) inv += 5; // 昼のあいだ、少しずつ物が増える (ゲームの1時間に5個)
    s.tick({ tick: age / step, raw: { self: { timeOfDay: tod, health: 20 }, entities: [...players.map((p) => ({ kind: 'player', ...p })), ...(zombie ? [{ kind: 'hostile', name: 'zombie', d: 6 }] : [])], inventory: [{ name: 'bread', count: inv }] },
      sense: { time: age, timeOfDay: tod, food: fs.food, saturation: fs.saturation, light: night ? (enclosed ? 10 : 3) : 15, shelter: { enclosed, roof: enclosed }, atHome: enclosed, unfamiliar: false, players, newCell } });
    // 食べる: お腹が空いたら (前に食べてからゲームの1時間はあける)
    if (sc.eat && s.needs.hunger >= 0.45 && age - lastEat >= 1000) { s.onActionNeeds('eat', 'bread', { ok: true }, age / step); fs.eat('bread'); lastEat = age; }
    // 人と: 昼のあいだ、ゲームの3時間ごとに一緒に動き (follow)、6時間ごとに物をあげる
    if (sc.social && !night && age % 3000 === 0 && age > 0) s.onActionNeeds('follow', 'Hanako', { ok: true });
    if (sc.social && !night && age % 6000 === 0 && age > 0) s.onActionNeeds('give', 'Hanako:bread:1', { ok: true }, age / step);
    if (sc.social && !night && age % 4000 === 2000) s.onAsked('Hanako', true, age / step); // ゲームの4時間ごとに聞かれて答える
    if (age >= nextRow) {
      const v = s.needs;
      rows.push({ hour: Math.round(age / 100) / 10, tod, food: fs.food, saturation: Math.round(fs.saturation * 10) / 10, ...Object.fromEntries(['hunger', 'sleep', 'safety', 'connection', 'recognition'].map((k) => [k, v[k]])),
        drives: Math.max(v.curiosity, v.greed, v.care), stress: v.stress, missedNights: v.missedNights,
        emo: { anger: s.emotions.anger, sadness: s.emotions.sadness, fear: s.emotions.fear }, words: s.words({ relations: false }) });
      nextRow += 2000;
    }
    // ベッド: 夜になってすぐ寝る → 朝まで飛ぶ (通しの時間は進まない)
    if (sc.bed && night && tod >= 13500) { s.onActionNeeds('sleep', 'red_bed', { ok: true, sleep: { slept: true, nightSkipped: true } }); tod = 0; continue; }
    fs.tick(step, { night });
    age += step; tod = (tod + step) % 24000;
  }
  return rows;
}

function main() {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
  const cfg = loadConfig(path.resolve(opt('config', path.join(__dirname, '..', 'configs', 'survival_3days.json'))));
  const pname = opt('persona', null);
  const persona = (cfg.personas || []).find((p) => p.name === pname) || { temperament: {} };
  const days = Number(opt('days', 1)); const step = Number(opt('step', 200)); const ex = String(opt('exhaust', '4/280')).split('/').map(Number); const exhaust = ex.length === 2 ? ex[0] / ex[1] : ex[0];
  const out = {};
  for (const [k, sc] of Object.entries(SCENARIOS)) out[k] = { label: sc.label, rows: simulate(sc, { days, step, persona, cfg, exhaust }) };
  if (args.includes('--json')) { console.log(JSON.stringify(out, null, 2)); return; }
  for (const [k, o] of Object.entries(out)) {
    console.log(`\n## ${k}: ${o.label}${pname ? ` (${pname})` : ''}`);
    console.log('時間  満腹度 隠し 空腹  眠気  不安  つながり 認められ 性格 ストレス 怒 悲 恐 | 言葉');
    for (const r of o.rows) {
      const f = (x) => x.toFixed(2);
      console.log(`${String(r.hour).padStart(4)}h ${String(r.food).padStart(4)} ${String(r.saturation).padStart(4)}  ${f(r.hunger)} ${f(r.sleep)} ${f(r.safety)} ${f(r.connection)}     ${f(r.recognition)}     ${f(r.drives)} ${f(r.stress)}   ${r.emo.anger.toFixed(1)} ${r.emo.sadness.toFixed(1)} ${r.emo.fear.toFixed(1)} | ${r.words}`);
    }
  }
}

if (require.main === module) main();
module.exports = { simulate, SCENARIOS };
