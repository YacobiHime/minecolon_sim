#!/usr/bin/env node
'use strict';
// 使う側の声 (toolwant.js)・物単位の刺激 (division.js)・先の道具切れ (anticipate.js) の確かめ。bot なし・本番なし。
//   node tools/toolvoice_demo.js [--json] [--mock] [--only a|b|c|d]
//   文を作る LLM: gpt-6-luna (キー /root/.config/luna.env)。Jev: TypeSafe 直 (キー /root/.config/typesafe.env)。キーの中身は出さない。
//   (a) 声: 社交的な Ken と人見知りの Mio に同じ不満 (素手で原木を掘るのに時間がかかった・木のツルハシが壊れた) を持たせ、
//       しきい値・確率と、60 判断での形の数 (乱数は種で固定)、luna の書いた声 (独り言・近くに頼む・全体に頼む) の例
//   (b) 聞いた人: Sayaka (石の斧1本・丸石・棒を持つ) が (a) の声を聞いたか だけを変え、ゴールの点 (Jev の P は本物) と選んだゴール
//   (c) 道具の備え: Kaori の石のツルハシの耐久が 2 割 (使う速さあり・予備なし) か 満タン か だけを変え、先の道具切れの言葉とゴールの点
//   (d) 提案: 共有のチェストがあり、道具が壊れた・使う人の事実を見せたときの luna の提案 (道具を入れるチェストの取り決めが出るか)
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
const { ToolWant } = require('../src/toolwant');
const { Talker } = require('../src/talker');

const cfg = loadConfig(path.join(__dirname, '..', 'configs', 'survival_3days.json'));
const args = process.argv.slice(2);
const json = args.includes('--json');
const mock = args.includes('--mock');
const oi = args.indexOf('--only');
const ONLY = oi >= 0 ? args[oi + 1] : null;
const blk = (name, x, z, notable = false, y = 64, diggable = true) => ({ name, notable, diggable, seen: 3, nearest: { x, y, z, d: Math.round(Math.hypot(x, z)) }, positions: [] });
const P = (n) => cfg.personas.find((p) => p.name === n);

const meter = new UsageMeter();
const runCfg = { ...cfg, llm: { ...cfg.llm, provider: 'luna' } };
const llmOpts = llmOptsFor(runCfg, 'goal', (cfg.goalPath && cfg.goalPath.llm) || {});
const jev = mock ? { call: async (state, q) => ({ r: { ok: true, answers: Object.fromEntries(Object.keys(q).map((k) => [k, { noul: k.startsWith('p1') ? 0.8 : 0.6 }])) } }) }
  : new JevDecider({ ...(cfg.decider.jev || {}), provider: 'typesafe', meter });
const talker = mock ? new Talker({ llm: { model: 'mock', complete: async (m) => ({ text: JSON.stringify(/提案/.test(m[0].content) ? { kind: 'rule', item: 'stone_axe', chest: 'Ken-3', count: 1, say: '石の斧は Ken-3 に入れよう' } : { say: '石の斧があればなあ' }) }) } })
  : new Talker({ llmOptsFor: (role) => llmOptsFor(runCfg, role, (cfg.talk && cfg.talk.llm) || {}), meter });
const kn = knowledge.loadFacts(cfg.knowledge.file);
const out = [];
const log = (s) => { if (!json) console.log(s); };

