'use strict';
// act: 選ばれた行動を mineflayer (+ pathfinder) で実行する。
// 返り値は { ok, msg } — msg は短い日本語で、そのまま記憶 (やったことと結果) に入る。
// 失敗も例外にせず結果として返す。1行動ごとにタイムアウトを設ける。
const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const { blockVisible } = require('./observe');
const { sleep, withTimeout, dist3 } = require('./util');

const DIR_VEC = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };
const REPLACEABLE = new Set(['air', 'cave_air', 'snow', 'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush']);
const DEFAULT_TIMEOUTS = { collect: 60000, go_to: 40000, explore: 40000, craft: 30000, place: 15000, eat: 10000, say: 3000, look_around: 5000, wait: 12000 };

function invTotal(bot) { return bot.inventory.items().reduce((s, i) => s + i.count, 0); }
function invCount(bot, name) { return bot.inventory.items().filter((i) => i.name === name).reduce((s, i) => s + i.count, 0); }

function pathErr(e) {
  const n = (e && (e.name || '')) + ' ' + (e && e.message || '');
  if (/NoPath|No path/i.test(n)) return '道が見つからない';
  if (/Timeout|timeout/i.test(n)) return '時間切れ';
  if (/GoalChanged|interrupted|stopped/i.test(n)) return '中断された';
  return (e && e.message ? e.message : String(e)).slice(0, 60);
}

// pathfinder.stop() は「次の goto」にまで効く旗を残すことがある (止めた後の explore が即失敗した)。
// 打ち切りには setGoal(null) を使う (動いている goto は GoalChanged で終わる)
function haltPath(bot) {
  try { bot.pathfinder.setGoal(null); } catch (_) { /* ignore */ }
  try { bot.clearControlStates(); } catch (_) { /* ignore */ }
}

async function gotoGoal(bot, goal) {
  await bot.pathfinder.goto(goal);
}

// 掘る速さが一番よい道具を持つ (なければ素手)
async function equipBestTool(bot, block) {
  let best = null;
  let bestTime = block.digTime(null, false, false, false, [], []);
  for (const it of bot.inventory.items()) {
    const t = block.digTime(it.type, false, false, false, [], []);
    if (t < bestTime) { best = it; bestTime = t; }
  }
  if (best) await bot.equip(best, 'hand');
}

async function pickUpNear(bot, pos) {
  await sleep(300);
  const drops = Object.values(bot.entities).filter((e) => e.name === 'item' && e.position.distanceTo(pos) < 5);
  for (const d of drops.slice(0, 3)) {
    try {
      await withTimeout(gotoGoal(bot, new goals.GoalNear(d.position.x, d.position.y, d.position.z, 0.8)), 6000, () => haltPath(bot));
    } catch (_) { /* 拾えなくても次へ */ }
  }
  await sleep(300);
}

