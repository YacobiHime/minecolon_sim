const assert = require("assert");
const E = require("./social_experiment.js");

const personas = { personas: {
  "1": { citizenId: 1, templateId: "helper", deceased: false, segments: {
    temperament: { empathy: 0.95, greed: 0.05, sociability: 0.9, obedience: 0.7 },
    politics: { loyalty: 0.9, ambition: 0.1 },
  } },
  "2": { citizenId: 2, templateId: "other", deceased: false, segments: {
    temperament: { empathy: 0.2, greed: 0.8, sociability: 0.2, obedience: 0.2 },
    politics: { loyalty: 0.2, ambition: 0.8 },
  } },
} };
const graph = {
  _meta: { colonyId: 1, gameTime: 200 },
  nodes: {
    "1": { citizenId: 1, homeBuilding: { x: 0, z: 0 } },
    "2": { citizenId: 2, homeBuilding: { x: 10, z: 0 } },
  },
  edges: { "1:2": {
    a: 1, b: 2, sources: ["parent_child"], familiarity: 0.9,
  } },
};
const dynamics = {
  _meta: {}, citizens: {
    "1": { citizenId: 1, active: true }, "2": { citizenId: 2, active: true },
  }, relations: { "1:2": {
    a: 1, b: 2, trust: 0.7, affinity: 0.7, debt: 0.4,
    perspectives: {
      "1": {
        toward: 2, trust: 0.8, affinity: 0.8, obligation: 0.4,
        affect: { gratitude: 0.7, resentment: 0, lastGameTime: 200 },
      },
      "2": {
        toward: 1, trust: 0.4, affinity: 0.4, obligation: 0,
        affect: { gratitude: 0, resentment: 0.6, lastGameTime: 200 },
      },
    },
  } },
};

const scenarios = E.buildScenarios(personas, graph, dynamics);
assert.strictEqual(scenarios.length, 2);
const first = E.runExperiment({ scenarios }, { repeats: 12, seed: "fixed" });
const again = E.runExperiment({ scenarios }, { repeats: 12, seed: "fixed" });
assert.deepStrictEqual(first, again, "same input and seed must reproduce exactly");
assert.deepStrictEqual(Object.keys(first.conditions), E.CONDITIONS);
for (const result of Object.values(first.conditions)) {
  assert.strictEqual(result.trials, 24);
  assert.strictEqual(result.help + result.refuse, result.trials);
}
const oneWay = scenarios.find((x) => x.helperId === 1);
const staticInput = E.intervention(oneWay, "persona_relation");
const temporalInput = E.intervention(oneWay, "temporal");
const A = require("./social_appraisal.js");
const staticDecision = A.decideHelp(staticInput, { mode: "max" });
const temporalDecision = A.decideHelp(temporalInput, { mode: "max" });
assert.ok(temporalDecision.actions.help.score > staticDecision.actions.help.score,
  "gratitude and obligation must raise the temporal help score");
const history = E.runHistoryManipulation(scenarios, { repeats: 20, seed: "history", mode: "max" });
assert.ok(history.variants.helped_before.meanMargin > history.variants.no_history.meanMargin);
assert.ok(history.variants.refused_before.meanMargin < history.variants.no_history.meanMargin);
console.log("ALL PASS (social experiment ablations)");
