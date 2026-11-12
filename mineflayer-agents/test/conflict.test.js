'use strict';
// わだかまり (social.js) と、悪い関係のときの行動 (conflict.js・conflict_agent.js・act_conflict.js)。2026-11-12 ユーザー決定
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Vec3 } = require('vec3');
const { Social, GRUDGE_DEFAULTS } = require('../src/social');
const C = require('../src/conflict');
const { ConflictCtl } = require('../src/conflict_agent');
const { OwnershipCtl } = require('../src/ownership_agent');
const { Memory } = require('../src/memory');
const { conflictHandlers } = require('../src/act_conflict');
const { listActions } = require('../src/actions');
const { conflictStats, lines } = require('../tools/conflict_stats');
const { conflictOverrides } = require('../run');
const { loadConfig } = require('../src/config');
const O = require('../src/ownership');
const { ADVICE_EN } = require('../src/en');

const on = (extra = {}) => new Social({ temperament: { empathy: 0.5, bravery: 0.5 }, grudge: { enabled: true, ...extra } });
const DIM = 'minecraft:overworld';

test('わだかまり: きっかけで生まれ、好感が下がる。ある間は Jev の採点などで元の値まで戻らない (上限 = 元の好感 − ceilDrop × わだかまり)', () => {
  const s = on();
  s.rel('Masaru').affinity = 60;
  const g = s.addGrudge('Masaru', 'hit');
  assert.strictEqual(g.add, 0.5);
  assert.ok(s.relations.Masaru.affinity < 60);
  assert.strictEqual(s.relations.Masaru.grudge.origin, 60);
  const cap = s.affinityCeiling('Masaru');
  assert.strictEqual(cap, 60 - 15 * 0.5);
  for (let i = 0; i < 30; i++) s.onRelationScore('Masaru', 4); // 「とても良くなった」を何度も
  assert.strictEqual(s.relations.Masaru.affinity, cap);
  assert.ok(s.relations.Masaru.capped > 0);
  // 下がる方には上限が無い
  s.moveAffinity('Masaru', -5);
  assert.ok(s.relations.Masaru.affinity < cap);
  // 何をされたかは、いちばん大きいきっかけ
  s.addGrudge('Masaru', 'complained');
  assert.strictEqual(s.relations.Masaru.grudge.kind, 'hit');
  // 怒りと恐れ
  assert.ok(s.emotions.anger > 0 && s.emotions.fear > 1);
});

test('わだかまり: 時間 (判断) で薄れて消える。謝罪・返却・補修で大きく減り、上限が緩む', () => {
  const s = on({ halfLife: 10 });
  s.rel('Yua').affinity = 60;
  s.addGrudge('Yua', 'took_witnessed', { item: 'torch' });
  const v0 = s.grudgeOf('Yua');
  for (let i = 0; i < 10; i++) s.decayGrudges();
  assert.ok(Math.abs(s.grudgeOf('Yua') - v0 / 2) < 0.01, `${s.grudgeOf('Yua')} ≒ ${v0 / 2}`);
  for (let i = 0; i < 60; i++) s.decayGrudges();
  assert.strictEqual(s.relations.Yua.grudge, undefined);
  // 謝罪
  const t = on();
  t.rel('Yua').affinity = 60;
  t.addGrudge('Yua', 'took_witnessed', { item: 'torch' });
  const capBefore = t.affinityCeiling('Yua');
  t.applyOwnershipImpact('Yua', { kind: 'apology', affinity: 2, trust: 0.04 });
  assert.ok(t.grudgeOf('Yua') <= 0.2 + 1e-9);
  assert.ok(t.affinityCeiling('Yua') > capBefore);
  t.applyOwnershipImpact('Yua', { kind: 'returned', affinity: 3, trust: 0.06 });
  assert.ok(t.grudgeOf('Yua') < 0.1);
  assert.ok(t.eased.length >= 2);
});

