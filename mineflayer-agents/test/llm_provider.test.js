'use strict';
// 文を作る LLM の提供元 (local = llama.cpp の 2B / luna = gpt-6-luna) の切り替え。本物の luna は呼ばず、OpenAI 互換の偽サーバーで経路を確かめる
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const prov = require('../src/llm_provider');
const { LLMDecider, LLM_USAGE, chatUrl } = require('../src/deciders/llm');
const { Talker } = require('../src/talker');
const { GoalPath } = require('../src/goalpath');
const { UsageMeter, mergeUsageSummaries } = require('../src/usage');
const { overflowTokens } = require('../src/promptfit');
const { llmOverrides } = require('../run');
const { llmUsageSummary, llmUsageLines } = require('../tools/summarize_run');
const { loadConfig } = require('../src/config');

const KEY = 'sk-test-SECRETSECRETSECRET1234';
const noSleep = async () => {};

// OpenAI 互換の偽サーバー。handler(body, req) → { status, json, headers }
function fakeServer(handler) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', async () => {
      const body = JSON.parse(b || '{}');
      seen.push({ url: req.url, auth: req.headers.authorization, body });
      const r = await handler(body, req, seen.length);
      res.writeHead(r.status || 200, { 'Content-Type': 'application/json', ...(r.headers || {}) });
      res.end(JSON.stringify(r.json || {}));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, url: `http://127.0.0.1:${srv.address().port}/v1` })));
}

const okJson = (text, usage = {}) => ({ json: { choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 400 }, completion_tokens_details: { reasoning_tokens: 0 }, ...usage } } });

function lunaOpts(url, extra = {}) {
  return prov.llmOptsFor({ llm: { provider: 'luna', providers: { luna: { baseUrl: url, apiKey: KEY, ...extra } } }, decider: { llm: { baseUrl: 'http://127.0.0.1:18081', temperature: 0.4 } } }, 'talk');
}

const SAY = { type: 'object', properties: { say: { type: 'string', maxLength: 60 } }, required: ['say'], additionalProperties: false };
const MSG = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }];

test('llmOptsFor: 既定は全部 local (今まで通り decider.llm が効く)、役ごとに luna、luna では decider.llm の窓口を使わない', () => {
  const cfg = { decider: { llm: { baseUrl: 'http://x:1', model: 'gemma-4-e2b', temperature: 0.4, maxTokens: 96 } } };
  for (const r of prov.ROLES) {
    const o = prov.llmOptsFor(cfg, r, { maxTokens: 64 });
    assert.strictEqual(o.provider, 'local');
    assert.strictEqual(o.baseUrl, 'http://x:1');
    assert.strictEqual(o.maxTokens, 64);
    assert.strictEqual(o.tokenParam, 'max_tokens');
    assert.strictEqual(o.ctxTokens, 8192);
  }
  const c2 = { ...cfg, llm: { provider: 'local', roles: { goal: 'luna', reflect: 'luna' } } };
  const g = prov.llmOptsFor(c2, 'goal', { maxTokens: 120, temperature: 0.5, baseUrl: 'http://ignored' });
  assert.strictEqual(g.provider, 'luna');
  assert.strictEqual(g.model, 'gpt-6-luna');
  assert.strictEqual(g.baseUrl, 'https://api.openai.com/v1');
  assert.strictEqual(g.maxTokens, 120);
  assert.strictEqual(g.temperature, 0.5);
  assert.strictEqual(g.tokenParam, 'max_completion_tokens');
  assert.strictEqual(g.reasoningEffort, 'none');
  assert.strictEqual(prov.llmOptsFor(c2, 'talk').provider, 'local');
  // providers.local.baseUrl (--llm-base-url) は decider.llm.baseUrl より強い
  assert.strictEqual(prov.llmOptsFor({ ...cfg, llm: { providers: { local: { baseUrl: 'http://y:2' } } } }, 'talk').baseUrl, 'http://y:2');
  assert.throws(() => prov.llmOptsFor({ llm: { provider: 'nope' } }, 'talk'), /分からない/);
});

