'use strict';
// 最初の「1つの設定」の部品: 使用量の上限・社会性・忘れる記憶・周りに聞く・小屋・設定ファイル
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { UsageMeter, estimateTokens } = require('../src/usage');
const { Social } = require('../src/social');
const { Memory } = require('../src/memory');
const ask = require('../src/ask');
const { hutSlots, hutStatus } = require('../src/hut');
const { listActions } = require('../src/actions');
const { buildContext, goalMet } = require('../src/agent');
const { loadConfig } = require('../src/config');
const { progressText } = require('../src/progress');
const { mockRaw } = require('./fixtures');

const CFG = path.join(__dirname, '..', 'configs', 'first_setting.json');

test('UsageMeter: Jev の入力トークンの合計が上限に達したら一度だけ知らせる・費用を出す', () => {
  const m = new UsageMeter({ maxJevInputTokens: 1000 });
  const hits = [];
  m.onExceeded((u) => hits.push(u));
  m.addJev({ inputChars: 100, inputTokens: 600, ms: 200, questions: 3 });
  assert.strictEqual(m.exceeded, false);
  m.addJev({ inputChars: 100, inputTokens: 600, ms: 300, questions: 3 });
  m.addJev({ inputChars: 100, inputTokens: 600, ms: 300, questions: 3 });
  assert.strictEqual(m.exceeded, true);
  assert.strictEqual(hits.length, 1);
  const s = m.summary();
  assert.strictEqual(s.jev.inputTokens, 1800);
  assert.strictEqual(s.jev.avgInputTokens, 600);
  assert.strictEqual(s.jev.costUsd, Number(((1800 / 1e6) * 0.042).toFixed(6)));
  m.addTwoB({ kind: 'talk', promptChars: 400, promptTokens: 300, ms: 5000 });
  m.addTwoB({ kind: 'answer', promptChars: 200, ms: 3000 });
  assert.strictEqual(m.summary().twoB.calls, 2);
  assert.strictEqual(m.summary().twoB.byKind.talk.calls, 1);
  assert.strictEqual(estimateTokens('あいう abcdefgh'), 3 + Math.ceil(9 / 4));
});

test('Social: ルールで感情・欲求・関係が動き、短い言葉になる (数値は出さない)', () => {
  const s = new Social({ temperament: { sociability: 0.9 } });
  for (let i = 0; i < 3; i++) s.onActionResult('collect', false, { repeatedFail: true });
  assert.ok(s.emotions.anger > 2);
  assert.match(s.words(), /いらだ|怒/);
  s.onHeard('Hanako', 1);
  s.onAnswered('Hanako', true);
  s.onRelationScore('Hanako', 4);
  assert.ok(s.rel('Hanako').affinity > 60);
  assert.match(s.words(), /Hanakoとは(仲が良い|感じが良い)。前にやり方を教えてくれた/);
  s.onIgnored('Jiro');
  s.onRelationScore('Jiro', 0);
  assert.match(s.words(), /Jiroとは少し苦手。聞いたのに返事がなかった/);
  assert.ok(!/\d/.test(s.words()), '2B に数値を渡さない');
  // 夕方になって小屋が無いと安全の欲求が上がる
  s.tick({ tick: 50, raw: { self: { food: 20, timeOfDay: 12500 } }, hasFood: false, progress: { hutRatio: 0 } });
  assert.ok(s.needs.safety > 0.5);
  assert.match(s.words(), /夜が近くて/);
  const back = Social.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
  assert.strictEqual(back.rel('Hanako').affinity, s.rel('Hanako').affinity);
});

test('Memory: 時間で忘れ、大事なもの (Jev の Score) は残る', () => {
  const m = new Memory({ limits: { promptItems: 20, halfLife: 10, impBoost: 6, forgetBelow: 0.1 } });
  m.tick = 1;
  m.noteEvent('look_around', '', true, '周りを見回した', 0);
  m.noteHeard('Hanako', 'こんにちは');
  m.setRecentImportance(0.0, 1);
  m.tick = 2;
  m.noteEvent('craft', 'crafting_table', true, '作った');
  m.setRecentImportance(1.0, 2);
  m.noteKnowledge('Hanako', 'craft:wooden_pickaxe', '作業台の近くで作る', { at: '昼' });
  m.tick = 50;
  m.forget();
  assert.ok(!m.events.some((e) => e.action === 'look_around'), '大事でないものは忘れた');
  assert.ok(!m.heard.some((h) => h.text === 'こんにちは'));
  assert.ok(m.events.some((e) => e.arg === 'crafting_table'), '大事なものは残る');
  assert.strictEqual(m.knowledge.length, 1);
  assert.ok(m.forgotten >= 2);
  const txt = m.toPromptText({ x: 0, y: 64, z: 0 });
  assert.match(txt, /教わったこと: Hanakoから\(48回前・昼\)「作業台の近くで作る」/);
});