test('わだかまり: off (既定) なら今までと同じ (上限なし・きっかけ無視・言葉に出ない)', () => {
  const s = new Social({ temperament: {} });
  assert.strictEqual(s.addGrudge('A', 'hit'), null);
  s.rel('A').affinity = 50;
  s.onIgnored('A');
  assert.strictEqual(s.relations.A.grudge, undefined);
  for (let i = 0; i < 5; i++) s.onRelationScore('A', 4);
  assert.ok(s.relations.A.affinity > 50);
  assert.strictEqual(s.relationWord('A').includes('許していない'), false);
  assert.strictEqual(GRUDGE_DEFAULTS.enabled, false);
});

test('わだかまりの言葉: 何をされたか・まだ許していない (数値は出さない)。関係の言葉の先頭に出る', () => {
  const s = on();
  s.rel('Ken').met = true; s.rel('Ken').affinity = 80;
  s.addGrudge('Masaru', 'took_witnessed', { item: 'acacia_log' });
  assert.match(s.relationWord('Masaru'), /acacia_logを取られた。まだ許していない/);
  const en = s.relationWord('Masaru', { lang: 'en' });
  assert.match(en, /they took my acacia_log; I have not forgiven it yet/);
  assert.ok(!/\d/.test(s.grudgeWord('Masaru')));
  assert.ok(!ADVICE_EN.test(en));
  assert.match(s.words({ maxRelations: 1 }), /Masaru/); // わだかまりのある相手が先
  assert.deepStrictEqual(Object.keys(s.grudges()), ['Masaru']);
  // 返事が無かった (social.onIgnored) もきっかけ
  s.onIgnored('Aoi');
  assert.strictEqual(s.relations.Aoi.grudge.kind, 'ignored');
  assert.strictEqual(s.grieved[0].who, 'Aoi');
  // もらった・教わった で少し減る
  const v = s.grudgeOf('Masaru');
  s.onReceived('Masaru');
  assert.ok(s.grudgeOf('Masaru') < v);
});

// ---- conflict_agent ----
function world() { return new Map(); }
function mkAgent(name, { conflict = { grudge: true, actions: true, aggression: true }, provenance = { actions: true, penalty: true, speech: 'template' }, temperament = {}, blocks = world() } = {}) {
  const writes = [];
  const memory = new Memory({});
  const social = new Social({ temperament: { empathy: 0.5, obedience: 0.5, greed: 0.5, sociability: 0.7, bravery: 0.5, ...temperament } });
  const chat = [];
  const bot = {
    username: name, chat: (t) => chat.push(t), _chat: chat, game: { dimension: 'overworld' }, entity: { position: new Vec3(0, 64, 0), height: 1.62, type: 'player', username: name }, health: 18,
    players: {}, entities: {}, registry: { blocksByName: {} },
    blockAt: (p) => ({ name: blocks.get(`${p.x},${p.y},${p.z}`) || 'air', position: new Vec3(p.x, p.y, p.z), boundingBox: 'block' }),
    findBlocks: () => [], on: () => {},
  };
  const agent = { cfg: { persona: { name }, conflict: { speech: 'template', ...conflict }, provenance, perception: { visionRadius: 16, hearRadius: 48 } }, memory, social,
    recorder: { write: (o) => writes.push(o) }, log: () => {}, talker: null, others: {}, stopped: false, bot };
  agent.conflict = new ConflictCtl(agent);
  agent.own = new OwnershipCtl(agent, { recordDir: null });
  return { agent, ctl: agent.conflict, writes, bot };
}
const ev = (w, e) => w.filter((x) => x.event === e);
const player = (bot, name, pos) => { const e = { type: 'player', username: name, position: new Vec3(pos.x, pos.y, pos.z), height: 1.8 }; bot.players[name] = { username: name, entity: e }; bot.entities[name] = e; return e; };

