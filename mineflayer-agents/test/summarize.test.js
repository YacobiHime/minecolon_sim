'use strict';
// tools/summarize_run.js: 実行のフォルダ (全員分 + run.json) から週次報告用の数字と会話の抜粋を出す
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const TOOL = path.join(__dirname, '..', 'tools', 'summarize_run.js');
const L = (o) => JSON.stringify(o);

test('2人分の記録と run.json を集計する', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-'));
  const t = (s) => `2026-11-03T01:00:${String(s).padStart(2, '0')}.000Z`;
  const step = (loop, s, extra = {}) => ({ ts: t(s), loop, action: 'collect', arg: 'oak_log', result: { ok: true, msg: 'ok' }, decideMs: 300, parseOk: true, valid: true, inventory: [], foodCount: 0, jev: { inputTokens: 1000, inputChars: 2000, ms: 300 }, ...extra });
  fs.writeFileSync(path.join(dir, 'Taro-x.jsonl'), [
    L({ ts: t(0), event: 'start', persona: { name: 'Taro' }, decider: 'jev', help: { hints: true, steps: true, progress: true, askOthers: true, excludeFailures: false }, day: 0 }),
    L(step(1, 1)),
    L({ ts: t(2), event: 'ask', from: 'Taro', to: 'Hanako', key: 'craft:stick', question: 'Hanakoさん、教えて: stickの作り方が分からない' }),
    L({ ts: t(4), event: 'ask_reply', to: 'Hanako', answer: '板材2個で作れるよ', known: true }),
    L(step(2, 5, { hutTrue: { ratio: 0.4 } })),
    L({ ts: t(6), event: 'answer_use', from: 'Hanako', key: 'craft:stick', used: true, how: 'retried_ok' }),
    L({ ts: t(7), event: 'goal', loop: 2, timeOfDay: 5000, day: 0 }),
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'Hanako-x.jsonl'), [
    L({ ts: t(0), event: 'start', persona: { name: 'Hanako' }, decider: 'jev', day: 0 }),
    L(step(1, 1, { foodCount: 3, hutTrue: { ratio: 0.5 } })),
    L({ ts: t(3), event: 'answer', from: 'Hanako', to: 'Taro', question: 'q', answer: '板材2個で作れるよ', known: true, twoB: { promptChars: 300 } }),
    L({ ts: t(5), event: 'talk', say: 'がんばろう', talkP: 0.8, promptChars: 500 }),
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'run.json'), L({ usage: { jev: { calls: 3, inputTokens: 3000, estimatedCalls: 0, costUsd: 0.000126, avgMs: 300, rateLimited: 0, retries: 0 }, twoB: { calls: 2, promptChars: 800, byKind: { answer: { calls: 1 }, talk: { calls: 1 } } } } }));
  const out = JSON.parse(execFileSync('node', [TOOL, dir], { encoding: 'utf8' }));
  assert.strictEqual(out.agents, 2);
  assert.strictEqual(out.decisions.count, 3);
  assert.strictEqual(out.goal.reached, 1);
  assert.strictEqual(out.goal.beforeNight, 1);
  assert.strictEqual(out.goal.hutRatioEnd, 0.5);
  assert.strictEqual(out.goal.foodTotalEnd, 3);
  assert.strictEqual(out.ask.asked, 1);
  assert.strictEqual(out.ask.answeredKnown, 1);
  assert.strictEqual(out.ask.used, 1);
  assert.strictEqual(out.twoB.calls, 2);
  assert.strictEqual(out.jev.inputTokens, 3000);
  assert.strictEqual(out.jev.inputTokensPerDecision, 1000);
  assert.strictEqual(out.help.askOthers, true);
  assert.deepStrictEqual(out.conversation.map((l) => l.replace(/^\[[^\]]+\] /, '')), [
    'Taro → Hanako [聞く] Hanakoさん、教えて: stickの作り方が分からない',
    'Hanako → Taro [答える] 板材2個で作れるよ',
    'Hanako: がんばろう  (talk 0.80)',
    'Taro [教わったことを使った(retried_ok)] Hanako から: craft:stick',
  ]);
  // run.json が無ければ記録から数え直す
  fs.unlinkSync(path.join(dir, 'run.json'));
  const out2 = JSON.parse(execFileSync('node', [TOOL, dir], { encoding: 'utf8' }));
  assert.strictEqual(out2.jev.inputTokens, 3000);
  assert.strictEqual(out2.twoB.calls, 2);
  const txt = execFileSync('node', [TOOL, dir, '--text'], { encoding: 'utf8' });
  assert.match(txt, /週次報告用/);
});

