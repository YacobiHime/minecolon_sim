'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Vec3 } = require('vec3');
const { summarizeObservation, collectRaw } = require('../src/observe');
const { relDir, timePhase } = require('../src/util');
const { mockRaw, mockBot } = require('./fixtures');

test('relDir: 東西南北と高さ', () => {
  assert.strictEqual(relDir({ x: 0, y: 64, z: 0 }, { x: 5, y: 64, z: -3 }), '東5北3(6m)');
  assert.strictEqual(relDir({ x: 0, y: 64, z: 0 }, { x: -2, y: 70, z: 4 }), '西2南4上6(7m)');
  assert.strictEqual(relDir({ x: 0, y: 64, z: 0 }, { x: 0, y: 64, z: 0 }), 'ここ(0m)');
});

test('timePhase', () => {
  assert.strictEqual(timePhase(6000), '昼');
  assert.strictEqual(timePhase(18000), '夜');
});

test('summarizeObservation: 目印を先に・持ち物・聞こえた話', () => {
  const txt = summarizeObservation(mockRaw());
  assert.match(txt, /体力20\/20 満腹18\/20 時間:昼/);
  assert.match(txt, /持ち物: spruce_logx2, breadx1/);
  // notable (spruce_log, water) が grass_block より前
  const line = txt.split('\n').find((l) => l.startsWith('見えるブロック'));
  assert.ok(line.indexOf('spruce_log') < line.indexOf('grass_block'));
  assert.match(line, /spruce_log 東5北3\(6m\) 他2\+/);
  assert.match(txt, /プレイヤーHanako 西4南4/);
  assert.match(txt, /Hanako「こんにちは」/);
});

test('summarizeObservation: maxTypes で種類の数を絞る', () => {
  const txt = summarizeObservation(mockRaw(), { maxTypes: 1 });
  const line = txt.split('\n').find((l) => l.startsWith('見えるブロック'));
  assert.strictEqual(line.split(', ').length, 1);
});

test('collectRaw: 壁の向こうのブロックは見えない (完全情報にしない)', () => {
  const blocks = new Map();
  // 目の高さ (y=65) に、東に壁 (x=3) とその奥の原木 (x=6)、西に見通しのよい原木 (x=-4)
  blocks.set('3,65,0', 'stone');
  blocks.set('6,65,0', 'oak_log');
  blocks.set('-4,65,0', 'birch_log');
  blocks.set('0,63,0', 'grass_block');
  // 半径の外
  blocks.set('40,65,0', 'diamond_ore');
  const bot = mockBot({ blocks, pos: new Vec3(0.5, 64, 0.5) });
  const raw = collectRaw(bot, { visionRadius: 16 });
  const names = raw.blocks.map((b) => b.name);
  assert.ok(names.includes('birch_log'));
  assert.ok(names.includes('stone'));
  assert.ok(!names.includes('oak_log'), '壁の向こうの原木が見えてしまっている');
  assert.ok(!names.includes('diamond_ore'), '半径の外が見えてしまっている');
  assert.strictEqual(raw.self.phase, '夜');
  // stone は harvestTools があり、道具を持っていないので掘れない扱い
  assert.strictEqual(raw.blocks.find((b) => b.name === 'stone').diggable, false);
  assert.strictEqual(raw.blocks.find((b) => b.name === 'birch_log').notable, true);
});

test('collectRaw: exclude の場所 (拠点の小屋) のブロックは素材として見せない', () => {
  const blocks = new Map();
  blocks.set('-4,65,0', 'birch_log');
  blocks.set('0,63,0', 'grass_block');
  const bot = mockBot({ blocks, pos: new Vec3(0.5, 64, 0.5) });
  const raw = collectRaw(bot, { visionRadius: 16, exclude: new Set(['-4,65,0']) });
  assert.ok(!raw.blocks.some((b) => b.name === 'birch_log'));
});

test('collectRaw: 遠いエンティティ・壁の向こうのプレイヤーは入らない', () => {
  const blocks = new Map([['2,65,0', 'stone'], ['2,64,0', 'stone']]);
  const mk = (x, z, username) => ({ type: 'player', username, position: new Vec3(x, 64, z), height: 1.8 });
  const bot = mockBot({ blocks, entities: { 1: mk(5.5, 0.5, 'Behind'), 2: mk(-5, 0.5, 'Near'), 3: mk(-30, 0.5, 'Far') } });
  const raw = collectRaw(bot, { visionRadius: 16 });
  assert.deepStrictEqual(raw.entities.map((e) => e.name), ['Near']);
});
