#!/usr/bin/env node
'use strict';
// 感情の言葉の作り方 (src/emotion_words.js) を、Minecraft を動かさずに比べる (2026-11-17)。
//   場面: tools/emotion_wording_situations.json (本番の記録の判断の場面 10 個。観察・記憶・ゴールの道筋・体と心の言葉は記録のまま。
//         人間関係・わだかまり・感情のきっかけ・行動の一覧は記録から起こした。行動の説明はコードと同じ文)。
//   1つの場面で、1つの感情 (怒り・恐れ・喜び・悲しみ) の値だけを 0〜10 に動かし (ほかの感情は記録のその時の値。驚きは 0)、言葉の作り方ごとにプロンプトを作って luna に聞く。
//   act : 行動を選ぶプロンプト (src/prompt.js、think あり。decider llm と同じ形)。選んだ行動・考え・発言
//   talk: 近くの人への発言 (src/talker.js の talk と同じ形)
// 測るもの (analyze):
//   1. 段階のつき方: luna を採点者にして (reasoning none・{"level":"0〜9"} の構造化出力・logprobs の上位5つから期待値、judgeReps 回の平均)
//      出力の文から読み取れるその感情の強さを出し、入力の値との Spearman の ρ・値を上げたのに下がった所の割合
//   2. 言い方のばらつき: distinct-2 (文字の2連続)・違う人どうしの言い方がほぼ同じ割合・いちばん多い感情語の割合 (例: 恐れの「怖い」)
//   3. 行動への効き方: 値ごとの行動の分類 (近づく・離れる・文句・殴る/戦う・話す・作業) の割合を、場面ごとの切片つきロジスティック回帰の傾き (値 1 あたり) で
//   4. プロンプトの長さと費用
// 使い方:
//   node tools/emotion_wording_eval.js run --out DIR [--modes buckets3,levels,numeric,cause,blend] [--emotions anger,fear,joy,sadness]
//        [--values 0,1,...,10] [--reps 3] [--tasks act,talk] [--situations id,...] [--concurrency 24] [--max-usd 30] [--dry]
//   node tools/emotion_wording_eval.js judge --out DIR [--judge-reps 2] [--concurrency 32]
//   node tools/emotion_wording_eval.js analyze --out DIR      (DIR/report.md と DIR/summary.json)
// 途中で止めても、同じ DIR でもう一度動かせば続きから (済んだものは飛ばす)。API キーは表示しない (llm_provider.js)。
const fs = require('fs');
const path = require('path');
const { Social, EMO_BASE } = require('../src/social');
const EW = require('../src/emotion_words');
const { resolveDecision } = require('../src/actions');
const { LLMDecider, LLM_USAGE, chatUrl } = require('../src/deciders/llm');
const { Talker } = require('../src/talker');
const { llmOptsFor, loadProviderKey, costOf, redact } = require('../src/llm_provider');

const SITUATIONS = path.join(__dirname, 'emotion_wording_situations.json');
// 比べる作り方 (名前 → social.emotions.wording)
const MODE_CFG = { buckets3: 'buckets3', levels: 'levels', numeric: 'numeric', cause: 'cause', blend: { mode: 'blend', mood: true } };
const EMO_JA = { joy: '喜び', sadness: '悲しみ', anger: '怒り', fear: '恐れ', disgust: '嫌悪', surprise: '驚き' };
const NOW = 100000; // 場面の「今」のゲームの時刻 (tick)

