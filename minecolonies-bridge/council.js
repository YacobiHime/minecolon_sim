// Multi-agent MineColonies "council" experiment, in the spirit of the
// original Voyager scripts (village.js etc.) where several LLM personas
// talk to each other in Japanese while doing a task - except here nobody
// connects to Minecraft as a bot (mineflayer can't, see README.md). Instead:
//   - A handful of GOVERNOR personas take turns deciding colony actions
//     (place/found/requestBuild/giveToCitizen/...) via the Voyager Bridge
//     HTTP API, and chat about their reasoning.
//   - Each real MineColonies citizen periodically gets a short, in-character
//     line of dialogue generated from their actual game state (job, open
//     requests) - flavor only, no game action.
// Both kinds of lines are broadcast into the real Minecraft chat via the
// server console (so a human watching in-game sees the whole conversation),
// by writing "say <name>: <message>" into the server's cmd_pipe.
const http = require("http");
const fs = require("fs");
const path = require("path");

// Load building registry once at startup and pre-render as a compact table
// so every governor's system prompt has the exact block IDs and blueprint
// paths without guessing.
const BUILDING_REGISTRY = JSON.parse(
  fs.readFileSync(path.join(__dirname, "building_registry.json"), "utf8")
);
// Per-building upgrade-effect knowledge (what actually improves: capacity,
// throughput, slots, unlocks). Small models can't infer this, so it is
// embedded directly into the candidate labels the governor picks from.
const BUILDING_KNOWLEDGE = JSON.parse(
  fs.readFileSync(path.join(__dirname, "building_knowledge.json"), "utf8")
);
function upgradeEffect(buildingType) {
  const key = String(buildingType).replace(/^blockhut/, "");
  const know = BUILDING_KNOWLEDGE[key];
  return know && know.upgrade ? know.upgrade : "";
}
function buildingTable() {
  const rows = Object.entries(BUILDING_REGISTRY)
    .filter(([, v]) => v.blueprint !== null)
    .map(([key, v]) => `${v.block}|${v.blueprint}|${v.job}|${v.role}`);
  return (
    "block_id|blueprint_path(Colonial)|職業名|役割\n" +
    rows.join("\n")
  );
}

// Mayor "constitution" prompts are externalized to prompts/*.md so the
// strategy priorities, status-reading rules and colony mechanics can be
// tuned without editing JS logic. {{NAME}}/{{ROLE}}/{{PERSONALITY}}/{{OTHERS}}
// are substituted per governor; {{JOB_DESCRIPTIONS}} is filled from the
// building registry. See the mayor-system skill for the design rationale.
const GOVERNOR_PROMPT_TEMPLATE = fs.readFileSync(
  path.join(__dirname, "prompts", "governor_system.md"), "utf8"
);
const CITIZEN_VOICE_TEMPLATE = fs.readFileSync(
  path.join(__dirname, "prompts", "citizen_voice.md"), "utf8"
);

// LLM backend: local ollama on the lab server (OpenAI-compatible
// /v1/chat/completions, no auth, no usage cost). Switched from OpenRouter
// (2026-07-03) after its credit balance ran out - even the ~19k-token input
// prompt alone exceeded the remaining allowance.
const LLM_HOST = process.env.LLM_HOST || "192.168.15.150";
const LLM_PORT = parseInt(process.env.LLM_PORT || "11434", 10);
const MODEL = process.env.LLM_MODEL || "gemma4:e4b";
const BRIDGE_HOST = "localhost";
const BRIDGE_PORT = 8089;
// Keep the console pipe configurable because the server location differs
// between deployments.  The current mine-server installation lives under
// mine-admin's home directory.
const CMD_PIPE = process.env.CMD_PIPE || "/home/mine-admin/mc-server-forge/cmd_pipe";
const COLONY_ID = parseInt(process.env.COLONY_ID || "1", 10);
// Infinity = resident daemon. The 300-cycle cap predates the colony_watch
// supervisor; with the cap, council exited every ~75min and the watch's
// auto-restart fired a notification each time. Now a council death is an
// actual anomaly worth reporting, not scheduled churn.
const MAX_CYCLES = Infinity;
const TURN_DELAY_MS = 2000;
// With the local ollama backend there is no per-token cost, so the old
// economy mode (60s cycles, citizen voice 1-in-3) is relaxed: the cycle pace
// now just tracks how fast the colony state actually changes.
const CYCLE_DELAY_MS = 15000;
const CITIZEN_VOICE_EVERY = 1;

// env で上書き可。未設定時は、スポーン地点からすぐ観察できる原点を使う。
const ANCHOR = {
  x: parseInt(process.env.ANCHOR_X ?? "0", 10),
  y: parseInt(process.env.ANCHOR_Y ?? "-60", 10),
  z: parseInt(process.env.ANCHOR_Z ?? "0", 10),
};

const GOVERNORS = [
  {
    name: "Aldric",
    role: "都市計画担当",
    personality: "実利主義で、効率と拡張を最優先する。慎重派の同僚にイライラしがち。",
  },
  {
    name: "Mira",
    role: "民政担当",
    personality: "市民の暮らしや資材不足を気にかける。慎重で、無理な拡張には異議を唱える。",
  },
];

// Shared, cross-governor memory.  A governor's private `history` only contains
// its own previous turns, so this log is the causal bridge between agents: it
// carries both what everybody said and what the governors actually did.
// Keep it bounded because council.js normally runs as a resident daemon.
const sharedChatLog = [];
const SHARED_LOG_LIMIT = 80;

function rememberSharedEvent(event) {
  sharedChatLog.push({ ...event, t: event.t || Date.now() });
  if (sharedChatLog.length > SHARED_LOG_LIMIT) {
    sharedChatLog.splice(0, sharedChatLog.length - SHARED_LOG_LIMIT);
  }
}

