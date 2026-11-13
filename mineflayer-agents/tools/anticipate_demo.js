#!/usr/bin/env node
'use strict';
// 2B と Jev を実際に呼んで、先のつらさ (anticipate.js) でゴールの選び方がどう変わるかを見る (bot なし)。
//   LLM_BASE_URL=http://192.168.15.30:18081 node tools/anticipate_demo.js [--who Taro] [--seed N] [--json] [--dry (2B・Jev を呼ばず、欲求と事実だけ)]
//   場面: 昼 (2日目の朝、前の夜は何事もなかった)・夕方前 (同じ人、夜まであと3分ほど)・夜に死んだあと (1日目の夜に zombie に2回殺された、2日目の夕方前)
//   どの場面も、欲求のモデル (Needs) に時間を進めて入れ、言葉 (2B の体と心・Jev の needs / later) と点 (いま + 先) を出す。
//   選ばれた案と、いまの点だけで選んだときの案 (nowChoice) を並べる。Jev は場面ごとに1回 (案 × 欲求)
const path = require('path');
const { GoalPath } = require('../src/goalpath');
const { summarizeObservation } = require('../src/observe');
const knowledge = require('../src/knowledge');
const { loadConfig } = require('../src/config');
const { Needs, needsConfig } = require('../src/needs');
const { JevDecider } = require('../src/deciders/jev');
const { UsageMeter } = require('../src/usage');
const { Order } = require('../src/order');

const cfg = loadConfig(path.join(__dirname, '..', 'configs', 'survival_3days.json'));
const blk = (name, x, z, notable = false) => ({ name, notable, diggable: true, seen: 3, nearest: { x, y: 64, z, d: Math.round(Math.hypot(x, z)) }, positions: [] });
const JUNGLE = [blk('jungle_log', 8, -6, true), blk('grass_block', 1, 0), blk('grass', 2, 1), blk('jungle_leaves', 7, -5), blk('stone', 10, 4), blk('cobblestone', 5, 3), blk('crafting_table', 2, 2, true)];
const INV = [{ name: 'jungle_planks', count: 6 }, { name: 'stick', count: 4 }, { name: 'cobblestone', count: 5 }, { name: 'wooden_pickaxe', count: 1 }];

