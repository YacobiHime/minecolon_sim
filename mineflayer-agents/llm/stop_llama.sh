#!/bin/bash
# llama-server の停止 (pkill -f は自分のシェルに一致しうるので PID を拾って kill する)
PORT="${PORT:-18081}"
PIDS=$(pgrep -f 'llama-serve[r].*--port '"$PORT")
if [ -z "$PIDS" ]; then echo "停止済み"; exit 0; fi
kill $PIDS && echo "停止: $PIDS"
