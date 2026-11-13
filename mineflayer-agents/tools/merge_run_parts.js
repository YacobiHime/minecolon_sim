#!/usr/bin/env node
'use strict';
// run.json が無い記録のフォルダで、残っている run-part<k>.json から run.json を作り直す
// (親プロセスが途中で落ちたとき。2026-11-13 の 100人試験)。書けなかった子は missingParts に残し、
// その子の人の results は各自の記録 (<名前>-<時刻>.jsonl) から拾い直す (fromRecord: true)。
// 例: node tools/merge_run_parts.js runs/<時刻>              (run.json があれば何もしない)
//     node tools/merge_run_parts.js runs/<時刻> --force      (あっても作り直す)
//     node tools/merge_run_parts.js runs/<時刻> --procs 10 --agents 100 --dry-run
// 子の数・人数は --procs・--agents、無ければ exp_start.json、run-part、monitor-<k>.jsonl の番号から決める。
const fs = require('fs');
const path = require('path');
const { buildRunSummary, personaFor, splitAgents } = require('../src/run_parts');

const A = path.join(__dirname, '..');

function parseArgs(argv) {
  const out = { dir: null };
  for (let i = 2; i < argv.length; i++) {
    const x = argv[i];
    if (!x.startsWith('--')) { if (!out.dir) out.dir = x; continue; }
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    out[x.slice(2)] = v;
  }
  return out;
}

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };

// 子の数・人数・設定を推し量る
function inferRun(dir, opts = {}) {
  const files = fs.readdirSync(dir);
  const exp = readJson(path.join(dir, 'exp_start.json'));
  const idx = (re) => files.map((f) => (f.match(re) || [])[1]).filter(Boolean).map(Number);
  const partIdx = idx(/^run-part(\d+)\.json$/);
  const monIdx = idx(/^monitor-(\d+)\.jsonl$/);
  const procs = Number(opts.procs) || (exp && exp.args && Number(exp.args.procs)) || Math.max(1, ...partIdx, ...monIdx);
  const firstPart = partIdx.length ? readJson(path.join(dir, `run-part${Math.min(...partIdx)}.json`)) : null;
  const agents = Number(opts.agents) || (exp && exp.args && Number(exp.args.agents)) || (firstPart && firstPart.agents) || null;
  let config = (firstPart && firstPart.config) || (exp && exp.args && exp.args.config ? path.resolve(A, exp.args.config) : null);
  if (opts.config) config = path.resolve(opts.config);
  return { procs, agents, config, exp, firstPart };
}

// 設定から子ごとの名前 (run.js と同じ分け方)。読めなければ null
function namesByProcFrom(config, agents, procs) {
  if (!config || !agents) return null;
  try {
    const { loadConfig } = require('../src/config');
    const base = loadConfig(config, {});
    return splitAgents(agents, procs).map(([from, to]) => Array.from({ length: to - from }, (_, i) => personaFor(base, from + i).name));
  } catch (_) { return null; }
}

function merge(dir, opts = {}) {
  const runFile = path.join(dir, 'run.json');
  if (fs.existsSync(runFile) && !opts.force) return { skipped: true, runFile };
  const { procs, agents, config } = inferRun(dir, opts);
  const namesByProc = namesByProcFrom(config, agents, procs);
  const s = buildRunSummary(dir, { procs, agents, meta: { runId: path.basename(dir), config }, namesByProc });
  if (s.minutes == null) {
    const ts = s.results.flatMap((r) => [r.firstTs, r.lastTs]).filter(Boolean).map((t) => Date.parse(t)).filter(Number.isFinite);
    if (ts.length) s.minutes = Math.round((Math.max(...ts) - Math.min(...ts)) / 600) / 100;
  }
  s.rebuilt = { by: 'tools/merge_run_parts.js', at: new Date().toISOString(), namesFromConfig: !!namesByProc };
  if (!opts['dry-run']) fs.writeFileSync(runFile, JSON.stringify(s, null, 2));
  return { skipped: false, runFile, summary: s };
}

if (require.main === module) {
  const a = parseArgs(process.argv);
  if (!a.dir || a.help) {
    console.error('usage: node tools/merge_run_parts.js <run-dir> [--force] [--procs P] [--agents N] [--config FILE] [--dry-run]');
    process.exit(a.help ? 0 : 2);
  }
  try {
    const r = merge(path.resolve(a.dir), a);
    if (r.skipped) { console.log(`run.json はもうある (作り直すなら --force): ${r.runFile}`); process.exit(0); }
    const s = r.summary;
    const fromRec = s.results.filter((x) => x.fromRecord).length;
    console.log(`${a['dry-run'] ? '(dry-run) ' : ''}run.json を作った: ${r.runFile}`);
    console.log(`  子 ${s.parts.found.length}/${s.parts.expected} 個の run-part・results ${s.results.length} 人 (うち記録から拾った ${fromRec} 人)`);
    if (s.partial) {
      console.log(`  欠けた子: ${s.missingParts.map((m) => `${m.proc}${m.names ? ` (${m.names.join(',')})` : ''}`).join(' / ')}`);
      const e = s.usage.missingEstimate;
      console.log(`  欠けた子の使用量は失われた。記録から見積もった Jev: ${e.jev.calls} 回・${e.jev.inputTokens} tok・$${e.jev.costUsd} (2B・LLM の費用は含まない)`);
    }
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { merge, inferRun, parseArgs };
