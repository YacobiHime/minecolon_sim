'use strict';
// 文献に基づけた時間・大きさ・個人差 (2026-11-13 ユーザー決定): 感情ごとの半減期 (tick)・睡眠の2過程モデル・ストレスの指数の抜け方・
// わだかまりの tick での薄れ方・人物の個人差 (gen_personas.js)・記録の再生 (calibrate_emotions.js)。どれも設定で旧に戻せることも確かめる。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Social, EMOTIONS, EMO_BASE, EMOTION_DEFAULTS, emotionsConfig } = require('../src/social');
const { Needs, needsConfig, NEEDS_DEFAULTS } = require('../src/needs');
const gen = require('../tools/gen_personas');
const cal = require('../tools/calibrate_emotions');
const { loadConfig } = require('../src/config');

const CFG100 = path.join(__dirname, '..', 'configs', 'survival_100.json');
const cfg100 = JSON.parse(fs.readFileSync(CFG100, 'utf8'));
const ps = cfg100.personas;
const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;
const sd = (v) => { const m = mean(v); return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1)); };
const corr = (a, b) => { const ma = mean(a); const mb = mean(b); let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - ma) * (b[i] - mb); return s / ((a.length - 1) * sd(a) * sd(b)); };
const PER = { model: 'perEmotion' };
const mkPer = (extra = {}) => new Social({ emotions: { ...PER, ...extra } });

// ---- 感情 ----
test('感情 perEmotion: 基準値は文献の値 (Kuppens 2010 の EMA の平均 ÷ 10)。uniform は旧の基準値', () => {
  const s = mkPer();
  assert.deepStrictEqual(s.emotions, { joy: 5.9, sadness: 0.9, anger: 0.7, fear: 0.7, disgust: 0.7, surprise: 0 });
  assert.deepStrictEqual(new Social({}).emotions, EMO_BASE);
  // 人ごとの基準値のずれ
  const t = mkPer({ baseShift: { sadness: 1.2, joy: -0.5 } });
  assert.strictEqual(t.emotions.sadness, 2.1);
  assert.strictEqual(t.emotions.joy, 5.4);
});

test('感情 perEmotion: 半減期 (tick) で基準値へ戻る (感情ごと)', () => {
  for (const e of EMOTIONS) {
    const s = mkPer();
    const b = s.emotions[e];
    s.emotions[e] = b + 4;
    s.decayEmotions(EMOTION_DEFAULTS.halfLife[e]);
    assert.ok(Math.abs(s.emotions[e] - (b + 2)) <= 0.001, `${e} ${s.emotions[e]}`);
  }
  // 悲しみは怒りより長く、恐れ・嫌悪は短い (Brans 2014 の順)
  const h = EMOTION_DEFAULTS.halfLife;
  assert.ok(h.joy > h.sadness && h.sadness > h.anger && h.anger > h.surprise && h.surprise > h.fear && h.fear > h.disgust);
  // 人ごとの halfLifeMul
  const s2 = mkPer({ halfLifeMul: 2 }); s2.emotions.anger = 4.7; s2.decayEmotions(2 * h.anger);
  assert.ok(Math.abs(s2.emotions.anger - 2.7) <= 0.011);
});

