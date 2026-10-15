---
name: mayor-system
description: LLM市長(council.js)の設計・調整・運用ガイド。市長の建設判断がおかしい/プロンプトを変えたい/統治者やペルソナを追加したい時に読む。
---

# LLM市長システム(council.js)ランブック

`minecolonies-bridge/council.js` が本体。ローカル ollama
(192.168.15.150:11434 / gemma4:e4b)で複数の「統治者(governor)」ペルソナが合議して
コロニーの建設判断を下し、同時に各市民が短い在職セリフを喋る。全発言はサーバー
コンソール `say` 経由でゲーム内チャットに出る。**council.js は Minecraft に bot として
繋がない** — bridge HTTP API(port 8089)経由で世界に介入する。

## 中核設計: メニュー選択方式(小型モデル対策)

gemma級のモデルは**自由記述のaction JSONを作れない**(action名・座標・block IDを捏造する)。
そこで:
1. `buildCandidates(status)` が **/status から「いま合法な行動」だけを番号付きメニュー**に生成
   (各候補は既に正しいパラメータを内包)
2. モデルは `{"say":"…","choice":<番号>}` で**番号を選ぶだけ**(schema強制 GOVERNOR_REPLY_SCHEMA)
3. 範囲外choiceは index 0 = wait に縮退

この設計のおかげで市長は構造的に不正な行動を取れない。判断の質はe4bで「おおむね妥当」。

## メニュー側のガバナー(暴走対策、いずれも buildCandidates 内)

過去に市長が同じ建物を暴走設置した実績があり(2026-07-06: alchemist 38棟/work order 130件)、
「構造的に合法 ≠ 戦略的に正気」を教訓に多層防御を入れてある:

| ガバナー | 内容 | 理由 |
|---|---|---|
| **spawn-gate** | 住居に空きがある時だけ spawnCitizen を提示 | 毎ターン選んで人口暴走するため |
| **backlog** | 未着工のlv0ハットがあれば追加配置を止めて着工を優先。建設中 ≥ 稼働builder×3 でも新規建設を止める | pendingになる前の空ハットを大量配置した事故と、builderが捌ける以上の発注を防ぐため |
| **builder距離** | 稼働builderがいる時は全hutから100ブロック圏外の着工候補をメニューから除外 | Bridgeの正当な距離拒否へLLMが固執するのを防ぐため |
| **配置後の自動着工** | LLMが`placeNext`で建物種を選んだら、返却座標へ同じ処理内で`requestBuild`する | 置いた後の別ターンでLLMが`wait`を選び、空ハットが残るのを防ぐため |
| **dedup** | placeNext は「コロニーに無いタイプ」のみ提示 | 同型を無限に建てるため(38 alchemist) |
| **maxLevel** | `b.maxLevel`(getMaxBuildingLevel)超のupgradeを除外 | tavern lv3・postbox lv1 等の無意味upgrade |
| **shuffle** | wait以外の候補順をランダム化 | e4bの低番号位置バイアス(先頭のalchemistを常に選んだ) |

**市長の判断がおかしい時はまずここを見る**。新しい暴走パターンが出たら、プロンプトに
一般則を足すより**メニューから該当候補を消す**方が確実(小型モデルには「選択肢に事実を
添付/不正な選択肢を消す」が効く。実証済み)。

## プロンプトの外部化(2026-07-07〜)

市長の「憲法」テキストは JS から `prompts/*.md` に外部化済み。**JSロジックを触らずに
プロンプトだけ改訂できる**:
- `prompts/governor_system.md` — 統治者system prompt。`{{NAME}}` `{{ROLE}}`
  `{{PERSONALITY}}` `{{OTHERS}}` を governor ごとに置換
- `prompts/citizen_voice.md` — 市民セリフ prompt。`{{JOB_DESCRIPTIONS}}` を建物レジストリから充填

置換は council.js の `buildGovernorSystemPrompt()` / `CITIZEN_VOICE_PROMPT` が起動時に実施。
**プロンプトを変えたら council を再起動**すれば反映(下記)。placeholder名を増やす時は
council.js 側の `.replace()` も足すこと。

## 統治者ペルソナ

`GOVERNORS` 配列(council.js内、現在 Aldric=都市計画/Mira=民政 の2名)。name/role/personality
を持つ。人数を増やせば合議が賑やかになるが、1サイクルの ollama 呼び出しが増える。
※市民一人一人の詳細ペルソナ化は別構想で保留中([[minecolonies-next-phase-plan]])。

## ollama バックエンドの必須設定(council.js askLLM)

- **ネイティブ `/api/chat` + `think:false` 必須** — OpenAI互換 `/v1` や think:true だと
  gemma4 が reasoning に全トークンを使い content が空になる
- **format にJSONスキーマを渡して構造強制**(市民セリフは自由文なので format 無し)
- env で上書き可: `LLM_HOST` `LLM_PORT` `LLM_MODEL`

## 運用(起動・監視・再起動)

`council.js` のゲーム内発言は `CMD_PIPE` 環境変数で指定した FIFO へ書く。未指定時は
現行 panama 配置(2026-10-15〜)の `/root/mc-server-forge/cmd_pipe` を使う。Forge 側も
同じ FIFO を標準入力として読む必要があるため、現行配置では直接 `run.sh` を起動せず
`/root/mc-server-forge/start_server.sh` を使う。

```bash
# 再起動(必ずサブシェル内cd。裸起動は即死)
pkill -f 'node council\.js$'; sleep 2
(cd /root/minecolon_sim/minecolonies-bridge && \
  setsid -f env CMD_PIPE=/root/mc-server-forge/cmd_pipe \
  node council.js >> council5.log 2>&1 </dev/null)
# 稼働確認(ちょうど1プロセス)
pgrep -fc 'node council\.js$'
# 挙動確認(統治者の choice と say が出る)
tail -f /root/minecolon_sim/minecolonies-bridge/council5.log
```

- **常駐化済み**(MAX_CYCLES=Infinity)。colony_watch が異常死時のみ自動再起動
- 前提: bridge稼働 + supply_bot 1プロセス + tickrate auto
- ペア関係: 市長=建設・人口の意思決定 / supply_bot=資材・福祉の自動供給 /
  colony_watch=死活監視。市長は資材を直接配らない(supply_botの仕事)

## 関連メモリ

[[minecolonies-council-operation]](ollama移行の経緯)、
[[minecolonies-finetuned-model-idea]](知識のfine-tune化構想)、
[[minecolonies-next-phase-plan]](市民ペルソナ+市民会議の次フェーズ)
