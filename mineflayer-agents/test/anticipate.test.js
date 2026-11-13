'use strict';
// 予期される欲求 (先のつらさ: 先の不安・先の空腹。src/anticipate.js) と、それを使う needs / knowledge / summarize_run
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Anticipation, preparedness, killerOf } = require('../src/anticipate');
const { Needs } = require('../src/needs');
const knowledge = require('../src/knowledge');

const ADVICE = /(とよい|といい|べき|優先|ほうが|方が|おすすめ|勧め|まず|先に|使え|使うと|しよう|しなさい|作れ|備え)/;
const ADVICE_EN = /\b(should|must|better|best|recommend|try to|prepare)\b/i;

function at(a, tod, extra = {}) { a.update({ timeOfDay: tod, day: extra.day ?? 0, time: (extra.day ?? 0) * 24000 + tod, inventory: [], ...extra }, extra.o || {}); return a.v; }

test('先の不安: 夜が近いほど大きく、朝は 0。最初の夜 (経験なし) でも夜には base だけある', () => {
  const a = new Anticipation();
  const xs = [1000, 6000, 9000, 11000, 12500].map((t) => at(a, t).night);
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] >= xs[i - 1], JSON.stringify(xs));
  assert.strictEqual(xs[0], 0);
  assert.ok(at(a, 14000).night > 0.25 && a.v.night <= 0.31, String(a.v.night));
});

test('先の不安: 夜に殺されると次の夜までの不安が強まり、備え (武器・囲まれた寝床) で弱まり、勇敢な人は弱い', () => {
  const run = (temperament, prep = {}) => {
    const a = new Anticipation({ temperament });
    at(a, 14000);
    a.noteDeath({ timeOfDay: 16000, day: 0, message: 'Taro was slain by Zombie' });
    a.noteDeath({ timeOfDay: 19000, day: 0, message: 'Taro was slain by Zombie' });
    at(a, 1000, { day: 1 }); // 夜明け
    return at(a, 11000, { day: 1, ...prep }).night;
  };
  const first = new Anticipation(); const v0 = at(first, 11000).night;
  const died = run({ bravery: 0.5 });
  const prepped = run({ bravery: 0.5 }, { inventory: [{ name: 'stone_sword', count: 1 }], shelterKnown: true });
  const brave = run({ bravery: 0.95 });
  const timid = run({ bravery: 0.2 });
  assert.ok(died > v0 * 2, `${died} > ${v0}`);
  assert.ok(prepped < died * 0.6, `${prepped} < ${died}`);
  assert.ok(brave < died && died < timid, `${brave} < ${died} < ${timid}`);
});

test('先の不安: 昼に死んでも夜の経験には入らない。寝て夜を飛ばすと (Needs.onSleep) その夜は閉じる。殺したものを覚える', () => {
  const a = new Anticipation();
  at(a, 5000);
  assert.strictEqual(a.noteDeath({ timeOfDay: 5000, message: 'Taro was blown up by Creeper' }), false);
  assert.strictEqual(a.harmed(), false);
  at(a, 15000);
  assert.strictEqual(a.noteDeath({ timeOfDay: 15000, message: 'Taro was shot by Skeleton' }), true);
  assert.deepStrictEqual(a.killers(), ['skeleton']);
  assert.ok(a.harmed());
  const n = new Needs();
  n.update({ time: 14000, timeOfDay: 14000 });
  assert.ok(n.ant.cur);
  n.onSleep({ nightSkipped: true });
  assert.strictEqual(n.ant.cur, null);
  assert.strictEqual(n.ant.nights.length, 1);
  assert.strictEqual(killerOf('Jiro drowned whilst trying to escape Zombie'), 'zombie');
  assert.strictEqual(killerOf('Emi drowned'), 'water');
  assert.strictEqual(killerOf('Aoi was slain by Cave Spider'), 'cave_spider');
});

