# 先行研究：社会課題の題材

先行研究が**どのような社会課題・社会現象を題材にしてきたか**を、幅広く整理したページです。評価指標には触れず、「何を扱ったか」だけに注目しています。個々の文献の書誌とURLは [先行研究 文献リスト](先行研究-文献リスト) にあります（本文中の M1、L1 などはそのIDです）。

## 1. 調べ方

次の5つの流れに分けて調べ、合計で約190件の研究・事例を集めました（調査日 2026-09-25）。

| 記号 | 研究の流れ | 件数 |
| --- | --- | --- |
| M | Minecraftを使った研究（LLMエージェント社会を除く） | 35 |
| L | LLM・生成エージェントによる「エージェント社会」の研究 | 37 |
| A | エージェントベース社会シミュレーション（ABM）の古典・代表研究とレビュー | 46 |
| G | Minecraft以外のゲーム・仮想世界を使った研究 | 37 |
| J | 日本の研究（Minecraft・ゲームを使った研究、日本のABM研究） | 36 |

- どの文献も、要旨ページ・DOIページ・公式ページのいずれかを開いて存在を確認しています。
- 網羅的な調査ではありません。特に、CiNii・情報処理学会電子図書館・Semantic Scholar はこの調査の環境から検索できず、**情報処理学会の文献はほぼ調べられていません**。

## 2. わかったこと（要点）

1. **題材はとても幅広い**。統治・協力・経済・世論・感染症・防災・都市計画・人口・環境・包摂・文化など、20ほどの分野にわたる。
2. **Minecraftの研究は「人が参加する場」としての利用が中心**。まちづくりへの市民参加、防災教育、SDGs・環境教育、障害のある子どもの居場所などが多い。ほかに、実際のMinecraftサーバーの自治ルールを大量に分析した研究がある（M1〜M4）。**Minecraft内でNPCの社会を動かして社会課題を調べた研究は少なく**、代表例はLLMエージェントを使った Project Sid（L1）くらいだった。
3. **LLMエージェント社会の研究は、社会科学の古典的なテーマをLLMで調べ直している**。統治・民主主義・課税、規範・慣習、協力・コモンズ、世論・誤情報、経済、感染症などが題材。Minecraftを使うものは、協働・分業の能力を測るベンチマークが中心。
4. **従来のABM研究は、意見の分極化と、協力・社会規範が二大テーマ**（レビュー A43〜A46）。政策に近い応用では、感染症・避難・交通・エネルギー・犯罪・移民がそれぞれ独立した研究分野になっている。
5. **ほかのゲームの研究**では、ゲーム内で偶然起きた疫病（World of Warcraft、G1）、仮想経済（EverQuest、EVE Online）、プレイヤー社会の観察が多い。**コロニーシム（Dwarf Fortress、Frostpunk）を「社会の実験室・思考実験」として読む研究**もある（G11、G34）。
6. **日本の研究**では、Minecraftは**防災教育とまちづくり**に集中している。ABMは**津波避難・感染症・少子高齢化・地域交通・介護・空き家**など、日本で切実な課題が多い。
7. **MineColoniesを使った学術研究は見つからなかった**（国内・国外とも。検索範囲の限界はある）。

## 3. 題材 × 研究の流れ（一覧）

表の中の記号は、その題材を扱った代表的な文献のIDです。「―」は今回の調査では見つからなかったことを表します。

| 題材 | M：Minecraft | L：LLMエージェント | A：古典ABM | G：他のゲーム | J：日本 |
| --- | --- | --- | --- | --- | --- |
| 統治・政治・ルールづくり | M1〜M6 | L1, L13, L15, L24 | A6 | G22, G25 | ― |
| 協力・社会的ジレンマ・共有資源 | M1, M28, M29 | L2, L26, L27, L29 | A2, A9, A10 | G23, G24 | ― |
| 社会規範・慣習・文化の伝播・宗教 | M3 | L1, L12, L28 | A3, A4 | G13, G16 | ― |
| 経済・格差・市場・税 | M7 | L16, L23〜L25 | A5, A19, A29〜A32 | G6〜G10 | J34 |
| 分断・世論・分極化・誤情報・選挙 | ― | L16〜L22 | A1, A33〜A35 | ― | J22 |
| 感染症・公衆衛生・医療 | M31 | L30, L31 | A5, A11〜A14 | G1〜G5 | J10, J23〜J25 |
| 防災・避難 | M13〜M15 | L16 | A15, A16 | G31, G32 | J3〜J6, J18〜J21 |
| 都市計画・まちづくり・市民参加 | M8〜M12 | ― | ― | G26〜G29 | J1, J2, J13〜J16, J21 |
| 交通・移動・観光 | ― | ― | A17, A18 | ― | J21, J31〜J33 |
| 住宅・都市の衰退・人口減少 | ― | ― | A19〜A22 | ― | J15, J27, J30 |
| 高齢化・介護・子育て・少子化 | ― | ― | A23 | ― | J10, J17, J26, J28, J29 |
| 移民・難民 | M12 | ― | A24, A25 | ― | ― |
| 犯罪・逸脱・有害行動・オンラインの安全 | M5 | L34, L35 | A26〜A28 | G14, G15, G35 | ― |
| 環境・資源・エネルギー・気候・食料 | M16〜M19 | ― | A36〜A39 | G30 | J8, J9 |
| 包摂・差別・ジェンダー・障害 | M20〜M24 | ― | ― | G17, G18 | ― |
| 孤立・コミュニティ・居場所 | M32, M34 | ― | ― | G19〜G21, G36 | J11, J12 |
| 文化・歴史・地域への愛着 | M25〜M27 | ― | A4 | G33 | J7, J11 |
| 分業・役割・組織・働き方 | ― | L1, L3〜L9 | A29, A30 | G11 | J35, J36 |
| 社会の成立・崩壊・生存 | M30 | L13〜L15 | A7, A8 | G11, G34 | ― |
| AIだけの社会の実態 | ― | L33〜L35 | ― | ― | ― |

## 4. 題材別の詳細

### 4.1 政治・統治と社会秩序

**統治・政治・ルールづくり**

- 実際のMinecraftサーバー数千〜数万件の自治ルールを分析し、コミュニティが大きく成熟するほど統治がどう変わるかを調べた研究群がある（M1〜M4）。子ども向けサーバーの自治（M5）や、サーバー規則を「原初的な統治」として論じた研究（M6）もある。
- LLMエージェントでは、Minecraft上で税法を民主的に改正する（L1）、闘争状態から社会契約で秩序が生まれる（L13）、民主的な自治が安定するか崩壊するか（L15）、住民投票で税制を決める（L24）といった題材がある。
- ほかに、市民暴動と鎮圧のABM（A6）、EVE Onlineのプレイヤー代表評議会（G22）、約100万人が1体のキャラを操作したゲームでの「民主制派」と「無政府派」の分裂（G25）。

**協力・社会的ジレンマ・共有資源（コモンズ）**

- 古典: 繰り返し囚人のジレンマによる協力の発生（A2）、バリ島の水利寺院による共有資源の管理（A9）、コモンズのジレンマの実験の再現（A10）。
- LLM: 共有の漁場を使い尽くすか（コモンズの悲劇、L26）、協力規範の文化進化（L27）、社会的学習と罰による協力の維持（L29）、生理的欲求をもつエージェントの協力（L2）。
- Minecraft: スタグハント型の協力のジレンマ（M29）、集団の中での社会的学習の人間実験（M28）。
- 大勢の匿名の人がキャンバスを取り合うReddit r/placeでの協働と対立（G23、G24）。

**社会規範・慣習・文化の伝播・宗教**

- 古典: 規範の進化（A3）、文化の伝播と分極化（A4）。
- LLM: 規範の出現と伝播（L12）、中央の調整なしに生まれる慣習と少数派による転換（L28）、Minecraft内での宗教の広がり（L1）。
- 制度の似たサーバーほど文化も似る（M3）、仮想世界でも現実の対人距離の規範が保たれる（G16）。

**社会の成立・崩壊・生存**

- 古代社会（アナサジ）の人口増加と集落放棄（A7、A8）。
- 資源が乏しいと分配より暴力が増える（L14）、闘争から秩序へ（L13）。
- コロニーシムを社会体制を試す実験室として読む研究（G11: Dwarf Fortress）、極限状態の社会運営の倫理（G34: Frostpunk）。
- Minecraftで「それらしい集落と歴史」を自動生成するコンペ（M30）。

### 4.2 経済と労働

**経済・格差・市場・税**

- Sugarscape（A5）は、資源を集めるエージェントの社会で**富の格差**、交易、文化、戦闘、感染症などをまとめて扱った代表的な人工社会。
- Minecraftの経済サーバーでは、規制のない市場で現実のどの国より大きな格差が生じた（M7）。
- 仮想世界の経済の測定（G6、G7）、EVE Onlineの経済と現実の経済状況の関係（G8、G9）、Second Lifeの仮想銀行の取り付け騒ぎ（G10）。
- LLM: マクロ経済（L23）、税制と社会厚生（L24）、町の経済で給付金が回らない現象（L25）、ベーシックインカム（L16）。
- 古典ABM: 住宅バブル（A19）、労働市場（A29、A30）、景気循環と政策（A31）、脱税（A32）。日本では地域通貨の流通（J34）。

**分業・役割・組織・働き方**

- Minecraft上のLLMエージェントが農民・鉱夫・衛兵などの職業に自然に分かれる（L1）。作業の分担・階層組織による協働を扱うMinecraftベンチマークが多い（L3〜L9）。
- ハイブリッド勤務と出社行動（J36）、農村の農地の担い手（J35）。

### 4.3 情報と世論

**分断・世論・分極化・誤情報・選挙**

