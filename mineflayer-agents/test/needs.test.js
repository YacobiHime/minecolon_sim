'use strict';
// 人としての欲求とストレス (needs.js)・欲求からのゴール (goalplan.js)・記録の集計
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Needs, needsConfig, senseShelter, effectiveLight, foodPoints, hungerFromFood } = require('../src/needs');
const { Social } = require('../src/social');
const { GoalPlan, parseGoal, GOAL_SCHEMA } = require('../src/goalplan');
const { loadConfig } = require('../src/config');
const { simulate, SCENARIOS } = require('../tools/sim_needs');

const CFG = path.join(__dirname, '..', 'configs', 'survival_3days.json');
const ADVICE = /(とよい|といい|べき|優先|ほうが|方が|おすすめ|勧め|まず|先に|良い|よい|大切|重要)/;

// 昼・明るい・安全な所で時間だけ進める
function run(n, from, to, step = 200, sense = {}) {
  for (let t = from; t <= to; t += step) n.update({ time: t, timeOfDay: t % 24000, light: 15, shelter: { enclosed: true }, players: [], ...sense });
}

test('空腹 (満腹度が分からないとき): 時間で増え、食べると食べ物の量に応じて減る', () => {
  const n = new Needs({});
  run(n, 0, 3500);
  assert.ok(n.v.hunger > 0.6 && n.v.hunger < 0.8, String(n.v.hunger)); // 0.2 + 3500/7000
  const h = n.v.hunger;
  n.onEat('cooked_beef'); // 満腹度 8
  assert.ok(Math.abs(h - n.v.hunger - 0.8 * Math.min(1, h / 0.8)) < 1e-6);
  n.v.hunger = 0.9;
  n.onEat('apple'); // 4
  assert.strictEqual(n.v.hunger, 0.5);
  assert.strictEqual(foodPoints('bread'), 5);
  assert.strictEqual(n.counts.ate, 2);
});

test('空腹 (満腹度が基準): 1 − food/20、隠し満腹度が0なら少し強く。食べた分は満腹度の回復で減る。寝て夜を飛ばしても増えない', () => {
  const n = new Needs({});
  n.update({ time: 0, timeOfDay: 1000, food: 20, saturation: 5 });
  assert.strictEqual(n.v.hunger, 0);
  n.update({ time: 200, timeOfDay: 1200, food: 14, saturation: 2 });
  assert.strictEqual(n.v.hunger, 0.3);
  n.update({ time: 400, timeOfDay: 1400, food: 14, saturation: 0 });
  assert.strictEqual(n.v.hunger, 0.4);
  // 時間がたっても満腹度が同じなら変わらない
  n.update({ time: 6000, timeOfDay: 7000, food: 14, saturation: 0 });
  assert.strictEqual(n.v.hunger, 0.4);
  n.update({ time: 6200, timeOfDay: 7200, food: 8, saturation: 0 });
  assert.strictEqual(n.v.hunger, 0.7);
  n.onEat('cooked_beef'); // 満腹度 +8、隠し +12.8 → food 16
  assert.strictEqual(n.v.hunger, 0.2);
  assert.strictEqual(n.food, 16);
  n.update({ time: 6400, timeOfDay: 7400, food: 16, saturation: 12.8 });
  assert.strictEqual(n.v.hunger, 0.2);
  n.onSleep({ nightSkipped: true });
  assert.strictEqual(n.v.hunger, 0.2, '満腹度で決めているときは bedHunger を足さない');
  assert.strictEqual(hungerFromFood(0, 0), 1);
  // 保存して戻せる
  const back = Needs.fromJSON(JSON.parse(JSON.stringify(n.toJSON())));
  assert.strictEqual(back.food, 16);
});

