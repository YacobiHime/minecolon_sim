# 先行研究：GDMC（Generative Design in Minecraft）

GDMC は、**AIにMinecraftの集落（町）を自動生成させる国際コンペ**です。建物の配置や都市の形をAIで扱う研究を考えるうえで、最も直接的な先行研究になります。このページでは、GDMC の概要、読むべき論文と読む順番、MineColonies の研究に活かせる点をまとめます（調査日 2026-09-25）。

## 1. GDMC の概要

- 2018年から毎年開催されている、AIによる集落生成のコンペ。主催は Christoph Salge（ハートフォードシャー大学）、Julian Togelius（ニューヨーク大学）らのグループ。
- 参加者は、**事前に見たことのない地図**の上に、地形に合わせた集落を自動で生成するプログラムを提出する。
- 生成された集落は、専門家とボランティアの審査員が実際にゲームの中を歩いて見て回り、次の**4つの観点**で0〜10点で採点する。

| 観点 | 内容 |
| --- | --- |
| 地形への適応（Adaptivity） | 地図の地形・素材・環境に合わせて集落が変わるか |
| 機能性（Functionality） | 住む人の立場から見て使えるか（移動のしやすさ、照明、敵モブの侵入を防ぐ、資源が得られる など） |
| 物語性（Evocative Narrative） | そこに住む人々や、集落がどうできたかの物語を感じさせるか |
| 見た目（Aesthetics） | 明らかなデザインの失敗がなく、見た目に統一感があるか |

- 任意の部門として、集落の歴史を文章で生成する **Chronicle（年代記）部門**がある。2025年以降は技術的な新しさを評価する賞もある。
- **提出されたコード・地図・採点結果は公開される**。過去の作品を実際に動かして試せる。
- 2026年大会は Minecraft 1.21.11 を使い、結果は2026年9月の IEEE Conference on Games（CoG 2026）で発表される予定。
- 公式サイト: <https://gendesignmc.wikidot.com/>（大会ごとのページと、関連論文の一覧「Research Page」がある）

### 使われるツール

| ツール | 内容 |
| --- | --- |
| **GDMC HTTP Interface** | Minecraft に入れるMOD。外部のプログラムから HTTP でブロックの読み書き、コマンドの実行、高さマップの取得などができる。MITライセンス |
| **GDPC** | GDMC HTTP Interface を Python から使うためのライブラリ。ブロックの配置、図形の作成、高さマップの取得などの機能がある。PyPI からインストールできる |
| **Amulet** | Minecraft のセーブデータを直接編集するツール。もう一つの提出方法 |

## 2. 読む順番（おすすめ）

| 順番 | 論文 | 読む目的 |
| --- | --- | --- |
| 1 | Salge ほか 2018「Generative Design in Minecraft (GDMC), Settlement Generation Competition」 | コンペの目的と問題設定をつかむ（短い） |
| 2 | Salge ほか 2020「The AI Settlement Generation Challenge in Minecraft」 | 1年目の作品・評価方法・課題の具体例を知る |
| 3 | **Salge ほか 2022「Impressions of the GDMC AI Settlement Generation Challenge in Minecraft」** | 審査員・参加者の生の感想から、何が難しいか、どこに研究の余地があるかを知る。**最重要** |
| 4 | van der Staaij ほか 2023「Believable Minecraft Settlements by Means of Decentralised Iterative Planning」 | 2022年の優勝作の手法。複数のエージェントで町を育て、簡単な経済で用途（住宅・工業・商業）を決める |
| 5 | Iramanesh & Kreminski 2021「AgentCraft」、Christiansen & Scirea 2022、Deinböck ほか 2025 | エージェントの行動から道や集落が「自然に」できる手法。社会シミュレーションに近い |
| 6 | Hervé & Salge 2021、Hervé ほか 2023 | 人の採点に頼らず、生成された集落を自動で評価する試み |
| 7 | van der Staaij ほか 2024、Green ほか 2019、Chronicle 部門の論文 | 機械学習・建物単体の生成・物語の生成など、発展的な内容 |

## 3. 各論文の要点

### 3.1 コンペの全体像（主催者の論文）

