# 実装内容メモ(2026-06-25時点)

`village.js`(4人村づくり、最新かつ最も複雑な実装)を中心に説明する。アーキテクチャは他のスクリプト(`lumber_team.js`, `house_build.js`, `pvp_duel.js`)も基本的に同じパターン。

## 全体の流れ(`village.js` 1ターンのループ)

```
spawnAgent() → bot.spawn → turn(name) ループ(4.5秒ごとに自分自身を再帰呼び出し)
```

各ターンで: 状態をテキスト化 → LLMに送信 → 返答を「発言」と「コード」に分けて解釈 → コード実行、というシンプルな反復構造。

## 1. プロンプトが書かれている場所

| 関数 | 場所 | 内容 |
|---|---|---|
| `buildSystemPrompt(selfName)` | village.js:182-221 | **システムプロンプト本体**。役割(木こり/建築家)ごとに分岐し、チーム構成・チェストの使い方・日本語で話すルール・返答フォーマット(`SAY:`/`CODE:`)を指示。`spawnAgent`内で`agent.history`の最初のメッセージとしてセット(village.js:423) |
| `buildStateContext(bot, selfName)` | village.js:292-318 | **毎ターンのユーザーメッセージ**。座標・インベントリ・チェスト位置・進捗・直近の会話ログを埋め込む `[STATE]` 行 |
| `primitivesDocs` | `control_primitives_context/*.js`を読み込んで連結 | 使える関数(`mineBlock`, `craftItem`, `placeItem`など)の説明をシステムプロンプト末尾に挿入 |

つまりプロンプトはハードコードされた文字列ではなく、**JS側で動的に組み立てて埋め込む**設計。

## 2. エージェントの「動き」を実際に制御している場所

