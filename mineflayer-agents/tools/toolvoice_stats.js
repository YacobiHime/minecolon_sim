#!/usr/bin/env node
'use strict';
// 道具の不満と声の集計 (toolwant.js・division.js の物単位の刺激・anticipate.js の先の道具切れの記録から)。
//   node tools/toolvoice_stats.js runs/<時刻>/ [--bins 6] [--json]
//   1. 不満の推移: 毎判断の toolWant.d (いちばん大きい物の不満) の区切りごとの平均・人ごとの平均と最大
//   2. 声: 独り言・近くの人に頼む・全体に頼む の数 (形ごと・人ごと)、性格 (5つ) との相関 (人ごとの 頼んだ割合・独り言の数)
//   3. 頼みごとから: 頼んだ人がその物 (同じ種類で同じ段以上) をもらった (received)・手に入れた (tool_want satisfied)・
//      ほかの人がその物を作った (craft)・渡した (give) までの時間 (秒・判断の数)
//   4. 道具が壊れた回数 (自分・見た)、作業が止まった時間 (壊れてから同じ種類の道具をまた持つまで: tool_back)
//   5. 共有のチェストの道具の数の推移 (毎判断の division.stock の、区切りごとの最大)
const { readRun } = require('./division_stats');
const F = require('../src/toolfacts');

const isStep = (r) => !!(r && r.loop && r.action && !r.event && r.result);
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const ts = (r) => (r && r.ts ? Date.parse(r.ts) : null);
const TRAITS = ['bravery', 'empathy', 'obedience', 'greed', 'sociability'];

function pearson(xs, ys) {
  const n = xs.length; if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n; const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0; let sx = 0; let sy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sx += (xs[i] - mx) ** 2; sy += (ys[i] - my) ** 2; }
  return sx && sy ? r2(sxy / Math.sqrt(sx * sy)) : null;
}
function stat(xs) {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return { n: 0 };
  return { n: v.length, p50: r2(v[Math.floor(v.length / 2)]), mean: r2(v.reduce((a, b) => a + b, 0) / v.length), max: r2(v[v.length - 1]) };
}
// 物 got が、欲しかった物 want を満たすか (同じ種類で同じ段以上)
function fits(got, want) {
  if (got === want) return true;
  const g = F.toolInfo(got); const w = F.toolInfo(want);
  return !!(g && w && g.type === w.type && F.rank(g.mat) >= F.rank(w.mat));
}

