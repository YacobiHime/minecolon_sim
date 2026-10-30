#!/usr/bin/env python3
"""ワールドを真上から見た PNG を作る(ゲームに入らずに見比べるため)。

  python3 -I map_preview.py <world> --out preview.png [--scale 2] [--marks x,z,label;...]
  python3 -I map_preview.py <world> --diff <otherworld> --out diff.png

各列の一番上の空気でないブロックを色の表で塗り、北隣との高さの差で明暗を付ける。
表に無いブロックはマゼンタ。--diff では、二つのワールドで中身が違う列を
<otherworld> 側の色でそのまま、同じ列を薄い灰色で描く。
"""
import argparse
import os
import struct
import sys
import zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import world as W  # noqa: E402

UNKNOWN = (255, 0, 255)

# ブロック -> RGB(バニラの見た目に近い色)
COLORS = {
    'stone': (125, 125, 125), 'bedrock': (85, 85, 85), 'stone_bricks': (122, 121, 122),
    'cracked_stone_bricks': (118, 117, 118), 'mossy_stone_bricks': (115, 121, 105),
    'chiseled_stone_bricks': (120, 119, 120), 'cobblestone': (127, 127, 127),
    'mossy_cobblestone': (110, 118, 95), 'smooth_stone': (159, 159, 159),
    'andesite': (136, 136, 137), 'polished_andesite': (132, 135, 134),
    'diorite': (189, 188, 189), 'polished_diorite': (193, 193, 195),
    'granite': (149, 103, 86), 'polished_granite': (154, 107, 89),
    'deepslate': (80, 80, 82), 'cobbled_deepslate': (77, 77, 80),
    'polished_deepslate': (72, 72, 73), 'deepslate_bricks': (70, 70, 71),
    'deepslate_tiles': (54, 54, 55), 'tuff': (108, 109, 102),
    'blackstone': (42, 36, 41), 'polished_blackstone': (53, 48, 56),
    'polished_blackstone_bricks': (48, 42, 49), 'gilded_blackstone': (56, 43, 38),
    'bricks': (150, 97, 83), 'mud_bricks': (137, 103, 79), 'mud': (60, 57, 60),
    'packed_mud': (142, 106, 79), 'nether_bricks': (44, 21, 26), 'red_nether_bricks': (69, 7, 9),
    'end_stone_bricks': (218, 224, 162), 'end_stone': (219, 222, 158),
    'sandstone': (216, 203, 155), 'smooth_sandstone': (223, 214, 170),
    'cut_sandstone': (217, 206, 159), 'chiseled_sandstone': (216, 202, 155),
    'red_sandstone': (186, 99, 29), 'smooth_red_sandstone': (181, 97, 31),
    'quartz_block': (235, 229, 222), 'smooth_quartz': (235, 229, 222),
    'quartz_bricks': (234, 229, 221), 'chiseled_quartz_block': (231, 226, 218),
    'quartz_pillar': (235, 230, 224),
    'purpur_block': (169, 125, 169),
    'prismarine': (99, 156, 151), 'prismarine_bricks': (99, 171, 158),
    'dark_prismarine': (51, 91, 75), 'sea_lantern': (172, 199, 190),
    'glowstone': (171, 131, 84), 'redstone_lamp': (95, 54, 30), 'shroomlight': (240, 146, 70),
    'iron_block': (220, 220, 220), 'gold_block': (246, 208, 61), 'coal_block': (16, 15, 15),
    'copper_block': (192, 107, 79), 'diamond_block': (98, 237, 228),
    'dirt': (134, 96, 67), 'coarse_dirt': (119, 85, 59), 'rooted_dirt': (144, 103, 76),
    'grass_block': (95, 159, 53), 'podzol': (91, 63, 24), 'mycelium': (111, 99, 105),
    'dirt_path': (148, 122, 65), 'farmland': (81, 44, 15), 'moss_block': (89, 109, 45),
    'sand': (219, 207, 163), 'red_sand': (190, 102, 33), 'gravel': (131, 127, 126),
    'clay': (160, 166, 179), 'snow_block': (249, 254, 254), 'snow': (249, 254, 254),
    'ice': (145, 183, 253), 'packed_ice': (141, 180, 250), 'blue_ice': (116, 167, 253),
    'water': (63, 118, 228), 'lava': (207, 92, 20),
    'oak_planks': (162, 130, 78), 'spruce_planks': (114, 84, 48), 'birch_planks': (192, 175, 121),
    'jungle_planks': (160, 115, 80), 'acacia_planks': (168, 90, 50), 'dark_oak_planks': (66, 43, 20),
    'mangrove_planks': (117, 54, 48), 'cherry_planks': (226, 178, 172), 'bamboo_planks': (193, 173, 80),
    'crimson_planks': (101, 48, 70), 'warped_planks': (43, 104, 99),
    'oak_log': (109, 85, 50), 'spruce_log': (58, 37, 16), 'birch_log': (216, 215, 210),
    'jungle_log': (85, 67, 25), 'acacia_log': (103, 96, 86), 'dark_oak_log': (60, 46, 26),
    'oak_leaves': (60, 120, 40), 'spruce_leaves': (50, 90, 50), 'birch_leaves': (95, 135, 60),
    'jungle_leaves': (55, 125, 30), 'acacia_leaves': (75, 115, 30), 'dark_oak_leaves': (45, 100, 25),
    'azalea_leaves': (90, 117, 44), 'flowering_azalea_leaves': (100, 112, 60),
    'mangrove_leaves': (70, 120, 35), 'cherry_leaves': (229, 172, 194),
    'glass': (200, 220, 225), 'tinted_glass': (44, 38, 46), 'glass_pane': (200, 220, 225),
    'iron_bars': (136, 139, 135), 'chain': (60, 65, 80), 'lantern': (106, 91, 83),
    'terracotta': (152, 94, 68),
    'short_grass': (95, 159, 53), 'grass': (95, 159, 53), 'tall_grass': (95, 159, 53),
    'fern': (85, 140, 50), 'large_fern': (85, 140, 50), 'dead_bush': (107, 78, 40),
    'poppy': (180, 40, 30), 'dandelion': (240, 220, 40), 'lilac': (170, 130, 170),
    'rose_bush': (150, 40, 40), 'lily_of_the_valley': (220, 220, 220), 'peony': (220, 170, 200),
    'blue_orchid': (40, 160, 200), 'flower_pot': (124, 68, 53),
    'rail': (125, 110, 90), 'powered_rail': (140, 110, 70), 'chest': (163, 116, 46),
    'blast_furnace': (80, 80, 81), 'furnace': (110, 110, 110), 'crafting_table': (120, 73, 42),
    'bookshelf': (117, 94, 59), 'hay_block': (166, 136, 38), 'melon': (111, 145, 30),
    'pumpkin': (198, 118, 24), 'oak_fence': (162, 130, 78), 'oak_fence_gate': (162, 130, 78),
    'dark_oak_fence_gate': (66, 43, 20), 'dark_oak_fence': (66, 43, 20),
    'stone_button': (125, 125, 125), 'birch_button': (192, 175, 121),
}
DYES = {
    'white': (207, 213, 214), 'orange': (224, 97, 1), 'magenta': (169, 48, 159),
    'light_blue': (36, 137, 199), 'yellow': (241, 175, 21), 'lime': (94, 169, 25),
    'pink': (214, 101, 143), 'gray': (55, 58, 62), 'light_gray': (125, 125, 115),
    'cyan': (21, 119, 136), 'purple': (100, 32, 156), 'blue': (45, 47, 143),
    'brown': (96, 60, 32), 'green': (73, 91, 36), 'red': (142, 33, 33), 'black': (8, 10, 15),
}
TERRACOTTA = {
    'white': (210, 178, 161), 'orange': (162, 84, 38), 'magenta': (149, 88, 109),
    'light_blue': (113, 109, 138), 'yellow': (186, 133, 35), 'lime': (104, 118, 53),
    'pink': (162, 78, 79), 'gray': (58, 42, 36), 'light_gray': (135, 107, 98),
    'cyan': (87, 91, 91), 'purple': (118, 70, 86), 'blue': (74, 60, 91),
    'brown': (77, 51, 36), 'green': (76, 83, 42), 'red': (143, 61, 47), 'black': (37, 23, 16),
}
CONCRETE_POWDER = {k: tuple(min(255, int(c * 1.15 + 20)) for c in v) for k, v in DYES.items()}
WOOL = {k: tuple(min(255, int(c * 1.05 + 10)) for c in v) for k, v in DYES.items()}
WOOL['white'] = (234, 236, 237)

