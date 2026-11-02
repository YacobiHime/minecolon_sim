#!/usr/bin/env python3
"""Arnis で作ったワールドを 1.20.1 サーバー向けに後処理する。

使い方(詳しくは README.md):
  python3 -I arnis_post.py --in <world> --out <newworld> [--fix-renames]
      [--roads recolor|redraw|none] [--ground lighten|grass|none]
      [--set-dataversion 3465] [--report]

--in は読むだけで、必ず --out にコピーしてからコピーを書き換える。
"""
import argparse
import json
import os
import shutil
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import nbt_io  # noqa: E402
import osm  # noqa: E402
import world as W  # noqa: E402
from nbt_io import Int, make_state  # noqa: E402

# 1.20.1 に無い名前の置き換え表(新しい名前 -> 1.20.1 の名前)。必要なら足す
RENAMES_1_20_1 = {
    'minecraft:short_grass': 'minecraft:grass',  # 1.20.3 で改名
}

DEFAULT_ROAD_SURFACE = ['minecraft:gray_concrete_powder', 'minecraft:cyan_terracotta',
                        'minecraft:gray_concrete']
DEFAULT_URBAN_FILL = ['minecraft:stone_bricks', 'minecraft:cracked_stone_bricks',
                      'minecraft:light_gray_concrete']
LANE_MARK = 'minecraft:white_concrete'
GROUND_TARGET = {
    'lighten': ('minecraft:smooth_stone', None),
    'grass': ('minecraft:grass_block', {'snowy': 'false'}),
}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def state_from_arg(s):
    """'minecraft:foo' か 'minecraft:foo[a=b,c=d]' をパレットの項目にする。"""
    if '[' in s and s.endswith(']'):
        name, props = s[:-1].split('[', 1)
        p = dict(kv.split('=', 1) for kv in props.split(',') if kv)
        return make_state(name, p)
    if ':' not in s:
        s = 'minecraft:' + s
    return make_state(s)


def copy_world(src, dst, force):
    src_a, dst_a = os.path.realpath(src), os.path.realpath(dst)
    if not os.path.isdir(os.path.join(src_a, 'region')):
        raise SystemExit('--in にワールドがありません(region フォルダが無い): %s' % src)
    if src_a == dst_a or dst_a.startswith(src_a + os.sep) or src_a.startswith(dst_a + os.sep):
        raise SystemExit('--out は --in と別の場所にしてください')
    if os.path.exists(dst_a):
        if not force:
            raise SystemExit('--out が既にあります(上書きするなら --force): %s' % dst)
        shutil.rmtree(dst_a)
    shutil.copytree(src_a, dst_a)


# ---------------------------------------------------------------- 1. 改名

def fix_renames(wld, table, stats):
    """全セクションのパレットの Name を置き換える。添字は変わらない。"""
    blocks = 0
    chunks = 0
    for (cx, cz) in wld.all_chunk_coords():
        c = wld.chunk(cx, cz)
        hit = False
        for sec in c.sections.values():
            pal = sec.palette
            changed = [k for k, e in enumerate(pal) if e['Name'] in table]
            if not changed:
                continue
            if len(pal) == 1:
                blocks += 4096
            else:
                idx = sec.indices
                cs = set(changed)
                blocks += sum(1 for i in idx if i in cs)
            for k in changed:
                pal[k]['Name'] = table[pal[k]['Name']]
            # 改名で同じ項目が二つになったらまとめる
            keys = [nbt_io.state_key(e) for e in pal]
            if len(set(keys)) != len(keys):
                sec.indices  # 復号しておく
                sec.dirty = True
            hit = True
        if hit:
            c.dirty = True
            c._names.clear()
            chunks += 1
        else:
            wld.release(cx, cz)
    stats['renames'] = {'blocks': blocks, 'chunks': chunks}


# ---------------------------------------------------------------- 道路・地面の準備

