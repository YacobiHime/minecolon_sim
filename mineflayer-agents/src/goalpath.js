'use strict';
// ゴール (2B) → 道筋 (プログラム、planner.js) → 行動 (Jev) の3つの層 (help.goalPath。goalplan.js の手順の文の代わり)。
//   考える (2B): ゴールを {kind, target, count?, give?, why, need} で決める。kind は item (物)・person (人)・place (場所)。
//     target は候補 (vocab.js: 物は関係しそうな数十個を日本語名付きで、人、場所) の名前から選ぶ (JSON schema の enum)。
//     呼ぶのは、ゴールが無いとき・済んだとき・詰まったとき・たどれなかったときだけ。
//   道筋 (プログラム): 物のゴールなら毎判断、今の持ち物と見えている物から要る物の連なりを作り直す (planner.js)。
//     人・場所のゴールは「次: Ken の所へ行く」「次: まだ行っていない北の方へ」だけ。
//     Jev の state.plan には planText() の短い文 (ゴール / 道筋 / 次) だけを出す。
//   済んだか: 物を持った・人の近くにいる (渡した)・場所に着いた をプログラムで確かめ (一度確かめたら済んだまま)、
//     さらに元の欲求が下がったか (needDrop / needLow) を見る。needWait 判断待っても下がらなければ、2B に選び直させる。
//   詰まった: 困りごとが troubleTicks 判断続く・道筋の残り (または人・場所までの距離) が patience 判断縮まない → 選び直し (同じゴールでもよい)。
//   たどれない物 (レシピも入手元も分からない) は、その旨を添えて 2B に選び直させる (maxTries 回まで)。
// 研究方針: 仕様・事実は見せるが、どう使うかは書かない。評価語を指示に入れない。数値はここで持ち、モデルには言葉だけ。
const { LLMDecider } = require('./deciders/llm');
const { Planner, pathText, remaining, GROUND } = require('./planner');
const { itemCandidates, personCandidates, placeCandidates } = require('./vocab');
const { timeText } = require('./goalplan');
const { NEED_LABEL, LABEL_TO_NEED } = require('./needs');
const { relDir, dist3 } = require('./util');

const DEFAULTS = {
  maxItems: 40,
  maxTries: 2, // 1回の選び直しで、たどれなかったときに 2B に聞き直す回数
  retryAfter: 3,
  maxTokens: 120,
  temperature: 0.5,
  whyMax: 40,
  needDrop: 0.15,
  needLow: 0.3,
  needWait: 12, // 済んだあと、元の欲求が下がるのを待つ判断の数
  troubleTicks: 4,
  patience: 15,
  nearDist: 5,
  arriveDist: 6,
  farDist: 48,
  maxShown: 5,
  version: '1.20.1',
};
const KINDS = ['item', 'person', 'place'];
const KIND_JA = { item: '物', person: '人', place: '場所' };
const NEED_LABELS = Object.values(NEED_LABEL);

function parseJson(text) {
  try { const s = String(text); return JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)); } catch (_) { return null; }
}

function goalSchema(cands, { giveItems = [] } = {}) {
  const names = [...new Set([...cands.items, ...cands.people, ...cands.places].map((c) => c.name))];
  const props = {
    kind: { type: 'string', enum: KINDS },
    target: { type: 'string', enum: names },
    count: { type: 'integer', minimum: 1, maximum: 64 },
    why: { type: 'string', maxLength: 40 },
    need: { type: 'string', enum: NEED_LABELS },
  };
  if (giveItems.length) props.give = { type: 'string', enum: ['', ...giveItems] };
  return { type: 'object', properties: props, required: ['kind', 'target', 'why', 'need'], additionalProperties: false };
}

