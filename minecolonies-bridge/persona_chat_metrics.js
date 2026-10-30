#!/usr/bin/env node
// persona_chat_metrics.js — metrics for persona_chat_experiment.js output.
// No LLM. Reads transcript_<cond>_seed<k>.jsonl in <out-dir>, computes
// per-run metrics, then per-condition mean ± sd over seeds.
//
//   node persona_chat_metrics.js <out-dir> [--fixtures=path]
// Writes <out-dir>/metrics.json and <out-dir>/metrics.md, prints the table.
//
// Metric definitions (all over successful utterances; text after cleaning):
//   meanLength        mean characters (code points) per utterance
//   truncationRate    share whose cleaned reply exceeded 40 chars (cut)
//   distinct1/2       unique char unigrams/bigrams ÷ total, pooled per run
//   selfSimilarity    Self-BLEU proxy: mean Jaccard similarity of char-3-gram
//                     sets over all utterance pairs in a run (higher = more
//                     repetitive). Simpler than BLEU, documented here.
//   nameMentionRate   share mentioning another cast member's name
//   replyRate         share mentioning someone who spoke in the visible
//                     last 8 lines (addressing a recent speaker)
//   exchange          chains u1->u2->... where u(k+1) is the addressee's first
//                     utterance within 8 turns after u(k) and it names u(k)'s
//                     speaker. Reports count of chains (len>=2) and mean len.
//   speakerGini       Gini of utterance counts (sanity: schedule is fixed, ~0)
//   mentionGini       Gini of how often each citizen is named (attention)
//   eventReaction     per event: share of the next 8 utterances containing an
//                     event keyword, and baseline = same share in the 8
//                     utterances before the event (null for turn 0)
//   relationExpression for scripted directed pairs (gratitude / resentment):
//                     among utterances by X that name Y, share containing a
//                     positive / negative lexicon word
//   duplicateRate     share of utterances identical to an earlier one in run

const fs = require("fs");
const path = require("path");

const WINDOW = 8;

const POSITIVE_WORDS = [
  "ありがとう", "ありがと", "感謝", "助か", "おかげ", "さすが", "頼り", "優し", "やさし", "好き",
  "嬉し", "うれし", "恩", "いい人", "美味し", "おいし", "すごい", "一緒", "任せ",
];
const NEGATIVE_WORDS = [
  "ふん", "どうせ", "ケチ", "けち", "嫌", "許さ", "根に", "信用でき", "信じられ", "ずるい",
  "勝手", "冷た", "文句", "むか", "ムカ", "恨", "うるさ", "知らない", "放って", "ひど",
];

// Scripted directed relations (speaker -> partner) from the fixture's
// relation script: help_succeeded => recipient feels gratitude toward helper,
// help_refused => recipient resents helper.
function relationPairs(fixtures) {
  const pairs = {};
  for (const ev of (fixtures && fixtures._meta && fixtures._meta.relationScript) || []) {
    const kind = ev.type === "help_succeeded" ? "gratitude" : ev.type === "help_refused" ? "resentment" : null;
    if (!kind) continue;
    const key = `${ev.recipientId}->${ev.helperId}`;
    pairs[key] = { from: ev.recipientId, to: ev.helperId, kind };
  }
  return Object.values(pairs);
}

function chars(s) {
  return Array.from(String(s || ""));
}