class Columns:
    """列ごとの地面の情報をまとめて持つ。"""

    def __init__(self, wld, geo, buildings_osm, ground_radius, ground_tol):
        t = time.time()
        surf = W.column_surfaces(wld)
        self.ground, self.water = W.classify_ground(surf, ground_radius, ground_tol)
        self.surf = surf
        self.buildings = osm.building_cells(geo, buildings_osm) if buildings_osm else set()
        log('地面の検出: 列 %d、地面 %d、水 %d、建物の敷地 %d (%.1fs)' % (
            len(surf), len(self.ground), len(self.water), len(self.buildings), time.time() - t))

    def paintable(self, k):
        return k in self.ground and k not in self.buildings and k not in self.water


def set_block(wld, x, y, z, state):
    c = wld.chunk(x >> 4, z >> 4)
    if c is None:
        return None
    return c.set_state(x & 15, y, z & 15, state)


def clear_plant_above(wld, x, y, z, stats_key, stats):
    """塗った列の上の草花を消し、WORLD_SURFACE の高さを合わせる。"""
    c = wld.chunk(x >> 4, z >> 4)
    lx, lz = x & 15, z & 15
    n = c.name_at(lx, y + 1, lz)
    if not W.is_plant(n):
        return
    top = y + 2
    if W.is_plant(c.name_at(lx, y + 2, lz)):  # 背の高い草花(上下 2 段)
        c.set_state(lx, y + 2, lz, make_state('minecraft:air'))
        top = y + 3
    c.set_state(lx, y + 1, lz, make_state('minecraft:air'))
    stats[stats_key] = stats.get(stats_key, 0) + 1
    hm = c.nbt.get('Heightmaps', {}).get('WORLD_SURFACE')
    if hm is not None:
        vals = nbt_io.decode_states(512, hm, count=256, min_bits=1)  # 9 ビット詰め
        i = lz * 16 + lx
        if vals[i] == top - c.min_y:
            vals[i] = y + 1 - c.min_y
            bits = max(1, (c.max_y - c.min_y + 2 - 1).bit_length())
            new = nbt_io.encode_states(vals, 1 << bits, min_bits=1)
            hm[:] = new
            c.dirty = True


def road_buffer(geo, ways, widths, extra):
    """道路の中心線から (幅/2 + extra) ブロック以内の列 -> way の情報。"""
    cells = {}
    for w in ways:
        half = osm.parse_width_m(w['tags'], widths) * geo.blocks_per_m / 2
        for k, v in osm.rasterize_way(osm.way_points(geo, w), half, extra).items():
            cells.setdefault(k, []).append((w, v))
    return cells


# ---------------------------------------------------------------- 2. 道路

def roads_recolor(wld, geo, cols, ways, widths, args, stats):
    asphalt = state_from_arg(args.asphalt)
    surface = set(args.road_surface)
    buf = road_buffer(geo, ways, widths, args.buffer)
    changed = 0
    skipped_building = 0
    for k in sorted(buf, key=lambda k: (k[1], k[0])):
        if not geo.in_area(*k):
            continue
        if k in cols.buildings:
            skipped_building += 1
            continue
        if not cols.paintable(k):
            continue
        y, name = cols.ground[k]
        if name in surface:
            set_block(wld, k[0], y, k[1], asphalt)
            changed += 1
    stats['roads_recolor'] = {'buffer_columns': len(buf), 'changed_columns': changed,
                              'skipped_in_building': skipped_building}
    return set(buf)


