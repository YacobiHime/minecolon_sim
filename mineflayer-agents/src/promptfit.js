'use strict';
// 2B のプロンプトを1スロットの文脈 (llama-server の -c / -np) に収める安全弁。
//   入力のトークン数は文字数 ÷ (1トークンあたりの文字数) で見積もる。1トークンあたりの文字数は、実際の呼び出しの
//   promptTokens / promptChars から小さいほう (= 見積もりが多めになるほう) に寄せて学ぶ (TokenRatio)。
//   見積もりが budget (= 文脈 − 出力の上限 − 余白) を超えたら、steps の順に欄を削って作り直す (fit)。

class TokenRatio {
  constructor({ initial = 1.6, min = 1.0, max = 4.0 } = {}) {
    this.value = initial; this.min = min; this.max = max; this.samples = 0;
  }

  // 実測 (文字数・トークン数) で学ぶ。少ない側 (トークンが多めに出る側) へはすぐ寄せ、多い側へはゆっくり戻す
  observe(chars, tokens) {
    if (!(chars > 0) || !(tokens > 0)) return;
    const r = Math.max(this.min, Math.min(this.max, chars / tokens));
    this.value = r < this.value ? r : this.value * 0.9 + r * 0.1;
    this.samples += 1;
  }

  tokens(chars) { return Math.ceil(chars / this.value); }
}

// llama-server の「request (4136 tokens) exceeds the available context size (4096 tokens)」から数を取る
function overflowTokens(msg) {
  const m = String(msg || '').match(/request \((\d+) tokens\) exceeds the available context size \((\d+) tokens\)/);
  if (m) return { request: Number(m[1]), ctx: Number(m[2]) };
  // OpenAI の形: "maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens"
  const o = String(msg || '').match(/maximum context length is (\d+) tokens[\s\S]*?resulted in (\d+) tokens/);
  return o ? { request: Number(o[2]), ctx: Number(o[1]) } : null;
}

function charsOf(messages) { return messages.reduce((s, m) => s + String(m.content || '').length, 0); }

// build(lim) → messages。steps = [[key, value], ...] を順に lim に当てて、見積もりが budget 以下になるまで作り直す
//   返り値 { messages, lim, est, budget, applied: [key=value...], over: 削りきっても超えている }
function fit(build, { lim = {}, steps = [], budget, ratio }) {
  const cur = { ...lim };
  let messages = build(cur);
  let est = ratio.tokens(charsOf(messages));
  const applied = [];
  for (const [key, value] of steps) {
    if (est <= budget) break;
    if (cur[key] === value) continue;
    cur[key] = value;
    applied.push(`${key}=${value}`);
    messages = build(cur);
    est = ratio.tokens(charsOf(messages));
  }
  return { messages, lim: cur, est, budget, applied, over: est > budget };
}

// 見出しごと (## で始まる行) の本文の行を n 行までにする
function capSectionLines(text, n) {
  if (!text) return text;
  const out = [];
  let k = 0;
  for (const line of String(text).split('\n')) {
    if (line.startsWith('## ')) { out.push(line); k = 0; continue; }
    if (k < n) out.push(line);
    k += 1;
  }
  return out.filter((l, i, a) => !(l.startsWith('## ') && (i === a.length - 1 || a[i + 1].startsWith('## ')))).join('\n');
}

// 各行を max 文字までにする。「ラベル: 中身」の行は、中身の新しい側 (後ろ) を残す
function capLineChars(text, max) {
  if (!text) return text;
  return String(text).split('\n').map((line) => {
    if (line.length <= max) return line;
    const i = line.indexOf(': ');
    if (i > 0 && i < 20) { const head = line.slice(0, i + 2); return `${head}…${line.slice(line.length - Math.max(10, max - head.length - 1))}`; }
    return line.slice(0, max) + '…';
  }).join('\n');
}

module.exports = { TokenRatio, overflowTokens, charsOf, fit, capSectionLines, capLineChars };
