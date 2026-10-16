"""設計図ごとに、地面の層の数と、地面の層の中の置き換えブロックの割合を数える。
使い方: python3 -I layers.py <blueprints_dir> <out.json> [--all-levels]"""
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nbt
def analyze(p):
    d = nbt.load(p)
    sx, sy, sz = d['size_x'], d['size_y'], d['size_z']
    po = d['optional_data']['structurize']['primary_offset']
    names = [e.get('Name', '') for e in d['palette']]
    sh = []
    for v in d['blocks']:
        sh.append((v >> 16) & 0xFFFF); sh.append(v & 0xFFFF)
    gl = None
    for te in d.get('tile_entities', []):
        bp = te.get('blueprintDataProvider')
        if not bp: continue
        for e in bp.get('posTagMap', []):
            if any(t.get('tagName') == 'groundlevel' for t in e.get('tagNameList', [])):
                gl = e['tagPos']['y']; break
    # タグがないときは、ビルドツールの既定（地面はアンカーの1つ下。AbstractBlueprintManipulationWindow の GROUNDSTYLE_RELATIVE）
    n = po['y'] + gl + 1 if gl is not None else po['y']
    solid_layers = sorted({y for y in range(sy) for i in range(sx * sz) if names[sh[y * sx * sz + i]].endswith('blocksolidsubstitution')})
    cnt = {'solid': 0, 'subst': 0, 'air': 0, 'other': 0}
    if n:
        for y in range(min(n, sy)):
            for i in range(sx * sz):
                nm = names[sh[y * sx * sz + i]]
                if nm.endswith('blocksolidsubstitution'): cnt['solid'] += 1
                elif nm.endswith('blocksubstitution'): cnt['subst'] += 1
                elif nm.endswith('air'): cnt['air'] += 1
                else: cnt['other'] += 1
    tot = sum(cnt.values()) or 1
    return {'size': [sx, sy, sz], 'primary_offset_y': po['y'], 'groundlevel_y': gl,
            'ground_layers': n, 'tagged': gl is not None, 'solid_layers': solid_layers, **cnt, 'solid_ratio': round(cnt['solid'] / tot, 2),
            'subst_ratio': round(cnt['subst'] / tot, 2)}
root, out = sys.argv[1], sys.argv[2]
alllv = '--all-levels' in sys.argv
res = {}
for dp, _, fs in os.walk(root):
    for f in sorted(fs):
        if not f.endswith('.blueprint'): continue
        if not alllv and not f.endswith('1.blueprint'): continue
        rel = os.path.relpath(os.path.join(dp, f), root)
        try: res[rel] = analyze(os.path.join(dp, f))
        except Exception as e: res[rel] = {'error': repr(e)}
json.dump(res, open(out, 'w'), ensure_ascii=False, indent=1, sort_keys=True)
