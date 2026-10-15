# 論文読み込みセッションの設定

卒業研究「Minecraft（MineColonies MOD）を用いた社会シミュレーション」のうち、**論文の読解・要約・整理だけを担当するセッション**の設定です。研究方針の検討は別の「方針セッション」で行います。新しいセッションでこの文書を読み込めば、同じ役割で作業を始められます。

## 役割

- 論文を読み、日本語の読書ノートを作る。
- 研究方針は決めない。方針に関わる気づきは、ノートの「方針セッションへの申し送り」欄に書く。

## 研究の現状（2026-09-30 時点）

- 有力な候補: **建物の配置（都市の形）をAIに学習・最適化させ、都市の社会課題（通勤・通学時間、職住近接、生活サービスへのアクセス、コンパクトシティか分散型か）を考える研究**。都市形態学・コンパクトシティ（立地適正化計画）の考え方と、AIによるMinecraftの集落生成コンペ **GDMC** を主な先行研究として読む。
- ほかの候補: 感染症（MineColoniesの病気・病院の仕組みを使う）、少子化（貨幣経済の追加が必要で重い）。
- 参考資料（このプロジェクト内）: `docs/reference/gdmc-reading-guide.md`（GDMCの読み方ガイド）、`docs/reference/prior-research-topics.md`（先行研究の題材と文献リスト約190件）、`docs/reference/minecolonies-wiki-draft.md`（MineColoniesの機能まとめ）。

## 読む候補（GDMC中心、おすすめ順）と進み具合

| 順 | 論文 | 状態 |
| --- | --- | --- |
| 1 | Salge ほか 2018「Generative Design in Minecraft (GDMC), Settlement Generation Competition」 https://arxiv.org/abs/1803.09853 | 読了（`docs/reference/paper-notes/gdmc-competition-2018.md`、2026-09-30） |
| 2 | Salge ほか 2020「The AI Settlement Generation Challenge in Minecraft」KI 34(1) https://link.springer.com/article/10.1007/s13218-020-00635-0 （arXiv: https://arxiv.org/abs/2103.14950 ） | 読了（`docs/reference/paper-notes/gdmc-first-year-2020.md`、2026-10-02） |
| 3 | Salge ほか 2022「Impressions of the GDMC AI Settlement Generation Challenge in Minecraft」FDG 2022 https://arxiv.org/abs/2108.02955 （最重要） | 読了（`docs/reference/paper-notes/gdmc-impressions-2022.md`、2026-10-05） |
| 4 | van der Staaij ほか 2023「Believable Minecraft Settlements by Means of Decentralised Iterative Planning」 https://arxiv.org/abs/2309.10871 | 読了（`docs/reference/paper-notes/decentralised-iterative-planning-2023.md`、2026-10-06） |
| 5 | Iramanesh & Kreminski 2021「AgentCraft: An Agent-Based Minecraft Settlement Generator」 https://escholarship.org/uc/item/83p272pq | 軽めに読了（`docs/reference/paper-notes/agentcraft-2021.md`、2026-10-06） |
| 6 | Christiansen & Scirea 2022「Space segmentation and multiple autonomous agents: a Minecraft settlement generator」IEEE CoG 2022 https://ieee-cog.org/2022/assets/papers/paper_52.pdf | 軽めに読了（`docs/reference/paper-notes/space-segmentation-agents-2022.md`、2026-10-06） |
| 7 | Deinböck, Hsueh, Ikeda 2025「Procedurally Generating Natural-Looking Villages in Minecraft with Ant Colony Optimization Algorithms」TAAI 2024 https://link.springer.com/chapter/10.1007/978-981-96-4596-1_9 | 要旨のみ（本文は有料。`docs/reference/paper-notes/aco-villages-2025.md`、2026-10-06） |
| 8 | Hervé & Salge 2021「Comparing PCG metrics with Human Evaluation in Minecraft Settlement Generation」 https://arxiv.org/abs/2107.02457 | 軽めに読了（`docs/reference/paper-notes/pcg-metrics-human-eval-2021.md`、2026-10-06） |
| 9 | Hervé ほか 2023「Exploring Minecraft Settlement Generators with Generative Shift Analysis」 https://arxiv.org/abs/2309.05371 | 軽めに読了（`docs/reference/paper-notes/generative-shift-2023.md`、2026-10-06） |

