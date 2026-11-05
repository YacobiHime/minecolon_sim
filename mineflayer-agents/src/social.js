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
  聞いたが知らなかった: 'I asked them but they did not know', 聞いたのに返事がなかった: 'I asked them but got no answer' };
const { Needs, NEED_LABEL } = require('./needs');
// ストレスの出どころ → どの感情に出やすいか
const STRESS_SOURCE = {
  anger: ['hunger', 'sleep', 'greed', 'recognition'],
  sadness: ['connection', 'recognition', 'care'],
  fear: ['safety'],
};

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function r2(v) { return Math.round(v * 100) / 100; }

class Social {
  constructor(opts = {}) {
    const t = opts.temperament || {};
    this.temperament = { bravery: 0.5, empathy: 0.5, obedience: 0.5, greed: 0.5, sociability: 0.5, ...t };
    this.emotions = { ...EMO_BASE };
    this.needsModel = new Needs({ cfg: opts.needs || {}, temperament: this.temperament });
    this.relations = {}; // name -> { affinity, trust, talks, helpedMe, iHelped, ignoredMe, met, note }
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

  bump(emo, d) { this.emotions[emo] = r2(clamp(this.emotions[emo] + d, 0, 10)); }

  // 1ループに1回: 感情は基準値へ戻り、欲求・ストレスは時間と周りの様子で変わり、ストレスが感情に出る。
  //   sense: agent.js が bot から作る { time, light, shelter, atHome, unfamiliar, newCell } (無ければ raw から分かる分だけ)
  tick({ tick = 0, raw = null, sense = {} } = {}) {
    for (const e of EMOTIONS) this.emotions[e] = r2(EMO_BASE[e] + (this.emotions[e] - EMO_BASE[e]) * this.decay);
    const s = { ...sense };
    if (raw && raw.self) {
      if (s.timeOfDay == null) s.timeOfDay = raw.self.timeOfDay;
      if (s.time == null && raw.self.day != null && raw.self.timeOfDay != null) s.time = raw.self.day * 24000 + raw.self.timeOfDay;
      if (s.health == null) s.health = raw.self.health;
      const ents = raw.entities || [];
      if (!s.hostiles) s.hostiles = ents.filter((e) => e.kind === 'hostile').map((e) => ({ name: e.name, d: e.d }));
      if (!s.players) s.players = ents.filter((e) => e.kind === 'player').map((e) => ({ name: e.name, d: e.d, affinity: this.relations[e.name] ? this.relations[e.name].affinity : 50 }));
      if (s.invTotal == null && raw.inventory) { s.invTotal = raw.inventory.reduce((t, i) => t + i.count, 0); s.invKinds = raw.inventory.length; }
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
    r.affinity = clamp(r.affinity + 6, 0, 100);
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
      r.affinity = clamp(r.affinity + 8, 0, 100);
      r.trust = r2(clamp(r.trust + 0.1, 0, 1));
      r.note = '前にやり方を教えてくれた';
      this.bump('joy', 1.2);
      this.needsModel.onHelpedBy(from);
    } else {
      r.affinity = clamp(r.affinity - 1, 0, 100);
      r.note = r.note || '聞いたが知らなかった';
    }
  }

  onIgnored(from) {
    const r = this.rel(from);
    r.ignoredMe += 1;
    r.affinity = clamp(r.affinity - 5, 0, 100);
    r.note = '聞いたのに返事がなかった';
    this.bump('sadness', 0.6);
  }

  // 誰かに聞かれて答えた (頼られた)
  onAsked(by, answered, tick = this.lastTalkTick) {
    const r = this.rel(by);
    if (answered) { r.iHelped += 1; this.needsModel.onHelpedOther(by, { tick, asked: true }); }
    r.affinity = clamp(r.affinity + 2 * (0.5 + this.temperament.empathy), 0, 100);
  }

  // Jev の Score (0〜4: とても悪くなった〜とても良くなった) で好感を動かす
  onRelationScore(name, score) {
    if (!Number.isFinite(score)) return;
    const r = this.rel(name);
    r.affinity = Math.round(clamp(r.affinity + (score - 2) * 6, 0, 100));
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
    const rels = Object.entries(this.relations).filter(([, r]) => r.met || r.talks || r.helpedMe || r.ignoredMe)
      .sort((a, b) => Math.abs(b[1].affinity - 50) - Math.abs(a[1].affinity - 50)).slice(0, maxRelations);
    for (const [name] of rels) out.push(en ? `with ${name}: ${this.relationWord(name, { lang })}` : `${name}とは${this.relationWord(name)}`);
    return out.join(sep);
  }
}

module.exports = { Social, EMOTIONS, NEED_LABEL };
