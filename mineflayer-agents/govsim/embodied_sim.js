'use strict';
// GovSim の Minecraft の中の版 (embodied) の1回の実行。文字の版 (sim.js) と同じ人・同じプロンプト・同じ記憶・同じ指標で、
// 違いは「体があること」だけにした (違いの一覧は PR の本文と govsim/embodied.js の先頭):
//   - 池の魚の量はサーバーの本当の数 (1匹 = k トン)。回復 min(capacity, 2S) は summon、崩壊は取ったあと 5 トン未満
//   - 漁: 月の漁の時間のうち、人ごとに種で決めた時刻に家を出て池に行き、池を見て数えてから取りたい量を決め (LLM)、自分で1匹ずつ取る。
//     割り当ては先に取った人のもの (物理)。欲しい量 (LLM の答え) と取れた量を両方残す
//   - 知ること: 池の量は自分が池で数えた数だけ。他人の漁は、取るところを見た (16 ブロック以内・見通しあり) 分か、チャットで聞いた分だけ。
//     村長の報告は無い (--mayor-report on で文字の版と同じ報告を足せる)
//   - 話し合い: ゲームの全体チャット。発言のプロンプトに入る話し合いは、その人が受け取ったチャット
//   - 心のモデル (mental on): 本物の満腹度・明るさ・近くの人で Social.tick、見て分かった取り決めの破り/守りで わだかまり・好感・信頼
// world は embodied_world.js の MinecraftWorld か、テスト用の embodied_fake.js の FakeWorld (同じ約束)
const { CommonsLedger, MonthClock, Knowledge, targetFish } = require('./commons');
const { computeMetrics } = require('./metrics');
const { GovMemory } = require('./memory');
const P = require('./prompts');
const { parseHarvest, parseLimit, parseUtterance, firstSentence, parseInsights } = require('./parse');
const { pickPersonas } = require('./mental');
const { EmbodiedMental } = require('./mental_embodied');
const { Rng } = require('./rng');
const { sustainableShare } = require('./env');
const { makeAsk, Stats, mentalStats, citedTerms, GOVSIM_NAMES, monthStart, reflectionDay, discussionDay } = require('./sim');

const EMBODIED_VARIANTS = ['default', 'no-language'];

// 人を選ぶ (文字の版の runSim と同じ選び方なので、同じ種なら同じ人)
function choosePersonas({ seed = 1, agents = 5, mentalConfig = null, names = 'persona', personas = null }) {
  let ps;
  if (personas) ps = personas.slice(0, agents);
  else if (mentalConfig) ps = pickPersonas(mentalConfig.personas, agents, new Rng(seed * 7919 + 17));
  else ps = Array.from({ length: agents }, (_, i) => ({ name: GOVSIM_NAMES[i] || `Fisher${i + 1}` }));
  if (names === 'govsim') ps = ps.map((p, i) => ({ ...p, name: GOVSIM_NAMES[i] || `Fisher${i + 1}` }));
  return ps;
}

