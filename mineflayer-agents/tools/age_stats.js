'use strict';
// 年齢層ごとのまとめ (summarize_run.js から。100人の実行を読むため。2026-11-10)
//   persona.age / ageGroup (configs/survival_100.json。記録の start の persona) で人を 子供・若者・大人・老人 に分け、
//   層ごとの行動・ゴール (欲求・種類・物)・発言・欲求の平均・死んだ回数・集まり・遠出と、層×層の関係 (好感の変化) を出す。
//   年齢の無い persona (survival_3days の20人など) は「年齢なし」。
const { LAYERS, layerOf } = require('./gen_personas');

const GROUP_JA = Object.fromEntries([...LAYERS.map((l) => [l.key, l.ja]), ['none', '年齢なし']]);
const ORDER = [...LAYERS.map((l) => l.key), 'none'];
const isStep = (r) => !!(r && r.loop && r.action && !r.event && r.result);
const sum = (a) => a.reduce((s, x) => s + (x || 0), 0);
const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const share = (m, total, n = 5) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => [k, total ? Math.round((v / total) * 100) : 0]);
const median = (v) => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); const h = Math.floor(s.length / 2); return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };

// 人 → { age, sex, group }
function personInfo(rows) {
  const st = rows.find((r) => r.event === 'start') || {};
  const p = st.persona || {};
  const age = Number.isFinite(p.age) ? p.age : null;
  const group = p.ageGroup || (age != null && layerOf(age) ? layerOf(age).key : 'none');
  return { age, sex: p.sex || null, group };
}

// 1人の発言 (近くの発言・全体チャット・判断の say・答え)。独り言は別に数える
function utterances(rows) {
  const out = [];
  for (const r of rows) {
    let t = null;
    if (isStep(r) && r.say) t = r.say;
    else if (r.event === 'talk' && r.say) t = r.say;
    else if (r.event === 'board' && (r.kind === 'broadcast' || r.kind === 'report_find') && r.say) t = r.say;
    else if (r.event === 'answer' && r.answer) t = r.answer;
    if (t) out.push({ ts: r.ts, text: String(t) });
  }
  return out;
}

function ageGroupStats(rowsByName, { survival = null, clusters = null, needs = null, spawnDistance = null, relations = null, samples = 3 } = {}) {
  const info = Object.fromEntries(Object.entries(rowsByName).map(([n, rows]) => [n, personInfo(rows)]));
  const groups = {};
  for (const g of ORDER) {
    const names = Object.keys(info).filter((n) => info[n].group === g).sort((a, b) => (info[a].age ?? 0) - (info[b].age ?? 0));
    if (!names.length) continue;
    const steps = names.flatMap((n) => rowsByName[n].filter(isStep));
    const acts = {}; for (const r of steps) acts[r.action] = (acts[r.action] || 0) + 1;
    const goals = names.flatMap((n) => rowsByName[n].filter((r) => r.event === 'goal_path' && r.kind === 'goal' && r.ok));
    const byNeed = {}; const byKind = {}; const byTarget = {};
    for (const r of goals) {
      byNeed[r.need || '-'] = (byNeed[r.need || '-'] || 0) + 1;
      byKind[r.goalKind || '-'] = (byKind[r.goalKind || '-'] || 0) + 1;
      const t = r.goalKind === 'person' && r.give ? `give:${r.give}` : String(r.target || '-');
      byTarget[t] = (byTarget[t] || 0) + 1;
    }
    const done = names.flatMap((n) => rowsByName[n].filter((r) => r.event === 'goal_path' && r.kind === 'goal_done')).length;
    const utt = names.flatMap((n) => utterances(rowsByName[n]).map((u) => ({ ...u, who: n })));
    const mutter = utt.filter((u) => /^\s*[(（]ひとりごと[)）]/.test(u.text));
    const spoken = utt.filter((u) => !/^\s*[(（]ひとりごと[)）]/.test(u.text));
    const asks = names.flatMap((n) => rowsByName[n].filter((r) => r.event === 'ask')).length;
    const needAvg = {};
    if (needs) {
      for (const k of ['hunger', 'sleep', 'safety', 'connection', 'recognition', 'curiosity', 'greed', 'care', 'stress']) {
        const v = names.map((n) => needs[n] && needs[n].overall[k] && needs[n].overall[k].avg).filter((x) => Number.isFinite(x));
        if (v.length) needAvg[k] = r2(sum(v) / v.length);
      }
    }
    const per = (x) => r2(x / names.length);
    // 発言の見本: 時刻順に均等に samples 個
    const sp = [...spoken].sort((a, b) => (a.ts < b.ts ? -1 : 1));
    const pick = sp.length <= samples ? sp : Array.from({ length: samples }, (_, i) => sp[Math.floor((i * sp.length) / samples)]);
    const ages = names.map((n) => info[n].age).filter((x) => x != null);
    groups[g] = {
      label: GROUP_JA[g], n: names.length, ages: ages.length ? `${Math.min(...ages)}-${Math.max(...ages)}` : null,
      male: names.filter((n) => info[n].sex === 'male').length, female: names.filter((n) => info[n].sex === 'female').length,
      decisionsPerPerson: per(steps.length), successPct: steps.length ? Math.round((steps.filter((r) => r.result.ok).length / steps.length) * 100) : null,
      actionsPct: share(acts, steps.length, 6),
      deathsPerPerson: survival ? per(sum(names.map((n) => survival.perAgent[n] || 0))) : null,
      inGroupPct: clusters && clusters.perAgent ? Math.round((sum(names.map((n) => (clusters.perAgent[n] ? clusters.perAgent[n].inGroupShare : 0))) / names.length) * 100) : null,
      spawnDistanceMedian: spawnDistance ? median(names.map((n) => spawnDistance.perAgent[n]).filter((x) => x != null)) : null,
      goals: { perPerson: per(goals.length), donePerPerson: per(done), needPct: share(byNeed, goals.length, 8), kindPct: share(byKind, goals.length, 4), topTargets: share(byTarget, goals.length, 5) },
      talk: { perPerson: per(spoken.length), avgChars: spoken.length ? Math.round(sum(spoken.map((u) => u.text.length)) / spoken.length) : null, mutterPerPerson: per(mutter.length), asksPerPerson: per(asks),
        samples: pick.map((u) => `${u.who}(${info[u.who].age ?? '-'}): ${u.text.slice(0, 80)}`) },
      needsAvg: needAvg,
      slept: needs ? per(sum(names.map((n) => (needs[n] ? needs[n].slept : 0)))) : null,
      ate: needs ? per(sum(names.map((n) => (needs[n] ? needs[n].ate : 0)))) : null,
      names,
    };
  }
  // 層 × 層の関係: 会った組の数と、好感の変化の平均 (from の層 → to の層)
  let relByGroup = null;
  if (relations && relations.matrix) {
    relByGroup = {};
    for (const [a, row] of Object.entries(relations.matrix)) {
      const ga = info[a] ? info[a].group : 'none';
      for (const [b, d] of Object.entries(row)) {
        if (d == null) continue;
        const gb = info[b] ? info[b].group : 'none';
        const k = `${ga}->${gb}`;
        const c = (relByGroup[k] = relByGroup[k] || { pairs: 0, sum: 0 });
        c.pairs += 1; c.sum += d;
      }
    }
    for (const c of Object.values(relByGroup)) { c.avg = r2(c.sum / c.pairs); delete c.sum; }
  }
  return { groups, relations: relByGroup, info };
}

