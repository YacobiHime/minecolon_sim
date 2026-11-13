#!/bin/bash
# panama の CPU 用に llama.cpp (公式リリースのビルド済み Linux CPU 版) とモデルを用意する (一度だけ)。
set -e
VER="${VER:-b12032}"
LLAMA_DIR="${LLAMA_DIR:-/opt/llama.cpp}"
MODEL_DIR="${MODEL_DIR:-/opt/models}"
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$LLAMA_DIR" "$MODEL_DIR"
cd "$LLAMA_DIR"
if [ ! -d "llama-$VER" ]; then
  curl -sfL -o "llama-$VER-bin-ubuntu-x64.tar.gz" \
    "https://github.com/ggml-org/llama.cpp/releases/download/$VER/llama-$VER-bin-ubuntu-x64.tar.gz"
  tar xzf "llama-$VER-bin-ubuntu-x64.tar.gz"
fi
ln -sfn "llama-$VER" current
cp "$HERE/start_llama.sh" "$HERE/stop_llama.sh" "$LLAMA_DIR/"
chmod +x "$LLAMA_DIR"/*.sh
# Gemma 4 E2B instruct, Q4_K_M (bartowski の変換)
M="$MODEL_DIR/google_gemma-4-E2B-it-Q4_K_M.gguf"
[ -f "$M" ] || curl -sfL -o "$M" \
  "https://huggingface.co/bartowski/google_gemma-4-E2B-it-GGUF/resolve/main/google_gemma-4-E2B-it-Q4_K_M.gguf"
echo "923c4c86177d2ee173a7f5b4fa3d0ac65f5962ab15e6d6a5bc250aec4fd7bf7e  $M" | sha256sum -c -
echo "用意できた: bash $LLAMA_DIR/start_llama.sh で起動"
