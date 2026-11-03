'use strict';
// act: 選ばれた行動を mineflayer (+ pathfinder) で実行する。
// 返り値は { ok, msg } — msg は短い日本語で、そのまま記憶 (やったことと結果) に入る。
// 失敗も例外にせず結果として返す。1行動ごとにタイムアウトを設ける。
const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const { blockVisible, HOSTILE, cropRipe } = require('./observe');
const { sleep, withTimeout, dist3 } = require('./util');
const { hutSlots, hutStatus } = require('./hut');
const { exploreTarget } = require('./explore');
const { moreHandlers, MORE_TIMEOUTS, noteContainer, furnaceItems, invDiff } = require('./act_more');

const DIR_VEC = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };
const REPLACEABLE = new Set(['air', 'cave_air', 'snow', 'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush']);
const DEFAULT_TIMEOUTS = { collect: 60000, go_to: 40000, explore: 40000, craft: 30000, place: 15000, eat: 10000, say: 3000, look_around: 5000, wait: 12000, build: 60000, hunt: 40000, ask: 70000, pillar: 30000, pick_up: 25000,
  attack: 40000, flee: 15000, smelt: 50000, sleep: 40000, equip: 5000, set_base: 2000, ...MORE_TIMEOUTS };
const MAT_RANK = { netherite: 6, diamond: 5, iron: 4, stone: 3, golden: 2, wooden: 1 };
const ARMOR_DEST = { helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' };

// いちばん強い武器 (剣 > 斧、素材の順)。無ければ null (素手)
function bestWeapon(bot) {
  let best = null; let bs = 0;
  for (const it of bot.inventory.items()) {
    const m = it.name.match(/^(\w+?)_(sword|axe)$/);
    if (!m) continue;
    const sc = (MAT_RANK[m[1]] || 0) * 2 + (m[2] === 'sword' ? 1 : 0);
    if (sc > bs) { best = it; bs = sc; }
  }
  return best;
}
const FACES = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]];

// 置く面に目から視線が通り、手が届くか (見えない面・壁の向こうには置かない)
function faceReachable(bot, refBlock, face, reach = 4.5) {
  const eye = bot.entity.position.offset(0, bot.entity.height ?? 1.62, 0);
  const pt = refBlock.position.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5);
  const d = pt.minus(eye);
  const len = d.norm();
  if (len > reach) return false;
  if (!bot.world || typeof bot.world.raycast !== 'function' || len < 1e-6) return true;
  const hit = bot.world.raycast(eye, d.scaled(1 / len), len + 0.5);
  return !!hit && hit.position.equals(refBlock.position);
}

// 掘ったときに落ちる物の名前 (石 → 丸石、鉱石 → 原石など。分からなければ同じ名前)
const DROPS = { stone: 'cobblestone', grass_block: 'dirt', coal_ore: 'coal', deepslate_coal_ore: 'coal', iron_ore: 'raw_iron', deepslate_iron_ore: 'raw_iron',
  copper_ore: 'raw_copper', gold_ore: 'raw_gold', diamond_ore: 'diamond', redstone_ore: 'redstone', lapis_ore: 'lapis_lazuli', deepslate: 'cobbled_deepslate',
  carrots: 'carrot', potatoes: 'potato', beetroots: 'beetroot', melon: 'melon_slice', grass: 'wheat_seeds', short_grass: 'wheat_seeds', sweet_berry_bush: 'sweet_berries' };
function dropName(_bot, name) { return DROPS[name] || name; }

function invMapAll(bot) { const m = {}; for (const i of bot.inventory.items()) m[i.name] = (m[i.name] || 0) + i.count; return m; }
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

// 右クリックで開く・動く物 (この上に置こうとすると、置かずに開いてしまう)
const INTERACTIVE = /^(furnace|blast_furnace|smoker|crafting_table|chest|trapped_chest|barrel|ender_chest|anvil|enchanting_table|hopper|dispenser|dropper|lever|note_block|loom|lectern|brewing_stand|cartography_table|grindstone|smithing_table|stonecutter|bell|cake)$|_(bed|door|trapdoor|button|fence_gate|sign|shulker_box)$/;

