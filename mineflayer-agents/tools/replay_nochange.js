#!/usr/bin/env node
'use strict';
// 実行の記録を読み直して、正味の変化で見る繰り返しの検出 (nochange.netNoChange) がどこで当たるかを出す。
//   node tools/replay_nochange.js runs/<時刻>/ [--json] [--netWindow 10 ...]
// 記録の各行: inventory = 行動の後の持ち物、pos = 行動の前の位置 (行動の後の位置は次の行の pos を使う)。
// 新しいマスは、記録の頭から入ったマスを数えて決める (記憶の忘れは考えない)。
const fs = require('fs');
const path = require('path');
const nochange = require('../src/nochange');

function readRows(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
    .filter((r) => r && r.loop && r.action && !r.event && r.result);
}

// 記録の行 → histEntry の列 (先頭は最初の行の前の状態の代わりに、最初の行の後の状態)
function historyFromRows(rows, { cell = 16 } = {}) {
  const seen = new Set();
  const cellKey = (p) => `${Math.floor(p.x / cell)},${Math.floor(p.z / cell)}`;
  if (rows[0] && rows[0].pos) seen.add(cellKey(rows[0].pos));
  return rows.map((r, i) => {
    const after = (rows[i + 1] && rows[i + 1].pos) || r.pos;
    let newCell = false;
    if (after) { const k = cellKey(after); newCell = !seen.has(k); seen.add(k); }
    return { loop: r.loop, ...nochange.histEntry({ action: r.action, arg: r.arg, inventory: r.inventory, pos: after, newCell, result: r.result }) };
  });
}

// 各ループで検出された key。返り値 [{ loop, keys, scope }]
function replay(rows, opts = {}) {
  const hist = historyFromRows(rows, opts);
  const out = [];
  for (let i = 0; i < hist.length; i++) {
    const r = nochange.netNoChange(hist.slice(0, i + 1), opts);
    if (r.keys.size) out.push({ loop: hist[i].loop, keys: [...r.keys], scope: r.scope });
  }
  return out;
}

// 続いた検出を区間にまとめる
function intervals(hits) {
  const out = [];
  for (const h of hits) {
    const last = out[out.length - 1];
    if (last && h.loop - last.to <= 2) { last.to = h.loop; for (const k of h.keys) last.keys.add(k); last.n += 1; } else out.push({ from: h.loop, to: h.loop, keys: new Set(h.keys), n: 1 });
  }
  return out.map((x) => ({ ...x, keys: [...x.keys] }));
}

function main() {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith('--') && !/^\d/.test(a));
  if (!target) { console.error('usage: node tools/replay_nochange.js <runs/<時刻>/ | x.jsonl> [--json] [--netWindow N]'); process.exit(2); }
  const opts = {};
  for (let i = 0; i < args.length; i++) if (args[i].startsWith('--') && args[i] !== '--json' && args[i + 1] != null) opts[args[i].slice(2)] = Number(args[i + 1]);
  const files = fs.statSync(target).isDirectory() ? fs.readdirSync(target).filter((f) => f.endsWith('.jsonl') && !/^monitor(-\d+)?\.jsonl$/.test(f)).map((f) => path.join(target, f)) : [target];
  const res = {};
  for (const f of files) {
    const rows = readRows(f);
    const name = path.basename(f).split('-')[0];
    res[name] = { loops: rows.length, intervals: intervals(replay(rows, opts)) };
  }
  if (args.includes('--json')) { console.log(JSON.stringify(res, null, 2)); return; }
  for (const [name, r] of Object.entries(res)) {
    console.log(`${name} (${r.loops} 回): 検出 ${r.intervals.length} 区間`);
    for (const iv of r.intervals) console.log(`  loop ${iv.from}〜${iv.to} (${iv.n} 回): ${iv.keys.join(', ')}`);
  }
}

if (require.main === module) main();
module.exports = { readRows, historyFromRows, replay, intervals };