def roads_redraw(wld, geo, cols, ways, widths, args, stats):
    asphalt = state_from_arg(args.asphalt)
    line = state_from_arg(LANE_MARK)
    side = state_from_arg(args.sidewalk) if args.sidewalk else None
    # 列 -> (優先度, 状態)。車道 2、中央線 3、歩道 1
    carriage = {}   # 列 -> 何本の way の車道にかかるか
    paint = {}
    centers = []
    for w in ways:
        t = w['tags']
        hw = t.get('highway', '')
        half = osm.parse_width_m(t, widths) * geo.blocks_per_m / 2
        pts = osm.way_points(geo, w)
        sw = 1.0 if (side is not None and hw in osm.SIDEWALK_CLASSES) else 0.0
        ras = osm.rasterize_way(pts, half, sw)
        for k, (d, s) in ras.items():
            if d <= half:
                carriage[k] = carriage.get(k, 0) + 1
                if paint.get(k, (0,))[0] < 2:
                    paint[k] = (2, asphalt)
            elif paint.get(k, (0,))[0] < 1:
                paint[k] = (1, side)
        if hw in osm.CENTERLINE_CLASSES and t.get('oneway', 'no') == 'no' and half >= 2.0:
            for k, (d, s) in ras.items():
                if d <= 0.5 and (int(s) % 6) < 3:   # 3 ブロック塗って 3 ブロック空ける
                    centers.append(k)
    for k in centers:
        if carriage.get(k, 0) == 1:  # 交差点(ほかの道路の車道と重なる所)には引かない
            paint[k] = (3, line)
    counts = {'carriageway': 0, 'center_line': 0, 'sidewalk': 0,
              'skipped_in_building': 0, 'skipped_water': 0, 'skipped_not_ground': 0}
    names = {2: 'carriageway', 3: 'center_line', 1: 'sidewalk'}
    for k in sorted(paint, key=lambda k: (k[1], k[0])):
        if not geo.in_area(*k):
            continue
        if k in cols.buildings:
            counts['skipped_in_building'] += 1
            continue
        if k in cols.water:
            counts['skipped_water'] += 1
            continue
        if k not in cols.ground:
            counts['skipped_not_ground'] += 1
            continue
        pr, st = paint[k]
        y, name = cols.ground[k]
        if name == st['Name']:
            continue
        set_block(wld, k[0], y, k[1], st)
        clear_plant_above(wld, k[0], y, k[1], 'plants_removed', counts)
        counts[names[pr]] += 1
    counts['changed_columns'] = counts['carriageway'] + counts['center_line'] + counts['sidewalk']
    stats['roads_redraw'] = counts
    return set(paint)


# ---------------------------------------------------------------- 3. 地面

def ground_fill(wld, geo, cols, road_cells, args, stats):
    name, props = GROUND_TARGET[args.ground]
    st = make_state(name, props)
    fill = set(args.urban_fill)
    changed = 0
    for k, (y, n) in sorted(cols.ground.items(), key=lambda kv: (kv[0][1], kv[0][0])):
        if n not in fill or k in road_cells or k in cols.buildings or k in cols.water:
            continue
        if not geo.in_area(*k):
            continue
        set_block(wld, k[0], y, k[1], st)
        changed += 1
    stats['ground_' + args.ground] = {'changed_columns': changed, 'to': name}


# ---------------------------------------------------------------- 4. DataVersion

def set_dataversion(out, wld, dv, stats):
    path = os.path.join(out, 'level.dat')
    name, lv, gz = nbt_io.load_file(path)
    data = lv['Data']
    data['DataVersion'] = Int(dv)
    names = {3465: '1.20.1', 3700: '1.20.4', 3955: '1.21.1', 4189: '1.21.4'}
    if 'Version' in data:
        data['Version']['Id'] = Int(dv)
        if dv in names:
            data['Version']['Name'] = names[dv]
    nbt_io.save_file(path, lv, name, gz)
    n = 0
    for (cx, cz) in wld.all_chunk_coords():
        c = wld.chunk(cx, cz)
        if int(c.nbt.get('DataVersion', -1)) != dv:
            c.nbt['DataVersion'] = Int(dv)
            c.dirty = True
            n += 1
    stats['dataversion'] = {'level_dat': dv, 'chunks': n}


# ---------------------------------------------------------------- main

def load_widths(path):
    widths = dict(osm.DEFAULT_WIDTHS)
    if path:
        with open(path, encoding='utf-8') as f:
            widths.update({k: float(v) for k, v in json.load(f).items()})
    return widths


