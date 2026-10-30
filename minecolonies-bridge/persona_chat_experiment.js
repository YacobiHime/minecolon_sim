#!/usr/bin/env node
// persona_chat_experiment.js — persona A/B conversation experiment (no game).
//
// Question: does an enriched persona prompt ("stage 1") make citizens' village
// chat more varied, more relationship-aware and more event-responsive than the
// thin persona used by chat_capacity_bench.js?
//
//   A (thin)     : name + job + one personality line (the current bench prompt).
//   B (enriched) : A + natural-language profile (age/generation, family,
//                  background, speech habits from speechStyle, temperament as
//                  words), current concern (need priorities + scripted state),
//                  own mood (6 emotions, rule-based), and relationship text
//                  toward the people who appear in the last 8 chat lines
//                  (trust/affinity/gratitude/resentment/help memory).
//                  Everything is rendered deterministically: no extra LLM calls.
//                  Inspired by AgentSociety (profile/needs/emotion) and
//                  Humanoid Agents (basic needs, emotion, closeness).
//
// The persona stack is only READ: personas.js (templates, assignFromTemplate,
// makeChildPersona), social_cognition.js (buildCognitiveProfile),
// social_dynamics.js (reconcileState/applyEvent/perspectiveFor/
// effectivePerspective). Those modules are not modified.
//
// Simulation: fixed cast of 8 (persona_chat_fixtures.json), fixed opening
// lines, scripted narrator events at fixed utterance indices, N utterances
// (default 360 = 8 x 45). Speaker order is a per-round seeded shuffle (each
// citizen speaks exactly once per round, never twice in a row) that depends on
// the run seed only, so A and B with the same seed have identical speakers and
// identical llama.cpp `seed` values per turn (paired design).
//
// LLM: OpenAI-compatible /v1/chat/completions (llama.cpp llama-server),
// Authorization: Bearer $LLM_API_KEY (env only; never logged or written).
//
// Usage:
//   node persona_chat_experiment.js --conditions=A,B --seeds=1,2,3,4,5 \
//        --turns=360 --out-dir=persona_chat_results/run1
//   node persona_chat_experiment.js --dry-prompts            # no LLM
//   node persona_chat_experiment.js --write-fixtures         # regenerate fixture
// Options: --llm-hosts=h:p[,h:p] (default 127.0.0.1:18080) --model=local
//   --temperature=0.8 --max-tokens=60 --timeout-ms=60000 --retries=2
//   --parallel=2 (conversations at once) --concurrency=1 (per conversation;
//   only 1 is meaningful because every line depends on the previous one)
//   --save-all-prompts (write the full system prompt on every transcript line)
//   --fixtures=path

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

const Personas = require("./personas.js");
const Cognition = require("./social_cognition.js");
const Dynamics = require("./social_dynamics.js");

const CONTEXT_LINES = 8;
const MAX_CHARS = 40;
const DEFAULT_TURNS = 360;
const FIXTURE_FILE = path.join(__dirname, "persona_chat_fixtures.json");
const FIXTURE_SEED = "persona-chat-fixtures-v1";
const FIXTURE_CREATED_AT = "2026-10-30T00:00:00.000Z";
const NARRATOR_ID = 0;
const NARRATOR_NAME = "(村の知らせ)";
// Scripted relation history happens at game time 0 and the conversation is
// evaluated a quarter day later (affect half-life 24000 ticks -> factor ~0.84).
const EVAL_GAME_TIME = 6000;
// Event salience decays per utterance (not wall clock): half-life 40 lines.
const EVENT_HALF_LIFE_TURNS = 40;
const SURPRISE_HALF_LIFE_TURNS = 8;

// ------------------------------------------------------------ small utils

function hash32(str) {
  const h = crypto.createHash("sha256").update(String(str)).digest();
  return h.readUInt32BE(0);
}

