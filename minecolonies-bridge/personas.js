// personas.js - Citizen persona schema + storage + heredity library (P1).
//
// Design doc: DESIGN_DECISIONS_persona.md (P-D1..P-D5). One citizen = one
// persona, split into SEGMENTS (genetic units). Heredity = per-segment
// weighted crossover (weight = parent happiness, P-D4) + low-rate mutation.
// Storage is a plain JSON file on the Node side (P-D5) - the bridge never
// sees personas. Deceased citizens are kept forever (family tree material).
//
// This module is pure library code: no polling, no HTTP. persona_daemon.js
// drives it against the live /status; test_persona.js drives it with mocks.
const fs = require("fs");
const path = require("path");

const PERSONAS_FILE = process.env.PERSONAS_FILE || path.join(__dirname, "personas.json");
const TEMPLATES_FILE = process.env.PERSONA_TEMPLATES_FILE || path.join(__dirname, "persona_templates.json");

// ---------- Schema (P-D1) ----------
// Segment = smallest heritable unit. A child inherits each segment WHOLE from
// one parent (never field-by-field), so correlated traits travel together.
// Numeric trait fields all live in [0,1].
const SEGMENT_SPEC = {
  jobPreference: { arrays: ["liked", "disliked"] },
  temperament: { numeric: ["bravery", "empathy", "obedience", "greed", "sociability"] },
  politics: { numeric: ["loyalty", "ambition"] }, // held only for now (war phase reads it; P-D8 judge already uses loyalty)
  combatResponse: { numeric: ["evacuateCivilians", "engage", "callReinforcements", "betray"] },
  speechStyle: { strings: ["tone"], numeric: ["verbosity"] },
};
const SEGMENT_NAMES = Object.keys(SEGMENT_SPEC);

// Known MineColonies job registry names (as they appear in /status "job").
// Used only for jobPreference validation leniency + mutation swap pool.
const JOB_POOL = [
  "farmer", "cook", "baker", "miner", "quarrier", "builder", "lumberjack",
  "fisherman", "deliveryman", "knight", "ranger", "druid", "researcher",
  "teacher", "healer", "composter", "florist", "shepherd", "swineherder",
  "cowboy", "chickenherder", "beekeeper", "smelter", "stonemason",
  "blacksmith", "mechanic", "sawmill", "fletcher", "glassblower", "dyer",
  "concretemixer", "crusher", "sifter", "enchanter", "alchemist",
  "netherworker", "planter", "undertaker",
];

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

// Validate a single segment object against SEGMENT_SPEC. Returns [] or a
// list of human-readable problems.
function validateSegment(name, seg) {
  const spec = SEGMENT_SPEC[name];
  const errs = [];
  if (!spec) return [`unknown segment "${name}"`];
  if (!seg || typeof seg !== "object") return [`segment "${name}" is not an object`];
  for (const f of spec.numeric || []) {
    const v = seg[f];
    if (typeof v !== "number" || Number.isNaN(v)) errs.push(`${name}.${f} is not a number`);
    else if (v < 0 || v > 1) errs.push(`${name}.${f}=${v} out of [0,1]`);
  }
  for (const f of spec.arrays || []) {
    if (!Array.isArray(seg[f])) errs.push(`${name}.${f} is not an array`);
  }
  for (const f of spec.strings || []) {
    if (typeof seg[f] !== "string" || !seg[f]) errs.push(`${name}.${f} is not a non-empty string`);
  }
  return errs;
}

// Validate a full persona record. Returns [] when OK.
function validatePersona(p) {
  const errs = [];
  if (!p || typeof p !== "object") return ["persona is not an object"];
  if (!Number.isInteger(p.citizenId)) errs.push("citizenId must be an integer");
  if (typeof p.name !== "string") errs.push("name must be a string");
  if (!Number.isInteger(p.generation) || p.generation < 0) errs.push("generation must be a non-negative integer");
  if (!Array.isArray(p.parents)) errs.push("parents must be an array (of citizen ids)");
  if (!p.segments || typeof p.segments !== "object") {
    errs.push("segments missing");
    return errs;
  }
  for (const name of SEGMENT_NAMES) {
    if (!p.segments[name]) errs.push(`segment "${name}" missing`);
    else errs.push(...validateSegment(name, p.segments[name]));
  }
  return errs;
}

// ---------- Storage (atomic JSON file) ----------
// File shape: { "_meta": {...}, "personas": { "<citizenId>": {persona} } }.
// Keyed by citizenId for O(1) lookup; nothing is ever deleted (family tree).