test('config の既定と --llm-provider など: 既定は local、引数で luna・役・モデル・URL・上限', () => {
  const base = loadConfig(path.join(__dirname, '..', 'configs', 'survival_3days.json'));
  assert.strictEqual(prov.providerFor(base, 'talk'), 'local');
  const ov = llmOverrides({ 'llm-provider': 'luna', 'llm-roles': 'talk=local,answer=local', 'llm-model': 'gpt-6-luna-x', 'llm-base-url': 'http://h/v1', 'max-llm-usd': '2.5' });
  assert.deepStrictEqual(ov, { provider: 'luna', roles: { talk: 'local', answer: 'local' }, providers: { luna: { model: 'gpt-6-luna-x', baseUrl: 'http://h/v1' } }, maxUsd: 2.5 });
  const cfg = loadConfig(path.join(__dirname, '..', 'configs', 'survival_3days.json'), { llm: ov });
  assert.strictEqual(prov.llmOptsFor(cfg, 'goal').model, 'gpt-6-luna-x');
  assert.strictEqual(prov.llmOptsFor(cfg, 'talk').provider, 'local');
  assert.strictEqual(llmOverrides({}), null);
  assert.throws(() => llmOverrides({ 'llm-roles': 'speak=luna' }), /役は/);
  assert.throws(() => llmOverrides({ 'llm-model': 'm' }), /--llm-provider/);
});

test('API キー: 環境変数 → luna.env の順に読む。無ければ checkKeys が知らせる (local だけなら要らない)。キーは表示に出ない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-'));
  const file = path.join(dir, 'luna.env');
  const p = prov.providerConfig({}, 'luna');
  assert.strictEqual(prov.loadProviderKey(p, { env: { LUNA_ENV_FILE: file } }), null);
  fs.writeFileSync(file, `# コメント\nexport LUNA_API_KEY="${KEY}"\n`, { mode: 0o600 });
  assert.strictEqual(prov.loadProviderKey(p, { env: { LUNA_ENV_FILE: file } }), KEY);
  fs.writeFileSync(file, `OPENAI_API_KEY=${KEY}x\n`);
  assert.strictEqual(prov.loadProviderKey(p, { env: { LUNA_ENV_FILE: file } }), `${KEY}x`);
  assert.strictEqual(prov.loadProviderKey(p, { env: { LUNA_ENV_FILE: file, LUNA_API_KEY: 'k1' } }), 'k1');
  // local だけなら要らない
  assert.ok(prov.checkKeys({}, { env: { LUNA_ENV_FILE: path.join(dir, 'none') } }).every((k) => k.ok));
  const ck = prov.checkKeys({ llm: { roles: { goal: 'luna' } } }, { env: { LUNA_ENV_FILE: path.join(dir, 'none') } });
  const bad = ck.find((k) => !k.ok);
  assert.ok(bad && bad.provider === 'luna' && bad.roles.includes('goal'));
  // 作ったデシダーを JSON にしても・エラーの文にもキーが出ない
  const d = new LLMDecider({ ...lunaOpts('http://127.0.0.1:1/v1') });
  assert.strictEqual(d.apiKey, KEY);
  assert.ok(!JSON.stringify(d).includes(KEY));
  assert.ok(!prov.redact(`Incorrect API key provided: ${KEY}`, KEY).includes(KEY));
  assert.ok(!prov.redact('Incorrect API key provided: sk-abcdefghijklmnop', null).includes('efghijklmnop'));
});