test('Memory: プロンプトに入れる記憶は promptItems 件まで (場所を含む)・拠点は忘れず必ず入る', () => {
  const m = new Memory({ limits: { promptItems: 12, promptPlaces: 4 } });
  m.notePlace('拠点', { x: 200, y: 64, z: 0 }, { keep: true, imp: 1 });
  for (let i = 0; i < 40; i++) {
    m.tick = i;
    m.noteEvent('collect', `log${i}`, i % 3 === 0, 'x', i % 5 === 0 ? 0.9 : 0.1);
    m.noteHeard('Ken', `話${i}`);
    m.notePlace('oak_log', { x: i * 20, y: 64, z: 0 });
  }
  m.tick = 300;
  m.forget();
  const here = { x: 0, y: 64, z: 0 };
  const places = m.placesForPrompt(here);
  assert.strictEqual(places[0].kind, '拠点');
  m.toPromptText(here, { places });
  const sel = m.lastSelection;
  const total = sel.places + sel.event + sel.heard + sel.knowledge;
  assert.ok(total <= 12, `total ${total}`);
  assert.ok(sel.event >= 2, '最新のやったことは入る');
});

test('ask: 困りごとの検出・チャットの形・記憶の範囲で答える・知らなければ空', () => {
  const m = new Memory();
  m.noteEvent('craft', 'wooden_pickaxe', false, '材料が足りない');
  m.noteEvent('craft', 'wooden_pickaxe', false, '材料が足りない');
  const tr = ask.troubles(m);
  assert.deepStrictEqual(tr.map((t) => t.key), ['craft:wooden_pickaxe']);
  assert.strictEqual(tr[0].about, 'wooden_pickaxeの作り方');
  const q = ask.questionText('Hanako', tr[0]);
  assert.deepStrictEqual(ask.parseQuestion(q), { to: 'Hanako', question: 'wooden_pickaxeの作り方が分からない(「材料が足りない」で失敗した)' });
  assert.deepStrictEqual(ask.parseAnswer(ask.answerText('Taro', '棒が要る')), { to: 'Taro', text: '棒が要る' });
  assert.strictEqual(ask.parseQuestion('こんにちは'), null);
  // 聞かれた側: 作ったことがあれば答えられる、なければ空
  const knows = new Memory();
  knows.noteEvent('craft', 'wooden_pickaxe', true, 'wooden_pickaxeを1個作った');
  assert.strictEqual(ask.relevantMemories(knows, 'wooden_pickaxeの作り方が分からない').length, 1);
  assert.strictEqual(ask.relevantMemories(new Memory(), 'wooden_pickaxeの作り方が分からない').length, 0);
  assert.ok(ask.isDontKnow('ごめん、それは分からない'));
  assert.strictEqual(ask.answerUse({ key: 'craft:wooden_pickaxe', answer: 'stick を作る' }, { action: 'craft', arg: 'stick' }, { ok: true }), 'followed');
  assert.strictEqual(ask.answerUse({ key: 'craft:wooden_pickaxe', answer: '' }, { action: 'craft', arg: 'wooden_pickaxe' }, { ok: true }), 'retried_ok');
});

test('listActions: 困っていて人が見えるときだけ ask、拠点と材料があれば build、動物が見えれば hunt', () => {
  const raw = mockRaw({ entities: [{ kind: 'player', name: 'Hanako', pos: { x: -4, y: 64, z: 4 }, d: 5.7 }, { kind: 'mob', name: 'cow', pos: { x: 6, y: 64, z: 0 }, d: 6 }] });
  const tr = [{ key: 'collect:spruce_log', about: 'spruce_logの取り方', lastMsg: 'x' }];
  const acts = listActions(raw, { troubles: tr, base: { x: 0, y: 64, z: 6 } });
  const names = acts.map((a) => a.name);
  assert.ok(names.includes('ask'));
  assert.deepStrictEqual(acts.find((a) => a.name === 'ask').choices.map((c) => c.id), ['Hanako']);
  assert.deepStrictEqual(acts.find((a) => a.name === 'build').choices.map((c) => c.id), ['spruce_log']);
  assert.deepStrictEqual(acts.find((a) => a.name === 'hunt').choices.map((c) => c.id), ['cow']);
  assert.ok(!listActions(raw, { base: null }).some((a) => a.name === 'ask' || a.name === 'build'));
  const alone = mockRaw({ entities: [] });
  assert.ok(!listActions(alone, { troubles: tr }).some((a) => a.name === 'ask'), '誰も見えなければ聞けない');
});

