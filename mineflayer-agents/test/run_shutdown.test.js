'use strict';
// 終わり際の停止 (2026-11-13 の 100人試験で、終わった子への send で親が落ち、親のいない子も落ちて run.json ができなかった)。
// 模擬の子 (test/mock_child.js を fork) で、子が先に終わった後の SIGINT・親が落ちた後の子・run-part の欠け・2回目の SIGINT を試す。
// サーバー・ボット・API には触らない。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork, spawn } = require('child_process');
const { superviseChildren, safeSend } = require('../src/supervise');
const { buildRunSummary, recoverFromRecord } = require('../src/run_parts');
const { merge } = require('../tools/merge_run_parts');
const { progress } = require('../tools/run_progress');

const MOCK = path.join(__dirname, 'mock_child.js');
const STAMP = '2099-01-01T00-00-00';

function tmpRun() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'run-shutdown-'));
  const dir = path.join(base, STAMP);
  fs.mkdirSync(dir);
  return { dir, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('時間切れ'); await sleep(20); }
}
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const childLog = (dir, k) => { try { return fs.readFileSync(path.join(dir, `child${k}.log`), 'utf8'); } catch (_) { return ''; } };

function start(dir, modes, opts = {}) {
  const children = modes.map((m, k) => fork(MOCK, [dir, String(k + 1), m], { stdio: 'ignore' }));
  const usage = modes.map(() => 0);
  const logs = [];
  const sup = superviseChildren(children, { runDir: dir, procs: modes.length, agents: 4, meta: { runId: STAMP, decider: 'random' }, signals: false,
    log: (m) => logs.push(m), onMessage: (k, m) => { if (m && m.type === 'usage') usage[k] += 1; }, ...opts });
  return { children, sup, usage, logs };
}

test('仕組みの確認: 終わった子に素の send をすると非同期の error が出る (これが未処理で親が落ちた)。safeSend は何も起こさない', async () => {
  const { dir, cleanup } = tmpRun();
  try {
    const c = fork(MOCK, [dir, '1', 'done'], { stdio: 'ignore' });
    await new Promise((r) => c.on('exit', r));
    assert.strictEqual(c.connected, false);
    const errs = [];
    c.on('error', (e) => errs.push(e.code));
    assert.strictEqual(safeSend(c, { type: 'stop' }), false);
    await sleep(50);
    assert.deepStrictEqual(errs, []);
    try { c.send({ type: 'stop' }); } catch (_) { /* 同期に投げることもある */ }
    await sleep(50);
    assert.deepStrictEqual(errs, ['ERR_IPC_CHANNEL_CLOSED']);
  } finally { cleanup(); }
});

test('子が先に終わった後の SIGINT: 親は落ちず、残りの子を待って run.json を作る', async () => {
  const { dir, cleanup } = tmpRun();
  try {
    const { sup, usage, logs } = start(dir, ['done', 'wait', 'wait']);
    await until(() => sup.exits[0] && usage[1] > 2 && usage[2] > 2);
    sup.stop('SIGINT'); // 子1 はもう終わっている
    const s = await sup.done;
    assert.ok(fs.existsSync(path.join(dir, 'run.json')));
    const run = readJson(path.join(dir, 'run.json'));
    assert.strictEqual(run.partial, false);
    assert.deepStrictEqual(run.results.map((r) => r.name).sort(), ['P1', 'P2', 'P3']);
    assert.deepStrictEqual(run.parts.found, [1, 2, 3]);
    assert.strictEqual(run.disconnects, 1);
    assert.strictEqual(s.exits.length, 3);
    for (const k of [2, 3]) assert.match(childLog(dir, k), /stop 親から/);
    for (const k of [1, 2, 3]) assert.doesNotMatch(childLog(dir, k), /uncaught/);
    assert.match(logs.join('\n'), /子 2 個の終わりを待つ/);
  } finally { cleanup(); }
});

test('process の SIGINT を受けても同じ (signals: true)', async () => {
  const { dir, cleanup } = tmpRun();
  try {
    const { sup, usage } = start(dir, ['done', 'wait'], { signals: true });
    await until(() => sup.exits[0] && usage[1] > 1);
    process.emit('SIGINT', 'SIGINT');
    const run = await sup.done;
    assert.strictEqual(run.partial, false);
    assert.strictEqual(process.listenerCount('SIGINT'), 0, '終わったら外す');
  } finally { cleanup(); }
});

