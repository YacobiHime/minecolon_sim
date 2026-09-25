const assert = require("assert");
const F = require("./food_allocation_scenario.js");

function fixture() {
  const personas = { personas: {
    "1": { citizenId: 1, templateId: "test-helper", segments: {
      temperament: { bravery: 0.5, empathy: 0.7, obedience: 0.6, greed: 0.3, sociability: 0.6 },
      politics: { loyalty: 0.7, ambition: 0.3 },
    } },
    "2": { citizenId: 2, segments: {} },
    "3": { citizenId: 3, segments: {} },
  } };
  const graph = {
    _meta: { gameTime: 2400 },
    nodes: {
      "1": { citizenId: 1, name: "Helper" },
      "2": { citizenId: 2, name: "Family" },
      "3": { citizenId: 3, name: "Neighbor" },
    },
    edges: {
      "1:2": { a: 1, b: 2, sources: ["parent_child"], familiarity: 0.9 },
      "1:3": { a: 1, b: 3, sources: ["neighbor"], familiarity: 0.2 },
    },
  };
  const perspective = (toward, trust, affinity) => ({
    toward, trust, affinity, obligation: 0,
    affect: { gratitude: 0, resentment: 0 }, memory: {},
  });
  const dynamics = {
    _meta: { gameTime: 2400 }, citizens: {},
    relations: {
      "1:2": { a: 1, b: 2, perspectives: {
        "1": perspective(2, 0.9, 0.9), "2": perspective(1, 0.9, 0.9),
      } },
      "1:3": { a: 1, b: 3, perspectives: {
        "1": perspective(3, 0.3, 0.3), "3": perspective(1, 0.3, 0.3),
      } },
    },
  };
  return { personas, graph, dynamics };
}

const input = fixture();
const scenarios = F.buildScenarios(input.personas, input.graph, input.dynamics);
assert.strictEqual(scenarios.length, 1);
assert.strictEqual(scenarios[0].candidates.close_mild.recipientId, 2);
assert.strictEqual(scenarios[0].candidates.weak_severe.recipientId, 3);
assert.strictEqual(scenarios[0].transferableMeals, 1);
assert.strictEqual(scenarios[0].closeRelationType, "family");
assert.strictEqual(scenarios[0].candidates.close_mild.recipientState.nutritionBand, "hungry");
assert.strictEqual(scenarios[0].candidates.weak_severe.recipientState.nutritionBand, "starving");
assert.strictEqual(scenarios[0].candidates.close_mild.recipientState.needSeverity, 0.5);
assert.strictEqual(scenarios[0].candidates.weak_severe.recipientState.needSeverity, 1);

const gradientScenario = F.withSeverities(scenarios[0], 0.4, 0.8);
assert.strictEqual(gradientScenario.severityId, "0.400:0.800");
assert.strictEqual(gradientScenario.candidates.close_mild.recipientState.needSeverity, 0.4);
assert.strictEqual(gradientScenario.candidates.weak_severe.recipientState.needSeverity, 0.8);
assert.strictEqual(scenarios[0].candidates.close_mild.recipientState.needSeverity, 0.5);

const deceased = fixture();
deceased.personas.personas["3"].deceased = true;
assert.strictEqual(F.buildScenarios(deceased.personas, deceased.graph, deceased.dynamics).length, 0);

const noFamily = fixture();
noFamily.graph.edges["1:2"].sources = ["coworker"];
noFamily.graph.edges["1:2"].familiarity = 0.8;
assert.strictEqual(F.buildScenarios(noFamily.personas, noFamily.graph, noFamily.dynamics).length, 0);
const fallback = F.buildScenarios(noFamily.personas, noFamily.graph, noFamily.dynamics, {
  allowNonFamilyClose: true,
});
assert.strictEqual(fallback.length, 1);
assert.strictEqual(fallback[0].closeRelationType, "strongest_available");
assert.ok(F.renderScenarioCard(fallback[0]).includes("最も親しく信頼"));

const personaInput = F.candidateInput(scenarios[0], "close_mild", "persona");
assert.deepStrictEqual(personaInput.sources, []);
assert.strictEqual(personaInput.helperPerspective.trust, 0.5);
const temporalInput = F.candidateInput(scenarios[0], "close_mild", "temporal");
assert.deepStrictEqual(temporalInput.sources, ["parent_child"]);
assert.strictEqual(temporalInput.helperPerspective.trust, 0.9);

const fakeDecide = (candidate) => {
  const score = candidate.recipientState.nutritionBand === "starving" ? 0.8 : 0.3;
  return { selected: "help", actions: { help: { score }, refuse: { score: 0 } } };
};
const outcome = F.chooseAllocation(scenarios[0], "uniform", { decide: fakeDecide });
assert.strictEqual(outcome.selected, "weak_severe");

const sampled1 = F.chooseAllocation(scenarios[0], "uniform", {
  decide: fakeDecide, mode: "sample", seed: "same-seed",
});
const sampled2 = F.chooseAllocation(scenarios[0], "uniform", {
  decide: fakeDecide, mode: "sample", seed: "same-seed",
});
assert.strictEqual(sampled1.selected, sampled2.selected);

const keep = F.chooseAllocation(scenarios[0], "uniform", { decide: () => ({
  selected: "refuse", actions: { help: { score: -0.1 }, refuse: { score: 0.2 } },
}) });
assert.strictEqual(keep.selected, "keep");

const card = F.renderScenarioCard(scenarios[0]);
assert.ok(card.includes("分けられる料理が1食だけ"));
assert.ok(card.includes("Family"));
assert.ok(card.includes("Neighbor"));

const result = F.runExperiment({ scenarios }, { decide: fakeDecide });
assert.strictEqual(result.scenarios, 1);
for (const condition of F.CONDITIONS) {
  assert.strictEqual(result.conditions[condition].needPriorityRate, 1);
}

console.log("ALL PASS (food allocation scenario)");
