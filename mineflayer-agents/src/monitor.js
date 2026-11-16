'use strict';
// 実行中の負荷を一定の間隔で記録する (20人を1つ・複数の node プロセスで動かすときの見張り)。
//   1行 = { ts, proc, sec, cpuPct (このプロセスの CPU、1コア = 100), rssMb, heapMb, loopLag (イベントループの遅れ ms: p50/p99/max),
//           loadavg, bots: { alive, total, disconnects }, decisions (この間の判断の数と1人あたりの間隔 秒), twoB (この間の 2B の待ち), jev (この間の呼び出し・429) }
// 記録は runs/<時刻>/monitor[-<proc>].jsonl。console には短い1行。phase は 'connect' (接続の途中。run.js は接続を始める前から見張る) か 'run'。
const fs = require('fs');
const os = require('os');
const { monitorEventLoopDelay } = require('perf_hooks');
const { LLM_STATS } = require('./deciders/llm');

class Monitor {
  // agents: Agent の配列。meter: UsageMeter。disconnects: { n, reasons: [] } (run.js が数える)
  constructor({ file = null, agents = [], meter = null, disconnects = null, intervalMs = 30000, proc = 0, log = console.log } = {}) {
    this.file = file;
    this.agents = agents;
    this.meter = meter;
    this.disconnects = disconnects || { n: 0, reasons: [] };
    this.intervalMs = intervalMs;
    this.proc = proc;
    this.log = log;
    this.rows = [];
    this.timer = null;
  }

  start() {
    this.t0 = Date.now();
    this.lastT = this.t0;
    this.lastCpu = process.cpuUsage();
    this.lastTicks = this.agents.map((a) => (a.memory ? a.memory.tick : 0));
    this.lastJev = this.meter ? { ...this.meter.jev } : null;
    this.lag = monitorEventLoopDelay({ resolution: 20 });
    this.lag.enable();
    LLM_STATS.window(); // ここから数える
    this.timer = setInterval(() => { try { this.sample(); } catch (e) { this.log(`monitor: ${e.message}`); } }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  sample() {
    const now = Date.now();
    const wall = Math.max(1, now - this.lastT);
    const cpu = process.cpuUsage(this.lastCpu);
    this.lastCpu = process.cpuUsage();
    this.lastT = now;
    const mem = process.memoryUsage();
    const lagMs = (v) => Math.round(v / 1e6);
    const ticks = this.agents.map((a) => (a.memory ? a.memory.tick : 0));
    const per = ticks.map((t, i) => t - (this.lastTicks[i] || 0));
    this.lastTicks = ticks;
    const active = per.filter((x) => x > 0);
    const n = per.reduce((s, x) => s + x, 0);
    let jev = null;
    if (this.meter) {
      const j = this.meter.jev;
      const l = this.lastJev;
      jev = { calls: j.calls - l.calls, rateLimited: j.rateLimited - l.rateLimited, retries: j.retries - l.retries, errors: j.errors - l.errors,
        inputTokens: j.inputTokens - l.inputTokens, avgMs: j.calls - l.calls ? Math.round((j.ms - l.ms) / (j.calls - l.calls)) : null, totalInputTokens: j.inputTokens };
      this.lastJev = { ...j };
    }
    const row = {
      ts: new Date(now).toISOString(), proc: this.proc, phase: this.phase || 'run', sec: Math.round((now - this.t0) / 1000),
      cpuPct: Math.round(((cpu.user + cpu.system) / 1000 / wall) * 1000) / 10,
      rssMb: Math.round(mem.rss / 1048576), heapMb: Math.round(mem.heapUsed / 1048576),
      loopLag: { p50: lagMs(this.lag.percentile(50)), p99: lagMs(this.lag.percentile(99)), max: lagMs(this.lag.max) },
      loadavg: os.loadavg().map((x) => Math.round(x * 100) / 100),
      bots: { alive: this.agents.filter((a) => a.bot && a.bot.entity && !a.stopped).length, total: this.agents.length, disconnects: this.disconnects.n },
      // 判断の間隔: この間に判断した人について、間隔 (秒) = 経過 / 判断の数
      decisions: { n, perMin: Math.round((n / (wall / 60000)) * 10) / 10, intervalSec: active.length ? Math.round(((wall / 1000) * active.length / n) * 10) / 10 : null, idle: per.length - active.length },
      twoB: LLM_STATS.window(),
      jev,
    };
    this.lag.reset();
    this.rows.push(row);
    if (this.file) fs.appendFileSync(this.file, JSON.stringify(row) + '\n');
    const t = row.twoB;
    this.log(`[monitor${this.proc ? ' ' + this.proc : ''}] ${row.phase === 'connect' ? '接続中 ' : ''}${row.sec}s cpu ${row.cpuPct}% rss ${row.rssMb}MB lag p99 ${row.loopLag.p99}ms bots ${row.bots.alive}/${row.bots.total} (切断 ${row.bots.disconnects}) 判断 ${n} (間隔 ${row.decisions.intervalSec}s) 2B ${t.calls}回 待ち p50 ${t.waitMs.p50}ms p95 ${t.waitMs.p95}ms${jev ? ` Jev ${jev.calls}回 429 ${jev.rateLimited} ${jev.inputTokens}tok` : ''}`);
    return row;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.lag) this.lag.disable();
  }
}

module.exports = { Monitor };
