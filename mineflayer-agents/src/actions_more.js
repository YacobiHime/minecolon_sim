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
//   lure     : 餌になる物を手に持って歩き、付いてくる動物を拠点・覚えた場所まで連れて行く (act_pen.js)
//   enclose  : 柵・塀・ブロックで、拠点か今いる所の周り (内側 3x3・5x5・7x7) を1周囲う。門があれば1つ門にする (act_pen.js)
// 何が意味のある組み合わせかは教えない (研究方針: 仕様は見せてよいが、どう使うかは教えない)。
// 持ち物の側は、マイクラで右クリックに意味がある物だけ (usable.js の一覧。モデルには見せず、選択肢から外れるだけ)。
// 候補は「近いもの数個」に絞るだけにする。1つの行動の choices は MAX_CHOICES (255) を超えない
const { relDir } = require('./util');
const { whereEn } = require('./en');
const { usefulOn, usefulItem } = require('./usable');
const { BREED_FOOD } = require('./animals');

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
    return { kind: 'block', name: b.name, pos: { x: t.x, y: t.y, z: t.z }, label: `${b.name}${t.ripe != null ? (t.ripe ? '(育ちきった)' : '(育ち途中)') : ''} ${relDir(here, t)}`,
      labelEn: `${b.name}${t.ripe != null ? (t.ripe ? ' (fully grown)' : ' (still growing)') : ''} (${whereEn(here, t)})` };
  });
  const seen = new Map();
  for (const e of raw.entities) {
    if (e.kind === 'player' || e.kind === 'item' || e.d > (ctx.useEntityRadius ?? 16)) continue;
    if (!seen.has(e.name)) seen.set(e.name, e);
  }
  const ents = [...seen.values()].slice(0, ctx.useEntities ?? 4)
    .map((e) => ({ kind: 'entity', name: e.name, pos: e.pos, entityId: e.id, label: `${e.kind === 'hostile' ? '敵' : ''}${e.name} ${relDir(here, e.pos)}`, labelEn: `${e.kind === 'hostile' ? 'hostile ' : ''}${e.name} (${whereEn(here, e.pos)})` }));
  // 畑 (agent が渡す ctx.farmTargets): 空いている耕地・植わっている作物 (近くを数えたもの)・覚えている耕地/作物の場所 (M番号)。
  //   見えている同じ名前の対象より遠い所でも出す (歩いて行って使う)。id は name@所 で見えている物と分ける
  const extra = (ctx.farmTargets || []).filter((t) => !blocks.some((b) => b.name === t.name && b.pos && t.pos && Math.abs(b.pos.x - t.pos.x) + Math.abs(b.pos.y - t.pos.y) + Math.abs(b.pos.z - t.pos.z) === 0))
    .map((t) => ({ kind: 'block', name: t.name, idName: t.idName || null, pos: t.pos, label: `${t.name}${t.note ? `(${t.note})` : ''} ${relDir(here, t.pos)}`, labelEn: `${t.name}${t.noteEn ? ` (${t.noteEn})` : ''} (${whereEn(here, t.pos)})` }));
  return [...blocks, ...extra, ...ents];
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

const dOf = (here, t) => Math.hypot(t.pos.x - here.x, t.pos.y - here.y, t.pos.z - here.z);
// 持ち物を数の多い順に (同じ数なら持ち物の並びの順)
function byCount(inv) { return inv.map((x, i) => ({ x, i })).sort((a, b) => (b.x.count - a.x.count) || (a.i - b.i)).map((y) => y.x); }
// 2つの並び (それぞれ順位の小さい方が先) の組 [a, b] を、順位の和の小さい順に (同じなら b の順位の小さい順)
function rankPairs(na, nb) {
  const out = [];
  for (let s = 0; s <= na + nb - 2; s++) for (let b = 0; b <= s; b++) { const a = s - b; if (a < na && b < nb) out.push([a, b]); }
  return out;
}