// 文章 (summarize_run --text)
function lines(st) {
  const out = [];
  if (!st || !Object.keys(st.groups).length) return out;
  out.push('年齢層ごと:');
  for (const g of ORDER) {
    const x = st.groups[g]; if (!x) continue;
    const ap = (l) => l.map(([k, v]) => `${k} ${v}%`).join('・') || '-';
    out.push(`  ${x.label} ${x.n}人 (${x.ages ?? '-'}歳、男${x.male}・女${x.female}): 判断 1人 ${x.decisionsPerPerson} 回 (成功 ${x.successPct ?? '-'}%)、死 1人 ${x.deathsPerPerson ?? '-'}、集まり ${x.inGroupPct ?? '-'}%、出現地点から最大 中央値 ${x.spawnDistanceMedian ?? '-'}m、寝た ${x.slept ?? '-'}・食べた ${x.ate ?? '-'} 回/人`);
    out.push(`    行動: ${ap(x.actionsPct)}`);
    out.push(`    ゴール 1人 ${x.goals.perPerson} 個 (済んだ ${x.goals.donePerPerson})、欲求: ${ap(x.goals.needPct)}、種類: ${ap(x.goals.kindPct)}、物: ${ap(x.goals.topTargets)}`);
    out.push(`    発言 1人 ${x.talk.perPerson} 回 (平均 ${x.talk.avgChars ?? '-'} 字)・独り言 ${x.talk.mutterPerPerson}・聞いた ${x.talk.asksPerPerson}、欲求の平均: ${Object.entries(x.needsAvg).map(([k, v]) => `${k} ${v}`).join(' ') || '-'}`);
    for (const s of x.talk.samples) out.push(`      「${s}」`);
  }
  if (st.relations && Object.keys(st.relations).length) {
    const present = ORDER.filter((g) => st.groups[g]);
    out.push(`  層×層の関係 (行 → 列、会った組の数 / 好感の変化の平均): ${present.map((g) => GROUP_JA[g]).join('・')}`);
    for (const a of present) out.push(`    ${GROUP_JA[a]}: ${present.map((b) => { const c = st.relations[`${a}->${b}`]; return c ? `${c.pairs}/${c.avg > 0 ? '+' : ''}${c.avg}` : '-'; }).join('  ')}`);
  }
  return out;
}

// 人ごとの1行の要約を年齢層ごとにまとめる (brief は scale_stats.briefPerAgent の行。先頭が「名前:」)
function briefByGroup(brief, st) {
  const out = [];
  const byName = new Map(brief.map((l) => [l.split(':')[0], l]));
  for (const g of ORDER) {
    const x = st.groups[g]; if (!x) continue;
    out.push(`${x.label} (${x.n}人):`);
    for (const n of x.names) { const l = byName.get(n); if (l) out.push(`  ${st.info[n].age != null ? `${st.info[n].age}${st.info[n].sex === 'female' ? '女' : st.info[n].sex === 'male' ? '男' : ''} ` : ''}${l}`); }
  }
  return out;
}

module.exports = { ageGroupStats, lines, briefByGroup, personInfo, GROUP_JA };
