# エージェント向け指示 (MineColonies bridge 実験)

このリポジトリ(単独リポジトリ、`main` ブランチ、リモートは `origin` のみ)は、LLM エージェントが
MineColonies コロニーを運営する実験を含む。かつては Voyager のフォーク上で開発していた。実験の実体は
`minecolonies-bridge/`(Forge mod + Node.js エージェント群)。

## 手順書 (skills)

定型作業の手順書が `.claude/skills/` にある。**該当する作業を始める前に必ず読むこと**:

- `.claude/skills/deploy-bridge/SKILL.md` — VoyagerBridge mod のビルド→配備→
  サーバー再起動→ヘルスチェック。ビルドや配備をするときはこの手順に従う。
- `.claude/skills/colony-diag/SKILL.md` — コロニー状態確認と、市民・建設が
  止まったときの診断ランブック。

手順書はただの Markdown なので、Claude Code 以外のツール(Codex、Gemini CLI 等)も
ファイルとして読んで従えばよい。

## 基本事実(実験マシン上)

- 実験マシン: panama(LAN 192.168.15.102、Tailscale 100.88.86.71、user root)。
  2026-10-15 に mine-server から移設した。
- Minecraft サーバー: `/root/mc-server-forge`(Forge 1.20.1、ゲーム port 25565)
- 本リポジトリ: `/root/minecolon_sim`、ワールドのバックアップ: `/root/simulation-backups`
- bridge HTTP API: `http://localhost:8089`(エンドポイント実装は
  `minecolonies-bridge/src/main/java/com/voyagerbridge/VoyagerBridge.java`)
- サーバーコンソール入力: `echo '<cmd>' > /root/mc-server-forge/cmd_pipe`、
  出力は `/root/mc-server-forge/console.log`
- ビルドには JDK17 (`/opt/jdk-17.0.19+10`) が必要

## ルール

- 検証が取れた変更は `main` ブランチにコミットし、`origin` に push する。
- 手順そのものを変えたら、同じコミットで該当 SKILL.md も更新する。

## 週次進捗報告

- 毎週月曜日の報告に向け、ルートの `progress_report_<月曜日の日付>.md` を更新する。
  月曜当日に一括作成せず、検証済みマイルストーン・設計変更・ライブ状態の変化ごとに
  次回月曜分へ追記する。
- 報告には少なくとも「目的」「実施内容」「検証結果」「現在のライブ状態」
  「未解決事項」「次の一週間」「主要コミット」を含める。
- セッション終了前、コンテキスト残量が少ない場合、または利用上限が近いと判断できる場合は、
  新規実装より先に週次進捗報告と引き継ぎ情報を最新化する。
  ツールから利用上限を直接取得できない場合でも、長い作業の節目ごとに更新して欠落を防ぐ。
