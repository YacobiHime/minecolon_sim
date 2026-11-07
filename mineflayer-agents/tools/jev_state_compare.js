#!/usr/bin/env node
'use strict';
// 前の実行の記録の場面から、Jev に送る state を「前の日本語の state (stateLang: ja)」と「英語の state (en)」の両方で作り直し、
// 1判断の入力トークンを比べる。
//   node tools/jev_state_compare.js runs/<時刻>/ [--scenes 6] [--call] [--show 1] [--config configs/survival_3days.json]
//   --call  本物の Jev に送って usage.input_tokens を測る (1場面 2 回。キーは表示しない)。無ければ文字数とトークンの推定だけ
//   --show N 最初の N 場面の英語の state を全部出す
// 記録には生の観測 (raw) が無いので、観測の文 (obs)・記憶の文 (memText)・欲求の値 (social)・ゴールの event から作り直す
// (座標は自分の位置と relDir の差から戻す。作れる物はレシピから数える)。日本語の state は記録の文をそのまま使う。
// 作り直しの確かさの目安として、記録にある本当の入力トークン (jev.inputTokens) も並べる。
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../src/config');
const { buildContext } = require('../src/agent');
const { Memory } = require('../src/memory');
const { notableMatcher } = require('../src/observe');
const { index } = require('../src/planner');
const { Social } = require('../src/social');
const { GoalPath } = require('../src/goalpath');
const { actionOptions, buildState, buildQuestions } = require('../src/deciders/jev');
const { JevClient } = require('../src/jev_client');
const { estimateTokens } = require('../src/usage');
const states = require('../src/states');
const en = require('../src/en');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const runDir = args.find((a) => !a.startsWith('--') && fs.existsSync(a));
if (!runDir && require.main === module) { console.error('usage: node tools/jev_state_compare.js runs/<時刻>/ [--scenes 6] [--call] [--show 1]'); process.exit(2); }
const nScenes = Number(opt('--scenes', 6));
const doCall = args.includes('--call');
const nShow = Number(opt('--show', 1));
const cfgFile = opt('--config', path.join(__dirname, '..', 'configs', 'survival_3days.json'));

const DIRS = { 東: [1, 0], 西: [-1, 0], 南: [0, 1], 北: [0, -1] };
// "西10南7上2(12m)" / "ここ(1m)" → 自分から見た差 {dx, dy, dz, d}
function parseRel(s) {
  const m = s.match(/^(.*?)\((\d+)m\)$/);
  if (!m) return null;
  let dx = 0; let dz = 0; let dy = 0;
  for (const [, w, n] of m[1].matchAll(/(東|西|南|北|上|下)(\d+)/g)) {
    if (w === '上') dy = Number(n); else if (w === '下') dy = -Number(n);
    else { dx += DIRS[w][0] * Number(n); dz += DIRS[w][1] * Number(n); }
  }
  return { dx, dy, dz, d: Number(m[2]) };
}

