#!/usr/bin/env node
'use strict';
// 前の実行の記録を読み直して、先のつらさ (anticipate.js) がどう動いたはずかと、その場面で出る知っていること (facts.json) を見る。
//   node tools/replay_anticipate.js runs/<時刻>/ [--json] [--persona-config configs/survival_3days.json]
// 記録の各行から: timeOfDay・day・持ち物 (行動の後)・obs の「体力n/20」「敵<名前>」「<動物>」・death の event (何に殺されたか) を読む。
//   拠点が囲まれていたか (shelterKnown)・着けている防具は古い記録に無いので、無いものとして数える。
// 場面: 夕方の少し前 (9500〜12000)・夜 (13000〜23000)・夜に死んだあと (次の判断から10判断)。
//   その場面で出ていた事実 (記録の factsShown) と、いまの knowledge.js で出る事実 (状況 + 持ち物・見えている物・道筋の名前) を比べる。
const fs = require('fs');
const path = require('path');
const { Anticipation } = require('../src/anticipate');
const { merge } = require('../src/needs');
const knowledge = require('../src/knowledge');
const { HOSTILE } = require('../src/observe');

function readJsonl(f) { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); }
const isStep = (r) => !!(r && r.loop && r.action && !r.event && r.result);
const ANIMALS = /\b(cow|pig|sheep|chicken|rabbit)\b/g;

function rawOf(r) {
  const obs = String(r.obs || '');
  const hp = obs.match(/体力(\d+)\/20/);
  const food = obs.match(/満腹(\d+)\/20/);
  const near = (obs.split('\n').find((l) => l.startsWith('近くの人')) || '');
  const hostiles = [...near.matchAll(/敵([a-z_]+) [^,]*?\((\d+)m\)/g)].map((m) => ({ kind: 'hostile', name: m[1], d: Number(m[2]) }));
  const mobs = [...new Set(near.match(ANIMALS) || [])].map((n) => ({ kind: 'mob', name: n, d: 8 }));
  const blocks = [...new Set((obs.split('\n').find((l) => l.startsWith('見えるブロック')) || '').match(/[a-z_]+(?= )/g) || [])].map((n) => ({ name: n }));
  return { self: { timeOfDay: r.timeOfDay, day: r.day, health: hp ? Number(hp[1]) : 20, food: food ? Number(food[1]) : 20 }, inventory: r.inventory || [], entities: [...hostiles.filter((h) => HOSTILE.has(h.name)), ...mobs], blocks };
}

function replayAgent(rows, persona = {}, cfgAnt = {}) {
  const a = new Anticipation({ cfg: merge(cfgAnt, (persona.needs && persona.needs.anticipate) || {}), temperament: persona.temperament || {} });
  const steps = rows.filter(isStep);
  const deaths = rows.filter((r) => r.event === 'death');
  let lastHp = null; let di = 0;
  const out = [];
  for (const r of steps) {
    while (di < deaths.length && deaths[di].loop <= r.loop) { const d = deaths[di++]; a.noteDeath({ timeOfDay: d.timeOfDay, day: d.day, cause: d.cause, message: d.message }); lastHp = null; }
    const raw = rawOf(r);
    const hurt = lastHp != null && raw.self.health < lastHp ? lastHp - raw.self.health : 0;
    lastHp = raw.self.health;
    a.update({ timeOfDay: r.timeOfDay, day: r.day, time: (r.day || 0) * 24000 + (r.timeOfDay || 0), inventory: raw.inventory, hostiles: raw.entities.filter((e) => e.kind === 'hostile'), entities: raw.entities, blocks: raw.blocks }, { hunger: 1 - raw.self.food / 20 });
    out.push({ r, raw, v: { ...a.v }, detail: a.detail, harmed: a.harmed(), killers: a.killers(), words: a.words().join('。') });
  }
  return out;
}

function scene(x, diedLoops) {
  const t = x.r.timeOfDay;
  if (diedLoops.some((l) => x.r.loop > l && x.r.loop <= l + 10)) return 'after_night_death';
  if (t >= 9500 && t < 12000) return 'before_dusk';
  if (t >= 13000 && t < 23000) return 'night';
  return null;
}

