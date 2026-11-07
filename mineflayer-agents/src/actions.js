'use strict';
// その瞬間にできる行動の一覧を作る (純粋な関数) と、選ばれた引数の解決。
// 実行は act.js。LLM / Jev などの decider は、この一覧から1つ選んで arg を埋めるだけ。
const { relDir } = require('./util');
const { peopleOf } = require('./people');
const { whereEn } = require('./en');
// 英語の文 (Jev 用): 行動ごとに descEn、選択肢ごとに labelEn を、日本語と同じ所で同じ値から作る
const kindEn = (k) => (k === '拠点' ? 'base' : /^共有のチェスト /.test(k) ? `shared chest ${k.slice(8)}` : k);
const { BUILD_MATERIAL } = require('./hut');
const { exploreChoices } = require('./explore');
const { moreActions, visibleContainers } = require('./actions_more');

const HUNTABLE = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit']);
const MAX_PILLAR = 4; // 足場は 4 段まで
// 足場にする物の順 (先にあるものを使う)。板材・原木は小屋の材料なので最後
const PILLAR_ORDER = [/^dirt$/, /^cobblestone$/, /^(cobbled_deepslate|stone|andesite|diorite|granite|netherrack|gravel|sand)$/, /_planks$/, /_log$/];

// 焼ける物 → 焼いたあとの物 (smelt の候補)。燃料は FUELS の順に使う (1個で焼ける数)
const SMELTABLE = {
  beef: 'cooked_beef', porkchop: 'cooked_porkchop', mutton: 'cooked_mutton', chicken: 'cooked_chicken', rabbit: 'cooked_rabbit',
  cod: 'cooked_cod', salmon: 'cooked_salmon', potato: 'baked_potato', raw_iron: 'iron_ingot', raw_gold: 'gold_ingot', raw_copper: 'copper_ingot',
  sand: 'glass', cobblestone: 'stone',
};
const FUELS = [[/^coal$/, 8], [/^charcoal$/, 8], [/_planks$/, 1.5], [/_log$/, 1.5], [/^stick$/, 0.5]];
const GEAR = /_(sword|axe|pickaxe|shovel|hoe|helmet|chestplate|leggings|boots)$|^shield$/;

function smeltInput(name) { return SMELTABLE[name] || (/_log$/.test(name) ? 'charcoal' : null); }

function fuelFor(inventory, inputName) {
  for (const [re, burns] of FUELS) {
    const it = inventory.find((i) => re.test(i.name) && i.name !== inputName);
    if (it) return { name: it.name, burns };
  }
  return null;
}

function pillarMaterial(inventory) {
  for (const re of PILLAR_ORDER) {
    const it = inventory.filter((i) => re.test(i.name)).sort((a, b) => b.count - a.count)[0];
    if (it) return { name: it.name, count: inventory.filter((i) => i.name === it.name).reduce((t, i) => t + i.count, 0) };
  }
  return null;
}

const DIRECTIONS = ['north', 'south', 'east', 'west'];
const PLACEABLE_HINT = new Set(['crafting_table', 'furnace', 'chest', 'torch']);

