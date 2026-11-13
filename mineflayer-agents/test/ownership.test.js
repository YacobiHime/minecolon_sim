'use strict';
// 所有の知識・理由の決め方・機能損害・許可の答え・関係の変化・発話の行 (src/ownership.js)
const test = require('node:test');
const assert = require('node:assert');
const O = require('../src/ownership');
const { ADVICE_EN } = require('../src/en');

const DIM = 'minecraft:overworld';

test('OwnKnowledge: 自分で置いた・見た・聞いた・共有・知らない で見方が分かれる', () => {
  const k = new O.OwnKnowledge({}, { me: 'Yua' });
  k.learn(DIM, [0, 64, 0], { block: 'torch', owner: 'Yua', source: 'self', tick: 1 });
  k.learn(DIM, [1, 64, 0], { block: 'crafting_table', owner: 'Miho', source: 'seen', tick: 1 });
  k.learn(DIM, [2, 64, 0], { block: 'oak_planks', owner: 'Ken', source: 'heard', from: 'Aoi', tick: 1 });
  k.learn(DIM, [3, 64, 0], { block: 'chest', owner: 'Ken', kind: 'public', source: 'project', tick: 1 });
  k.learn(DIM, [4, 64, 0], { block: 'cobblestone', owner: 'Ken', kind: 'group', source: 'seen', tick: 1 });
  assert.strictEqual(k.classify(DIM, [0, 64, 0], 'wall_torch').category, 'own');
  assert.deepStrictEqual([k.classify(DIM, [1, 64, 0], 'crafting_table').category, k.classify(DIM, [1, 64, 0], 'crafting_table').owner], ['other', 'Miho']);
  assert.strictEqual(k.classify(DIM, [2, 64, 0], 'oak_planks').entry.source, 'heard');
  assert.strictEqual(k.classify(DIM, [3, 64, 0], 'chest').category, 'public');
  assert.strictEqual(k.classify(DIM, [4, 64, 0], 'cobblestone').category, 'group');
  // 知らない置かれた物: 見た目で人工物なら unknown、天然と同じ見た目なら natural (誤認の余地)
  assert.strictEqual(k.classify(DIM, [9, 64, 9], 'torch').category, 'unknown');
  assert.strictEqual(k.classify(DIM, [9, 64, 9], 'white_bed').category, 'unknown');
  assert.strictEqual(k.classify(DIM, [9, 64, 9], 'cobblestone').category, 'natural');
  assert.strictEqual(k.classify(DIM, [9, 64, 9], 'oak_log').category, 'natural');
  // 別の dimension では知らない
  assert.strictEqual(k.classify('minecraft:the_nether', [0, 64, 0], 'torch').category, 'unknown');
  // 違う物が置かれている (前の物が無い) なら知識は当たらない
  assert.strictEqual(k.classify(DIM, [4, 64, 0], 'dirt').category, 'natural');
  // 無くなった物
  k.mark(DIM, [1, 64, 0], 'missing');
  assert.strictEqual(k.classify(DIM, [1, 64, 0], 'crafting_table').category, 'unknown');
});

test('OwnKnowledge: 強い知識 (自分で置いた) は弱い知らせ (聞いた) で上書きしない。忘れる・上限', () => {
  const k = new O.OwnKnowledge({}, { me: 'Yua', cfg: { knowledge: { max: 3 } } });
  k.learn(DIM, [0, 64, 0], { block: 'torch', owner: 'Yua', source: 'self', tick: 1 });
  k.learn(DIM, [0, 64, 0], { block: 'torch', owner: 'Ken', source: 'heard', tick: 5 });
  assert.strictEqual(k.get(DIM, [0, 64, 0]).owner, 'Yua');
  assert.strictEqual(k.get(DIM, [0, 64, 0]).t, 5);
  // 見た (seen) は聞いた (heard) を上書きする
  k.learn(DIM, [1, 64, 0], { block: 'torch', owner: 'Ken', source: 'heard', tick: 1 });
  k.learn(DIM, [1, 64, 0], { block: 'torch', owner: 'Miho', source: 'seen', tick: 2 });
  assert.strictEqual(k.get(DIM, [1, 64, 0]).owner, 'Miho');
  for (let i = 2; i < 6; i++) k.learn(DIM, [i, 64, 0], { block: 'torch', owner: 'Ken', source: 'heard', tick: i });
  assert.strictEqual(Object.keys(k.store).length, 3);
  assert.ok(k.get(DIM, [0, 64, 0]), '大事な (自分の) 知識が残る');
  const n = k.forget((e) => (e.source === 'self' ? 1 : 0));
  assert.ok(n >= 1);
  assert.deepStrictEqual(Object.values(k.store).map((e) => e.source), ['self']);
});

