'use strict';
// わだかまりと、悪い関係のときの行動のつなぎ (1エージェントに1つ)。agent.js から呼ぶ。
//   きっかけ (grieve): 物を取られた (ownership_agent.js から)・返事がなかった (social.onIgnored)・許可を断られた・殴られた・殺された・
//     寝ようとしたベッドを先に使われた・掘った物を先に拾われた・呼んだのに来なかった・取り決めを破られた・文句を言われた
//   良い出来事 (ease): もらった・教わった (social.js)・謝られた・返してもらった・元に戻してもらった (ownership の関係の変化)・呼んだら来た
//   記録: event 'grudge' (発生)・'grudge_ease' (減少)・'conflict_act' (悪い関係の行動)・'hit' / 'hit_received' / 'hit_seen' / 'kill' / 'killed_by'・'conflict_heard'
const C = require('./conflict');
const { GRUDGE_DEFAULTS, GRUDGE_JA } = require('./social');
const { peopleOf } = require('./people');
const { dist3 } = require('./util');
const { sameFamily } = require('./provenance');
const { itemOf } = require('./ownership');

const r3 = (v) => Math.round(v * 1000) / 1000;

class ConflictCtl {
  constructor(agent) {
    this.agent = agent;
    this.cfg = C.cfgOf(agent.cfg.conflict);
    this.me = agent.cfg.persona.name;
    // わだかまりの設定を social に入れる (off なら好感の動きは今までどおり)
    const gp = this.cfg.grudgeParams || {};
    agent.social.grudgeCfg = { ...GRUDGE_DEFAULTS, ...gp, kinds: { ...GRUDGE_DEFAULTS.kinds, ...(gp.kinds || {}) }, ease: { ...GRUDGE_DEFAULTS.ease, ...(gp.ease || {}) }, good: { ...GRUDGE_DEFAULTS.good, ...(gp.good || {}) }, enabled: this.cfg.grudge };
    const ex = agent.memory.extra || (agent.memory.extra = {});
    this.store = ex.conflict || (ex.conflict = { hitBy: {}, calls: [], said: {}, last: {}, breaches: {} });
    this.swings = new Map(); // 人 → 最後に腕を振った時刻
    this.seenHit = new Map(); // "殴った人|殴られた人" → 時刻
    this.offered = [];
    this.near = [];
  }

  get on() { return this.cfg.grudge; }
  tick() { return this.agent.memory.tick; }
  write(ev) { try { this.agent.recorder.write({ loop: this.tick(), ...ev }); } catch (_) { /* ignore */ } }
  state() {
    const s = this.agent.social;
    let needs = {};
    try { const e = s.needsModel.effective(); needs = Object.fromEntries(['hunger', 'sleep', 'safety', 'greed', 'connection'].map((k) => [k, r3(e[k] ?? 0)])); } catch (_) { /* ignore */ }
    return { emotions: { anger: s.emotions.anger, fear: s.emotions.fear, sadness: s.emotions.sadness }, needs, stress: s.stress, temperament: s.temperament };
  }

  // きっかけ: name へのわだかまりを足す (同じ相手・同じきっかけは cooldown の間に一度)。返り値: social.addGrudge の結果 | null
  grieve(name, kind, { item = null, scale = 1, force = false, detail = null } = {}) {
    if (!this.cfg.grudge || !name || name === this.me) return null;
    const k = `${name}|${kind}`;
    if (!force && this.tick() - (this.store.last[k] ?? -1e9) < this.cfg.cooldown) return null;
    this.store.last[k] = this.tick();
    const s = this.agent.social;
    const before = s.relations[name] ? s.relations[name].affinity : 50;
    const g = s.addGrudge(name, kind, { item, tick: this.tick(), scale });
    if (!g) return null;
    this.record(name, g, { item, before, detail });
    return g;
  }
  record(name, g, { item = null, before = null, detail = null } = {}) {
    const s = this.agent.social;
    this.write({ event: 'grudge', who: name, kind: g.kind, item, add: g.add, v: g.v, affinity: g.affinity, before, after: s.relations[name] ? s.relations[name].affinity : null, ceiling: g.ceiling, ...(detail ? { detail } : {}), ...this.state() });
    // 記憶に残す (何をされたか。大事さは高め)
    if (g.add > 0) { try { this.agent.memory.noteEvent('wronged', name, false, `${name}に${(GRUDGE_JA[g.kind] || (() => '嫌なことをされた'))(item)}`, 0.8); } catch (_) { /* ignore */ } }
  }
  ease(name, kind) {
    if (!this.cfg.grudge) return null;
    const e = this.agent.social.easeGrudge(name, kind);
    this.flush();
    return e;
  }
  // social.js の中で起きた分 (返事がなかった・もらった・教わった・謝られた など) を記録に書く
  flush() {
    const s = this.agent.social;
    for (const g of (s.grieved || []).splice(0)) this.record(g.who, g, {});
    for (const e of (s.eased || []).splice(0)) this.write({ event: 'grudge_ease', who: e.who, kind: e.kind, before: e.before, v: e.v, affinity: e.affinity });
  }

