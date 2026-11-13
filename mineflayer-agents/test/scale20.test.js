'use strict';
// 20人で動かすための部品: personas・プロセスへの分け方・使用量のまとめ・2B の待ち時間・集まりと関係の行列・負荷の見張り
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { splitAgents, personaFor } = require('../run');
const { UsageMeter, mergeUsageSummaries } = require('../src/usage');
const { LLMDecider, LLM_STATS } = require('../src/deciders/llm');
const { RandomDecider } = require('../src/deciders/mock');
const { Monitor } = require('../src/monitor');
const scale = require('../tools/scale_stats');

const CFG = path.join(__dirname, '..', 'configs', 'survival_3days.json');
const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));

test('personas: 20人、名前は重ならず Minecraft の名前に使える、先頭の5人は前のまま', () => {
  const ps = cfg.personas;
  assert.strictEqual(ps.length, 20);
  assert.deepStrictEqual(ps.slice(0, 5).map((p) => p.name), ['Taro', 'Hanako', 'Jiro', 'Yuki', 'Ken']);
  const names = ps.map((p) => p.name);
  assert.strictEqual(new Set(names).size, 20);
  for (const n of names) assert.match(n, /^[A-Za-z0-9_]{3,16}$/, n);
  // チャットの「〇〇さん」で取り違えないよう、ほかの名前の先頭に含まれない
  for (const a of names) for (const b of names) if (a !== b) assert.ok(!b.startsWith(a), `${a} が ${b} の先頭`);
  // 列の見出し (先頭3文字) が重ならない
  assert.strictEqual(new Set(names.map((n) => n.slice(0, 3))).size, 20);
});

test('personas: 性格・話し方・気質・欲求の差をみな持ち、役割の決めつけはない', () => {
  const KEYS = ['bravery', 'empathy', 'obedience', 'greed', 'sociability'];
  for (const p of cfg.personas) {
    assert.ok(p.personality && p.speech, p.name);
    assert.ok(p.needs && Object.keys(p.needs).filter((k) => k !== '_comment').length >= 1, p.name);
    for (const k of KEYS) assert.ok(p.temperament[k] >= 0 && p.temperament[k] <= 1, `${p.name}.${k}`);
    assert.doesNotMatch(p.personality, /リーダー|商人|長|係|担当|役/, p.name);
  }
  // 偏りなくばらつく: 各気質が 0.3 未満と 0.7 以上の両方にいて、平均は 0.35〜0.65
  for (const k of KEYS) {
    const v = cfg.personas.map((p) => p.temperament[k]);
    assert.ok(v.some((x) => x < 0.3) && v.some((x) => x >= 0.7), k);
    const avg = v.reduce((s, x) => s + x, 0) / v.length;
    assert.ok(avg > 0.35 && avg < 0.65, `${k} 平均 ${avg}`);
  }
  // 性格の文は重ならない
  assert.strictEqual(new Set(cfg.personas.map((p) => p.personality)).size, 20);
  // 20人までは番号の付いた使い回しにならない
  assert.strictEqual(personaFor(cfg, 19).name, cfg.personas[19].name);
  assert.strictEqual(personaFor(cfg, 20).name, 'Taro2');
});

test('splitAgents: 前から順に、なるべく同じ人数に分ける', () => {
  assert.deepStrictEqual(splitAgents(20, 2), [[0, 10], [10, 20]]);
  assert.deepStrictEqual(splitAgents(20, 3), [[0, 7], [7, 14], [14, 20]]);
  assert.deepStrictEqual(splitAgents(2, 5), [[0, 1], [1, 2]]);
  assert.deepStrictEqual(splitAgents(5, 1), [[0, 5]]);
});

test('mergeUsageSummaries: プロセスごとの使用量を足し、平均と費用を出し直す', () => {
  const a = new UsageMeter({ maxJevInputTokens: 100 });
  const b = new UsageMeter({ maxJevInputTokens: 100 });
  a.addJev({ inputTokens: 30, ms: 100, rateLimited: 1 }); a.addDecision({ calls: 1, inputTokens: 30 });
  b.addJev({ inputTokens: 50, ms: 300 }); b.addDecision({ calls: 1, inputTokens: 50 });
  b.addTwoB({ kind: 'talk', promptChars: 100, ms: 10 });
  const m = mergeUsageSummaries([a.summary(), b.summary(), null], { maxInputTokens: 45000000 });
  assert.strictEqual(m.jev.calls, 2);
  assert.strictEqual(m.jev.inputTokens, 80);
  assert.strictEqual(m.jev.rateLimited, 1);
  assert.strictEqual(m.jev.avgInputTokens, 40);
  assert.strictEqual(m.jev.inputTokensPerDecision, 40);
  assert.strictEqual(m.jev.avgMs, 200);
  assert.strictEqual(m.jev.maxInputTokens, 45000000);
  assert.strictEqual(m.jev.byStage['1'].calls, 2);
  assert.strictEqual(m.twoB.calls, 1);
  assert.strictEqual(m.twoB.byKind.talk.calls, 1);
});