// on(name): この設定でその行動を使うか。blocked: 続けて失敗した "action:arg"
function moreActions(raw, ctx = {}, on = () => true) {
  const out = [];
  const blocked = ctx.blocked || new Set();
  const here = raw.self.pos;
  const ok = (a, id) => !blocked.has(`${a}:${id}`);
  const inv = raw.inventory;
  const players = raw.entities.filter((e) => e.kind === 'player');

  // use_on: 持ち物 (と素手) × 見えている対象。maxUseChoices を超えるときは、近い対象・数の多い持ち物の組から
  //   (対象の近さの順位 + 持ち物の数の順位 の小さい順) 上限まで。組み合わせに意味があるかは判断しない
  if (on('use_on')) {
    const targets = useTargets(raw, ctx).map((t, i) => ({ t, i })).sort((a, b) => (dOf(here, a.t) - dOf(here, b.t)) || (a.i - b.i)).map((x) => x.t);
    // useOnSkip(name): 持ち物の側から外す物 (survival_3days では置けるブロック。種・苗木など使う=植えるになる物は残す)
    //   usableOn(name): 持ち物の側に出す物 (既定は usable.js の usefulOn。右クリックで何も起きない剣・ツルハシ・棒・ブロック等は外す)
    const skip = ctx.useOnSkip || null;
    const usable = ctx.usableOn || usefulOn;
    const items = [HAND, ...[...new Set(byCount(inv).map((i) => i.name))].filter((n) => usable(n) && !(skip && skip(n)))];
    const maxN = Math.min(MAX_CHOICES, ctx.maxUseChoices ?? 200);
    const ch = [];
    for (const [ii, ti] of rankPairs(items.length, targets.length)) {
      const it = items[ii]; const t = targets[ti];
      const id = `${it}>${t.idName || t.name}`;
      if (!ok('use_on', id)) continue;
      ch.push({ id, label: `${it === HAND ? '素手' : it}を${t.label}に`, labelEn: `${it === HAND ? 'bare hand' : it} on ${t.labelEn}`, item: it, target: t.name, targetKind: t.kind, pos: t.pos, entityId: t.entityId ?? null });
      if (ch.length >= maxN) break;
    }
    if (ch.length) out.push({ name: 'use_on', desc: '持ち物(か素手)を見えているブロックか生き物に使う (右クリック。近くへ歩いて狙う)', descEn: 'use an item (or bare hand) on a visible block or creature (right click; walks close and aims)', argType: 'choice', choices: ch });
  }

  // use_item: 持ち物をその場で使う (右クリックを押す。弓は引いて放す、盾は構える、釣り竿は投げて待つ)
  if (on('use_item')) {
    // usableItem(name): その場で使って何かが起きうる物だけ (既定は usable.js の usefulItem。ブロック・原木などは外す)
    const usable = ctx.usableItem || usefulItem;
    const ch = [...new Set(heldItems(raw))].filter((n) => usable(n) && ok('use_item', n)).map((n) => ({ id: n, label: n, item: n }));
    if (ch.length) out.push({ name: 'use_item', desc: '持ち物をその場で使う (向いている方へ。右クリック)', descEn: 'use an item where you stand (toward where you face; right click)', argType: 'choice', choices: cap(ch) });
  }

  if (on('dismount') && raw.self.vehicle && ok('dismount', 'here')) {
    out.push({ name: 'dismount', desc: `${raw.self.vehicle}から降りる`, descEn: `get off the ${raw.self.vehicle}`, argType: 'choice', choices: [{ id: 'here', label: '降りる', labelEn: 'get off' }] });
  }

  // chest_put / chest_take: いちばん近い入れ物
  const cont = nearestBlock(raw, CONTAINER, ctx.visionRadius ?? 16);
  if (cont) {
    const where = `${cont.name} ${relDir(here, cont.nearest)}`;
    const whereE = `${cont.name} (${whereEn(here, cont.nearest)})`;
    const pos = { x: cont.nearest.x, y: cont.nearest.y, z: cont.nearest.z };
    if (on('chest_put') && inv.length) {
      const ch = inv.filter((i) => ok('chest_put', i.name)).map((i) => ({ id: i.name, label: `${i.name}x${i.count}`, labelEn: `${i.name} x${i.count}`, item: i.name, count: i.count, pos, block: cont.name }));
      if (ch.length) out.push({ name: 'chest_put', desc: `${where} に持ち物を入れる (その種類を全部)`, descEn: `put items into the ${whereE} (all of that kind)`, argType: 'choice', choices: cap(ch) });
    }
    if (on('chest_take')) {
      const known = containerAt(ctx, pos);
      const ch = known && known.items.length
        ? known.items.filter((i) => ok('chest_take', i.name)).map((i) => ({ id: i.name, label: `${i.name}x${i.count}`, labelEn: `${i.name} x${i.count}`, item: i.name, pos, block: cont.name }))
        : (known ? [] : [{ id: 'look', label: '中を見る', labelEn: 'look inside', look: true, pos, block: cont.name }]);
      if (ch.length) out.push({ name: 'chest_take', desc: known ? `${where} から取り出す (前に見た中身。その種類を全部)` : `${where} の中を見る (開けて中身を知る)`,
        descEn: known ? `take items out of the ${whereE} (contents seen before; all of that kind)` : `open the ${whereE} and see what is inside`, argType: 'choice', choices: cap(ch) });
    }
  }

  // furnace_take: いちばん近いかまど。中が空と分かっているときは出さない
  const fur = nearestBlock(raw, FURNACE, ctx.visionRadius ?? 16);
  if (fur && on('furnace_take')) {
    const pos = { x: fur.nearest.x, y: fur.nearest.y, z: fur.nearest.z };
    const known = containerAt(ctx, pos);
    const has = known ? known.items : null;
    const desc = has ? ` (前に見た中身: ${has.map((i) => `${i.slot ? i.slot + ':' : ''}${i.name}x${i.count}`).join(', ')})` : '';
    const descE = has ? ` (contents seen before: ${has.map((i) => `${i.slot ? i.slot + ':' : ''}${i.name} x${i.count}`).join(', ')})` : '';
    if (!has || has.length) {
      const ch = [{ id: 'output', label: '出来上がった物', labelEn: 'the finished items', what: 'output', pos, block: fur.name }, { id: 'all', label: '全部 (出来上がった物・焼く前の物・燃料)', labelEn: 'everything (finished items, unsmelted items, fuel)', what: 'all', pos, block: fur.name }]
        .filter((c) => ok('furnace_take', c.id));
      if (ch.length) out.push({ name: 'furnace_take', desc: `${fur.name} ${relDir(here, fur.nearest)} から取り出す${desc}`, descEn: `take items out of the ${fur.name} (${whereEn(here, fur.nearest)})${descE}`, argType: 'choice', choices: ch });
    }
  }

  // trade: 見えている村人 (近い3人)。取引の一覧を前に見ていれば、その取引を選ぶ
  if (on('trade')) {
    const ch = [];
    for (const v of raw.entities.filter((e) => TRADER.test(e.name)).slice(0, 3)) {
      const known = (ctx.trades || {})[v.id];
      const who = `${v.name}#${v.id} ${relDir(here, v.pos)}`;
      const whoE = `${v.name}#${v.id} (${whereEn(here, v.pos)})`;
      if (!known) { if (ok('trade', `${v.id}:look`)) ch.push({ id: `${v.id}:look`, label: `${who} の取引の一覧を見る`, labelEn: `see the trades of ${whoE}`, entityId: v.id, look: true }); continue; }
      for (const t of known.trades) {
        const id = `${v.id}:${t.i}`;
        if (t.disabled || !ok('trade', id)) continue;
        ch.push({ id, label: `${who}: ${tradeText(t)}${hasInputs(inv, t) ? '' : ' (材料が足りない)'}`, labelEn: `${whoE}: ${tradeText(t)}${hasInputs(inv, t) ? '' : ' (not enough to pay)'}`, entityId: v.id, index: t.i });
      }
    }
    if (ch.length) out.push({ name: 'trade', desc: '村人と取引する (近くへ行って1回分)', descEn: 'trade with a villager (walks close; one trade)', argType: 'choice', choices: cap(ch) });
  }

  // enchant: エンチャント台が見えていて、ラピスラズリと置ける物を持っているとき。段 (1〜3) は選ぶ
  const table = nearestBlock(raw, /^enchanting_table$/, ctx.visionRadius ?? 16);
  const lapis = inv.find((i) => i.name === 'lapis_lazuli');
  if (table && lapis && on('enchant')) {
    const ch = [];
    for (const i of inv.filter((x) => ENCHANTABLE.test(x.name))) {
      for (const s of [1, 2, 3]) if (lapis.count >= s && ok('enchant', `${i.name}:${s}`)) ch.push({ id: `${i.name}:${s}`, label: `${i.name} ${s}段目 (ラピスラズリ${s}個・レベル${s}消費)`, labelEn: `${i.name}, option ${s} (uses ${s} lapis_lazuli and ${s} levels)`, item: i.name, slot: s, pos: table.nearest });
    }
    const lv = raw.self.level != null ? ` 今の経験値レベル${raw.self.level}` : '';
    if (ch.length) out.push({ name: 'enchant', desc: `エンチャント台 ${relDir(here, table.nearest)} で道具・防具・本にエンチャントする${lv}`, descEn: `enchant a tool, armor or book at the enchanting_table (${whereEn(here, table.nearest)})`, argType: 'choice', choices: cap(ch) });
  }

  // brew: 醸造台が見えていて、瓶 (ポーション) と材料を持っているとき
  const stand = nearestBlock(raw, /^brewing_stand$/, ctx.visionRadius ?? 16);
  if (stand && on('brew') && inv.some((i) => POTION.test(i.name))) {
    const ch = inv.filter((i) => BREW_INGREDIENT.has(i.name) && ok('brew', i.name)).map((i) => ({ id: i.name, label: `${i.name}を材料に`, labelEn: `${i.name} as the ingredient`, item: i.name, pos: stand.nearest }));
    const fuel = inv.some((i) => i.name === 'blaze_powder') ? '' : ' (燃料のブレイズパウダーを持っていない)';
    if (ch.length) out.push({ name: 'brew', desc: `醸造台 ${relDir(here, stand.nearest)} で、持っている瓶(最大3本)に材料を1つ入れて醸造する。終わるまで最大25秒待つ${fuel}`,
      descEn: `brew at the brewing_stand (${whereEn(here, stand.nearest)}): one ingredient into your bottles (up to 3); waits up to 25 seconds${fuel ? ' (no blaze_powder fuel in inventory)' : ''}`, argType: 'choice', choices: cap(ch) });
  }

  // anvil: 金床が見えていて、同じ道具2つ、または道具とエンチャントの本を持っているとき
  const anv = nearestBlock(raw, /^(anvil|chipped_anvil|damaged_anvil)$/, ctx.visionRadius ?? 16);
  if (anv && on('anvil')) {
    const ch = [];
    const names = inv.map((i) => i.name);
    for (const i of inv.filter((x) => DAMAGEABLE.test(x.name) || x.name === 'enchanted_book')) {
      if (i.count >= 2 || names.filter((n) => n === i.name).length >= 2) ch.push({ id: `${i.name}+${i.name}`, label: `${i.name}を2つ合わせる`, labelEn: `combine two ${i.name}`, a: i.name, b: i.name, pos: anv.nearest });
      if (i.name !== 'enchanted_book' && names.includes('enchanted_book')) ch.push({ id: `${i.name}+enchanted_book`, label: `${i.name}にenchanted_bookを合わせる`, labelEn: `apply enchanted_book to ${i.name}`, a: i.name, b: 'enchanted_book', pos: anv.nearest });
    }
    const ch2 = ch.filter((c) => ok('anvil', c.id));
    if (ch2.length) out.push({ name: 'anvil', desc: `金床 ${relDir(here, anv.nearest)} で2つの物を合わせる (経験値レベルを使う)`, descEn: `combine two items at the anvil (${whereEn(here, anv.nearest)}; uses experience levels)`, argType: 'choice', choices: cap(ch2) });
  }

  // follow: 見えている人について行く (followMs まで)
  if (on('follow') && players.length) {
    const ch = players.filter((p) => ok('follow', p.name)).map((p) => ({ id: p.name, label: `${p.name} ${relDir(here, p.pos)}`, labelEn: `${p.name} (${whereEn(here, p.pos)})`, player: p.name }));
    if (ch.length) out.push({ name: 'follow', desc: `人について行く (${Math.round((ctx.followMs ?? 30000) / 1000)}秒ほど)`, descEn: 'follow a person for a while', argType: 'choice', choices: ch });
  }

  // give: 見えている人に持ち物を投げ渡す (1個か、その種類を全部)。maxGiveChoices を超えるときは、
  //   近い人・数の多い持ち物の組から (順位の和の小さい順) 上限まで
  if (on('give') && players.length && inv.length) {
    const ps = [...players].sort((a, b) => a.d - b.d);
    const items = byCount(inv);
    const maxN = Math.min(MAX_CHOICES, ctx.maxGiveChoices ?? MAX_CHOICES);
    const ch = [];
    for (const [pi, ii] of rankPairs(ps.length, items.length)) {
      const p = ps[pi]; const i = items[ii];
      for (const n of i.count > 1 ? [1, 'all'] : [1]) {
        const id = `${p.name}:${i.name}:${n}`;
        if (ok('give', id) && ch.length < maxN) ch.push({ id, label: `${p.name}に${i.name}を${n === 'all' ? `全部(${i.count}個)` : '1個'}`, labelEn: `${n === 'all' ? `all ${i.count}` : '1'} ${i.name} to ${p.name}`, player: p.name, item: i.name, count: n === 'all' ? i.count : 1 });
      }
      if (ch.length >= maxN) break;
    }
    if (ch.length) out.push({ name: 'give', desc: '人の近くへ行って持ち物を投げ渡す', descEn: 'walk close to a person and toss them an item', argType: 'choice', choices: ch });
  }

  // call: 聞こえる範囲に見えている人を呼ぶ (「来て」と言う。相手の「今聞こえた話」に入る)
  if (on('call')) {
    const ch = players.filter((p) => p.d <= (ctx.hearRadius ?? 24) && ok('call', p.name)).map((p) => ({ id: p.name, label: `${p.name} ${relDir(here, p.pos)}`, labelEn: `${p.name} (${whereEn(here, p.pos)})`, player: p.name }));
    if (ch.length) out.push({ name: 'call', desc: '人を呼ぶ (「来て」と自分の場所を言う)', descEn: 'call a person over (says "come here" and where you are)', argType: 'choice', choices: ch });
  }
  // lure: 見えている動物 (餌の分かる物) × 持っている餌 × 行き先 (拠点・覚えている場所)
  if (on('lure')) {
    const ch = lureChoices(raw, ctx).filter((c) => ok('lure', c.id));
    if (ch.length) out.push({ name: 'lure', desc: '餌を手に持って歩き、付いてくる動物をその場所まで連れて行く', descEn: 'walk holding food so that animals follow, and lead them to the place', argType: 'choice', choices: cap(ch, ctx.maxLureChoices ?? 8) });
  }
  // enclose: 場所 (拠点・ここ) × 大きさ × 持っている柵・塀・ブロック
  if (on('enclose')) {
    const ch = encloseChoices(raw, ctx).filter((c) => ok('enclose', c.id));
    if (ch.length) out.push({ name: 'enclose', desc: '持っている柵・塀・ブロックで、その場所の周りを1周囲う (柵の門があれば1つ門にする。足りなければ置ける所まで)', descEn: 'surround the place once with fences, walls or blocks you have (one fence gate becomes the gate if you have one; places as many as you have)', argType: 'choice', choices: cap(ch, ctx.maxEncloseChoices ?? 18) });
  }
  return out;
}