const handlers = {
  async collect(bot, ch, ctx) {
    const name = ch.block;
    const type = bot.registry.blocksByName[name];
    if (!type) return { ok: false, msg: `${name} というブロックを知らない` };
    const want = ctx.collectCount ?? 3;
    const before = invTotal(bot);
    let dug = 0;
    let lastPos = null;
    let lastErr = '';
    const bad = new Set();
    for (let i = 0; i < want + 3; i++) {
      if (dug >= want) break;
      if (ctx.signal && ctx.signal.aborted) break;
      const feetY = Math.floor(bot.entity.position.y);
      const cands = bot.findBlocks({ matching: type.id, maxDistance: ctx.visionRadius ?? 16, count: 40 })
        // 見えているもの、または今掘った所のすぐ隣 (同じ木の幹など) だけを狙う
        .filter((p) => (lastPos && p.distanceTo(lastPos) <= 2.5) || blockVisible(bot, p))
        .filter((p) => p.y - feetY <= (ctx.maxReachUp ?? 4)) // 足場を積まないので、高すぎる所は狙わない
        .sort((a, b) => {
          const pa = Math.max(0, a.y - feetY - 3) * 4; const pb = Math.max(0, b.y - feetY - 3) * 4; // 高すぎる所は後回し
          return (a.distanceTo(bot.entity.position) + pa) - (b.distanceTo(bot.entity.position) + pb);
        });
      if (!cands.length) { lastErr = dug ? '' : `手の届く高さに${name}が見えない`; break; }
      const p = cands.find((q) => !bad.has(q.toString()));
      if (!p) { lastErr = lastErr || '届く所に見えない'; break; }
      try {
        // 1つの目標に長くかけない (届かない所の木で pathfinder が粘り続けるのを防ぐ)
        await withTimeout(gotoGoal(bot, new goals.GoalLookAtBlock(p, bot.world, { reach: 4.5 })), ctx.perTargetMs ?? 15000, () => haltPath(bot));
        const b = bot.blockAt(p);
        if (!b || b.name !== name) { bad.add(p.toString()); continue; }
        if (!bot.canDigBlock(b)) { lastErr = '手が届かない'; bad.add(p.toString()); continue; }
        await equipBestTool(bot, b);
        await bot.dig(b, true);
        dug += 1;
        lastPos = p;
        await pickUpNear(bot, p);
      } catch (e) {
        lastErr = pathErr(e);
        bad.add(p.toString());
        if (bad.size >= 3) break;
      }
    }
    const got = invTotal(bot) - before;
    if (dug === 0) return { ok: false, msg: lastErr || `${name}を掘れなかった` };
    return { ok: got > 0, msg: `${name}を${dug}個掘って${got}個拾った${lastErr ? '(' + lastErr + ')' : ''}` };
  },

  async go_to(bot, ch, ctx) {
    const p = ch.pos;
    try {
      await gotoGoal(bot, new goals.GoalNear(p.x, p.y, p.z, 2));
    } catch (e) {
      return { ok: false, msg: `${ch.kind || ch.player || ch.id}へ行けなかった: ${pathErr(e)}` };
    }
    if (ch.fromMemory && ch.kind && bot.registry.blocksByName[ch.kind]) {
      const still = bot.findBlock({ matching: bot.registry.blocksByName[ch.kind].id, maxDistance: 8 });
      if (!still) {
        if (ctx.memory) ctx.memory.forgetPlace(ch.kind, p);
        return { ok: false, msg: `着いたが${ch.kind}はもう無かった` };
      }
    }
    return { ok: true, msg: `${ch.kind || ch.player || ch.id}の所に着いた` };
  },

  async explore(bot, ch, ctx) {
    const [vx, vz] = DIR_VEC[ch.dir];
    const start = bot.entity.position.clone();
    const dist = ctx.exploreDistance ?? 20;
    let err = '';
    try {
      await gotoGoal(bot, new goals.GoalNearXZ(start.x + vx * dist, start.z + vz * dist, 3));
    } catch (e) { err = pathErr(e); }
    const moved = Math.round(dist3(start, bot.entity.position));
    if (moved < 4) return { ok: false, msg: `${ch.dir}へ進めなかった${err ? ': ' + err : ''}` };
    return { ok: true, msg: `${ch.dir}へ${moved}m進んだ${err ? '(' + err + ')' : ''}` };
  },

  async craft(bot, ch, ctx) {
    const item = bot.registry.itemsByName[ch.item];
    if (!item) return { ok: false, msg: `${ch.item}を知らない` };
    let table = null;
    if (ch.needsTable) {
      const tpos = bot.findBlocks({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: ctx.visionRadius ?? 16, count: 5 })
        .find((p) => blockVisible(bot, p) || p.distanceTo(bot.entity.position) < 4);
      if (!tpos) return { ok: false, msg: '近くに作業台が見えない' };
      try {
        await gotoGoal(bot, new goals.GoalNear(tpos.x, tpos.y, tpos.z, 2));
      } catch (e) { return { ok: false, msg: `作業台へ行けなかった: ${pathErr(e)}` }; }
      table = bot.blockAt(tpos);
    }
    const recipes = bot.recipesFor(item.id, null, 1, table);
    if (!recipes.length) return { ok: false, msg: `${ch.item}の材料が足りない${ch.needsTable ? '' : '(作業台が要るかも)'}` };
    const before = invCount(bot, ch.item);
    try {
      await bot.craft(recipes[0], 1, table);
    } catch (e) { return { ok: false, msg: `${ch.item}を作れなかった: ${String(e.message).slice(0, 50)}` }; }
    const made = invCount(bot, ch.item) - before;
    return { ok: made > 0, msg: `${ch.item}を${made}個作った` };
  },

  async place(bot, ch) {
    const it = bot.inventory.items().find((i) => i.name === ch.item);
    if (!it) return { ok: false, msg: `${ch.item}を持っていない` };
    const base = bot.entity.position.floored();
    const spots = [];
    for (const r of [1, 2]) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          for (const dy of [0, 1, -1]) spots.push(base.offset(dx, dy, dz));
        }
      }
    }
    for (const t of spots) {
      const tb = bot.blockAt(t);
      const below = bot.blockAt(t.offset(0, -1, 0));
      if (!tb || !below || !REPLACEABLE.has(tb.name) || below.boundingBox !== 'block') continue;
      const above = bot.blockAt(t.offset(0, 1, 0));
      if (above && above.boundingBox === 'block') continue;
      try {
        if (tb.name !== 'air' && tb.name !== 'cave_air') await bot.dig(tb, true); // 雪や草をどける
        await bot.equip(it, 'hand');
        await bot.placeBlock(below, new Vec3(0, 1, 0));
        return { ok: true, msg: `${ch.item}を(${t.x},${t.y},${t.z})に置いた` };
      } catch (e) {
        return { ok: false, msg: `${ch.item}を置けなかった: ${String(e.message).slice(0, 50)}` };
      }
    }
    return { ok: false, msg: '置ける場所が近くにない' };
  },

  async eat(bot, ch) {
    const it = bot.inventory.items().find((i) => i.name === ch.item);
    if (!it) return { ok: false, msg: `${ch.item}を持っていない` };
    try {
      await bot.equip(it, 'hand');
      await bot.consume();
      return { ok: true, msg: `${ch.item}を食べた` };
    } catch (e) { return { ok: false, msg: `食べられなかった: ${String(e.message).slice(0, 50)}` }; }
  },

  async say(bot, _ch, ctx) {
    ctx.chat(ctx.arg);
    return { ok: true, msg: `「${ctx.arg}」と言った` };
  },

  async look_around(bot) {
    const yaw0 = bot.entity.yaw;
    for (let i = 1; i <= 4; i++) { await bot.look(yaw0 + (Math.PI / 2) * i, 0, false); await sleep(300); }
    return { ok: true, msg: '周りを見回した' };
  },

  async wait(_bot, _ch, ctx) {
    const s = Number(ctx.arg) || 3;
    await sleep(s * 1000);
    return { ok: true, msg: `${s}秒待った` };
  },
};

async function executeAction(bot, resolved, ctx) {
  const h = handlers[resolved.action];
  if (!h) return { ok: false, msg: `実行できない行動: ${resolved.action}` };
  const ms = (ctx.timeouts && ctx.timeouts[resolved.action]) || DEFAULT_TIMEOUTS[resolved.action] || 30000;
  const signal = { aborted: false };
  try {
    return await withTimeout(h(bot, resolved.choice || {}, { ...ctx, arg: resolved.arg, signal }), ms, () => {
      signal.aborted = true;
      haltPath(bot);
      try { bot.stopDigging(); } catch (_) { /* ignore */ }
      bot.clearControlStates();
    });
  } catch (e) {
    return { ok: false, msg: `${resolved.action}が${pathErr(e)}` };
  }
}

module.exports = { executeAction, handlers, DEFAULT_TIMEOUTS };