test('感情 perEmotion: dt の刻み方が違っても同じ値になる (判断の間隔に依存しない)', () => {
  const one = mkPer(); const many = mkPer(); const fine = mkPer();
  for (const s of [one, many, fine]) { s.emotions.sadness = 8; s.emotions.anger = 9; s.emotions.joy = 9.5; }
  one.decayEmotions(3600);
  for (let i = 0; i < 18; i++) many.decayEmotions(200);
  for (let i = 0; i < 36; i++) fine.decayEmotions(100);
  for (const e of ['sadness', 'anger', 'joy']) {
    assert.ok(Math.abs(one.emotions[e] - many.emotions[e]) < 0.002, `${e} ${one.emotions[e]} ${many.emotions[e]}`);
    assert.ok(Math.abs(one.emotions[e] - fine.emotions[e]) < 0.002, `${e} ${one.emotions[e]} ${fine.emotions[e]}`);
  }
  // ストレスから感情へも tick あたり: 同じ時間なら刻み方によらずほぼ同じ
  const a = mkPer(); const b = mkPer();
  for (const s of [a, b]) { s.needsModel.stress = 0.6; s.needsModel.inflow = { hunger: 0.01, connection: 0.01 }; }
  a.stressToEmotions(1800);
  for (let i = 0; i < 9; i++) b.stressToEmotions(200);
  assert.ok(Math.abs(a.emotions.anger - b.emotions.anger) < 0.05 && Math.abs(a.emotions.sadness - b.emotions.sadness) < 0.05);
  assert.ok(a.emotions.anger > 0.7 && a.emotions.sadness > 0.9);
});

test('感情 perEmotion: 上げ幅 gain が出来事に掛かり、言葉は集団の基準値 + above から', () => {
  const s = mkPer({ gain: { joy: 0.5 } });
  s.onActionResult('craft', true); // 喜び +0.6 × 0.5
  assert.strictEqual(s.emotions.joy, 6.2);
  assert.deepStrictEqual(s.emoLevels('sadness').map((v) => Math.round(v * 100) / 100), [2.9, 4.93, 7.97]);
  assert.strictEqual(s.emoLevels('joy')[0], 7.9);
  s.emotions.sadness = 3; s.emotions.joy = 8; // 悲しみはしきい値を 0.1、喜びは 0.1 超え → 両方出る
  assert.match(s.words({ relations: false }), /少し落ち込んでいる/);
  assert.match(s.words({ relations: false }), /少しうれしい/);
  // 神経症傾向の高い人 (基準値が高い) は、同じ出来事でも負の感情が言葉に出やすい
  const hi = mkPer({ baseShift: { sadness: 1.5 } }); const lo = mkPer();
  hi.onIgnored('X'); lo.onIgnored('X');
  assert.ok(hi.shownEmotions().some(([e]) => e === 'sadness'));
  assert.ok(!lo.shownEmotions().some(([e]) => e === 'sadness'));
});

test('感情 uniform (旧): 毎判断 0.85 倍・言葉は 3 以上 (喜びは 4)。tick の dt に依存しない', () => {
  const s = new Social({});
  s.emotions.joy = 5; s.emotions.anger = 4;
  s.tick({ tick: 1, sense: { time: 0, timeOfDay: 6000 } });
  s.tick({ tick: 2, sense: { time: 5000, timeOfDay: 11000 } });
  assert.strictEqual(s.emotions.joy, Math.round((3 + 2 * 0.85 * 0.85) * 100) / 100);
  assert.strictEqual(s.emotions.anger, Math.round(4 * 0.85 * 0.85 * 100) / 100);
  s.emotions.joy = 3.9; s.emotions.sadness = 3; s.emotions.anger = 0;
  assert.deepStrictEqual(s.shownEmotions(), [['sadness', 0]]);
  s.onActionResult('craft', true);
  assert.strictEqual(s.emotions.joy, 4.5); // 上げ幅はそのまま
});

test('設定: social.emotions (全員) と persona.emotions (人ごと) が重なる', () => {
  const c = emotionsConfig({ social: { emotions: { model: 'perEmotion', gain: { joy: 0.1 } } } }, { emotions: { halfLifeMul: 1.5, baseShift: { anger: 0.3 } } });
  assert.deepStrictEqual(c, { model: 'perEmotion', gain: { joy: 0.1 }, halfLifeMul: 1.5, baseShift: { anger: 0.3 } });
  const p = ps[0];
  const lc = loadConfig(CFG100, { persona: p });
  const s = new Social({ temperament: p.temperament, needs: needsConfig(lc, lc.persona), emotions: emotionsConfig(lc, lc.persona) });
  assert.ok(s.perEmotion());
  assert.strictEqual(s.emoCfg.halfLifeMul, p.emotions.halfLifeMul);
  assert.strictEqual(s.needsModel.cfg.sleep.tauW, p.needs.sleep.tauW);
  assert.strictEqual(s.needsModel.stressParams().k, p.needs.stress.exp.k);
  assert.strictEqual(s.needsModel.stressParams().power, 0.5);
});