// 柵・塀 (1段で越えられない)・ブロック (2段に積む) として囲いに使える物
const FENCE_ITEM = /_fence$|_wall$/;
const WALL_BLOCK = /^(cobblestone|cobbled_deepslate|stone|dirt|coarse_dirt|deepslate|andesite|diorite|granite|tuff|sandstone|red_sandstone|bricks|stone_bricks|mud_bricks|.*_planks|.*_log)$/;
const GATE_ITEM = /_fence_gate$/;
const ENCLOSE_SIZES = [3, 5, 7];
function encloseNeed(item, size) { return (4 * size + 4) * (FENCE_ITEM.test(item) ? 1 : 2); }

function encloseChoices(raw, ctx = {}) {
  const here = raw.self.pos;
  const counts = new Map();
  for (const i of raw.inventory) counts.set(i.name, (counts.get(i.name) || 0) + i.count);
  const mats = [...counts].filter(([n]) => FENCE_ITEM.test(n) || WALL_BLOCK.test(n))
    .sort((a, b) => (FENCE_ITEM.test(b[0]) - FENCE_ITEM.test(a[0])) || (b[1] - a[1])).slice(0, ctx.encloseMaterials ?? 3);
  if (!mats.length) return [];
  const gate = [...counts.keys()].find((n) => GATE_ITEM.test(n)) || null;
  const places = [];
  if (ctx.base) places.push({ id: '拠点', label: `拠点 (${relDir(here, ctx.base)})`, labelEn: `the base (${whereEn(here, ctx.base)})`, center: { x: Math.floor(ctx.base.x), y: Math.floor(ctx.base.y), z: Math.floor(ctx.base.z) } });
  if (!ctx.base || Math.hypot(ctx.base.x - here.x, ctx.base.z - here.z) > 6) places.push({ id: 'ここ', label: '今いる所', labelEn: 'the current spot', center: { x: Math.floor(here.x), y: Math.floor(here.y), z: Math.floor(here.z) } });
  const out = [];
  for (const pl of places) {
    for (const size of ENCLOSE_SIZES) {
      for (const [m, n] of mats) {
        const need = encloseNeed(m, size);
        out.push({ id: `${pl.id}:${size}x${size}:${m}`, label: `${m}x${n} で${pl.label}の周り (内側${size}x${size}) を囲う (要る数${need}${FENCE_ITEM.test(m) ? '' : '・2段'}${FENCE_ITEM.test(m) && gate ? `・うち1つ ${gate}` : ''})`,
          labelEn: `around ${pl.labelEn} (inside ${size}x${size}) with ${m} x${n} (needs ${need}${FENCE_ITEM.test(m) ? '' : ', 2 high'}${FENCE_ITEM.test(m) && gate ? `, one of them ${gate}` : ''})`,
          center: pl.center, size, item: m, gate: FENCE_ITEM.test(m) ? gate : null, height: FENCE_ITEM.test(m) ? 1 : 2, need, place: pl.id });
      }
    }
  }
  return out;
}