// 行動の説明 (src/actions.js・actions_more.js・conflict.js と同じ文)
const ACTION_DESC = {
  collect: '見えているブロックを掘って拾う (近いものから数個)', go_to: '見えている物・覚えている場所(M番号)・人のところへ歩く', explore: 'その方角へ20ブロックほど歩いて新しい場所を見る',
  follow: '人について行く (30秒ほど)', give: '人の近くへ行って持ち物を投げ渡す', call: '人を呼ぶ (「来て」と自分の場所を言う)', craft: '作る (手元で作れるもの)', place: '持っているブロックを置く',
  eat: '食べる', pick_up: '落ちている物の所へ歩いて拾う', attack: '見えている敵か動物を攻撃する (持っている一番強い武器で)', flee: '敵から離れる方へ走る',
  ask: '近くの人にやり方を聞く (答えを待つ)', search: 'その方角を探す', avoid_person: 'その人から離れる', complain: 'その人に、されたことへの文句を言う',
  demand_back: 'その人に、取られた物を返してと言う', hit_person: 'その人を殴る (3発まで)', call_help: '周りの人に助けを求める',
  broadcast: '全員に届く声で何か言う (近くにいない人にも届く。言うことはこのあと考える)', say: '近くの人に話しかける (arg に話す内容)',
};
// 行動の分類 (行動への効き方)
const CATS = ['approach', 'avoid', 'confront', 'fight', 'talk', 'work'];
function actionCat(action, arg, people = new Set()) {
  if (['follow', 'call', 'give', 'ask'].includes(action)) return 'approach';
  if (action === 'go_to' && people.has(String(arg).split(':')[0])) return 'approach';
  if (['avoid_person', 'flee'].includes(action)) return 'avoid';
  if (['complain', 'demand_back'].includes(action)) return 'confront';
  if (action === 'hit_person') return 'fight';
  if (action === 'attack' && !['chicken', 'sheep', 'cow', 'pig'].includes(String(arg))) return 'fight';
  if (['say', 'broadcast', 'call_help'].includes(action)) return 'talk';
  return 'work';
}
// 感情語の辞書 (言い方のばらつき・いちばん多い語の割合)。前から順に、最初に当たった語をその文の語とする
const LEX = {
  anger: ['腹が立', '腹立', '頭にく', '頭に来', 'むかつ', 'ムカ', 'むか', 'イラ', 'いら', '怒', '許せ', '許さ', 'ひどい', 'ひでえ', 'ずるい', '嫌だ', 'いやだ', '不機嫌', '悔し', 'くやし'],
  fear: ['怖', 'こわ', 'コワ', '恐', '不安', '心配', 'びく', 'ビク', '震え', '危な', 'やばい', 'ヤバ', 'ドキ', 'どき', '落ち着かな', 'ぞっと'],
  joy: ['うれし', '嬉し', '楽し', 'たのし', 'よかった', '良かった', 'ありがと', 'やった', '幸せ', 'わくわく', 'ワクワク', '最高', 'いい気分', '気分がい', 'ご機嫌', '助かった'],
  sadness: ['悲し', 'かなし', 'さみし', '寂し', 'さびし', 'つら', '辛', '落ち込', 'しょんぼり', '泣', 'しんど', '元気が出', 'へこ', 'ヘコ', 'がっかり', 'むなし', '虚し'],
};

// ---------- 場面 → プロンプト ----------
function loadSituations(file = SITUATIONS) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

// 行動の一覧。go_to には覚えている場所 (memText の M 番号) も足す (本番の一覧と同じ)
function buildActions(spec, memText = '') {
  const out = [];
  const places = [...String(memText).matchAll(/(M\d+)=([^,\n]+)/g)].map((m) => ({ id: m[1], label: `${m[1]} ${m[2].trim()}` }));
  for (const [name, v0] of Object.entries(spec)) {
    const v = name === 'go_to' ? [...v0, ...places] : v0;
    const desc = ACTION_DESC[name] || name;
    if (name === 'say') out.push({ name, desc, argType: 'text' });
    else if (v === true) out.push({ name, desc, argType: 'none' });
    else out.push({ name, desc, argType: 'choice', choices: v.map((c) => ({ id: c.id, label: c.label || c.id })) });
  }
  return out;
}
function peopleOf(sit) {
  const s = new Set((sit.relations || []).map((r) => r.name));
  for (const m of String(sit.obs).matchAll(/プレイヤー([A-Za-z]+)/g)) s.add(m[1]);
  return s;
}

// 場面 sit で感情 emo を値 v にしたときの Social (言葉の作り方 mode)
function socialFor(sit, emo, v, mode) {
  const s = new Social({ name: sit.persona.name, temperament: sit.persona.temperament || {}, emotions: { wording: MODE_CFG[mode] || mode }, grudge: { enabled: true } });
  s.needsModel.lastTime = NOW;
  for (const r of sit.relations || []) {
    const x = s.rel(r.name);
    x.affinity = r.affinity ?? 50; x.met = true; x.talks = 1; if (r.note) x.note = r.note;
    if (r.grudge) x.grudge = { v: r.grudge.v, kind: r.grudge.kind, item: r.grudge.item || null, tick: 0, origin: Math.min(100, x.affinity + 5) };
  }
  // ほかの感情は記録のその時の値 (驚きは一時のものなので 0)。動かす感情だけ v
  s.emotions = { ...EMO_BASE, ...(sit.logEmotions || {}), surprise: 0, [emo]: v };
  // きっかけ: 今の値の基準値からの差を、そのきっかけで説明できる量にしておく (半減期で今まで薄まった分を戻す)
  for (const [e, c] of Object.entries(sit.causes || {})) {
    if (!c) continue;
    const t = c.ago != null ? NOW - c.ago * EW.TICKS_PER_MIN : null;
    const h = s.emoCfg.halfLife[e] || 1;
    const left = Math.max(0.5, (s.emotions[e] || 0) - (EMO_BASE[e] || 0));
    s.causes.push({ key: `${e}|${c.kind}`, emo: e, kind: c.kind, who: c.who || null, item: c.item || null, what: c.what || null, d: t == null ? left : left * Math.pow(2, (NOW - t) / h), t });
  }
  return s;
}
// 体と心・人間関係の文 (体と心は記録の言葉のまま、感情と関係は Social から)
function socialTextFor(sit, emo, v, mode, { lang = 'ja' } = {}) {
  const s = socialFor(sit, emo, v, mode);
  const needs = s.needsModel.words({ lang });
  const w = s.words({ lang });
  const rest = w.startsWith(needs) ? w.slice(needs.length) : w;
  return { text: `${sit.body}${rest}`, emotionPhrases: s.emotionPhrases({ lang }) };
}
function lineOf(obs, head) { const m = String(obs).match(new RegExp(`${head}: (.*)`)); return m ? m[1] : ''; }
function actCtx(sit, socialText) {
  return { persona: sit.persona, goal: { text: '' }, obsText: sit.obs, memText: sit.memText, actions: buildActions(sit.actions, sit.memText), progress: sit.progress, socialText };
}
function talkCtx(sit, socialText) {
  return { persona: sit.persona, goal: { text: '' }, plan: sit.progress, socialText, nearText: lineOf(sit.obs, '近くの人・生き物・落ちている物') || 'なし', heardText: lineOf(sit.obs, '今聞こえた話') || 'なし', memText: sit.memText };
}

