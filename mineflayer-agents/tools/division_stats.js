#!/usr/bin/env node
'use strict';
// 分業の指標 (division.js の分類表で数える。division の記録が無い前の記録にも当てられる)。
//   node tools/division_stats.js runs/<時刻>/ [--bins 6] [--json]
//   人ごと・活動ごとの回数と割合 (行動 / ゴール)、時間の区切りごとの推移、
//   分業の度合い: DOL 指数 (Gorelick et al. 2004: I(人; 活動) / H(活動))・人ごとの偏り (1 − H/log2 K)・活動ごとの担い手の Gini・集団の広がり (H(活動)/log2 K)、
//   刺激・しきい値・T の推移 (毎判断の division の記録があるとき)、役回りの言葉 (振り返りの role)、分業で選んだ案が変わった回数
const fs = require('fs');
const path = require('path');
const { ACTIVITIES, actionActivity, goalActivity, dolIndex } = require('../src/division');

const isStep = (r) => !!(r && r.loop && r.action && !r.event && r.result);
const r3 = (v) => Math.round(v * 1000) / 1000;

function readRun(target) {
  const files = fs.statSync(target).isDirectory()
    ? fs.readdirSync(target).filter((f) => f.endsWith('.jsonl') && !/^monitor(-\d+)?\.jsonl$/.test(f)).map((f) => path.join(target, f)) : [target];
  const all = [];
  for (const f of files) {
    const rows = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const st = rows.find((r) => r.event === 'start');
    const name = (st && (st.persona && st.persona.name || st.name)) || path.basename(f).replace(/-\d{4}-.*$/, '');
    for (const r of rows) all.push({ ...r, _name: name });
  }
  return all;
}

function countsOf(rows, f) {
  const c = {};
  for (const r of rows) {
    const a = f(r);
    if (!a) continue;
    (c[r._name] || (c[r._name] = {}))[a] = ((c[r._name] || {})[a] || 0) + 1;
  }
  return c;
}

const stepAct = (r) => (r.division && r.division.act !== undefined ? r.division.act : actionActivity(r.action, r.arg));
const goalAct = (r) => r.activity || goalActivity({ kind: r.goalKind, target: r.target, place: r.place || null });

function divisionStats(all, { bins = 6 } = {}) {
  const steps = all.filter(isStep);
  const goals = all.filter((r) => r.event === 'goal_path' && r.kind === 'goal');
  const ts = (r) => (r.ts ? Date.parse(r.ts) : null);
  const tAll = [...steps, ...goals].map(ts).filter(Number.isFinite);
  const t0 = Math.min(...tAll); const t1 = Math.max(...tAll);
  const binOf = (r) => { const t = ts(r); if (!Number.isFinite(t) || t1 <= t0) return 0; return Math.min(bins - 1, Math.floor(((t - t0) / (t1 - t0)) * bins)); };
  const acts = countsOf(steps, stepAct);
  const gl = countsOf(goals, goalAct);
  const share = (c) => Object.fromEntries(Object.entries(c).map(([n, m]) => { const s = Object.values(m).reduce((a, b) => a + b, 0); return [n, Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, `${v} (${Math.round((v / s) * 100)}%)`]))]; }));
  const timeline = [];
  for (let b = 0; b < bins; b++) {
    const sb = steps.filter((r) => binOf(r) === b); const gb = goals.filter((r) => binOf(r) === b);
    const da = dolIndex(countsOf(sb, stepAct)); const dg = dolIndex(countsOf(gb, goalAct));
    timeline.push({ bin: b, minutes: Number.isFinite(t0) ? [Math.round(((t1 - t0) * b) / bins / 60000), Math.round(((t1 - t0) * (b + 1)) / bins / 60000)] : null,
      acts: { n: da.total, dol: da.dol, meanSpecialization: da.meanSpecialization, groupSpread: da.groupSpread, share: da.activityShare },
      goals: { n: dg.total, dol: dg.dol, meanSpecialization: dg.meanSpecialization, groupSpread: dg.groupSpread, share: dg.activityShare } });
  }
  // 刺激・しきい値・T (毎判断の division)
  const withDiv = steps.filter((r) => r.division);
  let stim = null;
  if (withDiv.length) {
    stim = { perBin: [], perAgentEnd: {} };
    for (let b = 0; b < bins; b++) {
      const rs = withDiv.filter((r) => binOf(r) === b);
      const mean = (k) => Object.fromEntries(ACTIVITIES.map((a) => [a, rs.length ? r3(rs.reduce((t, r) => t + ((r.division[k] || {})[a] || 0), 0) / rs.length) : 0]).filter(([, v]) => v > 0));
      stim.perBin.push({ bin: b, n: rs.length, s: mean('s'), theta: mean('theta'), T: mean('T'), fam: mean('fam') });
    }
    for (const r of withDiv) stim.perAgentEnd[r._name] = { T: r.division.T, fam: r.division.fam };
  }
  const sel = goals.filter((r) => r.select && r.select.division);
  const roles = all.filter((r) => r.event === 'reflect' && r.role).map((r) => `${r._name}: ${r.role}`);
  const ends = all.filter((r) => r.event === 'end' && r.division);
  return {
    activities: ACTIVITIES,
    acts: { overall: dolIndex(acts), perAgent: share(acts) },
    goals: { overall: dolIndex(gl), perAgent: share(gl) },
    timeline,
    stimulus: stim,
    select: sel.length ? { n: sel.length, changed: sel.filter((r) => r.select.division.changed).length, divisionOnly: sel.filter((r) => r.select.rule === 'division_only').length,
      examples: sel.filter((r) => r.select.division.changed).slice(0, 6).map((r) => `${r._name}: ${r.select.scores.map((s, i) => `${i === r.select.chosen ? '*' : ''}${s.target}[${s.activity || '-'} T=${s.T}] ${s.score}${s.noDivision != null ? ` (なしなら ${s.noDivision})` : ''}`).join(' / ')}`) } : null,
    roles: roles.slice(0, 20),
    othersRoles: ends.length ? Object.fromEntries(ends.map((r) => [r._name, Object.fromEntries(Object.entries(r.division.roles || {}).filter(([, v]) => v.length).map(([n, v]) => [n, v.map((x) => x.act)]))])) : null,
  };
}

