// Counterfactual experiment runner for persona/social-help ablations.
//
// Every condition receives the same directed citizen pairs, need state and
// random draws. Conditions progressively restore persona, structural relation
// and temporal memory, so outcome differences have an explicit intervention.
const fs = require("fs");
const path = require("path");
const P = require("./personas.js");
const S = require("./social_graph.js");
const D = require("./social_dynamics.js");
const A = require("./social_appraisal.js");

const CONDITIONS = ["uniform", "persona", "persona_relation", "temporal"];
const NEUTRAL_PERSONA = {
  templateId: "uniform-control",
  segments: {
    temperament: { empathy: 0.5, greed: 0.5, sociability: 0.5, obedience: 0.5 },
    politics: { loyalty: 0.5, ambition: 0.5 },
  },
};

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function isFamily(sources) {
  return (sources || []).some((s) => ["partner", "parent_child", "sibling"].includes(s));
}

function structuralDistance(a, b) {
  const pa = a && (a.homeBuilding || a.workBuilding);
  const pb = b && (b.homeBuilding || b.workBuilding);
  if (!pa || !pb) return 24;
  return Math.hypot(pa.x - pb.x, pa.z - pb.z);
}

function buildScenarios(personas, graph, dynamics, opts) {
  const o = opts || {};
  const gameTime = Number.isFinite(o.gameTime)
    ? o.gameTime : Number(graph && graph._meta && graph._meta.gameTime) || 0;
  const scenarios = [];
  for (const [edgeKey, edge] of Object.entries(graph.edges || {}).sort()) {
    for (const [helperId, recipientId] of [[edge.a, edge.b], [edge.b, edge.a]]) {
      const helperNode = graph.nodes[String(helperId)];
      const recipientNode = graph.nodes[String(recipientId)];
      const helperPersona = P.get(personas, helperId);
      if (!helperNode || !recipientNode || !helperPersona || helperPersona.deceased) continue;
      const storedView = D.perspectiveFor(dynamics, helperId, recipientId);
      const view = D.effectivePerspective(storedView, gameTime) || {
        trust: 0.5, affinity: 0.5, obligation: 0,
        affect: { gratitude: 0, resentment: 0 }, memory: {},
      };
      scenarios.push({
        scenarioId: `${edgeKey}:${helperId}>${recipientId}`,
        edgeKey,
        helperId,
        recipientId,
        helperTemplate: helperPersona.templateId || "inherited",
        helperPersona,
        helperState: { nutritionBand: "fed", sick: false, stress: 0.1 },
        recipientState: { nutritionBand: "starving", sick: false, stress: 0.3 },
        helperPerspective: view,
        sources: (edge.sources || []).slice(),
        familiarity: edge.familiarity || 0,
        distance: structuralDistance(helperNode, recipientNode),
        resourceAvailable: true,
        family: isFamily(edge.sources),
      });
    }
  }
  return scenarios;
}

function intervention(scenario, condition) {
  const neutralView = {
    trust: 0.5, affinity: 0.5, obligation: 0,
    affect: { gratitude: 0, resentment: 0 }, memory: {},
  };
  if (condition === "uniform") {
    return {
      ...scenario,
      helperPersona: NEUTRAL_PERSONA,
      helperPerspective: neutralView,
      sources: [], familiarity: 0,
    };
  }
  if (condition === "persona") {
    return { ...scenario, helperPerspective: neutralView, sources: [], familiarity: 0 };
  }
  if (condition === "persona_relation") {
    return {
      ...scenario,
      helperPerspective: {
        ...scenario.helperPerspective,
        obligation: 0,
        affect: { gratitude: 0, resentment: 0 },
      },
    };
  }
  if (condition === "temporal") return scenario;
  throw new Error(`unknown experiment condition: ${condition}`);
}

function emptyMetrics() {
  return {
    trials: 0, help: 0, refuse: 0,
    helpRate: 0, meanHelpScore: 0, meanRefuseScore: 0, meanMargin: 0,
    family: { trials: 0, help: 0, helpRate: 0 },
    nonFamily: { trials: 0, help: 0, helpRate: 0 },
    byTemplate: {},
  };
}

function record(metrics, scenario, decision) {
  metrics.trials++;
  metrics[decision.selected]++;
  metrics._helpScore = (metrics._helpScore || 0) + decision.actions.help.score;
  metrics._refuseScore = (metrics._refuseScore || 0) + decision.actions.refuse.score;
  metrics._margin = (metrics._margin || 0) +
    decision.actions.help.score - decision.actions.refuse.score;
  const group = scenario.family ? metrics.family : metrics.nonFamily;
  group.trials++;
  if (decision.selected === "help") group.help++;
  const template = scenario.helperTemplate || "unknown";
  metrics.byTemplate[template] = metrics.byTemplate[template] || { trials: 0, help: 0 };
  metrics.byTemplate[template].trials++;
  if (decision.selected === "help") metrics.byTemplate[template].help++;
}