const notable = notableMatcher();
function rawFromObs(obs, inventory, version = '1.20.1') {
  const lines = obs.split('\n');
  const self = lines[0].match(/^自分: (\S+) 位置\((-?\d+),(-?\d+),(-?\d+)\) 体力(\d+)\/20 満腹(\d+)\/20 時間:(\S+?)(?: (\d+)日目)?(?: |$)/);
  const pos = { x: Number(self[2]), y: Number(self[3]), z: Number(self[4]) };
  const phaseTod = { 朝: 500, 昼: 6000, 夕方: 12000, 夜: 18000, 明け方: 23500 };
  const raw = { self: { name: self[1], pos, health: Number(self[5]), food: Number(self[6]), phase: self[7], timeOfDay: phaseTod[self[7]] ?? 6000, day: self[8] ? Number(self[8]) - 1 : null, held: null, vehicle: null },
    inventory: inventory || [], blocks: [], entities: [], heard: [], craft: { now: [], withTable: [] }, tableNearby: null };
  const at = (r) => ({ x: pos.x + r.dx, y: pos.y + r.dy, z: pos.z + r.dz });
  const hasPick = (inventory || []).some((i) => /_pickaxe$/.test(i.name));
  for (const l of lines.slice(1)) {
    if (l.startsWith('見えるブロック: ') && !/なし$/.test(l)) {
      for (const part of l.slice(l.indexOf(': ') + 2).split(', ')) {
        const m = part.match(/^([a-z0-9_]+)(?:\(育ちきった(\d+)\/(\d+)\))? (\S+?\(\d+m\))(?: 他(\d+)\+)?$/);
        if (!m) continue;
        const r = parseRel(m[4]);
        const p = { ...at(r), d: r.d };
        const stoneLike = /^(stone|cobblestone|.*_ore|andesite|diorite|granite|deepslate)$/.test(m[1]);
        raw.blocks.push({ name: m[1], notable: notable(m[1]), diggable: !/^(water|lava|bedrock)$/.test(m[1]) && (!stoneLike || hasPick), seen: 1 + Number(m[5] || 0), nearest: p, positions: [p], ...(m[2] ? { ripe: Number(m[2]) } : {}) });
      }
    }
    if (l.startsWith('近くの人・生き物・落ちている物: ') && !/なし$/.test(l)) {
      let id = 1;
      for (const part of l.slice(17).split(', ')) {
        const m = part.match(/^(プレイヤー|落ちている|敵)?([A-Za-z0-9_]+) (\S+?\(\d+m\))$/);
        if (!m) continue;
        const r = parseRel(m[3]);
        raw.entities.push({ kind: m[1] === 'プレイヤー' ? 'player' : m[1] === '落ちている' ? 'item' : m[1] === '敵' ? 'hostile' : 'mob', name: m[2], id: id++, pos: at(r), d: r.d });
      }
    }
    if (l.startsWith('今聞こえた話: ') && !/なし$/.test(l)) for (const [, from, text] of l.slice(8).matchAll(/(\S+?)「(.*?)」/g)) raw.heard.push({ from, text, d: 5 });
  }
  const t = raw.blocks.find((b) => b.name === 'crafting_table');
  raw.tableNearby = t ? t.nearest : null;
  // 作れる物 (レシピと持ち物から): 作業台の要らない物 → now、要る物 → withTable
  const inv = new Map();
  for (const i of raw.inventory) inv.set(i.name, (inv.get(i.name) || 0) + i.count);
  for (const [out, rs] of index(version).recipes) {
    for (const r of rs) {
      if (!Object.entries(r.ings).every(([k, v]) => (inv.get(k) || 0) >= v)) continue;
      (r.table ? raw.craft.withTable : raw.craft.now).push(out);
      break;
    }
  }
  raw.craft.now = [...new Set(raw.craft.now)];
  raw.craft.withTable = [...new Set(raw.craft.withTable)].filter((n) => !raw.craft.now.includes(n));
  return raw;
}

function memoryFrom(memText, pos, limits) {
  const m = new Memory({ limits });
  m.tick = 100;
  for (const l of String(memText || '').split('\n')) {
    if (l.startsWith('覚えている場所: ') && !/なし$/.test(l)) {
      for (const part of l.slice(l.indexOf(': ') + 2).split(', ')) {
        // "M2=聞いた場所(Mioが言っていた所) 西1(1m)・出現地点のすぐ近く" (聞いた場所・後ろの添え書きも読む)
        const mm = part.match(/^M\d+=(\S+?)(?:\((\S+?)が言っていた所\))? (\S+?\(\d+m\))(?:・.*)?$/);
        if (!mm) continue;
        const r = parseRel(mm[3]);
        m.places.push({ kind: mm[1], x: pos.x + r.dx, y: pos.y + r.dy, z: pos.z + r.dz, firstSeen: 99, lastSeen: 99, n: 1, ...(mm[2] ? { from: mm[2] } : {}) });
      }
    }
    if (l.startsWith('やったこと: ') && !/まだ何もしていない$/.test(l)) {
      let t = 90;
      for (const part of l.slice(7).split(' / ')) {
        const mm = part.match(/^([a-z_]+)(?:\((.*?)\))?→(成功|失敗):(.*)$/);
        if (mm) m.events.push({ t: t++, action: mm[1], arg: mm[2] || '', ok: mm[3] === '成功', msg: mm[4], imp: 0.3 });
      }
    }
    if (l.startsWith('聞いた話: ')) for (const [, from, text] of l.slice(6).matchAll(/(\S+?)「(.*?)」/g)) m.heard.push({ t: 95, from, text, imp: 0.3 });
    if (l.startsWith('教わったこと: ')) for (const [, from, text] of l.slice(7).matchAll(/(\S+?)から\(.*?\)「(.*?)」/g)) m.knowledge.push({ t: 95, from, about: '', text, imp: 0.8, at: '' });
  }
  return m;
}

