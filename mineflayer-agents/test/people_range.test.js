'use strict';
// 近くの交流の範囲 (2026-11-06): 声の届く距離・近くの人を、見えているか (視線・entity の描画) ではなく距離だけで決める。
// 踏破の共有は書き出すだけで読まない (scope: self が既定)。summarize_run の場所の共有の数
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { PlayerCache, playerDistance, nearPlayers, peopleOf, trackingRange } = require('../src/people');
const { Agent, buildContext } = require('../src/agent');
const { loadConfig, DEFAULTS } = require('../src/config');
const { Memory } = require('../src/memory');
const { listActions } = require('../src/actions');
const { mockRaw } = require('./fixtures');

const SURVIVAL = path.join(__dirname, '..', 'configs', 'survival_3days.json');
const CFG = path.join(__dirname, '..', 'configs', 'first_setting.json');
const at = (x, z = 0) => ({ entity: { position: { x, y: 64, z } } });

test('既定値: 声の届く距離 48・近くの人 = hearRadius・踏破は自分だけ (survival_3days も)', () => {
  assert.strictEqual(DEFAULTS.perception.hearRadius, 48);
  assert.strictEqual(DEFAULTS.perception.peopleRadius, null);
  const cfg = loadConfig(SURVIVAL);
  assert.strictEqual(cfg.perception.hearRadius, 48);
  assert.strictEqual(cfg.perception.peopleRadius, 48);
  assert.strictEqual(cfg.act.explore.scope, 'self');
  assert.strictEqual(require('../src/explore').DEFAULTS.scope, 'self');
});

test('trackingRange: サーバーがプレイヤーの位置を送る距離 (view-distance と entity-broadcast-range-percentage)', () => {
  assert.strictEqual(trackingRange({ viewDistance: 8, broadcastPct: 100 }), 112); // 今の fabric
  assert.strictEqual(trackingRange({ viewDistance: 10, broadcastPct: 100 }), 144);
  assert.strictEqual(trackingRange({ viewDistance: 3, broadcastPct: 100 }), 32); // 48 に足りない
  assert.strictEqual(trackingRange({ viewDistance: 10, broadcastPct: 5 }), 25);
});

test('people: entity の位置から距離。entity が消えても最後の位置を staleMs まで使い、それより古いと分からない', () => {
  const bot = { username: 'Taro', entity: { position: { x: 0, y: 64, z: 0 } }, players: { Taro: at(0), Hanako: at(40), Jiro: at(60), Ken: {} } };
  const cache = new PlayerCache({ staleMs: 1000 });
  assert.strictEqual(playerDistance(bot, 'Hanako', cache, 0).d, 40);
  assert.strictEqual(playerDistance(bot, 'Ken', cache, 0), null);
  const near = nearPlayers(bot, 48, { cache, seenNames: new Set(['Hanako']), now: 0 });
  assert.deepStrictEqual(near.map((p) => [p.name, p.d, p.seen, p.how]), [['Hanako', 40, true, 'entity']]);
  delete bot.players.Hanako.entity;
  const r = playerDistance(bot, 'Hanako', cache, 500);
  assert.deepStrictEqual([r.d, r.how], [40, 'cache']);
  assert.strictEqual(playerDistance(bot, 'Hanako', cache, 2000), null);
  // raw.people が無い古い形では見えている人
  assert.deepStrictEqual(peopleOf({ entities: [{ kind: 'player', name: 'A', d: 3 }, { kind: 'mob', name: 'cow', d: 2 }] }).map((p) => p.name), ['A']);
});

function makeAgent(name, dir, over = {}) {
  const cfg = loadConfig(CFG, { persona: { name }, memory: { file: null }, perception: { hearRadius: 48 }, ...over });
  cfg.memory.file = null;
  const a = new Agent(cfg, { decider: { kind: 'none' }, recordDir: dir, log: () => {} });
  a.bot = { username: name, entity: { position: { x: 0, y: 64, z: 0 } }, players: {}, time: { timeOfDay: 3000, day: 0 } };
  return a;
}

test('onChat: 見えていなくても (entity がなくても最後の位置で) 距離だけで判定する。48m 以内は聞こえ、外は捨てる', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hear-'));
  const a = makeAgent('Taro', dir);
  a.bot.players = { Hanako: at(40), Jiro: at(60), Ken: {} };
  a.onChat('Hanako', 'こっちに木があるよ');
  a.onChat('Jiro', '遠くの声');
  a.onChat('Ken', '位置の分からない人');
  assert.deepStrictEqual(a.heardBuf.map((h) => [h.from, h.d]), [['Hanako', 40]]);
  // Hanako の entity が消えても (描画の外・視線が通らない)、直前の位置で聞こえる
  delete a.bot.players.Hanako.entity;
  a.onChat('Hanako', 'まだここにいる');
  assert.strictEqual(a.heardBuf.length, 2);
  assert.deepStrictEqual(a.takeChatCount(), { heard: 2, far: 1, unknown: 1, cache: 1 });
  assert.strictEqual(a.takeChatCount(), null);
  // 24m の設定なら 40m の人は聞こえない
  const b = makeAgent('Yuki', dir, { perception: { hearRadius: 24 } });
  b.bot.players = { Hanako: at(40) };
  b.onChat('Hanako', 'こんにちは');
  assert.strictEqual(b.heardBuf.length, 0);
});

