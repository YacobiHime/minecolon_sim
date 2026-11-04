#!/usr/bin/env node
'use strict';
// 実行の記録を集計する。
//   node tools/summarize_run.js runs/<時刻>/            (run.js の1回の実行 = 全員分。run.json があれば使用量もそこから)
//   node tools/summarize_run.js runs/Taro-....jsonl     (段階1の1人分のファイルも読める)
//   --excerpt N   会話の抜粋の行数 (既定 40)   --text   週次報告用の短い文章も出す
const fs = require('fs');
const path = require('path');
const { JEV_USD_PER_MTOK } = require('../src/usage');
const scale = require('./scale_stats');

function pct(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
const sum = (a) => a.reduce((s, x) => s + (x || 0), 0);
const maxOf = (a) => (a.length ? Math.max(...a) : null);

// 1回の判断の行 (event の行・result の無い行は除く。answer_use などの event 行にも loop と action が付いている)
const isStep = (r) => !!(r && r.loop && r.action && !r.event && r.result);

function readJsonl(f) {
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}

// 探索: 訪れたマス (各ループの位置を exploreCell 四方の格子で数える。記憶の忘れとは関係なく記録から数える)・explore の種類・新しいマスだった回数
function exploreStats(loops, start) {
  const size = (start.explore && start.explore.cell) || 16;
  const cells = new Set(loops.filter((r) => r.pos).map((r) => `${Math.floor(r.pos.x / size)},${Math.floor(r.pos.z / size)}`));
  const ex = loops.filter((r) => r.action === 'explore');
  const byKind = {};
  for (const r of ex) { const k = (r.result.explore && r.result.explore.kind) || 'dir'; byKind[k] = (byKind[k] || 0) + 1; }
  return {
    mode: (start.explore && start.explore.mode) || 'basic', cell: size, visitedCells: cells.size, cellKeys: [...cells],
    n: ex.length, ok: ex.filter((r) => r.result.ok).length, newCell: ex.filter((r) => r.result.explore && r.result.explore.newCell).length, byKind,
    movedP50: pct(ex.map((r) => r.result.explore && r.result.explore.moved).filter((x) => x != null), 50),
  };
}

// build で置いた物: 原木・板材・そのほかの、選んだ回数と置いた個数 (result.placed)
function buildStats(loops) {
  const out = { log: { n: 0, placed: 0 }, planks: { n: 0, placed: 0 }, other: { n: 0, placed: 0 } };
  for (const r of loops.filter((x) => x.action === 'build')) {
    const k = /_log$/.test(r.arg) ? 'log' : /_planks$/.test(r.arg) ? 'planks' : 'other';
    out[k].n += 1;
    out[k].placed += (r.result && r.result.placed) || 0;
  }
  return out;
}

// 同じ行動・引数が続いた最長の回数
function maxRun(loops) {
  let best = 0; let n = 0; let prev = null;
  for (const r of loops) { const k = `${r.action}:${r.arg}`; n = k === prev ? n + 1 : 1; prev = k; if (n > best) best = n; }
  return best;
}

function summarizeAgent(file, rows) {
  const loops = rows.filter(isStep);
  const start = rows.find((r) => r.event === 'start') || {};
  const byAction = {};
  const failReasons = {};
  for (const r of loops) {
    const a = (byAction[r.action] = byAction[r.action] || { n: 0, ok: 0 });
    a.n += 1;
    if (r.result.ok) a.ok += 1;
    else {
      const k = `${r.action}: ${String(r.result.msg).replace(/[-\d(),]+/g, '#').slice(0, 40)}`;
      failReasons[k] = (failReasons[k] || 0) + 1;
    }
  }
  const dec = loops.map((r) => r.decideMs).filter((x) => x != null);
  const ptok = loops.map((r) => r.promptTokens).filter((x) => x != null);
  const pch = loops.map((r) => r.promptChars).filter((x) => x != null);
  const goal = rows.find((r) => r.event === 'goal');
  const t0 = rows[0] && new Date(rows[0].ts);
  const last = loops[loops.length - 1];
  const firstHave = (name) => { const r = loops.find((x) => (x.inventory || []).some((i) => i.name === name || i.name.endsWith(name))); return r ? r.loop : null; };
  const jevLoops = loops.filter((r) => r.jev);
  return {
    file: path.basename(file),
    name: start.persona ? start.persona.name : path.basename(file).split('-')[0],
    decider: start.decider || null,
    help: start.help || null,
    loops: loops.length,
    minutes: loops.length ? Math.round((new Date(last.ts) - t0) / 600) / 100 : 0,
    goalAtLoop: goal ? goal.loop : null,
    goalAtMin: goal ? Math.round((new Date(goal.ts) - t0) / 600) / 100 : null,
    goalTimeOfDay: goal ? goal.timeOfDay ?? null : null,
    goalBeforeNight: goal ? (goal.day === start.day || start.day == null) && (goal.timeOfDay ?? 0) < 12542 : false,
    milestones: { log: firstHave('_log'), planks: firstHave('_planks'), crafting_table: firstHave('crafting_table'), wooden_pickaxe: firstHave('wooden_pickaxe'),
      food: (loops.find((x) => (x.foodCount || 0) > 0) || {}).loop ?? null },
    actions: byAction,
    success: loops.filter((r) => r.result.ok).length,
    failure: loops.filter((r) => !r.result.ok).length,
    failReasons: Object.fromEntries(Object.entries(failReasons).sort((a, b) => b[1] - a[1]).slice(0, 8)),
    parseFail: loops.filter((r) => !r.parseOk).length,
    invalidChoice: loops.filter((r) => !r.valid).length,
    decideMs: { p50: pct(dec, 50), p95: pct(dec, 95), max: maxOf(dec), total: sum(dec) },
    promptTokens: { p50: pct(ptok, 50), p95: pct(ptok, 95), max: maxOf(ptok) },
    promptChars: { p50: pct(pch, 50), max: maxOf(pch) },
    jevChoiceConfidence: { p50: pct(jevLoops.map((r) => r.jev.choice && r.jev.choice.confidence).filter((x) => x != null), 50) },
    memItems: { p50: pct(loops.map((r) => r.memSelection && Object.values(r.memSelection).reduce((s, x) => s + x, 0)).filter((x) => x != null), 50) },
    forgotten: sum(loops.map((r) => r.forgotten)),
    explore: exploreStats(loops, start),
    build: buildStats(loops),
    // 状態が変わらなかった行動・困りごと (失敗の繰り返し / 変わらない繰り返し)・Jev の選択を重みで選び直した回数
    noChange: {
      unchanged: loops.filter((r) => r.stateChanged === false).length,
      unchangedOk: loops.filter((r) => r.stateChanged === false && r.result.ok).length,
      troubledLoops: loops.filter((r) => (r.troubles || []).length).length,
      troubledFail: loops.filter((r) => (r.troubleKinds || []).includes('fail')).length,
      troubledNoChange: loops.filter((r) => (r.troubleKinds || []).includes('noChange')).length,
      reweighted: loops.filter((r) => r.jev && r.jev.reweight).length,
      reweightChanged: loops.filter((r) => r.jev && r.jev.reweight && r.jev.reweight.changed).length,
      maxSameInRow: maxRun(loops),
    },
    end: last ? { inventory: last.inventory, foodCount: last.foodCount ?? null, hut: last.hutTrue ? last.hutTrue.ratio : null, social: last.social ? last.social.words : null, timeOfDay: last.timeOfDay ?? null } : null,
  };
}

// 2B の使用量を記録から数え直す (run.json が無いとき)
function twoBFromRows(all) {
  const out = { calls: 0, promptChars: 0, promptTokens: 0, byKind: {} };
  const add = (kind, chars, tok) => {
    out.calls += 1; out.promptChars += chars || 0; out.promptTokens += tok || 0;
    const k = (out.byKind[kind] = out.byKind[kind] || { calls: 0, promptChars: 0, promptTokens: 0 });
    k.calls += 1; k.promptChars += chars || 0; k.promptTokens += tok || 0;
  };
  for (const r of all) {
    if (isStep(r) && !r.jev && r.promptChars) add('act', r.promptChars, r.promptTokens);
    if (isStep(r) && r.talk) add('talk', r.talk.promptChars, null);
    if (r.event === 'talk') add('talk', r.promptChars, r.promptTokens);
    if (r.event === 'answer' && r.twoB) add('answer', r.twoB.promptChars, r.twoB.promptTokens);
  }
  out.avgPromptChars = out.calls ? Math.round(out.promptChars / out.calls) : 0;
  return out;
}

function jevFromRows(all) {
  const loops = all.filter((r) => isStep(r) && r.jev);
  const tok = sum(loops.map((r) => r.jev.inputTokens));
  const calls = sum(loops.map((r) => r.jev.calls || 1));
  return {
    calls, decisions: loops.length, callsPerDecision: loops.length ? Number((calls / loops.length).toFixed(3)) : null, inputTokens: tok, inputChars: sum(loops.map((r) => r.jev.inputChars)),
    estimatedCalls: loops.filter((r) => r.jev.tokensEstimated).length, rateLimited: sum(loops.map((r) => r.jev.rateLimited)),
    retries: sum(loops.map((r) => r.jev.retries)), avgMs: loops.length ? Math.round(sum(loops.map((r) => r.jev.ms)) / loops.length) : 0,
    costUsd: Number(((tok / 1e6) * JEV_USD_PER_MTOK).toFixed(6)),
  };
}

function hhmmss(ts) { return new Date(ts).toISOString().slice(11, 19); }

function conversation(all, n) {
  const lines = [];
  for (const r of all) {
    const who = r._name;
    if (isStep(r) && r.say) lines.push({ ts: r.ts, text: `${who}: ${r.say}` });
    if (r.event === 'talk' && r.say) lines.push({ ts: r.ts, text: `${who}: ${r.say}  (talk ${r.talkP != null ? r.talkP.toFixed(2) : '-'})` });
    if (r.event === 'ask') lines.push({ ts: r.ts, text: `${who} → ${r.to} [聞く] ${r.question}` });
    if (r.event === 'answer') lines.push({ ts: r.ts, text: `${who} → ${r.to} [答える${r.known ? '' : '・知らない'}] ${r.answer}` });
    if (r.event === 'ask_timeout') lines.push({ ts: r.ts, text: `${who} … ${r.to} から返事なし` });
    if (r.event === 'answer_use') lines.push({ ts: r.ts, text: `${who} [教わったことを${r.used ? `使った(${r.how})` : '使わなかった'}] ${r.from} から: ${r.key}` });
  }
  lines.sort((a, b) => (a.ts < b.ts ? -1 : 1));
  return lines.slice(0, n).map((l) => `[${hhmmss(l.ts)}] ${l.text}`);
}

// 生き延びる設定の集計: 死んだ回数・死因・各日の終わりに (それまで一度も死なずに) 生きていた人数・3日生き延びた人数
function survivalStats(agents, all, days = 3) {
  const deaths = all.filter((r) => r.event === 'death');
  const causes = {};
  for (const d of deaths) causes[d.cause || 'unknown'] = (causes[d.cause || 'unknown'] || 0) + 1;
  const maxDay = (name) => maxOf(all.filter((r) => r._name === name && isStep(r) && r.day != null).map((r) => r.day));
  const firstDeathDay = (name) => { const ds = deaths.filter((d) => d._name === name && d.day != null).map((d) => d.day); return ds.length ? Math.min(...ds) : null; };
  const aliveAtDayEnd = [];
  for (let d = 0; d < days; d++) {
    const reached = agents.filter((a) => (maxDay(a.name) ?? -1) > d);
    aliveAtDayEnd.push({ day: d + 1, reached: reached.length, alive: reached.filter((a) => { const f = firstDeathDay(a.name); return f == null || f > d; }).length });
  }
  const survived = agents.filter((a) => (maxDay(a.name) ?? -1) >= days && !deaths.some((d) => d._name === a.name)).map((a) => a.name);
  return {
    deaths: deaths.length, causes, perAgent: Object.fromEntries(agents.map((a) => [a.name, deaths.filter((d) => d._name === a.name).length])),
    deathList: deaths.map((d) => ({ who: d._name, day: d.day, timeOfDay: d.timeOfDay, cause: d.cause, message: d.message })),
    aliveAtDayEnd, survivedNoDeath: survived,
  };
}

// 自分で決めた目標の移り変わり (抜粋)
function goalTimeline(all, n = 12) {
  return all.filter((r) => r.event === 'self_goal').sort((a, b) => (a.ts < b.ts ? -1 : 1))
    .map((r) => `[${hhmmss(r.ts)}] ${r._name} #${r.loop} (${r.reason})${r.ok ? ` ${r.goal} / ${(r.steps || []).join(' → ')}` : ' (書けなかった)'}`)
    .slice(0, n);
}

// ゴールと手順 (help.goalPlan) の記録: event 'goal_plan' の kind ごとに数え、人ごとの進みと移り変わり (抜粋) を出す
function goalPlanStats(all, n = 20) {
  const ev = all.filter((r) => r.event === 'goal_plan').sort((a, b) => (a.ts < b.ts ? -1 : 1));
  const cnt = (rows, k) => rows.filter((r) => r.kind === k).length;
  const stats = (rows) => ({
    goals: rows.filter((r) => r.kind === 'goal' && r.ok).length, goalFailed: rows.filter((r) => r.kind === 'goal' && !r.ok).length,
    done: cnt(rows, 'goal_done'), abandoned: cnt(rows, 'abandon'), stepsAdvanced: cnt(rows, 'advance'),
    plans: rows.filter((r) => r.kind === 'steps' && r.ok).length, rebuilds: cnt(rows, 'rebuild'),
    checks: cnt(rows, 'check'), checkAsked: sum(rows.filter((r) => r.kind === 'check').map((r) => (r.asked || []).length)),
    checkFailed: sum(rows.filter((r) => r.kind === 'check').map((r) => (r.failed || []).length)), rewrites: rows.filter((r) => r.kind === 'rewrite' && r.ok).length,
    stepTook: { p50: pct(rows.filter((r) => r.kind === 'advance').map((r) => r.took), 50) },
  });
  const names = [...new Set(ev.map((r) => r._name))];
  const timeline = ev.filter((r) => ['goal', 'plan', 'rewrite', 'advance', 'rebuild', 'goal_done', 'abandon'].includes(r.kind)).map((r) => {
    const h = `[${hhmmss(r.ts)}] ${r._name} t${r.tick} ${r.kind}`;
    if (r.kind === 'goal') return `${h} ${r.ok ? r.goal : '(書けなかった)'}`;
    if (r.kind === 'plan') return `${h} ${(r.steps || []).map((s, i) => `(${i + 1})${s.text}${s.p != null ? `[${Number(s.p).toFixed(2)}]` : ''}`).join(' ')}`;
    if (r.kind === 'rewrite') return `${h} (${r.index + 1}) ${r.before} → ${r.ok ? r.after.join(' / ') : '(書けなかった)'}`;
    if (r.kind === 'advance') return `${h} (${r.index + 1}) ${r.step} 済み p=${Number(r.p).toFixed(2)} ${r.took}判断`;
    if (r.kind === 'rebuild') return `${h} ${r.why} → ${r.ok ? (r.steps || []).slice(r.from).join(' / ') : '(書けなかった)'}`;
    return `${h} ${r.goal} (手順 ${r.stepsDone}/${r.stepsTotal}、作り直し ${r.rebuilds})`;
  });
  return { ...stats(ev), perAgent: Object.fromEntries(names.map((nm) => [nm, stats(ev.filter((r) => r._name === nm))])), timeline: timeline.slice(0, n) };
}

// 振り返りと方針 (cfg.reflect): event 'reflect' の一覧
function reflectStats(all, n = 20) {
  const ev = all.filter((r) => r.event === 'reflect').sort((a, b) => (a.ts < b.ts ? -1 : 1));
  return {
    count: ev.length, ok: ev.filter((r) => r.ok).length, byReason: countBy(ev, (r) => r.reason),
    list: ev.slice(0, n).map((r) => `[${hhmmss(r.ts)}] ${r._name} t${r.tick} (${r.reason}) ${r.ok ? `方針: ${r.policy} / 何のため: ${r.why || '-'}` : '(書けなかった)'} ← ${(r.facts || []).slice(0, 4).join(' / ')}`),
  };
}

// lure・enclose の結果 (付いてきた・着いた頭数、置いた数・囲えたか)
function penActStats(loops) {
  const lu = loops.filter((r) => r.action === 'lure');
  const en = loops.filter((r) => r.action === 'enclose');
  return {
    lure: { n: lu.length, ok: lu.filter((r) => r.result.ok).length, followed: sum(lu.map((r) => (r.result.lure ? r.result.lure.followed : 0))), arrived: sum(lu.map((r) => (r.result.lure ? r.result.lure.arrived : 0))) },
    enclose: { n: en.length, ok: en.filter((r) => r.result.ok).length, placed: sum(en.map((r) => (r.result.enclose ? r.result.enclose.placed : 0))), enclosed: en.filter((r) => r.result.enclose && r.result.enclose.enclosed).length },
  };
}

// ゴール → 道筋 (help.goalPath) の記録: event 'goal_path'。ゴールの一覧・達成・選び直し (理由ごと)・道筋の進み
function goalPathStats(all, n = 30) {
  const ev = all.filter((r) => r.event === 'goal_path').sort((a, b) => (a.ts < b.ts ? -1 : 1));
  const goalOf = (r) => (r.kind === 'goal' ? `${r.target}${r.count ? ` ${r.count}` : ''}` : r.goal || r.target);
  const stats = (rows) => {
    const sel = rows.filter((r) => r.kind === 'reselect');
    return {
      goals: rows.filter((r) => r.kind === 'goal' && r.ok).length, goalFailed: rows.filter((r) => r.kind === 'goal' && !r.ok).length,
      byKind: countBy(rows.filter((r) => r.kind === 'goal' && r.ok), (r) => r.goalKind || '-'),
      unplannable: rows.filter((r) => r.kind === 'unplannable').length,
      reached: rows.filter((r) => r.kind === 'reached').length,
      done: rows.filter((r) => r.kind === 'goal_done').length,
      reselect: countBy(sel, (r) => r.result),
      pathChanges: rows.filter((r) => r.kind === 'path').length,
      reachTook: { p50: pct(rows.filter((r) => r.kind === 'reached').map((r) => r.took), 50) },
      // いちばんつらい欲求 (worst) とゴールの need が合っていた割合 (worst と need の両方があるゴールのうち)
      worstMatch: (() => {
        const g = rows.filter((r) => r.kind === 'goal' && r.ok && r.worst && r.need);
        const m = g.filter((r) => r.worst === r.need).length;
        return { matched: m, judged: g.length, rate: g.length ? Number((m / g.length).toFixed(3)) : null, pairs: countBy(g, (r) => `${r.worst}→${r.need}`) };
      })(),
    };
  };
  const names = [...new Set(ev.map((r) => r._name))];
  const timeline = ev.filter((r) => ['goal', 'unplannable', 'reached', 'goal_done', 'reselect'].includes(r.kind)).map((r) => {
    const h = `[${hhmmss(r.ts)}] ${r._name} t${r.tick} ${r.kind}`;
    if (r.kind === 'goal') {
      if (!r.ok) return `${h} (読めなかった)`;
      const p = r.path && r.path.steps ? ` / 道筋 ${r.path.steps.map((s) => `${s.item} ${s.count}`).join('、') || '揃っている'}` : '';
      return `${h} ${r.goalKind}:${goalOf(r)}${r.give ? ` give=${r.give}` : ''} (何のため: ${r.why || '-'} / need: ${r.need || '-'} / 理由: ${r.reason})${p}`;
    }
    if (r.kind === 'unplannable') return `${h} ${goalOf(r)} (たどれない: ${r.missing || '-'})`;
    if (r.kind === 'reached') return `${h} ${r.goal} (${r.took}判断)`;
    return `${h} ${r.target}${r.count ? ` ${r.count}` : ''} → ${r.result}${r.reason ? ` (${r.reason})` : ''}`;
  });
  // 道筋の進み: ゴールごとに、次の物が移っていった順
  const progress = [];
  let cur = null;
  for (const r of ev) {
    if (r.kind === 'goal' && r.ok) { cur = { who: r._name, goal: goalOf(r), nexts: [] }; progress.push(cur); }
    else if (r.kind === 'path' && cur && cur.who === r._name && r.next && cur.nexts[cur.nexts.length - 1] !== r.next) cur.nexts.push(r.next);
  }
  return { ...stats(ev), perAgent: Object.fromEntries(names.map((nm) => [nm, stats(ev.filter((r) => r._name === nm))])), timeline: timeline.slice(0, n),
    progress: progress.slice(0, n).map((p) => `${p.who} ${p.goal}: ${p.nexts.join(' → ') || '-'}`) };
}

function countBy(rows, f) { const m = {}; for (const r of rows) { const k = f(r); m[k] = (m[k] || 0) + 1; } return m; }

// 拠点に何が集まったか (event 'base_site'): 人ごとに最後に見た様子と、それまでで一番多かった数
function baseSiteStats(all) {
  const out = {};
  for (const r of all.filter((x) => x.event === 'base_site').sort((a, b) => (a.ts < b.ts ? -1 : 1))) {
    const o = out[r._name] || (out[r._name] = { seen: 0, last: null, max: {} });
    o.seen += 1;
    o.last = { loop: r.loop, center: r.center, isBase: r.isBase, counts: r.counts, light: r.light, enclosed: r.enclosed, text: r.text };
    for (const [k, v] of Object.entries(r.counts || {})) o.max[k] = Math.max(o.max[k] || 0, v);
  }
  return out;
}

// 協力に関わる出来事: 聞く・答える・話す・同じ所 (近さ near 以内) に同じ時間帯 (bucketSec) に居た組
function cooperationStats(all, { near = 8, bucketSec = 10 } = {}) {
  const loops = all.filter((r) => isStep(r) && r.pos && r.ts);
  const byBucket = new Map();
  for (const r of loops) {
    const b = Math.floor(new Date(r.ts).getTime() / (bucketSec * 1000));
    if (!byBucket.has(b)) byBucket.set(b, new Map());
    byBucket.get(b).set(r._name, r.pos);
  }
  const pairs = {};
  let together = 0;
  for (const m of byBucket.values()) {
    const ent = [...m.entries()];
    for (let i = 0; i < ent.length; i++) {
      for (let j = i + 1; j < ent.length; j++) {
        const [a, pa] = ent[i]; const [b, pb] = ent[j];
        if (Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z) <= near) { const k = [a, b].sort().join('-'); pairs[k] = (pairs[k] || 0) + 1; together += 1; }
      }
    }
  }
  return {
    asked: all.filter((r) => r.event === 'ask').length, answered: all.filter((r) => r.event === 'answer').length,
    talked: all.filter((r) => r.event === 'talk' && r.say).length,
    togetherBuckets: together, togetherPairs: pairs, bucketSec, near,
    setBase: all.filter((r) => r.event === 'set_base').map((r) => ({ who: r._name, loop: r.loop, base: r.base })),
  };
}