def build_parser():
    p = argparse.ArgumentParser(description='Arnis のワールドの後処理(コピーを書き換える)')
    p.add_argument('--in', dest='src', required=True, help='元のワールド(読むだけ)')
    p.add_argument('--out', required=True, help='書き出すワールド(ここにコピーして書き換える)')
    p.add_argument('--force', action='store_true', help='--out があれば消して作り直す')
    p.add_argument('--fix-renames', action='store_true', help='1.20.1 に無いブロック名を置き換える')
    p.add_argument('--roads', choices=['recolor', 'redraw', 'none'], default='none')
    p.add_argument('--ground', choices=['lighten', 'grass', 'none'], default='none')
    p.add_argument('--set-dataversion', type=int, default=None)
    p.add_argument('--report', action='store_true', help='操作ごとの変更数を表示する')
    p.add_argument('--osm-highways', default=None, help='道路の Overpass JSON')
    p.add_argument('--osm-buildings', default=None, help='建物の Overpass JSON')
    p.add_argument('--fetch', action='store_true',
                   help='Overpass から道路と建物を取って --osm-* のパス(無ければ ./osm_cache/)に保存する')
    p.add_argument('--include-footways', action='store_true', help='歩道・階段なども塗る')
    p.add_argument('--include-bridges', action='store_true', help='橋・トンネルの道路も地面に塗る')
    p.add_argument('--asphalt', default='minecraft:black_concrete', help='車道のブロック')
    p.add_argument('--sidewalk', default=None, help='歩道のブロック(redraw のとき、例 minecraft:smooth_stone)')
    p.add_argument('--road-surface', nargs='+', default=DEFAULT_ROAD_SURFACE,
                   help='recolor で塗り替える Arnis の道路のブロック')
    p.add_argument('--urban-fill', nargs='+', default=DEFAULT_URBAN_FILL,
                   help='--ground で置き換える地面のブロック')
    p.add_argument('--road-widths', default=None, help='道路の幅の表(JSON、種別 -> メートル)')
    p.add_argument('--buffer', type=float, default=1.5,
                   help='recolor で道路の幅に足す余裕(ブロック)')
    p.add_argument('--ground-radius', type=int, default=3, help='地面判定の近所の半径')
    p.add_argument('--ground-tol', type=int, default=2, help='地面判定の高さの許容差')
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    t0 = time.time()
    need_osm = args.roads != 'none' or args.ground != 'none'
    geo = osm.GeoMap.from_world(args.src) if need_osm or args.fetch else None
    hw_path = args.osm_highways or os.path.join('osm_cache', 'highways.json')
    bd_path = args.osm_buildings or os.path.join('osm_cache', 'buildings.json')
    if args.fetch:
        log('Overpass から取得: 道路 -> %s' % hw_path)
        osm.fetch_overpass('highway', geo.bbox(), hw_path)
        log('Overpass から取得: 建物 -> %s' % bd_path)
        osm.fetch_overpass('building', geo.bbox(), bd_path)
    if need_osm:
        for pth in (hw_path, bd_path):
            if not os.path.exists(pth):
                raise SystemExit('OSM のファイルがありません: %s(--osm-highways/--osm-buildings か --fetch)' % pth)

    copy_world(args.src, args.out, args.force)
    log('コピーしました: %s -> %s' % (args.src, args.out))
    wld = W.World(args.out)
    stats = {}

    if args.fix_renames:
        fix_renames(wld, RENAMES_1_20_1, stats)

    if need_osm:
        widths = load_widths(args.road_widths)
        hw = osm.load_json(hw_path)
        bd = osm.load_json(bd_path)
        cols = Columns(wld, geo, bd, args.ground_radius, args.ground_tol)
        ways = osm.highway_ways(hw, args.include_footways, args.include_bridges)
        road_cells = set()
        if args.roads == 'recolor':
            road_cells = roads_recolor(wld, geo, cols, ways, widths, args, stats)
        elif args.roads == 'redraw':
            road_cells = roads_redraw(wld, geo, cols, ways, widths, args, stats)
        if args.ground != 'none':
            if not road_cells:
                # 道路を触らない場合も、道路の上は置き換えない
                road_cells = set(road_buffer(geo, ways, widths, args.buffer))
            ground_fill(wld, geo, cols, road_cells, args, stats)

    if args.set_dataversion:
        set_dataversion(args.out, wld, args.set_dataversion, stats)

    n = wld.save()
    stats['chunks_written'] = n
    stats['seconds'] = round(time.time() - t0, 1)
    if args.report:
        print(json.dumps(stats, ensure_ascii=False, indent=2))
    return stats


if __name__ == '__main__':
    main()
