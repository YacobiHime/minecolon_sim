# 進捗報告 2026-08-03（2026-07-27〜08-02）

> 2026-08-02時点のドラフト。検証済みマイルストーンとライブ状態の変化ごとに追記する。

## 1. 目的

ペルソナ・個人間関係・感情をMineColonies上の実行可能な社会行動へ接続する前に、
既存実装の不具合を解消し、卒業研究として再現可能な比較実験を行える基盤を整える。

## 2. 実施内容

### 2.1 研究方針の整理

- 新規な感情アーキテクチャそのものの提案ではなく、既存の認知的評価モデルを参照しながら、
  ペルソナ・動的感情・有向な個人間関係をゲーム内行動と結果へ接続する閉ループを主な候補とした。
- 卒論の最小完成線として、困窮検出、援助要請、相手選択、実行、成否確認、関係更新を
  再現可能な条件で比較する方針を検討した。研究室教員との相談後に研究質問と新規性を確定する。
- OCC/FAtiMA型appraisalを参照した最小モデルを採用した。完全準拠や新規感情理論の主張はせず、
  各判断の寄与を記録できる実験用近似として実装した。

### 2.2 ペルソナ拡張前の保全

- バグ修正commit `4c9a7fc`を`origin`と`fork`へpushし、拡張前のソース復元点とした。
- personas、templates、social graph、dynamic state、イベントログ約11MBを時刻付きでバックアップし、
  SHA-256を確認した。

### 2.3 Phase 3 最小appraisal・援助閉ループ

- 既存P1からfamily、community、fairness、reciprocity、autonomyを決定論的に導出し、
  relevance、goalCongruence、normCompatibility、controllability、selfCostを評価する
  `voyager-appraisal-v1`を実装した。
- concern、obligation、reluctance、distressを中間状態としてhelp/refuseを採点し、全寄与を保存する。
- 関係辺に相互非対称な`perspectives`を後方互換追加した。
- append-only行動キューを追加し、social_observerがoffsetを保存して結果を一度だけreducerへ適用する。
- Bridgeへ`/citizenInventory`、近接制約付き`/transferCitizenItem`、`/status.position`を追加した。
- `social_help_daemon.js`が困窮者、関係者、所持食料を選び、実移動後に既存食料を1個移転する。
- 資源不足は`help_unable`、移動・API失敗は`help_failed`として、意図的拒否と区別する。

### 2.4 Phase 3.5 時間的関係・比較実験

- 有向perspectiveへ相手別のgratitude、resentment、援助・拒否回数、最終結果を追加した。
- 感情はgameTime 24,000 tick半減期で遅延評価し、observerのpoll頻度に依存させない。
- 恩義を持つ相手を助けた場合、obligationを最大0.10自動返済する返礼規則を追加した。
- Phase 3で適用済みの行動ログを別byte offsetで一度だけ記憶へ復元し、trustの二重適用を防いだ。
- 同じ222有向ペアと乱数を使うuniform／persona／persona_relation／temporal比較runnerを追加した。
- 援助履歴だけを操作するmanipulation checkと再現手順を`SOCIAL_EXPERIMENTS.md`へまとめた。

### 2.5 Phase 4 局所情報伝播

- 発信者、根拠イベント、gameTime、TTL、最大hopを持つ構造化脅威警報を実装した。
- 家族・同僚・近隣辺のみを通り、受信者から発信者へのtrust、familiarity、ペルソナ、感情で
  受容・再伝達を決め、全attemptと到達pathを保存する。
- 複数seedの平均・標準偏差を出すrunnerと、`/threats`を読むshadow専用daemonを追加した。
  現段階では市民移動・戦闘命令を出さない。

### 2.6 Phase 3.6 詳細認知ペルソナ

- P1の7数値特性を正本のまま維持し、価値、動機、欲求優先度、規範、対処、感情力学、
  意思決定傾向を決定論的に導出する`voyager-cognition-v1`を実装した。
- 本人・相手の困窮、有向関係、対人記憶、距離、資源から5つの状況依存goalを計算し、
  appraisal、予期感情、help/refuse scoreまで全入力・重み・寄与をtrace化した。
- 係数を`experimental-unvalidated`なJSON configへ分離し、詳細モデルv2と既存v1を
  同一場面・同一乱数で比較するrunnerを追加した。
- 初回v2が正信号の項目数だけで援助へ偏ったことを検出し、各値を中立点0.5からの正負の証拠へ
  変換した。運用既定は較正済みでないv2へ切り替えず、v1を維持した。
- 全生存市民のprofileと次元分布を出力するreportを追加し、定義、主張範囲、限界、再現手順を
  `COGNITIVE_MODEL.md`へまとめた。

### 2.7 一時欠落による誤死亡の修正

