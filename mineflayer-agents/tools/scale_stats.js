'use strict';
// 人数が多い実行 (20人) 向けの集計。summarize_run.js から使う。
//   clusterStats   : 集まり (near m 以内でつながった人のまとまり) の数と大きさの推移
//   relationMatrix : 関係の行列 (相手への好感の、初期値 50 からの変化)
//   intervalStats  : 判断の間隔 (同じ人の続けての判断の時刻の差)
//   briefPerAgent  : 人ごとの短い要約 (1人1行)
//   monitorStats   : run.js の monitor*.jsonl (CPU・メモリ・イベントループの遅れ・2B の待ち・Jev の 429) のまとめ
const fs = require('fs');
const path = require('path');

function pct(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
const isStep = (r) => !!(r && r.loop && r.action && !r.event && r.result);
const ms = (ts) => new Date(ts).getTime();

// 位置の組 [[name, pos], ...] を near 以内の辺でつなぎ、まとまり (名前の配列) に分ける。1人だけのまとまりも返す
function clustersOf(ent, near) {
  const parent = ent.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < ent.length; i++) {
    for (let j = i + 1; j < ent.length; j++) {
      const a = ent[i][1]; const b = ent[j][1];
      if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= near) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  ent.forEach(([name], i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(name); });
  return [...groups.values()].map((g) => g.sort()).sort((x, y) => y.length - x.length || x[0].localeCompare(y[0]));
}

// bucketSec ごとに、その時間の各人の位置 (最後の行) で集まりを作る。
// timeline: { min, people, groups (2人以上のまとまりの数), sizes (大きい順), alone (1人の人数), largest }
// perAgent: 2人以上のまとまりに居た割合・一緒に居た回数の多い相手
function clusterStats(all, { near = 16, bucketSec = 60 } = {}) {
  const loops = all.filter((r) => isStep(r) && r.pos && r.ts);
  if (!loops.length) return { near, bucketSec, timeline: [], perAgent: {}, summary: null };
  const t0 = Math.min(...loops.map((r) => ms(r.ts)));
  const byBucket = new Map();
  for (const r of loops) {
    const b = Math.floor((ms(r.ts) - t0) / (bucketSec * 1000));
    if (!byBucket.has(b)) byBucket.set(b, new Map());
    byBucket.get(b).set(r._name, r.pos);
  }
  const timeline = [];
  const per = {};
  for (const b of [...byBucket.keys()].sort((x, y) => x - y)) {
    const ent = [...byBucket.get(b).entries()];
    const cl = clustersOf(ent, near);
    const multi = cl.filter((g) => g.length >= 2);
    timeline.push({ min: Math.round((b * bucketSec) / 6) / 10, people: ent.length, groups: multi.length, sizes: multi.map((g) => g.length), alone: cl.length - multi.length, largest: cl.length ? cl[0].length : 0, members: multi });
    for (const g of cl) {
      for (const n of g) {
        const p = (per[n] = per[n] || { buckets: 0, inGroup: 0, with: {} });
        p.buckets += 1;
        if (g.length >= 2) p.inGroup += 1;
        for (const m of g) if (m !== n) p.with[m] = (p.with[m] || 0) + 1;
      }
    }
  }
  const perAgent = Object.fromEntries(Object.entries(per).sort().map(([n, p]) => [n, {
    inGroupShare: Number((p.inGroup / p.buckets).toFixed(2)),
    topWith: Object.entries(p.with).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([m, c]) => `${m}(${c})`),
  }]));
  const gs = timeline.map((t) => t.groups);
  const summary = {
    buckets: timeline.length,
    groupsAvg: Number((gs.reduce((s, x) => s + x, 0) / gs.length).toFixed(2)), groupsMax: Math.max(...gs),
    largestMax: Math.max(...timeline.map((t) => t.largest)), largestP50: pct(timeline.map((t) => t.largest), 50),
    aloneShareAvg: Number((timeline.reduce((s, t) => s + t.alone / Math.max(1, t.people), 0) / timeline.length).toFixed(2)),
  };
  return { near, bucketSec, timeline, perAgent, summary };
}

// 各人の最後の好感: end の social.relations、無ければ最後の判断の social.aff (動いたものだけ)
function finalAffinity(rows) {
  const end = [...rows].reverse().find((r) => r.event === 'end' && r.social && r.social.relations);
  if (end) {
    const out = {};
    for (const [n, r] of Object.entries(end.social.relations)) if (r && Number.isFinite(r.affinity)) out[n] = { affinity: r.affinity, met: !!r.met || !!r.talks };
    return out;
  }
  const last = [...rows].reverse().find((r) => isStep(r) && r.social && r.social.aff);
  return last ? Object.fromEntries(Object.entries(last.social.aff).map(([n, a]) => [n, { affinity: a, met: true }])) : {};
}