test('先の不安: 夜に傷を受けた・敵が近くに来た回数を数える (来たままは1回)', () => {
  const a = new Anticipation();
  at(a, 14000, { hostiles: [{ name: 'zombie', d: 5 }] });
  at(a, 14200, { hostiles: [{ name: 'zombie', d: 4 }], o: { hurt: 3 } });
  at(a, 14400, { hostiles: [] });
  at(a, 14600, { hostiles: [{ name: 'spider', d: 6 }] });
  assert.deepStrictEqual([a.cur.attacks, a.cur.hurts, a.cur.deaths], [2, 1, 0]);
});

test('備え: 武器の強さ・防具 (着けている > 持っているだけ)・盾・松明・寝床。合計は prepMax で頭打ち', () => {
  const p0 = preparedness({});
  assert.strictEqual(p0.total, 0);
  assert.ok(preparedness({ inventory: [{ name: 'iron_sword', count: 1 }] }).parts.weapon > preparedness({ inventory: [{ name: 'wooden_sword', count: 1 }] }).parts.weapon);
  assert.strictEqual(preparedness({ inventory: [{ name: 'bow', count: 1 }] }).parts.weapon, 0, '矢の無い弓は武器に数えない');
  assert.ok(preparedness({ worn: ['iron_chestplate'] }).parts.armor > preparedness({ inventory: [{ name: 'iron_chestplate', count: 1 }] }).parts.armor);
  assert.strictEqual(preparedness({ inventory: [{ name: 'torch', count: 2 }] }).parts.torch, 0);
  assert.ok(preparedness({ inventory: [{ name: 'torch', count: 8 }] }).parts.torch > 0);
  const all = preparedness({ inventory: [{ name: 'diamond_sword', count: 1 }, { name: 'shield', count: 1 }, { name: 'torch', count: 16 }], worn: ['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots'], shelterKnown: true, bedKnown: true });
  assert.strictEqual(all.total, 0.85);
  assert.ok(preparedness({ shelter: { enclosed: true } }).parts.shelter > 0, 'いま囲まれた所にいる');
});

test('先の空腹: 手持ちの食べ物が少ないほど・入手元を知らないほど・いまお腹が空いているほど大きい', () => {
  const f = (inv, extra = {}) => { const a = new Anticipation(); return at(a, 3000, { inventory: inv, ...extra }).food; };
  const none = f([]);
  const some = f([{ name: 'bread', count: 2 }]);
  const lots = f([{ name: 'cooked_beef', count: 8 }]);
  const seenCow = f([], { entities: [{ kind: 'mob', name: 'cow', d: 8 }] });
  assert.ok(none > some && some > lots, `${none} ${some} ${lots}`);
  assert.strictEqual(lots, 0);
  assert.ok(seenCow < none);
  const hungry = new Anticipation(); at(hungry, 3000, { o: { hunger: 0.6 } });
  assert.ok(hungry.v.food > none);
  // 入手元は sourceMemory tick のあいだ覚えている
  const a = new Anticipation();
  at(a, 3000, { entities: [{ kind: 'mob', name: 'cow', d: 8 }] });
  assert.ok(at(a, 5000).food < none);
  assert.strictEqual(at(a, 3000, { day: 1 }).food, none);
});

test('言葉: 事実と気持ちだけ (使い方・評価の言葉を書かない)。日本語と英語は同じ値から', () => {
  const a = new Anticipation();
  at(a, 14000);
  a.noteDeath({ timeOfDay: 16000, day: 0, message: 'Taro was slain by Zombie' });
  a.noteDeath({ timeOfDay: 18000, day: 0, message: 'Taro was slain by Zombie' });
  at(a, 1000, { day: 1 });
  at(a, 7000, { day: 1 });
  const ja = a.words().join('。'); const en = a.words({ lang: 'en' }).join('; ');
  assert.match(ja, /あと5分ほどで夜/);
  assert.match(ja, /昨夜はzombieに2回殺された/);
  assert.match(ja, /武器を持っていない/);
  assert.match(ja, /夜が来るのが(少し気になる|不安|怖い)/);
  assert.match(ja, /食べ物を持っていない/);
  assert.match(en, /about 5 minutes until night/);
  assert.match(en, /last night I was killed 2 times \(by zombie 2 times\)/);
  assert.doesNotMatch(ja, ADVICE);
  assert.doesNotMatch(en, ADVICE_EN);
  assert.doesNotMatch(ja, /0\.\d/);
  const b = new Anticipation();
  at(b, 9000, { inventory: [{ name: 'stone_sword', count: 1 }, { name: 'bread', count: 4 }], worn: ['leather_helmet'], shelterKnown: true });
  const jb = b.wordsOf('night');
  assert.match(jb, /stone_swordを持っている/);
  assert.match(jb, /leather_helmetを着けている/);
  assert.match(jb, /囲まれた寝床がある/);
  assert.match(jb, /まだここで夜を越したことがない/);
  assert.strictEqual(b.v.food, 0);
  assert.deepStrictEqual(new Anticipation().words(), [], 'まだ何も見ていないときは何も言わない');
});

