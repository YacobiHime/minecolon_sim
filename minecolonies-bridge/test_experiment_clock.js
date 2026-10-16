const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const Clock = require("./experiment_clock.js");

function close(a, b, msg) {
  assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} != ${b}`);
}

function testSummarize() {
  // 0-10s at 10x (2000 ticks), 10-30s at 20x (8000 ticks), plus an error line.
  const recs = [
    { wallTime: "2026-10-16T00:00:10.000Z", wallMs: 10000, gameTime: 3000, dayTime: 3000, multiplier: 20, auto: true, msptMs: 1 },
    { wallTime: "2026-10-16T00:00:00.000Z", wallMs: 0, gameTime: 1000, dayTime: 1000, multiplier: 10, auto: true, msptMs: 2 },
    { wallTime: "2026-10-16T00:00:20.000Z", wallMs: 20000, error: "HTTP 500" },
    { wallTime: "2026-10-16T00:00:30.000Z", wallMs: 30000, gameTime: 11000, dayTime: 11000, multiplier: 20, auto: true, msptMs: 1 },
  ];
  const s = Clock.summarize(recs, 10);
  assert.strictEqual(s.samples, 4);
  assert.strictEqual(s.validSamples, 3);
  assert.strictEqual(s.errorSamples, 1);
  assert.strictEqual(s.elapsedWallSec, 30);
  assert.strictEqual(s.elapsedTicks, 10000);
  assert.strictEqual(s.elapsedGameSec, 500);
  assert.strictEqual(s.minMultiplier, 10);
  assert.strictEqual(s.maxMultiplier, 20);
  close(s.meanMultiplierTimeWeighted, (10 * 10 + 20 * 20) / 30, "time-weighted mean");
  close(s.effectiveMultiplier, 500 / 30, "effective multiplier");
  assert.strictEqual(s.equivalentWallSecAtFixed, 50); // 10000 / (20*10)
  assert.strictEqual(Clock.summarize(recs, 20).equivalentWallSecAtFixed, 25);
  assert.strictEqual(s.startWallTime, "2026-10-16T00:00:00.000Z");

  const empty = Clock.summarize([], 10);
  assert.strictEqual(empty.validSamples, 0);
  assert.strictEqual(empty.elapsedTicks, null);

  const one = Clock.summarize([recs[1]], 10);
  assert.strictEqual(one.elapsedTicks, 0);
  assert.strictEqual(one.meanMultiplierTimeWeighted, 10);
  assert.strictEqual(one.effectiveMultiplier, null);
}

function startMock() {
  let gameTime = 5000;
  let calls = 0;
  const methods = [];
  const server = http.createServer((req, res) => {
    methods.push(`${req.method} ${req.url}`);
    calls++;
    if (calls === 2) { // second request fails -> error line, poller continues
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end('{"error":"boom"}');
      return;
    }
    gameTime += 40;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ multiplier: 12, auto: true, msptMs: 3.5, autoMax: 40, headroom: 0.8,
      gameTime, dayTime: gameTime % 24000 }));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, methods })));
}

function runCli(args, port, killAfterMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "experiment_clock.js"), ...args], {
      env: { ...process.env, BRIDGE_HOST: "127.0.0.1", BRIDGE_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const killer = killAfterMs ? setTimeout(() => child.kill("SIGTERM"), killAfterMs) : null;
    const guard = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("CLI timed out")); }, 10000);
    child.on("exit", (code, signal) => {
      clearTimeout(guard);
      if (killer) clearTimeout(killer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function readLines(file) {
  return fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

async function testPoller() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "expclock-"));
  const { server, methods } = await startMock();
  const port = server.address().port;
  try {
    // --duration: samples at t=0 (ok) and t=0.2s (HTTP 500), then exits.
    const out = path.join(tmp, "logs", "A-1_clock.jsonl");
    const r = await runCli([`--out=${out}`, "--interval=0.2", "--duration=0.3"], port);
    assert.strictEqual(r.code, 0, r.stderr);
    const lines = readLines(out);
    assert.strictEqual(lines.length, 2, JSON.stringify(lines));
    const [a, b] = lines;
    assert.strictEqual(a.gameTime, 5040);
    assert.strictEqual(a.dayTime, 5040);
    assert.strictEqual(a.multiplier, 12);
    assert.strictEqual(a.auto, true);
    assert.strictEqual(a.msptMs, 3.5);
    assert.ok(Number.isFinite(a.wallMs));
    assert.strictEqual(new Date(a.wallMs).toISOString(), a.wallTime);
    assert.deepStrictEqual(Object.keys(a),
      ["wallTime", "wallMs", "gameTime", "dayTime", "multiplier", "auto", "msptMs"]);
    assert.ok(/HTTP 500/.test(b.error), JSON.stringify(b));
    assert.ok(b.wallMs >= a.wallMs);

    // No --duration: runs until SIGTERM, then exits cleanly (appends to file).
    const out2 = path.join(tmp, "sig.jsonl");
    const r2 = await runCli([`--out=${out2}`, "--interval=0.1"], port, 450);
    assert.strictEqual(r2.code, 0, `exit ${r2.code}/${r2.signal}: ${r2.stderr}`);
    const lines2 = readLines(out2);
    assert.ok(lines2.length >= 2, `expected >=2 samples, got ${lines2.length}`);
    assert.ok(lines2.every((l) => !l.error && l.gameTime > 5040));

    // Read-only: every request was GET /tickrate.
    assert.ok(methods.length >= 4);
    assert.ok(methods.every((m) => m === "GET /tickrate"), methods.join(","));

    // --summarize CLI over the recorded file.
    const r3 = await runCli([`--summarize=${out2}`, "--fixed=10"], port);
    assert.strictEqual(r3.code, 0, r3.stderr);
    const s = JSON.parse(r3.stdout);
    assert.strictEqual(s.validSamples, lines2.length);
    assert.strictEqual(s.elapsedTicks, 40 * (lines2.length - 1));
    assert.strictEqual(s.equivalentWallSecAtFixed, s.elapsedTicks / 200);
    assert.strictEqual(s.meanMultiplierTimeWeighted, 12);

    // Missing --out is a usage error.
    const r4 = await runCli([], port);
    assert.strictEqual(r4.code, 2);
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

(async () => {
  testSummarize();
  await testPoller();
  console.log("test_experiment_clock: all tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
