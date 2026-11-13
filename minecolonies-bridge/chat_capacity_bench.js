#!/usr/bin/env node
// chat_capacity_bench.js — how many LLM-speaking MineColonies citizens can hold
// a real-time, mutual conversation in game chat with the lab's Ollama servers?
//
// Two modes:
//   --mode=throughput  Raw LLM capacity. For each concurrency level c, send
//                      --requests utterance requests keeping exactly c in
//                      flight; report latency / throughput, then estimate the
//                      max number of citizens for several speaking intervals.
//   --mode=live        A real conversation among N citizens (from bridge
//                      GET /status, padded with synthetic citizens). Each
//                      citizen aims to speak once every --interval seconds;
//                      the speaker sees the last ~8 chat lines so citizens
//                      reply to each other. --ramp=4,8,16 tries several N and
//                      reports the largest N that met the real-time criterion.
//
// Real-time criterion (live): p95 LLM latency <= --max-latency-ms AND achieved
// utterances per citizen per minute >= 90% of target (60 / interval).
//
// Safety: only GET /status is sent to the bridge (never POST). Writing to game
// chat is opt-in (--say) via the CMD_PIPE FIFO, opened O_WRONLY|O_NONBLOCK so a
// missing reader (ENXIO) is skipped instead of hanging. No npm dependencies.
//
// Examples:
//   node chat_capacity_bench.js --mode=throughput --concurrency=1,2,4,8 --requests=24
//   node chat_capacity_bench.js --mode=live --ramp=4,8,16 --interval=20 --duration=120
//   node chat_capacity_bench.js --mode=live --citizens=6 --say      # actually posts to chat
// LLM API (--api): "openai" (default) = llama.cpp llama-server
//   POST /v1/chat/completions with Authorization: Bearer $LLM_API_KEY
//   (default --llm-hosts=127.0.0.1:8080); "ollama" = POST /api/chat with
//   think:false (default --llm-hosts=192.168.15.150:11434). The key is read
//   from env LLM_API_KEY only and is never logged or written to result files.
// Single self-contained file (node built-ins only): it can be copied to the
// LLM host and run there, e.g. scp chat_capacity_bench.js gpu1: && ssh gpu1 node chat_capacity_bench.js
// Common options: --api=openai|ollama --llm-hosts=host:port[,host:port] --model=gemma4:e4b
//   --max-tokens=60 --max-latency-ms=5000 --timeout-ms=60000 --out=path.json
//   --bridge=localhost:8089 (or env BRIDGE_HOST/BRIDGE_PORT)

const fs = require("fs");
const http = require("http");
const path = require("path");

const CONTEXT_LINES = 8;
const MAX_CHARS = 40;
const RATE_PASS_RATIO = 0.9;

// ---------------------------------------------------------------- utilities

function parseArgs(argv) {
  const args = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) args[m[1]] = m[2] === undefined ? true : m[2];
  }
  return args;
}

function numList(v, def) {
  if (v === undefined || v === true) return def;
  return String(v).split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
}

function boolArg(v, def) {
  if (v === undefined) return def;
  if (v === true) return true;
  return !/^(false|0|no|off)$/i.test(String(v));
}

function parseHostPort(s, defPort) {
  const str = String(s).trim();
  const i = str.lastIndexOf(":");
  if (i < 0) return { host: str, port: defPort };
  return { host: str.slice(0, i), port: parseInt(str.slice(i + 1), 10) || defPort };
}

function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  // nearest-rank
  const rank = Math.ceil((p / 100) * s.length);
  return s[Math.min(s.length - 1, Math.max(0, rank - 1))];
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function round(v, d = 2) {
  if (v === null || v === undefined || !Number.isFinite(v)) return v === undefined ? null : v;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "_");
}

// --------------------------------------------------------------------- LLM

// Round-robin over hosts so several GPUs / servers share the load.
function makeHostPicker(hosts) {
  let i = 0;
  return () => hosts[i++ % hosts.length];
}