test('run-part の欠け: 書けずに落ちた子は missingParts に残り、その人は記録から拾う', async () => {
  const { dir, cleanup } = tmpRun();
  try {
    fs.writeFileSync(path.join(dir, 'monitor-2.jsonl'), `${JSON.stringify({ bots: { disconnects: 0 } })}\n${JSON.stringify({ bots: { disconnects: 3 } })}\n`);
    const { sup, usage } = start(dir, ['wait', 'crash'], { namesByProc: [['P1'], ['P2']] });
    await until(() => usage[0] > 1 && usage[1] > 1);
    sup.stop('SIGTERM');
    const run = await sup.done;
    assert.strictEqual(run.partial, true);
    assert.strictEqual(run.missingParts.length, 1);
    const m = run.missingParts[0];
    assert.strictEqual(m.proc, 2);
    assert.deepStrictEqual(m.agentRange, [2, 4]);
    assert.deepStrictEqual(m.names, ['P2']);
    assert.strictEqual(m.exit.code, 1);
    assert.strictEqual(m.disconnectsFromMonitor, 3);
    assert.strictEqual(run.disconnects, 3);
    const p2 = run.results.find((r) => r.name === 'P2');
    assert.ok(p2.fromRecord); assert.strictEqual(p2.proc, 2); assert.strictEqual(p2.loops, 1); assert.strictEqual(p2.ended, false);
    assert.strictEqual(run.usage.missingEstimate.jev.inputTokens, 100);
    assert.strictEqual(run.usage.jev.inputTokens, 100, '使用量は残った子だけ');
  } finally { cleanup(); }
});

test('2回目の stop: 止まらない子に SIGINT → aborted の run-part。それでも残る子は SIGKILL して欠けとして残す', async () => {
  const { dir, cleanup } = tmpRun();
  try {
    const { sup, usage } = start(dir, ['stubborn', 'hang'], { killAfterMs: 300 });
    await until(() => usage[0] > 1 && usage[1] > 1);
    sup.stop('SIGINT');
    await sleep(200);
    assert.ok(!sup.exits[0] && !sup.exits[1], '1回目では止まらない子');
    sup.stop('SIGINT');
    const run = await sup.done;
    assert.strictEqual(readJson(path.join(dir, 'run-part1.json')).aborted, 'force');
    assert.deepStrictEqual(run.missingParts.map((x) => x.proc), [2]);
    assert.strictEqual(run.missingParts[0].exit.signal, 'SIGKILL');
  } finally { cleanup(); }
});

test('親が落ちた後の子: 落ちずに止まり、自分の run-part を書いて終わる', async () => {
  const { dir, cleanup } = tmpRun();
  try {
    // 親: 子を fork し、子の使用量を受けたら突然終わる (子への後片付けなし)
    const parent = `const { fork } = require('child_process');
      const c = fork(${JSON.stringify(MOCK)}, [${JSON.stringify(dir)}, '1', 'wait'], { stdio: 'ignore' });
      c.on('message', () => process.exit(0));`;
    const p = spawn(process.execPath, ['-e', parent], { stdio: 'ignore' });
    await new Promise((r) => p.on('exit', r));
    await until(() => fs.existsSync(path.join(dir, 'run-part1.json')));
    await sleep(200);
    const log = childLog(dir, 1);
    assert.match(log, /stop 親がいなくなった/);
    assert.doesNotMatch(log, /uncaught/);
    assert.strictEqual(readJson(path.join(dir, 'run-part1.json')).stoppedBy, '親がいなくなった');
    // 残った run-part から run.json を作れる
    const r = merge(dir, { procs: 1, agents: 4 });
    assert.strictEqual(r.summary.partial, false);
    assert.ok(fs.existsSync(path.join(dir, 'run.json')));
  } finally { cleanup(); }
});

