#!/usr/bin/env node
'use strict';
// 使い方: node mineflayer-agents/run.js --config mineflayer-agents/configs/first_setting.json [--agents 1|5|20] [--minutes 15]
//         [--decider llm|split|jev|random] [--llm http://127.0.0.1:18081] [--name Taro] [--host 127.0.0.1] [--port 25565]
//         [--max-jev-tokens 3000000] [--seed N (選択肢の並べ方の種)] [--stagger-ms 1500] [--procs ceil(N/5)] [--monitor-sec 30] [--netdiag-sec 10] [--random-talk 0.2]
// 1プロセスで --agents 人を動かす。Jev の使用量の上限・2B の窓口は全員で共有する。
// --procs P (P > 1) なら、P 個の子プロセス (node run.js --child) に人を分ける (pathfinder の計算は1プロセスの中では直列なので)。
//   子は同じ runs/<時刻>/ に書き、親が Jev の入力トークンを合計して上限で全員を止め、最後に run.json にまとめる。
// 接続は --stagger-ms ずつずらす (プロセスが複数でも全体で1人ずつ)。つながらなければ 3 回まで再試行する。
// 負荷は --monitor-sec ごとに runs/<時刻>/monitor[-<子の番号>].jsonl (CPU・メモリ・イベントループの遅れ・判断の間隔・2B の待ち・Jev の 429)。接続を始める前から測る。
// 切断の調べ (src/netdiag.js) は --netdiag-sec ごと (既定 10。0 で止める) に runs/<時刻>/netdiag[-<子の番号>].jsonl
//   (短い間隔のイベントループの遅れ・ボットごとの受信量・keepalive の受信と遅れ・ソケットの書き込み待ち・切断の理由とその時点の様子)。
// 止め方: Ctrl-C (SIGINT) 1回 = 各自が今の1歩を終えて止まり、記録を書いて終わる。2回目 = 待たずに今ある分で記録を書いて終わる。
//   複数プロセスなら親が子の終わりを待ち、残っている run-part から run.json を作る (書けなかった子は run.json の missingParts)。
// --random-talk P: --decider random のとき、確率 P で話す (Jev なしで 2B の発言の負荷を試す)。
// 記録は runs/<時刻>/<名前>-<時刻>.jsonl (1人1ファイル) と runs/<時刻>/run.json (実行の合計)。
// LLM (2B) の窓口は --llm か環境変数 LLM_BASE_URL (既定 http://127.0.0.1:18081)。
// Jev の提供元: --jev-provider openrouter|typesafe (config の decider.jev.provider。既定 openrouter)、--jev-model M (例 typesafe/jev-1.14)。
//   openrouter のキーは環境変数 OPENROUTER_API (か OPENROUTER_API_KEY) か /root/.config/openrouter.env、
//   typesafe のキーは環境変数 TYPESAFE_API_KEY か /root/.config/typesafe.env (表示・記録しない)。
//   402 の残高不足が返ったら全員を止める。
// 文を作る LLM の提供元 (src/llm_provider.js): --llm-provider local|luna (既定の提供元)、--llm-roles goal=luna,reflect=luna (役ごと)、
//   --llm-model M・--llm-base-url URL (--llm-provider の提供元に)、--max-llm-usd X (費用の上限。全プロセスの合計)。
// 設置物の来歴と所有 (src/provenance.js・src/ownership.js): --provenance on|off (所有の知識と行動の分離)、--ownership-penalty on|off、--ledger on|off。
// わだかまりと悪い関係の行動 (src/conflict.js): --grudge on|off、--conflict on|off (行動の候補)、--aggression on|off (殴る)。
//   luna の API キーは環境変数 LUNA_API_KEY (無ければ OPENAI_API_KEY) か /root/.config/luna.env (表示・記録しない)。
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
const { LLM_STATS, LLM_USAGE } = require('./src/deciders/llm');
const llmProvider = require('./src/llm_provider');
const { splitAgents, personaFor, writeRunSummary } = require('./src/run_parts');
const { NetDiag } = require('./src/netdiag');

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

// splitAgents・personaFor は src/run_parts.js (run.json のまとめ直しの道具も使う)

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

