#!/usr/bin/env node
'use strict';
// 経験 (experience.js) と 他人のための道具 (division.js の 6) の確かめ。bot なし・本番なし。
//   node tools/experience_demo.js [--json] [--mock] [--only a|b|c]
//   文を作る LLM: gpt-6-luna (キー /root/.config/luna.env)。Jev: TypeSafe 直 (キー /root/.config/typesafe.env)。キーの中身は出さない。
//   (a) 鮭: 同じ人・同じ場面で、鮭を試して取れなかった回数 (0・1・3・5) と、聞いた経験 (Ken「鮭は取れないな」) だけを変える。
//       hand : 案は手で固定 (鮭・羊肉・牛肉・耕地)。Jev の P は本物
//       fixed: 2B (luna) の案は経験なしの場面で1回だけ作り、同じ案を全部の場面に使う (違いは経験の q と手間だけ)
//       full : 場面ごとに 2B が「やってみたこと」を見て案を作り直す
//   (b) 道具: ほかの人が素手・木の道具で木を切り・耕すのを見たか だけを変える。
//       fixed: 案は固定 (原木・石の斧・丸石・羊肉) で Jev の P は本物 / full: 2B が「みんなに足りていない物」を見て案を作る
//   (c) 渡す: 石の斧を持っていて、Ken が素手で木を切るのを見た人で、2B が「Ken に石の斧を渡す」(人 + give) を案に出すか (full を3回)
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
const { Experience } = require('../src/experience');

const cfg = loadConfig(path.join(__dirname, '..', 'configs', 'survival_3days.json'));
const args = process.argv.slice(2);
const json = args.includes('--json');
const mock = args.includes('--mock');
const oi = args.indexOf('--only');
const ONLY = oi >= 0 ? args[oi + 1] : null;
const blk = (name, x, z, notable = false, y = 64) => ({ name, notable, diggable: true, seen: 3, nearest: { x, y, z, d: Math.round(Math.hypot(x, z)) }, positions: [] });

const meter = new UsageMeter();
const runCfg = { ...cfg, llm: { ...cfg.llm, provider: 'luna' } };
const llmOpts = llmOptsFor(runCfg, 'goal', (cfg.goalPath && cfg.goalPath.llm) || {});
const jev = mock ? { call: async (state, q) => ({ r: { ok: true, answers: Object.fromEntries(Object.keys(q).map((k) => [k, { noul: k.startsWith('p1') ? 0.8 : 0.6 }])) } }) }
  : new JevDecider({ ...(cfg.decider.jev || {}), provider: 'typesafe', meter });
const kn = knowledge.loadFacts(cfg.knowledge.file);
const out = [];
const log = (s) => { if (!json) console.log(s); };

function mockLLM(goals) { return { complete: async () => ({ text: JSON.stringify({ goals }), promptTokens: 0, completionTokens: 0, finishReason: 'stop' }) }; }
function fixedLLM(gp, text) { return { provider: gp.llm.provider, ctxTokens: gp.llm.ctxTokens, complete: async () => ({ text, promptTokens: 0, completionTokens: 0, finishReason: 'stop' }) }; }

async function runScene({ who, raw, obsText, needsStart, experience = null, division = null, fixedText = null, mockGoals, memText = 'なし', people = [], peopleText = '' }) {
  const persona = cfg.personas.find((p) => p.name === who);
  const nCfg = needsConfig(cfg, persona);
  const needs = new Needs({ cfg: { ...nCfg, start: needsStart }, temperament: persona.temperament });
  needs.lastTime = 28000;
  const ev = [];
  const gp = new GoalPath({ cfg: { ...cfg.goalPath, select: { ...cfg.goalPath.select, enabled: true } }, llmOpts, log: (e) => ev.push(e), jev, experience, ...(mock ? { llm: mockLLM(mockGoals) } : {}) });
  if (fixedText) gp.llm = fixedLLM(gp, fixedText);
  const r = JSON.parse(JSON.stringify(raw));
  const ctx = { persona, goalText: '', obsText, raw: r, facts: () => knowledge.selectFacts(kn, { names: knowledge.namesInView({ raw: r }), max: cfg.knowledge.max }).map((f) => f.text), allFacts: kn,
    memText, socialText: needs.words(), worst: needs.worst(), peopleText, people, places: [{ id: 'M1', kind: '拠点', label: '拠点 南東3' }], placeKinds: ['拠点', 'crafting_table', 'chest'],
    base: { x: 3, y: 64, z: 3 }, needNow: () => 0.5, pressing: (o) => needs.pressing(o), later: () => [],
    division: division ? division.view() : null, shortage: division ? division.stimulusText() : '', role: null };
  await gp.update(ctx, 1);
  const g = ev.find((e) => e.kind === 'goal');
  const pr = ev.find((e) => e.kind === 'proposals' || e.kind === 'goal');
  const user = pr && pr.prompt ? pr.prompt[1].content : null;
  return { g, pr, user, rawOutput: pr ? pr.rawOutput : null };
}

