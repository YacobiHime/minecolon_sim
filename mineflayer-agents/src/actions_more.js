'use strict';
// マイクラでできることを広く出す行動の一覧 (actions.js の listActions から呼ぶ。純粋な関数)。
//   use_on   : 持ち物 X (か素手) を、見えているブロック/生き物 Y に使う (右クリック)。歩く・狙うはプログラム
//   use_item : 持ち物 X をその場で使う (釣り竿・弓・盾・投げる物など)
//   dismount : 乗り物から降りる
//   chest_put / chest_take : 見えている入れ物 (チェスト・樽) に入れる・出す
//   furnace_take : 見えているかまどから、出来上がった物・残りを取り出す
//   trade    : 見えている村人と取引する (取引の一覧を見てから選ぶ)
//   enchant / brew / anvil : エンチャント台・醸造台・金床
//   follow / give / call : 人について行く・物を投げ渡す・呼ぶ
// 何が意味のある組み合わせかは教えない (研究方針: 仕様は見せてよいが、どう使うかは教えない)。
// 候補は「近いもの数個」に絞るだけにする。1つの行動の choices は MAX_CHOICES (255) を超えない
const { relDir } = require('./util');

const MAX_CHOICES = 255;
const CONTAINER = /^(chest|trapped_chest|barrel)$|_shulker_box$|^shulker_box$/;
const FURNACE = /^(furnace|smoker|blast_furnace)$/;
const TRADER = /^(villager|wandering_trader)$/;
// エンチャント台に置ける物 (仕様)
const ENCHANTABLE = /_(sword|axe|pickaxe|shovel|hoe|helmet|chestplate|leggings|boots)$|^(bow|crossbow|trident|fishing_rod|book)$/;
// 醸造台の材料 (仕様: 醸造台の材料の枠に入る物)
const BREW_INGREDIENT = new Set(['nether_wart', 'redstone', 'glowstone_dust', 'fermented_spider_eye', 'gunpowder', 'dragon_breath', 'sugar', 'rabbit_foot',
  'glistering_melon_slice', 'spider_eye', 'pufferfish', 'magma_cream', 'golden_carrot', 'blaze_powder', 'ghast_tear', 'turtle_helmet', 'phantom_membrane']);
const POTION = /^(potion|splash_potion|lingering_potion)$/;
const DAMAGEABLE = /_(sword|axe|pickaxe|shovel|hoe|helmet|chestplate|leggings|boots)$|^(bow|crossbow|trident|fishing_rod|shears|flint_and_steel|shield|elytra|carrot_on_a_stick)$/;
const HAND = 'hand';

const posKey = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

// 見えている物から、use_on の対象 (ブロックは種類ごとに一番近い所、生き物は種類ごとに一番近いもの)
function useTargets(raw, ctx = {}) {
  const here = raw.self.pos;
  const r = ctx.useRadius ?? 10;
  const feetY = Math.floor(here.y);
  const reachUp = ctx.maxReachUp ?? 4;
  const near = raw.blocks
    .map((b) => ({ b, p: (b.positions && b.positions.length ? b.positions : [b.nearest]).find((q) => q.d <= r && q.y - feetY <= reachUp) }))
    .filter((x) => x.p)
    .sort((x, y) => x.p.d - y.p.d);
  // 近い順に数種類 + 目印 (水・原木・鉱石など observe の notable) を近い順に数種類
  const nNear = ctx.useNearBlocks ?? 5;
  const nNotable = ctx.useNotableBlocks ?? 4;
  const picked = near.slice(0, nNear);
  for (const x of near.filter((y) => y.b.notable && !picked.includes(y)).slice(0, nNotable)) picked.push(x);
  const blocks = picked.map(({ b, p }) => {
    // 作物は育ちきった所を先に (見えている中から)
    const ps = b.positions && b.positions.length ? b.positions.filter((q) => q.d <= r && q.y - feetY <= reachUp) : [p];
    const ripe = ps.find((q) => q.ripe);
    const t = ripe || p;
    return { kind: 'block', name: b.name, pos: { x: t.x, y: t.y, z: t.z }, label: `${b.name}${t.ripe != null ? (t.ripe ? '(育ちきった)' : '(育ち途中)') : ''} ${relDir(here, t)}` };
  });
  const seen = new Map();
  for (const e of raw.entities) {
    if (e.kind === 'player' || e.kind === 'item' || e.d > (ctx.useEntityRadius ?? 16)) continue;
    if (!seen.has(e.name)) seen.set(e.name, e);
  }
  const ents = [...seen.values()].slice(0, ctx.useEntities ?? 4)
    .map((e) => ({ kind: 'entity', name: e.name, pos: e.pos, entityId: e.id, label: `${e.kind === 'hostile' ? '敵' : ''}${e.name} ${relDir(here, e.pos)}` }));
  return [...blocks, ...ents];
}

