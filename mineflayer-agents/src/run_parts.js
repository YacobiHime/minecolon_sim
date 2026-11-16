'use strict';
// 子プロセスごとの記録 run-part<k>.json をまとめて run.json を作る (run.js の親と tools/merge_run_parts.js が使う)。
// 子が run-part を書けずに終わったら、その子は missingParts に残し (partial: true)、
// その子の人は各自の記録 (<名前>-<時刻>.jsonl) から回数などを拾い直す (results の fromRecord: true)。
// 欠けた子の切断の数はその子の monitor-<k>.jsonl の最後の行から足す (disconnectsFromMonitor)。欠けた子の使用量は失われる。記録の Jev の分だけ usage.missingEstimate に見積もる (2B・LLM の費用は記録に無い)。
const fs = require('fs');
const path = require('path');
const { mergeUsageSummaries } = require('./usage');
const { LLM_STATS } = require('./deciders/llm');

// n 人を procs 個に分ける (前から順に、なるべく同じ人数)。返り値 [[from, to), ...]
function splitAgents(n, procs) {
  const p = Math.max(1, Math.min(n, procs));
  const out = [];
  let from = 0;
  for (let k = 0; k < p; k++) { const size = Math.floor(n / p) + (k < n % p ? 1 : 0); out.push([from, from + size]); from += size; }
  return out;
}

// i 人目のペルソナ: 設定の personas から順に。足りなければ名前に番号を付けて使い回す
function personaFor(cfg, i) {
  const list = cfg.personas && cfg.personas.length ? cfg.personas : [cfg.persona];
  const p = list[i % list.length];
  const round = Math.floor(i / list.length);
  const name = round ? `${p.name}${round + 1}`.slice(0, 16) : p.name;
  return { ...p, name };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

// 1..procs の run-part を読む (無い・壊れていれば null)
function readParts(runDir, procs) {
  return Array.from({ length: procs }, (_, k) => readJson(path.join(runDir, `run-part${k + 1}.json`)));
}

// フォルダの中の各自の記録 <名前>-<stamp>.jsonl
function recordFiles(runDir, stamp = path.basename(runDir)) {
  const suffix = `-${stamp}.jsonl`;
  let names = [];
  try { names = fs.readdirSync(runDir); } catch (_) { return []; }
  return names.filter((f) => f.endsWith(suffix) && f.length > suffix.length).sort()
    .map((f) => ({ name: f.slice(0, -suffix.length), file: path.join(runDir, f) }));
}

// monitor-<k>.jsonl の最後の行の切断の数 (無ければ null)
function lastMonitorDisconnects(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
  const lines = text.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { const r = JSON.parse(lines[i]); if (r.bots && Number.isFinite(r.bots.disconnects)) return r.bots.disconnects; } catch (_) { /* 切れた行 */ }
  }
  return null;
}

// 1人の記録から results の1行を作り直す。Jev の使用量 (判断とゴールの道筋) も数える
function recoverFromRecord(file, name) {
  const out = { name, loops: 0, goalAt: null, recordFile: file, fromRecord: true, ended: false, firstTs: null, lastTs: null };
  const jev = { calls: 0, inputTokens: 0, costUsd: 0 };
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return { ...out, unreadable: true, jev }; }
  const addJev = (j) => {
    if (!j || typeof j !== 'object') return;
    jev.calls += Number(j.calls) || 1;
    jev.inputTokens += Number(j.inputTokens) || 0;
    jev.costUsd += Number(j.costUsd) || 0;
  };
  for (const line of text.split('\n')) {
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch (_) { continue; } // 途中で切れた最後の行
    if (r.ts) { if (!out.firstTs) out.firstTs = r.ts; out.lastTs = r.ts; }
    if (r.event === 'end') { out.ended = true; out.loops = Number(r.loops) || out.loops; if (r.goalAt != null) out.goalAt = r.goalAt; continue; }
    if (r.event === 'goal' && out.goalAt == null && r.loop != null) out.goalAt = r.loop;
    if (r.event === 'goal_path' && r.select) addJev(r.select.jev);
    if (!r.event && Number.isFinite(r.loop)) { out.loops = Math.max(out.loops, r.loop); addJev(r.jev); }
  }
  jev.costUsd = Number(jev.costUsd.toFixed(6));
  return { ...out, jev };
}

