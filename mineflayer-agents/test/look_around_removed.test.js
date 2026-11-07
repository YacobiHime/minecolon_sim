'use strict';
// look_around (立ち止まって見回す) を survival_3days で外す (2026-11-07 ユーザー決定)
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { listActions, fallbackDecision } = require('../src/actions');
const { category, movementStats } = require('../tools/search_stats');
const { blockVisible } = require('../src/observe');
const { mockRaw } = require('./fixtures');

const names = (acts) => acts.map((a) => a.name);
const cfgOf = (n) => require(path.join(__dirname, '..', 'configs', `${n}.json`));

test('act.disabled に look_around を入れると候補から外れる (入れなければ今のまま)', () => {
  assert.ok(names(listActions(mockRaw())).includes('look_around'));
  const acts = listActions(mockRaw(), { disabled: new Set(['look_around']) });
  assert.ok(!names(acts).includes('look_around'));
  for (const n of ['explore', 'say', 'wait']) assert.ok(names(acts).includes(n), n);
});

test('設定: survival_3days は look_around を外し、first_setting・wood_pickaxe は今のまま', () => {
  assert.ok(cfgOf('survival_3days').act.disabled.includes('look_around'));
  for (const n of ['first_setting', 'wood_pickaxe']) {
    const c = cfgOf(n);
    assert.ok(!((c.act && c.act.disabled) || []).includes('look_around'), n);
  }
});

test('fallbackDecision: look_around があればそれ (古い設定)', () => {
  const r = fallbackDecision(listActions(mockRaw()));
  assert.deepStrictEqual([r.ok, r.action, r.arg], [true, 'look_around', '']);
});

test('fallbackDecision: look_around が無ければ search の先頭の候補、search も無ければ explore、どちらも無ければ wait', () => {
  const base = listActions(mockRaw(), { disabled: new Set(['look_around']) });
  const search = { name: 'search', argType: 'choice', choices: [{ id: 'north', dir: 'north' }, { id: 'east', dir: 'east' }] };
  const r1 = fallbackDecision([...base, search]);
  assert.strictEqual(r1.action, 'search');
  assert.strictEqual(r1.arg, 'north');
  assert.strictEqual(r1.choice.dir, 'north');
  const r2 = fallbackDecision(base);
  const ex = base.find((a) => a.name === 'explore');
  assert.strictEqual(r2.action, 'explore');
  assert.strictEqual(r2.arg, ex.choices[0].id);
  assert.ok(r2.choice);
  const noMove = base.filter((a) => a.name !== 'explore');
  assert.deepStrictEqual(fallbackDecision(noMove), { ok: true, action: 'wait', arg: '3' });
  // 候補が空の explore は使わない
  assert.strictEqual(fallbackDecision([...noMove, { name: 'explore', argType: 'choice', choices: [] }]).action, 'wait');
});

test('分類: 選べなかったときの代わりは fallback、wait は wait (look_around は前の記録用に残す)', () => {
  const nm = new Set(['Taro']);
  assert.strictEqual(category({ action: 'search', arg: 'north', valid: false }, nm), 'fallback');
  assert.strictEqual(category({ action: 'search', arg: 'north', valid: true }, nm), 'search');
  assert.strictEqual(category({ action: 'wait', arg: '3' }, nm), 'wait');
  assert.strictEqual(category({ action: 'look_around', arg: '' }, nm), 'look_around');
  const step = (action, valid) => ({ loop: 1, action, arg: '', valid, result: { ok: true, msg: 'ok' }, _name: 'Taro' });
  const m = movementStats([step('search', false), step('explore', false), step('wait', true), step('search', true)], { names: ['Taro'] });
  assert.deepStrictEqual(m.fallbackBy, { search: 1, explore: 1 });
  assert.strictEqual(m.share.fallback.n, 2);
  assert.strictEqual(m.share.wait.n, 1);
});

test('見える物は向き (yaw) によらない: observe の blockVisible は目からの視線 (raycast) だけで決める', () => {
  const calls = [];
  const mk = (yaw) => ({
    entity: { yaw, pitch: 0, height: 1.62, position: { x: 0, y: 64, z: 0, offset(dx, dy, dz) { return new (require('vec3').Vec3)(this.x + dx, this.y + dy, this.z + dz); } } },
    world: { raycast: (_from, dir) => { calls.push(dir); return { position: { x: 0, y: 64, z: -5 } }; } },
  });
  // 向きを反対にしても同じ答え (視界の角度で絞っていない)
  const p = { x: 0, y: 64, z: -5 };
  const a = blockVisible(mk(0), p);
  const b = blockVisible(mk(Math.PI), p);
  assert.strictEqual(a, true);
  assert.strictEqual(a, b);
  assert.deepStrictEqual(calls[0], calls[1]);
});
