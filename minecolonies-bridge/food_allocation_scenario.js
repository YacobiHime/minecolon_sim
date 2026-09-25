// Counterfactual food-allocation dilemma grounded in the live social graph.
//
// A helper has exactly one transferable meal and must choose between a close,
// mildly hungry relation and a weaker, starving relation, or keep the meal.
// This is offline-only: it does not call Bridge or mutate Minecraft state.
const fs = require("fs");
const path = require("path");
const P = require("./personas.js");
const S = require("./social_graph.js");
const D = require("./social_dynamics.js");
const A1 = require("./social_appraisal.js");
const A2 = require("./social_appraisal_v2.js");
const E = require("./social_experiment.js");

const CONDITIONS = ["uniform", "persona", "persona_relation", "temporal"];
const CHOICES = ["close_mild", "weak_severe", "keep"];

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function isFamily(sources) {
  return (sources || []).some((source) =>
    ["partner", "parent_child", "sibling"].includes(source)
  );
}

function otherId(edge, helperId) {
  return edge.a === helperId ? edge.b : edge.a;
}

function neutralPerspective() {
  return {
    trust: 0.5, affinity: 0.5, obligation: 0,
    affect: { gratitude: 0, resentment: 0 }, memory: {},
  };
}

function activePerspective(dynamics, helperId, recipientId, gameTime) {
  return D.effectivePerspective(
    D.perspectiveFor(dynamics, helperId, recipientId), gameTime
  ) || neutralPerspective();
}

function relationStrength(edge, perspective) {
  return 0.4 * (perspective.trust == null ? 0.5 : perspective.trust) +
    0.35 * (perspective.affinity == null ? 0.5 : perspective.affinity) +
    0.25 * (edge.familiarity || 0);
}

function relationCandidate(edge, helperId, graph, dynamics, gameTime) {
  const recipientId = otherId(edge, helperId);
  const perspective = activePerspective(dynamics, helperId, recipientId, gameTime);
  return {
    recipientId,
    recipientName: graph.nodes[String(recipientId)]?.name || `citizen ${recipientId}`,
    sources: (edge.sources || []).slice(),
    familiarity: edge.familiarity || 0,
    perspective,
    strength: relationStrength(edge, perspective),
  };
}

function buildScenarios(personas, graph, dynamics, opts) {
  const o = opts || {};
  const gameTime = Number.isFinite(o.gameTime) ? o.gameTime :
    Number(graph?._meta?.gameTime || dynamics?._meta?.gameTime || 0);
  const edges = Object.values(graph.edges || {});
  const scenarios = [];
  for (const helperId of Object.keys(graph.nodes || {}).map(Number).sort((a, b) => a - b)) {
    const helperPersona = P.get(personas, helperId);
    if (!helperPersona || helperPersona.deceased) continue;
    const adjacent = edges.filter((edge) => edge.a === helperId || edge.b === helperId)
      .map((edge) => relationCandidate(edge, helperId, graph, dynamics, gameTime))
      .filter((candidate) => {
        const recipientPersona = P.get(personas, candidate.recipientId);
        return graph.nodes[String(candidate.recipientId)] &&
          (!recipientPersona || !recipientPersona.deceased);
      });
    let close = adjacent.filter((candidate) => isFamily(candidate.sources))
      .sort((a, b) => b.strength - a.strength || a.recipientId - b.recipientId)[0];
    if (!close && o.allowNonFamilyClose) {
      close = adjacent.slice()
        .sort((a, b) => b.strength - a.strength || a.recipientId - b.recipientId)[0];
    }
    const distant = adjacent.filter((candidate) => !isFamily(candidate.sources))
      .filter((candidate) => !close || candidate.recipientId !== close.recipientId)
      .sort((a, b) => a.strength - b.strength || a.recipientId - b.recipientId)[0];
    if (!close || !distant || close.recipientId === distant.recipientId) continue;
    scenarios.push({
      schema: "voyager-food-allocation-scenario-v1",
      scenarioId: `${helperId}:${close.recipientId}|${distant.recipientId}`,
      gameTime,
      helperId,
      helperName: graph.nodes[String(helperId)]?.name || `citizen ${helperId}`,
      helperTemplate: helperPersona.templateId || "inherited",
      helperPersona,
      helperState: { nutritionBand: "fed", sick: false, stress: 0.1 },
      transferableMeals: 1,
      distance: Number.isFinite(o.distance) ? o.distance : 12,
      closeRelationType: isFamily(close.sources) ? "family" : "strongest_available",
      candidates: {
        close_mild: {
          ...close,
          role: "close_mild",
          recipientState: {
            nutritionBand: "hungry",
            needSeverity: clamp01(Number.isFinite(o.closeNeed) ? o.closeNeed : 0.5),
            sick: false,
            stress: 0.2,
          },
        },
        weak_severe: {
          ...distant,
          role: "weak_severe",
          recipientState: {
            nutritionBand: "starving",
            needSeverity: clamp01(Number.isFinite(o.weakNeed) ? o.weakNeed : 1),
            sick: false,
            stress: 0.4,
          },
        },
      },
    });
  }
  return scenarios;
}