**① Generative Design in Minecraft (GDMC), Settlement Generation Competition**
- 書誌: Christoph Salge, Michael Cerny Green, Rodrigo Canaan, Julian Togelius／2018／FDG 2018 の PCG ワークショップ
- URL: <https://arxiv.org/abs/1803.09853>
- 要点: 機能的で、見た目がよく、それらしい集落を、与えられた地図に合わせて生成する AI を競うコンペを提案した。個々の要素ではなく、全体として地形に適応した「適応的・全体的な自動生成」が難しい研究課題だと位置づけている。
- 注目点: 研究の目標が「人間が作る集落に匹敵すること」に置かれている。

**② The AI Settlement Generation Challenge in Minecraft**
- 書誌: Christoph Salge, Michael Cerny Green, Rodrigo Canaan, Filip Skwarski, Rafael Fritsch, Adrian Brightmoore, Shaofang Ye, Changxing Cao, Julian Togelius／2020／KI - Künstliche Intelligenz 34(1):19–31
- URL: <https://link.springer.com/article/10.1007/s13218-020-00635-0>（arXiv 版: <https://arxiv.org/abs/2103.14950>）
- 要点: 1年目の報告。4つの評価観点の定義、参加作品の手法、審査の結果と、見えてきた課題（見た目と機能の両立、地図への本当の意味での適応）をまとめている。

**③ Impressions of the GDMC AI Settlement Generation Challenge in Minecraft**
- 書誌: Christoph Salge ほか（Ruck Thawonmas 氏を含む18名）／FDG 2022（arXiv 版は2021年）
- URL: <https://arxiv.org/abs/2108.02955>
- 要点: 点数では伝わらない審査員・参加者・主催者の感想を集めた論文。指摘されている主な課題は次のとおり。
  - **地形への適応**: 山や谷、水辺をうまく扱えず、地面を平らにしてしまう作品が多い。
  - **機能性**: 屋外の照明不足で敵モブが湧く、重要な場所どうしを結ぶ道が不十分、橋や階段がない。
  - **住む人の立場（身体性）**: プレイヤーが実際に歩いたときの動きやすさ、見通しなどが考えられておらず、「住めそう」に感じられない。
  - **評価方法**: 点数化はコンペ本来の考え方と相性が悪く、参加者は点数より言葉でのフィードバックを重視していた。
- 注目点: ある助言者は、作品の多くが**「大きく広がった、中央集権的な」クリエイティブモードのような建物**になっていると指摘している。そして、資源集めや移動の制約を守る**エージェントベースのシミュレーション**から集落が育つほうが、プレイヤーが作ったような「それらしい」集落になるだろうと提案している。**MineColonies の研究の立ち位置を説明する根拠として使える。**

### 3.2 生成手法（参加作品の論文）

**④ Believable Minecraft Settlements by Means of Decentralised Iterative Planning**
- 書誌: Arthur van der Staaij, Jelmer Prins, Vincent L. Prins, Julian Poelsma, Thera Smit, Matthias Müller-Brockhausen, Mike Preuss（ライデン大学）／2023／arXiv（掲載先は未確認）
- URL: <https://arxiv.org/abs/2309.10871>
- 要点: **2022年の優勝作**。4つの段階で集落を作る。
  1. **地形の解析**: 高さ・傾き・水・既存の構造物を2次元の「特徴マップ」にする。
  2. **分散型の反復計画**: 道・家・畑・城壁・教会・見張り塔などを担当する約40のエージェントが順番に、制約（道からの距離、傾き、水との距離）と「良さ」の関数に基づいて置き場所を選ぶ。これを約60ステップ繰り返し、町が有機的に広がっていく。
  3. **用途の分化**: 簡単な経済シミュレーションで、区画を住宅・工業・商業に分ける（商業は住宅や商業の近く、工業から離れた場所を好む）。
  4. **ブロックの配置**: 区画ごとに建物を生成する。
- 注目点: エージェントが町を「育てる」過程と、**住宅・工業・商業の用途地域の考え方**が、都市形態学やコンパクトシティの議論と直接つながる。

**⑤ AgentCraft: An Agent-Based Minecraft Settlement Generator**
- 書誌: Ari Iramanesh, Max Kreminski／2021／CEUR Workshop Proceedings Vol-3217
- URL: <https://escholarship.org/uc/item/83p272pq>（コード: <https://github.com/aith/agentcraft>）
- 要点: エージェントが社交・休息・水を飲む・繁殖・建築・資源集めを行う。行動した場所の「繁栄度」が上がり、それがしきい値を超えると道がつながる。**道がエージェントの行き来から自然にできる**。20作品中2位で、物語性の評価が高かった。
- 注目点: 人の移動から道路網ができるという考え方は、通勤経路や都市の成長の議論に使える。欠点はシミュレーションが重いこと。

