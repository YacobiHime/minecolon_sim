'use strict';
// ゴール → 逆向きにさかのぼった手順 → 1段ずつこなす (help.goalPlan。help.selfGoal の代わり)。
//   (a) ゴール (2B): しばらくめざすゴールを1つ。達成するか、捨てるまで変えない
//   (b) 手順 (2B): ゴールから逆向きにさかのぼって要るものを考え (needs)、最初にやる手順から順に並べる (steps)。
//       各手順は済んだか確かめられる形の文。maxSteps 個まで
//   (c) 確認 (Jev noul): 各手順が、見せている知識 (facts) と行動の一覧でできるか。1回の呼び出しにまとめて聞く。
//       checkThreshold 未満の手順はその部分だけ 2B に書き直させ、書き直した分をもう一度確かめる (maxRewrites 回まで)
//   (d) 実行: 行動を選ぶ Jev の state.plan には、ゴールと今の手順 (何手順目か) だけを出す。今の手順が済んだかを
//       Jev の noul (step_done) で毎回聞き、stepDoneThreshold 以上なら次の手順へ。全部済んだらゴール達成 → 新しいゴール
//   (d') ゴールは欲求から: ゴール作りには、体と心の状態・いちばんつらいこととその理由・周りの人の情報を渡し、
//       全体の目標は渡さない (goal.text が空のとき)。2B はゴールと一緒に「何のため」(why) と、満たしたいもの (need) を書く。
//       手順を全部こなしても、そのゴールの元の欲求が下がっていなければ (needDrop 未満・needLow より上)、手順を作り直す
//   (e) 詰まったとき (困りごとが troubleTicks 判断続く・今の手順が stepPatience 判断進まない): 残りの手順だけ作り直す。
//       ゴールは変えない。作り直しが abandonAfter 回を超えたらゴールを捨てて新しいゴール
// 研究方針: 仕様・事実は見せるが、どう使うかは書かない。評価語を指示に入れない。
const { LLMDecider } = require('./deciders/llm');
const { timePhase } = require('./util');
const { NEED_LABEL, LABEL_TO_NEED } = require('./needs');

const DEFAULTS = {
  maxSteps: 6,
  checkThreshold: 0.5,
  maxRewrites: 2,
  stepDoneThreshold: 0.7,
  stepPatience: 15,
  troubleTicks: 4,
  abandonAfter: 3,
  rewriteMax: 1, // 書き直した手順の数 (1つの手順を何個の手順にしてよいか)
  retryAfter: 3, // 2B の出力が読めなかったとき、次に試すまでの判断の数
  maxTokens: { goal: 120, steps: 420, rewrite: 160 },
  temperature: 0.5,
  goalMax: 60,
  stepMax: 40,
  whyMax: 60,
  needDrop: 0.15, // ゴールの元の欲求が、決めたときからこれだけ下がれば満たされた
  needLow: 0.3, // または、これより下になれば満たされた
};

const NEED_LABELS = Object.values(NEED_LABEL);
const GOAL_SCHEMA = {
  type: 'object',
  properties: { goal: { type: 'string', maxLength: 60 }, why: { type: 'string', maxLength: 60 }, need: { type: 'string', enum: NEED_LABELS } },
  required: ['goal', 'why', 'need'], additionalProperties: false,
};
function stepsSchema(maxSteps, withNeeds = true) {
  const props = {};
  if (withNeeds) props.needs = { type: 'array', items: { type: 'string', maxLength: 40 }, minItems: 1, maxItems: maxSteps };
  props.steps = { type: 'array', items: { type: 'string', maxLength: 40 }, minItems: 1, maxItems: maxSteps };
  return { type: 'object', properties: props, required: Object.keys(props), additionalProperties: false };
}

function round3(v) { return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null; }

