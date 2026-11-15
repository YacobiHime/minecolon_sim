'use strict';
// tools/exp_start.sh・tools/exp_stop.sh・tools/exp_digest.js の試験。
// 本物のサーバー・ボット・cmd_pipe には触らない: pgrep・cmd_pipe への送信・first_setting_world.sh・node run.js・
// start.sh・stop.sh はすべて一時フォルダの模擬に差し替える (環境変数 EXP_* と MC_DIR)。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { digest, lines, summaryJson } = require('../tools/exp_digest');

const ROOT = path.join(__dirname, '..');
const START = path.join(ROOT, 'tools', 'exp_start.sh');
const STOP = path.join(ROOT, 'tools', 'exp_stop.sh');

function w(file, text, mode) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); if (mode) fs.chmodSync(file, mode); }

// 模擬の環境を作る。opts: server (動いているか)・level・players (名前の配列)・bot (ボットが動いているか)・pristine・worlds
function mockEnv(opts = {}) {
  const m = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-scripts-'));
  const mc = path.join(m, 'mc');
  const st = path.join(m, 'state');
  fs.mkdirSync(st, { recursive: true });
  w(path.join(mc, 'server.properties'), `motd=x\nlevel-name=${opts.level || 'world_survival3d_19'}\ndifficulty=normal\n`);
  w(path.join(mc, 'console.log'), '[00:00:00] [Server thread/INFO]: old\n');
  if (opts.pristine !== false) w(path.join(mc, 'world_survival3d_15_pristine', 'level.dat'), 'pristine');
  for (const n of opts.worlds || ['world_survival3d_15', 'world_survival3d_19', 'world_survival3d_3']) w(path.join(mc, n, 'level.dat'), n);
  w(path.join(mc, 'start.sh'), `#!/bin/bash\necho start >> "${m}/calls.log"\ntouch "${st}/server_up"\necho '[00:00:01] [Server thread/INFO]: Done (1.0s)! For help, type "help"' >> "${mc}/console.log"\n`, 0o755);
  w(path.join(mc, 'stop.sh'), `#!/bin/bash\necho stop >> "${m}/calls.log"\nrm -f "${st}/server_up"\necho 停止完了\n`, 0o755);
  if (opts.server) fs.writeFileSync(path.join(st, 'server_up'), '');
  w(path.join(st, 'players'), (opts.players || []).join(', '));
  // pgrep -fa <パターン> の模擬: サーバーは state/server_up、ボットは state/bot_pid の PID が生きていれば出す
  w(path.join(m, 'bin', 'pgrep'), `#!/bin/bash
pat="$2"; found=1
if [[ "$pat" == *fabric* ]] && [ -f "${st}/server_up" ]; then echo "4242 /opt/jdk/bin/java -Xmx6G -jar fabric-server-launch.jar nogui"; found=0; fi
if [[ "$pat" == *run* ]]; then
  if [ -f "${st}/bot_fake" ]; then echo "5151 node run.js --config x"; found=0; fi
  if [ -f "${st}/bot_pid" ] && kill -0 "$(cat "${st}/bot_pid")" 2>/dev/null; then echo "$(cat "${st}/bot_pid") node run.js --config x"; found=0; fi
fi
exit $found
`, 0o755);
  if (opts.bot) fs.writeFileSync(path.join(st, 'bot_fake'), '');
  // cmd_pipe の代わり: list に players の内容で答える。送った行は sent.log に残す
  w(path.join(m, 'bin', 'send'), `#!/bin/bash
echo "$1" >> "${m}/sent.log"
if [ "$1" = list ]; then p=$(cat "${st}/players"); n=0; [ -n "$p" ] && n=$(echo "$p" | tr ',' '\\n' | wc -l)
  echo "[00:00:02] [Server thread/INFO]: There are $n of a max of 20 players online: $p" >> "${mc}/console.log"; fi
`, 0o755);
  w(path.join(m, 'bin', 'first_setting'), `#!/bin/bash
echo "first_setting $1 SURVIVAL_LEVEL=\${SURVIVAL_LEVEL:-} MC_DIR=$MC_DIR" >> "${m}/calls.log"
if [ "$1" = prepare_survival ]; then sed -i "s/^level-name=.*/level-name=$SURVIVAL_LEVEL/" "$MC_DIR/server.properties"; fi
`, 0o755);
  // node run.js の代わり: 記録のフォルダを作って眠る (PID を state/bot_pid に)
  w(path.join(m, 'bin', 'node'), `#!/bin/bash
echo $$ > "${st}/bot_pid"
echo "mock run.js $*"
mkdir -p "$EXP_RUNS_DIR/2099-01-01T00-00-00"
# 一時フォルダが消えたら (試験の片付け) 自分で終わる。最長 60 秒
for _ in $(seq 1 300); do [ -d "${st}" ] || exit 0; sleep 0.2; done
`, 0o755);
  const env = {
    ...process.env, MC_DIR: mc, EXP_PGREP: path.join(m, 'bin', 'pgrep'), EXP_SEND_CMD: path.join(m, 'bin', 'send'),
    EXP_FIRST_SETTING: path.join(m, 'bin', 'first_setting'), EXP_NODE: path.join(m, 'bin', 'node'),
    EXP_RUNS_DIR: path.join(m, 'runs'), EXP_LOG_DIR: m, EXP_START_TIMEOUT: '10', EXP_LAUNCH_WAIT: '8',
  };
  const read = (f) => { try { return fs.readFileSync(path.join(m, f), 'utf8'); } catch (_) { return ''; } };
  const cleanup = () => {
    try { process.kill(Number(fs.readFileSync(path.join(st, 'bot_pid'), 'utf8')), 'SIGKILL'); } catch (_) { /* なし */ }
    fs.rmSync(m, { recursive: true, force: true });
  };
  return { m, mc, st, env, read, cleanup };
}