function renderSharedCouncilContext(events = sharedChatLog, limit = 12) {
  const recent = events.slice(-limit);
  if (recent.length === 0) return "（まだ会話なし）";
  return recent.map((event) => {
    if (event.kind === "action") {
      const outcome = event.effective === false ? `INEFFECTIVE(${event.status})` : event.status;
      return `${event.who}の行動: ${event.label} -> ${outcome} ${event.result || ""}`.trim();
    }
    return `${event.who}: ${event.text}`;
  }).join(" | ");
}

function actionKey(action) {
  return JSON.stringify(action);
}

// A bridge endpoint can return HTTP 200 while reporting that no state change
// occurred (for example a blueprint that did not become pending).  Letting the
// same stale candidate remain at priority 1 traps both governors in a loop.
// Remove only actions whose *latest* shared result was ineffective; `wait` is
// retained as a safe fallback. A changed live candidate naturally gets a new
// key and becomes available immediately.
function filterRecentlyIneffectiveCandidates(candidates, events = sharedChatLog, limit = 12) {
  const latest = new Map();
  for (const event of events.slice(-limit).reverse()) {
    if (event.kind !== "action" || !event.action) continue;
    const key = actionKey(event.action);
    if (!latest.has(key)) latest.set(key, event.effective !== false);
  }
  return candidates.filter((candidate) => {
    if (candidate.action?.action === "wait") return true;
    return latest.get(actionKey(candidate.action)) !== false;
  });
}

function actionResultWasEffective(res) {
  if (res.status < 200 || res.status >= 300) return false;
  return !/\[WARN:\s*not pending after requestUpgrade/i.test(String(res.body));
}

function sayInGame(name, message) {
  const safe = String(message).replace(/"/g, "'").slice(0, 200);
  rememberSharedEvent({ kind: "speech", who: name, text: safe });
  try {
    // O_NONBLOCK: if the server isn't reading from cmd_pipe (no reader on the
    // FIFO), writeFileSync blocks forever. Non-blocking open throws ENXIO
    // immediately instead, so the council loop doesn't hang.
    const fd = fs.openSync(CMD_PIPE, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    fs.writeSync(fd, `say ${name}: ${safe}\n`);
    fs.closeSync(fd);
  } catch (e) {
    console.log(`[chat write failed] ${name}: ${safe} (${e.message})`);
  }
  console.log(`[CHAT] ${name}: ${safe}`);
}

function httpRequest(method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: BRIDGE_HOST, port: BRIDGE_PORT, path, method }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.end();
  });
}

// Scan for the first syntactically complete JSON object in text.
// The greedy /\{[\s\S]*\}/ regex breaks when the LLM appends explanation
// text after the JSON (common with markdown code fences + reasoning notes)
// because it stretches to the last } in the entire string.
function extractFirstJSON(text) {
  // Strip markdown code fence if present: ```json ... ``` or ``` ... ```
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  // Otherwise find the first { and walk braces to find its matching }.
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0, inString = false, escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\" && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") { if (--depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

// Structured-output schema for governor turns, enforced by ollama's
// schema-constrained decoding. gemma-class models can't reliably construct
// free-form action JSON (they invent action names and coordinates), so the
// governor picks a numbered choice from a menu that buildCandidates()
// derives from the live /status - every candidate already carries exact,
// valid parameters.
const GOVERNOR_REPLY_SCHEMA = {
  type: "object",
  properties: {
    say: { type: "string", maxLength: 40 },
    choice: { type: "integer" },
  },
  required: ["say", "choice"],
};

// Residence lvN sleeps N citizens, the tavern sleeps 4.
function housingCapacity(colony) {
  return (colony.buildings || []).reduce((cap, b) => {
    if (!b.operational) return cap;
    if (b.type === "blockhutcitizen") return cap + b.level;
    if (b.type === "blockhuttavern") return cap + 4;
    return cap;
  }, 0);
}

// Research requirements name a building as "minecolonies:<schematic>". Every
// name already equals the blockhut<name> key used elsewhere in the menu EXCEPT
// the residence: research calls it "residence" but its hut block is
// blockhutcitizen (key "citizen"). Alias it so a residence-level research
// prerequisite (e.g. outpost=residence4, hamlet=residence5) matches the
// residence upgrade candidate. Verified against the mod's research data
// (2026-07-12): residence is the only mismatch among ~30 requirement buildings.
const RESEARCH_BUILDING_ALIAS = { residence: "citizen" };

// Map of buildingKey -> {research, level} for start-imminent researches whose
// ONLY unmet requirement(s) are building levels (from /research "blocked").
// "blocked" already implies canResearch = parent complete AND depth <=
// university level, so these are the researches the University could start next
// if the prerequisite building were tall enough. Drives both the "upgrading
// this also unlocks research X" label and the research-prerequisite pin.
async function getResearchNeeds() {
  try {
    const res = await httpRequest("GET", `/research?colonyId=${COLONY_ID}`);
    if (res.status !== 200) return {};
    const d = JSON.parse(res.body);
    const map = {};
    for (const blk of d.blocked || []) {
      const reqs = blk.requirements || [];
      // Skip researches that also need something non-building (alternate-building
      // etc.): upgrading a building alone wouldn't start them, so pinning that
      // upgrade would mislead the mayor. Non-building requirements arrive without
      // a "building" field (the bridge emits "desc" for them instead).
      if (reqs.some((n) => !n.met && !n.building)) continue;
      for (const need of reqs) {
        if (need.met || !need.building) continue;
        const raw = need.building.split(":").pop().replace(/^blockhut/, "");
        const key = RESEARCH_BUILDING_ALIAS[raw] || raw;
        const research = blk.id.split("/").pop();
        // Keep the nearest (lowest) required level, so the label/pin always aim
        // at the next research this building would unlock, not a distant one.
        if (!map[key] || need.level < map[key].level) {
          map[key] = { research, level: need.level };
        }
      }
    }
    return map;
  } catch {
    return {};
  }
}

// Enumerate every action that makes sense against the current status.
// Index 0 is always wait so an out-of-range choice degrades to a no-op.
// Read the demand signal supply_bot publishes (item shortfalls mapped to the
// producer buildings that would relieve them). Reloaded every turn so the
// mayor's build priorities track live consumption.
function readDemand() {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(__dirname, "demand.json"), "utf8"));
    const rank = {};
    (d.buildingPriority || []).forEach((b, i) => {
      rank[b.building] = { rank: i + 1, score: b.score };
    });
    return { rank, top: d.buildingPriority || [] };
  } catch {
    return { rank: {}, top: [] };
  }
}