function parseJson(text) {
  try {
    const s = String(text);
    return JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
  } catch (_) { return null; }
}
function parseGoalText(text, max = DEFAULTS.goalMax) {
  const o = parseJson(text);
  const g = o && typeof o.goal === 'string' ? o.goal.trim().slice(0, max) : '';
  return g || null;
}
// { goal, why, need (needs.js のキー) } | null
function parseGoal(text, max = DEFAULTS.goalMax, whyMax = DEFAULTS.whyMax) {
  const o = parseJson(text);
  const g = o && typeof o.goal === 'string' ? o.goal.trim().slice(0, max) : '';
  if (!g) return null;
  const why = typeof o.why === 'string' ? o.why.trim().slice(0, whyMax) : '';
  const lab = typeof o.need === 'string' ? o.need.trim() : '';
  const need = LABEL_TO_NEED[lab] || (NEED_LABEL[lab] ? lab : null);
  return { goal: g, why: why || null, need };
}
function parseSteps(text, maxSteps = DEFAULTS.maxSteps, max = DEFAULTS.stepMax) {
  const o = parseJson(text);
  if (!o || !Array.isArray(o.steps)) return null;
  const steps = o.steps.map((x) => String(x).trim().slice(0, max)).filter(Boolean).slice(0, maxSteps);
  if (!steps.length) return null;
  const needs = Array.isArray(o.needs) ? o.needs.map((x) => String(x).trim()).filter(Boolean) : null;
  return { steps, needs };
}

// 時間と、夜 (または朝) までの目安。1日 = 24000 tick = 20分 (等倍)。夜は 13000〜23000
function timeText(timeOfDay, day = null) {
  const t = ((Number(timeOfDay) % 24000) + 24000) % 24000;
  const dayTxt = day != null ? ` ${day + 1}日目` : '';
  const min = (ticks) => Math.max(1, Math.round(ticks / 1200));
  const left = t < 13000 ? `夜まであと約${min(13000 - t)}分` : t < 23000 ? `朝まであと約${min(23000 - t)}分` : `朝まであと約${min(24000 - t)}分`;
  return `時間: ${timePhase(t)}${dayTxt} (${left})`;
}

// 行動の一覧 → { 名前: 説明 } (発言 say は除かない。2B に見せる一覧)
function actionTable(actions) {
  const t = {};
  for (const a of actions || []) if (!t[a.name]) t[a.name] = a.desc || a.name;
  return t;
}

class GoalPlan {
  constructor(opts = {}) {
    const c = opts.cfg || {};
    this.cfg = { ...DEFAULTS, ...c, maxTokens: { ...DEFAULTS.maxTokens, ...(c.maxTokens || {}) } };
    this.llm = opts.llm || new LLMDecider({ ...(opts.llmOpts || {}), mode: 'talk', maxTokens: this.cfg.maxTokens.steps, temperature: this.cfg.temperature });
    this.jev = opts.jev || null; // JevDecider (call(state, questions, stage) を使う)。無ければ確認はしない
    this.meter = opts.meter || null;
    this.log = opts.log || (() => {});
    this.goal = null; // { text, setAt, rebuilds, n }
    this.steps = []; // [{ text, p }]
    this.idx = 0;
    this.stepSince = 0;
    this.troubleRun = 0;
    this.retryAt = -1;
    this.history = []; // [{ goal, result: 'done'|'abandoned', stepsDone, stepsTotal, rebuilds, from, to }]
    this.counts = { goals: 0, done: 0, abandoned: 0, advanced: 0, rebuilds: 0, checks: 0, checkFailed: 0, rewrites: 0 };
    this.loggedPrompt = {};
  }

  get current() { return this.steps[this.idx] || null; }

  planText() {
    if (!this.goal) return '';
    const s = this.current;
    const g = `ゴール: ${this.goal.text}${this.goal.why ? ` (何のため: ${this.goal.why})` : ''}`;
    return s ? `${g} / 今の手順 (${this.idx + 1}/${this.steps.length}): ${s.text}` : g;
  }

  // 2B を呼ぶ (使用量を meter に)
  async ask2B(kind, messages, schema, maxTokens) {
    const promptChars = messages.reduce((s, m) => s + m.content.length, 0);
    const t0 = Date.now();
    let r = null; let error = null;
    const prevMax = this.llm.maxTokens;
    if (maxTokens) this.llm.maxTokens = maxTokens;
    try { r = await this.llm.complete(messages, schema); } catch (e) { error = e.message; } finally { this.llm.maxTokens = prevMax; }
    const ms = Date.now() - t0;
    const rec = { kind, promptChars, promptTokens: r ? r.promptTokens : null, completionTokens: r ? r.completionTokens : null, ms, error, rawOutput: r ? r.text : null };
    if (!this.loggedPrompt[kind]) { rec.prompt = messages; this.loggedPrompt[kind] = true; } // プロンプトの全文は種類ごとに最初の1回だけ
    return rec;
  }