// 2人組の距離の推移: bucketSec ごとに、その時間に記録のある人の位置 (最後の行) で組ごとの距離を出し、
// near m 以内の組の数と距離の中央値を並べる。組ごとの中央値と near 以内だった割合も
function pairDistanceStats(all, { near = 16, bucketSec = 60 } = {}) {
  const loops = all.filter((r) => isStep(r) && r.pos && r.ts);
  if (!loops.length) return { near, bucketSec, timeline: [], perPair: {} };
  const t0 = Math.min(...loops.map((r) => new Date(r.ts).getTime()));
  const byBucket = new Map();
  for (const r of loops) {
    const b = Math.floor((new Date(r.ts).getTime() - t0) / (bucketSec * 1000));
    if (!byBucket.has(b)) byBucket.set(b, new Map());
    byBucket.get(b).set(r._name, r.pos);
  }
  const perPairD = {};
  const timeline = [];
  for (const b of [...byBucket.keys()].sort((x, y) => x - y)) {
    const ent = [...byBucket.get(b).entries()];
    const ds = [];
    for (let i = 0; i < ent.length; i++) {
      for (let j = i + 1; j < ent.length; j++) {
        const [a, pa] = ent[i]; const [c, pc] = ent[j];
        const d = Math.hypot(pa.x - pc.x, pa.y - pc.y, pa.z - pc.z);
        ds.push(d);
        const k = [a, c].sort().join('-');
        (perPairD[k] = perPairD[k] || []).push(d);
      }
    }
    timeline.push({ min: Math.round((b * bucketSec) / 6) / 10, people: ent.length, pairs: ds.length, withinNear: ds.filter((d) => d <= near).length, median: ds.length ? Math.round(pct(ds, 50)) : null });
  }
  const perPair = Object.fromEntries(Object.entries(perPairD).sort().map(([k, ds]) => [k, { median: Math.round(pct(ds, 50)), withinNearShare: Number((ds.filter((d) => d <= near).length / ds.length).toFixed(2)), n: ds.length }]));
  return { near, bucketSec, timeline, perPair };
}

