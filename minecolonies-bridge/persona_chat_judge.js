#!/usr/bin/env node
// persona_chat_judge.js — LLM-as-judge hook for persona_chat_experiment.js
// output (NOT run by default; the judge model is still undecided).
//
// Two tasks per transcript:
//   who-said-it : show the cast (name, job, static profile) + up to 8 lines of
//                 context + one target line with the speaker masked as "???";
//                 the judge answers the speaker's name. Accuracy per condition
//                 = how identifiable each citizen's voice is.
//   rating      : show a window of consecutive lines; the judge rates
//                 naturalness and human-likeness on 1–5.
// The cast description given to the judge is the same for A and B (the
// static B profile = the "true" persona), so A is judged against the persona
// it was not told about. That is intentional: it measures persona fidelity.
//
//   node persona_chat_judge.js <out-dir> --judge-model=<model> \
//        [--judge-hosts=127.0.0.1:18080] [--api=openai|ollama] \
//        [--samples=40] [--windows=5] [--window-size=20] [--seed=judge-1]
// Key: env LLM_API_KEY (openai API only; never logged). Writes <out-dir>/judge.json.

const fs = require("fs");
const http = require("http");
const path = require("path");
const X = require("./persona_chat_experiment.js");

const MASK = "???";

function parseArgs(argv) {
  const args = { _: [] };
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) args[m[1]] = m[2] === undefined ? true : m[2];
    else args._.push(a);
  }
  return args;
}

function castDescription(fx) {
  return fx.citizens.map((c) => `■ ${c.name}(${c.jobLabel})\n${X.profileText(fx, c)}`).join("\n");
}

function lineText(fx, r) {
  if (r.type === "event") return `${X.NARRATOR_NAME}: ${r.text}`;
  return `${fx.byId[r.speakerId].name}: ${r.text}`;
}

// records: one transcript. targetIdx: index into records (an ok utterance).
function buildWhoSaidItMessages(fx, records, targetIdx) {
  const target = records[targetIdx];
  const ctx = [];
  for (let i = targetIdx - 1; i >= 0 && ctx.length < X.CONTEXT_LINES; i--) {
    const r = records[i];
    if (r.type === "event" || r.type === "seed_line" || (r.type === "utterance" && r.ok && r.text)) ctx.unshift(r);
  }
  const user =
    `村人の一覧:\n${castDescription(fx)}\n\n` +
    `会話:\n${ctx.map((r) => lineText(fx, r)).join("\n")}\n${MASK}: ${target.text}\n\n` +
    `「${MASK}」の発言をしたのは誰だと思いますか。村人の名前を1人だけ選び、` +
    `{"speaker":"名前"} というJSONだけを返してください。`;
  return [
    { role: "system", content: "あなたは会話ログを分析する評価者です。指示された形式だけで答えてください。" },
    { role: "user", content: user },
  ];
}

function buildRatingMessages(fx, lines) {
  const user =
    `次はゲームの村人たちのチャットログです。\n\n${lines.map((r) => lineText(fx, r)).join("\n")}\n\n` +
    `このログを次の2点で1〜5の整数で評価してください。\n` +
    `naturalness: 会話として自然につながっているか(5=とても自然)\n` +
    `humanlike: 人間が書いたように感じるか(5=人間らしい)\n` +
    `{"naturalness":数値,"humanlike":数値} というJSONだけを返してください。`;
  return [
    { role: "system", content: "あなたは会話ログを評価する評価者です。指示された形式だけで答えてください。" },
    { role: "user", content: user },
  ];
}

function extractJson(text) {
  const m = /\{[\s\S]*?\}/.exec(String(text || ""));
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch (_) {
    return null;
  }
}

// Returns citizen id or null. Falls back to the earliest cast name in text.
function parseWhoSaidIt(text, fx) {
  const j = extractJson(text);
  const s = j && typeof j.speaker === "string" ? j.speaker : String(text || "");
  let best = null;
  let bestPos = Infinity;
  for (const c of fx.citizens) {
    const p = s.indexOf(c.name);
    if (p >= 0 && p < bestPos) { best = c.id; bestPos = p; }
  }
  return best;
}

function clampRating(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 && n <= 5 ? n : null;
}

function parseRating(text) {
  const j = extractJson(text);
  if (j) return { naturalness: clampRating(j.naturalness), humanlike: clampRating(j.humanlike) };
  const nat = /naturalness\D*([1-5])/.exec(String(text || ""));
  const hum = /humanlike\D*([1-5])/.exec(String(text || ""));
  return { naturalness: nat ? Number(nat[1]) : null, humanlike: hum ? Number(hum[1]) : null };
}

function judgeRequest(hostPort, opts, messages) {
  return new Promise((resolve) => {
    const ollama = opts.api === "ollama";
    const body = ollama
      ? { model: opts.model, messages, stream: false, think: false, options: { temperature: 0, num_predict: opts.maxTokens } }
      : { model: opts.model, messages, stream: false, temperature: 0, max_tokens: opts.maxTokens, seed: 0 };
    const payload = JSON.stringify(body);
    const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) };
    if (!ollama && opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
    const req = http.request({
      host: hostPort.host, port: hostPort.port, method: "POST", headers,
      path: ollama ? "/api/chat" : "/v1/chat/completions",
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (data += d));
      res.on("end", () => {
        if (res.statusCode !== 200) return resolve({ ok: false, error: `HTTP ${res.statusCode}` });
        try {
          const p = JSON.parse(data);
          const text = ollama ? (p.message && p.message.content) || ""
            : (p.choices && p.choices[0] && p.choices[0].message && p.choices[0].message.content) || "";
          resolve({ ok: true, text });
        } catch (e) {
          resolve({ ok: false, error: `bad JSON: ${e.message}` });
        }
      });
    });
    req.setTimeout(opts.timeoutMs, () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ ok: false, error: e.message }));
    req.write(payload);
    req.end();
  });
}