  addMeter(rec, ok) {
    if (this.meter) this.meter.addTwoB({ kind: `plan_${rec.kind}`, promptChars: rec.promptChars, promptTokens: rec.promptTokens, completionTokens: rec.completionTokens, ms: rec.ms, error: rec.error || (ok ? null : 'parse') });
  }

  // 2B に渡す材料 (共通)。ctx = { persona, goalText, obsText, raw, facts(text) → [文], actions, memText, socialText, troubles,
  //   worst: { need, label, text } (いちばんつらいこと), peopleText (周りの人), needNow(k) → 数値 (済んだかの判断だけに使い、渡さない) }
  material(ctx, factsKey) {
    const p = ctx.persona || {};
    const self = ctx.raw && ctx.raw.self;
    const facts = ctx.facts ? ctx.facts(factsKey || '') : [];
    const tbl = actionTable(ctx.actions);
    const sys = [
      `あなたは Minecraft の世界にいる「${p.name}」。${p.personality || ''}`,
      ctx.goalText ? `全体の目標: ${ctx.goalText}` : '',
      'あなたが知っているのは、自分で見たこと・やったこと・聞いたことと、「知っていること」だけ。',
    ];
    const user = [
      '## 今の様子', ctx.obsText,
      self ? timeText(self.timeOfDay, self.day) : '',
      ctx.socialText ? `## 体と心\n${ctx.socialText}` : '',
      ctx.worst ? `## いちばんつらいこと\n${ctx.worst.text}` : '',
      ctx.peopleText ? `## 周りの人\n${ctx.peopleText}` : '',
      facts.length ? `## 知っていること\n${facts.join('\n')}` : '',
      `## できる行動\n${Object.entries(tbl).map(([k, v]) => `${k}: ${v}`).join('\n')}`,
      '## 覚えていること', ctx.memText || 'なし',
      `## これまでのゴール\n${this.history.length ? this.history.slice(-5).map((h) => `${h.goal}${h.why ? ` (何のため: ${h.why})` : ''} (${h.result === 'done' ? '達成した' : 'やめた'}。手順 ${h.stepsDone}/${h.stepsTotal})`).join('\n') : 'まだない'}`,
    ];
    return { sys, user };
  }

  goalMessages(ctx) {
    const { sys, user } = this.material(ctx, '');
    sys.push(`${ctx.goalText ? '全体の目標に向けて、' : ''}自分がこれからめざすゴールを1つ決める。ゴールは、達成するか、できないと分かるまで変えない。短い日本語で書く。`,
      `why にはそのゴールが何のためか、need にはそのゴールで満たしたいもの (${NEED_LABELS.join('・')}) を1つ書く。`,
      'JSON {"goal":"...","why":"...","need":"..."} だけを出力する。');
    user.push('ゴールを JSON で。');
    return [{ role: 'system', content: sys.filter(Boolean).join('\n') }, { role: 'user', content: user.filter(Boolean).join('\n') }];
  }

  // rebuild = { done: [文], stuck: 文, why: 文 } のとき、残りの手順だけを作り直す
  stepsMessages(ctx, rebuild = null) {
    const g = this.goal.text;
    const { sys, user } = this.material(ctx, g);
    sys.push(
      `ゴール「${g}」から逆向きにさかのぼって、そのために要るもの・済んでいる必要のあることを順に考え (needs)、`
      + `それを、最初にやる手順から順に並べる (steps)。各手順は「(物の名前)を3個持っている」「(物の名前)を置いた」「(場所や人)の近くにいる」のように、済んだかを確かめられる形の短い文にする。手順は${this.cfg.maxSteps}個まで。`,
      'JSON {"needs":["..."],"steps":["..."]} だけを出力する。',
    );
    if (rebuild && !rebuild.allDone) {
      user.push(`## 済んだ手順\n${rebuild.done.length ? rebuild.done.join('\n') : 'なし'}`);
      user.push(`## 進まなかった手順\n${rebuild.stuck} (${rebuild.why})`);
      user.push('済んだ手順のあとの、残りの手順だけを JSON で。');
    } else if (rebuild && rebuild.allDone) {
      user.push(`## 済んだ手順\n${rebuild.done.length ? rebuild.done.join('\n') : 'なし'}`);
      user.push(`## 手順は全部済んだが\n${rebuild.why}`);
      user.push('これからの手順を JSON で。');
    } else user.push(`## ゴール\n${g}${this.goal.why ? ` (何のため: ${this.goal.why})` : ''}`, '手順を JSON で。');
    return [{ role: 'system', content: sys.filter(Boolean).join('\n') }, { role: 'user', content: user.filter(Boolean).join('\n') }];
  }

