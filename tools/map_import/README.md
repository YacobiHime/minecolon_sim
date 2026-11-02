# map_import: Arnis のワールドの後処理

一関駅の周りを [Arnis](https://github.com/louis-e/arnis) v3.3.0 で変換したワールド(Java 1.21.4 形式)を、
このサーバー(Java 1.20.1 Forge)向けに直し、道路を見やすくする道具。
Python 3 の標準ライブラリだけで動く(`python3 -I` で実行する)。

| ファイル | 中身 |
| --- | --- |
| `arnis_post.py` | 後処理の本体(コマンド) |
| `map_preview.py` | ワールドを真上から見た PNG を作る(ゲームに入らずに見比べる) |
| `nbt_io.py` | NBT・region(.mca)・block_states の読み書き |
| `world.py` | 列ごとのブロックの読み書きと、地面の検出 |
| `osm.py` | OSM(Overpass)の取得・読み込みと、ブロック座標への変換 |
| `test_arnis_post.py` | テスト(`python3 -I -m unittest -v`) |
| `testdata/` | テスト用の OSM(サンプルの範囲の道路と建物、2026-10-30 取得) |

## arnis_post.py

```sh
python3 -I arnis_post.py --in "<Arnis のワールド>" --out <新しいワールド> \
    --fix-renames --roads redraw --sidewalk minecraft:smooth_stone --ground lighten \
    --osm-highways testdata/highways.json --osm-buildings testdata/buildings.json --report
```

- **`--in` は読むだけ。** 必ず `--out` にコピーしてから、コピーを書き換える。`--out` が既にあれば止まる(`--force` で作り直す)。
- 操作はどれも独立で、組み合わせられる。

| オプション | すること |
| --- | --- |
| `--fix-renames` | 1.20.1 に無いブロック名を置き換える。今は `minecraft:short_grass` → `minecraft:grass` だけ(表 `RENAMES_1_20_1` に足せる) |
| `--roads recolor` | OSM の道路の幅(+`--buffer`、既定 1.5 ブロック)の中で、地面が Arnis の道路のブロック(`--road-surface`、既定 gray_concrete_powder / cyan_terracotta / gray_concrete)の列を `--asphalt`(既定 black_concrete)にする。白線(white_concrete)は残す |
| `--roads redraw` | OSM の道路を 1 本ずつ地面に帯として塗る。車道は `--asphalt`、primary〜tertiary(一方通行でないもの)には白の破線の中央線(3 塗って 3 空ける、交差点には引かない)、`--sidewalk` を付けると primary〜tertiary の両側に幅 1 の歩道。歩道・階段など(footway/steps/pedestrian/path)は `--include-footways` を付けたときだけ。橋・トンネルの道路は既定で塗らない(`--include-bridges`) |
| `--ground lighten\|grass` | 道路でも建物でもない地面の列のうち、表面が `--urban-fill`(既定 stone_bricks / cracked_stone_bricks / light_gray_concrete、完全なブロックだけ)のものを、lighten → smooth_stone、grass → grass_block にする |
| `--set-dataversion 3465` | level.dat の DataVersion と Version(Name "1.20.1"、Id 3465)、全チャンクの DataVersion を書き換える |
| `--report` | 操作ごとの変更数を JSON で表示する |
| `--fetch` | Overpass から道路と建物を取って `--osm-highways` / `--osm-buildings`(省略時 `./osm_cache/`)に保存してから使う |

道路の幅は種別ごとの表(メートル、`osm.DEFAULT_WIDTHS`: primary 10、secondary 8、tertiary 7、
unclassified/residential 5、service 3、footway 2 など)を使い、`width` タグがあればそれ、無くて `lanes` があれば
車線数×3.0m にする。`--road-widths 表.json`(`{"primary": 12, ...}`)で上書きできる。
メートルからブロックへは metadata.json の範囲から求めた倍率(このサンプルでは 1 ブロック ≒ 1.0m)を掛ける。

道路も地面も、**OSM の建物の敷地の中(外周の辺を含む)と、水の上には塗らない。**

### 座標

Arnis の `metadata.json` の範囲で、`x = minMcX + (lon-minLon)/(maxLon-minLon)*(maxMcX-minMcX)`、
`z = minMcZ + (maxLat-lat)/(maxLat-minLat)*(maxMcZ-minMcZ)`(北が z の小さい側)。

### 地面の見つけ方

1. 列ごとに、下から岩盤とその上の空気(Arnis は y=-63 を空気にする)を飛ばし、最初の固体から上へ、
   **上のブロックが「開いている」ところまで**登る。そこを列の候補にする。「開いている」は空気・草花・
   レール・じゅうたん・ボタン・看板・水など(`world.is_open`)。屋根や橋は、地面との間に空気があるので選ばれない。
2. 候補の高さが、近所(半径 3 の正方形)の候補の最小値より 2 を超えて高い列は、壁・塀・木の幹など
   地面から立ち上がった構造物とみなして外す(`--ground-radius` / `--ground-tol`)。
3. 候補の上が水の列は「水」として外す。
4. さらに OSM の建物の敷地を外す(壁の中や床は塗らない)。

サンプル(500×500)では、列 25 万のうち地面 22.9 万、水 7,085。地形は y=-63〜-57 で起伏がある。
redraw で塗った列はすべて「下が固体・上が開いている・近所の地面より 2 以上高くない」ことをテストで確かめている。

## map_preview.py

```sh
python3 -I map_preview.py <ワールド> --out preview.png --scale 2 --marks "250,250,center;100,80,A"
python3 -I map_preview.py <元のワールド> --diff <新しいワールド> --out diff.png
```

各列の一番上のブロックを色の表(バニラに近い色、表に無いものはマゼンタ)で塗り、北隣との高さの差で明暗を付ける。
`--diff` は、中身が一つでも違う列を新しいワールドの色で、同じ列を薄い灰色で描く。

## テスト

```sh
cd tools/map_import && python3 -I -m unittest -v
```

サンプルのワールド(既定 `/root/mc-server-forge/arnis_out/Arnis World 1`、`ARNIS_SAMPLE_WORLD` で変更)を一時フォルダに
コピーして各操作をかける。サンプルが無ければ、ワールドを使うテストは飛ばす。

## 注意

- 地図のデータは © OpenStreetMap contributors(ODbL)。`testdata/` の JSON も同じ。画像を論文・発表で見せるときは
  「© OpenStreetMap contributors」の表示が要る。
- ワールドや画像はリポジトリに入れない。