// ollama:  mirrors council.js askLLM - native /api/chat, think:false (gemma4
//          otherwise spends the budget on hidden reasoning), num_predict caps length.
// openai:  llama.cpp llama-server /v1/chat/completions with a Bearer key;
//          token counts from usage{} and llama.cpp's timings{} when present.
// Both return the same shape: {ok, text|error, latencyMs, host, evalCount,
// evalDurationNs, promptEvalCount, promptEvalDurationNs}.
function buildLlmRequest(api, model, messages, maxTokens, apiKey) {
  const headers = { "Content-Type": "application/json" };
  let reqPath;
  let body;
  if (api === "ollama") {
    reqPath = "/api/chat";
    body = { model, messages, stream: false, think: false, options: { num_predict: maxTokens, temperature: 0.8 } };
  } else {
    reqPath = "/v1/chat/completions";
    body = { model, messages, max_tokens: maxTokens, temperature: 0.8, stream: false };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  }
  const payload = JSON.stringify(body);
  headers["Content-Length"] = Buffer.byteLength(payload);
  return { path: reqPath, headers, payload };
}

function parseLlmResponse(api, parsed) {
  if (api === "ollama") {
    return {
      text: (parsed.message && parsed.message.content ? parsed.message.content : "").trim(),
      evalCount: numOrNull(parsed.eval_count),
      evalDurationNs: numOrNull(parsed.eval_duration),
      promptEvalCount: numOrNull(parsed.prompt_eval_count),
      promptEvalDurationNs: numOrNull(parsed.prompt_eval_duration),
    };
  }
  const choice = Array.isArray(parsed.choices) && parsed.choices[0];
  const msg = choice && choice.message;
  const usage = parsed.usage || {};
  const t = parsed.timings || {};
  const ms2ns = (v) => (numOrNull(v) === null ? null : v * 1e6);
  return {
    text: (msg && typeof msg.content === "string" ? msg.content : "").trim(),
    evalCount: numOrNull(t.predicted_n) !== null ? t.predicted_n : numOrNull(usage.completion_tokens),
    evalDurationNs: ms2ns(t.predicted_ms),
    promptEvalCount: numOrNull(t.prompt_n) !== null ? t.prompt_n : numOrNull(usage.prompt_tokens),
    promptEvalDurationNs: ms2ns(t.prompt_ms),
  };
}

// opts: {api, model, maxTokens, timeoutMs, apiKey}
function llmChat({ host, port }, opts, messages) {
  const api = opts.api || "openai";
  return new Promise((resolve) => {
    const { path: reqPath, headers, payload } = buildLlmRequest(api, opts.model, messages, opts.maxTokens, opts.apiKey);
    const t0 = Date.now();
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      resolve({ host: `${host}:${port}`, latencyMs: Date.now() - t0, ...r });
    };
    const req = http.request({ host, port, path: reqPath, method: "POST", headers }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          finish({ ok: false, error: `HTTP ${res.statusCode}: ${data.slice(0, 200)}` });
          return;
        }
        try {
          const { text, ...stats } = parseLlmResponse(api, JSON.parse(data));
          if (!text) finish({ ok: false, error: "empty reply", ...stats });
          else finish({ ok: true, text, ...stats });
        } catch (e) {
          finish({ ok: false, error: `bad JSON: ${e.message}` });
        }
      });
    });
    req.setTimeout(opts.timeoutMs, () => {
      req.destroy(new Error(`timeout after ${opts.timeoutMs}ms`));
    });
    req.on("error", (e) => finish({ ok: false, error: e.message }));
    req.write(payload);
    req.end();
  });
}

function numOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// ------------------------------------------------------------------ prompts

const PERSONALITIES = [
  "陽気でおしゃべり。冗談が好き。",
  "慎重で心配性。食料の備蓄が気になる。",
  "働き者で無口。仕事の話ばかりする。",
  "好奇心旺盛。新しい建物に興味がある。",
  "皮肉屋だが根は優しい。",
  "世話好き。困っている人に声をかける。",
  "のんびり屋。天気と昼寝の話が好き。",
  "野心家。村をもっと大きくしたい。",
];

