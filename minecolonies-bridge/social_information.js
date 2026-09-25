// Phase 4 local information propagation over the structural social graph.
// Structured messages are authoritative; later LLM text is presentation only.
const P = require("./personas.js");
const D = require("./social_dynamics.js");
const A = require("./social_appraisal.js");
const E = require("./social_experiment.js");

const CONDITIONS = E.CONDITIONS;

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function trait(persona, field, fallback) {
  const value = persona && persona.segments && persona.segments.temperament &&
    persona.segments.temperament[field];
  return typeof value === "number" ? value : fallback;
}

function neighbors(graph) {
  const out = Object.fromEntries(Object.keys(graph.nodes || {}).map((id) => [id, []]));
  for (const [edgeKey, edge] of Object.entries(graph.edges || {}).sort()) {
    if (!out[String(edge.a)] || !out[String(edge.b)]) continue;
    const link = {
      edgeKey, sources: (edge.sources || []).slice(), familiarity: edge.familiarity || 0,
    };
    out[String(edge.a)].push({ citizenId: edge.b, ...link });
    out[String(edge.b)].push({ citizenId: edge.a, ...link });
  }
  for (const list of Object.values(out)) list.sort((a, b) => a.citizenId - b.citizenId);
  return out;
}

function conditionInputs(condition, persona, view, familiarity) {
  const neutralView = {
    trust: 0.5, affinity: 0.5, obligation: 0,
    affect: { gratitude: 0, resentment: 0 },
  };
  if (condition === "uniform") {
    return { persona: E.NEUTRAL_PERSONA, view: neutralView, familiarity: 0 };
  }
  if (condition === "persona") return { persona, view: neutralView, familiarity: 0 };
  if (condition === "persona_relation") {
    return {
      persona,
      view: { ...view, obligation: 0, affect: { gratitude: 0, resentment: 0 } },
      familiarity,
    };
  }
  if (condition === "temporal") return { persona, view, familiarity };
  throw new Error(`unknown propagation condition: ${condition}`);
}

function evaluateTransmission(input, opts) {
  const o = opts || {};
  const persona = input.persona || E.NEUTRAL_PERSONA;
  const view = input.view || {};
  const affect = view.affect || {};
  const values = A.deriveValues(persona);
  const trust = typeof view.trust === "number" ? view.trust : 0.5;
  const familiarity = typeof input.familiarity === "number" ? input.familiarity : 0;
  const urgency = clamp01(input.message && input.message.urgency == null
    ? 0.7 : input.message.urgency);
  const sociability = trait(persona, "sociability", 0.5);
  const gratitude = affect.gratitude || 0;
  const resentment = affect.resentment || 0;
  const acceptScore = round4(clamp01(
    0.4 * trust + 0.15 * familiarity + 0.15 * sociability +
    0.15 * urgency + 0.1 * gratitude - 0.15 * resentment
  ));
  const relayScore = round4(clamp01(
    0.3 * sociability + 0.25 * urgency + 0.2 * values.community +
    0.15 * trust + 0.1 * familiarity
  ));
  const mode = o.mode || "seeded";
  const accepted = mode === "max"
    ? acceptScore >= (o.acceptThreshold == null ? 0.5 : o.acceptThreshold)
    : A.seededUnit(`${o.seed}:accept`) < acceptScore;
  const relayed = accepted && (mode === "max"
    ? relayScore >= (o.relayThreshold == null ? 0.5 : o.relayThreshold)
    : A.seededUnit(`${o.seed}:relay`) < relayScore);
  return {
    accepted,
    relayed,
    acceptScore,
    relayScore,
    factors: { trust, familiarity, sociability, urgency, gratitude, resentment,
      community: values.community },
  };
}

function validateMessage(message) {
  if (!message || typeof message !== "object") throw new Error("message is required");
  if (!message.messageId) throw new Error("messageId is required");
  if (!Number.isInteger(message.originCitizenId)) throw new Error("originCitizenId must be an integer");
  if (!Number.isFinite(message.createdGameTime)) throw new Error("createdGameTime is required");
  if (!Number.isFinite(message.ttlTicks) || message.ttlTicks <= 0) throw new Error("ttlTicks must be positive");
  if (!Number.isInteger(message.maxHops) || message.maxHops < 0) throw new Error("maxHops must be non-negative");
}