function mulberry32(a) {
  let s = a >>> 0;
  return function rng() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededRng(str) {
  return mulberry32(hash32(str));
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

function sha1(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex");
}

function chars(s) {
  return Array.from(String(s || ""));
}

// llama.cpp `seed` for a given run seed and utterance index. Independent of
// the condition so A/B with the same run seed are paired.
function llmSeedFor(runSeed, turn) {
  return hash32(`llm:${runSeed}:${turn}`) & 0x7fffffff;
}

// --------------------------------------------------------------- fixtures

// Hand-authored identity (name/job/age/background) on top of real P1
// templates. thinPersonality is one of the 8 PERSONALITIES lines of
// chat_capacity_bench.js (condition A), each matched to the template.
const CAST_SPEC = [
  { id: 1, name: "アオイ", gender: "female", age: 24, job: "deliveryman", jobLabel: "配達人",
    template: "social_butterfly", thinPersonality: "陽気でおしゃべり。冗談が好き。",
    background: "村中を荷物を持って走り回るので、誰の噂もすぐ耳に入る。" },
  { id: 2, name: "ハルト", gender: "male", age: 31, job: "ranger", jobLabel: "狩人",
    template: "rebel_hunter", thinPersonality: "皮肉屋だが根は優しい。",
    background: "森で獲物を追う一匹狼。市長の命令には従いたがらない。" },
  { id: 3, name: "ミナ", gender: "female", age: 45, job: "cook", jobLabel: "料理人",
    template: "devoted_cook", thinPersonality: "世話好き。困っている人に声をかける。",
    background: "食堂を切り盛りしていて、腹をすかせた人を放っておけない。" },
  { id: 4, name: "ソウタ", gender: "male", age: 48, job: "miner", jobLabel: "鉱夫",
    template: "stubborn_miner", thinPersonality: "働き者で無口。仕事の話ばかりする。",
    background: "村ができた頃から鉱山を掘り続けている古参。" },
  { id: 5, name: "ユイ", gender: "female", age: 29, job: "researcher", jobLabel: "研究者",
    template: "cautious_scholar", thinPersonality: "慎重で心配性。食料の備蓄が気になる。",
    background: "研究所で村の記録をつけている。体が弱く、よく寝込む。" },
  { id: 6, name: "レン", gender: "male", age: 35, job: "blacksmith", jobLabel: "鍛冶屋",
    template: "ambitious_trader", thinPersonality: "野心家。村をもっと大きくしたい。",
    background: "鍛冶仕事のかたわら、品物の売り買いで一儲けを狙っている。" },
  { id: 7, name: "サクラ", gender: "female", age: 17, job: "farmer", jobLabel: "農家",
    parents: [3, 4], thinPersonality: "好奇心旺盛。新しい建物に興味がある。",
    background: "ミナとソウタの娘。畑仕事を任されたばかりで、何でも知りたがる。" },
  { id: 8, name: "カイト", gender: "male", age: 22, job: "fisherman", jobLabel: "漁師",
    template: "lazy_dreamer", thinPersonality: "のんびり屋。天気と昼寝の話が好き。",
    background: "川辺で釣り糸を垂れながら雲を眺めている時間が一番好き。" },
];

// Scripted relation history (directed, applied with social_dynamics.applyEvent):
// two "received help" pairs (gratitude/trust high) and one refused-help pair.
const RELATION_SCRIPT = [
  { type: "help_succeeded", helperId: 3, recipientId: 8, note: "ミナがカイトに食事を分けた(1回目)" },
  { type: "help_succeeded", helperId: 3, recipientId: 8, note: "ミナがカイトに食事を分けた(2回目)" },
  { type: "help_succeeded", helperId: 2, recipientId: 5, note: "ハルトが寝込んだユイに肉を届けた(1回目)" },
  { type: "help_succeeded", helperId: 2, recipientId: 5, note: "ハルトが寝込んだユイに肉を届けた(2回目)" },
  { type: "help_refused", helperId: 6, recipientId: 1, note: "レンがアオイの頼みを断った(1回目)" },
  { type: "help_refused", helperId: 6, recipientId: 1, note: "レンがアオイの頼みを断った(2回目)" },
];

const FAMILY_EDGES = [
  { a: 3, b: 4, source: "partner" },
  { a: 3, b: 7, source: "parent_child" },
  { a: 4, b: 7, source: "parent_child" },
  { a: 3, b: 7, source: "co_resident" },
  { a: 4, b: 7, source: "co_resident" },
  { a: 3, b: 4, source: "co_resident" },
];

// Build the fixture deterministically from the real persona/dynamics code.
function buildFixtures() {
  const rng = seededRng(FIXTURE_SEED);
  const templates = Personas.loadTemplates();
  const byId = {};
  const citizens = [];
  for (const spec of CAST_SPEC) {
    let persona;
    if (spec.parents) {
      const [pa, pb] = spec.parents.map((id) => byId[id]);
      // happiness 6 vs 4 -> 60% chance per segment from the first parent
      persona = Personas.makeChildPersona({ id: spec.id, name: spec.name }, pa, pb, 6, 4,
        { rng, mutationRate: 0.1 });
    } else {
      persona = Personas.assignFromTemplate({ id: spec.id, name: spec.name }, spec.template,
        { templates, rng });
    }
    persona.createdAt = FIXTURE_CREATED_AT;
    byId[spec.id] = persona;
    citizens.push({
      id: spec.id, name: spec.name, gender: spec.gender, age: spec.age,
      job: spec.job, jobLabel: spec.jobLabel, background: spec.background,
      thinPersonality: spec.thinPersonality, persona,
    });
  }
  // Village of 8: everyone is a neighbor; family edges added on top.
  const edges = {};
  const addEdge = (a, b, source) => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = `${lo}:${hi}`;
    if (!edges[key]) edges[key] = { a: lo, b: hi, sources: [] };
    if (!edges[key].sources.includes(source)) edges[key].sources.push(source);
    edges[key].sources.sort();
  };
  for (let i = 0; i < citizens.length; i++) {
    for (let j = i + 1; j < citizens.length; j++) addEdge(citizens[i].id, citizens[j].id, "neighbor");
  }
  for (const e of FAMILY_EDGES) addEdge(e.a, e.b, e.source);
  const graph = {
    _meta: { colonyId: 0 },
    nodes: Object.fromEntries(citizens.map((c) => [String(c.id), {
      citizenId: c.id, name: c.name, nutritionBand: "fed", sick: false, disease: null,
    }])),
    edges,
  };
  const personasStore = { personas: byId };
  const dynamics = Dynamics.reconcileState(null, graph, personasStore);
  for (const ev of RELATION_SCRIPT) Dynamics.applyEvent(dynamics, ev, personasStore, 0);
  // ユイ starts the conversation sick (scripted state).
  Dynamics.applyEvent(dynamics, { type: "sickness_started", citizenId: 5, disease: "風邪" },
    personasStore, 0);
  dynamics._meta.updatedAt = null;
  return {
    _meta: {
      schema: "persona-chat-fixtures-v1",
      _comment: "persona_chat_experiment.js の固定キャスト。node persona_chat_experiment.js --write-fixtures で再生成(決定論的)。personas.js / social_dynamics.js の実関数で作る。",
      seed: FIXTURE_SEED,
      evalGameTime: EVAL_GAME_TIME,
      relationScript: RELATION_SCRIPT,
    },
    citizens,
    dynamics,
  };
}

function loadFixtures(file) {
  return JSON.parse(fs.readFileSync(file || FIXTURE_FILE, "utf8"));
}

// -------------------------------------------------------------- scenario

const SEED_LINES = [
  { speakerId: 1, text: "今日は広場がにぎやかだね!" },
  { speakerId: 4, text: "…おう、鉱山から戻った" },
  { speakerId: 3, text: "みんな、ちゃんと食べてる?" },
  { speakerId: 6, text: "市場の鉄の値段がまた上がってたな" },
];

// at: fraction of total turns (0, 1/3, 2/3). Effects mutate the run state.
const EVENT_SCRIPT = [
  { id: "food_shortage", at: 0, text: "食料が足りなくなってきた",
    effects: [
      { type: "nutrition_changed", citizenId: 8, from: "fed", to: "hungry" },
      { type: "nutrition_changed", citizenId: 1, from: "fed", to: "hungry" },
      { type: "nutrition_changed", citizenId: 4, from: "fed", to: "starving" },
    ],
    world: { foodShortage: true } },
  { id: "house_built", at: 1 / 3, text: "新しい家が完成した", effects: [], world: { houseBuilt: true } },
  { id: "zombie_night", at: 2 / 3, text: "夜、ゾンビが村に近づいている", effects: [], world: { threat: true } },
];

const EVENT_KEYWORDS = {
  food_shortage: ["食料", "食べ", "食い", "腹", "ごはん", "ご飯", "飯", "パン", "小麦", "魚", "畑", "蓄え", "備蓄",
    "空腹", "飢え", "料理", "肉", "スープ", "腹ぺこ", "腹減"],
  house_built: ["家", "完成", "新居", "建て", "建っ", "住", "引っ越", "屋根", "部屋"],
  zombie_night: ["ゾンビ", "夜", "襲", "守", "戦", "武器", "逃げ", "避難", "扉", "見張", "危", "怖", "弓", "剣"],
};

function eventTurns(turns) {
  return EVENT_SCRIPT.map((e) => ({ ...e, turn: Math.floor(e.at * turns) }));
}

// Per-round seeded shuffle: everyone speaks once per round, no speaker twice
// in a row across round boundaries. Depends on run seed only.
function buildSchedule(ids, turns, runSeed) {
  const rng = seededRng(`schedule:${runSeed}`);
  const out = [];
  while (out.length < turns) {
    const round = ids.slice();
    for (let i = round.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [round[i], round[j]] = [round[j], round[i]];
    }
    if (out.length && round.length > 1 && round[0] === out[out.length - 1]) {
      const k = 1 + Math.floor(rng() * (round.length - 1));
      [round[0], round[k]] = [round[k], round[0]];
    }
    for (const id of round) if (out.length < turns) out.push(id);
  }
  return out;
}

// ------------------------------------------------------------ rendering

const PERSONALITY_WORDS = {
  bravery: ["勇敢", "臆病"],
  empathy: ["思いやりがある", "他人の気持ちに無頓着"],
  obedience: ["素直で決まりを守る", "指図されるのが嫌い"],
  greed: ["欲が深い", "欲がない"],
  sociability: ["話好き", "人付き合いが苦手"],
  loyalty: ["村への愛着が強い", "村に冷めている"],
  ambition: ["野心家", "出世に興味がない"],
};
const HIGH = 0.7;
const LOW = 0.3;

function temperamentWords(persona) {
  const seg = persona.segments;
  const vals = { ...seg.temperament, ...seg.politics };
  const words = [];
  for (const [k, [hi, lo]] of Object.entries(PERSONALITY_WORDS)) {
    if (typeof vals[k] !== "number") continue;
    if (vals[k] >= HIGH) words.push(hi);
    else if (vals[k] <= LOW) words.push(lo);
  }
  return words;
}

function verbosityText(v) {
  if (v >= 0.7) return "よくしゃべるほう";
  if (v <= 0.3) return "口数が少ない";
  return "ふつうにしゃべる";
}

function kinLabel(fx, selfId, otherId) {
  const self = fx.byId[selfId];
  const other = fx.byId[otherId];
  if ((self.persona.parents || []).includes(otherId)) return other.gender === "female" ? "母" : "父";
  if ((other.persona.parents || []).includes(selfId)) return other.gender === "female" ? "娘" : "息子";
  const rel = Dynamics.relationFor(fx.dynamics, selfId, otherId);
  if (rel && rel.sources.includes("partner")) return other.gender === "female" ? "妻" : "夫";
  if (rel && rel.sources.includes("sibling")) return "きょうだい";
  return null;
}

function familyText(fx, c) {
  const parts = [];
  for (const other of fx.citizens) {
    if (other.id === c.id) continue;
    const label = kinLabel(fx, c.id, other.id);
    if (label) parts.push(`${label}は${other.name}`);
  }
  return parts.length ? parts.join("、") : "村に家族はいない";
}

function generationText(g) {
  return g === 0 ? "村の第一世代" : `村生まれの第${g + 1}世代`;
}

function profileText(fx, c) {
  const p = c.persona;
  const words = temperamentWords(p);
  const tone = p.segments.speechStyle.tone;
  return [
    `年齢: ${c.age}歳(${generationText(p.generation)})`,
    `家族: ${familyText(fx, c)}`,
    `生い立ち: ${c.background}`,
    `性格: ${words.length ? words.join("、") : "おだやかで目立った癖はない"}`,
    `話し方: ${tone}。${verbosityText(p.segments.speechStyle.verbosity)}`,
  ].join("\n");
}

function cognitiveProfile(c) {
  return Cognition.buildCognitiveProfile(c.persona, {});
}

function recency(turn, eventTurn, halfLife) {
  if (eventTurn == null || turn < eventTurn) return 0;
  return Math.pow(0.5, (turn - eventTurn) / halfLife);
}

// Relation of `selfId` toward `otherId` (effective affect at evalGameTime).
function relationView(fx, selfId, otherId) {
  const rel = Dynamics.relationFor(fx.dynamics, selfId, otherId);
  if (!rel) return null;
  const raw = rel.perspectives && rel.perspectives[String(selfId)];
  if (!raw) return null;
  return Dynamics.effectivePerspective(raw, fx.evalGameTime);
}

function relationText(fx, selfId, otherId) {
  const other = fx.byId[otherId];
  const v = relationView(fx, selfId, otherId);
  const parts = [];
  const kin = kinLabel(fx, selfId, otherId);
  if (kin) parts.push(`自分の${kin}`);
  if (v) {
    const g = v.affect.gratitude;
    const r = v.affect.resentment;
    const m = v.memory || {};
    if (m.helpReceived > 0) parts.push(`前に食べ物を分けてもらった(${m.helpReceived}回)`);
    if (m.refusalsReceived > 0) parts.push(`前に頼みを断られた(${m.refusalsReceived}回)`);
    if (m.helpGiven > 0) parts.push("前に助けてあげた");
    if (m.requestsRefused > 0) parts.push("前に頼みを断ったことがある");
    if (g >= 0.25) parts.push("恩がある");
    else if (g >= 0.08) parts.push("少し恩を感じている");
    if (r >= 0.25) parts.push("根に持っている");
    else if (r >= 0.08) parts.push("少し根に持っている");
    if (v.obligation >= 0.15) parts.push("借りを返したいと思っている");
    if (v.trust >= 0.6) parts.push("信頼している");
    else if (v.trust <= 0.4) parts.push("あまり信用していない");
    if (v.affinity >= 0.58) parts.push("好意を持っている");
    else if (v.affinity <= 0.45) parts.push("少し苦手");
  }
  if (!parts.length) parts.push("ふつうの顔見知り");
  return `${other.name}: ${parts.join("、")}`;
}

// Six basic emotions (Ekman), rule-based from state + scripted events +
// relations of people present in the context. No LLM.
const EMOTION_WORDS = {
  joy: "うれしい",
  sadness: "気が沈んでいる",
  anger: "いらいらしている",
  fear: "怖い",
  disgust: "うんざりしている",
  surprise: "驚いている",
};

function computeMood(fx, c, state, world, turn, presentIds) {
  const prof = cognitiveProfile(c);
  const t = prof.inheritedTraits.temperament;
  const em = prof.stable.emotionDynamics;
  const cs = state.citizens[String(c.id)];
  const hunger = Cognition.nutritionSeverity(cs.nutritionBand);
  const sick = cs.sick ? 1 : 0;
  const stress = cs.stress || 0;
  const house = recency(turn, world.houseBuiltTurn, EVENT_HALF_LIFE_TURNS);
  const threat = world.threatTurn != null && turn >= world.threatTurn
    ? Math.max(0.5, recency(turn, world.threatTurn, EVENT_HALF_LIFE_TURNS)) : 0;
  let surprise = 0;
  for (const et of [world.foodShortageTurn, world.houseBuiltTurn, world.threatTurn]) {
    surprise = Math.max(surprise, recency(turn, et, SURPRISE_HALF_LIFE_TURNS));
  }
  let grat = 0;
  let resent = 0;
  for (const id of presentIds) {
    const v = relationView(fx, c.id, id);
    if (!v) continue;
    grat = Math.max(grat, v.affect.gratitude);
    resent = Math.max(resent, v.affect.resentment);
  }
  const damp = 1 - 0.3 * em.suppression;
  const raw = {
    joy: 0.15 * cs.satisfaction + 0.6 * house * (0.5 + 0.5 * t.sociability) + 0.8 * grat
      - 0.25 * hunger - 0.3 * threat * em.threatSensitivity,
    sadness: 0.5 * hunger * em.concernSensitivity + 0.3 * sick + 0.2 * stress,
    anger: 0.4 * hunger * (1 - t.empathy) + 1.2 * resent + 0.2 * stress * (1 - t.obedience),
    fear: 0.9 * threat * em.threatSensitivity + 0.2 * sick * (1 - t.bravery),
    disgust: 0.8 * resent * em.negativePersistence + 0.2 * hunger * t.greed,
    surprise: 0.6 * surprise,
  };
  const mood = {};
  for (const [k, v] of Object.entries(raw)) mood[k] = round3(clamp01(v * damp));
  return mood;
}

function moodText(mood) {
  const shown = Object.entries(mood).filter(([, v]) => v >= 0.2)
    .sort((a, b) => b[1] - a[1]).slice(0, 2);
  if (!shown.length) return "落ち着いている";
  return shown.map(([k, v]) => `${v >= 0.65 ? "かなり" : v < 0.4 ? "少し" : ""}${EMOTION_WORDS[k]}`).join("、");
}

const NEED_TEXT = {
  belonging: "仲間とのつながりを大事にしたい",
  competence: "仕事で認められたい",
  autonomy: "自分のやり方を通したい",
  security: "村の安全と蓄えが気になる",
  caregiving: "困っている人の世話を焼きたい",
};

function concernList(fx, c, state, world, turn) {
  const prof = cognitiveProfile(c);
  const needs = prof.stable.needPriorities;
  const em = prof.stable.emotionDynamics;
  const cs = state.citizens[String(c.id)];
  const hunger = Cognition.nutritionSeverity(cs.nutritionBand);
  const cands = [];
  if (hunger >= 1) cands.push({ key: "starving", score: 1.2, text: "ひどく空腹で、食べ物のことで頭がいっぱい" });
  else if (hunger > 0) cands.push({ key: "hungry", score: 0.9, text: "お腹がすいていて、食べ物が気になる" });
  if (cs.sick) cands.push({ key: "sick", score: 0.95, text: `${cs.disease || "病気"}で体調が悪く、早く治したい` });
  if (world.foodShortageTurn != null && turn >= world.foodShortageTurn && hunger === 0) {
    cands.push({ key: "food_shortage", score: 0.35 + 0.5 * needs.security + 0.2 * needs.caregiving,
      text: "村の食料不足が心配" });
  }
  if (world.threatTurn != null && turn >= world.threatTurn) {
    cands.push({ key: "threat", score: 0.5 + 0.6 * em.threatSensitivity,
      text: "近づくゾンビから村と自分の身を守りたい" });
  }
  const house = recency(turn, world.houseBuiltTurn, EVENT_HALF_LIFE_TURNS);
  if (house > 0) {
    cands.push({ key: "house", score: 0.3 + 0.5 * house * needs.belonging,
      text: "新しい家に誰が住むのか気になる" });
  }
  for (const [k, v] of Object.entries(needs)) cands.push({ key: `need:${k}`, score: 0.6 * v, text: NEED_TEXT[k] });
  cands.sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : 1));
  return cands.slice(0, 2);
}

