// Phase 3.6 detailed, inspectable cognitive profile derived from P1.
//
// These are computational constructs for the simulation, not clinical or
// psychometric claims. P1 remains the heritable source of truth. Every derived
// value includes a contribution trace so experiments can explain and ablate it.

const SCHEMA = "voyager-cognition-v1";

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function trait(persona, segment, field, fallback) {
  const value = persona && persona.segments && persona.segments[segment] &&
    persona.segments[segment][field];
  return typeof value === "number" ? value : fallback;
}

function term(source, input, weight) {
  return { source, input: round3(input), weight, contribution: round3(input * weight) };
}

function derive(terms, bias) {
  const b = typeof bias === "number" ? bias : 0;
  const raw = b + terms.reduce((sum, x) => sum + x.contribution, 0);
  return {
    value: round3(clamp01(raw)),
    trace: { bias: round3(b), raw: round3(raw), terms },
  };
}

function add(section, trace, name, result) {
  section[name] = result.value;
  trace[name] = result.trace;
  return result.value;
}

function nutritionSeverity(band) {
  return band === "starving" ? 1 : band === "hungry" ? 0.5 : 0;
}

function stateNeedSeverity(state) {
  if (state && typeof state.needSeverity === "number") {
    return clamp01(state.needSeverity);
  }
  return nutritionSeverity(state && state.nutritionBand);
}

function isFamily(sources) {
  return (sources || []).some((source) =>
    ["partner", "parent_child", "sibling"].includes(source)
  );
}

