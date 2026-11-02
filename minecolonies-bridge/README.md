# Voyager Bridge (MineColonies experiment)

Forge mod that runs inside the MineColonies server process and exposes an
HTTP API so an LLM agent can drive colony placement directly, bypassing the
client GUI entirely.

## Why this exists

MineColonies registers mandatory FML network channels, so a plain
vanilla-protocol bot (mineflayer) cannot even log into a server running it -
the connection is rejected with "This server has mods that require Forge to
be installed on the client." A Forge-aware client is required just to join.

Separately, building placement (where a hut goes) and colony founding are
GUI-driven flows (Build Tool + Structurize), not chat commands.

This mod sidesteps both problems by running *inside* the same JVM as the
server and calling MineColonies'/Structurize's own Java methods directly -
no network protocol involved. It turns out MineColonies' own classes
(`IColonyManager`, `ICitizenManager`, etc.) are **not** obfuscated (Forge
only obfuscates vanilla Minecraft classes), so they can be referenced by
their normal method names at compile time via `fg.deobf(files(...))`
pointing at the already-installed mod jars.

## Endpoints (port 8089)

- `POST /place?x=&y=&z=&block=minecolonies:blockhuttownhall` - places a hut
  block directly (`Level.setBlockAndUpdate` + `Block.setPlacedBy`, the same
  hooks a normal player placement would trigger).
- `POST /found?x=&y=&z=&name=` - founds a colony on a previously-placed,
  not-yet-colonized town hall (mirrors `CreateColonyMessage`, sent when a
  player confirms the in-game "found colony" prompt).
- `POST /spawnCitizen?colonyId=` - force-spawns a new citizen in the colony
  (mirrors the `/mc citizens spawnNew <id>` console command).
- `GET /ping` - health check.

## 実験時間の記録(experiment_clock.js)

倍率は適応ガバナーで自動的に変わるので、実験の長さを実時間だけで記録すると、
あとで一定倍率の場合に換算できない。`experiment_clock.js` は `GET /tickrate` を
一定間隔で読み(書き込みはしない)、ゲーム内の時刻とその時点の倍率を JSONL に1行ずつ追記する。

- 1行の中身: `wallTime`(ISO8601)、`wallMs`(エポックミリ秒)、`gameTime`(オーバーワールドの
  通算 tick)、`dayTime`(ゲーム内の日時 tick)、`multiplier`、`auto`、`msptMs`。
  bridge に繋がらないときは `error` 付きの行を書いて続ける。
- `gameTime`・`dayTime` は bridge 側の `GET /tickrate` に追加した項目。古い bridge では `null` になる。

記録(`--interval` の既定は5秒。`--duration` を省くと Ctrl-C / SIGTERM まで続ける):

```bash
node experiment_clock.js --out=experiment_logs/A-1_clock.jsonl --interval=5
# 接続先は環境変数 BRIDGE_HOST / BRIDGE_PORT(既定 localhost / 8089)
```

集計(`--fixed` の既定は10):

```bash
node experiment_clock.js --summarize=experiment_logs/A-1_clock.jsonl --fixed=10
```

経過実時間、経過 tick、倍率の最小・最大・時間加重平均、実効倍率を JSON で出す。
一定倍率 M のときの換算時間は **経過 tick から** `経過tick / (20 × M)` 秒として計算する
(`equivalentWallSecAtFixed`)。テストは `node test_experiment_clock.js`。

## ペルソナ A/B 会話実験(persona_chat_experiment.js)

ゲームを使わず、固定の村人8人に LLM で村のチャットをさせ、ペルソナの渡し方で会話が変わるかを比べる。

- **A(薄いペルソナ)**: `chat_capacity_bench.js` と同じ。名前・職業・性格1行。
- **B(厚いペルソナ, stage 1)**: A に加えて、プロフィール(年齢・世代・家族・生い立ち・
  `speechStyle` の話し方・`temperament` を言葉にした性格)、いま気になっていること
  (`social_cognition.js` の欲求優先度+空腹・病気・イベント)、今の気分(6感情を規則で計算)、
  直近8行に出てくる相手への気持ち(`social_dynamics.js` の trust/affinity/gratitude/resentment/援助の記憶)
  を日本語の文にして system prompt に入れる。LLM の追加呼び出しはしない。
