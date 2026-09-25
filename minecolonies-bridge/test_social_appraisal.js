const assert = require("assert");
const A = require("./social_appraisal.js");

function persona({ empathy, greed, sociability, obedience, loyalty, ambition }) {
  return { segments: {
    temperament: { empathy, greed, sociability, obedience },
    politics: { loyalty, ambition },
  } };
}

function input(overrides) {
  return {
    helperPersona: persona({
      empathy: 0.8, greed: 0.2, sociability: 0.7,
      obedience: 0.6, loyalty: 0.8, ambition: 0.2,
    }),
    helperState: { nutritionBand: "fed", sick: false, stress: 0.1 },
    recipientState: { nutritionBand: "starving", sick: false },
    helperPerspective: { trust: 0.7, affinity: 0.7, obligation: 0.2 },
    sources: ["parent_child"],
    familiarity: 0.9,
    distance: 12,
    resourceAvailable: true,
    ...overrides,
  };
}

let passed = 0;
function test(label, fn) {
  fn();
  passed++;
  console.log(`PASS ${label}`);
}

test("derived values are deterministic and bounded", () => {
  const values = A.deriveValues(input({}).helperPersona);
  assert.deepStrictEqual(values, A.deriveValues(input({}).helperPersona));
  assert.ok(Object.values(values).every((v) => v >= 0 && v <= 1));
  assert.ok(values.community > values.autonomy);
});

test("high-empathy family helper prefers feasible help", () => {
  const result = A.decideHelp(input({}), { mode: "max" });
  assert.strictEqual(result.selected, "help");
  assert.ok(result.appraisal.emotions.concern > 0.5);
  assert.ok(result.actions.help.contributions.some((x) => x.name === "family" && x.value > 0));
});

test("no resource makes refusal the explainable maximum", () => {
  const result = A.decideHelp(input({ resourceAvailable: false }), { mode: "max" });
  assert.strictEqual(result.selected, "refuse");
  assert.ok(result.actions.help.score < result.actions.refuse.score);
});

test("self-need and low empathy can reverse the decision", () => {
  const low = persona({
    empathy: 0.05, greed: 0.95, sociability: 0.2,
    obedience: 0.2, loyalty: 0.2, ambition: 0.9,
  });
  const result = A.decideHelp(input({
    helperPersona: low,
    helperState: { nutritionBand: "starving", sick: true, stress: 0.9 },
    helperPerspective: { trust: 0.2, affinity: 0.2, obligation: 0 },
    sources: ["neighbor"],
    familiarity: 0.35,
    distance: 80,
  }), { mode: "max" });
  assert.strictEqual(result.selected, "refuse");
});

test("seeded choice is repeatable", () => {
  const actions = A.decideHelp(input({}), { seed: "trial-7" });
  const same = A.decideHelp(input({}), { seed: "trial-7" });
  assert.strictEqual(actions.selected, same.selected);
  assert.deepStrictEqual(actions.actions, same.actions);
});

test("remembered gratitude and resentment shift later action scores", () => {
  const grateful = A.decideHelp(input({
    helperPerspective: {
      trust: 0.5, affinity: 0.5, obligation: 0,
      affect: { gratitude: 0.8, resentment: 0 },
    },
  }), { mode: "max" });
  const resentful = A.decideHelp(input({
    helperPerspective: {
      trust: 0.5, affinity: 0.5, obligation: 0,
      affect: { gratitude: 0, resentment: 0.8 },
    },
  }), { mode: "max" });
  assert.ok(grateful.actions.help.score > resentful.actions.help.score);
  assert.ok(grateful.actions.refuse.score < resentful.actions.refuse.score);
});

console.log(`\nALL PASS (${passed} tests)`);
