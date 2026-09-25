const assert = require("assert");
const I = require("./social_information.js");
const R = require("./social_information_runner.js");

function persona(id, sociability, loyalty) {
  return { citizenId: id, deceased: false, segments: {
    temperament: { empathy: 0.7, greed: 0.2, sociability, obedience: 0.7 },
    politics: { loyalty, ambition: 0.2 },
  } };
}
const personas = { personas: {
  "1": persona(1, 0.9, 0.9), "2": persona(2, 0.9, 0.9), "3": persona(3, 0.9, 0.9),
} };
const graph = {
  _meta: { colonyId: 1, gameTime: 100 },
  nodes: { "1": { citizenId: 1 }, "2": { citizenId: 2 }, "3": { citizenId: 3 } },
  edges: {
    "1:2": { a: 1, b: 2, sources: ["parent_child"], familiarity: 0.9 },
    "2:3": { a: 2, b: 3, sources: ["coworker"], familiarity: 0.8 },
  },
};
const view = (toward) => ({
  toward, trust: 0.9, affinity: 0.8, obligation: 0,
  affect: { gratitude: 0, resentment: 0, lastGameTime: 100 },
});
const dynamics = { _meta: {}, citizens: {}, relations: {
  "1:2": { a: 1, b: 2, perspectives: { "1": view(2), "2": view(1) } },
  "2:3": { a: 2, b: 3, perspectives: { "2": view(3), "3": view(2) } },
} };
const message = {
  messageId: "threat-1", type: "threat_warning", originCitizenId: 1,
  evidenceEventId: "fixture", createdGameTime: 100,
  ttlTicks: 1000, maxHops: 4, urgency: 1,
};

const full = I.propagate({ graph, dynamics, personas, message }, {
  condition: "temporal", mode: "max", hopTicks: 100,
});
assert.strictEqual(full.metrics.reached, 3);
assert.deepStrictEqual(full.reached.find((x) => x.citizenId === 3).path, [1, 2, 3]);

const ttl = I.propagate({ graph, dynamics, personas, message: { ...message, ttlTicks: 100 } }, {
  condition: "temporal", mode: "max", hopTicks: 100,
});
assert.strictEqual(ttl.metrics.reached, 2);
assert.strictEqual(ttl.metrics.expiredTransmissions, 1);

const first = I.propagate({ graph, dynamics, personas, message }, {
  condition: "temporal", seed: "repeatable", hopTicks: 100,
});
const again = I.propagate({ graph, dynamics, personas, message }, {
  condition: "temporal", seed: "repeatable", hopTicks: 100,
});
assert.deepStrictEqual(first, again);

const hostile = I.evaluateTransmission({
  persona: persona(3, 0.1, 0.1),
  view: { trust: 0, affect: { gratitude: 0, resentment: 1 } },
  familiarity: 0, message: { urgency: 0.4 },
}, { mode: "max" });
assert.strictEqual(hostile.accepted, false);
const ensemble = R.runEnsemble({
  personas, graph, dynamics, originCitizenId: 1,
  seed: "ensemble", runs: 5, hopTicks: 100,
});
assert.strictEqual(ensemble.conditions.temporal.runs, 5);
assert.ok(ensemble.conditions.temporal.meanCoverage >= 1 / 3);
console.log("ALL PASS (local information propagation)");
