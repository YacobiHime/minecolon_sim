#!/usr/bin/env node
'use strict';
// 動き方の集計 (2026-11-07 ユーザー決定 5): 行動の割合 (前の記録と比べられる分類)・search の距離と見つけた物・割り込みの回数と理由・
// 割り込みのあと寄り道した/そのまま進んだ・集まり (近くに人がいなかった判断の割合)・踏破したマス (全体・人ごと)・選択肢の重みで選び直した回数。
//   node tools/search_stats.js runs/<時刻>/ [--json]
// summarize_run.js からも使う (out.movement)。前の記録 (nearPeople の無いもの) は、観察の文の「プレイヤーX ...(Nm)」から近くの人の数を数える。
const fs = require('fs');
const path = require('path');

const isStep = (r) => !!(r && r.loop && r.action && !r.event && r.result);
const r1 = (x) => Math.round(x * 10) / 10;
function pct(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

// 行動の分類 (前の記録と同じ物差し)
const MAKE = new Set(['collect', 'craft', 'use_on', 'use_item', 'place', 'smelt', 'pillar', 'pick_up', 'build', 'furnace_take', 'chest_put', 'chest_take', 'enclose', 'lure', 'attack', 'hunt', 'eat', 'equip']);
// fallback: 選び方が無効で代わりにした行動 (valid=false)。選んだ search・explore に混ぜない
// wait: 待つ (look_around の無い設定ではここに来る)。look_around は前の記録用に残す
function category(r, names) {
  const a = r.action; const arg = String(r.arg || '');
  if (r.valid === false) return 'fallback';
  if (a === 'go_to') return names.has(arg) ? 'go_to_person' : /^M\d+$/.test(arg) ? 'go_to_place' : 'go_to_thing';
  if (a === 'follow') return 'follow';
  if (a === 'explore' || a === 'search' || a === 'look_around') return a;
  if (a === 'wait') return 'wait';
  if (MAKE.has(a)) return 'make_use';
  if (['say', 'ask', 'call', 'broadcast', 'propose', 'report_find', 'give', 'share_chest'].includes(a)) return 'talk_social';
  return 'other';
}

// 近くの人の数 (16m 以内)。nearPeople が無い前の記録は観察の文から
function near16(r) {
  if (r.nearPeople && Number.isFinite(r.nearPeople.n16)) return r.nearPeople.n16;
  const m = String(r.obs || '').match(/近くの人・生き物・落ちている物: (.*)/);
  if (!m) return 0;
  let n = 0;
  for (const x of m[1].matchAll(/プレイヤー\S+? \S*?\((\d+)m\)/g)) if (Number(x[1]) <= 16) n += 1;
  return n;
}

function movementStats(all, { names = null, cell = 16 } = {}) {
  const loops = all.filter(isStep);
  const nm = names ? new Set(names) : new Set(all.map((r) => r._name).filter(Boolean));
  const n = loops.length;
  const cat = {};
  for (const r of loops) { const k = category(r, nm); cat[k] = (cat[k] || 0) + 1; }
  const share = Object.fromEntries(Object.entries(cat).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, { n: v, pct: n ? r1((100 * v) / n) : 0 }]));
  // 選べなかったときに代わりにした行動の内訳 (search・explore・wait・look_around)
  const fallbackBy = {};
  for (const r of loops) if (r.valid === false) fallbackBy[r.action] = (fallbackBy[r.action] || 0) + 1;
  const personPct = n ? r1((100 * ((cat.go_to_person || 0) + (cat.follow || 0))) / n) : 0;
  // search
  const se = loops.filter((r) => r.action === 'search');
  const sr = se.map((r) => r.result.search).filter(Boolean);
  const moved = sr.map((s) => s.moved).filter(Number.isFinite);
  const inter = sr.filter((s) => s.interrupt);
  const byKind = {};
  for (const s of inter) byKind[s.interrupt.kind] = (byKind[s.interrupt.kind] || 0) + 1;
  const found = {};
  for (const s of inter.filter((x) => x.interrupt.kind === 'goal')) found[s.interrupt.what] = (found[s.interrupt.what] || 0) + 1;
  const after = loops.map((r) => r.searchAfter).filter(Boolean);
  const afterBy = {};
  for (const a of after) { afterBy[a.choice] = (afterBy[a.choice] || 0) + 1; }
  const afterByKind = {};
  for (const a of after) { afterByKind[a.interrupt] = afterByKind[a.interrupt] || {}; afterByKind[a.interrupt][a.choice] = (afterByKind[a.interrupt][a.choice] || 0) + 1; }
  const offered = loops.filter((r) => r.searchOffer).length;
  // 集まり: 16m 以内に人がいなかった判断の割合 (全体・人ごと)
  const alone = loops.filter((r) => near16(r) === 0).length;
  const perAgent = {};
  for (const r of loops) {
    const k = r._name || '?';
    const p = perAgent[k] || (perAgent[k] = { n: 0, alone: 0, cells: new Set(), search: 0, searchMoved: 0, person: 0 });
    p.n += 1;
    if (near16(r) === 0) p.alone += 1;
    if (r.pos) p.cells.add(`${Math.floor(r.pos.x / cell)},${Math.floor(r.pos.z / cell)}`);
    if (r.action === 'search') { p.search += 1; p.searchMoved += (r.result.search && r.result.search.moved) || 0; }
    const c = category(r, nm);
    if (c === 'go_to_person' || c === 'follow') p.person += 1;
  }
  const allCells = new Set();
  for (const p of Object.values(perAgent)) for (const c of p.cells) allCells.add(c);
  // 選択肢の重みで選び直した
  const rw = loops.map((r) => r.jev && r.jev.reweight).filter((x) => x && x.choiceWeights);
  return {
    decisions: n,
    share, goToPersonPlusFollowPct: personPct, fallbackBy,
    search: {
      offered, n: se.length, ok: se.filter((r) => r.result.ok).length,
      moved: { sum: moved.reduce((a, b) => a + b, 0), p50: pct(moved, 50), max: moved.length ? Math.max(...moved) : null },
      newCell: sr.filter((s) => s.newCell).length,
      interrupted: inter.length, byKind, found, placesNoted: sr.filter((s) => s.place).length,
      continued: sr.filter((s) => s.continued).length,
      after: afterBy, afterByKind,
    },
    alonePct: n ? r1((100 * alone) / n) : 0,
    cells: { total: allCells.size, cell },
    perAgent: Object.fromEntries(Object.entries(perAgent).sort().map(([k, p]) => [k, { n: p.n, alonePct: r1((100 * p.alone) / p.n), cells: p.cells.size, search: p.search, searchMoved: p.searchMoved, personPct: r1((100 * p.person) / p.n) }])),
    reweight: { byChoiceWeights: rw.length, changed: rw.filter((x) => x.changed).length },
  };
}