test('殴られた: 直前に腕を振った、手の届く所の人を見分けて、わだかまり (hit)・恐れ・怒り。敵がすぐ近くなら人のせいにしない', () => {
  const a = mkAgent('Aoi');
  player(a.bot, 'Masaru', { x: 1.5, y: 64, z: 0 });
  player(a.bot, 'Ken', { x: 3, y: 64, z: 0 });
  const t = Date.now();
  a.ctl.swings.set('Masaru', t - 200);
  a.ctl.onHurt(a.bot.entity, t);
  assert.strictEqual(ev(a.writes, 'hit_received')[0].from, 'Masaru');
  const g = ev(a.writes, 'grudge')[0];
  assert.deepStrictEqual([g.who, g.kind], ['Masaru', 'hit']);
  assert.ok(g.emotions.fear > 1 && g.emotions.anger > 0);
  assert.ok(a.agent.social.relations.Masaru.affinity < 50);
  assert.strictEqual(a.ctl.store.hitBy.Masaru, 0);
  // 腕を振っていない・遠い人は見ない
  const b = mkAgent('Aoi');
  player(b.bot, 'Ken', { x: 1, y: 64, z: 0 });
  b.ctl.swings.set('Ken', t - 5000);
  b.ctl.onHurt(b.bot.entity, t);
  assert.strictEqual(ev(b.writes, 'hit_received').length, 0);
  // ゾンビがすぐ近く → 人のせいにしない
  const c = mkAgent('Aoi');
  player(c.bot, 'Masaru', { x: 1.5, y: 64, z: 0 });
  c.bot.entities.z = { type: 'hostile', name: 'zombie', position: new Vec3(1, 64, 1) };
  c.ctl.swings.set('Masaru', t - 100);
  c.ctl.onHurt(c.bot.entity, t);
  assert.strictEqual(ev(c.writes, 'hit_received').length, 0);
  // サーバーが傷を負わせたエンティティを知らせたら、腕を振ったかに関係なくその人 (2026-11-12 の生の確認で、腕を振った知らせが来ないことがあった)
  const d = mkAgent('Aoi');
  const m = player(d.bot, 'Masaru', { x: 3, y: 64, z: 0 });
  d.ctl.onHurt(d.bot.entity, t, m);
  assert.strictEqual(ev(d.writes, 'hit_received')[0].from, 'Masaru');
  // 傷の元がプレイヤーでない (ゾンビ・矢) → 人のせいにしない
  const e2 = mkAgent('Aoi');
  player(e2.bot, 'Masaru', { x: 1.5, y: 64, z: 0 });
  e2.ctl.swings.set('Masaru', t - 100);
  e2.ctl.onHurt(e2.bot.entity, t, { type: 'hostile', name: 'zombie' });
  assert.strictEqual(ev(e2.writes, 'hit_received').length, 0);
  // 見ていた人: 自分が殴った分は数えない
  const k = mkAgent('Ken');
  const v = player(k.bot, 'Aoi', { x: 4, y: 64, z: 0 });
  k.ctl.onHurt(v, t, k.bot.entity);
  assert.strictEqual(ev(k.writes, 'hit_seen').length, 0);
});

test('人が人を殴るのを見た → 殴った人への見方が下がる (わだかまりにはしない)。助けての声を聞いた人も同じ', () => {
  const k = mkAgent('Ken');
  const victim = player(k.bot, 'Aoi', { x: 4, y: 64, z: 0 });
  player(k.bot, 'Masaru', { x: 5, y: 64, z: 0 });
  const t = Date.now();
  k.ctl.swings.set('Masaru', t - 100);
  k.ctl.onHurt(victim, t);
  assert.deepStrictEqual([ev(k.writes, 'hit_seen')[0].attacker, ev(k.writes, 'hit_seen')[0].victim], ['Masaru', 'Aoi']);
  assert.ok(k.agent.social.relations.Masaru.affinity < 50);
  assert.strictEqual(k.agent.social.relations.Masaru.grudge, undefined);
  k.ctl.onHurt(victim, t + 100); // 同じ組は10秒に1回
  assert.strictEqual(ev(k.writes, 'hit_seen').length, 1);
  const h = mkAgent('Hana');
  const said = h.ctl.onLine('Aoi', C.parseLine(C.line.help({ attacker: 'Masaru' }, '助けて')));
  assert.strictEqual(said, '助けて');
  assert.ok(h.agent.social.relations.Masaru.affinity < 50);
});

