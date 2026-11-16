#!/usr/bin/env node
'use strict';
// 感情・ストレスの係数を、既にある実行の記録の出来事の列を新しい式でオフライン再生して決める (2026-11-13 ユーザー決定)。サーバー・ボット・API は使わない。
//   node tools/calibrate_emotions.js runs/<時刻>/ [--config configs/survival_100.json] [--fit] [--json] [--validate]
//     --validate: 旧モデル (uniform・linear) で再生し、記録の感情の値と言葉の割合が再現できるかを見る (この道具の確かめ)
//     --fit: ストレスの k (STRESS_EXP_K) と感情ごとの上げ幅 gain を、下の目標に合うように二分法で決める
//     既定: 今の設定 (新モデル) で再生した割合を出す
//
// 再生のしかた (1人ずつ、記録の判断の順に):
//   出来事: 記録の行の時刻 (ts) で判断に割り当てる。判断 n の観測の後 (内面を進めた時刻 ≈ 行の ts − decideMs − actMs) より前の出来事は戻る前に、後なら後に当てる。
//     当てる出来事は Social の同じ関数を呼ぶ (bump の上げ幅 gain もそのまま効く):
//       初めて声を聞いた人 (観測の「今聞こえた話:」の名前) → onHeard、行動の結果 → onActionResult (続けて失敗 = 行の troubles にその行動)、
//       ベッドで夜を越した → 喜び、received → onReceived、ask_reply → onAnswered、ask_timeout・ownership_ask の返事なし → onIgnored、death → onDeath、
//       ownership_social → applyOwnershipImpact、grudge → addGrudge (+ complained の悲しみ)
//   欲求: 空腹・不安と上の欲求は記録の値 (上の欲求は眠気が変わった分の gate を掛け直す)。眠気は processS なら needs.js の Needs.update で作り直す
//     (時刻・ベッドの結果だけを渡す)。ストレスは Needs.accumulateStress で作り直す (旧モデルでも作り直して記録と比べる)。
//   言葉に出る感情: 内面を進めた直後 (行動の前。記録の social.words と同じ時点) に Social.shownEmotions。
// 目標:
//   感情: 言葉に出ている判断の割合 = 今その感情を感じている時間の割合 (Trampe, Quoidbach, & Taquet 2015, PLoS ONE 10, e0145450, Table 2):
//     喜び 0.35・悲しみ 0.20・嫌悪 0.11・怒り 0.10・恐れ 0.05 (驚きは測定が無いので合わせない)
//   ストレス: ストレスが言葉に出る (0.2 以上) 判断が1回でもある (人, 日) の割合 = 日々のストレッサーがあった日の割合 0.38
//     (ストレッサーの無い日 62%。Mroczek & Almeida 2004, J. Pers. 72, 355-378, Table 1)。あわせて人の判断の平均 (日々の負の感情は尺度の 4%) も出す
const fs = require('fs');
const path = require('path');
const { readRun } = require('./provenance_stats');
const { Social, EMOTIONS, emotionsConfig } = require('../src/social');
const { Needs, needsConfig, NEEDS, BASIC, merge } = require('../src/needs');
const gen = require('./gen_personas');

const ROOT = path.resolve(__dirname, '..');
const TARGET = { joy: 0.35, sadness: 0.2, disgust: 0.11, anger: 0.1, fear: 0.05 };
const STRESS_TARGET = { stressDays: 0.38, meanNA: 0.17 / 4 };
const EMO_WORDS = {
  joy: ['少しうれしい', 'うれしい', 'とてもうれしい'], sadness: ['少し落ち込んでいる', '落ち込んでいる', 'とても落ち込んでいる'],
  anger: ['少しいらだっている', 'いらだっている', 'かなり怒っている'], fear: ['少し不安', '不安', 'とても怖い'],
  disgust: ['少しうんざりしている', 'うんざりしている', 'ひどくうんざりしている'], surprise: ['少し驚いている', '驚いている', 'とても驚いている'],
};
const r3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const q = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const isStep = (r) => !!(r && r.loop && r.action && !r.event && r.social);
const tsOf = (r) => Date.parse(r.ts);

