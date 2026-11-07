'use strict';
// 動けない状態 (unstuck.js): returningPos の扱い・進み具合での打ち切り・見張り・回復・入り直し・竹
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const { Vec3 } = require('vec3');
const { goals, Movements } = require('mineflayer-pathfinder');
const unstuck = require('../src/unstuck');
const { handlers } = require('../src/act');
const en = require('../src/en');
const { buildState, buildStateEn } = require('../src/deciders/jev');
const ask = require('../src/ask');
const { Agent } = require('../src/agent');
const { loadConfig } = require('../src/config');
const { Board } = require('../src/board');

const CFG = path.join(__dirname, '..', 'configs', 'survival_3days.json');
const FAST = { noProgressMs: 300, sampleMs: 30, workGraceMs: 300 };

// 模擬の bot: goto は終わらない (setGoal(null) で GoalChanged)。move(bot) を毎サンプル呼べば動く
function fakeBot({ pos = new Vec3(0.5, 64, 0.5), blocks = new Map(), mining = () => false } = {}) {
  const bot = new EventEmitter();
  bot.entity = { position: pos, onGround: true };
  bot.controls = {};
  bot.dug = [];
  let rejectGoto = null;
  bot.pathfinder = {
    goals: [],
    LOSWhenPlacingBlocks: true,
    ret: null,
    goto: () => new Promise((_, rej) => { rejectGoto = rej; }),
    setGoal: (g) => { bot.pathfinder.goals.push(g); if (g === null && rejectGoto) { const e = new Error('The goal was changed before it could be completed!'); e.name = 'GoalChanged'; rejectGoto(e); rejectGoto = null; } },
    isMining: mining, isBuilding: () => false, isMoving: () => true,
    getReturningPos: () => bot.pathfinder.ret,
    clearReturningPos: () => { const had = bot.pathfinder.ret !== null; bot.pathfinder.ret = null; return had; },
  };
  bot.clearControlStates = () => { bot.controls = {}; };
  bot.setControlState = (k, v) => { bot.controls[k] = v; if (bot.onControl) bot.onControl(k, v); };
  bot.blockAt = (p) => { const n = blocks.get(`${p.x},${p.y},${p.z}`); return n ? { name: n, position: new Vec3(p.x, p.y, p.z), boundingBox: 'block', digTime: () => 500 } : null; };
  bot.canDigBlock = () => true;
  bot.dig = async (b) => { bot.dug.push(b.name); blocks.delete(`${b.position.x},${b.position.y},${b.position.z}`); };
  bot.__unstuckCfg = { ...unstuck.UNSTUCK_DEFAULTS, ...FAST, backMs: 20, walkMs: 20 };
  return bot;
}

test('pathfinder の patch: resetPath・stop で returningPos を消し、getReturningPos / clearReturningPos がある (patch-package)', () => {
  const src = fs.readFileSync(require.resolve('mineflayer-pathfinder/index.js'), 'utf8');
  assert.match(src, /bot\.pathfinder\.clearReturningPos = /);
  assert.match(src, /bot\.pathfinder\.getReturningPos = /);
  assert.ok((src.match(/returningPos = null/g) || []).length >= 3, 'resetPath・stop・着いたとき');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'patches', 'mineflayer-pathfinder+2.4.5.patch')));
  assert.strictEqual(require('../package.json').scripts.postinstall, 'patch-package');
});