const SYNTH_NAMES = [
  "アオイ", "ハルト", "ミナ", "ソウタ", "ユイ", "レン", "サクラ", "カイト",
  "ヒナ", "リク", "ツムギ", "ユウマ", "メイ", "タクミ", "コハル", "ハヤト",
];
const SYNTH_JOBS = ["builder", "farmer", "fisherman", "cook", "deliveryman", "lumberjack", "miner", "guard", "baker", "researcher"];

const SEED_LINES = [
  "今日は畑の小麦がよく育ってるね",
  "倉庫がそろそろいっぱいだよ",
  "新しい家はいつ建つんだろう",
  "夜はゾンビが出るから気をつけて",
  "パン屋さんのパン、今日も美味しかった",
  "木材が足りないって建築屋が言ってた",
  "雨が降りそうだな",
  "市場に魚がたくさん並んでたよ",
  "研究所で新しい発見があったらしい",
  "鉱山で鉄が見つかったって",
  "広場で少し休もうか",
  "お腹がすいたなあ",
];

function systemPrompt(c) {
  return (
    `あなたは Minecraft の村(MineColonies)の住民「${c.name}」です。職業: ${c.job}。性格: ${c.personality}\n` +
    `村のチャットで仲間と会話しています。直前の会話に反応して、短い日本語のチャット1行(${MAX_CHARS}文字以内)だけを返してください。` +
    `かぎかっこ・引用符・名前の前置きは付けないでください。`
  );
}

function userPrompt(chatLines) {
  if (!chatLines.length) return "(まだ誰も話していません。会話を始めてください。)";
  return "最近のチャット:\n" + chatLines.map((l) => `${l.name}: ${l.text}`).join("\n") + "\n\nあなたの次の発言:";
}

function buildMessages(citizen, chatLines) {
  return [
    { role: "system", content: systemPrompt(citizen) },
    { role: "user", content: userPrompt(chatLines.slice(-CONTEXT_LINES)) },
  ];
}

// Keep one short line: drop name prefixes, quotes and anything after a newline.
function cleanReply(text, name) {
  let t = String(text).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || "";
  if (name && t.startsWith(name)) t = t.slice(name.length).replace(/^\s*[:：]\s*/, "");
  t = t.replace(/^[^\s:：]{1,12}[:：]\s*/, "");
  t = t.replace(/^[「『"'“]+|[」』"'”]+$/g, "").trim();
  return t.slice(0, MAX_CHARS);
}

function synthCitizen(i) {
  return {
    id: `synthetic-${i}`,
    name: SYNTH_NAMES[i % SYNTH_NAMES.length] + (i >= SYNTH_NAMES.length ? String(Math.floor(i / SYNTH_NAMES.length) + 1) : ""),
    job: SYNTH_JOBS[i % SYNTH_JOBS.length],
    personality: PERSONALITIES[i % PERSONALITIES.length],
    synthetic: true,
  };
}

// ------------------------------------------------------------- throughput

async function runLevel(opts, concurrency, pickHost) {
  const results = [];
  let next = 0;
  const t0 = Date.now();
  const worker = async () => {
    while (next < opts.requests) {
      const i = next++;
      const citizen = synthCitizen(i);
      // Synthetic last ~8 lines of a conversation, rotating speakers.
      const lines = [];
      for (let k = 0; k < CONTEXT_LINES; k++) {
        lines.push({ name: synthCitizen(i + k + 1).name, text: SEED_LINES[(i + k) % SEED_LINES.length] });
      }
      const r = await llmChat(pickHost(), opts, buildMessages(citizen, lines));
      results.push(r);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, opts.requests) }, worker));
  const wallMs = Date.now() - t0;
  return summarizeLevel(concurrency, wallMs, results);
}

