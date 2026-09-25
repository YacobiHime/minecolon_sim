// Offline tests for Phase 2 dynamic state. No bridge access.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const D = require("./social_dynamics.js");

function graph(nodes, edges) {
  return {
    _meta: { colonyId: 1 },
    nodes: Object.fromEntries(nodes.map((n) => [String(n.citizenId), n])),
    edges: edges || {},
  };
}

function personas(records) {
  return { personas: Object.fromEntries(records.map((p) => [String(p.citizenId), p])) };
}

function persona(citizenId, loyalty, liked, disliked) {
  return {
    citizenId,
    segments: {
      politics: { loyalty },
      jobPreference: { liked: liked || [], disliked: disliked || [] },
    },
  };
}

let passed = 0;
function test(label, fn) {
  fn();
  passed++;
  console.log(`PASS ${label}`);
}

test("initial state uses persona loyalty and neutral dynamic values", () => {
  const g = graph([{ citizenId: 1, name: "A" }]);
  const state = D.reconcileState(null, g, personas([persona(1, 0.8)]));
  assert.deepStrictEqual(state.citizens["1"], {
    citizenId: 1,
    name: "A",
    active: true,
    fear: 0,
    stress: 0,
    satisfaction: 0.5,
    actualLoyalty: 0.8,
    nutritionBand: "unknown",
    sick: false,
    disease: null,
    lastEventGameTime: null,
  });
});

test("reconcile preserves dynamics and historical relations", () => {
  const edge = { a: 1, b: 2, sources: ["coworker"] };
  const first = D.reconcileState(null, graph([
    { citizenId: 1, name: "A" },
    { citizenId: 2, name: "B" },
  ], { "1:2": edge }), null);
  first.citizens["1"].satisfaction = 0.9;
  first.relations["1:2"].trust = 0.75;
  const second = D.reconcileState(first, graph([
    { citizenId: 1, name: "A" },
  ]), null);
  assert.strictEqual(second.citizens["1"].satisfaction, 0.9);
  assert.strictEqual(second.citizens["2"].active, false);
  assert.strictEqual(second.relations["1:2"].trust, 0.75);
  assert.strictEqual(second.relations["1:2"].structurallyActive, false);
  assert.strictEqual(second.relations["1:2"].perspectives["1"].toward, 2);
  assert.strictEqual(second.relations["1:2"].perspectives["2"].toward, 1);
});

test("help outcomes update asymmetric relationship perspectives", () => {
  const edge = { a: 1, b: 2, sources: ["parent_child"] };
  const state = D.reconcileState(null, graph([
    { citizenId: 1, name: "Helper" },
    { citizenId: 2, name: "Recipient" },
  ], { "1:2": edge }), null);

  D.applyEvent(state, {
    type: "help_succeeded", helperId: 1, recipientId: 2,
  }, null, 100);
  assert.strictEqual(D.perspectiveFor(state, 2, 1).trust, 0.58);
  assert.strictEqual(D.perspectiveFor(state, 1, 2).trust, 0.5);
  assert.strictEqual(D.perspectiveFor(state, 2, 1).obligation, 0.1);
  assert.strictEqual(D.perspectiveFor(state, 2, 1).affect.gratitude, 0.18);
  assert.strictEqual(D.perspectiveFor(state, 2, 1).memory.helpReceived, 1);
  assert.strictEqual(D.perspectiveFor(state, 1, 2).memory.helpGiven, 1);
  assert.strictEqual(state.relations["1:2"].trust, 0.54);

  D.applyEvent(state, {
    type: "help_refused", helperId: 1, recipientId: 2,
  }, null, 200);
  assert.strictEqual(D.perspectiveFor(state, 2, 1).trust, 0.52);
  assert.strictEqual(D.perspectiveFor(state, 1, 2).trust, 0.5);
  assert.strictEqual(D.perspectiveFor(state, 2, 1).affect.resentment, 0.16);
  assert.strictEqual(D.perspectiveFor(state, 2, 1).memory.refusalsReceived, 1);
});

test("directed affect decays by game time rather than poll count", () => {
  const state = D.reconcileState(null, graph([
    { citizenId: 1, name: "A" }, { citizenId: 2, name: "B" },
  ], { "1:2": { a: 1, b: 2, sources: ["neighbor"] } }), null);
  D.applyEvent(state, { type: "help_succeeded", helperId: 1, recipientId: 2 }, null, 100);
  const stored = D.perspectiveFor(state, 2, 1);
  const half = D.effectivePerspective(stored, 100 + D.AFFECT_HALF_LIFE_TICKS);
  assert.strictEqual(half.affect.gratitude, 0.09);
  assert.strictEqual(stored.affect.gratitude, 0.18, "lazy evaluation must not mutate stored state");
});

