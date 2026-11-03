'use strict';
// Jev (TypeSafe System One) の decider。1回目の呼び出しに質問をまとめる:
//   next_action (Choice)  その瞬間にできる行動の一覧 ("行動:引数" を選択肢にする) から1つ
//   talk        (Noul)    今、近くの人に話しかけるべきか (高ければ 2B が発言を作る)。近くに人がいないときは聞かない
//   remember    (Score)   直前の出来事 (last_result と heard_now) を覚えておく価値 0〜4 → 記憶の大事さ
//   rel_<n>     (Score)   今聞こえた相手ごとに、その人への気持ちがどう変わったか 0〜4 → 好感
// 対象の多い行動 (collect・go_to・explore・craft など) は1回目では分類1つ ("行動:*") にまとめ、選ばれたら
// 2回目の呼び出し (target、最小限の state) で対象を選ぶ (decider.jev.twoStage。enabled: false で1段)。
// 行動の説明は state.actions に行動の種類ごとに1回だけ書き、選択肢の文は「行動の名前: label」だけにする。
// 公式の資料 (docs.typesafe.ai) の勧め: 質問は小さく分けてまとめて聞く、数の計算はさせない、英語が一番正確。
// そこで質問の文 (instructions) は英語、状態 (state) は観測の日本語のまま渡す。
const { JevClient } = require('../jev_client');
const { estimateTokens } = require('../usage');
const { reweight } = require('../nochange');
const { selectFacts, namesInView } = require('../knowledge');

const MAX_OPTIONS = 255; // Choice の選択肢の上限 (API の制約)

const REMEMBER_LEVELS = [
  'Trivial routine; not worth remembering',
  'Minor detail',
  'Somewhat useful later',
  'Important: a new place, a new way to do something, a failure to avoid, or something a person said',
  'Very important: about the goal, the base, or a person helping or harming `you`',
];
const REL_LEVELS = [
  'Much worse: hostile, insulting, or refused to help',
  'Somewhat worse',
  'No change',
  'Somewhat better: friendly or cooperative',
  'Much better: helped `you` or taught `you` something',
];

// 2段にする設定 (decider.jev.twoStage)。enabled: false で1段 (全部の選択肢を1回に並べる)
//   maxDirect: 対象がこの数以下の行動は1段目にそのまま並べる。direct の行動は数に関係なくそのまま並べる
//   summaryMax: 分類の選択肢の文に書く対象の名前の数
const TWO_STAGE_DEFAULTS = { enabled: true, maxDirect: 3, direct: ['eat', 'sleep', 'flee', 'set_base', 'ask'], summaryMax: 8 };

function twoStageCfg(opt) {
  if (opt === false) return { ...TWO_STAGE_DEFAULTS, enabled: false };
  if (opt === true || opt == null) return { ...TWO_STAGE_DEFAULTS };
  return { ...TWO_STAGE_DEFAULTS, ...opt };
}

// 分類の要約に書く対象の名前 (go_to の M番号は、何の場所かの名前にする)
function targetName(a, c) { return c.player || (a.name === 'go_to' && c.kind) || c.item || c.block || c.mob || c.id; }

