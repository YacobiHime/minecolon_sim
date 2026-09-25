// social_dynamics.js - Phase 2 dynamic citizen/relationship state.
//
// Structural graph snapshots are disposable and rebuilt from /status.
// Dynamic values live here so graph rebuilds never reset accumulated values.
const fs = require("fs");
const path = require("path");

const DYNAMICS_FILE = process.env.SOCIAL_DYNAMICS_FILE ||
  path.join(__dirname, "social_dynamics.json");
const AFFECT_HALF_LIFE_TICKS = parseInt(
  process.env.SOCIAL_AFFECT_HALF_LIFE_TICKS || "24000", 10
);

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function round3(value) {
  return Math.round(clamp01(value) * 1000) / 1000;
}

function emptyState(graph) {
  return {
    _meta: {
      version: 1,
      phase: 2,
      colonyId: graph && graph._meta.colonyId,
      updatedAt: null,
    },
    citizens: {},
    relations: {},
  };
}

function personaFor(personas, citizenId) {
  if (!personas) return null;
  const records = personas.personas || personas;
  return records[String(citizenId)] || null;
}

function initialLoyalty(persona) {
  const value = persona && persona.segments && persona.segments.politics &&
    persona.segments.politics.loyalty;
  return typeof value === "number" ? round3(value) : 0.5;
}

function ensureCitizen(state, node, personas) {
  const key = String(node.citizenId);
  if (!state.citizens[key]) {
    state.citizens[key] = {
      citizenId: node.citizenId,
      name: node.name,
      active: true,
      fear: 0,
      stress: 0,
      satisfaction: 0.5,
      actualLoyalty: initialLoyalty(personaFor(personas, node.citizenId)),
      nutritionBand: node.nutritionBand || "unknown",
      sick: !!node.sick,
      disease: node.disease || null,
      lastEventGameTime: null,
    };
  } else {
    state.citizens[key].name = node.name;
    state.citizens[key].active = true;
    state.citizens[key].nutritionBand = node.nutritionBand || "unknown";
    state.citizens[key].sick = !!node.sick;
    state.citizens[key].disease = node.disease || null;
  }
  return state.citizens[key];
}

function ensureRelation(state, edge) {
  const key = edge.a < edge.b ? `${edge.a}:${edge.b}` : `${edge.b}:${edge.a}`;
  if (!state.relations[key]) {
    state.relations[key] = {
      a: Math.min(edge.a, edge.b),
      b: Math.max(edge.a, edge.b),
      structurallyActive: true,
      sources: (edge.sources || []).slice(),
      trust: 0.5,
      affinity: 0.5,
      debt: 0,
      perspectives: {},
      lastEventGameTime: null,
    };
  } else {
    state.relations[key].structurallyActive = true;
    state.relations[key].sources = (edge.sources || []).slice();
  }
  const relation = state.relations[key];
  relation.perspectives = relation.perspectives || {};
  ensurePerspective(relation, relation.a, relation.b);
  ensurePerspective(relation, relation.b, relation.a);
  updateRelationAggregates(relation);
  return relation;
}

function ensurePerspective(relation, from, toward) {
  const key = String(from);
  if (!relation.perspectives[key]) {
    relation.perspectives[key] = {
      toward,
      trust: typeof relation.trust === "number" ? relation.trust : 0.5,
      affinity: typeof relation.affinity === "number" ? relation.affinity : 0.5,
      obligation: 0,
      affect: { gratitude: 0, resentment: 0, lastGameTime: null },
      memory: {
        helpReceived: 0, helpGiven: 0,
        refusalsReceived: 0, requestsRefused: 0,
        repayments: 0, lastOutcome: null,
      },
      lastEventGameTime: null,
    };
  }
  const perspective = relation.perspectives[key];
  perspective.toward = toward;
  perspective.affect = perspective.affect || {
    gratitude: 0, resentment: 0, lastGameTime: perspective.lastEventGameTime || null,
  };
  perspective.affect.gratitude = round3(perspective.affect.gratitude || 0);
  perspective.affect.resentment = round3(perspective.affect.resentment || 0);
  perspective.memory = perspective.memory || {};
  for (const field of ["helpReceived", "helpGiven", "refusalsReceived", "requestsRefused", "repayments"]) {
    if (!Number.isInteger(perspective.memory[field]) || perspective.memory[field] < 0) {
      perspective.memory[field] = 0;
    }
  }
  if (!Object.hasOwn(perspective.memory, "lastOutcome")) perspective.memory.lastOutcome = null;
  return perspective;
}

