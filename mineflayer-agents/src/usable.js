'use strict';
// 右クリックで何かが起きる持ち物の一覧 (マイクラの仕様。bot に依存しない)。
//   use_on   : ブロックか生き物に向けて右クリックしたとき、何かが起きうる物 (耕す・樹皮をはぐ・植える・すくう・刈る・餌をやる・乗る等)
//   use_item : その場で右クリックしたとき、何かが起きうる物 (食べる・飲む・投げる・引く・構える・着る等)
// どちらにも当たらない物 (剣・ツルハシ・棒・原木などのブロック) は、その行動の選択肢から外すだけ。
// この一覧はモデルには見せない (研究方針: 仕様は見せてよいが、どう使うかは教えない。ここは選択肢を作るプログラムの側)。
// 素手 (扉・レバー・ボタン・ベッド・乗り物など) は actions_more.js の側で常に残す。

// --- use_on (ブロック・生き物に使う) ---
// 道具: クワ (耕す)・斧 (樹皮をはぐ・錆/蝋を落とす)・シャベル (土の道・焚き火を消す)・ハサミ (刈る)・火をつける物・ブラシ (怪しい砂)
const USE_ON_TOOL = /_(hoe|axe|shovel)$|^(shears|flint_and_steel|fire_charge|brush)$/;
// 植える物 (種・苗木・作物の種類など)
const USE_ON_PLANT = /_sapling$|_propagule$|_seeds$|^(carrot|potato|beetroot_seeds|sweet_berries|glow_berries|cocoa_beans|pitcher_pod|nether_wart|sugar_cane|bamboo|cactus|kelp|sea_pickle|lily_pad|brown_mushroom|red_mushroom|crimson_fungus|warped_fungus|azalea|flowering_azalea|chorus_flower)$/;
// 入れ物: バケツ類 (すくう・置く・乳をしぼる)・ガラス瓶 (水をくむ)・水の入った瓶 (土を泥に)・器 (ムーシュルーム)
const USE_ON_CONTAINER = /_bucket$|^(bucket|glass_bottle|potion|bowl)$/;
// 生き物に使う物: 名札・リード・鞍・染料 (羊・看板)・墨袋
const USE_ON_MOB = /_dye$|^(name_tag|lead|saddle|ink_sac|glow_ink_sac|honeycomb)$/;
// 餌になる物 (動物に使ったとき、食べる・繁殖する・なつく)
const USE_ON_FEED = new Set(['wheat', 'carrot', 'potato', 'beetroot', 'golden_carrot', 'golden_apple', 'enchanted_golden_apple', 'apple', 'sugar', 'hay_block',
  'cod', 'salmon', 'tropical_fish', 'bone', 'rotten_flesh', 'beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken',
  'cooked_mutton', 'cooked_rabbit', 'dandelion', 'sweet_berries', 'glow_berries', 'slime_ball', 'seagrass', 'bamboo', 'cactus', 'torchflower_seeds', 'wheat_seeds',
  'melon_seeds', 'pumpkin_seeds', 'beetroot_seeds', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip',
  'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'sunflower', 'lilac', 'rose_bush', 'peony', 'torchflower', 'pink_petals', 'spore_blossom', 'crimson_fungus', 'warped_fungus']);
// 乗り物・置く物 (ボート・トロッコ・額縁・絵画・防具立て)・その他 (エンダーアイ・レコード・本・コンパス・花火・スポーンエッグ・ろうそく)
const USE_ON_OTHER = /_boat$|_raft$|minecart$|_spawn_egg$|^music_disc_|^(item_frame|glow_item_frame|painting|armor_stand|end_crystal|ender_eye|book|writable_book|written_book|compass|firework_rocket|bone_meal|carrot_on_a_stick|warped_fungus_on_a_stick|candle|.*_candle)$/;

function usefulOn(name) {
  const n = String(name || '');
  return USE_ON_TOOL.test(n) || USE_ON_PLANT.test(n) || USE_ON_CONTAINER.test(n) || USE_ON_MOB.test(n) || USE_ON_FEED.has(n) || USE_ON_OTHER.test(n);
}

// --- use_item (その場で使う) ---
// 食べ物 (食べる。minecraft-data の foods の名前)
let FOODS = null;
function foods() {
  if (!FOODS) {
    try { FOODS = new Set(require('minecraft-data')('1.20.1').foodsArray.map((f) => f.name)); } catch (_) { FOODS = new Set(); }
  }
  return FOODS;
}
// 飲む・投げる・引く・構える・着る・覗く・吹く・乗っている物を動かす など
const USE_ITEM_OTHER = /_bucket$|_helmet$|_chestplate$|_leggings$|_boots$|^(potion|splash_potion|lingering_potion|milk_bucket|honey_bottle|bow|crossbow|trident|shield|fishing_rod|snowball|egg|ender_pearl|ender_eye|experience_bottle|firework_rocket|spyglass|goat_horn|map|writable_book|written_book|elytra|carved_pumpkin|bucket|glass_bottle|carrot_on_a_stick|warped_fungus_on_a_stick|wind_charge)$/;

function usefulItem(name) {
  const n = String(name || '');
  return foods().has(n) || USE_ITEM_OTHER.test(n);
}

module.exports = { usefulOn, usefulItem, USE_ON_TOOL, USE_ON_PLANT, USE_ON_CONTAINER, USE_ON_MOB, USE_ON_FEED, USE_ON_OTHER, USE_ITEM_OTHER };