function withSeverities(scenario, closeNeed, weakNeed) {
  const close = clamp01(closeNeed);
  const weak = clamp01(weakNeed);
  return {
    ...scenario,
    severityId: `${close.toFixed(3)}:${weak.toFixed(3)}`,
    candidates: {
      ...scenario.candidates,
      close_mild: {
        ...scenario.candidates.close_mild,
        recipientState: {
          ...scenario.candidates.close_mild.recipientState,
          needSeverity: close,
        },
      },
      weak_severe: {
        ...scenario.candidates.weak_severe,
        recipientState: {
          ...scenario.candidates.weak_severe.recipientState,
          needSeverity: weak,
        },
      },
    },
  };
}

function candidateInput(scenario, role, condition) {
  const candidate = scenario.candidates[role];
  if (!candidate) throw new Error(`unknown allocation role: ${role}`);
  if (!CONDITIONS.includes(condition)) throw new Error(`unknown allocation condition: ${condition}`);
  let helperPersona = scenario.helperPersona;
  let perspective = candidate.perspective;
  let sources = candidate.sources;
  let familiarity = candidate.familiarity;
  if (condition === "uniform") helperPersona = E.NEUTRAL_PERSONA;
  if (condition === "uniform" || condition === "persona") {
    perspective = neutralPerspective();
    sources = [];
    familiarity = 0;
  } else if (condition === "persona_relation") {
    perspective = {
      ...candidate.perspective,
      obligation: 0,
      affect: { gratitude: 0, resentment: 0 },
      memory: {},
    };
  }
  return {
    scenarioId: `${scenario.scenarioId}:${role}:${condition}`,
    helperId: scenario.helperId,
    recipientId: candidate.recipientId,
    helperTemplate: scenario.helperTemplate,
    helperPersona,
    helperState: scenario.helperState,
    recipientState: candidate.recipientState,
    helperPerspective: perspective,
    sources,
    familiarity,
    distance: scenario.distance,
    resourceAvailable: scenario.transferableMeals > 0,
    family: isFamily(sources),
  };
}

function margin(decision) {
  return decision.actions.help.score - decision.actions.refuse.score;
}

function chooseAllocation(scenario, condition, opts) {
  const o = opts || {};
  const decide = o.decide || A2.decideHelp;
  const scored = {};
  for (const role of ["close_mild", "weak_severe"]) {
    const input = candidateInput(scenario, role, condition);
    const decision = decide(input, {
      mode: "max",
      config: o.config,
      configFile: o.configFile,
    });
    scored[role] = {
      recipientId: scenario.candidates[role].recipientId,
      recipientName: scenario.candidates[role].recipientName,
      margin: round4(margin(decision)),
      selected: decision.selected,
      decision: o.includeTrace ? decision : undefined,
    };
  }
  let selected;
  if (o.mode === "sample") {
    const utilities = {
      close_mild: scored.close_mild.margin,
      weak_severe: scored.weak_severe.margin,
      keep: 0,
    };
    const temperature = Math.max(0.05, Number.isFinite(o.temperature) ? o.temperature : 0.35);
    const max = Math.max(...Object.values(utilities));
    const weighted = CHOICES.map((choice) => ({
      choice,
      weight: Math.exp((utilities[choice] - max) / temperature),
    }));
    const total = weighted.reduce((sum, item) => sum + item.weight, 0);
    let roll = A1.seededUnit(o.seed == null ? "0" : o.seed) * total;
    selected = weighted[weighted.length - 1].choice;
    for (const item of weighted) {
      roll -= item.weight;
      if (roll <= 0) { selected = item.choice; break; }
    }
  } else {
    const ranked = ["weak_severe", "close_mild"]
      .sort((a, b) => scored[b].margin - scored[a].margin);
    selected = scored[ranked[0]].margin > 0 ? ranked[0] : "keep";
  }
  return { selected, scores: scored };
}

