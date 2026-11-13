#!/usr/bin/env node
'use strict';
// 実験の要点を短く出す (tools/exp_stop.sh が集計のあとに呼ぶ)。
// 読むもの: <dir>/run.json・<dir>/summary.txt (summarize_run の JSON 部分)・<dir>/conflict.json・<dir>/check.txt
// 例: node tools/exp_digest.js runs/<時刻>
const fs = require('fs');
const path = require('path');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

// summary.txt は「JSON + (--text のとき) 週次報告用の文」。先頭の JSON だけ取り出す
function summaryJson(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
  const end = text.search(/\n\}\s*(\n|$)/);
  if (end < 0) return null;
  try { return JSON.parse(text.slice(0, end + 2)); } catch (_) { return null; }
}

const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);
const pct = (a, b) => (b > 0 ? `${((100 * a) / b).toFixed(1)}%` : '-');

function digest(dir) {
  const run = readJson(path.join(dir, 'run.json'));
  const sum = summaryJson(path.join(dir, 'summary.txt'));
  const conf = readJson(path.join(dir, 'conflict.json'));
  const exp = readJson(path.join(dir, 'exp_start.json'));
  let check = null;
  try { check = fs.readFileSync(path.join(dir, 'check.txt'), 'utf8').split(/\r?\n/).find((l) => /^(PASS|FAIL)\b/.test(l)) || null; } catch (_) { /* なし */ }

  const out = {};
  out.verdict = check ? check.split(/\s+/)[0] : null;
  out.minutes = run ? num(run.minutes) : null;
  out.agents = run ? num(run.agents) : (exp && exp.args ? exp.args.agents : null);
  if (sum && sum.decisions) out.decisions = num(sum.decisions.count);
  if (sum && Array.isArray(sum.perAgent)) {
    const ok = sum.perAgent.reduce((s, a) => s + (num(a.success) || 0), 0);
    const ng = sum.perAgent.reduce((s, a) => s + (num(a.failure) || 0), 0);
    out.success = { ok, total: ok + ng, rate: ok + ng > 0 ? ok / (ok + ng) : null };
  }
  if (sum && sum.survival) out.deaths = num(sum.survival.deaths);
  if (sum && sum.provenance) {
    const p = sum.provenance;
    out.takes = { placed: num(p.placedTakes), own: num(p.ownTakes), others: (num(p.placedTakes) || 0) - (num(p.ownTakes) || 0), byReason: p.byReason || {} };
  }
  if (conf) {
    const v = conf.violence || {};
    const h = v.hits || {};
    out.conflict = { grudges: num((conf.grudges || {}).n), grudgePairs: num((conf.grudges || {}).pairs), hits: num(h.n), hitters: num(h.people), blows: num(h.blows), kills: num(v.kills) };
  }
  if (run && run.usage) {
    const jev = num(run.usage.jev && run.usage.jev.costUsd);
    const llm = num(run.usage.llm && run.usage.llm.costUsd);
    if (jev != null || llm != null) out.costUsd = { jev, llm, total: (jev || 0) + (llm || 0) };
  }
  if (run && run.partial) {
    const e = (run.usage && run.usage.missingEstimate) || null;
    out.missing = { procs: (run.missingParts || []).map((m) => m.proc), jevUsdEstimate: e && e.jev ? num(e.jev.costUsd) : null };
  }
  out.args = exp ? exp.args : null;
  out.world = exp && exp.world ? exp.world.name : null;
  return out;
}

function lines(d) {
  const f = (x, unit = '') => (x == null ? '-' : `${x}${unit}`);
  const usd = (x) => (x == null ? '-' : `$${x.toFixed(2)}`);
  const L = [];
  L.push(`合否          ${d.verdict || '不明 (check.txt なし)'}`);
  L.push(`実行時間      ${f(d.minutes, ' 分')}・人数 ${f(d.agents)}${d.world ? `・ワールド ${d.world}` : ''}`);
  if (d.args) L.push(`仕組み        provenance=${d.args.provenance} ownership-penalty=${d.args.ownershipPenalty} grudge=${d.args.grudge} conflict=${d.args.conflict} aggression=${d.args.aggression}`);
  L.push(`判断          ${f(d.decisions)} 回・成功率 ${d.success ? `${pct(d.success.ok, d.success.total)} (${d.success.ok}/${d.success.total})` : '-'}・死亡 ${f(d.deaths)} 回`);
  if (d.takes) {
    const r = Object.entries(d.takes.byReason).map(([k, v]) => `${k} ${v}`).join('・');
    L.push(`他人の物の取得 ${d.takes.others} 件 (設置物の取得 ${f(d.takes.placed)}・うち自分の物 ${f(d.takes.own)})${r ? `  理由: ${r}` : ''}`);
  } else L.push('他人の物の取得 -');
  if (d.conflict) {
    const c = d.conflict;
    L.push(`わだかまり    ${f(c.grudges)} 回 (${f(c.grudgePairs)} 組)・殴った ${f(c.hits)} 回 (${f(c.hitters)} 人・${f(c.blows)} 発)・殺した ${f(c.kills)}`);
  } else L.push('わだかまり    - (conflict.json なし)');
  L.push(`費用          ${d.costUsd ? `$${d.costUsd.total.toFixed(2)} (Jev ${usd(d.costUsd.jev)}・LLM ${usd(d.costUsd.llm)})` : '記録なし (run.json に費用が無い)'}`);
  if (d.missing) L.push(`注意          run-part が欠けた子 ${d.missing.procs.join(',')} の使用量は費用に入っていない (記録から見積もった Jev ${usd(d.missing.jevUsdEstimate)}。LLM の分は不明)`);
  return L;
}

module.exports = { digest, lines, summaryJson };

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node tools/exp_digest.js <runs/<時刻>> [--json]'); process.exit(2); }
  const d = digest(dir);
  if (process.argv.includes('--json')) console.log(JSON.stringify(d, null, 2));
  else for (const l of lines(d)) console.log(l);
}
