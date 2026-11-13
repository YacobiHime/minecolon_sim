'use strict';
// lure (動物を連れて行く) と enclose (周りを囲う) の実行 (actions_more.js の lureChoices / encloseChoices の選択肢)。
//   lure   : 餌を手に持ち、付いてくる動物 (TEMPT_RANGE 以内) を確かめながら、行き先へ少しずつ歩く。
//            結果: 付いてきた頭数・行き先に着いた頭数・歩いた距離。
//   enclose: 中心から (size+1)/2 離れた四角の1周 (4×size+4 か所) の地面の上に、柵・塀なら1段、ブロックなら2段置く。
//            柵の門を持っていれば南の辺の真ん中を門にする。もとから越えられない所は置かない。足りなければ置けた所まで。
//            結果: 置いた数・もとからあった数・置けなかった数・囲えたか (states.enclosedArea で中心から確かめる)。
//   歩く・置くは lib (act.js の gotoGoal 等) を使う。模擬の bot でも試せるように、bot の使う所は少なくしている。
const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const { sleep, withTimeout, dist3 } = require('./util');
const { TEMPT_RANGE } = require('./animals');
const { enclosedArea, isBarrier, isSolid } = require('./states');

const REPLACEABLE = /^(air|cave_air|void_air|snow|short_grass|grass|tall_grass|fern|large_fern|dead_bush|dandelion|poppy|.*_tulip|azure_bluet|oxeye_daisy|cornflower)$/;
const V = (p) => new Vec3(p.x, p.y, p.z);
const errText = (e) => String((e && e.message) || e).slice(0, 60);

function animalsNear(bot, name, pos, r) {
  return Object.values(bot.entities || {}).filter((e) => e && e !== bot.entity && e.name === name && e.position && dist3(e.position, pos) <= r);
}

// 四角の1周の (x, z)。歩く順 (北の辺 → 東 → 南 → 西)
function ringCells(center, size) {
  const r = (size + 1) / 2;
  const out = [];
  for (let dx = -r; dx < r; dx++) out.push({ dx, dz: -r });
  for (let dz = -r; dz < r; dz++) out.push({ dx: r, dz });
  for (let dx = r; dx > -r; dx--) out.push({ dx, dz: r });
  for (let dz = r; dz > -r; dz--) out.push({ dx: -r, dz });
  return out.map(({ dx, dz }) => ({ x: center.x + dx, z: center.z + dz, dx, dz, gate: dx === 0 && dz === r }));
}

// その列の地面の上 (置く高さ)。上から見て、空いている所の下が固いブロック
function groundY(blockAt, x, z, cy) {
  for (let y = cy + 2; y >= cy - 3; y--) {
    const b = blockAt(x, y, z); const below = blockAt(x, y - 1, z);
    if ((!b || REPLACEABLE.test(b.name) || isBarrier(b)) && below && (isSolid(below) || isBarrier(below))) return isBarrier(below) ? y - 1 : y;
  }
  return null;
}