// ---------- 数え方 ----------
function rank(a) {
  const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
  const r = new Array(a.length);
  for (let i = 0; i < idx.length;) {
    let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}
function pearson(x, y) {
  const n = x.length; if (n < 3) return null;
  const mx = x.reduce((a, b) => a + b, 0) / n; const my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0; let sxx = 0; let syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}
function spearman(x, y) { return pearson(rank(x), rank(y)); }
function bigrams(s) { const t = String(s).replace(/\s+/g, ''); const out = []; for (let i = 0; i + 1 < t.length; i++) out.push(t.slice(i, i + 2)); return out; }
function distinct2(texts) { const all = texts.flatMap(bigrams); return all.length ? new Set(all).size / all.length : null; }
function jaccard(a, b) { const A = new Set(bigrams(a)); const B = new Set(bigrams(b)); if (!A.size && !B.size) return 1; let i = 0; for (const x of A) if (B.has(x)) i++; return i / (A.size + B.size - i); }
function lexWord(text, emo) { const t = String(text); for (const w of LEX[emo] || []) if (t.includes(w)) return w; return null; }

// 場面ごとの切片つきロジスティック回帰 y ~ a_sit + b·x (IRLS、少しの L2 で発散を防ぐ)。返り値 { slope, se } | null
function logisticFE(rows, { iters = 50, l2 = 1e-3 } = {}) {
  const groups = [...new Set(rows.map((r) => r.g))];
  const ys = rows.map((r) => r.y);
  if (!rows.length || ys.every((y) => y === ys[0])) return null;
  const k = groups.length + 1;
  const gi = new Map(groups.map((g, i) => [g, i]));
  const beta = new Array(k).fill(0);
  let H = null;
  for (let it = 0; it < iters; it++) {
    const g = new Array(k).fill(0);
    H = Array.from({ length: k }, () => new Array(k).fill(0));
    for (const r of rows) {
      const xi = new Array(k).fill(0); xi[gi.get(r.g)] = 1; xi[k - 1] = r.x;
      const eta = xi.reduce((s, v, j) => s + v * beta[j], 0);
      const p = 1 / (1 + Math.exp(-eta)); const w = p * (1 - p);
      for (let a = 0; a < k; a++) { if (!xi[a]) continue; g[a] += (r.y - p) * xi[a]; for (let b = 0; b < k; b++) if (xi[b]) H[a][b] += w * xi[a] * xi[b]; }
    }
    for (let a = 0; a < k; a++) { g[a] -= l2 * beta[a]; H[a][a] += l2; }
    const step = solve(H, g);
    if (!step) return null;
    let mx = 0; for (let a = 0; a < k; a++) { beta[a] += step[a]; mx = Math.max(mx, Math.abs(step[a])); }
    if (mx < 1e-8) break;
  }
  const inv = invert(H);
  return { slope: beta[k - 1], se: inv ? Math.sqrt(Math.max(0, inv[k - 1][k - 1])) : null };
}
function solve(A, b) {
  const n = b.length; const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) { if (r === c) continue; const f = M[r][c] / M[c][c]; for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}
function invert(A) {
  const n = A.length; const cols = [];
  for (let i = 0; i < n; i++) { const e = new Array(n).fill(0); e[i] = 1; const c = solve(A, e); if (!c) return null; cols.push(c); }
  return Array.from({ length: n }, (_, i) => cols.map((c) => c[i]));
}

// logprobs (Chat Completions の choices[0].logprobs.content) から 0〜9 の期待値。数字の所が無ければ null
function digitExpectation(content) {
  for (const t of content || []) {
    const tok = String(t.token).replace(/["\s]/g, '');
    if (!/^\d$/.test(tok)) continue;
    let z = 0; let s = 0;
    for (const c of t.top_logprobs || [{ token: t.token, logprob: t.logprob }]) {
      const d = String(c.token).replace(/["\s]/g, '');
      if (!/^\d$/.test(d)) continue;
      const p = Math.exp(c.logprob); z += p; s += p * Number(d);
    }
    return z > 0 ? s / z : Number(tok);
  }
  return null;
}

// ---------- 呼び出し ----------
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) { a._.push(k); continue; }
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    a[k.slice(2)] = v;
  }
  return a;
}
const list = (s, d) => (s ? String(s).split(',').map((x) => x.trim()).filter(Boolean) : d);
async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.max(1, n) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } });
  await Promise.all(workers);
}
function readJsonl(file) { if (!fs.existsSync(file)) return []; return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); }

