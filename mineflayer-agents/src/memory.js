'use strict';
// 経験で得た知識 (見た場所・行った場所・やったことと結果・聞いた話)。
// 上限つきで持ち、JSON ファイルに保存して再起動後も残す。
const fs = require('fs');
const path = require('path');
const { relDir, dist3 } = require('./util');
const en = require('./en');
const places = require('./places');
const { Prospects } = require('./prospect');

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
  }

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
      knowledge: this.knowledge, extra: this.extra,
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
      if (p.fails >= (this.limits.unreachableFails ?? 2)) { p.unreachableUntil = this.tick + (this.limits.unreachableTicks ?? 60); p.fails = 0; n += 1; }
    }
    return n;
  }

  // 着いた (行けた) ので、行けなかった回数を消す
  noteReached(pos, radius = CELL) {
    for (const p of this.places) if (dist3(p, pos) <= radius) { delete p.fails; delete p.unreachableUntil; }
  }

  isUnreachable(p) { return p.unreachableUntil != null && this.tick < p.unreachableUntil; }

  // 以前覚えた場所に行ったが、もう無かった (切った木など)
  forgetPlace(kind, pos, radius = CELL) {
    this.places = this.places.filter((p) => !(p.kind === kind && dist3(p, pos) <= radius));
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
    return e;
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
    return k;
  }

  // 今のループで入った記憶 (やったこと・聞いた話) の大事さを上書きする (Jev の Score から)
  setRecentImportance(imp, sinceTick = this.tick) {
    let n = 0;
    for (const list of [this.events, this.heard]) {
      for (const x of list) if (x.t >= sinceTick && x.from !== '自分') { x.imp = Math.max(0, Math.min(1, imp)); n += 1; }
    }
    return n;
  }

  // 記憶の強さ: 時間で弱まり、大事なものほどゆっくり弱まる
  strength(item, t = item.t ?? item.lastSeen ?? 0) {
    const L = this.limits;
    const age = Math.max(0, this.tick - t);
    return Math.exp((-age * Math.LN2) / (L.halfLife * (1 + L.impBoost * (item.imp ?? 0.3))));
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
  }

  // プロンプト用: 今いる場所から近い順に、上限の数だけ。id を付ける (go_to の引数になる)
  // opts.ensure: 一覧に必ず1つ入れる種類 (近い順で枠から漏れたら、いちばん遠い (忘れない場所でない) ものと入れ替える。例 ['water'])
  //   行けなかった印の付いている場所 (noteUnreachable) は unreachable: true にする (go_to・use_on の行き先に出さない)
  placesForPrompt(here, excludeKindsVisibleNow = new Set(), opts = {}) {
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
      return lines.join('\n');
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

module.exports = { Memory, DEFAULT_LIMITS, CELL, ruleImportance };
