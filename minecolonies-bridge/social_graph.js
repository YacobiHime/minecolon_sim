// social_graph.js - Phase 1 structural relationship graph.
//
// Builds a deterministic, read-only social graph from one colony /status
// snapshot. It does not change citizen behavior. The output is rebuilt from
// authoritative game state, so deaths, moves and job changes cannot leave
// dangling structural links.
const fs = require("fs");
const path = require("path");

const BRIDGE = process.env.BRIDGE || "http://localhost:8089";
const COLONY_ID = parseInt(process.env.COLONY_ID || "1", 10);
const SOCIAL_STATE_FILE = process.env.SOCIAL_STATE_FILE ||
  path.join(__dirname, "social_state.json");
const NEIGHBOR_DISTANCE = parseFloat(process.env.SOCIAL_NEIGHBOR_DISTANCE || "48");

const SOURCE_FAMILIARITY = {
  partner: 0.9,
  parent_child: 0.85,
  sibling: 0.8,
  co_resident: 0.7,
  coworker: 0.55,
  neighbor: 0.35,
};

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function buildingKey(building) {
  if (!building) return null;
  return `${building.x},${building.y},${building.z}`;
}

function edgeKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function nutritionBand(saturation) {
  if (typeof saturation !== "number") return "unknown";
  if (saturation <= 2.5) return "starving";
  if (saturation <= 6) return "hungry";
  return "fed";
}

function pairwise(ids, fn) {
  const unique = [...new Set(ids)].sort((a, b) => a - b);
  for (let i = 0; i < unique.length; i++) {
    for (let j = i + 1; j < unique.length; j++) fn(unique[i], unique[j]);
  }
}

function buildSocialGraph(colony, opts) {
  const o = opts || {};
  const neighborDistance = typeof o.neighborDistance === "number"
    ? o.neighborDistance : NEIGHBOR_DISTANCE;
  const citizens = (colony.citizens || []).slice().sort((a, b) => a.id - b.id);
  const byId = new Map(citizens.map((c) => [c.id, c]));
  const byName = new Map(citizens.filter((c) => c.name).map((c) => [c.name, c]));
  const edges = {};

  function addEdge(a, b, source) {
    if (a === b || !byId.has(a) || !byId.has(b)) return;
    const key = edgeKey(a, b);
    if (!edges[key]) {
      const [left, right] = key.split(":").map(Number);
      edges[key] = { a: left, b: right, sources: [] };
    }
    if (!edges[key].sources.includes(source)) {
      edges[key].sources.push(source);
      edges[key].sources.sort();
    }
  }

  // Family links. Several MineColonies fields overlap, but addEdge de-dupes.
  for (const c of citizens) {
    if (Number.isInteger(c.partner)) addEdge(c.id, c.partner, "partner");
    for (const id of c.children || []) addEdge(c.id, id, "parent_child");
    for (const id of c.siblings || []) addEdge(c.id, id, "sibling");
    for (const parentName of c.parents || []) {
      const parent = byName.get(parentName);
      if (parent) addEdge(c.id, parent.id, "parent_child");
    }
  }

  // Shared residence and workplace groups.
  const homes = new Map();
  const workplaces = new Map();
  for (const c of citizens) {
    const hk = buildingKey(c.homeBuilding);
    if (hk) homes.set(hk, (homes.get(hk) || []).concat(c.id));
    const wk = buildingKey(c.workBuilding);
    if (wk) workplaces.set(wk, (workplaces.get(wk) || []).concat(c.id));
  }
  for (const ids of homes.values()) pairwise(ids, (a, b) => addEdge(a, b, "co_resident"));
  for (const ids of workplaces.values()) pairwise(ids, (a, b) => addEdge(a, b, "coworker"));

  // Residents of separate homes within a short walk are neighbors. Citizens
  // without assigned homes are deliberately excluded instead of guessed.
  const housed = citizens.filter((c) => c.homeBuilding);
  for (let i = 0; i < housed.length; i++) {
    for (let j = i + 1; j < housed.length; j++) {
      const a = housed[i];
      const b = housed[j];
      if (buildingKey(a.homeBuilding) === buildingKey(b.homeBuilding)) continue;
      const dx = a.homeBuilding.x - b.homeBuilding.x;
      const dz = a.homeBuilding.z - b.homeBuilding.z;
      if (Math.hypot(dx, dz) <= neighborDistance) addEdge(a.id, b.id, "neighbor");
    }
  }

  // Phase 1 initializes neutral dynamic values. Phase 2 will update them from
  // explicit events; familiarity alone reflects structural exposure now.
  for (const edge of Object.values(edges)) {
    let unfamiliar = 1;
    for (const source of edge.sources) {
      unfamiliar *= 1 - (SOURCE_FAMILIARITY[source] || 0);
    }
    edge.familiarity = Math.round(clamp01(1 - unfamiliar) * 1000) / 1000;
    edge.trust = 0.5;
    edge.affinity = 0.5;
    edge.debt = 0;
  }

  const degree = Object.fromEntries(citizens.map((c) => [String(c.id), 0]));
  for (const edge of Object.values(edges)) {
    degree[String(edge.a)]++;
    degree[String(edge.b)]++;
  }
  const isolatedCitizenIds = citizens
    .filter((c) => degree[String(c.id)] === 0)
    .map((c) => c.id);
  const sourceCounts = {};
  for (const edge of Object.values(edges)) {
    for (const source of edge.sources) {
      sourceCounts[source] = (sourceCounts[source] || 0) + 1;
    }
  }

  return {
    _meta: {
      version: 1,
      phase: 1,
      colonyId: colony.id,
      colonyName: colony.name,
      gameTime: colony.gameTime,
      neighborDistance,
    },
    nodes: Object.fromEntries(citizens.map((c) => [String(c.id), {
      citizenId: c.id,
      name: c.name,
      isChild: !!c.isChild,
      job: c.job || null,
      nutritionBand: nutritionBand(c.saturation),
      sick: !!c.sick,
      disease: c.disease || null,
      homeBuilding: c.homeBuilding || null,
      workBuilding: c.workBuilding || null,
    }])),
    edges,
    metrics: {
      citizens: citizens.length,
      edges: Object.keys(edges).length,
      isolatedCitizenIds,
      averageDegree: citizens.length
        ? Math.round((2 * Object.keys(edges).length / citizens.length) * 1000) / 1000
        : 0,
      sourceCounts,
    },
  };
}