function summarizeLevel(concurrency, wallMs, results) {
  const ok = results.filter((r) => r.ok);
  const lat = ok.map((r) => r.latencyMs);
  const evals = ok.map((r) => r.evalCount).filter((v) => v !== null);
  const totalEval = evals.reduce((a, b) => a + b, 0);
  const perReqTps = ok
    .filter((r) => r.evalCount !== null && r.evalDurationNs)
    .map((r) => r.evalCount / (r.evalDurationNs / 1e9));
  const wallSec = wallMs / 1000;
  return {
    concurrency,
    requests: results.length,
    ok: ok.length,
    errors: results.length - ok.length,
    errorSamples: results.filter((r) => !r.ok).slice(0, 3).map((r) => r.error),
    wallMs,
    utterancesPerSec: wallSec > 0 ? round(ok.length / wallSec, 3) : null,
    latencyMs: { p50: percentile(lat, 50), p95: percentile(lat, 95), max: lat.length ? Math.max(...lat) : null },
    meanOutputTokens: round(mean(evals), 1),
    outputTokensPerSecAggregate: evals.length && wallSec > 0 ? round(totalEval / wallSec, 1) : null,
    meanPerRequestDecodeTokensPerSec: round(mean(perReqTps), 1),
    meanPromptTokens: round(mean(ok.map((r) => r.promptEvalCount).filter((v) => v !== null)), 1),
    meanPromptEvalMs: round(mean(ok.map((r) => r.promptEvalDurationNs).filter((v) => v !== null).map((v) => v / 1e6)), 1),
    hosts: countBy(results.map((r) => r.host)),
  };
}

function countBy(arr) {
  const o = {};
  for (const k of arr) o[k] = (o[k] || 0) + 1;
  return o;
}

// maxCitizens = floor(bestSustainableUtterancesPerSec * interval), where
// sustainable = levels with p95 latency <= maxLatencyMs.
function computeCapacity(levels, intervals, maxLatencyMs) {
  const sustainable = levels.filter(
    (l) => l.ok > 0 && l.latencyMs.p95 !== null && l.latencyMs.p95 <= maxLatencyMs
  );
  let best = null;
  for (const l of sustainable) if (!best || l.utterancesPerSec > best.utterancesPerSec) best = l;
  const ups = best ? best.utterancesPerSec : 0;
  return {
    formula: "maxCitizens = floor(bestSustainableUtterancesPerSec * intervalSec)",
    sustainableDefinition: `highest utterancesPerSec among concurrency levels whose p95 latency <= ${maxLatencyMs} ms`,
    assumptions: [
      "each citizen speaks once per interval on average, so the required rate is N / interval utterances/sec",
      "the LLM servers are the only bottleneck (bridge / game chat cost ignored)",
      "the measured prompt length (system prompt + ~8 chat lines) matches the real conversation",
      "the scheduler can keep the best concurrency level's number of requests in flight",
    ],
    maxLatencyMs,
    bestConcurrency: best ? best.concurrency : null,
    bestSustainableUtterancesPerSec: ups,
    table: intervals.map((iv) => ({ intervalSec: iv, maxCitizens: Math.floor(ups * iv) })),
  };
}

async function runThroughput(opts) {
  const pickHost = makeHostPicker(opts.hosts);
  const levels = [];
  for (const c of opts.concurrency) {
    log(opts, `[throughput] concurrency=${c} requests=${opts.requests} ...`);
    const lvl = await runLevel(opts, c, pickHost);
    levels.push(lvl);
    log(
      opts,
      `  wall=${lvl.wallMs}ms ups=${lvl.utterancesPerSec} p50=${lvl.latencyMs.p50} p95=${lvl.latencyMs.p95} ` +
        `max=${lvl.latencyMs.max} outTok=${lvl.meanOutputTokens} tok/s=${lvl.outputTokensPerSecAggregate} err=${lvl.errors}`
    );
  }
  const capacity = computeCapacity(levels, opts.intervals, opts.maxLatencyMs);
  return { mode: "throughput", config: publicConfig(opts), levels, capacity };
}

// --------------------------------------------------------------------- live

