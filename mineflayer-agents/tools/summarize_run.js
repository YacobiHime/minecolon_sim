#!/usr/bin/env node
'use strict';
// runs/*.jsonl (1ループ1行) を集計する: node tools/summarize_run.js runs/Taro-....jsonl
const fs = require('fs');

const file = process.argv[2];
if (!file) { console.error('usage: node tools/summarize_run.js <run.jsonl>'); process.exit(2); }
const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const loops = rows.filter((r) => r.loop && r.action);

function pct(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

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
const firstHave = (name) => { const r = loops.find((x) => (x.inventory || []).some((i) => i.name === name || i.name.endsWith(name))); return r ? r.loop : null; };
const t0 = rows[0] && new Date(rows[0].ts);
const out = {
  file,
  loops: loops.length,
  minutes: loops.length ? Math.round((new Date(loops[loops.length - 1].ts) - t0) / 600) / 100 : 0,
  goalAtLoop: goal ? goal.loop : null,
  goalAtMin: goal ? Math.round((new Date(goal.ts) - t0) / 600) / 100 : null,
  milestones: { log: firstHave('_log'), planks: firstHave('_planks'), crafting_table: firstHave('crafting_table'), stick: firstHave('stick'), wooden_pickaxe: firstHave('wooden_pickaxe') },
  actions: byAction,
  success: loops.filter((r) => r.result.ok).length,
  failure: loops.filter((r) => !r.result.ok).length,
  failReasons: Object.fromEntries(Object.entries(failReasons).sort((a, b) => b[1] - a[1]).slice(0, 10)),
  parseFail: loops.filter((r) => !r.parseOk).length,
  repaired: loops.filter((r) => r.repaired).length,
  invalidChoice: loops.filter((r) => !r.valid).length,
  decideMs: { p50: pct(dec, 50), p95: pct(dec, 95), max: Math.max(...dec) },
  promptTokens: { p50: pct(ptok, 50), p95: pct(ptok, 95), max: Math.max(...ptok) },
  promptChars: { p50: pct(pch, 50), max: Math.max(...pch) },
  says: loops.filter((r) => r.say).map((r) => `#${r.loop} ${r.say}`),
};
console.log(JSON.stringify(out, null, 2));