function saveGraph(graph, file) {
  const target = file || SOCIAL_STATE_FILE;
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(graph, null, 2));
  fs.renameSync(tmp, target);
}

function loadGraph(file) {
  const target = file || SOCIAL_STATE_FILE;
  if (!fs.existsSync(target)) return null;
  return JSON.parse(fs.readFileSync(target, "utf8"));
}

// Structural changes between two complete graph snapshots. Events contain no
// wall-clock timestamp so fixtures remain deterministic; the observer adds it.
function diffGraphs(previous, next) {
  if (!previous) return [];
  const events = [];
  const oldNodes = previous.nodes || {};
  const newNodes = next.nodes || {};
  const oldEdges = previous.edges || {};
  const newEdges = next.edges || {};

  for (const id of Object.keys(newNodes).sort((a, b) => Number(a) - Number(b))) {
    if (!oldNodes[id]) {
      events.push({ type: "citizen_added", citizenId: Number(id), name: newNodes[id].name });
      continue;
    }
    const before = oldNodes[id];
    const after = newNodes[id];
    if (before.job !== after.job) {
      events.push({ type: "job_changed", citizenId: Number(id), from: before.job, to: after.job });
    }
    // Missing fields mean an older persisted graph is being migrated. Save the
    // new baseline without emitting one fake health event per citizen.
    if (before.nutritionBand != null && before.nutritionBand !== after.nutritionBand) {
      events.push({
        type: "nutrition_changed", citizenId: Number(id),
        from: before.nutritionBand, to: after.nutritionBand,
      });
    }
    if (before.sick != null && before.sick !== after.sick) {
      events.push({
        type: after.sick ? "sickness_started" : "recovered",
        citizenId: Number(id), disease: after.sick ? after.disease : before.disease,
      });
    } else if (before.sick && after.sick && before.disease !== after.disease) {
      events.push({
        type: "disease_changed", citizenId: Number(id),
        from: before.disease, to: after.disease,
      });
    }
    const beforeHome = buildingKey(before.homeBuilding);
    const afterHome = buildingKey(after.homeBuilding);
    if (beforeHome !== afterHome) {
      events.push({ type: "home_changed", citizenId: Number(id), from: beforeHome, to: afterHome });
    }
    const beforeWork = buildingKey(before.workBuilding);
    const afterWork = buildingKey(after.workBuilding);
    if (beforeWork !== afterWork) {
      events.push({ type: "work_changed", citizenId: Number(id), from: beforeWork, to: afterWork });
    }
  }
  for (const id of Object.keys(oldNodes).sort((a, b) => Number(a) - Number(b))) {
    if (!newNodes[id]) {
      events.push({ type: "citizen_removed", citizenId: Number(id), name: oldNodes[id].name });
    }
  }
  for (const key of Object.keys(newEdges).sort()) {
    if (!oldEdges[key]) {
      events.push({
        type: "edge_added", edge: key, a: newEdges[key].a, b: newEdges[key].b,
        sources: newEdges[key].sources,
      });
    } else if (JSON.stringify(oldEdges[key].sources) !== JSON.stringify(newEdges[key].sources)) {
      events.push({
        type: "edge_sources_changed", edge: key,
        from: oldEdges[key].sources, to: newEdges[key].sources,
      });
    }
  }
  for (const key of Object.keys(oldEdges).sort()) {
    if (!newEdges[key]) {
      events.push({
        type: "edge_removed", edge: key, a: oldEdges[key].a, b: oldEdges[key].b,
        sources: oldEdges[key].sources,
      });
    }
  }
  return events;
}

async function fetchColony() {
  const res = await fetch(`${BRIDGE}/status`);
  if (!res.ok) throw new Error(`/status HTTP ${res.status}`);
  const colonies = await res.json();
  const colony = colonies.find((c) => c.id === COLONY_ID) || colonies[0];
  if (!colony) throw new Error("no colony in /status");
  return colony;
}

async function main() {
  const graph = buildSocialGraph(await fetchColony());
  saveGraph(graph);
  console.log(JSON.stringify(graph.metrics, null, 2));
}

module.exports = {
  NEIGHBOR_DISTANCE,
  SOURCE_FAMILIARITY,
  buildingKey,
  edgeKey,
  nutritionBand,
  buildSocialGraph,
  saveGraph,
  loadGraph,
  diffGraphs,
  fetchColony,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack || error);
    process.exit(1);
  });
}
