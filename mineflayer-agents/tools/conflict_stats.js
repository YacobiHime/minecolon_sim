#!/usr/bin/env node
'use strict';
// わだかまりと、悪い関係のときの行動の集計 (src/conflict_agent.js の記録 grudge / grudge_ease / conflict_act / hit / kill と、毎判断の conflict)。
//   node tools/conflict_stats.js runs/<時刻>/ [--json]
//   - わだかまりの発生 (きっかけ別)・減少 (良い出来事別)
//   - 悪い関係の行動: 候補に出た判断の数と選ばれた回数 (行動別)、殴る・殴られた・見た・殺した
//   - 関係の悪化 → 行動: 近く (16m) にいた人ごとに、わだかまりのある相手/ない相手で、follow・give・call・ask・go_to(人) の相手に選んだ割合と、近くの人との距離の平均
const { readRun } = require('./provenance_stats');

const isStep = (r) => !!(r && r.loop && r.action && !r.event && r.result);
const r3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);
const inc = (m, k, n = 1) => { m[k] = (m[k] || 0) + n; return m; };
const PARTNER = new Set(['follow', 'give', 'call', 'ask', 'go_to']);
const targetOf = (s) => (PARTNER.has(s.action) ? String(s.arg || '').split(':')[0] : null);

function conflictStats(all, { near = 16 } = {}) {
  const steps = all.filter(isStep);
  const grudges = all.filter((r) => r.event === 'grudge');
  const eases = all.filter((r) => r.event === 'grudge_ease');
  const byKind = {}; for (const g of grudges) { const k = byKind[g.kind] || (byKind[g.kind] = { n: 0, add: 0, affinity: 0 }); k.n += 1; k.add = r3(k.add + (g.add || 0)); k.affinity = r3(k.affinity + (g.affinity || 0)); }
  const easeBy = {}; for (const e of eases) inc(easeBy, e.kind);
  const offered = {}; const offeredSteps = {};
  for (const s of steps) {
    const names = new Set();
    for (const k of (s.conflict && s.conflict.offered) || []) { const a = k.split(':')[0]; inc(offered, a); names.add(a); }
    for (const a of names) inc(offeredSteps, a);
  }
  const acts = all.filter((r) => r.event === 'conflict_act');
  const chosen = {}; const chosenOk = {};
  for (const a of acts) { inc(chosen, a.action); if (a.ok) inc(chosenOk, a.action); }
  const actions = {};
  for (const a of new Set([...Object.keys(offeredSteps), ...Object.keys(chosen)])) actions[a] = { offeredDecisions: offeredSteps[a] || 0, chosen: chosen[a] || 0, ok: chosenOk[a] || 0, rate: offeredSteps[a] ? r3((chosen[a] || 0) / offeredSteps[a]) : null };
  // 殴った人の気質・怒り (誰が殴ったか)
  const hits = all.filter((r) => r.event === 'hit');
  const mean = (xs) => (xs.length ? r3(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  const hitters = { n: hits.length, people: new Set(hits.map((h) => h._name)).size, blows: hits.reduce((s, h) => s + (h.hits || 0), 0), retaliation: hits.filter((h) => h.retaliation).length,
    anger: mean(hits.map((h) => h.emotions && h.emotions.anger).filter(Number.isFinite)), bravery: mean(hits.map((h) => h.temperament && h.temperament.bravery).filter(Number.isFinite)),
    empathy: mean(hits.map((h) => h.temperament && h.temperament.empathy).filter(Number.isFinite)), obedience: mean(hits.map((h) => h.temperament && h.temperament.obedience).filter(Number.isFinite)) };
  // 関係の悪化 → 行動
  const pc = { grudge: { opp: 0, chosen: 0, d: [] }, none: { opp: 0, chosen: 0, d: [] } };
  for (const s of steps) {
    const c = s.conflict;
    if (!c || !c.near) continue;
    const t = targetOf(s);
    for (const p of c.near) {
      const b = c.grudges && c.grudges[p.n] ? pc.grudge : pc.none;
      b.d.push(p.d);
      if (p.d > near) continue;
      b.opp += 1;
      if (t === p.n) b.chosen += 1;
    }
  }
  const partner = Object.fromEntries(Object.entries(pc).map(([k, b]) => [k, { opportunities: b.opp, chosen: b.chosen, rate: b.opp ? r3(b.chosen / b.opp) : null, meanDistance: mean(b.d) }]));
  return {
    grudges: { n: grudges.length, byKind, pairs: new Set(grudges.filter((g) => g.add > 0).map((g) => `${g._name}>${g.who}`)).size, eased: eases.length, easeBy },
    actions,
    violence: { hits: hitters, received: all.filter((r) => r.event === 'hit_received').length, seen: all.filter((r) => r.event === 'hit_seen').length,
      kills: all.filter((r) => r.event === 'kill').length, killedBy: all.filter((r) => r.event === 'killed_by').length },
    heard: all.filter((r) => r.event === 'conflict_heard').reduce((m, r) => inc(m, r.type), {}),
    partnerChoice: partner,
  };
}

function lines(c) {
  if (!c || (!c.grudges.n && !Object.keys(c.actions).length)) return [];
  const j = (o, f = (v) => v) => Object.entries(o || {}).map(([k, v]) => `${k} ${f(v)}`).join('・') || 'なし';
  const p = c.partnerChoice;
  return [
    `わだかまりの発生 ${c.grudges.n} 回 (${c.grudges.pairs} 組。${j(c.grudges.byKind, (v) => v.n)})、減った ${c.grudges.eased} 回 (${j(c.grudges.easeBy)})`,
    `  悪い関係の行動 (選んだ/候補に出た判断): ${j(c.actions, (v) => `${v.chosen}/${v.offeredDecisions}`)}`,
    `  殴った ${c.violence.hits.n} 回 (${c.violence.hits.people} 人・${c.violence.hits.blows} 発・やり返し ${c.violence.hits.retaliation}。そのときの怒り ${c.violence.hits.anger ?? '-'}・共感 ${c.violence.hits.empathy ?? '-'})、殴られた ${c.violence.received}・見た ${c.violence.seen}・殺した ${c.violence.kills}・殺された ${c.violence.killedBy}`,
    `  近くの人を相手に選んだ割合 (follow・give・call・ask・go_to): わだかまりあり ${p.grudge.rate ?? '-'} (${p.grudge.chosen}/${p.grudge.opportunities})・なし ${p.none.rate ?? '-'} (${p.none.chosen}/${p.none.opportunities})、距離の平均 あり ${p.grudge.meanDistance ?? '-'}m・なし ${p.none.meanDistance ?? '-'}m`,
  ];
}

function main() {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith('--'));
  if (!target) { console.error('usage: node tools/conflict_stats.js <runs/<時刻>/> [--json]'); process.exit(2); }
  const c = conflictStats(readRun(target));
  if (args.includes('--json')) console.log(JSON.stringify(c, null, 2)); else for (const l of lines(c)) console.log(l);
}

if (require.main === module) main();
module.exports = { conflictStats, lines };
