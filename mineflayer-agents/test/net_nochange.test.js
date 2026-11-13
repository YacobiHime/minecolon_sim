'use strict';
// 直近 netWindow 回をさかのぼった正味の変化で、繰り返しを「何も変わらなかった」と見る (nochange.netNoChange)
// 2026-11-03 の実行の記録 (test/records/run_20261103_loops.json、runs/ から抜き出し) で確かめる
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const nochange = require('../src/nochange');
const ask = require('../src/ask');
const { Memory } = require('../src/memory');
const { buildContext } = require('../src/agent');
const { loadConfig } = require('../src/config');
const { historyFromRows, replay, intervals } = require('../tools/replay_nochange');
const { mockRaw } = require('./fixtures');

const DATA = require(path.join(__dirname, 'records', 'run_20261103_loops.json'));
const E = (action, arg, inv, x = 0, extra = {}) => nochange.histEntry({ action, arg, inventory: Object.entries(inv).map(([name, count]) => ({ name, count })), pos: { x, y: 64, z: 0 }, ...extra });

test('blockDelta: 積んだ・置いた数は +、掘った数は −、失敗は 0', () => {
  assert.strictEqual(nochange.blockDelta('pillar', { ok: true, msg: 'jungle_planksを4個積んで4段登った' }), 4);
  assert.strictEqual(nochange.blockDelta('collect', { ok: true, msg: 'jungle_planksを1個掘って1個拾った' }), -1);
  assert.strictEqual(nochange.blockDelta('place', { ok: true, msg: 'crafting_tableを(-316,63,10)に置いた' }), 1);
  assert.strictEqual(nochange.blockDelta('build', { ok: true, msg: '小屋に…', placed: 3 }), 3);
  assert.strictEqual(nochange.blockDelta('collect', { ok: false, msg: 'jungle_logを3個掘って0個拾った' }), 0);
});

test('netNoChange: 窓が埋まるまでは何もしない。窓全体の正味0なら繰り返した行動すべて', () => {
  const h = [E('look_around', '', { p: 12 })];
  for (let i = 0; i < 10; i++) h.push(i % 2 ? E('collect', 'p', { p: 12 }, 0, { result: { ok: true, msg: 'pを1個掘って1個拾った' } }) : E('pillar', 'log', { p: 11 }, 0, { result: { ok: true, msg: 'pを1個積んで1段登った' } }));
  assert.strictEqual(nochange.netNoChange(h.slice(0, 10), { netWindow: 10 }).keys.size, 0);
  const r = nochange.netNoChange(h, { netWindow: 10 });
  assert.deepStrictEqual([...r.keys].sort(), ['collect:p', 'pillar:log']);
  assert.deepStrictEqual(r.counts, { 'pillar:log': 5, 'collect:p': 5 });
  assert.strictEqual(r.scope, 'window');
  // 持ち物が増えていく、8m 以上動いた、新しいマスに入った → 検出しない
  const grow = [E('look_around', '', { log: 0 })];
  for (let i = 0; i < 10; i++) grow.push(E('collect', 'log', { log: i + 1 }));
  assert.strictEqual(nochange.netNoChange(grow).keys.size, 0);
  const walk = [E('look_around', '', {})];
  for (let i = 0; i < 10; i++) walk.push(E('go_to', 'M1', {}, i * 2));
  assert.strictEqual(nochange.netNoChange(walk).keys.size, 0);
  const cell = [E('look_around', '', {})];
  for (let i = 0; i < 10; i++) cell.push(E('explore', 'east', {}, 0, { newCell: i === 5 }));
  assert.strictEqual(nochange.netNoChange(cell).keys.size, 0);
  // 話す・聞く・攻撃は数えない
  const talk = [E('look_around', '', {})];
  for (let i = 0; i < 10; i++) talk.push(E(i % 2 ? 'say' : 'attack', 'x', {}));
  assert.strictEqual(nochange.netNoChange(talk).keys.size, 0);
});