// Count targets = "how much to build", tied to progression. Most buildings are
// singletons (target 1); these scale. pop and building-count grow with town-hall
// level, so they track progression indirectly. Crafters scale only while
// demand.json flags their output short. (house/residence keeps its own
// pop>housing path.) Numbers set with the user 2026-07-11 - easy to tune here.
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const SCALE_RULES = {
  builder:     (c) => clamp(4 + Math.floor(c.totalBuildings / 15), 4, 6), // 初期4→上限6
  deliveryman: (c) => clamp(3 + Math.floor(c.totalBuildings / 15), 3, 5), // 初期3→上限5
  farmer:      (c) => 4,
  fisherman:   (c) => 1,
  lumberjack:  (c) => clamp(1 + Math.floor(c.pop / 12), 1, 3),
  miner:       (c) => clamp(1 + Math.floor(c.pop / 12), 1, 3),
  // crafters: base 1, +1 while their output is a flagged shortage (demand.json)
  sawmill:     (c) => 1 + (c.demandHot.has("sawmill") ? 1 : 0),
  smeltery:    (c) => 1 + (c.demandHot.has("smeltery") ? 1 : 0),
  stonemason:  (c) => 1 + (c.demandHot.has("stonemason") ? 1 : 0),
};
const targetCount = (regKey, ctx) => (SCALE_RULES[regKey] ? SCALE_RULES[regKey](ctx) : 1);

// Buildings whose CONSTRUCTION is gated behind completed University research.
// Mirror of RESEARCH_GATED_BUILDINGS in the bridge Java (VoyagerBridge.java,
// the source of truth) - the same static list drives both the /status
// "researchUnlocked" array and requestBuild's "requires university research"
// rejection. A gated type is placeable iff its path appears in
// colony.researchUnlocked (bridge only lists a gated type there once its
// unlock-effect strength > 0). Non-gated types are always placeable. Keeping
// this list in sync with the Java is required whenever that set changes.
const RESEARCH_GATED_BUILDINGS = new Set([
  "blockhutalchemist", "blockhutarchery", "blockhutbarracks",
  "blockhutblacksmith", "blockhutcombatacademy", "blockhutcomposter",
  "blockhutconcretemixer", "blockhutcrusher", "blockhutdyer",
  "blockhutenchanter", "blockhutfletcher", "blockhutflorist",
  "blockhutglassblower", "blockhutgraveyard", "blockhuthospital",
  "blockhutlibrary", "blockhutmechanic", "blockhutmysticalsite",
  "blockhutnetherworker", "blockhutplantation", "blockhutsawmill",
  "blockhutschool", "blockhutsifter", "blockhutsmeltery",
  "blockhutstonemason", "blockhutstonesmeltery",
]);

