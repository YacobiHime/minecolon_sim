# MineColonies 仕様ノート（確定した仕様）

MineColonies 仕様把握セッションで確認し、ユーザーの了承を得た仕様を記録するノートです。新しい項目は下に追記します。

- 根拠の表記: 【Wiki】公式 Wiki の記載／【ソース確認】ソースコードで確認（ファイル名つき）／【実験で確認】研究室のコロニーで確認／【要検証】推測やゲーム内で未確認のもの
- ソースのパスは、特に断りがない限り MineColonies の `src/main/java/com/minecolonies/` からの相対パス

---

## 1. 建物の取り壊し・再配置（2026-10-07 確認）

方針セッションからの依頼（発展段階に応じて建物を取り壊して再配置する仕組みの検討。再配置のコストを評価関数に入れる）に対する確認結果。

### 1.1 確認した版

| 対象 | 版 |
| --- | --- |
| MineColonies `version/main` | コミット `4eb1b870`（1.20.1） |
| 研究室で使っている版 | タグ `v1.20.1-1.1.1231` |
| Structurize | 1.20.1-1.0.816（研究室で使っている版。`version/main` は 1.0.818 でビルドされている） |
| VoyagerBridge | リポジトリ `YacobiHime/minecolon_sim` のコミット `2bcde14` |

**1.1.1231 との差**: 以下に関わるファイルは、`AbstractEntityAIStructure.doMining` の立ち位置チェック（`workFrom` の確認が追加された）を除いて同じ。研究室の環境にもそのまま当てはまる。

### 1.2 解体（Deconstruct）

**作業指示の流れ**【ソース確認】

- 小屋の GUI の解体ボタン → `BuildRequestMessage.Mode.REMOVE` → `AbstractBuilding.requestRemoval` → `requestWorkOrder(WorkOrderType.REMOVE)`。子の建物にも同じ要求が出る（`BuildRequestMessage`）。
- `WorkOrderBuilding.create`: REMOVE の目標レベルは 0。設計図は現在のレベルのものを使う。
- 解体できない建物: `canDeconstruct()` が false の建物（兵舎塔 `BuildingBarracksTower`）。
- ビルダーの小屋のレベルは問わない（目標レベルが0のため。`WorkOrderBuilding.canBuildIgnoringDistance`）。ビルダーの小屋から100ブロック以内である必要はある。

**ビルダーがすること**【ソース確認】

- 作業の段階は「水の除去 → ブロックの除去」の2つ（`AbstractEntityAIStructure.loadStructure` の `removal` 分岐）。
- 外すのは、設計図で空気以外になっている位置のブロック。設計図で空気の位置にある地形は残る。小屋ブロックなど `IBuilderUndestroyable` のブロックは壊さない（`AbstractEntityAIStructure.skipRemoval`）。元の地形は戻らないので、基礎のあった場所は掘れた状態になる可能性がある【要検証】。
- 資材の要求はしない（`AbstractEntityAIStructureWithWorkOrder.requestMaterialsState`）。ブロックに合った道具は必要で、なければ道具を要求する。
- 1ブロックずつ採掘する（Structurize の `StructurePlacer` が `BREAK_BLOCK` を返し、ビルダーが `doMining` → `mineBlock` で壊す）。

**壊したブロック・資材の行き先**【ソース確認】

- 壊したブロックは、通常のドロップ（バニラのルール）として**ビルダーの持ち物**に入る（`AbstractEntityAIInteract.mineBlock`）。
- ビルダーはシルクタッチを使わないので、ガラスなど、そのままではドロップしないブロックは失われる。Domum Ornamentum のブロックは見た目の情報つきで戻る（`getCorrectDOItem`）。
- 持ち物がいっぱいになると、自分の小屋に荷下ろしする（`AbstractEntityAIBasic.inventoryNeedsDump` → `dumpInventory`）。小屋に入った物は、ほかの物と同じように配達員が倉庫へ運ぶと考えられる【要検証】。
- 【実験で確認】小屋のラックがいっぱいだと荷下ろしできず、ビルダーが止まる（研究室で、レベル1の小屋のビルダーがすべて持ち物いっぱいで止まった。週次報告 2026-07-07）。

**かかる時間**【ソース確認】

- 1ブロックあたりの採掘の待ち時間（`AbstractEntityAIInteract.calculateWorkerMiningDelay`）:

  ```
  500 × 0.85^(運動スキル/2) × ブロックの硬さ ÷ 道具の採掘速度 × (1 − 研究の破壊速度ボーナス)
  ```

  - ビルダーの破壊速度に効くのは副スキル（運動 Athletics。`EntityAIStructureBuilder.getBreakSpeedLevel`）。
  - 単位は tick と思われる【要検証】。例: 運動10、石（硬さ1.5）、石のツルハシ（速度4）なら約83。
