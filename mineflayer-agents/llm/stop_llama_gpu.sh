#!/bin/bash
# gpu-server の llama-server の停止 (pkill -f は自分のシェルに一致しうるので PID を拾って kill する)
# 他の人の GPU プロセス (python 等) には触らない。llama-server だけを止める。
PORT="${PORT:-18081}"
PIDS=$(pgrep -f 'llama-serve[r].*--port '"$PORT")
if [ -z "$PIDS" ]; then echo "停止済み"; exit 0; fi
kill $PIDS && echo "停止: $PIDS"