function finalize(metrics) {
  const n = metrics.trials || 1;
  metrics.helpRate = round4(metrics.help / n);
  metrics.meanHelpScore = round4((metrics._helpScore || 0) / n);
  metrics.meanRefuseScore = round4((metrics._refuseScore || 0) / n);
  metrics.meanMargin = round4((metrics._margin || 0) / n);
  delete metrics._helpScore;
  delete metrics._refuseScore;
  delete metrics._margin;
  for (const group of [metrics.family, metrics.nonFamily]) {
    group.helpRate = round4(group.trials ? group.help / group.trials : 0);
  }
  for (const value of Object.values(metrics.byTemplate)) {
    value.helpRate = round4(value.trials ? value.help / value.trials : 0);
  }
  return metrics;
}

function runExperiment(input, opts) {
  const o = opts || {};
  const repeats = Number.isInteger(o.repeats) && o.repeats > 0 ? o.repeats : 20;
  const seed = o.seed || "social-ablation-v1";
  const temperature = typeof o.temperature === "number" ? o.temperature : 0.35;
  const scenarios = input.scenarios || buildScenarios(
    input.personas, input.graph, input.dynamics, o
  );
  const metrics = Object.fromEntries(CONDITIONS.map((c) => [c, emptyMetrics()]));
  for (const scenario of scenarios) {
    for (let repeat = 0; repeat < repeats; repeat++) {
      const commonSeed = `${seed}:${scenario.scenarioId}:${repeat}`;
      for (const condition of CONDITIONS) {
        const candidate = intervention(scenario, condition);
        const decision = A.decideHelp(candidate, {
          seed: commonSeed,
          temperature,
          mode: o.mode === "max" ? "max" : undefined,
        });
        record(metrics[condition], scenario, decision);
      }
    }
  }
  for (const condition of CONDITIONS) finalize(metrics[condition]);
  const historyManipulation = runHistoryManipulation(scenarios, {
    repeats, seed: `${seed}:history`, temperature, mode: o.mode,
  });
  return {
    schema: "voyager-social-ablation-v1",
    seed,
    repeats,
    temperature,
    scenarios: scenarios.length,
    conditions: metrics,
    deltas: {
      personaVsUniform: round4(metrics.persona.helpRate - metrics.uniform.helpRate),
      relationVsPersona: round4(metrics.persona_relation.helpRate - metrics.persona.helpRate),
      temporalVsStaticRelation: round4(
        metrics.temporal.helpRate - metrics.persona_relation.helpRate
      ),
    },
    historyManipulation,
  };
}

function runHistoryManipulation(scenarios, opts) {
  const o = opts || {};
  const repeats = Number.isInteger(o.repeats) && o.repeats > 0 ? o.repeats : 20;
  const variants = ["no_history", "helped_before", "refused_before"];
  const metrics = Object.fromEntries(variants.map((name) => [name, emptyMetrics()]));
  for (const scenario of scenarios) {
    const base = intervention(scenario, "persona_relation");
    const candidates = {
      no_history: base,
      helped_before: {
        ...base,
        helperPerspective: {
          ...base.helperPerspective,
          obligation: 0.3,
          affect: { gratitude: 0.6, resentment: 0 },
        },
      },
      refused_before: {
        ...base,
        helperPerspective: {
          ...base.helperPerspective,
          obligation: 0,
          affect: { gratitude: 0, resentment: 0.6 },
        },
      },
    };
    for (let repeat = 0; repeat < repeats; repeat++) {
      const commonSeed = `${o.seed || "history-v1"}:${scenario.scenarioId}:${repeat}`;
      for (const variant of variants) {
        const decision = A.decideHelp(candidates[variant], {
          seed: commonSeed,
          temperature: typeof o.temperature === "number" ? o.temperature : 0.35,
          mode: o.mode === "max" ? "max" : undefined,
        });
        record(metrics[variant], scenario, decision);
      }
    }
  }
  for (const variant of variants) finalize(metrics[variant]);
  return {
    variants: metrics,
    deltas: {
      helpedVsNoHistory: round4(metrics.helped_before.helpRate - metrics.no_history.helpRate),
      refusedVsNoHistory: round4(metrics.refused_before.helpRate - metrics.no_history.helpRate),
    },
  };
}

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = runExperiment({
    personas: P.loadAll(), graph: S.loadGraph(), dynamics: D.loadState(),
  }, {
    seed: args.seed,
    repeats: args.repeats ? parseInt(args.repeats, 10) : undefined,
    temperature: args.temperature ? parseFloat(args.temperature) : undefined,
    mode: args.mode,
  });
  const document = { generatedAt: new Date().toISOString(), ...result };
  if (args.output) {
    const target = path.resolve(args.output);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(document, null, 2));
  }
  console.log(JSON.stringify(document, null, 2));
}

module.exports = {
  CONDITIONS, NEUTRAL_PERSONA, buildScenarios, intervention,
  runExperiment, runHistoryManipulation,
};

if (require.main === module) main();
