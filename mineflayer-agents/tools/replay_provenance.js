#!/usr/bin/env node
'use strict';
// 台帳の無い前の記録 (2026-11-10 の100人など) から、設置物の取得を推定して、新しい集計 (provenance_stats.js) に通す (読むだけ。何も書かない)。
//   node tools/replay_provenance.js runs/<時刻>/ [--json] [--radius 16]
//   1. place の結果の文「torch を (x,y,z) に置いた」から台帳を作る (build・pillar・use_on は位置が記録に無いので入らない)
//   2. collect の成功を、その判断の位置から radius 以内の、台帳で今ある同じ種類の物のうち近いものから「掘った数」だけ取ったと推定する
//      (collect は置かれた物を区別していなかったので、理由は unmodeled。所有を知っていたら新しい規則で何になったか (wouldBe) も付ける)
//   推定なので、本当の取得数とはずれる (台帳に無い物・別の所の物を掘った場合など)。数の確からしさは matched / unmatched で見る。
const fs = require('fs');
const path = require('path');
const { Ledger, sameFamily } = require('../src/provenance');
const O = require('../src/ownership');
const { provenanceStats, lines, readRun } = require('./provenance_stats');

const isStep = (r) => !!(r && r.loop && r.action && !r.event && r.result);
const PLACED_AT = /^([a-z0-9_]+)を\((-?\d+),(-?\d+),(-?\d+)\)に置いた/;
const DUG = /(\d+)個掘って/;
const DIM = 'minecraft:overworld';

function purposeOf(block) {
  return O.LIGHT[block] != null ? 'lighting' : /_bed$/.test(block) ? 'sleeping' : block === 'crafting_table' ? 'crafting' : /^(furnace|smoker)$/.test(block) ? 'cooking' : O.CONTAINER.test(block) ? 'storage' : 'building';
}
// 観察の文の「見えるブロック: a 東3(3m), b ...」から名前
function visibleNames(obs) {
  const m = String(obs || '').match(/見えるブロック: ([^\n]*)/);
  if (!m) return new Set();
  return new Set([...m[1].matchAll(/([a-z0-9_]+)(?:\([^)]*\))? (?:[東西南北上下]|ここ)/g)].map((x) => x[1]));
}