// 記録の言葉から、言葉に出ていた感情
function wordsEmotions(words) {
  const segs = new Set(String(words || '').split('。'));
  return EMOTIONS.filter((e) => EMO_WORDS[e].some((w) => segs.has(w)));
}
// 観測の「今聞こえた話:」の名前
function heardNames(obs, me) {
  const line = String(obs || '').split('\n').find((l) => l.startsWith('今聞こえた話:'));
  if (!line) return [];
  const out = []; const re = /([A-Za-z0-9_]{3,16})「/g; let m;
  while ((m = re.exec(line))) if (m[1] !== me && !out.includes(m[1])) out.push(m[1]);
  return out;
}

// 1人分の記録を、判断ごとの { 前の出来事, 後の出来事 } に分ける
function agentRuns(all) {
  const by = new Map();
  for (const r of all) { if (!by.has(r._name)) by.set(r._name, []); by.get(r._name).push(r); }
  const out = [];
  for (const [name, rows] of by) {
    const start = rows.find((r) => r.event === 'start');
    const steps = rows.filter(isStep).sort((a, b) => a.loop - b.loop);
    if (!steps.length || !start) continue;
    const evs = rows.filter((r) => r.event && r.ts && ['received', 'ask_reply', 'ask_timeout', 'ownership_ask', 'death', 'ownership_social', 'grudge'].includes(r.event));
    const items = steps.map((s) => ({ s, ts: tsOf(s), tickTs: tsOf(s) - (s.decideMs || 0) - (s.actMs || 0), pre: [], post: [] }));
    for (const e of evs) {
      const t = tsOf(e);
      const it = items.find((x) => t <= x.ts);
      if (!it) continue;
      (t < it.tickTs ? it.pre : it.post).push(e);
    }
    out.push({ name, persona: start.persona, items });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function applyEvent(s, e, me) {
  switch (e.event) {
    case 'received': s.onReceived(e.from); break;
    case 'ask_reply': if (e.from === me) s.onAnswered(e.to, !!e.known); break;
    case 'ask_timeout': if (e.from === me) s.onIgnored(e.to); break;
    case 'ownership_ask': if (e.answer !== 'granted' && e.answer !== 'denied') s.onIgnored(e.owner); break;
    case 'death': s.onDeath(); break;
    case 'ownership_social': s.applyOwnershipImpact(e.who || null, e); break;
    case 'grudge': s.grudgeCfg.enabled = true; s.addGrudge(e.who, e.kind, { scale: e.add && s.grudgeCfg.kinds[e.kind] && s.grudgeCfg.kinds[e.kind].add ? e.add / s.grudgeCfg.kinds[e.kind].add : 1 }); if (e.kind === 'complained') s.bump('sadness', 0.5); break;
    default: break;
  }
}

// gate (needs.js の Needs.gate と同じ形)
function gateOf(basicMax, g) { return 1 - (1 - g.min) * Math.max(0, Math.min(1, (basicMax - g.from) / Math.max(1e-6, g.to - g.from))); }

// 1人を再生する。opts: { cfg (設定), persona (人の設定。新しい survival_100 の同じ名前の人があればそれ), kMul, gain }
function replayAgent(run, opts) {
  const persona = opts.persona || run.persona;
  const cfg = opts.cfg;
  const ncfg = needsConfig(cfg, persona);
  if (opts.kMul != null && ncfg.stress) ncfg.stress = merge(ncfg.stress, { exp: { k: (ncfg.stress.exp && Number.isFinite(ncfg.stress.exp.k) ? ncfg.stress.exp.k : 0.012) * opts.kMul } });
  const ecfg = emotionsConfig(cfg, persona);
  if (opts.gain) ecfg.gain = { ...(ecfg.gain || {}), ...opts.gain };
  const s = new Social({ temperament: run.persona.temperament, needs: ncfg, emotions: ecfg });
  const sl = new Needs({ cfg: ncfg, temperament: run.persona.temperament }); // 眠気だけ (processS)
  const st = s.needsModel; // ストレス (accumulateStress)
  const processS = sl.processS();
  const met = new Set();
  let lastT = null;
  const rows = [];
  for (const it of run.items) {
    const r = it.s;
    const T = r.day * 24000 + r.timeOfDay;
    const dt = lastT == null ? 0 : Math.max(0, Math.min(ncfg.maxDt ?? 6000, T - lastT));
    lastT = T;
    for (const e of it.pre) applyEvent(s, e, run.name);
    for (const n of heardNames(r.obs, run.name)) { if (!met.has(n)) { met.add(n); s.onHeard(n, r.loop, ''); } else s.rel(n).talks += 1; }
    // 欲求 (記録の値 + 眠気の作り直し)
    const rec = r.social.needs || {};
    const recEff = rec.eff || rec;
    sl.update({ time: T, timeOfDay: r.timeOfDay, food: 20 });
    const sleep = processS ? sl.v.sleep : rec.sleep;
    const g = ncfg.gate || { from: 0.35, to: 0.8, min: 0.2 };
    const gOld = gateOf(Math.max(rec.hunger ?? 0, rec.sleep ?? 0, rec.safety ?? 0), g);
    const gNew = gateOf(Math.max(rec.hunger ?? 0, sleep ?? 0, rec.safety ?? 0), g);
    const e = { hunger: recEff.hunger ?? 0, sleep, safety: recEff.safety ?? 0 };
    for (const k of NEEDS) if (!BASIC.includes(k)) e[k] = (recEff[k] ?? 0) * (gOld > 0 ? gNew / gOld : 1);
    st.v.safety = rec.safety ?? 0; st.v.sleep = sleep;
    st.accumulateStress(e, dt);
    const stressNew = st.stress;
    if (opts.recordedStress) st.stress = r.social.stress ?? 0;
    s.decayEmotions(dt); // uniform では dt を見ない (1判断ぶん)
    if (s.grudgeCfg.enabled) s.decayGrudges(s.grudgeCfg.decayUnit === 'ticks' ? dt : null);
    s.stressToEmotions(s.perEmotion() ? dt : null);
    const shown = s.shownEmotions().map(([em]) => em);
    for (const ev of it.post) applyEvent(s, ev, run.name);
    const res = r.result || {};
    const key = `${r.action}:${r.arg}`;
    s.onActionResult(r.action, !!res.ok, { repeatedFail: !res.ok && (r.troubles || []).some((t) => t === key || (t && t.key === key)) });
    if (res.ok && r.action === 'sleep' && res.sleep && res.sleep.slept) {
      if (res.sleep.nightSkipped) s.bump('joy', 1);
      if (processS) { sl.lastTime = T; sl.onSleep({ nightSkipped: !!res.sleep.nightSkipped, timeOfDay: res.sleep.timeOfDay }); }
    }
    rows.push({ day: r.day, T, dt, shown, recShown: wordsEmotions(r.social.words), emotions: { ...s.emotions }, recEmotions: r.social.emotions, stress: stressNew, recStress: r.social.stress ?? 0, sleep, recSleep: rec.sleep });
  }
  return rows;
}

function summarize(rowsBy) {
  const all = rowsBy.flat();
  const occ = (k) => Object.fromEntries(EMOTIONS.map((e) => [e, r3(all.filter((x) => x[k].includes(e)).length / Math.max(1, all.length))]));
  const people = (k) => Object.fromEntries(EMOTIONS.map((e) => [e, rowsBy.filter((rs) => rs.some((x) => x[k].includes(e))).length]));
  const days = [];
  for (const rs of rowsBy) { const by = {}; for (const x of rs) (by[x.day] || (by[x.day] = [])).push(x); for (const xs of Object.values(by)) if (xs.length >= 10) days.push({ max: Math.max(...xs.map((x) => x.stress)), mean: mean(xs.map((x) => x.stress)) }); }
  const last = rowsBy.map((rs) => rs[rs.length - 1].stress);
  const mae = Object.fromEntries(EMOTIONS.map((e) => [e, r3(mean(all.map((x) => Math.abs(x.emotions[e] - (x.recEmotions[e] ?? 0)))))]));
  return {
    decisions: all.length, agents: rowsBy.length,
    occupancy: occ('shown'), recordedOccupancy: occ('recShown'), peopleShown: people('shown'),
    stress: { personDays: days.length, stressDays: r3(days.filter((d) => d.max >= 0.2).length / Math.max(1, days.length)), meanDecision: r3(mean(all.map((x) => x.stress))),
      lastQuartiles: [q(last, 0.25), q(last, 0.5), q(last, 0.75)].map(r3), recordedLastQuartiles: (() => { const l = rowsBy.map((rs) => rs[rs.length - 1].recStress); return [q(l, 0.25), q(l, 0.5), q(l, 0.75)].map(r3); })(),
      maeVsRecorded: r3(mean(all.map((x) => Math.abs(x.stress - x.recStress)))) },
    emotionMaeVsRecorded: mae,
    meanEmotion: Object.fromEntries(EMOTIONS.map((e) => [e, r3(mean(all.map((x) => x.emotions[e])))])),
  };
}

function loadCfg(p) { return JSON.parse(fs.readFileSync(path.resolve(ROOT, p), 'utf8')); }
function oldCfgOf(cfg) {
  const c = JSON.parse(JSON.stringify(cfg));
  c.needs = merge(c.needs || {}, { sleep: { model: 'linear' }, stress: { model: 'linear' } });
  c.social = merge(c.social || {}, { emotions: { model: 'uniform' } });
  return c;
}

function replayAll(runs, cfg, { personas = null, kMul = null, gain = null, recordedStress = false } = {}) {
  return runs.map((run) => replayAgent(run, { cfg, persona: personas ? personas.get(run.name) : null, kMul, gain, recordedStress }));
}

// k の倍率 → ストレスの日の割合 (単調に増える) を二分法で合わせる
function fitK(runs, cfg, personas) {
  let lo = 0.05; let hi = 20;
  for (let i = 0; i < 24; i++) {
    const mid = Math.sqrt(lo * hi);
    const v = summarize(replayAll(runs, cfg, { personas, kMul: mid })).stress.stressDays;
    if (v < STRESS_TARGET.stressDays) lo = mid; else hi = mid;
  }
  return Math.sqrt(lo * hi);
}
// 感情ごとの gain を二分法で (ほかの感情の gain は固定し、数回まわす)
function fitGains(runs, cfg, personas, { rounds = 4, start = null } = {}) {
  const gain = { joy: 1, sadness: 1, anger: 1, fear: 1, disgust: 1, ...(start || {}) };
  const unfit = new Set();
  for (let round = 0; round < rounds; round++) {
    for (const e of Object.keys(TARGET)) {
      if (unfit.has(e)) continue;
      let lo = 1e-3; let hi = 50;
      for (let i = 0; i < 22; i++) {
        const mid = Math.sqrt(lo * hi);
        const v = summarize(replayAll(runs, cfg, { personas, gain: { ...gain, [e]: mid } })).occupancy[e];
        if (v < TARGET[e]) lo = mid; else hi = mid;
      }
      gain[e] = Math.round(Math.sqrt(lo * hi) * 1000) / 1000;
      // 上げ幅をいくら大きくしても目標に届かない (その感情を動かす出来事が記録にほとんど無い) なら合わせられない: 1 のままにする
      if (gain[e] >= 49) { gain[e] = 1; unfit.add(e); }
    }
  }
  return { gain, unfit: [...unfit] };
}

function main() {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith('--') && !/\.json$/.test(a));
  const ci = args.indexOf('--config');
  const cfgPath = ci >= 0 ? args[ci + 1] : 'configs/survival_100.json';
  if (!target) { console.error('usage: node tools/calibrate_emotions.js runs/<時刻>/ [--config configs/survival_100.json] [--validate] [--fit] [--json]'); process.exit(2); }
  const cfg = loadCfg(cfgPath);
  const personas = new Map((cfg.personas || []).map((p) => [p.name, p]));
  const runs = agentRuns(readRun(target));
  const out = { run: target, config: cfgPath, targets: { emotions: TARGET, stress: STRESS_TARGET } };
  if (args.includes('--validate')) {
    // 旧モデル・記録の人 (start の persona)。ストレスは記録の値を感情に使う (感情の再生だけを確かめる) / 作り直したストレスと記録の差も出す
    out.validateOld = summarize(replayAll(runs, oldCfgOf(cfg), { recordedStress: true }));
  }
  if (args.includes('--fit')) {
    const kMul = fitK(runs, cfg, personas);
    out.fit = { stressKMul: r3(kMul), STRESS_EXP_K: Math.round(gen.STRESS_EXP_K * kMul * 100000) / 100000 };
    // k を合わせた設定で gain を合わせる
    const cfgK = JSON.parse(JSON.stringify(cfg));
    for (const p of cfgK.personas || []) if (p.needs && p.needs.stress && p.needs.stress.exp) p.needs.stress.exp.k *= kMul;
    const personasK = new Map((cfgK.personas || []).map((p) => [p.name, p]));
    const fg = fitGains(runs, cfgK, personasK);
    out.fit.gain = fg.gain; out.fit.unfit = fg.unfit;
    out.fitted = summarize(replayAll(runs, cfgK, { personas: personasK, gain: out.fit.gain }));
  } else {
    out.current = summarize(replayAll(runs, cfg, { personas }));
  }
  if (args.includes('--json')) { console.log(JSON.stringify(out, null, 2)); return; }
  const show = (name, s) => {
    if (!s) return;
    console.log(`## ${name} (${s.agents} 人・${s.decisions} 判断)`);
    console.log(`  言葉に出た割合: ${EMOTIONS.map((e) => `${e} ${s.occupancy[e]}${TARGET[e] != null ? ` (目標 ${TARGET[e]})` : ''}`).join('・')}`);
    console.log(`  記録の言葉の割合: ${EMOTIONS.map((e) => `${e} ${s.recordedOccupancy[e]}`).join('・')}`);
    console.log(`  1回でも言葉に出た人: ${EMOTIONS.map((e) => `${e} ${s.peopleShown[e]}`).join('・')}`);
    console.log(`  ストレス: 言葉に出た日 ${s.stress.stressDays} (目標 ${STRESS_TARGET.stressDays}、${s.stress.personDays} 人日)・判断の平均 ${s.stress.meanDecision}・最後の四分位 ${s.stress.lastQuartiles.join('/')} (記録 ${s.stress.recordedLastQuartiles.join('/')})`);
    console.log(`  記録との差 (平均の絶対値): ${EMOTIONS.map((e) => `${e} ${s.emotionMaeVsRecorded[e]}`).join('・')}・ストレス ${s.stress.maeVsRecorded}`);
  };
  show('旧モデルで再生 (確かめ)', out.validateOld);
  show('今の設定で再生', out.current);
  if (out.fit) { console.log(`fit: STRESS_EXP_K ${out.fit.STRESS_EXP_K} (倍率 ${out.fit.stressKMul})・gain ${JSON.stringify(out.fit.gain)}${out.fit.unfit.length ? ` (合わせられなかった: ${out.fit.unfit.join('・')})` : ''}`); show('合わせた値で再生', out.fitted); }
}

if (require.main === module) main();
module.exports = { agentRuns, replayAgent, replayAll, summarize, wordsEmotions, heardNames, fitK, fitGains, oldCfgOf, TARGET, STRESS_TARGET };
