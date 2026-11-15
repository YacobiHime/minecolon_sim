'use strict';
// src/netdiag.js: 切断の原因を後から調べる記録 (模擬の bot。サーバーには触らない)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { NetDiag, keepAliveNum } = require('../src/netdiag');

function fakeBot() {
  const bot = new EventEmitter();
  const client = new EventEmitter();
  client.socket = { readableLength: 0, writableLength: 0, bytesRead: 0, bytesWritten: 0, destroyed: false, isPaused: () => false };
  client.splitter = { _readableState: { length: 0 } };
  client.deserializer = { _writableState: { length: 5 }, _readableState: { length: 0 } };
  bot._client = client;
  return bot;
}

test('keepAliveNum: BigInt・[hi, lo]・数', () => {
  assert.strictEqual(keepAliveNum(BigInt(1234)), 1234);
  assert.strictEqual(keepAliveNum([1, 5]), 4294967301);
  assert.strictEqual(keepAliveNum(77), 77);
  assert.strictEqual(keepAliveNum(undefined), null);
});

test('NetDiag: 受信量・keepalive の遅れの推定・切断の時点の様子を書く', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netdiag-'));
  try {
    let now = 1_000_000;
    const file = path.join(dir, 'netdiag-3.jsonl');
    const nd = new NetDiag({ file, proc: 3, now: () => now, kaSlowMs: 2000 });
    nd.t0 = now; nd.lastT = now; nd.lastCpu = process.cpuUsage();
    const bot = fakeBot();
    nd.watch('Ryo', bot);
    now += 3000; bot.emit('spawn');
    const c = bot._client;
    for (let i = 0; i < 3; i++) c.emit('packet', {}, { name: 'map_chunk' }, Buffer.alloc(40000));
    c.emit('packet', {}, { name: 'entity_move' }, Buffer.alloc(20));
    // サーバーの時計 500000 で送った keepalive を now に受けた (基準)、次は 15 秒後に送ったものを 5 秒遅れて受けた
    c.emit('keep_alive', { keepAliveId: BigInt(500000) });
    const base = now;
    now = base + 20000; c.socket.bytesRead = 200000; c.socket.writableLength = 123;
    c.emit('keep_alive', { keepAliveId: BigInt(515000) });
    const row = nd.sample();
    const b = row.bots[0];
    assert.strictEqual(b.n, 'Ryo');
    assert.strictEqual(b.pk, 4);
    assert.deepStrictEqual(b.top[0], ['map_chunk', 3, 117]);
    assert.strictEqual(b.ka.n, 2);
    assert.strictEqual(b.ka.delayMaxMs, 5000);
    assert.strictEqual(b.netKB, 195);
    assert.strictEqual(b.wq, 123);
    now += 16000;
    bot.emit('kicked', '{"translate":"disconnect.timeout"}');
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const kinds = rows.map((r) => r.kind);
    assert.deepStrictEqual(kinds, ['connect', 'spawn', 'ka', 'sample', 'kicked']);
    assert.strictEqual(rows[1].ms, 3000);
    assert.strictEqual(rows[2].delayMs, 5000);
    const k = rows[4];
    assert.match(k.reason, /disconnect\.timeout/);
    assert.strictEqual(k.snapshot.ka.sinceLastMs, 16000);
    assert.strictEqual(k.snapshot.sinceLastPacketMs, 36000);
    assert.strictEqual(k.snapshot.buf.desIn, 5);
    assert.strictEqual(k.snapshot.sock.wq, 123);
    assert.strictEqual(k.proc, 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('NetDiag: イベントループが止まったら lag の行をすぐ書く', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netdiag-'));
  try {
    const file = path.join(dir, 'nd.jsonl');
    const nd = new NetDiag({ file, probeMs: 20, lagEventMs: 150, intervalMs: 60000 });
    nd.start();
    await new Promise((r) => setTimeout(r, 50));
    const t = Date.now(); while (Date.now() - t < 300) { /* 止める */ }
    await new Promise((r) => setTimeout(r, 60));
    nd.stop();
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const lag = rows.find((r) => r.kind === 'lag');
    assert.ok(lag && lag.ms >= 150, JSON.stringify(rows));
    assert.strictEqual(lag.phase, 'connect');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
