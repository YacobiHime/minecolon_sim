'use strict';
// Jev の提供元の切り替え (openrouter / typesafe)、OpenRouter のレスポンスの違い (id・provider・usage.cost・refusal)、再試行と 402 の扱い。
// 模擬の fetch だけ (本物の API は呼ばない)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JevClient, loadApiKey, splitRefusals, LONG_CONTEXT_BYTES } = require('../src/jev_client');
const { JevDecider } = require('../src/deciders/jev');
const { UsageMeter, mergeUsageSummaries } = require('../src/usage');
const { buildContext } = require('../src/agent');
const { Memory } = require('../src/memory');
const { loadConfig } = require('../src/config');
const { parseArgs } = require('../run');
const { mockRaw } = require('./fixtures');

function ctx(over = {}) {
  const cfg = loadConfig(null, { persona: { name: 'Taro' }, goal: { text: '小屋を作る', hints: [] }, help: { askOthers: true, excludeFailures: false } });
  return buildContext(mockRaw(over), new Memory({ limits: { promptItems: 20 } }), cfg, { foods: new Set(['bread']), socialText: '落ち着いている', lastResult: 'collect(spruce_log)→成功' });
}

const headers = (h = {}) => new Map(Object.entries(h));
function res(status, json, h = {}) {
  return { ok: status >= 200 && status < 300, status, headers: headers(h), json: async () => json, text: async () => JSON.stringify(json) };
}

test('提供元: 既定は openrouter (URL・キーの変数)。typesafe に切り替えられ、モデルは提供元ごとに固定できる', () => {
  const env = { OPENROUTER_API: 'or-key', TYPESAFE_API_KEY: 'ts-key' };
  const a = new JevClient({ env });
  assert.strictEqual(a.provider, 'openrouter');
  assert.strictEqual(a.url, 'https://openrouter.ai/api/v1/systemone');
  assert.strictEqual(a.apiKey, 'or-key');
  assert.strictEqual(a.model, 'jev-latest');
  const b = new JevClient({ env, provider: 'typesafe' });
  assert.strictEqual(b.url, 'https://api.typesafe.ai/v1/systemone');
  assert.strictEqual(b.apiKey, 'ts-key');
  const c = new JevClient({ env, provider: 'openrouter', model: 'jev-latest', providers: { openrouter: { model: 'typesafe/jev-1.14' }, typesafe: { model: 'jev-1.14.0' } } });
  assert.strictEqual(c.model, 'typesafe/jev-1.14');
  const d = new JevClient({ env, provider: 'typesafe', providers: { openrouter: { model: 'typesafe/jev-1.14' }, typesafe: { model: 'jev-1.14.0' } } });
  assert.strictEqual(d.model, 'jev-1.14.0');
  assert.throws(() => new JevClient({ env, provider: 'nope' }), /提供元/);
});

test('OpenRouter のキー: OPENROUTER_API (ユーザーの名前) と OPENROUTER_API_KEY のどちらも、環境変数かファイルから読む', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'or-'));
  const f = path.join(dir, 'openrouter.env');
  fs.writeFileSync(f, '# c\nOPENROUTER_API=sk-or-v1-abc\n');
  assert.strictEqual(loadApiKey({ env: {}, provider: 'openrouter', file: f }), 'sk-or-v1-abc');
  fs.writeFileSync(f, 'export OPENROUTER_API_KEY="sk-or-v1-def"\n');
  assert.strictEqual(loadApiKey({ env: {}, provider: 'openrouter', file: f }), 'sk-or-v1-def');
  // 環境変数 OPENROUTER_API は最優先、OPENROUTER_API_KEY はファイルの後 (シェルの古いキーよりファイルを使う)
  assert.strictEqual(loadApiKey({ env: { OPENROUTER_API: 'x' }, provider: 'openrouter', file: f }), 'x');
  assert.strictEqual(loadApiKey({ env: { OPENROUTER_API_KEY: 'stale' }, provider: 'openrouter', file: f }), 'sk-or-v1-def');
  assert.strictEqual(loadApiKey({ env: { OPENROUTER_API_KEY: 'only' }, provider: 'openrouter', file: path.join(dir, 'none') }), 'only');
  assert.strictEqual(loadApiKey({ env: { OPENROUTER_ENV_FILE: path.join(dir, 'none') }, provider: 'openrouter' }), null);
  // typesafe の既定 (前からの呼び方) はそのまま
  assert.strictEqual(loadApiKey({ env: { TYPESAFE_API_KEY: 't' } }), 't');
});