// 親: 子プロセスを起こし、Jev の使用量を合計して上限で止め、最後に run.json にまとめる (見張りは src/supervise.js)
// 止め方: 1回目の Ctrl-C / SIGINT / SIGTERM = 子に止める合図を送り、終わるのを待つ。2回目 = 子に記録を書かせてすぐ止める。3回目 = SIGKILL。
// どの止め方でも、残っている run-part から run.json を作る (書けなかった子は missingParts)。
async function runParent(args, base, n, procs) {
  const { fork } = require('child_process');
  const { superviseChildren } = require('./src/supervise');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runDir = path.join(base.record.dir, stamp);
  fs.mkdirSync(runDir, { recursive: true });
  const cap = (base.usage && base.usage.maxJevInputTokens) ?? 3000000;
  const parts = splitAgents(n, procs);
  const stagger = Number(args['stagger-ms'] || 1500);
  const passArgs = process.argv.slice(2).filter((_, i, arr) => !['--procs'].includes(arr[i]) && !(i > 0 && arr[i - 1] === '--procs'));
  const used = parts.map(() => 0);
  const usd = parts.map(() => 0);
  const capUsd = base.llm && base.llm.maxUsd != null ? Number(base.llm.maxUsd) : null;
  let capStopped = false;
  const children = parts.map(([from, to], k) => fork(__filename, [...passArgs, '--child', String(k + 1), '--agent-from', String(from), '--agent-to', String(to), '--agents', String(n),
    '--run-stamp', stamp, '--stagger-ms', String(stagger * parts.length), '--start-delay-ms', String(stagger * k)], { stdio: 'inherit' }));
  const t0 = Date.now();
  const sup = superviseChildren(children, {
    runDir, procs: parts.length, agents: n,
    meta: { runId: stamp, config: path.resolve(args.config), decider: base.decider.type || 'llm', order: base.order || null, maxInputTokens: cap },
    namesByProc: parts.map(([from, to]) => Array.from({ length: to - from }, (_, i) => personaFor(base, from + i).name)),
    onMessage: (k, m) => {
      if (!m || m.type !== 'usage') return;
      used[k] = m.jevInputTokens || 0;
      usd[k] = m.llmUsd || 0;
      const total = used.reduce((x, y) => x + y, 0);
      const totalUsd = usd.reduce((x, y) => x + y, 0);
      const why = total >= cap ? `Jev の入力トークンが全プロセスの合計で上限 ${cap} に達した: ${total}`
        : capUsd != null && totalUsd >= capUsd ? `LLM の費用が全プロセスの合計で上限 $${capUsd} に達した: $${totalUsd.toFixed(4)}` : null;
      if (!capStopped && why) { capStopped = true; console.log(`stopping (${why})...`); sup.send({ type: 'stop' }); }
    },
  });
  const summary = await sup.done;
  // minutes は親の経過時間 (run.json を書き直す)
  summary.minutes = Math.round((Date.now() - t0) / 600) / 100;
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(summary, null, 2));
  console.log('done', JSON.stringify({ runDir, procs: parts.length, partial: summary.partial, missingParts: summary.missingParts.map((m) => m.proc), usage: summary.usage, twoBLatency: summary.twoBLatency }));
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.config) {
    console.error('usage: node run.js --config <file> [--agents N] [--minutes N] [--llm URL] [--decider llm|split|jev|random] [--max-jev-tokens N] [--jev-provider openrouter|typesafe] [--jev-model M]\n'
      + '         [--llm-provider local|luna] [--llm-roles goal=luna,reflect=luna] [--llm-model M] [--llm-base-url URL] [--max-llm-usd X]');
    process.exit(2);
  }
  const ov = {};
  if (args.minutes) ov.loop = { minutes: Number(args.minutes) };
  if (args.host || args.port) ov.server = { ...(args.host ? { host: args.host } : {}), ...(args.port ? { port: Number(args.port) } : {}) };
  const llmUrl = args.llm || process.env.LLM_BASE_URL;
  if (llmUrl || args.decider) ov.decider = { ...(args.decider ? { type: args.decider } : {}), ...(llmUrl ? { llm: { baseUrl: llmUrl } } : {}) };
  if (args['max-jev-tokens']) ov.usage = { maxJevInputTokens: Number(args['max-jev-tokens']) };
  if (args['jev-provider']) ov.decider = { ...(ov.decider || {}), jev: { provider: args['jev-provider'] } };
  if (args['random-talk']) ov.decider = { ...(ov.decider || {}), talkP: Number(args['random-talk']) };
  // 比較実験の切り替え (cfg.provenance): --provenance on|off (所有の知識と行動の分離)、--ownership-penalty on|off (判断の重み + 関係の変化)、--ledger on|off (台帳)
  const prov = provenanceOverrides(args);
  if (prov) ov.provenance = prov;
  // わだかまりと悪い関係の行動 (cfg.conflict): --grudge on|off・--conflict on|off (行動の候補)・--aggression on|off (殴る)
  const conf = conflictOverrides(args);
  if (conf) ov.conflict = conf;
  const llmOv = llmOverrides(args);
  if (llmOv) ov.llm = llmOv;
  // 並べ方の種: --seed か config の order.seed。どちらも無ければここで決め、子プロセスにも --seed で渡す (記録の start と run.json に残る)
  if (args.seed != null) ov.order = { seed: Number(args.seed) >>> 0 };
  const base = loadConfig(args.config, ov);
  // --jev-model は使う提供元のモデル (config の decider.jev.providers.<提供元>.model より優先)
  if (args['jev-model']) {
    const jv = (base.decider.jev = base.decider.jev || {});
    const pv = jv.provider || 'openrouter';
    jv.providers = { ...(jv.providers || {}), [pv]: { ...((jv.providers || {})[pv] || {}), model: args['jev-model'] } };
  }
  if (!base.order || base.order.seed == null) {
    base.order = { ...(base.order || {}), seed: Math.floor(Math.random() * 2 ** 32) >>> 0 };
    args.seed = String(base.order.seed);
    process.argv.push('--seed', args.seed);
  }
  // 使う提供元の API キーがあるか (キーそのものは出さない)
  const keys = llmProvider.checkKeys(base);
  for (const k of keys) if (!k.ok) { console.error(`${k.error}。役 ${k.roles.join(',')} がこの提供元を使う。--llm-provider local で動かすか、README の「LLM の提供元」を見ること`); process.exit(2); }
  if (!args.child) console.log(`LLM: ${llmProvider.ROLES.map((r) => { const o = llmProvider.llmOptsFor(base, r); return `${r}=${o.provider}(${o.model})`; }).join(' ')}${base.llm && base.llm.maxUsd != null ? ` 上限 $${base.llm.maxUsd}` : ''}`);
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
      console.error(`Jev (${jevClient.provider}) の API キーがない (${jevClient.keyHint})。--jev-provider で提供元を替えるか、--decider llm で動かすこと`);
      process.exit(2);
    }
    if (!child) console.log(`Jev: ${jevClient.provider} ${jevClient.url} model=${jevClient.model}`);
  }
  const talker = base.talk && base.talk.enabled === false ? null
    : new Talker({ llmOptsFor: (role) => llmProvider.llmOptsFor(base, role, (base.talk && base.talk.llm) || {}), meter });
  if (base.llm && base.llm.maxUsd != null) LLM_USAGE.maxUsd = Number(base.llm.maxUsd);

  const agents = [];
  // 実行の名簿 (全プロセスの全員)。全体チャットの提案で「生きている人数」を数えるのに使う (board.js)
  const roster = Array.from({ length: n }, (_, i) => (n === 1 && args.name ? args.name : personaFor(base, i).name));
  for (let i = from; i < to; i++) {
    const persona = personaFor(base, i);
    const cfg = deepMerge(base, { persona: n === 1 && args.name ? { ...persona, name: args.name } : persona });
    cfg.roster = roster;
    const name = cfg.persona.name;
    cfg.memory = { ...cfg.memory, file: base.memory.perRun ? path.join(path.dirname(base.memory.file), stamp, `${name}.json`) : path.join(path.dirname(base.memory.file), `${name}.json`) };
    const decider = createDecider(cfg.decider, {}, { meter, jevClient, llmOpts: llmProvider.llmOptsFor(cfg, 'act') });
    agents.push(new Agent(cfg, { decider, meter, talker, recordDir: runDir, recordStamp: stamp }));
  }

  // 止め方: 1回目 (SIGINT/SIGTERM・親の stop・親がいなくなった・上限) = 各自が今の1歩を終えて止まり、run-part (run.json) を書いて終わる。
  // 止める途中にもう一度 SIGINT/SIGTERM = 待たずに、今ある分で run-part を書いてすぐ終わる (各自の results は aborted: true)。
  let stopRequested = false;
  const stopAll = (why) => { stopRequested = true; console.log(`stopping (${why})...`); for (const a of agents) a.stop(); };
  meter.onExceeded((u) => stopAll(`Jev の入力トークンが上限 ${u.jev.maxInputTokens} に達した`));
  LLM_USAGE.onExceeded((u) => stopAll(`LLM の費用が上限 $${u.maxUsd} に達した ($${u.costUsd})`));
  if (jevClient) jevClient.onFatal((f) => stopAll(f.error));
  let forceExit = null; // 下で定める (run-part を書いてすぐ終わる)
  const onSignal = (sig) => () => {
    if (stopRequested && forceExit) { console.log(`${sig} (2回目): 待たずに記録を書いて終わる`); forceExit(sig); return; }
    stopAll(sig);
  };
  process.on('SIGINT', onSignal('SIGINT'));
  process.on('SIGTERM', onSignal('SIGTERM'));
  process.on('unhandledRejection', (e) => console.log('unhandledRejection:', e && e.message));
  // 子プロセス: 親へ使用量を送り、親の stop で止まる。親がいなくなっても (disconnect) 止まって自分の run-part を書く。
  // 送るのは親とつながっているときだけ。送れなかった失敗はコールバックで受ける ('error' を未処理にしない。2026-11-13 に子が落ちた)
  let usageTimer = null;
  const sendUsage = () => {
    if (!child || !process.send || !process.connected) return;
    try { process.send({ type: 'usage', jevInputTokens: meter.jev.inputTokens, llmUsd: LLM_USAGE.totalUsd }, () => { /* 親がいない */ }); } catch (_) { /* ignore */ }
  };
  if (child && process.send) {
    process.on('error', (e) => console.log(`[proc ${child}] IPC: ${e && e.message}`));
    process.on('message', (m) => { if (m && m.type === 'stop') stopAll('親から'); });
    process.on('disconnect', () => { if (usageTimer) clearInterval(usageTimer); usageTimer = null; if (!stopRequested) stopAll('親がいなくなった'); });
    usageTimer = setInterval(sendUsage, 5000);
  }

  // 接続の見張り (src/netdiag.js): 接続を始める前から。--netdiag-sec 0 で止める
  const ndSec = Number(args['netdiag-sec'] ?? 10);
  const netdiag = ndSec > 0 ? new NetDiag({ file: path.join(runDir, child ? `netdiag-${child}.jsonl` : 'netdiag.jsonl'), proc: child, intervalMs: ndSec * 1000 }) : null;
  if (netdiag) { netdiag.start(); for (const a of agents) a.onBot = (bot) => netdiag.watch(a.cfg.persona.name, bot); }

  // 切断を数える (run の途中で end/kicked になった人。接続の再試行で捨てた bot は数えない)
  const disconnects = { n: 0, reasons: [] };
  const watchEnd = (a) => {
    const b = a.bot;
    // agent の end (stopped を立てる) より先に見る。止めた (stop) あと・時間切れで quit したときは数えない
    const note = (kind) => (r) => { if (a.bot !== b || b._endCounted || a.stopped || (a.plannedEnd && Date.now() > a.plannedEnd - 3000)) return; b._endCounted = true; disconnects.n += 1; disconnects.reasons.push({ name: a.cfg.persona.name, kind, reason: String(typeof r === 'string' ? r : JSON.stringify(r)).slice(0, 200), at: new Date().toISOString() }); };
    b.prependOnceListener('end', note('end'));
    b.prependOnceListener('kicked', note('kicked'));
  };

  // 負荷の見張り: 接続を始める前から (接続の途中の遅れも見る。2026-11-13 は全員の接続後からで、開始直後の切断の前が見えなかった)
  const ready = [];
  const monSec = Number(args['monitor-sec'] ?? 30);
  const monitor = monSec > 0 ? new Monitor({ file: path.join(runDir, child ? `monitor-${child}.jsonl` : 'monitor.jsonl'), agents, meter, disconnects, intervalMs: monSec * 1000, proc: child }) : null;
  if (monitor) { monitor.phase = 'connect'; monitor.start(); }

  let t0 = Date.now();
  let partWritten = false;
  const writePart = (results, extra = {}) => {
    if (partWritten) return null;
    partWritten = true;
    if (monitor) monitor.stop();
    if (netdiag) netdiag.stop();
    if (usageTimer) { clearInterval(usageTimer); usageTimer = null; }
    sendUsage();
    const summary = { runId: stamp, config: path.resolve(args.config), order: base.order || null, agents: n, connected: ready.length, ...(child ? { proc: child, agentRange: [from, to] } : {}), decider: decType,
      minutes: Math.round((Date.now() - t0) / 600) / 100, results, disconnects, usage: meter.summary(), twoBLatency: LLM_STATS.total(), ...extra,
      ...(child ? { twoBLatencyRaw: { ms: LLM_STATS.all.map((r) => r.ms), waitMs: LLM_STATS.all.map((r) => r.waitMs), serverMs: LLM_STATS.all.map((r) => r.serverMs) } } : {}) };
    fs.writeFileSync(path.join(runDir, child ? `run-part${child}.json` : 'run.json'), JSON.stringify(summary, null, 2));
    console.log('done', JSON.stringify({ runDir, ...(child ? { proc: child } : {}), usage: summary.usage, twoBLatency: summary.twoBLatency, disconnects: disconnects.n, ...extra }));
    return summary;
  };
  forceExit = (sig) => {
    const results = agents.map((a) => ({ name: a.cfg.persona.name, loops: a.memory ? a.memory.tick : null, goalAt: a.goalAt || null, recordFile: a.recorder ? a.recorder.file : null, aborted: true }));
    try { writePart(results, { aborted: sig }); } catch (e) { console.log(`run-part を書けなかった: ${e.message}`); }
    setTimeout(() => process.exit(130), 300);
  };

  const stagger = Number(args['stagger-ms'] || 1500);
  if (args['start-delay-ms']) await sleep(Number(args['start-delay-ms']));
  for (const a of agents) {
    if (stopRequested) break;
    const ok = await connectWithRetry(a);
    if (!ok) { console.log(`[${a.cfg.persona.name}] つながらなかったので外す`); continue; }
    watchEnd(a);
    ready.push(a);
    console.log(`[${a.cfg.persona.name}] spawned. goal: ${a.cfg.goal.text}  decider: ${a.decider.kind}  talker: ${talker ? talker.kind : '-'}  base: ${JSON.stringify(a.base)}`);
    if (stopRequested) break;
    await sleep(stagger);
  }
  if (monitor) monitor.phase = 'run';
  if (netdiag) netdiag.setPhase('run');
  t0 = Date.now();
  for (const a of ready) a.plannedEnd = t0 + a.cfg.loop.minutes * 60000;
  const settled = await Promise.allSettled(ready.map((a) => a.run({ runId: stamp, agents: n })));
  const results = settled.map((s, i) => (s.status === 'fulfilled' ? s.value
    : { name: ready[i].cfg.persona.name, loops: ready[i].memory ? ready[i].memory.tick : null, goalAt: ready[i].goalAt || null, error: String(s.reason && s.reason.message) }));
  writePart(results);
  setTimeout(() => process.exit(0), 500);
}