function main() {
  const args = process.argv.slice(2);
  const dir = args.find((x) => !x.startsWith('--'));
  if (!dir) { console.error('usage: node tools/replay_anticipate.js runs/<時刻>/ [--json]'); process.exit(2); }
  const ci = args.indexOf('--persona-config');
  const conf = JSON.parse(fs.readFileSync(ci >= 0 ? args[ci + 1] : path.join(__dirname, '..', 'configs', 'survival_3days.json'), 'utf8'));
  const cfgAnt = (conf.needs && conf.needs.anticipate) || {};
  const facts = knowledge.loadFacts();
  const res = { perAgent: {}, scenes: {} };
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl') && !x.startsWith('monitor'))) {
    const rows = readJsonl(path.join(dir, f));
    const start = rows.find((r) => r.event === 'start') || {};
    const name = start.persona ? start.persona.name : f.split('-')[0];
    const persona = (conf.personas || []).find((p) => p.name === name) || start.persona || {};
    const rep = replayAgent(rows, persona, cfgAnt);
    const diedLoops = rows.filter((r) => r.event === 'death' && r.timeOfDay >= 13000 && r.timeOfDay < 23000).map((r) => r.loop);
    res.perAgent[name] = { bravery: (persona.temperament || {}).bravery ?? null, maxNight: Math.max(0, ...rep.map((x) => x.v.night)), trend: rep.filter((_, i) => i % 15 === 0).map((x) => ({ loop: x.r.loop, day: x.r.day, tod: x.r.timeOfDay, night: x.v.night, food: x.v.food })) };
    for (const x of rep) {
      const sc = scene(x, diedLoops);
      if (!sc) continue;
      const S = (res.scenes[sc] = res.scenes[sc] || { n: 0, old: {}, now: {}, examples: [] });
      S.n += 1;
      for (const id of x.r.factsShown || []) S.old[id] = (S.old[id] || 0) + 1;
      const died = rows.filter((r) => r.event === 'death' && r.loop < x.r.loop).map((r) => r.loop).pop();
      const sit = knowledge.situations(x.raw, { tick: x.r.loop, diedAt: died ?? null, nightHarm: x.harmed, anxiousNight: x.v.night >= 0.3 });
      const ext = sit.has('night') || sit.has('night_soon') ? x.killers.filter((k) => !['unknown', 'water', 'fall', 'lava', 'hunger'].includes(k)) : [];
      const names = knowledge.namesInView({ raw: x.raw, actions: [], plan: x.r.progress || '' });
      const now = knowledge.selectFacts(facts, { names, strong: knowledge.namesInText(x.r.progress || ''), situations: sit, extraNames: ext, max: 8 }).map((ff) => ff.id);
      for (const id of now) S.now[id] = (S.now[id] || 0) + 1;
      if (S.examples.length < 3 && x.words && (sc !== 'night' || x.harmed)) S.examples.push({ who: name, loop: x.r.loop, tod: x.r.timeOfDay, night: x.v.night, words: x.words, old: x.r.factsShown || [], now });
    }
  }
  if (args.includes('--json')) { console.log(JSON.stringify(res, null, 2)); return; }
  const top = (m, n = 14) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${v}`).join('・');
  for (const [sc, S] of Object.entries(res.scenes)) {
    console.log(`\n## ${sc} (${S.n} 判断)`);
    console.log(`  前回出ていた事実: ${top(S.old)}`);
    console.log(`  いまの knowledge で出る事実: ${top(S.now)}`);
    for (const e of S.examples) console.log(`  例 ${e.who} loop${e.loop} tod${e.tod} 先の不安 ${e.night}: 「${e.words}」\n     前回 [${e.old.join(',')}]\n     いま [${e.now.join(',')}]`);
  }
  console.log('\n## 先の不安 (読み直し) の最大 (人ごと、勇敢さ)');
  console.log(Object.entries(res.perAgent).map(([k, v]) => `${k}(${v.bravery}) ${v.maxNight}`).join('・'));
}

if (require.main === module) main();
module.exports = { replayAgent, rawOf };