test('OpenRouter のレスポンス: id・provider・usage.cost・返ったモデル名を返し、refusal の答えを外して名前を残す', async () => {
  const seen = [];
  const c = new JevClient({ apiKey: 'k', fetch: async (url, init) => { seen.push({ url, init }); return res(200, {
    id: 'gen-1', provider: 'TypeSafe', model: 'typesafe/jev-1.14-20261014',
    answers: { a: { type: 'noul', noul: 0.7 }, b: { type: 'refusal' } }, usage: { input_tokens: 100, output_tokens: 3, cost: 0.0000042 } }); } });
  const r = await c.ask({ s: 1 }, { a: { type: 'noul' }, b: { type: 'noul' } });
  assert.ok(r.ok);
  assert.strictEqual(r.id, 'gen-1');
  assert.strictEqual(r.provider, 'TypeSafe');
  assert.strictEqual(r.model, 'typesafe/jev-1.14-20261014');
  assert.strictEqual(r.costUsd, 0.0000042);
  assert.strictEqual(r.via, 'openrouter');
  assert.deepStrictEqual(Object.keys(r.answers), ['a']);
  assert.deepStrictEqual(r.refusals, ['b']);
  assert.strictEqual(seen[0].init.headers.Authorization, 'Bearer k');
  assert.ok(seen[0].init.headers['X-OpenRouter-Title']);
  assert.deepStrictEqual(splitRefusals(null), { answers: {}, refusals: [] });
});

test('再試行: 429・502・503・524・529 と 402 の in-flight 予算 (Retry-After に従う)。残高不足の 402 は再試行せず fatal で止める', async () => {
  const waits = [];
  const seq = [
    res(429, {}, { 'retry-after': '1' }),
    res(402, { error: { code: 402, message: 'in-flight budget', metadata: { limit_source: 'openrouter_in_flight_budget' } } }, { 'retry-after': '3' }),
    res(524, {}), res(503, {}), res(502, {}), res(529, {}),
    res(200, { answers: { a: { type: 'noul', noul: 0.5 } }, usage: { input_tokens: 10, output_tokens: 1, cost: 0 } }),
  ];
  const c = new JevClient({ apiKey: 'k', maxRetries: 10, sleep: async (ms) => waits.push(ms), fetch: async () => seq.shift() });
  const r = await c.ask({}, { a: { type: 'noul' } });
  assert.ok(r.ok);
  assert.strictEqual(r.retries, 6);
  assert.strictEqual(r.rateLimited, 2); // 429 と in-flight の 402
  assert.deepStrictEqual(waits.slice(0, 2), [1000, 3000]);

  const fatals = [];
  let n = 0;
  const c2 = new JevClient({ apiKey: 'secret-key-123', maxRetries: 5, sleep: async () => {}, fetch: async () => { n += 1; return res(402, { error: { code: 402, message: 'Insufficient credits. key secret-key-123' } }); } });
  c2.onFatal((f) => fatals.push(f));
  const r2 = await c2.ask({}, { a: { type: 'noul' } });
  assert.ok(!r2.ok);
  assert.ok(r2.fatal);
  assert.strictEqual(n, 1, '残高不足は再試行しない');
  assert.match(r2.error, /残高/);
  assert.ok(!r2.error.includes('secret-key-123'), 'キーはエラーの文に出さない');
  assert.strictEqual(fatals.length, 1);
  const r3 = await c2.ask({}, { a: { type: 'noul' } });
  assert.ok(r3.fatal);
  assert.strictEqual(n, 1, 'fatal のあとは送らない');
});

test('本文が 32,000 バイトを超えたら longContext と bodyBytes を返す', async () => {
  const c = new JevClient({ apiKey: 'k', fetch: async () => res(200, { answers: {}, usage: { input_tokens: 1, output_tokens: 0 } }) });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const small = await c.ask({ t: 'x' }, {});
    assert.ok(!small.longContext);
    const big = await c.ask({ t: 'あ'.repeat(11000) }, {}); // 3バイト × 11000
    assert.ok(big.longContext);
    assert.ok(big.bodyBytes > LONG_CONTEXT_BYTES);
  } finally { console.warn = warn; }
});