test('殺された・殺した: 死亡メッセージから。殺されたのは強いきっかけ', () => {
  const a = mkAgent('Aoi');
  player(a.bot, 'Masaru', { x: 1, y: 64, z: 0 });
  a.ctl.onDeathMessage('death.attack.player', 'Aoi was slain by Masaru');
  assert.strictEqual(ev(a.writes, 'killed_by')[0].who, 'Masaru');
  assert.strictEqual(a.agent.social.relations.Masaru.grudge.kind, 'killed');
  assert.ok(a.agent.social.grudgeOf('Masaru') >= 0.9);
  a.ctl.onDeathMessage('death.attack.mob', 'Aoi was slain by Zombie');
  assert.strictEqual(ev(a.writes, 'killed_by').length, 1);
  const m = mkAgent('Masaru');
  m.ctl.onOtherDeath('death.attack.player', 'Aoi was slain by Masaru');
  assert.strictEqual(ev(m.writes, 'kill')[0].victim, 'Aoi');
});

test('きっかけの広さ: 呼んだのに来なかった/来た、ベッドを先に使われた、掘った物を先に拾われた、取り決めを破られた、文句を言われた、許可を断られた、物を取られた', async () => {
  const a = mkAgent('Aoi');
  player(a.bot, 'Ken', { x: 40, y: 64, z: 0 });
  a.ctl.afterAct({ action: 'call', arg: 'Ken', choice: { player: 'Ken' } }, { ok: true });
  const raw = (ps) => ({ self: { pos: { x: 0, y: 64, z: 0 } }, entities: [], people: ps });
  for (let i = 0; i < 6; i++) { a.agent.memory.tick += 1; a.ctl.observe(raw([{ name: 'Ken', pos: { x: 40, y: 64, z: 0 }, d: 40 }])); }
  assert.strictEqual(ev(a.writes, 'grudge').find((g) => g.kind === 'call_ignored').who, 'Ken');
  // 来た
  player(a.bot, 'Hana', { x: 30, y: 64, z: 0 });
  a.ctl.afterAct({ action: 'call', arg: 'Hana', choice: { player: 'Hana' } }, { ok: true });
  a.agent.memory.tick += 1;
  a.ctl.observe(raw([{ name: 'Hana', pos: { x: 3, y: 64, z: 0 }, d: 3 }]));
  assert.strictEqual(ev(a.writes, 'call_came')[0].who, 'Hana');
  // ベッドを先に使われた (すぐ近くの人)。村人だけなら誰のせいにもしない
  player(a.bot, 'Mai', { x: 10, y: 64, z: 10.5 });
  a.ctl.afterAct({ action: 'sleep', arg: 'white_bed', choice: { pos: { x: 10, y: 64, z: 10 } } }, { ok: false, msg: '寝られなかった: the bed is occupied' });
  assert.ok(ev(a.writes, 'grudge').some((g) => g.kind === 'bed_taken' && g.who === 'Mai'));
  const n0 = ev(a.writes, 'grudge').length;
  a.ctl.afterAct({ action: 'sleep', arg: 'white_bed', choice: { pos: { x: 90, y: 64, z: 90 } } }, { ok: false, msg: '寝られなかった: the bed is occupied' });
  assert.strictEqual(ev(a.writes, 'grudge').length, n0);
  // 掘った物を先に拾われた・取り決めを破られた (同じ取り決めは一度)・文句を言われた
  a.ctl.onSnatched('Yua', 'oak_log');
  a.ctl.onBreach('Ryo', 'Aoi#3'); a.ctl.onBreach('Ryo', 'Aoi#3');
  a.ctl.onLine('Sota', C.parseLine(C.line.complain({ target: 'Aoi', kind: 'took_witnessed' }, 'ひどい')));
  const kinds = ev(a.writes, 'grudge').map((g) => `${g.who}:${g.kind}`);
  for (const k of ['Yua:snatched', 'Ryo:breach', 'Sota:complained']) assert.ok(kinds.includes(k), k);
  assert.strictEqual(kinds.filter((k) => k === 'Ryo:breach').length, 1);
  // 同じ相手・同じきっかけは cooldown の間に一度
  a.ctl.onSnatched('Yua', 'oak_log');
  assert.strictEqual(ev(a.writes, 'grudge').filter((g) => g.kind === 'snatched').length, 1);
  // 物を取られた (目撃): ownership から
  a.agent.own.knowledge.learn(DIM, [2, 64, 0], { block: 'torch', owner: 'Aoi', source: 'self', tick: 0 });
  a.agent.own.onBlockChange({ pos: { x: 2, y: 64, z: 0 }, oldName: 'torch', newName: 'air', who: 'Masaru', players: [], me: { x: 0, y: 64, z: 0 } });
  const tw = ev(a.writes, 'grudge').find((g) => g.kind === 'took_witnessed');
  assert.deepStrictEqual([tw.who, tw.item], ['Masaru', 'torch']);
  // 記憶にも残る
  assert.ok(a.agent.memory.events.some((e) => e.action === 'wronged' && /Masaru/.test(e.msg)));
  // 許可を断られた
  const y = mkAgent('Yua');
  const p = y.agent.own.askPermission({ player: 'Miho', block: 'torch', pos: { x: 2, y: 64, z: 0 }, own: {} });
  await new Promise((r) => setTimeout(r, 20));
  y.agent.own.onLine('Miho', O.parseLine(O.line.answer({ id: 'Yua-0', yes: false }, 'だめ')));
  await p;
  assert.ok(ev(y.writes, 'grudge').some((g) => g.kind === 'denied' && g.who === 'Miho'));
});