- 古典: 居住分離（A1: Schelling）、意見の合意と分極化のモデル（A33〜A35）。レビューでは最大の研究群とされる（A44）。
- LLM: SNS上の情報拡散・分極化・同調（L17、L18）、意見の分断（L19）、誤情報とモデレーション（L20）、SNSの問題を改善する介入（L21）、選挙（L22）、扇動的メッセージ（L16）。
- 日本: 震災後のデマの拡散（J22）。

**AIだけの社会の実態（新しい題材）**

- AIエージェント専用のSNS「Moltbook」を観察し、AIだけの社会で本当に社会化が起きるか、有害性や安全性はどうかを調べた2026年の研究（L33〜L35）。

### 4.4 生命と安全

**感染症・公衆衛生・医療**

- 古典: インフルエンザ・COVID-19の対策評価（A11〜A14）。
- ゲーム: World of Warcraftで偶然広がった疫病「Corrupted Blood」を現実の流行のモデルとして分析（G1、G2）、Plague Inc.と健康意識（G3、G4）、Pokémon GOと運動不足（G5）。
- LLM: 自主隔離などの行動変容が自然に現れる感染症モデル（L30）、感染症下で営業規制を決める「市長」エージェント（L31）。
- Minecraft: 感染症流行時の公衆衛生システムを学ぶMod（M31）。
- 日本: COVID-19と病床・外出自粛（J23）、仮想都市での感染症対策（J24）、救急医療（J25）、認知症の早期発見のためのMinecraft MOD（J10）。

**防災・避難**

- 古典: 群集パニック（A15）、東日本大震災の津波避難（A16）。
- Minecraft: 火災時の避難行動の人間参加実験（M13）、子どもの防災参加（M14）、洪水対策の教育（M15）。
- 日本: Minecraftを使った避難所づくり・浸水リスク・水害の防災教育（J3〜J5）、津波避難の教育ゲーム（J6）、津波避難のABM（J18〜J21）。
- ゲーム: 洪水対策の啓発（G31）、ゲームにおける防災の表現（G32）。LLM: ハリケーンなどの外的ショック（L16）。

**犯罪・逸脱・有害行動・オンラインの安全**

- 古典: 空き巣・路上強盗のABM（A26、A27）と犯罪ABMのレビュー（A28）。
- ゲーム: 不正な換金ネットワークを犯罪組織のモデルに（G14）、オンラインのいじめ・有害行動（G15）、子どものオンライン安全（G35）。
- Minecraft: 子ども向けサーバーでの荒らし・対立への自治（M5）。LLM: AI専用SNSの有害性・安全性（L34、L35）。

### 4.5 都市・地域・人口

**都市計画・まちづくり・市民参加**

- Minecraftでは最も研究が多い分野の一つ。UN-Habitatの「Block by Block」による参加型の公共空間設計（M8、M9）、子どもの都市計画参加（M10）、難民と受け入れ地域の共同設計（M12）。参加型設計が「脱政治化」されるという批判（M11）もある。
- 日本: Minecraftを使ったまちづくりワークショップと合意形成（J1、J2）、PLATEAU（3D都市モデル）とMinecraftによる子どものまちづくり参加（J13、J14）、スマートシティ・地域課題を学ぶゲーム（J15、J16）。
- ほかのゲーム: SimCity・Cities: Skylinesを都市計画の教育や住民参加に使う研究（G26〜G28）、ゲーム化した住民参加（G29）。

**交通・移動・観光**

- 古典: 渋滞の発生（A17）、都市交通の大規模シミュレーション（A18）。
- 日本: 地域公共交通・オンデマンド交通（J31、J32）、観光地の混雑（J33）、交通需要マネジメント（J21）。

**住宅・都市の衰退・人口減少**

- 古典: 住宅バブル（A19）、ジェントリフィケーション（A20）、縮小都市と空き家（A21）、中心市街地の衰退（A22: 金沢市）。
- 日本: 空き家の発生と集積（J30）、人口・世帯数の将来推計（J27）、人口減少を背景としたスマートシティ（J15）。

**高齢化・介護・子育て・少子化**

- 家族による介護・育児と補助政策（A23）。
- 日本: 介護人材の不足（J26）、年金の地域差（J28）、待機児童（J29）、少子化の市民教育（J17）、認知症の早期発見（J10）。

**移民・難民**

- 難民の移動予測（A24）、移住ABMのレビュー（A25）、難民と受け入れ地域住民のMinecraftでの共同設計（M12）。

### 4.6 環境と資源

**環境・資源・エネルギー・気候・食料**

- 古典: 土地利用の変化（A36）、家庭のエネルギー選択（A37）、エネルギー転換（A38）、食料安全保障と農村の生計（A39）。
- Minecraft: SDGs・持続可能性・再生可能エネルギー・気候中立の教育（M16〜M19）。
- ゲーム: 気候変動の国際交渉のロールプレイ（G30）。
- 日本: 高レベル放射性廃棄物の処分について若者と対話するためのゲーム（J8、J9）。

### 4.7 包摂・つながり・文化

**包摂・差別・ジェンダー・障害**

- Minecraft: 自閉症の子どものための安全なサーバー「Autcraft」（M20）、低所得層・マイノリティの子どもが学習サーバーで見えない存在になる格差（M21）、自閉症児の社会技能（M22）、アイデンティティ（M23）、ジェンダー・人種の表象（M24）。
- ゲーム: 仮想世界にも持ち込まれる人種的偏見（G17）、ゲームでの性役割（G18）。

**孤立・コミュニティ・居場所**

- ゲームのギルドと社会関係資本（G19）、「サードプレイス」としてのオンラインゲーム（G20）、コロナ禍の孤立とあつまれ どうぶつの森（G21）、子どもの社交性の変化（G36）。
- Minecraft: コロナ禍の遠隔授業での孤立（M32）、オンライン集団への所属と精神的健康（M34）。
- 日本: Minecraftを使ったひきこもり・不登校の若者の支援（J11、J12）。

**文化・歴史・地域への愛着**

- Minecraft: 建築遺産の伝達（M25）、先住民族サーミの言語・文化の継承（M26）、ゲームの仕組みが植民地主義的な所有観を再生産するという批判（M27）。
- 日本: Minecraftで史跡を再現して地域への愛着（シビックプライド）を育てる（J7）、文化財の再生（J11）。
- ゲーム: Civilizationで世界史・政治を学ぶ（G33）。

## 5. 研究の流れごとの特徴

| 流れ | よく扱われる題材 | Minecraftの使われ方・特徴 |
| --- | --- | --- |
| M：Minecraft | 都市計画・市民参加、防災教育、SDGs・環境教育、包摂、文化遺産、サーバーの自治 | 人が参加するワークショップ・授業の場として使う研究が多い。実サーバーの観察（自治ルールの分析）もある。避難行動（M13）や社会的学習（M28）の人間実験の場としても使われる |
| L：LLMエージェント | 統治・民主主義・課税、規範・慣習、協力・コモンズ、世論・誤情報、経済、感染症 | Minecraftを使うものは協働・分業のベンチマークが中心。社会現象そのものを扱ったのは Project Sid（L1）のみ |
| A：古典ABM | 意見の分極化、協力・社会規範（二大テーマ）、格差、居住分離、感染症、避難、交通、住宅、犯罪、移民、エネルギー | 社会課題の種類としては最も幅広い。政策評価に使われる分野（感染症・交通・エネルギーなど）では専門のレビューがある |
| G：他のゲーム | 感染症、仮想経済、社会ネットワーク、規範・差別、コミュニティ、統治、都市計画、気候・防災 | ゲーム内で自然に起きた出来事やプレイヤー社会の観察が多い。コロニーシムを社会の思考実験として読む研究もある |
| J：日本 | 防災（津波・水害）、まちづくり、感染症、少子高齢化・介護、地域交通、空き家、観光、地域通貨 | Minecraftは防災教育とまちづくりに集中。人が参加するゲーミングとABMを組み合わせた研究（J34）もある |

## 6. MineColoniesとの関係

### 6.1 MineColoniesを使った研究

- **国内・国外とも、MineColoniesを使った学術研究は見つからなかった**。J-STAGEや、DOIの登録データベース（Crossref）で「MineColonies」を検索しても社会研究は0件で、Web検索でもMODの公式ページ・Wiki・攻略記事しか出てこない。
- CiNii・情報処理学会・Semantic Scholar は検索できていないため、「存在しない」とまでは言い切れない。

### 6.2 題材や方法が近い研究

| 研究 | 近い点 |
| --- | --- |
| L1 Project Sid | Minecraft上でエージェントの社会を動かし、役割分化・課税・民主主義・宗教の伝播を観察している |
| M1〜M4 サーバーの自治の研究 | Minecraftのコミュニティを社会として分析している（ただし人間のプレイヤー） |
| G11 Dwarf Fortress、G34 Frostpunk | コロニーシムを社会体制や倫理の実験室・思考実験として扱っている |
| A5 Sugarscape | 資源を集めるエージェントの人工社会で、格差・交易・感染症などをまとめて扱っている |
| L26 GovSim、L14 Sugarscape型LLM社会 | 資源の制約の下での協力と衝突を扱っている |
| J34 地域通貨のゲーミング＋ABM | 人が参加するゲームとエージェントの両方を使っている |

### 6.3 MineColoniesの仕組みと重なりやすい題材

[社会シミュレーションへの対応](MineColonies-社会シミュレーションへの対応) で整理した MineColonies の仕組みと照らし合わせると、先行研究の題材のうち次のものが特に重なりやすい。

- **感染症・医療**: 病気の発症と接触感染、病院、マスク・ワクチンの研究（先行研究: A11〜A14、L30、G1、J23）
- **経済・格差・分業**: 職業の割り当て、生産の連鎖（先行研究: A5、M7、L1、L23〜L25）
- **防災・安全**: 襲撃（外からのショック）、衛兵（先行研究: A15、A16、L16）
- **住宅・人口動態**: 住居、出生、移民（酒場の訪問者）（先行研究: A21、A22、A24、J27）
- **教育**: 学校・図書館（先行研究: J11、M21）
- **地域間の格差と連携**: バイオームで決まる作物、コロニー間の接続（先行研究: 該当する研究は少ない）

