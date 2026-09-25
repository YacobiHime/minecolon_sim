// Shadow-only bridge from live /threats to Phase 4 local propagation.
// It records who would hear a structured warning; it never moves citizens or
// issues combat orders. Phase 6 can consume the resulting delivery records.
const fs = require("fs");
const path = require("path");
const P = require("./personas.js");
const S = require("./social_graph.js");
const D = require("./social_dynamics.js");
const I = require("./social_information.js");
const R = require("./social_information_runner.js");

const BRIDGE = process.env.BRIDGE || "http://localhost:8089";
const COLONY_ID = parseInt(process.env.COLONY_ID || "1", 10);
const POLL_MS = parseInt(process.env.SOCIAL_INFORMATION_POLL_MS || "15000", 10);
const TTL_TICKS = parseInt(process.env.SOCIAL_INFORMATION_TTL_TICKS || "2400", 10);
const EVENT_FILE = process.env.SOCIAL_INFORMATION_EVENT_FILE ||
  path.join(__dirname, "social_information_events.jsonl");
const RUNTIME_FILE = process.env.SOCIAL_INFORMATION_RUNTIME_FILE ||
  path.join(__dirname, "social_information_runtime.json");
const PID_FILE = process.env.SOCIAL_INFORMATION_PID_FILE ||
  path.join(__dirname, "social_information.pid");

async function request(route) {
  const response = await fetch(`${BRIDGE}${route}`);
  const text = await response.text();
  if (!response.ok) throw new Error(`${route} HTTP ${response.status}: ${text}`);
  return JSON.parse(text);
}

function appendEvent(record, file, now) {
  const event = { ts: now || new Date().toISOString(), ...record };
  fs.appendFileSync(file || EVENT_FILE, JSON.stringify(event) + "\n");
  return event;
}

function loadRuntime(file) {
  const target = file || RUNTIME_FILE;
  if (!fs.existsSync(target)) return { lastSignature: null, lastMessageGameTime: null };
  return JSON.parse(fs.readFileSync(target, "utf8"));
}

function saveRuntime(runtime, file) {
  const target = file || RUNTIME_FILE;
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(runtime, null, 2));
  fs.renameSync(tmp, target);
}

function threatSignature(status) {
  const threats = (status.threats || []).map((x) => `${x.id}:${x.type}`).sort();
  return JSON.stringify({ threats, raid: !!(status.raid && status.raid.active) });
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function chooseOrigin(colony, threatStatus, graph) {
  const citizens = (colony.citizens || []).filter((c) =>
    c.position && graph.nodes[String(c.id)] && !c.isChild
  );
  const targeted = (threatStatus.threats || [])
    .map((x) => x.targetCitizenId)
    .find((id) => Number.isInteger(id) && citizens.some((c) => c.id === id));
  if (targeted != null) return targeted;
  if ((threatStatus.threats || []).length) {
    return citizens.slice().sort((a, b) => {
      const da = Math.min(...threatStatus.threats.map((t) => distance(a.position, t)));
      const db = Math.min(...threatStatus.threats.map((t) => distance(b.position, t)));
      return da - db || a.id - b.id;
    })[0]?.id || null;
  }
  return R.highestDegreeOrigin(graph);
}

function buildMessage(colony, threatStatus, originCitizenId, opts) {
  const o = opts || {};
  const count = (threatStatus.threats || []).length;
  const raid = !!(threatStatus.raid && threatStatus.raid.active);
  const signature = threatSignature(threatStatus);
  return {
    messageId: `live-threat-${colony.gameTime}-${originCitizenId}`,
    type: "threat_warning",
    originCitizenId,
    evidenceEventId: signature,
    createdGameTime: colony.gameTime,
    ttlTicks: o.ttlTicks || TTL_TICKS,
    maxHops: Number.isInteger(o.maxHops) ? o.maxHops : 6,
    urgency: Math.min(1, 0.55 + Math.min(count, 5) * 0.07 + (raid ? 0.2 : 0)),
    evidence: {
      threats: (threatStatus.threats || []).map((x) => ({
        id: x.id, type: x.type, x: x.x, y: x.y, z: x.z,
        targetCitizenId: x.targetCitizenId,
      })),
      raid: threatStatus.raid || { active: false },
    },
  };
}

async function pollOnce(opts) {
  const o = opts || {};
  const threatStatus = o.threatStatus || await request(`/threats?colonyId=${COLONY_ID}`);
  const hasThreat = (threatStatus.threats || []).length > 0 ||
    !!(threatStatus.raid && threatStatus.raid.active);
  if (!hasThreat) return { status: "no-threat" };
  const colonies = o.colonies || await request("/status");
  const colony = Array.isArray(colonies)
    ? (colonies.find((x) => x.id === COLONY_ID) || colonies[0]) : colonies;
  if (!colony) throw new Error("colony unavailable");
  const graph = o.graph || S.loadGraph();
  const dynamics = o.dynamics || D.loadState();
  const personas = o.personas || P.loadAll();
  const runtime = o.runtime || loadRuntime(o.runtimeFile);
  const signature = threatSignature(threatStatus);
  if (runtime.lastSignature === signature && Number.isFinite(runtime.lastMessageGameTime) &&
      colony.gameTime - runtime.lastMessageGameTime < (o.ttlTicks || TTL_TICKS)) {
    return { status: "duplicate", signature };
  }
  const originCitizenId = chooseOrigin(colony, threatStatus, graph);
  if (!Number.isInteger(originCitizenId)) return { status: "no-origin", signature };
  const message = buildMessage(colony, threatStatus, originCitizenId, o);
  const result = I.propagate({ graph, dynamics, personas, message }, {
    condition: "temporal",
    seed: o.seed || message.messageId,
    mode: o.mode,
    hopTicks: o.hopTicks,
  });
  appendEvent({ event: "threat_information_propagated", signature, result }, o.eventFile, o.now);
  runtime.lastSignature = signature;
  runtime.lastMessageGameTime = colony.gameTime;
  runtime.lastMessageId = message.messageId;
  saveRuntime(runtime, o.runtimeFile);
  return { status: "propagated", signature, result };
}

function acquirePidfile() {
  try {
    const old = parseInt(fs.readFileSync(PID_FILE, "utf8"), 10);
    if (old) {
      try { process.kill(old, 0); throw new Error(`social_information already running (pid ${old})`); }
      catch (error) { if (String(error.message).startsWith("social_information already")) throw error; }
    }
  } catch (error) {
    if (String(error.message).startsWith("social_information already")) throw error;
  }
  fs.writeFileSync(PID_FILE, String(process.pid));
  const cleanup = () => {
    try { if (fs.readFileSync(PID_FILE, "utf8") === String(process.pid)) fs.unlinkSync(PID_FILE); } catch {}
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}

async function main() {
  acquirePidfile();
  const once = process.argv.includes("--once");
  do {
    try {
      const result = await pollOnce();
      if (once || result.status !== "no-threat") console.log(JSON.stringify(result));
    } catch (error) {
      appendEvent({ event: "information_error", error: String(error.stack || error) });
    }
    if (!once) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  } while (!once);
}

module.exports = {
  threatSignature, chooseOrigin, buildMessage, pollOnce, loadRuntime, saveRuntime,
};
if (require.main === module) main().catch((error) => { console.error(error); process.exit(1); });
