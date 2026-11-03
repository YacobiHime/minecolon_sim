'use strict';
const test = require('node:test');
const assert = require('node:assert');
const nochange = require('../src/nochange');
const ask = require('../src/ask');
const { Memory } = require('../src/memory');
const { JevDecider } = require('../src/deciders/jev');
const { JevClient } = require('../src/jev_client');
const { buildContext } = require('../src/agent');
const { loadConfig } = require('../src/config');
const { mockRaw } = require('./fixtures');

test('nochange.changed: 持ち物・位置 (1ブロック超)・小屋で比べる', () => {
  const a = nochange.snapshot({ inventory: [{ name: 'dirt', count: 2 }], pos: { x: 0, y: 64, z: 0 }, hutFilled: 4 });
  assert.strictEqual(nochange.changed(a, nochange.snapshot({ inventory: [{ name: 'dirt', count: 1 }, { name: 'dirt', count: 1 }], pos: { x: 0.8, y: 64, z: 0.3 }, hutFilled: 4 })), false);
  assert.strictEqual(nochange.changed(a, nochange.snapshot({ inventory: [{ name: 'dirt', count: 3 }], pos: { x: 0, y: 64, z: 0 }, hutFilled: 4 })), true);
  assert.strictEqual(nochange.changed(a, nochange.snapshot({ inventory: [{ name: 'dirt', count: 2 }], pos: { x: 2, y: 64, z: 0 }, hutFilled: 4 })), true);
  assert.strictEqual(nochange.changed(a, nochange.snapshot({ inventory: [{ name: 'dirt', count: 2 }], pos: { x: 0, y: 64, z: 0 }, hutFilled: 5 })), true);
});

function memWith(evs) {
  const m = new Memory({ limits: { promptItems: 20 } });
  for (const [action, arg, ok, nc] of evs) { m.tick += 1; const e = m.noteEvent(action, arg, ok, ok ? '着いた' : '失敗'); e.nc = nc; }
  return m;
}

test('nochange: 直近4回で2回変わらなければ困りごと (成功でも)。say・ask は数えない', () => {
  const m = memWith([['collect', 'dirt', true, false], ['go_to', 'jungle_log', true, true], ['say', 'やあ', true, true], ['say', 'やあ', true, true], ['go_to', 'jungle_log', true, true]]);
  assert.deepStrictEqual([...nochange.noChangeKeys(m.events, 4, 2)], ['go_to:jungle_log']);
  assert.deepStrictEqual(nochange.penalties(m.events, 6), { 'go_to:jungle_log': 2 });
  // 失敗の繰り返しの検出だけ (noChange なし) では困りごとにならない
  assert.strictEqual(ask.troubles(m, 4, 2).length, 0);
  const t = ask.troubles(m, 4, 2, { window: 4, repeat: 2 });
  assert.strictEqual(t.length, 1);
  assert.strictEqual(t[0].kind, 'noChange');
  assert.match(ask.questionText('Hanako', t[0]), /何度やっても何も変わらなかった/);
});

test('nochange.reweight: 変わらなかった回数だけ weight を掛けて選び直す', () => {
  const probs = { 'go_to:jungle_log': 0.6, 'collect:dirt': 0.3, look_around: 0.1 };
  const id = (k) => (k.includes(':') ? k : `${k}:`);
  const r1 = nochange.reweight(probs, id, { 'go_to:jungle_log': 1 }, 0.5);
  assert.strictEqual(r1.choice, 'go_to:jungle_log'); // 0.30 vs 0.30 → 元のまま (同点は先のもの)
  const r2 = nochange.reweight(probs, id, { 'go_to:jungle_log': 2 }, 0.5);
  assert.strictEqual(r2.choice, 'collect:dirt');
  assert.strictEqual(r2.original, 'go_to:jungle_log');
  assert.ok(r2.changed);
  assert.ok(Math.abs(Object.values(r2.probs).reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test('JevDecider: ctx.noChange があれば Jev の確率に重みを掛けて選び直し、記録に残す', async () => {
  const cfg = loadConfig(null, { persona: { name: 'Taro' }, goal: { text: '小屋', hints: [] }, help: { askOthers: true, excludeFailures: false, noChange: true }, noChange: { weight: 0.1 } });
  const m = memWith([['explore', 'north', true, true], ['explore', 'north', true, true]]);
  const c = buildContext(mockRaw(), m, cfg, { foods: new Set(['bread']) });
  assert.deepStrictEqual(c.noChange.penalties, { 'explore:north': 2 });
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const keys = Object.keys(body.questions.next_action.criteria);
    const probabilities = Object.fromEntries(keys.map((k) => [k, k === 'explore:north' ? 0.8 : 0.2 / (keys.length - 1)]));
    return { ok: true, status: 200, headers: new Map(), json: async () => ({ answers: { next_action: { type: 'choice', choice: 'explore:north', confidence: 0.8, probabilities }, remember: { type: 'score', score: 1 } }, usage: { input_tokens: 10, output_tokens: 1 } }) };
  };
  const d = new JevDecider({ client: new JevClient({ apiKey: 'k', fetch }) });
  const r = await d.decide(c);
  assert.notStrictEqual(`${r.action}:${r.arg}`, 'explore:north');
  assert.strictEqual(r.jev.reweight.from, 'explore:north');
  assert.ok(r.jev.reweight.changed);
  assert.strictEqual(r.jev.choice.choice, 'explore:north'); // Jev の元の答えも残す
  // noChange が無ければ Jev の答えのまま
  const c2 = buildContext(mockRaw(), m, loadConfig(null, { persona: { name: 'Taro' }, goal: { text: '小屋', hints: [] }, help: { askOthers: true } }), { foods: new Set(['bread']) });
  assert.strictEqual(c2.noChange, null);
  const r2 = await d.decide(c2);
  assert.strictEqual(`${r2.action}:${r2.arg}`, 'explore:north');
  assert.strictEqual(r2.jev.reweight, undefined);
});
