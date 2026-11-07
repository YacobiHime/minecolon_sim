#!/usr/bin/env node
'use strict';
// 選択肢の重み (choice_weight.js) と search の候補で、go_to(人)・follow の割合がどれだけ変わるかを、記録の場面で確かめる (本番ではない短い確認)。
//   node tools/weight_check.js runs/<時刻>/ [--scenes 80] [--only person] [--config configs/survival_3days.json] [--people 0.4] [--memPlace 0.7] [--json]
// 場面は記録から等間隔に選び、jev_state_compare.js の sceneContext で ctx を作り直す (記録には生の観測が無いので近似)。
// 1場面につき Jev を 2 回呼ぶ: (A) 前と同じ行動の一覧、(B) A に search (道筋に要る物が見えていないとき) を足した一覧。
// それぞれ Jev の確率から、重みなしの一番と、重みを掛けた一番を数える。下げない人: ゴールの人・その場面で自分を呼んだ/頼んだ/誘った人 (choice_weight.isCalled)。
// キーは表示しない (JevClient が /root/.config/openrouter.env から読む)。
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../src/config');
const { actionOptions, buildState, buildQuestions } = require('../src/deciders/jev');
const { JevClient } = require('../src/jev_client');
const cw = require('../src/choice_weight');
const search = require('../src/search');
const { sceneContext } = require('./jev_state_compare');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const runDir = args.find((a) => !a.startsWith('--') && fs.existsSync(a) && fs.statSync(a).isDirectory());
if (!runDir) { console.error('usage: node tools/weight_check.js runs/<時刻>/ [--scenes 80]'); process.exit(2); }
const nScenes = Number(opt('--scenes', 80));
const cfgFile = opt('--config', path.join(__dirname, '..', 'configs', 'survival_3days.json'));

function kindOf(key, names) {
  const [a, arg] = [key.split(':')[0], key.slice(key.indexOf(':') + 1)];
  if (a === 'follow') return 'person';
  if (a === 'go_to') return names.has(arg) ? 'person' : /^M\d+$/.test(arg) ? 'place' : 'thing';
  return a;
}
const argmax = (p) => Object.entries(p).reduce((a, b) => (b[1] > a[1] ? b : a))[0];

