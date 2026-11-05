'use strict';
// actions_more.js の行動の実行 (右クリックで使う・GUI の出し入れ・協力)。
// act.js の handlers に足される。歩く・狙うはここ (プログラム) がやる。
// 結果は「何が変わったか」(ブロック・持ち物・乗り物) をそのまま書く。良し悪しは書かない
const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const { blockVisible } = require('./observe');
const { sleep, withTimeout, dist3 } = require('./util');
const { posKey, CONTAINER, FURNACE, TRADER, HAND } = require('./actions_more');

// 投げる・撃つ物 (右クリックで飛ぶ物)。生き物に使うときは離れて狙う
const PROJECTILE = /^(bow|crossbow|trident|snowball|egg|ender_pearl|splash_potion|lingering_potion|experience_bottle)$/;
// 弾の落ち方の目安 (距離 d で d*d*k だけ上を狙う)
const DROP_K = { bow: 0.0028, crossbow: 0.002, trident: 0.004 };
// 押し続ける時間 (ms)。食べる・飲むは 1.6 秒、弓は引ききるのに 1 秒
const HOLD_MS = { bow: 1100, trident: 1000, crossbow: 1300, shield: 3000, spyglass: 2000, goat_horn: 500, potion: 1800, milk_bucket: 1800, honey_bottle: 1800 };
const DEFAULT_HOLD = 1800;
// 向きはサーバーへ次の tick に送られる。向いてから使うまでの間
const LOOK_MS = 120;
const VEHICLE_ITEM = /_(boat|raft)$|minecart$/;
const FLUID = /^(water|lava)$/;
const hdist = (p, q) => Math.hypot(p.x + 0.5 - q.x, p.z + 0.5 - q.z);

const V = (p) => new Vec3(p.x, p.y, p.z);
const errText = (e) => String((e && e.message) || e).slice(0, 60);

function invMap(bot) {
  const m = {};
  for (const i of bot.inventory.items()) m[i.name] = (m[i.name] || 0) + i.count;
  // 体に着けた物・左手の物も数える (盾・防具を着けると「減った」に見えないように)
  for (const s of [5, 6, 7, 8, 45]) { const it = bot.inventory.slots[s]; if (it) m[it.name] = (m[it.name] || 0) + it.count; }
  return m;
}
function invDiff(a, b) {
  const out = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const d = (b[k] || 0) - (a[k] || 0);
    if (d) out.push({ name: k, d });
  }
  return out;
}
const diffText = (ds) => ds.map((x) => `${x.name}${x.d > 0 ? '+' : ''}${x.d}`).join(', ');

function props(b) { try { return b && typeof b.getProperties === 'function' ? b.getProperties() : {}; } catch (_) { return {}; } }

function snapshot(bot, pos, face) {
  const b = pos ? bot.blockAt(pos) : null;
  const n = pos && face ? bot.blockAt(pos.plus(face)) : null;
  return {
    block: b ? { name: b.name, state: b.stateId, props: props(b) } : null,
    nb: n ? n.name : null,
    inv: invMap(bot),
    vehicle: bot.vehicle ? (bot.vehicle.name || 'vehicle') : null,
    food: bot.food, health: bot.health,
  };
}

// 2つの様子の違いを文にする。変わっていなければ ''
function changeText(a, b, targetName) {
  const parts = [];
  if (a.block && b.block) {
    if (a.block.name !== b.block.name) parts.push(`${a.block.name}が${b.block.name}になった`);
    else if (a.block.state !== b.block.state) {
      const ch = Object.keys(b.block.props).filter((k) => String(a.block.props[k]) !== String(b.block.props[k]))
        .map((k) => `${k}:${a.block.props[k]}→${b.block.props[k]}`);
      parts.push(`${targetName || a.block.name}の様子が変わった${ch.length ? `(${ch.join(' ')})` : ''}`);
    }
  }
  if (a.nb !== b.nb && b.nb && !/^(air|cave_air)$/.test(b.nb)) parts.push(`隣に${b.nb}ができた`);
  else if (a.nb !== b.nb && a.nb && !/^(air|cave_air)$/.test(a.nb)) parts.push(`隣の${a.nb}が無くなった`);
  const d = invDiff(a.inv, b.inv);
  if (d.length) parts.push(`持ち物 ${diffText(d)}`);
  if (a.vehicle !== b.vehicle) parts.push(b.vehicle ? `${b.vehicle}に乗った` : '降りた');
  if (b.food > a.food) parts.push(`満腹${a.food}→${b.food}`);
  if (b.health !== a.health && Math.abs(b.health - a.health) >= 1) parts.push(`体力${Math.round(a.health)}→${Math.round(b.health)}`);
  return parts.join('、');
}

// 置く面: 上の面が空いていて目が上にあれば上の面 (地面・台の上に使う)。そうでなければ目に一番近い、空いている隣の面
function pickFace(bot, block) {
  const eye = bot.entity.position.offset(0, bot.entity.height ?? 1.62, 0);
  const up = bot.blockAt(block.position.offset(0, 1, 0));
  if ((!up || up.boundingBox !== 'block') && eye.y > block.position.y + 1) return new Vec3(0, 1, 0);
  const faces = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]].map((f) => new Vec3(...f));
  const c = block.position.offset(0.5, 0.5, 0.5);
  let best = new Vec3(0, 1, 0); let bd = Infinity;
  for (const f of faces) {
    const nb = bot.blockAt(block.position.plus(f));
    if (nb && nb.boundingBox === 'block') continue;
    const d = c.plus(f.scaled(0.5)).distanceTo(eye);
    if (d < bd) { bd = d; best = f; }
  }
  return best;
}

