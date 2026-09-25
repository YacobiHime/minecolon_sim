// social_appraisal.js - Explainable Phase 3 social decision core.
//
// This is a deliberately small OCC/FAtiMA-inspired appraisal model, not a
// claim of full FAtiMA compatibility. Stable persona traits and values shape
// how an event is appraised; appraisal and current state shape action scores.
// Every contribution is returned for experiment logs and ablation studies.

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

// P1 remains the heritable source of truth. These values are transparent,
// deterministic interpretations of its existing axes rather than new genes.
// This avoids silently changing every historical citizen while still
// separating values from temperament for appraisal and LLM context.
function deriveValues(persona) {
  const empathy = trait(persona, "temperament", "empathy", 0.5);
  const obedience = trait(persona, "temperament", "obedience", 0.5);
  const greed = trait(persona, "temperament", "greed", 0.5);
  const sociability = trait(persona, "temperament", "sociability", 0.5);
  const loyalty = trait(persona, "politics", "loyalty", 0.5);
  const ambition = trait(persona, "politics", "ambition", 0.5);
  return {
    family: round3(clamp01(0.5 * empathy + 0.3 * loyalty + 0.2 * (1 - greed))),
    community: round3(clamp01(0.6 * loyalty + 0.25 * empathy + 0.15 * obedience)),
    fairness: round3(clamp01(0.45 * empathy + 0.35 * (1 - greed) + 0.2 * obedience)),
    reciprocity: round3(clamp01(0.4 * empathy + 0.3 * sociability + 0.3 * (1 - greed))),
    autonomy: round3(clamp01(0.65 * (1 - obedience) + 0.35 * ambition)),
  };
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
  return (sources || []).some((s) => ["partner", "parent_child", "sibling"].includes(s));
}

function appraiseHelpRequest(input) {
  const persona = input.helperPersona || null;
  const helper = input.helperState || {};
  const recipient = input.recipientState || {};
  const view = input.helperPerspective || {};
  const values = deriveValues(persona);
  const empathy = trait(persona, "temperament", "empathy", 0.5);
  const greed = trait(persona, "temperament", "greed", 0.5);
  const sociability = trait(persona, "temperament", "sociability", 0.5);
  const family = isFamily(input.sources);
  const needSeverity = clamp01(
    stateNeedSeverity(recipient) + (recipient.sick ? 0.45 : 0)
  );
  const ownNeed = clamp01(
    stateNeedSeverity(helper) + (helper.sick ? 0.45 : 0) +
      0.35 * (helper.stress || 0)
  );
  const trust = typeof view.trust === "number" ? view.trust : 0.5;
  const affinity = typeof view.affinity === "number" ? view.affinity : 0.5;
  const obligation = typeof view.obligation === "number" ? view.obligation : 0;
  const gratitude = view.affect && typeof view.affect.gratitude === "number"
    ? view.affect.gratitude : 0;
  const resentment = view.affect && typeof view.affect.resentment === "number"
    ? view.affect.resentment : 0;
  const familiarity = typeof input.familiarity === "number" ? input.familiarity : 0;
  const resourceAvailable = input.resourceAvailable !== false;
  const distance = Math.max(0, input.distance || 0);

  // Appraisal variables use familiar names from cognitive appraisal models,
  // but are scoped specifically to a help request in this experiment.
  const appraisal = {
    relevance: round3(clamp01(needSeverity * (0.45 + 0.35 * familiarity + 0.2 * sociability))),
    goalCongruence: round3(clamp01(0.45 * empathy + 0.25 * values.community +
      0.2 * (family ? values.family : affinity) + 0.1 * trust)),
    normCompatibility: round3(clamp01(0.45 * values.fairness + 0.35 * values.reciprocity +
      0.2 * (family ? values.family : values.community))),
    controllability: round3(clamp01((resourceAvailable ? 0.75 : 0.05) +
      0.25 * (1 - Math.min(distance / 96, 1)))),
    selfCost: round3(clamp01(0.45 * ownNeed + 0.35 * greed + 0.2 * Math.min(distance / 96, 1))),
  };
  const emotions = {
    concern: round3(clamp01(appraisal.relevance * appraisal.goalCongruence)),
    obligation: round3(clamp01(appraisal.relevance * appraisal.normCompatibility +
      0.35 * obligation + 0.2 * gratitude)),
    reluctance: round3(clamp01(
      appraisal.selfCost * (1 - 0.35 * appraisal.goalCongruence) + 0.35 * resentment
    )),
    distress: round3(clamp01(needSeverity * (0.5 + 0.5 * (helper.stress || 0)))),
  };
  return {
    model: "voyager-appraisal-v1",
    values,
    appraisal,
    emotions,
    context: {
      family,
      needSeverity: round3(needSeverity),
      ownNeed: round3(ownNeed),
      trust,
      affinity,
      obligation,
      gratitude,
      resentment,
      familiarity,
      resourceAvailable,
      distance: round3(distance),
    },
  };
}

