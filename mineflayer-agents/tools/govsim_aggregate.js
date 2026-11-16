#!/usr/bin/env node
'use strict';
// GovSim (govsim/run.js) の複数の実行をまとめて表にする (平均 ± 標準偏差)。
// 使い方: node tools/govsim_aggregate.js [DIR ...] [--json OUT] [--examples N]
//   DIR: summary.json のあるフォルダか、その親 (既定 runs/govsim)。条件 = 提供元/モデル × variant × mental でまとめる
//   --examples N: mental on の収穫の考えのうち、心の言葉を挙げた例を N 個ずつ出す (events.jsonl から)
// 出すもの: 生き残った月 m・生き残り q (m = 最大の月)・崩壊・Gain・効率・平等・使いすぎ・読めなかった数・LLM の呼び出し・費用、
//   mental on/off の差を見るための 収穫の量の平均 (1人1か月あたり、欲しい量)・取り決めの数、
//   mental on の 心の言葉を挙げた判断の割合・プロンプトに出た言葉の上位
const fs = require('fs');
const path = require('path');

function findSummaries(dirs) {
  const out = [];
  const walk = (d, depth) => {
    if (!fs.existsSync(d)) return;
    if (fs.existsSync(path.join(d, 'summary.json'))) { out.push(path.join(d, 'summary.json')); return; }
    if (depth > 2) return;
    for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p, depth + 1); }
  };
  for (const d of dirs) walk(d, 0);
  return out;
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const sd = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const fmt = (a, d = 2) => { const v = a.filter((x) => x != null && Number.isFinite(x)); return v.length ? `${mean(v).toFixed(d)} ± ${sd(v).toFixed(d)}` : '-'; };

function load(file) {
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  const wanted = []; const caught = [];
  for (const m of s.months_detail || []) { for (const v of Object.values(m.wanted)) wanted.push(v); for (const v of Object.values(m.caught)) caught.push(v); }
  return { file, dir: path.dirname(file), s, wantedMean: mean(wanted), caughtMean: mean(caught) };
}

// events.jsonl から: mental on で、プロンプトに出た心の言葉を LLM の答えが挙げた数 (収穫・発言・振り返り) と、性格の言葉を挙げた数
function citeCounts(dir) {
  const f = path.join(dir, 'events.jsonl');
  const out = {};
  if (!fs.existsSync(f)) return out;
  const { citedTerms } = require('../govsim/sim');
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line) continue;
    const e = JSON.parse(line);
    if (e.type !== 'llm' || !e.mental || !e.text || e.attempt) continue;
    const o = (out[e.kind] = out[e.kind] || { calls: 0, citing: 0, personality: 0 });
    o.calls += 1;
    if (citedTerms(e.mental, e.text).length) o.citing += 1;
    if (/personalit|my nature|reserved|disciplined|dependable|quarrelsome|critical nature|anxious nature|calm and emotionally/i.test(e.text)) o.personality += 1;
  }
  return out;
}

// events.jsonl の mental (心のモデルの出来事) から: 取り決めを破った/守ったと分かった数 (文字の版は村長の報告 report、Minecraft の中の版は見た漁 judged)
function judgedCounts(dir) {
  const f = path.join(dir, 'events.jsonl');
  const out = { breach: 0, kept: 0 };
  if (!fs.existsSync(f)) return out;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line || !line.includes('"type":"mental"')) continue;
    const e = JSON.parse(line);
    for (const x of Object.values(e.events || {})) for (const j of [...(x.judged || []), ...(x.report || [])]) out[j.kind] = (out[j.kind] || 0) + 1;
  }
  return out;
}

