# 引き継ぎ

このページは、後任者や研究室メンバーが実験を再現・拡張するために必要な最小限の操作手順をまとめたものです。詳細な設計判断や過去のトラブル履歴は、リポジトリ内の以下の文書を参照してください。

- `HANDOFF_2026-08-01.md` — 最新の技術状態と既知の問題
- `IMPLEMENTATION_NOTES.md` — bridge/council/supply_bot の実装詳細
- `DESIGN_DECISIONS_normal_world.md` — 通常ワールド移行の設計判断
- `COGNITIVE_MODEL.md` — 詳細認知ペルソナの定義、比較結果、主張範囲
- `progress_report_*.md` — 節目ごとの進捗レポート

## リポジトリ構成

| パス | 内容 |
|---|---|
| `/home/mine-admin/minecolon_sim/` | このリポジトリ (branch: `minecolonies-experiment`) |
| `/home/mine-admin/minecolon_sim/minecolonies-bridge/` | Bridge mod ソース + Node.js エージェント |
| `/home/mine-admin/mc-server-forge/` | Forge 1.20.1 サーバー本体 |
| `/home/mine-admin/mc-server-forge/mods/voyagerbridge-*.jar` | ビルド済み Bridge mod |
| `/home/mine-admin/mc-server-forge/console.log` | サーバーログ (追記) |
| `/home/mine-admin/mc-server-forge/cmd_pipe` | 名前付き FIFO (サーバー stdin 代わり) |

## 必要な環境

| 項目 | 値 |
|---|---|
| サーバー OS | Linux |
| JDK (ビルド用) | 17 (`/opt/jdk-17.0.19+10`) |
| JDK (サーバー起動用) | 21 (システム) |
| Node.js | 16+ |
| LLM 推論サーバー | ollama (`192.168.15.150:11434`, モデル `gemma4:e4b`) |
| サーバーポート | 25566 (Minecraft), 8089 (Bridge HTTP API) |

## サーバー起動と停止

```bash
# 起動 (エージェント含む全部立ち上げ)
cd /home/mine-admin/mc-server-forge
bash start_server.sh

# エージェントなしで起動 (デバッグ用)
bash start_server.sh --no-agents

# 停止 (council / supply_bot を kill してからサーバー stop)
bash stop_server.sh
```

!!! warning "座標に依存する起動オプション"
    現在のコロニーは spawn から離れた場所にあるため、起動時に forceload 範囲を環境変数で指定する必要があります。
    ```
    FORCELOAD_CX=501 FORCELOAD_CZ=-319 FORCELOAD_R=80 bash start_server.sh
    ```
    起動後は必ず tick 適応ガバナーを ON にしてください。
    ```
    curl -s -X POST 'http://localhost:8089/tickrate?auto=true'
    ```

## Bridge mod の更新

Java コードを変更したら、必ずリビルド → 配備 → サーバー再起動が必要です。

```bash
bash stop_server.sh
bash rebuild_bridge.sh   # JDK17 でビルド → mods/ に自動配備
bash start_server.sh
```

!!! tip "Mojang マッピングでコンパイル"
    Bridge mod は Mojang マッピング (`level.getHeight()`, `pos.getY()` 等) でコンパイルします。SRG (`func_xxx`) ではありません。

skill として `deploy-bridge` を用意しているので、`/deploy-bridge` を実行するとこの手順を自動で辿ります。

## エージェント (council / supply_bot) の個別再起動

サーバー本体を落とさずに Node.js プロセスだけ再起動したい場合。

```bash
# supply_bot の再起動
pkill -f 'node supply_bot.js'
(cd /home/mine-admin/minecolon_sim/minecolonies-bridge && \
  setsid nohup node supply_bot.js >> supply_bot.log 2>&1 &)

# council の再起動
pkill -f 'node council.js'
(cd /home/mine-admin/minecolon_sim/minecolonies-bridge && \
  setsid nohup node council.js >> council.log 2>&1 &)
```

!!! danger "サブシェル内 cd 必須"
    裸で `node supply_bot.js &` すると即死します。`(cd ... && setsid nohup ... &)` の形で必ずサブシェルに閉じ込めてください。

!!! danger "各 1 プロセスのみ"
    supply_bot / council は **常に 1 プロセスだけ**。多重起動すると相互に上書きし合って壊れます。

## よく使う診断コマンド

```bash
# Bridge 死活確認
curl -s http://localhost:8089/ping

# コロニー全体の状態
curl -s http://localhost:8089/status | jq .

# 未解決の Work Order 一覧
curl -s 'http://localhost:8089/debugWorkOrders?colonyId=1' | jq .

# tick 状態確認 (現在の mspt と倍率)
curl -s http://localhost:8089/tickrate

# 特定市民のオープンリクエスト
curl -s "http://localhost:8089/openRequests?x=<hutX>&y=<hutY>&z=<hutZ>&citizenId=<id>" | jq .

# サーバーコンソールにコマンドを送る
echo '/gamerule doDaylightCycle false' > /home/mine-admin/mc-server-forge/cmd_pipe
tail -f /home/mine-admin/mc-server-forge/console.log
```

## トラブルシューティング

### 市民が働かない・建設が進まない

skill `colony-diag` を実行してください。MineColonies 固有の落とし穴 (食事 3 層ゲート、builder 作業半径 100、チャンク claim 問題等) を体系的に診断します。

代表的な原因:

- **チャンクが未ロード** — builder が施工地に行けず despawn する。forceload 範囲がコロニー領土全体を覆っているか確認
- **食事要件を満たさない** — 住居レベルに応じて栄養値・料理の多様性・料理の質の要件が上がる
- **建物レベルが町役場レベルを超えようとしている** — 町役場が全体の "天井". 建築家 hut のリープフロッグで先に町役場を上げる
- **道具の tier が職員レベル/hut レベルを超えている** — 低レベル建築家に鉄以上の道具を渡すと使えない (木/石を渡す)

### bridge が応答しない (`/ping` が返らない)

サーバーごと落ちている可能性が高いです。`console.log` の末尾を確認し、必要なら再起動 (`start_server.sh`)。

### Work Order が発行されない

`/place` した建物と担当 builder hut の位置関係を疑ってください。lv1 以上の builder hut が半径 100 以内に必要です。`/debugBuildGates?x&y&z` で発注時のゲート判定を確認できます。

### council の LLM 応答が壊れる

ollama サーバー (`192.168.15.150:11434`) の疎通と、`think: false` + スキーマ強制が council.js に効いているか確認します。詳細は `mayor-system` skill と メモリ `minecolonies-council-operation`。

## Git の運用

- 節目ごとに `progress_report_<日付>.md` を追加/更新
- **origin と fork の両方に push** (`origin`: 元の卒研リポジトリ、`fork`: 現行の atsushi-chiba/Voyager)
- コミットメッセージは英語基調・短く

## この wiki を更新するには

wiki は `wiki/` 配下で MkDocs Material を使ってビルドし、GitHub Actions で `gh-pages` ブランチに自動デプロイされます。

```bash
# ローカルプレビュー
cd /home/mine-admin/minecolon_sim/wiki
pip install -r requirements.txt
mkdocs serve  # http://127.0.0.1:8000

# 本番ビルド (CI で自動実行される)
mkdocs build --strict
```

`minecolonies-experiment` ブランチに `wiki/**` の変更を push すると、自動的にビルド → デプロイされます。