test('JevDecider: next_action の refusal は選べなかった扱い (action null・refusal を記録)。ほかの質問の refusal は答えが無い扱い', async () => {
  const meter = new UsageMeter();
  const fetch1 = async () => res(200, { id: 'g', provider: 'TypeSafe', model: 'typesafe/jev-1.14-20261014', answers: { next_action: { type: 'refusal' }, remember: { type: 'score', score: 2 } }, usage: { input_tokens: 500, output_tokens: 2, cost: 0.000021 } });
  const d = new JevDecider({ client: new JevClient({ apiKey: 'k', fetch: fetch1 }), meter, twoStage: false });
  const r = await d.decide(ctx());
  assert.strictEqual(r.action, null);
  assert.ok(r.refusal);
  assert.match(r.error, /refusal/);
  assert.deepStrictEqual(r.jev.refusals, ['next_action']);
  assert.strictEqual(r.jev.id, 'g');
  assert.strictEqual(r.jev.provider, 'TypeSafe');
  assert.strictEqual(r.jev.costUsd, 0.000021);
  assert.strictEqual(r.jev.via, 'openrouter');
  const u = meter.summary().jev;
  assert.strictEqual(u.refusals, 1);
  assert.strictEqual(u.reportedCostUsd, 0.000021);
  assert.strictEqual(u.costUsd, 0.000021, '費用は usage.cost の合計');
  assert.deepStrictEqual(u.models, { 'typesafe/jev-1.14-20261014': 1 });

  // talk・remember が refusal でも行動は選ぶ
  const fetch2 = async (url, init) => {
    const b = JSON.parse(init.body);
    const first = Object.keys(b.questions.next_action.criteria)[0];
    return res(200, { answers: { next_action: { type: 'choice', choice: first, probabilities: { [first]: 0.9 } }, remember: { type: 'refusal' }, ...(b.questions.talk ? { talk: { type: 'refusal' } } : {}) }, usage: { input_tokens: 400, output_tokens: 2 } });
  };
  const d2 = new JevDecider({ client: new JevClient({ apiKey: 'k', fetch: fetch2 }), twoStage: false });
  const r2 = await d2.decide(ctx());
  assert.ok(r2.parseOk);
  assert.strictEqual(r2.jev.remember, null);
  assert.ok(r2.jev.refusals.includes('remember'));
});

test('費用: usage.cost が返らない呼び出しは入力トークン × 単価で足す。--procs のまとめでも費用・refusal・モデルを足す', () => {
  const a = new UsageMeter();
  a.addJev({ inputTokens: 1000000, costUsd: 0.05, model: 'm1', via: 'openrouter', refusals: ['x'], bodyBytes: 40000, longContext: true });
  const b = new UsageMeter();
  b.addJev({ inputTokens: 1000000, model: 'm1', via: 'typesafe', bodyBytes: 100 });
  assert.strictEqual(a.summary().jev.costUsd, 0.05);
  assert.strictEqual(b.summary().jev.costUsd, 0.042);
  const m = mergeUsageSummaries([a.summary(), b.summary()]).jev;
  assert.strictEqual(m.costUsd, 0.092);
  assert.strictEqual(m.refusals, 1);
  assert.strictEqual(m.longContextCalls, 1);
  assert.strictEqual(m.maxBodyBytes, 40000);
  assert.deepStrictEqual(m.models, { m1: 2 });
  assert.deepStrictEqual(m.via, { openrouter: 1, typesafe: 1 });
  // --max-jev-tokens の上限は入力トークンで今まで通り効く
  const c = new UsageMeter({ maxJevInputTokens: 1500 });
  c.addJev({ inputTokens: 1000, costUsd: 0.00001 });
  assert.ok(!c.exceeded);
  c.addJev({ inputTokens: 600, costUsd: 0.00001 });
  assert.ok(c.exceeded);
});

