// Same-input comparison between appraisal v1 and detailed cognition v2.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const P = require("./personas.js");
const S = require("./social_graph.js");
const D = require("./social_dynamics.js");
const E = require("./social_experiment.js");
const A1 = require("./social_appraisal.js");
const A2 = require("./social_appraisal_v2.js");
const R = require("./persona_profile_report.js");

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function emptyMetrics() {
  return { trials: 0, help: 0, refuse: 0, marginSum: 0, byTemplate: {} };
}

function record(metrics, scenario, decision) {
  metrics.trials++;
  metrics[decision.selected]++;
  metrics.marginSum += decision.actions.help.score - decision.actions.refuse.score;
  const key = scenario.helperTemplate || "unknown";
  metrics.byTemplate[key] = metrics.byTemplate[key] || { trials: 0, help: 0 };
  metrics.byTemplate[key].trials++;
  if (decision.selected === "help") metrics.byTemplate[key].help++;
}

function finalize(metrics) {
  metrics.helpRate = round4(metrics.trials ? metrics.help / metrics.trials : 0);
  metrics.meanMargin = round4(metrics.trials ? metrics.marginSum / metrics.trials : 0);
  delete metrics.marginSum;
  for (const value of Object.values(metrics.byTemplate)) {
    value.helpRate = round4(value.trials ? value.help / value.trials : 0);
  }
  return metrics;
}

function configHash(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file || A2.CONFIG_FILE)).digest("hex");
}

function scoreMargin(decision) {
  return round4(decision.actions.help.score - decision.actions.refuse.score);
}

function deterministicComparison(scenarios, config) {
  const result = {
    scenarios: scenarios.length,
    v1Help: 0,
    v2Help: 0,
    disagreements: 0,
    v2HelpV1Refuse: 0,
    v1HelpV2Refuse: 0,
    examples: [],
  };
  for (const scenario of scenarios) {
    const v1 = A1.decideHelp(scenario, { mode: "max" });
    const v2 = A2.decideHelp(scenario, { mode: "max", config });
    if (v1.selected === "help") result.v1Help++;
    if (v2.selected === "help") result.v2Help++;
    if (v1.selected === v2.selected) continue;
    result.disagreements++;
    if (v2.selected === "help") result.v2HelpV1Refuse++;
    else result.v1HelpV2Refuse++;
    if (result.examples.length < 12) {
      result.examples.push({
        scenarioId: scenario.scenarioId,
        helperId: scenario.helperId,
        recipientId: scenario.recipientId,
        helperTemplate: scenario.helperTemplate || "unknown",
        family: !!scenario.family,
        v1: { selected: v1.selected, margin: scoreMargin(v1) },
        v2: { selected: v2.selected, margin: scoreMargin(v2) },
      });
    }
  }
  result.v1HelpRate = round4(result.scenarios ? result.v1Help / result.scenarios : 0);
  result.v2HelpRate = round4(result.scenarios ? result.v2Help / result.scenarios : 0);
  result.disagreementRate = round4(
    result.scenarios ? result.disagreements / result.scenarios : 0
  );
  return result;
}

function runComparison(input, opts) {
  const o = opts || {};
  const repeats = Number.isInteger(o.repeats) && o.repeats > 0 ? o.repeats : 20;
  const seed = o.seed || "cognition-v1-v2";
  const temperature = typeof o.temperature === "number" ? o.temperature : 0.35;
  const scenarios = input.scenarios || E.buildScenarios(
    input.personas, input.graph, input.dynamics, o
  );
  const config = o.config || A2.loadConfig(o.configFile);
  const models = { v1: emptyMetrics(), v2: emptyMetrics() };
  let disagreements = 0;
  let v2HelpV1Refuse = 0;
  let v1HelpV2Refuse = 0;
  for (const scenario of scenarios) {
    for (let repeat = 0; repeat < repeats; repeat++) {
      const common = { seed: `${seed}:${scenario.scenarioId}:${repeat}`, temperature };
      const v1 = A1.decideHelp(scenario, common);
      const v2 = A2.decideHelp(scenario, { ...common, config });
      record(models.v1, scenario, v1);
      record(models.v2, scenario, v2);
      if (v1.selected !== v2.selected) {
        disagreements++;
        if (v2.selected === "help") v2HelpV1Refuse++;
        else v1HelpV2Refuse++;
      }
    }
  }
  finalize(models.v1);
  finalize(models.v2);
  const profileReport = input.personas && input.graph && input.dynamics
    ? R.generateReport(input, { includeTrace: false }) : null;
  const trials = models.v1.trials;
  return {
    schema: "voyager-cognition-comparison-v1",
    seed, repeats, temperature, scenarios: scenarios.length,
    config: {
      schema: config._meta && config._meta.schema,
      version: config._meta && config._meta.version,
      status: config._meta && config._meta.status,
      sha256: o.config ? null : configHash(o.configFile),
    },
    models,
    comparison: {
      helpRateDeltaV2MinusV1: round4(models.v2.helpRate - models.v1.helpRate),
      disagreements,
      disagreementRate: round4(trials ? disagreements / trials : 0),
      v2HelpV1Refuse,
      v1HelpV2Refuse,
      deterministic: deterministicComparison(scenarios, config),
    },
    profileDiversity: profileReport && profileReport.dimensions,
  };
}

function parseArgs(argv) {
  return Object.fromEntries(argv.map((arg) => arg.match(/^--([^=]+)=(.*)$/)).filter(Boolean)
    .map((match) => [match[1], match[2]]));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = runComparison({
    personas: P.loadAll(), graph: S.loadGraph(), dynamics: D.loadState(),
  }, {
    seed: args.seed,
    repeats: args.repeats ? parseInt(args.repeats, 10) : undefined,
    temperature: args.temperature ? parseFloat(args.temperature) : undefined,
  });
  const document = { generatedAt: new Date().toISOString(), ...result };
  if (args.output) {
    const target = path.resolve(args.output);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(document, null, 2));
  }
  console.log(JSON.stringify(document, null, 2));
}

module.exports = { runComparison, configHash, deterministicComparison };
if (require.main === module) main();