## サーベイで追う観点（2026-10-05 のユーザーの振り返りから）

論文②まで読んだ時点のユーザーの振り返りをもとに、以降の論文では次の3点の動向を必ず確認し、各ノートの「追跡する観点」欄に書く。

1. **水・地形への適応**: 川・海・高低差をどう扱っているか（橋、港、水辺の地区、分断された集落の扱い）。第1回ではどの作品も水に適応できなかった（論文②6.2節）。ユーザーも前期の研究で水への適応の難しさを感じている。
2. **評価の数値化と客観性**: 人の採点の限界（第1回は審査員8人、一致度はピアソン相関の平均0.51）と、自動評価・数値指標の試み。主催者は指標の最適化を恐れて数値指標をあえて使わなかった（論文②4.4節）。
3. **集落の種類・性格（都市か田舎か、密か疎か）**: 地図に合わせて集落の種類そのものを選ぶ「地図全体を見た適応」は、第1回の未解決課題（論文②6.3節）。評価基準にも「都市か田舎か」という観点は明示されていない。

### ユーザーの着想（方針セッション向けの記録）

- 地形を活かした生成の考え方は、社会シミュレーションの設定の基礎に使えそう。例: 川で分断された町がそれぞれどう発展するか、川の上流に住む人が水資源の面でどのくらい有利になるか。
- 注意【推測】: 標準の Minecraft では水は減らない（水源は無限で、川の水量や上流・下流の差もない）。上流の有利さを扱うには、水資源の量や汚れなどをシミュレーション側で設計する必要がありそう。MineColonies で水が関わるのは、漁師（近くの水場）や米（水を張った農地）など（`docs/reference/minecolonies-wiki-draft.md`）。

- 論文③を読んで（2026-10-05）: 水回りの対処がどのくらいできているか、実際にゲーム画面で自分の目で確認したい。また、Chronicle（ゲーム内の本に文章を書く）のような、配置から少し逸れた要素が増えると、その部分を除いて考える必要があり面倒だと感じている。
  - 確認できたこと: Chronicle は任意参加の別の賞で、通常の4観点の点数とは別に審査される（2023・2024年の大会ページ）。ただし通常の4観点にも「物語」が含まれるので、総合点には物語の評価が混ざる。観点ごとの点数は公開されているので、適応・機能性の点数だけを見ることはできる。

## ゲーム内で確認するための資料（2026-10-05 調べ）

| 大会 | 生成済みのワールド | Minecraft のバージョン | ほかの資料 | 水に関係する作品 |
| --- | --- | --- | --- | --- |
| 2020 | 大会ページには見当たらない（未確認） | 未確認 | 点数表、各作品の説明とコード | University of Tsukuba（経路探索が水の上を通れるように橋を作る） |
| 2023 | あり（Google Drive） https://gendesignmc.wikidot.com/wiki:2023-settlement-generation-competition | 1.19.2 | 審査員のコメント入りの結果表、コード、審査のライブ配信の動画 | MGAIA（ライデン大学）「Collapsing Water Waves」（水のシミュレーションで建物どうしをつなぐ道を作る） |
| 2024 | あり（Dropbox） https://gendesignmc.wikidot.com/wiki:2024-settlement-generation-competition | 1.20.2 | 審査員のコメント入りの結果表（Excel）、審査員向けの説明書、全5作品のコード（GitHub） | 大会ページの説明には水に関する記述なし |