function replay(all, { radius = 16 } = {}) {
  const steps = all.filter(isStep).map((r) => ({ ...r, ms: Date.parse(r.ts) || 0 })).sort((a, b) => a.ms - b.ms);
  const ledger = new Ledger();
  const out = [];
  const seq = {};
  const prevInv = {}; // 人 → 前の判断の後の持ち物 (= この判断の前の持ち物。判断の行の inventory は行動の後)
  const stat = { placesWithPos: 0, placesNoPos: 0, artifactCollects: 0, matched: 0, unmatched: 0, ownMatched: 0, otherMatched: 0 };
  for (const r of steps) {
    const who = r._name;
    const invBefore = prevInv[who] || [];
    prevInv[who] = r.inventory || [];
    if (r.action === 'place' && r.result.ok) {
      const m = String(r.result.msg || '').match(PLACED_AT);
      if (m) {
        stat.placesWithPos += 1;
        ledger.record(who, { ms: r.ms, type: 'place', dim: DIM, pos: [+m[2], +m[3], +m[4]], block: m[1] === 'torch' ? 'torch' : m[1], by: who, action: 'place', purpose: purposeOf(m[1]), ownership: { kind: 'personal', owner: who } });
      } else stat.placesNoPos += 1;
      continue;
    }
    if (r.action !== 'collect' || !r.result.ok || !r.pos) continue;
    const block = r.result.block || r.arg;
    const dug = Number(r.result.dug) || Number((String(r.result.msg || '').match(DUG) || [])[1]) || 0;
    if (!dug) continue;
    if (O.ARTIFACT.test(block)) stat.artifactCollects += dug;
    const cands = ledger.near(DIM, r.pos, radius).filter((e) => (e.status === 'active' || e.status === 'abandoned') && sameFamily(e.block, block))
      .sort((a, b) => Math.hypot(a.position[0] - r.pos.x, a.position[1] - r.pos.y, a.position[2] - r.pos.z) - Math.hypot(b.position[0] - r.pos.x, b.position[1] - r.pos.y, b.position[2] - r.pos.z));
    const took = cands.slice(0, dug);
    if (O.ARTIFACT.test(block)) { stat.matched += took.length; stat.unmatched += dug - took.length; }
    const eff = (r.social && r.social.needs && r.social.needs.eff) || {};
    // 天然と見ていた物: 見えるブロックのうち見た目で人工物でない物 (置かれた松明などは代わりの入手元にしない)
    const vis = new Set([...visibleNames(r.obs)].filter((n) => !O.ARTIFACT.test(n)));
    const inv = invBefore;
    for (const e of took) {
      seq[who] = (seq[who] || 0) + 1;
      const id = `${who}-r${seq[who]}`;
      const own = e.placedBy === who;
      if (own) stat.ownMatched += 1; else stat.otherMatched += 1;
      const tod = ((r.timeOfDay ?? 6000) % 24000 + 24000) % 24000;
      const pos = { x: e.position[0], y: e.position[1], z: e.position[2] };
      const otherLight = ledger.near(DIM, pos, 7).some((q) => q !== e && q.status === 'active' && O.LIGHT[q.block] != null);
      const harm = O.functionalHarm(e.block, { night: tod >= 12542 && tod <= 23459, otherLightNear: otherLight });
      const alts = O.alternatives(e.block, { inventory: inv, natural: vis, hasPickaxe: inv.some((i) => /_pickaxe$/.test(i.name)), hasFood: (r.foodCount || 0) > 0 });
      const would = O.decideReason({ action: own ? 'dismantle_own' : 'take_placed', category: own ? 'own' : 'other', block: e.block, needs: eff, alternatives: alts });
      out.push({ event: 'intent', _name: who, id, action: 'collect', perspective: 'ground_truth', estimated: true, loop: r.loop,
        target: { block: e.block, pos, owner: null, ownerKind: 'natural' }, reasonCode: 'unmodeled', wouldBe: would.reasonCode, need: would.need, emergency: would.emergency,
        permission: 'not_applicable', alternatives: alts, functionalHarm: harm, truth: { placedBy: e.placedBy, ownership: e.ownership, purpose: e.purpose, status: e.status },
        ...(would.reasonCode === 'emergency_need' ? { truthAlternatives: null } : {}) });
      ledger.record(who, { ms: r.ms + 1, type: 'remove', dim: DIM, pos: e.position, block: e.block, by: who, action: 'collect', reasonCode: 'unmodeled', intentId: id });
    }
  }
  return { synthetic: out, ledger, stat };
}

function main() {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith('--'));
  if (!target) { console.error('usage: node tools/replay_provenance.js <runs/<時刻>/> [--json] [--radius 16]'); process.exit(2); }
  const ri = args.indexOf('--radius');
  const all = readRun(target);
  const { synthetic, ledger, stat } = replay(all, { radius: ri >= 0 ? Number(args[ri + 1]) : 16 });
  const p = provenanceStats([...all.filter(isStep), ...synthetic], { ledger });
  const would = {}; for (const s of synthetic.filter((x) => x.truth.placedBy !== x._name)) would[s.wouldBe] = (would[s.wouldBe] || 0) + 1;
  const res = { estimate: stat, wouldBeIfKnown: would, stats: p };
  if (args.includes('--json')) { console.log(JSON.stringify(res, null, 2)); return; }
  console.log(`推定: 位置のある place ${stat.placesWithPos} (位置の無い place ${stat.placesNoPos})、人工物の collect で掘った ${stat.artifactCollects} 個のうち台帳と合った ${stat.matched} (自分の物 ${stat.ownMatched}・ほかの人の物 ${stat.otherMatched})、合わない ${stat.unmatched}`);
  console.log(`  所有を知っていたら (新しい規則): ${Object.entries(would).map(([k, v]) => `${k} ${v}`).join('・')}`);
  for (const l of lines(p)) console.log(l);
}

if (require.main === module) main();
module.exports = { replay, visibleNames, purposeOf };
