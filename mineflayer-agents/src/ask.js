'use strict';
// 周りに聞く仕組み (方針メモ 14章)。bot に依存しない部分。
//   困ったことに気づく: 同じ行動・引数が直近 failWindow 回で failRepeat 回失敗 (段階1の④の検出を流用)
//   → 行動の一覧に「ask (近くの人に聞く)」を足す
//   → チャットで「<相手>さん、教えて: <困っていること>」と言う (聞こえる範囲の人にだけ届く)
//   → 聞かれた側は、自分の記憶の範囲で「<相手>さん、答え: …」と答える。記憶に手がかりがなければ「分からない」
//   → 答えを「誰から・いつ」付きで記憶 (knowledge) に入れる → その後の行動で使ったかを記録する

const { noChangeKeys } = require('./nochange');

const Q_RE = /^(\S+?)さん、教えて[:：]\s*(.+)$/;
const A_RE = /^(\S+?)さん、答え[:：]\s*(.+)$/;
const DONT_KNOW_RE = /分から|知らな|わから|ごめん/;

const ABOUT = {
  craft: (a) => `${a}の作り方`,
  collect: (a) => `${a}の取り方`,
  build: () => '小屋の建て方',
  go_to: (a) => `${a}への行き方`,
  place: (a) => `${a}の置き方`,
  hunt: (a) => `${a}のつかまえ方`,
  explore: (a) => `${a}の方へ進む方法`,
  eat: (a) => `${a}の食べ方`,
  pillar: (a) => `高い所の${a}への登り方`,
  pick_up: (a) => `落ちている${a}の拾い方`,
};

function aboutText(key) {
  const i = key.indexOf(':');
  const action = i < 0 ? key : key.slice(0, i);
  const arg = i < 0 ? '' : key.slice(i + 1);
  return (ABOUT[action] || ((x) => `${action}${x ? '(' + x + ')' : ''}のやり方`))(arg);
}

// 直近の失敗から、困っていること (key = "action:arg") と最後の失敗の理由
// noChange = { window, repeat, netKeys? } を渡すと、成功しても状態が変わらない繰り返し (nochange.js) も困りごとに入れる
function troubles(memory, window = 4, repeat = 2, noChange = null) {
  const keys = [...memory.recentFailures(window, repeat)].map((key) => ({ key, kind: 'fail' }));
  if (noChange) {
    for (const key of noChangeKeys(memory.events, noChange.window, noChange.repeat)) {
      if (!keys.some((k) => k.key === key)) keys.push({ key, kind: 'noChange' });
    }
    // noChange.netKeys: 直近 netWindow 回をさかのぼった正味の変化がほぼ0だった繰り返し (nochange.netNoChange)
    for (const key of noChange.netKeys || []) {
      if (!keys.some((k) => k.key === key)) keys.push({ key, kind: 'noChange' });
    }
  }
  return keys.map(({ key, kind }) => {
    const last = [...memory.events].reverse().find((e) => `${e.action}:${e.arg}` === key);
    return { key, kind, about: aboutText(key), lastMsg: last ? last.msg : '' };
  });
}

function questionText(to, trouble) {
  const why = trouble.kind === 'noChange' ? '(何度やっても何も変わらなかった)'
    : trouble.lastMsg ? `(「${trouble.lastMsg.slice(0, 30)}」で失敗した)` : '';
  return `${to}さん、教えて: ${trouble.about}が分からない${why}`;
}

function answerText(to, text) { return `${to}さん、答え: ${text}`; }

function parseQuestion(msg) { const m = String(msg).match(Q_RE); return m ? { to: m[1], question: m[2].trim() } : null; }
function parseAnswer(msg) { const m = String(msg).match(A_RE); return m ? { to: m[1], text: m[2].trim() } : null; }
function isDontKnow(text) { return DONT_KNOW_RE.test(String(text)); }

// 質問の文から、手がかりになる語 (ブロック・物の名前、行動の名前) を拾う
function questionTerms(question) {
  const q = String(question);
  const terms = new Set((q.match(/[a-z][a-z0-9_]+/g) || []).filter((w) => w.length >= 3));
  for (const [jp, t] of [['作り方', 'craft'], ['取り方', 'collect'], ['小屋', 'build'], ['建て', 'build'], ['置き方', 'place'], ['つかまえ', 'hunt'], ['行き方', 'go_to'], ['食べ', 'eat']]) {
    if (q.includes(jp)) terms.add(t);
  }
  return [...terms];
}

// 聞かれた側: 自分の記憶 (やったこと・場所・教わったこと) と、知っていること (goal.hints) から、質問に関係するものを選ぶ。
// 何も見つからなければ空 (→「分からない」と答える)
function relevantMemories(memory, question, { hints = [], max = 5 } = {}) {
  const terms = questionTerms(question);
  const items = [];
  if (!terms.length) return items;
  const names = terms.filter((t) => !['craft', 'collect', 'build', 'place', 'hunt', 'go_to', 'eat'].includes(t));
  const acts = terms.filter((t) => ['craft', 'collect', 'build', 'place', 'hunt', 'go_to', 'eat'].includes(t));
  const hit = (s) => s.length >= 3 && names.some((n) => s.includes(n) || n.includes(s));
  for (const e of [...memory.events].reverse()) {
    if (!e.ok) continue;
    if (hit(`${e.arg}`) || (!names.length && acts.includes(e.action))) items.push({ kind: 'event', text: `${e.action}(${e.arg})で成功: ${e.msg}` });
    if (items.length >= max) break;
  }
  for (const k of [...memory.knowledge].reverse()) {
    if (names.some((n) => k.about.includes(n) || k.text.includes(n)) || acts.some((a) => k.about.includes(a))) items.push({ kind: 'knowledge', text: `${k.from}に聞いた: ${k.text}` });
  }
  for (const p of memory.places) {
    if (names.some((n) => p.kind.includes(n) || n.includes(p.kind))) items.push({ kind: 'place', text: `${p.kind}を(${p.x},${p.y},${p.z})あたりで見た` });
  }
  for (const h of hints) {
    if (names.some((n) => h.includes(n)) || (acts.includes('build') && /小屋|build/.test(h)) || (acts.includes('hunt') && /hunt|肉/.test(h))) items.push({ kind: 'hint', text: h });
  }
  return items.slice(0, max);
}

// 聞いた側: 答えを使ったか。key = 困っていた "action:arg"、answer = 答えの文
//   retried_ok: 同じ行動をやり直して成功した / followed: 答えに出てきた行動・物を選んだ
function answerUse(pending, resolved, result) {
  const key = `${resolved.action}:${resolved.arg}`;
  if (key === pending.key && result.ok) return 'retried_ok';
  const words = new Set((String(pending.answer).match(/[a-z][a-z0-9_]+/g) || []));
  if ((words.has(resolved.arg) || words.has(resolved.action)) && result.ok) return 'followed';
  return null;
}

module.exports = { troubles, aboutText, questionText, answerText, parseQuestion, parseAnswer, isDontKnow, relevantMemories, questionTerms, answerUse };
