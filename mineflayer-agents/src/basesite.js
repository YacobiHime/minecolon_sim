'use strict';
// 拠点の様子 (観察): 拠点の近く (radius) に置かれている物の集まりを数える。何を置くかは誘導しない (見たままを書くだけ)。
//   拠点 = set_base の場所。なければ自分が最後にベッドかチェストを置いた所。
//   自然にあるブロック (地面・石・木・葉・草花・水など) は数えない。ベッド・ドアは2マスで1つ。壁の松明は松明に入れる。
//   明るさ (拠点の真ん中の光) と、囲まれているか (屋根と3方向以上の壁) も書く。
const { senseShelter } = require('./needs');

const NATURAL = /^(air|cave_air|void_air|water|lava|bedrock|dirt|grass_block|coarse_dirt|podzol|mycelium|rooted_dirt|mud|stone|deepslate|tuff|granite|diorite|andesite|calcite|sand|red_sand|gravel|clay|sandstone|red_sandstone|terracotta|.*_terracotta|snow|snow_block|ice|packed_ice|blue_ice|powder_snow|obsidian|magma_block|netherrack|soul_sand|soul_soil|.*_ore|raw_.*_block|.*_log|.*_wood|.*_leaves|mangrove_roots|muddy_mangrove_roots|grass|tall_grass|fern|large_fern|dead_bush|vine|glow_lichen|moss_block|moss_carpet|hanging_roots|azalea|flowering_azalea|seagrass|tall_seagrass|kelp|kelp_plant|sea_pickle|lily_pad|sugar_cane|cactus|bamboo|bamboo_sapling|pumpkin|melon|cocoa|sweet_berry_bush|brown_mushroom|red_mushroom|brown_mushroom_block|red_mushroom_block|mushroom_stem|cobweb|pointed_dripstone|dripstone_block|amethyst_block|budding_amethyst|.*amethyst_bud|amethyst_cluster|bubble_column|spore_blossom|big_dripleaf|big_dripleaf_stem|small_dripleaf|dandelion|poppy|blue_orchid|allium|azure_bluet|.*_tulip|oxeye_daisy|cornflower|lily_of_the_valley|sunflower|lilac|rose_bush|peony|pink_petals|.*_coral.*|sculk.*|smooth_basalt|basalt|blackstone)$/;
// まとめる名前: 2マスで1つの物・壁につけた物
const HALF = /(_bed|_door|tall_.*|large_fern)$/;
const MERGE = [[/^wall_torch$/, 'torch'], [/_wall_sign$/, (n) => n.replace('_wall_sign', '_sign')], [/^soul_wall_torch$/, 'soul_torch'], [/_wall_banner$/, (n) => n.replace('_wall_banner', '_banner')]];

function mergeName(n) {
  for (const [re, to] of MERGE) if (re.test(n)) return typeof to === 'function' ? to(n) : to;
  return n;
}

// blockAt(x,y,z) → { name, light?, skyLight?, boundingBox } | null
function baseSite(blockAt, center, { radius = 6, down = 2, up = 4, maxKinds = 8 } = {}) {
  if (!center) return null;
  const cx = Math.floor(center.x); const cy = Math.floor(center.y); const cz = Math.floor(center.z);
  const counts = {};
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dy = -down; dy <= up; dy++) {
        const b = blockAt(cx + dx, cy + dy, cz + dz);
        if (!b || !b.name || NATURAL.test(b.name)) continue;
        const n = mergeName(b.name);
        counts[n] = (counts[n] || 0) + 1;
      }
    }
  }
  for (const k of Object.keys(counts)) if (HALF.test(k)) counts[k] = Math.max(1, Math.round(counts[k] / 2));
  const mid = blockAt(cx, cy, cz) || blockAt(cx, cy + 1, cz);
  const light = mid && Number.isFinite(mid.light) ? mid.light : null;
  let shelter = null;
  try { shelter = senseShelter((x, y, z) => blockAt(x, y, z), center); } catch (_) { shelter = null; }
  const kinds = Object.entries(counts).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return { counts, kinds: kinds.slice(0, maxKinds), more: Math.max(0, kinds.length - maxKinds), light, enclosed: !!(shelter && shelter.enclosed), roof: !!(shelter && shelter.roof), walls: shelter ? shelter.walls : 0 };
}

// "拠点 (M1) の近く: chest 1、white_bed 1、torch 4、明るい、囲まれている"
function baseSiteText(site, { label = '拠点', dirText = null, near = true, darkBelow = 8 } = {}) {
  if (!site) return '';
  const items = site.kinds.length ? site.kinds.map(([k, n]) => `${k} ${n}`).join('、') + (site.more ? ` ほか${site.more}種` : '') : '置いた物なし';
  const extra = [];
  if (site.light != null) extra.push(site.light >= darkBelow ? '明るい' : '暗い');
  extra.push(site.enclosed ? '囲まれている' : site.roof ? '屋根あり' : '囲まれていない');
  if (near) return `${label}の近く: ${items}、${extra.join('、')}`;
  return `${label}${dirText ? ` (${dirText})` : ''} 前に見たとき: ${items}、${extra.join('、')}`;
}

// 英語 (Jev 用。同じ site から)。数は段階の言葉
function baseSiteTextEn(site, { label = 'base', near = true, where = null, darkBelow = 8 } = {}) {
  if (!site) return '';
  const { countWord } = require('./en');
  const items = site.kinds.length ? site.kinds.map(([k, n]) => `${k} (${countWord(n)})`).join(', ') + (site.more ? ', and more' : '') : 'nothing placed';
  const extra = [];
  if (site.light != null) extra.push(site.light >= darkBelow ? 'bright' : 'dark');
  extra.push(site.enclosed ? 'enclosed' : site.roof ? 'has a roof' : 'not enclosed');
  if (near) return `near ${label}: ${items}; ${extra.join(', ')}`;
  return `${label}${where ? ` (${where})` : ''}, when last seen: ${items}; ${extra.join(', ')}`;
}

module.exports = { baseSite, baseSiteText, baseSiteTextEn, NATURAL };
