'use strict';
// 1ボット = observe → decide → act → record のループ
//   decide は差し替えられる (llm / split / jev / random / scripted)。
//   jev のときは、行動を Jev が選び、発言は Talker (2B) が作る (Jev の Noul が閾値を超えたときだけ)。
//   社会性 (social.js)・忘れる記憶 (memory.js)・周りに聞く仕組み (ask.js) は、どの decider でも同じに動く。
const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const { collectRaw, summarizeObservation, notableMatcher, observationEn } = require('./observe');
const en = require('./en');
const { Order, agentSeed } = require('./order');
const { listActions, resolveDecision, fallbackDecision } = require('./actions');
const { executeAction } = require('./act');
const { Memory } = require('./memory');
const { Recorder } = require('./recorder');
const { progressText, stepStatus } = require('./progress');
const { Social } = require('./social');
const { senseShelter, effectiveLight, needsConfig } = require('./needs');
const { hutSlots, hutStatus } = require('./hut');
const ask = require('./ask');
const unstuck = require('./unstuck');
const nochange = require('./nochange');
const { SelfGoal } = require('./selfgoal');
const { GoalPlan } = require('./goalplan');
const { GoalPath } = require('./goalpath');
const { farmStatus } = require('./states');
const farmwater = require('./farmwater');
const { SharedExplore } = require('./explored');
const { PlayerCache, playerDistance, peopleOf } = require('./people');
const { replaceMRefs } = require('./places');
const scarcity = require('./scarcity');
const { OwnershipCtl } = require('./ownership_agent');
const ownership = require('./ownership');
const { ConflictCtl } = require('./conflict_agent');
const conflict = require('./conflict');

// 文の中の M 番号 → { M2: {x,y,z} } (places: placesForPrompt の一覧)。無ければ null
function mposOf(text, places) {
  const ids = String(text || '').match(/(?<![A-Za-z0-9_])M[0-9]{1,2}(?![0-9])/g);
  if (!ids || !places) return null;
  const out = {};
  for (const id of new Set(ids)) { const p = places.find((q) => q.id === id); if (p && p.pos) out[id] = { x: p.pos.x, y: p.pos.y, z: p.pos.z }; }
  return Object.keys(out).length ? out : null;
}
// [{ M2: pos }, ...] → [{ id, pos }] (同じ番号は先のものを使う)
function placesFromMpos(maps) {
  const out = [];
  for (const m of maps || []) for (const [id, pos] of Object.entries(m || {})) if (!out.some((q) => q.id === id)) out.push({ id, pos });
  return out;
}
const { Reflect } = require('./reflect');
const { llmOptsFor } = require('./llm_provider');
const { baseSite, baseSiteText, baseSiteTextEn } = require('./basesite');
const { isPlaceableBlockItem, Planner, effortWord, EFFORT_EN, SAPLING_LOG } = require('./planner');
const { OthersLog, DEFAULTS: OTHERS_DEFAULTS } = require('./others');
const knowledge = require('./knowledge');
const { Board, DEFAULTS: BOARD_DEFAULTS, parseLine, line: boardLine, chestLabelJa } = require('./board');
const { jaName, SUFFIX: JA_SUFFIX } = require('./names_ja');
const { Division, countsText, MUTTER_MARK } = require('./division');
const { ToolWant } = require('./toolwant');
const TF = require('./toolfacts');
const { Experience, expKey } = require('./experience');
const searchMod = require('./search');
const choiceWeight = require('./choice_weight');
const { sleep, dist3, relDir, timePhase } = require('./util');

const BASE_KIND = '拠点';
// noChange: 成功しても状態が変わらない繰り返しを困りごとにし、その行動に負の重みをつける (実験的。nochange.js)
const DEFAULT_HELP = { hints: true, steps: true, progress: true, askOthers: false, excludeFailures: true, noChange: false, askHint: true, hut: true, selfGoal: false, goalPlan: false, goalPath: false };

function helpOf(cfg) { return { ...DEFAULT_HELP, ...(cfg.help || {}) }; }
// cfg.act.collectExclude (ブロックの名前の配列) → RegExp | null
function collectExcludeOf(cfg) {
  const l = cfg.act && cfg.act.collectExclude;
  return Array.isArray(l) && l.length ? new RegExp(`^(${l.join('|')})$`) : null;
}
function noChangeCfg(cfg) { return { ...nochange.DEFAULTS, ...(cfg.noChange || {}) }; }
// 知っていること (knowledge/facts.json) の設定。cfg.knowledge が無ければ使わない (first_setting などは goal.hints のまま)
function knowledgeCfg(cfg) {
  if (!cfg.knowledge || cfg.knowledge.enabled === false) return null;
  return { ...knowledge.DEFAULTS, ...cfg.knowledge };
}
function loadKnowledge(cfg) {
  const k = knowledgeCfg(cfg);
  return k ? { facts: knowledge.loadFacts(k.file || knowledge.DEFAULT_FILE), max: k.max, stage2Max: k.stage2Max } : null;
}

// 知っていることを選ぶ材料: 道筋・ゴールの文の名前 (strong) と今の状況 (夜・敵・空腹・死んだばかり など。facts.json の when)
//   ahead: 先のつらさ (anticipate.js) から { harmed (夜に死んだ/襲われた/傷を受けた), anxious (先の不安がしきい値以上), killers (夜に自分を殺したもの) }
//     夜が近いか夜のあいだは、覚えている killers の名前も names に足す (mob_* の事実が当たる)
function factsOpts(raw, memory, planText = '', extraNames = null, ahead = null) {
  const strong = knowledge.namesInText(planText);
  for (const n of extraNames || []) strong.add(n);
  const died = [...(memory.events || [])].reverse().find((e) => e.action === 'death');
  const situations = knowledge.situations(raw, { tick: memory.tick, diedAt: died ? died.t : null, nightHarm: !!(ahead && ahead.harmed), anxiousNight: !!(ahead && ahead.anxious) });
  const extra = ahead && (situations.has('night') || situations.has('night_soon')) ? (ahead.killers || []) : [];
  return { strong, situations, extraNames: extra };
}

// 先のつらさから、知っていることを選ぶ材料 (factsOpts の ahead)
function aheadOf(needsModel) {
  const a = needsModel && needsModel.ant;
  if (!a) return null;
  return { harmed: a.harmed(), anxious: a.v.night >= a.cfg.night.threshold, killers: a.killers().filter((k) => !['unknown', 'water', 'fall', 'lava', 'hunger'].includes(k)) };
}

// Jev の英語の state に入れる数 (cfg.decider.jev.state で上書き)
const JEV_STATE_DEFAULTS = { maxVisible: 8, maxNearby: 6, maxPlaces: 4, maxEvents: 5, maxHeard: 3, maxTaught: 2 };

function jevStateCfg(cfg) { return { ...JEV_STATE_DEFAULTS, ...((cfg.decider && cfg.decider.jev && cfg.decider.jev.state) || {}) }; }
// 英語の観察。見えるブロックは目印と、道筋・ゴールの文 (planText) に出てくる名前だけ
function obsEn(raw, cfg, planText, bedPlaced = false) {
  const js = jevStateCfg(cfg);
  return observationEn(raw, { names: knowledge.namesInText(planText), maxVisible: js.maxVisible, maxNearby: js.maxNearby, showDay: cfg.perception.showDay, bedPlaced });
}

// use_on の畑の対象: 近くの空いている耕地・育ちきった作物 (farm = states.farmStatus) と、覚えている耕地・作物の場所 (cfg.act.farmRadius m 以内)
const FARM_PLACE = /^(farmland|wheat|carrots|potatoes|beetroots)$/;
// 覚えている場所の一覧 (M 番号) に必ず1つ入れる種類 (耕す行き先 farmland_spot@M・道筋の水の段に使う)
const PLACE_ENSURE = ['water'];
function farmTargets(raw, memPlaces, farm, cfg) {
  const out = [];
  if (farm) {
    if (farm.emptyPos && farm.emptyPos.length) out.push({ name: 'farmland', idName: 'farmland@empty', pos: farm.emptyPos[0], note: `空いている。近くの空いている耕地 ${farm.empty}`, noteEn: `empty; ${farm.empty} empty farmland nearby`, emptyCount: farm.empty });
    for (const [crop, ps] of Object.entries(farm.cropPos || {})) {
      const r = ps.find((q) => q.ripe);
      if (r) out.push({ name: crop, idName: `${crop}@ripe`, pos: r, note: '育ちきった', noteEn: 'fully grown' });
    }
  }
  const far = (cfg.act && cfg.act.farmRadius) ?? 48;
  for (const p of memPlaces || []) {
    if (!FARM_PLACE.test(p.kind) || p.d > far || p.d < 4 || p.unreachable) continue;
    out.push({ name: p.kind, idName: `${p.kind}@${p.id}`, pos: p.pos, note: `覚えている所 ${p.id}`, noteEn: `remembered place ${p.id}` });
  }
  // 耕す行き先: 見えている、水から4マス以内 (同じ高さか1つ上) の耕せるマス (farm.till = farmwater.tillSpots。無ければ見えているブロックから)
  const spots = farm && Array.isArray(farm.till) ? farm.till : farmwater.tillSpotsFromRaw(raw);
  if (spots.length) {
    const s0 = spots[0];
    const tc = farm && Number.isFinite(farm.tillCount) ? farm.tillCount : null;
    out.push({ name: farmwater.SPOT, idName: farmwater.SPOT, pos: { x: s0.x, y: s0.y, z: s0.z }, note: `水から4マス以内の${s0.name}${tc ? `。近くの耕せるマス ${tc}` : ''}`, noteEn: `${s0.name} within 4 blocks of water${tc ? `; ${tc} tillable blocks nearby` : ''}`,
      tillCount: tc, emptyCount: farm ? farm.empty || 0 : 0 });
  }
  // 覚えている・聞いた水場の近く (着いてから、水から4マス以内の耕せるマスを探す)。見えている水場の近くに耕せる所があるときは出さない
  const waterFar = (cfg.act && cfg.act.waterRadius) ?? 96;
  for (const p of (memPlaces || []).filter((q) => q.kind === 'water' && q.pos && !q.unreachable && q.d <= waterFar && (!spots.length || q.d > 16)).slice(0, (cfg.act && cfg.act.waterSpots) ?? 2)) {
    out.push({ name: farmwater.SPOT, idName: `${farmwater.SPOT}@${p.id}`, pos: p.pos, note: `${p.from ? `${p.from}が言っていた` : '覚えている'}水場 ${p.id} の近く`, noteEn: `near the ${p.from ? `water ${p.from} told of` : 'remembered water'} ${p.id}` });
  }
  return out;
}

// 知っていることを選ぶ名前に、覚えている耕地・作物の場所と、近くの畑を足す (種を持つ人・耕地を知る人に畑の事実が出るように)
function farmNames(names, memPlaces, farm) {
  for (const p of memPlaces || []) if (FARM_PLACE.test(p.kind)) names.add(p.kind);
  if (farm && farm.farmland > 0) names.add('farmland');
  for (const c of Object.keys((farm && farm.cropPos) || {})) names.add(c);
  return names;
}

// 観測と記憶から、decider に渡す材料を作る (bot に依存しない)
function buildContext(raw, memory, cfg, extra = {}) {
  const help = helpOf(cfg);
  const here = raw.self.pos;
  const visibleNotable = new Set(raw.blocks.filter((b) => b.notable).map((b) => b.name));
  const memPlaces = memory.placesForPrompt(here, visibleNotable, { ensure: PLACE_ENSURE });
  // ④ 失敗の除外 (段階1)。first_setting では外し、代わりに「聞く」を使う
  const blocked = help.excludeFailures ? memory.recentFailures(cfg.loop.failWindow ?? 4, cfg.loop.failRepeat ?? 2) : new Set();
  const nc = help.noChange ? noChangeCfg(cfg) : null;
  const troubles = extra.troubles || (help.askOthers ? ask.troubles(memory, cfg.loop.failWindow ?? 4, cfg.loop.failRepeat ?? 2, nc) : []);
  const actions = listActions(raw, {
    memPlaces, foods: extra.foods, placeable: extra.placeable, blocked, maxReachUp: cfg.act.maxReachUp,
    goalItems: new Set(Object.keys((cfg.goal.success && cfg.goal.success.inventory) || {})),
    base: extra.base || null, hut: raw.hut || null, troubles, hearRadius: cfg.perception.hearRadius, peopleRadius: cfg.perception.peopleRadius ?? cfg.perception.hearRadius,
    disabled: new Set((cfg.act && cfg.act.disabled) || []), enable: new Set((cfg.act && cfg.act.enable) || []),
    selfBase: !!(cfg.world && cfg.world.base === 'self'), fleeRadius: cfg.act.fleeRadius,
    // 入れ物の中身・村人の取引 (開けて見たときに覚えたもの。act_more.js)。use_on などの候補の絞り方 (cfg.act)
    containers: (memory.extra && memory.extra.containers) || {}, lastContainer: (memory.extra && memory.extra.lastContainer) || null, trades: (memory.extra && memory.extra.trades) || {},
    collectExclude: collectExcludeOf(cfg),
    useOnSkip: cfg.act.useOnPlaceable === false ? (n) => isPlaceableBlockItem(n, (cfg.server && cfg.server.version) || undefined) : null,
    visionRadius: cfg.perception.visionRadius, followMs: cfg.act.followMs, useRadius: cfg.act.useRadius, maxUseChoices: cfg.act.maxUseChoices, maxGiveChoices: cfg.act.maxGiveChoices,
    explore: { ...((cfg.act && cfg.act.explore) || {}), distance: cfg.act.exploreDistance ?? 20, cells: memory.cells, cellSize: memory.limits.exploreCell, tick: memory.tick,
      allCells: extra.allCells || null, others: extra.others || null, base: extra.base || null, othersCells: extra.othersCells || null },
    board: extra.boardActs || null,
    farmTargets: farmTargets(raw, memPlaces, extra.farm || null, cfg),
    own: extra.own || null, // 所有を考えた行動 (cfg.provenance.actions。ownership_agent.js の view)
    conflict: extra.conflict || null, // わだかまりのある相手への行動 (cfg.conflict.actions。conflict_agent.js の view)
  });
  const steps = help.steps ? cfg.goal.steps : null;
  let prog = '';
  if (steps) prog = help.progress ? progressText(steps, raw) : steps.map((s, i) => `(${i + 1})${s.text}`).join(' ');
  if (help.selfGoal || help.goalPlan || help.goalPath) prog = extra.planText || ''; // 自分で決めた目標と段取り (selfgoal.js) / ゴールと今の手順 (goalplan.js)
  // 知っていること: goal.hints (残っているもの) + facts.json のうち今に関係するもの (持ち物・見えている物・選択肢の対象・plan の名前)
  const kn = help.hints ? (extra.knowledge !== undefined ? extra.knowledge : loadKnowledge(cfg)) : null;
  let factsShown = [];
  if (kn && kn.facts.length) {
    const hints = new Set(cfg.goal.hints || []);
    factsShown = knowledge.selectFacts(kn.facts, { ...factsOpts(raw, memory, prog, extra.factsNames, extra.ahead || null), names: farmNames(knowledge.namesInView({ raw, actions, plan: prog }), memPlaces, extra.farm), max: kn.max, exclude: hints });
  }
  const goal = help.hints ? { ...cfg.goal, hints: [...(cfg.goal.hints || []), ...factsShown.map((f) => f.text)] } : { ...cfg.goal, hints: [] };
  // Jev 用の英語 (同じ raw・記憶・事実から。jev の stateLang: 'en' のときに使う)。件数は cfg.decider.jev.state で絞る
  const js = jevStateCfg(cfg);
  // 自分で置いたベッドがあるか (act.js の place が覚える)。無ければ、持っているベッドを観察に「まだ置いていない」と出す
  const bedPlaced = !!(memory.extra && memory.extra.myBed);
  const enCtx = {
    obs: obsEn(raw, cfg, prog, bedPlaced),
    mem: memory.toStateEn(here, { places: memPlaces, maxPlaces: js.maxPlaces, maxEvents: js.maxEvents, maxHeard: js.maxHeard, maxTaught: js.maxTaught }),
    social: extra.socialEn || '',
    lastResult: extra.lastResultEn || '',
    base: extra.baseEn || '',
    hints: help.hints ? [...(cfg.goal.hints_en || cfg.goal.hints || []), ...factsShown.map((f) => knowledge.factText(f, 'en'))] : [],
    plan: extra.planEn || null,
    board: extra.boardEn || null, // 全体チャット・取り決め・共同の目標・共有のチェスト・賛成を聞く提案 (board.js)
  };
  // 正味の変化で見た繰り返し (agent が extra.net で渡す) の回数を、1回ごとの penalties に合わせる
  const pens = nc ? nochange.mergePenalties(nochange.penalties(memory.events, nc.weightWindow), extra.net ? extra.net.counts : null) : null;
  return {
    persona: cfg.persona,
    goal,
    showHints: help.hints,
    askHint: help.askHint,
    selfGoal: !!help.selfGoal && !help.goalPlan,
    goalPlan: !!help.goalPlan && !help.goalPath,
    goalPath: !!help.goalPath,
    raw,
    actions,
    troubles,
    progress: prog,
    obsText: summarizeObservation(raw, { maxTypes: cfg.perception.maxTypes, showDay: cfg.perception.showDay, bedPlaced }) + (extra.baseText ? `\n${extra.baseText}` : ''),
    memText: memory.toPromptText(here, { places: memPlaces }),
    socialText: extra.socialText || '',
    boardText: extra.boardText || '',
    lastResult: extra.lastResult || '',
    noChange: nc ? { penalties: pens, weight: nc.weight } : null,
    knowledge: kn,
    factsShown: factsShown.map((f) => f.id),
    en: enCtx,
    order: extra.order || null,
    pathNext: extra.pathNext,
  };
}

