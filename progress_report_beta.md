# 進捗報告(ベータ版・逐一更新)

> このファイルは作業の節目ごとに随時更新される「生きた」進捗報告。
> セッションの区切りで日付版(progress_report_YYYY-MM-DD.md)に整理・昇格する。
> 最終更新: 2026-07-07(日付版へ昇格・リセット)

## 2026-07-08〜: 並列エージェント運用 + 市長スキル化 + 職業マッチャー

方式B(私=ライブ系オペレーター / サブエージェント=offline調査)で並列作業:

- **市長プロンプト外部化**(短期): council.js のベタ書きプロンプトを `prompts/*.md` に
  スクリプト抽出。`{{NAME}}`等を起動時置換。**mayor-system スキル**も作成(私向けに
  設計思想・5つのガバナー・ollama設定を集約)
- **無職→適職マッチャー**(中期): ビルダーがMineColonies内部を逆コンパイル調査
  (11スキルenum・全職業スキルマッピング・API)→私が統合。
  - `GET /citizenSkills`(全市民11スキル値+無職フラグ)
  - `POST /autoAssignJobs`(fit=2×主+副でスキル最適マッチング。サーバー内で正確な
    モジュールに配属。戦闘/子供/学生/MANUAL枠除外)
  - **フォークA 再配属**: `reassign=true&threshold=N` で低fit労働者を高fit無職と入替。
    初回11件適用(改善+10〜+26。auto-hireの適当配属を是正)。supply_botが20サイクル毎
- **フォークB 建物増設**: 生産系15棟(builder×3・farmer×2・baker・crafter各種)を
  配置。新枠がフォークAのテスト台にもなる
- **重要な発見**: 無職52人 vs 開き枠1(標準auto-hireが適当に即雇用しレースに勝てない)。
  真のスキル最適化=再配属が必須と判明。人口飽和(158人・増加中)は別途要対処
- **tickrate適応ガバナー**は前回実装済み・稼働中(mspt実測で8〜10倍に自動調整)
- 事故: startチェーンを`&`で一括背景化しサーバーを道連れに(掟違反)→単独起動で復旧。
  colony_watch が検知・記録

## 直近の確定版

- **progress_report_2026-07-07.md** — 2026-07-03〜07 のまとめ(病気×飢餓スパイラル根治、
  施設検証スイート、市長の建設暴走ガバナー、builder作業半径・チャンクロード問題、
  クリーン監査達成、次フェーズ方針)
- **HANDOFF_2026-07-07.md** — 後続セッションへの引き継ぎ(最優先タスク:
  /assignHome デプロイ→辺境builderの引っ越し→建設停滞解消)

## 2026-07-07 午後: レシピ教示システム + 錬金術師整理(引き継ぎは4日目に延期)

- ユーザー指示で Fable 5 継続(あと4日)、引き継ぎ準備は最終日に実施
- **レシピ教示**(職業ブロックのGUI限定機能をbridge化、ユーザー要望):
  - `/teachRecipe`(RecipeStorage組立→全craftingモジュールにaddRecipe試行。
    容量式 **2^建物lv×研究倍率×canLearnManyRecipes(×5)** と職業別適合タグは
    ゲーム側の判定をそのまま使用)、`/recipes`(taught/max/一覧)
  - `crafter_recipes.json`: 7職種(sawmill/stonemason/stonesmeltery/blacksmith/
    glassblower/fletcher/mechanic)の優先順教示リスト
  - supply_bot が10サイクルごとに自動教示(満杯で停止→レベルアップで自動再開)。
    実測: sawmill 8レシピ、stonesmeltery は製錬レシピがSmeltingModuleへ正しく振り分け
- **錬金術師整理**(ユーザー指摘「多すぎ」): 41棟→未建設23棟撤去(work order 64→40)、
  建設済みlv1-2の15棟は `/setHiringMode MANUAL+fire` で退役(構造物は温存)、
  lv5×3棟のみ稼働継続。就労18人→3人、15人が求職プールへ
- `/assignHome` デプロイ・稼働: 辺境builder 7人中3人を職場近くへ引っ越し
  (残り4人は近隣住宅が全満室 — 新築完成後に再試行)

## 2026-07-07 夜: 錬金術師偏愛の解明 + 死んだ職場の一斉活性化

- **なぜ市長は錬金術師を88回建てたか(ユーザー依頼の調査)**:
  gemma e4b は「農場が最優先!」と発言しながら choice 3 を選ぶ**低番号位置バイアス**があり、
  building_registry.json がアルファベット順で **alchemist が常に新設候補の先頭**だったため
  共振した。対策: メニュー候補を wait 以外シャッフル(バイアスを均一化)
- **実働率サンプラー work_stats.js**: 単発スナップショットは嘘をつくので複数回計測。
  初回計測で「全builderがINVENTORY_FULL(45/45スロット)で凍結」を発見 →
  真因: 一括納品がラックを満杯にし、CLEARステージの掘削デブリの捨て場が消滅
  (中央lv5ハットは大容量で潜伏、lv1辺境ハットで顕在化)。
  修正: **rack janitor**(資材リスト外の在庫を掃除)+ **荷下ろし予約9スロット**
- 孤児化した道具リクエスト(overrule false)は `requestsystem-reset` で救済
- **死んだ職場の活性化**:
  - 牧畜4種8棟: superflatに動物ゼロ → 各ハットに繁殖用4匹をsummon → 全稼働
  - composter: compostablesリスト空 → 汎用 `/setItemList` 新設で7品登録
  - 大学idle: 残研究は軍事建物ゲート(barracks lv4+等)待ちで**正当**(建設中)
  - miner: superflat死に職(既知)、hospital/cook: 需要なしidleは正常
- **クラフター経済の起動**(最重要の構造修正): 教示済みレシピ品を
  ①builder一括納品から除外(fillの `skip=` パラメータ)
  ②リクエストも3分間cheat解決を保留 → resolverがcrafterに製造を回し、courierが配達。
  間に合わない時だけcheat供給が介入(建設は止まらない)。
  チート供給は「原材料の供給源」へ後退し、中間経済が本物になる

## 現在の状態スナップショット(2026-07-07)

- コロニー: 203棟 / 市民118人 / 建設待ち64件(通勤問題で停滞中 — HANDOFF参照)
- 常駐系: council(常駐化済み)+ supply_bot + colony_watch.sh(セッションごと要再アーム)
- 運用ガイド: /root/CLAUDE.md(セッション開始チェックリスト・鉄の掟)