// mineflayer 4.37.1 は降りたとき (乗り物の乗客の一覧から自分が消えたとき) に bot.vehicle を消さない。ここで消す
function fixVehicleTracking(bot) {
  if (!bot._client || bot._vehicleFix) return;
  bot._vehicleFix = true;
  bot._client.on('set_passengers', ({ entityId, passengers }) => {
    if (bot.vehicle && bot.vehicle.id === entityId && bot.entity && !(passengers || []).includes(bot.entity.id)) {
      const v = bot.vehicle;
      bot.vehicle = null;
      bot.emit('dismount', v);
    }
  });
}

async function holdItem(bot, name) {
  if (name === HAND) {
    if (bot.heldItem) { try { await bot.unequip('hand'); } catch (_) { /* 持ち物が一杯なら持ったまま */ } }
    return true;
  }
  const it = bot.inventory.items().find((i) => i.name === name);
  if (!it) return false;
  await bot.equip(it, 'hand');
  return true;
}

// 開いた画面 (チェスト・村人など) を閉じる。入れ物なら中身を覚える
function closeAnyWindow(bot, ctx, pos, name) {
  const w = bot.currentWindow;
  if (!w) return '';
  let txt = '画面が開いた';
  try {
    if (pos && typeof w.containerItems === 'function') {
      const items = summarize(w.containerItems());
      noteContainer(ctx, pos, name, items);
      txt = `開いた (中身: ${items.length ? items.map((i) => `${i.name}x${i.count}`).join(', ') : '空'})`;
    }
  } catch (_) { /* ignore */ }
  try { bot.closeWindow(w); } catch (_) { /* ignore */ }
  return txt;
}

function summarize(items) {
  const m = new Map();
  for (const it of items || []) if (it) m.set(it.name, (m.get(it.name) || 0) + it.count);
  return [...m.entries()].map(([name, count]) => ({ name, count }));
}

// 入れ物の中身を覚える (memory.extra.containers["x,y,z"])。actions_more が chest_take / furnace_take の候補に使う
function noteContainer(ctx, pos, name, items) {
  if (!ctx || !ctx.memory) return;
  const ex = ctx.memory.extra || (ctx.memory.extra = {});
  ex.containers = ex.containers || {};
  ex.containers[posKey(pos)] = { name, items, tick: ctx.memory.tick ?? null };
}

function findBlockNear(bot, ch, ctx, re) {
  const p = ch.pos ? V(ch.pos) : null;
  let b = p ? bot.blockAt(p) : null;
  const want = ch.target || ch.block;
  const good = (x) => x && (re ? re.test(x.name) : x.name === want);
  if (good(b)) return b;
  const ps = bot.findBlocks({ matching: (x) => good(x), maxDistance: ctx.visionRadius ?? 16, count: 20 })
    .filter((q) => blockVisible(bot, q) || q.distanceTo(bot.entity.position) < 3);
  b = ps.length ? bot.blockAt(ps[0]) : null;
  return good(b) ? b : null;
}

function findEntity(bot, ch, ctx) {
  const byId = ch.entityId != null ? bot.entities[ch.entityId] : null;
  const want = ch.target;
  if (byId && byId.isValid !== false && (!want || byId.name === want)) return byId;
  let best = null; let bd = Infinity;
  for (const e of Object.values(bot.entities)) {
    if (!e || e === bot.entity || !e.position || (want && e.name !== want)) continue;
    const d = dist3(e.position, bot.entity.position);
    if (d < bd && d <= (ctx.visionRadius ?? 16)) { best = e; bd = d; }
  }
  return best;
}

function playerEntity(bot, name) {
  const p = bot.players && bot.players[name];
  return p && p.entity ? p.entity : null;
}

// 手が届き、狙うブロックの真上には立たない目標 (耕地を踏み荒らさない・自分の足元を狙わない)
class GoalReachNotOn extends goals.Goal {
  constructor(p, reach) { super(); this.x = p.x; this.y = p.y; this.z = p.z; this.reach = reach; }
  heuristic(n) { const dx = this.x - n.x; const dz = this.z - n.z; return Math.sqrt(dx * dx + dz * dz) + Math.abs(this.y - n.y); }
  isEnd(n) {
    if (n.x === this.x && n.z === this.z && n.y >= this.y && n.y <= this.y + 2) return false;
    const dx = this.x + 0.5 - (n.x + 0.5); const dy = this.y + 0.5 - (n.y + 1.62); const dz = this.z + 0.5 - (n.z + 0.5);
    return dx * dx + dy * dy + dz * dz <= this.reach * this.reach;
  }
}

// 水・溶岩の近くの、水・溶岩でない所に立つ目標 (水の中に立つと、ボートを置けない・すくえないことがある)
class GoalDryNear extends goals.Goal {
  constructor(bot, p, r) { super(); this.bot = bot; this.x = p.x; this.y = p.y; this.z = p.z; this.r = r; }
  heuristic(n) { const dx = this.x - n.x; const dz = this.z - n.z; return Math.sqrt(dx * dx + dz * dz) + Math.abs(this.y - n.y); }
  isEnd(n) {
    const dx = this.x - n.x; const dy = this.y - n.y; const dz = this.z - n.z;
    if (dx * dx + dy * dy + dz * dz > this.r * this.r) return false;
    const at = this.bot.blockAt(new Vec3(n.x, n.y, n.z));
    return !at || !FLUID.test(at.name);
  }
}