  // ---- bot の見張り (connect のたび) ----
  watch(bot) {
    if (!this.cfg.grudge || !bot || typeof bot.on !== 'function') return;
    const nameOf = (e) => (e && e.type === 'player' ? e.username : null);
    bot.on('entitySwingArm', (e) => { const n = nameOf(e); if (n && n !== bot.username) this.swings.set(n, Date.now()); });
    bot.on('entityHurt', (e) => { try { this.onHurt(e); } catch (_) { /* ignore */ } });
  }

  // 傷を受けたエンティティ e を、直前に腕を振った手の届く所の人が殴ったと見る。敵 (hostile) がすぐ近くにいるときは人のせいにしない
  attackerOf(e, now = Date.now()) {
    const bot = this.agent.bot;
    if (!bot || !e || !e.position) return null;
    const hostileNear = Object.values(bot.entities || {}).some((x) => x && x !== e && x.position && x.type !== 'player' && (x.type === 'hostile' || x.kind === 'Hostile mobs') && dist3(x.position, e.position) <= 3.5);
    if (hostileNear) return null;
    const c = Object.values(bot.players || {}).filter((p) => p && p.entity && p.entity !== e && p.username !== (e.username || null) && p.username !== bot.username
      && dist3(p.entity.position, e.position) <= this.cfg.hitReach && now - (this.swings.get(p.username) ?? -Infinity) <= this.cfg.hitWindowMs)
      .sort((a, b) => dist3(a.entity.position, e.position) - dist3(b.entity.position, e.position));
    return c.length ? c[0].username : null;
  }

  onHurt(e, now = Date.now()) {
    const bot = this.agent.bot;
    if (!bot || !e) return;
    if (e === bot.entity) {
      const who = this.attackerOf(e, now);
      if (!who) return;
      this.store.hitBy[who] = this.tick();
      const g = this.grieve(who, 'hit');
      this.write({ event: 'hit_received', from: who, health: bot.health ?? null, counted: !!g });
      return;
    }
    if (e.type !== 'player' || !e.username || !bot.entity || dist3(e.position, bot.entity.position) > 16) return;
    // 自分が殴った分は数えない (自分は swings に入らない)
    const who = this.attackerOf(e, now);
    if (!who) return;
    const k = `${who}|${e.username}`;
    if (now - (this.seenHit.get(k) ?? -Infinity) < 10000) return;
    this.seenHit.set(k, now);
    const g = this.grieve(who, 'saw_hit', { detail: { victim: e.username } });
    this.write({ event: 'hit_seen', attacker: who, victim: e.username, affinity: g ? g.affinity : 0 });
  }

  // 死亡メッセージ (自分が死んだ): 人に殺されたなら強いきっかけ
  onDeathMessage(key, text) {
    if (!this.cfg.grudge || !/^death\.attack\.player/.test(String(key))) return null;
    const bot = this.agent.bot;
    const names = Object.keys((bot && bot.players) || {}).filter((n) => n !== this.me && new RegExp(`(^|[^A-Za-z0-9_])${n}([^A-Za-z0-9_]|$)`).test(String(text)));
    const who = names[0];
    if (!who) return null;
    this.store.hitBy[who] = this.tick();
    const g = this.grieve(who, 'killed', { force: true });
    this.write({ event: 'killed_by', who, message: String(text).slice(0, 120) });
    return g;
  }
  // 死亡メッセージ (ほかの人が死んだ): 自分が殺した
  onOtherDeath(key, text) {
    if (!/^death\.attack\.player/.test(String(key))) return;
    const t = String(text);
    if (!new RegExp(`by ${this.me}([^A-Za-z0-9_]|$)`).test(t)) return;
    this.write({ event: 'kill', victim: t.split(' ')[0], message: t.slice(0, 120), ...this.state() });
  }

