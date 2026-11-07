#!/usr/bin/env node
'use strict';
// 珍しさ・大事さ (scarcity.js) と、夜の外歩きの手間 (planner の costScale) の確かめ。bot なし・本番なし。
//   node tools/value_demo.js [--json] [--mock] [--only a|b] [--reps N]
//   文を作る LLM: gpt-6-luna (キー /root/.config/luna.env)。Jev: config の提供元 (OpenRouter、キー /root/.config/openrouter.env)。キーの中身は出さない。
//   (a) 草と羊: 昼。草・シダがたくさん見え、羊が1頭見える。見かけた記録だけを変える:
//       first  : 初め (今見えている物だけ)
//       walked : 歩き回ったあと (草・シダ・原木は 10 マスでたくさん見た。羊はこれが2回目)
//       hand: 案は手で固定 (種・羊肉・羊毛・白いベッド・パン・耕地・Ken)。Jev の P は本物 / full: 2B (luna) が案を作る
//       どちらも1回の選び直しで「珍しさ・大事さなし (noValue)」と「あり」の点と選ばれた案を記録から出す
//   (b) 夜: 拠点の近く (作業台・かまど・チェスト)。持ち物は原木・板・丸石・羊肉 (生)・羊毛 2。ゾンビが 20m 先に見える。
//       夜の危なさの見込み (anticipate の night.risk) だけを変える: 0 (夜の外歩きを見ない) / 0.3 (初めての夜) / 0.8 (夜に死んだあと)。2B が案を作る
const path = require('path');
const { GoalPath } = require('../src/goalpath');
const { summarizeObservation } = require('../src/observe');
const knowledge = require('../src/knowledge');
const { loadConfig } = require('../src/config');
const { Needs, needsConfig } = require('../src/needs');
const { JevDecider } = require('../src/deciders/jev');
const { UsageMeter } = require('../src/usage');
const { llmOptsFor } = require('../src/llm_provider');
const scarcity = require('../src/scarcity');

const cfg = loadConfig(path.join(__dirname, '..', 'configs', 'survival_3days.json'));
const args = process.argv.slice(2);
const json = args.includes('--json');
const mock = args.includes('--mock');
const oi = args.indexOf('--only');
const ONLY = oi >= 0 ? args[oi + 1] : null;
const ri = args.indexOf('--reps');
const REPS = ri >= 0 ? Number(args[ri + 1]) : 2;
const blk = (name, x, z, seen = 3, notable = false, y = 64) => ({ name, notable, diggable: true, seen, nearest: { x, y, z, d: Math.round(Math.hypot(x, z)) }, positions: [] });

const meter = new UsageMeter();
const runCfg = { ...cfg, llm: { ...cfg.llm, provider: 'luna' } };
const llmOpts = llmOptsFor(runCfg, 'goal', (cfg.goalPath && cfg.goalPath.llm) || {});
const jev = mock ? { call: async (state, q) => ({ r: { ok: true, answers: Object.fromEntries(Object.keys(q).map((k) => [k, { noul: 0.4 + (k.length % 5) / 10 }])) } }) }
  : new JevDecider({ ...(cfg.decider.jev || {}), meter });
const kn = knowledge.loadFacts(cfg.knowledge.file);
const out = [];
const log = (s) => { if (!json) console.log(s); };
function fixedLLM(gp, text) { return { provider: gp.llm.provider, ctxTokens: gp.llm.ctxTokens, complete: async () => ({ text, promptTokens: 0, completionTokens: 0, finishReason: 'stop' }) }; }