const sh = (script, args, env) => {
  const r = spawnSync('bash', [script, ...args], { env, encoding: 'utf8', input: '', timeout: 60000 });
  return { code: r.status, out: r.stdout + r.stderr };
};

test('exp_start/exp_stop: bash -n が通り、--help が出る', () => {
  for (const s of [START, STOP]) {
    assert.strictEqual(spawnSync('bash', ['-n', s]).status, 0, s);
    const r = sh(s, ['--help'], process.env);
    assert.strictEqual(r.code, 0);
    assert.match(r.out, /使い方/);
  }
});

test('exp_start --dry-run: 新しいワールド (次の空き番号)・サーバーを止めて作り直す。何も変えない', () => {
  const e = mockEnv({ server: true });
  try {
    const r = sh(START, ['--dry-run'], e.env);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /ワールド world_survival3d_20 \(新しく作る/);
    assert.match(r.out, /推定の費用 約 \$8\.0/);
    const order = ['stop.sh', 'cp -a', 'prepare_survival', 'start.sh', 'Done', 'init_survival', 'morning', 'setsid -f'];
    let at = -1;
    for (const k of order) { const i = r.out.indexOf(k, at + 1); assert.ok(i > at, `${k} が順に出る\n${r.out}`); at = i; }
    assert.match(r.out, /--agents 100 --procs 10 --minutes 30 --stagger-ms 1500 --seed 20261111 --llm-provider luna --max-llm-usd 80 --max-jev-tokens 1000000000 --provenance on --ownership-penalty on --grudge on --conflict on --aggression on/);
    assert.ok(!fs.existsSync(path.join(e.mc, 'world_survival3d_20')), 'ワールドは作らない');
    assert.strictEqual(e.read('calls.log'), '', 'start/stop/first_setting を呼ばない');
    assert.strictEqual(e.read('sent.log'), 'list\n', '送るのは接続者の確認の list だけ');
  } finally { e.cleanup(); }
});

test('exp_start --dry-run: 引数が run.js に渡り、費用は人数と分に比例', () => {
  const e = mockEnv({ server: false });
  try {
    const r = sh(START, ['--dry-run', '--agents', '20', '--procs', '2', '--minutes', '15', '--grudge', 'off', '--aggression', 'off', '--world', 'world_x'], e.env);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /約 \$0\.8/);
    assert.match(r.out, /--agents 20 --procs 2 --minutes 15 /);
    assert.match(r.out, /--grudge off --conflict on --aggression off/);
    assert.match(r.out, /cp -a .*world_survival3d_15_pristine .*world_x/);
    assert.ok(!/stop\.sh/.test(r.out.split('ワールドとサーバーの準備')[1]), '止まっているサーバーは止めない');
    assert.strictEqual(e.read('sent.log'), '', '止まっているサーバーには送らない');
  } finally { e.cleanup(); }
});

test('exp_start --dry-run --reuse: 起動中のワールドと同じならサーバーを止めず morning だけ', () => {
  const e = mockEnv({ server: true, level: 'world_survival3d_19' });
  try {
    const r = sh(START, ['--dry-run', '--reuse', 'world_survival3d_19'], e.env);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /サーバーは止めない/);
    const prep = r.out.split('ワールドとサーバーの準備')[1];
    for (const k of ['stop.sh', 'cp -a', 'prepare_survival', 'start.sh', 'init_survival']) assert.ok(!prep.includes(k), `${k} は出ない`);
    assert.match(prep, /morning/);
  } finally { e.cleanup(); }
});

