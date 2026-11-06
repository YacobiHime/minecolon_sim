'use strict';
// ゴール (2B) → 道筋 (プログラム、planner.js) → 行動 (Jev) の3つの層 (help.goalPath。goalplan.js の手順の文の代わり)。
//   考える (2B): ゴールを {kind, target, count?, give?, why, need} で決める。kind は item (物)・person (人)・place (場所)。
//     target は候補 (vocab.js: 物は関係しそうな数十個を日本語名付きで、人、場所) の名前から選ぶ (JSON schema の enum)。
//     呼ぶのは、ゴールが無いとき・済んだとき・詰まったとき・たどれなかったときだけ。
//   道筋 (プログラム): 物のゴールなら毎判断、今の持ち物と見えている物から要る物の連なりを作り直す (planner.js)。
//     人・場所のゴールは「次: Ken の所へ行く」「次: まだ行っていない北の方へ」だけ。
//     Jev の state.plan には planText() の短い文 (ゴール / 道筋 / 次) だけを出す。
//   済んだか: 物を持った・人の近くにいる (渡した)・場所に着いた をプログラムで確かめ (一度確かめたら済んだまま)、
//     さらに元の欲求が下がったか (needDrop / needLow) を見る。needWait 判断待っても下がらなければ、2B に選び直させる。
//   詰まった: 困りごとが troubleTicks 判断続く・道筋の残り (または人・場所までの距離) が patience 判断縮まない → 選び直し (同じゴールでもよい)。
//   たどれない物 (レシピも入手元も分からない) は、その旨を添えて 2B に選び直させる (maxTries 回まで)。
// 研究方針: 仕様・事実は見せるが、どう使うかは書かない。評価語を指示に入れない。数値はここで持ち、モデルには言葉だけ。
const { peopleOf } = require('./people');
const { LLMDecider } = require('./deciders/llm');
const { Planner, pathText, stepText, remaining, GROUND, pathEn, stepTextEn, nextTextEn, FARM_CROPS, effortWord, EFFORT_EN } = require('./planner');
const states = require('./states');
const { dir8 } = require('./vocab');
const { itemCandidates, personCandidates, placeCandidates } = require('./vocab');
const { timeText } = require('./goalplan');
const { NEED_LABEL, LABEL_TO_NEED, NEED_EN } = require('./needs');
const { whereEn } = require('./en');
const { relDir, dist3 } = require('./util');
const promptfit = require('./promptfit');
const farmwater = require('./farmwater');

const DEFAULTS = {
  maxItems: 40,
  maxTries: 2, // 1回の選び直しで、たどれなかったときに 2B に聞き直す回数
  retryAfter: 3,
  maxTokens: 120,
  temperature: 0.5,
  whyMax: 40,
  needDrop: 0.15,
  needLow: 0.3,
  needWait: 12, // 済んだあと、元の欲求が下がるのを待つ判断の数
  troubleTicks: 4,
  patience: 15,
  nearDist: 5,
  arriveDist: 6,
  farDist: 48,
  maxShown: 5,
  version: '1.20.1',
  states: true, // 状態のゴール (kind: state。states.js) を候補に出す
  stateOpts: {}, // states.js の DEFAULTS を上書き (penSize・counts など)
  policyMax: 120, // 方針 (reflect.js) を 2B に見せる長さ
  // ゴール選びのプロンプトの大きさ (2026-11-06。1スロット 4096 で入力 約4000 + 出力 480 があふれた)。
  //   maxPeople: 人の候補 (付き合い・話した回数・近さの順で上位)。maxMemPlaces: 覚えている場所の候補。maxFacts: 知っていること。maxBoardLines: 全体チャットの欄ごとの行
  //   ctxTokens: llama-server の1スロットの文脈 (-c ÷ -np)。budget = ctxTokens − 出力の上限 − margin を超えそうなら steps の順に欄を削る (promptfit.js)
  //   charsPerToken: 文字数 → トークンの見積もりの初期値 (呼び出しの実測で学ぶ)
  prompt: {
    maxPeople: 8, maxMemPlaces: 4, maxFacts: 8, maxBoardLines: 4, ctxTokens: 8192, margin: 256, charsPerToken: 1.6, retryOnOverflow: true,
    steps: [['history', 2], ['board', 2], ['memChars', 300], ['facts', 4], ['peopleText', 2], ['people', 4], ['memPlaces', 2], ['items', 24],
      ['board', 0], ['memChars', 120], ['facts', 2], ['history', 0], ['peopleText', 0], ['policy', 0], ['people', 2], ['items', 16], ['facts', 0], ['memPlaces', 0], ['items', 10]],
  },
  // ゴールの選び方 (サーベイ R1、D2A の形): 2B が案を k 個 → Jev が 案 × 欲求 の noul (1回) → コードが Σ つらさ^power × P の最大を選ぶ。
  //   needs: 今つらい欲求の上位いくつを聞くか。minRatio: しきい値に対する割合がこれ未満の欲求は入れない
  //   tieEps: 最大との差がこれ以内の案は同点 → 2B が先に書いた案。lowP: どの案・欲求の P もこれ未満なら「全部低い」(onAllLow: best | first)
  //   つらい欲求が無いとき (no_pressing_need) は Jev を呼ばず、2B が先に書いた案
  //   later: 先のつらさ (anticipate.js: 夜・この先の食べ物) も 案 × 先の欲求 の noul で同じ呼び出しに足し、点 = Σ いまのつらさ × P + Σ 先のつらさ × P(先に役立つ)。
  //     laterMinRatio: しきい値に対する割合がこれ未満の先のつらさは入れない。laterNeeds: いくつまで
  //   effort: 手間で割る (2026-11-06)。点 = (Σ つらさ × P) ÷ (1 + alpha × 手間)。手間 = planner の手間 (物: effort、状態: planState の effort)、
  //     人・場所: 距離 × perMeter (見えない人は unseenPerson)。alpha: 0 で手間を見ない
  select: { enabled: false, k: 4, needs: 3, minRatio: 0.6, power: 1, tieEps: 0.02, lowP: 0.3, onAllLow: 'best', maxTokens: 480, temperature: 0.7, later: true, laterNeeds: 2, laterMinRatio: 0.5,
    effort: { alpha: 0.04, perMeter: 1 / 16, unseenPerson: 6 } },
};
const KINDS = ['item', 'person', 'place', 'state'];
const WAIT_WHY = 'もう植えてあって、あとは育つのを待つだけ';
const KIND_JA = { item: '物', person: '人', place: '場所', state: '状態' };
const NEED_LABELS = Object.values(NEED_LABEL);
// 先のつらさの英語のキー (Jev の state.later) と、案ごとの質問 (事実を問う形。評価語を入れない)
const LATER_EN = { night: 'night', food: 'food' };
const LATER_Q = {
  night: (p) => `If \`you\` achieved \`proposals.${p}\`, would that help \`you\` when the night that \`later.night\` describes comes?`,
  food: (p) => `If \`you\` achieved \`proposals.${p}\`, would that help \`you\` have food later, given what \`later.food\` describes?`,
};

function parseJson(text) {
  try { const s = String(text); return JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)); } catch (_) { return null; }
}

function goalSchema(cands, { giveItems = [] } = {}) {
  const names = [...new Set([...cands.items, ...cands.people, ...cands.places, ...(cands.states || [])].map((c) => c.name))];
  const props = {
    kind: { type: 'string', enum: KINDS },
    target: { type: 'string', enum: names },
    count: { type: 'integer', minimum: 1, maximum: 64 },
    why: { type: 'string', maxLength: 40 },
    need: { type: 'string', enum: NEED_LABELS },
  };
  if (giveItems.length) props.give = { type: 'string', enum: ['', ...giveItems] };
  return { type: 'object', properties: props, required: ['kind', 'target', 'why', 'need'], additionalProperties: false };
}

// 案を k 個 (R1)。1つの案の形は goalSchema と同じ
function proposalsSchema(cands, k, opts = {}) {
  return { type: 'object', properties: { goals: { type: 'array', items: goalSchema(cands, opts), minItems: k, maxItems: k } }, required: ['goals'], additionalProperties: false };
}