function contribution(name, value) {
  return { name, value: round3(value) };
}

function scoreHelpActions(appraisalResult) {
  const a = appraisalResult.appraisal;
  const e = appraisalResult.emotions;
  const c = appraisalResult.context;
  const v = appraisalResult.values;
  const helpParts = [
    contribution("concern", 1.25 * e.concern),
    contribution("obligation", 0.9 * e.obligation),
    contribution("gratitude", 0.4 * c.gratitude),
    contribution("resentment", -0.6 * c.resentment),
    contribution("trust", 0.65 * (c.trust - 0.5)),
    contribution("affinity", 0.45 * (c.affinity - 0.5)),
    contribution("family", c.family ? 0.35 * v.family : 0),
    contribution("community", 0.3 * (v.community - 0.5)),
    contribution("controllability", 0.45 * (a.controllability - 0.5)),
    contribution("reluctance", -1.1 * e.reluctance),
    contribution("infeasible", c.resourceAvailable ? 0 : -4),
  ];
  const refuseParts = [
    contribution("selfCost", 0.9 * a.selfCost),
    contribution("reluctance", 0.8 * e.reluctance),
    contribution("resentment", 0.5 * c.resentment),
    contribution("autonomy", 0.25 * (v.autonomy - 0.5)),
    contribution("lowConcern", 0.55 * (0.5 - e.concern)),
    contribution("noResource", c.resourceAvailable ? 0 : 1.5),
  ];
  const actions = {
    help: { contributions: helpParts },
    refuse: { contributions: refuseParts },
  };
  for (const action of Object.values(actions)) {
    action.score = round3(action.contributions.reduce((sum, p) => sum + p.value, 0));
  }
  return actions;
}

function hashSeed(value) {
  let h = 2166136261;
  for (const ch of String(value)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seededUnit(seed) {
  let x = hashSeed(seed) || 1;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return (x >>> 0) / 4294967296;
}

function chooseAction(actions, opts) {
  const entries = Object.entries(actions);
  const temperature = Math.max(0.05, (opts && opts.temperature) || 0.35);
  if (opts && opts.mode === "max") {
    return entries.slice().sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]))[0][0];
  }
  const maxScore = Math.max(...entries.map(([, a]) => a.score));
  const weighted = entries.map(([name, action]) => ({
    name,
    weight: Math.exp((action.score - maxScore) / temperature),
  }));
  const total = weighted.reduce((sum, x) => sum + x.weight, 0);
  let roll = seededUnit(opts && opts.seed != null ? opts.seed : "0") * total;
  for (const item of weighted) {
    roll -= item.weight;
    if (roll <= 0) return item.name;
  }
  return weighted[weighted.length - 1].name;
}

function decideHelp(input, opts) {
  const appraisal = appraiseHelpRequest(input);
  const actions = scoreHelpActions(appraisal);
  const selected = chooseAction(actions, opts);
  return { appraisal, actions, selected };
}

module.exports = {
  deriveValues,
  appraiseHelpRequest,
  scoreHelpActions,
  chooseAction,
  decideHelp,
  seededUnit,
  stateNeedSeverity,
};
