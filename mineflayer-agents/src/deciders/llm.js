'use strict';
// OpenAI 互換の窓口 (llama-server など) を使う decider。
// mode 'act'  : 行動を1つ選び、ついでに話す ({action, arg, say}) — 会話と行動を1つのモデルで
// mode 'talk' : 話す内容だけ ({say}) — 会話担当と行動担当を分ける構成 (split.js) で使う
const { parseDecision } = require('../parse');
const { systemPrompt, userPrompt } = require('../prompt');
const { Semaphore } = require('../jev_client');
const { loadProviderKey, costOf, redact, strictSchema } = require('../llm_provider');

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

// 提供元・役ごとの使用量と費用 (プロセスの中の全員でまとめる)。maxUsd を超えたら exceeded を立て、以後の呼び出しは投げずに失敗にする
function emptyUse() {
  return { calls: 0, errors: 0, rateLimited: 0, retries: 0, promptTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, completionTokens: 0, reasoningTokens: 0, ms: 0, costUsd: 0, unpriced: 0 };
}
const LLM_USAGE = {
  byProvider: {}, byRole: {}, totalUsd: 0, maxUsd: null, exceeded: false, listeners: [], providers: {},
  onExceeded(fn) { this.listeners.push(fn); },
  add(r) {
    const key = `${r.provider}/${r.role}`;
    for (const [m, k] of [[this.byProvider, r.provider], [this.byRole, key]]) {
      const u = (m[k] = m[k] || emptyUse());
      u.calls += 1;
      if (r.error) u.errors += 1;
      u.rateLimited += r.rateLimited || 0;
      u.retries += r.retries || 0;
      for (const f of ['promptTokens', 'cachedTokens', 'cacheWriteTokens', 'completionTokens', 'reasoningTokens', 'ms']) u[f] = (u[f] || 0) + (r[f] || 0);
      u.costUsd += r.costUsd || 0;
      if (r.priced === false && !r.error) u.unpriced += 1;
    }
    if (r.pricing) this.providers[r.provider] = { model: r.model, pricing: r.pricing };
    this.totalUsd += r.costUsd || 0;
    this.check();
  },
  check() {
    if (!this.exceeded && this.maxUsd != null && this.totalUsd >= this.maxUsd) {
      this.exceeded = true;
      for (const fn of this.listeners) { try { fn(this.summary()); } catch (_) { /* ignore */ } }
    }
  },
  summary() {
    const fix = (o) => Object.fromEntries(Object.entries(o).map(([k, u]) => [k, { ...u, costUsd: Number(u.costUsd.toFixed(6)), avgMs: u.calls ? Math.round(u.ms / u.calls) : 0 }]));
    const providers = Object.fromEntries(Object.entries(this.providers).map(([k, v]) => [k, { model: v.model, pricing: v.pricing,
      priced: v.pricing && v.pricing.inputPerMTok != null && v.pricing.outputPerMTok != null ? true : '未設定' }]));
    return { byProvider: fix(this.byProvider), byRole: fix(this.byRole), providers, costUsd: Number(this.totalUsd.toFixed(6)), maxUsd: this.maxUsd, exceeded: this.exceeded };
  },
  reset() { this.byProvider = {}; this.byRole = {}; this.totalUsd = 0; this.maxUsd = null; this.exceeded = false; this.listeners = []; this.providers = {}; },
};

// 同時に投げる数の上限を提供元 (baseUrl + model) ごとにプロセスで1つ共有する
const SEMS = new Map();
function semFor(key, n) {
  if (!(n > 0)) return null;
  if (!SEMS.has(key)) SEMS.set(key, new Semaphore(n));
  return SEMS.get(key);
}

// base URL → chat completions の URL。".../v1" で終わればそのまま、そうでなければ /v1 を足す (今までの local の書き方)
function chatUrl(baseUrl) {
  const b = String(baseUrl).replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(b)) return b;
  return /\/v\d+$/.test(b) ? `${b}/chat/completions` : `${b}/v1/chat/completions`;
}

