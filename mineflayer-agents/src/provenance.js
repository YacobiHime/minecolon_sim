'use strict';
// 設置物の来歴 (provenance ledger)。評価用の ground truth (エージェントの判断には渡さない)。
//   設置・破壊・置換・所有の変更 (共有にした) のたびに、dimension と座標をキーに1件の出来事を積む。
//   1つの位置の状態は、その位置の出来事を時刻の順に畳んで作る (プロセスをまたいで届く順がずれても同じ結果になる)。
//
// プロセスをまたぐ共有 (run.js は 1プロセス10人 × 10プロセス):
//   書く: 各エージェントが自分の名前のファイル runs/<id>/provenance/<名前>.jsonl に1行ずつ追記する (appendFileSync)。
//         1ファイルに書くのは1人だけなので、書き込みの競合が無い。
//   読む: 同じプロセスの全員は Ledger.shared(dir) で1つの台帳を共有する (自分のプロセスの出来事はすぐに入る)。
//         ほかのプロセスの分は sync() で各ファイルの読んだ位置 (byte) から先を読み足す (syncMs ごと。途中までの行は次に回す)。
//   この形にした理由: 親プロセス経由 (IPC) は親が落ちると共有も止まり、run.js の親子の作りを変える必要がある。
//   追記型の JSONL は、run の記録 (explored/) と同じ場所・同じ考え方で、プロセスが落ちても残り、あとで同じ手順で
//   台帳を作り直せる (オフラインの再生・集計にもそのまま使える)。遅れは最大 syncMs (既定 2 秒)。
const fs = require('fs');
const path = require('path');
const { Vec3 } = require('vec3');

const DIM_DEFAULT = 'minecraft:overworld';
// 状態: active (置かれて機能している) / abandoned (置いた人が要らない物として残した: 足場など) /
//       superseded (別の物に置き換わった) / removed (誰かが取った・壊した) / missing (無くなっているのを見た。誰かは不明)
const STATUSES = ['active', 'abandoned', 'superseded', 'removed', 'missing'];

function normDim(d) {
  if (!d) return DIM_DEFAULT;
  const s = String(d);
  return s.includes(':') ? s : `minecraft:${s}`;
}
function posArr(p) {
  if (Array.isArray(p)) return p.map((v) => Math.floor(v));
  return [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)];
}
function keyOf(dim, pos) { const [x, y, z] = posArr(pos); return `${normDim(dim)}|${x},${y},${z}`; }
function chunkOf(dim, pos) { const [x, , z] = posArr(pos); return `${normDim(dim)}|${Math.floor(x / 16)},${Math.floor(z / 16)}`; }

// 出来事の並べ方: 時刻 (ms) → 書いた人 → 番号
function evOrder(a, b) { return (a.ms - b.ms) || String(a.writer).localeCompare(String(b.writer)) || (a.seq - b.seq); }

