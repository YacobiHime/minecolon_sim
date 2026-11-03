'use strict';
// 1ボット = observe → decide → act → record のループ
//   decide は差し替えられる (llm / split / jev / random / scripted)。
//   jev のときは、行動を Jev が選び、発言は Talker (2B) が作る (Jev の Noul が閾値を超えたときだけ)。
//   社会性 (social.js)・忘れる記憶 (memory.js)・周りに聞く仕組み (ask.js) は、どの decider でも同じに動く。
const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const { collectRaw, summarizeObservation, notableMatcher } = require('./observe');
const { listActions, resolveDecision } = require('./actions');
const { executeAction } = require('./act');
const { Memory } = require('./memory');
const { Recorder } = require('./recorder');
const { progressText, progressRatio, stepStatus } = require('./progress');
const { Social } = require('./social');
const { hutSlots, hutStatus } = require('./hut');
const ask = require('./ask');
const { sleep, dist3, relDir, timePhase } = require('./util');

const BASE_KIND = '拠点';
const DEFAULT_HELP = { hints: true, steps: true, progress: true, askOthers: false, excludeFailures: true };

function helpOf(cfg) { return { ...DEFAULT_HELP, ...(cfg.help || {}) }; }

// 観測と記憶から、decider に渡す材料を作る (bot に依存しない)
function buildContext(raw, memory, cfg, extra = {}) {
  const help = helpOf(cfg);
  const here = raw.self.pos;
  const visibleNotable = new Set(raw.blocks.filter((b) => b.notable).map((b) => b.name));
  const memPlaces = memory.placesForPrompt(here, visibleNotable);
  // ④ 失敗の除外 (段階1)。first_setting では外し、代わりに「聞く」を使う
  const blocked = help.excludeFailures ? memory.recentFailures(cfg.loop.failWindow ?? 4, cfg.loop.failRepeat ?? 2) : new Set();
  const troubles = help.askOthers ? (extra.troubles || ask.troubles(memory, cfg.loop.failWindow ?? 4, cfg.loop.failRepeat ?? 2)) : [];
  const actions = listActions(raw, {
    memPlaces, foods: extra.foods, placeable: extra.placeable, blocked, maxReachUp: cfg.act.maxReachUp,
    goalItems: new Set(Object.keys((cfg.goal.success && cfg.goal.success.inventory) || {})),
    base: extra.base || null, hut: raw.hut || null, troubles, hearRadius: cfg.perception.hearRadius,
  });
  const steps = help.steps ? cfg.goal.steps : null;
  let prog = '';
  if (steps) prog = help.progress ? progressText(steps, raw) : steps.map((s, i) => `(${i + 1})${s.text}`).join(' ');
  const goal = help.hints ? cfg.goal : { ...cfg.goal, hints: [] };
  return {
    persona: cfg.persona,
    goal,
    showHints: help.hints,
    raw,
    actions,
    troubles,
    progress: prog,
    obsText: summarizeObservation(raw, { maxTypes: cfg.perception.maxTypes }),
    memText: memory.toPromptText(here, { places: memPlaces }),
    socialText: extra.socialText || '',
    lastResult: extra.lastResult || '',
  };
}

// 観測から記憶を更新する (見た目印・行った場所・聞いた話)
function updateMemoryFromObservation(memory, raw) {
  for (const b of raw.blocks) if (b.notable) memory.notePlace(b.name, b.nearest);
  memory.noteVisit(raw.self.pos);
  for (const h of raw.heard) memory.noteHeard(h.from, h.text);
}

function goalMet(goal, inventory, raw = null) {
  const s = goal && goal.success;
  if (!s) return false;
  const conds = [];
  if (s.inventory) conds.push(Object.entries(s.inventory).every(([name, n]) => inventory.filter((i) => i.name === name).reduce((t, i) => t + i.count, 0) >= n));
  if (s.hut != null) conds.push(!!(raw && raw.hut && raw.hut.ratio != null && raw.hut.ratio >= s.hut));
  if (s.food != null) conds.push(!!raw && (raw.foodCount || 0) >= s.food);
  return conds.length > 0 && conds.every(Boolean);
}