- ワールドは、そのバージョンの通常の Minecraft で開く（MineColonies の環境とは別にする。新しいバージョンのワールドを古いバージョンで開くのは避ける）。
- **2023年のワールドの見方**（審査員向けの説明書 https://docs.google.com/document/d/147UJm3bEj-onxrkMbcXEYWl385QOYIv4VORA0_50t_o より、2026-10-06 確認）:
  - フォルダは `2023_1`、`2023_2` … と生成器ごとに番号がついたワールド。番号とチーム名の対応は未確認（結果表で確認できるかもしれない）。
  - Minecraft 1.19.2 で開く（新しいバージョンでは地形の生成が変わるため）。`.minecraft/saves` にフォルダをコピーし、シングルプレイから選ぶ。
  - 審査ではスペクテイター／クリエイティブモードと `/tp` を使う。1作品10〜15分程度で見て回る。
  - 集落のある場所: 既存の集落 `/tp 450 158 626`、湿地・マングローブ（中央に湖）`/tp -12700 200 5000`、平らな海岸 `/tp -12700 200 200`、急な尾根 `/tp -5300 200 2400`、小さな島 `/tp 1500 200 -2900`。水回りを見るなら、湿地・海岸・島が向いている。
  - 2023年の結果（総合点）: 1位 PositionNotLoaded 5.98、2位 Shadow Wizard Money Gang 4.46、3位 Niels-NTG 4.40 … 5位 MGAIA（ライデン大学、Collapsing Water Waves）4.33、7位 Tobias Deinböck（アリコロニー最適化、論文⑦の手法）3.93。
- 2020年の「ヴェネツィアのような水上の集落」（論文③ B.12）がどの作品かは未確認。

## 作業のルール

- 論文は必ず原文（要旨ページ・PDF・HTML版）を開いて読む。書誌（タイトル・著者・年・掲載先）は論文のページで確認する。
- 原文にないことを書くときは【推測】と明記する。確認できなかった点は「未確認」と書く。
- 引用は短く（1か所15語以内）、要約は自分の言葉で書く。
- 読書ノートはプロジェクトに `docs/reference/paper-notes/<短い英語名>.md` として保存する（例: `docs/reference/paper-notes/gdmc-impressions-2022.md`）。
- **ノートには「章ごとの内容」を必ず入れる**（ユーザーの希望、2026-09-30）。章・節の見出しを原文どおりの番号で並べ、それぞれで何をしているか（主張、具体例、数値、比較している先行研究、ルールなど）を細かく書く。要点だけの短いまとめにはしない。
- **軽めに読むモード**（ユーザーの希望、2026-10-06、論文⑤〜⑨から）: 時間を節約するため、章ごとの内容は「章の構成（概要）」として1行ずつにとどめ、制約とアルゴリズム、追跡する観点、MineColonies に使える点、申し送りを中心に書く。ノートの題名に「（軽めの読書ノート）」と付ける。
- 1本読み終えたら、ノートの要点をユーザーに報告し、次に読む論文を確認する。
- **報告とノートは「制約・アルゴリズム」を中心にする**（ユーザーの希望、2026-10-06）。ユーザーは GDMC の見栄えや受賞・順位には関心がなく、どのような制約（ハード制約・評価関数・地形の扱いなど）で配置を決めているかを参考にしたい。受賞や点数の話は最小限にする。制約は `docs/reference/paper-notes/gdmc-constraints-overview.md` にも論文ごとに追記する。
- 読み終えたら、上の表の「状態」を更新する。

## 読書ノートのテンプレート

```
# <論文タイトル>

- 書誌: 著者／年／掲載先／URL
- 読んだもの: （要旨ページ・PDF・HTML版のどれを、いつ読んだか）
- 一言でいうと:

## 章ごとの内容

### 1 <章の見出し>
**1.1 <節の見出し>**
- （その節で何をしているかを細かく）

（以下、すべての章・節について同様に）

## まとめの項目
- 背景・解こうとしている問題:
- 手法:
- 実験・評価の方法:
- 主な結果:
- 限界・著者が認めている課題:

## 追跡する観点
- 水・地形への適応:
- 評価の数値化と客観性:
- 集落の種類・性格（都市か田舎か、密か疎か）:

## MineColonies の研究に使える点

## 疑問・気になった点

## 方針セッションへの申し送り
```