test('Needs: 先のつらさを words に入れ、values().ant に数値、later() に一覧。toJSON / fromJSON で夜の記憶が残る。人ごとの係数 (anticipate)', () => {
  const n = new Needs({ temperament: { bravery: 0.5 } });
  n.update({ time: 11000, timeOfDay: 11000, food: 20, saturation: 5, inventory: [] });
  assert.match(n.words(), /あと2分ほどで夜/);
  assert.match(n.words({ lang: 'en' }), /about 2 minutes until night/);
  const v = n.values();
  assert.ok(Number.isFinite(v.ant.night) && Number.isFinite(v.ant.food) && v.ant.ttn === 2000);
  const later = n.later({ minRatio: 0 });
  assert.deepStrictEqual(later.map((x) => x.need).sort(), ['food', 'night']);
  for (const x of later) assert.ok(x.text && x.textEn && x.distress > 0);
  n.update({ time: 14000, timeOfDay: 14000, inventory: [] });
  n.ant.noteDeath({ timeOfDay: 15000, message: 'X was slain by Zombie' });
  const m = Needs.fromJSON(JSON.parse(JSON.stringify(n.toJSON())));
  assert.deepStrictEqual(m.ant.killers(), ['zombie']);
  const s = new Needs({ cfg: { anticipate: { night: { sensitivity: 2 } } } });
  s.update({ time: 11000, timeOfDay: 11000, inventory: [] });
  assert.ok(s.ant.v.night > n.values().ant.night * 0 && s.ant.v.night > 0);
  const off = new Needs({ cfg: { anticipate: { enabled: false } } });
  off.update({ time: 11000, timeOfDay: 11000, inventory: [] });
  assert.deepStrictEqual([off.ant.v.night, off.ant.v.food], [0, 0]);
});

test('knowledge: 夜が近い (night_soon)・夜に死んだ/襲われた (night_harm)・先の不安が高い (anxious_night) で戦いの事実が出る。状況だけの事実は whenMax まで', () => {
  const facts = knowledge.loadFacts();
  const raw = (tod) => ({ self: { timeOfDay: tod, food: 20, health: 20 }, inventory: [], blocks: [], entities: [] });
  const sit = (tod, o = {}) => knowledge.situations(raw(tod), { tick: 50, ...o });
  assert.ok(sit(10000).has('night_soon'));
  assert.ok(!sit(6000).has('night_soon'));
  assert.ok(sit(6000, { nightHarm: true }).has('night_harm'));
  assert.ok(sit(6000, { anxiousNight: true }).has('anxious_night'));
  const ids = (s, extra = {}) => knowledge.selectFacts(facts, { situations: s, max: 8, ...extra }).map((f) => f.id);
  const soon = ids(sit(10000));
  for (const id of ['weapon_damage', 'tool_armor_recipes', 'mob_wall', 'torch_light']) assert.ok(soon.includes(id), `${id} in ${soon}`);
  assert.ok(soon.length <= knowledge.DEFAULTS.whenMax);
  const harm = ids(sit(6000, { nightHarm: true }), { extraNames: ['zombie'] });
  for (const id of ['weapon_damage', 'tool_shield', 'mob_zombie']) assert.ok(harm.includes(id), `${id} in ${harm}`);
  assert.ok(ids(sit(6000)).every((id) => !['weapon_damage', 'tool_shield'].includes(id)), '昼で何も無いときは出ない');
  // 道筋の名前 (strong) の事実は押し出されない
  const plan = ids(sit(12000, { nightHarm: true, anxiousNight: true }), { strong: new Set(['wooden_pickaxe', 'stick']) });
  assert.ok(plan.includes('tools_at_table') || plan.includes('tool_recipes'), plan.join(','));
});