function penHandlers(lib) {
  return {
    async lure(bot, ch, ctx) {
      const food = bot.inventory.items().find((i) => i.name === ch.food);
      if (!food) return { ok: false, msg: `${ch.food}を持っていない` };
      try { await bot.equip(food, 'hand'); } catch (e) { return { ok: false, msg: `${ch.food}を持てなかった: ${errText(e)}` }; }
      const dest = ch.dest;
      const start = bot.entity.position.clone();
      const range = ctx.temptRange ?? TEMPT_RANGE;
      let near = animalsNear(bot, ch.animal, bot.entity.position, range);
      // 近くにいなければ、いちばん近い1頭へ近づく
      if (!near.length) {
        const far = animalsNear(bot, ch.animal, bot.entity.position, ctx.visionRadius ?? 16).sort((a, b) => dist3(a.position, bot.entity.position) - dist3(b.position, bot.entity.position))[0];
        if (!far) return { ok: false, msg: `${ch.animal}が見えない`, lure: { followed: 0, arrived: 0, moved: 0 } };
        try { await withTimeout(lib.gotoGoal(bot, new goals.GoalNear(far.position.x, far.position.y, far.position.z, 4)), 15000, () => lib.haltPath(bot)); } catch (_) { /* そのまま */ }
        near = animalsNear(bot, ch.animal, bot.entity.position, range);
      }
      const ids = new Set(near.map((e) => e.id));
      const t0 = Date.now();
      const maxMs = ctx.lureMs ?? 60000;
      const stepLen = ctx.lureStep ?? 5;
      let lost = false; let err = '';
      while (dist3(bot.entity.position, dest) > 3 && Date.now() - t0 < maxMs) {
        if (ctx.signal && ctx.signal.aborted) break;
        // 付いてくる動物が近くに来るまで少し待つ (遠い動物を置いていかない)
        const w0 = Date.now();
        const followers = () => animalsNear(bot, ch.animal, bot.entity.position, range).filter((e) => ids.has(e.id) || ids.size === 0);
        while (Date.now() - w0 < (ctx.lureWaitMs ?? 3000) && !followers().some((e) => dist3(e.position, bot.entity.position) <= 4)) await sleep(250);
        const f = followers();
        if (!f.length) { lost = true; break; }
        for (const e of f) ids.add(e.id);
        const p = bot.entity.position;
        const d = dist3(p, dest);
        const k = Math.min(1, stepLen / Math.max(d, 1e-6));
        const wp = { x: p.x + (dest.x - p.x) * k, y: dest.y, z: p.z + (dest.z - p.z) * k };
        try { await withTimeout(lib.gotoGoal(bot, new goals.GoalNearXZ(wp.x, wp.z, 1)), 10000, () => lib.haltPath(bot)); } catch (e) { err = lib.pathErr ? lib.pathErr(e) : errText(e); break; }
      }
      await sleep(ctx.lureSettleMs ?? 1500);
      const moved = Math.round(dist3(start, bot.entity.position));
      const followed = animalsNear(bot, ch.animal, bot.entity.position, 6).filter((e) => ids.has(e.id)).length;
      const arrived = dist3(bot.entity.position, dest) <= 4 ? animalsNear(bot, ch.animal, dest, 5).length : 0;
      const where = ch.destId || '行き先';
      const lureRes = { followed, arrived, moved, lost, reached: dist3(bot.entity.position, dest) <= 4 };
      if (!ids.size) return { ok: false, msg: `${ch.food}を持ったが、${ch.animal}は付いてこなかった (${moved}m歩いた)`, lure: lureRes };
      const tail = lost ? ' (途中で付いてこなくなった)' : err ? ` (${err})` : lureRes.reached ? '' : ' (行き先まで着かなかった)';
      return { ok: arrived > 0, msg: `${ch.food}を持って${moved}m歩いた: ${ch.animal}が${followed}頭付いてきて、${where}の近くに${arrived}頭いる${tail}`, lure: lureRes };
    },

    async enclose(bot, ch, ctx) {
      const blockAt = (x, y, z) => bot.blockAt(new Vec3(x, y, z));
      const cells = ringCells(ch.center, ch.size);
      const height = ch.height || 1;
      let placed = 0; let existed = 0; let failed = 0; let gatePlaced = false; let lastErr = '';
      const have = (name) => bot.inventory.items().filter((i) => i.name === name).reduce((t, i) => t + i.count, 0);
      for (const c of cells) {
        if (ctx.signal && ctx.signal.aborted) break;
        const useGate = c.gate && ch.gate && have(ch.gate) > 0;
        const item = useGate ? ch.gate : ch.item;
        if (!have(item)) { if (!have(ch.item)) break; }
        const y0 = groundY(blockAt, c.x, c.z, ch.center.y);
        if (y0 == null) { failed += 1; lastErr = '地面が見つからない所があった'; continue; }
        for (let h = 0; h < height; h++) {
          const y = y0 + h;
          const b = blockAt(c.x, y, c.z);
          if (b && (isBarrier(b) || isSolid(b))) { existed += 1; continue; }
          const name = have(item) ? item : ch.item;
          if (!have(name)) { failed += 1; continue; }
          // 外側 (中心から離れる向き) に立って置く (囲いの中に自分を閉じ込めない)
          const ox = c.x + Math.sign(c.dx) * (Math.abs(c.dx) >= Math.abs(c.dz) ? 1 : 0);
          const oz = c.z + Math.sign(c.dz) * (Math.abs(c.dz) >= Math.abs(c.dx) ? 1 : 0);
          try {
            if (dist3(bot.entity.position, { x: c.x + 0.5, y, z: c.z + 0.5 }) > (ctx.placeReach ?? 4)) {
              await withTimeout(lib.gotoGoal(bot, new goals.GoalNear(ox, y, oz, 1)), ctx.perTargetMs ?? 10000, () => lib.haltPath(bot));
            }
            const fl = bot.entity.position.floored();
            if (fl.x === c.x && fl.z === c.z) { failed += 1; lastErr = '置く所に立っていた'; continue; }
            if (b && b.name !== 'air' && REPLACEABLE.test(b.name) && typeof bot.dig === 'function') { try { await bot.dig(b, true); } catch (_) { /* 草などは置けば消える */ } }
            const ref = blockAt(c.x, y - 1, c.z);
            const it = bot.inventory.items().find((i) => i.name === name);
            await bot.equip(it, 'hand');
            await bot.placeBlock(ref, new Vec3(0, 1, 0));
            placed += 1;
            if (name === ch.gate) gatePlaced = true;
          } catch (e) { failed += 1; lastErr = errText(e); }
        }
      }
      const total = cells.length * height;
      const left = total - placed - existed;
      const area = enclosedArea(blockAt, { x: ch.center.x + 0.5, y: groundY(blockAt, ch.center.x, ch.center.z, ch.center.y) ?? ch.center.y, z: ch.center.z + 0.5 }, { maxCells: (ch.size + 2) * (ch.size + 2) });
      const where = ch.place === '拠点' ? '拠点' : '今いた所';
      const res = { placed, existed, failed, left: Math.max(0, left), total, gate: gatePlaced, enclosed: area.enclosed };
      const tail = `${area.enclosed ? '中は囲われた' : 'すき間が残っている'}${gatePlaced ? '・門 1' : ''}${lastErr && failed ? ` (${lastErr})` : ''}`;
      if (!placed) return { ok: false, msg: `${where}の周り (内側${ch.size}x${ch.size}) に何も置けなかった: もとから${existed}か所・置けなかった${failed}か所。${tail}`, enclose: res };
      return { ok: true, msg: `${ch.item}で${where}の周り (内側${ch.size}x${ch.size}) を囲った: ${total}か所のうち${placed}個置いた (もとから${existed}・足りない/置けなかった${Math.max(0, left)})。${tail}`, enclose: res };
    },
  };
}

const PEN_TIMEOUTS = { lure: 90000, enclose: 180000 };

module.exports = { penHandlers, PEN_TIMEOUTS, ringCells, groundY };