test('exp_start --dry-run --reuse: 別のワールドならコピーせずに切り替えて起動', () => {
  const e = mockEnv({ server: true, level: 'world_survival3d_19' });
  try {
    const r = sh(START, ['--dry-run', '--reuse', 'world_survival3d_15'], e.env);
    assert.strictEqual(r.code, 0, r.out);
    const prep = r.out.split('ワールドとサーバーの準備')[1];
    assert.ok(!prep.includes('cp -a'));
    for (const k of ['stop.sh', 'SURVIVAL_LEVEL=world_survival3d_15', 'prepare_survival', 'start.sh', 'init_survival', 'morning']) assert.ok(prep.includes(k), `${k} が出る`);
    assert.strictEqual(sh(START, ['--dry-run', '--reuse', 'world_nai'], e.env).code, 1);
  } finally { e.cleanup(); }
});

test('exp_start: 接続者がいれば名前を出して中止、--force で続ける', () => {
  const e = mockEnv({ server: true, players: ['YacobiHime', 'Guest'] });
  try {
    const r = sh(START, ['--dry-run'], e.env);
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /接続者が 2 人いる: YacobiHime, Guest/);
    const f = sh(START, ['--dry-run', '--force'], e.env);
    assert.strictEqual(f.code, 0, f.out);
    assert.match(f.out, /--force なので続ける/);
  } finally { e.cleanup(); }
});

test('exp_start: ボットが動いている・pristine が無い・ワールドがもうある・確認ができない ときは中止', () => {
  const a = mockEnv({ bot: true });
  try {
    const r = sh(START, ['--dry-run'], a.env);
    assert.strictEqual(r.code, 1); assert.match(r.out, /ボット \(node run\.js\) がもう動いている/);
  } finally { a.cleanup(); }
  const b = mockEnv({ pristine: false });
  try {
    const r = sh(START, ['--dry-run'], b.env);
    assert.strictEqual(r.code, 1); assert.match(r.out, /コピー元 \(pristine\) が無い/);
  } finally { b.cleanup(); }
  const c = mockEnv({});
  try {
    const r = sh(START, ['--dry-run', '--world', 'world_survival3d_19'], c.env);
    assert.strictEqual(r.code, 1); assert.match(r.out, /ワールドがもうある/);
    const n = sh(START, [], c.env); // 端末でなく --yes も無い
    assert.strictEqual(n.code, 1); assert.match(n.out, /--yes を付けて/);
    assert.strictEqual(c.read('calls.log'), '');
    const bad = sh(START, ['--dry-run', '--grudge', 'maybe'], c.env);
    assert.strictEqual(bad.code, 1); assert.match(bad.out, /--grudge は on か off/);
  } finally { c.cleanup(); }
});

test('exp_start --yes (すべて模擬): 準備→起動→記録のフォルダに exp_start.json', () => {
  const e = mockEnv({ server: true });
  try {
    const r = sh(START, ['--yes', '--agents', '10', '--procs', '1', '--minutes', '5', '--conflict', 'off'], e.env);
    assert.strictEqual(r.code, 0, r.out);
    assert.ok(fs.existsSync(path.join(e.mc, 'world_survival3d_20', 'level.dat')), 'pristine からコピーした');
    assert.strictEqual(fs.readFileSync(path.join(e.mc, 'world_survival3d_15_pristine', 'level.dat'), 'utf8'), 'pristine');
    const calls = e.read('calls.log').trim().split('\n');
    assert.deepStrictEqual(calls.map((l) => l.split(' MC_DIR')[0]), ['stop', 'first_setting prepare_survival SURVIVAL_LEVEL=world_survival3d_20', 'start',
      'first_setting init_survival SURVIVAL_LEVEL=', 'first_setting morning SURVIVAL_LEVEL=']);
    const dir = path.join(e.m, 'runs', '2099-01-01T00-00-00');
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'exp_start.json'), 'utf8'));
    assert.strictEqual(j.args.agents, 10);
    assert.strictEqual(j.args.conflict, 'off');
    assert.strictEqual(j.world.name, 'world_survival3d_20');
    assert.strictEqual(j.world.mode, 'new');
    assert.ok(j.command.includes('run.js'));
    assert.match(r.out, /記録のフォルダ +.*2099-01-01T00-00-00/);
    assert.match(r.out, /100\.88\.86\.71:25565/);
    assert.match(r.out, /exp_stop\.sh --run/);
    assert.match(fs.readFileSync(j.log, 'utf8'), /mock run\.js run\.js --config configs\/survival_100\.json --agents 10/);
  } finally { e.cleanup(); }
});