const LUNA_CFG = { llm: { provider: 'luna' } };

async function cmdRun(args) {
  const out = args.out; if (!out) throw new Error('--out DIR');
  fs.mkdirSync(out, { recursive: true });
  const sits = loadSituations().filter((s) => !args.situations || list(args.situations).includes(s.id));
  const modes = list(args.modes, Object.keys(MODE_CFG));
  const emos = list(args.emotions, ['anger', 'fear', 'joy', 'sadness']);
  const values = list(args.values, ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10']).map(Number);
  const reps = Number(args.reps || 3);
  const tasks = list(args.tasks, ['act', 'talk']);
  const temperature = Number(args.temperature ?? 1);
  LLM_USAGE.maxUsd = Number(args['max-usd'] || 30);
  const file = path.join(out, 'results.jsonl');
  const done = new Set(readJsonl(file).filter((r) => !r.error).map((r) => r.key));
  const jobs = [];
  for (const sit of sits) for (const emo of emos) for (const v of values) for (const mode of modes) for (const task of tasks) for (let rep = 0; rep < reps; rep++) {
    const key = `${task}|${sit.id}|${emo}|${v}|${mode}|${rep}`;
    if (!done.has(key)) jobs.push({ key, task, sit, emo, v, mode, rep });
  }
  console.log(`場面 ${sits.length}・感情 ${emos.join(',')}・値 ${values.length}・作り方 ${modes.join(',')}・${tasks.join(',')}・各 ${reps} 回: 残り ${jobs.length} 回 (済み ${done.size})`);
  if (args.dry) {
    const sit = sits[0];
    for (const mode of modes) {
      const st = socialTextFor(sit, emos[0], 7, mode);
      const d = new LLMDecider({ think: true });
      const msgs = d.buildMessages(actCtx(sit, st.text));
      console.log(`=== ${mode} (${sit.id} ${emos[0]}=7) 感情の言葉: ${JSON.stringify(st.emotionPhrases)}\n${msgs[1].content.split('\n## 覚えていること')[0].split('## 気持ちと人間関係')[1]}`);
    }
    return;
  }
  const act = new LLMDecider({ ...llmOptsFor(LUNA_CFG, 'act', { temperature, maxTokens: 200, think: true }), think: true, allowSay: true, mode: 'act', maxConcurrent: 0, constrainArgs: false });
  // constrainArgs: false: OpenAI の strict な構造化出力は一番上の anyOf を受け付けないので、action だけ enum で縛り、arg は一覧と突き合わせる (resolveDecision)
  const talker = new Talker({ llmOptsFor: (role) => ({ ...llmOptsFor(LUNA_CFG, role, { temperature, maxTokens: 80 }), maxConcurrent: 0 }) });
  const fh = fs.openSync(file, 'a');
  let n = 0; const t0 = Date.now();
  await pool(jobs, Number(args.concurrency || 24), async (j) => {
    if (LLM_USAGE.exceeded) return;
    const st = socialTextFor(j.sit, j.emo, j.v, j.mode);
    const rec = { key: j.key, task: j.task, sit: j.sit.id, cat: j.sit.cat, persona: j.sit.persona.name, emo: j.emo, v: j.v, mode: j.mode, rep: j.rep, emotionPhrases: st.emotionPhrases, socialChars: st.text.length };
    try {
      if (j.task === 'act') {
        const r = await act.decide(actCtx(j.sit, st.text));
        Object.assign(rec, { action: r.action, arg: r.arg, think: r.think || '', say: r.say || '', parseOk: r.parseOk, promptTokens: r.promptTokens, completionTokens: r.completionTokens, cachedTokens: r.cachedTokens, error: r.error || null });
        if (r.parseOk) {
          const rv = resolveDecision(buildActions(j.sit.actions, j.sit.memText), r.action, r.arg);
          rec.valid = !!rv.ok; if (rv.ok) { rec.action = rv.action; rec.arg = rv.arg; }
          rec.cat2 = actionCat(rec.action, rec.arg, peopleOf(j.sit));
        }
      } else {
        const r = await talker.talk(talkCtx(j.sit, st.text));
        Object.assign(rec, { say: r.say || '', promptTokens: r.promptTokens, completionTokens: r.completionTokens, error: r.error || null });
      }
    } catch (e) { rec.error = redact(e.message); }
    fs.writeSync(fh, `${JSON.stringify(rec)}\n`);
    n += 1;
    if (n % 200 === 0) console.log(`${n}/${jobs.length} ${Math.round((Date.now() - t0) / 1000)}秒 $${LLM_USAGE.totalUsd.toFixed(3)}`);
  });
  fs.closeSync(fh);
  console.log(`終わり: ${n} 回、費用 $${LLM_USAGE.totalUsd.toFixed(3)}${LLM_USAGE.exceeded ? ' (上限で止めた)' : ''}`);
  fs.writeFileSync(path.join(out, `usage_run_${Date.now()}.json`), JSON.stringify({ totalUsd: LLM_USAGE.totalUsd, byRole: LLM_USAGE.byRole }, null, 1));
}

// 採点 (luna、reasoning none、logprobs)。text の中の感情 emo の強さ 0〜9
function judgeMessages(text, emo) {
  return [
    { role: 'system', content: [
      'あなたは文章から感情を読み取る採点者。ゲームの登場人物が書いた短い文 (考えと発言) を読み、書き手が今感じている「' + EMO_JA[emo] + '」の強さを 0〜9 の整数1つで答える。',
      '0 = まったく感じられない、2 = かすかに、4 = はっきり、6 = 強く、8 = とても強く、9 = 極めて強い。文に表れていることだけで判断し、書かれていないことは推測しない。',
      'JSON {"level":"数字1つ"} だけを出力する。'].join('\n') },
    { role: 'user', content: text },
  ];
}
const JUDGE_SCHEMA = { type: 'object', properties: { level: { type: 'string', enum: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] } }, required: ['level'], additionalProperties: false };
async function judgeOnce(opts, key, text, emo) {
  const body = { model: opts.model, messages: judgeMessages(text, emo), max_completion_tokens: 12, reasoning_effort: 'none', temperature: 1, logprobs: true, top_logprobs: 5,
    response_format: { type: 'json_schema', json_schema: { name: 'judge', schema: JUDGE_SCHEMA, strict: true } } };
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(chatUrl(opts.baseUrl), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
    if (res.status === 429 || res.status >= 500) { if (attempt >= 5) throw new Error(`HTTP ${res.status}`); await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt)); continue; }
    const d = await res.json();
    if (!res.ok) throw new Error(redact(`HTTP ${res.status} ${JSON.stringify(d).slice(0, 300)}`, key));
    const u = d.usage || {};
    const cost = costOf(opts.pricing, { promptTokens: u.prompt_tokens, cachedTokens: u.prompt_tokens_details?.cached_tokens ?? 0, cacheWriteTokens: u.prompt_tokens_details?.cache_write_tokens ?? 0, completionTokens: u.completion_tokens });
    LLM_USAGE.add({ provider: 'luna', role: 'judge', model: opts.model, pricing: opts.pricing, error: false, promptTokens: u.prompt_tokens, cachedTokens: u.prompt_tokens_details?.cached_tokens ?? 0, completionTokens: u.completion_tokens, costUsd: cost.usd, priced: cost.priced, ms: 0 });
    const ev = digitExpectation(d.choices?.[0]?.logprobs?.content);
    let lv = null; try { lv = Number(JSON.parse(d.choices[0].message.content).level); } catch (_) { /* ignore */ }
    return { ev: ev ?? lv, level: lv };
  }
}
function judgeText(r) { return r.task === 'act' ? [r.think ? `考え: ${r.think}` : '', r.say ? `発言: ${r.say}` : '発言: (何も言わない)'].filter(Boolean).join('\n') : `発言: ${r.say || '(何も言わない)'}`; }

