# 引き継ぎ 2026-11-10 — 100人実験と設置物の所有・取得理由

この文書は、100人の自律エージェント実験を停止した時点の状態と、次にClaudeで行う修正をまとめたもの。
次の作業者は、コードを変更する前にこの文書、`AGENTS.md`、`CLAUDE.md`を読むこと。

## 結論と次の課題

100人を実際に同時稼働させることには成功した。20人では目立たなかったベッドの作成・利用、集団行動と単独行動の併存、設備と資源をめぐる競合が多数観察された。

一方、エージェントが他者の置いた壁、板材、松明、作業台などを通常の資源として回収する問題が明確になった。現状は設置物の来歴・所有者・用途を保持せず、`collect`が「見えていて掘れるブロック」を一律に候補化する。そのため、他者の物を取ること自体よりも、次の区別を観察できないことが問題である。

- 利己的に奪った
- 生命、安全、睡眠などの必要から仕方なく取った
- 所有者の許可を得て取った
- 自分の物を移設した
- 共同設備を修理・再配置した
- 所有者を知らず天然資源と誤認した
- 単なる実装上の誤操作だった

次の修正では、取得を禁止するのではなく、設置物の来歴と、取得前に確定した理由と、その後の社会的結果を記録・判断可能にする。

## Gitと作業場所

- GitHub: `git@github.com:YacobiHime/minecolon_sim.git`
- Codexで使用したclone: `/root/.codex/checkpoints/minecolon_sim-20261110`
- 作業ブランチ: `codex/finish-100-agent-scale`
- 100人対応コミット: `693b363`
- 作業前保存ブランチ: `backup/first-setting-pre-100-run-20261110`
- 作業前保存コミット: `66738c8`
- 100人persona生成の主要コミット: `bbd7161`

Claudeが通常のrepo `/root/minecolon_sim` で作業する場合、最初にremoteとworktreeの状態を確認し、`codex/finish-100-agent-scale`をfetchして内容を比較すること。ユーザーの未コミット変更を上書きしないこと。コード変更は新しいブランチとPRで行う。

Codex cloneには `mineflayer-agents/live-100.pid` が未追跡で残っている。停止済みプロセスの古いPIDファイルであり、コミット対象ではない。

## サーバーと実験の現在状態

- 対象サーバー: `/root/mc-server-fabric`
- ワールド: `world_survival3d_14`
- サーバーはユーザーの指示で停止済み
- 停止時刻: 2026-11-10 15:09 JST
- 15:09:12にoverworld、the_end、the_netherを含む全ディメンションの保存完了を確認
- MinecraftサーバーのJavaプロセスは残っていない
- 停止時の100人の切断は `Server closed` であり、実験中の自然切断ではない

再起動はユーザーから明示的に依頼された場合だけ行うこと。実験を再開するときは、保存ワールド、サーバープロセス、ポート、console log、既存botプロセスを先に確認する。

## 100人実験の記録

実行ディレクトリはGit管理外で、約154MBある。

```text
/root/.codex/checkpoints/minecolon_sim-20261110/mineflayer-agents/runs/2026-11-10T05-38-15
```

主要ファイル:

- 統合結果: `runs/2026-11-10T05-38-15/run.json`
- 各人の記録: `<Name>-2026-11-10T05-38-15.jsonl`
- 10プロセスの監視記録: `monitor-1.jsonl` から `monitor-10.jsonl`
- 起動ログ: `/root/.codex/checkpoints/minecolon_sim-20261110/mineflayer-agents/live-100-console.log`
- 設定: `mineflayer-agents/configs/survival_100.json`

実行条件:

- 100エージェント
- 10 Nodeプロセス、各10人
- Minecraft server max players 120
- view distance 5、simulation distance 4
- 行動選択: `typesafe/jev-1.14-20261014` via OpenRouter
- ゴール、会話、内省: `gpt-6-luna`
- `run.json`上の時間: 33.37分（停止後の終了処理を含む）

停止直前の各監視プロセスは `bots 10/10`, `disconnects 0` だった。停止後に各プロセスが `bots 0/10`, `disconnects 10` となったため、最終disconnect数だけを異常切断として扱わないこと。

## 実測結果

### 全体

- 行動判断: 12,391回
- 成功: 9,670回
- 失敗: 2,721回
- 成功率: 約78%
- `collect`: 1,832回、成功921、失敗911
- `place`: 構造化結果のある748回中、成功636、失敗112

移動不能、対象への接近失敗、競合で別人に先に回収された、使用中のベッド、近くの敵など、失敗も社会・環境の一部として可視化された。ただし、明らかな実装失敗と意味のある失敗は今後分ける必要がある。

