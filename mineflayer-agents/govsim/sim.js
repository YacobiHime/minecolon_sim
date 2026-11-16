'use strict';
// GovSim の漁場の1回の実行 (月の流れ・話し合い・取り決め・振り返り・変種)。LLM は引数の関数で受け取る (テストでは偽物を渡す)。
// 流れは GovSim (MIT) の persona_v3 と concurrent_env / perturbation_env に合わせた。使い方は govsim/run.js、心のモデルの写し方は govsim/mental.js の先頭
const { FisheryEnv, scaleConfig, sustainableShare } = require('./env');
const { computeMetrics } = require('./metrics');
const { GovMemory, DAY } = require('./memory');
const P = require('./prompts');
const { parseHarvest, parseLimit, parseUtterance, firstSentence, parseInsights } = require('./parse');
const { Mental, pickPersonas } = require('./mental');
const { Rng } = require('./rng');

const VARIANTS = ['default', 'universalization', 'no-language', 'outsider'];
const GOVSIM_NAMES = ['John', 'Kate', 'Jack', 'Emma', 'Luke'];

// 日付 (元と同じ: 2024-01-01 01:00 に始まり、話し合いは月末の前日、振り返りは月末、次の月の1日に漁)
const monthStart = (m) => new Date(Date.UTC(2024, m, 1, 1, 0, 0));
const reflectionDay = (m) => new Date(Date.UTC(2024, m + 1, 0, 1, 0, 0));
const discussionDay = (m) => new Date(reflectionDay(m).getTime() - DAY);

// 読めなかったときに聞き直す文 (元には無い。1回だけ)
const REASK = {
  harvest: '\n\nYour previous reply did not end with the final answer in the required format. Reply again and finish with "Answer: N tons".',
  limit: '\n\nYour previous reply did not contain the final answer in the required format. Reply again and finish with "Answer: N" or "Answer: N/A".',
  utterance: '\n\nYour previous reply did not follow the output format. Reply again using exactly the three lines: "Response: ...", "Conversation conclusion by me: yes/no", "Next speaker: <name>".',
};

// 収穫の考えの中に、心の言葉のどれが出てきたか (mental on の寄与の目安)
const MENTAL_TERMS = ['glad', 'irritated', 'angry', 'anxious', 'scared', 'fed up', 'surprised', 'hungry', 'starving', 'eaten',
  'sleepy', 'uneasy', 'tense', 'worn down', 'breaking point', 'lonely', 'appreciat', 'want more things', 'so few things', 'helping', 'help someone',
  'forgiven', 'broke an agreement', 'bad terms', 'good terms', 'close friends', 'uncomfortable', 'grudge', 'trust'];
function citedTerms(mental, text) {
  if (!mental || !text) return [];
  const a = mental.toLowerCase(); const b = text.toLowerCase();
  return MENTAL_TERMS.filter((t) => a.includes(t) && b.includes(t));
}

class Stats {
  constructor() { this.parseFail = {}; this.reasked = {}; this.truncated = {}; this.llmErrors = 0; this.llmCalls = 0; this.byRole = {}; }
  fail(kind) { this.parseFail[kind] = (this.parseFail[kind] || 0) + 1; }
  reask(kind) { this.reasked[kind] = (this.reasked[kind] || 0) + 1; }
}

// LLM に聞く関数を作る。parse が ok でなければ REASK を足して1回だけ聞き直す。2回ともだめなら ok: false (embodied.js も使う)
function makeAsk({ llm, log, stats }) {
  return async function ask({ agent, role, kind, month, prompt, parse, maxTokens, extra = {} }) {
    let last = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const p = attempt === 0 ? prompt : prompt + (REASK[kind] || '');
      if (attempt > 0) stats.reask(kind);
      let r = null; let err = null;
      stats.llmCalls += 1; stats.byRole[role] = (stats.byRole[role] || 0) + 1;
      try { r = await llm({ role, prompt: p, maxTokens, agent, kind }); } catch (e) { err = String(e && e.message ? e.message : e).slice(0, 300); stats.llmErrors += 1; }
      const parsed = r ? parse(r.text) : { ok: false, error: 'llm_error' };
      log({ type: 'llm', month, agent, role, kind, attempt, prompt: p, text: r ? r.text : null, finishReason: r ? r.finishReason : null, error: err, parsed: { ...parsed }, ...extra });
      if (r && r.finishReason === 'length') stats.truncated[kind] = (stats.truncated[kind] || 0) + 1;
      last = { ...parsed, text: r ? r.text : null };
      if (parsed.ok) return { ...parsed, text: r.text, attempts: attempt + 1 };
    }
    stats.fail(kind);
    return { ...last, ok: false, attempts: 2 };
  };
}

