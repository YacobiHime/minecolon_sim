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
(cd mineflayer-agents && npm install)

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
  チャットは発言者が `hearRadius`(24) 以内にいるときだけ聞こえる (届かない発言は捨てる)。サーバーのプレイヤー一覧
  (`bot.players`) は聞こえる範囲の判定にだけ使い、プロンプトには入れない。
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

Jev の API キーは環境変数 `TYPESAFE_API_KEY` か `/root/.config/typesafe.env` (`TYPESAFE_API_KEY=...` の1行) から読む。
表示・記録・コミットしない。キーが無いのに `decider.type: "jev"` なら起動しない (`--decider llm` を使う)。

## 構成 (段階1に足したもの)

```
src/deciders/jev.js  Jev の decider (1回の呼び出しに Choice・Noul・Score をまとめる)
src/jev_client.js    System One API の窓口 (キーの読み込み・429/529 の再試行・同時数の制限)
src/usage.js         使用量 (Jev の入力の文字数・トークン・応答時間、2B の回数・プロンプトの長さ) と、Jev の入力トークンの上限
src/talker.js        2B で発言と答えを作る
src/social.js        感情・欲求・人間関係 (数値はプログラム、2B には短い言葉)
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
| explore | 東西南北 | 20 ブロック歩く |
| craft | 今の持ち物で作れる物 (作業台が見えれば作業台の要る物も) | recipesFor → craft |
| build (新) | 拠点を知っていて、板材・原木・丸石・土を持っている | 設計図の空いている所のうち隣に支えがある所へ、GoalPlaceBlock で近づき placeBlock。1回に4個まで。座標は選ばせない |
| hunt (新) | 牛・豚・羊・鶏・兎が見える | 追いかけて attack、落ちた肉を拾う (30 秒まで) |
| ask (新) | 困っていて (同じ行動・引数が直近4回で2回失敗)、聞こえる範囲 (24) に人が見える | チャットで聞いて、答えを最大 45 秒待つ |
| place / eat / look_around / wait | 段階1と同じ | |

拠点は、出現地点から南へ 6 ブロックの地面 (全員が最初から知っている。忘れない)。小屋の進み具合は、拠点が視界 (16) 内にあるときだけ分かる。

## Jev への1回の呼び出し

`state` (JSON): `you`・`personality`・`goal`・`knowledge` (① goal.hints)・`plan` (②③ 手順と「済」「次はこれ」)・`now` (観測の文)・
`feelings` (社会性の言葉)・`memory` (選んだ記憶)・`last_result` (直前の行動の結果)・`heard_now`・`troubled` (困りごと、あるときだけ)。
質問の文は英語 (公式の資料で英語が一番正確とある)、状態は日本語のまま。

| 名前 | 型 | 中身 |
| --- | --- | --- |
| next_action | choice | 一覧の「行動:引数」(例 `collect:oak_log`、`build:oak_planks`、`ask:Hanako`) から1つ。選択肢は最大 255 |
| remember | score (0〜4) | 直前の出来事を覚えておく価値 → 記憶の大事さ (score/4) |
| talk | noul | 今、近くの人に話しかけるべきか。人が見えるか何か聞こえたときだけ聞く |
| rel_0.. | score (0〜4) | 今聞こえた相手ごとに、その人への気持ちがどう変わったか → 好感 ±12 |

使用量は `usage.input_tokens` (返らなければ文字数から推定し、推定と記録)。費用は入力 100万トークンあたり $0.042。
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
| 欲求 (マズロー) | food・rest・safety・belonging・achievement の5つに絞った。ルールで更新 (peaceful では満腹度が減らないので、食べ物を持っていないと少しずつ上がる)。軽くした |
| 考え (話題ごとの態度) | 外した |
| 記憶 (出来事・知覚の流れ) | 14章の忘れる記憶に置き換えた。教わったこと (誰から・いつ) を足した |
| 人間関係 (0〜100) | 相手ごとの好感 0〜100・信頼 0〜1。研究室の `social_dynamics.js` の「助けた・断られた」の数え方を借りた。好感は Jev の Score とルール (教わった +8、無視された −5、頼られた +1〜3) |
| 移動・経済・家族 | 外した (Minecraft の行動に置き換わる) |
| 周りに聞く | 足した (14章) |

研究室の `personas.js`・`social_cognition.js`・`social_dynamics.js` は読んだだけで、変更も読み込みもしていない。
2B には数値を渡さず「少しいらだっている。誰かと話したい。Hanakoとは仲が良い。前にやり方を教えてくれた」の形で渡す。

## 周りに聞く仕組み (14章)

困っている (同じ行動・引数が直近4回で2回失敗、同じことは 10 ループ聞かない) → 一覧に ask → チャットで
`Hanakoさん、教えて: wooden_pickaxeの作り方が分からない(「…」で失敗した)` → 聞こえた相手 (24 ブロック以内) が
`Taroさん、答え: …` と答える → 聞いた側は答えを記憶 (knowledge: 誰から・ループ番号・昼/夜) に入れる →
その後 6 ループのうちに、同じ行動をやり直して成功したか (`retried_ok`)、答えに出てきた行動・物を選んで成功したか (`followed`) を記録。
記録: 聞いた側に `ask` / `ask_reply` / `ask_timeout` / `answer_use`、答えた側に `answer` (使った記憶と 2B のプロンプト)。

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

## 外からの助けの記録

`help` (①hints・②steps・③progress・askOthers・④excludeFailures・noChange) を設定に持ち、各記録の `start` に残す (noChange の値は `noChangeCfg`)。first_setting は ①②③ と聞く・noChange、④なし。
段階1の設定 (`wood_pickaxe.json`) は `help` を持たないので、これまでどおり ①②③④ (聞くなし) で動く。
