# システム構成

自律コロニー実験は 3 つのレイヤーで動いています。

```
┌─────────────────────────────────────────────────┐
│  LLM 市長 (council.js) + 供給デーモン (supply_bot.js)│  … Node.js 常駐エージェント
│                        ↕ HTTP (port 8089)          │
├─────────────────────────────────────────────────┤
│  VoyagerBridge (Forge mod)                       │  … サーバー内 JVM
│                        ↕ Java API                 │
├─────────────────────────────────────────────────┤
│  MineColonies + Structurize + Domum Ornamentum  │  … 既存の街づくり mod
│                        ↕                          │
│  Minecraft Forge 1.20.1 サーバー                  │
└─────────────────────────────────────────────────┘
```

以下、下のレイヤーから順に説明します。

---

## 1. MineColonies mod

MineColonies は Minecraft 上に「町 (コロニー)」を作り、**市民 (colonist) と呼ばれる NPC に自律的に建設・生産・戦闘をさせる**街づくり mod です。プレイヤーの役割は都市計画者であり、実際にブロックを積むのは市民です。

### コロニー

- **町役場 (Town Hall)** を設置して "found" することで 1 つのコロニーが生まれる
- 町役場周辺のチャンクを自動で claim (領有) し、コロニー拡大とともに領域を広げる
- 町役場レベル (1〜5) がコロニー全体の "天井": すべての建物は町役場レベルを超えて成長できない
- 人口上限は「ベッド数 + 研究進捗」で決まる (基本 25 人、大学の研究チェーンで拡張)

### 市民

各市民は独立した NPC エージェントで、以下の内部状態を持ちます。

- **空腹** (0〜20): 労働で減り、食事で回復。住居レベルが高いほど食事の質要件が厳しくなる
- **幸福度**: 住環境・食・安全・過労から算出、生産性に影響
- **健康**: 病気になると病院と治療アイテムが必要
- **睡眠**: 夜は住居のベッドで寝る、労働は昼のみ
- **スキル**: Athletics / Dexterity / Focus 等 11 種。職ごとの主・副スキルが作業速度と品質を決める
- **住居と職場**: 通勤距離が短いほど生産性が上がる

市民の行動は **優先度つき状態機械** で決まります (病気 → 食事 → 睡眠 → 労働 → 余暇)。

### 建物と建設