test('netNoChange: 窓の中で別の進みがあっても、繰り返した行動の組だけ足して正味0なら、その行動だけ', () => {
  const h = [E('look_around', '', { t: 1, p: 14 })];
  const seq = [['collect', 't', { t: 1, p: 14 }, -1], ['place', 't', { t: 0, p: 14 }, 1], ['craft', 'chest', { t: 0, p: 6, chest: 1 }, 0], ['collect', 't', { t: 1, p: 6, chest: 1 }, -1], ['place', 't', { t: 0, p: 6, chest: 1 }, 1],
    ['craft', 'planks', { t: 0, p: 10, chest: 1 }, 0], ['collect', 't', { t: 1, p: 10, chest: 1 }, -1], ['place', 't', { t: 0, p: 10, chest: 1 }, 1], ['look_around', '', { t: 0, p: 10, chest: 1 }, 0], ['wait', '3', { t: 0, p: 10, chest: 1 }, 0]];
  for (const [a, g, inv, b] of seq) h.push(E(a, g, inv, 0, { result: { ok: true, msg: b > 0 ? 'tを(1,2,3)に置いた' : b < 0 ? 'tを1個掘って1個拾った' : '' } }));
  const r = nochange.netNoChange(h);
  assert.strictEqual(r.scope, 'subset');
  assert.deepStrictEqual([...r.keys].sort(), ['collect:t', 'place:t']);
  assert.ok(!r.keys.has('craft:chest'));
});

test('troubles と penalties: 正味の変化で見た行動も「何度やっても何も変わらなかった」になり、Jev の重みの回数に入る', () => {
  const m = new Memory({ limits: { promptItems: 20 } });
  m.noteEvent('pillar', 'jungle_log', true, 'jungle_planksを1個積んで1段登った');
  const t = ask.troubles(m, 4, 2, { window: 4, repeat: 2, netKeys: new Set(['pillar:jungle_log']) });
  assert.strictEqual(t.length, 1);
  assert.strictEqual(t[0].kind, 'noChange');
  assert.match(ask.questionText('Taro', t[0]), /何度やっても何も変わらなかった/);
  const cfg = loadConfig(null, { persona: { name: 'Jiro' }, goal: { text: 'x', hints: [] }, help: { askOthers: true, excludeFailures: false, noChange: true } });
  const c = buildContext(mockRaw(), m, cfg, { foods: new Set(), net: { keys: new Set(['pillar:jungle_log']), counts: { 'pillar:jungle_log': 5 } } });
  assert.strictEqual(c.noChange.penalties['pillar:jungle_log'], 5);
});

test('2026-11-03 の記録: Jiro の pillar→collect(自分の足場) と Taro の作業台の place→collect を検出し、ふつうに木を集めて作る区間は検出しない', () => {
  const jiro = intervals(replay(DATA.jiro));
  const jl = jiro.find((iv) => iv.keys.includes('pillar:jungle_log') && iv.keys.includes('collect:jungle_planks') && iv.to - iv.from >= 30);
  assert.ok(jl, JSON.stringify(jiro));
  assert.ok(jl.from <= 200, `Jiro は loop 188 から繰り返し。検出の始まり ${jl.from}`);
  const taro = intervals(replay(DATA.taroTable));
  assert.ok(taro.some((iv) => iv.keys.includes('place:crafting_table') && iv.keys.includes('collect:crafting_table') && iv.from <= 157), JSON.stringify(taro));
  const normal = replay(DATA.taroNormal);
  assert.deepStrictEqual(normal, [], 'Taro loop 1〜45 (原木を集める・板材や作業台を作る・探す) は検出しない');
  // 1回ごとの判定 (nochange.changed) では、この繰り返しは毎回「変わった」になる (すり抜けていた)
  const rows = DATA.jiro.filter((r) => r.loop >= 190 && r.loop <= 237);
  const snap = (r) => nochange.snapshot({ inventory: r.inventory, pos: r.pos });
  assert.ok(rows.slice(1).every((r, i) => nochange.changed(snap(rows[i]), snap(r))));
  assert.strictEqual(historyFromRows(DATA.jiro).length, DATA.jiro.length);
});