async function cmdJudge(args) {
  const out = args.out; if (!out) throw new Error('--out DIR');
  const reps = Number(args['judge-reps'] || 2);
  LLM_USAGE.maxUsd = Number(args['max-usd'] || 30);
  const opts = llmOptsFor(LUNA_CFG, 'goal');
  const key = loadProviderKey(opts);
  if (!key) throw new Error('luna の API キーが無い');
  const rows = readJsonl(path.join(out, 'results.jsonl')).filter((r) => !r.error && (r.task === 'talk' || r.parseOk));
  const file = path.join(out, 'judge.jsonl');
  const done = new Set(readJsonl(file).map((r) => r.key));
  const jobs = rows.filter((r) => !done.has(r.key));
  console.log(`採点: 残り ${jobs.length} 件 (済み ${done.size})、1件 ${reps} 回`);
  const fh = fs.openSync(file, 'a');
  let n = 0;
  await pool(jobs, Number(args.concurrency || 32), async (r) => {
    if (LLM_USAGE.exceeded) return;
    const text = judgeText(r);
    try {
      const xs = [];
      for (let i = 0; i < reps; i++) xs.push(await judgeOnce(opts, key, text, r.emo));
      const evs = xs.map((x) => x.ev).filter((x) => Number.isFinite(x));
      fs.writeSync(fh, `${JSON.stringify({ key: r.key, judged: evs.length ? evs.reduce((a, b) => a + b, 0) / evs.length : null, each: evs })}\n`);
    } catch (e) { console.log(`採点の失敗 ${r.key}: ${redact(e.message, key)}`); }
    n += 1;
    if (n % 500 === 0) console.log(`${n}/${jobs.length} $${LLM_USAGE.totalUsd.toFixed(3)}`);
  });
  fs.closeSync(fh);
  console.log(`採点の終わり: 費用 $${LLM_USAGE.totalUsd.toFixed(3)}`);
  fs.writeFileSync(path.join(out, `usage_judge_${Date.now()}.json`), JSON.stringify({ totalUsd: LLM_USAGE.totalUsd, byRole: LLM_USAGE.byRole }, null, 1));
}

