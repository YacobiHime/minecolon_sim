#!/usr/bin/env bash
# 実験の停止と集計を1つのコマンドで (手順は /root/experiment_runbook.md の 3〜5 と同じ)。
#   ボットに SIGINT (自然に終わりかけていれば送らずに待つ) → 止まるのを待つ → run.json が無ければ run-part から作る
#   (tools/merge_run_parts.js) → check_scale_run・summarize_run・conflict_stats → 要点の表示
#   → (--stop-server なら) サーバーを止める
# 使い方: bash tools/exp_stop.sh --help
#
# テストのときだけ外のコマンドを差し替えられる (ふだんは設定しない):
#   EXP_PGREP     pgrep の代わり (pgrep -fa <パターン> と同じ出力を返すこと)
#   EXP_SEND_CMD  cmd_pipe に1行送る代わりのコマンド (引数に送る行)
#   EXP_RUNS_DIR  記録のフォルダの親 (既定 <コード>/runs)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
A="$(cd "$SCRIPT_DIR/.." && pwd)"
MC_DIR="${MC_DIR:-/root/mc-server-fabric}"
PGREP="${EXP_PGREP:-pgrep}"
RUNS_DIR="${EXP_RUNS_DIR:-$A/runs}"
PAT_BOT='node .*run[.]js'
PAT_SERVER='^[^ ]*java .*fabric-server-launc[h]'

RUN=""; STOP_SERVER=0; FORCE=0; TIMEOUT=180; NOW=0

usage() {
  cat <<'EOF'
使い方: bash tools/exp_stop.sh [オプション]
  動いている実験 (node run.js) を止め、記録を集計して要点を出す。もう終わっていれば集計だけ。

  --run DIR       記録のフォルダ (既定 runs/ のいちばん新しいフォルダ)
  --stop-server   サーバーも止める (既定は止めない。接続者がいれば止めない)
  --force         接続者がいてもサーバーを止める
  --timeout 秒    SIGINT のあと止まるのを待つ秒数 (既定 180。過ぎたら SIGTERM)。
                  自然に終わりかけている (予定の時間を過ぎた・子が終わり始めた) ときは SIGINT を送らずこの秒数まで待つ
  --now           終わりかけでも待たずに SIGINT を送る
  --help          この説明

出力 (記録のフォルダの中): check.txt・summary.txt・conflict.json・digest.txt
例:
  bash tools/exp_stop.sh                          # 止めて、いちばん新しい記録を集計
  bash tools/exp_stop.sh --stop-server            # サーバーも止める
  bash tools/exp_stop.sh --run runs/2026-11-11T03-43-35   # 終わった記録を集計し直す
環境変数: MC_DIR (サーバー。既定 /root/mc-server-fabric)
EOF
}

die() { echo "エラー: $*" >&2; exit 1; }
need_val() { [ $# -ge 2 ] && [ -n "$2" ] || die "$1 に値がない"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --run) need_val "$@"; RUN="$2"; shift 2;;
    --stop-server) STOP_SERVER=1; shift;;
    --force) FORCE=1; shift;;
    --now) NOW=1; shift;;
    --timeout) need_val "$@"; TIMEOUT="$2"; shift 2;;
    --help|-h) usage; exit 0;;
    *) usage >&2; die "知らない引数: $1";;
  esac
done
[[ "$TIMEOUT" =~ ^[0-9]+$ ]] || die "--timeout は秒数 (受け取った値: '$TIMEOUT')"

procs_of() { "$PGREP" -fa "$1" 2>/dev/null || true; }
pids_of() { procs_of "$1" | awk '{print $1}'; }
wait_gone() { # $1=秒。ボットがいなくなれば 0
  local i
  for ((i = 0; i < $1; i++)); do
    [ -n "$(procs_of "$PAT_BOT")" ] || return 0
    sleep 1
  done
  [ -z "$(procs_of "$PAT_BOT")" ]
}

