'use strict';
// 動物の仕様 (1.20.1): 繁殖・誘導に使う餌。states.js (状態のゴール) と actions_more.js (lure の候補) が使う
const BREED_FOOD = {
  cow: ['wheat'], mooshroom: ['wheat'], sheep: ['wheat'], goat: ['wheat'], pig: ['carrot', 'potato', 'beetroot'],
  chicken: ['wheat_seeds', 'melon_seeds', 'pumpkin_seeds', 'beetroot_seeds', 'torchflower_seeds'], rabbit: ['carrot', 'golden_carrot', 'dandelion'],
  horse: ['golden_apple', 'golden_carrot'], donkey: ['golden_apple', 'golden_carrot'], llama: ['hay_block'], turtle: ['seagrass'],
};
// 動物が餌について来る距離 (仕様: tempt の範囲 10 ブロック)
const TEMPT_RANGE = 10;
module.exports = { BREED_FOOD, TEMPT_RANGE };
