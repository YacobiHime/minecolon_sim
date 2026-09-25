// Phase 3.6 help appraisal using the detailed cognitive profile.
const fs = require("fs");
const path = require("path");
const C = require("./social_cognition.js");
const A1 = require("./social_appraisal.js");

const CONFIG_FILE = process.env.SOCIAL_APPRAISAL_V2_CONFIG ||
  path.join(__dirname, "social_appraisal_v2_config.json");

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function tracked(terms, bias) {
  const b = typeof bias === "number" ? bias : 0;
  const contributions = terms.map((x) => ({
    source: x.source,
    input: round3(x.input),
    weight: x.weight,
    contribution: round3(x.input * x.weight),
  }));
  const raw = b + contributions.reduce((sum, x) => sum + x.contribution, 0);
  return {
    value: round3(C.clamp01(raw)),
    trace: { bias: b, raw: round3(raw), terms: contributions },
  };
}

function loadConfig(file) {
  const target = file || CONFIG_FILE;
  const config = JSON.parse(fs.readFileSync(target, "utf8"));
  for (const section of ["help", "refuse"]) {
    if (!config[section] || typeof config[section] !== "object") {
      throw new Error(`appraisal v2 config missing ${section}`);
    }
    for (const [name, weight] of Object.entries(config[section])) {
      if (typeof weight !== "number" || !Number.isFinite(weight)) {
        throw new Error(`appraisal v2 config ${section}.${name} must be numeric`);
      }
    }
  }
  return config;
}

function appraiseHelpRequest(input) {
  const profile = C.buildCognitiveProfile(input.helperPersona, input);
  const s = profile.stable;
  const g = profile.activeGoals;
  const c = profile.context;
  const familyNorm = c.family ? s.norms.careForKin : s.norms.aidCommunity;
  const appraisalNodes = {
    relevance: tracked([
      { source: "aidOtherGoal", input: g.aidOther, weight: 0.5 },
      { source: "maintainRelationshipGoal", input: g.maintainRelationship, weight: 0.25 },
      { source: "concernSensitivity", input: s.emotionDynamics.concernSensitivity, weight: 0.25 },
    ]),
    goalCongruence: tracked([
      { source: "aidOtherGoal", input: g.aidOther, weight: 0.4 },
      { source: "honorReciprocityGoal", input: g.honorReciprocity, weight: 0.25 },
      { source: "maintainRelationshipGoal", input: g.maintainRelationship, weight: 0.2 },
      { source: "careMotive", input: s.motives.care, weight: 0.15 },
    ]),
    normCompatibility: tracked([
      { source: c.family ? "careForKinNorm" : "aidCommunityNorm", input: familyNorm, weight: 0.4 },
      { source: "reciprocateHelpNorm", input: s.norms.reciprocateHelp, weight: 0.35 },
      { source: "actFairlyNorm", input: s.norms.actFairly, weight: 0.25 },
    ]),
    controllability: tracked([
      { source: "resourceAvailable", input: c.resourceAvailable ? 1 : 0, weight: 0.55 },
      { source: "problemFocusedCoping", input: s.coping.problemFocused, weight: 0.25 },
      { source: "proximity", input: 1 - c.distanceCost, weight: 0.2 },
    ]),
    selfCost: tracked([
      { source: "preserveHealthGoal", input: g.preserveHealth, weight: 0.4 },
      { source: "preserveResourcesGoal", input: g.preserveResources, weight: 0.35 },
      { source: "distanceCost", input: c.distanceCost, weight: 0.25 },
    ]),
  };
  const appraisal = Object.fromEntries(Object.entries(appraisalNodes).map(([k, x]) => [k, x.value]));
  const emotionNodes = {
    compassion: tracked([
      { source: "relevance", input: appraisal.relevance, weight: 0.45 },
      { source: "goalCongruence", input: appraisal.goalCongruence, weight: 0.3 },
      { source: "concernSensitivity", input: s.emotionDynamics.concernSensitivity, weight: 0.25 },
    ]),
    guiltAnticipation: tracked([
      { source: "normCompatibility", input: appraisal.normCompatibility, weight: 0.55 },
      { source: "normSensitivity", input: s.decisionStyle.normSensitivity, weight: 0.3 },
      { source: "1-autonomy", input: 1 - s.values.autonomy, weight: 0.15 },
    ]),
    reluctance: tracked([
      { source: "selfCost", input: appraisal.selfCost, weight: 0.55 },
      { source: "resentment", input: c.resentment, weight: 0.3 },
      { source: "1-reappraisal", input: 1 - s.emotionDynamics.reappraisal, weight: 0.15 },
    ]),
    prideAnticipation: tracked([
      { source: "normCompatibility", input: appraisal.normCompatibility, weight: 0.4 },
      { source: "achievementMotive", input: s.motives.achievement, weight: 0.3 },
      { source: "communityValue", input: s.values.community, weight: 0.3 },
    ]),
    anxiety: tracked([
      { source: "selfCost", input: appraisal.selfCost, weight: 0.55 },
      { source: "threatSensitivity", input: s.emotionDynamics.threatSensitivity, weight: 0.45 },
    ]),
  };
  const emotions = Object.fromEntries(Object.entries(emotionNodes).map(([k, x]) => [k, x.value]));
  return {
    model: "voyager-appraisal-v2",
    profile,
    appraisal,
    appraisalTrace: Object.fromEntries(Object.entries(appraisalNodes).map(([k, x]) => [k, x.trace])),
    emotions,
    emotionTrace: Object.fromEntries(Object.entries(emotionNodes).map(([k, x]) => [k, x.trace])),
  };
}

