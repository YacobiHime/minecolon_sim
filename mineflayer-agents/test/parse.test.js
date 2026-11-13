'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseDecision } = require('../src/parse');

const ok = (s) => { const r = parseDecision(s); assert.ok(r.ok, `parse failed: ${s} (${r.error})`); return r; };

test('きれいな JSON', () => {
  const r = ok('{"action":"collect","arg":"oak_log","say":""}');
  assert.deepStrictEqual(r.value, { action: 'collect', arg: 'oak_log', say: '' });
  assert.ok(!r.repaired);
});

test('コードフェンスと前後の文章', () => {
  const r = ok('次はこうする:\n```json\n{"action": "craft", "arg": "oak_planks", "say": "板を作るぞ"}\n```\n以上');
  assert.strictEqual(r.value.action, 'craft');
  assert.strictEqual(r.value.say, '板を作るぞ');
});

test('末尾のカンマ・シングルクォート・クォートなしのキー', () => {
  assert.strictEqual(ok("{'action': 'explore', 'arg': 'north',}").value.arg, 'north');
  assert.strictEqual(ok('{action: "wait", arg: "3"}').value.action, 'wait');
});

test('出力が途中で切れた (max_tokens)', () => {
  const r = ok('{"action":"say","arg":"こんにちは、今日は木を');
  assert.strictEqual(r.value.action, 'say');
  assert.ok(r.repaired);
});

test('arg がオブジェクト・別名のキー', () => {
  assert.strictEqual(ok('{"action":"go_to","args":{"target":"M1"}}').value.arg, 'M1');
  assert.strictEqual(ok('{"act":"look_around"}').value.action, 'look_around');
});

test('文字列の中の括弧は数えない', () => {
  assert.strictEqual(ok('{"action":"say","arg":"{笑}","say":"x"} {"action":"wait"}').value.arg, '{笑}');
});

test('壊れていて action がないものは失敗', () => {
  assert.ok(!parseDecision('').ok);
  assert.ok(!parseDecision('木を切ります').ok);
  assert.ok(!parseDecision('{"arg":"oak_log"}').ok);
  assert.ok(!parseDecision(null).ok);
});