async function walkToBlock(lib, bot, b, ctx, reach = 4) {
  if (FLUID.test(b.name)) {
    try {
      await withTimeout(lib.gotoGoal(bot, new GoalDryNear(bot, b.position, 4)), ctx.perTargetMs ?? 15000, () => lib.haltPath(bot));
      return;
    } catch (_) { /* 乾いた所が無ければ近くへ */ }
  }
  const goal = b.boundingBox === 'block' ? new goals.GoalLookAtBlock(b.position, bot.world, { reach })
    : new goals.GoalNear(b.position.x, b.position.y, b.position.z, FLUID.test(b.name) ? 3 : 2);
  await withTimeout(lib.gotoGoal(bot, goal), ctx.perTargetMs ?? 15000, () => lib.haltPath(bot));
  // 狙うブロックの上 (か中) に立ってしまったら、隣へどく
  const f = bot.entity.position.floored();
  if (f.x === b.position.x && f.z === b.position.z && f.y >= b.position.y && f.y <= b.position.y + 2) {
    try { await withTimeout(lib.gotoGoal(bot, new GoalReachNotOn(b.position, reach)), 6000, () => lib.haltPath(bot)); } catch (_) { /* そのまま */ }
  }
}

// 動く相手に dist まで近づく (最大 ms)
async function approach(lib, bot, e, dist, ms, ctx) {
  const t0 = Date.now();
  while (e.isValid !== false && bot.entities[e.id] && dist3(e.position, bot.entity.position) > dist && Date.now() - t0 < ms) {
    if (ctx.signal && ctx.signal.aborted) break;
    const p = e.position;
    try { await withTimeout(lib.gotoGoal(bot, new goals.GoalNear(p.x, p.y, p.z, Math.max(1, dist - 1))), 5000, () => lib.haltPath(bot)); } catch (_) { /* 追い直す */ }
  }
  return dist3(e.position, bot.entity.position) <= dist + 0.5;
}

// 撃つ・投げる: いま向いている所 (aim があれば aim) へ
async function shoot(bot, item, aim) {
  const k = DROP_K[item] ?? 0.0067;
  const look = async () => {
    if (!aim) return;
    const d = dist3(aim, bot.entity.position);
    await bot.lookAt(aim.offset(0, d * d * k, 0), true); await sleep(LOOK_MS);
  };
  await look();
  if (item === 'crossbow') {
    bot.activateItem(); await sleep(HOLD_MS.crossbow); bot.deactivateItem(); await sleep(200);
    await look(); bot.activateItem(); await sleep(100); bot.deactivateItem();
    return;
  }
  bot.activateItem();
  await sleep(HOLD_MS[item] ?? 100);
  await look();
  bot.deactivateItem();
}

async function fishOnce(bot, ctx) {
  const ms = ctx.fishMs ?? 30000;
  try {
    await withTimeout(bot.fish(), ms, () => {});
    return '';
  } catch (e) {
    // 時間切れ: 釣り糸を巻き戻す
    try { bot.activateItem(); } catch (_) { /* ignore */ }
    return /timeout|時間/i.test(errText(e)) ? `${Math.round(ms / 1000)}秒待ったが掛からなかった` : errText(e);
  }
}

