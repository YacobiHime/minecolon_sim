'use strict';
// 行動の実機の試験 (試験用ワールド world_action_test、peaceful、試験用のボット1人)。
//   bash server-fabric/first_setting_world.sh prepare_action_test && bash /root/mc-server-fabric/start.sh && bash server-fabric/first_setting_world.sh init_action_test
//   node tools/action_test.js [--name Tester] [--part base|more|all] [--only use_on,trade]
// サーバーのコンソール (cmd_pipe) で持ち物を渡し、act.js の行動を順に呼んで結果を出す。
// more: use_on (耕す・植える・骨粉・水・瓶・釣り・ボート・牛乳・毛刈り・繁殖・扉・レバー・ゲート・弓) → use_item → chest/furnace → trade → enchant/brew/anvil → follow/give/call (2人目のボット)
// base: place (かまど・作業台・チェスト・松明・ベッド) → smelt → sleep → equip → attack → pick_up → pillar (+ collect) → flee
const fs = require('fs');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const { handlers } = require('../src/act');
const { Memory } = require('../src/memory');
const { sleep } = require('../src/util');
const { collectRaw } = require('../src/observe');
const { listActions } = require('../src/actions');
const { MORE_ACTIONS } = require('../src/actions_more');

const args = process.argv.slice(2);
const NAME = args.includes('--name') ? args[args.indexOf('--name') + 1] : 'Tester';
// --part base (これまでの行動) | more (右クリック・GUI・協力) | all。--only boat,trade (more の中で名前にその文字を含むものだけ)
const PART = args.includes('--part') ? args[args.indexOf('--part') + 1] : 'all';
const ONLY = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;
const PIPE = process.env.CMD_PIPE || '/root/mc-server-fabric/cmd_pipe';
const cmd = async (c, wait = 400) => { fs.writeFileSync(PIPE, c + '\n'); await sleep(wait); };

