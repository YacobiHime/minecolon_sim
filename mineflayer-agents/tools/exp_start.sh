#!/usr/bin/env bash
# 100人の実験の準備と開始を1つのコマンドで (手順は /root/experiment_runbook.md の 0〜2 と同じ)。
#   状態の確認 → 内容と費用の確認 (y/N) → サーバーを止める → pristine をコピー → prepare_survival
#   → start.sh → Done を待つ → init_survival → morning → run.js を切り離して起動 → 記録のフォルダを確かめる
# 使い方: bash tools/exp_start.sh --help
# 止めて集計するのは tools/exp_stop.sh。
#
# テストのときだけ外のコマンドを差し替えられる (ふだんは設定しない):
#   EXP_PGREP          pgrep の代わり (pgrep -fa <パターン> と同じ出力を返すこと)
#   EXP_NODE           run.js を動かす node の代わり
#   EXP_SEND_CMD       cmd_pipe に1行送る代わりのコマンド (引数に送る行)
#   EXP_FIRST_SETTING  server-fabric/first_setting_world.sh の代わり
#   EXP_RUNS_DIR       記録のフォルダの親 (既定 <コード>/runs)
#   EXP_LOG_DIR        live-run-*.log を置く場所 (既定 <コード>)
#   EXP_START_TIMEOUT  Done ( を待つ秒数 (既定 240)、EXP_LAUNCH_WAIT 起動後に確かめるまでの最長の秒数 (既定 20)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
A="$(cd "$SCRIPT_DIR/.." && pwd)"   # mineflayer-agents (コード)
MC_DIR="${MC_DIR:-/root/mc-server-fabric}"
PGREP="${EXP_PGREP:-pgrep}"
NODE_BOT="${EXP_NODE:-node}"
FIRST_SETTING="${EXP_FIRST_SETTING:-$A/server-fabric/first_setting_world.sh}"
RUNS_DIR="${EXP_RUNS_DIR:-$A/runs}"
LOG_DIR="${EXP_LOG_DIR:-$A}"
START_TIMEOUT="${EXP_START_TIMEOUT:-240}"
LAUNCH_WAIT="${EXP_LAUNCH_WAIT:-20}"

# 自分のコマンドに一致しないブラケット付きのパターン
PAT_BOT='node .*run[.]js'
PAT_SERVER='^[^ ]*java .*fabric-server-launc[h]'

AGENTS=100; PROCS=10; MINUTES=30; SEED=20261111; LLM_PROVIDER=luna; MAX_LLM_USD=80
PROVENANCE=on; OWNERSHIP_PENALTY=on; GRUDGE=on; CONFLICT=on; AGGRESSION=on
WORLD=""; REUSE=""; PRISTINE=world_survival3d_15_pristine; CONFIG=configs/survival_100.json
YES=0; FORCE=0; DRY=0
STAGGER_MS=1500; MAX_JEV_TOKENS=1000000000

usage() {
  cat <<'EOF'
使い方: bash tools/exp_start.sh [オプション]
  実験の準備 (新しいワールド・サーバーの起動・出現地点・朝) をして、run.js を切り離して起動する。

  --agents N               人数 (既定 100)
  --procs N                プロセス数 (既定 10。1プロセス10人が目安)
  --minutes N              長さ (分。既定 30)
  --seed N                 並べ方の種 (既定 20261111)
  --llm-provider P         local|luna (既定 luna)
  --max-llm-usd X          LLM の費用の上限 (ドル。既定 80)
  --provenance on|off      所有の知識と行動の分離 (既定 on)
  --ownership-penalty on|off  (既定 on)
  --grudge on|off          わだかまり (既定 on)
  --conflict on|off        悪い関係の行動の候補 (既定 on)
  --aggression on|off      殴る (既定 on)
  --world NAME             新しく作るワールドの名前 (既定 world_survival3d_<次の空き番号>)
  --reuse NAME             既存のワールドをそのまま使う (コピーしない)。起動中のワールドと同じならサーバーを止めない
  --pristine NAME          コピー元 (既定 world_survival3d_15_pristine。消さない・直接使わない)
  --config FILE            設定 (既定 configs/survival_100.json。コードの場所から見たパス)
  --yes                    確認 (y/N) を飛ばす
  --force                  接続者がいても続ける
  --dry-run                何も変えず、打つコマンドを表示するだけ (状態の確認と list は行う)
  --help                   この説明

例:
  bash tools/exp_start.sh                                   # 既定 (100人30分・すべて on) で新しいワールド
  bash tools/exp_start.sh --grudge off --conflict off --aggression off   # 比較 (わだかまりなし)
  bash tools/exp_start.sh --reuse world_survival3d_19 --yes # 今のワールドで続ける
  bash tools/exp_start.sh --agents 20 --procs 2 --minutes 10 --dry-run
環境変数: MC_DIR (サーバー。既定 /root/mc-server-fabric)
EOF
}