### ベッド

- ベッド作成: 4回、全成功
- ベッド設置: 6回、全成功
- 睡眠: 64回、成功35、失敗29
- 失敗理由には `the bed is occupied`、`there are monsters nearby`、`bot is not sleeping` が含まれる

例:

- Kumikoは眠気0.821の時点で白いベッドを作り、設置し、睡眠した
- Mihoは安心欲求0.999、眠気0.604の時点で白いベッドを作った
- 他者がベッドを使おうとして「使用中」になる競合が発生した
- ベッドを回収して別の場所へ置き直す行動も発生した

### 集団行動と単独行動

- `follow`: 482回
- `call`: 412回
- `ask`: 329回
- `give`: 45回
- `propose`: 5回
- `explore`: 1,278回
- `go_to`: 2,379回

近くにいる相手へ「そばにいて」「一緒に探そう」と話し、追従する一方、単独で遠くへ探索する行動も多かった。100人では出会い、関係、資源競合、性格分布の極端値が増えるため、20人で低確率だった系列が同時多発した可能性が高い。ただし、人口規模とpersonaモデルの効果を分離するには対照実験が必要。

### 設置と回収の競合

記録された主な行動対象:

- 松明設置: 260回
- 松明 `collect`: 152回
- 壁松明 `collect`: 3回
- 作業台 `collect`: 125回
- 板材 `collect`: 141回
- ベッド `collect`: 2回、両方成功
- かまど `collect`: 2回、両方成功

ログには誰がどの座標へ何を置いたかという行動結果はあるが、現在のワールド状態を参照する恒久的な設置物台帳がない。そのため、上の回収対象が天然生成物、自分の設置物、他者の設置物、共同設備のどれだったかを完全には復元できない。ユーザーの現地観察では、人が置いた壁・松明が回収されていた。

## 問題の直接原因

`mineflayer-agents/src/actions.js` の `collect` 候補生成は、主に次の条件を見る。

- 見えている
- diggable
- 現在の道具で回収可能
- 高さ・除外正規表現などの既存条件を満たす

ブロックが自然生成か、誰が置いたか、現在も機能している壁・灯りかを見ていない。実行側の `mineflayer-agents/src/act.js` も、渡された対象ブロックを掘るが、所有や目的を評価しない。

personalityの `greed` は `needs.js` で「物が欲しい」欲求の増加速度などに使われている。しかし、所有者、許可、公共性、機能損害、代替資源を表現していない。この状態で「greedが高かったから盗んだ」と説明するのは事後的合理化になる。

Jevの記録も主に選ばれたaction、confidence、候補、状態であり、取得理由の確定値を持たない。LLMに行動後の説明文だけを生成させてはいけない。

## 推奨する修正仕様

### 1. 設置物のprovenance ledger

設置・破壊・置換のたびに、dimensionと座標をキーに次を記録する。

```json
{
  "dimension": "minecraft:overworld",
  "position": [-502, 64, -63],
  "block": "torch",
  "placedBy": "Miho",
  "placedAt": "2026-11-10T05:53:14.798Z",
  "purpose": "base_lighting",
  "ownership": {"kind": "personal", "owner": "Miho"},
  "projectId": null,
  "active": true,
  "lastChangedBy": "Miho"
}
```

最低限必要な項目:

- dimension、座標、block type
- placedBy、placedAt
- placement actionの目的・欲求・goal/project
- personal / group / public / unknown
- active / abandoned / superseded
- 置換・回収履歴

システムの台帳は評価用のground truthとする。ただしエージェントへ全情報を渡してはならない。本人が設置した、目撃した、発言を聞いた、共同projectで共有された場合だけ所有者を知り、それ以外は `unknown owner` とする。部分観測を維持する。

ワールドの再起動を越えて必要ならJSONLまたはSQLiteで永続化する。まずは同一run内で確実に動く実装から始めてよい。

### 2. 行動を分離する

現在の一般的な `collect` から、設置物を外す。

- `collect`: 天然資源、または人工物と認識されていない対象
- `dismantle_own`: 自分の不要・誤設置・移設対象
- `take_placed`: 他人、共同、公共、所有者不明の設置物
- `ask_permission`: 所有者が分かり、連絡可能な場合の許可取得
- 必要なら `repair_or_relocate_public`: 公共設備の修理・再配置

設置物を絶対に取れなくしてはならない。`take_placed`として明示的な選択にし、理由と損害を評価する。

### 3. 行動前に構造化した理由を確定する

