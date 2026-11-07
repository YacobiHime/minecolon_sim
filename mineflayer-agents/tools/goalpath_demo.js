#!/usr/bin/env node
'use strict';
// 2B を実際に呼んで、欲求の言葉を入れたときのゴール (kind/target/why/need) と、planner の道筋を出す (bot・Jev なし)。
//   LLM_BASE_URL=http://192.168.15.30:18081 node tools/goalpath_demo.js [--json] [--only 名前] [--select] [--seed N]
//   --select: ゴールの選び方 (R1) を使う。2B が案を k 個 → Jev (本物、/root/.config/typesafe.env のキー) に 案 × 欲求 の noul → 点の最大。
//             欲求の値は場面ごとの needs (Needs モデルに入れて pressing を作る)
//   --provider luna: ゴールの案を gpt-6-luna で (キーは /root/.config/luna.env。自由記述 freeform は 'auto' で入る)。--freeform off で enum のまま
//   --examples N: 自由記述のとき例に見せる物の数 (freeform.maxExamples)
//   --k N: 案の数 (無ければ config の提供元ごとの既定)。--jev-provider typesafe|openrouter: Jev の提供元
const { GoalPath, statePathText } = require('../src/goalpath');
const { summarizeObservation } = require('../src/observe');
const { pathText } = require('../src/planner');
const knowledge = require('../src/knowledge');
const { loadConfig } = require('../src/config');
const path = require('path');
const { Needs } = require('../src/needs');
const { JevDecider } = require('../src/deciders/jev');
const { UsageMeter } = require('../src/usage');
const { Order } = require('../src/order');
const { llmOptsFor } = require('../src/llm_provider');
const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
// 場面ごとの欲求の値 (--select のとき。worst と合うように)
const NEEDS_OF = { Yuki: { safety: 0.6, sleep: 0.4 }, Taro: { hunger: 0.85 }, Jiro: { sleep: 0.9, _missed: 2 }, Hanako: { connection: 0.75, care: 0.6 }, Ken: { curiosity: 0.75 } };

const cfg = loadConfig(path.join(__dirname, '..', 'configs', 'survival_3days.json'));
const persona = (n) => cfg.personas.find((p) => p.name === n);
const blk = (name, x, z, notable = false) => ({ name, notable, diggable: true, seen: 3, nearest: { x, y: 64, z, d: Math.round(Math.hypot(x, z)) }, positions: [] });
const self = (name, tod, day = 0) => ({ name, pos: { x: 0, y: 64, z: 0 }, health: 20, food: 16, timeOfDay: tod, phase: tod < 12000 ? '昼' : tod < 13000 ? '夕方' : '夜', day });
const JUNGLE = [blk('jungle_log', 8, -6, true), blk('grass_block', 1, 0), blk('grass', 2, 1), blk('jungle_leaves', 7, -5), blk('vine', 6, -4)];