// 観測から記憶を更新する (見た目印・行った場所・聞いた話)
function updateMemoryFromObservation(memory, raw) {
  for (const b of raw.blocks) if (b.notable) memory.notePlace(b.name, b.nearest);
  memory.noteVisit(raw.self.pos);
  memory.noteCell(raw.self.pos);
  // 返り値: 近くの声から覚えた場所 [{ from, text, places }] (heard_place の記録用)
  const learned = [];
  for (const h of raw.heard) {
    const e = memory.noteHeard(h.from, h.text);
    if (e && e.places && e.places.length) learned.push({ from: h.from, text: h.text, places: e.places, d: h.d ?? null });
  }
  return learned;
}

// 近くの人の数 (8m・16m・48m 以内。集まりの集計に使う)
function nearCounts(raw) {
  const ds = peopleOf(raw).map((p) => p.d).filter((d) => Number.isFinite(d));
  return { n8: ds.filter((d) => d <= 8).length, n16: ds.filter((d) => d <= 16).length, n48: ds.filter((d) => d <= 48).length };
}

function goalMet(goal, inventory, raw = null) {
  const s = goal && goal.success;
  if (!s) return false;
  const conds = [];
  if (s.inventory) conds.push(Object.entries(s.inventory).every(([name, n]) => inventory.filter((i) => i.name === name).reduce((t, i) => t + i.count, 0) >= n));
  if (s.hut != null) conds.push(!!(raw && raw.hut && raw.hut.ratio != null && raw.hut.ratio >= s.hut));
  if (s.food != null) conds.push(!!raw && (raw.foodCount || 0) >= s.food);
  return conds.length > 0 && conds.every(Boolean);
}

// 相手ごとの好感 (50 = 初期値から動いたものだけ。summarize_run の関係の行列に使う)
function affinityOf(social) {
  const out = {};
  for (const [n, r] of Object.entries(social.relations || {})) if (r && Number.isFinite(r.affinity) && Math.round(r.affinity) !== 50) out[n] = Math.round(r.affinity);
  return out;
}

class Agent {
  constructor(cfg, { decider, log = console.log, meter = null, talker = null, recordDir = null, recordStamp = null } = {}) {
    this.cfg = cfg;
    this.decider = decider;
    this.log = log;
    this.meter = meter;
    this.talker = talker;
    this.help = helpOf(cfg);
    this.memory = Memory.load(cfg.memory.file, { limits: cfg.memory.limits });
    this.social = Social.fromJSON(this.memory.extra.social, { temperament: cfg.persona.temperament, needs: needsConfig(cfg, cfg.persona), affinity: (cfg.social && cfg.social.affinity) || {} });
    // 分業 (division.js): 慣れ・集団の必要 (刺激)・反応しきい値。cfg.division.enabled: true で使う
    this.division = cfg.division && cfg.division.enabled
      ? Division.fromJSON(this.memory.extra.division, { cfg: cfg.division, temperament: cfg.persona.temperament || {}, drives: (needsConfig(cfg, cfg.persona).drives) || {}, me: cfg.persona.name })
      : null;
    this.divisionExpAt = this.division ? this.division.copyExp() : null; // 前の振り返りのときの回数
    // 使う側の不満と声 (toolwant.js): 道具のやりにくさ・独り言・頼みごと。cfg.toolWant.enabled: true で使う。persona.toolVoice.mutter で独り言の多さを直接
    this.toolWant = cfg.toolWant && cfg.toolWant.enabled
      ? ToolWant.fromJSON(this.memory.extra.toolWant, { cfg: cfg.toolWant, temperament: cfg.persona.temperament || {}, me: cfg.persona.name, mutter: cfg.persona.toolVoice ? cfg.persona.toolVoice.mutter : null })
      : null;
    this.voicing = false;
    this.toolDown = {}; // 壊れて今は無い道具の種類 → { tool, tick, t }
    this.lastBreak = { tool: null, t: 0 };
    // 経験 (experience.js): ゴールの対象ごとの試した・達成した・かかった時間。help.goalPath のとき (cfg.experience.enabled: false で使わない)
    this.experience = this.help.goalPath && !(cfg.experience && cfg.experience.enabled === false)
      ? Experience.fromJSON(this.memory.extra.experience, { cfg: cfg.experience || {} }) : null;
    this.recorder = new Recorder(recordDir || cfg.record.dir, cfg.persona.name, recordStamp);
    this.heardBuf = [];
    // 探しながら歩く (search.js) と、選択肢の重み (choice_weight.js)。cfg.act.search / cfg.choiceWeights
    this.searchCfg = searchMod.cfgOf(cfg.act && cfg.act.search);
    this.cwCfg = choiceWeight.cfgOf(cfg.choiceWeights);
    this.searchState = null; // 割り込みで区切った search の続き { dir, target, what, tick, awaiting, interrupt }
    this.peopleSeenAt = {}; // 名前 → 最後に近くにいたループ (search の「しばらく見ていなかった人」)
    this.calledBy = {}; // 名前 → 自分の名前を呼んだ・頼んだループ (選択肢の重みで、その人の所へ行くのは下げない)
    // 近くの人の位置 (people.js)。entity が一時的に無いときに最後の位置を staleMs まで使う。onChat の距離・raw.people に使う
    this.playerCache = new PlayerCache({ staleMs: (cfg.perception && cfg.perception.positionStaleMs) ?? 15000 });
    this.chatCount = { heard: 0, far: 0, unknown: 0, cache: 0 }; // 近くの声: 拾った・遠くて捨てた・位置が分からず捨てた・最後の位置で判定した (判断ごとに記録して0に戻す)
    this.stopped = false;
    this.lastChat = { t: 0, text: '' };
    this.isNotable = notableMatcher(cfg.perception.notable || undefined);
    this.placeableRes = (cfg.placeable || []).map((p) => new RegExp(p.includes('$') || p.includes('^') ? p : `^${p}$`));
    this.base = null;
    this.pendingAsk = null; // 自分が聞いて答えを待っているもの
    this.askedAt = {}; // 困りごと (key) → 最後に聞いたループ (同じことを続けて聞かない)
    this.questionQueue = []; // 自分が聞かれたもの
    this.answering = false;
    this.talking = false;
    this.pendingUse = []; // 教わった答えを使ったかを見張るもの
    this.lastResult = '';
    this.lastResultEn = '';
    // 選択肢の並べ方 (order.js)。cfg.order = { shuffle, seed }。人ごとの種は実行の種と名前から
    const oc = cfg.order || {};
    this.runSeed = oc.seed != null ? Number(oc.seed) >>> 0 : null;
    this.order = new Order({ enabled: oc.shuffle === true, seed: agentSeed(this.runSeed ?? 0, cfg.persona.name) });
    this.goalAt = null;
    this.selfGoal = this.help.selfGoal
      ? new SelfGoal({ cfg: cfg.selfGoal || {}, llmOpts: llmOptsFor(cfg, 'goal', (cfg.selfGoal && cfg.selfGoal.llm) || {}), meter })
      : null;
    this.lastGoalDoneP = null;
    // 踏破したマスを runs/<id>/explored/ に書き出す (cfg.act.explore.shared。explored.js)。読んで判断に使うのは scope: 'all' のときだけ (exploreShare。既定 self)
    const exc = (cfg.act && cfg.act.explore) || {};
    this.sharedExplore = exc.shared && recordDir ? new SharedExplore({ dir: require('path').join(recordDir, 'explored'), name: cfg.persona.name, writeEvery: exc.shareEvery ?? 5, readEvery: exc.shareEvery ?? 5 }) : null;
    this.deaths = [];
    // 動けない状態の見張りと回復 (cfg.unstuck。unstuck.js)
    this.unstuckCfg = { ...unstuck.UNSTUCK_DEFAULTS, ...(cfg.unstuck || {}) };
    this.stuck = new unstuck.StuckWatch(this.unstuckCfg);
    this.reconnects = 0;
    this.lastDeathMsg = null;
    this.knowledge = loadKnowledge(cfg);
    this.loopHist = []; // 行動の後の状態の履歴 (nochange.netNoChange 用。netWindow + 1 件)
    // ほかの人が拾った・壊したこと (others.js)。cfg.others.enabled: false で使わない
    this.othersCfg = { ...OTHERS_DEFAULTS, radius: cfg.perception.visionRadius ?? OTHERS_DEFAULTS.radius, ...(cfg.others || {}) };
    this.others = this.othersCfg.enabled === false ? null : new OthersLog(this.othersCfg);
    // ゴール → 逆向きの手順 → 1段ずつ (help.goalPlan。goalplan.js)
    this.goalPlan = this.help.goalPlan
      ? new GoalPlan({ cfg: cfg.goalPlan || {}, llmOpts: llmOptsFor(cfg, 'goal', (cfg.goalPlan && cfg.goalPlan.llm) || {}), meter,
        jev: decider && decider.kind === 'jev' ? decider : null, log: (e) => this.recorder.write({ event: 'goal_plan', ...e }) })
      : null;
    // ゴール (2B) → 道筋 (planner) → 行動 (Jev) (help.goalPath。goalpath.js)。goalPlan より先に見る
    if (this.help.goalPath) {
      this.goalPlan = null;
      this.goalPath = new GoalPath({ cfg: cfg.goalPath || {}, llmOpts: llmOptsFor(cfg, 'goal', (cfg.goalPath && cfg.goalPath.llm) || {}), meter,
        jev: decider && decider.kind === 'jev' ? decider : null, order: this.order, experience: this.experience,
        log: (e) => { this.recorder.write({ event: 'goal_path', ...e }); if (this.reflect) this.reflect.noteGoal(e); if (this.division) this.division.noteGoal(e); } });
    } else this.goalPath = null;
    // 振り返りと方針 (cfg.reflect。reflect.js)。ゴール (help.goalPath) と一緒に使う
    this.reflect = cfg.reflect && cfg.reflect.enabled !== false && this.goalPath
      ? new Reflect({ cfg: cfg.reflect, llmOpts: llmOptsFor(cfg, 'reflect', (cfg.reflect && cfg.reflect.llm) || {}), meter, log: (e) => this.recorder.write({ event: 'reflect', ...e }) })
      : null;
    this.homeSpot = null; // 拠点が無いとき: 最後にベッドかチェストを置いた所
    this.baseSeen = null; // 最後に見た拠点の様子 { site, tick }
    this.lastBaseText = null;
    this.lastGave = [];
    // 全体チャット・提案・取り決め・共有のチェスト・共同の目標 (cfg.board。board.js)。サーバーの全体チャットで全員に届く
    this.boardCfg = { ...BOARD_DEFAULTS, ...(cfg.board || {}) };
    this.board = this.boardCfg.enabled ? new Board({ cfg: this.boardCfg, me: cfg.persona.name }) : null;
    this.boardAsked = new Set(); // 賛成するかを聞いた提案
    this.boardSeen = new Set(); // state に出した全体チャット (記憶に入れたもの)
    this.boardView = null;
    this.lastProposeTick = -1e9;
    // 設置物の来歴 (台帳。ground truth) と所有の知識・取得の理由・社会的な結果 (cfg.provenance。ownership_agent.js)
    this.own = new OwnershipCtl(this, { recordDir });
    // わだかまりと、悪い関係のときの行動 (cfg.conflict。conflict_agent.js)
    this.conflict = new ConflictCtl(this);
  }

  // 踏破の共有 (explored.js)。書き出し (runs/<id>/explored/) は分析のためにいつもする (shared のとき)。
  //   読む (ほかの人の踏破・今いる所を判断に使う) のは scope: 'all' のときだけ。既定の scope: 'self' では読まない
  //   (2026-11-06 ユーザー決定: 場所の共有は【発見】・近くの声・聞いて答える の会話だけで起きるようにする)。
  //   人の少ない方 (explore の few_people) は、self では近くの人 (raw.people: 距離だけで分かる peopleRadius 以内の人) で数える
  exploreShare(tick, raw) {
    const exc = (this.cfg.act && this.cfg.act.explore) || {};
    const readOthers = exc.scope === 'all';
    if (this.sharedExplore) this.sharedExplore.publish(tick, this.memory.cells, raw.self.pos);
    if (this.sharedExplore && readOthers) {
      this.sharedExplore.load(tick);
      return { allCells: this.sharedExplore.merge(this.memory.cells), others: this.sharedExplore.positions() };
    }
    const near = peopleOf(raw).map((p) => ({ name: p.name, pos: p.pos }));
    return { allCells: null, others: near.length ? near : null };
  }

  // ---- 全体チャット (board.js) ----
  // 生きている (つながっている) 人の数: 実行の名簿 (run.js が cfg.roster に入れる) のうち、サーバーにいる人。名簿が無ければサーバーの人数
  aliveCount() {
    const players = this.bot && this.bot.players ? Object.keys(this.bot.players) : [];
    const roster = this.cfg.roster || [];
    const n = roster.length ? roster.filter((x) => players.includes(x)).length : players.length;
    return Math.max(1, n);
  }

  // 印のある行を全体チャットに送り、自分の板にも積む (サーバーは自分の発言も返すが、onChat は自分の行を捨てる)
  sendBoard(text) {
    const t = String(text).replace(/\s+/g, ' ').trim().slice(0, 240);
    if (!t || !this.bot) return null;
    try { this.bot.chat(t); } catch (e) { this.log(`[${this.cfg.persona.name}] board chat error: ${e.message}`); return null; }
    const m = parseLine(t);
    if (m) this.onBoardLine(this.cfg.persona.name, m);
    return m;
  }

  // 受け取った印のある行 (自分の行も)。起きたことを記録・記憶に入れる
  onBoardLine(from, m) {
    if (!this.board) return;
    const me = this.cfg.persona.name;
    const tick = this.memory.tick;
    const evs = this.board.receive(from, m, { t: Date.now(), tick });
    // 【発見】の行は、state に出るかに関係なく、文の中の場所を覚える (聞いた場所。go_to の候補)
    if (m.find && from !== me) {
      const got = this.memory.learnPlaces(from, m.text);
      if (got.length) this.recorder.write({ event: 'heard_place', via: 'board', from, to: me, text: m.text, places: got, loop: tick });
    }
    for (const ev of evs) {
      if (ev.type === 'agreed') {
        const p = ev.p;
        this.recorder.write({ event: 'board', kind: 'agreed', id: p.id, by: p.by, text: p.text, spec: p.spec, yes: [...p.yes], no: [...p.no], n: p.n, need: this.board.need(p), loop: tick });
        // 全員の記憶に残す (時間とともに薄れる)。state の agreements / projects には成立している間ずっと出る
        this.memory.noteHeard(p.by, `(${p.spec.type === 'project' ? '共同の目標' : '取り決め'}になった) ${p.text}`, 0.9, { global: true, at: this.phaseSafe() });
      } else if (ev.type === 'share') {
        this.memory.notePlace(chestLabelJa(ev.c.id), ev.c.pos, { imp: 1 });
        this.own.onShare(ev.c.pos, ev.c.by);
        this.recorder.write({ event: 'board', kind: 'share', chest: ev.c.id, by: ev.c.by, pos: ev.c.pos, loop: tick });
      } else if (ev.type === 'chest') {
        // 共有のチェストの中身は全員に見えている事実: chest_take の候補 (入れ物の記憶) も同じ中身にする
        const ex = this.memory.extra || (this.memory.extra = {});
        ex.containers = ex.containers || {};
        ex.containers[`${ev.c.pos.x},${ev.c.pos.y},${ev.c.pos.z}`] = { name: 'chest', items: ev.c.items, tick, shared: ev.c.id };
        if (from !== me && ev.delta) this.recorder.write({ event: 'board', kind: 'chest_seen', chest: ev.c.id, who: ev.who, delta: ev.delta, loop: tick });
      } else if (ev.type === 'breach') {
        this.recorder.write({ event: 'board', kind: 'breach_known', agreement: ev.p.id, who: ev.b.who, chest: ev.b.chest, item: ev.b.item, n: ev.b.n, loop: tick });
        if (ev.b.who !== me) this.conflict.onBreach(ev.b.who, ev.p.id);
      } else if (ev.type === 'project_done') {
        this.recorder.write({ event: 'board', kind: 'project_done', id: ev.p.id, item: ev.p.spec.item, count: ev.p.spec.count, loop: tick });
      } else if (ev.type === 'vote' && from !== me && ev.p.by === me) {
        this.recorder.write({ event: 'board', kind: 'vote_seen', id: ev.p.id, from, yes: ev.yes, loop: tick });
      }
    }
  }

  phaseSafe() { try { return this.phaseNow(); } catch (_) { return ''; } }

  // 全体チャットの優先に使う名前: 自分のゴールと道筋に出てくる物 (英語の名前・日本語の名前・種類の言葉)
  boardNames() {
    const names = new Set();
    const g = this.goalPath && this.goalPath.goal;
    const add = (n) => {
      if (!n || typeof n !== 'string') return;
      names.add(n);
      const ja = jaName(n);
      if (ja) names.add(ja);
      for (const [suf, w] of JA_SUFFIX || []) if (n.endsWith(suf)) names.add(w);
    };
    if (g) { add(g.target); if (g.give) add(g.give); if (g.state && g.state.item) add(g.state.item); if (g.state && g.state.animal) add(g.state.animal); }
    const p = this.goalPath && this.goalPath.path;
    for (const st of (p && p.steps) || []) { add(st.item); add(st.from); add(st.animal); }
    return [...names];
  }

  // 関係の強さ 0〜1 (好感の 50 からの離れ具合と話した回数)
  relStrength(name) {
    const r = this.social.relations[name];
    if (!r) return 0;
    return Math.min(0.99, Math.abs((r.affinity ?? 50) - 50) / 50 + Math.min(0.3, (r.talks || 0) * 0.03));
  }