test('空腹の人ごとの差: sensitivity (感じやすさ) と threshold。survival_3days の Taro は感じやすく、Shota は感じにくく、Emi は早めに気にする', () => {
  const cfg = loadConfig(CFG);
  const mk = (name) => new Needs({ cfg: needsConfig(cfg, cfg.personas.find((p) => p.name === name)) });
  const [taro, emi, ken] = ['Taro', 'Emi', 'Ken'].map(mk);
  const slow = cfg.personas.find((p) => p.needs && p.needs.hunger && p.needs.hunger.sensitivity < 1);
  assert.ok(slow, '感じにくい人がいる');
  const y = mk(slow.name);
  for (const n of [taro, emi, ken, y]) n.update({ time: 0, timeOfDay: 1000, food: 12, saturation: 1 });
  assert.ok(taro.v.hunger > ken.v.hunger && ken.v.hunger > y.v.hunger, `${taro.v.hunger} ${ken.v.hunger} ${y.v.hunger}`);
  assert.strictEqual(slow.name, 'Shota');
  assert.strictEqual(emi.v.hunger, ken.v.hunger);
  assert.ok(emi.threshold('hunger') < ken.threshold('hunger'), 'Emi は早めに気にする (しきい値)');
});

test('眠気: 起きている間ずっと増え、夜に速い。ベッドで消える。床で休むと少し。寝ずに夜を越すと翌日まで残り「昨夜は寝られなかった」', () => {
  const n = new Needs({});
  run(n, 0, 12000);
  const day = n.v.sleep;
  run(n, 12200, 15000);
  assert.ok((n.v.sleep - day) / 3000 > (day - 0.1) / 12000 * 2, '夜は速い');
  const before = n.v.sleep;
  n.onRest();
  assert.ok(Math.abs(before - n.v.sleep - 0.03) < 1e-6);
  run(n, 15200, 24200); // 寝ないで朝
  assert.strictEqual(n.missedNights, 1);
  assert.ok(n.v.sleep >= 0.95);
  assert.match(n.words(), /昨夜は寝られなかった/);
  run(n, 24400, 48200); // もう一晩
  assert.strictEqual(n.missedNights, 2);
  assert.match(n.words(), /二晩ちゃんと寝ていない/);
  n.onEat('cooked_beef'); n.onEat('cooked_beef'); // 空腹のほうが強くならないように
  const w = n.worst();
  assert.strictEqual(w.need, 'sleep');
  assert.match(w.text, /二晩ちゃんと寝ていない/);
  n.onSleep({ nightSkipped: true });
  assert.strictEqual(n.v.sleep, 0);
  assert.strictEqual(n.missedNights, 0);
});

test('安心: 暗い・夜に外・敵が近い・知らない所に一人で下がり、囲まれた所・信頼できる人・明るいで上がる。殺されるとなかなか消えない', () => {
  const night = (n, t, sense) => n.update({ time: t, timeOfDay: 15000 + (t % 1000), ...sense });
  const out = new Needs({});
  for (let t = 0; t < 2000; t += 200) night(out, t, { light: 3, shelter: { enclosed: false }, hostiles: [{ name: 'zombie', d: 4 }], players: [], unfamiliar: true });
  assert.ok(out.v.safety > 0.75, String(out.v.safety));
  assert.match(out.words(), /近くにzombieがいる/);
  assert.match(out.words(), /怖い/);
  const home = new Needs({});
  for (let t = 0; t < 2000; t += 200) night(home, t, { light: 12, shelter: { enclosed: true }, players: [{ name: 'Hanako', d: 3, affinity: 70 }], atHome: true });
  assert.ok(home.v.safety < 0.1);
  assert.match(home.words(), /安心している/);
  // 気質: 怖がり (bravery 0.2) は同じ夜でより不安
  const brave = new Needs({ temperament: { bravery: 0.9 } });
  const timid = new Needs({ temperament: { bravery: 0.2 } });
  for (const n of [brave, timid]) for (let t = 0; t < 2000; t += 200) night(n, t, { light: 3, shelter: { enclosed: false }, players: [] });
  assert.ok(timid.v.safety > brave.v.safety + 0.1);
  // 殺された: 昼の安全な所に戻っても、ゲームの半日は不安が残る
  const d = new Needs({});
  run(d, 0, 1000);
  d.onDeath();
  run(d, 1200, 13000);
  assert.ok(d.shock.death > 0.5, String(d.shock.death));
  assert.ok(d.v.safety >= 0.25, String(d.v.safety)); // 囲まれた明るい所でも安心しきれない
  assert.match(d.words(), /殺されたことが頭から離れない/);
  // ダメージ
  const h = new Needs({});
  h.update({ time: 0, timeOfDay: 1000, health: 20, light: 15 });
  h.update({ time: 200, timeOfDay: 1200, health: 12, light: 15 });
  assert.ok(h.shock.hurt > 0.3);
});

