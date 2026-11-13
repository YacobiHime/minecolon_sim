'use strict';
// 社会性の最小限 (方針メモ 15章): 感情・欲求・人間関係を、プログラムが数値で持つ。
// 更新はルールか Jev の Score (relationScore)。2B には words() の短い日本語だけを渡す。
//
// AgentSociety (arXiv:2502.08691) の部品を基準にした。変えたところは README の「社会性」に書いた。
//   感情: 6種類の基本感情 0〜10 (AgentSociety と同じ)。ルールで上下し、時間で基準値へ戻る。
//   欲求とストレス: needs.js (人としての欲求。ゲームの満腹度とは切り離し、時間と出来事で変わる)。
//     ストレスが高いと、性格に合わせて怒り (いらいら)・悲しみ (落ち込み)・恐れ (怖さ) が上がる。
//   人間関係: 相手ごとの好感 0〜100 (AgentSociety の関係の強さと同じ幅)・信頼 0〜1・出来事の回数とひとこと。
// 気質は研究室の personas.js の temperament (bravery・empathy・obedience・greed・sociability、0〜1) の形を借りる。

const EMOTIONS = ['joy', 'sadness', 'anger', 'fear', 'disgust', 'surprise'];
const EMO_BASE = { joy: 3, sadness: 1, anger: 0, fear: 1, disgust: 0, surprise: 0 };
const EMO_WORD = {
  joy: ['少しうれしい', 'うれしい', 'とてもうれしい'],
  sadness: ['少し落ち込んでいる', '落ち込んでいる', 'とても落ち込んでいる'],
  anger: ['少しいらだっている', 'いらだっている', 'かなり怒っている'],
  fear: ['少し不安', '不安', 'とても怖い'],
  disgust: ['少しうんざりしている', 'うんざりしている', 'ひどくうんざりしている'],
  surprise: ['少し驚いている', '驚いている', 'とても驚いている'],
};
const EMO_WORD_EN = {
  joy: ['a little glad', 'glad', 'very glad'],
  sadness: ['a little down', 'down', 'very down'],
  anger: ['a little irritated', 'irritated', 'quite angry'],
  fear: ['a little anxious', 'anxious', 'very scared'],
  disgust: ['a little fed up', 'fed up', 'thoroughly fed up'],
  surprise: ['a little surprised', 'surprised', 'very surprised'],
};
// 関係のメモ (r.note) の英語
const NOTE_EN = { 前に物をあげた: 'I gave them something before', 前に物をくれた: 'they gave me something before', 前にやり方を教えてくれた: 'they taught me how to do something before',
  聞いたが知らなかった: 'I asked them but they did not know', 聞いたのに返事がなかった: 'I asked them but got no answer',
  前に物を取られた: 'they took something of mine before', 取った物を返してくれた: 'they made up for taking something of mine', 人の物を取ったと聞いた: 'I heard they took other people\'s things' };
const { Needs, NEED_LABEL } = require('./needs');
// ストレスの出どころ → どの感情に出やすいか
const STRESS_SOURCE = {
  anger: ['hunger', 'sleep', 'greed', 'recognition'],
  sadness: ['connection', 'recognition', 'care'],
  fear: ['safety'],
};

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function r2(v) { return Math.round(v * 100) / 100; }
function r1(v) { return Math.round(v * 10) / 10; }

// 好感の動き (2026-11-07 ユーザー決定「上がり幅を小さく、上限・下限に近いほど動きにくく」)。
//   変化 = 基の幅 × 残りの割合。残りの割合 = min(1, 残りの幅 ÷ room)。残りの幅は、上がるときは 100 − 好感、下がるときは 好感 − 0。
//   つまり 50 から上下 room までの所は基の幅のまま、そこから先は端に近いほど小さくなる (端で 0)。下がる方向も同じ形。
//   scoreStep: Jev の Score (0〜4、2 が変わらない) の 1 段あたりの基の幅 (前は 6、最大 ±12)。
//   events: 出来事ごとの基の幅 (物をもらった・教えてもらった・知らなかった・返事がなかった・聞かれて答えた (× (0.5 + empathy)))。
//   roomScale: false で前の形 (残りの割合を掛けない、端で切るだけ)
const AFFINITY_DEFAULTS = { scoreStep: 1.5, room: 50, roomScale: true, events: { received: 3, answered: 4, notKnown: -1, ignored: -3, asked: 1 } };