async function runScene({ who, raw, needsStart, laterList = [], sightings, gameNow, nightRisk = 0, fixedText = null, mockGoals = null, places = [], base = null, T = 0 }) {
  const persona = cfg.personas.find((p) => p.name === who);
  const needs = new Needs({ cfg: { ...needsConfig(cfg, persona), start: needsStart }, temperament: persona.temperament });
  needs.lastTime = gameNow;
  const ev = [];
  const gp = new GoalPath({ cfg: { ...cfg.goalPath, select: { ...cfg.goalPath.select, enabled: true } }, llmOpts, log: (e) => ev.push(e), jev });
  if (fixedText) gp.llm = fixedLLM(gp, fixedText);
  else if (mock) gp.llm = fixedLLM(gp, JSON.stringify({ goals: mockGoals }));
  const r = JSON.parse(JSON.stringify(raw));
  const ctx = { persona, goalText: '', obsText: summarizeObservation(r, { showDay: true }), raw: r,
    facts: () => knowledge.selectFacts(kn, { names: knowledge.namesInView({ raw: r }), max: cfg.knowledge.max }).map((f) => f.text), allFacts: kn,
    memText: places.length ? `覚えている場所: ${places.map((p) => `${p.id}=${p.label}`).join(', ')}` : 'なし', socialText: needs.words(), worst: needs.worst(), peopleText: 'Ken: 知り合い。東20', people: [{ name: 'Ken', relation: '知り合い', seen: '東20(20m)' }],
    places, placeKinds: places.map((p) => p.kind), base, needNow: () => 0.5, pressing: (o) => needs.pressing(o), later: () => laterList,
    division: { T: { exploring: T }, s: {}, theta: {}, fam: {}, score: {}, activityOf: () => null }, shortage: '', role: null,
    sightings, gameNow, nightRisk };
  await gp.update(ctx, 1);
  const g = ev.find((e) => e.kind === 'goal');
  const pr = ev.find((e) => e.kind === 'proposals' || e.kind === 'goal');
  return { g, pr };
}

const r2 = (x) => (x == null ? '-' : Math.round(x * 100) / 100);
function scoreLines(g) {
  if (!g || !g.select || !g.select.scores) return ['(点なし)'];
  const S = g.select;
  const noV = S.value && S.value.noValueChoice != null ? S.scores[S.value.noValueChoice].target : null;
  const lines = [`選ばれた: ${g.target}${noV ? ` (珍しさ・大事さなしなら ${noV})` : ''}  手間の倍率 ${JSON.stringify(S.costScale || {})}  [${S.decidedBy || S.rule}]`];
  for (const x of [...S.scores].sort((a, b) => b.score - a.score)) {
    const ra = x.rarity ? ` ${x.rarity.source} a=${x.rarity.a}${x.rarity.now ? '・今見える' : ''}` : '';
    lines.push(`   ${x.kind}:${x.target}${x.count ? ` x${x.count}` : ''} 点 ${x.noValue ?? '-'} → ${x.score}  R=${x.R ?? 1}${ra}  Imp=${x.imp ?? 0}  手間 ${r2(x.cost)}  P=${JSON.stringify(x.P || {})}`);
  }
  return lines;
}

