#!/bin/bash
# Fabric 1.20.1 の試験用サーバーを /root/mc-server-fabric に用意する (一度だけ)。
# Fabric Loader 0.20.1 + installer 1.1.2 + Fabric API 0.92.12+1.20.1。ほかの MOD は入れない。
set -e
DEST="${DEST:-/root/mc-server-fabric}"
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$DEST/mods"
cd "$DEST"
[ -f fabric-server-launch.jar ] || curl -sfL -o fabric-server-launch.jar \
  "https://meta.fabricmc.net/v2/versions/loader/1.20.1/0.20.1/1.1.2/server/jar"
[ -f mods/fabric-api-0.92.12+1.20.1.jar ] || curl -sfL -o mods/fabric-api-0.92.12+1.20.1.jar \
  "https://cdn.modrinth.com/data/P7dR8mSH/versions/rvI2dfzR/fabric-api-0.92.12%2B1.20.1.jar"
echo "3e9cdd3e2f827ca9a259df9eb8e31949437b6bd4  mods/fabric-api-0.92.12+1.20.1.jar" | sha1sum -c -
echo eula=true > eula.txt
cp -n "$HERE/server.properties" "$HERE/ops.json" .
cp "$HERE/start.sh" "$HERE/stop.sh" .
chmod +x start.sh stop.sh
echo "用意できた: bash $DEST/start.sh で起動"
