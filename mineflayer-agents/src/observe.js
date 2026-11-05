'use strict';
// observe: 1人のボットが「今」知ることのできる情報だけを集める。
// - 自分の状態 (位置・体力・空腹・持ち物・昼夜)
// - 視界: 半径 visionRadius 以内で、目から視線が通る (raycast で最初に当たる) ブロックとエンティティ
// - 近くで聞こえたチャット (hearRadius 以内の相手の発言だけ。届かない発言は agent 側で捨てる)
// サーバー全体の情報 (プレイヤー一覧・ワールドの座標一覧など) は使わない。
const { Vec3 } = require('vec3');
const { relDir, dist3, timePhase, round1 } = require('./util');
const en = require('./en');

const IGNORE = new Set(['air', 'cave_air', 'void_air']);
// 敵 (夜や暗い所に出る、こちらを襲うもの)。観測では kind: 'hostile' にして「敵」と書く
const HOSTILE = new Set(['zombie', 'zombie_villager', 'husk', 'drowned', 'skeleton', 'stray', 'creeper', 'spider', 'cave_spider',
  'enderman', 'witch', 'slime', 'phantom', 'pillager', 'vindicator', 'evoker', 'ravager', 'silverfish', 'guardian', 'blaze', 'ghast']);
const DEFAULT_NOTABLE = [
  '_log$', '^crafting_table$', '^furnace$', '^chest$', '^water$', '^lava$', '_ore$', '_bed$',
  '^sand$', '^gravel$', '^clay$', '^pumpkin$', '^melon$', '^sugar_cane$', '^cobblestone$',
];

function notableMatcher(patterns = DEFAULT_NOTABLE) {
  const res = patterns.map((p) => new RegExp(p));
  return (name) => res.some((r) => r.test(name));
}

function eyePos(bot) {
  return bot.entity.position.offset(0, bot.entity.height ?? 1.62, 0);
}

// 目からブロック中心へ視線が通るか (途中で別のブロックに当たれば見えない)
function blockVisible(bot, pos) {
  if (!bot.world || typeof bot.world.raycast !== 'function') return true;
  const eye = eyePos(bot);
  const c = new Vec3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5);
  const d = c.minus(eye);
  const len = d.norm();
  if (len < 1e-6) return true;
  // 当たり判定の無いブロック (水・作物・草・花・松明など) も見えるように、狙ったマスに入ったらそこで止める
  const same = (p) => p.x === pos.x && p.y === pos.y && p.z === pos.z;
  const hit = bot.world.raycast(eye, d.scaled(1 / len), len + 1,
    (b, iter) => same(b.position) || (!!b.shapes && b.shapes.length > 0 && !!iter.intersect(b.shapes, b.position)));
  return !!hit && same(hit.position);
}

function entityVisible(bot, e) {
  if (!bot.world || typeof bot.world.raycast !== 'function') return true;
  const eye = eyePos(bot);
  const c = e.position.offset(0, (e.height || 1) * 0.6, 0);
  const d = c.minus(eye);
  const len = d.norm();
  if (len < 1e-6) return true;
  const hit = bot.world.raycast(eye, d.scaled(1 / len), len);
  return !hit; // 途中にブロックがなければ見える
}

// 乗り物 (乗る・降りるができる物)
const VEHICLE = /(^|_)(boat|raft|minecart)$/;
// 作物の育ち: age が最大なら true、途中なら false、作物でなければ null
const CROP = /^(wheat|carrots|potatoes|beetroots|nether_wart|sweet_berry_bush|cocoa|melon_stem|pumpkin_stem|torchflower_crop|pitcher_crop)$/;
function cropRipe(bot, b) {
  if (!CROP.test(b.name) || typeof b.getProperties !== 'function') return null;
  const age = Number(b.getProperties().age);
  const reg = bot.registry && bot.registry.blocksByName[b.name];
  const st = reg && reg.states && reg.states.find((x) => x.name === 'age');
  if (!Number.isFinite(age) || !st) return null;
  return age >= st.num_values - 1;
}

function canHarvest(block, invIds) {
  if (!block.diggable || block.hardness == null) return false;
  if (!block.harvestTools) return true;
  return Object.keys(block.harvestTools).some((id) => invIds.has(Number(id)));
}