// 欲求のモデルに時間を進めて入れる。deaths: 1日目の夜に殺された時刻
function needsFor(persona, { tod, day, deaths = [] }) {
  const n = new Needs({ cfg: needsConfig(cfg, persona), temperament: persona.temperament });
  const feed = (age) => n.update({ time: age, timeOfDay: age % 24000, day: Math.floor(age / 24000), food: 16, saturation: 2, inventory: INV, health: 20, players: [], shelter: { enclosed: false }, entities: [{ kind: 'mob', name: 'cow', d: 12 }] });
  for (let age = 0; age <= day * 24000 + tod; age += 400) {
    feed(age);
    for (const d of deaths) if (age % 24000 === d && Math.floor(age / 24000) === 0) { n.onDeath(); n.ant.noteDeath({ timeOfDay: d, day: 0, message: `${persona.name} was slain by Zombie` }); }
  }
  // 1日目の夜は外で起きていた (missedNights)。眠気がつらさの上位を占めないように、2日目の朝にベッドで寝たことにする
  n.v.sleep = 0.2; n.missedNights = 0;
  n.update({ time: day * 24000 + tod + 10, timeOfDay: tod + 10, day, food: 16, saturation: 2, inventory: INV, health: 20 });
  return n;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
  const who = opt('who', 'Taro');
  const persona = cfg.personas.find((p) => p.name === who);
  const baseUrl = process.env.LLM_BASE_URL || 'http://192.168.15.30:18081';
  const kn = knowledge.loadFacts(cfg.knowledge.file);
  const meter = new UsageMeter();
  const jev = new JevDecider({ ...(cfg.decider.jev || {}), meter });
  const scenes = [
    { label: '昼 (2日目 3000、前の夜は何事もなかった)', tod: 3000, day: 1, deaths: [] },
    { label: '夕方前 (2日目 10000、前の夜は何事もなかった)', tod: 10000, day: 1, deaths: [] },
    { label: '夜に死んだあと (1日目の夜に zombie に2回殺された、2日目 10000)', tod: 10000, day: 1, deaths: [16000, 19600] },
  ];
  const out = [];
  for (const sc of scenes) {
    const n = needsFor(persona, sc);
    const raw = { self: { name: who, pos: { x: 0, y: 64, z: 0 }, health: 20, food: 16, timeOfDay: sc.tod, phase: sc.tod < 12000 ? '昼' : '夜', day: sc.day }, inventory: INV, blocks: JUNGLE,
      entities: [{ kind: 'mob', name: 'cow', pos: { x: 12, y: 64, z: 2 }, d: 12 }], heard: [], craft: { now: [], withTable: [] }, tableNearby: { x: 2, y: 64, z: 2 } };
    const a = n.ant;
    const sit = knowledge.situations(raw, { tick: 100, nightHarm: a.harmed(), anxiousNight: a.v.night >= a.cfg.night.threshold });
    const extraNames = sit.has('night_soon') || sit.has('night') ? a.killers().filter((k) => k !== 'unknown') : [];
    const facts = (text) => knowledge.selectFacts(kn, { names: knowledge.namesInView({ raw, plan: text || '' }), strong: knowledge.namesInText(text || ''), situations: sit, extraNames, max: cfg.knowledge.max });
    const ev = [];
    const gp = new GoalPath({ cfg: { ...cfg.goalPath, select: { ...cfg.goalPath.select, enabled: true } }, llmOpts: { ...cfg.decider.llm, baseUrl }, log: (e) => ev.push(e), jev,
      order: new Order({ enabled: true, seed: Number(opt('seed', 1)) }) });
    const socialText = n.words();
    const ctx = { persona, goalText: '', obsText: summarizeObservation(raw, { showDay: true }), raw, facts: (t) => facts(t).map((f) => f.text), allFacts: kn,
      memText: sc.deaths.length ? `覚えている場所: なし\nやったこと: 死んでしまった (1日目の夜)・死んでしまった (1日目の夜)` : '覚えている場所: なし\nやったこと: jungle_logを掘った・stickを作った',
      socialText, worst: n.worst(), peopleText: '', people: [], places: [], placeKinds: ['crafting_table'], base: null, needNow: (k) => n.effective()[k],
      pressing: (o) => n.pressing(o), later: (o) => n.later(o) };
    if (args.includes('--dry')) { console.log(sc.label, JSON.stringify(a.values()), '|', socialText, '|', facts('').map((f) => f.id).join(','), '| now', JSON.stringify(n.pressing({ n: 3, minRatio: 0.6 }).map((x) => [x.need, x.distress])), 'later', JSON.stringify(n.later({ minRatio: 0.6 }).map((x) => [x.need, x.distress]))); continue; }
    const tokens0 = meter.summary().jev.inputTokens;
    await gp.update(ctx, 1);
    const g = ev.find((e) => e.kind === 'goal' && e.ok) || ev[ev.length - 1] || {};
    const r = { scene: sc.label, ant: a.values(), socialText, factIds: facts('').map((f) => f.id), proposals: g.proposals || null, select: g.select || null, chosen: g.target || null, jevTokens: meter.summary().jev.inputTokens - tokens0 };
    out.push(r);
    if (!args.includes('--json')) {
      console.log(`\n## ${r.scene} (${who}, bravery ${persona.temperament.bravery})`);
      console.log(`  先のつらさ: 夜 ${r.ant.night} (夜まで ${r.ant.ttn} tick・見込み ${r.ant.risk}・備え ${r.ant.prep}・経験 ${r.ant.exp})、食べ物 ${r.ant.food} (手持ち ${r.ant.meals} 回分)`);
      console.log(`  体と心 (2B・Jev の feelings): ${socialText}`);
      console.log(`  知っていること: ${r.factIds.join(', ')}`);
      if (r.proposals) console.log(`  2B の案: ${r.proposals.map((p) => `${p.target}${p.count ? ` ×${p.count}` : ''} (${p.need || '-'}${p.ok ? '' : `、外した: ${p.result}`}) 「${p.why || ''}」`).join(' / ')}`);
      const s = r.select;
      if (s) {
        console.log(`  いまのつらさ: ${(s.needs || []).map((x) => `${x.need}=${x.distress}`).join(' ') || 'なし'} / 先のつらさ: ${(s.later || []).map((x) => `${x.need}=${x.distress}`).join(' ') || 'なし'}`);
        for (const [i, x] of (s.scores || []).entries()) console.log(`   ${i === s.chosen ? '*' : ' '}${x.target}${x.count ? ` ×${x.count}` : ''}: いま ${x.now} + 先 ${x.later} = ${x.score}  P ${JSON.stringify(x.P)}`);
        console.log(`  規則 ${s.rule}・決めた点 ${s.decidedBy || '-'}${s.nowChoice != null && s.scores[s.nowChoice] ? ` (いまの点だけなら ${s.scores[s.nowChoice].target})` : ''}・Jev ${r.jevTokens} トークン`);
      }
      console.log(`  選ばれたゴール: ${r.chosen}`);
    }
  }
  if (args.includes('--json')) console.log(JSON.stringify(out, null, 2));
  console.log(`\nJev 合計 ${meter.summary().jev.inputTokens} トークン (${meter.summary().jev.calls} 回)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