**⑥ Space segmentation and multiple autonomous agents: a Minecraft settlement generator**
- 書誌: Sebastian S. Christiansen, Marco Scirea（南デンマーク大学）／2022／IEEE CoG 2022
- URL: <https://ieee-cog.org/2022/assets/papers/paper_52.pdf>
- 要点: 歩ける場所を探索して土地を5×5の格子に分け、空腹・睡眠・住まい・子どもといった「衝動」を持つ開拓者エージェントが家を建て、子どもを持つ。66人へのアンケートでは、地形への適応と有機的な成長で元の村より高く評価され、現実感では元の村が上回った。
- 注目点: 欲求を持つエージェントの人口の増減と、町の広がりが結びついている。

**⑦ Procedurally Generating Natural-Looking Villages in Minecraft with Ant Colony Optimization Algorithms**
- 書誌: Tobias Deinböck, Chu-Hsuan Hsueh, Kokolo Ikeda（北陸先端科学技術大学院大学）／2025／TAAI 2024 の論文集（Springer）pp.116–131
- URL: <https://link.springer.com/chapter/10.1007/978-981-96-4596-1_9>
- 要点: 家を置いたあと、村人役の「アリ」が家どうしを行き来し、よく通る道ほどフェロモンが残る仕組み（アリコロニー最適化）で道路網を作る。45人へのアンケートで元の村より自然だと評価され、2023年大会の地形適応部門で4位。東アジアの参加者は密な配置、ヨーロッパの参加者はまばらな配置を好む傾向もあった。
- 注目点: **日本の研究機関の研究**。道路網の形成と、密度の好みの地域差は、都市の形の議論と相性がよい。

### 3.3 評価の自動化

**⑧ Comparing PCG metrics with Human Evaluation in Minecraft Settlement Generation**
- 書誌: Jean-Baptiste Hervé, Christoph Salge／2021／FDG 2021 の PCG ワークショップ
- URL: <https://arxiv.org/abs/2107.02457>
- 要点: 自動生成の評価指標を集落向けに作り直し、人の採点との相関を調べた。特定の要素の数、ブロックの多様さ、複雑なブロックの材料がそろっているか、などが人の評価と関係していた。

**⑨ Exploring Minecraft Settlement Generators with Generative Shift Analysis**
- 書誌: Jean-Baptiste Hervé, Oliver Withington, Marion Hervé, Laurissa Tokarchuk, Christoph Salge／2023／arXiv
- URL: <https://arxiv.org/abs/2309.05371>
- 要点: 生成の前後で、各地点の見え方（アイソビスト：その地点から見える範囲の広さや形）がどれだけ変わったかを測り、生成がどこを大きく変えたかを明らかにする手法。2021年大会の20作品のデータで試した。

関連: Hervé ほか 2022「Automated Isovist Computation for Minecraft」（<https://arxiv.org/abs/2204.03752>）、Hervé, Warpefelt, Salge「Landmarks, Monuments, and Beacons: Understanding Generative Calls to Action」（<https://arxiv.org/abs/2509.19030>、目印となる場所が人の行動をどう引き出すかの枠組み）。

### 3.4 発展的な内容

| 論文 | 内容 |
| --- | --- |
| van der Staaij, Preuss, Salge 2024「Terrain-adaptive PCGML in Minecraft」（IEEE CoG 2024） | 過去の作品が生成した集落から機械学習用のデータセットを作り、生成モデル（GAN）に地形に合わせた集落を学習させた。データセットは Zenodo で公開 |
| Green, Salge, Togelius 2019「Organic Building Generation in Minecraft」（FDG 2019 の PCG ワークショップ、<https://arxiv.org/abs/1906.05094>） | 制約付きの成長とセルオートマトンで、部屋・窓・扉のある建物を生成 |
| Salge, Guckelsberger, Green, Canaan, Togelius 2019「Generative Design in Minecraft: Chronicle Challenge」（<https://arxiv.org/abs/1905.05888>） | 集落の歴史を文章で生成する部門の提案。評価は物語の質と、その集落に合っているか |
| Beukman ほか 2023「Hierarchically Composing Level Generators for the Creation of Complex Structures」（<https://arxiv.org/abs/2302.01561>） | 単純な生成器を組み合わせて大きく複雑な構造を作る手法。Minecraft で実演 |