const brief = (g) => (g ? `${g.goalKind} ${g.target}${g.give ? ` give ${g.give}` : ''}${g.count ? ` x${g.count}` : ''}` : null);
const scoreLine = (g) => (g && g.select && g.select.scores ? g.select.scores.map((x) => `${x.target === g.target ? '*' : ''}${x.target}${x.count ? ` x${x.count}` : ''} 点${x.score}`
  + (x.expFactor != null ? ` (q/m0 ${x.expFactor}・手間 ${x.planCost ?? '-'}→${x.cost ?? '-'}・経験なし ${x.noExperience})` : '')
  + (x.T != null ? ` [${x.activity || '-'} T=${x.T}${x.noDivision != null ? `・分業なし ${x.noDivision}` : ''}]` : '')
  + ` P=${JSON.stringify(x.P || {})}`).join('\n      ') : '(点なし)');

// ---- (a) 鮭 ----
async function demoA() {
  const who = 'Aoi';
  const RAW = {
    self: { name: who, pos: { x: 0, y: 64, z: 0 }, health: 18, food: 9, timeOfDay: 5000, phase: '昼', day: 1, age: 29000 },
    inventory: [{ name: 'wheat', count: 3 }, { name: 'oak_planks', count: 2 }, { name: 'wooden_sword', count: 1 }],
    blocks: [blk('water', 6, 2, true, 62), blk('oak_log', -8, 5, true), blk('grass_block', 1, 0), blk('crafting_table', 2, 2, true)],
    // 羊は見えていない (羊肉は「まだ見ていない」で手間が大きい)。見えている食べ物の元は鮭だけ
    entities: [{ kind: 'mob', name: 'salmon', pos: { x: 6, y: 62, z: 2 }, d: 6.4 }],
    heard: [], craft: { now: [], withTable: [] }, tableNearby: { x: 2, y: 64, z: 2 },
  };
  const obsText = summarizeObservation(RAW, { showDay: true });
  const needsStart = { hunger: 0.75, greed: 0.3, safety: 0.2, connection: 0.3 };
  const mockGoals = [{ kind: 'item', target: 'salmon', count: 2, why: '食べる', need: '空腹' }, { kind: 'item', target: 'bread', count: 1, why: '食べる', need: '空腹' }, { kind: 'item', target: 'mutton', count: 2, why: '食べる', need: '空腹' }];
  const SC = [
    { id: 'none', label: '経験なし', setup: () => {} },
    { id: 'fail1', label: '鮭を1回試して取れなかった (約2分)', setup: (x) => fail(x, 1) },
    { id: 'fail3', label: '鮭を3回試して取れなかった (計約6分)', setup: (x) => fail(x, 3) },
    { id: 'fail5', label: '鮭を5回試して取れなかった (計約10分)', setup: (x) => fail(x, 5) },
    { id: 'heard', label: '自分は経験なし、Ken と Mai から「鮭は取れない」と2回ずつ聞いた', setup: (x) => { for (let i = 0; i < 2; i++) { x.noteHeard('Ken', '鮭は全然取れないな', i, who); x.noteHeard('Mai', '鮭は取れなかった', i, who); } } },
    { id: 'fail3_bread_ok', label: '鮭を3回失敗 + パンは2回手に入れた', setup: (x) => { fail(x, 3); for (let i = 0; i < 2; i++) x.noteResult({ kind: 'item', target: 'bread', result: 'done', from: 100 + i * 10, to: 106 + i * 10, gameFrom: 12000 + i * 5000, gameTo: 15600 + i * 5000 }); } },
  ];
  function fail(x, n) { for (let i = 0; i < n; i++) x.noteResult({ kind: 'item', target: 'salmon', result: 'stuck', from: i * 20, to: i * 20 + 18, gameFrom: i * 3000, gameTo: i * 3000 + 2400, why: '15判断、道筋が縮まなかった' }); }
  let fixedText = null;
  // hand: 案は手で固定 (鮭・羊肉 (羊はまだ見ていない)・牛肉・耕地)。Jev の P は本物。食べ物の案が鮭のほかにもあるとき
  const HAND = JSON.stringify({ goals: [
    { kind: 'item', target: 'salmon', count: 2, why: 'お腹を満たす', need: '空腹' },
    { kind: 'item', target: 'mutton', count: 2, why: 'お腹を満たす', need: '空腹' },
    { kind: 'item', target: 'beef', count: 2, why: 'お腹を満たす', need: '空腹' },
    { kind: 'state', target: 'farmland', count: 4, why: '作物を育てる', need: '空腹' },
  ] });
  for (const mode of ['hand', 'fixed', 'full']) {
    for (const sc of SC) {
      const x = new Experience({ cfg: cfg.experience });
      sc.setup(x);
      const r = await runScene({ who, raw: RAW, obsText, needsStart, experience: x, fixedText: mode === 'hand' ? HAND : mode === 'fixed' ? fixedText : null, mockGoals });
      if (mode === 'fixed' && !fixedText) fixedText = r.rawOutput;
      const expSec = r.user && r.user.includes('## やってみたこと') ? r.user.split('## やってみたこと')[1].split('\n## ')[0].split('\n').slice(1).join('\n') : '';
      const rec = { demo: 'a', mode, scene: sc.id, label: sc.label, chosen: brief(r.g), proposals: r.pr ? (r.pr.proposals || []).map((p) => `${p.target}${p.ok ? '' : ` (外した: ${p.result})`}`) : null,
        decidedBy: r.g && r.g.select ? r.g.select.decidedBy : null, changed: r.g && r.g.select && r.g.select.experience ? r.g.select.experience.changed : null,
        scores: r.g && r.g.select ? r.g.select.scores : null, words: expSec.trim(), wordsEn: x.lines({ lang: 'en' }), error: r.pr ? r.pr.error : 'no record' };
      out.push(rec);
      log(`\n## (a) [${mode}] ${sc.label}`);
      if (rec.words) log(`  2B に: ${rec.words.replace(/\n/g, ' / ')}`);
      if (rec.wordsEn.length) log(`  Jev に: ${rec.wordsEn.join(' / ')}`);
      log(`  案: ${(rec.proposals || []).join(' / ')}${rec.error ? ` (エラー ${rec.error})` : ''}`);
      log(`  点 [${rec.decidedBy || r.g && r.g.select && r.g.select.rule}${rec.changed ? '、経験で変わった' : ''}]:\n      ${scoreLine(r.g)}`);
      log(`  → ${rec.chosen}`);
    }
  }
}

