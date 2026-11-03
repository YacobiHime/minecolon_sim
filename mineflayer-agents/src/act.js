'use strict';
// act: 選ばれた行動を mineflayer (+ pathfinder) で実行する。
// 返り値は { ok, msg } — msg は短い日本語で、そのまま記憶 (やったことと結果) に入る。
// 失敗も例外にせず結果として返す。1行動ごとにタイムアウトを設ける。
const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const { blockVisible } = require('./observe');
const { sleep, withTimeout, dist3 } = require('./util');
const { hutSlots, hutStatus } = require('./hut');

const DIR_VEC = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };
const REPLACEABLE = new Set(['air', 'cave_air', 'snow', 'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush']);
const DEFAULT_TIMEOUTS = { collect: 60000, go_to: 40000, explore: 40000, craft: 30000, place: 15000, eat: 10000, say: 3000, look_around: 5000, wait: 12000, build: 60000, hunt: 40000, ask: 70000, pillar: 30000, pick_up: 25000 };
const FACES = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]];

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
    // 拠点の小屋の設計図の場所は掘らない (自分たちが置いた壁・屋根を素材として崩さない)
    const hutKeys = ctx.base ? new Set(hutSlots(ctx.base, ctx.hutShape || {}).map((s) => `${s.x},${s.y},${s.z}`)) : null;
    for (let i = 0; i < want + 3; i++) {
      if (dug >= want) break;
      if (ctx.signal && ctx.signal.aborted) break;
      const feetY = Math.floor(bot.entity.position.y);
      const cands = bot.findBlocks({ matching: type.id, maxDistance: ctx.visionRadius ?? 16, count: 40 })
        // 見えているもの、または今掘った所のすぐ隣 (同じ木の幹など) だけを狙う
        .filter((p) => (lastPos && p.distanceTo(lastPos) <= 2.5) || blockVisible(bot, p))
        .filter((p) => !hutKeys || !hutKeys.has(`${p.x},${p.y},${p.z}`))
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
    const label = ch.kind || ch.player || ch.id;
    const start = bot.entity.position.clone();
    try {
      await gotoGoal(bot, new goals.GoalNear(p.x, p.y, p.z, 2));
    } catch (e) {
      return { ok: false, msg: `${label}へ行けなかった: ${pathErr(e)}` };
    }
    // pathfinder は届かない目標でもすぐ終わることがある (真上の原木で、動かないまま「着いた」が 166 回続いた)。
    // 目標の近く (GoalNear の 2 + 余裕 1) に居なければ失敗として返す
    const left = dist3(bot.entity.position, p);
    if (left > (ctx.goToTolerance ?? 3)) {
      const moved = dist3(start, bot.entity.position);
      return { ok: false, msg: moved < 1 ? `${label}に近づけなかった (動けなかった)` : `${label}まで届かなかった (あと${Math.round(left)}m)` };
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

  // pillar: 目標の物の真下近くまで歩き、跳びながら足元にブロックを置いて ch.steps 段登る。
  // 降りるときは何もしない (足場は残す。次に歩くとき pathfinder が飛び降りる。4段までなので落下の傷は小さい)
  async pillar(bot, ch, ctx) {
    const t = ch.target;
    if (!t) return { ok: false, msg: '登る目標がない' };
    const startY = Math.floor(bot.entity.position.y);
    try {
      await withTimeout(gotoGoal(bot, new goals.GoalNearXZ(t.x + 0.5, t.z + 0.5, 1)), ctx.perTargetMs ?? 15000, () => haltPath(bot));
    } catch (e) { return { ok: false, msg: `${ch.block}の下へ行けなかった: ${pathErr(e)}` }; }
    haltPath(bot);
    const feet0 = Math.floor(bot.entity.position.y);
    const short = t.y - feet0 - (ctx.maxReachUp ?? 4);
    if (short <= 0) return { ok: true, msg: `登らなくても${ch.block}に手が届く所に来た` };
    const need = Math.min(ch.steps || 1, short, 4);
    let up = 0;
    let err = '';
    for (let i = 0; i < need; i++) {
      if (ctx.signal && ctx.signal.aborted) break;
      const it = bot.inventory.items().find((x) => x.name === ch.item);
      if (!it) { err = `${ch.item}が無くなった`; break; }
      const feet = bot.entity.position.floored();
      const head2 = bot.blockAt(feet.offset(0, 2, 0));
      if (head2 && head2.boundingBox === 'block') { err = '頭の上がふさがっている'; break; }
      const ref = bot.blockAt(feet.offset(0, -1, 0));
      if (!ref || ref.boundingBox !== 'block') { err = '足元が固くない'; break; }
      try {
        await bot.equip(it, 'hand');
        bot.setControlState('jump', true);
        const y0 = bot.entity.position.y;
        for (let k = 0; k < 20 && bot.entity.position.y < y0 + 1.0; k++) await sleep(25);
        await bot.placeBlock(ref, new Vec3(0, 1, 0));
        up += 1;
      } catch (e) {
        err = `置けなかった: ${String(e.message).slice(0, 40)}`;
        bot.setControlState('jump', false);
        break;
      }
      bot.setControlState('jump', false);
      for (let k = 0; k < 40 && !bot.entity.onGround; k++) await sleep(25);
      await sleep(100);
    }
    bot.setControlState('jump', false);
    const rose = Math.floor(bot.entity.position.y) - startY;
    if (up === 0) return { ok: false, msg: `登れなかった${err ? ': ' + err : ''}` };
    return { ok: true, msg: `${ch.item}を${up}個積んで${rose}段登った (${ch.block}に手が届くか collect で確かめる)${err ? '(' + err + ')' : ''}` };
  },

  // pick_up: 落ちている物の所へ歩いて拾う
  async pick_up(bot, ch, ctx) {
    const before = invCount(bot, ch.item);
    const find = () => {
      const byId = ch.entityId != null ? bot.entities[ch.entityId] : null;
      if (byId && byId.isValid !== false) return byId;
      let best = null; let bd = Infinity;
      for (const e of Object.values(bot.entities)) {
        if (!e || e.name !== 'item' || !e.position) continue;
        let n = null;
        try { const it = e.getDroppedItem && e.getDroppedItem(); n = it ? it.name : null; } catch (_) { n = null; }
        if (n !== ch.item) continue;
        const d = dist3(e.position, bot.entity.position);
        if (d < bd && d <= (ctx.visionRadius ?? 16)) { best = e; bd = d; }
      }
      return best;
    };
    let err = '';
    for (let i = 0; i < 2; i++) {
      const e = find();
      if (!e) break;
      try {
        await withTimeout(gotoGoal(bot, new goals.GoalNear(e.position.x, e.position.y, e.position.z, 0.8)), ctx.perTargetMs ?? 15000, () => haltPath(bot));
      } catch (er) { err = pathErr(er); }
      await sleep(500);
      if (invCount(bot, ch.item) > before) break;
    }
    const got = invCount(bot, ch.item) - before;
    if (got > 0) return { ok: true, msg: `${ch.item}を${got}個拾った` };
    return { ok: false, msg: `${ch.item}を拾えなかった${err ? ': ' + err : ''}` };
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

  // 拠点の小屋: 設計図の空いている所のうち、隣に支えがある所へ ctx.buildPerAction 個まで置く
  async build(bot, ch, ctx) {
    if (!ctx.base) return { ok: false, msg: '拠点の場所を知らない' };
    const slots = hutSlots(ctx.base, ctx.hutShape || {});
    const per = ctx.buildPerAction ?? 4;
    const skip = new Set();
    let placed = 0;
    let lastErr = '';
    const nameAt = (p) => { const b = bot.blockAt(new Vec3(p.x, p.y, p.z)); return b ? b.name : null; };
    for (let tries = 0; tries < per + 6 && placed < per; tries++) {
      if (ctx.signal && ctx.signal.aborted) break;
      const it = bot.inventory.items().find((i) => i.name === ch.item);
      if (!it) { lastErr = lastErr || `${ch.item}が無くなった`; break; }
      const st = hutStatus(slots, nameAt);
      if (!st.empty.length) return { ok: placed > 0, msg: placed ? `小屋に${placed}個置いて、小屋ができた` : '小屋はもうできている', placed };
      let target = null;
      let ref = null;
      for (const sl of st.empty) {
        const key = `${sl.x},${sl.y},${sl.z}`;
        if (skip.has(key)) continue;
        for (const [dx, dy, dz] of FACES) {
          const rb = bot.blockAt(new Vec3(sl.x + dx, sl.y + dy, sl.z + dz));
          if (rb && rb.boundingBox === 'block') { target = sl; ref = rb; break; }
        }
        if (target) break;
      }
      if (!target) { lastErr = '支えがなく置ける所がない'; break; }
      const tv = new Vec3(target.x, target.y, target.z);
      const key = `${target.x},${target.y},${target.z}`;
      try {
        await withTimeout(gotoGoal(bot, new goals.GoalPlaceBlock(tv, bot.world, { range: 4.5, LOS: false })), ctx.perTargetMs ?? 15000, () => haltPath(bot));
        const cur = bot.blockAt(tv);
        if (cur && cur.name !== 'air' && cur.name !== 'cave_air' && cur.boundingBox !== 'block') await bot.dig(cur, true); // 草や雪をどける
        await bot.equip(it, 'hand');
        await bot.placeBlock(ref, tv.minus(ref.position));
        placed += 1;
      } catch (e) {
        lastErr = pathErr(e);
        skip.add(key);
      }
    }
    const st = hutStatus(slots, nameAt);
    const pct = st.ratio == null ? '' : ` (小屋は${Math.round(st.ratio * 100)}%)`;
    if (!placed) return { ok: false, msg: `小屋に置けなかった: ${lastErr || '理由不明'}${pct}`, placed };
    return { ok: true, msg: `小屋に${ch.item}を${placed}個置いた${pct}`, placed };
  },

  // 動物を追いかけて倒し、落ちた物を拾う
  async hunt(bot, ch, ctx) {
    const before = invTotal(bot);
    const find = () => Object.values(bot.entities).filter((e) => e.name === ch.mob && e.position && e.position.distanceTo(bot.entity.position) <= (ctx.visionRadius ?? 16))
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
    const target = find();
    if (!target) return { ok: false, msg: `${ch.mob}が見えない` };
    let last = target.position.clone();
    let hits = 0;
    const t0 = Date.now();
    while (bot.entities[target.id] && Date.now() - t0 < (ctx.huntMs ?? 30000)) {
      if (ctx.signal && ctx.signal.aborted) break;
      last = target.position.clone();
      if (target.position.distanceTo(bot.entity.position) > 2.8) {
        try { await withTimeout(gotoGoal(bot, new goals.GoalNear(last.x, last.y, last.z, 1.5)), 5000, () => haltPath(bot)); } catch (_) { /* 逃げられたら追い直す */ }
        continue;
      }
      try { await bot.lookAt(target.position.offset(0, (target.height || 1) * 0.5, 0), true); bot.attack(target); hits += 1; } catch (_) { /* ignore */ }
      await sleep(650);
    }
    if (bot.entities[target.id]) return { ok: false, msg: `${ch.mob}を倒せなかった(${hits}回たたいた)` };
    await pickUpNear(bot, last);
    const got = invTotal(bot) - before;
    return { ok: got > 0, msg: got > 0 ? `${ch.mob}を倒して${got}個拾った` : `${ch.mob}を倒したが何も拾えなかった` };
  },

  // 近くの人に聞く。チャットで聞き、答えを待つ部分は agent が持つ (ctx.ask)
  async ask(_bot, ch, ctx) {
    if (!ctx.ask) return { ok: false, msg: '聞く仕組みがない' };
    return ctx.ask(ch);
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
