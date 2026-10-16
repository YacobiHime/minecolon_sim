"""Java HashMap の並びを再現し、getFirstPosForTag が返す groundlevel を回転ごとに求める。"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nbt
def i32(v): v &= 0xFFFFFFFF; return v - (1 << 32) if v >> 31 else v
def h(x, y, z): return i32(i32((y + z * 31) * 31) + x)
def order(keys):
    n = len(keys); cap = 16
    while n > cap * 0.75: cap *= 2
    def b(k):
        hh = h(*k) & 0xFFFFFFFF; return (hh ^ (hh >> 16)) & (cap - 1)
    return sorted(range(n), key=lambda i: (b(keys[i]), i))
ROT = {'NONE': lambda x, z: (x, z), 'CW90': lambda x, z: (-z, x), 'CW180': lambda x, z: (-x, -z), 'CCW90': lambda x, z: (z, -x)}
for p in sys.argv[1:]:
    d = nbt.load(p); po = d['optional_data']['structurize']['primary_offset']
    anchor = (po['x'], po['y'], po['z'])
    te = next(t for t in d['tile_entities'] if (t.get('x'), t.get('y'), t.get('z')) == anchor)
    ents = te['blueprintDataProvider']['posTagMap']
    res = {}
    for rn, rf in ROT.items():
        keys = []
        for e in ents:
            tp = e['tagPos']; x, z = rf(tp['x'], tp['z']); keys.append((x, tp['y'], z))
        for i in order(keys):
            if any(t.get('tagName') == 'groundlevel' for t in ents[i]['tagNameList']):
                res[rn] = po['y'] + keys[i][1] + 1; break
    print(os.path.basename(p), res)