test('decideReason: greed が高いが代わりがある → selfish_acquisition', () => {
  const alts = O.alternatives('torch', { inventory: [{ name: 'coal', count: 2 }, { name: 'stick', count: 2 }] });
  assert.ok(O.hasAlternative(alts));
  const r = O.decideReason({ action: 'take_placed', category: 'other', block: 'torch', needs: { greed: 0.95, safety: 0.3 }, alternatives: alts });
  assert.strictEqual(r.reasonCode, 'selfish_acquisition');
  assert.deepStrictEqual(r.need, { type: 'greed', value: 0.95 });
  assert.strictEqual(r.emergency, false);
});

test('decideReason: 安心が危機的で代わりが無い → emergency_need。代わりがあれば緊急ではない', () => {
  const none = O.alternatives('torch', { inventory: [], natural: new Set(['dirt']) });
  assert.ok(!O.hasAlternative(none));
  const r = O.decideReason({ action: 'take_placed', category: 'other', block: 'torch', needs: { safety: 0.94, greed: 0.2 }, alternatives: none });
  assert.strictEqual(r.reasonCode, 'emergency_need');
  assert.deepStrictEqual(r.need, { type: 'safety', value: 0.94 });
  const some = O.alternatives('torch', { inventory: [{ name: 'torch', count: 1 }] });
  assert.strictEqual(O.decideReason({ action: 'take_placed', category: 'other', block: 'torch', needs: { safety: 0.94 }, alternatives: some }).reasonCode, 'selfish_acquisition');
  // 眠気が限界でベッドが無い
  const bed = O.decideReason({ action: 'take_placed', category: 'other', block: 'white_bed', needs: { sleep: 0.9 }, alternatives: O.alternatives('white_bed', {}) });
  assert.strictEqual(bed.reasonCode, 'emergency_need');
  // 欲求に関係しない物 (作業台) は緊急にならない
  assert.strictEqual(O.decideReason({ action: 'take_placed', category: 'other', block: 'crafting_table', needs: { safety: 1, greed: 1 }, alternatives: [] }).reasonCode, 'selfish_acquisition');
  // しきい値は設定で
  assert.strictEqual(O.decideReason({ action: 'take_placed', category: 'other', block: 'torch', needs: { safety: 0.7 }, alternatives: none, emergencyNeed: 0.6 }).reasonCode, 'emergency_need');
});

test('decideReason: 許可あり・所有者不明・誤認・自分の物・行動と別の掘り・共同の物の移設', () => {
  const R = (o) => O.decideReason({ block: 'torch', needs: { safety: 0.99 }, alternatives: [], ...o }).reasonCode;
  assert.strictEqual(R({ action: 'take_placed', category: 'other', permission: 'granted' }), 'permission_granted');
  assert.strictEqual(R({ action: 'take_placed', category: 'unknown' }), 'unknown_ownership');
  assert.strictEqual(R({ action: 'collect' }), 'mistaken_as_natural');
  assert.strictEqual(R({ action: 'collect', modelOn: false }), 'unmodeled');
  assert.strictEqual(R({ action: 'dismantle_own', category: 'own' }), 'own_relocation');
  assert.strictEqual(R({ action: 'go_to' }), 'accidental');
  assert.strictEqual(R({ action: null }), 'accidental');
  assert.strictEqual(R({ action: 'repair_or_relocate_public', category: 'group' }), 'public_repair');
  // 断られたあとに取った: 理由は欲求で決まる (断られたことは permission と重み・関係の変化に出る)
  assert.strictEqual(R({ action: 'take_placed', category: 'other', permission: 'denied' }), 'emergency_need');
});

