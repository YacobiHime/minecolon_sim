'use strict';
// 100人の persona (configs/survival_100.json、tools/gen_personas.js。2026-11-10 ユーザー決定「根拠のある人のモデルから、年齢を分散させて100人」) と
// 年齢層ごとのまとめ (tools/age_stats.js)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const gen = require('../tools/gen_personas');
const ageTool = require('../tools/age_stats');
const { personaFor } = require('../run');
const { loadConfig } = require('../src/config');
const { needsConfig, Needs } = require('../src/needs');

const ROOT = path.join(__dirname, '..');
const CFG100 = path.join(ROOT, 'configs', 'survival_100.json');
const CFG20 = path.join(ROOT, 'configs', 'survival_3days.json');
const cfg = JSON.parse(fs.readFileSync(CFG100, 'utf8'));
const base = JSON.parse(fs.readFileSync(CFG20, 'utf8'));
const ps = cfg.personas;
const KEYS = ['bravery', 'empathy', 'obedience', 'greed', 'sociability'];
const avg = (v) => v.reduce((s, x) => s + x, 0) / v.length;
const grp = (g) => ps.filter((p) => p.ageGroup === g);

test('survival_100: 生成し直すと同じ (種が固定)・personas 以外は survival_3days と同じ', () => {
  const { cfg: again } = gen.generate({ n: 100, seed: 20261110, base });
  assert.strictEqual(JSON.stringify(again, null, 2) + '\n', fs.readFileSync(CFG100, 'utf8'), 'node tools/gen_personas.js で作り直す');
  for (const k of Object.keys(base)) if (k !== 'personas' && k !== '_comment') assert.deepStrictEqual(cfg[k], base[k], k);
  assert.strictEqual(base.personas.length, 20); // 比べるための 20 人はそのまま
});

test('survival_100: 100人、名前は重ならず先頭3文字も重ならない、ほかの名前の先頭に含まれない', () => {
  assert.strictEqual(ps.length, 100);
  const names = ps.map((p) => p.name);
  assert.strictEqual(new Set(names).size, 100);
  for (const n of names) assert.match(n, /^[A-Za-z0-9_]{3,16}$/, n);
  for (const a of names) for (const b of names) if (a !== b) assert.ok(!b.startsWith(a), `${a} が ${b} の先頭`);
  assert.strictEqual(new Set(names.map((n) => n.slice(0, 3))).size, 100);
  assert.strictEqual(personaFor(cfg, 99).name, ps[99].name);
});

test('survival_100: 年齢は4層に分かれ、各層 20 人以上、残りは人口の割合 (人口推計 2024)', () => {
  const n = Object.fromEntries(gen.LAYERS.map((l) => [l.key, grp(l.key).length]));
  assert.deepStrictEqual(n, { child: 21, youth: 23, adult: 30, elder: 26 });
  for (const p of ps) {
    const l = gen.layerOf(p.age);
    assert.ok(l && l.key === p.ageGroup, `${p.name} ${p.age}`);
    assert.ok(['male', 'female'].includes(p.sex));
  }
  // 層の中の男女は人口の比に近い (老人は女性が多い)
  assert.ok(grp('elder').filter((p) => p.sex === 'female').length >= grp('elder').filter((p) => p.sex === 'male').length);
  // 先頭 20 人 (--agents 20) にも4層が混ざる
  assert.strictEqual(new Set(ps.slice(0, 20).map((p) => p.ageGroup)).size, 4);
  // 名前は生まれ年の前後 5 年以内の上位の名前
  for (const p of ps) assert.ok(Number(p.nameSource.match(/差 (\d+)年/)[1]) <= 5, `${p.name} ${p.nameSource}`);
});