function moreHandlers(lib) {
  const h = {
    // use_on: 持ち物 (か素手) をブロック/生き物に使う
    async use_on(bot, ch, ctx) {
      fixVehicleTracking(bot);
      const item = ch.item;
      const itemTxt = item === HAND ? '素手' : item;
      if (item !== HAND && !bot.inventory.items().some((i) => i.name === item)) return { ok: false, msg: `${item}を持っていない` };
      if (ch.targetKind === 'entity') {
        const e = findEntity(bot, ch, ctx);
        if (!e) return { ok: false, msg: `${ch.target}が見えない` };
        if (PROJECTILE.test(item)) {
          if (dist3(e.position, bot.entity.position) > (ctx.shootRange ?? 15)) await approach(lib, bot, e, ctx.shootRange ?? 12, 10000, ctx);
          await holdItem(bot, item);
          const a = snapshot(bot);
          await shoot(bot, item, e.position.offset(0, (e.height || 1) * 0.6, 0));
          await sleep(1200);
          const gone = !bot.entities[e.id];
          const t = changeText(a, snapshot(bot));
          return { ok: !!t || gone, msg: `${itemTxt}を${ch.target}に向けて使った${t ? ': ' + t : ''}${gone ? ' (相手は見えなくなった)' : ''}` };
        }
        if (!(await approach(lib, bot, e, ctx.useReach ?? 3, 12000, ctx))) return { ok: false, msg: `${ch.target}に近づけなかった` };
        if (!(await holdItem(bot, item))) return { ok: false, msg: `${item}を持てなかった` };
        const a = snapshot(bot);
        await bot.activateEntity(e);
        await sleep(700);
        let win = closeAnyWindow(bot, ctx, null, null);
        let t = changeText(a, snapshot(bot));
        if (!t && !win && item !== HAND) {
          await bot.lookAt(e.position.offset(0, (e.height || 1) * 0.6, 0), true); await sleep(LOOK_MS);
          bot.activateItem(); await sleep(HOLD_MS[item] ?? DEFAULT_HOLD); bot.deactivateItem(); await sleep(400);
          win = closeAnyWindow(bot, ctx, null, null);
          t = changeText(a, snapshot(bot));
        }
        const res = [t, win].filter(Boolean).join('、');
        return { ok: !!res, msg: res ? `${itemTxt}を${ch.target}に使った: ${res}` : `${itemTxt}を${ch.target}に使ったが何も起きなかった` };
      }
      // ブロック
      let b = findBlockNear(bot, ch, ctx);
      if (!b) return { ok: false, msg: `${ch.target}が見えない` };
      try { await walkToBlock(lib, bot, b, ctx, 4); } catch (e) { return { ok: false, msg: `${ch.target}へ行けなかった: ${lib.pathErr(e)}` }; }
      // ボートは自分と重なる所には置けない (サーバーが断る)。水・溶岩は自分の足元の所を狙うとすくえないことがある。
      // 同じ種類のブロックで、少し離れた (ボートは 2.5m、水・溶岩は 1.5m 以上) 手の届く所を狙い直す
      const minD = VEHICLE_ITEM.test(item) ? 2.5 : FLUID.test(b.name) ? 1.5 : 0;
      if (minD && hdist(b.position, bot.entity.position) < minD) {
        const alt = bot.findBlocks({ matching: (x) => x && x.name === b.name, maxDistance: 6, count: 80 })
          .filter((q) => hdist(q, bot.entity.position) >= minD && q.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position.offset(0, 1.62, 0)) <= 4.5 && blockVisible(bot, q))
          .sort((q, r) => q.distanceTo(bot.entity.position) - r.distanceTo(bot.entity.position))[0];
        if (alt) b = bot.blockAt(alt);
      }
      if (b.position.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position.offset(0, 1.62, 0)) > 5) return { ok: false, msg: `${ch.target}に手が届かない` };
      if (!(await holdItem(bot, item))) return { ok: false, msg: `${item}を持てなかった` };
      const face = pickFace(bot, b);
      const facePt = b.position.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5);
      const a = snapshot(bot, b.position, face);
      if (item === 'fishing_rod') {
        await bot.lookAt(facePt, true); await sleep(LOOK_MS);
        const err = await fishOnce(bot, ctx);
        await sleep(800);
        const t = changeText(a, snapshot(bot, b.position, face));
        return { ok: !!t, msg: `釣り竿を${ch.target}に投げた${t ? ': ' + t : ''}${err ? ` (${err})` : ''}` };
      }
      if (PROJECTILE.test(item)) {
        await shoot(bot, item, facePt);
        await sleep(800);
        const t = changeText(a, snapshot(bot, b.position, face));
        return { ok: !!t, msg: `${itemTxt}を${ch.target}に向けて使った${t ? ': ' + t : ''}` };
      }
      const cursor = new Vec3(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5);
      await bot.lookAt(facePt, true); await sleep(LOOK_MS);
      await bot.activateBlock(b, face, cursor);
      await sleep(600);
      let win = closeAnyWindow(bot, ctx, b.position, b.name);
      let t = changeText(a, snapshot(bot, b.position, face), ch.target);
      // ブロックに使って何も起きなければ、狙ったまま持ち物そのものを使う (バケツで水をすくう・ボートを浮かべるなど)
      if (!t && !win && item !== HAND) {
        await bot.lookAt(facePt, true); await sleep(LOOK_MS);
        bot.activateItem(); await sleep(HOLD_MS[item] ?? 300); bot.deactivateItem(); await sleep(500);
        win = closeAnyWindow(bot, ctx, b.position, b.name);
        t = changeText(a, snapshot(bot, b.position, face), ch.target);
      }
      const res = [t, win].filter(Boolean).join('、');
      // 設備 (かまど・チェストなど) を置いたら場所を覚える (place と同じ)
      const nb = bot.blockAt(b.position.plus(face));
      if (ctx.memory && nb && nb.name !== a.nb && /^(furnace|crafting_table|chest|barrel|brewing_stand|enchanting_table|anvil|torch)$|_bed$/.test(nb.name)) {
        ctx.memory.notePlace(nb.name, nb.position, { imp: 0.8 });
      }
      const far = b.position.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position.offset(0, 1.62, 0)).toFixed(1);
      return { ok: !!res, msg: res ? `${itemTxt}を${ch.target}に使った: ${res}` : `${itemTxt}を${ch.target}(${b.position.x},${b.position.y},${b.position.z} ${far}m)に使ったが何も起きなかった${bot.entity.isInWater ? ' (自分は水の中)' : ''}` };
    },

    // use_item: その場で使う
    async use_item(bot, ch, ctx) {
      const item = ch.item;
      if (!bot.inventory.items().some((i) => i.name === item) && !(bot.inventory.slots[45] && bot.inventory.slots[45].name === item)) return { ok: false, msg: `${item}を持っていない` };
      const a = snapshot(bot);
      if (item === 'shield') {
        const it = bot.inventory.items().find((i) => i.name === 'shield');
        if (it) await bot.equip(it, 'off-hand');
        bot.activateItem(true);
        await sleep(ctx.shieldMs ?? HOLD_MS.shield);
        bot.deactivateItem();
        return { ok: true, msg: `盾を${Math.round((ctx.shieldMs ?? HOLD_MS.shield) / 1000)}秒構えた` };
      }
      await holdItem(bot, item);
      let err = '';
      if (item === 'fishing_rod') err = await fishOnce(bot, ctx);
      else if (PROJECTILE.test(item)) await shoot(bot, item, null);
      else { bot.activateItem(); await sleep(HOLD_MS[item] ?? DEFAULT_HOLD); bot.deactivateItem(); }
      await sleep(600);
      const win = closeAnyWindow(bot, ctx, null, null);
      const t = [changeText(a, snapshot(bot)), win].filter(Boolean).join('、');
      if (PROJECTILE.test(item) && !t) return { ok: false, msg: `${item}を使えなかった` };
      return { ok: !!t, msg: t ? `${item}を使った: ${t}${err ? ` (${err})` : ''}` : `${item}を使ったが何も起きなかった${err ? ` (${err})` : ''}` };
    },

    async dismount(bot) {
      fixVehicleTracking(bot);
      if (!bot.vehicle) return { ok: false, msg: '何にも乗っていない' };
      const v = bot.vehicle.name || '乗り物';
      // 降りる = 乗っているあいだスニークを押す。サーバーは次の tick に見るので、しばらく押し続ける
      try { bot.dismount(); } catch (_) { /* ignore */ }
      bot.setControlState('sneak', true);
      for (let i = 0; i < 20 && bot.vehicle; i++) {
        try { bot._client.write('steer_vehicle', { sideways: 0, forward: 0, jump: 0x02 }); } catch (_) { /* ignore */ }
        await sleep(100);
      }
      bot.setControlState('sneak', false);
      return bot.vehicle ? { ok: false, msg: `${v}から降りられなかった` } : { ok: true, msg: `${v}から降りた` };
    },

    async chest_put(bot, ch, ctx) {
      const b = findBlockNear(bot, ch, ctx, CONTAINER);
      if (!b) return { ok: false, msg: '入れ物が見えない' };
      const type = bot.registry.itemsByName[ch.item];
      const n = lib.invCount(bot, ch.item);
      if (!type || !n) return { ok: false, msg: `${ch.item}を持っていない` };
      try { await walkToBlock(lib, bot, b, ctx, 4); } catch (e) { return { ok: false, msg: `${b.name}へ行けなかった: ${lib.pathErr(e)}` }; }
      let w = null;
      try {
        w = await withTimeout(bot.openContainer(b), 8000, () => {});
        let err = '';
        try { await w.deposit(type.id, null, n); } catch (e) { err = /full/.test(errText(e)) ? '入れ物が一杯' : errText(e); }
        const items = summarize(w.containerItems());
        noteContainer(ctx, b.position, b.name, items);
        w.close();
        const put = n - lib.invCount(bot, ch.item);
        if (ctx.memory) ctx.memory.notePlace(b.name, b.position, { imp: 0.8 });
        const at = { x: b.position.x, y: b.position.y, z: b.position.z };
        if (!put) return { ok: false, msg: `${ch.item}を入れられなかった${err ? ': ' + err : ''}`, chest: { pos: at, items } };
        // chest: 入れ物の場所と中身 (agent が共有のチェストの中身を全員に知らせる・取り決めを数えるのに使う。board.js)
        return { ok: true, msg: `${b.name}に${ch.item}を${put}個入れた${err ? ` (${err})` : ''} (中身: ${items.map((i) => `${i.name}x${i.count}`).join(', ')})`, chest: { pos: at, items, item: ch.item, n: put } };
      } catch (e) {
        try { if (w) w.close(); } catch (_) { /* ignore */ }
        return { ok: false, msg: `${b.name}を開けなかった: ${errText(e)}` };
      }
    },

    async chest_take(bot, ch, ctx) {
      const b = findBlockNear(bot, ch, ctx, CONTAINER);
      if (!b) return { ok: false, msg: '入れ物が見えない' };
      try { await walkToBlock(lib, bot, b, ctx, 4); } catch (e) { return { ok: false, msg: `${b.name}へ行けなかった: ${lib.pathErr(e)}` }; }
      let w = null;
      try {
        w = await withTimeout(bot.openContainer(b), 8000, () => {});
        const before = summarize(w.containerItems());
        let took = 0; let err = '';
        if (!ch.look) {
          const type = bot.registry.itemsByName[ch.item];
          const have = (before.find((i) => i.name === ch.item) || {}).count || 0;
          if (type && have) {
            try { await w.withdraw(type.id, null, have); } catch (e) { err = /full/i.test(errText(e)) ? '持ち物が一杯' : errText(e); }
          }
        }
        const items = summarize(w.containerItems());
        noteContainer(ctx, b.position, b.name, items);
        w.close();
        // 持ち物の数は画面を閉じてから確かめる (開いているあいだは bot.inventory に反映されないことがある)
        if (!ch.look) {
          await sleep(300);
          const was = (before.find((i) => i.name === ch.item) || {}).count || 0;
          const now = (items.find((i) => i.name === ch.item) || {}).count || 0;
          took = Math.max(0, was - now);
        }
        if (ctx.memory) ctx.memory.notePlace(b.name, b.position, { imp: 0.8 });
        const content = items.length ? items.map((i) => `${i.name}x${i.count}`).join(', ') : '空';
        const at = { x: b.position.x, y: b.position.y, z: b.position.z };
        if (ch.look) return { ok: true, msg: `${b.name}を開けて見た (中身: ${content})`, chest: { pos: at, items } };
        if (!took) return { ok: false, msg: `${ch.item}を取り出せなかった${err ? ': ' + err : ''} (中身: ${content})`, chest: { pos: at, items } };
        return { ok: true, msg: `${b.name}から${ch.item}を${took}個取り出した${err ? ` (${err})` : ''} (残り: ${content})`, chest: { pos: at, items, item: ch.item, n: -took } };
      } catch (e) {
        try { if (w) w.close(); } catch (_) { /* ignore */ }
        return { ok: false, msg: `${b.name}を開けなかった: ${errText(e)}` };
      }
    },

    async furnace_take(bot, ch, ctx) {
      const b = findBlockNear(bot, ch, ctx, FURNACE);
      if (!b) return { ok: false, msg: 'かまどが見えない' };
      try { await walkToBlock(lib, bot, b, ctx, 4); } catch (e) { return { ok: false, msg: `${b.name}へ行けなかった: ${lib.pathErr(e)}` }; }
      let f = null;
      try {
        f = await withTimeout(bot.openFurnace(b), 8000, () => {});
        const a = invMap(bot);
        if (f.outputItem()) await f.takeOutput();
        if (ch.what === 'all') {
          if (f.inputItem()) await f.takeInput();
          if (f.fuelItem()) await f.takeFuel();
        }
        await sleep(300);
        const left = furnaceItems(f);
        noteContainer(ctx, b.position, b.name, left);
        f.close();
        const d = invDiff(a, invMap(bot)).filter((x) => x.d > 0);
        const rest = left.length ? ` (中に残り: ${left.map((i) => `${i.slot}:${i.name}x${i.count}`).join(', ')})` : ' (中は空)';
        if (!d.length) return { ok: false, msg: `${b.name}から取り出す物がなかった${rest}` };
        return { ok: true, msg: `${b.name}から ${diffText(d)} を取り出した${rest}` };
      } catch (e) {
        try { if (f) f.close(); } catch (_) { /* ignore */ }
        return { ok: false, msg: `${b.name}を開けなかった: ${errText(e)}` };
      }
    },

    async trade(bot, ch, ctx) {
      const e = bot.entities[ch.entityId] || findEntity(bot, { target: 'villager' }, ctx);
      if (!e || !TRADER.test(e.name)) return { ok: false, msg: '村人が見えない' };
      if (!(await approach(lib, bot, e, 3, 12000, ctx))) return { ok: false, msg: '村人に近づけなかった' };
      if (bot.heldItem) { try { await bot.unequip('hand'); } catch (_) { /* ignore */ } }
      let v = null;
      try {
        v = await withTimeout(bot.openVillager(e), 6000, () => {});
      } catch (err) {
        try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow); } catch (_) { /* ignore */ }
        noteTrades(ctx, e.id, []);
        return { ok: false, msg: `${e.name}は取引の画面を開かなかった (${errText(err)})` };
      }
      const list = (v.trades || []).map((t, i) => ({
        i, in1: itemOf(t.inputItem1, t.realPrice), in2: t.hasItem2 ? itemOf(t.inputItem2) : null, out: itemOf(t.outputItem),
        disabled: !!t.tradeDisabled || t.nbTradeUses >= t.maximumNbTradeUses,
      }));
      noteTrades(ctx, e.id, list);
      const { tradeText, hasInputs } = require('./actions_more');
      if (ch.look || ch.index == null) {
        v.close();
        return { ok: true, msg: `${e.name}の取引: ${list.length ? list.map((t) => `[${t.i}] ${tradeText(t)}${t.disabled ? ' (売り切れ)' : ''}`).join(' / ') : 'なし'}` };
      }
      const t = list[ch.index];
      if (!t) { v.close(); return { ok: false, msg: 'その取引はもう無い' }; }
      const inv = bot.inventory.items().map((i) => ({ name: i.name, count: i.count }));
      if (!hasInputs(inv, t)) { v.close(); return { ok: false, msg: `材料が足りない (${tradeText(t)})` }; }
      const a = invMap(bot);
      try {
        await withTimeout(bot.trade(v, ch.index, 1), 8000, () => {});
      } catch (err) {
        try { v.close(); } catch (_) { /* ignore */ }
        return { ok: false, msg: `取引できなかった: ${errText(err)}` };
      }
      try { v.close(); } catch (_) { /* ignore */ }
      await sleep(300);
      const d = invDiff(a, invMap(bot));
      return { ok: d.some((x) => x.d > 0), msg: `${e.name}と取引した (${tradeText(t)}): 持ち物 ${diffText(d) || '変わらない'}` };
    },

    async enchant(bot, ch, ctx) {
      const b = findBlockNear(bot, { pos: ch.pos }, ctx, /^enchanting_table$/);
      if (!b) return { ok: false, msg: 'エンチャント台が見えない' };
      try { await walkToBlock(lib, bot, b, ctx, 4); } catch (e) { return { ok: false, msg: `エンチャント台へ行けなかった: ${lib.pathErr(e)}` }; }
      const target = bot.inventory.items().find((i) => i.name === ch.item);
      const lapis = bot.inventory.items().find((i) => i.name === 'lapis_lazuli');
      if (!target || !lapis) return { ok: false, msg: `${target ? 'ラピスラズリ' : ch.item}を持っていない` };
      let t = null;
      try {
        t = await withTimeout(bot.openEnchantmentTable(b), 8000, () => {});
        // 画面の中の番号で動かす (持ち物の番号と画面の番号は違う)
        const wTarget = t.items().find((i) => i.name === ch.item);
        const wLapis = t.items().find((i) => i.name === 'lapis_lazuli');
        if (!wTarget || !wLapis) { t.close(); return { ok: false, msg: '台に置く物が見つからない' }; }
        await t.putTargetItem(wTarget);
        await t.putLapis(wLapis);
        const t0 = Date.now();
        while (Date.now() - t0 < 4000 && !(t.enchantments[ch.slot - 1].level > 0) && !t.enchantments.some((x) => x.level > 0 && Date.now() - t0 > 1500)) await sleep(200);
        const opts = t.enchantments.map((x) => x.level);
        const need = opts[ch.slot - 1];
        let msg = '';
        let ok = false;
        if (!(need > 0)) msg = `${ch.slot}段目は選べない (段ごとの必要レベル: ${opts.join('/')})`;
        else if ((bot.experience ? bot.experience.level : 0) < need) msg = `経験値レベルが足りない (${ch.slot}段目は${need}以上、今${bot.experience ? bot.experience.level : 0})`;
        else {
          // 出来上がりの知らせを待つ。知らせを取りこぼすことがあるので、台の上の物にエンチャントが付いたかも見る
          // mineflayer の enchant() は3段すべてが出るまで待つ (本棚が無いと3段目が出ず、待ち続ける)。知らせを直接送る
          let it = null;
          bot._client.write('enchant_item', { windowId: t.id, enchantment: ch.slot - 1 });
          const enchOf = (x) => { try { return x && x.enchants && x.enchants.length ? x.enchants : null; } catch (_) { return null; } };
          for (let k = 0; k < 20 && !enchOf(it); k++) { it = t.slots[0]; if (!enchOf(it)) await sleep(150); }
          const e = enchOf(it);
          ok = !!e;
          msg = e ? `${ch.item}にエンチャントした (${e.map((x) => `${x.name} ${x.lvl}`).join(', ')})` : `${ch.item}にエンチャントできなかった (段ごとの必要レベル: ${opts.join('/')}、台の上: ${t.slots[0] ? t.slots[0].name : 'なし'}、ラピス: ${t.slots[1] ? t.slots[1].count : 0})`;
        }
        try { if (t.targetItem()) await t.takeTargetItem(); } catch (_) { /* ignore */ }
        try { if (t.slots[1]) await bot.putAway(1); } catch (_) { /* ignore */ }
        t.close();
        return { ok, msg };
      } catch (e) {
        try { if (t) t.close(); } catch (_) { /* ignore */ }
        return { ok: false, msg: `エンチャントできなかった: ${errText(e)}` };
      }
    },

    async brew(bot, ch, ctx) {
      const b = findBlockNear(bot, { pos: ch.pos }, ctx, /^brewing_stand$/);
      if (!b) return { ok: false, msg: '醸造台が見えない' };
      try { await walkToBlock(lib, bot, b, ctx, 4); } catch (e) { return { ok: false, msg: `醸造台へ行けなかった: ${lib.pathErr(e)}` }; }
      let w = null;
      try {
        w = await withTimeout(bot.openBlock(b), 8000, () => {});
        if (!/brewing/.test(w.type)) { w.close(); return { ok: false, msg: `醸造台の画面ではなかった (${w.type})` }; }
        const inv = { sourceStart: w.inventoryStart, sourceEnd: w.inventoryEnd };
        const reg = bot.registry.itemsByName;
        const has = (n) => w.items().some((i) => i.name === n);
        const move = async (name, dest, count = 1) => bot.transfer({ window: w, itemType: reg[name].id, metadata: null, count, ...inv, destStart: dest, destEnd: dest + 1 });
        if (!w.slots[4] && has('blaze_powder')) await move('blaze_powder', 4, 1);
        let bottles = 0;
        for (let s = 0; s < 3; s++) {
          if (w.slots[s]) { bottles += 1; continue; }
          const pot = w.items().find((i) => /^(potion|splash_potion|lingering_potion)$/.test(i.name));
          if (!pot) break;
          await bot.transfer({ window: w, itemType: pot.type, metadata: null, nbt: pot.nbt, count: 1, ...inv, destStart: s, destEnd: s + 1 });
          bottles += 1;
        }
        if (!bottles) { w.close(); return { ok: false, msg: '瓶を入れられなかった' }; }
        if (!w.slots[4]) { w.close(); return { ok: false, msg: '燃料 (blaze_powder) が入っていない' }; }
        if (!w.slots[3]) await move(ch.item, 3, 1);
        const before = [0, 1, 2].map((s) => potionName(w.slots[s])).join('|');
        const t0 = Date.now();
        const waitMs = ctx.brewWaitMs ?? 25000;
        while (Date.now() - t0 < waitMs) {
          if (ctx.signal && ctx.signal.aborted) break;
          if ([0, 1, 2].map((s) => potionName(w.slots[s])).join('|') !== before) break;
          await sleep(500);
        }
        const after = [0, 1, 2].map((s) => potionName(w.slots[s])).filter(Boolean);
        const changed = [0, 1, 2].map((s) => potionName(w.slots[s])).join('|') !== before;
        for (let s = 0; s < 3; s++) if (w.slots[s]) { try { await bot.putAway(s); } catch (_) { /* ignore */ } }
        w.close();
        if (!changed) return { ok: false, msg: `${ch.item}を入れたが${Math.round(waitMs / 1000)}秒で変わらなかった (瓶は取り出した)` };
        return { ok: true, msg: `醸造した: ${after.join(', ')}` };
      } catch (e) {
        try { if (w) w.close(); } catch (_) { /* ignore */ }
        return { ok: false, msg: `醸造できなかった: ${errText(e)}` };
      }
    },

    async anvil(bot, ch, ctx) {
      const b = findBlockNear(bot, { pos: ch.pos }, ctx, /^(anvil|chipped_anvil|damaged_anvil)$/);
      if (!b) return { ok: false, msg: '金床が見えない' };
      const items = bot.inventory.items();
      const one = items.find((i) => i.name === ch.a);
      const two = items.find((i) => i.name === ch.b && i !== one);
      if (!one || !two) return { ok: false, msg: '合わせる物を2つ持っていない' };
      try { await walkToBlock(lib, bot, b, ctx, 4); } catch (e) { return { ok: false, msg: `金床へ行けなかった: ${lib.pathErr(e)}` }; }
      const a = invMap(bot);
      let w = null;
      try {
        // mineflayer の combine は費用の見積もりで断ることがあるので、2つを置いて、サーバーが出来上がりの枠に出した物を取る
        w = await withTimeout(bot.openBlock(b), 8000, () => {});
        if (!/anvil/.test(w.type)) { w.close(); return { ok: false, msg: `金床の画面ではなかった (${w.type})` }; }
        const inv = { sourceStart: w.inventoryStart, sourceEnd: w.inventoryEnd };
        const wi = w.items();
        const w1 = wi.find((i) => i.name === ch.a);
        const w2 = wi.find((i) => i.name === ch.b && i.slot !== w1.slot);
        await bot.moveSlotItem(w1.slot, 0);
        await bot.moveSlotItem(w2.slot, 1);
        const t0 = Date.now();
        while (!w.slots[2] && Date.now() - t0 < 2000) await sleep(100);
        let msg = '';
        let ok = false;
        if (w.slots[2]) {
          try { await bot.putAway(2); } catch (_) { /* ignore */ }
          await sleep(300);
          ok = !w.slots[2] && !w.slots[0];
          if (!ok) msg = `出来上がりを取れなかった (経験値レベル: 今${bot.experience ? bot.experience.level : '?'})`;
        } else msg = 'この2つは合わせられない (出来上がりの枠が空のまま)';
        for (const s of [0, 1, 2]) if (w.slots[s]) { try { await bot.putAway(s); } catch (_) { /* ignore */ } }
        try { w.close(); } catch (_) { /* ignore */ }
        await sleep(300);
        const dt = diffText(invDiff(a, invMap(bot)));
        return ok ? { ok, msg: `${ch.a}と${ch.b}を合わせた: 持ち物 ${dt || '変わらない'}` } : { ok, msg: `合わせられなかった: ${msg}` };
      } catch (e) {
        try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow); } catch (_) { /* ignore */ }
        return { ok: false, msg: `合わせられなかった: ${errText(e)}` };
      }
    },

    // follow: 人について行く (followMs のあいだ、2ブロックの所を保つ)
    async follow(bot, ch, ctx) {
      const e = playerEntity(bot, ch.player);
      if (!e) return { ok: false, msg: `${ch.player}が見えない` };
      const start = bot.entity.position.clone();
      const ms = ctx.followMs ?? 30000;
      bot.pathfinder.setGoal(new goals.GoalFollow(e, ctx.followRange ?? 2), true);
      const t0 = Date.now();
      let lost = false;
      while (Date.now() - t0 < ms) {
        if (ctx.signal && ctx.signal.aborted) break;
        if (!bot.entities[e.id]) { lost = true; break; }
        await sleep(300);
      }
      lib.haltPath(bot);
      const moved = Math.round(dist3(start, bot.entity.position));
      const left = bot.entities[e.id] ? Math.round(dist3(e.position, bot.entity.position)) : null;
      if (lost) return { ok: moved >= 2, msg: `${ch.player}について行ったが見失った (${moved}m動いた)` };
      return { ok: left != null && left <= 6, msg: `${ch.player}に${Math.round((Date.now() - t0) / 1000)}秒ついて行った (${moved}m動いた、今${left}m離れている)` };
    },

    // give: 人の近くへ行って投げ渡す
    async give(bot, ch, ctx) {
      const e = playerEntity(bot, ch.player);
      if (!e) return { ok: false, msg: `${ch.player}が見えない` };
      const type = bot.registry.itemsByName[ch.item];
      const have = lib.invCount(bot, ch.item);
      if (!type || !have) return { ok: false, msg: `${ch.item}を持っていない` };
      if (!(await approach(lib, bot, e, ctx.giveRange ?? 2, 15000, ctx))) return { ok: false, msg: `${ch.player}に近づけなかった` };
      const n = Math.min(have, ch.count || 1);
      try {
        // 相手の足元へ向けて投げる (投げた物は2秒たつと拾える。足元に落ちれば相手が拾う)
        await bot.lookAt(e.position.offset(0, 0.2, 0), true); await sleep(LOOK_MS);
        await bot.toss(type.id, null, n);
        // 投げた物は2秒たつと誰でも拾える。近い方が拾うので、投げたら少し下がる (自分で拾い直さないように)
        bot.setControlState('back', true);
        await sleep(ctx.giveBackMs ?? 700);
        bot.setControlState('back', false);
      } catch (err) { try { bot.setControlState('back', false); } catch (_) { /* ignore */ } return { ok: false, msg: `投げられなかった: ${errText(err)}` }; }
      await sleep(ctx.giveWaitMs ?? 3000);
      const still = Object.values(bot.entities).find((x) => x.name === 'item' && x.position && dist3(x.position, e.position) < 6 && (() => { try { const it = x.getDroppedItem(); return it && it.name === ch.item; } catch (_) { return false; } })());
      const back = lib.invCount(bot, ch.item) - (have - n); // 自分で拾い直した数
      const where = back > 0 ? ` (自分で${back}個拾い直した)` : still ? ` (まだ地面に落ちている、${ch.player}から${dist3(still.position, e.position).toFixed(1)}m)` : '';
      return { ok: back < n, msg: `${ch.player}に${ch.item}を${n}個投げ渡した${where}`, gave: { to: ch.player, item: ch.item, n, onGround: !!still, back } };
    },

    // call: 人を呼ぶ
    async call(bot, ch, ctx) {
      const p = bot.entity.position;
      const text = `${ch.player}、来て (${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)})`;
      const said = ctx.chat ? ctx.chat(text, { force: true }) : false;
      if (said === false) return { ok: false, msg: `${ch.player}を呼べなかった` };
      return { ok: true, msg: `「${text}」と呼んだ`, said: text };
    },
  };
  return h;
}