test('goalpath: 案の Jev の答えが refusal なら P = 0 として選び、記録に refusals・費用・提供元を残す (落ちない)', async () => {
  const { GoalPath } = require('../src/goalpath');
  const knowledge = require('../src/knowledge');
  const goals = JSON.stringify({ goals: [
    { kind: 'item', target: 'apple', count: 1, why: '食べる', need: '空腹' },
    { kind: 'item', target: 'jungle_log', count: 2, why: '木', need: '空腹' },
  ] });
  const llm = { complete: async () => ({ text: goals, promptTokens: 100, completionTokens: 50, finishReason: 'stop' }) };
  // 本物の窓口 (JevClient) を通して refusal を外させる
  const client = new JevClient({ apiKey: 'k', fetch: async (url, init) => {
    const q = JSON.parse(init.body).questions;
    return res(200, { answers: Object.fromEntries(Object.keys(q).map((k) => [k, k.startsWith('p1_') ? { type: 'refusal' } : { type: 'noul', noul: 0.6 }])), usage: { input_tokens: 300, output_tokens: 2, cost: 0.0000126 } });
  } });
  const jev = new JevDecider({ client, twoStage: false });
  const ev = [];
  const gp = new GoalPath({ llm, jev, log: (e) => ev.push(e), cfg: { select: { enabled: true, k: 2, later: false } } });
  const raw = mockRaw({ inventory: [], blocks: [{ name: 'jungle_log', nearest: { x: 3, y: 64, z: 0, d: 3 } }, { name: 'oak_leaves', nearest: { x: 4, y: 66, z: 0, d: 4 } }], entities: [], heard: [] });
  await gp.update({ persona: { name: 'Taro' }, obsText: 'x', raw, facts: () => [], allFacts: knowledge.loadFacts(), memText: 'なし', people: [], places: [], placeKinds: [], needNow: () => 0.5,
    pressing: () => [{ need: 'hunger', distress: 1.5, ratio: 1.2, textEn: 'hungry' }] }, 1);
  const g = ev.find((e) => e.kind === 'goal');
  assert.ok(g, JSON.stringify(ev.map((e) => e.kind)));
  const s = g.select;
  assert.ok(s.jev.ok);
  assert.ok(s.jev.refusals && s.jev.refusals.every((k) => k.startsWith('p1_')), JSON.stringify(s.jev));
  assert.strictEqual(s.jev.costUsd, 0.0000126);
  assert.strictEqual(s.jev.via, 'openrouter');
  const p1 = s.scores.find((x) => x.target === 'apple');
  assert.ok(Object.values(p1.P).every((v) => v === 0), '答えの無い案は P = 0');
  assert.strictEqual(g.target, 'jungle_log');
});

test('run.js: --jev-provider / --jev-model を読む', () => {
  const a = parseArgs(['node', 'run.js', '--config', 'x.json', '--jev-provider', 'typesafe', '--jev-model', 'jev-1.14.0']);
  assert.strictEqual(a['jev-provider'], 'typesafe');
  assert.strictEqual(a['jev-model'], 'jev-1.14.0');
});

test('OpenRouter のモデル名: TypeSafe 直の綴り jev-1.14.0 は typesafe/jev-1.14 に直す (ほかはそのまま)', () => {
  const { openrouterModel } = require('../src/jev_client');
  assert.strictEqual(openrouterModel('openrouter', 'jev-1.14.0'), 'typesafe/jev-1.14');
  assert.strictEqual(openrouterModel('openrouter', 'jev-latest'), 'jev-latest');
  assert.strictEqual(openrouterModel('openrouter', 'typesafe/jev-1.14'), 'typesafe/jev-1.14');
  assert.strictEqual(openrouterModel('typesafe', 'jev-1.14.0'), 'jev-1.14.0');
  assert.strictEqual(new JevClient({ apiKey: 'k', model: 'jev-1.14.0' }).model, 'typesafe/jev-1.14');
});

test('gpt-6-luna: キャッシュへの書き込み (cache_write_tokens) は $0.125、推論ありでは temperature を初めから送らない', () => {
  const prov = require('../src/llm_provider');
  const p = prov.providerConfig({}, 'luna').pricing;
  // 実際の応答の形: prompt 4082 (うち書き込み 4079)・出力 120
  const c = prov.costOf(p, { promptTokens: 4082, cachedTokens: 0, cacheWriteTokens: 4079, completionTokens: 120 });
  assert.ok(Math.abs(c.usd - (3 * 0.10 + 4079 * 0.125 + 120 * 0.5) / 1e6) < 1e-12);
  const c2 = prov.costOf(p, { promptTokens: 1262, cachedTokens: 1259, completionTokens: 27 });
  assert.ok(Math.abs(c2.usd - (3 * 0.10 + 1259 * 0.01 + 27 * 0.5) / 1e6) < 1e-12);
  const none = prov.llmOptsFor({ llm: { provider: 'luna' } }, 'talk');
  assert.strictEqual(none.sendTemperature, undefined, 'reasoning_effort none なら temperature を送る');
  const low = prov.llmOptsFor({ llm: { provider: 'luna', providers: { luna: { reasoningEffort: 'low' } } } }, 'reflect');
  assert.strictEqual(low.sendTemperature, false);
  const forced = prov.llmOptsFor({ llm: { provider: 'luna', providers: { luna: { reasoningEffort: 'low', sendTemperature: true } } } }, 'reflect');
  assert.strictEqual(forced.sendTemperature, true);
});