function textLines(d) {
  const out = [];
  const o = d.acts.overall; const g = d.goals.overall;
  out.push(`分業 (行動 ${o.total} 回): DOL ${o.dol}・人ごとの偏り (平均) ${o.meanSpecialization}・集団の広がり ${o.groupSpread}・割合 ${JSON.stringify(o.activityShare)}`);
  out.push(`  担い手の Gini ${JSON.stringify(o.giniByActivity)}`);
  out.push(`分業 (ゴール ${g.total} 個): DOL ${g.dol}・人ごとの偏り (平均) ${g.meanSpecialization}・集団の広がり ${g.groupSpread}・割合 ${JSON.stringify(g.activityShare)}`);
  out.push(`  担い手の Gini ${JSON.stringify(g.giniByActivity)}`);
  out.push(`  人ごと (行動の上位): ${Object.entries(o.perAgent || {}).map(([n, v]) => `${n} ${v.top.join(',')}`).join(' / ')}`);
  out.push(`  人ごと (ゴールの上位): ${Object.entries(g.perAgent || {}).map(([n, v]) => `${n} ${v.top.join(',')}`).join(' / ')}`);
  out.push(`  推移 (行動の DOL / ゴールの DOL): ${d.timeline.map((t) => `${t.minutes ? `${t.minutes[0]}-${t.minutes[1]}分` : t.bin} ${t.acts.dol}/${t.goals.dol}`).join('・')}`);
  if (d.stimulus) for (const b of d.stimulus.perBin) out.push(`  刺激 ${b.bin}: s ${JSON.stringify(b.s)} T ${JSON.stringify(b.T)}`);
  if (d.select) { out.push(`  分業で選んだ案が変わった ${d.select.changed}/${d.select.n} (つらい欲求が無く T で選んだ ${d.select.divisionOnly})`); for (const l of d.select.examples) out.push(`    ${l}`); }
  for (const l of d.roles.slice(0, 8)) out.push(`  役回り (振り返り): ${l}`);
  return out;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith('--'));
  const bi = args.indexOf('--bins');
  const d = divisionStats(readRun(target), { bins: bi >= 0 ? Number(args[bi + 1]) : 6 });
  if (args.includes('--json')) console.log(JSON.stringify(d, null, 2)); else console.log(textLines(d).join('\n'));
}

module.exports = { divisionStats, textLines, readRun };