function emptyStore() {
  return {
    _meta: {
      _comment: "市民ペルソナ台帳。persona_daemon.js が管理。deceased も家系図として永久保存。手で編集する時はデーモン停止中に。",
      version: 1,
      updatedAt: null,
    },
    personas: {},
  };
}

function loadAll(file) {
  const f = file || PERSONAS_FILE;
  if (!fs.existsSync(f)) return emptyStore();
  const store = JSON.parse(fs.readFileSync(f, "utf8"));
  if (!store.personas) store.personas = {};
  return store;
}

// Atomic write: tmp in the same dir -> rename, so a crash mid-write can
// never truncate the ledger (same-filesystem rename is atomic on Linux).
function saveAll(store, file) {
  const f = file || PERSONAS_FILE;
  store._meta = store._meta || emptyStore()._meta;
  store._meta.updatedAt = new Date().toISOString();
  const tmp = f + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, f);
}

function get(store, citizenId) {
  return store.personas[String(citizenId)] || null;
}

function put(store, persona) {
  const errs = validatePersona(persona);
  if (errs.length) throw new Error(`invalid persona for citizen ${persona && persona.citizenId}: ${errs.join("; ")}`);
  store.personas[String(persona.citizenId)] = persona;
  return persona;
}

// ---------- Templates (P-D2: manually defined generation 0) ----------

function loadTemplates(file) {
  const f = file || TEMPLATES_FILE;
  const data = JSON.parse(fs.readFileSync(f, "utf8"));
  const list = data.templates || [];
  if (!list.length) throw new Error(`no templates in ${f}`);
  return list;
}

// Deep copy that drops _comment keys (templates are human-annotated).
function cloneSegments(segments) {
  const out = {};
  for (const name of SEGMENT_NAMES) {
    out[name] = JSON.parse(JSON.stringify(segments[name]));
    delete out[name]._comment;
  }
  return out;
}

// Assign a template persona to a citizen (generation 0).
// templateId: exact template id, or omit/"random" for a random pick.
function assignFromTemplate(citizen, templateId, opts) {
  const o = opts || {};
  const templates = o.templates || loadTemplates(o.templatesFile);
  const rng = o.rng || Math.random;
  let tpl;
  if (templateId && templateId !== "random") {
    tpl = templates.find((t) => t.id === templateId);
    if (!tpl) throw new Error(`template "${templateId}" not found`);
  } else {
    tpl = templates[Math.floor(rng() * templates.length)];
  }
  const persona = {
    citizenId: citizen.id,
    name: citizen.name || "",
    generation: 0,
    parents: [],
    templateId: tpl.id,
    deceased: false,
    deceasedAt: null,
    createdAt: new Date().toISOString(),
    segments: cloneSegments(tpl.segments),
  };
  const errs = validatePersona(persona);
  if (errs.length) throw new Error(`template "${tpl.id}" produced invalid persona: ${errs.join("; ")}`);
  return persona;
}

// ---------- Heredity (P-D3/P-D4) ----------

// Weighted per-segment crossover. Each segment is inherited WHOLE from
// parent A with probability hA/(hA+hB) (happiness = fitness, P-D4), else
// from parent B. Zero/negative/missing happiness on both sides -> 0.5.
// Returns { segments, segmentOrigins } - origins ("A"/"B" per segment) are
// kept for logging and tests; the caller builds the persona record.
function crossover(parentA, parentB, happinessA, happinessB, rng) {
  const r = rng || Math.random;
  const hA = typeof happinessA === "number" && happinessA > 0 ? happinessA : 0;
  const hB = typeof happinessB === "number" && happinessB > 0 ? happinessB : 0;
  const pA = hA + hB > 0 ? hA / (hA + hB) : 0.5;
  const segments = {};
  const segmentOrigins = {};
  for (const name of SEGMENT_NAMES) {
    const fromA = r() < pA;
    const src = fromA ? parentA.segments[name] : parentB.segments[name];
    segments[name] = JSON.parse(JSON.stringify(src));
    segmentOrigins[name] = fromA ? "A" : "B";
  }
  return { segments, segmentOrigins };
}