test('許可の答え: 頼んだ人へのわだかまりの分だけ貸しにくい。断るときに何をされたかが発話の材料になる', async () => {
  const base = { temperament: { empathy: 0.7, obedience: 0.6, greed: 0.2 }, affinity: 55, harm: { score: 0.2 } };
  assert.strictEqual(O.permissionAnswer(base).yes, true);
  const g = O.permissionAnswer({ ...base, grudge: 0.6 });
  assert.strictEqual(g.yes, false);
  assert.strictEqual(g.why, 'grudge');
  const m = mkAgent('Miho', { temperament: { empathy: 0.7, obedience: 0.6, greed: 0.2 } });
  m.agent.social.rel('Yua').affinity = 55;
  m.ctl.grieve('Yua', 'took_witnessed', { item: 'torch' });
  m.agent.own.onLine('Yua', O.parseLine(O.line.ask({ id: 'Yua-9', block: 'torch', pos: [2, 64, 0], owner: 'Miho' }, '')));
  await new Promise((r) => setTimeout(r, 20));
  const p = ev(m.writes, 'ownership_permission')[0];
  assert.strictEqual(p.yes, false);
  assert.ok(p.grudge > 0);
});

function rawWith(people, extra = {}) {
  return { self: { name: 'Aoi', pos: { x: 0, y: 64, z: 0 }, health: 20, food: 20, timeOfDay: 6000 }, inventory: [], blocks: [], entities: [], heard: [], craft: { now: [], withTable: [] }, tableNearby: null, people, ...extra };
}
const names = (acts) => acts.map((a) => a.name);
const ids = (acts, n) => (acts.find((a) => a.name === n) || { choices: [] }).choices.map((c) => c.id);

