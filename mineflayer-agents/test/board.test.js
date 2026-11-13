'use strict';
// 全体チャット・提案と取り決め・共有のチェスト・共同の目標 (src/board.js とそのつなぎ)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Board, parseLine, line } = require('../src/board');
const { Planner, pathText, pathEn } = require('../src/planner');
const states = require('../src/states');
const { listActions } = require('../src/actions');
const { buildStateEn, buildQuestionsEn, JevDecider, pathMatch } = require('../src/deciders/jev');
const { JevClient } = require('../src/jev_client');
const { parseProposal, proposeSchema, Talker } = require('../src/talker');
const { Agent } = require('../src/agent');
const { loadConfig } = require('../src/config');
const { mockRaw } = require('./fixtures');

const CFG = path.join(__dirname, '..', 'configs', 'survival_3days.json');

test('board: 行の作り方と読み方 (印のない行・壊れた行は null)', () => {
  assert.deepStrictEqual(parseLine(line.say('羊がいたよ')), { type: 'say', text: '羊がいたよ' });
  assert.deepStrictEqual(parseLine(line.propose({ id: 'Hanako#12', n: 20, spec: { type: 'rule', item: 'white_wool', chest: 'Hanako-1' }, text: '羊毛は共有のチェストに' })),
    { type: 'propose', id: 'Hanako#12', n: 20, spec: { type: 'rule', item: 'white_wool', chest: 'Hanako-1' }, text: '羊毛は共有のチェストに' });
  assert.deepStrictEqual(parseLine(line.propose({ id: 'Ken#3', n: 5, spec: { type: 'project', item: 'white_bed', count: 5 }, text: 'みんなでベッドを5つ' })).spec, { type: 'project', item: 'white_bed', count: 5 });
  assert.deepStrictEqual(parseLine(line.propose({ id: 'Ken#4', n: 5, spec: { type: 'text' }, text: '夜は拠点に集まろう' })).spec, { type: 'text' });
  assert.deepStrictEqual(parseLine(line.vote('Ken#3', true)), { type: 'vote', id: 'Ken#3', yes: true });
  assert.deepStrictEqual(parseLine(line.vote('Ken#3', false)), { type: 'vote', id: 'Ken#3', yes: false });
  assert.deepStrictEqual(parseLine(line.share('Hanako-1', { x: 12.7, y: 64, z: -30.2 })), { type: 'share', chest: 'Hanako-1', pos: { x: 12, y: 64, z: -31 } });
  assert.deepStrictEqual(parseLine(line.chest('Hanako-1', 'Taro', { item: 'white_wool', n: -2 }, [{ name: 'oak_planks', count: 10 }])),
    { type: 'chest', chest: 'Hanako-1', who: 'Taro', delta: { item: 'white_wool', n: -2 }, items: [{ name: 'oak_planks', count: 10 }] });
  assert.deepStrictEqual(parseLine(line.placed('white_bed', 1)), { type: 'placed', item: 'white_bed', n: 1 });
  assert.strictEqual(parseLine('こんにちは'), null, '近くの声 (印なし)');
  assert.strictEqual(parseLine('【提案 bad n=3】x'), null);
  assert.ok(line.say('a【b】c').indexOf('【b】') < 0, '中身の【】は消す (行の印と混ざらない)');
});

test('board: 賛成 (提案者を含む) が ratio × n を超えたら成立。期限切れ。1人1票', () => {
  const b = new Board({ cfg: { agreeRatio: 1 / 3, proposalTtlMs: 1000 }, me: 'Taro' });
  b.receive('Hanako', parseLine(line.propose({ id: 'Hanako#1', n: 6, spec: { type: 'text' }, text: '夜は集まろう' })), { t: 0 });
  const p = b.proposals.get('Hanako#1');
  assert.strictEqual(b.need(p), 3, '6人の 1/3 = 2 を超える → 3');
  assert.deepStrictEqual(b.openFor('Taro').map((x) => x.id), ['Hanako#1']);
  assert.deepStrictEqual(b.openFor('Hanako'), [], '自分の提案は聞かない');
  b.receive('Ken', parseLine(line.vote('Hanako#1', true)), { t: 1 });
  b.receive('Ken', parseLine(line.vote('Hanako#1', true)), { t: 2 });
  assert.strictEqual(p.yes.size, 2, '同じ人の2票は1票');
  b.receive('Jiro', parseLine(line.vote('Hanako#1', false)), { t: 3 });
  const ev = b.receive('Yuki', parseLine(line.vote('Hanako#1', true)), { t: 4 });
  assert.ok(ev.some((e) => e.type === 'agreed'));
  assert.strictEqual(p.status, 'agreed');
  b.receive('Ken', parseLine(line.propose({ id: 'Ken#2', n: 6, spec: { type: 'text' }, text: 'x' })), { t: 0 });
  assert.deepStrictEqual(b.expire(5000).map((x) => x.id), ['Ken#2']);
});

