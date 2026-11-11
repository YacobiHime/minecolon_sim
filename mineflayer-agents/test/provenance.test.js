'use strict';
// 設置物の台帳 (src/provenance.js): 置く → 引く → 壊す → 置き換え、dimension の違い、ファイルからの復元、プロセスをまたぐ共有、bot への取り付け
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Vec3 } = require('vec3');
const { Ledger, keyOf, instrumentBot, sameFamily } = require('../src/provenance');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'prov-'));
const clock = (t0 = 1000) => { let t = t0; return () => (t += 10); };

test('Ledger: place → lookup → remove → lookup は無い (履歴は残る)', () => {
  const l = new Ledger({ now: clock() });
  l.record('Miho', { type: 'place', dim: 'overworld', pos: { x: -502, y: 64, z: -63 }, block: 'torch', by: 'Miho', purpose: 'lighting', ownership: { kind: 'personal', owner: 'Miho' } });
  const e = l.lookup('minecraft:overworld', [-502, 64, -63]);
  assert.strictEqual(e.block, 'torch');
  assert.strictEqual(e.placedBy, 'Miho');
  assert.strictEqual(e.purpose, 'lighting');
  assert.strictEqual(e.status, 'active');
  assert.deepStrictEqual(e.ownership, { kind: 'personal', owner: 'Miho' });
  assert.strictEqual(e.dimension, 'minecraft:overworld');
  l.record('Yua', { type: 'remove', dim: 'overworld', pos: [-502, 64, -63], block: 'torch', by: 'Yua', reasonCode: 'selfish_acquisition', intentId: 'Yua-i1' });
  assert.strictEqual(l.lookup('overworld', [-502, 64, -63]), null);
  const g = l.get('overworld', [-502, 64, -63]);
  assert.strictEqual(g.status, 'removed');
  assert.strictEqual(g.removedBy, 'Yua');
  assert.strictEqual(g.removeReason, 'selfish_acquisition');
  assert.deepStrictEqual(g.history.map((h) => h.type), ['place', 'remove']);
  assert.strictEqual(g.history[1].intentId, 'Yua-i1');
});

test('Ledger: 置いてある所に別の物を置くと置き換え (supersedes)。同じ物の別の形 (壁の松明) は同じ物として壊れる', () => {
  const l = new Ledger({ now: clock() });
  l.record('Miho', { type: 'place', pos: [0, 64, 0], block: 'oak_planks', by: 'Miho' });
  l.record('Ken', { type: 'place', pos: [0, 64, 0], block: 'cobblestone', by: 'Ken' });
  const e = l.lookup(null, [0, 64, 0]);
  assert.strictEqual(e.block, 'cobblestone');
  assert.strictEqual(e.placedBy, 'Ken');
  assert.strictEqual(e.supersedes.block, 'oak_planks');
  assert.strictEqual(e.supersedes.placedBy, 'Miho');
  // 別の物を壊した記録は、置かれた物を消さない
  l.record('Yua', { type: 'remove', pos: [0, 64, 0], block: 'dirt', by: 'Yua' });
  assert.ok(l.lookup(null, [0, 64, 0]));
  l.record('Miho', { type: 'place', pos: [1, 64, 0], block: 'wall_torch', by: 'Miho' });
  l.record('Yua', { type: 'remove', pos: [1, 64, 0], block: 'torch', by: 'Yua' });
  assert.strictEqual(l.lookup(null, [1, 64, 0]), null);
  assert.ok(sameFamily('wall_torch', 'torch'));
  assert.ok(sameFamily('white_bed', 'red_bed'));
});

test('Ledger: dimension が違えば別の位置', () => {
  const l = new Ledger({ now: clock() });
  l.record('A', { type: 'place', dim: 'minecraft:overworld', pos: [5, 64, 5], block: 'torch', by: 'A' });
  l.record('A', { type: 'place', dim: 'minecraft:the_nether', pos: [5, 64, 5], block: 'netherrack', by: 'A' });
  assert.strictEqual(l.lookup('minecraft:overworld', [5, 64, 5]).block, 'torch');
  assert.strictEqual(l.lookup('the_nether', [5, 64, 5]).block, 'netherrack');
  assert.strictEqual(l.lookup('the_end', [5, 64, 5]), null);
  assert.notStrictEqual(keyOf('overworld', [5, 64, 5]), keyOf('the_nether', [5, 64, 5]));
  assert.strictEqual(l.near('overworld', [0, 64, 0], 16).length, 1);
});