test('近くの人: follow・give・go_to(人) は peopleRadius、call・ask は hearRadius。見えていない (raw.entities にいない) 人も対象', () => {
  const people = [
    { kind: 'player', name: 'Hanako', pos: { x: -4, y: 64, z: 4 }, d: 5.7, seen: true },
    { kind: 'player', name: 'Jiro', pos: { x: 30, y: 64, z: 0 }, d: 30, seen: false },
    { kind: 'player', name: 'Ken', pos: { x: 45, y: 64, z: 0 }, d: 45, seen: false },
  ];
  const raw = mockRaw({ people });
  const troubles = [{ key: 'craft:stick', about: 'stickの作り方', kind: 'fail' }];
  const acts = listActions(raw, { hearRadius: 48, peopleRadius: 48, memPlaces: [], troubles, enable: new Set(['follow', 'give', 'call']) });
  const ids = (n) => { const a = acts.find((x) => x.name === n); return a ? [...new Set(a.choices.map((c) => c.player))] : []; };
  for (const n of ['follow', 'give', 'call', 'ask']) assert.deepStrictEqual(ids(n), ['Hanako', 'Jiro', 'Ken'], n);
  assert.deepStrictEqual(acts.find((x) => x.name === 'go_to').choices.filter((c) => c.player).map((c) => c.player), ['Hanako', 'Jiro', 'Ken']);
  // 狭めると、それぞれの距離で切れる
  const acts2 = listActions(raw, { hearRadius: 24, peopleRadius: 40, memPlaces: [], troubles, enable: new Set(['follow', 'give', 'call']) });
  const ids2 = (n) => { const a = acts2.find((x) => x.name === n); return a ? [...new Set(a.choices.map((c) => c.player))] : []; };
  assert.deepStrictEqual(ids2('follow'), ['Hanako', 'Jiro']);
  assert.deepStrictEqual(ids2('give'), ['Hanako', 'Jiro']);
  assert.deepStrictEqual(ids2('call'), ['Hanako']);
  assert.deepStrictEqual(ids2('ask'), ['Hanako']);
});

test('buildContext: cfg.perception の hearRadius・peopleRadius が行動の候補に効く', () => {
  const cfg = loadConfig(SURVIVAL, { persona: { name: 'Taro' } });
  const memory = new Memory({ file: null });
  const raw = mockRaw({ people: [{ kind: 'player', name: 'Ken', pos: { x: 45, y: 64, z: 0 }, d: 45, seen: false }] });
  const ctx = buildContext(raw, memory, cfg, {});
  const f = ctx.actions.find((x) => x.name === 'follow');
  assert.ok(f && f.choices.some((c) => c.player === 'Ken'));
});

test('go_to: 聞いた場所の候補に heardFrom が付く (記録の heardPlace)', () => {
  const raw = mockRaw();
  const memPlaces = [{ id: 'M1', kind: 'cow', pos: { x: 100, y: 64, z: 0 }, d: 100, from: 'Hanako', label: 'cow(Hanakoが言っていた所)' }];
  const go = listActions(raw, { memPlaces }).find((x) => x.name === 'go_to');
  const c = go.choices.find((x) => x.id === 'M1');
  assert.strictEqual(c.heardFrom, 'Hanako');
});