GDMC 公式の Research Page には、ほかにも卒業論文・修士論文を含む関連研究が20件ほど載っている（例: 物語に基づくマルチエージェントの集落生成、シミュレーションに基づく村の生成の修士論文、Poisson ディスク分布と A* による配置の卒業論文）。

## 4. MineColonies の研究に活かせる点

1. **立ち位置の根拠になる**: GDMC 自身が、「身体性（住む人の立場）」の不足を課題に挙げ、エージェントベースのシミュレーションから集落を育てることを提案している（論文③）。MineColonies では市民が実際に歩いて通勤・食事・配達をするので、**住む人の立場からの機能性**を、人の印象ではなく市民の行動で確かめられる。
2. **手法をそのまま参考にできる**: 地形の特徴マップ（④）、エージェントによる反復的な配置（④⑥）、人の行き来から道ができる仕組み（⑤⑦）は、建物の配置を AI に学習させる際の土台になる。
3. **都市の形の議論とつながる**: ④の住宅・工業・商業の用途分け、⑦の密度の好みの地域差は、都市形態学やコンパクトシティ（一極集中型かネットワーク型か）の議論と結びつけられる。
4. **評価の組み合わせ**: GDMC は人の採点が中心で、自動評価はまだ発展途上（⑧⑨）。MineColonies で測れる市民の移動距離や不満の数などを加えれば、**人の印象と機能面の両方**から配置を評価できる。
5. **国内とのつながり**: 論文③の共著者の Ruck Thawonmas 氏（立命館大学）は、Minecraft の MOD で認知症の早期発見を試みた日本の研究（文献リストの J10）の共著者でもある。論文⑦は北陸先端科学技術大学院大学のグループによる研究。

## 5. 技術面の注意

- **Minecraft のバージョンが合わない**: GDMC HTTP Interface が対応しているのは Minecraft 1.19.2、1.20.2、1.21.4、1.21.10〜1.21.11 で、MineColonies（1.20.1 Forge または 1.21.1 NeoForge）と同じバージョンがない（2026-09-25 に Modrinth と GitHub で確認）。そのため、**同じワールドで両方を動かすことは今のところできない**と考えられる。
- 考えられる対応:
  1. **配置の計画だけを借りる（現実的）**: GDMC 型のアルゴリズムを Python で動かして、道・区画・建物の位置を2次元の計画図として出力し、その位置に MineColonies のハットを置く。
  2. **MOD を移植する**: GDMC HTTP Interface はオープンソース（MIT）なので、MineColonies と同じバージョン向けに移植する。作業量は大きい。
  3. **別のワールドで試す**: まずは GDMC の対応バージョンで過去の作品を動かして手法を理解し、その後 MineColonies 側に考え方を移す。
- GDMC の作品が作る建物は MineColonies のハット（職業の建物）ではないため、建物そのものはそのまま使えない。**借りられるのは「どこに何を置くか」の部分**。

## 6. 読むときのチェックリスト

論文を読むときは、次の点をメモしておくと、あとで MineColonies に移すときに役立ちます。

- 地形をどう解析しているか（高さ・傾き・水の扱い）
- 道路網をどう作っているか（先に道か、建物が先か、人の移動から作るか）
- 土地をどう区画に分けているか
- 建物の配置をどんなルール・評価で決めているか
- エージェントを使っているか。使っているなら、エージェントは何を欲し、どう動くか
- 計算にどれくらい時間がかかるか
- コードが公開されているか
- MineColonies の建物（家・職場・食堂・倉庫など）の配置に置き換えられるか

## 参考リンク

- GDMC 公式サイト: <https://gendesignmc.wikidot.com/>
- 関連論文の一覧（Research Page）: <https://gendesignmc.wikidot.com/wiki:all-research>
- 2024年大会: <https://gendesignmc.wikidot.com/wiki:2024-settlement-generation-competition>
- 2026年大会: <https://gendesignmc.wikidot.com/wiki:2026-settlement-generation-competition>
- CoG 2025 の大会ページ: <https://cog2025.inesc-id.pt/gdmc/>
- GDMC HTTP Interface: <https://github.com/Niels-NTG/gdmc_http_interface>
- GDPC: <https://github.com/avdstaaij/gdpc>、ドキュメント <https://gdpc.readthedocs.io/en/stable/>
