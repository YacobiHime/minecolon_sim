// Reproducible MVP runner for the social food-allocation experiment.
//
// This runner is deliberately offline with respect to Minecraft mutation: it
// can read a live /status snapshot, but never changes the world. It expands
// one grounded social graph into controlled severity conditions, runs the
// same seeds through every counterfactual condition, and emits machine-readable
// trial logs plus JSON/CSV summaries. The optional `llm` condition calls the
// same local Ollama backend used by council.js.
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const P = require("./personas.js");
const S = require("./social_graph.js");
const D = require("./social_dynamics.js");
const A1 = require("./social_appraisal.js");
const F = require("./food_allocation_scenario.js");

const MODEL_CONDITIONS = F.CONDITIONS;
const ALL_CONDITIONS = [...MODEL_CONDITIONS, "llm"];
const DEFAULT_GRADIENT = [
  [0.5, 0.5],
  [0.5, 0.625],
  [0.5, 0.75],
  [0.5, 0.875],
  [0.5, 1],
];

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") out.help = true;
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

function parseConditions(value) {
  const conditions = value ? value.split(",").map((x) => x.trim()).filter(Boolean) : MODEL_CONDITIONS;
  if (conditions.length === 0) throw new Error("at least one condition is required");
  for (const condition of conditions) {
    if (!ALL_CONDITIONS.includes(condition)) throw new Error(`unknown condition: ${condition}`);
  }
  return [...new Set(conditions)];
}

function parseGradient(value) {
  if (!value) return DEFAULT_GRADIENT.map((pair) => pair.slice());
  const pairs = value.split(",").map((entry) => {
    const parts = entry.split(":").map(Number);
    if (parts.length !== 2 || parts.some((x) => !Number.isFinite(x) || x < 0 || x > 1)) {
      throw new Error(`invalid severity pair "${entry}"; expected close:weak values in [0,1]`);
    }
    if (parts[0] > parts[1]) {
      throw new Error(`invalid severity pair "${entry}"; close need must be <= weak need`);
    }
    return parts;
  });
  if (pairs.length === 0) throw new Error("at least one severity pair is required");
  return pairs;
}

function seededPersonaStore(colony, seed) {
  const store = P.emptyStore();
  const templates = P.loadTemplates();
  for (const citizen of (colony.citizens || []).slice().sort((a, b) => a.id - b.id)) {
    const draw = A1.seededUnit(`${seed}:persona:${citizen.id}`);
    const persona = P.assignFromTemplate(citizen, "random", {
      templates,
      rng: () => draw,
    });
    // Snapshot generation must not gain a wall-clock difference across runs.
    persona.createdAt = null;
    P.put(store, persona);
  }
  store._meta.updatedAt = null;
  store._meta.source = "deterministic-live-baseline";
  store._meta.seed = seed;
  return store;
}

function validateInput(input) {
  if (!input || !input.personas || !input.graph || !input.dynamics) {
    throw new Error("input must contain personas, graph, and dynamics");
  }
  const personaCount = Object.keys(input.personas.personas || {}).length;
  const nodeCount = Object.keys(input.graph.nodes || {}).length;
  if (personaCount === 0 || nodeCount === 0) {
    throw new Error("input snapshot has no personas or social graph nodes");
  }
  return input;
}

function ensureExperimentalTopology(graph) {
  const ids = Object.keys(graph.nodes || {}).map(Number).sort((a, b) => a - b);
  if (ids.length < 3) return graph;
  const degrees = Object.fromEntries(ids.map((id) => [id, 0]));
  for (const edge of Object.values(graph.edges || {})) {
    degrees[edge.a] = (degrees[edge.a] || 0) + 1;
    degrees[edge.b] = (degrees[edge.b] || 0) + 1;
  }
  if (Math.max(0, ...Object.values(degrees)) >= 2) return graph;
  graph.edges = graph.edges || {};
  function add(a, b, source, familiarity) {
    if (a === b) return;
    const key = S.edgeKey(a, b);
    const edge = graph.edges[key] || {
      a: Math.min(a, b), b: Math.max(a, b), sources: [],
      trust: 0.5, affinity: 0.5, debt: 0, familiarity: 0,
    };
    if (!edge.sources.includes(source)) edge.sources.push(source);
    edge.sources.sort();
    edge.familiarity = Math.max(edge.familiarity || 0, familiarity);
    graph.edges[key] = edge;
  }
  const oppositeOffset = Math.max(2, Math.floor(ids.length / 2));
  for (let i = 0; i < ids.length; i++) {
    add(ids[i], ids[(i + 1) % ids.length], "experimental_close", 0.8);
    add(ids[i], ids[(i + oppositeOffset) % ids.length], "experimental_weak", 0.2);
  }
  graph._meta = graph._meta || {};
  graph._meta.topologyFallback = {
    type: "deterministic-synthetic-ring-v1",
    reason: "live status lacked enough family/home/work relationships",
  };
  const edges = Object.values(graph.edges);
  graph.metrics = graph.metrics || {};
  graph.metrics.edges = edges.length;
  graph.metrics.averageDegree = round4(2 * edges.length / ids.length);
  graph.metrics.sourceCounts = {};
  for (const edge of edges) {
    for (const source of edge.sources) {
      graph.metrics.sourceCounts[source] = (graph.metrics.sourceCounts[source] || 0) + 1;
    }
  }
  return graph;
}