  // ---- 毎判断 ----
  observe(raw) {
    this.flush();
    const people = peopleOf(raw);
    this.near = people.filter((p) => p.d <= 48).map((p) => ({ n: p.name, d: Math.round(p.d) }));
    if (!this.cfg.grudge) return;
    // 呼んだ相手が来たか
    const keep = [];
    for (const c of this.store.calls) {
      const p = people.find((x) => x.name === c.to);
      if (p && p.d <= this.cfg.callNear) { if (!c.wasNear) { this.ease(c.to, 'came'); this.write({ event: 'call_came', who: c.to, after: this.tick() - c.tick }); } continue; }
      if (this.tick() - c.tick >= this.cfg.callWaitTicks) { this.grieve(c.to, 'call_ignored'); continue; }
      keep.push(c);
    }
    this.store.calls = keep;
  }

  // 行動の候補に渡す見方 (ctx.conflict)
  view(raw, { takeBack = [] } = {}) {
    if (!this.cfg.actions) return null;
    const s = this.agent.social;
    const grudges = {};
    for (const [n, r] of Object.entries(s.relations)) if (r.grudge && r.grudge.v > 0) grudges[n] = { v: r.grudge.v, kind: r.grudge.kind, item: r.grudge.item || null };
    return { cfg: this.cfg, grudges, hitBy: this.store.hitBy, tick: this.tick(), hearRadius: (this.agent.cfg.perception && this.agent.cfg.perception.hearRadius) ?? 48,
      saidRecently: (kind, name) => this.tick() - (this.store.said[`${kind}|${name}`] ?? -1e9) < this.cfg.sayCooldown, takeBack };
  }

  // 取り返す候補: わだかまりのきっかけが「取られた」で、その相手が置いている (自分が知っている) 同じ種類の物が見えている
  takeBackTargets(raw, own) {
    if (!this.cfg.actions || !own || !own.knowledge) return [];
    const out = [];
    const dim = own.dim();
    for (const [n, r] of Object.entries(this.agent.social.relations)) {
      const g = r.grudge;
      if (!g || g.v < this.cfg.threshold || !/^took_/.test(g.kind) || !g.item) continue;
      for (const b of raw.blocks || []) {
        if (!b.diggable || !(sameFamily(b.name, g.item) || itemOf(b.name) === itemOf(g.item))) continue;
        for (const p of (b.positions && b.positions.length ? b.positions : [b.nearest])) {
          const c = own.knowledge.classify(dim, p, b.name);
          if (c.category === 'other' && c.owner === n && dist3(p, raw.self.pos) <= this.cfg.nearRadius) { out.push({ player: n, block: b.name, pos: { x: p.x, y: p.y, z: p.z } }); break; }
        }
      }
    }
    return out;
  }

  noteOffered(actions) {
    this.offered = [];
    for (const a of actions || []) if (C.CONFLICT_ACTIONS.includes(a.name)) for (const c of a.choices || []) this.offered.push(`${a.name}:${c.id}`);
  }

  // 文句・返して・助けて (act_conflict.js から)
  async say(kind, ch) {
    const g = this.agent.social.relations[ch.player] && this.agent.social.relations[ch.player].grudge;
    const rec = kind === 'complain' ? { target: ch.player, kind: g ? g.kind : ch.kind || 'hit', item: (g && g.item) || ch.item || null }
      : kind === 'demand' ? { target: ch.player, item: ch.item } : { attacker: ch.player };
    let text = C.templateText(kind, rec);
    let via = 'template';
    const tk = this.agent.talker;
    if (this.cfg.speech === 'llm' && tk && typeof tk.run === 'function') {
      const persona = this.agent.cfg.persona;
      const what = kind === 'complain' ? `${rec.target}に、${(GRUDGE_JA[rec.kind] || (() => '嫌なことをされた'))(rec.item)}ことへの文句を言う` : kind === 'demand' ? `${rec.target}に、取られた${rec.item}を返してと言う` : `周りの人に、${rec.attacker}に殴られたので助けてと言う`;
      try {
        const r = await tk.run('talk', [
          { role: 'system', content: [`あなたは Minecraft の世界にいる「${persona.name}」。${persona.personality || ''}`, persona.speech ? `話し方: ${persona.speech}` : '', `今の気持ち: ${this.agent.social.words({ relations: false })}`,
            '次の「伝えること」だけを、近くの人に言う短い日本語(30字以内)にする。書いていないことは言わない。JSON {"say":"..."} だけを出力する。'].filter(Boolean).join('\n') },
          { role: 'user', content: `## 伝えること\n${what}\n話すことを JSON で。` }]);
        if (r && r.say) { text = r.say; via = 'llm'; }
      } catch (_) { /* 型どおりの文で */ }
    }
    const l = kind === 'complain' ? C.line.complain(rec, text) : kind === 'demand' ? C.line.demand(rec, text) : C.line.help(rec, text);
    try { this.agent.bot.chat(l.slice(0, 250)); } catch (e) { return { ok: false, msg: `言えなかった: ${e.message}` }; }
    this.agent.memory.noteHeard('自分', text);
    this.store.said[`${kind}|${ch.player}`] = this.tick();
    const msg = kind === 'complain' ? `${ch.player}に文句を言った「${text}」` : kind === 'demand' ? `${ch.player}に${rec.item}を返してと言った「${text}」` : `周りに助けを求めた「${text}」`;
    return { ok: true, msg, said: text, via, conflictSaid: { kind, target: ch.player } };
  }

