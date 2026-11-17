'use strict';
// 感情の言葉の作り方 (src/emotion_words.js と Social.words の wording)
const test = require('node:test');
const assert = require('node:assert');
const EW = require('../src/emotion_words');
const { Social, EMOTIONS } = require('../src/social');

const mk = (wording, extra = {}) => new Social({ name: extra.name || 'Airi', emotions: { wording, ...(extra.emotions || {}) }, grudge: { enabled: true } });

test('既定 (buckets3) は今までと同じ言葉', () => {
  const a = new Social({ name: 'Airi' });
  const b = mk('buckets3');
  for (const s of [a, b]) { s.emotions.anger = 6.3; s.emotions.fear = 4.2; s.emotions.joy = 9; }
  assert.strictEqual(a.words(), b.words());
  assert.deepStrictEqual(a.emotionPhrases(), ['とてもうれしい', 'いらだっている']);
  assert.deepStrictEqual(a.emotionPhrases({ lang: 'en' }), ['very glad', 'irritated']);
  // 知らない mode も buckets3
  assert.strictEqual(EW.wordingConfig('nope').mode, 'buckets3');
  assert.deepStrictEqual(EW.wordingConfig({ mode: 'blend', top: 3, mood: true }), { mode: 'blend', top: 3, mood: true });
});

test('level6: しきい値から 10 までを 6 段に、単調', () => {
  const L = [3, 5, 8];
  let prev = -1;
  for (let v = 3; v <= 10; v += 0.25) { const lv = EW.level6(v, L); assert.ok(lv >= prev && lv >= 0 && lv <= 5); prev = lv; }
  assert.strictEqual(EW.level6(3, L), 0);
  assert.strictEqual(EW.level6(10, L), 5);
  // 表はどの感情も 6 段 × 3 つ (日本語・英語)
  for (const e of EMOTIONS) for (const T of [EW.LEVEL_JA, EW.LEVEL_EN]) { assert.strictEqual(T[e].length, 6); for (const l of T[e]) assert.strictEqual(l.length, 3); }
});

test('levels: 同じ人なら毎回同じ言い方、人が違うと言い方が分かれる', () => {
  const a1 = mk('levels', { name: 'Airi' }); const a2 = mk('levels', { name: 'Airi' });
  a1.emotions.fear = 7; a2.emotions.fear = 7;
  assert.deepStrictEqual(a1.emotionPhrases(), a2.emotionPhrases());
  const seen = new Set();
  for (const n of ['Airi', 'Akemi', 'Akira', 'Aoi', 'Arata', 'Asahi', 'Asuka', 'Aya', 'Chinatsu', 'Daiki', 'Hana', 'Haruto']) {
    const s = mk('levels', { name: n }); s.emotions.fear = 7; seen.add(s.emotionPhrases()[0]);
    assert.ok(EW.LEVEL_JA.fear[EW.level6(7, s.emoLevels('fear'))].includes(s.emotionPhrases()[0]));
  }
  assert.ok(seen.size >= 2, `言い方が1つしかない: ${[...seen]}`);
});

test('levels: 値が上がると段が上がる (buckets3 の 3 段より細かい)', () => {
  const s = mk('levels');
  const lv = [];
  for (let v = 3; v <= 10; v += 0.5) { s.emotions.anger = v; const p = s.emotionPhrases()[0]; lv.push(EW.LEVEL_JA.anger.findIndex((l) => l.includes(p))); }
  assert.deepStrictEqual([...lv].sort((x, y) => x - y), lv);
  assert.strictEqual(new Set(lv).size, 6);
});