// Affect is stored at the last social event and evaluated lazily from absolute
// game time. This makes decay independent of observer polling frequency.
function effectivePerspective(perspective, gameTime, halfLifeTicks) {
  if (!perspective) return null;
  const affect = perspective.affect || { gratitude: 0, resentment: 0, lastGameTime: null };
  const halfLife = Number.isFinite(halfLifeTicks) && halfLifeTicks > 0
    ? halfLifeTicks : AFFECT_HALF_LIFE_TICKS;
  const elapsed = Number.isFinite(gameTime) && Number.isFinite(affect.lastGameTime)
    ? Math.max(0, gameTime - affect.lastGameTime) : 0;
  const factor = Math.pow(0.5, elapsed / halfLife);
  return {
    ...perspective,
    affect: {
      gratitude: round3((affect.gratitude || 0) * factor),
      resentment: round3((affect.resentment || 0) * factor),
      lastGameTime: affect.lastGameTime == null ? null : affect.lastGameTime,
      evaluatedAtGameTime: Number.isFinite(gameTime) ? gameTime : null,
    },
  };
}

function advancePerspectiveAffect(perspective, gameTime) {
  const effective = effectivePerspective(perspective, gameTime);
  perspective.affect = {
    gratitude: effective.affect.gratitude,
    resentment: effective.affect.resentment,
    lastGameTime: Number.isFinite(gameTime) ? gameTime : perspective.affect.lastGameTime,
  };
  return perspective;
}

// Phase 3 action outcomes may already have changed trust/affinity before the
// Phase 3.5 memory schema existed. Rebuild memory/affect from the authoritative
// append-only action log without applying numeric relationship deltas twice.
function backfillActionMemory(state, event, gameTime) {
  if (event.type === "help_succeeded") {
    const recipientView = perspectiveFor(state, event.recipientId, event.helperId);
    const helperView = perspectiveFor(state, event.helperId, event.recipientId);
    if (!recipientView || !helperView) return false;
    advancePerspectiveAffect(recipientView, gameTime);
    advancePerspectiveAffect(helperView, gameTime);
    recipientView.affect.gratitude = round3(recipientView.affect.gratitude + 0.18);
    recipientView.affect.resentment = round3(recipientView.affect.resentment - 0.05);
    recipientView.memory.helpReceived++;
    recipientView.memory.lastOutcome = "received_help";
    helperView.memory.helpGiven++;
    helperView.memory.lastOutcome = "gave_help";
    return true;
  }
  if (event.type === "help_refused") {
    const recipientView = perspectiveFor(state, event.recipientId, event.helperId);
    const helperView = perspectiveFor(state, event.helperId, event.recipientId);
    if (!recipientView || !helperView) return false;
    advancePerspectiveAffect(recipientView, gameTime);
    advancePerspectiveAffect(helperView, gameTime);
    recipientView.affect.resentment = round3(recipientView.affect.resentment + 0.16);
    recipientView.affect.gratitude = round3(recipientView.affect.gratitude - 0.06);
    recipientView.memory.refusalsReceived++;
    recipientView.memory.lastOutcome = "request_refused";
    helperView.memory.requestsRefused++;
    helperView.memory.lastOutcome = "refused_request";
    return true;
  }
  return false;
}

function updateRelationAggregates(relation) {
  const views = Object.values(relation.perspectives || {});
  if (!views.length) return relation;
  relation.trust = round3(views.reduce((sum, p) => sum + p.trust, 0) / views.length);
  relation.affinity = round3(views.reduce((sum, p) => sum + p.affinity, 0) / views.length);
  // Compatibility field for Phase 1/2 readers. Directed obligation is the
  // authoritative representation from Phase 3 onward.
  relation.debt = Math.round(views.reduce((sum, p) => sum + p.obligation, 0) * 1000) / 1000;
  return relation;
}

function relationFor(state, a, b) {
  const key = a < b ? `${a}:${b}` : `${b}:${a}`;
  return state.relations[key] || null;
}

function perspectiveFor(state, from, toward) {
  const relation = relationFor(state, from, toward);
  if (!relation) return null;
  relation.perspectives = relation.perspectives || {};
  return ensurePerspective(relation, from, toward);
}