// ---------- まとめ ----------
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const f2 = (x) => (x == null || !Number.isFinite(x) ? '-' : x.toFixed(2));
const pct = (x) => (x == null || !Number.isFinite(x) ? '-' : `${Math.round(x * 100)}%`);
// 言葉に出るしきい値 (uniform の既定: 喜び 4、ほか 3)
const SHOW = { joy: 4, sadness: 3, anger: 3, fear: 3, disgust: 3, surprise: 3 };
// 感情ごとに見る行動の分類 (傾きを表に出すもの)
const FOCUS = { anger: ['confront', 'fight', 'avoid', 'approach'], fear: ['avoid', 'fight', 'approach', 'talk'], joy: ['approach', 'talk', 'work'], sadness: ['approach', 'talk', 'work'] };

// 決まった乱数 (mulberry32)
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// 場面ごとに引き直す bootstrap の ρ の 95% 区間
function rhoCI(rows, B = 300, seed = 1) {
  const sits = [...new Set(rows.map((r) => r.sit))]; const by = new Map(sits.map((x) => [x, rows.filter((r) => r.sit === x)]));
  const R = rng(seed); const xs = [];
  for (let b = 0; b < B; b++) {
    const rr = []; for (let i = 0; i < sits.length; i++) rr.push(...by.get(sits[Math.floor(R() * sits.length)]));
    const r = spearman(rr.map((q) => q.v), rr.map((q) => q.judged)); if (r != null) xs.push(r);
  }
  xs.sort((a, b) => a - b);
  return xs.length ? [xs[Math.floor(0.025 * xs.length)], xs[Math.floor(0.975 * xs.length)]] : null;
}
// 値 0〜2 と 8〜10 の行動の分布の違い (全変動距離、場面ごとの平均)。perm: 低い・高いの札を場面の中で入れ替えた偶然の大きさ (回数)
function tvLowHigh(ok, { perm = 0, seed = 1 } = {}) {
  const dist = (xs) => { const d = {}; for (const r of xs) { const a = `${r.action}:${r.arg}`; d[a] = (d[a] || 0) + 1 / xs.length; } return d; };
  const tv = (L, H) => { const dl = dist(L); const dh = dist(H); return 0.5 * [...new Set([...Object.keys(dl), ...Object.keys(dh)])].reduce((s, a) => s + Math.abs((dl[a] || 0) - (dh[a] || 0)), 0); };
  const sits = [...new Set(ok.map((r) => r.sit))];
  const obs = []; const nul = [];
  const R = rng(seed);
  for (const sit of sits) {
    const L = ok.filter((r) => r.sit === sit && r.v <= 2); const H = ok.filter((r) => r.sit === sit && r.v >= 8);
    if (!L.length || !H.length) continue;
    obs.push(tv(L, H));
    if (perm) {
      const all = [...L, ...H]; let acc = 0;
      for (let p = 0; p < perm; p++) { const sh = all.map((r) => [R(), r]).sort((a, b) => a[0] - b[0]).map((x) => x[1]); acc += tv(sh.slice(0, L.length), sh.slice(L.length)); }
      nul.push(acc / perm);
    }
  }
  return { tv: mean(obs), tvNull: perm ? mean(nul) : null };
}