class Ledger {
  constructor({ dir = null, syncMs = 2000, now = () => Date.now() } = {}) {
    this.dir = dir;
    this.syncMs = syncMs;
    this.now = now;
    this.byKey = new Map(); // key → { events: [...], entry }
    this.byChunk = new Map(); // chunk → Set(key)
    this.seen = new Set(); // 出来事の id (同じ出来事を二度入れない)
    this.writers = new Set(); // このプロセスで書く人 (sync で自分のファイルを読み直さない)
    this.offsets = new Map(); // ファイル → { pos, rest }
    this.seqs = new Map(); // 書く人 → 番号
    this.lastSync = -Infinity;
    if (dir) { try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* ignore */ } }
  }

  // 同じ dir の台帳はプロセスの中で1つ (同じプロセスの10人が同じ物を見る)
  static shared(dir, opts = {}) {
    const k = path.resolve(dir);
    if (!Ledger.registry.has(k)) Ledger.registry.set(k, new Ledger({ ...opts, dir: k }));
    return Ledger.registry.get(k);
  }

  addWriter(name) { this.writers.add(name); }

  // 出来事を作って台帳に入れ、ファイルに追記する。ev: { type, dim, pos, block, by, ... }
  record(writer, ev) {
    const seq = (this.seqs.get(writer) || 0) + 1;
    this.seqs.set(writer, seq);
    const ms = Number.isFinite(ev.ms) ? ev.ms : this.now();
    const full = { id: `${writer}#${seq}`, writer, seq, ms, t: new Date(ms).toISOString(), ...ev, dim: normDim(ev.dim), pos: posArr(ev.pos) };
    this.apply(full);
    if (this.dir) {
      try { fs.appendFileSync(path.join(this.dir, `${writer}.jsonl`), JSON.stringify(full) + '\n'); } catch (_) { /* 書けなくても台帳には入っている */ }
    }
    return full;
  }

  apply(ev) {
    if (!ev || !ev.id || this.seen.has(ev.id) || !ev.pos) return false;
    this.seen.add(ev.id);
    const key = keyOf(ev.dim, ev.pos);
    let slot = this.byKey.get(key);
    if (!slot) {
      slot = { events: [], entry: null };
      this.byKey.set(key, slot);
      const ck = chunkOf(ev.dim, ev.pos);
      if (!this.byChunk.has(ck)) this.byChunk.set(ck, new Set());
      this.byChunk.get(ck).add(key);
    }
    const last = slot.events[slot.events.length - 1];
    slot.events.push(ev);
    if (last && evOrder(last, ev) > 0) slot.events.sort(evOrder); // 遅れて届いた出来事
    slot.entry = fold(slot.events);
    return true;
  }

  // ほかのプロセスのファイルを読み足す (force でなければ syncMs ごと)。返り値: 新しく入った出来事の数
  sync({ force = false } = {}) {
    if (!this.dir) return 0;
    const t = this.now();
    if (!force && t - this.lastSync < this.syncMs) return 0;
    this.lastSync = t;
    let files = [];
    try { files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.jsonl')); } catch (_) { return 0; }
    let n = 0;
    for (const f of files) {
      if (this.writers.has(f.replace(/\.jsonl$/, ''))) continue;
      const fp = path.join(this.dir, f);
      const st = this.offsets.get(fp) || { pos: 0, rest: '' };
      let size = 0;
      try { size = fs.statSync(fp).size; } catch (_) { continue; }
      if (size <= st.pos) continue;
      let buf = '';
      try {
        const fd = fs.openSync(fp, 'r');
        const b = Buffer.alloc(size - st.pos);
        fs.readSync(fd, b, 0, b.length, st.pos);
        fs.closeSync(fd);
        buf = b.toString('utf8');
      } catch (_) { continue; }
      st.pos = size;
      const text = st.rest + buf;
      const lines = text.split('\n');
      st.rest = lines.pop(); // 書きかけの行は次に
      for (const l of lines) { if (!l) continue; try { if (this.apply(JSON.parse(l))) n += 1; } catch (_) { /* 壊れた行 */ } }
      this.offsets.set(fp, st);
    }
    return n;
  }

  // ファイルから台帳を作り直す (再起動・オフラインの集計)
  static load(dir) {
    const l = new Ledger({ dir: null });
    l.dir = dir;
    l.sync({ force: true });
    l.dir = null;
    return l;
  }

  get(dim, pos) { const s = this.byKey.get(keyOf(dim, pos)); return s ? s.entry : null; }
  // 今そこにある (active か abandoned) 置かれた物
  lookup(dim, pos) { const e = this.get(dim, pos); return e && (e.status === 'active' || e.status === 'abandoned') ? e : null; }
  events(dim, pos) { const s = this.byKey.get(keyOf(dim, pos)); return s ? s.events.slice() : []; }

  // pos から r 以内の entry (状態を問わない)
  near(dim, pos, r = 16) {
    const [x, y, z] = posArr(pos);
    const out = [];
    const c = Math.ceil(r / 16);
    const cx = Math.floor(x / 16); const cz = Math.floor(z / 16);
    for (let i = -c; i <= c; i++) {
      for (let j = -c; j <= c; j++) {
        const keys = this.byChunk.get(`${normDim(dim)}|${cx + i},${cz + j}`);
        if (!keys) continue;
        for (const k of keys) {
          const e = this.byKey.get(k).entry;
          if (!e) continue;
          const [ex, ey, ez] = e.position;
          if (Math.hypot(ex - x, ey - y, ez - z) <= r) out.push(e);
        }
      }
    }
    return out;
  }

  entries() { return [...this.byKey.values()].map((s) => s.entry).filter(Boolean); }
}
Ledger.registry = new Map();

