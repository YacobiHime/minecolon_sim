const assert = require("assert");
const X = require("./social_cognition_experiment.js");

function persona(citizenId, name, templateId, traits) {
  return {
    citizenId, name, templateId, generation: 0,
    segments: {
      temperament: {
        bravery: traits.bravery, empathy: traits.empathy,
        obedience: traits.obedience, greed: traits.greed,
        sociability: traits.sociability,
      },
      politics: { loyalty: traits.loyalty, ambition: traits.ambition },
    },
  };
}

const caring = persona(1, "Care", "communal", {
  bravery: 0.5, empathy: 0.9, obedience: 0.8, greed: 0.1,
  sociability: 0.9, loyalty: 0.9, ambition: 0.2,
});
const guarded = persona(2, "Guard", "self_protective", {
  bravery: 0.7, empathy: 0.2, obedience: 0.2, greed: 0.8,
  sociability: 0.3, loyalty: 0.3, ambition: 0.8,
});
const base = {
  helperState: { nutritionBand: "fed", sick: false, stress: 0.2 },
  recipientState: { nutritionBand: "starving", sick: false },
  helperPerspective: {
    trust: 0.7, affinity: 0.6, obligation: 0.2,
    affect: { gratitude: 0.2, resentment: 0.1 },
  },
  sources: ["neighbor"], familiarity: 0.6, distance: 12,
  resourceAvailable: true,
};
const scenarios = [
  { ...base, scenarioId: "care", helperPersona: caring, helperTemplate: "communal" },
  { ...base, scenarioId: "guard", helperPersona: guarded, helperTemplate: "self_protective" },
];
const population = {
  personas: { personas: { "1": caring, "2": guarded } },
  graph: {
    nodes: { "1": { job: "farmer" }, "2": { job: "builder" } },
    edges: { "1:2": { a: 1, b: 2, sources: ["neighbor"] } },
  },
  dynamics: { citizens: { "1": {}, "2": {} } },
};
const opts = { scenarios, repeats: 5, seed: "fixture", temperature: 0.35 };
const a = X.runComparison({ ...population, scenarios }, opts);
const b = X.runComparison({ ...population, scenarios }, opts);
assert.deepStrictEqual(a, b, "comparison must be reproducible for a fixed seed");
assert.strictEqual(a.schema, "voyager-cognition-comparison-v1");
assert.strictEqual(a.models.v1.trials, 10);
assert.strictEqual(a.models.v2.trials, 10);
assert.strictEqual(a.comparison.disagreements,
  a.comparison.v2HelpV1Refuse + a.comparison.v1HelpV2Refuse);
assert.strictEqual(a.comparison.deterministic.scenarios, 2);
assert.strictEqual(a.comparison.deterministic.disagreements,
  a.comparison.deterministic.v2HelpV1Refuse +
  a.comparison.deterministic.v1HelpV2Refuse);
assert.strictEqual(a.config.status, "experimental-unvalidated");
assert.match(a.config.sha256, /^[0-9a-f]{64}$/);
assert.ok(a.profileDiversity.care.sd > 0);
console.log("ALL PASS (cognition comparison experiment)");
