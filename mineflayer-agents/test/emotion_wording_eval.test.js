'use strict';
// tools/emotion_wording_eval.js の、LLM を呼ばない部分 (場面 → プロンプト・数え方)
const test = require('node:test');
const assert = require('node:assert');
const E = require('../tools/emotion_wording_eval');
const { LLMDecider } = require('../src/deciders/llm');
const { resolveDecision } = require('../src/actions');

test('場面の一覧: 10 個、どれも行動の一覧と人がそろっている', () => {
  const sits = E.loadSituations();
  assert.strictEqual(sits.length, 10);
  assert.strictEqual(new Set(sits.map((s) => s.persona.name)).size, 10); // 違う人
  for (const s of sits) {
    const acts = E.buildActions(s.actions, s.memText);
    assert.ok(acts.length >= 5, s.id);
    for (const a of acts) if (a.argType === 'choice') assert.ok(a.choices.length, `${s.id} ${a.name}`);
    assert.ok(resolveDecision(acts, 'explore', 'north_near').ok);
  }
});

test('作り方ごとにプロンプトの感情の言葉だけが変わる', () => {
  const sit = E.loadSituations().find((s) => s.id === 'toru_snatched');
  const texts = {};
  for (const mode of Object.keys(E.MODE_CFG)) {
    const st = E.socialTextFor(sit, 'anger', 7, mode);
    assert.ok(st.text.startsWith(sit.body));
    texts[mode] = st;
  }
  assert.ok(texts.numeric.emotionPhrases[0].includes('怒り 7.0/10'));
  assert.match(texts.cause.emotionPhrases.join('。'), /3分前に自分が掘ったoak_saplingをChinatsuに先に拾われて、まだ.+腹が立っている/);
  assert.match(texts.blend.emotionPhrases[0], /けれど、/);
  // しきい値より下ではどの作り方でも怒りの言葉は出ない
  for (const mode of Object.keys(E.MODE_CFG)) assert.ok(!/怒|腹|いら|むっ/.test(E.socialTextFor(sit, 'anger', 2, mode).emotionPhrases.join('')), mode);
  // 本番と同じ形のプロンプト (prompt.js)
  const msgs = new LLMDecider({ think: true }).buildMessages(E.actCtx(sit, texts.cause.text));
  assert.ok(msgs[1].content.includes('## 気持ちと人間関係') && msgs[1].content.includes('- complain:'));
  assert.ok(E.talkCtx(sit, 'x').nearText.includes('Daiki'));
});

test('値は感情の言葉だけを動かす (Social の値・ほかの感情は記録の値)', () => {
  const sit = E.loadSituations().find((s) => s.id === 'kanon_skeleton');
  const s = E.socialFor(sit, 'fear', 9, 'cause');
  assert.strictEqual(s.emotions.fear, 9);
  assert.strictEqual(s.emotions.joy, sit.logEmotions.joy);
  assert.strictEqual(s.emotions.surprise, 0);
});

test('行動の分類', () => {
  const ppl = new Set(['Bob']);
  assert.strictEqual(E.actionCat('follow', 'Bob', ppl), 'approach');
  assert.strictEqual(E.actionCat('go_to', 'Bob', ppl), 'approach');
  assert.strictEqual(E.actionCat('go_to', 'M3', ppl), 'work');
  assert.strictEqual(E.actionCat('avoid_person', 'Bob', ppl), 'avoid');
  assert.strictEqual(E.actionCat('flee', 'away', ppl), 'avoid');
  assert.strictEqual(E.actionCat('demand_back', 'Bob:x', ppl), 'confront');
  assert.strictEqual(E.actionCat('hit_person', 'Bob', ppl), 'fight');
  assert.strictEqual(E.actionCat('attack', 'zombie', ppl), 'fight');
  assert.strictEqual(E.actionCat('attack', 'sheep', ppl), 'work');
  assert.strictEqual(E.actionCat('broadcast', '', ppl), 'talk');
});

test('数え方: Spearman・distinct-2・jaccard・感情語', () => {
  assert.strictEqual(E.spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.strictEqual(E.spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1);
  assert.deepStrictEqual(E.rank([5, 1, 5]), [2.5, 1, 2.5]);
  assert.strictEqual(E.distinct2(['ああ', 'ああ']), 0.5);
  assert.strictEqual(E.jaccard('こわいよ', 'こわいよ'), 1);
  assert.strictEqual(E.lexWord('ちょっと怖いね', 'fear'), '怖');
  assert.strictEqual(E.lexWord('木を探す', 'fear'), null);
});

test('logprobs から 0〜9 の期待値', () => {
  const content = [{ token: '{"', logprob: 0 }, { token: 'level', logprob: 0 }, { token: '":"', logprob: 0 },
    { token: '6', logprob: Math.log(0.5), top_logprobs: [{ token: '6', logprob: Math.log(0.5) }, { token: '4', logprob: Math.log(0.5) }, { token: 'x', logprob: Math.log(0.1) }] }];
  assert.strictEqual(E.digitExpectation(content), 5);
  assert.strictEqual(E.digitExpectation([{ token: 'a', logprob: 0 }]), null);
});

test('場面ごとの切片つきロジスティック回帰の傾き', () => {
  // 値が上がるほど y=1 が増える (2つの場面で切片が違う)
  const rows = [];
  for (const g of ['a', 'b']) for (let x = 0; x <= 10; x++) for (let k = 0; k < 10; k++) {
    const p = 1 / (1 + Math.exp(-((g === 'a' ? -3 : -1) + 0.5 * x)));
    rows.push({ g, x, y: (k + 0.5) / 10 < p ? 1 : 0 });
  }
  const fit = E.logisticFE(rows);
  assert.ok(fit.slope > 0.3 && fit.slope < 0.8, String(fit.slope));
  assert.ok(fit.se > 0);
  assert.strictEqual(E.logisticFE([{ g: 'a', x: 1, y: 0 }, { g: 'a', x: 2, y: 0 }]), null); // ぜんぶ同じなら出さない
});

test('analyze と report (作った記録で)', () => {
  const rows = []; const judged = [];
  for (const mode of ['buckets3', 'cause']) for (const sit of ['s1', 's2']) for (let v = 0; v <= 10; v++) for (let rep = 0; rep < 2; rep++) {
    const key = `act|${sit}|anger|${v}|${mode}|${rep}`;
    const hit = mode === 'cause' && v >= 6 && rep === 0;
    rows.push({ key, task: 'act', sit, persona: sit, emo: 'anger', v, mode, rep, parseOk: true, action: hit ? 'complain' : 'collect', arg: 'x', cat2: hit ? 'confront' : 'work',
      think: v >= 5 ? '腹が立つ' : '木を切る', say: '', emotionPhrases: v >= 3 ? [`p${v}`] : [], socialChars: 100, promptTokens: 2000, completionTokens: 40 });
    judged.push({ key, judged: mode === 'cause' ? v * 0.8 : 2 });
  }
  const sum = E.analyze(rows, judged, { modes: ['buckets3', 'cause'], emos: ['anger'] });
  assert.ok(sum.grade['act|anger|cause'].rho > 0.9);
  assert.ok(sum.behaviour['act|anger|cause'].cats.confront.slope > 0);
  assert.strictEqual(sum.behaviour['act|anger|buckets3'].cats.confront.slope, null);
  const md = E.report(sum, rows, { modes: ['buckets3', 'cause'], emos: ['anger'] });
  assert.ok(md.includes('| 怒り | cause |'));
});
