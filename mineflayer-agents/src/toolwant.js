'use strict';
// 使う側の不満と声 (2026-11-07 ユーザー決定「使う側の声から刺激を生む」)。bot に依存しない部品 (つなぎは agent.js)。
//   1. 不満 (欲求): 自分の作業のやりにくさを、物ごと (stone_axe・stone_pickaxe・iron_hoe …) の数値 v で持つ。
//      - 掘るのに時間がかかった (collect の結果の道具と時間): 1段上・2段上の道具 x ごとに
//          v[x] += upW[k] × slowW × min(slowCap, 失った秒 / slowRef)、失った秒 = 掘った秒 × (1 − 今の速さ / x の速さ) (仕様の速さ)
//      - 素手で取れなかった (石。ツルハシが無い): v[1段上] += cantW、v[2段上] += cantW × upW[1]
//      - 道具が壊れた: v[同じ物] += brokeW、v[1段上] += brokeW × upW[1] × (1 + 耐久の伸び)
//      - 耐久が少ない (いまの値。積まない): 持っている道具の残り frac < wornFrac なら worn[同じ物] = wornW × (1 − frac / wornFrac)
//      積んだ分は判断ごとに半減期 halfLife で薄れる。同じ種類で x 以上の段の (すり減っていない) 道具を手に入れたら 0 に戻す (満たされた)
//   2. 声に出す (3つの形。文は文を作る LLM が書く):
//      (a) 独り言 mutter (近くに人がいてもいなくても。近くの人には聞こえる)、(b) 近くの人に頼む near、(c) 全体チャットで頼む all
//      言い出しやすさのしきい値 θ (性格の表 TRAIT_VOICE。分業と同じ反応しきい値の形 T = d² / (d² + θ²)):
//        z = Σ w_k (2 × 性格_k − 1) / Σ |w_k|、θ = theta0 × (1 − traitScale × z)
//        近く: θ_near = θ × (1 − friendCut × 仲の良さ) × (1 + repeatMul × 同じ物を頼んだ回数 (薄れ))   (仲の良い人が近くに来た = タイミング)
//        全体: θ_all = θ × allMul × (1 + repeatMul × 回数)
//        独り言: p_mutter = m × T(d, θ × mutterTheta)、m = mutterBase × (1 + mutterScale × z_m) (よく話す人は persona.toolVoice.mutter で直接)
//      判断ごとに、近くに人がいれば p_near で頼む、だめなら p_all で全体に、だめなら p_mutter で独り言 (形ごとに間隔 gap)。
//   3. 自分で作る: 自分の不満は自分の刺激 (division の物単位の刺激) にもなる: selfW × (0.5 + greed) × v (greed が高いほど自分で作ろうとする)
// 研究方針: 数値はここで持ち、モデルには言葉 (事実) だけ。「○○を作れ」とは書かない。
const F = require('./toolfacts');

// ---- 性格 → 言い出しやすさの表 (w > 0: その性格が高いほど θ が下がる = 言い出しやすい) ----
//   論拠 (2026-11-07 ユーザー決定):
//   request (頼む):
//     sociability +0.6: 人に話しかけるのが平気な人は、小さな不満でも気兼ねなく頼む。低い人 (人見知り) は不満が大きくなるかタイミングを待つ
//     obedience   +0.3: 集団に合わせる・人を頼る傾向 (言われたことに従う人は、頼む/頼まれるのやりとりに抵抗が少ない)
//     greed       −0.3: 欲の強い人は人に頼まず自分で作ろうとする (頼む前に自分の刺激になる。下の selfW)
//   mutter (独り言の多さ。w > 0: 高いほど多い):
//     sociability −0.5: 人に言わない分を口の中で言う (人見知りは頼まずにつぶやく)
//     greed       +0.3: 自分の物・道具への不満を口にしやすい
//     obedience   −0.2: 従順な人は不満を飲み込みがち
const TRAIT_VOICE = {
  request: { sociability: 0.6, obedience: 0.3, greed: -0.3 },
  mutter: { sociability: -0.5, greed: 0.3, obedience: -0.2 },
};