function fetchJson(host, port, p, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path: p, timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

// GET /status returns an array of colonies; each has citizens[] with
// {id, name, job, jobStatus, ...} (VoyagerBridge.handleStatus).
async function loadCitizens(opts) {
  let real = [];
  let statusError = null;
  try {
    const status = await fetchJson(opts.bridge.host, opts.bridge.port, "/status");
    const colonies = Array.isArray(status) ? status : [status];
    for (const col of colonies) {
      for (const c of (col && col.citizens) || []) {
        if (!c || !c.name) continue;
        real.push({
          id: c.id,
          name: String(c.name),
          job: c.job || "unemployed",
          colonyId: col.id,
          synthetic: false,
        });
      }
    }
  } catch (e) {
    statusError = e.message;
  }
  real = real.map((c, i) => ({ ...c, personality: PERSONALITIES[i % PERSONALITIES.length] }));
  return { real, statusError };
}

function pickCitizens(real, n, allowSynthetic) {
  const out = real.slice(0, n);
  let k = 0;
  while (out.length < n && allowSynthetic) out.push(synthCitizen(k++));
  return out;
}

function sayToPipe(cmdPipe, name, text) {
  const safe = String(text).replace(/"/g, "'").slice(0, 200);
  try {
    // Same pattern as council.js sayInGame: non-blocking open so a FIFO with no
    // reader throws ENXIO immediately instead of hanging.
    const fd = fs.openSync(cmdPipe, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    try {
      fs.writeSync(fd, `say ${name}: ${safe}\n`);
    } finally {
      fs.closeSync(fd);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.code || e.message };
  }
}

async function runLiveSession(opts, citizens, pickHost, transcriptFd) {
  const n = citizens.length;
  const intervalMs = opts.interval * 1000;
  const durationMs = opts.duration * 1000;
  const jitter = opts.jitter;
  const chat = [];
  const utterances = [];
  const t0 = Date.now();
  const state = citizens.map((c) => ({
    c,
    nextSlot: Math.random() * intervalMs, // relative to t0
    busy: false,
    count: 0,
  }));
  let inFlight = 0;
  let maxBacklog = 0;
  const backlogSamples = [];
  let sayFailures = 0;
  const pending = new Set();

  const start = (s, now) => {
    s.busy = true;
    inFlight++;
    const slot = s.nextSlot;
    const startRel = now - t0;
    const context = chat.slice(-CONTEXT_LINES);
    const p = llmChat(pickHost(), opts, buildMessages(s.c, context)).then((r) => {
      const endRel = Date.now() - t0;
      inFlight--;
      s.busy = false;
      // Chain from the slot, not from "now": falling behind shows up as lag.
      s.nextSlot = slot + intervalMs * (1 + jitter * (Math.random() * 2 - 1));
      const rec = {
        n,
        citizenId: s.c.id,
        name: s.c.name,
        synthetic: !!s.c.synthetic,
        slotMs: Math.round(slot),
        startMs: startRel,
        endMs: endRel,
        scheduleLagMs: Math.max(0, Math.round(startRel - slot)),
        deliveryLagMs: Math.max(0, Math.round(endRel - slot)),
        latencyMs: r.latencyMs,
        host: r.host,
        ok: r.ok,
        withinDuration: endRel <= durationMs,
        contextLines: context.length,
        replyTo: context.length ? context[context.length - 1].name : null,
        evalCount: r.evalCount === undefined ? null : r.evalCount,
        evalDurationNs: r.evalDurationNs === undefined ? null : r.evalDurationNs,
        promptEvalCount: r.promptEvalCount === undefined ? null : r.promptEvalCount,
        promptEvalDurationNs: r.promptEvalDurationNs === undefined ? null : r.promptEvalDurationNs,
      };
      if (r.ok) {
        rec.rawText = r.text;
        rec.text = cleanReply(r.text, s.c.name) || r.text.slice(0, MAX_CHARS);
        chat.push({ name: s.c.name, text: rec.text });
        if (rec.withinDuration) s.count++;
        if (opts.say) {
          const w = sayToPipe(opts.cmdPipe, s.c.name, rec.text);
          rec.said = w.ok;
          if (!w.ok) {
            rec.sayError = w.error;
            sayFailures++;
          }
        }
      } else {
        rec.error = r.error;
      }
      rec.wallTime = new Date().toISOString();
      utterances.push(rec);
      if (transcriptFd !== null) fs.writeSync(transcriptFd, JSON.stringify(rec) + "\n");
      if (opts.verbose) log(opts, `  [N=${n}] ${rec.name}: ${rec.text || "(error " + rec.error + ")"} (${rec.latencyMs}ms)`);
    });
    pending.add(p);
    p.then(() => pending.delete(p));
  };

  while (Date.now() - t0 < durationMs) {
    const now = Date.now();
    const rel = now - t0;
    const due = state.filter((s) => !s.busy && s.nextSlot <= rel).sort((a, b) => a.nextSlot - b.nextSlot);
    for (const s of due) {
      if (inFlight >= opts.liveConcurrency) break;
      start(s, now);
    }
    const backlog = state.filter((s) => !s.busy && s.nextSlot <= rel).length;
    backlogSamples.push(backlog);
    if (backlog > maxBacklog) maxBacklog = backlog;
    await sleep(opts.tickMs);
  }
  // Let in-flight requests finish (logged, but not counted toward the rate).
  let drainTimer;
  await Promise.race([
    Promise.all([...pending]),
    new Promise((r) => (drainTimer = setTimeout(r, opts.timeoutMs + 1000))),
  ]);
  clearTimeout(drainTimer);

  return evaluateLive({
    n,
    citizens,
    utterances,
    intervalSec: opts.interval,
    durationSec: opts.duration,
    maxLatencyMs: opts.maxLatencyMs,
    maxBacklog,
    meanBacklog: mean(backlogSamples),
    sayFailures,
  });
}

// Pure: turns the utterance records of one session into the pass/fail verdict.
function evaluateLive({ n, citizens, utterances, intervalSec, durationSec, maxLatencyMs, maxBacklog = null, meanBacklog = null, sayFailures = 0 }) {
  const counted = utterances.filter((u) => u.ok && u.withinDuration);
  const okAll = utterances.filter((u) => u.ok);
  const lat = okAll.map((u) => u.latencyMs);
  const schedLag = utterances.map((u) => u.scheduleLagMs);
  const delivLag = okAll.map((u) => u.deliveryLagMs);
  const minutes = durationSec / 60;
  const targetPerCitizenPerMin = 60 / intervalSec;
  const achievedPerCitizenPerMin = n > 0 && minutes > 0 ? counted.length / n / minutes : 0;
  const perCitizen = citizens.map((c) => {
    const cnt = counted.filter((u) => u.citizenId === c.id).length;
    return { id: c.id, name: c.name, synthetic: !!c.synthetic, utterances: cnt, perMin: round(cnt / minutes, 2) };
  });
  const p95 = percentile(lat, 95);
  const latencyOk = p95 !== null && p95 <= maxLatencyMs;
  const rateRatio = targetPerCitizenPerMin > 0 ? achievedPerCitizenPerMin / targetPerCitizenPerMin : 0;
  const rateOk = rateRatio >= RATE_PASS_RATIO;
  const replies = okAll.filter((u) => u.replyTo && u.replyTo !== u.name).length;
  return {
    n,
    syntheticCitizens: citizens.filter((c) => c.synthetic).length,
    utterances: counted.length,
    utterancesAfterEnd: okAll.length - counted.length,
    errors: utterances.length - okAll.length,
    targetPerCitizenPerMin: round(targetPerCitizenPerMin, 3),
    achievedPerCitizenPerMin: round(achievedPerCitizenPerMin, 3),
    achievedRatio: round(rateRatio, 3),
    minPerCitizenPerMin: perCitizen.length ? Math.min(...perCitizen.map((p) => p.perMin)) : null,
    latencyMs: { p50: percentile(lat, 50), p95, max: lat.length ? Math.max(...lat) : null },
    scheduleLagMs: { p50: percentile(schedLag, 50), p95: percentile(schedLag, 95), max: schedLag.length ? Math.max(...schedLag) : null },
    deliveryLagMs: { p50: percentile(delivLag, 50), p95: percentile(delivLag, 95), max: delivLag.length ? Math.max(...delivLag) : null },
    backlog: { max: maxBacklog, mean: round(meanBacklog, 2) },
    repliesToOtherCitizen: replies,
    sayFailures,
    latencyOk,
    rateOk,
    passed: latencyOk && rateOk,
    perCitizen,
  };
}

async function runLive(opts, transcriptPath) {
  const pickHost = makeHostPicker(opts.hosts);
  const { real, statusError } = await loadCitizens(opts);
  if (statusError) log(opts, `[live] bridge /status unavailable (${statusError}); using synthetic citizens only`);
  const transcriptFd = transcriptPath ? fs.openSync(transcriptPath, "a") : null;
  const sessions = [];
  try {
    for (const n of opts.ramp) {
      const citizens = pickCitizens(real, n, opts.allowSynthetic);
      if (citizens.length < n) {
        sessions.push({ n, skipped: true, reason: `only ${citizens.length} real citizens and --allow-synthetic=false`, passed: false });
        log(opts, `[live] N=${n} skipped (only ${citizens.length} real citizens)`);
        continue;
      }
      log(opts, `[live] N=${n} (${citizens.filter((c) => c.synthetic).length} synthetic) interval=${opts.interval}s duration=${opts.duration}s ...`);
      const s = await runLiveSession(opts, citizens, pickHost, transcriptFd);
      sessions.push(s);
      log(
        opts,
        `  achieved=${s.achievedPerCitizenPerMin}/min (target ${s.targetPerCitizenPerMin}, ${Math.round(s.achievedRatio * 100)}%) ` +
          `p50=${s.latencyMs.p50} p95=${s.latencyMs.p95} schedLag p95=${s.scheduleLagMs.p95} backlog max=${s.backlog.max} ` +
          `err=${s.errors} -> ${s.passed ? "PASS" : "FAIL"}`
      );
    }
  } finally {
    if (transcriptFd !== null) fs.closeSync(transcriptFd);
  }
  const passedNs = sessions.filter((s) => s.passed).map((s) => s.n);
  return {
    mode: "live",
    config: publicConfig(opts),
    realCitizensAvailable: real.length,
    statusError,
    criterion: {
      definition: `p95 LLM latency <= ${opts.maxLatencyMs} ms AND achieved utterances/citizen/min >= ${RATE_PASS_RATIO * 100}% of target (60 / interval)`,
      maxLatencyMs: opts.maxLatencyMs,
      rateRatio: RATE_PASS_RATIO,
    },
    sessions,
    largestPassingN: passedNs.length ? Math.max(...passedNs) : null,
    transcript: transcriptPath || null,
  };
}

// --------------------------------------------------------------------- main

function log(opts, msg) {
  if (!opts.quiet) console.log(msg);
}

function publicConfig(opts) {
  // apiKey is deliberately dropped: the key never reaches result files.
  const { quiet, verbose, apiKey, ...rest } = opts;
  return { ...rest, apiKeySet: !!apiKey, hosts: opts.hosts.map((h) => `${h.host}:${h.port}`), bridge: `${opts.bridge.host}:${opts.bridge.port}` };
}

function buildOptions(args, env = process.env) {
  const mode = args.mode || "throughput";
  const api = String(args.api || "openai").toLowerCase();
  if (api !== "openai" && api !== "ollama") throw new Error(`unknown --api=${args.api} (openai|ollama)`);
  const defaultHosts = api === "ollama" ? "192.168.15.150:11434" : "127.0.0.1:8080";
  const hosts = String(args["llm-hosts"] || defaultHosts)
    .split(",")
    .filter((s) => s.trim())
    .map((s) => parseHostPort(s, api === "ollama" ? 11434 : 8080));
  const bridge = args.bridge
    ? parseHostPort(args.bridge, 8089)
    : { host: env.BRIDGE_HOST || "localhost", port: parseInt(env.BRIDGE_PORT || "8089", 10) };
  const ramp = args.ramp !== undefined ? numList(args.ramp, [4]) : [Number(args.citizens) || 4];
  return {
    mode,
    hosts,
    api,
    apiKey: env.LLM_API_KEY || null,
    model: args.model || "gemma4:e4b",
    maxTokens: Number(args["max-tokens"]) || 60,
    maxLatencyMs: Number(args["max-latency-ms"]) || 5000,
    timeoutMs: Number(args["timeout-ms"]) || 60000,
    // throughput
    concurrency: numList(args.concurrency, [1, 2, 4, 8, 16]),
    requests: Number(args.requests) || 24,
    intervals: numList(args.intervals, [10, 20, 30, 60]),
    // live
    bridge,
    ramp,
    interval: Number(args.interval) || 20,
    duration: Number(args.duration) || 120,
    jitter: args.jitter !== undefined ? Math.min(0.9, Math.max(0, Number(args.jitter))) : 0.2,
    liveConcurrency: Number(args["live-concurrency"]) || 4 * hosts.length,
    allowSynthetic: boolArg(args["allow-synthetic"], true),
    say: boolArg(args.say, false),
    cmdPipe: env.CMD_PIPE || "/root/mc-server-forge/cmd_pipe",
    tickMs: Number(args["tick-ms"]) || 50,
    out: args.out || null,
    quiet: boolArg(args.quiet, false),
    verbose: boolArg(args.verbose, false),
  };
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(fs.readFileSync(__filename, "utf8").split("\n").filter((l) => l.startsWith("//")).join("\n"));
    return null;
  }
  const opts = buildOptions(args, env);
  if (opts.api === "openai" && !opts.apiKey) log(opts, "[warn] LLM_API_KEY is not set; sending requests without Authorization");
  if (opts.mode !== "throughput" && opts.mode !== "live") throw new Error(`unknown --mode=${opts.mode}`);
  const out = opts.out || path.join("experiment_logs", `chat_bench_${opts.mode}_${timestamp()}.json`);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  const startedAt = new Date().toISOString();
  let result;
  if (opts.mode === "throughput") {
    result = await runThroughput(opts);
  } else {
    const transcript = out.replace(/\.json$/i, "") + ".transcript.jsonl";
    if (!opts.say) log(opts, "[live] dry-run: nothing is written to game chat (use --say to post)");
    result = await runLive(opts, transcript);
  }
  result.startedAt = startedAt;
  result.finishedAt = new Date().toISOString();
  fs.writeFileSync(out, JSON.stringify(result, null, 2) + "\n");

  if (result.mode === "throughput") {
    const cap = result.capacity;
    log(opts, `\n[capacity] best sustainable = ${cap.bestSustainableUtterancesPerSec} utt/s (concurrency ${cap.bestConcurrency}, p95 <= ${cap.maxLatencyMs}ms)`);
    for (const row of cap.table) log(opts, `  interval ${row.intervalSec}s -> max ${row.maxCitizens} citizens`);
  } else {
    log(opts, `\n[live] largest N that passed: ${result.largestPassingN === null ? "none" : result.largestPassingN}`);
    log(opts, `  transcript: ${result.transcript}`);
  }
  log(opts, `  result: ${out}`);
  result.out = out;
  return result;
}

module.exports = {
  parseArgs,
  buildOptions,
  percentile,
  cleanReply,
  computeCapacity,
  summarizeLevel,
  evaluateLive,
  pickCitizens,
  loadCitizens,
  sayToPipe,
  llmChat,
  buildLlmRequest,
  parseLlmResponse,
  runThroughput,
  runLive,
  main,
};

if (require.main === module) {
  main().catch((e) => {
    console.error(e.stack || e.message);
    process.exit(1);
  });
}
