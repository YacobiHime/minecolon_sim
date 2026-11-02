"""arnis_post.py / nbt_io.py / map_preview.py のテスト(標準ライブラリの unittest)。

  cd tools/map_import && python3 -I -m unittest -v

サンプルのワールド(既定 /root/mc-server-forge/arnis_out/Arnis World 1、
環境変数 ARNIS_SAMPLE_WORLD で変更)が無ければ、ワールドを使うテストは飛ばす。
サンプルは読むだけで、書き換えは一時フォルダのコピーに対して行う。
"""
import array
import hashlib
import io
import contextlib
import os
import random
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import arnis_post  # noqa: E402
import map_preview  # noqa: E402
import nbt_io  # noqa: E402
import osm  # noqa: E402
import world as W  # noqa: E402
from nbt_io import Compound, NBTList, make_state  # noqa: E402

SAMPLE = os.environ.get('ARNIS_SAMPLE_WORLD', '/root/mc-server-forge/arnis_out/Arnis World 1')
HW = os.path.join(HERE, 'testdata', 'highways.json')
BD = os.path.join(HERE, 'testdata', 'buildings.json')
HAVE_SAMPLE = os.path.isfile(os.path.join(SAMPLE, 'region', 'r.0.0.mca'))


def tree_hash(path):
    h = hashlib.sha256()
    for root, dirs, files in sorted(os.walk(path)):
        dirs.sort()
        for f in sorted(files):
            p = os.path.join(root, f)
            h.update(os.path.relpath(p, path).encode())
            with open(p, 'rb') as fh:
                h.update(fh.read())
    return h.hexdigest()


class TestNBT(unittest.TestCase):
    def test_all_tag_types_roundtrip(self):
        c = Compound()
        c['b'] = nbt_io.Byte(-5)
        c['s'] = nbt_io.Short(1234)
        c['i'] = nbt_io.Int(-70000)
        c['l'] = nbt_io.Long(-(1 << 60))
        c['f'] = nbt_io.Float(0.1)
        c['d'] = nbt_io.Double(3.14159)
        c['ba'] = bytes([0, 1, 255])
        c['str'] = 'あいう\x00😀'
        c['ia'] = array.array('i', [1, -2, 3])
        c['la'] = array.array('q', [1 << 62, -1])
        c['empty'] = NBTList(elem_type=nbt_io.TAG_END)
        c['emptyc'] = NBTList(elem_type=nbt_io.TAG_COMPOUND)
        c['lst'] = NBTList([NBTList([nbt_io.Int(1)], nbt_io.TAG_INT)], nbt_io.TAG_LIST)
        c['nested'] = Compound(x=Compound(y='z'))
        raw = nbt_io.dumps(c, 'root')
        name, back = nbt_io.loads(raw)
        self.assertEqual(name, 'root')
        self.assertEqual(nbt_io.dumps(back, name), raw)
        self.assertEqual(back['str'], c['str'])
        self.assertEqual(nbt_io.tag_type_of(back['emptyc']), nbt_io.TAG_LIST)
        self.assertEqual(back['emptyc'].elem_type, nbt_io.TAG_COMPOUND)
        # Modified UTF-8: NUL は C0 80
        self.assertIn(b'\xc0\x80', raw)

    @unittest.skipUnless(HAVE_SAMPLE, 'サンプルのワールドが無い')
    def test_real_chunks_byte_identical(self):
        r = nbt_io.RegionFile(os.path.join(SAMPLE, 'region', 'r.0.0.mca'))
        self.assertEqual(len(r.chunks), 1024)
        for k in r.chunks:
            raw = r.raw_chunk(*k)
            self.assertEqual(nbt_io.dumps(nbt_io.loads(raw)[1]), raw, k)

    @unittest.skipUnless(HAVE_SAMPLE, 'サンプルのワールドが無い')
    def test_level_dat_roundtrip(self):
        with open(os.path.join(SAMPLE, 'level.dat'), 'rb') as f:
            import gzip
            raw = gzip.decompress(f.read())
        name, v = nbt_io.loads(raw)
        self.assertEqual(nbt_io.dumps(v, name), raw)

    @unittest.skipUnless(HAVE_SAMPLE, 'サンプルのワールドが無い')
    def test_region_rewrite_keeps_chunks(self):
        with tempfile.TemporaryDirectory() as td:
            p = os.path.join(td, 'r.0.0.mca')
            shutil.copy(os.path.join(SAMPLE, 'region', 'r.0.0.mca'), p)
            r = nbt_io.RegionFile(p)
            c = r.get_chunk(3, 4)
            r.set_chunk(3, 4, c, timestamp=12345)
            r.save()
            r2 = nbt_io.RegionFile(p)
            orig = nbt_io.RegionFile(os.path.join(SAMPLE, 'region', 'r.0.0.mca'))
            self.assertEqual(set(r2.chunks), set(orig.chunks))
            for k in orig.chunks:
                self.assertEqual(r2.raw_chunk(*k), orig.raw_chunk(*k), k)
            self.assertEqual(r2.chunks[(3, 4)][2], 12345)
            self.assertEqual(os.path.getsize(p) % 4096, 0)