test('chatUrl: /v1 で終わる (OpenAI の書き方) も、無い (今までの local の書き方) も /v1/chat/completions', () => {
  assert.strictEqual(chatUrl('http://127.0.0.1:18081'), 'http://127.0.0.1:18081/v1/chat/completions');
  assert.strictEqual(chatUrl('http://192.168.15.30:18081/v1/'), 'http://192.168.15.30:18081/v1/chat/completions');
  assert.strictEqual(chatUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1/chat/completions');
});

test('strictSchema: 文字列の長さを外し、object は全部 required・additionalProperties false', () => {
  const s = prov.strictSchema({ type: 'object', properties: { a: { type: 'string', maxLength: 3 }, b: { type: 'object', properties: { c: { type: 'string', minLength: 1 } } } }, required: ['a'] });
  assert.deepStrictEqual(s, { type: 'object', properties: { a: { type: 'string' }, b: { type: 'object', properties: { c: { type: 'string' } }, required: ['c'], additionalProperties: false } }, required: ['a', 'b'], additionalProperties: false });
});

test('luna の経路 (偽サーバー): max_completion_tokens・reasoning_effort・strict の json_schema・キー、使用量と費用を提供元・役ごとに', async () => {
  LLM_USAGE.reset();
  const { srv, seen, url } = await fakeServer(() => okJson('{"say":"やあ"}'));
  try {
    const d = new LLMDecider({ ...lunaOpts(url), mode: 'talk', maxTokens: 64 });
    const r = await d.complete(MSG, SAY);
    assert.strictEqual(r.text, '{"say":"やあ"}');
    const b = seen[0].body;
    assert.strictEqual(seen[0].url, '/v1/chat/completions');
    assert.strictEqual(seen[0].auth, `Bearer ${KEY}`);
    assert.strictEqual(b.model, 'gpt-6-luna');
    assert.strictEqual(b.max_completion_tokens, 64);
    assert.strictEqual(b.max_tokens, undefined);
    assert.strictEqual(b.reasoning_effort, 'none');
    assert.strictEqual(b.response_format.type, 'json_schema');
    assert.strictEqual(b.response_format.json_schema.strict, true);
    assert.strictEqual(b.response_format.json_schema.schema.properties.say.maxLength, undefined);
    // 費用: (600 × 0.10 + 400 × 0.01 + 20 × 0.50) / 1e6
    const want = (600 * 0.10 + 400 * 0.01 + 20 * 0.50) / 1e6;
    assert.ok(Math.abs(r.costUsd - want) < 1e-12);
    const u = LLM_USAGE.summary();
    assert.strictEqual(u.byProvider.luna.calls, 1);
    assert.strictEqual(u.byRole['luna/talk'].promptTokens, 1000);
    assert.strictEqual(u.byRole['luna/talk'].cachedTokens, 400);
    assert.strictEqual(u.providers.luna.priced, true);
    assert.ok(!JSON.stringify(u).includes(KEY));
  } finally { srv.close(); LLM_USAGE.reset(); }
});

test('推論あり: reasoning_effort を送り、出力の上限に推論の分を足す。推論のトークンを別に数える', async () => {
  LLM_USAGE.reset();
  const { srv, seen, url } = await fakeServer(() => okJson('{"say":"a"}', { completion_tokens: 300, completion_tokens_details: { reasoning_tokens: 280 } }));
  try {
    const d = new LLMDecider({ ...lunaOpts(url, { reasoningEffort: 'low', reasoningExtraTokens: 1000 }), mode: 'talk', maxTokens: 64 });
    const r = await d.complete(MSG, SAY);
    assert.strictEqual(seen[0].body.reasoning_effort, 'low');
    assert.strictEqual(seen[0].body.max_completion_tokens, 1064);
    assert.strictEqual(r.reasoningTokens, 280);
    assert.strictEqual(LLM_USAGE.summary().byProvider.luna.reasoningTokens, 280);
  } finally { srv.close(); LLM_USAGE.reset(); }
});

test('429: retry-after を待って再試行し、回数を数える。上限を超えたら失敗', async () => {
  LLM_USAGE.reset();
  const waits = [];
  const { srv, url } = await fakeServer((b, req, n) => (n <= 2 ? { status: 429, headers: { 'retry-after': '2' }, json: { error: { message: 'rate limit' } } } : okJson('{"say":"b"}')));
  try {
    const d = new LLMDecider({ ...lunaOpts(url), mode: 'talk', sleep: async (ms) => { waits.push(ms); } });
    const r = await d.complete(MSG, SAY);
    assert.strictEqual(r.rateLimited, 2);
    assert.deepStrictEqual(waits, [2000, 2000]);
    assert.strictEqual(LLM_USAGE.summary().byProvider.luna.rateLimited, 2);
  } finally { srv.close(); }
  const { srv: s2, url: u2 } = await fakeServer(() => ({ status: 429, json: { error: { message: `rate limit for ${KEY}` } } }));
  try {
    const d = new LLMDecider({ ...lunaOpts(u2, { maxRetries: 1 }), mode: 'talk', sleep: noSleep });
    await assert.rejects(d.complete(MSG, SAY), (e) => /HTTP 429/.test(e.message) && !e.message.includes(KEY));
  } finally { s2.close(); LLM_USAGE.reset(); }
});

test('受け付けない引数: temperature を断られたら外して送り直す。schema を断られたら json_object にする', async () => {
  LLM_USAGE.reset();
  const { srv, seen, url } = await fakeServer((b) => {
    if (b.temperature != null) return { status: 400, json: { error: { message: "Unsupported value: 'temperature' does not support 0.7 with this model. Only the default (1) value is supported." } } };
    if (b.response_format && b.response_format.type === 'json_schema') return { status: 400, json: { error: { message: "Invalid schema for response_format 'decision'" } } };
    return okJson('{"say":"c"}');
  });
  try {
    const d = new LLMDecider({ ...lunaOpts(url), mode: 'talk', temperature: 0.7 });
    const r = await d.complete(MSG, SAY);
    assert.strictEqual(r.text, '{"say":"c"}');
    assert.strictEqual(seen.length, 3);
    assert.strictEqual(seen[2].body.response_format.type, 'json_object');
    assert.match(seen[2].body.messages[1].content, /JSON schema/);
    assert.strictEqual(d.sendTemperature, false);
    assert.strictEqual(d.structured, 'json_object');
    // 次からは初めから外す
    await d.complete(MSG, SAY);
    assert.strictEqual(seen.length, 4);
  } finally { srv.close(); LLM_USAGE.reset(); }
});

test('同時に投げる数の上限 (提供元ごとに共有): 20人が一斉に呼んでも maxConcurrent まで', async () => {
  LLM_USAGE.reset();
  let active = 0; let peak = 0;
  const { srv, url } = await fakeServer(async () => { active += 1; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 20)); active -= 1; return okJson('{"say":"d"}'); });
  try {
    const opts = lunaOpts(url, { maxConcurrent: 3, model: 'gpt-6-luna-conc' });
    const ds = Array.from({ length: 20 }, () => new LLMDecider({ ...opts, mode: 'talk' }));
    await Promise.all(ds.map((d) => d.complete(MSG, SAY)));
    assert.strictEqual(peak, 3);
    assert.strictEqual(LLM_USAGE.summary().byProvider.luna.calls, 20);
  } finally { srv.close(); LLM_USAGE.reset(); }
});