test('Ledger: 遅れて届いた出来事も時刻の順に畳む (壊した記録が先に届いても結果は同じ)', () => {
  const l = new Ledger();
  l.apply({ id: 'Yua#1', writer: 'Yua', seq: 1, ms: 2000, t: 'b', type: 'remove', dim: 'minecraft:overworld', pos: [0, 64, 0], block: 'torch', by: 'Yua' });
  assert.strictEqual(l.get(null, [0, 64, 0]), null);
  l.apply({ id: 'Miho#1', writer: 'Miho', seq: 1, ms: 1000, t: 'a', type: 'place', dim: 'minecraft:overworld', pos: [0, 64, 0], block: 'torch', by: 'Miho' });
  assert.strictEqual(l.get(null, [0, 64, 0]).status, 'removed');
  assert.strictEqual(l.get(null, [0, 64, 0]).placedBy, 'Miho');
  assert.strictEqual(l.apply({ id: 'Miho#1', writer: 'Miho', seq: 1, ms: 1000, type: 'place', pos: [0, 64, 0] }), false); // 同じ出来事は二度入れない
});

test('Ledger: abandoned (足場) と gone (誰かは分からないが無くなった) と reclassify (共有にした)', () => {
  const l = new Ledger({ now: clock() });
  l.record('A', { type: 'place', pos: [0, 65, 0], block: 'dirt', by: 'A', status: 'abandoned', purpose: 'scaffold' });
  assert.strictEqual(l.lookup(null, [0, 65, 0]).status, 'abandoned');
  l.record('B', { type: 'gone', pos: [0, 65, 0], block: 'dirt', by: 'B' });
  assert.strictEqual(l.get(null, [0, 65, 0]).status, 'missing');
  l.record('A', { type: 'place', pos: [3, 64, 0], block: 'chest', by: 'A' });
  l.record('A', { type: 'reclassify', pos: [3, 64, 0], by: 'A', ownership: { kind: 'public', owner: 'A' }, projectId: 'shared_chest' });
  assert.deepStrictEqual(l.lookup(null, [3, 64, 0]).ownership, { kind: 'public', owner: 'A' });
  assert.strictEqual(l.lookup(null, [3, 64, 0]).projectId, 'shared_chest');
});

test('Ledger: ファイルに追記し、Ledger.load で作り直せる (再起動・オフラインの集計)', () => {
  const dir = tmp();
  const l = new Ledger({ dir, now: clock() });
  l.addWriter('Miho');
  l.record('Miho', { type: 'place', pos: [1, 2, 3], block: 'white_bed', by: 'Miho', purpose: 'sleeping' });
  l.record('Miho', { type: 'place', pos: [4, 5, 6], block: 'torch', by: 'Miho' });
  l.record('Miho', { type: 'remove', pos: [4, 5, 6], block: 'torch', by: 'Miho' });
  const lines = fs.readFileSync(path.join(dir, 'Miho.jsonl'), 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 3);
  const r = Ledger.load(dir);
  assert.strictEqual(r.lookup(null, [1, 2, 3]).purpose, 'sleeping');
  assert.strictEqual(r.get(null, [4, 5, 6]).status, 'removed');
  assert.strictEqual(r.entries().length, 2);
});

test('Ledger: ほかのプロセスが書いた行を sync で読み足す (書きかけの行は次に回す)', () => {
  const dir = tmp();
  const l = new Ledger({ dir, syncMs: 0 });
  l.addWriter('Yua');
  // 別の Node プロセスが Miho の名前で書く
  const script = `const { Ledger } = require(${JSON.stringify(path.resolve(__dirname, '../src/provenance'))});
    const l = new Ledger({ dir: ${JSON.stringify(dir)} }); l.addWriter('Miho');
    l.record('Miho', { type: 'place', pos: [-502, 64, -63], block: 'torch', by: 'Miho', purpose: 'lighting' });`;
  execFileSync(process.execPath, ['-e', script]);
  assert.strictEqual(l.lookup(null, [-502, 64, -63]), null);
  assert.strictEqual(l.sync({ force: true }), 1);
  assert.strictEqual(l.lookup(null, [-502, 64, -63]).placedBy, 'Miho');
  // 書きかけの行
  const ev = { id: 'Ken#1', writer: 'Ken', seq: 1, ms: Date.now(), t: 'x', type: 'place', dim: 'minecraft:overworld', pos: [9, 64, 9], block: 'crafting_table', by: 'Ken' };
  const s = JSON.stringify(ev) + '\n';
  fs.appendFileSync(path.join(dir, 'Ken.jsonl'), s.slice(0, 20));
  assert.strictEqual(l.sync({ force: true }), 0);
  fs.appendFileSync(path.join(dir, 'Ken.jsonl'), s.slice(20));
  assert.strictEqual(l.sync({ force: true }), 1);
  assert.strictEqual(l.lookup(null, [9, 64, 9]).block, 'crafting_table');
  // 自分のファイル (同じプロセスで書いた物) は読み直さない
  l.record('Yua', { type: 'place', pos: [0, 70, 0], block: 'torch', by: 'Yua' });
  assert.strictEqual(l.sync({ force: true }), 0);
});