// ------------------------------------------------------------- prompts

function thinSystemPrompt(c) {
  // Identical to chat_capacity_bench.js systemPrompt().
  return (
    `あなたは Minecraft の村(MineColonies)の住民「${c.name}」です。職業: ${c.job}。性格: ${c.personality}\n` +
    `村のチャットで仲間と会話しています。直前の会話に反応して、短い日本語のチャット1行(${MAX_CHARS}文字以内)だけを返してください。` +
    `かぎかっこ・引用符・名前の前置きは付けないでください。`
  );
}

function presentSpeakers(lines, selfId) {
  const ids = [];
  for (const l of lines) {
    if (l.speakerId === NARRATOR_ID || l.speakerId === selfId) continue;
    if (!ids.includes(l.speakerId)) ids.push(l.speakerId);
  }
  return ids;
}

// Returns { system, dynamic } for one speaker. dynamic is null for A.
function buildSystemPrompt(condition, fx, c, ctx) {
  const thin = thinSystemPrompt({ name: c.name, job: c.job, personality: c.thinPersonality });
  if (condition === "A") return { system: thin, dynamic: null };
  if (condition !== "B") throw new Error(`unknown condition ${condition}`);
  const present = presentSpeakers(ctx.lines, c.id);
  const mood = computeMood(fx, c, ctx.state, ctx.world, ctx.turn, present);
  const concerns = concernList(fx, c, ctx.state, ctx.world, ctx.turn);
  const relations = present.map((id) => ({ id, text: relationText(fx, c.id, id) }));
  const concernStr = concerns.map((x) => x.text).join("。");
  const mText = moodText(mood);
  const system =
    `あなたは Minecraft の村(MineColonies)の住民「${c.name}」です。職業: ${c.jobLabel}(${c.job})。\n` +
    `【プロフィール】\n${profileText(fx, c)}\n` +
    `【いま気になっていること】${concernStr}\n` +
    `【今の気分】${mText}\n` +
    (relations.length
      ? `【会話にいる人への気持ち】\n${relations.map((r) => `- ${r.text}`).join("\n")}\n`
      : "") +
    `村のチャットで仲間と会話しています。上の人物になりきり、気分や相手への気持ちが自然ににじむように、` +
    `直前の会話に反応して、短い日本語のチャット1行(${MAX_CHARS}文字以内)だけを返してください。` +
    `設定をそのまま説明しないでください。かぎかっこ・引用符・名前の前置きは付けないでください。`;
  return {
    system,
    dynamic: {
      mood, moodText: mText,
      concerns: concerns.map((x) => ({ key: x.key, score: round3(x.score), text: x.text })),
      relationsShown: relations,
    },
  };
}