async function main() {
  const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: NAME, version: '1.20.1', auth: 'offline' });
  bot.loadPlugin(pathfinder);
  await new Promise((res, rej) => { bot.once('spawn', res); bot.once('error', rej); });
  const mv = new Movements(bot); mv.canDig = true; mv.allow1by1towers = false; bot.pathfinder.setMovements(mv);
  await Promise.race([bot.waitForChunksToLoad(), sleep(10000)]);
  await sleep(1000);
  const mem = new Memory();
  const out = [];
  const run = async (name, fn) => {
    const t0 = Date.now();
    let r;
    try { r = await fn(); } catch (e) { r = { ok: false, msg: `例外: ${e.message}` }; }
    const rec = { name, ok: !!(r && r.ok), msg: r && r.msg, ms: Date.now() - t0, extra: r && (r.smelt || r.sleep || r.weapon || null) };
    out.push(rec);
    console.log(`${rec.ok ? 'OK' : 'NG'} ${name}: ${rec.msg} (${rec.ms}ms)${rec.extra ? ' ' + JSON.stringify(rec.extra) : ''}`);
    return r;
  };
  const p0 = bot.entity.position.floored();
  console.log(`spawned at ${p0}`);
  if (PART === 'more' || PART === 'all') await moreTests(bot, run, mem);
  if (PART === 'more') {
    console.log(JSON.stringify({ results: out }));
    bot.quit();
    setTimeout(() => process.exit(0), 500);
    return;
  }
  await cmd(`clear ${NAME}`);
  await cmd('time set 1000');
  for (const [item, n] of [['furnace', 1], ['crafting_table', 1], ['chest', 1], ['torch', 4], ['red_bed', 1], ['beef', 3], ['oak_planks', 16], ['dirt', 8], ['stone_sword', 1], ['iron_helmet', 1], ['wooden_axe', 1]]) {
    await cmd(`give ${NAME} minecraft:${item} ${n}`, 150);
  }
  await sleep(1000);
  const ctx = { memory: mem, visionRadius: 16, maxReachUp: 4 };

  // 置く
  for (const it of ['furnace', 'crafting_table', 'chest', 'torch', 'red_bed']) await run(`place ${it}`, () => handlers.place(bot, { item: it }, ctx));
  // 焼く
  const fpos = bot.findBlock({ matching: (b) => b && b.name === 'furnace', maxDistance: 8 });
  await run('smelt beef', () => (fpos ? handlers.smelt(bot, { item: 'beef', fuel: 'oak_planks', burns: 1.5, furnace: fpos.position }, { ...ctx, smeltWaitMs: 30000 }) : { ok: false, msg: 'かまどが無い' }));
  // 寝る (playersSleepingPercentage 0 なので1人で夜が明ける)
  await cmd('time set 13000', 2500);
  const bed = bot.findBlock({ matching: (b) => bot.isABed(b), maxDistance: 8 });
  await run('sleep', () => (bed ? handlers.sleep(bot, { pos: bed.position }, { ...ctx, sleepWaitMs: 20000 }) : { ok: false, msg: 'ベッドが無い' }));
  console.log(`  timeOfDay after sleep: ${bot.time.timeOfDay}`);
  // 持ち替える
  await run('equip iron_helmet', () => handlers.equip(bot, { item: 'iron_helmet' }));
  await run('equip wooden_axe', () => handlers.equip(bot, { item: 'wooden_axe' }));
  // 攻撃 (牛を出す。いちばん強い武器 = stone_sword を自動で持つ)
  const p = bot.entity.position;
  await cmd(`summon minecraft:cow ${Math.floor(p.x) + 3} ${Math.floor(p.y)} ${Math.floor(p.z)}`, 1500);
  await run('attack cow', () => handlers.attack(bot, { mob: 'cow' }, ctx));
  // 拾う (落ちている原木を出す)
  const q = bot.entity.position;
  await cmd(`summon minecraft:item ${Math.floor(q.x) + 3} ${Math.floor(q.y) + 1} ${Math.floor(q.z) + 1} {Item:{id:"minecraft:oak_log",Count:2b}}`, 1500);
  await run('pick_up oak_log', () => handlers.pick_up(bot, { item: 'oak_log' }, ctx));
  // 登る: 6段上に原木を置き、足場を積んで collect できるか
  const r0 = bot.entity.position.floored();
  const tgt = { x: r0.x + 1, y: r0.y + 6, z: r0.z };
  await cmd(`setblock ${tgt.x} ${tgt.y} ${tgt.z} minecraft:oak_log`, 1000);
  await run('pillar 2段', () => handlers.pillar(bot, { target: tgt, steps: 2, item: 'dirt', block: 'oak_log' }, ctx));
  await run('collect oak_log (登ったあと)', () => handlers.collect(bot, { block: 'oak_log' }, { ...ctx, collectCount: 1 }));
  // 逃げる (peaceful なので敵はいない。東3ブロックに敵がいるつもりで)
  const f = bot.entity.position;
  await run('flee', () => handlers.flee(bot, { from: [{ x: f.x + 3, y: f.y, z: f.z }] }, ctx));
  console.log(`memory places: ${mem.places.map((x) => x.kind).join(', ')}`);
  console.log(`inventory: ${bot.inventory.items().map((i) => `${i.name}x${i.count}`).join(', ')}`);
  console.log(JSON.stringify({ results: out }));
  bot.quit();
  setTimeout(() => process.exit(0), 500);
}

