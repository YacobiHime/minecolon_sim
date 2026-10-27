#!/usr/bin/env node
// experiment_clock.js — records the game clock together with the tick
// multiplier while an experiment runs.
//
// The adaptive tickrate governor changes the speed on its own, so wall-clock
// durations are not comparable between runs. This polls GET /tickrate (read
// only, never POSTs) and appends one JSON line per sample:
//   {"wallTime","wallMs","gameTime","dayTime","multiplier","auto","msptMs"}
// Later, elapsed game ticks give the fixed-speed equivalent duration:
//   equivalent wall seconds at M x = elapsedTicks / (20 * M)
//
// Record:    node experiment_clock.js --out=experiment_logs/A-1_clock.jsonl [--interval=5] [--duration=SEC]
// Summarize: node experiment_clock.js --summarize=experiment_logs/A-1_clock.jsonl [--fixed=10]
// Env: BRIDGE_HOST (default localhost), BRIDGE_PORT (default 8089)

const fs = require("fs");
const http = require("http");
const path = require("path");

const TICKS_PER_SECOND = 20;

function parseArgs(argv) {
  const args = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) args[m[1]] = m[2] === undefined ? true : m[2];
  }
  return args;
}

function fetchTickrate(host, port, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path: "/tickrate", timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          return;
        }
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`bad JSON: ${e.message}`)); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

async function sampleOnce(host, port) {
  const now = new Date();
  const base = { wallTime: now.toISOString(), wallMs: now.getTime() };
  try {
    const t = await fetchTickrate(host, port);
    return {
      ...base,
      gameTime: t.gameTime === undefined ? null : t.gameTime,
      dayTime: t.dayTime === undefined ? null : t.dayTime,
      multiplier: t.multiplier === undefined ? null : t.multiplier,
      auto: t.auto === undefined ? null : t.auto,
      msptMs: t.msptMs === undefined ? null : t.msptMs,
    };
  } catch (e) {
    return { ...base, error: String(e.message || e) };
  }
}

// Polls until durationSec elapses (if given) or stop() is called.
// Returns { done: Promise<number of samples>, stop }.
function runClock({ out, intervalSec = 5, durationSec = null,
  host = process.env.BRIDGE_HOST || "localhost",
  port = Number(process.env.BRIDGE_PORT || 8089) }) {
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  let stopped = false;
  let timer = null;
  let wake = null;
  let count = 0;
  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (wake) wake();
  };
  const startMs = Date.now();
  const done = (async () => {
    while (!stopped) {
      const rec = await sampleOnce(host, port);
      fs.appendFileSync(out, JSON.stringify(rec) + "\n");
      count++;
      if (durationSec != null && Date.now() - startMs >= durationSec * 1000) break;
      if (stopped) break;
      await new Promise((r) => { wake = r; timer = setTimeout(r, intervalSec * 1000); });
      wake = null;
      timer = null;
      if (durationSec != null && Date.now() - startMs > durationSec * 1000) break;
    }
    return count;
  })();
  return { done, stop };
}

function readJsonl(file) {
  return fs.readFileSync(file, "utf8").split("\n")
    .filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
    .filter(Boolean);
}

// Pure: summarise samples. Only error-free samples with numeric gameTime,
// wallMs and multiplier are used. The time-weighted mean holds each sample's
// multiplier until the next sample (step function over wall time).
function summarize(records, fixedMultiplier = 10) {
  const all = Array.isArray(records) ? records : [];
  const ok = all
    .filter((r) => r && !r.error && Number.isFinite(r.wallMs)
      && Number.isFinite(r.gameTime) && Number.isFinite(r.multiplier))
    .sort((a, b) => a.wallMs - b.wallMs);
  const summary = {
    samples: all.length,
    validSamples: ok.length,
    errorSamples: all.filter((r) => r && r.error).length,
    startWallTime: null,
    endWallTime: null,
    elapsedWallSec: null,
    elapsedTicks: null,
    elapsedGameSec: null,
    minMultiplier: null,
    maxMultiplier: null,
    meanMultiplierTimeWeighted: null,
    effectiveMultiplier: null,
    fixedMultiplier,
    equivalentWallSecAtFixed: null,
  };
  if (ok.length === 0) return summary;
  const first = ok[0];
  const last = ok[ok.length - 1];
  const elapsedWallSec = (last.wallMs - first.wallMs) / 1000;
  const elapsedTicks = last.gameTime - first.gameTime;
  const mults = ok.map((r) => r.multiplier);
  let weighted = 0;
  let weight = 0;
  for (let i = 0; i + 1 < ok.length; i++) {
    const dt = ok[i + 1].wallMs - ok[i].wallMs;
    weighted += ok[i].multiplier * dt;
    weight += dt;
  }
  Object.assign(summary, {
    startWallTime: first.wallTime || new Date(first.wallMs).toISOString(),
    endWallTime: last.wallTime || new Date(last.wallMs).toISOString(),
    elapsedWallSec,
    elapsedTicks,
    elapsedGameSec: elapsedTicks / TICKS_PER_SECOND,
    minMultiplier: Math.min(...mults),
    maxMultiplier: Math.max(...mults),
    meanMultiplierTimeWeighted: weight > 0 ? weighted / weight : first.multiplier,
    effectiveMultiplier: elapsedWallSec > 0 ? elapsedTicks / TICKS_PER_SECOND / elapsedWallSec : null,
    equivalentWallSecAtFixed: fixedMultiplier > 0
      ? elapsedTicks / (TICKS_PER_SECOND * fixedMultiplier) : null,
  });
  return summary;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.summarize) {
    const fixed = args.fixed === undefined ? 10 : Number(args.fixed);
    console.log(JSON.stringify(summarize(readJsonl(args.summarize), fixed), null, 2));
    return;
  }
  if (!args.out || args.out === true) {
    console.error("usage: node experiment_clock.js --out=<file.jsonl> [--interval=5] [--duration=SEC]\n"
      + "       node experiment_clock.js --summarize=<file.jsonl> [--fixed=10]");
    process.exit(2);
  }
  const intervalSec = args.interval === undefined ? 5 : Number(args.interval);
  const durationSec = args.duration === undefined ? null : Number(args.duration);
  if (!(intervalSec > 0) || (durationSec != null && !(durationSec >= 0))) {
    console.error("--interval must be > 0 and --duration >= 0");
    process.exit(2);
  }
  const clock = runClock({ out: args.out, intervalSec, durationSec });
  process.on("SIGINT", clock.stop);
  process.on("SIGTERM", clock.stop);
  const n = await clock.done;
  console.error(`[experiment_clock] wrote ${n} samples to ${args.out}`);
}

module.exports = { summarize, runClock, sampleOnce, readJsonl, parseArgs };

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
