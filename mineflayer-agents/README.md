# mineflayer-agents — 軽い LLM で動く Minecraft のボット (段階1: 1人)

研究方針メモ 13章 (2026-10-30) の最初の到達点に向けた実装。mineflayer でプレイヤーとして接続したボットを、
2B 前後の LLM で「会話と行動」させる。各ボットは**完全情報を持たない** (自分で見た・やった・聞いたことだけを知る)。

## 構成

```
run.js                 起動 (設定の読み込み → Agent)
src/agent.js           1ボット = observe → decide → act → record のループ
src/observe.js         観測: 自分の状態・視界 (半径16、目から視線が通るブロック/エンティティ)・聞こえた話
src/memory.js          記憶: 見た場所 (8x8 の格子でまとめる)・行った場所・やったことと結果・聞いた話。上限つき、JSON に保存
src/actions.js         その瞬間にできる行動の一覧を作る / decider の出力を一覧と突き合わせる
src/act.js             行動の実行 (mineflayer-pathfinder)。失敗は結果として返す。1行動ごとにタイムアウト
src/prompt.js          2B 向けの短いプロンプト (system は固定にしてキャッシュを効かせる)
src/parse.js           壊れた JSON への対処 (フェンス・前後の文・末尾カンマ・打ち切り等)
src/deciders/          decider (差し替えられる部品)
  llm.js               OpenAI 互換の窓口 (llama-server 等)。act モード / talk モード
  split.js             会話担当と行動担当を分ける構成 (行動担当を Jev に差し替える想定)
  mock.js              scripted / random (テスト・比較用)
src/recorder.js        1ループ1行の JSONL (runs/、git に入れない)
configs/*.json         目標とペルソナの設定
tools/summarize_run.js JSONL の集計 (成功/失敗・判断の時間 p50/p95・プロンプトの長さ・壊れた率)
server-fabric/         試験用 Fabric サーバーの設定と start/stop (/root/mc-server-fabric にコピーして使う)
llm/                   llama-server (CPU) の用意と start/stop (/opt/llama.cpp にコピーして使う)
```

## 起動

```bash
# 1回だけ
bash mineflayer-agents/server-fabric/setup.sh     # /root/mc-server-fabric
bash mineflayer-agents/llm/setup_llama.sh         # /opt/llama.cpp, /opt/models
(cd mineflayer-agents && npm install)               # postinstall で patches/ (mineflayer-pathfinder の returningPos の修正) が当たる

# サーバーと LLM
bash /root/mc-server-fabric/start.sh              # 停止: stop.sh。入力: echo '<cmd>' > cmd_pipe、出力: console.log
bash /opt/llama.cpp/start_llama.sh                # 127.0.0.1:18081 (OpenAI 互換)。停止: stop_llama.sh

# ボット
node mineflayer-agents/run.js --config mineflayer-agents/configs/wood_pickaxe.json --minutes 15
#   --llm http://HOST:PORT (または環境変数 LLM_BASE_URL)  --name Jiro  --decider llm|split|random
node mineflayer-agents/tools/summarize_run.js mineflayer-agents/runs/<file>.jsonl

# テスト (模擬の LLM・模擬の観測)
(cd mineflayer-agents && npm test)
```

試験用ワールドは seed 1030 (雪のトウヒの森)。試験では `setworldspawn 60 65 -58`・`gamerule spawnRadius 0` にして、
毎回同じ場所 (木の多い所) から始めた。ボットの持ち物と位置を戻すには、ボットが入っていないときに
`world/playerdata/<オフラインUUID>.dat` を消す。

記憶は `data/memory/<名前>.json` に残る (再起動しても続きから)。消せば何も知らない状態から始まる。

## 設計の判断

- **完全情報にしない**: 視界は半径 `visionRadius`(16) 以内で、目から raycast して最初に当たるブロックだけ
  (種類ごとに近い 12 個を調べ、見えた最大 5 個を持つ)。木の葉の中の幹や壁の向こうは見えない。エンティティも視線が通るものだけ。
  チャットは発言者が `hearRadius`(48。2026-11-06 に 24 から広げた) 以内にいるときだけ聞こえる (届かない発言は捨てる)。
  距離は相手が見えているか (視線) を問わず、サーバーが送ってくる相手の位置 (`bot.players[名前].entity`、一時的に無ければ
  `positionStaleMs` まで最後の位置) だけで決める (`src/people.js`)。follow・give・go_to(人) の対象になる「近くの人」も
  `peopleRadius` (既定は hearRadius) 以内なら見えていなくてよい (call・ask は hearRadius)。サーバーがプレイヤーの位置を送る距離
  min(512 × `entity-broadcast-range-percentage`/100, (`view-distance` − 1) × 16) をこれらより大きくしておく。
  サーバーのプレイヤー一覧は全員の名簿としてはプロンプトに入れない。
- **踏破の共有はしない (既定)**: `act.explore.scope` の既定は `self` (自分が行った所だけで「行ったか」を決める)。
  `runs/<id>/explored/` には分析のために書き出すが、読むのは `scope: all` のときだけ。場所の共有は【発見】・近くの声・
  聞いて答える の会話だけで起きる (`tools/summarize_run.js` の `placeShare` で数える)。
- **経験の記憶**: 目印 (原木・作業台・水・鉱石など、`notable`) を見るたびに場所を覚える。上限 40 か所、プロンプトには近い 8 か所を
  `M1..` の番号付きで入れ、`go_to` の引数にできる。行ってみて無かった場所は忘れる。やったこと 6 件・聞いた話 5 件をプロンプトに入れる。
- **decide は「一覧から選んで引数を埋める」**: 行動の一覧と、行動ごとの引数の候補をプログラムが毎回作る。
  llama-server の `json_schema` で、行動ごとに引数の候補まで文法で縛る (`constrainArgs`)。2B でも一覧にない行動・引数を出せない。
  縛りを外したとき (`constrained:false`) のために、解析の側でも壊れた JSON・表記ゆれに対処する。
  Jev のような選択式のモデルは、この一覧をそのまま選択肢として渡せばよい (decider を差し替える)。
- **会話と行動を1つのモデルで**: 出力の `say` で、行動しながら話す。`say` 行動だけを選ぶこともできる。
  分ける構成は `decider.type: "split"` (行動担当と会話担当を並行に呼ぶ)。
- **think 欄**: 2B は「原木を持っているのに原木を集め続ける」ことが多かった (同じ観測で 6/6 回)。行動の前に短い考え (`think`) を
  書かせると、板材を作る方を選ぶようになった。出力が数十トークン増える (判断が約 1〜2 秒遅くなる)。設定で切れる。
- **目標とペルソナは設定ファイルで与える**: `goal.text`・`goal.hints` (ゲームの知識)・`goal.steps` (手順と、済んだかの判定)・
  `goal.success` (達成の判定)、`persona.name/personality/speech`。
- **手順の進み具合をプログラムが書き出す** (`src/progress.js`): 2B は持ち物の行を読んで手順を追えず、原木 41 個・作業台 4 個を持ったまま
  15 分間、原木集めと板材作りを繰り返した (作業台を一度も置かなかった)。`goal.steps` の各手順の `doneWhen`
  (自分の持ち物か、今見えているものだけで判定) から「済」「次はこれ」を付け、プロンプトの最後に置く。
  作業台を持っていて近くに無いときは、place の説明に「置くと wooden_pickaxe が作れる」と添える (レシピの知識)。
  craft の候補で目標の物には「目標の物」と印を付ける。
- **行動は小さく、失敗は記憶へ**: 足場を積まない (高すぎる原木は狙わない。手の届く高さに見えないブロックは collect の候補に出さない)。
  1つの目標に 15 秒、1行動に 15〜60 秒の上限。失敗の理由 (「道が見つからない」など) が次の判断の材料になる。
- **pathfinder の打ち切りは `setGoal(null)`**: `pathfinder.stop()` は次の `goto` まで止める旗を残すことがあり、
  打ち切りの後の explore が毎回即座に失敗した。
- **目標を達成しても止めない** (`loop.stopOnGoal: false`): 達成後の振る舞いも見るため。試験では達成後に作業台や斧を作り続けた。
- **同じ失敗の繰り返しを止める**: 2B は「同じ失敗を繰り返さない」という指示を守れず、届かない原木を 7 回続けて選んだ。
  直近 4 回の中で同じ行動・引数が 2 回失敗したら、その選択を一覧から一時的に外す (`loop.failWindow` / `loop.failRepeat`)。
  経験から「それは無理だった」と分かっている、という扱い。

