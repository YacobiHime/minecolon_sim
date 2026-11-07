#!/usr/bin/env node
'use strict';
// 分業 (division.js) の確かめ: 同じ人・同じ場面で、見聞きしたこと (刺激) だけを変えると、選ばれるゴールが変わるか。bot なし・本番なし。
//   node tools/division_demo.js [--who Hanako] [--json] [--mock]
//   文を作る LLM: gpt-6-luna (キー /root/.config/luna.env)。Jev: TypeSafe 直 (キー /root/.config/typesafe.env)。キーの中身は出さない。
//   2つの比べ方:
//     fixed: 2B の案は「刺激なし」の場面で1回だけ作り、同じ案を全部の場面に使う。Jev の P も同じ場面なので、違いは T (刺激) だけ
//     full : 場面ごとに 2B が「みんなに足りていない物」を見て案を作り直す (案そのものが変わるか)
//   --mock: LLM・Jev を呼ばない (形の確かめ)
const path = require('path');
const { GoalPath } = require('../src/goalpath');
const { summarizeObservation } = require('../src/observe');
const knowledge = require('../src/knowledge');
const { loadConfig } = require('../src/config');
const { Needs, needsConfig } = require('../src/needs');
const { JevDecider } = require('../src/deciders/jev');
const { UsageMeter } = require('../src/usage');
const { llmOptsFor } = require('../src/llm_provider');
const { Division } = require('../src/division');

const cfg = loadConfig(path.join(__dirname, '..', 'configs', 'survival_3days.json'));
const args = process.argv.slice(2);
const wi = args.indexOf('--who');
const WHO = wi >= 0 ? args[wi + 1] : 'Hanako';
const persona = cfg.personas.find((p) => p.name === WHO);
const blk = (name, x, z, notable = false) => ({ name, notable, diggable: true, seen: 3, nearest: { x, y: 64, z, d: Math.round(Math.hypot(x, z)) }, positions: [] });
// 同じ場面: 昼、拠点の近く。木・石・羊が見えていて、持ち物は少し
const RAW = {
  self: { name: WHO, pos: { x: 0, y: 64, z: 0 }, health: 20, food: 19, timeOfDay: 4000, phase: '昼', day: 1 },
  inventory: [{ name: 'jungle_planks', count: 4 }, { name: 'stick', count: 2 }, { name: 'wooden_pickaxe', count: 1 }],
  blocks: [blk('jungle_log', 8, -6, true), blk('stone', 6, 5), blk('grass_block', 1, 0), blk('grass', 2, 1), blk('water', -7, 4, true), blk('crafting_table', 2, 2, true)],
  entities: [{ kind: 'mob', name: 'sheep', pos: { x: -9, y: 64, z: 3 }, d: 9 }, { kind: 'player', name: 'Kaori', pos: { x: 12, y: 64, z: -3 }, d: 12 }],
  heard: [], craft: { now: [], withTable: [] }, tableNearby: { x: 2, y: 64, z: 2 },
};
const BASE = { x: 3, y: 64, z: 3 };
const FOOD = [{ name: 'bread', count: 12 }, { name: 'cooked_mutton', count: 8 }];
// 刺激の場面 (見聞きしたことだけが違う)
const SCENES = [
  { id: 'none', label: '刺激なし (共有のチェストの中身を知らず、依頼も聞いていない)', setup: () => ({}) },
  { id: 'food', label: '共有のチェストに食べ物が無い + Ken「誰か食べ物持ってない?」',
    setup: (d) => { d.noteHeard('Ken', '誰か食べ物持ってない?お腹ぺこぺこ', 9); return { chests: [{ id: 'Ken-1', items: [{ name: 'jungle_log', count: 20 }, { name: 'cobblestone', count: 30 }], known: true }] }; } },
  { id: 'stone', label: '共有のチェストは食べ物だけ + Ken「石が足りない、誰か掘ってくれない?」',
    setup: (d) => { d.noteHeard('Ken', '石が足りない、誰か掘ってくれない?', 9); return { chests: [{ id: 'Ken-1', items: [...FOOD, { name: 'jungle_log', count: 20 }], known: true }] }; } },
  { id: 'stone_covered', label: '同じ (石) + Jiro・Goro が石を掘っているのを見た',
    setup: (d) => { d.noteHeard('Ken', '石が足りない、誰か掘ってくれない?', 9); d.noteOthers([{ seq: 1, who: 'Jiro', kind: 'break', name: 'stone' }, { seq: 2, who: 'Goro', kind: 'pickup', name: 'cobblestone' }, { seq: 3, who: 'Jiro', kind: 'pickup', name: 'cobblestone' }], 9);
      return { chests: [{ id: 'Ken-1', items: [...FOOD, { name: 'jungle_log', count: 20 }], known: true }] }; } },
  { id: 'build', label: '共同の目標 torch 8 (Ken の提案) + 自分の拠点が暗い・囲まれていない',
    setup: () => ({ chests: [{ id: 'Ken-1', items: [...FOOD, { name: 'jungle_log', count: 20 }, { name: 'cobblestone', count: 30 }], known: true }], shared: [{ item: 'torch', add: 8, note: '共同の目標 torch 8 (Kenの提案)', noteEn: 'for the project torch x8' }], base: { dark: true, enclosed: false } }) },
];