const DEFAULTS = {
  enabled: true,
  halfLife: 40, keep: 200, // 判断の数
  slowW: 0.5, slowRef: 10, slowCap: 2, // 失った秒 / slowRef (上限 slowCap) × slowW
  cantW: 0.6, cantGap: 5, // 素手で取れなかった (同じ判断の続きは cantGap ごとに1回)
  brokeW: 0.8,
  upW: [1, 0.5], // 1段上・2段上
  wornW: 0.5, wornFrac: 0.3,
  vMax: 2, showMin: 0.15,
  voice: {
    enabled: true, minD: 0.15,
    theta0: 0.6, traitScale: 0.6, min: 0.1, max: 2, traits: TRAIT_VOICE.request,
    friendCut: 0.4, friendAff: 70, // 好感 friendAff で仲の良さ 1
    allMul: 1.8, repeatMul: 0.6, repeatHalfLife: 40,
    mutterBase: 0.25, mutterScale: 0.8, mutterTheta: 0.6, mutterTraits: TRAIT_VOICE.mutter,
    gap: { near: 6, all: 15, mutter: 5 }, // 同じ形を続けない判断の数
  },
  selfW: 0.4,
};

const r3 = (v) => Math.round(v * 1000) / 1000;
const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function merge(a, b) { if (!isObj(a) || !isObj(b)) return b === undefined ? a : b; const o = { ...a }; for (const [k, v] of Object.entries(b)) o[k] = merge(a[k], v); return o; }
const decay = (v, dt, half) => v * Math.pow(0.5, Math.max(0, dt) / half);
function response(s, theta) { if (!(s > 0)) return 0; return (s * s) / (s * s + theta * theta); }
function traitZ(traits, w) {
  const ws = Object.values(w).reduce((t, x) => t + Math.abs(x), 0) || 1;
  return Object.entries(w).reduce((t, [k, x]) => t + x * (2 * (traits[k] ?? 0.5) - 1), 0) / ws;
}

// 素材 mat のとき、欲しがる段 [{ mat, k }] (k = 0: 1段上、1: 2段上)
function upTiers(mat, n = 2) {
  const i = Math.max(0, F.LADDER.indexOf(mat === 'golden' ? 'wooden' : mat));
  return F.LADDER.slice(i + 1, i + 1 + n).map((m, k) => ({ mat: m, k }));
}

class ToolWant {
  constructor({ cfg = {}, temperament = {}, me = null, mutter = null, rng = Math.random } = {}) {
    this.cfg = merge(DEFAULTS, cfg || {});
    this.me = me;
    this.traits = { bravery: 0.5, empathy: 0.5, obedience: 0.5, greed: 0.5, sociability: 0.5, ...temperament };
    this.mutterOverride = Number.isFinite(mutter) ? mutter : null;
    this.rng = rng;
    this.acc = {}; // 物 → { v, t, slow, cant, broke } (積んだ分。t: 最後に薄れを当てた判断)
    this.worn = {}; // 物 → いまの値 (耐久が少ない)
    this.facts = {}; // 物 → [{ tick, kind, text, textEn }] (いちばん新しい数件)
    this.asked = {}; // 物 → { n, t } (頼んだ回数。薄れる)
    this.lastVoice = { near: -1e9, all: -1e9, mutter: -1e9 };
    this.lastCant = -1e9;
    this.broken = []; // 自分の道具が壊れた [{ tick, tool }]
    this.tick = 0;
    this.lastTools = [];
  }

  static fromJSON(d, opts = {}) {
    const x = new ToolWant(opts);
    if (isObj(d)) for (const k of ['acc', 'facts', 'asked', 'lastVoice', 'broken']) if (d[k] !== undefined) x[k] = d[k];
    if (isObj(d) && Number.isFinite(d.tick)) x.tick = d.tick;
    return x;
  }

  toJSON() { return { acc: this.acc, facts: this.facts, asked: this.asked, lastVoice: this.lastVoice, broken: this.broken.slice(-20), tick: this.tick }; }

