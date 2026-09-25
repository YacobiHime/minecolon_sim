# 進捗報告 2026-07-27（2026-07-20〜07-26）

> 2026-07-24 時点のドラフト。検証済みマイルストーンごとに追記し、月曜報告時に確定する。

## 1. 今週の目的

MineColonies市民のペルソナ基盤（P1）をライブコロニーへ統合する。また、研究の中心を
「個性付きNPCの演出」ではなく社会シミュレーションとして明確化し、個人間の関係が行動へ
影響し、その結果が関係へ戻る段階実装へ設計を改訂する。

## 2. 実施内容

### 2.1 P1ペルソナ基盤

- 12種類の初期ペルソナテンプレート、セグメント単位の交叉・突然変異、
  出生・死亡検知、JSON台帳の原子的保存を実装。
- Bridgeの`/status`へMineColonies市民の`happiness`を追加し、
  遺伝デーモンの固定値フォールバックから実値へ接続。
- 通常ワールドの34市民へgeneration 0ペルソナを割り当て、
  `personas.json`へ永続化。
- デーモン再起動後に既存台帳を再利用し、初期ペルソナが再割当てされないことを確認。

### 2.2 社会シミュレーション設計の再編

P1は比較的固定な個体差として維持し、後続を以下へ再編した。

1. Phase 1: 家族・同居・同僚・近隣の関係グラフ観測
2. Phase 2: イベント台帳と動的状態
3. Phase 2.5: 職業選好と満足度
4. Phase 3: 援助要請による最小の社会的フィードバック
5. Phase 4: 局所的な情報伝播
6. Phase 5: LLMによる発言表現
7. Phase 6: 危機・援軍シナリオ

研究としての最小完成線をPhase 3に置き、全機能の同時完成を前提にしない方針とした。

### 2.3 Phase 1: 関係グラフ

- `/status`へ各市民の`homeBuilding`を追加。既存の家族情報・`workBuilding`と合わせ、
  関係をゲーム内の実データから抽出可能にした。
- `social_graph.js`を追加。statusスナップショットから以下の構造的関係を再構築する。
  - partner
  - parent_child
  - sibling
  - co_resident
  - coworker
  - neighbor（別住居かつ48ブロック以内）
- 死亡・転居・転職後の古い参照を残さないよう、関係グラフは正本のstatusから全再構築する。
- `social_state.json`へ原子的に保存する。Phase 1では行動変更を行わず、
  trust・affinityは中立値、familiarityだけを構造的接触から初期化する。
- `social_observer.js`を追加し、60秒ごとに関係グラフを再構築する。
  市民追加・消失、転職、転居、勤務先変更、関係辺の追加・削除・根拠変更だけを
  `social_graph_events.jsonl`へ記録する。既存グラフを起動時baselineとして扱い、
  再起動だけで架空の全件追加イベントを出さない。

### 2.4 Phase 2: 動的状態の分離（基盤）

- `social_dynamics.js`を追加し、再構築可能な構造グラフと、経験を蓄積する動的状態を分離。
- 市民ごとにfear、stress、satisfaction、actualLoyaltyを保持する。
  actualLoyaltyの初期値にはP1の`politics.loyalty`を使う。
- 関係ごとにtrust、affinity、debtを保持する。構造的接点が消えても関係を削除せず、
  `structurallyActive=false`として過去の値を残す。
- 市民が1pollだけ消えても死亡とは扱わずinactiveとする。死亡確定はP1の3poll規則へ委ねる。
- 最初の状態更新規則として転職だけを実装。希望職ならsatisfaction +0.10 /
  actualLoyalty +0.02、不希望職なら−0.15 / −0.03、中立職は変化なし。
- social_observerが構造差分を動的状態へ一度だけ適用し、原子的に保存する。
- 満腹度を`fed`（>6）、`hungry`（2.5超〜6）、`starving`（2.5以下）へ離散化し、
  同じ帯の中で数値が揺れてもイベントを出さない。
- `nutrition_changed`、`sickness_started`、`recovered`、`disease_changed`を追加。
  空腹悪化1段階につきstress +0.10 / satisfaction −0.05、回復は逆方向。
  発病は+0.15 / −0.10、回復は−0.10 / +0.05とし、完全相殺ではなく罹患の影響を一部残す。

## 3. 検証結果