test('LLM_STATS: 2B の応答時間からサーバーの処理時間を引いて待ち時間を数える', async () => {
  LLM_STATS.reset();
  const fetch = async () => { await new Promise((r) => setTimeout(r, 60)); return { ok: true, json: async () => ({ choices: [{ message: { content: '{"say":"やあ"}' } }], usage: { prompt_tokens: 10 }, timings: { prompt_ms: 5, predicted_ms: 5 } }) }; };
  const llm = new LLMDecider({ fetch, mode: 'talk' });
  const r = await llm.complete([{ role: 'user', content: 'x' }], null);
  assert.strictEqual(r.serverMs, 10);
  assert.ok(r.waitMs >= 40, String(r.waitMs));
  const bad = new LLMDecider({ fetch: async () => { throw new Error('down'); } });
  await assert.rejects(() => bad.complete([{ role: 'user', content: 'x' }], null));
  const w = LLM_STATS.window();
  assert.strictEqual(w.calls, 2);
  assert.strictEqual(w.errors, 1);
  assert.ok(w.waitMs.p50 >= 40);
  assert.strictEqual(LLM_STATS.window().calls, 0); // window は前回からの分
  assert.strictEqual(LLM_STATS.total().calls, 2);
  LLM_STATS.reset();
});

test('RandomDecider の talkP: その確率で「話す」を返す (Jev なしで 2B の発言の負荷を試す)', async () => {
  const seq = [0, 0.1, 0, 0.9]; // 行動の番号・話すか を交互に
  let i = 0;
  const d = new RandomDecider({ talkP: 0.5, rand: () => seq[i++ % seq.length] });
  const ctx = { actions: [{ name: 'wait', argType: 'none' }] };
  const r1 = await d.decide(ctx);
  assert.strictEqual(r1.talkP, 1);
  const r2 = await d.decide(ctx);
  assert.strictEqual(r2.talkP, 0);
  const plain = await new RandomDecider({}).decide(ctx);
  assert.strictEqual(plain.talkP, undefined);
});

test('Monitor: CPU・メモリ・判断の間隔・切断・Jev の 429 を1行に書く', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mon-'));
  const agents = [{ memory: { tick: 0 }, bot: { entity: {} }, stopped: false }, { memory: { tick: 0 }, bot: { entity: {} }, stopped: true }];
  const meter = new UsageMeter();
  const m = new Monitor({ file: path.join(dir, 'monitor.jsonl'), agents, meter, disconnects: { n: 1 }, intervalMs: 1e9, log: () => {} });
  m.start();
  agents[0].memory.tick = 6;
  meter.addJev({ inputTokens: 100, rateLimited: 2 });
  const row = m.sample();
  m.stop();
  assert.strictEqual(row.bots.alive, 1);
  assert.strictEqual(row.bots.disconnects, 1);
  assert.strictEqual(row.decisions.n, 6);
  assert.strictEqual(row.decisions.idle, 1);
  assert.strictEqual(row.jev.rateLimited, 2);
  assert.ok(row.rssMb > 0);
  const lines = fs.readFileSync(path.join(dir, 'monitor.jsonl'), 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 1);
  const ms = scale.monitorStats(dir);
  assert.strictEqual(ms.monitor.bots.disconnects, 1);
  assert.strictEqual(ms.monitor.jevRateLimited, 2);
});

test('clustersOf / clusterStats: 16m 以内でつながった人をまとまりにする (つながりは連鎖する)', () => {
  const cl = scale.clustersOf([['A', { x: 0, y: 0, z: 0 }], ['B', { x: 10, y: 0, z: 0 }], ['C', { x: 20, y: 0, z: 0 }], ['D', { x: 100, y: 0, z: 0 }]], 16);
  assert.deepStrictEqual(cl, [['A', 'B', 'C'], ['D']]);
  const t = (s) => `2026-11-04T01:0${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}.000Z`;
  const step = (name, s, x) => ({ _name: name, ts: t(s), loop: 1, action: 'wait', result: { ok: true }, pos: { x, y: 64, z: 0 } });
  const all = [step('A', 1, 0), step('B', 1, 5), step('C', 1, 50), step('D', 1, 55), step('E', 1, 200),
    step('A', 61, 0), step('B', 61, 100), step('C', 61, 200), step('D', 61, 300), step('E', 61, 400)];
  const cs = scale.clusterStats(all);
  assert.strictEqual(cs.timeline.length, 2);
  assert.strictEqual(cs.timeline[0].groups, 2);
  assert.deepStrictEqual(cs.timeline[0].sizes, [2, 2]);
  assert.strictEqual(cs.timeline[0].alone, 1);
  assert.strictEqual(cs.timeline[1].groups, 0);
  assert.strictEqual(cs.summary.groupsMax, 2);
  assert.strictEqual(cs.perAgent.A.inGroupShare, 0.5);
  assert.deepStrictEqual(cs.perAgent.A.topWith, ['B(1)']);
});

