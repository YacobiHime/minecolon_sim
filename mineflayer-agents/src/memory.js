'use strict';
// 経験で得た知識 (見た場所・行った場所・やったことと結果・聞いた話)。
// 上限つきで持ち、JSON ファイルに保存して再起動後も残す。
const fs = require('fs');
const path = require('path');
const { relDir, dist3, timePhase } = require('./util');
const en = require('./en');
const places = require('./places');
const { Prospects } = require('./prospect');
const assoc = require('./assoc');

// 2つの貯蔵の忘れ方 (Murre & Dros 2015 の2貯蔵モデル。半減期は ゲームの1日 = 人の1日、1時間 = 1000 tick で tick に直した)
//   強さ = (1 − w)·0.5^(経過/h1) + w·0.5^(経過/h2)。h1 = 500 tick (25〜39 分)、h2 = 1,080,000 tick (45 日。8〜100 日)
//   w (長く残る割合) = w0 × 大事さ/impRef (0〜wMax)。w0 = 0.3 (1日後の savings .27〜.34)、聞いた話は 0.2。
//   大事さを w に掛ける形は Yonelinas & Ritchey 2015 (感情的な出来事は 24 時間後に差) から。量 (impRef) は文献に無く仮の値
const DUAL_DEFAULTS = { h1: 500, h2: 1080000, w0: 0.3, heardW0: 0.2, impRef: 0.5, wMax: 0.9, ticksPerLoop: 180 };
function dualStrength(age, imp, w0, c = DUAL_DEFAULTS) {
  const w = Math.max(0, Math.min(c.wMax, (w0 * (imp ?? 0.3)) / c.impRef));
  const a = Math.max(0, age);
  return (1 - w) * Math.pow(0.5, a / c.h1) + w * Math.pow(0.5, a / c.h2);
}

const DEFAULT_LIMITS = {
  places: 40, // 覚えておく場所の数 (古いものから忘れる)
  visited: 20, // 行ったことのある地点
  cells: 300, // 探索のマス (粗い格子) の数。プロンプトには件数を入れない (explore の選択肢の文にだけ使う)
  exploreCell: 16, // 探索のマスの一辺 (ブロック)
  events: 60, // やったことと結果 (保存する数)
  heard: 30, // 聞いた話 (保存する数)
  // プロンプトに入れる数
  promptPlaces: 8,
  promptEvents: 6,
  promptHeard: 5,
  textLen: 80, // 1件の文字数の上限
  // 忘れる記憶 (方針メモ 14章)。promptItems > 0 のとき有効
  knowledge: 30, // 人から教わったこと (誰から・いつ)
  promptItems: 0, // プロンプトに入れる記憶の総数 (場所を含む)。0 = 段階1の固定の数 (promptPlaces など)
  halfLife: 40, // 大事さ 0 の記憶が半分の強さになるまでのループ数
  impBoost: 6, // 大事さ 1 の記憶は halfLife の (1+impBoost) 倍もつ
  forgetBelow: 0.08, // 強さがこれを下回ったら忘れる
  // 行けなかった場所: unreachableFails 回続けて行けなかったら、unreachableTicks ループのあいだ go_to・use_on の行き先に出さない
  unreachableFails: 2,
  unreachableTicks: 60,
};

const CELL = 8;
function agoEn(d) { return d <= 0 ? 'just now' : d === 1 ? 'one turn ago' : d <= 4 ? 'a few turns ago' : d <= 15 ? 'a while ago' : 'long ago'; } // 場所をまとめる格子の大きさ (ブロック)

