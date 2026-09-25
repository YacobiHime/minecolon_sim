const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const S = require("./social_graph.js");
const D = require("./social_dynamics.js");
const O = require("./social_observer.js");
const Q = require("./social_action_queue.js");

const colony = {
  id: 1,
  name: "Test",
  gameTime: 500,
  citizens: [
    { id: 1, name: "Helper", saturation: 10, children: [2], siblings: [], parents: [] },
    { id: 2, name: "Recipient", saturation: 1, children: [], siblings: [], parents: [] },
  ],
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "observer-action-test-"));
  const actionFile = path.join(dir, "actions.jsonl");
  const eventFile = path.join(dir, "observer.jsonl");
  const stateFile = path.join(dir, "graph.json");
  const dynamicsFile = path.join(dir, "dynamics.json");
  const graph = S.buildSocialGraph(colony);
  const dynamics = D.reconcileState(null, graph, null);
  Q.appendAction({
    type: "help_succeeded", helperId: 1, recipientId: 2, gameTime: 480,
  }, actionFile, "t1");

  const result = await O.pollOnce(graph, {
    fetchColony: async () => colony,
    dynamicState: dynamics,
    actionFile,
    eventFile,
    stateFile,
    dynamicsFile,
    now: "t2",
    personas: { personas: {} },
  });
  assert.strictEqual(D.perspectiveFor(result.dynamicState, 2, 1).trust, 0.58);
  assert.strictEqual(result.dynamicState._meta.actionEventOffset, fs.statSync(actionFile).size);
  assert.strictEqual(result.dynamicState._meta.memoryBackfillOffset, fs.statSync(actionFile).size);
  assert.ok(fs.readFileSync(eventFile, "utf8").includes("social_action_applied"));

  const again = await O.pollOnce(graph, {
    fetchColony: async () => colony,
    dynamicState: result.dynamicState,
    actionFile,
    eventFile,
    stateFile,
    dynamicsFile,
    now: "t3",
    personas: { personas: {} },
  });
  assert.strictEqual(D.perspectiveFor(again.dynamicState, 2, 1).trust, 0.58);
  assert.strictEqual(D.perspectiveFor(again.dynamicState, 2, 1).memory.helpReceived, 1);

  const legacyActionFile = path.join(dir, "legacy-actions.jsonl");
  Q.appendAction({
    type: "help_succeeded", helperId: 1, recipientId: 2, gameTime: 480,
  }, legacyActionFile, "legacy");
  const legacy = D.reconcileState(null, graph, null);
  D.perspectiveFor(legacy, 2, 1).trust = 0.58;
  D.perspectiveFor(legacy, 2, 1).obligation = 0.1;
  legacy._meta.actionEventOffset = fs.statSync(legacyActionFile).size;
  const migrated = await O.pollOnce(graph, {
    fetchColony: async () => colony,
    dynamicState: legacy,
    actionFile: legacyActionFile,
    eventFile: path.join(dir, "legacy-observer.jsonl"),
    stateFile: path.join(dir, "legacy-graph.json"),
    dynamicsFile: path.join(dir, "legacy-dynamics.json"),
    now: "t4",
    personas: { personas: {} },
  });
  assert.strictEqual(D.perspectiveFor(migrated.dynamicState, 2, 1).trust, 0.58,
    "memory backfill must not apply trust twice");
  assert.strictEqual(D.perspectiveFor(migrated.dynamicState, 2, 1).memory.helpReceived, 1);
  assert.strictEqual(migrated.dynamicState._meta.memoryBackfillOffset,
    migrated.dynamicState._meta.actionEventOffset);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("ALL PASS (observer applies social actions exactly once)");
})().catch((error) => { console.error(error); process.exit(1); });