function propagate(input, opts) {
  const o = opts || {};
  const { graph, dynamics, personas, message } = input;
  validateMessage(message);
  if (!graph.nodes[String(message.originCitizenId)]) throw new Error("origin is not in graph");
  const condition = o.condition || "temporal";
  const hopTicks = Number.isFinite(o.hopTicks) && o.hopTicks > 0 ? o.hopTicks : 200;
  const adjacency = neighbors(graph);
  const accepted = new Map([[message.originCitizenId, {
    citizenId: message.originCitizenId, hop: 0, receivedGameTime: message.createdGameTime,
    fromCitizenId: null, path: [message.originCitizenId],
  }]]);
  const queue = [{ citizenId: message.originCitizenId, hop: 0, path: [message.originCitizenId] }];
  const attempted = new Set();
  const transmissions = [];
  while (queue.length) {
    const current = queue.shift();
    if (current.hop >= message.maxHops) continue;
    for (const link of adjacency[String(current.citizenId)] || []) {
      const receiverId = link.citizenId;
      if (accepted.has(receiverId)) continue;
      const attemptKey = `${current.citizenId}>${receiverId}`;
      if (attempted.has(attemptKey)) continue;
      attempted.add(attemptKey);
      const hop = current.hop + 1;
      const arrival = message.createdGameTime + hop * hopTicks;
      if (arrival > message.createdGameTime + message.ttlTicks) {
        transmissions.push({
          fromCitizenId: current.citizenId, toCitizenId: receiverId,
          hop, arrivalGameTime: arrival, accepted: false, relayed: false, reason: "expired",
        });
        continue;
      }
      const persona = P.get(personas, receiverId) || E.NEUTRAL_PERSONA;
      const storedView = D.perspectiveFor(dynamics, receiverId, current.citizenId);
      const effectiveView = D.effectivePerspective(storedView, arrival) || {};
      const factors = conditionInputs(condition, persona, effectiveView, link.familiarity);
      const decision = evaluateTransmission({ ...factors, message }, {
        ...o, seed: `${o.seed || message.messageId}:${attemptKey}:${hop}`,
      });
      const record = {
        fromCitizenId: current.citizenId, toCitizenId: receiverId,
        edgeKey: link.edgeKey, sources: link.sources,
        hop, arrivalGameTime: arrival, ...decision,
      };
      transmissions.push(record);
      if (!decision.accepted) continue;
      const path = current.path.concat(receiverId);
      accepted.set(receiverId, {
        citizenId: receiverId, hop, receivedGameTime: arrival,
        fromCitizenId: current.citizenId, path,
      });
      if (decision.relayed) queue.push({ citizenId: receiverId, hop, path });
    }
  }
  const population = Object.keys(graph.nodes || {}).length;
  const reached = [...accepted.values()].sort((a, b) => a.hop - b.hop || a.citizenId - b.citizenId);
  const reachedIds = new Set(reached.map((x) => String(x.citizenId)));
  const evaluated = transmissions.filter((x) => typeof x.acceptScore === "number");
  return {
    schema: "voyager-local-information-v1",
    condition,
    message: { ...message },
    metrics: {
      population,
      reached: reached.length,
      coverage: round4(population ? reached.length / population : 0),
      attempts: transmissions.length,
      acceptedTransmissions: transmissions.filter((x) => x.accepted).length,
      rejectedTransmissions: transmissions.filter((x) => !x.accepted && x.reason !== "expired").length,
      expiredTransmissions: transmissions.filter((x) => x.reason === "expired").length,
      relayed: transmissions.filter((x) => x.relayed).length,
      maxHop: reached.reduce((max, x) => Math.max(max, x.hop), 0),
      meanHop: round4(reached.length ? reached.reduce((sum, x) => sum + x.hop, 0) / reached.length : 0),
      meanAcceptScore: round4(evaluated.length
        ? evaluated.reduce((sum, x) => sum + x.acceptScore, 0) / evaluated.length : 0),
      meanRelayScore: round4(evaluated.length
        ? evaluated.reduce((sum, x) => sum + x.relayScore, 0) / evaluated.length : 0),
      unreachedCitizenIds: Object.keys(graph.nodes || {}).filter((id) => !reachedIds.has(id)).map(Number),
    },
    reached,
    transmissions,
  };
}

module.exports = {
  CONDITIONS, neighbors, conditionInputs, evaluateTransmission, propagate, validateMessage,
};
