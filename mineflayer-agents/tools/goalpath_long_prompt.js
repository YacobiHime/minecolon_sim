#!/usr/bin/env node
'use strict';
// ゴール案 (2B、案 k 個) を長いプロンプト (20人・全体チャット・長い記憶・知っていること・これまでのゴール) で実際に呼び、
//   入力のトークン数・出力が切れたか (finish_reason)・文脈あふれ・削った欄 を出す (bot・Jev なし。つらい欲求を渡さないので Jev は呼ばない)。
//   LLM_BASE_URL=http://192.168.15.30:18081 node tools/goalpath_long_prompt.js [--n 8] [--ctx 8192] [--pad 1.0]
//   --ctx: GoalPath の prompt.ctxTokens (安全弁の予算)。--pad: 記憶・全体チャットの長さの倍率。--n: 同時に呼ぶ数 (人数分の並列)
const path = require('path');
const { GoalPath } = require('../src/goalpath');
const { summarizeObservation } = require('../src/observe');
const knowledge = require('../src/knowledge');
const { loadConfig } = require('../src/config');
const { Order } = require('../src/order');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const N = Number(arg('--n', 8));
const CTX = Number(arg('--ctx', 8192));
const PAD = Number(arg('--pad', 1));
const cfg = loadConfig(path.join(__dirname, '..', 'configs', 'survival_3days.json'));
const names = cfg.personas.map((p) => p.name);
const blk = (name, x, z, notable = false) => ({ name, notable, diggable: true, seen: 3, nearest: { x, y: 64, z, d: Math.round(Math.hypot(x, z)) }, positions: [] });

function scene(who, i) {
  const others = names.filter((n) => n !== who);
  const entities = others.slice(0, 12).map((n, j) => ({ kind: 'player', name: n, pos: { x: j - 6, y: 64, z: 3 }, d: Math.abs(j - 6) + 2 }));
  entities.push({ kind: 'mob', name: 'cow', pos: { x: 12, y: 64, z: 2 }, d: 12 }, { kind: 'mob', name: 'sheep', pos: { x: -9, y: 64, z: 3 }, d: 9 });
  const raw = { self: { name: who, pos: { x: 0, y: 64, z: 0 }, health: 18, food: 12, timeOfDay: 9000 + i * 100, phase: '昼', day: 1 }, heard: [], craft: { now: [], withTable: [] }, tableNearby: null,
    inventory: [{ name: 'jungle_log', count: 3 }, { name: 'jungle_planks', count: 6 }, { name: 'stick', count: 4 }, { name: 'wheat_seeds', count: 2 }],
    blocks: [blk('jungle_log', 8, -6, true), blk('grass_block', 1, 0), blk('grass', 2, 1), blk('jungle_leaves', 7, -5), blk('vine', 6, -4), blk('stone', 10, 4), blk('water', -12, 9, true), blk('coal_ore', 9, 2, true)], entities };
  const ev = Array.from({ length: Math.round(14 * PAD) }, (_, j) => `collect(jungle_log)→${j % 3 ? '成功' : '失敗'}:jungle_log を${j % 4}個手に入れた。近くで ${others[j % others.length]} が jungle_leaves を壊した`).join(' / ');
  const heard = Array.from({ length: Math.round(6 * PAD) }, (_, j) => `${others[j]}は全員に「北西の川の近くに牛がいたよ、みんなで行こう、出現地点から北西に${40 + j * 10}m」と言っていた (${j + 2}回前・昼)`).join(' ');
  const memText = `覚えている場所: ${Array.from({ length: 8 }, (_, j) => `M${j + 1}=jungle_log 西${j}北${j * 2}`).join(', ')}\nやったこと: ${ev}\n聞いた話: ${heard}`;
  const boardLines = Array.from({ length: Math.round(8 * PAD) }, (_, j) => `${others[j + 3]}${j % 3 ? '' : 'の提案'}「${j % 2 ? '石を見つけた、出現地点から東に80m、丸石がたくさん取れる' : '夜に備えてみんなで拠点の近くに松明を置こう、木炭を作れる人は手伝って'}」`);
  const boardText = `## 全体に届いた話\n${boardLines.join('\n')}\n## 取り決め\n- 共有のチェストには食べ物を入れる (Kenの提案、賛成 7)\n- 夜は拠点の近くにいる (Hanakoの提案、賛成 5)\n## 共同の目標\n- torch 16 (Ken の提案) — 今 3/16\n## 共有のチェスト\n- C1 (東3): bread 2、jungle_log 12、cobblestone 20`;
  const people = others.map((n, j) => ({ name: n, relation: j % 3 ? '知り合い' : '感じが良い。前に食べ物をくれた', seen: j < 12 ? `西${j}南3(${j + 2}m)` : null, affinity: 50 + (j % 5) * 6, talks: j % 4, d: j < 12 ? j + 2 : null }));
  const kn = knowledge.loadFacts(cfg.knowledge.file);
  const facts = () => knowledge.selectFacts(kn, { names: knowledge.namesInView({ raw }), max: 12 }).map((f) => f.text);
  const persona = cfg.personas.find((p) => p.name === who);
  return {
    persona, goalText: '', obsText: summarizeObservation(raw, { showDay: true }), raw, facts, allFacts: kn, memText,
    socialText: 'お腹が少し空いた。少し眠い。落ち着かない。この先の食べ物が心配。誰かと一緒にいたい', worst: { need: 'hunger', text: 'お腹が少し空いた' },
    peopleText: people.slice(0, 5).map((p) => `${p.name}: ${p.relation}。${p.seen ? `今は${p.seen}にいる` : '今は見えない'}`).join('\n'), people,
    places: Array.from({ length: 8 }, (_, j) => ({ id: `M${j + 1}`, kind: 'jungle_log', label: `jungle_log 西${j}北${j * 2}`, pos: { x: -j, y: 64, z: -2 * j } })),
    placeKinds: ['jungle_log', 'water', 'stone'], base: { x: 3, y: 64, z: 3 }, baseLabel: '自分の拠点 (東3南3)', needNow: () => 0.6,
    policy: '夜になる前に拠点の近くで食べ物を確保し、仲間と分け合う。知らない所へは昼のうちに行く。',
    board: { text: boardText, chests: [], shared: [] },
  };
}

