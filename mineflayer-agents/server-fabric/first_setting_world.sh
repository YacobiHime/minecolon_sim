#!/bin/bash
# 最初の「1つの設定」(方針メモ 16章) の世界: 平原の新しいワールド・peaceful・昼夜あり・等倍。
#   prepare : (サーバー停止中に) server.properties の level-name を新しいワールドに切り替える。古いワールドは消さない
#   init    : (サーバー起動後に1回) 最寄りの平原を探して、そこを出現地点にする。出現の広がり 0、昼夜あり
#   morning : (実行の前に毎回) 朝 (time 0) に戻す。夜までの時間 = 約10分 (等倍)
# 使い方: bash first_setting_world.sh prepare && bash /root/mc-server-fabric/start.sh && bash first_setting_world.sh init
set -e
MC_DIR="${MC_DIR:-/root/mc-server-fabric}"
LEVEL="${LEVEL:-world_first_setting}"
SEED="${SEED:-20261102}"
cd "$MC_DIR"

send() { echo "$1" > cmd_pipe; sleep "${2:-0.5}"; }

case "$1" in
  prepare)
    if pgrep -f 'fabric-server-launc[h]' > /dev/null; then echo "ERROR: サーバーが動いている。stop.sh で止めてから"; exit 1; fi
    cp -n server.properties server.properties.before-first-setting || true
    sed -i "s/^level-name=.*/level-name=$LEVEL/; s/^level-seed=.*/level-seed=$SEED/; s/^difficulty=.*/difficulty=peaceful/; s/^spawn-monsters=.*/spawn-monsters=false/; s/^spawn-animals=.*/spawn-animals=true/" server.properties
    grep -E '^(level-name|level-seed|difficulty|spawn-monsters|spawn-animals)=' server.properties
    echo "切り替えた。元に戻すには server.properties.before-first-setting を戻す"
    ;;
  init)
    [ -p cmd_pipe ] || { echo "ERROR: サーバーが動いていない"; exit 1; }
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
             'gamerule doInsomnia false' 'gamerule doTraderSpawning false' 'gamerule doMobSpawning true' 'difficulty peaceful' 'time set 0'; do
      send "$c" 0.3
    done
    tail -n +"$((START + 1))" console.log | grep -E 'spawn point|Set the world spawn|Gamerule|time' | tail -5
    ;;
  morning)
    send 'time set 0' 0.3
    send 'weather clear' 0.3
    ;;
  *) echo "usage: $0 prepare|init|morning"; exit 2 ;;
esac
