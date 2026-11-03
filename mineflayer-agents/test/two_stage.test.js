'use strict';
// Jev の選択肢: 行動の説明は state.actions に1回だけ、対象の多い行動は2段 (1回目は分類、2回目で対象)
const test = require('node:test');
const assert = require('node:assert');
const { JevDecider, actionOptions } = require('../src/deciders/jev');
const { JevClient } = require('../src/jev_client');
const { UsageMeter } = require('../src/usage');
const { buildContext } = require('../src/agent');
const { Memory } = require('../src/memory');
const { loadConfig } = require('../src/config');
const { resolveDecision } = require('../src/actions');
const { mockRaw } = require('./fixtures');

function ctx(over = {}, cfgOver = {}, extra = {}) {
  const cfg = loadConfig(null, { persona: { name: 'Taro' }, goal: { text: '小屋を作る', hints: ['原木1個から板材4個'] }, help: { askOthers: true, excludeFailures: false, noChange: true }, ...cfgOver });
  return buildContext(mockRaw(over), new Memory({ limits: { promptItems: 20 } }), cfg, { foods: new Set(['bread']), socialText: '落ち着いている', lastResult: 'collect(spruce_log)→成功', ...extra });
}

// answer(body, n) → answers。送った body を seen に残す
function fetchWith(answer, seen) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body);
    return { ok: true, status: 200, headers: new Map(), json: async () => ({ model: 'jev-1.14.0', answers: answer(body, seen.length), usage: { input_tokens: seen.length === 1 ? 1000 : 200, output_tokens: 5 } }) };
  };
}

test('actionOptions: 選択肢の文に行動の説明を繰り返さず、説明は表に1回だけ。twoStage では対象の多い行動を分類1つに', () => {
  const c = ctx();
  const one = actionOptions(c.actions);
  const explore = c.actions.find((a) => a.name === 'explore');
  assert.ok(explore.choices.length > 3);
  assert.strictEqual(one.criteria['explore:north'], 'explore: north');
  assert.ok(!Object.values(one.criteria).some((v) => v.includes(explore.desc)));
  assert.strictEqual(one.table.explore, explore.desc);
  assert.ok(!('say' in one.table));
  const two = actionOptions(c.actions, { twoStage: { maxDirect: 3 } });
  assert.ok(two.criteria['explore:*'], '4方向 > 3 は分類');
  assert.match(two.criteria['explore:*'], /4個から選ぶ \(north, south, east, west\)/);
  assert.ok(!two.criteria['explore:north']);
  assert.ok(two.criteria['collect:spruce_log'], '対象1個はそのまま');
  assert.deepStrictEqual(two.map['explore:*'], { group: 'explore' });
  for (const [k, v] of Object.entries(two.map)) if (!v.group) assert.ok(resolveDecision(c.actions, v.action, v.arg).ok, k);
  // direct の行動は数に関係なくそのまま
  const d = actionOptions(c.actions, { twoStage: { maxDirect: 3, direct: ['explore'] } });
  assert.ok(d.criteria['explore:north']);
});

test('JevDecider (2段): 分類が選ばれたら、最小限の state で2回目を呼んで対象を選ぶ。使用量は1判断2回', async () => {
  const seen = [];
  const meter = new UsageMeter();
  const answer = (body, n) => (n === 1
    ? { next_action: { type: 'choice', choice: 'explore:*', confidence: 0.6 }, remember: { type: 'score', score: 1 }, talk: { type: 'noul', noul: 0.1 }, rel_0: { type: 'score', score: 2 } }
    : { target: { type: 'choice', choice: 'east', confidence: 0.7 } });
  const d = new JevDecider({ client: new JevClient({ apiKey: 'k', fetch: fetchWith(answer, seen) }), meter, twoStage: { maxDirect: 3 } });
  const r = await d.decide(ctx());
  assert.strictEqual(seen.length, 2);
  const [b1, b2] = seen;
  assert.ok(b1.state.actions.explore, '1回目の state に行動の説明表');
  assert.ok(b1.questions.remember && b1.questions.talk && b1.questions.rel_0);
  assert.deepStrictEqual(Object.keys(b2.questions), ['target'], 'remember/talk/rel は1回目だけ');
  assert.deepStrictEqual(Object.keys(b2.questions.target.criteria), ['north', 'south', 'east', 'west']);
  for (const k of ['memory', 'feelings', 'now', 'heard_now', 'personality']) assert.ok(!(k in b2.state), `2回目に ${k} を送らない`);
  assert.match(b2.state.action, /^explore: /);
  assert.match(b2.state.inventory, /spruce_logx2/);
  assert.strictEqual(r.action, 'explore');
  assert.strictEqual(r.arg, 'east');
  assert.ok(r.parseOk);
  assert.strictEqual(r.jev.calls, 2);
  assert.strictEqual(r.jev.inputTokens, 1200);
  assert.strictEqual(r.jev.stage1.inputTokens, 1000);
  assert.strictEqual(r.jev.stage2.inputTokens, 200);
  assert.strictEqual(r.jev.stage2.choice.choice, 'east');
  assert.strictEqual(r.promptTokens, 1200);
  const u = meter.summary().jev;
  assert.strictEqual(u.calls, 2);
  assert.strictEqual(u.decisions, 1);
  assert.strictEqual(u.callsPerDecision, 2);
  assert.strictEqual(u.inputTokensPerDecision, 1200);
  assert.strictEqual(u.byStage[1].calls, 1);
  assert.strictEqual(u.byStage[2].inputTokens, 200);
});

