const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const A1 = require("./social_appraisal.js");
const C = require("./social_cognition.js");
const R = require("./experiment_runner.js");

function persona(id, templateId) {
  return {
    citizenId: id,
    name: `Citizen ${id}`,
    generation: 0,
    parents: [],
    templateId,
    deceased: false,
    segments: {
      jobPreference: { liked: [], disliked: [] },
      temperament: { bravery: 0.5, empathy: 0.7, obedience: 0.6, greed: 0.3, sociability: 0.6 },
      politics: { loyalty: 0.7, ambition: 0.3 },
      combatResponse: { evacuateCivilians: 0.5, engage: 0.5, callReinforcements: 0.5, betray: 0 },
      speechStyle: { tone: "neutral", verbosity: 0.5 },
    },
  };
}

function fixture() {
  const perspective = (toward, trust, affinity) => ({
    toward, trust, affinity, obligation: 0,
    affect: { gratitude: 0, resentment: 0 }, memory: {},
  });
  return {
    personas: { personas: {
      "1": persona(1, "helper"), "2": persona(2, "family"), "3": persona(3, "neighbor"),
    } },
    graph: {
      _meta: { colonyId: 1, gameTime: 2400 },
      nodes: {
        "1": { citizenId: 1, name: "Helper" },
        "2": { citizenId: 2, name: "Family" },
        "3": { citizenId: 3, name: "Neighbor" },
      },
      edges: {
        "1:2": { a: 1, b: 2, sources: ["parent_child"], familiarity: 0.9 },
        "1:3": { a: 1, b: 3, sources: ["neighbor"], familiarity: 0.2 },
      },
    },
    dynamics: {
      _meta: { gameTime: 2400 }, citizens: {},
      relations: {
        "1:2": { a: 1, b: 2, perspectives: {
          "1": perspective(2, 0.9, 0.9), "2": perspective(1, 0.9, 0.9),
        } },
        "1:3": { a: 1, b: 3, perspectives: {
          "1": perspective(3, 0.3, 0.3), "3": perspective(1, 0.3, 0.3),
        } },
      },
    },
  };
}

async function main() {
  assert.deepStrictEqual(R.parseConditions("uniform,temporal,llm"), ["uniform", "temporal", "llm"]);
  assert.throws(() => R.parseConditions("unknown"), /unknown condition/);
  assert.deepStrictEqual(R.parseGradient("0.25:0.5,0.5:1"), [[0.25, 0.5], [0.5, 1]]);
  assert.throws(() => R.parseGradient("0.8:0.2"), /close need must be/);

  const sparse = {
    _meta: {},
    nodes: Object.fromEntries([1, 2, 3, 4].map((id) => [String(id), { citizenId: id }])),
    edges: {}, metrics: {},
  };
  R.ensureExperimentalTopology(sparse);
  assert.strictEqual(sparse._meta.topologyFallback.type, "deterministic-synthetic-ring-v1");
  assert.ok(Object.keys(sparse.edges).length >= 4);
  assert.ok(Object.values(sparse.edges).some((edge) => edge.sources.includes("experimental_close")));
  assert.ok(Object.values(sparse.edges).some((edge) => edge.sources.includes("experimental_weak")));
  const sparseDynamics = { _meta: {}, relations: Object.fromEntries(
    Object.entries(sparse.edges).map(([key, edge]) => [key, {
      perspectives: {
        [String(edge.a)]: { trust: 0.5, affinity: 0.5, obligation: 0 },
        [String(edge.b)]: { trust: 0.5, affinity: 0.5, obligation: 0 },
      },
    }])
  ) };
  R.seedExperimentalRelations(sparseDynamics, sparse);
  assert.ok(Object.values(sparseDynamics.relations).some((relation) =>
    Object.values(relation.perspectives).some((view) => view.trust === 0.8)
  ));

  assert.strictEqual(A1.stateNeedSeverity({ nutritionBand: "hungry", needSeverity: 0.73 }), 0.73);
  assert.strictEqual(C.stateNeedSeverity({ nutritionBand: "fed", needSeverity: 2 }), 1);
  assert.deepStrictEqual(R.parseLLMReply('{"say":"家族を助ける","choice":"close_mild"}'), {
    say: "家族を助ける", selected: "close_mild",
  });
  assert.throws(() => R.parseLLMReply('{"say":"x","choice":"invalid"}'), /invalid choice/);

  const options = {
    conditions: ["uniform", "persona", "persona_relation", "temporal", "llm"],
    gradient: [[0.5, 0.5], [0.5, 1]],
    repeats: 3,
    mode: "sample",
    seed: "repeatable-v1",
  };
  const deps = { llmDecide: async () => ({ selected: "weak_severe", say: "必要性を優先する" }) };
  const first = await R.runExperiment(fixture(), options, deps);
  const second = await R.runExperiment(fixture(), options, deps);
  assert.strictEqual(first.records.length, 2 * 1 * 3 * 5);
  assert.strictEqual(first.recordsSha256, second.recordsSha256);
  assert.deepStrictEqual(
    first.records.map(R.canonicalRecord),
    second.records.map(R.canonicalRecord)
  );
  assert.strictEqual(first.summary.overall.llm.choices.weak_severe, 6);
  assert.ok(first.summary.bySeverity["0.500:1.000"]);

  const csv = R.summaryCsv(first.summary);
  assert.ok(csv.startsWith("severity,condition,trials,failures"));
  assert.ok(csv.includes("0.500:1.000,llm,3,0"));

  const target = fs.mkdtempSync(path.join(os.tmpdir(), "voyager-experiment-test-"));
  try {
    R.writeOutputs(first, { source: "fixture", input: fixture() }, target, new Date("2026-08-30T00:00:00Z"));
    for (const name of ["input_snapshot.json", "trials.jsonl", "summary.json", "summary.csv"]) {
      assert.ok(fs.existsSync(path.join(target, name)), name);
    }
    const saved = JSON.parse(fs.readFileSync(path.join(target, "summary.json"), "utf8"));
    assert.strictEqual(saved.recordsSha256, first.recordsSha256);
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }

  console.log("ALL PASS (experiment runner)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