test('悪い関係の行動の候補: わだかまりのある相手が近いときだけ。返してはきっかけが「取られた」とき。殴るは aggression のとき。重みは掛けない', () => {
  const a = mkAgent('Aoi');
  a.agent.social.rel('Masaru').affinity = 50;
  a.ctl.grieve('Masaru', 'took_witnessed', { item: 'acacia_log' });
  a.ctl.grieve('Ken', 'call_ignored'); // 小さい (しきい値未満)
  const people = [{ name: 'Masaru', pos: { x: 5, y: 64, z: 0 }, d: 5 }, { name: 'Ken', pos: { x: 3, y: 64, z: 0 }, d: 3 }];
  const acts = listActions(rawWith(people), { conflict: a.ctl.view(rawWith(people)) });
  for (const n of ['avoid_person', 'complain', 'demand_back', 'hit_person']) assert.ok(names(acts).includes(n), n);
  assert.deepStrictEqual(ids(acts, 'avoid_person'), ['Masaru']);
  assert.deepStrictEqual(ids(acts, 'demand_back'), ['Masaru:acacia_log']);
  assert.ok(!names(acts).includes('call_help'));
  const lab = acts.find((x) => x.name === 'hit_person').choices[0].labelEn;
  assert.match(lab, /they took your acacia_log/);
  for (const x of acts.filter((q) => C.CONFLICT_ACTIONS.includes(q.name))) { assert.ok(!ADVICE_EN.test(x.descEn), x.descEn); for (const c of x.choices) assert.ok(!ADVICE_EN.test(c.labelEn), c.labelEn); }
  // 遠い・いない → 出ない
  assert.ok(!names(listActions(rawWith([]), { conflict: a.ctl.view(rawWith([])) })).includes('avoid_person'));
  // aggression off → 殴るは出ない
  const b = mkAgent('Aoi', { conflict: { grudge: true, actions: true, aggression: false } });
  b.ctl.grieve('Masaru', 'took_witnessed', { item: 'acacia_log' });
  const ba = listActions(rawWith(people), { conflict: b.ctl.view(rawWith(people)) });
  assert.ok(!names(ba).includes('hit_person') && names(ba).includes('complain'));
  // actions off → 候補なし (わだかまりは持つ)
  const c = mkAgent('Aoi', { conflict: { grudge: true, actions: false, aggression: true } });
  c.ctl.grieve('Masaru', 'hit');
  assert.strictEqual(c.ctl.view(rawWith(people)), null);
  assert.ok(c.agent.social.grudgeOf('Masaru') > 0);
  // 言ったばかりの文句は出さない
  a.ctl.store.said['complain|Masaru'] = a.agent.memory.tick;
  assert.ok(!names(listActions(rawWith(people), { conflict: a.ctl.view(rawWith(people)) })).includes('complain'));
});

test('殴られたばかり: やり返す (hit_person)・逃げる (avoid_person)・周りに助けを求める (call_help) が出る', () => {
  const a = mkAgent('Aoi');
  player(a.bot, 'Masaru', { x: 1.5, y: 64, z: 0 });
  a.ctl.swings.set('Masaru', Date.now());
  a.ctl.onHurt(a.bot.entity);
  const people = [{ name: 'Masaru', pos: { x: 2, y: 64, z: 0 }, d: 2 }, { name: 'Ken', pos: { x: 10, y: 64, z: 0 }, d: 10 }];
  const acts = listActions(rawWith(people), { conflict: a.ctl.view(rawWith(people)) });
  assert.deepStrictEqual(ids(acts, 'hit_person'), ['Masaru']);
  assert.ok(acts.find((x) => x.name === 'hit_person').choices[0].retaliation);
  assert.deepStrictEqual(ids(acts, 'call_help'), ['Masaru']);
  assert.ok(names(acts).includes('avoid_person'));
});

