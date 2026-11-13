#!/usr/bin/env node
'use strict';
// わだかまりと、悪い関係のときの行動の集計 (src/conflict_agent.js の記録 grudge / grudge_ease / conflict_act / hit / kill と、毎判断の conflict)。
//   node tools/conflict_stats.js runs/<時刻>/ [--json]
//   - わだかまりの発生 (きっかけ別)・減少 (良い出来事別)
//   - 悪い関係の行動: 候補に出た判断の数と選ばれた回数 (行動別)、殴る・殴られた・見た・殺した
//   - 誰が殴ったか (aggressionStats。2026-11-13 ユーザー決定「殴る・取り返すに重みは掛けない。そのかわり実行のあとに、挑発された人ほど殴ったか・
//     協調性の低い人ほど殴ったかを数えて文献の向きと比べる」): 人ごとに 殴った回数 (event hit) と、挑発されたか (人に殴られた・殺された = grudge の hit/killed か
//     hit_received、広くは何かのわだかまりのきっかけ) と、協調性 (start の persona.bigFive.z.A) を並べて、
//       挑発: 挑発された人とされていない人の殴った回数の差の効果量 d (併合 SD) と、1回でも殴った人の割合。文献: 挑発 d = .76 (Anderson & Bushman 1997, Rev. Gen. Psychol. 1, 19-41)
//       協調性: 協調性 z と殴った回数の相関 r。文献: r = −.20 (Hyatt, Zeichner, & Miller 2019, Psychol. Violence 9, 675-689 の実験室の攻撃との相関)
//     人の数が少ない・殴った人が少ないと値は大きく揺れる (n と殴った人の数も出す)
//   - 関係の悪化 → 行動: 近く (16m) にいた人ごとに、わだかまりのある相手/ない相手で、follow・give・call・ask・go_to(人) の相手に選んだ割合と、近くの人との距離の平均
const { readRun } = require('./provenance_stats');

const isStep = (r) => !!(r && r.loop && r.action && !r.event && r.result);
const r3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);
const inc = (m, k, n = 1) => { m[k] = (m[k] || 0) + n; return m; };
const PARTNER = new Set(['follow', 'give', 'call', 'ask', 'go_to']);
const targetOf = (s) => (PARTNER.has(s.action) ? String(s.arg || '').split(':')[0] : null);

const LIT = { provocationD: 0.76, agreeablenessR: -0.2 };
function dOf(a, b) {
  if (a.length < 2 || b.length < 2) return null;
  const m = (x) => x.reduce((s, v) => s + v, 0) / x.length;
  const v = (x) => { const mm = m(x); return x.reduce((s, y) => s + (y - mm) ** 2, 0) / (x.length - 1); };
  const sp = Math.sqrt(((a.length - 1) * v(a) + (b.length - 1) * v(b)) / (a.length + b.length - 2));
  return sp > 0 ? r3((m(a) - m(b)) / sp) : null;
}
function rOf(x, y) {
  const n = x.length; if (n < 3) return null;
  const mx = x.reduce((s, v) => s + v, 0) / n; const my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0; let sxx = 0; let syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx > 0 && syy > 0 ? r3(sxy / Math.sqrt(sxx * syy)) : null;
}
// 誰が殴ったか (上の説明)。人は start の行がある人 (persona.bigFive.z.A が無い人は協調性の相関から外す)
function aggressionStats(all) {
  const people = new Map();
  for (const r of all) if (r.event === 'start' && r._name) people.set(r._name, { name: r._name, A: r.persona && r.persona.bigFive && r.persona.bigFive.z ? r.persona.bigFive.z.A : null, hits: 0, hitBy: 0, wronged: 0 });
  if (!people.size) return null;
  for (const r of all) {
    const p = people.get(r._name); if (!p) continue;
    if (r.event === 'hit') p.hits += 1;
    if (r.event === 'hit_received' || r.event === 'killed_by' || (r.event === 'grudge' && (r.kind === 'hit' || r.kind === 'killed'))) p.hitBy += 1;
    if (r.event === 'grudge' && r.add > 0) p.wronged += 1;
  }
  const ps = [...people.values()];
  const split = (f) => {
    const yes = ps.filter(f); const no = ps.filter((p) => !f(p));
    const share = (g) => (g.length ? r3(g.filter((p) => p.hits > 0).length / g.length) : null);
    return { n: [yes.length, no.length], hitters: [yes.filter((p) => p.hits > 0).length, no.filter((p) => p.hits > 0).length], share: [share(yes), share(no)], d: dOf(yes.map((p) => p.hits), no.map((p) => p.hits)) };
  };
  const withA = ps.filter((p) => Number.isFinite(p.A));
  return {
    people: ps.length, hitters: ps.filter((p) => p.hits > 0).length, hits: ps.reduce((s, p) => s + p.hits, 0),
    provokedPhysical: split((p) => p.hitBy > 0), provokedAny: split((p) => p.wronged > 0 || p.hitBy > 0),
    agreeableness: { n: withA.length, r: rOf(withA.map((p) => p.A), withA.map((p) => p.hits)), rAny: rOf(withA.map((p) => p.A), withA.map((p) => (p.hits > 0 ? 1 : 0))) },
    literature: LIT,
  };
}

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
    aggression: aggressionStats(all),
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
    ...(c.aggression ? [`  誰が殴ったか (${c.aggression.people} 人中 ${c.aggression.hitters} 人・${c.aggression.hits} 回): 殴られた・殺された人 ${c.aggression.provokedPhysical.share[0] ?? '-'} が殴った (${c.aggression.provokedPhysical.hitters[0]}/${c.aggression.provokedPhysical.n[0]})・そうでない人 ${c.aggression.provokedPhysical.share[1] ?? '-'} (${c.aggression.provokedPhysical.hitters[1]}/${c.aggression.provokedPhysical.n[1]})、回数の d ${c.aggression.provokedPhysical.d ?? '-'} (何かのわだかまりで分けると ${c.aggression.provokedAny.d ?? '-'}。文献の挑発 d ${LIT.provocationD})、協調性と殴った回数 r ${c.aggression.agreeableness.r ?? '-'} (文献 ${LIT.agreeablenessR})`] : []),
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
module.exports = { conflictStats, aggressionStats, lines };