function toolVoiceStats(all, { bins = 6 } = {}) {
  const steps = all.filter(isStep);
  const voices = all.filter((r) => r.event === 'tool_voice');
  const wantEv = all.filter((r) => r.event === 'tool_want');
  const breaks = all.filter((r) => r.event === 'tool_break');
  const backs = all.filter((r) => r.event === 'tool_back');
  const withTW = steps.filter((r) => r.toolWant);
  if (!withTW.length && !voices.length && !breaks.length) return null;
  const tAll = [...steps, ...voices].map(ts).filter(Number.isFinite);
  const t0 = Math.min(...tAll); const t1 = Math.max(...tAll);
  const binOf = (r) => { const t = ts(r); if (!Number.isFinite(t) || t1 <= t0) return 0; return Math.min(bins - 1, Math.floor(((t - t0) / (t1 - t0)) * bins)); };
  const minutes = (b) => (Number.isFinite(t0) ? [Math.round(((t1 - t0) * b) / bins / 60000), Math.round(((t1 - t0) * (b + 1)) / bins / 60000)] : null);
  const names = [...new Set(all.map((r) => r._name))];
  const temper = Object.fromEntries(names.map((n) => { const s = all.find((r) => r._name === n && r.event === 'start'); return [n, (s && s.persona && s.persona.temperament) || null]; }));

  // 1. 不満の推移
  const timeline = [];
  for (let b = 0; b < bins; b++) {
    const rs = withTW.filter((r) => binOf(r) === b);
    const tops = {};
    for (const r of rs) if (r.toolWant.top) tops[r.toolWant.top] = (tops[r.toolWant.top] || 0) + 1;
    timeline.push({ bin: b, minutes: minutes(b), n: rs.length, meanD: rs.length ? r2(rs.reduce((t, r) => t + (r.toolWant.d || 0), 0) / rs.length) : 0,
      withWant: rs.filter((r) => r.toolWant.d > 0).length, tops });
  }
  const perAgentD = Object.fromEntries(names.map((n) => { const rs = withTW.filter((r) => r._name === n); return [n, { mean: rs.length ? r2(rs.reduce((t, r) => t + (r.toolWant.d || 0), 0) / rs.length) : 0, max: r2(Math.max(0, ...rs.map((r) => r.toolWant.d || 0))) }]; }));
  const wantAdds = {};
  for (const e of wantEv) wantAdds[e.kind] = (wantAdds[e.kind] || 0) + 1;

  // 2. 声
  const said = voices.filter((v) => v.say);
  const byForm = { mutter: 0, near: 0, all: 0 };
  const perAgent = {};
  for (const v of said) { byForm[v.form] = (byForm[v.form] || 0) + 1; const a = perAgent[v._name] || (perAgent[v._name] = { mutter: 0, near: 0, all: 0 }); a[v.form] += 1; }
  const allSteps = Object.fromEntries(names.map((n) => [n, steps.filter((r) => r._name === n).length]));
  const corr = {};
  const rows = names.filter((n) => temper[n] && allSteps[n]);
  for (const k of TRAITS) {
    const xs = rows.map((n) => temper[n][k] ?? 0.5);
    const req = rows.map((n) => { const a = perAgent[n] || { mutter: 0, near: 0, all: 0 }; const tot = a.mutter + a.near + a.all; return tot ? (a.near + a.all) / tot : 0; });
    const mut = rows.map((n) => ((perAgent[n] || {}).mutter || 0) / allSteps[n]);
    const voiced = rows.map((n) => { const a = perAgent[n] || { mutter: 0, near: 0, all: 0 }; return (a.mutter + a.near + a.all) / allSteps[n]; });
    corr[k] = { requestShare: pearson(xs, req), mutterPerStep: pearson(xs, mut), voicesPerStep: pearson(xs, voiced) };
  }
  // 声にした時の不満の大きさ (形ごと)
  const dAt = Object.fromEntries(['mutter', 'near', 'all'].map((f) => [f, stat(said.filter((v) => v.form === f).map((v) => v.d))]));

  // 3. 頼みごとから
  const requests = said.filter((v) => v.form === 'near' || v.form === 'all');
  const crafts = steps.filter((r) => r.action === 'craft' && r.result && r.result.ok);
  const gives = steps.filter((r) => r.action === 'give' && r.result && r.result.ok && r.result.gave);
  const received = all.filter((r) => r.event === 'received');
  const satisfied = wantEv.filter((e) => e.kind === 'satisfied');
  const lat = { received: [], satisfied: [], craftedByOther: [], givenByOther: [] };
  const ex = [];
  for (const q of requests) {
    const t = ts(q); const who = q._name; const item = q.item;
    const first = (xs, f) => xs.filter((r) => ts(r) >= t && f(r)).sort((a, b) => ts(a) - ts(b))[0];
    const rc = first(received, (r) => r._name === who && fits(r.item, item));
    const sf = first(satisfied, (r) => r._name === who && r.item === item);
    const cr = first(crafts, (r) => r._name !== who && fits(String(r.arg || '').split(':')[0], item));
    const gv = first(gives, (r) => r._name !== who && r.result.gave.to === who && fits(r.result.gave.item, item));
    const sec = (r) => (r ? Math.round((ts(r) - t) / 1000) : null);
    if (rc) lat.received.push(sec(rc)); if (sf) lat.satisfied.push(sec(sf)); if (cr) lat.craftedByOther.push(sec(cr)); if (gv) lat.givenByOther.push(sec(gv));
    if (ex.length < 10) ex.push(`${who} (${q.form}) ${item}「${q.say}」 → ${[rc ? `もらった ${sec(rc)}秒 (${rc.from})` : '', sf ? `手に入れた ${sec(sf)}秒` : '', cr ? `${cr._name}が作った ${sec(cr)}秒` : '', gv ? `${gv._name}が渡した ${sec(gv)}秒` : ''].filter(Boolean).join('・') || 'まだ'}`);
  }

  // 4. 壊れた・止まった時間
  const selfBreaks = breaks.filter((b) => b.how === 'self');
  const brokeBy = {};
  for (const b of selfBreaks) brokeBy[b._name] = (brokeBy[b._name] || 0) + 1;
  const down = { sec: stat(backs.map((b) => b.ms / 1000)), ticks: stat(backs.map((b) => b.ticks)), notBack: Math.max(0, selfBreaks.length - backs.length) };

  // 5. 共有のチェストの道具の数の推移
  const stock = [];
  for (let b = 0; b < bins; b++) {
    const rs = steps.filter((r) => binOf(r) === b && r.division && r.division.stock);
    const m = {};
    for (const r of rs) for (const [type, v] of Object.entries(r.division.stock)) { const x = m[type] || (m[type] = { stock: 0, users: 0 }); x.stock = Math.max(x.stock, v.stock); x.users = Math.max(x.users, v.users); }
    stock.push({ bin: b, minutes: minutes(b), ...m });
  }
  // 先の道具切れ (needs の ant.tool)
  const antTool = steps.map((r) => r.social && r.social.needs && r.social.needs.ant ? r.social.needs.ant.tool : null).filter(Number.isFinite);

  return {
    want: { timeline, perAgent: perAgentD, adds: wantAdds },
    voices: { n: said.length, tried: voices.length, byForm, perAgent, corr, dAt, examples: said.slice(0, 12).map((v) => `${v._name} [${v.form}] ${v.item} d=${v.d}: 「${v.say}」`) },
    requests: { n: requests.length, received: stat(lat.received), satisfied: stat(lat.satisfied), craftedByOther: stat(lat.craftedByOther), givenByOther: stat(lat.givenByOther), examples: ex },
    breaks: { self: selfBreaks.length, seen: breaks.filter((b) => b.how === 'seen').length, perAgent: brokeBy, byTool: selfBreaks.reduce((m, b) => { m[b.tool] = (m[b.tool] || 0) + 1; return m; }, {}), down },
    stock,
    anticipate: { steps: antTool.length, mean: stat(antTool).mean ?? null, over05: antTool.filter((v) => v >= 0.5).length },
  };
}