test('費用の上限: 超えたら知らせ、以後は投げずに失敗にする', async () => {
  LLM_USAGE.reset();
  const { srv, seen, url } = await fakeServer(() => okJson('{"say":"e"}', { prompt_tokens: 200000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } }));
  try {
    LLM_USAGE.maxUsd = 0.03;
    const fired = [];
    LLM_USAGE.onExceeded((u) => fired.push(u.costUsd));
    const d = new LLMDecider({ ...lunaOpts(url), mode: 'talk' });
    await d.complete(MSG, SAY); // $0.02
    assert.strictEqual(fired.length, 0);
    await d.complete(MSG, SAY); // $0.04
    assert.deepStrictEqual(fired, [0.04]);
    await assert.rejects(d.complete(MSG, SAY), /上限/);
    assert.strictEqual(seen.length, 2);
  } finally { srv.close(); LLM_USAGE.reset(); }
});

test('入力が 272K を超える呼び出しは入力 2倍・出力 1.5倍', () => {
  const p = prov.providerConfig({}, 'luna').pricing;
  assert.ok(Math.abs(prov.costOf(p, { promptTokens: 300000, completionTokens: 1000 }).usd - (300000 * 0.2 + 1000 * 0.75) / 1e6) < 1e-12);
  assert.deepStrictEqual(prov.costOf(prov.providerConfig({}, 'local').pricing, { promptTokens: 5000, completionTokens: 50 }), { usd: 0, priced: true });
});

test('料金が分からない提供元: 費用 0 で数え、「未設定」と残す', async () => {
  LLM_USAGE.reset();
  const { srv, url } = await fakeServer(() => okJson('{"say":"f"}'));
  try {
    const cfg = { llm: { provider: 'other', providers: { other: { apiStyle: 'openai', baseUrl: url, model: 'm', apiKey: 'k', pricing: { inputPerMTok: null, outputPerMTok: null } } } } };
    const d = new LLMDecider({ ...prov.llmOptsFor(cfg, 'reflect'), mode: 'talk' });
    const r = await d.complete(MSG, SAY);
    assert.strictEqual(r.costUsd, 0);
    const u = LLM_USAGE.summary();
    assert.strictEqual(u.providers.other.priced, '未設定');
    assert.strictEqual(u.byProvider.other.unpriced, 1);
  } finally { srv.close(); LLM_USAGE.reset(); }
});

