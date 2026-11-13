'use strict';
// 親プロセスが子プロセス (node run.js --child) を見張る部分 (run.js の runParent が使う)。
//   - 子へ送るのは、つながっている (c.connected) 子だけ。送れなかった失敗はコールバックで受け、'error' イベントも拾う
//     (2026-11-13: 終わった子に send して ERR_IPC_CHANNEL_CLOSED が未処理になり、親が落ちて run.json ができなかった)
//   - 止め方: 1回目の SIGINT/SIGTERM (や stop()) = 子に stop を送り、終わるのを待つ。
//             2回目 = まだ動いている子に SIGINT (子はすぐ自分の run-part を書いて終わる)。killAfterMs 待っても残れば SIGKILL。
//             3回目 = 残っている子にすぐ SIGKILL。
//     どの止め方でも、子がすべて終わったら残っている run-part から run.json を作る (欠けた子は missingParts)。
const { writeRunSummary } = require('./run_parts');

function safeSend(c, msg) {
  if (!c || !c.connected) return false;
  try { c.send(msg, () => { /* 送れなかった (子が終わった) ら捨てる */ }); return true; } catch (_) { return false; }
}

// children: fork した子の配列。runDir・procs・agents・meta・namesByProc は run.json のため (src/run_parts.js)
// onMessage(k, m): 子 k (0 から) からのメッセージ。signals: process の SIGINT/SIGTERM を受けるか
function superviseChildren(children, { runDir, procs, agents, meta = {}, namesByProc = null, log = console.log, killAfterMs = 15000, signals = true, onMessage = null } = {}) {
  const exits = children.map(() => null);
  let level = 0;
  let killTimer = null;
  const alive = () => children.filter((c, k) => !exits[k]);
  const exited = children.map((c, k) => new Promise((resolve) => {
    c.on('error', (e) => log(`子 ${k + 1}: ${e && e.code ? e.code : ''} ${e && e.message}`));
    if (onMessage) c.on('message', (m) => { try { onMessage(k, m); } catch (e) { log(`子 ${k + 1} のメッセージ: ${e.message}`); } });
    c.on('exit', (code, signal) => { exits[k] = { code, signal, at: new Date().toISOString() }; resolve(); });
  }));
  const kill = (sig) => { for (const c of alive()) { try { c.kill(sig); } catch (_) { /* ignore */ } } };

  function stop(why) {
    level += 1;
    const left = alive().length;
    if (level === 1) {
      log(`stopping (${why})... 子 ${left} 個の終わりを待つ (もう一度 Ctrl-C で、子に記録を書かせてすぐ止める)`);
      for (const c of children) safeSend(c, { type: 'stop' });
    } else if (level === 2) {
      log(`stopping (${why}, 2回目): 残りの子 ${left} 個に SIGINT (run-part を書いてすぐ終わる)。${Math.round(killAfterMs / 1000)} 秒で残れば SIGKILL。もう一度 Ctrl-C ですぐ SIGKILL`);
      kill('SIGINT');
      killTimer = setTimeout(() => { if (alive().length) { log(`残りの子 ${alive().length} 個に SIGKILL`); kill('SIGKILL'); } }, killAfterMs);
      if (killTimer.unref) killTimer.unref();
    } else {
      log(`stopping (${why}, ${level}回目): 残りの子 ${left} 個に SIGKILL`);
      kill('SIGKILL');
    }
  }
  const onSig = (sig) => () => stop(sig);
  const handlers = signals ? { SIGINT: onSig('SIGINT'), SIGTERM: onSig('SIGTERM') } : {};
  for (const [sig, h] of Object.entries(handlers)) process.on(sig, h);

  const done = Promise.all(exited).then(() => {
    if (killTimer) clearTimeout(killTimer);
    for (const [sig, h] of Object.entries(handlers)) process.removeListener(sig, h);
    const summary = writeRunSummary(runDir, { procs, agents, meta, namesByProc, exits });
    if (summary.partial) log(`注意: run-part が欠けた子 ${summary.missingParts.map((m) => m.proc).join(',')} (run.json の missingParts。その人の results は記録から拾った)`);
    return summary;
  });
  return { stop, done, exits, send: (msg) => children.forEach((c) => safeSend(c, msg)) };
}

module.exports = { superviseChildren, safeSend };