function lines(m) {
  if (!m) return [];
  const s = m.search;
  const sh = Object.entries(m.share).map(([k, v]) => `${k} ${v.pct}%`).join('・');
  return [
    `行動の割合 (${m.decisions} 判断): ${sh} (go_to(人)+follow ${m.goToPersonPlusFollowPct}%)${m.fallbackBy && Object.keys(m.fallbackBy).length ? `、選べなかったときの代わり ${Object.entries(m.fallbackBy).map(([k, v]) => `${k} ${v}`).join('・')}` : ''}`,
    `search ${s.n} 回 (出した判断 ${s.offered}、成功 ${s.ok}、続き ${s.continued})、歩いた 合計 ${s.moved.sum}m (p50 ${s.moved.p50}・最大 ${s.moved.max})、新しいマス ${s.newCell}、割り込み ${s.interrupted} (${Object.entries(s.byKind).map(([k, v]) => `${k} ${v}`).join('・') || 'なし'})、見つけた ${JSON.stringify(s.found)} (場所として覚えた ${s.placesNoted})`,
    `  割り込みの次の判断: ${Object.entries(s.after).map(([k, v]) => `${k} ${v}`).join('・') || 'なし'} ${JSON.stringify(s.afterByKind)}`,
    `近くに人 (16m) がいなかった判断 ${m.alonePct}%、踏破したマス ${m.cells.total} 個 (${m.cells.cell} 四方)、人ごと: ${Object.entries(m.perAgent).map(([k, v]) => `${k} ${v.cells}マス・1人${v.alonePct}%・人へ${v.personPct}%`).join(' / ')}`,
    `選択肢の重みを掛けた判断 ${m.reweight.byChoiceWeights} (選び直した ${m.reweight.changed})`,
  ];
}

function readRun(target) {
  const files = fs.statSync(target).isDirectory() ? fs.readdirSync(target).filter((f) => f.endsWith('.jsonl') && !/^monitor(-\d+)?\.jsonl$/.test(f)).map((f) => path.join(target, f)) : [target];
  const all = [];
  for (const f of files) {
    const name = path.basename(f).split('-')[0];
    for (const l of fs.readFileSync(f, 'utf8').split('\n')) { if (!l) continue; try { all.push({ ...JSON.parse(l), _name: name }); } catch (_) { /* skip */ } }
  }
  return all;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith('--'));
  if (!target) { console.error('usage: node tools/search_stats.js runs/<時刻>/ [--json]'); process.exit(2); }
  const m = movementStats(readRun(target));
  if (args.includes('--json')) console.log(JSON.stringify(m, null, 2)); else for (const l of lines(m)) console.log(l);
}

module.exports = { movementStats, lines, category, near16, readRun };