// ---- (a) 草と羊 ----
async function demoA() {
  const who = 'Aoi';
  const RAW = {
    self: { name: who, pos: { x: 0, y: 64, z: 0 }, health: 18, food: 12, timeOfDay: 6000, phase: '昼', day: 0, age: 6000 },
    inventory: [{ name: 'oak_planks', count: 6 }, { name: 'stick', count: 2 }, { name: 'crafting_table', count: 1 }],
    blocks: [blk('grass', 2, 1, 12), blk('fern', 4, -2, 8), blk('grass_block', 1, 0, 12), blk('oak_log', -9, 4, 6, true), blk('oak_leaves', -9, 6, 12)],
    entities: [{ kind: 'mob', name: 'sheep', pos: { x: 12, y: 64, z: -8 }, d: 14 }, { kind: 'player', name: 'Ken', pos: { x: 20, y: 64, z: 0 }, d: 20 }],
    heard: [], craft: { now: [], withTable: [] }, tableNearby: null,
  };
  const needsStart = { hunger: 0.55, sleep: 0.35, safety: 0.3, greed: 0.4, curiosity: 0.3 };
  const laterList = [{ need: 'night', distress: 0.6, ratio: 0.6, text: 'あと8分ほどで夜。囲まれた寝床は無い', textEn: 'night in about 8 minutes; no enclosed bed' },
    { need: 'food', distress: 0.5, ratio: 0.6, text: '食べ物を持っていない', textEn: 'no food on hand' }];
  const HAND = JSON.stringify({ goals: [
    { kind: 'item', target: 'wheat_seeds', count: 8, give: '', why: '畑を作る', need: '空腹' },
    { kind: 'item', target: 'mutton', count: 2, give: '', why: 'お腹を満たす', need: '空腹' },
    { kind: 'item', target: 'white_wool', count: 3, give: '', why: 'ベッドを作る', need: '眠気' },
    { kind: 'item', target: 'white_bed', count: 1, give: '', why: '夜に寝る', need: '眠気' },
    { kind: 'item', target: 'bread', count: 2, give: '', why: '食べ物', need: '空腹' },
    { kind: 'state', target: 'farmland', count: 4, give: '', why: '作物を育てる', need: '空腹' },
    { kind: 'person', target: 'Ken', count: 1, give: '', why: '一緒にいる', need: 'つながり' },
  ] });
  const mkSight = (walked) => {
    const sg = new scarcity.Sightings({}, cfg.goalPath.select.value);
    if (walked) {
      for (let i = 0; i < 10; i++) sg.note({ blocks: [blk('grass', i * 20, 30, 12), blk('fern', i * 20, 34, 8), blk('oak_log', i * 20, 40, 8), blk('oak_leaves', i * 20, 42, 12), blk('grass_block', i * 20, 30, 12)], entities: [] }, 1000 + i * 300);
      sg.note({ blocks: [], entities: [{ kind: 'mob', name: 'sheep', pos: { x: -60, y: 64, z: 50 } }] }, 2500);
    }
    sg.note(RAW, 6000);
    return sg;
  };
  for (const mode of ['hand', 'full']) {
    for (const walked of [false, true]) {
      for (let rep = 0; rep < (mode === 'full' ? REPS : 1); rep++) {
        const r = await runScene({ who, raw: RAW, needsStart, laterList, sightings: mkSight(walked), gameNow: 6000, fixedText: mode === 'hand' ? HAND : null, mockGoals: JSON.parse(HAND).goals });
        const g = r.g;
        const S = g && g.select;
        const rec = { demo: 'a', mode, scene: walked ? 'walked' : 'first', rep, chosen: g ? g.target : null, noValueChoice: S && S.value && S.value.noValueChoice != null ? S.scores[S.value.noValueChoice].target : null,
          proposals: r.pr ? (r.pr.proposals || []).map((p) => `${p.target}${p.ok ? '' : ` (外した: ${p.result})`}`) : null, scores: S ? S.scores : null, error: r.pr ? r.pr.error : 'no record' };
        out.push(rec);
        log(`\n## (a) [${mode}] ${walked ? '歩き回ったあと (草・シダ・原木は 10 マスで見た・羊は2回目)' : '初め (今見えている物だけ)'}${mode === 'full' ? ` 試し ${rep + 1}` : ''}`);
        log(`  案: ${(rec.proposals || []).join(' / ')}${rec.error ? ` (エラー ${rec.error})` : ''}`);
        for (const l of scoreLines(g)) log(`  ${l}`);
      }
    }
  }
}

