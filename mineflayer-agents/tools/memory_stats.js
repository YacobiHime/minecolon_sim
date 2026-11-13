#!/usr/bin/env node
'use strict';
// 記憶の引き出しの集計 (src/memory.js の memSelection と answer の記録)。連想あり/なし・失敗のメモあり/なしの比較に使う。
//   node tools/memory_stats.js runs/<時刻>/ [--json]
//   - 選び方 (mode: associative | legacy) ごとの判断の数
//   - 思い出した記憶の内訳: 手がかりの種類別 (place・person・item・goal・next・need・time・heard・expand・must・recency) と線の段数別 (LLM 向けと Jev 向け)
//   - 近くにいる人に関わる記憶が渡った割合 (近くの人のうち、その人に関わる出来事を覚えている人について)
//   - 空振り (覚えた場所に行ったら物が無かった) の回数、失敗のメモを渡した回数
//   - 聞かれて答えられた割合 (「分からない」の割合)、答えに使った記憶の段数
//   - 依頼文の記憶の部分の長さ (LLM の memText の文字数・Jev の memory の JSON の文字数)
const isStep = (r) => !!(r && r.loop && r.action && !r.event && r.result);
const r3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);
const inc = (m, k, n = 1) => { m[k] = (m[k] || 0) + n; return m; };
function pct(arr, p) {
  const a = arr.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
}
const MISS_RE = /はもう無かった/;
const KINDS = ['event', 'heard', 'knowledge', 'owned', 'wronged'];

function selStats(sels) {
  const byCue = {}; const hops = {}; const kinds = {};
  let nearN = 0; let nearRecalled = 0; let notes = 0; let notesLoops = 0;
  const chars = []; const items = [];
  for (const s of sels) {
    for (const [k, n] of Object.entries(s.byCue || {})) inc(byCue, k, n);
    for (const [k, n] of Object.entries(s.hops || {})) inc(hops, k, n);
    let it = 0;
    for (const k of KINDS) if (Number.isFinite(s[k])) { inc(kinds, k, s[k]); it += s[k]; }
    items.push(it);
    if (s.near) { nearN += s.near.n || 0; nearRecalled += s.near.recalled || 0; }
    if (s.note) { notes += s.note; notesLoops += 1; }
    if (Number.isFinite(s.chars)) chars.push(s.chars);
  }
  const total = Object.values(byCue).reduce((a, b) => a + b, 0);
  const share = Object.fromEntries(Object.entries(byCue).map(([k, n]) => [k, r3(total ? n / total : 0)]));
  return {
    loops: sels.length, items: { p50: pct(items, 50), total: items.reduce((a, b) => a + b, 0) }, kinds, byCue, byCueShare: share, hops,
    nearPeople: { n: nearN, recalled: nearRecalled, ratio: nearN ? r3(nearRecalled / nearN) : null },
    notes: { total: notes, loops: notesLoops }, chars: { p50: pct(chars, 50), p90: pct(chars, 90), max: chars.length ? Math.max(...chars) : null },
  };
}

function memoryStats(all) {
  const steps = all.filter(isStep);
  const withSel = steps.filter((s) => s.memSelection);
  const modes = {};
  for (const s of withSel) inc(modes, s.memSelection.mode || 'legacy(old)');
  const llm = selStats(withSel.map((s) => s.memSelection).filter((s) => s.byCue));
  const jev = selStats(withSel.map((s) => s.memSelection.jev).filter(Boolean));
  const memText = steps.map((s) => (typeof s.memText === 'string' ? s.memText.length : null)).filter((x) => x != null);
  const misses = steps.filter((s) => s.result && MISS_RE.test(String(s.result.msg || '')));
  const missBy = {};
  for (const s of misses) inc(missBy, s._name || '?');
  const answers = all.filter((r) => r.event === 'answer');
  const known = answers.filter((r) => r.known).length;
  const answerHops = {}; const answerKinds = {};
  for (const a of answers) for (const m of a.memories || []) { inc(answerHops, m.hop == null ? '-' : String(m.hop)); inc(answerKinds, m.kind || '?'); }
  return {
    modes,
    llm, jev,
    memTextChars: { p50: pct(memText, 50), p90: pct(memText, 90), max: memText.length ? Math.max(...memText) : null },
    misses: { total: misses.length, perStep: r3(steps.length ? misses.length / steps.length : 0), agents: Object.keys(missBy).length },
    answers: { total: answers.length, known, dontKnow: answers.length - known, dontKnowRatio: answers.length ? r3((answers.length - known) / answers.length) : null,
      noMemory: answers.filter((r) => !(r.memories || []).length).length, hops: answerHops, kinds: answerKinds },
  };
}

function textLines(m) {
  const L = [];
  const cue = (s) => Object.entries(s.byCueShare || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join('・');
  L.push(`記憶の選び方: ${Object.entries(m.modes).map(([k, n]) => `${k} ${n}`).join('・') || '記録なし'}`);
  if (m.llm.loops) L.push(`LLM 向け: 1判断 ${m.llm.items.p50} 件、手がかり ${cue(m.llm)}、段数 ${JSON.stringify(m.llm.hops)}、近くの人の記憶が渡った ${m.llm.nearPeople.recalled}/${m.llm.nearPeople.n} (${m.llm.nearPeople.ratio ?? '-'})、失敗のメモ ${m.llm.notes.total} 件、文字数 p50 ${m.llm.chars.p50}・p90 ${m.llm.chars.p90}`);
  if (m.jev.loops) L.push(`Jev 向け: 1判断 ${m.jev.items.p50} 件、手がかり ${cue(m.jev)}、近くの人の記憶が渡った ${m.jev.nearPeople.recalled}/${m.jev.nearPeople.n} (${m.jev.nearPeople.ratio ?? '-'})、文字数 p50 ${m.jev.chars.p50}`);
  L.push(`空振り (覚えた場所に物が無かった) ${m.misses.total} 回 (${m.misses.agents} 人)、答え ${m.answers.total} 回のうち「分からない」${m.answers.dontKnow} (${m.answers.dontKnowRatio ?? '-'})、答えの記憶の段数 ${JSON.stringify(m.answers.hops)}`);
  return L;
}

module.exports = { memoryStats, selStats, textLines };

if (require.main === module) {
  const { readRun } = require('./provenance_stats');
  const target = process.argv[2];
  if (!target) { console.error('usage: node tools/memory_stats.js runs/<時刻>/ [--json]'); process.exit(2); }
  const all = readRun(target);
  const m = memoryStats(all);
  if (process.argv.includes('--json')) console.log(JSON.stringify(m, null, 2));
  else console.log(textLines(m).join('\n'));
}