SHAPE_SUFFIXES = ('_stairs', '_slab', '_wall', '_trapdoor', '_door', '_fence_gate', '_fence',
                  '_pressure_plate', '_button', '_wall_sign', '_sign', '_wall_banner', '_banner',
                  '_pane', '_carpet')


def _dye_split(base, suffix):
    if base.endswith(suffix):
        return base[:-len(suffix)]
    return None


def block_color(name, cache={}):
    c = cache.get(name)
    if c is not None:
        return c
    base = name.split(':', 1)[-1]
    c = _block_color(base)
    cache[name] = c
    return c


def _block_color(base):
    if base in COLORS:
        return COLORS[base]
    for suf, table in (('_concrete_powder', CONCRETE_POWDER), ('_concrete', DYES),
                       ('_terracotta', TERRACOTTA), ('_glazed_terracotta', TERRACOTTA),
                       ('_wool', WOOL), ('_carpet', WOOL)):
        d = _dye_split(base, suf)
        if d is not None and d in table:
            return table[d]
    for suf in ('_stained_glass_pane', '_stained_glass'):
        d = _dye_split(base, suf)
        if d is not None and d in DYES:
            r, g, b = DYES[d]
            return ((r + 200) // 2, (g + 210) // 2, (b + 215) // 2)
    if base.startswith('potted_'):
        return COLORS['flower_pot']
    if base.endswith('_tulip'):
        return (200, 80, 60)
    for suf in SHAPE_SUFFIXES:
        if base.endswith(suf):
            stem = base[:-len(suf)]
            for cand in (stem, stem + 's', stem + '_block', stem + '_planks',
                         stem.replace('brick', 'bricks'), stem.replace('tile', 'tiles')):
                if cand in COLORS:
                    return COLORS[cand]
                c = _block_color(cand) if cand != base and cand.endswith(('_concrete', '_wool', '_terracotta')) else None
                if c:
                    return c
            if suf in ('_wall_banner', '_banner', '_carpet'):
                for d in DYES:
                    if stem == d:
                        return WOOL[d]
    return UNKNOWN


# ---------------------------------------------------------------- 文字(3x5)

FONT = {
    '0': '111101101101111', '1': '010110010010111', '2': '111001111100111', '3': '111001111001111',
    '4': '101101111001001', '5': '111100111001111', '6': '111100111101111', '7': '111001001001001',
    '8': '111101111101111', '9': '111101111001111', 'A': '010101111101101', 'B': '110101110101110',
    'C': '011100100100011', 'D': '110101101101110', 'E': '111100110100111', 'F': '111100110100100',
    'G': '011100101101011', 'H': '101101111101101', 'I': '111010010010111', 'J': '001001001101010',
    'K': '101101110101101', 'L': '100100100100111', 'M': '101111111101101', 'N': '110101101101101',
    'O': '010101101101010', 'P': '110101110100100', 'Q': '010101101111011', 'R': '110101110101101',
    'S': '011100010001110', 'T': '111010010010010', 'U': '101101101101111', 'V': '101101101101010',
    'W': '101101111111101', 'X': '101101010101101', 'Y': '101101010010010', 'Z': '111001010100111',
    '-': '000000111000000', '_': '000000000000111', '.': '000000000000010', ' ': '000000000000000',
    ',': '000000000010100', ':': '000010000010000', '/': '001001010100100',
}


# ---------------------------------------------------------------- 画像

class Image:
    def __init__(self, w, h, bg=(0, 0, 0)):
        self.w, self.h = w, h
        self.px = bytearray(bytes(bg) * (w * h))

    def set(self, x, y, c):
        if 0 <= x < self.w and 0 <= y < self.h:
            i = (y * self.w + x) * 3
            self.px[i:i + 3] = bytes(c)

    def rect(self, x, y, s, c):
        for dy in range(s):
            for dx in range(s):
                self.set(x + dx, y + dy, c)

    def text(self, x, y, s, c, size=2):
        for ch in s.upper():
            g = FONT.get(ch, FONT[' '])
            for i, bit in enumerate(g):
                if bit == '1':
                    self.rect(x + (i % 3) * size, y + (i // 3) * size, size, c)
            x += 4 * size

    def save_png(self, path):
        raw = bytearray()
        row = self.w * 3
        for y in range(self.h):
            raw.append(0)
            raw += self.px[y * row:(y + 1) * row]

        def chunk(t, d):
            return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xFFFFFFFF)
        png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', self.w, self.h, 8, 2, 0, 0, 0))
        png += chunk(b'IDAT', zlib.compress(bytes(raw), 9)) + chunk(b'IEND', b'')
        with open(path, 'wb') as f:
            f.write(png)


# ---------------------------------------------------------------- ワールドを読む

def top_blocks(wld):
    """(x, z) -> (y, name)。"""
    out = {}
    for (cx, cz) in wld.all_chunk_coords():
        c = wld.chunk(cx, cz)
        for z in range(16):
            for x in range(16):
                y, n = c.top_block(x, z)
                if y is not None:
                    out[(cx * 16 + x, cz * 16 + z)] = (y, n)
        wld.release(cx, cz)
    return out


def changed_columns(wa, wb):
    """二つのワールドで、ブロックが一つでも違う列の集合。"""
    out = set()
    for (cx, cz) in sorted(set(wa.all_chunk_coords()) | set(wb.all_chunk_coords())):
        ca, cb = wa.chunk(cx, cz), wb.chunk(cx, cz)
        if ca is None or cb is None:
            for z in range(16):
                for x in range(16):
                    out.add((cx * 16 + x, cz * 16 + z))
            continue
        for sy in sorted(set(ca.ys) | set(cb.ys)):
            na, nb = ca.names(sy), cb.names(sy)
            if na == nb:
                continue
            na = na or ['minecraft:air'] * 4096
            nb = nb or ['minecraft:air'] * 4096
            for i in range(4096):
                if na[i] != nb[i]:
                    out.add((cx * 16 + (i & 15), cz * 16 + ((i >> 4) & 15)))
        wa.release(cx, cz)
        wb.release(cx, cz)
    return out


def shade(c, dh):
    f = 1.0 + max(-3, min(3, dh)) * 0.08
    return tuple(max(0, min(255, int(v * f))) for v in c)


def render(world_path, out, scale=1, marks=None, diff=None):
    wa = W.World(world_path)
    tops = top_blocks(wa)
    changed = None
    if diff:
        wb = W.World(diff)
        changed = changed_columns(W.World(world_path), wb)
        tops = top_blocks(W.World(diff))
    if not tops:
        raise SystemExit('ブロックがありません')
    xs = [k[0] for k in tops]
    zs = [k[1] for k in tops]
    x0, x1, z0, z1 = min(xs), max(xs), min(zs), max(zs)
    img = Image((x1 - x0 + 1) * scale, (z1 - z0 + 1) * scale)
    unknown = {}
    for (x, z), (y, n) in tops.items():
        c = block_color(n)
        if c == UNKNOWN:
            unknown[n] = unknown.get(n, 0) + 1
        north = tops.get((x, z - 1))
        if north is not None:
            c = shade(c, y - north[0])
        if changed is not None:
            if (x, z) in changed:
                pass
            else:
                g = (c[0] * 3 + c[1] * 6 + c[2]) // 10
                g = 150 + g * 3 // 10   # 変わっていない列は明るい灰色に薄める
                c = (g, g, g)
        img.rect((x - x0) * scale, (z - z0) * scale, scale, c)
    for (mx, mz, label) in marks or []:
        px, pz = (mx - x0) * scale, (mz - z0) * scale
        for d in range(-4 * scale, 4 * scale + 1):
            img.set(px + d, pz, (255, 0, 0))
            img.set(px, pz + d, (255, 0, 0))
        if label:
            img.text(px + 3 * scale, pz + 3 * scale, label, (255, 255, 0), size=max(1, scale))
    img.save_png(out)
    info = {'columns': len(tops), 'size': (img.w, img.h), 'unknown_blocks': unknown}
    if changed is not None:
        info['changed_columns'] = len(changed)
    return info


def parse_marks(s):
    out = []
    if not s:
        return out
    for part in s.split(';'):
        part = part.strip()
        if not part:
            continue
        bits = part.split(',', 2)
        out.append((int(float(bits[0])), int(float(bits[1])), bits[2] if len(bits) > 2 else ''))
    return out


def main(argv=None):
    p = argparse.ArgumentParser(description='ワールドの真上からの PNG')
    p.add_argument('world')
    p.add_argument('--out', required=True)
    p.add_argument('--scale', type=int, default=1)
    p.add_argument('--marks', default=None, help='x,z,label;x,z,label ...')
    p.add_argument('--diff', default=None, help='比べるワールド(こちらの色で描き、違う列を明るくする)')
    a = p.parse_args(argv)
    info = render(a.world, a.out, a.scale, parse_marks(a.marks), a.diff)
    print(info)
    return info


if __name__ == '__main__':
    main()
