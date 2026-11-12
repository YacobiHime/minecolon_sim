'use strict';
// 所有と来歴のつなぎ (1エージェントに1つ)。agent.js から呼ぶ。
//   台帳 (provenance.js の Ledger): 評価用の ground truth。自分が置いた・掘った物を runs/<id>/provenance/<名前>.jsonl に書く。
//     エージェントの判断には渡さない (理由の記録の truth 欄と、天然と誤認した・誤って壊した の判定だけに使う)。
//   知識 (ownership.js の OwnKnowledge): 自分で置いた・置くのを見た・聞いた・共有にされた物だけ。memory.extra.owned に保存し、記憶と同じ式で忘れる。
//   行動の前の理由の記録 (event: 'intent')・結果 (event: 'take')・許可・説明・返却・補修・関係の変化 (event: 'ownership_*') を recorder に書く。
//   発話の行 (【許可?】【許可】【説明】【返却】【補修】【噂】) は近くの声 (hearRadius) で届く。全員が同じ行を読む (プロセスをまたいでも同じ)。
const path = require('path');
const { Vec3 } = require('vec3');
const { Ledger, instrumentBot, keyOf, normDim, sameFamily, SOFT } = require('./provenance');
const O = require('./ownership');
const { naturalPositions } = require('./ownership_actions');
const { peopleOf } = require('./people');
const { blockVisible } = require('./observe');
const { dist3 } = require('./util');