die() { echo "エラー: $*" >&2; exit 1; }

onoff() { # $1=名前 $2=値
  case "$2" in on|off) ;; *) die "$1 は on か off (受け取った値: '$2')";; esac
}
posint() { [[ "$2" =~ ^[0-9]+$ ]] && [ "$2" -gt 0 ] || die "$1 は正の整数 (受け取った値: '$2')"; }

need_val() { [ $# -ge 2 ] && [ -n "$2" ] || die "$1 に値がない"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --agents) need_val "$@"; AGENTS="$2"; shift 2;;
    --procs) need_val "$@"; PROCS="$2"; shift 2;;
    --minutes) need_val "$@"; MINUTES="$2"; shift 2;;
    --seed) need_val "$@"; SEED="$2"; shift 2;;
    --llm-provider) need_val "$@"; LLM_PROVIDER="$2"; shift 2;;
    --max-llm-usd) need_val "$@"; MAX_LLM_USD="$2"; shift 2;;
    --provenance) need_val "$@"; PROVENANCE="$2"; shift 2;;
    --ownership-penalty) need_val "$@"; OWNERSHIP_PENALTY="$2"; shift 2;;
    --grudge) need_val "$@"; GRUDGE="$2"; shift 2;;
    --conflict) need_val "$@"; CONFLICT="$2"; shift 2;;
    --aggression) need_val "$@"; AGGRESSION="$2"; shift 2;;
    --world) need_val "$@"; WORLD="$2"; shift 2;;
    --reuse) need_val "$@"; REUSE="$2"; shift 2;;
    --pristine) need_val "$@"; PRISTINE="$2"; shift 2;;
    --config) need_val "$@"; CONFIG="$2"; shift 2;;
    --yes|-y) YES=1; shift;;
    --force) FORCE=1; shift;;
    --dry-run) DRY=1; shift;;
    --help|-h) usage; exit 0;;
    *) usage >&2; die "知らない引数: $1";;
  esac
done

posint --agents "$AGENTS"; posint --procs "$PROCS"; posint --minutes "$MINUTES"
[[ "$SEED" =~ ^[0-9]+$ ]] || die "--seed は整数 (受け取った値: '$SEED')"
[[ "$MAX_LLM_USD" =~ ^[0-9]+([.][0-9]+)?$ ]] || die "--max-llm-usd は数 (受け取った値: '$MAX_LLM_USD')"
case "$LLM_PROVIDER" in local|luna) ;; *) die "--llm-provider は local か luna (受け取った値: '$LLM_PROVIDER')";; esac
onoff --provenance "$PROVENANCE"; onoff --ownership-penalty "$OWNERSHIP_PENALTY"; onoff --grudge "$GRUDGE"
onoff --conflict "$CONFLICT"; onoff --aggression "$AGGRESSION"
[ -z "$WORLD" ] || [ -z "$REUSE" ] || die "--world と --reuse は一緒に使えない"
for n in "$WORLD" "$REUSE" "$PRISTINE"; do
  [ -z "$n" ] || [[ "$n" =~ ^[A-Za-z0-9_.-]+$ ]] || die "ワールドの名前に使えない文字がある: '$n'"
done
[ -f "$A/$CONFIG" ] || [ -f "$CONFIG" ] || die "設定ファイルが無い: $CONFIG (コードの場所 $A から見たパス)"
[ -d "$MC_DIR" ] || die "サーバーの場所が無い: $MC_DIR (MC_DIR で指定)"
[ -f "$MC_DIR/start.sh" ] && [ -f "$MC_DIR/stop.sh" ] || die "$MC_DIR に start.sh・stop.sh が無い"
[ -f "$FIRST_SETTING" ] || die "ワールドの設定スクリプトが無い: $FIRST_SETTING"