test('survival_100: 性格の文・話し方・気質・欲求をみな持ち、職業・役割の語は無い', () => {
  const ROLE = /(木こり|農家|狩人|猟師|鉱夫|職人|大工|料理人|商人|[^役]屋|係|woodcutter|farmer|hunter|miner|builder|cook\b|merchant)/;
  for (const p of ps) {
    assert.ok(p.personality && p.personality_en && p.speech, p.name);
    assert.ok(p.personality.startsWith(`${p.age}歳の`), p.name);
    assert.ok(p.personality_en.startsWith(`A ${p.age}-year-old`), p.name);
    assert.doesNotMatch(p.personality, ROLE, p.name);
    assert.doesNotMatch(p.personality_en, ROLE, p.name);
    assert.doesNotMatch(p.personality, /リーダー|商人|長|係|担当|役/, p.name);
    for (const k of KEYS) assert.ok(p.temperament[k] >= 0 && p.temperament[k] <= 1, `${p.name}.${k}`);
    assert.ok(p.needs.drives.curiosity >= 0.2 && p.needs.drives.curiosity <= 0.9);
    assert.ok(Object.keys(p.needs).filter((k) => k !== '_comment').length >= 3);
  }
  assert.strictEqual(new Set(ps.map((p) => p.personality)).size, 100);
  // 子供はくだけた話し方、老人は落ち着いた話し方
  for (const p of grp('child')) assert.match(p.speech, /子供らしい/);
  for (const p of grp('elder')) assert.match(p.speech, /ゆっくり/);
  for (const k of KEYS) {
    const v = ps.map((p) => p.temperament[k]);
    assert.ok(v.some((x) => x < 0.3) && v.some((x) => x >= 0.7), k);
    assert.ok(avg(v) > 0.35 && avg(v) < 0.65, `${k} 平均 ${avg(v)}`);
  }
});

test('survival_100: 研究の年齢差が層の平均に出る (C・A は子供が低く老人が高い、N は老人が低い)', () => {
  const z = (g, t) => avg(grp(g).map((p) => p.bigFive.z[t]));
  assert.ok(z('child', 'C') < z('adult', 'C') && z('adult', 'C') < z('elder', 'C'));
  assert.ok(z('child', 'A') < z('elder', 'A'));
  assert.ok(z('elder', 'N') < z('youth', 'N'));
  const t = (g, k) => avg(grp(g).map((p) => p.temperament[k]));
  assert.ok(t('child', 'obedience') < t('elder', 'obedience'));
});

test('gen_personas: 写し方と年齢の欲求', () => {
  // 気質は Φ(重み付きの z) なので z = 0 なら 0.5
  assert.ok(Math.abs(gen.phi(0) - 0.5) < 1e-9);
  assert.ok(Math.abs(gen.phi(1.96) - 0.975) < 1e-3);
  const z0 = { E: 0, A: 0, C: 0, N: 0, O: 0 };
  // 推奨の睡眠: 子供 10h → 14h 起きている、老人 7.5h → 16.5h
  assert.strictEqual(gen.needsFor(12, z0, 0.5).sleep.fullAfter, 26250);
  assert.strictEqual(gen.needsFor(40, z0, 0.5).sleep.fullAfter, 30000);
  assert.strictEqual(gen.needsFor(70, z0, 0.5).sleep.fullAfter, 30938);
  assert.strictEqual(gen.needsFor(70, z0, 0.5).sleep.threshold, 0.5);
  assert.strictEqual(gen.needsFor(20, z0, 0.5).sleep.threshold, 0.6);
  assert.strictEqual(gen.needsFor(70, z0, 0.5).hunger.sensitivity, 0.8);
  assert.strictEqual(gen.needsFor(40, z0, 0.5).hunger, undefined);
  assert.ok(gen.needsFor(12, z0, 0.5).safety.dark > 0.25);
  assert.strictEqual(gen.needsFor(70, z0, 0.5).connection.bond, 0.45);
  assert.strictEqual(gen.needsFor(17, z0, 0.5).recognition.fullAfter, 12000);
  // 神経症傾向が高いほど不安のしきい値が低く、ストレスがたまりやすい
  const hi = gen.needsFor(40, { ...z0, N: 1.5 }, 0.5); const lo = gen.needsFor(40, { ...z0, N: -1.5 }, 0.5);
  assert.ok(hi.safety.threshold < lo.safety.threshold && hi.stress.k > lo.stress.k);
  // 年齢の平均: 25 歳以上は川本ら 2015 の年代の値、10 歳は Soto ら 2011 の差を足した値
  const bf = gen.loadData().bf;
  const n70 = gen.traitNorm(bf, 75, 'male');
  assert.ok(Math.abs(n70.C.z - (9.01 - 8.12) / 2.14) < 1e-9);
  const n10 = gen.traitNorm(bf, 10, 'male'); const n25 = gen.traitNorm(bf, 25, 'male');
  assert.ok(Math.abs(n10.C.z - (n25.C.z - 0.4)) < 1e-9);
  assert.ok(Math.abs(gen.traitNorm(bf, 14, 'female').C.z - (n25.C.z - 0.7)) < 0.2);
});