- 全体の時間 ≒ 設計図の空気以外のブロック数 ×（採掘の待ち時間＋移動）＋荷下ろしの往復。資材の待ち時間はない。移動と荷下ろしの割合は【要検証】。
- 参考（再建側）: 1ブロックの設置の待ち時間は `15 × 10 ÷ (適応力スキル/2 + 10) × (1 − 研究の設置速度ボーナス)`（`AbstractEntityAIStructure`）。

**解体のあとの状態**【ソース確認】

- 完了時の処理は `building.setDeconstructed()` だけ（`AbstractEntityAIStructureWithWorkOrder` の完了処理）。統計 `build_removed` と、イベントログ（`BuildingDeconstructedEvent`）にも記録される。
- **登録は残る。建物レベルは N のまま（0 に戻らない）。** `isBuilt` も true のまま。
- `isDeconstructed` が効くのは次の3か所だけ。
  - GUI: 「修理」ボタンが「建てる」になり、「回収」ボタンが出る（`WindowBuildBuilding`）
  - もう一度取り壊しを要求すると回収（`pickUp`）になる（`AbstractBuilding.requestRemoval`）
  - スタイルを変えられる（`BuildingSetStyleMessage`）
- そのため、ゲームの仕組みの上では「建っている建物」として扱われ続ける。
  - 人口上限: レベルが1以上の住居は、レベル分のベッドとして数えられ続ける（`CitizenManager.calculateMaxCitizens`）。
  - 自動雇用: `canAssignCitizens()`（レベル1以上かつ `isBuilt`）が true のままなので、雇用が続く（`IBuilding.canAssignCitizens`、`BuildingUtils.canAutoHire`）。
- **場所は空かない。** 登録と設置範囲が残るので、研究の `placeNext` の重なり判定でもふさがったまま。

**市民への影響**【ソース確認】

- 解体しただけでは、雇用も居住の割り当ても外れない。
- 割り当てが外れるのは、回収したとき、または小屋ブロックを壊したとき（`AbstractBuilding.destroy` → `onDestroyed` → `AbstractAssignedCitizenModule.onDestroyed` で全員を `removeCitizen`）。外れた市民は無職・宿無しになる。
- 町役場の自動雇用・自動入居の設定は初期値でオン（`BuildingModules` の `autohiring` / `autohousing`）。オンなら、コロニーの tick ごとに空きのある建物へ割り当て直される。
  - 自動入居（`LivingBuildingModule.onColonyTick`）は、住居が建っているかを確かめない。レベルが1以上で空きがあれば、解体済みや未完成の住居にも宿無しの市民が割り当てられる。
  - 自動雇用は、建物が建っていること（`isBuilt`）を条件にしている。
- 幸福度に直接の影響はない。無職・宿無しの要因を通じて間接的に下がる（7日・14日でさらに悪化）。
- 【要検証】解体済みの建物に割り当てられたままの市民は、ベッドや作業に使うブロックがなくなるので、眠れない・働けない可能性がある（睡眠の要因、職場で暇の要因が下がる可能性）。

**領土**

- 【Wiki】解体すると、その建物が確保したチャンクがなくなる（`systems/border`）。
- 【ソース確認】実際には、**解体の完了ではチャンクは解放されない**。解放されるのは回収時、または小屋ブロックを壊したとき（`AbstractBuilding.onDestroyed` → `ChunkDataHelper.claimBuildingChunks(..., false, ...)`）。
- 【ソース確認】チャンクの持ち主がなくなるのは、同じコロニーのほかの建物がそのチャンクを確保していない場合だけ（`IColonyTagCapability.removeBuildingClaim`）。創設時の範囲は外れない（`ChunkDataHelper`）。
- チャンクを失ったときの影響:
  - 保護が外れる。
  - 【実験で確認】設置範囲に領土外のチャンクがかかる建物のワークオーダーは、ログを残さずに捨てられる。
  - 領土の外側への配置ができなくなる（ビルドツールは設計図が領土内に収まるかを確かめる。`SurvivalHandler`）。

### 1.3 回収（pickUp）とレベル付きの小屋

