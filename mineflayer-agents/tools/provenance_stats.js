#!/usr/bin/env node
'use strict';
// 設置物の取得と、その理由・社会的な結果の集計 (src/ownership_agent.js の記録 intent / take / ownership_* と、台帳 runs/<id>/provenance/)。
//   node tools/provenance_stats.js runs/<時刻>/ [--json]
//   指標 (2026-11-10 引き継ぎ「観察可能性」):
//     設置物の取得 / 1000 判断、reasonCode 別、所有の種類 (エージェントの見方・台帳の本当) 別、許可を求めた割合、
//     緊急の取得のうち本当に代わりが無かった割合、機能損害 (光・壁の穴・ベッド・設備)、返却・補修・説明の割合、関係 (好感・信頼) の変化、
//     accidental と実行の失敗の割合、所有者の知識の正しさ (台帳と合っていたか)
const fs = require('fs');
const path = require('path');
const { Ledger, fold, sameFamily } = require('../src/provenance');

const isStep = (r) => !!(r && r.loop && r.action && !r.event && r.result);
const r3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);
const inc = (m, k, n = 1) => { m[k] = (m[k] || 0) + n; return m; };
const ratio = (a, b) => (b ? r3(a / b) : null);

function readRun(target) {
  const isDir = fs.statSync(target).isDirectory();
  const files = isDir ? fs.readdirSync(target).filter((f) => f.endsWith('.jsonl') && !/^monitor(-\d+)?\.jsonl$/.test(f)).map((f) => path.join(target, f)) : [target];
  const all = [];
  for (const f of files) {
    const rows = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const st = rows.find((r) => r.event === 'start');
    const name = (st && st.persona && st.persona.name) || path.basename(f).replace(/-\d{4}-.*$/, '');
    for (const r of rows) all.push({ ...r, _name: name });
  }
  return all;
}

