---
name: deploy-bridge
description: VoyagerBridge mod のビルド→配備→サーバー再起動→ヘルスチェックの一連手順。minecolonies-bridge の Java コードを変更してサーバーに反映するときに使う。
---

# VoyagerBridge デプロイ手順

前提: 実験マシンは panama(2026-10-15 に mine-server から移設)。ソースは `/root/minecolon_sim/minecolonies-bridge`、サーバーは `/root/mc-server-forge`(Forge 1.20.1-47.1.3, ゲーム port 25565, bridge HTTP port 8089)。
サーバー側スクリプトは `/root/mc-server-forge/` の `start_server.sh` / `stop_server.sh` / `rebuild_bridge.sh`。
build.gradle が参照する MineColonies 等の jar は既定で `/root/mc-server-forge/mods`(`-PmcModsDir=...` または env `MC_MODS_DIR` で上書き可)。

## 手順

1. **ビルド検証**(サーバー稼働中でも可):
   ```bash
   cd /root/minecolon_sim/minecolonies-bridge && set -o pipefail && \
     JAVA_HOME=/opt/jdk-17.0.19+10 ./gradlew build -x test 2>&1 | tail -5
   ```
   `set -o pipefail` は必須。パイプ先の tail の exit code で gradle 失敗がマスクされ、古い jar を配備した事故がある。

2. **サーバー停止**: `bash /root/mc-server-forge/stop_server.sh`

3. **配備**: `bash /root/mc-server-forge/rebuild_bridge.sh`
   (`/root/minecolon_sim/minecolonies-bridge` を JDK17 で `gradlew jar` →旧 jar 削除→ mods へコピーまでやる。サーバー起動中は拒否される)

4. **起動**:
   - 検証セッションでは、先に `colony_watch.sh` を停止する。watcher は bridge 復帰を検知すると
     council.js / supply_bot.js を自動再起動するため、動いたままでは `--no-agents` が成立しない。
   - 現行コロニー(スーパーフラット、id=1、中心0,-60,0)の検証起動:
     `FORCELOAD_CX=0 FORCELOAD_CZ=0 FORCELOAD_R=72 bash /root/mc-server-forge/start_server.sh --no-agents`
     (start_server.sh の既定値は旧 200/200/72 なので、FORCELOAD_* は必ず明示する)
     コロニーが広がって建物が範囲外に出たら、`/status` の全建物境界をチャンク座標へ丸め、
     `forceload remove all` → `forceload add <minX> <minZ> <maxX> <maxZ>` で全建物を覆う。
     Minecraft の上限は256チャンクなので、矩形の包含チャンク数を事前に確認すること。
   - 通常運用: `--no-agents` なしで起動
   - Codex等のコマンド実行器がコマンド終了時に子プロセスを回収する環境では、通常の起動コマンドが
     `Bridge ready`まで成功しても直後にJavaがログなしで消える。この場合は次のように独立sessionへ
     切り離し、**別コマンド**で`/ping`とJava PIDを確認する。
     ```bash
     setsid -f env FORCELOAD_CX=0 FORCELOAD_CZ=0 FORCELOAD_R=72 \
       bash /root/mc-server-forge/start_server.sh --no-agents \
       >/tmp/voyager_start_server.log 2>&1 </dev/null
     ```
   - 起動完了待ちは Bash の `run_in_background` + until ループで `curl -s http://localhost:8089/status` をポーリング(foreground の sleep 連鎖は harness にブロックされる)。起動には 60〜90 秒かかる。
   - コマンドを `&` で背景化した壊れたチェーンで「サーバーが落ちたまま」になった事故あり。起動系は必ず単独コマンドで。

5. **ヘルスチェック**:
   - `curl -s http://localhost:8089/status | head -c 300` が colonies JSON を返すこと
   - `grep -iE "error|exception" /root/mc-server-forge/console.log | tail -20`
     (起動直後の `Error loading blueprint: Colonial:blueprints/minecolonies/colonial` は無害 — onPlacement の getCorners が pack/path 設定前に走るだけで、後で自己修復される)
   - supply_bot が**ちょうど1プロセス**か: `pgrep -fa supply_bot.js`
     多重起動事故あり。逆に停止していると creativeresolve=false のため建設が資材待ちで全停止する(--no-agents 起動時は必要に応じて `node /root/minecolon_sim/minecolonies-bridge/supply_bot.js` を背景起動)。

6. **tickrate**: サーバー再起動で 1x に戻るので、起動確認したら**必ず** `curl -s -X POST 'http://localhost:8089/tickrate?auto=true'` で適応ガバナーを有効化する(2026-07-08〜。tick処理時間から出せる最大倍率へ15秒ごとに自動調整。この機体では〜10倍、軽いコロニー/強いマシンでは20倍超)。tickrate は bridge の HTTP エンドポイントであり、コンソールコマンドではない — cmd_pipe に送ると `tickrate 10<--[HERE]` という不明コマンドエラーになる(`<--[HERE]` 付きの応答はエラーであって成功ではない)。mod 側でキック/ログインタイムアウト抑止済みなのでリアルプレイヤーがいても 10x のままでよい。

## 反映後

- 動作検証が取れたら `main` ブランチにコミットし、`origin` に push する(単独リポジトリ。`fork` リモートはない)。
