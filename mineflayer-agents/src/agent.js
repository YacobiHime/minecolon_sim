'use strict';
// 1ボット = observe → decide → act → record のループ
const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const { collectRaw, summarizeObservation, notableMatcher } = require('./observe');
const { listActions, resolveDecision } = require('./actions');
const { executeAction } = require('./act');
const { Memory } = require('./memory');
const { Recorder } = require('./recorder');
const { progressText } = require('./progress');
const { sleep, dist3 } = require('./util');

// 観測と記憶から、decider に渡す材料を作る (bot に依存しない)
function buildContext(raw, memory, cfg, extra = {}) {
  const here = raw.self.pos;
  const visibleNotable = new Set(raw.blocks.filter((b) => b.notable).map((b) => b.name));
  const memPlaces = memory.placesForPrompt(here, visibleNotable);
  const blocked = memory.recentFailures(cfg.loop.failWindow ?? 4, cfg.loop.failRepeat ?? 2);
  const actions = listActions(raw, { memPlaces, foods: extra.foods, placeable: extra.placeable, blocked, maxReachUp: cfg.act.maxReachUp,
    goalItems: new Set(Object.keys((cfg.goal.success && cfg.goal.success.inventory) || {})) });
  const prog = cfg.goal.steps ? progressText(cfg.goal.steps, raw) : '';
  return {
    persona: cfg.persona,
    goal: cfg.goal,
    raw,
    actions,
    progress: prog,
    obsText: summarizeObservation(raw, { maxTypes: cfg.perception.maxTypes }),
    memText: memory.toPromptText(here, { places: memPlaces }),
  };
}

// 観測から記憶を更新する (見た目印・行った場所・聞いた話)
function updateMemoryFromObservation(memory, raw) {
  for (const b of raw.blocks) if (b.notable) memory.notePlace(b.name, b.nearest);
  memory.noteVisit(raw.self.pos);
  for (const h of raw.heard) memory.noteHeard(h.from, h.text);
}

function goalMet(goal, inventory) {
  const need = goal && goal.success && goal.success.inventory;
  if (!need) return false;
  return Object.entries(need).every(([name, n]) => inventory.filter((i) => i.name === name).reduce((s, i) => s + i.count, 0) >= n);
}

class Agent {
  constructor(cfg, { decider, log = console.log } = {}) {
    this.cfg = cfg;
    this.decider = decider;
    this.log = log;
    this.memory = Memory.load(cfg.memory.file, { limits: cfg.memory.limits });
    this.recorder = new Recorder(cfg.record.dir, cfg.persona.name);
    this.heardBuf = [];
    this.stopped = false;
    this.lastChat = { t: 0, text: '' };
    this.isNotable = notableMatcher(cfg.perception.notable || undefined);
    this.placeableRes = (cfg.placeable || []).map((p) => new RegExp(p.includes('$') || p.includes('^') ? p : `^${p}$`));
  }

  connect() {
    const s = this.cfg.server;
    this.bot = mineflayer.createBot({ host: s.host, port: s.port, username: this.cfg.persona.name, version: s.version, auth: 'offline' });
    const bot = this.bot;
    bot.loadPlugin(pathfinder);
    bot.on('chat', (username, message) => this.onChat(username, message));
    bot.on('death', () => { this.memory.noteEvent('death', '', false, '死んでしまった'); this.log(`[${bot.username}] died`); });
    bot.on('kicked', (r) => { this.log(`[${bot.username}] kicked: ${JSON.stringify(r)}`); this.stopped = true; });
    bot.on('end', (r) => { this.log(`[${bot.username}] end: ${r}`); this.stopped = true; });
    bot.on('error', (e) => this.log(`[${bot.username}] error: ${e.message}`));
    return new Promise((resolve, reject) => {
      bot.once('spawn', () => {
        const mv = new Movements(bot);
        mv.canDig = true;
        mv.allow1by1towers = false;
        mv.allowParkour = true;
        bot.pathfinder.setMovements(mv);
        bot.pathfinder.thinkTimeout = 5000;
        resolve();
      });
      bot.once('error', reject);
    });
  }

  // 聞こえる範囲 (hearRadius) の中にいる相手の発言だけを拾う。
  // 相手のエンティティが見えていない (遠すぎてサーバーが送ってこない) 場合も届かない扱い。
  onChat(username, message) {
    const bot = this.bot;
    if (!bot || username === bot.username) return;
    const e = bot.players[username] && bot.players[username].entity;
    if (!e || !bot.entity) return;
    const d = dist3(e.position, bot.entity.position);
    if (d > this.cfg.perception.hearRadius) return;
    this.heardBuf.push({ from: username, text: String(message).slice(0, 120), d: Math.round(d) });
    if (this.heardBuf.length > 10) this.heardBuf.shift();
  }

  chat(text) {
    const now = Date.now();
    const t = String(text).replace(/\s+/g, ' ').trim().slice(0, 100);
    if (!t) return false;
    if (t === this.lastChat.text && now - this.lastChat.t < 30000) return false;
    if (now - this.lastChat.t < this.cfg.loop.chatMinIntervalMs) return false;
    this.lastChat = { t: now, text: t };
    this.bot.chat(t);
    this.memory.noteHeard('自分', t);
    return true;
  }