function itemOf(it, count) {
  if (!it || !it.name) return null;
  return { name: it.name, count: count ?? it.count };
}

function potionName(it) {
  if (!it) return null;
  let p = null;
  try { p = it.nbt && it.nbt.value && it.nbt.value.Potion ? it.nbt.value.Potion.value : null; } catch (_) { p = null; }
  return p ? `${it.name}(${String(p).replace(/^minecraft:/, '')})` : it.name;
}

function furnaceItems(f) {
  const out = [];
  const add = (slot, it) => { if (it) out.push({ slot, name: it.name, count: it.count }); };
  const get = (fn) => (typeof f[fn] === 'function' ? f[fn]() : null);
  add('焼く前', get('inputItem')); add('燃料', get('fuelItem')); add('出来上がり', get('outputItem'));
  return out;
}

function noteTrades(ctx, id, trades) {
  if (!ctx || !ctx.memory) return;
  const ex = ctx.memory.extra || (ctx.memory.extra = {});
  ex.trades = ex.trades || {};
  ex.trades[id] = { trades, tick: ctx.memory.tick ?? null };
}

const MORE_TIMEOUTS = { use_on: 45000, use_item: 40000, dismount: 5000, chest_put: 25000, chest_take: 25000, furnace_take: 25000, trade: 35000, enchant: 30000, brew: 60000, anvil: 25000, follow: 45000, give: 30000, call: 3000 };

module.exports = { moreHandlers, MORE_TIMEOUTS, changeText, invDiff, noteContainer, furnaceItems, potionName, PROJECTILE };