  // 判断の前: 期限切れの提案を閉じ、state に出す全体チャット・取り決め・共有のチェスト・賛成を聞く提案を作る
  prepareBoard(raw) {
    if (!this.board) return null;
    const me = this.cfg.persona.name;
    const tick = this.memory.tick;
    for (const p of this.board.expire(Date.now())) this.recorder.write({ event: 'board', kind: 'expired', id: p.id, by: p.by, yes: p.yes.size, no: p.no.size, need: this.board.need(p), loop: tick });
    const here = raw.self.pos;
    // 近くの共有のチェストは場所の記憶を新しくする
    for (const c of this.board.chests.values()) if (dist3(here, c.pos) <= (this.cfg.perception.visionRadius ?? 16)) this.memory.notePlace(chestLabelJa(c.id), c.pos, { imp: 1 });
    const shown = this.board.select({ me, tick, names: this.boardNames(), strength: (n) => this.relStrength(n) });
    for (const m of shown) {
      if (this.boardSeen.has(m.seq)) continue;
      this.boardSeen.add(m.seq);
      // 聞いた内容は記憶に「Taro は〜と言っていた (いつ)」の形で残り、時間とともに薄れる (memory.js)
      this.memory.noteHeard(m.from, m.text, 0.3, { global: true, at: this.phaseSafe() });
      if (this.division) this.division.noteHeard(m.from, m.text, tick, { form: 'all' });
      if (this.experience) this.experience.noteHeard(m.from, m.text, tick, me);
      this.recorder.write({ event: 'board', kind: 'seen', from: m.from, to: me, msgKind: m.kind, pid: m.pid || null, text: m.text, why: m.why, hit: m.hit, loop: tick });
    }
    const open = this.board.openFor(me, this.boardAsked);
    const en0 = this.board.stateEn({ me, tick, here, shown, open, relationEn: (n) => this.social.relationWord(n, { lang: 'en' }), effortEn: (item, count) => this.effortEnOf(raw, item, count) });
    const text = this.board.textJa({ tick, here, shown, relDir });
    // ゴール候補: 取り決め (物 → 共有のチェスト) と共同の目標 (その物と材料 → いちばん近い共有のチェスト) への貢献
    const chests = [...this.board.chests.values()].map((c) => ({ id: c.id, items: c.items, known: c.known, pos: c.pos }));
    const shared = [];
    for (const p of this.board.agreedRules()) shared.push({ chest: p.spec.chest, item: p.spec.item, add: this.boardCfg.ruleAdd ?? 4, note: `取り決め「${p.text}」`, noteEn: `agreement「${p.text}」` });
    const nearest = chests.slice().sort((a, b) => dist3(here, a.pos) - dist3(here, b.pos))[0];
    if (nearest) {
      for (const p of this.board.agreedProjects().filter((x) => x.status === 'agreed')) {
        const left = Math.max(1, p.spec.count - this.board.progress(p));
        shared.push({ chest: nearest.id, item: p.spec.item, add: left, note: `共同の目標 ${p.spec.item} ${p.spec.count} (${p.by}の提案)`, noteEn: `for the project ${p.spec.item} x${p.spec.count}` });
        for (const [ing, k] of this.projectIngredients(p.spec.item)) shared.push({ chest: nearest.id, item: ing, add: k * left, note: `共同の目標 ${p.spec.item} ${p.spec.count} の材料`, noteEn: `an ingredient of the project ${p.spec.item} x${p.spec.count}` });
      }
    }
    this.boardView = { shown, open, openMap: en0.openMap, text, chests, shared };
    const sharedKeys = new Set(chests.map((c) => `${c.pos.x},${c.pos.y},${c.pos.z}`));
    return {
      en: { state: en0.state, open: en0.open, breakers: en0.breakers },
      text,
      goal: { chests, shared, text },
      acts: { canShare: this.board.chests.size < this.boardCfg.maxShared, isShared: (pos) => !!this.board.chestAt(pos) || sharedKeys.has(`${pos.x},${pos.y},${pos.z}`),
        proposedRecently: this.memory.tick - this.lastProposeTick < (this.boardCfg.proposeGap ?? 5) },
    };
  }

  // 共同の目標の物の材料 (レシピの最初の形。多い順に2つまで)
  projectIngredients(item) {
    try {
      const { index } = require('./planner');
      const r = (index(this.cfg.server && this.cfg.server.version ? this.cfg.server.version : undefined).recipes.get(item) || [])[0];
      return r ? Object.entries(r.ings).sort((a, b) => b[1] - a[1]).slice(0, 2) : [];
    } catch (_) { return []; }
  }

  // talker に渡す材料 (近くの声の talk と同じ + 全体の話)
  talkCtx(ctx, plannedText = '') {
    const players = peopleOf(ctx.raw);
    return {
      persona: this.cfg.persona, goal: ctx.goal, plan: ctx.progress || '', socialText: ctx.socialText,
      nearText: players.map((e) => `${e.name} ${relDir(ctx.raw.self.pos, e.pos)}`).join(', '),
      heardText: ctx.raw.heard.map((h) => `${h.from}「${h.text}」`).join(' '),
      memText: ctx.memText, plannedAction: plannedText, boardText: ctx.boardText || '',
    };
  }

  async doBroadcast(ctx) {
    if (!this.talker || !this.board) return { ok: false, msg: '全体に言う仕組みがない' };
    const r = await this.talker.broadcast(this.talkCtx(ctx));
    const say = r.say ? this.refPlaces(r.say.replace(/\s+/g, ' ').trim(), { via: 'board' }).slice(0, this.boardCfg.textMax) : '';
    this.recorder.write({ event: 'board', kind: 'broadcast', loop: this.memory.tick, say: say || null, rawOutput: r.rawOutput, promptChars: r.promptChars, promptTokens: r.promptTokens, ms: r.ms, error: r.error });
    if (!say) return { ok: false, msg: '全体に言うことが出てこなかった' };
    this.sendBoard(boardLine.say(say));
    this.memory.noteHeard('自分', say, 0.1, { global: true });
    this.social.onSpoke(this.memory.tick);
    this.log(`[${this.cfg.persona.name}] 全体に「${say}」`);
    return { ok: true, msg: `全員に「${say}」と言った`, said: say };
  }

  // 見つけた物と場所を全員に (【発見】)。2B に見せるのは、見えている目印・生き物と覚えている場所の、自分からの方角と共通の呼び方 (事実だけ)
  async doReportFind(ctx) {
    if (!this.talker || !this.board) return { ok: false, msg: '全体に知らせる仕組みがない' };
    const raw = ctx.raw;
    const here = raw.self.pos;
    const ref = (p) => this.memory.commonRef(p);
    const seen = [];
    for (const b of raw.blocks.filter((x) => x.notable).slice(0, 6)) seen.push(`${b.name}: ${relDir(here, b.nearest)}${ref(b.nearest) ? `・${ref(b.nearest)}` : ''}`);
    const mobs = new Map();
    for (const e of raw.entities) if (e.kind !== 'player' && e.kind !== 'item' && !mobs.has(e.name)) mobs.set(e.name, e);
    for (const e of [...mobs.values()].slice(0, 4)) seen.push(`${e.name}: ${relDir(here, e.pos)}${ref(e.pos) ? `・${ref(e.pos)}` : ''}`);
    const r = await this.talker.reportFind({ ...this.talkCtx(ctx), seenText: seen.join('\n'), hereText: ref(here) });
    const say = r.say ? this.refPlaces(r.say.replace(/\s+/g, ' ').trim(), { via: 'board' }).slice(0, this.boardCfg.textMax) : '';
    this.recorder.write({ event: 'board', kind: 'report_find', loop: this.memory.tick, say: say || null, rawOutput: r.rawOutput, promptChars: r.promptChars, promptTokens: r.promptTokens, ms: r.ms, error: r.error });
    if (!say) return { ok: false, msg: '知らせることが出てこなかった' };
    this.sendBoard(boardLine.find(say));
    this.memory.noteHeard('自分', say, 0.1, { global: true });
    this.social.onSpoke(this.memory.tick);
    this.log(`[${this.cfg.persona.name}] 発見「${say}」`);
    return { ok: true, msg: `全員に発見「${say}」を知らせた`, said: say };
  }

  async doPropose(ctx) {
    if (!this.talker || !this.board) return { ok: false, msg: '提案する仕組みがない' };
    const raw = ctx.raw;
    const me = this.cfg.persona.name;
    this.lastProposeTick = this.memory.tick;
    const near = raw.blocks.filter((b) => /^(chest|trapped_chest|barrel)$/.test(b.name) && b.nearest.d <= (this.cfg.perception.visionRadius ?? 16)).sort((a, b) => a.nearest.d - b.nearest.d)[0];
    const hereChest = near && !this.board.chestAt(near.nearest) && this.board.chests.size < this.boardCfg.maxShared ? near : null;
    // 欲しい道具 (自分の不満・聞いた頼みごと) も物の名前の候補に
    const toolItems = [...(this.toolWant ? this.toolWant.wants().map((x) => x.item) : []), ...(this.division ? Object.keys(this.division.sItem || {}) : [])];
    const items = [...new Set([...raw.inventory.map((i) => i.name), ...toolItems, ...((this.goalPath && this.goalPath.lastItemNames) || []), ...this.boardNames().filter((n) => /^[a-z0-9_]+$/.test(n)),
      ...[...this.board.chests.values()].flatMap((c) => c.items.map((i) => i.name))])].slice(0, 60);
    const chests = [...this.board.chests.values()].map((c) => ({ id: c.id, text: `${relDir(raw.self.pos, c.pos)}・${this.board.chestItemsText(c, 'ja')}` }));
    const toolFacts = this.division ? this.division.toolFactsText({ mine: raw.tools || [] }) : '';
    const r = await this.talker.propose({ ...this.talkCtx(ctx), items, chests, hereChest: !!hereChest, itemEffort: (this.goalPath && this.goalPath.lastItemEffort) || {}, toolFacts });
    const pr = r.proposal;
    const rec = { event: 'board', kind: 'propose', loop: this.memory.tick, rawOutput: r.rawOutput, promptChars: r.promptChars, promptTokens: r.promptTokens, ms: r.ms, error: r.error };
    if (!pr) { this.recorder.write({ ...rec, ok: false }); return { ok: false, msg: '提案することが出てこなかった' }; }
    // chest: here → 先に共有にして、その id にする
    if (pr.spec.type === 'rule' && pr.spec.chest === 'here') {
      const sh = hereChest ? this.doShareChest({ pos: hereChest.nearest }) : null;
      if (sh && sh.ok) pr.spec.chest = sh.chest; else pr.spec = { type: 'text' };
    }
    pr.text = this.refPlaces(pr.text, { via: 'board' });
    const id = `${me}#${this.memory.tick}`;
    const n = this.aliveCount();
    this.sendBoard(boardLine.propose({ id, n, spec: pr.spec, text: pr.text }));
    this.boardAsked.add(id);
    this.recorder.write({ ...rec, ok: true, id, n, need: this.board.proposals.get(id) ? this.board.need(this.board.proposals.get(id)) : null, spec: pr.spec, text: pr.text });
    this.log(`[${me}] 提案 ${id}「${pr.text}」 ${JSON.stringify(pr.spec)}`);
    return { ok: true, msg: `全員に「${pr.text}」と提案した`, proposal: { id, spec: pr.spec, text: pr.text } };
  }

  // 自分が item を count 個手に入れる手間の言葉 (英語。Jev の賛成の質問の state 用。数値は出さない)
  effortEnOf(raw, item, count = 1) {
    try {
      const kinds = new Set(this.memory.places.map((q) => q.kind));
      const pl = new Planner({ inventory: raw.inventory, visibleBlocks: raw.blocks.map((b) => b.name), visibleMobs: raw.entities.filter((e) => e.kind !== 'item' && e.kind !== 'player').map((e) => e.name),
        knownBlocks: [...kinds], stations: { crafting_table: !!raw.tableNearby || kinds.has('crafting_table'), furnace: raw.blocks.some((b) => b.name === 'furnace') || kinds.has('furnace') } });
      const w = effortWord(pl.effort([{ item, count }]));
      return w ? (EFFORT_EN[w] || w) : null;
    } catch (_) { return null; }
  }

  // ここのチェストを共有にする (全員に知らせる。中身を知っていれば中身も)
  doShareChest(ch) {
    if (!this.board || !ch || !ch.pos) return { ok: false, msg: 'チェストが分からない' };
    if (this.board.chestAt(ch.pos)) return { ok: false, msg: 'そのチェストはもう共有になっている' };
    if (this.board.chests.size >= this.boardCfg.maxShared) return { ok: false, msg: '共有のチェストはもう増やせない' };
    const me = this.cfg.persona.name;
    const id = this.board.nextChestId(me);
    const pos = { x: Math.floor(ch.pos.x), y: Math.floor(ch.pos.y), z: Math.floor(ch.pos.z) };
    this.sendBoard(boardLine.share(id, pos));
    const known = ((this.memory.extra && this.memory.extra.containers) || {})[`${pos.x},${pos.y},${pos.z}`];
    if (known) this.sendBoard(boardLine.chest(id, me, null, known.items || []));
    this.recorder.write({ event: 'board', kind: 'share_chest', loop: this.memory.tick, chest: id, pos, known: !!known });
    return { ok: true, msg: `このチェストを共有にした (${chestLabelJa(id)})`, chest: id };
  }

  // 行動のあと: 共有のチェストの中身を全員に知らせる・取り決めを守ったか数える・共同の目標の物を置いたら知らせる
  afterBoardAction(resolved, result) {
    if (!this.board) return;
    const me = this.cfg.persona.name;
    const tick = this.memory.tick;
    if ((resolved.action === 'chest_put' || resolved.action === 'chest_take') && result.chest) {
      const c = this.board.chestAt(result.chest.pos);
      const d = result.ok && result.chest.item ? { item: result.chest.item, n: result.chest.n } : null;
      // 取り決めとの照らし合わせは、送る前 (自分の行で板の数が変わる前) に
      const checks = d ? this.board.checkOwn(resolved.action, d.item, c ? c.id : null) : [];
      if (c) this.sendBoard(boardLine.chest(c.id, me, d, result.chest.items || []));
      for (const x of checks) this.recorder.write({ event: 'board', kind: 'comply', agreement: x.p.id, by: x.p.by, item: d.item, n: Math.abs(d.n), kept: x.kept, how: x.how, chest: c ? c.id : null, loop: tick });
    }
    if (resolved.action === 'place' && result.ok && this.board.activeProjectItems().has(resolved.arg)) {
      this.sendBoard(boardLine.placed(resolved.arg, 1));
      this.recorder.write({ event: 'board', kind: 'placed', item: resolved.arg, loop: tick });
    }
  }

  // Jev の agree_q* (noul) から賛成/反対を決めて全体チャットで返す
  voteFromJev(dec) {
    if (!this.board || !dec.jev || !dec.jev.agree || !this.boardView) return [];
    const out = [];
    for (const [q, p] of Object.entries(dec.jev.agree)) {
      const id = this.boardView.openMap[q];
      if (!id || p == null) continue;
      const pr = this.board.proposals.get(id);
      this.boardAsked.add(id);
      if (!pr || pr.status !== 'open') continue;
      const yes = p >= this.boardCfg.voteThreshold;
      this.sendBoard(boardLine.vote(id, yes));
      const v = { event: 'board', kind: 'vote', id, by: pr.by, yes, p: Math.round(p * 1000) / 1000, relation: this.social.relationWord(pr.by), affinity: this.social.relations[pr.by] ? Math.round(this.social.relations[pr.by].affinity) : 50, loop: this.memory.tick, yesNow: pr.yes.size, need: this.board.need(pr), status: pr.status };
      this.recorder.write(v);
      out.push(v);
    }
    return out;
  }

  // 拠点の様子 (観察に出す文)。拠点 = set_base の場所、なければ最後にベッド/チェストを置いた所。
  // 近く (visionRadius) にいれば数え直し、遠ければ前に見たときの様子。変わったら記録に残す
  baseView(raw, memPlaces) {
    if (this.cfg.baseSite === false || this.help.goalPath !== true) return '';
    const center = this.base || this.homeSpot;
    this.baseEn = '';
    if (!center) return '';
    const m = memPlaces.find((p) => p.kind === BASE_KIND);
    const labelEn = this.base ? `the base${m ? ` (${m.id})` : ''}` : 'the spot where I placed my bed/chest';
    const label = this.base ? `拠点${m ? ` (${m.id})` : ''}` : '自分のベッド/チェストを置いた所';
    const here = raw.self.pos;
    const near = dist3(here, center) <= (this.cfg.perception.visionRadius ?? 16);
    if (near && this.bot && typeof this.bot.blockAt === 'function') {
      const site = baseSite((x, y, z) => this.bot.blockAt(new Vec3(x, y, z)), center, (this.cfg.baseSiteOpts || {}));
      if (site) this.baseSeen = { site, tick: this.memory.tick };
    }
    if (!this.baseSeen) {
      this.baseEn = near ? `near ${labelEn}: not counted yet` : `${labelEn}: ${en.whereEn(here, center)}`;
      return near ? `${label}の近く: まだ数えていない` : `${label}: ${relDir(here, center)}`;
    }
    const text = baseSiteText(this.baseSeen.site, { label, near, dirText: relDir(here, center) });
    this.baseEn = baseSiteTextEn(this.baseSeen.site, { label: labelEn, near, where: en.whereEn(here, center) });
    const key = JSON.stringify(this.baseSeen.site.counts) + this.baseSeen.site.enclosed + (this.baseSeen.site.light >= 8);
    if (near && key !== this.lastBaseText) {
      this.lastBaseText = key;
      this.recorder.write({ event: 'base_site', loop: this.memory.tick, center, isBase: !!this.base, counts: this.baseSeen.site.counts, light: this.baseSeen.site.light, enclosed: this.baseSeen.site.enclosed, roof: this.baseSeen.site.roof, walls: this.baseSeen.site.walls, text });
    }
    return text;
  }