// 右クリックで使う・GUI の出し入れ・協力 (act_more.js)。足元を平らにして、試験の物を /give・/setblock・/summon で用意する
async function moreTests(bot, run0, mem) {
  const run = (name, fn) => (ONLY && ![...ONLY].some((k) => name.includes(k)) ? null : run0(name, fn));
  const ctx = { memory: mem, visionRadius: 16, maxReachUp: 4, fishMs: 60000, followMs: 8000 };
  const H = handlers;
  const P = bot.entity.position.floored();
  const { x, y, z } = P;
  const at = (dx, dy, dz) => ({ x: x + dx, y: y + dy, z: z + dz });
  const sb = (p, b, w = 150) => cmd(`setblock ${p.x} ${p.y} ${p.z} ${b}`, w);
  const nearestEnt = (name, max = 16) => Object.values(bot.entities).filter((e) => e.name === name && e.position.distanceTo(bot.entity.position) < max)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
  const blockName = (p) => { const b = bot.blockAt(new Vec3(p.x, p.y, p.z)); return b ? b.name : null; };
  const home = () => cmd(`tp ${NAME} ${x + 0.5} ${y} ${z + 0.5}`, 800);
  await cmd(`clear ${NAME}`);
  await cmd('time set 1000');
  await cmd('weather clear');
  await cmd(`kill @e[type=!player,x=${x},y=${y},z=${z},distance=..40]`, 500);
  await cmd(`fill ${x - 10} ${y - 3} ${z - 10} ${x + 10} ${y - 2} ${z + 10} minecraft:dirt`, 300);
  await cmd(`fill ${x - 10} ${y - 1} ${z - 10} ${x + 10} ${y - 1} ${z + 10} minecraft:grass_block`, 300);
  await cmd(`fill ${x - 10} ${y} ${z - 10} ${x + 10} ${y + 6} ${z + 10} minecraft:air`, 300);
  await home();
  const gives = [['wooden_hoe', 1], ['wheat_seeds', 4], ['bone_meal', 8], ['bucket', 2], ['shears', 1], ['wheat', 6], ['oak_boat', 1], ['fishing_rod', 1],
    ['flint_and_steel', 1], ['bread', 4], ['beef', 2], ['emerald', 4], ['lapis_lazuli', 6], ['iron_sword', 1], ['blaze_powder', 2], ['nether_wart', 2],
    ['glass_bottle', 1], ['bow', 1], ['arrow', 8], ['shield', 1], ['snowball', 4]];
  for (const [it, n] of gives) await cmd(`give ${NAME} minecraft:${it} ${n}`, 120);
  await cmd(`give ${NAME} minecraft:potion{Potion:"minecraft:water"} 2`, 120);
  await cmd(`give ${NAME} minecraft:iron_pickaxe{Damage:200} 1`, 120);
  await cmd(`give ${NAME} minecraft:iron_pickaxe{Damage:150} 1`, 120);
  await cmd(`xp add ${NAME} 40 levels`, 500);
  await sleep(1000);

  // 農業: 耕す → 植える → 骨粉 → 育ちきった小麦を collect / 素手で使う
  const soil = at(2, -1, 2);
  await run('use_on wooden_hoe>grass_block (耕す)', () => H.use_on(bot, { item: 'wooden_hoe', target: 'grass_block', targetKind: 'block', pos: soil }, ctx));
  await run('use_on wheat_seeds>farmland (植える)', () => H.use_on(bot, { item: 'wheat_seeds', target: 'farmland', targetKind: 'block', pos: soil }, ctx));
  await run('use_on bone_meal>wheat (骨粉)', () => H.use_on(bot, { item: 'bone_meal', target: 'wheat', targetKind: 'block', pos: at(2, 0, 2) }, ctx));
  await sb(at(3, -1, 2), 'minecraft:farmland'); await sb(at(3, 0, 2), 'minecraft:wheat[age=7]');
  await sb(at(4, -1, 2), 'minecraft:farmland'); await sb(at(4, 0, 2), 'minecraft:wheat[age=7]', 800);
  await run('collect wheat (収穫)', () => H.collect(bot, { block: 'wheat' }, { ...ctx, collectCount: 2 }));
  await sb(at(2, 0, 2), 'minecraft:wheat[age=7]', 800);
  await run('use_on hand>wheat (素手、熟した小麦)', () => H.use_on(bot, { item: 'hand', target: 'wheat', targetKind: 'block', pos: at(2, 0, 2) }, ctx));

  // 水: すくう・置く・瓶に汲む・釣り・ボート
  await cmd(`fill ${x - 10} ${y - 1} ${z - 4} ${x - 4} ${y - 1} ${z + 3} minecraft:water`, 800);
  await run('use_on bucket>water (すくう)', () => H.use_on(bot, { item: 'bucket', target: 'water', targetKind: 'block', pos: at(-5, -1, 0) }, ctx));
  await run('use_on water_bucket>grass_block (置く)', () => H.use_on(bot, { item: 'water_bucket', target: 'grass_block', targetKind: 'block', pos: at(0, -1, -3) }, ctx));
  await run('use_on glass_bottle>water (瓶に汲む)', () => H.use_on(bot, { item: 'glass_bottle', target: 'water', targetKind: 'block', pos: at(-5, -1, 0) }, ctx));
  await run('use_on fishing_rod>water (釣り)', () => H.use_on(bot, { item: 'fishing_rod', target: 'water', targetKind: 'block', pos: at(-6, -1, -1) }, ctx));
  await run('use_on oak_boat>water (浮かべる)', () => H.use_on(bot, { item: 'oak_boat', target: 'water', targetKind: 'block', pos: at(-6, -1, 0) }, ctx));
  await sleep(500);
  const boat = nearestEnt('boat')[0];
  await run('use_on hand>boat (乗る)', () => (boat ? H.use_on(bot, { item: 'hand', target: 'boat', targetKind: 'entity', entityId: boat.id }, ctx) : { ok: false, msg: 'ボートが無い' }));
  await run('dismount', () => H.dismount(bot, {}, ctx));
  await home();

  // 動物: 牛乳・毛刈り・繁殖
  // 繁殖を見るため牛は動けるようにする (NoAI だと近づき合えず子が生まれない)
  await cmd(`summon minecraft:cow ${x + 3} ${y} ${z - 2}`, 200);
  await cmd(`summon minecraft:cow ${x + 4} ${y} ${z - 2}`, 200);
  await cmd(`summon minecraft:sheep ${x - 2} ${y} ${z + 3} {NoAI:1b}`, 1500);
  const cows = nearestEnt('cow');
  await run('use_on bucket>cow (牛乳)', () => H.use_on(bot, { item: 'bucket', target: 'cow', targetKind: 'entity', entityId: cows[0] && cows[0].id }, ctx));
  await run('use_item milk_bucket (飲む)', () => H.use_item(bot, { item: 'milk_bucket' }, ctx));
  const sheep = nearestEnt('sheep')[0];
  await run('use_on shears>sheep (毛刈り)', () => H.use_on(bot, { item: 'shears', target: 'sheep', targetKind: 'entity', entityId: sheep && sheep.id }, ctx));
  const nCows = nearestEnt('cow', 30).length;
  await run('use_on wheat>cow (1匹目)', () => H.use_on(bot, { item: 'wheat', target: 'cow', targetKind: 'entity', entityId: cows[0] && cows[0].id }, ctx));
  await run('use_on wheat>cow (2匹目)', () => H.use_on(bot, { item: 'wheat', target: 'cow', targetKind: 'entity', entityId: cows[1] && cows[1].id }, ctx));
  await sleep(8000);
  console.log(`  cows: ${nCows} → ${nearestEnt('cow', 30).length} (繁殖すると子が増える)`);

  // 扉・レバー
  await sb(at(0, 0, 5), 'minecraft:oak_door[half=lower,facing=north]', 100); await sb(at(0, 1, 5), 'minecraft:oak_door[half=upper,facing=north]', 100);
  await sb(at(-2, 0, 4), 'minecraft:lever[face=floor,facing=north]', 800);
  await run('use_on hand>oak_door (扉)', () => H.use_on(bot, { item: 'hand', target: 'oak_door', targetKind: 'block', pos: at(0, 0, 5) }, ctx));
  await run('use_on hand>lever (レバー)', () => H.use_on(bot, { item: 'hand', target: 'lever', targetKind: 'block', pos: at(-2, 0, 4) }, ctx));

  // ネザーのゲート: 黒曜石の枠 (横4 x 縦5) の下の内側に火打石
  const fx = x + 5; const fz = z - 6;
  await cmd(`fill ${fx} ${y} ${fz} ${fx + 3} ${y + 4} ${fz} minecraft:obsidian`, 200);
  await cmd(`fill ${fx + 1} ${y + 1} ${fz} ${fx + 2} ${y + 3} ${fz} minecraft:air`, 800);
  await run('use_on flint_and_steel>obsidian (ゲート)', () => H.use_on(bot, { item: 'flint_and_steel', target: 'obsidian', targetKind: 'block', pos: { x: fx + 1, y, z: fz } }, ctx));
  await sleep(500);
  console.log(`  portal: ${blockName({ x: fx + 1, y: y + 1, z: fz })}`);
  await cmd(`fill ${fx} ${y} ${fz} ${fx + 3} ${y + 4} ${fz} minecraft:air`, 300);
  await home();

  // 撃つ・構える・投げる
  await cmd(`summon minecraft:pig ${x + 0.5} ${y} ${z + 9.5} {NoAI:1b}`, 1500);
  const pig = nearestEnt('pig', 20)[0];
  await run('use_on bow>pig (弓)', () => H.use_on(bot, { item: 'bow', target: 'pig', targetKind: 'entity', entityId: pig && pig.id }, ctx));
  await run('use_item shield (構える)', () => H.use_item(bot, { item: 'shield' }, { ...ctx, shieldMs: 1500 }));
  await run('use_item snowball (投げる)', () => H.use_item(bot, { item: 'snowball' }, ctx));
  await home();

  // チェスト・かまど
  await sb(at(-2, 0, -3), 'minecraft:chest');
  await sb(at(-1, 0, -4), 'minecraft:furnace{Items:[{Slot:0b,id:"minecraft:beef",Count:1b},{Slot:1b,id:"minecraft:coal",Count:2b},{Slot:2b,id:"minecraft:cooked_beef",Count:3b}]}', 800);
  await run('chest_put bread', () => H.chest_put(bot, { item: 'bread', pos: at(-2, 0, -3) }, ctx));
  await run('chest_take look', () => H.chest_take(bot, { look: true, pos: at(-2, 0, -3) }, ctx));
  await run('chest_take bread', () => H.chest_take(bot, { item: 'bread', pos: at(-2, 0, -3) }, ctx));
  await run('furnace_take output', () => H.furnace_take(bot, { what: 'output', pos: at(-1, 0, -4) }, ctx));
  await run('furnace_take all', () => H.furnace_take(bot, { what: 'all', pos: at(-1, 0, -4) }, ctx));

  // 村人と取引
  await cmd(`summon minecraft:villager ${x + 2.5} ${y} ${z - 5.5} {NoAI:1b,VillagerData:{profession:"minecraft:farmer",level:2,type:"minecraft:plains"},Offers:{Recipes:[{buy:{id:"minecraft:emerald",Count:1b},sell:{id:"minecraft:bread",Count:6b},maxUses:12},{buy:{id:"minecraft:wheat",Count:20b},sell:{id:"minecraft:emerald",Count:1b},maxUses:16}]}}`, 1500);
  const vil = nearestEnt('villager')[0];
  await run('trade look', () => (vil ? H.trade(bot, { entityId: vil.id, look: true }, ctx) : { ok: false, msg: '村人がいない' }));
  await run('trade 0 (emerald → bread)', () => (vil ? H.trade(bot, { entityId: vil.id, index: 0 }, ctx) : { ok: false, msg: '村人がいない' }));

  // エンチャント台・醸造台・金床
  await sb(at(1, 0, -6), 'minecraft:enchanting_table');
  await sb(at(-3, 0, -6), 'minecraft:brewing_stand');
  await sb(at(-1, 0, -7), 'minecraft:anvil', 800);
  await run('enchant iron_sword:1', () => H.enchant(bot, { item: 'iron_sword', slot: 1, pos: at(1, 0, -6) }, ctx));
  await run('brew nether_wart', () => H.brew(bot, { item: 'nether_wart', pos: at(-3, 0, -6) }, { ...ctx, brewWaitMs: 25000 }));
  await run('anvil iron_pickaxe+iron_pickaxe', () => H.anvil(bot, { a: 'iron_pickaxe', b: 'iron_pickaxe', pos: at(-1, 0, -7) }, ctx));

  // 協力: 2人目のボットについて行く・渡す・呼ぶ
  const b2 = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: `${NAME}2`, version: '1.20.1', auth: 'offline' });
  b2.loadPlugin(pathfinder);
  await new Promise((res, rej) => { b2.once('spawn', res); b2.once('error', rej); });
  await cmd(`tp ${NAME}2 ${x + 3.5} ${y} ${z + 0.5}`, 1500);
  const heard = [];
  b2.on('chat', (u, m) => { if (u === NAME) heard.push(m); });
  const mv2 = new Movements(b2); mv2.canDig = false; b2.pathfinder.setMovements(mv2);
  const walk = b2.pathfinder.goto(new goals.GoalNear(x + 9, y, z + 8, 1)).catch(() => {});
  await run('follow Tester2', () => H.follow(bot, { player: `${NAME}2` }, ctx));
  await walk;
  const breadOf = (b) => b.inventory.items().filter((i) => i.name === 'bread').reduce((s, i) => s + i.count, 0);
  const before2 = breadOf(b2);
  await run('give Tester2 bread 2', () => H.give(bot, { player: `${NAME}2`, item: 'bread', count: 2 }, ctx));
  await sleep(1500);
  console.log(`  ${NAME}2 bread: ${before2} → ${breadOf(b2)} (${NAME} は ${breadOf(bot)})`);
  await run('call Tester2', () => H.call(bot, { player: `${NAME}2` }, { ...ctx, chat: (t) => { bot.chat(t); return true; } }));
  await sleep(1500);
  console.log(`  ${NAME}2 heard: ${JSON.stringify(heard)}`);
  b2.quit();

  // 実機の観測から行動一覧を作って、選択肢の数を見る
  const raw = collectRaw(bot, { visionRadius: 16 });
  const enable = new Set(['attack', 'flee', 'smelt', 'sleep', 'equip', ...MORE_ACTIONS]);
  const acts = listActions(raw, { enable, foods: new Set(Object.keys(bot.registry.foodsByName)), containers: mem.extra.containers, trades: mem.extra.trades });
  console.log(`  actions: ${acts.map((a) => `${a.name}:${a.choices ? a.choices.length : 1}`).join(' ')}`);
  console.log(`  containers: ${JSON.stringify(mem.extra.containers)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