// わだかまり (2026-11-12 ユーザー決定)。相手ごとに好感とは別に持つ (r.grudge = { v: 0〜1, kind, item, tick, origin })。
//   ある間は好感が元の値 (最初のきっかけの直前の好感 origin) まで戻らない: 上がる方の上限 = origin − ceilDrop × v。
//   時間で薄れる (halfLife 判断で半分)。謝られた・返してもらった・元に戻してもらった で大きく減る (ease)。clearBelow を下回ったら消える。
//   きっかけごとの大きさ add (わだかまりに足す分) と aff (好感の基の幅。既にほかで好感を動かしているきっかけは 0)。
//   数値はモデルに見せない。関係の言葉に「何をされたか。まだ許していない」を出す (relationWord)。
const GRUDGE_DEFAULTS = {
  enabled: false, halfLife: 150, ceilDrop: 15, clearBelow: 0.03, showFrom: 0.1,
  kinds: {
    took_witnessed: { add: 0.4, aff: 0 }, took_heard: { add: 0.25, aff: 0 }, took_told: { add: 0.2, aff: 0 }, // 自分の物を取られた (好感は ownership の socialImpact)
    ignored: { add: 0.1, aff: 0 }, // 聞いた・頼んだのに返事がなかった (好感は onIgnored)
    denied: { add: 0.1, aff: -2 }, // 許可を断られた
    hit: { add: 0.5, aff: -8 }, killed: { add: 0.9, aff: -15 }, // 殴られた・殺された
    bed_taken: { add: 0.15, aff: -2 }, // 寝ようとしたベッドを先に使われていた
    snatched: { add: 0.2, aff: -3 }, // 自分が掘った物を先に拾われた
    call_ignored: { add: 0.08, aff: -1 }, // 呼んだのに来なかった
    breach: { add: 0.15, aff: 0 }, // 取り決めを破られた (好感は Jev の採点)
    complained: { add: 0.05, aff: -1 }, // 文句を言われた
    saw_hit: { add: 0, aff: -3 }, // 人が人を殴るのを見た・助けを呼ぶ声を聞いた (わだかまりにはしない。見方だけ下がる)
  },
  ease: { apology: 0.5, returned: 0.3, repaired: 0.3, received: 0.8, answered: 0.85, came: 0.9, defended: 0.5 }, // わだかまりに掛ける (小さいほど大きく減る)
  good: { came: 1, defended: 4 }, // 良い出来事の好感の基の幅 (もらった・教わった・謝られた・返してもらった は今までの所で動かす)
};
const GRUDGE_JA = { took_witnessed: (i) => `${i || '物'}を取られた`, took_heard: (i) => `${i || '物'}を取られたと聞いた`, took_told: (i) => `${i || '物'}を取られた`, ignored: () => '聞いたのに返事がなかった',
  denied: (i) => `${i || '物'}を使わせてと頼んで断られた`, hit: () => '殴られた', killed: () => '殺された', bed_taken: () => '寝ようとしたベッドを先に使われた', snatched: (i) => `自分が掘った${i || '物'}を先に拾われた`,
  call_ignored: () => '呼んだのに来なかった', breach: () => '取り決めを破られた', complained: () => '文句を言われた' };
