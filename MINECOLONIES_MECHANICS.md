# MineColonies動作機構と社会実験の介入境界

## 対象

- Minecraft 1.20.1 / Forge
- MineColonies `1.20.1-1.1.1231`
- 実験用Bridge: `minecolonies-bridge/`

ここでは、MineColoniesが本来行う判断とVoyagerが外から追加する判断を区別する。
区別しないまま結果を見ると、ペルソナの効果とゲーム標準AIの効果を取り違えるためである。

## 標準AIとBridgeの役割

| 対象 | MineColonies標準の動作 | 観測に使えるBridge情報 | Voyager側の介入 |
|---|---|---|---|
| 空腹・食事 | saturationに応じて食事を探し、手持ちやRestaurantの料理を食べる。料理の品質・多様性・食歴も幸福度へ関わる | `/status`、`/citizenInventory`、`/debugCitizenAI` | `supply_bot`の給餌、`/giveToCitizen`、`/transferCitizenItem`、市民間援助 |
| 物流・要求 | hut在庫から要求を作り、Warehouse、Courier、製作職の連鎖で解決する | `/openRequests`、work order、各種debug API、console log | 不足品の外部供給、要求解決の補助 |
| 職業・生活周期 | 職業AI、通勤、作業、帰宅、睡眠を繰り返す | `/status.position`、job/building、`/debugCitizenAI` | 配属、移動、建設・供給命令 |
| 脅威・raid | 市民は作業を止め、避難や防衛へ移る。Guard施設と衛兵AIが応戦する | `/threats`、guard状態、console log | 警報伝播、guard order。現状の情報daemonはshadowのみ |
| 社会関係 | 家族、住居、職場、死亡時の反応などは持つが、一般的な有向trustや個人別感情は実験用状態として公開されない | citizen/family/home/jobから構造辺を構築 | 有向trust・affinity・obligation、gratitude・resentment、行動履歴 |

参照: [Request System](https://minecolonies.com/wiki/systems/request/)、
[Dining Hall / Cook](https://minecolonies.com/wiki/buildings/cook/)、
[Raids](https://minecolonies.com/wiki/systems/raid/)、
[Guard Tower](https://minecolonies.com/wiki/buildings/guardtower/)、
[MineColonies source](https://github.com/ldtteam/minecolonies)

## 食料配分実験で混ざり得る要因

- 判断中に本人または受益者が手持ちの別の料理を食べる。
- Restaurant、Courier、Warehouse、`supply_bot`が先に不足を解決する。
- 二人の物理距離や通行可能性が異なり、社会関係ではなく到着時間が結果を決める。
- adaptive tickrateにより、同じ実時間でもゲーム内経過時間が変わる。
- 職業、病気、raid、睡眠、料理の品質・食歴が空腹回復や幸福度へ影響する。
- 社会的な移動命令が本来の仕事を中断する。

## 安全な介入境界

1. まず保存済みのpersona・graph・dynamicsで反実仮想を計算し、操作が判断へ効くか確認する。
2. ライブ試験はメイン世界ではなく複製worldまたは復元可能なsnapshotで行う。
3. 条件間で開始時刻、tickrate、距離、食料、空腹帯、職業中断時間を固定して記録する。
4. 外部供給を止めるのは複製環境の短い判断窓だけとし、終了後は必ず救済する。
5. 各結果に、標準AI、Bridge API、社会daemonのどれが動かしたかをイベントとして残す。

現段階のoffline runnerはMinecraftを変更しない。Forge/Bridgeを起動せずに実行できる。
ライブ化する際は、MineColoniesの自然な食事・要求系を消すのではなく、短い統制窓の前後を含めて
観測し、「社会判断が標準AIへ追加された時の差」として評価する。