class TestBlockStates(unittest.TestCase):
    def test_bits(self):
        self.assertEqual(nbt_io.bits_for_palette(2), 4)
        self.assertEqual(nbt_io.bits_for_palette(16), 4)
        self.assertEqual(nbt_io.bits_for_palette(17), 5)
        self.assertEqual(nbt_io.bits_for_palette(33), 6)
        self.assertEqual(nbt_io.bits_for_palette(256), 8)
        self.assertEqual(nbt_io.bits_for_palette(257), 9)

    def test_encode_decode_roundtrip(self):
        rnd = random.Random(1)
        for n in (2, 3, 16, 17, 31, 32, 33, 64, 65, 200, 300, 600):
            idx = [rnd.randrange(n) for _ in range(4096)]
            data = nbt_io.encode_states(idx, n)
            bits = nbt_io.bits_for_palette(n)
            self.assertEqual(len(data), -(-4096 // (64 // bits)), n)
            self.assertEqual(nbt_io.decode_states(n, data), idx, n)
        self.assertIsNone(nbt_io.encode_states([0] * 4096, 1))

    def test_packing_does_not_span_longs(self):
        # 5 ビット: 1 long に 12 個、上の 4 ビットは空き
        idx = [31] * 4096
        data = nbt_io.encode_states(idx, 32)
        self.assertEqual(data[0] & 0xFFFFFFFFFFFFFFFF, (1 << 60) - 1)

    @unittest.skipUnless(HAVE_SAMPLE, 'サンプルのワールドが無い')
    def test_real_sections_reencode_identical(self):
        r = nbt_io.RegionFile(os.path.join(SAMPLE, 'region', 'r.0.0.mca'))
        n = 0
        for k in list(r.chunks)[:200]:
            for s in r.get_chunk(*k)['sections']:
                bs = s['block_states']
                if 'data' not in bs:
                    continue
                idx = nbt_io.decode_states(len(bs['palette']), bs['data'])
                self.assertEqual(list(nbt_io.encode_states(idx, len(bs['palette']))), list(bs['data']))
                n += 1
        self.assertGreater(n, 0)

    def test_repalette(self):
        pal = NBTList([make_state('minecraft:air'), make_state('minecraft:stone'),
                       make_state('minecraft:dirt'), make_state('minecraft:stone')],
                      nbt_io.TAG_COMPOUND)
        idx = [0, 1, 3, 3, 0]
        newpal, newidx = nbt_io.repalette(pal, idx)
        self.assertEqual([e['Name'] for e in newpal], ['minecraft:air', 'minecraft:stone'])
        self.assertEqual(newidx, [0, 1, 1, 1, 0])

    def test_section_commit_single_entry_drops_data(self):
        pal = NBTList([make_state('minecraft:air'), make_state('minecraft:stone')], nbt_io.TAG_COMPOUND)
        idx = [0] * 4096
        idx[5] = 1
        sec = Compound(Y=nbt_io.Byte(0), block_states=Compound(palette=pal, data=nbt_io.encode_states(idx, 2)))
        s = nbt_io.Section(sec)
        s.set_state(5, make_state('minecraft:air'))
        self.assertTrue(s.commit())
        self.assertEqual(len(sec['block_states']['palette']), 1)
        self.assertNotIn('data', sec['block_states'])
        # 新しいブロックを足すとパレットが増え、ビット数が上がる
        s2 = nbt_io.Section(sec)
        for i in range(17):
            s2.set_state(i, make_state('minecraft:wool_%d' % i))
        s2.commit()
        bs = sec['block_states']
        self.assertEqual(len(bs['palette']), 18)
        self.assertEqual(len(bs['data']), -(-4096 // (64 // 5)))
        back = nbt_io.decode_states(18, bs['data'])
        self.assertEqual(bs['palette'][back[16]]['Name'], 'minecraft:wool_16')
        self.assertEqual(bs['palette'][back[100]]['Name'], 'minecraft:air')


@unittest.skipUnless(HAVE_SAMPLE, 'サンプルのワールドが無い')
class TestOnSample(unittest.TestCase):
    """サンプルのコピーに各操作をかけて確かめる。"""

    @classmethod
    def setUpClass(cls):
        cls.td = tempfile.mkdtemp(prefix='arnis_post_test_')
        cls.src_hash = tree_hash(SAMPLE)
        cls.geo = osm.GeoMap.from_world(SAMPLE)
        cls.bld = osm.building_cells(cls.geo, osm.load_json(BD))
        orig = W.World(SAMPLE)
        cls.surf = W.column_surfaces(orig)
        cls.ground, cls.water = W.classify_ground(cls.surf)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.td, ignore_errors=True)
        assert tree_hash(SAMPLE) == cls.src_hash, '--in が書き換わった'

    def run_tool(self, name, *extra):
        out = os.path.join(self.td, name)
        argv = ['--in', SAMPLE, '--out', out, '--force', '--osm-highways', HW, '--osm-buildings', BD]
        argv += list(extra)
        with contextlib.redirect_stderr(io.StringIO()):
            stats = arnis_post.main(argv)
        return out, stats

    def changed(self, out):
        return map_preview.changed_columns(W.World(SAMPLE), W.World(out))

    def assert_region_parses(self, out):
        r = nbt_io.RegionFile(os.path.join(out, 'region', 'r.0.0.mca'))
        self.assertEqual(len(r.chunks), 1024)
        for k in r.chunks:
            c = r.get_chunk(*k)
            for s in c['sections']:
                bs = s['block_states']
                n = len(bs['palette'])
                if n == 1:
                    self.assertNotIn('data', bs)
                else:
                    idx = nbt_io.decode_states(n, bs['data'])
                    self.assertEqual(len(set(idx)), n, '使っていないパレット項目が残っている %r' % (k,))

    def test_refuse_existing_out(self):
        out = os.path.join(self.td, 'exists')
        os.makedirs(out)
        with self.assertRaises(SystemExit):
            arnis_post.main(['--in', SAMPLE, '--out', out])
        with self.assertRaises(SystemExit):
            arnis_post.main(['--in', SAMPLE, '--out', os.path.join(SAMPLE, 'x')])

    def test_fix_renames(self):
        out, stats = self.run_tool('renames', '--fix-renames')
        self.assertGreater(stats['renames']['blocks'], 0)
        r = nbt_io.RegionFile(os.path.join(out, 'region', 'r.0.0.mca'))
        n_grass = 0
        for k in r.chunks:
            for s in r.get_chunk(*k)['sections']:
                names = [e['Name'] for e in s['block_states']['palette']]
                self.assertNotIn('minecraft:short_grass', names)
                n_grass += names.count('minecraft:grass')
        self.assertGreater(n_grass, 0)
        # 改名だけなので、変わった列は元が short_grass の列だけ
        orig = W.World(SAMPLE)
        for (x, z) in list(self.changed(out))[:300]:
            c = orig.chunk(x >> 4, z >> 4)
            col = [c.name_at(x & 15, y, z & 15) for y in range(c.min_y, c.max_y + 1)]
            self.assertIn('minecraft:short_grass', col)
        self.assert_region_parses(out)

    def test_roads_recolor(self):
        out, stats = self.run_tool('recolor', '--roads', 'recolor')
        n = stats['roads_recolor']['changed_columns']
        self.assertGreater(n, 1000)
        ch = self.changed(out)
        self.assertEqual(len(ch), n)          # 変わった列 = 数えた列(ほかの列は全く同じ)
        self.assertFalse(ch & self.bld)       # 建物の敷地の中は変えない
        a, b = W.World(SAMPLE), W.World(out)
        for (x, z) in ch:
            y, name = self.ground[(x, z)]
            self.assertIn(name, arnis_post.DEFAULT_ROAD_SURFACE)
            ca, cb = a.chunk(x >> 4, z >> 4), b.chunk(x >> 4, z >> 4)
            self.assertEqual(cb.name_at(x & 15, y, z & 15), 'minecraft:black_concrete')
            for yy in range(ca.min_y, ca.max_y + 1):   # その列でも地面の 1 個しか変えない
                if yy != y:
                    self.assertEqual(ca.name_at(x & 15, yy, z & 15), cb.name_at(x & 15, yy, z & 15))
        self.assert_region_parses(out)

    def test_roads_redraw_lands_on_ground(self):
        out, stats = self.run_tool('redraw', '--roads', 'redraw', '--sidewalk', 'minecraft:smooth_stone')
        s = stats['roads_redraw']
        self.assertGreater(s['carriageway'], 1000)
        self.assertGreater(s['center_line'], 0)
        self.assertGreater(s['sidewalk'], 0)
        ch = self.changed(out)
        self.assertFalse(ch & self.bld)
        self.assertFalse(ch & self.water)
        b = W.World(out)
        painted = {'minecraft:black_concrete', 'minecraft:white_concrete', 'minecraft:smooth_stone'}
        for (x, z) in ch:
            y, _ = self.ground[(x, z)]
            c = b.chunk(x >> 4, z >> 4)
            self.assertIn(c.name_at(x & 15, y, z & 15), painted)
            # 地面に載っている: 下は地形の固体、上は開いている(屋根や橋の上ではない)
            self.assertFalse(W.is_open(c.name_at(x & 15, y - 1, z & 15)))
            self.assertTrue(W.is_open(c.name_at(x & 15, y + 1, z & 15)))
            # 近所の地面より高くない
            near = [self.ground[(x + dx, z + dz)][0] for dx in range(-3, 4) for dz in range(-3, 4)
                    if (x + dx, z + dz) in self.ground]
            self.assertLessEqual(y - min(near), 2)
        # WORLD_SURFACE の高さが一番上のブロックと合っている(草を消した列も)
        for (x, z) in list(ch)[:2000]:
            c = b.chunk(x >> 4, z >> 4)
            vals = nbt_io.decode_states(512, c.nbt['Heightmaps']['WORLD_SURFACE'], 256, min_bits=1)
            ty, _ = c.top_block(x & 15, z & 15)
            self.assertEqual(vals[(z & 15) * 16 + (x & 15)], ty + 1 - c.min_y)
        self.assert_region_parses(out)

    def test_ground_lighten_and_grass(self):
        for mode, block in (('lighten', 'minecraft:smooth_stone'), ('grass', 'minecraft:grass_block')):
            out, stats = self.run_tool('ground_' + mode, '--ground', mode)
            n = stats['ground_' + mode]['changed_columns']
            self.assertGreater(n, 1000)
            ch = self.changed(out)
            self.assertEqual(len(ch), n)
            self.assertFalse(ch & self.bld)
            b = W.World(out)
            for (x, z) in list(ch)[:3000]:
                y, name = self.ground[(x, z)]
                self.assertIn(name, arnis_post.DEFAULT_URBAN_FILL)
                self.assertEqual(b.chunk(x >> 4, z >> 4).name_at(x & 15, y, z & 15), block)
            self.assert_region_parses(out)

    def test_combined_and_dataversion(self):
        out, stats = self.run_tool('all', '--fix-renames', '--roads', 'redraw', '--ground', 'grass',
                                   '--set-dataversion', '3465')
        self.assertIn('roads_redraw', stats)
        self.assertIn('ground_grass', stats)
        _, lv, gz = nbt_io.load_file(os.path.join(out, 'level.dat'))
        self.assertTrue(gz)
        self.assertEqual(int(lv['Data']['DataVersion']), 3465)
        self.assertEqual(lv['Data']['Version']['Name'], '1.20.1')
        self.assertEqual(int(lv['Data']['Version']['Id']), 3465)
        r = nbt_io.RegionFile(os.path.join(out, 'region', 'r.0.0.mca'))
        for k in r.chunks:
            self.assertEqual(int(r.get_chunk(*k)['DataVersion']), 3465)
        self.assert_region_parses(out)

    def test_preview_png(self):
        p = os.path.join(self.td, 'p.png')
        info = map_preview.render(SAMPLE, p, scale=1, marks=[(10, 10, 'A1')])
        self.assertEqual(info['size'], (500, 500))
        self.assertEqual(info['unknown_blocks'], {})
        with open(p, 'rb') as f:
            self.assertEqual(f.read(8), b'\x89PNG\r\n\x1a\n')


class TestOSM(unittest.TestCase):
    def test_width(self):
        w = osm.DEFAULT_WIDTHS
        self.assertEqual(osm.parse_width_m({'highway': 'primary', 'lanes': '2'}, w), 6.0)
        self.assertEqual(osm.parse_width_m({'highway': 'primary', 'width': '7.5 m'}, w), 7.5)
        self.assertEqual(osm.parse_width_m({'highway': 'service'}, w), 3.0)

    def test_geo_mapping(self):
        g = osm.GeoMap({'minMcX': 0, 'maxMcX': 499, 'minMcZ': 0, 'maxMcZ': 499,
                        'minGeoLat': 38.92464, 'maxGeoLat': 38.92913,
                        'minGeoLon': 141.13601, 'maxGeoLon': 141.14179})
        self.assertEqual(g.to_block(38.92913, 141.13601), (0.0, 0.0))   # 北西の角
        x, z = g.to_block(38.92464, 141.14179)
        self.assertAlmostEqual(x, 499)
        self.assertAlmostEqual(z, 499)
        self.assertAlmostEqual(g.blocks_per_m, 1.0, delta=0.05)

    def test_polygon_fill(self):
        cells = osm._fill_polygon([(0, 0), (10, 0), (10, 10), (0, 10)])
        self.assertEqual(len(cells), 100)


if __name__ == '__main__':
    unittest.main()