const GRUDGE_EN = { took_witnessed: (i) => `they took my ${i || 'thing'}`, took_heard: (i) => `I heard they took my ${i || 'thing'}`, took_told: (i) => `they took my ${i || 'thing'}`, ignored: () => 'they did not answer when I asked',
  denied: (i) => `they refused when I asked to use their ${i || 'thing'}`, hit: () => 'they hit me', killed: () => 'they killed me', bed_taken: () => 'they were in the bed I went to sleep in', snatched: (i) => `they picked up the ${i || 'thing'} I dug`,
  call_ignored: () => 'they did not come when I called', breach: () => 'they broke an agreement', complained: () => 'they complained at me' };

class Social {
  constructor(opts = {}) {
    const t = opts.temperament || {};
    this.temperament = { bravery: 0.5, empathy: 0.5, obedience: 0.5, greed: 0.5, sociability: 0.5, ...t };
    this.emotions = { ...EMO_BASE };
    this.needsModel = new Needs({ cfg: opts.needs || {}, temperament: this.temperament });
    this.relations = {}; // name -> { affinity, trust, talks, helpedMe, iHelped, ignoredMe, met, note }
    const af = opts.affinity || {};
    this.aff = { ...AFFINITY_DEFAULTS, ...af, events: { ...AFFINITY_DEFAULTS.events, ...(af.events || {}) } };
    const g = opts.grudge || {};
    this.grudgeCfg = { ...GRUDGE_DEFAULTS, ...g, kinds: { ...GRUDGE_DEFAULTS.kinds, ...(g.kinds || {}) }, ease: { ...GRUDGE_DEFAULTS.ease, ...(g.ease || {}) }, good: { ...GRUDGE_DEFAULTS.good, ...(g.good || {}) } };
    this.decay = opts.decay ?? 0.85; // 1ループごとに基準値との差がこの割合に縮む
    this.lastTalkTick = 0;
  }

  static fromJSON(d, opts = {}) {
    const s = new Social(opts);
    if (d && typeof d === 'object') {
      if (d.emotions) Object.assign(s.emotions, d.emotions);
      if (d.needsModel) s.needsModel = Needs.fromJSON(d.needsModel, { cfg: opts.needs || {}, temperament: s.temperament });
      if (d.relations) s.relations = d.relations;
      s.lastTalkTick = d.lastTalkTick || 0;
    }
    return s;
  }

  toJSON() { return { emotions: this.emotions, needsModel: this.needsModel.toJSON(), relations: this.relations, lastTalkTick: this.lastTalkTick }; }

  // 欲求とストレスの数値 (記録用。2B・Jev には渡さない)
  get needs() { return this.needsModel.values(); }
  get stress() { return this.needsModel.stress; }

  rel(name) {
    if (!this.relations[name]) this.relations[name] = { affinity: 50, trust: 0.5, talks: 0, helpedMe: 0, iHelped: 0, ignoredMe: 0, met: false, note: '' };
    return this.relations[name];
  }

  // 好感を d (基の幅) だけ動かす。端に近いほど小さく (AFFINITY_DEFAULTS)。返り値: 実際に動いた幅
  moveAffinity(name, d) {
    const r = this.rel(name);
    if (!Number.isFinite(d) || d === 0) return 0;
    const a = r.affinity;
    const left = d > 0 ? 100 - a : a;
    const f = this.aff.roomScale ? clamp(left / (this.aff.room || 50), 0, 1) : 1;
    let to = clamp(a + d * f, 0, 100);
    // わだかまりがある間は、上がる方に上限が掛かる (元の値まで戻らない)
    const cap = d > 0 ? this.affinityCeiling(name) : null;
    if (cap != null && to > cap) { to = Math.max(a, cap); r.capped = (r.capped || 0) + 1; }
    r.affinity = r1(to);
    return r1(r.affinity - a);
  }