async function main() {
  const base = loadConfig(cfgFile, {});
  const wcfg = { ...cw.cfgOf(base.choiceWeights), enabled: true, people: Number(opt('--people', (base.choiceWeights || {}).people ?? 0.4)), memPlace: Number(opt('--memPlace', (base.choiceWeights || {}).memPlace ?? 0.7)), called: Number(opt('--called', (base.choiceWeights || {}).called ?? 1)) };
  const scfg = { ...search.cfgOf(base.act && base.act.search), enabled: true };
  const files = fs.readdirSync(runDir).filter((f) => f.endsWith('.jsonl') && !f.startsWith('monitor'));
  const names = new Set(files.map((f) => f.split('-')[0]));
  const scenes = [];
  for (const f of files) {
    const rows = fs.readFileSync(path.join(runDir, f), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const steps = rows.filter((r) => r.loop && r.action && r.result && r.jev && r.obs);
    for (let i = 1; i < steps.length; i++) scenes.push({ file: f, rows, row: steps[i], prev: steps[i - 1] });
  }
  scenes.sort((a, b) => (a.row.ts < b.row.ts ? -1 : 1));
  // --only person: 記録で go_to(人)・follow を選んだ場面だけ (重みの効きを多めの場面で見る)
  if (opt('--only', null) === 'person') scenes.splice(0, scenes.length, ...scenes.filter((x) => x.row.action === 'follow' || (x.row.action === 'go_to' && names.has(x.row.arg))));
  const pick = [];
  for (let i = 0; i < nScenes; i++) pick.push(scenes[Math.floor(((i + 0.5) / nScenes) * scenes.length)]);
  const client = new JevClient(base.decider.jev || {});
  if (!client.hasKey) { console.error('Jev の API キーが無い'); process.exit(2); }
  const out = [];
  let i = 0;
  const one = async (sc) => {
    let built;
    try { built = sceneContext(sc, base, cfgFile); } catch (e) { i += 1; return { scene: `${sc.file} loop ${sc.row.loop}`, skipped: String(e.message).slice(0, 80) }; }
    const { ctx, name, gp } = built;
    const raw = ctx.raw;
    const exempt = new Set();
    if (gp && gp.goal && gp.goal.kind === 'person' && gp.goal.metAt == null) exempt.add(gp.goal.target);
    const called = new Set();
    for (const h of raw.heard || []) if (cw.isCalled(h.text, name)) called.add(h.from);
    const rel = new Set();
    if (gp && gp.path && gp.path.ok) for (const s of [gp.path.next, ...(gp.path.steps || [])]) if (s) for (const k of [s.item, s.from, s.station]) if (k) rel.add(k);
    if (gp && gp.goal && gp.goal.kind === 'item') rel.add(gp.goal.target);
    const rec = sc.row.action === 'go_to' || sc.row.action === 'follow' ? kindOf(`${sc.row.action}:${sc.row.arg}`, names) : sc.row.action;
    const r = { scene: `${name} loop ${sc.row.loop}`, recorded: `${sc.row.action}:${sc.row.arg}`, recordedKind: rec };
    const variant = async (actions) => {
      const o = actionOptions(actions, { lang: 'en' });
      const st = buildState(ctx, { table: o.table, lang: 'en' });
      const q = buildQuestions(ctx, { criteria: o.criteria, hasTable: true, lang: 'en' }).questions;
      const a = await client.ask(st, q);
      const na = a.ok && a.answers && a.answers.next_action;
      if (!na || !na.probabilities) return { error: a.ok ? 'no next_action' : a.error };
      const w = cw.choiceWeights(actions, { exemptPeople: exempt, calledPeople: called, relatedKinds: rel }, wcfg);
      const rw = cw.reweightMult(na.probabilities, w);
      const b = argmax(na.probabilities); const c = rw.choice;
      const pPerson = Object.entries(na.probabilities).filter(([k]) => kindOf(k, names) === 'person').reduce((s, [, p]) => s + p, 0);
      return { base: b, weighted: c, baseKind: kindOf(b, names), weightedKind: kindOf(c, names), pPerson: Math.round(pPerson * 1000) / 1000, pPersonW: Math.round(Object.entries(rw.probs).filter(([k]) => kindOf(k, names) === 'person').reduce((s, [, p]) => s + p, 0) * 1000) / 1000, options: Object.keys(o.criteria).length };
    };
    r.A = await variant(ctx.actions);
    // B: search を足す
    let sa = null;
    if (gp && gp.pathNext()) {
      const visible = new Set([...raw.blocks.map((b) => b.name), ...raw.entities.map((e) => e.name)]);
      const targets = search.searchTargets(gp.path, visible);
      if (targets) sa = search.searchAction({ cfg: scfg, targets, here: raw.self.pos, cells: [], othersCells: new Map(), cellSize: 16, dist: search.searchDistance(0.4, scfg), name });
    }
    r.searchOffered = !!sa;
    r.B = sa ? await variant([...ctx.actions, sa]) : r.A;
    i += 1;
    if (!args.includes('--json')) process.stderr.write(`\r${i}/${pick.length}`);
    return r;
  };
  // 4 本ずつ並べて呼ぶ
  for (let k = 0; k < pick.length; k += 4) out.push(...await Promise.all(pick.slice(k, k + 4).map(one)));
  if (!args.includes('--json')) process.stderr.write('\n');
  const ok = (v) => out.filter((r) => !r.skipped && r[v] && !r[v].error);
  const rate = (rows, v, f) => { const n = rows.length; const k = rows.filter((r) => f(r[v])).length; return { n, k, pct: n ? Math.round((1000 * k) / n) / 10 : null }; };
  const kinds = (rows, v, field) => rows.reduce((m, r) => { const k = r[v][field]; m[k] = (m[k] || 0) + 1; return m; }, {});
  const A = ok('A'); const B = ok('B');
  const summary = {
    scenes: out.length, skipped: out.filter((r) => r.skipped).length, weights: { people: wcfg.people, memPlace: wcfg.memPlace, called: wcfg.called },
    recordedPersonPct: (() => { const u = out.filter((r) => !r.skipped); return u.length ? Math.round((1000 * u.filter((r) => r.recordedKind === 'person').length) / u.length) / 10 : null; })(),
    A: { person: { base: rate(A, 'A', (x) => x.baseKind === 'person'), weighted: rate(A, 'A', (x) => x.weightedKind === 'person') }, place: { base: rate(A, 'A', (x) => x.baseKind === 'place'), weighted: rate(A, 'A', (x) => x.weightedKind === 'place') },
      meanPPerson: { base: avg(A.map((r) => r.A.pPerson)), weighted: avg(A.map((r) => r.A.pPersonW)) }, kindsBase: kinds(A, 'A', 'baseKind'), kindsWeighted: kinds(A, 'A', 'weightedKind') },
    B: { searchOffered: out.filter((r) => r.searchOffered).length, person: { base: rate(B, 'B', (x) => x.baseKind === 'person'), weighted: rate(B, 'B', (x) => x.weightedKind === 'person') },
      search: { base: rate(B, 'B', (x) => x.baseKind === 'search'), weighted: rate(B, 'B', (x) => x.weightedKind === 'search') }, kindsWeighted: kinds(B, 'B', 'weightedKind') },
    errors: out.filter((r) => (r.A && r.A.error) || (r.B && r.B.error)).length,
  };
  console.log(JSON.stringify(args.includes('--json') ? { summary, scenes: out } : summary, null, 2));
}
function avg(a) { return a.length ? Math.round((a.reduce((s, x) => s + x, 0) / a.length) * 1000) / 1000 : null; }

main().catch((e) => { console.error(e); process.exit(1); });