test('setupPathfinder: LOSWhenPlacingBlocks を切る・竹は乗れず通れない (通るなら壊す)・死亡/リスポーンで returningPos を消す・押し戻しと path_reset を数える', () => {
  const registry = require('minecraft-data')('1.20.1');
  const bot = fakeBot();
  bot.registry = registry;
  bot.version = '1.20.1';
  const mv = new Movements(bot);
  assert.ok(!mv.fences.has(registry.blocksByName.bamboo.id), 'pathfinder の既定では竹は満ブロック (上に立てると思う)');
  unstuck.setupPathfinder(bot, mv);
  assert.strictEqual(bot.pathfinder.LOSWhenPlacingBlocks, false);
  assert.ok(mv.fences.has(registry.blocksByName.bamboo.id));
  // 竹: physical でも safe でもない → 足場にしない・通るなら掘る
  const b = { type: registry.blocksByName.bamboo.id, boundingBox: 'block', shapes: [[0.15, 0, 0.15, 0.34, 1, 0.34]] };
  bot.blockAt = () => b;
  const gb = mv.getBlock(new Vec3(0, 64, 0), 0, 0, 0);
  assert.strictEqual(gb.physical, false);
  assert.strictEqual(gb.safe, false);
  bot.pathfinder.ret = new Vec3(1, 64, 1);
  bot.emit('death');
  assert.strictEqual(bot.pathfinder.ret, null);
  bot.pathfinder.ret = new Vec3(1, 64, 1);
  bot.emit('respawn');
  assert.strictEqual(bot.pathfinder.ret, null);
  unstuck.beginAction(bot);
  bot.emit('forcedMove'); bot.emit('forcedMove');
  bot.emit('path_reset', 'stuck'); bot.emit('path_reset', 'block_updated'); bot.emit('path_reset', 'stuck');
  bot.pathfinder.ret = new Vec3(2, 64, 2);
  const mvRec = unstuck.endAction(bot);
  assert.strictEqual(mvRec.forced, 2);
  assert.deepStrictEqual(mvRec.resets, { stuck: 2, block_updated: 1 });
  assert.strictEqual(mvRec.returningCleared, 1, '行動の終わりにも消す');
  assert.strictEqual(bot.pathfinder.ret, null);
});

test('clearReturning: patch が無い pathfinder なら LOSWhenPlacingBlocks を切る (returningPos が使われない)', () => {
  const bot = { pathfinder: { LOSWhenPlacingBlocks: true } };
  assert.strictEqual(unstuck.clearReturning(bot), false);
  assert.strictEqual(bot.pathfinder.LOSWhenPlacingBlocks, false);
});

test('gotoProgress: 目標に 1m も近づかないまま noProgressMs たつとやめる (setGoal(null))。結果の文は「動けなかった」(英語も)', async () => {
  const bot = fakeBot();
  unstuck.beginAction(bot);
  const t0 = Date.now();
  await assert.rejects(unstuck.gotoProgress(bot, new goals.GoalNear(20, 64, 0, 2)), (e) => e.name === 'NoProgress');
  assert.ok(Date.now() - t0 < 1500);
  assert.ok(bot.pathfinder.goals.includes(null));
  const r = await handlers.go_to(bot, { pos: { x: 20, y: 64, z: 0 }, kind: 'oak_log' }, {});
  assert.strictEqual(r.ok, false);
  assert.match(r.msg, /oak_logへ行けなかった: 動けなかった/);
  assert.match(en.resultEn({ action: 'go_to', arg: 'oak_log', ok: false, msg: r.msg }), /could not reach oak_log: could not move/);
  const ex = await handlers.explore(bot, { dir: 'north', label: 'north' }, { exploreDistance: 20 });
  assert.match(ex.msg, /northへ進めなかった: 動けなかった/);
  assert.match(en.msgEn(ex.msg).text, /could not walk .*north.*could not move/);
  const st = unstuck.endAction(bot);
  assert.strictEqual(st.gotos, 3);
  assert.strictEqual(st.noProgress, 3);
  assert.strictEqual(st.moved, 0);
  assert.ok(st.samples === undefined && st.moving === 1, JSON.stringify(st));
});

test('gotoProgress: 近づいている間・掘っている間 (workGraceMs まで) は続ける', async () => {
  const bot = fakeBot();
  let done = null;
  bot.pathfinder.goto = () => new Promise((res) => { done = res; });
  const iv = setInterval(() => { bot.entity.position = bot.entity.position.offset(0.6, 0, 0); if (bot.entity.position.x > 10) done(); }, 30);
  await unstuck.gotoProgress(bot, new goals.GoalNear(20, 64, 0, 2));
  clearInterval(iv);
  // 掘っている: 動かなくても grace の分は待つ
  let mining = true;
  const bot2 = fakeBot({ mining: () => mining });
  bot2.__unstuckCfg = { ...bot2.__unstuckCfg, noProgressMs: 200, workGraceMs: 400 };
  const t0 = Date.now();
  await assert.rejects(unstuck.gotoProgress(bot2, new goals.GoalNear(20, 64, 0, 2)), (e) => e.name === 'NoProgress');
  const took = Date.now() - t0;
  assert.ok(took >= 550, `grace が効く (${took}ms)`);
  mining = false;
});

