#!/bin/bash
# Fabric 1.20.1 試験用サーバーの起動 (mineflayer エージェント用)
# 入力: echo '<cmd>' > cmd_pipe   出力: console.log
set -e
MC_DIR="$(cd "$(dirname "$0")" && pwd)"
JAVA="${JAVA:-/opt/jdk-17.0.19+10/bin/java}"
XMX="${XMX:-6G}"
cd "$MC_DIR"
# 自分のコマンドに一致しないようにブラケット付きのパターンで探す
if pgrep -f 'fabric-server-launc[h]' > /dev/null; then
  echo "ERROR: すでに起動中 (PID $(pgrep -f 'fabric-server-launc[h]'))"; exit 1
fi
rm -f cmd_pipe; mkfifo cmd_pipe
START_LINE=$(wc -l < console.log 2>/dev/null || echo 0)
setsid -f bash -c "tail -f /dev/null > cmd_pipe & T=\$!; '$JAVA' -Xms2G -Xmx$XMX -XX:+UseG1GC -jar fabric-server-launch.jar nogui < cmd_pipe >> console.log 2>&1; kill \$T 2>/dev/null" < /dev/null > /dev/null 2>&1
echo "起動待ち (最大180秒)..."
for i in $(seq 1 90); do
  if tail -n +"$((START_LINE + 1))" console.log 2>/dev/null | grep -q 'Done ('; then
    # java 本体 (setsid の bash -c の包みも同じ文字列を含むので、先頭が java のものを選ぶ)
    PID=$(pgrep -f '^[^ ]*java .*fabric-server-launc[h]' | head -1); echo "$PID" > server.pid
    echo "起動完了 (PID $PID)  port 25565"
    # 試験用の世界設定
    for c in 'gamerule doWeatherCycle false' 'weather clear' 'gamerule doInsomnia false' 'gamerule doTraderSpawning false'; do
      echo "$c" > cmd_pipe; sleep 0.3
    done
    exit 0
  fi
  sleep 2
done
echo "WARNING: 180秒で Done が出なかった。console.log を見ること"