// 1つの位置の出来事 (時刻の順) → entry
function fold(events) {
  let e = null;
  const history = [];
  for (const ev of events) {
    history.push({ type: ev.type, by: ev.by ?? null, t: ev.t, block: ev.block ?? null, ...(ev.reasonCode ? { reasonCode: ev.reasonCode } : {}), ...(ev.intentId ? { intentId: ev.intentId } : {}) });
    if (ev.type === 'place') {
      // 前の物がまだあるところへ置いた = 置き換え (前の物は superseded。entry は新しい物にする)
      const supersedes = e && (e.status === 'active' || e.status === 'abandoned') ? { block: e.block, placedBy: e.placedBy, placedAt: e.placedAt, ownership: e.ownership } : null;
      if (supersedes) history[history.length - 1].supersedes = supersedes.block;
      const prevHistory = history.slice(0, -1);
      e = {
        dimension: ev.dim, position: ev.pos, block: ev.block, placedBy: ev.by, placedAt: ev.t,
        purpose: ev.purpose || null, action: ev.action || null, need: ev.need || null, goal: ev.goal || null,
        ownership: ev.ownership || { kind: 'personal', owner: ev.by },
        projectId: ev.projectId ?? null,
        active: ev.status !== 'abandoned', status: ev.status === 'abandoned' ? 'abandoned' : 'active',
        lastChangedBy: ev.by, history: prevHistory, ...(supersedes ? { supersedes } : {}),
      };
    } else if (!e) {
      continue; // 置いた記録の無い位置の出来事 (天然物など) は entry にしない (履歴だけは残る)
    } else if (ev.type === 'remove') {
      if (ev.block && e.block && ev.block !== e.block && !sameFamily(ev.block, e.block)) continue; // 別の物を壊した (置いた物はもう無かった)
      e.active = false; e.status = 'removed'; e.lastChangedBy = ev.by ?? null; e.removedBy = ev.by ?? null; e.removedAt = ev.t; e.removeReason = ev.reasonCode || null;
    } else if (ev.type === 'gone') {
      if (e.status === 'active' || e.status === 'abandoned') { e.active = false; e.status = 'missing'; e.lastChangedBy = null; e.goneSeenBy = ev.by ?? null; e.goneAt = ev.t; }
    } else if (ev.type === 'reclassify') {
      if (ev.ownership) e.ownership = ev.ownership;
      if (ev.projectId !== undefined) e.projectId = ev.projectId;
      if (ev.status && STATUSES.includes(ev.status)) { e.status = ev.status; e.active = ev.status === 'active'; }
      e.lastChangedBy = ev.by ?? e.lastChangedBy;
    }
    if (e) e.history = history.slice();
  }
  return e;
}

// 松明と壁の松明、ベッドの頭と足など、同じ物の別の形
function sameFamily(a, b) {
  const f = (n) => String(n).replace(/^wall_/, '').replace(/_wall_/, '_').replace(/^(soul_)?wall_torch$/, 'torch');
  return f(a) === f(b) || /_bed$/.test(a) && /_bed$/.test(b);
}