function seedExperimentalRelations(dynamics, graph) {
  if (!graph._meta || !graph._meta.topologyFallback) return dynamics;
  for (const [key, edge] of Object.entries(graph.edges || {})) {
    const relation = dynamics.relations && dynamics.relations[key];
    if (!relation || !relation.perspectives) continue;
    const close = (edge.sources || []).includes("experimental_close");
    const weak = (edge.sources || []).includes("experimental_weak");
    if (!close && !weak) continue;
    const trust = close ? 0.8 : 0.3;
    const affinity = close ? 0.8 : 0.3;
    for (const perspective of Object.values(relation.perspectives)) {
      perspective.trust = trust;
      perspective.affinity = affinity;
    }
    D.updateRelationAggregates(relation);
  }
  dynamics._meta.syntheticRelationBaseline = {
    close: { trust: 0.8, affinity: 0.8 },
    weak: { trust: 0.3, affinity: 0.3 },
  };
  return dynamics;
}

async function loadInput(opts, deps) {
  const o = opts || {};
  const d = deps || {};
  if (o.input) {
    return {
      source: "snapshot",
      input: validateInput(JSON.parse(fs.readFileSync(path.resolve(o.input), "utf8"))),
    };
  }
  const source = o.source || "auto";
  if (source === "files" || source === "auto") {
    const persisted = {
      personas: P.loadAll(o.personasFile),
      graph: S.loadGraph(o.graphFile),
      dynamics: D.loadState(o.dynamicsFile),
    };
    if (persisted.graph && persisted.dynamics && Object.keys(persisted.personas.personas || {}).length > 0) {
      return { source: "files", input: validateInput(persisted) };
    }
    if (source === "files") {
      throw new Error("persisted persona/social files are missing; use --source=live or --input=<snapshot.json>");
    }
  }
  if (source !== "auto" && source !== "live") throw new Error(`unknown source: ${source}`);
  const fetchColony = d.fetchColony || S.fetchColony;
  const colony = await fetchColony();
  const personas = seededPersonaStore(colony, o.seed || "food-allocation-v1");
  let graph = S.buildSocialGraph(colony, {
    neighborDistance: Number.isFinite(o.neighborDistance) ? o.neighborDistance : undefined,
  });
  if (o.syntheticTopology !== "never") graph = ensureExperimentalTopology(graph);
  const dynamics = seedExperimentalRelations(D.reconcileState(null, graph, personas), graph);
  dynamics._meta.gameTime = colony.gameTime;
  return { source: "live", input: validateInput({ personas, graph, dynamics }) };
}

function parseLLMReply(text) {
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`LLM reply has no JSON: ${String(text).slice(0, 160)}`);
  const parsed = JSON.parse(match[0]);
  if (!F.CHOICES.includes(parsed.choice)) throw new Error(`LLM returned invalid choice: ${parsed.choice}`);
  return { selected: parsed.choice, say: String(parsed.say || "").slice(0, 80) };
}

