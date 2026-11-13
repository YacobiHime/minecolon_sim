'use strict';
// 連想の記憶 (2026-11-13 ユーザー決定)。記憶をグラフにし、手がかりから線をたどって思い出す。埋め込みは入れない (差し込み口だけ)。
//
// 構造 (点と線)
//   点: 場所 area:<cx>,<cz> (16 ブロック四方。memory.cells と同じ大きさ) と目印 lm:<種類>@<x>,<y>,<z> (memory.places の1件)、
//       人 person:<名前>、物 item:<名前> と分類 item:*_log など、概念 cat:home/enclosure/village、欲求 need:<欲求>、時刻 time:<夜など>、
//       出来事 ep:<番号> (誰が・どこで・何を・どうした・結果・感情)。所有の知識・聞いた話・教わったこと・されたことも出来事の一種。
//   線: 出来事 → 関わる人・場所・物・時刻 (書き込むときに張る。自分で見た・聞いた・教わったことだけ = 部分観測)。
//       目印 → 場所・物・(聞いた場所なら) 言った人。場所 → となりの場所 (8方向)。
//       物 → 分類・材料 (作り方)、欲求 → 満たす物 (assoc_world.js。全員共通の知識)。
//       欲求 (安心・つながり) → 仲の良い人: 関係の値は social の持ち物を毎回参照する (コピーしない)。
//   失敗のメモ: 場所・人の点に付ける (空振り・行けなかった・死んだ・取られた・殴られた)。その点を思い出したときだけ戻す (禁止しない)。
//
// 引き出し (LLM・Jev・答えで同じ選び方。件数だけ違う)
//   1. 手がかり (cues): 今いる場所・見えている人と物・ゴールと道筋の次の物・いちばんつらい欲求・夜・聞こえた話の話し手と中身 (質問なら質問の語)
//   2. 活性を線に沿って広げる (ACT-R の spreading activation の形): 段ごとに 活性 × 線の重み × 扇の係数 × 減衰^(段−1)。
//      扇の係数 = 1/(1 + ln 扇の大きさ) (ACT-R の S − ln fan は扇が e^S ≈ 7 を超えると 0 以下になるので、比の形にした)
//   3. 点の得点 = α × 活性/最大の活性 + β × 新しさ (2つの貯蔵の忘れ方) + γ × 大事さ (+ 埋め込みの関連度: 今は無し)
//      α = 1.0・β = 0.3・γ = 0.3 (HAM-VLN, arXiv:2607.29600 の関連度・新しさ・重要度の重み)
//   4. 上位 seedK 件から、同じ点 (人・場所・物) につながる出来事へ1つ広げて足し (HAM-VLN の「上位3か所から1つ隣」)、残りを得点の順に。
//   5. 失敗のメモは、その点 (場所・人) が思い出された (手がかりか、選んだ記憶のつながる先) ときだけ足す。
const { nodesInText, itemNodes, semanticEdges, nodeLabel, ACTION_CAT, PLACE_KIND_NODE, NEED_REASON_JA, NEED_REASON_EN } = require('./assoc_world');
const { timePhase } = require('./util');

const AREA = 16;
const r3 = (v) => Math.round(v * 1000) / 1000;