test('Talker: 役ごとに提供元を分ける (talk は local、broadcast・propose・report_find は luna)。記録に provider', async () => {
  LLM_USAGE.reset();
  const local = await fakeServer(() => ({ json: { choices: [{ message: { content: '{"say":"近く"}' } }], usage: { prompt_tokens: 10, completion_tokens: 3 }, timings: { prompt_ms: 5, predicted_ms: 5 } } }));
  const luna = await fakeServer(() => okJson('{"say":"全体"}'));
  try {
    const cfg = { decider: { llm: { baseUrl: local.url.replace(/\/v1$/, '') } }, llm: { roles: { broadcast: 'luna' }, providers: { luna: { baseUrl: luna.url, apiKey: KEY } } } };
    const meter = new UsageMeter();
    const t = new Talker({ llmOptsFor: (role) => prov.llmOptsFor(cfg, role, { maxTokens: 64, temperature: 0.7 }), meter });
    assert.match(t.kind, /broadcast=luna\(gpt-6-luna\)/);
    const a = await t.talk({ persona: { name: 'A' } });
    const b = await t.broadcast({ persona: { name: 'A' } });
    assert.strictEqual(a.say, '近く');
    assert.strictEqual(a.provider, 'local');
    assert.strictEqual(b.say, '全体');
    assert.strictEqual(b.provider, 'luna');
    assert.strictEqual(local.seen[0].body.max_tokens, 64);
    assert.strictEqual(local.seen[0].auth, undefined);
    assert.strictEqual(luna.seen[0].body.max_completion_tokens, 64);
    const s = meter.summary();
    assert.strictEqual(s.llm.byRole['local/talk'].calls, 1);
    assert.strictEqual(s.llm.byRole['luna/broadcast'].calls, 1);
    assert.strictEqual(s.llm.byProvider.local.costUsd, 0);
    // 全部 local なら記録の書き方は今まで通り
    assert.strictEqual(new Talker({ llmOptsFor: (role) => prov.llmOptsFor({ decider: { llm: {} } }, role) }).kind, '2B(gemma-4-e2b)');
  } finally { local.srv.close(); luna.srv.close(); LLM_USAGE.reset(); }
});

test('GoalPath: 文脈の上限は提供元の ctxTokens (luna は 272K)。local は goalPath.prompt.ctxTokens が勝つ', () => {
  const luna = new LLMDecider({ ...prov.llmOptsFor({ llm: { roles: { goal: 'luna' }, providers: { luna: { apiKey: 'k' } } } }, 'goal'), mode: 'talk' });
  assert.strictEqual(new GoalPath({ llm: luna, cfg: { prompt: { ctxTokens: 8192 } } }).cfg.prompt.ctxTokens, 272000);
  const local = new LLMDecider({ ...prov.llmOptsFor({}, 'goal'), mode: 'talk' });
  assert.strictEqual(new GoalPath({ llm: local, cfg: { prompt: { ctxTokens: 4096 } } }).cfg.prompt.ctxTokens, 4096);
  assert.strictEqual(new GoalPath({ llm: local }).cfg.prompt.ctxTokens, 8192);
});

test('promptfit: OpenAI の文脈あふれの文も読む', () => {
  assert.deepStrictEqual(overflowTokens("This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens."), { request: 9000, ctx: 8192 });
  assert.deepStrictEqual(overflowTokens('request (4136 tokens) exceeds the available context size (4096 tokens)'), { request: 4136, ctx: 4096 });
});

test('mergeUsageSummaries と summarize_run: プロセスごとの LLM の使用量を足し、提供元・役ごとに出す', () => {
  const part = (usd) => ({ jev: {}, twoB: {}, llm: { byProvider: { luna: { calls: 2, errors: 0, rateLimited: 1, retries: 1, promptTokens: 100, cachedTokens: 0, completionTokens: 10, reasoningTokens: 0, ms: 200, costUsd: usd, unpriced: 0 } },
    byRole: { 'luna/goal': { calls: 2, errors: 0, rateLimited: 1, retries: 1, promptTokens: 100, cachedTokens: 0, completionTokens: 10, reasoningTokens: 0, ms: 200, costUsd: usd, unpriced: 0 } },
    providers: { luna: { model: 'gpt-6-luna', pricing: { inputPerMTok: 0.1, outputPerMTok: 0.5 }, priced: true } }, costUsd: usd, maxUsd: 1, exceeded: false } });
  const m = mergeUsageSummaries([part(0.001), part(0.002), null]);
  assert.strictEqual(m.llm.byProvider.luna.calls, 4);
  assert.strictEqual(m.llm.byProvider.luna.avgMs, 100);
  assert.strictEqual(m.llm.costUsd, 0.003);
  assert.strictEqual(m.llm.maxUsd, 1);
  const lines = llmUsageLines(llmUsageSummary(m.llm));
  assert.match(lines[0], /費用 \$0\.003 \(上限 \$1\)/);
  assert.ok(lines.some((l) => /luna: 4 回 .*429 2.*gpt-6-luna/.test(l)));
  assert.ok(lines.some((l) => /luna\/goal: 4 回/.test(l)));
});