行動実行前に、次のようなintent recordを作り、recorderへ書く。

```json
{
  "event": "intent",
  "action": "take_placed",
  "target": {"block": "torch", "owner": "Miho", "purpose": "base_lighting"},
  "reasonCode": "emergency_need",
  "need": {"type": "safety", "value": 0.94},
  "traitInfluence": {"greed": 0.31, "empathy": 0.76, "obedience": 0.68},
  "permission": "not_requested",
  "alternatives": [
    {"kind": "collect_natural", "target": "coal", "available": false},
    {"kind": "ask_permission", "available": true}
  ],
  "functionalHarm": {"lightLoss": 7, "opensWall": false},
  "socialCost": 0.42,
  "intendedRestitution": "replace_after_dawn"
}
```

reasonCodeの最低候補:

- `selfish_acquisition`
- `emergency_need`
- `own_relocation`
- `permission_granted`
- `public_repair`
- `unknown_ownership`
- `mistaken_as_natural`
- `accidental`

reasonCodeは自由文LLMに丸投げせず、行動時の欲求値、代替手段、所有情報、permission、機能損害、personalityから決定・検証できる形にする。LLMは確定したrecordを自然な発話に変換する用途に限定する。

### 4. 判断へ所有と機能損害を加える

概念上の評価は次の構成にする。

```text
take value
= survival/safety urgency
+ goal/resource benefit
+ greed pressure
- available alternatives
- functional damage (light, wall, bed, farm, shared station)
- ownership/social cost
- relationship/trust cost
```

固定の単一スコアへ直ちに閉じ込める必要はない。Jevへ構造化された候補差を渡しつつ、明らかに不合理な候補をgate/reweightする形でもよい。ただし、どの項目が選択へ影響したかをログに残す。

機能損害の例:

- torch / wall_torch: 周囲の光量、安全、mob spawn risk
- wall/planks/fence/door: enclosureに穴を開けるか
- bed: 現在の利用者、近隣のベッド数、夜間の睡眠手段
- crafting_table/furnace/chest: 共同設備か、代替設備の距離
- farm block: 作物・水・囲いを壊すか

### 5. 許可、目撃、評判、返却

- 所有者が近くにいるなら、緊急でなければ `ask_permission` を候補にする
- 緊急時は無断取得を許すが、後で説明・返却・補修するgoalを生成可能にする
- 所有者が目撃した、後で欠損へ気づいた、第三者から聞いた、でknowledgeを分ける
- 無断取得は関係・信頼を下げる
- 緊急性と説明はペナルティを軽減する
- 許可ありなら原則ペナルティなし
- 返却・補修・謝罪で回復する
- 利己的取得を繰り返す場合は評判が他者へ伝播する

物理的取得を社会的出来事に変えることが目的。

### 6. 観察可能性

consoleとsummaryへ最低限次を出す。

```text
Yua take_placed(torch owned by Miho)
reason=selfish_acquisition need=greed:0.93 alternatives=2 harm=light:7 permission=no
```

集計指標:

- 設置物取得件数 / 1000 decisions
- reasonCode別件数
- owner別、public/personal/unknown別件数
- permissionを尋ねた割合
- 緊急取得のうち代替手段が本当になかった割合
- 壁穴、光量低下、設備停止などの機能損害
- 返却・補修率
- 信頼変化
- `accidental` と実装失敗の割合

## 実装候補箇所

最初に読むこと:

- `mineflayer-agents/src/actions.js`: `collect`候補生成
- `mineflayer-agents/src/act.js`: collect/place実行、実行結果
- `mineflayer-agents/src/agent.js`: event hook、recorder、social/needsとの統合
- `mineflayer-agents/src/deciders/jev.js`: Jevへ渡すstateと候補
- `mineflayer-agents/src/needs.js`: greed、care、connection、safety
- `mineflayer-agents/src/social.js`: 感情と関係変化
- `mineflayer-agents/src/division.js`: personalityから活動傾向への写像
- `mineflayer-agents/src/board.js`: 共同project・合意・共有物
- `mineflayer-agents/tools/summarize_run.js`: 集計

新規module候補:

- `src/provenance.js`: 設置物台帳とpartial knowledge
- `src/taking.js` または `src/ownership.js`: 所有・損害・理由判定

既存の `board.js` は共同projectに置いた数などを持つが、全設置ブロックの座標・所有・目的を管理する台帳ではない。混同しないこと。

## 人物モデルの出典

100人は手作業のpersonalityではなく、`tools/gen_personas.js`で乱数種`20261110`を固定し、資料から生成した。

