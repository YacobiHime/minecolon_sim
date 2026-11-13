#!/usr/bin/env node
'use strict';
// 2B を実際に呼んで、振り返り (reflect.js) → 方針 → その方針を材料にしたゴール選び (goalpath.js) を出す (bot・Jev なし)。
//   記録は模擬 (1日分の判断・死んだ・食べた・人とのこと を作る)。LLM_BASE_URL=http://192.168.15.30:18081 node tools/reflect_demo.js [--json]
const path = require('path');
const { Reflect } = require('../src/reflect');
const { GoalPath } = require('../src/goalpath');
const { summarizeObservation } = require('../src/observe');
const knowledge = require('../src/knowledge');
const { loadConfig } = require('../src/config');

const cfg = loadConfig(path.join(__dirname, '..', 'configs', 'survival_3days.json'));
const persona = (n) => cfg.personas.find((p) => p.name === n);
const blk = (name, x, z, notable = false) => ({ name, notable, diggable: true, seen: 3, nearest: { x, y: 64, z, d: Math.round(Math.hypot(x, z)) }, positions: [] });

// 模擬の1日: goals = [[ゴール, need, 判断数, 1判断で歩く m, 結果]]
function day(r, { goals, deaths = [], ate = [], slept = 0, near = {}, received = [], heard = [], fails = [] }) {
  let tick = 0; let tod = 1000; let x = 0;
  for (const [goal, need, n, walk, result] of goals) {
    const from = tick;
    for (let i = 0; i < n; i++) {
      tick += 1; tod += 250; x += walk;
      const nm = Object.entries(near).filter(([, v]) => tick % v === 0).map(([k]) => k);
      const fail = fails.find((f) => f[2] === goal && i % 3 === 0);
      r.note({ tick, day: 0, timeOfDay: tod, pos: { x, y: 64, z: 0 }, action: fail ? fail[0] : 'collect', arg: fail ? fail[1] : 'x', ok: !fail, goal, need, near: nm });
    }
    r.noteGoal({ kind: result === 'done' ? 'goal_done' : 'reselect', tick, target: goal, goalKind: 'item', count: 1, need, result, from, to: tick });
  }
  for (const f of ate) r.note({ tick: ++tick, day: 0, timeOfDay: (tod += 50), pos: { x, y: 64, z: 0 }, action: 'eat', arg: f, ok: true, goal: null, need: null, near: [] });
  for (let i = 0; i < slept; i++) r.note({ tick: ++tick, day: 0, timeOfDay: (tod += 50), pos: { x, y: 64, z: 0 }, action: 'sleep', arg: 'white_bed', ok: true, goal: null, need: null, near: [] });
  for (const d of deaths) r.noteEvent({ kind: 'death', tick, ...d });
  for (const g of received) r.noteEvent({ kind: 'received', tick, ...g });
  for (const h of heard) r.noteEvent({ kind: 'heard', tick, ...h });
  r.pending = null;
  return tick;
}

const SCENARIOS = [
  { who: 'Yuki', reason: 'death', social: '少しお腹が空いた。暗いし、殺されたばかりで怖い。気が張っている', worst: { need: 'safety', text: '暗いし、殺されたばかりで怖い' },
    day: { goals: [['beef', 'hunger', 30, 7, 'stuck'], ['apple', 'hunger', 20, 1, 'stuck'], ['white_bed', 'sleep', 12, 2, 'stuck']], deaths: [{ timeOfDay: 14500, cause: 'death.attack.zombie' }, { timeOfDay: 17000, cause: 'death.attack.skeleton' }],
      ate: [], near: { Ken: 5 }, heard: [{ from: 'Ken', text: '夜は外に出るなよ' }], fails: [['attack', 'cow', 'beef']] },
    raw: { inventory: [{ name: 'jungle_planks', count: 6 }, { name: 'stick', count: 2 }, { name: 'wheat', count: 2 }], blocks: [blk('jungle_log', 8, -6, true), blk('grass_block', 1, 0), blk('grass', 2, 1), blk('crafting_table', 2, 2, true)],
      entities: [{ kind: 'mob', name: 'cow', pos: { x: 9, y: 64, z: 3 }, d: 9 }] }, base: { x: 2, y: 64, z: 2 }, tod: 15500 },
  { who: 'Hanako', reason: 'day_end', social: 'お腹は空いていない。眠くない。落ち着いている。ひとりぼっちで寂しい', worst: { need: 'connection', text: 'ずっと誰とも一緒に何もしていなくて寂しい' },
    day: { goals: [['wheat_seeds', 'hunger', 15, 2, 'done'], ['bread', 'hunger', 25, 3, 'done'], ['jungle_log', 'greed', 8, 1, 'done']], ate: ['bread', 'bread'], slept: 1, near: {}, received: [] },
    raw: { inventory: [{ name: 'bread', count: 4 }, { name: 'jungle_log', count: 6 }, { name: 'wheat_seeds', count: 5 }], blocks: [blk('jungle_log', 8, -6, true), blk('grass_block', 1, 0), blk('water', -6, 4, true)],
      entities: [{ kind: 'player', name: 'Jiro', pos: { x: -5, y: 64, z: 8 }, d: 9 }, { kind: 'mob', name: 'sheep', pos: { x: 12, y: 64, z: 2 }, d: 12 }] }, base: { x: 0, y: 64, z: 0 }, tod: 12100 },
  { who: 'Taro', reason: 'goals', social: 'お腹が空いた。少し眠い。落ち着いている', worst: { need: 'hunger', text: 'お腹が空いた。朝から何も食べていない' },
    day: { goals: [['beef', 'hunger', 18, 6, 'done'], ['cooked_beef', 'hunger', 30, 2, 'stuck'], ['beef', 'hunger', 22, 8, 'done']], ate: ['beef'], near: { Ken: 3, Jiro: 6 }, received: [{ from: 'Ken', item: 'bread', count: 1 }] },
    raw: { inventory: [{ name: 'oak_planks', count: 12 }, { name: 'stick', count: 6 }, { name: 'wheat', count: 3 }, { name: 'beef', count: 1 }], blocks: [blk('oak_log', 6, -6, true), blk('grass_block', 1, 0), blk('stone', 5, 5)],
      entities: [{ kind: 'mob', name: 'cow', pos: { x: 12, y: 64, z: 1 }, d: 12 }, { kind: 'mob', name: 'cow', pos: { x: 14, y: 64, z: 3 }, d: 14 }, { kind: 'player', name: 'Ken', pos: { x: 3, y: 64, z: 1 }, d: 3 }] },
    base: { x: 1, y: 64, z: 1 }, tod: 9000 },
];