// 行動の一覧 → Choice の選択肢 { key: 文 }、key → {action, arg} か {group}、行動の説明表 { 行動: 説明 }
//   選択肢の文は「行動の名前 + 対象の label」だけ。行動の説明は表 (state.actions) に1回だけ書く
//   twoStage が有効なら、対象の多い行動は分類1つ (key "行動:*") にまとめ、対象の名前の要約を付ける
function actionOptions(actions, opts = {}) {
  const ts = opts.twoStage ? twoStageCfg(opts.twoStage) : { enabled: false };
  const criteria = {};
  const map = {};
  const table = {};
  const groups = {};
  for (const a of actions) {
    if (a.argType === 'text') continue; // 発言は 2B
    table[a.name] = a.desc;
    if (a.argType === 'choice') {
      const direct = !ts.enabled || a.choices.length <= ts.maxDirect || (ts.direct || []).includes(a.name);
      if (direct) {
        for (const c of a.choices) {
          const k = `${a.name}:${c.id}`;
          criteria[k] = `${a.name}: ${c.label}`;
          map[k] = { action: a.name, arg: c.id };
        }
      } else {
        const k = `${a.name}:*`;
        const names = [...new Set(a.choices.map((c) => targetName(a, c)))];
        const shown = names.slice(0, ts.summaryMax);
        criteria[k] = `${a.name}: ${a.choices.length}個から選ぶ (${shown.join(', ')}${names.length > shown.length ? ' ほか' : ''})`;
        map[k] = { group: a.name };
        groups[a.name] = a;
      }
    } else if (a.argType === 'number') {
      criteria[`${a.name}:3`] = `${a.name}: 3秒`;
      map[`${a.name}:3`] = { action: a.name, arg: '3' };
    } else {
      criteria[a.name] = a.name;
      map[a.name] = { action: a.name, arg: '' };
    }
  }
  const keys = Object.keys(criteria).slice(0, MAX_OPTIONS);
  return { criteria: Object.fromEntries(keys.map((k) => [k, criteria[k]])), map, table, groups };
}

const hasGoal = (ctx) => !!(ctx && ctx.goal && ctx.goal.text);

function troubledText(troubles) {
  return troubles.map((t) => `${t.about}が分からない (${t.kind === 'noChange' ? '何度やっても何も変わらなかった' : '同じ失敗が続いた'})`).join(' / ');
}

function buildState(ctx, opts = {}) {
  const st = {
    you: ctx.persona.name,
    personality: ctx.persona.personality || '',
  };
  if (hasGoal(ctx)) st.goal = ctx.goal.text; // 全体の目標が無い設定 (survival_3days) では渡さない
  if (ctx.showHints && ctx.goal.hints && ctx.goal.hints.length) st.knowledge = ctx.goal.hints.join(' ');
  if (ctx.progress) st.plan = ctx.progress;
  st.now = ctx.obsText;
  if (opts.table && Object.keys(opts.table).length) st.actions = opts.table;
  if (ctx.socialText) st.feelings = ctx.socialText;
  st.memory = ctx.memText;
  st.last_result = ctx.lastResult || 'なし';
  st.heard_now = ctx.raw && ctx.raw.heard && ctx.raw.heard.length ? ctx.raw.heard.map((h) => `${h.from}「${h.text}」`).join(' ') : 'なし';
  if (ctx.troubles && ctx.troubles.length) st.troubled = troubledText(ctx.troubles);
  return st;
}

// 2段目の state: 目標・plan・持ち物・その行動に関係する知識・last_result だけ (memory 全文や feelings は送らない)
function buildStage2State(ctx, action) {
  const inv = (ctx.raw && ctx.raw.inventory) || [];
  const counts = new Map();
  for (const i of inv) counts.set(i.name, (counts.get(i.name) || 0) + i.count);
  const st = { you: ctx.persona.name };
  if (hasGoal(ctx)) st.goal = ctx.goal.text;
  if (ctx.progress) st.plan = ctx.progress;
  st.action = `${action.name}: ${action.desc}`;
  st.inventory = counts.size ? [...counts].map(([n, c]) => `${n}x${c}`).join(', ') : 'なし';
  if (ctx.showHints && ctx.knowledge && ctx.knowledge.facts && ctx.knowledge.facts.length) {
    // その行動の名前か、その行動の対象の名前に当たる事実だけ (持ち物・always では選ばない)
    const names = namesInView({ actions: [action] });
    const fs = selectFacts(ctx.knowledge.facts, { names, actions: new Set([action.name]), max: ctx.knowledge.stage2Max ?? 4, always: false });
    if (fs.length) st.knowledge = fs.map((f) => f.text).join(' ');
  }
  st.last_result = ctx.lastResult || 'なし';
  const tr = (ctx.troubles || []).filter((t) => t.key.startsWith(`${action.name}:`));
  if (tr.length) st.troubled = troubledText(tr);
  return st;
}

