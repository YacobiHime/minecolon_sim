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
const { parsePlaces } = require('../src/places');
const divisionTool = require('./division_stats');

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
    ...jevCostFromLoops(loops, tok),
  };
}

// 費用: 記録の jev.costUsd (OpenRouter の usage.cost。2段なら合計) があればその値、無い判断は入力トークン × 単価。refusal・long-context・提供元も数える
function jevCostFromLoops(loops, tok) {
  const rep = loops.filter((r) => Number.isFinite(r.jev.costUsd));
  const repTok = sum(rep.map((r) => r.jev.inputTokens));
  const reportedCostUsd = sum(rep.map((r) => r.jev.costUsd));
  const via = {};
  const models = {};
  for (const r of loops) { if (r.jev.via) via[r.jev.via] = (via[r.jev.via] || 0) + 1; if (r.jev.model) models[r.jev.model] = (models[r.jev.model] || 0) + 1; }
  return {
    costUsd: Number((reportedCostUsd + ((tok - repTok) / 1e6) * JEV_USD_PER_MTOK).toFixed(6)), reportedCostUsd: Number(reportedCostUsd.toFixed(6)), reportedCostCalls: rep.length,
    refusals: sum(loops.map((r) => (r.jev.refusals || []).length + ((r.jev.stage2 && r.jev.stage2.refusals) || []).length)),
    longContextCalls: loops.filter((r) => r.jev.longContext || (r.jev.stage2 && r.jev.stage2.longContext)).length,
    maxBodyBytes: Math.max(0, ...loops.map((r) => r.jev.bodyBytes || 0)), via, models,
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

// Jev の行動の選び方 (R10・R5・R3): 選んだ選択肢の確率 p と 1位÷2位 の比 ratio の分布、選んだ選択肢の並びの位置 (先頭に寄るか)、
//   道筋の次の一手が今すぐできるか (next_now) と、そのとき道筋どおりの行動を選んだ割合
const P_BINS = [0.2, 0.4, 0.6, 0.8, 1.0001];
const R_BINS = [1.5, 2, 4, 10, Infinity];
function hist(xs, bins, label) {
  const out = {};
  let lo = 0;
  for (const b of bins) { out[label(lo, b)] = xs.filter((x) => x >= lo && x < b).length; lo = b; }
  return out;
}
function jevChoiceStats(loops, { yes = 0.7, no = 0.3 } = {}) {
  const js = loops.filter((r) => r.jev && r.jev.choice);
  const ps = js.map((r) => r.jev.choice.p).filter((x) => Number.isFinite(x));
  const rs = js.map((r) => r.jev.choice.ratio).filter((x) => Number.isFinite(x));
  const q = (a) => ({ n: a.length, p10: pct(a, 10), p50: pct(a, 50), p90: pct(a, 90) });
  const pos = js.filter((r) => Number.isFinite(r.jev.choice.pos) && r.jev.choice.pos >= 0 && r.jev.choice.n > 1);
  // 位置: 先頭の 10% に入った割合 (並べ方を変えていれば偏りがなければ約 10%)
  const relPos = pos.map((r) => r.jev.choice.pos / (r.jev.choice.n - 1));
  const shuffled = pos.filter((r) => r.jev.order && r.jev.order.shuffled);
  const nn = js.filter((r) => r.jev.path && Number.isFinite(r.jev.path.nextNowP));
  const can = nn.filter((r) => r.jev.path.nextNowP >= yes);
  const cannot = nn.filter((r) => r.jev.path.nextNowP < no);
  const share = (rows, m) => (rows.length ? Number((rows.filter((r) => r.jev.path.match === m).length / rows.length).toFixed(3)) : null);
  return {
    p: { ...q(ps), hist: hist(ps, P_BINS, (lo, b) => `${lo.toFixed(1)}-${Math.min(1, b).toFixed(1)}`) },
    ratio: { ...q(rs), hist: hist(rs, R_BINS, (lo, b) => (b === Infinity ? `>=${lo}` : `${lo}-${b}`)) },
    position: { n: pos.length, shuffled: shuffled.length, first: pos.filter((r) => r.jev.choice.pos === 0).length,
      first10pct: relPos.length ? Number((relPos.filter((x) => x <= 0.1).length / relPos.length).toFixed(3)) : null, meanRel: relPos.length ? Number((relPos.reduce((a, b) => a + b, 0) / relPos.length).toFixed(3)) : null },
    nextNow: {
      asked: nn.length, can: can.length, cannot: cannot.length, unsure: nn.length - can.length - cannot.length,
      canRate: nn.length ? Number((can.length / nn.length).toFixed(3)) : null,
      // 「今すぐできる」と判定したとき、道筋どおり (step) / 近づく (approach) / ほか を選んだ割合
      whenCan: { step: share(can, 'step'), approach: share(can, 'approach'), other: share(can, 'other') },
      whenCannot: { step: share(cannot, 'step'), approach: share(cannot, 'approach'), other: share(cannot, 'other') },
    },
  };
}

// ゴールの選び方 (R1・R2): 案の数・外した案 (満たされている・たどれない)・Jev の点で選んだ規則・2B の最初の案と違う案を選んだ割合
function goalSelectStats(all, n = 12) {
  const ev = all.filter((r) => r.event === 'goal_path');
  const props = ev.filter((r) => r.kind === 'proposals' || (r.kind === 'goal' && r.proposals));
  const goals = ev.filter((r) => r.kind === 'goal' && r.ok && r.select);
  const allProps = props.flatMap((r) => r.proposals || []);
  // 先のつらさ (later) があれば「先の夜(1.8)」と、案ごとの いま+先 の内訳も
  const examples = goals.slice(0, n).map((r) => `${r._name} t${r.tick}: ${(r.select.needs || []).map((x) => `${x.need}(${x.distress})`).join(' ')}${(r.select.later || []).map((x) => ` 先の${x.need}(${x.distress})`).join('')} | ${(r.select.scores || []).map((s, i) => `${i === r.select.chosen ? '*' : ''}${s.target}${s.count ? ` ${s.count}` : ''}=${s.score}${s.later ? ` (いま ${s.now}+先 ${s.later})` : ''} ${JSON.stringify(s.P)}`).join(' / ')} [${r.select.rule}${r.select.decidedBy ? `・${r.select.decidedBy}` : ''}]`);
  return {
    rounds: props.length, goalsSelected: goals.length, proposals: allProps.length,
    dropped: countBy(allProps.filter((x) => !x.ok), (x) => x.result || '-'),
    satisfiedSingle: ev.filter((r) => r.kind === 'satisfied').length,
    rules: countBy(goals, (r) => r.select.rule || '-'),
    notFirst: goals.filter((r) => r.select.chosen > 0).length,
    jevTokens: sum(goals.map((r) => (r.select.jev ? r.select.jev.inputTokens : 0))),
    effortChanged: goals.filter((r) => r.select.effortChanged).length, // 手間で割らなければ別の案だった
    calls: twoBCallStats(ev),
    examples,
  };
}

// ゴール選びの 2B の呼び出し (毎回の記録): 入力のトークン (p50/p90/max)・出力が切れた・文脈あふれ・欄を削った・成功
function twoBCallStats(ev) {
  const calls = ev.filter((r) => (r.kind === 'proposals' || r.kind === 'goal' || r.kind === 'unplannable' || r.kind === 'satisfied') && (r.promptChars != null || r.error));
  const overflow = ev.filter((r) => r.kind === 'prompt_overflow').length;
  const pt = calls.map((r) => r.promptTokens).filter(Number.isFinite).sort((a, b) => a - b);
  const q = (f) => (pt.length ? pt[Math.min(pt.length - 1, Math.floor(f * pt.length))] : null);
  return { calls: calls.length + overflow, ok: calls.filter((r) => r.ok).length, truncated: calls.filter((r) => r.truncated || r.finishReason === 'length').length,
    overflow, httpErrors: calls.filter((r) => r.error).length, trimmed: calls.filter((r) => r.fit && r.fit.applied && r.fit.applied.length).length,
    promptTokens: { p50: q(0.5), p90: q(0.9), max: pt.length ? pt[pt.length - 1] : null } };
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

// 備え・夜の戦い・先の不安 (anticipate.js。2026-11-05)。古い記録 (先の不安の値が無い) でも、備え・戦い・夜の死亡は同じに数える
//   備え: 武器 (剣・弓・クロスボウ・三叉槍)・斧・防具・盾・松明を、初めて作った (craft が成功) / 初めて持った (持ち物か着けている物に出た) 判断。
//     夕方より前 (その日の timeOfDay < dusk) に作った/持った人の数を日ごとに
//   夜に戦った割合: 夜 (13000〜23000) に敵が見えた判断 (obs に「敵<名前>」) のうち attack (敵に) / flee / ほか。昼も比べる
//   先の不安の推移: social.needs.ant.night (と food) の1分ごとの平均
const PREP_KINDS = {
  weapon: /_sword$|^bow$|^crossbow$|^trident$/, axe: /_axe$/, armor: /_(helmet|chestplate|leggings|boots)$/, shield: /^shield$/, torch: /^torch$/,
};
const HOSTILE_RE = /敵([a-z_]+)/g;
const HOSTILE_NAMES = new Set(['zombie', 'zombie_villager', 'husk', 'drowned', 'skeleton', 'stray', 'creeper', 'spider', 'cave_spider', 'enderman', 'witch', 'slime', 'phantom', 'pillager', 'vindicator', 'evoker', 'ravager', 'silverfish', 'zombified_piglin', 'piglin', 'hoglin', 'zoglin', 'blaze', 'ghast', 'magma_cube', 'wither_skeleton', 'guardian', 'elder_guardian', 'vex', 'endermite', 'shulker', 'warden', 'breeze']);
const isNightT = (t) => t != null && t >= 13000 && t < 23000;
function prepareStats(all, { dusk = 12000 } = {}) {
  const steps = all.filter(isStep);
  const t0 = Math.min(...all.filter((r) => r.ts).map((r) => new Date(r.ts).getTime()));
  const minOf = (r) => (r.ts ? Math.round(((new Date(r.ts).getTime() - t0) / 60000) * 10) / 10 : null);
  const names = [...new Set(steps.map((r) => r._name))];
  const bravery = {};
  for (const r of all.filter((x) => x.event === 'start' && x.persona)) bravery[r._name] = r.persona.temperament ? r.persona.temperament.bravery ?? null : null;
  const at = (r) => ({ loop: r.loop, day: r.day, timeOfDay: r.timeOfDay, min: minOf(r), item: r.arg || null });
  const perAgent = {};
  for (const nm of names) {
    const rows = steps.filter((r) => r._name === nm);
    const o = { bravery: bravery[nm] ?? null, crafted: {}, had: {} };
    for (const [k, re] of Object.entries(PREP_KINDS)) {
      const c = rows.find((r) => r.action === 'craft' && r.result.ok && re.test(String(r.arg || '')));
      o.crafted[k] = c ? at(c) : null;
      const h = rows.find((r) => (r.inventory || []).some((i) => re.test(i.name)) || ((r.worn || []).some((n) => re.test(n))));
      o.had[k] = h ? { ...at(h), item: ((h.inventory || []).find((i) => re.test(i.name)) || {}).name || null } : null;
    }
    perAgent[nm] = o;
  }
  // 日ごとに、夕方より前に作った/持った人の数
  const days = [...new Set(steps.map((r) => r.day).filter((d) => d != null))].sort((a, b) => a - b);
  const before = (x, d) => x && x.day != null && (x.day < d || (x.day === d && x.timeOfDay != null && x.timeOfDay < dusk));
  const beforeDusk = days.map((d) => ({ day: d + 1, ...Object.fromEntries(Object.keys(PREP_KINDS).map((k) => [k, {
    crafted: names.filter((nm) => before(perAgent[nm].crafted[k], d)).length, had: names.filter((nm) => before(perAgent[nm].had[k], d)).length,
  }])) }));
  // 敵が見えた判断で何を選んだか (夜・昼)
  const fight = (rows) => {
    const seen = rows.filter((r) => { const m = String(r.obs || '').match(HOSTILE_RE); return m && m.some((x) => HOSTILE_NAMES.has(x.slice(1))); });
    const atk = seen.filter((r) => r.action === 'attack' && HOSTILE_NAMES.has(String(r.arg || '').split(':')[0])).length;
    const fl = seen.filter((r) => r.action === 'flee').length;
    const r2 = (x) => (seen.length ? Math.round((x / seen.length) * 100) / 100 : null);
    return { seen: seen.length, attack: atk, flee: fl, other: seen.length - atk - fl, attackRate: r2(atk), fleeRate: r2(fl) };
  };
  const night = steps.filter((r) => isNightT(r.timeOfDay));
  const day = steps.filter((r) => r.timeOfDay != null && !isNightT(r.timeOfDay));
  const fightPer = Object.fromEntries(names.map((nm) => [nm, { bravery: bravery[nm] ?? null, night: fight(night.filter((r) => r._name === nm)), day: fight(day.filter((r) => r._name === nm)) }]));
  // 夜の死亡
  const deaths = all.filter((r) => r.event === 'death');
  const nightDeaths = deaths.filter((d) => isNightT(d.timeOfDay));
  const killer = (d) => { const m = String(d.message || '').match(/(?:escape|by) ([A-Z][A-Za-z ]*?)$/); return m ? m[1].toLowerCase() : /drown/.test(d.message || '') ? 'water' : d.cause || 'unknown'; };
  const nightByKiller = countBy(nightDeaths, killer);
  // 先の不安の推移 (1分ごと、人ごと)
  const antRows = steps.filter((r) => r.social && r.social.needs && r.social.needs.ant && Number.isFinite(r.social.needs.ant.night));
  let anticipation = null;
  if (antRows.length) {
    anticipation = {};
    for (const nm of names) {
      const rows = antRows.filter((r) => r._name === nm);
      if (!rows.length) continue;
      const by = new Map();
      for (const r of rows) { const m = Math.floor(minOf(r)); if (!by.has(m)) by.set(m, []); by.get(m).push(r.social.needs.ant); }
      const avg = (xs, k) => Math.round((sum(xs.map((x) => x[k] || 0)) / xs.length) * 100) / 100;
      anticipation[nm] = { max: { night: Math.max(...rows.map((r) => r.social.needs.ant.night)), food: Math.max(...rows.map((r) => r.social.needs.ant.food || 0)) },
        perMinute: [...by.keys()].sort((a, b) => a - b).map((m) => ({ min: m, night: avg(by.get(m), 'night'), food: avg(by.get(m), 'food'), prep: avg(by.get(m), 'prep') })) };
    }
  }
  // ゴールの選び方で、先の点が選んだ案を変えた回数
  const sel = all.filter((r) => r.event === 'goal_path' && r.select && r.select.decidedBy);
  const decidedBy = countBy(sel, (r) => r.select.decidedBy);
  return {
    perAgent, beforeDusk, fight: { night: fight(night), day: fight(day), perAgent: fightPer },
    nightDeaths: { n: nightDeaths.length, of: deaths.length, byKiller: nightByKiller, byDay: countBy(nightDeaths, (d) => (d.day != null ? d.day + 1 : '?')) },
    anticipation, decidedBy,
  };
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

// 全体チャット・提案・取り決め・共有のチェスト・共同の目標 (src/board.js の event: 'board')
//   同じ取り決めの成立・中身の変化は全員が記録するので、id ごとに1つにまとめる
function boardStats(all, n = 8) {
  const ev = all.filter((r) => r.event === 'board').sort((a, b) => (a.ts < b.ts ? -1 : 1));
  if (!ev.length) return null;
  const k = (kind) => ev.filter((r) => r.kind === kind);
  const bc = k('broadcast');
  const said = bc.filter((r) => r.say);
  const props = k('propose').filter((r) => r.ok);
  const votes = k('vote');
  const agreed = new Map(); for (const r of k('agreed')) if (!agreed.has(r.id)) agreed.set(r.id, r);
  const expired = new Set(k('expired').map((r) => r.id));
  const seen = k('seen');
  const pairs = {};
  for (const r of seen) { const key = `${r.from}→${r.to}`; pairs[key] = (pairs[key] || 0) + 1; }
  const why = {};
  for (const r of seen) why[r.why] = (why[r.why] || 0) + 1;
  const reach = {}; // 発言ごとに何人の state に出たか
  for (const r of seen) { const key = `${r.from}|${r.text}`; reach[key] = (reach[key] || 0) + 1; }
  const comply = k('comply');
  const byAgreement = {};
  for (const r of comply) { const x = byAgreement[r.agreement] || (byAgreement[r.agreement] = { kept: 0, broken: 0, keptBy: {}, brokenBy: {} }); const f = r.kept ? 'kept' : 'broken'; x[f] += r.n || 1; x[`${f}By`][r._name] = (x[`${f}By`][r._name] || 0) + (r.n || 1); }
  const projDone = new Map(); for (const r of k('project_done')) if (!projDone.has(r.id)) projDone.set(r.id, r);
  const shares = k('share_chest');
  const voteBy = {};
  for (const r of votes) { const x = voteBy[r.id] || (voteBy[r.id] = { yes: 0, no: 0, by: r.by, examples: [] }); x[r.yes ? 'yes' : 'no'] += 1; if (x.examples.length < 3) x.examples.push(`${r._name} ${r.yes ? '賛成' : '反対'} p=${r.p} (${r.by}とは${r.relation})`); }
  return {
    broadcasts: { asked: bc.length, said: said.length, byFrom: countBy(said, (r) => r._name), examples: said.slice(0, n).map((r) => `${r._name}: ${r.say}`) },
    seen: { n: seen.length, byWhy: why, pairs: Object.entries(pairs).sort((a, b) => b[1] - a[1]).slice(0, 15), reachP50: pct(Object.values(reach), 50), reachMax: maxOf(Object.values(reach)) },
    proposals: props.map((r) => ({ id: r.id, by: r._name, text: r.text, spec: r.spec, n: r.n, need: r.need, votes: voteBy[r.id] || { yes: 0, no: 0 }, agreed: agreed.has(r.id), expired: expired.has(r.id) })),
    proposeFailed: k('propose').filter((r) => !r.ok).length,
    votes: { n: votes.length, yes: votes.filter((r) => r.yes).length, no: votes.filter((r) => !r.yes).length, examples: Object.values(voteBy).flatMap((x) => x.examples).slice(0, n) },
    agreements: [...agreed.values()].map((r) => ({ id: r.id, by: r.by, text: r.text, spec: r.spec, yes: (r.yes || []).length, need: r.need, compliance: byAgreement[r.id] || null })),
    projectsDone: [...projDone.values()].map((r) => `${r.id} ${r.item} x${r.count}`),
    sharedChests: shares.map((r) => `${r._name}: ${r.chest}`),
    breachKnown: k('breach_known').map((r) => `${r._name} が知った: ${r.who} が ${r.chest} から ${r.item} x${r.n} を出した (${r.agreement})`),
    placed: k('placed').length,
  };
}

// 近くの声と全体チャットの回数・比率、近くの声が会話になったか (記録だけ。使い方は制限しない)
//   近くの声: talk の発言・say の行動・聞く (ask)・答える (answer)。全体: broadcast (言えた)・propose (書けた)。賛成/反対の印は別に数える
//   会話になった: 近くの声の時点で hearRadius 以内に居たほかの人 (その人の直前の判断の位置) が、replySec 秒以内に近くの声で何か言った
function voiceStats(all, { hearRadius = 24, replySec = 60 } = {}) {
  const t = (r) => Date.parse(r.ts);
  const near = [];
  for (const r of all) {
    if (r.event === 'talk' && r.say) near.push({ who: r._name, ts: t(r), kind: 'talk' });
    else if (r.event === 'ask') near.push({ who: r._name, ts: t(r), kind: 'ask', to: r.to });
    else if (r.event === 'answer') near.push({ who: r._name, ts: t(r), kind: 'answer', to: r.to });
    else if (isStep(r) && r.action === 'say' && r.say) near.push({ who: r._name, ts: t(r), kind: 'say' });
  }
  const glob = all.filter((r) => r.event === 'board' && ((r.kind === 'broadcast' && r.say) || (r.kind === 'propose' && r.ok))).map((r) => ({ who: r._name, ts: t(r), kind: r.kind }));
  const votes = all.filter((r) => r.event === 'board' && r.kind === 'vote').length;
  // 人ごとの位置の時系列 (判断の記録の pos)
  const posBy = {};
  for (const r of all) if (isStep(r) && r.pos) (posBy[r._name] = posBy[r._name] || []).push({ ts: t(r), pos: r.pos });
  for (const l of Object.values(posBy)) l.sort((a, b) => a.ts - b.ts);
  const posAt = (name, ts) => { const l = posBy[name] || []; let p = null; for (const x of l) { if (x.ts > ts) break; p = x.pos; } return p; };
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const nearSorted = near.slice().sort((a, b) => a.ts - b.ts);
  let withListener = 0; let replied = 0; let listenerSum = 0;
  const per = {};
  const P = (n) => (per[n] = per[n] || { near: 0, global: 0, nearWithListener: 0, nearReplied: 0 });
  for (const u of nearSorted) {
    P(u.who).near += 1;
    const me = posAt(u.who, u.ts);
    const listeners = me ? Object.keys(posBy).filter((n) => n !== u.who && (() => { const p = posAt(n, u.ts); return p && d(p, me) <= hearRadius; })()) : [];
    listenerSum += listeners.length;
    if (!listeners.length && !u.to) continue;
    withListener += 1; P(u.who).nearWithListener += 1;
    const ls = new Set(u.to ? [...listeners, u.to] : listeners);
    if (nearSorted.some((v) => v !== u && ls.has(v.who) && v.ts > u.ts && v.ts - u.ts <= replySec * 1000)) { replied += 1; P(u.who).nearReplied += 1; }
  }
  for (const g of glob) P(g.who).global += 1;
  const ratio = (a, b) => (a + b ? Math.round((b / (a + b)) * 100) / 100 : null);
  for (const v of Object.values(per)) v.globalShare = ratio(v.near, v.global);
  return { near: near.length, global: glob.length, globalShare: ratio(near.length, glob.length), votes, nearWithListener: withListener, nearReplied: replied, listeners: listenerSum, listenersAvg: near.length ? Math.round((listenerSum / near.length) * 100) / 100 : null, replySec, hearRadius, perAgent: per };
}

// 場所の共有 (2026-11-06 ユーザー決定: 共有は【発見】・近くの声・聞いて答える の会話だけで起きる。踏破のファイルは読まない)
//   finds: 【発見】の行 (board report_find で言えた数・そのうち場所 (共通の呼び方・座標) が入っていた数)
//   nearWithPlace: 近くの声 (talk の発言・say・call・answer) のうち場所が入っていた数 (種類ごと)
//   learned: 聞いた場所を覚えた数 (heard_place。via: board = 【発見】 / near = 近くの声。古い記録は via なし → board)
//   goTo: 聞いた場所 (人から聞いて覚えた所) へ go_to した数 (判断の記録の heardPlace。古い記録には無い)・着いた数
const ORIGIN0 = { x: 0, y: 64, z: 0 };
const hasPlace = (text) => { try { return !!text && parsePlaces(String(text), ORIGIN0).length > 0; } catch (_) { return false; } };
// チェストとベッド (2026-11-06T06-05-27 の実行で見つけた不具合の数)
//   chest.lookOtherTake: 「中を見た」チェストと、そのあと3回以内の「取り出す」が別の位置だった回数
//   bed.placeFail / placeRetried: ベッドを置けなかった回数 / 置き直して置けた回数 (result.retries)
//   bed.diedUnplaced: 自分のベッドを一度も置かないまま、ベッドを持って死んだ回数
function chestBedStats(all) {
  const byName = new Map();
  for (const r of all) {
    if (!r._name) continue;
    if (!byName.has(r._name)) byName.set(r._name, []);
    byName.get(r._name).push(r);
  }
  const key = (p) => (p ? `${p.x},${p.y},${p.z}` : null);
  let looks = 0; let lookOtherTake = 0; let takeFail = 0;
  let placeTry = 0; let placeFail = 0; let placeRetried = 0; let diedUnplaced = 0;
  for (const rows of byName.values()) {
    const steps = rows.filter((r) => r.action && r.result);
    steps.forEach((r, i) => {
      if (r.action !== 'chest_take') return;
      if (r.arg === 'look' || String(r.arg).startsWith('look@')) {
        looks += 1;
        const at = key(r.result.chest && r.result.chest.pos);
        const next = steps.slice(i + 1, i + 4).find((x) => x.action === 'chest_take' && !String(x.arg).startsWith('look'));
        if (at && next && next.result.chest && key(next.result.chest.pos) !== at) lookOtherTake += 1;
      } else if (!r.result.ok) takeFail += 1;
    });
    let placedBed = false; let lastInv = [];
    for (const r of rows) {
      if (r.event === 'death') {
        if (!placedBed && lastInv.some((x) => /_bed$/.test(x.name))) diedUnplaced += 1;
        continue;
      }
      if (r.inventory) lastInv = r.inventory;
      if (r.action === 'place' && /_bed$/.test(String(r.arg)) && r.result) {
        placeTry += 1;
        if (r.result.ok) { placedBed = true; if (r.result.retries) placeRetried += 1; } else placeFail += 1;
      }
    }
  }
  return { chest: { looks, lookOtherTake, takeFail }, bed: { placeTry, placeFail, placeRetried, diedUnplaced } };
}

function placeShareStats(all) {
  const finds = all.filter((r) => r.event === 'board' && r.kind === 'report_find');
  const said = finds.filter((r) => r.say);
  const near = [];
  for (const r of all) {
    if (r.event === 'talk' && r.say) near.push({ kind: 'talk', text: r.say });
    else if (r.event === 'answer' && r.answer) near.push({ kind: 'answer', text: r.answer });
    else if (isStep(r) && r.action === 'say' && r.say) near.push({ kind: 'say', text: r.say });
    else if (isStep(r) && r.action === 'call' && r.result && r.result.said) near.push({ kind: 'call', text: r.result.said });
  }
  const nearP = near.filter((x) => hasPlace(x.text));
  const learned = all.filter((r) => r.event === 'heard_place');
  const via = (r) => r.via || 'board';
  const gos = all.filter((r) => isStep(r) && r.action === 'go_to' && r.heardPlace);
  const hasHeardField = all.some((r) => isStep(r) && 'heardPlace' in r);
  const pairs = {};
  for (const r of learned) { const k = `${r.from}→${r.to || r._name}`; pairs[k] = (pairs[k] || 0) + 1; }
  return {
    finds: { chosen: finds.length, said: said.length, withPlace: said.filter((r) => hasPlace(r.say)).length },
    nearVoices: near.length, nearWithPlace: nearP.length, nearWithPlaceByKind: countBy(nearP, (x) => x.kind),
    learned: learned.length, learnedPlaces: sum(learned.map((r) => (r.places || []).length)), learnedByVia: countBy(learned, via),
    learnedPairs: Object.entries(pairs).sort((a, b) => b[1] - a[1]).slice(0, 10),
    goTo: hasHeardField ? { n: gos.length, arrived: gos.filter((r) => r.result && r.result.ok).length, byPair: countBy(gos, (r) => `${r._name}←${r.heardPlace.from}`) } : null,
    examples: [...said.filter((r) => hasPlace(r.say)).map((r) => `${r._name} 【発見】${r.say}`), ...learned.filter((r) => r.via === 'near').map((r) => `${r.to || r._name} ← ${r.from}「${r.text}」`)].slice(0, 8),
  };
}

// 近くの声が届く人数を、声の届く距離ごとに見積もる (判断の記録の位置で。voiceStats と同じ数え方)
function voiceReach(all, radii = [24, 48]) {
  return Object.fromEntries(radii.map((h) => { const v = voiceStats(all, { hearRadius: h }); return [h, { near: v.near, nearWithListener: v.nearWithListener, listeners: v.listeners, listenersAvg: v.listenersAvg, nearReplied: v.nearReplied }]; }));
}

// 動けない (unstuck.js): 回復の回数と結果・移動の打ち切り・押し戻し・path_reset の理由・returningPos
function stuckStats(all, loops) {
  const ev = all.filter((r) => r.event === 'unstuck');
  const mv = loops.filter((r) => r.result && r.result.move).map((r) => ({ name: r._name, action: r.action, ...r.result.move }));
  const resets = {};
  for (const m of mv) for (const [k, v] of Object.entries(m.resets || {})) resets[k] = (resets[k] || 0) + v;
  const reconnects = ev.filter((r) => r.reconnect);
  return {
    stuck: ev.length, recovered: ev.filter((r) => r.ok).length, notRecovered: ev.filter((r) => !r.ok).length,
    perAgent: countBy(ev, (r) => r._name), byHow: countBy(ev, (r) => r.how || '?'),
    reconnects: reconnects.length, reconnectOk: reconnects.filter((r) => r.reconnect.ok).length,
    withReturningPos: ev.filter((r) => r.returning).length,
    moveActions: mv.length, gotos: sum(mv.map((m) => m.gotos || 0)), noProgress: sum(mv.map((m) => m.noProgress || 0)),
    noProgressByAction: countBy(mv.filter((m) => m.noProgress), (m) => m.action),
    forcedMoves: sum(mv.map((m) => m.forced || 0)), forcedByAgent: mv.filter((m) => m.forced).reduce((o, m) => { o[m.name] = (o[m.name] || 0) + m.forced; return o; }, {}),
    resets, returningSeen: mv.filter((m) => m.returning > 0).length, returningCleared: sum(mv.map((m) => m.returningCleared || 0)),
    list: ev.slice(0, 20).map((r) => `${r._name} #${r.loop} ${r.action}${r.arg ? `(${r.arg})` : ''} → ${r.ok ? '回復' : '回復できず'}: ${r.how}${r.reconnect ? ` [入り直し ${r.reconnect.ok ? 'OK' : 'NG'}]` : ''}`),
  };
}

// 実行の声の届く距離 (start の記録の cfg に入っていれば。無ければ 24 = 2026-11-06 より前の既定)
function hearOf(all) {
  const st = all.find((r) => r.event === 'start' && r.perception && r.perception.hearRadius);
  return st ? st.perception.hearRadius : 24;
}

// 畑: 耕した回数とそのとき水から4マス以内だった割合 (result.farm.nearWater。古い記録は分からない)、植えた、耕地が土に戻った (event farmland_reverted)、
//   収穫した (育ちきった作物の collect が成功)、パンを作った、何も起きない操作 (クワを耕地に)、育つのを待った判断 (growWait)
const CROP_RE = /^(wheat|carrots|potatoes|beetroots)$/;
function farmStats(all, loops) {
  const useOn = loops.filter((r) => r.action === 'use_on' && r.result);
  const tilled = useOn.filter((r) => (r.result.farm && r.result.farm.till) || (!r.result.farm && r.result.ok && /_hoe>/.test(r.arg || '') && /farmland/.test(String(r.result.msg || '')) && !/>farmland/.test(r.arg || '')));
  const known = tilled.filter((r) => r.result.farm && r.result.farm.nearWater != null);
  const near = known.filter((r) => r.result.farm.nearWater).length;
  const planted = useOn.filter((r) => (r.result.farm && r.result.farm.plant) || (!r.result.farm && r.result.ok && /^(wheat_seeds|carrot|potato|beetroot_seeds)>farmland/.test(r.arg || '')));
  const reverted = all.filter((r) => r.event === 'farmland_reverted');
  const harvest = loops.filter((r) => r.action === 'collect' && r.result && r.result.ok && CROP_RE.test(String(r.arg || '').split('@')[0]));
  const bread = loops.filter((r) => r.action === 'craft' && r.result && r.result.ok && r.arg === 'bread');
  const byAgent = {};
  const add = (rows, k) => { for (const r of rows) { const a = (byAgent[r._name] = byAgent[r._name] || { till: 0, plant: 0, reverted: 0, harvest: 0, bread: 0 }); a[k] += 1; } };
  add(tilled, 'till'); add(planted, 'plant'); add(reverted, 'reverted'); add(harvest, 'harvest'); add(bread, 'bread');
  return {
    till: tilled.length, tillNearWaterKnown: known.length, tillNearWater: near, tillNearWaterRate: known.length ? Number((near / known.length).toFixed(3)) : null,
    tillToSpot: useOn.filter((r) => /farmland_spot/.test(r.arg || '')).length,
    plant: planted.length, plantBy: countBy(planted, (r) => (r.result.farm && r.result.farm.plant) || String(r.arg).split('>')[0]),
    reverted: reverted.length, revertedNearWater: reverted.filter((r) => r.nearWater).length,
    harvest: harvest.length, bread: bread.length,
    hoeOnFarmland: useOn.filter((r) => /_hoe>farmland(@|$)/.test(r.arg || '')).length,
    growWait: loops.filter((r) => r.growWait).length,
    // 続けて耕す・植える (result.farm.n): 耕したマス・植えた本数の合計と、2マス以上続けた回数
    tillBlocks: sum(tilled.map((r) => (r.result.farm && r.result.farm.n) || 1)), plantBlocks: sum(planted.map((r) => (r.result.farm && r.result.farm.n) || 1)),
    batched: useOn.filter((r) => r.result.farm && r.result.farm.n > 1).length,
    revertedCause: countBy(reverted, revertCause),
    // 苗木を植えた (result.sapling。道筋の「植える → 育つ → 切る」)
    sapling: useOn.filter((r) => r.result.ok && r.result.sapling).length, saplingBy: countBy(useOn.filter((r) => r.result.ok && r.result.sapling), (r) => r.result.sapling.name),
    perAgent: byAgent,
  };
}

// 耕地が土に戻った原因の見立て (記録にある材料だけ): 真上に固い物 (block_on_top)・自分か人が上か隣に立っていた (stood_on)・材料が無い (unknown)
function revertCause(r) {
  if (r.above && !/^(air|cave_air|void_air|wheat|carrots|potatoes|beetroots)$/.test(r.above)) return 'block_on_top';
  if (r.selfOnTop || (r.near || []).some((x) => x.d <= 1.2 && x.dy >= 0.5 && x.dy <= 2)) return 'stood_on';
  if (r.above === undefined && r.near === undefined) return 'unknown_old_record';
  return 'unknown';
}

// あとでやること (prospect.js。event prospect): 足した数 (種類ごと)・見込みの時刻になった数・済んだ (取った/取り出した/無くなった)・
//   見込みの時刻のあとに取った数と、見込みの時刻から取るまでの時間 (ゲーム内の分)・あとでやることの候補をゴールに選んだ数
function prospectStats(all) {
  const ev = all.filter((r) => r.event === 'prospect');
  const added = ev.filter((r) => r.op === 'add');
  const done = ev.filter((r) => r.op === 'done');
  const got = done.filter((r) => (r.how === 'harvested' || r.how === 'taken'));
  const after = got.filter((r) => r.afterDue);
  const over = after.map((r) => r.overdueMin).filter(Number.isFinite);
  const goals = all.filter((r) => r.event === 'goal_path' && r.kind === 'goal' && r.ok && r.later);
  return {
    added: added.length, byKind: countBy(added, (r) => r.kind), merged: ev.filter((r) => r.op === 'merge').length,
    due: ev.filter((r) => r.op === 'due').length, dueByKind: countBy(ev.filter((r) => r.op === 'due'), (r) => r.kind),
    ripeSeen: ev.filter((r) => r.op === 'ripe_seen').length,
    done: countBy(done, (r) => r.how), collected: got.length, collectedAfterDue: after.length,
    overdueMin: over.length ? { p50: pct(over, 50), max: Math.max(...over) } : null,
    sinceStartMin: got.length ? { p50: pct(got.map((r) => r.sinceStartMin).filter(Number.isFinite), 50) } : null,
    laterGoals: goals.length, laterGoalsByKind: countBy(goals, (r) => r.later.kind),
  };
}

// 発言の中の M 番号を共通の呼び方に置き換えた (event m_replaced): 置き換えた文の数・M 番号の数・経路 (chat / board)
function mRefStats(all) {
  const ev = all.filter((r) => r.event === 'm_replaced');
  return { texts: ev.length, refs: sum(ev.map((r) => r.n || 0)), byVia: countBy(ev, (r) => r.via), examples: ev.slice(0, 3).map((r) => `${r._name || ''}: 「${r.original}」→「${r.replaced}」`) };
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
      reportedCostUsd: jev.reportedCostUsd ?? null, reportedCostCalls: jev.reportedCostCalls ?? null, refusals: jev.refusals ?? null,
      longContextCalls: jev.longContextCalls ?? null, maxBodyBytes: jev.maxBodyBytes ?? null, via: jev.via || null, models: jev.models || null, fatal: jev.fatal ?? null,
    },
    survival: survivalStats(agents, all),
    selfGoals: { count: all.filter((r) => r.event === 'self_goal').length, byReason: all.filter((r) => r.event === 'self_goal').reduce((m, r) => { m[r.reason] = (m[r.reason] || 0) + 1; return m; }, {}), timeline: goalTimeline(all) },
    goalPlan: all.some((r) => r.event === 'goal_plan') ? goalPlanStats(all) : null,
    goalPath: all.some((r) => r.event === 'goal_path') ? goalPathStats(all) : null,
    goalSelect: all.some((r) => r.event === 'goal_path' && (r.kind === 'proposals' || r.select || r.kind === 'satisfied')) ? goalSelectStats(all) : null,
    jevChoice: jevChoiceStats(loops),
    reflect: all.some((r) => r.event === 'reflect') ? reflectStats(all) : null,
    penActs: penActStats(loops),
    baseSite: all.some((r) => r.event === 'base_site') ? baseSiteStats(all) : null,
    needs: needsStats(all),
    prepare: prepareStats(all),
    goalWhy: goalWhyList(all),
    others: { appended: loops.filter((r) => r.result && r.result.others && r.result.others.length).length,
      items: sum(loops.map((r) => ((r.result && r.result.others) || []).length)) },
    cooperation: cooperationStats(all),
    board: boardStats(all),
    stuck: stuckStats(all, loops),
    voices: voiceStats(all, { hearRadius: hearOf(all) }),
    voiceReach: voiceReach(all),
    placeShare: placeShareStats(all),
    chestBed: chestBedStats(all),
    farm: farmStats(all, loops),
    prospects: prospectStats(all),
    mRefs: mRefStats(all),
    pairDistance: pairDistanceStats(all),
    goToPerson: goToPersonStats(all, agents.map((a) => a.name)),
    // 分業の指標 (tools/division_stats.js。division の記録が無い前の記録にも分類表で当てる)
    division: divisionTool.divisionStats(all),
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
  // 文を作る LLM の提供元・役ごとの使用量と費用 (run.json の usage.llm。古い記録には無い)
  out.llm = runJson && runJson.usage && runJson.usage.llm ? llmUsageSummary(runJson.usage.llm) : null;
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
      if (out.goalSelect) {
        const gs = out.goalSelect;
        console.log(`ゴールの案 ${gs.proposals} 個 (${gs.rounds} 回、外した ${JSON.stringify(gs.dropped)}、1案のとき満たされていて外した ${gs.satisfiedSingle})、Jev の点で選んだ ${gs.goalsSelected} 回 (${JSON.stringify(gs.rules)}、2B の最初の案以外 ${gs.notFirst}、Jev ${gs.jevTokens} トークン)`);
        for (const l of gs.examples.slice(0, 6)) console.log(`  ${l}`);
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
      const pr = out.prepare;
      console.log(`備え (夕方より前に 作った/持った 人数): ${pr.beforeDusk.map((d) => `${d.day}日目 ${Object.entries(d).filter(([k]) => k !== 'day').map(([k, v]) => `${k} ${v.crafted}/${v.had}`).join('・')}`).join(' | ')}`);
      const firsts = Object.entries(pr.perAgent).map(([nm, v]) => [nm, Object.entries(v.crafted).filter(([, x]) => x).map(([k, x]) => `${k}=${x.item}@${x.day + 1}日目${x.timeOfDay}`)]).filter(([, l]) => l.length);
      console.log(`  初めて作った: ${firsts.map(([nm, l]) => `${nm} ${l.join(',')}`).join(' / ') || 'なし'}`);
      const fn = pr.fight.night; const fd = pr.fight.day;
      console.log(`敵が見えた判断: 夜 ${fn.seen} 回 (attack ${fn.attack} = ${fn.attackRate}・flee ${fn.flee} = ${fn.fleeRate})、昼 ${fd.seen} 回 (attack ${fd.attackRate}・flee ${fd.fleeRate})、夜の死亡 ${pr.nightDeaths.n}/${pr.nightDeaths.of} ${JSON.stringify(pr.nightDeaths.byKiller)}`);
      console.log(`  夜の attack の割合 (人ごと、勇敢さ): ${Object.entries(pr.fight.perAgent).filter(([, v]) => v.night.seen).map(([nm, v]) => `${nm}(${v.bravery}) ${v.night.attack}/${v.night.seen}`).join('・')}`);
      if (pr.anticipation) for (const [nm, v] of Object.entries(pr.anticipation)) console.log(`  先の不安 ${nm} (最大 夜 ${v.max.night}・食べ物 ${v.max.food}): ${v.perMinute.filter((_, i) => i % 3 === 0).map((x) => `${x.min}分 ${x.night}`).join(' ')}`);
      if (Object.keys(pr.decidedBy).length) console.log(`  ゴールの選び方で決めた点 ${JSON.stringify(pr.decidedBy)}`);
      const fm = out.farm;
      if (fm.till || fm.plant || fm.harvest || fm.bread || fm.reverted) console.log(`畑: 耕した ${fm.till} 回 (水から4マス以内 ${fm.tillNearWater}/${fm.tillNearWaterKnown}${fm.tillNearWaterRate != null ? ` = ${Math.round(fm.tillNearWaterRate * 100)}%` : ''})・植えた ${fm.plant}・耕地が土に戻った ${fm.reverted}・収穫した ${fm.harvest}・パンを作った ${fm.bread}・クワを耕地に ${fm.hoeOnFarmland}・育つのを待った判断 ${fm.growWait}`);
      if (fm.sapling) console.log(`苗木を植えた ${fm.sapling} 回 ${JSON.stringify(fm.saplingBy)}`);
      if (fm.till || fm.plant) console.log(`  耕したマス ${fm.tillBlocks}・植えた本数 ${fm.plantBlocks} (続けて2マス以上 ${fm.batched} 回)・土に戻った原因の見立て ${JSON.stringify(fm.revertedCause)}`);
      const ps = out.prospects;
      if (ps.added) console.log(`あとでやること: ${ps.added} 件 ${JSON.stringify(ps.byKind)} (まとめた ${ps.merged})・見込みの時刻になった ${ps.due}・育ちきったのを見た ${ps.ripeSeen}・済んだ ${JSON.stringify(ps.done)}・見込みの時刻のあとに取った ${ps.collectedAfterDue}${ps.overdueMin ? ` (見込みから p50 ${ps.overdueMin.p50}分・最大 ${ps.overdueMin.max}分)` : ''}・候補をゴールに選んだ ${ps.laterGoals}`);
      if (out.mRefs.texts) console.log(`発言の M 番号を共通の呼び方に置き換えた: ${out.mRefs.texts} 文・${out.mRefs.refs} 個 ${JSON.stringify(out.mRefs.byVia)}`);
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
    const vs = out.voices;
    console.log(`近くの声 ${vs.near} 回・全体チャット ${vs.global} 回 (全体の割合 ${vs.globalShare ?? '-'}、賛成/反対の印 ${vs.votes})、近くの声のうち近くに人がいた ${vs.nearWithListener}・会話になった (${vs.replySec}秒以内に近くの人が返した) ${vs.nearReplied}`);
    console.log(`  人ごと (近く/全体/会話になった): ${Object.entries(vs.perAgent).map(([k, v]) => `${k} ${v.near}/${v.global}/${v.nearReplied}`).join('・')}`);
    console.log(`  届く距離ごと (近くの声のうち聞き手がいた / 聞き手の延べ人数・1発言あたり / 会話になった): ${Object.entries(out.voiceReach).map(([h, v]) => `${h}m ${v.nearWithListener}/${v.near}・${v.listeners}人 (${v.listenersAvg})・${v.nearReplied}`).join(' | ')}`);
    const ps = out.placeShare;
    console.log(`場所の共有: 【発見】 ${ps.finds.said} 回 (場所入り ${ps.finds.withPlace}、選んだ ${ps.finds.chosen})、近くの声に場所 ${ps.nearWithPlace}/${ps.nearVoices} ${JSON.stringify(ps.nearWithPlaceByKind)}、聞いた場所を覚えた ${ps.learned} 回 (${ps.learnedPlaces} か所、${JSON.stringify(ps.learnedByVia)})、聞いた場所へ go_to ${ps.goTo ? `${ps.goTo.n} 回 (着いた ${ps.goTo.arrived}) ${JSON.stringify(ps.goTo.byPair)}` : '- (記録に heardPlace なし)'}`);
    for (const l of ps.examples) console.log(`  ${l}`);
    const bd = out.board;
    if (bd) {
      console.log(`全体チャット ${bd.broadcasts.said} 回 (選んだ ${bd.broadcasts.asked}、人ごと ${JSON.stringify(bd.broadcasts.byFrom)})、state に出た ${bd.seen.n} 回 (理由 ${JSON.stringify(bd.seen.byWhy)}、1発言が届いた人数 p50 ${bd.seen.reachP50}・最大 ${bd.seen.reachMax})`);
      if (bd.seen.pairs.length) console.log(`  誰から誰へ (上位): ${bd.seen.pairs.map(([p, c]) => `${p} ${c}`).join('・')}`);
      for (const l of bd.broadcasts.examples) console.log(`  全体: ${l}`);
      console.log(`提案 ${bd.proposals.length} 個 (書けなかった ${bd.proposeFailed})、賛成 ${bd.votes.yes}・反対 ${bd.votes.no}、成立 ${bd.agreements.length}、共有にしたチェスト ${bd.sharedChests.length} (${bd.sharedChests.join(', ')})、共同の目標の達成 ${bd.projectsDone.length}`);
      for (const p of bd.proposals.slice(0, 8)) console.log(`  提案 ${p.id}「${p.text}」 ${JSON.stringify(p.spec)} 賛成 ${p.votes.yes + 1}/${p.need} (n=${p.n})${p.agreed ? ' 成立' : p.expired ? ' 期限切れ' : ''}`);
      for (const l of bd.votes.examples) console.log(`  票: ${l}`);
      for (const a of bd.agreements) if (a.compliance) console.log(`  取り決め ${a.id}: 守った ${a.compliance.kept} ${JSON.stringify(a.compliance.keptBy)}・破った ${a.compliance.broken} ${JSON.stringify(a.compliance.brokenBy)}`);
      for (const l of bd.breachKnown.slice(0, 5)) console.log(`  ${l}`);
    }
    const su = out.stuck;
    console.log(`動けない ${su.stuck} 回 (回復 ${su.recovered}・回復できず ${su.notRecovered}、入り直し ${su.reconnectOk}/${su.reconnects}、returningPos があった ${su.withReturningPos}) ${JSON.stringify(su.perAgent)}、回復のしかた ${JSON.stringify(su.byHow)}`);
    console.log(`  移動の打ち切り (10秒近づかない) ${su.noProgress} 回 / goto ${su.gotos} 回 ${JSON.stringify(su.noProgressByAction)}、押し戻し ${su.forcedMoves} 回 ${JSON.stringify(su.forcedByAgent)}、path_reset ${JSON.stringify(su.resets)}、行動の終わりに消した returningPos ${su.returningCleared}`);
    for (const l of su.list) console.log(`  ${l}`);
    console.log(`go_to(人) ${out.goToPerson.n} 回 (着いた ${out.goToPerson.ok}) ${JSON.stringify(out.goToPerson.byPair)}`);
    for (const l of divisionTool.textLines(out.division)) console.log(l);
    const jc = out.jevChoice;
    if (jc && jc.p.n) {
      console.log(`Jev の選択の確率 p: p10 ${jc.p.p10}・p50 ${jc.p.p50}・p90 ${jc.p.p90} ${JSON.stringify(jc.p.hist)}、1位÷2位: p50 ${jc.ratio.p50} ${JSON.stringify(jc.ratio.hist)}`);
      console.log(`  選んだ選択肢の位置: 先頭 ${jc.position.first}/${jc.position.n} (先頭10% ${jc.position.first10pct}、平均の位置 ${jc.position.meanRel}、並べ替えあり ${jc.position.shuffled})`);
      const nx = jc.nextNow;
      if (nx.asked) console.log(`  道筋の次の一手が今すぐできる (P≥0.7) ${nx.can}/${nx.asked} (${nx.canRate})、できない (P<0.3) ${nx.cannot}。できるとき道筋どおり ${nx.whenCan.step}・近づく ${nx.whenCan.approach}・ほか ${nx.whenCan.other}`);
    }
    console.log(`2B の呼び出し ${out.twoB.calls} 回 (平均 ${out.twoB.avgPromptChars} 文字)`);
    for (const l of llmUsageLines(out.llm)) console.log(l);
    console.log(`Jev 入力 ${out.jev.inputTokens} トークン (1判断 ${out.jev.inputTokensPerDecision}・呼び出し ${out.jev.callsPerDecision} 回、1呼び出し ${out.jev.inputTokensPerCall})、費用 $${out.jev.costUsd}`
      + (out.jev.reportedCostCalls ? ` (うち応答の usage.cost ${out.jev.reportedCostCalls} 回 $${out.jev.reportedCostUsd}、残りは 100万トークン $${JEV_USD_PER_MTOK} で計算)` : ` (100万トークン $${JEV_USD_PER_MTOK} で計算)`));
    const jx = out.jev;
    if (jx.via || jx.models) console.log(`  Jev の提供元 ${JSON.stringify(jx.via || {})}、返ったモデル ${JSON.stringify(jx.models || {})}`);
    if (jx.refusals || jx.longContextCalls || jx.fatal) console.log(`  refusal ${jx.refusals || 0}・long-context (本文 > 32,000 バイト) ${jx.longContextCalls || 0} 回 (最大 ${jx.maxBodyBytes} バイト)${jx.fatal ? `・止めたエラー (402 残高不足など) ${jx.fatal}` : ''}`);
  }
}

// usage.llm → { costUsd, maxUsd, exceeded, byProvider, byRole, providers }
function llmUsageSummary(l) {
  const pick = (u) => ({ calls: u.calls, errors: u.errors, rateLimited: u.rateLimited, retries: u.retries, promptTokens: u.promptTokens, cachedTokens: u.cachedTokens,
    cacheWriteTokens: u.cacheWriteTokens ?? null, completionTokens: u.completionTokens, reasoningTokens: u.reasoningTokens, avgMs: u.avgMs ?? (u.calls ? Math.round(u.ms / u.calls) : 0), costUsd: u.costUsd, unpriced: u.unpriced });
  const map = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, u]) => [k, pick(u)]));
  return { costUsd: l.costUsd, maxUsd: l.maxUsd ?? null, exceeded: !!l.exceeded, byProvider: map(l.byProvider), byRole: map(l.byRole), providers: l.providers || {} };
}