class Agent {
  constructor(cfg, { decider, log = console.log, meter = null, talker = null, recordDir = null, recordStamp = null } = {}) {
    this.cfg = cfg;
    this.decider = decider;
    this.log = log;
    this.meter = meter;
    this.talker = talker;
    this.help = helpOf(cfg);
    this.memory = Memory.load(cfg.memory.file, { limits: cfg.memory.limits });
    this.social = Social.fromJSON(this.memory.extra.social, { temperament: cfg.persona.temperament });
    this.recorder = new Recorder(recordDir || cfg.record.dir, cfg.persona.name, recordStamp);
    this.heardBuf = [];
    this.stopped = false;
    this.lastChat = { t: 0, text: '' };
    this.isNotable = notableMatcher(cfg.perception.notable || undefined);
    this.placeableRes = (cfg.placeable || []).map((p) => new RegExp(p.includes('$') || p.includes('^') ? p : `^${p}$`));
    this.base = null;
    this.pendingAsk = null; // 自分が聞いて答えを待っているもの
    this.askedAt = {}; // 困りごと (key) → 最後に聞いたループ (同じことを続けて聞かない)
    this.questionQueue = []; // 自分が聞かれたもの
    this.answering = false;
    this.talking = false;
    this.pendingUse = []; // 教わった答えを使ったかを見張るもの
    this.lastResult = '';
    this.goalAt = null;
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
      bot.once('spawn', async () => {
        const mv = new Movements(bot);
        mv.canDig = true;
        mv.allow1by1towers = false;
        mv.allowParkour = true;
        bot.pathfinder.setMovements(mv);
        bot.pathfinder.thinkTimeout = 5000;
        try { await Promise.race([bot.waitForChunksToLoad(), sleep(10000)]); } catch (_) { /* ignore */ }
        this.setupBase();
        resolve();
      });
      bot.once('error', reject);
    });
  }

  // 拠点: 設定 world.base が 'spawn' なら、出現した地点から baseOffset ずらした所 (全員同じ地点に出る前提)。
  // 全員が最初から「拠点の予定地」を知っている (場所の知識に差をつけない)
  setupBase() {
    const w = this.cfg.world || {};
    if (!w.base) return;
    let p = null;
    if (w.base === 'spawn') {
      const sp = this.bot.spawnPoint || this.bot.entity.position;
      const off = w.baseOffset || { x: 0, z: 6 };
      p = { x: Math.floor(sp.x) + (off.x || 0), y: Math.floor(sp.y), z: Math.floor(sp.z) + (off.z || 0) };
    } else p = { x: Math.floor(w.base.x), y: Math.floor(w.base.y), z: Math.floor(w.base.z) };
    // 地面の高さに合わせる (上から下へ、最初の固い地面の上)
    for (let y = p.y + 12; y > p.y - 12; y--) {
      const b = this.bot.blockAt(new Vec3(p.x, y, p.z));
      if (b && b.boundingBox === 'block' && !/leaves|_log$/.test(b.name)) { p.y = y + 1; break; }
    }
    this.base = p;
    this.memory.notePlace(BASE_KIND, p, { keep: true, imp: 1 });
  }

  // 聞こえる範囲 (hearRadius) の中にいる相手の発言だけを拾う。
  onChat(username, message) {
    const bot = this.bot;
    if (!bot || username === bot.username) return;
    const e = bot.players[username] && bot.players[username].entity;
    if (!e || !bot.entity) return;
    const d = dist3(e.position, bot.entity.position);
    if (d > this.cfg.perception.hearRadius) return;
    const text = String(message).slice(0, 120);
    this.heardBuf.push({ from: username, text, d: Math.round(d) });
    if (this.heardBuf.length > 10) this.heardBuf.shift();
    const me = bot.username;
    const q = ask.parseQuestion(text);
    if (q && q.to === me && this.help.askOthers) {
      this.questionQueue.push({ from: username, question: q.question, loop: this.memory.tick, t: Date.now() });
      this.answerQueued().catch((err) => this.log(`[${me}] answer error: ${err.message}`));
    }
    const a = ask.parseAnswer(text);
    if (a && a.to === me && this.pendingAsk && this.pendingAsk.to === username && !this.pendingAsk.reply) {
      this.pendingAsk.reply = { text: a.text, t: Date.now() };
    }
  }

  chat(text, { force = false } = {}) {
    const now = Date.now();
    const t = String(text).replace(/\s+/g, ' ').trim().slice(0, 100);
    if (!t) return false;
    if (!force && t === this.lastChat.text && now - this.lastChat.t < 30000) return false;
    if (!force && now - this.lastChat.t < this.cfg.loop.chatMinIntervalMs) return false;
    this.lastChat = { t: now, text: t };
    this.bot.chat(t);
    this.memory.noteHeard('自分', t);
    this.social.onSpoke(this.memory.tick);
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

  // 小屋の進み具合: 拠点が近く (visionRadius 以内) にあるときだけ分かる
  hutView() {
    if (!this.base) return null;
    const pos = this.bot.entity.position;
    const near = dist3(pos, this.base) <= (this.cfg.perception.visionRadius ?? 16);
    const st = hutStatus(hutSlots(this.base, this.cfg.world.hut || {}), (p) => { const b = this.bot.blockAt(new Vec3(p.x, p.y, p.z)); return b ? b.name : null; });
    this.trueHut = { ratio: st.ratio, filled: st.filled, total: st.total }; // 記録用 (エージェントには見せない)
    return near ? { ratio: st.ratio, filled: st.filled, total: st.total } : null;
  }

  // 聞く: チャットで聞いて、答えを待つ (act.js の ask から呼ばれる)
  async doAsk(ch) {
    const trouble = ch.trouble;
    const to = ch.player;
    const q = ask.questionText(to, trouble);
    const rec = { id: `${this.cfg.persona.name}-${this.memory.tick}`, from: this.cfg.persona.name, to, key: trouble.key, about: trouble.about, question: q, loop: this.memory.tick };
    this.askedAt[trouble.key] = this.memory.tick;
    this.pendingAsk = { to, reply: null };
    this.chat(q, { force: true });
    this.recorder.write({ event: 'ask', ...rec });
    const waitMs = (this.cfg.ask && this.cfg.ask.waitMs) || 45000;
    const t0 = Date.now();
    while (!this.pendingAsk.reply && Date.now() - t0 < waitMs && !this.stopped) await sleep(250);
    const reply = this.pendingAsk.reply;
    this.pendingAsk = null;
    if (!reply) {
      this.social.onIgnored(to);
      this.recorder.write({ event: 'ask_timeout', id: rec.id, from: rec.from, to, waitedMs: Date.now() - t0 });
      return { ok: false, msg: `${to}に聞いたが返事がなかった` };
    }
    const known = !ask.isDontKnow(reply.text);
    this.memory.noteKnowledge(to, trouble.key, reply.text, { imp: known ? 0.8 : 0.3, at: this.phaseNow() });
    this.social.onAnswered(to, known);
    if (known) this.pendingUse.push({ id: rec.id, key: trouble.key, answer: reply.text, from: to, until: this.memory.tick + ((this.cfg.ask && this.cfg.ask.useWindow) || 6) });
    this.recorder.write({ event: 'ask_reply', id: rec.id, from: rec.from, to, answer: reply.text, known, waitedMs: reply.t - t0 });
    return { ok: true, msg: `${to}に聞いた:「${reply.text.slice(0, 50)}」` };
  }

  phaseNow() { return timePhase(this.bot.time ? this.bot.time.timeOfDay : 6000); }

  // 聞かれたことに、自分の記憶の範囲で答える (ループとは別に、聞かれた順に)
  async answerQueued() {
    if (this.answering) return;
    this.answering = true;
    try {
      while (this.questionQueue.length && !this.stopped) {
        const q = this.questionQueue.shift();
        const mems = ask.relevantMemories(this.memory, q.question, { hints: this.help.hints ? (this.cfg.goal.hints || []) : [] });
        let text;
        let twoB = null;
        if (!mems.length) text = 'ごめん、それは分からない';
        else if (this.talker) {
          const r = await this.talker.answer({ persona: this.cfg.persona, from: q.from, question: q.question, memories: mems });
          twoB = { promptChars: r.promptChars, promptTokens: r.promptTokens, ms: r.ms, error: r.error, rawOutput: r.rawOutput };
          text = r.say || 'ごめん、うまく言えない';
        } else text = mems[0].text;
        this.chat(ask.answerText(q.from, text), { force: true });
        this.social.onAsked(q.from, mems.length > 0);
        this.recorder.write({ event: 'answer', from: this.cfg.persona.name, to: q.from, question: q.question, answer: text, known: mems.length > 0 && !ask.isDontKnow(text), memories: mems, twoB, delayMs: Date.now() - q.t });
      }
    } finally {
      this.answering = false;
    }
  }

  // Jev の talk (Noul) が閾値を超えたら、2B に発言を作らせる (待たずに次へ進む)
  maybeTalk(ctx, dec, plannedText) {
    const tcfg = this.cfg.talk || {};
    if (!this.talker || this.talking || !dec.jev || dec.jev.talkP == null) return null;
    const thr = (tcfg.threshold ?? 0.6) + (0.5 - (this.social.temperament.sociability ?? 0.5)) * 0.2;
    if (dec.jev.talkP < thr) return null;
    this.talking = true;
    const players = ctx.raw.entities.filter((e) => e.kind === 'player');
    const tctx = {
      persona: this.cfg.persona, goal: ctx.goal, socialText: ctx.socialText,
      nearText: players.map((e) => `${e.name} ${relDir(ctx.raw.self.pos, e.pos)}`).join(', '),
      heardText: ctx.raw.heard.map((h) => `${h.from}「${h.text}」`).join(' '),
      memText: ctx.memText, plannedAction: plannedText,
    };
    const loop = this.memory.tick;
    this.talker.talk(tctx).then((r) => {
      const said = r.say && this.chat(r.say) ? r.say : null;
      this.recorder.write({ event: 'talk', loop, talkP: dec.jev.talkP, threshold: Number(thr.toFixed(3)), say: said, rawOutput: r.rawOutput, promptChars: r.promptChars, promptTokens: r.promptTokens, ms: r.ms, error: r.error });
      if (said) this.log(`[${this.cfg.persona.name}] say「${said}」 (talk ${dec.jev.talkP.toFixed(2)})`);
    }).catch(() => {}).finally(() => { this.talking = false; });
    return thr;
  }

  async step(loopNo) {
    const bot = this.bot;
    const cfg = this.cfg;
    this.memory.tick += 1;
    const tick = this.memory.tick;
    const tObs = Date.now();
    const heard = this.heardBuf.splice(0);
    const hutKeys = this.base ? new Set(hutSlots(this.base, (cfg.world && cfg.world.hut) || {}).map((s) => `${s.x},${s.y},${s.z}`)) : null;
    const raw = collectRaw(bot, { ...cfg.perception, isNotable: this.isNotable, heard, craft: this.craftInfo(), exclude: hutKeys });
    raw.hut = this.hutView();
    const ex = this.extras();
    raw.foodCount = raw.inventory.filter((i) => ex.foods.has(i.name)).reduce((s, i) => s + i.count, 0);
    updateMemoryFromObservation(this.memory, raw);
    for (const h of raw.heard) this.social.onHeard(h.from, tick);
    const steps = this.help.steps ? cfg.goal.steps : null;
    this.social.tick({ tick, raw, hasFood: raw.foodCount > 0, progress: { ratio: steps ? progressRatio(steps, raw) : null, hutRatio: raw.hut ? raw.hut.ratio : null } });
    const forgotten = this.memory.forget();
    // 困りごと: 同じものを最近聞いたばかりなら、しばらく聞かない
    const cool = (cfg.ask && cfg.ask.cooldown) || 10;
    const troubles = this.help.askOthers ? ask.troubles(this.memory, cfg.loop.failWindow ?? 4, cfg.loop.failRepeat ?? 2).filter((t) => !(tick - (this.askedAt[t.key] ?? -1e9) < cool)) : [];
    const socialText = this.social.words();
    const ctx = buildContext(raw, this.memory, cfg, { ...ex, base: this.base, troubles, socialText, lastResult: this.lastResult });
    const obsMs = Date.now() - tObs;

    const dec = await this.decider.decide(ctx);
    // 2B が行動を決めた (llm / split) ときは、その呼び出しを 2B の使用量に入れる
    if (this.meter && !dec.jev && dec.promptChars) {
      this.meter.addTwoB({ kind: 'act', promptChars: dec.promptChars, promptTokens: dec.promptTokens, completionTokens: dec.completionTokens, ms: dec.latencyMs, error: dec.parseOk ? null : dec.error });
      if (dec.talk) this.meter.addTwoB({ kind: 'talk', promptChars: dec.talk.promptChars, ms: dec.talk.latencyMs });
    }
    let resolved = dec.parseOk ? resolveDecision(ctx.actions, dec.action, dec.arg) : { ok: false, error: dec.error || 'parse failed' };
    const valid = resolved.ok;
    if (!valid) resolved = { ok: true, action: 'look_around', arg: '', fallback: true, error: resolved.error };

    // Jev の Score を記憶の大事さと好感に (直前の出来事 = 前のループの結果と、今聞こえた話)
    if (dec.jev) {
      if (Number.isFinite(dec.jev.remember)) this.memory.setRecentImportance(dec.jev.remember / 4, tick - 1);
      for (const [name, sc] of Object.entries(dec.jev.relations || {})) this.social.onRelationScore(name, sc);
    }
    const plannedText = `${resolved.action}${resolved.arg ? '(' + resolved.arg + ')' : ''}`;
    const talkThr = this.maybeTalk(ctx, dec, plannedText);

    let said = null;
    if (dec.say && resolved.action !== 'say' && this.chat(dec.say)) said = dec.say;
    const tAct = Date.now();
    const result = await executeAction(bot, resolved, {
      ...cfg.act, visionRadius: cfg.perception.visionRadius, memory: this.memory, chat: (t) => this.chat(t),
      base: this.base, hutShape: (cfg.world && cfg.world.hut) || {}, ask: (ch) => this.doAsk(ch),
    });
    const actMs = Date.now() - tAct;
    if (resolved.action === 'say') said = resolved.arg;
    const key = `${resolved.action}:${resolved.arg}`;
    this.memory.noteEvent(resolved.action, resolved.arg, result.ok, valid ? result.msg : `(選び方が無効: ${resolved.error}) ${result.msg}`);
    this.social.onActionResult(resolved.action, result.ok, { repeatedFail: !result.ok && troubles.some((t) => t.key === key) });
    this.lastResult = `${plannedText}→${result.ok ? '成功' : '失敗'}: ${result.msg}`;

    // 教わった答えを使ったか
    const uses = [];
    for (const p of [...this.pendingUse]) {
      const how = ask.answerUse(p, resolved, result);
      if (how || tick >= p.until) {
        this.pendingUse.splice(this.pendingUse.indexOf(p), 1);
        const u = { event: 'answer_use', id: p.id, from: p.from, key: p.key, used: !!how, how: how || null, loop: loopNo, action: resolved.action, arg: resolved.arg };
        this.recorder.write(u);
        uses.push(u);
      }
    }

    const inv = bot.inventory.items().map((i) => ({ name: i.name, count: i.count }));
    const met = goalMet(cfg.goal, inv, raw);
    const stepSt = steps ? stepStatus(steps, raw).map((s) => s.done) : null;
    this.memory.extra.social = this.social.toJSON();

    this.recorder.write({
      loop: loopNo,
      pos: raw.self.pos,
      timeOfDay: bot.time ? bot.time.timeOfDay : null,
      day: bot.time ? bot.time.day : null,
      obs: ctx.obsText,
      memText: ctx.memText,
      memSelection: this.memory.lastSelection || null,
      forgotten,
      social: { words: socialText, emotions: this.social.emotions, needs: this.social.needs },
      troubles: troubles.map((t) => t.key),
      actions: ctx.actions.map((a) => (a.choices ? `${a.name}:${a.choices.length}` : a.name)),
      progress: ctx.progress || null,
      steps: stepSt,
      promptChars: dec.promptChars,
      promptTokens: dec.promptTokens ?? null,
      completionTokens: dec.completionTokens ?? null,
      cachedTokens: dec.cachedTokens ?? null,
      rawOutput: dec.rawOutput,
      think: dec.think ?? null,
      jev: dec.jev || null,
      talkThreshold: talkThr,
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
      foodCount: raw.foodCount,
      hutSeen: raw.hut,
      hutTrue: this.trueHut || null,
      goalMet: met,
    });
    this.memory.save();
    this.log(`[${bot.username}] #${loopNo} ${valid ? '' : '(fallback) '}${resolved.action}(${resolved.arg}) -> ${result.ok ? 'OK' : 'NG'} ${result.msg}${said ? ` / say「${said}」` : ''} [decide ${dec.latencyMs}ms, act ${actMs}ms]`);
    return { met };
  }

  startRecord(extra = {}) {
    const cfg = this.cfg;
    const t = this.bot && this.bot.time;
    this.recorder.write({
      event: 'start', persona: cfg.persona, goal: cfg.goal, decider: this.decider.kind, talker: this.talker ? this.talker.kind : null,
      help: this.help, perception: cfg.perception, memoryLimits: this.memory.limits, base: this.base, world: cfg.world || null,
      talk: cfg.talk || null, askCfg: cfg.ask || null, timeOfDay: t ? t.timeOfDay : null, day: t ? t.day : null, ...extra,
    });
  }

  async run(extra = {}) {
    const cfg = this.cfg;
    const end = Date.now() + cfg.loop.minutes * 60000;
    this.startRecord(extra);
    let loopNo = 0;
    while (!this.stopped && Date.now() < end) {
      loopNo += 1;
      try {
        const { met } = await this.step(loopNo);
        if (met && !this.goalAt) {
          this.goalAt = loopNo;
          const t = this.bot.time;
          this.recorder.write({ event: 'goal', loop: loopNo, timeOfDay: t ? t.timeOfDay : null, day: t ? t.day : null });
          this.log(`[${this.bot.username}] goal reached at loop ${loopNo}`);
          if (cfg.loop.stopOnGoal) break;
        }
      } catch (e) {
        this.log(`[${this.bot && this.bot.username}] step error: ${e.stack || e.message}`);
        this.recorder.write({ loop: loopNo, error: String(e.message) });
        await sleep(2000);
      }
      if (this.meter && this.meter.exceeded) { this.stopped = true; this.recorder.write({ event: 'token_cap', loop: loopNo, usage: this.meter.summary() }); }
      await sleep(cfg.loop.pauseMs);
    }
    // 発言・答えの途中なら少し待つ (記録を閉じる前に)
    for (let i = 0; i < 60 && (this.talking || this.answering); i++) await sleep(250);
    this.recorder.write({ event: 'end', loops: loopNo, goalAt: this.goalAt, memoryForgotten: this.memory.forgotten, social: this.social.toJSON() });
    this.memory.extra.social = this.social.toJSON();
    this.memory.save();
    await this.recorder.close();
    try { this.bot.quit(); } catch (_) { /* ignore */ }
    return { name: cfg.persona.name, loops: loopNo, goalAt: this.goalAt, recordFile: this.recorder.file };
  }

  stop() { this.stopped = true; }
}

module.exports = { Agent, buildContext, updateMemoryFromObservation, goalMet, DEFAULT_HELP };