  rewriteMessages(ctx, i) {
    const g = this.goal.text;
    const { sys, user } = this.material(ctx, `${g} ${this.steps.map((s) => s.text).join(' ')}`);
    sys.push(`ゴール「${g}」の手順のうち、1つの手順だけを書き直す。手順は済んだかを確かめられる形の短い文。書き直した手順は${this.cfg.rewriteMax > 1 ? `1〜${this.cfg.rewriteMax}個` : '1個'}。`, 'JSON {"steps":["..."]} だけを出力する。');
    user.push(`## 手順\n${this.steps.map((s, j) => `(${j + 1}) ${s.text}`).join('\n')}`);
    user.push(`## 書き直す手順\n(${i + 1}) ${this.steps[i].text} — 「知っていること」と「できる行動」からは、できるか確かめられなかった`);
    user.push('この手順の代わりを JSON で。');
    return [{ role: 'system', content: sys.filter(Boolean).join('\n') }, { role: 'user', content: user.filter(Boolean).join('\n') }];
  }

  // (c) Jev で手順を確かめる。idxs の手順だけ聞く。返り値 { [i]: p }
  async check(ctx, idxs, tick) {
    if (!this.jev || !idxs.length) return null;
    const facts = ctx.facts ? ctx.facts(`${this.goal.text} ${this.steps.map((s) => s.text).join(' ')}`) : [];
    const state = { you: ctx.persona.name, goal: this.goal.text, steps: this.steps.map((s, j) => `(${j + 1}) ${s.text}`), now: ctx.obsText };
    if (facts.length) state.knowledge = facts.join(' ');
    state.actions = actionTable((ctx.actions || []).filter((a) => a.argType !== 'text'));
    const questions = {};
    for (const i of idxs) {
      questions[`step_${i + 1}`] = { type: 'noul', instructions: `Judging only from \`knowledge\`, \`actions\` and \`now\`, can \`you\` accomplish step (${i + 1}) of \`steps\`, assuming the steps before it are done?` };
    }
    const c = await this.jev.call(state, questions, 'plan');
    const ps = {};
    if (c.r.ok) for (const i of idxs) { const a = c.r.answers && c.r.answers[`step_${i + 1}`]; ps[i] = a && Number.isFinite(a.noul) ? a.noul : null; }
    this.counts.checks += 1;
    const failed = idxs.filter((i) => ps[i] != null && ps[i] < this.cfg.checkThreshold);
    this.counts.checkFailed += failed.length;
    this.log({ kind: 'check', tick, goal: this.goal.text, steps: this.steps.map((s) => s.text), asked: idxs, p: ps, failed, threshold: this.cfg.checkThreshold,
      ok: c.r.ok, error: c.r.ok ? null : c.r.error, inputTokens: c.inputTokens });
    return { ps, failed, ok: c.r.ok };
  }

