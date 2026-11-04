'use strict';
// アイテムの日本語名 (2B に見せるゴールの候補の説明に使う)。名前そのものだけ (使い方・良し悪しは書かない)
const WOOD = { oak: 'オーク', spruce: 'トウヒ', birch: 'シラカバ', jungle: 'ジャングル', acacia: 'アカシア', dark_oak: 'ダークオーク', mangrove: 'マングローブ', cherry: 'サクラ', bamboo: '竹', crimson: '真紅', warped: '歪んだ' };
const COLOR = { white: '白', orange: '橙', magenta: '赤紫', light_blue: '空色', yellow: '黄', lime: '黄緑', pink: '桃', gray: '灰', light_gray: '薄灰', cyan: '青緑', purple: '紫', blue: '青', brown: '茶', green: '緑', red: '赤', black: '黒' };
const MAT = { wooden: '木の', stone: '石の', iron: '鉄の', golden: '金の', diamond: 'ダイヤの', netherite: 'ネザライトの', leather: '革の', chainmail: 'チェーンの' };
const SUFFIX = [
  ['_log', '原木'], ['_planks', '板材'], ['_bed', 'ベッド'], ['_wool', '羊毛'], ['_door', 'ドア'], ['_trapdoor', 'トラップドア'], ['_fence_gate', '柵のゲート'], ['_fence', '柵'],
  ['_sapling', '苗木'], ['_leaves', '葉'], ['_slab', 'ハーフブロック'], ['_stairs', '階段'], ['_boat', 'ボート'], ['_sign', '看板'], ['_carpet', 'カーペット'], ['_banner', '旗'],
  ['_pressure_plate', '感圧板'], ['_button', 'ボタン'], ['_dye', '染料'], ['_wood', '木'],
  ['_pickaxe', 'ツルハシ'], ['_axe', '斧'], ['_shovel', 'シャベル'], ['_hoe', 'クワ'], ['_sword', '剣'],
  ['_helmet', 'ヘルメット'], ['_chestplate', 'チェストプレート'], ['_leggings', 'レギンス'], ['_boots', 'ブーツ'],
];
const DIRECT = {
  stick: '棒', crafting_table: '作業台', furnace: 'かまど', chest: 'チェスト', barrel: '樽', torch: '松明', lantern: 'ランタン', campfire: '焚き火',
  cobblestone: '丸石', stone: '石', coal: '石炭', charcoal: '木炭', raw_iron: '鉄の原石', iron_ingot: '鉄インゴット', raw_gold: '金の原石', gold_ingot: '金インゴット',
  raw_copper: '銅の原石', copper_ingot: '銅インゴット', diamond: 'ダイヤモンド', flint: '火打石', flint_and_steel: '火打石と打ち金', sand: '砂', gravel: '砂利', glass: 'ガラス', clay_ball: '粘土玉', brick: 'レンガ',
  beef: '生の牛肉', cooked_beef: 'ステーキ', porkchop: '生の豚肉', cooked_porkchop: '焼き豚', mutton: '生の羊肉', cooked_mutton: '焼き羊肉', chicken: '生の鶏肉', cooked_chicken: '焼き鳥',
  rabbit: '生の兎肉', cooked_rabbit: '焼き兎肉', cod: '生のタラ', cooked_cod: '焼きタラ', salmon: '生の鮭', cooked_salmon: '焼き鮭', potato: 'ジャガイモ', baked_potato: 'ベイクドポテト',
  carrot: 'ニンジン', apple: 'リンゴ', bread: 'パン', wheat: '小麦', wheat_seeds: '小麦の種', sweet_berries: 'スイートベリー', melon_slice: 'スイカの薄切り', pumpkin: 'カボチャ', pumpkin_pie: 'パンプキンパイ',
  cookie: 'クッキー', cake: 'ケーキ', sugar: '砂糖', sugar_cane: 'サトウキビ', egg: '卵', milk_bucket: '牛乳入りバケツ', bucket: 'バケツ', water_bucket: '水入りバケツ', mushroom_stew: 'キノコシチュー', bowl: 'ボウル',
  rotten_flesh: '腐った肉', bone: '骨', bone_meal: '骨粉', string: '糸', spider_eye: 'クモの目', gunpowder: '火薬', arrow: '矢', bow: '弓', crossbow: 'クロスボウ', shield: '盾', feather: '羽', leather: '革',
  shears: 'ハサミ', fishing_rod: '釣り竿', ladder: 'はしご', paper: '紙', book: '本', bookshelf: '本棚', compass: 'コンパス', clock: '時計', map: '地図', lead: 'リード', saddle: '鞍',
  white_bed: '白のベッド', bed: 'ベッド', glass_pane: '板ガラス', iron_bars: '鉄格子', iron_door: '鉄のドア', cobblestone_wall: '丸石の塀', stone_bricks: '石レンガ', smoker: '燻製器', blast_furnace: '溶鉱炉',
  anvil: '金床', enchanting_table: 'エンチャント台', brewing_stand: '醸造台', cauldron: '大釜', composter: 'コンポスター', hay_block: '干し草の俵', dirt: '土', grass_block: '草ブロック', grass: '草',
  tall_grass: '背の高い草', fern: 'シダ', oak_leaves: 'オークの葉', vine: 'ツタ', poppy: 'ポピー', dandelion: 'タンポポ', cactus: 'サボテン', snowball: '雪玉', obsidian: '黒曜石', redstone: 'レッドストーン',
  lapis_lazuli: 'ラピスラズリ', emerald: 'エメラルド', golden_apple: '金のリンゴ', golden_carrot: '金のニンジン', painting: '絵画', item_frame: '額縁', flower_pot: '植木鉢', white_banner: '白の旗',
};

function jaName(name) {
  if (DIRECT[name]) return DIRECT[name];
  for (const [suf, ja] of SUFFIX) {
    if (!name.endsWith(suf)) continue;
    const pre = name.slice(0, -suf.length);
    const p = WOOD[pre] || COLOR[pre] || MAT[pre];
    if (p) return p.endsWith('の') ? `${p}${ja}` : `${p}の${ja}`;
    if (!pre) return ja;
  }
  return null;
}

module.exports = { jaName, WOOD, COLOR };