// 乱数 (種で固定。mulberry32)
function rngOf(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// 同じ不満: 素手で原木を3回 (各3個・9秒) 掘り、木のツルハシが壊れた
// 同じ不満: 木の斧 (耐久 15/59) で原木を digs 回 (各6個・9秒) 掘った
function sameWant(name, digs = 3) {
  const w = new ToolWant({ cfg: cfg.toolWant, temperament: P(name).temperament, me: name, mutter: P(name).toolVoice ? P(name).toolVoice.mutter : null });
  for (let i = 0; i < digs; i++) w.noteDig({ block: 'oak_log', tools: ['wooden_axe'], digMs: 9000, n: 6, tick: 1 + i });
  w.update({ tick: 5, tools: [{ name: 'wooden_axe', used: 44, max: 59, left: 15, frac: 0.254 }] });
  return w;
}

function talkCtxOf(name, extra = {}) {
  return { persona: P(name), goal: null, plan: '', socialText: 'お腹は満ちている', heardText: '', memText: 'なし', boardText: '', ...extra };
}

const VOICES = [];
async function demoA() {
  log('\n## (a) 同じ不満の Ken (sociability 0.9) と Mio (sociability 0.2)、よくぶつぶつ言う Goro');
  // 不満の大きさ d ごとの1判断の確率 (近くに知り合い1人)
  log('  不満 d ごとの確率 (近くの人に頼む / 全体に頼む / 独り言):');
  for (const name of ['Ken', 'Mio', 'Goro', 'Sota', 'Daiki', 'Sayaka']) {
    const row = [0.2, 0.4, 0.8].map((dv) => { const w = new ToolWant({ cfg: cfg.toolWant, temperament: P(name).temperament, mutter: P(name).toolVoice ? P(name).toolVoice.mutter : null }); w.add('stone_axe', dv, 'slow', null, 1); w.update({ tick: 1 }); const x = w.decide({ tick: 1, near: [{ name: 'Sota', affinity: 50 }], rng: () => 0.999 }); return `d=${dv}: ${x.p.near}/${x.p.all}/${x.p.mutter}`; });
    log(`    ${name} (soc ${P(name).temperament.sociability}・obe ${P(name).temperament.obedience}・greed ${P(name).temperament.greed}): ${row.join('  ')}`);
    out.push({ demo: 'a_table', name, row });
  }
  for (const name of ['Ken', 'Mio', 'Goro']) {
    const w = sameWant(name);
    const near = [{ name: 'Sota', affinity: 50 }];
    const dc = w.decide({ tick: 5, near, rng: () => 0.999 });
    const friend = w.decide({ tick: 5, near: [{ name: 'Nana', affinity: 75 }], rng: () => 0.999 });
    // 60 判断 (半分は近くに人、仲の良さは 50)。不満は同じ値のまま (薄れ・満たされは止める)
    const counts = { near: 0, all: 0, mutter: 0, none: 0 };
    const sim = sameWant(name, 1); sim.rng = rngOf(7 + name.length);
    for (let t = 6; t < 66; t++) {
      for (const a of Object.values(sim.acc)) a.t = t; // 薄れを止める
      const d = sim.decide({ tick: t, near: t % 2 ? near : [] });
      if (d.form) { counts[d.form] += 1; sim.noteVoiced(d.form, d.item, t); } else counts.none += 1;
    }
    const rec = { demo: 'a', name, temperament: P(name).temperament, wants: w.wants().slice(0, 3).map((x) => `${x.item} ${x.v}`), d: dc.d, item: dc.item, theta: dc.theta, p: dc.p, pFriend: friend.p.near, mutterRate: dc.mutterRate, counts60: counts, facts: w.factsText(dc.item), says: [] };
    log(`\n### ${name} ${JSON.stringify(P(name).temperament)}`);
    log(`  不満: ${rec.wants.join(' / ')}  (いちばん大きい物 ${dc.item} d=${dc.d})`);
    log(`  θ: ${JSON.stringify(dc.theta)}  独り言の多さ m=${dc.mutterRate}`);
    log(`  1判断の確率: 近くの人 (知り合い) に頼む ${dc.p.near}・(仲の良い Nana なら ${friend.p.near})・全体に頼む ${dc.p.all}・独り言 ${dc.p.mutter}`);
    log(`  60 判断 (不満 1回分 d=${sim.top().v} のまま、半分は近くに人): ${JSON.stringify(counts)}`);
    log(`  文の材料 (事実): ${rec.facts}`);
    for (const form of name === 'Goro' ? ['mutter'] : ['mutter', 'near', 'all']) {
      for (let i = 0; i < (mock ? 1 : 2); i++) {
        const r = await talker.voice({ ...talkCtxOf(name), form, wantItem: dc.item, wantFacts: rec.facts, nearText: form === 'near' ? 'Sota 北東5' : 'Sota 北東5' });
        const say = r.say || null;
        rec.says.push({ form, say, error: r.error });
        if (say) VOICES.push({ from: name, form, item: dc.item, text: form === 'mutter' ? `(ひとりごと) ${say}` : say });
        log(`  [${form}] 「${say}」${r.error ? ` (エラー ${r.error})` : ''}`);
      }
    }
    if (name === 'Mio') {
      const r = await talker.voice({ ...talkCtxOf(name), form: 'near', wantItem: dc.item, wantFacts: rec.facts, nearText: 'Nana 北5 (仲が良い)', socialText: 'お腹は満ちている。Nana とは仲が良い' });
      rec.says.push({ form: 'near_friend', say: r.say || null });
      log(`  [near・仲の良い Nana に] 「${r.say}」`);
    }
    out.push(rec);
  }
}

// ---- (b)(c) ゴールの点 ----
const RAW = (who, inv, extraBlocks = []) => ({
  self: { name: who, pos: { x: 0, y: 64, z: 0 }, health: 20, food: 18, timeOfDay: 4000, phase: '昼', day: 1, age: 28000 },
  inventory: inv,
  blocks: [blk('oak_log', 8, -6, true), blk('stone', 6, 5), blk('grass_block', 1, 0), blk('crafting_table', 2, 2, true), ...extraBlocks],
  entities: [{ kind: 'mob', name: 'sheep', pos: { x: -9, y: 64, z: 3 }, d: 9 }, { kind: 'player', name: 'Ken', pos: { x: 6, y: 64, z: -2 }, d: 6.3 }, { kind: 'player', name: 'Mio', pos: { x: -5, y: 64, z: -4 }, d: 6.4 }],
  heard: [], craft: { now: [], withTable: [] }, tableNearby: { x: 2, y: 64, z: 2 },
});
const PEOPLE = [{ name: 'Ken', relation: '知り合い', seen: '北東6(6m)' }, { name: 'Mio', relation: '知り合い', seen: '北西6(6m)' }];
function mockLLM(goals) { return { complete: async () => ({ text: JSON.stringify({ goals }), promptTokens: 0, completionTokens: 0, finishReason: 'stop' }) }; }
function fixedLLM(gp, text) { return { provider: gp.llm.provider, ctxTokens: gp.llm.ctxTokens, complete: async () => ({ text, promptTokens: 0, completionTokens: 0, finishReason: 'stop' }) }; }

async function runScene({ who, raw, needs, division = null, fixedText = null, mockGoals, later = false, heardText = '' }) {
  const persona = P(who);
  const ev = [];
  const gp = new GoalPath({ cfg: { ...cfg.goalPath, select: { ...cfg.goalPath.select, enabled: true, later } }, llmOpts, log: (e) => ev.push(e), jev, ...(mock ? { llm: mockLLM(mockGoals) } : {}) });
  if (fixedText) gp.llm = fixedLLM(gp, fixedText);
  const r = JSON.parse(JSON.stringify(raw));
  r.heard = heardText ? heardText.split('\n').map((l) => { const m = l.match(/^(\S+)「(.*)」$/); return m ? { from: m[1], text: m[2], d: 6 } : null; }).filter(Boolean) : [];
  const obsText = summarizeObservation(r, { showDay: true });
  const ctx = { persona, goalText: '', obsText, raw: r, facts: () => knowledge.selectFacts(kn, { names: knowledge.namesInView({ raw: r }), max: cfg.knowledge.max }).map((f) => f.text), allFacts: kn,
    memText: 'なし', socialText: needs.words(), worst: needs.worst(), peopleText: 'Ken: 知り合い。北東6\nMio: 知り合い。北西6', people: PEOPLE, places: [{ id: 'M1', kind: '拠点', label: '拠点 南東3' }], placeKinds: ['拠点', 'crafting_table', 'chest'],
    base: { x: 3, y: 64, z: 3 }, needNow: () => 0.5, pressing: (o) => needs.pressing(o), later: (o) => needs.later(o),
    division: division ? division.view() : null, shortage: division ? division.stimulusText() : '', role: null };
  await gp.update(ctx, 1);
  const g = ev.find((e) => e.kind === 'goal');
  const pr = ev.find((e) => e.kind === 'proposals' || e.kind === 'goal');
  return { g, pr };
}
const brief = (g) => (g ? `${g.goalKind} ${g.target}${g.give ? ` give ${g.give}` : ''}${g.count ? ` x${g.count}` : ''}` : null);
const scoreLine = (g) => (g && g.select && g.select.scores ? g.select.scores.map((x, i) => `${i === g.select.chosen ? '*' : ''}${x.kind === 'person' ? `${x.target}に${x.give || ''}` : x.target}${x.count ? ` x${x.count}` : ''} 点${x.score}`
  + (x.T != null ? ` [${x.activity || '-'} T=${x.T}${g.select.division && g.select.division.item && g.select.division.item[i] ? `・物 ${g.select.division.item[i].item} s=${g.select.division.item[i].s}` : ''}${x.noDivision != null ? `・分業なし ${x.noDivision}` : ''}]` : '')
  + ` P=${JSON.stringify(x.P || {})}`).join('\n      ') : '(点なし)');

function needsOf(who, start) {
  const persona = P(who);
  const n = new Needs({ cfg: { ...needsConfig(cfg, persona), start }, temperament: persona.temperament });
  n.lastTime = 28000;
  return n;
}

async function demoB() {
  const who = 'Sayaka';
  const inv = [{ name: 'stone_axe', count: 1 }, { name: 'cobblestone', count: 4 }, { name: 'stick', count: 3 }, { name: 'oak_planks', count: 2 }, { name: 'bread', count: 2 }];
  const raw = RAW(who, inv);
  const FIXED = JSON.stringify({ goals: [
    { kind: 'item', target: 'oak_log', count: 4, why: '木を集める', need: '物が欲しい' },
    { kind: 'item', target: 'stone_axe', count: 2, why: '道具を作る', need: '物が欲しい' },
    { kind: 'person', target: 'Ken', give: 'stone_axe', why: '渡す', need: '人の役に立ちたい' },
    { kind: 'person', target: 'Mio', give: 'stone_axe', why: '渡す', need: '人の役に立ちたい' },
  ] });
  const fallback = [{ from: 'Ken', form: 'near', text: 'stone_axe 持ってない？素手だと木が全然切れなくて' }, { from: 'Mio', form: 'mutter', text: '(ひとりごと) 石の斧があればなあ…' }];
  const heardOf = (sel) => {
    const pick = (from, form) => VOICES.find((v) => v.from === from && v.form === form) || fallback.find((v) => v.from === from);
    return sel === 'ken' ? [pick('Ken', 'near')] : sel === 'mio' ? [pick('Mio', 'mutter')] : sel === 'both' ? [pick('Ken', 'near'), pick('Mio', 'mutter')] : [];
  };
  for (const mode of ['fixed', 'full']) {
    for (const sel of ['none', 'mio', 'ken', 'both']) {
      const persona = P(who);
      const d = new Division({ cfg: cfg.division, temperament: persona.temperament, drives: (needsConfig(cfg, persona).drives) || {}, me: who });
      const hs = heardOf(sel);
      for (const h of hs) d.noteHeard(h.from, h.text, 9);
      d.update({ tick: 10 });
      const needs = needsOf(who, { hunger: 0.15, greed: 0.3, safety: 0.2, connection: 0.4, care: 0.5 });
      const r = await runScene({ who, raw, needs, division: d, fixedText: mode === 'fixed' ? FIXED : null, mockGoals: JSON.parse(FIXED).goals, heardText: hs.map((h) => `${h.from}「${h.text}」`).join('\n') });
      const rec = { demo: 'b', mode, heard: hs.map((h) => `${h.from}「${h.text}」`), sItem: d.sItem, shortage: d.stimulusText(), chosen: brief(r.g),
        proposals: r.pr ? (r.pr.proposals || []).map((p) => `${p.kind === 'person' ? `${p.target}${p.give ? `に${p.give}を渡す` : 'の近く'}` : p.target}${p.ok ? '' : ` (外した: ${p.result})`}`) : null, scores: r.g && r.g.select ? r.g.select.scores : null };
      out.push(rec);
      log(`\n## (b) [${mode}] Sayaka が聞いた: ${rec.heard.join(' / ') || 'なし'}`);
      log(`  物の刺激 sItem: ${JSON.stringify(d.sItem)}  T(crafting) ${d.T.crafting} T(social) ${d.T.social}`);
      if (rec.shortage) log(`  2B に: ${rec.shortage.replace(/\n/g, ' / ')}`);
      if (mode === 'full') log(`  案: ${(rec.proposals || []).join(' / ')}`);
      log(`  点 [${r.g && r.g.select ? r.g.select.decidedBy || r.g.select.rule : '-'}]:\n      ${scoreLine(r.g)}`);
      log(`  → ${rec.chosen}`);
    }
  }
}

async function demoC() {
  const who = 'Kaori';
  const FIXED = JSON.stringify({ goals: [
    { kind: 'item', target: 'cobblestone', count: 8, why: '石を集める', need: '物が欲しい' },
    { kind: 'item', target: 'stone_pickaxe', count: 2, why: '道具', need: '物が欲しい' },
    { kind: 'item', target: 'wheat', count: 4, why: '食べ物', need: '空腹' },
  ] });
  for (const mode of ['fixed', 'full']) {
    for (const worn of [false, true]) {
      const used = worn ? 105 : 0;
      const inv = [{ name: 'stone_pickaxe', count: 1 }, { name: 'cobblestone', count: 2 }, { name: 'stick', count: 4 }, { name: 'oak_planks', count: 3 }, { name: 'bread', count: 1 }];
      const raw = RAW(who, inv, [blk('coal_ore', 7, 4, true)]);
      raw.tools = [{ name: 'stone_pickaxe', used, max: 131, left: 131 - used, frac: Math.round(((131 - used) / 131) * 1000) / 1000 }];
      const needs = needsOf(who, { hunger: 0.2, greed: 0.5, safety: 0.2, connection: 0.3 });
      // 使う速さ: 少し前の判断では耐久の減りが少なかった (石を掘っていた)
      if (worn) { needs.update({ time: 26800, timeOfDay: 2800, food: 18, saturation: 3, inventory: inv, tools: [{ ...raw.tools[0], used: 80, left: 51, frac: 0.39 }] }); needs.ant.toolSeen.stone_pickaxe.lastUse = 26800; }
      needs.update({ time: 28000, timeOfDay: 4000, food: 18, saturation: 3, inventory: inv, tools: raw.tools });
      const later = needs.later({ minRatio: cfg.goalPath.select.laterMinRatio ?? 0.6 });
      const r = await runScene({ who, raw, needs, fixedText: mode === 'fixed' ? FIXED : null, mockGoals: JSON.parse(FIXED).goals, later: true });
      const rec = { demo: 'c', mode, worn, toolV: needs.ant.v.tool, later: later.map((x) => `${x.need} ${x.distress}: ${x.text}`), laterEn: later.filter((x) => x.need === 'tool').map((x) => x.textEn), chosen: brief(r.g),
        proposals: r.pr ? (r.pr.proposals || []).map((p) => `${p.target}${p.count ? ` x${p.count}` : ''}${p.ok ? '' : ` (外した: ${p.result})`}`) : null, scores: r.g && r.g.select ? r.g.select.scores : null };
      out.push(rec);
      log(`\n## (c) [${mode}] Kaori の stone_pickaxe: ${worn ? '耐久 26/131 (使っている・予備なし)' : '満タン'}  先の道具切れ ${rec.toolV}`);
      for (const l of rec.later) log(`  先のつらさ: ${l}`);
      for (const l of rec.laterEn) log(`  Jev に (later.tool): ${l}`);
      if (mode === 'full') log(`  案: ${(rec.proposals || []).join(' / ')}`);
      log(`  点 [${r.g && r.g.select ? r.g.select.decidedBy || r.g.select.rule : '-'}]:\n      ${scoreLine(r.g)}`);
      log(`  → ${rec.chosen}`);
    }
  }
}

async function demoD() {
  const who = 'Ken';
  const d = new Division({ cfg: cfg.division, temperament: P(who).temperament, me: who });
  d.noteToolUse('Mai', 'wood', 'wooden', 1); d.noteToolUse('Sota', 'mining', 'stone', 1); d.noteToolUse('Mio', 'wood', 'hand', 2);
  d.noteBreakSeen('Mai', 'wooden_axe', 3); d.noteHeard('Sota', 'stone_pickaxe が壊れた', 4); d.noteHeard('Mio', '(ひとりごと) 石の斧があればなあ', 5);
  const chests = [{ id: 'Ken-3', items: [{ name: 'oak_log', count: 12 }, { name: 'bread', count: 3 }], known: true, pos: { x: 3, y: 64, z: 3 } }];
  d.update({ tick: 6, chests, selfTypes: ['axe', 'pickaxe'] });
  const toolFacts = d.toolFactsText({ mine: [{ name: 'stone_axe', left: 40, max: 131 }] });
  log(`\n## (d) 提案 (Ken。共有のチェスト Ken-3 あり)\n  道具の事実:\n    ${toolFacts.replace(/\n/g, '\n    ')}`);
  for (let i = 0; i < (mock ? 1 : 3); i++) {
    const r = await talker.propose({ ...talkCtxOf(who), items: ['stone_axe', 'stone_pickaxe', 'cobblestone', 'oak_log', 'stick', 'bread', 'wooden_axe'], chests: [{ id: 'Ken-3', text: '南東4・oak_log 12・bread 3' }], hereChest: false, toolFacts });
    out.push({ demo: 'd', try: i, proposal: r.proposal, error: r.error });
    log(`  [${i + 1}] ${r.proposal ? `${JSON.stringify(r.proposal.spec)} 「${r.proposal.text}」` : `(なし) ${r.error || r.rawOutput}`}`);
  }
}

async function main() {
  if (!ONLY || ONLY === 'a') await demoA();
  if (!ONLY || ONLY === 'b') await demoB();
  if (!ONLY || ONLY === 'c') await demoC();
  if (!ONLY || ONLY === 'd') await demoD();
  if (json) console.log(JSON.stringify(out, null, 2));
  const u = meter.summary();
  if (!mock) console.error(`\nJev ${u.jev.calls} 回・${u.jev.inputTokens} トークン${u.jev.costUsd != null ? `・$${u.jev.costUsd}` : ''}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