function clip(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ルールでの大事さ (Jev の Score がないとき): 失敗は少し大事、目標に関わる物の成功はもう少し大事
function ruleImportance(e) {
  if (!e.ok) return 0.35;
  if (/crafting_table|pickaxe|build|hunt|eat|ask/.test(`${e.action}:${e.arg}`)) return 0.5;
  if (e.action === 'look_around' || e.action === 'wait') return 0.05;
  return 0.2;
}

class Memory {
  constructor(opts = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...(opts.limits || {}) };
    this.file = opts.file || null;
    this.places = []; // {kind, x, y, z, lastSeen, firstSeen, n}
    this.visited = []; // {x, y, z, t}
    this.cells = []; // {cx, cz, n, first, t} 探索のマス (exploreCell 四方)。n = 入った回数、t = 最後にいたループ
    this.events = []; // {t, action, arg, ok, msg}
    this.heard = []; // {t, from, text, imp}
    this.knowledge = []; // {t, from, about, text, imp, at} 人から教わったこと
    this.extra = {}; // ほかの部品の状態 (社会性など) を一緒に保存する
    this.tick = 0; // ループの番号 (時刻の代わり)
    this.forgotten = 0; // 忘れた件数 (記録用)
    // 出現地点 (全員に共通の場所の呼び方の基準。places.js)。agent が出現したときに入れる。heardPlaces: 聞いた話から場所を覚えるか
    this.origin = opts.origin || null;
    this.heardPlaces = opts.heardPlaces !== false;
    // あとでやること (prospect.js)。中身は extra.prospects に入れて一緒に保存する。gameNow: 今のゲーム内の時刻 (ワールドの age、tick。agent が入れる)
    this.prospectCfg = opts.prospect || {};
    this.gameNow = null;
    // 連想の記憶 (assoc.js)。retrieval: 'legacy' (今までの選び方) | 'associative' (グラフの連想)。
    //   store: 'single' (判断の回数で1本の指数) | 'dual' (経過 tick で2つの貯蔵)。グラフはどちらでも書く (集計で比べるため)
    this.retrieval = opts.retrieval === 'associative' ? 'associative' : 'legacy';
    this.store = opts.store === 'dual' ? 'dual' : 'single';
    this.failureNotes = opts.failureNotes !== false;
    this.dual = { ...DUAL_DEFAULTS, ...(opts.dual || {}) };
    // 関連度の項 (埋め込みの差し込み口)。relevance.embedding が null なら使わない。足すときは embedRelevance(ep, cues) → 0〜1 を入れ、
    //   relevance.embeddingWeight を得点に掛ける (assoc.recall)。今は実装していないので、null 以外を入れたら止める
    this.relevanceCfg = { embedding: null, embeddingWeight: 0, ...(opts.relevance || {}) };
    this.embedRelevance = null;
    if (this.relevanceCfg.embedding) throw new Error('memory.relevance.embedding はまだ実装していない (差し込み口だけ)');
    this.version = opts.version || undefined;
    this.me = opts.me || null;
    this.assocCfg = opts.assoc || {};
    this.graph = new assoc.MemGraph(null, this.assocCfg);
    this.loopGame = []; // [[判断の番号, ゲームの tick]] (判断の番号 → 経過 tick の換算)
    this.now = null; // 書き込みのときの様子 { pos, people, phase, emo } (observeNow)
    this.cues = null; // 引き出しの手がかり (setCues)
  }

  // ---- 時刻 (判断の番号 → ゲームの tick) ----
  noteGameTime(t, g) {
    if (!Number.isFinite(g)) return;
    const last = this.loopGame[this.loopGame.length - 1];
    if (last && last[0] === t) last[1] = g; else this.loopGame.push([t, g]);
    if (this.loopGame.length > 4000) this.loopGame = this.loopGame.filter((_, i) => i % 2 === 0 || i > this.loopGame.length - 500);
  }

  gameNowOr() { return Number.isFinite(this.gameNow) ? this.gameNow : this.tick * this.dual.ticksPerLoop; }

  gameOf(t) {
    const L = this.loopGame;
    if (!L.length) return this.gameNowOr() - (this.tick - t) * this.dual.ticksPerLoop;
    if (t <= L[0][0]) return L[0][1] - (L[0][0] - t) * this.dual.ticksPerLoop;
    const last = L[L.length - 1];
    if (t >= last[0]) return last[1] + (t - last[0]) * this.dual.ticksPerLoop;
    let lo = 0; let hi = L.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (L[mid][0] <= t) lo = mid; else hi = mid; }
    const [t0, g0] = L[lo]; const [t1, g1] = L[hi];
    return t1 === t0 ? g0 : g0 + ((g1 - g0) * (t - t0)) / (t1 - t0);
  }

  // 聞いた話か (2つの貯蔵の w0 を変える)
  static isHeard(x) { return x && x.kind ? x.kind === 'heard' : !!(x && x.text != null && x.from != null && x.about == null); }

  get prospects() {
    if (!this._prospects || this._prospects.store !== this.extra) this._prospects = new Prospects(this.extra, this.prospectCfg);
    return this._prospects;
  }

  // あとでやることの文 (プロンプト用)。places: M 番号の付いた場所 (同じ番号で呼ぶため)
  laterTexts(here, places = null, lang = 'ja') {
    if (!Number.isFinite(this.gameNow) || !Array.isArray(this.extra.prospects) || !this.extra.prospects.length) return [];
    const opt = { here, places: places || this.placesForPrompt(here) };
    return lang === 'en' ? this.prospects.textsEn(this.gameNow, opt) : this.prospects.textsJa(this.gameNow, opt);
  }

  // 共通の呼び方 (出現地点から北東に120m)。origin が無ければ null
  commonRef(pos, opts = {}) { return places.commonRef(pos, this.origin, opts); }

  static load(file, opts = {}) {
    const m = new Memory({ ...opts, file });
    if (file && fs.existsSync(file)) {
      try {
        const d = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const k of ['places', 'visited', 'cells', 'events', 'heard', 'knowledge']) if (Array.isArray(d[k])) m[k] = d[k];
        m.tick = d.tick || 0;
        if (d.extra && typeof d.extra === 'object') m.extra = d.extra;
        if (Array.isArray(d.loopGame)) m.loopGame = d.loopGame;
        // グラフ: 新しい形のファイルならそのまま、古い形 (graph が無い) なら一覧から作る
        if (d.graph && typeof d.graph === 'object') m.graph = new assoc.MemGraph(d.graph, m.assocCfg);
        else m.importLegacy();
        m.enforceLimits();
      } catch (e) {
        // 壊れたファイルは捨てて空から始める (中身は .bad に退避)
        try { fs.renameSync(file, file + '.bad'); } catch (_) { /* ignore */ }
      }
    }
    return m;
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({
      tick: this.tick, places: this.places, visited: this.visited, cells: this.cells, events: this.events, heard: this.heard,
      knowledge: this.knowledge, extra: this.extra, loopGame: this.loopGame, graph: this.graphJSON(),
    }));
    fs.renameSync(tmp, this.file);
  }

  // 見たもの: 同じ種類で同じ格子 (8x8) のものは1つにまとめる
  // opts.keep = 忘れない (拠点など)。opts.imp = 大事さ
  notePlace(kind, pos, opts = {}) {
    const cx = Math.floor(pos.x / CELL);
    const cz = Math.floor(pos.z / CELL);
    let p = this.places.find((q) => q.kind === kind && Math.floor(q.x / CELL) === cx && Math.floor(q.z / CELL) === cz);
    if (!p) {
      p = { kind, x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z), firstSeen: this.tick, lastSeen: this.tick, n: 0 };
      this.places.push(p);
    }
    p.lastSeen = this.tick;
    p.n += 1;
    // from: 人から聞いた場所 (自分では見ていない)。自分で見たら消す
    if (opts.from) { if (p.n === 1) p.from = opts.from; } else delete p.from;
    if (opts.keep) p.keep = true;
    if (opts.imp != null) p.imp = opts.imp;
    this.enforceLimits();
    return p;
  }

  // 覚えている場所 (pos から CELL 以内) へ行けなかった。unreachableFails 回で印 (unreachableUntil) を付ける。返り値: 印を付けた場所の数
  noteUnreachable(pos, radius = CELL) {
    let n = 0;
    for (const p of this.places) {
      if (p.keep || dist3(p, pos) > radius) continue;
      p.fails = (p.fails || 0) + 1;
      if (p.fails >= (this.limits.unreachableFails ?? 2)) {
        p.unreachableUntil = this.tick + (this.limits.unreachableTicks ?? 60); p.fails = 0; n += 1;
        this.addNote(assoc.areaOf(p), 'unreachable', `${p.kind}の所へ行こうとしたが行けなかった`, `could not get to the ${p.kind} there`, 0.5);
      }
    }
    return n;
  }

  // 着いた (行けた) ので、行けなかった回数を消す
  noteReached(pos, radius = CELL) {
    for (const p of this.places) if (dist3(p, pos) <= radius) { delete p.fails; delete p.unreachableUntil; }
  }

  isUnreachable(p) { return p.unreachableUntil != null && this.tick < p.unreachableUntil; }

  // 以前覚えた場所に行ったが、もう無かった (切った木など)
  //   why: 'gone' (行ったら無かった = 空振り) | 'dug_by_me' (自分で掘った。メモは付けない)
  forgetPlace(kind, pos, radius = CELL, why = 'gone') {
    this.places = this.places.filter((p) => !(p.kind === kind && dist3(p, pos) <= radius));
    // 空振りの失敗のメモ (覚えた場所に物が無かった)。禁止はせず、その場所を思い出したときだけ戻す
    if (pos && why === 'gone') this.addNote(assoc.areaOf(pos), 'gone', `前に${kind}を取りに来たら無かった`, `the ${kind} you remembered there was gone`, 0.5);
  }

  // 失敗のメモを点 (場所・人) に付ける (failureNotes のときだけ)
  addNote(host, why, text, en, imp = 0.5, src = null) {
    if (!this.failureNotes || !host) return null;
    return this.graph.addNote(host, { why, text, ...(en ? { en } : {}), t: this.tick, g: this.gameNowOr(), imp, ...(src ? { src } : {}) });
  }

  noteVisit(pos) {
    const last = this.visited[this.visited.length - 1];
    if (last && dist3(last, pos) < CELL) return;
    this.visited.push({ x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z), t: this.tick });
    this.enforceLimits();
  }

  noteEvent(action, arg, ok, msg, imp = null) {
    const e = { t: this.tick, action, arg: clip(arg, 40), ok: !!ok, msg: clip(msg, this.limits.textLen) };
    e.imp = imp ?? ruleImportance(e);
    this.events.push(e);
    this.enforceLimits();
    this.graphEvent(e);
    return e;
  }

  // ---- グラフへの書き込み (今の記録の入り口から自動で。自分で見た・聞いた・教わったことだけ) ----
  epBase(kind, x) {
    const now = this.now || {};
    const ep = { kind, t: this.tick, g: this.gameNowOr(), imp: x.imp };
    if (now.emo) ep.emo = now.emo;
    if (now.phase) ep.at = now.phase;
    return ep;
  }

  linkLegacy(x, ep) {
    if (!this._legacyOf) { this._legacyOf = new Map(); this._epOf = new WeakMap(); }
    this._legacyOf.set(ep.id, x);
    this._epOf.set(x, ep);
  }

  epOf(x) { return this._epOf ? this._epOf.get(x) || null : null; }

  graphEvent(e) {
    const C = this.graph.cfg;
    const ep = this.graph.add({ ...this.epBase('event', e), action: e.action, arg: e.arg, ok: e.ok, text: e.msg }, assoc.eventLinks(e, this.now, this.graph, C, this.version));
    this.linkLegacy(e, ep);
    // されたこと・死んだ: 人と場所に失敗のメモ
    const area = this.now && this.now.pos ? assoc.areaOf(this.now.pos) : null;
    if (e.action === 'wronged' && e.arg) { this.addNote(`person:${e.arg}`, 'wronged', e.msg, null, e.imp ?? 0.8, ep.id); this.addNote(area, 'wronged', `ここで${e.msg}`, null, e.imp ?? 0.8, ep.id); }
    if (e.action === 'death') this.addNote(area, 'death', `ここで${this.now && this.now.phase ? `${this.now.phase}に` : ''}死んだ`, 'you died here', 0.9, ep.id);
    return ep;
  }

  // 後から付く英語の文・M 番号の場所・大事さ (agent が noteEvent の返り値に足す) をグラフの出来事に写す
  syncLegacy() {
    if (!this._legacyOf) return;
    for (const [id, l] of this._legacyOf) {
      const ep = this.graph.byId.get(id);
      if (!ep) { this._legacyOf.delete(id); continue; }
      if (l.en && ep.en !== l.en) ep.en = l.en;
      if (l.mpos && !ep.mpos) ep.mpos = l.mpos;
      if (l.imp != null && (ep.n || 1) === 1) ep.imp = l.imp;
    }
  }

  graphJSON() { this.syncLegacy(); return this.graph.toJSON(); }

  // 古い形のファイル (グラフが無い): やったこと・聞いた話・教わったことから出来事を作る (場所・一緒にいた人は分からない)
  importLegacy() {
    const g = new assoc.MemGraph(null, this.assocCfg);
    this.graph = g;
    for (const h of this.heard) if (h.from && h.from !== '自分') g.persons.add(h.from);
    for (const k of this.knowledge) if (k.from) g.persons.add(k.from);
    const all = [
      ...this.events.map((x) => ['event', x]), ...this.heard.map((x) => ['heard', x]), ...this.knowledge.map((x) => ['knowledge', x]),
    ].sort((a, b) => (a[1].t ?? 0) - (b[1].t ?? 0));
    for (const [kind, x] of all) {
      const base = { kind, t: x.t ?? 0, g: this.gameOf(x.t ?? 0), imp: x.imp, ...(x.at ? { at: x.at } : {}), imported: true };
      let ep;
      if (kind === 'event') ep = g.add({ ...base, action: x.action, arg: x.arg, ok: x.ok, text: x.msg, ...(x.en ? { en: x.en } : {}), ...(x.mpos ? { mpos: x.mpos } : {}) }, assoc.eventLinks(x, null, g, g.cfg, this.version));
      else if (kind === 'heard') ep = g.add({ ...base, from: x.from, text: x.text, ...(x.global ? { global: true } : {}) }, this.heardLinks(x.from, x.text, x.places || [], null));
      else ep = g.add({ ...base, from: x.from, about: x.about, text: x.text }, this.knowledgeLinks(x.from, x.about, x.text, null));
      this.linkLegacy(x, ep);
    }
    return g.eps.length;
  }

  heardLinks(from, text, placesGot = [], now = this.now) {
    const C = this.graph.cfg;
    const links = [];
    if (from && from !== '自分') { links.push({ id: `person:${from}`, w: C.edge.person, rel: 'said' }); this.graph.persons.add(from); }
    links.push(...assoc.textLinks(text, this.graph, C, this.version));
    for (const p of placesGot) links.push({ id: assoc.areaOf(p), w: C.edge.place, rel: 'about' });
    links.push(...assoc.placeLinks(now, C).map((l) => ({ ...l, w: l.w * 0.5 })));
    return links;
  }

  knowledgeLinks(from, about, text, now = this.now) {
    const C = this.graph.cfg;
    const links = [];
    if (from) links.push({ id: `person:${from}`, w: C.edge.person, rel: 'taught' });
    const parts = String(about || '').split(/[:>@]/).filter((p) => /^[a-z][a-z0-9_]+$/.test(p) && !['hand', 'craft', 'collect', 'build', 'place', 'hunt', 'go_to', 'eat', 'use_on', 'explore', 'search', 'pillar', 'pick_up', 'stuck'].includes(p));
    links.push(...assoc.itemLinks(parts, C));
    links.push(...assoc.textLinks(text, this.graph, C, this.version));
    links.push(...assoc.placeLinks(now, C).map((l) => ({ ...l, w: l.w * 0.5 })));
    return links;
  }

  // 判断のはじめ (観測の直後・覚える前): 書き込みのときの様子 (どこ・誰が近く・時刻・気持ち) と時刻の換算を入れ、所有の知識をグラフに写す。
  //   o = { raw, emotions, me }。見えている人は自分で見た人だけ (部分観測)
  observeNow({ raw = null, emotions = null, me = null } = {}) {
    if (me) this.me = me;
    if (Number.isFinite(this.gameNow)) this.noteGameTime(this.tick, this.gameNow);
    const self = (raw && raw.self) || {};
    const people = raw ? (Array.isArray(raw.people) ? raw.people : (raw.entities || []).filter((e) => e.kind === 'player')).filter((p) => p.name && p.name !== this.me).map((p) => ({ name: p.name, d: p.d })) : [];
    for (const p of people) this.graph.persons.add(p.name);
    this.now = { pos: self.pos || null, people, phase: self.timeOfDay != null ? timePhase(self.timeOfDay) : null, emo: assoc.dominantEmotion(emotions) };
    this.syncOwned();
  }

  // 所有の知識 (extra.owned。ownership.js が持つ) を出来事としてグラフに写す。新しく知った物・様子が変わった物だけ
  syncOwned() {
    const owned = this.extra && this.extra.owned;
    if (!owned || typeof owned !== 'object') return 0;
    const C = this.graph.cfg;
    const idx = this.graph.ownIdx || (this.graph.ownIdx = new Map(this.graph.eps.filter((e) => e.ownKey).map((e) => [e.ownKey, e])));
    let n = 0;
    const SRC = { self: '自分で置いた', seen: '置くのを見た', heard: '聞いた', project: '共有にされた' };
    const ST = { missing: '今は無い', taken: '取られた' };
    for (const [k, o] of Object.entries(owned)) {
      if (!o || !o.block) continue;
      const prev = idx.get(k);
      if (prev && prev.status === o.status && prev.owner === o.owner) continue;
      const pos = Array.isArray(o.pos) ? { x: o.pos[0], y: o.pos[1], z: o.pos[2] } : o.pos;
      const who = o.owner === this.me ? '自分' : o.owner || '誰か';
      const text = `${o.block}(${pos ? `${pos.x},${pos.y},${pos.z}` : '?'})は${who}の物 (${SRC[o.source] || o.source || ''})${ST[o.status] ? `・${ST[o.status]}` : ''}`;
      if (prev) {
        prev.status = o.status; prev.owner = o.owner; prev.text = text;
        prev.ts = [...(prev.ts || [prev.t]), this.tick].slice(-C.maxPresent); prev.gs = [...(prev.gs || [prev.g]), this.gameNowOr()].slice(-C.maxPresent);
        prev.t = this.tick; prev.g = this.gameNowOr(); this.graph.rev += 1;
      } else {
        const links = [...assoc.itemLinks([o.block], C), ...(pos ? [{ id: assoc.areaOf(pos), w: C.edge.place, rel: 'at' }] : [])];
        if (o.owner) links.push({ id: `person:${o.owner}`, w: C.edge.person, rel: 'owner' });
        const ep = this.graph.add({ kind: 'owned', ownKey: k, sig: `owned|${k}`, t: Number.isFinite(o.t) ? o.t : this.tick, g: this.gameOf(Number.isFinite(o.t) ? o.t : this.tick), imp: o.imp ?? 0.6, owner: o.owner, block: o.block, status: o.status, text }, links);
        idx.set(k, ep);
      }
      n += 1;
    }
    return n;
  }

  // 引き出しの手がかりを入れる (判断ごと)。o = { raw, goal, next, worst, social }
  setCues(o = {}) {
    this.cueSocial = o.social || null;
    this.cues = assoc.cuesFrom({ ...o, graph: this.graph, me: this.me }, this.assocCfg);
    this._rec = null;
    return this.cues;
  }

  // 今の手がかりでの連想 (同じ判断の中では使い回す)
  assocRecall() {
    if (!this.cues) this.cues = { list: [], here: null, near: [], phase: null };
    const key = `${this.tick}|${this.graph.rev}|${this.places.length}`;
    if (this._rec && this._rec.cues === this.cues && this._recKey === key) return this._rec;
    this._rec = assoc.recall(this, this.cues, { social: this.cueSocial });
    this._recKey = key;
    return this._rec;
  }

  // opts.global: 全体チャット (board.js) で聞いた。opts.at: ゲーム内の時刻の言葉 (朝・夜など)
  noteHeard(from, text, imp = null, opts = {}) {
    const h = { t: this.tick, from, text: clip(text, this.limits.textLen), imp: imp ?? (from === '自分' ? 0.1 : 0.3) };
    if (opts.global) h.global = true;
    if (opts.at) h.at = opts.at;
    this.heard.push(h);
    // 話に出た場所 (共通の呼び方・座標) を、話した人から聞いた場所として覚える (go_to の候補になる)
    const got = from !== '自分' ? this.learnPlaces(from, text) : [];
    if (got.length) h.places = got;
    this.enforceLimits();
    const ep = this.graph.add({ ...this.epBase('heard', h), from, text: h.text, ...(h.global ? { global: true } : {}), ...(opts.at ? { at: opts.at } : {}) }, this.heardLinks(from, text, got));
    this.linkLegacy(h, ep);
    return h;
  }

  // 文の中の場所を from から聞いた場所として覚える。返り値 [{ kind, x, y, z, how }]
  learnPlaces(from, text) {
    if (!this.heardPlaces || !/\d/.test(String(text))) return [];
    const out = [];
    for (const pl of places.parsePlaces(text, this.origin)) {
      const q = this.notePlace(pl.kind || '聞いた場所', pl.pos, { from, imp: 0.6 });
      out.push({ kind: q.kind, x: q.x, y: q.y, z: q.z, how: pl.how });
    }
    return out;
  }

  // 人から教わったこと。誰から・いつ (ループ番号と、ゲーム内の時刻の言葉) を付けて残す
  noteKnowledge(from, about, text, { imp = 0.8, at = '' } = {}) {
    const k = { t: this.tick, from, about, text: clip(text, this.limits.textLen), imp, at };
    this.knowledge.push(k);
    this.enforceLimits();
    const ep = this.graph.add({ ...this.epBase('knowledge', k), from, about, text: k.text, ...(at ? { at } : {}) }, this.knowledgeLinks(from, about, text));
    this.linkLegacy(k, ep);
    return k;
  }

  // 今のループで入った記憶 (やったこと・聞いた話) の大事さを上書きする (Jev の Score から)
  setRecentImportance(imp, sinceTick = this.tick) {
    let n = 0;
    for (const list of [this.events, this.heard]) {
      for (const x of list) if (x.t >= sinceTick && x.from !== '自分') { x.imp = Math.max(0, Math.min(1, imp)); n += 1; }
    }
    this.graph.setRecentImportance(imp, sinceTick);
    return n;
  }

  // 記憶の強さ: 時間で弱まり、大事なものほどゆっくり弱まる
  //   store 'single': 判断の回数で1本の指数 (今まで)。'dual': 経過 tick で2つの貯蔵 (dualStrength)。t は判断の番号 (ゲームの tick に直す)
  strength(item, t = item.t ?? item.lastSeen ?? 0) {
    const L = this.limits;
    if (this.store === 'dual') {
      const g = item && Number.isFinite(item.g) && t === item.t ? item.g : this.gameOf(t);
      return dualStrength(this.gameNowOr() - g, item.imp ?? 0.3, Memory.isHeard(item) ? this.dual.heardW0 : this.dual.w0, this.dual);
    }
    const age = Math.max(0, this.tick - t);
    return Math.exp((-age * Math.LN2) / (L.halfLife * (1 + L.impBoost * (item.imp ?? 0.3))));
  }

  // グラフの出来事・メモの新しさ (0〜1)。何度も起きた (まとめた) 出来事は、どれか1つの痕が残っている確からしさ 1 − Π(1 − 強さ)
  recencyOf(x) {
    const ts = x.ts || [x.t ?? 0];
    const gs = x.gs || [x.g];
    let miss = 1;
    for (let i = 0; i < ts.length; i += 1) {
      const s = this.store === 'dual'
        ? dualStrength(this.gameNowOr() - (Number.isFinite(gs[i]) ? gs[i] : this.gameOf(ts[i])), x.imp ?? 0.3, x.kind === 'heard' ? this.dual.heardW0 : this.dual.w0, this.dual)
        : Math.exp((-Math.max(0, this.tick - ts[i]) * Math.LN2) / (this.limits.halfLife * (1 + this.limits.impBoost * (x.imp ?? 0.3))));
      miss *= 1 - s;
    }
    return 1 - miss;
  }

  // 弱くなった記憶を忘れる (promptItems > 0 のときだけ。段階1の動きは変えない)
  forget() {
    const L = this.limits;
    if (!(L.promptItems > 0)) return 0;
    let n = 0;
    const keep = (list, tf) => list.filter((x) => { const ok = x.keep || this.strength(x, tf(x)) >= L.forgetBelow; if (!ok) n += 1; return ok; });
    this.events = keep(this.events, (x) => x.t);
    this.heard = keep(this.heard, (x) => x.t);
    this.knowledge = keep(this.knowledge, (x) => x.t);
    this.places = keep(this.places, (x) => x.lastSeen);
    this.forgotten += n;
    // グラフも同じ強さで忘れる。件数の上限を超えたら残りやすさの低いものから (2つの貯蔵では数日で w より下がらないので、量は上限で決まる)
    this.graphForgotten = (this.graphForgotten || 0) + this.graph.forget((x) => this.recencyOf(x), L.forgetBelow) + this.graph.enforce((x) => this.recencyOf(x));
    // 探索のマスも時間で忘れる (忘れた数は forgotten に入れない。記憶の項目ではないので)
    const before = this.cells.length;
    this.cells = this.cells.filter((c) => this.strength(c, c.t) >= L.forgetBelow);
    this.cellsForgotten = (this.cellsForgotten || 0) + (before - this.cells.length);
    return n;
  }

  // 直近 window 件のうち、同じ行動・引数で minFails 回以上失敗したもの ("action:arg" の Set)。
  // 小さいモデルが同じ失敗を繰り返すのを、経験として候補から外すのに使う
  recentFailures(window = 4, minFails = 2) {
    const cnt = new Map();
    for (const e of this.events.slice(-window)) {
      if (e.ok) continue;
      const k = `${e.action}:${e.arg}`;
      cnt.set(k, (cnt.get(k) || 0) + 1);
    }
    return new Set([...cnt].filter(([, n]) => n >= minFails).map(([k]) => k));
  }

  // 探索のマス: 今いるマスを覚える。前のループと違うマスに入ったら n を 1 増やす (同じマスに居続けても増やさない)
  cellOf(pos) { const c = this.limits.exploreCell; return { cx: Math.floor(pos.x / c), cz: Math.floor(pos.z / c) }; }

  cellAt(cx, cz) { return this.cells.find((q) => q.cx === cx && q.cz === cz) || null; }

  noteCell(pos) {
    const { cx, cz } = this.cellOf(pos);
    let c = this.cellAt(cx, cz);
    const entered = !this.lastCell || this.lastCell.cx !== cx || this.lastCell.cz !== cz;
    if (!c) { c = { cx, cz, n: 0, first: this.tick, t: this.tick }; this.cells.push(c); }
    if (entered) c.n += 1;
    c.t = this.tick;
    this.lastCell = { cx, cz };
    this.enforceLimits();
    return c;
  }

  enforceLimits() {
    const L = this.limits;
    if (this.places.length > L.places) {
      // 最後に見たのが古いものから忘れる
      this.places.sort((a, b) => (!!b.keep - !!a.keep) || (b.lastSeen - a.lastSeen));
      this.places.length = L.places;
    }
    if (this.visited.length > L.visited) this.visited.splice(0, this.visited.length - L.visited);
    if (this.cells.length > L.cells) { this.cells.sort((a, b) => b.t - a.t); this.cells.length = L.cells; }
    if (this.events.length > L.events) this.events.splice(0, this.events.length - L.events);
    if (this.heard.length > L.heard) this.heard.splice(0, this.heard.length - L.heard);
    if (this.knowledge.length > L.knowledge) this.knowledge.splice(0, this.knowledge.length - L.knowledge);
    if (this.graph && this.graph.eps.length > this.graph.cfg.maxEpisodes) this.graph.enforce((x) => this.recencyOf(x));
  }

  // ---- 連想での引き出し (retrieval: 'associative') ----
  // 覚えている場所の一覧: 拠点 → 近い順に nearMin → ensure の種類 → 連想の得点の順。並びは 拠点 → 得点の順 (Jev は先頭の数件を使う)
  placesAssoc(here, excludeKindsVisibleNow = new Set(), opts = {}) {
    const C = this.graph.cfg;
    const n = this.limits.promptPlaces;
    const rec = this.assocRecall();
    const sc = new Map(rec.lms.map((x) => [x.p, x]));
    const all = this.places
      .filter((p) => !(excludeKindsVisibleNow.has(p.kind) && dist3(p, here) <= 16))
      .map((p) => { const d = dist3(p, here); const x = sc.get(p) || { s: 0, A: 0, why: { type: 'recency' } }; return { p, d, x: { ...x, s: x.s + (C.placeProx ?? 0) * Math.exp(-d / (C.placeScale || 48)) } }; });
    const picked = [];
    const add = (q) => { if (q && !picked.includes(q) && picked.length < n) picked.push(q); };
    for (const q of all.filter((a) => a.p.keep)) add(q);
    for (const q of all.filter((a) => !a.p.keep).sort((a, b) => a.d - b.d).slice(0, C.nearMin)) add(q);
    for (const k of opts.ensure || []) if (!picked.some((q) => q.p.kind === k)) add(all.filter((a) => a.p.kind === k && !this.isUnreachable(a.p)).sort((a, b) => a.d - b.d)[0]);
    for (const q of [...all].sort((a, b) => b.x.s - a.x.s)) add(q);
    picked.sort((a, b) => (!!b.p.keep - !!a.p.keep) || (b.x.s - a.x.s));
    return picked.map(({ p, d, x }, i) => {
      const ref = this.origin ? this.commonRef(p) : null;
      const un = this.isUnreachable(p);
      const why = x.A > 0 && x.why && x.why.type !== 'recency' && x.why.type !== 'place' ? x.why : null;
      return { id: `M${i + 1}`, kind: p.kind, pos: { x: p.x, y: p.y, z: p.z }, d: Math.round(d), from: p.from || null, ...(un ? { unreachable: true } : {}), ...(why ? { why } : {}), lm: assoc.lmId(p),
        label: `${p.kind}${p.from ? `(${p.from}が言っていた所)` : ''} ${relDir(here, p)}${ref ? `・${ref}` : ''}${un ? '・行けなかった所' : ''}` };
    });
  }

  // LLM・Jev・答えで同じ選び方 (assoc.choose)。kind = 'llm' | 'jev' | 'answer'
  assocSelect(kind, places = [], opts = {}) {
    const C = this.graph.cfg;
    const budget = { ...(C.budget[kind] || C.budget.llm), ...(opts.budget || {}) };
    const rec = opts.rec || this.assocRecall();
    const chosen = assoc.choose(this, rec, budget, { filter: opts.filter || (kind === 'jev' ? (e) => e.from !== '自分' : null) });
    const notes = assoc.notesFor(this, rec, chosen, places.map((p) => p.lm).filter(Boolean), budget);
    return { chosen, notes, rec, budget };
  }

  // 選んだ記憶の内訳 (記録の memSelection に入る): 種類・手がかりの種類・線の段数・失敗のメモ・近くの人に関わる記憶が渡ったか
  selMetrics(items, notes, extra = {}) {
    const m = { mode: this.retrieval, event: 0, heard: 0, knowledge: 0, owned: 0, wronged: 0, note: (notes || []).length, byCue: {}, hops: {}, ...extra };
    for (const x of items) {
      const k = x.ep ? (x.ep.action === 'wronged' ? 'wronged' : x.ep.kind) : x.kind;
      m[k] = (m[k] || 0) + 1;
      const t = (x.why && x.why.type) || 'recency';
      m.byCue[t] = (m.byCue[t] || 0) + 1;
      const h = x.why && x.why.hop != null ? String(x.why.hop) : '-';
      m.hops[h] = (m.hops[h] || 0) + 1;
    }
    // 近くの人 (手がかりの人) のうち、その人に関わる出来事を覚えている人数 n と、そのうち関わる記憶が渡った人数 recalled
    const near = (this.cues && this.cues.near) || [];
    let n = 0; let recalled = 0;
    for (const name of near) {
      if (!(this.graph.inv.get(`person:${name}`) || []).some((y) => this.graph.byId.has(y.to))) continue;
      n += 1;
      if (items.some((x) => { const ep = x.ep || this.epOf(x.x || x); return ep ? ep.links.some((l) => l.id === `person:${name}`) : JSON.stringify(x.x || x).includes(name); })) recalled += 1;
    }
    m.near = { n, recalled };
    return m;
  }

  agoJa(t) { const d = this.tick - t; return d <= 0 ? '今' : `${d}回前`; }

  epTextJa(ep, places) {
    const emo = ep.emo && (ep.imp ?? 0) >= 0.5 && assoc.EMO_JA[ep.emo] ? `・${assoc.EMO_JA[ep.emo]}` : '';
    if (ep.kind === 'event' && ep.action === 'wronged') return `${ep.text} (${this.agoJa(ep.t)}${ep.at ? '・' + ep.at : ''}${emo})`;
    if (ep.kind === 'event') return this.relabelM(`${ep.action}${ep.arg ? '(' + ep.arg + ')' : ''}→${ep.ok ? '成功' : '失敗'}:${ep.text}${ep.n > 1 ? ` (${ep.n}回)` : ''}${emo ? ` (${emo.slice(1)})` : ''}`, ep, places);
    if (ep.kind === 'heard') return ep.from === '自分' ? `自分は${ep.global ? '全員に' : ''}「${ep.text}」と言った (${this.agoJa(ep.t)})` : `${ep.from}は${ep.global ? '全員に' : ''}「${ep.text}」と言っていた (${this.agoJa(ep.t)}${ep.at ? '・' + ep.at : ''})`;
    if (ep.kind === 'knowledge') return `${ep.from}から(${this.agoJa(ep.t)}${ep.at ? '・' + ep.at : ''})「${ep.text}」`;
    return ep.text;
  }

  epTextEn(ep, places) {
    if (ep.kind === 'event' && ep.action === 'wronged') return `${ep.text} (${agoEn(this.tick - ep.t)})`;
    if (ep.kind === 'event') return this.relabelM(ep.en || en.resultEn({ action: ep.action, arg: ep.arg, ok: ep.ok, msg: ep.text }), ep, places, 'en');
    if (ep.kind === 'heard') return `${ep.from === '自分' ? 'you' : ep.from} said${ep.global ? ' to everyone' : ''}「${ep.text}」 (${agoEn(this.tick - ep.t)}${ep.at ? `, ${en.phaseEn(ep.at)}` : ''})`;
    if (ep.kind === 'knowledge') return `from ${ep.from}: 「${ep.text}」`;
    return ep.text;
  }

  // 「なぜ思い出したか」を付ける (explain のとき。最新だから・必ず入れる分には付けない)
  withWhy(text, why, lang = 'ja') {
    if (!this.graph.cfg.explain || !why || why.type === 'recency' || why.type === 'must') return text;
    const r = lang === 'en' ? assoc.reasonEn(why) : assoc.reasonJa(why);
    if (!r) return text;
    return lang === 'en' ? `${text} [recalled: ${r}]` : `〔${r}〕${text}`;
  }

  assocPromptText(here, opts = {}) {
    const places = opts.places || this.placesForPrompt(here);
    const sel = this.assocSelect('llm', places);
    const build = (chosen) => {
      const lines = [];
      lines.push('覚えている場所: ' + (places.length ? places.map((p) => this.withWhy(`${p.id}=${p.label}`, p.why)).join(', ') : 'なし'));
      const sorted = [...chosen].sort((a, b) => a.ep.t - b.ep.t);
      const sec = (f) => sorted.filter((x) => f(x.ep)).map((x) => this.withWhy(this.epTextJa(x.ep, places), x.why));
      const ev = sec((e) => e.kind === 'event' && e.action !== 'wronged');
      lines.push('やったこと: ' + (ev.length ? ev.join(' / ') : 'まだ何もしていない'));
      const wr = sec((e) => e.kind === 'event' && e.action === 'wronged');
      if (wr.length) lines.push('されたこと: ' + wr.join(' / '));
      const hd = sec((e) => e.kind === 'heard');
      if (hd.length) lines.push('聞いた話: ' + hd.join(' '));
      const kn = sec((e) => e.kind === 'knowledge');
      if (kn.length) lines.push('教わったこと: ' + kn.join(' '));
      const ow = sec((e) => e.kind === 'owned');
      if (ow.length) lines.push('持ち主: ' + ow.join(' / '));
      if (sel.notes.length) lines.push('気をつけること: ' + sel.notes.map((x) => this.withWhy(`${x.note.text}${x.note.n > 1 ? ` (${x.note.n}回)` : ''}`, x.why)).join(' / '));
      const later = this.laterTexts(here, places);
      if (later.length) lines.push('あとでやること: ' + later.join(' / '));
      return lines.join('\n');
    };
    let chosen = sel.chosen;
    let text = build(chosen);
    while (text.length > sel.budget.maxChars && chosen.some((x) => x.why.type !== 'must')) {
      let j = chosen.length - 1;
      while (j >= 0 && chosen[j].why.type === 'must') j -= 1;
      chosen = chosen.filter((_, i) => i !== j);
      text = build(chosen);
    }
    this.lastSelection = { places: places.length, ...this.selMetrics(chosen, sel.notes, { chars: text.length, placesWhy: places.filter((p) => p.why).length }), ...(this.lastSelectionJev ? { jev: this.lastSelectionJev } : {}) };
    return text;
  }

  assocStateEn(here, opts = {}) {
    const { maxPlaces = 4 } = opts;
    const places = (opts.places || this.placesForPrompt(here)).slice(0, maxPlaces);
    const sel = this.assocSelect('jev', opts.places || places);
    const build = (chosen) => {
      const out = {};
      out.places = places.length ? places.map((p) => this.withWhy(`${p.id}=${en.placeKindEn(p.kind)} (${en.whereEn(here, p.pos)}${p.from ? `; ${p.from} said so` : ''})`, p.why, 'en')).join('; ') : 'none';
      const sorted = [...chosen].sort((a, b) => a.ep.t - b.ep.t);
      const sec = (f) => sorted.filter((x) => f(x.ep)).map((x) => this.withWhy(this.epTextEn(x.ep, places), x.why, 'en'));
      const ev = sec((e) => e.kind === 'event' && e.action !== 'wronged');
      out.recent = ev.length ? ev : 'nothing yet';
      const wr = sec((e) => e.kind === 'event' && e.action === 'wronged');
      if (wr.length) out.done_to_me = wr;
      const hd = sec((e) => e.kind === 'heard');
      if (hd.length) out.heard = hd.join(' ');
      const kn = sec((e) => e.kind === 'knowledge');
      if (kn.length) out.taught = kn.join(' ');
      const ow = sec((e) => e.kind === 'owned');
      if (ow.length) out.owners = ow;
      if (sel.notes.length) out.caution = sel.notes.map((x) => this.withWhy(x.note.en || x.note.text, x.why, 'en'));
      const later = this.laterTexts(here, places, 'en');
      if (later.length) out.later = later;
      return out;
    };
    let chosen = sel.chosen;
    let out = build(chosen);
    while (JSON.stringify(out).length > sel.budget.maxChars && chosen.some((x) => x.why.type !== 'must')) {
      let j = chosen.length - 1;
      while (j >= 0 && chosen[j].why.type === 'must') j -= 1;
      chosen = chosen.filter((_, i) => i !== j);
      out = build(chosen);
    }
    this.lastSelectionJev = { places: places.length, ...this.selMetrics(chosen, sel.notes, { chars: JSON.stringify(out).length }) };
    return out;
  }

  // 聞かれて答える: 質問の中の人・物・場所・欲求の言葉を手がかりに連想する (ask.relevantMemories から)。
  //   返り値 [{ kind, text, why, hop, mpos? }]。手がかりが無いか、手がかりから届いた記憶が無ければ空 (→「分からない」)
  recallForAnswer(question, { from = null } = {}) {
    const known = [...new Set([...this.graph.persons, ...Object.keys((this.cueSocial && this.cueSocial.relations) || {})])].filter((n) => n !== this.me);
    const cues = assoc.cuesFromQuestion(question, { from, known, cfg: this.assocCfg });
    if (!cues.list.some((c) => c.type === 'question')) { this.lastAnswerSelection = { mode: 'associative', cues: 0, items: 0 }; return []; }
    const rec = assoc.recall(this, cues, { social: this.cueSocial });
    const C = this.graph.cfg;
    const budget = C.budget.answer;
    const minA = budget.minA ?? 0.05;
    // 質問の手がかりから届いたものだけ (聞いた人からだけ届いたもの・最新なだけのものは除く)
    const fromQ = (x) => x.why && x.why.type === 'question' && x.A >= minA;
    const sel = this.assocSelect('answer', [], { rec, filter: (e) => e.from !== '自分' && !(e.kind === 'event' && e.action === 'wronged') });
    const chosen = sel.chosen.filter(fromQ);
    const items = [];
    const placeItems = rec.lms.filter((x) => x.why.type === 'question' && x.A >= minA).slice(0, 2);
    const T = (ep) => {
      if (ep.kind === 'event') return `${ep.action}(${ep.arg})で${ep.ok ? '成功' : '失敗'}: ${ep.text}`;
      if (ep.kind === 'knowledge') return `${ep.from}に聞いた: ${ep.text}`;
      if (ep.kind === 'heard') return `${ep.from}が「${ep.text}」と言っていた`;
      return ep.text;
    };
    for (const x of chosen) items.push({ kind: x.ep.kind, text: T(x.ep), why: x.why.label, hop: x.why.hop, ...(x.ep.mpos ? { mpos: x.ep.mpos } : {}) });
    for (const x of placeItems) {
      const p = x.p;
      items.push({ kind: 'place', text: `${p.kind}を${this.origin ? `${places.commonRef(p, this.origin)} ` : ''}(${p.x},${p.y},${p.z})あたりで${p.from ? `見たと${p.from}が言っていた` : '見た'}`, why: x.why.label, hop: x.why.hop });
    }
    const placeIds = placeItems.map((x) => assoc.lmId(x.p));
    for (const nt of assoc.notesFor(this, rec, chosen, placeIds, budget, { viaChosen: false })) items.push({ kind: 'note', text: nt.note.text, why: nt.why.label, hop: nt.why.hop });
    const out = items.slice(0, Math.max(budget.items, 1) + 1);
    this.lastAnswerSelection = { mode: 'associative', cues: cues.list.length, items: out.length, byHop: out.reduce((m, x) => { const k = String(x.hop ?? '-'); m[k] = (m[k] || 0) + 1; return m; }, {}) };
    return out;
  }

  // プロンプト用: 今いる場所から近い順に、上限の数だけ。id を付ける (go_to の引数になる)
  // opts.ensure: 一覧に必ず1つ入れる種類 (近い順で枠から漏れたら、いちばん遠い (忘れない場所でない) ものと入れ替える。例 ['water'])
  //   行けなかった印の付いている場所 (noteUnreachable) は unreachable: true にする (go_to・use_on の行き先に出さない)
  placesForPrompt(here, excludeKindsVisibleNow = new Set(), opts = {}) {
    if (this.retrieval === 'associative' && this.cues && this.graph.cfg.places === 'assoc') return this.placesAssoc(here, excludeKindsVisibleNow, opts);
    const all = this.places
      .filter((p) => !(excludeKindsVisibleNow.has(p.kind) && dist3(p, here) <= 16))
      .map((p) => ({ ...p, d: dist3(p, here) }))
      .sort((a, b) => (!!b.keep - !!a.keep) || (a.d - b.d)); // 忘れない場所 (拠点) は必ず入れる
    const list = all.slice(0, this.limits.promptPlaces);
    for (const k of opts.ensure || []) {
      if (list.some((p) => p.kind === k)) continue;
      const add = all.find((p) => p.kind === k && !this.isUnreachable(p));
      if (!add) continue;
      let j = list.length - 1;
      while (j >= 0 && (list[j].keep || (opts.ensure || []).includes(list[j].kind))) j -= 1;
      if (list.length < this.limits.promptPlaces) list.push(add);
      else if (j >= 0) { list.splice(j, 1); list.push(add); }
    }
    list.sort((a, b) => (!!b.keep - !!a.keep) || (a.d - b.d));
    return list.map((p, i) => {
      const ref = this.origin ? this.commonRef(p) : null;
      const un = this.isUnreachable(p);
      return { id: `M${i + 1}`, kind: p.kind, pos: { x: p.x, y: p.y, z: p.z }, d: Math.round(p.d), from: p.from || null, ...(un ? { unreachable: true } : {}),
        label: `${p.kind}${p.from ? `(${p.from}が言っていた所)` : ''} ${relDir(here, p)}${ref ? `・${ref}` : ''}${un ? '・行けなかった所' : ''}` };
    });
  }

  // 記憶の選び方 (promptItems > 0): 場所は近い順に promptPlaces まで、残りの枠を
  // やったこと・聞いた話・教わったことから「強さ x (0.5 + 大事さ)」の高い順に選ぶ。最新の2件のやったことは必ず入れる
  selectForPrompt(places) {
    const L = this.limits;
    const budget = Math.max(0, L.promptItems - places.length);
    const cands = [
      ...this.events.map((x, i) => ({ kind: 'event', x, s: this.strength(x) * (0.5 + (x.imp ?? 0.3)), must: i >= this.events.length - 2 })),
      ...this.heard.map((x) => ({ kind: 'heard', x, s: this.strength(x) * (0.5 + (x.imp ?? 0.3)) })),
      ...this.knowledge.map((x) => ({ kind: 'knowledge', x, s: this.strength(x) * (0.5 + (x.imp ?? 0.8)) + 0.2 })),
    ];
    const must = cands.filter((c) => c.must);
    const rest = cands.filter((c) => !c.must).sort((a, b) => b.s - a.s);
    const chosen = [...must, ...rest].slice(0, budget);
    // 時刻の順に並べ直す (古い → 新しい)
    chosen.sort((a, b) => a.x.t - b.x.t);
    return chosen;
  }

  // Jev 用の英語の記憶 (toPromptText と同じ記憶から)。件数を絞る: 場所 maxPlaces・やったこと maxEvents (新しい順)・
  //   聞いた話 maxHeard (発言の中身は原文のまま)・教わったこと maxTaught。やったことの文は e.en (agent が英語で残す) か msgEn
  toStateEn(here, opts = {}) {
    if (this.retrieval === 'associative') return this.assocStateEn(here, opts);
    const { maxPlaces = 4, maxEvents = 5, maxHeard = 3, maxTaught = 2 } = opts;
    const places = (opts.places || this.placesForPrompt(here)).slice(0, maxPlaces);
    const out = {};
    out.places = places.length ? places.map((p) => `${p.id}=${en.placeKindEn(p.kind)} (${en.whereEn(here, p.pos)}${p.from ? `; ${p.from} said so` : ''})`).join('; ') : 'none';
    const evs = this.events.slice(-maxEvents);
    out.recent = evs.length ? evs.map((e) => this.relabelM(e.en || en.resultEn({ action: e.action, arg: e.arg, ok: e.ok, msg: e.msg }), e, places, 'en')) : 'nothing yet';
    const hd = this.heard.filter((h) => h.from !== '自分').slice(-maxHeard);
    // 「Taro は〜と言っていた (いつ)」の形。いつ = 何判断前 (言葉) と、聞いたときのゲーム内の時刻
    if (hd.length) out.heard = hd.map((h) => `${h.from} said${h.global ? ' to everyone' : ''}「${h.text}」 (${agoEn(this.tick - h.t)}${h.at ? `, ${en.phaseEn(h.at)}` : ''})`).join(' ');
    const kn = this.knowledge.slice(-maxTaught);
    if (kn.length) out.taught = kn.map((k) => `from ${k.from}: 「${k.text}」`).join(' ');
    const later = this.laterTexts(here, places, 'en');
    if (later.length) out.later = later; // あとでやること (prospect.js)
    // 比べるための内訳 (手がかりがあるときだけ。文は変えない)
    if (this.cues) this.lastSelectionJev = { places: places.length, ...this.selMetrics([...evs, ...hd, ...kn].map((x) => ({ x, ep: this.epOf(x), kind: x.about != null ? 'knowledge' : x.text != null ? 'heard' : 'event', why: { type: 'recency' } })), [], { chars: JSON.stringify(out).length }) };
    return out;
  }

  // 出来事の文の M 番号は、その出来事のときの番号 (e.mpos に場所が残っている)。今の一覧 (places) で同じ場所の番号に付け直し、
  //   今の一覧に無ければ共通の呼び方 (出現地点から北に60m の所) にする。場所が残っていない番号はそのまま
  relabelM(text, e, plist, lang = 'ja') {
    const mp = e && e.mpos;
    if (!mp) return text;
    return String(text).replace(/(?<![A-Za-z0-9_])M([0-9]{1,2})(?![0-9])/g, (m) => {
      const pos = mp[m];
      if (!pos) return m;
      const cur = (plist || []).find((p) => p.pos && Math.abs(p.pos.x - pos.x) <= 1 && Math.abs(p.pos.z - pos.z) <= 1 && Math.abs((p.pos.y ?? 0) - (pos.y ?? 0)) <= 2);
      if (cur) return cur.id;
      const ref = this.origin ? places.commonRef(pos, this.origin, { lang }) : null;
      return ref ? (lang === 'en' ? `(${ref})` : `(${ref}の所)`) : m;
    });
  }

  toPromptText(here, opts = {}) {
    const L = this.limits;
    const lines = [];
    if (this.retrieval === 'associative') return this.assocPromptText(here, opts);
    if (L.promptItems > 0) {
      const places = opts.places || this.placesForPrompt(here);
      const chosen = this.selectForPrompt(places);
      this.lastSelection = { places: places.length, event: 0, heard: 0, knowledge: 0 };
      for (const c of chosen) this.lastSelection[c.kind] += 1;
      lines.push('覚えている場所: ' + (places.length ? places.map((p) => `${p.id}=${p.label}`).join(', ') : 'なし'));
      const ago = (t) => { const d = this.tick - t; return d <= 0 ? '今' : `${d}回前`; };
      const ev = chosen.filter((c) => c.kind === 'event').map((c) => c.x);
      lines.push('やったこと: ' + (ev.length ? ev.map((e) => this.relabelM(`${e.action}${e.arg ? '(' + e.arg + ')' : ''}→${e.ok ? '成功' : '失敗'}:${e.msg}`, e, places)).join(' / ') : 'まだ何もしていない'));
      const hd = chosen.filter((c) => c.kind === 'heard').map((c) => c.x);
      if (hd.length) lines.push('聞いた話: ' + hd.map((h) => `${h.from}は${h.global ? '全員に' : ''}「${h.text}」と言っていた (${ago(h.t)}${h.at ? '・' + h.at : ''})`).join(' '));
      const kn = chosen.filter((c) => c.kind === 'knowledge').map((c) => c.x);
      if (kn.length) lines.push('教わったこと: ' + kn.map((k) => `${k.from}から(${ago(k.t)}${k.at ? '・' + k.at : ''})「${k.text}」`).join(' '));
      const later = this.laterTexts(here, places);
      if (later.length) lines.push('あとでやること: ' + later.join(' / '));
      const text = lines.join('\n');
      // 比べるための内訳 (手がかりがあるときだけ。選び方と文は変えない)
      if (this.cues) {
        const m = this.selMetrics(chosen.map((c) => ({ x: c.x, ep: this.epOf(c.x), kind: c.kind, why: { type: c.must ? 'must' : 'recency' } })), [], { chars: text.length });
        this.lastSelection = { ...this.lastSelection, mode: m.mode, byCue: m.byCue, near: m.near, chars: m.chars, ...(this.lastSelectionJev ? { jev: this.lastSelectionJev } : {}) };
      }
      return text;
    }
    const places = opts.places || this.placesForPrompt(here);
    lines.push('覚えている場所: ' + (places.length ? places.map((p) => `${p.id}=${p.label}`).join(', ') : 'なし'));
    const ev = this.events.slice(-L.promptEvents);
    lines.push('最近やったこと: ' + (ev.length
      ? ev.map((e) => `${e.action}${e.arg ? '(' + e.arg + ')' : ''}→${e.ok ? '成功' : '失敗'}:${e.msg}`).join(' / ')
      : 'まだ何もしていない'));
    const hd = this.heard.slice(-L.promptHeard);
    lines.push('前に聞いた話: ' + (hd.length ? hd.map((h) => `${h.from}「${h.text}」`).join(' ') : 'なし'));
    const later = this.laterTexts(here, places);
    if (later.length) lines.push('あとでやること: ' + later.join(' / '));
    return lines.join('\n');
  }
}

module.exports = { Memory, DEFAULT_LIMITS, CELL, ruleImportance, dualStrength, DUAL_DEFAULTS };