> MineColoniesには老化・寿命、通貨・市場、選挙の仕組みがないため、高齢化・金融・選挙などの題材は、そのままでは扱いにくい（[社会シミュレーションへの対応](MineColonies-社会シミュレーションへの対応) の「表現しにくいこと」を参照）。

---

# 先行研究 文献リスト

[先行研究：社会課題の題材](先行研究-社会課題の題材) で参照している文献の一覧です。IDの頭文字は研究の流れを表します。

| 記号 | 研究の流れ |
| --- | --- |
| M | Minecraftを使った研究（LLMエージェント社会を除く） |
| L | LLM・生成エージェントによる「エージェント社会」の研究（Minecraftを使うものは【MC】） |
| A | エージェントベース社会シミュレーション（ABM）の古典・代表研究とレビュー |
| G | Minecraft以外のゲーム・仮想世界を使った研究 |
| J | 日本の研究（Minecraft・ゲームを使った研究と、日本のABM研究） |

- 各文献は、要旨ページ・DOIページ・公式ページのいずれかを開いて存在を確認しています（2026-09-25 時点）。確認できなかった項目は「未確認」と書いています。
- 「題材」は、その研究が扱った社会課題・社会現象を短くまとめたものです。
- 研究ではない実践事例・報告書・公式発表も一部含みます（種別に明記）。

## M：Minecraftを使った研究

| ID | 研究（著者・年） | 掲載先・種別 | 環境 | 題材 | URL |
| --- | --- | --- | --- | --- | --- |
| M1 | Emergence of integrated institutions in a large population of self-governing communities（Frey & Sumner, 2019） | PLOS ONE 14(7) | Minecraftサーバー5,216件 | 共有資源の管理と自治制度。規模の大きいコミュニティほど統合された統治制度を採用するか | https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0216335 |
| M2 | Governing Online Goods: Maturity and Formalization in Minecraft, Reddit, and World of Warcraft Communities（Frey, Zhong ほか, 2022） | Proc. ACM HCI 6(CSCW2) | Minecraftサーバーほか約8万コミュニティ | コミュニティの成熟と成文ルールの形式化（Ostromの制度分析） | https://arxiv.org/abs/2202.01317 |
| M3 | Institutional similarity drives cultural similarity among online communities（Zhong & Frey, 2022） | Scientific Reports 12 | Minecraftサーバー1,097件 | 制度の類似が文化の類似を生むか | https://www.nature.com/articles/s41598-022-23223-8 |
| M4 | Quantifying the Selective, Stochastic, and Complementary Drivers of Institutional Evolution in Online Communities（Zhong, Frey & Hilbert, 2022） | Entropy 24(9):1185 | Minecraftサーバー約2万件（2年間） | 制度の進化と、環境変化に対するコミュニティの強さ | https://www.mdpi.com/1099-4300/24/9/1185 |
| M5 | Designing for Youth-Centered Moderation and Community Governance in Minecraft（Salen Tekinbaş ほか, 2021） | ACM TOCHI 28(4) | 8〜13歳向けの独自サーバー | 子どものオンライン共同体での荒らし・対立と、子ども主体の自治 | https://doi.org/10.1145/3450290 |
| M6 | The Proto-Governance of Minecraft Servers（Rolfes & Passig, 2019） | Journal for Virtual Worlds Research 12(3) | Minecraftサーバー全般 | サーバー規則・コードによる統治・サーバー間の規制競争 | https://jvwr-ojs-utexas.tdl.org/jvwr/index.php/jvwr/article/view/7365 |
| M7 | Minecraft Economics: A Study of Wealth Inequality in a Virtual World（Blackwell & Carroll, 2018） | SSRN ワーキングペーパー（査読なし） | 経済サーバー | 規制のない市場で生じる富の格差 | https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3185048 |
| M8 | The Block by Block Playbook（UN-Habitat, 2021） | 報告書 | Minecraftワークショップ | 若者・インフォーマル居住地の住民・障害者など、計画から取り残されがちな人々の公共空間設計への参加 | https://unhabitat.org/the-block-by-block-playbook-using-minecraft-as-a-participatory-design-tool-in-urban-design-and |
| M9 | Minecraft and Playful Public Participation in Urban Design（Delaney, 2022） | Urban Planning 7(2) | Minecraft（Block by Block、UCLCraft） | 都市デザインへの市民参加の民主化、コロナ禍の遠隔参加 | https://www.cogitatiopress.com/urbanplanning/article/view/5229 |
| M10 | Minecraft as a Tool for Engaging Children in Urban Planning（de Andrade ほか, 2020） | ISPRS IJGI 9(3) | Minecraft | 子どもの都市計画への参加（ブラジル・ティロル） | https://www.mdpi.com/2220-9964/9/3/170 |
| M11 | Playing, Mapping, and Power: A Critical Analysis of Using Minecraft in Spatial Design（Bashandy, 2020） | American Journal of Play 12(3) | Block by Blockの3事例 | 参加型設計の「脱政治化」と専門家の権威の再生産への批判 | https://files.eric.ed.gov/fulltext/EJ1284130.pdf |
| M12 | Designing public spaces using Minecraft brings refugees and local communities together（UN-Habitat, 2018） | 実践事例（報告記事） | Minecraftワークショップ | 難民と受け入れ地域住民の公共空間の共同設計（ケニア・カロベイエイ） | https://unhabitat.org/designing-public-spaces-using-minecraft-brings-refugees-and-local-communities-together-in-northern-kenya |
| M13 | Application of Minecraft in the study of evacuation dynamics under fire emergency conditions（Zhang ほか, 2023） | Physica A 624 | Minecraft（軌跡解析ソフトMCTrackを開発） | 火災時の群集避難行動（人間参加実験） | https://www.sciencedirect.com/science/article/abs/pii/S0378437123004909 |
| M14 | Fostering Children's Participation in Disaster Risk Reduction Through Play: A Case Study of LEGO and Minecraft（Le Dé ほか, 2021） | Int. J. Disaster Risk Science 12(6) | MinecraftとLEGO | 子どもの防災（災害リスク削減）への参加と権力関係 | https://link.springer.com/article/10.1007/s13753-021-00375-1 |
| M15 | Floodcraft（Emiroglu ほか, 2025） | Int. J. Disaster Risk Reduction 130 | Minecraft（Mod・コマンド） | 洪水対策の学習と地域の洪水対策への参加 | https://www.sciencedirect.com/science/article/abs/pii/S2212420925006235 |
| M16 | Inspired to build understanding: learning about sustainability and environmental education from within a virtual world（Gesthuizen ほか, 2025） | IRGEE 34(1) | Minecraft | SDGsに沿った建造物の設計を通じた持続可能性・環境の学習 | https://research.monash.edu/en/publications/inspired-to-build-understanding-learning-about-sustainability-and |
| M17 | Implementation of Minecraft in Education to Introduce Sustainable Development Goals（Kersánszki ほか, 2023） | SLERD 2023（Springer 書籍章） | Minecraft | 再生可能エネルギーとSDGsの学習 | https://link.springer.com/chapter/10.1007/978-981-99-5540-4_13 |
| M18 | Gamification and climate changes: a challenge in Minecraft Education Edition（Zappalà ほか, 2025） | Physics Education 60(4) | Minecraft Education | エネルギー源の切り替えによる気候中立 | https://doi.org/10.1088/1361-6552/ade2b1 |
| M19 | An Example of the Views of Educators on Incorporating the Sustainable Development Goals into Engineering and Environmental School Engagement Activities Using Minecraft（Hobbs & Behenna, 2024） | Education Sciences 14(10) | Minecraft | SDGs教育（教員11名へのインタビュー） | https://doaj.org/article/e1f779d0b95c4a5faacc87cab6d57823 |
| M20 | Making "Safe": Community-Centered Practices in a Virtual World Dedicated to Children with Autism（Ringland ほか, 2015） | CSCW '15 | Autcraft（自閉症の子ども向けサーバー） | 自閉症の子どもにとって安全なオンライン空間づくり | https://doi.org/10.1145/2675133.2675216 |
| M21 | "Connected Learning" and the Equity Agenda: A Microsociology of Minecraft Play（Ames & Burrell, 2017） | CSCW '17 | 学習向けマルチプレイサーバー | 低所得層・マイノリティの子どもが見えない存在になる構造的な格差 | https://morganya.org/research/ames-cscw17-minecraft.pdf |
| M22 | 自閉症児の社会的コミュニケーション技能（Cadieux & Keenan, 2020） | JMIR Serious Games 8(2) | Minecraft | Minecraft内で練習した社会技能が現実でも使えるか | https://games.jmir.org/2020/2/e14369/ |
| M23 | オンラインMinecraftコミュニティでの自閉症アイデンティティ（Ringland, 2019） | iConference（LNCS） | Minecraftコミュニティ | 自閉症の若者のアイデンティティ形成（抄録は未確認） | https://ouci.dntb.gov.ua/en/works/9jGWm2p7/ |
| M24 | Minecraftにおけるジェンダー・人種の表象（Anderson ほか, 2017） | FDG '17 | Minecraftとそのコミュニティ | ジェンダー・人種の交差的な表象（抄録は未確認、タイトルから判断） | https://doi.org/10.1145/3102071.3102094 |
| M25 | Cultural Heritage and Communication through Simulation Videogames—A Validation of Minecraft（Garcia-Fernandez & Medeiros, 2019） | Heritage 2(3) | Minecraft | 建築遺産を伝える手段としての適性 | https://www.mdpi.com/2571-9408/2/3/138 |
| M26 | Exploring the Use of Minecraft in Sámi Teacher Education（Føreland ほか, 2024） | Genealogy 8(2) | Minecraft | 先住民族サーミの言語再活性化と文化継承 | https://www.mdpi.com/2313-5778/8/2/59 |
| M27 | On the 10-year anniversary of Minecraft: two interventions in extractive colonialism（Brazelton, 2020。オンライン公開は2019） | Cultural Geographies 27(3) | Minecraft | ゲームの仕組みが植民地主義的な所有観を再生産するという批判 | https://journals.sagepub.com/doi/10.1177/1474474019890319 |
| M28 | Adaptive mechanisms of social and asocial learning in immersive collective foraging（Wu ほか, 2025） | Nature Communications 16 | Minecraft上の集団採餌課題 | 集団の中で他者から学ぶか自分で探索するか（社会的学習、人間実験） | https://www.nature.com/articles/s41467-025-58365-6 |
| M29 | The Malmo Platform for Artificial Intelligence Experimentation（Johnson ほか, 2016）と Malmo Collaborative AI Challenge（2017） | IJCAI 2016／Microsoft Research のコンペ | Project Malmo | 協力するか単独で安全を取るかというスタグハント型の社会的ジレンマ | https://www.ijcai.org/abstract/16/643 |
| M30 | Generative Design in Minecraft（GDMC）関連（Salge ほか, 2018・2019・2020） | FDG'18／ICCC 2019／KI 34(1) | Minecraft（集落の自動生成コンペ） | 社会課題そのものではなく、地形に適応した信憑性のある集落と、その歴史の物語の生成 | https://arxiv.org/abs/1803.09853 |
| M31 | Learn around the block: communicating population health in Minecraft（ANU NCEPH, 2023） | 大学のプロジェクト紹介（査読論文は未確認） | 独自Mod「Syndemitown」 | 感染症流行時の公衆衛生システム（役割分担による協働）の学習 | https://nceph.anu.edu.au/news-events/news/learn-around-block-communicating-population-health-minecraft |
| M32 | Minecraft as an Educational Tool Before, During, and After the Pandemic: A Case Study Research Project（Cigognini & Nardi, 2024） | EURODL 26(1) | Minecraft | 遠隔授業での社会的孤立の克服 | https://eurodljournal.com/articles/10.2478/eurodl-2024-0011 |
| M33 | Playing in the Virtual Sandbox: Students' Collaborative Practices in Minecraft（Davis ほか, 2018） | IJGBL 8(3) | Minecraft | 子どもの協働に影響する要因 | https://doi.org/10.4018/IJGBL.2018070104 |
| M34 | 集団への所属と精神的健康（Riordan & Scarf, 2017） | F1000Research（意見論文） | Autcraft、Block by Block | オンライン集団への所属がもたらす精神的健康への効果 | https://f1000research.com/articles/5-2339 |
| M35 | The Uncensored Library（国境なき記者団 RSF, 2020） | NGOの活動（研究ではない） | Minecraft内の図書館 | 報道の自由・検閲された記事の公開 | https://rsf.org/en/rsf-opens-uncensored-library-digital-home-press-freedom-within-global-computer-game |