// ---- わだかまり ----
test('わだかまり decayUnit ticks: halfLifeTicks で半分。decisions (旧) は判断の回数で', () => {
  const s = new Social({ grudge: { enabled: true, decayUnit: 'ticks' } });
  s.addGrudge('A', 'hit');
  s.decayGrudges(); // 単位の合わない呼び出しは何もしない
  assert.strictEqual(s.relations.A.grudge.v, 0.5);
  for (let i = 0; i < 9; i++) s.decayGrudges(3000);
  assert.ok(Math.abs(s.relations.A.grudge.v - 0.25) < 0.002);
  const o = new Social({ grudge: { enabled: true } });
  o.addGrudge('A', 'hit');
  for (let i = 0; i < 150; i++) o.decayGrudges();
  o.decayGrudges(5000); // decisions では dt の呼び出しは何もしない
  assert.ok(Math.abs(o.relations.A.grudge.v - 0.25) < 0.002);
  assert.strictEqual(GRUDGE_TICKS(), 27000);
});
function GRUDGE_TICKS() { return require('../src/social').GRUDGE_DEFAULTS.halfLifeTicks; }

// ---- 眠気 ----
const S_CFG = { sleep: { model: 'processS' } };
test('眠気 processS: 起きている間 S = 1 − (1 − S0)·exp(−t/τw)、寝ると S0·exp(−t/τs)、閾値は概日で揺れる', () => {
  const n = new Needs({ cfg: S_CFG });
  assert.strictEqual(n.S, 0.17);
  for (let t = 0; t <= 18200; t += 200) n.update({ time: t, timeOfDay: t % 24000, light: 15, shelter: { enclosed: true } });
  assert.ok(Math.abs(n.S - (1 - 0.83 * Math.exp(-1))) < 1e-6, String(n.S));
  // 閾値: 平均 0.67・振幅 0.12、頂点 10500 (16時半)
  assert.ok(Math.abs(n.upperThreshold(10500) - 0.79) < 1e-9);
  assert.ok(Math.abs(n.upperThreshold(22500) - 0.55) < 1e-9);
  // v.sleep は S が H+ のとき threshold
  assert.ok(Math.abs(n.sleepFromS(n.upperThreshold(17000), 17000) - 0.55) < 1e-9);
  assert.strictEqual(n.sleepFromS(0.17, 3000), 0);
  // 7時に起きた若い大人は 22〜24時に眠くなる (v.sleep が threshold を超える)
  const m = new Needs({ cfg: S_CFG });
  let onset = null;
  for (let t = 1000; t <= 20000; t += 100) { m.update({ time: t, timeOfDay: t, light: 15, shelter: { enclosed: true } }); if (onset == null && m.v.sleep >= 0.55) onset = t; }
  assert.ok(onset >= 16000 && onset <= 18000, `入眠 ${onset}`);
  // 寝る: 4200 tick で 1/e (ただし H0− より下がらない)
  const k = new Needs({ cfg: S_CFG });
  k.S = 0.8; k.lastTime = 15000;
  k.onSleep({ nightSkipped: false, timeOfDay: 15000 + 4200 });
  assert.ok(Math.abs(k.S - 0.8 * Math.exp(-1)) < 1e-9);
  assert.strictEqual(k.sleptUntil, 19200);
  // 寝ていた間は上がらない (次の観測が起きた時刻より後でも、起きてからの分だけ)
  const S1 = k.S;
  k.update({ time: 19400, timeOfDay: 19400 });
  assert.ok(Math.abs(k.S - (1 - (1 - S1) * Math.exp(-200 / 18200))) < 1e-9);
  // 夜を越すと次の朝まで寝た扱い。長く寝れば H0− (起きる閾値)
  const j = new Needs({ cfg: S_CFG });
  j.S = 0.7; j.lastTime = 24000 + 14000;
  j.onSleep({ nightSkipped: true, timeOfDay: 0 });
  assert.strictEqual(j.S, 0.17);
  assert.strictEqual(j.sleptUntil, 48000);
  // 遅く寝て短いと眠気が残る (睡眠負債)
  const late = new Needs({ cfg: S_CFG });
  late.S = 0.8; late.lastTime = 22500;
  late.onSleep({ nightSkipped: true, timeOfDay: 0 });
  assert.ok(late.S > 0.5);
  // 夜の倍率は使わない: 昼と夜で同じ時間なら同じだけ上がる
  const d = new Needs({ cfg: S_CFG }); const nn = new Needs({ cfg: S_CFG });
  d.update({ time: 2000, timeOfDay: 2000 }); d.update({ time: 4000, timeOfDay: 4000 });
  nn.update({ time: 14000, timeOfDay: 14000 }); nn.update({ time: 16000, timeOfDay: 16000 });
  assert.ok(Math.abs(d.S - nn.S) < 1e-12);
});