function llmUsageLines(l) {
  if (!l) return [];
  const out = [`文を作る LLM: 費用 $${l.costUsd}${l.maxUsd != null ? ` (上限 $${l.maxUsd}${l.exceeded ? '、上限で止めた' : ''})` : ''}`];
  const line = (k, u) => `  ${k}: ${u.calls} 回 (失敗 ${u.errors}・429 ${u.rateLimited}・再試行 ${u.retries})、入力 ${u.promptTokens} (キャッシュ ${u.cachedTokens}${u.cacheWriteTokens ? `・キャッシュへの書き込み ${u.cacheWriteTokens}` : ''})・出力 ${u.completionTokens}${u.reasoningTokens ? ` (推論 ${u.reasoningTokens})` : ''} トークン、平均 ${u.avgMs}ms、$${u.costUsd}`;
  for (const [k, u] of Object.entries(l.byProvider)) {
    const p = l.providers[k];
    out.push(`${line(k, u)}${p ? ` [${p.model}、料金 ${p.priced === true ? `入力 $${p.pricing.inputPerMTok}・出力 $${p.pricing.outputPerMTok} / 100万トークン` : '未設定'}]` : ''}`);
  }
  for (const [k, u] of Object.entries(l.byRole)) out.push(line(k, u));
  return out;
}

if (require.main === module) main();

module.exports = { llmUsageSummary, llmUsageLines };