# ---- 記録のフォルダ ----
if [ -z "$RUN" ]; then
  [ -d "$RUNS_DIR" ] || die "記録の場所が無い: $RUNS_DIR"
  NEWEST=$(ls -1t "$RUNS_DIR" 2>/dev/null | while read -r d; do [ -d "$RUNS_DIR/$d" ] && { echo "$d"; break; }; done || true)
  [ -n "$NEWEST" ] || die "$RUNS_DIR に記録のフォルダが無い"
  RUN="$RUNS_DIR/$NEWEST"
fi
[ -d "$RUN" ] || { [ -d "$A/$RUN" ] && RUN="$A/$RUN"; } || die "記録のフォルダが無い: $RUN"
RUN="$(cd "$RUN" && pwd)"
echo "記録のフォルダ: $RUN"

# ---- 1. ボットを止める ----
send_int_and_wait() {
  local PARENTS LEFT
  PARENTS=$(procs_of "$PAT_BOT" | grep -v -- ' --child ' | awk '{print $1}' || true)
  [ -n "$PARENTS" ] || PARENTS=$(pids_of "$PAT_BOT")
  echo "ボットに止める合図 (SIGINT) を送る: PID $(echo "$PARENTS" | tr '\n' ' ')"
  for p in $PARENTS; do kill -INT "$p" 2>/dev/null || true; done
  echo "止まるのを待つ (最長 ${TIMEOUT} 秒)..."
  if wait_gone "$TIMEOUT"; then
    echo "ボットは止まった"
  else
    LEFT=$(pids_of "$PAT_BOT")
    echo "${TIMEOUT} 秒で止まらなかったので SIGTERM を送る: PID $(echo "$LEFT" | tr '\n' ' ')"
    for p in $LEFT; do kill -TERM "$p" 2>/dev/null || true; done
    if wait_gone 20; then echo "ボットは止まった (SIGTERM)"
    else
      echo "注意: まだ残っているプロセスがある (手で確かめて kill すること。pkill -f は使わない):" >&2
      procs_of "$PAT_BOT" >&2
    fi
  fi
}
BOTS=$(procs_of "$PAT_BOT")
if [ -n "$BOTS" ]; then
  # 自然に終わりかけている (予定の時間を過ぎた・子が run-part を書き始めた) ときは SIGINT を送らず待つ
  # (2026-11-13: 終わりかけに SIGINT を送り、終わった子への送信で親が落ちて run.json ができなかった)
  PROG=""
  [ "$NOW" = 1 ] || PROG=$(node "$A/tools/run_progress.js" "$RUN" 2>/dev/null || true)
  if echo "$PROG" | grep -q '"finishing":true'; then
    WHY=$(echo "$PROG" | sed -nE 's/.*"reason":"([^"]*)".*/\1/p')
    echo "実験は自然に終わりかけている (${WHY})。SIGINT を送らず、終わるのを待つ (最長 ${TIMEOUT} 秒。すぐ止めるなら --now)"
    if wait_gone "$TIMEOUT"; then echo "ボットは自分で終わった"
    else echo "${TIMEOUT} 秒で終わらなかった"; send_int_and_wait; fi
  else
    send_int_and_wait
  fi
else
  echo "ボットはもう止まっている。集計へ"
fi
if [ ! -f "$RUN/run.json" ]; then
  echo "注意: $RUN/run.json が無い (run.js が最後まで書けなかった)。残っている run-part から作り直す" >&2
  node "$A/tools/merge_run_parts.js" "$RUN" || echo "注意: run.json を作り直せなかった" >&2
fi