const SCENARIOS = [
  { who: 'Yuki', raw: { self: self('Yuki', 11500), inventory: [], blocks: JUNGLE, entities: [{ kind: 'player', name: 'Ken', pos: { x: 6, y: 64, z: 3 }, d: 7 }] },
    social: '少しお腹が空いた。少し眠い。もうすぐ暗くなるし、外にいるので少し落ち着かない', worst: { need: 'safety', text: 'もうすぐ暗くなるし、外にいるので少し落ち着かない' } },
  { who: 'Taro', raw: { self: self('Taro', 5000), inventory: [{ name: 'jungle_log', count: 3 }], blocks: [...JUNGLE, blk('stone', 10, 4)], entities: [{ kind: 'mob', name: 'cow', pos: { x: 12, y: 64, z: 2 }, d: 12 }] },
    social: 'お腹がぺこぺこ。ここに来てから何も食べていない。眠くない。落ち着いている', worst: { need: 'hunger', text: 'お腹がぺこぺこ。ここに来てから何も食べていない' } },
  { who: 'Jiro', raw: { self: self('Jiro', 9000, 2), inventory: [{ name: 'jungle_planks', count: 6 }, { name: 'stick', count: 4 }, { name: 'crafting_table', count: 1 }], blocks: JUNGLE, entities: [{ kind: 'mob', name: 'sheep', pos: { x: -9, y: 64, z: 3 }, d: 9 }] },
    social: 'お腹は空いていない。二晩ちゃんと寝ていない。眠くてたまらない。落ち着いている。かなり参っている', worst: { need: 'sleep', text: '二晩ちゃんと寝ていない。眠くてたまらない' } },
  { who: 'Hanako', raw: { self: self('Hanako', 3000, 1), inventory: [{ name: 'bread', count: 3 }, { name: 'jungle_log', count: 2 }], blocks: JUNGLE,
    entities: [{ kind: 'player', name: 'Jiro', pos: { x: -5, y: 64, z: 8 }, d: 9 }, { kind: 'player', name: 'Taro', pos: { x: 12, y: 64, z: 0 }, d: 12 }] },
    social: 'お腹は空いていない。眠くない。落ち着いている。ひとりぼっちで寂しい。誰かの役に立ちたい', worst: { need: 'connection', text: 'ずっと誰とも一緒に何もしていなくて寂しい' },
    people: [{ name: 'Jiro', relation: '知り合い', seen: '西5南8(9m)' }, { name: 'Taro', relation: '感じが良い', seen: '東12(12m)' }] },
  { who: 'Ken', raw: { self: self('Ken', 2000, 0), inventory: [{ name: 'wooden_pickaxe', count: 1 }, { name: 'jungle_log', count: 1 }], blocks: [...JUNGLE, blk('stone', 4, 4), blk('coal_ore', 9, 2, true)], entities: [] },
    social: 'お腹は空いていない。眠くない。落ち着いている。知らない所を見てみたくてうずうずする', worst: { need: 'curiosity', text: '知らない所を見てみたい' } },
  { who: 'Yuki', label: 'Yuki (夜・拠点あり)', raw: { self: self('Yuki', 15000, 1), inventory: [{ name: 'jungle_planks', count: 4 }, { name: 'stick', count: 2 }], blocks: [...JUNGLE, blk('crafting_table', 2, 2, true)], entities: [{ kind: 'hostile', name: 'zombie', pos: { x: 10, y: 64, z: -10 }, d: 14 }] },
    base: { x: 3, y: 64, z: 3 }, baseText: '拠点 (M1) の近く: crafting_table 1、chest 1、暗い、囲まれていない',
    social: 'お腹が空いた。眠い。暗いし、敵が近いので怖い。気が張っている', worst: { need: 'safety', text: '暗いし、敵が近いので怖い' } },
];

