'use strict';
// 振り返りと方針の層 (cfg.reflect)。PDCA のように、ときどき自分の暮らしを振り返らせ、2B に方針 (長く続けたいこと) を書かせる。
//   いつ: ゲーム内の1日の終わり (夕方に入ったとき)・寝る前 (夜に寝られるようになったとき)・死んだあと・ゴールを afterGoals 個済ませた/捨てたあと。
//     前の振り返りから minGap 判断たたないうちは振り返らない。
//   材料: プログラムが記録から数えた事実だけ (factsSince)。何に時間がかかったか・どれだけ歩いたか・死んだ・食べた・寝た・
//     ゴールの結果 (済んだ/捨てた・かかった判断数)・人とのこと (一緒にいた・もらった・あげた・言われた)・続けて失敗したこと。
//   出力: 2B が JSON {policy, why} (方針 1〜2行 + 何のため)。方針はゴールを選ぶ材料として 2B (goalpath.js) に、Jev の state.policy にも短く出す。
//   記録: event 'reflect' (理由・事実・方針・前の方針・トークン)。
// 研究方針: 評価語・使い方の誘導は書かない (事実を並べるだけ)。数値はここで持つ (モデルには数えた結果の言葉だけ)。
const { LLMDecider } = require('./deciders/llm');
const { NEED_LABEL } = require('./needs');
const { dist3 } = require('./util');

const DEFAULTS = {
  enabled: true,
  onDayEnd: true, onSleep: true, onDeath: true,
  afterGoals: 3, // ゴールを何個済ませた/捨てたら振り返るか (0 で使わない)
  minGap: 10, // 前の振り返りから最低この判断数あける
  maxFacts: 12,
  maxTokens: 160, temperature: 0.5,
  policyMax: 80, whyMax: 40,
  nearDist: 8, // 一緒にいた (この距離以内)
  stateMax: 80, // Jev の state.policy の長さ
};
const NEED_WORD = { hunger: '空腹', sleep: '眠気', safety: '安心', connection: 'つながり', recognition: '認められたい', curiosity: '好奇心', greed: '物が欲しい', care: '人の役に立ちたい' };
const RESULT_JA = { done: '達成した', need_unmet: '手に入れた/着いたが、つらさは変わらなかった', stuck: '進まなかったのでやめた', unplannable: '手に入れ方が分からなかった' };

const gameT = (day, tod) => (Number.isFinite(day) && Number.isFinite(tod) ? day * 24000 + tod : null);
const minutesText = (m) => (m < 1 ? '1分足らず' : `約${Math.round(m)}分`);

function parseJson(text) {
  try { const s = String(text); return JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)); } catch (_) { return null; }
}

function deathWho(cause) {
  const m = String(cause || '').match(/^death\.attack\.([a-zA-Z]+)/);
  if (m) return m[1] === 'player' ? '人' : m[1];
  const k = String(cause || '').replace(/^death\./, '');
  return { fell: '落ちて', 'fell.accident.generic': '落ちて', drown: '溺れて', inFire: '火で', onFire: '燃えて', lava: '溶岩で', starve: '飢えて' }[k] || null;
}

class Reflect {
  constructor(opts = {}) {
    this.cfg = { ...DEFAULTS, ...(opts.cfg || {}) };
    this.llm = opts.llm || new LLMDecider({ ...(opts.llmOpts || {}), mode: 'talk', maxTokens: this.cfg.maxTokens, temperature: this.cfg.temperature });
    this.meter = opts.meter || null;
    this.log = opts.log || (() => {});
    this.steps = []; // [{ tick, ms, t (ゲームの時刻), pos, action, arg, ok, goal, need, near: [名前] }]
    this.events = []; // [{ kind: death|received|gave|heard|goal, tick, ... }]
    this.lastAt = { tick: -1e9, step: 0, event: 0 };
    this.pending = null; // 死んだ → 次の判断で振り返る
    this.policy = null; // { text, why, tick, reason }
    this.history = [];
    this.prevTod = null;
    this.sleptNight = null; // 寝る前の振り返りをした夜 (day)
    this.count = 0;
  }

  // ---- 記録 ----
  note(s) { this.steps.push({ ms: Date.now(), ...s }); if (this.steps.length > 4000) this.steps.splice(0, 1000), this.lastAt.step = Math.max(0, this.lastAt.step - 1000); }

  noteEvent(e) {
    this.events.push({ ms: Date.now(), ...e });
    if (e.kind === 'death' && this.cfg.onDeath) this.pending = 'death';
    if (this.events.length > 2000) { this.events.splice(0, 500); this.lastAt.event = Math.max(0, this.lastAt.event - 500); }
  }

  // goalpath.js の log をそのまま受ける (済んだ・選び直し・たどれない)
  noteGoal(e) {
    if (!e || !['goal_done', 'reselect', 'unplannable'].includes(e.kind)) return;
    this.noteEvent({ kind: 'goal', tick: e.tick, target: e.target, goalKind: e.goalKind, count: e.count, need: e.need, result: e.kind === 'unplannable' ? 'unplannable' : e.result, took: e.from != null && e.to != null ? e.to - e.from : null, reason: e.reason || null });
  }