const DEFAULTS = {
  // 得点の重み (HAM-VLN: 関連度 α 1.0・新しさ β 0.3・重要度 γ 0.3)
  alpha: 1.0, beta: 0.3, gamma: 0.3,
  // 広げ方: 段数・2段目からの減衰・扇の形 ('log' = 1/(1+ln fan)、'actr' = (S − ln fan)/S を 0 で止める)・ACT-R の S
  maxHops: 3, decay: 0.5, fan: 'log', S: 2, minAct: 0.002, aFloor: 0.05, cueFloor: 0.05,
  // 手がかりの重み (種類ごと)。人は関係の強さ (わだかまり・好感の離れ) で personSalience まで重くする
  cueWeights: { place: 0.8, person: 1.0, item: 0.5, goal: 1.0, next: 0.8, need: 1.0, heard: 0.5, time: 0.4, question: 1.5, asker: 0.3 },
  personSalience: 0.5, personRadius: 24, maxItemCues: 6, maxHeardCues: 6,
  // 線の重み
  edge: { person: 1.0, with: 0.5, place: 1.0, item: 1.0, family: 0.8, time: 0.5, lmArea: 1.0, lmItem: 1.0, lmFrom: 0.6, areaAdj: 0.3, relation: 0.8 },
  trustedAffinity: 58, // 欲求 (安心・つながり) → 仲の良い人 の線 (needs.js の trustedAffinity と同じ)
  withRadius: 8, maxWith: 3, // 出来事に「一緒にいた人」としてつなぐ距離と人数
  // 上位から1つ広げる (HAM-VLN: 上位3か所から1つ隣、最大5か所)。hubFan より扇の大きい点からは広げない
  seedK: 3, expandMax: 3, hubFan: 25,
  // 使う先ごとの件数 (場所は別に M 番号の一覧から)。must = 必ず入れる最新のやったこと、notes = 失敗のメモの数、maxChars = 記憶の部分の文字数の上限
  budget: {
    llm: { items: 14, must: 2, notes: 2, maxChars: 1300 },
    jev: { items: 8, must: 2, notes: 2, maxChars: 900 },
    answer: { items: 5, must: 0, notes: 1, maxChars: 600, minA: 0.2 },
  },
  // 覚えている場所の一覧 (M 番号) を連想で選ぶか ('assoc') ・近い順か ('near')。nearMin = 近い順で必ず入れる数
  // placeProx: 連想の届かない場所は近いほど上に (得点 + placeProx × exp(−距離/placeScale))
  places: 'assoc', nearMin: 3, placeProx: 0.3, placeScale: 48,
  maxSame: 2, // 同じ行動・引数・成否の出来事は maxSame 件まで (同じことの繰り返しで枠が埋まらないように)
  maxPerPath: 3, // 同じ手がかりから同じ点を経て届いた記憶は、まず maxPerPath 件まで (ほかの手がかりの記憶にも枠を回す)
  explain: true, // 「なぜ思い出したか」を文に付ける
  // 書き込み: 同じ出来事 (同じ種類・行動・引数・成否・場所) が mergeTicks 以内なら1つにまとめ、思い出す回数 (提示) を足す
  mergeTicks: 1500, maxPresent: 8, maxEpisodes: 400, maxNotesPerNode: 4, maxNotes: 200,
  textLen: 80,
};

function mergeCfg(c = {}) {
  const out = { ...DEFAULTS, ...c };
  for (const k of ['cueWeights', 'edge']) out[k] = { ...DEFAULTS[k], ...(c[k] || {}) };
  out.budget = {};
  for (const k of new Set([...Object.keys(DEFAULTS.budget), ...Object.keys(c.budget || {})])) out.budget[k] = { ...(DEFAULTS.budget[k] || {}), ...((c.budget || {})[k] || {}) };
  return out;
}