test('StuckWatch: 移動系 (goto を使った) 行動が続けて2回、失敗か打ち切りで1m未満 → 動けない。移動しない行動は数えない。動けば数え直す。困りごとは troubleLoops ループ', () => {
  const w = new unstuck.StuckWatch({ stuckRepeat: 2, troubleLoops: 3 });
  assert.strictEqual(w.note({ action: 'explore', ok: false, move: { gotos: 1, moved: 0.2 } }), false);
  assert.strictEqual(w.note({ action: 'look_around', ok: true, move: null }), false);
  assert.strictEqual(w.note({ action: 'go_to', ok: false, move: { gotos: 1, moved: 0.1, noProgress: 1 } }), true);
  w.noteRecovery(10, { ok: true, how: '後ろへ下がって跳んだら動けた' });
  assert.strictEqual(w.run, 0);
  const t = w.trouble(11);
  assert.deepStrictEqual([t.key, t.kind, t.about], ['stuck:', 'stuck', 'その場から動けない']);
  assert.match(t.lastMsg, /回復: 後ろへ下がって/);
  assert.strictEqual(w.trouble(14), null);
  // 届かない物を掘れなかっただけ (collect の失敗、打ち切りなし)・すぐ近くの物を集めた (成功) は数えない
  assert.strictEqual(w.note({ action: 'collect', ok: false, move: { gotos: 1, moved: 0 } }), false);
  assert.strictEqual(w.note({ action: 'collect', ok: false, move: { gotos: 1, moved: 0 } }), false);
  assert.strictEqual(w.note({ action: 'collect', ok: true, move: { gotos: 1, moved: 0.3 } }), false);
  assert.strictEqual(w.run, 0);
  // collect でも移動が打ち切られたら数える
  w.note({ action: 'collect', ok: false, move: { gotos: 1, moved: 0, noProgress: 1 } });
  assert.strictEqual(w.run, 1);
  w.run = 0;
  w.note({ action: 'explore', ok: false, move: { gotos: 1, moved: 0 } });
  w.note({ action: 'explore', ok: true, move: { gotos: 1, moved: 12 } });
  assert.strictEqual(w.run, 0);
});

test('困りごと「その場から動けない」が Jev の state (日本語・英語) と聞く文に出る', () => {
  const t = new unstuck.StuckWatch().trouble(-1) || { key: 'stuck:', kind: 'stuck', about: 'その場から動けない', lastMsg: '移動が続けて1m未満だった (回復できなかった)' };
  const ctx = { troubles: [t], en: {}, actions: [], raw: { self: {} } };
  let ja = null; let enS = null;
  try { ja = buildState(ctx); } catch (_) { /* 材料が足りなければ下で文を直接見る */ }
  try { enS = buildStateEn(ctx); } catch (_) { /* 同上 */ }
  if (ja) assert.match(JSON.stringify(ja), /その場から動けない/);
  if (enS) assert.match(JSON.stringify(enS), /stuck: could not move from this spot/);
  assert.ok(ja || enS, 'state を作れた');
  assert.match(ask.questionText('Hanako', t), /Hanakoさん、教えて: その場から動く方法が分からない/);
});

test('recover: 下がって跳んでも動けない → すぐ横の竹 (足元の竹も) を掘って歩くと動けた', async () => {
  const blocks = new Map([['1,64,0', 'bamboo'], ['1,65,0', 'bamboo'], ['0,63,0', 'bamboo'], ['-1,64,0', 'stone'], ['0,64,1', 'oak_planks'], ['0,64,-1', 'oak_log']]);
  const bot = fakeBot({ blocks });
  bot.pathfinder.ret = new Vec3(5, 70, 5);
  bot.onControl = (k, v) => { if (k === 'forward' && v && bot.dug.length) bot.entity.position = bot.entity.position.offset(1.5, 0, 0); };
  const r = await unstuck.recover(bot);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.returning, true);
  assert.strictEqual(bot.pathfinder.ret, null);
  assert.ok(bot.dug.includes('bamboo'));
  assert.strictEqual(bot.dug[0], 'bamboo', '柔らかい物 (竹) から');
  assert.match(r.how, /bamboo/);
  assert.ok(!bot.dug.includes('oak_planks') && !bot.dug.includes('oak_log'), '板材・原木 (小屋の壁かもしれない) は掘らない');
  assert.ok(r.steps.includes('halt') && r.steps.includes('returning_cleared'));
  // 何をしても動けない
  const bot2 = fakeBot();
  const r2 = await unstuck.recover(bot2);
  assert.strictEqual(r2.ok, false);
});