  // 周りの人 (ゴールの候補): 名前・関係・今見えているか
  peopleList(raw) {
    const me = this.cfg.persona.name;
    const names = new Set(Object.keys(this.social.relations));
    for (const e of peopleOf(raw)) names.add(e.name);
    for (const h of this.memory.heard) if (h.from !== '自分' && h.from !== me) names.add(h.from);
    return [...names].filter((n) => n && n !== me).map((name) => {
      const e = peopleOf(raw).find((x) => x.name === name);
      const r = this.social.relations[name] || null;
      // affinity・talks・d はゴール選びの候補を上位 N 人に絞る並べ方だけに使う (2B には見せない)
      return { name, relation: this.social.relationWord(name), relationEn: this.social.relationWord(name, { lang: 'en' }), seen: e ? relDir(raw.self.pos, e.pos) : null, seenEn: e ? en.whereEn(raw.self.pos, e.pos) : null,
        affinity: r ? r.affinity : null, talks: r ? r.talks || 0 : 0, helped: r ? (r.helpedMe || 0) + (r.iHelped || 0) : 0, d: e ? e.d : null,
        doing: this.division ? this.division.othersDoing(name) || null : null, doingEn: this.division ? this.division.othersDoing(name, { lang: 'en' }) || null : null };
    });
  }

  // ほかの人が拾った物・壊したブロックを見張る (行動の結果の文に足す)
  watchOthers() {
    const bot = this.bot;
    const o = this.others;
    if (!o) return;
    const me = () => (bot.entity ? bot.entity.position : null);
    const nameOf = (e) => (e && e.type === 'player' ? e.username : null);
    // 道具が壊れた (entity_status 47: 利き手の物、48: もう片方の手)。サーバーは壊れた知らせを先に送り、持ち物の更新は後なので、手の物はまだ見える
    bot._client.on('entity_status', (packet) => {
      try {
        if (packet.entityStatus !== 47 && packet.entityStatus !== 48) return;
        const e = bot.entities[packet.entityId];
        if (!e) return;
        const tool = e.heldItem ? e.heldItem.name : null;
        if (e === bot.entity) { this.onToolBreak(tool, 'status'); return; }
        const who = nameOf(e);
        const p0 = me();
        if (!who || (p0 && e.position && e.position.distanceTo(p0) > (this.othersCfg.radius ?? 16))) return;
        if (this.division) this.division.noteBreakSeen(who, tool, this.memory.tick);
        this.recorder.write({ event: 'tool_break', who, tool, how: 'seen', loop: this.memory.tick });
      } catch (_) { /* ignore */ }
    });
    bot._client.on('collect', (packet) => {
      try {
        const who = nameOf(bot.entities[packet.collectorEntityId]);
        const it = bot.entities[packet.collectedEntityId];
        if (!who || !it || it.name !== 'item') return;
        const d = it.getDroppedItem && it.getDroppedItem();
        if (!d) return;
        // 自分が拾った物のすぐ近く (3m) にほかの人が居て、自分が掘った直後でなければ、その人がくれた物とみなす (目安)
        if (who === bot.username && !(bot.lastDigTime && performance.now() - bot.lastDigTime < 3000)) {
          const giver = Object.values(bot.players).filter((p) => p.username !== bot.username && p.entity && p.entity.position.distanceTo(it.position) <= 3)
            .sort((a, b) => a.entity.position.distanceTo(it.position) - b.entity.position.distanceTo(it.position))[0];
          // その人が直前にブロックを壊していたら、落ちた物を拾っただけ (もらったのではない。2026-11-11 の生の試験で、取られた松明を拾って「くれた」になった)
          if (giver && !o.brokeRecently(giver.username) && Date.now() - (this.lastReceived || 0) > 5000) { this.lastReceived = Date.now(); this.social.onReceived(giver.username); this.recorder.write({ event: 'received', from: giver.username, item: d.name, count: packet.pickupItemCount || d.count || 1, loop: this.memory.tick }); if (this.reflect) this.reflect.noteEvent({ kind: 'received', tick: this.memory.tick, from: giver.username, item: d.name, count: packet.pickupItemCount || d.count || 1 }); }
        }
        // 自分が掘ったばかりの所の物を、ほかの人が先に拾った (わだかまりのきっかけ)
        if (who !== bot.username && o.myDigNear(it.position)) this.conflict.onSnatched(who, d.name);
        o.notePickup({ who, self: bot.username, me: me(), item: d.name, count: packet.pickupItemCount || d.count || 1, pos: it.position });
      } catch (_) { /* ignore */ }
    });
    bot.on('blockBreakProgressObserved', (block, stage, entity) => {
      const who = nameOf(entity);
      if (who && block) o.noteBreakProgress({ who, self: bot.username, pos: block.position, tool: entity.heldItem ? entity.heldItem.name : null });
    });
    bot.on('diggingCompleted', (block) => { if (block) o.noteMyDig(block.position); });
    // 腕を振った (すぐ壊れる物を誰が壊したかの見分けに使う。others.js)
    bot.on('entitySwingArm', (e) => { try { const who = nameOf(e); if (who && who !== bot.username) o.noteSwing(who); } catch (_) { /* ignore */ } });
    bot.on('blockUpdate', (oldB, newB) => {
      try {
        if (!oldB || !newB || oldB.name === newB.name) return;
        // 自分が掘り終えた直後 (mineflayer は掘り終えたとき lastDigTime を新しくしてから空気にする) は自分の分
        const p0 = me();
        if (p0 && bot.lastDigTime && performance.now() - bot.lastDigTime < 500 && newB.position.offset(0.5, 0.5, 0.5).distanceTo(p0) <= 6) o.noteMyDig(newB.position);
        // held: その人が手に持っている物 (エンティティの equipment。見えている分)
        const players = Object.values(bot.players).filter((p) => p.username !== bot.username && p.entity).map((p) => ({ name: p.username, pos: p.entity.position, held: p.entity.heldItem ? p.entity.heldItem.name : null }));
        let who = null;
        if (newB.name === 'farmland') o.noteTill({ pos: newB.position, oldName: oldB.name, newName: newB.name, me: me(), players });
        else who = o.noteBlockGone({ pos: newB.position, oldName: oldB.name, newName: newB.name, me: me(), players });
        // 所有の知識: 置くのを見た・知っている物を取るのを見た (ownership_agent.js)
        this.own.onBlockChange({ pos: newB.position, oldName: oldB.name, newName: newB.name, who, how: who ? o.lastHow : null, players, me: me() });
      } catch (_) { /* ignore */ }
    });
  }

  // again: 入り直し (unstuck)。拠点・記憶・欲求・ゴール・Board はこの Agent が持ったまま、bot だけ作り直す
  connect({ again = false } = {}) {
    const s = this.cfg.server;
    this.bot = mineflayer.createBot({ host: s.host, port: s.port, username: this.cfg.persona.name, version: s.version, auth: 'offline' });
    const bot = this.bot;
    // 接続の見張り (run.js が付ける src/netdiag.js。接続の再試行・入り直しの bot も)
    if (this.onBot) { try { this.onBot(bot); } catch (_) { /* ignore */ } }
    bot.loadPlugin(pathfinder);
    bot.on('chat', (username, message) => this.onChat(username, message));
    // 死んだら: 死因はサーバーの死亡メッセージ (translate が death.〜) から拾う。リスポーンは mineflayer が自動で行う
    bot.on('message', (jsonMsg) => {
      try {
        const key = jsonMsg && jsonMsg.translate;
        if (key && /^death\./.test(key) && String(jsonMsg.toString()).startsWith(bot.username)) this.lastDeathMsg = { key, text: jsonMsg.toString(), t: Date.now() };
        else if (key && /^death\./.test(key)) this.conflict.onOtherDeath(key, jsonMsg.toString()); // 自分が人を殺したか
      } catch (_) { /* ignore */ }
    });
    bot.on('death', () => {
      this.memory.noteEvent('death', '', false, '死んでしまった');
      this.social.onDeath();
      this.log(`[${bot.username}] died`);
      const t = bot.time;
      const pos = bot.entity ? { x: Math.round(bot.entity.position.x), y: Math.round(bot.entity.position.y), z: Math.round(bot.entity.position.z) } : null;
      const at = { loop: this.memory.tick, timeOfDay: t ? t.timeOfDay : null, day: t ? t.day : null, pos };
      setTimeout(() => {
        const m = this.lastDeathMsg && Date.now() - this.lastDeathMsg.t < 5000 ? this.lastDeathMsg : null;
        const d = { ...at, cause: m ? m.key : 'unknown', message: m ? m.text : null };
        this.deaths.push(d);
        // 先のつらさ: 夜に死んだら、何に殺されたかと一緒に覚える (anticipate.js)
        const counted = this.social.needsModel.ant.noteDeath({ timeOfDay: d.timeOfDay, day: d.day, cause: d.cause, message: d.message });
        this.recorder.write({ event: 'death', ...d, night: counted });
        if (m) this.conflict.onDeathMessage(m.key, m.text); // 人に殺されたなら強いきっかけ
        if (this.reflect) this.reflect.noteEvent({ kind: 'death', tick: d.loop, day: d.day, timeOfDay: d.timeOfDay, cause: d.cause });
        this.lastDeathMsg = null;
      }, 1500);
    });
    bot.on('kicked', (r) => { this.log(`[${bot.username}] kicked: ${JSON.stringify(r)}`); this.stopped = true; });
    bot.on('end', (r) => { this.log(`[${bot.username}] end: ${r}`); this.stopped = true; });
    bot.on('error', (e) => this.log(`[${bot.username}] error: ${e.message}`));
    return new Promise((resolve, reject) => {
      bot.once('spawn', async () => {
        const mv = new Movements(bot);
        mv.canDig = true;
        mv.allow1by1towers = false;
        mv.allowParkour = true;
        bot.pathfinder.setMovements(mv);
        bot.pathfinder.thinkTimeout = 5000;
        // returningPos で止まらないように (LOSWhenPlacingBlocks = false)・竹は乗らずに壊す・押し戻しと path_reset を数える
        unstuck.setupPathfinder(bot, mv, this.unstuckCfg);
        try { await Promise.race([bot.waitForChunksToLoad(), sleep(10000)]); } catch (_) { /* ignore */ }
        // 全員に共通の場所の呼び方の基準 (places.js): 設定 world.origin {x,y,z} か、出現地点 (world spawn)
        if (!this.memory.origin) {
          const o = (this.cfg.world && this.cfg.world.origin) || bot.spawnPoint || bot.entity.position;
          this.memory.origin = { x: Math.round(o.x), y: Math.round(o.y), z: Math.round(o.z) };
        }
        if (!again) this.setupBase();
        this.watchOthers();
        this.own.attach(bot);
        this.conflict.watch(bot);
        resolve();
      });
      bot.once('error', reject);
    });
  }

  // 拠点: 設定 world.base が 'spawn' なら、出現した地点から baseOffset ずらした所 (全員同じ地点に出る前提)。
  // 全員が最初から「拠点の予定地」を知っている (場所の知識に差をつけない)
  setupBase() {
    const w = this.cfg.world || {};
    if (!w.base || w.base === 'self') return; // 'self': 拠点は最初は無く、set_base で自分で決める
    let p = null;
    if (w.base === 'spawn') {
      const sp = this.bot.spawnPoint || this.bot.entity.position;
      const off = w.baseOffset || { x: 0, z: 6 };
      p = { x: Math.floor(sp.x) + (off.x || 0), y: Math.floor(sp.y), z: Math.floor(sp.z) + (off.z || 0) };
    } else p = { x: Math.floor(w.base.x), y: Math.floor(w.base.y), z: Math.floor(w.base.z) };
    // 地面の高さに合わせる (上から下へ、最初の固い地面の上)
    for (let y = p.y + 12; y > p.y - 12; y--) {
      const b = this.bot.blockAt(new Vec3(p.x, y, p.z));
      if (b && b.boundingBox === 'block' && !/leaves|_log$/.test(b.name)) { p.y = y + 1; break; }
    }
    this.base = p;
    this.memory.notePlace(BASE_KIND, p, { keep: true, imp: 1 });
  }

  // 聞こえる範囲 (hearRadius) の中にいる相手の発言だけを拾う (相手が見えているかは問わない。距離だけ)。
  onChat(username, message) {
    const bot = this.bot;
    if (!bot || username === bot.username) return;
    // 全体チャットの印のある行は、距離に関係なく全員が受け取る (近くの声には入れない)
    if (this.board) { const m = parseLine(message); if (m) { this.onBoardLine(username, m); return; } }
    // 距離だけで決める (視線・見えているかは見ない)。位置は bot.players の entity、無ければ最後に分かった位置 (people.js)
    const r = playerDistance(bot, username, this.playerCache);
    if (!r) { this.chatCount.unknown += 1; return; }
    const d = r.d;
    if (d > (this.cfg.perception.hearRadius ?? 48)) { this.chatCount.far += 1; return; }
    // 独り言 (文の頭の印) は小さな声: mutterRadius より遠ければ聞こえない
    if (MUTTER_MARK.test(String(message)) && d > ((this.cfg.toolWant && this.cfg.toolWant.mutterRadius) ?? 16)) { this.chatCount.far += 1; return; }
    this.chatCount.heard += 1;
    if (r.how === 'cache') this.chatCount.cache += 1;
    let text = String(message).slice(0, 120);
    // 所有の行 (【許可?】【許可】【説明】【返却】【補修】【噂】)。印を読んで、発話の部分だけを近くの声に残す
    if (this.own.on) {
      const om = ownership.parseLine(message);
      if (om) { const said = this.own.onLine(username, om); if (!said) return; text = said.slice(0, 120); }
    }
    // わだかまりの行 (【文句】【返して】【助けて】)
    if (this.conflict.on) {
      const cm = conflict.parseLine(message);
      if (cm) { const said = this.conflict.onLine(username, cm); if (!said) return; text = said.slice(0, 120); }
    }
    this.heardBuf.push({ from: username, text, d: Math.round(d) });
    if (this.heardBuf.length > 10) this.heardBuf.shift();
    const me = bot.username;
    if (choiceWeight.isCalled(text, me)) this.calledBy[username] = this.memory.tick;
    const q = ask.parseQuestion(text);
    if (q && q.to === me && this.help.askOthers) {
      this.questionQueue.push({ from: username, question: q.question, loop: this.memory.tick, t: Date.now() });
      this.answerQueued().catch((err) => this.log(`[${me}] answer error: ${err.message}`));
    }
    const a = ask.parseAnswer(text);
    if (a && a.to === me && this.pendingAsk && this.pendingAsk.to === username && !this.pendingAsk.reply) {
      this.pendingAsk.reply = { text: a.text, t: Date.now() };
    }
  }

  takeChatCount() {
    const c = this.chatCount;
    if (!c || !(c.heard || c.far || c.unknown)) return null;
    this.chatCount = { heard: 0, far: 0, unknown: 0, cache: 0 };
    return c;
  }

  // 返り値: 送った文 (M 番号を共通の呼び方に置き換えたあと) | false
  chat(text, { force = false, places = null } = {}) {
    const now = Date.now();
    const t = this.refPlaces(String(text).replace(/\s+/g, ' ').trim(), { places, via: 'chat' }).slice(0, 100);
    if (!t) return false;
    if (!force && t === this.lastChat.text && now - this.lastChat.t < 30000) return false;
    if (!force && now - this.lastChat.t < this.cfg.loop.chatMinIntervalMs) return false;
    this.lastChat = { t: now, text: t };
    this.bot.chat(t);
    this.memory.noteHeard('自分', t);
    this.social.onSpoke(this.memory.tick);
    return t; // 送った文 (M 番号を置き換えたあと)。記録・ログはこれを使う (元の文は *Raw)
  }

  // craftables: 名前の配列、または "all" (レシピのある物すべて。マイクラで作れる物を全部候補にする)
  craftableNames() {
    if (this.cfg.craftables !== 'all') return this.cfg.craftables || [];
    if (!this.allCraftables) {
      const reg = this.bot.registry;
      const ids = new Set(Object.keys(reg.recipes || {}).map(Number));
      this.allCraftables = reg.itemsArray.filter((it) => ids.has(it.id)).map((it) => it.name);
    }
    return this.allCraftables;
  }

  craftInfo() {
    const now = [];
    const withTable = [];
    for (const name of this.craftableNames()) {
      const it = this.bot.registry.itemsByName[name];
      if (!it) continue;
      if (this.bot.recipesFor(it.id, null, 1, null).length) now.push(name);
      else if (this.bot.recipesFor(it.id, null, 1, true).length) withTable.push(name);
    }
    return { now, withTable };
  }

  extras() {
    const bot = this.bot;
    const foods = new Set(Object.keys(bot.registry.foodsByName || {}));
    const placeable = new Set(bot.inventory.items().map((i) => i.name)
      .filter((n) => bot.registry.blocksByName[n] && this.placeableRes.some((r) => r.test(n))));
    return { foods, placeable };
  }

  // 小屋の進み具合: 拠点が近く (visionRadius 以内) にあるときだけ分かる
  hutView() {
    if (!this.base || this.help.hut === false) { this.trueHut = null; return null; }
    const pos = this.bot.entity.position;
    const near = dist3(pos, this.base) <= (this.cfg.perception.visionRadius ?? 16);
    const st = hutStatus(hutSlots(this.base, this.cfg.world.hut || {}), (p) => { const b = this.bot.blockAt(new Vec3(p.x, p.y, p.z)); return b ? b.name : null; });
    this.trueHut = { ratio: st.ratio, filled: st.filled, total: st.total }; // 記録用 (エージェントには見せない)
    return near ? { ratio: st.ratio, filled: st.filled, total: st.total } : null;
  }

  // set_base: 今いる所を拠点にする。拠点は忘れにくい記憶 (大事さ 1。近くに居るあいだは新しくし続ける)
  setBase() {
    const pos = this.bot.entity.position;
    const p = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
    this.memory.places = this.memory.places.filter((q) => q.kind !== BASE_KIND);
    this.base = p;
    this.memory.notePlace(BASE_KIND, p, { imp: 1 });
    this.recorder.write({ event: 'set_base', loop: this.memory.tick, base: p });
    return p;
  }