test('board: 全体チャットの優先は 自分の名前 > ゴール・道筋の物の名前 > 関係の強い人 (中身は評価しない)。古いものは出さない', () => {
  const b = new Board({ cfg: { maxBoard: 3, keepTicks: 5 }, me: 'Taro' });
  b.receive('Ken', parseLine(line.say('今日は晴れ')), { tick: 10 });
  b.receive('Mai', parseLine(line.say('羊毛を集めている')), { tick: 10 });
  b.receive('Jiro', parseLine(line.say('Taro、こっちに来て')), { tick: 10 });
  b.receive('Rin', parseLine(line.say('ずっと前の話')), { tick: 1 });
  b.receive('Sota', parseLine(line.say('石を掘った')), { tick: 10 });
  const s = b.select({ tick: 11, names: ['white_wool', '羊毛'], strength: (n) => (n === 'Sota' ? 0.8 : 0.1) });
  assert.deepStrictEqual(s.map((m) => `${m.from}:${m.why}`), ['Jiro:name', 'Mai:item', 'Sota:relation']);
  const st = b.stateEn({ tick: 11, shown: s }).state;
  assert.match(st.board[0], /^Jiro said to everyone「Taro、こっちに来て」 \(one turn ago\)$/);
});

test('board: 共有のチェストの中身・取り決めを破った (提案者だけが知る)・共同の目標の進み (チェスト + 置いた数)', () => {
  const mk = (me) => new Board({ cfg: { agreeRatio: 0.2 }, me });
  const boards = { Hanako: mk('Hanako'), Taro: mk('Taro') };
  const all = (from, msg) => Object.values(boards).flatMap((b) => b.receive(from, parseLine(msg), { tick: 3 }).map((e) => ({ ...e, at: b.me })));
  all('Hanako', line.share('Hanako-1', { x: 10, y: 64, z: 0 }));
  all('Hanako', line.chest('Hanako-1', 'Hanako', null, [{ name: 'white_wool', count: 2 }]));
  all('Hanako', line.propose({ id: 'Hanako#5', n: 4, spec: { type: 'rule', item: 'white_wool', chest: 'Hanako-1' }, text: '羊毛は Hanako-1 に入れよう' }));
  all('Ken', line.vote('Hanako#5', true));
  assert.strictEqual(boards.Taro.proposals.get('Hanako#5').status, 'agreed', '4人の 0.2 = 0.8 を超える → 2票で成立');
  const ev = all('Taro', line.chest('Hanako-1', 'Taro', { item: 'white_wool', n: -2 }, []));
  const br = ev.filter((e) => e.type === 'breach');
  assert.deepStrictEqual(br.map((e) => e.at), ['Hanako'], '提案者だけが「破られた」と知る');
  assert.strictEqual(boards.Taro.proposals.get('Hanako#5').broken, 2, '全員が同じ数を数える');
  const st = boards.Hanako.stateEn({ tick: 4, here: { x: 0, y: 64, z: 0 } });
  assert.match(st.state.broken_agreements[0], /^Taro took white_wool x2 out of Hanako's chest 1 \(shared\), against your agreement「羊毛は Hanako-1 に入れよう」$/);
  assert.deepStrictEqual(st.breakers, ['Taro']);
  assert.match(st.state.agreements[0], /^white_wool goes into Hanako's chest 1 \(shared\) 「羊毛は Hanako-1 に入れよう」 \(proposed by Hanako; a few agreed\)$/);
  assert.match(st.state.shared_chests[0], /^Hanako's chest 1 \(shared\) \(.*\): empty$/);
  // checkOwn: 取り決めのチェストに入れた = 守った、ほかの入れ物 = 破った、取り決めのチェストから出した = 破った
  assert.deepStrictEqual(boards.Taro.checkOwn('chest_put', 'white_wool', 'Hanako-1').map((x) => x.kept), [true]);
  assert.deepStrictEqual(boards.Taro.checkOwn('chest_put', 'white_wool', null).map((x) => x.how), ['put_other_container']);
  assert.deepStrictEqual(boards.Taro.checkOwn('chest_take', 'white_wool', 'Hanako-1').map((x) => x.kept), [false]);
  assert.deepStrictEqual(boards.Taro.checkOwn('chest_put', 'oak_log', 'Hanako-1'), []);
  // 共同の目標
  all('Ken', line.propose({ id: 'Ken#9', n: 4, spec: { type: 'project', item: 'white_bed', count: 3 }, text: 'みんなでベッドを3つ' }));
  all('Mai', line.vote('Ken#9', true));
  all('Taro', line.chest('Hanako-1', 'Taro', { item: 'white_bed', n: 1 }, [{ name: 'white_bed', count: 1 }]));
  all('Mai', line.placed('white_bed', 1));
  const pj = boards.Taro.proposals.get('Ken#9');
  assert.strictEqual(boards.Taro.progress(pj), 2);
  assert.match(boards.Taro.stateEn({ tick: 4 }).state.projects[0], /^white_bed x3 \(proposed by Ken; a few agreed\) — 2\/3$/);
  const done = all('Mai', line.placed('white_bed', 1));
  assert.ok(done.some((e) => e.type === 'project_done'));
  assert.match(boards.Taro.textJa({ tick: 4 }), /## 共同の目標\n- white_bed 3 \(Kenの提案\) — 今 3\/3・達成/);
});

test('planner: 共有のチェストも入手元にする (white_wool 3 ← チェストに 2、あと 1 は sheep から)', () => {
  const w = { inventory: [], visibleMobs: ['sheep'], sharedChests: [{ id: 'Hanako-1', items: [{ name: 'white_wool', count: 2 }] }] };
  const p = new Planner(w).plan('white_wool', 3);
  assert.ok(p.ok);
  assert.deepStrictEqual(p.steps.map((s) => `${s.item} ${s.count} ${s.how} ${s.from}`), ['white_wool 2 chest Hanako-1', 'white_wool 1 kill sheep']);
  assert.match(pathText(p), /white_wool 2 ← 共有のチェスト Hanako-1、white_wool 1 ← sheep\(見える\) \/ 次: 共有のチェスト Hanako-1 から white_wool を出す/);
  assert.deepStrictEqual(pathEn(p), { path: ["white_wool x2 <- take from Hanako's chest 1 (shared)", 'white_wool x1 <- kill sheep (visible)'], next: "take white_wool out of Hanako's chest 1 (shared)" });
  assert.strictEqual(pathMatch(p.next, 'chest_take', 'white_wool'), 'step');
  // 足りていれば、ほかの入手元は使わない
  assert.deepStrictEqual(new Planner(w).plan('white_wool', 2).steps.map((s) => s.how), ['chest']);
});

test('states: 共有のチェストに入れるゴール (取り決め・共同の目標から)。中身は全員に見えている数で確かめ、そのチェストからは出さない', () => {
  const chests = [{ id: 'Hanako-1', items: [{ name: 'white_wool', count: 2 }], known: true }];
  const world = { inventory: [{ name: 'white_wool', count: 1 }], visibleMobs: ['sheep'], sharedChests: chests };
  const c = states.stateCandidates({ world, sense: { shared: chests }, raw: { inventory: world.inventory, entities: [] }, shared: [{ chest: 'Hanako-1', item: 'white_wool', add: 3, note: '共同の目標 white_bed 5', noteEn: 'for the project white_bed x5' }] })
    .find((x) => x.name === 'shared_Hanako-1__white_wool');
  assert.ok(c);
  assert.strictEqual(c.count, 5, '今ある 2 + 入れる 3');
  assert.match(c.desc, /共有のチェスト Hanako-1 に white_wool が5個ある。共同の目標 white_bed 5。今2個/);
  const st = states.parseStateId('shared_Hanako-1__white_wool');
  const p = states.planState(st, 5, world, states.senseState(st, { shared: chests }));
  assert.ok(p.ok);
  assert.ok(!p.steps.some((s) => s.how === 'chest'), '入れる先のチェストからは出さない');
  assert.strictEqual(states.actTextEn(p.acts[0]), "put 3 white_wool into Hanako's chest 1 (shared)");
  assert.strictEqual(states.senseState(st, { shared: [{ id: 'Hanako-1', items: [{ name: 'white_wool', count: 5 }], known: true }] }).have, 5);
});

test('listActions: broadcast・propose・share_chest は board があり act.enable に入れたときだけ。共有のチェストは出さない', () => {
  const raw = mockRaw({ blocks: [...mockRaw().blocks, { name: 'chest', notable: true, diggable: true, seen: 1, nearest: { x: 3, y: 64, z: 0, d: 3 }, positions: [] }] });
  const enable = new Set(['broadcast', 'propose', 'share_chest']);
  const names = (ctx) => listActions(raw, { enable, ...ctx }).map((a) => a.name);
  assert.ok(!names({}).includes('broadcast'), 'board が無ければ出さない');
  const n1 = names({ board: { canShare: true, isShared: () => false } });
  for (const k of ['broadcast', 'propose', 'share_chest']) assert.ok(n1.includes(k), k);
  assert.ok(!names({ board: { canShare: true, isShared: () => true } }).includes('share_chest'));
  assert.ok(!names({ board: { canShare: true, isShared: () => false, proposedRecently: true } }).includes('propose'));
  const a = listActions(raw, { enable, board: { canShare: true, isShared: () => false } }).find((x) => x.name === 'broadcast');
  assert.doesNotMatch(a.descEn, /should|better|good|cooperat/i, '使い方・評価の言葉を入れない');
});

test('Jev: state に board・agreements・projects・shared_chests・open_proposals、質問に agree_q* と relb_*。答えから賛成の P と関係を拾う', async () => {
  const cfg = loadConfig(CFG, {});
  cfg.persona = cfg.personas[1];
  const raw = mockRaw({ heard: [] });
  const ctx = { persona: cfg.persona, goal: { text: '' }, askHint: false, raw, actions: listActions(raw, {}), en: {
    obs: { inventory: 'bread x1' },
    board: { state: { board: ['Ken said to everyone「北に羊」 (just now)'], agreements: ['x'], shared_chests: ["Hanako's chest 1 (shared) (near, east): empty"], broken_agreements: ['Taro took ...'] },
      open: { q1: 'Ken proposes: 「夜は集まろう」 (one agreed so far; you and Ken: friendly)' }, breakers: ['Taro'] } } };
  const st = buildStateEn(ctx);
  for (const k of ['board', 'agreements', 'shared_chests', 'open_proposals', 'broken_agreements']) assert.ok(k in st, k);
  const { questions } = buildQuestionsEn(ctx, { criteria: { look_around: 'look_around' }, hasTable: true });
  assert.strictEqual(questions.agree_q1.type, 'noul');
  assert.match(questions.agree_q1.instructions, /open_proposals\.q1/);
  assert.match(questions.relb_0.instructions, /Taro did in `broken_agreements`/);
  assert.match(questions.next_action.instructions, /`board` is what people said to everyone/);
  assert.doesNotMatch(questions.next_action.instructions + questions.agree_q1.instructions, /should|good|better|cooperat/i);
  const fetch = async (_u, init) => {
    const body = JSON.parse(init.body);
    const k = Object.keys(body.questions.next_action.criteria)[0];
    return { ok: true, status: 200, headers: new Map(), json: async () => ({ answers: { next_action: { choice: k, confidence: 0.5 }, agree_q1: { noul: 0.81 }, relb_0: { score: 0 }, remember: { score: 1 } }, usage: { input_tokens: 500 } }) };
  };
  const d = new JevDecider({ client: new JevClient({ apiKey: 'k', fetch }), twoStage: false });
  const dec = await d.decide(ctx);
  assert.deepStrictEqual(dec.jev.agree, { q1: 0.81 });
  assert.strictEqual(dec.jev.relations.Taro, 0);
});

test('talker: 提案の schema (物・チェストは候補の enum) と読み方。rule は物とチェストがあるときだけ構造にする', () => {
  const ctx = { items: ['white_wool', 'white_bed'], chests: [{ id: 'Hanako-1' }], hereChest: true };
  const sc = proposeSchema(ctx);
  assert.deepStrictEqual(sc.properties.chest.enum, ['', 'Hanako-1', 'here']);
  assert.deepStrictEqual(parseProposal('{"kind":"rule","item":"white_wool","chest":"Hanako-1","count":1,"say":"羊毛は Hanako-1 に"}', ctx).spec, { type: 'rule', item: 'white_wool', chest: 'Hanako-1' });
  assert.deepStrictEqual(parseProposal('{"kind":"rule","item":"","chest":"Hanako-1","count":1,"say":"なにか"}', ctx).spec, { type: 'text' });
  assert.deepStrictEqual(parseProposal('{"kind":"project","item":"white_bed","chest":"","count":5,"say":"ベッドを5つ"}', ctx).spec, { type: 'project', item: 'white_bed', count: 5 });
  assert.strictEqual(parseProposal('{"kind":"other","item":"","chest":"","count":1,"say":""}', ctx), null);
  const t = new Talker({ llm: { model: 'x', complete: async () => ({ text: '{}' }) } });
  const sys = t.proposeMessages({ persona: { name: 'Hanako' }, ...ctx }).map((m) => m.content).join('\n');
  assert.doesNotMatch(sys, /協力すると|しよう|した方が|すると良い/, '使い方の誘導を入れない');
});

// ---- agent のつなぎ (模擬の bot。サーバーにはつながない) ----
function makeAgent(name, dir, deps = {}) {
  const cfg = loadConfig(CFG, { memory: { file: null } });
  cfg.persona = cfg.personas.find((p) => p.name === name) || { ...cfg.personas[0], name };
  cfg.memory.file = null;
  cfg.roster = ['Taro', 'Hanako', 'Ken'];
  const a = new Agent(cfg, { decider: { kind: 'none' }, recordDir: dir, log: () => {}, ...deps });
  a.bot = { username: name, entity: { position: { x: 0, y: 64, z: 0 } }, players: { Taro: {}, Hanako: {}, Ken: {} }, time: { timeOfDay: 3000, day: 0 }, said: [] };
  return a;
}
// 全体チャット: 誰かが言うと、距離に関係なく全員の onChat に届く (サーバーと同じ)
function server(agents) {
  for (const a of agents) a.bot.chat = (t) => { a.bot.said.push(t); for (const b of agents) if (b !== a) b.onChat(a.bot.username, t); };
}
const rows = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('agent: 印のある行は近くの声に入れず全員の板に積む。提案 → Jev の P で賛成 → 成立 → 全員の記憶。共有のチェストに入れると中身が全員に届き、守ったかを数える', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-'));
  const llm = { model: 'fake', complete: async (_m, schema) => ({ text: schema && schema.properties.kind
    ? JSON.stringify({ kind: 'rule', item: 'white_wool', chest: 'here', count: 1, say: '羊毛はここのチェストに入れよう' }) : JSON.stringify({ say: 'みんな、北に羊がいるよ' }) }) };
  const talker = new Talker({ llm });
  const [hanako, taro, ken] = ['Hanako', 'Taro', 'Ken'].map((n) => makeAgent(n, dir, { talker }));
  server([hanako, taro, ken]);
  // 遠く (近くの声の範囲の外) でも届く。近くの声 (heardBuf) には入らない
  const raw = mockRaw({ heard: [], inventory: [{ name: 'white_wool', count: 3 }], blocks: [...mockRaw().blocks, { name: 'chest', notable: true, diggable: true, seen: 1, nearest: { x: 3, y: 64, z: 0, d: 3 }, positions: [] }] });
  const ctx = { raw, goal: { text: '' }, progress: '', socialText: '', memText: '', boardText: '' };
  const r1 = await hanako.doBroadcast(ctx);
  assert.ok(r1.ok);
  assert.strictEqual(hanako.bot.said[0], '【全体】みんな、北に羊がいるよ');
  assert.strictEqual(taro.heardBuf.length, 0);
  assert.strictEqual(taro.board.messages[0].text, 'みんな、北に羊がいるよ');
  // 提案 (chest: here → 先に共有にする)
  const r2 = await hanako.doPropose(ctx);
  assert.ok(r2.ok, r2.msg);
  assert.deepStrictEqual(r2.proposal.spec, { type: 'rule', item: 'white_wool', chest: 'Hanako-1' });
  assert.ok(taro.board.chests.has('Hanako-1'));
  const pid = r2.proposal.id;
  assert.strictEqual(taro.board.proposals.get(pid).n, 3);
  // Taro: state に出る → Jev の agree_q1 = 0.8 → 賛成を全体に返す。3人の 1/3 を超える (2票) → 成立
  const bv = taro.prepareBoard(raw);
  assert.match(bv.en.open.q1, /^Hanako proposes: white_wool goes into Hanako's chest 1 \(shared\)「羊毛はここのチェストに入れよう」/);
  assert.match(bv.text, /## 全体に届いた話\nHanakoの提案「羊毛はここのチェストに入れよう」\nHanako「みんな、北に羊がいるよ」/);
  assert.ok(taro.memory.heard.some((h) => h.global && h.from === 'Hanako'), '聞いた全体チャットは記憶に入る');
  const votes = taro.voteFromJev({ jev: { agree: { q1: 0.8 } } });
  assert.deepStrictEqual(votes.map((v) => v.yes), [true]);
  assert.strictEqual(taro.bot.said[0], `【賛成 ${pid}】`);
  for (const a of [hanako, taro, ken]) assert.strictEqual(a.board.proposals.get(pid).status, 'agreed', a.cfg.persona.name);
  assert.ok(ken.memory.heard.some((h) => /取り決めになった/.test(h.text)));
  // ゴール候補: 取り決めのチェストに white_wool を入れる
  const kv = ken.prepareBoard(raw);
  assert.deepStrictEqual(kv.goal.shared.map((x) => `${x.chest}:${x.item}`), ['Hanako-1:white_wool']);
  // Ken が取り決めのチェストに入れた → 中身の行が全員に届く、守ったと数える
  ken.afterBoardAction({ action: 'chest_put', arg: 'white_wool' }, { ok: true, chest: { pos: { x: 3, y: 64, z: 0 }, items: [{ name: 'white_wool', count: 3 }], item: 'white_wool', n: 3 } });
  assert.match(ken.bot.said.at(-1), /^【箱 Hanako-1 Ken \+white_wool 3】white_wool:3$/);
  assert.deepStrictEqual(hanako.board.chests.get('Hanako-1').items, [{ name: 'white_wool', count: 3 }]);
  assert.deepStrictEqual(taro.memory.extra.containers['3,64,0'].items, [{ name: 'white_wool', count: 3 }], 'chest_take の候補も同じ中身');
  // Taro が出した → Hanako (提案者) が破られたと知る
  taro.afterBoardAction({ action: 'chest_take', arg: 'white_wool' }, { ok: true, chest: { pos: { x: 3, y: 64, z: 0 }, items: [], item: 'white_wool', n: -3 } });
  assert.strictEqual(hanako.board.breaches.length, 1);
  await Promise.all([hanako, taro, ken].map((a) => a.recorder.close()));
  const all = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).flatMap((f) => rows(path.join(dir, f)));
  const kinds = all.filter((r) => r.event === 'board').map((r) => r.kind);
  for (const k of ['broadcast', 'propose', 'share_chest', 'seen', 'vote', 'agreed', 'comply', 'breach_known']) assert.ok(kinds.includes(k), k);
  const comply = all.filter((r) => r.kind === 'comply');
  assert.deepStrictEqual(comply.map((r) => r.kept), [true, false]);
});