function userPrompt(lines, fx) {
  if (!lines.length) return "(まだ誰も話していません。会話を始めてください。)";
  return "最近のチャット:\n" + lines.map((l) => `${lineName(fx, l)}: ${l.text}`).join("\n") + "\n\nあなたの次の発言:";
}

function lineName(fx, l) {
  return l.speakerId === NARRATOR_ID ? NARRATOR_NAME : fx.byId[l.speakerId].name;
}

function buildMessages(condition, fx, c, ctx) {
  const lines = ctx.lines.slice(-CONTEXT_LINES);
  const sp = buildSystemPrompt(condition, fx, c, { ...ctx, lines });
  return {
    messages: [
      { role: "system", content: sp.system },
      { role: "user", content: userPrompt(lines, fx) },
    ],
    dynamic: sp.dynamic,
    contextLines: lines,
  };
}

// One short line: first non-empty line, strip a name prefix / quotes.
function cleanReply(text, names) {
  let t = String(text || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || "";
  // Strip "Name:" prefixes only (a leading name followed by a colon). A line
  // that merely starts by addressing someone ("ミナさん、…") is kept intact.
  for (const n of [...(names || []), NARRATOR_NAME]) {
    const m = new RegExp(`^${n.replace(/[()]/g, "\\$&")}\\s*(さん)?\\s*[:：]\\s*`).exec(t);
    if (m) {
      t = t.slice(m[0].length);
      break;
    }
  }
  t = t.replace(/^[^\s:：]{1,12}[:：]\s*/, "");
  t = t.replace(/^[「『"'“]+|[」』"'”]+$/g, "").trim();
  const cs = chars(t);
  return { text: cs.slice(0, MAX_CHARS).join(""), truncated: cs.length > MAX_CHARS, fullLength: cs.length };
}

function mentionsIn(text, fx, selfId) {
  return fx.citizens.filter((c) => c.id !== selfId && String(text).includes(c.name)).map((c) => c.id);
}

// ---------------------------------------------------------------- LLM

function buildLlmRequest(opts, messages, seed) {
  const body = {
    model: opts.model, messages, max_tokens: opts.maxTokens,
    temperature: opts.temperature, stream: false, seed,
  };
  const payload = JSON.stringify(body);
  const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
  return { path: "/v1/chat/completions", headers, payload, body };
}

function numOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function llmChat(hostPort, opts, messages, seed) {
  return new Promise((resolve) => {
    const { path: p, headers, payload } = buildLlmRequest(opts, messages, seed);
    const t0 = Date.now();
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      resolve({ host: `${hostPort.host}:${hostPort.port}`, latencyMs: Date.now() - t0, ...r });
    };
    const req = http.request({ host: hostPort.host, port: hostPort.port, path: p, method: "POST", headers }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (data += d));
      res.on("end", () => {
        if (res.statusCode !== 200) return finish({ ok: false, error: `HTTP ${res.statusCode}: ${data.slice(0, 200)}` });
        try {
          const parsed = JSON.parse(data);
          const choice = Array.isArray(parsed.choices) && parsed.choices[0];
          const text = choice && choice.message && typeof choice.message.content === "string"
            ? choice.message.content : "";
          const usage = parsed.usage || {};
          const timings = parsed.timings || {};
          const stats = {
            promptTokens: numOrNull(timings.prompt_n) ?? numOrNull(usage.prompt_tokens),
            completionTokens: numOrNull(timings.predicted_n) ?? numOrNull(usage.completion_tokens),
            finishReason: choice && choice.finish_reason || null,
          };
          if (!text.trim()) finish({ ok: false, error: "empty reply", rawText: text, ...stats });
          else finish({ ok: true, rawText: text, ...stats });
        } catch (e) {
          finish({ ok: false, error: `bad JSON: ${e.message}` });
        }
      });
    });
    req.setTimeout(opts.timeoutMs, () => req.destroy(new Error(`timeout after ${opts.timeoutMs}ms`)));
    req.on("error", (e) => finish({ ok: false, error: e.message }));
    req.write(payload);
    req.end();
  });
}

