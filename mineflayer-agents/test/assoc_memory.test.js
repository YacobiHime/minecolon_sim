'use strict';
// 連想の記憶 (src/assoc.js・memory.js の retrieval: 'associative' / store: 'dual')
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Memory, dualStrength, DUAL_DEFAULTS } = require('../src/memory');
const assoc = require('../src/assoc');
const ask = require('../src/ask');

function mk(opts = {}) {
  const m = new Memory({ retrieval: 'associative', store: 'dual', me: 'Aoi', limits: { promptItems: 20, promptPlaces: 6 }, version: '1.20.1', ...opts });
  m.origin = { x: 0, y: 64, z: 0 };
  return m;
}
// 1判断ぶん進める (ゲームの時刻も dt tick 進める)。raw を返す
function step(m, { pos = { x: 0, y: 64, z: 0 }, people = [], tod = 3000, dt = 180, blocks = [], heard = [] } = {}) {
  m.tick += 1;
  m.gameNow = (m.gameNow || 0) + dt;
  const raw = { self: { pos, timeOfDay: tod }, people, blocks, entities: [], heard };
  m.observeNow({ raw, emotions: { fear: 3 } });
  return raw;
}
function filler(m, n, { pos = (i) => ({ x: i * 3, y: 64, z: 0 }), people = [] } = {}) {
  for (let i = 0; i < n; i += 1) {
    step(m, { pos: pos(i), people });
    m.noteEvent('explore', ['east', 'west', 'north', 'south'][i % 4], true, `進んだ ${i}`);
    m.setRecentImportance(0.2, m.tick);
  }
}

test('2つの貯蔵の強さ: 速い方 500 tick・遅い方 45 日、大事さで長く残る割合が増える', () => {
  const c = DUAL_DEFAULTS;
  assert.strictEqual(dualStrength(0, 0.5, 0.3), 1);
  // 大事さ 0.5 (w = 0.3): 500 tick で 0.7×0.5 + 0.3×(ほぼ1) ≈ 0.65
  assert.ok(Math.abs(dualStrength(500, 0.5, 0.3) - (0.7 * 0.5 + 0.3 * Math.pow(0.5, 500 / c.h2))) < 1e-9);
  // 1日 (24000 tick) 後: 速い方はほぼ 0、遅い方の割合 w が残る
  assert.ok(Math.abs(dualStrength(24000, 0.5, 0.3) - 0.3) < 0.01);
  assert.ok(dualStrength(24000, 1, 0.3) > dualStrength(24000, 0.5, 0.3));
  // 大事さ 0 は速い方だけ (数千 tick で忘れる)
  assert.ok(dualStrength(3000, 0, 0.3) < 0.08);
  // 聞いた話は w0 = 0.2
  assert.ok(dualStrength(24000, 0.5, c.heardW0) < dualStrength(24000, 0.5, c.w0));
});

test('2つの貯蔵: 忘れ方は判断の回数ではなく経過 tick で決まる', () => {
  const m = mk();
  step(m);
  const e = m.noteEvent('look_around', '', true, '見回した', 0);
  const k = m.noteKnowledge('Yui', 'craft:crafting_table', '板材4つで作業台', { imp: 0.8 });
  // 判断は 1 回だけだが、ゲームの時間は 5000 tick 進んだ
  step(m, { dt: 5000 });
  assert.ok(m.strength(e) < 0.08, 'どうでもいい出来事は数千 tick で弱まる');
  assert.ok(m.strength(k) > 0.4, '教わったこと (大事さ 0.8) は残る');
  m.forget();
  assert.ok(!m.events.includes(e));
  assert.ok(m.knowledge.includes(k));
  assert.ok(!m.graph.eps.some((x) => x.kind === 'event' && x.text === '見回した'), 'グラフからも忘れる');
  // 判断が多くても時間が進んでいなければ忘れない
  const m2 = mk();
  step(m2);
  const e2 = m2.noteEvent('look_around', '', true, '見回した', 0.1);
  for (let i = 0; i < 30; i += 1) step(m2, { dt: 10 });
  assert.ok(m2.strength(e2) > 0.5);
});