### 年齢・性別

- 総務省統計局「人口推計（2024年10月1日現在）」各歳・男女別人口
- 10〜14、15〜29、30〜64、65〜89歳の各層を最低20人確保し、残りを人口比で配分
- 実際の100人: 子供21、若者23、大人30、老人26
- 年齢範囲: 10〜87歳

### Big Five

- 川本哲也・小塩真司ほか (2015)「ビッグ・ファイブ・パーソナリティ特性の年齢差と性差」
- 日本人4,588名、23〜79歳、TIPI-J
- 年代×性別の平均・SDと特性間相関を利用
- 10〜24歳は Soto et al. (2011), N=1,267,218 の年齢差を、日本人25歳基準へ加えて延長
- TIPI-Jの語は小塩・阿部・カトローニ (2012)

詳細データ: `mineflayer-agents/personas/bigfive_age.json`

### 名前

- 明治安田生命「生まれ年別名前ベスト10」
- 生年に近い名前を重複しないよう全体最適化して割り当て

### 年齢による欲求差

- 睡眠時間: Hirshkowitz et al. (2015)
- 年齢とchronotype: Roenneberg et al. (2004)
- 高齢者の空腹感: Giezenaar et al. (2016)
- 子供の夜への恐怖: Muris et al. (2001)
- 高齢者が親しい少数関係を選ぶ傾向: Carstensen et al.; English & Carstensen
- 青年期の他者評価への敏感さ: Somerville (2013)
- 神経症傾向とストレス: Suls & Martin (2005)

### 作用経路

```text
年齢・性別
  -> Big Five
  -> sociability / empathy / obedience / greed / bravery / curiosity
  -> hunger / sleep / safety / connection / recognition / greed / care
  -> goal、活動傾向、会話、行動候補と選択
```

気質の主な写像:

- sociability = E
- empathy = A
- obedience = 0.4C + 0.4A - 0.2N
- greed = -0.7A + 0.3N
- bravery = -0.55N + 0.45E
- curiosity = O

このモデルは傾向を作るが、今回の単一runだけから特定行動の原因を断定してはいけない。とくに現在の設置物取得にはownership変数がないため、greedと盗取の因果を主張できない。

## 年齢層別の今回の観測

- 子供: safety由来goal 47%、集団内70%、睡眠成功0回/人
- 若者: safety 49%、集団内66%、睡眠0.52回/人
- 大人: safety 40%、集団内69%、睡眠0.67回/人
- 老人: safety 49%、集団内74%、睡眠0.12回/人

子供の夜の怖さ、高齢者の少数の親しい関係、年齢別の睡眠などと整合する現象はあるが、100人化、配置、乱数、遭遇密度も同時に変わっている。personaの効果を確かめるにはablationが必要。

## 推奨する検証順

1. provenance ledger単体テスト
   - place -> lookup -> break -> replacement
   - dimension違い
   - restart/persistenceを入れるなら復元
2. partial knowledgeテスト
   - 自分の設置、目撃、伝聞、未知
3. action候補テスト
   - 天然物は`collect`
   - 自分の物は`dismantle_own`
   - 他者・共同物は`take_placed`
4. reason判定テスト
   - greedが高いが代替あり
   - safetyが危機的で代替なし
   - permissionあり
   - owner不明
5. social consequenceテスト
   - 目撃、後から発見、説明、返却、補修
6. 小人数の隔離worldでライブ試験
7. 20人で旧仕様/新仕様を固定seed比較
8. 100人で再試験

評価では最低限、次を比較する。

- provenance off / on
- ownership penalty off / on
- personaあり / 全員同一persona
- 20人×複数seed / 100人×複数seed

1回の20人対1回の100人だけで結論を出さない。

## Claudeが作業を再開するときの安全な順序

1. `AGENTS.md`、`CLAUDE.md`、本ファイルを読む
2. `git status`、branch、remote、未コミット変更を確認
3. `/root/mc-server-fabric`のプロセスとconsole末尾を確認し、停止中であることを確認
4. 上記runの`run.json`と代表的なJSONLを読み、数値を再確認
5. `actions.js`、`act.js`、`agent.js`、`needs.js`、`social.js`の現仕様を確認
6. 実装前に、provenanceとreasonCodeの仕様を小さく確定
7. 新branchを作成し、単体テストから実装
8. サーバーを起動する前にユーザーへ知らせる

ユーザーの要望は「他人の物を絶対に取らないこと」ではない。「取ることを許しつつ、その理由が、利己心、必要性、許可、誤認などとして観察・検証可能であること」が中心である。