# ---- 小さな道具 ----
q() { local s=""; for a in "$@"; do s+="$(printf '%q' "$a") "; done; echo "${s% }"; }
# 実行する (dry-run なら表示だけ)
run() {
  if [ "$DRY" = 1 ]; then echo "[dry-run] $(q "$@")"; else echo "+ $(q "$@")"; "$@"; fi
}
procs_of() { "$PGREP" -fa "$1" 2>/dev/null || true; }
send_line() { # cmd_pipe に1行送る (サーバーが読んでいないと書き込みが止まるので timeout 付き)
  if [ -n "${EXP_SEND_CMD:-}" ]; then "$EXP_SEND_CMD" "$1"; return; fi
  [ -p "$MC_DIR/cmd_pipe" ] || return 1
  timeout 5 bash -c 'printf "%s\n" "$1" > "$2"' _ "$1" "$MC_DIR/cmd_pipe"
}
console_lines() { if [ -f "$MC_DIR/console.log" ]; then wc -l < "$MC_DIR/console.log"; else echo 0; fi; }
# サーバーに list を送り、「人数<TAB>名前」を出す。返事が無ければ失敗
LIST_N=""; LIST_NAMES=""
list_players() {
  local start line i
  start=$(console_lines)
  send_line list || return 1
  for i in $(seq 1 10); do
    line=$(tail -n +"$((start + 1))" "$MC_DIR/console.log" 2>/dev/null | grep -m1 -E 'There are [0-9]+ of a max of [0-9]+ players online' || true)
    if [ -n "$line" ]; then
      LIST_N=$(echo "$line" | sed -E 's/.*There are ([0-9]+) of a max.*/\1/')
      LIST_NAMES=$(echo "$line" | sed -E 's/.*players online:[[:space:]]*//')
      return 0
    fi
    sleep 0.5
  done
  return 1
}
level_name() { grep -E '^level-name=' "$MC_DIR/server.properties" 2>/dev/null | head -1 | cut -d= -f2- || true; }

# ---- 1. 状態の確認 ----
echo "== 状態の確認 =="
BOTS=$(procs_of "$PAT_BOT")
if [ -n "$BOTS" ]; then
  echo "$BOTS" >&2
  die "ボット (node run.js) がもう動いている。止めるなら: bash $SCRIPT_DIR/exp_stop.sh"
fi
SERVER=$(procs_of "$PAT_SERVER")
CUR_LEVEL=$(level_name)
SERVER_UP=0
if [ -n "$SERVER" ]; then
  SERVER_UP=1
  echo "サーバー: 動いている (ワールド ${CUR_LEVEL:-不明})"
  if list_players; then
    if [ "$LIST_N" -gt 0 ]; then
      if [ "$FORCE" = 1 ]; then echo "注意: 接続者が $LIST_N 人いる ($LIST_NAMES)。--force なので続ける"
      else die "接続者が $LIST_N 人いる: $LIST_NAMES。抜けてもらうか、--force で続ける"; fi
    else echo "接続者: 0 人"; fi
  else
    if [ "$FORCE" = 1 ]; then echo "注意: list の返事が無く接続者を確かめられなかった。--force なので続ける"
    else die "サーバーに list を送ったが返事が無く、接続者を確かめられなかった ($MC_DIR/console.log を見ること)。--force で続ける"; fi
  fi
else
  echo "サーバー: 止まっている (設定のワールド ${CUR_LEVEL:-不明})"
fi

# ---- 使うワールドを決める ----
MODE=new
if [ -n "$REUSE" ]; then
  MODE=reuse; TARGET="$REUSE"
  [ -d "$MC_DIR/$TARGET" ] || die "--reuse のワールドが無い: $MC_DIR/$TARGET"
  [ "$TARGET" != "$PRISTINE" ] || die "pristine ($PRISTINE) は初期状態の元なので直接使わない"
else
  [ -d "$MC_DIR/$PRISTINE" ] || die "コピー元 (pristine) が無い: $MC_DIR/$PRISTINE"
  if [ -n "$WORLD" ]; then TARGET="$WORLD"
  else
    max=0
    for d in "$MC_DIR"/world_survival3d_*; do
      b=$(basename "$d")
      [[ "$b" =~ ^world_survival3d_([0-9]+)$ ]] || continue
      if [ "${BASH_REMATCH[1]}" -gt "$max" ]; then max="${BASH_REMATCH[1]}"; fi
    done
    TARGET="world_survival3d_$((max + 1))"
  fi
  [ ! -e "$MC_DIR/$TARGET" ] || die "ワールドがもうある: $MC_DIR/$TARGET (そのまま使うなら --reuse $TARGET、別の名前なら --world)"
fi
KEEP_SERVER=0
if [ "$MODE" = reuse ] && [ "$SERVER_UP" = 1 ] && [ "$CUR_LEVEL" = "$TARGET" ]; then KEEP_SERVER=1; fi

