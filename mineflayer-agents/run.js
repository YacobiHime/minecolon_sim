#!/usr/bin/env node
'use strict';
// 使い方: node mineflayer-agents/run.js --config mineflayer-agents/configs/first_setting.json [--agents 1|5|30] [--minutes 15]
//         [--decider llm|split|jev|random] [--llm http://127.0.0.1:18081] [--name Taro] [--host 127.0.0.1] [--port 25565]
//         [--max-jev-tokens 3000000] [--stagger-ms 1500]
// 1プロセスで --agents 人を動かす。Jev の使用量の上限・2B の窓口は全員で共有する。
// 記録は runs/<時刻>/<名前>-<時刻>.jsonl (1人1ファイル) と runs/<時刻>/run.json (実行の合計)。
// LLM (2B) の窓口は --llm か環境変数 LLM_BASE_URL (既定 http://127.0.0.1:18081)。
// Jev の API キーは環境変数 TYPESAFE_API_KEY か /root/.config/typesafe.env (表示・記録しない)。
const fs = require('fs');
const path = require('path');
const { loadConfig, deepMerge } = require('./src/config');
const { createDecider } = require('./src/deciders');
const { Agent } = require('./src/agent');
const { UsageMeter } = require('./src/usage');
const { Talker } = require('./src/talker');
const { JevClient } = require('./src/jev_client');
const { sleep } = require('./src/util');

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    a[k.slice(2)] = v;
  }
  return a;
}

// i 人目のペルソナ: 設定の personas から順に。足りなければ名前に番号を付けて使い回す
function personaFor(cfg, i) {
  const list = cfg.personas && cfg.personas.length ? cfg.personas : [cfg.persona];
  const p = list[i % list.length];
  const round = Math.floor(i / list.length);
  const name = round ? `${p.name}${round + 1}`.slice(0, 16) : p.name;
  return { ...p, name };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.config) {
    console.error('usage: node run.js --config <file> [--agents N] [--minutes N] [--llm URL] [--decider llm|split|jev|random] [--max-jev-tokens N]');
    process.exit(2);
  }
  const ov = {};
  if (args.minutes) ov.loop = { minutes: Number(args.minutes) };
  if (args.host || args.port) ov.server = { ...(args.host ? { host: args.host } : {}), ...(args.port ? { port: Number(args.port) } : {}) };
  const llmUrl = args.llm || process.env.LLM_BASE_URL;
  if (llmUrl || args.decider) ov.decider = { ...(args.decider ? { type: args.decider } : {}), ...(llmUrl ? { llm: { baseUrl: llmUrl } } : {}) };
  if (args['max-jev-tokens']) ov.usage = { maxJevInputTokens: Number(args['max-jev-tokens']) };
  const base = loadConfig(args.config, ov);
  const n = Math.max(1, Number(args.agents || base.agents || 1));

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runDir = path.join(base.record.dir, stamp);
  fs.mkdirSync(runDir, { recursive: true });
  const meter = new UsageMeter({ maxJevInputTokens: (base.usage && base.usage.maxJevInputTokens) ?? 3000000 });
  const decType = base.decider.type || 'llm';
  let jevClient = null;
  if (decType === 'jev') {
    jevClient = new JevClient(base.decider.jev || {});
    if (!jevClient.hasKey) {
      console.error('Jev の API キーがない (TYPESAFE_API_KEY か /root/.config/typesafe.env)。--decider llm で動かすこと');
      process.exit(2);
    }
  }
  const talker = base.talk && base.talk.enabled === false ? null
    : new Talker({ llmOpts: { ...base.decider.llm, ...(base.talk && base.talk.llm ? base.talk.llm : {}) }, meter });

  const agents = [];
  for (let i = 0; i < n; i++) {
    const persona = personaFor(base, i);
    const cfg = deepMerge(base, { persona: n === 1 && args.name ? { ...persona, name: args.name } : persona });
    const name = cfg.persona.name;
    cfg.memory = { ...cfg.memory, file: base.memory.perRun ? path.join(path.dirname(base.memory.file), stamp, `${name}.json`) : path.join(path.dirname(base.memory.file), `${name}.json`) };
    const decider = createDecider(cfg.decider, {}, { meter, jevClient });
    agents.push(new Agent(cfg, { decider, meter, talker, recordDir: runDir, recordStamp: stamp }));
  }

  const stopAll = (why) => { console.log(`stopping (${why})...`); for (const a of agents) a.stop(); };
  meter.onExceeded((u) => stopAll(`Jev の入力トークンが上限 ${u.jev.maxInputTokens} に達した`));
  process.on('SIGINT', () => stopAll('SIGINT'));
  process.on('SIGTERM', () => stopAll('SIGTERM'));
  process.on('unhandledRejection', (e) => console.log('unhandledRejection:', e && e.message));

  const stagger = Number(args['stagger-ms'] || 1500);
  for (const a of agents) {
    await a.connect();
    console.log(`[${a.cfg.persona.name}] spawned. goal: ${a.cfg.goal.text}  decider: ${a.decider.kind}  talker: ${talker ? talker.kind : '-'}  base: ${JSON.stringify(a.base)}`);
    await sleep(stagger);
  }
  const t0 = Date.now();
  const results = await Promise.all(agents.map((a) => a.run({ runId: stamp, agents: n })));
  const summary = { runId: stamp, config: path.resolve(args.config), agents: n, decider: decType, minutes: Math.round((Date.now() - t0) / 600) / 100, results, usage: meter.summary() };
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(summary, null, 2));
  console.log('done', JSON.stringify({ runDir, usage: summary.usage }));
  setTimeout(() => process.exit(0), 500);
}

main().catch((e) => { console.error(e); process.exit(1); });
