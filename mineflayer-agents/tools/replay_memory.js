#!/usr/bin/env node
'use strict';
// 記録 (runs/<時刻>/<名前>-*.jsonl) をオフラインで再生し、今までの選び方 (legacy・1本の指数) と連想 (associative・2つの貯蔵) で
// 渡る記憶がどう変わるかを比べる。サーバー・LLM・Jev は使わない (記録の観測・行動・結果・Jev の remember をそのまま使う)。
//   node tools/replay_memory.js runs/<時刻>/ [--names Aoi,Megumi] [--agents 5] [--examples 3] [--json out.json]
// 再生するもの (記録から分かる範囲):
//   観測の文 (obs) → 位置・見えている目印 (DEFAULT_NOTABLE)・近くの人・今聞こえた話 → notePlace・noteVisit・noteCell・noteHeard
//   行動の結果 → noteEvent (英語の文は無いので日本語のまま)。go_to で「着いたが…はもう無かった」→ forgetPlace (空振りのメモ)
//   Jev の remember → setRecentImportance。set_base → 拠点。death → 死んだ。ownership_loss (見た・相手が分かった) → されたこと
//   人に聞いて返ってきた答え (ask + ask_reply) → noteKnowledge。人に聞かれた質問 (answer) → その時点の記憶で答えの記憶を選び直す
// 再生しないもの: 所有の知識 (extra.owned)、全体チャット、prospect、置いた物の場所 (一部だけ)
const fs = require('fs');
const path = require('path');
const { Memory } = require('../src/memory');
const ask = require('../src/ask');
const { DEFAULT_NOTABLE } = require('../src/observe');

const NOTABLE = DEFAULT_NOTABLE.map((p) => new RegExp(p));
const isNotable = (n) => NOTABLE.some((r) => r.test(n));
const LIMITS = { places: 40, visited: 20, cells: 300, exploreCell: 16, events: 60, heard: 30, promptPlaces: 6, promptItems: 20, halfLife: 40, impBoost: 6, forgetBelow: 0.08, knowledge: 30, textLen: 80 };

function readRows(f) { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); }

// 「東1南2上9(9m)」「ここ(1m)」→ { dx, dy, dz }
function parseRel(s) {
  const out = { dx: 0, dy: 0, dz: 0 };
  for (const m of String(s).matchAll(/(東|西|南|北|上|下)(\d+)/g)) {
    const v = Number(m[2]);
    if (m[1] === '東') out.dx += v; else if (m[1] === '西') out.dx -= v; else if (m[1] === '南') out.dz += v; else if (m[1] === '北') out.dz -= v; else if (m[1] === '上') out.dy += v; else out.dy -= v;
  }
  return out;
}

// 観測の文 → raw (memory と手がかりに要る分だけ)
function parseObs(obs, row) {
  const lines = String(obs || '').split('\n');
  const self = { pos: row.pos ? { x: row.pos.x, y: row.pos.y, z: row.pos.z } : null, timeOfDay: row.timeOfDay ?? null, day: row.day ?? null };
  const pm = String(obs).match(/位置\((-?\d+),(-?\d+),(-?\d+)\)/);
  if (pm) self.pos = { x: Number(pm[1]), y: Number(pm[2]), z: Number(pm[3]) };
  const raw = { self, blocks: [], entities: [], people: [], heard: [] };
  for (const l of lines) {
    if (l.startsWith('見えるブロック:')) {
      for (const part of l.slice(8).split(/,\s*/)) {
        const m = part.trim().match(/^([a-z0-9_]+)\s+(\S+?)\((\d+)m\)/);
        if (!m || !self.pos) continue;
        const r = parseRel(m[2]);
        raw.blocks.push({ name: m[1], notable: isNotable(m[1]), d: Number(m[3]), nearest: { x: self.pos.x + r.dx, y: self.pos.y + r.dy, z: self.pos.z + r.dz } });
      }
    } else if (l.startsWith('近くの人・生き物・落ちている物:')) {
      for (const part of l.slice(l.indexOf(':') + 1).split(/,\s*/)) {
        const m = part.trim().match(/^(プレイヤー)?([A-Za-z0-9_]+)\s+(\S+?)\((\d+)m\)/);
        if (!m || !self.pos) continue;
        const r = parseRel(m[3]);
        const e = { name: m[2], d: Number(m[4]), pos: { x: self.pos.x + r.dx, y: self.pos.y + r.dy, z: self.pos.z + r.dz } };
        if (m[1]) { e.kind = 'player'; raw.people.push(e); } else { e.kind = /zombie|skeleton|spider|creeper|enderman|witch|drowned|husk/.test(m[2]) ? 'hostile' : 'mob'; }
        raw.entities.push(e);
      }
    } else if (l.startsWith('今聞こえた話:')) {
      for (const m of l.slice(7).matchAll(/([A-Za-z0-9_]+)「([^」]*)」/g)) raw.heard.push({ from: m[1], text: m[2] });
    }
  }
  return raw;
}

