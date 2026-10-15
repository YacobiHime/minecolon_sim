# 卒研の文書（建物の配置の研究）

卒業研究「Minecraft（MineColonies MOD）を用いたゲーム社会シミュレーション」のうち、建物の配置を AI に任せる研究の文書です。2026-10-15 に claude.ai のプロジェクト「minecraft卒研作業」から移しました。**これ以降は、このリポジトリの文書が正本です。**

## フォルダ構成

| フォルダ | 中身 | いつ読むか |
| --- | --- | --- |
| `docs/research/` | 研究の方針、実装・実験の計画と記録、MineColonies の確定した仕様、研究室の進捗 | **毎回、作業の前に読む** |
| `docs/sessions/` | 論文読み込みセッション・仕様把握セッションの設定 | そのセッションを始めるとき |
| `docs/reference/` | MineColonies の機能まとめ、先行研究の題材と文献リスト、GDMC の読み方ガイド、論文ノート | 必要なときだけ読む（大きい文書があるので、毎回は読まない） |

## 文書の一覧と、書いてよいセッション

文書ごとに「書くセッション」を決めています。ほかのセッションは読むだけにして、同じファイルを同時に書き換えて衝突するのを防ぎます。

| 文書 | 内容 | 書くセッション |
| --- | --- | --- |
| `research/research-direction-notes.md` | 方針メモ（決めたルール・判断・検討中の案） | 方針セッション |
| `research/implementation-session.md` | 実装セッションの設定（役割・範囲・レビューの仕組み・サブエージェント） | 方針セッション（実装セッションは提案だけ） |
| `research/experiment-plan.md` | 前提を確かめる実験 A〜D の計画 | 方針セッション |
| `research/experiment-log.md` | 実験の記録（最初の実験のときに作る） | 実装セッション |
| `research/implementation-log.md` | 実装の作業記録・サブエージェントの使用記録（最初の作業のときに作る） | 実装セッション |
| `research/minecolonies-spec-notes.md` | MineColonies の確定した仕様 | 仕様把握セッション |
| `research/minecolonies-esa-article.md` | 研究室のシステムの進捗（esa の記事のまとめ）と、今の配置処理の説明（11章） | 仕様把握セッション |
| `sessions/paper-reading-session.md` | 論文読み込みセッションの設定と進み具合 | 論文読み込みセッション |
| `sessions/minecolonies-spec-session.md` | 仕様把握セッションの設定 | 仕様把握セッション |
| `reference/paper-notes/*.md` | 論文ごとの読書ノート | 論文読み込みセッション |
| `reference/gdmc-reading-guide.md`、`reference/prior-research-topics.md`、`reference/minecolonies-wiki-draft.md` | 読み方ガイド、先行研究の題材と文献リスト、MineColonies の機能まとめ | 論文読み込みセッション／仕様把握セッション |

## 移行についての注意

- 文書の中の「プロジェクトに保存する」「`project_write`」などの書き方は、移行前の運用のなごりです。今は「このリポジトリの該当ファイルを編集してコミットする」と読み替えてください。
- 文書の中のファイルの場所は、移行時にこのリポジトリの場所（`docs/...`）に書き換えてあります。
- claude.ai のプロジェクトに残っている文書は、移行時点の控えです。更新しません。