# ---- 2. 内容と費用の確認 ----
COST=$(awk -v a="$AGENTS" -v m="$MINUTES" 'BEGIN { printf "%.1f", 8 * (a / 100) * (m / 30) }')
COMMIT=$(git -C "$A" rev-parse --short HEAD 2>/dev/null || echo 不明)
BRANCH=$(git -C "$A" rev-parse --abbrev-ref HEAD 2>/dev/null || echo 不明)
DIRTY=$(git -C "$A" status --porcelain --untracked-files=no 2>/dev/null | head -1 || true)
RUN_ARGS=(run.js --config "$CONFIG" --agents "$AGENTS" --procs "$PROCS" --minutes "$MINUTES"
  --stagger-ms "$STAGGER_MS" --seed "$SEED" --llm-provider "$LLM_PROVIDER" --max-llm-usd "$MAX_LLM_USD" --max-jev-tokens "$MAX_JEV_TOKENS"
  --provenance "$PROVENANCE" --ownership-penalty "$OWNERSHIP_PENALTY" --grudge "$GRUDGE" --conflict "$CONFLICT" --aggression "$AGGRESSION")

echo
echo "== 実行の内容 =="
echo "  人数 $AGENTS (プロセス $PROCS)・$MINUTES 分・種 $SEED・LLM $LLM_PROVIDER (上限 \$$MAX_LLM_USD)"
echo "  所有 provenance=$PROVENANCE ownership-penalty=$OWNERSHIP_PENALTY / わだかまり grudge=$GRUDGE conflict=$CONFLICT aggression=$AGGRESSION"
echo "  設定 $CONFIG"
if [ "$MODE" = new ]; then echo "  ワールド $TARGET (新しく作る。元 $PRISTINE)"
elif [ "$KEEP_SERVER" = 1 ]; then echo "  ワールド $TARGET (今動いているワールドをそのまま使う。サーバーは止めない)"
else echo "  ワールド $TARGET (既存。コピーしない。サーバーを切り替えて起動)"; fi
echo "  コード $A ($BRANCH @ $COMMIT${DIRTY:+、未コミットの変更あり})"
echo "  サーバー $MC_DIR"
echo "  推定の費用 約 \$$COST (100人30分で約8ドルからの比例の概算)"

if [ "$DRY" = 0 ] && [ "$YES" = 0 ]; then
  if [ ! -t 0 ]; then die "確認ができない (端末でない)。--yes を付けて実行すること"; fi
  read -r -p "始めますか? [y/N] " ans
  case "$ans" in y|Y|yes|YES) ;; *) echo "やめた"; exit 1;; esac
fi

# ---- 3. ワールドとサーバーの準備 ----
echo
echo "== ワールドとサーバーの準備 =="
if [ "$KEEP_SERVER" = 0 ]; then
  if [ "$SERVER_UP" = 1 ]; then
    run bash "$MC_DIR/stop.sh"
    if [ "$DRY" = 0 ] && [ -n "$(procs_of "$PAT_SERVER")" ]; then die "サーバーが止まらなかった (stop.sh の出力を見ること)"; fi
  fi
  if [ "$MODE" = new ]; then run cp -a "$MC_DIR/$PRISTINE" "$MC_DIR/$TARGET"; fi
  run env MC_DIR="$MC_DIR" SURVIVAL_LEVEL="$TARGET" bash "$FIRST_SETTING" prepare_survival
  START_LINE=$(console_lines)
  run bash "$MC_DIR/start.sh"
  if [ "$DRY" = 1 ]; then
    echo "[dry-run] (console.log に 'Done (' が出るまで最長 ${START_TIMEOUT} 秒待つ)"
  else
    waited=0
    until tail -n +"$((START_LINE + 1))" "$MC_DIR/console.log" 2>/dev/null | grep -q 'Done ('; do
      [ "$waited" -lt "$START_TIMEOUT" ] || die "サーバーが ${START_TIMEOUT} 秒で起動しなかった (console.log に 'Done (' が出ない)。$MC_DIR/console.log を見ること"
      sleep 2; waited=$((waited + 2))
    done
    echo "サーバー起動 (Done を確認)"
  fi
  run env MC_DIR="$MC_DIR" bash "$FIRST_SETTING" init_survival
else
  echo "サーバーはそのまま ($TARGET)"
fi
run env MC_DIR="$MC_DIR" bash "$FIRST_SETTING" morning

# ---- 4. run.js を切り離して起動 ----
echo
echo "== 実験の開始 =="
STAMP=$(date +%m%d-%H%M%S)
LOG="$LOG_DIR/live-run-$STAMP.log"
LAUNCH="cd $(q "$A") && exec $(q "$NODE_BOT" "${RUN_ARGS[@]}") > $(q "$LOG") 2>&1 < /dev/null"
if [ "$DRY" = 1 ]; then
  echo "[dry-run] setsid -f bash -c \"$LAUNCH\""
  echo "[dry-run] (起動後、プロセスと $RUNS_DIR/ の新しいフォルダを確かめ、exp_start.json を書く)"
  echo
  echo "dry-run なので何も変えていない。"
  exit 0