// 2B の出力 → { kind, target, count, give, why, need } | null。target の種類から kind を正す
function parseGoal(text, cands, opts = {}) {
  const o = parseJson(text);
  if (!o || typeof o.target !== 'string') return null;
  const t = o.target.trim();
  const inItems = cands.items.find((c) => c.name === t);
  const inPeople = cands.people.find((c) => c.name === t);
  const inPlaces = cands.places.find((c) => c.name === t);
  let kind = KINDS.includes(o.kind) ? o.kind : null;
  const fits = { item: !!inItems, person: !!inPeople, place: !!inPlaces };
  let kindFixed = false;
  if (!kind || !fits[kind]) {
    const k = KINDS.find((x) => fits[x]) || (opts.allowUnknownItem && /^[a-z0-9_]+$/.test(t) ? 'item' : null);
    if (!k) return null;
    kindFixed = !!kind; kind = k;
  }
  const lab = typeof o.need === 'string' ? o.need.trim() : '';
  const need = LABEL_TO_NEED[lab] || (NEED_LABEL[lab] ? lab : null);
  const count = kind === 'item' ? Math.max(1, Math.min(64, Math.floor(Number(o.count)) || 1)) : null;
  const give = kind === 'person' && typeof o.give === 'string' && o.give.trim() ? o.give.trim() : null;
  const why = typeof o.why === 'string' ? o.why.trim().slice(0, opts.whyMax ?? DEFAULTS.whyMax) : '';
  return { kind, target: t, count, give, why: why || null, need, kindFixed, place: inPlaces || null };
}

function goalText(g) {
  if (!g) return '';
  if (g.kind === 'item') return `${g.target} ${g.count}`;
  if (g.kind === 'person') return g.give ? `${g.target} に ${g.give} を渡す` : `${g.target} の近くにいる`;
  return g.place && g.place.type === 'dir' ? `${g.target}へ行く` : `${g.target}へ行く`;
}

function invCount(raw, name) { return (raw.inventory || []).filter((i) => i.name === name).reduce((t, i) => t + i.count, 0); }

class GoalPath {
  constructor(opts = {}) {
    this.cfg = { ...DEFAULTS, ...(opts.cfg || {}) };
    this.llm = opts.llm || new LLMDecider({ ...(opts.llmOpts || {}), mode: 'talk', maxTokens: this.cfg.maxTokens, temperature: this.cfg.temperature });
    this.meter = opts.meter || null;
    this.log = opts.log || (() => {});
    this.goal = null;
    this.path = null; // 今の道筋 (planner の返り値)
    this.history = []; // [{ kind, target, count, why, need, result, reason, from, to }]
    this.troubleRun = 0;
    this.retryAt = -1;
    this.counts = { goals: 0, done: 0, needUnmet: 0, stuck: 0, unplannable: 0, failed: 0 };
    this.loggedPrompt = false;
    this.lastNextKey = null;
  }

  // ---- 2B ----
  candidates(ctx) {
    const raw = ctx.raw;
    return {
      items: itemCandidates({ raw, facts: ctx.allFacts || [], placeKinds: ctx.placeKinds || [], history: this.history, version: this.cfg.version, maxItems: this.cfg.maxItems }),
      people: personCandidates(ctx.people || []),
      places: placeCandidates({ here: raw && raw.self.pos, base: ctx.base || null, baseLabel: ctx.baseLabel || null, places: ctx.places || [], cellAt: ctx.cellAt || null, far: this.cfg.farDist }),
    };
  }

  historyText() {
    if (!this.history.length) return 'まだない';
    return this.history.slice(-5).map((h) => `${goalText(h)}${h.why ? ` (何のため: ${h.why})` : ''}: ${h.resultText}`).join('\n');
  }