test('書き込み: 出来事は関わる人・場所・物・時刻の点につながる。聞いた話は話し手と中身の名前に', () => {
  const m = mk();
  step(m, { pos: { x: 100, y: 64, z: 100 }, people: [{ name: 'Masaru', d: 4 }, { name: 'Far', d: 30 }], tod: 15000 });
  m.noteEvent('collect', 'oak_log', true, 'oak_logを3個拾った');
  const ep = m.graph.eps[m.graph.eps.length - 1];
  const ids = ep.links.map((l) => l.id);
  assert.ok(ids.includes('area:6,6'));
  assert.ok(ids.includes('item:oak_log') && ids.includes('item:*_log'));
  assert.ok(ids.includes('person:Masaru'), '近く (8m 以内) にいた人は一緒にいた人として');
  assert.ok(!ids.includes('person:Far'), '遠くの人はつながない');
  assert.ok(ids.includes('time:夜'));
  assert.strictEqual(ep.emo, 'fear');
  m.noteHeard('Yui', 'Masaruが作業台の近くに原木があるって');
  const h = m.graph.eps[m.graph.eps.length - 1];
  const hid = h.links.map((l) => l.id);
  assert.ok(hid.includes('person:Yui') && hid.includes('person:Masaru') && hid.includes('item:crafting_table') && hid.includes('item:*_log'));
  // 大事さは Jev の remember で上書き (記録の入り口と同じ)
  m.setRecentImportance(0.9, m.tick);
  assert.strictEqual(h.imp, 0.9);
});

test('部分観測: 見ていない出来事はグラフに入らない (見えた人・聞いた話・自分の出来事だけ)', () => {
  const m = mk();
  step(m, { people: [{ name: 'Masaru', d: 3 }] });
  m.noteEvent('craft', 'stick', true, '棒を作った');
  // Hiroshi は一度も見ていない・聞いていない
  assert.ok(!m.graph.persons.has('Hiroshi'));
  assert.strictEqual((m.graph.inv.get('person:Hiroshi') || []).length, 0);
  const raw = step(m, { people: [{ name: 'Hiroshi', d: 3 }] });
  m.setCues({ raw, social: { relations: {} } });
  m.toPromptText(raw.self.pos);
  assert.deepStrictEqual(m.lastSelection.near, { n: 0, recalled: 0 }, 'Hiroshi に関わる記憶は無い');
});

// 前に Masaru に囲いを壊された (大事さはふつう 0.4) あと、50 判断ぶんほかのことをした
function masaruWorld(opts) {
  const m = mk(opts);
  step(m, { pos: { x: 100, y: 64, z: 100 }, people: [{ name: 'Masaru', d: 4 }] });
  m.noteEvent('wronged', 'Masaru', false, 'Masaruに囲いを壊された', 0.4);
  for (let i = 0; i < 40; i += 1) {
    step(m, { pos: { x: i * 3, y: 64, z: 0 }, people: [{ name: 'Yui', d: 3 }] });
    m.noteEvent('craft', `item${i}`, true, `作った ${i}`);
    m.setRecentImportance(0.5, m.tick);
  }
  for (let i = 0; i < 10; i += 1) { step(m); m.noteHeard('Yui', `いい天気だね ${i}`); m.setRecentImportance(0.5, m.tick); }
  return m;
}

test('連想: Masaru が見える → 前に Masaru に囲いを壊された出来事が上位に来る (古くても)', () => {
  const m = masaruWorld();
  const raw = step(m, { people: [{ name: 'Masaru', d: 5 }] });
  m.setCues({ raw, social: { relations: { Masaru: { affinity: 40 } } } });
  const rec = m.assocRecall();
  assert.strictEqual(rec.ranked[0].ep.text, 'Masaruに囲いを壊された');
  assert.strictEqual(rec.ranked[0].why.type, 'person');
  const text = m.toPromptText(raw.self.pos);
  assert.match(text, /されたこと: 〔Masaruを見て〕Masaruに囲いを壊された/);
  assert.deepStrictEqual(m.lastSelection.near, { n: 1, recalled: 1 });
  const st = m.toStateEn(raw.self.pos);
  assert.ok(st.done_to_me.some((s) => /Masaruに囲いを壊された.*\[recalled: you see Masaru\]/.test(s)));
  // 今までの選び方 (legacy) では渡らない: 古くて、新しい出来事に押し出される
  const L = masaruWorld({ retrieval: 'legacy', store: 'single' });
  const lraw = step(L, { people: [{ name: 'Masaru', d: 5 }] });
  L.setCues({ raw: lraw, social: { relations: {} } });
  assert.ok(!/Masaru/.test(L.toPromptText(lraw.self.pos)));
  assert.deepStrictEqual(L.lastSelection.near, { n: 1, recalled: 0 });
});