## 前期の資産との関係

研究室の前期のリポジトリ
[atsushi-chiba/Graduation-research-voyager-minecraft-agents](https://github.com/atsushi-chiba/Graduation-research-voyager-minecraft-agents)
(Voyager の fork、MIT License, Copyright (c) 2023 MineDojo Team) の `voyager/env/mineflayer/` を参考にした
(mineflayer 4.37 系と pathfinder の組み合わせ、チャットの連投の抑え方、状態の要約の形)。コードはそのまま写していない。
Voyager の「LLM がコードを書く」方式は 2B では無理なので、構成は新しく作った。改造版 collectblock は TypeScript のビルドが要るため使わず、
掘る・拾う処理は `src/act.js` に小さく書いた。

mineflayer 4.37 は Node 22 以上を求めると宣言しているが、panama の Node 20.19 で動いている (npm の警告のみ)。

---

# 最初の「1つの設定」(方針メモ 16章)

全員に同じ目標「仲間と協力して、夜までに拠点(小屋)を作り、食べ物を確保する」(`configs/first_setting.json`)。
行動は Jev、発言は 2B (Gemma 4 E2B)、社会性は AgentSociety を基にした最小限、記憶は時間で忘れて大事なものは残る、
外からの助けは①〜③、困ったら周りに聞く。

## 起動

```bash
(cd mineflayer-agents && npm install)
# 世界 (一度だけ): サーバー停止中に新しいワールドへ切り替え → 起動 → 最寄りの平原を出現地点に
bash mineflayer-agents/server-fabric/first_setting_world.sh prepare   # level-name=world_first_setting, seed 20261102, peaceful
bash /root/mc-server-fabric/start.sh
bash mineflayer-agents/server-fabric/first_setting_world.sh init      # locate biome plains → setworldspawn、spawnRadius 0、昼夜あり
bash /opt/llama.cpp/start_llama.sh                                    # 2B (発言と答え)
# 実行のたびに朝へ戻す (夜まで約10分、等倍)
bash mineflayer-agents/server-fabric/first_setting_world.sh morning
node mineflayer-agents/run.js --config mineflayer-agents/configs/first_setting.json --agents 1 --minutes 5
#   --agents 5 / 30   --decider llm (Jev を使わず 2B で行動)   --max-jev-tokens 3000000   --stagger-ms 1500
node mineflayer-agents/tools/summarize_run.js mineflayer-agents/runs/<時刻>/ --text
```

### Jev の提供元 (openrouter / typesafe) と API キー

Jev は **OpenRouter 経由** (既定、2026-11-06 ユーザー決定) か **TypeSafe 直** で呼ぶ。どちらも System One API (`{model, state, questions}`) で、答えの形は同じ。

| 提供元 | 窓口 | キー (表示・記録・コミットしない) |
|---|---|---|
| `openrouter` (既定) | `https://openrouter.ai/api/v1/systemone` | 環境変数 `OPENROUTER_API` → `/root/.config/openrouter.env` の `OPENROUTER_API=...` (か `OPENROUTER_API_KEY=...`) の1行 → 環境変数 `OPENROUTER_API_KEY` |
| `typesafe` | `https://api.typesafe.ai/v1/systemone` | 環境変数 `TYPESAFE_API_KEY` → `/root/.config/typesafe.env` の `TYPESAFE_API_KEY=...` の1行 |

- 環境変数の `OPENROUTER_API_KEY` はファイルより後に見る (シェルの設定に古いキーが残っていて 401 "User not found" になったため。2026-11-06)。
  別のファイルは `OPENROUTER_ENV_FILE=/path` / `TYPESAFE_ENV_FILE=/path`。
- 切り替え: `--jev-provider openrouter|typesafe` か config の `decider.jev.provider`。モデルは `decider.jev.model` (既定 `jev-latest`)、
  提供元ごとに固定するなら `decider.jev.providers.openrouter.model: "typesafe/jev-1.14"` のように書く (`--jev-model M` は使う提供元のモデルを変える)。
  OpenRouter は `jev-latest`・`jev-1.14`・`typesafe/jev-1.14`・`~typesafe/jev-latest` を通し、返るモデル名は `typesafe/jev-1.14-20261014`。
  TypeSafe 直の綴り `jev-1.14.0` は OpenRouter では 400 なので `typesafe/jev-1.14` に直して送る。
- キーが無いのに `decider.type: "jev"` なら起動しない (`--jev-provider` を替えるか `--decider llm`)。
- OpenRouter の応答は TypeSafe 直の形に `id`・`provider` ("TypeSafe")・`usage.cost` (US ドル) が足される。記録の `jev` に `via` (提供元)・`id`・`provider`・`model`・
  `costUsd`・`bodyBytes` を残し、run.json の `usage.jev.costUsd` は `usage.cost` の合計 (返らない呼び出しは入力トークン × $0.042/100万)。
- 答えの `type: "refusal"` (値も確率も無い) は答えが無いとして扱い、記録の `jev.refusals` に質問の名前を残す。`next_action` が refusal なら行動を選べなかった扱い
  (Jev が失敗したときと同じく look_around。look_around の無い survival_3days は search → explore、どちらも無ければ explore の方角を1つ作る。wait にはしない)。ゴールの案の noul が refusal なら P = 0。
- 再試行: 429・502・503・524・529 と、402 のうち本文の `limit_source` が in-flight 予算のもの (`Retry-After` に従う)。
  **402 の残高不足は再試行せず、全員を止める** (エラーの文に「残高 (クレジット) が足りない」)。
- 送る本文が 32,000 バイトを超えると OpenRouter は黙って long-context モード (遅く・精度が下がるとされる) で走らせるので、記録に `jev.longContext` を残し、
  最初の1回は警告を出す。`--max-jev-tokens` (入力トークンの上限) は提供元によらず今まで通り効く。
- 実測 (2026-11-06、記録の場面 40 個 × 各経路 2 回): 答えの一致は経路の差と呼ぶたびの揺れが同じ程度 (下の「Jev の提供元の比較」)。
  OpenRouter 経由は 1回 p50 335ms (TypeSafe 直 162ms)。

## 構成 (段階1に足したもの)

```
src/deciders/jev.js  Jev の decider (1回の呼び出しに Choice・Noul・Score をまとめる)
src/jev_client.js    System One API の窓口 (提供元 openrouter/typesafe・キーの読み込み・再試行・402 で止める・refusal・本文の大きさ・同時数の制限)
src/usage.js         使用量 (Jev の入力の文字数・トークン・応答時間、2B の回数・プロンプトの長さ) と、Jev の入力トークンの上限
src/talker.js        2B で発言と答えを作る
src/social.js        感情・人間関係 (数値はプログラム、2B には短い言葉)。欲求とストレスは needs.js
src/needs.js         人としての欲求 (空腹・眠気・安心・つながり・認められたい・性格ごと) とストレス。ゲームの満腹度とは切り離す
tools/sim_needs.js   欲求とストレスのシミュレーション (bot なし。食べない・寝ない・夜に外 などで1日を進める)
src/ask.js           周りに聞く仕組み (困りごとの検出・チャットの形・記憶の範囲で答える・使ったかの判定)
src/hut.js           小屋の設計図 (5x5・壁2段・屋根、入口あり、55 か所) と進み具合
run.js               1プロセスで --agents 人。使用量と 2B は全員で共有。記録は runs/<時刻>/ に1人1ファイル + run.json
```

## 行動 (mineflayer)

その瞬間にできる行動の一覧をプログラムが毎回作り、Jev が「行動:引数」の形で1つ選ぶ。

| 行動 | 一覧に出る条件 | 実行 (mineflayer) |
| --- | --- | --- |
| collect | 見えていて掘れて手の届く高さ (足元から4段まで) のブロック。拠点の小屋の場所は除く | pathfinder で近づき dig、落ちた物を拾う (3個) |
| go_to | 見えている目印・覚えている場所 (M番号、拠点を含む)・見えている人。collect できる種類と、手の届く高さより上のものは出さない | pathfinder。着いたあと目標から 3 ブロックより遠ければ失敗 (「近づけなかった」「届かなかった」) |
| pillar (新) | 目印で掘れる物が、手の届く高さより 1〜4 段上にしか見えず、足場にするブロックを持っている。足場は土 → 丸石 → 石の類 → 板材 → 原木の順に選ぶ (板材・原木は小屋の材料なので後回し) | 目標の真下近くまで歩き、跳びながら足元にブロックを置いて登る。**降りるときは何もしない (足場は残す)**: 次に歩くとき pathfinder が飛び降りる。4 段までなので落下の傷は小さい。登ったあとの採掘は collect |
| pick_up (新) | 落ちている物 (原木に限らない) が見える | その物の所へ歩いて拾う。collect のあとに拾い損ねた物にも使う |
| explore | `act.explore.mode` が `basic` (既定・段階1) なら東西南北。`varied` (first_setting) なら 8方位 × 近く 12m / 遠く 35m、`unvisited` (まだ行っていない一番近いマス、6マス以内)、`random` (でたらめな方へ 15〜35m) の 18 個。方角の選択肢の文に、行き先のマスに行ったことがあるか (「行ったことなし」「行った 3回・6回前」) を入れる | GoalNearXZ で歩く。記録の `result.explore` に種類・行き先・予定と実際の距離・新しいマスだったか |
| search (新、`act.search`) | ゴールの道筋に要る物 (掘る元のブロック・倒す生き物・畑の水) が見えていない。方角は点の高い `choices` 個と、割り込みのあとの「このまま進む (continue)」 | `scanMs` ごとに周りを見ながら GoalNearXZ で歩き、道筋の物・敵・呼ばれた/頼まれた・しばらく見ていなかった人が見えたら区切る (下の「探しながら歩く」)。記録の `result.search` |
| craft | 今の持ち物で作れる物 (作業台が見えれば作業台の要る物も) | recipesFor → craft |
| build (新) | 拠点を知っていて、板材・原木・丸石・土を持っている | 設計図の空いている所のうち隣に支えがある所へ、GoalPlaceBlock で近づき placeBlock。1回に4個まで。座標は選ばせない |
| hunt (新) | 牛・豚・羊・鶏・兎が見える | 追いかけて attack、落ちた肉を拾う (30 秒まで) |
| ask (新) | 困っていて (同じ行動・引数が直近4回で2回失敗)、聞こえる範囲 (24) に人が見える | チャットで聞いて、答えを最大 45 秒待つ |
| place / eat / look_around / wait | 段階1と同じ | |

拠点は、出現地点から南へ 6 ブロックの地面 (全員が最初から知っている。忘れない)。小屋の進み具合は、拠点が視界 (16) 内にあるときだけ分かる。

## Jev への1回の呼び出し

`state` (JSON): `you`・`personality`・`goal`・`knowledge` (① goal.hints と facts.json の関係するもの)・`actions` (行動の説明表)・`plan` (②③ 手順と「済」「次はこれ」)・`now` (観測の文)・
`feelings` (社会性の言葉)・`memory` (選んだ記憶)・`last_result` (直前の行動の結果)・`heard_now`・`troubled` (困りごと、あるときだけ)。
質問の文は英語 (公式の資料で英語が一番正確とある)、状態は日本語のまま。

| 名前 | 型 | 中身 |
| --- | --- | --- |
| next_action | choice | 一覧の「行動:引数」(例 `collect:oak_log`、`build:oak_planks`、`ask:Hanako`) から1つ。選択肢は最大 255 |
| remember | score (0〜4) | 直前の出来事を覚えておく価値 → 記憶の大事さ (score/4) |
| talk | noul | 今、近くの人に話しかけるべきか。人が見えるか何か聞こえたときだけ聞く |
| rel_0.. | score (0〜4) | 今聞こえた相手ごとに、その人への気持ちがどう変わったか → 好感 ±12 |

使用量は `usage.input_tokens` (返らなければ文字数から推定し、推定と記録)。費用は入力 100万トークンあたり $0.042。

### 選択肢の文と2段の呼び出し (`decider.jev.twoStage`)

- 行動の説明は `state.actions` (`{ 行動: 説明 }`) に種類ごとに1回だけ書き、選択肢の文は `行動: label` だけにする
  (前は選択肢ごとに説明を繰り返し、1回 約3,900トークンのうち6割強が選択肢と質問だった)。
- 対象が `maxDirect` (3) 個以下の行動と `direct` の行動 (eat・sleep・flee・set_base・ask) は1回目にそのまま並べる。
  ほかは分類1つ (`collect:*` など、文は「collect: 7個から選ぶ (stone, jungle_log, ...)」) にまとめ、選ばれたら2回目の呼び出し
  (`target` の choice だけ) で対象を選ぶ。2回目の state は `goal`・`plan`・`action` (その行動の説明)・`inventory`・`knowledge`
  (その行動か対象の名前に当たる事実、`knowledge.stage2Max` 個まで)・`last_result`・`troubled` (その行動のものだけ)。
  remember・talk・goal_done・rel は1回目だけ。2回目が失敗・一覧にない答えなら分類の先頭の対象にする (`jev.stage2.fallback`)。
- 記録の `jev.calls` (1か2)・`jev.inputTokens` (合計)・`jev.stage1`・`jev.stage2`。使用量 (run.json の `usage.jev`) に
  `byStage`・`decisions`・`callsPerDecision`・`inputTokensPerDecision`。`twoStage: { "enabled": false }` で1段に戻る。
- 状態が変わらなかった重み: 分類は中の対象の回数の一番少ないもの、2回目は対象ごとに掛ける。

### 知っていること (`knowledge`、`knowledge/facts.json`)

`[{ id, text, items, actions, always }]`。`items` は名前 (先頭 `*` は後方一致 `*_planks`、末尾 `*` は前方一致 `wooden_*`)。
持ち物・見えているブロック/生き物/落ちている物・選択肢の対象・plan の英語名に当たる事実と `always` の事実を、1回に `knowledge.max` (8) 個まで
`state.knowledge` に出す (`goal.hints` に残したものは別に出し、同じ文は二重に出さない)。設定に `knowledge` が無ければ使わない
(first_setting などは goal.hints のまま)。ファイルが無い・空・壊れていても動く。聞かれたときの答えの材料にも使う。
仕様の事実だけを書き、評価語・使い方の指示は書かない (test/knowledge.test.js で確かめる)。記録の `factsShown` に出した id。
実行の合計が `usage.maxJevInputTokens` (既定 300万) に達したら全員を止めて終える (`token_cap` を記録)。

## 2B を呼ぶとき

- **発言**: Jev の talk ≥ 閾値 (0.6 + (0.5 − 社交性) × 0.2) のとき。行動は待たない。プロンプトは人物・目標・気持ちと関係・近くの人・今聞こえた話・覚えていること・これからする行動。出力 `{"say"}` を json_schema で縛る (60字まで)。
- **答え**: 聞かれたとき。自分の記憶 (成功したこと・見た場所・教わったこと) と知っていること (goal.hints) から質問に関係するものを最大5件選び、それだけを渡す。何も無ければ 2B を呼ばずに「ごめん、それは分からない」。
- `--decider llm` のときは段階1と同じく 2B が行動と発言を決める (呼び出しは `act` として数える)。

## 記憶 (14章)

- 強さ = 2^(−経過ループ数 / (halfLife × (1 + impBoost × 大事さ)))。halfLife 40、impBoost 6、強さ 0.08 未満で忘れる。大事さ 0 の記憶は約 146 ループ、大事さ 1 は約 1000 ループもつ。
- 大事さは Jev の remember。Jev がないときはルール (失敗 0.35、目標に関わる成功 0.5、見回し・待つ 0.05、ほか 0.2)。教わったことは 0.8 (「分からない」は 0.3)。拠点は忘れない。
- プロンプトに入れるのは 20 件 (場所は近い順に 6 件まで、残りを「強さ × (0.5 + 大事さ)」の順。最新のやったこと2件は必ず)。

## 社会性 (15章) と AgentSociety から変えたところ

| AgentSociety の部品 | ここでの扱い |
| --- | --- |
| 人物像 (属性) | 名前・性格・話し方と、研究室の `personas.js` の気質 (bravery・empathy・obedience・greed・sociability) の形を借りた。軽くした |
| 感情 (6種 0〜10) | そのまま 6種 0〜10。ルールで上下 (成功で喜び、失敗で怒り、続けて失敗で悲しみ・嫌悪、初めて会うと驚き、夕方に小屋がないと恐れ)。1ループごとに基準値へ 15% 戻る。LLM で更新しない (軽くした) |
| 欲求 (マズロー) | needs.js。ゲームの仕組みに寄せず、人としての欲求を持たせる (マイクラはそれを満たす手段)。基本は空腹 (時間で必ず増え、食べた物の満腹度で減る)・眠気 (起きている間増え夜は速い。ベッドで消え、床で休むと少し。寝ずに夜を越すと残る)・安心 (暗い・夜に外・敵・ダメージ・殺された・知らない所に一人 で下がり、寝床・囲まれた所・関係の良い人・明るい で上がる)。その上につながり (話しただけでは満たされない)・認められたい・性格ごと (好奇心・欲・世話)。上の欲求は基本が満たされていないほど弱い。満たされない欲求があるとストレスがたまり (長いほど急に)、性格に合わせて怒り・悲しみ・恐れに出る。係数は config の `needs` と `personas[].needs` |
| 考え (話題ごとの態度) | 外した |
| 記憶 (出来事・知覚の流れ) | 14章の忘れる記憶に置き換えた。教わったこと (誰から・いつ) を足した |
| 人間関係 (0〜100) | 相手ごとの好感 0〜100・信頼 0〜1。研究室の `social_dynamics.js` の「助けた・断られた」の数え方を借りた。好感は Jev の Score とルール (教わった +8、無視された −5、頼られた +1〜3) |
| 移動・経済・家族 | 外した (Minecraft の行動に置き換わる) |
| 周りに聞く | 足した (14章) |

研究室の `personas.js`・`social_cognition.js`・`social_dynamics.js` は読んだだけで、変更も読み込みもしていない。
2B には数値を渡さず「お腹がぺこぺこ。昨夜は寝られなかった。眠い。周りが暗いし、夜なのに外にいるので落ち着かない。かなり参っている。いらだっている。Hanakoとは仲が良い。前にやり方を教えてくれた」の形で毎回渡す (Jev の `feelings` も同じ)。
help.goalPlan のゴール作りには、これに加えて「いちばんつらいこと」と「周りの人」(各人への関係・最近の発言・最近拾った/壊した物・今どこにいるか) を渡し、2B がゴールを why (何のため)・need (満たしたいもの) と一緒に書く。手順を全部こなしても need が下がっていなければ手順を作り直す。

## 周りに聞く仕組み (14章)

困っている (同じ行動・引数が直近4回で2回失敗、同じことは 10 ループ聞かない) → 一覧に ask → チャットで
`Hanakoさん、教えて: wooden_pickaxeの作り方が分からない(「…」で失敗した)` → 聞こえた相手 (24 ブロック以内) が
`Taroさん、答え: …` と答える → 聞いた側は答えを記憶 (knowledge: 誰から・ループ番号・昼/夜) に入れる →
その後 6 ループのうちに、同じ行動をやり直して成功したか (`retried_ok`)、答えに出てきた行動・物を選んで成功したか (`followed`) を記録。
記録: 聞いた側に `ask` / `ask_reply` / `ask_timeout` / `answer_use`、答えた側に `answer` (使った記憶と 2B のプロンプト)。

## 探索のマス

行ったことのある場所を 16×16 のマス (`memory.limits.exploreCell`) で覚える (`memory.cells`: マスごとに入った回数・最後にいたループ)。
毎ループの観測で今いるマスを記録し、前のループと違うマスに入ったときだけ回数を増やす。時間で忘れる (記憶と同じ強さの式。忘れた数は `forgotten` に入れない)。
マスの件数や一覧はプロンプトに入れず、explore の選択肢の文にだけ使う。summarize_run は記録の位置から「訪れたマスの数」を数える (忘れとは関係なし)。
少し前の状態に戻る往復は、下の「状態が変わらない繰り返し」の正味の変化 (`noChange.net`) で見る。

## 探しながら歩く (`act.search`、src/search.js) と選択肢の重み (`choiceWeights`、src/choice_weight.js)

2026-11-07 ユーザー決定 (「大体の人が固まって話すだけ」への対応)。
- **search**: ゴールの道筋に要る物が見えていないときだけ出す。歩く距離は探検の反応の強さ T (division の exploring) で `minDist`〜`maxDist`。
  歩き始めに見えていた物では止まらない。区切りの種類は `interrupts` (`hostile` 敵が `hostileRadius` 以内・`called` 自分の名前と、呼ぶ/聞く/頼む/誘う形の発言・
  `goal` 道筋に出るブロック/生き物・`person` `newPersonTicks` 判断のあいだ近くにいなかった人)。見つけたブロックは `memory.notePlace` で場所として覚える (次の判断の go_to に M番号で出る)。
  区切ったあと `continueTicks` 判断のあいだ「このまま進む」を出し、次の判断で寄り道したか (`searchAfter.choice`: detour / continue / other_direction) を記録する。
- **方角の散らし方**: 8方位それぞれ、行き先までのマスのうち「自分も行っていない・ほかの人が行ったとも分かっていない」割合 + 人ごとの好みの方角 (名前から決まる、`jitter`)。
  「ほかの人が行った」は見聞きした範囲だけ: 人から聞いた場所 (memory.places の from。【発見】・近くの声) と、近くにいた人の居たマス (`memory.extra.othersSeen`)。全員の踏破は見ない。
  explore の方角の文にも、行き先のマスについて「Ken が言っていた場所がある」「Mai を見かけた」を足し、least_explored はそのマスも数える。
- **選択肢の重み**: Jev の確率に掛けて足して 1 にし、一番を選ぶ (noChange の 0.5^n と同じ所)。go_to(人)・follow × `people` (0.4)。ゴールがその人なら掛けない、
  `exemptTicks` 判断以内にその人に呼ばれた/頼まれた/誘われたら `called` (1)。ゴール・道筋に関係しない覚えた場所 (M) への go_to × `memPlace` (0.7)。記録は `jev.reweight.choiceWeights`。
- 集計: `tools/search_stats.js` (summarize_run の `movement`)。重みの確かめ: `tools/weight_offline.js` (記録の Jev の上位3つに掛け直す)、`tools/weight_check.js` (記録の場面を作り直して Jev を呼ぶ)。

## 状態が変わらない繰り返し (実験的、`help.noChange`)

失敗の繰り返し (ask の条件) だけでは、「着いた」の成功が続いても何も起きないループ (1人5分の試験で go_to が 166 回続いた) を拾えない。
そこで `help.noChange: true` のとき (first_setting は有効、既定は無効):

- 行動の前と後で、持ち物・位置 (1 ブロック以内は同じ)・小屋の埋まった数を比べる。同じなら記録の `stateChanged: false` (この記録は設定に関係なく常に残す)。
- 同じ行動・引数で状態が変わらなかったのが直近 `noChange.window` (4) 回で `noChange.repeat` (2) 回 → 困っている (`troubleKinds: "noChange"`)。
  失敗の繰り返しと同じく ask へつながる。質問の文は「…が分からない(何度やっても何も変わらなかった)」。
- 負の重み: 直近 `noChange.weightWindow` (6) 回で状態が変わらなかった回数を n とし、Jev の choice の確率に `noChange.weight` (0.5) の n 乗を掛けて、
  いちばん高いものを選び直す。Jev の元の答えは `jev.choice`、選び直しは `jev.reweight` (`from` / `to` / `changed` / 掛けた回数) に残る。
  state に文を足す方法 (b) にしなかったのは、プロンプトが増えず、重みが効いたかが記録で1件ずつ追えるため。
- say・ask は数えない。summarize_run の `noChange` と `--text` の行に回数が出る。
- **正味の変化** (`noChange.net`、既定 true): 1回ごとの判定は、毎回 持ち物±1・高さ±1 変わる繰り返し (足場を積む → その足場を掘る、
  作業台を置く → 掘る) をすり抜ける。そこで直近 `netWindow` (10) 回前の状態と今を比べ、持ち物の差の合計 ≤ `invTol` (1)・
  位置の差 < `moveDist` (8m)・新しいマスに入っていない・|置いた − 掘った| ≤ `blockTol` (1) なら、その間に `netRepeat` (2) 回以上出た行動を
  「何度やっても何も変わらなかった」扱いにする (困りごと・負の重みは上と同じ。重みの回数は窓の中の回数)。窓全体では何か変わっていても、
  繰り返した行動1つか2つの組だけを足して正味0 (回数の合計 `netMinLoops` (4) 以上) なら、その行動だけを同じ扱いにする。
  attack・flee・sleep・say・ask は数えない (`netExempt`)。記録の `netNoChange` (`keys`・`counts`・`scope`)。
  記録を読み直して確かめる: `node tools/replay_nochange.js runs/<時刻>/`。

## 外からの助けの記録

`help` (①hints・②steps・③progress・askOthers・④excludeFailures・noChange) を設定に持ち、各記録の `start` に残す (noChange の値は `noChangeCfg`)。first_setting は ①②③ と聞く・noChange、④なし。
①hints (`goal.hints`) には仕様の事実 (レシピ・小屋の形と材料・肉が手に入ること) だけを書き、扱い方・勧め・優先順位は書かない (2026-11-03 ユーザー決定)。
build の原木の選択肢には「jungle_logx2(板材にすると8個)」と換算を事実として添える。原木と板材のどちらを置くかは Jev が選び、
summarize_run の「build で置いた物」(原木・板材・そのほかの個数と回数) で数える。
段階1の設定 (`wood_pickaxe.json`) は `help` を持たないので、これまでどおり ①②③④ (聞くなし) で動く。

# 5人で「3日生き延びる」(`configs/survival_3days.json`)

全員に「この世界で3日生き延びる。」だけを与える (協力・小屋の話は書かない)。normal・昼夜あり・等倍、60分 = 3日。
小屋 (hut.js・build)・② 手順・③ 進み具合は使わない (`help.hut/steps/progress: false`)。

- **自分で目標を決める** (`help.selfGoal`、`src/selfgoal.js`): 最初・済んだ・困りごとが新しく出た・30ループごとに、2B が
  状態・持ち物・記憶・① から「今の目標と 2〜4 個の段取り」を書く (json_schema)。Jev の state の `plan` に入れる。
  済んだかは Jev の noul `goal_done` で毎回聞き、0.7 以上で次のループに書き直す (2B の呼び出しを増やさないため)。記録は `self_goal`。
- **ゴール → 逆向きの手順 → 1段ずつ** (`help.goalPlan`、`src/goalplan.js`。survival では selfGoal の代わりにこちらを使う):
  2B がゴールを1つ決め (達成するか捨てるまで変えない)、ゴールから逆向きにさかのぼって (`needs`) 最初にやる手順から並べる (`steps`、6個まで。
  済んだか確かめられる形の文)。Jev の noul で各手順が facts と行動の一覧でできるかをまとめて聞き、`checkThreshold` 未満の手順だけ 2B が
  書き直す (`maxRewrites` 回まで)。行動を選ぶ Jev の `plan` にはゴールと今の手順 (何手順目か) だけを出し、noul `step_done` ≥ `stepDoneThreshold`
  で次の手順へ。困りごとが `troubleTicks` 判断続く・今の手順が `stepPatience` 判断進まないと残りの手順だけを作り直し、作り直しが `abandonAfter` 回を
  超えたらゴールを捨てる。一定判断ごとの書き直しはしない。2B の材料: 今の様子・時間と夜までの目安・関係する facts・行動の名前と説明・覚えていること・
  これまでのゴールと結果。記録は event `goal_plan` (kind: goal/steps/check/rewrite/plan/advance/rebuild/goal_done/abandon)、summarize_run の `goalPlan`。
- **ほかの人が拾った・壊したこと** (`others`、`src/others.js`): collect・pick_up・attack・hunt の間に近く (visionRadius) でほかの人が拾った物
  (サーバーの collect) と壊したブロック (掘っている途中の様子が見えていたマスが空気になった / すぐ壊れるブロックはすぐ近くに1人だけ居たとき。葉は除く)
  を、結果の文にそのまま足す (例: 「jungle_logを3個掘って0個拾った。Kenがjungle_logを2個拾った」)。記憶にも入る。`result.others` にも残す。
- **使う側の声** (`toolWant`、`src/toolwant.js`・`src/toolfacts.js`。2026-11-07): 道具のやりにくさを物ごと (stone_axe など) の不満にする
  (掘るのに時間がかかった・石を素手で取れない・道具が壊れた・耐久が少ない)。声にするかは 不満 × 言い出しやすさ (性格の表 `toolWant.voice.traits`・
  仲の良い人が近く・同じ物を何度も頼んだ) の反応しきい値で、独り言 (文の頭に「(ひとりごと)」、`mutterRadius` m まで)・近くの人に頼む・全体に頼む。
  文は文を作る LLM (`voice_*`)。聞いた人では物単位の刺激 (`division.items`) になり、その物を作る・渡す (渡す相手の分)・共有のチェストに入れるゴールの T に効く。
  共有のチェストの道具の数・使う人・壊れた回数からの足りなさも同じ刺激に。先の道具切れは `needs.anticipate.tool` (耐久の残り・使う速さ・予備)。
  道具が壊れたは entity_status 47 (自分・見えた人) と collect の持ち物の減り。記録は event `tool_voice`・`tool_want`・`tool_break`・`tool_back` と
  毎判断の `toolWant`・`division.sItem/stock`。集計は summarize_run の `toolVoice` (`tools/toolvoice_stats.js`)。確かめ: `node tools/toolvoice_demo.js [--mock]`。
- **1段で選ぶ**: survival は `decider.jev.twoStage.enabled: false`。代わりに use_on (`act.maxUseChoices` 12) と give (`act.maxGiveChoices` 8) を、
  近い対象 (人)・数の多い持ち物の組 (順位の和の小さい順) から上限まで並べる (意味のある組み合わせかは判断しない)。
- **拠点**: `world.base: "self"`。最初は無く、`set_base` で自分で決める。大事さ 1 の記憶で、近くに居るあいだは新しくし続ける。
- **行動** (`act.enable` で有効): attack (いちばん強い武器を自動で持つ)・flee・smelt (最大30秒待つ、終わらなければ入れたまま)・
  sleep (夜が明けなければ待ってから起きる)・equip (防具は体、道具は手)。hunt・build は `act.disabled`。collect は道具があれば石・鉱石も。
- **マイクラでできることを広く** (`src/actions_more.js` が一覧、`src/act_more.js` が実行。`act.enable` で有効):
  - `use_on`: 持ち物 (か素手) を見えているブロック/生き物に使う (右クリック)。候補は 持ち物+素手 × (近いブロック5種 + 目印4種 + 生き物4種)、
    `act.maxUseChoices` (既定 200、survival は 12) を超えるときは、近い対象・数の多い持ち物の組から上限まで。何が意味のある組み合わせかは絞らない。プログラムは歩いて狙い、
    ブロックに使って何も変わらなければ、狙ったまま持ち物そのものを使う (バケツ・瓶・ボート)。結果は変わったこと (ブロック・隣・持ち物・乗り物) をそのまま返す。
    弓・雪玉などは離れて狙って撃つ、釣り竿は投げて掛かるまで待つ (`act.fishMs`)。
  - `use_item` (その場で使う。盾は構える)・`dismount`。
  - GUI: `chest_put`・`chest_take` (中身を知らなければ「中を見る」。開けたときの中身を `memory.extra.containers` に覚える)・
    `furnace_take` (出来上がった物 / 全部)・`trade` (一覧を見てから1回分。`memory.extra.trades`)・`enchant` (段を選ぶ)・`brew`・`anvil`。
  - 協力: `follow` (`act.followMs`)・`give` (近くへ行って投げる。1個 / 全部)・`call` (「〇〇、来て (x,y,z)」と言う)。
  - `craftables: "all"` (レシピのある物すべて)、`placeable: [".*"]` (持っているブロックすべて)。collect は作物の育ちきった所を先に掘り、
    名前の違う落とし物 (草 → 種など) も数える。観測の作物は「wheat(育ちきった1/3)」。
- **寝る**: `playersSleepingPercentage 50` (寝ている人が半分以上で夜が明ける、5人なら3人)。① にも事実として書いた。
- **死んだら**: 持ち物はバニラどおり落ち、すぐ生き返って続ける。`death` (死因 = 死亡メッセージの translate・日・時刻・位置) を記録。
- **観測**: 敵は「敵zombie 東5(5m)」、時間は「時間:夜 2日目」。置くときは置く面に視線が通り手が届く所だけ。
- **Jev の state は英語** (`decider.jev.stateLang: "en"`、2026-11-05。`"ja"` で前の日本語の state): 観察 (`self`・`inventory`・`visible`・`nearby`)・
  記憶・気持ち・道筋 (`plan` = `{goal, for_need, why, path, next}`)・知識 (`facts.json` の `text_en`)・拠点・`last_result` を、日本語と同じ値から英語で作る
  (`src/en.js`・各部品の `lang: 'en'`・行動の `descEn`/`labelEn`)。座標は出さず、距離・数は段階の言葉 (here/near/a short walk/far、none/one/a few/some/many)。
  見えるブロックは目印と道筋に出てくる名前だけ、記憶は件数を絞る (`decider.jev.state`)。人の名前・発言・2B が書いた文 (方針・why) は原文のまま。
  2B 向けの文は日本語のまま。行動の結果の文はよく出る形だけ英語に直し、直せない文は原文。比べ方: `node tools/jev_state_compare.js runs/<時刻>/ [--call]`。
- **選択肢の並べ方を毎回変える** (`order.shuffle`、`src/order.js`): Jev の行動の選択肢・2B のゴールの候補・Jev に聞くゴールの案。種は `order.seed` か `--seed`
  (無ければ run.js が決め、event `start` と run.json に残す)。記録 `jev.order = {seed, stream, n}` から `replay()` で同じ並びを作り直せる。
- **ゴールの選び方** (`goalPath.select`、D2A の形): 2B が案を k 個 → もう満たされている案 (持っている数以下の物・もう近くの人・着いている所) と
  たどれない案を外す → Jev に 案 × 今つらい欲求 (上位 `needs` 個) の noul を1回で聞く → 点 = Σ つらさ^power × P の最大 (同点は 2B が先に書いた案)。
  点は event `goal_path` (kind: goal) の `select` に残す。1案のとき (select なし) も、満たされている案は外して聞き直す (kind: satisfied)。
  案の数 `select.k` は提供元ごと (`{local: 4, luna: 10}`)。Jev の1回の質問の数・本文の大きさが `maxQuestions`・`maxBodyBytes` を超えるなら案を分けて並列に呼ぶ。
- **自由記述のゴール** (`goalPath.freeform`、`src/resolve.js`、2026-11-07): 文脈の広い提供元 (luna) では、案の物・状態・人・場所を enum で縛らず自由に書かせる
  (`enabled: 'auto'` で local 以外)。名前は正式名に直す (正式名・表示名・日本語名・表記ゆれ・複数形・打ち間違い・種類違い (木・色) は
  持っている > 見えている > 例 > 手間 の順)。直せない・たどれない・もう満たされている・重複の案は理由を添えて `maxRewrites` 回まで書き直させる。
  状態は今の型 (pen・farmland・lit・walled・chest・planted) に当てはめ、当てはまらない文は type: text (選ぶ前に Jev に「見て確かめられるか」
  「もうそうなっているか」を聞き、ゴールにしたら `textCheckEvery` 判断ごとに「そうなったか」を聞く)。候補の一覧は例として見せる (`maxExamples`)。
  記録は proposals の `written`・`via`・`round`、`diversity` (種類の数・kind・例に無い物・直し方)・`rewrites`。summarize_run の `goalSelect.spread`。
  実際に呼ぶ: `node tools/goalpath_demo.js --select --provider luna --jev-provider typesafe [--k N] [--freeform off] [--examples N]`。
- **記録**: `jev.choice` に選んだ選択肢の確率 `p`・1位÷2位 `ratio`・上位3つ・並びの位置 `pos`。道筋の「次」が今すぐできるかを noul `next_now` で
  同じ呼び出しに聞き (`jev.nextNowP`。行動の選び方には使わない)、選んだ行動が道筋どおりか (`jev.path.match`: step/approach/other)。
  summarize_run の `jevChoice` (分布・位置・できると判定した割合と、そのとき道筋どおりの割合) と `goalSelect`。

```bash
# 世界 (一度だけ): サーバー停止中に新しいワールドへ
bash mineflayer-agents/server-fabric/first_setting_world.sh prepare_survival
bash /root/mc-server-fabric/start.sh
bash mineflayer-agents/server-fabric/first_setting_world.sh init_survival
# 実行 (朝から 60 分)
bash mineflayer-agents/server-fabric/first_setting_world.sh morning
node mineflayer-agents/run.js --config mineflayer-agents/configs/survival_3days.json --agents 5 --llm http://192.168.15.30:18081
node mineflayer-agents/tools/summarize_run.js mineflayer-agents/runs/<時刻>/ --text
# 終わったら (サーバー停止中に) world_first_setting に戻す
bash /root/mc-server-fabric/stop.sh && bash mineflayer-agents/server-fabric/first_setting_world.sh restore
```

行動の実機の試験: `prepare_action_test` → start → `init_action_test` → `node mineflayer-agents/tools/action_test.js [--part base|more|all]` (試験用のボット1人。
`more` は足元を平らにして右クリック・GUI・協力を試し、協力には2人目のボット `Tester2` を出す)。

# 20人で動かす (`--agents 20`)

`configs/survival_3days.json` の personas は20人 (先頭の5人は Taro・Hanako・Jiro・Yuki・Ken のまま。`--agents N` で先頭から N 人)。
名前は英字 (Minecraft の名前、ほかの名前の先頭に含まれない)。性格の文・話し方・気質 (bravery・empathy・obedience・greed・sociability) と
欲求の係数 (`needs`) を人ごとに変え、気質はどれも 0.3 未満と 0.7 以上の人がいて平均 0.4〜0.5 になるようにした。職業・役割は書かない (test/scale20.test.js)。

| 名前 | 性格 (短く) | 欲求の差 |
| --- | --- | --- |
| Taro / Hanako / Jiro / Yuki / Ken | (前のまま) 木こり・世話好き・せっかち・怖がり・話し好き | |
| Mai | 素直、言われたことを信じる | 褒められたい |
| Sota | 無口、一人で黙々 | 人恋しくなりにくい |
| Aoi | 好奇心が強い | 好奇心 0.9 |
| Daiki | 欲張り | 物が欲しい 0.9 |
| Rin | ずる賢い、損をしない | 物が欲しい 0.7 |
| Haruto | 勇敢、危ない所にも先に行く | 怖がりにくい |
| Emi | 心配性 | 不安・空腹を早めに気にする |
| Shota | のんき | ストレスがたまりにくい・空腹になりにくい |
| Nana | 寂しがり | 人恋しくなりやすい |
| Ryo | 頑固 | 眠気に強い |
| Kaori | 几帳面 | 眠くなりやすい |
| Takumi | 見栄っ張り | 認められたい |
| Mio | 人見知り | 人の役に立ちたい 0.7 |
| Goro | 気が短い | ストレスがたまりやすい・よく食べる |
| Sayaka | お人よし、頼まれると断れない | 人の役に立ちたい 0.85 |

# 100人で動かす (`configs/survival_100.json`)

100人の年齢・性別・Big Five・名前は、人口推計と既存研究から、種 `20261110` を固定して生成する。生成し直すコマンドは
`node tools/gen_personas.js --check`、設定と実測の詳しい根拠は [100_AGENT_SCALE.md](100_AGENT_SCALE.md) を参照。

100人の実測では、20プロセスは Node 側だけで約12〜15コアを使い、Fabric が最大25秒遅れて timeout が出た。
16論理CPUの実験機では、まず `--procs 10` (1プロセス10人) を使う。サーバー設定は `view-distance=5`・
`simulation-distance=4`・ローカル通信の圧縮なしで、会話範囲48mに必要なプレイヤー追跡距離64mは残す。

```bash
bash mineflayer-agents/server-fabric/first_setting_world.sh morning
node mineflayer-agents/run.js --config mineflayer-agents/configs/survival_100.json \
  --agents 100 --procs 10 --minutes 10 --stagger-ms 1500
node mineflayer-agents/tools/check_scale_run.js mineflayer-agents/runs/<時刻> \
  --agents 100 --max-disconnects 0 --max-loop-lag-ms 10000
node mineflayer-agents/tools/summarize_run.js mineflayer-agents/runs/<時刻> --text
```

## 同時に動かす仕組み (run.js)

- **プロセスを分ける** (`--procs P`、既定は `ceil(N/5)` = 20人で4プロセス)。mineflayer の物理と pathfinder・ゴールの候補作り (約0.5秒) は
  1プロセスの中では直列なので、20人を1プロセスにするとイベントループが 1〜2 秒止まり、2人が keepalive で切られた (`disconnect.timeout`)。
  親が子 (`run.js --child k`) を起こし、子は同じ `runs/<時刻>/` に書く (1人1ファイルはこれまでどおり)。子は 5 秒ごとに Jev の入力トークンを親に送り、
  **親が全プロセスの合計で `--max-jev-tokens` に達したら全員を止める**。最後に親が子の `run-part<k>.json` を `run.json` にまとめる (使用量は足し直す)。
- **接続**: `--stagger-ms` (1500) ずつずらす。プロセスが複数でも全体で1人ずつ (子 k は k×stagger 待ってから、P×stagger おきに入る)。
  60 秒で spawn しなければ 3 回まで再試行し、だめならその人を外して続ける。走っている途中の切断 (end / kicked) は数えて `run.json` の `disconnects` に残す
  (自動でつなぎ直しはしない)。Fabric は max-players 120、rate-limit 0。100人では同一地点の圧死だけを
  `maxEntityCramming 0` で止める。
- **負荷の見張り** (`--monitor-sec`、既定 30): `runs/<時刻>/monitor[-k].jsonl` に CPU・RSS・イベントループの遅れ・生きているボット・判断の数と間隔・
  2B の呼び出しと待ち・Jev の呼び出しと 429。
- **2B の待ち時間**: llama-server の応答の `timings` (prompt_ms + predicted_ms) を処理時間とし、全体の時間から引いた残りを待ち (スロットの空き待ち。
  イベントループの遅れも入る) として数える (`src/deciders/llm.js` の `LLM_STATS`)。`run.json` の `twoBLatency`。
- **Jev**: 429・502・503・524・529 と in-flight 予算の 402 は `jev_client.js` が retry-after (無ければ 0.5・1・2・4 秒、最大 30 秒) で4回まで再試行する。同時の呼び出しは1プロセス `decider.jev.maxConcurrent` (8) まで。
- `--decider random --random-talk 0.15`: Jev を使わずに、でたらめな行動と確率 0.15 の発言 (2B) で負荷を試す。

## 負荷の試験 (2026-11-04、world_action_test・peaceful、2B は gpu-server の `-np 8`)

| 構成 | 判断 (3〜4分、20人) | 判断の間隔 p50 / p95 | node の CPU (1プロセス) | RSS | イベントループの遅れ p99 (中央値 / 最大) | 2B の待ち p50 / p95 / 最大 | 切断 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| random、1プロセス (4分) | 337 | 7.6s / 62s | 118% (張りつき) | 1.4GB | 1.3s / 1.8s | 1.0s / 13.5s / 18.8s | 0 |
| random、1プロセス (3分、reflect 等を入れた後) | 261 | 7.0s / 42s | 117% | 1.4GB | 1.1s / 2.2s | 0.6s / 14.4s / 19.4s | **2 (timeout)** |
| random、4プロセス (3分) | 429 | 3.8s / 31s | 55〜91% | 各 0.6GB | 0.3s / 1.6s | 0.2s / 3.5s / 5.9s | 0 |
| random、10プロセス (3分) | 483 | 3.3s / 31s | 15〜65% | 各 0.4GB | 0.1s / 1.5s | 0.03s / 0.9s / 1.1s | 0 |
| Jev、4プロセス (約50秒、上限で停止) | 114 | — | 60〜120% | 各 0.6GB | 0.25〜0.77s / — | 0.2s / 3.7s / 4.4s | 0 |

- 2B の待ちは始めの1分 (20人が一斉にゴールを作る) がいちばん長く、そのあとは p95 1 秒前後。
- Jev: 1判断 **3,545 トークン** (1段)、平均 551ms、**429 は 0 回** (32 本まで同時)。20人で約 2.5 判断/秒 → 60分で約 9,000 判断・**約 3,200 万トークン**
  (ゴールや振り返りで state が増えれば 4,000 万前後)。**`--max-jev-tokens 45000000` を勧める** (設定の既定 1,200 万では 20 分ほどで止まる)。
- Fabric サーバー (Java) は 20人で CPU 30〜90% (1コア = 100%)、RSS 2.7GB。`Can't keep up` は出なかった。
- 寝る: `playersSleepingPercentage 50` なので、20人なら 10 人が寝ないと夜は明けない。

```bash
# 本番 (20人・60分)。世界は prepare_survival → start → init_survival で作ったもの
bash mineflayer-agents/server-fabric/first_setting_world.sh morning
node mineflayer-agents/run.js --config mineflayer-agents/configs/survival_3days.json --agents 20 --procs 4 \
  --llm http://192.168.15.30:18081 --max-jev-tokens 45000000
node mineflayer-agents/tools/summarize_run.js mineflayer-agents/runs/<時刻>/ --text
```

summarize_run (20人向けに足したもの): 集まり (16m 以内でつながった2人以上のまとまりの数と大きさ、60秒ごとの推移、1人で居た割合)・
判断の間隔・関係の行列 (好感の初期値 50 からの変化。会っていない所は「.」、列は名前の先頭3文字)・上がった/下がった組とお互いに変わった組・
人ごとの1行の要約 (判断・成功率・多かった行動・死んだ回数・集まりに居た割合と一緒の相手・持ち物)・負荷 (monitor と 2B の待ち)。
2人組の距離 (190 組) は JSON の `pairDistance.perPair` にだけ残し、文章には全体の数だけを出す。

## LLM の提供元 (local = 2B / luna = gpt-6-luna) (`src/llm_provider.js`)

文を作る役 (発言・ゴールの案・振り返り・答え・全体チャット) の LLM を切り替える。記憶とメンタルモデルはハーネスが持ち、行動は Jev が選ぶ形は変わらない。

- **local** (既定): llama.cpp の llama-server の Gemma 4 E2B (OpenAI 互換)。窓口は今まで通り `--llm URL` (`decider.llm.baseUrl`)。費用 0。
- **luna**: OpenAI の `gpt-6-luna` (Chat Completions、`https://api.openai.com/v1`)。料金は入力 $0.10・キャッシュ済み入力 $0.01・キャッシュへの書き込み $0.125・
  出力 $0.50 / 100万トークン (入力が 272K を超える呼び出しは入力 2倍・出力 1.5倍。developers.openai.com/api/docs/models/gpt-6-luna、2026-11-06 確認)。
  応答の `usage.prompt_tokens_details` の `cached_tokens` と `cache_write_tokens` (どちらも入力の内数)、`completion_tokens_details.reasoning_tokens` から費用を出す。
  送り方: `max_completion_tokens`・`reasoning_effort: none` (既定。推論を使うと出力の上限に `reasoningExtraTokens` を足す)・
  `response_format: json_schema` (strict。文字列の長さの制約は外す)。`reasoning_effort: none` なら temperature を受け付ける。
  low 以上では temperature は 400 (既定の 1 だけ) なので初めから送らない。ほかに temperature か schema を 400 で断られたら外して送り直す (以後も外す)。
  429・5xx は retry-after (無ければ 1, 2, 4… 秒) で 4 回まで再試行、同時に投げるのは 1プロセス 8 本まで (`--procs 4` なら全体で 32 本)。
  promptfit の上限 (`ctxTokens`) は 272,000 (local は `goalPath.prompt.ctxTokens` = 8192)。

### API キーの渡し方

```bash
install -m 600 /dev/null /root/.config/luna.env
# エディタで1行書く (echo で書くとシェルの履歴に残る)
#   LUNA_API_KEY=sk-...
```

環境変数 `LUNA_API_KEY` (無ければ `OPENAI_API_KEY`) があればそちらを使う。別のファイルは `LUNA_ENV_FILE=/path`。
キーは表示・ログ・記録 (run.json・jsonl) に出さず、サーバーのエラーの文に入っていても `***` に消す。キーのファイルが無くても local だけなら今まで通り動く
(luna を使う役があるのにキーが無ければ、run.js は接続の前に止まる)。

### 切り替え方

```bash
# 全部 luna
node mineflayer-agents/run.js --config mineflayer-agents/configs/survival_3days.json --agents 20 --procs 4 \
  --llm http://192.168.15.30:18081 --max-jev-tokens 45000000 --llm-provider luna --max-llm-usd 2
# ゴールの案と振り返りだけ luna、ほか (発言・答え・全体チャット) は 2B
node mineflayer-agents/run.js ... --llm http://192.168.15.30:18081 --llm-roles goal=luna,reflect=luna --max-llm-usd 1
# 2B に戻す: --llm-provider / --llm-roles を付けない (config の llm.provider: local が既定)
# luna の経路を 2B で試す (キーは何でもよい。llama-server は見ない)
LUNA_API_KEY=dummy node mineflayer-agents/run.js ... --llm-provider luna --llm-base-url http://192.168.15.30:18081/v1 --llm-model gemma-4-e2b
```

- 役: `goal` (ゴールの案・goalPlan・selfGoal)、`talk` (近くの発言)、`reflect` (振り返り)、`answer` (答え)、`broadcast` (全体・提案・【発見】)、`act` (`--decider llm|split` の行動)。
- config では `llm: { provider, roles: { goal: 'luna', ... }, providers: { luna: { model, baseUrl, reasoningEffort, maxConcurrent, ctxTokens, pricing } }, maxUsd }`。
  `--llm-model`・`--llm-base-url` は `--llm-provider` の提供元の設定を変える。料金が分からない提供元は `pricing: { inputPerMTok: null, outputPerMTok: null }` (費用 0 として数え「未設定」と残す)。
- **使用量と費用**: run.json の `usage.llm` に提供元ごと (`byProvider`) と 提供元/役ごと (`byRole`、例 `luna/goal`) の呼び出し・失敗・429・再試行・
  入力 (うちキャッシュ)・出力 (うち推論) トークン・待ち時間・費用。`summarize_run.js --text` に「文を作る LLM: 費用 $…」の行。
  `--max-llm-usd X` (config `llm.maxUsd`) を全プロセスの合計で超えたら全員を止め、それ以降の呼び出しは投げない。

## Jev の提供元の比較 (2026-11-06、OpenRouter 経由 / TypeSafe 直)

前の実行の記録の場面 40 個 (英語の state。途中の場面を作り直した 24 個と、記録に残る送った state そのまま 16 個。選択肢 45〜94 個) を、
同じ state・同じ質問で各経路 2 回ずつ (計 160 回) 呼んだ。モデルは `jev-latest` (OpenRouter は `typesafe/jev-1.14-20261014`、TypeSafe 直は `jev-1.14.0` が返る)。

| | OpenRouter 経由 | TypeSafe 直 |
|---|---|---|
| 1回の時間 p50 / p90 / 最大 | 335 / 357 / 408 ms | 162 / 182 / 300 ms |
| 失敗・再試行・refusal | 0・0・0 | 0・0・0 |
| choice の probabilities | 全部に付く (選択肢すべて) | 全部に付く |
| 入力トークン (同じ場面で同じ数) | 277,268 | 277,268 |
| 費用 | `usage.cost` の合計 $0.011645 (= 入力 × $0.042/100万 と一致) | 計算で $0.011645 |

- 選んだ行動の一致: 同じ経路の 2 回で OpenRouter 39/40・TypeSafe 38/40、経路をまたいで (1回目どうし) 38/40、4 回とも同じ 36/40。
  違った 4 場面はどれも 1位の確率が 0.11〜0.19 の接戦か、1位と2位がほぼ同じ (collect:fern 0.5〜0.59 と use_on:hand>fern 0.52) 場面。
- 確率の差 (choice の分布の全変動距離): 同じ経路の 2 回で平均 0.054 (OpenRouter)・0.050 (TypeSafe)、経路をまたいで平均 0.050。
  noul の差の平均は同じ経路 0.029・経路をまたいで 0.024、score の差は 0.028・0.035。**経路の差は呼ぶたびの揺れと同じ程度** (OpenRouter で別の較正にはなっていない)。
- 本文 34,267 バイト (> 32,000) の場面: OpenRouter 406ms (同じ場面の 11,267 バイトで 381ms)、TypeSafe 直 260ms (191ms)。この 1 場面では遅さはほとんど見えなかった。

---

# 設置物の来歴と、取得の理由 (`cfg.provenance`、2026-11-11)

引き継ぎ `HANDOFF_2026-11-10_100_AGENT_OWNERSHIP.md` の「推奨する修正仕様」1〜6。他人の物を取らせないのではなく、取ったときの理由が
利己心・必要性・許可・誤認などとして観察・検証できるようにする (物理的な取得を社会的な出来事にする)。

| 部品 | 中身 |
| --- | --- |
| `src/provenance.js` | 台帳 (評価用の ground truth)。設置・破壊・置換・共有にした のたびに dimension+座標で1件。`runs/<id>/provenance/<名前>.jsonl` に各人が追記し、同じプロセスの人は1つの台帳を共有、ほかのプロセスの分は `sync()` (既定 2 秒ごと) で読み足す。`bot.dig`・`placeBlock`・`activateBlock` を包むので、pathfinder の掘り・足場も入る |
| `src/ownership.js` | 部分的な知識 (`OwnKnowledge`: 自分で置いた・見た・聞いた・共有にされた物だけ)、代わりの手段・機能損害・社会的な損、理由 (`decideReason`)、判断の重み、許可の答え、関係の変化 (`socialImpact`)、発話の行 |
| `src/ownership_actions.js` / `src/act_own.js` | 行動の候補と実行: `collect` (天然と見ている物だけ)・`dismantle_own`・`take_placed`・`ask_permission`・`make_amends` (説明・返す・戻す)・`repair_or_relocate_public` |
| `src/ownership_agent.js` | agent とのつなぎ (台帳への記録・知識の更新・意図の記録・目撃・後で気づいた・伝聞・許可のやりとり・噂・planner への見方) |
| `tools/provenance_stats.js` | 集計 (`summarize_run.js` の `provenance` と `--text` の行) |
| `tools/replay_provenance.js` | 台帳の無い前の記録から推定して集計に通す (読むだけ) |

- **設定**: `ledger` (既定 on。観察だけで行動は変えない)、`actions` (知識と行動の分離。既定 off、survival_3days/100 は on)、`penalty` (判断の重み + 関係の変化。既定 off、survival は on。
  `reweight`・`social` で片方だけ切れる)、`countPlaced` (物のゴールで自分の置いた機能している物を「持っている」に数える。既定 on、actions が on のとき)。
  比較実験: `run.js --provenance on|off --ownership-penalty on|off [--ledger on|off]`。
- **見た目で人工物と分かる物** (`ARTIFACT`: 松明・作業台・ベッド・板材・柵など) は、所有者を知らなくても置かれた物と認識し、`take_placed` (所有者不明) になる。
  丸石・土・原木のように天然と同じ見た目の物は、知らなければ collect に残り、台帳と突き合わせて `mistaken_as_natural` と記録される。台帳に無い人工物 (村の物など) は**みんなの物 (public)** (2026-11-11 ユーザー決定。外界の物なので)。
  エージェントは、村人を見かけた所 (`village.radius` 32 以内) の所有者を知らない人工物を「村の物」(public、`take_placed:…@village`) と認識する。
  評価の記録では `truth.ownership = { kind: 'public', world: true }`。天然と同じ見た目の村の家の原木・丸石 (隣に台帳に無い人工物がある) は collect のままで、掘ると public の物の `mistaken_as_natural` になる。
- **理由** (行動の前に決める。LLM に説明させない): `repair_or_relocate_public` → public_repair / 行動の対象でない掘り (pathfinder・unstuck・別の物を掘る途中) → accidental /
  collect → mistaken_as_natural (provenance off なら unmodeled) / dismantle_own → own_relocation / 許可あり → permission_granted / 所有者不明 → unknown_ownership /
  その物が満たす欲求 (松明・壁 → 安心、ベッド → 眠気、作物・かまど → 空腹) が `emergencyNeed` (0.8) 以上で代わりの手段が無い → emergency_need / それ以外 → selfish_acquisition。
- **記録**: `event: intent` (理由・欲求・性格・許可・代わり・損害・社会的な損・重みの内訳・台帳の本当の持ち主・本当の代わり)、`take`、`ownership_ask`/`ownership_permission`、
  `ownership_amends`、`ownership_social` (好感・信頼の変化と前後)、`ownership_loss`、`ownership_rumor`、`ownership_heard`、`place_forgotten`。console に1行
  (`Yua take_placed(torch owned by Miho) reason=… need=… alternatives=… harm=… permission=…`)。
- **発話の行** (近くの声 hearRadius の中だけ): `【許可? id 物 x,y,z 持ち主】`・`【許可 id yes|no】`・`【説明 物 x,y,z 持ち主 理由】`・`【返却 物 数 持ち主】`・`【補修 …】`・`【噂 取った人 物 持ち主 回数】`。
  頭の印は機械が読み、後ろの文は確定した記録から talker (LLM) が作る (`speech: template` で型どおりの文)。聞いた人は印を除いた文だけを近くの声として聞く。
- **planner**: 置かれた物と認識している物は collect の入手元にせず、手間 (`COST.placed` = 4) を足した「取る」入手元 (`where: 'placed'`) にする。置かれた作業台・かまどは「使える設備」としては数える。
- 前からの不具合も直した: collect は拾えたかで成功を決める (他人が先に壊した物を成功にしない・死んで負の数にしない)、自分で掘った物の場所を記憶から消す、
  others.js の「誰が壊したか」を腕を振ったか・はっきり一番近いかでも見分ける。
