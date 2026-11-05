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

// 2B (llama-server) の呼び出しの待ち時間を、プロセスの中の全員でまとめて数える (20人で -np 8 の待ち行列を見るため)。
//   ms: 呼び出しから応答まで。serverMs: サーバーが実際に処理した時間 (timings.prompt_ms + predicted_ms)。
//   waitMs = ms − serverMs ≈ スロットの空き待ち (と通信)。window() は前回の window() からの分
const LLM_STATS = {
  all: [], since: 0,
  add(r) { this.all.push(r); if (this.all.length > 20000) { this.all.splice(0, 10000); this.since = Math.max(0, this.since - 10000); } },
  summarize(rows) {
    const q = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]); };
    const ok = rows.filter((r) => !r.error);
    const f = (k) => ok.map((r) => r[k]).filter((x) => Number.isFinite(x));
    return { calls: rows.length, errors: rows.length - ok.length, ms: { p50: q(f('ms'), 0.5), p95: q(f('ms'), 0.95), max: q(f('ms'), 1) },
      serverMs: { p50: q(f('serverMs'), 0.5), p95: q(f('serverMs'), 0.95) }, waitMs: { p50: q(f('waitMs'), 0.5), p95: q(f('waitMs'), 0.95), max: q(f('waitMs'), 1) } };
  },
  total() { return this.summarize(this.all); },
  window() { const rows = this.all.slice(this.since); this.since = this.all.length; return this.summarize(rows); },
  reset() { this.all = []; this.since = 0; },
};

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
      { role: 'user', content: userPrompt(ctx.obsText, ctx.memText, ctx.actions, ctx.progress, ctx.socialText) },
    ];
  }

  // opts: { maxTokens, temperature } (この呼び出しだけ変える。ゴールの案を k 個出すときなど)
  async complete(messages, schema, opts = {}) {
    const body = { model: this.model, messages, temperature: opts.temperature ?? this.temperature, max_tokens: opts.maxTokens ?? this.maxTokens, stream: false };
    if (this.constrained && schema) body.response_format = { type: 'json_schema', json_schema: { name: 'decision', schema, strict: true } };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    const t0 = Date.now();
    let stat = { ms: null, serverMs: null, waitMs: null, error: true };
    try {
      const res = await this.fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const d = await res.json();
      const ms = Date.now() - t0;
      const serverMs = d.timings && Number.isFinite(d.timings.prompt_ms) ? Math.round((d.timings.prompt_ms || 0) + (d.timings.predicted_ms || 0)) : null;
      stat = { ms, serverMs, waitMs: serverMs == null ? null : Math.max(0, ms - serverMs), error: false };
      return {
        text: d.choices?.[0]?.message?.content ?? '',
        promptTokens: d.usage?.prompt_tokens ?? null,
        completionTokens: d.usage?.completion_tokens ?? null,
        cachedTokens: d.timings?.cache_n ?? d.usage?.prompt_tokens_details?.cached_tokens ?? null,
        ms, serverMs, waitMs: stat.waitMs,
      };
    } finally {
      clearTimeout(timer);
      if (stat.ms == null) stat.ms = Date.now() - t0;
      LLM_STATS.add(stat);
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

module.exports = { LLMDecider, decisionSchema, LLM_STATS };