async function pickUpNear(bot, pos, waitMs = 1500) {
  // 倒した動物の落とし物は少し遅れて出る (死ぬ動きのあと)。出るまで最大 waitMs 待つ
  let drops = [];
  const t0 = Date.now();
  do {
    await sleep(250);
    drops = Object.values(bot.entities).filter((e) => e.name === 'item' && e.position && e.position.distanceTo(pos) < 5);
  } while (!drops.length && Date.now() - t0 < waitMs);
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
    const beforeItem = invCount(bot, dropName(bot, name));
    const beforeAll = invMapAll(bot);
    // 作物は育ちきった所を先に掘る (育ちきった物が見えていればそれだけ)
    const ripeOf = (p) => { const b = bot.blockAt(p); return b ? cropRipe(bot, b) : null; };
    let dug = 0;
    let lastPos = null;
    let lastErr = '';
    const bad = new Set();
    // 拠点の小屋の設計図の場所は掘らない (自分たちが置いた壁・屋根を素材として崩さない)
    const hutKeys = ctx.base && ctx.hutShape ? new Set(hutSlots(ctx.base, ctx.hutShape).map((s) => `${s.x},${s.y},${s.z}`)) : null;
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
      const ripeC = cands.filter((q) => ripeOf(q) === true);
      if (ripeC.length) cands.splice(0, cands.length, ...ripeC);
      else if (dug > 0 && cands.some((q) => ripeOf(q) === false)) break; // 育ちきった物を掘り終えたら、育ち途中の物は掘らない
      const p = cands.find((q) => !bad.has(q.toString()));
      if (!p) { lastErr = lastErr || '届く所に見えない'; break; }
      try {
        // 1つの目標に長くかけない (届かない所の木で pathfinder が粘り続けるのを防ぐ)
        // 当たり判定の無いブロック (作物・草など) は GoalLookAtBlock の視線の判定が通らないので、近くまで歩く
        const b0 = bot.blockAt(p);
        const goal = b0 && b0.boundingBox !== 'block' ? new goals.GoalNear(p.x, p.y, p.z, 2) : new goals.GoalLookAtBlock(p, bot.world, { reach: 4.5 });
        await withTimeout(gotoGoal(bot, goal), ctx.perTargetMs ?? 15000, () => haltPath(bot));
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
    // 拾った数は掘った物だけで数える (pathfinder が足場に土などを使うと、持ち物の合計が減ることがある)
    const got = invCount(bot, dropName(bot, name)) - beforeItem;
    if (dug === 0) return { ok: false, msg: lastErr || `${name}を掘れなかった` };
    // 名前の違う物が落ちることがある (草 → 種、小麦 → 小麦と種、にんじん → carrot)。増えた物を全部書く
    const gained = invDiff(beforeAll, invMapAll(bot)).filter((x) => x.d > 0);
    const other = gained.filter((x) => x.name !== dropName(bot, name));
    const otherTxt = other.length ? ` (${other.map((x) => `${x.name}+${x.d}`).join(', ')})` : '';
    return { ok: got > 0 || other.length > 0, msg: `${name}を${dug}個掘って${got}個拾った${otherTxt}${lastErr ? '(' + lastErr + ')' : ''}` };
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
    const start = bot.entity.position.clone();
    const c = ch.kind ? ch : { ...ch, kind: 'dir', vec: DIR_VEC[ch.dir], dist: ctx.exploreDistance ?? 20 };
    const t = exploreTarget(start, c);
    let err = '';
    try {
      await gotoGoal(bot, new goals.GoalNearXZ(t.x, t.z, 3));
    } catch (e) { err = pathErr(e); }
    const end = bot.entity.position;
    const moved = Math.round(dist3(start, end));
    // 着いたマスが新しいか (このループの観測より前に判定する。記憶のマスは次の観測で更新される)
    let newCell = null; let cell = null;
    if (ctx.memory && typeof ctx.memory.cellOf === 'function') {
      const k = ctx.memory.cellOf(end);
      const known = ctx.memory.cellAt(k.cx, k.cz);
      newCell = !(known && known.n);
      cell = [k.cx, k.cz];
    }
    const explore = { kind: c.kind, id: ch.id || ch.dir || null, dirJp: t.dirJp, planned: t.dist, target: { x: Math.round(t.x), z: Math.round(t.z) }, moved, newCell, cell };
    // basic (東西南北、label = dir) はこれまでどおり英語の方角、varied は日本語の方角
    const where = c.kind === 'unvisited' ? 'まだ行っていないマスの方' : c.kind === 'random' ? `でたらめに${t.dirJp}` : (!ch.label || ch.label === ch.dir ? ch.dir : t.dirJp);
    const tag = newCell == null ? '' : newCell ? ' 新しいマス' : ' 行ったことのあるマス';
    if (moved < 4) return { ok: false, msg: `${where}へ進めなかった${err ? ': ' + err : ''}`, explore };
    return { ok: true, msg: `${where}へ${moved}m進んだ${tag}${err ? '(' + err + ')' : ''}`, explore };
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
      // 跳んで、足が置く所 (元の足の高さ) より十分上に来てから置く。届かなければ着地してやり直す (最大3回)
      let placedOne = false;
      for (let attempt = 0; attempt < 3 && !placedOne; attempt++) {
        try {
          await bot.equip(it, 'hand');
          for (let k = 0; k < 40 && !bot.entity.onGround; k++) await sleep(25);
          const y0 = Math.floor(bot.entity.position.y);
          bot.setControlState('jump', true);
          for (let k = 0; k < 24 && bot.entity.position.y < y0 + 1.15; k++) await sleep(25);
          if (bot.entity.position.y < y0 + 1.15) { bot.setControlState('jump', false); err = '跳び上がれなかった'; continue; }
          await bot.placeBlock(ref, new Vec3(0, 1, 0));
          placedOne = true;
          up += 1;
        } catch (e) {
          err = `置けなかった: ${String(e.message).slice(0, 40)}`;
          // 知らせが遅れただけで置けていることがある
          const nb = bot.blockAt(ref.position.offset(0, 1, 0));
          if (nb && nb.boundingBox === 'block') { placedOne = true; up += 1; err = ''; }
        }
        bot.setControlState('jump', false);
        for (let k = 0; k < 40 && !bot.entity.onGround; k++) await sleep(25);
      }
      if (!placedOne) break;
      await sleep(100);
    }
    bot.setControlState('jump', false);
    const rose = Math.floor(bot.entity.position.y) - startY;
    if (up === 0) return { ok: false, msg: `登れなかった${err ? ': ' + err : ''}` };
    return { ok: true, msg: `${ch.item}を${up}個積んで${rose}段登った${err ? '(' + err + ')' : ''}` };
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

  async place(bot, ch, ctx = {}) {
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
      if (!tb || !below || !REPLACEABLE.has(tb.name) || below.boundingBox !== 'block' || INTERACTIVE.test(below.name)) continue;
      const above = bot.blockAt(t.offset(0, 1, 0));
      if (above && above.boundingBox === 'block') continue;
      if (!faceReachable(bot, below, new Vec3(0, 1, 0))) continue; // 見えない面・届かない所には置かない
      // ベッドは向いている方へ2マス使う (足 → 頭)。斜めの所は向きが決まらないので使わず、頭の側も空いていて下が固いことを確かめる
      if (/_bed$/.test(ch.item)) {
        const dx = t.x - base.x; const dz = t.z - base.z;
        if (Math.abs(dx) === Math.abs(dz)) continue;
        const head = Math.abs(dx) > Math.abs(dz) ? t.offset(Math.sign(dx), 0, 0) : t.offset(0, 0, Math.sign(dz));
        const hb = bot.blockAt(head); const hbelow = bot.blockAt(head.offset(0, -1, 0));
        if (!hb || !REPLACEABLE.has(hb.name) || !hbelow || hbelow.boundingBox !== 'block') continue;
      }
      try {
        if (tb.name !== 'air' && tb.name !== 'cave_air') await bot.dig(tb, true); // 雪や草をどける
        await bot.equip(it, 'hand');
        await bot.placeBlock(below, new Vec3(0, 1, 0));
        // 置いた設備 (かまど・作業台・チェスト・ベッド・松明) の場所は覚える
        if (ctx.memory && /^(furnace|crafting_table|chest|torch)$|_bed$/.test(ch.item)) ctx.memory.notePlace(ch.item, t, { imp: 0.8 });
        return { ok: true, msg: `${ch.item}を(${t.x},${t.y},${t.z})に置いた`, placedItem: ch.item };
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
        await withTimeout(gotoGoal(bot, new goals.GoalPlaceBlock(tv, bot.world, { range: 4.5, LOS: true })), ctx.perTargetMs ?? 15000, () => haltPath(bot));
        const cur = bot.blockAt(tv);
        if (cur && cur.name !== 'air' && cur.name !== 'cave_air' && cur.boundingBox !== 'block') await bot.dig(cur, true); // 草や雪をどける
        if (!faceReachable(bot, ref, tv.minus(ref.position))) { lastErr = '置く面が見えない・届かない'; skip.add(key); continue; }
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

  // attack: 敵か動物を攻撃する。いちばん強い武器を持ってから追いかけてたたく。倒したら落ちた物を拾う
  async attack(bot, ch, ctx) {
    const w = bestWeapon(bot);
    if (w) { try { await bot.equip(w, 'hand'); } catch (_) { /* 素手で */ } }
    const r = await handlers.hunt(bot, ch, { ...ctx, huntMs: ctx.attackMs ?? 30000 });
    return { ...r, msg: `${w ? w.name + 'で' : '素手で'}${r.msg}`, weapon: w ? w.name : null };
  },

  // flee: 近くの敵の反対の方へ走る (fleeDistance ブロック)
  async flee(bot, ch, ctx) {
    const here = bot.entity.position;
    const from = (ch.from && ch.from.length) ? ch.from : Object.values(bot.entities).filter((e) => HOSTILE.has(e.name) && e.position && dist3(e.position, here) <= 16).map((e) => e.position);
    if (!from.length) return { ok: false, msg: '逃げる相手が見えない' };
    let vx = 0; let vz = 0;
    for (const p of from) { const dx = here.x - p.x; const dz = here.z - p.z; const l = Math.hypot(dx, dz) || 1; vx += dx / l; vz += dz / l; }
    const l = Math.hypot(vx, vz) || 1;
    const dist = ctx.fleeDistance ?? 16;
    const start = here.clone();
    try { bot.setControlState('sprint', true); } catch (_) { /* ignore */ }
    let err = '';
    try { await gotoGoal(bot, new goals.GoalNearXZ(start.x + (vx / l) * dist, start.z + (vz / l) * dist, 3)); } catch (e) { err = pathErr(e); }
    try { bot.setControlState('sprint', false); } catch (_) { /* ignore */ }
    const moved = Math.round(dist3(start, bot.entity.position));
    if (moved < 4) return { ok: false, msg: `逃げられなかった${err ? ': ' + err : ''}` };
    return { ok: true, msg: `敵から${moved}m離れた` };
  },

  // smelt: かまどに燃料と焼く物を入れ、焼けるまで最大 smeltWaitMs 待って取り出す。終わらなければ入れたまま離れる
  async smelt(bot, ch, ctx) {
    const p = ch.furnace;
    const fb = p && bot.blockAt(new Vec3(p.x, p.y, p.z));
    if (!fb || fb.name !== 'furnace') return { ok: false, msg: 'かまどが見当たらない' };
    try {
      await withTimeout(gotoGoal(bot, new goals.GoalLookAtBlock(fb.position, bot.world, { reach: 4 })), ctx.perTargetMs ?? 15000, () => haltPath(bot));
    } catch (e) { return { ok: false, msg: `かまどへ行けなかった: ${pathErr(e)}` }; }
    if (ctx.memory) ctx.memory.notePlace('furnace', fb.position, { imp: 0.8 });
    const reg = bot.registry;
    const input = reg.itemsByName[ch.item];
    const fuel = reg.itemsByName[ch.fuel];
    if (!input || !fuel) return { ok: false, msg: '焼く物か燃料を知らない' };
    const n = Math.min(invCount(bot, ch.item), ctx.smeltMax ?? 3);
    if (n <= 0) return { ok: false, msg: `${ch.item}を持っていない` };
    let furnace = null;
    try {
      furnace = await bot.openFurnace(fb);
      const haveFuel = furnace.fuelItem();
      const needFuel = Math.max(0, Math.ceil(n / (ch.burns || 1.5)) - (haveFuel ? haveFuel.count : 0));
      if (needFuel > 0) await furnace.putFuel(fuel.id, null, Math.min(needFuel, invCount(bot, ch.fuel)));
      await furnace.putInput(input.id, null, n);
      const t0 = Date.now();
      const waitMs = ctx.smeltWaitMs ?? 30000;
      while (Date.now() - t0 < waitMs) {
        if (ctx.signal && ctx.signal.aborted) break;
        const o = furnace.outputItem();
        if (o && o.count >= n) break;
        await sleep(500);
      }
      const o = furnace.outputItem();
      let took = 0; let outName = null;
      if (o) { outName = o.name; took = o.count; await furnace.takeOutput(); }
      await sleep(200);
      noteContainer(ctx, fb.position, fb.name, furnaceItems(furnace)); // 入れたままの物を覚える (furnace_take の候補)
      furnace.close();
      if (!took) return { ok: false, msg: `${ch.item}を${n}個入れたが、まだ焼けていない (入れたまま)`, smelt: { input: ch.item, n, took: 0 } };
      return { ok: true, msg: `${ch.item}を焼いて${outName}を${took}個取り出した${took < n ? ' (残りは入れたまま)' : ''}`, smelt: { input: ch.item, n, took, output: outName } };
    } catch (e) {
      try { if (furnace) furnace.close(); } catch (_) { /* ignore */ }
      return { ok: false, msg: `焼けなかった: ${String(e.message).slice(0, 50)}` };
    }
  },

  // sleep: ベッドで寝る。起きる (夜が明ける) まで最大 sleepWaitMs 待つ。明けなければ起きて戻る
  async sleep(bot, ch, ctx) {
    const p = ch.pos;
    const bed = p && bot.blockAt(new Vec3(p.x, p.y, p.z));
    if (!bed || !bot.isABed(bed)) return { ok: false, msg: 'ベッドが見当たらない' };
    try {
      await withTimeout(gotoGoal(bot, new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2)), ctx.perTargetMs ?? 15000, () => haltPath(bot));
    } catch (e) { return { ok: false, msg: `ベッドへ行けなかった: ${pathErr(e)}` }; }
    try { await bot.sleep(bed); } catch (e) { return { ok: false, msg: `寝られなかった: ${String(e.message).slice(0, 50)}` }; }
    if (ctx.memory) ctx.memory.notePlace(bed.name, bed.position, { imp: 0.8 });
    const t0 = Date.now();
    const waitMs = ctx.sleepWaitMs ?? 30000;
    while (bot.isSleeping && Date.now() - t0 < waitMs) {
      if (ctx.signal && ctx.signal.aborted) break;
      await sleep(500);
    }
    if (bot.isSleeping) {
      try { await bot.wake(); } catch (_) { /* ignore */ }
      return { ok: true, msg: '寝たが夜は明けなかったので起きた', sleep: { slept: true, nightSkipped: false, timeOfDay: bot.time ? bot.time.timeOfDay : null } };
    }
    // 起きたあと、時刻の知らせ (1秒ごと) が届くのを少し待ってから、朝になったかで判断する
    await sleep(ctx.wakeTimeWaitMs ?? 1500);
    const tod = bot.time ? bot.time.timeOfDay : null;
    const skipped = tod != null && (tod % 24000) < 12000;
    return { ok: true, msg: skipped ? '寝て起きた (夜が明けた)' : '寝たが途中で起きた (まだ夜)', sleep: { slept: true, nightSkipped: skipped, timeOfDay: tod } };
  },

  // equip: 道具・武器は手に、防具は体に
  async equip(bot, ch) {
    const it = bot.inventory.items().find((i) => i.name === ch.item);
    if (!it) return { ok: false, msg: `${ch.item}を持っていない` };
    const m = ch.item.match(/_(helmet|chestplate|leggings|boots)$/);
    const dest = m ? ARMOR_DEST[m[1]] : ch.item === 'shield' ? 'off-hand' : 'hand';
    try { await bot.equip(it, dest); } catch (e) { return { ok: false, msg: `持ち替えられなかった: ${String(e.message).slice(0, 50)}` }; }
    return { ok: true, msg: dest === 'hand' ? `${ch.item}を手に持った` : `${ch.item}を身につけた` };
  },

  // set_base: 今いる所を拠点にする (agent が持つ。忘れにくい記憶にする)
  async set_base(bot, _ch, ctx) {
    if (!ctx.setBase) return { ok: false, msg: '拠点を決める仕組みがない' };
    const p = ctx.setBase();
    return { ok: true, msg: `ここ(${p.x},${p.y},${p.z})を拠点にした` };
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

Object.assign(handlers, moreHandlers({ gotoGoal, haltPath, pathErr, invCount, pickUpNear }));

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

module.exports = { executeAction, handlers, DEFAULT_TIMEOUTS, faceReachable, bestWeapon };