function analyze(rows, judged, { modes, emos } = {}) {
  const J = new Map(judged.map((j) => [j.key, j.judged]));
  for (const r of rows) r.judged = J.get(r.key) ?? null;
  modes = modes || [...new Set(rows.map((r) => r.mode))];
  emos = emos || [...new Set(rows.map((r) => r.emo))];
  const sum = { grade: {}, diversity: {}, behaviour: {}, cost: {}, prompt: {} };
  for (const task of ['act', 'talk']) {
    for (const emo of emos) for (const mode of modes) {
      const R = rows.filter((r) => r.task === task && r.emo === emo && r.mode === mode && !r.error);
      if (!R.length) continue;
      const k = `${task}|${emo}|${mode}`;
      // 1. 段階
      const jr = R.filter((r) => Number.isFinite(r.judged));
      const above = jr.filter((r) => r.v >= SHOW[emo]);
      let viol = 0; let pairs = 0;
      for (const sit of new Set(jr.map((r) => r.sit))) {
        const ms = [];
        for (let v = SHOW[emo]; v <= 10; v++) { const xs = jr.filter((r) => r.sit === sit && r.v === v).map((r) => r.judged); if (xs.length) ms.push(mean(xs)); }
        for (let i = 1; i < ms.length; i++) { pairs++; if (ms[i] < ms[i - 1] - 0.5) viol++; }
      }
      const lo = mean(jr.filter((r) => r.v === SHOW[emo]).map((r) => r.judged)); const hi = mean(jr.filter((r) => r.v === 10).map((r) => r.judged));
      const base = mean(jr.filter((r) => r.v < SHOW[emo]).map((r) => r.judged));
      sum.grade[k] = { rho: spearman(jr.map((r) => r.v), jr.map((r) => r.judged)), rhoCI: rhoCI(jr), rhoAbove: spearman(above.map((r) => r.v), above.map((r) => r.judged)),
        violations: pairs ? viol / pairs : null, below: base, atShow: lo, at10: hi, n: jr.length };
      // 2. ばらつき (しきい値以上の値の出力)
      const texts = R.filter((r) => r.v >= SHOW[emo]).map((r) => (task === 'act' ? `${r.think || ''} ${r.say || ''}` : r.say || '')).filter((t) => t.trim());
      const words = texts.map((t) => lexWord(t, emo));
      const hit = words.filter(Boolean); const cnt = {}; for (const w of hit) cnt[w] = (cnt[w] || 0) + 1;
      const top = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0];
      let dup = 0; let dp = 0;
      const byCell = {};
      for (const r of R.filter((x) => x.v >= SHOW[emo])) (byCell[`${r.v}|${r.rep}`] = byCell[`${r.v}|${r.rep}`] || []).push(task === 'act' ? r.say || r.think || '' : r.say || '');
      for (const ts of Object.values(byCell)) for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++) { dp++; if (jaccard(ts[i], ts[j]) >= 0.5) dup++; }
      sum.diversity[k] = { distinct2: distinct2(texts), nearDup: dp ? dup / dp : null, mention: texts.length ? hit.length / texts.length : null,
        topWord: top ? top[0] : null, topShare: top && hit.length ? top[1] / hit.length : null, n: texts.length };
      // 4. 長さと費用
      sum.cost[k] = { promptTokens: mean(R.map((r) => r.promptTokens).filter(Number.isFinite)), completionTokens: mean(R.map((r) => r.completionTokens).filter(Number.isFinite)),
        socialChars: mean(R.map((r) => r.socialChars)), emoChars: mean(R.filter((r) => r.v >= SHOW[emo]).map((r) => (r.emotionPhrases || []).join('。').length)) };
      // 3. 行動
      if (task === 'act') {
        const ok = R.filter((r) => r.parseOk && r.cat2);
        const b = {};
        for (const c of CATS) {
          const sitsWith = new Set(ok.filter((r) => r.cat2 === c).map((r) => r.sit));
          const rr = ok.filter((r) => sitsWith.has(r.sit)).map((r) => ({ g: r.sit, x: r.v, y: r.cat2 === c ? 1 : 0 }));
          const fit = logisticFE(rr);
          const p0 = mean(ok.filter((r) => r.v <= 2).map((r) => (r.cat2 === c ? 1 : 0))); const p10 = mean(ok.filter((r) => r.v >= 8).map((r) => (r.cat2 === c ? 1 : 0)));
          b[c] = { slope: fit ? fit.slope : null, se: fit ? fit.se : null, pLow: p0, pHigh: p10 };
        }
        const t = tvLowHigh(ok, { perm: 200 });
        sum.behaviour[k] = { cats: b, tv: t.tv, tvNull: t.tvNull, n: ok.length };
      }
    }
  }
  // プロンプトの側: 作り方ごとの感情の言い方の数と、同じ言い方を使う人の数
  for (const mode of modes) {
    const R = rows.filter((r) => r.mode === mode && r.task === 'act' && r.rep === 0 && r.v >= SHOW[r.emo]);
    const byPhrase = {};
    for (const r of R) for (const p of r.emotionPhrases || []) (byPhrase[p] = byPhrase[p] || new Set()).add(r.persona);
    const ps = Object.values(byPhrase);
    sum.prompt[mode] = { phrases: ps.length, personasPerPhrase: mean(ps.map((s) => s.size)), sharedBy5: ps.length ? ps.filter((s) => s.size >= 5).length / ps.length : null };
  }
  return sum;
}

