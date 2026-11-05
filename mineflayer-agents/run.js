#!/usr/bin/env node
'use strict';
// 使い方: node mineflayer-agents/run.js --config mineflayer-agents/configs/first_setting.json [--agents 1|5|20] [--minutes 15]
//         [--decider llm|split|jev|random] [--llm http://127.0.0.1:18081] [--name Taro] [--host 127.0.0.1] [--port 25565]
//         [--max-jev-tokens 3000000] [--seed N (選択肢の並べ方の種)] [--stagger-ms 1500] [--procs ceil(N/5)] [--monitor-sec 30] [--random-talk 0.2]
// 1プロセスで --agents 人を動かす。Jev の使用量の上限・2B の窓口は全員で共有する。
// --procs P (P > 1) なら、P 個の子プロセス (node run.js --child) に人を分ける (pathfinder の計算は1プロセスの中では直列なので)。
//   子は同じ runs/<時刻>/ に書き、親が Jev の入力トークンを合計して上限で全員を止め、最後に run.json にまとめる。
// 接続は --stagger-ms ずつずらす (プロセスが複数でも全体で1人ずつ)。つながらなければ 3 回まで再試行する。
// 負荷は --monitor-sec ごとに runs/<時刻>/monitor[-<子の番号>].jsonl (CPU・メモリ・イベントループの遅れ・判断の間隔・2B の待ち・Jev の 429)。
// --random-talk P: --decider random のとき、確率 P で話す (Jev なしで 2B の発言の負荷を試す)。
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
const { Monitor } = require('./src/monitor');
const { mergeUsageSummaries } = require('./src/usage');
const { LLM_STATS } = require('./src/deciders/llm');

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

// n 人を procs 個に分ける (前から順に、なるべく同じ人数)。返り値 [[from, to), ...]
function splitAgents(n, procs) {
  const p = Math.max(1, Math.min(n, procs));
  const out = [];
  let from = 0;
  for (let k = 0; k < p; k++) { const size = Math.floor(n / p) + (k < n % p ? 1 : 0); out.push([from, from + size]); from += size; }
  return out;
}

// 接続 (spawn とチャンクの読み込みまで)。timeoutMs で打ち切り、tries 回まで。失敗した bot の end/kicked は捨てる (stopped を立てさせない)
async function connectWithRetry(a, { tries = 3, timeoutMs = 60000, log = console.log } = {}) {
  for (let i = 1; i <= tries; i++) {
    try {
      let timer;
      await Promise.race([a.connect(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('接続のタイムアウト')), timeoutMs); })]).finally(() => clearTimeout(timer));
      return true;
    } catch (e) {
      log(`[${a.cfg.persona.name}] 接続に失敗 (${i}/${tries}): ${e.message}`);
      const old = a.bot;
      if (old) { old.removeAllListeners('end'); old.removeAllListeners('kicked'); old.on('error', () => {}); try { old.end('retry'); } catch (_) { /* ignore */ } }
      a.stopped = false;
      await sleep(5000 * i);
    }
  }
  return false;
}