// 案ごとの点 = Σ_欲求 つらさ^power × P(満たされる) ÷ (1 + alpha × 手間)。P[i] = { need: p }。needs = [{ need, distress }]。costs[i] = 手間 (無ければ割らない)
//   同点 (最大との差 ≤ tieEps) は先に書かれた案 (rule: tie_first)。全部の P < lowP なら rule: all_low (onAllLow: first なら最初の案)
function effortFactor(cost, alpha) { return Number.isFinite(cost) && alpha > 0 ? 1 / (1 + alpha * Math.max(0, cost)) : 1; }
function selectScores(P, needs, { power = 1, tieEps = 0.02, lowP = 0.3, onAllLow = 'best', effort = null } = {}, costs = null) {
  const alpha = effort && Number.isFinite(effort.alpha) ? effort.alpha : 0;
  const scores = P.map((row, i) => Math.round(needs.reduce((t, x) => t + Math.pow(x.distress, power) * (row[x.need] || 0), 0) * (costs ? effortFactor(costs[i], alpha) : 1) * 1000) / 1000);
  const allLow = P.every((row) => needs.every((x) => (row[x.need] || 0) < lowP));
  if (allLow && onAllLow === 'first') return { index: 0, scores, rule: 'all_low_first' };
  const best = Math.max(...scores);
  const tied = scores.map((v, i) => [v, i]).filter(([v]) => best - v <= tieEps).map(([, i]) => i);
  const index = tied[0];
  return { index, scores, rule: allLow ? 'all_low_best' : tied.length > 1 ? 'tie_first' : 'max' };
}

// 2B の出力 → { kind, target, count, give, why, need } | null。target の種類から kind を正す
function parseGoal(text, cands, opts = {}) {
  const o = parseJson(text);
  if (!o || typeof o.target !== 'string') return null;
  const t = o.target.trim();
  const inItems = cands.items.find((c) => c.name === t);
  const inPeople = cands.people.find((c) => c.name === t);
  const inPlaces = cands.places.find((c) => c.name === t);
  const inStates = (cands.states || []).find((c) => c.name === t);
  let kind = KINDS.includes(o.kind) ? o.kind : null;
  const fits = { item: !!inItems, person: !!inPeople, place: !!inPlaces, state: !!inStates };
  let kindFixed = false;
  if (!kind || !fits[kind]) {
    const k = KINDS.find((x) => fits[x]) || (opts.allowUnknownItem && /^[a-z0-9_]+$/.test(t) ? 'item' : null);
    if (!k) return null;
    kindFixed = !!kind; kind = k;
  }
  const lab = typeof o.need === 'string' ? o.need.trim() : '';
  const need = LABEL_TO_NEED[lab] || (NEED_LABEL[lab] ? lab : null);
  const count = kind === 'item' ? Math.max(1, Math.min(64, Math.floor(Number(o.count)) || 1))
    : kind === 'state' ? (inStates.state.type === 'walled' ? 1 : Math.max(1, Math.min(64, Math.floor(Number(o.count)) || inStates.count || 1))) : null;
  const give = kind === 'person' && typeof o.give === 'string' && o.give.trim() ? o.give.trim() : null;
  const why = typeof o.why === 'string' ? o.why.trim().slice(0, opts.whyMax ?? DEFAULTS.whyMax) : '';
  return { kind, target: t, count, give, why: why || null, need, kindFixed, place: inPlaces || null, state: inStates ? inStates.state : null };
}

function goalText(g) {
  if (!g) return '';
  if (g.kind === 'item') return `${g.target} ${g.count}`;
  if (g.kind === 'state') return states.stateGoalText(g.state || states.parseStateId(g.target) || {}, g.count);
  if (g.kind === 'person') return g.give ? `${g.target} に ${g.give} を渡す` : `${g.target} の近くにいる`;
  if (g.place && g.place.type === 'later') return laterText(g.target);
  return `${g.target}へ行く`;
}
// あとでやることの候補の名前「小麦を取りに行く@M2」→「小麦を取りに行く (M2)」
function laterText(name) { const i = String(name).lastIndexOf('@'); return i > 0 ? `${name.slice(0, i)} (${name.slice(i + 1)})` : String(name); }

function candDesc(cands, name) {
  const c = [...cands.items, ...cands.people, ...cands.places, ...(cands.states || [])].find((x) => x.name === name);
  return c ? c.desc : null;
}

// 状態の道筋の文: 物の手順 (stepText) と行動の手順 (actText) を maxShown まで + 次
function statePathText(p, { maxShown = 5 } = {}) {
  if (!p || !p.ok) return '';
  if (p.done) return '道筋: 揃っている';
  const st = p.status && p.status.known ? `今${p.status.have} / ` : '';
  const shown = p.steps.slice(-maxShown).map((s) => (s.act ? states.actText(s) : stepText(s)));
  const more = p.steps.length > maxShown ? `ほか${p.steps.length - maxShown}、` : '';
  const nx = p.next ? (p.next.act ? states.actText(p.next) : stepText(p.next).split(' ← ')[0] + ' を手に入れる') : '';
  return `${st}道筋: ${more}${shown.join('、')} / 次: ${nx}`;
}

// 英語 (Jev 用。同じゴールから)
function placeEn(g) {
  const pl = g.place || {};
  if (pl.type === 'dir') return `far to the ${pl.dir}`;
  if (pl.type === 'base' || g.target === '拠点') return 'the base';
  if (pl.type === 'later' && pl.descEn) return pl.descEn.replace(/^go (get|take|to) /, '');
  return `${g.target}${pl.desc ? ` (${String(pl.desc).split(' ')[0] === '拠点' ? 'base' : String(pl.desc).split(' ')[0]})` : ''}`;
}
function goalTextEn(g) {
  if (!g) return '';
  if (g.kind === 'item') return `obtain ${g.target} x${g.count}`;
  if (g.kind === 'state') return states.stateGoalTextEn(g.state || states.parseStateId(g.target) || {}, g.count);
  if (g.kind === 'person') return g.give ? `give ${g.give} to ${g.target}` : `be near ${g.target}`;
  return `go to ${placeEn(g)}`;
}
function statePathEn(p, { maxShown = 5 } = {}) {
  if (!p || !p.ok) return null;
  if (p.done) return { path: 'everything is in place', next: null };
  const shown = p.steps.slice(-maxShown).map((x) => (x.act ? states.actTextEn(x) : stepTextEn(x)));
  if (p.steps.length > maxShown) shown.unshift(`${p.steps.length - maxShown} more before these`);
  const nx = p.next ? (p.next.act ? states.actTextEn(p.next) : nextTextEn(p.next)) : null;
  const o = { path: shown, next: nx };
  if (p.status && p.status.known) o.now = `${p.status.have} now`;
  return o;
}

// 人の候補の並べ方 (上位 maxPeople 人に絞る前): 話した回数・助け合った回数・好き嫌いの強さ・近さ。同点は元の順
function rankPeople(people) {
  const score = (p) => (p.talks || 0) + 2 * (p.helped || 0) + (p.affinity != null ? Math.abs(p.affinity - 50) / 10 : 0) + (p.d != null ? 3 / (1 + p.d / 8) : 0);
  return people.map((p, i) => ({ p, i, s: score(p) })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.p);
}

// 道筋の次が「育つのを待つ」だけ (畑の段で、耕す・植えるが残っておらず、植わっている作物がある)
function waitOnly(p) {
  const n = p && p.ok ? p.next : null;
  return !!(n && n.how === 'farm' && !(n.till > 0) && !(n.plants > 0) && n.growing > 0);
}

function invCount(raw, name) { return (raw.inventory || []).filter((i) => i.name === name).reduce((t, i) => t + i.count, 0); }