function report(sum, rows, { modes, emos }) {
  const L = [];
  L.push('# 感情の言葉の作り方の比較 (tools/emotion_wording_eval.js)', '');
  L.push(`出力 ${rows.length} 件。値 0〜10 は1つの感情だけを動かした値 (ほかの感情は記録のその時の値、驚きは 0)。しきい値 (喜び 4・ほか 3) より下はどの作り方でも感情の言葉が出ない。`, '');
  for (const task of ['act', 'talk']) {
    L.push(`## ${task === 'act' ? '行動を選ぶプロンプト (考え + 発言を採点)' : '発言のプロンプト (発言を採点)'}`, '');
    L.push('### 段階のつき方 (採点者の読み取った強さ 0〜9)', '', '| 感情 | 作り方 | ρ (全部) [95%区間] | ρ (しきい値以上) | 下がった所 | しきい値より下 | しきい値 | 10 |', '|---|---|---|---|---|---|---|---|');
    for (const emo of emos) for (const mode of modes) { const g = sum.grade[`${task}|${emo}|${mode}`]; if (g) L.push(`| ${EMO_JA[emo]} | ${mode} | ${f2(g.rho)} [${g.rhoCI ? g.rhoCI.map(f2).join(', ') : '-'}] | ${f2(g.rhoAbove)} | ${pct(g.violations)} | ${f2(g.below)} | ${f2(g.atShow)} | ${f2(g.at10)} |`); }
    L.push('', '### 言い方のばらつき (しきい値以上)', '', '| 感情 | 作り方 | distinct-2 | ほぼ同じ文 (違う人どうし) | 感情語が出る割合 | いちばん多い語 | その割合 |', '|---|---|---|---|---|---|---|');
    for (const emo of emos) for (const mode of modes) { const d = sum.diversity[`${task}|${emo}|${mode}`]; if (d) L.push(`| ${EMO_JA[emo]} | ${mode} | ${f2(d.distinct2)} | ${pct(d.nearDup)} | ${pct(d.mention)} | ${d.topWord || '-'} | ${pct(d.topShare)} |`); }
    L.push('');
  }
  L.push('## 行動への効き方 (行動を選ぶプロンプト)', '', '傾き = 場面ごとの切片つきロジスティック回帰の、値 1 あたりの対数オッズ。( ) は値 0〜2 → 8〜10 の割合。TV = 値 0〜2 と 8〜10 の行動の分布の違い (全変動距離、場面ごとの平均)。偶然 = 低い・高いの札を場面の中で入れ替えたときの TV (200 回の平均)。TV − 偶然 が感情の言葉の効いた分。', '');
  for (const emo of emos) {
    const cs = FOCUS[emo] || CATS;
    L.push(`### ${EMO_JA[emo]}`, '', `| 作り方 | TV | 偶然 | ${cs.join(' | ')} |`, `|---|---|---|${cs.map(() => '---').join('|')}|`);
    for (const mode of modes) {
      const b = sum.behaviour[`act|${emo}|${mode}`]; if (!b) continue;
      L.push(`| ${mode} | ${f2(b.tv)} | ${f2(b.tvNull)} | ${cs.map((c) => { const x = b.cats[c]; return x ? `${f2(x.slope)}±${f2(x.se)} (${pct(x.pLow)}→${pct(x.pHigh)})` : '-'; }).join(' | ')} |`);
    }
    L.push('');
  }
  L.push('## プロンプトの長さ・言い方の数', '', '| 作り方 | 感情の言葉の字数 (平均) | act の入力トークン | talk の入力トークン | 感情の言い方の数 | 1つの言い方を使う人 (平均) | 5人以上が同じ言い方 |', '|---|---|---|---|---|---|---|');
  for (const mode of modes) {
    const a = emos.map((e) => sum.cost[`act|${e}|${mode}`]).filter(Boolean); const t = emos.map((e) => sum.cost[`talk|${e}|${mode}`]).filter(Boolean); const p = sum.prompt[mode] || {};
    L.push(`| ${mode} | ${f2(mean(a.map((x) => x.emoChars).filter(Number.isFinite)))} | ${f2(mean(a.map((x) => x.promptTokens).filter(Number.isFinite)))} | ${f2(mean(t.map((x) => x.promptTokens).filter(Number.isFinite)))} | ${p.phrases ?? '-'} | ${f2(p.personasPerPhrase)} | ${pct(p.sharedBy5)} |`);
  }
  return L.join('\n');
}

function cmdAnalyze(args) {
  const out = args.out; if (!out) throw new Error('--out DIR');
  const rows = readJsonl(path.join(out, 'results.jsonl'));
  const judged = readJsonl(path.join(out, 'judge.jsonl'));
  const modes = list(args.modes, Object.keys(MODE_CFG).filter((m) => rows.some((r) => r.mode === m)));
  const emos = list(args.emotions, ['anger', 'fear', 'joy', 'sadness'].filter((e) => rows.some((r) => r.emo === e)));
  const sum = analyze(rows, judged, { modes, emos });
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(sum, null, 1));
  const md = report(sum, rows, { modes, emos });
  fs.writeFileSync(path.join(out, 'report.md'), md);
  console.log(md);
}

async function main() {
  const args = parseArgs(process.argv);
  const cmd = args._[0];
  if (cmd === 'run') return cmdRun(args);
  if (cmd === 'judge') return cmdJudge(args);
  if (cmd === 'analyze') return cmdAnalyze(args);
  console.log('使い方: node tools/emotion_wording_eval.js run|judge|analyze --out DIR (ファイルの先頭の説明を参照)');
  return null;
}

if (require.main === module) main().catch((e) => { console.error(redact(e.message)); process.exit(1); });

module.exports = { rhoCI, tvLowHigh, loadSituations, socialFor, socialTextFor, buildActions, actCtx, talkCtx, actionCat, peopleOf, spearman, rank, distinct2, jaccard, lexWord, logisticFE, digitExpectation, analyze, report, judgeMessages, MODE_CFG, LEX, CATS };
