# 社会シミュレーション比較実験

## 目的

ペルソナ、静的な社会関係、時間的な対人記憶が、同じ困窮状況に対する援助判断と
局所情報伝播へどの程度の差を生むかを、同一入力・同一乱数で比較する。
このrunnerは係数の操作確認と実験条件選定用であり、Minecraft上の実行結果を置き換えるものではない。

## 援助判断の4条件

`minecolonies-bridge/social_experiment.js`は、現在の全構造辺を双方向の市民ペアへ展開し、
援助者はfed、受益者はstarving、資源ありという共通条件を与える。

1. `uniform`: 全員を中立ペルソナ、関係値なしとして扱う。
2. `persona`: 実ペルソナだけを戻し、関係値と構造ラベルを隠す。
3. `persona_relation`: trust、affinity、家族・同僚等、familiarityを戻すが、恩義と感情履歴を隠す。
4. `temporal`: obligation、時間減衰後のgratitude・resentmentを含む全状態を使う。

各条件には同じ市民ペアと同じ乱数drawを与える。実行例:

```bash
cd /root/minecolon_sim/minecolonies-bridge
node social_experiment.js \
  --repeats=50 --seed=phase35-final-v1 \
  --output=social_experiment_results/phase35_final_v1.json
```

2026-08-01の35市民・111辺（双方向222 scenario、各条件11,100試行）では、援助率は
`uniform=0.5123`、`persona=0.6051`、`persona_relation=0.7018`、`temporal=0.7018`だった。
時間条件が静的関係と同率なのは、ライブの社会行動履歴が援助1件しかないためである。

同じrunnerは履歴だけを統制操作するmanipulation checkも出力する。現行係数では
`no_history=0.7018`、`helped_before=0.8322`、`refused_before=0.3007`。
方向は設計どおりだが、拒否履歴の効果が大きいため、この値を妥当性の証拠とはせず係数較正対象とする。

## 具体シナリオ: 食料1食の配分

`food_allocation_scenario.js`は、実graphから家族辺と家族以外の辺を両方持つ援助者を選び、
親しい軽度空腹者と関係の薄い重度空腹者のどちらへ1食を渡すか、または保持するかを比較する。
物理距離は同じ12ブロックに固定し、関係性と必要性の競合だけを明示する。

```bash
node test_food_allocation_scenario.js
node food_allocation_scenario.js \
  --output=food_allocation_results/pilot_v1.json
```

2026-08-04の24 scenarioでは、`uniform`は24人全員が重症者、`persona`は重症者15・保持9、
`persona_relation`と`temporal`は家族15・保持9だった。この反転は操作確認として有用だが、
家族効果が強すぎる可能性があるため、係数を結果へ合わせず空腹差の感度分析を行う。
実験設計、仮説、ライブ化の条件は`FOOD_ALLOCATION_SCENARIO.md`を参照する。

## 局所情報伝播の4条件

`social_information_runner.js`は、最大次数の市民を脅威警報源とし、構造辺だけを通して伝達する。
受容・再伝達は受信者から発信者へのtrust、familiarity、sociability、community価値、
時間減衰後のgratitude・resentment、警報urgencyから決まる。全attemptと到達pathを保存する。

```bash
node social_information_runner.js \
  --runs=100 --seed=phase4-ensemble-v1 --ttl=2400 --hops=6 --urgency=0.9 \
  --output=social_information_results/phase4_ensemble_v1.json
```

2026-08-01の100 seed平均到達率は、`uniform=0.4529 (SD=0.1733)`、
`persona=0.4423 (SD=0.1727)`、`persona_relation=0.5643 (SD=0.1784)`、
`temporal=0.5643 (SD=0.1784)`。現在は履歴が少ないため、ここでも時間条件の差はまだない。

`social_information_daemon.js`は`/threats`を読むshadow専用daemonである。敵またはraid検出時に、
狙われている市民、なければ敵に最も近い成人市民を警報源として`temporal`条件を一度伝播する。
Minecraftへの移動・戦闘命令は出さない。同一脅威はTTL内で重複記録しない。

```bash
node social_information_daemon.js --once
```

## 詳細認知profileとappraisal v2の比較

Phase 3.6ではP1を変更せず、価値、動機、欲求優先度、規範、対処、感情力学、意思決定傾向、
状況依存goalを導出する`voyager-cognition-v1`を追加した。定義と主張範囲は
`COGNITIVE_MODEL.md`を参照する。

```bash
node persona_profile_report.js --output=persona_profile_results/current_v1.json
node social_cognition_experiment.js \
  --repeats=50 --seed=cognition-live-v2 \
  --output=social_cognition_results/cognition_live_v2.json
```

比較runnerは同じ222場面へv1/v2を適用し、確率的判断だけでなく`mode=max`の決定論的判断も比較する。
2026-08-01の結果は、確率的援助率v1=0.7003、v2=0.6032、不一致率0.1001。
決定論的援助率v1=0.6892、v2=0.6171、不一致16/222（0.0721）だった。
v2 configはversion 2、statusは`experimental-unvalidated`で、本実験の固定係数ではない。

## 時間的関係の更新規則

- 援助成功: 受益者→援助者のtrust `+0.08`、affinity `+0.05`、obligation `+0.10`、gratitude `+0.18`。
- 援助拒否: 要請者→相手のtrust `-0.06`、affinity `-0.03`、resentment `+0.16`。
- 返礼: obligationを持つ市民がその相手を助けた時、最大`0.10`を自動消費する。
- gratitudeとresentmentはゲーム内24,000 tickを半減期として遅延評価する。poll回数では変化しない。
- trust、affinity、obligationは`[0,1]`へ制限する。履歴回数は消さずに保持する。

## 解釈上の注意

- 現在の数値はモデルの内部整合性と感度を示す操作チェックで、現実妥当性の確定値ではない。
- Minecraftのライブ試験では移動成功率、応答時間、実際の空腹回復、資源保存を別に測る。
- adaptive tickrate下ではゲーム時間が速く進む。感情半減期は実時間ではなくシミュレーション時間で解釈する。
- 係数、半減期、softmax temperatureは、複数seedと教員相談後に事前登録してから本実験へ固定する。
- 結果JSONは容量増加を避けるためgitignoreし、検証済み要約と使用seedを週報・論文用表へ残す。
