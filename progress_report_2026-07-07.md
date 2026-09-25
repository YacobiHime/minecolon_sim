# 進捗報告 2026-07-07(2026-07-03〜07 のまとめ)

> ベータ版から昇格した確定版。この期間の無人運転で発見・根治した問題群と
> 次フェーズ方針を含む。後続セッションはまず HANDOFF_2026-07-07.md を読むこと。

## 2026-07-04 昼: 病気×飢餓スパイラルの根治(33人中23人が病気)

無人運転中にインフルエンザが23人まで蔓延しコロニーがほぼ停止。逆コンパイル診断で
悪循環を特定し、その場の治療と supply_bot の恒久修正で**病人ゼロまで完全回復**した。

- **メカニズム**(CitizenAI/EntityAISickTask/EntityAIEatTask/FoodUtils を CFR で逆コンパイル):
  1. 非guard職は SICK 状態が EATING より優先 → 病気の間は食事不能で満腹度0に張り付く
  2. supply_bot が食べられない病人にパンを配り続け → インベントリ満杯
  3. 治療アイテム配達が `gave 0/1` で弾かれるが、bot は結果を見ず「配達済み」扱い → 永遠に病気
  4. 病人が食堂周辺に密集 → 感染拡大
- **恒久修正**(supply_bot): ①治療配達は `gave X/Y` を検証、部分配達なら
  インベントリ掃除→再配達 ②病人への給食はスキップ ③給食をパン→cooked_beef に変更
  (canEatLevel: 住居lv3+ は栄養値≥lv+1 が必要。パン(5)は lv5 住居の市民に食べられない)
- **病院を建設**(128,-60,241, lv1, healer 雇用済み) — 病人がベッドで治る本来の経路も開通
- **副次発見**: 座席なし食堂(Colonial cookery1 に sit_in/sit_out タグなし)の実害が確定。
  健常市民はフォールバックで食べられるが、**guard職(EATING優先)は WAIT_FOR_FOOD に
  永久に固まる**。メニュー食品を直接渡せば脱出する。診断手順は colony-diag skill に集約
- 前回残の research 要件エクスポート(bridge の /research に requirements/blocked)を
  ビルド・デプロイ・検証。council のアップグレード候補ラベルに「lvN で研究Xが解禁」を表示
- 研究は無人運転で 141/206 完了。残り65は大学 lv5 が必要な深層のみ(大学は lv4)
- council.js(ollama市長)re稼働、tickrate 10x 復帰、supply_bot 1プロセス確認

## 研究の最終目標(2026-07-03 確定)

1. **戦争**: MineColonies のコロニーを2つ立てて争わせる
2. **狭小空間の発展**: コロニーを狭い範囲に制限し、効率的発展を観察
3. **SNS連携**: 各市民エージェントがゲーム内の出来事を OASIS 等のSNSシミュレーション上で発言

本質は社会シミュレーション。当面は「1コロニーで全施設を建てて正常動作を確認できる」基盤づくりを優先する。

## 2026-07-03 のハイライト

### LLM市長会議を OpenRouter → ローカル ollama に移行
- 残高問題が消滅。gemma4:e4b(研究室サーバー 192.168.15.150)で稼働
- 小型モデル対策: think:false 必須 + JSONスキーマ強制 + **メニュー選択方式**
  (JSが status から実行可能アクションの番号付きリストを生成、LLMは番号を選ぶだけ。
  座標・IDの捏造が構造的に不可能になった)

### 職業ブロックのGUI操作を bridge エンドポイント化
- **食堂メニュー登録**(/setMenu): 食堂稼働後、市民はメニュー登録済みの食品しか
  食べない仕様が判明(未登録だと全員絶食)。登録で解決
- **畑の種指定**(/setFieldSeed, /fields): 種未指定だと農民が働かない。指定で就労開始
- 調査レシピ確立: GUI操作は network/messages/server/ のメッセージクラスから
  サーバー側APIを特定 → bridge化

### 資材供給の効率化(ユーザー要望)
- **一括納品**(/fillBuilderResources): work order の残り資材リスト全体を builder hut の
  ラックへ一度に納品。「1品目ずつ要求→配達」の往復を撤廃
- 個別配達は要求数ぴったりに修正(旧: 最低64個渡して過剰供給)

