"""OSM(Overpass の `out geom tags` JSON)の読み込み・取得と、ブロック座標への変換・塗り。"""
import json
import math
import os
import time
import urllib.error
import urllib.parse
import urllib.request

OVERPASS_URL = 'https://overpass-api.de/api/interpreter'
USER_AGENT = 'minecolon_sim-map_import/0.1 (+https://github.com/YacobiHime/minecolon_sim)'

FOOTWAY_CLASSES = {'footway', 'steps', 'pedestrian', 'path', 'cycleway', 'bridleway', 'corridor'}
CENTERLINE_CLASSES = {'primary', 'secondary', 'tertiary', 'primary_link', 'secondary_link',
                      'tertiary_link', 'trunk', 'trunk_link', 'motorway', 'motorway_link'}
SIDEWALK_CLASSES = CENTERLINE_CLASSES

# 道路の幅(メートル)。--road-widths で JSON を渡すと上書きできる
DEFAULT_WIDTHS = {
    'motorway': 12, 'trunk': 12, 'primary': 10, 'secondary': 8, 'tertiary': 7,
    'motorway_link': 6, 'trunk_link': 6, 'primary_link': 6, 'secondary_link': 6,
    'tertiary_link': 5, 'unclassified': 5, 'residential': 5, 'living_street': 4,
    'road': 5, 'service': 3, 'track': 3,
    'footway': 2, 'pedestrian': 3, 'path': 2, 'steps': 2, 'cycleway': 2,
    'bridleway': 2, 'corridor': 2,
    '*': 3,
}
LANE_WIDTH_M = 3.0


class GeoMap:
    """metadata.json(Arnis)に従って緯度経度をブロック座標にする。北が z の小さい側。"""

    def __init__(self, meta):
        self.m = meta
        self.min_lat, self.max_lat = meta['minGeoLat'], meta['maxGeoLat']
        self.min_lon, self.max_lon = meta['minGeoLon'], meta['maxGeoLon']
        self.x0, self.x1 = meta.get('minMcX', 0), meta['maxMcX']
        self.z0, self.z1 = meta.get('minMcZ', 0), meta['maxMcZ']
        lat_c = math.radians((self.min_lat + self.max_lat) / 2)
        mx = (self.max_lon - self.min_lon) * 111320.0 * math.cos(lat_c)
        mz = (self.max_lat - self.min_lat) * 110574.0
        # 1 メートルあたりのブロック数(x, z の平均)
        self.blocks_per_m = ((self.x1 - self.x0) / mx + (self.z1 - self.z0) / mz) / 2

    @classmethod
    def from_world(cls, world_path):
        with open(os.path.join(world_path, 'metadata.json')) as f:
            return cls(json.load(f))

    def to_block(self, lat, lon):
        x = self.x0 + (lon - self.min_lon) / (self.max_lon - self.min_lon) * (self.x1 - self.x0)
        z = self.z0 + (self.max_lat - lat) / (self.max_lat - self.min_lat) * (self.z1 - self.z0)
        return x, z

    def bbox(self):
        return self.min_lat, self.min_lon, self.max_lat, self.max_lon

    def in_area(self, x, z):
        return self.x0 <= x <= self.x1 and self.z0 <= z <= self.z1