function socialFrom(rec, persona) {
  const s = new Social({ temperament: persona.temperament || {} });
  const sv = rec.social || {};
  if (sv.needs) {
    for (const k of Object.keys(s.needsModel.v)) if (Number.isFinite(sv.needs[k])) s.needsModel.v[k] = sv.needs[k];
    s.needsModel.missedNights = sv.needs.missedNights || 0;
  }
  s.needsModel.stress = sv.stress || 0;
  if (sv.emotions) Object.assign(s.emotions, sv.emotions);
  for (const [n, a] of Object.entries(sv.aff || {})) s.relations[n] = { affinity: a, trust: 0.5, talks: 1, helpedMe: 0, iHelped: 0, ignoredMe: 0, met: true, note: '' };
  return s;
}

// 記録の1場面 (sc = { rows, row, prev }) から、Jev に渡す ctx を作り直す (weight_check.js からも使う)。返り値 { ctx, name, persona, cfg, raw, mem, gp }
function sceneContext(sc, base, cfgFile) {
  const { row, prev } = sc;
  const name = row.obs.match(/^自分: (\S+)/)[1];
  const persona = (base.personas || []).find((p) => p.name === name) || { name };
  const cfg = loadConfig(cfgFile, { persona });
  cfg.persona = persona;
  const raw = rawFromObs(row.obs.split('\n').filter((l) => /^(自分|持ち物|見えるブロック|近くの人|今聞こえた話)/.test(l)).join('\n'), prev.inventory || []);
  const mem = memoryFrom(row.memText, raw.self.pos, cfg.memory.limits);
  const social = socialFrom(row, persona);
  const lastJa = `${prev.action}${prev.arg ? '(' + prev.arg + ')' : ''}→${prev.result.ok ? '成功' : '失敗'}: ${prev.result.msg}`;
  const prev2 = sc.rows.filter((r) => r.loop && r.action && r.result && r.jev && r.obs && r.loop < prev.loop).pop();
  const lastEn = en.resultEn({ action: prev.action, arg: prev.arg, ok: prev.result.ok, msg: prev.result.msg, delta: en.invDelta(prev2 ? prev2.inventory : [], prev.inventory || []) });
  const ctx = buildContext(raw, mem, cfg, { foods: new Set(Object.keys(index().md.foodsByName || {})), socialText: row.social ? row.social.words : '', socialEn: social.words({ lang: 'en' }), lastResult: lastJa, lastResultEn: lastEn, planText: row.progress || '' });
  ctx.obsText = row.obs; ctx.memText = row.memText; // 日本語の state は記録の文のまま
  ctx.policy = row.policy || null;
  // ゴール: この判断より前の最後のゴールの event から作り直し、英語の plan を作る
  const g = sc.rows.filter((r) => r.event === 'goal_path' && r.kind === 'goal' && r.ok && r.ts <= row.ts).pop();
  let gp = null;
  if (g) {
    gp = new GoalPath({ llm: { complete: async () => ({ text: '' }) }, cfg: cfg.goalPath });
    const gctx = { raw, people: [], places: mem.placesForPrompt(raw.self.pos), base: null };
    const pl = g.goalKind === 'place' ? gp.rawCandidates(gctx).places.find((x) => x.name === g.target) || null : null;
    gp.goal = { kind: g.goalKind, target: g.target, count: g.count, give: g.give, why: g.why, need: g.need, state: g.goalKind === 'state' ? states.parseStateId(g.target) : null, place: pl, startPos: raw.self.pos, metAt: null, setAt: 0, best: Infinity, bestAt: 0 };
    gp.refresh(gctx, 1);
    if (row.goalPath && row.goalPath.met) gp.goal.metAt = 0;
    ctx.en.plan = gp.planEn();
    ctx.pathNext = gp.pathNext();
    ctx.en.obs = require('../src/agent').obsEn(raw, cfg, row.progress || '');
  }
  return { ctx, name, persona, cfg, raw, mem, gp: g ? gp : null };
}

