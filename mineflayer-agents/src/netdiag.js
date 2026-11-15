'use strict';
// 切断 (サーバー側の Timed out など) の原因を後から調べるための軽い記録 (2026-11-13 の 100人試験で、
// 開始直後に1つのプロセスの5人がまとめて keepalive で切られたが、何が遅れたのか分からなかった)。
// 記録は runs/<時刻>/netdiag[-<proc>].jsonl。接続を始める前から動かす。1行 = 1つの出来事か一定間隔の様子:
//   { kind: 'sample' }      intervalMs ごと: イベントループの遅れ (probeMs 間隔の測定の最大・1秒超えの回数)・CPU・
//                           ボットごとの受信 (この間のバイト・パケット数・量の多いパケット上位3つ)・keepalive (受けた回数・
//                           最後に受けてからの ms・遅れの推定の最大)・最後のパケットからの ms・ソケットの読み書き待ちの量
//   { kind: 'lag' }         イベントループが lagEventMs 以上止まったとき (すぐ書く)
//   { kind: 'connect' / 'spawn' }  接続を始めた・出現した (かかった ms)
//   { kind: 'ka' }          keepalive を受けて応答した (ka 回ごとでなく、遅れが kaSlowMs 以上か間隔が kaGapMs 以上のときだけ)
//   { kind: 'kicked' / 'end' / 'error' }  切断の理由と、その時点のソケット・受信の様子 (snapshot)
// keepalive の遅れの推定: サーバーの keepAliveId はサーバーの時計 (ms)。受けた時刻 − id の最小値を基準に、それより遅れた分。
//   同じマシンのサーバーなら「サーバーが送ってからこのプロセスが処理するまで」がどれだけ伸びたかが分かる。
const fs = require('fs');

const num = (x) => {
  if (typeof x === 'bigint') return Number(x);
  if (Array.isArray(x) && x.length === 2) return x[0] * 4294967296 + (x[1] >>> 0); // [hi, lo]
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
};
const qlen = (st) => (st && typeof st.length === 'number' ? st.length : null);

class NetDiag {
  constructor({ file = null, proc = 0, intervalMs = 10000, probeMs = 250, lagEventMs = 1000, kaSlowMs = 2000, kaGapMs = 20000, log = console.log, now = Date.now } = {}) {
    this.file = file;
    this.proc = proc;
    this.intervalMs = intervalMs;
    this.probeMs = probeMs;
    this.lagEventMs = lagEventMs;
    this.kaSlowMs = kaSlowMs;
    this.kaGapMs = kaGapMs;
    this.log = log;
    this.now = now;
    this.phase = 'connect';
    this.bots = new Map(); // 名前 → 状態
    this.kaBase = null; // 受けた時刻 − keepAliveId の最小値
    this.win = { lagMax: 0, over1s: 0 };
    this.timers = [];
  }

  write(row) {
    const r = { ts: new Date(this.now()).toISOString(), proc: this.proc, ...row };
    if (this.file) { try { fs.appendFileSync(this.file, JSON.stringify(r) + '\n'); } catch (e) { this.log(`netdiag: ${e.message}`); } }
    return r;
  }