def fetch_overpass(kind, bbox, path, timeout=120, retries=4):
    """Overpass から取ってファイルに保存する。kind は 'highway' か 'building'。"""
    s, w, n, e = bbox
    b = '%.7f,%.7f,%.7f,%.7f' % (s, w, n, e)
    if kind == 'highway':
        q = '[out:json][timeout:90];way["highway"](%s);out geom tags;' % b
    elif kind == 'building':
        q = ('[out:json][timeout:90];(way["building"](%s);relation["building"](%s););'
             'out geom tags;' % (b, b))
    else:
        raise ValueError(kind)
    data = urllib.parse.urlencode({'data': q}).encode()
    body = None
    for attempt in range(retries):
        req = urllib.request.Request(OVERPASS_URL, data=data, headers={'User-Agent': USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = r.read()
            break
        except urllib.error.HTTPError as e:
            # 混んでいるとき(429/502/503/504)は待ってやり直す
            if e.code not in (429, 502, 503, 504) or attempt == retries - 1:
                raise SystemExit('Overpass の取得に失敗しました (%s): HTTP %d' % (kind, e.code))
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt == retries - 1:
                raise SystemExit('Overpass の取得に失敗しました (%s): %s' % (kind, e))
        time.sleep(10 * (attempt + 1))
    json.loads(body)  # 壊れていないか確かめてから保存
    d = os.path.dirname(os.path.abspath(path))
    os.makedirs(d, exist_ok=True)
    with open(path, 'wb') as f:
        f.write(body)
    return path


def load_json(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


# ---------------------------------------------------------------- 道路

def parse_width_m(tags, widths):
    """幅(メートル)。width タグ > lanes タグ×3.0m > 種別の表。"""
    w = tags.get('width')
    if w:
        try:
            v = float(w.replace('m', '').replace(',', '.').strip().split()[0])
            if 0.5 <= v <= 60:
                return v
        except (ValueError, IndexError):
            pass
    lanes = tags.get('lanes')
    if lanes:
        try:
            n = float(lanes.split(';')[0])
            if 0 < n <= 12:
                return n * LANE_WIDTH_M
        except ValueError:
            pass
    hw = tags.get('highway', '')
    return float(widths.get(hw, widths.get('*', 3)))


def highway_ways(osm, include_footways=False, include_bridges=False):
    """塗る対象の道路の way を返す。橋・トンネルは既定で外す(地面に塗ると位置が違う)。"""
    out = []
    for e in osm.get('elements', []):
        if e.get('type') != 'way' or 'geometry' not in e:
            continue
        t = e.get('tags', {})
        hw = t.get('highway')
        if not hw or hw in ('proposed', 'construction', 'platform', 'elevator', 'bus_stop'):
            continue
        if t.get('area') == 'yes':
            continue
        if hw in FOOTWAY_CLASSES and not include_footways:
            continue
        if not include_bridges and (t.get('bridge', 'no') != 'no' or t.get('tunnel', 'no') != 'no'
                                    or t.get('covered') == 'yes'):
            continue
        out.append(e)
    return out


def _seg_dist(px, pz, ax, az, bx, bz):
    """点と線分の距離と、線分上の位置 t(0..1)。"""
    dx, dz = bx - ax, bz - az
    L2 = dx * dx + dz * dz
    if L2 == 0:
        return math.hypot(px - ax, pz - az), 0.0
    t = ((px - ax) * dx + (pz - az) * dz) / L2
    t = 0.0 if t < 0 else (1.0 if t > 1 else t)
    cx, cz = ax + t * dx, az + t * dz
    return math.hypot(px - cx, pz - cz), t


def way_points(geo, way):
    return [geo.to_block(p['lat'], p['lon']) for p in way['geometry'] if p is not None]


def rasterize_way(pts, half_w, extra=0.0):
    """列 (x,z) -> (中心線からの距離, 先頭からの道のり)。距離 <= half_w + extra の列だけ。"""
    out = {}
    r = half_w + extra
    along = 0.0
    for i in range(len(pts) - 1):
        (ax, az), (bx, bz) = pts[i], pts[i + 1]
        seg_len = math.hypot(bx - ax, bz - az)
        xmin = int(math.floor(min(ax, bx) - r - 1))
        xmax = int(math.ceil(max(ax, bx) + r + 1))
        zmin = int(math.floor(min(az, bz) - r - 1))
        zmax = int(math.ceil(max(az, bz) + r + 1))
        for z in range(zmin, zmax + 1):
            pz = z + 0.5
            for x in range(xmin, xmax + 1):
                d, t = _seg_dist(x + 0.5, pz, ax, az, bx, bz)
                if d <= r:
                    s = along + t * seg_len
                    old = out.get((x, z))
                    if old is None or d < old[0]:
                        out[(x, z)] = (d, s)
        along += seg_len
    return out


# ---------------------------------------------------------------- 建物

def _rings(e):
    """建物の外周・内周 (outer: list[pts], inner: list[pts])。座標は緯度経度。"""
    if e['type'] == 'way' and 'geometry' in e:
        return [e['geometry']], []
    outer, inner = [], []
    if e['type'] == 'relation':
        for m in e.get('members', []):
            if m.get('type') != 'way' or not m.get('geometry'):
                continue
            (inner if m.get('role') == 'inner' else outer).append(m['geometry'])
    return outer, inner


def _fill_polygon(pts):
    """列の中心が多角形の中にある列 + 辺が通る列。"""
    cells = set()
    n = len(pts)
    if n < 3:
        return cells
    zs = [p[1] for p in pts]
    zmin, zmax = int(math.floor(min(zs))), int(math.ceil(max(zs)))
    for z in range(zmin, zmax + 1):
        pz = z + 0.5
        xs = []
        for i in range(n):
            (ax, az), (bx, bz) = pts[i], pts[(i + 1) % n]
            if (az <= pz < bz) or (bz <= pz < az):
                xs.append(ax + (pz - az) * (bx - ax) / (bz - az))
        xs.sort()
        for i in range(0, len(xs) - 1, 2):
            for x in range(int(math.ceil(xs[i] - 0.5)), int(math.floor(xs[i + 1] - 0.5)) + 1):
                cells.add((x, z))
    return cells


def _edge_cells(pts):
    cells = set()
    n = len(pts)
    for i in range(n):
        (ax, az), (bx, bz) = pts[i], pts[(i + 1) % n]
        steps = max(1, int(math.hypot(bx - ax, bz - az) * 4))
        for k in range(steps + 1):
            t = k / steps
            cells.add((int(math.floor(ax + t * (bx - ax))), int(math.floor(az + t * (bz - az)))))
    return cells


def building_cells(geo, osm):
    """OSM の建物の敷地(外周の辺を含む)にかかる列の集合。"""
    cells = set()
    for e in osm.get('elements', []):
        t = e.get('tags', {})
        if 'building' not in t and 'building:part' not in t:
            continue
        outer, inner = _rings(e)
        for ring in outer:
            pts = [geo.to_block(p['lat'], p['lon']) for p in ring if p is not None]
            cells |= _fill_polygon(pts) | _edge_cells(pts)
        for ring in inner:
            pts = [geo.to_block(p['lat'], p['lon']) for p in ring if p is not None]
            cells -= _fill_polygon(pts) - _edge_cells(pts)
    return cells