test('生き延びる設定: 死んだ回数・死因・各日の終わりの人数・3日生き延びた人数・目標の移り変わり・同じ所に居た組', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-'));
  const t = (s) => new Date(Date.UTC(2026, 10, 3, 1, 0, 0) + s * 1000).toISOString();
  const step = (loop, s, day, pos, extra = {}) => ({ ts: t(s), loop, day, timeOfDay: 1000, pos, action: 'explore', arg: 'north_far', result: { ok: true, msg: 'ok' }, decideMs: 300, parseOk: true, valid: true, inventory: [], foodCount: 0, jev: { inputTokens: 2500, inputChars: 4000, ms: 300 }, ...extra });
  // Taro: 3日目まで一度も死なない。Hanako: 2日目に死ぬ
  fs.writeFileSync(path.join(dir, 'Taro-x.jsonl'), [
    L({ ts: t(0), event: 'start', persona: { name: 'Taro' }, help: { selfGoal: true }, day: 0 }),
    L({ ts: t(1), event: 'self_goal', loop: 1, reason: 'start', ok: true, goal: '木を集める', steps: ['原木を集める', '道具を作る'] }),
    L(step(1, 1, 0, { x: 0, y: 64, z: 0 })),
    L(step(2, 12, 1, { x: 3, y: 64, z: 0 }, { action: 'attack', arg: 'zombie', result: { ok: true, msg: '倒した' } })),
    L({ ts: t(20), event: 'self_goal', loop: 3, reason: 'done', ok: true, goal: '肉を焼く', steps: ['かまどを作る', '焼く'] }),
    L(step(3, 22, 3, { x: 100, y: 64, z: 0 }, { action: 'place', arg: 'furnace', result: { ok: true, msg: '置いた' } })),
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'Hanako-x.jsonl'), [
    L({ ts: t(0), event: 'start', persona: { name: 'Hanako' }, help: { selfGoal: true }, day: 0 }),
    L(step(1, 2, 0, { x: 2, y: 64, z: 1 })),
    L(step(2, 11, 1, { x: 4, y: 64, z: 1 }, { action: 'sleep', arg: 'red_bed', result: { ok: true, msg: '寝た' } })),
    L({ ts: t(15), event: 'death', day: 1, timeOfDay: 15000, cause: 'death.attack.zombie', message: 'Hanako was slain by Zombie' }),
    L(step(3, 23, 3, { x: 4, y: 64, z: 1 })),
  ].join('\n'));
  const out = JSON.parse(execFileSync('node', [TOOL, dir], { encoding: 'utf8' }));
  assert.strictEqual(out.survival.deaths, 1);
  assert.deepStrictEqual(out.survival.causes, { 'death.attack.zombie': 1 });
  assert.deepStrictEqual(out.survival.aliveAtDayEnd, [{ day: 1, reached: 2, alive: 2 }, { day: 2, reached: 2, alive: 1 }, { day: 3, reached: 2, alive: 1 }]);
  assert.deepStrictEqual(out.survival.survivedNoDeath, ['Taro']);
  assert.strictEqual(out.selfGoals.count, 2);
  assert.deepStrictEqual(out.selfGoals.byReason, { start: 1, done: 1 });
  assert.match(out.selfGoals.timeline[1], /Taro #3 \(done\) 肉を焼く \/ かまどを作る → 焼く/);
  assert.deepStrictEqual(out.placed, { furnace: 1 });
  assert.ok(out.cooperation.togetherPairs['Hanako-Taro'] >= 2); // 1秒・2秒と11秒・12秒に近くに居た
  const txt = execFileSync('node', [TOOL, dir, '--text'], { encoding: 'utf8' });
  assert.match(txt, /死んだ 1 回 \(death\.attack\.zombie 1\)/);
  assert.match(txt, /3日生き延びた \(一度も死ななかった\) 1 人/);
  assert.match(txt, /攻撃 1 回/);
});