// 一覧の各要素: { name, desc, argType: 'choice'|'text'|'none'|'number', choices: [{id, label, ...data}] }
function listActions(raw, ctx = {}) {
  const memPlaces = ctx.memPlaces || [];
  const foods = ctx.foods || new Set();
  const placeableNames = ctx.placeable || null; // Set (bot から渡す) / null なら PLACEABLE_HINT と _planks 等
  const maxCollect = ctx.maxCollectChoices ?? 10;
  const maxReachUp = ctx.maxReachUp ?? 4;
  const goalItems = ctx.goalItems || new Set(); // 目標の物 (作れるようになったら印を付ける)
  const blocked = ctx.blocked || new Set(); // 最近続けて失敗した "action:arg" (今回は候補から外す)
  const here = raw.self.pos;
  const out = [];
  const disabled = ctx.disabled || new Set(); // この設定で使わない行動 (例: survival の hunt・build)
  // サバイバル用の行動 (attack・flee・smelt・sleep・equip) は、設定で有効にしたときだけ (first_setting の一覧は変えない)
  const enabled = ctx.enable || new Set();
  const on = (n) => enabled.has(n) && !disabled.has(n);

  // collect: 見えていて、今の道具で掘れて、手の届く高さ (足場を積まない) にあるブロック
  // collectExclude: 候補にしないブロック (survival_3days では地面そのもの: dirt・grass_block など。耕す・植えるはその場の土に use_on でできる)
  const collEx = ctx.collectExclude || null;
  const coll = raw.blocks
    .filter((b) => b.diggable && !blocked.has(`collect:${b.name}`) && !(collEx && collEx.test(b.name)))
    // 作物 (育ち具合の分かる物。observe の ripe) は、育ちきった所だけ。育ちきった物が無ければ候補に出さない
    .map((b) => ({ b, reach: (b.positions && b.positions.length ? b.positions : [b.nearest]).filter((p) => p.y - Math.floor(here.y) <= maxReachUp && !(b.ripe != null && p.ripe === false)) }))
    .filter((x) => !(x.b.ripe != null && !(x.b.ripe > 0)))
    .filter((x) => x.reach.length)
    .sort((x, y) => (y.b.notable - x.b.notable) || (x.reach[0].d - y.reach[0].d))
    .slice(0, maxCollect)
    .map(({ b, reach }) => ({ id: b.name, label: `${b.name} ${relDir(here, reach[0])}`, labelEn: `${b.name} (${whereEn(here, reach[0])})`, block: b.name }));
  if (coll.length) out.push({ name: 'collect', desc: '見えているブロックを掘って拾う (近いものから数個)', descEn: 'dig a visible block and pick it up (several, nearest first)', argType: 'choice', choices: coll });

  // go_to: 見えている目印・覚えている場所・近くの人 (見えていなくてもよい。peopleRadius 以内)
  // いま collect できる種類のブロックへの go_to は出さない (collect が自分で歩いて行く。
  // 出すと「go_to(原木)」「go_to(M2=原木)」を交互に選び続けて何も掘らないことがあった)
  // 手の届く高さ (maxReachUp) より上のブロックは go_to にも出さない (着いても掘れない。行っても動かずに「着いた」になっていた)
  const collectable = new Set(coll.map((c) => c.block));
  const feetY = Math.floor(here.y);
  const reachable = (p) => p.y - feetY <= maxReachUp;
  const go = [];
  const seenKinds = new Set();
  for (const b of raw.blocks.filter((x) => x.notable).sort((a, c) => a.nearest.d - c.nearest.d)) {
    if (blocked.has(`go_to:${b.name}`) || collectable.has(b.name)) continue;
    const target = (b.positions && b.positions.length ? b.positions : [b.nearest]).find(reachable);
    if (!target || target.d < 3) continue;
    go.push({ id: b.name, label: `${b.name} ${relDir(here, target)}`, labelEn: `${b.name} (${whereEn(here, target)})`, pos: target, kind: b.name });
    seenKinds.add(b.name);
    if (go.length >= 5) break;
  }
  for (const p of memPlaces) {
    if ((p.d !== undefined && p.d < 3) || blocked.has(`go_to:${p.id}`) || (collectable.has(p.kind) && !p.from)) continue; // 聞いた場所は遠くても出す
    if (p.unreachable) continue; // 続けて行けなかった場所 (memory.noteUnreachable) はしばらく出さない
    if (p.pos && !reachable(p.pos)) continue;
    go.push({ id: p.id, label: p.label, labelEn: `${p.id}=${kindEn(p.kind)} (${p.pos ? whereEn(here, p.pos) : 'location unknown'}${p.from ? `; ${p.from} said so` : ''})`, pos: p.pos, kind: p.kind, fromMemory: true, ...(p.from ? { heardFrom: p.from } : {}) });
  }
  // 人: 見えていなくても近く (peopleRadius 以内。raw.people) の人
  for (const e of peopleOf(raw).filter((x) => x.d <= (ctx.peopleRadius ?? Infinity))) {
    go.push({ id: e.name, label: `プレイヤー${e.name} ${relDir(here, e.pos)}`, labelEn: `player ${e.name} (${whereEn(here, e.pos)})`, pos: e.pos, player: e.name });
  }
  if (go.length) out.push({ name: 'go_to', desc: '見えている物・覚えている場所(M番号)・人のところへ歩く', descEn: 'walk to a visible thing, a remembered place (M number) or a person', argType: 'choice', choices: go });

  // pillar: 掘りたい物 (目印で、今の道具で掘れる物) が手の届かない高さ (1〜4段足りない) にしか見えず、
  // 足場にできるブロックを持っているときだけ。足場は土・丸石を先に使う (板材・原木は小屋の材料なので後回し)
  const pillarMat = pillarMaterial(raw.inventory);
  if (pillarMat) {
    const pil = [];
    for (const b of raw.blocks.filter((x) => x.notable && x.diggable && !collectable.has(x.name))) {
      if (blocked.has(`pillar:${b.name}`)) continue;
      const ps = (b.positions && b.positions.length ? b.positions : [b.nearest]);
      const t = ps.map((p) => ({ p, n: p.y - feetY - maxReachUp })).filter((x) => x.n >= 1 && x.n <= MAX_PILLAR)
        .sort((x, y) => (x.n - y.n) || (x.p.d - y.p.d))[0];
      if (!t || t.n > pillarMat.count) continue;
      pil.push({ id: b.name, label: `${b.name} ${relDir(here, t.p)} ${t.n}段 (${pillarMat.name}で)`, labelEn: `${b.name} (${whereEn(here, t.p)}), ${t.n} blocks up (using ${pillarMat.name})`, target: { x: t.p.x, y: t.p.y, z: t.p.z }, steps: t.n, item: pillarMat.name, block: b.name });
    }
    if (pil.length) out.push({ name: 'pillar', desc: '足元にブロックを積んで登る (登った分だけ高い所に手が届く)', descEn: 'stack blocks under your feet and climb (reach as many blocks higher as you climb)', argType: 'choice', choices: pil });
  }

  // pick_up: 見えている落ちている物を拾いに行く
  const items = new Map();
  for (const e of raw.entities.filter((x) => x.kind === 'item')) if (!items.has(e.name) && !blocked.has(`pick_up:${e.name}`)) items.set(e.name, e);
  if (items.size) {
    out.push({ name: 'pick_up', desc: '落ちている物の所へ歩いて拾う', descEn: 'walk to a dropped item and pick it up', argType: 'choice',
      choices: [...items.values()].map((e) => ({ id: e.name, label: `${e.name} ${relDir(here, e.pos)}`, labelEn: `${e.name} (${whereEn(here, e.pos)})`, item: e.name, entityId: e.id, pos: e.pos })) });
  }

  // explore: mode 'basic' は東西南北 20m (段階1)、'varied' は 8方位 × 近く/遠く・まだ行っていないマス・でたらめ (explore.js)
  const ex = ctx.explore || {};
  out.push({
    name: 'explore',
    desc: ex.mode === 'varied' ? '歩いて新しい場所を見る' : 'その方角へ20ブロックほど歩いて新しい場所を見る',
    descEn: ex.mode === 'varied' ? 'walk and see new places' : 'walk about 20 blocks in that direction and see new places',
    argType: 'choice',
    choices: exploreChoices(here, { ...ex, blocked }),
  });

  // craft: 今の持ち物で作れるもの。作業台が見えていれば作業台が要るものも
  const craftNames = [...raw.craft.now, ...(raw.tableNearby ? raw.craft.withTable : [])];
  if (craftNames.length) {
    out.push({
      name: 'craft', desc: raw.tableNearby ? '作る (作業台が要るものは近くの作業台で)' : '作る (手元で作れるもの)',
      descEn: raw.tableNearby ? 'make an item (items that need a crafting_table are made at the one nearby)' : 'make an item (items that can be made in hand)', argType: 'choice',
      choices: [...new Set(craftNames)].filter((n) => !blocked.has(`craft:${n}`))
        .map((n) => ({ id: n, label: goalItems.has(n) ? `${n} 目標の物` : n, labelEn: goalItems.has(n) ? `${n} (goal item)` : n, item: n, needsTable: !raw.craft.now.includes(n) })),
    });
  }

  // place: 持っているブロックを足元の近くに置く
  const pl = raw.inventory.filter((i) => (placeableNames ? placeableNames.has(i.name) : PLACEABLE_HINT.has(i.name)));
  // 作業台を持っていて近くに無いとき、置けば何が作れるようになるかを書き添える (レシピの知識。世界の状態ではない)
  const unlock = !raw.tableNearby && raw.craft.withTable.length && pl.some((i) => i.name === 'crafting_table')
    ? ` (crafting_table を置くと、その近くで ${raw.craft.withTable.join(', ')} が作れる)` : '';
  const unlockEn = unlock ? ` (with a crafting_table placed, ${raw.craft.withTable.join(', ')} can be made near it)` : '';
  if (pl.length) out.push({ name: 'place', desc: `持っているブロックをすぐ近くに置く${unlock}`, descEn: `place a block you have right next to you${unlockEn}`, argType: 'choice', choices: pl.map((i) => ({ id: i.name, label: `${i.name}x${i.count}`, labelEn: `${i.name} x${i.count}`, item: i.name })) });

  // eat: 空腹で食べ物を持っているとき
  if (raw.self.food < 20) {
    const fd = raw.inventory.filter((i) => foods.has(i.name));
    if (fd.length) out.push({ name: 'eat', desc: '食べる', descEn: 'eat', argType: 'choice', choices: fd.map((i) => ({ id: i.name, label: i.name, item: i.name })) });
  }

  // build: 拠点を知っていて、建てる材料を持っているとき (設計図の次の場所をプログラムが決める。座標は選ばせない)
  if (ctx.base && !disabled.has('build')) {
    const mats = raw.inventory.filter((i) => BUILD_MATERIAL.test(i.name));
    const hut = ctx.hut && ctx.hut.ratio != null ? ` 今${Math.round(ctx.hut.ratio * 100)}%できている` : '';
    if (mats.length) {
      out.push({ name: 'build', desc: `拠点 (${relDir(here, ctx.base)}) に小屋を建てる。決まった形に数個ずつ置く。遠ければ歩いて行く${hut}`,
        descEn: `build a hut at the base (${whereEn(here, ctx.base)}); places a few blocks at a time in a fixed shape; walks there if far${ctx.hut && ctx.hut.ratio != null ? `; ${Math.round(ctx.hut.ratio * 100)}% done now` : ''}`, argType: 'choice',
        // 原木には板材への換算を事実として添える (原木1個 → 板材4個)。どちらを置くかの良し悪しは書かない
        choices: mats.filter((i) => !blocked.has(`build:${i.name}`))
          .map((i) => ({ id: i.name, label: /_log$/.test(i.name) ? `${i.name}x${i.count}(板材にすると${i.count * 4}個)` : `${i.name}x${i.count}`, labelEn: /_log$/.test(i.name) ? `${i.name} x${i.count} (${i.count * 4} as planks)` : `${i.name} x${i.count}`, item: i.name })) });
    }
  }

  // hunt: 見えている動物 (食べ物になる)
  const seenAnimals = new Map();
  for (const e of raw.entities.filter((x) => x.kind === 'mob' && HUNTABLE.has(x.name))) if (!seenAnimals.has(e.name)) seenAnimals.set(e.name, e);
  const hunt = [...seenAnimals.values()].filter((e) => !blocked.has(`hunt:${e.name}`)).map((e) => ({ id: e.name, label: `${e.name} ${relDir(here, e.pos)}`, labelEn: `${e.name} (${whereEn(here, e.pos)})`, mob: e.name }));
  if (hunt.length && !disabled.has('hunt')) out.push({ name: 'hunt', desc: '動物を倒して肉を手に入れる (食べ物)', descEn: 'kill an animal to get meat (food)', argType: 'choice', choices: hunt });

  // attack: 見えている敵か動物 (いちばん強い武器を自動で持つ)
  if (on('attack')) {
    const seen = new Map();
    for (const e of raw.entities.filter((x) => x.kind === 'hostile' || (x.kind === 'mob' && HUNTABLE.has(x.name)))) if (!seen.has(e.name)) seen.set(e.name, e);
    const att = [...seen.values()].filter((e) => !blocked.has(`attack:${e.name}`))
      .map((e) => ({ id: e.name, label: `${e.kind === 'hostile' ? '敵' : ''}${e.name} ${relDir(here, e.pos)}`, labelEn: `${e.kind === 'hostile' ? 'hostile ' : ''}${e.name} (${whereEn(here, e.pos)})`, mob: e.name, hostile: e.kind === 'hostile' }));
    if (att.length) out.push({ name: 'attack', desc: '見えている敵か動物を攻撃する (持っている一番強い武器で)', descEn: 'attack a visible hostile mob or animal (with the strongest weapon you have)', argType: 'choice', choices: att });
  }

  // flee: 敵が近く (fleeRadius) にいるとき、敵から離れる方へ走る
  const fleeR = ctx.fleeRadius ?? 12;
  const near = raw.entities.filter((x) => x.kind === 'hostile' && x.d <= fleeR);
  if (near.length && on('flee') && !blocked.has('flee:away')) {
    out.push({ name: 'flee', desc: '敵から離れる方へ走る', descEn: 'run away from enemies', argType: 'choice',
      choices: [{ id: 'away', label: `敵から離れる (${near.map((e) => `${e.name} ${relDir(here, e.pos)}`).slice(0, 3).join(', ')})`,
        labelEn: `away from ${near.map((e) => `${e.name} (${whereEn(here, e.pos)})`).slice(0, 3).join(', ')}`, from: near.map((e) => e.pos) }] });
  }

  // smelt: かまどが見えていて、焼ける物と燃料を持っているとき
  const furnace = raw.blocks.find((b) => b.name === 'furnace');
  if (furnace && on('smelt')) {
    const sm = [];
    for (const i of raw.inventory) {
      const outName = smeltInput(i.name);
      if (!outName || blocked.has(`smelt:${i.name}`)) continue;
      const f = fuelFor(raw.inventory, i.name);
      if (!f) continue;
      sm.push({ id: i.name, label: `${i.name}x${i.count} → ${outName} (燃料 ${f.name})`, labelEn: `${i.name} x${i.count} -> ${outName} (fuel ${f.name})`, item: i.name, output: outName, fuel: f.name, burns: f.burns, furnace: furnace.nearest });
    }
    if (sm.length) out.push({ name: 'smelt', desc: `かまど (${relDir(here, furnace.nearest)}) で焼く。焼けるまで最大30秒待つ`, descEn: `smelt in the furnace (${whereEn(here, furnace.nearest)}); waits up to 30 seconds for it`, argType: 'choice', choices: sm });
  }

  // sleep: ベッドが見えていて夜のとき (12542〜23459 に寝られる)
  const bed = raw.blocks.find((b) => /_bed$/.test(b.name));
  const tod = ((raw.self.timeOfDay ?? 6000) % 24000 + 24000) % 24000;
  if (bed && tod >= 12542 && tod <= 23459 && on('sleep') && !blocked.has(`sleep:${bed.name}`)) {
    out.push({ name: 'sleep', desc: 'ベッドで寝る', descEn: 'sleep in the bed', argType: 'choice', choices: [{ id: bed.name, label: `${bed.name} ${relDir(here, bed.nearest)}`, labelEn: `${bed.name} (${whereEn(here, bed.nearest)})`, pos: bed.nearest }] });
  }

  // equip: 持ち替えられる道具・武器・防具 (今手に持っている物は除く)
  if (on('equip')) {
    const eq = raw.inventory.filter((i) => GEAR.test(i.name) && i.name !== raw.self.held && !blocked.has(`equip:${i.name}`))
      .map((i) => ({ id: i.name, label: i.name, item: i.name }));
    if (eq.length) out.push({ name: 'equip', desc: '道具・武器を手に持つ、防具を着る', descEn: 'hold a tool or weapon, or put on armor', argType: 'choice', choices: eq });
  }

  // set_base: 自分で拠点を決める設定 (world.base: "self") で、拠点がまだ無いか、拠点から離れているとき
  if (ctx.selfBase && !disabled.has('set_base')) {
    const far = !ctx.base || Math.hypot(ctx.base.x - here.x, ctx.base.z - here.z) > (ctx.setBaseDistance ?? 24);
    if (far) out.push({ name: 'set_base', desc: ctx.base ? `ここを新しい拠点にする (今の拠点は ${relDir(here, ctx.base)})` : 'ここを拠点にする', descEn: ctx.base ? `make this spot the new base (current base: ${whereEn(here, ctx.base)})` : 'make this spot the base', argType: 'choice', choices: [{ id: 'here', label: 'ここ', labelEn: 'here' }] });
  }

  // ask: 困っているとき (同じ行動が続けて失敗した) だけ。声の届く範囲 (hearRadius) の人に聞く (見えていなくてもよい)
  const troubles = ctx.troubles || [];
  if (troubles.length) {
    const near = peopleOf(raw).filter((x) => x.d <= (ctx.hearRadius ?? 48));
    if (near.length) {
      out.push({ name: 'ask', desc: `近くの人に「${troubles[0].about}」を聞く (答えを待つ)`, descEn: `ask a nearby person how to do ${troubles[0].key} (waits for the answer)`, argType: 'choice',
        choices: near.map((e) => ({ id: e.name, label: `${e.name} ${relDir(here, e.pos)}`, labelEn: `${e.name} (${whereEn(here, e.pos)})`, player: e.name, trouble: troubles[0] })) });
    }
  }

  // 右クリックで使う・GUI の出し入れ・協力 (actions_more.js)。設定の act.enable に入れたものだけ
  out.push(...moreActions(raw, { ...ctx, blocked }, on));

  // 手元でできること (craft / build / place / eat) を先に並べる (小さいモデルは先頭の候補に引っぱられやすい)
  const first = ['craft', 'build', 'place', 'eat', 'hunt', 'ask', 'pick_up', 'pillar', 'flee', 'attack', 'smelt', 'sleep', 'equip', 'set_base'];
  const rank = (n) => (first.includes(n) ? first.indexOf(n) : first.length);
  out.sort((a, b) => rank(a.name) - rank(b.name));

  // 全体チャット・提案・共有のチェスト (board.js)。cfg.board.enabled で、act.enable に入れたものだけ。説明は「全員に届く」などの事実だけ
  const bd = ctx.board || null;
  if (bd) {
    if (on('report_find')) out.push({ name: 'report_find', desc: '見つけた物と場所を全員に知らせる (【発見】の行で近くにいない人にも届く。言うことはこのあと考える)', descEn: 'tell everyone about something found and where it is (reaches everyone, near or far; what to say is worked out next)', argType: 'none' });
    if (on('broadcast')) out.push({ name: 'broadcast', desc: '全員に届く声で何か言う (近くにいない人にも届く。言うことはこのあと考える)', descEn: 'say something that reaches everyone, near or far (what to say is worked out next)', argType: 'none' });
    if (on('propose') && !bd.proposedRecently) out.push({ name: 'propose', desc: '全員に提案する (全員に届き、それぞれが賛成するかを決める。賛成が集まると取り決めか共同の目標になる。中身はこのあと考える)', descEn: 'propose something to everyone (it reaches every person; each decides whether to agree; with enough agreement it becomes an agreement or a shared project; what to propose is worked out next)', argType: 'none' });
    // chest_put / chest_take と同じ入れ物 (最後に開けた入れ物が見えていればそれ、なければいちばん近い物)
    const cont = visibleContainers(raw, ctx).filter((c) => /^(chest|trapped_chest|barrel)$/.test(c.name))[0];
    if (on('share_chest') && cont && bd.canShare && !(bd.isShared && bd.isShared(cont.pos)) && !blocked.has(`share_chest:${cont.name}`)) {
      out.push({ name: 'share_chest', desc: 'このチェストを共有にする (全員に知らされ、中身が全員に見えるようになる)', descEn: 'make this chest shared (everyone is told, and everyone can see what is inside)', argType: 'choice',
        choices: [{ id: cont.name, label: `${cont.name} ${relDir(here, cont.pos)}`, labelEn: `${cont.name} (${whereEn(here, cont.pos)})`, pos: { ...cont.pos } }] });
    }
  }

  for (let i = out.length - 1; i >= 0; i--) if (out[i].argType === 'choice' && !out[i].choices.length) out.splice(i, 1);

  out.push({ name: 'say', desc: '近くの人に話しかける (arg に話す内容)', descEn: 'talk to people nearby', argType: 'text' });
  // look_around: 立ち止まって見回すだけ (見える物は毎判断の observe で決まり、向きでは変わらない)。survival_3days は act.disabled で外す
  if (!disabled.has('look_around')) out.push({ name: 'look_around', desc: '立ち止まって周りを見回す', descEn: 'stop and look around', argType: 'none' });
  out.push({ name: 'wait', desc: '少し待つ (arg に秒数 1〜10)', descEn: 'wait a moment', argType: 'number' });
  return out;
}

