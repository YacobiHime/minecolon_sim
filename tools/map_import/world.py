"""ワールド(region フォルダ)を列単位で読み、ブロックを書き換える。

地面の検出(ground surface)もここに置く。方法は README.md の「地面の見つけ方」を参照。
"""
import glob
import os

import nbt_io
from nbt_io import Section

# 通り抜けられる・地面とみなさないブロック(空気、草花、飾り)。
# ここに入るものは「上が開いている」とみなす。
OPEN_EXACT = {
    'minecraft:air', 'minecraft:cave_air', 'minecraft:void_air',
    'minecraft:short_grass', 'minecraft:grass', 'minecraft:tall_grass',
    'minecraft:fern', 'minecraft:large_fern', 'minecraft:dead_bush',
    'minecraft:snow', 'minecraft:dandelion', 'minecraft:poppy',
    'minecraft:blue_orchid', 'minecraft:allium', 'minecraft:azure_bluet',
    'minecraft:oxeye_daisy', 'minecraft:cornflower', 'minecraft:lily_of_the_valley',
    'minecraft:lilac', 'minecraft:rose_bush', 'minecraft:peony', 'minecraft:sunflower',
    'minecraft:sweet_berry_bush', 'minecraft:sugar_cane', 'minecraft:vine',
    'minecraft:rail', 'minecraft:powered_rail', 'minecraft:detector_rail',
    'minecraft:activator_rail', 'minecraft:torch', 'minecraft:wall_torch',
    'minecraft:redstone_wire', 'minecraft:lever', 'minecraft:ladder',
    'minecraft:lily_pad', 'minecraft:seagrass', 'minecraft:tall_seagrass',
    'minecraft:kelp', 'minecraft:kelp_plant', 'minecraft:moss_carpet',
}
OPEN_SUFFIX = ('_carpet', '_tulip', '_sapling', '_button', '_pressure_plate',
               '_sign', '_banner', '_torch', '_mushroom', '_flower')
# 道路を塗った上に残すと不自然な草花(塗った列では消す)
PLANT_EXACT = {
    'minecraft:short_grass', 'minecraft:grass', 'minecraft:tall_grass',
    'minecraft:fern', 'minecraft:large_fern', 'minecraft:dead_bush',
    'minecraft:dandelion', 'minecraft:poppy', 'minecraft:blue_orchid',
    'minecraft:allium', 'minecraft:azure_bluet', 'minecraft:oxeye_daisy',
    'minecraft:cornflower', 'minecraft:lily_of_the_valley', 'minecraft:lilac',
    'minecraft:rose_bush', 'minecraft:peony', 'minecraft:sunflower',
    'minecraft:sweet_berry_bush',
}
PLANT_SUFFIX = ('_tulip', '_sapling')
WATER = {'minecraft:water', 'minecraft:bubble_column', 'minecraft:lava'}
BEDROCK = 'minecraft:bedrock'
AIR = {'minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'}


def is_open(name):
    return name in OPEN_EXACT or name in WATER or name.endswith(OPEN_SUFFIX)


def is_plant(name):
    return name in PLANT_EXACT or name.endswith(PLANT_SUFFIX)


class ChunkCtx:
    def __init__(self, region, lcx, lcz):
        self.region = region
        self.lcx, self.lcz = lcx, lcz
        self.nbt = region.get_chunk(lcx, lcz)
        self.sections = {}
        for s in self.nbt.get('sections', []):
            if 'block_states' in s:
                self.sections[int(s['Y'])] = Section(s)
        self.ys = sorted(self.sections)
        self.min_y = self.ys[0] * 16 if self.ys else -64
        self.max_y = self.ys[-1] * 16 + 15 if self.ys else -64
        self.dirty = False
        self._names = {}

    def names(self, sy):
        """セクション sy の 4096 個のブロック名(list)。空気だけなら None。"""
        if sy in self._names:
            return self._names[sy]
        s = self.sections.get(sy)
        if s is None:
            out = None
        elif len(s.palette) == 1:
            n = s.palette[0]['Name']
            out = None if n in AIR else [n] * 4096
        else:
            pn = [e['Name'] for e in s.palette]
            out = [pn[i] for i in s.indices]
        self._names[sy] = out
        return out

    def name_at(self, x, y, z):
        """x, z はチャンク内 0..15。"""
        arr = self.names(y >> 4)
        if arr is None:
            return 'minecraft:air'
        return arr[((y & 15) << 8) | (z << 4) | x]

    def set_state(self, x, y, z, state):
        s = self.sections.get(y >> 4)
        if s is None:
            raise ValueError('セクション Y=%d が無い' % (y >> 4))
        i = ((y & 15) << 8) | (z << 4) | x
        before = self.name_at(x, y, z)
        s.set_state(i, state)
        if s.dirty:
            self.dirty = True
            arr = self._names.get(y >> 4)
            if arr is None:
                self._names.pop(y >> 4, None)
            else:
                arr[i] = state['Name']
        return before

    def top_block(self, x, z):
        """一番上の空気でないブロック (y, name)。無ければ (None, None)。"""
        for sy in reversed(self.ys):
            arr = self.names(sy)
            if arr is None:
                continue
            base = (z << 4) | x
            for ly in range(15, -1, -1):
                n = arr[(ly << 8) | base]
                if n not in AIR:
                    return sy * 16 + ly, n
        return None, None

    def lowest_open_surface(self, x, z):
        """下から見て、地形の固体の連なりの一番上 (y, name, 上のブロック名)。

        岩盤とその上の空気(Arnis は y=-63 を空気にする)は飛ばし、
        最初の岩盤以外の固体から上へ、上が開く(is_open)まで登る。
        """
        y = self.min_y
        top = self.max_y
        # 岩盤・空気を飛ばす
        while y <= top:
            n = self.name_at(x, y, z)
            if n == BEDROCK or n in AIR:
                y += 1
                continue
            break
        if y > top:
            return None, None, None
        # 固体の連なりを登る
        cur = self.name_at(x, y, z)
        if is_open(cur):
            return None, None, cur
        while y < top:
            above = self.name_at(x, y + 1, z)
            if is_open(above):
                return y, cur, above
            y += 1
            cur = above
        return y, cur, 'minecraft:air'

    def commit(self):
        if not self.dirty:
            return False
        for s in self.sections.values():
            s.commit()
        self.region.set_chunk(self.lcx, self.lcz, self.nbt)
        self.dirty = False
        return True


