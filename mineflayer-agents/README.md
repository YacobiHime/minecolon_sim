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