  add(item, v, kind, fact, tick = this.tick) {
    if (!(v > 0) || !item) return;
    const a = this.acc[item] || (this.acc[item] = { v: 0, t: tick, slow: 0, cant: 0, broke: 0 });
    const dt = tick - a.t;
    const h = this.cfg.halfLife;
    a.v = decay(a.v, dt, h); a.slow = decay(a.slow, dt, h); a.cant = decay(a.cant, dt, h); a.broke = decay(a.broke, dt, h); a.t = tick;
    a.v = Math.min(this.cfg.vMax, a.v + v); a[kind] = (a[kind] || 0) + v;
    if (fact) {
      const fs = this.facts[item] || (this.facts[item] = []);
      if (!fs.length || fs[fs.length - 1].text !== fact.text) fs.push({ tick, kind, ...fact });
      if (fs.length > 4) fs.splice(0, fs.length - 4);
    }
  }

  // collect の結果: block を tools ('hand' か道具の名前) で n 個掘るのに digMs かかった
  noteDig({ block, tools = [], digMs = 0, n = 1, tick = this.tick } = {}) {
    const task = F.taskOfBlock(block);
    if (!task || !(digMs > 0)) return [];
    const type = F.TASKS[task].tool;
    const mats = (tools.length ? tools : ['hand']).map((t) => F.toolMat(t === 'hand' ? null : t, task));
    const mat = mats.sort((a, b) => F.rank(b) - F.rank(a))[0];
    const c = this.cfg;
    const sec = digMs / 1000;
    const out = [];
    for (const { mat: m, k } of upTiers(mat)) {
      const x = `${m}_${type}`;
      const lost = sec * F.speedGain(mat, m);
      const v = (c.upW[k] ?? 0) * c.slowW * Math.min(c.slowCap, lost / c.slowRef);
      const used = mat === 'hand' ? '素手' : `${mat}_${type}`;
      const usedEn = mat === 'hand' ? 'bare hands' : `${mat}_${type}`;
      this.add(x, v, 'slow', { text: `${block}を${used}で${n}個掘るのに${Math.max(1, Math.round(sec))}秒かかった`, textEn: `took ${Math.max(1, Math.round(sec))} s to dig ${n} ${block} with ${usedEn}` }, tick);
      out.push({ item: x, v: r3(v) });
    }
    return out;
  }

  // 石など、道具が無いと何も落ちないブロックを取れなかった (持っているのはその種類の held の道具か素手)
  noteCantHarvest({ block = 'stone', have = null, tick = this.tick } = {}) {
    if (tick - this.lastCant < this.cfg.cantGap) return [];
    const task = F.taskOfBlock(block) || 'mining';
    const type = F.TASKS[task].tool;
    const mat = have ? F.toolMat(have, task) : 'hand';
    this.lastCant = tick;
    const out = [];
    for (const { mat: m, k } of upTiers(mat)) {
      const v = this.cfg.cantW * (this.cfg.upW[k] ?? 0);
      this.add(`${m}_${type}`, v, 'cant', { text: `${block}を${mat === 'hand' ? '素手' : `${mat}_${type}`}では取れなかった`, textEn: `could not get ${block} with ${mat === 'hand' ? 'bare hands' : `${mat}_${type}`}` }, tick);
      out.push({ item: `${m}_${type}`, v: r3(v) });
    }
    return out;
  }

  // 自分の道具が壊れた
  noteBroke({ tool, tick = this.tick } = {}) {
    const i = F.toolInfo(tool); if (!i) return [];
    this.broken.push({ tick, tool });
    const c = this.cfg;
    const n = this.broken.filter((b) => b.tool === tool).length;
    const fact = { text: `${tool}が壊れた${n > 1 ? ` (${n}回目)` : ''}`, textEn: `my ${tool} broke${n > 1 ? ` (${n} times so far)` : ''}` };
    this.add(tool, c.brokeW, 'broke', fact, tick);
    const out = [{ item: tool, v: c.brokeW }];
    const up = upTiers(i.mat, 1)[0];
    if (up) {
      const x = `${up.mat}_${i.type}`;
      const v = c.brokeW * (c.upW[1] ?? 0) * (1 + F.durGain(i.mat, up.mat));
      this.add(x, v, 'broke', fact, tick);
      out.push({ item: x, v: r3(v) });
    }
    return out;
  }