function renderScenarioCard(scenario) {
  const close = scenario.candidates.close_mild;
  const distant = scenario.candidates.weak_severe;
  const closeDescription = scenario.closeRelationType === "strongest_available"
    ? "あなたが最も親しく信頼している相手"
    : "あなたの親しい家族";
  return [
    `あなたは ${scenario.helperName} です。自分は満腹です。`,
    "自分用の最後の食事とは別に、分けられる料理が1食だけあります。",
    `${close.recipientName} は${closeDescription}で、空腹度は${Math.round((close.recipientState.needSeverity ?? 0.5) * 100)}%です。`,
    `${distant.recipientName} は関係の薄い共同体の一員で、空腹度は${Math.round((distant.recipientState.needSeverity ?? 1) * 100)}%です。`,
    "判断中は食堂・配達員・外部供給から食料は届きません。料理を渡せる相手は一人だけです。",
    `選択肢: ${close.recipientName}へ渡す / ${distant.recipientName}へ渡す / 誰にも渡さない`,
  ].join("\n");
}

function emptyMetrics() {
  return {
    scenarios: 0,
    choices: { close_mild: 0, weak_severe: 0, keep: 0 },
    byTemplate: {},
  };
}

function record(metrics, scenario, outcome) {
  metrics.scenarios++;
  metrics.choices[outcome.selected]++;
  const template = scenario.helperTemplate || "unknown";
  metrics.byTemplate[template] = metrics.byTemplate[template] || {
    scenarios: 0, close_mild: 0, weak_severe: 0, keep: 0,
  };
  metrics.byTemplate[template].scenarios++;
  metrics.byTemplate[template][outcome.selected]++;
}

function finalize(metrics) {
  const n = metrics.scenarios || 1;
  metrics.rates = Object.fromEntries(
    CHOICES.map((choice) => [choice, round4(metrics.choices[choice] / n)])
  );
  metrics.relationshipOverrideRate = metrics.rates.close_mild;
  metrics.needPriorityRate = metrics.rates.weak_severe;
  metrics.keepRate = metrics.rates.keep;
  for (const value of Object.values(metrics.byTemplate)) {
    const count = value.scenarios || 1;
    value.rates = Object.fromEntries(
      CHOICES.map((choice) => [choice, round4(value[choice] / count)])
    );
  }
  return metrics;
}

function runExperiment(input, opts) {
  const o = opts || {};
  const scenarios = input.scenarios || buildScenarios(
    input.personas, input.graph, input.dynamics, o
  );
  const conditions = Object.fromEntries(CONDITIONS.map((condition) => [condition, emptyMetrics()]));
  const disagreements = [];
  for (const scenario of scenarios) {
    const outcomes = {};
    for (const condition of CONDITIONS) {
      outcomes[condition] = chooseAllocation(scenario, condition, o);
      record(conditions[condition], scenario, outcomes[condition]);
    }
    const choices = new Set(CONDITIONS.map((condition) => outcomes[condition].selected));
    if (choices.size > 1 && disagreements.length < (o.exampleLimit || 12)) {
      disagreements.push({
        scenarioId: scenario.scenarioId,
        helperId: scenario.helperId,
        helperName: scenario.helperName,
        helperTemplate: scenario.helperTemplate,
        closeRecipient: scenario.candidates.close_mild.recipientName,
        severeRecipient: scenario.candidates.weak_severe.recipientName,
        outcomes,
        scenarioCard: renderScenarioCard(scenario),
      });
    }
  }
  for (const condition of CONDITIONS) finalize(conditions[condition]);
  return {
    schema: "voyager-food-allocation-experiment-v1",
    scenarios: scenarios.length,
    manipulation: {
      transferableMeals: 1,
      helperNutrition: "fed",
      closeCandidateNeed: "hungry",
      weakCandidateNeed: "starving",
      fixedDistance: Number.isFinite(o.distance) ? o.distance : 12,
    },
    conditions,
    disagreements,
  };
}

function parseArgs(argv) {
  return Object.fromEntries(argv.map((arg) => arg.match(/^--([^=]+)=(.*)$/)).filter(Boolean)
    .map((match) => [match[1], match[2]]));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = runExperiment({
    personas: P.loadAll(), graph: S.loadGraph(), dynamics: D.loadState(),
  }, {
    distance: args.distance ? parseFloat(args.distance) : undefined,
    includeTrace: args.trace === "true",
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
  CONDITIONS, CHOICES, isFamily, relationStrength, buildScenarios,
  withSeverities, candidateInput, chooseAllocation, renderScenarioCard,
  runExperiment,
};

if (require.main === module) main();