// "spruce_log 東5北3(6m)" → "spruce_log(東5北3 6m)"
function choiceText(c) {
  if (c.id === c.label) return c.id;
  const rest = c.label.startsWith(c.id) ? c.label.slice(c.id.length).trim() : c.label;
  return `${c.id}(${rest.replace(/\((\d+m)\)$/, ' $1')})`;
}

// プロンプト用の行動一覧の文章
function actionsToText(actions) {
  return actions.map((a) => {
    if (a.argType === 'choice') return `- ${a.name}: ${a.desc}。arg: ${a.choices.map(choiceText).join(' | ')}`;
    if (a.argType === 'text') return `- ${a.name}: ${a.desc}`;
    if (a.argType === 'number') return `- ${a.name}: ${a.desc}`;
    return `- ${a.name}: ${a.desc}。arg は空`;
  }).join('\n');
}

// decider の出した {action, arg} を一覧と突き合わせる。
// 返り値 { ok, action, arg, choice, fixed, error }
function resolveDecision(actions, action, arg) {
  const a = actions.find((x) => x.name === String(action || '').trim().toLowerCase());
  if (!a) return { ok: false, error: `unknown action: ${action}` };
  const s = arg == null ? '' : String(arg).trim();
  if (a.argType === 'none') return { ok: true, action: a.name, arg: '' };
  if (a.argType === 'text') {
    if (!s) return { ok: false, action: a.name, error: 'say の内容が空' };
    return { ok: true, action: a.name, arg: s.slice(0, 100) };
  }
  if (a.argType === 'number') {
    const n = Number.parseFloat(s);
    const v = Number.isFinite(n) ? Math.min(10, Math.max(1, n)) : 3;
    return { ok: true, action: a.name, arg: String(v), fixed: !Number.isFinite(n) };
  }
  // choice: 完全一致 → 大文字小文字・前後の記号を無視 → 部分一致 (1つに決まるときだけ)
  const norm = (x) => String(x).toLowerCase().replace(/^minecraft:/, '').replace(/[\s"'`\[\]()]/g, '');
  let c = a.choices.find((x) => x.id === s);
  let fixed = false;
  // 一覧の表示 "id[説明]" をそのまま写したもの
  if (!c && /[\[(]/.test(s)) { c = a.choices.find((x) => x.id === s.split(/[\[(]/)[0].trim()); fixed = !!c; }
  if (!c) { c = a.choices.find((x) => norm(x.id) === norm(s)); fixed = !!c; }
  if (!c && s) {
    const hits = a.choices.filter((x) => norm(x.id).includes(norm(s)) || norm(s).includes(norm(x.id)));
    if (hits.length === 1) { c = hits[0]; fixed = true; }
  }
  if (!c) return { ok: false, action: a.name, error: `arg "${s}" は ${a.name} の候補にない` };
  return { ok: true, action: a.name, arg: c.id, choice: c, fixed };
}

// 選び方が無効 (Jev が一覧にない物を選んだ・refusal・HTTP エラー) のときの代わりの行動。
// look_around が一覧にあればそれ (first_setting などの古い設定は今のまま)、無ければ search → explore の先頭の候補、どちらも無ければ wait 3 秒
function fallbackDecision(actions) {
  const has = (n) => actions.find((a) => a.name === n);
  if (has('look_around')) return { ok: true, action: 'look_around', arg: '' };
  for (const n of ['search', 'explore']) {
    const a = has(n);
    if (a && a.choices && a.choices.length) {
      const r = resolveDecision(actions, n, a.choices[0].id);
      if (r.ok) return r;
    }
  }
  return { ok: true, action: 'wait', arg: '3' };
}

module.exports = { listActions, actionsToText, resolveDecision, fallbackDecision, pillarMaterial, smeltInput, fuelFor, DIRECTIONS, HUNTABLE, MAX_PILLAR, SMELTABLE, GEAR };