  craftInfo() {
    const now = [];
    const withTable = [];
    for (const name of this.cfg.craftables) {
      const it = this.bot.registry.itemsByName[name];
      if (!it) continue;
      if (this.bot.recipesFor(it.id, null, 1, null).length) now.push(name);
      else if (this.bot.recipesFor(it.id, null, 1, true).length) withTable.push(name);
    }
    return { now, withTable };
  }

  extras() {
    const bot = this.bot;
    const foods = new Set(Object.keys(bot.registry.foodsByName || {}));
    const placeable = new Set(bot.inventory.items().map((i) => i.name)
      .filter((n) => bot.registry.blocksByName[n] && this.placeableRes.some((r) => r.test(n))));
    return { foods, placeable };
  }

  async step(loopNo) {
    const bot = this.bot;
    const cfg = this.cfg;
    this.memory.tick += 1;
    const tObs = Date.now();
    const heard = this.heardBuf.splice(0);
    const raw = collectRaw(bot, { ...cfg.perception, isNotable: this.isNotable, heard, craft: this.craftInfo() });
    updateMemoryFromObservation(this.memory, raw);
    const ctx = buildContext(raw, this.memory, cfg, this.extras());
    const obsMs = Date.now() - tObs;

    const dec = await this.decider.decide(ctx);
    let resolved = dec.parseOk ? resolveDecision(ctx.actions, dec.action, dec.arg) : { ok: false, error: dec.error || 'parse failed' };
    const valid = resolved.ok;
    if (!valid) resolved = { ok: true, action: 'look_around', arg: '', fallback: true, error: resolved.error };

    let said = null;
    if (dec.say && resolved.action !== 'say' && this.chat(dec.say)) said = dec.say;
    const tAct = Date.now();
    const result = await executeAction(bot, resolved, {
      ...cfg.act, visionRadius: cfg.perception.visionRadius, memory: this.memory, chat: (t) => this.chat(t),
    });
    const actMs = Date.now() - tAct;
    if (resolved.action === 'say') said = resolved.arg;
    this.memory.noteEvent(resolved.action, resolved.arg, result.ok, valid ? result.msg : `(選び方が無効: ${resolved.error}) ${result.msg}`);
    const inv = bot.inventory.items().map((i) => ({ name: i.name, count: i.count }));
    const met = goalMet(cfg.goal, inv);

    this.recorder.write({
      loop: loopNo,
      pos: raw.self.pos,
      obs: ctx.obsText,
      memText: ctx.memText,
      actions: ctx.actions.map((a) => (a.choices ? `${a.name}:${a.choices.length}` : a.name)),
      promptChars: dec.promptChars,
      promptTokens: dec.promptTokens ?? null,
      completionTokens: dec.completionTokens ?? null,
      cachedTokens: dec.cachedTokens ?? null,
      rawOutput: dec.rawOutput,
      think: dec.think ?? null,
      parseOk: !!dec.parseOk,
      repaired: !!dec.repaired,
      valid,
      invalidReason: valid ? null : resolved.error,
      argFixed: !!resolved.fixed,
      action: resolved.action,
      arg: resolved.arg,
      say: said,
      result,
      obsMs,
      decideMs: dec.latencyMs,
      actMs,
      talk: dec.talk || null,
      inventory: inv,
      goalMet: met,
    });
    this.memory.save();
    this.log(`[${bot.username}] #${loopNo} ${valid ? '' : '(fallback) '}${resolved.action}(${resolved.arg}) -> ${result.ok ? 'OK' : 'NG'} ${result.msg}${said ? ` / say「${said}」` : ''} [decide ${dec.latencyMs}ms, act ${actMs}ms]`);
    return { met };
  }

  async run() {
    const cfg = this.cfg;
    const end = Date.now() + cfg.loop.minutes * 60000;
    this.recorder.write({ event: 'start', persona: cfg.persona, goal: cfg.goal, decider: this.decider.kind, perception: cfg.perception });
    let loopNo = 0;
    let goalAt = null;
    while (!this.stopped && Date.now() < end) {
      loopNo += 1;
      try {
        const { met } = await this.step(loopNo);
        if (met && !goalAt) {
          goalAt = loopNo;
          this.recorder.write({ event: 'goal', loop: loopNo });
          this.log(`[${this.bot.username}] goal reached at loop ${loopNo}`);
          if (cfg.loop.stopOnGoal) break;
        }
      } catch (e) {
        this.log(`[${this.bot && this.bot.username}] step error: ${e.stack || e.message}`);
        this.recorder.write({ loop: loopNo, error: String(e.message) });
        await sleep(2000);
      }
      await sleep(cfg.loop.pauseMs);
    }
    this.recorder.write({ event: 'end', loops: loopNo, goalAt });
    this.memory.save();
    await this.recorder.close();
    try { this.bot.quit(); } catch (_) { /* ignore */ }
    return { loops: loopNo, goalAt, recordFile: this.recorder.file };
  }

  stop() { this.stopped = true; }
}

module.exports = { Agent, buildContext, updateMemoryFromObservation, goalMet };
