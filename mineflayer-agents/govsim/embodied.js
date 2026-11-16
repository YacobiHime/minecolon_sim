#!/usr/bin/env node
'use strict';
// GovSim の漁場の Minecraft の中の版 (embodied) を1回動かす。文字の版は govsim/run.js。
// 使い方 (サーバーが動いていて、実験用のワールドであること。準備は PR の「動かし方」):
//   node govsim/embodied.js --agents 5 --months 12 --mental on --seed 1 --llm-provider luna --max-llm-usd 3
// 引数 (文字の版と同じもの): --agents --months --seed --variant default|no-language --mental on|off --names persona|govsim
//   --llm-provider --llm-model --llm-base-url --max-llm-usd --temperature --reasoning-effort --mental-config --higher-needs --out
// Minecraft の中の版だけの引数:
//   --month-ticks T      1か月のゲームの時間 (tick。既定 6000 = 1/4 日 = 実時間 5 分)。漁 50%・話し合い 30%・振り返り 20%
//   --tons-per-fish K    1匹が何トンか (既定 2。容量 100 トン = 50 匹)
//   --witness-range R    人が魚を取るのを見分けられる距離 (ブロック。既定 16。見通しも要る)
//   --stagger F          漁の時間のうち、家を出る時刻を散らす割合 (既定 0.4。人ごとに種で決める)
//   --hunger-per-month H 1か月に減る満腹度 (点。既定 12。空腹の効果 hunger II の長さで決める)
//   --mayor-report on    文字の版と同じ村長の報告 (全員の取った量) を話し合いの初めに出す (既定 off。情報の違いだけを切り分けるため)
//   --site S             場所の番号 (既定 0。200 ブロックずつずらす。同時に動かすときは別の番号と別の種)
//   --origin x,y,z       場所の原点を直接決める   --no-world-rules  世界の決まり (難易度・昼で止める等) を送らない
//   --mc-dir DIR (既定 /root/mc-server-fabric)  --host H --port P
//   --world fake         サーバー無しの偽物の world で流れだけ試す (LLM は本物)
// 書くもの: DIR/events.jsonl・DIR/summary.json (文字の版と同じ形 + mode: 'embodied'・embodied: {...})。API キーは表示も記録もしない。
const fs = require('fs');
const path = require('path');
const { parseArgs, onoff, makeLlm } = require('./run');
const { runEmbodied, choosePersonas, EMBODIED_VARIANTS } = require('./embodied_sim');
const { loadMentalConfig, DEFAULT_CONFIG } = require('./mental');
const { redact } = require('../src/llm_provider');

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const variant = a.variant || 'default';
  if (!EMBODIED_VARIANTS.includes(variant)) throw new Error(`--variant は ${EMBODIED_VARIANTS.join('|')}`);
  const mental = onoff(a.mental, false);
  const seed = Number(a.seed ?? 1);
  const agentsN = Number(a.agents || 5);
  const site = Number(a.site || 0);
  const monthTicks = Number(a['month-ticks'] || 6000);
  const k = Number(a['tons-per-fish'] || 2);
  const { llm, provider, info: llmInfo } = makeLlm(a);
  const mentalConfig = loadMentalConfig(a['mental-config'] || DEFAULT_CONFIG);
  const personas = choosePersonas({ seed, agents: agentsN, mentalConfig, names: a.names || 'persona' });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = a.out || path.join(__dirname, '..', 'runs', 'govsim', `${stamp}_embodied_${provider}_${variant}_${mental ? 'on' : 'off'}_s${seed}`);
  fs.mkdirSync(out, { recursive: true });
  const ev = fs.createWriteStream(path.join(out, 'events.jsonl'));
  const log = (o) => ev.write(`${JSON.stringify({ t: new Date().toISOString(), ...o })}\n`);

  let world;
  if (a.world === 'fake') {
    const { FakeWorld } = require('./embodied_fake');
    world = new FakeWorld({ names: personas.map((p) => p.name) });
  } else {
    const { MinecraftWorld } = require('./embodied_world');
    let origin = null;
    if (a.origin) { const [x, y, z] = String(a.origin).split(',').map(Number); origin = { x, y: Number.isFinite(y) ? y : null, z }; }
    world = new MinecraftWorld({ personas, site, mcDir: a['mc-dir'] || '/root/mc-server-fabric', host: a.host || 'localhost', port: Number(a.port || 25565), tonsPerFish: k, log,
      witnessRange: Number(a['witness-range'] || 16), hungerPerMonth: Number(a['hunger-per-month'] ?? 12), monthTicks, origin });
    await world.setup({ rules: !a['no-world-rules'] });
  }
  const t0 = Date.now();
  let summary;
  try {
    summary = await runEmbodied({
      world, llm, log, personas, mentalConfig, mental, variant, seed, agents: agentsN, months: a.months ? Number(a.months) : 12, tonsPerFish: k, monthTicks,
      staggerFrac: a.stagger != null ? Number(a.stagger) : 0.4, mayorReport: onoff(a['mayor-report'], false), higherNeeds: onoff(a['higher-needs'], false),
    });
  } catch (e) {
    log({ type: 'error', error: redact(String(e && e.stack ? e.stack : e)) });
    throw e;
  } finally {
    if (world.teardown) await world.teardown();
  }
  summary.llm = llmInfo();
  summary.wallSec = Math.round((Date.now() - t0) / 1000);
  summary.out = out;
  summary.embodied.site = site;
  summary.embodied.world = a.world === 'fake' ? 'fake' : 'minecraft';
  summary.embodied.witnessRange = Number(a['witness-range'] || 16);
  summary.embodied.hungerPerMonth = Number(a['hunger-per-month'] ?? 12);
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  ev.end();
  const mm = summary.metrics;
  console.log(JSON.stringify({ out, mode: 'embodied', variant, mental, seed, survivalMonths: mm.survivalMonths, collapsed: mm.collapsed, gain: mm.gain, efficiency: mm.efficiency, equality: mm.equality,
    overUsage: mm.overUsage, parseFailures: summary.parseFailures, llmCalls: summary.llmCalls, costUsd: summary.llm.costUsd, wallSec: summary.wallSec, info: summary.embodied.information }));
  setTimeout(() => process.exit(0), 500);
}

if (require.main === module) {
  main().catch((e) => { console.error(redact(String(e && e.message ? e.message : e))); setTimeout(() => process.exit(1), 500); });
}