  // 判断ごと: tools = 持っている道具の耐久 (toolfacts.toolsOfItems)。満たされた物は 0 に戻す。耐久の少ない道具は worn に
  //   返り値 { satisfied: [{ item, by, v }] }
  update({ tick = this.tick + 1, tools = [] } = {}) {
    this.tick = tick;
    this.lastTools = tools;
    const c = this.cfg;
    // 薄れ
    for (const [x, a] of Object.entries(this.acc)) {
      const dt = tick - a.t;
      a.v = decay(a.v, dt, c.halfLife); a.slow = decay(a.slow || 0, dt, c.halfLife); a.cant = decay(a.cant || 0, dt, c.halfLife); a.broke = decay(a.broke || 0, dt, c.halfLife); a.t = tick;
      if (a.v < 0.01) { delete this.acc[x]; delete this.facts[x]; }
    }
    // 満たされた: 同じ種類で x 以上の段の、すり減っていない道具がある
    const satisfied = [];
    for (const x of Object.keys(this.acc)) {
      const i = F.toolInfo(x); if (!i) continue;
      const by = tools.find((t) => { const j = F.toolInfo(t.name); return j && j.type === i.type && F.rank(j.mat) >= F.rank(i.mat) && t.frac >= c.wornFrac; });
      if (by) { satisfied.push({ item: x, by: by.name, v: r3(this.acc[x].v) }); delete this.acc[x]; delete this.facts[x]; delete this.asked[x]; }
    }
    // 耐久が少ない (種類ごとに、いちばん上の段の道具だけ見る。予備 = 同じ種類のほかの道具があれば数えない)
    this.worn = {};
    const byType = {};
    for (const t of tools) { const i = F.toolInfo(t.name); if (!i) continue; (byType[i.type] || (byType[i.type] = [])).push({ ...t, mat: i.mat }); }
    for (const [, ts] of Object.entries(byType)) {
      const best = ts.slice().sort((a, b) => F.rank(b.mat) - F.rank(a.mat) || b.frac - a.frac)[0];
      if (ts.length > 1) continue;
      if (best.frac < c.wornFrac) {
        this.worn[best.name] = r3(c.wornW * (1 - best.frac / c.wornFrac));
        const fs = this.facts[best.name] || (this.facts[best.name] = []);
        const text = `持っている${best.name}の耐久が残り${Math.max(1, Math.round(best.frac * 10))}割ほど (あと${best.left}回)`;
        const old = fs.findIndex((f) => f.kind === 'worn');
        if (old >= 0) fs.splice(old, 1);
        fs.push({ tick, kind: 'worn', text, textEn: `the ${best.name} I have has about ${best.left} uses left` });
      }
    }
    return { satisfied };
  }

  // 物ごとの不満 [{ item, v, acc, worn, why }] (多い順)
  wants() {
    const items = new Set([...Object.keys(this.acc), ...Object.keys(this.worn)]);
    return [...items].map((x) => {
      const a = this.acc[x] || { v: 0, slow: 0, cant: 0, broke: 0 };
      const w = this.worn[x] || 0;
      return { item: x, v: r3(Math.min(this.cfg.vMax, a.v + w)), acc: r3(a.v), worn: w, why: { slow: r3(a.slow || 0), cant: r3(a.cant || 0), broke: r3(a.broke || 0), worn: w } };
    }).filter((x) => x.v > 0).sort((p, q) => q.v - p.v);
  }

  top() { return this.wants()[0] || null; }
  total() { return r3(this.wants().reduce((t, x) => Math.max(t, x.v), 0)); }

  // 自分の刺激 (division の物単位): selfW × (0.5 + greed) × v
  selfStimulus() {
    const k = this.cfg.selfW * (0.5 + (this.traits.greed ?? 0.5));
    return Object.fromEntries(this.wants().map((x) => [x.item, r3(k * x.v)]));
  }

  // ---- 言い出しやすさ ----
  thetaBase() {
    const vc = this.cfg.voice;
    return clamp(vc.theta0 * (1 - vc.traitScale * traitZ(this.traits, vc.traits)), vc.min, vc.max);
  }

  mutterRate() {
    if (this.mutterOverride != null) return clamp(this.mutterOverride);
    const vc = this.cfg.voice;
    return clamp(vc.mutterBase * (1 + vc.mutterScale * traitZ(this.traits, vc.mutterTraits)));
  }

