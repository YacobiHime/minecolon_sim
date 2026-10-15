# CLAUDE.md（卒研: 建物の配置の研究）

@AGENTS.md

<!-- リポジトリ全体の指示は AGENTS.md にある（上の行で読み込む）。ここには建物の配置の研究に関わる指示だけを書く。リポジトリにすでに CLAUDE.md がある場合は、この内容を末尾に追記してください。 -->

このリポジトリでは、MineColonies を使ったゲーム社会シミュレーションのうち、**建物の配置を AI に任せる研究**も進めています。研究の文書は `docs/` にあり、**リポジトリの文書が正本**です。

## 最初に読む文書

作業の前に、自分のセッションの役割に合わせて次を読む。

- すべてのセッション: `docs/README.md`（文書の一覧と、どのセッションが書いてよいか）、`docs/research/research-direction-notes.md`（方針メモ）
- 実装セッション: `docs/research/implementation-session.md`、`docs/research/experiment-plan.md`、`docs/research/minecolonies-spec-notes.md`、`docs/research/minecolonies-esa-article.md` の11章
- 仕様把握セッション: `docs/sessions/minecolonies-spec-session.md`、`docs/research/minecolonies-spec-notes.md`
- 論文読み込みセッション: `docs/sessions/paper-reading-session.md`

`docs/reference/` は大きい文書を含むので、必要なときだけ読む。

## セッションの分担

| セッション | 担当 |
| --- | --- |
| 方針セッション | 研究の方向・評価の考え方・ルールを決める |
| 仕様把握セッション | MineColonies で何ができるかを根拠つきで確認する |
| 論文読み込みセッション | 論文を読み、ノートを作る |
| 実装セッション | 方針と仕様に基づいてコードを書き、実験を進める |

最初の発言でどのセッションとして動くかを指定されなければ、ユーザーに確認する。

## 文書の更新ルール

- **文書ごとに書いてよいセッションが決まっている**（`docs/README.md` の表）。担当外の文書は読むだけにし、変更が必要なら担当のセッションへの申し送りとして、自分の担当の文書か作業記録に書く。
- **書く前に `git pull` する**。ほかのセッションの更新を取り込んでから編集する。
- `docs/` の中の文書の更新は、main に直接コミットしてよい。コミットのメッセージの先頭にセッション名を付ける（例: `[方針] 仮設の小屋の扱いを追記`）。
- 文書の内容を変えるときは、ユーザーとの対話で決まったことだけを書く。推測で決定事項を増やさない。

## コードの変更ルール

- コードの変更は、小さくても PR を通す。main に直接 push しない。PR の書き方とレビューの仕組みは `docs/research/implementation-session.md` の「レビューの仕組み」に従う。
- 配置以外の部分（LLM 市長 `council.js`、社会モデル `social_*.js` など）は、同期の担当範囲と重なる可能性があるので、触る前にユーザーに確認する。

## ビルド・起動・テスト

- VoyagerBridge のビルド・配備・サーバー再起動・ヘルスチェックは、既存の手順書 `.claude/skills/deploy-bridge/SKILL.md` に従う。
- コロニーの状態確認と、市民・建設が止まったときの診断は `.claude/skills/colony-diag/SKILL.md` に従う。
- 実験用ワールド（本番とは別）の扱いは `docs/research/experiment-plan.md` の「共通のルール」に従う。手順が固まったら、ここに追記する。

## 研究室の既存ルールとの関係

- AGENTS.md のルール（コミットするブランチ、週次進捗報告 `progress_report_<月曜日の日付>.md` の更新など）にも従う。配置の研究で進んだことも、週次進捗報告に追記する。
- AGENTS.md のルールと、この文書や `docs/` のルールが食い違う場合は、作業を止めてユーザーに確認する。