# ---- 2. 集計 ----
AGENTS=$(node -e '
const fs = require("fs"); const d = process.argv[1];
const r = (f) => { try { return JSON.parse(fs.readFileSync(d + "/" + f, "utf8")); } catch (_) { return null; } };
const e = r("exp_start.json"), j = r("run.json");
console.log((e && e.args && e.args.agents) || (j && j.agents) || 100);
' "$RUN")
FAILED=()
echo
echo "== 集計 (人数 $AGENTS) =="
cd "$A"
echo "+ node tools/check_scale_run.js $RUN --agents $AGENTS ..."
set +e
node tools/check_scale_run.js "$RUN" --agents "$AGENTS" --max-disconnects 0 --max-api-errors 0 --max-loop-lag-ms 10000 --min-minutes 5 > "$RUN/check.txt" 2>&1
rc=$?
set -e
cat "$RUN/check.txt"
[ "$rc" = 0 ] || FAILED+=("check_scale_run (終了コード $rc。FAIL なら基準外)")

echo "+ node tools/summarize_run.js $RUN --text > $RUN/summary.txt"
if ! node tools/summarize_run.js "$RUN" --text > "$RUN/summary.txt" 2> "$RUN/summary.err"; then
  FAILED+=("summarize_run ($RUN/summary.err を見ること)"); cat "$RUN/summary.err" >&2 || true
else rm -f "$RUN/summary.err"; fi

echo "+ node tools/conflict_stats.js $RUN --json > $RUN/conflict.json"
if ! node tools/conflict_stats.js "$RUN" --json > "$RUN/conflict.json" 2> "$RUN/conflict.err"; then
  FAILED+=("conflict_stats ($RUN/conflict.err を見ること)"); cat "$RUN/conflict.err" >&2 || true
else rm -f "$RUN/conflict.err"; fi

# ---- 3. 要点 ----
echo
echo "== 要点 =="
if node tools/exp_digest.js "$RUN" > "$RUN/digest.txt" 2>&1; then cat "$RUN/digest.txt"
else FAILED+=("exp_digest"); cat "$RUN/digest.txt" >&2 || true; fi
cat <<EOF

出力:
  $RUN/check.txt
  $RUN/summary.txt    (less で読む。後ろに週次報告用の文)
  $RUN/conflict.json
  $RUN/digest.txt
EOF

# ---- 4. サーバー ----
SERVER_MSG=""
if [ "$STOP_SERVER" = 1 ]; then
  echo
  if [ -z "$(procs_of "$PAT_SERVER")" ]; then
    echo "サーバーはもう止まっている"
  else
    start=$(wc -l < "$MC_DIR/console.log" 2>/dev/null || echo 0)
    sent=0
    if [ -n "${EXP_SEND_CMD:-}" ]; then "$EXP_SEND_CMD" list && sent=1
    elif [ -p "$MC_DIR/cmd_pipe" ]; then timeout 5 bash -c 'printf "list\n" > "$1"' _ "$MC_DIR/cmd_pipe" && sent=1; fi
    line=""
    if [ "$sent" = 1 ]; then
      for _ in $(seq 1 10); do
        line=$(tail -n +"$((start + 1))" "$MC_DIR/console.log" 2>/dev/null | grep -m1 -E 'There are [0-9]+ of a max of [0-9]+ players online' || true)
        [ -n "$line" ] && break
        sleep 0.5
      done
    fi
    n=$(echo "$line" | sed -nE 's/.*There are ([0-9]+) of a max.*/\1/p')
    names=$(echo "$line" | sed -nE 's/.*players online:[[:space:]]*//p')
    if [ -z "$n" ] && [ "$FORCE" = 0 ]; then
      SERVER_MSG="サーバーの接続者を確かめられなかったので止めていない (--force で止める)"
    elif [ -n "$n" ] && [ "$n" -gt 0 ] && [ "$FORCE" = 0 ]; then
      SERVER_MSG="接続者が $n 人いる ($names) ので、サーバーは止めていない (--force で止める)"
    else
      echo "+ bash $MC_DIR/stop.sh"
      bash "$MC_DIR/stop.sh" || FAILED+=("stop.sh")
    fi
    [ -z "$SERVER_MSG" ] || echo "注意: $SERVER_MSG" >&2
  fi
fi

echo
if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "失敗したもの:" >&2
  for f in "${FAILED[@]}"; do echo "  - $f" >&2; done
  exit 1
fi
echo "集計はすべて通った"
