'use strict';
// 行動の実機の試験 (試験用ワールド world_action_test、peaceful、試験用のボット1人)。
//   bash server-fabric/first_setting_world.sh prepare_action_test && bash /root/mc-server-fabric/start.sh && bash server-fabric/first_setting_world.sh init_action_test
//   node tools/action_test.js [--name Tester]
// サーバーのコンソール (cmd_pipe) で持ち物を渡し、act.js の行動を順に呼んで結果を出す。
// place (かまど・作業台・チェスト・松明・ベッド) → smelt → sleep → equip → attack → pick_up → pillar (+ collect) → flee
const fs = require('fs');
const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const { handlers } = require('../src/act');
const { Memory } = require('../src/memory');
const { sleep } = require('../src/util');

const args = process.argv.slice(2);
const NAME = args.includes('--name') ? args[args.indexOf('--name') + 1] : 'Tester';
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
  const fpos = bot.findBlock({ matching: bot.registry.blocksByName.furnace.id, maxDistance: 8 });
  await run('smelt beef', () => (fpos ? handlers.smelt(bot, { item: 'beef', fuel: 'oak_planks', burns: 1.5, furnace: fpos.position }, { ...ctx, smeltWaitMs: 30000 }) : { ok: false, msg: 'かまどが無い' }));
  // 寝る (playersSleepingPercentage 0 なので1人で夜が明ける)
  await cmd('time set 13000', 800);
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

main().catch((e) => { console.error(e); process.exit(1); });