// all: 全員の記録の行 (_name 付き)。opts.ledger: Ledger (無ければ ledgerDir から読む)
function provenanceStats(all, opts = {}) {
  const steps = all.filter(isStep);
  const decisions = steps.length;
  const ledger0 = opts.ledger || (opts.ledgerDir && fs.existsSync(opts.ledgerDir) ? Ledger.load(opts.ledgerDir) : null);
  // 台帳があれば、意図の時点の本当の持ち主を台帳の全部の出来事から作り直す (実行中はほかのプロセスの記録が最大2秒遅れて届くので、
  //   記録の truth が「台帳に無い (world)」になっていることがある。2026-11-11 の実行1)
  let truthFixed = 0;
  const fixTruth = (r) => {
    if (!ledger0 || r.event !== 'intent' || !r.target || !r.target.pos || !r.ts) return r;
    const t = Date.parse(r.ts) + 1000;
    // gone (見た人のワールドの表示で無かった) は外す: 意図はその物が見えて (掘る直前に) あったときに書くので、その時点では有った。
    //   ほかのクライアントへの反映の遅れで、置いた直後に gone と書かれることがある (2026-11-11 の実行1)
    const evs = ledger0.events(r.dim || 'minecraft:overworld', r.target.pos).filter((e) => e.ms <= t && e.type !== 'gone' && !(e.intentId && e.intentId === r.id));
    const e = evs.length ? fold(evs) : null;
    if (!e || !(e.status === 'active' || e.status === 'abandoned') || !sameFamily(e.block, r.target.block)) return r;
    const owner = r.target.owner;
    const truth = { placedBy: e.placedBy, ownership: e.ownership, purpose: e.purpose, status: e.status, placedAt: e.placedAt, ownerMatches: owner ? e.placedBy === owner || (e.ownership && e.ownership.owner === owner) : null };
    if (!r.truth || r.truth.placedBy !== truth.placedBy) truthFixed += 1;
    return { ...r, truth };
  };
  const intents = all.filter((r) => r.event === 'intent').map(fixTruth);
  const byId = new Map(intents.map((r) => [r.id, r]));
  const takes = all.filter((r) => r.event === 'take');
  const ledger = ledger0;
  const removedIntents = new Set();
  if (ledger) for (const e of ledger.entries()) for (const h of e.history || []) if (h.type === 'remove' && h.intentId) removedIntents.add(h.intentId);

  // 取った (成功した) 出来事: エージェントの意図で取ったもの (take の ok) と、ground truth の記録 (天然と誤認・行動とは別の掘り・モデル無し)
  const done = [];
  for (const t of takes) if (t.ok) { const it = byId.get(t.intentId); if (it) done.push({ ...it, _name: t._name, got: t.got }); }
  for (const it of intents.filter((r) => r.perspective === 'ground_truth')) {
    // 台帳の remove に意図の id が付いていれば掘れた。台帳が無ければ記録を数える (掘る直前の記録なので、ほぼ掘れている)
    //   台帳に無い外界の物 (村など、truth.ownership.world) は台帳で確かめられないので、記録を数える
    if (ledger && !removedIntents.has(it.id) && !(it.truth && it.truth.ownership && it.truth.ownership.world)) continue;
    done.push(it);
  }
  const ownTruth = (it) => it.truth && it.truth.placedBy === it._name;
  const placedTakes = done.filter((it) => it.action !== 'dismantle_own' && !ownTruth(it));
  const own = done.filter((it) => it.action === 'dismantle_own' || ownTruth(it));

  const byReason = {}; const byOwnerKind = {}; const byTruthKind = {}; const byBlock = {};
  for (const it of placedTakes) {
    inc(byReason, it.reasonCode);
    inc(byOwnerKind, it.target ? it.target.ownerKind || 'unknown' : 'unknown');
    // 台帳に無い外界の物 (村など) は public (2026-11-11 ユーザー決定)。プレイヤーの共有物と分けて public_world と数える
    inc(byTruthKind, it.truth ? (it.truth.ownership && it.truth.ownership.world ? 'public_world' : (it.truth.ownership && it.truth.ownership.kind) || 'personal') : 'not_in_ledger');
    inc(byBlock, it.target ? it.target.block : '?');
  }

  // 許可
  const asks = all.filter((r) => r.event === 'ownership_ask');
  const answers = {}; for (const a of asks) inc(answers, a.answer || 'unknown');
  const knownOwnerTakes = placedTakes.filter((it) => it.action === 'take_placed' && it.target && ['personal', 'group', 'public'].includes(it.target.ownerKind));
  const withoutPermission = knownOwnerTakes.filter((it) => it.permission !== 'granted');
  const given = all.filter((r) => r.event === 'ownership_permission');

  // 緊急
  const em = placedTakes.filter((it) => it.reasonCode === 'emergency_need');
  const emChecked = em.filter((it) => it.truthAlternatives);
  const emNoAlt = emChecked.filter((it) => !it.truthAlternatives.available);

  // 機能損害
  const harm = { lightLost: 0, darkened: 0, wallHoles: 0, bedsInUse: 0, bedsAtNight: 0, stationsNoAlt: 0, stationsWithItems: 0, farm: 0, scoreSum: 0 };
  for (const it of placedTakes) {
    const h = it.functionalHarm || {};
    if (h.light) { harm.lightLost += 1; if (h.darkens) harm.darkened += 1; }
    if (h.opensWall) harm.wallHoles += 1;
    if (h.bed && h.bed.occupied) harm.bedsInUse += 1;
    if (h.bed && h.bed.night) harm.bedsAtNight += 1;
    if (h.station && h.station.altDist == null) harm.stationsNoAlt += 1;
    if (h.station && h.station.items) harm.stationsWithItems += 1;
    if (h.farm) harm.farm += 1;
    harm.scoreSum += h.score || 0;
  }
  harm.scoreMean = ratio(harm.scoreSum, placedTakes.length); harm.scoreSum = r3(harm.scoreSum);

  // 償い (取った相手への説明・返却・元に戻す)
  const owing = placedTakes.filter((it) => it.action === 'take_placed' && it.permission !== 'granted');
  const amends = all.filter((r) => r.event === 'ownership_amends' && r.ok);
  const amendIds = { explain: new Set(), return: new Set(), repair: new Set() };
  for (const a of amends) if (amendIds[a.kind] && a.intentId) amendIds[a.kind].add(a.intentId);
  const owingIds = new Set(owing.map((it) => it.id));
  const cnt = (k) => [...amendIds[k]].filter((id) => owingIds.has(id)).length;
  const restored = new Set([...amendIds.return, ...amendIds.repair].filter((id) => owingIds.has(id)));

  // 関係の変化 (持ち主・見た人・聞いた人の側)
  const soc = all.filter((r) => r.event === 'ownership_social');
  const relation = { events: soc.length, byKind: {}, affinity: 0, trust: 0, perKind: {} };
  for (const s of soc) {
    inc(relation.byKind, s.kind);
    relation.affinity += s.affinity || 0; relation.trust += s.trust || 0;
    const pk = relation.perKind[s.kind] || (relation.perKind[s.kind] = { affinity: 0, trust: 0 });
    pk.affinity = r3(pk.affinity + (s.affinity || 0)); pk.trust = r3(pk.trust + (s.trust || 0));
  }
  relation.affinity = r3(relation.affinity); relation.trust = r3(relation.trust);
  const losses = all.filter((r) => r.event === 'ownership_loss');
  const lossBy = {}; for (const l of losses) inc(lossBy, l.kind);

  // accidental と実行の失敗
  const failed = takes.filter((t) => !t.ok);
  const failWhy = {}; for (const t of failed) inc(failWhy, t.gone ? 'already_gone' : String(t.msg || '').replace(/[-\d(),.]+/g, '#').slice(0, 30));

  // 所有者の知識の正しさ (エージェントが「X の物」と思った物が、台帳でも X の物だったか)
  const attributed = placedTakes.filter((it) => it.truth && it.truth.ownerMatches != null);
  const misattributed = attributed.filter((it) => it.truth.ownerMatches === false);

  // 台帳
  let ledgerSummary = null;
  if (ledger) {
    const es = ledger.entries();
    const byStatus = {}; const byPurpose = {}; let removedByOther = 0; let removedBySelf = 0;
    for (const e of es) {
      inc(byStatus, e.status); inc(byPurpose, e.purpose || '-');
      if (e.status === 'removed') { if (e.removedBy && e.removedBy !== e.placedBy) removedByOther += 1; else removedBySelf += 1; }
    }
    ledgerSummary = { entries: es.length, byStatus, byPurpose, removedByOther, removedBySelf };
  }

  return {
    decisions, intents: intents.length, truthFixedFromLedger: truthFixed,
    placedTakes: placedTakes.length, per1000Decisions: decisions ? Math.round((placedTakes.length / decisions) * 10000) / 10 : null, ownTakes: own.length,
    byReason, byOwnerKind, byTruthOwnerKind: byTruthKind, byBlock,
    permission: { asked: asks.length, answers, knownOwnerTakes: knownOwnerTakes.length, takenWithoutPermission: withoutPermission.length,
      askRate: ratio(asks.length, asks.length + withoutPermission.length), answeredAsOwner: given.length, grantedAsOwner: given.filter((g) => g.yes).length },
    emergency: { takes: em.length, checked: emChecked.length, trulyNoAlternative: emNoAlt.length, trulyNoAlternativeRate: ratio(emNoAlt.length, emChecked.length) },
    harm,
    restitution: { owing: owing.length, explained: cnt('explain'), returned: cnt('return'), repaired: cnt('repair'), restoredRate: ratio(restored.size, owing.length), explainedRate: ratio(cnt('explain'), owing.length) },
    relation, losses: lossBy, rumors: all.filter((r) => r.event === 'ownership_rumor').length,
    accidental: { n: placedTakes.filter((it) => it.reasonCode === 'accidental').length, rate: ratio(placedTakes.filter((it) => it.reasonCode === 'accidental').length, placedTakes.length),
      failedTakes: failed.length, failRate: ratio(failed.length, takes.length), failWhy },
    knowledge: { attributed: attributed.length, misattributed: misattributed.length, accuracy: ratio(attributed.length - misattributed.length, attributed.length) },
    ledger: ledgerSummary,
  };
}