test('連想: 作業台が欲しい → 作り方の線 (作業台 ← 板材 ← 原木) で原木の場所と出来事を思い出す', () => {
  const m = mk();
  step(m, { pos: { x: 300, y: 64, z: -200 } });
  m.notePlace('oak_log', { x: 300, y: 64, z: -200 });
  m.noteEvent('collect', 'oak_log', true, 'oak_logを2個拾った');
  for (let i = 0; i < 12; i += 1) { step(m, { pos: { x: i * 9, y: 64, z: 5 } }); m.notePlace(['sand', 'gravel', 'water', 'clay', 'pumpkin', 'cobblestone'][i % 6], { x: i * 9, y: 64, z: 5 }); m.noteEvent('explore', 'east', true, `東へ ${i}`); }
  const raw = step(m);
  m.setCues({ raw, goal: { kind: 'item', target: 'crafting_table' }, social: { relations: {} } });
  const pl = m.placesForPrompt(raw.self.pos);
  const log = pl.find((p) => p.kind === 'oak_log');
  assert.ok(log, '遠くても原木の場所が一覧に入る');
  assert.strictEqual(log.why.type, 'goal');
  assert.match(m.toPromptText(raw.self.pos, { places: pl }), /〔作業台が要るので→原木〕M\d=oak_log/);
  const rec = m.assocRecall();
  const ev = rec.ranked.find((x) => x.ep.action === 'collect');
  assert.strictEqual(ev.why.type, 'goal');
  assert.ok(ev.why.hop >= 2, `段数 ${ev.why.hop}`);
  // 近い順 (legacy) では入らない
  const L = mk({ retrieval: 'legacy' });
  L.places = m.places;
  assert.ok(!L.placesForPrompt(raw.self.pos).some((p) => p.kind === 'oak_log'));
});

test('連想: 夜で不安 → 明かり・囲い・仲の良い人の記憶', () => {
  const m = mk();
  step(m, { pos: { x: 50, y: 64, z: 50 } });
  m.noteEvent('place', 'torch', true, '松明を置いた');
  step(m, { pos: { x: 60, y: 64, z: 50 } });
  m.noteEvent('enclose', 'here_3x3', true, 'oak_fenceで今いた所の周りを囲った');
  step(m, { pos: { x: 70, y: 64, z: 50 } });
  m.noteHeard('Yui', '困ったら呼んでね');
  step(m, { pos: { x: 70, y: 64, z: 50 } });
  m.noteHeard('Kenta', 'あっちに羊がいた');
  filler(m, 30);
  const raw = step(m, { pos: { x: -200, y: 64, z: -200 }, tod: 16000 });
  m.setCues({ raw, worst: { need: 'safety' }, social: { relations: { Yui: { affinity: 82 }, Kenta: { affinity: 50 } } } });
  const rec = m.assocRecall();
  const top = rec.ranked.slice(0, 5).map((x) => x.ep.text);
  assert.ok(top.includes('松明を置いた'), JSON.stringify(top));
  assert.ok(top.some((t) => /囲った/.test(t)), JSON.stringify(top));
  assert.ok(top.includes('困ったら呼んでね'), '仲の良い人 (好感 58 以上) の話');
  assert.ok(!top.includes('あっちに羊がいた'), '仲の良くない人の話は上に来ない');
  const yui = rec.ranked.find((x) => x.ep.text === '困ったら呼んでね');
  assert.strictEqual(yui.why.type, 'need');
  assert.strictEqual(yui.why.via, 'person:Yui');
  assert.match(m.toPromptText(raw.self.pos), /〔不安で→Yui〕Yuiは「困ったら呼んでね」/);
});