fi

mkdir -p "$RUNS_DIR"
BEFORE=$(ls -1 "$RUNS_DIR" 2>/dev/null | sort || true)
STARTED_AT=$(date -Is)
echo "+ setsid -f bash -c \"$LAUNCH\""
setsid -f bash -c "$LAUNCH"
RUN_DIR=""; waited=0
while [ "$waited" -lt "$LAUNCH_WAIT" ]; do
  sleep 1; waited=$((waited + 1))
  NEW=$(comm -13 <(echo "$BEFORE") <(ls -1 "$RUNS_DIR" 2>/dev/null | sort) | tail -1 || true)
  if [ -n "$NEW" ] && [ -d "$RUNS_DIR/$NEW" ]; then RUN_DIR="$RUNS_DIR/$NEW"; break; fi
  [ -n "$(procs_of "$PAT_BOT")" ] || break
done
sleep 2
ALIVE=$(procs_of "$PAT_BOT")
if [ -z "$ALIVE" ]; then
  echo "--- $LOG の最後 ---" >&2; tail -n 20 "$LOG" >&2 || true
  die "run.js がすぐに終わった (上のログを見ること)"
fi
[ -n "$RUN_DIR" ] || die "run.js は動いているが、$RUNS_DIR に新しい記録のフォルダができない (ログ $LOG を見ること)"
PARENT_PID=$(echo "$ALIVE" | grep -v -- ' --child ' | head -1 | awk '{print $1}')

# 実行の内容を残す
EXP_JSON="$RUN_DIR/exp_start.json" \
J_STARTED="$STARTED_AT" J_WORLD="$TARGET" J_MODE="$MODE" J_PRISTINE="$PRISTINE" J_KEEP="$KEEP_SERVER" J_MC="$MC_DIR" \
J_CODE="$A" J_COMMIT="$(git -C "$A" rev-parse HEAD 2>/dev/null || echo)" J_BRANCH="$BRANCH" J_DIRTY="${DIRTY:+1}" J_LOG="$LOG" J_PID="${PARENT_PID:-}" \
J_AGENTS="$AGENTS" J_PROCS="$PROCS" J_MINUTES="$MINUTES" J_SEED="$SEED" J_LLM="$LLM_PROVIDER" J_USD="$MAX_LLM_USD" J_CONFIG="$CONFIG" \
J_PROV="$PROVENANCE" J_PEN="$OWNERSHIP_PENALTY" J_GRUDGE="$GRUDGE" J_CONFLICT="$CONFLICT" J_AGG="$AGGRESSION" J_COST="$COST" \
node -e '
const e = process.env;
const out = {
  startedAt: e.J_STARTED,
  args: { agents: +e.J_AGENTS, procs: +e.J_PROCS, minutes: +e.J_MINUTES, seed: +e.J_SEED, llmProvider: e.J_LLM, maxLlmUsd: +e.J_USD, config: e.J_CONFIG,
    provenance: e.J_PROV, ownershipPenalty: e.J_PEN, grudge: e.J_GRUDGE, conflict: e.J_CONFLICT, aggression: e.J_AGG },
  world: { name: e.J_WORLD, mode: e.J_MODE, pristine: e.J_MODE === "new" ? e.J_PRISTINE : null, keptRunningServer: e.J_KEEP === "1", mcDir: e.J_MC },
  code: { dir: e.J_CODE, commit: e.J_COMMIT || null, branch: e.J_BRANCH, dirty: e.J_DIRTY === "1" },
  command: process.argv.slice(1), log: e.J_LOG, pid: e.J_PID ? +e.J_PID : null, estimatedUsd: +e.J_COST,
};
require("fs").writeFileSync(e.EXP_JSON, JSON.stringify(out, null, 2) + "\n");
' "$NODE_BOT" "${RUN_ARGS[@]}"

# ---- 5. 見方 ----
cat <<EOF

== 始まった ==
  記録のフォルダ  $RUN_DIR
  ログ            $LOG
  親の PID        ${PARENT_PID:-不明}
  ワールド        $TARGET

様子を見る (Ctrl+C で見るのをやめるだけ。実験は止まらない):
  tail -f $LOG
  tail -f $MC_DIR/console.log
ゲームに入る: Minecraft 1.20.1 で 100.88.86.71:25565 (LAN なら 192.168.15.102)
止めて集計する:
  bash $SCRIPT_DIR/exp_stop.sh --run $RUN_DIR
EOF