  // 行動のあとの小屋の埋まった数 (状態が変わったかの比較用。記録の hutTrue は行動の前のまま)
  trueHutFilled() {
    if (!this.base || this.help.hut === false) return null;
    return hutStatus(hutSlots(this.base, this.cfg.world.hut || {}), (p) => { const b = this.bot.blockAt(new Vec3(p.x, p.y, p.z)); return b ? b.name : null; }).filled;
  }

  // 聞く: チャットで聞いて、答えを待つ (act.js の ask から呼ばれる)
  async doAsk(ch) {
    const trouble = ch.trouble;
    const to = ch.player;
    const q = ask.questionText(to, trouble);
    const rec = { id: `${this.cfg.persona.name}-${this.memory.tick}`, from: this.cfg.persona.name, to, key: trouble.key, about: trouble.about, question: q, loop: this.memory.tick };
    this.askedAt[trouble.key] = this.memory.tick;
    this.pendingAsk = { to, reply: null };
    // 困りごとの M 番号は、その失敗をしたときの番号 (今の一覧とずれることがある) → そのときの場所で置き換える
    const sentQ = this.chat(q, { force: true, places: this.placesOfKey(trouble.key) });
    if (sentQ && sentQ !== q) { rec.questionRaw = q; rec.question = sentQ; }
    this.recorder.write({ event: 'ask', ...rec });
    const waitMs = (this.cfg.ask && this.cfg.ask.waitMs) || 45000;
    const t0 = Date.now();
    while (!this.pendingAsk.reply && Date.now() - t0 < waitMs && !this.stopped) await sleep(250);
    const reply = this.pendingAsk.reply;
    this.pendingAsk = null;
    if (!reply) {
      this.social.onIgnored(to);
      this.recorder.write({ event: 'ask_timeout', id: rec.id, from: rec.from, to, waitedMs: Date.now() - t0 });
      return { ok: false, msg: `${to}に聞いたが返事がなかった` };
    }
    const known = !ask.isDontKnow(reply.text);
    this.memory.noteKnowledge(to, trouble.key, reply.text, { imp: known ? 0.8 : 0.3, at: this.phaseNow() });
    this.social.onAnswered(to, known);
    if (known) this.pendingUse.push({ id: rec.id, key: trouble.key, answer: reply.text, from: to, until: this.memory.tick + ((this.cfg.ask && this.cfg.ask.useWindow) || 6) });
    this.recorder.write({ event: 'ask_reply', id: rec.id, from: rec.from, to, answer: reply.text, known, waitedMs: reply.t - t0 });
    return { ok: true, msg: `${to}に聞いた:「${reply.text.slice(0, 50)}」` };
  }

  phaseNow() { return timePhase(this.bot.time ? this.bot.time.timeOfDay : 6000); }

  // 聞かれたことに、自分の記憶の範囲で答える (ループとは別に、聞かれた順に)
  async answerQueued() {
    if (this.answering) return;
    this.answering = true;
    try {
      while (this.questionQueue.length && !this.stopped) {
        const q = this.questionQueue.shift();
        const hints = this.help.hints ? [...(this.cfg.goal.hints || []), ...(this.knowledge ? this.knowledge.facts.map((f) => f.text) : [])] : [];
        const mems = ask.relevantMemories(this.memory, q.question, { hints });
        let text;
        let twoB = null;
        if (!mems.length) text = 'ごめん、それは分からない';
        else if (this.talker) {
          const gw = this.social.grudgeWord ? this.social.grudgeWord(q.from) : '';
          const r = await this.talker.answer({ persona: this.cfg.persona, from: q.from, question: q.question, memories: mems, ...(gw ? { relation: this.social.relationWord(q.from) } : {}) });
          twoB = { promptChars: r.promptChars, promptTokens: r.promptTokens, ms: r.ms, error: r.error, rawOutput: r.rawOutput };
          text = r.say || 'ごめん、うまく言えない';
        } else text = mems[0].text;
        // 答えの M 番号は、思い出した出来事のときの番号 (出来事に残した場所) を先に、無ければ今の一覧で置き換える
        const sentA = this.chat(ask.answerText(q.from, text), { force: true, places: this.placesOfMemories(mems) });
        const answerSent = sentA ? String(sentA).replace(/^\S+?さん、答え[:：]\s*/, '') : null;
        this.social.onAsked(q.from, mems.length > 0, this.memory.tick);
        this.recorder.write({ event: 'answer', from: this.cfg.persona.name, to: q.from, question: q.question, answer: answerSent || text, ...(answerSent && answerSent !== text ? { answerRaw: text } : {}), known: mems.length > 0 && !ask.isDontKnow(text), memories: mems, twoB, delayMs: Date.now() - q.t });
      }
    } finally {
      this.answering = false;
    }
  }