### 10倍速不具合の根本解決(3件)
1. **永遠の正午問題**: doDaylightCycle=false でコロニー日付が進まず、日付ベースの
   スケジューラ(農家の畑ローテーション)が死んでいた → true に恒久変更。
   農家の「耕す→植える→収穫」の日次サイクルを3日連続で実測確認
2. **無人時のコロニー休眠**: プレイヤー不在だとコロニーが UNLOADED になり
   work orderバインド・日付・リクエスト処理が全停止(市民は歩くので気づきにくい)
   → bridge の keepColoniesActive() が無人時に状態機械をACTIVEへ強制。
   無人状態で builder のバインド→建設進行→日付進行を実測確認
3. **実時間/ゲーム時間のずれ**: supply_bot の給食クールダウンをゲーム時間基準に
   (10倍速なら実時間1分)+食堂ラックへメニュー食を自動補充(/stockRestaurant)

### 診断基盤(恒久資産)
- /debugCitizenAI(市民がWORKに入らない理由)、/debugFarm(畑スケジューラ内部)、
  /debugBuilder(work orderバインド条件)
- colony-diag skill に全落とし穴を集約(食堂絶食・種未指定・日付凍結・コロニー休眠)

### 運用
- アドバイザー(Fable)+エグゼキューター(Sonnet)体制を試行→トークン節約にならず撤回
- 夜のモンスター: 対策せず観察方針(シミュレーションの一環)

## 施設検証スイート Phase 1(2026-07-04 稼働開始)

- `verify_suite.js`: /status の全建物を PASS/WARN/FAIL で採点する監査ハーネス
  (pending=WARN、未稼働/無人の職業建物/病気・飢餓の担当者=FAIL。無人が正常な
  建物種と「スーパーフラットでminerは死に職」は例外扱い)
- 初回実行: PASS 31 / WARN 9 / FAIL 12(52棟)。FAIL 12件は全て
  「councilがハットを置いたが建設発注が無い」建物 → その場で全12件 requestBuild 発行
- 未設置の建物タイプは26種(baker, blacksmith, sawmill, library, school,
  barracks系, composter ほか)。Phase 2 = これらを系統的に
  設置→建設→/assignWorkerで雇用→働くか判定、まで自動化する

## 2026-07-06: 大学「穴の底」問題の根治 + Phase 2 開始

- **ユーザー指摘**: 大学が地表より低い岩盤ギリギリの穴に建ち、落ちたら出られない
- **原因**: placeNext が全建物のアンカーをタウンホールと同じ高さ(地表)に置いていたが、
  blueprintのアンカー高さは設計ごとに違う(groundlevelタグ: 通常ハット=-1、library1=-3、
  university1=-7)。大学は6ブロック沈み、地上階が岩盤(-64)に落ちて周囲が掘削された
- **修正**: `Y = center.getY() - 1 + BlueprintTagUtils.getGroundAnchorOffset(blueprint, 1)`。
  実地検証: library=-58 / school=-60 / bakery=-61 と blueprint ごとに正しく補正
- 既存大学は移設せず**脱出階段**(x=139, z=260-262 の土階段)で転落対策のみ
- 探索半径 100→200(60棟で円盤が満杯になり blacksmith が置けなくなったため)
- **ついでに判明**: コロニー領土はガードタワー専用ではなく**全建物が周囲1〜2チャンクをclaim**
  (lv4-5は半径2、ガードタワーはlv5で半径5)。創設時に半径4チャンク。上限はconfig
  maxColonySize=20チャンク
- **Phase 2 第1陣**: library(-58,大学lv5研究の要件), school, baker, sawmill,
  stonemason, blacksmith, composter の7種を設置+建設発注、rebalanceで5 builderに分散
- 市民 33→56人に急増(食事修正の効果で住居容量まで回復中)

## 2026-07-06 午後: 無人運転体制 + 倉庫増強

- **倉庫満杯(ユーザー指摘)** → GUI限定の「エメラルドブロックでラック増強」機能を
  bridge化(`/upgradeWarehouse`、本来1回=エメラルドブロック1個・最大3回・建物レベル別枠)。
  実行して 0→3(最大)、125ラックの容量を増強
- **無人運転監視**(colony_watch.sh、常駐Monitor): bridge死活、supply_bot/council の
  死活+自動再起動(councilはMAX_CYCLES=300で自然終了するため)、病気>5・飢餓>10 の
  しきい値警報、keepColoniesActive失敗検知、1時間ごとに verify_suite 監査ハートビート
