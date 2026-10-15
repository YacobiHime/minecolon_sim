# MineColonies シミュレーション セットアップ手順

この文書は、実験マシン上でMineColoniesのシミュレーションを開始し、Minecraftプレイヤーとして観察するための手順です。

> **2026-10-15 移設:** 実験マシンは旧 `mine-server`(192.168.15.10、`/home/mine-admin`)から `panama`(LAN 192.168.15.102、Tailscale 100.88.86.71、ユーザー `root`)へ恒久的に移りました。以下のパスはすべて panama 上のものです。

現在の構成は次のとおりです。

- 実験マシン: `panama`(LAN `192.168.15.102` / Tailscale `100.88.86.71`、ユーザー `root`)

- Minecraft: 1.20.1
- Forge: 1.20.1-47.1.3
- Minecraftサーバー: `/root/mc-server-forge`
- 本リポジトリ: `/root/minecolon_sim`
- ワールドのバックアップ: `/root/simulation-backups`
- JDK17(bridgeビルド用): `/opt/jdk-17.0.19+10`
- ゲームポート: `25565`
- Voyager Bridge API: `127.0.0.1:8089`
- コロニー中心: `X=0, Y=-60, Z=0`
- コロニーID: `1`
- 稼働エージェント: `supply_bot.js` のみ(LLM市長 `council.js` は任意。2026年度の計画では使用しない)

## 1. クライアントの準備

Minecraftクライアントにも、サーバーと同じMinecraft 1.20.1用Forge環境と前提MODが必要です。

必須MOD:

```text
blockui-1.20.1-1.0.193.jar
structurize-1.20.1-1.0.816.jar
domum_ornamentum-1.20.1-1.0.303-snapshot-universal.jar
multipiston-1.20-0.0.47-snapshot.jar
minecolonies-1.20.1-1.1.1255-snapshot.jar
```

サーバーではForge 1.20.1-47.1.3を使用しています。接続トラブルを避けるため、クライアントも同じForgeバージョンを推奨します。

観察に便利な任意MOD:

```text
journeymap-1.20.1-5.9.24-forge.jar
jei-1.20.1-forge-15.20.0.133.jar
caramelChat-mc1.20.1-forge-1.2.0.jar
```

`voyagerbridge-0.1.0.jar` はサーバー側専用です。クライアントへの導入は不要です。

## 2. Tailscale踏み台経由で接続する

> **同じTailscaleネットワークにいるクライアントの場合:** トンネル不要です。Minecraftの「マルチプレイ」から `100.88.86.71:25565` へ直接接続できます。以下のSSHトンネル手順は、Tailscaleに参加していないクライアント向けです。

クライアントPCの `~/.ssh/config` に以下を設定します。

```sshconfig
Host lab-raspi
    HostName donescargot.tailb42ea.ts.net
    User student
    IdentityFile ~/.ssh/id_lab
    Port 22

# 2026-10-15 以降の実験マシンは panama(エイリアス名は従来どおり mine-server)
Host mine-server
    HostName 192.168.15.102
    User root
    ProxyJump lab-raspi
    IdentityFile ~/.ssh/id_lab
```

クライアントPCでSSHトンネルを開きます。このターミナルはMinecraftで接続している間、閉じないでください。

```bash
ssh -N -L 25566:127.0.0.1:25565 mine-server
```

Minecraftの「マルチプレイ」から次のアドレスへ接続します。

```text
localhost:25566
```

## 3. サーバーを起動する

サーバーへSSH接続します。

```bash
ssh mine-server
```

Forgeは必ず `start_server.sh` から起動します。このスクリプトが `cmd_pipe` をForgeの標準入力へ接続するため、LLMの発言がゲーム内チャットへ表示されます。

```bash
tmux new-session -d -s mc-server '/root/mc-server-forge/start_server.sh'
```

起動完了を確認します。

```bash
until curl -fsS http://127.0.0.1:8089/ping; do sleep 2; done
curl -fsS http://127.0.0.1:8089/status | jq
```

サーバーログを見る場合:

```bash
tmux attach -t mc-server
```

tmuxから抜けるときは `Ctrl-B`、続けて `D` を押します。`Ctrl-C` はサーバーを終了させるため、通常は押さないでください。

## 4. 管理者権限を与える

サーバー側からプレイヤーをOPレベル4に登録します。

```bash
printf 'op YacobiHime\n' > /root/mc-server-forge/cmd_pipe
```

登録状態は次のファイルで確認できます。

```bash
jq . /root/mc-server-forge/ops.json
```