function mkMem(kind, name) {
  const opts = kind === 'assoc' ? { retrieval: 'associative', store: 'dual' } : { retrieval: 'legacy', store: 'single' };
  return new Memory({ ...opts, limits: LIMITS, me: name, version: '1.20.1' });
}

function replayAgent(file, { examples = 3 } = {}) {
  const rows = readRows(file);
  const start = rows.find((r) => r.event === 'start');
  const name = (start && start.persona && start.persona.name) || path.basename(file).replace(/-\d{4}-.*$/, '');
  const mems = { legacy: mkMem('legacy', name), assoc: mkMem('assoc', name) };
  const stat = {};
  for (const k of Object.keys(mems)) stat[k] = { loops: 0, near: { n: 0, recalled: 0 }, nearJev: { n: 0, recalled: 0 }, byCue: {}, byCueJev: {}, hops: {}, chars: [], charsJev: [], notes: 0, answers: 0, answersKnown: 0 };
  const ex = { person: [], goal: [], need: [], note: [], answer: [] };
  const pendingAsk = {};
  let lastRaw = null;
  let lastPlaces = { legacy: [], assoc: [] };
  let origin = null;
  for (const r of rows) {
    if (r.event === 'death') { for (const m of Object.values(mems)) m.noteEvent('death', '', false, '死んでしまった', 0.9); continue; }
    if (r.event === 'set_base' && r.base) { for (const m of Object.values(mems)) { m.places = m.places.filter((q) => q.kind !== '拠点'); m.notePlace('拠点', r.base, { keep: true, imp: 1 }); } continue; }
    if (r.event === 'ownership_loss' && r.kind === 'witnessed' && r.culprit) { for (const m of Object.values(mems)) m.noteEvent('wronged', r.culprit, false, `${r.culprit}に${r.block || '物'}を取られた`, 0.8); continue; }
    if (r.event === 'ask' && r.from === name) { pendingAsk[r.id] = r; continue; }
    if (r.event === 'ask_reply' && r.from === name && pendingAsk[r.id]) {
      const q = pendingAsk[r.id];
      for (const m of Object.values(mems)) m.noteKnowledge(r.to, q.key, r.answer, { imp: r.known ? 0.8 : 0.3 });
      continue;
    }
    if (r.event === 'answer' && r.from === name) {
      const out = {};
      for (const [k, m] of Object.entries(mems)) {
        const items = ask.relevantMemories(m, r.question, { from: r.to });
        out[k] = items;
        stat[k].answers += 1;
        if (items.length) stat[k].answersKnown += 1;
      }
      if (ex.answer.length < examples && (out.assoc.length || out.legacy.length)) ex.answer.push({ question: r.question, legacy: out.legacy.map((x) => x.text), assoc: out.assoc.map((x) => `${x.text}${x.why ? ` 〔${x.why}・${x.hop}段〕` : ''}`), originalAnswer: r.answer });
      continue;
    }
    if (r.event || !r.result || !r.loop) continue;
    const raw = parseObs(r.obs, r);
    if (!raw.self.pos) continue;
    if (!origin) origin = { x: raw.self.pos.x, y: raw.self.pos.y, z: raw.self.pos.z };
    const gameNow = Number.isFinite(r.day) && Number.isFinite(r.timeOfDay) ? r.day * 24000 + r.timeOfDay : null;
    const rel = {};
    for (const [n, a] of Object.entries((r.social && r.social.aff) || {})) rel[n] = { affinity: a };
    for (const [k, m] of Object.entries(mems)) {
      m.origin = m.origin || origin;
      m.tick = r.loop;
      if (gameNow != null) m.gameNow = gameNow;
      m.observeNow({ raw, emotions: r.social && r.social.emotions, me: name });
      for (const b of raw.blocks) if (b.notable) m.notePlace(b.name, b.nearest);
      m.noteVisit(raw.self.pos);
      m.noteCell(raw.self.pos);
      for (const h of raw.heard) m.noteHeard(h.from, h.text);
      m.forget();
      const gp = r.goalPath;
      m.setCues({ raw, goal: gp ? { kind: gp.kind, target: gp.target } : null, next: gp && gp.next ? { item: gp.next } : null, worst: r.social && r.social.worst ? { need: r.social.worst } : null, social: { relations: rel } });
      const here = raw.self.pos;
      const vis = new Set(raw.blocks.filter((b) => b.notable).map((b) => b.name));
      const places = m.placesForPrompt(here, vis, { ensure: ['water'] });
      const st = m.toStateEn(here, { places, maxPlaces: 4 });
      const text = m.toPromptText(here, { places });
      const s = stat[k];
      s.loops += 1;
      const sel = m.lastSelection || {};
      const selJ = m.lastSelectionJev || {};
      if (sel.near) { s.near.n += sel.near.n; s.near.recalled += sel.near.recalled; }
      if (selJ.near) { s.nearJev.n += selJ.near.n; s.nearJev.recalled += selJ.near.recalled; }
      for (const [c, n] of Object.entries(sel.byCue || {})) s.byCue[c] = (s.byCue[c] || 0) + n;
      for (const [c, n] of Object.entries(selJ.byCue || {})) s.byCueJev[c] = (s.byCueJev[c] || 0) + n;
      for (const [c, n] of Object.entries(sel.hops || {})) s.hops[c] = (s.hops[c] || 0) + n;
      s.chars.push(text.length);
      s.charsJev.push(JSON.stringify(st).length);
      s.notes += sel.note || 0;
      m._last = { text, st, sel, places };
      lastPlaces[k] = places;
    }
    // 例: 近くの人の記憶が連想でだけ渡った / ゴールから連想した場所 / 欲求から / 失敗のメモ
    const A = mems.assoc._last; const L = mems.legacy._last;
    const near = (mems.assoc.cues && mems.assoc.cues.near) || [];
    if (ex.person.length < examples && A.sel.near && A.sel.near.recalled > ((L.sel.near && L.sel.near.recalled) || 0)) {
      const who = near.find((n) => A.text.includes(n) && !L.text.split('\n').slice(1).join('\n').includes(n));
      if (who) ex.person.push({ loop: r.loop, name, near: who, affinity: rel[who] ? rel[who].affinity : 50, legacy: lineWith(L.text, who) || '(その人に関わる記憶は渡らない)', assoc: lineWith(A.text, who) });
    }
    if (ex.goal.length < examples && A.places.some((p) => p.why && (p.why.type === 'goal' || p.why.type === 'next'))) {
      const p = A.places.find((q) => q.why && (q.why.type === 'goal' || q.why.type === 'next'));
      if (!L.places.some((q) => q.pos.x === p.pos.x && q.pos.z === p.pos.z)) ex.goal.push({ loop: r.loop, name, goal: r.goalPath ? `${r.goalPath.target} (次: ${r.goalPath.next})` : null, assocPlace: `${p.id}=${p.label}`, why: p.why, legacyPlaces: L.places.map((q) => `${q.id}=${q.kind}(${q.d}m)`).join(', ') });
    }
    if (ex.need.length < examples && /〔[^〕]*(不安で|眠くて|お腹が空いて)/.test(A.text)) ex.need.push({ loop: r.loop, name, worst: r.social && r.social.worst, lines: A.text.split('\n').filter((l) => /〔[^〕]*(不安で|眠くて|お腹が空いて)/.test(l)).map((l) => l.slice(0, 300)) });
    if (ex.note.length < examples && /気をつけること/.test(A.text)) ex.note.push({ loop: r.loop, name, line: lineWith(A.text, '気をつけること') });
    // 行動の結果を覚える (両方に同じものを)
    for (const [k, m] of Object.entries(mems)) {
      const e = m.noteEvent(r.action, r.arg, r.result.ok, r.result.msg);
      if (/はもう無かった/.test(String(r.result.msg || '')) && r.action === 'go_to') {
        const p = lastPlaces.legacy.find((q) => q.id === r.arg) || lastPlaces[k].find((q) => q.id === r.arg);
        const kind = (String(r.result.msg).match(/着いたが(.+?)はもう無かった/) || [])[1];
        if (p && kind) m.forgetPlace(kind, p.pos);
      }
      if (r.action === 'place' && r.result.ok && /^(furnace|crafting_table|chest|torch)$|_bed$/.test(String(r.arg))) m.notePlace(r.arg, raw.self.pos, { imp: 0.8 });
      if (r.jev && Number.isFinite(r.jev.remember)) m.setRecentImportance(r.jev.remember / 4, r.loop - 1);
      void e;
    }
    lastRaw = raw;
  }
  void lastRaw;
  const fin = (s) => ({ loops: s.loops, nearLLM: { ...s.near, ratio: s.near.n ? round(s.near.recalled / s.near.n) : null }, nearJev: { ...s.nearJev, ratio: s.nearJev.n ? round(s.nearJev.recalled / s.nearJev.n) : null },
    byCue: s.byCue, byCueJev: s.byCueJev, hops: s.hops, charsP50: pct(s.chars, 50), charsJevP50: pct(s.charsJev, 50), notes: s.notes, answers: s.answers, answersWithMemory: s.answersKnown });
  return { name, legacy: fin(stat.legacy), assoc: fin(stat.assoc), graph: { episodes: mems.assoc.graph.eps.length, notes: mems.assoc.graph.noteCount(), persons: mems.assoc.graph.persons.size }, examples: ex };
}