function makeHostPicker(hosts) {
  let i = 0;
  return () => hosts[i++ % hosts.length];
}

// ----------------------------------------------------------- simulation

function prepareFixtures(raw) {
  const fx = {
    citizens: raw.citizens,
    byId: Object.fromEntries(raw.citizens.map((c) => [c.id, c])),
    dynamics: raw.dynamics,
    evalGameTime: raw._meta.evalGameTime,
    raw,
  };
  return fx;
}

function newRunState(fx) {
  return {
    state: JSON.parse(JSON.stringify(fx.dynamics)),
    world: { foodShortageTurn: null, houseBuiltTurn: null, threatTurn: null },
  };
}

function applyScriptedEvent(fx, run, ev) {
  const personasStore = { personas: Object.fromEntries(fx.citizens.map((c) => [String(c.id), c.persona])) };
  for (const eff of ev.effects) Dynamics.applyEvent(run.state, eff, personasStore, fx.evalGameTime);
  if (ev.world.foodShortage) run.world.foodShortageTurn = ev.turn;
  if (ev.world.houseBuilt) run.world.houseBuiltTurn = ev.turn;
  if (ev.world.threat) run.world.threatTurn = ev.turn;
}

// Run one conversation. llm(messages, seed) -> {ok, rawText, latencyMs, ...}.
// write(record) receives transcript records in order.
async function runConversation({ fx, condition, seed, turns, llm, write, retries, saveAllPrompts }) {
  const ids = fx.citizens.map((c) => c.id);
  const names = fx.citizens.map((c) => c.name);
  const schedule = buildSchedule(ids, turns, seed);
  const events = eventTurns(turns);
  const run = newRunState(fx);
  const lines = [];
  const firstPrompts = {};
  SEED_LINES.forEach((s, k) => {
    lines.push({ speakerId: s.speakerId, text: s.text });
    write({ type: "seed_line", turn: k - SEED_LINES.length, condition, seed,
      speakerId: s.speakerId, speakerName: fx.byId[s.speakerId].name, text: s.text });
  });
  let okCount = 0;
  for (let turn = 0; turn < turns; turn++) {
    const markers = [];
    for (const ev of events.filter((e) => e.turn === turn)) {
      applyScriptedEvent(fx, run, ev);
      lines.push({ speakerId: NARRATOR_ID, text: ev.text, eventId: ev.id });
      markers.push(ev.id);
      write({ type: "event", turn, condition, seed, eventId: ev.id, text: ev.text,
        effects: ev.effects, keywords: EVENT_KEYWORDS[ev.id] });
    }
    const speakerId = schedule[turn];
    const c = fx.byId[speakerId];
    const built = buildMessages(condition, fx, c, { lines, state: run.state, world: run.world, turn });
    const sys = built.messages[0].content;
    if (!firstPrompts[speakerId]) firstPrompts[speakerId] = { turn, system: sys, user: built.messages[1].content };
    const llmSeed = llmSeedFor(seed, turn);
    let r = null;
    let attempts = 0;
    for (; attempts <= retries; attempts++) {
      r = await llm(built.messages, llmSeed);
      if (r.ok) {
        const cleaned = cleanReply(r.rawText, names);
        if (cleaned.text) break;
        r = { ...r, ok: false, error: "empty after cleaning" };
      }
    }
    const rec = {
      type: "utterance", turn, condition, seed, speakerId, speakerName: c.name, llmSeed,
      ok: !!r.ok, attempts: Math.min(attempts + 1, retries + 1), error: r.ok ? null : r.error,
      host: r.host || null, latencyMs: r.latencyMs ?? null,
      promptTokens: r.promptTokens ?? null, completionTokens: r.completionTokens ?? null,
      promptChars: chars(sys).length + chars(built.messages[1].content).length,
      finishReason: r.finishReason || null,
      rawText: r.rawText ?? null, text: "", truncated: false, fullLength: 0,
      mentions: [], mentionNames: [],
      eventMarkers: markers,
      activeEvents: Object.entries(run.world).filter(([, v]) => v != null).map(([k]) => k.replace(/Turn$/, "")),
      contextSpeakers: built.contextLines.map((l) => l.speakerId),
      systemPromptSha1: sha1(sys),
      persona: built.dynamic,
    };
    if (saveAllPrompts) rec.systemPrompt = sys;
    if (r.ok) {
      const cleaned = cleanReply(r.rawText, names);
      rec.text = cleaned.text;
      rec.truncated = cleaned.truncated;
      rec.fullLength = cleaned.fullLength;
      rec.mentions = mentionsIn(cleaned.text, fx, speakerId);
      rec.mentionNames = rec.mentions.map((id) => fx.byId[id].name);
      lines.push({ speakerId, text: cleaned.text });
      okCount++;
    }
    write(rec);
  }
  return { schedule, firstPrompts, okCount };
}