test('聞かれて答える: 「どこで寝ればいい?」→ ベッドの場所・村の話 (質問の語から連想)', () => {
  const m = mk();
  step(m, { pos: { x: 90, y: 64, z: 95 } });
  m.notePlace('white_bed', { x: 90, y: 64, z: 95 }, { imp: 0.8 });
  step(m);
  m.noteHeard('Takeshi', '村にベッドがあったよ');
  filler(m, 20);
  const raw = step(m);
  m.setCues({ raw, social: { relations: {} } });
  const mems = ask.relevantMemories(m, 'どこで寝ればいい?', { from: 'Yui' });
  assert.ok(mems.some((x) => x.kind === 'place' && /white_bed/.test(x.text)), JSON.stringify(mems));
  assert.ok(mems.some((x) => /村にベッド/.test(x.text)), JSON.stringify(mems));
  assert.ok(mems.every((x) => x.why), '思い出した手がかりの語');
  assert.ok(!mems.some((x) => /進んだ/.test(x.text)), '関係のない最近の出来事は入れない');
  // 手がかりの無い質問は「分からない」(空)
  assert.deepStrictEqual(ask.relevantMemories(m, 'ダイヤモンドはどこ?', { from: 'Yui' }), []);
});

test('失敗のメモ: 空振りした場所は、その場所を思い出したときだけ戻る (禁止はしない)', () => {
  const m = mk();
  step(m, { pos: { x: 300, y: 64, z: -200 } });
  m.notePlace('oak_log', { x: 300, y: 64, z: -200 });
  m.forgetPlace('oak_log', { x: 300, y: 64, z: -200 });
  filler(m, 10);
  // 別の所では出ない
  let raw = step(m, { pos: { x: 0, y: 64, z: 0 } });
  m.setCues({ raw, social: { relations: {} } });
  assert.ok(!/取りに来たら無かった/.test(m.toPromptText(raw.self.pos)));
  // その場所に来ると出る
  raw = step(m, { pos: { x: 302, y: 64, z: -198 } });
  m.setCues({ raw, social: { relations: {} } });
  assert.match(m.toPromptText(raw.self.pos), /気をつけること: 〔ここで〕前にoak_logを取りに来たら無かった/);
  assert.strictEqual(m.lastSelection.note, 1);
  // 自分で掘ってなくなったときはメモを付けない
  const m2 = mk();
  step(m2);
  m2.notePlace('oak_log', { x: 5, y: 64, z: 5 });
  m2.forgetPlace('oak_log', { x: 5, y: 64, z: 5 }, 12, 'dug_by_me');
  assert.strictEqual(m2.graph.noteCount(), 0);
  // failureNotes: false なら付けない
  const m3 = mk({ failureNotes: false });
  step(m3);
  m3.forgetPlace('oak_log', { x: 5, y: 64, z: 5 });
  assert.strictEqual(m3.graph.noteCount(), 0);
});

test('失敗のメモ: 人に付いたメモ (されたこと) はその人を思い出したときだけ。同じ出来事を選んだら重ねて出さない', () => {
  const m = mk({ assoc: { budget: { llm: { items: 2, must: 2, notes: 2, maxChars: 2000 } } } });
  step(m, { pos: { x: 100, y: 64, z: 100 } });
  m.noteEvent('wronged', 'Masaru', false, 'Masaruに物を取られた', 0.8);
  filler(m, 10);
  let raw = step(m, { people: [{ name: 'Masaru', d: 4 }] });
  m.setCues({ raw, social: { relations: {} } });
  // 枠 2 は最新のやったことで埋まる → 出来事は入らないが、Masaru のメモが戻る
  const t = m.toPromptText(raw.self.pos);
  assert.match(t, /気をつけること: 〔Masaruを見て〕Masaruに物を取られた/);
  raw = step(m, { people: [{ name: 'Yui', d: 4 }] });
  m.setCues({ raw, social: { relations: {} } });
  assert.ok(!/Masaru/.test(m.toPromptText(raw.self.pos)));
});

test('同じ選び方で件数だけ変わる (LLM・Jev・答え)、記憶の部分の長さに上限', () => {
  const m = mk({ assoc: { budget: { llm: { items: 10, maxChars: 300 } } } });
  for (let i = 0; i < 30; i += 1) { step(m, { people: [{ name: 'Yui', d: 3 }] }); m.noteHeard('Yui', `とても長い話をしているところ その${i} `.repeat(3)); m.noteEvent('craft', `stick${i}`, true, `棒を作った ${i}`); }
  const raw = step(m, { people: [{ name: 'Yui', d: 3 }] });
  m.setCues({ raw, social: { relations: {} } });
  const text = m.toPromptText(raw.self.pos);
  assert.ok(text.length <= 300 || m.lastSelection.event + m.lastSelection.heard <= 2, `長さ ${text.length}`);
  assert.ok(m.lastSelection.chars === text.length);
  const st = m.toStateEn(raw.self.pos);
  assert.ok(JSON.stringify(st).length <= 1100 + 400);
  assert.ok(m.lastSelectionJev && m.lastSelectionJev.mode === 'associative');
});