class World:
    def __init__(self, path):
        self.path = path
        self.region_dir = os.path.join(path, 'region')
        self.regions = {}
        for p in glob.glob(os.path.join(self.region_dir, 'r.*.*.mca')):
            parts = os.path.basename(p).split('.')
            self.regions[(int(parts[1]), int(parts[2]))] = None
        self._chunks = {}

    def region(self, rx, rz):
        r = self.regions.get((rx, rz), 'missing')
        if r == 'missing':
            return None
        if r is None:
            r = nbt_io.RegionFile(os.path.join(self.region_dir, 'r.%d.%d.mca' % (rx, rz)))
            self.regions[(rx, rz)] = r
        return r

    def chunk(self, cx, cz):
        key = (cx, cz)
        if key in self._chunks:
            return self._chunks[key]
        r = self.region(cx >> 5, cz >> 5)
        ctx = None
        if r is not None and (cx & 31, cz & 31) in r.chunks:
            ctx = ChunkCtx(r, cx & 31, cz & 31)
        self._chunks[key] = ctx
        return ctx

    def all_chunk_coords(self):
        out = []
        for (rx, rz) in sorted(self.regions):
            r = self.region(rx, rz)
            for (lx, lz) in r.chunks:
                out.append((rx * 32 + lx, rz * 32 + lz))
        return sorted(out, key=lambda k: (k[1], k[0]))

    def release(self, cx, cz):
        """メモリ節約用: 変更の無いチャンクの解析結果を捨てる。"""
        c = self._chunks.get((cx, cz))
        if c is not None and not c.dirty:
            del self._chunks[(cx, cz)]

    def save(self):
        n = 0
        for c in self._chunks.values():
            if c is not None and c.commit():
                n += 1
        for r in self.regions.values():
            if r is not None and r.dirty:
                r.save()
        return n


# ---------------------------------------------------------------- 地面の検出

def column_surfaces(world):
    """全列の「下から見た固体の連なりの上端」を求める。

    返り値: dict (x, z) -> (y, surface_name, above_name)
    """
    out = {}
    for (cx, cz) in world.all_chunk_coords():
        c = world.chunk(cx, cz)
        bx, bz = cx * 16, cz * 16
        for z in range(16):
            for x in range(16):
                out[(bx + x, bz + z)] = c.lowest_open_surface(x, z)
        world.release(cx, cz)
    return out


def classify_ground(surf, radius=3, tol=2):
    """列ごとに地面かどうかを決める。

    surf[(x,z)] = (y, name, above)。y が近所(半径 radius の正方形)の
    最小値より tol を超えて高い列は、壁や塀などの構造物とみなして地面から外す。
    上が水の列も外す(water 集合で返す)。
    返り値: (ground: dict (x,z)->(y,name), water: set)
    """
    water = set()
    h = {}
    for k, (y, name, above) in surf.items():
        if y is None:
            continue
        if above in WATER or name in WATER:
            water.add(k)
            continue
        h[k] = y
    if not h:
        return {}, water
    xs = [k[0] for k in h]
    zs = [k[1] for k in h]
    x0, x1, z0, z1 = min(xs), max(xs), min(zs), max(zs)
    W = x1 - x0 + 1
    BIG = 10 ** 9
    # 水の列も「低い地面」として最小値の計算には入れる(岸の判定を安定させる)
    grid = {}
    for k, (y, name, above) in surf.items():
        if y is not None:
            grid[k] = y
    # 分離可能な最小値フィルタ(x 方向 → z 方向)
    rowmin = {}
    for z in range(z0, z1 + 1):
        row = [grid.get((x, z), BIG) for x in range(x0, x1 + 1)]
        for i in range(W):
            lo, hi = max(0, i - radius), min(W, i + radius + 1)
            rowmin[(x0 + i, z)] = min(row[lo:hi])
    ground = {}
    for (x, z), y in h.items():
        m = BIG
        for dz in range(-radius, radius + 1):
            v = rowmin.get((x, z + dz))
            if v is not None and v < m:
                m = v
        if y - m <= tol:
            ground[(x, z)] = (y, surf[(x, z)][1])
    return ground, water