// --------------------------------------------------------------- CLI

function parseArgs(argv) {
  const args = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) args[m[1]] = m[2] === undefined ? true : m[2];
  }
  return args;
}

function parseHostPort(s, defPort) {
  const str = String(s).trim();
  const i = str.lastIndexOf(":");
  if (i < 0) return { host: str, port: defPort };
  return { host: str.slice(0, i), port: parseInt(str.slice(i + 1), 10) || defPort };
}

function buildOptions(args, env) {
  const e = env || process.env;
  const conditions = String(args.conditions || "A,B").split(",").map((s) => s.trim()).filter(Boolean);
  for (const cnd of conditions) if (!["A", "B"].includes(cnd)) throw new Error(`unknown condition ${cnd}`);
  const seeds = String(args.seeds || "1,2,3,4,5").split(",").map((s) => s.trim()).filter(Boolean);
  const concurrency = parseInt(args.concurrency || "1", 10);
  return {
    conditions, seeds,
    turns: parseInt(args.turns || String(DEFAULT_TURNS), 10),
    outDir: args["out-dir"] || path.join(__dirname, "persona_chat_results",
      new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "")),
    hosts: String(args["llm-hosts"] || "127.0.0.1:18080").split(",").filter(Boolean).map((s) => parseHostPort(s, 18080)),
    model: args.model || "local",
    temperature: args.temperature !== undefined ? Number(args.temperature) : 0.8,
    maxTokens: parseInt(args["max-tokens"] || "60", 10),
    timeoutMs: parseInt(args["timeout-ms"] || "60000", 10),
    retries: parseInt(args.retries || "2", 10),
    parallel: Math.max(1, parseInt(args.parallel || "2", 10)),
    concurrency: Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 1,
    saveAllPrompts: !!args["save-all-prompts"],
    fixtures: args.fixtures || FIXTURE_FILE,
    apiKey: e.LLM_API_KEY || null,
  };
}

