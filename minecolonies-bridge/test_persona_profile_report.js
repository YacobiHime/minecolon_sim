const assert = require("assert");
const R = require("./persona_profile_report.js");

function persona(citizenId, name, traits) {
  return {
    citizenId, name, templateId: `fixture-${citizenId}`, generation: 0,
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

const input = {
  personas: { personas: {
    "1": persona(1, "Care", {
      bravery: 0.4, empathy: 0.9, obedience: 0.8, greed: 0.1,
      sociability: 0.9, loyalty: 0.9, ambition: 0.2,
    }),
    "2": persona(2, "Gain", {
      bravery: 0.8, empathy: 0.1, obedience: 0.2, greed: 0.9,
      sociability: 0.2, loyalty: 0.2, ambition: 0.9,
    }),
  } },
  graph: {
    nodes: {
      "1": { citizenId: 1, job: "farmer", isChild: false },
      "2": { citizenId: 2, job: "builder", isChild: false },
    },
    edges: {
      "1:2": { a: 1, b: 2, sources: ["neighbor", "coworker"] },
    },
  },
  dynamics: { citizens: {
    "1": { stress: 0.2, satisfaction: 0.8, actualLoyalty: 0.9 },
    "2": { stress: 0.7, satisfaction: 0.3, actualLoyalty: 0.2 },
  } },
};

const report = R.generateReport(input, { includeTrace: false });
assert.strictEqual(report.schema, "voyager-persona-profile-report-v1");
assert.strictEqual(report.population, 2);
assert.strictEqual(report.profiles[0].roles.relationDegree, 1);
assert.deepStrictEqual(report.profiles[0].roles.relationSources, ["coworker", "neighbor"]);
assert.ok(!report.profiles[0].profile.trace, "compact reports omit derivation traces");
assert.ok(report.dimensions.care.sd > 0);
assert.strictEqual(report.dimensions.care.max.citizenId, 1);
assert.strictEqual(report.dimensions.resourceProtection.max.citizenId, 2);

const traced = R.generateReport(input, { includeTrace: true });
assert.ok(traced.profiles[0].profile.trace.motives.care.terms.length > 0);
console.log("ALL PASS (persona profile report)");