test('hut: 5x5・壁2段・屋根で 55 か所、入口は空ける。読み込まれていなければ不明', () => {
  const slots = hutSlots({ x: 0, y: 64, z: 0 }, { size: 5, height: 2, roof: true });
  assert.strictEqual(slots.length, 55);
  assert.ok(!slots.some((s) => s.x === 0 && s.z === 2 && s.y < 66), '入口');
  const filled = new Set(slots.slice(0, 30).map((s) => `${s.x},${s.y},${s.z}`));
  const st = hutStatus(slots, (p) => (filled.has(`${p.x},${p.y},${p.z}`) ? 'oak_planks' : 'air'));
  assert.strictEqual(st.filled, 30);
  assert.strictEqual(st.empty[0].part, 'roof');
  assert.strictEqual(hutStatus(slots, () => null).ratio, null);
});

test('first_setting.json: 目標・助け①〜③・聞く・Jev・上限 300万。手順は小屋と食べ物で進む', () => {
  const cfg = loadConfig(CFG);
  assert.match(cfg.goal.text, /仲間と協力して、夜までに拠点\(小屋\)を作り、食べ物を確保する/);
  assert.deepStrictEqual(cfg.help, { hints: true, steps: true, progress: true, askOthers: true, excludeFailures: false, noChange: true });
  assert.deepStrictEqual(Object.keys(cfg.noChange).filter((k) => !k.startsWith('_')), ['window', 'repeat', 'weight', 'weightWindow']);
  assert.strictEqual(cfg.decider.type, 'jev');
  assert.strictEqual(cfg.usage.maxJevInputTokens, 3000000);
  assert.ok(cfg.personas.length >= 5);
  assert.ok(cfg.personas.every((p) => p.name.length <= 16));
  const raw = mockRaw({ inventory: [{ name: 'oak_planks', count: 20 }], hut: { ratio: 0.95 }, foodCount: 0 });
  assert.match(progressText(cfg.goal.steps, raw), /\(3\)拠点で build して小屋を建てる…済 \(4\)hunt で食べ物\(肉\)を2個手に入れる…← 次はこれ/);
  assert.ok(!goalMet(cfg.goal, raw.inventory, raw));
  assert.ok(goalMet(cfg.goal, raw.inventory, { ...raw, foodCount: 2 }));
  assert.ok(!goalMet(cfg.goal, raw.inventory, { ...raw, hut: null, foodCount: 2 }), '拠点が見えないときは達成と判定しない');
});

test('buildContext: excludeFailures=false なら失敗した選択を外さず、askOthers なら困りごとを渡す', () => {
  const cfg = loadConfig(CFG);
  const m = new Memory({ limits: cfg.memory.limits });
  m.noteEvent('collect', 'spruce_log', false, '届かない');
  m.noteEvent('collect', 'spruce_log', false, '届かない');
  const c = buildContext(mockRaw(), m, cfg, { foods: new Set(), socialText: '少しいらだっている' });
  assert.ok(c.actions.find((a) => a.name === 'collect').choices.some((x) => x.id === 'spruce_log'), '④を使わない');
  assert.deepStrictEqual(c.troubles.map((t) => t.key), ['collect:spruce_log']);
  assert.ok(c.actions.some((a) => a.name === 'ask'), 'Hanako が見えているので聞ける');
  // 段階1の設定 (help なし) では、これまでどおり外す
  const old = loadConfig(path.join(__dirname, '..', 'configs', 'wood_pickaxe.json'));
  const c2 = buildContext(mockRaw(), m, old, { foods: new Set() });
  assert.ok(!c2.actions.find((a) => a.name === 'collect').choices.some((x) => x.id === 'spruce_log'));
  assert.ok(!c2.actions.some((a) => a.name === 'ask'));
});

test('first_setting.json: 知っていること (goal.hints) は事実だけ (扱い方・勧め・優先順位を書かない)', () => {
  const cfg = loadConfig(CFG);
  for (const h of cfg.goal.hints) assert.doesNotMatch(h, /(とよい|といい|べき|優先|ほうが|方が|おすすめ|勧め|まず|先に)/, h);
  assert.ok(cfg.goal.hints.some((h) => /原木1個から板材\(_planks\)が4個/.test(h)));
  assert.ok(cfg.goal.hints.some((h) => /板材4個から作業台/.test(h)));
});
