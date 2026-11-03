#!/bin/bash
# gpu-server (192.168.15.30, RTX 4060 Ti 16GB) で llama-server (OpenAI 互換) を GPU で起動する。
# 置き場所: ~/llama.cpp/start_llama_gpu.sh   ログ: ~/llama.cpp/llama-server.log   停止: ~/llama.cpp/stop_llama_gpu.sh
# 設定は panama の /opt/llama.cpp/start_llama.sh に合わせ、違いは -ngl 99 / --host 0.0.0.0 / 8 スロットだけ。
# 共用 GPU: 他の人のプロセスが約 2GB 使っている。こちらが使ってよいのは残りの約 14GB まで。
# 中身: 公式リリース b12032 の ubuntu-cuda-12.8-x64 事前ビルド + cudart 同梱ライブラリ
#        + libgomp.so.1 (apt download で取って ~/llama.cpp/current に展開。システムには入れていない)
LLAMA_DIR="${LLAMA_DIR:-$HOME/llama.cpp}"
MODEL="${MODEL:-$LLAMA_DIR/models/google_gemma-4-E2B-it-Q4_K_M.gguf}"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-18081}"
PARALLEL="${PARALLEL:-8}"
CTX="${CTX:-32768}"   # 全スロット合計 (1スロット 4096 x 8)
NGL="${NGL:-99}"

if pgrep -f 'llama-serve[r].*--port '"$PORT" > /dev/null; then
  echo "すでに起動中: $(pgrep -fa 'llama-serve[r].*--port '"$PORT")"; exit 1
fi
cd "$LLAMA_DIR"
export LD_LIBRARY_PATH="$LLAMA_DIR/current${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
# --reasoning off: 2B では考える過程を書かせると遅くなるだけなので切る
setsid -f "$LLAMA_DIR/current/llama-server" \
  -m "$MODEL" -a gemma-4-e2b \
  --host "$HOST" --port "$PORT" \
  -ngl "$NGL" -c "$CTX" -np "$PARALLEL" \
  --reasoning off --metrics \
  >> "$LLAMA_DIR/llama-server.log" 2>&1 < /dev/null
for i in $(seq 1 90); do
  if curl -sf "http://127.0.0.1:$PORT/health" > /dev/null; then
    echo "llama-server 起動完了: http://$(hostname -I | awk '{print $1}'):$PORT/v1 (PID $(pgrep -f 'llama-serve[r].*--port '"$PORT"))"
    nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader
    exit 0
  fi
  sleep 1
done
echo "WARNING: 90秒で /health が応答しない。$LLAMA_DIR/llama-server.log を見ること"
