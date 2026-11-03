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
