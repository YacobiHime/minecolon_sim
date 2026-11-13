#!/usr/bin/env node
'use strict';
// 使い方: node mineflayer-agents/run.js --config mineflayer-agents/configs/wood_pickaxe.json [--minutes 15]
//         [--llm http://127.0.0.1:18081] [--name Taro] [--host 127.0.0.1] [--port 25565] [--decider llm|split|random]
// LLM の窓口は --llm か環境変数 LLM_BASE_URL (既定 http://127.0.0.1:18081)。
const { loadConfig } = require('./src/config');
const { createDecider } = require('./src/deciders');
const { Agent } = require('./src/agent');

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

async function main() {
  const args = parseArgs(process.argv);
  if (!args.config) {
    console.error('usage: node run.js --config <file> [--minutes N] [--llm URL] [--name NAME] [--decider llm|split|random]');
    process.exit(2);
  }
  const ov = {};
  if (args.minutes) ov.loop = { minutes: Number(args.minutes) };
  if (args.name) ov.persona = { name: args.name };
  if (args.host || args.port) ov.server = { ...(args.host ? { host: args.host } : {}), ...(args.port ? { port: Number(args.port) } : {}) };
  const llmUrl = args.llm || process.env.LLM_BASE_URL;
  if (llmUrl || args.decider) ov.decider = { ...(args.decider ? { type: args.decider } : {}), ...(llmUrl ? { llm: { baseUrl: llmUrl } } : {}) };
  const cfg = loadConfig(args.config, ov);

  const agent = new Agent(cfg, { decider: createDecider(cfg.decider) });
  const stop = () => { console.log('stopping...'); agent.stop(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('unhandledRejection', (e) => console.log('unhandledRejection:', e && e.message));
  await agent.connect();
  console.log(`[${cfg.persona.name}] spawned. goal: ${cfg.goal.text}  decider: ${agent.decider.kind}  record: ${agent.recorder.file}`);
  const r = await agent.run();
  console.log('done', JSON.stringify(r));
  setTimeout(() => process.exit(0), 500);
}

main().catch((e) => { console.error(e); process.exit(1); });