test('survival_100: persona の欲求が needs.js に渡り、年齢の差が出る', () => {
  const child = grp('child').find((p) => p.age <= 13); const elder = grp('elder')[0];
  const c = loadConfig(CFG100, { persona: child });
  const nc = new Needs({ cfg: needsConfig(c, c.persona), temperament: child.temperament });
  assert.strictEqual(nc.cfg.sleep.fullAfter, 26250);
  assert.strictEqual(nc.cfg.hunger.sensitivity, 1.1);
  assert.strictEqual(nc.drives.curiosity, child.needs.drives.curiosity);
  const e = loadConfig(CFG100, { persona: elder });
  const ne = new Needs({ cfg: needsConfig(e, e.persona), temperament: elder.temperament });
  assert.strictEqual(ne.cfg.hunger.sensitivity, 0.8);
  assert.strictEqual(ne.cfg.connection.bond, 0.45);
  assert.deepStrictEqual(ne.cfg.sleep.restActions, []); // 全員の設定 (survival_3days と同じ) は残る
});

test('age_stats: 年齢層ごとに行動・ゴール・発言をまとめ、人ごとの行を層ごとに並べる', () => {
  const mk = (name, age, sex, group, acts, goals, says) => {
    const rows = [{ ts: '2026-11-10T00:00:00Z', event: 'start', persona: { name, age, sex, ageGroup: group } }];
    acts.forEach((a, i) => rows.push({ ts: `2026-11-10T00:00:${String(10 + i).padStart(2, '0')}Z`, loop: i + 1, action: a, result: { ok: true } }));
    goals.forEach((g) => rows.push({ ts: '2026-11-10T00:01:00Z', event: 'goal_path', kind: 'goal', ok: true, goalKind: 'item', target: g[0], need: g[1] }));
    says.forEach((s) => rows.push({ ts: '2026-11-10T00:02:00Z', event: 'talk', say: s }));
    return rows;
  };
  const rowsByName = {
    Sora: mk('Sora', 12, 'male', 'child', ['explore', 'explore', 'eat'], [['bread', 'hunger']], ['ねえ、あっち行こうよ!', '(ひとりごと) 眠い']),
    Hana: mk('Hana', 11, 'female', 'child', ['explore'], [], ['これなに?']),
    Kiyoshi: mk('Kiyoshi', 80, 'male', 'elder', ['sleep', 'craft'], [['white_bed', 'sleep'], ['bread', 'hunger']], ['そろそろ休もうかのう']),
    Taro: mk('Taro', null, null, null, ['craft'], [], []),
  };
  const relations = { matrix: { Sora: { Hana: 5, Kiyoshi: null, Taro: null }, Hana: { Sora: 3, Kiyoshi: -2, Taro: null }, Kiyoshi: { Sora: null, Hana: 1, Taro: null }, Taro: { Sora: null, Hana: null, Kiyoshi: null } } };
  const st = ageTool.ageGroupStats(rowsByName, { relations, survival: { perAgent: { Sora: 1, Hana: 0, Kiyoshi: 0 } } });
  assert.deepStrictEqual(Object.keys(st.groups), ['child', 'elder', 'none']);
  const ch = st.groups.child;
  assert.strictEqual(ch.n, 2); assert.strictEqual(ch.ages, '11-12'); assert.strictEqual(ch.male, 1);
  assert.deepStrictEqual(ch.actionsPct[0], ['explore', 75]);
  assert.strictEqual(ch.talk.perPerson, 1); // 独り言は別
  assert.strictEqual(ch.talk.mutterPerPerson, 0.5);
  assert.strictEqual(ch.deathsPerPerson, 0.5);
  assert.deepStrictEqual(st.groups.elder.goals.needPct, [['sleep', 50], ['hunger', 50]]);
  assert.deepStrictEqual(st.relations['child->child'], { pairs: 2, avg: 4 });
  assert.deepStrictEqual(st.relations['child->elder'], { pairs: 1, avg: -2 });
  const text = ageTool.lines(st).join('\n');
  assert.match(text, /子供 2人 \(11-12歳、男1・女1\)/);
  assert.match(text, /老人 1人/);
  assert.match(text, /層×層の関係/);
  const brief = ageTool.briefByGroup(['Sora: 判断3', 'Hana: 判断1', 'Kiyoshi: 判断2', 'Taro: 判断1'], st);
  assert.deepStrictEqual(brief, ['子供 (2人):', '  11女 Hana: 判断1', '  12男 Sora: 判断3', '老人 (1人):', '  80男 Kiyoshi: 判断2', '年齢なし (1人):', '  Taro: 判断1']);
});