function fakeRun(dir) {
  w(path.join(dir, 'run.json'), JSON.stringify({ runId: 'x', agents: 2, minutes: 6.5, results: [{ name: 'A' }, { name: 'B' }], disconnects: 0,
    usage: { jev: { costUsd: 0.25, errors: 0 }, twoB: { calls: 0 }, llm: { costUsd: 0.5 } } }));
  w(path.join(dir, 'exp_start.json'), JSON.stringify({ args: { agents: 2, provenance: 'on', ownershipPenalty: 'on', grudge: 'on', conflict: 'on', aggression: 'off' }, world: { name: 'world_t' } }));
  const t = '2026-11-13T00:00:00.000Z';
  w(path.join(dir, 'A-x.jsonl'), [{ ts: t, event: 'start', name: 'A' }, { ts: t, event: 'grudge', kind: 'took', who: 'B', add: 1 }, { ts: t, event: 'hit', hits: 2 }, { ts: t, event: 'kill' }].map((r) => JSON.stringify(r)).join('\n') + '\n');
  w(path.join(dir, 'B-x.jsonl'), `${JSON.stringify({ ts: t, event: 'start', name: 'B' })}\n`);
}

test('exp_stop: ボットが止まっていれば集計だけ。失敗した集計を最後に出し、要点に費用・わだかまり', () => {
  const e = mockEnv({});
  try {
    const dir = path.join(e.m, 'runs', '2026-11-13T00-00-00');
    fakeRun(dir);
    const r = sh(STOP, [], e.env);
    assert.match(r.out, /ボットはもう止まっている/);
    assert.match(r.out, /== 集計 \(人数 2\) ==/);
    for (const f of ['check.txt', 'summary.txt', 'conflict.json', 'digest.txt']) assert.ok(fs.existsSync(path.join(dir, f)), f);
    const d = fs.readFileSync(path.join(dir, 'digest.txt'), 'utf8');
    assert.match(d, /費用 +\$0\.75 \(Jev \$0\.25・LLM \$0\.50\)/);
    assert.match(d, /わだかまり +1 回/);
    assert.match(d, /殺した 1/);
    assert.match(d, /aggression=off/);
    // 模擬の記録は monitor が無いので check_scale_run は FAIL になり、それが最後に出る
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /失敗したもの:\n {2}- check_scale_run/);
    assert.strictEqual(e.read('calls.log'), '', '--stop-server なしならサーバーに触らない');
  } finally { e.cleanup(); }
});

test('exp_stop: 動いているボットに SIGINT を送って待つ。--stop-server は接続者がいれば止めない', () => {
  const e = mockEnv({ server: true, players: ['Guest'] });
  try {
    fakeRun(path.join(e.m, 'runs', '2026-11-13T00-00-00'));
    // SIGINT で終わる模擬のボット
    // setsid -f で切り離す (この試験のプロセスの子のままだと、終わってもゾンビとして残り kill -0 が通ってしまう)
    const body = `trap 'echo got-int > "${e.st}/int"; exit 0' INT; echo $$ > "${e.st}/bot_pid"; while true; do sleep 0.1; done`;
    spawnSync('setsid', ['-f', 'bash', '-c', body], { stdio: 'ignore' });
    const t0 = Date.now();
    while (!fs.existsSync(path.join(e.st, 'bot_pid')) && Date.now() - t0 < 5000) spawnSync('sleep', ['0.1']);
    const r = sh(STOP, ['--stop-server', '--timeout', '10'], e.env);
    assert.match(r.out, /SIGINT\) を送る: PID/);
    assert.match(r.out, /ボットは止まった/);
    assert.strictEqual(fs.readFileSync(path.join(e.st, 'int'), 'utf8').trim(), 'got-int');
    assert.match(r.out, /接続者が 1 人いる \(Guest\) ので、サーバーは止めていない/);
    assert.ok(!e.read('calls.log').includes('stop'));
    // 接続者なしなら止める
    fs.writeFileSync(path.join(e.st, 'players'), '');
    const s = sh(STOP, ['--stop-server', '--timeout', '1'], e.env);
    assert.match(s.out, /停止完了/);
    assert.ok(e.read('calls.log').includes('stop'));
  } finally { e.cleanup(); }
});

