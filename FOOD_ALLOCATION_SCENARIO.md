# 食料1食の配分シナリオ

## 研究質問

食料が1食しかないとき、個人特性、家族関係、過去のやり取りを順に与えることで、
MineColonies市民の「必要性を優先する・親しい相手を優先する・自分で保持する」という選択は
どのように変わるか。

これは社会シミュレーションの最初の最小シナリオである。ペルソナ項目を増やすことより、
同じ状況で情報だけを段階的に変え、判断とゲーム内結果を比較できることを優先する。

## 既存研究から採った設計要素

- [Generative Agents](https://arxiv.org/abs/2304.03442): 抽象的な性格紹介だけでなく、具体的な初期イベントを与え、記憶・計画・反省から後続行動を見る。
- [SOTOPIA](https://arxiv.org/abs/2310.11667): 共通シナリオと個人別の目標を分け、社会的な結果を評価する。
- [GovSim](https://arxiv.org/abs/2404.16698): 共有された希少資源をめぐる協力と持続可能性を扱う。
- [Melting Pot](https://proceedings.mlr.press/v139/leibo21a.html): 資源共有、互恵性、役割分担など複数の社会課題を分解して評価する。
- [Sequential Social Dilemmas](https://arxiv.org/abs/1702.03037): 資源量など環境条件を変え、協力と競争がいつ生じるかを見る。

本実験ではこれらの理論やベンチマークを再実装したとは主張しない。具体的な状況、私的特性、
希少資源、条件間比較という実験設計の要素をMineColoniesへ移したものと位置付ける。

## 共通シナリオ

runnerは実際のpersonaと社会graphから、家族辺と家族以外の辺を両方持つ生存市民を選ぶ。
二人の候補は物理的には同じ12ブロック先とし、社会的距離と物理距離を混同しない。

> あなたは（援助者名）です。自分は満腹です。自分用の最後の食事とは別に、分けられる料理が1食だけあります。親しい家族は空腹ですが緊急ではありません。関係の薄い共同体の一員は深刻な空腹状態です。判断中は食堂・配達員・外部供給から食料は届きません。料理を渡せる相手は一人だけです。家族へ渡す、重症者へ渡す、誰にも渡さない、のいずれかを選んでください。

## 比較する4条件

| 条件 | 判断へ見せる情報 |
|---|---|
| `uniform` | 中立人格。関係情報なし |
| `persona` | 個人特性のみ。関係情報なし |
| `persona_relation` | 個人特性、家族等の構造、trust、affinity、familiarity |
| `temporal` | 上記にobligation、gratitude、resentment、行動記憶を追加 |

選択肢の内部名は`close_mild`（親しい軽度空腹）、`weak_severe`（関係の薄い重度空腹）、
`keep`（保持）である。各候補へのhelp scoreとrefuse scoreの差を比較し、最大差が正ならその相手へ渡す。
両候補が非正なら保持する。同点では必要性の高い相手を優先する。この選択規則自体も検証対象であり、
現実の人間行動を直接再現したものとは扱わない。

## 2026-08-04 offline予備結果

実行時のgraphは35 nodes、111 edgesで、条件を満たす援助者は24人だった。

| 条件 | 親しい軽度空腹 | 関係の薄い重度空腹 | 保持 |
|---|---:|---:|---:|
| uniform | 0 / 24 | 24 / 24 | 0 / 24 |
| persona | 0 / 24 | 15 / 24 | 9 / 24 |
| persona_relation | 15 / 24 | 0 / 24 | 9 / 24 |
| temporal | 15 / 24 | 0 / 24 | 9 / 24 |

ペルソナだけを戻すと、援助する15人は重症者を選び、自己保全寄りの9人は保持した。
関係情報を戻すと、援助する15人すべてが家族へ反転した。時間条件が静的関係と同じなのは、
現在の履歴が少ないためである。

これは「関係操作が判断へ影響する」という操作確認にはなるが、家族効果が強すぎる可能性も示す。
望ましい結果へ合わせて係数を後から変えず、空腹差を複数段階にした感度分析を先に定義する。

## 仮説と指標

- H1: `uniform`では関係によらず重症者が優先される。
- H2: `persona`では保持を含む個人差が現れる。
- H3: `persona_relation`では親しい相手を選ぶ割合が増える。
- H4: 十分な援助・拒否履歴の蓄積後にだけ`temporal`と`persona_relation`の差が現れる。

主要指標は、必要性優先率、関係優先率、保持率、ペルソナ型別選択、条件間反転率とする。
ライブ段階では、移転成功率、決定から到着までの時間、実際のsaturation回復、本来の仕事の中断時間も測る。

## 再現方法

```bash
cd /root/minecolon_sim/minecolonies-bridge
node test_food_allocation_scenario.js
node food_allocation_scenario.js \
  --output=food_allocation_results/pilot_v1.json
```

runnerはoffline専用でBridge APIを呼ばず、Minecraftのworldや市民在庫を変更しない。

## 統合実験runner（MVP）

`experiment_runner.js`は、severity gradient、複数seedの反復、条件間の共通乱数、
試行JSONL、JSON/CSV集計、入力snapshotを1コマンドで生成する。Minecraftの
`/status`は読み取るだけで、worldは変更しない。

```bash
cd /root/minecolon_sim/minecolonies-bridge
node experiment_runner.js \
  --source=live \
  --conditions=uniform,persona,persona_relation,temporal \
  --severity=0.5:0.5,0.5:0.75,0.5:1 \
  --repeats=30 --mode=sample --seed=food-v1
```

出力先に`input_snapshot.json`、`trials.jsonl`、`summary.json`、`summary.csv`が作られる。
同じsnapshotとseedの実行は`recordsSha256`が一致する。

```bash
node experiment_runner.js \
  --input=experiment_results/<run>/input_snapshot.json \
  --conditions=uniform,persona,persona_relation,temporal \
  --severity=0.5:0.5,0.5:0.75,0.5:1 \
  --repeats=30 --mode=sample --seed=food-v1
```

LLM条件は明示的に`llm`を指定した時だけ、Councilと同じローカルOllamaを呼ぶ。
まず1件で接続を確認する。

```bash
node experiment_runner.js \
  --input=experiment_results/<run>/input_snapshot.json \
  --conditions=llm --severity=0.5:1 --repeats=1 --scenario-limit=1
```

### 観測データ不足時の扱い

ライブ`/status`に家族・住居・共同職場の辺が十分ない場合、runnerは
`deterministic-synthetic-ring-v1`をsnapshotに付与し、親しい接点と弱い接点を
決定論的に補う。これは実測関係ではなく実験操作である。実関係のみを必須にする場合は
`--require-family=true --synthetic-topology=never`を指定し、条件不足時に失敗させる。

## ライブ試験へ進む条件

1. 空腹差の段階とappraisal係数を、結果を見る前に固定する。
2. 複製worldを用意し、開始状態を条件ごとに復元できるようにする。
3. 二候補の距離、料理、tickrateを固定し、Restaurant・Courier・外部供給は短い判断窓だけ統制する。
4. 判断窓終了後の救済条件、最大試行時間、職業復帰手順を決める。
5. deterministic appraisalと、同じscenario cardを与えたLLM選択を別条件として比較する。

この準備が済んだ段階が、ユーザーがMinecraftへ入り実際の挙動を確認するタイミングである。