function publicConfig(opts) {
  const { apiKey, ...rest } = opts;
  return { ...rest, apiKeySet: !!apiKey, hosts: opts.hosts.map((h) => `${h.host}:${h.port}`) };
}

function runFileBase(condition, seed) {
  return `${condition}_seed${seed}`;
}

async function runAll(opts, llmFactory, logFn) {
  const log = logFn || ((m) => process.stderr.write(m + "\n"));
  const fxRaw = loadFixtures(opts.fixtures);
  const fx = prepareFixtures(fxRaw);
  fs.mkdirSync(opts.outDir, { recursive: true });
  if (opts.concurrency > 1) log(`[note] --concurrency=${opts.concurrency}: each line depends on the previous one, so a conversation always runs 1 request at a time; use --parallel for throughput`);
  fs.writeFileSync(path.join(opts.outDir, "config.json"), JSON.stringify({
    ...publicConfig(opts), startedAt: new Date().toISOString(),
    fixturesSha1: sha1(fs.readFileSync(opts.fixtures, "utf8")),
    events: eventTurns(opts.turns).map((e) => ({ id: e.id, turn: e.turn, text: e.text })),
    seedLines: SEED_LINES, contextLines: CONTEXT_LINES, maxChars: MAX_CHARS,
  }, null, 2));
  const jobs = [];
  for (const seed of opts.seeds) for (const condition of opts.conditions) jobs.push({ condition, seed });
  const llm = llmFactory || (() => {
    const pick = makeHostPicker(opts.hosts);
    return (messages, seed) => llmChat(pick(), opts, messages, seed);
  })();
  const summaries = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const base = runFileBase(job.condition, job.seed);
      const file = path.join(opts.outDir, `transcript_${base}.jsonl`);
      const fd = fs.openSync(file, "w");
      const t0 = Date.now();
      log(`[run] ${base} start (${opts.turns} turns)`);
      const res = await runConversation({
        fx, condition: job.condition, seed: job.seed, turns: opts.turns, llm,
        retries: opts.retries, saveAllPrompts: opts.saveAllPrompts,
        write: (rec) => fs.writeSync(fd, JSON.stringify(rec) + "\n"),
      });
      fs.closeSync(fd);
      const prompts = {};
      for (const c of fx.citizens) prompts[c.id] = { name: c.name, ...(res.firstPrompts[c.id] || {}) };
      fs.writeFileSync(path.join(opts.outDir, `system_prompts_${base}.json`), JSON.stringify(prompts, null, 2));
      const s = { ...job, okUtterances: res.okCount, turns: opts.turns, wallMs: Date.now() - t0, transcript: path.basename(file) };
      summaries.push(s);
      log(`[run] ${base} done ok=${res.okCount}/${opts.turns} wall=${s.wallMs}ms`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.parallel, jobs.length) }, worker));
  fs.writeFileSync(path.join(opts.outDir, "runs.json"), JSON.stringify(summaries, null, 2));
  return summaries;
}