  // 手順を作ったあと: 確かめて、落ちた手順だけ書き直す (maxRewrites 回まで)
  async checkAndRewrite(ctx, tick, from = 0) {
    let idxs = this.steps.map((_, i) => i).filter((i) => i >= from);
    for (let round = 0; round <= this.cfg.maxRewrites; round++) {
      const r = await this.check(ctx, idxs, tick);
      if (!r) return;
      for (const [i, p] of Object.entries(r.ps)) if (this.steps[i]) this.steps[i].p = p;
      if (!r.failed.length || round === this.cfg.maxRewrites) return;
      // 後ろから書き直す (1〜2個に増えても前の番号がずれない)
      const changed = [];
      for (const i of [...r.failed].sort((a, b) => b - a)) {
        const rec = await this.ask2B('rewrite', this.rewriteMessages(ctx, i), stepsSchema(this.cfg.rewriteMax, false), this.cfg.maxTokens.rewrite);
        const parsed = rec.rawOutput ? parseSteps(rec.rawOutput, this.cfg.rewriteMax, this.cfg.stepMax) : null;
        this.addMeter(rec, !!parsed);
        const before = this.steps[i].text;
        if (parsed) {
          const room = this.cfg.maxSteps - (this.steps.length - 1);
          const repl = parsed.steps.slice(0, Math.max(1, room)).map((text) => ({ text, p: null }));
          this.steps.splice(i, 1, ...repl);
          for (let k = 0; k < changed.length; k++) changed[k] += repl.length - 1;
          for (let k = 0; k < repl.length; k++) changed.push(i + k);
          this.counts.rewrites += 1;
        }
        this.log({ kind: 'rewrite', tick, goal: this.goal.text, index: i, before, after: parsed ? parsed.steps : null, ok: !!parsed, ...rec });
      }
      if (!changed.length) return;
      idxs = changed.sort((a, b) => a - b);
    }
  }

  async newGoal(ctx, tick) {
    const rec = await this.ask2B('goal', this.goalMessages(ctx), GOAL_SCHEMA, this.cfg.maxTokens.goal);
    const pg = rec.rawOutput ? parseGoal(rec.rawOutput, this.cfg.goalMax, this.cfg.whyMax) : null;
    this.addMeter(rec, !!pg);
    const needAt = pg && pg.need && ctx.needNow ? round3(ctx.needNow(pg.need)) : null;
    this.log({ kind: 'goal', tick, goal: pg ? pg.goal : null, why: pg ? pg.why : null, need: pg ? pg.need : null, needAt,
      worst: ctx.worst ? ctx.worst.need : null, worstText: ctx.worst ? ctx.worst.text : null, ok: !!pg, ...rec });
    if (!pg) { this.retryAt = tick + this.cfg.retryAfter; return false; }
    this.counts.goals += 1;
    this.goal = { text: pg.goal, why: pg.why, need: pg.need, needAt, setAt: tick, rebuilds: 0, n: this.counts.goals };
    this.steps = []; this.idx = 0; this.stepSince = tick; this.troubleRun = 0;
    return this.makeSteps(ctx, tick);
  }

  // 手順を作る (rebuild があれば、済んだ手順のあとを作り直す)
  async makeSteps(ctx, tick, rebuild = null) {
    const rec = await this.ask2B(rebuild ? 'rebuild' : 'steps', this.stepsMessages(ctx, rebuild), stepsSchema(this.cfg.maxSteps), this.cfg.maxTokens.steps);
    const parsed = rec.rawOutput ? parseSteps(rec.rawOutput, this.cfg.maxSteps, this.cfg.stepMax) : null;
    this.addMeter(rec, !!parsed);
    const keep = rebuild && !rebuild.allDone ? this.steps.slice(0, this.idx) : [];
    if (parsed) {
      const room = Math.max(1, this.cfg.maxSteps - keep.length);
      this.steps = [...keep, ...parsed.steps.slice(0, room).map((text) => ({ text, p: null }))];
      if (rebuild && rebuild.allDone) this.idx = 0;
      this.stepSince = tick; this.troubleRun = 0;
    }
    this.log({ kind: rebuild ? 'rebuild' : 'steps', tick, goal: this.goal.text, needs: parsed ? parsed.needs : null, steps: parsed ? this.steps.map((s) => s.text) : null, from: keep.length, why: rebuild ? rebuild.why : null, ok: !!parsed, ...rec });
    if (!parsed) { this.retryAt = tick + this.cfg.retryAfter; return false; }
    await this.checkAndRewrite(ctx, tick, keep.length);
    this.log({ kind: 'plan', tick, goal: this.goal.text, steps: this.steps.map((s) => ({ text: s.text, p: s.p })), idx: this.idx });
    return true;
  }