test('取り返す: 取られた種類と同じ、その相手の置いた物が見えているとき。理由は retaliation で記録', () => {
  const a = mkAgent('Aoi');
  a.ctl.grieve('Masaru', 'took_witnessed', { item: 'torch' });
  a.agent.own.knowledge.learn(DIM, [4, 64, 0], { block: 'wall_torch', owner: 'Masaru', source: 'seen', tick: 0 });
  const raw = rawWith([{ name: 'Masaru', pos: { x: 6, y: 64, z: 0 }, d: 6 }], { blocks: [{ name: 'wall_torch', diggable: true, nearest: { x: 4, y: 64, z: 0, d: 4 }, positions: [{ x: 4, y: 64, z: 0, d: 4 }] }] });
  const tb = a.ctl.takeBackTargets(raw, a.agent.own);
  assert.deepStrictEqual(tb, [{ player: 'Masaru', block: 'wall_torch', pos: { x: 4, y: 64, z: 0 } }]);
  const acts = listActions(raw, { conflict: a.ctl.view(raw, { takeBack: tb }) });
  const ch = acts.find((x) => x.name === 'take_back').choices[0];
  const it = a.agent.own.beforeAct({ action: 'take_back', arg: ch.id, choice: ch }, {});
  assert.strictEqual(it.reasonCode, 'retaliation');
  assert.strictEqual(it.target.owner, 'Masaru');
});

test('act: hit_person は1回で hits 発まで殴る (殺せなくはしない: 相手が消えたら止まる)。文句・返して・助けては発話の行', async () => {
  let attacks = 0;
  const target = { position: new Vec3(1, 64, 0), height: 1.8 };
  const bot = { entity: { position: new Vec3(0, 64, 0) }, players: { Masaru: { entity: target } }, lookAt: async () => {}, attack: () => { attacks += 1; } };
  const h = conflictHandlers({ gotoGoal: async () => {}, haltPath: () => {}, flee: async () => ({ ok: true }), takePlaced: async () => ({ ok: true, taken: { got: 1 } }) });
  const r = await h.hit_person(bot, { player: 'Masaru' }, { hits: 3, hitGapMs: 1 });
  assert.deepStrictEqual([r.ok, r.hitPerson.hits, attacks], [true, 3, 3]);
  bot.attack = () => { attacks += 1; delete bot.players.Masaru; };
  const r2 = await h.hit_person(bot, { player: 'Masaru' }, { hits: 3, hitGapMs: 1 });
  assert.deepStrictEqual([r2.hitPerson.hits, r2.hitPerson.gone], [1, true]);
  assert.strictEqual((await h.hit_person(bot, { player: 'Masaru' }, {})).ok, false);
  // 発話
  const a = mkAgent('Aoi');
  a.ctl.grieve('Masaru', 'took_witnessed', { item: 'acacia_log' });
  const s = await a.ctl.say('complain', { player: 'Masaru' });
  assert.ok(s.ok);
  assert.match(a.bot._chat[0], /^【文句 Masaru took_witnessed】Masaru、acacia_logを取られたのは嫌だった$/);
  await a.ctl.say('demand', { player: 'Masaru', item: 'acacia_log' });
  assert.deepStrictEqual(C.parseLine(a.bot._chat[1]), { type: 'demand', target: 'Masaru', item: 'acacia_log', text: 'Masaru、acacia_logを返して' });
  a.ctl.afterAct({ action: 'hit_person', arg: 'Masaru', choice: { player: 'Masaru', grudge: 0.4, retaliation: true } }, { ok: true, hitPerson: { hits: 2, gone: false } });
  const ca = ev(a.writes, 'conflict_act')[0];
  assert.deepStrictEqual([ca.action, ca.target, ca.hits, ca.retaliation], ['hit_person', 'Masaru', 2, true]);
  assert.ok(ca.temperament && ca.emotions);
  assert.strictEqual(ev(a.writes, 'hit')[0].hits, 2);
  assert.strictEqual(C.parseLine('こんにちは'), null);
});