- **小屋ブロック** (例: Builder's Hut) を置くと、その種類の建物がレベル 0 で生成される
- 実際の建設は **Work Order** として発行され、**建築家 (Builder)** が blueprint (Structurize が管理) 通りにブロックを 1 つずつ設置
- 建築家自身の建物レベルが施工可能な建物レベルの上限になる
- 建築家は自小屋から半径 100 ブロック以内・かつロード済みチャンクのみで施工可能
- 資材が不足すれば **Request (要求)** を発行し、下記のリクエスト経済で解決される

### リクエスト経済

コロニー内の経済ロジックは Request System と呼ばれ、リゾルバ連鎖で解決されます。

```
市民/建物が要求発行
    ↓
① 本人/建物内の在庫を探す
    ↓ なければ
② 倉庫 (Warehouse) を探し、配達員 (Courier) が搬送
    ↓ なければ
③ 対応するクラフター (Sawmill, Smeltery 等) が生産
    ↓ なければ
④ プレイヤー供給 (creativeresolve = true なら自動、この研究では下記の supply_bot が代替)
```

### 研究

- **大学 (University)** に研究者を配置して研究を進行
- 二層構造: 全コロニー共通の研究ツリー × 各コロニーの進捗状態
- **人口上限拡張** (keen → outpost → hamlet → village → city) や、建物・機能の解禁がここに紐づく
- 研究者が本棚を巡って実時間で進行、大学レベル = 同時進行スロット数

---

## 2. VoyagerBridge (Forge mod)

`mineflayer` などの標準的な LLM-Minecraft 連携ライブラリは Forge サーバーに接続できないため、独自の Forge mod をサーバー JVM 内に組み込む方式を採用しました。

### 役割

- **HTTP サーバーを起動** (port 8089) して LLM 側からのリクエストを受け付ける
- サーバー内部から MineColonies / Structurize / Domum Ornamentum の Java API を直接呼び出す
- 単純ラッパーではなく、既存 mod のバグ・落とし穴を吸収する層としても機能

### 主なエンドポイント (抜粋)

| エンドポイント | 用途 |
|---|---|
| `/ping` | 疎通確認 |
| `/status` | 全コロニーの建物・市民・在庫を JSON で返却 |
| `/citizenInventory` | 指定市民が実際に所持するアイテムと個数を集計 |
| `/transferCitizenItem` | 距離・在庫・受取容量を検証し、市民間で既存アイテムを移転 |
| `/place` | 指定座標に小屋ブロックを設置 (既存建物との衝突を事前チェック) |
| `/found` | 町役場をコロニーとして設立 |
| `/spawnCitizen` | 市民を 1 人スポーン |
| `/requestBuild` | 建物に Work Order を発行 (着工指示) |
| `/giveToCitizen` | 市民インベントリにアイテムを直接挿入 |
| `/resolveRequest` | 市民のオープンリクエストを解決 (Domum Ornamentum フレームブロックは素材消費 → 完成品挿入 → OVERRULED) |
| `/openRequests` | 市民の未解決リクエスト一覧 |
| `/surfaceY`, `/heightmap` | 地表 Y を返す (地形対応 placeNext 用) |
| `/tickrate` | サーバー tick 倍率を制御 (auto ガバナー付き) |

`/status`の市民情報には、社会行動の身体性を検証するためライブ位置も含まれます。

エンドポイント全体像は `IMPLEMENTATION_NOTES.md` またはメモリ `minecolonies-bridge-api` を参照してください。

### 特殊対応

MineColonies 本体のバグや癖に対して、bridge 側で以下のような補正を入れています。

- `/place` — 建物間の footprint 衝突を事前チェック (MineColonies 本体はチェックしないため、静かに既存建物を破壊する)
- `/requestBuild` — 全建築家 hut を検索して有効な builder を渡す (未指定だと Work Order が発行されない)
- `/resolveRequest` — Domum Ornamentum フレームブロックの完成品を実インベントリに挿入 (状態フラグを立てるだけだと建築家 AI が同じリクエストを無限再発行する)
- 適応 tickrate ガバナー — サーバー負荷 (mspt) を測定して自動で tick 倍率を調整

---

## 3. 外部エージェント層

### 社会シミュレーション層

- `persona_daemon.js`: 安定した個体IDにP1ペルソナと家系を対応させる
- `social_observer.js`: 同居・親子・職場などの関係グラフと、感情・信頼・義理の動的状態を更新する
- `social_help_daemon.js`: 困窮を検出し、関係者から援助者を選び、appraisalの判断根拠を保存する。実行時は
  援助者を相手まで歩かせ、所持している食料だけを移転する
- `social_cognition.js`: P1から価値、動機、欲求優先度、規範、対処、感情力学、意思決定傾向を
  寄与trace付きで導出する。これらは心理測定値ではなく比較実験用の操作的構成概念
- `social_appraisal_v2.js`: 詳細認知profile、関係、困窮、距離、資源を状況依存goalと予期感情へ変換し、
  help/refuseの各寄与を保存する実験モデル。未較正のため運用既定はv1
- `persona_profile_report.js`: 生存市民の認知profileと次元別の平均・標準偏差・最小・最大を出力する
- `social_cognition_experiment.js`: 同じ場面と乱数でappraisal v1/v2の確率的・決定論的判断を比較する
- `social_action_queue.js`: 行動結果をappend-onlyで受け渡し、observerがoffsetにより一度だけ関係へ反映する
- `social_experiment.js`: 同じ市民ペアを全員同一／ペルソナ／関係／時間的記憶の4条件で比較する
- `social_information.js`: 脅威警報を社会グラフ上で局所伝播し、受容・再伝達・経路を記録する
- `social_information_daemon.js`: `/threats`を読むshadow層。現段階では移動・戦闘命令を出さない

関係は対称な辺だけでなく、AからBへのtrust/affinity/obligationとBからAへの値を別々に持ちます。
これにより、援助を受けた側だけが強い信頼や返礼義務を持つ状態を表現できます。現在、援助daemonは
限定試験のみで、連続自動実行は係数較正前のため停止しています。Phase 3.5以降は相手別のgratitude、
resentment、援助・拒否履歴も保持し、感情はgameTimeに基づいて減衰、恩義は返礼行動で消費します。

詳細認知層はP1の7特性を正本のまま使うため、既存市民と遺伝履歴を変更しません。導出次元が増えても
独立な人格自由度が増えたとは解釈せず、各次元の入力と重みを追跡できる点を研究上の利点とします。

### LLM 市長 (council.js) と供給デーモン (supply_bot.js)

サーバー外部で常駐する 2 つの Node.js プロセスが実際の "統治" を担います。

### council.js — LLM 市長

- **市長ペルソナ**が定期的に「今のコロニーを見て、次に何をすべきか」を判断する
- 現在は 1 コロニー・1 市長ペルソナ (実験フェーズ次第で複数化予定 = 目標①)
- **入力**: `/status`, `/openRequests`, `/debugWorkOrders` から集めた現在のコロニー状態を JSON で渡す
- **出力**: 「この座標にこの建物を建てる」「この市民をこの職業に配属する」「この建物をアップグレードする」といった構造化コマンド
- **LLM**: 現在はローカル ollama サーバー (`192.168.15.150:11434`) の `gemma4:e4b` を使用。`think: false` + スキーマ強制 + メニュー選択方式で応答の暴走を防いでいる
- **建物配置 (placeNext)**: グリッドを走査してフットプリントごとに `/surfaceY` で地表 Y をサンプル → 代表 Y (mode) と平坦さ (max-min) を計算 → 平坦さゲートを通過すれば配置。水域は除外

### supply_bot.js — 供給デーモン

- 市民のオープンリクエストを 6 秒ごとに巡回し、未解決の物 (建材・食料・道具・種) を自動供給する
- MineColonies の `creativeresolve = true` 設定と同等の役割だが、サーバー再起動時に設定が消える問題を回避するため独立プロセス化
- **テーパー機能**: アイテムごとの生産経路の稼働を検知し、生産が立ち上がったアイテムは自動供給を停止 → コロニーが自前生産で回るようになる (自給自足への移行を仕組みで担保)

### colony_watch — 監視スクリプト

- サーバーとエージェントの死活を定期的にチェック
- 落ちていれば通知 (現状は監視 = 通知のみ、自動再起動は operator 判断)

---

## データフロー (1 サイクル)

```
1. council.js が /status を呼ぶ  → コロニー全体の状態を取得
2. council.js が LLM に問い合わせ → 次アクションの構造化コマンドを得る
3. council.js が /place, /requestBuild, /assignCitizen 等を呼ぶ
   → VoyagerBridge が MineColonies API を叩く
   → 市民 NPC が Work Order を受け取り、建設/生産を実行
4. supply_bot.js が /openRequests を巡回 → 不足資材を /giveToCitizen で補充
   (生産経路が稼働していれば、そのアイテムはスキップ = テーパー)
5. サーバー tick が進み、次サイクルへ
```

## ソースの在処 (要点)

| 対象 | パス |
|---|---|
| VoyagerBridge Java ソース | `minecolonies-bridge/src/main/java/com/voyagerbridge/VoyagerBridge.java` |
| council.js (市長) | `minecolonies-bridge/council.js` |
| supply_bot.js (供給) | `minecolonies-bridge/supply_bot.js` |
| 建物レジストリ | `minecolonies-bridge/building_registry.json` |
| MineColonies 本体ソース | [ldtteam/minecolonies](https://github.com/ldtteam/minecolonies) の `src/main/java/com/minecolonies/core/` |

より深い設計判断は [引き継ぎ](handoff.md) と、リポジトリ内の `DESIGN_DECISIONS_normal_world.md`, `IMPLEMENTATION_NOTES.md` を参照してください。