> 日本の Minecraft 研究（まちづくり・防災教育など）は J の欄にまとめています。

## L：LLM・生成エージェントによる「エージェント社会」の研究

| ID | 研究（著者・年） | 掲載先・種別 | 環境 | 題材 | URL |
| --- | --- | --- | --- | --- | --- |
| L1 | 【MC】Project Sid: Many-agent simulations toward AI civilization（Altera.AL, 2024） | 技術報告（arXiv） | Minecraft（最大500体以上） | 職業・役割の自然発生、税法の民主的な改正、宗教の伝播 | https://arxiv.org/abs/2411.00114 |
| L2 | 【MC】MineLand（Yu ほか, 2024） | arXiv | Minecraft（64体以上） | 限られた感覚と生理的欲求の下での協力・集団行動 | https://arxiv.org/abs/2403.19267 |
| L3 | 【MC】Collaborating Action by Action（MINDcraft／MineCollab）（White ほか, 2025） | arXiv | Minecraft | 身体を持つエージェント同士の協働とコミュニケーション | https://arxiv.org/abs/2504.17950 |
| L4 | 【MC】VillagerAgent（Dong ほか, 2024） | Findings of ACL 2024 | Minecraft | 依存関係のある作業の分担・調整（分業） | https://aclanthology.org/2024.findings-acl.964/ |
| L5 | 【MC】S-Agents: Self-organizing Agents in Open-ended Environments（Chen ほか, 2024） | ICLR 2024 Workshop | Minecraft | 人間の組織を模した階層構造での自己組織化 | https://arxiv.org/abs/2402.04578 |
| L6 | 【MC】PillagerBench（Schipper ほか, 2025） | IEEE CoG 2025 | Minecraft（チーム対チーム） | チーム内の協力とチーム間の競争 | https://arxiv.org/abs/2509.06235 |
| L7 | 【MC（一部）】MindAgent: Emergent Gaming Interaction（Gong ほか, 2024） | Findings of NAACL 2024 | 独自ゲームとMinecraft | 人間とAIのNPCの協働 | https://aclanthology.org/2024.findings-naacl.200/ |
| L8 | 【MC】TeamCraft（Long ほか, 2024） | arXiv | Minecraft | チーム協働 | https://arxiv.org/abs/2412.05255 |
| L9 | 【MC】CraftUtopia（著者は未確認, 2026） | AAMAS 2026（デモ） | Minecraft | 管理者・現場監督・作業員の階層組織による協働建築 | https://github.com/craftutopia-demo/CraftUtopia |
| L10 | Generative Agents: Interactive Simulacra of Human Behavior（Park ほか, 2023） | UIST 2023 | 独自の町「Smallville」（25体） | 日常生活、情報の伝わり方、人間関係の形成 | https://arxiv.org/abs/2304.03442 |
| L11 | Humanoid Agents（Wang ほか, 2023） | EMNLP 2023 Demo | 独自の町 | 基本的欲求・感情・親密度が行動に与える影響 | https://arxiv.org/abs/2310.05418 |
| L12 | Emergence of Social Norms in Generative Agent Societies（Ren ほか, 2024） | IJCAI 2024 | Smallville | 社会規範の出現と伝播 | https://www.ijcai.org/proceedings/2024/874 |
| L13 | Artificial Leviathan（Dai ほか, 2026） | Frontiers in Physics（arXiv 2024） | 資源の乏しいサンドボックス | 闘争状態から社会契約による秩序が生まれる過程（ホッブズ） | https://www.frontiersin.org/journals/physics/articles/10.3389/fphy.2026.1700712/full |
| L14 | Do Large Language Model Agents Exhibit a Survival Instinct?（Masumori & Ikegami, 2025） | arXiv | Sugarscape型の世界 | 資源の希少性と、分配・暴力の関係 | https://arxiv.org/abs/2508.12920 |
| L15 | Emergence World（Akkil ほか, 2026） | arXiv | 常時稼働する共有世界 | 民主的な自治と、それが安定するか崩壊するか | https://arxiv.org/abs/2606.08367 |
| L16 | AgentSociety（Piao ほか, 2025） | arXiv | 都市・社会・経済の統合シミュレータ（1万体以上） | 分極化、扇動的メッセージ、ベーシックインカム、ハリケーン | https://arxiv.org/abs/2502.08691 |
| L17 | S³: Social-network Simulation System（Gao ほか, 2023） | arXiv | SNSシミュレータ | 情報・態度・感情の伝播 | https://arxiv.org/abs/2307.14984 |
| L18 | OASIS（Yang ほか, 2024） | arXiv | X型・Reddit型SNS（最大100万体） | 情報拡散・集団の分極化・同調 | https://arxiv.org/abs/2411.11581 |
| L19 | Simulating Opinion Dynamics with Networks of LLM-based Agents（Chuang ほか, 2024） | Findings of NAACL 2024 | 議論ネットワーク | 意見の動態と分極化（確証バイアス） | https://aclanthology.org/2024.findings-naacl.211/ |
| L20 | MOSAIC（Liu ほか, 2025） | EMNLP 2025 | SNS | 誤情報の拡散とコンテンツモデレーション | https://aclanthology.org/2025.emnlp-main.325/ |
| L21 | Can We Fix Social Media?（Larooij & Törnberg, 2025） | arXiv | 合成SNS | エコーチェンバー・影響力の集中と、それを改善する介入 | https://arxiv.org/abs/2508.03385 |
| L22 | ElectionSim（Zhang ほか, 2024） | arXiv | 選挙シミュレータ | 選挙の投票行動と世論 | https://arxiv.org/abs/2410.20746 |
| L23 | EconAgent（Li ほか, 2024） | ACL 2024 | マクロ経済シミュレーション | 家計の労働・消費の判断から生まれるマクロ経済 | https://arxiv.org/abs/2310.10436 |
| L24 | LLM Economist（Karten ほか, 2025） | arXiv | 労働者と政策立案者の経済 | 税制の設計と社会厚生、住民投票による統治 | https://arxiv.org/abs/2507.15815 |
| L25 | But How Would AI Agents Run a Town's Economy?（Regmi ほか, 2026） | arXiv | 仮想のポカラ（ネパール）の町経済（100体） | 需要が伸びても賃金に波及しない、給付金が回らない | https://arxiv.org/html/2609.11108 |
| L26 | Cooperate or Collapse（GovSim）（Piatti ほか, 2024） | NeurIPS 2024 | 共有資源（漁場など） | コモンズの悲劇 | https://arxiv.org/abs/2404.16698 |
| L27 | Cultural Evolution of Cooperation among LLM Agents（Vallinder & Hughes, 2024） | arXiv | 寄付ゲーム | 間接互恵性による協力規範の文化進化 | https://arxiv.org/abs/2412.10270 |
| L28 | Emergent social conventions and collective bias in LLM populations（Flint Ashery ほか, 2025） | Science Advances 11 | 命名ゲーム | 社会的慣習の形成と集団としての偏り、少数派による転換 | https://arxiv.org/abs/2410.08948 |
| L29 | The Role of Social Learning and Collective Norm Formation in Fostering Cooperation（Gupta ほか, 2026） | AAMAS 2026 | 共有資源 | 社会的学習・規範・罰による協力の維持（Ostromの原則） | https://arxiv.org/abs/2510.14401 |
| L30 | Epidemic Modeling with Generative Agents（Williams ほか, 2023） | arXiv | 町の感染症モデル | 自主隔離・外出自粛などの行動変容と流行の波 | https://arxiv.org/abs/2307.04986 |
| L31 | AI Agents as Policymakers in Simulated Epidemics（Aoki & Ghaffarzadegan, 2026） | arXiv | 感染症シミュレーションの市長役 | 感染症下の営業規制の判断 | https://arxiv.org/abs/2601.04245 |
| L32 | CivRealm（Qi ほか, 2024） | ICLR 2024 | Freeciv | 文明の発展・外交・交渉 | https://arxiv.org/abs/2401.10568 |
| L33 | Does Socialization Emerge in AI Agent Society? A Case Study of Moltbook（Li, Li & Zhou, 2026） | arXiv | AIエージェント専用SNS「Moltbook」 | AIだけの社会で「社会化」が起きるか | https://arxiv.org/abs/2602.14299 |
| L34 | "Humans welcome to observe": A First Look at the Agent Social Network Moltbook（Jiang ほか, 2026） | arXiv | Moltbook | 話題の集中、分断を招く物語、有害性 | https://arxiv.org/abs/2602.10127 |
| L35 | Agents in the Wild: Safety, Society, and the Illusion of Sociality on Moltbook（Zhang ほか, 2026） | arXiv | Moltbook | 統治・経済の仕組みの出現と「見かけだけの社会性」、安全性 | https://arxiv.org/abs/2602.13284 |
| L36 | Concordia: Generative agent-based modeling（Vezhnevets ほか, 2023） | arXiv（Google DeepMind） | 生成ABMライブラリ | 社会科学向けの生成型エージェントモデルの基盤 | https://arxiv.org/abs/2312.03664 |
| L37 | Large language models empowered agent-based modeling and simulation: a survey and perspectives（Gao ほか, 2024） | Humanities and Social Sciences Communications 11 | サーベイ | LLMを使ったABMの分野全体の整理 | https://www.nature.com/articles/s41599-024-03611-3 |