// ---- (b)(c) 道具 ----
const RAW_B = (inv) => ({
  self: { name: 'Goro', pos: { x: 0, y: 64, z: 0 }, health: 20, food: 18, timeOfDay: 4000, phase: '昼', day: 1, age: 28000 },
  inventory: inv,
  blocks: [blk('oak_log', 8, -6, true), blk('stone', 6, 5), blk('grass_block', 1, 0), blk('crafting_table', 2, 2, true)],
  entities: [{ kind: 'mob', name: 'sheep', pos: { x: -9, y: 64, z: 3 }, d: 9 }, { kind: 'player', name: 'Ken', pos: { x: 10, y: 64, z: -4 }, d: 10.8 }, { kind: 'player', name: 'Mai', pos: { x: -6, y: 64, z: -8 }, d: 10 }],
  heard: [], craft: { now: [], withTable: [] }, tableNearby: { x: 2, y: 64, z: 2 },
});
const PEOPLE = [{ name: 'Ken', relation: '知り合い', seen: '北東11(11m)' }, { name: 'Mai', relation: '知り合い', seen: '北西10(10m)' }];
function seenDiv(saw) {
  const persona = cfg.personas.find((p) => p.name === 'Goro');
  const d = new Division({ cfg: cfg.division, temperament: persona.temperament, drives: (needsConfig(cfg, persona).drives) || {}, me: 'Goro' });
  if (saw) d.noteOthers([
    { seq: 1, who: 'Ken', kind: 'break', name: 'oak_log', tool: null }, { seq: 2, who: 'Ken', kind: 'break', name: 'oak_log', tool: null },
    { seq: 3, who: 'Mai', kind: 'break', name: 'birch_log', tool: 'wooden_axe' }, { seq: 4, who: 'Mai', kind: 'till', name: 'farmland', tool: 'wooden_hoe' },
  ], 9);
  d.update({ tick: 10 });
  return d;
}
async function demoB() {
  const inv = [{ name: 'oak_planks', count: 4 }, { name: 'stick', count: 4 }, { name: 'wooden_pickaxe', count: 1 }];
  const raw = RAW_B(inv);
  const obsText = summarizeObservation(raw, { showDay: true });
  const needsStart = { hunger: 0.2, greed: 0.5, safety: 0.2, connection: 0.35, care: 0.45 };
  const FIXED = JSON.stringify({ goals: [
    { kind: 'item', target: 'oak_log', count: 4, why: '木を集める', need: '物が欲しい' },
    { kind: 'item', target: 'stone_axe', count: 1, why: '道具を作る', need: '物が欲しい' },
    { kind: 'item', target: 'cobblestone', count: 6, why: '石を集める', need: '物が欲しい' },
    { kind: 'item', target: 'mutton', count: 2, why: '食べ物', need: '空腹' },
  ] });
  for (const mode of ['fixed', 'full']) {
    for (const saw of [false, true]) {
      const d = seenDiv(saw);
      const r = await runScene({ who: 'Goro', raw, obsText, needsStart, division: d, fixedText: mode === 'fixed' ? FIXED : null, mockGoals: JSON.parse(FIXED).goals, people: PEOPLE, peopleText: 'Ken: 知り合い。北東11\nMai: 知り合い。北西10' });
      const rec = { demo: 'b', mode, saw, chosen: brief(r.g), shortage: d.stimulusText(), T: { mining: d.T.mining, crafting: d.T.crafting, wood: d.T.wood }, s: { mining: d.s.mining, crafting: d.s.crafting },
        proposals: r.pr ? (r.pr.proposals || []).map((p) => `${p.kind === 'person' ? `${p.target}${p.give ? `に${p.give}を渡す` : ''}` : p.target}${p.ok ? '' : ` (外した: ${p.result})`}`) : null, scores: r.g && r.g.select ? r.g.select.scores : null, error: r.pr ? r.pr.error : 'no record' };
      out.push(rec);
      log(`\n## (b) [${mode}] ${saw ? 'Ken が素手で・Mai が木の斧で木を切り、Mai が木のクワで耕すのを見た' : '見ていない'}`);
      if (rec.shortage) log(`  2B に (みんなに足りていない物): ${rec.shortage.replace(/\n/g, ' / ')}`);
      log(`  s: ${JSON.stringify(rec.s)}  T: ${JSON.stringify(rec.T)}`);
      log(`  案: ${(rec.proposals || []).join(' / ')}${rec.error ? ` (エラー ${rec.error})` : ''}`);
      log(`  点 [${r.g && r.g.select ? r.g.select.decidedBy || r.g.select.rule : '-'}]:\n      ${scoreLine(r.g)}`);
      log(`  → ${rec.chosen}`);
    }
  }
}
async function demoC() {
  const inv = [{ name: 'stone_axe', count: 2 }, { name: 'cobblestone', count: 5 }, { name: 'stick', count: 2 }, { name: 'bread', count: 2 }];
  const raw = RAW_B(inv);
  const obsText = summarizeObservation(raw, { showDay: true });
  const needsStart = { hunger: 0.15, greed: 0.2, safety: 0.2, connection: 0.45, care: 0.6 };
  for (let i = 0; i < (mock ? 1 : 3); i++) {
    const d = seenDiv(true);
    const r = await runScene({ who: 'Goro', raw, obsText, needsStart, division: d, mockGoals: [{ kind: 'person', target: 'Ken', give: 'stone_axe', why: '渡す', need: '人の役に立ちたい' }, { kind: 'item', target: 'oak_log', count: 2, why: '木', need: '物が欲しい' }],
      people: PEOPLE, peopleText: 'Ken: 知り合い。北東11\nMai: 知り合い。北西10' });
    const props = r.pr ? (r.pr.proposals || []) : [];
    const rec = { demo: 'c', try: i, chosen: brief(r.g), proposals: props.map((p) => `${p.kind === 'person' ? `${p.target}${p.give ? `に${p.give}を渡す` : 'の近く'}` : p.target}${p.ok ? '' : ` (外した: ${p.result})`}`),
      giveTool: props.some((p) => p.kind === 'person' && /_(axe|pickaxe|hoe)$/.test(p.give || '')), scores: r.g && r.g.select ? r.g.select.scores : null, error: r.pr ? r.pr.error : 'no record' };
    out.push(rec);
    log(`\n## (c) 石の斧2本を持ち、Ken が素手で木を切るのを見た Goro (試し ${i + 1})`);
    log(`  案: ${rec.proposals.join(' / ')}${rec.error ? ` (エラー ${rec.error})` : ''}`);
    log(`  点: ${scoreLine(r.g)}`);
    log(`  → ${rec.chosen}  (道具を渡す案: ${rec.giveTool ? 'あり' : 'なし'})`);
  }
}

async function main() {
  if (!ONLY || ONLY === 'a') await demoA();
  if (!ONLY || ONLY === 'b') await demoB();
  if (!ONLY || ONLY === 'c') await demoC();
  if (json) console.log(JSON.stringify(out, null, 2));
  const u = meter.summary();
  if (!mock) console.error(`\nJev ${u.jev.calls} 回・${u.jev.inputTokens} トークン${u.jev.costUsd != null ? `・$${u.jev.costUsd}` : ''}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