- `persona_daemon.js`は、市民が`/status`から3 poll連続で欠落すると死亡扱いしていた。
  実環境では生存市民24がこの条件を満たし、`personas.json`で誤って`deceased=true`になっていた。
- `/status`上の欠落だけでは死亡を確定できないため、死亡印を暫定状態として扱い、同じ市民IDが
  再出現した場合に`deceased`と`deceasedAt`を自動解除して`restored`イベントを記録するよう修正した。
- この変更は既存の欠落3 poll規則と家系履歴を維持しつつ、誤判定を自己修復可能にする。
- ライブ名と台帳名が異なる市民8・24も確認されたため、安定IDと家系を維持したまま表示名を同期し、
  `identity_updated`イベントで旧名と新名を記録するようにした。

### 2.8 Phase 3.6 身体化v2ライブ試験

- 自然な空腹場面でv1/v2を同一snapshot・最大効用選択で比較し、v2の援助だけでなく
  `stubborn_miner`、`cold_strategist`等による拒否も実データ上で発生することを確認した。
- v2拒否5件を実行し、受け手視点のtrust 0.50→0.44、affinity 0.50→0.47、
  resentment 0→0.16と、助け手側の`requestsRefused`をobserverが一度だけ更新した。
- 市民22→14では同居関係、v2 margin +0.758でfish dinnerを手渡した。送信側4→3、
  受信側0→1の後に受信者が食べ、saturation 0→6.4まで回復した。受け手視点は
  trust 0.58、gratitude 0.18、obligation 0.10になった。
- 従来の「古い受け手位置へ到着後に移転」では適応tickrate中に受け手が移動し続け、2件失敗した。
  250msごとに実位置を確認し、2秒ごとに追跡先を更新、6ブロック以内で即移転する方式へ変更した。
- 修正版は市民3→21で18.0ブロックから約0.56秒で接近・移転に成功した。助け手位置は
  X=492→507、受け手X=510、fish dinnerは157→156 / 0→1となった。
- `supply_bot`へ社会支援の初動猶予を追加したが、初期値は0で従来挙動を維持する。
  社会支援常駐とセットの場合だけ`SOCIAL_HELP_GRACE_MS`で有効化できる。

## 3. 検証結果

| 項目 | 結果 |
|---|---|
| P1単体テスト | 17/17 PASS（再出現後の復活・ライブ名同期テストを追加） |
| Phase 1関係グラフ | 8/8 PASS |
| Phase 2〜3.5動的状態 | 10/10 PASS |
| `git diff --check` | PASS |
| ライブ復活確認 | PASS。市民24を`restored`し、`deceased=false`を永続化 |
| ライブ名同期 | PASS。市民8・24で`identity_updated`を一度だけ記録 |
| Appraisal単体テスト | 6/6 PASS |
| 詳細認知profile | PASS（決定性、範囲、個人差、導出trace） |
| Appraisal v2 | PASS（援助、拒否、資源なし、seed再現、寄与trace） |
| Profile report / v1-v2比較 | PASS（分布集計、trace切替、同一seed再現、決定論比較） |
| 行動キュー | PASS（partial line保留、byte offset再開） |
| observer行動適用 | PASS（同一イベントを一度だけ適用） |
| 援助daemon | PASS（成功・shadow・失敗・資源不足） |
| Bridgeビルド | JDK17、BUILD SUCCESSFUL |
| 市民位置 | 35/35取得 |
| 遠距離移転拒否 | 166.1ブロックをHTTP 500で拒否、所持数不変 |
| 資源保存 | 1個往復で送信96→95→96、受信0→1→0 |
| ライブ援助 | 市民17→18、実移動後steak dinner 1個移転成功 |
| 非対称関係更新 | 受益者側trust 0.50→0.58、offset 275/275 |
| 記憶移行 | 222/222視点、memory offset 275/275。旧援助1件をtrust二重適用なしで復元 |
| 援助4条件比較 | 11,100試行/条件。help率 0.5123→0.6051→0.7018→0.7018 |
| 履歴操作 | 援助経験0.8322、履歴なし0.7018、拒否経験0.3007 |
| Phase 4単体・daemonテスト | PASS（経路、TTL、seed再現、重複抑止、標的市民を警報源化） |
| 情報伝播100 seed | 平均到達率 uniform 0.4529、persona 0.4423、relation/temporal 0.5643 |
| `/threats` shadow接続 | PASS。現在は`no-threat`、ゲーム操作なし |
| 35市民の認知分布 | 主要9次元すべてに分散、SD 0.1147〜0.2058 |
| v1/v2確率比較 | 11,100試行/モデル。援助率0.7003→0.6032、不一致率0.1001 |
| v1/v2決定論比較 | 222場面。援助率0.6892→0.6171、不一致16場面（0.0721） |
| v2ライブshadow | starving対象なし。hungry対象で実profile・全寄与生成、ゲーム操作なし |
| v2ライブ拒否 | 5件。拒否者のpersona/自己困窮に応じて選択し、非対称trust・resentment・記憶へ反映 |
| v2ライブ援助22→14 | 接近、fish dinner 4→3 / 0→1、摂食、saturation 0→6.4、gratitude/obligation更新を確認 |
| 高速追跡3→21 | 適応tickrate下、初期距離18.0、約0.56秒で3.3ブロックまで接近し移転成功 |
| 追跡・食料多様性テスト | PASS（live位置poll、再標的化、受け手が未所持の料理を優先） |
| 供給猶予テスト | PASS。初期値0、20秒設定の境界を単体確認 |