## A：エージェントベース社会シミュレーション（ABM）の古典・代表研究とレビュー

| ID | 研究（著者・年） | 掲載先・種別 | 題材 | URL |
| --- | --- | --- | --- | --- |
| A1 | Dynamic models of segregation（Schelling, 1971） | Journal of Mathematical Sociology 1(2) | 居住分離。弱い好みでも社会全体では強い分離が生まれる | https://doi.org/10.1080/0022250X.1971.9989794 |
| A2 | The Evolution of Cooperation（Axelrod & Hamilton, 1981） | Science 211 | 利己的な個人の間での協力の発生と維持（繰り返し囚人のジレンマ） | https://doi.org/10.1126/science.7466396 |
| A3 | An Evolutionary Approach to Norms（Axelrod, 1986） | American Political Science Review 80 | 社会規範（違反者への制裁）の発生と定着 | https://doi.org/10.2307/1960858 |
| A4 | The Dissemination of Culture（Axelrod, 1997） | Journal of Conflict Resolution 41(2) | 文化の伝播。地域ごとの均質化と社会全体の分極化 | https://journals.sagepub.com/doi/10.1177/0022002797041002001 |
| A5 | Growing Artificial Societies（Sugarscape）（Epstein & Axtell, 1996） | 書籍（MIT Press / Brookings） | 富の格差、交易・市場、文化、部族間の戦闘、感染症、人口変動、汚染 | https://www.brookings.edu/books/growing-artificial-societies/ |
| A6 | Modeling civil violence: An agent-based computational approach（Epstein, 2002） | PNAS 99(suppl.3) | 市民暴動・反乱と鎮圧 | https://doi.org/10.1073/pnas.092080199 |
| A7 | Population growth and collapse in a multiagent model of the Kayenta Anasazi（Axtell ほか, 2002） | PNAS 99 | 古代社会（アナサジ）の人口増加と集落放棄 | https://doi.org/10.1073/pnas.092080799 |
| A8 | Understanding Artificial Anasazi（Janssen, 2009） | JASSS 12(4) | A7の再現・分析 | https://www.jasss.org/12/4/13.html |
| A9 | Emergent Properties of Balinese Water Temple Networks（Lansing & Kremer, 1993） | American Anthropologist 95(1) | 水利寺院による灌漑・害虫対策の協調（中央集権なしの共有資源管理） | https://doi.org/10.1525/aa.1993.95.1.02a00050 |
| A10 | Simulating Common Pool Resource Management Experiments with Adaptive Agents（Deadman ほか, 2000） | JASSS 3(2) | コモンズのジレンマと、コミュニケーション・制度の違い | https://www.jasss.org/3/2/2.html |
| A11 | Strategies for mitigating an influenza pandemic（Ferguson ほか, 2006） | Nature 442 | 新型インフルエンザ対策（渡航制限・学校閉鎖・ワクチンなど） | https://www.nature.com/articles/nature04795 |
| A12 | Report 9: Impact of non-pharmaceutical interventions to reduce COVID-19 mortality and healthcare demand（Ferguson ほか, 2020） | Imperial College London 報告書 | COVID-19と行動制限（社会的距離・隔離など） | https://www.imperial.ac.uk/mrc-global-infectious-disease-analysis/covid-19/report-9-impact-of-npis-on-covid-19/ |
| A13 | Covasim: An agent-based model of COVID-19 dynamics and interventions（Kerr ほか, 2021） | PLOS Computational Biology 17 | COVID-19対策の評価 | https://doi.org/10.1371/journal.pcbi.1009149 |
| A14 | Modelling to contain pandemics（Epstein, 2009） | Nature 460（論評） | H1N1流行への対処とABMの有用性 | https://www.nature.com/articles/460687a |
| A15 | Simulating dynamical features of escape panic（Helbing ほか, 2000） | Nature 407 | 緊急避難時の群集パニックと建物設計 | https://www.nature.com/articles/35035023 |
| A16 | Agent-based Simulation of the 2011 Great East Japan Earthquake/Tsunami Evacuation（Mas ほか, 2012） | Journal of Natural Disaster Science 34(1) | 津波避難（仙台市荒浜地区、徒歩・車の経路と避難所） | https://www.jstage.jst.go.jp/article/jnds/34/1/34_41/_article/-char/ja/ |
| A17 | A cellular automaton model for freeway traffic（Nagel & Schreckenberg, 1992） | Journal de Physique I 2(12) | 高速道路の渋滞の発生 | https://doi.org/10.1051/jp1:1992277 |
| A18 | The Multi-Agent Transport Simulation MATSim（Horni ほか編, 2016） | 書籍（Ubiquity Press） | 都市交通・移動と交通政策 | https://www.ubiquitypress.com/site/books/10.5334/baw/ |
| A19 | Getting at Systemic Risk via an Agent-Based Model of the Housing Market（Geanakoplos ほか, 2012） | American Economic Review 102(3) | 住宅バブルと崩壊（ワシントンDC） | https://www.aeaweb.org/articles?id=10.1257/aer.102.3.53 |
| A20 | Modeling gentrification dynamics: A hybrid approach（Torrens & Nara, 2007） | Computers, Environment and Urban Systems 31(3) | ジェントリフィケーション | https://doi.org/10.1016/j.compenvurbsys.2006.07.004 |
| A21 | Modeling and simulating residential mobility in a shrinking city（Haase ほか, 2010） | Environmental Modelling & Software 25(10) | 縮小都市での転居と空き家化 | https://doi.org/10.1016/j.envsoft.2010.04.009 |
| A22 | Agent-Based Simulation of Residential Promoting Policy Effects on Downtown Revitalization（Ma ほか, 2013） | JASSS 16(2) | 中心市街地の衰退と、まちなか居住の家賃補助（金沢市） | https://www.jasss.org/16/2/2.html |
| A23 | Social and child care provision in kinship networks（Gostoli & Silverman, 2020） | PLOS ONE 15(12) | 高齢化と家族による介護・育児、補助政策（英国） | https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0242779 |
| A24 | A generalized simulation development approach for predicting refugee destinations（Suleimenova ほか, 2017） | Scientific Reports 7 | 難民の移動予測と人道支援 | https://www.nature.com/articles/s41598-017-13828-9 |
| A25 | Decision-Making in Agent-Based Models of Migration（Klabunde & Willekens, 2016） | European Journal of Population 32(1)（レビュー） | 移住（移民）のABM | https://link.springer.com/article/10.1007/s10680-015-9362-0 |
| A26 | Crime reduction through simulation: An agent-based model of burglary（Malleson ほか, 2010） | Computers, Environment and Urban Systems 34(3) | 空き巣と防犯政策 | https://eprints.whiterose.ac.uk/76813/ |
| A27 | Simulation for Theory Testing and Experimentation: Routine Activity Theory and Street Robbery（Groff, 2007） | Journal of Quantitative Criminology 23 | 路上強盗と日常活動理論 | https://link.springer.com/article/10.1007/s10940-006-9021-z |
| A28 | Agent-Based Modeling in Criminology（Birks ほか, 2025） | Annual Review of Criminology 8（レビュー） | 犯罪・警察活動全般 | https://www.annualreviews.org/content/journals/10.1146/annurev-criminol-022222-033905 |
| A29 | Structure, behavior, and market power in an evolutionary labor market with adaptive search（Tesfatsion, 2001） | Journal of Economic Dynamics and Control 25 | 労働市場の交渉力 | https://doi.org/10.1016/s0165-1889(00)00032-4 |
| A30 | Agent-based models of the labor market（Neugart & Richiardi, 2012） | ワーキングペーパー（レビュー） | 労働市場・失業と労働政策 | https://ideas.repec.org/p/cca/wplabo/125.html |
| A31 | Schumpeter meeting Keynes（Dosi ほか, 2010） | Journal of Economic Dynamics and Control 34(9) | 景気循環・失業・成長と経済政策 | https://ideas.repec.org/a/eee/dyncon/v34y2010i9p1748-1767.html |
| A32 | A Comparison of Agent-Based Models of Income Tax Evasion（Bloomquist, 2006） | Social Science Computer Review 24(4) | 所得税の脱税と税務調査 | https://journals.sagepub.com/doi/abs/10.1177/0894439306287021 |
| A33 | Mixing beliefs among interacting agents（Deffuant ほか, 2000） | Advances in Complex Systems 3 | 意見形成（合意か分裂か） | https://doi.org/10.1142/S0219525900000078 |
| A34 | Opinion dynamics and bounded confidence（Hegselmann & Krause, 2002） | JASSS 5(3) | 意見の合意・分極化・分裂 | https://www.jasss.org/5/3/2.html |
| A35 | Models of Social Influence: Towards the Next Frontiers（Flache ほか, 2017） | JASSS 20(4)（レビュー） | 社会的影響・意見の分極化 | https://www.jasss.org/20/4/2.html |
| A36 | Multi-Agent Systems for the Simulation of Land-Use and Land-Cover Change: A Review（Parker ほか, 2003） | Annals of the AAG 93(2)（レビュー） | 土地利用の変化（都市化・農地転用） | https://doi.org/10.1111/1467-8306.9302004 |
| A37 | Agent-based modelling of consumer energy choices（Rai & Henry, 2016） | Nature Climate Change 6 | 家庭のエネルギー選択と脱炭素政策 | https://www.nature.com/articles/nclimate2967 |
| A38 | Models Within Models – Agent-Based Modelling and Simulation in Energy Systems Analysis（Klein ほか, 2019） | JASSS 22(4)（レビュー） | エネルギー転換 | https://www.jasss.org/22/4/6.html |
| A39 | Agent-Based Modelling to Assess Community Food Security and Sustainable Livelihoods（Dobbie ほか, 2018） | JASSS 21(1) | 食料安全保障と農村の生計（マラウイ） | https://www.jasss.org/21/1/9.html |
| A40 | Agent-based modeling: Methods and techniques for simulating human systems（Bonabeau, 2002） | PNAS 99（レビュー） | 応用分野: 人や物の流れ（交通・避難）、組織、市場、普及 | https://doi.org/10.1073/pnas.082080899 |
| A41 | From Factors to Actors: Computational Sociology and Agent-Based Modeling（Macy & Willer, 2002） | Annual Review of Sociology 28（レビュー） | 応用分野: 拡散、規範、慣習、集合行為 | https://www.annualreviews.org/content/journals/10.1146/annurev.soc.28.110601.141117 |
| A42 | A Survey of Agent-Based Modeling Practices (1998–2008)（Heath ほか, 2009） | JASSS 12(4)（レビュー） | 279本の分類。上位は経済・社会科学・生物 | https://www.jasss.org/12/4/9.html |
| A43 | The Development of Social Simulation as Reflected in the First Ten Years of JASSS（Meyer ほか, 2009） | JASSS 12(4)（引用分析） | 主な研究群: 規範・慣習、拡散、評判、互恵性、意見動態、資源管理、人工市場、社会的ジレンマ | https://www.jasss.org/12/4/12.html |
| A44 | Recent Development of Social Simulation as Reflected in JASSS Between 2008 and 2014（Hauke ほか, 2017） | JASSS 20(1)（引用分析） | 意見動態が最大の研究群。協力の進化・規範が続く | https://www.jasss.org/20/1/5.html |
| A45 | Social Simulation in the Social Sciences: A Brief Overview（Squazzoni ほか, 2014） | Social Science Computer Review 32(3)（レビュー） | 応用分野: 意見、拡散、協力、信頼、健康、市場、規範、公共政策 | https://doi.org/10.1177/0894439313512975 |
| A46 | Agent-based models in sociology（Bianchi & Squazzoni, 2015） | WIREs Computational Statistics 7(4)（レビュー） | 協力と社会規範（最も活発）、社会的影響（居住分離・意見・不平等） | https://doi.org/10.1002/wics.1356 |

