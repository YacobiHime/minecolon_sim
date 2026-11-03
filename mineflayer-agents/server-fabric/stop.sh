#!/bin/bash
# Fabric 試験用サーバーの停止 (cmd_pipe に stop を送って待つ)
MC_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$MC_DIR"
if ! pgrep -f 'fabric-server-launc[h]' > /dev/null; then echo "停止済み"; rm -f server.pid; exit 0; fi
[ -p cmd_pipe ] && echo 'stop' > cmd_pipe
for i in $(seq 1 30); do
  pgrep -f 'fabric-server-launc[h]' > /dev/null || { echo "停止完了"; rm -f server.pid; exit 0; }
  sleep 2
done
echo "60秒で止まらなかった。次の PID を確認して kill すること (pkill -f は使わない):"
pgrep -fa '^[^ ]*java .*fabric-server-launc[h]'