- **`askLLM()`** (village.js:320-361): OpenRouter API(`gpt-5`)にhistory(systemプロンプト+直近10往復)を送って返答を取得
- **`parseReply()`** (village.js:363-369): 返答を正規表現で `SAY:` の文言と ```` ```javascript ```` ブロックのコードに分解
- **`evaluateCode(bot, code)`** (village.js:223-290): LLMが生成したJSコードを実際に動かす場所。`control_primitives/*.js`の生コード文字列 + 村専用ヘルパー(`villagePrimitivesCode`)+ LLM生成コードを**1つの非同期関数として`eval()`**し、最後に`act(bot)`を呼ぶ。45秒のタイムアウトあり

つまりLLMは「自由なJSコードを書く」のではなく、**事前に用意された関数(プリミティブ)を組み合わせて呼ぶだけ**という制約の中で動いている。これがVoyagerのコア発想(スキルライブラリ+コード生成)。

## 3. LLMが使える「道具」(スキル)

- `control_primitives/*.js` — 元のVoyagerが持っている汎用スキル(`mineBlock`, `craftItem`, `placeItem`, `killMob`, `smeltItem`, `useChest`など)。生のコード文字列としてファイルから読み込み、eval内に展開(village.js:34-38)

- `villagePrimitivesCode` (village.js:50-117) — このシナリオ専用に追加したヘルパー。`depositLogsToChest`/`withdrawFromChest`(チェスト排他制御込み)、`buildAssigned`(ブループリント座標へ自動設置、異物除去・再検証ロジック込み)
- `lib/skillLoader.js` — mineflayerの低レベルAPI(`bot.sleep`, `bot.fish`など)に安全ガードを追加するラッパー。`bot.loadPlugin`後に`inject(bot)`で適用(village.js:436)

## 4. 「ゲーム」固有のロジック(LLMには見せない部分)

- `generateBlueprint()` — 家の座標リストをコード側で生成し、各座標を建築家に割り振る(LLMはブループリントの座標計算をしない)
- `isPlacedNow()` / `remainingFor()` / `totalRemaining()` — 進捗判定。キャッシュを信用せず近くのボットの実ブロックで再検証(前回のバグ修正箇所)
- `turn()` (village.js:371-412) — ループの司令塔。完成判定・ターン数/時間制限のチェック、LLM呼び出し、結果実行、次ターンのスケジューリングをすべてここで行う
- `spawnAgent()` (village.js:414-485) — bot生成、プラグイン読み込み、**`bot.chat`の上書き**(ライブラリ内部の英語chatを握り潰し、`sayToChat`経由のLLM発言だけが実際に発声される、前回ログにあったバグ修正の実装箇所)

## 5. MineColonies Bridgeアーキテクチャ(別実験)

`minecolonies-bridge/` 以下に、mineflayerが接続できないForgeサーバーをLLMで操作するための別システムがある。詳細は同ディレクトリの`README.md`を参照。ここでは**他のClaudeが作業を引き継ぐために必要な知識**だけをまとめる。

### ファイル構成

| ファイル | 役割 |
|---|---|
| `VoyagerBridge.java` | Forge Mod本体。HTTP API(port 8089)を生やしてサーバーJVM内から直接MineColonies操作 |
| `council.js` | 複数のLLM「知事」ペルソナが交代でコロニー運営方針を議論・実行するメインループ |
| `supply_bot.js` | council.jsと並走し、全市民のオープンリクエストを6秒ごとに自動解決するサポートスクリプト |
| `social_appraisal.js` | P1特性・価値・関係・状態から援助判断と説明可能な寄与を計算 |
| `social_cognition.js` | P1から価値・動機・欲求・規範・対処・感情力学・goalをtrace付きで導出 |
| `social_appraisal_v2.js` | 詳細認知profileをhelp/refuseへ接続する実験的appraisal（v1が運用既定） |
| `persona_profile_report.js` | 生存市民の詳細profileと次元別分布をJSON出力 |
| `social_cognition_experiment.js` | 同一場面・同一乱数でappraisal v1/v2を比較 |
| `social_help_daemon.js` | 困窮検出→相手選択→実移動→既存食料移転を行うPhase 3 daemon |
| `social_action_queue.js` | 行動daemonから単一writerのsocial_observerへ結果を渡すappend-onlyキュー |
| `social_experiment.js` | 同一入力・同一乱数で4条件の援助判断を比較する反実仮想runner |
| `social_information.js` | trust・ペルソナ・TTLに基づくPhase 4局所情報伝播の純粋モデル |
| `social_information_runner.js` | 現在の社会グラフで情報到達率を複数seed比較 |
| `social_information_daemon.js` | `/threats`を構造化警報へ接続するshadow専用daemon |
| `building_registry.json` | block_id → Colonialパック blueprint パスのマッピング表 |

### Domum Ornamentum フレーム付きブロックの取り扱い(重要)

MineColoniesのblueprintには `domum_ornamentum:framed` のような**テクスチャ付き装飾ブロック**が含まれる。これは通常のアイテムと異なり、ItemStackのNBTトップレベルに `textureData` CompoundTag(テクスチャパス→素材ブロックのマッピング)を持つ。

建築家NPCがこのブロックをリクエストしたとき、`/resolveRequest` エンドポイントが行う正しい手順：
1. `/openRequests` の `materials[]` 配列から必要な**素材アイテム**を特定
2. `giveToCitizen` で素材を市民インベントリに投入
3. `/resolveRequest` を呼ぶ → 内部で素材を消費し `textureData` 付きの完成品をインベントリに挿入してからリクエストを OVERRULED にマーク

**やってはいけないこと:** `overruleNextOpenRequestOfCitizenWithStack()` はリクエスト状態を変えるだけで完成品をインベントリに入れない。完成品を入れずにこれだけ呼ぶと、建築家AIは「アイテムが手元にない」と判断して同一リクエストを再発行し続ける無限ループになる。(2026-07-01修正済み: `VoyagerBridge.java` の `handleResolveRequest` で素材消費後に `inv.insertItem` を追加)

### ファイル・ディレクトリ構成

```
/home/mine-admin/mc-server-forge/          ← Forge 1.20.1 サーバー本体
  run.sh                        ← Forge 標準起動スクリプト(直接使わない)
  start_server.sh               ← ★ 通常の起動エントリポイント
  stop_server.sh                ← ★ 通常の停止エントリポイント
  rebuild_bridge.sh             ← ★ Bridge mod ビルド & 配備
  cmd_pipe                      ← 名前付きFIFO(サーバーのstdin代わり)
  console.log                   ← サーバーログ(追記)
  mods/
    voyagerbridge-0.1.0.jar     ← Bridge mod 本体(ビルド成果物)
    minecolonies-1.20.1-*.jar
    structurize-1.20.1-*.jar
    blockui-1.20.1-*.jar
    domum_ornamentum-1.20.1-*.jar
    multipiston-1.20-*.jar
  config/
    minecolonies-common.toml    ← MineColonies 設定(creativeresolveは未設定)

/home/mine-admin/minecolon_sim/minecolonies-bridge/   ← Bridge mod ソース + エージェント
  VoyagerBridge.java            ← Bridge mod 唯一のソースファイル
    (src/main/java/com/voyagerbridge/)
  council.js                    ← ★ メインエージェント(LLM知事2人が議論してコロニー運営)
  supply_bot.js                 ← ★ 資材自動供給ボット(council.jsと並走)
  building_registry.json        ← 建物タイプ → block_id / blueprint / 職業 のマッピング表
  build.gradle / gradlew        ← Gradle ビルド設定(JDK17専用)
```

### 起動・停止手順

```bash
# ===== 通常起動 =====
cd /home/mine-admin/mc-server-forge
bash start_server.sh
# → サーバー起動 + Bridge 待機 + supply_bot + council が全部自動で立ち上がる
# → ログ: /tmp/supply_bot.log  /tmp/council.log

# エージェントなしで起動したい場合
bash start_server.sh --no-agents

# ===== 停止 =====
bash stop_server.sh
# → council & supply_bot を kill してから Minecraft サーバーに stop を送る

# ===== Bridge mod を改造した後の更新手順 =====
bash stop_server.sh
bash rebuild_bridge.sh   # JDK17 でビルド → mods/ に自動配備
bash start_server.sh

# ===== council だけ再起動したい場合 =====
cd /home/mine-admin/minecolon_sim/minecolonies-bridge
OPENROUTER_API_KEY=sk-... node council.js > /tmp/council.log 2>&1 &
```

### 環境メモ

| 項目 | 値 |
|---|---|
| サーバーポート | 25566 (vanilla は 25565 で別) |
| Bridge HTTP API | http://localhost:8089 |
| ワールド | スーパーフラット、y=-60 が地表 |
| JDK | `/opt/jdk-17.0.19+10`(ビルド用) / システムJDK21(サーバー起動用) |
| LLMモデル | `anthropic/claude-haiku-4.5` via OpenRouter |
| gamerule | doDaylightCycle=false, doWeatherCycle=false (start_server.sh が設定) |

### Bridge mod の HTTP エンドポイント一覧

| エンドポイント | メソッド | 主なパラメータ | 説明 |
|---|---|---|---|
| `/ping` | GET | - | 疎通確認 |
| `/status` | GET | - | 全コロニーの建物・市民情報をJSON返却 |
| `/place` | POST | x,y,z,block | 指定座標に hut ブロックを設置。既存建物と重複するとERROR |
| `/found` | POST | x,y,z,name | town hall をコロニーとして設立 |
| `/spawnCitizen` | POST | colonyId | 市民を1人追加スポーン |
| `/requestBuild` | POST | x,y,z | 建物に work order を発行(着工指示) |
| `/giveToCitizen` | POST | colonyId,citizenId,item,count | 市民インベントリにアイテムを直接挿入 |
| `/citizenInventory` | GET | colonyId,citizenId | 市民の現在所持品をアイテムID別に集計（読み取り専用） |
| `/transferCitizenItem` | POST | colonyId,fromCitizenId,toCitizenId,item,count,maxDistance | 近接する市民間で既存所持品を原子的に移転 |
| `/resolveRequest` | POST | x,y,z,citizenId | 市民のオープンリクエストを解決(textured blockは素材消費→完成品挿入→OVERRULED) |
| `/giveTexturedBlock` | POST | colonyId,citizenId,block,count,tex1,mat1... | Domum Ornamentum フレームブロックを合成して渡す |
| `/openRequests` | GET | x,y,z,citizenId | 市民の未解決リクエスト一覧 |
| `/clearCitizenInventory` | POST | colonyId,citizenId | 市民インベントリを全クリア |

### Bridge mod で手を加えた箇所とその理由

MineColonies/Structurize の API はほぼそのまま呼んでいるが、以下の点で独自ロジックを追加した：

**1. `/place` — 建物配置前の footprint 衝突チェック**
MineColonies 本体には `setBlockAndUpdate` 呼び出し時の重複チェックが存在しない。ある座標に新しい hut を置くと既存建物が静かに破壊される。さらに、破壊された座標に置かれた新建物は内部状態が壊れて `requestUpgrade` が work order を生成しなくなるという二次被害もある。そのため `/place` 内で `IBuilding.isInBuilding(pos)` を使った事前チェックを実装した。

**2. `/requestBuild` — builder hut の選択**
`IBuilding.requestUpgrade(player, builderPos)` の第2引数は「担当 builder hut の座標」。ドキュメントが存在しないため当初は target 建物の座標を渡していたが、builder hut 以外の建物では work order が作られないことで発覚。`colony.getServerBuildingManager()` から lv1+ の builder hut を検索して渡すよう修正。

**3. `/resolveRequest` — Domum Ornamentum フレームブロックの完成品配送**
`overruleNextOpenRequestOfCitizenWithStack()` はリクエストシステムの状態を OVERRULED にするだけで、アイテムを実際にインベントリに入れない。builder AI は「手元にない」と判断して同一リクエストを再発行し続けるループに陥る。素材消費後に完成品 ItemStack を `inv.insertItem` で直接挿入することで解決。

**4. `cmd_pipe` への書き込みに O_NONBLOCK**
Linux の名前付き FIFO は reader がいない状態で open しようとすると永久ブロックする。council.js のループが詰まらないよう `fs.openSync(path, O_WRONLY | O_NONBLOCK)` で開き、reader 不在時は ENXIO を catch してスキップするよう変更。

### なぜ `creativeresolve` を使っていないか

`minecolonies-common.toml` の `[requestsystem]` セクションに `creativeresolve = true` を設定すると `StandardPlayerRequestResolver` がリクエストを自動充足する。ただし**サーバー稼働中に設定を変更するとシャットダウン時に上書きされて消える**ため、変更は必ずサーバー停止中に行う必要がある。現状は `supply_bot.js` が同等の機能を担っているため設定していない。

---

## まとめ図

```
[システムプロンプト: buildSystemPrompt]  ←役割・ルール・利用可能関数の説明
        +
[毎ターンの状態: buildStateContext]      ←座標/持ち物/進捗/直近チャット
        ↓
   askLLM() → OpenRouter(gpt-5)
        ↓
parseReply() → { say, code }
        ↓
sayToChat(say)          evaluateCode(code) → eval(primitives + village専用helper + LLMコード + act(bot))
        ↓                          ↓
  実際のMinecraftチャット      実際のbot操作(移動/採掘/設置/クラフト/チェスト)
```

他のファイル(`lumber_team.js`, `house_build.js`, `pvp_duel.js`)もほぼ同型の構造で、システムプロンプトの内容とシナリオ専用ヘルパー(`villagePrimitivesCode`相当)だけが差分。
