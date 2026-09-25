# 進捗報告:MineColonies bridge 実験 — バグ根絶と LLM 市長の本稼働

## 1. 課題の背景と目的

LLM エージェント(市長)が MineColonies コロニーを自律運営する実験基盤。mineflayer は Forge サーバーに接続できないため、サーバー JVM 内に HTTP API を生やす自作 mod(VoyagerBridge、port 8089)経由で操作する構成。

本日の目的は、(1) 前セッションから持ち越した3バグ(建物フットプリント重複・builder への仕事の偏り・10倍速中のプレイヤーキック)の修正、(2) コロニー成長の再開、(3) LLM 市長会議(council.js)による自律運営の開始だった。

## 2. 実施した内容

### 2.1 持ち越し3バグの修正(全て検証済み)

| # | バグ | 原因 | 修正 |
|---|---|---|---|
| 1 | 自動配置(placeNext)した建物が既存建物と重複 | `getCorners()` がセーブ内の縮退値を返す+配置時の向きで rotation がずれ、想定フットプリントと実物が不一致 | 縮退検出時に `calculateCorners()` で自己修復。配置時に blueprint アンカーの BlockState をコピーして rotation を 0 に固定 |
| 2 | 建設依頼が1つの builder hut に集中 | jobStatus は着工まで "idle" のままなので idle 優先選択が機能しない | claimed work order 数が最少の hut を選ぶ方式へ。既存の偏りは新設 `/rebalanceWorkOrders` で再配分 |
| 3 | 10倍速中に実プレイヤーがキックされる | vanilla の tick カウンタ式タイムアウト(浮遊判定・ログインハンドシェイク)が10倍で進む | multiplier>1 の間、該当カウンタをリフレクションで毎 tick リセット |

### 2.2 「Annika 型 wedge」の根本解明と修正

builder の Annika が `LOAD_STRUCTURE→START_BUILDING→BUILDING_STEP→LOAD_STRUCTURE` を5秒周期で無限ループする問題を bytecode 解析で追跡。原因は **`/rebalanceWorkOrders` が work order の `claimedBy` だけを書き換え、旧 hut がキャッシュする workOrderId・進捗・資材リストと、worker AI が握る structurePlacer を残置**していたこと(建物と AI が別々の work order を見る分裂状態になり、資材判定が永遠に RECALC を返す)。

修正: claim 移動前に公式のクリーンアップ経路 `AbstractBuildingStructureBuilder.onWorkOrderCancellation()` を呼ぶ。診断用に `/debugWorkOrders`(全 work order の claim/stage/blueprintLoaded をダンプ)も追加。修正後、Annika が Mine の建設を開始することをゲーム内でも確認した。

### 2.3 病気の自動治療

市民が病気(インフルエンザ等)になると病院がない限り永遠に待機する問題に対応。`/status` に `sick`/`disease`/`cureItems` を追加し、supply_bot が治療アイテムを自動配達(全アイテムが本人のインベントリに揃うと自己治療する仕様を利用)。1回のポーリングで4人のインフルエンザ治療を確認。

### 2.4 LLM 市長会議(council.js)の本稼働

- **OpenRouter 402 の解明**: `max_tokens` 未指定だとモデル最大値(64k)で残高チェックされ、残高が少ないと全呼び出しが 402 になる。市長は「稼働しているように見えて一度も意思決定していなかった」。`max_tokens: 1000` を明示して解決。
- **節約モード**: 残高が少ないため、サイクル間60秒+市民ボイスは3サイクルに1回(ユーザー決定)。
- **中期フェーズのルール追加**: hospital 等の研究ゲート(University 必須)、中期優先順(university→mine→住居→builder hut 自己アップグレード)。
- 稼働確認: ガバナー(Aldric/Mira)の合議がゲーム内チャットに流れ、待機判断や食堂(cook)の発注など状況に応じた意思決定を実行している。

### 2.5 職業別の環境整備(スーパーフラット対応)

- **木こり**: 世界に木が1本もなく `LUMBERJACK_NO_TREES_FOUND`。`place feature minecraft:oak` で hut 周辺にオーク9本を植樹 → 伐採開始(`LUMBERJACK_CHOP_TREE`)。
- **釣り人**: 水深2ブロックが必要(ユーザー指摘)だが、blueprint を NBT 解析した結果 **fisher1 の池は設計自体が水深1(107セル)** と判明。全セルの直下(y=-62)に注水して水深2化 → 釣り開始(`FISHERMAN_START_FISHING`)。blueprint のブロック配列デコード方法(y→z→x、上位short先)も確立した。

### 2.6 空腹市民への自動給食(世話役エージェントの第一歩)

空腹の市民は食料を探しに行き作業が長時間止まる(食堂が未建設のため)。本日3回手動でパンを配った作業を自動化: `/status` の市民情報に `saturation`(0〜20)を追加し、supply_bot が満腹度8未満の市民にパン8個を自動配達する(市民1人あたり10分クールダウン)。稼働直後に全8市民への配達を確認。

### 2.7 運用基盤の整備

