// social_help_daemon.js - Phase 3 embodied help-request loop.
//
// Detects a hungry/sick citizen, chooses one structurally connected helper,
// runs explainable appraisal, then (when explicitly enabled) walks the helper
// to the recipient and transfers an existing food item. Outcomes are appended
// to social_action_events.jsonl; social_observer remains the only dynamics
// writer and applies them exactly once.
const fs = require("fs");
const path = require("path");
const P = require("./personas.js");
const S = require("./social_graph.js");
const D = require("./social_dynamics.js");
const A1 = require("./social_appraisal.js");
const A2 = require("./social_appraisal_v2.js");
const Q = require("./social_action_queue.js");

const BRIDGE = process.env.BRIDGE || "http://localhost:8089";
const COLONY_ID = parseInt(process.env.COLONY_ID || "1", 10);
const POLL_MS = parseInt(process.env.SOCIAL_HELP_POLL_MS || "30000", 10);
const EXECUTE = process.env.SOCIAL_HELP_EXECUTE === "true";
// v2 remains opt-in until its experimental weights have been validated by
// comparison and embodied shadow runs. The already-observed v1 is the safe
// operational default.
const APPRAISAL_MODEL = process.env.SOCIAL_HELP_APPRAISAL_MODEL || "v1";
const NEED_BAND = process.env.SOCIAL_HELP_NEED_BAND || "starving";
const COOLDOWN_TICKS = parseInt(process.env.SOCIAL_HELP_COOLDOWN_TICKS || "12000", 10);
const RECIPIENT_ID = process.env.SOCIAL_HELP_RECIPIENT_ID == null ? null :
  parseInt(process.env.SOCIAL_HELP_RECIPIENT_ID, 10);
const HELPER_ID = process.env.SOCIAL_HELP_HELPER_ID == null ? null :
  parseInt(process.env.SOCIAL_HELP_HELPER_ID, 10);
const EVENT_FILE = process.env.SOCIAL_HELP_EVENT_FILE || path.join(__dirname, "social_help_events.jsonl");
const RUNTIME_FILE = process.env.SOCIAL_HELP_RUNTIME_FILE || path.join(__dirname, "social_help_runtime.json");
const PID_FILE = process.env.SOCIAL_HELP_PID_FILE || path.join(__dirname, "social_help.pid");
const PURSUIT_TIMEOUT_MS = parseInt(process.env.SOCIAL_HELP_PURSUIT_TIMEOUT_MS || "15000", 10);
const PURSUIT_POLL_MS = parseInt(process.env.SOCIAL_HELP_PURSUIT_POLL_MS || "250", 10);
const PURSUIT_RETARGET_MS = parseInt(process.env.SOCIAL_HELP_PURSUIT_RETARGET_MS || "2000", 10);
const TRANSFER_DISTANCE = parseInt(process.env.SOCIAL_HELP_TRANSFER_DISTANCE || "6", 10);

const FOOD_ITEMS = [
  "minecolonies:steak_dinner", "minecolonies:fish_dinner", "minecolonies:schnitzel",
  "minecolonies:ramen", "minecolonies:sushi_roll", "minecolonies:tacos",
  "minecolonies:borscht", "minecolonies:hand_pie", "minecraft:cooked_beef", "minecraft:bread",
];

function appendLog(event, fields, file, now) {
  const record = { ts: now || new Date().toISOString(), event, ...fields };
  fs.appendFileSync(file || EVENT_FILE, JSON.stringify(record) + "\n");
  console.log(JSON.stringify(record));
  return record;
}

function loadRuntime(file) {
  const target = file || RUNTIME_FILE;
  if (!fs.existsSync(target)) return { lastRequestGameTime: {} };
  const state = JSON.parse(fs.readFileSync(target, "utf8"));
  state.lastRequestGameTime = state.lastRequestGameTime || {};
  return state;
}

function saveRuntime(state, file) {
  const target = file || RUNTIME_FILE;
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, target);
}

function isNeedy(citizen, band) {
  if (citizen.sick) return true;
  if (band === "hungry") return citizen.nutritionBand === "hungry" || citizen.nutritionBand === "starving";
  return citizen.nutritionBand === "starving";
}