function main() {
  const files = fs.readdirSync(runDir).filter((f) => f.endsWith('.jsonl') && !f.startsWith('monitor'));
  const scenes = [];
  for (const f of files) {
    const rows = fs.readFileSync(path.join(runDir, f), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const steps = rows.filter((r) => r.loop && r.action && r.result && r.jev && r.obs);
    for (let i = 1; i < steps.length; i++) scenes.push({ file: f, rows, row: steps[i], prev: steps[i - 1] });
  }
  if (!scenes.length) { console.error('Jev の判断の行が無い'); process.exit(1); }
  const pick = [];
  for (let i = 0; i < nScenes; i++) pick.push(scenes[Math.floor(((i + 0.5) / nScenes) * scenes.length)]);
  const client = doCall ? new JevClient({}) : null;
  if (doCall && !client.hasKey) { console.error('Jev の API キーが無い'); process.exit(2); }
  const base = loadConfig(cfgFile, {});
  return (async () => {
    const out = [];
    for (const [si, sc] of pick.entries()) {
      const { row } = sc;
      const { ctx, name } = sceneContext(sc, base, cfgFile);
      const oJa = actionOptions(ctx.actions, { lang: 'ja' });
      const stJa = buildState(ctx, { table: oJa.table, lang: 'ja' });
      const qJa = buildQuestions(ctx, { criteria: oJa.criteria, hasTable: true, lang: 'ja' }).questions;
      const oEn = actionOptions(ctx.actions, { lang: 'en' });
      const stEn = buildState(ctx, { table: oEn.table, lang: 'en' });
      const qEn = buildQuestions(ctx, { criteria: oEn.criteria, hasTable: true, lang: 'en' }).questions;
      const txtJa = JSON.stringify(stJa) + JSON.stringify(qJa);
      const txtEn = JSON.stringify(stEn) + JSON.stringify(qEn);
      const r = { scene: `${name} loop ${row.loop}`, recordedTokens: row.jev.inputTokens, recordedChars: row.jev.inputChars, options: { ja: Object.keys(oJa.criteria).length, en: Object.keys(oEn.criteria).length },
        chars: { ja: txtJa.length, en: txtEn.length }, est: { ja: estimateTokens(txtJa), en: estimateTokens(txtEn) },
        stateChars: Object.fromEntries(Object.keys({ ...stJa, ...stEn }).map((k) => [k, [stJa[k] ? JSON.stringify(stJa[k]).length : 0, stEn[k] ? JSON.stringify(stEn[k]).length : 0]])) };
      if (doCall) {
        const a = await client.ask(stJa, qJa); const b = await client.ask(stEn, qEn);
        r.jev = { ja: a.usage ? a.usage.input_tokens : null, en: b.usage ? b.usage.input_tokens : null, errJa: a.ok ? null : a.error, errEn: b.ok ? null : b.error,
          choiceJa: a.answers && a.answers.next_action ? a.answers.next_action.choice : null, choiceEn: b.answers && b.answers.next_action ? b.answers.next_action.choice : null,
          nextNowP: b.answers && b.answers.next_now ? b.answers.next_now.noul : null };
      }
      if (si < nShow) r.stateEn = stEn;
      out.push(r);
    }
    const tot = (f) => out.reduce((s, r) => s + (f(r) || 0), 0);
    const summary = { scenes: out.length, recordedTokensAvg: Math.round(tot((r) => r.recordedTokens) / out.length), charsAvg: { ja: Math.round(tot((r) => r.chars.ja) / out.length), en: Math.round(tot((r) => r.chars.en) / out.length) },
      estAvg: { ja: Math.round(tot((r) => r.est.ja) / out.length), en: Math.round(tot((r) => r.est.en) / out.length) } };
    if (doCall) summary.jevAvg = { ja: Math.round(tot((r) => r.jev.ja) / out.length), en: Math.round(tot((r) => r.jev.en) / out.length) };
    console.log(JSON.stringify({ summary, scenes: out }, null, 2));
  })();
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { parseRel, rawFromObs, memoryFrom, socialFrom, sceneContext };