  // ---- わだかまり ----
  grudgeOf(name) { const r = this.relations[name]; return this.grudgeCfg.enabled && r && r.grudge && r.grudge.v > 0 ? r.grudge.v : 0; }
  affinityCeiling(name) {
    const r = this.relations[name];
    if (!this.grudgeCfg.enabled || !r || !r.grudge) return null;
    return r1(clamp(r.grudge.origin - this.grudgeCfg.ceilDrop * r.grudge.v, 0, 100));
  }
  // きっかけ kind で name へのわだかまりを足し、好感を動かす。返り値 { kind, add, v, affinity (動いた幅), ceiling } | null (off・知らない kind)
  addGrudge(name, kind, { item = null, tick = 0, scale = 1 } = {}) {
    const k = this.grudgeCfg.kinds[kind];
    if (!this.grudgeCfg.enabled || !k || !name) return null;
    const r = this.rel(name);
    const origin0 = r.affinity;
    const moved = k.aff ? this.moveAffinity(name, k.aff * scale) : 0;
    const add = k.add * scale;
    if (add > 0) {
      if (!r.grudge) r.grudge = { v: 0, kind, item, tick, origin: origin0 };
      const g = r.grudge;
      // 何をされたかは、いちばん大きいきっかけを残す
      const cur = this.grudgeCfg.kinds[g.kind];
      if (!cur || add >= cur.add) { g.kind = kind; g.item = item; }
      g.v = r2(clamp(g.v + add, 0, 1));
      g.tick = tick; g.n = (g.n || 0) + 1;
    }
    if (kind === 'hit' || kind === 'killed') { this.bump('fear', (kind === 'killed' ? 3 : 1.5) * (1.3 - this.temperament.bravery)); this.bump('anger', kind === 'killed' ? 3 : 2); } else if (add > 0) this.bump('anger', 4 * add);
    return { kind, add: r2(add), v: r.grudge ? r.grudge.v : 0, affinity: moved, ceiling: this.affinityCeiling(name) };
  }
  // 良い出来事でわだかまりを減らす (kind: ease の名前)。good にある出来事は好感も動かす。返り値 { kind, before, v, affinity } | null
  easeGrudge(name, kind) {
    if (!this.grudgeCfg.enabled || !name) return null;
    const r = this.rel(name);
    const up = this.grudgeCfg.good[kind];
    const before = r.grudge ? r.grudge.v : 0;
    const m = this.grudgeCfg.ease[kind];
    if (r.grudge && m != null) { r.grudge.v = r2(r.grudge.v * m); if (r.grudge.v < this.grudgeCfg.clearBelow) delete r.grudge; }
    const moved = up ? this.moveAffinity(name, up) : 0;
    if (!before && !moved) return null;
    const out = { kind, who: name, before, v: r.grudge ? r.grudge.v : 0, affinity: moved };
    this.eased = this.eased || [];
    this.eased.push(out); // agent が記録に書いて空にする
    return out;
  }
  // 1判断ごとに薄れる
  decayGrudges() {
    if (!this.grudgeCfg.enabled) return;
    const f = Math.pow(0.5, 1 / Math.max(1, this.grudgeCfg.halfLife));
    for (const r of Object.values(this.relations)) {
      if (!r.grudge) continue;
      r.grudge.v = Math.round(r.grudge.v * f * 10000) / 10000;
      if (r.grudge.v < this.grudgeCfg.clearBelow) delete r.grudge;
    }
  }
  // わだかまりの言葉 (何をされたか。まだ許していない)。無ければ ''
  grudgeWord(name, { lang = 'ja' } = {}) {
    const r = this.relations[name];
    if (!this.grudgeCfg.enabled || !r || !r.grudge || r.grudge.v < this.grudgeCfg.showFrom) return '';
    const f = (lang === 'en' ? GRUDGE_EN : GRUDGE_JA)[r.grudge.kind];
    if (!f) return '';
    return lang === 'en' ? `${f(r.grudge.item)}; I have not forgiven it yet` : `${f(r.grudge.item)}。まだ許していない`;
  }
  // わだかまりのある相手 { 名前: v } (showFrom 以上)
  grudges() {
    const out = {};
    if (!this.grudgeCfg.enabled) return out;
    for (const [n, r] of Object.entries(this.relations)) if (r.grudge && r.grudge.v >= this.grudgeCfg.showFrom) out[n] = r.grudge.v;
    return out;
  }