test("helping a former helper repays directed obligation", () => {
  const state = D.reconcileState(null, graph([
    { citizenId: 1, name: "A" }, { citizenId: 2, name: "B" },
  ], { "1:2": { a: 1, b: 2, sources: ["neighbor"] } }), null);
  D.applyEvent(state, { type: "help_succeeded", helperId: 1, recipientId: 2 }, null, 100);
  const reciprocal = D.applyEvent(
    state, { type: "help_succeeded", helperId: 2, recipientId: 1 }, null, 200
  );
  assert.strictEqual(D.perspectiveFor(state, 2, 1).obligation, 0);
  assert.strictEqual(D.perspectiveFor(state, 2, 1).memory.repayments, 1);
  assert.strictEqual(D.perspectiveFor(state, 1, 2).obligation, 0.1);
  assert.strictEqual(reciprocal.repaidObligation, 0.1);
});

test("liked and disliked job changes update satisfaction and loyalty", () => {
  const ps = personas([persona(1, 0.5, ["farmer"], ["miner"])]);
  const state = D.reconcileState(null, graph([{ citizenId: 1, name: "A" }]), ps);
  const liked = D.applyEvent(
    state, { type: "job_changed", citizenId: 1, to: "farmer" }, ps, 100
  );
  assert.strictEqual(liked.preference, "liked");
  assert.strictEqual(state.citizens["1"].satisfaction, 0.6);
  assert.strictEqual(state.citizens["1"].actualLoyalty, 0.52);
  const disliked = D.applyEvent(
    state, { type: "job_changed", citizenId: 1, to: "miner" }, ps, 200
  );
  assert.strictEqual(disliked.preference, "disliked");
  assert.strictEqual(state.citizens["1"].satisfaction, 0.45);
  assert.strictEqual(state.citizens["1"].actualLoyalty, 0.49);
  assert.strictEqual(state.citizens["1"].lastEventGameTime, 200);
});

test("citizen removal is inactivity, not an unconfirmed death", () => {
  const state = D.reconcileState(null, graph([{ citizenId: 1, name: "A" }]), null);
  D.applyEvent(state, { type: "citizen_removed", citizenId: 1 }, null, 123);
  assert.strictEqual(state.citizens["1"].active, false);
  assert.ok(!Object.hasOwn(state.citizens["1"], "deceased"));
});

test("nutrition band transitions update stress without per-poll noise", () => {
  const state = D.reconcileState(null, graph([{ citizenId: 1, name: "A" }]), null);
  const worse = D.applyEvent(
    state, { type: "nutrition_changed", citizenId: 1, from: "fed", to: "starving" },
    null, 100
  );
  assert.strictEqual(worse.stressDelta, 0.2);
  assert.strictEqual(state.citizens["1"].stress, 0.2);
  assert.strictEqual(state.citizens["1"].satisfaction, 0.4);
  const better = D.applyEvent(
    state, { type: "nutrition_changed", citizenId: 1, from: "starving", to: "fed" },
    null, 200
  );
  assert.strictEqual(better.stressDelta, -0.2);
  assert.strictEqual(state.citizens["1"].stress, 0);
  assert.strictEqual(state.citizens["1"].satisfaction, 0.5);
});

test("sickness and recovery update state with bounded partial recovery", () => {
  const state = D.reconcileState(null, graph([{ citizenId: 1, name: "A" }]), null);
  D.applyEvent(
    state, { type: "sickness_started", citizenId: 1, disease: "flu" }, null, 100
  );
  assert.strictEqual(state.citizens["1"].stress, 0.15);
  assert.strictEqual(state.citizens["1"].satisfaction, 0.4);
  assert.strictEqual(state.citizens["1"].disease, "flu");
  D.applyEvent(state, { type: "recovered", citizenId: 1, disease: "flu" }, null, 200);
  assert.strictEqual(state.citizens["1"].stress, 0.05);
  assert.strictEqual(state.citizens["1"].satisfaction, 0.45);
  assert.strictEqual(state.citizens["1"].sick, false);
});

test("atomic save/load round trip", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "social-dynamics-test-"));
  const file = path.join(dir, "state.json");
  const state = D.reconcileState(null, graph([{ citizenId: 1, name: "A" }]), null);
  D.saveState(state, file);
  assert.ok(!fs.existsSync(`${file}.tmp`));
  assert.deepStrictEqual(D.loadState(file), state);
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\nALL PASS (${passed} tests)`);
