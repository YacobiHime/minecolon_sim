// Offline unit tests for social_graph.js. No bridge or world access.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const S = require("./social_graph.js");
const O = require("./social_observer.js");

function citizen(id, name, extra) {
  return {
    id,
    name,
    job: "unemployed",
    saturation: 10,
    sick: false,
    disease: null,
    isChild: false,
    parents: [],
    children: [],
    siblings: [],
    partner: null,
    homeBuilding: null,
    workBuilding: null,
    ...extra,
  };
}

function building(x, z, level = 1) {
  return { x, y: 64, z, level };
}

function colony(citizens) {
  return { id: 1, name: "Fixture", gameTime: 1234, citizens };
}

let passed = 0;
function test(label, fn) {
  fn();
  passed++;
  console.log(`PASS ${label}`);
}

test("family fields resolve to de-duplicated structural edges", () => {
  const graph = S.buildSocialGraph(colony([
    citizen(1, "Parent A", { partner: 2, children: [3] }),
    citizen(2, "Parent B", { partner: 1, children: [3] }),
    citizen(3, "Child", { parents: ["Parent A", "Parent B"] }),
  ]));
  assert.deepStrictEqual(graph.edges["1:2"].sources, ["partner"]);
  assert.deepStrictEqual(graph.edges["1:3"].sources, ["parent_child"]);
  assert.deepStrictEqual(graph.edges["2:3"].sources, ["parent_child"]);
  assert.strictEqual(graph.metrics.edges, 3);
});

test("same home, same workplace and nearby homes add independent sources", () => {
  const homeA = building(0, 0);
  const homeB = building(30, 0);
  const work = building(10, 10);
  const graph = S.buildSocialGraph(colony([
    citizen(1, "A", { homeBuilding: homeA, workBuilding: work }),
    citizen(2, "B", { homeBuilding: homeA, workBuilding: work }),
    citizen(3, "C", { homeBuilding: homeB }),
  ]), { neighborDistance: 48 });
  assert.deepStrictEqual(graph.edges["1:2"].sources, ["co_resident", "coworker"]);
  assert.deepStrictEqual(graph.edges["1:3"].sources, ["neighbor"]);
  assert.deepStrictEqual(graph.edges["2:3"].sources, ["neighbor"]);
  assert.ok(graph.edges["1:2"].familiarity > graph.edges["1:3"].familiarity);
});

test("unhoused citizens are not guessed as neighbors", () => {
  const graph = S.buildSocialGraph(colony([
    citizen(1, "Housed", { homeBuilding: building(0, 0) }),
    citizen(2, "Unhoused"),
  ]));
  assert.strictEqual(graph.metrics.edges, 0);
  assert.deepStrictEqual(graph.metrics.isolatedCitizenIds, [1, 2]);
});

test("rebuild removes stale links after death, move and job change", () => {
  const home = building(0, 0);
  const work = building(5, 5);
  const before = S.buildSocialGraph(colony([
    citizen(1, "A", { homeBuilding: home, workBuilding: work }),
    citizen(2, "B", { homeBuilding: home, workBuilding: work }),
  ]));
  assert.ok(before.edges["1:2"]);
  const after = S.buildSocialGraph(colony([
    citizen(1, "A", { homeBuilding: building(100, 100) }),
  ]));
  assert.strictEqual(after.metrics.edges, 0);
  assert.deepStrictEqual(Object.keys(after.nodes), ["1"]);
});

test("output and atomic save are deterministic", () => {
  const input = colony([
    citizen(3, "C", { siblings: [2] }),
    citizen(1, "A", { partner: 2 }),
    citizen(2, "B", { partner: 1, siblings: [3] }),
  ]);
  const a = S.buildSocialGraph(input);
  const b = S.buildSocialGraph(input);
  assert.deepStrictEqual(a, b);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "social-graph-test-"));
  const file = path.join(dir, "social_state.json");
  S.saveGraph(a, file);
  assert.ok(!fs.existsSync(`${file}.tmp`));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")), a);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("diffGraphs reports citizen, assignment and structural edge changes", () => {
  const oldGraph = S.buildSocialGraph(colony([
    citizen(1, "A", {
      job: "farmer",
      homeBuilding: building(0, 0),
      workBuilding: building(10, 10),
      partner: 2,
    }),
    citizen(2, "B", { homeBuilding: building(0, 0), partner: 1 }),
  ]));
  const newGraph = S.buildSocialGraph(colony([
    citizen(1, "A", {
      job: "builder",
      homeBuilding: building(100, 100),
      workBuilding: building(20, 20),
    }),
    citizen(3, "C", { homeBuilding: building(100, 100) }),
  ]));
  const types = S.diffGraphs(oldGraph, newGraph).map((e) => e.type);
  for (const expected of [
    "citizen_added", "citizen_removed", "job_changed", "home_changed",
    "work_changed", "edge_added", "edge_removed",
  ]) {
    assert.ok(types.includes(expected), `missing ${expected}: ${types.join(",")}`);
  }
  assert.deepStrictEqual(S.diffGraphs(newGraph, newGraph), []);
});

test("health diffs use nutrition bands and ignore raw saturation noise", () => {
  const oldGraph = S.buildSocialGraph(colony([
    citizen(1, "A", { saturation: 5.5, sick: false }),
    citizen(2, "B", { saturation: 10, sick: true, disease: "flu" }),
  ]));
  const sameBands = S.buildSocialGraph(colony([
    citizen(1, "A", { saturation: 4.5, sick: false }),
    citizen(2, "B", { saturation: 9, sick: true, disease: "flu" }),
  ]));
  assert.deepStrictEqual(S.diffGraphs(oldGraph, sameBands), []);

  const changed = S.buildSocialGraph(colony([
    citizen(1, "A", { saturation: 2, sick: true, disease: "measles" }),
    citizen(2, "B", { saturation: 9, sick: false }),
  ]));
  const events = S.diffGraphs(oldGraph, changed);
  assert.ok(events.some((e) => e.type === "nutrition_changed" &&
    e.citizenId === 1 && e.from === "hungry" && e.to === "starving"));
  assert.ok(events.some((e) => e.type === "sickness_started" && e.citizenId === 1));
  assert.ok(events.some((e) => e.type === "recovered" && e.citizenId === 2));
});

test("observer reconcile and JSONL append are deterministic and replayable", () => {
  const first = O.reconcile(null, colony([citizen(1, "A")]));
  assert.deepStrictEqual(first.events, [], "initial baseline must not invent changes");
  const second = O.reconcile(first.graph, colony([
    citizen(1, "A", { job: "builder" }),
    citizen(2, "B"),
  ]));
  assert.ok(second.events.some((e) => e.type === "citizen_added" && e.citizenId === 2));
  assert.ok(second.events.some((e) => e.type === "job_changed" && e.citizenId === 1));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "social-event-test-"));
  const file = path.join(dir, "events.jsonl");
  const record = O.appendEvent(
    second.events[0], file, "2026-07-24T00:00:00.000Z", 999
  );
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8").trim()), record);
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\nALL PASS (${passed} tests)`);