function examples(dir, n) {
  const f = path.join(dir, 'events.jsonl');
  if (!fs.existsSync(f)) return [];
  const out = [];
  const { citedTerms } = require('../govsim/sim');
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line) continue;
    const e = JSON.parse(line);
    if (e.type !== 'llm' || e.kind !== 'harvest' || !e.mental || !e.text) continue;
    const c = citedTerms(e.mental, e.text);
    if (c.length) out.push({ month: e.month + 1, agent: e.agent, cited: c, mental: e.mental, answer: e.parsed && e.parsed.value, text: e.text.replace(/\s+/g, ' ').slice(0, 500) });
    if (out.length >= n) break;
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const dirs = []; let jsonOut = null; let nEx = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') jsonOut = args[++i];
    else if (args[i] === '--examples') nEx = Number(args[++i]);
    else dirs.push(args[i]);
  }
  if (!dirs.length) dirs.push(path.join(__dirname, '..', 'runs', 'govsim'));
  const runs = findSummaries(dirs).map(load);
  const groups = {};
  for (const r of runs) {
    const llm = r.s.llm || {};
    // mode: 文字の版 (summary に mode が無い) は text、Minecraft の中の版は embodied (村長の報告ありは embodied+mayor)
    const mode = r.s.mode === 'embodied' ? (r.s.embodied && r.s.embodied.mayorReport ? 'embodied+mayor' : 'embodied') : 'text';
    const key = `${llm.provider || '?'}/${llm.model || '?'} | ${mode} | ${r.s.variant} | mental ${r.s.mental ? 'on' : 'off'}`;
    (groups[key] = groups[key] || []).push(r);
  }
  const rows = [];
  for (const [key, rs] of Object.entries(groups).sort()) {
    const M = (f) => rs.map((r) => f(r.s.metrics));
    const pf = rs.map((r) => Object.values(r.s.parseFailures || {}).reduce((a, b) => a + b, 0));
    const pfKinds = {};
    for (const r of rs) for (const [k, v] of Object.entries(r.s.parseFailures || {})) pfKinds[k] = (pfKinds[k] || 0) + v;
    const row = {
      group: key, runs: rs.length, seeds: rs.map((r) => r.s.seed).join(','),
      survivalMonths: fmt(M((m) => m.survivalMonths)), survivalRate: (rs.filter((r) => r.s.metrics.survived).length / rs.length).toFixed(2),
      collapsed: rs.filter((r) => r.s.metrics.collapsed).length, gain: fmt(M((m) => m.gain), 1), efficiency: fmt(M((m) => m.efficiency)),
      equality: fmt(M((m) => m.equality)), overUsage: fmt(M((m) => m.overUsage)),
      wantedPerAgentMonth: fmt(rs.map((r) => r.wantedMean), 1), caughtPerAgentMonth: fmt(rs.map((r) => r.caughtMean), 1),
      agreements: fmt(rs.map((r) => (r.s.agreements || []).length), 1),
      parseFailures: `${pf.reduce((a, b) => a + b, 0)} ${JSON.stringify(pfKinds)}`, reasked: rs.reduce((a, r) => a + Object.values(r.s.reasked || {}).reduce((x, y) => x + y, 0), 0),
      llmCalls: rs.reduce((a, r) => a + (r.s.llmCalls || 0), 0), llmErrors: rs.reduce((a, r) => a + (r.s.llmErrors || 0), 0),
      costUsd: rs.reduce((a, r) => a + ((r.s.llm && r.s.llm.costUsd) || 0), 0).toFixed(4),
    };
    // Minecraft の中の版: 池を見た割合・他人の漁を見た割合・欲しい量より取れなかった数 など (embodied_sim.js の infoStats を足し合わせる)
    const inf = rs.map((r) => r.s.embodied && r.s.embodied.information).filter(Boolean);
    if (inf.length) {
      const S = (f) => inf.reduce((x, i) => x + (i[f] || 0), 0);
      row.embodied = {
        agentMonths: S('agentMonths'), lookedShare: fmt(inf.map((i) => i.lookedShare)), meanAbsCountError: fmt(inf.map((i) => i.meanAbsCountError)),
        catches: S('catches'), witnessedShare: fmt(inf.map((i) => i.witnessedShare)), wantedTotal: S('wantedTotal'), caughtTotal: S('caughtTotal'),
        caughtLessThanWanted: S('caughtLessThanWanted'), caughtMoreThanWanted: S('caughtMoreThanWanted'), lateAgentMonths: S('lateAgentMonths'), unattributedFish: S('unattributedFish'),
      };
    }
    const mc = rs.map((r) => r.s.mentalContribution).filter(Boolean);
    if (mc.length) {
      const dec = mc.reduce((a, m) => a + m.harvestDecisions, 0);
      const cit = mc.reduce((a, m) => a + m.decisionsCitingMentalTerms, 0);
      const terms = {}; const shown = {};
      for (const m of mc) { for (const [k, v] of Object.entries(m.citedTerms)) terms[k] = (terms[k] || 0) + v; for (const [k, v] of Object.entries(m.shownPhrases)) shown[k] = (shown[k] || 0) + v; }
      row.mental = { harvestDecisions: dec, citingMentalTerms: cit, citingShare: dec ? +(cit / dec).toFixed(3) : null,
        citedTerms: Object.fromEntries(Object.entries(terms).sort((a, b) => b[1] - a[1])),
        shownPhrasesTop: Object.fromEntries(Object.entries(shown).sort((a, b) => b[1] - a[1]).slice(0, 15)) };
      const cc = {};
      for (const r of rs) for (const [k, v] of Object.entries(citeCounts(r.dir))) { const o = (cc[k] = cc[k] || { calls: 0, citing: 0, personality: 0 }); o.calls += v.calls; o.citing += v.citing; o.personality += v.personality; }
      row.mental.citingByKind = cc;
      const jc = { breach: 0, kept: 0 };
      for (const r of rs) for (const [k, v] of Object.entries(judgedCounts(r.dir))) jc[k] = (jc[k] || 0) + v;
      row.mental.judged = jc;
      if (nEx) row.examples = rs.flatMap((r) => examples(r.dir, nEx)).slice(0, nEx * 2);
    }
    rows.push(row);
  }
  const cols = ['group', 'runs', 'survivalMonths', 'survivalRate', 'collapsed', 'gain', 'efficiency', 'equality', 'overUsage', 'wantedPerAgentMonth', 'caughtPerAgentMonth', 'agreements', 'parseFailures', 'llmCalls', 'costUsd'];
  console.log(`| ${cols.join(' | ')} |`);
  console.log(`|${cols.map(() => '---').join('|')}|`);
  for (const r of rows) console.log(`| ${cols.map((c) => r[c]).join(' | ')} |`);
  for (const r of rows.filter((x) => x.embodied)) console.log(`\n## ${r.group}: 体があることで知ったこと\n${JSON.stringify(r.embodied)}`);
  for (const r of rows.filter((x) => x.mental)) {
    console.log(`\n## ${r.group}: 心の言葉`);
    console.log(JSON.stringify(r.mental, null, 1));
    for (const e of r.examples || []) console.log(`- ${e.agent} ${e.month}月 (答え ${e.answer}) 挙げた言葉 ${e.cited.join(', ')}\n  心: ${e.mental}\n  考え: ${e.text}`);
  }
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ rows, runs: runs.map((r) => r.dir) }, null, 2));
}

if (require.main === module) main();
module.exports = { findSummaries, mean, sd };