function buildCandidates(status, researchNeeds = {}, demandRank = {}) {
  const candidates = [{ label: "wait(様子見。建設中で他にやることがない時のみ)", action: { action: "wait" } }];
  // Set when some wanted building can't be placed/built yet because its
  // University research is incomplete; read after the colony block to drive
  // University-first pinning.
  let researchBlockedPending = false;
  // Set when workplaces outnumber citizens (unfilled job slots) so the
  // population levers get pinned to the front of the menu; read after the
  // colony block alongside researchBlockedPending.
  let populationNeeded = false;
  const colony = status[0];
  if (colony) {
    // Only offer the spawn cheat while there are free beds - gemma otherwise
    // picks it every single turn and the population runs away past housing.
    const housing = housingCapacity(colony);
    const pop = (colony.citizens || []).length;
    // Population should track the number of job slots the colony has built, so
    // workplaces don't sit worker-less (user 2026-07-12: "職場が増える毎に+1人").
    // Count operational job-providing buildings (~1 worker each; exclude the town
    // hall and residences). Housing is then driven to stay a bit ahead of this
    // target so citizens can be recruited/spawned to fill the jobs.
    const jobBuildings = (colony.buildings || []).filter(
      (b) => b.operational && b.type !== "blockhuttownhall" && b.type !== "blockhutcitizen"
    ).length;
    const targetPop = jobBuildings + 2; // small buffer for builder/courier churn
    // Population balance: every residence built OR upgraded adds a citizen, so
    // housing growth IS population growth. When too many are already jobless,
    // freeze all population levers (spawn, new residence, residence upgrade) -
    // the mayor should build WORKPLACES to absorb the surplus first, then
    // housing unfreezes. Without this, housing runs ahead of jobs indefinitely.
    const unemployedCount = (colony.citizens || []).filter(
      (c) => c.job === "unemployed" || !c.job
    ).length;
    const HOUSING_UNEMPLOYMENT_CAP = 12;
    const housingFrozen = unemployedCount > HOUSING_UNEMPLOYMENT_CAP;
    // Unfilled job slots: operational workplaces (jobBuildings) minus people.
    // Only a genuine head-count shortfall counts - unemployed citizens auto-hire
    // into empty workplaces, so pop<jobBuildings is the real "need more people"
    // signal (user 2026-07-12: 就ける職場があるのに住民が足りないなら住民増を最優先).
    // Frozen (jobless surplus high) => it's an assignment problem, not a pop one.
    const unfilledJobs = Math.max(0, jobBuildings - pop);
    populationNeeded = unfilledJobs > 0 && !housingFrozen;
    if (pop < housing && !housingFrozen) {
      candidates.push({
        label: `spawnCitizen(市民を1人追加。住居容量 ${housing} に空きあり)`,
        action: { action: "spawnCitizen", colonyId: COLONY_ID },
        pop: true,
      });
    }
    // A building can only be upgraded to a level some operational builder hut
    // already has (the hut itself may self-upgrade one level ahead). Doomed
    // upgrade candidates are filtered out entirely - the model otherwise keeps
    // picking them and collecting level-gate errors.
    // Research placement gate (user 2026-07-12): stop the mayor placing
    // research-locked buildings (sawmill/stonemason/blacksmith/hospital/...)
    // that requestBuild then refuses with "requires university research",
    // leaving empty shells and idle builders. colony.researchUnlocked lists
    // the gated types whose unlock research the bridge has confirmed complete
    // (effect strength > 0); any other gated type is currently unplaceable.
    // researchBlockedPending records that something WOULD be built but for a
    // missing research, which drives University-first below. (Missing field =>
    // empty set => gated types held back; requires the bridge that emits
    // researchUnlocked, already deployed.)
    const researchUnlocked = new Set(colony.researchUnlocked || []);
    const researchLocked = (block) => {
      const p = String(block).replace(/^minecolonies:/, "");
      return RESEARCH_GATED_BUILDINGS.has(p) && !researchUnlocked.has(p);
    };
    const buildings = colony.buildings || [];
    const maxBuilderLevel = Math.max(
      0,
      ...buildings.filter((b) => b.type === "blockhutbuilder" && b.operational).map((b) => b.level)
    );
    const operationalBuilders = buildings.filter(
      (b) => b.type === "blockhutbuilder" && b.operational
    );
    const builderCanReach = (target) => operationalBuilders.some((builder) => {
      const dx = Number(builder.x) - Number(target.x);
      const dy = Number(builder.y) - Number(target.y);
      const dz = Number(builder.z) - Number(target.z);
      return dx * dx + dy * dy + dz * dz <= 100 * 100;
    });
    // Progression = town-hall level (MineColonies: buildings can't exceed it, it
    // caps colony size, gates research). It is the axis for "how much" (count)
    // and "how deep" (level) targets.
    const townHallLevel = buildings.find((b) => b.type === "blockhuttownhall")?.level ?? 0;
    const countByType = {};
    for (const b of buildings) {
      const k = String(b.type).replace(/^blockhut/, "");
      countByType[k] = (countByType[k] || 0) + 1;
    }
    // Pace gate for the town hall (below): it may only advance once the current
    // stage is fully built. Research-locked empty shells are EXCLUDED - they are
    // waiting on University research (never buildable now), so counting them
    // would freeze town-hall progression forever and deadlock the whole colony
    // at lv1 (user 2026-07-12 req 3). Only placeable-now unbuilt shells pace it.
    const unbuiltPlaceableCount = buildings.filter(
      (b) => !b.operational && b.level === 0 && !researchLocked(b.type)
    ).length;
    const scaleCtx = {
      pop,
      totalBuildings: buildings.length,
      demandHot: new Set(Object.keys(demandRank)),
    };
    // Backlog governor. The menu offered construction every cycle regardless
    // of the queue, and gemma happily picked one each time - 130 queued work
    // orders / 38 alchemists / 65 houses by the time it was caught
    // (2026-07-06). While the queue is deeper than the builders can chew,
    // construction options disappear from the menu entirely.
    const pendingCount = buildings.filter((b) => b.pending).length;
    const builderCount = Math.max(1, buildings.filter((b) => b.type === "blockhutbuilder" && b.operational).length);
    const backlogFull = pendingCount >= builderCount * 3;
    // A placed level-0 hut is already construction backlog even before it has
    // a Work Order. Do not place another building until each buildable shell
    // has at least been submitted. The old pending-only gate let the mayor
    // place one of every type while pending stayed false.
    const awaitingBuildOrder = buildings.some(
      (b) => !b.operational && b.level === 0 && !b.pending &&
        b.inTerritory && !researchLocked(b.type) &&
        (operationalBuilders.length === 0 || builderCanReach(b))
    );
    for (const b of buildings) {
      if (backlogFull) break;
      if (b.pending || !b.inTerritory) continue;
      if (!b.operational) {
        // Research-locked shell: requestBuild would just error. Don't offer it
        // (and flag the block so University gets prioritized to unlock it).
        if (researchLocked(b.type)) { researchBlockedPending = true; continue; }
        // The Bridge remains the source of truth and still rejects out-of-range
        // builds. Filtering the same known-invalid choice here prevents the LLM
        // from spending every turn retrying it. With no operational builder we
        // fail open so bootstrap behavior remains available.
        if (operationalBuilders.length > 0 && !builderCanReach(b)) continue;
        candidates.push({
          label: `requestBuild ${b.type} @(${b.x},${b.y},${b.z}) 未着工→着工させる(重要)`,
          action: { action: "requestBuild", x: b.x, y: b.y, z: b.z },
        });
      } else if (b.type === "blockhutcitizen" && housingFrozen) {
        // residence upgrade adds a citizen; skip while jobless surplus is high
        continue;
      } else if (
        // Leapfrog progression (user 2026-07-12). MineColonies requires a
        // Builder's Hut one level AHEAD of the town hall before the town hall can
        // advance (bridge-verified: townhall lv1->2 needs a builder hut lv2, and
        // a builder hut CAN self-upgrade one level past the town hall). So:
        // - builder: may lead the town hall by one level -> min(townHall+1, max).
        //   This is the seed: at townHall lv1 the mayor can still order builder
        //   lv1->2, which raises maxBuilderLevel and unblocks the town hall.
        // - town hall: gated by maxBuilderLevel (needs a builder already at
        //   level+1) AND by pace (current stage fully built, research-locked
        //   shells excluded). Emitting it only once buildable avoids dead orders.
        // - others: capped at the town-hall level and by an operational builder
        //   that can already reach the next level.
        // Order guaranteed: builder->lv2, then townhall->lv2, then others->lv2,
        // then builder->lv3, ... the leapfrog cycle, mayor-driven end to end.
        b.type === "blockhuttownhall"
          ? (
              b.level + 1 <= maxBuilderLevel &&
              unbuiltPlaceableCount === 0 &&
              b.level < (b.maxLevel ?? 5)
            )
          : b.type === "blockhutbuilder"
            ? b.level < Math.min(townHallLevel + 1, b.maxLevel ?? 5)
            : (
                b.level < Math.min(townHallLevel, b.maxLevel ?? 5) &&
                b.level + 1 <= maxBuilderLevel
              )
      ) {
        // maxLevel comes from /status (building.getMaxBuildingLevel()) - e.g.
        // Colonial tavern caps at 3, postbox at 1; offering those upgrades
        // wasted mayor turns on silent no-ops.
        // level 5 is the MineColonies max; requestUpgrade silently no-ops there
        const effect = upgradeEffect(b.type);
        const key = b.type.replace(/^blockhut/, "");
        const rn = researchNeeds[key];
        // This upgrade satisfies a research building-level prerequisite while the
        // building is still below the required level - flag it so the pin below
        // can lift it out of the shuffle (user 2026-07-12 req 1).
        const isResearchPrereq = !!(rn && b.level < rn.level);
        const unlock = isResearchPrereq
          ? `(さらに lv${rn.level} で研究「${rn.research}」が解禁される)` : "";
        const dem = demandRank[key];
        const demand = dem ? `【需要↑ ${dem.rank}位: この生産を増強すべき】` : "";
        candidates.push({
          label: `requestBuild ${b.type} @(${b.x},${b.y},${b.z}) lv${b.level}→lv${b.level + 1}にアップグレード${effect ? "(効果: " + effect + ")" : ""}${unlock}${demand}`,
          action: { action: "requestBuild", x: b.x, y: b.y, z: b.z },
          // Residence lv+1 = +1 bed, tavern lv+1 = +4 beds: both raise the
          // population ceiling, so mark them as population levers to be pinned.
          pop: b.type === "blockhutcitizen" || b.type === "blockhuttavern",
          // Existing-building upgrade (lv->lv+1); upgradeType drives the
          // builder-first ordering of the idle fallback pin below.
          upgrade: true,
          upgradeType: b.type,
          researchPrereq: isResearchPrereq,
        });
      }
    }
    // Build housing proactively until capacity reaches the job-driven target,
    // not just when population already overflows - otherwise pop lags the job
    // slots and workplaces stay empty. Freeze still applies when too many are
    // jobless (housing running ahead of actually-filled jobs).
    if (housing < targetPop && !backlogFull && !awaitingBuildOrder && !housingFrozen) {
      candidates.push({
        label: `placeNext minecolonies:blockhutcitizen(住居の新設。容量${housing}<目標${targetPop}[就労建物${jobBuildings}]なので最優先級)`,
        action: { action: "placeNext", block: "minecolonies:blockhutcitizen" },
        pop: true,
      });
    }
    // New buildings: what to place, in priority order. Two gates combine:
    //  - tier (1=foundation..4=luxury/military): only surface the LOWEST tier
    //    that still has an unmet target, so essentials come before a rabbit hutch.
    //  - count target (targetCount): most buildings are singletons, a few scale
    //    with progression (builder/deliveryman/food/resource) or demand (crafters).
    // A type is "wanted" when its placed count is below its target. citizen
    // (housing) has its own pop>housing path above and is excluded here.
    // (Before this, every unbuilt type was an equal shuffled option, so gemma
    // placed luxury buildings as readily as farms - 2026-07-11.)
    if (!backlogFull && !awaitingBuildOrder) {
      const tierOf = (v) => (typeof v.tier === "number" ? v.tier : 4);
      // "wanted by count" ignoring the research gate - used to detect types the
      // mayor would place if the research were done (drives University-first).
      const wantedByCount = (regKey, v) =>
        v.blueprint !== null &&
        v.block !== "minecolonies:blockhuttownhall" &&
        regKey !== "citizen" &&
        (countByType[regKey] || 0) < targetCount(regKey, scaleCtx);
      // Placeable now = wanted AND not research-locked. activeTier is computed
      // from this set, so a tier isn't considered "filled" by a type that can't
      // actually be placed yet, and locked types never surface as candidates.
      const wanted = (regKey, v) => wantedByCount(regKey, v) && !researchLocked(v.block);
      for (const [regKey, v] of Object.entries(BUILDING_REGISTRY)) {
        if (wantedByCount(regKey, v) && researchLocked(v.block)) { researchBlockedPending = true; break; }
      }
      let activeTier = Infinity;
      for (const [regKey, v] of Object.entries(BUILDING_REGISTRY)) {
        if (wanted(regKey, v) && tierOf(v) < activeTier) activeTier = tierOf(v);
      }
      for (const [regKey, v] of Object.entries(BUILDING_REGISTRY)) {
        if (!wanted(regKey, v)) continue;
        if (tierOf(v) > activeTier) continue; // tier gate: hold back higher tiers
        const have = countByType[regKey] || 0;
        const want = targetCount(regKey, scaleCtx);
        const countTag = want > 1 ? `[${have}/${want}]` : "";
        const rn = researchNeeds[regKey];
        const unlock = rn ? `(建てると研究「${rn.research}」の解禁に近づく)` : "";
        const dem = demandRank[regKey];
        const demand = dem ? `【不足解消 需要↑ ${dem.rank}位】` : "";
        candidates.push({
          label: `placeNext ${v.block}(T${tierOf(v)}${countTag} ${v.job || "-"}: ${(v.role || "").slice(0, 40)}) 新設を配置${unlock}${demand}`,
          action: { action: "placeNext", block: v.block },
          // A new tavern adds 4 beds (population lever), so it can be pinned too.
          pop: v.block === "minecolonies:blockhuttavern",
        });
      }
    }
  }
  // Shuffle everything except wait (index 0). gemma e4b has a strong
  // low-number position bias - it declared "farms first!" while picking
  // choice 3 - and the registry's alphabetical order put the alchemist
  // first among placeNext options every cycle, compounding into 88
  // alchemist placements (2026-07-07 post-mortem). Randomizing the order
  // spreads the bias uniformly so no building type is systematically
  // favored; the dedup/backlog governors bound the damage of any one pick.
  // University-first when research-blocked (user 2026-07-12). When something is
  // stuck waiting on research, pin any University build/upgrade candidate to the
  // front - out of the shuffle and emphatically labeled - so the mayor invests
  // in research slots (concurrent research = University level) instead of
  // placing more empty shells. If no University candidate exists (not yet
  // placeable under the tier gate, or already at cap) this is a no-op.
  // Population-first when workplaces outnumber citizens (user 2026-07-12).
  // Pull every population lever (spawn / new or upgraded residence / new or
  // upgraded tavern) out of the shuffle and pin it to the very front, so beds
  // lead and empty workplaces get staffed. Sits ABOVE the University pin - a
  // worker-less colony can't run research either. Respects housingFrozen
  // (populationNeeded is false when the jobless surplus is high, so a job
  // backlog never triggers more population). No-op if no pop lever qualifies.
  // Research-prerequisite upgrades (user 2026-07-12 req 1). A start-imminent
  // research is stuck only because a building is under-leveled; pin the upgrade
  // that raises it to the required level so research doesn't stall on it. These
  // candidates already passed the level-following gate (min(townHall,
  // maxBuilder)) when created, so pinning only reorders - it never bypasses a
  // gate or invents an upgrade beyond the town-hall level. Sits BELOW the
  // University pin (raising University widens research capacity in general) and
  // ABOVE the idle fallback.
  // Idle fallback (user 2026-07-12 req 2). When nothing new can be placed (no
  // placeNext survived the tier/count/research gates), stop the mayor idling on
  // "wait" and pour effort into upgrading what exists - builder hut FIRST (a
  // higher builder level means faster builds and a higher level cap for every
  // other building), then core buildings, then the rest. When the backlog is
  // full there are no upgrade candidates either, so this is a no-op then.
  let popPinned = [];
  let uniPinned = [];
  let prereqPinned = [];
  let upgradePinned = [];
  let rest = candidates.slice(1);
  if (populationNeeded) {
    const isPop = (c) => c.pop === true;
    popPinned = rest.filter(isPop).map((c) => ({ ...c, label: `【職不足→住民増最優先】${c.label}` }));
    rest = rest.filter((c) => !isPop(c));
  }
  if (researchBlockedPending) {
    const isUni = (c) => typeof c.label === "string" && c.label.includes("blockhutuniversity");
    uniPinned = rest.filter(isUni).map((c) => ({ ...c, label: `【研究待ち→最優先】${c.label}` }));
    rest = rest.filter((c) => !isUni(c));
  }
  {
    const isPrereq = (c) => c.researchPrereq === true;
    prereqPinned = rest.filter(isPrereq).map((c) => ({ ...c, label: `【研究前提→優先】${c.label}` }));
    rest = rest.filter((c) => !isPrereq(c));
  }
  const hasNewBuild = candidates.some((c) => c.action && c.action.action === "placeNext");
  if (!hasNewBuild) {
    const CORE_ORDER = {
      blockhutbuilder: 0, blockhuttownhall: 1, blockhutwarehouse: 2, blockhutuniversity: 3,
    };
    const rank = (c) => (c.upgradeType in CORE_ORDER ? CORE_ORDER[c.upgradeType] : 9);
    upgradePinned = rest
      .filter((c) => c.upgrade === true)
      .sort((a, b) => rank(a) - rank(b))
      .map((c) => ({ ...c, label: `【新規建設なし→アップグレード優先】${c.label}` }));
    rest = rest.filter((c) => c.upgrade !== true);
  }
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return [candidates[0], ...popPinned, ...uniPinned, ...prereqPinned, ...upgradePinned, ...rest];
}

