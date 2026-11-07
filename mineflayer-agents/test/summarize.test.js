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

test('event 付きの行 (answer_use など、loop と action を持つ) と result の無い行で落ちない。死亡・死因・2人組の距離・go_to(人)・1判断の呼び出し数', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-'));
  const t = (s) => `2026-11-03T01:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.000Z`;
  const step = (loop, s, pos, extra = {}) => ({ ts: t(s), loop, action: 'collect', arg: 'oak_log', pos, day: 0, result: { ok: true, msg: 'ok' }, decideMs: 300, parseOk: true, valid: true, inventory: [], foodCount: 0, jev: { inputTokens: 1000, inputChars: 2000, ms: 300, calls: 1 }, ...extra });
  fs.writeFileSync(path.join(dir, 'Taro-x.jsonl'), [
    L({ ts: t(0), event: 'start', persona: { name: 'Taro' }, decider: 'jev', day: 0 }),
    L(step(1, 1, { x: 0, y: 64, z: 0 })),
    L({ ts: t(2), event: 'answer_use', id: 'Taro-1', from: 'Hanako', key: 'collect:oak_log', used: true, how: 'followed', loop: 1, action: 'craft', arg: 'oak_planks' }),
    L({ ts: t(3), loop: 2, error: 'step error' }),
    L({ ts: t(3), loop: 2, action: 'look_around' }), // result の無い行
    L(step(3, 70, { x: 0, y: 64, z: 0 }, { action: 'go_to', arg: 'Hanako', jev: { inputTokens: 1300, inputChars: 2400, ms: 400, calls: 2 } })),
    L({ ts: t(71), event: 'death', loop: 3, day: 0, timeOfDay: 15000, cause: 'death.attack.mob', message: 'Taro was slain by Zombie' }),
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'Hanako-x.jsonl'), [
    L({ ts: t(0), event: 'start', persona: { name: 'Hanako' }, decider: 'jev', day: 0 }),
    L(step(1, 2, { x: 10, y: 64, z: 0 })),
    L(step(2, 72, { x: 30, y: 64, z: 0 })),
  ].join('\n'));
  const out = JSON.parse(execFileSync('node', [TOOL, dir], { encoding: 'utf8' }));
  assert.strictEqual(out.decisions.count, 4, 'event 行と result の無い行は判断に数えない');
  assert.strictEqual(out.survival.deaths, 1);
  assert.deepStrictEqual(out.survival.causes, { 'death.attack.mob': 1 });
  assert.strictEqual(out.ask.used, 1);
  assert.strictEqual(out.goToPerson.n, 1);
  assert.deepStrictEqual(out.goToPerson.byPair, { 'Taro→Hanako': 1 });
  assert.deepStrictEqual(out.pairDistance.timeline.map((x) => [x.withinNear, x.median]), [[1, 10], [0, 30]]);
  assert.strictEqual(out.pairDistance.perPair['Hanako-Taro'].withinNearShare, 0.5);
  assert.strictEqual(out.jev.decisions, 4);
  assert.strictEqual(out.jev.calls, 5);
  assert.strictEqual(out.jev.callsPerDecision, 1.25);
  const txt = execFileSync('node', [TOOL, dir, '--text'], { encoding: 'utf8' });
  assert.match(txt, /死んだ 1 回/);
  assert.match(txt, /go_to\(人\) 1 回/);
  assert.match(txt, /16m 以内の組の数/);
});