test('踏破の共有: scope self (既定) では書き出すだけで、ほかの人のファイルを読まない。all のときだけ読む', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expl-'));
  const exDir = path.join(dir, 'explored');
  fs.mkdirSync(exDir, { recursive: true });
  fs.writeFileSync(path.join(exDir, 'Hanako.json'), JSON.stringify({ name: 'Hanako', at: Date.now(), pos: { x: 100, z: 0 }, cells: [[5, 0, 3]] }));
  const raw = mockRaw({ people: [{ kind: 'player', name: 'Jiro', pos: { x: 30, y: 64, z: 0 }, d: 30 }] });
  const a = makeAgent('Taro', dir, { act: { explore: { shared: true, shareEvery: 1 } } });
  assert.strictEqual(a.cfg.act.explore.scope, undefined); // first_setting に scope なし → explore.js の既定 self
  let loads = 0;
  const orig = a.sharedExplore.load.bind(a.sharedExplore);
  a.sharedExplore.load = (...x) => { loads += 1; return orig(...x); };
  const r = a.exploreShare(1, raw);
  assert.strictEqual(loads, 0);
  assert.strictEqual(r.allCells, null);
  assert.deepStrictEqual(r.others.map((o) => o.name), ['Jiro']); // 人の少ない方は近くの人だけで数える
  assert.ok(fs.existsSync(path.join(exDir, 'Taro.json'))); // 分析用の書き出しは残す
  const b = makeAgent('Yuki', dir, { act: { explore: { shared: true, shareEvery: 1, scope: 'all' } } });
  const rb = b.exploreShare(1, raw);
  assert.ok(rb.allCells.some((c) => c.who.includes('Hanako')));
  assert.deepStrictEqual(rb.others.map((o) => o.name).sort(), ['Hanako', 'Taro']);
  // survival_3days の設定で作ったエージェントも読まない
  const c = new Agent(Object.assign(loadConfig(SURVIVAL, { persona: { name: 'Ken' } }), { memory: { file: null, limits: {} } }), { decider: { kind: 'none' }, recordDir: dir, log: () => {} });
  c.bot = { username: 'Ken', entity: { position: { x: 0, y: 64, z: 0 } }, players: {} };
  let cl = 0; c.sharedExplore.load = () => { cl += 1; return false; };
  assert.strictEqual(c.exploreShare(1, raw).allCells, null);
  assert.strictEqual(cl, 0);
});

test('summarize_run: 場所の共有 (【発見】・近くの声の場所・覚えた・聞いた場所へ go_to・着いた) と届く距離ごとの聞き手', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'share-'));
  const L = (o) => JSON.stringify(o);
  const t = (s) => `2026-11-06T01:00:${String(s).padStart(2, '0')}.000Z`;
  const step = (loop, s, pos, extra = {}) => ({ ts: t(s), loop, pos, action: 'look_around', arg: '', result: { ok: true, msg: 'ok' }, decideMs: 100, parseOk: true, valid: true, inventory: [], foodCount: 0, ...extra });
  fs.writeFileSync(path.join(dir, 'Taro-x.jsonl'), [
    L({ ts: t(0), event: 'start', persona: { name: 'Taro' }, perception: { hearRadius: 48 } }),
    L(step(1, 1, { x: 0, y: 64, z: 0 })),
    L({ ts: t(2), event: 'board', kind: 'report_find', say: 'cow がいた、出現地点から北に100m' }),
    L({ ts: t(3), event: 'talk', say: '水は (10, 64, 20) にあるよ' }),
    L(step(2, 4, { x: 0, y: 64, z: 0 }, { action: 'call', arg: 'Hanako', result: { ok: true, msg: '', said: 'Hanako、来て (0,64,0)' } })),
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'Hanako-x.jsonl'), [
    L({ ts: t(0), event: 'start', persona: { name: 'Hanako' } }),
    L(step(1, 1, { x: 40, y: 64, z: 0 })),
    L({ ts: t(2), event: 'heard_place', via: 'board', from: 'Taro', to: 'Hanako', text: 'cow がいた、出現地点から北に100m', places: [{ kind: 'cow' }] }),
    L({ ts: t(5), event: 'heard_place', via: 'near', from: 'Taro', to: 'Hanako', text: '水は (10, 64, 20) にあるよ', places: [{ kind: 'water' }] }),
    L({ ts: t(6), event: 'talk', say: 'ありがとう' }),
    L(step(2, 7, { x: 40, y: 64, z: 0 }, { action: 'go_to', arg: 'M1', heardPlace: { from: 'Taro', kind: 'water', pos: { x: 10, y: 64, z: 20 } }, result: { ok: true, msg: '着いた' } })),
    L(step(3, 8, { x: 10, y: 64, z: 20 }, { action: 'go_to', arg: 'M2', heardPlace: { from: 'Taro', kind: 'cow', pos: { x: 0, y: 64, z: -100 } }, result: { ok: false, msg: '届かなかった' } })),
  ].join('\n'));
  const out = JSON.parse(execFileSync('node', [path.join(__dirname, '..', 'tools', 'summarize_run.js'), dir], { encoding: 'utf8' }));
  const ps = out.placeShare;
  assert.deepStrictEqual(ps.finds, { chosen: 1, said: 1, withPlace: 1 });
  assert.strictEqual(ps.nearWithPlace, 2);
  assert.deepStrictEqual(ps.nearWithPlaceByKind, { talk: 1, call: 1 });
  assert.strictEqual(ps.learned, 2);
  assert.deepStrictEqual(ps.learnedByVia, { board: 1, near: 1 });
  assert.deepStrictEqual([ps.goTo.n, ps.goTo.arrived], [2, 1]);
  assert.strictEqual(out.voices.hearRadius, 48);
  // Taro と Hanako は 40m: 24m では聞き手なし、48m では聞き手あり
  assert.ok(out.voiceReach['48'].listeners > out.voiceReach['24'].listeners);
});