test('JevDecider (2段): そのまま並べた選択肢が選ばれたら1回だけ。2回目の失敗・一覧にない答えは分類の先頭に', async () => {
  const seen = [];
  const meter = new UsageMeter();
  const d = new JevDecider({ client: new JevClient({ apiKey: 'k', fetch: fetchWith(() => ({ next_action: { type: 'choice', choice: 'collect:spruce_log' } }), seen) }), meter });
  const r = await d.decide(ctx());
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(`${r.action}:${r.arg}`, 'collect:spruce_log');
  assert.strictEqual(r.jev.calls, 1);
  assert.strictEqual(meter.summary().jev.callsPerDecision, 1);
  const seen2 = [];
  const d2 = new JevDecider({ client: new JevClient({ apiKey: 'k', fetch: fetchWith((b, n) => (n === 1 ? { next_action: { type: 'choice', choice: 'explore:*' } } : { target: { type: 'choice', choice: 'moon' } }), seen2) }) });
  const r2 = await d2.decide(ctx());
  assert.strictEqual(`${r2.action}:${r2.arg}`, 'explore:north');
  assert.ok(r2.jev.stage2.fallback);
  assert.match(r2.jev.stage2.error, /moon/);
});

test('JevDecider (2段): 変わらなかった回数の重みは、2回目の対象にも掛かる。分類は中の一番少ない回数', async () => {
  const seen = [];
  const answer = (body, n) => {
    const q = n === 1 ? body.questions.next_action : body.questions.target;
    const keys = Object.keys(q.criteria);
    const top = n === 1 ? 'explore:*' : 'north';
    const probabilities = Object.fromEntries(keys.map((k) => [k, k === top ? 0.7 : 0.3 / (keys.length - 1)]));
    return n === 1 ? { next_action: { type: 'choice', choice: top, probabilities } } : { target: { type: 'choice', choice: top, probabilities } };
  };
  const d = new JevDecider({ client: new JevClient({ apiKey: 'k', fetch: fetchWith(answer, seen) }) });
  const c = ctx();
  c.noChange = { penalties: { 'explore:north': 3 }, weight: 0.5 };
  const r = await d.decide(c);
  assert.strictEqual(r.jev.reweight, undefined, '分類 explore:* には south などが残るので重みなし');
  assert.strictEqual(r.action, 'explore');
  assert.notStrictEqual(r.arg, 'north');
  assert.strictEqual(r.jev.stage2.reweight.from, 'north');
  assert.ok(r.jev.stage2.reweight.changed);
});

test('JevDecider: twoStage: false なら1段 (分類を作らない)', async () => {
  const seen = [];
  const d = new JevDecider({ client: new JevClient({ apiKey: 'k', fetch: fetchWith(() => ({ next_action: { type: 'choice', choice: 'explore:west' } }), seen) }), twoStage: false });
  const r = await d.decide(ctx());
  assert.strictEqual(seen.length, 1);
  assert.ok(seen[0].questions.next_action.criteria['explore:north']);
  assert.strictEqual(`${r.action}:${r.arg}`, 'explore:west');
});