test('全体チャット・提案・取り決めと、近くの声/全体の回数・会話になったか', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-board-'));
  const t = (s) => `2026-11-05T01:00:${String(s).padStart(2, '0')}.000Z`;
  const step = (loop, s, pos, extra = {}) => ({ ts: t(s), loop, action: 'look_around', arg: '', result: { ok: true, msg: 'ok' }, decideMs: 300, parseOk: true, valid: true, inventory: [], foodCount: 0, pos, ...extra });
  fs.writeFileSync(path.join(dir, 'Hanako-x.jsonl'), [
    L({ ts: t(0), event: 'start', persona: { name: 'Hanako' }, decider: 'jev', day: 0 }),
    L(step(1, 1, { x: 0, y: 64, z: 0 })),
    L({ ts: t(2), event: 'talk', say: 'こんにちは' }),
    L({ ts: t(3), event: 'board', kind: 'broadcast', say: '北に羊がいるよ' }),
    L({ ts: t(4), event: 'board', kind: 'propose', ok: true, id: 'Hanako#3', n: 2, need: 1, spec: { type: 'text' }, text: '夜は集まろう' }),
    L({ ts: t(9), event: 'board', kind: 'agreed', id: 'Hanako#3', by: 'Hanako', text: '夜は集まろう', spec: { type: 'text' }, yes: ['Hanako', 'Taro'], need: 1 }),
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'Taro-x.jsonl'), [
    L({ ts: t(0), event: 'start', persona: { name: 'Taro' }, decider: 'jev', day: 0 }),
    L(step(1, 1, { x: 5, y: 64, z: 0 })),
    L({ ts: t(5), event: 'talk', say: 'やあ' }),
    L({ ts: t(6), event: 'board', kind: 'seen', from: 'Hanako', to: 'Taro', text: '北に羊がいるよ', why: 'relation' }),
    L({ ts: t(7), event: 'board', kind: 'vote', id: 'Hanako#3', by: 'Hanako', yes: true, p: 0.8, relation: '知り合い' }),
    L({ ts: t(9), event: 'board', kind: 'agreed', id: 'Hanako#3', by: 'Hanako', text: '夜は集まろう', spec: { type: 'text' }, yes: ['Hanako', 'Taro'], need: 1 }),
  ].join('\n'));
  const out = execFileSync('node', [TOOL, dir, '--text'], { encoding: 'utf8' });
  const j = JSON.parse(out.slice(0, out.indexOf('\n--- 週次報告用 ---')));
  assert.strictEqual(j.voices.near, 2);
  assert.strictEqual(j.voices.global, 2);
  assert.strictEqual(j.voices.globalShare, 0.5);
  assert.strictEqual(j.voices.nearReplied, 1, 'Hanako の「こんにちは」に近くの Taro が返した');
  assert.deepStrictEqual(j.voices.perAgent.Hanako, { near: 1, global: 2, nearWithListener: 1, nearReplied: 1, globalShare: 0.67 });
  assert.strictEqual(j.board.agreements.length, 1, '全員が記録した成立は1つにまとめる');
  assert.deepStrictEqual(j.board.seen.pairs, [['Hanako→Taro', 1]]);
  assert.match(out, /近くの声 2 回・全体チャット 2 回/);
  assert.match(out, /提案 Hanako#3「夜は集まろう」/);
});

test('動けない: 回復の回数と結果・入り直し・移動の打ち切り・押し戻し・path_reset を数える', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-'));
  const t = (s) => `2026-11-05T01:00:${String(s).padStart(2, '0')}.000Z`;
  const step = (loop, s, move, ok = false) => ({ ts: t(s), loop, action: 'explore', arg: 'north', result: { ok, msg: 'northへ進めなかった: 動けなかった (近づけなかった)', move }, decideMs: 300, parseOk: true, valid: true, inventory: [] });
  fs.writeFileSync(path.join(dir, 'Taro-x.jsonl'), [
    L({ ts: t(0), event: 'start', persona: { name: 'Taro' }, decider: 'jev', day: 0 }),
    L(step(1, 1, { gotos: 1, moved: 0.2, noProgress: 1, forced: 3, resets: { stuck: 1 }, returning: 0.5 })),
    L(step(2, 2, { gotos: 1, moved: 0.1, noProgress: 1, forced: 2, resets: { stuck: 2, block_updated: 1 } })),
    L({ ts: t(3), event: 'unstuck', loop: 2, action: 'explore', arg: 'north', ok: false, how: '入り直したら動けるようになった', returning: true, reconnect: { ok: true }, steps: [] }),
    L(step(3, 4, { gotos: 1, moved: 14 }, true)),
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'Mio-x.jsonl'), [
    L({ ts: t(0), event: 'start', persona: { name: 'Mio' }, decider: 'jev', day: 0 }),
    L({ ts: t(3), event: 'unstuck', loop: 5, action: 'go_to', arg: 'p1', ok: true, how: 'すぐ横のbambooを掘ったら動けた', returning: false, steps: [] }),
  ].join('\n'));
  const out = JSON.parse(execFileSync('node', [TOOL, dir], { encoding: 'utf8' }));
  const s = out.stuck;
  assert.strictEqual(s.stuck, 2);
  assert.strictEqual(s.recovered, 1);
  assert.strictEqual(s.notRecovered, 1);
  assert.deepStrictEqual([s.reconnects, s.reconnectOk, s.withReturningPos], [1, 1, 1]);
  assert.strictEqual(s.noProgress, 2);
  assert.strictEqual(s.forcedMoves, 5);
  assert.deepStrictEqual(s.resets, { stuck: 3, block_updated: 1 });
  assert.strictEqual(s.returningSeen, 1);
  const text = execFileSync('node', [TOOL, dir, '--text'], { encoding: 'utf8' });
  assert.match(text, /動けない 2 回 \(回復 1・回復できず 1、入り直し 1\/1/);
});