function liveNutritionBand(citizen) {
  const saturation = Number(citizen && citizen.saturation);
  if (!Number.isFinite(saturation)) return "unknown";
  if (saturation <= 2.5) return "starving";
  if (saturation <= 6) return "hungry";
  return "fed";
}

function distance(a, b) {
  if (!a || !b) return Infinity;
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function relationKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function rankHelpers(recipient, colony, graph, dynamics, gameTime) {
  const byId = new Map((colony.citizens || []).map((c) => [c.id, c]));
  const ranked = [];
  for (const edge of Object.values(graph.edges || {})) {
    if (edge.a !== recipient.id && edge.b !== recipient.id) continue;
    const helperId = edge.a === recipient.id ? edge.b : edge.a;
    const helper = byId.get(helperId);
    const helperState = dynamics.citizens[String(helperId)];
    if (!helper || helper.isChild || !helper.position || !helperState || !helperState.active) continue;
    if (helper.sick || liveNutritionBand(helper) === "starving") continue;
    const requesterView = D.effectivePerspective(
      D.perspectiveFor(dynamics, recipient.id, helperId),
      gameTime == null ? colony.gameTime : gameTime
    ) || {};
    const affect = requesterView.affect || {};
    const family = (edge.sources || []).some((x) => ["partner", "parent_child", "sibling"].includes(x));
    const score = 0.4 * (requesterView.trust == null ? 0.5 : requesterView.trust) +
      0.3 * (edge.familiarity || 0) + 0.2 * (family ? 1 : 0) +
      0.1 * ((affect.gratitude || 0) - (affect.resentment || 0));
    ranked.push({
      helper,
      edge,
      score: Math.round(score * 1000) / 1000,
      distance: distance(helper.position, recipient.position),
    });
  }
  return ranked.sort((a, b) => b.score - a.score || a.distance - b.distance || a.helper.id - b.helper.id);
}

function selectFood(inventory, recipientInventory) {
  const counts = new Map((inventory.items || []).map((x) => [x.item, x.count]));
  const recipientCounts = new Map(((recipientInventory && recipientInventory.items) || [])
    .map((x) => [x.item, x.count]));
  // Keep one item in the helper's possession so helping never consumes their
  // final meal. Prefer a meal absent from the recipient's inventory: the
  // MineColonies food-history rule rewards variety, so social help should not
  // hand over a duplicate when a novel dinner is available.
  return FOOD_ITEMS.filter((item) => (counts.get(item) || 0) >= 2)
    .sort((a, b) => (recipientCounts.get(a) || 0) - (recipientCounts.get(b) || 0) ||
      FOOD_ITEMS.indexOf(a) - FOOD_ITEMS.indexOf(b))[0] || null;
}

async function request(method, route) {
  const response = await fetch(`${BRIDGE}${route}`, { method });
  const text = await response.text();
  if (!response.ok) throw new Error(`${route} HTTP ${response.status}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

async function fetchColony() {
  const colonies = await request("GET", "/status");
  const colony = colonies.find((x) => x.id === COLONY_ID) || colonies[0];
  if (!colony) throw new Error("no colony in /status");
  return colony;
}

async function fetchInventory(citizenId) {
  return request("GET", `/citizenInventory?colonyId=${COLONY_ID}&citizenId=${citizenId}`);
}

async function waitForMove(citizenId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await request("GET", `/moveCitizen?colonyId=${COLONY_ID}&citizenId=${citizenId}`);
    if (status.status === "arrived") return status;
    if (["timeout", "lost", "replaced"].includes(status.status)) {
      throw new Error(`move ended with ${status.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("move wait timed out");
}

async function executeHelp(helper, recipient, item, opts) {
  const o = opts || {};
  const getColony = o.fetchColony || fetchColony;
  const call = o.request || request;
  const sleep = o.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = o.nowMs || Date.now;
  const timeoutMs = o.timeoutMs || PURSUIT_TIMEOUT_MS;
  const pollMs = o.pollMs || PURSUIT_POLL_MS;
  const retargetMs = o.retargetMs || PURSUIT_RETARGET_MS;
  const maxDistance = o.maxDistance || TRANSFER_DISTANCE;
  const deadline = now() + timeoutMs;
  let nextRetarget = 0;
  let lastError = null;
  while (now() < deadline) {
    const latest = await getColony();
    const currentHelper = latest.citizens.find((x) => x.id === helper.id);
    const currentRecipient = latest.citizens.find((x) => x.id === recipient.id);
    if (!currentHelper || !currentHelper.position) throw new Error("helper has no live position");
    if (!currentRecipient || !currentRecipient.position) throw new Error("recipient has no live position");

    // Transfer as soon as the live positions overlap. Waiting for an arrival
    // at the recipient's old position loses the target at accelerated tickrate.
    if (distance(currentHelper.position, currentRecipient.position) <= maxDistance) {
      try {
        return await call("POST", `/transferCitizenItem?colonyId=${COLONY_ID}` +
          `&fromCitizenId=${helper.id}&toCitizenId=${recipient.id}` +
          `&item=${encodeURIComponent(item)}&count=1&maxDistance=${maxDistance}`);
      } catch (error) {
        lastError = error;
        if (!String(error.message || error).includes("blocks apart")) throw error;
      }
    }

    if (now() >= nextRetarget) {
      await call("POST", `/moveCitizen?colonyId=${COLONY_ID}&citizenId=${helper.id}` +
        `&x=${currentRecipient.position.x}&y=${currentRecipient.position.y}&z=${currentRecipient.position.z}` +
        `&range=3&timeout=1200`);
      nextRetarget = now() + retargetMs;
    }
    await sleep(pollMs);
  }
  throw lastError || new Error("help pursuit timed out before citizens met");
}

async function runCycle(opts) {
  const o = opts || {};
  const colony = o.colony || await fetchColony();
  const personas = o.personas || P.loadAll();
  const graph = o.graph || S.loadGraph();
  const dynamics = o.dynamics || D.loadState();
  const runtime = o.runtime || loadRuntime(o.runtimeFile);
  if (!graph || !dynamics) throw new Error("social graph/dynamics baseline missing");
  const nodes = graph.nodes || {};
  const recipients = (colony.citizens || []).filter((c) => {
    const node = nodes[String(c.id)];
    const last = runtime.lastRequestGameTime[String(c.id)];
    const cooled = last == null || colony.gameTime - last >= (o.cooldownTicks || COOLDOWN_TICKS);
    const selectedRecipient = (o.recipientId == null ? RECIPIENT_ID : o.recipientId);
    return (selectedRecipient == null || c.id === selectedRecipient) && c.position && node &&
      isNeedy({ ...c, nutritionBand: liveNutritionBand(c) }, o.needBand || NEED_BAND) && cooled;
  }).sort((a, b) => a.saturation - b.saturation || a.id - b.id);
  if (!recipients.length) return { status: "no-need" };

  const recipient = recipients[0];
  const selectedHelper = o.helperId == null ? HELPER_ID : o.helperId;
  const ranked = rankHelpers(recipient, colony, graph, dynamics, colony.gameTime)
    .filter((x) => selectedHelper == null || x.helper.id === selectedHelper);
  if (!ranked.length) return { status: "no-helper", recipientId: recipient.id };
  const candidate = ranked[0];
  const helper = candidate.helper;
  const getInventory = o.fetchInventory || fetchInventory;
  const inventory = await getInventory(helper.id);
  const recipientInventory = await getInventory(recipient.id);
  const item = selectFood(inventory, recipientInventory);
  const helperPersona = P.get(personas, helper.id);
  const helperState = {
    ...(dynamics.citizens[String(helper.id)] || {}),
    nutritionBand: liveNutritionBand(helper),
    sick: !!helper.sick,
  };
  const recipientState = {
    ...(dynamics.citizens[String(recipient.id)] || {}),
    nutritionBand: liveNutritionBand(recipient),
    sick: !!recipient.sick,
  };
  const appraisalModel = o.appraisalModel || APPRAISAL_MODEL;
  const engine = appraisalModel === "v1" ? A1 : appraisalModel === "v2" ? A2 : null;
  if (!engine) throw new Error(`unknown appraisal model ${appraisalModel}`);
  const decision = engine.decideHelp({
    helperPersona,
    helperState,
    recipientState,
    helperPerspective: D.effectivePerspective(
      D.perspectiveFor(dynamics, helper.id, recipient.id), colony.gameTime
    ),
    sources: candidate.edge.sources,
    familiarity: candidate.edge.familiarity,
    distance: candidate.distance,
    resourceAvailable: !!item,
  }, {
    mode: o.decisionMode || process.env.SOCIAL_HELP_DECISION_MODE,
    seed: `${colony.id}:${Math.floor(colony.gameTime / 1200)}:${helper.id}:${recipient.id}`,
  });
  const requestId = `${colony.id}-${colony.gameTime}-${recipient.id}-${helper.id}`;
  const base = {
    requestId, gameTime: colony.gameTime,
    helperId: helper.id, helperName: helper.name,
    recipientId: recipient.id, recipientName: recipient.name,
    item, candidateRankScore: candidate.score,
    appraisalModel: decision.appraisal.model,
  };
  appendLog("help_decided", { ...base, decision }, o.eventFile, o.now);

  const execute = Object.hasOwn(o, "execute") ? o.execute : EXECUTE;
  if (!execute) return { status: "shadow", ...base, selected: decision.selected };
  if (!item) {
    runtime.lastRequestGameTime[String(recipient.id)] = colony.gameTime;
    saveRuntime(runtime, o.runtimeFile);
    appendLog("help_unable", { ...base, reason: "no-transferable-resource" }, o.eventFile, o.now);
    return { status: "unable", ...base };
  }
  if (decision.selected === "refuse") {
    runtime.lastRequestGameTime[String(recipient.id)] = colony.gameTime;
    saveRuntime(runtime, o.runtimeFile);
    Q.appendAction({ type: "help_refused", ...base }, o.actionFile, o.now);
    appendLog("help_refused", base, o.eventFile, o.now);
    return { status: "refused", ...base };
  }
  try {
    const result = o.executeHelp ? await o.executeHelp(helper, recipient, item) :
      await executeHelp(helper, recipient, item);
    runtime.lastRequestGameTime[String(recipient.id)] = colony.gameTime;
    saveRuntime(runtime, o.runtimeFile);
    Q.appendAction({ type: "help_succeeded", ...base }, o.actionFile, o.now);
    appendLog("help_succeeded", { ...base, result }, o.eventFile, o.now);
    return { status: "succeeded", ...base, result };
  } catch (error) {
    appendLog("help_failed", { ...base, error: String(error.message || error) }, o.eventFile, o.now);
    return { status: "failed", ...base, error: String(error.message || error) };
  }
}

function acquirePidfile() {
  try {
    const old = parseInt(fs.readFileSync(PID_FILE, "utf8"), 10);
    if (old) {
      try { process.kill(old, 0); throw new Error(`social_help already running (pid ${old})`); }
      catch (error) { if (String(error.message).startsWith("social_help already")) throw error; }
    }
  } catch (error) {
    if (String(error.message).startsWith("social_help already")) throw error;
  }
  fs.writeFileSync(PID_FILE, String(process.pid));
  const cleanup = () => { try { if (fs.readFileSync(PID_FILE, "utf8") === String(process.pid)) fs.unlinkSync(PID_FILE); } catch {} };
  process.on("exit", cleanup);
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}

async function main() {
  acquirePidfile();
  appendLog("start", {
    execute: EXECUTE, pollMs: POLL_MS, needBand: NEED_BAND,
    appraisalModel: APPRAISAL_MODEL,
  });
  const once = process.argv.includes("--once");
  do {
    try {
      const outcome = await runCycle();
      if (["no-need", "no-helper"].includes(outcome.status)) {
        appendLog("cycle_idle", outcome);
      }
    } catch (error) { appendLog("error", { error: String(error.stack || error) }); }
    if (!once) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  } while (!once);
}

module.exports = {
  isNeedy, liveNutritionBand, rankHelpers, selectFood,
  runCycle, executeHelp, loadRuntime, saveRuntime,
};

if (require.main === module) main().catch((error) => { appendLog("fatal", { error: String(error.stack || error) }); process.exit(1); });
