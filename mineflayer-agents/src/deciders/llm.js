'use strict';
// OpenAI 互換の窓口 (llama-server など) を使う decider。
// mode 'act'  : 行動を1つ選び、ついでに話す ({action, arg, say}) — 会話と行動を1つのモデルで
// mode 'talk' : 話す内容だけ ({say}) — 会話担当と行動担当を分ける構成 (split.js) で使う
const { parseDecision } = require('../parse');
const { systemPrompt, userPrompt } = require('../prompt');

// constrainArgs=true なら、行動ごとに arg の候補まで文法で縛る (anyOf)。2B でも一覧にない引数を出せない
// think=true なら、行動の前に短い考え ("think") を書かせる (小さいモデルの判断を助ける。出力が数十トークン増える)
function decisionSchema(actions, allowSay, constrainArgs = true, think = false) {
  const sayProp = allowSay ? { say: { type: 'string', maxLength: 60 } } : {};
  const thinkProp = think ? { think: { type: 'string', maxLength: 80 } } : {};
  const req = [...(think ? ['think'] : []), 'action', 'arg', ...(allowSay ? ['say'] : [])];
  if (!constrainArgs) {
    return {
      type: 'object',
      properties: { ...thinkProp, action: { type: 'string', enum: actions.map((a) => a.name) }, arg: { type: 'string' }, ...sayProp },
      required: req, additionalProperties: false,
    };
  }
  return {
    anyOf: actions.map((a) => {
      let arg = { type: 'string' };
      if (a.argType === 'choice') arg = { type: 'string', enum: a.choices.map((c) => c.id) };
      else if (a.argType === 'none') arg = { type: 'string', enum: [''] };
      else if (a.argType === 'number') arg = { type: 'string', enum: ['1', '2', '3', '5', '10'] };
      else arg = { type: 'string', minLength: 1, maxLength: 60 };
      return { type: 'object', properties: { ...thinkProp, action: { type: 'string', enum: [a.name] }, arg, ...sayProp }, required: req, additionalProperties: false };
    }),
  };
}

class LLMDecider {
  constructor(opts = {}) {
    this.kind = 'llm';
    this.baseUrl = (opts.baseUrl || process.env.LLM_BASE_URL || 'http://127.0.0.1:18081').replace(/\/+$/, '');
    this.model = opts.model || process.env.LLM_MODEL || 'gemma-4-e2b';
    this.temperature = opts.temperature ?? 0.4;
    this.maxTokens = opts.maxTokens ?? (opts.think ? 160 : 96);
    this.timeoutMs = opts.timeoutMs ?? 60000;
    // constrained: llama-server の json_schema (文法の制約) で、壊れた JSON と一覧にない action を出せなくする
    this.constrained = opts.constrained ?? true;
    this.constrainArgs = opts.constrainArgs ?? true;
    this.think = opts.think ?? false;
    this.allowSay = opts.allowSay ?? true;
    this.mode = opts.mode || 'act';
    this.retries = opts.retries ?? 0;
    this.fetch = opts.fetch || globalThis.fetch;
    this.apiKey = opts.apiKey || process.env.LLM_API_KEY || '';
  }

  buildMessages(ctx) {
    if (this.mode === 'talk') {
      return [
        { role: 'system', content: systemPrompt(ctx.persona, ctx.goal) + '\n今回は話すことだけを決める。{"say":"..."} だけを出力する。話すことがなければ空文字。' },
        { role: 'user', content: `## 今の様子\n${ctx.obsText}\n## 覚えていること\n${ctx.memText}\n${ctx.plannedAction ? `## これからする行動\n${ctx.plannedAction}\n` : ''}話すことを JSON で。` },
      ];
    }
    return [
      { role: 'system', content: systemPrompt(ctx.persona, ctx.goal, { allowSay: this.allowSay, think: this.think }) },
      { role: 'user', content: userPrompt(ctx.obsText, ctx.memText, ctx.actions, ctx.progress) },
    ];
  }

  async complete(messages, schema) {
    const body = { model: this.model, messages, temperature: this.temperature, max_tokens: this.maxTokens, stream: false };
    if (this.constrained && schema) body.response_format = { type: 'json_schema', json_schema: { name: 'decision', schema, strict: true } };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const d = await res.json();
      return {
        text: d.choices?.[0]?.message?.content ?? '',
        promptTokens: d.usage?.prompt_tokens ?? null,
        completionTokens: d.usage?.completion_tokens ?? null,
        cachedTokens: d.timings?.cache_n ?? d.usage?.prompt_tokens_details?.cached_tokens ?? null,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async decide(ctx) {
    const messages = this.buildMessages(ctx);
    const promptChars = messages.reduce((s, m) => s + m.content.length, 0);
    const schema = this.mode === 'talk'
      ? { type: 'object', properties: { say: { type: 'string' } }, required: ['say'], additionalProperties: false }
      : decisionSchema(ctx.actions, this.allowSay, this.constrainArgs, this.think);
    const t0 = Date.now();
    let last = null;
    let attempts = 0;
    for (let i = 0; i <= this.retries; i++) {
      attempts += 1;
      let r;
      try {
        r = await this.complete(messages, schema);
      } catch (e) {
        last = { error: `LLM error: ${e.message}`, rawOutput: null };
        continue;
      }
      const base = { rawOutput: r.text, promptTokens: r.promptTokens, completionTokens: r.completionTokens, cachedTokens: r.cachedTokens };
      if (this.mode === 'talk') {
        const m = r.text.match(/"say"\s*:\s*"([^"]*)/);
        return { ...base, action: null, arg: '', say: m ? m[1].trim() : '', parseOk: !!m, repaired: false, latencyMs: Date.now() - t0, promptChars, attempts };
      }
      const p = parseDecision(r.text);
      if (p.ok) {
        return { ...base, ...p.value, say: this.allowSay ? p.value.say : '', parseOk: true, repaired: !!p.repaired, latencyMs: Date.now() - t0, promptChars, attempts };
      }
      last = { ...base, error: p.error };
    }
    return { action: null, arg: '', say: '', parseOk: false, repaired: false, latencyMs: Date.now() - t0, promptChars, attempts, ...last };
  }
}

module.exports = { LLMDecider, decisionSchema };