  // 近くの声の行。返り値: 近くの声として残す文
  onLine(from, m) {
    if (!m) return null;
    if (m.type === 'complain' && m.target === this.me) { this.grieve(from, 'complained'); this.agent.social.bump('sadness', 0.5); }
    if (m.type === 'help' && m.attacker !== this.me && from !== this.me) {
      const k = `${m.attacker}|${from}`;
      if (Date.now() - (this.seenHit.get(k) ?? -Infinity) > 10000) { this.seenHit.set(k, Date.now()); this.grieve(m.attacker, 'saw_hit', { detail: { victim: from, via: 'help' } }); }
    }
    this.write({ event: 'conflict_heard', from, type: m.type, target: m.target || m.attacker || null, toMe: (m.target || m.attacker) === this.me, ...(m.item ? { item: m.item } : {}), ...(m.kind ? { kind: m.kind } : {}) });
    return m.text || null;
  }

  // 取り決めを破られた (board の breach)
  onBreach(who, id) {
    const k = `${id}|${who}`;
    if (this.store.breaches[k]) return;
    this.store.breaches[k] = this.tick();
    this.grieve(who, 'breach', { force: true });
  }

  // 掘った物を先に拾われた (agent の collect の見張りから)
  onSnatched(who, item) { return this.grieve(who, 'snatched', { item }); }

  // ---- 行動のあと ----
  afterAct(resolved, result) {
    const a = resolved.action;
    const ch = resolved.choice || {};
    const bot = this.agent.bot;
    if (this.cfg.grudge) {
      if (a === 'call' && result && result.ok && ch.player) {
        const p = bot && bot.players && bot.players[ch.player];
        const d = p && p.entity && bot.entity ? dist3(p.entity.position, bot.entity.position) : Infinity;
        this.store.calls = this.store.calls.filter((c) => c.to !== ch.player);
        this.store.calls.push({ to: ch.player, tick: this.tick(), wasNear: d <= this.cfg.callNear });
      }
      // 寝ようとしたベッドを先に使われていた: ベッドのすぐ近くに人がいればその人 (村人なら誰のせいにもしない)
      if (a === 'sleep' && result && !result.ok && /occupied/.test(String(result.msg)) && ch.pos && bot && bot.players) {
        const near = Object.values(bot.players).filter((p) => p && p.entity && p.username !== this.me && dist3(p.entity.position, ch.pos) <= 2.5)
          .sort((x, y) => dist3(x.entity.position, ch.pos) - dist3(y.entity.position, ch.pos))[0];
        if (near) this.grieve(near.username, 'bed_taken');
      }
    }
    if (C.CONFLICT_ACTIONS.includes(a)) {
      const target = ch.player || null;
      this.write({ event: 'conflict_act', action: a, arg: resolved.arg, target, ok: !!(result && result.ok), grudge: ch.grudge ?? this.agent.social.grudgeOf(target), kind: ch.kind || null, retaliation: !!ch.retaliation,
        ...(result && result.hitPerson ? { hits: result.hitPerson.hits, gone: !!result.hitPerson.gone } : {}), ...(result && result.said ? { said: result.said } : {}), ...this.state() });
      if (result && result.hitPerson && result.hitPerson.hits) this.write({ event: 'hit', target, hits: result.hitPerson.hits, gone: !!result.hitPerson.gone, retaliation: !!ch.retaliation, ...this.state() });
    }
    this.flush();
  }

  snapshot() {
    const g = this.agent.social.grudges();
    return { grudges: Object.keys(g).length ? g : undefined, near: this.near.length ? this.near : undefined, offered: this.offered.length ? this.offered : undefined };
  }
}

module.exports = { ConflictCtl };