- 【ソース確認】`AbstractBuilding.pickUp`: 小屋アイテムに入るのは、コロニー ID（`TAG_COLONY_ID`）とレベル（`TAG_OTHER_LEVEL`）だけ。その後 `destroy()` と `destroyBlock` を呼ぶ。
  - 親を持つ建物は回収できない。
  - GUI の回収ボタンが出るのは、レベル0の建物か解体済みの建物。サーバー側の `pickUp()` 自体は解体済みかを確かめない。
  - 小屋ブロックの持ち物は地面に落ちる（`AbstractColonyBlock.onRemove`）。
- 【ソース確認】このアイテムを置くと、**レベル N・解体済みの状態で登録される**。
  - ビルドツールで置いた場合: `SurvivalHandler`。`setBuildingLevel(N)` → `setDeconstructed()`。
  - 小屋を直接置いた場合: `DirectPlaceMessage`。同じ処理。
  - 別のコロニーの ID が入っていると置けない。
- 【ソース確認】建物の本体はないので、「建てる」（中身は修理 `REPAIR` の作業指示）で、**レベル N の設計図を一度に建てる**。
  - 資材は、ワールドにすでに同じブロックがある位置を除いた一式が必要（Structurize `StructurePlacer.getResourceRequirements`）。途中のレベルは経由しない。
  - ビルダーの小屋のレベルが N 以上である必要がある（`AbstractBuilding.requestWorkOrder`、`WorkOrderBuilding.canBuildIgnoringDistance`）。
- 【ソース確認】建て終わると、`upgradeBuildingLevelToSchematicData`（設計図データの更新時）か、完了時の補正処理で、レベル N の領土が確保され、`isBuilt` が true になり、解体済みの印が外れる（`AbstractSchematicProvider`、`AbstractEntityAIStructureWithWorkOrder`）。実際に印が外れるかは【要検証】。
- 【ソース確認】新しい建物として作り直されるので、雇用・設定・教えたレシピなどは引き継がれない。

### 1.4 移設（reposition）

- 【Wiki】町役場の Build Options に「reposition」がある（`buildings/townhall`）。
- 【ソース確認】**専用の移設の作業指示はない。** 作業指示の種類は BUILD / UPGRADE / REPAIR / REMOVE の4つだけ（`api/colony/workorders/WorkOrderType.java`）。GUI のボタンも、建てる・修理・解体・回収・キャンセルだけ（`WindowBuildBuilding`）。
- 【ソース確認】2020-06-16 のコミット `c496355`（#5220「Add a new reposition approach」）で、移設は「解体 → 回収（レベルとコロニー ID 付きの小屋） → ビルドツールで設置」に置き換えられた（コミットメッセージ）。Wiki の reposition は古い記述と考えられる。
- そのため、移設は町役場に限らず、解体と回収ができる小屋ならどれでもこの手順でできる。
  - 引き継がれるもの: レベルだけ。
  - 引き継がれないもの: 登録（作り直し）、割り当てられた市民、設定。
  - 町役場を回収したときの扱い（コロニーへの影響）は【要検証】。

### 1.5 VoyagerBridge の `/removeBuilding`

- 【ソース確認】`VoyagerBridge.java` の `handleRemoveBuilding`: `colony.getServerBuildingManager().removeBuilding(building, ...)` と `level.removeBlock(pos, false)` だけ。**建物本体のブロックは残る。**
- 【ソース確認】プレイヤーが小屋を壊したときは `building.destroy()` を通る（`ColonyPermissionEventHandler`）。`/removeBuilding` は `destroy()` を通らないので、次の違いがある。

| 項目 | プレイヤーが小屋を壊す（`destroy()`） | `/removeBuilding`（現状） |
| --- | --- | --- |
| チャンクの確保 | 解放 | **残る** |
| 働いていた市民 | 割り当てが外れ、無職になる | **職の参照が残る**（`AbstractJob.workBuilding` が消えた建物を指したまま）。無職扱いにならないので、自動雇用でほかの職場に移らない。その後の動作は【要検証】 |
| 住んでいた市民 | 割り当てが外れる | 住居の参照は外れる（`CitizenData.onRemoveBuilding`） |
| リクエスト | 取り消し | 取り消し（`RegisteredStructureManager.removeBuilding`） |
| 工事テープ・リクエストシステムのデータ・子の建物 | 片付けられる | 残る |
| 小屋の持ち物 | 地面に落ちる | 地面に落ちる |

### 1.6 外部（HTTP）から呼ぶ方法