// ---- (b) 夜 ----
async function demoB() {
  const who = 'Yuki';
  const RAW = {
    self: { name: who, pos: { x: 2, y: 64, z: 2 }, health: 16, food: 11, timeOfDay: 15000, phase: '夜', day: 0, age: 15000 },
    inventory: [{ name: 'oak_log', count: 3 }, { name: 'oak_planks', count: 5 }, { name: 'stick', count: 4 }, { name: 'cobblestone', count: 9 }, { name: 'mutton', count: 2 }, { name: 'white_wool', count: 2 }, { name: 'wooden_pickaxe', count: 1 }],
    blocks: [blk('crafting_table', 1, 1, 1, true), blk('furnace', 3, 1, 1, true), blk('chest', 0, 3, 1, true), blk('grass_block', 1, 0, 12), blk('oak_log', -10, 4, 6, true), blk('farmland', 5, 5, 4)],
    entities: [{ kind: 'mob', name: 'zombie', pos: { x: 18, y: 64, z: -8 }, d: 20 }, { kind: 'player', name: 'Ken', pos: { x: 22, y: 64, z: 0 }, d: 20 }],
    heard: [], craft: { now: [], withTable: [] }, tableNearby: { x: 1, y: 64, z: 1 },
  };
  const needsStart = { hunger: 0.55, sleep: 0.75, safety: 0.75, greed: 0.3, connection: 0.4 };
  const laterList = [{ need: 'night', distress: 0.8, ratio: 0.8, text: '今は夜。夜明けまであと6分ほど。囲まれた寝床は無い', textEn: 'it is night; about 6 minutes until dawn; no enclosed bed' }];
  const places = [{ id: 'M1', kind: '拠点', label: '拠点 ここ', pos: { x: 2, y: 64, z: 2 }, d: 0 }, { id: 'M2', kind: 'sheep', label: 'sheep 北東40(40m)', pos: { x: 30, y: 64, z: -30 }, d: 42 }, { id: 'M3', kind: 'coal_ore', label: 'coal_ore 西50(50m)', pos: { x: -48, y: 60, z: 2 }, d: 50 }];
  const sg = new scarcity.Sightings({}, cfg.goalPath.select.value);
  for (let i = 0; i < 8; i++) sg.note({ blocks: [blk('grass', i * 20, 30, 12), blk('oak_log', i * 20, 40, 8)], entities: [] }, 2000 + i * 500);
  sg.note({ blocks: [], entities: [{ kind: 'mob', name: 'sheep', pos: { x: 30, y: 64, z: -30 } }] }, 9000);
  sg.note(RAW, 15000);
  const mockGoals = [{ kind: 'item', target: 'cooked_mutton', count: 2, give: '', why: '食べる', need: '空腹' }, { kind: 'state', target: 'lit_base', count: 4, give: '', why: '明るく', need: '安心' }, { kind: 'person', target: 'Ken', count: 1, give: '', why: '一緒', need: '安心' }, { kind: 'item', target: 'white_bed', count: 1, give: '', why: '寝る', need: '眠気' }];
  for (const risk of [0, 0.3, 0.8]) {
    for (let rep = 0; rep < REPS; rep++) {
      const r = await runScene({ who, raw: RAW, needsStart, laterList, sightings: sg, gameNow: 15000, nightRisk: risk, mockGoals, places, base: { x: 2, y: 64, z: 2 } });
      const g = r.g;
      const rec = { demo: 'b', risk, rep, chosen: g ? `${g.goalKind}:${g.target}` : null, proposals: r.pr ? (r.pr.proposals || []).map((p) => `${p.target}${p.ok ? '' : ` (外した: ${p.result})`}`) : null, scores: g && g.select ? g.select.scores : null, error: r.pr ? r.pr.error : 'no record' };
      out.push(rec);
      log(`\n## (b) 夜・拠点の近く。夜の危なさの見込み ${risk}${risk === 0 ? ' (夜の外歩きを見ない = 前と同じ)' : ''} 試し ${rep + 1}`);
      log(`  案: ${(rec.proposals || []).join(' / ')}${rec.error ? ` (エラー ${rec.error})` : ''}`);
      for (const l of scoreLines(g)) log(`  ${l}`);
    }
  }
}

async function main() {
  if (!ONLY || ONLY === 'a') await demoA();
  if (!ONLY || ONLY === 'b') await demoB();
  if (json) console.log(JSON.stringify(out, null, 2));
  const u = meter.summary();
  if (!mock) console.error(`\nJev ${u.jev.calls} 回・${u.jev.inputTokens} トークン${u.jev.costUsd != null ? `・$${u.jev.costUsd}` : ''}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
