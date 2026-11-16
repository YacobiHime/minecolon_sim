#!/usr/bin/env node
'use strict';
// 動いている実験が自然に終わりかけているかを見る (tools/exp_stop.sh が SIGINT を送る前に使う)。
//   終わりかけ = 子プロセスが run-part を書き始めた か、いちばん早い人の開始 (記録の start) から --minutes 分 (- margin 秒) を過ぎた
// 出力 (1行の JSON): { finishing, reason, parts, startedAt, plannedEndAt, secsLeft }
// 例: node tools/run_progress.js runs/<時刻> [--minutes 30] [--margin-sec 30]
//     分は --minutes か exp_start.json の args.minutes。分からなければ run-part だけで決める。
const fs = require('fs');
const path = require('path');

// 記録の1行目の ts (先頭 4KB だけ読む。1行目は {"ts":"...","event":"start",...})
function firstTs(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const m = buf.slice(0, n).toString('utf8').match(/^\{"ts":"([^"]+)","event":"start"/);
    return m ? Date.parse(m[1]) : null;
  } catch (_) { return null; } finally { if (fd != null) try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
}

function progress(dir, { minutes = null, marginSec = 30, now = Date.now() } = {}) {
  const files = fs.readdirSync(dir);
  const parts = files.filter((f) => /^run-part\d+\.json$/.test(f)).length;
  let mins = minutes != null ? Number(minutes) : null;
  if (mins == null) { try { mins = Number(JSON.parse(fs.readFileSync(path.join(dir, 'exp_start.json'), 'utf8')).args.minutes) || null; } catch (_) { /* なし */ } }
  const suffix = `-${path.basename(dir)}.jsonl`;
  const starts = files.filter((f) => f.endsWith(suffix)).map((f) => firstTs(path.join(dir, f))).filter(Number.isFinite);
  const startedAt = starts.length ? Math.min(...starts) : null;
  const plannedEndAt = startedAt != null && mins ? startedAt + mins * 60000 : null;
  const secsLeft = plannedEndAt != null ? Math.round((plannedEndAt - now) / 1000) : null;
  let finishing = false; let reason = null;
  if (parts > 0) { finishing = true; reason = `子が終わり始めている (run-part ${parts} 個)`; }
  else if (secsLeft != null && secsLeft <= marginSec) { finishing = true; reason = secsLeft <= 0 ? `予定の時間を ${-secsLeft} 秒過ぎた` : `予定の終わりまで ${secsLeft} 秒`; }
  return { finishing, reason, parts, startedAt: startedAt != null ? new Date(startedAt).toISOString() : null, plannedEndAt: plannedEndAt != null ? new Date(plannedEndAt).toISOString() : null, secsLeft };
}

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node tools/run_progress.js <run-dir> [--minutes N] [--margin-sec 30]'); process.exit(2); }
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  try {
    console.log(JSON.stringify(progress(dir, { minutes: arg('--minutes'), marginSec: Number(arg('--margin-sec') ?? 30) })));
  } catch (e) { console.error(`ERROR: ${e.message}`); process.exit(1); }
}

module.exports = { progress, firstTs };
