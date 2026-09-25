const assert = require("assert");
const A = require("./social_appraisal_v2.js");

function persona(overrides) {
  return { citizenId: 1, templateId: "fixture", generation: 0, segments: {
    temperament: {
      bravery: 0.5, empathy: 0.8, obedience: 0.7,
      greed: 0.2, sociability: 0.8, ...overrides,
    },
    politics: { loyalty: 0.8, ambition: 0.2 },
  } };
}
function input(overrides) {
  return {
    helperPersona: persona(),
    helperState: { nutritionBand: "fed", sick: false, stress: 0.1 },
    recipientState: { nutritionBand: "starving", sick: false },
    helperPerspective: {
      trust: 0.8, affinity: 0.8, obligation: 0.2,
      affect: { gratitude: 0.3, resentment: 0 },
    },
    sources: ["parent_child"], familiarity: 0.9,
    distance: 10, resourceAvailable: true, ...overrides,
  };
}
const config = A.loadConfig();
assert.strictEqual(config._meta.status, "experimental-unvalidated");
const help = A.decideHelp(input({}), { mode: "max", config });
assert.strictEqual(help.selected, "help");
assert.strictEqual(help.appraisal.model, "voyager-appraisal-v2");
assert.ok(help.appraisal.profile.trace.norms.reciprocateHelp.terms.length > 0);
assert.ok(help.actions.help.contributions.every((x) => typeof x.value === "number"));

const unable = A.decideHelp(input({ resourceAvailable: false }), { mode: "max", config });
assert.strictEqual(unable.selected, "refuse");
const costly = A.decideHelp(input({
  helperPersona: persona({ empathy: 0.05, greed: 0.95, sociability: 0.1 }),
  helperState: { nutritionBand: "starving", sick: true, stress: 0.9 },
  helperPerspective: {
    trust: 0.1, affinity: 0.1, obligation: 0,
    affect: { gratitude: 0, resentment: 0.8 },
  },
  sources: ["neighbor"], familiarity: 0.2, distance: 90,
}), { mode: "max", config });
assert.strictEqual(costly.selected, "refuse");
const repeat = A.decideHelp(input({}), { seed: "v2-seed", config });
const same = A.decideHelp(input({}), { seed: "v2-seed", config });
assert.deepStrictEqual(repeat, same);
console.log("ALL PASS (appraisal v2)");