function ngrams(s, n) {
  const c = chars(s);
  const out = [];
  for (let i = 0; i + n <= c.length; i++) out.push(c.slice(i, i + n).join(""));
  return out;
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function sd(xs) {
  if (xs.length < 2) return xs.length ? 0 : null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

function gini(values) {
  const xs = values.slice().sort((a, b) => a - b);
  const n = xs.length;
  const total = xs.reduce((a, b) => a + b, 0);
  if (!n || total === 0) return 0;
  let cum = 0;
  for (let i = 0; i < n; i++) cum += (i + 1) * xs[i];
  return (2 * cum) / (n * total) - (n + 1) / n;
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function containsAny(text, words) {
  return words.some((w) => String(text).includes(w));
}

function round(v, d = 4) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

function readJsonl(file) {
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// records: full transcript of one run. castIds: all citizen ids.
function computeRunMetrics(records, opts) {
  const o = opts || {};
  const castIds = o.castIds || [...new Set(records.filter((r) => r.type === "utterance").map((r) => r.speakerId))];
  const pairs = o.relationPairs || [];
  const all = records.filter((r) => r.type === "utterance");
  const utts = all.filter((r) => r.ok && r.text);
  const events = records.filter((r) => r.type === "event");
  const n = utts.length;
  const m = { utterances: n, failed: all.length - n };
  if (!n) return m;

  m.meanLength = mean(utts.map((u) => chars(u.text).length));
  m.truncationRate = utts.filter((u) => u.truncated).length / n;

  const uni = [];
  const bi = [];
  for (const u of utts) {
    uni.push(...ngrams(u.text, 1));
    bi.push(...ngrams(u.text, 2));
  }
  m.distinct1 = uni.length ? new Set(uni).size / uni.length : null;
  m.distinct2 = bi.length ? new Set(bi).size / bi.length : null;

  const tri = utts.map((u) => new Set(ngrams(u.text, 3)));
  let simSum = 0;
  let pairsN = 0;
  for (let i = 0; i < tri.length; i++) {
    for (let j = i + 1; j < tri.length; j++) {
      simSum += jaccard(tri[i], tri[j]);
      pairsN++;
    }
  }
  m.selfSimilarity = pairsN ? simSum / pairsN : null;

  m.nameMentionRate = utts.filter((u) => (u.mentions || []).length > 0).length / n;
  m.replyRate = utts.filter((u) => (u.mentions || []).some((id) => (u.contextSpeakers || []).includes(id))).length / n;

  // exchange chains over all utterances (by turn index)
  const byTurn = utts.slice().sort((a, b) => a.turn - b.turn);
  const used = new Set();
  const chains = [];
  for (let i = 0; i < byTurn.length; i++) {
    if (used.has(i)) continue;
    let cur = i;
    let len = 1;
    for (;;) {
      const u = byTurn[cur];
      let nextIdx = -1;
      for (let j = cur + 1; j < byTurn.length && byTurn[j].turn - u.turn <= WINDOW; j++) {
        if ((u.mentions || []).includes(byTurn[j].speakerId)) { nextIdx = j; break; }
      }
      if (nextIdx < 0 || !(byTurn[nextIdx].mentions || []).includes(u.speakerId)) break;
      used.add(nextIdx);
      cur = nextIdx;
      len++;
    }
    if (len >= 2) chains.push(len);
  }
  m.exchangeChains = chains.length;
  m.meanExchangeLength = chains.length ? mean(chains) : 0;

  const spk = {};
  const men = {};
  for (const id of castIds) { spk[id] = 0; men[id] = 0; }
  for (const u of utts) {
    spk[u.speakerId] = (spk[u.speakerId] || 0) + 1;
    for (const id of u.mentions || []) men[id] = (men[id] || 0) + 1;
  }
  m.speakerGini = gini(Object.values(spk));
  m.mentionGini = gini(Object.values(men));

  const keywordsByEvent = o.eventKeywords || {};
  m.eventReaction = {};
  for (const ev of events) {
    const kw = ev.keywords || keywordsByEvent[ev.eventId] || [];
    const after = byTurn.filter((u) => u.turn >= ev.turn).slice(0, WINDOW);
    const before = byTurn.filter((u) => u.turn < ev.turn).slice(-WINDOW);
    m.eventReaction[ev.eventId] = {
      turn: ev.turn,
      rate: after.length ? after.filter((u) => containsAny(u.text, kw)).length / after.length : null,
      baseline: before.length ? before.filter((u) => containsAny(u.text, kw)).length / before.length : null,
    };
  }
  const rates = Object.values(m.eventReaction).map((x) => x.rate).filter((x) => x !== null);
  m.eventReactionMean = rates.length ? mean(rates) : null;

  m.relationExpression = {};
  for (const kind of ["gratitude", "resentment"]) {
    const ps = pairs.filter((p) => p.kind === kind);
    const addressed = utts.filter((u) => ps.some((p) => p.from === u.speakerId && (u.mentions || []).includes(p.to)));
    m.relationExpression[kind] = {
      addressed: addressed.length,
      positiveRate: addressed.length ? addressed.filter((u) => containsAny(u.text, POSITIVE_WORDS)).length / addressed.length : null,
      negativeRate: addressed.length ? addressed.filter((u) => containsAny(u.text, NEGATIVE_WORDS)).length / addressed.length : null,
    };
  }

  const seen = new Set();
  let dup = 0;
  for (const u of byTurn) {
    if (seen.has(u.text)) dup++;
    seen.add(u.text);
  }
  m.duplicateRate = dup / n;
  return m;
}

// Flatten nested metrics into "a.b.c" scalar keys.
function flatten(obj, prefix, out) {
  const o = out || {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") flatten(v, key, o);
    else if (typeof v === "number") o[key] = v;
  }
  return o;
}

function aggregate(runs) {
  const byCond = {};
  for (const r of runs) (byCond[r.condition] = byCond[r.condition] || []).push(r);
  const out = {};
  for (const [cond, rs] of Object.entries(byCond)) {
    const flats = rs.map((r) => flatten(r.metrics));
    const keys = [...new Set(flats.flatMap((f) => Object.keys(f)))].sort();
    out[cond] = { seeds: rs.map((r) => r.seed), metrics: {} };
    for (const k of keys) {
      if (/\.turn$/.test(k)) continue;
      const xs = flats.map((f) => f[k]).filter((x) => typeof x === "number" && Number.isFinite(x));
      out[cond].metrics[k] = { mean: round(mean(xs)), sd: round(sd(xs)), n: xs.length };
    }
  }
  return out;
}

const TABLE_KEYS = [
  "utterances", "meanLength", "truncationRate", "distinct1", "distinct2", "selfSimilarity",
  "nameMentionRate", "replyRate", "exchangeChains", "meanExchangeLength", "speakerGini", "mentionGini",
  "eventReactionMean", "eventReaction.food_shortage.rate", "eventReaction.house_built.rate",
  "eventReaction.house_built.baseline", "eventReaction.zombie_night.rate", "eventReaction.zombie_night.baseline",
  "relationExpression.gratitude.addressed", "relationExpression.gratitude.positiveRate",
  "relationExpression.gratitude.negativeRate", "relationExpression.resentment.addressed",
  "relationExpression.resentment.positiveRate", "relationExpression.resentment.negativeRate",
  "duplicateRate",
];

function markdownTable(agg) {
  const conds = Object.keys(agg).sort();
  const fmt = (x) => (x && x.mean !== null ? `${x.mean.toFixed(3)} ± ${(x.sd || 0).toFixed(3)}` : "—");
  const lines = [
    `| 指標 | ${conds.map((c) => `${c} (n=${agg[c].seeds.length})`).join(" | ")} |`,
    `| --- | ${conds.map(() => "---").join(" | ")} |`,
  ];
  for (const k of TABLE_KEYS) lines.push(`| ${k} | ${conds.map((c) => fmt(agg[c].metrics[k])).join(" | ")} |`);
  return lines.join("\n") + "\n";
}

function analyzeDir(dir, fixturesFile) {
  let fixtures = null;
  const fxFile = fixturesFile || path.join(__dirname, "persona_chat_fixtures.json");
  if (fs.existsSync(fxFile)) fixtures = JSON.parse(fs.readFileSync(fxFile, "utf8"));
  const pairs = relationPairs(fixtures);
  const castIds = fixtures ? fixtures.citizens.map((c) => c.id) : undefined;
  const runs = [];
  for (const f of fs.readdirSync(dir).filter((x) => /^transcript_.+\.jsonl$/.test(x)).sort()) {
    const recs = readJsonl(path.join(dir, f));
    const first = recs.find((r) => r.type === "utterance") || recs[0];
    if (!first) continue;
    runs.push({
      file: f, condition: first.condition, seed: first.seed,
      metrics: computeRunMetrics(recs, { castIds, relationPairs: pairs }),
    });
  }
  const agg = aggregate(runs);
  return { generatedAt: new Date().toISOString(), dir, relationPairs: pairs, runs, byCondition: agg, markdown: markdownTable(agg) };
}

function main() {
  const argv = process.argv.slice(2);
  const dir = argv.find((a) => !a.startsWith("--"));
  if (!dir) {
    console.error("usage: node persona_chat_metrics.js <out-dir> [--fixtures=path]");
    process.exit(2);
  }
  const fxArg = argv.find((a) => a.startsWith("--fixtures="));
  const res = analyzeDir(dir, fxArg ? fxArg.split("=")[1] : null);
  const { markdown, ...json } = res;
  fs.writeFileSync(path.join(dir, "metrics.json"), JSON.stringify(json, null, 2));
  fs.writeFileSync(path.join(dir, "metrics.md"), `# persona chat metrics\n\n${markdown}`);
  process.stdout.write(markdown);
}

module.exports = {
  POSITIVE_WORDS, NEGATIVE_WORDS, WINDOW,
  relationPairs, ngrams, gini, jaccard, mean, sd, computeRunMetrics, aggregate, markdownTable, analyzeDir,
};

if (require.main === module) main();