async function runSim(o) {
  const variant = o.variant || 'default';
  if (!VARIANTS.includes(variant)) throw new Error(`variant は ${VARIANTS.join('|')}`);
  const outsider = variant === 'outsider';
  const language = variant !== 'no-language';
  const N = o.agents || 5;
  const months = o.months || (outsider ? 15 : 12);
  const nStart = outsider ? N - 1 : N; // outsider: 元は 4人で始め、4か月目 (round 3) に5人目が入る
  const outsiderMonth = o.outsiderMonth ?? 3;
  const envCfg = scaleConfig({ agents: N, maxMonths: months, allocation: o.allocation || 'stochastic', seed: o.seed ?? 1, capacity: o.capacity ?? null });
  const env = new FisheryEnv(envCfg);
  if (outsider && o.govsimOutsiderBug) env.thresholdN = nStart;
  const log = o.log || (() => {});
  const llm = o.llm;
  const stats = new Stats();
  const maxConv = o.maxConversation ?? 10;
  const mentalOn = !!o.mental;
  const f0 = sustainableShare(envCfg.capacity, nStart);

  // 人と名前
  const rngP = new Rng((o.seed ?? 1) * 7919 + 17);
  let personas;
  if (o.personas) personas = o.personas.slice(0, N);
  else if (o.mentalConfig) personas = pickPersonas(o.mentalConfig.personas, N, rngP);
  else personas = Array.from({ length: N }, (_, i) => ({ name: GOVSIM_NAMES[i] || `Fisher${i + 1}` }));
  if (o.names === 'govsim') personas = personas.map((p, i) => ({ ...p, name: GOVSIM_NAMES[i] || `Fisher${i + 1}` }));
  const names = personas.map((p) => p.name);
  const goalsOf = (i) => (outsider ? (i === N - 1 ? P.GOALS.outsider : P.GOALS.traditional) : '');

  const agents = personas.map((p, i) => {
    const others = names.filter((n) => n !== p.name);
    const sys = P.systemPrompt({ name: p.name, others, capacity: envCfg.capacity, nAgents: N, language, goals: goalsOf(i),
      personality: mentalOn ? (p.personality_en || '') : '' });
    const a = { name: p.name, persona: p, sys, memory: new GovMemory({ expirationDays: o.expirationDays ?? 63 }), mental: null };
    if (mentalOn) a.mental = new Mental({ persona: p, cfg: o.mentalConfig, others: [], subsistence: o.subsistence ?? f0, higherNeeds: !!o.higherNeeds });
    return a;
  });
  const byName = Object.fromEntries(agents.map((a) => [a.name, a]));
  log({ type: 'start', variant, agents: names, personas: mentalOn ? personas.map((p) => ({ name: p.name, age: p.age, sex: p.sex, temperament: p.temperament, personality_en: p.personality_en })) : undefined,
    env: envCfg, mental: mentalOn, language, outsider, f0 });

  const ask = makeAsk({ llm, log, stats });

  let agreement = null; // 最新の取り決め (mental on の「破った・守った」の判定に使う)
  const agreements = [];
  const monthRows = [];
  let active = agents.slice(0, nStart);
  const setActive = (list) => { active = list; for (const a of active) if (a.mental) a.mental.setOthers(active.map((x) => x.name)); };
  setActive(active);

  while (!env.done) {
    const m = env.month;
    if (outsider && m === outsiderMonth && active.length < N) { setActive(agents.slice(0, N)); log({ type: 'outsider_joins', month: m, who: agents[N - 1].name }); }
    const t0 = monthStart(m); const tDisc = discussionDay(m); const tRef = reflectionDay(m);
    const f = env.threshold(active.length);
    // ---- 漁 ----
    for (const a of active) {
      a.memory.addEvent(P.tonsInLake(env.pool), t0, tRef, true);
      if (variant === 'universalization') a.memory.addEvent(P.univ(f), t0, tRef, true);
      if (a.mental) a.mental.beforeHarvest(m);
    }
    const harvestRes = await Promise.all(active.map(async (a) => {
      const mental = a.mental ? a.mental.words() : '';
      const snap = a.mental ? a.mental.snapshot() : undefined;
      if (env.pool <= 0) return { a, wanted: 0, ok: true, mental };
      const prompt = P.harvestPrompt({ sys: a.sys, date: t0, name: a.name, memories: a.memory.retrieve(t0, 10), interval: [0, env.pool], mental });
      const r = await ask({ agent: a.name, role: 'act', kind: 'harvest', month: m, prompt, parse: parseHarvest, maxTokens: o.maxTokensHarvest ?? 2500, extra: mental ? { mental, mentalState: snap } : {} });
      return { a, wanted: r.ok ? r.value : 0, ok: r.ok, mental, reasoning: r.text, cited: citedTerms(mental, r.text) };
    }));
    const wanted = Object.fromEntries(harvestRes.map((x) => [x.a.name, x.wanted]));
    const rec = env.harvest(active.map((a) => a.name), wanted);
    log({ type: 'harvest', month: m, poolBefore: rec.poolBefore, threshold: rec.threshold, wanted: rec.wanted, caught: rec.caught, poolAfter: rec.poolAfter, collapsed: rec.collapsed,
      failed: harvestRes.filter((x) => !x.ok).map((x) => x.a.name), cited: Object.fromEntries(harvestRes.filter((x) => x.cited && x.cited.length).map((x) => [x.a.name, x.cited])) });
    const mentalEvents = {};
    for (const a of active) {
      a.memory.addEvent(P.tonsCaught(a.name, rec.wanted[a.name], rec.caught[a.name]), new Date(tDisc.getTime() - 60000), tRef, true);
      if (a.mental) mentalEvents[a.name] = { harvest: a.mental.onHarvest(m, { wanted: rec.wanted[a.name], caught: rec.caught[a.name] }) };
    }
    // ---- 話し合い ----
    let conversation = []; let summary = null; let limit = null;
    if (language) {
      conversation.push(['Mayor', P.mayorReport(active.map((a) => [a.name, rec.caught[a.name]]))]);
      for (const a of active) if (a.mental) { mentalEvents[a.name].report = a.mental.onReport(m, rec.caught, agreement); a.mental.onMeeting(); }
      const participants = active.map((a) => a.name);
      let speaker = active[0];
      while (true) {
        const mental = speaker.mental ? speaker.mental.words() : '';
        const prompt = P.utterancePrompt({ sys: speaker.sys, date: tDisc, name: speaker.name, memories: speaker.memory.retrieve(tDisc, 5), participants, conversation, mental });
        const r = await ask({ agent: speaker.name, role: 'talk', kind: 'utterance', month: m, prompt, parse: (t) => parseUtterance(t, participants), maxTokens: o.maxTokensUtterance ?? 800, extra: mental ? { mental } : {} });
        const utter = r.utterance || '';
        conversation.push([speaker.name, utter]);
        if (speaker.mental) speaker.mental.onSpoke();
        for (const a of active) if (a.mental && a !== speaker) a.mental.onHeard(speaker.name, utter);
        const end = r.ok ? r.end : (r.end !== false); // 読めないときは元の既定 (終わる)。終わらないが次が読めないときは元の既定 (最初の人)
        if (end || conversation.length >= maxConv) break;
        speaker = byName[r.next] && active.includes(byName[r.next]) ? byName[r.next] : active[0];
      }
      const s = await ask({ agent: 'framework', role: 'framework', kind: 'summary', month: m, prompt: P.summaryPrompt(conversation), parse: (t) => ({ ok: true, value: firstSentence(t) }), maxTokens: 200 });
      summary = s.ok ? s.value : '';
      const l = await ask({ agent: 'framework', role: 'framework', kind: 'limit', month: m, prompt: P.limitPrompt(conversation), parse: parseLimit, maxTokens: o.maxTokensLimit ?? 1500 });
      limit = l.ok ? l.value : null;
      if (limit != null) { agreement = limit; agreements.push({ month: m, limit }); }
      log({ type: 'conversation', month: m, conversation, summary, limit });
      await Promise.all(active.map(async (a) => {
        a.memory.addChat(summary, tDisc);
        const mental = a.mental ? a.mental.words() : '';
        const pl = await ask({ agent: a.name, role: 'reflect', kind: 'planning', month: m, prompt: P.planningPrompt(a.sys, conversation, mental, a.name), parse: (t) => ({ ok: !!firstSentence(t), value: firstSentence(t) }), maxTokens: 200 });
        if (pl.ok) a.memory.addThought(pl.value, tDisc);
        const me = await ask({ agent: a.name, role: 'reflect', kind: 'memorize', month: m, prompt: P.memorizePrompt(a.sys, conversation, mental, a.name), parse: (t) => ({ ok: !!firstSentence(t), value: firstSentence(t) }), maxTokens: 200 });
        if (me.ok) a.memory.addThought(me.value, tDisc);
        if (limit != null) a.memory.addThought(P.agreedLimit(limit), tDisc, { always: true });
      }));
    }
    // ---- 振り返り (家) ----
    await Promise.all(active.map(async (a) => {
      if (a.mental) a.mental.beforeReflect(m);
      const mems = a.memory.retrieve(tRef, 10);
      if (!mems.length) return;
      const mental = a.mental ? a.mental.words() : '';
      const r = await ask({ agent: a.name, role: 'reflect', kind: 'insight', month: m, prompt: P.insightPrompt(a.sys, a.name, mems, mental), parse: (t) => { const v = parseInsights(t); return { ok: v.length > 0, value: v }; }, maxTokens: 500 });
      if (r.ok) for (const x of r.value) a.memory.addThought(x, tRef);
    }));
    for (const a of active) if (a.mental) { a.mental.sleep(m); mentalEvents[a.name].state = a.mental.snapshot(); }
    if (mentalOn) log({ type: 'mental', month: m, events: mentalEvents });
    monthRows.push({ month: m, poolBefore: rec.poolBefore, threshold: rec.threshold, wanted: rec.wanted, caught: rec.caught, poolAfter: rec.poolAfter, limit,
      conversationLen: conversation.length, mentalWords: mentalOn ? Object.fromEntries(harvestRes.map((x) => [x.a.name, x.mental])) : undefined,
      cited: mentalOn ? Object.fromEntries(harvestRes.map((x) => [x.a.name, x.cited || []])) : undefined });
    env.endMonth();
  }

  const metrics = computeMetrics(env.history, { maxMonths: months, capacity: envCfg.capacity, agents: names, collapseBelow: envCfg.collapseBelow, initialAgents: nStart });
  const summary = {
    variant, mental: mentalOn, seed: o.seed ?? 1, agents: names, months, allocation: envCfg.allocation, env: envCfg, metrics,
    monthsRun: env.history.length, agreements, months_detail: monthRows,
    parseFailures: stats.parseFail, reasked: stats.reasked, truncated: stats.truncated, llmCalls: stats.llmCalls, llmErrors: stats.llmErrors, callsByRole: stats.byRole,
    failurePolicy: 'parse 失敗は REASK を足して1回だけ聞き直す。それでもだめなら: 収穫 = 0 トン (GovSim と同じ値)、発言 = 読めた分の文・話し合いは終える (GovSim の既定 yes)・次の話し手が読めなければ最初の人 (GovSim の既定)、取り決め = なし。どれも parseFailures に数える',
  };
  if (mentalOn) summary.mentalContribution = mentalStats(monthRows);
  log({ type: 'end', summary });
  return summary;
}

// mental on の寄与の集計 (収穫の考えに心の言葉が出た割合と、出た言葉)
function mentalStats(rows) {
  let calls = 0; let citing = 0; const terms = {}; const shown = {};
  for (const r of rows) {
    for (const [n, w] of Object.entries(r.mentalWords || {})) {
      calls += 1;
      for (const part of String(w || '').split('; ').filter(Boolean)) { const k = part.replace(/^with [^:]+: /, 'with X: '); shown[k] = (shown[k] || 0) + 1; }
      const c = (r.cited || {})[n] || [];
      if (c.length) citing += 1;
      for (const t of c) terms[t] = (terms[t] || 0) + 1;
    }
  }
  return { harvestDecisions: calls, decisionsCitingMentalTerms: citing, citedTerms: terms, shownPhrases: shown };
}

module.exports = { runSim, VARIANTS, GOVSIM_NAMES, monthStart, reflectionDay, discussionDay, citedTerms, MENTAL_TERMS, makeAsk, Stats, mentalStats, REASK };