test('conflict_stats: きっかけ別・行動の候補と選ばれ方・殴る・わだかまりのある/ない相手の選ばれ方と距離', () => {
  const step = (n, o) => ({ _name: 'Aoi', loop: n, action: 'explore', arg: 'n', result: { ok: true }, ...o });
  const all = [
    { _name: 'Aoi', event: 'grudge', who: 'Masaru', kind: 'took_witnessed', add: 0.4, affinity: 0 },
    { _name: 'Aoi', event: 'grudge', who: 'Masaru', kind: 'hit', add: 0.5, affinity: -8 },
    { _name: 'Aoi', event: 'grudge_ease', who: 'Masaru', kind: 'apology' },
    step(1, { conflict: { grudges: { Masaru: 0.9 }, near: [{ n: 'Masaru', d: 5 }, { n: 'Ken', d: 6 }], offered: ['avoid_person:Masaru', 'hit_person:Masaru'] } }),
    step(2, { action: 'follow', arg: 'Ken', conflict: { grudges: { Masaru: 0.9 }, near: [{ n: 'Masaru', d: 9 }, { n: 'Ken', d: 3 }], offered: ['avoid_person:Masaru'] } }),
    step(3, { action: 'hit_person', arg: 'Masaru', conflict: { grudges: { Masaru: 0.9 }, near: [{ n: 'Masaru', d: 2 }], offered: ['hit_person:Masaru'] } }),
    { _name: 'Aoi', event: 'conflict_act', action: 'hit_person', ok: true },
    { _name: 'Aoi', event: 'hit', target: 'Masaru', hits: 3, retaliation: true, emotions: { anger: 6 }, temperament: { empathy: 0.2, bravery: 0.8 } },
    { _name: 'Masaru', event: 'hit_received', from: 'Aoi' },
  ];
  const c = conflictStats(all);
  assert.deepStrictEqual([c.grudges.n, c.grudges.pairs, c.grudges.eased], [3 - 1, 1, 1]);
  assert.deepStrictEqual(c.actions.hit_person, { offeredDecisions: 2, chosen: 1, ok: 1, rate: 0.5 });
  assert.deepStrictEqual(c.actions.avoid_person, { offeredDecisions: 2, chosen: 0, ok: 0, rate: 0 });
  assert.deepStrictEqual([c.violence.hits.n, c.violence.hits.blows, c.violence.received], [1, 3, 1]);
  assert.deepStrictEqual(c.partnerChoice.none, { opportunities: 2, chosen: 1, rate: 0.5, meanDistance: 4.5 });
  assert.deepStrictEqual(c.partnerChoice.grudge, { opportunities: 3, chosen: 0, rate: 0, meanDistance: 5.333 });
  assert.ok(lines(c).length === 4);
});

test('設定: survival_3days/100 は on。first_setting は off (今までと同じ)。run.js の --grudge・--conflict・--aggression', () => {
  for (const f of ['survival_3days.json', 'survival_100.json']) {
    const c = C.cfgOf(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'configs', f), 'utf8')).conflict);
    assert.deepStrictEqual([c.grudge, c.actions, c.aggression], [true, true, true], f);
  }
  const fsCfg = C.cfgOf(loadConfig(path.join(__dirname, '..', 'configs', 'first_setting.json')).conflict);
  assert.deepStrictEqual([fsCfg.grudge, fsCfg.actions, fsCfg.aggression], [false, false, false]);
  assert.deepStrictEqual(conflictOverrides({ aggression: 'off', conflict: 'on' }), { actions: true, aggression: false });
  assert.deepStrictEqual(conflictOverrides({ grudge: 'off' }), { grudge: false });
  assert.strictEqual(conflictOverrides({}), null);
  // わだかまりが off なら行動・殴るも off
  assert.deepStrictEqual(Object.values((({ grudge, actions, aggression }) => ({ grudge, actions, aggression }))(C.cfgOf({ grudge: false, actions: true, aggression: true }))), [false, false, false]);
  // off の agent は social を変えない
  const a = mkAgent('Aoi', { conflict: { grudge: false } });
  assert.strictEqual(a.ctl.grieve('Masaru', 'hit'), null);
  assert.strictEqual(a.agent.social.grudgeCfg.enabled, false);
  assert.deepStrictEqual(a.writes, []);
});