function lureChoices(raw, ctx = {}) {
  const here = raw.self.pos;
  const counts = new Set(raw.inventory.map((i) => i.name));
  const dests = [];
  if (ctx.base && Math.hypot(ctx.base.x - here.x, ctx.base.z - here.z) > 4) dests.push({ id: '拠点', label: `拠点 (${relDir(here, ctx.base)})`, labelEn: `the base (${whereEn(here, ctx.base)})`, pos: ctx.base });
  for (const p of (ctx.memPlaces || []).filter((q) => q.kind !== '拠点' && q.pos && (q.d == null || q.d > 4)).slice(0, ctx.lureDests ?? 2)) dests.push({ id: p.id, label: p.label, labelEn: `${p.id}=${p.kind} (${whereEn(here, p.pos)})`, pos: p.pos });
  if (!dests.length) return [];
  const seen = new Map();
  for (const e of raw.entities) if (e.kind === 'mob' && BREED_FOOD[e.name] && e.d <= (ctx.visionRadius ?? 16) && !seen.has(e.name)) seen.set(e.name, e);
  const out = [];
  for (const [animal, e] of seen) {
    const food = BREED_FOOD[animal].find((f) => counts.has(f));
    if (!food) continue;
    const n = raw.entities.filter((x) => x.name === animal && x.kind === 'mob').length;
    for (const d of dests) {
      out.push({ id: `${animal}>${d.id}`, label: `${food} を持って ${animal} (${relDir(here, e.pos)}・見えている${n}頭) を${d.label}へ`, labelEn: `${animal} (${whereEn(here, e.pos)}; ${n === 1 ? 'one' : n <= 4 ? 'a few' : 'some'} visible) to ${d.labelEn}, holding ${food}`, animal, food, dest: { x: d.pos.x, y: d.pos.y, z: d.pos.z }, destId: d.id, entityId: e.id ?? null });
    }
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

const MORE_ACTIONS = ['use_on', 'use_item', 'dismount', 'chest_put', 'chest_take', 'furnace_take', 'trade', 'enchant', 'brew', 'anvil', 'follow', 'give', 'call', 'lure', 'enclose'];

module.exports = { lureChoices, encloseChoices, encloseNeed, FENCE_ITEM, WALL_BLOCK, GATE_ITEM, ENCLOSE_SIZES, moreActions, useTargets, rankPairs, byCount, tradeText, hasInputs, posKey, MORE_ACTIONS, CONTAINER, FURNACE, TRADER, BREW_INGREDIENT, ENCHANTABLE, POTION, HAND, MAX_CHOICES };
