// persona_daemon.js - Citizen persona lifecycle daemon (P1).
//
// Polls the bridge /status and keeps personas.json in sync with the colony:
//   - first poll: every citizen without a persona gets a random template
//     (generation 0 baseline; P-D2)
//   - later polls: a NEW citizen id = a birth -> resolve its MineColonies
//     parents (parents come as NAMES from /status, added in P0) to citizen
//     ids, then weighted crossover + mutation (P-D3/P-D4). When parents
//     can't be resolved, two adults are drawn by happiness-weighted lottery
//     and marked parentsSynthesized:true - selection pressure still flows
//     through happiness.
//   - a citizen id missing for 3 consecutive polls = provisional death ->
//     deceased mark (never deleted; family tree). If the same id later
//     reappears, automatically reverse the mark because /status absence is not
//     authoritative proof of death.
//
// Live wiring is the operator's job; everything here is driven through
// processStatus() so test_persona.js can feed it mock /status fixtures.
const fs = require("fs");
const path = require("path");
const P = require("./personas.js");

const BRIDGE = process.env.BRIDGE || "http://localhost:8089";
const POLL_MS = parseInt(process.env.PERSONA_POLL_MS || "30000", 10);
const COLONY_ID = parseInt(process.env.COLONY_ID || "1", 10);
const MUTATION_RATE = parseFloat(process.env.PERSONA_MUTATION_RATE || "0.1");
const LOG_FILE = process.env.PERSONA_LOG_FILE || path.join(__dirname, "persona_daemon.log");
const PID_FILE = path.join(__dirname, "persona_daemon.pid");
// A citizen must be absent this many CONSECUTIVE polls before we call it dead.
const DEATH_CONFIRM_POLLS = 3;

// One event per line as JSON - grep/jq friendly, same spirit as the other
// daemons' logs.
function logEvent(event, fields, logFile) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...fields });
  try {
    fs.appendFileSync(logFile || LOG_FILE, line + "\n");
  } catch {
    /* logging must never kill the daemon */
  }
  console.log(line);
}

// ---------- Core: one poll's worth of reconciliation ----------
// store:    personas store (P.loadAll())
// citizens: the citizens array of our colony from /status
// state:    daemon memory across polls: { baselineDone, missingCounts: {id: n} }
// opts:     { templates, rng, mutationRate, logFile, now } - injectable for tests
// Returns { changed, events } and mutates store/state in place.
function processStatus(store, citizens, state, opts) {
  const o = opts || {};
  const rng = o.rng || Math.random;
  const templates = o.templates || P.loadTemplates(o.templatesFile);
  const mutationRate = typeof o.mutationRate === "number" ? o.mutationRate : MUTATION_RATE;
  const events = [];
  let changed = false;

  const byId = new Map();
  const byName = new Map(); // name -> citizen (parents are NAMES in /status)
  for (const c of citizens) {
    byId.set(c.id, c);
    if (c.name) byName.set(c.name, c);
  }

  // A long transient omission can pass the absence threshold.  Reconcile it
  // before birth detection so an existing persona is restored, not replaced.
  for (const c of citizens) {
    const persona = P.get(store, c.id);
    if (!persona || !persona.deceased) continue;
    P.markAlive(store, c.id, c.name);
    if (state.missingCounts[c.id]) delete state.missingCounts[c.id];
    events.push({
      event: "restored",
      citizenId: c.id,
      name: c.name || persona.name,
      reason: "citizen-reappeared-after-absence",
    });
    changed = true;
  }

  // Citizen display names can change while the stable MineColonies id and
  // lineage remain the same. Keep the persona ledger readable without
  // replacing the inherited persona or treating a rename as a new birth.
  for (const c of citizens) {
    const persona = P.get(store, c.id);
    if (!persona || !c.name || persona.name === c.name) continue;
    const previousName = persona.name;
    persona.name = c.name;
    events.push({
      event: "identity_updated",
      citizenId: c.id,
      previousName,
      name: c.name,
    });
    changed = true;
  }

  // --- new citizens ---
  for (const c of citizens) {
    if (P.get(store, c.id)) continue;
    if (!state.baselineDone) {
      // Startup baseline: everyone unknown is generation 0 from a template.
      const persona = P.assignFromTemplate(c, "random", { templates, rng });
      P.put(store, persona);
      events.push({ event: "assign", citizenId: c.id, name: c.name, templateId: persona.templateId });
      changed = true;
      continue;
    }
    // Birth: resolve parent names -> living citizens with personas.
    const parentNames = Array.isArray(c.parents) ? c.parents : [];
    const resolved = [];
    for (const pname of parentNames) {
      const pc = byName.get(pname);
      if (pc && P.get(store, pc.id)) resolved.push(pc);
    }
    let parentA = null;
    let parentB = null;
    let synthesized = false;
    if (resolved.length >= 2) {
      [parentA, parentB] = resolved;
    } else {
      // Fallback lottery (P-D3 step 2): adults with personas, weighted by
      // happiness. If exactly one real parent resolved, keep it and draw
      // only the missing one.
      const adults = citizens.filter(
        (a) => !a.isChild && a.id !== c.id && P.get(store, a.id) &&
          (!resolved[0] || a.id !== resolved[0].id)
      ).map((a) => ({ id: a.id, happiness: happinessOf(a), citizen: a }));
      const need = 2 - resolved.length;
      const drawn = P.weightedSample(adults, need, rng).map((d) => d.citizen);
      const pair = resolved.concat(drawn);
      if (pair.length < 2) {
        // Colony too small to synthesize parents - fall back to a template
        // so the newborn is never persona-less.
        const persona = P.assignFromTemplate(c, "random", { templates, rng });
        P.put(store, persona);
        events.push({ event: "assign", citizenId: c.id, name: c.name, templateId: persona.templateId, reason: "no-parents-available" });
        changed = true;
        continue;
      }
      [parentA, parentB] = pair;
      synthesized = true;
    }
    const pA = P.get(store, parentA.id);
    const pB = P.get(store, parentB.id);
    const child = P.makeChildPersona(c, pA, pB, happinessOf(parentA), happinessOf(parentB), {
      parentsSynthesized: synthesized,
      mutationRate,
      rng,
    });
    P.put(store, child);
    events.push({
      event: "birth", citizenId: c.id, name: c.name,
      parents: child.parents, parentsSynthesized: synthesized,
      generation: child.generation, segmentOrigins: child.segmentOrigins,
      mutatedSegments: child.mutatedSegments,
    });
    changed = true;
  }

  // --- deaths (3 consecutive missing polls; P1 spec) ---
  for (const idStr of Object.keys(store.personas)) {
    const persona = store.personas[idStr];
    if (persona.deceased) continue;
    const id = persona.citizenId;
    if (byId.has(id)) {
      if (state.missingCounts[id]) delete state.missingCounts[id];
      continue;
    }
    state.missingCounts[id] = (state.missingCounts[id] || 0) + 1;
    if (state.missingCounts[id] >= DEATH_CONFIRM_POLLS) {
      P.markDeceased(store, id, o.now);
      delete state.missingCounts[id];
      events.push({ event: "deceased", citizenId: id, name: persona.name });
      changed = true;
    }
  }

  state.baselineDone = true;
  return { changed, events };
}