function lineWith(text, word) { const l = String(text).split('\n').filter((x) => x.includes(word)); if (!l.length) return null; const s = l[0]; const i = s.indexOf(word); return (i > 120 ? '…' + s.slice(i - 100) : s).slice(0, 320); }
function round(v) { return Math.round(v * 1000) / 1000; }
function pct(a, p) { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : null; }

function main() {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  if (!dir) { console.error('usage: node tools/replay_memory.js runs/<時刻>/ [--names A,B] [--agents N] [--examples N] [--json out.json]'); process.exit(2); }
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl') && !/^monitor/.test(f)).sort();
  const names = opt('--names', null);
  const pick = names ? files.filter((f) => names.split(',').some((n) => f.startsWith(`${n}-`))) : files.slice(0, Number(opt('--agents', 5)));
  const res = pick.map((f) => replayAgent(path.join(dir, f), { examples: Number(opt('--examples', 3)) }));
  const tot = (k, f) => res.reduce((s, r) => s + f(r[k]), 0);
  const summary = {};
  for (const k of ['legacy', 'assoc']) {
    const n = tot(k, (x) => x.nearLLM.n); const rc = tot(k, (x) => x.nearLLM.recalled);
    const nj = tot(k, (x) => x.nearJev.n); const rj = tot(k, (x) => x.nearJev.recalled);
    const byCue = {}; for (const r of res) for (const [c, v] of Object.entries(r[k].byCue)) byCue[c] = (byCue[c] || 0) + v;
    const hops = {}; for (const r of res) for (const [c, v] of Object.entries(r[k].hops)) hops[c] = (hops[c] || 0) + v;
    summary[k] = { agents: res.length, loops: tot(k, (x) => x.loops), nearLLM: { n, recalled: rc, ratio: n ? round(rc / n) : null }, nearJev: { n: nj, recalled: rj, ratio: nj ? round(rj / nj) : null },
      byCue, hops, charsP50: pct(res.map((r) => r[k].charsP50), 50), charsJevP50: pct(res.map((r) => r[k].charsJevP50), 50), notes: tot(k, (x) => x.notes), answers: tot(k, (x) => x.answers), answersWithMemory: tot(k, (x) => x.answersWithMemory) };
  }
  const out = { dir, summary, agents: res };
  const jf = opt('--json', null);
  if (jf) fs.writeFileSync(jf, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  for (const r of res) {
    for (const [k, l] of Object.entries(r.examples)) for (const e of l) console.log(`\n[${r.name} ${k}] ${JSON.stringify(e, null, 1)}`);
  }
}

module.exports = { parseObs, parseRel, replayAgent };
if (require.main === module) main();