function heldItems(raw) {
  return raw.inventory.map((i) => i.name);
}

function containerAt(ctx, pos) {
  const m = ctx.containers || {};
  return m[posKey(pos)] || null;
}

function nearestBlock(raw, re, maxD = Infinity) {
  return raw.blocks.filter((b) => re.test(b.name) && b.nearest.d <= maxD).sort((a, b) => a.nearest.d - b.nearest.d)[0] || null;
}

function cap(choices, n = MAX_CHOICES) { return choices.slice(0, n); }

// on(name): この設定でその行動を使うか。blocked: 続けて失敗した "action:arg"
function moreActions(raw, ctx = {}, on = () => true) {
  const out = [];
  const blocked = ctx.blocked || new Set();
  const here = raw.self.pos;
  const ok = (a, id) => !blocked.has(`${a}:${id}`);
  const inv = raw.inventory;
  const players = raw.entities.filter((e) => e.kind === 'player');

  // use_on: 持ち物 (と素手) × 見えている対象。多すぎるときは遠い対象から落とす
  if (on('use_on')) {
    let targets = useTargets(raw, ctx);
    const items = [HAND, ...heldItems(raw)];
    const maxN = Math.min(MAX_CHOICES, ctx.maxUseChoices ?? 200);
    while (targets.length > 1 && items.length * targets.length > maxN) targets = targets.slice(0, -1);
    const ch = [];
    for (const it of items) {
      for (const t of targets) {
        const id = `${it}>${t.name}`;
        if (!ok('use_on', id)) continue;
        ch.push({ id, label: `${it === HAND ? '素手' : it}を${t.label}に`, item: it, target: t.name, targetKind: t.kind, pos: t.pos, entityId: t.entityId ?? null });
      }
    }
    if (ch.length) out.push({ name: 'use_on', desc: '持ち物(か素手)を見えているブロックか生き物に使う (右クリック。近くへ歩いて狙う)', argType: 'choice', choices: cap(ch, maxN) });
  }

  // use_item: 持ち物をその場で使う (右クリックを押す。弓は引いて放す、盾は構える、釣り竿は投げて待つ)
  if (on('use_item')) {
    const ch = heldItems(raw).filter((n) => ok('use_item', n)).map((n) => ({ id: n, label: n, item: n }));
    if (ch.length) out.push({ name: 'use_item', desc: '持ち物をその場で使う (向いている方へ。右クリック)', argType: 'choice', choices: cap(ch) });
  }

  if (on('dismount') && raw.self.vehicle && ok('dismount', 'here')) {
    out.push({ name: 'dismount', desc: `${raw.self.vehicle}から降りる`, argType: 'choice', choices: [{ id: 'here', label: '降りる' }] });
  }

  // chest_put / chest_take: いちばん近い入れ物
  const cont = nearestBlock(raw, CONTAINER, ctx.visionRadius ?? 16);
  if (cont) {
    const where = `${cont.name} ${relDir(here, cont.nearest)}`;
    const pos = { x: cont.nearest.x, y: cont.nearest.y, z: cont.nearest.z };
    if (on('chest_put') && inv.length) {
      const ch = inv.filter((i) => ok('chest_put', i.name)).map((i) => ({ id: i.name, label: `${i.name}x${i.count}`, item: i.name, count: i.count, pos, block: cont.name }));
      if (ch.length) out.push({ name: 'chest_put', desc: `${where} に持ち物を入れる (その種類を全部)`, argType: 'choice', choices: cap(ch) });
    }
    if (on('chest_take')) {
      const known = containerAt(ctx, pos);
      const ch = known && known.items.length
        ? known.items.filter((i) => ok('chest_take', i.name)).map((i) => ({ id: i.name, label: `${i.name}x${i.count}`, item: i.name, pos, block: cont.name }))
        : (known ? [] : [{ id: 'look', label: '中を見る', look: true, pos, block: cont.name }]);
      if (ch.length) out.push({ name: 'chest_take', desc: known ? `${where} から取り出す (前に見た中身。その種類を全部)` : `${where} の中を見る (開けて中身を知る)`, argType: 'choice', choices: cap(ch) });
    }
  }

  // furnace_take: いちばん近いかまど。中が空と分かっているときは出さない
  const fur = nearestBlock(raw, FURNACE, ctx.visionRadius ?? 16);
  if (fur && on('furnace_take')) {
    const pos = { x: fur.nearest.x, y: fur.nearest.y, z: fur.nearest.z };
    const known = containerAt(ctx, pos);
    const has = known ? known.items : null;
    const desc = has ? ` (前に見た中身: ${has.map((i) => `${i.slot ? i.slot + ':' : ''}${i.name}x${i.count}`).join(', ')})` : '';
    if (!has || has.length) {
      const ch = [{ id: 'output', label: '出来上がった物', what: 'output', pos, block: fur.name }, { id: 'all', label: '全部 (出来上がった物・焼く前の物・燃料)', what: 'all', pos, block: fur.name }]
        .filter((c) => ok('furnace_take', c.id));
      if (ch.length) out.push({ name: 'furnace_take', desc: `${fur.name} ${relDir(here, fur.nearest)} から取り出す${desc}`, argType: 'choice', choices: ch });
    }
  }

  // trade: 見えている村人 (近い3人)。取引の一覧を前に見ていれば、その取引を選ぶ
  if (on('trade')) {
    const ch = [];
    for (const v of raw.entities.filter((e) => TRADER.test(e.name)).slice(0, 3)) {
      const known = (ctx.trades || {})[v.id];
      const who = `${v.name}#${v.id} ${relDir(here, v.pos)}`;
      if (!known) { if (ok('trade', `${v.id}:look`)) ch.push({ id: `${v.id}:look`, label: `${who} の取引の一覧を見る`, entityId: v.id, look: true }); continue; }
      for (const t of known.trades) {
        const id = `${v.id}:${t.i}`;
        if (t.disabled || !ok('trade', id)) continue;
        ch.push({ id, label: `${who}: ${tradeText(t)}${hasInputs(inv, t) ? '' : ' (材料が足りない)'}`, entityId: v.id, index: t.i });
      }
    }
    if (ch.length) out.push({ name: 'trade', desc: '村人と取引する (近くへ行って1回分)', argType: 'choice', choices: cap(ch) });
  }

  // enchant: エンチャント台が見えていて、ラピスラズリと置ける物を持っているとき。段 (1〜3) は選ぶ
  const table = nearestBlock(raw, /^enchanting_table$/, ctx.visionRadius ?? 16);
  const lapis = inv.find((i) => i.name === 'lapis_lazuli');
  if (table && lapis && on('enchant')) {
    const ch = [];
    for (const i of inv.filter((x) => ENCHANTABLE.test(x.name))) {
      for (const s of [1, 2, 3]) if (lapis.count >= s && ok('enchant', `${i.name}:${s}`)) ch.push({ id: `${i.name}:${s}`, label: `${i.name} ${s}段目 (ラピスラズリ${s}個・レベル${s}消費)`, item: i.name, slot: s, pos: table.nearest });
    }
    const lv = raw.self.level != null ? ` 今の経験値レベル${raw.self.level}` : '';
    if (ch.length) out.push({ name: 'enchant', desc: `エンチャント台 ${relDir(here, table.nearest)} で道具・防具・本にエンチャントする${lv}`, argType: 'choice', choices: cap(ch) });
  }

  // brew: 醸造台が見えていて、瓶 (ポーション) と材料を持っているとき
  const stand = nearestBlock(raw, /^brewing_stand$/, ctx.visionRadius ?? 16);
  if (stand && on('brew') && inv.some((i) => POTION.test(i.name))) {
    const ch = inv.filter((i) => BREW_INGREDIENT.has(i.name) && ok('brew', i.name)).map((i) => ({ id: i.name, label: `${i.name}を材料に`, item: i.name, pos: stand.nearest }));
    const fuel = inv.some((i) => i.name === 'blaze_powder') ? '' : ' (燃料のブレイズパウダーを持っていない)';
    if (ch.length) out.push({ name: 'brew', desc: `醸造台 ${relDir(here, stand.nearest)} で、持っている瓶(最大3本)に材料を1つ入れて醸造する。終わるまで最大25秒待つ${fuel}`, argType: 'choice', choices: cap(ch) });
  }

  // anvil: 金床が見えていて、同じ道具2つ、または道具とエンチャントの本を持っているとき
  const anv = nearestBlock(raw, /^(anvil|chipped_anvil|damaged_anvil)$/, ctx.visionRadius ?? 16);
  if (anv && on('anvil')) {
    const ch = [];
    const names = inv.map((i) => i.name);
    for (const i of inv.filter((x) => DAMAGEABLE.test(x.name) || x.name === 'enchanted_book')) {
      if (i.count >= 2 || names.filter((n) => n === i.name).length >= 2) ch.push({ id: `${i.name}+${i.name}`, label: `${i.name}を2つ合わせる`, a: i.name, b: i.name, pos: anv.nearest });
      if (i.name !== 'enchanted_book' && names.includes('enchanted_book')) ch.push({ id: `${i.name}+enchanted_book`, label: `${i.name}にenchanted_bookを合わせる`, a: i.name, b: 'enchanted_book', pos: anv.nearest });
    }
    const ch2 = ch.filter((c) => ok('anvil', c.id));
    if (ch2.length) out.push({ name: 'anvil', desc: `金床 ${relDir(here, anv.nearest)} で2つの物を合わせる (経験値レベルを使う)`, argType: 'choice', choices: cap(ch2) });
  }

  // follow: 見えている人について行く (followMs まで)
  if (on('follow') && players.length) {
    const ch = players.filter((p) => ok('follow', p.name)).map((p) => ({ id: p.name, label: `${p.name} ${relDir(here, p.pos)}`, player: p.name }));
    if (ch.length) out.push({ name: 'follow', desc: `人について行く (${Math.round((ctx.followMs ?? 30000) / 1000)}秒ほど)`, argType: 'choice', choices: ch });
  }

  // give: 見えている人に持ち物を投げ渡す (1個か、その種類を全部)
  if (on('give') && players.length && inv.length) {
    const ch = [];
    for (const p of players) {
      for (const i of inv) {
        for (const n of i.count > 1 ? [1, 'all'] : [1]) {
          const id = `${p.name}:${i.name}:${n}`;
          if (ok('give', id)) ch.push({ id, label: `${p.name}に${i.name}を${n === 'all' ? `全部(${i.count}個)` : '1個'}`, player: p.name, item: i.name, count: n === 'all' ? i.count : 1 });
        }
      }
    }
    if (ch.length) out.push({ name: 'give', desc: '人の近くへ行って持ち物を投げ渡す', argType: 'choice', choices: cap(ch) });
  }

  // call: 聞こえる範囲に見えている人を呼ぶ (「来て」と言う。相手の「今聞こえた話」に入る)
  if (on('call')) {
    const ch = players.filter((p) => p.d <= (ctx.hearRadius ?? 24) && ok('call', p.name)).map((p) => ({ id: p.name, label: `${p.name} ${relDir(here, p.pos)}`, player: p.name }));
    if (ch.length) out.push({ name: 'call', desc: '人を呼ぶ (「来て」と自分の場所を言う)', argType: 'choice', choices: ch });
  }
  return out;
}

function itemText(it) { return it ? `${it.name}x${it.count}` : ''; }
function tradeText(t) {
  return `${[t.in1, t.in2].filter(Boolean).map(itemText).join('+')} → ${itemText(t.out)}`;
}
function hasInputs(inv, t) {
  const c = (n) => inv.filter((i) => i.name === n).reduce((s, i) => s + i.count, 0);
  return [t.in1, t.in2].filter(Boolean).every((x) => c(x.name) >= x.count);
}

const MORE_ACTIONS = ['use_on', 'use_item', 'dismount', 'chest_put', 'chest_take', 'furnace_take', 'trade', 'enchant', 'brew', 'anvil', 'follow', 'give', 'call'];

module.exports = { moreActions, useTargets, tradeText, hasInputs, posKey, MORE_ACTIONS, CONTAINER, FURNACE, TRADER, BREW_INGREDIENT, ENCHANTABLE, POTION, HAND, MAX_CHOICES };