// 親: 子プロセスを起こし、Jev の使用量を合計して上限で止め、最後に run.json にまとめる
async function runParent(args, base, n, procs) {
  const { fork } = require('child_process');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runDir = path.join(base.record.dir, stamp);
  fs.mkdirSync(runDir, { recursive: true });
  const cap = (base.usage && base.usage.maxJevInputTokens) ?? 3000000;
  const parts = splitAgents(n, procs);
  const stagger = Number(args['stagger-ms'] || 1500);
  const passArgs = process.argv.slice(2).filter((_, i, arr) => !['--procs'].includes(arr[i]) && !(i > 0 && arr[i - 1] === '--procs'));
  const used = parts.map(() => 0);
  let stopped = false;
  const children = parts.map(([from, to], k) => {
    const c = fork(__filename, [...passArgs, '--child', String(k + 1), '--agent-from', String(from), '--agent-to', String(to), '--agents', String(n),
      '--run-stamp', stamp, '--stagger-ms', String(stagger * parts.length), '--start-delay-ms', String(stagger * k)], { stdio: 'inherit' });
    c.on('message', (m) => {
      if (!m || m.type !== 'usage') return;
      used[k] = m.jevInputTokens || 0;
      const total = used.reduce((x, y) => x + y, 0);
      if (!stopped && total >= cap) {
        stopped = true;
        console.log(`stopping (Jev の入力トークンが全プロセスの合計で上限 ${cap} に達した: ${total})...`);
        for (const cc of children) { try { cc.send({ type: 'stop' }); } catch (_) { /* ignore */ } }
      }
    });
    return c;
  });
  const fwd = (sig) => () => { console.log(`stopping (${sig})...`); for (const c of children) { try { c.send({ type: 'stop' }); } catch (_) { /* ignore */ } } };
  process.on('SIGINT', fwd('SIGINT'));
  process.on('SIGTERM', fwd('SIGTERM'));
  const t0 = Date.now();
  await Promise.all(children.map((c) => new Promise((r) => c.on('exit', r))));
  const partsJson = parts.map((_, k) => { try { return JSON.parse(fs.readFileSync(path.join(runDir, `run-part${k + 1}.json`), 'utf8')); } catch (_) { return null; } });
  const lat = { ms: [], waitMs: [], serverMs: [] };
  for (const pj of partsJson) if (pj && pj.twoBLatencyRaw) for (const k of Object.keys(lat)) lat[k].push(...(pj.twoBLatencyRaw[k] || []));
  const summary = {
    runId: stamp, config: path.resolve(args.config), agents: n, procs: parts.length, decider: base.decider.type || 'llm',
    minutes: Math.round((Date.now() - t0) / 600) / 100,
    results: partsJson.flatMap((pj) => (pj ? pj.results : [])),
    disconnects: partsJson.reduce((s, pj) => s + ((pj && pj.disconnects && pj.disconnects.n) || 0), 0),
    usage: mergeUsageSummaries(partsJson.map((pj) => pj && pj.usage), { maxInputTokens: cap }),
    twoBLatency: LLM_STATS.summarize(lat.ms.map((ms, i) => ({ ms, waitMs: lat.waitMs[i], serverMs: lat.serverMs[i] }))),
  };
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(summary, null, 2));
  console.log('done', JSON.stringify({ runDir, procs: parts.length, usage: summary.usage, twoBLatency: summary.twoBLatency }));
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
  if (args['random-talk']) ov.decider = { ...(ov.decider || {}), talkP: Number(args['random-talk']) };
  // 並べ方の種: --seed か config の order.seed。どちらも無ければここで決め、子プロセスにも --seed で渡す (記録の start と run.json に残る)
  if (args.seed != null) ov.order = { seed: Number(args.seed) >>> 0 };
  const base = loadConfig(args.config, ov);
  if (!base.order || base.order.seed == null) {
    base.order = { ...(base.order || {}), seed: Math.floor(Math.random() * 2 ** 32) >>> 0 };
    args.seed = String(base.order.seed);
    process.argv.push('--seed', args.seed);
  }
  const n = Math.max(1, Number(args.agents || base.agents || 1));
  // 既定は 5人ずつ (20人なら4プロセス)。1プロセスに20人だとイベントループが 1〜2 秒止まり、keepalive で切断された (2026-11-04 の試験)
  const procs = Math.max(1, args.procs ? Number(args.procs) : Math.ceil(n / 5));
  const child = args.child ? Number(args.child) : 0;
  if (!child && procs > 1 && n > 1) return runParent(args, base, n, procs);
  const from = child ? Number(args['agent-from']) : 0;
  const to = child ? Number(args['agent-to']) : n;

  const stamp = args['run-stamp'] || new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
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
  // 実行の名簿 (全プロセスの全員)。全体チャットの提案で「生きている人数」を数えるのに使う (board.js)
  const roster = Array.from({ length: n }, (_, i) => (n === 1 && args.name ? args.name : personaFor(base, i).name));
  for (let i = from; i < to; i++) {
    const persona = personaFor(base, i);
    const cfg = deepMerge(base, { persona: n === 1 && args.name ? { ...persona, name: args.name } : persona });
    cfg.roster = roster;
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
  // 子プロセス: 親へ使用量を送り、親の stop で止まる
  let usageTimer = null;
  if (child && process.send) {
    process.on('message', (m) => { if (m && m.type === 'stop') stopAll('親から'); });
    usageTimer = setInterval(() => { try { process.send({ type: 'usage', jevInputTokens: meter.jev.inputTokens }); } catch (_) { /* ignore */ } }, 5000);
  }

  // 切断を数える (run の途中で end/kicked になった人。接続の再試行で捨てた bot は数えない)
  const disconnects = { n: 0, reasons: [] };
  const watchEnd = (a) => {
    const b = a.bot;
    // agent の end (stopped を立てる) より先に見る。止めた (stop) あと・時間切れで quit したときは数えない
    const note = (kind) => (r) => { if (a.bot !== b || b._endCounted || a.stopped || (a.plannedEnd && Date.now() > a.plannedEnd - 3000)) return; b._endCounted = true; disconnects.n += 1; disconnects.reasons.push({ name: a.cfg.persona.name, kind, reason: String(typeof r === 'string' ? r : JSON.stringify(r)).slice(0, 200), at: new Date().toISOString() }); };
    b.prependOnceListener('end', note('end'));
    b.prependOnceListener('kicked', note('kicked'));
  };

  const stagger = Number(args['stagger-ms'] || 1500);
  if (args['start-delay-ms']) await sleep(Number(args['start-delay-ms']));
  const ready = [];
  for (const a of agents) {
    const ok = await connectWithRetry(a);
    if (!ok) { console.log(`[${a.cfg.persona.name}] つながらなかったので外す`); continue; }
    watchEnd(a);
    ready.push(a);
    console.log(`[${a.cfg.persona.name}] spawned. goal: ${a.cfg.goal.text}  decider: ${a.decider.kind}  talker: ${talker ? talker.kind : '-'}  base: ${JSON.stringify(a.base)}`);
    await sleep(stagger);
  }
  const monSec = Number(args['monitor-sec'] ?? 30);
  const monitor = monSec > 0 ? new Monitor({ file: path.join(runDir, child ? `monitor-${child}.jsonl` : 'monitor.jsonl'), agents: ready, meter, disconnects, intervalMs: monSec * 1000, proc: child }) : null;
  if (monitor) monitor.start();
  const t0 = Date.now();
  for (const a of ready) a.plannedEnd = t0 + a.cfg.loop.minutes * 60000;
  const results = await Promise.all(ready.map((a) => a.run({ runId: stamp, agents: n })));
  if (monitor) monitor.stop();
  if (usageTimer) { clearInterval(usageTimer); try { process.send({ type: 'usage', jevInputTokens: meter.jev.inputTokens }); } catch (_) { /* ignore */ } }
  const summary = { runId: stamp, config: path.resolve(args.config), order: base.order || null, agents: n, connected: ready.length, ...(child ? { proc: child, agentRange: [from, to] } : {}), decider: decType,
    minutes: Math.round((Date.now() - t0) / 600) / 100, results, disconnects, usage: meter.summary(), twoBLatency: LLM_STATS.total(),
    ...(child ? { twoBLatencyRaw: { ms: LLM_STATS.all.map((r) => r.ms), waitMs: LLM_STATS.all.map((r) => r.waitMs), serverMs: LLM_STATS.all.map((r) => r.serverMs) } } : {}) };
  fs.writeFileSync(path.join(runDir, child ? `run-part${child}.json` : 'run.json'), JSON.stringify(summary, null, 2));
  console.log('done', JSON.stringify({ runDir, usage: summary.usage, twoBLatency: summary.twoBLatency, disconnects: disconnects.n }));
  setTimeout(() => process.exit(0), 500);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { splitAgents, connectWithRetry, personaFor, parseArgs };
