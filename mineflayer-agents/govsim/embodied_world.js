'use strict';
// GovSim の Minecraft の中の版: サーバーと bot をつなぐ所 (テストでは govsim/embodied_sim.js に偽物の world を渡す)。
//   ServerConsole : cmd_pipe にコマンドを送り、console.log から答えを読む (池の魚の本当の数は scoreboard で数える)
//   FisherBot     : 1人の bot (mineflayer + pathfinder)。歩く・池を見て数える・魚を取る・食べる・チャット・心のモデルの材料 (sense)
//   MinecraftWorld: 場所 (池・集まる所・家) を作り、上の2つを embodied_sim.js の world の約束にまとめる
//
// 場所 (原点 O = (x0, y0, z0)、y0 = 立つ高さ。1つの実行 = 1つの場所。--site で 200 ブロックずつずらすと同時に動かせる):
//   平らな地面 x0−12..x0+12、z0−10..z0+36 (草。上は y0+12 まで空気)
//   池: 水 7×7×2 (x0−3..x0+3、z0−3..z0+3、y0−2..y0−1)。周りは地面。魚 (cod) はタグ gs_<site> 付き・消えない・落とし物なし
//   池の縁: 池の中心から 4 マスの四角の1周 (ここに立って取る。手が届くのは 5 ブロックまで)
//   集まる所 (話し合い): (x0, z0+22)。家: z0+30 に 4 マスおき。池から 16 ブロックより遠い (見分けられる距離の外)
const fs = require('fs');
const path = require('path');
const { Vec3 } = require('vec3');
const { senseShelter, effectiveLight } = require('../src/needs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

class ServerConsole {
  constructor({ mcDir = '/root/mc-server-fabric', log = () => {} } = {}) {
    this.mcDir = mcDir;
    this.pipe = path.join(mcDir, 'cmd_pipe');
    this.consoleLog = path.join(mcDir, 'console.log');
    this.log = log;
    this.queue = Promise.resolve();
  }

  // 1行送る (読む側がいなければ失敗。止まらないように O_NONBLOCK)
  sendNow(cmd) {
    const fd = fs.openSync(this.pipe, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    try { fs.writeSync(fd, `${cmd}\n`); } finally { fs.closeSync(fd); }
  }

  async send(cmd, gapMs = 60) {
    this.queue = this.queue.then(async () => { this.sendNow(cmd); await sleep(gapMs); });
    return this.queue;
  }

  size() { try { return fs.statSync(this.consoleLog).size; } catch (_) { return 0; } }
  readFrom(off) {
    const fd = fs.openSync(this.consoleLog, 'r');
    try {
      const n = this.size() - off;
      if (n <= 0) return '';
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, off);
      return buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  }

  // コマンドを送り、console.log の新しい行から re に合う最初の行を待つ
  async query(cmds, re, timeoutMs = 5000) {
    let off;
    this.queue = this.queue.then(async () => {
      off = this.size();
      for (const c of [].concat(cmds)) { this.sendNow(c); await sleep(30); }
    });
    await this.queue;
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const m = this.readFrom(off).match(re);
      if (m) return m;
      await sleep(100);
    }
    return null;
  }
}

// 見通し: from から to まで、0.25 ずつ進んで固いブロック (boundingBox 'block') が無いか。水・草は通す
function lineOfSight(blockAt, from, to, { step = 0.25 } = {}) {
  const d = d3(from, to);
  const n = Math.max(1, Math.ceil(d / step));
  const start = `${Math.floor(from.x)},${Math.floor(from.y)},${Math.floor(from.z)}`;
  const end = `${Math.floor(to.x)},${Math.floor(to.y)},${Math.floor(to.z)}`;
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const x = from.x + (to.x - from.x) * t; const y = from.y + (to.y - from.y) * t; const z = from.z + (to.z - from.z) * t;
    const key = `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
    if (key === start || key === end) continue;
    const b = blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)));
    if (b && b.boundingBox === 'block') return false;
  }
  return true;
}

class Layout {
  constructor({ x0, y0, z0, n }) {
    Object.assign(this, { x0, y0, z0, n });
    this.pondHalf = 3;
    this.rimDist = 4;
    this.meeting = { x: x0 + 0.5, y: y0, z: z0 + 22.5 };
    this.homes = Array.from({ length: n }, (_, i) => ({ x: x0 - 8 + 4 * (i % 5) + 0.5, y: y0, z: z0 + 30 + 4 * Math.floor(i / 5) + 0.5 }));
  }
  inPond(p) { return Math.abs(p.x - (this.x0 + 0.5)) <= this.pondHalf + 0.6 && Math.abs(p.z - (this.z0 + 0.5)) <= this.pondHalf + 0.6 && p.y > this.y0 - 3.2 && p.y < this.y0 + 0.5; }
  // 縁の立つ所 (ブロックの中心)
  rimCells() {
    const r = this.rimDist; const out = [];
    for (let d = -r; d <= r; d++) { out.push({ x: this.x0 + d, z: this.z0 - r }, { x: this.x0 + d, z: this.z0 + r }); }
    for (let d = -r + 1; d <= r - 1; d++) { out.push({ x: this.x0 - r, z: this.z0 + d }, { x: this.x0 + r, z: this.z0 + d }); }
    return out.map((c) => ({ x: c.x + 0.5, y: this.y0, z: c.z + 0.5 }));
  }
  nearestRim(p) { return this.rimCells().reduce((best, c) => (d3(c, p) < d3(best, p) ? c : best)); }
  // 池の全体が見える所 (着いたら数える)
  lakeView() { return { x: this.x0 + 0.5, y: this.y0, z: this.z0 + this.rimDist + 0.5 }; }
  buildCommands() {
    const { x0, y0, z0 } = this; const h = this.pondHalf;
    return [
      `fill ${x0 - 12} ${y0 - 5} ${z0 - 10} ${x0 + 12} ${y0 - 2} ${z0 + 36} dirt`,
      `fill ${x0 - 12} ${y0 - 1} ${z0 - 10} ${x0 + 12} ${y0 - 1} ${z0 + 36} grass_block`,
      `fill ${x0 - 12} ${y0} ${z0 - 10} ${x0 + 12} ${y0 + 12} ${z0 + 36} air`,
      `fill ${x0 - h} ${y0 - 3} ${z0 - h} ${x0 + h} ${y0 - 3} ${z0 + h} stone`,
      `fill ${x0 - h} ${y0 - 2} ${z0 - h} ${x0 + h} ${y0 - 1} ${z0 + h} water`,
    ];
  }
}

class FisherBot {
  constructor({ name, username, host = 'localhost', port = 25565, version = '1.20.1', log = () => {}, group = () => [] }) {
    Object.assign(this, { name, username, host, port, version, log });
    this.group = group; // 同じ実行の人の username → name (チャットはこの人たちのものだけ聞く。同時に動かしたほかの場所の声は捨てる)
    this.heard = []; // { from (name), text, t (Date.now()) }
    this.bot = null;
  }

  async connect() {
    const mineflayer = require('mineflayer');
    const { pathfinder, Movements } = require('mineflayer-pathfinder');
    const bot = mineflayer.createBot({ host: this.host, port: this.port, username: this.username, version: this.version, auth: 'offline' });
    this.bot = bot;
    bot.loadPlugin(pathfinder);
    bot.on('chat', (username, message) => {
      const from = this.group()[username];
      if (!from) return;
      this.heard.push({ from, text: String(message), t: Date.now() });
    });
    bot.on('kicked', (r) => this.log({ type: 'bot_kicked', who: this.name, reason: String(JSON.stringify(r)).slice(0, 300) }));
    bot.on('error', (e) => this.log({ type: 'bot_error', who: this.name, error: String(e && e.message).slice(0, 200) }));
    bot.on('end', (r) => { this.ended = true; this.log({ type: 'bot_end', who: this.name, reason: String(r) }); });
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error(`${this.username}: 30 秒で入れなかった`)), 30000);
      bot.once('spawn', () => { clearTimeout(to); resolve(); });
      bot.once('error', (e) => { clearTimeout(to); reject(e); });
    });
    const mv = new Movements(bot);
    mv.canDig = false; mv.allowParkour = false; mv.allow1by1towers = false; mv.scafoldingBlocks = []; mv.liquidCost = 50; mv.allowSprinting = false;
    bot.pathfinder.setMovements(mv);
    bot.pathfinder.thinkTimeout = 3000;
  }

  pos() { return this.bot && this.bot.entity ? this.bot.entity.position : null; }
  eye() { const p = this.pos(); return p ? p.offset(0, 1.62, 0) : null; }
  age() { return this.bot && this.bot.time ? Number(this.bot.time.age) : null; }

  async goto(p, range = 0.8, timeoutMs = 20000) {
    const { goals } = require('mineflayer-pathfinder');
    if (this.pos() && d3(this.pos(), p) <= range + 0.5) return true;
    const goal = new goals.GoalNear(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), Math.max(0, Math.round(range)));
    try {
      await Promise.race([this.bot.pathfinder.goto(goal), sleep(timeoutMs).then(() => { throw new Error('timeout'); })]);
      return true;
    } catch (e) {
      try { this.bot.pathfinder.stop(); } catch (_) { /* ignore */ }
      this.log({ type: 'goto_fail', who: this.name, to: { x: p.x, y: p.y, z: p.z }, error: String(e && e.message).slice(0, 100) });
      return false;
    }
  }

  canSee(toPos) {
    const e = this.eye();
    if (!e) return false;
    return lineOfSight((v) => this.bot.blockAt(v), e, toPos);
  }

  // 池の中に見えている魚 (cod)。見通しのあるものだけ
  visibleFish(layout) {
    return Object.values(this.bot.entities).filter((e) => e && e.name === 'cod' && e.position && layout.inPond(e.position) && this.canSee(e.position.offset(0, 0.2, 0)));
  }

  // 1匹取る。claims: 同じ魚を2人で狙わないための印 (同じプロセスの中の取り決めではなく、誰の手柄かを1つに決めるため)。
  // 返り値 { ok, fishId, fishPos } | { ok: false, reason }
  async catchOne(layout, claims, deadlineMs) {
    const fish = this.visibleFish(layout).filter((e) => !claims.has(e.id));
    if (!fish.length) return { ok: false, reason: 'no_fish_visible' };
    const me = this.pos();
    fish.sort((a, b) => d3(a.position, me) - d3(b.position, me));
    const target = fish[0];
    claims.add(target.id);
    try {
      for (let tries = 0; tries < 4 && Date.now() < deadlineMs; tries++) {
        if (!this.bot.entities[target.id]) return { ok: false, reason: 'gone' };
        if (d3(this.pos(), target.position) > 4.5) {
          await this.goto(layout.nearestRim(target.position), 0, Math.max(1000, Math.min(10000, deadlineMs - Date.now())));
        }
        if (!this.bot.entities[target.id]) return { ok: false, reason: 'gone' };
        if (d3(this.pos(), target.position) > 5.2) continue;
        const fishPos = target.position.clone();
        try { await this.bot.lookAt(target.position.offset(0, 0.2, 0), true); } catch (_) { /* ignore */ }
        const dead = new Promise((resolve) => {
          const onDead = (e) => { if (e.id === target.id) { cleanup(); resolve(true); } };
          const cleanup = () => { this.bot.removeListener('entityDead', onDead); this.bot.removeListener('entityGone', onDead); };
          this.bot.on('entityDead', onDead); this.bot.on('entityGone', onDead);
          setTimeout(() => { cleanup(); resolve(false); }, 1200);
        });
        this.bot.attack(target);
        if (await dead) return { ok: true, fishId: target.id, fishPos };
      }
      return { ok: false, reason: 'not_killed' };
    } finally { claims.delete(target.id); }
  }

  countItem(name) { return this.bot.inventory.items().filter((i) => i.name === name).reduce((s, i) => s + i.count, 0); }

  async holdSword() {
    const sw = this.bot.inventory.items().find((i) => i.name === 'iron_sword');
    if (sw) { try { await this.bot.equip(sw, 'hand'); } catch (_) { /* ignore */ } }
  }

  // 満腹度が maxFood 以下で、取った魚 (raw cod) を持っていれば食べる。食べた数
  async eat({ maxFood = 18, max = 10 } = {}) {
    let n = 0;
    while (n < max && this.bot.food <= maxFood) {
      const cod = this.bot.inventory.items().find((i) => i.name === 'cod');
      if (!cod) break;
      try {
        await this.bot.equip(cod, 'hand');
        await Promise.race([this.bot.consume(), sleep(4000).then(() => { throw new Error('timeout'); })]);
        n += 1;
      } catch (e) { this.log({ type: 'eat_fail', who: this.name, error: String(e && e.message).slice(0, 100) }); break; }
    }
    await this.holdSword();
    return n;
  }

  // 1発言を 240 字以下の行に分けて送る (embodied_sim.js の chatChunks。続きのある行は " ~" で終わる)。返り値は送った発言 (つないだもの)
  chat(text) {
    const { chatChunks } = require('./embodied_sim');
    for (const p of chatChunks(text)) this.bot.chat(p);
    return chatChunks(text, Infinity).join('');
  }

  // 心のモデルの材料 (agent.js の senseNeeds と同じもの)。others: [{name, username}]
  sense({ home, others }) {
    const bot = this.bot; const p = this.pos();
    if (!bot || !p) return null;
    const s = { time: this.age(), timeOfDay: Number(bot.time.timeOfDay), food: bot.food, saturation: bot.foodSaturation, health: bot.health };
    try {
      const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z));
      s.shelter = senseShelter(at, p);
      const b = at(Math.floor(p.x), Math.floor(p.y) + 1, Math.floor(p.z));
      if (b) s.light = effectiveLight({ blockLight: b.light ?? 0, skyLight: b.skyLight ?? 15 }, s.timeOfDay);
    } catch (_) { /* ignore */ }
    s.players = [];
    for (const o of others) {
      const e = bot.players[o.username] && bot.players[o.username].entity;
      if (e && e.position) { const d = d3(e.position, p); if (d <= 16) s.players.push({ name: o.name, d: Math.round(d * 10) / 10 }); }
    }
    s.atHome = home ? d3(p, home) <= 8 : false;
    const inv = bot.inventory.items();
    s.invTotal = inv.reduce((t, i) => t + i.count, 0); s.invKinds = inv.length;
    s.unfamiliar = false; s.newCell = false;
    return s;
  }

  quit() { try { this.bot.quit(); } catch (_) { /* ignore */ } }
}

// embodied_sim.js の world の約束を Minecraft で満たす
class MinecraftWorld {
  constructor({ personas, site = 0, mcDir, host = 'localhost', port = 25565, tonsPerFish = 2, log = () => {}, witnessRange = 16, hungerPerMonth = 12, monthTicks = 6000, origin = null }) {
    this.console = new ServerConsole({ mcDir, log });
    this.site = site; this.tag = `gs_${site}`; this.k = tonsPerFish; this.log = log; this.witnessRange = witnessRange;
    this.hungerPerMonth = hungerPerMonth; this.monthTicks = monthTicks; this.origin = origin;
    this.userOf = {}; this.nameOf = {};
    for (const p of personas) {
      const u = (site ? `${p.name.slice(0, 12)}_${site}` : p.name).slice(0, 16);
      this.userOf[p.name] = u; this.nameOf[u] = p.name;
    }
    this.bots = Object.fromEntries(personas.map((p) => [p.name, new FisherBot({ name: p.name, username: this.userOf[p.name], host, port, log, group: () => this.nameOf })]));
    this.names = personas.map((p) => p.name);
    this.realtime = true;
  }

  any() { return Object.values(this.bots).find((b) => b.bot && !b.ended); }
  now() { const b = this.any(); return b ? b.age() : null; }
  async waitUntil(tick, { onTick = null, everyMs = 250 } = {}) {
    while (true) {
      const t = this.now();
      if (t != null && t >= tick) return t;
      if (onTick) onTick();
      await sleep(everyMs);
    }
  }

  async setup({ rules = true } = {}) {
    const C = this.console;
    if (rules) await this.worldRules();
    // 1人目を入れて、場所の地面の高さを知る
    for (const b of Object.values(this.bots)) { await b.connect(); await sleep(800); }
    const first = this.bots[this.names[0]];
    const spawn = first.bot.spawnPoint || first.pos();
    const ox = this.origin ? this.origin.x : Math.floor(spawn.x) + 24 + this.site * 200;
    const oz = this.origin ? this.origin.z : Math.floor(spawn.z);
    await C.send(`forceload add ${ox - 12} ${oz - 10} ${ox + 12} ${oz + 36}`, 2000);
    await C.send(`spreadplayers ${ox} ${oz} 0 1 false ${first.username}`, 2500);
    await sleep(1500);
    const y0 = this.origin && this.origin.y != null ? this.origin.y : Math.floor(first.pos().y);
    this.layout = new Layout({ x0: ox, y0, z0: oz, n: this.names.length });
    for (const c of this.layout.buildCommands()) await C.send(c, 400);
    await C.send('scoreboard objectives add govsim dummy', 200);
    await C.send(`kill @e[type=cod,tag=${this.tag}]`, 300);
    await C.send(`kill @e[type=item,x=${ox - 12},y=${y0 - 6},z=${oz - 10},dx=25,dy=20,dz=47]`, 300);
    for (const n of this.names) {
      const u = this.userOf[n]; const h = this.layout.homes[this.names.indexOf(n)];
      for (const c of [`tp ${u} ${h.x} ${h.y} ${h.z}`, `clear ${u}`, `effect clear ${u}`, `gamemode survival ${u}`, `give ${u} iron_sword 1`, `effect give ${u} minecraft:saturation 2 10 true`]) await C.send(c, 150);
    }
    await sleep(2500);
    for (const b of Object.values(this.bots)) await b.holdSword();
    this.log({ type: 'site', site: this.site, tag: this.tag, origin: { x: ox, y: y0, z: oz }, homes: this.layout.homes, meeting: this.layout.meeting, users: this.userOf });
  }

  async setFish(n) {
    const C = this.console; const L = this.layout;
    await C.send(`kill @e[type=cod,tag=${this.tag}]`, 300);
    await this.summonFish(n);
  }

  async summonFish(n, rng = Math.random) {
    const L = this.layout;
    for (let i = 0; i < n; i++) {
      const x = L.x0 - L.pondHalf + rng() * (2 * L.pondHalf + 1); const z = L.z0 - L.pondHalf + rng() * (2 * L.pondHalf + 1);
      await this.console.send(`summon cod ${x.toFixed(2)} ${L.y0 - 1.5} ${z.toFixed(2)} {Tags:["${this.tag}"],PersistenceRequired:1b,DeathLootTable:"minecraft:empty"}`, 40);
    }
  }

  async removeFish(n) { if (n > 0) await this.console.send(`kill @e[type=cod,tag=${this.tag},limit=${n},sort=random]`, 300); }

  // サーバーで数えた本当の匹数
  async countFish() {
    const key = this.tag;
    const m = await this.console.query([`execute store result score ${key} govsim if entity @e[type=cod,tag=${key}]`, `scoreboard players get ${key} govsim`], new RegExp(`${key} has (\\d+) \\[govsim\\]`), 6000);
    if (!m) throw new Error('魚の数が読めなかった (console.log)');
    return Number(m[1]);
  }

  async startMonth(names) {
    // 本物の空腹: 空腹の効果 (hunger II = 1 tick に 0.01 の消耗) を「1か月に hungerPerMonth 点」の長さだけ (消耗 4 = 1 点)
    const ticks = Math.min(this.monthTicks, Math.round((this.hungerPerMonth * 4) / 0.01));
    for (const n of names) await this.console.send(`effect give ${this.userOf[n]} minecraft:hunger ${Math.max(1, Math.round(ticks / 20))} 1 true`, 60);
  }

  async giveCatch(name) { await this.console.send(`give ${this.userOf[name]} cod 1`, 30); }

  bot(name) { return this.bots[name]; }
  home(name) { return this.layout.homes[this.names.indexOf(name)]; }

  // 取ったところを見た人 (距離と見通し。見る人の目から取った人の体まで)
  witnesses(who, names) {
    const ev = { who, pos: this.bots[who].pos() };
    const out = [];
    for (const n of names) {
      if (n === who) continue;
      const b = this.bots[n]; const p = b.pos();
      if (!p || !ev.pos) continue;
      if (d3(p, ev.pos) > this.witnessRange) continue;
      if (!b.canSee(ev.pos.offset(0, 1.0, 0))) continue;
      out.push(n);
    }
    return out;
  }

  sense(name) {
    return this.bots[name].sense({ home: this.home(name), others: this.names.filter((n) => n !== name).map((n) => ({ name: n, username: this.userOf[n] })) });
  }

  // ---- embodied_sim.js が使う、人ごとの動き ----
  deadlineMs(tick) { const t = this.now(); return Date.now() + Math.max(0, (tick - (t ?? tick)) * 50); }
  pause(ms) { return sleep(ms); }
  settleChat() { return sleep(1500); } // 全員にチャットが届くのを待つ
  idx(name) { return this.names.indexOf(name); }
  rimSpot(name) { const r = this.layout.rimCells(); return r[Math.floor((this.idx(name) * r.length) / this.names.length) % r.length]; }
  meetSpot(name) { const a = (2 * Math.PI * this.idx(name)) / this.names.length; const m = this.layout.meeting; return { x: m.x + 2 * Math.cos(a), y: m.y, z: m.z + 2 * Math.sin(a) }; }
  async goToLake(name, deadlineMs) { return this.bots[name].goto(this.rimSpot(name), 0, Math.max(1000, Math.min(30000, deadlineMs - Date.now()))); }
  async goHome(name) { return this.bots[name].goto(this.home(name), 0, 30000); }
  async goMeeting(name) { return this.bots[name].goto(this.meetSpot(name), 1, 30000); }
  lookAtLake(name) { return this.bots[name].visibleFish(this.layout).length; }
  async catchOne(name, claims, deadlineMs) { return this.bots[name].catchOne(this.layout, claims, deadlineMs); }
  async eat(name) { return this.bots[name].eat(); }
  chat(name, text) { return this.bots[name].chat(text); }
  heard(name) { return this.bots[name].heard; }
  position(name) { const p = this.bots[name].pos(); return p ? { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 } : null; }

  // 村長の報告 (--mayor-report on のときだけ)。同じ実行の人にだけ見せる
  async announce(text) {
    for (const n of this.names) await this.console.send(`tellraw ${this.userOf[n]} ${JSON.stringify({ text: `[Mayor] ${text}` })}`, 30);
  }

  // 世界の決まり (この実験のワールドだけ。何回送っても同じ): 敵が出ない・空腹は進む (easy)・昼で止める・晴れ・押しつぶし無し・死んでも持ち物を落とさない
  async worldRules() {
    for (const c of ['difficulty peaceful', 'gamerule doMobSpawning false', 'gamerule doDaylightCycle false', 'time set 6000', 'weather clear', 'gamerule doWeatherCycle false',
      'gamerule maxEntityCramming 0', 'gamerule keepInventory true', 'gamerule doImmediateRespawn true', 'gamerule doInsomnia false', 'gamerule doTraderSpawning false', 'difficulty easy']) await this.console.send(c, 300);
  }

  async teardown() {
    for (const b of Object.values(this.bots)) b.quit();
    await sleep(1000);
    const L = this.layout;
    if (L) await this.console.send(`forceload remove ${L.x0 - 12} ${L.z0 - 10} ${L.x0 + 12} ${L.z0 + 36}`, 300);
  }
}

module.exports = { ServerConsole, FisherBot, MinecraftWorld, Layout, lineOfSight };