  bump(emo, d) { this.emotions[emo] = r2(clamp(this.emotions[emo] + d, 0, 10)); }

  // 1ループに1回: 感情は基準値へ戻り、欲求・ストレスは時間と周りの様子で変わり、ストレスが感情に出る。
  //   sense: agent.js が bot から作る { time, light, shelter, atHome, unfamiliar, newCell } (無ければ raw から分かる分だけ)
  tick({ tick = 0, raw = null, sense = {} } = {}) {
    for (const e of EMOTIONS) this.emotions[e] = r2(EMO_BASE[e] + (this.emotions[e] - EMO_BASE[e]) * this.decay);
    this.decayGrudges();
    const s = { ...sense };
    if (raw && raw.self) {
      if (s.timeOfDay == null) s.timeOfDay = raw.self.timeOfDay;
      if (s.time == null && raw.self.day != null && raw.self.timeOfDay != null) s.time = raw.self.day * 24000 + raw.self.timeOfDay;
      if (s.health == null) s.health = raw.self.health;
      if (s.food == null && Number.isFinite(raw.self.food)) s.food = raw.self.food;
      const ents = raw.entities || [];
      if (!s.hostiles) s.hostiles = ents.filter((e) => e.kind === 'hostile').map((e) => ({ name: e.name, d: e.d }));
      if (!s.players) s.players = ents.filter((e) => e.kind === 'player').map((e) => ({ name: e.name, d: e.d, affinity: this.relations[e.name] ? this.relations[e.name].affinity : 50 }));
      if (s.invTotal == null && raw.inventory) { s.invTotal = raw.inventory.reduce((t, i) => t + i.count, 0); s.invKinds = raw.inventory.length; }
      // 先のつらさ (anticipate.js) の材料: 持ち物・着けている物・見えている生き物とブロック・何日目か
      if (!s.inventory && raw.inventory) s.inventory = raw.inventory;
      if (!s.worn && raw.self.worn) s.worn = raw.self.worn;
      if (!s.tools && raw.tools) s.tools = raw.tools; // 道具の耐久 (先の道具切れ)
      if (!s.entities) s.entities = ents;
      if (!s.blocks && raw.blocks) s.blocks = raw.blocks;
      if (s.day == null && raw.self.day != null) s.day = raw.self.day;
    }
    s.bestAffinity = Math.max(50, ...Object.values(this.relations).map((r) => r.affinity));
    this.needsModel.update(s);
    this.stressToEmotions();
  }

  // ストレス → 感情 (性格でどれが強く出るか変わる)
  stressToEmotions() {
    const n = this.needsModel;
    const st = n.cfg.stress;
    const S = n.stress;
    const t = this.temperament;
    if (S > st.from) {
      const tilt = { anger: 1.3 - t.obedience * 0.8 + t.greed * 0.2, sadness: 0.4 + t.empathy * 0.4 + t.sociability * 0.4, fear: 1.3 - t.bravery };
      const tot = Object.values(n.inflow).reduce((a, b) => a + b, 0);
      for (const [emo, src] of Object.entries(STRESS_SOURCE)) {
        const share = tot > 0 ? src.reduce((a, k) => a + (n.inflow[k] || 0), 0) / tot : 1 / 3;
        this.bump(emo, S * st.gain * tilt[emo] * (0.3 + share));
      }
    }
    // 今の不安そのものも恐れに
    if (n.v.safety > 0.5) this.bump('fear', (n.v.safety - 0.5) * (1.3 - t.bravery));
  }

  // 行動の結果 (ルール)
  onActionResult(action, ok, { repeatedFail = false } = {}) {
    if (ok) { this.bump('joy', 0.6); this.bump('anger', -0.4); }
    else {
      this.bump('anger', 1.0 * (1.2 - this.temperament.obedience * 0.4));
      if (repeatedFail) { this.bump('sadness', 0.8); this.bump('disgust', 0.5); }
    }
  }