test('functionalHarm: 明かり・壁の穴・ベッド・設備・畑', () => {
  const t = O.functionalHarm('torch', { night: true, otherLightNear: false });
  assert.strictEqual(t.light, 14);
  assert.ok(t.darkens);
  assert.ok(t.score >= 0.79);
  assert.ok(O.functionalHarm('torch', { otherLightNear: true }).score < t.score);
  assert.ok(O.functionalHarm('oak_planks', { placedNeighbors: 3 }).opensWall);
  assert.ok(!O.functionalHarm('oak_planks', { placedNeighbors: 1 }).opensWall);
  assert.strictEqual(O.functionalHarm('white_bed', { bedOccupied: true }).score, 1);
  assert.ok(O.functionalHarm('white_bed', { night: true }).score > O.functionalHarm('white_bed', { night: false }).score);
  const st = O.functionalHarm('crafting_table', { altStationDist: null });
  assert.strictEqual(st.station.altDist, null);
  assert.ok(st.score > O.functionalHarm('crafting_table', { altStationDist: 5 }).score);
  assert.ok(O.functionalHarm('chest', { altStationDist: 5, containerItems: 10 }).station.items);
  assert.ok(O.functionalHarm('farmland', {}).farm);
  assert.strictEqual(O.functionalHarm('dirt', {}).score, 0);
  assert.strictEqual(O.harmText(t), 'light:14');
  assert.strictEqual(O.harmText(O.functionalHarm('dirt', {})), 'none');
});

test('choiceWeight: 損害・社会的な損・代わりの有無・所有者不明・断られた で下げる。0 にはしない', () => {
  const base = { harm: { score: 0.8 }, socialCost: 0.6, alternatives: [{ kind: 'craft', available: true }], category: 'other', permission: 'not_requested', emergency: false };
  const w = O.choiceWeight(base);
  assert.deepStrictEqual(Object.keys(w.factors).sort(), ['alt', 'harm', 'social']);
  assert.ok(w.w < 0.5 && w.w >= 0.15);
  const em = O.choiceWeight({ ...base, emergency: true, alternatives: [] });
  assert.ok(!('alt' in em.factors));
  assert.ok(em.w > w.w);
  const granted = O.choiceWeight({ ...base, permission: 'granted' });
  assert.deepStrictEqual(Object.keys(granted.factors), ['harm']);
  const worst = O.choiceWeight({ harm: { score: 1 }, socialCost: 1, alternatives: [{ kind: 'x', available: true }], category: 'unknown', permission: 'denied' });
  assert.strictEqual(worst.w, 0.15);
  assert.strictEqual(O.choiceWeight({ harm: { score: 0 }, socialCost: 0, alternatives: [], category: 'other' }).w, 1);
  // 性格の欲が強いほど重みが上がる (0.8〜1.2 倍)
  const g = (t) => O.choiceWeight({ ...base, greedTrait: t }).w;
  assert.ok(g(0.9) > g(0.5) && g(0.5) > g(0.1));
  assert.strictEqual(O.choiceWeight({ harm: { score: 0 }, socialCost: 0, alternatives: [], category: 'other', greedTrait: 1 }).factors.greed, 1.2);
});

test('socialCost: 自分の物・許可ありは 0。共有の物は個人の物より小さい。共感・従順が高いほど大きい', () => {
  assert.strictEqual(O.socialCost({ kind: 'own' }), 0);
  assert.strictEqual(O.socialCost({ kind: 'personal', permission: 'granted' }), 0);
  assert.ok(O.socialCost({ kind: 'public' }) < O.socialCost({ kind: 'personal' }));
  assert.ok(O.socialCost({ kind: 'personal', temperament: { empathy: 0.9, obedience: 0.9 } }) > O.socialCost({ kind: 'personal', temperament: { empathy: 0.1, obedience: 0.1 } }));
  assert.ok(O.socialCost({ kind: 'personal', permission: 'denied' }) > O.socialCost({ kind: 'personal' }));
});

test('permissionAnswer: 決定的。親しく共感の高い持ち主は貸す、欲の強い持ち主・使用中のベッドは断る', () => {
  const kind = O.permissionAnswer({ temperament: { empathy: 0.9, obedience: 0.7, greed: 0.1 }, affinity: 70, harm: { score: 0.2 } });
  assert.strictEqual(kind.yes, true);
  const greedy = O.permissionAnswer({ temperament: { empathy: 0.1, obedience: 0.2, greed: 0.9 }, affinity: 40, harm: { score: 0.6 } });
  assert.strictEqual(greedy.yes, false);
  assert.strictEqual(O.permissionAnswer({ temperament: { empathy: 1 }, harm: { score: 1, bed: { occupied: true } } }).yes, false);
  // 緊急だと言われると貸しやすい
  const mid = { temperament: { empathy: 0.4, obedience: 0.4, greed: 0.5 }, affinity: 50, harm: { score: 0.5 } };
  assert.ok(O.permissionAnswer({ ...mid, emergency: true }).score > O.permissionAnswer(mid).score);
  assert.deepStrictEqual(O.permissionAnswer(mid), O.permissionAnswer(mid));
});