function buildStage2Questions(action, ctx = null) {
  const toward = ctx && !hasGoal(ctx) ? '`plan` if present' : '`goal` (and `plan` if present)';
  const criteria = {};
  for (const c of action.choices.slice(0, MAX_OPTIONS)) criteria[c.id] = c.label;
  return {
    target: {
      type: 'choice',
      instructions: `\`you\` decided to do \`action\`. Choose the target for it that best advances ${toward}. Check \`inventory\`. Do not repeat what just failed in \`last_result\` unless something changed.`,
      criteria,
    },
  };
}

function buildQuestions(ctx, opts) {
  const q = {};
  q.next_action = {
    type: 'choice',
    instructions: (hasGoal(ctx) ? 'Choose the single next action for `you` that best advances `goal`. ' : 'Choose the single next action for `you`. ')
      + (!hasGoal(ctx) && ctx.socialText ? '`feelings` is how `you` feel in body and mind right now. ' : '')
      + (opts.hasTable ? '`actions` explains each kind of action; an option ending in "*" is a kind of action whose target is chosen next. ' : '')
      + (ctx.goalPlan ? '`plan` is the goal `you` set for yourself and the step `you` are on now. '
        : ctx.selfGoal ? '`plan` is the goal `you` set for yourself and its steps. ' : '`plan` lists the steps; the step marked 「← 次はこれ」 is next. ')
      + 'Check `now` (inventory and what is visible) and `memory`. Do not repeat an action that just failed in `last_result` unless something changed.'
      // help.askHint: 困ったら聞くよう後押しする一文 (first_setting では外し、無しで聞くかを観察する)
      + (ctx.askHint === false ? '' : ' If `troubled` is present and an ask option exists, asking a nearby player is a good choice.'),
    criteria: opts.criteria,
  };
  // 自分で決めた目標が済んだか (help.selfGoal)。高ければ agent が次のループで目標を書き直す
  if (ctx.selfGoal && ctx.progress) {
    q.goal_done = { type: 'noul', instructions: 'Has `you` already achieved the goal in `plan`, judging from `now`, `memory` and `last_result`?' };
  }
  // ゴールと手順 (help.goalPlan): 今の手順が済んだか。高ければ agent が次の判断の前に次の手順へ進める
  if (ctx.goalPlan && ctx.progress && /今の手順/.test(ctx.progress)) {
    q.step_done = { type: 'noul', instructions: 'Is the current step in `plan` already done, judging from `now`, `memory` and `last_result`?' };
  }
  q.remember = { type: 'score', instructions: 'How worth remembering for `you` is what happened in `last_result` and `heard_now`?', criteria: REMEMBER_LEVELS };
  const players = (ctx.raw && ctx.raw.entities || []).filter((e) => e.kind === 'player');
  const heard = (ctx.raw && ctx.raw.heard) || [];
  if (players.length || heard.length) {
    q.talk = {
      type: 'noul',
      instructions: 'Should `you` say something out loud to a nearby player right now? Yes if someone in `heard_now` spoke to `you`, if a player just came near, '
        + (hasGoal(ctx) ? 'or if talking would help coordinate `goal` with nearby players. ' : 'or if `you` have something to say to nearby players about what `you` or they are doing or feeling. ')
        + 'No if nobody is near or there is nothing worth saying.',
    };
  }
  const speakers = [...new Set(heard.map((h) => h.from))].slice(0, opts.maxRelations ?? 3);
  speakers.forEach((name, i) => {
    q[`rel_${i}`] = { type: 'score', instructions: `How did what ${name} said in \`heard_now\` change how \`you\` feel about ${name}?`, criteria: REL_LEVELS };
  });
  return { questions: q, speakers };
}