// --provenance / --ownership-penalty / --ledger → config の provenance に重ねる分 (無ければ null)
function provenanceOverrides(args) {
  const o = {};
  const onoff = (k) => { const v = String(args[k]).toLowerCase(); if (!['on', 'off', 'true', 'false'].includes(v)) throw new Error(`--${k} は on か off`); return v === 'on' || v === 'true'; };
  if (args.provenance != null) o.actions = onoff('provenance');
  if (args['ownership-penalty'] != null) o.penalty = onoff('ownership-penalty');
  if (args.ledger != null) o.ledger = onoff('ledger');
  return Object.keys(o).length ? o : null;
}

function conflictOverrides(args) {
  const o = {};
  const onoff = (k) => { const v = String(args[k]).toLowerCase(); if (!['on', 'off', 'true', 'false'].includes(v)) throw new Error(`--${k} は on か off`); return v === 'on' || v === 'true'; };
  if (args.grudge != null) o.grudge = onoff('grudge');
  if (args.conflict != null) o.actions = onoff('conflict');
  if (args.aggression != null) o.aggression = onoff('aggression');
  return Object.keys(o).length ? o : null;
}

// --llm-provider / --llm-roles / --llm-model / --llm-base-url / --max-llm-usd → config の llm に重ねる分 (無ければ null)
function llmOverrides(args) {
  const o = {};
  if (args['llm-provider']) o.provider = args['llm-provider'];
  if (args['llm-roles']) {
    o.roles = {};
    for (const kv of String(args['llm-roles']).split(',').filter(Boolean)) {
      const [r, p] = kv.split('=');
      if (!llmProvider.ROLES.includes(r) || !p) throw new Error(`--llm-roles の書き方: goal=luna,talk=local (役は ${llmProvider.ROLES.join('|')})`);
      o.roles[r] = p;
    }
  }
  const target = args['llm-provider'] || null;
  if (args['llm-model'] || args['llm-base-url']) {
    if (!target) throw new Error('--llm-model・--llm-base-url は --llm-provider と一緒に使う (どの提供元の設定か)');
    o.providers = { [target]: { ...(args['llm-model'] ? { model: args['llm-model'] } : {}), ...(args['llm-base-url'] ? { baseUrl: args['llm-base-url'] } : {}) } };
  }
  if (args['max-llm-usd'] != null) o.maxUsd = Number(args['max-llm-usd']);
  return Object.keys(o).length ? o : null;
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { splitAgents, connectWithRetry, personaFor, runParent, parseArgs, llmOverrides, provenanceOverrides, conflictOverrides };