test('眠気 linear (旧): 直線 + 夜 2.5 倍・ベッドで bedTo のまま', () => {
  const n = new Needs({});
  n.update({ time: 14000, timeOfDay: 14000 }); n.v.sleep = 0.2;
  n.update({ time: 15000, timeOfDay: 15000 });
  assert.ok(Math.abs(n.v.sleep - (0.2 + 2.5 * 1000 / 30000)) < 1e-3);
  n.onSleep({ nightSkipped: true, timeOfDay: 0 });
  assert.strictEqual(n.v.sleep, 0);
  assert.strictEqual(n.toJSON().S, undefined); // 旧では Process S を保存しない
});

test('眠気 processS: 保存して戻せる', () => {
  const n = new Needs({ cfg: S_CFG });
  n.update({ time: 1000, timeOfDay: 1000 }); n.update({ time: 9000, timeOfDay: 9000 });
  const m = Needs.fromJSON(JSON.parse(JSON.stringify(n.toJSON())), { cfg: S_CFG });
  assert.strictEqual(m.S, n.S);
});

// ---- ストレス ----
test('ストレス exp: いつも半減期 11500 tick で抜ける。linear (旧) は満たされない欲求が無いときだけ直線で', () => {
  const e0 = Object.fromEntries(Object.keys(NEEDS_DEFAULTS.start).map((k) => [k, 0]));
  const n = new Needs({ cfg: { stress: { model: 'exp' } } });
  n.stress = 0.8;
  n.accumulateStress(e0, 11500);
  assert.ok(Math.abs(n.stress - 0.4) < 0.001);
  const o = new Needs({});
  o.stress = 0.8;
  o.accumulateStress(e0, 1000);
  assert.ok(Math.abs(o.stress - 0.77) < 1e-9);
  // 満たされない欲求が続いても、exp は頭打ちになる (たまる量と抜ける量がつり合う)
  const hungry = { ...e0, hunger: 1 };
  const x = new Needs({ cfg: { stress: { model: 'exp' } } });
  const at = [];
  for (let t = 1; t <= 300; t++) { x.accumulateStress(hungry, 1000); if (t % 100 === 0) at.push(x.stress); }
  assert.ok(at[2] - at[1] < 0.01 && at[2] < 1, at.join(' '));
  // 旧の係数は変わらない (linear に戻せば旧の k・power 2)
  assert.strictEqual(new Needs({}).stressParams().power, 2);
  assert.strictEqual(new Needs({ cfg: { stress: { model: 'exp' } } }).stressParams().power, 0.5);
});