async function main() {
  const json = process.argv.includes('--json');
  const oi = process.argv.indexOf('--only');
  const only = oi >= 0 ? process.argv[oi + 1] : null;
  const baseUrl = process.env.LLM_BASE_URL || 'http://192.168.15.30:18081';
  const kn = knowledge.loadFacts(cfg.knowledge.file);
  const out = [];
  const select = process.argv.includes('--select');
  const si = process.argv.indexOf('--seed');
  const meter = new UsageMeter();
  const jevProvider = arg('--jev-provider');
  const jev = select ? new JevDecider({ ...(cfg.decider.jev || {}), ...(jevProvider ? { provider: jevProvider } : {}), timeoutMs: 60000, meter }) : null;
  const provider = arg('--provider') || 'local';
  const kArg = arg('--k');
  const ffArg = arg('--freeform');
  const llmOpts = provider === 'local' ? { ...cfg.decider.llm, baseUrl } : llmOptsFor({ ...cfg, llm: { ...(cfg.llm || {}), provider } }, 'goal', (cfg.goalPath && cfg.goalPath.llm) || {});
  for (const sc of SCENARIOS) {
    if (only && sc.who !== only) continue;
    const ev = [];
    const exArg = arg('--examples');
    const ffCfg = { ...(cfg.goalPath.freeform || {}), ...(ffArg ? { enabled: ffArg === 'on' } : {}), ...(exArg ? { maxExamples: Number(exArg) } : {}) };
    const gp = new GoalPath({ cfg: { ...cfg.goalPath, freeform: ffCfg,
      select: { ...(cfg.goalPath.select || {}), enabled: select, ...(kArg ? { k: Number(kArg) } : {}) } }, llmOpts, log: (e) => ev.push(e),
      jev, order: new Order({ enabled: true, seed: si >= 0 ? Number(process.argv[si + 1]) : 1 }) });
    const nv = NEEDS_OF[sc.who] || {};
    const needs = new Needs({ cfg: { start: Object.fromEntries(Object.entries(nv).filter(([k]) => !k.startsWith('_'))) } });
    needs.missedNights = nv._missed || 0; needs.lastTime = 9000;
    const raw = { heard: [], craft: { now: [], withTable: [] }, tableNearby: sc.raw.blocks.find((b) => b.name === 'crafting_table') ? { x: 2, y: 64, z: 2 } : null, ...sc.raw };
    const obsText = summarizeObservation(raw, { showDay: true }) + (sc.baseText ? `\n${sc.baseText}` : '');
    const facts = () => knowledge.selectFacts(kn, { names: knowledge.namesInView({ raw }), max: cfg.knowledge.max }).map((f) => f.text);
    const people = sc.people || raw.entities.filter((e) => e.kind === 'player').map((e) => ({ name: e.name, relation: '知らない人', seen: `${e.d}m` }));
    for (const n of ['Taro', 'Hanako', 'Jiro', 'Yuki', 'Ken']) if (n !== sc.who && !people.some((p) => p.name === n)) people.push({ name: n, relation: '知らない人', seen: null });
    const ctx = { persona: persona(sc.who), goalText: '', obsText, raw, facts, allFacts: kn, memText: '覚えている場所: なし\nやったこと: まだ何もしていない', socialText: sc.social, worst: sc.worst,
      peopleText: people.map((p) => `${p.name}: ${p.relation}。${p.seen ? `今は${p.seen}にいる` : '今は見えない'}`).join('\n'), people,
      places: sc.base ? [{ id: 'M1', kind: '拠点', label: '拠点 南東3' }] : [], placeKinds: sc.base ? ['拠点', 'crafting_table', 'chest'] : [], base: sc.base || null, needNow: () => 0.7,
      pressing: (o) => needs.pressing(o), later: (o) => needs.later(o) };
    const t0 = Date.now();
    await gp.update(ctx, 1);
    const g = ev.filter((e) => e.kind === 'goal' || e.kind === 'unplannable' || e.kind === 'proposals');
    const r = { who: sc.label || sc.who, worst: sc.worst.need, goals: g.map((e) => ({ kind: e.goalKind, target: e.target, count: e.count, give: e.give, why: e.why, need: e.need, ok: e.ok, raw: e.rawOutput, promptTokens: e.promptTokens, completionTokens: e.completionTokens, ms: e.ms, error: e.error, proposals: e.proposals || null, select: e.select || null,
        diversity: e.diversity || null, rewrites: e.rewrites || null, textJev: e.textJev || null, written: e.written || null })),
      plan: gp.planText(), path: gp.path ? (gp.goal && gp.goal.kind === 'state' ? statePathText(gp.path, { maxShown: 20 }) : pathText(gp.path, { maxShown: 20 })) : null, ms: Date.now() - t0 };
    out.push(r);
    if (!json) {
      console.log(`\n## ${r.who} (いちばんつらい: ${r.worst})`);
      for (const x of r.goals) console.log(`  2B: ${x.ok ? `${x.kind} ${x.target}${x.count ? ` ×${x.count}` : ''}${x.give ? ` give=${x.give}` : ''} / why: ${x.why} / need: ${x.need}` : `(${x.error || '読めない/たどれない'}) ${x.raw || ''}`} [入力 ${x.promptTokens} / 出力 ${x.completionTokens} トークン, ${x.ms}ms]`);
      for (const x of r.goals) if (x.proposals) console.log(`  案:\n${x.proposals.map((p) => `    ${p.round ? `[書き直し${p.round}] ` : ''}${p.written && p.written !== p.target ? `「${p.written}」→ ` : ''}${p.kind || '?'} ${p.target || ''}${p.count ? ` ×${p.count}` : ''}${p.via ? ` [${p.via}]` : ''} (${p.need || '-'}${p.ok ? '' : `、外した: ${p.result}${p.reason ? ` — ${p.reason}` : ''}`}${p.replaced ? '、書き直させた' : ''})`).join('\n')}`);
      for (const x of r.goals) if (x.diversity) console.log(`  広がり: ${JSON.stringify(x.diversity)}`);
      for (const x of r.goals) for (const w of x.rewrites || []) console.log(`  書き直し${w.round}: ${w.asked} 案を頼んで ${w.ok} 案が使えた [入力 ${w.promptTokens} / 出力 ${w.completionTokens}, ${w.ms}ms]`);
      for (const x of r.goals) if (x.select) console.log(`  選び方 [${x.select.rule}] 欲求 ${x.select.needs.map((n) => `${n.need}=${n.distress}`).join(' ')} / ${x.select.scores.map((sc2, i) => `${i === x.select.chosen ? '*' : ''}${sc2.target}=${sc2.score} ${JSON.stringify(sc2.P)}`).join(' / ')}${x.select.jev ? ` (Jev ${x.select.jev.inputTokens} トークン)` : ''}`);
      console.log(`  Jev の plan: ${r.plan}`);
      if (r.path && r.path !== r.plan) console.log(`  道筋 (全部): ${r.path}`);
    }
  }
  if (json) console.log(JSON.stringify(out, null, 2));
  if (select) console.log(`\nJev 合計 ${meter.summary().jev.inputTokens} トークン (${meter.summary().jev.calls} 回)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
