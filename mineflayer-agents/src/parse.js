'use strict';
// 2B の LLM の出力から {action, arg, say} を取り出す。壊れた出力にも対処する。
// 返り値 { ok, value, repaired, error }

function stripFences(s) {
  return s.replace(/```(?:json|JSON)?/g, '').trim();
}

// 最初の { から、対応する } までを取り出す (文字列の中の括弧は数えない)
function firstObject(s) {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let q = '';
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === q) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = true; q = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return s.slice(start) + '}'.repeat(Math.max(depth, 1)); // 閉じ忘れ (出力の打ち切り) を閉じる
}

function repairJson(s) {
  let t = s;
  t = t.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  t = t.replace(/'([^'"\n]*)'(\s*[:,}])/g, '"$1"$2'); // 'x' → "x"
  t = t.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":'); // key: → "key":
  t = t.replace(/,\s*([}\]])/g, '$1'); // 末尾のカンマ
  t = t.replace(/"\s*\n\s*"/g, '", "'); // カンマ忘れ (改行で区切られたもの)
  // 閉じていない文字列を閉じる ("say": "あいう} のような打ち切り)
  const quotes = (t.match(/(?<!\\)"/g) || []).length;
  if (quotes % 2 === 1) t = t.replace(/}+\s*$/, '') + '"}';
  return t;
}

function pick(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const action = obj.action ?? obj.act ?? obj.name ?? obj.command;
  if (typeof action !== 'string' || !action.trim()) return null;
  let arg = obj.arg ?? obj.args ?? obj.target ?? obj.argument ?? '';
  if (arg && typeof arg === 'object') arg = Object.values(arg)[0];
  const say = obj.say ?? obj.chat ?? obj.message ?? '';
  const v = { action: action.trim(), arg: arg == null ? '' : String(arg), say: typeof say === 'string' ? say.trim() : '' };
  if (typeof obj.think === 'string') v.think = obj.think.trim();
  return v;
}

function parseDecision(text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'empty output' };
  const body = stripFences(text);
  const objText = firstObject(body);
  if (objText) {
    try {
      const v = pick(JSON.parse(objText));
      if (v) return { ok: true, value: v, repaired: objText.length !== body.trim().length && body.trim() !== objText };
    } catch (_) { /* 次へ */ }
    try {
      const v = pick(JSON.parse(repairJson(objText)));
      if (v) return { ok: true, value: v, repaired: true };
    } catch (_) { /* 次へ */ }
  }
  // 最後の手段: "action": "xxx" を正規表現で拾う
  const m = body.match(/["']?action["']?\s*[:=]\s*["']?([a-z_]+)/i);
  if (m) {
    const a = body.match(/["']?arg["']?\s*[:=]\s*["']([^"'\n]*)/i);
    const s = body.match(/["']?say["']?\s*[:=]\s*["']([^"'\n]*)/i);
    return { ok: true, value: { action: m[1], arg: a ? a[1] : '', say: s ? s[1] : '' }, repaired: true };
  }
  return { ok: false, error: 'no JSON object with "action"' };
}

module.exports = { parseDecision, repairJson, firstObject };
