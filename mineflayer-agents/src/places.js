'use strict';
// 全員に共通の場所の呼び方と、聞いた話から場所を読み取ること。
//   呼び方: 出現地点 (全員が同じ所に出る。world spawn) からの方角と距離。「出現地点から北東に120m」。距離は step m 単位に丸める。
//     M 番号 (memory.placesForPrompt) は人ごとの番号なので、ほかの人に言っても伝わらない。共通の呼び方は誰が聞いても同じ所を指す。
//   読み取り: 「出現地点から北東に120m」「(-250, 70, 130)」「x=-250 z=130」の形と、同じ文に出てくる物の名前 (jungle_log など)。
const { index } = require('./planner');

const DIRS = [['東', 'east', 1, 0], ['南東', 'southeast', 1, 1], ['南', 'south', 0, 1], ['南西', 'southwest', -1, 1], ['西', 'west', -1, 0], ['北西', 'northwest', -1, -1], ['北', 'north', 0, -1], ['北東', 'northeast', 1, -1]];
const JA_VEC = Object.fromEntries(DIRS.map(([ja, , dx, dz]) => [ja, [dx / Math.hypot(dx, dz), dz / Math.hypot(dx, dz)]]));
const ORIGIN_JA = '出現地点';

function dirOf(dx, dz) { const a = Math.atan2(dz, dx); return DIRS[((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8]; }

// pos の共通の呼び方。abs: 絶対座標も添える
function commonRef(pos, origin, { step = 10, near = 15, abs = false, lang = 'ja' } = {}) {
  if (!pos || !origin) return null;
  const dx = pos.x - origin.x; const dz = pos.z - origin.z;
  const d = Math.hypot(dx, dz);
  const xyz = abs ? ` (${Math.round(pos.x)}, ${Math.round(pos.y ?? origin.y ?? 64)}, ${Math.round(pos.z)})` : '';
  if (d < near) return lang === 'en' ? `right by the spawn point${xyz}` : `${ORIGIN_JA}のすぐ近く${xyz}`;
  const r = Math.max(step, Math.round(d / step) * step);
  const [ja, en] = dirOf(dx, dz);
  return lang === 'en' ? `${r}m ${en} of the spawn point${xyz}` : `${ORIGIN_JA}から${ja}に${r}m${xyz}`;
}

// 日本語で言われやすいブロック・生き物 (話し言葉 → minecraft の名前)。長い語から当てる
const JA_KIND = [['サトウキビ', 'sugar_cane'], ['石炭', 'coal_ore'], ['鉄鉱石', 'iron_ore'], ['鉄', 'iron_ore'], ['原木', '_log'], ['丸石', 'stone'], ['石', 'stone'], ['砂利', 'gravel'], ['砂', 'sand'],
  ['粘土', 'clay'], ['水', 'water'], ['溶岩', 'lava'], ['牛', 'cow'], ['豚', 'pig'], ['羊', 'sheep'], ['鶏', 'chicken'], ['ニワトリ', 'chicken'], ['ウサギ', 'rabbit'], ['兎', 'rabbit'], ['馬', 'horse'],
  ['村人', 'villager'], ['カボチャ', 'pumpkin'], ['スイカ', 'melon'], ['小麦', 'wheat'], ['耕地', 'farmland'], ['畑', 'farmland'], ['草', 'grass'], ['花', 'poppy']];

// 文の中の物の名前 (minecraft のアイテム・ブロック・生き物)。英語の名前が先、無ければ日本語の言い方から
function namesIn(text, version) {
  const md = index(version).md;
  const s = String(text || '');
  const out = [];
  for (const w of s.match(/[a-z][a-z0-9_]{2,}/g) || []) {
    if ((md.blocksByName[w] || md.itemsByName[w] || (md.entitiesByName && md.entitiesByName[w])) && !out.includes(w)) out.push(w);
  }
  if (!out.length) {
    const hits = [];
    let rest = s;
    for (const [ja, name] of JA_KIND) {
      const i = rest.indexOf(ja);
      if (i < 0 || name.startsWith('_')) continue;
      hits.push([i, name]); rest = rest.split(ja).join(' '.repeat(ja.length));
    }
    for (const [, n] of hits.sort((a, b) => a[0] - b[0])) if (!out.includes(n)) out.push(n);
  }
  return out;
}

const RE_COMMON = new RegExp(`${ORIGIN_JA}から(?:の)?\\s*(北東|北西|南東|南西|東|西|南|北)(?:の方)?(?:に|へ)?\\s*(?:約|およそ|だいたい)?\\s*(\\d{1,5})\\s*(?:m|メートル|ブロック)`, 'g');
const RE_NEAR = new RegExp(`${ORIGIN_JA}の(?:すぐ)?(?:近く|そば)`, 'g');
const RE_XYZ = /\(?\s*(-?\d{1,6})\s*[,、]\s*(-?\d{1,3})\s*[,、]\s*(-?\d{1,6})\s*\)?/g;
const RE_XZ = /x\s*[=:＝]?\s*(-?\d{1,6})\s*[,、 ]\s*(?:y\s*[=:＝]?\s*(-?\d{1,3})\s*[,、 ]\s*)?z\s*[=:＝]?\s*(-?\d{1,6})/gi;

// 聞いた文から場所を読む → [{ pos, kind (物の名前 | null), how: 'common'|'xyz' }]
function parsePlaces(text, origin, { version } = {}) {
  const s = String(text || '');
  const out = [];
  const kinds = namesIn(s, version);
  const kind = kinds[0] || null;
  if (origin) {
    for (const m of s.matchAll(RE_COMMON)) {
      const [vx, vz] = JA_VEC[m[1]]; const d = Number(m[2]);
      out.push({ pos: { x: Math.round(origin.x + vx * d), y: origin.y ?? 64, z: Math.round(origin.z + vz * d) }, kind, how: 'common' });
    }
    if (!out.length && RE_NEAR.test(s)) out.push({ pos: { x: origin.x, y: origin.y ?? 64, z: origin.z }, kind, how: 'common' });
    RE_NEAR.lastIndex = 0;
  }
  for (const m of s.matchAll(RE_XZ)) out.push({ pos: { x: Number(m[1]), y: m[2] != null ? Number(m[2]) : (origin ? origin.y : 64), z: Number(m[3]) }, kind, how: 'xyz' });
  if (!out.some((p) => p.how === 'xyz')) for (const m of s.matchAll(RE_XYZ)) out.push({ pos: { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) }, kind, how: 'xyz' });
  return out;
}

module.exports = { commonRef, parsePlaces, namesIn, ORIGIN_JA, dirOf };