// bot から生の観測を集める (データだけを返す。文章にはしない)
function collectRaw(bot, opts = {}) {
  const radius = opts.visionRadius ?? 16;
  const perType = opts.samplesPerType ?? 12; // 種類ごとに視線を調べる候補の数
  const keepPerType = opts.keepPerType ?? 5; // 種類ごとに覚える見えた位置の数
  const isNotable = opts.isNotable || notableMatcher(opts.notable);
  const pos = bot.entity.position;
  const items = bot.inventory.items();
  const invIds = new Set(items.map((i) => i.type));

  // 半径内の空気以外のブロック (近い順)。種類ごとに近いものから視線を調べる
  const found = bot.findBlocks({
    matching: (b) => b && !IGNORE.has(b.name),
    maxDistance: radius,
    count: opts.scanCount ?? 20000,
  });
  const byType = new Map();
  const exclude = opts.exclude || null; // Set of "x,y,z" (拠点の小屋に置いたブロック。素材として見せない)
  for (const p of found) {
    if (exclude && exclude.has(`${p.x},${p.y},${p.z}`)) continue;
    const b = bot.blockAt(p);
    if (!b || IGNORE.has(b.name)) continue;
    let t = byType.get(b.name);
    if (!t) { t = { name: b.name, checked: 0, positions: [], block: b, ripe: 0 }; byType.set(b.name, t); }
    if (t.checked >= perType || t.positions.length >= keepPerType) continue;
    t.checked += 1;
    if (blockVisible(bot, p)) {
      // 作物 (age のあるブロック) は育ちきっているかを位置ごとに持つ (見た目で分かること)
      const ripe = cropRipe(bot, b);
      t.positions.push(ripe == null ? { x: p.x, y: p.y, z: p.z } : { x: p.x, y: p.y, z: p.z, ripe });
      if (ripe) t.ripe += 1;
    }
  }
  const blocks = [];
  for (const t of byType.values()) {
    if (!t.positions.length) continue;
    const positions = t.positions
      .map((p) => ({ ...p, d: round1(dist3(p, pos)) }))
      .sort((a, b) => a.d - b.d);
    blocks.push({
      name: t.name,
      notable: isNotable(t.name),
      diggable: canHarvest(t.block, invIds),
      seen: positions.length,
      nearest: positions[0],
      positions,
      ...(positions.some((p) => p.ripe != null) ? { ripe: t.ripe } : {}),
    });
  }

  // エンティティ (半径内・視線が通るもの)
  const entities = [];
  for (const e of Object.values(bot.entities || {})) {
    if (!e || e === bot.entity || !e.position) continue;
    const d = dist3(e.position, pos);
    if (d > radius) continue;
    if (!entityVisible(bot, e)) continue;
    let kind = 'mob';
    let name = e.name || e.displayName || 'unknown';
    if (e.type === 'player') { kind = 'player'; name = e.username || name; }
    else if (HOSTILE.has(e.name)) kind = 'hostile';
    else if (VEHICLE.test(e.name || '')) kind = 'vehicle';
    else if (e.name === 'item') {
      kind = 'item';
      try { const it = e.getDroppedItem && e.getDroppedItem(); name = it ? it.name : 'item'; } catch (_) { name = 'item'; }
    } else if (e.type === 'object' || e.type === 'orb' || e.type === 'projectile') continue;
    entities.push({ kind, name, id: e.id, pos: { x: round1(e.position.x), y: round1(e.position.y), z: round1(e.position.z) }, d: round1(d) });
  }
  entities.sort((a, b) => a.d - b.d);

  const table = blocks.find((b) => b.name === 'crafting_table');
  return {
    self: {
      name: bot.username,
      pos: { x: round1(pos.x), y: round1(pos.y), z: round1(pos.z) },
      health: Math.round(bot.health ?? 20),
      food: Math.round(bot.food ?? 20),
      timeOfDay: bot.time ? bot.time.timeOfDay : 6000,
      phase: timePhase(bot.time ? bot.time.timeOfDay : 6000),
      day: bot.time && Number.isFinite(bot.time.day) ? bot.time.day : null,
      held: bot.heldItem ? bot.heldItem.name : null,
      vehicle: bot.vehicle ? (bot.vehicle.name || 'vehicle') : null,
      level: bot.experience && Number.isFinite(bot.experience.level) ? bot.experience.level : null,
    },
    inventory: summarizeInventory(items),
    blocks,
    entities,
    heard: opts.heard || [],
    craft: opts.craft || { now: [], withTable: [] },
    tableNearby: table ? table.nearest : null,
  };
}

function summarizeInventory(items) {
  const m = new Map();
  for (const it of items) m.set(it.name, (m.get(it.name) || 0) + it.count);
  return [...m.entries()].map(([name, count]) => ({ name, count }));
}