test('merge_run_parts: run.json があれば作り直さない (--force で作り直す)・exp_start.json から子の数を読む', () => {
  const { dir, cleanup } = tmpRun();
  try {
    fs.writeFileSync(path.join(dir, 'exp_start.json'), JSON.stringify({ args: { agents: 4, procs: 2, minutes: 1 } }));
    fs.writeFileSync(path.join(dir, 'run-part1.json'), JSON.stringify({ runId: STAMP, agents: 4, proc: 1, connected: 2, minutes: 1.2, results: [{ name: 'A' }, { name: 'B' }], disconnects: { n: 0 }, usage: { jev: { calls: 2, inputTokens: 10 } } }));
    const t = '2099-01-01T00:00:00.000Z';
    fs.writeFileSync(path.join(dir, `C-${STAMP}.jsonl`), [{ ts: t, event: 'start' }, { ts: t, loop: 1, jev: { inputTokens: 7, costUsd: 0.5 } }, { ts: t, event: 'goal', loop: 2 }, { ts: t, loop: 2 }, { ts: t, event: 'end', loops: 2, goalAt: 2 }].map((x) => JSON.stringify(x)).join('\n') + '\n{"ts":"切れ');
    const r = merge(dir, {});
    assert.strictEqual(r.summary.procs, 2);
    assert.strictEqual(r.summary.minutes, 1.2);
    assert.deepStrictEqual(r.summary.missingParts.map((m) => [m.proc, m.agentRange]), [[2, [2, 4]]]);
    const c = r.summary.results.find((x) => x.name === 'C');
    assert.deepStrictEqual([c.loops, c.goalAt, c.ended, c.fromRecord], [2, 2, true, true]);
    assert.strictEqual(r.summary.usage.missingEstimate.jev.costUsd, 0.5);
    assert.ok(r.summary.rebuilt);
    assert.strictEqual(merge(dir, {}).skipped, true);
    assert.strictEqual(merge(dir, { force: true }).skipped, false);
  } finally { cleanup(); }
});

test('recoverFromRecord: 読めない記録でも落ちない', () => {
  const r = recoverFromRecord('/nonexistent/x.jsonl', 'X');
  assert.strictEqual(r.unreadable, true);
  assert.strictEqual(r.loops, 0);
});

test('buildRunSummary: run-part がすべて揃えば partial ではない', () => {
  const { dir, cleanup } = tmpRun();
  try {
    for (const k of [1, 2]) fs.writeFileSync(path.join(dir, `run-part${k}.json`), JSON.stringify({ agents: 2, proc: k, connected: 1, minutes: 3, results: [{ name: `N${k}` }], disconnects: { n: 1, reasons: [{ name: `N${k}` }] }, usage: {} }));
    const s = buildRunSummary(dir, { procs: 2 });
    assert.strictEqual(s.partial, false);
    assert.strictEqual(s.disconnects, 2);
    assert.strictEqual(s.disconnectReasons.length, 2);
    assert.strictEqual(s.connected, 2);
    assert.deepStrictEqual(s.results.map((r) => r.proc), [1, 2]);
  } finally { cleanup(); }
});

test('run_progress: 子が run-part を書き始めた・予定の時間を過ぎた なら終わりかけ', () => {
  const { dir, cleanup } = tmpRun();
  try {
    const now = Date.parse('2099-01-01T00:40:00Z');
    fs.writeFileSync(path.join(dir, 'exp_start.json'), JSON.stringify({ args: { minutes: 30 } }));
    fs.writeFileSync(path.join(dir, `A-${STAMP}.jsonl`), `${JSON.stringify({ ts: '2099-01-01T00:05:00.000Z', event: 'start' })}\n`);
    fs.writeFileSync(path.join(dir, `B-${STAMP}.jsonl`), `${JSON.stringify({ ts: '2099-01-01T00:06:00.000Z', event: 'start' })}\n`);
    let p = progress(dir, { now: Date.parse('2099-01-01T00:20:00Z') });
    assert.strictEqual(p.finishing, false);
    assert.strictEqual(p.secsLeft, 900);
    p = progress(dir, { now: Date.parse('2099-01-01T00:34:40Z') });
    assert.strictEqual(p.finishing, true); assert.match(p.reason, /予定の終わりまで 20 秒/);
    p = progress(dir, { now });
    assert.match(p.reason, /過ぎた/);
    fs.writeFileSync(path.join(dir, 'run-part1.json'), '{}');
    p = progress(dir, { now: Date.parse('2099-01-01T00:10:00Z') });
    assert.strictEqual(p.finishing, true); assert.match(p.reason, /run-part 1 個/);
  } finally { cleanup(); }
});
