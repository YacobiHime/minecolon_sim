#!/usr/bin/env node
'use strict';
// 実行の記録を集計する。
//   node tools/summarize_run.js runs/<時刻>/            (run.js の1回の実行 = 全員分。run.json があれば使用量もそこから)
//   node tools/summarize_run.js runs/Taro-....jsonl     (段階1の1人分のファイルも読める)
//   --excerpt N   会話の抜粋の行数 (既定 40)   --text   週次報告用の短い文章も出す
const fs = require('fs');
const path = require('path');
const { JEV_USD_PER_MTOK } = require('../src/usage');

function pct(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
const sum = (a) => a.reduce((s, x) => s + (x || 0), 0);
const maxOf = (a) => (a.length ? Math.max(...a) : null);

function readJsonl(f) {
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}

// 同じ行動・引数が続いた最長の回数
function maxRun(loops) {
  let best = 0; let n = 0; let prev = null;
  for (const r of loops) { const k = `${r.action}:${r.arg}`; n = k === prev ? n + 1 : 1; prev = k; if (n > best) best = n; }
  return best;
}

function summarizeAgent(file, rows) {
  const loops = rows.filter((r) => r.loop && r.action);
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
    if (r.loop && r.action && !r.jev && r.promptChars) add('act', r.promptChars, r.promptTokens);
    if (r.loop && r.action && r.talk) add('talk', r.talk.promptChars, null);
    if (r.event === 'talk') add('talk', r.promptChars, r.promptTokens);
    if (r.event === 'answer' && r.twoB) add('answer', r.twoB.promptChars, r.twoB.promptTokens);
  }
  out.avgPromptChars = out.calls ? Math.round(out.promptChars / out.calls) : 0;
  return out;
}

function jevFromRows(all) {
  const loops = all.filter((r) => r.loop && r.jev);
  const tok = sum(loops.map((r) => r.jev.inputTokens));
  return {
    calls: loops.length, inputTokens: tok, inputChars: sum(loops.map((r) => r.jev.inputChars)),
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
    if (r.loop && r.action && r.say) lines.push({ ts: r.ts, text: `${who}: ${r.say}` });
    if (r.event === 'talk' && r.say) lines.push({ ts: r.ts, text: `${who}: ${r.say}  (talk ${r.talkP != null ? r.talkP.toFixed(2) : '-'})` });
    if (r.event === 'ask') lines.push({ ts: r.ts, text: `${who} → ${r.to} [聞く] ${r.question}` });
    if (r.event === 'answer') lines.push({ ts: r.ts, text: `${who} → ${r.to} [答える${r.known ? '' : '・知らない'}] ${r.answer}` });
    if (r.event === 'ask_timeout') lines.push({ ts: r.ts, text: `${who} … ${r.to} から返事なし` });
    if (r.event === 'answer_use') lines.push({ ts: r.ts, text: `${who} [教わったことを${r.used ? `使った(${r.how})` : '使わなかった'}] ${r.from} から: ${r.key}` });
  }
  lines.sort((a, b) => (a.ts < b.ts ? -1 : 1));
  return lines.slice(0, n).map((l) => `[${hhmmss(l.ts)}] ${l.text}`);
}

function main() {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith('--'));
  if (!target) { console.error('usage: node tools/summarize_run.js <runs/<時刻>/ | run.jsonl> [--excerpt N] [--text]'); process.exit(2); }
  const ei = args.indexOf('--excerpt');
  const nEx = ei >= 0 ? Number(args[ei + 1]) : 40;
  const isDir = fs.statSync(target).isDirectory();
  const files = isDir ? fs.readdirSync(target).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(target, f)) : [target];
  const runJson = isDir && fs.existsSync(path.join(target, 'run.json')) ? JSON.parse(fs.readFileSync(path.join(target, 'run.json'), 'utf8')) : null;

  const all = [];
  const agents = [];
  for (const f of files) {
    const rows = readJsonl(f);
    const s = summarizeAgent(f, rows);
    agents.push(s);
    for (const r of rows) all.push({ ...r, _name: s.name });
  }
  const loops = all.filter((r) => r.loop && r.action);
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
      calls: jev.calls, inputTokens: jev.inputTokens, inputTokensPerDecision: jev.calls ? Math.round(jev.inputTokens / jev.calls) : 0,
      estimatedCalls: jev.estimatedCalls, costUsd: jev.costUsd ?? Number(((jev.inputTokens / 1e6) * JEV_USD_PER_MTOK).toFixed(6)),
      avgMs: jev.avgMs, rateLimited: jev.rateLimited, retries: jev.retries, errors: jev.errors ?? null, exceeded: jev.exceeded ?? null,
    },
    perAgent: agents,
    conversation: conversation(all, nEx),
  };
  console.log(JSON.stringify(out, null, 2));
  if (args.includes('--text')) {
    console.log('\n--- 週次報告用 ---');
    console.log(`人数 ${out.agents} / 判断 ${out.decisions.count} 回 (1人 ${out.decisions.perAgent} 回、判断の時間 p50 ${out.decisions.decideMs.p50}ms・p95 ${out.decisions.decideMs.p95}ms、実行 ${out.decisions.wallMinutes} 分)`);
    console.log(`目標の達成 ${out.goal.reached}/${out.agents} 人 (夜までに ${out.goal.beforeNight})、小屋 ${hutEnd == null ? '不明' : Math.round(hutEnd * 100) + '%'}、食べ物 合計 ${foodEnd} 個`);
    console.log(`周りに聞いた ${out.ask.asked} 回 (返事 ${out.ask.replied}・知っていた ${out.ask.answeredKnown}・使った ${out.ask.used})`);
    const nc = (k) => sum(agents.map((a) => (a.noChange ? a.noChange[k] : 0)));
    const acts = (n) => sum(agents.map((a) => (a.actions[n] ? a.actions[n].n : 0)));
    const actsOk = (n) => sum(agents.map((a) => (a.actions[n] ? a.actions[n].ok : 0)));
    console.log(`状態が変わらなかった行動 ${nc('unchanged')} 回 (うち成功扱い ${nc('unchangedOk')})、困っていた判断 ${nc('troubledLoops')} 回 (失敗の繰り返し ${nc('troubledFail')}・変わらない繰り返し ${nc('troubledNoChange')})、重みで選び直し ${nc('reweightChanged')}/${nc('reweighted')} 回、同じ行動の連続 最長 ${maxOf(agents.map((a) => a.noChange.maxSameInRow))} 回`);
    console.log(`pillar ${acts('pillar')} 回 (成功 ${actsOk('pillar')})、pick_up ${acts('pick_up')} 回 (成功 ${actsOk('pick_up')})、go_to ${acts('go_to')} 回 (成功 ${actsOk('go_to')})`);
    console.log(`2B の呼び出し ${out.twoB.calls} 回 (平均 ${out.twoB.avgPromptChars} 文字)`);
    console.log(`Jev 入力 ${out.jev.inputTokens} トークン (1判断 ${out.jev.inputTokensPerDecision})、推定 $${out.jev.costUsd} (100万トークン $${JEV_USD_PER_MTOK})`);
  }
}

main();
