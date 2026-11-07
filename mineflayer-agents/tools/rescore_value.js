#!/usr/bin/env node
'use strict';
// 前の記録のゴール選びの場面を、珍しさ・大事さ (scarcity.js) と手間の感じ方 (探検の T・夜の外歩き。planner の costScale) を入れて点を付け直す。
// LLM・Jev は呼ばない (記録の P をそのまま使う)。bot なし。
//   node tools/rescore_value.js <runs/ID> [--names wheat_seeds,white_wool,mutton] [--night] [--max 8] [--json]
//   見かけた記録 (Sightings) は、各判断の観測の文 (obs: 見えるブロック・近くの生き物と方角・距離) を順に読み直して作る
//   (obs は種類を maxTypes まで・数を「他N+」で出すので、本番の記録より少なめに数える近似)。
//   道筋は判断の記録 (持ち物・見えている物・覚えている場所の種類) から planner で作り直す (近似)。
//   手間: 記録の手間 (経験・慣れの補正のあと) × (作り直した道筋の手間 (costScale あり) ÷ (costScale なし))。人・場所は × travel
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../src/config');
const { Planner } = require('../src/planner');
const { selectScores } = require('../src/goalpath');
const scarcity = require('../src/scarcity');

const args = process.argv.slice(2);
const runDir = args.find((a) => !a.startsWith('--'));
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const NAMES = (opt('--names', 'wheat_seeds,white_wool,mutton')).split(',');
const NIGHT = args.includes('--night');
const MAX = Number(opt('--max', 8));
const JSON_OUT = args.includes('--json');
const cfg = loadConfig(path.join(__dirname, '..', 'configs', 'survival_3days.json'));
const sc = { ...cfg.goalPath.select };
const ef = sc.effort || {};
const vc = scarcity.cfgOf(sc.value);

