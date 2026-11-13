// Tests for chat_capacity_bench.js against a mock Ollama and a mock bridge.
// Run: node test_chat_capacity_bench.js
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const Bench = require("./chat_capacity_bench.js");

const API_KEY = "test-key-123-secret";

// Mock LLM: Ollama /api/chat and llama.cpp llama-server /v1/chat/completions
// (the latter requires "Authorization: Bearer API_KEY"). Sleeps delayMs and
// answers with fake token stats.
function startMockLLM(delayMs) {
  const seen = [];
  const paths = [];
  const auths = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      paths.push(req.url);
      auths.push(req.headers.authorization || null);
      const openai = req.url === "/v1/chat/completions";
      if (openai && req.headers.authorization !== `Bearer ${API_KEY}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: 401, message: "Invalid API Key" } }));
        return;
      }
      if (!openai && req.url !== "/api/chat") {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      const parsed = JSON.parse(body);
      seen.push(parsed);
      setTimeout(() => {
        const name = (/住民「([^」]+)」/.exec(parsed.messages[0].content) || [])[1] || "?";
        const content = `${name}: 「そうだね、${seen.length}回目の話だ」\n余計な2行目`;
        res.writeHead(200, { "Content-Type": "application/json" });
        if (openai) {
          res.end(JSON.stringify({
            object: "chat.completion",
            model: parsed.model,
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
            usage: { prompt_tokens: 140, completion_tokens: 10, total_tokens: 150 },
            timings: { prompt_n: 140, prompt_ms: 15, predicted_n: 10, predicted_ms: 250 },
          }));
        } else {
          res.end(JSON.stringify({
            model: parsed.model,
            message: { role: "assistant", content },
            done: true,
            eval_count: 12,
            eval_duration: 400e6,
            prompt_eval_count: 150,
            prompt_eval_duration: 20e6,
          }));
        }
      }, delayMs);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, seen, paths, auths })));
}

function startMockBridge(citizens) {
  const methods = [];
  const server = http.createServer((req, res) => {
    methods.push(`${req.method} ${req.url}`);
    if (req.method === "GET" && req.url === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([{ id: 1, name: "TestColony", buildings: [], citizens }]));
    } else {
      res.writeHead(404);
      res.end("no");
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, methods })));
}

function testPure() {
  assert.strictEqual(Bench.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
  assert.strictEqual(Bench.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.strictEqual(Bench.percentile([], 50), null);
  assert.strictEqual(Bench.cleanReply("ミナ: 「おはよう」\n2行目", "ミナ"), "おはよう");
  assert.strictEqual(Bench.cleanReply("\"いい天気だね\"", "X"), "いい天気だね");
  assert.strictEqual(Bench.cleanReply("あ".repeat(60), "X").length, 40);

  const lv = (c, ups, p95) => ({ concurrency: c, ok: 10, utterancesPerSec: ups, latencyMs: { p50: 1, p95, max: p95 } });
  const cap = Bench.computeCapacity([lv(1, 0.5, 2000), lv(4, 1.7, 4900), lv(8, 2.5, 7000)], [10, 20, 60], 5000);
  assert.strictEqual(cap.bestConcurrency, 4);
  assert.strictEqual(cap.bestSustainableUtterancesPerSec, 1.7);
  assert.deepStrictEqual(cap.table.map((r) => r.maxCitizens), [17, 34, 102]);
  assert.ok(cap.formula.includes("floor"));
  const none = Bench.computeCapacity([lv(1, 3, 9000)], [20], 5000);
  assert.strictEqual(none.bestSustainableUtterancesPerSec, 0);
  assert.strictEqual(none.table[0].maxCitizens, 0);

  // evaluateLive pass/fail logic: 2 citizens, interval 10s, 60s => target 6/min/citizen... 1/10s = 6/min.
  const citizens = [{ id: 1, name: "A" }, { id: 2, name: "B", synthetic: true }];
  const mk = (id, n, lat, within = true) => Array.from({ length: n }, () => ({
    citizenId: id, name: id === 1 ? "A" : "B", ok: true, withinDuration: within, latencyMs: lat,
    scheduleLagMs: 0, deliveryLagMs: lat, replyTo: id === 1 ? "B" : "A",
  }));
  const good = Bench.evaluateLive({ n: 2, citizens, utterances: [...mk(1, 6, 1000), ...mk(2, 5, 1000)], intervalSec: 10, durationSec: 60, maxLatencyMs: 5000 });
  assert.strictEqual(good.achievedRatio, round3(11 / 12));
  assert.ok(good.rateOk && good.latencyOk && good.passed);
  assert.strictEqual(good.syntheticCitizens, 1);
  const slow = Bench.evaluateLive({ n: 2, citizens, utterances: [...mk(1, 6, 6000), ...mk(2, 6, 6000)], intervalSec: 10, durationSec: 60, maxLatencyMs: 5000 });
  assert.ok(slow.rateOk && !slow.latencyOk && !slow.passed);
  const sparse = Bench.evaluateLive({ n: 2, citizens, utterances: [...mk(1, 5, 100), ...mk(2, 5, 100), ...mk(2, 3, 100, false)], intervalSec: 10, durationSec: 60, maxLatencyMs: 5000 });
  assert.strictEqual(sparse.utterances, 10);
  assert.strictEqual(sparse.utterancesAfterEnd, 3);
  assert.ok(!sparse.rateOk && !sparse.passed); // 10/12 = 83% < 90%

  // Option defaults.
  const o = Bench.buildOptions({}, {});
  assert.deepStrictEqual(o.concurrency, [1, 2, 4, 8, 16]);
  assert.strictEqual(o.requests, 24);
  assert.strictEqual(o.maxTokens, 60);
  assert.strictEqual(o.maxLatencyMs, 5000);
  assert.strictEqual(o.interval, 20);
  assert.strictEqual(o.duration, 120);
  assert.strictEqual(o.say, false);
  assert.strictEqual(o.allowSynthetic, true);
  assert.strictEqual(o.model, "gemma4:e4b");
  assert.strictEqual(o.api, "openai");
  assert.deepStrictEqual(o.hosts, [{ host: "127.0.0.1", port: 8080 }]);
  assert.strictEqual(o.apiKey, null);
  assert.strictEqual(o.cmdPipe, "/root/mc-server-forge/cmd_pipe");
  const ol = Bench.buildOptions({ api: "ollama" }, { LLM_API_KEY: "k" });
  assert.deepStrictEqual(ol.hosts, [{ host: "192.168.15.150", port: 11434 }]);
  assert.throws(() => Bench.buildOptions({ api: "vllm" }, {}), /unknown --api/);

  // Request bodies per API; the Bearer header only on openai.
  const msgs = [{ role: "user", content: "x" }];
  const oa = Bench.buildLlmRequest("openai", "m", msgs, 60, "KEY");
  assert.strictEqual(oa.path, "/v1/chat/completions");
  assert.strictEqual(oa.headers.Authorization, "Bearer KEY");
  assert.deepStrictEqual(JSON.parse(oa.payload), { model: "m", messages: msgs, max_tokens: 60, temperature: 0.8, stream: false });
  const ob = Bench.buildLlmRequest("ollama", "m", msgs, 60, "KEY");
  assert.strictEqual(ob.path, "/api/chat");
  assert.strictEqual(ob.headers.Authorization, undefined);
  assert.strictEqual(JSON.parse(ob.payload).think, false);
  // usage{} fallback when llama.cpp timings{} are absent.
  const pr = Bench.parseLlmResponse("openai", { choices: [{ message: { content: " hi " } }], usage: { prompt_tokens: 7, completion_tokens: 3 } });
  assert.deepStrictEqual(pr, { text: "hi", evalCount: 3, evalDurationNs: null, promptEvalCount: 7, promptEvalDurationNs: null });
  console.log("ok pure functions");
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

async function testThroughput(tmp) {
  const a = await startMockLLM(100);
  const b = await startMockLLM(100);
  try {
    const out = path.join(tmp, "tp.json");
    const res = await Bench.main([
      "--mode=throughput",
      "--api=ollama",
      `--llm-hosts=127.0.0.1:${a.port},127.0.0.1:${b.port}`,
      "--concurrency=1,4",
      "--requests=8",
      "--intervals=10,20",
      "--max-latency-ms=1000",
      `--out=${out}`,
      "--quiet",
    ]);
    const saved = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.strictEqual(saved.mode, "throughput");
    assert.strictEqual(saved.levels.length, 2);
    // Request format mirrors council.js.
    const req = a.seen[0];
    assert.strictEqual(req.stream, false);
    assert.strictEqual(req.think, false);
    assert.strictEqual(req.options.num_predict, 60);
    assert.strictEqual(req.options.temperature, 0.8);
    assert.strictEqual(req.model, "gemma4:e4b");
    assert.ok(req.messages[1].content.split("\n").length >= 8, "context has ~8 chat lines");
    // Round-robin: both hosts used, 16 requests total.
    assert.strictEqual(a.seen.length + b.seen.length, 16);
    assert.strictEqual(a.seen.length, 8);
    const [l1, l4] = saved.levels;
    assert.strictEqual(l1.errors, 0);
    assert.strictEqual(l1.ok, 8);
    assert.strictEqual(l1.meanOutputTokens, 12);
    assert.strictEqual(l1.meanPromptTokens, 150);
    assert.strictEqual(l1.meanPerRequestDecodeTokensPerSec, 30); // 12 / 0.4s
    assert.ok(l1.latencyMs.p50 >= 100 && l1.latencyMs.p95 < 1000, JSON.stringify(l1.latencyMs));
    // c=1 -> ~10/s max, c=4 -> ~4x faster wall time.
    assert.ok(l1.utterancesPerSec > 5 && l1.utterancesPerSec <= 10.5, `c1 ups ${l1.utterancesPerSec}`);
    assert.ok(l4.utterancesPerSec > l1.utterancesPerSec * 2, `c4 ups ${l4.utterancesPerSec}`);
    assert.ok(Math.abs(l1.outputTokensPerSecAggregate - (8 * 12) / (l1.wallMs / 1000)) < 0.1);
    const cap = saved.capacity;
    assert.strictEqual(cap.bestConcurrency, 4);
    assert.strictEqual(cap.bestSustainableUtterancesPerSec, l4.utterancesPerSec);
    assert.deepStrictEqual(cap.table, [
      { intervalSec: 10, maxCitizens: Math.floor(l4.utterancesPerSec * 10) },
      { intervalSec: 20, maxCitizens: Math.floor(l4.utterancesPerSec * 20) },
    ]);
    assert.ok(Array.isArray(cap.assumptions) && cap.assumptions.length > 0);
    assert.strictEqual(res.out, out);

    // Errors are counted, not thrown: a dead host.
    const errRes = await Bench.runThroughput({
      ...Bench.buildOptions({ concurrency: "2", requests: "4", "timeout-ms": "2000" }, {}),
      hosts: [{ host: "127.0.0.1", port: 1 }],
      quiet: true,
    });
    assert.strictEqual(errRes.levels[0].errors, 4);
    assert.strictEqual(errRes.capacity.bestSustainableUtterancesPerSec, 0);
    assert.ok(a.paths.every((p) => p === "/api/chat") && a.auths.every((h) => h === null));
    console.log(`ok throughput ollama (c1 ${l1.utterancesPerSec} utt/s, c4 ${l4.utterancesPerSec} utt/s)`);
  } finally {
    a.server.close();
    b.server.close();
  }
}

async function testThroughputOpenAI(tmp) {
  const m = await startMockLLM(50);
  try {
    const out = path.join(tmp, "tp_openai.json");
    const args = [
      "--mode=throughput",
      `--llm-hosts=127.0.0.1:${m.port}`,
      "--concurrency=1,2",
      "--requests=4",
      "--intervals=20",
      `--out=${out}`,
      "--quiet",
    ];
    await Bench.main(args, { LLM_API_KEY: API_KEY });
    assert.ok(m.paths.every((p) => p === "/v1/chat/completions"));
    assert.ok(m.auths.every((h) => h === `Bearer ${API_KEY}`), "Bearer key sent on every request");
    const req = m.seen[0];
    assert.strictEqual(req.max_tokens, 60);
    assert.strictEqual(req.temperature, 0.8);
    assert.strictEqual(req.stream, false);
    assert.strictEqual(req.think, undefined);
    assert.strictEqual(req.options, undefined);
    const raw = fs.readFileSync(out, "utf8");
    assert.ok(!raw.includes(API_KEY), "API key must not be written to the result file");
    const saved = JSON.parse(raw);
    assert.strictEqual(saved.config.api, "openai");
    assert.strictEqual(saved.config.apiKeySet, true);
    const l1 = saved.levels[0];
    assert.strictEqual(l1.errors, 0);
    assert.strictEqual(l1.meanOutputTokens, 10); // timings.predicted_n
    assert.strictEqual(l1.meanPromptTokens, 140); // timings.prompt_n
    assert.strictEqual(l1.meanPerRequestDecodeTokensPerSec, 40); // 10 / 0.25s
    assert.strictEqual(l1.meanPromptEvalMs, 15);
    assert.ok(saved.capacity.bestSustainableUtterancesPerSec > 0);

    // Wrong / missing key -> 401 counted as errors, never thrown.
    const bad = await Bench.main([...args.slice(0, -2), "--concurrency=1", "--requests=2", `--out=${path.join(tmp, "tp_nokey.json")}`, "--quiet"], {});
    assert.strictEqual(bad.levels[0].errors, 2);
    assert.ok(/HTTP 401/.test(bad.levels[0].errorSamples[0]));
    assert.strictEqual(bad.capacity.bestSustainableUtterancesPerSec, 0);
    console.log("ok throughput openai (Bearer auth, usage/timings, key not saved)");
  } finally {
    m.server.close();
  }
}

function mkfifo(p) {
  execFileSync("mkfifo", [p]);
}

function drainFifo(fd) {
  const buf = Buffer.alloc(65536);
  try {
    const n = fs.readSync(fd, buf, 0, buf.length, null);
    return buf.slice(0, n).toString("utf8");
  } catch (e) {
    if (e.code === "EAGAIN") return "";
    throw e;
  }
}

async function testLive(tmp) {
  const llm = await startMockLLM(60);
  const bridge = await startMockBridge([
    { id: 11, name: "Alice Smith", job: "builder", jobStatus: "working" },
    { id: 12, name: "Bob Jones", job: "farmer", jobStatus: "idle" },
  ]);
  const fifo = path.join(tmp, "cmd_pipe");
  mkfifo(fifo);
  // Keep a reader open so a writer's non-blocking open would succeed.
  const reader = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  const common = [
    "--mode=live",
    `--llm-hosts=127.0.0.1:${llm.port}`,
    `--bridge=127.0.0.1:${bridge.port}`,
    "--interval=0.25",
    "--jitter=0.1",
    "--duration=4",
    "--max-latency-ms=1000",
    "--quiet",
  ];
  try {
    // Dry run (default): nothing written to the FIFO.
    const out = path.join(tmp, "live.json");
    const res = await Bench.main([...common, "--ramp=2,4", `--out=${out}`], { CMD_PIPE: fifo, LLM_API_KEY: API_KEY });
    assert.strictEqual(drainFifo(reader), "", "dry run must not write to cmd_pipe");
    assert.ok(bridge.methods.every((m) => m.startsWith("GET /status")), `bridge calls: ${bridge.methods}`);
    const saved = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.ok(llm.auths.length > 0 && llm.auths.every((h) => h === `Bearer ${API_KEY}`), "live mode sends the Bearer key");
    assert.strictEqual(saved.realCitizensAvailable, 2);
    assert.strictEqual(saved.config.say, false);
    assert.strictEqual(saved.sessions.length, 2);
    const [s2, s4] = saved.sessions;
    assert.strictEqual(s2.syntheticCitizens, 0);
    assert.strictEqual(s4.syntheticCitizens, 2);
    assert.deepStrictEqual(s2.perCitizen.map((p) => p.name), ["Alice Smith", "Bob Jones"]);
    for (const s of [s2, s4]) {
      assert.strictEqual(s.errors, 0);
      assert.strictEqual(s.targetPerCitizenPerMin, 240);
      assert.ok(s.latencyOk, `latency p95 ${s.latencyMs.p95}`);
      assert.ok(s.achievedRatio >= 0.85 && s.achievedRatio <= 1.15, `ratio ${s.achievedRatio}`);
      assert.strictEqual(s.passed, s.latencyOk && s.rateOk);
      assert.ok(s.repliesToOtherCitizen > 0, "citizens reply to each other");
    }
    assert.ok(s2.passed && s4.passed, `s2 ${s2.achievedRatio} s4 ${s4.achievedRatio}`);
    assert.strictEqual(saved.largestPassingN, 4);
    // Transcript next to the result file, one JSON per utterance.
    const trRaw = fs.readFileSync(path.join(tmp, "live.transcript.jsonl"), "utf8");
    assert.ok(!trRaw.includes(API_KEY) && !fs.readFileSync(out, "utf8").includes(API_KEY), "key not in live outputs");
    const tr = trRaw.trim().split("\n").map((l) => JSON.parse(l));
    assert.strictEqual(tr.length, s2.utterances + s2.utterancesAfterEnd + s4.utterances + s4.utterancesAfterEnd);
    const u = tr.find((r) => r.ok);
    assert.ok(/^そうだね、\d+回目の話だ$/.test(u.text), `cleaned text: ${u.text}`);
    assert.strictEqual(u.evalCount, 10); // llama.cpp timings.predicted_n
    assert.ok(tr.some((r) => r.synthetic) && tr.some((r) => !r.synthetic));
    assert.ok(tr.filter((r) => r.contextLines > 0).length > 0);
    // Later speakers see earlier lines (from other citizens) in their prompt.
    assert.ok(llm.seen.some((s) => /Alice Smith: そうだね/.test(s.messages[1].content)));

    // Too slow -> latency criterion fails; synthetic disabled -> skipped.
    const strict = await Bench.main([...common, "--duration=2", "--ramp=2,3", "--max-latency-ms=10", "--allow-synthetic=false", `--out=${path.join(tmp, "strict.json")}`], { CMD_PIPE: fifo, LLM_API_KEY: API_KEY });
    assert.strictEqual(strict.sessions[0].passed, false);
    assert.strictEqual(strict.sessions[0].latencyOk, false);
    assert.strictEqual(strict.sessions[1].skipped, true);
    assert.strictEqual(strict.largestPassingN, null);
    assert.strictEqual(drainFifo(reader), "");

    // --say writes "say <name>: <text>" lines.
    const said = await Bench.main([...common, "--duration=2", "--citizens=2", "--say", `--out=${path.join(tmp, "say.json")}`], { CMD_PIPE: fifo, LLM_API_KEY: API_KEY });
    const written = drainFifo(reader);
    const lines = written.trim().split("\n");
    assert.ok(lines.length >= 2, `fifo got: ${written}`);
    assert.ok(lines.every((l) => /^say (Alice Smith|Bob Jones): そうだね、\d+回目の話だ$/.test(l)), written);
    assert.strictEqual(said.sessions[0].sayFailures, 0);
    console.log(`ok live (N=2 ${s2.achievedRatio}, N=4 ${s4.achievedRatio}, ${tr.length} transcript lines, ${lines.length} say lines)`);
  } finally {
    fs.closeSync(reader);
    llm.server.close();
    bridge.server.close();
  }

  // No reader on the FIFO -> ENXIO is skipped, not thrown or hung.
  const r = Bench.sayToPipe(fifo, "X", "hi");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, "ENXIO");
  // Bridge down -> all synthetic.
  const { real, statusError } = await Bench.loadCitizens({ bridge: { host: "127.0.0.1", port: 1 } });
  assert.strictEqual(real.length, 0);
  assert.ok(statusError);
  assert.strictEqual(Bench.pickCitizens([], 3, true).filter((c) => c.synthetic).length, 3);
  assert.strictEqual(Bench.pickCitizens([], 3, false).length, 0);
  console.log("ok ENXIO skip / synthetic fallback");
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chat-bench-"));
  try {
    testPure();
    await testThroughput(tmp);
    await testThroughputOpenAI(tmp);
    await testLive(tmp);
    console.log("all chat_capacity_bench tests passed");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
