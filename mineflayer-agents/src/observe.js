'use strict';
// observe: 1人のボットが「今」知ることのできる情報だけを集める。
// - 自分の状態 (位置・体力・空腹・持ち物・昼夜)
// - 視界: 半径 visionRadius 以内で、目から視線が通る (raycast で最初に当たる) ブロックとエンティティ
// - 近くで聞こえたチャット (hearRadius 以内の相手の発言だけ。届かない発言は agent 側で捨てる)
// サーバー全体の情報 (プレイヤー一覧・ワールドの座標一覧など) は使わない。
const { Vec3 } = require('vec3');
const { relDir, dist3, timePhase, round1 } = require('./util');

const IGNORE = new Set(['air', 'cave_air', 'void_air']);
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
  const hit = bot.world.raycast(eye, d.scaled(1 / len), len + 1);
  return !!hit && hit.position.x === pos.x && hit.position.y === pos.y && hit.position.z === pos.z;
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
    if (!t) { t = { name: b.name, checked: 0, positions: [], block: b }; byType.set(b.name, t); }
    if (t.checked >= perType || t.positions.length >= keepPerType) continue;
    t.checked += 1;
    if (blockVisible(bot, p)) t.positions.push({ x: p.x, y: p.y, z: p.z });
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
  lines.push(`自分: ${s.name} 位置(${Math.round(s.pos.x)},${Math.round(s.pos.y)},${Math.round(s.pos.z)}) 体力${s.health}/20 満腹${s.food}/20 時間:${s.phase}`);
  lines.push('持ち物: ' + (raw.inventory.length ? raw.inventory.map((i) => `${i.name}x${i.count}`).join(', ') : 'なし'));
  const blocks = [...raw.blocks].sort((a, b) => (b.notable - a.notable) || (a.nearest.d - b.nearest.d)).slice(0, maxTypes);
  lines.push('見えるブロック: ' + (blocks.length
    ? blocks.map((b) => `${b.name} ${relDir(s.pos, b.nearest)}${b.seen > 1 ? ` 他${b.seen - 1}+` : ''}`).join(', ')
    : 'なし'));
  const ents = raw.entities.slice(0, maxEntities);
  lines.push('近くの人・生き物・落ちている物: ' + (ents.length
    ? ents.map((e) => `${e.kind === 'player' ? 'プレイヤー' : e.kind === 'item' ? '落ちている' : ''}${e.name} ${relDir(s.pos, e.pos)}`).join(', ')
    : 'なし'));
  lines.push('今聞こえた話: ' + (raw.heard.length ? raw.heard.map((h) => `${h.from}「${h.text}」`).join(' ') : 'なし'));
  return lines.join('\n');
}

module.exports = { collectRaw, summarizeObservation, summarizeInventory, notableMatcher, blockVisible, DEFAULT_NOTABLE };