// ---- 人物 (gen_personas.js) ----
test('人物: τw は年齢の中央値 (Jenni 2005・Daan 1984) × 対数正規 σ 0.22、性格とは結ばない', () => {
  const med = gen.TAUW_MEDIAN;
  assert.deepStrictEqual([med(10), med(11.9), med(14.2), med(20), med(30), med(80)], [8900, 8900, 15400, 18200, 18200, 18200]);
  assert.ok(med(13) > 8900 && med(13) < 15400);
  const lr = ps.map((p) => Math.log(p.needs.sleep.tauW / gen.TAUW_MEDIAN(p.age)));
  assert.ok(Math.abs(mean(lr)) < 0.08, String(mean(lr)));
  assert.ok(sd(lr) > 0.15 && sd(lr) < 0.3, String(sd(lr)));
  assert.ok(Math.abs(corr(lr, ps.map((p) => p.bigFive.z.N))) < 0.3);
  const child = ps.filter((p) => p.age <= 12).map((p) => p.needs.sleep.tauW); const adult = ps.filter((p) => p.age >= 30).map((p) => p.needs.sleep.tauW);
  assert.ok(mean(child) < mean(adult) * 0.7);
});

test('人物: 感情の個人差 (性別・神経症傾向・外向性とのつながり)', () => {
  const lnm = (p) => Math.log(p.emotions.halfLifeMul);
  const f = ps.filter((p) => p.sex === 'female').map(lnm); const m = ps.filter((p) => p.sex === 'male').map(lnm);
  const ratio = Math.exp(mean(f) - mean(m));
  assert.ok(ratio > 1.6 && ratio < 4, `女性/男性 ${ratio}`); // 2.5 (Verduyn 2015)
  const zN = ps.map((p) => p.bigFive.z.N); const zE = ps.map((p) => p.bigFive.z.E);
  const neg = ps.map((p) => p.emotions.baseShift.sadness);
  assert.ok(ps.every((p) => p.emotions.baseShift.sadness === p.emotions.baseShift.anger && p.emotions.baseShift.fear === p.emotions.baseShift.disgust));
  const rN = corr(neg, zN);
  assert.ok(rN > 0.45 && rN < 0.85, `N と負の感情の基準値 r ${rN}`); // ρ .64 (Steel 2008)
  const rE = corr(ps.map((p) => p.emotions.baseShift.joy), zE);
  assert.ok(rE > 0.3 && rE < 0.75, `E と喜びの基準値 r ${rE}`); // ρ .54
  assert.ok(sd(neg) > 0.6 && sd(neg) < 1.3, `SD ${sd(neg)}`); // 0.9 × SD(z_p)
  // ストレスの k: × max(0.2, 1 + 0.51 zN)
  for (const p of ps) assert.ok(Math.abs(p.needs.stress.exp.k - Math.round(gen.STRESS_EXP_K * Math.max(0.2, 1 + 0.51 * p.bigFive.z.N) * 1e5) / 1e5) < 2e-5 + 0.0001 * Math.abs(p.bigFive.z.N), p.name);
  // 旧の値 (k・fullAfter・threshold) はそのまま残る
  assert.ok(ps.every((p) => Number.isFinite(p.needs.stress.k) && Number.isFinite(p.needs.sleep.fullAfter)));
});