// Demo context for --dry-prompts: opening lines + the turn-0 event applied.
function dryPrompts(fx, ids) {
  const run = newRunState(fx);
  const lines = SEED_LINES.map((s) => ({ speakerId: s.speakerId, text: s.text }));
  const ev = eventTurns(DEFAULT_TURNS)[0];
  applyScriptedEvent(fx, run, ev);
  lines.push({ speakerId: NARRATOR_ID, text: ev.text, eventId: ev.id });
  const out = [];
  for (const id of ids) {
    const c = fx.byId[id];
    for (const cond of ["A", "B"]) {
      const b = buildMessages(cond, fx, c, { lines, state: run.state, world: run.world, turn: 0 });
      out.push({ id, name: c.name, condition: cond, system: b.messages[0].content, user: b.messages[1].content });
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args["write-fixtures"]) {
    const file = typeof args["write-fixtures"] === "string" ? args["write-fixtures"] : FIXTURE_FILE;
    fs.writeFileSync(file, JSON.stringify(buildFixtures(), null, 2) + "\n");
    console.log(`wrote ${file}`);
    return;
  }
  if (args["dry-prompts"]) {
    const fx = prepareFixtures(loadFixtures(args.fixtures));
    const ids = typeof args["dry-prompts"] === "string"
      ? args["dry-prompts"].split(",").map(Number) : [8, 1];
    for (const p of dryPrompts(fx, ids)) {
      console.log(`===== ${p.name} (id ${p.id}) condition ${p.condition} =====`);
      console.log("[system]\n" + p.system);
      console.log("[user]\n" + p.user + "\n");
    }
    return;
  }
  const opts = buildOptions(args);
  if (!opts.apiKey) process.stderr.write("[warn] LLM_API_KEY is not set; sending requests without Authorization\n");
  const summaries = await runAll(opts);
  console.log(JSON.stringify({ outDir: opts.outDir, runs: summaries }, null, 2));
}

module.exports = {
  CONTEXT_LINES, MAX_CHARS, DEFAULT_TURNS, NARRATOR_ID, NARRATOR_NAME, FIXTURE_FILE,
  SEED_LINES, EVENT_SCRIPT, EVENT_KEYWORDS, CAST_SPEC, RELATION_SCRIPT,
  hash32, seededRng, llmSeedFor, chars,
  buildFixtures, loadFixtures, prepareFixtures, newRunState, applyScriptedEvent,
  eventTurns, buildSchedule, temperamentWords, profileText, relationText, relationView,
  computeMood, moodText, concernList, thinSystemPrompt, buildSystemPrompt, buildMessages,
  userPrompt, presentSpeakers, cleanReply, mentionsIn, buildLlmRequest, llmChat,
  runConversation, runAll, buildOptions, publicConfig, parseArgs, dryPrompts,
};

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`[fatal] ${e.stack || e.message}\n`);
    process.exit(1);
  });
}
