'use strict';
// 2人のエージェントを模擬の bot (チャットだけ) でつなぎ、聞く → 答える → 記憶に入る → 記録に残る、を通して確かめる
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Agent } = require('../src/agent');
const { loadConfig } = require('../src/config');
const { Talker } = require('../src/talker');
const { UsageMeter } = require('../src/usage');

const CFG = path.join(__dirname, '..', 'configs', 'first_setting.json');

function makeAgent(name, dir, deps = {}) {
  const cfg = loadConfig(CFG, { persona: { name }, memory: { file: null }, ask: { waitMs: 2000 } });
  cfg.memory.file = null;
  const a = new Agent(cfg, { decider: { kind: 'none' }, recordDir: dir, log: () => {}, ...deps });
  a.bot = { username: name, entity: { position: { x: 0, y: 64, z: 0 } }, players: {}, time: { timeOfDay: 3000, day: 0 }, said: [] };
  return a;
}

// a が話すと、聞こえる範囲の b に届く
function link(a, b, d = 5) {
  a.bot.players[b.bot.username] = { entity: { position: { x: d, y: 64, z: 0 } } };
  b.bot.players[a.bot.username] = { entity: { position: { x: d, y: 64, z: 0 } } };
  a.bot.chat = (t) => { a.bot.said.push(t); setImmediate(() => b.onChat(a.bot.username, t)); };
  b.bot.chat = (t) => { b.bot.said.push(t); setImmediate(() => a.onChat(b.bot.username, t)); };
}

function fakeTalker(meter, reply) {
  const seen = [];
  const llm = { model: 'fake-2b', complete: async (messages) => { seen.push(messages); return { text: JSON.stringify({ say: reply }), promptTokens: 120, completionTokens: 10 }; } };
  return { talker: new Talker({ llm, meter }), seen };
}

const rows = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('聞く → 記憶の範囲で答える (2B) → 誰から・いつ付きで記憶に入る → 両方の記録に残る', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-'));
  const meter = new UsageMeter();
  const { talker, seen } = fakeTalker(meter, 'stickを2本作ってから作業台の近くで作るといいよ');
  const taro = makeAgent('Taro', dir, { talker, meter });
  const hanako = makeAgent('Hanako', dir, { talker, meter });
  link(taro, hanako);
  hanako.memory.noteEvent('craft', 'wooden_pickaxe', true, 'wooden_pickaxeを1個作った');
  taro.memory.tick = 7;
  const r = await taro.doAsk({ player: 'Hanako', trouble: { key: 'craft:wooden_pickaxe', about: 'wooden_pickaxeの作り方', lastMsg: '材料が足りない' } });
  assert.ok(r.ok, r.msg);
  assert.match(taro.bot.said[0], /^Hanakoさん、教えて: wooden_pickaxeの作り方が分からない/);
  assert.match(hanako.bot.said[0], /^Taroさん、答え: stickを2本作って/);
  const k = taro.memory.knowledge[0];
  assert.strictEqual(k.from, 'Hanako');
  assert.strictEqual(k.about, 'craft:wooden_pickaxe');
  assert.strictEqual(k.t, 7);
  assert.strictEqual(k.at, '昼');
  assert.match(seen[0][1].content, /wooden_pickaxeを1個作った/, '答える 2B には自分の記憶だけを渡す');
  assert.strictEqual(meter.summary().twoB.byKind.answer.calls, 1);
  assert.ok(taro.social.rel('Hanako').affinity > 50);
  assert.strictEqual(taro.pendingUse.length, 1);
  await taro.recorder.close();
  await hanako.recorder.close();
  const tr = rows(taro.recorder.file);
  assert.ok(tr.some((x) => x.event === 'ask' && x.to === 'Hanako' && x.key === 'craft:wooden_pickaxe'));
  assert.ok(tr.some((x) => x.event === 'ask_reply' && x.known === true));
  const hr = rows(hanako.recorder.file);
  const ans = hr.find((x) => x.event === 'answer');
  assert.strictEqual(ans.to, 'Taro');
  assert.strictEqual(ans.known, true);
  assert.strictEqual(ans.memories.length, 1);
});

test('記憶にも知っていることにも手がかりがなければ 2B を呼ばずに「分からない」と答え、遠すぎれば届かず返事なし', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-'));
  const meter = new UsageMeter();
  const { talker } = fakeTalker(meter, 'x');
  const taro = makeAgent('Taro', dir, { talker, meter });
  const ken = makeAgent('Ken', dir, { talker, meter });
  link(taro, ken);
  // furnace は知っていること (goal.hints) にも記憶にもない
  const r = await taro.doAsk({ player: 'Ken', trouble: { key: 'craft:furnace', about: 'furnaceの作り方', lastMsg: '' } });
  assert.ok(r.ok);
  assert.match(ken.bot.said[0], /分からない/);
  assert.strictEqual(meter.summary().twoB.calls, 0);
  assert.strictEqual(taro.pendingUse.length, 0, '「分からない」は使う見張りに入れない');
  // 遠い (hearRadius 24 より先)
  const far = makeAgent('Yuki', dir, { talker, meter });
  link(taro, far, 60);
  const r2 = await taro.doAsk({ player: 'Yuki', trouble: { key: 'hunt:cow', about: 'cowのつかまえ方', lastMsg: '' } });
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(far.bot.said.length, 0);
  assert.ok(taro.social.rel('Yuki').ignoredMe === 1);
});