権限を取り消す場合:

```bash
printf 'deop YacobiHime\n' > /root/mc-server-forge/cmd_pipe
```

## 5. 新しいシミュレーション用にワールドをリセットする

この操作は現在のワールドを切り替えます。ワールドは削除せず、日時付きディレクトリへ退避します。

まずLLMエージェントとサーバーを正常終了します。

```bash
pkill -f 'node council\.js$' || true
pkill -f 'node supply_bot\.js$' || true
/root/mc-server-forge/stop_server.sh
```

Javaプロセスが終了したことを確認します。

```bash
while pgrep -f 'libraries/net/minecraftforge/forge/1\.20\.1-47\.1\.3/unix_args\.txt' >/dev/null; do
    sleep 1
done
```

現在のワールドをバックアップします。

```bash
backup_stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_dir="/root/simulation-backups/$backup_stamp"
mkdir -p "$backup_dir"
mv /root/mc-server-forge/world "$backup_dir/world"
cp /root/mc-server-forge/server.properties "$backup_dir/server.properties"
```

必要に応じて、エージェントのログも保存します。

```bash
cp /root/minecolon_sim/minecolonies-bridge/council5.log "$backup_dir/council5.log"
cp /root/minecolon_sim/minecolonies-bridge/supply_bot.log "$backup_dir/supply_bot.log"
```

その後、手順3の方法でサーバーを起動します。`world` ディレクトリが自動生成され、`/status` が `[]` なら空のワールドです。

## 6. 撮影・観察位置へ移動する

コロニー予定地は `0, -60, 0` です。ワールドのスポーン地点と同じ場所なので、通常は長距離移動する必要がありません。ゲーム内チャットで以下を実行すると、斜め上方の撮影位置へ移動できます。

新規ワールド生成後は、サーバー側でワールドスポーンと観察者の個人スポーンを明示的に原点へ設定します。

```bash
printf 'setworldspawn 0 -60 0\nspawnpoint YacobiHime 0 -60 0\n' > /root/mc-server-forge/cmd_pipe
```

```mcfunction
/gamemode spectator
/tp @s 45 -30 45 135 25
```

真上から確認したい場合:

```mcfunction
/tp @s 0 0 0 0 90
```

建築へ介入したい場合はCreativeへ戻します。

```mcfunction
/gamemode creative
```

建物が見えない場合は `F3+A` でチャンクを再読み込みしてください。コロニーはおおむね中心から100ブロック以内に発展します。

## 7. コロニーを創設する

録画する場合は、ここから先へ進む前にMinecraftクライアント側で録画を開始します。

最初に予定地周辺を常時読み込み対象にします。

```bash
printf 'forceload add -16 -16 15 15\n' > /root/mc-server-forge/cmd_pipe
```

Town Hallを配置してコロニーを創設します。

```bash
curl -fsS -X POST 'http://127.0.0.1:8089/place?x=0&y=-60&z=0&block=minecolonies%3Ablockhuttownhall'
curl -fsS -X POST 'http://127.0.0.1:8089/found?x=0&y=-60&z=0&name=Voyager%20Simulation'
```

Builder's Hutを配置します。応答に表示された `[pos:X,Y,Z]` を控え、その座標で着工を要求してください。

```bash
curl -fsS -X POST 'http://127.0.0.1:8089/placeNext?block=minecolonies%3Ablockhutbuilder&colonyId=1'
curl -fsS -X POST 'http://127.0.0.1:8089/requestBuild?x=BUILDER_X&y=BUILDER_Y&z=BUILDER_Z'
```

`BUILDER_X`、`BUILDER_Y`、`BUILDER_Z` は `placeNext` の返却座標へ置き換えます。

初期市民はコロニー創設時に生成されます。人数を増やす必要がある場合のみ実行します。

```bash
curl -fsS -X POST 'http://127.0.0.1:8089/spawnCitizen?colonyId=1'
```

シミュレーション速度を適応ガバナー(auto)に設定します。tick処理時間に余裕がある範囲で倍率を自動調整します(最大40倍)。サーバー再起動で1倍に戻るので、起動のたびに実行します。固定倍率が必要なときだけ `?multiplier=N` を使います(autoは解除されます)。

```bash
curl -fsS -X POST 'http://127.0.0.1:8089/tickrate?auto=true'
curl -fsS http://127.0.0.1:8089/tickrate
```

## 8. 初期建築を完成させてLLMエージェントを開始する

