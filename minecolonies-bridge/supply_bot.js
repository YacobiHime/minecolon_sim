// supply_bot.js - Cheat-mode material supplier.
// Runs alongside council.js and automatically resolves every open citizen
// request so builders are never blocked waiting for materials.
//
// Key design: /resolveRequest alone only changes request state (OVERRULED) but
// does NOT put items in the citizen's inventory. The builder AI checks its own
// inventory and will re-issue the same request if the item isn't there, causing
// an infinite resolve loop. The correct sequence is:
//   1. /giveToCitizen  — physically deliver the item (builder AI detects it)
//   2. /resolveRequest — close the request state so MineColonies stops retrying
//
// Textured (Domum Ornamentum framed-block) requests are skipped - those
// require raw materials in the citizen's inventory first.
const http = require("http");
const fs = require("fs");
// Reused production-detection primitives (jobStatus==="working" heuristic +
// the no-worker building set) for the boot-time taper below.
const workStats = require("./work_stats.js");

const CMD_PIPE = process.env.CMD_PIPE || "/root/mc-server-forge/cmd_pipe";

// Non-blocking console command (mirrors council.js sayInGame): O_NONBLOCK so
// a wedged pipe can never hang the supply loop.
function consoleCmd(cmd) {
  try {
    const fd = fs.openSync(CMD_PIPE, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    fs.writeSync(fd, cmd + "\n");
    fs.closeSync(fd);
  } catch {
    // pipe not ready - skip, retry next cycle
  }
}

const BRIDGE_HOST = "localhost";
const BRIDGE_PORT = 8089;
const POLL_INTERVAL_MS = 6000;
const RESOLVE_DELAY_MS = 300;

// SUPPLY_MODE=observe turns the bot into a pure recorder: NO interventions
// (no feeding, curing, stocking, research, teaching, filling, resolving) -
// the colony runs on its own economy while every open request and welfare
// stat is aggregated into bottleneck_report.json. After OBSERVE_MINUTES the
// final report is written and the process exits; colony_watch restarts the
// bot without the env var, restoring normal (economy) mode automatically.
// Purpose (2026-07-08, user): find the colony's REAL bottlenecks to derive
// the mayor's build-priority criteria from data.
const SUPPLY_MODE = process.env.SUPPLY_MODE || "economy";
const OBSERVE_MINUTES = parseInt(process.env.OBSERVE_MINUTES || "120", 10);
const observeStart = Date.now();
const observedRequests = new Map(); // item -> {occurrences, maxCount, buildings:Set, description}
const observeTimeline = [];

function recordRequest(building, req) {
  const key = req.item || req.description || "?";
  if (!observedRequests.has(key)) {
    observedRequests.set(key, { occurrences: 0, maxCount: 0, buildings: new Set(), description: req.description });
  }
  const a = observedRequests.get(key);
  a.occurrences++;
  a.maxCount = Math.max(a.maxCount, req.count || 0);
  a.buildings.add(`${building.type}@${building.x},${building.z}`);
}

function writeObserveReport(final_) {
  const items = [...observedRequests.entries()]
    .map(([item, a]) => ({
      item, description: a.description, occurrences: a.occurrences,
      maxCount: a.maxCount, requesters: [...a.buildings],
    }))
    .sort((x, y) => y.occurrences - x.occurrences);
  const report = {
    mode: "observe", startedAt: new Date(observeStart).toISOString(),
    minutes: Math.round((Date.now() - observeStart) / 60000), final: !!final_,
    unresolvedRequests: items, timeline: observeTimeline,
  };
  require("fs").writeFileSync(`${__dirname}/bottleneck_report.json`, JSON.stringify(report, null, 2));
  if (final_) {
    console.log(`[observe] FINAL REPORT: ${items.length} distinct unresolved items; top:`);
    for (const it of items.slice(0, 15)) {
      console.log(`  ${it.occurrences}x ${it.item} (max ${it.maxCount}) <- ${it.requesters.slice(0, 3).join(", ")}${it.requesters.length > 3 ? ` +${it.requesters.length - 3}` : ""}`);
    }
  }
}

function httpRequest(method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: BRIDGE_HOST, port: BRIDGE_PORT, path, method },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getStatus() {
  const res = await httpRequest("GET", "/status");
  return JSON.parse(res.body);
}

async function getOpenRequests(x, y, z, citizenId) {
  const res = await httpRequest(
    "GET",
    `/openRequests?x=${x}&y=${y}&z=${z}&citizenId=${citizenId}`
  );
  try {
    return JSON.parse(res.body);
  } catch {
    return [];
  }
}

async function giveToCitizen(colonyId, citizenId, item, count) {
  return httpRequest(
    "POST",
    `/giveToCitizen?colonyId=${colonyId}&citizenId=${citizenId}&item=${encodeURIComponent(item)}&count=${count}`
  );
}

async function resolveRequest(x, y, z, citizenId) {
  return httpRequest(
    "POST",
    `/resolveRequest?x=${x}&y=${y}&z=${z}&citizenId=${citizenId}`
  );
}

// citizenId -> disease id we already delivered cure items for. Cleared when
// the citizen is healthy again so a new infection triggers a fresh delivery.
const curesDelivered = new Map();

// The game runs at 10x (POST /tickrate, standing rule) but this bot lives in
// real time. Anything that models an in-game process (hunger drain, cooldowns
// meant to span "a while for the citizen") must be divided by the multiplier,
// or the bot falls behind the game tenfold - the 10min feed cooldown at 10x
// meant citizens starved and trekked to the restaurant between feeds, which
// also caused the constant door-flapping foot traffic.
const TICK_MULTIPLIER = 10;

// Hungry citizens walk off to hunt for food (CHECK_FOR_FOOD / SEARCH_RESTAURANT)
// instead of working. Feed them before they get there. Citizens eat from
// their own inventory once saturation drops, so a small stack lasts a while.
// Two constraints learned the hard way:
// - canEatLevel: nutrition >= home level + 1 for lv3+ homes (bread(5) is
//   inedible in lv5 residences) - every item here is nutrition >= 7.
// - Food history: once a citizen's history is full, getBestFoodForCitizen
//   REFUSES all inventory food if diversity (distinct foods) or quality
//   (count of IMinecoloniesFoodItem meals) is below the home-level
//   requirement, and sends them trekking to the restaurant instead - fatal
//   for far-away workplaces at 10x where night interrupts the trip
//   (citizens 16/26 starvation, 2026-07-06). Rotating MineColonies dinners
//   (tier-3 ItemFood, no saturation nerf) keeps both stats satisfied.
const FEED_BELOW_SATURATION = 8;
// All tier-3 nutrition-9 ItemFood. Depth matters: the diversity requirement
// is homeLevel (lv5 home -> MORE than 5 distinct foods in history), so a
// 4-item rotation deadlocked once every item had been eaten recently
// (citizen 16, 2026-07-06 second starvation). 8 distinct tier-3 meals keep
// diversity above every home level's bar, and a never-eaten minecolonies
// food is always accepted immediately, which breaks existing deadlocks.
const FEED_ITEMS = [
  "minecolonies:steak_dinner",
  "minecolonies:fish_dinner",
  "minecolonies:schnitzel",
  "minecolonies:ramen",
  "minecolonies:sushi_roll",
  "minecolonies:tacos",
  "minecolonies:borscht",
  "minecolonies:hand_pie",
];
// Tier-3 meals restore ~7.5 saturation each (no vanilla nerf); 4 is already
// 30 saturation vs the 20 cap. Keeping the stack small stops uneaten food
// from packing inventories (which is what blocked cure deliveries on 07-04).
const FEED_ITEM_COUNT = 4;
// Couriers (and builders commuting to frontier sites) sprint all day at 10x
// and burn through 4 meals before the next cooldown - their saturation
// oscillated 0 <-> 4 while everyone else sat near 20 (2026-07-06 audit).
const HIGH_DRAIN_JOBS = new Set(["deliveryman", "builder"]);
const HIGH_DRAIN_COUNT = 8;
const feedRotation = new Map(); // citizenId -> next index into FEED_ITEMS
const FEED_COOLDOWN_MS = (10 * 60 * 1000) / TICK_MULTIPLIER;
const lastFed = new Map(); // citizenId -> timestamp of last delivery
// Optional first-response window for embodied citizen-to-citizen help. It is
// disabled by default so the welfare safety net is unchanged unless the
// social-help daemon is deliberately enabled alongside it.
const SOCIAL_HELP_GRACE_MS = Math.max(0,
  parseInt(process.env.SOCIAL_HELP_GRACE_MS || "0", 10) || 0);
const hungryObservedAt = new Map(); // citizenId -> real timestamp first seen below threshold

function socialHelpGraceRemaining(observedAt, citizenId, now, graceMs) {
  if (graceMs <= 0) return 0;
  if (!observedAt.has(citizenId)) observedAt.set(citizenId, now);
  return Math.max(0, graceMs - (now - observedAt.get(citizenId)));
}

async function feedHungryCitizens(colony, cycle) {
  let fed = 0;
  const hungryNow = new Set();
  for (const citizen of colony.citizens || []) {
    if (typeof citizen.saturation !== "number") continue;
    if (citizen.saturation >= FEED_BELOW_SATURATION) continue;
    hungryNow.add(citizen.id);
    // Sick citizens can't reach the EATING state (CitizenAI checks SICK
    // first), so bread only piles up until the inventory is full - which
    // then makes the cure delivery bounce and the citizen stays sick
    // forever (the 2026-07-04 23-sick-citizens incident). Cure first,
    // feed after.
    if (citizen.sick) continue;
    const graceRemaining = socialHelpGraceRemaining(
      hungryObservedAt, citizen.id, Date.now(), SOCIAL_HELP_GRACE_MS
    );
    if (graceRemaining > 0) continue;
    const last = lastFed.get(citizen.id) || 0;
    if (Date.now() - last < FEED_COOLDOWN_MS) continue;
    const idx = feedRotation.get(citizen.id) || 0;
    const item = FEED_ITEMS[idx % FEED_ITEMS.length];
    feedRotation.set(citizen.id, idx + 1);
    const count = HIGH_DRAIN_JOBS.has(citizen.job) ? HIGH_DRAIN_COUNT : FEED_ITEM_COUNT;
    await giveToCitizen(colony.id, citizen.id, item, count);
    lastFed.set(citizen.id, Date.now());
    console.log(
      `[supply #${cycle}] fed citizen ${citizen.id} (saturation ${citizen.saturation}): ${count}x ${item}`
    );
    fed++;
    await sleep(RESOLVE_DELAY_MS);
  }
  for (const citizenId of hungryObservedAt.keys()) {
    if (!hungryNow.has(citizenId)) hungryObservedAt.delete(citizenId);
  }
  return fed;
}

// Builders request materials one item type at a time as construction reaches
// them, which costs a request->deliver round-trip (one poll cycle) per item
// type. The hut itself tracks the whole remaining bill of materials, and the
// builder takes from the hut's racks before filing requests - so bulk-filling
// the racks via /fillBuilderResources removes the ping-pong. Tools/armor are
// not in that list and still flow through the request loop below.
async function fillBuilderHuts(colony, cycle, tapered) {
  let filled = 0;
  for (const building of colony.buildings || []) {
    if (building.type !== "blockhutbuilder") continue;
    try {
      // Skip both crafter-economy outputs and tapered (self-produced) items so
      // bulk-fill doesn't stuff racks with what the colony now makes itself;
      // the builder then files real requests that the taper/economy handle.
      const skip = encodeURIComponent([...taughtOutputs, ...(tapered || [])].join(","));
      const res = await httpRequest(
        "POST",
        `/fillBuilderResources?x=${building.x}&y=${building.y}&z=${building.z}&skip=${skip}`
      );
      if (res.status !== 200) continue;
      const given = JSON.parse(res.body).filter((i) => i.given > 0);
      if (given.length > 0) {
        console.log(
          `[supply #${cycle}] filled builder hut (${building.x},${building.y},${building.z}): ` +
            given.map((i) => `${i.given}x ${i.item}`).join(", ")
        );
        filled += given.length;
      }
    } catch {
      // transient - retry next cycle
    }
  }
  return filled;
}

// Crafters only produce what they have been TAUGHT (normally via the crafting
// GUI). crafter_recipes.json is a priority-ordered teach list per building
// type; recipe slots scale as 2^buildingLevel (x research), so we teach from
// the top and simply stop when the building refuses (capacity full) - after
// the next level-up or RECIPES research the loop picks up where it left off.
// /teachRecipe is idempotent ("already taught" is a success).
const CRAFTER_RECIPES = require("./crafter_recipes.json");

// ---- Bottleneck-driven demand signal ----
// The colony's real demand is invisible in economy mode because supply_bot
// fulfils every request. But it SEES every request as it fulfils them, so it
// can tally what's actually consumed and, via the item->producer map, tell the
// mayor which producer buildings to build/upgrade. Written to demand.json;
// council.js reads it and annotates its build menu. This is the data-driven
// build-priority the observation window was meant to inform.
//
// item -> producer building, derived from crafter_recipes.json (what each
// crafter is taught to make) plus farm/food staples the world can grow.
const ITEM_PRODUCER = {};
for (const [buildingType, recipes] of Object.entries(CRAFTER_RECIPES)) {
  if (buildingType.startsWith("_")) continue;
  const key = buildingType.replace(/^blockhut/, "");
  for (const r of recipes) if (r.output) ITEM_PRODUCER[r.output] = key;
}
Object.assign(ITEM_PRODUCER, {
  "minecraft:carrot": "farmer", "minecraft:wheat": "farmer", "minecraft:potato": "farmer",
  "minecraft:wheat_seeds": "farmer", "minecraft:beetroot": "farmer", "minecraft:pumpkin": "farmer",
  "minecraft:melon_slice": "farmer", "minecraft:sugar_cane": "farmer",
  "minecraft:cooked_beef": "cook", "minecraft:cooked_porkchop": "cook", "minecraft:cooked_chicken": "cook",
  "minecraft:cooked_mutton": "cook", "minecraft:cod": "fisherman", "minecraft:salmon": "fisherman",
  "minecraft:cooked_cod": "fisherman", "minecraft:cooked_salmon": "fisherman",
  "minecraft:leather": "cowboy", "minecraft:beef": "cowboy", "minecraft:porkchop": "swineherder",
  "minecraft:mutton": "shepherd", "minecraft:white_wool": "shepherd", "minecraft:rabbit": "rabbithutch",
  "minecraft:oak_log": "lumberjack", "minecraft:oak_sapling": "lumberjack",
});
// Miner raws + the rest of the tree-species logs/saplings, so the taper can
// see "this ore/log now has a live producer" for the normal-world gatherers.
Object.assign(ITEM_PRODUCER, {
  "minecraft:cobblestone": "miner", "minecraft:stone": "miner", "minecraft:coal": "miner",
  "minecraft:raw_iron": "miner", "minecraft:iron_ore": "miner", "minecraft:raw_copper": "miner",
  "minecraft:copper_ore": "miner", "minecraft:raw_gold": "miner", "minecraft:gold_ore": "miner",
  "minecraft:redstone": "miner", "minecraft:lapis_lazuli": "miner", "minecraft:diamond": "miner",
  "minecraft:diorite": "miner", "minecraft:andesite": "miner", "minecraft:granite": "miner",
  "minecraft:gravel": "miner", "minecraft:dirt": "miner",
  "minecraft:birch_log": "lumberjack", "minecraft:spruce_log": "lumberjack",
  "minecraft:jungle_log": "lumberjack", "minecraft:acacia_log": "lumberjack",
  "minecraft:dark_oak_log": "lumberjack", "minecraft:stick": "lumberjack",
  "minecraft:birch_sapling": "lumberjack", "minecraft:spruce_sapling": "lumberjack",
  "minecraft:jungle_sapling": "lumberjack", "minecraft:acacia_sapling": "lumberjack",
  "minecraft:dark_oak_sapling": "lumberjack",
});

// ============================================================================
// Boot-time taper: supply_bot from primary supplier -> safety net (design D3).
//
// The colony is migrating superflat -> normal world, where miner/lumberjack/
// farmer become real gatherers. We want to STOP cheat-supplying an item once
// the colony can produce it itself, but not so early that construction stalls
// waiting for materials. So each item is tapered only when BOTH hold:
//   (1) production detected  - a producer building for the item is actively
//       working, AND
//   (2) time floor cleared   - the colony is older than N in-game days
//       (early-stall insurance).
// A tapered item gets NO primary supply; only a persistent unmet request
// (economy provably behind, STARVE_GUARD_MS) makes the safety net step back
// in. Items with no known producer are never tapered - they keep full
// gap-fill supply, which is exactly "gap-fill only for zero-production items".
//
// Production-detection PROXY = worker activity (jobStatus==="working") from
// /status, aggregated over a rolling window and mapped item->producer through
// ITEM_PRODUCER. Rationale: it is the only self-sufficiency signal available
// from existing endpoints. /warehouseStats reports rack OCCUPANCY, not per-item
// counts, so a true "warehouse stock delta per item" would need a new Java
// endpoint (out of scope here). Worker activity is the same heuristic
// work_stats.js already uses to find dead workplaces, so we reuse it verbatim.
// It is a proxy: a "working" lumberjack is assumed to be yielding its logs/
// saplings, a "working" miner its ores, etc. - true at the building-type
// granularity we taper on.
//
// All thresholds are env-overridable constants; defaults are deliberately
// CONSERVATIVE (slow to cut supply) to protect early construction.
// ============================================================================
const TAPER_ENABLED = process.env.TAPER !== "off"; // TAPER=off restores pre-taper behavior
// In-game days the colony must reach before any item may taper. At 10x a game
// day is ~2 real minutes, but crops/economy advance on GAME time, so the floor
// is expressed in game days. 4 days = the producers have had several harvest/
// mining cycles to actually stock the warehouse before we lean on them.
const TAPER_FLOOR_DAYS = parseFloat(process.env.TAPER_FLOOR_DAYS || "4");
// Logs taper earlier: plains are tree-sparse, so we bootstrap logging with
// SAPLINGS (below) and want to stop free-log supply as soon as the lumberjack
// is on the job, forcing the colony onto its own replant harvest.
const LOG_TAPER_FLOOR_DAYS = parseFloat(process.env.LOG_TAPER_FLOOR_DAYS || "2");
// Detection window: how many recent poll cycles decide "producer is active".
// 15 cycles x 6s poll = ~90s real observation (~15 game-min at 10x).
const DETECT_WINDOW_CYCLES = parseInt(process.env.TAPER_DETECT_WINDOW || "15", 10);
// Don't judge a producer until we have this many samples (avoid deciding on a
// lucky/unlucky single snapshot right after startup).
const DETECT_MIN_SAMPLES = parseInt(process.env.TAPER_DETECT_MIN || "8", 10);
// Fraction of window samples in which the producer must be "working" to count
// as active. Gatherers commute/sleep/eat a lot at 10x, so sustained ~1/3
// working is already a live production line. Higher = slower to taper (safer,
// may never fire); lower = eager to taper (risks cutting a marginal producer).
const DETECT_WORKING_FRACTION = parseFloat(process.env.TAPER_DETECT_FRACTION || "0.35");
// A tapered item whose request stays UNMET this long means the real economy is
// too slow; the safety net supplies it anyway so construction never deadlocks.
// 5 real min = ~50 game-min at 10x.
const STARVE_GUARD_MS = parseInt(process.env.TAPER_STARVE_GUARD_MS || "300000", 10);
const TICKS_PER_DAY = 24000;

// Saplings SEED the lumberjack replant loop. Plains barely have trees, so we
// keep supplying saplings (never taper them) as the boot input that gets the
// logging loop spinning; the lumberjack then plants them and harvests logs.
const SAPLING_ITEMS = new Set([
  "minecraft:oak_sapling", "minecraft:birch_sapling", "minecraft:spruce_sapling",
  "minecraft:jungle_sapling", "minecraft:acacia_sapling", "minecraft:dark_oak_sapling",
]);
const LOG_ITEMS = new Set([
  "minecraft:oak_log", "minecraft:birch_log", "minecraft:spruce_log",
  "minecraft:jungle_log", "minecraft:acacia_log", "minecraft:dark_oak_log",
]);

// producerKey (building type minus "blockhut", matching ITEM_PRODUCER values)
// -> rolling array of 0/1: was any of that producer's staffed operational
// buildings observed working this cycle?
const producerWindow = new Map();
function recordProducerActivity(colony, citById) {
  const activeNow = new Set();
  const presentNow = new Set();
  for (const b of colony.buildings || []) {
    if (workStats.NO_WORKER.has(b.type)) continue;
    if (!b.operational || !(b.workers || []).length) continue;
    const key = b.type.replace(/^blockhut/, "");
    presentNow.add(key);
    const working = (b.workers || []).some((id) => workStats.isCitizenWorking(citById.get(id)));
    if (working) activeNow.add(key);
  }
  // Sample every producer we have ever seen, so a producer that goes absent
  // (building removed / worker died) decays back toward "inactive".
  for (const key of new Set([...producerWindow.keys(), ...presentNow])) {
    const arr = producerWindow.get(key) || [];
    arr.push(activeNow.has(key) ? 1 : 0);
    while (arr.length > DETECT_WINDOW_CYCLES) arr.shift();
    producerWindow.set(key, arr);
  }
}
function producerActive(key) {
  const arr = producerWindow.get(key);
  if (!arr || arr.length < DETECT_MIN_SAMPLES) return false;
  const frac = arr.reduce((a, b) => a + b, 0) / arr.length;
  return frac >= DETECT_WORKING_FRACTION;
}

// Colony age in game-days, anchored to the first gameTime we ever saw for this
// colony (persisted so it survives colony_watch restarts). Using an anchor
// rather than raw gameTime keeps the floor correct even if the world's clock
// is already large; if gameTime ever goes backwards (world rollback) we
// re-anchor, erring toward MORE supply.
const TAPER_STATE_FILE = `${__dirname}/taper_state.json`;
let taperState = { foundingGameTime: {} };
try { taperState = JSON.parse(fs.readFileSync(TAPER_STATE_FILE, "utf8")); } catch { /* first run */ }
function colonyAgeDays(colony) {
  const gt = colony.gameTime;
  if (typeof gt !== "number") return 0;
  const key = String(colony.id);
  const anchor = taperState.foundingGameTime[key];
  if (anchor == null || anchor > gt) {
    taperState.foundingGameTime[key] = gt;
    try { fs.writeFileSync(TAPER_STATE_FILE, JSON.stringify(taperState)); } catch { /* non-fatal */ }
    return 0;
  }
  return (gt - anchor) / TICKS_PER_DAY;
}

// Items currently in safety-net (tapered) mode - only for transition logging.
const taperedItems = new Set();
// item -> first timestamp it was seen still-requested while tapered (starve guard).
const taperedRequestSince = new Map();

function itemProducerKey(item) {
  return ITEM_PRODUCER[item];
}
// True => stop primary supply of this item (colony produces it, past the floor).
function shouldTaper(item, ageDays, cycle) {
  if (!TAPER_ENABLED) return false;
  if (SAPLING_ITEMS.has(item)) return false; // boot seed: always supplied
  const key = itemProducerKey(item);
  if (!key) return false; // no known producer -> zero-production -> keep gap-filling
  const floor = LOG_ITEMS.has(item) ? LOG_TAPER_FLOOR_DAYS : TAPER_FLOOR_DAYS;
  const active = ageDays >= floor && producerActive(key);
  if (active && !taperedItems.has(item)) {
    taperedItems.add(item);
    console.log(
      `[taper #${cycle}] ${item}: primary supply STOPPED -> safety net ` +
      `(producer '${key}' active, colony age ${ageDays.toFixed(1)}d >= floor ${floor}d)`
    );
  } else if (!active && taperedItems.has(item)) {
    taperedItems.delete(item);
    taperedRequestSince.delete(item);
    console.log(
      `[taper #${cycle}] ${item}: primary supply RESUMED ` +
      `(producer '${key}' no longer active at age ${ageDays.toFixed(1)}d)`
    );
  }
  return active;
}
// Recompute the tapered set for a colony once per cycle (also emits the
// STOPPED/RESUMED transition logs). Iterating ITEM_PRODUCER keys is enough:
// only items with a known producer can ever taper.
function computeTapered(ageDays, cycle) {
  const set = new Set();
  for (const item of Object.keys(ITEM_PRODUCER)) {
    if (shouldTaper(item, ageDays, cycle)) set.add(item);
  }
  return set;
}

const demandTally = new Map(); // item -> decayed weighted count
function recordDemand(item, weight) {
  if (!item) return;
  demandTally.set(item, (demandTally.get(item) || 0) + weight);
}
function writeDemand() {
  // Aggregate item demand into producer-building scores.
  const byBuilding = new Map();
  const topItems = [];
  for (const [item, cnt] of demandTally) {
    if (cnt < 1) continue;
    topItems.push({ item, count: Math.round(cnt) });
    const prod = ITEM_PRODUCER[item];
    if (prod) byBuilding.set(prod, (byBuilding.get(prod) || 0) + cnt);
  }
  topItems.sort((a, b) => b.count - a.count);
  const buildingPriority = [...byBuilding.entries()]
    .map(([building, score]) => ({ building, score: Math.round(score) }))
    .sort((a, b) => b.score - a.score);
  try {
    require("fs").writeFileSync(
      `${__dirname}/demand.json`,
      JSON.stringify({ updated: Date.now(), buildingPriority, topItems: topItems.slice(0, 20) })
    );
  } catch {
    /* non-fatal */
  }
}

// The colony's own production economy. Items some crafter has been TAUGHT
// are left to the request system: excluded from the builder bulk-fill (so
// builders file real requests), and their requests are NOT cheat-resolved
// for CRAFT_DEFER_MS - the resolver routes them to the crafter, the crafter
// works, a courier delivers. Only if the economy fails to deliver in time
// does the cheat supply step in, so construction never deadlocks. Raw
// inputs (logs, stone, iron) are never taught outputs and stay cheated -
// the cheat retreats to the resource frontier, the middle becomes real.
let taughtOutputs = new Set();
const CRAFT_DEFER_MS = 180000; // 3 real minutes = 30 game-minutes at 10x
const deferredSince = new Map(); // request signature -> first-seen timestamp

async function refreshTaughtOutputs(colony, cycle) {
  if (cycle % 10 !== 7 && taughtOutputs.size > 0) return;
  const next = new Set();
  for (const building of colony.buildings || []) {
    if (!CRAFTER_RECIPES[building.type] || !building.operational || !(building.workers || []).length) continue;
    try {
      const res = await httpRequest("GET", `/recipes?x=${building.x}&y=${building.y}&z=${building.z}`);
      if (res.status !== 200) continue;
      for (const m of JSON.parse(res.body).modules || []) {
        for (const r of m.recipes || []) next.add(r.output);
      }
    } catch {
      return; // transient - keep the old set
    }
  }
  taughtOutputs = next;
}

async function teachCrafterRecipes(colony, cycle) {
  if (cycle % 10 !== 5) return 0; // same cadence as autoResearch, offset phase
  let taught = 0;
  for (const building of colony.buildings || []) {
    const list = CRAFTER_RECIPES[building.type];
    if (!list || !building.operational || building.level < 1) continue;
    for (const r of list) {
      const inputs = encodeURIComponent(r.inputs);
      const out = encodeURIComponent(r.output);
      let res;
      try {
        res = await httpRequest(
          "POST",
          `/teachRecipe?x=${building.x}&y=${building.y}&z=${building.z}` +
            `&output=${out}&outputCount=${r.count || 1}&inputs=${inputs}&grid=${r.grid || 3}`
        );
      } catch {
        break; // transient - retry next round
      }
      if (res.status !== 200) break; // capacity full (or incompatible) - stop here for now
      if ((res.body || "").includes("taught ")) {
        console.log(`[supply #${cycle}] ${building.type}@(${building.x},${building.z}): ${res.body.slice(0, 120)}`);
        taught++;
      }
      await sleep(RESOLVE_DELAY_MS);
    }
  }
  return taught;
}

// Skill-optimal job assignment. MineColonies' own auto-hire fills open slots
// with an arbitrary jobless citizen; /autoAssignJobs instead matches the
// best-skilled unemployed to each open civilian slot (respecting MANUAL
// decommissions). Auto-hire usually wins the race for a single slot, so this
// mainly earns its keep when a batch of new buildings opens several slots at
// once. Silent unless it actually assigns someone.
// Every 5 cycles (~30s at the 6s poll): fast enough that a slot vacated by a
// dead worker gets a skill-optimal successor promptly (MineColonies auto-hire
// also refills AUTO slots, but arbitrarily; this backstops and optimizes).
async function autoAssignJobs(colony, cycle) {
  if (cycle % 5 !== 1) return 0;
  try {
    // reassign=true: also swap a slot's weakest occupant for a clearly-better
    // unemployed one (fit improvement >= threshold). Converges - displaced
    // low-fit workers cascade to jobs they suit, and stops when no swap clears
    // the threshold. This is what turns MineColonies' arbitrary auto-hire into
    // skill-based staffing over time.
    const res = await httpRequest(
      "POST",
      `/autoAssignJobs?colonyId=${colony.id}&reassign=true&threshold=10&max=10`
    );
    if (res.status !== 200) return 0;
    const d = JSON.parse(res.body);
    if (d.filled > 0 || d.swapped > 0) {
      console.log(
        `[supply #${cycle}] job matcher: filled ${d.filled}, swapped ${d.swapped} for skill fit`
      );
    }
    return (d.filled || 0) + (d.swapped || 0);
  } catch {
    return 0;
  }
}

// Citizens are unhappy when home is far from work. Periodically move workers
// to the nearest residence with a free bed. Cheap no-op once homes are good.
async function optimizeHomes(colony, cycle) {
  if (cycle % 30 !== 17) return 0;
  try {
    const res = await httpRequest("POST", `/optimizeHomes?colonyId=${colony.id}&maxDist=50&max=10`);
    if (res.status !== 200) return 0;
    const d = JSON.parse(res.body);
    if (d.moved > 0) {
      console.log(`[supply #${cycle}] moved ${d.moved} workers to homes nearer their workplace`);
    }
    return d.moved || 0;
  } catch {
    return 0;
  }
}

// Research progresses on its own once started (the university researcher
// works it down), but finished research frees slots and unlocks children -
// periodically ask the bridge to start whatever is startable next. Item
// costs are cheated (creative path); progression order stays vanilla.
// Farmer huts don't work until each field has a seed assigned (normally a GUI
// step). Fields also increase as the farmer hut levels up, so unseeded fields
// keep appearing. Auto-assign a rotating crop to any empty field - this makes
// new farmers start working with no manual setup and covers higher-level huts'
// extra fields (user asks 2026-07-12). Rotating crops also feeds the citizen
// food-diversity rule (see colony-diag).
const FIELD_CROPS = [
  "minecraft:wheat_seeds", "minecraft:potato", "minecraft:carrot",
  "minecraft:beetroot_seeds",
];
async function seedFarmFields(colony, cycle) {
  if (cycle % 5 !== 2) return 0; // a few times a minute, offset from other steps
  try {
    const res = await httpRequest("GET", `/fields?colonyId=${colony.id}`);
    if (res.status !== 200) return 0;
    const fields = JSON.parse(res.body);
    const empty = fields.filter((f) => !f.seed);
    let seeded = 0;
    for (let i = 0; i < empty.length; i++) {
      const f = empty[i];
      const crop = FIELD_CROPS[(seeded + fields.length) % FIELD_CROPS.length];
      const r = await httpRequest(
        "POST",
        `/setFieldSeed?x=${f.x}&y=${f.y}&z=${f.z}&seed=${encodeURIComponent(crop)}`
      );
      if (r.status === 200) seeded++;
    }
    if (seeded > 0) {
      console.log(`[supply #${cycle}] seeded ${seeded} empty farm field(s)`);
    }
    return seeded;
  } catch {
    // transient - retry next round
  }
  return 0;
}

// University staffing guarantee. Research only advances while a researcher
// works the University down; an UNSTAFFED University freezes every in-progress
// research at its current progress, so research-gated buildings never unlock
// and the builders that would build them sit idle - the whole colony stalls.
// Observed live (2026-07-11): University workers:[] with research progress 0;
// unblocked only after a builder was hand-moved to the University (0 -> 24).
// MineColonies auto-hire only draws from the JOBLESS pool, so a full colony
// with no unemployed never fills the University itself. This step fixes that:
//   (a) if a jobless citizen exists, assign it (free labour, no trade-off);
//   (b) else, ONLY when research is the active bottleneck, reassign one
//       SURPLUS worker - a spare builder (keeping >=1 builder), or failing that
//       a non-core worker - never a core producer (farmer/cook/lumberjack/...).
// Core economy jobs are never poached to staff research.
const CORE_JOBS = new Set([
  "farmer", "cook", "baker", "lumberjack", "fisherman", "miner",
  "deliveryman", "warehouse", "cowboy", "shepherd", "swineherder",
  "chickenherder", "composter", "researcher",
]);

// Research is the active bottleneck iff some research is already IN PROGRESS:
// MineColonies begins the research (creative path, no worker needed) but only a
// University researcher advances it, so inProgress>0 with an unstaffed
// University means research is frozen - the exact live symptom, and precisely
// when pulling a worker onto research pays off. If nothing is in progress there
// is nothing for a researcher to do, so we do NOT poach anyone. One existing
// endpoint (/research.inProgress), fully deterministic.
async function isResearchLimited(colony) {
  try {
    const res = await httpRequest("GET", `/research?colonyId=${colony.id}`);
    if (res.status !== 200) return false;
    const d = JSON.parse(res.body);
    return (d.inProgress || 0) > 0;
  } catch {
    return false;
  }
}

async function staffUniversities(colony, cycle) {
  if (cycle % 5 !== 3) return 0; // offset from autoAssignJobs(%5==1)/seedFarmFields(%5==2)
  const empty = (colony.buildings || []).filter(
    (b) => b.type === "blockhutuniversity" && b.operational && !(b.workers || []).length
  );
  if (empty.length === 0) return 0; // no University, or all already staffed

  const citizens = colony.citizens || [];
  const healthy = (c) => !c.sick;
  const unemployed = citizens.filter((c) => c.job === "unemployed" && healthy(c));
  // Sorted so the LAST builder (highest id, usually the most recently hired /
  // most surplus) is the one pulled; pop() keeps at least one builder building.
  const builders = citizens
    .filter((c) => c.job === "builder" && healthy(c))
    .sort((a, b) => a.id - b.id);
  const nonCore = citizens.filter(
    (c) => c.job !== "unemployed" && c.job !== "builder" && !CORE_JOBS.has(c.job) && healthy(c)
  );

  let staffed = 0;
  let researchChecked = false;
  let researchLimited = false;

  for (const uni of empty) {
    // (a) prefer a jobless citizen - no worker is displaced.
    let pick = unemployed.shift();
    let reason = "assigned unemployed";
    if (!pick) {
      // (b) no jobless: only poach when research is the active bottleneck.
      if (!researchChecked) {
        researchLimited = await isResearchLimited(colony);
        researchChecked = true;
      }
      if (!researchLimited) break; // not worth pulling anyone off their job
      if (builders.length >= 2) {
        pick = builders.pop(); // spare builder; >=1 builder stays on construction
        reason = "reassigned builder";
      } else {
        pick = nonCore.shift(); // else a non-core worker (guard/rabbithutch/...)
        reason = "reassigned worker";
      }
      if (!pick) break; // no surplus worker to spare - leave core jobs intact
    }
    const res = await httpRequest(
      "POST",
      `/assignWorker?x=${uni.x}&y=${uni.y}&z=${uni.z}&colonyId=${colony.id}&citizenId=${pick.id}`
    );
    if (res.status === 200) {
      console.log(
        `[supply #${cycle}] staffed university @(${uni.x},${uni.y},${uni.z}): ` +
        `${reason} ${pick.name} (id ${pick.id}) -> researcher`
      );
      staffed++;
    } else {
      console.log(
        `[supply #${cycle}] staff university @(${uni.x},${uni.y},${uni.z}) failed ` +
        `(citizen ${pick.id}): ${res.body}`
      );
    }
    await sleep(RESOLVE_DELAY_MS);
  }
  return staffed;
}

async function autoResearch(colony, cycle) {
  if (cycle % 10 !== 1) return 0;
  try {
    const res = await httpRequest("POST", `/autoResearch?colonyId=${colony.id}`);
    if (res.status !== 200) return 0; // e.g. no university yet
    const d = JSON.parse(res.body);
    if (d.started && d.started.length > 0) {
      console.log(
        `[supply #${cycle}] started research: ${d.started.join(", ")} (${d.inProgress}/${d.slots} slots)`
      );
      return d.started.length;
    }
  } catch {
    // transient - retry next round
  }
  return 0;
}

// Population ceiling = available beds + research. The base MineColonies cap is
// 25 citizens; the only way past it is the civilian research chain
// keen -> outpost -> hamlet -> village -> city (each adds a citizencapaddition
// effect). autoResearch already starts these when reachable, but it competes
// with every other shallow research for the limited slots (= university level);
// when the colony is pushing against the cap AND still has empty workplaces we
// give this chain an explicit head start (user 2026-07-12).
const POP_CAP_BRANCH = "minecolonies:civilian";
// Ordered shallow->deep; outpost needs residence lv4, hamlet residence lv5,
// village town-hall lv4, city town-hall lv5 (verified against the mod jar).
const POP_CAP_CHAIN = [
  "minecolonies:civilian/keen",
  "minecolonies:civilian/outpost",
  "minecolonies:civilian/hamlet",
  "minecolonies:civilian/village",
  "minecolonies:civilian/city",
];
async function prioritizePopulationResearch(colony, cycle) {
  if (cycle % 10 !== 6) return 0; // offset a few ticks from autoResearch (cycle%10==1)
  const buildings = colony.buildings || [];
  const pop = (colony.citizens || []).length;
  const jobBuildings = buildings.filter(
    (b) => b.operational && b.type !== "blockhuttownhall" && b.type !== "blockhutcitizen"
  ).length;
  const unfilledJobs = Math.max(0, jobBuildings - pop);
  // Only near the ceiling (approaching the base cap of 25) with jobs still to
  // fill - otherwise more beds/spawns raise the population without any research.
  if (unfilledJobs <= 0 || pop < 23) return 0;
  try {
    const res = await httpRequest("GET", `/research?colonyId=${colony.id}`);
    if (res.status !== 200) return 0; // no university yet
    const d = JSON.parse(res.body);
    const uniLevel = d.universityLevel || 0;
    if (uniLevel <= 0) return 0;
    const branch = (d.branches || []).find((b) => b.branch === POP_CAP_BRANCH);
    if (!branch) return 0;
    const byId = new Map((branch.researches || []).map((r) => [r.id, r]));
    // Walk the chain in order. Skip FINISHED, stop on the first NOT_STARTED that
    // is actually startable (parent finished by the loop invariant, depth within
    // university level, building requirements met). The direct startResearch
    // path skips vanilla's depth/requirement checks, so we enforce them here.
    for (const id of POP_CAP_CHAIN) {
      const r = byId.get(id);
      if (!r) continue;
      if (r.state === "FINISHED") continue;
      if (r.state !== "NOT_STARTED") return 0; // IN_PROGRESS: chain already advancing
      if (r.depth > uniLevel) {
        console.log(
          `[supply #${cycle}] pop-cap research ${id} needs university lv${r.depth} (have ${uniLevel}); upgrade University`
        );
        return 0;
      }
      const unmet = (r.requirements || []).filter((rq) => !rq.met);
      if (unmet.length > 0) {
        console.log(
          `[supply #${cycle}] pop-cap research ${id} blocked by: ` +
            unmet.map((rq) => rq.desc || rq.building || "requirement").join(", ")
        );
        return 0;
      }
      const sr = await httpRequest(
        "POST",
        `/startResearch?colonyId=${colony.id}&branch=${encodeURIComponent(POP_CAP_BRANCH)}&id=${encodeURIComponent(id)}`
      );
      if (sr.status === 200) {
        console.log(
          `[supply #${cycle}] started population-cap research ${id} (pop ${pop}, unfilled jobs ${unfilledJobs})`
        );
        return 1;
      }
      console.log(`[supply #${cycle}] startResearch ${id} failed: ${sr.body}`);
      return 0;
    }
  } catch {
    // transient - retry next round
  }
  return 0;
}

// Keep the restaurant's racks stocked with every menu food so the cook can
// serve arrivals immediately (the built-in MinimumStock pipeline is too slow
// at 10x and citizens loiter at the restaurant waiting to be fed).
// Menu items the colony can bake/cook itself: the bot leaves these OUT of
// the restaurant stocking so the MinimumStock requests reach the baker and
// the cook (their data-driven custom recipes cover bread and the
// minecolonies dishes; ingredient requests cascade to the cheat supply).
// Direct emergency feeding of citizens is unchanged - this only moves the
// restaurant's shelf-stocking onto the real economy.
const SELF_COOKED = new Set(["minecraft:bread", ...FEED_ITEMS]);

async function stockRestaurants(colony, cycle) {
  let stocked = 0;
  const skip = encodeURIComponent([...SELF_COOKED].join(","));
  for (const building of colony.buildings || []) {
    if (building.type !== "blockhutcook" || !building.operational) continue;
    try {
      const res = await httpRequest(
        "POST",
        `/stockRestaurant?x=${building.x}&y=${building.y}&z=${building.z}&countPerItem=32&skip=${skip}`
      );
      if (res.status !== 200) continue;
      const given = JSON.parse(res.body).filter((i) => i.given > 0);
      if (given.length > 0) {
        console.log(
          `[supply #${cycle}] stocked restaurant (${building.x},${building.y},${building.z}): ` +
            given.map((i) => `${i.given}x ${i.item}`).join(", ")
        );
        stocked += given.length;
      }
    } catch {
      // transient - retry next cycle
    }
  }
  return stocked;
}

// Sick citizens don't file requests - their EntityAISickTask walks to a
// hospital (which this colony doesn't have) and otherwise waits forever.
// The same AI self-cures (APPLY_CURE) as soon as every cure item of the
// disease is in the citizen's own inventory, so delivering the items via
// /giveToCitizen is a full treatment.
async function deliverCure(colony, citizen) {
  let complete = true;
  for (const cure of citizen.cureItems) {
    if (!cure.item || cure.count <= 0) continue;
    const res = await giveToCitizen(colony.id, citizen.id, cure.item, cure.count);
    const m = /gave (\d+)\/(\d+)/.exec(res.body || "");
    if (!m || m[1] !== m[2]) complete = false;
    await sleep(RESOLVE_DELAY_MS);
  }
  return complete;
}

async function treatSickCitizens(colony, cycle) {
  let treated = 0;
  for (const citizen of colony.citizens || []) {
    if (!citizen.sick) {
      curesDelivered.delete(citizen.id);
      continue;
    }
    if (!citizen.cureItems || citizen.cureItems.length === 0) continue;
    if (curesDelivered.get(citizen.id) === citizen.disease) continue;
    // /giveToCitizen answers "gave X/Y" - X < Y means the inventory was
    // full and the cure is incomplete, which the sick AI treats as no cure
    // at all. Clear the inventory (cheap, everything is cheat-supplied)
    // and retry once; only a fully landed delivery counts as treated.
    let complete = await deliverCure(colony, citizen);
    if (!complete) {
      await httpRequest(
        "POST",
        `/clearCitizenInventory?colonyId=${colony.id}&citizenId=${citizen.id}`
      );
      complete = await deliverCure(colony, citizen);
    }
    if (!complete) {
      console.log(
        `[supply #${cycle}] cure delivery incomplete for citizen ${citizen.id} (${citizen.disease}), will retry`
      );
      continue;
    }
    curesDelivered.set(citizen.id, citizen.disease);
    console.log(
      `[supply #${cycle}] treated citizen ${citizen.id} (${citizen.disease}): ` +
        citizen.cureItems.map((c) => `${c.count}x ${c.item}`).join(", ")
    );
    treated++;
  }
  return treated;
}

// The warehouse saturates (hit 6696/6696 slots, 2026-07-08) because 120
// citizens' harvests inflow with no real outflow. When fullness passes 90%,
// cap every item to 256 and void the surplus - couriers need dump space or
// they wedge silently.
async function warehouseJanitor(colony, cycle) {
  if (cycle % 20 !== 3) return 0;
  try {
    const res = await httpRequest("GET", `/warehouseStats?colonyId=${colony.id}`);
    if (res.status !== 200) return 0;
    const whs = JSON.parse(res.body).warehouses || [];
    if (!whs.some((w) => w.fullness >= 0.9)) return 0;
    const trim = await httpRequest("POST", `/trimWarehouse?colonyId=${colony.id}&keepPerItem=256`);
    if (trim.status === 200) {
      const d = JSON.parse(trim.body);
      console.log(
        `[supply #${cycle}] warehouse janitor: trimmed ${d.trimmedTotal} items across ${d.trimmedTypes} types`
      );
      return 1;
    }
  } catch {
    // transient
  }
  return 0;
}

// Visitors spawn within +-5 blocks VERTICALLY of the tavern
// (EntityUtils.getSpawnPoint) - i.e. sometimes on its roof - and their
// wander AI also climbs tall buildings via stairs; either way they walk off
// unfenced blueprint edges and splat (all "mystery pit" deaths were
// visitors, 2026-07-08). Rescue any visitor 5+ blocks above ground by
// teleporting them to the tavern forecourt. Citizens are NOT touched
// (builders legitimately work at height).
function rescueElevatedVisitors(colonies) {
  const colony = colonies.find((c) => c.id === 1) || colonies[0];
  if (!colony) return;
  // Keep the historical forecourt offset, but derive it from the active
  // colony instead of teleporting visitors to the retired 200,-60,200 map.
  const rescueSpot = `${colony.x - 29} ${colony.y} ${colony.z + 28}`;
  consoleCmd(
    `execute as @e[type=minecolonies:visitor,y=${colony.y + 5},dy=60] at @s run tp @s ${rescueSpot}`
  );
}

async function loop() {
  let cycle = 0;
  while (true) {
    cycle++;
    // Decay the demand tally into a rolling ~30-cycle window, then publish.
    for (const [item, cnt] of demandTally) {
      const d = cnt * 0.95;
      if (d < 0.5) demandTally.delete(item); else demandTally.set(item, d);
    }
    if (cycle % 10 === 0) writeDemand();
    try {
      const colonies = await getStatus();
      rescueElevatedVisitors(colonies);
      let totalResolved = 0;
      // Tapered items still seen requested this cycle - used to reset the
      // starvation guard for items the economy has caught up on.
      const requestedThisCycle = new Set();

      for (const colony of colonies) {
        if (SUPPLY_MODE === "observe") {
          // Pure recorder: no interventions of any kind (user decision
          // 2026-07-08: full stop, welfare included, for a clean picture).
          const cits = colony.citizens || [];
          observeTimeline.push({
            t: Math.round((Date.now() - observeStart) / 1000),
            citizens: cits.length,
            sick: cits.filter((c) => c.sick).length,
            starving: cits.filter((c) => c.saturation <= 2.5).length,
            pendingBuilds: (colony.buildings || []).filter((b) => b.pending).length,
          });
          for (const building of colony.buildings || []) {
            for (const citizenId of building.workers || []) {
              try {
                const reqs = await getOpenRequests(building.x, building.y, building.z, citizenId);
                for (const req of reqs) recordRequest(building, req);
              } catch { /* transient */ }
            }
          }
          if (cycle % 10 === 0) writeObserveReport(false);
          if (Date.now() - observeStart > OBSERVE_MINUTES * 60000) {
            writeObserveReport(true);
            console.log("[observe] window complete - exiting so colony_watch restarts economy mode");
            process.exit(0);
          }
          continue;
        }
        await refreshTaughtOutputs(colony, cycle);
        // Boot-time taper: sample producer activity and recompute which items
        // the colony now makes for itself (past their time floor). Welfare
        // (feed/cure/restaurant) is intentionally NOT tapered - only material
        // supply retreats to a safety net.
        const citById = new Map((colony.citizens || []).map((c) => [c.id, c]));
        recordProducerActivity(colony, citById);
        const ageDays = colonyAgeDays(colony);
        const currentTapered = computeTapered(ageDays, cycle);
        totalResolved += await treatSickCitizens(colony, cycle);
        totalResolved += await feedHungryCitizens(colony, cycle);
        totalResolved += await stockRestaurants(colony, cycle);
        totalResolved += await autoResearch(colony, cycle);
        totalResolved += await prioritizePopulationResearch(colony, cycle);
        totalResolved += await seedFarmFields(colony, cycle);
        totalResolved += await autoAssignJobs(colony, cycle);
        totalResolved += await staffUniversities(colony, cycle);
        totalResolved += await optimizeHomes(colony, cycle);
        totalResolved += await teachCrafterRecipes(colony, cycle);
        totalResolved += await warehouseJanitor(colony, cycle);
        totalResolved += await fillBuilderHuts(colony, cycle, currentTapered);
        for (const building of colony.buildings) {
          if (building.workers.length === 0) continue;

          for (const citizenId of building.workers) {
            let requests;
            try {
              requests = await getOpenRequests(
                building.x,
                building.y,
                building.z,
                citizenId
              );
            } catch {
              continue;
            }

            for (const req of requests) {
              if (!req.item || req.count <= 0) continue;
              recordDemand(req.item, req.count > 0 ? 1 : 0); // every request is a demand signal
              try {
                if (req.textured && req.materials && req.materials.length > 0) {
                  // Textured (Domum Ornamentum framed-block): give each raw material
                  // to the citizen first, then resolveRequest will consume them and
                  // fulfill the request via the equivalent-exchange logic.
                  for (const mat of req.materials) {
                    if (!mat.item || mat.count <= 0) continue;
                    await giveToCitizen(colony.id, citizenId, mat.item, mat.count);
                    await sleep(RESOLVE_DELAY_MS);
                  }
                  const res = await resolveRequest(building.x, building.y, building.z, citizenId);
                  if (res.status === 200) {
                    console.log(
                      `[supply #${cycle}] resolved textured ${req.item} for citizen ${citizenId}: ${req.description}`
                    );
                    totalResolved++;
                  } else {
                    console.log(`[supply #${cycle}] textured resolve failed: ${res.body}`);
                  }
                } else if (!req.textured) {
                  // Craftable by a colony crafter? Leave it to the real economy
                  // for a grace period; cheat only if it doesn't arrive.
                  if (taughtOutputs.has(req.item)) {
                    const sig = `${building.x},${building.z}:${citizenId}:${req.item}:${req.count}`;
                    const t0 = deferredSince.get(sig) || Date.now();
                    deferredSince.set(sig, t0);
                    if (Date.now() - t0 < CRAFT_DEFER_MS) continue;
                    console.log(
                      `[supply #${cycle}] crafter economy missed ${req.item} x${req.count} for citizen ${citizenId} - cheating it in`
                    );
                    recordDemand(req.item, 3); // a missed craft is a strong "need more capacity" signal
                    deferredSince.delete(sig);
                  }
                  // Boot-time taper gate: if the colony now produces this item
                  // (past its time floor), leave it to the real economy - the
                  // safety net only steps back in once the request has gone
                  // unmet for STARVE_GUARD_MS (economy provably behind), so
                  // construction can never deadlock on a slow producer.
                  if (currentTapered.has(req.item)) {
                    requestedThisCycle.add(req.item);
                    const first = taperedRequestSince.get(req.item) || Date.now();
                    taperedRequestSince.set(req.item, first);
                    if (Date.now() - first < STARVE_GUARD_MS) {
                      continue; // economy owns it this cycle
                    }
                    console.log(
                      `[taper #${cycle}] ${req.item}: economy behind ` +
                      `${Math.round((Date.now() - first) / 1000)}s - safety net supplying (starvation guard)`
                    );
                    recordDemand(req.item, 3); // persistent shortfall => producer needs upgrading
                    taperedRequestSince.delete(req.item); // reset guard after intervening
                  }
                  // Plain material request: give item then close the request.
                  // Give exactly what the request asks for (the old 64-item floor
                  // that avoided re-request round-trips is obsolete now that
                  // fillBuilderResources bulk-stocks the hut racks, and it flooded
                  // citizens with e.g. 64x polished diorite for a 1-block request).
                  const isToolItem = /_(pickaxe|axe|shovel|hoe|sword|bow|crossbow|fishing_rod)$/.test(req.item);
                  const maxMatch = !isToolItem && req.description && req.description.match(/\d+-(\d+)/);
                  const giveCount = isToolItem ? 1 : (maxMatch ? parseInt(maxMatch[1]) : Math.max(req.count, 1));
                  await giveToCitizen(colony.id, citizenId, req.item, giveCount);
                  const res = await resolveRequest(building.x, building.y, building.z, citizenId);
                  if (res.status === 200) {
                    console.log(
                      `[supply #${cycle}] gave ${giveCount}x ${req.item} to citizen ${citizenId} @ (${building.x},${building.y},${building.z}): ${req.description}`
                    );
                    totalResolved++;
                  }
                }
              } catch {
                // ignore transient errors
              }
              await sleep(RESOLVE_DELAY_MS);
            }
          }
        }
      }

      // Reset the starvation guard for tapered items no longer being requested
      // (the economy caught up) so a later re-request starts its timer fresh.
      for (const item of [...taperedRequestSince.keys()]) {
        if (!requestedThisCycle.has(item)) taperedRequestSince.delete(item);
      }

      if (totalResolved > 0) {
        console.log(`[supply #${cycle}] resolved ${totalResolved} request(s)`);
      }
    } catch (e) {
      console.log(`[supply #${cycle}] error:`, e.message);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

// Only auto-start when launched directly (colony_watch / start scripts do
// `node supply_bot.js`); allow `require()` for unit-testing the taper logic
// without kicking off the live poll loop.
if (require.main === module) {
  console.log("[supply_bot] starting - auto-resolving all open citizen requests");
  loop().catch((e) => console.error("FATAL", e));
}

module.exports = {
  shouldTaper, computeTapered, colonyAgeDays, recordProducerActivity, producerActive,
  staffUniversities, isResearchLimited, socialHelpGraceRemaining, CORE_JOBS,
};