  messages(ctx, cands, feedback = []) {
    const p = ctx.persona || {};
    const self = ctx.raw && ctx.raw.self;
    const facts = ctx.facts ? ctx.facts('') : [];
    const inv = ((ctx.raw && ctx.raw.inventory) || []).map((i) => i.name);
    const sys = [
      `あなたは Minecraft の世界にいる「${p.name}」。${p.personality || ''}`,
      ctx.goalText ? `全体の目標: ${ctx.goalText}` : '',
      'あなたが知っているのは、自分で見たこと・やったこと・聞いたことと、「知っていること」だけ。',
      `自分がこれからめざすゴールを1つ決める。ゴールは、手に入れたい物 (kind: item)・近くに行きたい人 (kind: person)・行きたい場所 (kind: place) のどれか1つ。`,
      'target は「めざせる物」「人」「場所」の一覧にある名前を、そのまま1つ書く。物なら count に数を書く。'
        + (inv.length ? '人に持ち物を渡したいときは give にその物の名前を書く。' : ''),
      `why にはそのゴールが何のためか、need にはそのゴールで満たしたいもの (${NEED_LABELS.join('・')}) を1つ書く。`,
      `JSON {"kind":"...","target":"...","count":1,"why":"...","need":"..."} だけを出力する。`,
    ];
    const user = [
      '## 今の様子', ctx.obsText,
      self ? timeText(self.timeOfDay, self.day) : '',
      ctx.baseText ? `## 拠点の様子\n${ctx.baseText}` : '',
      ctx.socialText ? `## 体と心\n${ctx.socialText}` : '',
      ctx.worst ? `## いちばんつらいこと\n${ctx.worst.text}` : '',
      ctx.peopleText ? `## 周りの人\n${ctx.peopleText}` : '',
      facts.length ? `## 知っていること\n${facts.join('\n')}` : '',
      '## 覚えていること', ctx.memText || 'なし',
      `## これまでのゴール\n${this.historyText()}`,
      `## めざせる物\n${cands.items.map((c) => `${c.name}: ${c.desc}`).join('\n')}`,
      cands.people.length ? `## 人\n${cands.people.map((c) => `${c.name}: ${c.desc}`).join('\n')}` : '',
      `## 場所\n${cands.places.map((c) => `${c.name}: ${c.desc}`).join('\n')}`,
      feedback.length ? `## さっき選んだゴール\n${feedback.join('\n')}` : '',
      'ゴールを JSON で。',
    ];
    return [{ role: 'system', content: sys.filter(Boolean).join('\n') }, { role: 'user', content: user.filter(Boolean).join('\n') }];
  }

  async ask2B(messages, schema) {
    const promptChars = messages.reduce((s, m) => s + m.content.length, 0);
    const t0 = Date.now();
    let r = null; let error = null;
    try { r = await this.llm.complete(messages, schema); } catch (e) { error = e.message; }
    const rec = { promptChars, promptTokens: r ? r.promptTokens : null, completionTokens: r ? r.completionTokens : null, ms: Date.now() - t0, error, rawOutput: r ? r.text : null };
    if (!this.loggedPrompt) { rec.prompt = messages; this.loggedPrompt = true; }
    return rec;
  }

  addMeter(rec, ok) {
    if (this.meter) this.meter.addTwoB({ kind: 'goal_path', promptChars: rec.promptChars, promptTokens: rec.promptTokens, completionTokens: rec.completionTokens, ms: rec.ms, error: rec.error || (ok ? null : 'parse') });
  }

  // ---- 道筋 ----
  world(ctx) {
    const raw = ctx.raw;
    const kinds = new Set(ctx.placeKinds || []);
    return {
      inventory: raw.inventory,
      visibleBlocks: raw.blocks.map((b) => b.name),
      visibleMobs: raw.entities.filter((e) => e.kind !== 'item' && e.kind !== 'player').map((e) => e.name),
      knownBlocks: [...kinds],
      stations: { crafting_table: !!raw.tableNearby || kinds.has('crafting_table'), furnace: raw.blocks.some((b) => b.name === 'furnace') || kinds.has('furnace') },
      excludeBlocks: GROUND,
    };
  }

  planItem(ctx, target, count) {
    return new Planner(this.world(ctx), { version: this.cfg.version }).plan(target, count);
  }

  // 人・場所の今の様子 { met, d (距離), text (次の文) }
  targetStatus(ctx) {
    const g = this.goal;
    const raw = ctx.raw;
    const here = raw.self.pos;
    if (g.kind === 'item') {
      const have = invCount(raw, g.target);
      return { met: have >= g.count, d: remaining(this.path) };
    }
    if (g.kind === 'person') {
      const e = raw.entities.find((x) => x.kind === 'player' && x.name === g.target);
      const near = !!e && e.d <= this.cfg.nearDist;
      const gave = !!(ctx.gave || []).find((x) => x.to === g.target && (!g.give || x.item === g.give));
      const met = g.give ? gave : near;
      const where = e ? relDir(here, e.pos) : '今は見えない';
      const text = g.give && near ? `${g.target} に ${g.give} を渡す` : `${g.target} の所へ行く (${where})`;
      return { met, d: e ? e.d : 1e6, text };
    }
    const pl = g.place;
    if (pl.type === 'dir') {
      const start = g.startPos;
      const along = (here.x - start.x) * pl.vec[0] + (here.z - start.z) * pl.vec[1];
      const left = Math.max(0, Math.round(this.cfg.farDist - along));
      return { met: left <= this.cfg.farDist * 0.2, d: left, text: `${g.target}へ (あと${left}mほど)` };
    }
    const pos = g.pos || pl.pos;
    const d = pos ? dist3(here, pos) : 1e6;
    return { met: d <= this.cfg.arriveDist, d, text: `${g.target}へ行く (${pos ? relDir(here, pos) : '場所が分からない'})` };
  }

