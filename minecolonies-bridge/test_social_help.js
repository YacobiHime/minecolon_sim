const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const H = require("./social_help_daemon.js");

function fixture() {
  const colony = { id: 1, gameTime: 2400, citizens: [
    { id: 1, name: "Helper", position: { x: 0, y: 64, z: 0 }, saturation: 15, sick: false },
    { id: 2, name: "Hungry", position: { x: 10, y: 64, z: 0 }, saturation: 1, sick: false },
  ] };
  const graph = { nodes: {
    "1": { citizenId: 1, nutritionBand: "fed" },
    "2": { citizenId: 2, nutritionBand: "starving" },
  }, edges: { "1:2": { a: 1, b: 2, sources: ["parent_child"], familiarity: 0.9 } } };
  const dynamics = { _meta: {}, citizens: {
    "1": { citizenId: 1, active: true, nutritionBand: "fed", stress: 0 },
    "2": { citizenId: 2, active: true, nutritionBand: "starving", stress: 0.3 },
  }, relations: { "1:2": {
    a: 1, b: 2, trust: 0.5, affinity: 0.5, debt: 0,
    perspectives: {
      "1": { toward: 2, trust: 0.8, affinity: 0.8, obligation: 0 },
      "2": { toward: 1, trust: 0.8, affinity: 0.8, obligation: 0 },
    },
  } } };
  const personas = { personas: { "1": { citizenId: 1, segments: {
    temperament: { empathy: 0.9, greed: 0.1, sociability: 0.8, obedience: 0.7 },
    politics: { loyalty: 0.9, ambition: 0.1 },
  } } } };
  return { colony, graph, dynamics, personas };
}