test('socialImpact: 目撃 > 伝聞。緊急・説明で軽く、断られたのに取った・繰り返しで重い。返却・補修・謝罪は良くなる', () => {
  const T = { empathy: 0.5 };
  const w = O.socialImpact('witnessed', { reasonCode: 'selfish_acquisition', temperament: T });
  const h = O.socialImpact('heard', { reasonCode: 'selfish_acquisition', temperament: T });
  assert.ok(w.affinity < h.affinity && h.affinity < 0);
  assert.ok(w.trust < 0);
  const em = O.socialImpact('witnessed', { reasonCode: 'emergency_need', temperament: T });
  assert.ok(Math.abs(em.affinity) < Math.abs(w.affinity));
  assert.ok(Math.abs(O.socialImpact('witnessed', { reasonCode: 'selfish_acquisition', explained: true, temperament: T }).affinity) < Math.abs(w.affinity));
  assert.ok(Math.abs(O.socialImpact('witnessed', { reasonCode: 'selfish_acquisition', denied: true, temperament: T }).affinity) > Math.abs(w.affinity));
  assert.ok(Math.abs(O.socialImpact('witnessed', { reasonCode: 'selfish_acquisition', times: 3, temperament: T }).affinity) > Math.abs(w.affinity));
  assert.strictEqual(O.socialImpact('witnessed', { reasonCode: 'permission_granted', temperament: T }).affinity, undefined); // 許可ありなら罰なし (0 は書かない)
  assert.ok(O.socialImpact('returned', {}).affinity > 0 && O.socialImpact('repaired', {}).trust > 0);
  assert.ok(O.socialImpact('apology', { reasonCode: 'emergency_need' }).affinity > O.socialImpact('apology', { reasonCode: 'selfish_acquisition' }).affinity);
  assert.ok(Math.abs(O.socialImpact('rumor', { n: 3, temperament: T }).trust) > Math.abs(O.socialImpact('rumor', { n: 1, temperament: T }).trust));
  // 共感の高い持ち主は怒りにくい
  assert.ok(Math.abs(O.socialImpact('witnessed', { temperament: { empathy: 0.9 } }).affinity) < Math.abs(O.socialImpact('witnessed', { temperament: { empathy: 0.1 } }).affinity));
  assert.ok(O.socialImpact('discovered', {}).sadness > 0);
  assert.strictEqual(O.socialImpact('nope', {}), null);
  assert.ok(w.why.length >= 2);
});

test('発話の行: 作る → 読む が一致する。壊れた行は null', () => {
  const ask = O.parseLine(O.line.ask({ id: 'Yua-12', block: 'torch', pos: { x: -502, y: 64, z: -63 }, owner: 'Miho', emergency: true }, 'Mihoさん、松明を使ってもいい?'));
  assert.deepStrictEqual({ ...ask, text: undefined }, { type: 'ask', id: 'Yua-12', block: 'torch', pos: [-502, 64, -63], owner: 'Miho', emergency: true, text: undefined });
  assert.strictEqual(ask.text, 'Mihoさん、松明を使ってもいい?');
  assert.deepStrictEqual(O.parseLine(O.line.answer({ id: 'Yua-12', yes: false }, 'ごめん')).yes, false);
  const ex = O.parseLine(O.line.explain({ block: 'torch', pos: [1, 2, 3], owner: 'Miho', reasonCode: 'emergency_need' }, '借りた'));
  assert.strictEqual(ex.reasonCode, 'emergency_need');
  assert.strictEqual(O.parseLine(O.line.explain({ block: 'torch', pos: [1, 2, 3], owner: null, reasonCode: 'unknown_ownership' })).owner, null);
  assert.deepStrictEqual(O.parseLine(O.line.returned({ item: 'torch', n: 1, owner: 'Miho' })).n, 1);
  assert.strictEqual(O.parseLine(O.line.repaired({ block: 'torch', pos: [1, 2, 3], owner: 'Miho' })).type, 'repaired');
  assert.strictEqual(O.parseLine(O.line.rumor({ taker: 'Yua', block: 'torch', owner: 'Miho', n: 2 })).taker, 'Yua');
  assert.strictEqual(O.parseLine('【説明 torch 1,2,3 Miho made_up_reason】x'), null);
  assert.strictEqual(O.parseLine('【許可? bad id torch】'), null);
  assert.strictEqual(O.parseLine('こんにちは'), null);
  assert.strictEqual(O.parseLine('【全体】みんな聞いて'), null); // 全体チャット (board.js) の行とは別
  // 文の中の【】は消す (行の形が壊れない)
  assert.ok(O.parseLine(O.line.answer({ id: 'a-1', yes: true }, '【いいよ】')));
});