async function main() {
  const json = args.includes('--json');
  const mock = args.includes('--mock');
  const meter = new UsageMeter();
  const runCfg = { ...cfg, llm: { ...cfg.llm, provider: 'luna' } };
  const llmOpts = llmOptsFor(runCfg, 'goal', (cfg.goalPath && cfg.goalPath.llm) || {});
  const jev = mock ? { call: async (state, q) => ({ r: { ok: true, answers: Object.fromEntries(Object.keys(q).map((k) => [k, { noul: 0.5 }])) } }) }
    : new JevDecider({ ...(cfg.decider.jev || {}), provider: 'typesafe', meter });
  const kn = knowledge.loadFacts(cfg.knowledge.file);
  const nCfg = needsConfig(cfg, persona);
  // いまの欲求: お腹はほぼ満ちていて、少し物が欲しい・人と何かしたい (どれも強くはない。いまのつらさが小さい場面)
  const needs = new Needs({ cfg: { ...nCfg, start: { hunger: 0.1, greed: 0.45, safety: 0.25, connection: 0.35, care: 0.4 } }, temperament: persona.temperament });
  needs.lastTime = 28000;
  const obsText = summarizeObservation(RAW, { showDay: true }) + '\n拠点 (M1) の近く: crafting_table 1、chest 1';
  let fixedText = null; // fixed で使う 2B の出力
  const out = [];
  for (const mode of ['fixed', 'full']) {
    for (const sc of SCENES) {
      const d = new Division({ cfg: cfg.division, temperament: persona.temperament, drives: nCfg.drives || {}, me: WHO });
      // 慣れ: 少し畑をやってきた人 (場面ごとに同じ)
      for (let i = 0; i < 6; i++) d.noteAction('use_on', 'farmland_spot', true);
      d.noteGoal({ kind: 'goal_done', goalKind: 'state', target: 'farmland', result: 'done' });
      const view = sc.setup(d);
      d.update({ tick: 10, ...view });
      const ev = [];
      const base = mock ? { complete: async () => ({ text: JSON.stringify({ goals: [{ kind: 'item', target: 'cobblestone', count: 8, why: '石', need: '物が欲しい' }, { kind: 'item', target: 'mutton', count: 2, why: '食べる', need: '空腹' }, { kind: 'item', target: 'jungle_log', count: 4, why: '木', need: '物が欲しい' }, { kind: 'state', target: 'lit_base', count: 4, why: '明るく', need: '安心' }] }), promptTokens: 0, completionTokens: 0 }) } : null;
      const gp = new GoalPath({ cfg: { ...cfg.goalPath, select: { ...cfg.goalPath.select, enabled: true } }, llmOpts, log: (e) => ev.push(e), jev, ...(base ? { llm: base } : {}) });
      if (mode === 'fixed' && fixedText) { gp.llm = { provider: gp.llm.provider, ctxTokens: gp.llm.ctxTokens, complete: async () => ({ text: fixedText, promptTokens: 0, completionTokens: 0, finishReason: 'stop' }) }; }
      const raw = JSON.parse(JSON.stringify(RAW));
      const ctx = { persona, goalText: '', obsText, raw, facts: () => knowledge.selectFacts(kn, { names: knowledge.namesInView({ raw }), max: cfg.knowledge.max }).map((f) => f.text), allFacts: kn,
        memText: '覚えている場所: M1 拠点\nやったこと: 畑を耕した', socialText: `${needs.words()}。${d.famWords()}`, worst: needs.worst(),
        peopleText: 'Kaori: 知り合い。今は東12にいる\nKen: 感じが良い。今は見えない', people: [{ name: 'Kaori', relation: '知り合い', seen: '東12(12m)' }, { name: 'Ken', relation: '感じが良い', seen: null }],
        places: [{ id: 'M1', kind: '拠点', label: '拠点 南東3' }], placeKinds: ['拠点', 'crafting_table', 'chest'], base: BASE, needNow: () => 0.5,
        pressing: (o) => needs.pressing(o), later: () => [], division: d.view(), shortage: mode === 'fixed' ? '' : d.stimulusText(), role: null };
      await gp.update(ctx, 1);
      const g = ev.find((e) => e.kind === 'goal');
      const pr = ev.find((e) => e.kind === 'proposals' || e.kind === 'goal');
      if (mode === 'fixed' && !fixedText && pr && pr.rawOutput) fixedText = pr.rawOutput;
      const r = { mode, scene: sc.id, label: sc.label, shortage: d.stimulusText(), T: d.T, theta: d.theta, s: d.s, chosen: g ? `${g.goalKind} ${g.target}${g.count ? ` x${g.count}` : ''}` : null, activity: g ? g.activity : null,
        rule: g && g.select ? g.select.rule : null, changed: g && g.select && g.select.division ? g.select.division.changed : null,
        scores: g && g.select ? (g.select.scores || []).map((x) => ({ target: x.target, activity: x.activity, P: x.P, T: x.T, noDivision: x.noDivision, score: x.score })) : null,
        proposals: pr ? (pr.proposals || []).map((p) => `${p.target}${p.count ? ` x${p.count}` : ''}${p.ok ? '' : ` (外した: ${p.result})`}`) : null, error: pr && pr.error };
      out.push(r);
      if (!json) {
        console.log(`\n## [${mode}] ${sc.label}`);
        if (r.shortage) console.log(`  見聞き: ${r.shortage.replace(/\n/g, ' / ')}`);
        console.log(`  T: ${JSON.stringify(r.T)}`);
        console.log(`  案: ${(r.proposals || []).join(' / ')}${r.error ? ` (エラー ${r.error})` : ''}`);
        if (r.scores) console.log(`  点 [${r.rule}${r.changed ? '、分業で変わった' : ''}]: ${r.scores.map((x) => `${x.target === (g && g.target) ? '*' : ''}${x.target}[${x.activity || '-'} T=${x.T}] ${x.score} (分業なし ${x.noDivision ?? '-'}) P=${JSON.stringify(x.P || {})}`).join(' / ')}`);
        console.log(`  → ${r.chosen} (${r.activity})`);
      }
    }
  }
  if (json) console.log(JSON.stringify(out, null, 2));
  const u = meter.summary();
  if (!mock) console.log(`\nJev ${u.jev.calls} 回・${u.jev.inputTokens} トークン`);
}

main().catch((e) => { console.error(e); process.exit(1); });