(async () => {
  assert.strictEqual(H.isNeedy({ nutritionBand: "starving", sick: false }, "starving"), true);
  assert.strictEqual(H.isNeedy({ nutritionBand: "hungry", sick: false }, "starving"), false);
  assert.strictEqual(H.liveNutritionBand({ saturation: 2.5 }), "starving");
  assert.strictEqual(H.liveNutritionBand({ saturation: 6 }), "hungry");
  assert.strictEqual(H.liveNutritionBand({ saturation: 6.1 }), "fed");
  assert.strictEqual(H.selectFood({ items: [{ item: "minecolonies:borscht", count: 1 }] }), null);
  assert.strictEqual(H.selectFood({ items: [{ item: "minecolonies:borscht", count: 2 }] }), "minecolonies:borscht");
  assert.strictEqual(H.selectFood({ items: [
    { item: "minecolonies:steak_dinner", count: 3 },
    { item: "minecolonies:fish_dinner", count: 2 },
  ] }, { items: [{ item: "minecolonies:steak_dinner", count: 1 }] }), "minecolonies:fish_dinner");

  let pursuitTime = 0;
  let pursuitSnapshot = 0;
  const pursuitCalls = [];
  const pursuit = await H.executeHelp(
    { id: 1 }, { id: 2 }, "minecolonies:borscht", {
      nowMs: () => pursuitTime,
      sleep: async (ms) => { pursuitTime += ms; },
      pollMs: 250,
      retargetMs: 500,
      timeoutMs: 2000,
      fetchColony: async () => ({ citizens: [
        { id: 1, position: { x: Math.min(pursuitSnapshot++ * 3, 6), y: 64, z: 0 } },
        { id: 2, position: { x: 10, y: 64, z: 0 } },
      ] }),
      request: async (method, route) => {
        pursuitCalls.push({ method, route });
        return route.startsWith("/transferCitizenItem") ? { result: "transferred" } : { result: "moving" };
      },
    }
  );
  assert.strictEqual(pursuit.result, "transferred");
  assert.ok(pursuitCalls.some((x) => x.route.startsWith("/moveCitizen")));
  assert.ok(pursuitCalls.some((x) => x.route.startsWith("/transferCitizenItem")));

  const f = fixture();
  const ranked = H.rankHelpers(f.colony.citizens[1], f.colony, f.graph, f.dynamics);
  assert.strictEqual(ranked.length, 1);
  assert.strictEqual(ranked[0].helper.id, 1);

  const staleGraph = fixture();
  staleGraph.colony.citizens[1].saturation = 12;
  const noLongerNeedy = await H.runCycle({
    ...staleGraph,
    execute: false,
    decisionMode: "max",
  });
  assert.strictEqual(noLongerNeedy.status, "no-need",
    "live saturation must override a stale starving graph node");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "social-help-test-"));
  const result = await H.runCycle({
    ...f,
    execute: true,
    appraisalModel: "v2",
    decisionMode: "max",
    fetchInventory: async () => ({ items: [{ item: "minecolonies:borscht", count: 3 }] }),
    executeHelp: async () => ({ result: "ok" }),
    eventFile: path.join(dir, "help.jsonl"),
    actionFile: path.join(dir, "actions.jsonl"),
    runtimeFile: path.join(dir, "runtime.json"),
    now: "test-time",
  });
  assert.strictEqual(result.status, "succeeded");
  assert.strictEqual(result.helperId, 1);
  assert.strictEqual(result.recipientId, 2);
  assert.strictEqual(result.appraisalModel, "voyager-appraisal-v2");
  const action = JSON.parse(fs.readFileSync(path.join(dir, "actions.jsonl"), "utf8").trim());
  assert.strictEqual(action.type, "help_succeeded");
  assert.ok(fs.readFileSync(path.join(dir, "help.jsonl"), "utf8").includes("help_decided"));

  const shadowRuntime = path.join(dir, "shadow-runtime.json");
  const shadow = await H.runCycle({
    ...f,
    execute: false,
    appraisalModel: "v2",
    decisionMode: "max",
    fetchInventory: async () => ({ items: [{ item: "minecolonies:borscht", count: 3 }] }),
    eventFile: path.join(dir, "shadow.jsonl"),
    actionFile: path.join(dir, "shadow-actions.jsonl"),
    runtimeFile: shadowRuntime,
    now: "shadow-time",
  });
  assert.strictEqual(shadow.status, "shadow");
  assert.strictEqual(fs.existsSync(shadowRuntime), false, "shadow mode must not consume cooldown");

  const legacy = await H.runCycle({
    ...f,
    execute: false,
    appraisalModel: "v1",
    decisionMode: "max",
    fetchInventory: async () => ({ items: [{ item: "minecolonies:borscht", count: 3 }] }),
    eventFile: path.join(dir, "legacy-v1.jsonl"),
    actionFile: path.join(dir, "legacy-v1-actions.jsonl"),
    runtimeFile: path.join(dir, "legacy-v1-runtime.json"),
    now: "legacy-time",
  });
  assert.strictEqual(legacy.appraisalModel, "voyager-appraisal-v1");

  const failedRuntime = path.join(dir, "failed-runtime.json");
  const failed = await H.runCycle({
    ...f,
    execute: true,
    appraisalModel: "v2",
    decisionMode: "max",
    fetchInventory: async () => ({ items: [{ item: "minecolonies:borscht", count: 3 }] }),
    executeHelp: async () => { throw new Error("move timeout"); },
    eventFile: path.join(dir, "failed.jsonl"),
    actionFile: path.join(dir, "failed-actions.jsonl"),
    runtimeFile: failedRuntime,
    now: "failed-time",
  });
  assert.strictEqual(failed.status, "failed");
  assert.strictEqual(fs.existsSync(failedRuntime), false, "failed execution must not consume cooldown");

  const unable = await H.runCycle({
    ...f,
    execute: true,
    appraisalModel: "v2",
    decisionMode: "max",
    fetchInventory: async () => ({ items: [] }),
    eventFile: path.join(dir, "unable.jsonl"),
    actionFile: path.join(dir, "unable-actions.jsonl"),
    runtimeFile: path.join(dir, "unable-runtime.json"),
    now: "unable-time",
  });
  assert.strictEqual(unable.status, "unable");
  assert.strictEqual(fs.existsSync(path.join(dir, "unable-actions.jsonl")), false,
    "lack of resources must not be recorded as intentional refusal");
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("ALL PASS (social help daemon)");
})().catch((error) => { console.error(error); process.exit(1); });