class LLMDecider {
  constructor(opts = {}) {
    this.kind = 'llm';
    this.provider = opts.provider || 'local';
    this.role = opts.role || null;
    this.apiStyle = opts.apiStyle || 'llamacpp';
    this.baseUrl = (opts.baseUrl || process.env.LLM_BASE_URL || 'http://127.0.0.1:18081').replace(/\/+$/, '');
    this.model = opts.model || process.env.LLM_MODEL || 'gemma-4-e2b';
    this.temperature = opts.temperature ?? 0.4;
    this.sendTemperature = opts.sendTemperature ?? true; // false: temperature を送らない (受け付けないモデル)。400 で断られたら自動で false にする
    this.maxTokens = opts.maxTokens ?? (opts.think ? 160 : 96);
    this.timeoutMs = opts.timeoutMs ?? 60000;
    // constrained: llama-server の json_schema (文法の制約) で、壊れた JSON と一覧にない action を出せなくする
    this.constrained = opts.constrained ?? true;
    // structured: json_schema (そのまま) | json_schema_strict (OpenAI の strict に通る形に直す) | json_object | none
    this.structured = opts.structured || 'json_schema';
    this.tokenParam = opts.tokenParam || 'max_tokens';
    this.reasoningEffort = opts.reasoningEffort ?? null;
    this.reasoningExtraTokens = opts.reasoningExtraTokens ?? 0;
    this.ctxTokens = opts.ctxTokens ?? null;
    this.pricing = opts.pricing || null;
    this.maxRetries = opts.maxRetries ?? 0;
    this.sem = semFor(`${this.baseUrl}|${this.model}`, opts.maxConcurrent ?? 0);
    this.sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.constrainArgs = opts.constrainArgs ?? true;
    this.think = opts.think ?? false;
    this.allowSay = opts.allowSay ?? true;
    this.mode = opts.mode || 'act';
    this.retries = opts.retries ?? 0;
    this.fetch = opts.fetch || globalThis.fetch;
    let key = opts.apiKey || '';
    if (!key && opts.apiKeyVars) key = loadProviderKey(opts) || '';
    if (!key && this.provider === 'local') key = process.env.LLM_API_KEY || '';
    // キーは列挙されない所に置く (JSON.stringify・console.log で出ないように)
    Object.defineProperty(this, 'apiKey', { value: key, enumerable: false, writable: true });
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

  // 送る本文。提供元ごとの違い (出力の上限の名前・推論・構造化出力・temperature) をここで吸収する
  buildBody(messages, schema, opts = {}) {
    let maxTok = opts.maxTokens ?? this.maxTokens;
    const reasoning = this.reasoningEffort && this.reasoningEffort !== 'none';
    if (reasoning) maxTok += this.reasoningExtraTokens;
    const body = { model: this.model, messages, stream: false };
    body[this.tokenParam] = maxTok;
    if (this.sendTemperature) body.temperature = opts.temperature ?? this.temperature;
    if (this.reasoningEffort) body.reasoning_effort = this.reasoningEffort;
    if (this.constrained && schema && this.structured !== 'none') {
      if (this.structured === 'json_object') {
        body.response_format = { type: 'json_object' };
        body.messages = [...messages.slice(0, -1), { ...messages[messages.length - 1], content: `${messages[messages.length - 1].content}\n出力の JSON schema: ${JSON.stringify(schema)}` }];
      } else {
        const s = this.structured === 'json_schema_strict' ? strictSchema(schema) : schema;
        body.response_format = { type: 'json_schema', json_schema: { name: 'decision', schema: s, strict: true } };
      }
    }
    return body;
  }

  // opts: { maxTokens, temperature } (この呼び出しだけ変える。ゴールの案を k 個出すときなど)
  async complete(messages, schema, opts = {}) {
    if (LLM_USAGE.exceeded) {
      LLM_USAGE.add({ provider: this.provider, role: this.role || 'other', error: true });
      throw new Error(`LLM の費用が上限 $${LLM_USAGE.maxUsd} に達したので呼ばない`);
    }
    const t0 = Date.now();
    if (this.sem) await this.sem.acquire();
    const queueMs = Date.now() - t0;
    let stat = { ms: null, serverMs: null, waitMs: null, error: true, provider: this.provider };
    let retries = 0; let rateLimited = 0; let triedSchema = false;
    const use = { provider: this.provider, role: this.role || 'other', model: this.model, pricing: this.pricing, error: true, ms: 0 };
    try {
      for (let attempt = 0; ; attempt++) {
        const body = this.buildBody(messages, schema, opts);
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), this.timeoutMs);
        let res;
        try {
          res = await this.fetch(chatUrl(this.baseUrl), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
            body: JSON.stringify(body),
            signal: ac.signal,
          });
        } catch (e) {
          clearTimeout(timer);
          if (attempt < this.maxRetries) { retries += 1; await this.sleep(500 * 2 ** attempt); continue; }
          throw new Error(`LLM 接続失敗: ${e.name === 'AbortError' ? 'timeout' : redact(e.message, this.apiKey)}`);
        }
        clearTimeout(timer);
        if (res.status === 429 || res.status >= 500) {
          if (res.status === 429) rateLimited += 1;
          if (attempt < this.maxRetries) {
            const ra = Number(res.headers && res.headers.get ? res.headers.get('retry-after') : NaN);
            retries += 1;
            try { await res.text(); } catch (_) { /* ignore */ }
            await this.sleep(Number.isFinite(ra) && ra > 0 ? Math.min(60000, ra * 1000) : Math.min(30000, 1000 * 2 ** attempt));
            continue;
          }
        }
        if (!res.ok) {
          const detail = redact((await res.text()).slice(0, 300), this.apiKey);
          // 受け付けない引数を外して1回だけやり直す (temperature・構造化出力の schema)
          if (res.status === 400 && this.sendTemperature && /temperature/i.test(detail) && /unsupported|not support|does not support|only the default/i.test(detail)) {
            this.sendTemperature = false; continue;
          }
          if (res.status === 400 && !triedSchema && /^json_schema/.test(this.structured) && schema && /response_format|json_schema|schema/i.test(detail) && !/exceeds the available context/.test(detail)) {
            this.structured = 'json_object'; triedSchema = true; continue;
          }
          throw new Error(`LLM HTTP ${res.status}: ${detail}`);
        }
        const d = await res.json();
        const ms = Date.now() - t0;
        const serverMs = d.timings && Number.isFinite(d.timings.prompt_ms) ? Math.round((d.timings.prompt_ms || 0) + (d.timings.predicted_ms || 0)) : null;
        stat = { ms, serverMs, waitMs: serverMs == null ? null : Math.max(0, ms - serverMs), error: false, provider: this.provider };
        const msg = d.choices?.[0]?.message || {};
        const promptTokens = d.usage?.prompt_tokens ?? null;
        const completionTokens = d.usage?.completion_tokens ?? null;
        const reasoningTokens = d.usage?.completion_tokens_details?.reasoning_tokens ?? null;
        const cachedTokens = d.timings?.cache_n ?? d.usage?.prompt_tokens_details?.cached_tokens ?? null;
        // llama-server の cache_n はキャッシュに当たったトークン (費用は 0 なので区別しない)
        // OpenAI: cached_tokens (キャッシュに当たった) と cache_write_tokens (キャッシュに書いた。単価が入力より高い) は prompt_tokens の内数
        const cacheWriteTokens = d.usage?.prompt_tokens_details?.cache_write_tokens ?? 0;
        const cost = costOf(this.pricing, { promptTokens, cachedTokens: d.usage?.prompt_tokens_details?.cached_tokens ?? 0, cacheWriteTokens, completionTokens });
        Object.assign(use, { error: false, promptTokens, cachedTokens: d.usage?.prompt_tokens_details?.cached_tokens ?? 0, cacheWriteTokens, completionTokens, reasoningTokens, ms, costUsd: cost.usd, priced: cost.priced });
        return {
          text: msg.content ?? '',
          refusal: msg.refusal ?? null,
          finishReason: d.choices?.[0]?.finish_reason ?? null, // 'length' = 出力が max_tokens か文脈の上限で切れた
          promptTokens, completionTokens, reasoningTokens, cachedTokens, cacheWriteTokens,
          ms, serverMs, waitMs: stat.waitMs, queueMs, retries, rateLimited,
          provider: this.provider, model: this.model, costUsd: cost.usd,
        };
      }
    } finally {
      if (this.sem) this.sem.release();
      if (stat.ms == null) stat.ms = Date.now() - t0;
      LLM_STATS.add(stat);
      use.ms = use.ms || stat.ms;
      use.retries = retries; use.rateLimited = rateLimited;
      LLM_USAGE.add(use);
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

module.exports = { LLMDecider, decisionSchema, LLM_STATS, LLM_USAGE, chatUrl };
