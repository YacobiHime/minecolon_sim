// Runs one controlled threat-message propagation over the current social graph.
// This is observation/simulation only and never issues Minecraft commands.
const fs = require("fs");
const path = require("path");
const P = require("./personas.js");
const S = require("./social_graph.js");
const D = require("./social_dynamics.js");
const I = require("./social_information.js");

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

function highestDegreeOrigin(graph) {
  const degree = {};
  for (const edge of Object.values(graph.edges || {})) {
    degree[edge.a] = (degree[edge.a] || 0) + 1;
    degree[edge.b] = (degree[edge.b] || 0) + 1;
  }
  const highest = Object.entries(degree)
    .sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]))[0];
  return highest ? Number(highest[0]) : null;
}

function runCurrent(opts) {
  const o = opts || {};
  const personas = o.personas || P.loadAll();
  const graph = o.graph || S.loadGraph();
  const dynamics = o.dynamics || D.loadState();
  const originCitizenId = Number.isInteger(o.originCitizenId)
    ? o.originCitizenId : highestDegreeOrigin(graph);
  const createdGameTime = Number(graph._meta.gameTime) || 0;
  const message = {
    messageId: o.messageId || `threat-${createdGameTime}-${originCitizenId}`,
    type: "threat_warning",
    originCitizenId,
    evidenceEventId: o.evidenceEventId || "controlled-threat-scenario",
    createdGameTime,
    ttlTicks: Number.isFinite(o.ttlTicks) ? o.ttlTicks : 2400,
    maxHops: Number.isInteger(o.maxHops) ? o.maxHops : 6,
    urgency: Number.isFinite(o.urgency) ? o.urgency : 0.9,
  };
  return {
    schema: "voyager-information-ablation-v1",
    originCitizenId,
    seed: o.seed || "information-v1",
    conditions: Object.fromEntries(I.CONDITIONS.map((condition) => {
      const result = I.propagate({ graph, dynamics, personas, message }, {
        condition, seed: o.seed || "information-v1", mode: o.mode,
        hopTicks: o.hopTicks,
      });
      return [condition, result];
    })),
  };
}

function mean(values) {
  return values.length ? values.reduce((sum, x) => sum + x, 0) / values.length : 0;
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function runEnsemble(opts) {
  const o = opts || {};
  const runs = Number.isInteger(o.runs) && o.runs > 0 ? o.runs : 50;
  const baseSeed = o.seed || "information-ensemble-v1";
  const samples = Array.from({ length: runs }, (_, index) => runCurrent({
    ...o, seed: `${baseSeed}:${index}`,
  }));
  const conditions = {};
  for (const condition of I.CONDITIONS) {
    const metrics = samples.map((x) => x.conditions[condition].metrics);
    const coverages = metrics.map((x) => x.coverage);
    const coverageMean = mean(coverages);
    const variance = mean(coverages.map((x) => (x - coverageMean) ** 2));
    conditions[condition] = {
      runs,
      meanCoverage: round4(coverageMean),
      sdCoverage: round4(Math.sqrt(variance)),
      minCoverage: Math.min(...coverages),
      maxCoverage: Math.max(...coverages),
      meanReached: round4(mean(metrics.map((x) => x.reached))),
      meanAcceptScore: round4(mean(metrics.map((x) => x.meanAcceptScore))),
      meanRelayScore: round4(mean(metrics.map((x) => x.meanRelayScore))),
      meanMaxHop: round4(mean(metrics.map((x) => x.maxHop))),
      fullCoverageRate: round4(metrics.filter((x) => x.coverage === 1).length / runs),
    };
  }
  return {
    schema: "voyager-information-ensemble-v1",
    seed: baseSeed,
    runs,
    originCitizenId: samples[0].originCitizenId,
    conditions,
    example: samples[0],
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const runnerOpts = {
    originCitizenId: args.origin ? parseInt(args.origin, 10) : undefined,
    seed: args.seed,
    mode: args.mode,
    ttlTicks: args.ttl ? parseInt(args.ttl, 10) : undefined,
    maxHops: args.hops ? parseInt(args.hops, 10) : undefined,
    urgency: args.urgency ? parseFloat(args.urgency) : undefined,
    hopTicks: args.hopTicks ? parseInt(args.hopTicks, 10) : undefined,
  };
  const result = args.runs
    ? runEnsemble({ ...runnerOpts, runs: parseInt(args.runs, 10) })
    : runCurrent(runnerOpts);
  const document = { generatedAt: new Date().toISOString(), ...result };
  if (args.output) {
    const target = path.resolve(args.output);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(document, null, 2));
  }
  console.log(JSON.stringify(document, null, 2));
}

module.exports = { highestDegreeOrigin, runCurrent, runEnsemble };
if (require.main === module) main();