## 4. 現在のライブ状態

- Minecraft/Forge、Bridge `localhost:8089`、persona_daemon、social_observer、supply_botが稼働中。
  councilは停止中。
- コロニー`NormalActual`は35市民。市民24 `June D. Harris`の生存を`/status`で確認した。
- 修正版persona_daemonをライブ再起動し、市民24の誤死亡を解除した。現在の台帳は
  `deceased=false`、`deceasedAt=null`、name=`June D. Harris`。
- Bridge最終版を配備し、全建物範囲255チャンクと適応tickrateを復元した。
- social_helpは限定`--once`試験のみ。v2の実行試験は成功2件・拒否5件で、連続自動実行は開始していない。
  `social_help_daemon`の運用既定はv1、v2は環境変数によるopt-inのまま。
- 供給ボットは通常の猶予なし設定で稼働中。コード上の`SOCIAL_HELP_GRACE_MS`既定値も0。
- social dynamicsはversion 2 / phase 3.5へライブ移行済み。observerは新コードで稼働中。
- Phase 3.5前のライブ状態は`runtime_backups/pre_phase35_b9b825c_20260801T1430Z/`へ退避し、
  SHA-256を確認した。information daemonは一回shadowのみで常駐していない。
- 返礼試験はArchie(18)→George(17)がhelpを選択したが、実行直前にGeorgeが食事して回復したため
  実行側が安全に`no-need`とし、食料移転・関係更新は発生しなかった。

## 5. 未解決事項

- `/status`欠落を死亡とみなす3 poll規則自体には推測が残る。将来、MineColonies側から
  権威ある死亡イベントを取得できるか調査する余地がある。
- guardの`WAIT_FOR_FOOD`ウェッジ、Restaurant blueprintの座席欠落、forceload上限付近の運用など、
  以前からの既知問題は未解消。
- 既存未追跡の`compare_metrics.js`、`ops.js`、`zone_audit.js`は変更せず保全中。
- appraisal係数、拒否ペナルティ、softmax temperature、明示的な価値遺伝は未較正。
- 詳細認知の各次元はP1の7特性からの射影であり、独立な心理因子ではない。卒論では因子相関と
  多重共線性を明示し、「詳細な名称=新しい独立自由度」と主張しない。
- 履歴操作で拒否経験が援助率を0.7018→0.3007へ下げ、現係数は強すぎる可能性がある。
  本実験値として固定せず、複数seedと教員相談後に事前登録する。
- 高速追跡は18ブロックで成功したが、距離別成功率、追跡による本来の仕事への影響、15秒timeoutの
  妥当性は未測定。長距離を含む連続実行前に上限距離と除外条件を固定する。
- v2常駐は市民移動と食料移転を繰り返すため、単発試験とは別の継続的外部作用になる。
  今回は常駐化せず、供給猶予もライブでは無効へ戻した。

## 6. 次の一週間

1. 詳細v2係数、個人別感情半減期、softmax temperatureの候補範囲を複数seedで感度分析する。
2. 調整前に仮説・主要指標・除外条件を記録し、自然な困窮時にv1/v2を同じsnapshotでshadow比較する。
3. 自然な困窮時の限定ライブ試行を増やし、返礼、移動距離、成功率、回復時間を測定する。
   常駐化する場合は、v2実行と20秒供給猶予を必ず同時に有効化し、停止条件を先に決める。
4. 自然発生脅威をshadow観測し、中心性・孤立者と情報未到達の関係を分析する。
5. 教員相談後、現比較条件と係数を本実験用に固定する。

## 7. 主要コミット

- `4c9a7fc` — 誤死亡自己修復、名前同期、週次報告開始（両remoteへpush済み）
- `68fdcf2` — Phase 3 appraisal・有向関係・身体化された援助閉ループ（両remoteへpush済み）
- `e253513` — Phase 3.5時間的関係・比較runner・Phase 4局所情報伝播（両remoteへpush済み）
- `05a5215` — 詳細認知profile・appraisal v2・v1/v2比較runner（両remoteへpush済み）
- `a692b4b` — 高速tickrate追跡、料理多様性、供給猶予（全Nodeテスト・ライブ18ブロック成功）