test('つながり: 話しただけでは満たされず、一緒に行動した・助けた/助けられたで満たされる。関係の良い人がいれば軽い', () => {
  const s = new Social({});
  for (let t = 0; t <= 6000; t += 200) s.tick({ tick: t / 200, sense: { time: t, timeOfDay: t, light: 15, players: [] } });
  const c0 = s.needs.connection;
  for (let i = 0; i < 5; i++) s.onHeard('Ken', 31 + i, 'やあ'); // 話しただけ
  assert.strictEqual(s.needs.connection, c0);
  s.onActionNeeds('follow', 'Ken', { ok: true });
  assert.ok(s.needs.connection < c0 - 0.15);
  const c1 = s.needs.connection;
  s.onAnswered('Ken', true); // 教えてもらえた = 助けられた
  assert.ok(s.needs.connection < c1);
  // 感謝: 物をあげた相手から「ありがとう」で認められたいが満たされる
  s.needsModel.v.recognition = 0.8;
  s.onActionNeeds('give', 'Hanako:bread:1', { ok: true }, 40);
  const r1 = s.needs.recognition;
  assert.ok(r1 < 0.8);
  s.onHeard('Hanako', 42, 'パンありがとう!');
  assert.ok(s.needs.recognition < r1 - 0.2);
  assert.strictEqual(s.rel('Hanako').iHelped, 1);
});

test('マズロー的な重み: 空腹・眠気・不安が強いときは、上の欲求が弱く出る', () => {
  const n = new Needs({});
  n.v.connection = 0.9; n.v.recognition = 0.9;
  n.v.hunger = 0.1;
  const calm = n.effective().connection;
  n.v.hunger = 1;
  assert.ok(n.effective().connection < calm * 0.5);
  assert.ok(n.gate() < 0.3);
});

test('ストレス: 満たされない時間が長いほど急に増え (非線形)、満たされれば少しずつ抜ける。係数は config', () => {
  const n = new Needs({});
  n.v.hunger = 1;
  const inc = [];
  for (let h = 0; h < 4; h++) {
    const s0 = n.stress;
    for (let t = 0; t < 2000; t += 200) n.update({ time: h * 2000 + t, timeOfDay: 1000, light: 15, shelter: { enclosed: true } });
    inc.push(n.stress - s0);
  }
  for (let i = 1; i < inc.length; i++) assert.ok(inc[i] > inc[i - 1] * 1.2, JSON.stringify(inc));
  const peak = n.stress;
  n.onEat('cooked_beef'); n.onEat('cooked_beef');
  for (const k of ['connection', 'recognition', 'curiosity', 'greed', 'care']) n.v[k] = 0; // 上の欲求も満ちている場合
  for (let t = 8000; t < 10000; t += 200) n.update({ time: t, timeOfDay: 1000, light: 15, shelter: { enclosed: true } });
  assert.ok(n.stress < peak && n.stress > peak - 0.1, `${peak} → ${n.stress}`);
  // config で係数を変えられる
  const fast = new Needs({ cfg: { stress: { k: 0.05 } } });
  fast.v.hunger = 1;
  for (let t = 0; t < 4000; t += 200) fast.update({ time: t, timeOfDay: 1000, light: 15, shelter: { enclosed: true } });
  const slow = new Needs({});
  slow.v.hunger = 1;
  for (let t = 0; t < 4000; t += 200) slow.update({ time: t, timeOfDay: 1000, light: 15, shelter: { enclosed: true } });
  assert.ok(fast.stress > slow.stress * 3);
});

