'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Memory } = require('../src/memory');

test('上限を超えたら古いものから忘れる', () => {
  const m = new Memory({ limits: { events: 5, heard: 3, places: 4, visited: 2 } });
  for (let i = 0; i < 20; i++) {
    m.tick = i;
    m.noteEvent('wait', String(i), true, 'ok');
    m.noteHeard('A', `msg${i}`);
    m.notePlace('oak_log', { x: i * 20, y: 64, z: 0 }); // 別々の格子
    m.noteVisit({ x: i * 20, y: 64, z: 0 });
  }
  assert.strictEqual(m.events.length, 5);
  assert.strictEqual(m.events[0].arg, '15');
  assert.strictEqual(m.heard.length, 3);
  assert.strictEqual(m.places.length, 4);
  assert.ok(m.places.every((p) => p.lastSeen >= 16), '最近見た場所が残る');
  assert.strictEqual(m.visited.length, 2);
});

test('同じ格子の同じ種類は1つにまとめる', () => {
  const m = new Memory();
  m.notePlace('oak_log', { x: 1, y: 64, z: 1 });
  m.notePlace('oak_log', { x: 3, y: 65, z: 2 });
  m.notePlace('water', { x: 3, y: 63, z: 2 });
  assert.strictEqual(m.places.length, 2);
  m.forgetPlace('oak_log', { x: 2, y: 64, z: 2 });
  assert.deepStrictEqual(m.places.map((p) => p.kind), ['water']);
});

test('長い文は切り詰める・プロンプトは上限の数だけ', () => {
  const m = new Memory({ limits: { promptEvents: 2, promptPlaces: 1, textLen: 10 } });
  m.noteEvent('say', 'x', true, 'あ'.repeat(50));
  m.noteEvent('wait', '1', true, 'ok1');
  m.noteEvent('wait', '2', false, 'ng2');
  m.notePlace('oak_log', { x: 10, y: 64, z: 0 });
  m.notePlace('water', { x: 100, y: 64, z: 0 });
  assert.strictEqual(m.events[0].msg.length, 10);
  const txt = m.toPromptText({ x: 0, y: 64, z: 0 });
  assert.match(txt, /M1=oak_log 東10\(10m\)/);
  assert.ok(!/water/.test(txt));
  assert.ok(!/say/.test(txt));
  assert.match(txt, /wait\(2\)→失敗:ng2/);
});

test('recentFailures: 直近で同じ失敗が2回以上', () => {
  const m = new Memory();
  m.noteEvent('collect', 'spruce_log', false, 'x');
  m.noteEvent('craft', 'stick', true, 'ok');
  m.noteEvent('collect', 'spruce_log', false, 'x');
  m.noteEvent('explore', 'north', false, 'x');
  assert.deepStrictEqual([...m.recentFailures(4, 2)], ['collect:spruce_log']);
  m.noteEvent('wait', '1', true, 'ok');
  m.noteEvent('wait', '1', true, 'ok');
  m.noteEvent('wait', '1', true, 'ok');
  assert.strictEqual(m.recentFailures(4, 2).size, 0);
});

test('ファイルに保存して読み戻せる・壊れたファイルは退避して空から', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-'));
  const f = path.join(dir, 'm.json');
  const m = Memory.load(f);
  m.tick = 7;
  m.notePlace('crafting_table', { x: 5, y: 64, z: 5 });
  m.noteHeard('Hanako', 'やあ');
  m.save();
  const m2 = Memory.load(f);
  assert.strictEqual(m2.tick, 7);
  assert.strictEqual(m2.places[0].kind, 'crafting_table');
  assert.strictEqual(m2.heard[0].text, 'やあ');
  fs.writeFileSync(f, '{broken');
  const m3 = Memory.load(f);
  assert.strictEqual(m3.places.length, 0);
  assert.ok(fs.existsSync(f + '.bad'));
});