- **skills(手順書)の導入**: `deploy-bridge`(ビルド→配備→再起動→ヘルスチェック)と `colony-diag`(市民停止の診断ランブック)を `.claude/skills/` に作成しリポジトリ管理。他の LLM ツール向けに `AGENTS.md`(入口ファイル)と `LLM_SKILLS_GUIDE.md`(運用ガイド、raw URL 込み)も追加。
- **常時10倍速の運用ルール化**(ユーザー指示)。正しい手順は `POST /tickrate?multiplier=10`(コンソールコマンドではない。cmd_pipe に送ると `<--[HERE]` 付きの不明コマンドエラーになり、これを成功と誤読していた事故を修正)。

## 3. 検証結果とコロニー現況

| 項目 | 結果 |
|---|---|
| フットプリント重複 | ✅ 6件の縮退 corners が自己修復、重複せず配置。ユーザーもゲーム内確認 |
| builder 負荷分散 | ✅ 新規依頼が最少 claim の hut に割当。5 hut に1件ずつ分散 |
| 10倍速キック | ✅ ユーザーが10倍速中にジャンプ・再ログインしても切断されず |
| Annika 型 wedge | ✅ 修正版デプロイ後、Mine 建設開始。ユーザーもゲーム内確認 |
| 市長会議 | ✅ 402解消、待機/発注の合議をゲーム内チャットで確認 |
| 木こり/釣り人 | ✅ 両者とも作業状態に遷移(CHOP_TREE / START_FISHING) |

コロニー現況(16時時点): 市民8人全員就業(builder×5・釣り人・警備・木こり)、建物13棟稼働+4件建設中(tavern・house×2・mine)。cook(食堂)を市長が発注済み。新規建物の稼働には人口増(=住居)が必要で、市長がその方針を出している。

## 4. 未解決の課題

- **人口がボトルネック**: cook・miner・deliveryman は完成しても働き手がいない。住居建設と tavern 経由の人口増待ち。
- **hospital は研究ゲート**: University 未建設のため requestBuild 不可(placeNext は通ってしまう点に注意)。
- **OpenRouter 残高が枯渇し市長会議は停止中**: 16:30頃、入力プロンプト(約19k tokens)すら残高上限(5395)を超えて 402 になったため council.js を停止した。クレジット追加後に再起動すれば再開できる。プロンプト自体の減量(状態JSONの圧縮・履歴短縮)も中期課題。
- **council.js の常駐化未実装**: MAX_CYCLES=300(約5時間)で自然終了する。
- **未調査ログ**: `Failed to get rotation of building at pos: 212,182 / 150,170 with path:(空)` — 市長が発注した建物で発生。実害は未確認。
- **miner がほぼ死に職(ユーザー指摘)**: スーパーフラットのため掘る地層も鉱石も存在しない。(a) スーパーフラットのカスタムプリセットで地層を深くする(鉱石が生成されるかは要検証)か、(b) 通常ワールドへ移行する(今後の研究の本命だが placeNext の平地前提ロジックの見直しが必要)のどちらかをワールド再生成込みで決める。
- **軽微な残件**: 初期 builder hut 2棟の5列重複(稼働中のため放置)、旧リポジトリのアーカイブ(GitHub UI 手動操作)。

## 5. 今後の計画

### 短期
1. 市長セッションの経過観察(暴走・402再発・建設進捗)
2. tavern・住居完成→人口増→cook/miner/deliveryman の自動雇用を確認
3. University 建設→hospital 解禁
4. 食料自動化(cook 稼働 or supply_bot への給食追加)

### 中期
5. **世話役(caretaker)エージェント**(ユーザー発案・メモ保存済み): 市民の困りごと(木がない・水深不足・空腹・病気・stuck)を検知してゲーム内で自動解決する常駐デーモン。今日手動でやった植樹・注水・給食がそのまま自動化対象。給食は本日実装済みで、これが第一歩
6. council.js の常駐化(start_server.sh での再起動ラッパー)とプロンプト減量
7. council.js のプロンプト肥大化対策として、MineColonies 知識をfine-tune した小型モデルの検討(既存メモあり)

## 6. 変更ファイル一覧(コミット、いずれも origin / fork 両方に push 済み)

| commit | 内容 |
|---|---|
| `647d940` | 持ち越し3バグ修正(フットプリント・負荷分散・キック抑止) |
| `ace1496` | 病気自動治療(/status の sick 情報 + supply_bot 治療配達) |
| `e20edde` | skills(deploy-bridge / colony-diag)・AGENTS.md・LLM_SKILLS_GUIDE.md 追加 |
| `a64603a` | Annika 型 wedge 根本修正(onWorkOrderCancellation)+ /debugWorkOrders |
| `080aba2` | skills の tickrate 手順修正(HTTP エンドポイントが正) |
| `492d635` | council.js: 402修正(max_tokens)・節約モード・中期ルール |
| `901cc29` | colony-diag: 木こり/釣り人の環境要件を追記 |
| `b5ce51c` | 本進捗レポート追加 |
| `dbdf600` | 空腹市民への自動給食(/status に saturation + supply_bot 給食ロジック) |