async function main() {
  const baseUrl = process.env.LLM_BASE_URL || 'http://192.168.15.30:18081';
  const gcfg = { ...cfg.goalPath, select: { ...(cfg.goalPath.select || {}), enabled: true }, prompt: { ...(cfg.goalPath.prompt || {}), ctxTokens: CTX } };
  const fakeJev = { call: async () => { throw new Error('not used'); } };
  const runs = names.slice(0, N).map(async (who, i) => {
    const ev = [];
    const gp = new GoalPath({ cfg: gcfg, llmOpts: { ...cfg.decider.llm, baseUrl }, log: (e) => ev.push(e), jev: fakeJev, order: new Order({ enabled: true, seed: i + 1 }) });
    // 5回ぶんのこれまでのゴール
    for (let h = 0; h < 5; h++) gp.history.push({ kind: 'item', target: 'jungle_log', count: 4, why: '板材を作るため', resultText: '進まなかった (15判断、道筋が縮まなかった)' });
    await gp.update(scene(who, i), 1);
    return { who, ev: ev.filter((e) => e.kind === 'proposals' || e.kind === 'goal' || e.kind === 'prompt_overflow') };
  });
  const res = await Promise.all(runs);
  let ok = 0; let trunc = 0; let over = 0; const pts = [];
  for (const r of res) {
    for (const e of r.ev) {
      if (e.promptTokens) pts.push(e.promptTokens);
      if (e.truncated) trunc += 1;
      if (e.kind === 'prompt_overflow' || e.overflow) over += 1;
      console.log(`${r.who}\t${e.kind}\tok=${e.ok}\t入力 ${e.promptTokens} (見積 ${e.promptEst ?? (e.fit && e.fit.est)}, 予算 ${e.fit && e.fit.budget})\t出力 ${e.completionTokens}\t${e.finishReason || ''}\t削った: ${e.fit && e.fit.applied ? e.fit.applied.join(',') || 'なし' : '-'}\t${e.error ? e.error.slice(0, 80) : ''}${e.target ? `\t→ ${e.goalKind} ${e.target}` : ''}`);
    }
    if (r.ev.some((e) => e.kind === 'goal' && e.ok)) ok += 1;
  }
  pts.sort((a, b) => a - b);
  console.log(`\nゴールが決まった ${ok}/${res.length}、出力が切れた ${trunc}、あふれた ${over}、入力 min ${pts[0]} / p50 ${pts[Math.floor(pts.length / 2)]} / max ${pts[pts.length - 1]}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