// 欲求とストレス (needs.js): 人ごとに、分ごとの平均・最大と、寝た回数・食べた回数。古い記録 (social.needs に stress が無い) は null
const NEED_KEYS = ['hunger', 'sleep', 'safety', 'connection', 'recognition', 'curiosity', 'greed', 'care', 'stress'];
function needsStats(all) {
  const loops = all.filter((r) => isStep(r) && r.ts && r.social && r.social.needs && r.social.needs.stress != null);
  if (!loops.length) return null;
  const t0 = Math.min(...all.filter((r) => r.ts).map((r) => new Date(r.ts).getTime()));
  const r2 = (x) => Math.round(x * 100) / 100;
  const out = {};
  for (const name of [...new Set(loops.map((r) => r._name))]) {
    const rows = loops.filter((r) => r._name === name);
    const byMin = new Map();
    for (const r of rows) {
      const m = Math.floor((new Date(r.ts).getTime() - t0) / 60000);
      if (!byMin.has(m)) byMin.set(m, []);
      byMin.get(m).push(r.social.needs);
    }
    const perMinute = [...byMin.keys()].sort((a, b) => a - b).map((m) => {
      const xs = byMin.get(m);
      const o = { min: m, n: xs.length };
      for (const k of NEED_KEYS) {
        const v = xs.map((x) => x[k]).filter((x) => Number.isFinite(x));
        if (v.length) o[k] = { avg: r2(sum(v) / v.length), max: r2(Math.max(...v)) };
      }
      return o;
    });
    const all1 = {};
    for (const k of NEED_KEYS) {
      const v = rows.map((r) => r.social.needs[k]).filter((x) => Number.isFinite(x));
      if (v.length) all1[k] = { avg: r2(sum(v) / v.length), max: r2(Math.max(...v)) };
    }
    const steps = all.filter((r) => isStep(r) && r._name === name);
    out[name] = {
      overall: all1, perMinute,
      slept: steps.filter((r) => r.action === 'sleep' && r.result.ok && (!r.result.sleep || r.result.sleep.slept)).length,
      nightsSkipped: steps.filter((r) => r.action === 'sleep' && r.result.ok && r.result.sleep && r.result.sleep.nightSkipped).length,
      ate: steps.filter((r) => r.action === 'eat' && r.result.ok).length,
      received: all.filter((r) => r.event === 'received' && r._name === name).length,
      worst: rows.reduce((m, r) => { const w = r.social.worst; if (w) m[w] = (m[w] || 0) + 1; return m; }, {}),
    };
  }
  return out;
}

