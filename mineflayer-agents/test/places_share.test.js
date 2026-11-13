'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const places = require('../src/places');
const { Memory } = require('../src/memory');
const { SharedExplore } = require('../src/explored');
const { exploreChoices } = require('../src/explore');
const { parseLine, line } = require('../src/board');
const { listActions } = require('../src/actions');
const { mockRaw } = require('./fixtures');

const O = { x: -320, y: 72, z: 64 };

test('places: 出現地点からの方角と距離で呼ぶ。聞いた文から共通の呼び方・座標と物の名前を読む', () => {
  assert.strictEqual(places.commonRef({ x: -235, y: 70, z: -21 }, O), '出現地点から北東に120m');
  assert.strictEqual(places.commonRef({ x: -315, y: 70, z: 60 }, O), '出現地点のすぐ近く');
  assert.strictEqual(places.commonRef({ x: -235, y: 70, z: -21 }, O, { lang: 'en' }), '120m northeast of the spawn point');
  const a = places.parsePlaces('jungle_log がいっぱいあった、出現地点から北東に120mくらい', O);
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].kind, 'jungle_log');
  assert.ok(Math.abs(a[0].pos.x - -235) <= 1 && Math.abs(a[0].pos.z - -21) <= 1);
  assert.deepStrictEqual(places.parsePlaces('cow が (-200, 64, 40) にいた', O).map((p) => [p.kind, p.pos.x, p.pos.z]), [['cow', -200, 40]]);
  assert.deepStrictEqual(places.parsePlaces('x=-200 z=40 に水', O).map((p) => [p.pos.x, p.pos.z]), [[-200, 40]]);
  assert.deepStrictEqual(places.parsePlaces('おなかすいた', O), []);
});

test('memory: 聞いた話の場所を「〜が言っていた所」として覚え、共通の呼び方を添えて go_to の候補にする。自分で見たら消える', () => {
  const m = new Memory({ origin: O });
  m.noteHeard('Ken', 'jungle_log は出現地点から北東に120mにたくさんあった');
  const pl = m.places.find((p) => p.kind === 'jungle_log');
  assert.ok(pl && pl.from === 'Ken');
  const here = { x: -320, y: 72, z: 64 };
  const mp = m.placesForPrompt(here);
  assert.match(mp[0].label, /^jungle_log\(Kenが言っていた所\) 東\d+北\d+\(\d+m\)・出現地点から北東に120m$/);
  // 見えている jungle_log が collect できても、聞いた場所への go_to は出る
  const raw = mockRaw({ self: { name: 'Taro', pos: here, health: 20, food: 20 }, blocks: [{ name: 'jungle_log', nearest: { x: -318, y: 72, z: 64, d: 2 }, diggable: true, notable: true, positions: [] }], entities: [], inventory: [], heard: [] });
  const acts = listActions(raw, { memPlaces: mp });
  const go = acts.find((a) => a.name === 'go_to');
  const c = go.choices.find((x) => x.id === 'M1');
  assert.ok(c, JSON.stringify(go.choices.map((x) => x.id)));
  assert.match(c.labelEn, /Ken said so/);
  assert.match(m.toPromptText(here), /M1=jungle_log\(Kenが言っていた所\)/);
  // 自分の発言・数字の無い話は場所にしない
  m.noteHeard('自分', '出現地点から南に50mに石');
  assert.ok(!m.places.some((p) => p.kind === '聞いた場所'));
  // 自分で見たら from が消える
  m.notePlace('jungle_log', { x: pl.x, y: 70, z: pl.z });
  assert.strictEqual(m.places.find((p) => p.kind === 'jungle_log').from, undefined);
});

test('board: 【発見】の行。受け取った人は文の中の場所を覚える', () => {
  assert.strictEqual(line.find('cow がいた 出現地点から南に80m'), '【発見】cow がいた 出現地点から南に80m');
  const msg = parseLine('【発見】cow がいた 出現地点から南に80m');
  assert.deepStrictEqual(msg, { type: 'say', text: 'cow がいた 出現地点から南に80m', find: true });
  const m = new Memory({ origin: O });
  const got = m.learnPlaces('Aoi', msg.text);
  assert.deepStrictEqual(got.map((g) => [g.kind, g.x, g.z]), [['cow', -320, 144]]);
});

test('explored: 全員の踏破を分け合い、explore の「まだ行っていない」を全員で決める。近さだけで選ばない候補 (拠点から離れる・踏破が少ない・人が少ない)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'explored-'));
  const a = new SharedExplore({ dir, name: 'Taro' });
  const b = new SharedExplore({ dir, name: 'Ken' });
  // Ken は北側のマス (0,-1) (1,-1) (-1,-1) に行った
  b.publish(1, [{ cx: 0, cz: -1, n: 2 }, { cx: 1, cz: -1, n: 1 }, { cx: -1, cz: -1, n: 1 }, { cx: 0, cz: 0, n: 1 }], { x: 8, z: -40 }, { force: true });
  a.load(1, { force: true });
  const mine = [{ cx: 0, cz: 0, n: 3 }];
  const all = a.merge(mine);
  assert.strictEqual(all.find((c) => c.cx === 0 && c.cz === 0).who.length, 2);
  const here = { x: 8, y: 64, z: 8 };
  const self = exploreChoices(here, { mode: 'varied', near: 12, far: 40, cells: mine, cellSize: 16, scope: 'self' });
  const shared = exploreChoices(here, { mode: 'varied', near: 12, far: 40, cells: mine, allCells: all, cellSize: 16, scope: 'all', extra: true, base: { x: 8, z: 30 }, others: a.positions() });
  const uSelf = self.find((c) => c.id === 'unvisited'); const uAll = shared.find((c) => c.id === 'unvisited');
  assert.match(uAll.label, /^誰も行っていないマスへ/);
  // 自分だけなら北のマスも未踏、全員なら北のマスは行った扱い
  assert.ok(uSelf.cell[1] <= 0 || uAll.cell[1] >= 0);
  assert.ok(!(uAll.cell[1] === -1 && Math.abs(uAll.cell[0]) <= 1), JSON.stringify(uAll.cell));
  assert.match(shared.find((c) => c.id === 'north_near').label, /1人が行った/);
  const away = shared.find((c) => c.id === 'away_base');
  assert.strictEqual(away.dir, 'north'); // 拠点 (南) から離れる方
  const least = shared.find((c) => c.id === 'least_explored');
  assert.notStrictEqual(least.dir, 'north');
  assert.match(least.label, /みんなの踏破したマスが少ない方/);
  const few = shared.find((c) => c.id === 'few_people');
  assert.notStrictEqual(few.dir, 'north'); // Ken は北にいる
  for (const c of shared) assert.doesNotMatch(c.label, /べき|良い|おすすめ/);
});