  finishGoal(result, tick, nc = null) {
    const h = { goal: this.goal.text, why: this.goal.why || null, need: this.goal.need || null, result, stepsDone: Math.min(this.idx, this.steps.length), stepsTotal: this.steps.length, rebuilds: this.goal.rebuilds, from: this.goal.setAt, to: tick };
    this.history.push(h);
    if (result === 'done') this.counts.done += 1; else this.counts.abandoned += 1;
    this.log({ kind: result === 'done' ? 'goal_done' : 'abandon', tick, ...h, needAt: this.goal.needAt ?? null, needNow: nc ? nc.now : null });
    this.goal = null; this.steps = []; this.idx = 0;
  }

  // 毎判断の前に呼ぶ。stepDoneP: 前の判断で Jev が答えた「今の手順は済んだか」。troubles: 今の困りごと
  async update(ctx, tick, { stepDoneP = null, troubles = [] } = {}) {
    this.troubleRun = troubles.length ? this.troubleRun + 1 : 0;
    if (tick < this.retryAt) return null;
    if (!this.goal) { await this.newGoal(ctx, tick); return 'goal'; }
    if (!this.steps.length) { await this.makeSteps(ctx, tick); return 'steps'; }
    if (stepDoneP != null && stepDoneP >= this.cfg.stepDoneThreshold) {
      this.log({ kind: 'advance', tick, goal: this.goal.text, step: this.current.text, index: this.idx, p: stepDoneP, took: tick - this.stepSince });
      this.counts.advanced += 1;
      this.idx += 1; this.stepSince = tick; this.troubleRun = 0;
      if (this.idx >= this.steps.length) {
        // 手順は全部済んだ: ゴールの元の欲求が下がっていれば達成。下がっていなければ手順を作り直す
        const nc = this.needCheck(ctx);
        if (nc.met) { this.finishGoal('done', tick, nc); await this.newGoal(ctx, tick); return 'goal_done'; }
        this.log({ kind: 'need_unmet', tick, goal: this.goal.text, need: this.goal.need, needAt: this.goal.needAt, needNow: nc.now });
        return this.rebuildOrAbandon(ctx, tick, { done: this.steps.map((s) => s.text), allDone: true,
          why: `${NEED_LABEL[this.goal.need]}のつらさが変わらない${ctx.worst && ctx.worst.need === this.goal.need ? ` (${ctx.worst.text})` : ''}` });
      }
      return 'advance';
    }
    const stuckTrouble = this.troubleRun >= this.cfg.troubleTicks;
    const stuckLong = tick - this.stepSince >= this.cfg.stepPatience;
    if (!stuckTrouble && !stuckLong) return null;
    const why = stuckTrouble ? `困りごとが${this.troubleRun}判断続いた: ${troubles.map((t) => t.about).join(' / ')}` : `${tick - this.stepSince}判断進まなかった`;
    return this.rebuildOrAbandon(ctx, tick, { done: this.steps.slice(0, this.idx).map((s) => s.text), stuck: this.current.text, why });
  }

  // ゴールの元の欲求が下がったか。need が無い・数値が取れないときは、手順を全部こなしたことで済んだとする
  needCheck(ctx) {
    const g = this.goal;
    if (!g || !g.need || !ctx.needNow || g.needAt == null) return { met: true, now: null };
    const now = round3(ctx.needNow(g.need));
    return { met: now <= g.needAt - this.cfg.needDrop || now <= this.cfg.needLow, now };
  }

  async rebuildOrAbandon(ctx, tick, rebuild) {
    this.goal.rebuilds += 1;
    this.counts.rebuilds += 1;
    if (this.goal.rebuilds > this.cfg.abandonAfter) {
      this.finishGoal('abandoned', tick);
      await this.newGoal(ctx, tick);
      return 'abandon';
    }
    await this.makeSteps(ctx, tick, rebuild);
    if (this.stepSince !== tick) this.stepSince = tick; // 作り直せなくても、すぐには繰り返さない
    this.troubleRun = 0;
    if (rebuild.allDone && this.idx >= this.steps.length) this.idx = Math.max(0, this.steps.length - 1); // 作り直せなかったら最後の手順に留まる
    return rebuild.allDone ? 'rebuild_need' : 'rebuild';
  }
}

module.exports = { GoalPlan, DEFAULTS, GOAL_SCHEMA, stepsSchema, parseGoal, parseGoalText, parseSteps, timeText, actionTable };