## G：Minecraft以外のゲーム・仮想世界を使った研究

| ID | 研究（著者・年） | 掲載先・種別 | ゲーム・場 | 題材 | URL |
| --- | --- | --- | --- | --- | --- |
| G1 | The untapped potential of virtual game worlds to shed light on real world epidemics（Lofgren & Fefferman, 2007） | Lancet Infectious Diseases 7(9) | World of Warcraft（Corrupted Blood事件） | ゲーム内で偶然広がった疫病を、現実の感染症流行のモデルとして分析 | https://www.sciencedirect.com/science/article/abs/pii/S1473309907702128 |
| G2 | Modeling infectious diseases dissemination through online role-playing games（Balicer, 2007） | Epidemiology 18(2) | World of Warcraft | 仮想の流行と現実の流行の類似 | https://cris.bgu.ac.il/en/publications/modeling-infectious-diseases-dissemination-through-online-role-pl |
| G3 | Health Communication in Games at the Early Stage of COVID-19 Epidemic（Jiang ほか, 2021） | Games for Health Journal 10(6) | Plague Inc. | 感染症ゲームによる健康意識・リスク認知 | https://journals.sagepub.com/doi/abs/10.1089/g4h.2020.0135 |
| G4 | Playing at apocalypse: Reading Plague Inc. in pandemic culture（Mitchell & Hamilton, 2018） | Convergence 24(6) | Plague Inc. | パンデミックへの社会的な不安の表現 | https://journals.sagepub.com/doi/abs/10.1177/1354856516687235 |
| G5 | Influence of Pokémon Go on Physical Activity（Althoff ほか, 2016） | J Medical Internet Research 18(12) | Pokémon GO | 運動不足という公衆衛生課題 | https://homes.cs.washington.edu/~althoff/docs/althoff_pokemon_go_physical_activity_jmir.pdf |
| G6 | Virtual Worlds: A First-Hand Account of Market and Society on the Cyberian Frontier（Castronova, 2001） | CESifo Working Paper | EverQuest | 仮想世界の経済（GNP・時給・為替）と富の格差 | https://papers.ssrn.com/sol3/papers.cfm?abstract_id=294828 |
| G7 | Synthetic Worlds: The Business and Culture of Online Games（Castronova, 2005。出版社ページの表記は2006年） | 書籍（University of Chicago Press） | EverQuest、WoW など | 仮想経済のインフレ・労働市場と、仮想社会の統治 | https://press.uchicago.edu/ucp/books/book/chicago/S/bo3620704.html |
| G8 | On the connection between real-world circumstances and online player behaviour: The case of EVE Online（Belaza ほか, 2020） | PLOS ONE | EVE Online | 現実の攻撃性・失業率・為替とゲーム内の行動の関係 | https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0240196 |
| G9 | EVE Online Appoints In-World Economist（CCP Games, 2007） | 公式発表 | EVE Online | 専任の経済学者による仮想経済の観測・報告 | https://community.eveonline.com/news/news-channels/press-releases/eve-online-appoints-in-world-economist-1/ |
| G10 | Second Life の Ginko Financial 取り付け騒ぎ（2007） | 報道記録 | Second Life | 仮想経済で起きた金融危機と規制 | https://ebiquity.umbc.edu/blogger/2007/08/08/second-life-economic-crisis-bank-run-on-ginko-financial/ |
| G11 | Dwarf Fortress: Laboratory and Homestead（Fordyce, 2018） | Games and Culture 13(1) | Dwarf Fortress（コロニーシム） | 社会階層や生産体制を試す「実験室」としてのコロニーシム | https://journals.sagepub.com/doi/abs/10.1177/1555412015603192 |
| G12 | Multirelational organization of large-scale social networks in an online world（Szell ほか, 2010） | PNAS 107(31) | Pardus | 友好・交易・敵対などの社会関係の構造（構造バランス理論） | https://csh.ac.at/publication/multirelational-organization-of-large-scale-social-networks-in-an-online-world/ |
| G13 | Emergence of Good Conduct, Scaling and Zipf Laws in Human Behavioral Sequences in an Online World（Thurner ほか, 2012） | PLOS ONE 7(1) | Pardus | 攻撃・処罰・協力的行動の連鎖と「善い振る舞い」 | https://researcher.itu.dk/p/en/research-outputs/emergence-of-good-conduct-scaling-and-zipf-laws-in-human-behavior |
| G14 | Dark Gold: Statistical Properties of Clandestine Networks in MMOGs（Keegan ほか, 2010） | IEEE SocialCom 2010 | EverQuest II | 不正な換金ネットワークを犯罪組織のモデルとして分析 | https://experts.umn.edu/en/publications/dark-gold-statistical-properties-of-clandestine-networks-in-massi/ |
| G15 | Exploring Cyberbullying and Other Toxic Behavior in Team Competition Online Games（Kwak ほか, 2015） | ACM CHI 2015 | League of Legends | オンラインのいじめ・有害行動 | https://ar5iv.labs.arxiv.org/html/1504.02305 |
| G16 | The Unbearable Likeness of Being Digital（Yee ほか, 2007） | CyberPsychology & Behavior 10(1) | Second Life | 現実の非言語的な社会規範（対人距離・視線）が仮想世界でも保たれるか | https://journals.sagepub.com/doi/abs/10.1089/cpb.2006.9984 |
| G17 | Is it a game? Evidence for social influence in the virtual world（Eastwick & Gardner, 2009） | Social Influence 4(1) | There.com | 説得技法の効果と、アバターの肌の色による人種的偏見 | https://www.scholars.northwestern.edu/en/publications/is-it-a-game-evidence-for-social-influence-in-the-virtual-world |
| G18 | Looking for Gender: Gender Roles and Behaviors among Online Gamers（Williams ほか, 2009） | Journal of Communication 59(4) | EverQuest II | ゲームでの性役割・ジェンダーの固定観念 | https://academic.oup.com/joc/article-abstract/59/4/700/4098413 |
| G19 | From Tree House to Barracks: The Social Life of Guilds in World of Warcraft（Williams ほか, 2006） | Games and Culture 1(4) | World of Warcraft | ギルドの規模・構造と社会関係資本 | https://journals.sagepub.com/doi/10.1177/1555412006292616 |
| G20 | Where Everybody Knows Your (Screen) Name: Online Games as "Third Places"（Steinkuehler & Williams, 2006） | Journal of Computer-Mediated Communication 11(4) | Lineage、Asheron's Call | 「サードプレイス」としてのオンラインゲームと社会関係資本 | https://academic.oup.com/jcmc/article-abstract/11/4/885/4617703 |
| G21 | New Social Horizons: Anxiety, Isolation, and Animal Crossing During the COVID-19 Pandemic（Lewis ほか, 2021） | Frontiers in Virtual Reality | あつまれ どうぶつの森 | ロックダウン中の社会的孤立・不安 | https://www.frontiersin.org/journals/virtual-reality/articles/10.3389/frvir.2021.627350/full |
| G22 | "Democracy" in a Virtual World: EVE Online's Council of Stellar Management（Ireland, 2013） | 修士論文 | EVE Online | プレイヤーが選ぶ代表評議会は民主主義として機能するか | https://minds.wisc.edu/items/865013ca-e024-4ddc-adac-f2a33b18b778 |
| G23 | Latent Structure in Collaboration: The Case of Reddit r/place（Rappaz ほか, 2018） | ICWSM 12(1) | Reddit r/place | 匿名の大人数が自然に組織を作って協働する仕組み | https://ojs.aaai.org/index.php/ICWSM/article/view/15013 |
| G24 | No Place for Old Memes: Large-scale Collective Dynamics in the Three Iterations of Reddit r/place（Wu & Silva, 2024） | arXiv（査読付き掲載先は未確認） | Reddit r/place | 連合の形成・社会的手抜き・協力と対立 | https://arxiv.org/html/2408.13236v2 |
| G25 | The dynamics of collective social behavior in a crowd controlled game（Aleta & Moreno, 2019） | EPJ Data Science 8 | Twitch Plays Pokémon | 集団での目標達成、「民主制派」と「無政府派」の分裂 | https://link.springer.com/article/10.1140/epjds/s13688-019-0200-1 |
| G26 | SimCity in the Community Planning Classroom（Terzano & Morckel, 2017） | Journal of Planning Education and Research 37(1) | SimCity | 都市計画教育でのシステム思考・地域理解 | https://journals.sagepub.com/doi/abs/10.1177/0739456X16628959 |
| G27 | The Case of Cities: Skylines Versions—Affordances in Urban Planning Education（Cañete Sanz ほか, 2025） | Media and Communication | Cities: Skylines | 都市計画教育・住民参加・交通・持続可能な設計 | https://pure.eur.nl/en/publications/the-case-of-cities-skylines-versionsaffordances-in-urban-planning/ |
| G28 | Urban Development Modelling: The Potential of Gaming Simulators for Education and Participatory Planning（Fedorenko, 2026） | Ekonomichna ta Sotsialna Geografiya 95 | Cities: Skylines | 住民参加型計画、戦後復興計画（ウクライナ） | https://www.bulletin-esgeograph.org.ua/esg/article/view/95-fedorenko-126-152 |
| G29 | Playful Civic Learning（Gordon & Baldwin-Philippi, 2014） | International Journal of Communication 8 | Community PlanIt | ゲーム化した住民参加での住民同士の信頼と市民としての学び | https://ijoc.org/index.php/ijoc/article/view/2195 |
| G30 | WORLD CLIMATE: A Role-Play Simulation of Climate Negotiations（Sterman ほか, 2015） | Simulation & Gaming 46(3–4) | World Climate（C-ROADS） | 気候変動の国際交渉 | https://dspace.mit.edu/handle/1721.1/109268 |
| G31 | Societal impact of a serious game on raising public awareness: the case of FloodSim（Rebolledo-Mendez ほか, 2009） | ACM Sandbox '09 | FloodSim | 洪水リスクと洪水対策政策への市民の理解 | https://pureportal.coventry.ac.uk/en/publications/societal-impact-of-a-serious-game-on-raising-public-awareness-the-2 |
| G32 | Stop Disasters 2.0: Video Games as Tools for Disaster Risk Reduction（Gampell & Gaillard, 2016） | Int. J. Mass Emergencies & Disasters 34(2) | Stop Disasters!、SimCity など | ゲームにおける災害・脆弱性・防災の表現 | https://journals.sagepub.com/doi/10.1177/028072701603400205 |
| G33 | Changing the Game: What Happens When Video Games Enter the Classroom?（Squire, 2005） | Innovate 1(6) | Civilization III | 世界史・地理・政治の学習 | https://nsuworks.nova.edu/cgi/viewcontent.cgi?httpsredir=1&article=1168&context=innovate |
| G34 | Aesth(ethics) in Ludonarrative Experiences: 11Bit's Frostpunk（Oliveros García, 2025） | Humanities 14(12) | Frostpunk | 極限状態の社会運営での倫理的なジレンマ | https://www.mdpi.com/2076-0787/14/12/242 |
| G35 | Navigating parental concerns in children's engagement with Roblox（Tunca, 2025） | BMC Psychology | Roblox（保護者のReddit投稿） | 子どものデジタル安全・課金・交流のリスク | https://link.springer.com/article/10.1186/s40359-025-03802-w |
| G36 | "Fortnite" and New Kids' Sociabilities（Andrade & Ferreira, 2021） | European Journal of Social Sciences Articles 4 | Fortnite | 子どもの社交性の変化 | https://ideas.repec.org/a/eur/ejssjr/82.html |
| G37 | EVE Online Project Discovery（Sullivan ほか, 2018） | Nature Biotechnology（phys.org の解説で確認） | EVE Online | ゲーム内の市民科学・集合知（社会課題そのものではない） | https://phys.org/news/2018-08-cells-proteins-combined-gamers-ai.html |

