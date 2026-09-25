# 進捗報告 2026-08-10（2026-08-03〜08-09）

> 2026-08-04時点の逐次更新版。検証済みマイルストーンとライブ状態の変化ごとに追記する。

## 1. 目的

ペルソナ項目の拡張を一旦止め、MineColonies本来のAIとVoyagerの介入を区別したうえで、
卒業研究として比較可能な具体的社会シナリオを設計する。最初の対象は、希少な食料を
必要性・関係性・自己保全のどれに基づいて配分するかという葛藤とする。

## 2. 実施内容

### 2.1 MineColonies機構の整理

- MineColonies `1.20.1-1.1.1231`を対象として、空腹・Restaurant、要求・物流、職業・生活周期、
  raid・防衛、家族等の標準機構を整理した。
- 標準AI、Bridgeによる観測、Voyagerによる外部介入を`MINECOLONIES_MECHANICS.md`の表へ分離した。
- 食堂、Courier、Warehouse、`supply_bot`、adaptive tickrate、物理距離、病気、職業中断を
  食料配分実験の交絡要因として記録した。
- ライブ試験はメインworldへ直接加えず、複製worldの短い統制窓で実施し、終了後に救済する方針とした。

### 2.2 既存研究から具体シナリオへの変換

- Generative Agentsの具体的seed event、SOTOPIAの共通状況と私的目標、GovSimの希少共有資源、
  Melting Potの社会課題分解、Sequential Social Dilemmasの環境条件操作を設計要素として整理した。
- 既存理論の再実装とは主張せず、MineColonies上の具体的な条件間比較へ移したものと位置付けた。

### 2.3 食料1食の配分scenario

- 実persona・社会graphから、家族辺と家族以外の辺を両方持つ生存市民を抽出するoffline runnerを追加した。
- 援助者は満腹、移転可能な食料は1食、候補は「親しい軽度空腹者」と
  「関係の薄い重度空腹者」とし、両者の物理距離を12ブロックへ固定した。
- `uniform`、`persona`、`persona_relation`、`temporal`の4条件で、家族・重症者・保持を比較する。
- 同じ内容を将来LLMへ渡せる日本語scenario cardとして生成する。
- 死亡済み候補を除外し、結果JSONの出力先をgitignoreした。

## 3. 検証結果

| 項目 | 結果 |
|---|---|
| 食料配分runner単体テスト | PASS。候補抽出、死亡者除外、条件mask、重症者選択、保持、card生成 |
| 全Nodeテスト | 16ファイルすべてexit 0。P1 17 tests、graph 8、dynamics 10を含む |
| `node --check` | PASS |
| `git diff --check` | PASS |
| offline対象数 | 24 scenario（保存graph 35 nodes / 111 edges） |
| `uniform` | 重症者24、家族0、保持0 |
| `persona` | 重症者15、家族0、保持9 |
| `persona_relation` | 家族15、重症者0、保持9 |
| `temporal` | 家族15、重症者0、保持9 |

関係性を入れると援助する15人が全員家族へ反転したため、操作は判断へ明確に効いている。
一方で家族効果が強すぎる可能性があり、現時点の数値を現実妥当性の証拠とはしない。
望ましい結果へ合わせた係数調整は行わず、空腹差の感度分析を先に定義する。

## 4. 現在のライブ状態

- 2026-08-04のhost process確認ではForge/Javaサーバーは停止中で、`localhost:8089/ping`はconnection refused。
- `persona_daemon.js` PID 3260956、`social_observer.js` PID 3289955、`supply_bot.js` PID 3326445は
  processとして残っているが、Bridge停止中のため有効なライブ処理はできない。
- 今回はoffline設計とrunner検証だけを行い、サーバー起動、world変更、Bridge配備は行っていない。
- Minecraftへ入って確認する段階にはまだ進めていない。複製worldと統制条件を準備した時点でユーザーへ通知する。

## 5. 未解決事項

- family効果が重症度差を完全に上回る現在の係数は未較正。severity gradientで境界を測る必要がある。
- `temporal`と静的関係の差は履歴不足でまだ現れない。人工履歴操作と自然履歴を分けて評価する。
- 候補別help-refuse marginの最大値を選ぶ規則は実験上の操作的定義で、人間の規範判断そのものではない。
- ライブ比較用の複製world、開始snapshot、固定tickrate、短い供給停止窓、救済条件は未準備。
- Restaurantのsitting positionエラー、guardの`WAIT_FOR_FOOD`等の既知問題は未解消。
- 既存未追跡の`compare_metrics.js`、`ops.js`、`zone_audit.js`は変更・stageせず保全中。

## 6. 次の一週間

1. 空腹差を複数段階にした感度分析を実装し、family係数の支配範囲を可視化する。
2. 結果を見る前に、主要仮説、指標、除外条件、係数候補を実験仕様へ固定する。
3. 同じscenario cardを決定論的appraisalとLLMへ与える比較条件を設計する。
4. 複製worldで、固定距離・固定tickrate・1食・短い供給停止窓を再現するライブprotocolを作る。
5. protocolの安全確認後、ユーザーへMinecraft上で観察可能になったことを通知して限定試験を行う。

## 7. 主要コミット

- `e2ff903` — 身体化v2ライブ検証と引き継ぎ記録（両remoteへpush済み）
- `f0358d8` — MineColonies介入境界、食料1食scenario、4条件offline比較