// 関係の行列: m[from][to] = 好感の変化 (最後 − 50、整数)。会っていない・動いていない相手は null
function relationMatrix(rowsByName) {
  const names = Object.keys(rowsByName).sort();
  const m = {};
  const pairs = [];
  for (const a of names) {
    const fa = finalAffinity(rowsByName[a]);
    m[a] = {};
    for (const b of names) {
      if (a === b) continue;
      const r = fa[b];
      const d = r ? Math.round(r.affinity - 50) : null;
      m[a][b] = d === 0 && !(r && r.met) ? null : d;
      if (m[a][b] != null && m[a][b] !== 0) pairs.push({ from: a, to: b, delta: m[a][b] });
    }
  }
  pairs.sort((x, y) => y.delta - x.delta);
  const mutual = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const x = m[names[i]][names[j]]; const y = m[names[j]][names[i]];
      if (x != null && y != null && x !== 0 && y !== 0) mutual.push({ pair: `${names[i]}-${names[j]}`, a: x, b: y });
    }
  }
  return {
    names, matrix: m, changed: pairs.length, positive: pairs.filter((p) => p.delta > 0).length, negative: pairs.filter((p) => p.delta < 0).length,
    top: pairs.slice(0, 5), bottom: pairs.filter((p) => p.delta < 0).slice(-5).reverse(), mutual: mutual.sort((x, y) => (y.a + y.b) - (x.a + x.b)).slice(0, 8),
  };
}

// 行列を文字の表にする (列の見出しは名前の先頭3文字。値は変化、会っていない所は「.」)
function matrixText(rm) {
  const { names, matrix } = rm;
  const ab = (n) => n.slice(0, 3).padStart(4);
  const lines = [`${''.padEnd(7)}${names.map(ab).join('')}`];
  for (const a of names) lines.push(`${a.slice(0, 6).padEnd(7)}${names.map((b) => (a === b ? '   -' : matrix[a][b] == null ? '   .' : String(matrix[a][b] > 0 ? `+${matrix[a][b]}` : matrix[a][b]).padStart(4))).join('')}`);
  return lines;
}

// 判断の間隔 (秒): 同じ人の続けての判断の ts の差。全員と人ごとの中央値
function intervalStats(rowsByName) {
  const allGaps = [];
  const perAgent = {};
  for (const [n, rows] of Object.entries(rowsByName)) {
    const t = rows.filter((r) => isStep(r) && r.ts).map((r) => ms(r.ts)).sort((a, b) => a - b);
    const g = [];
    for (let i = 1; i < t.length; i++) g.push((t[i] - t[i - 1]) / 1000);
    allGaps.push(...g);
    perAgent[n] = g.length ? Number(pct(g, 50).toFixed(1)) : null;
  }
  const r1 = (x) => (x == null ? null : Number(x.toFixed(1)));
  return { p50: r1(pct(allGaps, 50)), p95: r1(pct(allGaps, 95)), max: r1(allGaps.length ? Math.max(...allGaps) : null), perAgent };
}

// 人ごとの短い要約 (1行): 判断の数・成功の割合・多かった行動・死んだ回数・集まりに居た割合・最後の持ち物の多いもの
function briefPerAgent(agents, { clusters = null, deathsPerAgent = {}, intervals = null } = {}) {
  return agents.map((a) => {
    const top = Object.entries(a.actions || {}).sort((x, y) => y[1].n - x[1].n).slice(0, 3).map(([k, v]) => `${k}${v.n}`).join(' ');
    const inv = ((a.end && a.end.inventory) || []).slice().sort((x, y) => y.count - x.count).slice(0, 3).map((i) => `${i.name}x${i.count}`).join(' ');
    const c = clusters && clusters.perAgent[a.name];
    const okPct = a.loops ? Math.round((a.success / a.loops) * 100) : 0;
    return `${a.name}: 判断${a.loops} (間隔${intervals && intervals.perAgent[a.name] != null ? intervals.perAgent[a.name] : '-'}s, 成功${okPct}%) ${top}` +
      ` / 死${deathsPerAgent[a.name] || 0} / 集まり${c ? Math.round(c.inGroupShare * 100) : 0}%${c && c.topWith.length ? ` (${c.topWith.join(' ')})` : ''} / 持ち物 ${inv || 'なし'}`;
  });
}

// run.js の monitor*.jsonl のまとめ (プロセスごと)
function monitorStats(dir) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^monitor(-\d+)?\.jsonl$/.test(f)); } catch (_) { return null; }
  if (!files.length) return null;
  const out = {};
  for (const f of files.sort()) {
    const rows = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    if (!rows.length) continue;
    const col = (g) => rows.map(g).filter((x) => Number.isFinite(x));
    const mx = (a) => (a.length ? Math.max(...a) : null);
    out[f.replace(/\.jsonl$/, '')] = {
      samples: rows.length,
      cpuPct: { p50: pct(col((r) => r.cpuPct), 50), max: mx(col((r) => r.cpuPct)) },
      rssMb: { max: mx(col((r) => r.rssMb)) },
      loopLagP99: { p50: pct(col((r) => r.loopLag && r.loopLag.p99), 50), max: mx(col((r) => r.loopLag && r.loopLag.max)) },
      bots: { minAlive: Math.min(...col((r) => r.bots && r.bots.alive)), total: rows[rows.length - 1].bots ? rows[rows.length - 1].bots.total : null, disconnects: mx(col((r) => r.bots && r.bots.disconnects)) },
      decisionIntervalSec: { p50: pct(col((r) => r.decisions && r.decisions.intervalSec), 50) },
      twoBWaitP95: { p50: pct(col((r) => r.twoB && r.twoB.waitMs && r.twoB.waitMs.p95), 50), max: mx(col((r) => r.twoB && r.twoB.waitMs && r.twoB.waitMs.max)) },
      twoBCalls: col((r) => r.twoB && r.twoB.calls).reduce((s, x) => s + x, 0),
      jevRateLimited: col((r) => r.jev && r.jev.rateLimited).reduce((s, x) => s + x, 0),
    };
  }
  return out;
}

module.exports = { clustersOf, clusterStats, relationMatrix, matrixText, intervalStats, briefPerAgent, monitorStats, finalAffinity };