| 項目 | 結果 |
|---|---|
| P1単体テスト | 15/15 PASS |
| Phase 1関係グラフ単体テスト | 8/8 PASS |
| Phase 2動的状態単体テスト | 7/7 PASS |
| Bridgeビルド | JDK 17、BUILD SUCCESSFUL |
| happiness | 34/34市民で取得、実測9.94〜10.00 |
| homeBuilding | 34/34市民で取得 |
| P1永続化 | 再起動後も34件を再利用 |
| 関係グラフ | 34ノード、108辺、平均次数6.353、孤立者0 |
| 定期observer | 5秒周期の短時間検証を3poll実施、安定状態の架空差分0件。現在60秒周期 |
| 動的状態 | 34市民・108関係、全員active。満足度0.5、実効忠誠度0.15〜0.95 |
| 健康イベント | ライブ1pollでnutrition帯変化19件。fed→hungry 2人へstress/satisfaction変化を確認 |
| 発病・回復 | 市民20・33でsickness_started/recoveredをライブ記録し、動的状態への反映を確認 |

ライブ関係の内訳:

| 根拠 | 辺数 |
|---|---:|
| neighbor | 76 |
| co_resident | 21 |
| parent_child | 16 |
| partner | 6 |
| coworker | 1 |

1つの辺が複数の根拠を持てるため、内訳の合計は総辺数と一致しない。

## 4. 現在のライブ状態

- ワールド: seed 42、通常ワールド
- コロニー: id=1 `NormalActual`、中心 `(501,79,-319)`
- 市民35人、建物67棟
- Bridge `:8089`: 稼働
- persona_daemon: 1プロセス稼働
- social_observer: 1プロセス稼働（60秒周期）
- supply_bot: 1プロセス稼働
- council / colony_watch: Phase 2検証中のため停止
- forceload: 建物境界`X=393..654 / Z=-434..-210`を覆う255チャンク
- tickrate: 手動10倍（病気guardの復旧中。適応40倍から一時的に抑制）

## 5. 運用上の発見

- `colony_watch.sh`が動いたままだとBridge復帰時にcouncilとsupply_botを再起動するため、
  `--no-agents`検証にならない。deploy-bridge手順へ停止確認を追加した。
- 通常ワールドの全建物を含む矩形は255チャンクで、Minecraftのforceload上限256に
  ほぼ到達している。建物がさらに外へ増えた場合は単一矩形方式を継続できない。
- Restaurant blueprintの座席欠落エラーは引き続きログへ出る。既知問題であり、
  今回のBridge変更による新規例外ではない。
- Phase 1検証中にsupply_botを停止したまま適応40倍で長時間動かし、
  35人中starving 11 / hungry 8 / sick 1まで悪化した。supply_bot復帰20秒後に
  starving 2 / hungry 2 / fed 31まで回復。この変化が健康イベントのライブ検証にもなった。
- 市民33（Lacey G. Magic、knight）はinfluenza・満腹度0・`WAIT_FOR_FOOD`で停止し、
  carrot/potato、steak_dinner、cooked_beef、単発`/moveCitizen`では復旧しなかった。
  正常なサーバー再起動でAIキャッシュを初期化すると満腹度5.4・`WORKING`・病気falseへ回復。
  observerも市民20・33の`recovered`を次pollで記録した。

## 6. 未解決事項

- trust・affinity・debtは永続化したが中立初期値のみ。援助などによる更新規則は未実装。
- 転職規則の係数（+0.10/+0.02、−0.15/−0.03）は初期仮説であり、比較実験前に固定する必要がある。
- 座席なし食堂とguardのEATING優先が重なる`WAIT_FOR_FOOD`ウェッジは再起動で復旧できるが、
  自動検知・局所AIリセットによる恒久対策は未実装。
- 近隣距離48ブロックは初期仮説。感度分析またはゲーム内移動時間による妥当性確認が必要。
- happinessがほぼ全員10であり、現在のコロニーでは遺伝の選択圧として差が小さい。
- council / supply_bot / colony_watchを通常運用へ戻すタイミングを決める必要がある。
- 既存未追跡の`compare_metrics.js`、`ops.js`、`zone_audit.js`は保全中で未整理。

## 7. 次の一週間

1. 病気guardの`WAIT_FOR_FOOD`を安全な局所AIリセットで解消する恒久策を検討する。
2. P1の死亡確定イベントをPhase 2へ接続し、一時的なstatus欠落と死亡を区別する。
3. 関係グラフと動的状態の集計を週次レポート向けに出力する。
4. Phase 3の援助要請を、まず空腹市民1人・支援者1人の限定シナリオで設計する。

## 8. 主要コミット

| commit | 内容 |
|---|---|
| `673958e` | P1ペルソナ基盤、遺伝デーモン、12テンプレート、単体テスト |
| `35ee929` | happinessライブ統合、段階ロードマップ、配備手順更新 |
| `5a9ca00` | Phase 1関係グラフ、homeBuilding、週次報告運用 |
| `881f53c` | Phase 1定期observer、構造差分JSONL |
| `772762d` | Phase 2動的状態、転職イベントreducer、永続化テスト |
| `143e464` | 空腹・発病・回復イベント、stress/satisfaction更新 |