## J：日本の研究

### J（前半）：Minecraft・ゲーム・仮想空間を使った研究と事例

| ID | 研究（著者・年） | 掲載先・種別 | 環境 | 題材 | URL |
| --- | --- | --- | --- | --- | --- |
| J1 | Minecraftを用いたまちづくりワークショップの開発（西・饗庭, 2022） | 日本建築学会技術報告集 28(68) | Minecraft | 市民参加型まちづくりでの空間理解と議論（同名の2020年版が都市計画報告集19(2)にある） | https://www.jstage.jst.go.jp/article/aijt/28/68/28_430/_article/-char/ja |
| J2 | Minecraftを用いたまちづくりワークショップにおける合意形成プロセスの把握と有効性の一考察（三國・矢口, 2026） | 日本建築学会技術報告集 32(80) | Minecraft | まちづくりの合意形成（大学キャンパスの再設計） | https://www.jstage.jst.go.jp/article/aijt/32/80/32_452/_article/-char/ja |
| J3 | Minecraftを活用した小学校低学年向け防災学習ゲームの提案（三國・矢口, 2024） | 日本建築学会技術報告集 30(76) | Minecraft | 低学年の防災教育（理想の避難所づくり） | https://www.jstage.jst.go.jp/article/aijt/30/76/30_1640/_article/-char/ja |
| J4 | 三次元都市データとマインクラフトを活用した防災教育コンテンツの開発と実践（小野ほか, 2024） | 土木学会論文集 80(27) | Minecraft＋3D都市データ | 地域の浸水リスクの理解 | https://www.jstage.jst.go.jp/article/jscejj/80/27/80_24-27034/_article/-char/ja |
| J5 | マインクラフトと氾濫解析を統合した体験型防災教育ツール開発とその教育効果の学年比較（小野ほか, 2026） | 土木学会論文集 82(16) | Minecraft＋氾濫解析 | 小中学生の水害への防災意識、治水事業の意義 | https://www.jstage.jst.go.jp/article/jscejj/82/16/82_25-16133/_article/-char/ja |
| J6 | ゲーム空間における疑似避難体験を提供する新たな津波防災教育ツールの開発（三戸部ほか, 2025） | 土木学会論文集 81(18) | 独自ゲーム | 津波避難教育 | https://www.jstage.jst.go.jp/article/jscejj/81/18/81_25-18070/_article/-char/ja |
| J7 | ゲームを通じてシビックプライドを高める学びのデザイン（村井ほか, 2023） | 日本デザイン学会研究発表大会概要集 70 | Minecraft | 若者の地域への愛着と史跡の継承（高天神城跡、掛川市） | https://www.jstage.jst.go.jp/article/jssd/70/0/70_194/_article/-char/ja |
| J8 | 人々の意識・行動の選択に影響を与えるデジタルゲームの要素（上村ほか, 2023） | 実践政策学 9(2) | Minecraft ほか | 高レベル放射性廃棄物の処分に関する若者との対話 | https://www.jstage.jst.go.jp/article/ppseb/9/2/9_177/_article/-char/ja |
| J9 | デジタルゲームを活用した高レベル放射性廃棄物処分の対話の効果（上村・石岡, 2025） | 実践政策学 11(1) | デジタルゲーム（ゲーム名は未確認） | 高レベル放射性廃棄物への高校生・大学生の関心と理解 | https://www.jstage.jst.go.jp/article/ppseb/11/1/11_135/_article/-char/ja |
| J10 | アルツハイマー型認知症を早期発見するためのMinecraftのMODの提案（伊藤ほか, 2021） | 芸術科学会論文誌 20(5) | Minecraft の MOD | 認知症の早期発見（高齢化・医療） | https://www.jstage.jst.go.jp/article/artsci/20/5/20_254/_article/-char/ja |
| J11 | オンラインゲームによる文化財再生と引きこもりの子どもの学習保障・就労支援（田口, 2017–2020） | 科研費 挑戦的研究（萌芽） | Minecraft | ひきこもりの子どもの学習・就労支援と地域再生 | https://kaken.nii.ac.jp/ja/grant/KAKENHI-PROJECT-17K18613/ |
| J12 | オンラインゲームと社会を結ぶPBLを通したメンタライジングの発見と支援（田口, 2020–2023） | 科研費 基盤研究(B) | Minecraft | ゲーム好きの若者の孤立・不登校の防止 | https://kaken.nii.ac.jp/ja/grant/KAKENHI-PROJECT-20H04468/ |
| J13 | 「PLATEAU × マインクラフト」で新しい新宿を作る（国土交通省 Project PLATEAU, 2023） | 公式記事（実践事例） | Minecraft＋3D都市モデル | 再開発を題材にした子どものまちづくり参加 | https://www.mlit.go.jp/plateau/journal/j038/ |
| J14 | SAITAMA Minecraft AWARD 2025（さいたま市, 2025） | 自治体の事業（実践事例） | Minecraft＋PLATEAU | 2050年の街の住宅・交通・防災・環境を考える子どもの参加 | https://www.city.saitama.lg.jp/001/010/014/007/p120455.html |
| J15 | スマートシティ推進のための意識・行動変容を目指したゲーミフィケーション教材の開発と有効性の検証（鈴木ほか, 2026） | Beyond SDGsイノベーション研究 7(13) | 独自のゲーム教材 | 人口減少を背景としたスマートシティへの市民参加 | https://www.jstage.jst.go.jp/article/bsir/7/13/7_1/_article/-char/ja |
| J16 | みんなのまちづくりゲーム in cities（池島ほか, 年は未確認） | 内閣府の事例資料 | ボードゲーム | 地域経済・環境・福祉・防災が絡む地域課題 | https://www8.cao.go.jp/cstp/sogochi/jirei/jirei2kai/shiryo2_ynu.pdf |
| J17 | 市民教育を用いた社会的リスクの軽減―少子化現象について学ぶカードゲームの設計と実施（李, 2018） | 計測と制御 57(6) | カードゲーム | 少子化についての市民教育 | https://www.jstage.jst.go.jp/article/sicejl/57/6/57_444/_article/-char/ja |