// ---- bot への取り付け (bot.dig / bot.placeBlock / bot.activateBlock を包む) ----
//   hooks: { beforeDig(info), afterDig(info, ok), afterPlace(info), afterActivate(info) }。info = { pos: {x,y,z}, name }
//   pathfinder・unstuck・act.js のどこから掘っても置いても、ここを通る (pathfinder は bot.dig を呼ぶときに参照する)
const SOFT = /^(air|cave_air|void_air|water|lava|short_grass|grass|tall_grass|fern|large_fern|snow|dead_bush|fire)$/;
function instrumentBot(bot, hooks = {}) {
  if (!bot || bot.__provenance) return false;
  bot.__provenance = true;
  const p3 = (v) => ({ x: Math.floor(v.x), y: Math.floor(v.y), z: Math.floor(v.z) });
  // mineflayer の blockAt は Vec3 が要る (ただの {x,y,z} では例外になり、置いた記録が抜けていた。2026-11-11 の生の試験)
  const nameAt = (p) => { try { const b = bot.blockAt(new Vec3(p.x, p.y, p.z)); return b ? b.name : null; } catch (_) { return null; } };
  if (typeof bot.dig === 'function') {
    const origDig = bot.dig;
    bot.dig = async function dig(block, ...rest) {
      const info = block && block.position ? { pos: p3(block.position), name: block.name } : null;
      if (info && hooks.beforeDig) { try { hooks.beforeDig(info); } catch (_) { /* 記録の失敗で掘るのを止めない */ } }
      let ok = false;
      try { const r = await origDig.call(bot, block, ...rest); ok = true; return r; } finally {
        if (info && hooks.afterDig) { try { hooks.afterDig(info, ok); } catch (_) { /* ignore */ } }
      }
    };
  }
  if (typeof bot.placeBlock === 'function') {
    const origPlace = bot.placeBlock;
    bot.placeBlock = async function placeBlock(ref, face, ...rest) {
      const target = ref && ref.position && face ? p3(ref.position.plus ? ref.position.plus(face) : { x: ref.position.x + face.x, y: ref.position.y + face.y, z: ref.position.z + face.z }) : null;
      const before = target ? nameAt(target) : null;
      const held = bot.heldItem ? bot.heldItem.name : null;
      // 置く前に知らせる (置いた知らせ blockUpdate は placeBlock が終わるより先に来るので、自分の置いた物をほかの人の物と見ないように)
      if (target && hooks.beforePlace) { try { hooks.beforePlace({ pos: target, held }); } catch (_) { /* ignore */ } }
      const done = () => {
        if (!target || !hooks.afterPlace) return;
        const now = nameAt(target);
        if (!now || now === before || SOFT.test(now)) return;
        try { hooks.afterPlace({ pos: target, name: now, held }); } catch (e) { if (process.env.PROV_DEBUG) console.error("afterPlace", e); }
      };
      try { const r = await origPlace.call(bot, ref, face, ...rest); done(); return r; } catch (e) {
        // 時間切れでも置けていることがある (act.js の place と同じ)。少し待って見る
        setTimeout(done, 500);
        throw e;
      }
    };
  }
  if (typeof bot.activateBlock === 'function') {
    const origAct = bot.activateBlock;
    bot.activateBlock = async function activateBlock(block, face, ...rest) {
      const held = bot.heldItem ? bot.heldItem.name : null;
      const at = block && block.position ? p3(block.position) : null;
      const side = at && face ? p3({ x: at.x + face.x, y: at.y + face.y, z: at.z + face.z }) : null;
      const before = { at: at ? nameAt(at) : null, side: side ? nameAt(side) : null };
      const r = await origAct.call(bot, block, face, ...rest);
      if (hooks.afterActivate && at) {
        // 耕す (土 → 耕地) は同じマス、植える (耕地の上に種) は face の側のマスが変わる
        setTimeout(() => {
          try {
            const a = nameAt(at); const s = side ? nameAt(side) : null;
            if (a && a !== before.at && !SOFT.test(a)) hooks.afterActivate({ pos: at, name: a, held, was: before.at });
            if (side && s && s !== before.side && !SOFT.test(s)) hooks.afterActivate({ pos: side, name: s, held, was: before.side });
          } catch (_) { /* ignore */ }
        }, 400);
      }
      return r;
    };
  }
  return true;
}

module.exports = { Ledger, fold, keyOf, chunkOf, normDim, posArr, sameFamily, instrumentBot, STATUSES, DIM_DEFAULT, SOFT };