// Reconcile authoritative membership and structural edges while preserving
// dynamic values and historical relations.
function reconcileState(existing, graph, personas) {
  const state = existing || emptyState(graph);
  state._meta = state._meta || emptyState(graph)._meta;
  state.citizens = state.citizens || {};
  state.relations = state.relations || {};
  const activeIds = new Set();
  for (const node of Object.values(graph.nodes || {})) {
    activeIds.add(String(node.citizenId));
    ensureCitizen(state, node, personas);
  }
  for (const [id, citizen] of Object.entries(state.citizens)) {
    if (!activeIds.has(id)) citizen.active = false;
  }
  const activeEdges = new Set();
  for (const [key, edge] of Object.entries(graph.edges || {})) {
    activeEdges.add(key);
    ensureRelation(state, edge);
  }
  for (const [key, relation] of Object.entries(state.relations)) {
    if (!activeEdges.has(key)) relation.structurallyActive = false;
  }
  state._meta.colonyId = graph._meta.colonyId;
  state._meta.version = Math.max(Number(state._meta.version) || 1, 2);
  state._meta.phase = 3.5;
  return state;
}

function jobPreferenceEffect(persona, job) {
  const pref = persona && persona.segments && persona.segments.jobPreference;
  if (!pref || !job) return { satisfaction: 0, loyalty: 0, preference: "neutral" };
  if ((pref.liked || []).includes(job)) {
    return { satisfaction: 0.1, loyalty: 0.02, preference: "liked" };
  }
  if ((pref.disliked || []).includes(job)) {
    return { satisfaction: -0.15, loyalty: -0.03, preference: "disliked" };
  }
  return { satisfaction: 0, loyalty: 0, preference: "neutral" };
}

function nutritionSeverity(band) {
  return band === "starving" ? 2 : band === "hungry" ? 1 : 0;
}