- 固定キャスト `persona_chat_fixtures.json` は `personas.js`・`social_dynamics.js` の実関数で決定論的に作る
  (`--write-fixtures` で再生成)。感謝の関係2組(カイト→ミナ、ユイ→ハルト)、援助を断られた恨み1組(アオイ→レン)。
- 台本イベント: 発話0番目「食料が足りなくなってきた」(3人が空腹に)、1/3「新しい家が完成した」、
  2/3「夜、ゾンビが村に近づいている」。最初に固定の4行(SEED_LINES)を置く。
- 話す順は各ラウンドで8人を seed でシャッフル(同じ人が連続しない)。llama.cpp の `seed` は
  (実行 seed, 発話番号)から決めるので、同じ seed の A と B は対になる。

```bash
# プロンプトだけ確認(LLM を呼ばない)
node persona_chat_experiment.js --dry-prompts            # 既定はカイトとアオイ
# 本実験(llama-server, キーは環境変数 LLM_API_KEY だけから読む)
node persona_chat_experiment.js --conditions=A,B --seeds=1,2,3,4,5 --turns=360 \
  --llm-hosts=127.0.0.1:18080 --parallel=2 --out-dir=persona_chat_results/run1
# 指標(LLM なし)→ metrics.json / metrics.md
node persona_chat_metrics.js persona_chat_results/run1
# 評価者 LLM(未実行。モデル未定)→ judge.json
node persona_chat_judge.js persona_chat_results/run1 --judge-model=<model> --judge-hosts=127.0.0.1:18080
```

出力: 実行ごとの `transcript_<条件>_seed<k>.jsonl`(発話番号・話者・seed・プロンプトのトークン数・遅延・
整形後/生のテキスト・イベント印・名前を出した相手、B は気分・関心・関係文)、
`system_prompts_<条件>_seed<k>.json`(各人の最初の発話の system prompt そのもの)、`config.json`。
指標の定義は `persona_chat_metrics.js` の先頭コメント。テストは `node test_persona_chat_experiment.js`。

## Known gotchas hit while building this

- Gradle 8.1.1 (bundled in the Forge MDK) cannot run on JDK 21
  ("Unsupported class file major version 65"). Build with JDK 17
  (`JAVA_HOME` pointed at a Temurin 17 install) and let Gradle's toolchain
  resolve the rest.
- `ICitizenManager.spawnOrCreateCitizen()` (no-arg) has a bug in this
  MineColonies build: it ends up calling `List.of(null)` internally and
  throws an NPE. Call `spawnOrCreateCivilian(null, world, new ArrayList<>(), true)`
  directly instead (passing an *empty*, not null, list) - this is what the
  official `/mc citizens spawnNew` console command does under the hood.
- `TileEntityColonyBuilding.setStructurePack` requires Domum Ornamentum on
  the compile classpath too (`IMateriallyTexturedBlockEntity`), even though
  we never call into Domum Ornamentum directly.

## Building

Requires JDK 17 and the MineColonies/Structurize/Domum Ornamentum jars to
already exist at the paths referenced in `build.gradle`'s `compileOnly
fg.deobf(files(...))` lines (adjust those paths if your server's mods folder
is elsewhere).

```bash
export JAVA_HOME=/path/to/jdk-17
./gradlew build -x test
# output: build/libs/voyagerbridge-0.1.0.jar -> copy into the server's mods/ folder
```

## Third-party mods and licensing

This mod is built and run **against** [MineColonies](https://github.com/ldtteam/minecolonies)
and [Structurize](https://github.com/ldtteam/structurize) (both by ldtteam,
licensed GPL-3.0) as compile-time-only (`compileOnly`) API dependencies -
their code is never copied, bundled, or redistributed here. This repository
only contains original `voyagerbridge` source; the referenced MineColonies/
Structurize/Domum Ornamentum jars are expected to already be present on the
end user's own server install (see `build.gradle`) and are not shipped with
this project. Full credit to ldtteam for MineColonies, Structurize, and
Domum Ornamentum, which this experiment depends on entirely for the colony
simulation itself - `voyagerbridge` only adds an HTTP control surface on top.
