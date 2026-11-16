#!/usr/bin/env node
'use strict';
// GovSim の漁場 (文字だけ) を1回動かす。Minecraft のサーバーは要らない。
// 使い方:
//   node govsim/run.js --agents 5 --months 12 --mental on --variant default --seed 1 --llm-provider luna --max-llm-usd 2
// 引数:
//   --agents N (既定 5)  --months M (既定 12、outsider は 15)  --seed S (既定 1)
//   --variant default|universalization|no-language|outsider   --allocation stochastic|proportional
//   --mental on|off (既定 off)  --names persona|govsim (既定 persona: survival_100 の persona から種で選んだ名前。govsim: John・Kate・Jack・Emma・Luke)
//   --llm-provider local|luna (既定 luna)  --llm-model M  --llm-base-url URL  --max-llm-usd X (既定 5)  --temperature T (既定 0 = GovSim と同じ)
//   --reasoning-effort none|low|... (luna。既定 none)  --subsistence T (mental on: 何トンで満腹か。既定 f0 = 10)
//   --mental-config FILE (既定 configs/survival_100.json)  --out DIR (既定 runs/govsim/<日時>_<variant>_<mental>_s<seed>)
//   --higher-needs on|off (mental on: 上の欲求を動かすか。既定 off。govsim/mental.js の説明)
//   --govsim-outsider-bug (outsider の f(t) を元と同じく最初の人数で割る)
// 書くもの: DIR/events.jsonl (全部の出来事と LLM の呼び出し)・DIR/summary.json (指標・失敗の数・呼び出しの数・費用)
// API キーは表示も記録もしない (src/llm_provider.js が読む)。
const fs = require('fs');
const path = require('path');
const { runSim, VARIANTS } = require('./sim');
const { loadMentalConfig, DEFAULT_CONFIG } = require('./mental');
const { llmOptsFor, checkKeys, redact } = require('../src/llm_provider');
const { LLMDecider, LLM_USAGE } = require('../src/deciders/llm');

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const key = k.slice(2);
    const v = argv[i + 1];
    if (v == null || v.startsWith('--')) a[key] = true; else { a[key] = v; i++; }
  }
  return a;
}

function onoff(v, def) { if (v == null) return def; return v === true || v === 'on' || v === 'true' || v === '1'; }

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const variant = a.variant || 'default';
  if (!VARIANTS.includes(variant)) throw new Error(`--variant は ${VARIANTS.join('|')}`);
  const mental = onoff(a.mental, false);
  const seed = Number(a.seed ?? 1);
  const provider = a['llm-provider'] || 'luna';
  const maxUsd = a['max-llm-usd'] != null ? Number(a['max-llm-usd']) : 5;
  const temperature = a.temperature != null ? Number(a.temperature) : 0;
  const prov = {};
  if (a['llm-model']) prov.model = a['llm-model'];
  if (a['llm-base-url']) prov.baseUrl = a['llm-base-url'];
  if (a['reasoning-effort']) prov.reasoningEffort = a['reasoning-effort'];
  const cfg = { llm: { provider, providers: { [provider]: prov }, maxUsd } };
  for (const k of checkKeys(cfg)) if (!k.ok) throw new Error(k.error);
  LLM_USAGE.reset();
  LLM_USAGE.maxUsd = maxUsd;
  const deciders = {};
  const deciderFor = (role) => {
    if (!deciders[role]) deciders[role] = new LLMDecider({ ...llmOptsFor(cfg, role, { temperature }), temperature, timeoutMs: provider === 'local' ? 180000 : 120000 });
    return deciders[role];
  };
  const llm = async ({ role, prompt, maxTokens }) => {
    const d = deciderFor(role);
    const r = await d.complete([{ role: 'user', content: prompt }], null, { maxTokens, temperature });
    return { text: r.text, finishReason: r.finishReason, costUsd: r.costUsd };
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = a.out || path.join(__dirname, '..', 'runs', 'govsim', `${stamp}_${provider}_${variant}_${mental ? 'on' : 'off'}_s${seed}`);
  fs.mkdirSync(out, { recursive: true });
  const ev = fs.createWriteStream(path.join(out, 'events.jsonl'));
  const log = (o) => ev.write(`${JSON.stringify({ t: new Date().toISOString(), ...o })}\n`);
  const mentalConfig = loadMentalConfig(a['mental-config'] || DEFAULT_CONFIG);
  const t0 = Date.now();
  let summary;
  try {
    summary = await runSim({
      agents: Number(a.agents || 5), months: a.months ? Number(a.months) : undefined, variant, seed, mental, allocation: a.allocation || 'stochastic',
      names: a.names || 'persona', subsistence: a.subsistence != null ? Number(a.subsistence) : undefined, govsimOutsiderBug: !!a['govsim-outsider-bug'], higherNeeds: onoff(a['higher-needs'], false),
      mentalConfig, llm, log,
    });
  } catch (e) {
    log({ type: 'error', error: redact(String(e && e.stack ? e.stack : e)) });
    ev.end();
    throw e;
  }
  const usage = LLM_USAGE.summary();
  const firstDecider = Object.values(deciders)[0];
  summary.llm = { provider, model: firstDecider ? firstDecider.model : null, temperature, reasoningEffort: firstDecider ? firstDecider.reasoningEffort : null, usage, costUsd: usage.costUsd, exceeded: usage.exceeded };
  summary.wallSec = Math.round((Date.now() - t0) / 1000);
  summary.out = out;
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  ev.end();
  const mm = summary.metrics;
  console.log(JSON.stringify({ out, variant, mental, seed, survivalMonths: mm.survivalMonths, collapsed: mm.collapsed, gain: mm.gain, efficiency: mm.efficiency, equality: mm.equality,
    overUsage: mm.overUsage, parseFailures: summary.parseFailures, llmCalls: summary.llmCalls, costUsd: usage.costUsd, wallSec: summary.wallSec }));
}

if (require.main === module) {
  main().catch((e) => { console.error(redact(String(e && e.message ? e.message : e))); process.exit(1); });
}

module.exports = { parseArgs };