// /status doesn't carry happiness yet (P0 didn't add it) - default to a
// neutral 5 (MineColonies happiness is 0..10) so crossover weights stay 0.5
// until the bridge exposes the real value.
function happinessOf(citizen) {
  return typeof citizen.happiness === "number" ? citizen.happiness : 5;
}

// ---------- Live plumbing ----------

async function fetchCitizens() {
  const res = await fetch(`${BRIDGE}/status`);
  if (!res.ok) throw new Error(`/status HTTP ${res.status}`);
  const colonies = await res.json();
  const colony = colonies.find((c) => c.id === COLONY_ID) || colonies[0];
  if (!colony) throw new Error("no colony in /status");
  return colony.citizens || [];
}

// Single-instance guard. No shared pidfile convention exists (supply_bot and
// council are guarded externally by colony_watch.sh's pgrep count), so use a
// plain pidfile: stale files (dead pid) are reclaimed automatically.
function acquirePidfile() {
  try {
    const old = parseInt(fs.readFileSync(PID_FILE, "utf8"), 10);
    if (old && !Number.isNaN(old)) {
      try {
        process.kill(old, 0); // throws if the pid is gone
        console.error(`persona_daemon already running (pid ${old}); exiting`);
        process.exit(1);
      } catch {
        /* stale pidfile - take over */
      }
    }
  } catch {
    /* no pidfile */
  }
  fs.writeFileSync(PID_FILE, String(process.pid));
  const cleanup = () => {
    try {
      if (fs.readFileSync(PID_FILE, "utf8") === String(process.pid)) fs.unlinkSync(PID_FILE);
    } catch {}
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}

async function main() {
  acquirePidfile();
  logEvent("start", { bridge: BRIDGE, pollMs: POLL_MS, colonyId: COLONY_ID, personasFile: P.PERSONAS_FILE });
  const templates = P.loadTemplates();
  const state = { baselineDone: false, missingCounts: {} };
  // Loaded once and kept in memory, saved on change. The daemon is the only
  // writer; manual edits require stopping it first (noted in _meta).
  const store = P.loadAll();
  // If personas already exist (daemon restart), don't re-baseline: unknown
  // citizens on the first poll after a restart could be births that happened
  // while we were down. Their parents are still resolvable by name, and the
  // no-parents fallback covers the rest, so treat first poll as live.
  if (Object.keys(store.personas).length > 0) state.baselineDone = true;

  for (;;) {
    try {
      const citizens = await fetchCitizens();
      const { changed, events } = processStatus(store, citizens, state, { templates });
      for (const ev of events) logEvent(ev.event, ev);
      if (changed) P.saveAll(store);
    } catch (e) {
      logEvent("error", { message: String(e && e.message || e) });
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

module.exports = { processStatus, happinessOf, DEATH_CONFIRM_POLLS, logEvent };

if (require.main === module) {
  main().catch((e) => {
    logEvent("fatal", { message: String(e && e.stack || e) });
    process.exit(1);
  });
}
