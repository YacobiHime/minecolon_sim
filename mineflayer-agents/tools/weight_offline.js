#!/usr/bin/env node
'use strict';
// 記録に残った Jev の確率 (各判断の上位3つ。jev.choice.top) に選択肢の重み (choice_weight.js) を掛け直し、選ばれる行動の割合を見積もる (Jev は呼ばない)。
//   node tools/weight_offline.js runs/<時刻>/ [--people 0.4] [--memPlace 0.7] [--called 1] [--exemptTicks 10]
// 下げない人: ゴールがその人 (progress の「ゴール: X に …を渡す / X の近くにいる」)。called を掛ける人: exemptTicks 判断以内に、観察の「今聞こえた話」で
// 自分を呼んだ・頼んだ・誘った人 (choice_weight.isCalled)。noChange の重み (jev.reweight.penalties) も掛ける。
// 限界: 上位3つの外の選択肢は見えない (重みで一番が入れ替わる先が4位以下なら数え違う)。M が道筋に関係するかは見ない (memPlace は全部の M に掛ける)。
const path = require('path');
const { readRun, category } = require('./search_stats');
const { isCalled } = require('../src/choice_weight');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] != null ? Number(args[i + 1]) : d; };
const target = args.find((a) => !a.startsWith('--') && !/^[\d.]+$/.test(a));
if (!target) { console.error('usage: node tools/weight_offline.js runs/<時刻>/ [--people 0.4] [--memPlace 0.7] [--called 1]'); process.exit(2); }

function estimate(all, { people = 0.4, memPlace = 0.7, called = 1, exemptTicks = 10, ncWeight = 0.5 } = {}) {
  const names = new Set(all.map((r) => r._name));
  const rows = all.filter((r) => r.loop && r.action && !r.event && r.result && r.jev && r.jev.choice && r.jev.choice.top);
  const by = {};
  for (const r of rows) (by[r._name] = by[r._name] || []).push(r);
  const kind = (k) => { const a = k.split(':')[0]; return category({ action: a, arg: k.slice(a.length + 1) }, names); };
  const c = {}; let n = 0;
  for (const [me, list] of Object.entries(by)) {
    const calledAt = {};
    for (const r of list.sort((a, b) => a.loop - b.loop)) {
      const h = (String(r.obs).match(/今聞こえた話: (.*)/) || [])[1] || '';
      for (const [, from, text] of h.matchAll(/(\S+?)「(.*?)」/g)) if (isCalled(text, me)) calledAt[from] = r.loop;
      const g = String(r.progress || '').match(/^ゴール: (\S+) (?:に|の近く)/);
      const goalPerson = g && names.has(g[1]) ? g[1] : null;
      const cl = new Set(Object.entries(calledAt).filter(([, t]) => r.loop - t <= exemptTicks).map(([k]) => k));
      const pen = (r.jev.reweight && r.jev.reweight.penalties) || {};
      let best = null; let bp = -1;
      for (const [k, p0] of r.jev.choice.top) {
        const kk = kind(k); const arg = k.slice(k.indexOf(':') + 1);
        let p = p0 * Math.pow(ncWeight, pen[k] || 0);
        if ((kk === 'go_to_person' || kk === 'follow') && arg !== goalPerson) p *= cl.has(arg) ? called : people;
        if (kk === 'go_to_place') p *= memPlace;
        if (p > bp) { bp = p; best = k; }
      }
      const kk = kind(best); c[kk] = (c[kk] || 0) + 1; n += 1;
    }
  }
  const pct = (k) => Math.round((1000 * (c[k] || 0)) / n) / 10;
  return { n, weights: { people, memPlace, called }, pct: Object.fromEntries(Object.keys(c).sort((a, b) => c[b] - c[a]).map((k) => [k, pct(k)])), personPlusFollow: Math.round((pct('go_to_person') + pct('follow')) * 10) / 10 };
}

if (require.main === module) {
  const all = readRun(path.resolve(target));
  const w = { people: opt('--people', 0.4), memPlace: opt('--memPlace', 0.7), called: opt('--called', 1), exemptTicks: opt('--exemptTicks', 10) };
  console.log(JSON.stringify({ before: estimate(all, { people: 1, memPlace: 1, called: 1 }), after: estimate(all, w) }, null, 2));
}

module.exports = { estimate };