function askLocalLLM(scenario, opts) {
  const o = opts || {};
  const host = o.llmHost || process.env.LLM_HOST || "192.168.15.150";
  const port = Number(o.llmPort || process.env.LLM_PORT || 11434);
  const model = o.llmModel || process.env.LLM_MODEL || "gemma4:e4b";
  const payload = JSON.stringify({
    model,
    stream: false,
    think: false,
    format: {
      type: "object",
      properties: {
        say: { type: "string", maxLength: 80 },
        choice: { type: "string", enum: F.CHOICES },
      },
      required: ["say", "choice"],
    },
    messages: [
      {
        role: "system",
        content: "あなたは社会シミュレーション内の市民です。状況を読み、選択肢を一つ選んでJSONだけを返してください。",
      },
      {
        role: "user",
        content: `${F.renderScenarioCard(scenario)}\nJSON形式: {"say":"80文字以内の理由","choice":"close_mild|weak_severe|keep"}`,
      },
    ],
    options: {
      temperature: Number.isFinite(o.temperature) ? o.temperature : 0.35,
      seed: Math.floor(A1.seededUnit(o.seed == null ? "0" : o.seed) * 2147483647),
      num_predict: 160,
    },
  });
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, path: "/api/chat", method: "POST", headers: {
      "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload),
    } }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`LLM HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        try {
          const body = JSON.parse(data);
          resolve(parseLLMReply(body.message && body.message.content));
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(Number(o.llmTimeoutMs) || 120000, () => req.destroy(new Error("LLM request timed out")));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function canonicalRecord(record) {
  const { decisionMs, llmRaw, ...stable } = record;
  return stable;
}

function summarize(records) {
  const overall = {};
  const bySeverity = {};
  function add(target, record) {
    const key = record.condition;
    target[key] = target[key] || {
      trials: 0,
      choices: { close_mild: 0, weak_severe: 0, keep: 0 },
      failures: 0,
      totalDecisionMs: 0,
    };
    const metric = target[key];
    metric.trials++;
    if (record.error) metric.failures++;
    else metric.choices[record.selected]++;
    metric.totalDecisionMs += record.decisionMs || 0;
  }
  for (const record of records) {
    add(overall, record);
    bySeverity[record.severityId] = bySeverity[record.severityId] || {};
    add(bySeverity[record.severityId], record);
  }
  for (const groups of [overall, ...Object.values(bySeverity)]) {
    for (const metric of Object.values(groups)) {
      const completed = Math.max(1, metric.trials - metric.failures);
      metric.rates = Object.fromEntries(F.CHOICES.map((choice) => [
        choice, round4(metric.choices[choice] / completed),
      ]));
      metric.meanDecisionMs = round4(metric.totalDecisionMs / Math.max(1, metric.trials));
      delete metric.totalDecisionMs;
    }
  }
  return { overall, bySeverity };
}

async function runExperiment(input, opts, deps) {
  const o = opts || {};
  const conditions = o.conditions || MODEL_CONDITIONS;
  const gradient = o.gradient || DEFAULT_GRADIENT;
  const repeats = Number.isInteger(o.repeats) && o.repeats > 0 ? o.repeats : 1;
  const seed = o.seed || "food-allocation-v1";
  const mode = o.mode === "sample" ? "sample" : "max";
  const llmDecide = (deps && deps.llmDecide) || askLocalLLM;
  const allScenarios = F.buildScenarios(input.personas, input.graph, input.dynamics, o);
  const baseScenarios = Number.isInteger(o.scenarioLimit) && o.scenarioLimit > 0
    ? allScenarios.slice(0, o.scenarioLimit)
    : allScenarios;
  if (baseScenarios.length === 0) {
    throw new Error("no eligible helper has both a family relation and a non-family relation");
  }
  const records = [];
  for (const [closeNeed, weakNeed] of gradient) {
    for (const base of baseScenarios) {
      const scenario = F.withSeverities(base, closeNeed, weakNeed);
      for (let repeat = 0; repeat < repeats; repeat++) {
        const commonSeed = `${seed}:${scenario.scenarioId}:${scenario.severityId}:${repeat}`;
        for (const condition of conditions) {
          const started = Date.now();
          const record = {
            trialId: `${scenario.scenarioId}:${scenario.severityId}:${repeat}:${condition}`,
            seed: commonSeed,
            repeat,
            scenarioId: scenario.scenarioId,
            severityId: scenario.severityId,
            closeNeed,
            weakNeed,
            helperId: scenario.helperId,
            helperTemplate: scenario.helperTemplate,
            closeRelationType: scenario.closeRelationType,
            closeRecipientId: scenario.candidates.close_mild.recipientId,
            weakRecipientId: scenario.candidates.weak_severe.recipientId,
            condition,
            mode: condition === "llm" ? "llm" : mode,
          };
          try {
            if (condition === "llm") {
              const result = await llmDecide(scenario, { ...o, seed: commonSeed });
              record.selected = result.selected;
              record.say = result.say || "";
            } else {
              const result = F.chooseAllocation(scenario, condition, {
                seed: commonSeed,
                mode,
                temperature: o.temperature,
                includeTrace: !!o.includeTrace,
              });
              record.selected = result.selected;
              record.scores = result.scores;
            }
          } catch (error) {
            record.error = String(error.message || error);
          }
          record.decisionMs = Date.now() - started;
          records.push(record);
        }
      }
    }
  }
  const stableJsonl = records.map((record) => JSON.stringify(canonicalRecord(record))).join("\n") + "\n";
  return {
    schema: "voyager-social-experiment-run-v1",
    config: {
      seed, repeats, mode, conditions, gradient, scenarios: baseScenarios.length,
      topologyFallback: input.graph._meta && input.graph._meta.topologyFallback || null,
    },
    records,
    summary: summarize(records),
    recordsSha256: crypto.createHash("sha256").update(stableJsonl).digest("hex"),
  };
}

function csvEscape(value) {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function summaryCsv(summary) {
  const rows = [["severity", "condition", "trials", "failures", ...F.CHOICES, ...F.CHOICES.map((x) => `${x}_rate`), "mean_decision_ms"]];
  for (const severity of Object.keys(summary.bySeverity).sort()) {
    for (const condition of Object.keys(summary.bySeverity[severity]).sort()) {
      const m = summary.bySeverity[severity][condition];
      rows.push([
        severity, condition, m.trials, m.failures,
        ...F.CHOICES.map((x) => m.choices[x]),
        ...F.CHOICES.map((x) => m.rates[x]),
        m.meanDecisionMs,
      ]);
    }
  }
  return rows.map((row) => row.map(csvEscape).join(",")).join("\n") + "\n";
}

function writeOutputs(result, inputInfo, outputDir, now) {
  const target = path.resolve(outputDir);
  fs.mkdirSync(target, { recursive: true });
  const generatedAt = (now || new Date()).toISOString();
  fs.writeFileSync(path.join(target, "input_snapshot.json"), JSON.stringify(inputInfo.input, null, 2));
  fs.writeFileSync(path.join(target, "trials.jsonl"), result.records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  fs.writeFileSync(path.join(target, "summary.json"), JSON.stringify({
    generatedAt,
    inputSource: inputInfo.source,
    schema: result.schema,
    config: result.config,
    recordsSha256: result.recordsSha256,
    summary: result.summary,
  }, null, 2));
  fs.writeFileSync(path.join(target, "summary.csv"), summaryCsv(result.summary));
  return target;
}

function usage() {
  return `Usage: node experiment_runner.js [options]\n\n` +
    `  --source=auto|live|files       Input source (default: auto)\n` +
    `  --input=snapshot.json         Replay an exact saved input snapshot\n` +
    `  --conditions=a,b,c            uniform,persona,persona_relation,temporal,llm\n` +
    `  --severity=.5:.5,.5:.75,.5:1 Controlled close:weak need gradient\n` +
    `  --repeats=30                  Repetitions per scenario and severity\n` +
    `  --scenario-limit=1            Limit helpers (useful for LLM smoke tests)\n` +
    `  --mode=max|sample             Deterministic or seeded stochastic choice\n` +
    `  --seed=experiment-v1          Shared seed across conditions\n` +
    `  --output-dir=path             Result directory\n` +
    `  --trace=true                  Include full appraisal traces\n` +
    `  --require-family=true         Fail instead of using the strongest relation fallback\n` +
    `  --synthetic-topology=never    Fail when live relationship data is insufficient\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(usage()); return; }
  const seed = args.seed || "food-allocation-v1";
  const options = {
    source: args.source,
    input: args.input,
    seed,
    repeats: args.repeats ? parseInt(args.repeats, 10) : 1,
    scenarioLimit: args["scenario-limit"] ? parseInt(args["scenario-limit"], 10) : undefined,
    mode: args.mode,
    conditions: parseConditions(args.conditions),
    gradient: parseGradient(args.severity),
    temperature: args.temperature ? parseFloat(args.temperature) : undefined,
    includeTrace: args.trace === "true",
    allowNonFamilyClose: args["require-family"] !== "true",
    syntheticTopology: args["synthetic-topology"] || "auto",
    llmHost: args["llm-host"],
    llmPort: args["llm-port"],
    llmModel: args["llm-model"],
  };
  const inputInfo = await loadInput(options);
  const result = await runExperiment(inputInfo.input, options);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDir = args["output-dir"] || path.join(__dirname, "experiment_results", stamp);
  const target = writeOutputs(result, inputInfo, outputDir);
  console.log(JSON.stringify({
    outputDir: target,
    inputSource: inputInfo.source,
    records: result.records.length,
    recordsSha256: result.recordsSha256,
    overall: result.summary.overall,
  }, null, 2));
  if (result.records.some((record) => record.error)) process.exitCode = 2;
}

module.exports = {
  MODEL_CONDITIONS, ALL_CONDITIONS, DEFAULT_GRADIENT,
  parseArgs, parseConditions, parseGradient, seededPersonaStore, validateInput,
  ensureExperimentalTopology, seedExperimentalRelations,
  loadInput, parseLLMReply, askLocalLLM, canonicalRecord, summarize,
  runExperiment, summaryCsv, writeOutputs, usage,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack || error);
    process.exit(1);
  });
}