function buildCognitiveProfile(persona, context) {
  const c = context || {};
  const temperament = {
    bravery: trait(persona, "temperament", "bravery", 0.5),
    empathy: trait(persona, "temperament", "empathy", 0.5),
    obedience: trait(persona, "temperament", "obedience", 0.5),
    greed: trait(persona, "temperament", "greed", 0.5),
    sociability: trait(persona, "temperament", "sociability", 0.5),
  };
  const politics = {
    loyalty: trait(persona, "politics", "loyalty", 0.5),
    ambition: trait(persona, "politics", "ambition", 0.5),
  };
  const stable = {
    values: {}, needPriorities: {}, motives: {}, norms: {},
    coping: {}, emotionDynamics: {}, decisionStyle: {},
  };
  const trace = {
    values: {}, needPriorities: {}, motives: {}, norms: {},
    coping: {}, emotionDynamics: {}, decisionStyle: {}, activeGoals: {},
  };
  const v = stable.values;
  add(v, trace.values, "family", derive([
    term("empathy", temperament.empathy, 0.5),
    term("loyalty", politics.loyalty, 0.3),
    term("1-greed", 1 - temperament.greed, 0.2),
  ]));
  add(v, trace.values, "community", derive([
    term("loyalty", politics.loyalty, 0.6),
    term("empathy", temperament.empathy, 0.25),
    term("obedience", temperament.obedience, 0.15),
  ]));
  add(v, trace.values, "fairness", derive([
    term("empathy", temperament.empathy, 0.45),
    term("1-greed", 1 - temperament.greed, 0.35),
    term("obedience", temperament.obedience, 0.2),
  ]));
  add(v, trace.values, "reciprocity", derive([
    term("empathy", temperament.empathy, 0.4),
    term("sociability", temperament.sociability, 0.3),
    term("1-greed", 1 - temperament.greed, 0.3),
  ]));
  add(v, trace.values, "autonomy", derive([
    term("1-obedience", 1 - temperament.obedience, 0.65),
    term("ambition", politics.ambition, 0.35),
  ]));

  const motives = stable.motives;
  add(motives, trace.motives, "care", derive([
    term("empathy", temperament.empathy, 0.5),
    term("familyValue", v.family, 0.25),
    term("communityValue", v.community, 0.25),
  ]));
  add(motives, trace.motives, "affiliation", derive([
    term("sociability", temperament.sociability, 0.45),
    term("communityValue", v.community, 0.3),
    term("empathy", temperament.empathy, 0.25),
  ]));
  add(motives, trace.motives, "achievement", derive([
    term("ambition", politics.ambition, 0.5),
    term("autonomyValue", v.autonomy, 0.25),
    term("bravery", temperament.bravery, 0.25),
  ]));
  add(motives, trace.motives, "security", derive([
    term("1-bravery", 1 - temperament.bravery, 0.45),
    term("loyalty", politics.loyalty, 0.3),
    term("obedience", temperament.obedience, 0.25),
  ]));
  add(motives, trace.motives, "resourceProtection", derive([
    term("greed", temperament.greed, 0.5),
    term("securityMotive", motives.security, 0.3),
    term("autonomyValue", v.autonomy, 0.2),
  ]));

  const needs = stable.needPriorities;
  add(needs, trace.needPriorities, "belonging", derive([
    term("affiliationMotive", motives.affiliation, 0.55),
    term("communityValue", v.community, 0.3),
    term("loyalty", politics.loyalty, 0.15),
  ]));
  add(needs, trace.needPriorities, "competence", derive([
    term("achievementMotive", motives.achievement, 0.55),
    term("ambition", politics.ambition, 0.3),
    term("bravery", temperament.bravery, 0.15),
  ]));
  add(needs, trace.needPriorities, "autonomy", derive([
    term("autonomyValue", v.autonomy, 0.7),
    term("achievementMotive", motives.achievement, 0.3),
  ]));
  add(needs, trace.needPriorities, "security", derive([
    term("securityMotive", motives.security, 0.7),
    term("resourceProtection", motives.resourceProtection, 0.3),
  ]));
  add(needs, trace.needPriorities, "caregiving", derive([
    term("careMotive", motives.care, 0.65),
    term("familyValue", v.family, 0.2),
    term("reciprocityValue", v.reciprocity, 0.15),
  ]));

  const norms = stable.norms;
  add(norms, trace.norms, "careForKin", derive([
    term("familyValue", v.family, 0.5),
    term("careMotive", motives.care, 0.35),
    term("loyalty", politics.loyalty, 0.15),
  ]));
  add(norms, trace.norms, "reciprocateHelp", derive([
    term("reciprocityValue", v.reciprocity, 0.55),
    term("fairnessValue", v.fairness, 0.25),
    term("loyalty", politics.loyalty, 0.2),
  ]));
  add(norms, trace.norms, "aidCommunity", derive([
    term("communityValue", v.community, 0.5),
    term("careMotive", motives.care, 0.3),
    term("obedience", temperament.obedience, 0.2),
  ]));
  add(norms, trace.norms, "actFairly", derive([
    term("fairnessValue", v.fairness, 0.7),
    term("empathy", temperament.empathy, 0.3),
  ]));
  add(norms, trace.norms, "selfPreservation", derive([
    term("securityMotive", motives.security, 0.5),
    term("resourceProtection", motives.resourceProtection, 0.3),
    term("1-careMotive", 1 - motives.care, 0.2),
  ]));

  const decision = stable.decisionStyle;
  add(decision, trace.decisionStyle, "riskTolerance", derive([
    term("bravery", temperament.bravery, 0.55),
    term("autonomyValue", v.autonomy, 0.25),
    term("ambition", politics.ambition, 0.2),
  ]));
  add(decision, trace.decisionStyle, "normSensitivity", derive([
    term("obedience", temperament.obedience, 0.4),
    term("fairnessValue", v.fairness, 0.3),
    term("communityValue", v.community, 0.3),
  ]));
  add(decision, trace.decisionStyle, "futureOrientation", derive([
    term("ambition", politics.ambition, 0.35),
    term("securityMotive", motives.security, 0.3),
    term("obedience", temperament.obedience, 0.2),
    term("loyalty", politics.loyalty, 0.15),
  ]));
  add(decision, trace.decisionStyle, "exploration", derive([
    term("autonomyValue", v.autonomy, 0.45),
    term("sociability", temperament.sociability, 0.3),
    term("bravery", temperament.bravery, 0.25),
  ]));

  const coping = stable.coping;
  add(coping, trace.coping, "problemFocused", derive([
    term("bravery", temperament.bravery, 0.35),
    term("futureOrientation", decision.futureOrientation, 0.3),
    term("achievementMotive", motives.achievement, 0.2),
    term("obedience", temperament.obedience, 0.15),
  ]));
  add(coping, trace.coping, "supportSeeking", derive([
    term("sociability", temperament.sociability, 0.5),
    term("affiliationMotive", motives.affiliation, 0.3),
    term("empathy", temperament.empathy, 0.2),
  ]));
  add(coping, trace.coping, "avoidance", derive([
    term("1-bravery", 1 - temperament.bravery, 0.5),
    term("securityMotive", motives.security, 0.3),
    term("1-obedience", 1 - temperament.obedience, 0.2),
  ]));
  add(coping, trace.coping, "confrontation", derive([
    term("bravery", temperament.bravery, 0.5),
    term("ambition", politics.ambition, 0.3),
    term("1-empathy", 1 - temperament.empathy, 0.2),
  ]));

  const emotion = stable.emotionDynamics;
  add(emotion, trace.emotionDynamics, "concernSensitivity", derive([
    term("empathy", temperament.empathy, 0.55),
    term("careMotive", motives.care, 0.3),
    term("affiliationMotive", motives.affiliation, 0.15),
  ]));
  add(emotion, trace.emotionDynamics, "threatSensitivity", derive([
    term("1-bravery", 1 - temperament.bravery, 0.55),
    term("securityMotive", motives.security, 0.3),
    term("1-riskTolerance", 1 - decision.riskTolerance, 0.15),
  ]));
  add(emotion, trace.emotionDynamics, "reappraisal", derive([
    term("futureOrientation", decision.futureOrientation, 0.35),
    term("empathy", temperament.empathy, 0.25),
    term("obedience", temperament.obedience, 0.2),
    term("problemFocused", coping.problemFocused, 0.2),
  ]));
  add(emotion, trace.emotionDynamics, "suppression", derive([
    term("obedience", temperament.obedience, 0.4),
    term("1-sociability", 1 - temperament.sociability, 0.3),
    term("securityMotive", motives.security, 0.3),
  ]));
  const positivePersistence = add(emotion, trace.emotionDynamics, "positivePersistence", derive([
    term("loyalty", politics.loyalty, 0.35),
    term("sociability", temperament.sociability, 0.25),
    term("reciprocityValue", v.reciprocity, 0.25),
    term("1-suppression", 1 - emotion.suppression, 0.15),
  ]));
  const negativePersistence = add(emotion, trace.emotionDynamics, "negativePersistence", derive([
    term("greed", temperament.greed, 0.3),
    term("ambition", politics.ambition, 0.2),
    term("1-empathy", 1 - temperament.empathy, 0.25),
    term("1-reappraisal", 1 - emotion.reappraisal, 0.25),
  ]));
  emotion.positiveHalfLifeTicks = Math.round(12000 + positivePersistence * 156000);
  emotion.negativeHalfLifeTicks = Math.round(12000 + negativePersistence * 156000);

  const helper = c.helperState || {};
  const recipient = c.recipientState || {};
  const view = c.helperPerspective || {};
  const affect = view.affect || {};
  const family = isFamily(c.sources);
  const ownNeed = clamp01(
    stateNeedSeverity(helper) + (helper.sick ? 0.45 : 0) +
      0.35 * (helper.stress || 0)
  );
  const otherNeed = clamp01(
    stateNeedSeverity(recipient) + (recipient.sick ? 0.45 : 0)
  );
  const trust = typeof view.trust === "number" ? view.trust : 0.5;
  const affinity = typeof view.affinity === "number" ? view.affinity : 0.5;
  const obligation = typeof view.obligation === "number" ? view.obligation : 0;
  const gratitude = affect.gratitude || 0;
  const resentment = affect.resentment || 0;
  const distanceCost = Math.min(Math.max(Number(c.distance) || 0, 0) / 96, 1);
  const goals = {};
  add(goals, trace.activeGoals, "preserveHealth", derive([
    term("ownNeed", ownNeed, 0.55),
    term("securityMotive", motives.security, 0.25),
    term("selfPreservationNorm", norms.selfPreservation, 0.2),
  ]));
  add(goals, trace.activeGoals, "aidOther", derive([
    term("otherNeed", otherNeed, 0.45),
    term("careMotive", motives.care, 0.25),
    term("careNorm", family ? norms.careForKin : norms.aidCommunity, 0.2),
    term("familyContext", family ? 1 : 0, 0.1),
  ]));
  add(goals, trace.activeGoals, "honorReciprocity", derive([
    term("obligation", obligation, 0.4),
    term("reciprocityNorm", norms.reciprocateHelp, 0.3),
    term("gratitude", gratitude, 0.2),
    term("trust", trust, 0.1),
  ]));
  add(goals, trace.activeGoals, "maintainRelationship", derive([
    term("affinity", affinity, 0.3),
    term("trust", trust, 0.25),
    term("affiliationMotive", motives.affiliation, 0.25),
    term("familyContext", family ? 1 : 0, 0.2),
    term("resentment", resentment, -0.2),
  ]));
  add(goals, trace.activeGoals, "preserveResources", derive([
    term("resourceProtection", motives.resourceProtection, 0.55),
    term("ownNeed", ownNeed, 0.3),
    term("distanceCost", distanceCost, 0.15),
  ]));

  return {
    schema: SCHEMA,
    source: {
      citizenId: persona && persona.citizenId,
      templateId: persona && persona.templateId || null,
      generation: persona && persona.generation,
      heritableSchema: "P1",
    },
    inheritedTraits: { temperament, politics },
    stable,
    activeGoals: goals,
    context: {
      family, sources: (c.sources || []).slice(), ownNeed: round3(ownNeed),
      otherNeed: round3(otherNeed), trust: round3(trust), affinity: round3(affinity),
      obligation: round3(obligation), gratitude: round3(gratitude),
      resentment: round3(resentment), distanceCost: round3(distanceCost),
      resourceAvailable: c.resourceAvailable !== false,
    },
    trace,
  };
}

module.exports = {
  SCHEMA, buildCognitiveProfile, nutritionSeverity, stateNeedSeverity,
  isFamily, clamp01, round3,
};