test('summarize_run: 備え (夕方より前に作った/持った)・夜に敵が見えた判断で attack/flee を選んだ割合・夜の死亡・先の不安の推移・決めた点', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-ant-'));
  const t = (s) => `2026-11-05T01:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.000Z`;
  const L = (o) => JSON.stringify(o);
  const step = (loop, s, o) => ({ ts: t(s), loop, day: 0, timeOfDay: 6000, pos: { x: 0, y: 64, z: 0 }, action: 'collect', arg: 'oak_log', result: { ok: true, msg: 'ok' }, inventory: [], obs: '近くの人・生き物・落ちている物: なし',
    social: { needs: { hunger: 0.1, stress: 0, ant: { night: 0.1, food: 0.2, prep: 0 } } }, ...o });
  fs.writeFileSync(path.join(dir, 'Taro-x.jsonl'), [
    L({ ts: t(0), event: 'start', persona: { name: 'Taro', temperament: { bravery: 0.5 } } }),
    L(step(1, 1, { action: 'craft', arg: 'wooden_sword', timeOfDay: 9000, inventory: [{ name: 'wooden_sword', count: 1 }] })),
    L(step(2, 61, { timeOfDay: 14000, obs: '近くの人・生き物・落ちている物: 敵zombie 東3(3m)', action: 'attack', arg: 'zombie', social: { needs: { stress: 0, ant: { night: 0.5, food: 0.2, prep: 0.2 } } } })),
    L(step(3, 62, { timeOfDay: 14200, obs: '近くの人・生き物・落ちている物: 敵zombie 東3(3m)', action: 'flee', arg: 'away' })),
    L({ ts: t(63), event: 'death', timeOfDay: 14300, day: 0, cause: 'death.attack.mob', message: 'Taro was slain by Zombie' }),
    L({ ts: t(64), event: 'goal_path', kind: 'goal', ok: true, select: { decidedBy: 'later' } }),
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'Hanako-x.jsonl'), [
    L({ ts: t(0), event: 'start', persona: { name: 'Hanako', temperament: { bravery: 0.4 } } }),
    L(step(1, 1, { action: 'craft', arg: 'torch', timeOfDay: 12500, inventory: [{ name: 'torch', count: 4 }] })),
    L(step(2, 61, { timeOfDay: 15000, obs: '近くの人・生き物・落ちている物: 敵skeleton 西5(5m)', action: 'wait', arg: '' })),
  ].join('\n'));
  const out = JSON.parse(execFileSync('node', [path.join(__dirname, '..', 'tools', 'summarize_run.js'), dir], { encoding: 'utf8' }));
  const p = out.prepare;
  assert.deepStrictEqual(p.beforeDusk[0].weapon, { crafted: 1, had: 1 });
  assert.deepStrictEqual(p.beforeDusk[0].torch, { crafted: 0, had: 0 }, '夕方 (12000) を過ぎてから');
  assert.strictEqual(p.perAgent.Taro.crafted.weapon.item, 'wooden_sword');
  assert.deepStrictEqual([p.fight.night.seen, p.fight.night.attack, p.fight.night.flee, p.fight.night.attackRate], [3, 1, 1, 0.33]);
  assert.strictEqual(p.fight.perAgent.Taro.bravery, 0.5);
  assert.deepStrictEqual([p.nightDeaths.n, p.nightDeaths.byKiller], [1, { zombie: 1 }]);
  assert.strictEqual(p.anticipation.Taro.max.night, 0.5);
  assert.deepStrictEqual(p.decidedBy, { later: 1 });
});
