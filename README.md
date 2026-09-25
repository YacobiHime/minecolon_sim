# minecolon_sim — MineColonies LLM社会シミュレーション

Minecraft (Forge 1.20.1) + [MineColonies](https://minecolonies.com/) を使い、
**LLMが「市長」としてコロニーを自律運営する**社会シミュレーションです。
プレイヤーの代わりにLLM市長が建物の配置・職業割当・生産計画を判断し、市民NPCがそれに従って生活します。
長時間の観察から、AI統治のダイナミクスや失敗パターンを分析することを目的としています。

## アーキテクチャ

```
┌─ Minecraftサーバー (Forge 1.20.1 + MineColonies) ─────────────┐
│  voyagerbridge mod (src/main/java/com/voyagerbridge)          │
│    └ HTTP API :8089  /status /place /found /requestBuild ...  │
└──────────────┬────────────────────────────────────────────────┘
               │ HTTP (同一ホスト)
┌──────────────┴───────────────── Node.js エージェント群 ────────┐
│  council.js      LLM市長 — 統治者ペルソナの合議で建設を判断     │
│  supply_bot.js   建設資材の自動供給                            │
│  persona_daemon.js / social_*.js  市民の関係・認知・発言モデル │
│  experiment_runner.js  食料配分などの再現可能な社会実験runner  │
└────────────────────────────────────────────────────────────────┘
```

- 市長のLLMはローカルOllama (例: `gemma4:e4b`) で動作し、自由記述ではなく
  **番号付きメニューから合法な行動を選ぶ**方式で小型モデルの捏造を防いでいます。
- 市民の発言はサーバーコンソール `say` 経由でゲーム内チャットに表示されます。
- `council.js` はMinecraftにbotとして接続せず、すべてbridge HTTP API経由で世界に介入します。

## セットアップと実行

手順全体は **[Sim_SetUp.md](Sim_SetUp.md)** を参照してください。概要:

1. Forge 1.20.1サーバー + MineColoniesと前提MODを導入
   (`minecolonies-bridge` を `./gradlew build` でビルドし、jarをサーバーの `mods/` へ)
2. サーバーを起動し、bridge API (`127.0.0.1:8089`) の応答を確認
3. `node supply_bot.js` を起動 → Town Hall / Builder's Hut level 1 を完成させる
4. `node council.js` を起動 → LLM市長の合議が始まり、建物が自律的に増えていく

再現可能な社会実験(食料配分scenario)は:

```bash
cd minecolonies-bridge
node experiment_runner.js --help
```

ユニットテストは `node verify_suite.js` で一括実行できます。

## リポジトリ構成

| パス | 内容 |
|---|---|
| `minecolonies-bridge/` | Forge bridge mod + Node.jsエージェント群(本体) |
| `wiki/` | 研究紹介wiki (MkDocs, GitHub Pagesで公開) |
| `Sim_SetUp.md` | セットアップ〜起動の手順書 |
| `MINECOLONIES_MECHANICS.md` | MineColoniesの機構メモ |
| `COGNITIVE_MODEL.md` / `DESIGN_DECISIONS_*.md` | 市民の認知モデルと設計判断 |
| `FOOD_ALLOCATION_SCENARIO.md` / `SOCIAL_EXPERIMENTS.md` | 社会実験の設計 |
| `progress_report_*.md` / `HANDOFF_*.md` | 進捗報告とセッション引き継ぎ記録 |
| `.claude/` | 運用ランブック (Claude Codeスキル: mayor-system, deploy-bridge, colony-diag) |

## 関連

- かつて[MineDojo/Voyager](https://github.com/MineDojo/Voyager)のforkで開発していましたが、
  現構成はVoyager本体コードに依存しないため、本リポジトリに独立させました。
