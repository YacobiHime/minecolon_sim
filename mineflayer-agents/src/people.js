'use strict';
// 近くの人: 見えていなくても (視線が通らなくても) 距離だけで決める (2026-11-06 ユーザー決定「近くの交流ができる範囲を広げる」)。
//   位置は bot.players[名前].entity (サーバーがこのボットに送っている相手の位置。視線とは関係ない) から取る。
//   entity が無い (サーバーが送ってこない = entity の届く範囲の外か、まだ来ていない) ときは、
//   最後に分かった位置を staleMs まで使う (PlayerCache)。それより古い・一度も分からない人は「遠い」扱い。
//   届く範囲: Minecraft 1.20.1 のサーバーは、プレイヤーの位置を min(512 × entity-broadcast-range-percentage / 100, (view-distance − 1) × 16) m
//   (水平の距離) 以内のプレイヤーに送る。trackingRange() で求める。hearRadius・peopleRadius はこれ以下にする。
const { dist3, round1 } = require('./util');

class PlayerCache {
  constructor({ staleMs = 15000 } = {}) { this.staleMs = staleMs; this.pos = new Map(); }
  // bot.players の entity のある人の位置を覚える
  update(bot, now = Date.now()) {
    if (!bot || !bot.players) return;
    for (const [name, p] of Object.entries(bot.players)) {
      if (name === bot.username || !p || !p.entity || !p.entity.position) continue;
      const e = p.entity.position;
      this.pos.set(name, { x: e.x, y: e.y, z: e.z, at: now });
    }
  }
  // 名前の人の位置 { pos, how: 'entity'|'cache' } | null
  get(bot, name, now = Date.now()) {
    const p = bot && bot.players && bot.players[name];
    if (p && p.entity && p.entity.position) {
      const e = p.entity.position;
      this.pos.set(name, { x: e.x, y: e.y, z: e.z, at: now });
      return { pos: { x: e.x, y: e.y, z: e.z }, how: 'entity' };
    }
    const c = this.pos.get(name);
    if (c && now - c.at <= this.staleMs) return { pos: { x: c.x, y: c.y, z: c.z }, how: 'cache' };
    return null;
  }
}

// 自分から name までの距離 (分からなければ null)
function playerDistance(bot, name, cache = null, now = Date.now()) {
  if (!bot || !bot.entity) return null;
  const got = cache ? cache.get(bot, name, now) : (() => {
    const p = bot.players && bot.players[name];
    return p && p.entity && p.entity.position ? { pos: p.entity.position, how: 'entity' } : null;
  })();
  if (!got) return null;
  return { d: dist3(got.pos, bot.entity.position), how: got.how, pos: got.pos };
}

// 半径 radius 以内の人 (自分を除く、近い順)。視線は見ない。seen: 視界に入っている (raw.entities にいる) か
//   返り値の形は raw.entities の player と同じ { kind: 'player', name, pos, d } + seen・how
function nearPlayers(bot, radius, { cache = null, seenNames = null, now = Date.now() } = {}) {
  if (!bot || !bot.entity || !bot.players) return [];
  const out = [];
  for (const name of Object.keys(bot.players)) {
    if (name === bot.username) continue;
    const r = playerDistance(bot, name, cache, now);
    if (!r || r.d > radius) continue;
    out.push({ kind: 'player', name, pos: { x: round1(r.pos.x), y: round1(r.pos.y), z: round1(r.pos.z) }, d: round1(r.d), seen: seenNames ? seenNames.has(name) : false, how: r.how });
  }
  return out.sort((a, b) => a.d - b.d);
}

// 行動の対象になる近くの人: raw.people (距離だけで決めた人) があればそれ、無ければ見えている人 (古い記録・テスト)
function peopleOf(raw) {
  if (raw && Array.isArray(raw.people)) return raw.people;
  return ((raw && raw.entities) || []).filter((e) => e.kind === 'player');
}

// サーバーがプレイヤーの位置を送ってくる水平の距離 (Minecraft 1.20.1 の ChunkMap.TrackedEntity: min(effectiveRange, (viewDistance − 1) × 16))
//   プレイヤーの clientTrackingRange は 32 チャンク = 512 m。entity-broadcast-range-percentage で縮む
function trackingRange({ viewDistance = 10, broadcastPct = 100 } = {}) {
  const eff = Math.floor((512 * broadcastPct) / 100);
  return Math.min(eff, (viewDistance - 1) * 16);
}

module.exports = { PlayerCache, playerDistance, nearPlayers, peopleOf, trackingRange };