function scoreHelpActions(result, config) {
  const cfg = config || loadConfig();
  const p = result.profile;
  const a = result.appraisal;
  const e = result.emotions;
  const c = p.context;
  // Scores are utilities around a neutral reference point. A bounded
  // construct at 0.5 contributes no directional evidence; this prevents a
  // model with more named positive constructs from becoming helpful merely
  // because it has more terms than the refusal utility.
  const signals = {
    compassionEvidence: e.compassion - 0.5,
    reciprocityEvidence: p.activeGoals.honorReciprocity - 0.5,
    relationshipEvidence: p.activeGoals.maintainRelationship - 0.5,
    normEvidence: a.normCompatibility - 0.5,
    controlEvidence: a.controllability - 0.5,
    gratitude: c.gratitude,
    prideEvidence: e.prideAnticipation - 0.5,
    selfCost: a.selfCost,
    resentment: c.resentment,
    infeasible: c.resourceAvailable ? 0 : 1,
    healthProtectionEvidence: p.activeGoals.preserveHealth - 0.5,
    resourceProtectionEvidence: p.activeGoals.preserveResources - 0.5,
    autonomyEvidence: p.stable.values.autonomy - 0.5,
    reluctanceEvidence: e.reluctance - 0.5,
    lowCompassionEvidence: 0.5 - e.compassion,
    guiltEvidence: e.guiltAnticipation - 0.5,
    noResource: c.resourceAvailable ? 0 : 1,
  };
  const actions = {};
  for (const name of ["help", "refuse"]) {
    const contributions = Object.entries(cfg[name]).map(([signal, weight]) => {
      if (!Object.hasOwn(signals, signal)) throw new Error(`unknown v2 signal ${name}.${signal}`);
      return {
        name: signal,
        input: round3(signals[signal]),
        weight,
        value: round3(signals[signal] * weight),
      };
    });
    actions[name] = {
      score: round3(contributions.reduce((sum, x) => sum + x.value, 0)),
      contributions,
    };
  }
  return actions;
}

function decideHelp(input, opts) {
  const o = opts || {};
  const appraisal = appraiseHelpRequest(input);
  const config = o.config || loadConfig(o.configFile);
  const actions = scoreHelpActions(appraisal, config);
  const selected = A1.chooseAction(actions, o);
  return {
    appraisal,
    actions,
    selected,
    config: {
      schema: config._meta && config._meta.schema,
      version: config._meta && config._meta.version,
      status: config._meta && config._meta.status,
    },
  };
}

module.exports = { CONFIG_FILE, loadConfig, appraiseHelpRequest, scoreHelpActions, decideHelp };
