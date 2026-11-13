'use strict';
// test/run_shutdown.test.js の模擬の子プロセス (node run.js --child の代わり。ボット・サーバー・API は使わない)。
// 引数: <runDir> <proc> <mode>
//   done     : すぐ run-part を書いて終わる (子が先に終わった場面)
//   wait     : 止める合図 (親の stop・親がいなくなった・SIGINT) まで動き、合図のあと少し待って run-part を書いて終わる
//   crash    : 止める合図で run-part を書かずに exit(1)
//   stubborn : 止める合図を無視。2回目の SIGINT (run.js と同じ) で aborted の run-part を書いて終わる
//   hang     : 何も聞かない (SIGKILL でしか止まらない)
// 使用量は 10ms ごとに親へ送る (childIpc)。各自の記録 <名前>-<stamp>.jsonl も書く。
const fs = require('fs');
const path = require('path');
const { childIpc } = require('../src/supervise');

const [runDir, procStr, mode] = process.argv.slice(2);
const proc = Number(procStr);
const stamp = path.basename(runDir);
const name = `P${proc}`;
const rec = path.join(runDir, `${name}-${stamp}.jsonl`);
const t = new Date().toISOString();
fs.appendFileSync(rec, `${JSON.stringify({ ts: t, event: 'start', name })}\n${JSON.stringify({ ts: t, loop: 1, jev: { calls: 1, inputTokens: 100, costUsd: 0.001 } })}\n`);
const log = (m) => fs.appendFileSync(path.join(runDir, `child${proc}.log`), `${m}\n`);
process.on('uncaughtException', (e) => { log(`uncaught ${e.code || ''} ${e.message}`); process.exit(9); });

let written = false;
const writePart = (extra = {}) => {
  if (written) return;
  written = true;
  const part = { runId: stamp, agents: 4, connected: 1, proc, decider: 'random', minutes: 0.01, results: [{ name, loops: 1, goalAt: null, recordFile: rec }],
    disconnects: { n: proc === 2 ? 1 : 0, reasons: [] }, usage: { jev: { calls: 1, inputTokens: 100, costUsd: 0.001 }, twoB: { calls: 0 } }, ...extra };
  fs.writeFileSync(path.join(runDir, `run-part${proc}.json`), JSON.stringify(part));
};
let stopping = false;
const finish = (why) => { log(`stop ${why}`); setTimeout(() => { writePart({ stoppedBy: why }); ipc.stop(); ipc.send(); setTimeout(() => process.exit(0), 50); }, 150); };
const onStop = (why, force) => {
  if (force && mode === 'stubborn') { log('force'); writePart({ aborted: 'force' }); setTimeout(() => process.exit(130), 50); return; }
  if (mode === 'stubborn' || mode === 'hang') { stopping = true; log(`ignore ${why}`); return; }
  if (stopping) return;
  stopping = true;
  if (mode === 'crash') { log('crash'); process.exit(1); }
  finish(why);
};
const ipc = childIpc({ proc, intervalMs: 10, getUsage: () => ({ jevInputTokens: 100, llmUsd: 0.01 }), onStop, log });
process.on('SIGINT', () => {
  if (mode === 'hang') return;
  if (stopping && mode === 'stubborn') { log('force'); writePart({ aborted: 'SIGINT' }); setTimeout(() => process.exit(130), 50); return; }
  onStop('SIGINT');
});
process.on('SIGTERM', () => { if (mode !== 'hang') onStop('SIGTERM'); });
if (mode === 'done') { writePart({ stoppedBy: 'time' }); ipc.stop(); setTimeout(() => process.exit(0), 20); }
setInterval(() => {}, 1000); // 動き続ける