// 生の観測を、プロンプトに入れる短い文章にする (bot に依存しない純粋な関数)
function summarizeObservation(raw, opts = {}) {
  const maxTypes = opts.maxTypes ?? 12;
  const maxEntities = opts.maxEntities ?? 6;
  const s = raw.self;
  const lines = [];
  // showDay: 何日目か (1日目 = day 0)。3日生き延びる設定で使う
  const dayTxt = opts.showDay && s.day != null ? ` ${s.day + 1}日目` : '';
  const ride = s.vehicle ? ` ${s.vehicle}に乗っている` : '';
  lines.push(`自分: ${s.name} 位置(${Math.round(s.pos.x)},${Math.round(s.pos.y)},${Math.round(s.pos.z)}) 体力${s.health}/20 満腹${s.food}/20 時間:${s.phase}${dayTxt}${ride}`);
  lines.push('持ち物: ' + (raw.inventory.length ? raw.inventory.map((i) => `${i.name}x${i.count}`).join(', ') : 'なし'));
  const blocks = [...raw.blocks].sort((a, b) => (b.notable - a.notable) || (a.nearest.d - b.nearest.d)).slice(0, maxTypes);
  lines.push('見えるブロック: ' + (blocks.length
    ? blocks.map((b) => `${b.name}${b.ripe != null ? `(育ちきった${b.ripe}/${b.seen})` : ''} ${relDir(s.pos, b.nearest)}${b.seen > 1 ? ` 他${b.seen - 1}+` : ''}`).join(', ')
    : 'なし'));
  const ents = raw.entities.slice(0, maxEntities);
  lines.push('近くの人・生き物・落ちている物: ' + (ents.length
    ? ents.map((e) => `${e.kind === 'player' ? 'プレイヤー' : e.kind === 'item' ? '落ちている' : e.kind === 'hostile' ? '敵' : ''}${e.name} ${relDir(s.pos, e.pos)}`).join(', ')
    : 'なし'));
  lines.push('今聞こえた話: ' + (raw.heard.length ? raw.heard.map((h) => `${h.from}「${h.text}」`).join(' ') : 'なし'));
  return lines.join('\n');
}

// Jev 用の英語の観察 (summarizeObservation と同じ raw から)。判断に関係の薄いものを削り、数・距離は段階の言葉にする。
//   visible: 目印 (notable)・names (道筋・ゴール・選択肢に出てくる名前) に当たるブロック・作物だけ。maxVisible 種類まで
//   位置の座標は出さない。見えている数は none/one/a few/some/many
function observationEn(raw, opts = {}) {
  const s = raw.self;
  const names = opts.names || new Set();
  const maxVisible = opts.maxVisible ?? 8;
  const maxNearby = opts.maxNearby ?? 6;
  const self = [`health ${en.healthWord(s.health)}`, `food ${en.foodWord(s.food)}`, en.phaseEn(s.phase)];
  if (opts.showDay && s.day != null) self.push(en.dayEn(s.day));
  if (s.vehicle) self.push(`riding a ${s.vehicle}`);
  if (s.held) self.push(`holding ${s.held}`);
  const keep = raw.blocks.filter((b) => b.notable || names.has(b.name) || b.ripe != null);
  const blocks = keep.sort((a, b) => (names.has(b.name) - names.has(a.name)) || (b.notable - a.notable) || (a.nearest.d - b.nearest.d)).slice(0, maxVisible);
  const visible = blocks.map((b) => `${b.name} (${en.whereEn(s.pos, b.nearest)}; ${b.ripe != null ? `${en.countWord(b.ripe)} fully grown of ${en.countWord(b.seen)}` : en.countWord(b.seen)})`);
  const kindEn = { player: 'player', hostile: 'hostile', item: 'dropped item', vehicle: 'vehicle', mob: 'animal' };
  const ents = raw.entities.slice(0, maxNearby);
  const nearby = ents.map((e) => `${e.name} (${kindEn[e.kind] || e.kind}; ${en.whereEn(s.pos, e.pos)})`);
  return { self: self.join(', '), inventory: en.invText(raw.inventory), visible: visible.length ? visible.join('; ') : 'nothing notable', nearby: nearby.length ? nearby.join('; ') : 'nobody' };
}

module.exports = { observationEn, cropRipe, VEHICLE, collectRaw, summarizeObservation, summarizeInventory, notableMatcher, blockVisible, DEFAULT_NOTABLE, HOSTILE };