const AIRISH = /^(air|cave_air|void_air)$/;
// 自然に伸びる・生える・広がる物 (置くのを見たとはしない)
const GROWS = /vine|_leaves$|^(short_grass|grass|tall_grass|fern|large_fern|snow|kelp|kelp_plant|bamboo|sugar_cane|cactus|seagrass|tall_seagrass|cave_vines|cave_vines_plant|sweet_berry_bush|grass_block|dirt|mycelium|moss_block|cobweb)$|_log$|_mushroom$/;
const TAKE_LIKE = new Set(['collect', 'take_placed', 'dismantle_own', 'repair_or_relocate_public', 'take_back']);
// 台帳に無い人工物の ground truth (村の家・ベッド・扉・柵・松明など)。2026-11-11 ユーザー決定: 外界の物なので、みんなの物 (public)
const WORLD_TRUTH = Object.freeze({ placedBy: null, ownership: { kind: 'public', owner: null, world: true }, purpose: 'world_structure', status: 'unlogged', placedAt: null });
// 天然と同じ見た目の、村の家の一部 (原木・丸石など): 台帳に無く、すぐ隣 (26マス) に台帳に無い人工物 (板材・ガラス・扉など) がある
const STRUCTURE_TRUTH = Object.freeze({ placedBy: null, ownership: { kind: 'public', owner: null, world: true }, purpose: 'world_structure_natural_looking', status: 'unlogged', placedAt: null });
const STRUCTURAL = /_log$|_wood$|^(cobblestone|mossy_cobblestone|stone_bricks|stone|dirt_path|sandstone|smooth_sandstone|terracotta|white_terracotta|bricks|clay)$/;
const P = (p) => (Array.isArray(p) ? { x: p[0], y: p[1], z: p[2] } : { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const samePos = (a, b) => !!a && !!b && Math.floor(a.x) === Math.floor(b.x) && Math.floor(a.y) === Math.floor(b.y) && Math.floor(a.z) === Math.floor(b.z);
// 本当の代わりの手段 (評価用): 天然の入手元の種類 (台帳の置かれた物は除く)
const TRUTH_SOURCE = [
  [(b) => O.LIGHT[b] != null, /^(deepslate_)?coal_ore$/, null],
  [(b) => /_bed$/.test(b), null, /^sheep$/],
  [(b) => /^(crafting_table|chest|barrel|ladder)$|_planks$|_fence$|_fence_gate$|_door$|_trapdoor$|_sign$|_slab$|_stairs$|_log$/.test(b), /_log$/, null],
  [(b) => /^(furnace|smoker|blast_furnace|cobblestone|stone|stone_bricks|cobbled_deepslate)$/.test(b), /^(stone|deepslate|andesite|diorite|granite)$/, null],
  [(b) => O.FARM.test(b), /^(short_grass|grass|tall_grass)$/, /^(cow|pig|sheep|chicken|rabbit)$/],
];

class OwnershipCtl {
  constructor(agent, { recordDir = null } = {}) {
    this.agent = agent;
    this.cfg = O.cfgOf(agent.cfg.provenance);
    this.me = agent.cfg.persona.name;
    // 記録の場所が無い (テストなど) ときは、このエージェントだけの台帳 (ファイルに書かない)
    this.ledger = !this.cfg.ledger ? null : recordDir ? Ledger.shared(path.join(recordDir, 'provenance'), { syncMs: this.cfg.syncMs }) : new Ledger({ dir: null });
    if (this.ledger) this.ledger.addWriter(this.me);
    const ex = agent.memory.extra || (agent.memory.extra = {});
    this.knowledge = this.cfg.actions ? new O.OwnKnowledge(ex.owned || (ex.owned = {}), { me: this.me, cfg: this.cfg }) : null;
    if (this.knowledge) this.knowledge.publicNear = (dim, pos) => this.isVillage(dim, pos);
    this.store = ex.ownership || (ex.ownership = { owe: [], losses: [], permits: {}, asked: {}, takesBy: {}, witnessed: [], seq: 0, rumorAt: {} });
    this.cur = null; // 今の行動 { action, arg, choice, intent, tick }
    this.pendingAsk = null;
    this.recentPlace = new Map(); // 自分が置いたマス → 時刻 (blockUpdate で自分の物を見たことにしない)
    this.lastRaw = null;
    this.counts = { intents: 0, takes: 0, learned: 0, social: 0 };
  }

  get on() { return !!this.knowledge; }
  get bot() { return this.agent.bot; }
  dim() { const g = this.bot && this.bot.game; return normDim(g && g.dimension); }
  tick() { return this.agent.memory.tick; }
  write(ev) { try { this.agent.recorder.write({ loop: this.tick(), ...ev }); } catch (_) { /* ignore */ } }

  // ---- bot への取り付け (connect のたび) ----
  attach(bot) {
    if (!this.ledger && !this.knowledge) return;
    // others.js を使わない設定では、置いた・壊したのを見る見張りをここで付ける (壊した人の見分けは無し)
    if (this.knowledge && !this.agent.others && typeof bot.on === 'function') {
      bot.on('blockUpdate', (oldB, newB) => {
        try {
          if (!oldB || !newB || oldB.name === newB.name) return;
          const players = Object.values(bot.players || {}).filter((p) => p.username !== bot.username && p.entity).map((p) => ({ name: p.username, pos: p.entity.position, held: p.entity.heldItem ? p.entity.heldItem.name : null }));
          this.onBlockChange({ pos: newB.position, oldName: oldB.name, newName: newB.name, who: null, players, me: bot.entity ? bot.entity.position : null });
        } catch (_) { /* ignore */ }
      });
    }
    instrumentBot(bot, {
      beforeDig: (i) => this.beforeDig(i),
      afterDig: (i, ok) => this.afterDig(i, ok),
      beforePlace: (i) => this.recentPlace.set(`${i.pos.x},${i.pos.y},${i.pos.z}`, Date.now()),
      afterPlace: (i) => this.afterPlace(i),
      afterActivate: (i) => { if (O.FARM.test(i.name) || O.ARTIFACT.test(i.name)) this.afterPlace({ ...i, via: 'activate' }); },
    });
  }

  // 置いた物の目的と所有 (行動と道筋のゴールから)
  placeMeta(name) {
    const c = this.cur || {};
    const a = c.action || null;
    const ch = c.choice || {};
    const g = this.agent.goalPath && this.agent.goalPath.goal;
    const base = { action: a, goal: g ? g.target || null : null, need: g ? g.need || null : null };
    const own = (kind, owner, group) => ({ kind, owner, ...(group ? { group } : {}) });
    if (a === 'pillar') return { ...base, purpose: 'scaffold', status: 'abandoned', ownership: own('personal', this.me) };
    if (a === 'build') return { ...base, purpose: 'shelter', ownership: own('group', this.me, 'base') };
    if (a === 'enclose') return { ...base, purpose: 'animal_pen', ownership: own('personal', this.me) };
    if (a === 'use_on') return { ...base, purpose: 'farm', ownership: own('personal', this.me) };
    if (a === 'make_amends' || a === 'repair_or_relocate_public') {
      const kind = ch.own ? (ch.own.category === 'other' ? 'personal' : ch.own.category) : a === 'repair_or_relocate_public' ? 'group' : ch.owner ? 'personal' : 'unknown';
      return { ...base, purpose: a === 'make_amends' ? 'restitution' : ch.kind === 'relocate' ? 'public_relocation' : 'public_repair', ownership: own(kind, ch.owner || (kind === 'unknown' ? null : this.me)) };
    }
    if (a === 'place') {
      const purpose = O.LIGHT[name] != null ? 'lighting' : /_bed$/.test(name) ? 'sleeping' : name === 'crafting_table' ? 'crafting' : /^(furnace|smoker|blast_furnace)$/.test(name) ? 'cooking' : O.CONTAINER.test(name) ? 'storage' : g && /walled/.test(g.target || '') ? 'shelter_wall' : 'building';
      return { ...base, purpose, ownership: own('personal', this.me) };
    }
    // pathfinder が歩くために置いた足場など
    return { ...base, purpose: 'path_scaffold', status: 'abandoned', ownership: own('personal', this.me) };
  }

  afterPlace(i, part = null) {
    const k = `${i.pos.x},${i.pos.y},${i.pos.z}`;
    this.recentPlace.set(k, Date.now());
    const meta = this.placeMeta(i.name);
    if (this.ledger) this.ledger.record(this.me, { type: 'place', dim: this.dim(), pos: i.pos, block: i.name, by: this.me, ...meta, ...(part ? { part } : {}), gameTime: this.agent.memory.gameNow ?? null });
    if (this.knowledge) {
      const o = meta.ownership || {};
      const e = this.knowledge.learn(this.dim(), i.pos, { block: i.name, owner: o.owner ?? this.me, kind: o.kind === 'personal' ? 'personal' : o.kind, source: 'self', tick: this.tick(), purpose: meta.purpose, force: true });
      if (part && e) e.part = part;
    }
    // ベッドは2マス (足の側に置くと、向いている方に頭の側ができる)。頭の側も同じ持ち主の物として残す
    if (/_bed$/.test(i.name) && !part && this.bot && typeof this.bot.blockAt === 'function') {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        try {
          const b = this.bot.blockAt(new Vec3(i.pos.x + dx, i.pos.y, i.pos.z + dz));
          if (b && b.name === i.name && typeof b.getProperties === 'function' && b.getProperties().part === 'head') { this.afterPlace({ ...i, pos: { x: i.pos.x + dx, y: i.pos.y, z: i.pos.z + dz } }, 'head'); break; }
        } catch (_) { /* ignore */ }
      }
    }
  }

  // 掘る直前: 台帳で置かれた物なら、行動の意図で覆われていないもの (天然と誤認・行動とは別の掘り) を ground truth の記録にする
  beforeDig(i) {
    if (!this.ledger) return;
    this.ledger.sync({ force: Date.now() - this.ledger.lastSync > 500 });
    let truth = this.ledger.lookup(this.dim(), i.pos);
    if (truth && !sameFamily(truth.block, i.name)) truth = null;
    // 台帳に無い、見た目で人の置いた物 (村・遺跡など、ワールドが作った物か、記録の前に置かれた物): 持ち主の無い置かれた物として記録する
    if (!truth && O.ARTIFACT.test(i.name)) truth = WORLD_TRUTH;
    if (!truth && STRUCTURAL.test(i.name) && this.nextToWorldArtifact(i.pos)) truth = STRUCTURE_TRUTH;
    if (!truth) return;
    const c = this.cur;
    if (c && c.intent && samePos(c.intent.target.pos, i.pos)) return; // take_placed などの意図の通り
    if (truth.status === 'abandoned' && truth.placedBy !== this.me) { this.digNote = { pos: i.pos, reasonCode: null }; return; } // 足場の残り
    if (truth.placedBy === this.me && (!c || c.action !== 'collect')) { this.digNote = { pos: i.pos, reasonCode: null }; return; } // 自分の物を自分で (道を作るなど)
    // 行動の対象でない物を掘った (collect の途中で pathfinder が道をあけた・take_placed で別の所を掘った) → 「<行動>_path」として accidental
    let action = c ? c.action : null;
    const target = c && c.choice ? c.choice.block || null : null;
    if (action === 'collect' && target && !sameFamily(target, i.name) && target !== i.name) action = 'collect_path';
    if (TAKE_LIKE.has(action) && action !== 'collect') action = `${action}_path`;
    const r = O.decideReason({ action, modelOn: this.on, block: i.name, needs: this.needsNow() });
    const it = this.intentRecord({ action: action || 'none', block: i.name, pos: i.pos, category: 'natural', owner: null, perspective: 'ground_truth', reason: r, truth,
      harm: O.functionalHarm(i.name, this.harmFacts(i.pos, i.name)), alternatives: [], permission: 'not_applicable', socialCostV: 0 });
    this.digNote = { pos: i.pos, reasonCode: r.reasonCode, intentId: it.id };
  }

  afterDig(i, ok) {
    const note = this.digNote && samePos(this.digNote.pos, i.pos) ? this.digNote : null;
    this.digNote = null;
    if (!ok) return;
    this.forgetDugPlace(i);
    const c = this.cur;
    const viaIntent = c && c.intent && samePos(c.intent.target.pos, i.pos) ? c.intent : null;
    if (this.ledger && this.ledger.lookup(this.dim(), i.pos)) {
      this.ledger.record(this.me, { type: 'remove', dim: this.dim(), pos: i.pos, block: i.name, by: this.me, action: c ? c.action : null,
        reasonCode: viaIntent ? viaIntent.reasonCode : note ? note.reasonCode : null, intentId: viaIntent ? viaIntent.id : note ? note.intentId || null : null });
    }
    if (this.knowledge) {
      const e = this.knowledge.get(this.dim(), i.pos);
      if (e && e.owner === this.me && e.kind === 'personal') this.knowledge.remove(this.dim(), i.pos);
      else if (e) this.knowledge.mark(this.dim(), i.pos, 'taken', { takenBy: this.me, takenAt: this.tick() });
    }
  }

  // 自分で掘った物の場所を記憶から消す (同じ種類がもう近くに無いとき)。2026-11-10: 自分で取った松明の場所へ行って空振りしていた
  forgetDugPlace(i) {
    const m = this.agent.memory;
    const bot = this.bot;
    if (!m || typeof m.forgetPlace !== 'function' || !(m.places || []).some((q) => q.kind === i.name && Math.hypot(q.x - i.pos.x, q.z - i.pos.z) <= 12)) return;
    try {
      const type = bot && bot.registry && bot.registry.blocksByName[i.name];
      const left = type && typeof bot.findBlocks === 'function' ? bot.findBlocks({ matching: type.id, maxDistance: 8, count: 2, point: new Vec3(i.pos.x, i.pos.y, i.pos.z) }).filter((p) => !samePos(p, i.pos)) : [];
      if (!left.length) { m.forgetPlace(i.name, i.pos, 12); this.write({ event: 'place_forgotten', kind: i.name, pos: i.pos, why: 'dug_by_me' }); }
    } catch (_) { /* ignore */ }
  }

  // すぐ隣 (26マス) に、台帳に無い人工物があるか (村の家の一部の見分け。評価用)
  nextToWorldArtifact(pos) {
    const bot = this.bot;
    if (!bot || typeof bot.blockAt !== 'function') return false;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      if (!dx && !dy && !dz) continue;
      const q = { x: pos.x + dx, y: pos.y + dy, z: pos.z + dz };
      let b = null;
      try { b = bot.blockAt(new Vec3(q.x, q.y, q.z)); } catch (_) { b = null; }
      if (b && O.ARTIFACT.test(b.name) && !/^(farmland|wheat|carrots|potatoes|beetroots)$/.test(b.name) && !(this.ledger && this.ledger.lookup(this.dim(), q))) return true;
    }
    return false;
  }

  // 村人を見かけた所を覚える (村の物の見分け。見た事実だけ)
  noteVillagers(raw) {
    const vs = (raw.entities || []).filter((e) => e.name === 'villager' && e.pos);
    if (!vs.length) return;
    const list = this.store.villagers || (this.store.villagers = []);
    for (const v of vs) {
      const p = { x: Math.round(v.pos.x), y: Math.round(v.pos.y), z: Math.round(v.pos.z) };
      const near = list.find((q) => Math.hypot(q.x - p.x, q.z - p.z) <= 8);
      if (near) { near.tick = this.tick(); continue; }
      list.push({ ...p, tick: this.tick() });
      if (list.length > this.cfg.village.keep) list.shift();
    }
  }

  isVillage(dim, pos) {
    if (normDim(dim) !== 'minecraft:overworld') return false;
    const p = Array.isArray(pos) ? { x: pos[0], z: pos[2] } : pos;
    return (this.store.villagers || []).some((q) => Math.hypot(q.x - p.x, q.z - p.z) <= this.cfg.village.radius);
  }

  needsNow() { try { return this.agent.social.needsModel.effective(); } catch (_) { return {}; } }

  // ---- 観察 (毎判断) ----
  observe(raw) {
    this.lastRaw = raw;
    this.noteVillagers(raw);
    const bot = this.bot;
    if (!bot || typeof bot.blockAt !== 'function') return;
    const dim = this.dim();
    const here = raw.self.pos;
    const vr = (this.agent.cfg.perception && this.agent.cfg.perception.visionRadius) || 16;
    const nameAt = (p) => { try { const b = bot.blockAt(new Vec3(p.x, p.y, p.z)); return b ? b.name : null; } catch (_) { return null; } };
    // 台帳: 近くの置かれた物が、記録なしに無くなっていたら gone (誰がしたかは分からない。ground truth の維持)
    if (this.ledger) {
      this.ledger.sync();
      for (const e of this.ledger.near(dim, here, vr)) {
        if (e.status !== 'active' && e.status !== 'abandoned') continue;
        // 置いたばかりの物は、ほかのクライアントの表示に届くまで空気に見えることがある (2026-11-11 の実行1: 0.7秒後に gone と書かれた)
        if (Date.now() - Date.parse(e.placedAt) < (this.cfg.goneGraceMs ?? 15000)) continue;
        const n = nameAt(P(e.position));
        if (n && !sameFamily(n, e.block) && n !== e.block) this.ledger.record(this.me, { type: 'gone', dim, pos: e.position, block: e.block, by: this.me, now: n });
      }
    }
    if (!this.knowledge) return;
    // 知識: 見える所の知っている物が無くなっていた・戻っていた
    for (const e of this.knowledge.near(dim, here, vr)) {
      const p = P(e.pos);
      const n = nameAt(p);
      if (!n) continue;
      const present = sameFamily(n, e.block) || n === e.block;
      if (e.status === 'present' && !present) {
        if (!blockVisible(bot, new Vec3(p.x, p.y, p.z))) continue;
        this.knowledge.mark(dim, p, 'missing', { missingAt: this.tick() });
        if (e.owner === this.me || (e.kind === 'group' && e.owner === this.me)) this.noticeLoss(e, null, 'discovered');
      } else if ((e.status === 'missing' || e.status === 'taken') && present) {
        this.knowledge.mark(dim, p, 'present');
        const loss = this.store.losses.find((l) => samePos(P(l.pos), p) && !l.restored);
        if (loss) { loss.restored = this.tick(); this.write({ event: 'ownership_loss', kind: 'restored_seen', pos: e.pos, block: e.block, culprit: loss.culprit || null }); }
      }
    }
    // 忘れる (記憶の忘れ方と同じ式。memory.limits.promptItems > 0 のときだけ)
    const m = this.agent.memory;
    if (m.limits && m.limits.promptItems > 0) this.knowledge.forget((e) => m.strength(e, e.t), m.limits.forgetBelow);
    // 許可は permitTicks で切れる
    for (const [k, v] of Object.entries(this.store.permits)) if (this.tick() - v.tick > this.cfg.permitTicks) delete this.store.permits[k];
  }

  // 自分の物が無くなった (culprit: 分かった相手 | null、how: discovered | witnessed | heard | told)
  noticeLoss(e, culprit, how, extra = {}) {
    const p = P(e.pos);
    let loss = this.store.losses.find((l) => samePos(P(l.pos), p) && !l.restored);
    if (!loss) { loss = { pos: [p.x, p.y, p.z], block: e.block, culprit: null, how, tick: this.tick(), explained: false }; this.store.losses.push(loss); if (this.store.losses.length > 60) this.store.losses.shift(); }
    const firstCulprit = culprit && !loss.culprit;
    if (culprit) loss.culprit = culprit;
    this.write({ event: 'ownership_loss', kind: how, pos: loss.pos, block: e.block, culprit: loss.culprit, ...extra });
    // わだかまり (conflict_agent.js): 取られた相手が分かったとき (見た・聞いた・本人から聞いた)
    if (firstCulprit && this.agent.conflict) this.agent.conflict.grieve(culprit, how === 'witnessed' ? 'took_witnessed' : how === 'told' ? 'took_told' : 'took_heard', { item: O.itemOf(e.block), force: true });
    if (!this.cfg.social) return loss;
    if (how === 'discovered' && !loss.culprit) this.applyImpact(null, O.socialImpact('discovered', { temperament: this.agent.social.temperament }, this.cfg), { pos: loss.pos, block: e.block });
    else if (firstCulprit) {
      const times = (this.store.takesBy[culprit] = (this.store.takesBy[culprit] || 0) + 1);
      const kind = how === 'witnessed' ? 'witnessed' : how === 'told' ? 'told' : 'heard';
      this.applyImpact(culprit, O.socialImpact(kind, { temperament: this.agent.social.temperament, times, reasonCode: extra.reasonCode || null, explained: how === 'told' }, this.cfg), { pos: loss.pos, block: e.block, how });
    }
    return loss;
  }

  applyImpact(name, imp, extra = {}) {
    if (!imp) return;
    const s = this.agent.social;
    const before = name && s.relations[name] ? { affinity: s.relations[name].affinity, trust: s.relations[name].trust } : null;
    const applied = s.applyOwnershipImpact(name, imp);
    this.counts.social += 1;
    this.write({ event: 'ownership_social', who: name, ...imp, ...extra, before, after: applied });
  }

  // ---- blockUpdate (agent の watchOthers から): 置いた・壊したのを見た ----
  //   who: others.js が見分けた壊した人 (いなければ null)。players: [{ name, pos, held }]
  onBlockChange({ pos, oldName, newName, who = null, how = null, players = [], me = null }) {
    if (!this.knowledge || !pos) return;
    const dim = this.dim();
    const p = P(pos);
    const k = `${p.x},${p.y},${p.z}`;
    const wr = this.cfg.witnessRadius;
    if (me && dist3(me, { x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 }) > wr) return;
    // 置いた: 空気など → 固い物/置かれる物。すぐ近くにほかの人が1人だけ (手の物が分かればそれと合う)
    if ((AIRISH.test(oldName) || SOFT.test(oldName)) && !SOFT.test(newName) && !/_leaves$|^(water|lava|fire)$/.test(newName)) {
      const t = this.recentPlace.get(k);
      if (t && Date.now() - t < 5000) return;
      const c = { x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 };
      const close = players.filter((q) => q && q.pos && dist3(q.pos, c) <= this.cfg.nearDist);
      if (close.length !== 1) return;
      const q = close[0];
      // 手の物が分かって、置かれた物と合うときだけ (自然に伸びる・生える物 (ツタ・草・苗木の成長) を、そばにいた人の物にしない。2026-11-11 の実行1でツタが「置いた物」になった)
      if (!q.held || GROWS.test(newName)) return;
      if (!sameFamily(O.itemOf(newName), q.held) && O.itemOf(newName) !== q.held && !(newName.startsWith(q.held.replace(/_seeds$/, '')))) return;
      if (this.bot && !blockVisible(this.bot, new Vec3(p.x, p.y, p.z))) return;
      this.knowledge.learn(dim, p, { block: newName, owner: q.name, kind: 'personal', source: 'seen', tick: this.tick() });
      this.counts.learned += 1;
      return;
    }
    // 壊した: 知っている置かれた物が空気に
    if (!AIRISH.test(newName)) return;
    const e = this.knowledge.get(dim, p);
    if (!e || e.status !== 'present' || !sameFamily(e.block, oldName)) return;
    if (!who) return; // 誰か分からないものは、あとで見たときに missing (observe)
    this.knowledge.mark(dim, p, 'taken', { takenBy: who, takenAt: this.tick() });
    // 許した (許したのを聞いた) 取得は、無断の取得として扱わない
    if (this.permittedTake(who, p)) { this.write({ event: 'ownership_loss', kind: 'permitted_take_seen', pos: [p.x, p.y, p.z], block: e.block, culprit: who, owner: e.owner }); return; }
    if (e.owner === this.me) { this.noticeLoss(e, who, 'witnessed', { seenBy: how }); return; }
    if (e.owner && who !== e.owner) {
      // ほかの人の物を取るのを見た: 取った人への見方が少し下がる。持ち主に伝えるかは maybeGossip
      if (this.cfg.social) this.applyImpact(who, O.socialImpact('third', { temperament: this.agent.social.temperament }, this.cfg), { owner: e.owner, block: e.block, pos: e.pos });
      this.store.witnessed.push({ taker: who, owner: e.owner, block: e.block, pos: e.pos, tick: this.tick(), told: false });
      if (this.store.witnessed.length > 40) this.store.witnessed.shift();
    }
  }

  // ---- 行動の候補に渡す見方 (ctx.own)。知識と見えている物だけから ----
  view(raw, { base = null, goalNames = null } = {}) {
    if (!this.knowledge) return null;
    const dim = this.dim();
    const inv = raw.inventory || [];
    const natural = new Set();
    for (const b of raw.blocks || []) if (b.diggable && naturalPositions(b, { knowledge: this.knowledge, dim }).length) natural.add(b.name);
    const s = this.agent.social;
    const tod = ((raw.self.timeOfDay ?? 6000) % 24000 + 24000) % 24000;
    return {
      me: this.me, dim, knowledge: this.knowledge, cfg: this.cfg,
      hearRadius: (this.agent.cfg.perception && this.agent.cfg.perception.hearRadius) ?? 48, witnessRadius: this.cfg.witnessRadius,
      permit: (pos) => this.store.permits[keyOf(dim, pos)] || null,
      askedRecently: (owner, block) => this.tick() - (this.store.asked[`${owner}:${block}`] ?? -1e9) < this.cfg.askCooldown,
      needs: this.needsNow(), temperament: s.temperament,
      affinity: (n) => (s.relations[n] ? s.relations[n].affinity : null),
      harmFacts: (pos, block) => this.harmFacts(pos, block, raw, tod),
      altView: { inventory: inv, natural, mobs: new Set((raw.entities || []).filter((e) => e.kind === 'mob').map((e) => e.name)), hasPickaxe: inv.some((i) => /_pickaxe$/.test(i.name)), hasFood: (raw.foodCount || 0) > 0 },
      owe: this.store.owe.filter((o) => !(o.returned || o.repaired) || !o.explained),
      base, goalNames,
    };
  }

  // planner (goalpath.world) に渡す見方: 天然と見ている見えている物・置かれた物と認識している見えている物・自分の置いた機能している物の数
  plannerView(raw) {
    if (!this.knowledge) return null;
    const dim = this.dim();
    const naturalVisible = [];
    const placed = {};
    const rank = { own: 0, unknown: 1, public: 2, group: 3, other: 4 };
    for (const b of raw.blocks || []) {
      const ps = b.positions && b.positions.length ? b.positions : [b.nearest];
      let nat = false;
      for (const p of ps) {
        const c = this.knowledge.classify(dim, p, b.name);
        if (c.category === 'natural') nat = true;
        else if (placed[b.name] == null || rank[c.category] < rank[placed[b.name]]) placed[b.name] = c.category;
      }
      if (nat) naturalVisible.push(b.name);
    }
    const ownedPlaced = {};
    for (const e of this.knowledge.list()) {
      if (e.owner !== this.me || e.kind !== 'personal' || e.status !== 'present' || /scaffold/.test(e.purpose || '')) continue;
      const it = O.itemOf(e.block);
      if (e.part === 'head') continue; // ベッドの頭の側 (足の側で1つと数える)
      ownedPlaced[it] = (ownedPlaced[it] || 0) + 1;
    }
    return { naturalVisible, placed, ownedPlaced, countPlaced: !!this.cfg.countPlaced, artifact: (k) => O.ARTIFACT.test(String(k)) };
  }

  // 機能損害の材料 (見えている物・自分の知識・目の前のブロックから)
  harmFacts(pos, block, raw = this.lastRaw, tod = null) {
    const f = {};
    const bot = this.bot;
    const t = tod != null ? tod : raw && raw.self ? ((raw.self.timeOfDay ?? 6000) % 24000 + 24000) % 24000 : 6000;
    f.night = t >= 12542 && t <= 23459;
    const lights = [];
    for (const b of (raw && raw.blocks) || []) if (O.LIGHT[b.name] != null) for (const q of (b.positions && b.positions.length ? b.positions : [b.nearest])) if (!samePos(q, pos)) lights.push(q);
    f.otherLightNear = lights.some((q) => dist3(q, pos) <= 7);
    const nameAt = (x, y, z) => { try { const b = bot && bot.blockAt(new Vec3(x, y, z)); return b ? b : null; } catch (_) { return null; } };
    if (O.WALLISH.test(block) && bot) {
      let n = 0;
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]) {
        const b = nameAt(pos.x + dx, pos.y + dy, pos.z + dz);
        if (!b || b.boundingBox !== 'block') continue;
        const q = { x: pos.x + dx, y: pos.y + dy, z: pos.z + dz };
        const placed = (this.knowledge && this.knowledge.recognized(this.dim(), q, b.name)) || (dy !== -1 && b.name === block);
        if (placed) n += 1;
      }
      f.placedNeighbors = n;
    }
    if (/_bed$/.test(block)) {
      const b = nameAt(pos.x, pos.y, pos.z);
      try { f.bedOccupied = !!(b && typeof b.getProperties === 'function' && String(b.getProperties().occupied) === 'true'); } catch (_) { f.bedOccupied = false; }
      f.otherBedsKnown = this.knowledge ? this.knowledge.list().filter((e) => /_bed$/.test(e.block) && e.status === 'present' && !samePos(P(e.pos), pos)).length : 0;
    }
    if (O.STATION.test(block)) {
      const others = [];
      for (const b of (raw && raw.blocks) || []) if (b.name === block) for (const q of (b.positions && b.positions.length ? b.positions : [b.nearest])) if (!samePos(q, pos)) others.push(dist3(q, pos));
      f.altStationDist = others.length ? Math.min(...others) : null;
      if (O.CONTAINER.test(block)) {
        const c = this.agent.memory.extra && this.agent.memory.extra.containers && this.agent.memory.extra.containers[`${pos.x},${pos.y},${pos.z}`];
        f.containerItems = c && c.items ? c.items.reduce((s, i) => s + (i.count || 0), 0) : 0;
      }
    }
    return f;
  }

  // 本当の代わりの手段 (評価用。見えているかを問わず近く 32 の天然の入手元。台帳の置かれた物は除く)
  truthAlternatives(block) {
    const bot = this.bot;
    if (!bot || typeof bot.findBlocks !== 'function') return null;
    const row = TRUTH_SOURCE.find(([f]) => f(block));
    const blockRe = row ? row[1] : new RegExp(`^${block}$`);
    const mobRe = row ? row[2] : null;
    const out = { blocks: 0, mobs: 0 };
    try {
      if (blockRe) {
        const ps = bot.findBlocks({ matching: (b) => b && blockRe.test(b.name), maxDistance: 32, count: 20 });
        out.blocks = ps.filter((p) => !(this.ledger && this.ledger.lookup(this.dim(), p))).length;
      }
      if (mobRe) out.mobs = Object.values(bot.entities || {}).filter((e) => e && e.position && mobRe.test(e.name || '') && dist3(e.position, bot.entity.position) <= 32).length;
    } catch (_) { return null; }
    out.available = out.blocks > 0 || out.mobs > 0;
    return out;
  }

  // 意図の記録を作って書く
  intentRecord({ action, block, pos, category, owner, perspective = 'agent', reason, truth = undefined, harm, alternatives, permission, socialCostV, choice = null, weight = null, source = null, purpose = null }) {
    this.store.seq = (this.store.seq || 0) + 1;
    const t = this.agent.social.temperament || {};
    // ほかのプロセスの置いた記録が届いていないことがある (2秒ごとの sync)。記録の前に読み足す (2026-11-11 の実行1で、置いたばかりの物が「台帳に無い」になった)
    if (truth === undefined && this.ledger && Date.now() - this.ledger.lastSync > 200) this.ledger.sync({ force: true });
    let tr = truth === undefined ? (this.ledger ? this.ledger.lookup(this.dim(), pos) : null) : truth;
    if (!tr && O.ARTIFACT.test(block)) tr = WORLD_TRUTH;
    const rec = {
      event: 'intent', id: `${this.me}-i${this.store.seq}`, action, perspective,
      target: { block, pos: { x: pos.x, y: pos.y, z: pos.z }, owner: owner || null, ownerKind: category === 'other' ? 'personal' : category, source, purpose },
      reasonCode: reason.reasonCode, rule: reason.rule, motive: reason.motive, need: reason.need, emergency: reason.emergency,
      needs: Object.fromEntries(['hunger', 'sleep', 'safety', 'greed'].map((k) => [k, Math.round((this.needsNow()[k] ?? 0) * 1000) / 1000])),
      traitInfluence: { greed: t.greed ?? null, empathy: t.empathy ?? null, obedience: t.obedience ?? null },
      permission, alternatives, functionalHarm: harm, socialCost: socialCostV,
      intendedRestitution: O.intendedRestitution(reason.reasonCode, t),
      ...(weight ? { weight } : {}),
      // 評価用 (エージェントは知らない): 台帳の置いた人・所有・目的と、本当の代わりの手段
      truth: tr ? { placedBy: tr.placedBy, ownership: tr.ownership, purpose: tr.purpose, status: tr.status, placedAt: tr.placedAt, ownerMatches: owner ? tr.placedBy === owner || (tr.ownership && tr.ownership.owner === owner) : null } : null,
      truthAlternatives: reason.reasonCode === 'emergency_need' || perspective === 'ground_truth' ? this.truthAlternatives(block) : undefined,
      choice: choice || undefined,
    };
    this.write(rec);
    this.counts.intents += 1;
    try { this.agent.log(O.consoleLine(this.me, rec)); } catch (_) { /* ignore */ }
    return rec;
  }

  // ---- 行動の前後 ----
  beforeAct(resolved, ctx) {
    const ch = resolved.choice || {};
    this.cur = { action: resolved.action, arg: resolved.arg, choice: ch, intent: null, tick: this.tick() };
    // 取り返す (conflict.js の take_back): 理由は retaliation
    if (resolved.action === 'take_back' && ch.pos && ch.block) {
      const reason = O.decideReason({ action: 'take_back', category: 'other', block: ch.block, needs: this.needsNow(), alternatives: [] });
      this.cur.intent = this.intentRecord({ action: 'take_back', block: ch.block, pos: ch.pos, category: 'other', owner: ch.player, reason, harm: O.functionalHarm(ch.block, this.harmFacts(ch.pos, ch.block)), alternatives: [],
        permission: 'not_requested', socialCostV: 0, source: 'grudge', choice: `take_back:${resolved.arg}` });
      return this.cur.intent;
    }
    const takeLike = resolved.action === 'take_placed' || resolved.action === 'dismantle_own' || (resolved.action === 'repair_or_relocate_public' && ch.kind === 'relocate');
    if (!takeLike || !ch.own || !ch.pos) return null;
    const i = ch.own;
    const reason = resolved.action === 'take_placed' ? i.reason : O.decideReason({ action: resolved.action, category: i.category, block: i.block, needs: this.needsNow(), alternatives: i.alternatives });
    const w = ctx && ctx.ownWeightInfo ? ctx.ownWeightInfo[`${resolved.action}:${resolved.arg}`] : null;
    this.cur.intent = this.intentRecord({ action: resolved.action, block: i.block, pos: i.pos, category: i.category, owner: i.owner, reason, harm: i.harm, alternatives: i.alternatives,
      permission: i.permission, socialCostV: i.socialCost, weight: w || (resolved.action === 'take_placed' ? i.weight : null), source: i.source, purpose: i.purpose, choice: `${resolved.action}:${resolved.arg}` });
    return this.cur.intent;
  }

  afterAct(resolved, result) {
    const c = this.cur;
    this.cur = null;
    if (!c) return;
    // ふつうの give で、取った相手に同じ物を渡した → 返したことにする
    if (c.action === 'give' && result && result.ok && result.gave) {
      const o = this.store.owe.find((x) => x.owner === result.gave.to && !x.returned && !x.repaired && O.itemOf(x.block) === result.gave.item);
      if (o) this.afterAmends({ kind: 'return', oweId: o.id, player: o.owner, item: result.gave.item }, result);
    }
    const it = c.intent;
    if (it) {
      const taken = result && result.taken;
      this.write({ event: 'take', intentId: it.id, action: c.action, reasonCode: it.reasonCode, ok: !!(result && result.ok && taken), block: it.target.block, owner: it.target.owner, ownerKind: it.target.ownerKind,
        pos: it.target.pos, got: taken ? taken.got : 0, msg: result ? String(result.msg || '').slice(0, 120) : null, gone: !!(result && result.gone) });
      if (taken) this.counts.takes += 1;
      // 返す・説明する相手の記録 (自分の物・許可あり・共同の物の移設は除く)
      if (taken && c.action === 'take_placed' && it.permission !== 'granted') {
        this.store.owe.push({ id: it.id, owner: it.target.owner, ownerKind: it.target.ownerKind, block: it.target.block, pos: [it.target.pos.x, it.target.pos.y, it.target.pos.z], reasonCode: it.reasonCode, tick: this.tick(), explained: false, returned: false, repaired: false });
        if (this.store.owe.length > 30) this.store.owe.shift();
      }
    }
  }

  // ---- 発話 ----
  async phrase(kind, rec) {
    const fallback = O.templateText(kind, rec);
    const tk = this.agent.talker;
    if (this.cfg.speech !== 'llm' || !tk || typeof tk.run !== 'function') return { text: fallback, via: 'template' };
    const persona = this.agent.cfg.persona;
    const facts = {
      ask: `${rec.owner}が置いた${rec.block}を使わせてもらえるか聞く${rec.emergency ? '。今どうしても要る' : ''}`,
      answer: rec.yes ? `${rec.to}に、${rec.block}を使ってよいと答える` : `${rec.to}に、${rec.block}は使わないでほしいと答える${rec.grudgeWord ? `。理由: 前に${rec.to}に${rec.grudgeWord}` : ''}`,
      explain: `${rec.owner}に、${rec.owner}の${rec.block}を取ったことを話す。理由: ${{ emergency_need: 'どうしても必要で、ほかに手段が無かった', unknown_ownership: '誰の物か知らなかった', mistaken_as_natural: '人の物だと気づかなかった', selfish_acquisition: '自分が欲しかった', permission_granted: '許してもらった' }[rec.reasonCode] || rec.reasonCode}`,
      returned: `${rec.owner}に、取った${rec.block}を返す`,
      repaired: `${rec.owner}の${rec.block}を元の所に戻したと伝える`,
      rumor: `${rec.owner}に、${rec.taker}が${rec.owner}の${rec.block}を取っていたのを見たと伝える`,
    }[kind];
    if (!facts) return { text: fallback, via: 'template' };
    const messages = [
      { role: 'system', content: [`あなたは Minecraft の世界にいる「${persona.name}」。${persona.personality || ''}`, persona.speech ? `話し方: ${persona.speech}` : '',
        '次の「伝えること」だけを、近くの人に言う短い日本語(30字以内)にする。書いていないことは言わない。JSON {"say":"..."} だけを出力する。'].filter(Boolean).join('\n') },
      { role: 'user', content: `## 伝えること\n${facts}\n話すことを JSON で。` },
    ];
    try {
      const r = await tk.run('talk', messages);
      if (r && r.say) return { text: r.say, via: 'llm' };
    } catch (_) { /* 文の失敗は型どおりの文で */ }
    return { text: fallback, via: 'template' };
  }

  async sendLine(kind, rec, mk) {
    const ph = await this.phrase(kind, rec);
    const line = mk(ph.text);
    try { this.bot.chat(line.slice(0, 250)); } catch (e) { return { ok: false, line, via: ph.via, error: e.message }; }
    this.agent.memory.noteHeard('自分', ph.text);
    return { ok: true, line, text: ph.text, via: ph.via };
  }

  // ask_permission (act_own.js から)
  async askPermission(ch) {
    const i = ch.own || {};
    const id = `${this.me}-${this.tick()}`;
    const rec = { id, block: ch.block, pos: ch.pos, owner: ch.player, emergency: !!i.emergency };
    this.store.asked[`${ch.player}:${ch.block}`] = this.tick();
    this.pendingAsk = { id, owner: ch.player, reply: null };
    const s = await this.sendLine('ask', rec, (text) => O.line.ask(rec, text));
    const t0 = Date.now();
    while (!this.pendingAsk.reply && Date.now() - t0 < this.cfg.askWaitMs && !this.agent.stopped) await new Promise((r) => setTimeout(r, 250));
    const reply = this.pendingAsk.reply;
    this.pendingAsk = null;
    const answer = reply ? (reply.yes ? 'granted' : 'denied') : 'no_answer';
    if (reply) this.store.permits[keyOf(this.dim(), ch.pos)] = { owner: ch.player, granted: reply.yes, tick: this.tick() };
    this.write({ event: 'ownership_ask', id, owner: ch.player, block: ch.block, pos: ch.pos, emergency: rec.emergency, answer, waitedMs: Date.now() - t0, said: s.text || null, via: s.via, harm: i.harm || null });
    if (reply && !reply.yes && this.agent.conflict) this.agent.conflict.grieve(ch.player, 'denied', { item: ch.block });
    if (!reply) { this.agent.social.onIgnored(ch.player); return { ok: false, msg: `${ch.player}に${ch.block}を使ってよいか聞いたが、返事がなかった`, msgEn: `asked ${ch.player} about the ${ch.block}; no answer`, permission: answer }; }
    return { ok: true, msg: `${ch.player}に${ch.block}を使ってよいか聞いた: ${reply.yes ? 'いいと言われた' : '断られた'}「${reply.text || ''}」`, msgEn: `asked ${ch.player} about the ${ch.block}; ${reply.yes ? 'they said yes' : 'they said no'}`, permission: answer };
  }

  // make_amends の explain
  async explainTake(ch) {
    const list = this.store.owe.filter((o) => o.owner === ch.player && !o.explained);
    const o = list[list.length - 1];
    if (!o) return { ok: false, msg: `${ch.player}に話すことが無い` };
    const rec = { block: o.block, pos: o.pos, owner: o.owner, reasonCode: o.reasonCode };
    const s = await this.sendLine('explain', rec, (text) => O.line.explain(rec, text));
    for (const x of list) x.explained = true;
    this.write({ event: 'ownership_amends', kind: 'explain', owner: o.owner, block: o.block, pos: o.pos, reasonCode: o.reasonCode, intentId: o.id, said: s.text || null, via: s.via, ok: s.ok });
    return { ok: s.ok, msg: `${o.owner}に${o.block}を取ったことを話した「${s.text || ''}」`, msgEn: `told ${o.owner} about taking their ${o.block}`, amends: { kind: 'explain', owner: o.owner } };
  }

  afterAmends(ch, r) {
    const o = this.store.owe.find((x) => x.id === ch.oweId) || null;
    if (!r || !r.ok || !o) { this.write({ event: 'ownership_amends', kind: ch.kind, owner: ch.player || ch.owner || null, block: o ? o.block : ch.block || null, ok: false, msg: r ? String(r.msg || '').slice(0, 80) : null }); return; }
    if (ch.kind === 'return') o.returned = true;
    if (ch.kind === 'repair') o.repaired = true;
    this.write({ event: 'ownership_amends', kind: ch.kind, owner: o.owner, block: o.block, pos: o.pos, reasonCode: o.reasonCode, intentId: o.id, ok: true });
    if (o.owner) {
      const rec = ch.kind === 'return' ? { item: ch.item, n: 1, owner: o.owner, block: o.block } : { block: o.block, pos: o.pos, owner: o.owner };
      this.sendLine(ch.kind === 'return' ? 'returned' : 'repaired', rec, (text) => (ch.kind === 'return' ? O.line.returned(rec, text) : O.line.repaired(rec, text))).catch(() => {});
    }
  }

  afterPublicRepair(ch, r) {
    this.write({ event: 'ownership_public', kind: ch.kind, block: ch.block, pos: ch.pos, owner: ch.owner || null, ok: !!(r && r.ok) });
    if (r && r.ok && ch.kind === 'repair' && this.knowledge) this.knowledge.mark(this.dim(), ch.pos, 'present');
  }

  // 共有のチェスト (board の share)。知識を public に。自分が共有にしたら台帳の所有も変える
  onShare(pos, by) {
    if (this.knowledge) this.knowledge.learn(this.dim(), pos, { block: 'chest', owner: by, kind: 'public', source: 'project', tick: this.tick(), force: true });
    if (this.ledger && by === this.me && this.ledger.lookup(this.dim(), pos)) this.ledger.record(this.me, { type: 'reclassify', dim: this.dim(), pos, by: this.me, ownership: { kind: 'public', owner: by }, projectId: 'shared_chest' });
  }

  // 許可のあった取得か (自分が許した・許したのを聞いた)。key は "取った人|位置"
  //   2026-11-11 の実行で、持ち主が許した取得を見た人たちが噂として伝え、持ち主自身も伝聞として好感を下げていた
  permittedTake(taker, pos, block = null) {
    const g = this.store.granted || {};
    const ks = pos ? [`${taker}|${keyOf(this.dim(), pos)}`] : Object.keys(g).filter((k) => k.startsWith(`${taker}|`) && (!block || (g[k].block && sameFamily(g[k].block, block))));
    return ks.some((k) => g[k] && this.tick() - g[k].tick <= this.cfg.permitTicks * 2);
  }
  notePermitted(taker, pos, block) {
    const g = this.store.granted || (this.store.granted = {});
    g[`${taker}|${keyOf(this.dim(), pos)}`] = { tick: this.tick(), block };
    for (const k of Object.keys(g)) if (this.tick() - g[k].tick > this.cfg.permitTicks * 4) delete g[k];
  }
  // 同じ取得の噂・伝聞を何度も当てない (何人もが同じことを伝える)。返り値: 初めてなら true
  firstNews(kind, taker, owner, block) {
    const n = this.store.news || (this.store.news = {});
    const k = `${kind}|${taker}|${owner}|${String(block).replace(/^wall_/, '')}`;
    if (this.tick() - (n[k] ?? -1e9) < (this.cfg.gossip.cooldownTicks ?? 20)) return false;
    n[k] = this.tick();
    return true;
  }

  // ---- 近くの声の行 ----
  //   返り値: 近くの声として残す文 (行の頭の印を除いた発話) | null
  onLine(from, m) {
    if (!m) return null;
    const dim = this.dim();
    const T = this.agent.social.temperament;
    const k = this.knowledge;
    if (m.type === 'ask') {
      if (k) k.learn(dim, m.pos, { block: m.block, owner: m.owner, kind: 'personal', source: 'heard', from, tick: this.tick() });
      const asks = this.heardAsks || (this.heardAsks = new Map());
      asks.set(m.id, { from, owner: m.owner, pos: m.pos, block: m.block });
      if (asks.size > 50) asks.delete(asks.keys().next().value);
      if (m.owner === this.me) this.answerAsk(from, m).catch(() => {});
    } else if (m.type === 'answer') {
      if (this.pendingAsk && this.pendingAsk.id === m.id && from === this.pendingAsk.owner) this.pendingAsk.reply = { yes: m.yes, text: m.text };
      // 許したのを聞いた: その人がそこの物を取っても、無断の取得とは見ない
      const a = this.heardAsks && this.heardAsks.get(m.id);
      if (a && m.yes && a.owner === from) this.notePermitted(a.from, a.pos, a.block);
    } else if (m.type === 'explain') {
      if (m.owner === this.me && k) {
        const e = k.get(dim, m.pos) || { pos: m.pos, block: m.block };
        const loss = this.store.losses.find((l) => samePos(P(l.pos), P(m.pos)) && !l.restored);
        if (loss && loss.culprit === from) {
          if (!loss.explained && this.cfg.social) this.applyImpact(from, O.socialImpact('apology', { reasonCode: m.reasonCode, temperament: T }, this.cfg), { pos: m.pos, block: m.block, reasonCode: m.reasonCode });
          loss.explained = true;
        } else {
          const l2 = this.noticeLoss(e, from, 'told', { reasonCode: m.reasonCode });
          l2.explained = true;
        }
        k.mark(dim, m.pos, 'taken', { takenBy: from });
      } else if (k && m.owner) {
        k.learn(dim, m.pos, { block: m.block, owner: m.owner, kind: 'personal', source: 'heard', from, tick: this.tick(), status: 'taken' });
        if (m.reasonCode === 'selfish_acquisition' && this.cfg.social) this.applyImpact(from, O.socialImpact('rumor', { temperament: T, n: 1 }, this.cfg), { owner: m.owner, block: m.block, via: 'explain_heard' });
      }
    } else if (m.type === 'returned' || m.type === 'repaired') {
      if (m.owner === this.me) {
        if (this.cfg.social) this.applyImpact(from, O.socialImpact(m.type, { temperament: T }, this.cfg), { block: m.block || m.item });
        const loss = m.pos ? this.store.losses.find((l) => samePos(P(l.pos), P(m.pos))) : this.store.losses.slice().reverse().find((l) => l.culprit === from && !l.restored);
        if (loss) loss.restored = this.tick();
        if (k && m.pos) k.mark(dim, m.pos, 'present');
      }
    } else if (m.type === 'rumor') {
      if (m.owner === this.me && (this.permittedTake(m.taker, null, m.block) || !this.firstNews('rumor_owner', m.taker, m.owner, m.block))) {
        // 自分が許した取得・もう聞いた取得の噂は、関係を動かさない
      } else if (m.owner === this.me) {
        const loss = this.store.losses.slice().reverse().find((l) => !l.culprit && sameFamily(l.block, m.block));
        if (loss) this.noticeLoss({ pos: loss.pos, block: loss.block }, m.taker, 'heard', { from });
        else if (this.cfg.social) { const times = (this.store.takesBy[m.taker] = (this.store.takesBy[m.taker] || 0) + 1); this.applyImpact(m.taker, O.socialImpact('heard', { temperament: T, times }, this.cfg), { block: m.block, from }); }
      } else if (m.taker !== this.me && this.cfg.social && !this.permittedTake(m.taker, null, m.block) && this.firstNews('rumor', m.taker, m.owner, m.block)) {
        this.applyImpact(m.taker, O.socialImpact('rumor', { temperament: T, n: m.n }, this.cfg), { owner: m.owner, block: m.block, from });
      }
    }
    this.write({ event: 'ownership_heard', from, type: m.type, ...(m.owner ? { owner: m.owner } : {}), ...(m.block ? { block: m.block } : {}), ...(m.reasonCode ? { reasonCode: m.reasonCode } : {}) });
    return m.text || null;
  }

  async answerAsk(from, m) {
    const harm = O.functionalHarm(m.block, this.harmFacts(P(m.pos), m.block));
    const aff = this.agent.social.relations[from] ? this.agent.social.relations[from].affinity : 50;
    // 頼んだ人へのわだかまりの分だけ貸しにくい。断るとき、何をされたかが発話に出る
    const grudge = this.agent.social.grudgeOf ? this.agent.social.grudgeOf(from) : 0;
    const a = O.permissionAnswer({ temperament: this.agent.social.temperament, affinity: aff, harm, emergency: m.emergency, grudge }, this.cfg);
    const rec = { id: m.id, yes: a.yes, to: from, block: m.block, grudgeWord: !a.yes && grudge ? this.agent.social.grudgeWord(from) : '' };
    if (a.yes) this.notePermitted(from, m.pos, m.block);
    const s = await this.sendLine('answer', rec, (text) => O.line.answer(rec, text));
    this.write({ event: 'ownership_permission', to: from, block: m.block, pos: m.pos, yes: a.yes, score: a.score, why: a.why, grudge: grudge || undefined, harm, said: s.text || null, via: s.via });
  }

  // 見た無断の取得を、持ち主が近くにいれば伝える (社交的で、取った人より持ち主と親しいとき)
  maybeGossip(raw) {
    if (!this.knowledge || !this.cfg.social) return null;
    const s = this.agent.social;
    if ((s.temperament.sociability ?? 0.5) < this.cfg.gossip.minSociability) return null;
    const near = peopleOf(raw).filter((p) => p.d <= ((this.agent.cfg.perception && this.agent.cfg.perception.hearRadius) ?? 48));
    const w = this.store.witnessed.find((x) => !x.told && near.some((p) => p.name === x.owner) && x.taker !== x.owner);
    if (!w) return null;
    if (this.tick() - (this.store.rumorAt[w.owner] ?? -1e9) < this.cfg.gossip.cooldownTicks) return null;
    const aff = (n) => (s.relations[n] ? s.relations[n].affinity : 50);
    if (aff(w.owner) < aff(w.taker)) { w.told = 'kept'; return null; }
    w.told = true;
    this.store.rumorAt[w.owner] = this.tick();
    const n = this.store.witnessed.filter((x) => x.taker === w.taker).length;
    const rec = { taker: w.taker, block: w.block, owner: w.owner, n };
    this.sendLine('rumor', rec, (text) => O.line.rumor(rec, text)).then((r) => this.write({ event: 'ownership_rumor', ...rec, said: r.text || null, via: r.via })).catch(() => {});
    return rec;
  }

  snapshot() { return { known: this.knowledge ? Object.keys(this.knowledge.store).length : null, owe: this.store.owe.filter((o) => !o.returned && !o.repaired).length, losses: this.store.losses.filter((l) => !l.restored).length, ...this.counts }; }
}

module.exports = { OwnershipCtl, samePos, TRUTH_SOURCE };
