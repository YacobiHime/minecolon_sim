'use strict';
// 所有を考えた行動の実行 (mineflayer)。候補は ownership_actions.js。理由の記録 (intent) は実行の前に agent (ownership_agent.js) が書く。
//   take_placed / dismantle_own: 決めた1か所だけを掘る (別の所に替えない。意図の記録と実際に取った所を一致させる)
//   ask_permission: 許可を聞いて答えを待つ (ctx.askPermission。agent が持つ)
//   make_amends: explain (ctx.explainTake) / return (近づいて投げ渡す) / repair (取った所に置き直す)
//   repair_or_relocate_public: repair (無くなった共同の物の所に置く) / relocate (掘って拠点の近くへ置く)
const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const { withTimeout } = require('./util');
const { sameFamily, SOFT } = require('./provenance');
const { itemOf } = require('./ownership');

const FACES = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]];
const OWN_TIMEOUTS = { take_placed: 40000, dismantle_own: 40000, ask_permission: 30000, make_amends: 40000, repair_or_relocate_public: 90000 };

function ownerJa(ch) {
  const i = ch.own || ch;
  if (i.category === 'own') return '自分の';
  if (!i.owner) return i.category === 'group' ? 'みんなの' : i.category === 'public' ? '共有の' : '誰かが置いた';
  return `${i.owner}の`;
}
function ownerEn(ch) {
  const i = ch.own || ch;
  if (i.category === 'own') return 'your own';
  if (!i.owner) return i.category === 'group' ? 'the group\'s' : i.category === 'public' ? 'the shared' : 'someone\'s';
  return `${i.owner}'s`;
}