test('exp_digest: summary.txt の先頭の JSON だけ読み、成功率・他人の物の取得を出す', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-digest-'));
  try {
    const sum = { decisions: { count: 10 }, perAgent: [{ success: 6, failure: 2 }, { success: 1, failure: 1 }], survival: { deaths: 3 },
      provenance: { placedTakes: 5, ownTakes: 1, byReason: { mistaken_as_natural: 4 } } };
    w(path.join(dir, 'summary.txt'), `${JSON.stringify(sum, null, 2)}\n\n--- 週次報告用 ---\n人数 2 / {x}\n}\n`);
    w(path.join(dir, 'check.txt'), 'PASS x\n  OK agents\n');
    assert.deepStrictEqual(summaryJson(path.join(dir, 'summary.txt')).decisions, { count: 10 });
    const d = digest(dir);
    assert.strictEqual(d.verdict, 'PASS');
    assert.strictEqual(d.success.ok, 7); assert.strictEqual(d.success.total, 10);
    assert.strictEqual(d.takes.others, 4);
    const text = lines(d).join('\n');
    assert.match(text, /成功率 70\.0% \(7\/10\)・死亡 3 回/);
    assert.match(text, /他人の物の取得 4 件/);
    assert.match(text, /費用 +記録なし/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('exp_stop: 自然に終わりかけていれば SIGINT を送らず待つ。run.json が無ければ run-part から作る', () => {
  const e = mockEnv({});
  try {
    const dir = path.join(e.m, 'runs', '2026-11-13T00-00-00');
    const old = new Date(Date.now() - 10 * 60000).toISOString();
    w(path.join(dir, 'exp_start.json'), JSON.stringify({ args: { agents: 2, procs: 2, minutes: 1 } }));
    w(path.join(dir, 'run-part1.json'), JSON.stringify({ runId: '2026-11-13T00-00-00', agents: 2, proc: 1, connected: 1, minutes: 1, results: [{ name: 'A' }], disconnects: { n: 0 }, usage: { jev: { calls: 1 } } }));
    w(path.join(dir, 'A-2026-11-13T00-00-00.jsonl'), `${JSON.stringify({ ts: old, event: 'start' })}\n`);
    w(path.join(dir, 'B-2026-11-13T00-00-00.jsonl'), `${JSON.stringify({ ts: old, event: 'start' })}\n${JSON.stringify({ ts: old, loop: 3 })}\n`);
    // 2 秒で自分で終わる模擬のボット (SIGINT を受けたら印を残す)
    const body = `trap 'echo got-int > "${e.st}/int"; exit 0' INT; echo $$ > "${e.st}/bot_pid"; for i in $(seq 1 20); do sleep 0.1; done`;
    spawnSync('setsid', ['-f', 'bash', '-c', body], { stdio: 'ignore' });
    const t0 = Date.now();
    while (!fs.existsSync(path.join(e.st, 'bot_pid')) && Date.now() - t0 < 5000) spawnSync('sleep', ['0.1']);
    const r = sh(STOP, ['--timeout', '20'], e.env);
    assert.match(r.out, /自然に終わりかけている \(子が終わり始めている/);
    assert.match(r.out, /ボットは自分で終わった/);
    assert.ok(!fs.existsSync(path.join(e.st, 'int')), 'SIGINT は送らない');
    assert.match(r.out, /run\.json が無い .*作り直す/);
    const run = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));
    assert.strictEqual(run.partial, true);
    assert.deepStrictEqual(run.missingParts.map((m) => m.proc), [2]);
    assert.deepStrictEqual(run.results.map((x) => x.name).sort(), ['A', 'B']);
    assert.match(fs.readFileSync(path.join(dir, 'check.txt'), 'utf8'), /NG run parts: 欠けた子 2/);
  } finally { e.cleanup(); }
});

test('exp_stop --now: 終わりかけでも SIGINT を送る', () => {
  const e = mockEnv({});
  try {
    const dir = path.join(e.m, 'runs', '2026-11-13T00-00-00');
    fakeRun(dir);
    w(path.join(dir, 'run-part1.json'), '{}');
    const body = `trap 'echo got-int > "${e.st}/int"; exit 0' INT; echo $$ > "${e.st}/bot_pid"; while true; do sleep 0.1; done`;
    spawnSync('setsid', ['-f', 'bash', '-c', body], { stdio: 'ignore' });
    const t0 = Date.now();
    while (!fs.existsSync(path.join(e.st, 'bot_pid')) && Date.now() - t0 < 5000) spawnSync('sleep', ['0.1']);
    const r = sh(STOP, ['--now', '--timeout', '10'], e.env);
    assert.match(r.out, /SIGINT\) を送る: PID/);
    assert.strictEqual(fs.readFileSync(path.join(e.st, 'int'), 'utf8').trim(), 'got-int');
  } finally { e.cleanup(); }
});
