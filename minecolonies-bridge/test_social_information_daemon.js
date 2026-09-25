const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const D = require("./social_information_daemon.js");
const P = require("./personas.js");

const graph = {
  _meta: { colonyId: 1, gameTime: 100 },
  nodes: { "1": { citizenId: 1 }, "2": { citizenId: 2 } },
  edges: { "1:2": { a: 1, b: 2, sources: ["neighbor"], familiarity: 0.7 } },
};
const dynamics = { _meta: {}, citizens: {}, relations: { "1:2": {
  a: 1, b: 2, perspectives: {
    "1": { toward: 2, trust: 0.8, affinity: 0.7, obligation: 0 },
    "2": { toward: 1, trust: 0.8, affinity: 0.7, obligation: 0 },
  },
} } };
const segment = {
  temperament: { empathy: 0.8, greed: 0.2, sociability: 0.8, obedience: 0.7 },
  politics: { loyalty: 0.8, ambition: 0.2 },
};
const personas = { personas: {
  "1": { citizenId: 1, deceased: false, segments: segment },
  "2": { citizenId: 2, deceased: false, segments: segment },
} };
const colony = { id: 1, gameTime: 100, citizens: [
  { id: 1, isChild: false, position: { x: 0, y: 64, z: 0 } },
  { id: 2, isChild: false, position: { x: 20, y: 64, z: 0 } },
] };

(async () => {
  const none = await D.pollOnce({ threatStatus: { threats: [], raid: { active: false } } });
  assert.strictEqual(none.status, "no-threat");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "information-daemon-test-"));
  const threatStatus = { threats: [{
    id: 7, type: "minecraft:zombie", x: 2, y: 64, z: 0, targetCitizenId: 2,
  }], raid: { active: false } };
  assert.strictEqual(D.chooseOrigin(colony, threatStatus, graph), 2,
    "targeted citizen must originate the warning");
  const opts = {
    threatStatus, colonies: [colony], graph, dynamics, personas,
    runtimeFile: path.join(dir, "runtime.json"),
    eventFile: path.join(dir, "events.jsonl"),
    mode: "max", now: "test-time",
  };
  const result = await D.pollOnce(opts);
  assert.strictEqual(result.status, "propagated");
  assert.strictEqual(result.result.message.originCitizenId, 2);
  assert.ok(fs.readFileSync(opts.eventFile, "utf8").includes("threat_information_propagated"));
  const duplicate = await D.pollOnce(opts);
  assert.strictEqual(duplicate.status, "duplicate");
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("ALL PASS (information shadow daemon)");
})().catch((error) => { console.error(error); process.exit(1); });
