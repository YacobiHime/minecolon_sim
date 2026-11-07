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
const { Planner, pathText, stepText, remaining, GROUND, pathEn, stepTextEn, nextTextEn, FARM_CROPS, SAPLING_LOG, effortWord, EFFORT_EN } = require('./planner');
const states = require('./states');
const { dir8 } = require('./vocab');
const { itemCandidates, personCandidates, placeCandidates } = require('./vocab');
const { timeText } = require('./goalplan');
const { NEED_LABEL, LABEL_TO_NEED, NEED_EN } = require('./needs');
const { whereEn } = require('./en');
const { relDir, dist3 } = require('./util');
const promptfit = require('./promptfit');
const farmwater = require('./farmwater');
const { goalActivity } = require('./division');
const resolve = require('./resolve');
const { describeItem } = require('./vocab');

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
    steps: [['history', 2], ['experience', 3], ['board', 2], ['memChars', 300], ['facts', 4], ['peopleText', 2], ['people', 4], ['memPlaces', 2], ['items', 24],
      ['board', 0], ['memChars', 120], ['facts', 2], ['history', 0], ['experience', 1], ['peopleText', 0], ['policy', 0], ['people', 2], ['items', 16], ['facts', 0], ['memPlaces', 0], ['items', 10]],
  },
  // ゴールの選び方 (サーベイ R1、D2A の形): 2B が案を k 個 → Jev が 案 × 欲求 の noul (1回) → コードが Σ つらさ^power × P の最大を選ぶ。
  //   needs: 今つらい欲求の上位いくつを聞くか。minRatio: しきい値に対する割合がこれ未満の欲求は入れない
  //   tieEps: 最大との差がこれ以内の案は同点 → 2B が先に書いた案。lowP: どの案・欲求の P もこれ未満なら「全部低い」(onAllLow: best | first)
  //   つらい欲求が無いとき (no_pressing_need) は Jev を呼ばず、2B が先に書いた案
  //   later: 先のつらさ (anticipate.js: 夜・この先の食べ物) も 案 × 先の欲求 の noul で同じ呼び出しに足し、点 = Σ いまのつらさ × P + Σ 先のつらさ × P(先に役立つ)。
  //     laterMinRatio: しきい値に対する割合がこれ未満の先のつらさは入れない。laterNeeds: いくつまで
  //   effort: 手間で割る (2026-11-06)。点 = (Σ つらさ × P) ÷ (1 + alpha × 手間)。手間 = planner の手間 (物: effort、状態: planState の effort)、
  //     人・場所: 距離 × perMeter (見えない人は unseenPerson)。alpha: 0 で手間を見ない
  //   k: 案の数。数か、提供元ごとの { local, luna, default } (2026-11-07: luna 10、local 4)。tokensPerProposal: 案1つあたりの出力の上限 (maxTokens と大きい方)
  //   maxQuestions・maxBodyBytes: Jev の1回の呼び出しの質問の数・本文の大きさの上限。超えるなら案を分けて並列に呼ぶ
  //     (TypeSafe 直で 600 問まで通った (2026-11-07)。OpenRouter は本文 32,000 バイトを超えると long-context モード)
  select: { enabled: false, k: { local: 4, luna: 10, default: 4 }, tokensPerProposal: 110, maxQuestions: 60, maxBodyBytes: 30000, needs: 3, minRatio: 0.6, power: 1, tieEps: 0.02, lowP: 0.3, onAllLow: 'best', maxTokens: 480, temperature: 0.7, later: true, laterNeeds: 2, laterMinRatio: 0.5,
    effort: { alpha: 0.04, perMeter: 1 / 16, unseenPerson: 6 } },
  // 自由記述のゴール (2026-11-07 ユーザー決定): 文脈の広い提供元 (luna) では、ゴールの物・状態・人・場所を候補の enum から選ばせず、自由に書かせる。
  //   enabled: 'auto' (local 以外で使う) | true | false。書かれた名前は resolve.js で正式名に直す。直せない・たどれない・もう満たされている案は、
  //   理由を添えて maxRewrites 回まで書き直させる。候補の一覧は「知っていることの例」として maxExamples 個まで見せる (選択肢ではない)。
  //   textStates: 今の状態の型に当てはまらない状態の文を、済んだかを Jev の noul で聞く状態 (type: text) として受ける。
  //     選ぶ前に「見て確かめられるか」(checkableP 未満なら外す) と「もうそうなっているか」(textDoneP 以上なら外す) を Jev に聞く。
  //     ゴールにしたら textCheckEvery 判断ごとに「そうなったか」を聞き、textDoneP 以上で済んだとする
  freeform: { enabled: 'auto', maxRewrites: 2, maxExamples: 120, textStates: true, textCheckEvery: 4, textDoneP: 0.7, checkableP: 0.5 },
};
// 案の数 (提供元ごと)
function kOf(k, provider) {
  if (Number.isFinite(k)) return k;
  if (k && typeof k === 'object') return Number.isFinite(k[provider]) ? k[provider] : Number.isFinite(k.default) ? k.default : 4;
  return 4;
}
const KINDS = ['item', 'person', 'place', 'state'];
const WAIT_WHY = 'もう植えてある。育っている頃に戻る (あとでやること)';
const KIND_JA = { item: '物', person: '人', place: '場所', state: '状態' };
const NEED_LABELS = Object.values(NEED_LABEL);
// 先のつらさの英語のキー (Jev の state.later) と、案ごとの質問 (事実を問う形。評価語を入れない)
const LATER_EN = { night: 'night', food: 'food', tool: 'tool' };
const LATER_Q = {
  night: (p) => `If \`you\` achieved \`proposals.${p}\`, would that help \`you\` when the night that \`later.night\` describes comes?`,
  food: (p) => `If \`you\` achieved \`proposals.${p}\`, would that help \`you\` have food later, given what \`later.food\` describes?`,
  tool: (p) => `If \`you\` achieved \`proposals.${p}\`, would that help \`you\` still have a working tool later, given what \`later.tool\` describes?`,
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

// 自由記述 (freeform): target・give は文字列 (enum なし)。kind・need は今のまま
function goalSchemaFree() {
  return { type: 'object', properties: {
    kind: { type: 'string', enum: KINDS }, target: { type: 'string', maxLength: 80 }, count: { type: 'integer', minimum: 1, maximum: 64 },
    give: { type: 'string', maxLength: 40 }, why: { type: 'string', maxLength: 40 }, need: { type: 'string', enum: NEED_LABELS },
  }, required: ['kind', 'target', 'count', 'give', 'why', 'need'], additionalProperties: false };
}
function proposalsSchemaFree(k) {
  return { type: 'object', properties: { goals: { type: 'array', items: goalSchemaFree(), minItems: k, maxItems: k } }, required: ['goals'], additionalProperties: false };
}

// Jev の質問を、1回の呼び出しの上限 (質問の数・本文の大きさ) に収まるように案ごとに分ける。
//   groups: [{ id, q: { 名前: 質問 }, s: { 案の文 } }] → [[group, ...], ...]
function chunkQuestions(groups, base, { maxQuestions = 60, maxBodyBytes = 30000 } = {}) {
  const out = []; let cur = []; let nq = 0; let bytes = Buffer.byteLength(JSON.stringify(base));
  for (const g of groups) {
    const gq = Object.keys(g.q).length;
    const gb = Buffer.byteLength(JSON.stringify(g.q)) + Buffer.byteLength(JSON.stringify(g.s));
    if (cur.length && (nq + gq > maxQuestions || bytes + gb > maxBodyBytes)) { out.push(cur); cur = []; nq = 0; bytes = Buffer.byteLength(JSON.stringify(base)); }
    cur.push(g); nq += gq; bytes += gb;
  }
  if (cur.length) out.push(cur);
  return out;
}

// 案ごとの点 = Σ_欲求 つらさ^power × P(満たされる) ÷ (1 + alpha × 手間)。P[i] = { need: p }。needs = [{ need, distress }]。costs[i] = 手間 (無ければ割らない)
//   同点 (最大との差 ≤ tieEps) は先に書かれた案 (rule: tie_first)。全部の P < lowP なら rule: all_low (onAllLow: first なら最初の案)
function effortFactor(cost, alpha) { return Number.isFinite(cost) && alpha > 0 ? 1 / (1 + alpha * Math.max(0, cost)) : 1; }
//   division (分業。division.js): { T: [案ごとの反応の強さ], beta, gamma } があれば 点 = (Σ つらさ × P × (1 + beta × T) + gamma × T) ÷ (1 + alpha × 手間)
//   experience (経験。experience.js): { factor: [案ごとの q ÷ m0] } があれば分子に掛ける (P_実 = P × q ÷ m0。gamma × T の項にも)
function selectScores(P, needs, { power = 1, tieEps = 0.02, lowP = 0.3, onAllLow = 'best', effort = null } = {}, costs = null, division = null, experience = null) {
  const alpha = effort && Number.isFinite(effort.alpha) ? effort.alpha : 0;
  const Ti = (i) => (division && division.T && Number.isFinite(division.T[i]) ? division.T[i] : 0);
  const beta = division && Number.isFinite(division.beta) ? division.beta : 0;
  const gamma = division && Number.isFinite(division.gamma) ? division.gamma : 0;
  const Ei = (i) => (experience && experience.factor && Number.isFinite(experience.factor[i]) ? experience.factor[i] : 1);
  const scores = P.map((row, i) => Math.round((needs.reduce((t, x) => t + Math.pow(x.distress, power) * (row[x.need] || 0), 0) * (1 + beta * Ti(i)) + gamma * Ti(i)) * Ei(i) * (costs ? effortFactor(costs[i], alpha) : 1) * 1000) / 1000);
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
  // 畑: 耕す・植えるが残っておらず、植わっている作物がある / 木: 植えるが残っておらず、植わっている苗木がある
  return !!(n && (n.how === 'farm' || n.how === 'tree') && !(n.till > 0) && !(n.plants > 0) && n.growing > 0);
}

function invCount(raw, name) { return (raw.inventory || []).filter((i) => i.name === name).reduce((t, i) => t + i.count, 0); }

class GoalPath {
  constructor(opts = {}) {
    this.cfg = { ...DEFAULTS, ...(opts.cfg || {}) };
    this.cfg.select = { ...DEFAULTS.select, ...((opts.cfg && opts.cfg.select) || {}) };
    this.cfg.prompt = { ...DEFAULTS.prompt, ...((opts.cfg && opts.cfg.prompt) || {}) };
    this.ratio = new promptfit.TokenRatio({ initial: this.cfg.prompt.charsPerToken });
    this.jev = opts.jev || null;
    // 経験 (experience.js): 対象ごとの試した・達成した・かかった判断と時間。ゴールの点 (成功の見込み・手間) と 2B の言葉に使う
    this.experience = opts.experience || null;
    this.lastAge = null; // ゲーム内の時刻 (raw.self.age)。ゴールにかかった時間を数える // JevDecider (call(state, questions, stage) を使う)。select.enabled のときに要る
    this.order = opts.order || null; // Order (order.js)。候補の並べ方を毎回変える
    this.llm = opts.llm || new LLMDecider({ ...(opts.llmOpts || {}), mode: 'talk', maxTokens: this.cfg.maxTokens, temperature: this.cfg.temperature });
    // 文脈の上限 (promptfit) は提供元の ctxTokens (llm_provider.js)。local は goalPath.prompt.ctxTokens (llama-server の1スロット) があればそれ
    const userCtx = opts.cfg && opts.cfg.prompt && opts.cfg.prompt.ctxTokens;
    const prov = this.llm.provider || 'local';
    if (this.llm.ctxTokens && (prov !== 'local' || !userCtx)) this.cfg.prompt.ctxTokens = this.llm.ctxTokens;
    // 提供元ごとの既定: 案の数 (select.k) と自由記述 (freeform)
    this.provider = prov;
    this.cfg.freeform = { ...DEFAULTS.freeform, ...((opts.cfg && opts.cfg.freeform) || {}) };
    const ffOn = this.cfg.freeform.enabled;
    this.freeform = ffOn === 'auto' || ffOn == null ? prov !== 'local' : !!ffOn;
    this.k = kOf(this.cfg.select.k, prov);
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
    this.lastArrived = c.arrived || [];
    this.lastItemEffort = Object.fromEntries(c.items.filter((x) => x.effort).map((x) => [x.name, x.effort])); // 提案の物の名前に添える手間
    // R2: もう満たされている候補。場所: もう着いている所は外す。人: もう近くにいる人は「もう近くにいる」を付ける (渡すゴールはありうる)
    //   物・状態: 「もう持っている n」「もう n ある」を事実として付ける (vocab / states)。2B が選んだ数で満たされていれば goalpath が外す
    if (raw) {
      const here = raw.self.pos;
      c.arrived = c.places.filter((pl) => pl.pos && pl.type !== 'dir' && dist3(here, pl.pos) <= this.cfg.arriveDist); // 自由記述でその名前が書かれたら「もう着いている」
      c.places = c.places.filter((pl) => !c.arrived.includes(pl));
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
      items: itemCandidates({ raw, facts: ctx.allFacts || [], placeKinds: ctx.placeKinds || [], history: this.history, version: this.cfg.version, maxItems: this.freeform ? this.cfg.freeform.maxExamples : this.cfg.maxItems,
        recipeHops: this.freeform ? 2 : undefined, world: raw ? this.world(ctx) : null, annotate: this.cfg.annotate !== false }),
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
    const lim = { items: Infinity, people: Infinity, memPlaces: Infinity, facts: pc.maxFacts, board: pc.maxBoardLines, memChars: Infinity, history: 5, peopleText: Infinity, policy: 1, experience: this.experience ? this.experience.cfg.words.maxLines : 0 };
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
    const L = { board: Infinity, memChars: Infinity, history: 5, peopleText: Infinity, policy: 1, experience: this.experience ? this.experience.cfg.words.maxLines : 0, ...lim };
    const expText = this.experience && L.experience > 0 ? this.experience.lines({ max: L.experience }).join('\n') : '';
    const board = ctx.board && ctx.board.text ? (L.board === Infinity ? ctx.board.text : promptfit.capSectionLines(ctx.board.text, L.board)) : '';
    const mem = L.memChars === Infinity ? ctx.memText : promptfit.capLineChars(ctx.memText, L.memChars);
    const peopleText = ctx.peopleText && L.peopleText > 0 ? (L.peopleText === Infinity ? ctx.peopleText : ctx.peopleText.split('\n').slice(0, L.peopleText).join('\n')) : '';
    const inv = ((ctx.raw && ctx.raw.inventory) || []).map((i) => i.name);
    const ff = this.freeform;
    const hasStates = !!(cands.states && cands.states.length) || (ff && this.cfg.states);
    const sys = ff ? [
      `あなたは Minecraft の世界にいる「${p.name}」。${p.personality || ''}`,
      ctx.goalText ? `全体の目標: ${ctx.goalText}` : '',
      'あなたが知っているのは、自分で見たこと・やったこと・聞いたことと、「知っていること」だけ。',
      `自分がこれからめざすゴールを1つ決める。ゴールは、手に入れたい物 (kind: item)・近くに行きたい人 (kind: person)・行きたい場所 (kind: place)${hasStates ? '・こうなっていてほしい状態 (kind: state)' : ''} のどれか1つ。`,
      `target には、めざす物・人・場所${hasStates ? '・状態' : ''}を自由に書く。物は Minecraft の物の名前 (英語の名前か日本語の名前) で書く。${hasStates ? '状態は、こうなっていてほしい様子を短い文で書いてよい。' : ''}`
        + '下の「例」は今知っていることの一部で、選択肢ではない。ほかの物・場所・状態でもよい。物・状態なら count に数を書く。'
        + (inv.length ? '人に持ち物を渡したいときは give にその物の名前を書く (渡さないなら空の文字列)。' : 'give は空の文字列にする。'),
      `why にはそのゴールが何のためか、need にはそのゴールで満たしたいもの (${NEED_LABELS.join('・')}) を1つ書く。`,
      k > 1 ? `ゴールの案を${k}個出す (同じ案は書かない)。JSON {"goals":[{"kind":"...","target":"...","count":1,"give":"","why":"...","need":"..."}, ...]} だけを出力する。`
        : 'JSON {"kind":"...","target":"...","count":1,"give":"","why":"...","need":"..."} だけを出力する。',
    ] : [
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
      ctx.role ? `## 自分が最近よくしていること (振り返りで自分が書いたこと)\n${ctx.role}` : '',
      ctx.shortage ? `## みんなに足りていない物 (自分が見聞きした範囲)\n${ctx.shortage}` : '',
      (ctx.troubles || []).some((t) => t.kind === 'stuck') ? `## 困っていること\n${ctx.troubles.filter((t) => t.kind === 'stuck').map((t) => `${t.about} (${t.lastMsg})`).join('\n')}` : '',
      peopleText ? `## 周りの人\n${peopleText}` : '',
      board || '', // 全体に届いた話・取り決め・共同の目標・共有のチェスト (board.js)
      facts.length ? `## 知っていること\n${facts.join('\n')}` : '',
      '## 覚えていること', mem || 'なし',
      L.history > 0 ? `## これまでのゴール\n${this.historyText(L.history)}` : '',
      expText ? `## やってみたこと (自分の経験と、聞いたこと)\n${expText}` : '',
      `## ${ff ? '知っている物の例 (このほかの物でもよい)' : 'めざせる物'}\n${cands.items.map((c) => `${c.name}: ${c.desc}`).join('\n')}`,
      cands.states && cands.states.length ? `## ${ff ? '状態の例 (このほかの状態でもよい)' : 'めざせる状態'}\n${cands.states.map((c) => `${c.name}: ${c.desc}`).join('\n')}` : '',
      cands.people.length ? `## ${ff ? '知っている人' : '人'}\n${cands.people.map((c) => `${c.name}: ${c.desc}`).join('\n')}` : '',
      `## ${ff ? '知っている場所 (このほか、覚えている場所の種類でもよい)' : '場所'}\n${cands.places.map((c) => `${c.name}: ${c.desc}`).join('\n')}`,
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
      out = { rec, cands: bp.cands, messages: bp.messages, schema };
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
      // 植えた作物の覚えている場所 (道筋の「育っている頃に戻る (植わっている n、M2)」)
      cropPlaces: Object.fromEntries((ctx.places || []).filter((p) => FARM_CROPS.test(p.kind)).sort((a, b) => (a.d ?? 0) - (b.d ?? 0)).reverse().map((p) => [p.kind, { id: p.id, d: p.d }])),
      // 近くに植わっている苗木 (見えている苗木のブロックの数) と、植えた苗木の覚えている場所 (道筋の「植わっている oak_sapling 1 (M3)」)
      saplings: Object.fromEntries((raw.blocks || []).filter((b) => SAPLING_LOG[b.name]).map((b) => [b.name, b.seen || 1])),
      treePlaces: Object.fromEntries((ctx.places || []).filter((p) => SAPLING_LOG[p.kind]).sort((a, b) => (a.d ?? 0) - (b.d ?? 0)).reverse().map((p) => [p.kind, { id: p.id, d: p.d }])),
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
    // 文の状態 (freeform の type: text): 道筋は作らない。済んだかは Jev の noul (textCheck)
    if (st && st.type === 'text') return { ok: true, text: true, steps: [], next: null, done: false, effort: null, status: { have: g.textDone ? 1 : 0, known: true, p: g.textP ?? null } };
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
      // 文の状態: Jev の「そうなったか」の P が上がったら縮んだとみなす
      const d = p && p.text ? Math.round((1 - (g.textP ?? 0)) * 100) : p && p.ok ? p.steps.length * 100 + (p.left || 0) : 1e6;
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
      if (st && st.type === 'text') return { met: false }; // 文の状態は選ぶ前に Jev に聞く (checkTextStates)
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

  // ---- 自由記述 (freeform) ----
  // 名前を直すときの好み (持っている > 見えている > 例に出した > 手間が小さい)。1回の選び直しで1回作る
  preferOf(ctx, cands) {
    const raw = ctx.raw || { inventory: [], blocks: [], entities: [] };
    return { have: (raw.inventory || []).map((i) => i.name), seen: [...(raw.blocks || []).map((b) => b.name), ...(raw.entities || []).filter((e) => e.kind === 'item').map((e) => e.name)],
      shown: (cands.items || []).map((c) => c.name), planner: ctx.raw ? new Planner(this.world(ctx), { version: this.cfg.version }) : null };
  }

  // 案の説明 (desc・descEn) を付ける: 例の一覧にあればそれ、無ければ作る
  describe(pg, ctx, cands) {
    const c = cands ? [...cands.items, ...cands.people, ...cands.places, ...(cands.states || [])].find((x) => x.name === pg.target) : null;
    if (c) { pg.desc = c.desc; pg.descEn = c.descEn || null; return pg; }
    if (pg.kind === 'item') {
      const d = describeItem(pg.target, { raw: ctx && ctx.raw, world: ctx && ctx.raw ? this.world(ctx) : null, version: this.cfg.version, annotate: this.cfg.annotate !== false });
      pg.desc = d.desc; pg.descEn = d.descEn;
    } else if (pg.kind === 'state') {
      const st = pg.state || {};
      pg.desc = st.type === 'text' ? `状態 (文): ${st.text}` : `状態: ${states.stateGoalText(st, pg.count)}`;
      pg.descEn = st.type === 'text' ? `state written by ${(ctx && ctx.persona && ctx.persona.name) || 'you'}: ${st.text}` : `state: ${states.stateGoalTextEn(st, pg.count)}`;
    } else if (pg.place) { pg.desc = pg.place.desc || null; pg.descEn = pg.place.descEn || null; }
    return pg;
  }

  // 自由に書かれた案 o → { pg } | { error, why }。書かれた kind を先に試し、合わなければほかの kind (kindFixed)。
  //   状態の文が今の型に当てはまらなければ type: text (textStates のとき、書かれた kind が state のときだけ)
  resolveFree(o, cands, ctx, prefer) {
    if (!o || typeof o !== 'object') return { error: 'parse', why: '読めなかった' };
    const text = typeof o.target === 'string' ? o.target.trim() : '';
    if (!text) return { error: 'unresolved', why: 'target が空' };
    const kindIn = KINDS.includes(o.kind) ? o.kind : null;
    const ff = this.cfg.freeform;
    const peopleNames = [...new Set([...(cands.people || []).map((c) => c.name), ...(ctx.people || []).map((x) => x.name)])];
    const tryKind = (k) => {
      if (k === 'person') { const r = resolve.resolvePerson(text, peopleNames); return r.ok ? { kind: k, target: r.name, via: r.via } : { why: r.why }; }
      if (k === 'place') { const r = resolve.resolvePlace(text, cands.places || [], ctx.places || [], { arrived: this.lastArrived || [] }); return r.ok ? { kind: k, target: r.name, via: r.via, place: r.place } : { why: r.why }; }
      if (k === 'item') { const r = resolve.resolveItem(text, { version: this.cfg.version, prefer }); return r.ok ? { kind: k, target: r.name, via: r.via } : { why: r.why, suggestions: r.suggestions }; }
      if (k === 'state') {
        if (!this.cfg.states) return { why: '状態のゴールは使えない' };
        const r = resolve.resolveState(text, { cands: cands.states || [], allowText: false, version: this.cfg.version });
        if (r.ok && r.asItem) return { kind: 'item', target: r.asItem, via: r.via };
        return r.ok ? { kind: k, target: r.id, via: r.via, state: r.state } : { why: r.why };
      }
      return { why: '?' };
    };
    let hit = null; const whyBy = {};
    const order = [...new Set([kindIn, 'person', 'place', 'state', 'item'].filter(Boolean))];
    for (const k of order) { const r = tryKind(k); if (r.kind) { hit = r; break; } whyBy[k] = r.why; }
    const firstWhy = whyBy[kindIn] || whyBy.item;
    if (!hit && kindIn === 'state' && this.cfg.states && ff.textStates) {
      const r = resolve.resolveState(text, { cands: cands.states || [], allowText: true, version: this.cfg.version });
      if (r.ok && !r.asItem) hit = { kind: 'state', target: r.state.type === 'text' ? r.state.text : r.id, via: r.via, state: r.state };
    }
    if (!hit) return { error: 'unresolved', why: firstWhy || `「${text}」が分からなかった`, written: text, kind: kindIn };
    const lab = typeof o.need === 'string' ? o.need.trim() : '';
    const need = LABEL_TO_NEED[lab] || (NEED_LABEL[lab] ? lab : null);
    const st = hit.state || null;
    const inState = hit.kind === 'state' ? (cands.states || []).find((c) => c.name === hit.target) : null;
    // 状態の文に数が書いてあって count が 1 なら、文の数 (「明かりが4個ある」)
    const numInText = hit.kind === 'state' && hit.via !== 'exact' ? Number((text.match(/(\d+)\s*(?:個|頭|匹|マス|本|つ|blocks?|torches|lights?|\b)/) || [])[1]) : NaN;
    if (Number.isFinite(numInText) && numInText > 0 && !(Number(o.count) > 1)) o = { ...o, count: numInText };
    const count = hit.kind === 'item' ? Math.max(1, Math.min(64, Math.floor(Number(o.count)) || 1))
      : hit.kind === 'state' ? (st.type === 'walled' || st.type === 'text' ? 1 : Math.max(1, Math.min(64, Math.floor(Number(o.count)) || (inState && inState.count) || states.DEFAULTS.counts[st.type] || 1))) : null;
    let give = null;
    if (hit.kind === 'person' && typeof o.give === 'string' && o.give.trim()) {
      const gr = resolve.resolveItem(o.give, { version: this.cfg.version, prefer: { have: prefer.have } });
      if (!gr.ok || !(prefer.have || []).includes(gr.name)) return { error: 'unresolved', why: `${o.give} を持っていない`, written: text, kind: kindIn };
      give = gr.name;
    }
    const why = typeof o.why === 'string' ? o.why.trim().slice(0, this.cfg.whyMax) : '';
    const pg = { kind: hit.kind, target: hit.target, count, give, why: why || null, need, kindFixed: !!kindIn && kindIn !== hit.kind, place: hit.place || null, state: st,
      resolved: { written: text, via: hit.via, kindWritten: kindIn } };
    this.describe(pg, ctx, cands);
    return { pg };
  }

  // 文の状態の案 (type: text) を、選ぶ前に Jev に聞く: 見て確かめられるか・もうそうなっているか。返り値 { [i]: { checkable, done } }
  async checkTextStates(ctx, valid) {
    const idx = valid.map((v, i) => (v.pg.kind === 'state' && v.pg.state && v.pg.state.type === 'text' ? i : -1)).filter((i) => i >= 0);
    if (!idx.length || !this.jev) return { res: {}, record: null };
    const p = ctx.persona || {};
    const state = { you: p.name, now: String(ctx.obsText || '').slice(0, 1500), states: Object.fromEntries(idx.map((i) => [`s${i + 1}`, valid[i].pg.state.text])) };
    const questions = {};
    for (const i of idx) {
      questions[`s${i + 1}_checkable`] = { type: 'noul', instructions: `Could \`you\` tell, just by looking around, whether \`states.s${i + 1}\` is true?` };
      questions[`s${i + 1}_done`] = { type: 'noul', instructions: `Given \`now\`, is \`states.s${i + 1}\` already true?` };
    }
    let r = null;
    try { r = await this.jev.call(state, questions, 'goal_text'); } catch (e) { r = { r: { ok: false, error: e.message } }; }
    const ans = (r.r && r.r.answers) || {};
    const pv = (k) => (ans[k] && Number.isFinite(ans[k].noul) ? ans[k].noul : null);
    const res = {};
    for (const i of idx) res[i] = { checkable: pv(`s${i + 1}_checkable`), done: pv(`s${i + 1}_done`) };
    return { res, record: { ok: !!(r.r && r.r.ok), inputTokens: r.inputTokens ?? null, ms: r.r ? r.r.ms : null, questions: Object.keys(questions).length } };
  }

  // 文の状態のゴールが済んだか (textCheckEvery 判断ごと)
  async textCheck(ctx, tick) {
    const g = this.goal;
    if (!this.jev || !g || g.kind !== 'state' || !g.state || g.state.type !== 'text' || g.metAt != null) return;
    if (g.textAt != null && tick - g.textAt < this.cfg.freeform.textCheckEvery) return;
    g.textAt = tick;
    const p = ctx.persona || {};
    const state = { you: p.name, goal: g.state.text, now: String(ctx.obsText || '').slice(0, 1500) };
    const questions = { done: { type: 'noul', instructions: 'Given `now`, is `goal` true now?' } };
    let r = null;
    try { r = await this.jev.call(state, questions, 'goal_text'); } catch (e) { r = { r: { ok: false, error: e.message } }; }
    const a = r.r && r.r.ok && r.r.answers && r.r.answers.done;
    if (a && Number.isFinite(a.noul)) { g.textP = a.noul; if (a.noul >= this.cfg.freeform.textDoneP) g.textDone = true; }
    this.log({ kind: 'text_check', tick, goal: g.state.text, p: g.textP ?? null, done: !!g.textDone, ok: !!a, inputTokens: r.inputTokens ?? null });
  }

  // Jev の state.plan (英語のオブジェクト): { goal, for_need, why (2B の原文), path, next, status }
  planEn() {
    const g = this.goal;
    if (!g) return null;
    const o = { goal: goalTextEn(g) };
    if (g.need) o.for_need = NEED_EN[g.need] || g.need;
    if (g.why) o.why = g.why;
    if (g.metAt != null) { o.status = g.kind === 'item' ? 'obtained' : g.kind === 'state' ? 'done' : g.kind === 'person' ? (g.give ? 'given' : 'near them now') : 'arrived'; return o; }
    if (g.kind === 'state' && this.path && this.path.text) { o.check = 'not yet (judged by looking around)'; return o; }
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
    if (g.kind === 'state' && this.path && this.path.text) return `${head} / まだ (見て確かめる)`;
    if (g.kind === 'state') return this.path && this.path.ok ? `${head} / ${statePathText(this.path, { maxShown: this.cfg.maxShown })}` : head;
    return g.statusText ? `${head} / 次: ${g.statusText}` : head;
  }

  // ---- ゴールを決める ----
  async newGoal(ctx, tick, reason = 'start') {
    if (this.cfg.select.enabled && this.jev && (this.k || 1) > 1) return this.newGoalSelect(ctx, tick, reason);
    const allCands = this.candidates(ctx);
    const feedback = [];
    const giveItems = [...new Set(((ctx.raw && ctx.raw.inventory) || []).map((i) => i.name))];
    for (let tryN = 0; tryN < this.cfg.maxTries; tryN++) {
      const ff = this.freeform;
      const { rec, cands } = await this.askFit(ctx, allCands, feedback, { schemaOf: ff ? () => goalSchemaFree() : goalSchema, giveItems });
      let pg = null;
      if (ff && rec.rawOutput) {
        const o = parseJson(rec.rawOutput);
        const rf = this.resolveFree(o, cands, ctx, this.preferOf(ctx, cands));
        if (!rf.pg && rf.error === 'unresolved') {
          this.addMeter(rec, false);
          this.counts.unresolved = (this.counts.unresolved || 0) + 1;
          this.log({ kind: 'unresolved', ok: false, tick, reason, try: tryN, written: rf.written, kindWritten: rf.kind, why: rf.why, ...rec });
          feedback.push(`${rf.written}: ${rf.why}`);
          continue;
        }
        pg = rf.pg || null;
      } else pg = rec.rawOutput ? parseGoal(rec.rawOutput, cands, { whyMax: this.cfg.whyMax }) : null;
      this.addMeter(rec, !!pg);
      const needAt = pg && pg.need && ctx.needNow ? Math.round(ctx.needNow(pg.need) * 1000) / 1000 : null;
      const base = { tick, reason, try: tryN, goalKind: pg ? pg.kind : null, target: pg ? pg.target : null, count: pg ? pg.count : null, give: pg ? pg.give : null,
        why: pg ? pg.why : null, need: pg ? pg.need : null, needAt, kindFixed: pg ? pg.kindFixed : null, worst: ctx.worst ? ctx.worst.need : null, worstText: ctx.worst ? ctx.worst.text : null,
        needMatchesWorst: pg && pg.need && ctx.worst ? pg.need === ctx.worst.need : null, policy: ctx.policy || null, desc: pg ? pg.desc || candDesc(cands, pg.target) : null,
        ...(pg && pg.resolved ? { written: pg.resolved.written, via: pg.resolved.via } : {}),
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
      if (path.text) return { ok: true, path, cost: null };
      if (!path.ok) return { ok: false, result: 'unplannable', why: `${path.missing || ''} の手に入れ方が分からなかった`, missing: path.missing || null };
      return { ok: true, path, cost: path.effort };
    }
    if (pg.kind === 'item') {
      const planner = new Planner(this.world(ctx), { version: this.cfg.version });
      let path = planner.plan(pg.target, pg.count);
      // freeform: 書かれた種類 (木・色) がたどれなければ、たどれる種類違いに直す (oak_planks → jungle_planks)
      if (!path.ok && this.freeform) {
        const alt = resolve.plannableVariant(pg.target, planner, this.cfg.version);
        if (alt) {
          const p2 = planner.plan(alt, pg.count);
          if (p2.ok) { pg.resolved = { ...(pg.resolved || {}), variantOf: pg.target, via: `${(pg.resolved && pg.resolved.via) || 'exact'}+variant` }; pg.target = alt; this.describe(pg, ctx, null); path = p2; }
        }
      }
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
    const age = ctx.raw.self && Number.isFinite(ctx.raw.self.age) ? ctx.raw.self.age : null;
    this.goal = { ...pg, gameAt: age, lastStatus: path && path.status && path.status.known ? path.status : null, needAt: base.needAt, setAt: tick, n: this.counts.goals, startPos: { x: here.x, y: here.y, z: here.z }, pos: pg.place ? pg.place.pos || null : null, metAt: null, best: Infinity, bestAt: tick };
    this.path = path;
    this.troubleRun = 0;
    // あとでやること (prospect.js) の候補を選んだ: どれか (summarize_run の「見込みの時刻のあと取りに行った」)
    const later = pg.place && pg.place.type === 'later' ? { id: pg.place.laterId, kind: pg.place.laterKind } : null;
    this.log({ kind: 'goal', ok: true, ...base, activity: goalActivity(pg), ...(later ? { later } : {}), path: path ? this.pathRecord(path) : null });
    return true;
  }

  // R1 (D2A の形): 2B が案を k 個 → 満たされている・たどれない案を外す → Jev が 案 × 欲求 の noul → コードで点の最大を選ぶ
  //   freeform (luna): 案は自由記述。名前を正式名に直し (resolve.js)、直せない・たどれない・満たされている・重複の案は理由を添えて
  //   freeform.maxRewrites 回まで書き直させる (同じ会話に続けて、その数だけ)
  async newGoalSelect(ctx, tick, reason) {
    const sc = this.cfg.select;
    const k = this.k;
    const ff = this.freeform;
    const maxTokens = Math.max(sc.maxTokens || 0, k * (sc.tokensPerProposal || 0));
    const allCands = this.candidates(ctx);
    const feedback = [];
    const giveItems = [...new Set(((ctx.raw && ctx.raw.inventory) || []).map((i) => i.name))];
    for (let tryN = 0; tryN < this.cfg.maxTries; tryN++) {
      const fit = await this.askFit(ctx, allCands, feedback, { k, maxTokens, temperature: sc.temperature, schemaOf: ff ? () => proposalsSchemaFree(k) : (c, o) => proposalsSchema(c, k, o), giveItems });
      const { rec, cands } = fit;
      const prefer = ff ? this.preferOf(ctx, cands) : null;
      const seen = new Set();
      const props = [];
      // 1つの案を読む → 確かめる
      const take = (g, round) => {
        let pg = null;
        if (ff) {
          const r = this.resolveFree(g, cands, ctx, prefer);
          if (!r.pg) return { ok: false, result: r.error || 'unresolved', why: r.why, written: r.written || (g && g.target) || null, kindWritten: r.kind || null, raw: g, round };
          pg = r.pg;
        } else {
          pg = parseGoal(JSON.stringify(g), cands, { whyMax: this.cfg.whyMax });
          if (!pg) return { ok: false, result: 'parse', raw: g, round };
        }
        // 重複 (同じ正式名): 数は見ない
        const key = `${pg.kind}|${pg.target}|${pg.give || ''}`;
        if (seen.has(key)) return { ok: false, result: 'duplicate', why: '同じ案がもうある', pg, round };
        seen.add(key);
        const chk = this.checkProposal(ctx, pg);
        if (pg.resolved && pg.resolved.variantOf) seen.add(`${pg.kind}|${pg.target}|${pg.give || ''}`); // 種類違いに直した名前も
        return { pg, ...chk, round };
      };
      const o = rec.rawOutput ? parseJson(rec.rawOutput) : null;
      const list = o && Array.isArray(o.goals) ? o.goals : [];
      for (const g of list) props.push(take(g, 0));
      // 書き直し (freeform)
      const rewrites = [];
      let msgs = fit.messages; let lastOut = rec.rawOutput;
      for (let rw = 1; ff && list.length && rw <= (this.cfg.freeform.maxRewrites || 0); rw++) {
        const bad = props.filter((x) => !x.ok && !x.replaced && ['unresolved', 'parse', 'unplannable', 'satisfied', 'waiting', 'duplicate'].includes(x.result));
        if (!bad.length) break;
        const lines = bad.map((x) => `- ${x.pg ? `「${x.pg.resolved ? x.pg.resolved.written : x.pg.target}」(${goalText(x.pg)})` : `「${x.written || JSON.stringify(x.raw)}」`}: ${x.why || x.result}`);
        const used = props.filter((x) => x.ok && x.pg).map((x) => `- ${goalText(x.pg)}`);
        msgs = [...msgs, { role: 'assistant', content: String(lastOut || '') }, { role: 'user', content: `## 使えなかった案\n${lines.join('\n')}${used.length ? `\n## 使えた案 (もう出ている)\n${used.join('\n')}` : ''}\n使えなかった案の代わりに、ここに無い別の案を${bad.length}個、同じ形の JSON で。` }];
        const r2 = await this.ask2B(msgs, proposalsSchemaFree(bad.length), { maxTokens: Math.max(sc.maxTokens || 0, bad.length * (sc.tokensPerProposal || 0)), temperature: sc.temperature });
        this.addMeter(r2, !!r2.rawOutput);
        lastOut = r2.rawOutput;
        const o2 = r2.rawOutput ? parseJson(r2.rawOutput) : null;
        const l2 = o2 && Array.isArray(o2.goals) ? o2.goals : [];
        for (const x of bad) x.replaced = rw;
        const added = l2.map((g) => take(g, rw));
        props.push(...added);
        rewrites.push({ round: rw, asked: bad.length, got: l2.length, ok: added.filter((x) => x.ok).length, promptTokens: r2.promptTokens, completionTokens: r2.completionTokens, ms: r2.ms, error: r2.error || null,
          reasons: bad.map((x) => ({ written: x.pg ? (x.pg.resolved ? x.pg.resolved.written : x.pg.target) : x.written, result: x.result, why: x.why || null })) });
      }
      this.addMeter(rec, props.some((x) => x.ok));
      let valid = props.filter((x) => x.ok);
      // 文の状態: 見て確かめられるか・もうそうなっているか (Jev)
      let textRec = null;
      if (ff && valid.some((v) => v.pg.state && v.pg.state.type === 'text')) {
        const tc = await this.checkTextStates(ctx, valid);
        textRec = tc.record;
        const fc = this.cfg.freeform;
        valid.forEach((v, i) => {
          const r = tc.res[i];
          if (!r) return;
          v.textCheck = r;
          if (r.checkable != null && r.checkable < fc.checkableP) { v.ok = false; v.result = 'uncheckable'; v.why = '見て確かめられない'; }
          else if (r.done != null && r.done >= fc.textDoneP) { v.ok = false; v.result = 'satisfied'; v.why = 'もうそうなっている'; }
        });
        valid = valid.filter((v) => v.ok);
      }
      const brief = (x) => (x.pg ? { kind: x.pg.kind, target: x.pg.target, count: x.pg.count, give: x.pg.give, need: x.pg.need, why: x.pg.why, ok: !!x.ok, result: x.result || null, reason: x.ok ? null : x.why || null,
        ...(x.pg.resolved ? { written: x.pg.resolved.written, via: x.pg.resolved.via, ...(x.pg.resolved.variantOf ? { variantOf: x.pg.resolved.variantOf } : {}) } : {}), ...(x.pg.kindFixed ? { kindFixed: true } : {}),
        ...(x.round ? { round: x.round } : {}), ...(x.replaced ? { replaced: x.replaced } : {}), ...(x.textCheck ? { textCheck: x.textCheck } : {}) }
        : { ok: false, result: x.result, reason: x.why || null, written: x.written || null, kindWritten: x.kindWritten || null, ...(x.round ? { round: x.round } : {}), ...(x.replaced ? { replaced: x.replaced } : {}) });
      const base0 = { tick, reason, try: tryN, k, freeform: ff, provider: this.provider, proposals: props.map(brief), diversity: this.diversity(props, valid, cands), ...(rewrites.length ? { rewrites } : {}), ...(textRec ? { textJev: textRec } : {}),
        order: this.lastOrder || null, worst: ctx.worst ? ctx.worst.need : null, worstText: ctx.worst ? ctx.worst.text : null,
        candidates: { items: cands.items.length, people: cands.people.length, places: cands.places.length, states: (cands.states || []).length }, ...rec };
      for (const x of props) {
        if (x.ok || !x.pg) continue;
        if (x.result === 'satisfied') this.counts.satisfied = (this.counts.satisfied || 0) + 1;
        if (x.result === 'unplannable') {
          this.counts.unplannable += 1;
          this.history.push({ ...x.pg, result: 'unplannable', resultText: x.why, from: tick, to: tick });
        }
        if (x.result === 'waiting') this.counts.waiting = (this.counts.waiting || 0) + 1;
        if (!x.replaced && (x.result === 'satisfied' || x.result === 'unplannable' || x.result === 'waiting' || x.result === 'uncheckable')) feedback.push(`${goalText(x.pg)}: ${x.why}`);
      }
      for (const x of props) if (!x.pg && !x.replaced && x.result === 'unresolved') { this.counts.unresolved = (this.counts.unresolved || 0) + 1; feedback.push(`${x.written}: ${x.why}`); }
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
        needMatchesWorst: pg.need && ctx.worst ? pg.need === ctx.worst.need : null, policy: ctx.policy || null, desc: pg.desc || candDesc(cands, pg.target), select: sel.record,
        ...(pg.resolved ? { written: pg.resolved.written, via: pg.resolved.via } : {}) };
      return this.accept(ctx, tick, pg, chosen.path, base);
    }
    this.retryAt = tick + this.cfg.retryAfter;
    return false;
  }

  // 案の広がり (記録・summarize_run): 書いた数・読めた数・使えた数・種類 (正式名) の数・kind ごと・例の一覧に無い物の数・直し方ごと
  diversity(props, valid, cands) {
    const withPg = props.filter((x) => x.pg);
    const shown = new Set([...cands.items, ...cands.people, ...cands.places, ...(cands.states || [])].map((c) => c.name));
    const tally = (arr, f) => { const m = {}; for (const x of arr) { const kk = f(x); if (kk != null) m[kk] = (m[kk] || 0) + 1; } return m; };
    return {
      written: props.filter((x) => !x.round).length, rewritten: props.filter((x) => x.round).length,
      resolved: withPg.length, valid: valid.length,
      distinct: new Set(withPg.map((x) => `${x.pg.kind}|${x.pg.target}`)).size,
      distinctValid: new Set(valid.map((x) => `${x.pg.kind}|${x.pg.target}`)).size,
      kinds: tally(valid, (x) => x.pg.kind),
      outsideExamples: valid.filter((x) => !shown.has(x.pg.target)).length,
      via: tally(withPg, (x) => (x.pg.resolved ? x.pg.resolved.via : null)),
      dropped: tally(props.filter((x) => !x.ok), (x) => x.result),
    };
  }

  // Jev に 案 × 欲求 (いま) と 案 × 先の欲求 を noul で1回に聞き、点 = Σ いまのつらさ^power × P + Σ 先のつらさ^power × P(先に役立つ) の最大の案を選ぶ。
  //   返り値 { index, record }。record.decidedBy: now (いまの点だけでも同じ案) | later (先の点で選ばれた案が変わった) | later_only (いまのつらさが無い)
  async selectByNeeds(ctx, valid, cands) {
    const sc = this.cfg.select;
    const needs = ctx.pressing ? ctx.pressing({ n: sc.needs, minRatio: sc.minRatio }) : [];
    const later = sc.later && ctx.later ? ctx.later({ minRatio: sc.laterMinRatio }).slice(0, sc.laterNeeds) : [];
    const record = { needs: needs.map((x) => ({ need: x.need, distress: x.distress, ratio: x.ratio })), later: later.map((x) => ({ need: x.need, distress: x.distress, ratio: x.ratio, text: x.text })), scores: [], chosen: 0, rule: null };
    if (valid.length === 1) { record.rule = 'only_one'; return { index: 0, record }; }
    // 分業 (division.js): 案ごとの活動・反応の強さ T・慣れ (手間を小さく感じる)
    const dv = ctx.division || null;
    const dsc = dv ? dv.score || {} : {};
    const acts = dv ? valid.map((v) => dv.activityOf(v.pg)) : null;
    // 物単位の刺激 (division.goalT。聞いた頼みごと・独り言・共有のチェストの道具の数) があれば、活動の刺激と足して T を作る
    const Tarr = dv ? valid.map((v, i) => (dv.Tof ? dv.Tof(v.pg) : (acts[i] && dv.T[acts[i]]) || 0)) : null;
    const sItemArr = dv && dv.goalT ? valid.map((v) => { const g = dv.goalT(v.pg); return g.item ? { item: g.item, s: g.sItem } : null; }) : null;
    const famArr = dv ? acts.map((a) => (a && dv.fam[a]) || 0) : null;
    const divOpt = dv ? { T: Tarr, beta: dsc.beta ?? 0, gamma: dsc.gamma ?? 0 } : null;
    // 経験 (experience.js): 成功の見込みの比 (q ÷ m0) を点に掛け、手間を実際にかかった判断の数で直す
    const ex = this.experience;
    const expS = valid.map((v) => (ex ? ex.success(v.pg) : { q: null, factor: 1, n: 0 }));
    const expCost = valid.map((v) => (ex ? ex.cost(v.pg, Number.isFinite(v.cost) ? v.cost : null) : (Number.isFinite(v.cost) ? v.cost : null)));
    const expOpt = ex ? { factor: expS.map((x) => x.factor) } : null;
    const costs = valid.map((v, i) => (Number.isFinite(expCost[i]) ? expCost[i] * (dv ? 1 - (dsc.skillCut ?? 0) * famArr[i] : 1) : null));
    const rawCosts = valid.map((v, i) => (Number.isFinite(expCost[i]) ? expCost[i] : null));
    const planCosts = valid.map((v, i) => (Number.isFinite(v.cost) ? v.cost * (dv ? 1 - (dsc.skillCut ?? 0) * famArr[i] : 1) : null)); // 経験を入れなかったら
    if (ex) record.experience = { q: expS.map((x) => x.q), factor: expS.map((x) => x.factor), n: expS.map((x) => x.n), planCost: valid.map((v) => (Number.isFinite(v.cost) ? Math.round(v.cost * 100) / 100 : null)), cost: expCost.map((c) => (Number.isFinite(c) ? Math.round(c * 100) / 100 : null)) };
    if (dv) record.division = { acts, T: Tarr, fam: famArr, s: acts.map((a) => (a && dv.s[a]) || 0), theta: acts.map((a) => (a && dv.theta[a]) || null), beta: divOpt.beta, gamma: divOpt.gamma, skillCut: dsc.skillCut ?? 0, ...(sItemArr && sItemArr.some(Boolean) ? { item: sItemArr } : {}) };
    if (!needs.length && !later.length) {
      // つらい欲求が無い: 刺激 (T) があれば gamma × T ÷ (1 + alpha × 手間') の最大 (Jev は呼ばない)。無ければ 2B が先に書いた案
      if (dv && Tarr.some((t) => t > 0) && divOpt.gamma > 0) {
        const out0 = selectScores(valid.map(() => ({})), [], { ...sc, onAllLow: 'best' }, costs, divOpt, expOpt);
        record.scores = valid.map((v, i) => ({ target: v.pg.target, kind: v.pg.kind, count: v.pg.count, need: v.pg.need, activity: acts[i], T: Tarr[i], score: out0.scores[i] }));
        record.rule = 'division_only'; record.chosen = out0.index; record.division.changed = out0.index !== 0; record.decidedBy = 'division';
        return { index: out0.index, record };
      }
      record.rule = 'no_pressing_need'; return { index: 0, record };
    }
    const p = ctx.persona || {};
    // 案の並べ方も変える (state のキーの順)
    let ids = valid.map((_, i) => i);
    if (this.order) { const r = this.order.shuffle(ids, 'goal_jev'); ids = r.arr; record.order = { seed: r.rec.seed, n: r.rec.n }; }
    // 案ごとの質問のまとまり。1回の呼び出しの上限 (maxQuestions・maxBodyBytes) を超えるなら案を分けて並列に呼ぶ
    const groups = ids.map((i) => {
      const pg = valid[i].pg;
      const c = pg.descEn !== undefined ? null : [...cands.items, ...cands.people, ...cands.places, ...(cands.states || [])].find((x) => x.name === pg.target);
      const descEn = pg.descEn !== undefined ? pg.descEn : c ? c.descEn : null;
      const q = {};
      for (const x of needs) {
        const nk = NEED_EN[x.need] || x.need;
        q[`p${i + 1}_${nk}`] = { type: 'noul', instructions: `If \`you\` achieved \`proposals.p${i + 1}\`, would that ease what \`needs.${nk}\` describes?` };
      }
      for (const x of later) q[`p${i + 1}_later_${LATER_EN[x.need]}`] = { type: 'noul', instructions: LATER_Q[x.need](`p${i + 1}`) };
      return { id: i, s: { [`p${i + 1}`]: `${goalTextEn(pg)}${descEn ? ` (${descEn})` : ''}` }, q };
    });
    const base = { you: p.name };
    if (needs.length) base.needs = Object.fromEntries(needs.map((x) => [NEED_EN[x.need] || x.need, x.textEn]));
    if (later.length) base.later = Object.fromEntries(later.map((x) => [LATER_EN[x.need], x.textEn]));
    const personality = p.personality_en || p.personality || null;
    const chunks = chunkQuestions(groups, { ...base, personality }, { maxQuestions: sc.maxQuestions, maxBodyBytes: sc.maxBodyBytes });
    const calls = await Promise.all(chunks.map(async (ch) => {
      const state = { ...base, proposals: Object.assign({}, ...ch.map((g) => g.s)) };
      if (personality) state.personality = personality;
      const questions = Object.assign({}, ...ch.map((g) => g.q));
      try { return { ...(await this.jev.call(state, questions, 'goal')), nq: Object.keys(questions).length }; } catch (e) { return { r: { ok: false, error: e.message }, nq: Object.keys(questions).length }; }
    }));
    const sumN = (f) => { const v = calls.map(f).filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) : null; };
    const r = { inputTokens: sumN((c) => c.inputTokens), r: { ok: calls.every((c) => c.r && c.r.ok), ms: Math.max(0, ...calls.map((c) => (c.r && c.r.ms) || 0)),
      answers: Object.assign({}, ...calls.map((c) => (c.r && c.r.answers) || {})), error: (calls.find((c) => !(c.r && c.r.ok)) || { r: {} }).r.error || null,
      via: calls[0] && calls[0].r ? calls[0].r.via : undefined, costUsd: sumN((c) => (c.r ? c.r.costUsd : null)), refusals: calls.flatMap((c) => (c.r && c.r.refusals) || []), longContext: calls.some((c) => c.r && c.r.longContext) } };
    record.jev = { inputTokens: r.inputTokens ?? null, ms: r.r.ms, questions: sumN((c) => c.nq), calls: calls.length, ok: !!r.r.ok };
    // 提供元・費用・refusal (答えの無い質問は P = 0 として数える)
    if (r.r.via) record.jev.via = r.r.via; if (r.r.costUsd != null) record.jev.costUsd = r.r.costUsd; if (r.r.refusals.length) record.jev.refusals = r.r.refusals; if (r.r.longContext) record.jev.longContext = true;
    if (!r.r.ok) { record.rule = 'jev_error'; record.error = r.r.error; return { index: 0, record }; }
    const ans = r.r.answers || {};
    const pv = (key) => { const a = ans[key]; return a && Number.isFinite(a.noul) ? a.noul : 0; };
    // いまの欲求は need のまま、先の欲求は later_<need> のキーで同じ表に入れる
    const all = [...needs, ...later.map((x) => ({ ...x, need: `later_${x.need}` }))];
    const P = valid.map((_, i) => Object.fromEntries([
      ...needs.map((x) => [x.need, pv(`p${i + 1}_${NEED_EN[x.need] || x.need}`)]),
      ...later.map((x) => [`later_${x.need}`, pv(`p${i + 1}_later_${LATER_EN[x.need]}`)]),
    ]));
    const out = selectScores(P, all, sc, costs, divOpt, expOpt);
    const noEffort = selectScores(P, all, { ...sc, effort: null }, null, divOpt, expOpt);
    const noDivision = dv ? selectScores(P, all, sc, rawCosts, null, expOpt) : null; // 分業を入れなかったら (T も慣れも無し)
    const noExperience = ex ? selectScores(P, all, sc, planCosts, divOpt) : null; // 経験を入れなかったら (見込みも手間の補正も無し)
    const nowOnly = needs.length ? selectScores(P, needs, sc, costs, divOpt, expOpt) : null;
    const laterOnly = later.length ? selectScores(P, all.filter((x) => String(x.need).startsWith('later_')), { ...sc, onAllLow: 'best' }, costs, divOpt, expOpt) : null;
    const alpha = (sc.effort && sc.effort.alpha) || 0;
    const num = dv ? `(sum(distress * P) * (1 + ${divOpt.beta} * T) + ${divOpt.gamma} * T)` : 'sum(distress * P)';
    const num2 = ex ? `(q / ${ex.cfg.prior.mean}) * ${num}` : num;
    record.formula = alpha > 0 ? `score = ${num2} / (1 + ${alpha} * cost${ex ? '_exp' : ''}${dv ? ` * (1 - ${dsc.skillCut ?? 0} * fam)` : ''})` : `score = ${num2}`;
    record.scores = valid.map((v, i) => ({ target: v.pg.target, kind: v.pg.kind, count: v.pg.count, need: v.pg.need, P: Object.fromEntries(Object.entries(P[i]).map(([kk, vv]) => [kk, Math.round(vv * 1000) / 1000])),
      now: nowOnly ? nowOnly.scores[i] : 0, later: laterOnly ? laterOnly.scores[i] : 0, cost: costs[i] == null ? null : Math.round(costs[i] * 100) / 100,
      effort: costs[i] == null ? null : effortWord(costs[i]), factor: Math.round(effortFactor(costs[i], alpha) * 1000) / 1000, noEffort: noEffort.scores[i], score: out.scores[i],
      ...(dv ? { activity: acts[i], T: Tarr[i], fam: famArr[i], noDivision: noDivision.scores[i] } : {}),
      ...(ex ? { q: expS[i].q, expFactor: expS[i].factor, tries: expS[i].n, planCost: Number.isFinite(valid[i].cost) ? Math.round(valid[i].cost * 100) / 100 : null, noExperience: noExperience.scores[i] } : {}) }));
    record.chosen = out.index; record.rule = out.rule;
    if (dv) { record.division.changed = noDivision.index !== out.index; record.division.noDivisionChoice = noDivision.index; } // 分業を入れなければ別の案だった
    record.effortChanged = noEffort.index !== out.index; // 手間で割らなければ別の案だった
    if (ex) { record.experience.changed = noExperience.index !== out.index; record.experience.noExperienceChoice = noExperience.index; } // 経験を入れなければ別の案だった
    record.decidedBy = !nowOnly ? 'later_only' : (laterOnly && nowOnly.index !== out.index ? 'later' : 'now');
    if (dv && record.division.changed) record.decidedBy = `${record.decidedBy}+division`;
    if (ex && record.experience.changed) record.decidedBy = `${record.decidedBy}+experience`;
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
    const resultText = { planted: '植えた (育っている頃に戻る。あとでやること)', done: '達成した', need_unmet: `手に入れた/着いたが、${NEED_LABEL[g.need] || ''}のつらさは変わらなかった`, stuck: `進まなかった (${why})`, unplannable: '作り方も手に入れ方も分からなくなった' }[result] || result;
    const h = { kind: g.kind, target: g.target, count: g.count, give: g.give, why: g.why, need: g.need, result, resultText, from: g.setAt, to: tick };
    this.history.push(h);
    if (this.experience) this.experience.noteResult({ ...h, why, gameFrom: g.gameAt ?? null, gameTo: this.lastAge });
    if (result === 'done') this.counts.done += 1;
    else if (result === 'need_unmet') this.counts.needUnmet += 1;
    else if (result === 'stuck') this.counts.stuck += 1;
    else if (result === 'planted') this.counts.planted = (this.counts.planted || 0) + 1;
    this.log({ ...h, kind: result === 'done' || result === 'planted' ? 'goal_done' : 'reselect', goalKind: g.kind, activity: goalActivity(g), place: g.place ? { type: g.place.type || null, kind: g.place.kind || null, laterKind: g.place.laterKind || null } : null, result, tick, reason: why || null, needAt: g.needAt ?? null, ...extra });
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
    if (ctx.raw && ctx.raw.self && Number.isFinite(ctx.raw.self.age)) this.lastAge = ctx.raw.self.age;
    this.troubleRun = troubles.length ? this.troubleRun + 1 : 0;
    if (!this.goal) {
      if (tick < this.retryAt) return null;
      await this.newGoal(ctx, tick, this.history.length ? 'after' : 'start');
      if (this.goal) this.refresh(ctx, tick);
      return 'goal';
    }
    await this.textCheck(ctx, tick);
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
    //   状態のゴールの道筋 (物の手順に畑・木を含む) でも同じ。道筋の次が「育つのを待つ」のまま止まらない (2026-11-07: wait を外した)
    if ((g.kind === 'item' || g.kind === 'state') && this.cfg.finishOnWait !== false && this.waitingGrowth()) {
      this.finish('planted', tick, null, { growing: this.path.next.growing, crop: this.path.next.crop || this.path.next.sapling });
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

module.exports = { kOf, chunkQuestions, goalSchemaFree, proposalsSchemaFree, waitOnly, WAIT_WHY, effortFactor, rankPeople, goalTextEn, statePathEn, proposalsSchema, selectScores, GoalPath, DEFAULTS, goalSchema, parseGoal, goalText, statePathText, KINDS, KIND_JA };