function askLLM(model, messages, { format = null } = {}) {
  return new Promise((resolve, reject) => {
    // ollama native /api/chat, not the OpenAI-compatible /v1 endpoint:
    // - think:false is required - gemma4 otherwise burns the whole token
    //   budget on a "reasoning" field and returns empty content.
    // - format: JSON schema (or "json") for structured turns. Citizen voice
    //   is free-form text and must NOT set it.
    // num_predict caps runaway generations; replies are one short JSON object.
    const body = { model, messages, stream: false, think: false, options: { num_predict: 1000 } };
    if (format) body.format = format;
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: LLM_HOST,
        port: LLM_PORT,
        path: "/api/chat",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            const reply = parsed.message?.content?.trim();
            if (reply) resolve(reply);
            else reject(new Error("No reply: " + data));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function getStatus() {
  const res = await httpRequest("GET", "/status");
  return JSON.parse(res.body);
}

async function getOpenRequests(x, y, z, citizenId) {
  const res = await httpRequest("GET", `/openRequests?x=${x}&y=${y}&z=${z}&citizenId=${citizenId}`);
  try {
    return JSON.parse(res.body);
  } catch {
    return [];
  }
}

// ---------- Governor (council) turn ----------

function buildGovernorSystemPrompt(gov) {
  const others = GOVERNORS.filter((g) => g.name !== gov.name).map((g) => g.name).join(", ");
  return GOVERNOR_PROMPT_TEMPLATE
    .replace(/\{\{NAME\}\}/g, gov.name)
    .replace(/\{\{ROLE\}\}/g, gov.role)
    .replace(/\{\{PERSONALITY\}\}/g, gov.personality)
    .replace(/\{\{OTHERS\}\}/g, others);
}

async function governorTurn(gov, history, status) {
  const researchNeeds = await getResearchNeeds();
  const demand = readDemand();
  const candidates = filterRecentlyIneffectiveCandidates(
    buildCandidates(status, researchNeeds, demand.rank)
  );
  const menu = candidates.map((c, i) => `${i}: ${c.label}`).join("\n");
  // Pre-computed hints: small models don't reliably derive these from the
  // raw status JSON, and the housing deficit drives the top-priority rule.
  const colony = status[0];
  let hint = "";
  if (colony) {
    const cap = housingCapacity(colony);
    const pop = (colony.citizens || []).length;
    const pending = (colony.buildings || []).filter((b) => b.pending).length;
    hint = `\n[HINT] 市民${pop}人/住居容量${cap}人${pop > cap ? ` → 住居が${pop - cap}人分不足!住居の新設/アップグレードを優先` : "(充足)"}、建設中(pending)${pending}件`;
    if (demand.top.length > 0) {
      hint += `\n[DEMAND] 今コロニーで不足しがちな物を作る建物(上位・これらの新設/増強を優先): `
        + demand.top.slice(0, 5).map((b, i) => `${i + 1}位 ${b.building}`).join(", ");
    }
  }
  // Anchor hint follows the live colony center so it stays correct after a
  // colony_watch restart that doesn't pass ANCHOR_* env (normal-world colonies
  // are founded at their real terrain coords, not the configured default).
  const anc = colony ? { x: colony.x, y: colony.y, z: colony.z } : ANCHOR;
  const userMsg = `[STATE] anchor ${anc.x},${anc.y},${anc.z}\ncolonies: ${JSON.stringify(status)}${hint}\n[COUNCIL MEMORY] ${renderSharedCouncilContext()}\n直前の他の統治者の発言に提案・要望があれば、安全性と優先ルールに反しない限りchoiceに反映すること。反映しない場合はsayで短く理由を返すこと。\n[ACTIONS] 次の行動を1つ選び {"say":"<日本語で40文字以内の短い一言>","choice":<番号>} で答えること。sayに分析や長文を書かない:\n${menu}`;
  history.push({ role: "user", content: userMsg });

  let reply;
  try {
    reply = await askLLM(MODEL, history.slice(0, 1).concat(history.slice(-12)), { format: GOVERNOR_REPLY_SCHEMA });
  } catch (e) {
    console.log(`[${gov.name}] LLM error:`, e.message);
    return;
  }
  history.push({ role: "assistant", content: reply });

  const jsonStr = extractFirstJSON(reply);
  if (!jsonStr) {
    console.log(`[${gov.name}] no JSON in reply:`, reply.slice(0, 200));
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    console.log(`[${gov.name}] JSON parse failed:`, e.message, jsonStr.slice(0, 200));
    return;
  }

  if (parsed.say) sayInGame(gov.name, String(parsed.say).slice(0, 40));
  else console.log(`[${gov.name}] reply missing say:`, jsonStr.slice(0, 200));

  const idx =
    Number.isInteger(parsed.choice) && parsed.choice >= 0 && parsed.choice < candidates.length
      ? parsed.choice
      : 0;
  const chosen = candidates[idx];
  try {
    const res = await runGovernorAction(chosen.action);
    console.log(`[${gov.name}] choice ${idx} (${chosen.label}) ->`, res.status, res.body);
    const effective = actionResultWasEffective(res);
    rememberSharedEvent({
      kind: "action",
      who: gov.name,
      label: chosen.label,
      action: chosen.action,
      status: res.status,
      effective,
      result: String(res.body).slice(0, 150),
    });
    // Feed the outcome back into this governor's history - otherwise errors
    // (level gates, no space, research gates) are invisible and the model
    // keeps repeating the same failing choice.
    history.push({ role: "user", content: `[RESULT] ${chosen.label} -> ${res.status} ${String(res.body).slice(0, 150)}` });
  } catch (e) {
    console.log(`[${gov.name}] action failed:`, e.message);
    rememberSharedEvent({
      kind: "action",
      who: gov.name,
      label: chosen.label,
      action: chosen.action,
      status: "ERROR",
      effective: false,
      result: String(e.message).slice(0, 150),
    });
  }
}

async function runGovernorAction(action) {
  switch (action.action) {
    case "placeNext": {
      const placed = await httpRequest(
        "POST",
        `/placeNext?block=${encodeURIComponent(action.block)}&colonyId=${action.colonyId || COLONY_ID}`
      );
      if (placed.status < 200 || placed.status >= 300) return placed;
      const pos = parsePlacedPosition(placed.body);
      if (!pos) return placed;
      // Placement and construction are separate MineColonies operations. Once
      // the LLM has chosen the building type, submitting that exact hut for
      // construction is deterministic bookkeeping, not another policy choice.
      // Doing it here prevents an unbuilt shell from depending on a later LLM
      // turn where the model may incorrectly choose wait.
      const requested = await httpRequest(
        "POST",
        `/requestBuild?x=${pos.x}&y=${pos.y}&z=${pos.z}`
      );
      return {
        status: requested.status,
        body: `${placed.body} auto-requestBuild=${requested.body}`,
      };
    }
    case "place":
      return httpRequest("POST", `/place?x=${action.x}&y=${action.y}&z=${action.z}&block=${encodeURIComponent(action.block)}`);
    case "found":
      return httpRequest("POST", `/found?x=${action.x}&y=${action.y}&z=${action.z}&name=${encodeURIComponent(action.name || "VoyagerColony")}`);
    case "spawnCitizen":
      return httpRequest("POST", `/spawnCitizen?colonyId=${action.colonyId || COLONY_ID}`);
    case "requestBuild":
      return httpRequest("POST", `/requestBuild?x=${action.x}&y=${action.y}&z=${action.z}`);
    case "giveToCitizen":
      return httpRequest(
        "POST",
        `/giveToCitizen?colonyId=${action.colonyId || COLONY_ID}&citizenId=${action.citizenId}&item=${encodeURIComponent(action.item)}&count=${action.count}`
      );
    case "resolveRequest":
      return httpRequest("POST", `/resolveRequest?x=${action.x}&y=${action.y}&z=${action.z}&citizenId=${action.citizenId}`);
    case "wait":
      return { status: 200, body: '{"result":"waited"}' };
    default:
      throw new Error("Unknown action: " + JSON.stringify(action));
  }
}

function parsePlacedPosition(body) {
  const match = String(body).match(/\[pos:(-?\d+),(-?\d+),(-?\d+)\]/);
  if (!match) return null;
  return { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) };
}

// ---------- Citizen voice ----------

// Build job descriptions once: schematic_name -> English description from lang file
function jobDescriptions() {
  return Object.entries(BUILDING_REGISTRY)
    .filter(([, v]) => v.desc_en)
    .map(([key, v]) => `${v.job}(${key}): ${v.desc_en.slice(0, 120)}`)
    .join("\n");
}

const CITIZEN_VOICE_PROMPT = CITIZEN_VOICE_TEMPLATE.replace(
  /\{\{JOB_DESCRIPTIONS\}\}/g, jobDescriptions()
);

async function citizenVoiceTurn(citizen, building) {
  let context = `名前: ${citizen.name}, 職業: ${citizen.job}, 状態: ${citizen.jobStatus || "不明"}`;
  // Look up English job description for richer context
  const jobEntry = Object.values(BUILDING_REGISTRY).find((v) => {
    const key = Object.entries(BUILDING_REGISTRY).find(([, vv]) => vv === v)?.[0];
    return citizen.job && (key === citizen.job || v.job === citizen.job);
  });
  if (jobEntry?.desc_en) context += `, 仕事内容: ${jobEntry.desc_en.slice(0, 100)}`;
  if (building) {
    const requests = await getOpenRequests(building.x, building.y, building.z, citizen.id);
    if (requests.length > 0) {
      context += `, 未解決の要求: ${requests.map((r) => r.description).join(", ")}`;
    } else {
      context += `, 未解決の要求なし`;
    }
  }
  let line;
  try {
    line = await askLLM(MODEL, [
      { role: "system", content: CITIZEN_VOICE_PROMPT },
      { role: "user", content: context },
    ]);
  } catch (e) {
    console.log(`[citizen voice error] ${citizen.name}:`, e.message);
    return;
  }
  sayInGame(citizen.name, line.replace(/^["']|["']$/g, ""));
}

// ---------- Main loop ----------

async function main() {
  const histories = {};
  GOVERNORS.forEach((g) => {
    histories[g.name] = [{ role: "system", content: buildGovernorSystemPrompt(g) }];
  });

  for (let cycle = 1; cycle <= MAX_CYCLES; cycle++) {
    console.log(`\n=== cycle ${cycle} ===`);
    const status = await getStatus();

    // One citizen speaks per cycle, picked round-robin from whichever
    // colony already exists.
    const colony = status[0];
    if (
      colony && colony.citizens && colony.citizens.length > 0 &&
      (cycle - 1) % CITIZEN_VOICE_EVERY === 0
    ) {
      const citizen = colony.citizens[(cycle - 1) % colony.citizens.length];
      await citizenVoiceTurn(citizen, citizen.workBuilding);
      await sleep(TURN_DELAY_MS);
    }

    // Each governor takes one turn per cycle.
    for (const gov of GOVERNORS) {
      const freshStatus = await getStatus();
      await governorTurn(gov, histories[gov.name], freshStatus);
      await sleep(TURN_DELAY_MS);
    }

    await sleep(CYCLE_DELAY_MS);
  }
  console.log("\nReached max cycles, stopping.");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  askLLM, buildGovernorSystemPrompt, extractFirstJSON, buildCandidates,
  parsePlacedPosition, renderSharedCouncilContext,
  filterRecentlyIneffectiveCandidates, GOVERNORS, MODEL, GOVERNOR_REPLY_SCHEMA,
};

if (require.main === module) {
  main().catch((e) => console.error("FATAL", e));
}