- 初回ハートビート: citizens=56 sick=0 starving=1 | PASS 57 / WARN 2 / FAIL 9(68棟)
  (FAILは建設待ちの新設ハット中心。builderが順次消化中)

## 2026-07-06 深夜: 「消えるwork order」の根治(辺境チャンクのclaim問題)

- 症状: sawmill(コロニー西端)の requestBuild が5回連続で音もなく消える
- 診断: `/debugBuildGates` を新設して全ゲートをダンプ → **フットプリントが触れる
  chunk(5,12) が owner=0**。WorkManager.isWorkOrderWithinColony が「全チャンク所有」を
  要求し、違反時はプレイヤー向けメッセージのみで捨てる(ログなし)
- 根本原因は3段重ね:
  1. bridge設置では onPlacement の claimBuildingChunks が例外で不発(pack/path未設定時に
     calculateCorners が転倒)
  2. 後追いの ChunkDataHelper 再claimも不発: アンロードチャンクは「次回ロード時適用」に
     先送り(無人の辺境は誰も踏まない=永遠に来ない)
  3. 同期 getChunk() 直後でも WorldUtil.isChunkLoaded は visible holder map 参照で false
- 修正: 設置時と requestBuild 時に対象チャンクを強制ロードし、CLOSE_COLONY_CAP に
  addBuildingClaim を直接書き込む(owner未設定なら所有権も付く)。sawmillで実証、
  work order が CLEAR ステージまで進行
- 監視ループの自己修復も実戦投入: council(MAX_CYCLES自然終了)を3回自動再起動

## 2026-07-06 続報: 市長の建設暴走と2つのガバナー

- maxLevel対応後、市長(gemma e4b)が「毎サイクル全タイプのplaceNextが提示される」メニューで
  重複設置を332回選択 → **建物78→192棟(住居65, alchemist38, archery10…)、
  work order 130件**の暴走が発生。「構造的に合法=戦略的に正気」ではないことが実証された
- council.js に2つのガバナーを実装:
  1. **バックログ制御**: 建設待ち ≥ 稼働builder×3 の間は建設系候補をメニューから全消去
  2. **重複禁止**: placeNext は「コロニーに無いタイプ」のみ提示(住居は容量不足時の専用候補、
     意図的な重複はオペレーター側の操作に分離)
- 積まれた130件は10倍速で数時間で消化見込み。設置済み重複建物の撤去はユーザー判断待ち
- 食歴システムの完全解明も同日: diversity要求=住居lv(lv5は6種以上)、quality要求=lv-2。
  supply_bot は tier3栄養9 の8種ローテーションに(市民16の再飢餓 sat0→19.5 で実証)

## 2026-07-06 夜: builder作業半径問題の全面解決(ユーザー判断: 増設で対応)

- **第2の停滞**: rebalance後もWARNが2時間不動 → builderは動くのに建てない。真因は2つ:
  1. builderの作業半径はハットから**100ブロック**(WorkOrderBuilding.canBuild)。
     bridge側の自動割当が距離を見ておらず、圏外orderがハットに束縛されキュー凍結
  2. **建設地のチャンクがアンロードだとbuilder AIは無言で待機**。無人運転の辺境は
     誰も踏まないので永遠にロードされない(forceloadで即回復するのを実証)
- 恒久修正: rebalance/requestBuildの距離対応(圏外はunclaim+エラー)、placeNextの
  「builder hutから90ブロック以内」配置ガード、**バインド中work orderのチャンクを
  自動force-load**するkeepBuildSitesLoaded(完了で解除)
- **圏外93棟への対応(ユーザー指示: 撤去せず増設)**: builder hutの自己建設例外
  (canBuildIgnoringDistanceのbuilderLocation==location)を使い、**フロンティアの
  クラスタ中心7か所にbuilder hutを直接設置→自己建設**。全93件を半径88でカバーする
  配置をフットプリント回避付き貪欲法で計算。全7棟にbuilder配置済み、
  lv1到達後にrebalanceで93件を自動配分するウォッチャー稼働中
- 中心180ブロック圏は建物飽和(gap=1でも空き5か所)— 今後の拡張はフロンティア
  builder hutを起点に外へ伸びる構造になった

## 2026-07-06 深夜: 初のクリーン監査達成

