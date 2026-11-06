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
const { listActions, resolveDecision } = require('./actions');
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
const { Reflect } = require('./reflect');
const { baseSite, baseSiteText, baseSiteTextEn } = require('./basesite');
const { isPlaceableBlockItem } = require('./planner');
const { OthersLog, DEFAULTS: OTHERS_DEFAULTS } = require('./others');
const knowledge = require('./knowledge');
const { Board, DEFAULTS: BOARD_DEFAULTS, parseLine, line: boardLine, chestLabelJa } = require('./board');
const { jaName, SUFFIX: JA_SUFFIX } = require('./names_ja');
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
function obsEn(raw, cfg, planText) {
  const js = jevStateCfg(cfg);
  return observationEn(raw, { names: knowledge.namesInText(planText), maxVisible: js.maxVisible, maxNearby: js.maxNearby, showDay: cfg.perception.showDay });
}

// use_on の畑の対象: 近くの空いている耕地・育ちきった作物 (farm = states.farmStatus) と、覚えている耕地・作物の場所 (cfg.act.farmRadius m 以内)
const FARM_PLACE = /^(farmland|wheat|carrots|potatoes|beetroots)$/;
function farmTargets(raw, memPlaces, farm, cfg) {
  const out = [];
  if (farm) {
    if (farm.emptyPos && farm.emptyPos.length) out.push({ name: 'farmland', idName: 'farmland@empty', pos: farm.emptyPos[0], note: '空いている', noteEn: 'empty' });
    for (const [crop, ps] of Object.entries(farm.cropPos || {})) {
      const r = ps.find((q) => q.ripe);
      if (r) out.push({ name: crop, idName: `${crop}@ripe`, pos: r, note: '育ちきった', noteEn: 'fully grown' });
    }
  }
  const far = (cfg.act && cfg.act.farmRadius) ?? 48;
  for (const p of memPlaces || []) {
    if (!FARM_PLACE.test(p.kind) || p.d > far || p.d < 4) continue;
    out.push({ name: p.kind, idName: `${p.kind}@${p.id}`, pos: p.pos, note: `覚えている所 ${p.id}`, noteEn: `remembered place ${p.id}` });
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
  const memPlaces = memory.placesForPrompt(here, visibleNotable);
  // ④ 失敗の除外 (段階1)。first_setting では外し、代わりに「聞く」を使う
  const blocked = help.excludeFailures ? memory.recentFailures(cfg.loop.failWindow ?? 4, cfg.loop.failRepeat ?? 2) : new Set();
  const nc = help.noChange ? noChangeCfg(cfg) : null;
  const troubles = extra.troubles || (help.askOthers ? ask.troubles(memory, cfg.loop.failWindow ?? 4, cfg.loop.failRepeat ?? 2, nc) : []);
  const actions = listActions(raw, {
    memPlaces, foods: extra.foods, placeable: extra.placeable, blocked, maxReachUp: cfg.act.maxReachUp,
    goalItems: new Set(Object.keys((cfg.goal.success && cfg.goal.success.inventory) || {})),
    base: extra.base || null, hut: raw.hut || null, troubles, hearRadius: cfg.perception.hearRadius,
    disabled: new Set((cfg.act && cfg.act.disabled) || []), enable: new Set((cfg.act && cfg.act.enable) || []),
    selfBase: !!(cfg.world && cfg.world.base === 'self'), fleeRadius: cfg.act.fleeRadius,
    // 入れ物の中身・村人の取引 (開けて見たときに覚えたもの。act_more.js)。use_on などの候補の絞り方 (cfg.act)
    containers: (memory.extra && memory.extra.containers) || {}, trades: (memory.extra && memory.extra.trades) || {},
    collectExclude: collectExcludeOf(cfg),
    useOnSkip: cfg.act.useOnPlaceable === false ? (n) => isPlaceableBlockItem(n, (cfg.server && cfg.server.version) || undefined) : null,
    visionRadius: cfg.perception.visionRadius, followMs: cfg.act.followMs, useRadius: cfg.act.useRadius, maxUseChoices: cfg.act.maxUseChoices, maxGiveChoices: cfg.act.maxGiveChoices,
    explore: { ...((cfg.act && cfg.act.explore) || {}), distance: cfg.act.exploreDistance ?? 20, cells: memory.cells, cellSize: memory.limits.exploreCell, tick: memory.tick },
    board: extra.boardActs || null,
    farmTargets: farmTargets(raw, memPlaces, extra.farm || null, cfg),
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
  const enCtx = {
    obs: obsEn(raw, cfg, prog),
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
    obsText: summarizeObservation(raw, { maxTypes: cfg.perception.maxTypes, showDay: cfg.perception.showDay }) + (extra.baseText ? `\n${extra.baseText}` : ''),
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
  for (const h of raw.heard) memory.noteHeard(h.from, h.text);
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
    this.social = Social.fromJSON(this.memory.extra.social, { temperament: cfg.persona.temperament, needs: needsConfig(cfg, cfg.persona) });
    this.recorder = new Recorder(recordDir || cfg.record.dir, cfg.persona.name, recordStamp);
    this.heardBuf = [];
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
      ? new SelfGoal({ cfg: cfg.selfGoal || {}, llmOpts: { ...cfg.decider.llm, ...((cfg.selfGoal && cfg.selfGoal.llm) || {}) }, meter })
      : null;
    this.lastGoalDoneP = null;
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
      ? new GoalPlan({ cfg: cfg.goalPlan || {}, llmOpts: { ...cfg.decider.llm, ...((cfg.goalPlan && cfg.goalPlan.llm) || {}) }, meter,
        jev: decider && decider.kind === 'jev' ? decider : null, log: (e) => this.recorder.write({ event: 'goal_plan', ...e }) })
      : null;
    // ゴール (2B) → 道筋 (planner) → 行動 (Jev) (help.goalPath。goalpath.js)。goalPlan より先に見る
    if (this.help.goalPath) {
      this.goalPlan = null;
      this.goalPath = new GoalPath({ cfg: cfg.goalPath || {}, llmOpts: { ...cfg.decider.llm, ...((cfg.goalPath && cfg.goalPath.llm) || {}) }, meter,
        jev: decider && decider.kind === 'jev' ? decider : null, order: this.order,
        log: (e) => { this.recorder.write({ event: 'goal_path', ...e }); if (this.reflect) this.reflect.noteGoal(e); } });
    } else this.goalPath = null;
    // 振り返りと方針 (cfg.reflect。reflect.js)。ゴール (help.goalPath) と一緒に使う
    this.reflect = cfg.reflect && cfg.reflect.enabled !== false && this.goalPath
      ? new Reflect({ cfg: cfg.reflect, llmOpts: { ...cfg.decider.llm, ...((cfg.reflect && cfg.reflect.llm) || {}) }, meter, log: (e) => this.recorder.write({ event: 'reflect', ...e }) })
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
    for (const ev of evs) {
      if (ev.type === 'agreed') {
        const p = ev.p;
        this.recorder.write({ event: 'board', kind: 'agreed', id: p.id, by: p.by, text: p.text, spec: p.spec, yes: [...p.yes], no: [...p.no], n: p.n, need: this.board.need(p), loop: tick });
        // 全員の記憶に残す (時間とともに薄れる)。state の agreements / projects には成立している間ずっと出る
        this.memory.noteHeard(p.by, `(${p.spec.type === 'project' ? '共同の目標' : '取り決め'}になった) ${p.text}`, 0.9, { global: true, at: this.phaseSafe() });
      } else if (ev.type === 'share') {
        this.memory.notePlace(chestLabelJa(ev.c.id), ev.c.pos, { imp: 1 });
        this.recorder.write({ event: 'board', kind: 'share', chest: ev.c.id, by: ev.c.by, pos: ev.c.pos, loop: tick });
      } else if (ev.type === 'chest') {
        // 共有のチェストの中身は全員に見えている事実: chest_take の候補 (入れ物の記憶) も同じ中身にする
        const ex = this.memory.extra || (this.memory.extra = {});
        ex.containers = ex.containers || {};
        ex.containers[`${ev.c.pos.x},${ev.c.pos.y},${ev.c.pos.z}`] = { name: 'chest', items: ev.c.items, tick, shared: ev.c.id };
        if (from !== me && ev.delta) this.recorder.write({ event: 'board', kind: 'chest_seen', chest: ev.c.id, who: ev.who, delta: ev.delta, loop: tick });
      } else if (ev.type === 'breach') {
        this.recorder.write({ event: 'board', kind: 'breach_known', agreement: ev.p.id, who: ev.b.who, chest: ev.b.chest, item: ev.b.item, n: ev.b.n, loop: tick });
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
      this.recorder.write({ event: 'board', kind: 'seen', from: m.from, to: me, msgKind: m.kind, pid: m.pid || null, text: m.text, why: m.why, hit: m.hit, loop: tick });
    }
    const open = this.board.openFor(me, this.boardAsked);
    const en0 = this.board.stateEn({ me, tick, here, shown, open, relationEn: (n) => this.social.relationWord(n, { lang: 'en' }) });
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
    const players = ctx.raw.entities.filter((e) => e.kind === 'player');
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
    const say = r.say ? r.say.replace(/\s+/g, ' ').trim().slice(0, this.boardCfg.textMax) : '';
    this.recorder.write({ event: 'board', kind: 'broadcast', loop: this.memory.tick, say: say || null, rawOutput: r.rawOutput, promptChars: r.promptChars, promptTokens: r.promptTokens, ms: r.ms, error: r.error });
    if (!say) return { ok: false, msg: '全体に言うことが出てこなかった' };
    this.sendBoard(boardLine.say(say));
    this.memory.noteHeard('自分', say, 0.1, { global: true });
    this.social.onSpoke(this.memory.tick);
    this.log(`[${this.cfg.persona.name}] 全体に「${say}」`);
    return { ok: true, msg: `全員に「${say}」と言った`, said: say };
  }

  async doPropose(ctx) {
    if (!this.talker || !this.board) return { ok: false, msg: '提案する仕組みがない' };
    const raw = ctx.raw;
    const me = this.cfg.persona.name;
    this.lastProposeTick = this.memory.tick;
    const near = raw.blocks.filter((b) => /^(chest|trapped_chest|barrel)$/.test(b.name) && b.nearest.d <= (this.cfg.perception.visionRadius ?? 16)).sort((a, b) => a.nearest.d - b.nearest.d)[0];
    const hereChest = near && !this.board.chestAt(near.nearest) && this.board.chests.size < this.boardCfg.maxShared ? near : null;
    const items = [...new Set([...raw.inventory.map((i) => i.name), ...((this.goalPath && this.goalPath.lastItemNames) || []), ...this.boardNames().filter((n) => /^[a-z0-9_]+$/.test(n)),
      ...[...this.board.chests.values()].flatMap((c) => c.items.map((i) => i.name))])].slice(0, 60);
    const chests = [...this.board.chests.values()].map((c) => ({ id: c.id, text: `${relDir(raw.self.pos, c.pos)}・${this.board.chestItemsText(c, 'ja')}` }));
    const r = await this.talker.propose({ ...this.talkCtx(ctx), items, chests, hereChest: !!hereChest });
    const pr = r.proposal;
    const rec = { event: 'board', kind: 'propose', loop: this.memory.tick, rawOutput: r.rawOutput, promptChars: r.promptChars, promptTokens: r.promptTokens, ms: r.ms, error: r.error };
    if (!pr) { this.recorder.write({ ...rec, ok: false }); return { ok: false, msg: '提案することが出てこなかった' }; }
    // chest: here → 先に共有にして、その id にする
    if (pr.spec.type === 'rule' && pr.spec.chest === 'here') {
      const sh = hereChest ? this.doShareChest({ pos: hereChest.nearest }) : null;
      if (sh && sh.ok) pr.spec.chest = sh.chest; else pr.spec = { type: 'text' };
    }
    const id = `${me}#${this.memory.tick}`;
    const n = this.aliveCount();
    this.sendBoard(boardLine.propose({ id, n, spec: pr.spec, text: pr.text }));
    this.boardAsked.add(id);
    this.recorder.write({ ...rec, ok: true, id, n, need: this.board.proposals.get(id) ? this.board.need(this.board.proposals.get(id)) : null, spec: pr.spec, text: pr.text });
    this.log(`[${me}] 提案 ${id}「${pr.text}」 ${JSON.stringify(pr.spec)}`);
    return { ok: true, msg: `全員に「${pr.text}」と提案した`, proposal: { id, spec: pr.spec, text: pr.text } };
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
    for (const e of raw.entities.filter((x) => x.kind === 'player')) names.add(e.name);
    for (const h of this.memory.heard) if (h.from !== '自分' && h.from !== me) names.add(h.from);
    return [...names].filter((n) => n && n !== me).map((name) => {
      const e = raw.entities.find((x) => x.kind === 'player' && x.name === name);
      const r = this.social.relations[name] || null;
      // affinity・talks・d はゴール選びの候補を上位 N 人に絞る並べ方だけに使う (2B には見せない)
      return { name, relation: this.social.relationWord(name), relationEn: this.social.relationWord(name, { lang: 'en' }), seen: e ? relDir(raw.self.pos, e.pos) : null, seenEn: e ? en.whereEn(raw.self.pos, e.pos) : null,
        affinity: r ? r.affinity : null, talks: r ? r.talks || 0 : 0, helped: r ? (r.helpedMe || 0) + (r.iHelped || 0) : 0, d: e ? e.d : null };
    });
  }

  // ほかの人が拾った物・壊したブロックを見張る (行動の結果の文に足す)
  watchOthers() {
    const bot = this.bot;
    const o = this.others;
    if (!o) return;
    const me = () => (bot.entity ? bot.entity.position : null);
    const nameOf = (e) => (e && e.type === 'player' ? e.username : null);
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
          if (giver && Date.now() - (this.lastReceived || 0) > 5000) { this.lastReceived = Date.now(); this.social.onReceived(giver.username); this.recorder.write({ event: 'received', from: giver.username, item: d.name, count: packet.pickupItemCount || d.count || 1, loop: this.memory.tick }); if (this.reflect) this.reflect.noteEvent({ kind: 'received', tick: this.memory.tick, from: giver.username, item: d.name, count: packet.pickupItemCount || d.count || 1 }); }
        }
        o.notePickup({ who, self: bot.username, me: me(), item: d.name, count: packet.pickupItemCount || d.count || 1, pos: it.position });
      } catch (_) { /* ignore */ }
    });
    bot.on('blockBreakProgressObserved', (block, stage, entity) => {
      const who = nameOf(entity);
      if (who && block) o.noteBreakProgress({ who, self: bot.username, pos: block.position });
    });
    bot.on('diggingCompleted', (block) => { if (block) o.noteMyDig(block.position); });
    bot.on('blockUpdate', (oldB, newB) => {
      try {
        if (!oldB || !newB || oldB.name === newB.name) return;
        // 自分が掘り終えた直後 (mineflayer は掘り終えたとき lastDigTime を新しくしてから空気にする) は自分の分
        const p0 = me();
        if (p0 && bot.lastDigTime && performance.now() - bot.lastDigTime < 500 && newB.position.offset(0.5, 0.5, 0.5).distanceTo(p0) <= 6) o.noteMyDig(newB.position);
        const players = Object.values(bot.players).filter((p) => p.username !== bot.username && p.entity).map((p) => ({ name: p.username, pos: p.entity.position }));
        o.noteBlockGone({ pos: newB.position, oldName: oldB.name, newName: newB.name, me: me(), players });
      } catch (_) { /* ignore */ }
    });
  }

  // again: 入り直し (unstuck)。拠点・記憶・欲求・ゴール・Board はこの Agent が持ったまま、bot だけ作り直す
  connect({ again = false } = {}) {
    const s = this.cfg.server;
    this.bot = mineflayer.createBot({ host: s.host, port: s.port, username: this.cfg.persona.name, version: s.version, auth: 'offline' });
    const bot = this.bot;
    bot.loadPlugin(pathfinder);
    bot.on('chat', (username, message) => this.onChat(username, message));
    // 死んだら: 死因はサーバーの死亡メッセージ (translate が death.〜) から拾う。リスポーンは mineflayer が自動で行う
    bot.on('message', (jsonMsg) => {
      try {
        const key = jsonMsg && jsonMsg.translate;
        if (key && /^death\./.test(key) && String(jsonMsg.toString()).startsWith(bot.username)) this.lastDeathMsg = { key, text: jsonMsg.toString(), t: Date.now() };
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
        if (!again) this.setupBase();
        this.watchOthers();
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

  // 聞こえる範囲 (hearRadius) の中にいる相手の発言だけを拾う。
  onChat(username, message) {
    const bot = this.bot;
    if (!bot || username === bot.username) return;
    // 全体チャットの印のある行は、距離に関係なく全員が受け取る (近くの声には入れない)
    if (this.board) { const m = parseLine(message); if (m) { this.onBoardLine(username, m); return; } }
    const e = bot.players[username] && bot.players[username].entity;
    if (!e || !bot.entity) return;
    const d = dist3(e.position, bot.entity.position);
    if (d > this.cfg.perception.hearRadius) return;
    const text = String(message).slice(0, 120);
    this.heardBuf.push({ from: username, text, d: Math.round(d) });
    if (this.heardBuf.length > 10) this.heardBuf.shift();
    const me = bot.username;
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

  chat(text, { force = false } = {}) {
    const now = Date.now();
    const t = String(text).replace(/\s+/g, ' ').trim().slice(0, 100);
    if (!t) return false;
    if (!force && t === this.lastChat.text && now - this.lastChat.t < 30000) return false;
    if (!force && now - this.lastChat.t < this.cfg.loop.chatMinIntervalMs) return false;
    this.lastChat = { t: now, text: t };
    this.bot.chat(t);
    this.memory.noteHeard('自分', t);
    this.social.onSpoke(this.memory.tick);
    return true;
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
    this.chat(q, { force: true });
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
          const r = await this.talker.answer({ persona: this.cfg.persona, from: q.from, question: q.question, memories: mems });
          twoB = { promptChars: r.promptChars, promptTokens: r.promptTokens, ms: r.ms, error: r.error, rawOutput: r.rawOutput };
          text = r.say || 'ごめん、うまく言えない';
        } else text = mems[0].text;
        this.chat(ask.answerText(q.from, text), { force: true });
        this.social.onAsked(q.from, mems.length > 0, this.memory.tick);
        this.recorder.write({ event: 'answer', from: this.cfg.persona.name, to: q.from, question: q.question, answer: text, known: mems.length > 0 && !ask.isDontKnow(text), memories: mems, twoB, delayMs: Date.now() - q.t });
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
    for (const e of raw.entities.filter((x) => x.kind === 'player')) names.add(e.name);
    for (const h of this.memory.heard) if (h.from !== '自分' && h.from !== me) names.add(h.from);
    const ev = this.others ? this.others.events : [];
    for (const e of ev) names.add(e.who);
    const lines = [];
    for (const name of [...names].filter((n) => n && n !== me).slice(0, maxPeople)) {
      const parts = [`${name}: ${this.social.relationWord(name)}`];
      const seen = raw.entities.find((x) => x.kind === 'player' && x.name === name);
      parts.push(seen ? `今は${relDir(raw.self.pos, seen.pos)}にいる` : '今は見えない');
      const said = this.memory.heard.filter((h) => h.from === name).slice(-heardPer).map((h) => `「${h.text}」`);
      if (said.length) parts.push(`最近の発言 ${said.join(' ')}`);
      const did = {};
      for (const e of ev.filter((x) => x.who === name)) { const k = `${e.name}を${e.kind === 'pickup' ? '拾った' : '壊した'}`; did[k] = (did[k] || 0) + e.count; }
      const dl = Object.entries(did).slice(-3).map(([k, n]) => k.replace('を', `を${n}個`));
      if (dl.length) parts.push(`最近 ${dl.join('・')}`);
      lines.push(parts.join('。'));
    }
    return lines.join('\n');
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
    this.talker.talk(tctx).then((r) => {
      const said = r.say && this.chat(r.say) ? r.say : null;
      this.recorder.write({ event: 'talk', loop, talkP, threshold: Number(thr.toFixed(3)), say: said, rawOutput: r.rawOutput, promptChars: r.promptChars, promptTokens: r.promptTokens, ms: r.ms, error: r.error });
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
    const raw = collectRaw(bot, { ...cfg.perception, isNotable: this.isNotable, heard, craft: this.craftInfo(), exclude: hutKeys });
    raw.hut = this.hutView();
    const ex = this.extras();
    raw.foodCount = raw.inventory.filter((i) => ex.foods.has(i.name)).reduce((s, i) => s + i.count, 0);
    const cell0 = this.memory.cellOf(raw.self.pos);
    const knownCell = this.memory.cellAt(cell0.cx, cell0.cz);
    updateMemoryFromObservation(this.memory, raw);
    for (const h of raw.heard) this.social.onHeard(h.from, tick, h.text);
    const steps = this.help.steps ? cfg.goal.steps : null;
    this.social.tick({ tick, raw, sense: this.senseNeeds(raw, { newCell: !knownCell, cell: knownCell }) });
    const forgotten = this.memory.forget();
    // 困りごと: 同じものを最近聞いたばかりなら、しばらく聞かない
    const cool = (cfg.ask && cfg.ask.cooldown) || 10;
    const nc = this.help.noChange ? noChangeCfg(cfg) : null;
    // 直近 netWindow 回をさかのぼった正味の変化がほぼ0なら、その間に繰り返した行動も「何も変わらなかった」扱い
    const net = nc && nc.net !== false ? nochange.netNoChange(this.loopHist, nc) : null;
    const ncT = nc && net && net.keys.size ? { ...nc, netKeys: net.keys } : nc;
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
    const socialText = this.social.words();
    const worst = this.social.worstNeed();
    const ahead = aheadOf(this.social.needsModel);
    const memPlacesNow = this.memory.placesForPrompt(raw.self.pos, new Set(raw.blocks.filter((b) => b.notable).map((b) => b.name)));
    const baseText = this.goalPath ? this.baseView(raw, memPlacesNow) : '';
    const socialEn = this.social.words({ lang: 'en' });
    const bview = this.prepareBoard(raw);
    // 近くの畑 (空いている耕地・植わっている作物)。use_on の対象・planner の world.farm に使う
    let farm = null;
    try { farm = bot && typeof bot.blockAt === 'function' ? farmStatus((x, y, z) => bot.blockAt(new Vec3(x, y, z)), raw.self.pos) : null; } catch (_) { farm = null; }
    const ctx = buildContext(raw, this.memory, cfg, { ...ex, farm, base: this.base, troubles, socialText, net, knowledge: this.knowledge, lastResult: this.lastResult, baseText, ahead,
      socialEn, lastResultEn: this.lastResultEn, baseEn: this.goalPath ? this.baseEn : '', order: this.order,
      boardEn: bview ? bview.en : null, boardText: bview ? bview.text : '', boardActs: bview ? bview.acts : null,
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
        const pol = await this.reflect.run({ persona: cfg.persona, socialText }, tick, reason);
        reflected = reason;
        if (pol) this.log(`[${cfg.persona.name}] 振り返り (${reason}): ${pol.text} / ${pol.why || ''}`);
      }
      ctx.policy = this.reflect.stateText() || null;
    }
    if (this.goalPath) {
      const kn = this.help.hints ? this.knowledge : null;
      const facts = (text) => (kn && kn.facts.length
        ? knowledge.selectFacts(kn.facts, { ...factsOpts(raw, this.memory, text, null, ahead), names: farmNames(knowledge.namesInView({ raw, actions: ctx.actions, plan: text }), memPlacesNow, farm), max: kn.max }).map((f) => f.text) : []);
      const cellSize = this.memory.limits.exploreCell;
      planUpdate = await this.goalPath.update({
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
        _farm: farm || undefined,
      }, tick, { troubles });
      this.lastGave = [];
      ctx.progress = this.goalPath.planText();
      ctx.en.plan = this.goalPath.planEn();
      ctx.en.obs = obsEn(raw, cfg, ctx.progress);
      ctx.pathNext = this.goalPath.pathNext();
      if (planUpdate) this.log(`[${cfg.persona.name}] ${planUpdate}: ${ctx.progress}`);
    }
    const obsMs = Date.now() - tObs;

    const dec = await this.decider.decide(ctx);
    // 2B が行動を決めた (llm / split) ときは、その呼び出しを 2B の使用量に入れる
    if (this.meter && !dec.jev && dec.promptChars) {
      this.meter.addTwoB({ kind: 'act', promptChars: dec.promptChars, promptTokens: dec.promptTokens, completionTokens: dec.completionTokens, ms: dec.latencyMs, error: dec.parseOk ? null : dec.error });
      if (dec.talk) this.meter.addTwoB({ kind: 'talk', promptChars: dec.talk.promptChars, ms: dec.talk.latencyMs });
    }
    let resolved = dec.parseOk ? resolveDecision(ctx.actions, dec.action, dec.arg) : { ok: false, error: dec.error || 'parse failed' };
    const valid = resolved.ok;
    if (!valid) resolved = { ok: true, action: 'look_around', arg: '', fallback: true, error: resolved.error };

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

    let said = null;
    if (dec.say && resolved.action !== 'say' && this.chat(dec.say)) said = dec.say;
    const before = nochange.snapshot({ inventory: raw.inventory, pos: raw.self.pos, hutFilled: this.trueHut ? this.trueHut.filled : null });
    const tAct = Date.now();
    const othersMark = this.others ? this.others.mark() : 0;
    unstuck.beginAction(bot);
    const result = await executeAction(bot, resolved, {
      ...cfg.act, visionRadius: cfg.perception.visionRadius, memory: this.memory, chat: (t, o) => this.chat(t, o),
      base: this.base, hutShape: this.help.hut === false ? null : ((cfg.world && cfg.world.hut) || {}), ask: (ch) => this.doAsk(ch),
      setBase: () => this.setBase(),
      broadcast: () => this.doBroadcast(ctx), propose: () => this.doPropose(ctx), shareChest: (ch) => this.doShareChest(ch),
    });
    this.afterBoardAction(resolved, result);
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
    if (resolved.action === 'say') said = resolved.arg;
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
    const key = `${resolved.action}:${resolved.arg}`;
    const inv = bot.inventory.items().map((i) => ({ name: i.name, count: i.count }));
    const after = nochange.snapshot({ inventory: inv, pos: bot.entity.position, hutFilled: this.trueHutFilled() });
    const stateChanged = nochange.changed(before, after);
    const ev = this.memory.noteEvent(resolved.action, resolved.arg, result.ok, valid ? result.msg : `(選び方が無効: ${resolved.error}) ${result.msg}`);
    ev.nc = !stateChanged; // 状態が変わらなかった (help.noChange のときだけ困りごと・重みに使う。記録は常に)
    if (nc) {
      const p = bot.entity.position;
      const { cx, cz } = this.memory.cellOf(p);
      this.loopHist.push(nochange.histEntry({ action: resolved.action, arg: resolved.arg, inventory: inv, pos: p, newCell: !this.memory.cellAt(cx, cz), result }));
      if (this.loopHist.length > (nc.netWindow ?? 10) + 1) this.loopHist.splice(0, this.loopHist.length - ((nc.netWindow ?? 10) + 1));
    }
    this.social.onActionResult(resolved.action, result.ok, { repeatedFail: !result.ok && troubles.some((t) => t.key === key) });
    this.social.onActionNeeds(resolved.action, resolved.arg, result, tick);
    this.lastResult = `${plannedText}→${result.ok ? '成功' : '失敗'}: ${result.msg}`;
    // 英語 (Jev 用。同じ結果と、行動の前後の持ち物の差から)。記憶のやったことにも英語の文を残す
    this.lastResultEn = en.resultEn({ action: resolved.action, arg: resolved.arg, ok: result.ok, msg: result.msg, delta: en.invDelta(raw.inventory, inv) });
    ev.en = this.lastResultEn;
    if (this.reflect) {
      const g = this.goalPath && this.goalPath.goal;
      const near = raw.entities.filter((e) => e.kind === 'player' && e.d <= this.reflect.cfg.nearDist).map((e) => e.name);
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
      hutSeen: raw.hut,
      hutTrue: this.trueHut || null,
      goalMet: met,
    });
    this.memory.save();
    this.log(`[${bot.username}] #${loopNo} ${valid ? '' : '(fallback) '}${resolved.action}(${resolved.arg}) -> ${result.ok ? 'OK' : 'NG'} ${result.msg}${said ? ` / say「${said}」` : ''} [decide ${dec.latencyMs}ms, act ${actMs}ms]`);
    if (stuckNow) await this.recoverStuck(loopNo, tick, resolved, move);
    return { met };
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
      explore: { ...((cfg.act && cfg.act.explore) || { mode: 'basic' }), cell: this.memory.limits.exploreCell }, timeOfDay: t ? t.timeOfDay : null, day: t ? t.day : null, ...extra,
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
    this.recorder.write({ event: 'end', loops: loopNo, goalAt: this.goalAt, deaths: this.deaths.length, selfGoals: this.selfGoal ? this.selfGoal.history.length : null, goalPlan: this.goalPlan ? { counts: this.goalPlan.counts, history: this.goalPlan.history } : null, goalPath: this.goalPath ? { counts: this.goalPath.counts, history: this.goalPath.history } : null, reflect: this.reflect ? { count: this.reflect.count, history: this.reflect.history } : null, baseSite: this.baseSeen ? this.baseSeen.site : null, memoryForgotten: this.memory.forgotten, social: this.social.toJSON(), board: this.board ? this.board.snapshot() : null });
    this.memory.extra.social = this.social.toJSON();
    this.memory.save();
    await this.recorder.close();
    try { this.bot.quit(); } catch (_) { /* ignore */ }
    return { name: cfg.persona.name, loops: loopNo, goalAt: this.goalAt, recordFile: this.recorder.file };
  }

  stop() { this.stopped = true; }
}

module.exports = { obsEn, JEV_STATE_DEFAULTS, Agent, buildContext, factsOpts, updateMemoryFromObservation, goalMet, DEFAULT_HELP };