async function main() {
  const json = process.argv.includes('--json');
  const baseUrl = process.env.LLM_BASE_URL || 'http://192.168.15.30:18081';
  const kn = knowledge.loadFacts(cfg.knowledge.file);
  const out = [];
  for (const sc of SCENARIOS) {
    const rev = [];
    const r = new Reflect({ cfg: cfg.reflect, llmOpts: { ...cfg.decider.llm, baseUrl }, log: (e) => rev.push(e) });
    const tick = day(r, sc.day);
    const pol = await r.run({ persona: persona(sc.who), socialText: sc.social }, tick, sc.reason);
    const gev = [];
    const gp = new GoalPath({ cfg: cfg.goalPath, llmOpts: { ...cfg.decider.llm, baseUrl }, log: (e) => gev.push(e) });
    const raw = { self: { name: sc.who, pos: { x: 0, y: 64, z: 0 }, health: 20, food: 14, timeOfDay: sc.tod, phase: sc.tod < 12000 ? '昼' : sc.tod < 13000 ? '夕方' : '夜', day: 1 }, heard: [], craft: { now: [], withTable: [] },
      tableNearby: sc.raw.blocks.some((b) => b.name === 'crafting_table') ? { x: 2, y: 64, z: 2 } : null, ...sc.raw };
    const obsText = summarizeObservation(raw, { showDay: true });
    const facts = () => knowledge.selectFacts(kn, { names: knowledge.namesInView({ raw }), max: cfg.knowledge.max }).map((f) => f.text);
    await gp.update({ persona: persona(sc.who), goalText: '', obsText, raw, facts, allFacts: kn, memText: '覚えている場所: M1 拠点', socialText: sc.social, worst: sc.worst,
      peopleText: '', people: [], places: [{ id: 'M1', kind: '拠点', label: '拠点' }], placeKinds: ['拠点'], base: sc.base, baseLabel: '自分の拠点', needNow: () => 0.7, policy: r.policyText() }, tick + 1);
    const g = gev.find((e) => e.kind === 'goal' || e.kind === 'unplannable') || {};
    const rec = { who: sc.who, reason: sc.reason, facts: rev[0].facts, policy: pol ? pol.text : null, why: pol ? pol.why : null, reflectRaw: rev[0].rawOutput, reflectTokens: [rev[0].promptTokens, rev[0].completionTokens],
      goal: { kind: g.goalKind, target: g.target, count: g.count, why: g.why, need: g.need, worst: g.worst, desc: g.desc, tokens: [g.promptTokens, g.completionTokens] }, plan: gp.planText() };
    out.push(rec);
    if (!json) {
      console.log(`\n## ${rec.who} (振り返り: ${rec.reason})`);
      for (const f of rec.facts) console.log(`  - ${f}`);
      console.log(`  方針: ${rec.policy} / 何のため: ${rec.why} [2B 入力 ${rec.reflectTokens[0]} / 出力 ${rec.reflectTokens[1]}]`);
      console.log(`  → ゴール: ${rec.goal.kind} ${rec.goal.target}${rec.goal.count ? ` ×${rec.goal.count}` : ''} / why: ${rec.goal.why} / need: ${rec.goal.need} (worst: ${rec.goal.worst}) [2B 入力 ${rec.goal.tokens[0]} / 出力 ${rec.goal.tokens[1]}]`);
      console.log(`    候補の説明: ${rec.goal.desc}`);
      console.log(`    Jev の plan: ${rec.plan}`);
    }
  }
  if (json) console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