// 1発言をチャットの行に分ける。サーバーは1行 256 字までで、前後の空白を詰めるので、語の切れ目で max 字以下に分け、
// 続きのある行の終わりに CONT (" ~") を付ける。受け取る側 (groupChat) は CONT で終わる行と、同じ人の次の行をつなぐ
const CONT = ' ~';
function chatChunks(text, max = 240) {
  const t = String(text || '').replace(/\s+/g, ' ').replace(/^\/+/, '').trim();
  if (!t) return [];
  const out = [];
  let rest = t;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(' ', max - CONT.length);
    if (cut < max / 2) cut = max - CONT.length;
    out.push(rest.slice(0, cut).trim() + CONT);
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

// 受け取ったチャット → 話し合いの形 [[話し手, 発言]]。同じ人の行で、前の行が CONT で終わっていればつなぐ
function groupChat(msgs) {
  const out = [];
  let open = false;
  for (const m of msgs) {
    const last = out[out.length - 1];
    const text = String(m.text).trim();
    const cont = text.endsWith(CONT.trim());
    const body = cont ? text.slice(0, -CONT.trim().length).trim() : text;
    if (last && open && last[0] === m.from) last[1] += ` ${body}`;
    else out.push([m.from, body]);
    open = cont;
  }
  return out;
}

async function runEmbodied(o) {
  const variant = o.variant || 'default';
  if (!EMBODIED_VARIANTS.includes(variant)) throw new Error(`embodied の variant は ${EMBODIED_VARIANTS.join('|')}`);
  const language = variant !== 'no-language';
  const world = o.world;
  const log = o.log || (() => {});
  const stats = new Stats();
  const ask = makeAsk({ llm: o.llm, log, stats });
  const N = o.agents || 5;
  const months = o.months || 12;
  const k = o.tonsPerFish || 2;
  const seed = o.seed ?? 1;
  const mentalOn = !!o.mental;
  const mayorReport = !!o.mayorReport;
  const maxConv = o.maxConversation ?? 10;
  const ledger = new CommonsLedger({ agents: N, tonsPerFish: k, maxMonths: months, seed });
  const envCfg = ledger.cfg;
  const f0 = sustainableShare(envCfg.capacity, N);
  const personas = o.personas || choosePersonas({ seed, agents: N, mentalConfig: o.mentalConfig, names: o.names });
  const names = personas.map((p) => p.name);

  const agents = personas.map((p) => {
    const others = names.filter((n) => n !== p.name);
    const sys = P.systemPrompt({ name: p.name, others, capacity: envCfg.capacity, nAgents: N, language, personality: mentalOn ? (p.personality_en || '') : '', embodied: { tonsPerFish: k, mayorReport } });
    const a = { name: p.name, persona: p, sys, memory: new GovMemory({ expirationDays: o.expirationDays ?? 63 }), mental: null, know: new Knowledge(p.name) };
    if (mentalOn) { a.mental = new EmbodiedMental({ persona: p, cfg: o.mentalConfig, others: [], subsistence: f0, higherNeeds: !!o.higherNeeds }); a.mental.setOthers(names); }
    return a;
  });
  const byName = Object.fromEntries(agents.map((a) => [a.name, a]));

  // 心のモデルを本物の材料で進める (2 秒ごと。偽物の world では区切りごと)
  let lastMentalTick = 0;
  const tickMentals = (force = false) => {
    if (!mentalOn) return;
    if (!force && Date.now() - lastMentalTick < (o.mentalTickMs ?? 2000)) return;
    lastMentalTick = Date.now();
    for (const a of agents) { const s = world.sense(a.name); if (s && Number.isFinite(s.time)) a.mental.tickReal(s); }
  };
  const timer = mentalOn && world.realtime ? setInterval(() => { try { tickMentals(); } catch (_) { /* ignore */ } }, o.mentalTickMs ?? 2000) : null;
  const waitUntil = async (tick) => { await world.waitUntil(tick, { onTick: () => tickMentals() }); tickMentals(true); };

  const monthTicks = o.monthTicks ?? 6000;
  const startAt = world.now() + (o.startDelayTicks ?? 200);
  const clock = new MonthClock({ t0: startAt, monthTicks, harvest: o.harvestFrac ?? 0.5, discussion: o.discussionFrac ?? 0.3 });
  const staggerFrac = o.staggerFrac ?? 0.4;
  const rngS = new Rng(seed * 31 + 7);
  log({ type: 'start', mode: 'embodied', variant, agents: names, personas: mentalOn ? personas.map((p) => ({ name: p.name, age: p.age, sex: p.sex, temperament: p.temperament, personality_en: p.personality_en })) : undefined,
    env: envCfg, tonsPerFish: k, mental: mentalOn, language, mayorReport, f0, clock: { t0: startAt, monthTicks, harvest: clock.harvest, discussion: clock.discussion }, staggerFrac });

  await world.setFish(ledger.capFish);
  let agreement = null;
  const agreements = [];
  const monthRows = [];
  try {
    while (!ledger.done) {
      const m = ledger.month;
      const tStart = monthStart(m); const tDisc = discussionDay(m); const tRef = reflectionDay(m);
      const hStart = clock.phaseStart(m, 'harvest'); const hEnd = clock.phaseEnd(m, 'harvest');
      await waitUntil(hStart);
      const fishStart = await world.countFish();
      const rec = ledger.startMonth(names, fishStart);
      await world.startMonth(names);
      log({ type: 'month_start', month: m, tick: world.now(), fishStart, poolBefore: rec.poolBefore, threshold: rec.threshold });
      // ---- 漁 ----
      const delays = Object.fromEntries(agents.map((a) => [a.name, Math.floor(rngS.next() * staggerFrac * (hEnd - hStart))]));
      const claims = new Set();
      const info = { arrive: {}, arriveTrue: {}, leave: {}, late: [], misses: {}, ate: {}, delays };
      const harvestRes = await Promise.all(agents.map(async (a) => {
        await world.waitUntil(hStart + delays[a.name]);
        if (world.now() >= hEnd) { info.late.push(a.name); return { a, decided: false, ok: true, mental: '' }; }
        await world.goToLake(a.name, world.deadlineMs(hEnd));
        const seen = world.lookAtLake(a.name);
        info.arrive[a.name] = seen;
        if (o.trueAtLook !== false) info.arriveTrue[a.name] = await world.countFish();
        a.know.look(m, 'arrive', seen);
        a.memory.addEvent(P.sawLake(a.name, seen, k), tStart, tRef, true);
        for (const [other, n] of Object.entries(a.know.seen(m))) a.memory.addEvent(P.sawCatches(a.name, other, n, k), tStart, tRef, true);
        tickMentals(true);
        const mental = a.mental ? a.mental.words() : '';
        const snap = a.mental ? a.mental.snapshot() : undefined;
        let wanted = 0; let r = { ok: true, text: '' };
        if (seen > 0) {
          const prompt = P.harvestPrompt({ sys: a.sys, date: tStart, name: a.name, memories: a.memory.retrieve(tStart, 10), interval: [0, seen * k], mental });
          r = await ask({ agent: a.name, role: 'act', kind: 'harvest', month: m, prompt, parse: parseHarvest, maxTokens: o.maxTokensHarvest ?? 2500, extra: { seenFish: seen, ...(mental ? { mental, mentalState: snap } : {}) } });
          wanted = r.ok ? r.value : 0;
        }
        ledger.recordWanted(a.name, wanted);
        const target = targetFish(wanted, k);
        let got = 0; let misses = 0;
        while (got < target && world.now() < hEnd && misses < (o.maxMisses ?? 12)) {
          const c = await world.catchOne(a.name, claims, world.deadlineMs(hEnd));
          if (!c.ok) {
            misses += 1;
            if (c.reason === 'no_fish_visible' && world.lookAtLake(a.name) === 0) break;
            await world.pause(300);
            continue;
          }
          const w = world.witnesses(a.name, names);
          ledger.recordCatch(a.name, { fishId: c.fishId, t: world.now(), witnesses: w });
          for (const x of w) byName[x].know.sawCatch(m, a.name);
          log({ type: 'catch', month: m, who: a.name, fishId: c.fishId, tick: world.now(), witnesses: w, pos: world.position(a.name) });
          got += 1;
          await world.giveCatch(a.name);
        }
        info.misses[a.name] = misses;
        const seenAfter = world.lookAtLake(a.name);
        info.leave[a.name] = seenAfter;
        a.know.look(m, 'leave', seenAfter);
        a.memory.addEvent(P.sawLake(a.name, seenAfter, k, true), new Date(tStart.getTime() + 3600000), tRef, true);
        info.ate[a.name] = await world.eat(a.name);
        if (a.mental) a.mental.onAte(info.ate[a.name]);
        await world.goHome(a.name);
        return { a, decided: true, wanted, target, got, ok: r.ok, mental, reasoning: r.text, cited: citedTerms(mental, r.text) };
      }));
      const fishAfter = await world.countFish();
      ledger.endHarvest(fishAfter);
      const witnessEvents = rec.catches.reduce((s, c) => s + c.witnesses.length, 0);
      log({ type: 'harvest', month: m, poolBefore: rec.poolBefore, threshold: rec.threshold, wanted: rec.wanted, caught: rec.caught, poolAfter: rec.poolAfter, collapsed: rec.collapsed,
        attributedMismatch: rec.attributedMismatch, failed: harvestRes.filter((x) => !x.ok).map((x) => x.a.name), info, witnessEvents,
        seen: Object.fromEntries(agents.map((a) => [a.name, a.know.seen(m)])), cited: Object.fromEntries(harvestRes.filter((x) => x.cited && x.cited.length).map((x) => [x.a.name, x.cited])) });
      const mentalEvents = {};
      for (const a of agents) {
        const tSaw = new Date(tDisc.getTime() - 60000);
        a.memory.addEvent(P.tonsCaught(a.name, rec.wanted[a.name], rec.caught[a.name]), tSaw, tRef, true);
        for (const [other, n] of Object.entries(a.know.seen(m))) a.memory.addEvent(P.sawCatches(a.name, other, n, k), tSaw, tRef, true);
        if (a.mental) {
          const h = a.mental.onHarvestReal({ wanted: rec.wanted[a.name], caught: rec.caught[a.name] });
          let judged;
          if (mayorReport) judged = agreement == null ? [] : names.filter((n) => n !== a.name).map((n) => ({ who: n, kind: rec.caught[n] > agreement ? 'breach' : 'kept', seenTons: rec.caught[n], limit: agreement }));
          else judged = a.know.judge(m, agreement, k, (who) => rec.caught[who] / k);
          mentalEvents[a.name] = { harvest: h, judged: a.mental.onJudged(judged) };
        }
      }
      // ---- 話し合い (全体チャット) ----
      let conversation = []; let summary = null; let limit = null; let cut = false; let meetingStartMs = null;
      if (language) {
        await waitUntil(clock.phaseStart(m, 'discussion'));
        await Promise.all(agents.map((a) => world.goMeeting(a.name)));
        for (const a of agents) if (a.mental) a.mental.onMeeting();
        meetingStartMs = Date.now();
        const dEnd = clock.phaseEnd(m, 'discussion');
        const opening = [];
        if (mayorReport) {
          const txt = P.mayorReport(agents.map((a) => [a.name, rec.caught[a.name]]));
          opening.push(['Mayor', txt]);
          conversation.push(['Mayor', txt]);
          await world.announce(txt);
        }
        const heardBy = (a) => [...opening, ...groupChat(world.heard(a.name).filter((h) => h.t >= meetingStartMs))];
        let speaker = agents[0];
        let ended = false;
        while (world.now() < dEnd) {
          const mental = speaker.mental ? speaker.mental.words() : '';
          const prompt = P.utterancePrompt({ sys: speaker.sys, date: tDisc, name: speaker.name, memories: speaker.memory.retrieve(tDisc, 5), participants: names, conversation: heardBy(speaker), mental });
          const r = await ask({ agent: speaker.name, role: 'talk', kind: 'utterance', month: m, prompt, parse: (t) => parseUtterance(t, names), maxTokens: o.maxTokensUtterance ?? 800, extra: mental ? { mental } : {} });
          const sent = world.chat(speaker.name, r.utterance || '');
          conversation.push([speaker.name, sent]);
          await world.settleChat();
          if (speaker.mental) speaker.mental.onSpokeChat();
          for (const a of agents) if (a.mental && a !== speaker && sent) a.mental.onHeardChat(speaker.name, sent);
          const end = r.ok ? r.end : (r.end !== false);
          if (end || conversation.length >= maxConv) { ended = true; break; }
          speaker = byName[r.next] || agents[0];
        }
        cut = !ended;
        const s = await ask({ agent: 'framework', role: 'framework', kind: 'summary', month: m, prompt: P.summaryPrompt(conversation), parse: (t) => ({ ok: true, value: firstSentence(t) }), maxTokens: 200 });
        summary = s.ok ? s.value : '';
        const l = await ask({ agent: 'framework', role: 'framework', kind: 'limit', month: m, prompt: P.limitPrompt(conversation), parse: parseLimit, maxTokens: o.maxTokensLimit ?? 1500 });
        limit = l.ok ? l.value : null;
        if (limit != null) { agreement = limit; agreements.push({ month: m, limit }); }
        const received = Object.fromEntries(agents.map((a) => [a.name, heardBy(a).length]));
        log({ type: 'conversation', month: m, conversation, summary, limit, cut, received });
        await Promise.all(agents.map(async (a) => {
          const conv = heardBy(a);
          a.memory.addChat(summary, tDisc);
          const mental = a.mental ? a.mental.words() : '';
          const pl = await ask({ agent: a.name, role: 'reflect', kind: 'planning', month: m, prompt: P.planningPrompt(a.sys, conv, mental, a.name), parse: (t) => ({ ok: !!firstSentence(t), value: firstSentence(t) }), maxTokens: 200 });
          if (pl.ok) a.memory.addThought(pl.value, tDisc);
          const me = await ask({ agent: a.name, role: 'reflect', kind: 'memorize', month: m, prompt: P.memorizePrompt(a.sys, conv, mental, a.name), parse: (t) => ({ ok: !!firstSentence(t), value: firstSentence(t) }), maxTokens: 200 });
          if (me.ok) a.memory.addThought(me.value, tDisc);
          if (limit != null) a.memory.addThought(P.agreedLimit(limit), tDisc, { always: true });
        }));
      }
      // ---- 振り返り (家) ----
      await waitUntil(clock.phaseStart(m, 'reflection'));
      await Promise.all(agents.map(async (a) => {
        await world.goHome(a.name);
        const n = await world.eat(a.name);
        info.ate[a.name] = (info.ate[a.name] || 0) + n;
        if (a.mental) a.mental.onAte(n);
      }));
      tickMentals(true);
      await Promise.all(agents.map(async (a) => {
        const mems = a.memory.retrieve(tRef, 10);
        if (!mems.length) return;
        const mental = a.mental ? a.mental.words() : '';
        const r = await ask({ agent: a.name, role: 'reflect', kind: 'insight', month: m, prompt: P.insightPrompt(a.sys, a.name, mems, mental), parse: (t) => { const v = parseInsights(t); return { ok: v.length > 0, value: v }; }, maxTokens: 500 });
        if (r.ok) for (const x of r.value) a.memory.addThought(x, tRef);
      }));
      for (const a of agents) if (a.mental) { a.mental.sleepNow(); mentalEvents[a.name].state = a.mental.snapshot(); }
      if (mentalOn) log({ type: 'mental', month: m, events: mentalEvents });
      // ---- 月の終わり: 回復 ----
      const mEnd = clock.monthStart(m + 1);
      const overrun = Math.max(0, world.now() - mEnd);
      await waitUntil(mEnd);
      const fishEnd = await world.countFish();
      const g = ledger.endMonth(fishEnd);
      if (!g.done) { await world.summonFish(g.summon); await world.removeFish(g.remove); }
      log({ type: 'month_end', month: m, fishEnd, targetFish: g.targetFish, summon: g.summon, remove: g.remove, overrunTicks: overrun, done: g.done, collapsed: g.collapsed });
      monthRows.push({ month: m, poolBefore: rec.poolBefore, threshold: rec.threshold, wanted: rec.wanted, caught: rec.caught, poolAfter: rec.poolAfter, limit,
        conversationLen: conversation.length, mentalWords: mentalOn ? Object.fromEntries(harvestRes.map((x) => [x.a.name, x.mental])) : undefined,
        cited: mentalOn ? Object.fromEntries(harvestRes.map((x) => [x.a.name, x.cited || []])) : undefined,
        embodied: { fishStart, fishAfter, fishEnd, arrive: info.arrive, arriveTrue: info.arriveTrue, leave: info.leave, late: info.late, decided: rec.decided,
          catches: rec.catches.length, witnessEvents, possibleWitness: rec.catches.length * (N - 1), seen: Object.fromEntries(agents.map((a) => [a.name, a.know.seen(m)])),
          attributedMismatch: rec.attributedMismatch, discussionCut: cut, overrunTicks: overrun, ate: info.ate } });
    }
  } finally {
    if (timer) clearInterval(timer);
  }

  const metrics = computeMetrics(ledger.metricsHistory(), { maxMonths: months, capacity: envCfg.capacity, agents: names, collapseBelow: envCfg.collapseBelow, initialAgents: N });
  const summary = {
    mode: 'embodied', variant, mental: mentalOn, seed, agents: names, months, allocation: 'physical', env: envCfg, metrics,
    monthsRun: ledger.history.length, agreements, months_detail: monthRows,
    parseFailures: stats.parseFail, reasked: stats.reasked, truncated: stats.truncated, llmCalls: stats.llmCalls, llmErrors: stats.llmErrors, callsByRole: stats.byRole,
    failurePolicy: '文字の版 (sim.js) と同じ: 聞き直し1回、だめなら 収穫 0 トン・話し合いを終える・次の話し手は最初の人・取り決めなし',
    embodied: { tonsPerFish: k, monthTicks, mayorReport, staggerFrac, information: infoStats(monthRows, N) },
  };
  if (mentalOn) summary.mentalContribution = mentalStats(monthRows);
  log({ type: 'end', summary });
  return summary;
}

// 体があることで知ること がどれだけ変わったか: 池を見た割合・見た数と本当の数の差・他人の漁を見た割合・欲しい量と取れた量の差
function infoStats(rows, N) {
  let agentMonths = 0; let looked = 0; let absErr = 0; let nErr = 0; let catches = 0; let wit = 0; let possible = 0; let wantedT = 0; let caughtT = 0; let short = 0; let over = 0; let late = 0; let mismatch = 0;
  for (const r of rows) {
    const e = r.embodied || {};
    for (const n of Object.keys(r.wanted)) {
      agentMonths += 1;
      if (e.arrive && e.arrive[n] != null) looked += 1;
      if (e.arrive && e.arriveTrue && e.arrive[n] != null && e.arriveTrue[n] != null) { absErr += Math.abs(e.arrive[n] - e.arriveTrue[n]); nErr += 1; }
      wantedT += r.wanted[n]; caughtT += r.caught[n];
      if (r.caught[n] < r.wanted[n]) short += 1;
      if (r.caught[n] > r.wanted[n]) over += 1;
    }
    catches += e.catches || 0; wit += e.witnessEvents || 0; possible += e.possibleWitness || 0; late += (e.late || []).length; mismatch += Math.abs(e.attributedMismatch || 0);
  }
  return {
    agentMonths, lookedShare: agentMonths ? looked / agentMonths : null, meanAbsCountError: nErr ? absErr / nErr : null,
    catches, witnessEvents: wit, witnessedShare: possible ? wit / possible : null, wantedTotal: wantedT, caughtTotal: caughtT,
    caughtLessThanWanted: short, caughtMoreThanWanted: over, lateAgentMonths: late, unattributedFish: mismatch, agentsPerCatch: N - 1,
  };
}

module.exports = { runEmbodied, choosePersonas, groupChat, chatChunks, infoStats, EMBODIED_VARIANTS };