function textLines(d) {
  if (!d) return ['道具の不満と声: 記録なし'];
  const out = [];
  out.push(`道具の不満: 推移 (平均 d) ${d.want.timeline.map((t) => `${t.minutes ? `${t.minutes[0]}-${t.minutes[1]}分` : t.bin} ${t.meanD}`).join('・')}、増えた理由 ${JSON.stringify(d.want.adds)}`);
  out.push(`  人ごと (平均/最大): ${Object.entries(d.want.perAgent).map(([n, v]) => `${n} ${v.mean}/${v.max}`).join(' ')}`);
  out.push(`声 ${d.voices.n} 回 (書かせた ${d.voices.tried}): 独り言 ${d.voices.byForm.mutter}・近くに頼む ${d.voices.byForm.near}・全体に頼む ${d.voices.byForm.all}、声にした時の不満 ${JSON.stringify(d.voices.dAt)}`);
  out.push(`  人ごと: ${Object.entries(d.voices.perAgent).map(([n, v]) => `${n} 独${v.mutter}/近${v.near}/全${v.all}`).join(' ')}`);
  out.push(`  性格との相関 (頼んだ割合 / 独り言の率 / 声の率): ${Object.entries(d.voices.corr).map(([k, v]) => `${k} ${v.requestShare}/${v.mutterPerStep}/${v.voicesPerStep}`).join('・')}`);
  for (const l of d.voices.examples.slice(0, 6)) out.push(`  ${l}`);
  const q = d.requests;
  out.push(`頼みごと ${q.n} 回 → もらった ${q.received.n} (p50 ${q.received.p50}秒)・手に入れた ${q.satisfied.n} (p50 ${q.satisfied.p50}秒)・ほかの人が作った ${q.craftedByOther.n} (p50 ${q.craftedByOther.p50}秒)・渡した ${q.givenByOther.n} (p50 ${q.givenByOther.p50}秒)`);
  for (const l of q.examples.slice(0, 5)) out.push(`  ${l}`);
  out.push(`道具が壊れた ${d.breaks.self} 回 (見た ${d.breaks.seen}) ${JSON.stringify(d.breaks.byTool)}、止まった時間 p50 ${d.breaks.down.sec.p50}秒・平均 ${d.breaks.down.sec.mean}秒 (判断 p50 ${d.breaks.down.ticks.p50})、戻らないまま ${d.breaks.down.notBack}`);
  out.push(`共有のチェストの道具: ${d.stock.map((s) => `${s.minutes ? `${s.minutes[0]}-${s.minutes[1]}分` : s.bin} ${['pickaxe', 'axe', 'shovel', 'hoe'].filter((k) => s[k]).map((k) => `${k} ${s[k].stock}(使う人${s[k].users})`).join(',') || '-'}`).join('・')}`);
  out.push(`先の道具切れ: 判断 ${d.anticipate.steps} 回で平均 ${d.anticipate.mean}、0.5 以上 ${d.anticipate.over05} 回`);
  return out;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith('--'));
  const bi = args.indexOf('--bins');
  const d = toolVoiceStats(readRun(target), { bins: bi >= 0 ? Number(args[bi + 1]) : 6 });
  if (args.includes('--json')) console.log(JSON.stringify(d, null, 2)); else console.log(textLines(d).join('\n'));
}

module.exports = { toolVoiceStats, textLines, pearson, fits };
