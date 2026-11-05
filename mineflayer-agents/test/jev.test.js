'use strict';
// Jev の decider と窓口を、模擬の fetch で確かめる (本物の API は呼ばない)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JevDecider, actionOptions } = require('../src/deciders/jev');
const { JevClient, loadApiKey } = require('../src/jev_client');
const { UsageMeter } = require('../src/usage');
const { buildContext } = require('../src/agent');
const { Memory } = require('../src/memory');
const { loadConfig } = require('../src/config');
const { resolveDecision } = require('../src/actions');
const { mockRaw } = require('./fixtures');

function ctx(over = {}) {
  const cfg = loadConfig(null, { persona: { name: 'Taro' }, goal: { text: '小屋を作る', hints: ['原木1個から板材4個'] }, help: { askOthers: true, excludeFailures: false } });
  return buildContext(mockRaw(over), new Memory({ limits: { promptItems: 20 } }), cfg, { foods: new Set(['bread']), socialText: '落ち着いている', lastResult: 'collect(spruce_log)→成功' });
}

// answers を作る関数を受け取り、送られた body を seen に残す
function jevFetch(makeAnswers, seen = [], { usage = { input_tokens: 777, output_tokens: 30 }, status = 200 } = {}) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ url, body, headers: init.headers });
    return { ok: status === 200, status, headers: new Map(), json: async () => ({ model: 'jev-1.14.0', answers: makeAnswers(body), ...(usage ? { usage } : {}) }), text: async () => 'err' };
  };
}

const firstChoice = (body) => ({
  next_action: { type: 'choice', choice: Object.keys(body.questions.next_action.criteria)[0], confidence: 0.9 },
  remember: { type: 'score', score: 3.2, confidence: 0.5 },
  ...(body.questions.talk ? { talk: { type: 'noul', noul: 0.8 } } : {}),
  ...(body.questions.rel_0 ? { rel_0: { type: 'score', score: 3.6 } } : {}),
});

test('actionOptions: 行動と引数を "行動:引数" の選択肢にし、say (発言) は入れない', () => {
  const c = ctx();
  const { criteria, map } = actionOptions(c.actions);
  assert.ok(criteria['collect:spruce_log']);
  assert.ok(criteria['explore:north']);
  assert.ok(criteria['wait:3']);
  assert.ok(criteria.look_around);
  assert.ok(!Object.keys(criteria).some((k) => k.startsWith('say')));
  for (const [k, v] of Object.entries(map)) assert.ok(resolveDecision(c.actions, v.action, v.arg).ok, k);
});