> **注:** Council(`council.js`、LLM市長)は任意です。2026年度の計画ではLLM(Ollama)を使わず、コロニーは Supply Bot だけで運用します。Councilのコードは残してあるので、LLM実験を行う場合のみ以下の Council 起動手順を実行してください。

最初にSupply Botだけを起動します。Builder's Hutの建築中にCouncilを起動すると、稼働中の建築家がいない状態で次の建物を計画する可能性があるため、Councilはまだ起動しません。

```bash
cd /root/minecolon_sim/minecolonies-bridge

setsid -f node supply_bot.js >> supply_bot.log 2>&1 </dev/null
```

`/status` を確認し、`blockhutbuilder` が `"level": 1`、`"operational": true` になるまで待ちます。

```bash
watch -n 5 'curl -fsS http://127.0.0.1:8089/status | jq'
```

`Ctrl-C` で `watch` を終了し、Town Hallの建築を要求します。

```bash
curl -fsS -X POST 'http://127.0.0.1:8089/requestBuild?x=0&y=-60&z=0'
```

再び `/status` を確認し、`blockhuttownhall` が `"level": 1`、`"operational": true` になったらCouncilを起動します。

```bash
cd /root/minecolon_sim/minecolonies-bridge

setsid -f env CMD_PIPE=/root/mc-server-forge/cmd_pipe \
    node council.js >> council5.log 2>&1 </dev/null
```

各プロセスが1つだけ動いていることを確認します。

```bash
pgrep -fa 'node (supply_bot|council)\.js'
```

ログを観察します。

```bash
tail -f /root/minecolon_sim/minecolonies-bridge/council5.log
```

ゲーム内チャットにAldric、Mira、市民の発言が表示され、建物が順次配置・建築されれば開始成功です。

## 9. 稼働状態を確認する

コロニー全体:

```bash
curl -fsS http://127.0.0.1:8089/status | jq
```

Bridge:

```bash
curl -fsS http://127.0.0.1:8089/ping
```

Minecraftサーバー:

```bash
pgrep -fa 'libraries/net/minecraftforge/forge/1\.20\.1-47\.1\.3/unix_args\.txt'
tail -n 100 /root/mc-server-forge/logs/latest.log
```

## 10. 社会シミュレーション実験を実行する

統合runnerはBridgeから現在状態を読み取りますが、Minecraftのworld・市民在庫・
関係状態を変更しません。

```bash
cd /root/minecolon_sim/minecolonies-bridge

node experiment_runner.js \
  --source=live \
  --conditions=uniform,persona,persona_relation,temporal \
  --severity=0.5:0.5,0.5:0.75,0.5:1 \
  --repeats=30 \
  --mode=sample \
  --seed=food-v1
```

実行後の`outputDir`に、完全な入力snapshot、全試行ログ、JSON/CSV集計が保存されます。
snapshotを`--input=.../input_snapshot.json`で渡すと、同じ条件を再実行できます。

LLMの接続確認は、最初は1シナリオに制限します。

```bash
node experiment_runner.js \
  --input=/path/to/input_snapshot.json \
  --conditions=llm --severity=0.5:1 \
  --repeats=1 --scenario-limit=1 --seed=llm-smoke-v1
```

## 11. 正常終了する

先にエージェントを停止し、次にForgeへ `stop` を送ります。

```bash
pkill -f 'node council\.js$' || true
pkill -f 'node supply_bot\.js$' || true
/root/mc-server-forge/stop_server.sh
```

ワールド保存完了前にJavaプロセスを強制終了しないでください。

## トラブルシューティング

### LLMの発言がゲーム内に表示されない

Forgeを `run.sh` から直接起動せず、`start_server.sh` から起動してください。また、Councilに現在のFIFOを指定します。

```bash
CMD_PIPE=/root/mc-server-forge/cmd_pipe node council.js
```

### 建設が資材待ちで止まる

Supply Botが1プロセス動作しているか確認します。

```bash
pgrep -fa 'node supply_bot\.js'
tail -n 100 /root/minecolon_sim/minecolonies-bridge/supply_bot.log
```

### Minecraftから接続できない

- クライアントのMinecraft、Forge、必須MODのバージョンを確認する
- クライアントPC側のSSHトンネルが動作中か確認する
- 接続先が `localhost:25566`(SSHトンネル経由)または `100.88.86.71:25565`(Tailscale直結)になっているか確認する
- サーバー側で `ss -ltn | grep 25565` を実行する

### 管理者コマンドが使えない

プレイヤー名の大文字・小文字を正確に指定して、もう一度OP登録します。

```bash
printf 'op YacobiHime\n' > /root/mc-server-forge/cmd_pipe
```