class JevDecider {
  constructor(opts = {}) {
    this.kind = 'jev';
    this.client = opts.client || new JevClient(opts);
    this.meter = opts.meter || null;
    this.maxRelations = opts.maxRelations ?? 3;
    this.twoStage = twoStageCfg(opts.twoStage);
  }

  // 1回の呼び出し: 送って、使用量を記録する
  async call(state, questions, stage) {
    const inputText = JSON.stringify(state) + JSON.stringify(questions);
    const r = await this.client.ask(state, questions);
    const usageIn = r.usage && Number.isFinite(r.usage.input_tokens) ? r.usage.input_tokens : null;
    const nq = Object.keys(questions).length;
    const rec = this.meter
      ? this.meter.addJev({ stage, inputChars: inputText.length, inputText, inputTokens: usageIn, outputTokens: r.usage ? r.usage.output_tokens : null, ms: r.ms, questions: nq, error: r.ok ? null : r.error, rateLimited: r.rateLimited, retries: r.retries })
      : { inputTokens: usageIn ?? estimateTokens(inputText), estimated: usageIn == null };
    return { r, inputChars: inputText.length, inputTokens: rec.inputTokens, estimated: rec.estimated };
  }

  // Jev の確率に、状態が変わらなかった回数だけ負の重みを掛けて選び直す。pens = { 選択肢の key: 回数 }
  static applyPenalties(ans, pens, weight) {
    if (!ans || !ans.probabilities || !Object.keys(pens).length) return null;
    const rw = reweight(ans.probabilities, (k) => k, pens, weight);
    if (!rw) return null;
    const touched = Object.keys(ans.probabilities).filter((k) => pens[k]);
    return { rw, info: { from: rw.original, to: rw.choice, changed: rw.changed, weight,
      penalties: Object.fromEntries(touched.map((k) => [k, pens[k]])),
      pFrom: Number((ans.probabilities[rw.original] || 0).toFixed(3)), pTo: Number((rw.probs[rw.choice] || 0).toFixed(3)) } };
  }