class GoalPath {
  constructor(opts = {}) {
    this.cfg = { ...DEFAULTS, ...(opts.cfg || {}) };
    this.cfg.select = { ...DEFAULTS.select, ...((opts.cfg && opts.cfg.select) || {}) };
    this.cfg.prompt = { ...DEFAULTS.prompt, ...((opts.cfg && opts.cfg.prompt) || {}) };
    this.ratio = new promptfit.TokenRatio({ initial: this.cfg.prompt.charsPerToken });
    this.jev = opts.jev || null; // JevDecider (call(state, questions, stage) を使う)。select.enabled のときに要る
    this.order = opts.order || null; // Order (order.js)。候補の並べ方を毎回変える
    this.llm = opts.llm || new LLMDecider({ ...(opts.llmOpts || {}), mode: 'talk', maxTokens: this.cfg.maxTokens, temperature: this.cfg.temperature });
    // 文脈の上限 (promptfit) は提供元の ctxTokens (llm_provider.js)。local は goalPath.prompt.ctxTokens (llama-server の1スロット) があればそれ
    const userCtx = opts.cfg && opts.cfg.prompt && opts.cfg.prompt.ctxTokens;
    const prov = this.llm.provider || 'local';
    if (this.llm.ctxTokens && (prov !== 'local' || !userCtx)) this.cfg.prompt.ctxTokens = this.llm.ctxTokens;
    this.meter = opts.meter || null;
    this.log = opts.log || (() => {});
    this.goal = null;
    this.path = null; // 今の道筋 (planner の返り値)
    this.history = []; // [{ kind, target, count, why, need, result, reason, from, to }]
    this.troubleRun = 0;
    this.retryAt = -1;
    this.counts = { goals: 0, done: 0, needUnmet: 0, stuck: 0, unplannable: 0, failed: 0, worstJudged: 0, worstMatched: 0 };
    this.loggedPrompt = false;
    this.lastNextKey = null;
  }

  // ---- 2B ----
  candidates(ctx) {
    const raw = ctx.raw;
    const c = this.rawCandidates(ctx);
    this.lastItemNames = c.items.map((x) => x.name); // 提案 (propose) の物の候補にも使う
    this.lastItemEffort = Object.fromEntries(c.items.filter((x) => x.effort).map((x) => [x.name, x.effort])); // 提案の物の名前に添える手間
    // R2: もう満たされている候補。場所: もう着いている所は外す。人: もう近くにいる人は「もう近くにいる」を付ける (渡すゴールはありうる)
    //   物・状態: 「もう持っている n」「もう n ある」を事実として付ける (vocab / states)。2B が選んだ数で満たされていれば goalpath が外す
    if (raw) {
      const here = raw.self.pos;
      c.places = c.places.filter((pl) => !(pl.pos && pl.type !== 'dir' && dist3(here, pl.pos) <= this.cfg.arriveDist));
      for (const pc of c.people) {
        const e = peopleOf(raw).find((x) => x.name === pc.name);
        if (e && e.d <= this.cfg.nearDist) { pc.near = true; pc.desc = `${pc.desc}・もう近くにいる`; pc.descEn = `${pc.descEn || ''}; already near`; }
      }
    }
    return c;
  }

  rawCandidates(ctx) {
    const raw = ctx.raw;
    const bd = ctx.board || null; // 共有のチェスト・取り決め・共同の目標 (board.js。agent が渡す)
    return {
      items: itemCandidates({ raw, facts: ctx.allFacts || [], placeKinds: ctx.placeKinds || [], history: this.history, version: this.cfg.version, maxItems: this.cfg.maxItems, world: raw ? this.world(ctx) : null, annotate: this.cfg.annotate !== false }),
      people: personCandidates(rankPeople(ctx.people || []).slice(0, this.cfg.prompt.maxPeople)),
      // あとでやることのうち見込みの時刻を過ぎたもの (prospect.js の goalCandidates。type: later) を場所の候補の先に足す。取りに行くかは 2B が選ぶ
      places: [...(ctx.laterPlaces || []), ...placeCandidates({ here: raw && raw.self.pos, base: ctx.base || null, baseLabel: ctx.baseLabel || null, places: ctx.places || [], cellAt: ctx.cellAt || null, far: this.cfg.farDist, maxPlaces: this.cfg.prompt.maxMemPlaces, origin: ctx.origin || null })],
      states: this.cfg.states && raw ? states.stateCandidates({ world: this.world(ctx), sense: this.senseOf(ctx), raw, cfg: this.cfg.stateOpts, version: this.cfg.version, dir: (pos) => dir8(raw.self.pos, pos), shared: bd ? bd.shared || [] : [] }) : [],
    };
  }

  // 状態を確かめる材料 (states.senseState)。拠点 = set_base の場所、なければベッド/チェストを置いた所 (ctx.home)
  senseOf(ctx) {
    const raw = ctx.raw;
    return { blockAt: ctx.blockAt || null, here: raw ? raw.self.pos : null, anchor: ctx.base || ctx.home || null, entities: raw ? raw.entities : [], containers: ctx.containers || {}, near: this.cfg.nearBase ?? 16,
      shared: ctx.board ? ctx.board.chests || [] : [] };
  }

  historyText(n = 5) {
    if (!this.history.length) return 'まだない';
    return this.history.slice(-n).map((h) => `${goalText(h)}${h.why ? ` (何のため: ${h.why})` : ''}: ${h.resultText}`).join('\n');
  }

  // 候補の一覧を並べ替える (R5)。記録は this.lastOrder
  shuffled(cands) {
    if (!this.order) { this.lastOrder = null; return cands; }
    const out = { ...cands };
    const recs = {};
    for (const k of ['items', 'states', 'people', 'places']) {
      if (!cands[k] || !cands[k].length) continue;
      const r = this.order.shuffle(cands[k], `goal_${k}`);
      out[k] = r.arr; recs[k] = r.rec.n;
    }
    this.lastOrder = { seed: this.order.seed, n: recs, shuffled: this.order.enabled };
    return out;
  }

