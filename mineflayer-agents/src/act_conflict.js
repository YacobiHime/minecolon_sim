'use strict';
// わだかまりのある相手への行動の実行 (候補は conflict.js)。発話の部分は agent (conflict_agent.js の say) が持つ。
const { goals } = require('mineflayer-pathfinder');
const { sleep, withTimeout, dist3 } = require('./util');

const CONFLICT_TIMEOUTS = { avoid_person: 15000, complain: 15000, demand_back: 15000, call_help: 15000, take_back: 40000, hit_person: 25000 };

function conflictHandlers(lib) {
  const entityOf = (bot, name) => { const p = bot.players && bot.players[name]; return p && p.entity && p.entity.position ? p.entity : null; };
  return {
    async avoid_person(bot, ch, ctx) {
      const e = entityOf(bot, ch.player);
      const from = e ? [e.position] : ch.from || [];
      if (!from.length) return { ok: false, msg: `${ch.player}がどこにいるか分からない` };
      const r = await lib.flee(bot, { from }, { ...ctx, fleeDistance: ctx.avoidDistance ?? 16 });
      const d = e ? Math.round(dist3(e.position, bot.entity.position)) : null;
      return r.ok ? { ok: true, msg: `${ch.player}から離れた${d != null ? ` (今${d}m)` : ''}`, msgEn: `moved away from ${ch.player}`, avoided: { target: ch.player, d } }
        : { ok: false, msg: `${ch.player}から離れられなかった`, msgEn: `could not move away from ${ch.player}` };
    },
    async complain(_bot, ch, ctx) { return ctx.conflictSay ? ctx.conflictSay('complain', ch) : { ok: false, msg: '言う仕組みがない' }; },
    async demand_back(_bot, ch, ctx) { return ctx.conflictSay ? ctx.conflictSay('demand', ch) : { ok: false, msg: '言う仕組みがない' }; },
    async call_help(_bot, ch, ctx) { return ctx.conflictSay ? ctx.conflictSay('help', ch) : { ok: false, msg: '言う仕組みがない' }; },
    async take_back(bot, ch, ctx) {
      const r = await lib.takePlaced(bot, { pos: ch.pos, block: ch.block, own: { owner: ch.player, category: 'other' } }, ctx);
      return r.ok ? { ...r, msg: `${ch.player}の${ch.block}を取り返した (${r.taken ? r.taken.got : 0}個拾った)`, msgEn: `took ${ch.player}'s ${ch.block} in return`, tookBack: { target: ch.player, block: ch.block } } : r;
    },
    // 殴る: 近づいて hits 発まで。相手が死んだ (エンティティが消えた) ら止める
    async hit_person(bot, ch, ctx) {
      let e = entityOf(bot, ch.player);
      if (!e) return { ok: false, msg: `${ch.player}が見えない` };
      const max = ctx.hits ?? 3;
      let hits = 0;
      const t0 = Date.now();
      while (hits < max && Date.now() - t0 < (ctx.hitMs ?? 15000)) {
        if (ctx.signal && ctx.signal.aborted) break;
        e = entityOf(bot, ch.player);
        if (!e) break;
        if (e.position.distanceTo(bot.entity.position) > 3) {
          try { await withTimeout(lib.gotoGoal(bot, new goals.GoalNear(e.position.x, e.position.y, e.position.z, 2)), 5000, () => lib.haltPath(bot)); } catch (_) { /* 逃げられたら追い直す */ }
          continue;
        }
        try { await bot.lookAt(e.position.offset(0, (e.height || 1.8) * 0.6, 0), true); bot.attack(e); hits += 1; } catch (_) { break; }
        await sleep(ctx.hitGapMs ?? 650);
      }
      const gone = !entityOf(bot, ch.player);
      if (!hits) return { ok: false, msg: `${ch.player}を殴れなかった (近づけなかった)`, msgEn: `could not reach ${ch.player} to hit them`, hitPerson: { target: ch.player, hits: 0 } };
      return { ok: true, msg: `${ch.player}を${hits}回殴った${gone ? ' (姿が見えなくなった)' : ''}`, msgEn: `hit ${ch.player} ${hits} times`, hitPerson: { target: ch.player, hits, gone, retaliation: !!ch.retaliation } };
    },
  };
}

module.exports = { conflictHandlers, CONFLICT_TIMEOUTS };
