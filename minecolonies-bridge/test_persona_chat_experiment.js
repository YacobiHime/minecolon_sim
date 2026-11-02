// Offline tests for persona_chat_experiment.js / _metrics.js / _judge.js.
// Uses a mock OpenAI-compatible server; never calls a real LLM.
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const X = require("./persona_chat_experiment.js");
const M = require("./persona_chat_metrics.js");
const J = require("./persona_chat_judge.js");
const Personas = require("./personas.js");

let passed = 0;
async function test(label, fn) {
  await fn();
  passed++;
  console.log(`PASS ${label}`);
}

const fx = X.prepareFixtures(X.loadFixtures());
const KEY = "test-secret-key-do-not-log";

const FAKE_LINES = [
  "ミナさん、ありがとう!助かったよ",
  "カイト: 雲がきれいだね",
  "レン、どうせまたケチるんだろ",
  "お腹すいたなあ、パン食べたい",
  "新しい家、すごく立派だね",
  "ゾンビが来る!扉を閉めて!",
  "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろ",
  "「今日もいい天気」",
];

function startMock() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      requests.push({ path: req.url, auth: req.headers.authorization, body: parsed });
      const text = FAKE_LINES[parsed.seed % FAKE_LINES.length];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100 + parsed.messages[0].content.length, completion_tokens: 10 },
      }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, requests, port: server.address().port })));
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "persona-chat-test-"));
}