| 操作 | 使う API | 追加の手間 |
| --- | --- | --- |
| 解体 | `building.requestRemoval(fakePlayer, builderPos)`。既存の `/requestBuild` とほぼ同じ書き方でよい | 小（数十行） |
| 回収 | `pickUp()` は FakePlayer の持ち物にアイテムを入れるので使わない。レベル・種類・スタイルを記録してから `building.destroy()` と `level.destroyBlock(pos, false)` を呼ぶ | 小 |
| 移設先での再建 | 既存の設置処理のあと、`setBuildingLevel(N)` → `setDeconstructed()` → `requestRepair(builderPos)`（`SurvivalHandler` と `DirectPlaceMessage` の処理をまねる） | 中（回収と合わせて100〜150行程度） |
| `/removeBuilding` の修正 | `removeBuilding()` を `building.destroy()` に置き換える | 小（数行） |

### 1.7 まとめの表

行の定義:

- 「解体＋新築」: 解体して回収（または小屋を壊して）から、新しい小屋をレベル0から建て直す
- 「移設」: 回収したレベル付きの小屋を別の場所に置き、レベル N の設計図を一度に建てる

| | 時間 | 資材 | 市民への影響 | レベル | 領土 | 外部から呼べるか |
| --- | --- | --- | --- | --- | --- | --- |
| 解体のみ | 設計図の空気以外のブロック数 ×（採掘の待ち時間＋移動）＋荷下ろし。資材を待つ時間はない | 不要（道具のみ）。ドロップはビルダー → 小屋のラックへ。ドロップしないブロックは失われる | 割り当ては残り、自動雇用・自動入居も続く。ただし仕事・睡眠に支障が出る可能性あり【要検証】 | N のまま（解体済みの印が付く） | 変わらない | 窓口なし。足すのは小 |
| 解体＋新築 | 解体＋レベル1の建築＋レベル N までの改築の合計 | 新築はレベル1の一式＋各改築の差分 | 回収時に全員の割り当てが外れる。自動雇用・自動入居で再割り当て。新しい建物で雇い直し | 0 から上げ直し | 回収時に旧分を解放。新しい建物は設置時に設置範囲のチャンク、完成ごとにレベル分の半径 | 解体と回収は窓口を足せば可。新築は既存の `/place` と `/requestBuild` |
| 移設 | 解体＋レベル N の設計図を一度に建てる時間 | **レベル N の設計図一式**（途中のレベルを飛ばせる） | 回収時に全員外れる。設置直後から人口上限に数えられ、宿無しの市民が入居者として割り当てられうる（ベッドはない）。職人の自動雇用は建て終わるまで起きない | 小屋アイテムが N を保持する | 回収時に旧分を解放。設置時は設置範囲のチャンク、完成時にレベル N の半径 | 窓口を足せば可（中） |
| `/removeBuilding`（現状） | 即時 | 建物本体は残る。小屋の持ち物は地面に落ちる | 住居だけ外れる。職の参照は残る | 登録ごと消える | **解放されない** | 可 |

### 1.8 方針セッションへの申し送り

- 「解体のみ」では場所が空かず、ゲーム上も建っている建物として扱われ続ける。再配置のコストは「解体＋回収」を単位に考える必要がある。
- 移設は途中のレベルを飛ばせるので、資材コストはレベル N の設計図一式になる。改築を重ねるより安くなる可能性がある。
- 時間の式の単位と、移動・荷下ろし・資材待ちの割合は【要検証】。テスト用のワールドで、ゲーム時間とワークオーダーの進み具合を記録して実測するのが確実。
- `/removeBuilding` を再配置の実験に使うと、職の参照とチャンクの確保が残る。先に `destroy()` を使う形に直すことを推奨する。

### 1.9 未確認事項

| # | 内容 | 確かめ方（案） |
| --- | --- | --- |
| 1 | 採掘・設置の待ち時間の単位（tick か）と、移動・荷下ろしを含めた全体の時間 | テスト用のワールドで、ブロック数の分かる建物を解体・再建して計測する |
| 2 | 解体後の地形の状態（基礎の位置が掘れたままになるか） | ゲーム内で解体して確認する |
| 3 | 解体済みの建物に割り当てられたままの市民の睡眠・仕事 | ゲーム内で解体後の市民の状態を観察する |
| 4 | 再建後に解体済みの印が実際に外れるか（その場での再建と、移設先での再建の両方） | `/status` などで印とレベルを確認する |
| 5 | `/removeBuilding` で職の参照が残った市民の動作（サーバー再起動後を含む） | 複製ワールドで試す |
| 6 | 町役場を回収したときのコロニーへの影響 | 複製ワールドで試す |
| 7 | 回収・解体で小屋に戻った物を、配達員が倉庫へ運ぶか | ゲーム内で観察する |
