# 通常ワールド移行 — 設計決定書 (2026-07-11 方針決めセッションで確定)

このセッションでユーザーと逐一詰めた設計決定。**次セッションの並列エージェント実装の仕様書**。
上位方針は HANDOFF_2026-07-10.md「更新 2026-07-11」節、メモリ minecolonies-next-phase-plan。

## 確定した設計決定

| # | 論点 | 決定 |
|---|---|---|
| D1 | 世界生成 | **plains-spawn seed で平地寄り**。通常ワールド(地下に石層・鉱石、周囲に水・木)。seed 値は operator が実測選定(下記) |
| D2 | placeNext 骨格 | **表面Yサンプル + 平坦さゲート + builder整地**、急斜面のみ terraform フォールバック(D5) |
| D3 | チート供給 | **ブート後テーパー**。序盤手厚く→生産立ち上がり検知後は demand.json 連動でギャップ埋めのみ |
| D4 | 並列分割 | **4エージェント**(A heightmap / B placeNext / C terraform / D supply)。依存 A→B→C、D独立 |
| D5 | terraform | フォールバック限定。平坦さゲートを通るセルが探索範囲内に無い時だけ footprint を setblock で平坦化 |
| D6 | 人口ハードキャップ | **保留**(通常ワールドの実挙動を見てから)。当面は住居バランスガバナーの自己是正に任せる |
| D7 | 既存superflatコロニー | **停止のまま据え置き**(再起動しない=常駐監視不要)。別ディレクトリworldとして退避保存 |
| D8 | 市民ペルソナ/SNS(目標③) | 通常ワールド移行の**後**。今フェーズ対象外 |

### D2 の細目(トレードオフ小につきAI既定、実装で調整可)
- 代表Y = **フットプリント内 surface Y の最頻値(mode)**。整地量が最小になる。多峰なら中央値(median)に退避。
- 平坦さ指標 = **フットプリント内の max-min surface Y 差**(段差の高さ)。閾値 T を超えるセルはスキップし次グリッドへ。
- 流用: 既存のフットプリントテーブル、builder作業半径100、groundlevelタグY補正、isInBuilding衝突判定。
- **閾値 T は経験的**。operator の builder整地テスト(下記)で「綺麗に整地できた最大段差」に設定。

### D3 の細目
- テーパー発火 = **アイテム単位の生産検知**(そのアイテムの生産経路が稼働)**＋ 時間フロア**(Nゲーム内日より前は絞らない=序盤失速の保険)。
- 計測フック = 既存 `work_stats.js` を流用(worker出力 / 倉庫在庫デルタ)。
- log は **苗木ブート分だけ供給**し lumberjack の植林(replant)ループに乗せる(plains は樹木が疎なため)。

## 並列エージェントのタスク仕様 (D4)

各エージェントは隔離 worktree・狭スコープ・コード生成のみ。**ライブ系に触らない**。operator(統合セッション)が
受け取り直列にデプロイ(deploy-bridge skill、サーバー1台)。bridge Java は **Mojangマッピング**でコンパイル。

### Agent A — bridge 地表Yサンプル API 【基盤・他の前提・依存なし】
- スコープ: VoyagerBridge に地表Yを返す HTTP エンドポイントを追加(例 `/surfaceY?x&z` 単点、`/heightmap?x0&z0&x1&z1` 矩形バッチ)。
- 実装: `level.getHeight(Heightmap.Types.WORLD_SURFACE, x, z)`(Mojangマッピング)。矩形はグリッドJSONで返す(フットプリント一括サンプル用)。
- 未ロードチャンク対策(forceload 済み範囲前提 or chunk load)を明記。
- 受け入れ: 稼働中worldで既知座標の地表Yが正しく返る/矩形が全グリッド返る。

### Agent B — 地形対応 placeNext 【本丸・Agent A 依存】
- スコープ: placeNext を「候補グリッドセルごとに /surfaceY でフットプリントをサンプル→代表Y(mode)算出→平坦さ(max-min)算出→
  T以下ならそのYにアンカー配置、超なら次セルへ」に改修。探索範囲内に配置可セルが無ければ terraform フォールバック(Agent C)を呼ぶ。
- 入力: Agent A の API。既存フットプリントテーブル・衝突判定。
- 受け入れ: plains テストworldで緩起伏上に正しいYで配置、浮き/埋没なし。平坦さゲートが段差セルをスキップ。

### Agent C — terraform フォールバック 【Agent A/B 依存】
- スコープ: 平坦さゲートを通るセルが無い footprint に対し、代表Yへ setblock で削り/埋め(上を削り下を土等で埋める、Y補正尊重)し
  平坦パッドを作ってから配置。**フォールバック限定**、使用頻度をログ。
- 受け入れ: 急斜面に強制配置した建物が綺麗なパッド上で建つ。多用されない。

### Agent D — supply_bot テーパー + 生産検知 【独立・即着手可】
- スコープ: work_stats.js / supply_bot.js を拡張。アイテム単位の生産検知→生産経路が稼働 かつ 日数≥フロア のアイテムは
  主供給を停止、demand.json 経由で生産経路ゼロのアイテムのギャップ埋めのみ残す。供給→安全網の遷移をアイテム単位でログ。
- 受け入れ: miner/lumberjack/farmer 立ち上がり後、自給アイテムの供給が落ち、コロニーは自前生産で建設継続。未生産アイテムは埋まる。

## operator(統合セッション)が直列でやること
1. **新world構築**: plains-spawn seed を実測選定(候補seedで生成→spawnがplainsか目視、違えば seed 変えて再生成)。
   サーバー停止→旧world退避(`mv world world_backup_<epoch>`)→server.properties を newworld テンプレへ書換→起動→plains確認。
2. **founding ブートストラップ**: spawn近くの平坦地を目視で選び town hall を置く→`/place blockhuttownhall`→`/found`→
   ANCHOR_*/FORCELOAD_C* を town hall 実座標に設定→council/supply_bot/colony_watch 起動。1スクリプト化推奨。
3. **builder整地テスト(D2閾値の確定)**: 既知の緩斜面・段差(1/2/3ブロック)にテスト建物を置き、builderが浮き/埋没を残さず
   完成するか目視＋verify_suite で確認。綺麗に整地できた最大段差=閾値T。それ超はterraform要と判断。
4. **直列統合/デプロイ**: A→B→C の順、D は独立に。deploy-bridge skill。並列agentにデプロイさせない。

## 下ごしらえ(2026-07-11 済み・後方互換)
- 座標パラメータ化: council.js COLONY_ID/ANCHOR(env ANCHOR_X/Y/Z)、verify_suite.js COLONY_ID、
  start_server.sh forceload(env FORCELOAD_CX/CZ/R)。既定は旧値を再現、検証済み(commit f31ec27)。
- `newworld.server.properties.template` 作成済み(level-type=normal 差分 + 移行手順)。