  // 行動の結果で欲求を動かす (食べた・寝た・休んだ・作った・一緒に行動した・物をあげた)
  onActionNeeds(action, arg, result, tick = 0) {
    this.needsModel.onAction(action, arg, result, { tick });
    if (result && result.ok && action === 'give') {
      const to = String(arg || '').split(':')[0];
      if (to) { const r = this.rel(to); r.iHelped += 1; r.note = r.note || '前に物をあげた'; }
    }
    if (result && result.ok && action === 'sleep' && result.sleep && result.sleep.nightSkipped) this.bump('joy', 1);
  }

  onDeath() { this.needsModel.onDeath(); this.bump('fear', 4 * (1.3 - this.temperament.bravery)); this.bump('sadness', 2); }

  // 物をもらった (近くの人が投げた物を拾った)
  onReceived(from) {
    const r = this.rel(from);
    r.helpedMe += 1;
    this.easeGrudge(from, 'received');
    this.moveAffinity(from, this.aff.events.received);
    r.note = '前に物をくれた';
    this.needsModel.onHelpedBy(from);
    this.bump('joy', 1);
  }

  onHeard(from, tick, text = '') {
    if (this.needsModel.onHeard(from, text, tick)) this.bump('joy', 1);
    const r = this.rel(from);
    if (!r.met) { r.met = true; this.bump('surprise', 1.5); this.bump('joy', 0.5 * this.temperament.sociability); }
    r.talks += 1;
    this.lastTalkTick = tick;
  }

  onSpoke(tick) { this.lastTalkTick = tick; }

  // 自分が聞いた相手から答えが返ってきた / 返ってこなかった
  onAnswered(from, known) {
    const r = this.rel(from);
    if (known) {
      r.helpedMe += 1;
      this.easeGrudge(from, 'answered');
      this.moveAffinity(from, this.aff.events.answered);
      r.trust = r2(clamp(r.trust + 0.1, 0, 1));
      r.note = '前にやり方を教えてくれた';
      this.bump('joy', 1.2);
      this.needsModel.onHelpedBy(from);
    } else {
      this.moveAffinity(from, this.aff.events.notKnown);
      r.note = r.note || '聞いたが知らなかった';
    }
  }

  onIgnored(from) {
    const r = this.rel(from);
    r.ignoredMe += 1;
    this.moveAffinity(from, this.aff.events.ignored);
    r.note = '聞いたのに返事がなかった';
    this.bump('sadness', 0.6);
    const gr = this.addGrudge(from, 'ignored');
    if (gr) { this.grieved = this.grieved || []; this.grieved.push({ who: from, ...gr }); } // agent が記録に書いて空にする
  }

  // 誰かに聞かれて答えた (頼られた)
  onAsked(by, answered, tick = this.lastTalkTick) {
    const r = this.rel(by);
    if (answered) { r.iHelped += 1; this.needsModel.onHelpedOther(by, { tick, asked: true }); }
    this.moveAffinity(by, this.aff.events.asked * (0.5 + this.temperament.empathy));
  }

  // 所有の出来事 (ownership.js の socialImpact) を関係と感情に当てる。name が null なら感情だけ (誰の仕業か分からない)。
  //   返り値: 当てたあとの { affinity, trust } (name が無ければ null)
  applyOwnershipImpact(name, imp) {
    if (!imp) return null;
    for (const e of ['anger', 'sadness', 'joy']) if (imp[e]) this.bump(e, imp[e]);
    if (!name) return null;
    const r = this.rel(name);
    // 謝られた・返してもらった・元に戻してもらった: わだかまりを先に減らす (好感の上限が緩んでから上げる)
    if (['returned', 'repaired', 'apology'].includes(imp.kind)) this.easeGrudge(name, imp.kind);
    if (imp.affinity) this.moveAffinity(name, imp.affinity);
    if (imp.trust) r.trust = r2(clamp(r.trust + imp.trust, 0, 1));
    const neg = (imp.affinity || 0) < 0 || (imp.trust || 0) < 0;
    if (['witnessed', 'heard', 'told'].includes(imp.kind)) { r.tookFromMe = (r.tookFromMe || 0) + 1; r.note = '前に物を取られた'; }
    else if (['returned', 'repaired', 'apology'].includes(imp.kind)) { r.amends = (r.amends || 0) + 1; if (r.note === '前に物を取られた') r.note = '取った物を返してくれた'; }
    else if (neg && (imp.kind === 'rumor' || imp.kind === 'third')) { r.tookSeen = (r.tookSeen || 0) + 1; if (!r.note) r.note = '人の物を取ったと聞いた'; }
    return { affinity: r.affinity, trust: r.trust };
  }

