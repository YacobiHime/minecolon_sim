#!/bin/bash
# 最初の「1つの設定」(方針メモ 16章) の世界: 平原の新しいワールド・peaceful・昼夜あり・等倍。
#   prepare : (サーバー停止中に) server.properties の level-name を新しいワールドに切り替える。古いワールドは消さない
#   init    : (サーバー起動後に1回) 最寄りの平原を探して、そこを出現地点にする。出現の広がり 0、昼夜あり
#   morning : (実行の前に毎回) 朝 (time 0) に戻す。夜までの時間 = 約10分 (等倍)
# 3日生き延びる設定 (configs/survival_3days.json): 新しいワールド world_survival3d、同じ seed・同じ出現地点の決め方、normal
#   prepare_survival / init_survival / morning
# 行動の試験用 (試験用のボット1人で短く): world_action_test、peaceful
#   prepare_action_test / init_action_test
# restore : (サーバー停止中に) level-name=world_first_setting・peaceful に戻す
# 使い方: bash first_setting_world.sh prepare && bash /root/mc-server-fabric/start.sh && bash first_setting_world.sh init
set -e
MC_DIR="${MC_DIR:-/root/mc-server-fabric}"
LEVEL="${LEVEL:-world_first_setting}"
SEED="${SEED:-20261102}"
cd "$MC_DIR"

send() { echo "$1" > cmd_pipe; sleep "${2:-0.5}"; }

# server.properties を切り替える (サーバー停止中だけ)
switch_level() { # $1=level $2=difficulty $3=spawn-monsters
  if pgrep -f 'fabric-server-launc[h]' > /dev/null; then echo "ERROR: サーバーが動いている。stop.sh で止めてから"; exit 1; fi
  cp -n server.properties server.properties.before-first-setting || true
  sed -i "s/^level-name=.*/level-name=$1/; s/^level-seed=.*/level-seed=$SEED/; s/^difficulty=.*/difficulty=$2/; s/^spawn-monsters=.*/spawn-monsters=$3/; s/^spawn-animals=.*/spawn-animals=true/" server.properties
  grep -E '^(level-name|level-seed|difficulty|spawn-monsters|spawn-animals)=' server.properties
}

# 最寄りの平原を出現地点にして、ゲームルールを設定する (サーバー起動後に1回)。$1=difficulty、残り=追加のコマンド
init_world() {
  [ -p cmd_pipe ] || { echo "ERROR: サーバーが動いていない"; exit 1; }
  local DIFF="$1"; shift
  START=$(wc -l < console.log)
  send 'locate biome minecraft:plains' 3
  LINE=$(tail -n +"$((START + 1))" console.log | grep -m1 'minecraft:plains is at' || true)
  [ -n "$LINE" ] || { echo "ERROR: 平原が見つからない (console.log を見ること)"; exit 1; }
  X=$(echo "$LINE" | sed -E 's/.*at \[(-?[0-9]+), [^,]+, (-?[0-9]+)\].*/\1/')
  Z=$(echo "$LINE" | sed -E 's/.*at \[(-?[0-9]+), [^,]+, (-?[0-9]+)\].*/\2/')
  echo "平原: x=$X z=$Z"
  send "forceload add $X $Z" 3
  send "execute positioned $X 0 $Z positioned over motion_blocking_no_leaves run setworldspawn ~ ~ ~" 1
  send "forceload remove $X $Z" 0.5
  for c in 'gamerule spawnRadius 0' 'gamerule doDaylightCycle true' 'gamerule doWeatherCycle false' 'weather clear' \
           'gamerule doInsomnia false' 'gamerule doTraderSpawning false' 'gamerule doMobSpawning true' "difficulty $DIFF" "$@" 'time set 0'; do
    send "$c" 0.3
  done
  tail -n +"$((START + 1))" console.log | grep -E 'spawn point|Set the world spawn|Gamerule|difficulty|time|<--\[HERE\]' | tail -12
}

case "$1" in
  prepare)
    switch_level "$LEVEL" peaceful false
    echo "切り替えた。元に戻すには server.properties.before-first-setting を戻す"
    ;;
  init)
    init_world peaceful
    ;;
  prepare_survival)
    switch_level "${SURVIVAL_LEVEL:-world_survival3d}" normal true
    echo "切り替えた (3日生き延びる)。終わったら restore で world_first_setting に戻す"
    ;;
  init_survival)
    # 夜に敵が出る・空腹が進む (normal)。死んだら持ち物は落ちる (keepInventory false)。
    # ベッドは寝ている人が半分以上なら夜が明ける (playersSleepingPercentage 50、5人なら3人)。すぐに生き返る (doImmediateRespawn)
    init_world normal 'gamerule keepInventory false' 'gamerule playersSleepingPercentage 50' 'gamerule doImmediateRespawn true' 'gamerule naturalRegeneration true' 'gamerule showDeathMessages true'
    ;;
  prepare_action_test)
    switch_level "${ACTION_LEVEL:-world_action_test}" peaceful false
    echo "切り替えた (行動の試験用)。終わったら restore で world_first_setting に戻す"
    ;;
  init_action_test)
    init_world peaceful 'gamerule playersSleepingPercentage 0'
    ;;
  restore)
    switch_level "$LEVEL" peaceful false
    echo "world_first_setting に戻した"
    ;;
  morning)
    send 'time set 0' 0.3
    send 'weather clear' 0.3
    ;;
  *) echo "usage: $0 prepare|init|prepare_survival|init_survival|prepare_action_test|init_action_test|restore|morning"; exit 2 ;;
esac
