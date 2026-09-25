// Materializes inspectable Phase 3.6 profiles for the current population.
const fs = require("fs");
const path = require("path");
const P = require("./personas.js");
const S = require("./social_graph.js");
const D = require("./social_dynamics.js");
const C = require("./social_cognition.js");

const DIMENSIONS = [
  ["care", (p) => p.stable.motives.care],
  ["affiliation", (p) => p.stable.motives.affiliation],
  ["achievement", (p) => p.stable.motives.achievement],
  ["security", (p) => p.stable.motives.security],
  ["resourceProtection", (p) => p.stable.motives.resourceProtection],
  ["normSensitivity", (p) => p.stable.decisionStyle.normSensitivity],
  ["riskTolerance", (p) => p.stable.decisionStyle.riskTolerance],
  ["supportSeeking", (p) => p.stable.coping.supportSeeking],
  ["avoidance", (p) => p.stable.coping.avoidance],
];

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function generateReport(input, opts) {
  const o = opts || {};
  const personas = input.personas;
  const graph = input.graph;
  const dynamics = input.dynamics;
  const degree = Object.fromEntries(Object.keys(graph.nodes || {}).map((id) => [id, 0]));
  const sourceSets = Object.fromEntries(Object.keys(graph.nodes || {}).map((id) => [id, new Set()]));
  for (const edge of Object.values(graph.edges || {})) {
    degree[String(edge.a)] = (degree[String(edge.a)] || 0) + 1;
    degree[String(edge.b)] = (degree[String(edge.b)] || 0) + 1;
    for (const source of edge.sources || []) {
      sourceSets[String(edge.a)]?.add(source);
      sourceSets[String(edge.b)]?.add(source);
    }
  }
  const profiles = [];
  for (const persona of Object.values(personas.personas || {}).sort((a, b) => a.citizenId - b.citizenId)) {
    if (persona.deceased || !graph.nodes[String(persona.citizenId)]) continue;
    const node = graph.nodes[String(persona.citizenId)];
    const dynamic = dynamics.citizens[String(persona.citizenId)] || {};
    const profile = C.buildCognitiveProfile(persona, { helperState: dynamic });
    if (!o.includeTrace) delete profile.trace;
    profiles.push({
      citizenId: persona.citizenId,
      name: persona.name,
      templateId: persona.templateId || "inherited",
      generation: persona.generation,
      roles: {
        job: node.job || null,
        isChild: !!node.isChild,
        relationDegree: degree[String(persona.citizenId)] || 0,
        relationSources: [...(sourceSets[String(persona.citizenId)] || [])].sort(),
      },
      dynamic: {
        stress: dynamic.stress || 0,
        satisfaction: dynamic.satisfaction == null ? 0.5 : dynamic.satisfaction,
        actualLoyalty: dynamic.actualLoyalty == null ? 0.5 : dynamic.actualLoyalty,
      },
      profile,
    });
  }
  const dimensions = {};
  for (const [name, getter] of DIMENSIONS) {
    const values = profiles.map((x) => ({ citizenId: x.citizenId, name: x.name, value: getter(x.profile) }));
    const mean = values.length ? values.reduce((sum, x) => sum + x.value, 0) / values.length : 0;
    const variance = values.length
      ? values.reduce((sum, x) => sum + (x.value - mean) ** 2, 0) / values.length : 0;
    dimensions[name] = {
      mean: round4(mean),
      sd: round4(Math.sqrt(variance)),
      min: values.slice().sort((a, b) => a.value - b.value || a.citizenId - b.citizenId)[0] || null,
      max: values.slice().sort((a, b) => b.value - a.value || a.citizenId - b.citizenId)[0] || null,
    };
  }
  return {
    schema: "voyager-persona-profile-report-v1",
    cognitionSchema: C.SCHEMA,
    population: profiles.length,
    dimensions,
    profiles,
  };
}

function parseArgs(argv) {
  return Object.fromEntries(argv.map((arg) => arg.match(/^--([^=]+)=(.*)$/)).filter(Boolean)
    .map((match) => [match[1], match[2]]));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = generateReport({
    personas: P.loadAll(), graph: S.loadGraph(), dynamics: D.loadState(),
  }, { includeTrace: args.trace === "true" });
  const document = { generatedAt: new Date().toISOString(), ...report };
  if (args.output) {
    const target = path.resolve(args.output);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(document, null, 2));
  }
  console.log(JSON.stringify(document, null, 2));
}

module.exports = { DIMENSIONS, generateReport };
if (require.main === module) main();