test('relationMatrix: end の好感 (無ければ最後の判断の aff) から、初期値 50 からの変化の行列を作る', () => {
  const rows = {
    A: [{ event: 'end', social: { relations: { B: { affinity: 62, met: true }, C: { affinity: 50, met: false } } } }],
    B: [{ loop: 3, action: 'wait', result: { ok: true }, social: { aff: { A: 41 } } }],
    C: [],
  };
  const rm = scale.relationMatrix(rows);
  assert.strictEqual(rm.matrix.A.B, 12);
  assert.strictEqual(rm.matrix.A.C, null); // 会っていない
  assert.strictEqual(rm.matrix.B.A, -9);
  assert.strictEqual(rm.matrix.C.A, null);
  assert.strictEqual(rm.positive, 1);
  assert.strictEqual(rm.negative, 1);
  assert.deepStrictEqual(rm.mutual, [{ pair: 'A-B', a: 12, b: -9 }]);
  const txt = scale.matrixText(rm);
  assert.strictEqual(txt.length, 4);
  assert.match(txt[1], /^A\s+-\s+\+12\s+\.$/);
});

test('summarize_run: 20人の記録から集まり・関係の行列・判断の間隔・人ごとの要約・負荷を出す', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run20-'));
  const names = cfg.personas.map((p) => p.name);
  const t = (s) => new Date(Date.UTC(2026, 10, 4, 1, 0, 0) + s * 1000).toISOString();
  names.forEach((n, i) => {
    const rows = [{ ts: t(0), event: 'start', persona: { name: n }, decider: 'random', day: 0 }];
    for (let k = 1; k <= 4; k++) {
      // 前の10人は近く (4m おき)、後ろの10人はばらばら (100m おき)
      const x = i < 10 ? i * 4 : i * 100;
      rows.push({ ts: t(k * 30 + i), loop: k, action: k % 2 ? 'collect' : 'explore', arg: 'oak_log', result: { ok: k !== 4 }, pos: { x, y: 64, z: 0 }, decideMs: 10, parseOk: true, valid: true, inventory: [{ name: 'oak_log', count: k }],
        social: { aff: i === 0 ? { [names[1]]: 60 } : {} } });
    }
    fs.writeFileSync(path.join(dir, `${n}-x.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n'));
  });
  fs.writeFileSync(path.join(dir, 'monitor.jsonl'), JSON.stringify({ cpuPct: 50, rssMb: 900, loopLag: { p99: 30, max: 80 }, bots: { alive: 20, total: 20, disconnects: 0 }, decisions: { intervalSec: 6 }, twoB: { calls: 4, waitMs: { p95: 1200, max: 2000 } }, jev: { rateLimited: 0 } }) + '\n');
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ procs: 2, disconnects: 0, twoBLatency: { calls: 4, ms: { p50: 900, p95: 2000 }, waitMs: { p50: 300, p95: 1200, max: 2000 } }, usage: { jev: { calls: 0, inputTokens: 0 }, twoB: { calls: 4, promptChars: 400, byKind: {} } } }));
  const out = JSON.parse(execFileSync('node', [path.join(__dirname, '..', 'tools', 'summarize_run.js'), dir], { encoding: 'utf8' }));
  assert.strictEqual(out.agents, 20);
  assert.strictEqual(out.clusters.summary.largestMax, 10);
  assert.strictEqual(out.clusters.timeline[0].groups, 1);
  assert.strictEqual(out.clusters.timeline[0].alone, 10);
  assert.strictEqual(out.relations.matrix[names[0]][names[1]], 10);
  assert.strictEqual(out.relations.changed, 1);
  assert.strictEqual(out.decisions.intervalSec.p50, 30);
  assert.strictEqual(out.brief.length, 20);
  assert.match(out.brief.find((l) => l.startsWith('Taro:')), /判断4 \(間隔30s, 成功75%\)/);
  assert.strictEqual(out.load.procs, 2);
  assert.strictEqual(out.load.monitor.monitor.rssMb.max, 900);
  const txt = execFileSync('node', [path.join(__dirname, '..', 'tools', 'summarize_run.js'), dir, '--text'], { encoding: 'utf8' });
  assert.match(txt, /集まり \(16m 以内/);
  assert.match(txt, /関係 \(好感の変化/);
  assert.match(txt, /負荷 monitor: CPU/);
  assert.match(txt, /2B の応答 \(全体\)/);
});