test('numeric: 値と目盛り', () => {
  const s = mk('numeric');
  s.emotions.anger = 6.34; s.emotions.joy = 2;
  assert.deepStrictEqual(s.emotionPhrases(), ['気持ち (0〜10): 怒り 6.3/10 (0=平静, 5=はっきり不機嫌, 10=我を忘れる)']);
  assert.match(s.emotionPhrases({ lang: 'en' })[0], /^feelings \(0-10\): anger 6\.3\/10 \(0=calm/);
  s.emotions.anger = 1; // しきい値より下なら出さない (どの方式も同じ)
  assert.deepStrictEqual(s.emotionPhrases(), []);
});

test('cause: きっかけ (誰に・何を・いつ) と強さ。時間が経つと「まだ」', () => {
  const s = mk('cause');
  s.needsModel.lastTime = 10000;
  s.addGrudge('Bob', 'took_witnessed', { item: '鉄' }); // 怒りが上がる (きっかけが残る)
  s.needsModel.lastTime = 10000 + 2 * 1200; // 2分後
  s.emotions.anger = 7.5;
  const p = s.emotionPhrases()[0];
  assert.match(p, /^2分前にBobに鉄を取られて、まだ.+腹が立っている$/);
  assert.match(s.emotionPhrases({ lang: 'en' })[0], /^Bob took my 鉄 2 minutes ago, and I am still .+ angry$/);
  // 強さの副詞は値で変わる
  s.emotions.anger = 3.2; const lo = s.emotionPhrases()[0];
  s.emotions.anger = 9.9; const hi = s.emotionPhrases()[0];
  assert.notStrictEqual(lo, hi);
  assert.ok(EW.CAUSE_JA.took_witnessed && /少し|ちょっと/.test(lo) && /どうしようもなく|たまらなく/.test(hi));
});

test('cause: きっかけが薄れたら、怒りはわだかまりから (時刻なし)、ほかは levels', () => {
  const s = mk('cause');
  s.needsModel.lastTime = 0;
  s.addGrudge('Bob', 'hit');
  s.needsModel.lastTime = 200000; // ずっと後 (きっかけの量は薄れきった)
  s.emotions.anger = 6; s.emotions.fear = 6;
  const [a, f] = s.emotionPhrases();
  assert.match(a, /^Bobに殴られて、.+腹が立っている$/);
  assert.ok(EW.LEVEL_JA.fear.some((l) => l.includes(f)));
});

test('cause: 出来事ごとのきっかけ (もらった・失敗・死んだ・ストレス)', () => {
  const s = mk('cause');
  s.needsModel.lastTime = 5000;
  s.onReceived('Kenta');
  assert.strictEqual(s.causeOf('joy').kind, 'received');
  s.onActionResult('collect', false);
  assert.strictEqual(s.causeOf('anger').what, 'collect');
  s.onDeath();
  assert.strictEqual(s.causeOf('fear').kind, 'death');
  s.emotions.joy = 8;
  assert.match(s.emotionPhrases()[0], /Kentaに物をもらって、/);
  // 値の動きはきっかけの有無で変わらない
  const a = new Social({ name: 'x', grudge: { enabled: true } }); const b = mk('cause', { name: 'x' });
  for (const t of [a, b]) { t.onReceived('K'); t.onActionResult('collect', false, { repeatedFail: true }); t.onDeath(); t.onIgnored('Z'); }
  assert.deepStrictEqual(a.emotions, b.emotions);
  // 記録に残る (toJSON / fromJSON)
  const c = Social.fromJSON(JSON.parse(JSON.stringify(b.toJSON())), { name: 'x', emotions: { wording: 'cause' } });
  assert.strictEqual(c.causes.length, b.causes.length);
});

test('cause: て形の言い方がどの kind にもある', () => {
  for (const [k, f] of Object.entries(EW.CAUSE_JA)) {
    const t = f({ who: 'Bob', item: '鉄', what: 'collect' });
    assert.ok(/て$|で$/.test(t), `${k}: ${t}`);
    assert.ok(EW.CAUSE_EN[k], k);
  }
});

test('blend: 2つ目の感情を相対の強さで。mood で全体の気分', () => {
  const s = mk({ mode: 'blend', mood: true });
  s.emotions.joy = 9; s.emotions.fear = 3.5; // 喜びのしきい値 4、恐れ 3: 超えた分 5 と 0.5
  const out = s.emotionPhrases();
  assert.match(out[0], /けれど、少し不安もある$/);
  assert.match(out[1], /^全体の気分: 明るく、/);
  s.emotions.fear = 8.5;
  assert.match(s.emotionPhrases()[0], /けれど、同じくらい不安もある$/);
  assert.match(s.emotionPhrases({ lang: 'en' })[0], /, but with almost as much worry too$/);
});

test('top: 3つ以上の感情も出せる', () => {
  const s = mk({ mode: 'levels', top: 3 });
  s.emotions.joy = 6; s.emotions.anger = 5; s.emotions.fear = 4;
  assert.strictEqual(s.emotionPhrases().length, 3);
  const b = mk({ mode: 'buckets3', top: 3 });
  Object.assign(b.emotions, s.emotions);
  assert.deepStrictEqual(b.emotionPhrases(), ['うれしい', 'いらだっている', '少し不安']);
  // words の wording 引数で一時的に変えられる
  assert.ok(b.words({ wording: 'numeric', relations: false }).includes('気持ち (0〜10)'));
});

test('elapsedText と run.js の --emotion-wording', () => {
  assert.strictEqual(EW.elapsedText(600, 'ja'), 'さっき');
  assert.strictEqual(EW.elapsedText(5 * 1200, 'ja'), '5分前に');
  assert.strictEqual(EW.elapsedText(3 * 72000, 'ja'), '3時間ほど前に');
  const { emotionWordingOverrides } = require('../run');
  assert.strictEqual(emotionWordingOverrides({}), null);
  assert.deepStrictEqual(emotionWordingOverrides({ 'emotion-wording': 'cause', 'emotion-top': '3' }), { mode: 'cause', top: 3 });
  assert.throws(() => emotionWordingOverrides({ 'emotion-wording': 'xx' }));
});
