'use strict';
// 経験で得た知識 (見た場所・行った場所・やったことと結果・聞いた話)。
// 上限つきで持ち、JSON ファイルに保存して再起動後も残す。
const fs = require('fs');
const path = require('path');
const { relDir, dist3 } = require('./util');

const DEFAULT_LIMITS = {
  places: 40, // 覚えておく場所の数 (古いものから忘れる)
  visited: 20, // 行ったことのある地点
  events: 60, // やったことと結果 (保存する数)
  heard: 30, // 聞いた話 (保存する数)
  // プロンプトに入れる数
  promptPlaces: 8,
  promptEvents: 6,
  promptHeard: 5,
  textLen: 80, // 1件の文字数の上限
};

const CELL = 8; // 場所をまとめる格子の大きさ (ブロック)

function clip(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

class Memory {
  constructor(opts = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...(opts.limits || {}) };
    this.file = opts.file || null;
    this.places = []; // {kind, x, y, z, lastSeen, firstSeen, n}
    this.visited = []; // {x, y, z, t}
    this.events = []; // {t, action, arg, ok, msg}
    this.heard = []; // {t, from, text}
    this.tick = 0; // ループの番号 (時刻の代わり)
  }

  static load(file, opts = {}) {
    const m = new Memory({ ...opts, file });
    if (file && fs.existsSync(file)) {
      try {
        const d = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const k of ['places', 'visited', 'events', 'heard']) if (Array.isArray(d[k])) m[k] = d[k];
        m.tick = d.tick || 0;
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
      tick: this.tick, places: this.places, visited: this.visited, events: this.events, heard: this.heard,
    }));
    fs.renameSync(tmp, this.file);
  }

  // 見たもの: 同じ種類で同じ格子 (8x8) のものは1つにまとめる
  notePlace(kind, pos) {
    const cx = Math.floor(pos.x / CELL);
    const cz = Math.floor(pos.z / CELL);
    let p = this.places.find((q) => q.kind === kind && Math.floor(q.x / CELL) === cx && Math.floor(q.z / CELL) === cz);
    if (!p) {
      p = { kind, x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z), firstSeen: this.tick, lastSeen: this.tick, n: 0 };
      this.places.push(p);
    }
    p.lastSeen = this.tick;
    p.n += 1;
    this.enforceLimits();
    return p;
  }

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

  noteEvent(action, arg, ok, msg) {
    this.events.push({ t: this.tick, action, arg: clip(arg, 40), ok: !!ok, msg: clip(msg, this.limits.textLen) });
    this.enforceLimits();
  }

  noteHeard(from, text) {
    this.heard.push({ t: this.tick, from, text: clip(text, this.limits.textLen) });
    this.enforceLimits();
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

  enforceLimits() {
    const L = this.limits;
    if (this.places.length > L.places) {
      // 最後に見たのが古いものから忘れる
      this.places.sort((a, b) => b.lastSeen - a.lastSeen);
      this.places.length = L.places;
    }
    if (this.visited.length > L.visited) this.visited.splice(0, this.visited.length - L.visited);
    if (this.events.length > L.events) this.events.splice(0, this.events.length - L.events);
    if (this.heard.length > L.heard) this.heard.splice(0, this.heard.length - L.heard);
  }

  // プロンプト用: 今いる場所から近い順に、上限の数だけ。id を付ける (go_to の引数になる)
  placesForPrompt(here, excludeKindsVisibleNow = new Set()) {
    return this.places
      .filter((p) => !(excludeKindsVisibleNow.has(p.kind) && dist3(p, here) <= 16))
      .map((p) => ({ ...p, d: dist3(p, here) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, this.limits.promptPlaces)
      .map((p, i) => ({ id: `M${i + 1}`, kind: p.kind, pos: { x: p.x, y: p.y, z: p.z }, d: Math.round(p.d), label: `${p.kind} ${relDir(here, p)}` }));
  }

  toPromptText(here, opts = {}) {
    const L = this.limits;
    const lines = [];
    const places = opts.places || this.placesForPrompt(here);
    lines.push('覚えている場所: ' + (places.length ? places.map((p) => `${p.id}=${p.label}`).join(', ') : 'なし'));
    const ev = this.events.slice(-L.promptEvents);
    lines.push('最近やったこと: ' + (ev.length
      ? ev.map((e) => `${e.action}${e.arg ? '(' + e.arg + ')' : ''}→${e.ok ? '成功' : '失敗'}:${e.msg}`).join(' / ')
      : 'まだ何もしていない'));
    const hd = this.heard.slice(-L.promptHeard);
    lines.push('前に聞いた話: ' + (hd.length ? hd.map((h) => `${h.from}「${h.text}」`).join(' ') : 'なし'));
    return lines.join('\n');
  }
}

module.exports = { Memory, DEFAULT_LIMITS, CELL };