  askedN(item, tick = this.tick) { const a = this.asked[item]; return a ? decay(a.n, tick - a.t, this.cfg.voice.repeatHalfLife) : 0; }

  // 声に出すか。near = [{ name, affinity }] (声の届く近くの人)。返り値 { form: 'near'|'all'|'mutter'|null, item, d, theta, p, ... }
  decide({ tick = this.tick, near = [], canAll = true, rng = this.rng } = {}) {
    const vc = this.cfg.voice;
    const top = this.top();
    if (!vc.enabled || !top || top.v < vc.minD) return { form: null, item: top ? top.item : null, d: top ? top.v : 0 };
    const d = top.v;
    const th = this.thetaBase();
    const rep = 1 + vc.repeatMul * this.askedN(top.item, tick);
    const close = near.length ? Math.max(...near.map((p) => clamp(((p.affinity ?? 50) - 50) / (vc.friendAff - 50)))) : 0;
    const thNear = th * (1 - vc.friendCut * close) * rep;
    const thAll = th * vc.allMul * rep;
    const thMut = th * vc.mutterTheta;
    const m = this.mutterRate();
    const p = { near: near.length ? r3(response(d, thNear)) : 0, all: canAll ? r3(response(d, thAll)) : 0, mutter: r3(m * response(d, thMut)) };
    const gapOk = (f) => tick - (this.lastVoice[f] ?? -1e9) >= vc.gap[f];
    const draws = {};
    let form = null;
    for (const f of ['near', 'all', 'mutter']) {
      if (!p[f] || !gapOk(f)) continue;
      draws[f] = r3(rng());
      if (draws[f] < p[f]) { form = f; break; }
    }
    const theta = { base: r3(th), near: r3(thNear), all: r3(thAll), mutter: r3(thMut) };
    return { form, item: top.item, d, theta, p, mutterRate: r3(m), close: r3(close), repeat: r3(rep), draws, to: form === 'near' ? near.map((x) => x.name) : [] };
  }

  // 声に出した (頼んだ回数を数え、間隔を始める)
  noteVoiced(form, item, tick = this.tick) {
    this.lastVoice[form] = tick;
    if (form === 'near' || form === 'all') {
      const n = this.askedN(item, tick);
      this.asked[item] = { n: n + 1, t: tick };
    }
  }

  // 文を作る LLM に渡す事実 (日本語)。仕様の事実と自分の作業の事実だけ
  factsText(item, lang = 'ja') {
    const en = lang === 'en';
    const fs = (this.facts[item] || []).slice(-3).map((f) => (en ? f.textEn : f.text));
    const i = F.toolInfo(item);
    const have = (this.lastTools || []).filter((t) => { const j = F.toolInfo(t.name); return j && i && j.type === i.type; }).map((t) => `${t.name} (${en ? `${t.left} uses left` : `耐久 残り${t.left}回`})`);
    const lines = [...fs];
    lines.push(have.length ? (en ? `I have: ${have.join(', ')}` : `持っている${F.TYPE_JA[i.type]}: ${have.join('・')}`) : (en ? `I have no ${F.TYPE_EN[i.type]}` : `${F.TYPE_JA[i.type]}を持っていない`));
    const spec = F.specText(item, lang);
    if (spec) lines.push(en ? `spec: ${spec}` : `仕様: ${spec}`);
    return lines.join(en ? '; ' : '。');
  }

  // 体と心の言葉に足す (事実 + 欲しい)。showMin 以上の上位1つ
  words({ lang = 'ja' } = {}) {
    const t = this.top();
    if (!t || t.v < this.cfg.showMin) return '';
    const f = (this.facts[t.item] || []).slice(-1)[0];
    if (lang === 'en') return `want a ${t.item}${f ? ` (${f.textEn})` : ''}`;
    return `${t.item} (${F.itemJa(t.item)}) が欲しい${f ? ` (${f.text})` : ''}`;
  }

  snapshot() {
    const ws = this.wants();
    return { d: ws.length ? ws[0].v : 0, top: ws.length ? ws[0].item : null, wants: Object.fromEntries(ws.slice(0, 4).map((x) => [x.item, x.v])) };
  }
}

module.exports = { ToolWant, DEFAULTS, TRAIT_VOICE, upTiers, traitZ, response };
