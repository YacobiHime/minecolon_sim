#!/usr/bin/env node
'use strict';

// 多人数試験の run.json と monitor-*.jsonl を機械的に合否判定する。
// 例: node tools/check_scale_run.js runs/<時刻> --agents 100 --max-disconnects 0
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = { dir: null };
  for (let i = 2; i < argv.length; i++) {
    const x = argv[i];
    if (!x.startsWith('--') && !out.dir) { out.dir = x; continue; }
    if (!x.startsWith('--')) continue;
    const key = x.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    out[key] = value;
  }
  return out;
}

function jsonLines(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line, i) => {
    try { return JSON.parse(line); } catch (e) { throw new Error(`${file}:${i + 1}: ${e.message}`); }
  });
}

function max(values) {
  const xs = values.filter(Number.isFinite);
  return xs.length ? Math.max(...xs) : null;
}

function sumProviderErrors(run) {
  return Object.values((((run.usage || {}).llm || {}).byProvider) || {})
    .reduce((n, x) => n + Number((x && x.errors) || 0), 0);
}

function evaluate(dir, opts = {}) {
  const runFile = path.join(dir, 'run.json');
  if (!fs.existsSync(runFile)) throw new Error(`run.json がない: ${runFile}`);
  const run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  const expectedAgents = Number(opts.agents == null ? run.agents : opts.agents);
  const maxDisconnects = Number(opts.maxDisconnects == null ? 0 : opts.maxDisconnects);
  const maxApiErrors = Number(opts.maxApiErrors == null ? 0 : opts.maxApiErrors);
  const maxLoopLagMs = Number(opts.maxLoopLagMs == null ? 10000 : opts.maxLoopLagMs);
  const minMinutes = Number(opts.minMinutes == null ? 5 : opts.minMinutes);
  const monitorFiles = fs.readdirSync(dir).filter((x) => /^monitor(?:-\d+)?\.jsonl$/.test(x)).sort();
  const monitors = monitorFiles.flatMap((file) => jsonLines(path.join(dir, file)).map((row) => ({ file, ...row })));
  const names = (run.results || []).map((x) => x && x.name).filter(Boolean);
  const jevErrors = Number((((run.usage || {}).jev || {}).errors) || 0);
  const llmErrors = sumProviderErrors(run);
  const stats = {
    agents: Number(run.agents),
    resultAgents: new Set(names).size,
    procs: Number(run.procs || 1),
    minutes: Number(run.minutes || 0),
    disconnects: Number(run.disconnects || 0),
    jevErrors,
    llmErrors,
    loopLagP99MaxMs: max(monitors.map((x) => Number(x.loopLag && x.loopLag.p99))),
    loopLagMaxMs: max(monitors.map((x) => Number(x.loopLag && x.loopLag.max))),
    cpuMaxPct: max(monitors.map((x) => Number(x.cpuPct))),
    rssMaxPerProcMb: max(monitors.map((x) => Number(x.rssMb))),
    monitorFiles: monitorFiles.length,
  };
  const checks = [
    ['agents', stats.agents === expectedAgents, `${stats.agents}/${expectedAgents}`],
    ['unique results', stats.resultAgents === expectedAgents, `${stats.resultAgents}/${expectedAgents}`],
    ['duration', stats.minutes >= minMinutes, `${stats.minutes}m >= ${minMinutes}m`],
    ['disconnects', stats.disconnects <= maxDisconnects, `${stats.disconnects} <= ${maxDisconnects}`],
    ['Jev errors', stats.jevErrors <= maxApiErrors, `${stats.jevErrors} <= ${maxApiErrors}`],
    ['LLM errors', stats.llmErrors <= maxApiErrors, `${stats.llmErrors} <= ${maxApiErrors}`],
    ['monitor files', stats.monitorFiles === stats.procs, `${stats.monitorFiles}/${stats.procs}`],
    ['event-loop p99 max', stats.loopLagP99MaxMs != null && stats.loopLagP99MaxMs <= maxLoopLagMs,
      `${stats.loopLagP99MaxMs}ms <= ${maxLoopLagMs}ms`],
  ].map(([name, ok, detail]) => ({ name, ok, detail }));
  return { ok: checks.every((x) => x.ok), runId: run.runId || path.basename(dir), stats, limits: { expectedAgents, maxDisconnects, maxApiErrors, maxLoopLagMs, minMinutes }, checks };
}

function print(result, json = false) {
  if (json) { console.log(JSON.stringify(result, null, 2)); return; }
  console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.runId}`);
  for (const c of result.checks) console.log(`  ${c.ok ? 'OK' : 'NG'} ${c.name}: ${c.detail}`);
  const s = result.stats;
  console.log(`  procs=${s.procs} CPU max=${s.cpuMaxPct}% RSS max/proc=${s.rssMaxPerProcMb}MB loop lag max=${s.loopLagMaxMs}ms`);
}

if (require.main === module) {
  const a = parseArgs(process.argv);
  if (!a.dir) {
    console.error('usage: node tools/check_scale_run.js <run-dir> [--agents 100] [--max-disconnects 0] [--max-api-errors 0] [--max-loop-lag-ms 10000] [--min-minutes 5] [--json]');
    process.exit(2);
  }
  try {
    const result = evaluate(path.resolve(a.dir), {
      agents: a.agents,
      maxDisconnects: a['max-disconnects'],
      maxApiErrors: a['max-api-errors'],
      maxLoopLagMs: a['max-loop-lag-ms'],
      minMinutes: a['min-minutes'],
    });
    print(result, a.json === true);
    process.exitCode = result.ok ? 0 : 1;
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exitCode = 2;
  }
}

module.exports = { evaluate, parseArgs };