// Apply one observer event deterministically. Missing from one graph poll is
// inactivity, not death; P1 retains its separate three-poll confirmation.
function applyEvent(state, event, personas, gameTime) {
  const citizen = Number.isInteger(event.citizenId)
    ? state.citizens[String(event.citizenId)] : null;
  const effect = { type: event.type, citizenId: event.citizenId || null };
  if (event.type === "citizen_added" && citizen) {
    citizen.active = true;
  } else if (event.type === "citizen_removed" && citizen) {
    citizen.active = false;
  } else if (event.type === "job_changed" && citizen) {
    const delta = jobPreferenceEffect(personaFor(personas, event.citizenId), event.to);
    citizen.satisfaction = round3(citizen.satisfaction + delta.satisfaction);
    citizen.actualLoyalty = round3(citizen.actualLoyalty + delta.loyalty);
    citizen.lastEventGameTime = gameTime == null ? null : gameTime;
    effect.preference = delta.preference;
    effect.satisfactionDelta = delta.satisfaction;
    effect.loyaltyDelta = delta.loyalty;
  } else if (event.type === "nutrition_changed" && citizen) {
    const severityDelta = nutritionSeverity(event.to) - nutritionSeverity(event.from);
    const stressDelta = 0.1 * severityDelta;
    const satisfactionDelta = -0.05 * severityDelta;
    citizen.stress = round3(citizen.stress + stressDelta);
    citizen.satisfaction = round3(citizen.satisfaction + satisfactionDelta);
    citizen.nutritionBand = event.to;
    citizen.lastEventGameTime = gameTime == null ? null : gameTime;
    effect.stressDelta = stressDelta;
    effect.satisfactionDelta = satisfactionDelta;
  } else if (event.type === "sickness_started" && citizen) {
    citizen.stress = round3(citizen.stress + 0.15);
    citizen.satisfaction = round3(citizen.satisfaction - 0.1);
    citizen.sick = true;
    citizen.disease = event.disease || null;
    citizen.lastEventGameTime = gameTime == null ? null : gameTime;
    effect.stressDelta = 0.15;
    effect.satisfactionDelta = -0.1;
  } else if (event.type === "recovered" && citizen) {
    citizen.stress = round3(citizen.stress - 0.1);
    citizen.satisfaction = round3(citizen.satisfaction + 0.05);
    citizen.sick = false;
    citizen.disease = null;
    citizen.lastEventGameTime = gameTime == null ? null : gameTime;
    effect.stressDelta = -0.1;
    effect.satisfactionDelta = 0.05;
  } else if (event.type === "disease_changed" && citizen) {
    citizen.disease = event.to || null;
    citizen.lastEventGameTime = gameTime == null ? null : gameTime;
  } else if (event.type === "edge_added") {
    ensureRelation(state, event);
  } else if (event.type === "edge_removed") {
    const relation = state.relations[event.edge];
    if (relation) relation.structurallyActive = false;
  } else if (event.type === "edge_sources_changed") {
    const relation = state.relations[event.edge];
    if (relation) relation.sources = (event.to || []).slice();
  } else if (event.type === "help_succeeded") {
    const recipientView = perspectiveFor(state, event.recipientId, event.helperId);
    const helperView = perspectiveFor(state, event.helperId, event.recipientId);
    const relation = relationFor(state, event.helperId, event.recipientId);
    if (recipientView && helperView && relation) {
      advancePerspectiveAffect(recipientView, gameTime);
      advancePerspectiveAffect(helperView, gameTime);
      const repaid = Math.min(helperView.obligation, 0.1);
      recipientView.trust = round3(recipientView.trust + 0.08);
      recipientView.affinity = round3(recipientView.affinity + 0.05);
      recipientView.obligation = round3(recipientView.obligation + 0.1);
      recipientView.affect.gratitude = round3(recipientView.affect.gratitude + 0.18);
      recipientView.affect.resentment = round3(recipientView.affect.resentment - 0.05);
      recipientView.memory.helpReceived++;
      recipientView.memory.lastOutcome = "received_help";
      helperView.affinity = round3(helperView.affinity + 0.02);
      helperView.obligation = round3(helperView.obligation - repaid);
      helperView.memory.helpGiven++;
      helperView.memory.lastOutcome = repaid > 0 ? "repaid_help" : "gave_help";
      if (repaid > 0) helperView.memory.repayments++;
      recipientView.lastEventGameTime = gameTime == null ? null : gameTime;
      helperView.lastEventGameTime = gameTime == null ? null : gameTime;
      relation.lastEventGameTime = gameTime == null ? null : gameTime;
      updateRelationAggregates(relation);
      effect.trustDelta = 0.08;
      effect.affinityDelta = 0.05;
      effect.obligationDelta = 0.1;
      effect.gratitudeDelta = 0.18;
      effect.repaidObligation = Math.round(repaid * 1000) / 1000;
    }
  } else if (event.type === "help_refused") {
    const recipientView = perspectiveFor(state, event.recipientId, event.helperId);
    const helperView = perspectiveFor(state, event.helperId, event.recipientId);
    const relation = relationFor(state, event.helperId, event.recipientId);
    if (recipientView && helperView && relation) {
      advancePerspectiveAffect(recipientView, gameTime);
      advancePerspectiveAffect(helperView, gameTime);
      recipientView.trust = round3(recipientView.trust - 0.06);
      recipientView.affinity = round3(recipientView.affinity - 0.03);
      recipientView.affect.resentment = round3(recipientView.affect.resentment + 0.16);
      recipientView.affect.gratitude = round3(recipientView.affect.gratitude - 0.06);
      recipientView.memory.refusalsReceived++;
      recipientView.memory.lastOutcome = "request_refused";
      helperView.memory.requestsRefused++;
      helperView.memory.lastOutcome = "refused_request";
      recipientView.lastEventGameTime = gameTime == null ? null : gameTime;
      helperView.lastEventGameTime = gameTime == null ? null : gameTime;
      relation.lastEventGameTime = gameTime == null ? null : gameTime;
      updateRelationAggregates(relation);
      effect.trustDelta = -0.06;
      effect.affinityDelta = -0.03;
      effect.resentmentDelta = 0.16;
    }
  } else if (event.type === "help_repaid") {
    const repayerView = perspectiveFor(state, event.repayerId, event.recipientId);
    const relation = relationFor(state, event.repayerId, event.recipientId);
    if (repayerView && relation) {
      advancePerspectiveAffect(repayerView, gameTime);
      const repaid = Math.min(repayerView.obligation, event.amount || 0.1);
      repayerView.obligation = round3(repayerView.obligation - repaid);
      repayerView.memory.repayments++;
      repayerView.memory.lastOutcome = "repaid_help";
      repayerView.lastEventGameTime = gameTime == null ? null : gameTime;
      relation.lastEventGameTime = gameTime == null ? null : gameTime;
      updateRelationAggregates(relation);
      effect.obligationDelta = -repaid;
    }
  }
  return effect;
}

function loadState(file) {
  const target = file || DYNAMICS_FILE;
  if (!fs.existsSync(target)) return null;
  return JSON.parse(fs.readFileSync(target, "utf8"));
}

function saveState(state, file) {
  const target = file || DYNAMICS_FILE;
  state._meta.updatedAt = new Date().toISOString();
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, target);
}

module.exports = {
  DYNAMICS_FILE,
  emptyState,
  initialLoyalty,
  reconcileState,
  jobPreferenceEffect,
  nutritionSeverity,
  AFFECT_HALF_LIFE_TICKS,
  relationFor,
  perspectiveFor,
  effectivePerspective,
  advancePerspectiveAffect,
  backfillActionMemory,
  updateRelationAggregates,
  applyEvent,
  loadState,
  saveState,
};