  // プロンプトを作る。文脈に収まらなければ欄を削る (promptfit)。返り値 { messages, cands (見せた候補。schema もこれで作る), fit }
  //   budgetCut: 前の呼び出しがあふれたとき、予算から引くトークン
  buildPrompt(ctx, candsIn, feedback = [], { k = 1, maxTokens = this.cfg.maxTokens, budgetCut = 0 } = {}) {
    const pc = this.cfg.prompt;
    const rankOf = (arr) => (arr || []).map((c, i) => ({ ...c, _rank: i }));
    const shuffled = this.shuffled({ ...candsIn, items: rankOf(candsIn.items), people: rankOf(candsIn.people), places: rankOf(candsIn.places), states: rankOf(candsIn.states) });
    const facts = ctx.facts ? ctx.facts('') : [];
    const lim = { items: Infinity, people: Infinity, memPlaces: Infinity, facts: pc.maxFacts, board: pc.maxBoardLines, memChars: Infinity, history: 5, peopleText: Infinity, policy: 1 };
    let shown = null;
    const build = (L) => {
      let memSeen = 0;
      const cands = {
        ...shuffled,
        items: shuffled.items.filter((c) => c._rank < L.items),
        people: shuffled.people.filter((c) => c._rank < L.people),
        places: shuffled.places.filter((c) => c.type !== 'memory' || (memSeen++ < L.memPlaces)),
      };
      shown = cands;
      return this.messagesWith(ctx, cands, feedback, { k, facts: facts.slice(0, L.facts), lim: L });
    };
    const budget = pc.ctxTokens - maxTokens - pc.margin - budgetCut;
    const r = promptfit.fit(build, { lim, steps: pc.steps, budget, ratio: this.ratio });
    const m = build(r.lim); // shown を最後の lim に合わせる
    const sections = {};
    for (const line of m[1].content.split('\n## ')) { const h = line.split('\n')[0].replace(/^## /, ''); if (h.length < 20) sections[h] = line.length; }
    return { messages: m, cands: shown, fit: { est: r.est, budget, applied: r.applied, over: r.over, ratio: Math.round(this.ratio.value * 1000) / 1000, sections } };
  }

  messagesWith(ctx, cands, feedback = [], { k = 1, facts = [], lim = {} } = {}) {
    const p = ctx.persona || {};
    const self = ctx.raw && ctx.raw.self;
    const L = { board: Infinity, memChars: Infinity, history: 5, peopleText: Infinity, policy: 1, ...lim };
    const board = ctx.board && ctx.board.text ? (L.board === Infinity ? ctx.board.text : promptfit.capSectionLines(ctx.board.text, L.board)) : '';
    const mem = L.memChars === Infinity ? ctx.memText : promptfit.capLineChars(ctx.memText, L.memChars);
    const peopleText = ctx.peopleText && L.peopleText > 0 ? (L.peopleText === Infinity ? ctx.peopleText : ctx.peopleText.split('\n').slice(0, L.peopleText).join('\n')) : '';
    const inv = ((ctx.raw && ctx.raw.inventory) || []).map((i) => i.name);
    const sys = [
      `あなたは Minecraft の世界にいる「${p.name}」。${p.personality || ''}`,
      ctx.goalText ? `全体の目標: ${ctx.goalText}` : '',
      'あなたが知っているのは、自分で見たこと・やったこと・聞いたことと、「知っていること」だけ。',
      `自分がこれからめざすゴールを1つ決める。ゴールは、手に入れたい物 (kind: item)・近くに行きたい人 (kind: person)・行きたい場所 (kind: place)${cands.states && cands.states.length ? '・こうなっていてほしい状態 (kind: state)' : ''} のどれか1つ。`,
      `target は「めざせる物」「人」「場所」${cands.states && cands.states.length ? '「めざせる状態」' : ''}の一覧にある名前を、そのまま1つ書く。物${cands.states && cands.states.length ? '・状態' : ''}なら count に数を書く。`
        + (inv.length ? '人に持ち物を渡したいときは give にその物の名前を書く。' : ''),
      `why にはそのゴールが何のためか、need にはそのゴールで満たしたいもの (${NEED_LABELS.join('・')}) を1つ書く。`,
      k > 1 ? `ゴールの案を${k}個出す (同じ案は書かない)。JSON {"goals":[{"kind":"...","target":"...","count":1,"why":"...","need":"..."}, ...]} だけを出力する。`
        : `JSON {"kind":"...","target":"...","count":1,"why":"...","need":"..."} だけを出力する。`,
    ];
    const user = [
      '## 今の様子', ctx.obsText,
      self ? timeText(self.timeOfDay, self.day) : '',
      ctx.baseText ? `## 拠点の様子\n${ctx.baseText}` : '',
      ctx.socialText ? `## 体と心\n${ctx.socialText}` : '',
      ctx.worst ? `## いちばんつらいこと\n${ctx.worst.text}` : '',
      ctx.policy && L.policy ? `## 自分の方針 (前に自分で決めたこと)\n${String(ctx.policy).slice(0, this.cfg.policyMax)}` : '',
      (ctx.troubles || []).some((t) => t.kind === 'stuck') ? `## 困っていること\n${ctx.troubles.filter((t) => t.kind === 'stuck').map((t) => `${t.about} (${t.lastMsg})`).join('\n')}` : '',
      peopleText ? `## 周りの人\n${peopleText}` : '',
      board || '', // 全体に届いた話・取り決め・共同の目標・共有のチェスト (board.js)
      facts.length ? `## 知っていること\n${facts.join('\n')}` : '',
      '## 覚えていること', mem || 'なし',
      L.history > 0 ? `## これまでのゴール\n${this.historyText(L.history)}` : '',
      `## めざせる物\n${cands.items.map((c) => `${c.name}: ${c.desc}`).join('\n')}`,
      cands.states && cands.states.length ? `## めざせる状態\n${cands.states.map((c) => `${c.name}: ${c.desc}`).join('\n')}` : '',
      cands.people.length ? `## 人\n${cands.people.map((c) => `${c.name}: ${c.desc}`).join('\n')}` : '',
      `## 場所\n${cands.places.map((c) => `${c.name}: ${c.desc}`).join('\n')}`,
      feedback.length ? `## さっき選んだゴール\n${feedback.join('\n')}` : '',
      k > 1 ? `ゴールの案を${k}個、JSON で。` : 'ゴールを JSON で。',
    ];
    return [{ role: 'system', content: sys.filter(Boolean).join('\n') }, { role: 'user', content: user.filter(Boolean).join('\n') }];
  }

  async ask2B(messages, schema, opts = undefined) {
    const promptChars = messages.reduce((s, m) => s + m.content.length, 0);
    const t0 = Date.now();
    let r = null; let error = null;
    try { r = await (opts ? this.llm.complete(messages, schema, opts) : this.llm.complete(messages, schema)); } catch (e) { error = e.message; }
    const ov = error ? promptfit.overflowTokens(error) : null;
    const rec = { promptChars, promptTokens: r ? r.promptTokens : ov ? ov.request : null, completionTokens: r ? r.completionTokens : null, ms: Date.now() - t0, error, rawOutput: r ? r.text : null,
      finishReason: r ? r.finishReason || null : null, truncated: !!(r && r.finishReason === 'length'), overflow: !!ov };
    if (rec.promptTokens) this.ratio.observe(promptChars, rec.promptTokens);
    if (!this.loggedPrompt) { rec.prompt = messages; this.loggedPrompt = true; }
    return rec;
  }

  // buildPrompt → 2B。あふれた (exceed_context) ら、あふれた分だけ予算を減らして1回作り直す。返り値 { rec, cands }
  async askFit(ctx, candsIn, feedback, { k = 1, maxTokens = this.cfg.maxTokens, temperature, schemaOf, giveItems = [] }) {
    let cut = 0; let out = null;
    for (let i = 0; i < (this.cfg.prompt.retryOnOverflow ? 2 : 1); i++) {
      const bp = this.buildPrompt(ctx, candsIn, feedback, { k, maxTokens, budgetCut: cut });
      const schema = schemaOf(bp.cands, { giveItems });
      const opts = k > 1 || temperature != null ? { maxTokens, temperature } : undefined;
      const rec = await this.ask2B(bp.messages, schema, opts);
      rec.fit = { ...bp.fit, try: i };
      rec.promptEst = bp.fit.est;
      out = { rec, cands: bp.cands };
      if (!rec.overflow) break;
      this.addMeter(rec, false);
      this.log({ kind: 'prompt_overflow', ok: false, promptTokens: rec.promptTokens, promptChars: rec.promptChars, fit: rec.fit, error: rec.error });
      const ov = promptfit.overflowTokens(rec.error);
      cut += Math.max(64, ov.request + maxTokens - ov.ctx + 64);
    }
    return out;
  }

  addMeter(rec, ok) {
    if (this.meter) this.meter.addTwoB({ kind: 'goal_path', promptChars: rec.promptChars, promptTokens: rec.promptTokens, completionTokens: rec.completionTokens, ms: rec.ms, error: rec.error || (ok ? null : 'parse'),
      truncated: !!rec.truncated, overflow: !!rec.overflow, trimmed: !!(rec.fit && rec.fit.applied && rec.fit.applied.length) });
  }

  // ---- 道筋 ----
  // 近くの畑 (planner の world.farm)。blockAt があればブロックを数え、無ければ見えている作物の ripe から。1つの ctx で1回
  farmOf(ctx) {
    if (ctx._farm) return ctx._farm;
    const raw = ctx.raw;
    let f = null;
    if (ctx.blockAt && raw && raw.self) {
      f = states.farmStatus(ctx.blockAt, raw.self.pos, { radius: (this.cfg.stateOpts && this.cfg.stateOpts.farmRadius) || states.DEFAULTS.farmRadius });
      try { const ts = farmwater.tillSpots(ctx.blockAt, raw.self.pos); f.till = ts.spots; f.tillCount = ts.count; } catch (_) { /* 数えない */ }
    }
    else {
      f = { empty: 0, growing: {}, ripe: {} };
      for (const b of (raw && raw.blocks) || []) {
        if (!FARM_CROPS.test(b.name) || b.ripe == null) continue;
        f.ripe[b.name] = b.ripe; f.growing[b.name] = Math.max(0, (b.seen || 0) - b.ripe);
      }
    }
    ctx._farm = f;
    return f;
  }

  waterOf(ctx) {
    const raw = ctx.raw;
    const f = this.farmOf(ctx);
    let ready;
    if (f && Array.isArray(f.till)) ready = f.till.length > 0;
    else if (ctx.blockAt && raw && raw.self) { try { ready = farmwater.tillSpots(ctx.blockAt, raw.self.pos).spots.length > 0; } catch (_) { ready = undefined; } }
    return farmwater.waterInfo(raw && raw.self ? raw.self.pos : null, { raw, places: ctx.places || [], ready });
  }

  // 道筋の次が「作物が育つのを待つ」(畑の段で、耕す・植えるが残っておらず、植わっている作物がある)
  waitingGrowth() { return waitOnly(this.path); }

  world(ctx) {
    const raw = ctx.raw;
    const kinds = new Set(ctx.placeKinds || []);
    return {
      farm: this.farmOf(ctx),
      // 耕す前の水の段 (見えている・覚えている M 番号と距離・知らない)。済んだ = 水から4マス以内で高さの合う耕せるマスが近くにある
      water: this.waterOf(ctx),
      // 植えた作物の覚えている場所 (道筋の「育つのを待つ (植わっている n、M2)」)
      cropPlaces: Object.fromEntries((ctx.places || []).filter((p) => FARM_CROPS.test(p.kind)).sort((a, b) => (a.d ?? 0) - (b.d ?? 0)).reverse().map((p) => [p.kind, { id: p.id, d: p.d }])),
      inventory: raw.inventory,
      visibleBlocks: raw.blocks.map((b) => b.name),
      visibleMobs: raw.entities.filter((e) => e.kind !== 'item' && e.kind !== 'player').map((e) => e.name),
      knownBlocks: [...kinds],
      stations: { crafting_table: !!raw.tableNearby || kinds.has('crafting_table'), furnace: raw.blocks.some((b) => b.name === 'furnace') || kinds.has('furnace') },
      excludeBlocks: GROUND,
      sharedChests: ctx.board ? ctx.board.chests || [] : [],
    };
  }

  planItem(ctx, target, count) {
    return new Planner(this.world(ctx), { version: this.cfg.version }).plan(target, count);
  }

  // 状態の道筋 (今の様子から作り直す)
  planStateGoal(ctx, g) {
    const st = g.state || states.parseStateId(g.target);
    const status = states.senseState(st, this.senseOf(ctx), { ...states.DEFAULTS, ...this.cfg.stateOpts });
    if (status.known) g.lastStatus = status; else if (g.lastStatus) Object.assign(status, { have: g.lastStatus.have, penCells: g.lastStatus.penCells, chests: g.lastStatus.chests });
    const p = states.planState(st, g.count, this.world(ctx), status, { version: this.cfg.version, cfg: this.cfg.stateOpts });
    return { ...p, status };
  }

  // 人・場所の今の様子 { met, d (距離), text (次の文) }
  targetStatus(ctx) {
    const g = this.goal;
    const raw = ctx.raw;
    const here = raw.self.pos;
    if (g.kind === 'item') {
      const have = invCount(raw, g.target);
      return { met: have >= g.count, d: remaining(this.path) };
    }
    if (g.kind === 'state') {
      const p = this.path;
      const st = p ? p.status : { have: 0, known: false };
      const met = !!(st && st.known && st.have >= (g.count || 1));
      const d = p && p.ok ? p.steps.length * 100 + (p.left || 0) : 1e6;
      return { met, d, have: st ? st.have : 0, known: !!(st && st.known) };
    }
    if (g.kind === 'person') {
      const e = peopleOf(raw).find((x) => x.name === g.target);
      const near = !!e && e.d <= this.cfg.nearDist;
      const gave = !!(ctx.gave || []).find((x) => x.to === g.target && (!g.give || x.item === g.give));
      const met = g.give ? gave : near;
      const where = e ? relDir(here, e.pos) : '今は見えない';
      const text = g.give && near ? `${g.target} に ${g.give} を渡す` : `${g.target} の所へ行く (${where})`;
      const textEn = g.give && near ? `give ${g.give} to ${g.target}` : `go to ${g.target} (${e ? whereEn(here, e.pos) : 'not visible now'})`;
      return { met, d: e ? e.d : 1e6, text, textEn };
    }
    const pl = g.place;
    if (pl.type === 'dir') {
      const start = g.startPos;
      const along = (here.x - start.x) * pl.vec[0] + (here.z - start.z) * pl.vec[1];
      const left = Math.max(0, Math.round(this.cfg.farDist - along));
      return { met: left <= this.cfg.farDist * 0.2, d: left, text: `${g.target}へ (あと${left}mほど)`, textEn: `keep going ${pl.dir} (${left < 15 ? 'almost there' : left < 30 ? 'about halfway' : 'a long way left'})` };
    }
    const pos = g.pos || pl.pos;
    const d = pos ? dist3(here, pos) : 1e6;
    return { met: d <= this.cfg.arriveDist, d, text: `${pl.type === 'later' ? laterText(g.target) : `${g.target}へ行く`} (${pos ? relDir(here, pos) : '場所が分からない'})`, textEn: `go to ${placeEn(g)} (${pos ? whereEn(here, pos) : 'location unknown'})` };
  }

  // R2: その案は今すでに満たされているか (選んですぐ「手に入れた/着いた」にならないように)。{ met, why (2B への事実), whyEn }
  satisfiedNow(ctx, pg) {
    const raw = ctx.raw;
    if (!raw) return { met: false };
    if (pg.kind === 'item') {
      const have = invCount(raw, pg.target);
      return have >= pg.count ? { met: true, why: `もう持っている (${have})`, have } : { met: false, have };
    }
    if (pg.kind === 'state') {
      const st = pg.state || states.parseStateId(pg.target);
      const status = states.senseState(st, this.senseOf(ctx), { ...states.DEFAULTS, ...this.cfg.stateOpts });
      return status.known && status.have >= (pg.count || 1) ? { met: true, why: `もうそうなっている (今${status.have})`, have: status.have } : { met: false };
    }
    if (pg.kind === 'person') {
      if (pg.give) return { met: false };
      const e = peopleOf(raw).find((x) => x.name === pg.target);
      return e && e.d <= this.cfg.nearDist ? { met: true, why: 'もう近くにいる' } : { met: false };
    }
    const pl = pg.place;
    if (pl && pl.type !== 'dir' && pl.pos && dist3(raw.self.pos, pl.pos) <= this.cfg.arriveDist) return { met: true, why: 'もう着いている' };
    return { met: false };
  }

  // Jev の state.plan (英語のオブジェクト): { goal, for_need, why (2B の原文), path, next, status }
  planEn() {
    const g = this.goal;
    if (!g) return null;
    const o = { goal: goalTextEn(g) };
    if (g.need) o.for_need = NEED_EN[g.need] || g.need;
    if (g.why) o.why = g.why;
    if (g.metAt != null) { o.status = g.kind === 'item' ? 'obtained' : g.kind === 'state' ? 'done' : g.kind === 'person' ? (g.give ? 'given' : 'near them now') : 'arrived'; return o; }
    if (g.kind === 'item' || g.kind === 'state') {
      const pe = this.path && this.path.ok ? (g.kind === 'item' ? pathEn(this.path, { maxShown: this.cfg.maxShown }) : statePathEn(this.path, { maxShown: this.cfg.maxShown })) : null;
      if (pe) Object.assign(o, pe);
      if (o.next == null) delete o.next;
      return o;
    }
    if (g.statusTextEn) o.next = g.statusTextEn;
    return o;
  }

  // 道筋の次の一手 (物・状態のゴールで、まだ済んでいないとき)。Jev の記録 (next_now・pathMatch) に使う
  pathNext() {
    const g = this.goal;
    if (!g || g.metAt != null || !(g.kind === 'item' || g.kind === 'state') || !this.path || !this.path.ok) return null;
    return this.path.next || null;
  }

  planText() {
    const g = this.goal;
    if (!g) return '';
    const head = `ゴール: ${goalText(g)}${g.why ? ` (${g.why})` : ''}`;
    if (g.metAt != null) return `${head} / ${g.kind === 'item' ? '手に入れた' : g.kind === 'state' ? 'そうなった' : g.kind === 'person' ? (g.give ? '渡した' : '近くにいる') : '着いた'}`;
    if (g.kind === 'item') return this.path && this.path.ok ? `${head} / ${pathText(this.path, { maxShown: this.cfg.maxShown })}` : head;
    if (g.kind === 'state') return this.path && this.path.ok ? `${head} / ${statePathText(this.path, { maxShown: this.cfg.maxShown })}` : head;
    return g.statusText ? `${head} / 次: ${g.statusText}` : head;
  }

  // ---- ゴールを決める ----
  async newGoal(ctx, tick, reason = 'start') {
    if (this.cfg.select.enabled && this.jev && (this.cfg.select.k || 1) > 1) return this.newGoalSelect(ctx, tick, reason);
    const allCands = this.candidates(ctx);
    const feedback = [];
    const giveItems = [...new Set(((ctx.raw && ctx.raw.inventory) || []).map((i) => i.name))];
    for (let tryN = 0; tryN < this.cfg.maxTries; tryN++) {
      const { rec, cands } = await this.askFit(ctx, allCands, feedback, { schemaOf: goalSchema, giveItems });
      const pg = rec.rawOutput ? parseGoal(rec.rawOutput, cands, { whyMax: this.cfg.whyMax }) : null;
      this.addMeter(rec, !!pg);
      const needAt = pg && pg.need && ctx.needNow ? Math.round(ctx.needNow(pg.need) * 1000) / 1000 : null;
      const base = { tick, reason, try: tryN, goalKind: pg ? pg.kind : null, target: pg ? pg.target : null, count: pg ? pg.count : null, give: pg ? pg.give : null,
        why: pg ? pg.why : null, need: pg ? pg.need : null, needAt, kindFixed: pg ? pg.kindFixed : null, worst: ctx.worst ? ctx.worst.need : null, worstText: ctx.worst ? ctx.worst.text : null,
        needMatchesWorst: pg && pg.need && ctx.worst ? pg.need === ctx.worst.need : null, policy: ctx.policy || null, desc: pg ? candDesc(cands, pg.target) : null,
        candidates: { items: cands.items.length, people: cands.people.length, places: cands.places.length, states: (cands.states || []).length }, ...rec };
      if (!pg) { this.counts.failed += 1; this.log({ kind: 'goal', ok: false, ...base }); this.retryAt = tick + this.cfg.retryAfter; return false; }
      if (this.lastOrder) base.order = this.lastOrder;
      // R2: もう満たされている案は外して聞き直す
      const sat = this.satisfiedNow(ctx, pg);
      if (sat.met) {
        this.counts.satisfied = (this.counts.satisfied || 0) + 1;
        this.log({ kind: 'satisfied', ok: false, ...base, why: sat.why });
        feedback.push(`${goalText(pg)}: ${sat.why}`);
        continue;
      }
      let path = null;
      if (pg.kind === 'state') {
        path = this.planStateGoal(ctx, { ...pg });
        if (!path.ok) {
          this.counts.unplannable += 1;
          this.log({ kind: 'unplannable', ok: false, ...base, missing: path.missing || null });
          this.history.push({ ...pg, result: 'unplannable', resultText: `${path.missing || ''} の手に入れ方が分からなかった`, from: tick, to: tick });
          feedback.push(`${goalText(pg)}: ${path.missing || ''} の手に入れ方が分からなかった`);
          continue;
        }
      }
      if (pg.kind === 'item') {
        path = this.planItem(ctx, pg.target, pg.count);
        if (!path.ok) {
          this.counts.unplannable += 1;
          this.log({ kind: 'unplannable', ok: false, ...base, missing: path.missing || null });
          this.history.push({ ...pg, result: 'unplannable', resultText: '作り方も手に入れ方も分からなかった', from: tick, to: tick });
          feedback.push(`${goalText(pg)}: ${path.missing && path.missing !== pg.target ? `${path.missing} の` : ''}作り方も手に入れ方も分からなかった`);
          continue;
        }
        // もう植えてあって、あとは育つのを待つだけ → 外して聞き直す (待つ間は別のゴール)
        if (waitOnly(path)) {
          this.counts.waiting = (this.counts.waiting || 0) + 1;
          this.log({ kind: 'waiting', ok: false, ...base, why: WAIT_WHY });
          feedback.push(`${goalText(pg)}: ${WAIT_WHY}`);
          continue;
        }
      }
      return this.accept(ctx, tick, pg, path, { ...base, needAt });
    }
    this.retryAt = tick + this.cfg.retryAfter;
    return false;
  }

  // 案を1つ確かめる: 満たされている (satisfied)・たどれない (unplannable) なら { ok: false, why }、よければ { ok: true, path }
  checkProposal(ctx, pg) {
    const sat = this.satisfiedNow(ctx, pg);
    if (sat.met) return { ok: false, result: 'satisfied', why: sat.why };
    if (pg.kind === 'state') {
      const path = this.planStateGoal(ctx, { ...pg });
      if (!path.ok) return { ok: false, result: 'unplannable', why: `${path.missing || ''} の手に入れ方が分からなかった`, missing: path.missing || null };
      return { ok: true, path, cost: path.effort };
    }
    if (pg.kind === 'item') {
      const planner = new Planner(this.world(ctx), { version: this.cfg.version });
      const path = planner.plan(pg.target, pg.count);
      if (!path.ok) return { ok: false, result: 'unplannable', why: `${path.missing && path.missing !== pg.target ? `${path.missing} の` : ''}作り方も手に入れ方も分からなかった`, missing: path.missing || null };
      if (waitOnly(path)) return { ok: false, result: 'waiting', why: WAIT_WHY };
      return { ok: true, path, cost: planner.effort([{ item: path.target, count: pg.count }]) };
    }
    return { ok: true, path: null, cost: this.moveCost(ctx, pg) };
  }

  // 人・場所の手間: 距離 × perMeter (見えない人は unseenPerson)
  moveCost(ctx, pg) {
    const ef = this.cfg.select.effort || {};
    const per = ef.perMeter ?? 1 / 16;
    const raw = ctx.raw;
    if (!raw) return null;
    if (pg.kind === 'person') {
      const e = peopleOf(raw).find((x) => x.name === pg.target);
      return e ? e.d * per : (ef.unseenPerson ?? 6);
    }
    const pl = pg.place || {};
    if (pl.type === 'dir') return this.cfg.farDist * per;
    return pl.pos ? dist3(raw.self.pos, pl.pos) * per : null;
  }

  // ゴールを決めたことにする (newGoal と newGoalSelect で同じ)
  accept(ctx, tick, pg, path, base) {
    this.counts.goals += 1;
    if (base.worst && pg.need) { this.counts.worstJudged += 1; if (base.worst === pg.need) this.counts.worstMatched += 1; }
    const here = ctx.raw.self.pos;
    this.goal = { ...pg, lastStatus: path && path.status && path.status.known ? path.status : null, needAt: base.needAt, setAt: tick, n: this.counts.goals, startPos: { x: here.x, y: here.y, z: here.z }, pos: pg.place ? pg.place.pos || null : null, metAt: null, best: Infinity, bestAt: tick };
    this.path = path;
    this.troubleRun = 0;
    // あとでやること (prospect.js) の候補を選んだ: どれか (summarize_run の「見込みの時刻のあと取りに行った」)
    const later = pg.place && pg.place.type === 'later' ? { id: pg.place.laterId, kind: pg.place.laterKind } : null;
    this.log({ kind: 'goal', ok: true, ...base, ...(later ? { later } : {}), path: path ? this.pathRecord(path) : null });
    return true;
  }

  // R1 (D2A の形): 2B が案を k 個 → 満たされている・たどれない案を外す → Jev が 案 × 欲求 の noul → コードで点の最大を選ぶ
  async newGoalSelect(ctx, tick, reason) {
    const sc = this.cfg.select;
    const k = sc.k;
    const allCands = this.candidates(ctx);
    const feedback = [];
    const giveItems = [...new Set(((ctx.raw && ctx.raw.inventory) || []).map((i) => i.name))];
    for (let tryN = 0; tryN < this.cfg.maxTries; tryN++) {
      const { rec, cands } = await this.askFit(ctx, allCands, feedback, { k, maxTokens: sc.maxTokens, temperature: sc.temperature, schemaOf: (c, o) => proposalsSchema(c, k, o), giveItems });
      const o = rec.rawOutput ? parseJson(rec.rawOutput) : null;
      const list = o && Array.isArray(o.goals) ? o.goals : [];
      const seen = new Set();
      const props = [];
      for (const g of list) {
        const pg = parseGoal(JSON.stringify(g), cands, { whyMax: this.cfg.whyMax });
        if (!pg) { props.push({ ok: false, result: 'parse', raw: g }); continue; }
        const key = `${pg.kind}|${pg.target}|${pg.count}|${pg.give || ''}`;
        if (seen.has(key)) { props.push({ ok: false, result: 'duplicate', pg }); continue; }
        seen.add(key);
        props.push({ pg, ...this.checkProposal(ctx, pg) });
      }
      this.addMeter(rec, props.some((x) => x.ok));
      const valid = props.filter((x) => x.ok);
      const brief = (x) => (x.pg ? { kind: x.pg.kind, target: x.pg.target, count: x.pg.count, give: x.pg.give, need: x.pg.need, why: x.pg.why, ok: !!x.ok, result: x.result || null, reason: x.why || null } : { ok: false, result: x.result });
      const base0 = { tick, reason, try: tryN, k, proposals: props.map(brief), order: this.lastOrder || null, worst: ctx.worst ? ctx.worst.need : null, worstText: ctx.worst ? ctx.worst.text : null,
        candidates: { items: cands.items.length, people: cands.people.length, places: cands.places.length, states: (cands.states || []).length }, ...rec };
      for (const x of props) {
        if (x.ok || !x.pg) continue;
        if (x.result === 'satisfied') this.counts.satisfied = (this.counts.satisfied || 0) + 1;
        if (x.result === 'unplannable') {
          this.counts.unplannable += 1;
          this.history.push({ ...x.pg, result: 'unplannable', resultText: x.why, from: tick, to: tick });
        }
        if (x.result === 'waiting') this.counts.waiting = (this.counts.waiting || 0) + 1;
        if (x.result === 'satisfied' || x.result === 'unplannable' || x.result === 'waiting') feedback.push(`${goalText(x.pg)}: ${x.why}`);
      }
      if (!valid.length) {
        this.counts.failed += list.length ? 0 : 1;
        this.log({ kind: 'proposals', ok: false, ...base0 });
        if (!list.length) { this.retryAt = tick + this.cfg.retryAfter; return false; }
        continue;
      }
      const sel = await this.selectByNeeds(ctx, valid, cands);
      const chosen = valid[sel.index];
      const pg = chosen.pg;
      const needAt = pg.need && ctx.needNow ? Math.round(ctx.needNow(pg.need) * 1000) / 1000 : null;
      this.counts.selected = (this.counts.selected || 0) + 1;
      const base = { ...base0, goalKind: pg.kind, target: pg.target, count: pg.count, give: pg.give, why: pg.why, need: pg.need, needAt, kindFixed: pg.kindFixed,
        needMatchesWorst: pg.need && ctx.worst ? pg.need === ctx.worst.need : null, policy: ctx.policy || null, desc: candDesc(cands, pg.target), select: sel.record };
      return this.accept(ctx, tick, pg, chosen.path, base);
    }
    this.retryAt = tick + this.cfg.retryAfter;
    return false;
  }

  // Jev に 案 × 欲求 (いま) と 案 × 先の欲求 を noul で1回に聞き、点 = Σ いまのつらさ^power × P + Σ 先のつらさ^power × P(先に役立つ) の最大の案を選ぶ。
  //   返り値 { index, record }。record.decidedBy: now (いまの点だけでも同じ案) | later (先の点で選ばれた案が変わった) | later_only (いまのつらさが無い)
  async selectByNeeds(ctx, valid, cands) {
    const sc = this.cfg.select;
    const needs = ctx.pressing ? ctx.pressing({ n: sc.needs, minRatio: sc.minRatio }) : [];
    const later = sc.later && ctx.later ? ctx.later({ minRatio: sc.laterMinRatio }).slice(0, sc.laterNeeds) : [];
    const record = { needs: needs.map((x) => ({ need: x.need, distress: x.distress, ratio: x.ratio })), later: later.map((x) => ({ need: x.need, distress: x.distress, ratio: x.ratio, text: x.text })), scores: [], chosen: 0, rule: null };
    if (valid.length === 1) { record.rule = 'only_one'; return { index: 0, record }; }
    if (!needs.length && !later.length) { record.rule = 'no_pressing_need'; return { index: 0, record }; }
    const p = ctx.persona || {};
    // 案の並べ方も変える (state のキーの順)
    let ids = valid.map((_, i) => i);
    if (this.order) { const r = this.order.shuffle(ids, 'goal_jev'); ids = r.arr; record.order = { seed: r.rec.seed, n: r.rec.n }; }
    const proposals = {};
    for (const i of ids) {
      const pg = valid[i].pg;
      const c = [...cands.items, ...cands.people, ...cands.places, ...(cands.states || [])].find((x) => x.name === pg.target);
      proposals[`p${i + 1}`] = `${goalTextEn(pg)}${c && c.descEn ? ` (${c.descEn})` : ''}`;
    }
    const state = { you: p.name };
    if (needs.length) state.needs = Object.fromEntries(needs.map((x) => [NEED_EN[x.need] || x.need, x.textEn]));
    if (later.length) state.later = Object.fromEntries(later.map((x) => [LATER_EN[x.need], x.textEn]));
    state.proposals = proposals;
    if (p.personality_en || p.personality) state.personality = p.personality_en || p.personality;
    const questions = {};
    for (const i of ids) {
      for (const x of needs) {
        const nk = NEED_EN[x.need] || x.need;
        questions[`p${i + 1}_${nk}`] = { type: 'noul', instructions: `If \`you\` achieved \`proposals.p${i + 1}\`, would that ease what \`needs.${nk}\` describes?` };
      }
      for (const x of later) questions[`p${i + 1}_later_${LATER_EN[x.need]}`] = { type: 'noul', instructions: LATER_Q[x.need](`p${i + 1}`) };
    }
    let r = null;
    try { r = await this.jev.call(state, questions, 'goal'); } catch (e) { r = { r: { ok: false, error: e.message } }; }
    record.jev = { inputTokens: r.inputTokens ?? null, ms: r.r ? r.r.ms : null, questions: Object.keys(questions).length, ok: !!(r.r && r.r.ok) };
    // 提供元・費用・refusal (答えの無い質問は P = 0 として数える)
    if (r.r) { if (r.r.via) record.jev.via = r.r.via; if (r.r.costUsd != null) record.jev.costUsd = r.r.costUsd; if (r.r.refusals && r.r.refusals.length) record.jev.refusals = r.r.refusals; if (r.r.longContext) record.jev.longContext = true; }
    if (!r.r || !r.r.ok) { record.rule = 'jev_error'; record.error = r.r ? r.r.error : null; return { index: 0, record }; }
    const ans = r.r.answers || {};
    const pv = (key) => { const a = ans[key]; return a && Number.isFinite(a.noul) ? a.noul : 0; };
    // いまの欲求は need のまま、先の欲求は later_<need> のキーで同じ表に入れる
    const all = [...needs, ...later.map((x) => ({ ...x, need: `later_${x.need}` }))];
    const P = valid.map((_, i) => Object.fromEntries([
      ...needs.map((x) => [x.need, pv(`p${i + 1}_${NEED_EN[x.need] || x.need}`)]),
      ...later.map((x) => [`later_${x.need}`, pv(`p${i + 1}_later_${LATER_EN[x.need]}`)]),
    ]));
    const costs = valid.map((v) => (Number.isFinite(v.cost) ? v.cost : null));
    const out = selectScores(P, all, sc, costs);
    const noEffort = selectScores(P, all, { ...sc, effort: null });
    const nowOnly = needs.length ? selectScores(P, needs, sc, costs) : null;
    const laterOnly = later.length ? selectScores(P, all.filter((x) => String(x.need).startsWith('later_')), { ...sc, onAllLow: 'best' }, costs) : null;
    const alpha = (sc.effort && sc.effort.alpha) || 0;
    record.formula = alpha > 0 ? `score = sum(distress * P) / (1 + ${alpha} * cost)` : 'score = sum(distress * P)';
    record.scores = valid.map((v, i) => ({ target: v.pg.target, kind: v.pg.kind, count: v.pg.count, need: v.pg.need, P: Object.fromEntries(Object.entries(P[i]).map(([kk, vv]) => [kk, Math.round(vv * 1000) / 1000])),
      now: nowOnly ? nowOnly.scores[i] : 0, later: laterOnly ? laterOnly.scores[i] : 0, cost: costs[i] == null ? null : Math.round(costs[i] * 100) / 100,
      effort: costs[i] == null ? null : effortWord(costs[i]), factor: Math.round(effortFactor(costs[i], alpha) * 1000) / 1000, noEffort: noEffort.scores[i], score: out.scores[i] }));
    record.chosen = out.index; record.rule = out.rule;
    record.effortChanged = noEffort.index !== out.index; // 手間で割らなければ別の案だった
    record.decidedBy = !nowOnly ? 'later_only' : (laterOnly && nowOnly.index !== out.index ? 'later' : 'now');
    record.nowChoice = nowOnly ? nowOnly.index : null;
    return { index: out.index, record };
  }

  pathRecord(p) {
    if (!p) return null;
    const r = { ok: p.ok, steps: (p.steps || []).map((s) => (s.act ? { act: s.how, text: states.actText(s) } : { item: s.item, count: s.count, how: s.how, from: s.from || null, where: s.where || null })), next: p.next ? (p.next.act ? p.next.how : p.next.item) : null };
    if (p.status) r.status = { have: p.status.have, known: !!p.status.known };
    if (p.effortWord) r.effort = p.effortWord;
    return r;
  }

  finish(result, tick, why, extra = {}) {
    const g = this.goal;
    const resultText = { planted: '植えた (あとは育つのを待つ)', done: '達成した', need_unmet: `手に入れた/着いたが、${NEED_LABEL[g.need] || ''}のつらさは変わらなかった`, stuck: `進まなかった (${why})`, unplannable: '作り方も手に入れ方も分からなくなった' }[result] || result;
    const h = { kind: g.kind, target: g.target, count: g.count, give: g.give, why: g.why, need: g.need, result, resultText, from: g.setAt, to: tick };
    this.history.push(h);
    if (result === 'done') this.counts.done += 1;
    else if (result === 'need_unmet') this.counts.needUnmet += 1;
    else if (result === 'stuck') this.counts.stuck += 1;
    else if (result === 'planted') this.counts.planted = (this.counts.planted || 0) + 1;
    this.log({ ...h, kind: result === 'done' || result === 'planted' ? 'goal_done' : 'reselect', goalKind: g.kind, result, tick, reason: why || null, needAt: g.needAt ?? null, ...extra });
    this.goal = null; this.path = null; this.lastNextKey = null;
  }

  needCheck(ctx) {
    const g = this.goal;
    if (!g || !g.need || !ctx.needNow || g.needAt == null) return { met: true, now: null };
    const now = Math.round(ctx.needNow(g.need) * 1000) / 1000;
    return { met: now <= g.needAt - this.cfg.needDrop || now <= this.cfg.needLow, now };
  }

  // 毎判断の前に呼ぶ。返り値: 何が起きたか (記録用) | null
  async update(ctx, tick, { troubles = [] } = {}) {
    this.troubleRun = troubles.length ? this.troubleRun + 1 : 0;
    if (!this.goal) {
      if (tick < this.retryAt) return null;
      await this.newGoal(ctx, tick, this.history.length ? 'after' : 'start');
      if (this.goal) this.refresh(ctx, tick);
      return 'goal';
    }
    const st = this.refresh(ctx, tick);
    const g = this.goal;
    if (g.metAt != null) {
      const nc = this.needCheck(ctx);
      if (nc.met) { this.finish('done', tick, null, { needNow: nc.now }); await this.newGoal(ctx, tick, 'done'); this.refresh(ctx, tick); return 'goal_done'; }
      if (tick - g.metAt < this.cfg.needWait) return null;
      this.finish('need_unmet', tick, null, { needNow: nc.now });
      await this.newGoal(ctx, tick, 'need_unmet'); this.refresh(ctx, tick);
      return 'need_unmet';
    }
    if ((g.kind === 'item' || g.kind === 'state') && this.path && !this.path.ok) {
      this.finish('unplannable', tick, this.path.missing || null);
      await this.newGoal(ctx, tick, 'unplannable'); this.refresh(ctx, tick);
      return 'unplannable';
    }
    // 植えて、道筋の残りが「育つのを待つ」だけになった → ゴールは済んだ扱いにして、別のゴールを選ぶ (2026-11-06)。
    //   植えた所と育つ見込みは、あとでやること (prospect.js) に残る。育っている頃になったらゴールの候補に出る
    if (g.kind === 'item' && this.cfg.finishOnWait !== false && this.waitingGrowth()) {
      this.finish('planted', tick, null, { growing: this.path.next.growing, crop: this.path.next.crop });
      await this.newGoal(ctx, tick, 'planted'); this.refresh(ctx, tick);
      return 'planted';
    }
    if (st.d < g.best - 1e-9) { g.best = st.d; g.bestAt = tick; }
    // 作物が育つのを待っている間は「道筋が縮まなかった」「困りごとが続いた」に数えない
    if (this.waitingGrowth()) { g.bestAt = tick; this.troubleRun = 0; }
    const stuckTrouble = this.troubleRun >= this.cfg.troubleTicks;
    const stuckLong = tick - g.bestAt >= this.cfg.patience;
    if (!stuckTrouble && !stuckLong) return null;
    const why = stuckTrouble ? `困りごとが${this.troubleRun}判断続いた: ${troubles.map((t) => t.about).join(' / ')}`
      : g.kind === 'item' || g.kind === 'state' ? `${tick - g.bestAt}判断、道筋が縮まなかった` : `${tick - g.bestAt}判断、近づかなかった`;
    this.finish('stuck', tick, why, { next: this.path && this.path.next ? (this.path.next.act ? this.path.next.how : this.path.next.item) : null });
    this.troubleRun = 0;
    await this.newGoal(ctx, tick, 'stuck'); this.refresh(ctx, tick);
    return 'stuck';
  }

  // 道筋 (物) / 次 (人・場所) を今の様子で作り直す。道筋の次の物が変わったら記録する
  refresh(ctx, tick) {
    const g = this.goal;
    if (!g) return { met: false, d: Infinity };
    if ((g.kind === 'item' || g.kind === 'state') && g.metAt == null) {
      this.path = g.kind === 'item' ? this.planItem(ctx, g.target, Math.max(0, g.count)) : this.planStateGoal(ctx, g);
      const nx = this.path.next ? (this.path.next.act ? this.path.next.how : this.path.next.item) : '-';
      const key = this.path.ok ? `${nx}|${this.path.steps.length}|${this.path.status ? this.path.status.have : ''}` : 'x';
      if (key !== this.lastNextKey) {
        this.lastNextKey = key;
        this.log({ kind: 'path', tick, goal: goalText(g), ...this.pathRecord(this.path), text: g.kind === 'item' ? pathText(this.path, { maxShown: this.cfg.maxShown }) : statePathText(this.path, { maxShown: this.cfg.maxShown }) });
      }
    }
    const st = this.targetStatus(ctx);
    g.statusText = st.text || null;
    g.statusTextEn = st.textEn || null;
    // 済んだ (物を持った・人の近く・着いた) ら、そのあとは済んだまま (置いて持ち物から消えても)
    if (st.met && g.metAt == null) { g.metAt = tick; this.log({ kind: 'reached', tick, goal: goalText(g), took: tick - g.setAt }); }
    return st;
  }
}

module.exports = { waitOnly, WAIT_WHY, effortFactor, rankPeople, goalTextEn, statePathEn, proposalsSchema, selectScores, GoalPath, DEFAULTS, goalSchema, parseGoal, goalText, statePathText, KINDS, KIND_JA };
