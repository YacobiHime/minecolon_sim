'use strict';
// Jev (TypeSafe System One) の decider。1回の呼び出しに質問をまとめる:
//   next_action (Choice)  その瞬間にできる行動の一覧 ("行動:引数" を選択肢にする) から1つ
//   talk        (Noul)    今、近くの人に話しかけるべきか (高ければ 2B が発言を作る)。近くに人がいないときは聞かない
//   remember    (Score)   直前の出来事 (last_result と heard_now) を覚えておく価値 0〜4 → 記憶の大事さ
//   rel_<n>     (Score)   今聞こえた相手ごとに、その人への気持ちがどう変わったか 0〜4 → 好感
// 公式の資料 (docs.typesafe.ai) の勧め: 質問は小さく分けてまとめて聞く、数の計算はさせない、英語が一番正確。
// そこで質問の文 (instructions) は英語、状態 (state) は観測の日本語のまま渡す。
const { JevClient } = require('../jev_client');
const { estimateTokens } = require('../usage');

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

// 行動の一覧 → Choice の選択肢 { key: 説明 } と、key → {action, arg}
function actionOptions(actions) {
  const criteria = {};
  const map = {};
  for (const a of actions) {
    if (a.argType === 'text') continue; // 発言は 2B
    if (a.argType === 'choice') {
      for (const c of a.choices) {
        const k = `${a.name}:${c.id}`;
        criteria[k] = `${a.name}: ${a.desc} — ${c.label}`;
        map[k] = { action: a.name, arg: c.id };
      }
    } else if (a.argType === 'number') {
      criteria[`${a.name}:3`] = `${a.name}: ${a.desc} (3秒)`;
      map[`${a.name}:3`] = { action: a.name, arg: '3' };
    } else {
      criteria[a.name] = `${a.name}: ${a.desc}`;
      map[a.name] = { action: a.name, arg: '' };
    }
  }
  const keys = Object.keys(criteria).slice(0, MAX_OPTIONS);
  return { criteria: Object.fromEntries(keys.map((k) => [k, criteria[k]])), map };
}

function buildState(ctx) {
  const st = {
    you: ctx.persona.name,
    personality: ctx.persona.personality || '',
    goal: ctx.goal.text,
  };
  if (ctx.showHints && ctx.goal.hints && ctx.goal.hints.length) st.knowledge = ctx.goal.hints.join(' ');
  if (ctx.progress) st.plan = ctx.progress;
  st.now = ctx.obsText;
  if (ctx.socialText) st.feelings = ctx.socialText;
  st.memory = ctx.memText;
  st.last_result = ctx.lastResult || 'なし';
  st.heard_now = ctx.raw && ctx.raw.heard && ctx.raw.heard.length ? ctx.raw.heard.map((h) => `${h.from}「${h.text}」`).join(' ') : 'なし';
  if (ctx.troubles && ctx.troubles.length) st.troubled = ctx.troubles.map((t) => `${t.about}が分からない (同じ失敗が続いた)`).join(' / ');
  return st;
}

function buildQuestions(ctx, opts) {
  const q = {};
  q.next_action = {
    type: 'choice',
    instructions: 'Choose the single next action for `you` that best advances `goal`. `plan` lists the steps; the step marked 「← 次はこれ」 is next. '
      + 'Check `now` (inventory and what is visible) and `memory`. Do not repeat an action that just failed in `last_result` unless something changed. '
      + 'If `troubled` is present and an ask option exists, asking a nearby player is a good choice.',
    criteria: opts.criteria,
  };
  q.remember = { type: 'score', instructions: 'How worth remembering for `you` is what happened in `last_result` and `heard_now`?', criteria: REMEMBER_LEVELS };
  const players = (ctx.raw && ctx.raw.entities || []).filter((e) => e.kind === 'player');
  const heard = (ctx.raw && ctx.raw.heard) || [];
  if (players.length || heard.length) {
    q.talk = {
      type: 'noul',
      instructions: 'Should `you` say something out loud to a nearby player right now? Yes if someone in `heard_now` spoke to `you`, if a player just came near, '
        + 'or if talking would help coordinate `goal` with nearby players. No if nobody is near or there is nothing worth saying.',
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
  }

  async decide(ctx) {
    const { criteria, map } = actionOptions(ctx.actions);
    const state = buildState(ctx);
    const { questions, speakers } = buildQuestions(ctx, { criteria, maxRelations: this.maxRelations });
    const inputText = JSON.stringify(state) + JSON.stringify(questions);
    const r = await this.client.ask(state, questions);
    const usageIn = r.usage && Number.isFinite(r.usage.input_tokens) ? r.usage.input_tokens : null;
    const nq = Object.keys(questions).length;
    const rec = this.meter
      ? this.meter.addJev({ inputChars: inputText.length, inputText, inputTokens: usageIn, outputTokens: r.usage ? r.usage.output_tokens : null, ms: r.ms, questions: nq, error: r.ok ? null : r.error, rateLimited: r.rateLimited, retries: r.retries })
      : { inputTokens: usageIn ?? estimateTokens(inputText), estimated: usageIn == null };
    const jev = {
      model: r.model || null, ms: r.ms, queueMs: r.queueMs, retries: r.retries, rateLimited: r.rateLimited, status: r.status ?? null,
      inputChars: inputText.length, inputTokens: rec.inputTokens, tokensEstimated: rec.estimated, outputTokens: r.usage ? r.usage.output_tokens : null,
      questions: Object.keys(questions), options: Object.keys(criteria).length, limits: r.limits || null,
    };
    const base = { rawOutput: null, latencyMs: r.ms, promptChars: inputText.length, promptTokens: rec.inputTokens, say: '', jev };
    if (!r.ok) return { ...base, action: null, arg: '', parseOk: false, repaired: false, error: r.error };
    const a = r.answers || {};
    const pick = a.next_action && map[a.next_action.choice];
    jev.choice = a.next_action ? { choice: a.next_action.choice, confidence: a.next_action.confidence ?? null } : null;
    jev.talkP = a.talk ? a.talk.noul : null;
    jev.remember = a.remember ? a.remember.score : null;
    jev.relations = Object.fromEntries(speakers.map((n, i) => [n, a[`rel_${i}`] ? a[`rel_${i}`].score : null]));
    base.rawOutput = JSON.stringify(a.next_action ? { choice: a.next_action.choice, confidence: a.next_action.confidence } : null);
    if (!pick) return { ...base, action: null, arg: '', parseOk: false, repaired: false, error: `Jev の選択が一覧にない: ${a.next_action && a.next_action.choice}` };
    return { ...base, action: pick.action, arg: pick.arg, parseOk: true, repaired: false };
  }
}

module.exports = { JevDecider, actionOptions, buildState, buildQuestions, REMEMBER_LEVELS, REL_LEVELS };