test('保存と復元: グラフ・メモ・時刻の換算が戻る。古い形 (graph が無い) のファイルも読める', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assoc-'));
  const f = path.join(dir, 'Aoi.json');
  const m = Memory.load(f, { retrieval: 'associative', store: 'dual', me: 'Aoi', limits: { promptItems: 20 } });
  step(m, { pos: { x: 100, y: 64, z: 100 }, people: [{ name: 'Masaru', d: 4 }] });
  const e = m.noteEvent('wronged', 'Masaru', false, 'Masaruに殴られた', 0.8);
  e.en = 'Masaru hit me';
  m.forgetPlace('oak_log', { x: 100, y: 64, z: 100 });
  m.save();
  const m2 = Memory.load(f, { retrieval: 'associative', store: 'dual', me: 'Aoi', limits: { promptItems: 20 } });
  assert.strictEqual(m2.graph.eps.length, m.graph.eps.length);
  assert.strictEqual(m2.graph.eps[0].en, 'Masaru hit me', '後から付いた英語の文も保存される');
  assert.ok((m2.graph.inv.get('person:Masaru') || []).length >= 1, '索引も作り直す');
  assert.strictEqual(m2.graph.noteCount(), m.graph.noteCount());
  assert.deepStrictEqual(m2.loopGame, m.loopGame);
  // 古い形: グラフの無いファイル
  const old = path.join(dir, 'Old.json');
  fs.writeFileSync(old, JSON.stringify({ tick: 50, places: [], events: [{ t: 10, action: 'collect', arg: 'oak_log', ok: true, msg: 'oak_logを拾った', imp: 0.5 }],
    heard: [{ t: 20, from: 'Yui', text: 'Masaruが作業台を置いた', imp: 0.3 }], knowledge: [{ t: 30, from: 'Ken', about: 'craft:crafting_table', text: '板材4つ', imp: 0.8, at: '朝' }], extra: { social: {} } }));
  const o = Memory.load(old, { retrieval: 'associative', store: 'dual', limits: { promptItems: 20 } });
  assert.strictEqual(o.graph.eps.length, 3);
  assert.ok(o.graph.eps.every((x) => x.imported));
  assert.ok((o.graph.inv.get('item:crafting_table') || []).length >= 2);
  // legacy の設定で古いファイルを読んでも今までどおり
  const ol = Memory.load(old, { limits: { promptItems: 20 } });
  assert.strictEqual(ol.events.length, 1);
  assert.strictEqual(ol.retrieval, 'legacy');
});

test('legacy に切り替えたら今と同じ動き (文・場所の一覧・選び方が変わらない)', () => {
  const build = (opts) => {
    const m = new Memory({ limits: { promptItems: 12, promptPlaces: 4 }, ...opts });
    m.origin = { x: 0, y: 64, z: 0 };
    for (let i = 0; i < 25; i += 1) {
      m.tick += 1; m.gameNow = m.tick * 200;
      if (opts.retrieval) m.observeNow({ raw: { self: { pos: { x: i, y: 64, z: 0 }, timeOfDay: 1000 }, people: [{ name: 'Yui', d: 2 }] } });
      m.noteEvent('explore', 'east', i % 3 !== 0, `東へ ${i}`);
      if (i % 4 === 0) m.noteHeard('Yui', `話 ${i}`);
      if (i % 5 === 0) m.notePlace(['oak_log', 'water', 'sand'][i % 3], { x: i * 10, y: 64, z: 0 });
      m.setRecentImportance((i % 4) / 4, m.tick);
      m.forget();
    }
    return m;
  };
  const a = build({});
  const b = build({ retrieval: 'legacy', store: 'single' });
  const here = { x: 3, y: 64, z: 2 };
  b.setCues({ raw: { self: { pos: here, timeOfDay: 1000 }, people: [{ name: 'Yui', d: 2 }], blocks: [], entities: [], heard: [] }, social: { relations: {} } });
  assert.strictEqual(b.toPromptText(here), a.toPromptText(here));
  assert.deepStrictEqual(b.toStateEn(here), a.toStateEn(here));
  assert.deepStrictEqual(b.placesForPrompt(here), a.placesForPrompt(here));
  assert.deepStrictEqual(b.events, a.events);
  // 集計の欄だけ増える (近くの人の記憶が渡ったか)
  assert.ok(b.lastSelection.near && b.lastSelection.mode === 'legacy');
  assert.strictEqual(a.lastSelection.near, undefined);
});

