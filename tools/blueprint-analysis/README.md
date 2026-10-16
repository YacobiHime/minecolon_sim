# 設計図の解析スクリプト

MineColonies／Structurize の設計図（`.blueprint`）を読み、ビルダーの整地・埋め立てに関わる値を数えるスクリプトです。仕様把握セッションで、ビルダーが自分で整地できる段差を調べるために作りました（方針メモ 8章の申し送り）。標準ライブラリだけで動きます。

| ファイル | 内容 |
| --- | --- |
| `nbt.py` | 設計図を読む最小限の NBT パーサー |
| `layers.py` | 設計図ごとに、地面の層の数（`primary_offset.y` + groundlevel タグの y + 1。タグがなければ `primary_offset.y`）と、地面の層の中の blockSolidSubstitution・blockSubstitution の割合、blockSolidSubstitution がある層を数えて JSON に書く |
| `first_tag.py` | groundlevel タグが2つある設計図で、Structurize（`BlueprintTagUtils.getFirstPosForTag`、HashMap の並び）がどちらを使うかを、回転ごとに計算する |

## 使い方

設計図は MineColonies のリポジトリから、使っている版のタグで取り出します（研究室の版は `v1.20.1-1.1.1231`）。

```sh
git clone --filter=blob:none --no-checkout https://github.com/ldtteam/minecolonies.git mc
cd mc
git sparse-checkout set --no-cone 'src/main/resources/blueprints/minecolonies/colonial/'
git checkout v1.20.1-1.1.1231
cd ..

# 設計図ごとの地面の層の数（--all-levels を付けないとレベル1だけ）
python3 -I tools/blueprint-analysis/layers.py mc/src/main/resources/blueprints/minecolonies/colonial layers.json --all-levels

# groundlevel タグが2つある設計図で、使われるタグを回転ごとに求める
python3 -I tools/blueprint-analysis/first_tag.py mc/src/main/resources/blueprints/minecolonies/colonial/fundamentals/residence4.blueprint
```

## 注意

- `first_tag.py` の回転は、MineColonies の `BlockPos.rotate` に合わせた近似です。ゲーム内では確かめていません。
- 結果の読み方は、仕様ノート（`docs/research/minecolonies-spec-notes.md`）の該当する章を見てください。
