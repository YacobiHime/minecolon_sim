# 詳細認知ペルソナモデル（Phase 3.6）

## 位置づけ

`voyager-cognition-v1`は、P1の7つの数値特性から、社会的な判断に使う計算上の構成概念を
決定論的に導出する層である。これは臨床診断、心理尺度の測定値、FAtiMA/OCCの完全実装ではない。
卒業研究で「誰が、どの状況を、なぜそのように評価したか」を再現・説明・比較するための
操作的モデルとして扱う。

P1を正本のまま残した理由は、既存35市民の履歴と遺伝条件を壊さず、詳細モデルの有無だけを
反実仮想比較できるようにするためである。詳細な名前が増えても、独立な人格自由度が増えたわけではない。
現段階の全構成概念は、元の7特性の相関した射影である。

## 処理レイヤー

```text
P1（遺伝する7特性）
  ↓ 決定論的導出 + 寄与trace
価値・動機・欲求優先度・規範・対処・感情力学・意思決定傾向
  ↓ 現在の困窮、関係、記憶、距離、資源
状況依存goal → appraisal → 予期感情
  ↓ 明示configの効用計算 + seed固定softmax
help / refuse
  ↓ 実行時のみ
移動・食料移転 → 結果event → 有向関係・対人記憶
```

## 構成概念

全値は原則`[0,1]`で、`trace`には入力、重み、寄与、丸め前の合計を保存する。

| 区分 | 次元 |
|---|---|
| 価値 | family, community, fairness, reciprocity, autonomy |
| 動機 | care, affiliation, achievement, security, resourceProtection |
| 欲求優先度 | belonging, competence, autonomy, security, caregiving |
| 規範 | careForKin, reciprocateHelp, aidCommunity, actFairly, selfPreservation |
| 対処 | problemFocused, supportSeeking, avoidance, confrontation |
| 感情力学 | concernSensitivity, threatSensitivity, reappraisal, suppression, positivePersistence, negativePersistence |
| 意思決定 | riskTolerance, normSensitivity, futureOrientation, exploration |
| 状況依存goal | preserveHealth, aidOther, honorReciprocity, maintainRelationship, preserveResources |

感情力学の`positivePersistence`と`negativePersistence`は、12,000〜168,000 game tickの
半減期にも変換する。これは今後、相手別感情の固定24,000 tick半減期を個人差へ接続するための
候補値であり、現時点のライブstate更新にはまだ使用しない。

## Appraisal v2

`voyager-appraisal-v2`は、詳細profileと状況から次を計算する。

- appraisal: relevance, goalCongruence, normCompatibility, controllability, selfCost
- 予期感情: compassion, guiltAnticipation, reluctance, prideAnticipation, anxiety
- 行動効用: help / refuseの各signal寄与と合計score

係数は`social_appraisal_v2_config.json`へ分離し、`experimental-unvalidated`と明記した。
version 1の初回比較では、0〜1の正信号をそのまま足したため援助率が70.46%から86.28%へ上がり、
11,100試行の差分1,756件がすべてv2だけの援助になった。この一方向性を構造的バイアスと判定し、
version 2では中立点0.5からの正負の証拠へ変換した。これは観測値へ合わせた係数調整ではなく、
異なる数の構成概念を比較可能な効用尺度へ揃える修正である。

安全のため`social_help_daemon.js`の既定はv1のままにし、v2は
`SOCIAL_HELP_APPRAISAL_MODEL=v2`を明示した場合だけ使用する。

## 2026-08-01の操作確認

現在の生存35市民では、主要9次元すべてに個人差があった。標準偏差は
resourceProtectionの0.1147からcareの0.2058の範囲で、例としてcareは
Lane C. Colthurst=0.173、Darian M. Revaluri=0.922だった。

同じ222場面、同じ乱数、50反復（11,100試行/モデル）で比較した結果:

| 指標 | v1 | v2 centered |
|---|---:|---:|
| 確率的援助率 | 0.7003 | 0.6032 |
| 平均 help-refuse margin | 0.5259 | 0.2307 |
| 決定論的援助率 | 0.6892 | 0.6171 |

確率的判断の不一致は1,111件（10.01%）、決定論的判断の不一致は16/222場面（7.21%）。
決定論的差分16件はすべて`stubborn_miner`系がv1の援助からv2の拒否へ変わった。
これは詳細モデルがcareだけでなく、資源防衛・自律・自己コスト・規範感受性を分離して評価した
結果として説明できる。ただし、この方向を現実妥当性の証拠にはしない。

最初のライブshadowではstarving対象が0人だったためhungryへ広げ、実profileと寄与を生成した。
その後の限定実行では、v2による拒否5件と援助2件を確認した。市民22→14の援助では接近後に
fish dinnerが4→3 / 0→1となり、受け手が食べてsaturation 0→6.4へ回復した。成功eventから
受け手視点のtrust=0.58、gratitude=0.18、obligation=0.10が一度だけ更新された。

適応tickrate中は、到着目標にした受け手の古い位置から本人が移動してしまう。そこで250msごとに
両者の実位置を再取得し、2秒ごとに追跡先を更新、6ブロック以内になった時点で移転する方式へ変えた。
市民3→21では初期距離18.0ブロックから約0.56秒で接近・移転できた。これは遠隔移転ではなく、
Bridgeの近接制約を保った身体化実行である。

連続自動実行はまだ開始していない。`supply_bot`の社会支援猶予も既定値0で、現在のライブ供給は
従来どおりである。常駐実験に移す場合は、決定論的v2、15秒追跡、20秒供給猶予を一組の実験条件として
停止条件とともに固定する。

## 再現コマンド

```bash
cd /home/mine-admin/minecolon_sim/minecolonies-bridge

# 現在人口の詳細profileと分布（結果JSONはgitignore）
node persona_profile_report.js --output=persona_profile_results/current_v1.json

# 1人ごとの導出traceも保存
node persona_profile_report.js --trace=true \
  --output=persona_profile_results/current_v1_traced.json

# v1/v2を同一入力・同一乱数で比較
node social_cognition_experiment.js \
  --repeats=50 --seed=cognition-live-v2 \
  --output=social_cognition_results/cognition_live_v2.json

# ゲーム操作なしのv2評価
SOCIAL_HELP_EXECUTE=false SOCIAL_HELP_APPRAISAL_MODEL=v2 \
  SOCIAL_HELP_NEED_BAND=hungry node social_help_daemon.js --once
```

## 研究上の限界と次の判断点

1. 詳細次元は7特性からの導出なので、名称ほど独立ではない。因子相関と多重共線性を報告する。
2. 重みは理論概念を実装へ写した仮説であり、心理測定で推定した係数ではない。
3. 少数の実移動・空腹回復・関係変化は確認したが、距離別成功率や長期的な仕事・関係への影響は未測定。
4. 本実験前に係数範囲、temperature、seed、主要指標、除外条件を固定する。
5. 明示的な価値・goalを新しい遺伝自由度にするのは、現モデルのablationで不足が確認された後に検討する。
6. 次の実装候補は、個人別感情半減期、複数goal間競合、経験によるcoping更新である。
   ただし一度に追加せず、それぞれを独立条件として比較可能にする。