  // ---- いつ振り返るか ----
  // now = { tick, timeOfDay, day, canSleep (今寝られる) }。返り値: 理由 | null
  due(now) {
    const c = this.cfg;
    if (c.enabled === false) return null;
    const tod = ((now.timeOfDay ?? 6000) % 24000 + 24000) % 24000;
    const prev = this.prevTod;
    this.prevTod = tod;
    if (now.tick - this.lastAt.tick < c.minGap) return null;
    if (this.pending) return this.pending;
    if (c.onSleep && now.canSleep && this.sleptNight !== now.day) { this.sleptNight = now.day; return 'before_sleep'; }
    if (c.onDayEnd && prev != null && prev < 12000 && tod >= 12000 && tod < 13000 + 1000) return 'day_end';
    if (c.afterGoals > 0) {
      const g = this.events.slice(this.lastAt.event).filter((e) => e.kind === 'goal').length;
      if (g >= c.afterGoals) return 'goals';
    }
    return null;
  }

  // ---- 材料: 前の振り返りから今までに記録から数えたこと ----
  factsSince() {
    const st = this.steps.slice(this.lastAt.step);
    const ev = this.events.slice(this.lastAt.event);
    const out = [];
    if (!st.length && !ev.length) return out;
    // 時間: ゲームの時刻があればそれで、なければ実時間で (分)
    const dtMin = (a, b) => {
      const ta = gameT(a.day, a.timeOfDay); const tb = gameT(b.day, b.timeOfDay);
      return ta != null && tb != null && tb >= ta ? (tb - ta) / 1200 : (b.ms - a.ms) / 60000;
    };
    if (st.length >= 2) out.push(`前に振り返ってから${minutesText(dtMin(st[0], st[st.length - 1]))}、判断${st.length}回`);
    // 欲求ごとに、そのためのゴールに使った時間と、ゴールごとに歩いた距離
    const byNeed = {}; const walk = {};
    for (let i = 1; i < st.length; i++) {
      const a = st[i - 1]; const b = st[i];
      if (a.goal && a.need) { const k = a.need; byNeed[k] = byNeed[k] || { m: 0, targets: new Set() }; byNeed[k].m += dtMin(a, b); byNeed[k].targets.add(a.goal); }
      if (a.goal && a.pos && b.pos) walk[a.goal] = (walk[a.goal] || 0) + dist3(a.pos, b.pos);
    }
    for (const [k, v] of Object.entries(byNeed).sort((x, y) => y[1].m - x[1].m).slice(0, 3)) {
      out.push(`ゴール (${[...v.targets].slice(0, 3).join('・')}、need: ${NEED_WORD[k] || NEED_LABEL[k] || k}) に${minutesText(v.m)}かかった`);
    }
    for (const [g, m] of Object.entries(walk).sort((x, y) => y[1] - x[1]).slice(0, 2)) if (m >= 20) out.push(`${g} をめざして${Math.round(m)}m歩いた`);
    // 死んだ
    const deaths = ev.filter((e) => e.kind === 'death');
    if (deaths.length) {
      const night = deaths.filter((d) => { const t = ((d.timeOfDay ?? 6000) % 24000 + 24000) % 24000; return t >= 13000 && t < 23000; }).length;
      const who = [...new Set(deaths.map((d) => deathWho(d.cause)).filter(Boolean))];
      out.push(`${night === deaths.length ? '夜に' : night ? `(うち夜に${night}回) ` : '昼に'}${deaths.length}回死んだ${who.length ? ` (${who.join('・')})` : ''}`);
    }
    // 食べた・寝た
    const ate = st.filter((s) => s.action === 'eat' && s.ok);
    const ateBy = {}; for (const s of ate) ateBy[s.arg] = (ateBy[s.arg] || 0) + 1;
    out.push(ate.length ? `${ate.length}回食べた (${Object.entries(ateBy).map(([k, v]) => `${k}${v > 1 ? ` ${v}回` : ''}`).join('・')})` : '何も食べなかった');
    const slept = st.filter((s) => s.action === 'sleep' && s.ok).length;
    out.push(slept ? `${slept}回寝た` : '寝なかった');
    // ゴールの結果
    const goals = ev.filter((e) => e.kind === 'goal');
    if (goals.length) {
      const cnt = {}; for (const g of goals) cnt[g.result] = (cnt[g.result] || 0) + 1;
      out.push(`ゴール ${goals.length}個: ${Object.entries(cnt).map(([k, v]) => `${RESULT_JA[k] || k} ${v}`).join('・')}`);
      for (const g of goals.slice(-3)) out.push(`ゴール ${g.target}${g.count && g.goalKind === 'item' ? ` ${g.count}` : ''}: ${RESULT_JA[g.result] || g.result}${g.took != null ? ` (${g.took}判断)` : ''}`);
    }
    // 続けて失敗したこと
    const fails = {}; for (const s of st.filter((x) => !x.ok && x.action)) { const k = `${s.action}${s.arg ? `(${s.arg})` : ''}`; fails[k] = (fails[k] || 0) + 1; }
    for (const [k, v] of Object.entries(fails).filter(([, v]) => v >= 3).sort((a, b) => b[1] - a[1]).slice(0, 2)) out.push(`${k} が${v}回うまくいかなかった`);
    // 人とのこと
    const near = {}; for (const s of st) for (const n of s.near || []) near[n] = (near[n] || 0) + 1;
    const nearL = Object.entries(near).sort((a, b) => b[1] - a[1]).slice(0, 3);
    out.push(nearL.length ? `近くにいた人: ${nearL.map(([n, v]) => `${n} (判断${v}回)`).join('・')}` : 'ほとんどひとりでいた');
    for (const e of ev.filter((x) => x.kind === 'received').slice(-2)) out.push(`${e.from} から ${e.item} を${e.count || 1}個もらった`);
    for (const e of ev.filter((x) => x.kind === 'gave').slice(-2)) out.push(`${e.to} に ${e.item} を${e.count || 1}個あげた`);
    for (const e of ev.filter((x) => x.kind === 'heard').slice(-2)) out.push(`${e.from} に「${String(e.text).slice(0, 30)}」と言われた`);
    return out.slice(0, this.cfg.maxFacts);
  }

