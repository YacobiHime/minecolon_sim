'use strict';
// wait (待つ) を survival_3days の候補から外す・眠気が床で休んで減る扱い (restActions) を外す (2026-11-07 ユーザー決定)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { listActions, fallbackDecision } = require('../src/actions');
const { Needs, needsConfig } = require('../src/needs');
const { GoalPath } = require('../src/goalpath');
const { Planner, pathText, pathEn } = require('../src/planner');
const { loadConfig } = require('../src/config');
const { mockRaw } = require('./fixtures');

const names = (acts) => acts.map((a) => a.name);
const cfgOf = (n) => require(path.join(__dirname, '..', 'configs', `${n}.json`));

test('設定: survival_3days は wait も外し、first_setting・wood_pickaxe は今のまま', () => {
  const d = cfgOf('survival_3days').act.disabled;
  assert.ok(d.includes('wait'));
  assert.ok(d.includes('look_around'));
  for (const n of ['first_setting', 'wood_pickaxe']) {
    const c = cfgOf(n);
    assert.ok(!((c.act && c.act.disabled) || []).includes('wait'), n);
  }
});

test('act.disabled に wait を入れると候補から外れ、explore は残る。fallback は wait にならない', () => {
  assert.ok(names(listActions(mockRaw())).includes('wait'));
  const acts = listActions(mockRaw(), { disabled: new Set(['look_around', 'wait']) });
  assert.ok(!names(acts).includes('wait'));
  assert.ok(!names(acts).includes('look_around'));
  assert.ok(names(acts).includes('explore'));
  const r = fallbackDecision(acts);
  assert.strictEqual(r.action, 'explore');
  // explore が一覧に無くても、方角を作って explore (wait にしない)
  for (const v of [0, 0.3, 0.6, 0.99]) {
    const x = fallbackDecision(acts.filter((a) => a.name !== 'explore'), { rng: () => v });
    assert.strictEqual(x.action, 'explore');
    assert.ok(['north', 'south', 'east', 'west'].includes(x.arg));
    assert.strictEqual(x.choice.dir, x.arg);
  }
});

test('眠気: survival_3days では wait・look_around で減らない (restActions が空)。ベッドでは減る。既定 (古い設定) は今のまま', () => {
  const cfg = loadConfig(path.join(__dirname, '..', 'configs', 'survival_3days.json'));
  for (const p of cfg.personas) assert.deepStrictEqual(needsConfig(cfg, p).sleep.restActions, [], p.name);
  const n = new Needs({ cfg: needsConfig(cfg, cfg.personas[0]) });
  n.v.sleep = 0.6;
  n.onAction('wait', '3', { ok: true });
  n.onAction('look_around', '', { ok: true });
  assert.strictEqual(n.v.sleep, 0.6);
  assert.strictEqual(n.counts.rested, 0);
  n.onAction('sleep', 'red_bed', { ok: true, sleep: { slept: true, nightSkipped: true } });
  assert.ok(n.v.sleep < 0.6);
  // 既定 (first_setting などの古い設定) は wait で少し減る
  const old = new Needs({});
  old.v.sleep = 0.6;
  old.onAction('wait', '3', { ok: true });
  assert.ok(Math.abs(old.v.sleep - 0.57) < 1e-9);
});

test('状態のゴールでも、道筋の次が「育つのを待つ」だけになったら済んだ扱い (planted) で次のゴールへ (止まらない)', async () => {
  const W = { inventory: [], visibleBlocks: ['grass', 'water'], visibleMobs: [], knownBlocks: ['wheat'], stations: {}, farm: { growing: { wheat: 3 } }, cropPlaces: { wheat: { id: 'M2', d: 5 } } };
  const waitPath = new Planner(W).plan('wheat', 3);
  const gp = new GoalPath({ llm: null, log: () => {} });
  gp.goal = { kind: 'state', target: 'planted:wheat', count: 3, why: 'x', need: null, setAt: 0, best: 5, bestAt: 0 };
  gp.textCheck = async () => {};
  gp.refresh = () => { gp.path = gp.goal && gp.goal.kind === 'state' ? waitPath : null; return { d: 1 }; };
  gp.newGoal = async () => { gp.goal = { kind: 'place', target: '北の方', setAt: 1, best: 9, bestAt: 1 }; };
  assert.strictEqual(await gp.update({ raw: mockRaw() }, 1), 'planted');
  assert.strictEqual(gp.history[0].kind, 'state');
  assert.strictEqual(gp.history[0].result, 'planted');
  assert.strictEqual(gp.goal.kind, 'place');
  assert.strictEqual(gp.waitingGrowth(), false);
});

test('道筋の文に「待つ」(wait) の意味を出さない: 植わっている作物・苗木は「育っている頃に戻る」', () => {
  const farm = new Planner({ inventory: [], visibleBlocks: ['grass', 'water'], visibleMobs: [], knownBlocks: [], stations: {}, farm: { growing: { wheat: 3 } } }).plan('wheat', 3);
  const tree = new Planner({ inventory: [], visibleBlocks: ['grass_block'], visibleMobs: [], knownBlocks: [], stations: {}, saplings: { oak_sapling: 1 } }).plan('oak_log', 4);
  for (const p of [farm, tree]) {
    assert.doesNotMatch(pathText(p), /待つ/);
    assert.doesNotMatch(JSON.stringify(pathEn(p)), /\bwait/);
    assert.match(pathText(p), /育っている頃に戻る/);
  }
});

test('agent.js: 育つのを待つ間の wait・look_around の特別扱い (GROW_WAIT_ACTS) は外した', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'agent.js'), 'utf8');
  assert.doesNotMatch(src, /GROW_WAIT_ACTS\s*=/);
  assert.doesNotMatch(src, /growWait/);
});
