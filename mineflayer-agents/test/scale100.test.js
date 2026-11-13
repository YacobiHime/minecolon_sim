'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { evaluate } = require('../tools/check_scale_run');

const ROOT = path.join(__dirname, '..');

function properties(file) {
  return Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .filter((x) => x && !x.startsWith('#') && x.includes('='))
    .map((x) => { const i = x.indexOf('='); return [x.slice(0, i), x.slice(i + 1)]; }));
}

test('100人用サーバー設定: 接続枠・追跡距離・チャンク負荷・圧死', () => {
  const p = properties(path.join(ROOT, 'server-fabric', 'server.properties'));
  assert.ok(Number(p['max-players']) >= 100);
  assert.ok((Number(p['view-distance']) - 1) * 16 >= 48, '会話範囲 48m の相手の位置が届く');
  assert.ok(Number(p['view-distance']) <= 5, '100人で送るチャンクを抑える');
  assert.ok(Number(p['simulation-distance']) <= 4, '100人で tick するチャンクを抑える');
  assert.strictEqual(p['network-compression-threshold'], '-1', '同一マシンでは圧縮 CPU を使わない');
  const world = fs.readFileSync(path.join(ROOT, 'server-fabric', 'first_setting_world.sh'), 'utf8');
  assert.match(world, /gamerule maxEntityCramming 0/);
});

test('check_scale_run: 正常な100人試験を通し、切断と遅延を落とす', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scale100-'));
  const base = {
    runId: 'ok', agents: 100, procs: 10, minutes: 8,
    results: Array.from({ length: 100 }, (_, i) => ({ name: `P${i}` })), disconnects: 0,
    usage: { jev: { errors: 0 }, llm: { byProvider: { luna: { errors: 0 } } } },
  };
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(base));
  for (let i = 1; i <= 10; i++) fs.writeFileSync(path.join(dir, `monitor-${i}.jsonl`), `${JSON.stringify({ cpuPct: 80, rssMb: 600, loopLag: { p99: 900, max: 2200 } })}\n`);
  assert.strictEqual(evaluate(dir, { agents: 100 }).ok, true);
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ ...base, disconnects: 1 }));
  assert.strictEqual(evaluate(dir, { agents: 100 }).ok, false);
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(base));
  fs.writeFileSync(path.join(dir, 'monitor-1.jsonl'), `${JSON.stringify({ cpuPct: 100, rssMb: 700, loopLag: { p99: 12000, max: 15000 } })}\n`);
  assert.strictEqual(evaluate(dir, { agents: 100 }).ok, false);
});