test('JevDecider: 1回の呼び出しに choice / score / noul / 相手ごとの score をまとめ、結果を読む', async () => {
  const seen = [];
  const meter = new UsageMeter();
  const d = new JevDecider({ client: new JevClient({ apiKey: 'test-key', fetch: jevFetch(firstChoice, seen) }), meter });
  const r = await d.decide(ctx());
  assert.strictEqual(seen.length, 1);
  const b = seen[0].body;
  assert.strictEqual(seen[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.strictEqual(seen[0].headers.Authorization, 'Bearer test-key');
  assert.strictEqual(b.model, 'jev-latest');
  assert.ok(!Array.isArray(b.questions), 'questions は名前をキーにした辞書');
  assert.strictEqual(b.questions.next_action.type, 'choice');
  assert.strictEqual(b.questions.remember.type, 'score');
  assert.strictEqual(b.questions.remember.criteria.length, 5);
  assert.strictEqual(b.questions.talk.type, 'noul'); // mockRaw には見えている人 (Hanako) がいる
  assert.match(b.questions.rel_0.instructions, /Hanako/); // Hanako の発言が聞こえている
  assert.strictEqual(b.state.you, 'Taro');
  assert.match(b.state.inventory, /spruce_log x2/); // 英語の state (stateLang: en が既定)
  assert.ok(b.state.knowledge.some((k) => k.includes('板材')), '英語の文の無い goal.hints は原文のまま');
  assert.ok(r.parseOk);
  assert.ok(resolveDecision(ctx().actions, r.action, r.arg).ok);
  assert.strictEqual(r.jev.talkP, 0.8);
  assert.strictEqual(r.jev.remember, 3.2);
  assert.deepStrictEqual(r.jev.relations, { Hanako: 3.6 });
  assert.strictEqual(r.jev.inputTokens, 777);
  assert.strictEqual(r.jev.tokensEstimated, false);
  const u = meter.summary().jev;
  assert.strictEqual(u.calls, 1);
  assert.strictEqual(u.inputTokens, 777);
  assert.ok(u.inputChars > 100);
});

test('JevDecider: 人が見えず何も聞こえないときは talk と rel を聞かない', async () => {
  const seen = [];
  const d = new JevDecider({ client: new JevClient({ apiKey: 'k', fetch: jevFetch(firstChoice, seen) }) });
  const r = await d.decide(ctx({ entities: [], heard: [] }));
  assert.ok(!seen[0].body.questions.talk);
  assert.ok(!seen[0].body.questions.rel_0);
  assert.strictEqual(r.jev.talkP, null);
});

test('使用量が返らないときは文字数から推定し、推定したことを記録する', async () => {
  const meter = new UsageMeter();
  const d = new JevDecider({ client: new JevClient({ apiKey: 'k', fetch: jevFetch(firstChoice, [], { usage: null }) }), meter });
  const r = await d.decide(ctx());
  assert.strictEqual(r.jev.tokensEstimated, true);
  assert.ok(r.jev.inputTokens > 50);
  assert.strictEqual(meter.summary().jev.estimatedCalls, 1);
});

test('一覧にない選択・HTTP エラーは parseOk=false (agent が look_around に落とす)', async () => {
  const bad = new JevDecider({ client: new JevClient({ apiKey: 'k', fetch: jevFetch(() => ({ next_action: { type: 'choice', choice: 'fly:moon' } })) }) });
  const r1 = await bad.decide(ctx());
  assert.strictEqual(r1.parseOk, false);
  const err = new JevDecider({ client: new JevClient({ apiKey: 'k', maxRetries: 0, fetch: jevFetch(firstChoice, [], { status: 422 }) }) });
  const r2 = await err.decide(ctx());
  assert.strictEqual(r2.parseOk, false);
  assert.match(r2.error, /422/);
});

test('JevClient: 429 は retry-after に従って待ち、再試行する', async () => {
  let n = 0;
  const waits = [];
  const fetch = async () => {
    n += 1;
    if (n === 1) return { ok: false, status: 429, headers: new Map([['retry-after', '2']]), text: async () => 'slow down' };
    return { ok: true, status: 200, headers: new Map(), json: async () => ({ model: 'jev-1.14.0', answers: { x: { type: 'noul', noul: 0.5 } }, usage: { input_tokens: 300, output_tokens: 5 } }) };
  };
  const c = new JevClient({ apiKey: 'k', fetch, sleep: async (ms) => { waits.push(ms); } });
  const r = await c.ask('s', { x: { type: 'noul', instructions: 'q?' } });
  assert.ok(r.ok);
  assert.strictEqual(r.rateLimited, 1);
  assert.strictEqual(r.retries, 1);
  assert.deepStrictEqual(waits, [2000]);
});

test('API キーは環境変数か typesafe.env の1行から読む (値はエラーの文に入らない)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-'));
  const f = path.join(dir, 'typesafe.env');
  fs.writeFileSync(f, '# comment\nTYPESAFE_API_KEY=abc123secret\n');
  assert.strictEqual(loadApiKey({ env: {}, file: f }), 'abc123secret');
  assert.strictEqual(loadApiKey({ env: { TYPESAFE_API_KEY: 'fromenv' }, file: f }), 'fromenv');
  assert.strictEqual(loadApiKey({ env: {}, file: path.join(dir, 'none') }), null);
  const c = new JevClient({ apiKey: 'abc123secret', maxRetries: 0, fetch: async () => ({ ok: false, status: 401, headers: new Map(), text: async () => 'unauthorized' }) });
  const r = await c.ask('s', { x: { type: 'noul' } });
  assert.ok(!r.ok);
  assert.ok(!r.error.includes('abc123secret'));
});

// help.askHint: false なら「聞くのはよい選択」の一文を Jev の instructions に入れない
test('askHint false removes the ask nudge from next_action instructions', async () => {
  const { buildQuestions } = require('../src/deciders/jev.js');
  const base = { raw: { entities: [], heard: [] } };
  const on = buildQuestions({ ...base }, { criteria: {} }).questions.next_action.instructions;
  const off = buildQuestions({ ...base, askHint: false }, { criteria: {} }).questions.next_action.instructions;
  assert.match(on, /asking a nearby player/);
  assert.doesNotMatch(off, /asking a nearby player/);
});