  // 欲求に使う周りの様子 (needs.js の update に渡す): 通しの時間・明るさ・囲まれているか・寝床の近くか・知らない場所か
  senseNeeds(raw, { newCell = false, cell = null } = {}) {
    const bot = this.bot;
    const s = { newCell };
    const t = bot && bot.time;
    if (t && Number.isFinite(Number(t.age))) s.time = Number(t.age);
    const pos = raw.self.pos;
    if (bot && typeof bot.blockAt === 'function') {
      try {
        const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z));
        s.shelter = senseShelter(at, pos);
        const b = at(Math.floor(pos.x), Math.floor(pos.y) + 1, Math.floor(pos.z));
        if (b) s.light = effectiveLight({ blockLight: b.light ?? 0, skyLight: b.skyLight ?? 15 }, raw.self.timeOfDay);
      } catch (_) { /* ignore */ }
    }
    // 自分の寝床: 自分の拠点か、寝たことのあるベッド (記憶の場所) の近く
    const homes = this.memory.places.filter((q) => q.kind === BASE_KIND || /_bed$/.test(q.kind));
    const hr = (this.social.needsModel.cfg.safety.homeRadius) || 8;
    // 空腹はマイクラの満腹度 (0〜20) と隠し満腹度 (saturation) から (needs.js)
    if (bot && Number.isFinite(bot.food)) s.food = bot.food;
    if (bot && Number.isFinite(bot.foodSaturation)) s.saturation = bot.foodSaturation;
    s.atHome = homes.some((q) => dist3(pos, q) <= hr) || (this.base ? dist3(pos, this.base) <= hr : false);
    // 先のつらさ (anticipate.js) の備え: 囲まれた寝床/拠点を知っている (拠点を最後に見たとき囲まれていた) ・ベッドを知っている
    s.shelterKnown = !!(this.baseSeen && this.baseSeen.site && this.baseSeen.site.enclosed);
    s.bedKnown = this.memory.places.some((q) => /_bed$/.test(q.kind));
    // 知らない場所: 初めて入ったマスか、入ったのが1回だけで来たばかり
    s.unfamiliar = !cell || (cell.n <= 1 && this.memory.tick - cell.first < 10);
    return s;
  }

  // 周りの人の情報 (ゴール作りに渡す): 各人への関係・最近聞いた発言・最近拾った/壊した物・今見えているか
  peopleText(raw, { maxPeople = 5, heardPer = 2 } = {}) {
    const me = this.cfg.persona.name;
    const names = new Set(Object.keys(this.social.relations));
    for (const e of peopleOf(raw)) names.add(e.name);
    for (const h of this.memory.heard) if (h.from !== '自分' && h.from !== me) names.add(h.from);
    const ev = this.others ? this.others.events : [];
    for (const e of ev) names.add(e.who);
    const lines = [];
    for (const name of [...names].filter((n) => n && n !== me).slice(0, maxPeople)) {
      const parts = [`${name}: ${this.social.relationWord(name)}`];
      const seen = peopleOf(raw).find((x) => x.name === name);
      parts.push(seen ? `今は${relDir(raw.self.pos, seen.pos)}にいる` : '今は見えない');
      const said = this.memory.heard.filter((h) => h.from === name).slice(-heardPer).map((h) => `「${h.text}」`);
      if (said.length) parts.push(`最近の発言 ${said.join(' ')}`);
      const did = {};
      for (const e of ev.filter((x) => x.who === name)) { const k = `${e.name}を${e.kind === 'pickup' ? '拾った' : '壊した'}`; did[k] = (did[k] || 0) + e.count; }
      const dl = Object.entries(did).slice(-3).map(([k, n]) => k.replace('を', `を${n}個`));
      if (dl.length) parts.push(`最近 ${dl.join('・')}`);
      const doing = this.division ? this.division.othersDoing(name) : '';
      if (doing) parts.push(doing);
      lines.push(parts.join('。'));
    }
    return lines.join('\n');
  }

  // ---- 使う側の不満と声 (toolwant.js) ----
  // 判断の前: 道具の耐久で満たされた/すり減ったを見直す。石が見えているのに取れない (ツルハシが無い) を数える。壊れた道具が戻ったかを記録
  toolWantStep(raw, tick) {
    const tools = raw.tools || [];
    for (const [type, dn] of Object.entries(this.toolDown)) {
      if (tools.some((t) => (TF.toolInfo(t.name) || {}).type === type)) {
        this.recorder.write({ event: 'tool_back', type, tool: dn.tool, ticks: tick - dn.tick, ms: Date.now() - dn.t, loop: tick });
        delete this.toolDown[type];
      }
    }
    if (!this.toolWant) return;
    const u = this.toolWant.update({ tick, tools });
    for (const x of u.satisfied) this.recorder.write({ event: 'tool_want', kind: 'satisfied', item: x.item, by: x.by, v: x.v, loop: tick });
    // 道具が要る物 (石・鉱石) を、自分のゴール・道筋で使うのに、見えていて取れない
    const g = this.goalPath && this.goalPath.goal;
    const names = this.goalPath ? this.boardNames() : [];
    const wantsStone = names.some((n) => /^(cobblestone|stone|cobbled_deepslate|coal|raw_iron|raw_copper|[a-z_]*_ore|furnace|stone_[a-z_]+)$/.test(n)) || (g && /^stone_|cobblestone/.test(String(g.target || '')));
    if (wantsStone) {
      const b = (raw.blocks || []).find((x) => x.diggable === false && TF.taskOfBlock(x.name) === 'mining');
      const pick = tools.find((t) => (TF.toolInfo(t.name) || {}).type === 'pickaxe');
      if (b && !pick) {
        const out = this.toolWant.noteCantHarvest({ block: b.name, tick });
        if (out.length) this.recorder.write({ event: 'tool_want', kind: 'cant', block: b.name, add: out, loop: tick });
      }
    }
  }

  // 行動の後: 掘るのにかかった時間・壊れた道具
  toolWantAfter(resolved, result, tick) {
    if (!result) return;
    if (result.broke && result.broke.length) for (const t of result.broke) this.onToolBreak(t, 'inventory');
    if (!this.toolWant) return;
    if (resolved.action === 'collect' && result.digMs > 0 && result.block) {
      const out = this.toolWant.noteDig({ block: result.block, tools: result.tools || [], digMs: result.digMs, n: result.dug || 1, tick });
      if (out.length) this.recorder.write({ event: 'tool_want', kind: 'slow', block: result.block, tools: result.tools, digMs: result.digMs, n: result.dug || 1, add: out, loop: tick });
    }
  }

  // 自分の道具が壊れた (entity_status か、collect の持ち物の減り。2秒以内の同じ道具は1回)
  onToolBreak(tool, via) {
    const now = Date.now();
    if (this.lastBreak.tool === tool && now - this.lastBreak.t < 2000) return;
    this.lastBreak = { tool, t: now };
    const tick = this.memory.tick;
    const i = TF.toolInfo(tool);
    const add = this.toolWant && i ? this.toolWant.noteBroke({ tool, tick }) : [];
    if (i) this.toolDown[i.type] = { tool, tick, t: now };
    this.recorder.write({ event: 'tool_break', who: this.cfg.persona.name, tool, how: 'self', via, add, loop: tick });
    if (this.reflect) this.reflect.noteEvent({ kind: 'heard', tick, from: '自分', text: `${tool}が壊れた` });
  }

  // 声に出すか (toolwant.decide)。出すなら文を作る LLM に書かせ、待たずに次へ (形: 独り言・近くの人に頼む・全員に頼む)
  maybeVoice(ctx, raw, tick) {
    if (!this.toolWant || !this.talker || this.voicing) return null;
    const hear = (this.cfg.perception && this.cfg.perception.hearRadius) ?? 48;
    const near = peopleOf(raw).filter((e) => e.d == null || e.d <= Math.min(hear, (this.cfg.toolWant && this.cfg.toolWant.nearRadius) ?? 16))
      .map((e) => ({ name: e.name, affinity: this.social.relations[e.name] ? this.social.relations[e.name].affinity : 50 }));
    const dcs = this.toolWant.decide({ tick, near, canAll: !!this.board });
    if (!dcs.form) return dcs.d > 0 ? { form: null, item: dcs.item, d: dcs.d, p: dcs.p, theta: dcs.theta } : null;
    this.toolWant.noteVoiced(dcs.form, dcs.item, tick);
    this.voicing = true;
    const tctx = { ...this.talkCtx(ctx), form: dcs.form, wantItem: dcs.item, wantFacts: this.toolWant.factsText(dcs.item),
      nearText: dcs.form === 'near' ? near.map((x) => x.name).join(', ') : this.talkCtx(ctx).nearText };
    const placesAt = this.lastMemPlaces || null;
    this.talker.voice(tctx).then((r) => {
      let say = r.say ? r.say.replace(/\s+/g, ' ').trim() : '';
      const sayRaw = say;
      let sent = false;
      if (say) {
        if (dcs.form === 'all') { say = this.refPlaces(say, { places: placesAt, via: 'board' }).slice(0, this.boardCfg.textMax); sent = !!this.sendBoard(boardLine.say(say)); if (sent) { this.memory.noteHeard('自分', say, 0.1, { global: true }); this.social.onSpoke(this.memory.tick); } }
        else if (dcs.form === 'near') { const t = this.chat(say, { places: placesAt, force: true }); sent = !!t; if (t) say = t; }
        else { const t = this.chat(`(ひとりごと) ${say}`, { places: placesAt, force: true }); sent = !!t; if (t) say = t.replace(/^\(ひとりごと\) /, ''); }
      }
      this.recorder.write({ event: 'tool_voice', loop: tick, form: dcs.form, item: dcs.item, d: dcs.d, p: dcs.p, theta: dcs.theta, mutterRate: dcs.mutterRate, close: dcs.close, repeat: dcs.repeat,
        to: dcs.to, say: sent ? say : null, ...(sent && say !== sayRaw ? { sayRaw } : {}), rawOutput: r.rawOutput, promptChars: r.promptChars, promptTokens: r.promptTokens, ms: r.ms, error: r.error });
      if (sent) this.log(`[${this.cfg.persona.name}] ${dcs.form === 'mutter' ? 'ひとりごと' : dcs.form === 'near' ? '頼む' : '全体に頼む'}「${say}」 (${dcs.item} ${dcs.d})`);
    }).catch(() => {}).finally(() => { this.voicing = false; });
    return { form: dcs.form, item: dcs.item, d: dcs.d, p: dcs.p, theta: dcs.theta };
  }

  // Jev の talk (Noul) が閾値を超えたら、2B に発言を作らせる (待たずに次へ進む)
  maybeTalk(ctx, dec, plannedText) {
    const tcfg = this.cfg.talk || {};
    // 話すかは Jev の talk。random の decider の talkP (負荷の試験用) も同じに扱う
    const talkP = dec.jev ? dec.jev.talkP : dec.talkP;
    if (!this.talker || this.talking || talkP == null) return null;
    const thr = (tcfg.threshold ?? 0.6) + (0.5 - (this.social.temperament.sociability ?? 0.5)) * 0.2;
    if (talkP < thr) return null;
    this.talking = true;
    const tctx = this.talkCtx(ctx, plannedText);
    const loop = this.memory.tick;
    const placesAt = this.lastMemPlaces || null; // 文を作ったときの M 番号 (置き換えに使う)
    this.talker.talk(tctx).then((r) => {
      const said = r.say ? this.chat(r.say, { places: placesAt }) || null : null;
      const sayRaw = said && r.say ? String(r.say).replace(/\s+/g, ' ').trim() : null;
      this.recorder.write({ event: 'talk', loop, talkP, threshold: Number(thr.toFixed(3)), say: said, ...(said && sayRaw !== said ? { sayRaw } : {}), rawOutput: r.rawOutput, promptChars: r.promptChars, promptTokens: r.promptTokens, ms: r.ms, error: r.error });
      if (said) this.log(`[${this.cfg.persona.name}] say「${said}」 (talk ${talkP.toFixed(2)})`);
    }).catch(() => {}).finally(() => { this.talking = false; });
    return thr;
  }

  async step(loopNo) {
    const bot = this.bot;
    const cfg = this.cfg;
    this.memory.tick += 1;
    const tick = this.memory.tick;
    const tObs = Date.now();
    const heard = this.heardBuf.splice(0);
    const hutKeys = this.base && this.help.hut !== false ? new Set(hutSlots(this.base, (cfg.world && cfg.world.hut) || {}).map((s) => `${s.x},${s.y},${s.z}`)) : null;
    const raw = collectRaw(bot, { ...cfg.perception, playerCache: this.playerCache, isNotable: this.isNotable, heard, craft: this.craftInfo(), exclude: hutKeys });
    raw.hut = this.hutView();
    // ゲーム内の時刻 (ワールドの age、tick)。あとでやること (prospect.js) の「何分前・あと何分」はこれで数える
    const gameNow = Number.isFinite(raw.self.age) ? raw.self.age : (Number.isFinite(raw.self.day) ? raw.self.day * 24000 + (raw.self.timeOfDay || 0) : null);
    this.memory.gameNow = gameNow;
    // 珍しさ (scarcity.js): 見えた入手元 (ブロック・生き物) を数える。memory.extra.sightings に残す (保存される)
    const valueCfg = cfg.goalPath && cfg.goalPath.select && cfg.goalPath.select.value;
    if (valueCfg && valueCfg.enabled) {
      if (!this.sightings) { this.memory.extra = this.memory.extra || {}; this.memory.extra.sightings = this.memory.extra.sightings || {}; this.sightings = new scarcity.Sightings(this.memory.extra.sightings, valueCfg); }
      this.sightings.note(raw, Number.isFinite(gameNow) ? gameNow : tick);
    }
    const ex = this.extras();
    raw.foodCount = raw.inventory.filter((i) => ex.foods.has(i.name)).reduce((s, i) => s + i.count, 0);
    const cell0 = this.memory.cellOf(raw.self.pos);
    const knownCell = this.memory.cellAt(cell0.cx, cell0.cz);
    const learnedNear = updateMemoryFromObservation(this.memory, raw);
    // 近くの人 (見かけた人) の居たマスを覚える (search の方角で「ほかの人が行った」方に使う)・最後に見たループ
    for (const p of peopleOf(raw)) this.peopleSeenAt[p.name] = tick;
    if (this.searchCfg.enabled) searchMod.noteOthersSeen(this.memory, peopleOf(raw), { cellSize: this.memory.limits.exploreCell, tick, me: cfg.persona.name });
    // 近くの声 (発言・答え) の中の場所を覚えた (共有の分析用。【発見】は onBoardLine で via: 'board')
    for (const l of learnedNear) this.recorder.write({ event: 'heard_place', via: 'near', from: l.from, to: cfg.persona.name, text: l.text, places: l.places, d: l.d, loop: tick });
    for (const h of raw.heard) this.social.onHeard(h.from, tick, h.text);
    if (this.division) { for (const h of raw.heard) this.division.noteHeard(h.from, h.text, tick); if (this.others) this.division.noteOthers(this.others.events, tick); }
    if (this.experience) for (const h of raw.heard) this.experience.noteHeard(h.from, h.text, tick, cfg.persona.name);
    const steps = this.help.steps ? cfg.goal.steps : null;
    this.social.tick({ tick, raw, sense: this.senseNeeds(raw, { newCell: !knownCell, cell: knownCell }) });
    this.toolWantStep(raw, tick);
    const forgotten = this.memory.forget();
    // 困りごと: 同じものを最近聞いたばかりなら、しばらく聞かない
    const cool = (cfg.ask && cfg.ask.cooldown) || 10;
    const nc = this.help.noChange ? noChangeCfg(cfg) : null;
    // 直近 netWindow 回をさかのぼった正味の変化がほぼ0なら、その間に繰り返した行動も「何も変わらなかった」扱い
    const net = nc && nc.net !== false ? nochange.netNoChange(this.loopHist, nc) : null;
    const ncT = nc && net && net.keys.size ? { ...nc, netKeys: net.keys } : nc;
    // 作物が育つのを待つ間の 待つ・見回す の扱い (GROW_WAIT_ACTS) は外した (2026-11-07): 植えたらゴールは済んだ扱いで別のゴールへ移り、
    //   survival_3days には wait・look_around が無い。育っている頃に戻るのは、あとでやること (prospect.js) から
    const troubles = this.help.askOthers ? ask.troubles(this.memory, cfg.loop.failWindow ?? 4, cfg.loop.failRepeat ?? 2, ncT).filter((t) => !(tick - (this.askedAt[t.key] ?? -1e9) < cool)) : [];
    // その場から動けない (unstuck.js): 回復のあと troubleLoops ループ出す (Jev の state・2B のゴール選び)
    const stuckT = this.stuck.trouble(tick);
    if (stuckT) troubles.unshift(stuckT);
    // 自分で決めた拠点: 近くに居れば記憶を新しくする。記憶から消えたら (忘れたら) 拠点も無くなる
    if (cfg.world && cfg.world.base === 'self' && this.base) {
      const bp = this.memory.places.find((q) => q.kind === BASE_KIND);
      if (!bp) this.base = null;
      else if (dist3(raw.self.pos, this.base) <= (cfg.perception.visionRadius ?? 16)) this.memory.notePlace(BASE_KIND, this.base, { imp: 1 });
    }
    let socialText = this.social.words();
    const worst = this.social.worstNeed();
    const ahead = aheadOf(this.social.needsModel);
    const memPlacesNow = this.memory.placesForPrompt(raw.self.pos, new Set(raw.blocks.filter((b) => b.notable).map((b) => b.name)), { ensure: PLACE_ENSURE });
    const baseText = this.goalPath ? this.baseView(raw, memPlacesNow) : '';
    let socialEn = this.social.words({ lang: 'en' });
    const bview = this.prepareBoard(raw);
    // 分業: 見聞きした範囲から刺激を作り直し、慣れの言葉を体と心の言葉に足す
    let divisionSnap = null;
    if (this.division) {
      const site = this.base && this.baseSeen ? this.baseSeen.site : null;
      divisionSnap = this.division.update({ tick, chests: bview ? bview.goal.chests : [], shared: bview ? bview.goal.shared : [],
        selfWant: this.toolWant ? this.toolWant.selfStimulus() : {}, selfTypes: [...new Set((raw.tools || []).map((t) => (TF.toolInfo(t.name) || {}).type).filter(Boolean))],
        base: site ? { dark: site.light != null && site.light < 8, enclosed: !!site.enclosed } : null });
      const fw = this.division.famWords(); const fwEn = this.division.famWords({ lang: 'en' });
      if (this.toolWant) { const w = this.toolWant.words(); const we = this.toolWant.words({ lang: 'en' }); if (w) socialText = `${socialText}。${w}`; if (we) socialEn = `${socialEn}; ${we}`; }
      if (fw) socialText = `${socialText}。${fw}`;
      if (fwEn) socialEn = `${socialEn}; ${fwEn}`;
    }
    // 近くの畑 (空いている耕地・植わっている作物)。use_on の対象・planner の world.farm に使う
    let farm = null;
    try {
      if (bot && typeof bot.blockAt === 'function') {
        const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z));
        farm = farmStatus(at, raw.self.pos);
        const ts = farmwater.tillSpots(at, raw.self.pos);
        farm.till = ts.spots; // 水から4マス以内の耕せるマス (use_on の farmland_spot・道筋の水の段)
        farm.tillCount = ts.count; // その数 (耕す・植える数。planner の畑の段と use_on の続けて耕す数)
      }
    } catch (_) { farm = null; }
    raw.farm = farm; // 観察の文 (近くの耕地の様子) に使う
    this.checkTilled(bot, tick, raw); // 耕した所が土に戻ったか (記録 farmland_reverted)
    this.lastMemPlaces = memPlacesNow; // 発言の中の M 番号を共通の呼び方に置き換えるとき (refPlaces) に使う
    // あとでやること: 近くの作物の育ちを見て見込みを直す・見込みの時刻になったものを記録する
    if (Number.isFinite(gameNow)) {
      const pr = this.memory.prospects;
      const evs = [];
      try { if (bot && typeof bot.blockAt === 'function') evs.push(...pr.observeCrops((x, y, z) => bot.blockAt(new Vec3(x, y, z)), raw.self.pos, gameNow, tick)); } catch (_) { /* 見えない */ }
      try { if (bot && typeof bot.blockAt === 'function') evs.push(...pr.observeSaplings((x, y, z) => bot.blockAt(new Vec3(x, y, z)), raw.self.pos, gameNow, tick)); } catch (_) { /* 見えない */ }
      evs.push(...pr.tick(gameNow, tick));
      for (const e of evs) this.recorder.write({ event: 'prospect', ...e, gameTime: gameNow });
    }
    const { allCells, others } = this.exploreShare(tick, raw);
    // 所有: 台帳を読み足し、知っている物が無くなった・戻ったかを見る。見た無断の取得を持ち主に伝えるか
    this.own.observe(raw);
    const gossip = this.own.maybeGossip(raw);
    const ownPlan = this.goalPath ? this.goalPath.planText() : this.goalPlan ? this.goalPlan.planText() : this.selfGoal ? this.selfGoal.planText() : '';
    const ownView = this.own.view(raw, { base: this.base, goalNames: knowledge.namesInText(ownPlan) });
    // わだかまり: 呼んだ相手が来たか・social の中で起きた分の記録。候補に渡す見方
    this.conflict.observe(raw);
    const conflictView = this.conflict.view(raw, { takeBack: this.conflict.takeBackTargets(raw, this.own) });
    const othersCells = this.searchCfg.enabled ? searchMod.othersCells(this.memory, this.memory.limits.exploreCell) : null;
    const ctx = buildContext(raw, this.memory, cfg, { ...ex, farm, allCells, others, othersCells, base: this.base, troubles, socialText, net, knowledge: this.knowledge, lastResult: this.lastResult, baseText, ahead,
      socialEn, lastResultEn: this.lastResultEn, baseEn: this.goalPath ? this.baseEn : '', order: this.order,
      boardEn: bview ? bview.en : null, boardText: bview ? bview.text : '', boardActs: bview ? bview.acts : null, own: ownView, conflict: conflictView,
      planText: this.goalPath ? this.goalPath.planText() : this.goalPlan ? this.goalPlan.planText() : this.selfGoal ? this.selfGoal.planText() : '' });
    // 自分で目標を決める: 最初・済んだ・困りごとが新しく出た・一定ループごとに 2B で書き直す
    let goalUpdate = null;
    if (this.selfGoal) {
      const reason = this.selfGoal.needs(tick, { doneP: this.lastGoalDoneP, troubles });
      if (reason) {
        goalUpdate = await this.selfGoal.update({
          persona: cfg.persona, goalText: cfg.goal.text, hints: this.help.hints ? (ctx.goal.hints || []) : [],
          obsText: ctx.obsText, memText: ctx.memText, socialText, troubles,
        }, reason, tick);
        this.lastGoalDoneP = null;
        const { prompt, ...rest } = goalUpdate;
        this.recorder.write({ event: 'self_goal', loop: loopNo, tick, ...rest, prompt: this.selfGoalPromptLogged ? undefined : prompt });
        this.selfGoalPromptLogged = true; // プロンプトの全文は最初の1回だけ記録に残す (長いので)
        if (goalUpdate.ok) this.log(`[${cfg.persona.name}] 目標 (${reason}): ${goalUpdate.goal} / ${goalUpdate.steps.join(' → ')}`);
        ctx.progress = this.selfGoal.planText();
      }
    }
    // ゴール → 手順 → 1段ずつ: 前の判断で Jev が答えた「今の手順は済んだか」で進め、詰まったら残りを作り直す
    let planUpdate = null;
    if (this.goalPlan && !this.goalPath) {
      const kn = this.help.hints ? this.knowledge : null;
      const facts = (text) => (kn && kn.facts.length
        ? knowledge.selectFacts(kn.facts, { ...factsOpts(raw, this.memory, text, null, ahead), names: farmNames(knowledge.namesInView({ raw, actions: ctx.actions, plan: text }), memPlacesNow, farm), max: kn.max }).map((f) => f.text) : []);
      planUpdate = await this.goalPlan.update({
        persona: cfg.persona, goalText: cfg.goal.text, obsText: ctx.obsText, raw, facts, actions: ctx.actions, memText: ctx.memText, socialText, troubles,
        worst, peopleText: this.peopleText(raw), needNow: (k) => this.social.needsModel.effective()[k],
      }, tick, { stepDoneP: this.lastStepDoneP, troubles });
      this.lastStepDoneP = null;
      ctx.progress = this.goalPlan.planText();
      if (planUpdate) this.log(`[${cfg.persona.name}] ${planUpdate}: ${ctx.progress}`);
    }
    // 振り返り (reflect.js): 1日の終わり・寝る前・死んだあと・ゴールをいくつか終えたあと。方針はゴール選び (2B) と Jev の state に出す
    let reflected = null;
    if (this.reflect) {
      const reason = this.reflect.due({ tick, timeOfDay: raw.self.timeOfDay, day: raw.self.day, canSleep: ctx.actions.some((a) => a.name === 'sleep') });
      if (reason) {
        const activityFacts = this.division ? countsText(this.division.countsSince(this.divisionExpAt)) : '';
        const experienceFacts = this.experience ? this.experience.lines({ max: 3 }) : [];
        const pol = await this.reflect.run({ persona: cfg.persona, socialText, activityFacts, experienceFacts, laterText: this.memory.laterTexts(raw.self.pos, memPlacesNow).join('\n') }, tick, reason);
        if (this.division) this.divisionExpAt = this.division.copyExp();
        reflected = reason;
        if (pol) this.log(`[${cfg.persona.name}] 振り返り (${reason}): ${pol.text} / ${pol.why || ''}`);
      }
      ctx.policy = this.reflect.stateText() || null;
      ctx.role = this.reflect.roleText() || null; // 自分が最近よくしていること (振り返りで書いたもの)
    }
    if (this.goalPath) {
      const kn = this.help.hints ? this.knowledge : null;
      const facts = (text) => (kn && kn.facts.length
        ? knowledge.selectFacts(kn.facts, { ...factsOpts(raw, this.memory, text, null, ahead), names: farmNames(knowledge.namesInView({ raw, actions: ctx.actions, plan: text }), memPlacesNow, farm), max: kn.max }).map((f) => f.text) : []);
      const cellSize = this.memory.limits.exploreCell;
      planUpdate = await this.goalPath.update({
        ownPlanner: this.own.plannerView(raw), // 所有を考えた入手元 (cfg.provenance.actions)。置かれた物は collect の入手元にしない
        persona: cfg.persona, goalText: cfg.goal.text, obsText: ctx.obsText, raw, facts, allFacts: kn ? kn.facts : [], memText: ctx.memText, socialText, troubles,
        worst, peopleText: this.peopleText(raw), people: this.peopleList(raw), needNow: (k) => this.social.needsModel.effective()[k],
        places: memPlacesNow, placeKinds: [...new Set(this.memory.places.map((q) => q.kind))], base: this.base, baseText: null, // 拠点の様子は obsText に入っている
        baseLabel: this.base ? `自分の拠点 (${relDir(raw.self.pos, this.base)})` : null,
        cellAt: (x, z) => this.memory.cellAt(Math.floor(x / cellSize), Math.floor(z / cellSize)), gave: this.lastGave,
        // 状態のゴール (states.js) を確かめる材料: ブロック・入れ物の中身 (開けて見たもの)・拠点が無いときのベッド/チェストの所
        blockAt: bot && typeof bot.blockAt === 'function' ? (x, y, z) => bot.blockAt(new Vec3(x, y, z)) : null,
        containers: (this.memory.extra && this.memory.extra.containers) || {}, home: this.homeSpot,
        policy: this.reflect ? this.reflect.policyText() : null,
        pressing: (o) => this.social.needsModel.pressing(o),
        later: (o) => this.social.needsModel.later(o), // 先のつらさ (anticipate.js)
        board: bview ? bview.goal : null,
        division: this.division ? this.division.view() : null, shortage: this.division ? this.division.stimulusText() : '', role: ctx.role || null,
        _farm: farm || undefined, origin: this.memory.origin || null,
        // 珍しさ (見かけた記録) と今の時刻、夜の外歩きの危なさ (夜のあいだだけ anticipate の night.risk。planner の手間の感じ方 costScale)
        sightings: this.sightings || null, gameNow: Number.isFinite(gameNow) ? gameNow : tick, nightRisk: this.nightRisk(),
        // あとでやることのうち見込みの時刻を過ぎたもの (場所の候補 type: later)。取りに行くかは 2B が選ぶ
        laterPlaces: Number.isFinite(gameNow) ? this.memory.prospects.goalCandidates(gameNow, { here: raw.self.pos, places: memPlacesNow }) : [],
      }, tick, { troubles });
      this.lastGave = [];
      ctx.progress = this.goalPath.planText();
      ctx.en.plan = this.goalPath.planEn();
      if (this.division) {
        const od = {};
        for (const p of this.peopleList(raw)) if (p.doingEn) od[p.name] = p.doingEn;
        ctx.en.othersDoing = od;
      }
      // 経験 (今のゴールの対象を先に、英語の言葉で)
      if (this.experience) {
        const g = this.goalPath.goal;
        const ex = this.experience.lines({ lang: 'en', max: 3, first: g ? [expKey(g)] : [] });
        if (ex.length) ctx.en.experience = ex;
      }
      ctx.en.obs = obsEn(raw, cfg, ctx.progress, !!(this.memory.extra && this.memory.extra.myBed));
      ctx.pathNext = this.goalPath.pathNext();
      if (planUpdate) this.log(`[${cfg.persona.name}] ${planUpdate}: ${ctx.progress}`);
    }
    // 所有の重みと判断材料は、行動の一覧を作り直す前 (addSearchAction は ctx.actions を新しい配列にする) に取っておく
    //   (2026-11-11 の実行1: 一覧の配列に付けていたので消え、重みが掛かっていなかった)
    const ownAct = { weights: ctx.actions.ownWeights || null, infos: ctx.actions.ownInfos || null };
    this.conflict.noteOffered(ctx.actions);
    // 探しながら歩く (search) の候補と、選択肢の重み (人の所へ行く・ついて行く・道筋に関係しない覚えた場所)
    const searchInfo = this.addSearchAction(ctx, raw, tick);
    if (this.cwCfg.enabled) ctx.choiceWeights = choiceWeight.choiceWeights(ctx.actions, this.weightContext(tick), this.cwCfg);
    // 所有の重み (cfg.provenance.reweight): take_placed の候補に、損害・社会的な損・代わりの手段・所有者不明・断られた の係数を掛ける (0 にはしない)
    const ownWeightInfo = {};
    if (ownAct.infos) for (const [k, i] of Object.entries(ownAct.infos)) ownWeightInfo[k] = i.weight;
    if (this.own.cfg.reweight && ownAct.weights) {
      ctx.choiceWeights = { ...(ctx.choiceWeights || {}) };
      for (const [k, w] of Object.entries(ownAct.weights)) if (w !== 1) ctx.choiceWeights[k] = Math.round((ctx.choiceWeights[k] ?? 1) * w * 1000) / 1000;
    }
    ctx.ownWeightInfo = ownWeightInfo;
    const obsMs = Date.now() - tObs;

    const dec = await this.decider.decide(ctx);
    // 2B が行動を決めた (llm / split) ときは、その呼び出しを 2B の使用量に入れる
    if (this.meter && !dec.jev && dec.promptChars) {
      this.meter.addTwoB({ kind: 'act', promptChars: dec.promptChars, promptTokens: dec.promptTokens, completionTokens: dec.completionTokens, ms: dec.latencyMs, error: dec.parseOk ? null : dec.error });
      if (dec.talk) this.meter.addTwoB({ kind: 'talk', promptChars: dec.talk.promptChars, ms: dec.talk.latencyMs });
    }
    let resolved = dec.parseOk ? resolveDecision(ctx.actions, dec.action, dec.arg) : { ok: false, error: dec.error || 'parse failed' };
    const valid = resolved.ok;
    // 選べなかった・refusal: look_around が一覧にあればそれ、無ければ search → explore、どちらも無ければ explore の方角を1つ作る (actions.fallbackDecision。wait にはしない)
    if (!valid) resolved = { ...fallbackDecision(ctx.actions), fallback: true, error: resolved.error };

    // Jev の Score を記憶の大事さと好感に (直前の出来事 = 前のループの結果と、今聞こえた話)
    if (dec.jev) {
      if (this.selfGoal) this.lastGoalDoneP = dec.jev.goalDoneP ?? null;
      if (this.goalPlan) this.lastStepDoneP = dec.jev.stepDoneP ?? null;
      if (Number.isFinite(dec.jev.remember)) this.memory.setRecentImportance(dec.jev.remember / 4, tick - 1);
      for (const [name, sc] of Object.entries(dec.jev.relations || {})) this.social.onRelationScore(name, sc);
    }
    const votes = this.voteFromJev(dec);
    const plannedText = `${resolved.action}${resolved.arg ? '(' + resolved.arg + ')' : ''}`;
    const talkThr = this.maybeTalk(ctx, dec, plannedText);
    const voiced = this.maybeVoice(ctx, raw, tick);

    let said = null;
    if (dec.say && resolved.action !== 'say') said = this.chat(dec.say) || null;
    const before = nochange.snapshot({ inventory: raw.inventory, pos: raw.self.pos, hutFilled: this.trueHut ? this.trueHut.filled : null });
    const tAct = Date.now();
    const othersMark = this.others ? this.others.mark() : 0;
    // 取る行動の理由を、実行の前に確定して記録する (event: 'intent')
    const intent = this.own.beforeAct(resolved, ctx);
    unstuck.beginAction(bot);
    const result = await executeAction(bot, resolved, {
      ...cfg.act, visionRadius: cfg.perception.visionRadius, memory: this.memory, chat: (t, o) => this.chat(t, o),
      base: this.base, hutShape: this.help.hut === false ? null : ((cfg.world && cfg.world.hut) || {}), ask: (ch) => this.doAsk(ch),
      setBase: () => this.setBase(),
      broadcast: () => this.doBroadcast(ctx), reportFind: () => this.doReportFind(ctx), propose: () => this.doPropose(ctx), shareChest: (ch) => this.doShareChest(ch),
      search: this.searchCfg, searchWatch: () => this.searchWatch(searchInfo, tick),
      ownRecognized: this.own.on ? (p, name) => this.own.knowledge.recognized(this.own.dim(), p, name) : null,
      askPermission: (ch) => this.own.askPermission(ch), explainTake: (ch) => this.own.explainTake(ch),
      afterAmends: (ch, r) => this.own.afterAmends(ch, r), afterPublicRepair: (ch, r) => this.own.afterPublicRepair(ch, r),
      conflictSay: (kind, ch) => this.conflict.say(kind, ch), hits: this.conflict.cfg.hits, hitGapMs: this.conflict.cfg.hitGapMs, avoidDistance: this.conflict.cfg.avoidDistance,
    });
    this.own.afterAct(resolved, result);
    this.conflict.afterAct(resolved, result);
    this.afterBoardAction(resolved, result);
    const searchAfter = this.afterSearch(resolved, result, tick);
    const actMs = Date.now() - tAct;
    // 移動の記録 (goto の回数・打ち切り・押し戻し・path_reset の理由・掘る/置く/動くの割合・returningPos)。行動の終わりに returningPos を消す
    const move = unstuck.endAction(bot);
    if (move) result.move = move;
    const stuckNow = this.stuck.note({ action: resolved.action, ok: result.ok, move });
    // 行動中に近くでほかの人が拾った物・壊したブロックを、結果の文にそのまま足す (記憶にも入る)
    if (this.others && (this.othersCfg.actions || []).includes(resolved.action)) {
      const seen = this.others.since(othersMark);
      if (seen.length) { result.others = seen; result.msg = OthersLog.appendTo(result.msg, seen); }
    }
    if (resolved.action === 'say') said = (result && result.said) || resolved.arg;
    // 渡した (人のゴールの済んだかに使う)・ベッド/チェストを置いた所 (拠点が無いときの拠点の様子に使う)
    if (result.ok && resolved.action === 'give') {
      const ga = ctx.actions.find((a) => a.name === 'give');
      const gc = ga && ga.choices.find((c) => c.id === resolved.arg);
      if (gc) this.lastGave.push({ to: gc.player, item: gc.item });
    }
    if (result.ok && resolved.action === 'place' && /_bed$|^chest$/.test(resolved.arg) && bot.entity) {
      const p = bot.entity.position;
      this.homeSpot = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
    }
    // 覚えている場所へ行けなかった・行けた (go_to の覚えている場所・耕す行き先 farmland_spot@M)。続けて行けなかった所に印を付ける
    const chosen = resolved.choice || {};
    const toMem = chosen.pos && ((resolved.action === 'go_to' && chosen.fromMemory) || (resolved.action === 'use_on' && chosen.till && /@M\d+$/.test(String(resolved.arg || ''))));
    if (toMem) {
      const moveFail = !result.ok && (result.unreachable || resolved.action === 'go_to' || /時間切れ|timeout/.test(String(result.msg || '')));
      if (moveFail) { if (this.memory.noteUnreachable(chosen.pos)) result.markedUnreachable = true; } else if (result.ok) this.memory.noteReached(chosen.pos);
    }
    const key = `${resolved.action}:${resolved.arg}`;
    const inv = bot.inventory.items().map((i) => ({ name: i.name, count: i.count }));
    const after = nochange.snapshot({ inventory: inv, pos: bot.entity.position, hutFilled: this.trueHutFilled() });
    const stateChanged = nochange.changed(before, after);
    const ev = this.memory.noteEvent(resolved.action, resolved.arg, result.ok, valid ? result.msg : `(選び方が無効: ${resolved.error}) ${result.msg}`);
    // 引数・結果の文の M 番号 (この判断の覚えている場所の番号) の場所を出来事に残す。番号は判断ごとに付け直すので、
    //   あとで聞く・答えるときはこの場所で共通の呼び方に置き換える (placesOfKey / placesOfMemories)
    const mpos = mposOf(`${resolved.arg || ''} ${result.msg || ''}`, memPlacesNow);
    if (mpos) ev.mpos = mpos;
    this.noteProspects(resolved, result, raw.inventory, inv, tick);
    ev.nc = !stateChanged; // 状態が変わらなかった (help.noChange のときだけ困りごと・重みに使う。記録は常に)
    if (nc) {
      const p = bot.entity.position;
      const { cx, cz } = this.memory.cellOf(p);
      this.loopHist.push(nochange.histEntry({ action: resolved.action, arg: resolved.arg, inventory: inv, pos: p, newCell: !this.memory.cellAt(cx, cz), result }));
      if (this.loopHist.length > (nc.netWindow ?? 10) + 1) this.loopHist.splice(0, this.loopHist.length - ((nc.netWindow ?? 10) + 1));
    }
    this.social.onActionResult(resolved.action, result.ok, { repeatedFail: !result.ok && troubles.some((t) => t.key === key) });
    this.social.onActionNeeds(resolved.action, resolved.arg, result, tick);
    const divisionAct = this.division ? this.division.noteAction(resolved.action, resolved.arg, !!result.ok) : null;
    this.toolWantAfter(resolved, result, tick);
    this.lastResult = `${plannedText}→${result.ok ? '成功' : '失敗'}: ${result.msg}`;
    // 英語 (Jev 用。同じ結果と、行動の前後の持ち物の差から)。記憶のやったことにも英語の文を残す
    this.lastResultEn = en.resultEn({ action: resolved.action, arg: resolved.arg, ok: result.ok, msg: result.msgEn || result.msg, delta: en.invDelta(raw.inventory, inv) });
    ev.en = this.lastResultEn;
    if (this.reflect) {
      const g = this.goalPath && this.goalPath.goal;
      const near = peopleOf(raw).filter((e) => e.d <= this.reflect.cfg.nearDist).map((e) => e.name);
      this.reflect.note({ tick, day: raw.self.day, timeOfDay: raw.self.timeOfDay, pos: raw.self.pos, action: resolved.action, arg: resolved.arg, ok: !!result.ok,
        goal: g ? (g.kind === 'item' ? g.target : g.kind === 'state' ? g.target : g.target) : null, need: g ? g.need : null, near });
      if (result.ok && resolved.action === 'give' && result.gave) this.reflect.noteEvent({ kind: 'gave', tick, to: result.gave.to, item: result.gave.item, count: result.gave.n });
      for (const h of raw.heard) if (h.from !== cfg.persona.name) this.reflect.noteEvent({ kind: 'heard', tick, from: h.from, text: h.text });
    }

    // 教わった答えを使ったか
    const uses = [];
    for (const p of [...this.pendingUse]) {
      const how = ask.answerUse(p, resolved, result);
      if (how || tick >= p.until) {
        this.pendingUse.splice(this.pendingUse.indexOf(p), 1);
        const u = { event: 'answer_use', id: p.id, from: p.from, key: p.key, used: !!how, how: how || null, loop: loopNo, action: resolved.action, arg: resolved.arg };
        this.recorder.write(u);
        uses.push(u);
      }
    }

    const met = goalMet(cfg.goal, inv, raw);
    const stepSt = steps ? stepStatus(steps, raw).map((s) => s.done) : null;
    this.memory.extra.social = this.social.toJSON();
    if (this.division) this.memory.extra.division = this.division.toJSON();
    if (this.toolWant) this.memory.extra.toolWant = this.toolWant.toJSON();
    if (this.experience) this.memory.extra.experience = this.experience.toJSON();

    this.recorder.write({
      loop: loopNo,
      pos: raw.self.pos,
      timeOfDay: bot.time ? bot.time.timeOfDay : null,
      day: bot.time ? bot.time.day : null,
      obs: ctx.obsText,
      memText: ctx.memText,
      memSelection: this.memory.lastSelection || null,
      forgotten,
      social: { words: socialText, emotions: this.social.emotions, needs: this.social.needs, stress: this.social.stress, worst: worst ? worst.need : null, aff: affinityOf(this.social) },
      troubles: troubles.map((t) => t.key),
      troubleKinds: troubles.map((t) => t.kind),
      stateChanged,
      netNoChange: net && net.keys.size ? { keys: [...net.keys], counts: net.counts, scope: net.scope } : null,
      factsShown: ctx.factsShown && ctx.factsShown.length ? ctx.factsShown : null,
      actions: ctx.actions.map((a) => (a.choices ? `${a.name}:${a.choices.length}` : a.name)),
      progress: ctx.progress || null,
      goalUpdated: goalUpdate ? goalUpdate.reason : null,
      planUpdated: planUpdate,
      reflected,
      policy: ctx.policy || null,
      role: ctx.role || null,
      division: divisionSnap ? { ...divisionSnap, act: divisionAct } : null,
      toolWant: this.toolWant ? { ...this.toolWant.snapshot(), voice: voiced || null } : null,
      planStep: this.goalPlan && this.goalPlan.goal ? { goal: this.goalPlan.goal.n, idx: this.goalPlan.idx, of: this.goalPlan.steps.length } : null,
      goalPath: this.goalPath && this.goalPath.goal ? { goal: this.goalPath.goal.n, kind: this.goalPath.goal.kind, target: this.goalPath.goal.target, met: this.goalPath.goal.metAt != null,
        next: this.goalPath.path && this.goalPath.path.next ? this.goalPath.path.next.item : null, steps: this.goalPath.path && this.goalPath.path.ok ? this.goalPath.path.steps.length : null } : null,
      steps: stepSt,
      promptChars: dec.promptChars,
      promptTokens: dec.promptTokens ?? null,
      completionTokens: dec.completionTokens ?? null,
      cachedTokens: dec.cachedTokens ?? null,
      rawOutput: dec.rawOutput,
      think: dec.think ?? null,
      jev: dec.jev || null,
      talkThreshold: talkThr,
      parseOk: !!dec.parseOk,
      repaired: !!dec.repaired,
      valid,
      invalidReason: valid ? null : resolved.error,
      argFixed: !!resolved.fixed,
      action: resolved.action,
      arg: resolved.arg,
      // 聞いた場所 (人から聞いて覚えた所) への go_to: 誰から聞いたか・どこか (summarize_run の場所の共有)
      heardPlace: resolved.choice && resolved.choice.heardFrom ? { from: resolved.choice.heardFrom, kind: resolved.choice.kind || null, pos: resolved.choice.pos || null } : null,
      // 近くの声: この判断までに拾った・遠くて捨てた・位置が分からず捨てた・最後の位置で判定した数
      chatHeard: this.takeChatCount(),
      say: said,
      result,
      obsMs,
      decideMs: dec.latencyMs,
      actMs,
      talk: dec.talk || null,
      board: bview ? { shown: this.boardView.shown.map((m) => `${m.from}:${m.why}`), open: Object.values(this.boardView.openMap), votes: votes.map((v) => `${v.id}:${v.yes ? 'yes' : 'no'}`) } : null,
      inventory: inv,
      worn: raw.self.worn && raw.self.worn.length ? raw.self.worn : null, // 着けている防具・もう片方の手 (行動の前。summarize_run の備え)
      foodCount: raw.foodCount,
      // 近くの耕地 (行動の前。summarize_run の畑)
      farm: raw.farm ? { farmland: raw.farm.farmland, wet: raw.farm.wet, dry: raw.farm.dry, planted: raw.farm.planted, dryEmpty: raw.farm.dryEmpty, tillSpots: (raw.farm.till || []).length } : null,
      hutSeen: raw.hut,
      hutTrue: this.trueHut || null,
      goalMet: met,
      // 探しながら歩く: 出した候補の探す物・割り込みの次の判断で寄り道したか (searchAfter)。近くの人の数 (集まりの集計)
      searchOffer: searchInfo ? { what: searchInfo.primary, names: searchInfo.names, dist: searchInfo.dist, continue: searchInfo.hasContinue } : undefined,
      searchAfter: searchAfter || undefined,
      nearPeople: nearCounts(raw),
      // わだかまりのある相手 { 名前: 大きさ }・近くの人 [{ n, d }]・候補に出た悪い関係の行動 (tools/conflict_stats.js)
      conflict: this.conflict.on ? this.conflict.snapshot() : undefined,
      // 所有: 知っている物の数・返していない取得・気づいた損・意図/取得/関係の変化の数。take_placed の候補の重み (係数の内訳)。この判断の意図の id
      own: this.own.ledger || this.own.on ? { ...this.own.snapshot(), intent: intent ? intent.id : null, gossip: gossip || undefined,
        weights: Object.keys(ownWeightInfo).length ? ownWeightInfo : undefined, reweight: this.own.cfg.reweight } : undefined,
    });
    this.memory.save();
    this.log(`[${bot.username}] #${loopNo} ${valid ? '' : '(fallback) '}${resolved.action}(${resolved.arg}) -> ${result.ok ? 'OK' : 'NG'} ${result.msg}${said ? ` / say「${said}」` : ''} [decide ${dec.latencyMs}ms, act ${actMs}ms]`);
    if (stuckNow) await this.recoverStuck(loopNo, tick, resolved, move);
    return { met };
  }

  // 探しながら歩く (search.js) の候補を ctx.actions に足す。返り値 { primary, names, dist, hasContinue } | null
  addSearchAction(ctx, raw, tick) {
    ctx.actions = ctx.actions.filter((a) => a.name !== 'search');
    const c = this.searchCfg;
    if (!c.enabled || !this.goalPath || !this.goalPath.pathNext()) return null;
    if (c.disabledWhen && ctx.actions.some((a) => a.name === c.disabledWhen)) return null;
    const visible = new Set([...raw.blocks.map((b) => b.name), ...raw.entities.map((e) => e.name)]);
    const targets = searchMod.searchTargets(this.goalPath.path, visible);
    if (!targets) return null;
    const st = this.searchState && tick - this.searchState.tick <= c.continueTicks ? this.searchState : null;
    if (!st) this.searchState = null;
    const T = this.division && this.division.T ? this.division.T.exploring : 0;
    const dist = searchMod.searchDistance(T, c);
    const cellSize = this.memory.limits.exploreCell;
    const act = searchMod.searchAction({ cfg: c, targets, here: raw.self.pos, cells: this.memory.cells, othersCells: searchMod.othersCells(this.memory, cellSize), cellSize, dist, name: this.cfg.persona.name, active: st });
    if (!act) return null;
    ctx.actions.push(act);
    return { primary: targets.primary, names: targets.names.slice(0, c.maxNames), dist, T: T ?? null, hasContinue: act.choices.some((ch) => ch.id === 'continue') };
  }

  // 歩いている間の見張りの材料 (act.js の search)。歩き始めたときに呼ぶ
  searchWatch(info, tick) {
    const c = this.searchCfg;
    const start = new Set(this.heardBuf);
    const known = new Set(Object.entries(this.peopleSeenAt).filter(([, t]) => tick - t <= c.newPersonTicks).map(([n]) => n));
    return { names: new Set(info ? info.names : []), me: this.bot ? this.bot.username : this.cfg.persona.name, hostileRadius: c.hostileRadius,
      visionRadius: this.cfg.perception.visionRadius ?? 16, known, heard: () => this.heardBuf.filter((h) => !start.has(h)) };
  }

  // search の結果で続きの状態を持つ。割り込みの次の判断で「寄り道したか・そのまま進んだか」を返す (記録用)
  afterSearch(resolved, result, tick) {
    let after = null;
    const st = this.searchState;
    if (st && st.awaiting) {
      const cont = resolved.action === 'search' && resolved.arg === 'continue';
      after = { interrupt: st.interrupt.kind, what: st.interrupt.what, choice: cont ? 'continue' : resolved.action === 'search' ? 'other_direction' : 'detour', action: `${resolved.action}:${resolved.arg}` };
      st.awaiting = false;
    }
    if (resolved.action === 'search') {
      const s = result.search;
      if (s && s.interrupt && s.left >= this.searchCfg.minLeft) {
        this.searchState = { dir: s.dir, target: s.target, what: s.what, tick, awaiting: true, interrupt: s.interrupt };
      } else this.searchState = null;
    }
    return after;
  }

  // 選択肢の重みの材料: 下げない人 (ゴールの人・最近呼んだ/頼んだ人)、ゴール・道筋に関係する場所の種類と位置
  weightContext(tick) {
    const exemptPeople = new Set();
    const calledPeople = new Set();
    const relatedKinds = new Set();
    const relatedPos = [];
    const g = this.goalPath && this.goalPath.goal;
    if (g && g.metAt == null && g.kind === 'person' && g.target) exemptPeople.add(g.target);
    for (const [n, t] of Object.entries(this.calledBy)) if (tick - t <= this.cwCfg.exemptTicks) calledPeople.add(n);
    if (g && g.metAt == null) {
      if (g.kind === 'place') { if (g.pos) relatedPos.push(g.pos); if (g.place && g.place.kind) relatedKinds.add(g.place.kind); }
      if (g.kind === 'item' && g.target) relatedKinds.add(g.target);
      const p = this.goalPath.path;
      if (p && p.ok) {
        for (const s of [p.next, ...(p.steps || [])]) {
          if (!s) continue;
          for (const k of [s.item, s.from, s.station, s.crop, s.seed, s.animal]) if (k) relatedKinds.add(k);
          if (s.water) relatedKinds.add('water');
          if (s.how === 'farm') relatedKinds.add('farmland');
        }
      }
    }
    // explore の行き先のうち、よく行った範囲を通るだけのもの (choiceWeights.visited) を下げるための今いる所と踏破
    const here = this.bot && this.bot.entity ? this.bot.entity.position : null;
    return { exemptPeople, calledPeople, relatedKinds, relatedPos, here: here ? { x: here.x, z: here.z } : null, cells: this.memory.cells, cellSize: this.memory.limits.exploreCell };
  }

  // 行動の結果から、あとでやること (prospect.js) を足す・済んだにする。記録は event 'prospect'
  //   植えた (result.farm.plant) → crop。かまどに入れたまま (result.smelt の took < n) → smelt。取り出した → 済んだ。
  //   動物に好きな餌 (result.bred) → breed_again (大人のとき)、子どもが生まれた → grow_up。作物が持ち物に増えた → その近くの crop は済んだ
  noteProspects(resolved, result, invBefore, invAfter, tick) {
    const now = this.memory.gameNow;
    if (!Number.isFinite(now) || !result) return;
    const pr = this.memory.prospects;
    const out = [];
    const add = (kind, o) => { const r = pr.add(kind, { ...o, now, loop: tick }); if (r) out.push({ op: r.merged ? 'merge' : 'add', id: r.item.id, kind, what: r.item.what, n: o.n, total: r.item.n, pos: r.item.pos, dueMin: r.item.dueMin, dueMax: r.item.dueMax, start: r.item.start, loop: tick }); };
    const fm = result.farm;
    if (result.ok && fm && fm.plant && fm.pos) add('crop', { pos: fm.pos, n: fm.n || 1, what: { crop: fm.plant, ...(fm.wet != null ? { wet: fm.wet } : {}) } });
    const sp = result.sapling;
    if (result.ok && sp && sp.pos) add('sapling', { pos: sp.pos, n: 1, what: { sapling: sp.name, ...(SAPLING_LOG[sp.name] ? { log: SAPLING_LOG[sp.name] } : {}) } });
    const sm = result.smelt;
    if (sm && sm.at) {
      if (sm.took > 0) out.push(...pr.furnaceTaken(sm.at, now, tick));
      if (sm.n - (sm.took || 0) > 0) add('smelt', { pos: sm.at, n: sm.n - (sm.took || 0), what: { input: sm.input, ...(sm.output ? { output: sm.output } : {}) } });
    }
    if (result.ok && result.furnace && result.furnace.at && result.furnace.taken > 0) out.push(...pr.furnaceTaken(result.furnace.at, now, tick));
    const br = result.bred;
    if (br && br.pos) {
      if (br.adult) add('breed_again', { pos: br.pos, n: 1, what: { animal: br.animal } });
      if (br.babies > 0) add('grow_up', { pos: br.pos, n: br.babies, what: { animal: br.animal } });
    }
    const gained = {};
    const cnt = (l) => { const m = {}; for (const i of l || []) m[i.name] = (m[i.name] || 0) + i.count; return m; };
    const a = cnt(invBefore); const b = cnt(invAfter);
    for (const k of Object.keys(b)) if (b[k] > (a[k] || 0)) gained[k] = b[k] - (a[k] || 0);
    if (Object.keys(gained).length && /^(collect|use_on|pick_up)$/.test(resolved.action) && this.bot && this.bot.entity) out.push(...pr.harvested(this.bot.entity.position, gained, now, tick));
    for (const e of out) this.recorder.write({ event: 'prospect', ...e, gameTime: now, action: resolved.action, arg: resolved.arg });
  }

  // 夜の外歩きの危なさ: 夜のあいだだけ、先のつらさ (anticipate.js) の夜の見込み risk (自分の夜の経験で上がる)。昼は 0
  nightRisk() {
    const nm = this.social && this.social.needsModel;
    const d = nm && nm.ant ? nm.ant.detail : null;
    return d && d.night && d.night.isNight && Number.isFinite(d.night.risk) ? d.night.risk : 0;
  }

  // 困りごと (key = "action:arg") の M 番号を、その行動をしたときの場所 (出来事に残した mpos) で返す。無ければ null (今の一覧を使う)
  placesOfKey(key) {
    const ev = [...this.memory.events].reverse().find((e) => `${e.action}:${e.arg}` === key && e.mpos);
    return ev ? placesFromMpos([ev.mpos]) : null;
  }

  // 思い出した記憶 (ask.relevantMemories の { kind, text, ... }) の M 番号を、その出来事のときの場所で返す。
  //   出来事に場所が残っていない番号は、今の一覧 (lastMemPlaces) で補う。同じ番号が別の場所なら先に出た記憶 (関係の強い方) を使う
  placesOfMemories(mems) {
    const maps = [];
    for (const m of mems || []) if (m && m.mpos) maps.push(m.mpos);
    if (!maps.length) return null;
    const own = placesFromMpos(maps);
    const cur = (this.lastMemPlaces || []).filter((p) => !own.some((q) => q.id === p.id));
    return [...own, ...cur];
  }

  // 発言の中の M 番号 (自分だけの覚えている場所の番号) を、相手に通じる共通の呼び方 (places.js: 出現地点から北東に40m) に置き換える。
  //   places: その文を作ったときの覚えている場所 (M 番号の付いた一覧)。置き換えたら記録 (event m_replaced: 元の文と置き換え後)
  refPlaces(text, { places = null, via = 'chat' } = {}) {
    const r = replaceMRefs(text, places || this.lastMemPlaces || [], this.memory.origin);
    if (r.n) this.recorder.write({ event: 'm_replaced', via, loop: this.memory.tick, original: String(text), replaced: r.text, n: r.n, ids: r.ids });
    return r.text;
  }

  // 耕した所 (act_more が memory.extra.tilled に入れる) が土に戻ったかを見る。戻っていたら記録 (farmland_reverted) して一覧から外す。
  //   読み込まれていない所 (blockAt が null) はそのまま残す。耕地でも土でもない物になっていたら外すだけ
  checkTilled(bot, tick, raw = null) {
    const ex = this.memory.extra || {};
    const list = ex.tilled;
    if (!Array.isArray(list) || !list.length || !bot || typeof bot.blockAt !== 'function') return;
    const keep = [];
    for (const p of list) {
      let b = null;
      try { b = bot.blockAt(new Vec3(p.x, p.y, p.z)); } catch (_) { b = null; }
      if (!b || b.name === 'farmland') { keep.push(p); continue; }
      if (b.name === 'dirt') {
        let wet = null;
        try { wet = farmwater.waterWithin((x, y, z) => bot.blockAt(new Vec3(x, y, z)), p); } catch (_) { wet = null; }
        // 原因を調べる材料: 真上のブロック (固いブロックを置くと土に戻る)・近くの人 (踏む・跳ぶ)・自分の位置 (上に立っているか)・直前の自分の行動
        let above = null;
        try { const ab = bot.blockAt(new Vec3(p.x, p.y + 1, p.z)); above = ab ? ab.name : null; } catch (_) { above = null; }
        const me = bot.entity ? bot.entity.position : null;
        const near = raw ? peopleOf(raw).filter((e) => e.pos && Math.hypot(e.pos.x - (p.x + 0.5), e.pos.z - (p.z + 0.5)) <= 3).map((e) => ({ name: e.name, d: Math.round(Math.hypot(e.pos.x - (p.x + 0.5), e.pos.z - (p.z + 0.5)) * 10) / 10, dy: Math.round((e.pos.y - p.y) * 10) / 10 })) : [];
        const last = this.memory.events[this.memory.events.length - 1] || null;
        this.recorder.write({ event: 'farmland_reverted', loop: tick, pos: { x: p.x, y: p.y, z: p.z }, tilledAt: p.t ?? null, nearWater: wet, above,
          selfOnTop: !!(me && Math.floor(me.x) === p.x && Math.floor(me.z) === p.z && me.y - p.y >= 0.9 && me.y - p.y <= 2), selfD: me ? Math.round(Math.hypot(me.x - (p.x + 0.5), me.z - (p.z + 0.5)) * 10) / 10 : null,
          near, lastAction: last ? `${last.action}:${last.arg}` : null });
      }
    }
    ex.tilled = keep;
  }

  // 動けない: 回復手順 (unstuck.recover)。駄目なら同じ名前で入り直す。記録は event 'unstuck'
  async recoverStuck(loopNo, tick, resolved, move) {
    const c = this.unstuckCfg;
    const bot = this.bot;
    const pos = bot.entity ? { x: Math.round(bot.entity.position.x * 10) / 10, y: Math.round(bot.entity.position.y * 10) / 10, z: Math.round(bot.entity.position.z * 10) / 10 } : null;
    let rec;
    try { rec = await unstuck.recover(bot, c); } catch (e) { rec = { ok: false, how: `回復の途中で失敗: ${String(e.message).slice(0, 40)}`, steps: [] }; }
    let reconnect = null;
    if (!rec.ok && c.reconnect) {
      reconnect = await this.reconnect('unstuck');
      if (reconnect.ok) rec = { ...rec, ok: true, how: '入り直したら動けるようになった' };
    }
    this.stuck.noteRecovery(tick, rec);
    const ev = { event: 'unstuck', loop: loopNo, tick, pos, action: resolved.action, arg: resolved.arg, move, ok: !!rec.ok, how: rec.how, moved: rec.moved ?? null,
      steps: rec.steps, dug: rec.dug || null, returning: !!rec.returning, reconnect };
    this.recorder.write(ev);
    this.log(`[${this.cfg.persona.name}] 動けない → ${rec.ok ? '回復' : '回復できず'}: ${rec.how}${reconnect ? ` (入り直し ${reconnect.ok ? 'OK' : 'NG'})` : ''}`);
    return ev;
  }

  // 同じ名前で入り直す。記憶・欲求・ゴール・Board・拠点はこの Agent が持ったまま (bot だけ作り直す)
  async reconnect(reason = 'reconnect') {
    const c = this.unstuckCfg;
    const old = this.bot;
    const t0 = Date.now();
    const base = this.base;
    const wasStopped = this.stopped;
    this.reconnects += 1;
    if (old) {
      // 古い bot の end/kicked は数えない (stopped を立てない・run.js の切断にも数えない)
      old.removeAllListeners('end'); old.removeAllListeners('kicked'); old.on('error', () => {});
      try { old.quit(reason); } catch (_) { /* ignore */ }
    }
    await sleep(c.reconnectWaitMs);
    let ok = false; let err = null;
    for (let i = 0; i < 2 && !ok; i++) {
      let timer;
      try {
        await Promise.race([this.connect({ again: true }), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('接続のタイムアウト')), c.reconnectTimeoutMs); })]).finally(() => clearTimeout(timer));
        ok = true;
      } catch (e) {
        err = String(e.message).slice(0, 80);
        const b = this.bot;
        if (b && b !== old) { b.removeAllListeners('end'); b.removeAllListeners('kicked'); b.on('error', () => {}); try { b.end('retry'); } catch (_) { /* ignore */ } }
        await sleep(c.reconnectWaitMs);
      }
    }
    if (base) this.base = base;
    this.stopped = ok ? wasStopped : true;
    return { ok, reason, ms: Date.now() - t0, error: err, n: this.reconnects };
  }

  startRecord(extra = {}) {
    const cfg = this.cfg;
    const t = this.bot && this.bot.time;
    this.recorder.write({
      event: 'start', order: { shuffle: this.order.enabled, runSeed: this.runSeed, seed: this.order.seed }, jevStateLang: this.decider && this.decider.lang ? this.decider.lang : null, persona: cfg.persona, goal: cfg.goal, decider: this.decider.kind, talker: this.talker ? this.talker.kind : null,
      help: this.help, perception: cfg.perception, memoryLimits: this.memory.limits, base: this.base, world: cfg.world || null,
      talk: cfg.talk || null, askCfg: cfg.ask || null, noChangeCfg: this.help.noChange ? noChangeCfg(cfg) : null,
      explore: { ...((cfg.act && cfg.act.explore) || { mode: 'basic' }), cell: this.memory.limits.exploreCell }, timeOfDay: t ? t.timeOfDay : null, day: t ? t.day : null,
      conflict: { grudge: this.conflict.cfg.grudge, actions: this.conflict.cfg.actions, aggression: this.conflict.cfg.aggression, threshold: this.conflict.cfg.threshold, hits: this.conflict.cfg.hits },
      provenance: { ledger: !!this.own.ledger, actions: this.own.on, penalty: !!this.own.cfg.penalty, reweight: this.own.cfg.reweight, social: this.own.cfg.social, emergencyNeed: this.own.cfg.emergencyNeed, speech: this.own.cfg.speech }, ...extra,
    });
  }

  async run(extra = {}) {
    const cfg = this.cfg;
    const end = Date.now() + cfg.loop.minutes * 60000;
    this.startRecord(extra);
    let loopNo = 0;
    while (!this.stopped && Date.now() < end) {
      loopNo += 1;
      try {
        const { met } = await this.step(loopNo);
        if (met && !this.goalAt) {
          this.goalAt = loopNo;
          const t = this.bot.time;
          this.recorder.write({ event: 'goal', loop: loopNo, timeOfDay: t ? t.timeOfDay : null, day: t ? t.day : null });
          this.log(`[${this.bot.username}] goal reached at loop ${loopNo}`);
          if (cfg.loop.stopOnGoal) break;
        }
      } catch (e) {
        this.log(`[${this.bot && this.bot.username}] step error: ${e.stack || e.message}`);
        this.recorder.write({ loop: loopNo, error: String(e.message) });
        await sleep(2000);
      }
      if (this.meter && this.meter.exceeded) { this.stopped = true; this.recorder.write({ event: 'token_cap', loop: loopNo, usage: this.meter.summary() }); }
      await sleep(cfg.loop.pauseMs);
    }
    // 発言・答えの途中なら少し待つ (記録を閉じる前に)
    for (let i = 0; i < 60 && (this.talking || this.answering); i++) await sleep(250);
    this.recorder.write({ event: 'end', loops: loopNo, goalAt: this.goalAt, deaths: this.deaths.length, selfGoals: this.selfGoal ? this.selfGoal.history.length : null, goalPlan: this.goalPlan ? { counts: this.goalPlan.counts, history: this.goalPlan.history } : null, goalPath: this.goalPath ? { counts: this.goalPath.counts, history: this.goalPath.history } : null, reflect: this.reflect ? { count: this.reflect.count, history: this.reflect.history } : null, division: this.division ? { exp: this.division.exp, fam: this.division.fam(), roles: Object.fromEntries(Object.keys(this.division.roles).map((n) => [n, this.division.rolesOf(n)])) } : null, experience: this.experience ? this.experience.snapshot() : null, baseSite: this.baseSeen ? this.baseSeen.site : null, memoryForgotten: this.memory.forgotten, social: this.social.toJSON(), board: this.board ? this.board.snapshot() : null });
    this.memory.extra.social = this.social.toJSON();
    this.memory.save();
    await this.recorder.close();
    try { this.bot.quit(); } catch (_) { /* ignore */ }
    return { name: cfg.persona.name, loops: loopNo, goalAt: this.goalAt, recordFile: this.recorder.file };
  }

  stop() { this.stopped = true; }
}

module.exports = { obsEn, JEV_STATE_DEFAULTS, Agent, buildContext, factsOpts, updateMemoryFromObservation, goalMet, DEFAULT_HELP };