const DIRV = { 東: [1, 0], 西: [-1, 0], 南: [0, 1], 北: [0, -1] };
// 「西10南7上2(12m)」→ { dx, dy, dz }
function offsetOf(s) {
  const o = { dx: 0, dy: 0, dz: 0 };
  for (const m of String(s).matchAll(/(東|西|南|北|上|下)(\d+)/g)) {
    const n = Number(m[2]);
    if (m[1] === '上') o.dy += n; else if (m[1] === '下') o.dy -= n; else { o.dx += DIRV[m[1]][0] * n; o.dz += DIRV[m[1]][1] * n; }
  }
  return o;
}
// 観測の文 → { blocks: [{ name, seen, nearest }], entities: [{ name, kind, pos }] }
function parseObs(obs, pos) {
  const out = { blocks: [], entities: [] };
  const lines = String(obs || '').split('\n');
  const bl = lines.find((l) => l.startsWith('見えるブロック:'));
  if (bl) {
    for (const part of bl.replace('見えるブロック:', '').split(', ')) {
      const m = part.trim().match(/^([a-z0-9_]+) (\S+?)\((\d+)m\)(?: 他(\d+)\+?)?/);
      if (!m) continue;
      const o = m[2] === 'ここ' ? { dx: 0, dy: 0, dz: 0 } : offsetOf(m[2]);
      out.blocks.push({ name: m[1], seen: 1 + (Number(m[4]) || 0), nearest: { x: pos.x + o.dx, y: pos.y + o.dy, z: pos.z + o.dz } });
    }
  }
  const el = lines.find((l) => l.startsWith('近くの人・生き物・落ちている物:'));
  if (el) {
    for (const part of el.replace('近くの人・生き物・落ちている物:', '').split(', ')) {
      const t = part.trim();
      if (!t || t === 'なし') continue;
      const m = t.match(/^(プレイヤー|落ちている)?([A-Za-z0-9_]+) (\S+?)\(/);
      if (!m) continue;
      const o = m[3] === 'ここ' ? { dx: 0, dy: 0, dz: 0 } : offsetOf(m[3]);
      out.entities.push({ name: m[2], kind: m[1] === 'プレイヤー' ? 'player' : m[1] === '落ちている' ? 'item' : 'mob', pos: { x: pos.x + o.dx, y: pos.y + o.dy, z: pos.z + o.dz } });
    }
  }
  return out;
}
const knownKinds = (memText) => {
  const l = String(memText || '').split('\n').find((x) => x.startsWith('覚えている場所:'));
  if (!l) return [];
  return [...l.matchAll(/M\d+=([a-z0-9_]+)/g)].map((m) => m[1]);
};
const isNight = (t) => t >= 13000 && t < 23000;
const r3 = (x) => Math.round(x * 1000) / 1000;

function rescoreFile(file, name) {
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  const sg = new scarcity.Sightings({}, vc);
  let last = null;
  const scenes = [];
  for (const r of lines) {
    if (r.event == null && r.loop != null && r.pos) {
      const now = (r.day || 0) * 24000 + (r.timeOfDay || 0);
      const o = parseObs(r.obs, r.pos);
      sg.note({ blocks: o.blocks, entities: o.entities, self: { pos: r.pos } }, now);
      last = { r, o, now };
      continue;
    }
    if (r.event !== 'goal_path' || r.kind !== 'goal' || !r.select || !Array.isArray(r.select.scores) || r.select.scores.length < 2 || !last) continue;
    const L = last.r;
    const tod = L.timeOfDay;
    if (NIGHT && !isNight(tod)) continue;
    const S = r.select;
    const targets = S.scores.map((x) => x.target);
    if (!NIGHT && !targets.some((t) => NAMES.includes(t))) continue;
    const T = L.division && L.division.T ? Number(L.division.T.exploring) || 0 : 0;
    const risk = isNight(tod) && L.social && L.social.needs && L.social.needs.ant ? Number(L.social.needs.ant.risk) || 0 : 0;
    const scale = { unseen: Math.max(0.1, 1 - (ef.unseenT ?? 0) * Math.min(1, T)), travel: 1 + (ef.nightTravel ?? 0) * risk };
    const world = { inventory: L.inventory || [], visibleBlocks: last.o.blocks.map((b) => b.name), visibleMobs: last.o.entities.filter((e) => e.kind === 'mob').map((e) => e.name),
      knownBlocks: knownKinds(L.memText), stations: { crafting_table: knownKinds(L.memText).includes('crafting_table') || last.o.blocks.some((b) => b.name === 'crafting_table') } };
    const p0 = new Planner(world, {}); const p1 = new Planner({ ...world, costScale: scale }, {});
    const valid = S.scores.map((x) => {
      let pth = null; let ratio = 1;
      if (x.kind === 'item') {
        pth = p1.plan(x.target, x.count || 1);
        const e0 = p0.effort([{ item: x.target, count: x.count || 1 }]); const e1 = p1.effort([{ item: x.target, count: x.count || 1 }]);
        ratio = Number.isFinite(e0) && e0 > 0 && Number.isFinite(e1) ? e1 / e0 : 1;
      } else if (x.kind === 'person' || x.kind === 'place') ratio = scale.travel;
      return { pg: { kind: x.kind, target: x.target }, path: pth && pth.ok ? pth : null, cost: x.cost == null ? null : x.cost * ratio, x };
    });
    const needs = (S.needs || []).map((n) => ({ need: n.need, distress: n.distress }));
    const later = (S.later || []).map((n) => ({ need: `later_${n.need}`, distress: n.distress }));
    const all = [...needs, ...later];
    const P = S.scores.map((x) => x.P || {});
    const divOpt = S.division ? { T: S.division.T, beta: S.division.beta, gamma: S.division.gamma } : null;
    const expOpt = S.experience ? { factor: S.experience.factor } : null;
    const props = valid.map((v) => ({ kind: v.pg.kind, target: v.pg.target, path: v.path }));
    const W = scarcity.importanceWeights(props, vc);
    const visible = new Set([...world.visibleBlocks, ...world.visibleMobs]);
    const rar = valid.map((v) => (v.pg.kind === 'item' ? scarcity.itemRarity(v.pg.target, v.path, (n) => sg.availability(n, last.now), visible, vc) : { R: 1 }));
    const value = { W, lambda: vc.lambda, R: rar.map((x) => x.R), S: rar.map((x) => (Number.isFinite(x.a) ? 1 - x.a : 0)) };
    const costsNew = valid.map((v) => v.cost);
    const costsOld = S.scores.map((x) => x.cost);
    const old = selectScores(P, all, sc, costsOld, divOpt, expOpt);
    const onlyCost = selectScores(P, all, sc, costsNew, divOpt, expOpt);
    const neu = selectScores(P, all, sc, costsNew, divOpt, expOpt, value);
    scenes.push({ who: name, loop: L.loop, tod, night: isNight(tod), T: r3(T), risk: r3(risk), scale, chosenRecorded: r.target,
      oldChoice: S.scores[old.index].target, costChoice: S.scores[onlyCost.index].target, newChoice: S.scores[neu.index].target,
      rows: S.scores.map((x, i) => ({ target: x.target, kind: x.kind, need: x.need, old: old.scores[i], cost: [x.cost, costsNew[i] == null ? null : r3(costsNew[i])], costOnly: onlyCost.scores[i],
        imp: neu.imp[i], usedBy: W[i].map((w, j) => (w ? `${S.scores[j].target}${w < 1 ? `×${w}` : ''}` : null)).filter(Boolean), R: value.R[i], src: rar[i].source || null, a: rar[i].a ?? null, srcNow: !!rar[i].now, new: neu.scores[i] })) });
  }
  return scenes;
}

function main() {
  if (!runDir) { console.error('usage: node tools/rescore_value.js <runs/ID> [--names a,b] [--night] [--max N] [--json]'); process.exit(1); }
  const files = fs.readdirSync(runDir).filter((f) => /^[A-Z][a-z]+-.*\.jsonl$/.test(f));
  let scenes = [];
  for (const f of files) scenes.push(...rescoreFile(path.join(runDir, f), f.split('-')[0]));
  const sum = { scenes: scenes.length, changed: scenes.filter((s) => s.oldChoice !== s.newChoice).length, oldChoices: {}, newChoices: {} };
  for (const s of scenes) { sum.oldChoices[s.oldChoice] = (sum.oldChoices[s.oldChoice] || 0) + 1; sum.newChoices[s.newChoice] = (sum.newChoices[s.newChoice] || 0) + 1; }
  // 名前ごとに、案に出た場面での点の順位 (1 = 選ばれる)
  const rank = {};
  for (const s of scenes) for (const nm of NAMES) {
    const row = s.rows.find((x) => x.target === nm);
    if (!row) continue;
    const ro = 1 + s.rows.filter((x) => x.old > row.old).length; const rn = 1 + s.rows.filter((x) => x.new > row.new).length;
    rank[nm] = rank[nm] || { n: 0, oldFirst: 0, newFirst: 0, oldRankSum: 0, newRankSum: 0, R: [] };
    const k = rank[nm]; k.n += 1; k.oldFirst += ro === 1 ? 1 : 0; k.newFirst += rn === 1 ? 1 : 0; k.oldRankSum += ro; k.newRankSum += rn; k.R.push(row.R);
  }
  for (const k of Object.values(rank)) { k.oldRank = r3(k.oldRankSum / k.n); k.newRank = r3(k.newRankSum / k.n); k.Rmean = r3(k.R.reduce((a, b) => a + b, 0) / k.R.length); delete k.oldRankSum; delete k.newRankSum; delete k.R; }
  sum.rank = rank;
  if (JSON_OUT) { console.log(JSON.stringify({ summary: sum, scenes }, null, 2)); return; }
  console.log(JSON.stringify(sum));
  const show = scenes.filter((s) => s.oldChoice !== s.newChoice).concat(scenes.filter((s) => s.oldChoice === s.newChoice)).slice(0, MAX);
  for (const s of show) {
    console.log(`\n## ${s.who} loop ${s.loop} (時刻 ${s.tod}${s.night ? '・夜' : ''}) T探検=${s.T} 夜の危なさ=${s.risk} 手間の倍率 unseen×${r3(s.scale.unseen)} travel×${r3(s.scale.travel)}`);
    console.log(`   選ばれた: 前 ${s.oldChoice} → 手間だけ直す ${s.costChoice} → 珍しさ・大事さも ${s.newChoice}`);
    for (const x of [...s.rows].sort((a, b) => b.new - a.new)) {
      console.log(`   ${x.kind}:${x.target} 点 ${x.old} → ${x.new}  手間 ${x.cost[0]}→${x.cost[1]}  R=${x.R}${x.src ? ` (${x.src} a=${x.a}${x.srcNow ? '・今見える' : ''})` : ''}  Imp=${x.imp}${x.usedBy.length ? ` (${x.usedBy.join(', ')} の材料)` : ''}`);
    }
  }
}

main();
