'use strict';
// 誰がどこへ行ったか (踏破したマス) を、同じ実行の全員で分け合う (run.js の記録の場所 runs/<id>/explored/<名前>.json)。
//   プロセスをまたいでも同じ記録の場所を使う。publish: 自分のマス (memory.cells) と今いる所を書く (writeEvery 判断ごと)。
//   load: ほかの人のファイルを読む (readEvery 判断ごと)。merged(): 全員のマスを合わせた [{ cx, cz, n, who: [名前], at }]
//   cfg.act.explore.scope が 'all' のとき、explore の「まだ行っていない」「行ったか」を全員の踏破で決める (explore.js)。
const fs = require('fs');
const path = require('path');

class SharedExplore {
  constructor({ dir, name, writeEvery = 5, readEvery = 5, staleMs = 10 * 60 * 1000 } = {}) {
    this.dir = dir; this.name = name; this.writeEvery = writeEvery; this.readEvery = readEvery; this.staleMs = staleMs;
    this.others = new Map(); // 名前 → { cells, pos, at }
    this.lastWrite = -Infinity; this.lastRead = -Infinity;
    if (dir) { try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* ignore */ } }
  }

  publish(tick, cells, pos, { force = false } = {}) {
    if (!this.dir || (!force && tick - this.lastWrite < this.writeEvery)) return false;
    this.lastWrite = tick;
    const f = path.join(this.dir, `${this.name}.json`);
    const body = JSON.stringify({ name: this.name, at: Date.now(), pos: pos ? { x: Math.round(pos.x), z: Math.round(pos.z) } : null, cells: (cells || []).map((c) => [c.cx, c.cz, c.n]) });
    try { fs.writeFileSync(`${f}.tmp`, body); fs.renameSync(`${f}.tmp`, f); } catch (_) { return false; }
    return true;
  }

  load(tick, { force = false } = {}) {
    if (!this.dir || (!force && tick - this.lastRead < this.readEvery)) return false;
    this.lastRead = tick;
    let files = [];
    try { files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')); } catch (_) { return false; }
    for (const f of files) {
      const who = f.replace(/\.json$/, '');
      if (who === this.name) continue;
      try {
        const d = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
        this.others.set(who, { cells: d.cells || [], pos: d.pos || null, at: d.at || 0 });
      } catch (_) { /* 書きかけ */ }
    }
    this.merged = null;
    return true;
  }

  // 全員 (自分を含む) のマス。mine = memory.cells
  merge(mine = []) {
    const m = new Map();
    const add = (cx, cz, n, who) => {
      const k = `${cx},${cz}`;
      let c = m.get(k);
      if (!c) { c = { cx, cz, n: 0, who: [] }; m.set(k, c); }
      c.n += n; if (!c.who.includes(who)) c.who.push(who);
    };
    for (const c of mine) add(c.cx, c.cz, c.n || 1, this.name);
    for (const [who, o] of this.others) for (const [cx, cz, n] of o.cells) add(cx, cz, n || 1, who);
    return [...m.values()];
  }

  // ほかの人の今いる所 (staleMs より古いものは外す)
  positions(now = Date.now()) {
    return [...this.others.entries()].filter(([, o]) => o.pos && now - o.at <= this.staleMs).map(([name, o]) => ({ name, pos: o.pos }));
  }
}

module.exports = { SharedExplore };