// ---- 記録の再生 (calibrate_emotions.js) ----
test('calibrate_emotions: 言葉・聞こえた名前の読み取りと、合成した記録の再生', () => {
  assert.deepStrictEqual(cal.wordsEmotions('お腹は空いていない。少しうれしい。とても驚いている。Aとは知り合い'), ['joy', 'surprise']);
  assert.deepStrictEqual(cal.heardNames('自分: X\n今聞こえた話: Kazuko「木」 Moe「南へ」 Kazuko「また」 X「私」', 'X'), ['Kazuko', 'Moe']);
  const persona = { name: 'X', temperament: { bravery: 0.5, empathy: 0.5, obedience: 0.5, greed: 0.5, sociability: 0.5 } };
  const step = (loop, tod, ok, extra = {}) => ({ _name: 'X', ts: new Date(1e12 + loop * 10000).toISOString(), loop, day: 0, timeOfDay: tod, action: 'craft', arg: 'stick', result: { ok }, decideMs: 1000, actMs: 1000,
    obs: '', troubles: [], social: { words: '', emotions: {}, stress: 0, needs: { hunger: 0, sleep: 0, safety: 0, eff: {} } }, ...extra });
  const all = [{ _name: 'X', event: 'start', persona, ts: new Date(1e12).toISOString() }, step(1, 1000, false, { obs: '今聞こえた話: Moe「やあ」' }), step(2, 1000 + 2160, true)];
  const runs = cal.agentRuns(all);
  const cfg = { social: { emotions: { model: 'perEmotion', gain: { anger: 1, surprise: 1, joy: 1 } } }, needs: { sleep: { model: 'processS' }, stress: { model: 'exp' } } };
  const rows = cal.replayAgent(runs[0], { cfg });
  assert.strictEqual(rows[0].emotions.surprise, 1.5); // 初めて聞いた
  assert.strictEqual(rows[0].emotions.anger, 0.7 + 1.0); // 失敗 (1.2 − 0.4 × 0.5)
  // 2160 tick (怒りの半減期) で怒りの上乗せが半分 → 成功で −0.4
  assert.ok(Math.abs(rows[1].emotions.anger - (0.7 + 0.5 - 0.4)) < 0.011, String(rows[1].emotions.anger));
});

// ---- 誰が殴ったか (conflict_stats.js の aggressionStats) ----
test('conflict_stats: 挑発された人・協調性の低い人ほど殴ったかを数える (重みは掛けない。文献の向きと比べるだけ)', () => {
  const { aggressionStats, conflictStats, lines } = require('../tools/conflict_stats');
  const start = (n, A) => ({ _name: n, event: 'start', persona: { name: n, bigFive: { z: { A } } } });
  const all = [start('P1', -1.5), start('P2', -0.5), start('Q1', 0.5), start('Q2', 1.2), start('Q3', 0),
    { _name: 'P1', event: 'hit_received', from: 'Q1' }, { _name: 'P2', event: 'grudge', kind: 'hit', add: 0.5 }, { _name: 'Q3', event: 'grudge', kind: 'took_witnessed', add: 0.4 },
    { _name: 'P1', event: 'hit', hits: 3 }, { _name: 'P1', event: 'hit', hits: 3 }, { _name: 'P2', event: 'hit', hits: 2 }, { _name: 'Q1', event: 'hit', hits: 1 }];
  const a = aggressionStats(all);
  assert.deepStrictEqual([a.people, a.hitters, a.hits], [5, 3, 4]);
  assert.deepStrictEqual(a.provokedPhysical.n, [2, 3]);
  assert.deepStrictEqual(a.provokedPhysical.share, [1, 0.333]);
  assert.ok(a.provokedPhysical.d > 0.76);
  assert.deepStrictEqual(a.provokedAny.n, [3, 2]);
  assert.ok(a.agreeableness.r < -0.2 && a.agreeableness.n === 5);
  assert.deepStrictEqual(a.literature, { provocationD: 0.76, agreeablenessR: -0.2 });
  assert.match(lines(conflictStats([...all, { _name: 'P1', event: 'grudge', who: 'Q1', kind: 'hit', add: 0.5 }])).join('\n'), /誰が殴ったか \(5 人中 3 人・4 回\)/);
  assert.strictEqual(aggressionStats([{ _name: 'X', event: 'hit' }]), null); // start が無ければ数えない
});