- **FAIL 0 / 病人 0 / 飢餓 0**(PASS 139 / WARN 64=建設進行中のみ、203棟・118人)
- 本日の無人運転で検知→根治した問題群: 病気×飢餓スパイラル(治療配達検証)、
  座席なし食堂、canEatLevel/食歴diversity/quality の3層食品ゲート、高消費職の配給量、
  placeNextのY補正、builder作業半径100、建設地チャンクのアンロード停滞、
  チャンクclaimの先送り消失、市長の建設暴走(ガバナー2種)、tavern等のmaxLevel
- 監視(colony_watch)+自動化(supply_bot/council/bridge)のスタックで
  「問題が出る→ハートビートで検知→診断→恒久修正→クリーン」のループが一巡した

## 次フェーズ方針(2026-07-07 ユーザー指示)

1. **クリーンラン**: 今回の修正群が全部入った状態で、ワールドを1から作り直し
   「途中修正なし」でブートストラップから発展まで完走させる検証ラン
2. **市民ペルソナ**: 各市民に詳細なペルソナを設定し、個体差のある発話・
   コミュニケーションを観察(研究目標③のSNS連携の前段)

## 進行中 / 次の作業

- **研究パイプライン(2026-07-04 完成・実証済み)**: 「University配置→建設→研究員配属
  (builderから/assignWorkerで配置転換)→autoResearchが自動投入→研究員が完了→次を自動投入
  →研究ゲート解禁」までを人手ゼロで確認。初の解禁: blockhutcomposter。
  1研究あたり10倍速で数分。大学レベル上げ(市長の知識ラベルに「同時研究数+1」提示済み)で並列化
- 実装詳細:
  - bridge に /research(ツリー全体+進行状態。4ブランチ206研究)、/startResearch、
    /autoResearch(空き枠に浅い順で自動投入)を実装
  - 研究開始はクリエイティブ相当でコスト無料(チート供給方針と整合)。進行自体は
    大学の研究員が担う通常シミュレーション。同時研究数=大学レベルは自前で強制
  - supply_bot が60秒ごとに autoResearch を呼ぶ(完了→子研究の解禁を自動で追う)
  - University を (155,-60,257) に配置・着工済み(完成待ち)
  - 副産物の修正: placeNext の探索半径 60→100(中心60ブロック圏が満杯だった)、
    /place の固定62ブロック上限(townhall lv0 前提の遺物)を isCoordInColony 判定に置換
- ワールド移行(通常ワールド)は**保留**: 整地エージェントの難度が高いというユーザー判断。
  最悪スーパーフラット継続でも可
- その後: 施設検証スイート(全建物を系統的に建てて動作をpass/fail判定するハーネス)

## 建物知識ベース(2026-07-04)

- 建物48種の「アップグレードで何が伸びるか」(収容/物量/効率/枠/解禁)を
  `building_knowledge.json` に整理し、市長会議のメニュー選択肢ラベルに自動埋め込み。
  市長がアップグレードの価値を根拠付きで判断できるようになった
  (例: 「fisherman lv4→5(効果: 釣り効率が上がりレア釣果が出やすくなる)」を選択)
- 判断エージェントが知識を参照できる基盤の第一歩(ユーザー提案)。将来は caretaker・
  fine-tune/RAG の共通知識源として拡張予定

## コロニー成長の記録(無人運転の成果)

- keep-alive 実装後、無人のまま townhall が lv5 まで到達、建物32棟(courier群など
  council の発注も消化)。「無人でも市長会議+builderで成長が回る」ことの実証データになる

## 未解決・観察中

- 夜モブによるコロニー被害の有無(観察中)
- クラフター系建物(sawmill等)はレシピ教示(AddRemoveRecipeMessage)が未実装
- Colonial の cookery1 blueprint に座席が無い("Restaurant without sitting position" ログスパム。実害は現状不明)
- miner はスーパーフラットでは動作確認不可(ワールド移行できた場合のみ)

## 本日のコミット(origin / fork 両方に push 済み)

| commit | 内容 |
|---|---|
| `ec63b16` | council.js を ollama+メニュー選択方式に移行 |
| `26c5457` | 食堂メニュー・畑の種の bridge エンドポイント |
| `a2120e7` | 資材の一括納品 + 要求数ぴったり配達 |
| `a4cb5e3` | executor エージェント定義(後に休眠化) |
| `53a2431` | /debugCitizenAI |
| `9843a6b` | /debugFarm + 農家の日付凍結問題の根治 |
| `026d737` | 無人コロニー keep-alive + ゲーム時間基準の給食 + 食堂在庫 |
| `9a35d52` | colony-diag: コロニー休眠の診断手順 |