test('Ledger.shared: 同じ記録の場所なら同じプロセスの全員で1つの台帳', () => {
  const dir = tmp();
  const a = Ledger.shared(dir); const b = Ledger.shared(dir);
  assert.strictEqual(a, b);
  a.addWriter('A'); a.record('A', { type: 'place', pos: [0, 64, 0], block: 'torch', by: 'A' });
  assert.ok(b.lookup(null, [0, 64, 0]));
});

test('instrumentBot: bot.dig / placeBlock / activateBlock を包んで、掘った・置いた所を知らせる (元の動きは変えない)', async () => {
  const blocks = new Map([['0,64,0', 'torch'], ['1,63,0', 'dirt']]);
  const bot = {
    heldItem: { name: 'torch' },
    blockAt: (p) => { if (typeof p.floored !== 'function') throw new Error('mineflayer の blockAt は Vec3 が要る'); const n = blocks.get(`${p.x},${p.y},${p.z}`); return n ? { name: n, position: new Vec3(p.x, p.y, p.z) } : { name: 'air', position: new Vec3(p.x, p.y, p.z) }; },
    dig: async (b) => { blocks.delete(`${b.position.x},${b.position.y},${b.position.z}`); return 'dug'; },
    placeBlock: async (ref, face) => { const t = ref.position.plus(face); blocks.set(`${t.x},${t.y},${t.z}`, 'wall_torch'); return 'placed'; },
    activateBlock: async (b) => { blocks.set(`${b.position.x},${b.position.y},${b.position.z}`, 'farmland'); },
  };
  const ev = [];
  assert.ok(instrumentBot(bot, { beforeDig: (i) => ev.push(['before', i.name, i.pos]), afterDig: (i, ok) => ev.push(['after', i.name, ok]), afterPlace: (i) => ev.push(['place', i.name, i.pos, i.held]), afterActivate: (i) => ev.push(['act', i.name, i.was]) }));
  assert.ok(!instrumentBot(bot, {})); // 二度は付けない
  assert.strictEqual(await bot.dig({ name: 'torch', position: new Vec3(0, 64, 0) }), 'dug');
  assert.strictEqual(await bot.placeBlock({ position: new Vec3(1, 63, 0) }, new Vec3(0, 1, 0)), 'placed');
  await bot.activateBlock({ position: new Vec3(1, 63, 0) }, new Vec3(0, 1, 0));
  await new Promise((r) => setTimeout(r, 450));
  assert.deepStrictEqual(ev[0], ['before', 'torch', { x: 0, y: 64, z: 0 }]);
  assert.deepStrictEqual(ev[1], ['after', 'torch', true]);
  assert.deepStrictEqual(ev[2], ['place', 'wall_torch', { x: 1, y: 64, z: 0 }, 'torch']);
  assert.deepStrictEqual(ev[3], ['act', 'farmland', 'dirt']);
  // 掘るのに失敗したら ok: false (例外はそのまま)
  bot.__provenance = false;
  const b2 = { blockAt: bot.blockAt, dig: async () => { throw new Error('Digging aborted'); } };
  const ev2 = [];
  instrumentBot(b2, { afterDig: (i, ok) => ev2.push(ok) });
  await assert.rejects(() => b2.dig({ name: 'stone', position: new Vec3(0, 0, 0) }), /aborted/);
  assert.deepStrictEqual(ev2, [false]);
});