  messages(ctx, facts) {
    const p = ctx.persona || {};
    const sys = [
      `あなたは Minecraft の世界にいる「${p.name}」。${p.personality || ''}`,
      'これまでの自分の暮らしを振り返り、これから長く続けたいこと (方針) を1〜2行で書く。why にはそれが何のためかを書く。',
      'JSON {"policy":"...","why":"..."} だけを出力する。',
    ];
    const user = [
      `## 振り返ること (${{ day_end: '1日が終わる', before_sleep: '寝る前', death: '死んだあと', goals: 'ゴールをいくつか終えた' }[ctx.reason] || ctx.reason})`,
      facts.map((f) => `- ${f}`).join('\n'),
      ctx.socialText ? `## 今の体と心\n${ctx.socialText}` : '',
      `## 前の方針\n${this.policy ? `${this.policy.text}${this.policy.why ? ` (何のため: ${this.policy.why})` : ''}` : 'まだない'}`,
      '方針を JSON で。',
    ];
    return [{ role: 'system', content: sys.join('\n') }, { role: 'user', content: user.filter(Boolean).join('\n') }];
  }

  schema() {
    return { type: 'object', properties: { policy: { type: 'string', maxLength: this.cfg.policyMax }, why: { type: 'string', maxLength: this.cfg.whyMax } }, required: ['policy', 'why'], additionalProperties: false };
  }

  // 振り返る。返り値: 新しい方針 | null
  async run(ctx, tick, reason) {
    const facts = this.factsSince();
    const messages = this.messages({ ...ctx, reason }, facts);
    const promptChars = messages.reduce((s, m) => s + m.content.length, 0);
    const t0 = Date.now();
    let r = null; let error = null;
    try { r = await this.llm.complete(messages, this.schema()); } catch (e) { error = e.message; }
    const o = r ? parseJson(r.text) : null;
    const text = o && typeof o.policy === 'string' ? o.policy.trim().slice(0, this.cfg.policyMax) : '';
    const why = o && typeof o.why === 'string' ? o.why.trim().slice(0, this.cfg.whyMax) : '';
    const ok = !!text;
    if (this.meter) this.meter.addTwoB({ kind: 'reflect', promptChars, promptTokens: r ? r.promptTokens : null, completionTokens: r ? r.completionTokens : null, ms: Date.now() - t0, error: error || (ok ? null : 'parse') });
    const prev = this.policy;
    if (ok) this.policy = { text, why: why || null, tick, reason };
    this.count += 1;
    const rec = { tick, reason, ok, facts, policy: ok ? text : null, why: ok ? why || null : null, prevPolicy: prev ? prev.text : null, promptChars,
      promptTokens: r ? r.promptTokens : null, completionTokens: r ? r.completionTokens : null, ms: Date.now() - t0, error, rawOutput: r ? r.text : null };
    if (this.count === 1) rec.prompt = messages;
    this.log(rec);
    this.history.push({ tick, reason, policy: rec.policy, why: rec.why });
    this.lastAt = { tick, step: this.steps.length, event: this.events.length };
    this.pending = null;
    return ok ? this.policy : null;
  }

  // 2B (ゴール選び) に見せる文・Jev の state.policy に出す短い文
  policyText() { return this.policy ? `${this.policy.text}${this.policy.why ? ` (何のため: ${this.policy.why})` : ''}` : ''; }

  stateText() { return this.policy ? this.policy.text.slice(0, this.cfg.stateMax) : ''; }
}

module.exports = { Reflect, DEFAULTS, deathWho };