  planText() {
    const g = this.goal;
    if (!g) return '';
    const head = `ゴール: ${goalText(g)}${g.why ? ` (${g.why})` : ''}`;
    if (g.metAt != null) return `${head} / ${g.kind === 'item' ? '手に入れた' : g.kind === 'person' ? (g.give ? '渡した' : '近くにいる') : '着いた'}`;
    if (g.kind === 'item') return this.path && this.path.ok ? `${head} / ${pathText(this.path, { maxShown: this.cfg.maxShown })}` : head;
    return g.statusText ? `${head} / 次: ${g.statusText}` : head;
  }

  // ---- ゴールを決める ----
  async newGoal(ctx, tick, reason = 'start') {
    const cands = this.candidates(ctx);
    const feedback = [];
    const giveItems = [...new Set(((ctx.raw && ctx.raw.inventory) || []).map((i) => i.name))];
    for (let tryN = 0; tryN < this.cfg.maxTries; tryN++) {
      const rec = await this.ask2B(this.messages(ctx, cands, feedback), goalSchema(cands, { giveItems }));
      const pg = rec.rawOutput ? parseGoal(rec.rawOutput, cands, { whyMax: this.cfg.whyMax }) : null;
      this.addMeter(rec, !!pg);
      const needAt = pg && pg.need && ctx.needNow ? Math.round(ctx.needNow(pg.need) * 1000) / 1000 : null;
      const base = { tick, reason, try: tryN, goalKind: pg ? pg.kind : null, target: pg ? pg.target : null, count: pg ? pg.count : null, give: pg ? pg.give : null,
        why: pg ? pg.why : null, need: pg ? pg.need : null, needAt, kindFixed: pg ? pg.kindFixed : null, worst: ctx.worst ? ctx.worst.need : null, worstText: ctx.worst ? ctx.worst.text : null,
        candidates: { items: cands.items.length, people: cands.people.length, places: cands.places.length }, ...rec };
      if (!pg) { this.counts.failed += 1; this.log({ kind: 'goal', ok: false, ...base }); this.retryAt = tick + this.cfg.retryAfter; return false; }
      let path = null;
      if (pg.kind === 'item') {
        path = this.planItem(ctx, pg.target, pg.count);
        if (!path.ok) {
          this.counts.unplannable += 1;
          this.log({ kind: 'unplannable', ok: false, ...base, missing: path.missing || null });
          this.history.push({ ...pg, result: 'unplannable', resultText: '作り方も手に入れ方も分からなかった', from: tick, to: tick });
          feedback.push(`${goalText(pg)}: ${path.missing && path.missing !== pg.target ? `${path.missing} の` : ''}作り方も手に入れ方も分からなかった`);
          continue;
        }
      }
      this.counts.goals += 1;
      const here = ctx.raw.self.pos;
      this.goal = { ...pg, needAt, setAt: tick, n: this.counts.goals, startPos: { x: here.x, y: here.y, z: here.z }, pos: pg.place ? pg.place.pos || null : null, metAt: null, best: Infinity, bestAt: tick };
      this.path = path;
      this.troubleRun = 0;
      this.log({ kind: 'goal', ok: true, ...base, path: path ? this.pathRecord(path) : null });
      return true;
    }
    this.retryAt = tick + this.cfg.retryAfter;
    return false;
  }

  pathRecord(p) {
    if (!p) return null;
    return { ok: p.ok, steps: (p.steps || []).map((s) => ({ item: s.item, count: s.count, how: s.how, from: s.from || null, where: s.where || null })), next: p.next ? p.next.item : null };
  }