// run.json の中身を作る。
//   runDir, procs (子の数), agents (全体の人数), meta: { runId, config, decider, minutes, order, maxInputTokens }
//   namesByProc: [[名前...], ...] (分かれば。欠けた子の人の名前と、記録から拾った人の子の番号に使う)
//   exits: [{ code, signal }, ...] (親が見た子の終わり方。分かれば)
function buildRunSummary(runDir, { procs, agents, meta = {}, namesByProc = null, exits = null } = {}) {
  const P = Math.max(1, Number(procs) || 1);
  const parts = readParts(runDir, P);
  const present = parts.filter(Boolean);
  const n = Number(agents) || (present[0] && present[0].agents) || null;
  const ranges = n ? splitAgents(n, P) : null;
  const results = present.flatMap((pj) => (pj.results || []).map((r) => ({ ...r, proc: r.proc != null ? r.proc : pj.proc })));
  const have = new Set(results.map((r) => r && r.name).filter(Boolean));
  const procOf = new Map();
  if (namesByProc) namesByProc.forEach((names, k) => (names || []).forEach((nm) => procOf.set(nm, k + 1)));
  // 欠けた子の人: 記録から拾い直す
  const est = { agents: 0, jev: { calls: 0, inputTokens: 0, costUsd: 0 } };
  for (const { name, file } of recordFiles(runDir, meta.runId || path.basename(runDir))) {
    if (have.has(name)) continue;
    const r = recoverFromRecord(file, name);
    const { jev, ...row } = r;
    if (procOf.has(name)) row.proc = procOf.get(name);
    results.push(row);
    have.add(name);
    est.agents += 1;
    est.jev.calls += jev.calls; est.jev.inputTokens += jev.inputTokens; est.jev.costUsd += jev.costUsd;
  }
  est.jev.costUsd = Number(est.jev.costUsd.toFixed(6));
  const missingParts = [];
  parts.forEach((pj, k) => {
    if (pj) return;
    const m = { proc: k + 1 };
    if (ranges && ranges[k]) m.agentRange = ranges[k];
    if (namesByProc && namesByProc[k]) m.names = namesByProc[k];
    if (exits && exits[k]) m.exit = exits[k];
    missingParts.push(m);
  });
  // 欠けた子の切断の数: その子の monitor-<k>.jsonl の最後の行 (bots.disconnects) から
  let monDisc = 0;
  for (const m of missingParts) {
    const d = lastMonitorDisconnects(path.join(runDir, `monitor-${m.proc}.jsonl`));
    if (d != null) { m.disconnectsFromMonitor = d; monDisc += d; }
  }
  const lat = { ms: [], waitMs: [], serverMs: [] };
  for (const pj of present) if (pj.twoBLatencyRaw) for (const key of Object.keys(lat)) lat[key].push(...(pj.twoBLatencyRaw[key] || []));
  const usage = mergeUsageSummaries(present.map((pj) => pj.usage), { maxInputTokens: meta.maxInputTokens ?? null });
  if (missingParts.length) usage.missingEstimate = { note: '欠けた子の使用量は失われた。各自の記録の Jev の分だけ見積もった (2B・LLM の費用は含まない)', ...est };
  const partMinutes = present.map((pj) => Number(pj.minutes)).filter(Number.isFinite);
  const first = present[0] || {};
  const summary = {
    runId: meta.runId || first.runId || path.basename(runDir),
    config: meta.config || first.config || null,
    order: meta.order || first.order || null,
    agents: n,
    connected: present.reduce((s, pj) => s + (Number(pj.connected) || 0), 0),
    procs: P,
    decider: meta.decider || first.decider || null,
    minutes: meta.minutes != null ? meta.minutes : (partMinutes.length ? Math.max(...partMinutes) : null),
    results,
    disconnects: present.reduce((s, pj) => s + ((pj.disconnects && pj.disconnects.n) || 0), 0) + monDisc,
    disconnectReasons: present.flatMap((pj) => (pj.disconnects && pj.disconnects.reasons) || []),
    usage,
    twoBLatency: LLM_STATS.summarize(lat.ms.map((ms, i) => ({ ms, waitMs: lat.waitMs[i], serverMs: lat.serverMs[i] }))),
    parts: { expected: P, found: parts.map((pj, k) => (pj ? k + 1 : null)).filter(Boolean) },
    partial: missingParts.length > 0,
    missingParts,
    ...(exits ? { exits } : {}),
  };
  return summary;
}

function writeRunSummary(runDir, opts) {
  const s = buildRunSummary(runDir, opts);
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(s, null, 2));
  return s;
}

module.exports = { splitAgents, personaFor, readParts, recordFiles, recoverFromRecord, buildRunSummary, writeRunSummary };