function ownHandlers(lib) {
  // pos の name を1つ掘って拾う
  async function digAt(bot, pos, name, ctx) {
    const p = new Vec3(pos.x, pos.y, pos.z);
    let b = bot.blockAt(p);
    if (!b || !sameFamily(b.name, name)) return { ok: false, msg: `${name}はもう無かった`, gone: true };
    try {
      const goal = b.boundingBox !== 'block' ? new goals.GoalNear(p.x, p.y, p.z, 2) : new goals.GoalLookAtBlock(p, bot.world, { reach: 4.5 });
      await withTimeout(lib.gotoGoal(bot, goal), ctx.perTargetMs ?? 15000, () => lib.haltPath(bot));
    } catch (e) { return { ok: false, msg: `${name}へ行けなかった: ${lib.pathErr(e)}` }; }
    b = bot.blockAt(p);
    if (!b || !sameFamily(b.name, name)) return { ok: false, msg: `着いたが${name}はもう無かった`, gone: true };
    if (typeof bot.canDigBlock === 'function' && !bot.canDigBlock(b)) return { ok: false, msg: '手が届かない' };
    const item = itemOf(b.name);
    const before = lib.invCount(bot, item);
    try {
      if (lib.equipBestTool) await lib.equipBestTool(bot, b);
      await bot.dig(b, true);
    } catch (e) { return { ok: false, msg: `${name}を掘れなかった: ${lib.pathErr(e)}` }; }
    await lib.pickUpNear(bot, p);
    const got = lib.invCount(bot, item) - before;
    return { ok: true, got, item, block: b.name };
  }

  // pos に item を置く (下か横の固いブロックを支えにする)
  async function placeAt(bot, pos, item, ctx) {
    const t = new Vec3(pos.x, pos.y, pos.z);
    const it = bot.inventory.items().find((i) => i.name === item);
    if (!it) return { ok: false, msg: `${item}を持っていない` };
    const cur = bot.blockAt(t);
    if (!cur || !SOFT.test(cur.name) || /^(water|lava)$/.test(cur.name)) return { ok: false, msg: `その場所はふさがっている (${cur ? cur.name : '不明'})` };
    let ref = null; let face = null;
    for (const [dx, dy, dz] of FACES) {
      const rb = bot.blockAt(t.offset(dx, dy, dz));
      if (rb && rb.boundingBox === 'block') { ref = rb; face = new Vec3(-dx, -dy, -dz); break; }
    }
    if (!ref) return { ok: false, msg: '支えが無くて置けない' };
    try {
      await withTimeout(lib.gotoGoal(bot, new goals.GoalPlaceBlock(t, bot.world, { range: 4.5, LOS: true })), ctx.perTargetMs ?? 15000, () => lib.haltPath(bot));
    } catch (e) { return { ok: false, msg: `置く所へ行けなかった: ${lib.pathErr(e)}` }; }
    try {
      const c2 = bot.blockAt(t);
      if (c2 && c2.name !== 'air' && c2.name !== 'cave_air') await bot.dig(c2, true); // 草・雪をどける
      await bot.equip(it, 'hand');
      await bot.placeBlock(ref, face);
    } catch (e) {
      await new Promise((r) => setTimeout(r, 400));
      const nb = bot.blockAt(t);
      if (!nb || SOFT.test(nb.name)) return { ok: false, msg: `${item}を置けなかった: ${String(e.message).slice(0, 50)}` };
    }
    const nb = bot.blockAt(t);
    return { ok: !!nb && !SOFT.test(nb.name), placed: nb ? nb.name : null };
  }

  return {
    async take_placed(bot, ch, ctx) {
      const r = await digAt(bot, ch.pos, ch.block, ctx);
      if (!r.ok) return { ...r, taken: null };
      return { ok: true, msg: `${ownerJa(ch)}${ch.block}を掘って${r.got}個拾った`, msgEn: `dug up ${ownerEn(ch)} ${ch.block} and picked up ${r.got}`, taken: { block: r.block, pos: ch.pos, got: r.got, item: r.item } };
    },

    async dismantle_own(bot, ch, ctx) {
      const r = await digAt(bot, ch.pos, ch.block, ctx);
      if (!r.ok) return { ...r, taken: null };
      return { ok: true, msg: `自分で置いた${ch.block}を外して${r.got}個拾った`, msgEn: `took back your own ${ch.block}; picked up ${r.got}`, taken: { block: r.block, pos: ch.pos, got: r.got, item: r.item } };
    },

    async ask_permission(_bot, ch, ctx) {
      if (!ctx.askPermission) return { ok: false, msg: '許可を聞く仕組みがない' };
      return ctx.askPermission(ch);
    },

    async make_amends(bot, ch, ctx) {
      if (ch.kind === 'explain') return ctx.explainTake ? ctx.explainTake(ch) : { ok: false, msg: '話す仕組みがない' };
      if (ch.kind === 'return') {
        if (!lib.give) return { ok: false, msg: '渡す仕組みがない' };
        const r = await lib.give(bot, { player: ch.player, item: ch.item, count: 1 }, ctx);
        if (ctx.afterAmends) ctx.afterAmends(ch, r);
        return { ...r, amends: { kind: 'return', owner: ch.player, item: ch.item, ok: !!r.ok } };
      }
      if (ch.kind === 'repair') {
        const r = await placeAt(bot, ch.pos, ch.item, ctx);
        const res = r.ok ? { ok: true, msg: `${ch.item}を取った所に戻した`, msgEn: `put a ${ch.item} back where it was taken` } : r;
        if (ctx.afterAmends) ctx.afterAmends(ch, res);
        return { ...res, amends: { kind: 'repair', owner: ch.owner || null, item: ch.item, pos: ch.pos, ok: !!r.ok } };
      }
      return { ok: false, msg: `分からない償い方: ${ch.kind}` };
    },

    async repair_or_relocate_public(bot, ch, ctx) {
      if (ch.kind === 'repair') {
        const r = await placeAt(bot, ch.pos, ch.item, ctx);
        const res = r.ok ? { ok: true, msg: `無くなっていた共同の${ch.block}の所に${ch.item}を置いた`, msgEn: `put a ${ch.item} where the shared ${ch.block} had gone missing` } : r;
        if (ctx.afterPublicRepair) ctx.afterPublicRepair(ch, res);
        return { ...res, publicRepair: { kind: 'repair', block: ch.block, pos: ch.pos, ok: !!r.ok } };
      }
      if (ch.kind === 'relocate') {
        if (!ctx.base) return { ok: false, msg: '拠点を知らない' };
        const r = await digAt(bot, ch.pos, ch.block, ctx);
        if (!r.ok) return { ...r, taken: null };
        const taken = { block: r.block, pos: ch.pos, got: r.got, item: r.item };
        try {
          await withTimeout(lib.gotoGoal(bot, new goals.GoalNear(ctx.base.x, ctx.base.y, ctx.base.z, 3)), ctx.relocateWalkMs ?? 45000, () => lib.haltPath(bot));
        } catch (e) { return { ok: false, msg: `共同の${ch.block}を掘ったが、拠点へ行けなかった: ${lib.pathErr(e)}`, taken }; }
        const pr = lib.place ? await lib.place(bot, { item: r.item }, ctx) : { ok: false, msg: '置く仕組みがない' };
        if (ctx.afterPublicRepair) ctx.afterPublicRepair(ch, pr);
        return { ok: !!pr.ok, msg: pr.ok ? `共同の${ch.block}を拠点の近くへ移した (${pr.msg})` : `共同の${ch.block}を掘ったが置けなかった: ${pr.msg}`, msgEn: pr.ok ? `moved the shared ${ch.block} to near the base` : `dug up the shared ${ch.block} but could not place it`, taken, publicRepair: { kind: 'relocate', block: ch.block, from: ch.pos, ok: !!pr.ok } };
      }
      return { ok: false, msg: `分からない直し方: ${ch.kind}` };
    },
  };
}

module.exports = { ownHandlers, OWN_TIMEOUTS };
