# 週次進捗報告（2026-08-31）

## 目的

- WindowsクライアントからSSHトンネル経由でMinecraftワールドを観察し、LLM Councilの会話をゲーム内で確認できる状態を維持する。

## 実施内容

- Forgeサーバーを `mc-server` tmuxセッションで起動した。
- サーバー再起動後に停止していた `supply_bot.js` と `council.js` を各1プロセスで再起動した。
- CouncilログとMinecraftログを照合し、チャット配送経路を確認した。
- Councilの共有記憶に、発言だけでなく実行した行動と結果も記録し、次のLLMのchoiceに渡すようにした。
- 他の統治者の提案を、安全性・優先ルールに反しない限り行動選択に反映し、反映しない場合は理由を返すルールを追加した。
- 食料1食配分の統合`experiment_runner.js`を追加し、severity gradient、複数seed、4条件比較、任意LLM条件、snapshot再実行、JSONL/JSON/CSV出力を一体化した。
- ライブ関係データ不足時に決定論的な実験用トポロジーを作り、実測関係と区別するメタデータをsnapshotへ保存するようにした。
- 旧ワールド（建物90、市民46）を`simulation-backups/20260830T071028Z`へ退避し、原点から新規シミュレーションを開始した。
- 新規コロニーのBuilder's HutとTown Hallをlevel 1まで完成させてから、Supply BotとCouncilを順番に起動した。

## 検証結果

- Bridge `/ping`: `{"status":"ok"}`。
- コロニーID 1（Voyager Simulation）の状態取得に成功。
- Councilの新規cycle 1でAldricの発言生成を確認。
- Minecraft `latest.log` に `[Server] Aldric: ...` が記録され、ゲーム内チャットへの配送成功を確認。
- コミット `0f83ec7` の反映後にCouncilを起動し、新コードでcycle 9まで進行することを確認。
- 現在47市民のsnapshotから4条件×3空腹度×2反復の1,128試行を実行し、失敗0件。
- snapshot再実行で選択結果SHA-256 `b6176d375f556c4376edddcb3e1cf192c8fd8b9a969ef67fa7ae2d80ea7a8a66` の一致を確認。
- 関係操作後の1,128試行で、親しい相手の選択率が`persona=0.3191`から`persona_relation=0.4326`へ変化した。
- ローカルOllamaのLLM条件を1件実行し、JSON選択・理由・応答時間の保存に成功。
- 最新コミット`76b724a`のrunnerをライブ状態から4条件×3空腹度×47シナリオ×30反復で実行し、16,920試行すべて失敗0件。再現用`recordsSha256`は`196cff790fec357831e59a43b7da330788bff5d8756cfe84196708e638f7ced2`。
- 本実行では親しい相手の選択率が`persona=0.3083`から`persona_relation=0.4246`へ変化した。`temporal`は`persona_relation`と同率で、履歴効果の追加観測が引き続き必要。
- 新規ワールドのCouncil cycle 1でAldric/Miraの発言がMinecraftチャットへ届き、坑夫小屋と住居の配置・着工まで成功した。

## 現在のライブ状態

- Forge 1.20.1サーバー: 稼働中（ゲームポート25565）。
- `supply_bot.js`: 稼働中、単一プロセス。
- `council.js`: 稼働中、単一プロセス。
- tickrate: 10倍速。
- 観察クライアントはSSHローカル転送 `localhost:25566` から接続可能。
- 現在の新規コロニー: 市民4、Town Hall level 1、Builder's Hut level 1。坑夫小屋と住居を建築中。

## 未解決事項

- 現在の`/status`は47市民に対し社会関係を1辺しか復元できない。今回のライブMVPは合成トポロジーを使うため、実関係の比較には家族・住居・位置観測の復旧が必要。

- Councilが配置したcourier hutでStructurizeのblueprint読み込みエラーが記録されている。会話配送自体には影響していないが、該当建築の進行は別途診断が必要。

## 次の一週間

- 実関係を使う統制ライブ試験のため、Bridgeの家族・住居・市民位置観測を復旧する。

- Council/Supply BotをMinecraftサーバー再起動時に安全に再開する運用または自動化を検討する。
- courier hutのblueprintパス不整合を診断する。

## 主要コミット

- `76b724a` 食料配分の再現可能な統合実験runner。

- `0f83ec7` Councilの会話を行動選択へ反映。
