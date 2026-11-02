#!/bin/bash
# panama の CPU で llama-server (OpenAI 互換) を起動する。
# 置き場所: /opt/llama.cpp/start_llama.sh (この控えを setup でコピー)
#   ログ: /opt/llama.cpp/llama-server.log   停止: /opt/llama.cpp/stop_llama.sh
# Minecraft と CPU を取り合わないよう、スレッドは 8 (i5-12600K の P コア 6 + 余裕)。
LLAMA_DIR="${LLAMA_DIR:-/opt/llama.cpp}"
MODEL="${MODEL:-/opt/models/google_gemma-4-E2B-it-Q4_K_M.gguf}"
PORT="${PORT:-18081}"
THREADS="${THREADS:-8}"
PARALLEL="${PARALLEL:-2}"
CTX="${CTX:-8192}"   # 全スロット合計 (1スロット 4096)

if pgrep -f 'llama-serve[r].*--port '"$PORT" > /dev/null; then
  echo "すでに起動中: $(pgrep -fa 'llama-serve[r].*--port '"$PORT")"; exit 1
fi
cd "$LLAMA_DIR"
# --reasoning off: 2B では考える過程を書かせると遅くなるだけなので切る
setsid -f "$LLAMA_DIR/current/llama-server" \
  -m "$MODEL" -a gemma-4-e2b \
  --host 127.0.0.1 --port "$PORT" \
  -t "$THREADS" -c "$CTX" -np "$PARALLEL" \
  --reasoning off --metrics \
  >> "$LLAMA_DIR/llama-server.log" 2>&1 < /dev/null
for i in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$PORT/health" > /dev/null; then
    echo "llama-server 起動完了: http://127.0.0.1:$PORT/v1 (PID $(pgrep -f 'llama-serve[r].*--port '"$PORT"))"; exit 0
  fi
  sleep 1
done
echo "WARNING: 60秒で /health が応答しない。$LLAMA_DIR/llama-server.log を見ること"