// ---- agent: 回復できないと同じ名前で入り直す。記憶・欲求・ゴール・Board・拠点は引き継ぐ ----
function makeAgent(dir) {
  const cfg = loadConfig(CFG, { memory: { file: null } });
  cfg.persona = cfg.personas.find((p) => p.name === 'Taro');
  cfg.memory.file = null;
  cfg.board = { ...(cfg.board || {}), enabled: true };
  cfg.unstuck = { ...FAST, backMs: 20, walkMs: 20, reconnectWaitMs: 10, reconnectTimeoutMs: 2000 };
  return new Agent(cfg, { decider: { kind: 'none' }, recordDir: dir, log: () => {} });
}

test('agent: 回復できなければ入り直す。Board・記憶・欲求・ゴール・拠点は同じもののまま。古い bot の end では止まらない。記録は event unstuck', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unstuck-'));
  const a = makeAgent(dir);
  assert.ok(a.board instanceof Board);
  const old = fakeBot();
  old.username = 'Taro';
  let quitWith = null;
  old.quit = (r) => { quitWith = r; old.emit('end', r); };
  old.on('end', () => { a.stopped = true; }); // connect() が付けるのと同じ
  a.bot = old;
  a.base = { x: 10, y: 64, z: 10 };
  a.memory.noteEvent('collect', 'oak_log', true, 'oak_logを3個掘った');
  a.board.receive('Hanako', { kind: 'say', text: '北に羊がいる' }, { t: Date.now(), tick: 1 });
  const keep = { board: a.board, memory: a.memory, social: a.social, goalPath: a.goalPath, reflect: a.reflect, recorder: a.recorder };
  const boardJson = JSON.stringify(a.board.toJSON ? a.board.toJSON() : [...(a.board.msgs || [])]);
  a.social.needsModel.v.hunger = 0.77;
  let calls = 0;
  a.connect = async ({ again }) => { calls += 1; assert.strictEqual(again, true); a.bot = fakeBot(); a.bot.username = 'Taro'; };
  const ev = await a.recoverStuck(7, 7, { action: 'explore', arg: 'north' }, { gotos: 1, moved: 0, noProgress: 1 });
  assert.strictEqual(quitWith, 'unstuck');
  assert.strictEqual(calls, 1);
  assert.notStrictEqual(a.bot, old);
  assert.strictEqual(a.stopped, false, '古い bot の end で止まらない');
  for (const [k, v] of Object.entries(keep)) assert.strictEqual(a[k], v, k);
  assert.strictEqual(JSON.stringify(a.board.toJSON ? a.board.toJSON() : [...(a.board.msgs || [])]), boardJson);
  assert.deepStrictEqual(a.base, { x: 10, y: 64, z: 10 });
  assert.strictEqual(a.social.needsModel.v.hunger, 0.77);
  assert.ok(a.memory.events.some((e) => e.action === 'collect'));
  assert.strictEqual(ev.ok, true);
  assert.strictEqual(ev.reconnect.ok, true);
  assert.match(ev.how, /入り直したら/);
  // 次のループで困りごとに出る
  assert.strictEqual(a.stuck.trouble(8).kind, 'stuck');
  await a.recorder.close();
  const rows = fs.readFileSync(a.recorder.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const u = rows.find((r) => r.event === 'unstuck');
  assert.ok(u && u.reconnect && u.steps.length >= 3, JSON.stringify(u));
});

test('agent: 入り直しに失敗したら止まる (stopped)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unstuck-'));
  const a = makeAgent(dir);
  const old = fakeBot();
  old.quit = () => {};
  a.bot = old;
  a.connect = async () => { throw new Error('refused'); };
  const r = await a.reconnect('unstuck');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(a.stopped, true);
  await a.recorder.close();
});