test('ストレスが高いと感情が変わる。どれが強く出るかは性格で変わる', () => {
  const mk = (t) => { const s = new Social({ temperament: t }); s.needsModel.stress = 0.7; s.needsModel.inflow = { hunger: 0.01, sleep: 0.01, safety: 0.01 }; for (let i = 0; i < 6; i++) s.stressToEmotions(); return s; };
  const jiro = mk({ obedience: 0.3, bravery: 0.8, empathy: 0.3 });
  const yuki = mk({ obedience: 0.7, bravery: 0.2, empathy: 0.6 });
  assert.ok(jiro.emotions.anger > yuki.emotions.anger);
  assert.ok(yuki.emotions.fear > jiro.emotions.fear);
  assert.match(jiro.words(), /いらだ|怒/);
});

test('渡し方: 体と心の状態は毎回必ず言葉で入る (数値なし)。関係も続けて入る', () => {
  const s = new Social({});
  s.tick({ tick: 1, sense: { time: 0, timeOfDay: 1000, light: 15, players: [] } });
  const w = s.words();
  assert.match(w, /お腹/);
  assert.match(w, /眠/);
  assert.match(w, /落ち着|安心|怖|不安/);
  assert.ok(!/\d/.test(w), w);
  s.onAnswered('Hanako', true);
  assert.match(s.words(), /Hanakoとは/);
  assert.doesNotMatch(s.words({ relations: false }), /Hanakoとは/);
  // 保存して戻せる
  const back = Social.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
  assert.strictEqual(back.needs.hunger, s.needs.hunger);
});

test('人ごとの設定: cfg.needs に persona.needs を重ねる。survival_3days の5人には少し差がある', () => {
  const cfg = loadConfig(CFG);
  const taro = cfg.personas.find((p) => p.name === 'Taro');
  const hanako = cfg.personas.find((p) => p.name === 'Hanako');
  const a = new Needs({ cfg: needsConfig(cfg, taro) });
  const b = new Needs({ cfg: needsConfig(cfg, hanako) });
  assert.strictEqual(a.cfg.hunger.fullAfter, 6000);
  assert.strictEqual(b.cfg.hunger.fullAfter, 7000);
  assert.strictEqual(a.cfg.stress.k, cfg.needs.stress.k);
  run(a, 0, 3000); run(b, 0, 3000);
  assert.ok(a.v.hunger > b.v.hunger);
  for (const p of cfg.personas) assert.ok(p.needs, p.name);
});

test('周りの様子: 屋根と壁・夜の明るさ', () => {
  const solid = new Set(['0,66,0', '1,64,0', '-1,64,0', '0,64,1']);
  const at = (x, y, z) => (solid.has(`${x},${y},${z}`) ? { boundingBox: 'block' } : { boundingBox: 'empty' });
  assert.deepStrictEqual(senseShelter(at, { x: 0.5, y: 64, z: 0.5 }), { roof: true, walls: 3, enclosed: true });
  assert.strictEqual(senseShelter(() => null, { x: 0, y: 64, z: 0 }).enclosed, false);
  assert.strictEqual(effectiveLight({ blockLight: 0, skyLight: 15 }, 6000), 15);
  assert.ok(effectiveLight({ blockLight: 0, skyLight: 15 }, 18000) < 8);
  assert.strictEqual(effectiveLight({ blockLight: 14, skyLight: 15 }, 18000), 14);
});

test('1日のシミュレーション: 食べない・寝ない・夜に外 でストレスが増え、ふつうの日はほとんど増えない', () => {
  const at = (sc, h) => simulate(SCENARIOS[sc], { days: 1.5 }).find((r) => r.hour === h);
  assert.ok(at('normal', 24).stress < 0.05);
  assert.ok(at('noFood', 24).stress > 0.7);
  assert.ok(at('noSleep', 24).stress > 0.2 && at('noSleep', 24).missedNights === 1);
  assert.ok(at('nightOut', 18).safety > 0.6);
  assert.ok(at('all', 20).stress > at('noFood', 20).stress);
  assert.ok(at('alone', 24).stress > at('normal', 24).stress);
  // 空腹は満腹度から: 食べないと満腹度が0近くまで減り空腹は1、ふつうの日は食べて満腹度が戻る
  assert.ok(at('noFood', 12).food <= 2 && at('noFood', 12).hunger === 1, JSON.stringify(at('noFood', 12)));
  const normal = simulate(SCENARIOS.normal, { days: 1 });
  assert.ok(normal.every((r) => r.food >= 12 && r.hunger < 0.5), JSON.stringify(normal.map((r) => [r.food, r.hunger])));
});