// Box-Muller gaussian (mean 0, sigma 1) from a uniform rng.
function gaussian(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Mutation: after segment inheritance, each segment independently mutates
// with probability `rate` (default 0.10). Numeric segments get gaussian
// jitter (sigma 0.15, clamped to [0,1]) on every numeric field; the
// jobPreference segment instead swaps one liked/disliked entry for a random
// job from the pool. Mutates `persona` in place; returns the list of segment
// names that changed (for logging/tests).
function mutate(persona, rate, rng) {
  const r = rng || Math.random;
  const rt = typeof rate === "number" ? rate : 0.1;
  const mutated = [];
  for (const name of SEGMENT_NAMES) {
    if (r() >= rt) continue;
    const seg = persona.segments[name];
    const spec = SEGMENT_SPEC[name];
    if (name === "jobPreference") {
      const listName = r() < 0.5 ? "liked" : "disliked";
      const list = seg[listName];
      const newJob = JOB_POOL[Math.floor(r() * JOB_POOL.length)];
      if (Array.isArray(list) && list.length > 0) {
        list[Math.floor(r() * list.length)] = newJob;
      } else if (Array.isArray(list)) {
        list.push(newJob);
      }
    } else {
      for (const f of spec.numeric || []) {
        seg[f] = clamp01(seg[f] + gaussian(r) * 0.15);
        // 2 decimals keeps personas.json readable; precision beyond that is noise.
        seg[f] = Math.round(seg[f] * 100) / 100;
      }
    }
    mutated.push(name);
  }
  return mutated;
}

// Build a child persona from two parent personas (P-D3 step 3-4).
// extra: { parentsSynthesized?:bool, mutationRate?:number, rng?:fn }
function makeChildPersona(citizen, parentA, parentB, happinessA, happinessB, extra) {
  const e = extra || {};
  const { segments, segmentOrigins } = crossover(parentA, parentB, happinessA, happinessB, e.rng);
  const persona = {
    citizenId: citizen.id,
    name: citizen.name || "",
    generation: Math.max(parentA.generation, parentB.generation) + 1,
    parents: [parentA.citizenId, parentB.citizenId],
    parentsSynthesized: !!e.parentsSynthesized,
    deceased: false,
    deceasedAt: null,
    createdAt: new Date().toISOString(),
    segments,
    segmentOrigins,
  };
  persona.mutatedSegments = mutate(persona, e.mutationRate, e.rng);
  const errs = validatePersona(persona);
  if (errs.length) throw new Error(`child persona invalid for citizen ${citizen.id}: ${errs.join("; ")}`);
  return persona;
}

// Mark a citizen's persona as deceased (never delete - family tree, P1 spec).
// Returns the persona, or null if none exists.
function markDeceased(store, citizenId, when) {
  const p = get(store, citizenId);
  if (!p || p.deceased) return p;
  p.deceased = true;
  p.deceasedAt = when || new Date().toISOString();
  return p;
}

// Reverse a provisional death when MineColonies reports the same citizen id
// again.  /status can temporarily omit citizen data, so absence-based death
// detection is not authoritative.  Keeping this transition reversible avoids
// permanently corrupting the persona/family ledger after a long chunk unload.
function markAlive(store, citizenId, liveName) {
  const p = get(store, citizenId);
  if (!p || !p.deceased) return p;
  p.deceased = false;
  p.deceasedAt = null;
  if (liveName) p.name = liveName;
  return p;
}

// Happiness-weighted sampling of `count` distinct entries from
// [{id, happiness}, ...]. Fallback parent lottery (P-D3 step 2) when
// MineColonies parent names can't be resolved - selection pressure still
// flows through happiness. Missing/zero happiness counts as 1 so nobody has
// literally zero chance.
function weightedSample(candidates, count, rng) {
  const r = rng || Math.random;
  const pool = candidates.slice();
  const picked = [];
  while (picked.length < count && pool.length > 0) {
    const total = pool.reduce((s, c) => s + (c.happiness > 0 ? c.happiness : 1), 0);
    let roll = r() * total;
    let idx = 0;
    for (; idx < pool.length; idx++) {
      roll -= pool[idx].happiness > 0 ? pool[idx].happiness : 1;
      if (roll <= 0) break;
    }
    if (idx >= pool.length) idx = pool.length - 1;
    picked.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return picked;
}

module.exports = {
  PERSONAS_FILE,
  TEMPLATES_FILE,
  SEGMENT_NAMES,
  SEGMENT_SPEC,
  JOB_POOL,
  validatePersona,
  validateSegment,
  emptyStore,
  loadAll,
  saveAll,
  get,
  put,
  loadTemplates,
  assignFromTemplate,
  crossover,
  mutate,
  makeChildPersona,
  markDeceased,
  markAlive,
  weightedSample,
  gaussian,
};