function sampleIndices(n, k, rng) {
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, Math.min(k, n)).sort((a, b) => a - b);
}

// ask(messages) -> {ok, text}. Returns per-run judge results.
async function judgeRun(fx, records, ask, opts) {
  const uttIdx = records.map((r, i) => (r.type === "utterance" && r.ok && r.text ? i : -1)).filter((i) => i >= 0);
  const rng = X.seededRng(`${opts.seed}:${records[uttIdx[0]] ? records[uttIdx[0]].seed : ""}`);
  const who = [];
  for (const k of sampleIndices(uttIdx.length, opts.samples, rng)) {
    const i = uttIdx[k];
    const r = await ask(buildWhoSaidItMessages(fx, records, i));
    const guess = r.ok ? parseWhoSaidIt(r.text, fx) : null;
    who.push({ turn: records[i].turn, truth: records[i].speakerId, guess, correct: guess === records[i].speakerId, error: r.ok ? null : r.error });
  }
  const ratings = [];
  const utts = uttIdx.map((i) => records[i]);
  const size = opts.windowSize;
  const maxStart = Math.max(0, utts.length - size);
  for (let w = 0; w < opts.windows && utts.length; w++) {
    const start = opts.windows === 1 ? 0 : Math.round((w * maxStart) / (opts.windows - 1));
    const lines = utts.slice(start, start + size);
    const r = await ask(buildRatingMessages(fx, lines));
    ratings.push({ startTurn: lines[0].turn, ...(r.ok ? parseRating(r.text) : { naturalness: null, humanlike: null }), error: r.ok ? null : r.error });
  }
  const valid = who.filter((x) => !x.error);
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return {
    whoSaidItAccuracy: valid.length ? valid.filter((x) => x.correct).length / valid.length : null,
    chanceLevel: 1 / fx.citizens.length,
    meanNaturalness: avg(ratings.map((x) => x.naturalness).filter((x) => x !== null)),
    meanHumanlike: avg(ratings.map((x) => x.humanlike).filter((x) => x !== null)),
    who, ratings,
  };
}

async function judgeDir(dir, opts, ask) {
  const fx = X.prepareFixtures(X.loadFixtures(opts.fixtures));
  const runs = [];
  for (const f of fs.readdirSync(dir).filter((x) => /^transcript_.+\.jsonl$/.test(x)).sort()) {
    const recs = fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const first = recs.find((r) => r.type === "utterance");
    if (!first) continue;
    runs.push({ file: f, condition: first.condition, seed: first.seed, ...(await judgeRun(fx, recs, ask, opts)) });
  }
  return runs;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = args._[0];
  if (!dir || !args["judge-model"]) {
    console.error("usage: node persona_chat_judge.js <out-dir> --judge-model=<model> [--judge-hosts=h:p] [--api=openai|ollama]");
    process.exit(2);
  }
  const api = String(args.api || "openai");
  const defPort = api === "ollama" ? 11434 : 18080;
  const hosts = String(args["judge-hosts"] || `127.0.0.1:${defPort}`).split(",").map((s) => {
    const i = s.lastIndexOf(":");
    return i < 0 ? { host: s, port: defPort } : { host: s.slice(0, i), port: parseInt(s.slice(i + 1), 10) };
  });
  const opts = {
    api, model: args["judge-model"], apiKey: process.env.LLM_API_KEY || null,
    samples: parseInt(args.samples || "40", 10), windows: parseInt(args.windows || "5", 10),
    windowSize: parseInt(args["window-size"] || "20", 10), seed: args.seed || "judge-1",
    maxTokens: parseInt(args["max-tokens"] || "60", 10), timeoutMs: parseInt(args["timeout-ms"] || "120000", 10),
    fixtures: args.fixtures,
  };
  let hi = 0;
  const ask = (messages) => judgeRequest(hosts[hi++ % hosts.length], opts, messages);
  const runs = await judgeDir(dir, opts, ask);
  const { apiKey, ...pub } = opts;
  const out = { generatedAt: new Date().toISOString(), config: { ...pub, apiKeySet: !!apiKey, hosts: hosts.map((h) => `${h.host}:${h.port}`) }, runs };
  fs.writeFileSync(path.join(dir, "judge.json"), JSON.stringify(out, null, 2));
  for (const r of runs) {
    console.log(`${r.file}: who-said-it=${r.whoSaidItAccuracy} naturalness=${r.meanNaturalness} humanlike=${r.meanHumanlike}`);
  }
}

module.exports = {
  buildWhoSaidItMessages, buildRatingMessages, parseWhoSaidIt, parseRating, extractJson,
  judgeRequest, judgeRun, judgeDir, sampleIndices,
};

if (require.main === module) {
  main().catch((e) => {
    console.error(`[fatal] ${e.stack || e.message}`);
    process.exit(1);
  });
}