  finish(result, tick, why, extra = {}) {
    const g = this.goal;
    const resultText = { done: '達成した', need_unmet: `手に入れた/着いたが、${NEED_LABEL[g.need] || ''}のつらさは変わらなかった`, stuck: `進まなかった (${why})`, unplannable: '作り方も手に入れ方も分からなくなった' }[result] || result;
    const h = { kind: g.kind, target: g.target, count: g.count, give: g.give, why: g.why, need: g.need, result, resultText, from: g.setAt, to: tick };
    this.history.push(h);
    if (result === 'done') this.counts.done += 1;
    else if (result === 'need_unmet') this.counts.needUnmet += 1;
    else if (result === 'stuck') this.counts.stuck += 1;
    this.log({ ...h, kind: result === 'done' ? 'goal_done' : 'reselect', goalKind: g.kind, result, tick, reason: why || null, needAt: g.needAt ?? null, ...extra });
    this.goal = null; this.path = null; this.lastNextKey = null;
  }

  needCheck(ctx) {
    const g = this.goal;
    if (!g || !g.need || !ctx.needNow || g.needAt == null) return { met: true, now: null };
    const now = Math.round(ctx.needNow(g.need) * 1000) / 1000;
    return { met: now <= g.needAt - this.cfg.needDrop || now <= this.cfg.needLow, now };
  }

  // 毎判断の前に呼ぶ。返り値: 何が起きたか (記録用) | null
  async update(ctx, tick, { troubles = [] } = {}) {
    this.troubleRun = troubles.length ? this.troubleRun + 1 : 0;
    if (!this.goal) {
      if (tick < this.retryAt) return null;
      await this.newGoal(ctx, tick, this.history.length ? 'after' : 'start');
      if (this.goal) this.refresh(ctx, tick);
      return 'goal';
    }
    const st = this.refresh(ctx, tick);
    const g = this.goal;
    if (g.metAt != null) {
      const nc = this.needCheck(ctx);
      if (nc.met) { this.finish('done', tick, null, { needNow: nc.now }); await this.newGoal(ctx, tick, 'done'); this.refresh(ctx, tick); return 'goal_done'; }
      if (tick - g.metAt < this.cfg.needWait) return null;
      this.finish('need_unmet', tick, null, { needNow: nc.now });
      await this.newGoal(ctx, tick, 'need_unmet'); this.refresh(ctx, tick);
      return 'need_unmet';
    }
    if (g.kind === 'item' && this.path && !this.path.ok) {
      this.finish('unplannable', tick, this.path.missing || null);
      await this.newGoal(ctx, tick, 'unplannable'); this.refresh(ctx, tick);
      return 'unplannable';
    }
    if (st.d < g.best - 1e-9) { g.best = st.d; g.bestAt = tick; }
    const stuckTrouble = this.troubleRun >= this.cfg.troubleTicks;
    const stuckLong = tick - g.bestAt >= this.cfg.patience;
    if (!stuckTrouble && !stuckLong) return null;
    const why = stuckTrouble ? `困りごとが${this.troubleRun}判断続いた: ${troubles.map((t) => t.about).join(' / ')}`
      : g.kind === 'item' ? `${tick - g.bestAt}判断、道筋が縮まなかった` : `${tick - g.bestAt}判断、近づかなかった`;
    this.finish('stuck', tick, why, { next: this.path && this.path.next ? this.path.next.item : null });
    this.troubleRun = 0;
    await this.newGoal(ctx, tick, 'stuck'); this.refresh(ctx, tick);
    return 'stuck';
  }

  // 道筋 (物) / 次 (人・場所) を今の様子で作り直す。道筋の次の物が変わったら記録する
  refresh(ctx, tick) {
    const g = this.goal;
    if (!g) return { met: false, d: Infinity };
    if (g.kind === 'item' && g.metAt == null) {
      this.path = this.planItem(ctx, g.target, Math.max(0, g.count));
      const key = this.path.ok ? `${this.path.next ? this.path.next.item : '-'}|${this.path.steps.length}` : 'x';
      if (key !== this.lastNextKey) {
        this.lastNextKey = key;
        this.log({ kind: 'path', tick, goal: goalText(g), ...this.pathRecord(this.path), text: pathText(this.path, { maxShown: this.cfg.maxShown }) });
      }
    }
    const st = this.targetStatus(ctx);
    g.statusText = st.text || null;
    // 済んだ (物を持った・人の近く・着いた) ら、そのあとは済んだまま (置いて持ち物から消えても)
    if (st.met && g.metAt == null) { g.metAt = tick; this.log({ kind: 'reached', tick, goal: goalText(g), took: tick - g.setAt }); }
    return st;
  }
}

module.exports = { GoalPath, DEFAULTS, goalSchema, parseGoal, goalText, KINDS, KIND_JA };
