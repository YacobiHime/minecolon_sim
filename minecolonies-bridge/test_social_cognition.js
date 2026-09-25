const assert = require("assert");
const C = require("./social_cognition.js");

function persona(values) {
  return { citizenId: 1, templateId: "fixture", generation: 0, segments: {
    temperament: {
      bravery: values.bravery, empathy: values.empathy,
      obedience: values.obedience, greed: values.greed,
      sociability: values.sociability,
    },
    politics: { loyalty: values.loyalty, ambition: values.ambition },
  } };
}
const caring = persona({
  bravery: 0.5, empathy: 0.95, obedience: 0.8, greed: 0.05,
  sociability: 0.9, loyalty: 0.9, ambition: 0.2,
});
const selfFocused = persona({
  bravery: 0.7, empathy: 0.05, obedience: 0.1, greed: 0.95,
  sociability: 0.1, loyalty: 0.1, ambition: 0.9,
});
const context = {
  helperState: { nutritionBand: "fed", sick: false, stress: 0.1 },
  recipientState: { nutritionBand: "starving", sick: false },
  helperPerspective: {
    trust: 0.8, affinity: 0.8, obligation: 0.2,
    affect: { gratitude: 0.4, resentment: 0 },
  },
  sources: ["parent_child"], familiarity: 0.9, distance: 10,
  resourceAvailable: true,
};
const a = C.buildCognitiveProfile(caring, context);
const same = C.buildCognitiveProfile(caring, context);
const b = C.buildCognitiveProfile(selfFocused, context);
assert.deepStrictEqual(a, same, "profile derivation must be deterministic");
assert.strictEqual(a.schema, "voyager-cognition-v1");
assert.ok(a.stable.motives.care > b.stable.motives.care);
assert.ok(a.stable.norms.careForKin > b.stable.norms.careForKin);
assert.ok(a.activeGoals.aidOther > b.activeGoals.aidOther);
assert.ok(b.stable.motives.resourceProtection > a.stable.motives.resourceProtection);
assert.ok(Object.values(a.stable.values).every((x) => x >= 0 && x <= 1));
assert.ok(a.stable.emotionDynamics.positiveHalfLifeTicks >= 12000);
assert.ok(a.trace.activeGoals.aidOther.terms.some((x) => x.source === "familyContext"));
console.log("ALL PASS (detailed cognitive profile)");
