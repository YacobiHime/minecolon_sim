'use strict';
// 模擬の LLM (fetch の差し替え) で decider と、観測→行動一覧→判断→解決の流れを確かめる
const test = require('node:test');
const assert = require('node:assert');
const { LLMDecider } = require('../src/deciders/llm');
const { createDecider } = require('../src/deciders');
const { buildContext, goalMet } = require('../src/agent');
const { resolveDecision } = require('../src/actions');
const { Memory } = require('../src/memory');
const { loadConfig } = require('../src/config');
const { mockRaw } = require('./fixtures');

function fakeFetch(replies, seen = []) {
  let i = 0;
  return async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    const content = replies[Math.min(i++, replies.length - 1)];
    return { ok: true, json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 500, completion_tokens: 20 } }) };
  };
}

function ctx() {
  const cfg = loadConfig(null, { persona: { name: 'Taro', personality: 'まじめ' }, goal: { text: '木のツルハシを作る' } });
  return buildContext(mockRaw(), new Memory(), cfg, { foods: new Set(['bread']) });
}

test('LLMDecider: 行動一覧と制約 (json_schema の enum) を送り、結果を解析する', async () => {
  const seen = [];
  const d = new LLMDecider({ fetch: fakeFetch(['{"action":"collect","arg":"spruce_log","say":"木を切るぞ"}'], seen) });
  const c = ctx();
  const r = await d.decide(c);
  assert.strictEqual(r.action, 'collect');
  assert.strictEqual(r.say, '木を切るぞ');
  assert.strictEqual(r.promptTokens, 500);
  assert.ok(r.promptChars > 100);
  const body = seen[0].body;
  assert.strictEqual(seen[0].url, 'http://127.0.0.1:18081/v1/chat/completions');
  const any = body.response_format.json_schema.schema.anyOf;
  assert.deepStrictEqual(any.map((x) => x.properties.action.enum[0]), c.actions.map((a) => a.name));
  const coll = any.find((x) => x.properties.action.enum[0] === 'collect');
  assert.deepStrictEqual(coll.properties.arg.enum, ['spruce_log', 'grass_block']);
  assert.match(body.messages[1].content, /## できる行動/);
  assert.match(body.messages[0].content, /木のツルハシを作る/);
  assert.ok(resolveDecision(c.actions, r.action, r.arg).ok);
});

test('constrainArgs=false なら action だけを縛る', async () => {
  const seen = [];
  const d = new LLMDecider({ fetch: fakeFetch(['{"action":"wait","arg":"1"}'], seen), constrainArgs: false });
  await d.decide(ctx());
  assert.ok(seen[0].body.response_format.json_schema.schema.properties.action.enum.includes('wait'));
});

test('LLMDecider: 壊れた出力 → retries で再試行、それでも駄目なら parseOk=false', async () => {
  const d1 = new LLMDecider({ fetch: fakeFetch(['うーん', '{"action":"wait","arg":"2"}']), retries: 1 });
  const r1 = await d1.decide(ctx());
  assert.ok(r1.parseOk);
  assert.strictEqual(r1.attempts, 2);
  const d2 = new LLMDecider({ fetch: fakeFetch(['うーん']), retries: 0 });
  const r2 = await d2.decide(ctx());
  assert.strictEqual(r2.parseOk, false);
  assert.strictEqual(r2.rawOutput, 'うーん');
});

test('LLMDecider: HTTP エラーは例外にせず結果に入れる', async () => {
  const d = new LLMDecider({ fetch: async () => { throw new Error('ECONNREFUSED'); } });
  const r = await d.decide(ctx());
  assert.strictEqual(r.parseOk, false);
  assert.match(r.error, /ECONNREFUSED/);
});

test('allowSay=false なら say を捨てる / split は行動と会話を別々に呼ぶ', async () => {
  const d = new LLMDecider({ fetch: fakeFetch(['{"action":"wait","arg":"1","say":"やあ"}']), allowSay: false });
  assert.strictEqual((await d.decide(ctx())).say, '');
  const seen = [];
  const sd = createDecider({ type: 'split', talkEvery: 1, llm: { fetch: fakeFetch(['{"action":"look_around","arg":"","say":""}', '{"say":"こんにちは"}'], seen) } });
  const r = await sd.decide(ctx());
  assert.strictEqual(r.action, 'look_around');
  assert.strictEqual(r.say, 'こんにちは');
  assert.strictEqual(seen.length, 2);
});

test('random / scripted decider は一覧の中から選ぶ', async () => {
  const c = ctx();
  const rd = createDecider({ type: 'random' });
  for (let i = 0; i < 20; i++) {
    const r = await rd.decide(c);
    assert.ok(resolveDecision(c.actions, r.action, r.arg).ok, JSON.stringify(r));
  }
  const sc = createDecider({ type: 'scripted', script: ['```{"action":"explore","arg":"north"}```'] });
  assert.strictEqual((await sc.decide(c)).arg, 'north');
});

test('goalMet', () => {
  const g = { success: { inventory: { wooden_pickaxe: 1 } } };
  assert.ok(!goalMet(g, [{ name: 'stick', count: 2 }]));
  assert.ok(goalMet(g, [{ name: 'wooden_pickaxe', count: 1 }]));
  assert.ok(!goalMet({}, [{ name: 'wooden_pickaxe', count: 1 }]));
});