// ---- 欲求からのゴール ----

function mockLLM(script) {
  const seen = [];
  return {
    seen, maxTokens: 96,
    complete: async (messages, schema) => {
      const kind = /JSON \{"goal"/.test(messages[0].content) ? 'goal' : /手順は全部済んだが/.test(messages[1].content) ? 'rebuild_need' : 'steps';
      seen.push({ kind, messages, schema });
      const q = script[kind];
      return { text: Array.isArray(q) ? q.shift() : q, promptTokens: 400, completionTokens: 40 };
    },
  };
}

test('ゴール: 体と心・いちばんつらいこと・周りの人を渡し、全体の目標は渡さない。why と need を書かせる', async () => {
  assert.deepStrictEqual(GOAL_SCHEMA.required, ['goal', 'why', 'need']);
  assert.deepStrictEqual(parseGoal('{"goal":"ベッドを作って寝る","why":"二晩寝ていなくて眠い","need":"眠気"}'), { goal: 'ベッドを作って寝る', why: '二晩寝ていなくて眠い', need: 'sleep' });
  assert.strictEqual(parseGoal('{"goal":"x","why":"y","need":"なにか"}').need, null);
  let sleepNow = 0.95;
  const llm = mockLLM({
    goal: ['{"goal":"ベッドで寝る","why":"二晩寝ていなくて眠い","need":"眠気"}', '{"goal":"食べ物を探す","why":"お腹が空いた","need":"空腹"}'],
    steps: '{"needs":["ベッド"],"steps":["ベッドを持っている","ベッドで寝た"]}',
    rebuild_need: '{"needs":["夜"],"steps":["夜まで待った","ベッドで寝た"]}',
  });
  const logs = [];
  const g = new GoalPlan({ llm, log: (e) => logs.push(e), cfg: { abandonAfter: 3 } });
  const ctx = () => ({
    persona: { name: 'Yuki', personality: '慎重' }, goalText: '', obsText: '自分: Yuki', raw: { self: { timeOfDay: 2000, day: 1 } },
    facts: () => [], actions: [{ name: 'sleep', desc: 'ベッドで寝る' }], memText: 'なし', troubles: [],
    socialText: 'お腹が空いた。二晩ちゃんと寝ていない。眠くてたまらない。落ち着いている',
    worst: { need: 'sleep', label: '眠気', text: '二晩ちゃんと寝ていない。眠くてたまらない' },
    peopleText: 'Ken: 感じが良い。今は東 5mにいる。最近の発言 「木を切ろう」。最近 oak_logを3個拾った',
    needNow: (k) => (k === 'sleep' ? sleepNow : 0.5),
  });
  assert.strictEqual(await g.update(ctx(), 1), 'goal');
  const gm = llm.seen[0].messages;
  assert.doesNotMatch(gm[0].content, /全体の目標/);
  assert.match(gm[1].content, /## 体と心\n.*二晩ちゃんと寝ていない/);
  assert.match(gm[1].content, /## いちばんつらいこと\n二晩ちゃんと寝ていない/);
  assert.match(gm[1].content, /## 周りの人\nKen: 感じが良い。.*oak_logを3個拾った/);
  for (const x of llm.seen) assert.doesNotMatch(x.messages[0].content, ADVICE, x.messages[0].content);
  assert.doesNotMatch(gm[0].content, /原木|作業台/);
  assert.strictEqual(g.goal.why, '二晩寝ていなくて眠い');
  assert.strictEqual(g.goal.need, 'sleep');
  assert.match(g.planText(), /何のため: 二晩寝ていなくて眠い/);
  const ge = logs.find((e) => e.kind === 'goal');
  assert.strictEqual(ge.why, '二晩寝ていなくて眠い');
  assert.strictEqual(ge.need, 'sleep');
  assert.strictEqual(ge.needAt, 0.95);
  assert.strictEqual(ge.worst, 'sleep');
  // 手順は全部済んだが、眠気が下がっていない → 手順を作り直す (ゴールは変えない)
  await g.update(ctx(), 2, { stepDoneP: 0.9 });
  assert.strictEqual(await g.update(ctx(), 3, { stepDoneP: 0.9 }), 'rebuild_need');
  assert.strictEqual(g.goal.text, 'ベッドで寝る');
  assert.strictEqual(g.idx, 0);
  assert.deepStrictEqual(g.steps.map((s) => s.text), ['夜まで待った', 'ベッドで寝た']);
  assert.ok(logs.some((e) => e.kind === 'need_unmet'));
  assert.match(llm.seen.find((x) => x.kind === 'rebuild_need').messages[1].content, /眠気のつらさが変わらない/);
  // 寝られて眠気が下がった → 達成
  sleepNow = 0.1;
  await g.update(ctx(), 4, { stepDoneP: 0.9 });
  assert.strictEqual(await g.update(ctx(), 5, { stepDoneP: 0.9 }), 'goal_done');
  assert.strictEqual(g.history[0].need, 'sleep');
  assert.strictEqual(g.history[0].why, '二晩寝ていなくて眠い');
  const done = logs.find((e) => e.kind === 'goal_done');
  assert.strictEqual(done.needNow, 0.1);
  assert.strictEqual(g.goal.text, '食べ物を探す');
});

test('summarize_run: 人ごとの欲求・ストレスの推移 (分ごとの平均・最大)・寝た回数・食べた回数・ゴールの why', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'needs-'));
  const t = (s) => new Date(Date.UTC(2026, 10, 3, 1, 0, s)).toISOString();
  const needs = (h, st) => ({ hunger: h, sleep: 0.2, safety: 0.1, connection: 0.3, recognition: 0.2, curiosity: 0.3, greed: 0.2, care: 0.2, stress: st });
  const step = (loop, s, action, extra = {}) => ({ ts: t(s), loop, action, arg: '', result: { ok: true, msg: 'ok' }, parseOk: true, valid: true, inventory: [], social: { words: 'x', needs: needs(0.5, 0.1 * loop), worst: 'hunger' }, ...extra });
  fs.writeFileSync(path.join(dir, 'Taro-x.jsonl'), [
    { ts: t(0), event: 'start', persona: { name: 'Taro' } },
    step(1, 10, 'collect'),
    step(2, 70, 'eat'),
    step(3, 80, 'sleep', { result: { ok: true, msg: '寝て起きた', sleep: { slept: true, nightSkipped: true } } }),
    { ts: t(81), event: 'goal_plan', kind: 'goal', ok: true, goal: 'パンを作る', why: 'お腹が空いた', need: 'hunger', worst: 'hunger' },
  ].map((o) => JSON.stringify(o)).join('\n'));
  const out = JSON.parse(execFileSync('node', [path.join(__dirname, '..', 'tools', 'summarize_run.js'), dir], { encoding: 'utf8' }));
  const n = out.needs.Taro;
  assert.strictEqual(n.ate, 1);
  assert.strictEqual(n.slept, 1);
  assert.strictEqual(n.nightsSkipped, 1);
  assert.strictEqual(n.perMinute.length, 2);
  assert.deepStrictEqual(n.perMinute[0].stress, { avg: 0.1, max: 0.1 });
  assert.deepStrictEqual(n.perMinute[1].stress, { avg: 0.25, max: 0.3 });
  assert.strictEqual(n.overall.hunger.avg, 0.5);
  assert.strictEqual(n.worst.hunger, 3);
  assert.match(out.goalWhy[0], /パンを作る \(何のため: お腹が空いた \/ need: hunger/);
});
