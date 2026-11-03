'use strict';
// 自分で目標を決める仕組み (help.selfGoal)。全体の目標 (goal.text) だけを与えられたエージェントが、
// 自分の状態・持ち物・記憶から「今の目標と 2〜4 個の段取り」を 2B で書く (json_schema で縛る)。
// それを Jev の state の plan に入れる。済んだかは Jev の noul (goal_done) で毎回聞く (追加の呼び出しが要らない)。
// 書き直すとき: 最初 / 済んだ (goal_done ≥ doneThreshold) / 困りごとが新しく出た / every ループたった。
const { LLMDecider } = require('./deciders/llm');

const GOAL_SCHEMA = {
  type: 'object',
  properties: {
    goal: { type: 'string', maxLength: 40 },
    steps: { type: 'array', items: { type: 'string', maxLength: 30 }, minItems: 2, maxItems: 4 },
  },
  required: ['goal', 'steps'],
  additionalProperties: false,
};

const DEFAULTS = { every: 30, doneThreshold: 0.7, maxTokens: 160, temperature: 0.5 };

function parseGoal(text) {
  try {
    const s = String(text);
    const o = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
    const goal = String(o.goal || '').trim().slice(0, 40);
    const steps = (Array.isArray(o.steps) ? o.steps : []).map((x) => String(x).trim().slice(0, 30)).filter(Boolean).slice(0, 4);
    if (!goal || steps.length < 1) return null;
    return { goal, steps };
  } catch (_) { return null; }
}

class SelfGoal {
  constructor(opts = {}) {
    this.cfg = { ...DEFAULTS, ...(opts.cfg || {}) };
    this.llm = opts.llm || new LLMDecider({ ...(opts.llmOpts || {}), mode: 'talk', maxTokens: this.cfg.maxTokens, temperature: this.cfg.temperature });
    this.meter = opts.meter || null;
    this.current = null; // { goal, steps, setAt, reason }
    this.history = [];
    this.troubleKey = '';
  }

  // 書き直す理由 (なければ null)
  needs(tick, { doneP = null, troubles = [] } = {}) {
    if (!this.current) return 'start';
    if (doneP != null && doneP >= this.cfg.doneThreshold) return 'done';
    const tk = troubles.map((t) => t.key).sort().join('|');
    if (tk && tk !== this.troubleKey) return 'trouble';
    if (tick - this.current.setAt >= this.cfg.every) return 'interval';
    return null;
  }

  planText() {
    if (!this.current) return '';
    return `目標: ${this.current.goal} / 段取り: ${this.current.steps.map((s, i) => `(${i + 1})${s}`).join(' ')}`;
  }

  messages(ctx, reason) {
    const p = ctx.persona || {};
    const prev = this.current
      ? `${this.current.goal} (${{ done: '済んだ', trouble: '困っている', interval: 'しばらく続けた' }[reason] || ''})`
      : 'まだない';
    const system = [
      `あなたは Minecraft の世界にいる「${p.name}」。${p.personality || ''}`,
      `全体の目標: ${ctx.goalText}`,
      ctx.hints && ctx.hints.length ? `知っていること: ${ctx.hints.join(' ')}` : '',
      'あなたが知っているのは、自分で見たこと・やったこと・聞いたことだけ。',
      '今の様子と覚えていることから、次にめざす目標を1つと、その段取りを2〜4個、短い日本語で書く。',
      'JSON {"goal":"...","steps":["...","..."]} だけを出力する。',
    ].filter(Boolean).join('\n');
    const user = [
      '## 今の様子', ctx.obsText,
      ctx.socialText ? `## 気持ち\n${ctx.socialText}` : '',
      '## 覚えていること', ctx.memText,
      `## 前の目標\n${prev}`,
      ctx.troubles && ctx.troubles.length ? `## 困っていること\n${ctx.troubles.map((t) => t.about).join(' / ')}` : '',
      '目標を JSON で。',
    ].filter(Boolean).join('\n');
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
  }

  async update(ctx, reason, tick) {
    const messages = this.messages(ctx, reason);
    const promptChars = messages.reduce((s, m) => s + m.content.length, 0);
    const t0 = Date.now();
    let r = null; let error = null;
    try { r = await this.llm.complete(messages, GOAL_SCHEMA); } catch (e) { error = e.message; }
    const ms = Date.now() - t0;
    const parsed = r ? parseGoal(r.text) : null;
    if (this.meter) this.meter.addTwoB({ kind: 'goal', promptChars, promptTokens: r ? r.promptTokens : null, completionTokens: r ? r.completionTokens : null, ms, error: error || (parsed ? null : 'parse') });
    const prev = this.current;
    if (parsed) {
      this.current = { ...parsed, setAt: tick, reason };
      this.history.push(this.current);
    } else if (prev) {
      prev.setAt = tick; // 書けなかったら前の目標を続ける (すぐに書き直しを繰り返さない)
    }
    this.troubleKey = (ctx.troubles || []).map((t) => t.key).sort().join('|');
    return { reason, prev: prev ? { goal: prev.goal, steps: prev.steps } : null, goal: parsed ? parsed.goal : null, steps: parsed ? parsed.steps : null,
      ok: !!parsed, error, rawOutput: r ? r.text : null, promptChars, promptTokens: r ? r.promptTokens : null, ms, prompt: messages };
  }
}

module.exports = { SelfGoal, GOAL_SCHEMA, parseGoal, DEFAULTS };