test('埋め込みの差し込み口: relevance.embedding は今は null だけ (入れたら止める)', () => {
  assert.throws(() => mk({ relevance: { embedding: 'text-embedding-3-small' } }), /まだ実装していない/);
  const m = mk({ relevance: { embedding: null, embeddingWeight: 0.5 } });
  // 関数を差し込めば得点に入る (将来用。今は何も入れていない)
  step(m);
  m.noteEvent('craft', 'stick', true, 'a');
  m.noteEvent('craft', 'torch', true, 'b');
  m.embedRelevance = (ep) => (ep.arg === 'stick' ? 1 : 0);
  const raw = step(m);
  m.setCues({ raw, social: { relations: {} } });
  const rec = m.assocRecall();
  assert.strictEqual(rec.ranked[0].ep.arg, 'stick');
});

test('手がかり: ゴール・道筋の次・欲求・夜・聞こえた話・見えている物', () => {
  const raw = { self: { pos: { x: 0, y: 64, z: 0 }, timeOfDay: 14000 }, people: [{ name: 'Masaru', d: 5 }, { name: 'Far', d: 40 }],
    blocks: [{ name: 'oak_log', notable: true, d: 3 }, { name: 'grass', notable: false, d: 1 }], entities: [{ kind: 'hostile', name: 'zombie', d: 10 }],
    heard: [{ from: 'Yui', text: '松明を置いてね' }] };
  const c = assoc.cuesFrom({ raw, goal: { kind: 'state', target: 'lit_base' }, next: { item: 'coal' }, worst: { need: 'safety' }, social: { relations: { Masaru: { affinity: 20, grudge: { v: 0.6 } } } } });
  const by = Object.fromEntries(c.list.map((x) => [x.node, x]));
  assert.ok(by['area:0,0'] && by['person:Masaru'] && !by['person:Far']);
  assert.ok(by['person:Masaru'].w > 1, 'わだかまりのある人は重い');
  assert.ok(by['item:oak_log'] && by['item:zombie'] && !by['item:grass']);
  assert.ok(by['item:torch'], 'lit_base → 松明 (と聞こえた話の松明は1つにまとめる)');
  assert.ok(by['item:coal'] && by['need:safety'] && by['time:夜'] && by['person:Yui']);
  assert.deepStrictEqual(c.near, ['Masaru']);
});

test('所有の知識は出来事としてグラフに入る (持ち主・物・場所)', () => {
  const m = mk();
  m.extra.owned = { 'minecraft:overworld|5,64,5': { dim: 'minecraft:overworld', pos: [5, 64, 5], block: 'crafting_table', owner: 'Tatsuya', kind: 'personal', source: 'seen', t: 1, imp: 0.6, status: 'present' } };
  step(m);
  const ep = m.graph.eps.find((x) => x.kind === 'owned');
  assert.ok(ep && /crafting_table\(5,64,5\)はTatsuyaの物/.test(ep.text), ep && ep.text);
  assert.ok(ep.links.some((l) => l.id === 'person:Tatsuya'));
  m.extra.owned['minecraft:overworld|5,64,5'].status = 'taken';
  step(m);
  assert.strictEqual(m.graph.eps.filter((x) => x.kind === 'owned').length, 1);
  assert.match(ep.text, /取られた/);
  const raw = step(m, { people: [{ name: 'Tatsuya', d: 3 }] });
  m.setCues({ raw, social: { relations: {} } });
  assert.match(m.toPromptText(raw.self.pos), /持ち主: 〔Tatsuyaを見て〕crafting_table/);
});
