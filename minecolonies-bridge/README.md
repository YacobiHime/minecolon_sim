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

## 市民の会話の同時人数の計測(chat_capacity_bench.js)

研究室の LLM サーバーで、LLM で話す市民が**何人まで実時間で互いに会話できるか**を手早く調べる道具。
node の標準モジュールだけの1ファイルなので、LLM のマシンにコピーしてそこで実行してもよい。

- LLM の API(`--api`): 既定は `openai`(llama.cpp の `llama-server`、`POST /v1/chat/completions`、
  既定の接続先 `127.0.0.1:8080`)。鍵は環境変数 `LLM_API_KEY` から読み `Authorization: Bearer` で送る
  (ログにも結果ファイルにも書かない)。`--api=ollama` は `POST /api/chat`(`think:false`、既定 `192.168.15.150:11434`)。
- `--llm-hosts=host:port,host:port` を複数書くと順番に振り分ける(GPU・マシンが複数のとき)。
  `--model`(既定 `gemma4:e4b`)、`--max-tokens`(既定 60)。トークン数・処理時間は
  llama.cpp の `timings`/`usage`、Ollama の `eval_count` などから記録する。
- 発言のプロンプトは、市民の名前・職業・性格1行と直近8行のチャットで、40字以内の日本語1行を返させる。
- 結果は `--out`(既定 `experiment_logs/chat_bench_<mode>_<時刻>.json`)に JSON で書く。

**throughput モード**: 同時リクエスト数 c(`--concurrency=1,2,4,8,16`)ごとに `--requests`(既定24)件を
c 件ずつ流し続け、実時間・発言/秒・遅延 p50/p95/最大・出力トークン数・トークン/秒・エラー数を出す。
そのうえで発言間隔 `--intervals=10,20,30,60` 秒ごとの最大人数を見積もる:

```
最大人数 = floor(持続できる発言/秒 × 発言間隔[秒])
持続できる発言/秒 = p95 遅延 ≤ --max-latency-ms(既定 5000)を満たす c のうち最大の発言/秒
```

**live モード**: 実際に N 人で会話させる。市民は bridge の `GET /status` の `citizens[]`(id・name・job)から取り、
足りない分は合成の市民で補う(`--allow-synthetic`、既定 true。結果に `synthetic` と記録)。
各市民が `--interval`(既定20秒、±20% のゆらぎ)ごとに1回話すように予定を組み、話す人には直近8行を渡すので
互いに返事をし合う。`--duration`(既定120秒)のあいだ、達成した発言数/人/分、LLM の遅延 p50/p95、
予定からの遅れ、待ち行列を測る。`--ramp=4,8,16,32` で N を順に増やし、**実時間の基準**
「p95 遅延 ≤ `--max-latency-ms` かつ 達成した発言数が目標(60/間隔 回/分)の90%以上」を満たした最大の N を出す。
同時に流すリクエスト数の上限は `--live-concurrency`(既定 ホスト数×4)。発言は結果の隣の `.transcript.jsonl` に1行ずつ残す。
bridge へは `GET /status` しか送らない。ゲームのチャットへの書き込みは **`--say` を付けたときだけ**
(`CMD_PIPE` の FIFO に `say <名前>: <発言>`。読み手がいなければ飛ばす)。既定は書き込まない。

```bash
export LLM_API_KEY=...   # llama-server の鍵
node chat_capacity_bench.js --mode=throughput --llm-hosts=127.0.0.1:8080 --concurrency=1,2,4,8,16
node chat_capacity_bench.js --mode=live --ramp=4,8,16,32 --interval=20 --duration=120
node chat_capacity_bench.js --mode=live --citizens=6 --say   # 実際にゲームのチャットへ流す
```

テストは `node test_chat_capacity_bench.js`(偽の LLM・偽の bridge を立てて確かめる)。

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