function readJsonl(f) {
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const L = (speakerId, text) => ({ speakerId, text });

(async () => {
  await test("fixtures are reproducible from personas.js/social_dynamics.js", () => {
    const rebuilt = JSON.parse(JSON.stringify(X.buildFixtures()));
    assert.deepStrictEqual(rebuilt, X.loadFixtures());
  });

  await test("fixture cast: 8 valid personas, child has parents, scripted relations", () => {
    assert.strictEqual(fx.citizens.length, 8);
    for (const c of fx.citizens) assert.deepStrictEqual(Personas.validatePersona(c.persona), []);
    const sakura = fx.byId[7];
    assert.strictEqual(sakura.persona.generation, 1);
    assert.deepStrictEqual(sakura.persona.parents, [3, 4]);
    const kaitoToMina = X.relationView(fx, 8, 3);
    assert.ok(kaitoToMina.affect.gratitude >= 0.25 && kaitoToMina.trust >= 0.6);
    const yuiToHaruto = X.relationView(fx, 5, 2);
    assert.ok(yuiToHaruto.affect.gratitude >= 0.25 && yuiToHaruto.trust >= 0.6);
    const aoiToRen = X.relationView(fx, 1, 6);
    assert.ok(aoiToRen.affect.resentment >= 0.25 && aoiToRen.trust < 0.45);
    const neutral = X.relationView(fx, 2, 4);
    assert.strictEqual(neutral.affect.gratitude, 0);
    assert.strictEqual(neutral.affect.resentment, 0);
    assert.strictEqual(neutral.trust, 0.5);
  });

  await test("condition A is the thin bench prompt; B adds profile/concern/mood", () => {
    const run = X.newRunState(fx);
    const ctx = { lines: [L(3, "みんな食べてる?")], state: run.state, world: run.world, turn: 0 };
    const kaito = fx.byId[8];
    const a = X.buildSystemPrompt("A", fx, kaito, ctx);
    assert.strictEqual(a.dynamic, null);
    assert.ok(a.system.includes("「カイト」") && a.system.includes("のんびり屋"));
    assert.ok(!a.system.includes("【"));
    const b = X.buildSystemPrompt("B", fx, kaito, ctx);
    for (const s of ["【プロフィール】", "年齢: 22歳", "家族:", "生い立ち:", "性格:", "話し方:", "【いま気になっていること】", "【今の気分】", "【会話にいる人への気持ち】"]) {
      assert.ok(b.system.includes(s), `B missing ${s}`);
    }
    assert.ok(b.system.includes("気だるげで詩的"), "speechStyle.tone rendered");
    assert.ok(X.temperamentWords(fx.byId[1].persona).includes("話好き"), "high sociability -> 話好き");
    assert.ok(X.profileText(fx, fx.byId[7]).includes("母はミナ") && X.profileText(fx, fx.byId[7]).includes("父はソウタ"));
    assert.ok(X.profileText(fx, fx.byId[3]).includes("夫はソウタ") && X.profileText(fx, fx.byId[3]).includes("娘はサクラ"));
  });

  await test("relation text appears only when the partner is in the last 8 lines", () => {
    const run = X.newRunState(fx);
    const kaito = fx.byId[8];
    const old = [L(3, "ご飯できたよ"), ...Array.from({ length: 8 }, (_, i) => L(i % 2 ? 1 : 2, `話${i}`))];
    const without = X.buildMessages("B", fx, kaito, { lines: old, state: run.state, world: run.world, turn: 5 });
    assert.ok(!without.messages[0].content.includes("ミナ:"), "Mina is 9 lines back -> no relation text");
    assert.ok(without.messages[0].content.includes("アオイ: "));
    const withMina = X.buildMessages("B", fx, kaito, { lines: [...old, L(3, "おかわりある?")], state: run.state, world: run.world, turn: 5 });
    const sys = withMina.messages[0].content;
    assert.ok(sys.includes("ミナ: 前に食べ物を分けてもらった(2回)") && sys.includes("恩がある"), sys);
    assert.ok(X.relationText(fx, 1, 6).includes("根に持っている"));
    assert.ok(X.relationText(fx, 2, 4).includes("ふつうの顔見知り"));
    const noLines = X.buildMessages("B", fx, kaito, { lines: [], state: run.state, world: run.world, turn: 0 });
    assert.ok(!noLines.messages[0].content.includes("【会話にいる人への気持ち】"));
  });

  await test("mood/concern react to scripted state and events", () => {
    const run = X.newRunState(fx);
    const evs = X.eventTurns(90);
    const yui = fx.byId[5];
    const calm = X.computeMood(fx, yui, run.state, run.world, 0, []);
    assert.ok(X.concernList(fx, yui, run.state, run.world, 0).some((x) => x.key === "sick"));
    X.applyScriptedEvent(fx, run, evs[0]);
    assert.strictEqual(run.state.citizens["4"].nutritionBand, "starving");
    assert.strictEqual(X.concernList(fx, fx.byId[4], run.state, run.world, 1)[0].key, "starving");
    X.applyScriptedEvent(fx, run, evs[2]);
    const scared = X.computeMood(fx, yui, run.state, run.world, evs[2].turn, []);
    assert.ok(scared.fear > calm.fear + 0.3, "zombie raises fear for a timid scholar");
    assert.ok(X.moodText(scared).includes("怖い"));
    const aoi = fx.byId[1];
    const withRen = X.computeMood(fx, aoi, run.state, run.world, 10, [6]);
    const withoutRen = X.computeMood(fx, aoi, run.state, run.world, 10, []);
    assert.ok(withRen.anger > withoutRen.anger, "resented partner present -> anger");
  });

  await test("schedule: 45 each, never twice in a row, seed-deterministic", () => {
    const ids = fx.citizens.map((c) => c.id);
    const s1 = X.buildSchedule(ids, 360, "1");
    assert.deepStrictEqual(s1, X.buildSchedule(ids, 360, "1"));
    assert.notDeepStrictEqual(s1, X.buildSchedule(ids, 360, "2"));
    for (const id of ids) assert.strictEqual(s1.filter((x) => x === id).length, 45);
    for (let i = 1; i < s1.length; i++) assert.notStrictEqual(s1[i], s1[i - 1]);
    assert.deepStrictEqual(X.eventTurns(360).map((e) => e.turn), [0, 120, 240]);
  });

  await test("cleanReply strips name prefix/quotes and flags truncation", () => {
    const names = fx.citizens.map((c) => c.name);
    assert.strictEqual(X.cleanReply("カイト: 雲がきれい\n二行目", names).text, "雲がきれい");
    assert.strictEqual(X.cleanReply("ミナさん：はーい", names).text, "はーい");
    assert.strictEqual(X.cleanReply("「今日もいい天気」", names).text, "今日もいい天気");
    const long = X.cleanReply("あ".repeat(45), names);
    assert.strictEqual(long.text.length, 40);
    assert.ok(long.truncated);
    assert.strictEqual(X.cleanReply("ミナさん、ありがとう", names).text, "ミナさん、ありがとう");
    assert.strictEqual(X.cleanReply("(村の知らせ): 雨", names).text, "雨");
    assert.deepStrictEqual(X.mentionsIn("ミナさん、レンは?", fx, 8), [3, 6]);
  });

  const mock = await startMock();
  const outDir = tmpDir();
  const opts = X.buildOptions({
    conditions: "A,B", seeds: "7,8", turns: "24", "out-dir": outDir,
    "llm-hosts": `127.0.0.1:${mock.port}`, parallel: "2",
  }, { LLM_API_KEY: KEY });
  const logs = [];
  await X.runAll(opts, null, (m) => logs.push(m));

  await test("runAll writes transcripts/prompts/config; key sent but never written", () => {
    const files = fs.readdirSync(outDir).sort();
    for (const f of ["config.json", "runs.json", "transcript_A_seed7.jsonl", "transcript_B_seed8.jsonl",
      "system_prompts_A_seed7.json", "system_prompts_B_seed7.json"]) assert.ok(files.includes(f), f);
    assert.strictEqual(mock.requests.length, 4 * 24);
    assert.ok(mock.requests.every((r) => r.auth === `Bearer ${KEY}` && r.path === "/v1/chat/completions"));
    assert.ok(mock.requests.every((r) => r.body.temperature === 0.8 && r.body.max_tokens === 60));
    for (const f of files) assert.ok(!fs.readFileSync(path.join(outDir, f), "utf8").includes(KEY), `key leaked in ${f}`);
    assert.ok(!logs.join("\n").includes(KEY));
    const cfg = JSON.parse(fs.readFileSync(path.join(outDir, "config.json"), "utf8"));
    assert.strictEqual(cfg.apiKeySet, true);
    const sp = JSON.parse(fs.readFileSync(path.join(outDir, "system_prompts_B_seed7.json"), "utf8"));
    assert.ok(sp["8"].system.includes("【プロフィール】"));
    const spA = JSON.parse(fs.readFileSync(path.join(outDir, "system_prompts_A_seed7.json"), "utf8"));
    assert.ok(!spA["8"].system.includes("【プロフィール】"));
  });

  const tA = readJsonl(path.join(outDir, "transcript_A_seed7.jsonl"));
  const tB = readJsonl(path.join(outDir, "transcript_B_seed7.jsonl"));

  await test("A/B with the same seed are paired (speakers + llama.cpp seed)", () => {
    const uA = tA.filter((r) => r.type === "utterance");
    const uB = tB.filter((r) => r.type === "utterance");
    assert.deepStrictEqual(uA.map((r) => r.speakerId), uB.map((r) => r.speakerId));
    assert.deepStrictEqual(uA.map((r) => r.llmSeed), uB.map((r) => r.llmSeed));
    assert.deepStrictEqual(uA.map((r) => r.llmSeed), uA.map((r) => X.llmSeedFor("7", r.turn)));
    const sentSeeds = new Set(mock.requests.map((r) => r.body.seed));
    for (const r of uA) assert.ok(sentSeeds.has(r.llmSeed));
    const u8 = readJsonl(path.join(outDir, "transcript_A_seed8.jsonl")).filter((r) => r.type === "utterance");
    assert.notDeepStrictEqual(u8.map((r) => r.llmSeed), uA.map((r) => r.llmSeed));
  });

  await test("events injected at turns 0, N/3, 2N/3 before that turn's utterance", () => {
    const evs = tA.filter((r) => r.type === "event");
    assert.deepStrictEqual(evs.map((e) => [e.turn, e.eventId]), [[0, "food_shortage"], [8, "house_built"], [16, "zombie_night"]]);
    assert.strictEqual(evs[0].text, "食料が足りなくなってきた");
    for (const e of evs) {
      const idx = tA.indexOf(e);
      assert.strictEqual(tA[idx + 1].type, "utterance");
      assert.strictEqual(tA[idx + 1].turn, e.turn);
      assert.deepStrictEqual(tA[idx + 1].eventMarkers, [e.eventId]);
    }
    assert.strictEqual(tA.filter((r) => r.type === "seed_line").length, X.SEED_LINES.length);
    const u = tA.find((r) => r.type === "utterance" && r.turn === 17);
    assert.ok(u.contextSpeakers.includes(X.NARRATOR_ID), "narrator line is in the context");
  });

  await test("transcript schema", () => {
    const keys = ["type", "turn", "condition", "seed", "speakerId", "speakerName", "llmSeed", "ok", "latencyMs",
      "promptTokens", "promptChars", "rawText", "text", "truncated", "mentions", "mentionNames", "eventMarkers",
      "contextSpeakers", "systemPromptSha1", "persona"];
    const uB = tB.filter((r) => r.type === "utterance");
    for (const r of uB) for (const k of keys) assert.ok(Object.hasOwn(r, k), `missing ${k}`);
    assert.ok(uB.every((r) => r.ok && r.text.length <= 40 && !r.text.startsWith("カイト")));
    assert.ok(uB.some((r) => r.truncated));
    assert.ok(uB.every((r) => r.persona && r.persona.moodText && Array.isArray(r.persona.relationsShown)));
    assert.ok(tA.filter((r) => r.type === "utterance").every((r) => r.persona === null));
    assert.ok(uB.some((r) => r.mentions.length > 0 && r.mentionNames.length === r.mentions.length));
  });

  mock.server.close();

  await test("metrics math on a tiny synthetic transcript", () => {
    const u = (turn, speakerId, text, mentions, ctx, extra) => ({
      type: "utterance", ok: true, turn, speakerId, text, mentions: mentions || [], contextSpeakers: ctx || [],
      truncated: false, condition: "A", seed: "1", ...(extra || {}),
    });
    const recs = [
      { type: "event", turn: 0, eventId: "food_shortage", keywords: ["食"] },
      u(0, 8, "ミナさんありがとう", [3], [3]),
      u(1, 3, "カイトどういたしまして", [8], [8]),
      u(2, 1, "レンどうせケチ", [6], []),
      u(3, 6, "あああ", [], [], { truncated: true }),
      u(4, 1, "あああ", [], []),
      { type: "event", turn: 5, eventId: "house_built", keywords: ["家"] },
      u(5, 2, "家だ", [], []),
    ];
    const pairs = [{ from: 8, to: 3, kind: "gratitude" }, { from: 1, to: 6, kind: "resentment" }];
    const m = M.computeRunMetrics(recs, { castIds: [1, 2, 3, 6, 8], relationPairs: pairs });
    assert.strictEqual(m.utterances, 6);
    assert.strictEqual(m.truncationRate, 1 / 6);
    assert.strictEqual(m.duplicateRate, 1 / 6);
    assert.strictEqual(m.nameMentionRate, 3 / 6);
    assert.strictEqual(m.replyRate, 2 / 6);
    assert.strictEqual(m.exchangeChains, 1);
    assert.strictEqual(m.meanExchangeLength, 2);
    assert.strictEqual(m.eventReaction.food_shortage.rate, 0);
    assert.strictEqual(m.eventReaction.food_shortage.baseline, null);
    assert.strictEqual(m.eventReaction.house_built.rate, 1);
    assert.strictEqual(m.eventReaction.house_built.baseline, 0);
    assert.strictEqual(m.relationExpression.gratitude.addressed, 1);
    assert.strictEqual(m.relationExpression.gratitude.positiveRate, 1);
    assert.strictEqual(m.relationExpression.resentment.negativeRate, 1);
    assert.strictEqual(m.relationExpression.resentment.positiveRate, 0);
    // mean length: 9+11+7+3+3+2 = 35 / 6
    assert.ok(Math.abs(m.meanLength - 35 / 6) < 1e-9);
    assert.strictEqual(M.gini([1, 1, 1, 1]), 0);
    assert.ok(Math.abs(M.gini([0, 0, 0, 4]) - 0.75) < 1e-9);
    assert.strictEqual(M.jaccard(new Set(["a", "b"]), new Set(["b", "c"])), 1 / 3);
    const d = M.computeRunMetrics([u(0, 1, "abab"), u(1, 2, "abab")], {});
    assert.strictEqual(d.distinct1, 2 / 8);
    assert.strictEqual(d.distinct2, 2 / 6); // {ab, ba} unique among ab,ba,ab ×2
    assert.strictEqual(d.selfSimilarity, 1);
    const agg = M.aggregate([
      { condition: "A", seed: 1, metrics: { x: 1 } }, { condition: "A", seed: 2, metrics: { x: 3 } },
    ]);
    assert.strictEqual(agg.A.metrics.x.mean, 2);
    assert.ok(Math.abs(agg.A.metrics.x.sd - Math.SQRT2) < 1e-3);
  });

  await test("metrics over the mock run directory", () => {
    const res = M.analyzeDir(outDir);
    assert.strictEqual(res.runs.length, 4);
    assert.deepStrictEqual(Object.keys(res.byCondition).sort(), ["A", "B"]);
    assert.strictEqual(res.byCondition.A.metrics.utterances.mean, 24);
    assert.ok(res.markdown.includes("| distinct2 |"));
    assert.strictEqual(res.relationPairs.length, 3);
  });

  await test("judge: request building, parsing and mock run", async () => {
    const recs = tB;
    const i = recs.findIndex((r) => r.type === "utterance" && r.turn === 3);
    const msgs = J.buildWhoSaidItMessages(fx, recs, i);
    assert.ok(msgs[1].content.includes(`???: ${recs[i].text}`));
    assert.ok(!msgs[1].content.includes(`${recs[i].speakerName}: ${recs[i].text}`));
    assert.strictEqual(J.parseWhoSaidIt('{"speaker":"ミナ"}', fx), 3);
    assert.strictEqual(J.parseWhoSaidIt("たぶんレンだと思う", fx), 6);
    assert.strictEqual(J.parseWhoSaidIt("わからない", fx), null);
    assert.deepStrictEqual(J.parseRating('```json\n{"naturalness": 4, "humanlike": 9}\n```'), { naturalness: 4, humanlike: null });
    assert.deepStrictEqual(J.parseRating("naturalness: 3, humanlike: 2"), { naturalness: 3, humanlike: 2 });
    // fake judge always answers the true speaker for who-said-it, 4/3 for ratings
    const ask = async (m) => {
      const c = m[1].content;
      if (c.includes("???")) {
        const line = c.split("\n").find((l) => l.startsWith("???: "));
        const target = recs.find((r) => r.type === "utterance" && `???: ${r.text}` === line);
        return { ok: true, text: `{"speaker":"${target.speakerName}"}` };
      }
      return { ok: true, text: '{"naturalness":4,"humanlike":3}' };
    };
    const r = await J.judgeRun(fx, recs, ask, { seed: "t", samples: 5, windows: 2, windowSize: 10 });
    assert.strictEqual(r.who.length, 5);
    assert.strictEqual(r.meanNaturalness, 4);
    assert.strictEqual(r.meanHumanlike, 3);
    assert.ok(r.whoSaidItAccuracy > 0);
  });

  await test("dry prompts show A and B for two citizens without an LLM", () => {
    const out = X.dryPrompts(fx, [8, 1]);
    assert.strictEqual(out.length, 4);
    assert.ok(out.find((p) => p.id === 1 && p.condition === "B").system.includes("レン: 前に頼みを断られた"));
  });

  fs.rmSync(outDir, { recursive: true, force: true });
  console.log(`\n${passed} tests passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