function clip(s, n) { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function areaOf(pos) { return pos ? `area:${Math.floor(pos.x / AREA)},${Math.floor(pos.z / AREA)}` : null; }
function lmId(p) { return `lm:${p.kind}@${p.x},${p.y},${p.z}`; }
function isNode(id, kind) { return String(id).startsWith(`${kind}:`); }

// 感情のいちばん強いもの (基準値 + 1 を超えたもの)。出来事に「そのときの気持ち」として残す
const EMO_BASE = { joy: 2, sadness: 1, anger: 0, fear: 1, disgust: 0, surprise: 0 };
const EMO_JA = { joy: 'うれしかった', sadness: '悲しかった', anger: '腹が立った', fear: '怖かった', disgust: '嫌だった', surprise: '驚いた' };
const EMO_EN = { joy: 'glad', sadness: 'sad', anger: 'angry', fear: 'scared', disgust: 'disgusted', surprise: 'surprised' };
function dominantEmotion(em) {
  if (!em) return null;
  let best = null; let bv = 1;
  for (const [k, v] of Object.entries(em)) { const d = (Number(v) || 0) - (EMO_BASE[k] ?? 0); if (d > bv) { bv = d; best = k; } }
  return best;
}

class MemGraph {
  constructor(data = null, cfg = {}) {
    this.cfg = mergeCfg(cfg);
    const d = data && typeof data === 'object' ? data : {};
    this.eps = Array.isArray(d.eps) ? d.eps : [];
    this.notes = d.notes && typeof d.notes === 'object' ? d.notes : {};
    this.seq = d.seq || this.eps.reduce((m, e) => Math.max(m, Number(String(e.id).split(':')[1]) || 0), 0);
    this.persons = new Set(Array.isArray(d.persons) ? d.persons : []);
    this.rev = 0;
    this.reindex();
  }

  toJSON() { return { v: 1, seq: this.seq, eps: this.eps, notes: this.notes, persons: [...this.persons] }; }

  reindex() {
    this.byId = new Map();
    this.inv = new Map(); // 点 → [{ to: 出来事の id, w }]
    for (const e of this.eps) this.indexEp(e);
    this.rev += 1;
  }

  indexEp(e) {
    this.byId.set(e.id, e);
    for (const l of e.links || []) {
      if (!this.inv.has(l.id)) this.inv.set(l.id, []);
      this.inv.get(l.id).push({ to: e.id, w: l.w });
      if (isNode(l.id, 'person')) this.persons.add(l.id.slice(7));
    }
  }

  // ---- 書き込み ----
  // ep = { kind: event|heard|knowledge|owned, t, g, imp, ... }。links = [{ id, w, rel }]。同じ出来事が近ければまとめる
  add(ep, links) {
    const C = this.cfg;
    const uniq = [];
    for (const l of links) if (l && l.id && !uniq.some((u) => u.id === l.id)) uniq.push(l);
    const area = (uniq.find((l) => isNode(l.id, 'area')) || {}).id || '';
    const sig = ep.sig || `${ep.kind}|${ep.action || ''}|${ep.arg || ''}|${ep.ok == null ? '' : ep.ok}|${ep.from || ''}|${ep.kind === 'event' ? '' : ep.text}|${area}`;
    const prev = this.eps.slice(-6).reverse().find((e) => e.sig === sig);
    if (prev && Number.isFinite(ep.g) && Number.isFinite(prev.g) && ep.g - prev.g <= C.mergeTicks) {
      prev.n = (prev.n || 1) + 1;
      prev.ts = [...(prev.ts || [prev.t]), ep.t].slice(-C.maxPresent);
      prev.gs = [...(prev.gs || [prev.g]), ep.g].slice(-C.maxPresent);
      prev.t = ep.t; prev.g = ep.g;
      prev.imp = Math.max(prev.imp ?? 0, ep.imp ?? 0);
      if (ep.text) prev.text = ep.text;
      for (const l of uniq) if (!prev.links.some((x) => x.id === l.id)) { prev.links.push(l); if (!this.inv.has(l.id)) this.inv.set(l.id, []); this.inv.get(l.id).push({ to: prev.id, w: l.w }); }
      this.rev += 1;
      return prev;
    }
    this.seq += 1;
    const e = { id: `ep:${this.seq}`, sig, ...ep, links: uniq };
    delete e.sig; e.sig = sig;
    this.eps.push(e);
    this.indexEp(e);
    this.rev += 1;
    return e;
  }

  // 失敗のメモ: 点 (場所・人) に理由を付ける。同じ理由は1つにまとめて回数を数える
  addNote(host, note) {
    if (!host) return null;
    const l = this.notes[host] || (this.notes[host] = []);
    const same = l.find((x) => x.why === note.why && x.text === note.text);
    if (same) { same.n = (same.n || 1) + 1; same.t = note.t; same.g = note.g; same.imp = Math.max(same.imp ?? 0, note.imp ?? 0); this.rev += 1; return same; }
    const x = { ...note, n: 1 };
    l.push(x);
    if (l.length > this.cfg.maxNotesPerNode) l.shift();
    this.rev += 1;
    return x;
  }

  noteCount() { return Object.values(this.notes).reduce((s, l) => s + l.length, 0); }

  // 今の判断で入った出来事の大事さを Jev の remember で上書き (memory.setRecentImportance と同じ範囲)
  setRecentImportance(imp, sinceT) {
    for (const e of this.eps) if (e.t >= sinceT && e.from !== '自分' && (e.kind === 'event' || e.kind === 'heard')) e.imp = Math.max(0, Math.min(1, imp));
  }

  // 上限を超えたら、残りやすさ (新しさ × (0.5 + 大事さ)) の低いものから忘れる。メモも同じ
  enforce(recency) {
    const C = this.cfg;
    let n = 0;
    if (this.eps.length > C.maxEpisodes) {
      const keep = this.eps.map((e) => ({ e, s: recency(e) * (0.5 + (e.imp ?? 0.3)) })).sort((a, b) => b.s - a.s).slice(0, C.maxEpisodes);
      const ids = new Set(keep.map((x) => x.e.id));
      n = this.eps.length - ids.size;
      this.eps = this.eps.filter((e) => ids.has(e.id));
      this.reindex();
    }
    const all = Object.entries(this.notes).flatMap(([h, l]) => l.map((x) => ({ h, x })));
    if (all.length > C.maxNotes) {
      all.sort((a, b) => recency(b.x) * (0.5 + (b.x.imp ?? 0.5)) - recency(a.x) * (0.5 + (a.x.imp ?? 0.5)));
      const drop = new Set(all.slice(C.maxNotes).map((a) => a.x));
      for (const [h, l] of Object.entries(this.notes)) { this.notes[h] = l.filter((x) => !drop.has(x)); if (!this.notes[h].length) delete this.notes[h]; }
    }
    return n;
  }

  // 弱くなった出来事・メモを忘れる (strength(x) < below)
  forget(strength, below) {
    const before = this.eps.length;
    this.eps = this.eps.filter((e) => e.keep || strength(e) >= below);
    if (this.eps.length !== before) this.reindex();
    for (const [h, l] of Object.entries(this.notes)) { this.notes[h] = l.filter((x) => strength(x) >= below); if (!this.notes[h].length) delete this.notes[h]; }
    return before - this.eps.length;
  }
}

// ---- 書き込みの線を作る ----
// now = { pos, people: [{ name, d }], phase, g, emo } (memory.observeNow が入れる)
function placeLinks(now, C) {
  const out = [];
  const a = now && now.pos ? areaOf(now.pos) : null;
  if (a) out.push({ id: a, w: C.edge.place, rel: 'at' });
  if (now && now.phase) out.push({ id: `time:${now.phase}`, w: C.edge.time, rel: 'when' });
  return out;
}
function withLinks(now, C, exclude = new Set()) {
  return ((now && now.people) || []).filter((p) => p && p.name && !exclude.has(p.name) && (p.d == null || p.d <= C.withRadius))
    .sort((a, b) => (a.d ?? 0) - (b.d ?? 0)).slice(0, C.maxWith).map((p) => ({ id: `person:${p.name}`, w: C.edge.with, rel: 'with' }));
}
function itemLinks(names, C, rel = 'what') {
  const out = [];
  for (const n of names) for (const [i, id] of itemNodes(n).entries()) out.push({ id, w: i === 0 ? C.edge.item : C.edge.family, rel });
  return out;
}
function textLinks(text, graph, C, version) {
  return nodesInText(text, { version, people: [...graph.persons] }).map((x) => ({ id: x.node, w: isNode(x.node, 'person') ? C.edge.person : C.edge.item * 0.8, rel: 'mentions' }));
}

// 出来事 (やったこと) → 線
function eventLinks(e, now, graph, C, version) {
  const links = [...placeLinks(now, C)];
  const argStr = String(e.arg || '');
  const parts = argStr.split(/[:@,>]/).filter(Boolean);
  const persons = new Set();
  const known = graph.persons;
  const nearNames = new Set(((now && now.people) || []).map((p) => p.name));
  for (const p of parts) if ((known.has(p) || nearNames.has(p)) && !persons.has(p)) persons.add(p);
  if (e.action === 'wronged' && argStr) persons.add(argStr);
  for (const p of persons) links.push({ id: `person:${p}`, w: C.edge.person, rel: e.action === 'wronged' ? 'by' : 'whom' });
  const items = parts.filter((p) => /^[a-z][a-z0-9_]+$/.test(p) && !/^(here|base|north|south|east|west|northeast|northwest|southeast|southwest|near|far|empty|ripe|unknown|M\d+)$/.test(p) && !/_near$|_far$/.test(p));
  links.push(...itemLinks(items, C));
  for (const l of textLinks(e.msg, graph, C, version)) if (!links.some((x) => x.id === l.id)) links.push(l);
  if (ACTION_CAT[e.action]) links.push({ id: ACTION_CAT[e.action], w: C.edge.item, rel: 'what' });
  links.push(...withLinks(now, C, persons));
  return links;
}

// ---- 手がかり ----
// 1判断の手がかりを作る。o = { raw, goal: goalPath.goal, next: 道筋の次の物, worst: social.worstNeed(), social, me }
const STATE_GOAL_NODES = [[/lit|light|torch/, ['item:torch']], [/wall|pen_|enclos|fence/, ['cat:enclosure']], [/farm|planted/, ['item:farmland']], [/bed|sleep/, ['item:*_bed']], [/base|home|hut/, ['cat:home']], [/chest_(.+)/, null]];
function goalNodes(goal) {
  if (!goal || !goal.target) return [];
  const t = String(goal.target);
  if (goal.kind === 'item') return itemNodes(t);
  if (goal.kind === 'person') return [`person:${t}`];
  if (goal.kind === 'state') {
    const out = [];
    for (const [re, ids] of STATE_GOAL_NODES) { const m = t.match(re); if (m) out.push(...(ids || itemNodes(m[1]))); }
    const pen = t.match(/^pen_(.+)$/); if (pen) out.push(...itemNodes(pen[1]));
    if (!out.length) out.push(...nodesInText(t).map((x) => x.node));
    return out;
  }
  if (goal.kind === 'place') return goal.place && goal.place.pos ? [areaOf(goal.place.pos)] : nodesInText(t).map((x) => x.node);
  return [];
}

function cuesFrom(o = {}, cfg = {}) {
  const C = mergeCfg(cfg);
  const W = C.cueWeights;
  const raw = o.raw || {};
  const self = raw.self || {};
  const out = [];
  const push = (type, node, w, label) => { if (node && w > 0) out.push({ type, node, w, label: label || nodeLabel(node) }); };
  if (self.pos) push('place', areaOf(self.pos), W.place, 'ここ');
  const people = (Array.isArray(raw.people) ? raw.people : (raw.entities || []).filter((e) => e.kind === 'player')).filter((p) => p.name && p.name !== o.me && (p.d == null || p.d <= C.personRadius));
  const rels = (o.social && o.social.relations) || {};
  for (const p of people) {
    const r = rels[p.name];
    const sal = r ? Math.min(1, Math.max(r.grudge ? r.grudge.v || 0 : 0, Math.abs((r.affinity ?? 50) - 50) / 50)) : 0;
    push('person', `person:${p.name}`, W.person * (1 + C.personSalience * sal), p.name);
  }
  const items = [];
  for (const b of raw.blocks || []) if (b.notable) items.push({ name: b.name, d: b.d ?? (b.nearest && self.pos ? Math.hypot(b.nearest.x - self.pos.x, b.nearest.z - self.pos.z) : 99) });
  for (const e of raw.entities || []) if (e.kind === 'hostile' || e.kind === 'mob' || e.kind === 'item') items.push({ name: e.name, d: e.d ?? 99 });
  const seenItems = new Set();
  for (const it of items.sort((a, b) => a.d - b.d)) {
    if (seenItems.has(it.name) || seenItems.size >= C.maxItemCues) continue;
    seenItems.add(it.name);
    push('item', `item:${it.name}`, W.item, nodeLabel(`item:${it.name}`));
  }
  for (const id of goalNodes(o.goal)) push('goal', id, W.goal, nodeLabel(id));
  if (o.next && o.next.item) for (const id of itemNodes(o.next.item).slice(0, 1)) push('next', id, W.next, nodeLabel(id));
  if (o.worst && o.worst.need) push('need', `need:${o.worst.need}`, W.need, NEED_REASON_JA[o.worst.need] || o.worst.label);
  const phase = self.timeOfDay != null ? timePhase(self.timeOfDay) : null;
  if (phase === '夜' || phase === '夕方') push('time', `time:${phase}`, W.time, phase);
  const known = [...new Set([...((o.graph && o.graph.persons) || []), ...Object.keys(rels), ...people.map((p) => p.name)])];
  let nh = 0;
  for (const h of raw.heard || []) {
    if (!h.from || h.from === o.me || nh >= C.maxHeardCues) continue;
    push('heard', `person:${h.from}`, W.heard, h.from); nh += 1;
    for (const x of nodesInText(h.text, { people: known })) { if (nh >= C.maxHeardCues) break; push('heard', x.node, W.heard * 0.8, x.word); nh += 1; }
  }
  // 同じ点が何度も出たら、重みのいちばん大きい手がかりにまとめる (重みは足す)
  const by = new Map();
  for (const c of out) { const p = by.get(c.node); if (!p) by.set(c.node, { ...c }); else { if (c.w > p.w) { p.type = c.type; p.label = c.label; } p.w += c.w; } }
  return { list: [...by.values()], here: self.pos || null, near: people.map((p) => p.name), phase };
}

// 質問の手がかり (聞かれて答えるとき)
function cuesFromQuestion(question, { from = null, known = [], cfg = {} } = {}) {
  const C = mergeCfg(cfg);
  const list = nodesInText(question, { people: known }).map((x) => ({ type: 'question', node: x.node, w: C.cueWeights.question, label: x.word }));
  if (from) list.push({ type: 'asker', node: `person:${from}`, w: C.cueWeights.asker, label: from });
  return { list, here: null, near: [], phase: null, question: true };
}

// ---- 広げる ----
// ctx = { graph, places (memory.places), social, version }
function neighbors(id, ctx, C) {
  const g = ctx.graph;
  const out = [];
  if (isNode(id, 'ep')) { const e = g.byId.get(id); return e ? e.links.map((l) => ({ to: l.id, w: l.w })) : []; }
  for (const x of g.inv.get(id) || []) out.push({ to: x.to, w: x.w });
  if (isNode(id, 'lm')) {
    const p = ctx.lmIndex.get(id);
    if (p) {
      out.push({ to: areaOf(p), w: C.edge.lmArea });
      const kn = PLACE_KIND_NODE[p.kind];
      if (kn) out.push({ to: kn, w: C.edge.lmItem }); else for (const [i, n] of itemNodes(p.kind).entries()) out.push({ to: n, w: i ? C.edge.family : C.edge.lmItem });
      if (p.from) out.push({ to: `person:${p.from}`, w: C.edge.lmFrom });
    }
    return out;
  }
  for (const l of ctx.lmBy.get(id) || []) out.push({ to: l, w: isNode(id, 'area') ? C.edge.lmArea : isNode(id, 'person') ? C.edge.lmFrom : C.edge.lmItem });
  if (isNode(id, 'area')) {
    const [cx, cz] = id.slice(5).split(',').map(Number);
    for (let dx = -1; dx <= 1; dx += 1) for (let dz = -1; dz <= 1; dz += 1) {
      if (!dx && !dz) continue;
      const a = `area:${cx + dx},${cz + dz}`;
      if (g.inv.has(a) || ctx.lmBy.has(a)) out.push({ to: a, w: C.edge.areaAdj });
    }
  } else if (isNode(id, 'item') || isNode(id, 'need') || isNode(id, 'cat')) {
    for (const e of semanticEdges(id, ctx.version)) out.push({ to: e.to, w: e.w });
  }
  if (id === 'need:safety' || id === 'need:connection') {
    for (const [name, r] of Object.entries((ctx.social && ctx.social.relations) || {})) {
      if (r && (r.affinity ?? 50) >= C.trustedAffinity && !(r.grudge && r.grudge.v >= 0.1)) out.push({ to: `person:${name}`, w: C.edge.relation * Math.min(1, ((r.affinity ?? 50) - 50) / 25) });
    }
  }
  return out;
}

function fanFactor(n, C) {
  if (n <= 1) return 1;
  if (C.fan === 'actr') return Math.max(0, (C.S - Math.log(n)) / C.S);
  return 1 / (1 + Math.log(n));
}

// 手がかり → 点ごとの活性 { a, hop, cue, via }
function spread(cues, ctx, C) {
  const act = new Map();
  let frontier = new Map();
  for (const c of cues.list) {
    const p = frontier.get(c.node);
    if (!p) frontier.set(c.node, { a: c.w, hop: 0, cue: c, via: null, best: c.w });
    else { p.a += c.w; if (c.w > p.best) { p.cue = c; p.best = c.w; } }
  }
  for (const [k, v] of frontier) act.set(k, v);
  for (let h = 1; h <= C.maxHops; h += 1) {
    const next = new Map();
    for (const [u, au] of frontier) {
      const nb = neighbors(u, ctx, C);
      const f = fanFactor(nb.length, C) * (h === 1 ? 1 : C.decay);
      for (const e of nb) {
        if (act.has(e.to)) continue;
        const d = au.a * e.w * f;
        if (d < C.minAct) continue;
        const p = next.get(e.to);
        if (!p) next.set(e.to, { a: d, hop: h, cue: au.cue, via: au.hop === 0 ? null : u, viaFrom: u, best: d });
        else { p.a += d; if (d > p.best) { p.best = d; p.cue = au.cue; p.via = au.hop === 0 ? null : u; p.viaFrom = u; } }
      }
    }
    for (const [k, v] of next) act.set(k, v);
    frontier = next;
    if (!frontier.size) break;
  }
  return act;
}

function buildCtx(memory, graph, social) {
  const lmIndex = new Map();
  const lmBy = new Map();
  const add = (k, id) => { if (!lmBy.has(k)) lmBy.set(k, []); lmBy.get(k).push(id); };
  for (const p of memory.places || []) {
    const id = lmId(p);
    lmIndex.set(id, p);
    add(areaOf(p), id);
    const kn = PLACE_KIND_NODE[p.kind];
    if (kn) add(kn, id); else for (const n of itemNodes(p.kind)) add(n, id);
    if (p.from) add(`person:${p.from}`, id);
  }
  return { graph, places: memory.places || [], social, lmIndex, lmBy, version: memory.version };
}

// 1回の連想。返り値 { act, ranked: [{ ep, s, A, R, why }], lms: [{ p, s, A, R, why }], ctx }
function recall(memory, cues, { social = null } = {}) {
  const graph = memory.graph;
  const C = graph.cfg;
  const ctx = buildCtx(memory, graph, social);
  // 手がかりごとに広げ、手がかりごとに「いちばん届いた記憶 = 1」に合わせてから重みを掛けて足す
  //   (1つの強い手がかり (今いる所) が、段数の深い手がかり (作業台 → 板材 → 原木) を押しつぶさないように。
  //    届き方が弱すぎる手がかりは cueFloor × 重み で割って、小さいまま残す)
  const cand = new Set([...graph.eps.map((e) => e.id), ...(memory.places || []).map(lmId)]);
  const act = new Map();
  for (const c of cues.list) {
    const one = spread({ list: [c] }, ctx, C);
    let mx = 0;
    for (const [k, v] of one) if (cand.has(k) && v.a > mx) mx = v.a;
    const den = Math.max(mx, c.w * C.cueFloor);
    for (const [k, v] of one) {
      const n = (v.a / den) * c.w;
      const p = act.get(k);
      if (!p) act.set(k, { ...v, a: n, best: n });
      else { p.a += n; if (n > p.best) { p.best = n; p.cue = v.cue; p.hop = v.hop; p.via = v.via; } }
    }
  }
  const whyOf = (v) => (v ? { type: v.cue.type, label: v.cue.label, node: v.cue.node, hop: v.hop, via: v.via || null } : { type: 'recency', hop: null });
  const embed = typeof memory.embedRelevance === 'function' ? memory.embedRelevance : null; // 埋め込みの関連度の差し込み口 (今は無し)
  const epA = graph.eps.map((e) => (act.get(e.id) || {}).a || 0);
  const maxA = Math.max(C.aFloor, ...epA);
  const ranked = graph.eps.map((e, i) => {
    const v = act.get(e.id);
    const A = epA[i] / maxA;
    const R = memory.recencyOf(e);
    const E = embed ? (embed(e, cues) || 0) : 0;
    return { ep: e, A: r3(A), R: r3(R), s: C.alpha * A + C.beta * R + C.gamma * (e.imp ?? 0.3) + (memory.relevanceCfg && memory.relevanceCfg.embeddingWeight ? memory.relevanceCfg.embeddingWeight * E : 0), why: v ? whyOf(v) : whyOf(null) };
  }).sort((a, b) => b.s - a.s);
  const lmA = (memory.places || []).map((p) => (act.get(lmId(p)) || {}).a || 0);
  const maxL = Math.max(C.aFloor, ...lmA);
  const lms = (memory.places || []).map((p, i) => {
    const v = act.get(lmId(p));
    const R = memory.strength(p, p.lastSeen);
    return { p, A: r3(lmA[i] / maxL), R: r3(R), s: C.alpha * (lmA[i] / maxL) + C.beta * R + C.gamma * (p.imp ?? 0.3), why: v ? whyOf(v) : whyOf(null) };
  }).sort((a, b) => b.s - a.s);
  return { act, ranked, lms, ctx, cues };
}

// 件数を絞る: 最新のやったこと must 件 → 上位 seedK 件 → その1つ隣 (同じ人・場所・物につながる出来事) expandMax 件 → 残りを得点の順。
//   opts.filter(ep) で候補を絞る (答えでは自分の発言を除く など)。opts.minA: 活性がこれ未満のものは入れない (答え)
function choose(memory, rec, budget, opts = {}) {
  const C = memory.graph.cfg;
  const n = budget.items ?? 10;
  const pool = rec.ranked.filter((x) => (opts.filter ? opts.filter(x.ep) : true) && (budget.minA == null || x.A >= budget.minA));
  const chosen = [];
  const has = new Set();
  const same = new Map();
  const sameKey = (e) => (e.kind === 'event' ? `${e.action}|${e.arg}|${e.ok}` : e.kind === 'heard' ? `heard|${e.from}|${e.text}` : e.id);
  const take = (x, why) => {
    if (chosen.length >= n || has.has(x.ep.id)) return;
    const k = sameKey(x.ep);
    if ((same.get(k) || 0) >= (C.maxSame ?? 2) && !(why && why.type === 'must')) return;
    same.set(k, (same.get(k) || 0) + 1);
    has.add(x.ep.id); chosen.push(why ? { ...x, why } : x);
  };
  if (budget.must) {
    const evs = memory.graph.eps.filter((e) => e.kind === 'event' && (opts.filter ? opts.filter(e) : true)).slice(-budget.must);
    for (const e of evs) { const x = rec.ranked.find((r) => r.ep === e); if (x) take(x, x.why.type === 'recency' ? { type: 'must', hop: null } : x.why); }
  }
  const seeds = pool.filter((x) => x.why.type !== 'recency').slice(0, C.seedK);
  for (const x of seeds) take(x);
  // 1つ隣: seed の出来事がつながる点 (扇が hubFan 以下、時刻の点は除く) にもつながる出来事
  const exp = [];
  for (const sd of seeds) {
    for (const l of sd.ep.links) {
      if (isNode(l.id, 'time')) continue;
      const fan = (memory.graph.inv.get(l.id) || []).length;
      if (fan > C.hubFan) continue;
      for (const y of memory.graph.inv.get(l.id) || []) {
        const x = pool.find((r) => r.ep.id === y.to);
        if (x && !has.has(x.ep.id) && !exp.some((z) => z.x === x)) exp.push({ x, via: l.id });
      }
    }
  }
  exp.sort((a, b) => b.x.s - a.x.s);
  for (const { x, via } of exp.slice(0, C.expandMax)) take(x, x.why.type === 'recency' ? { type: 'expand', label: nodeLabel(via), node: via, hop: 1, via } : x.why);
  // 残り: 同じ手がかりの同じ道 (手がかりの点・経由の点) からは maxPerPath 件まで → 枠が余れば上限なしで
  const per = new Map();
  for (const x of chosen) { const k = pathKey(x.why); per.set(k, (per.get(k) || 0) + 1); }
  for (const x of pool) {
    const k = pathKey(x.why);
    if (x.why.type !== 'recency' && (per.get(k) || 0) >= (C.maxPerPath ?? 3)) continue;
    const before = chosen.length;
    take(x);
    if (chosen.length > before) per.set(k, (per.get(k) || 0) + 1);
  }
  for (const x of pool) take(x);
  return chosen;
}
function pathKey(why) { return why ? `${why.type}|${why.node || ''}|${why.via || ''}` : '-'; }

// 失敗のメモ: 思い出された点 (手がかりの点・選んだ記憶がつながる点・選んだ場所) に付いているものだけ
//   同じ出来事から付いたメモ (src) は、その出来事を選んだときは出さない (同じことを2度言わない)。opts.viaChosen: false なら選んだ記憶のつながる先は見ない (答え)
function notesFor(memory, rec, chosen, placeIds, budget, opts = {}) {
  if (!memory.failureNotes || !(budget.notes > 0)) return [];
  const g = memory.graph;
  const hosts = new Map();
  const chosenIds = new Set(chosen.map((x) => x.ep.id));
  for (const c of rec.cues.list) hosts.set(c.node, { type: c.type, label: c.label, node: c.node, hop: 0 });
  if (opts.viaChosen !== false) for (const x of chosen) for (const l of x.ep.links) if (!hosts.has(l.id) && (isNode(l.id, 'area') || isNode(l.id, 'person'))) hosts.set(l.id, { type: 'memory', label: nodeLabel(l.id), node: l.id, hop: 1 });
  for (const pid of placeIds || []) { const p = rec.ctx.lmIndex.get(pid); if (p) { const a = areaOf(p); if (!hosts.has(a)) hosts.set(a, { type: 'place', label: nodeLabel(pid), node: a, hop: 1, lm: pid }); } }
  const out = [];
  for (const [h, why] of hosts) for (const note of g.notes[h] || []) if (!(note.src && chosenIds.has(note.src))) out.push({ host: h, note, why, s: memory.recencyOf(note) * 0.3 + (note.imp ?? 0.5) * 0.3 + ((rec.act.get(h) || {}).a || 0) });
  return out.sort((a, b) => b.s - a.s).slice(0, budget.notes);
}

// ---- 言葉にする ----
function reasonJa(why) {
  if (!why) return '';
  const via = why.via ? `→${nodeLabel(why.via)}` : '';
  switch (why.type) {
    case 'person': return `${why.label}を見て${via}`;
    case 'place': return `ここで${via}`;
    case 'item': return `${why.label}を見て${via}`;
    case 'goal': case 'next': return `${why.label}が要るので${via}`;
    case 'need': return `${why.label}${via}`;
    case 'time': return `${why.label}なので${via}`;
    case 'heard': return `「${why.label}」と聞いて${via}`;
    case 'question': return `「${why.label}」と聞かれて${via}`;
    case 'asker': return `${why.label}に聞かれて${via}`;
    case 'expand': return `${why.label}つながりで`;
    case 'memory': return `${why.label}を思い出して`;
    default: return '';
  }
}
function reasonEn(why) {
  if (!why) return '';
  const via = why.via ? ` -> ${nodeLabel(why.via, 'en')}` : '';
  const L = why.node ? nodeLabel(why.node, 'en') : why.label;
  switch (why.type) {
    case 'person': return `you see ${L}${via}`;
    case 'place': return `you are here${via}`;
    case 'item': return `you see ${L}${via}`;
    case 'goal': case 'next': return `you need ${L}${via}`;
    case 'need': return `${NEED_REASON_EN[String(why.node || '').slice(5)] || L}${via}`;
    case 'time': return `it is ${L}${via}`;
    case 'heard': return `you heard "${why.label}"${via}`;
    case 'question': return `asked about "${why.label}"${via}`;
    case 'asker': return `${why.label} asked${via}`;
    case 'expand': return `linked to ${L}`;
    case 'memory': return `recalling ${L}`;
    default: return '';
  }
}

module.exports = { MemGraph, DEFAULTS, mergeCfg, recall, choose, notesFor, cuesFrom, cuesFromQuestion, eventLinks, placeLinks, withLinks, itemLinks, textLinks,
  areaOf, lmId, spread, neighbors, fanFactor, reasonJa, reasonEn, dominantEmotion, EMO_JA, EMO_EN, goalNodes, clip };