### J（後半）：日本のエージェントベース社会シミュレーション

| ID | 研究（著者・年） | 掲載先・種別 | 環境 | 題材 | URL |
| --- | --- | --- | --- | --- | --- |
| J18 | マルチ・エージェント・シミュレーションによる津波避難ビルへの避難行動分析（深田・橋本, 2021） | 地理学論集 96(2) | MAS | 津波避難ビルへの避難（釧路市） | https://www.jstage.jst.go.jp/article/hgs/96/2/96_7/_article/-char/ja |
| J19 | 異なる避難開始時間を考慮したArtisocによる津波避難シミュレーション（兼村・中村, 2023） | 土木学会論文集 79(18) | artisoc | 避難の遅れと犠牲者数（気仙沼市） | https://www.jstage.jst.go.jp/article/jscejj/79/18/79_23-18046/_article/-char/ja |
| J20 | マルチエージェントシミュレーションを用いた辰巳工業団地における津波避難計画立案の支援（苅田ほか, 2025） | 土木学会論文集 81(24) | MAS | 工業団地の津波避難計画（阿南市） | https://www.jstage.jst.go.jp/article/jscejj/81/24/81_25-24159/_article/-char/ja |
| J21 | 都市課題の改善に向けたマルチエージェント・シミュレーションの活用（北上ほか, 2013） | 電気学会論文誌C 133(9) | MAS | 津波避難と交通需要マネジメント、住民との合意形成（鎌倉市） | https://www.jstage.jst.go.jp/article/ieejeiss/133/9/133_1640/_article/-char/ja |
| J22 | なぜ震災後デマが拡散したのか―ネットワーク構造の影響分析―（臼井ほか, 2013） | 電気学会論文誌C 133(9) | ABM | 震災後のデマの拡散 | https://www.jstage.jst.go.jp/article/ieejeiss/133/9/133_1796/_article/-char/ja |
| J23 | 感染症病床リソースと外出自粛を導入したマルチエージェント環境によるウィルス感染症の伝播予測手法（大前ほか, 2020） | 知能と情報 32(6) | MAS | COVID-19、病床の制約と外出自粛 | https://www.jstage.jst.go.jp/article/jsoft/32/6/32_998/_article/-char/ja |
| J24 | 感染症実用シミュレーションにおける仮想都市構築法の違いによる結果への影響分析（市川・出口, 2013） | 計測自動制御学会論文集 49(11) | SOARS | 感染症対策と仮想都市（家庭・職場・学校） | https://www.jstage.jst.go.jp/article/sicetr/49/11/49_1012/_article/-char/ja |
| J25 | 社会シミュレーションを用いた保健医療サービスの評価（金谷ほか, 2013） | 計測と制御 52(7) | 社会シミュレーション | 救急医療・医療計画 | https://www.jstage.jst.go.jp/article/sicejl/52/7/52_622/_article/-char/ja |
| J26 | デイサービス施設における排泄介助マルチエージェントシミュレーション（高木ほか, 2025） | 人工知能学会論文誌 40(4) | MAS | 介護人材の不足と業務の効率化 | https://www.jstage.jst.go.jp/article/tjsai/40/4/40_40-4_A-O73/_article/-char/ja |
| J27 | エージェントベースドモデルによる日本の人口・世帯数の将来推計（金田・上村, 2020） | 生活経済学研究 51 | ABM | 人口減少・高齢化と単身世帯の増加 | https://www.jstage.jst.go.jp/article/seikatsukeizaigaku/51/0/51_77/_article/-char/ja |
| J28 | 公的年金制度における47都道府県の所得代替率に関する考察（杜・村田, 2016） | システム制御情報学会論文誌 29(9) | ABM | 少子高齢化の中での年金の地域差 | https://www.jstage.jst.go.jp/article/iscie/29/9/29_422/_article/-char/ja |
| J29 | 待機児童問題解消に向けた保育需給のマルチエージェントモデルによる分析（財津ほか, 2020） | 構造計画研究所 MASコンペティション | artisoc | 待機児童問題と保育所の配置 | https://mas.kke.co.jp/wp-content/uploads/2020/01/04_%E8%B2%A1%E6%B4%A5@%E6%9D%B1%E4%BA%AC%E5%B7%A5%E6%A5%AD%E5%A4%A7%E5%AD%A6.pdf |
| J30 | 都市衰退過程での空き家の発生と集積および空地の商業への影響に着目したマルチエージェントシステムによる都市シミュレーション（安藤ほか, 2005） | 都市計画論文集 40.1 | MAS | 都市の衰退と空き家 | https://www.jstage.jst.go.jp/article/journalcpij/40.1/0/40.1_51/_article/-char/ja |
| J31 | AI便乗サービスの定時定路線との乗り継ぎ導入による効果分析（鎌田ほか, 2026） | 人工知能学会全国大会論文集 | MAS | 地域公共交通（オンデマンド交通と路線バス） | https://www.jstage.jst.go.jp/article/pjsai/JSAI2026/0/JSAI2026_4N5GS10g04/_article/-char/ja |
| J32 | 人工社会モデルによる都市部の各種交通政策導入効果の検討（井ノ口ほか, 2023） | 知能と情報 35(1) | 人工社会モデル | MaaS・シェアサイクル・オンデマンドバス（大阪南東部） | https://www.jstage.jst.go.jp/article/jsoft/35/1/35_517/_article/-char/ja |
| J33 | MASを用いた観光地の混雑の再現と解決策の検討：神奈川県藤沢市江の島を事例に（武田ほか, 2025） | 日本地理学会発表要旨集 | MAS | 観光地の混雑（オーバーツーリズム） | https://www.jstage.jst.go.jp/article/ajg/2025s/0/2025s_215/_article/-char/ja |
| J34 | ゲーミングとマルチエージェントシミュレーションによる地域通貨流通メカニズムの検討（小林ほか, 2015） | シミュレーション＆ゲーミング 23(2) | 人が参加するゲーミング＋MAS | 地域通貨の滞留と地域経済の活性化 | https://www.jstage.jst.go.jp/article/jasag/23/2/23_1/_article/-char/ja |
| J35 | マルチエージェントシステムを適用した集落農地貸借モデルの開発（山下・星野, 2003） | 農村計画学会誌 22(suppl) | MAS | 農村集落の農地の貸し借りと担い手 | https://www.jstage.jst.go.jp/article/arp1982/22/22-suppl/22_22-suppl_85/_article/-char/ja |
| J36 | エージェントベースモデルによるポストコロナのオフィス出社行動の分析（玉真ほか, 2026） | 人工知能学会論文誌 41(3) | ABM | ハイブリッド勤務での出社行動と組織の成果・幸福度 | https://www.jstage.jst.go.jp/article/tjsai/41/3/41_41-3_B-P74/_article/-char/ja |

## 調査の限界

- CiNii Research、KAKEN の検索画面、情報処理学会電子図書館、Semantic Scholar、OpenAlex は、この調査の環境から検索できませんでした。**情報処理学会（全国大会・研究報告）の文献はほぼ調べられていません。**
- 一部の出版社ページは開けなかったため、DOI登録情報（Crossref）や要旨ページで書誌を確認しています。
- 各研究の「題材」は要旨などをもとにした要約です。論文を引用するときは本文で確認してください。