  // Jev の Score (0〜4: とても悪くなった〜とても良くなった) で好感を動かす。基の幅 = (score − 2) × scoreStep (既定 1.5、最大 ±3)
  onRelationScore(name, score) {
    if (!Number.isFinite(score)) return;
    this.moveAffinity(name, (score - 2) * this.aff.scoreStep);
  }

  // いちばんつらいこと { need, label, text } | null
  worstNeed() { return this.needsModel.worst(); }

  // 相手との関係の言葉 (lang: 'ja' | 'en')
  relationWord(name, { lang = 'ja' } = {}) {
    const r = this.relations[name];
    const en = lang === 'en';
    if (!r) return en ? 'a stranger' : '知らない人';
    const i = r.affinity >= 75 ? 0 : r.affinity >= 58 ? 1 : r.affinity <= 25 ? 2 : r.affinity <= 42 ? 3 : 4;
    const how = (en ? ['close friends', 'on good terms', 'on bad terms', 'a little uncomfortable with them', 'acquaintances'] : ['仲が良い', '感じが良い', '仲が悪い', '少し苦手', '知り合い'])[i];
    const gw = this.grudgeWord(name, { lang });
    if (gw) return en ? `${how}; ${gw}` : `${how}。${gw}`; // わだかまりがある間は、何をされたかを出す
    if (en) return `${how}${r.note ? `; ${NOTE_EN[r.note] || r.note}` : ''}`;
    return `${how}${r.note ? '。' + r.note : ''}`;
  }

  // 2B と Jev に渡す短い言葉。数値は渡さない。体と心の状態 (needs.js) は毎回必ず入れる。lang: 'en' は Jev 用 (同じ値から作る)
  words({ maxRelations = 3, relations = true, lang = 'ja' } = {}) {
    const en = lang === 'en';
    const out = [this.needsModel.words({ lang })];
    const emo = EMOTIONS.map((e) => [e, this.emotions[e]])
      .filter(([e, v]) => v >= 3 && !(e === 'joy' && v < 4))
      .sort((a, b) => b[1] - a[1]).slice(0, 2);
    for (const [e, v] of emo) out.push((en ? EMO_WORD_EN : EMO_WORD)[e][v >= 8 ? 2 : v >= 5 ? 1 : 0]);
    const sep = en ? '; ' : '。';
    if (!relations) return out.join(sep);
    // わだかまりのある相手は先に (何をされたかが必ず言葉に出る)
    const gv = (r) => (this.grudgeCfg.enabled && r.grudge && r.grudge.v >= this.grudgeCfg.showFrom ? r.grudge.v : 0);
    const rels = Object.entries(this.relations).filter(([, r]) => r.met || r.talks || r.helpedMe || r.ignoredMe || gv(r))
      .sort((a, b) => (gv(b[1]) - gv(a[1])) || (Math.abs(b[1].affinity - 50) - Math.abs(a[1].affinity - 50))).slice(0, maxRelations);
    for (const [name] of rels) out.push(en ? `with ${name}: ${this.relationWord(name, { lang })}` : `${name}とは${this.relationWord(name)}`);
    return out.join(sep);
  }
}

module.exports = { Social, EMOTIONS, NEED_LABEL, AFFINITY_DEFAULTS, GRUDGE_DEFAULTS, GRUDGE_JA, GRUDGE_EN };