function lines(p) {
  if (!p) return [];
  const j = (o) => Object.entries(o || {}).map(([k, v]) => `${k} ${v}`).join('・') || 'なし';
  return [
    `設置物の取得 ${p.placedTakes} 件 (1000判断あたり ${p.per1000Decisions ?? '-'}、自分の物 ${p.ownTakes})。理由: ${j(p.byReason)}`,
    `  所有 (見方): ${j(p.byOwnerKind)} / 台帳: ${j(p.byTruthOwnerKind)}`,
    `  許可を求めた ${p.permission.asked} 回 (${j(p.permission.answers)})、許可なしで取った ${p.permission.takenWithoutPermission}、求めた割合 ${p.permission.askRate ?? '-'}`,
    `  緊急の取得 ${p.emergency.takes} (本当に代わりが無かった ${p.emergency.trulyNoAlternative}/${p.emergency.checked})`,
    `  損害: 明かり ${p.harm.lightLost} (暗くなった ${p.harm.darkened})・壁の穴 ${p.harm.wallHoles}・使用中のベッド ${p.harm.bedsInUse}・夜のベッド ${p.harm.bedsAtNight}・代わりの無い設備 ${p.harm.stationsNoAlt}`,
    `  償い: 説明 ${p.restitution.explained}・返却 ${p.restitution.returned}・元に戻す ${p.restitution.repaired} / ${p.restitution.owing} (戻した割合 ${p.restitution.restoredRate ?? '-'})`,
    `  関係の変化 ${p.relation.events} 回 (好感 ${p.relation.affinity}・信頼 ${p.relation.trust}; ${j(p.relation.byKind)})、気づいた損 ${j(p.losses)}、噂 ${p.rumors}`,
    `  accidental ${p.accidental.n} (${p.accidental.rate ?? '-'})、取りに行って失敗 ${p.accidental.failedTakes} (${j(p.accidental.failWhy)})、所有者の知識の正しさ ${p.knowledge.accuracy ?? '-'} (${p.knowledge.attributed - p.knowledge.misattributed}/${p.knowledge.attributed})`,
  ];
}

function main() {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith('--'));
  if (!target) { console.error('usage: node tools/provenance_stats.js <runs/<時刻>/> [--json]'); process.exit(2); }
  const all = readRun(target);
  const p = provenanceStats(all, { ledgerDir: fs.statSync(target).isDirectory() ? path.join(target, 'provenance') : null });
  if (args.includes('--json')) console.log(JSON.stringify(p, null, 2));
  else for (const l of lines(p)) console.log(l);
}

if (require.main === module) main();
module.exports = { provenanceStats, lines, readRun };