test('consoleLine: 引き継ぎの形の1行', () => {
  const it = { action: 'take_placed', target: { block: 'torch', owner: 'Miho', ownerKind: 'personal' }, reasonCode: 'selfish_acquisition', need: { type: 'greed', value: 0.93 },
    alternatives: [{ kind: 'craft', available: true }, { kind: 'collect_natural', available: true }, { kind: 'ask_permission', available: false }], functionalHarm: O.functionalHarm('torch', {}), permission: 'not_requested' };
  assert.strictEqual(O.consoleLine('Yua', it), 'Yua take_placed(torch owned by Miho) reason=selfish_acquisition need=greed:0.93 alternatives=2 harm=light:14 permission=no');
  assert.match(O.consoleLine('Ken', { ...it, target: { block: 'chest', ownerKind: 'unknown' } }), /chest owner unknown/);
});

test('alternatives: 種類ごとの代わり (持っている・作れる・天然の入手元・羊)、持ち主に聞けるか', () => {
  const av = (b, v) => O.alternatives(b, v).filter((a) => a.available).map((a) => a.kind);
  assert.deepStrictEqual(av('oak_planks', { natural: new Set(['oak_log']) }), ['collect_natural']);
  assert.deepStrictEqual(av('crafting_table', { inventory: [{ name: 'oak_log', count: 1 }] }), ['craft']);
  assert.deepStrictEqual(av('white_bed', { mobs: new Set(['sheep']) }), ['hunt']);
  assert.deepStrictEqual(av('furnace', { natural: new Set(['stone']), hasPickaxe: true }), ['collect_natural']);
  assert.deepStrictEqual(av('furnace', { natural: new Set(['stone']), hasPickaxe: false }), []);
  assert.deepStrictEqual(av('torch', { ownerKnown: true, owner: 'Miho', ownerNear: true }), ['ask_permission']);
  assert.ok(!O.hasAlternative(O.alternatives('torch', { ownerKnown: true, owner: 'Miho', ownerNear: true })), '聞けることは代わりの入手元ではない');
  assert.strictEqual(O.itemOf('wall_torch'), 'torch');
  assert.strictEqual(O.itemOf('farmland'), 'dirt');
  assert.strictEqual(O.needOf('oak_planks'), 'safety');
  assert.strictEqual(O.needOf('crafting_table'), null);
});

test('harmFactsEn・templateText: 評価語を入れない事実の文', () => {
  const facts = [O.functionalHarm('torch', { night: true }), O.functionalHarm('oak_planks', { placedNeighbors: 2 }), O.functionalHarm('white_bed', { bedOccupied: true }), O.functionalHarm('chest', { containerItems: 3 }), O.functionalHarm('farmland', {})]
    .flatMap((h) => O.harmFactsEn(h));
  assert.ok(facts.length >= 5);
  for (const f of facts) assert.ok(!ADVICE_EN.test(f), f);
  for (const k of ['ask', 'answer', 'explain', 'returned', 'repaired', 'rumor']) assert.ok(O.templateText(k, { owner: 'Miho', block: 'torch', taker: 'Yua', reasonCode: 'emergency_need', yes: true }).length > 3, k);
});

test('cfgOf: 既定は台帳だけ on。penalty に従って reweight・social が決まり、個別に切れる', () => {
  const d = O.cfgOf();
  assert.deepStrictEqual([d.ledger, d.actions, d.penalty, d.reweight, d.social], [true, false, false, false, false]);
  const on = O.cfgOf({ actions: true, penalty: true });
  assert.deepStrictEqual([on.reweight, on.social], [true, true]);
  assert.deepStrictEqual([O.cfgOf({ penalty: true, social: false }).social, O.cfgOf({ penalty: true, social: false }).reweight], [false, true]);
  assert.strictEqual(O.cfgOf(false).ledger, false);
  assert.strictEqual(O.cfgOf({ weights: { floor: 0.3 } }).weights.harm, 0.6);
});