  start() {
    this.t0 = this.now();
    this.lastCpu = process.cpuUsage();
    this.lastT = this.t0;
    let expect = this.now() + this.probeMs;
    const probe = setInterval(() => {
      const t = this.now();
      const lag = Math.max(0, t - expect);
      expect = t + this.probeMs;
      if (lag > this.win.lagMax) this.win.lagMax = lag;
      if (lag >= 1000) this.win.over1s += 1;
      if (lag >= this.lagEventMs) this.write({ kind: 'lag', ms: lag, phase: this.phase });
    }, this.probeMs);
    const sample = setInterval(() => { try { this.sample(); } catch (e) { this.log(`netdiag: ${e.message}`); } }, this.intervalMs);
    for (const t of [probe, sample]) { if (t.unref) t.unref(); this.timers.push(t); }
    this.write({ kind: 'start', intervalMs: this.intervalMs, probeMs: this.probeMs });
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  setPhase(p) { this.phase = p; this.write({ kind: 'phase', phase: p }); }

  // 新しい bot (接続のたび。再試行・入り直しも) を見張る。bot は mineflayer の bot (bot._client が minecraft-protocol の client)
  watch(name, bot) {
    const client = bot && bot._client;
    if (!client) return;
    const st = { name, bot, client, t0: this.now(), up: false, bytes: 0, pkts: 0, byName: new Map(), lastPkt: null, lastPktName: null,
      ka: { n: 0, last: null, delayMax: 0, gapMax: 0, recent: [] }, lastRead: 0, lastWritten: 0 };
    this.bots.set(name, st);
    this.write({ kind: 'connect', name });
    client.on('packet', (data, meta, buffer) => {
      const len = buffer ? buffer.length : 0;
      st.bytes += len; st.pkts += 1; st.lastPkt = this.now(); st.lastPktName = meta && meta.name;
      const k = (meta && meta.name) || '?';
      const e = st.byName.get(k);
      if (e) { e[0] += 1; e[1] += len; } else st.byName.set(k, [1, len]);
    });
    client.on('keep_alive', (p) => {
      const t = this.now();
      const id = num(p && p.keepAliveId);
      const gap = st.ka.last ? t - st.ka.last : null;
      let delay = null;
      if (id != null) {
        const off = t - id;
        if (this.kaBase == null || off < this.kaBase) this.kaBase = off;
        delay = off - this.kaBase;
      }
      st.ka.n += 1; st.ka.last = t;
      if (delay != null && delay > st.ka.delayMax) st.ka.delayMax = delay;
      if (gap != null && gap > st.ka.gapMax) st.ka.gapMax = gap;
      const sock = client.socket;
      st.ka.recent.push({ at: new Date(t).toISOString(), delayMs: delay, gapMs: gap, wq: sock ? sock.writableLength : null });
      if (st.ka.recent.length > 4) st.ka.recent.shift();
      if ((delay != null && delay >= this.kaSlowMs) || (gap != null && gap >= this.kaGapMs)) {
        this.write({ kind: 'ka', name, delayMs: delay, gapMs: gap, sock: this.sock(st) });
      }
    });
    bot.once('spawn', () => { st.up = true; this.write({ kind: 'spawn', name, ms: this.now() - st.t0 }); });
    const down = (kind) => (r) => {
      if (kind !== 'error') st.up = false;
      const reason = r instanceof Error ? `${r.code || ''} ${r.message}`.trim() : (typeof r === 'string' ? r : JSON.stringify(r));
      this.write({ kind, name, reason: String(reason).slice(0, 300), phase: this.phase, snapshot: this.snapshot(st) });
    };
    bot.on('kicked', down('kicked'));
    bot.on('end', down('end'));
    bot.on('error', down('error'));
  }

  sock(st) {
    const s = st.client && st.client.socket;
    if (!s) return null;
    return { rq: s.readableLength, wq: s.writableLength, read: s.bytesRead, written: s.bytesWritten, paused: typeof s.isPaused === 'function' ? s.isPaused() : null, destroyed: !!s.destroyed };
  }

  // 切断の時点の様子
  snapshot(st) {
    const t = this.now();
    const c = st.client || {};
    return {
      sinceConnectMs: t - st.t0,
      sinceLastPacketMs: st.lastPkt ? t - st.lastPkt : null, lastPacket: st.lastPktName,
      ka: { n: st.ka.n, sinceLastMs: st.ka.last ? t - st.ka.last : null, delayMaxMs: st.ka.delayMax, gapMaxMs: st.ka.gapMax, recent: st.ka.recent },
      sock: this.sock(st),
      // 受け取ったがまだ解いていない量 (splitter の出口・deserializer の入口と出口)
      buf: { split: qlen(c.splitter && c.splitter._readableState), desIn: qlen(c.deserializer && c.deserializer._writableState), desOut: qlen(c.deserializer && c.deserializer._readableState) },
      loopLagMaxMs: this.win.lagMax,
    };
  }

  sample() {
    const t = this.now();
    const wall = Math.max(1, t - this.lastT);
    const cpu = process.cpuUsage(this.lastCpu);
    this.lastCpu = process.cpuUsage();
    this.lastT = t;
    const bots = [];
    for (const st of this.bots.values()) {
      if (!st.up && !st.pkts) continue;
      const top = [...st.byName.entries()].sort((a, b) => b[1][1] - a[1][1]).slice(0, 3).map(([k, [n, b]]) => [k, n, Math.round(b / 1024)]);
      const s = this.sock(st);
      bots.push({ n: st.name, up: st.up, inKB: Math.round(st.bytes / 1024), pk: st.pkts, top,
        netKB: s ? Math.round((s.read - st.lastRead) / 1024) : null,
        ka: { n: st.ka.n, agoMs: st.ka.last ? t - st.ka.last : null, delayMaxMs: st.ka.delayMax },
        lastPktAgoMs: st.lastPkt ? t - st.lastPkt : null, rq: s ? s.rq : null, wq: s ? s.wq : null });
      if (s) st.lastRead = s.read;
      st.bytes = 0; st.pkts = 0; st.byName.clear(); st.ka.n = 0; st.ka.delayMax = 0;
    }
    const row = this.write({ kind: 'sample', phase: this.phase, sec: Math.round((t - this.t0) / 1000),
      lag: { maxMs: this.win.lagMax, over1s: this.win.over1s }, cpuPct: Math.round(((cpu.user + cpu.system) / 1000 / wall) * 1000) / 10, bots });
    this.win = { lagMax: 0, over1s: 0 };
    return row;
  }
}

module.exports = { NetDiag, keepAliveNum: num };
