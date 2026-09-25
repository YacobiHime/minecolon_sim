const assert = require("assert");
const {
  buildCandidates,
  parsePlacedPosition,
  renderSharedCouncilContext,
  filterRecentlyIneffectiveCandidates,
} = require("./council.js");

function colony(buildings) {
  return [{
    id: 1,
    citizens: [],
    buildings,
    researchUnlocked: [],
  }];
}

function building(overrides) {
  return {
    x: 0, y: 64, z: 0,
    type: "blockhutcitizen",
    level: 0,
    maxLevel: 5,
    pending: false,
    operational: false,
    inTerritory: true,
    workers: [],
    ...overrides,
  };
}

function actionsFor(buildings) {
  return buildCandidates(colony(buildings)).map((candidate) => candidate.action);
}

{
  const actions = actionsFor([
    building({ type: "blockhutbuilder", level: 1, operational: true }),
    building({ x: 20, type: "blockhutcitizen" }),
  ]);
  assert(actions.some((action) => action.action === "requestBuild" && action.x === 20));
  assert(!actions.some((action) => action.action === "placeNext"));
}

{
  const actions = actionsFor([
    building({ type: "blockhutbuilder", level: 1, operational: true }),
    building({ x: 101, type: "blockhutcitizen" }),
  ]);
  assert(!actions.some((action) => action.action === "requestBuild" && action.x === 101));
}

{
  const actions = actionsFor([
    building({ type: "blockhutbuilder", level: 1, operational: true }),
    building({ x: 100, type: "blockhutcitizen" }),
  ]);
  assert(actions.some((action) => action.action === "requestBuild" && action.x === 100));
}

{
  const actions = actionsFor([
    building({ x: 101, type: "blockhutcitizen" }),
  ]);
  assert(actions.some((action) => action.action === "requestBuild" && action.x === 101));
}

assert.deepStrictEqual(
  parsePlacedPosition('{"result":"placed hut [pos:-12,-60,34]"}'),
  { x: -12, y: -60, z: 34 }
);
assert.strictEqual(parsePlacedPosition('{"error":"no valid position"}'), null);

{
  const memory = renderSharedCouncilContext([
    { kind: "speech", who: "Aldric", text: "次は住居を増やそう" },
    {
      kind: "action",
      who: "Aldric",
      label: "住居を新設",
      status: 200,
      effective: true,
      result: "placed",
    },
    { kind: "speech", who: "Mira", text: "了解、次は食料を優先します" },
  ]);
  assert(memory.includes("Aldric: 次は住居を増やそう"));
  assert(memory.includes("Aldricの行動: 住居を新設 -> 200 placed"));
  assert(memory.includes("Mira: 了解、次は食料を優先します"));
}

{
  const staleAction = { action: "requestBuild", x: 15, y: -60, z: 71 };
  const freshAction = { action: "placeNext", block: "minecolonies:blockhutfarm" };
  const candidates = [
    { label: "wait", action: { action: "wait" } },
    { label: "stale barracks", action: staleAction },
    { label: "fresh farm", action: freshAction },
  ];
  const filtered = filterRecentlyIneffectiveCandidates(candidates, [{
    kind: "action",
    who: "Aldric",
    action: staleAction,
    status: 200,
    effective: false,
  }]);
  assert.deepStrictEqual(filtered.map((candidate) => candidate.action), [
    { action: "wait" },
    freshAction,
  ]);
}

console.log("ALL PASS (council build governor)");
