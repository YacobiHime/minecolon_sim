'use strict';
// LLM の答えを読む。読めなかったら ok: false (呼ぶ側が1回だけ聞き直し、それでもだめなら失敗として数える)。
// 元 (GovSim) は読めないと黙って 0 トン (収穫) / "yes" (話し合いを終える) / 最初の人 (次の話し手) にしていた。

const ANSWER_RE = /(?:\*\*\s*Answer\s*\*\*\s*:|Answer\s*:\s*\*\*|Answer\s*:|So, the answer is:)/i;

// 収穫の量。"Answer:" (元の stop_regex と同じ印) のあとの最初の整数。印が無い・数が無いなら ok: false
function parseHarvest(text) {
  const s = String(text ?? '');
  const parts = s.split(ANSWER_RE);
  if (parts.length < 2) return { ok: false, error: 'no_answer_marker' };
  const after = parts[parts.length - 1];
  const m = after.match(/\d+/);
  if (!m) return { ok: false, error: 'no_number_after_answer' };
  return { ok: true, value: parseInt(m[0], 10) };
}

// 取り決めの量。"Answer:" のあとに数があればその数、N/A・none などなら null (取り決めなし。失敗ではない)。印が無ければ ok: false
function parseLimit(text) {
  const s = String(text ?? '');
  const parts = s.split(ANSWER_RE);
  if (parts.length < 2) return { ok: false, error: 'no_answer_marker' };
  const after = parts[parts.length - 1];
  const m = after.match(/\d+/);
  if (m) return { ok: true, value: parseInt(m[0], 10) };
  return { ok: true, value: null };
}

// 話し合いの1発言。Response: / Conversation conclusion by me: / Next speaker: の3つ。
//   options: 次の話し手に選べる名前。conclusion の印が無ければ ok: false。
//   終わらない (no) のに次の話し手が読めなければ ok: false (fallback に元の既定 = options[0] を入れる)
function parseUtterance(text, options) {
  const s = String(text ?? '').replace(/\r/g, '');
  const concl = s.match(/Conversation conclusion by me\s*:\s*\**\s*\[?\s*(yes|no)\b/i);
  const conclIdx = s.search(/Conversation conclusion by me/i);
  let utter = conclIdx >= 0 ? s.slice(0, conclIdx) : s;
  const r = utter.match(/Response\s*:\s*/i);
  if (r) utter = utter.slice(r.index + r[0].length);
  utter = utter.replace(/^\s*\**\s*/, '').replace(/\s*\**\s*$/, '').trim();
  if (utter.length > 1 && utter[0] === '"' && utter[utter.length - 1] === '"') utter = utter.slice(1, -1);
  if (!concl) return { ok: false, error: 'no_conclusion', utterance: utter, end: true, next: null };
  const end = concl[1].toLowerCase() === 'yes';
  if (end) return { ok: true, utterance: utter, end: true, next: null };
  const nm = s.match(/Next speaker\s*:\s*\**\s*\[?\s*([^\n\]*]+)/i);
  const raw = nm ? nm[1].trim() : '';
  const found = options.find((o) => raw.toLowerCase().startsWith(o.toLowerCase()))
    || options.find((o) => new RegExp(`\\b${o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(raw));
  if (!found) return { ok: false, error: 'no_next_speaker', utterance: utter, end: false, next: options[0] };
  return { ok: true, utterance: utter, end: false, next: found };
}

// 1文 (元は stop_regex "\." で最初の句点まで)
function firstSentence(text) {
  const s = String(text ?? '').trim().replace(/\s+/g, ' ');
  const m = s.match(/^.*?[.!?](\s|$)/);
  return (m ? m[0] : s).trim();
}

// 振り返りの洞察 (番号つきの並び)。"(because of 1,5,3)" は外す
function parseInsights(text) {
  const lines = String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  let items = lines.filter((l) => /^\d+[.)]\s*/.test(l)).map((l) => l.replace(/^\d+[.)]\s*/, ''));
  if (!items.length) items = lines;
  return items.map((l) => l.replace(/\s*\(because of[^)]*\)\s*\.?$/i, '').replace(/\*\*/g, '').trim()).filter((l) => l.length > 3).slice(0, 10);
}

module.exports = { parseHarvest, parseLimit, parseUtterance, firstSentence, parseInsights };