  async decide(ctx) {
    const { criteria, map, table, groups } = actionOptions(ctx.actions, { twoStage: this.twoStage.enabled ? this.twoStage : false });
    const state = buildState(ctx, { table });
    const { questions, speakers } = buildQuestions(ctx, { criteria, maxRelations: this.maxRelations, hasTable: true });
    const c1 = await this.call(state, questions, 1);
    const r = c1.r;
    const jev = {
      model: r.model || null, ms: r.ms, queueMs: r.queueMs, retries: r.retries, rateLimited: r.rateLimited, status: r.status ?? null,
      inputChars: c1.inputChars, inputTokens: c1.inputTokens, tokensEstimated: c1.estimated, outputTokens: r.usage ? r.usage.output_tokens : null,
      questions: Object.keys(questions), options: Object.keys(criteria).length, limits: r.limits || null, calls: 1,
      groups: Object.keys(groups),
    };
    const base = { rawOutput: null, latencyMs: r.ms, promptChars: c1.inputChars, promptTokens: c1.inputTokens, say: '', jev };
    const finish = () => {
      base.latencyMs = jev.ms; base.promptChars = jev.inputChars; base.promptTokens = jev.inputTokens;
      if (this.meter && this.meter.addDecision) this.meter.addDecision({ calls: jev.calls, inputTokens: jev.inputTokens });
    };
    if (!r.ok) { finish(); return { ...base, action: null, arg: '', parseOk: false, repaired: false, error: r.error }; }
    const a = r.answers || {};
    let chosen = a.next_action ? a.next_action.choice : null;
    // 状態が変わらなかった行動に負の重み (help.noChange のとき、agent が ctx.noChange を渡す)。
    // 分類の選択肢は、中の対象の回数の一番少ないもの (変わらなかったことのない対象が1つでもあれば重みなし)
    const pens = (ctx.noChange && ctx.noChange.penalties) || {};
    if (ctx.noChange && Object.keys(pens).length) {
      const p1 = {};
      for (const k of Object.keys(criteria)) {
        const m = map[k];
        const n = m.group ? Math.min(...groups[m.group].choices.map((c) => pens[`${m.group}:${c.id}`] || 0)) : (pens[`${m.action}:${m.arg}`] || 0);
        if (n) p1[k] = n;
      }
      const x = JevDecider.applyPenalties(a.next_action, p1, ctx.noChange.weight);
      if (x) { jev.reweight = x.info; chosen = x.rw.choice; }
    }
    jev.choice = a.next_action ? { choice: a.next_action.choice, confidence: a.next_action.confidence ?? null } : null;
    jev.talkP = a.talk ? a.talk.noul : null;
    jev.goalDoneP = a.goal_done ? a.goal_done.noul : null;
    jev.stepDoneP = a.step_done ? a.step_done.noul : null;
    jev.remember = a.remember ? a.remember.score : null;
    jev.relations = Object.fromEntries(speakers.map((n, i) => [n, a[`rel_${i}`] ? a[`rel_${i}`].score : null]));
    base.rawOutput = JSON.stringify(a.next_action ? { choice: a.next_action.choice, confidence: a.next_action.confidence } : null);
    let pick = chosen && map[chosen];
    if (pick && pick.group) {
      // 2回目: 分類の中から対象を選ぶ
      const act = groups[pick.group];
      const st2 = buildStage2State(ctx, act);
      const q2 = buildStage2Questions(act, ctx);
      const c2 = await this.call(st2, q2, 2);
      const s2 = { action: act.name, options: Object.keys(q2.target.criteria).length, inputChars: c2.inputChars, inputTokens: c2.inputTokens, tokensEstimated: c2.estimated, ms: c2.r.ms, outputTokens: c2.r.usage ? c2.r.usage.output_tokens : null };
      jev.calls = 2;
      jev.stage1 = { inputChars: c1.inputChars, inputTokens: c1.inputTokens, ms: r.ms };
      jev.inputChars += c2.inputChars; jev.inputTokens += c2.inputTokens; jev.ms += c2.r.ms || 0;
      jev.tokensEstimated = jev.tokensEstimated || c2.estimated;
      if (jev.outputTokens != null && s2.outputTokens != null) jev.outputTokens += s2.outputTokens;
      let id = null;
      const t = c2.r.ok && c2.r.answers ? c2.r.answers.target : null;
      if (t) {
        id = t.choice;
        s2.choice = { choice: t.choice, confidence: t.confidence ?? null };
        if (ctx.noChange) {
          const p2 = {};
          for (const c of act.choices) { const n = pens[`${act.name}:${c.id}`]; if (n) p2[c.id] = n; }
          const x = JevDecider.applyPenalties(t, p2, ctx.noChange.weight);
          if (x) { s2.reweight = x.info; id = x.rw.choice; }
        }
      }
      if (!id || !act.choices.some((c) => c.id === id)) {
        // 2回目が失敗・一覧にない答え: 一覧の先頭 (近い・手元のもの) にする
        s2.error = c2.r.ok ? `一覧にない対象: ${id}` : c2.r.error;
        id = act.choices[0].id;
        s2.fallback = true;
      }
      jev.stage2 = s2;
      pick = { action: act.name, arg: id };
    }
    finish();
    if (!pick) return { ...base, action: null, arg: '', parseOk: false, repaired: false, error: `Jev の選択が一覧にない: ${chosen}` };
    return { ...base, action: pick.action, arg: pick.arg, parseOk: true, repaired: false };
  }
}

module.exports = { JevDecider, actionOptions, buildState, buildQuestions, buildStage2State, buildStage2Questions, twoStageCfg, TWO_STAGE_DEFAULTS, REMEMBER_LEVELS, REL_LEVELS };