// ゴールの why / need (help.goalPlan の goal event)
function goalWhyList(all, n = 20) {
  return all.filter((r) => r.event === 'goal_plan' && r.kind === 'goal' && r.ok).sort((a, b) => (a.ts < b.ts ? -1 : 1))
    .map((r) => `[${hhmmss(r.ts)}] ${r._name} ${r.goal} (何のため: ${r.why || '-'} / need: ${r.need || '-'}${r.worst ? ` / いちばんつらい: ${r.worst}` : ''})`).slice(0, n);
}

// go_to で人の所へ行った回数 (arg が記録にいる人の名前)
function goToPersonStats(all, names) {
  const set = new Set(names);
  const rows = all.filter((r) => isStep(r) && r.action === 'go_to' && set.has(r.arg));
  const by = {};
  for (const r of rows) { const k = `${r._name}→${r.arg}`; by[k] = (by[k] || 0) + 1; }
  return { n: rows.length, ok: rows.filter((r) => r.result.ok).length, byPair: by };
}

function main() {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith('--'));
  if (!target) { console.error('usage: node tools/summarize_run.js <runs/<時刻>/ | run.jsonl> [--excerpt N] [--text]'); process.exit(2); }
  const ei = args.indexOf('--excerpt');
  const nEx = ei >= 0 ? Number(args[ei + 1]) : 40;
  const isDir = fs.statSync(target).isDirectory();
  const files = isDir ? fs.readdirSync(target).filter((f) => f.endsWith('.jsonl') && !/^monitor(-\d+)?\.jsonl$/.test(f)).map((f) => path.join(target, f)) : [target];
  const runJson = isDir && fs.existsSync(path.join(target, 'run.json')) ? JSON.parse(fs.readFileSync(path.join(target, 'run.json'), 'utf8')) : null;

  const all = [];
  const agents = [];
  const rowsByName = {};
  for (const f of files) {
    const rows = readJsonl(f);
    const s = summarizeAgent(f, rows);
    agents.push(s);
    rowsByName[s.name] = rows;
    for (const r of rows) all.push({ ...r, _name: s.name });
  }
  const loops = all.filter(isStep);
  const dec = loops.map((r) => r.decideMs).filter((x) => x != null);
  const asks = all.filter((r) => r.event === 'ask');
  const answers = all.filter((r) => r.event === 'answer');
  const uses = all.filter((r) => r.event === 'answer_use');
  const jev = runJson ? runJson.usage.jev : jevFromRows(all);
  const twoB = runJson ? runJson.usage.twoB : twoBFromRows(all);
  const hutEnd = maxOf(agents.map((a) => (a.end && a.end.hut != null ? a.end.hut : -1)).filter((x) => x >= 0));
  const foodEnd = sum(agents.map((a) => (a.end ? a.end.foodCount : 0)));
  const helpUsed = (agents.find((a) => a.help) || {}).help || null;

  const out = {
    target,
    agents: agents.length,
    help: helpUsed,
    decisions: { count: loops.length, perAgent: agents.length ? Math.round(loops.length / agents.length) : 0, decideMs: { p50: pct(dec, 50), p95: pct(dec, 95), max: maxOf(dec) }, decideMinutesTotal: Math.round(sum(dec) / 600) / 100, wallMinutes: maxOf(agents.map((a) => a.minutes)) },
    goal: {
      reached: agents.filter((a) => a.goalAtLoop).length,
      beforeNight: agents.filter((a) => a.goalBeforeNight).length,
      perAgent: Object.fromEntries(agents.map((a) => [a.name, a.goalAtLoop ? { loop: a.goalAtLoop, min: a.goalAtMin, timeOfDay: a.goalTimeOfDay } : null])),
      hutRatioEnd: hutEnd, foodTotalEnd: foodEnd,
    },
    ask: {
      asked: asks.length,
      replied: all.filter((r) => r.event === 'ask_reply').length,
      timeouts: all.filter((r) => r.event === 'ask_timeout').length,
      answered: answers.length,
      answeredKnown: answers.filter((r) => r.known).length,
      used: uses.filter((r) => r.used).length,
      notUsed: uses.filter((r) => !r.used).length,
      pairs: asks.map((r) => `${r._name}→${r.to}: ${r.key}`),
    },
    twoB: { calls: twoB.calls, byKind: twoB.byKind, avgPromptChars: twoB.avgPromptChars ?? (twoB.calls ? Math.round(twoB.promptChars / twoB.calls) : 0), promptTokens: twoB.promptTokens },
    jev: {
      calls: jev.calls, inputTokens: jev.inputTokens,
      // 1判断あたり (2段にしたので、呼び出し数 ≠ 判断の数)。古い記録は decisions が無いので calls で割る
      decisions: jev.decisions || jev.calls, callsPerDecision: jev.callsPerDecision ?? (jev.decisions ? Number((jev.decisionCalls / jev.decisions).toFixed(3)) : 1),
      inputTokensPerDecision: jev.inputTokensPerDecision ?? ((jev.decisions || jev.calls) ? Math.round(jev.inputTokens / (jev.decisions || jev.calls)) : 0),
      inputTokensPerCall: jev.calls ? Math.round(jev.inputTokens / jev.calls) : 0, byStage: jev.byStage || null,
      estimatedCalls: jev.estimatedCalls, costUsd: jev.costUsd ?? Number(((jev.inputTokens / 1e6) * JEV_USD_PER_MTOK).toFixed(6)),
      avgMs: jev.avgMs, rateLimited: jev.rateLimited, retries: jev.retries, errors: jev.errors ?? null, exceeded: jev.exceeded ?? null,
    },
    survival: survivalStats(agents, all),
    selfGoals: { count: all.filter((r) => r.event === 'self_goal').length, byReason: all.filter((r) => r.event === 'self_goal').reduce((m, r) => { m[r.reason] = (m[r.reason] || 0) + 1; return m; }, {}), timeline: goalTimeline(all) },
    goalPlan: all.some((r) => r.event === 'goal_plan') ? goalPlanStats(all) : null,
    goalPath: all.some((r) => r.event === 'goal_path') ? goalPathStats(all) : null,
    reflect: all.some((r) => r.event === 'reflect') ? reflectStats(all) : null,
    penActs: penActStats(loops),
    baseSite: all.some((r) => r.event === 'base_site') ? baseSiteStats(all) : null,
    needs: needsStats(all),
    goalWhy: goalWhyList(all),
    others: { appended: loops.filter((r) => r.result && r.result.others && r.result.others.length).length,
      items: sum(loops.map((r) => ((r.result && r.result.others) || []).length)) },
    cooperation: cooperationStats(all),
    pairDistance: pairDistanceStats(all),
    goToPerson: goToPersonStats(all, agents.map((a) => a.name)),
    placed: loops.filter((r) => r.action === 'place' && r.result && r.result.ok).reduce((m, r) => { m[r.arg] = (m[r.arg] || 0) + 1; return m; }, {}),
    perAgent: agents,
    conversation: conversation(all, nEx),
  };
  // 人数が多いとき向け: 集まり・関係の行列・判断の間隔・人ごとの短い要約・負荷 (monitor)
  out.decisions.intervalSec = scale.intervalStats(rowsByName);
  out.clusters = scale.clusterStats(all);
  out.relations = scale.relationMatrix(rowsByName);
  out.brief = scale.briefPerAgent(agents, { clusters: out.clusters, deathsPerAgent: out.survival.perAgent, intervals: out.decisions.intervalSec });
  out.load = { monitor: isDir ? scale.monitorStats(target) : null, twoBLatency: runJson ? runJson.twoBLatency || null : null,
    disconnects: runJson ? (typeof runJson.disconnects === 'number' ? runJson.disconnects : runJson.disconnects ? runJson.disconnects.n : null) : null, procs: runJson ? runJson.procs || 1 : null };
  console.log(JSON.stringify(out, null, 2));
  if (args.includes('--text')) {
    console.log('\n--- 週次報告用 ---');
    console.log(`人数 ${out.agents} / 判断 ${out.decisions.count} 回 (1人 ${out.decisions.perAgent} 回、判断の時間 p50 ${out.decisions.decideMs.p50}ms・p95 ${out.decisions.decideMs.p95}ms、実行 ${out.decisions.wallMinutes} 分)`);
    console.log(`目標の達成 ${out.goal.reached}/${out.agents} 人 (夜までに ${out.goal.beforeNight})、小屋 ${hutEnd == null ? '不明' : Math.round(hutEnd * 100) + '%'}、食べ物 合計 ${foodEnd} 個`);
    console.log(`周りに聞いた ${out.ask.asked} 回 (返事 ${out.ask.replied}・返事なし ${out.ask.timeouts})・答えた ${out.ask.answered} (知っていた ${out.ask.answeredKnown})・教わったことを使った ${out.ask.used} / 使わなかった ${out.ask.notUsed}`);
    const nc = (k) => sum(agents.map((a) => (a.noChange ? a.noChange[k] : 0)));
    const acts = (n) => sum(agents.map((a) => (a.actions[n] ? a.actions[n].n : 0)));
    const actsOk = (n) => sum(agents.map((a) => (a.actions[n] ? a.actions[n].ok : 0)));
    console.log(`状態が変わらなかった行動 ${nc('unchanged')} 回 (うち成功扱い ${nc('unchangedOk')})、困っていた判断 ${nc('troubledLoops')} 回 (失敗の繰り返し ${nc('troubledFail')}・変わらない繰り返し ${nc('troubledNoChange')})、重みで選び直し ${nc('reweightChanged')}/${nc('reweighted')} 回、同じ行動の連続 最長 ${maxOf(agents.map((a) => a.noChange.maxSameInRow))} 回`);
    const allCells = new Set(agents.flatMap((a) => a.explore.cellKeys));
    console.log(`訪れたマス ${allCells.size} 個 (${agents[0] ? agents[0].explore.cell : 16} 四方、1人あたり ${agents.map((a) => a.explore.visitedCells).join('/')})、explore ${sum(agents.map((a) => a.explore.n))} 回 (新しいマスに着いた ${sum(agents.map((a) => a.explore.newCell))}、種類 ${JSON.stringify(agents.reduce((m, a) => { for (const [k, v] of Object.entries(a.explore.byKind)) m[k] = (m[k] || 0) + v; return m; }, {}))})`);
    const bs = (k, f) => sum(agents.map((a) => a.build[k][f]));
    console.log(`build で置いた物: 原木 ${bs('log', 'placed')} 個 (${bs('log', 'n')} 回)・板材 ${bs('planks', 'placed')} 個 (${bs('planks', 'n')} 回)・そのほか ${bs('other', 'placed')} 個 (${bs('other', 'n')} 回)`);
    console.log(`pillar ${acts('pillar')} 回 (成功 ${actsOk('pillar')})、pick_up ${acts('pick_up')} 回 (成功 ${actsOk('pick_up')})、go_to ${acts('go_to')} 回 (成功 ${actsOk('go_to')})`);
    const sv = out.survival;
    if (sv.deaths || all.some((r) => r.event === 'self_goal' || r.event === 'goal_plan' || r.event === 'goal_path')) {
      console.log(`死んだ ${sv.deaths} 回 (${Object.entries(sv.causes).map(([k, v]) => `${k} ${v}`).join('・') || 'なし'})、各日の終わりに一度も死なずに生きていた人数 ${sv.aliveAtDayEnd.map((d) => `${d.day}日目 ${d.alive}/${d.reached}`).join('・')}、3日生き延びた (一度も死ななかった) ${sv.survivedNoDeath.length} 人`);
      console.log(`攻撃 ${acts('attack')} 回 (成功 ${actsOk('attack')})・逃げる ${acts('flee')}・焼く ${acts('smelt')} (成功 ${actsOk('smelt')})・寝る ${acts('sleep')} (成功 ${actsOk('sleep')})・置いた ${JSON.stringify(out.placed)}・拠点を決めた ${out.cooperation.setBase.length} 回`);
      console.log(`自分で決めた目標 ${out.selfGoals.count} 回 (${JSON.stringify(out.selfGoals.byReason)})`);
      for (const l of out.selfGoals.timeline.slice(0, 6)) console.log(`  ${l}`);
      if (out.goalPlan) {
        const g = out.goalPlan;
        console.log(`ゴール ${g.goals} 個 (達成 ${g.done}・捨てた ${g.abandoned})、手順を進めた ${g.stepsAdvanced} 回 (1手順 p50 ${g.stepTook.p50} 判断)、作り直し ${g.rebuilds} 回、確認 ${g.checks} 回 (${g.checkAsked} 手順のうち落ちた ${g.checkFailed}、書き直し ${g.rewrites})`);
        console.log(`  人ごと: ${Object.entries(g.perAgent).map(([k, v]) => `${k} ゴール${v.goals}・進んだ${v.stepsAdvanced}・作り直し${v.rebuilds}`).join(' / ')}`);
        for (const l of g.timeline.slice(0, 8)) console.log(`  ${l}`);
      }
      if (out.goalPath) {
        const g = out.goalPath;
        console.log(`ゴール ${g.goals} 個 (${Object.entries(g.byKind).map(([k, v]) => `${k} ${v}`).join('・')}、読めなかった ${g.goalFailed}、たどれなかった ${g.unplannable})、着いた/手に入れた ${g.reached} (p50 ${g.reachTook.p50} 判断)、達成 ${g.done}、選び直し ${JSON.stringify(g.reselect)}、道筋の次の物が変わった ${g.pathChanges} 回`);
        console.log(`  人ごと: ${Object.entries(g.perAgent).map(([k, v]) => `${k} ゴール${v.goals}・達成${v.done}・選び直し${Object.values(v.reselect).reduce((a, b) => a + b, 0)}`).join(' / ')}`);
        for (const l of g.timeline.slice(0, 10)) console.log(`  ${l}`);
        for (const l of g.progress.slice(0, 8)) console.log(`  道筋の進み ${l}`);
        const wm = g.worstMatch;
        console.log(`  いちばんつらい欲求とゴールの need が合っていた ${wm.matched}/${wm.judged}${wm.rate != null ? ` (${Math.round(wm.rate * 100)}%)` : ''} ${JSON.stringify(wm.pairs)}`);
      }
      if (out.reflect) {
        console.log(`振り返り ${out.reflect.count} 回 (方針を書けた ${out.reflect.ok}、${JSON.stringify(out.reflect.byReason)})`);
        for (const l of out.reflect.list.slice(0, 10)) console.log(`  ${l}`);
      }
      const pa = out.penActs;
      if (pa.lure.n || pa.enclose.n) console.log(`lure ${pa.lure.n} 回 (着いた ${pa.lure.ok}、付いてきた ${pa.lure.followed} 頭・着いた ${pa.lure.arrived} 頭)・enclose ${pa.enclose.n} 回 (置いた ${pa.enclose.placed} 個、囲えた ${pa.enclose.enclosed} 回)`);
      if (out.baseSite) for (const [nm, b] of Object.entries(out.baseSite)) console.log(`  拠点 ${nm}: ${b.last ? b.last.text : '-'} (一番多かった数 ${JSON.stringify(b.max)})`);
      if (out.needs) {
        for (const [nm, v] of Object.entries(out.needs)) {
          const o = v.overall;
          const f = (k) => (o[k] ? `${o[k].avg}/${o[k].max}` : '-');
          console.log(`  欲求 ${nm} (平均/最大): 空腹 ${f('hunger')}・眠気 ${f('sleep')}・不安 ${f('safety')}・つながり ${f('connection')}・認められたい ${f('recognition')}・ストレス ${f('stress')}、寝た ${v.slept} 回 (夜を越した ${v.nightsSkipped})・食べた ${v.ate} 回・もらった ${v.received} 回`);
        }
        for (const l of out.goalWhy.slice(0, 8)) console.log(`  ${l}`);
      }
      console.log(`ほかの人が拾った・壊したことを結果に足した ${out.others.appended} 回`);
      console.log(`協力に関わる出来事: 聞いた ${out.cooperation.asked}・答えた ${out.cooperation.answered}・話した ${out.cooperation.talked}・同じ所 (${out.cooperation.near}m 以内) に居た ${out.cooperation.togetherBuckets} 回 (${out.cooperation.bucketSec}秒ごと、組 ${JSON.stringify(out.cooperation.togetherPairs)})`);
    }
    const sv2 = out.survival;
    if (!(sv2.deaths || all.some((r) => r.event === 'self_goal' || r.event === 'goal_plan' || r.event === 'goal_path'))) console.log(`死んだ 0 回`);
    else console.log(`死んだ回数 (人ごと) ${Object.entries(sv2.perAgent).map(([k, v]) => `${k} ${v}`).join('・')}`);
    const pdl = out.pairDistance.timeline;
    console.log(`2人組の距離 (${out.pairDistance.bucketSec}秒ごと、${out.pairDistance.near}m 以内の組の数 / 中央値): ${pdl.filter((_, i) => i % Math.max(1, Math.ceil(pdl.length / 12)) === 0).map((x) => `${x.min}分 ${x.withinNear}/${x.pairs}組 ${x.median}m`).join('、')}`);
    const cs = out.clusters;
    if (cs.summary) {
      const tl = cs.timeline.filter((_, i) => i % Math.max(1, Math.ceil(cs.timeline.length / 12)) === 0);
      console.log(`集まり (${cs.near}m 以内でつながった2人以上、${cs.bucketSec}秒ごと): 平均 ${cs.summary.groupsAvg} 個・最大 ${cs.summary.groupsMax} 個、いちばん大きい集まり 中央値 ${cs.summary.largestP50} 人・最大 ${cs.summary.largestMax} 人、1人で居た割合 平均 ${Math.round(cs.summary.aloneShareAvg * 100)}%`);
      console.log(`  推移: ${tl.map((x) => `${x.min}分 ${x.groups}個[${x.sizes.join(',')}]`).join('、')}`);
    }
    const iv = out.decisions.intervalSec;
    console.log(`判断の間隔 p50 ${iv.p50}s・p95 ${iv.p95}s・最大 ${iv.max}s`);
    const rm = out.relations;
    console.log(`関係 (好感の変化、初期値 50 から): 変わった ${rm.changed} 組 (上がった ${rm.positive}・下がった ${rm.negative})、上位 ${rm.top.map((p) => `${p.from}→${p.to} ${p.delta > 0 ? '+' : ''}${p.delta}`).join('・') || 'なし'}${rm.bottom.length ? `、下位 ${rm.bottom.map((p) => `${p.from}→${p.to} ${p.delta}`).join('・')}` : ''}`);
    if (rm.mutual.length) console.log(`  お互いに変わった組: ${rm.mutual.map((x) => `${x.pair} (${x.a > 0 ? '+' : ''}${x.a}/${x.b > 0 ? '+' : ''}${x.b})`).join('・')}`);
    if (rm.changed) for (const l of scale.matrixText(rm)) console.log(`  ${l}`);
    console.log('人ごと:');
    for (const l of out.brief) console.log(`  ${l}`);
    if (out.load.monitor || out.load.twoBLatency) {
      for (const [k, v] of Object.entries(out.load.monitor || {})) console.log(`負荷 ${k}: CPU p50 ${v.cpuPct.p50}%・最大 ${v.cpuPct.max}%、RSS 最大 ${v.rssMb.max}MB、イベントループの遅れ p99 の中央値 ${v.loopLagP99.p50}ms・最大 ${v.loopLagP99.max}ms、ボット ${v.bots.minAlive}/${v.bots.total} (切断 ${v.bots.disconnects})、2B の待ち p95 の中央値 ${v.twoBWaitP95.p50}ms・最大 ${v.twoBWaitP95.max}ms、Jev の 429 ${v.jevRateLimited} 回`);
      const tl = out.load.twoBLatency;
      if (tl) console.log(`2B の応答 (全体): ${tl.calls} 回、全体 p50 ${tl.ms.p50}ms・p95 ${tl.ms.p95}ms、待ち p50 ${tl.waitMs.p50}ms・p95 ${tl.waitMs.p95}ms・最大 ${tl.waitMs.max}ms、切断 ${out.load.disconnects ?? '-'}`);
    }
    console.log(`go_to(人) ${out.goToPerson.n} 回 (着いた ${out.goToPerson.ok}) ${JSON.stringify(out.goToPerson.byPair)}`);
    console.log(`2B の呼び出し ${out.twoB.calls} 回 (平均 ${out.twoB.avgPromptChars} 文字)`);
    console.log(`Jev 入力 ${out.jev.inputTokens} トークン (1判断 ${out.jev.inputTokensPerDecision}・呼び出し ${out.jev.callsPerDecision} 回、1呼び出し ${out.jev.inputTokensPerCall})、推定 $${out.jev.costUsd} (100万トークン $${JEV_USD_PER_MTOK})`);
  }
}

main();
