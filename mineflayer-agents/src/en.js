'use strict';
// Jev に渡す英語の言葉 (bot に依存しない純粋な関数)。
//   公式の資料: 英語がいちばん正確、数・数え上げは苦手 → 数は名前の付いた段階 (none/one/few/some/many など) にする。
//   日本語の文 (2B 向け) と同じ情報源 (raw・記録の値) から作る。2B 向けの日本語はそのまま。
//   人の名前・発言の中身・2B が書いた文 (方針など) は原文のまま渡す (訳さない)。
//   行動の結果の文 (act.js の日本語) は、よく出る形だけを英語に直し (msgEn)、直せない文は原文のまま残す。
// 研究方針: 仕様・事実だけ。評価語・使い方の誘導は書かない (test で英語の評価語も見る)。

// 8方位 (x+ = 東, z+ = 南)
const DIR8_EN = ['east', 'southeast', 'south', 'southwest', 'west', 'northwest', 'north', 'northeast'];
const DIR_JA_EN = { 北: 'north', 北東: 'northeast', 東: 'east', 南東: 'southeast', 南: 'south', 南西: 'southwest', 西: 'west', 北西: 'northwest', すぐそば: 'right here' };

function dir8En(from, to) {
  if (!from || !to) return null;
  const dx = to.x - from.x; const dz = to.z - from.z;
  if (Math.hypot(dx, dz) < 3) return 'here';
  const a = Math.atan2(dz, dx);
  return DIR8_EN[((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8];
}

// 距離の段階 (m の数は出さない)
const DIST_BANDS = [[3, 'here'], [8, 'near'], [16, 'a short walk'], [40, 'far'], [Infinity, 'very far']];
function distWord(d) {
  if (!Number.isFinite(d)) return 'unknown distance';
  return DIST_BANDS.find(([lim]) => d < lim)[1];
}

// 「near, east」「here」「far, north (above)」
function whereEn(from, to) {
  if (!from || !to) return 'location unknown';
  const d = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  const w = distWord(d);
  if (w === 'here') return 'here';
  const dy = Math.round(to.y - from.y);
  const v = dy >= 3 ? ' (above)' : dy <= -3 ? ' (below)' : '';
  return `${w}, ${dir8En(from, to)}${v}`;
}

// 数の段階 (見えている数・記憶の件数など。持ち物の数はそのまま)
function countWord(n) {
  if (!Number.isFinite(n) || n <= 0) return 'none';
  if (n === 1) return 'one';
  if (n <= 4) return 'a few';
  if (n <= 15) return 'some';
  return 'many';
}

// 体力・満腹度 (ゲームの値 0〜20) の段階
function barWord(v, { full = 'full', high = 'high', half = 'half', low = 'low', zero = 'almost none' } = {}) {
  if (!Number.isFinite(v)) return 'unknown';
  if (v >= 20) return full;
  if (v >= 14) return high;
  if (v >= 8) return half;
  if (v >= 3) return low;
  return zero;
}
const healthWord = (h) => barWord(h, { zero: 'almost dead' });
const foodWord = (f) => barWord(f, { zero: 'empty' });

const PHASE_EN = { 朝: 'morning', 昼: 'daytime', 夕方: 'dusk', 夜: 'night', 明け方: 'dawn' };
function phaseEn(p) { return PHASE_EN[p] || p || 'unknown'; }
// 覚えている場所の種類 (拠点・共有のチェスト) の英語
function placeKindEn(k) { return k === '拠点' ? 'base' : /^共有のチェスト /.test(String(k)) ? `shared chest ${String(k).slice(8)}` : k; }

const ORD = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
function dayEn(day) { return day == null ? null : `day ${ORD[day + 1] ? ORD[day + 1] : day + 1}`.replace(/^day (\w+)$/, (m, w) => (ORD.includes(w) ? `the ${w} day` : `day ${w}`)); }

// 持ち物の差 (before / after: [{name, count}]) → "+4 jungle_log, -1 bread" | ''
function invDelta(before = [], after = []) {
  const m = new Map();
  for (const i of before || []) m.set(i.name, (m.get(i.name) || 0) - i.count);
  for (const i of after || []) m.set(i.name, (m.get(i.name) || 0) + i.count);
  return [...m].filter(([, d]) => d !== 0).sort((a, b) => b[1] - a[1]).map(([n, d]) => `${d > 0 ? '+' : ''}${d} ${n}`).join(', ');
}

function invText(inv = []) {
  const m = new Map();
  for (const i of inv || []) m.set(i.name, (m.get(i.name) || 0) + i.count);
  return m.size ? [...m].map(([n, c]) => `${n} x${c}`).join(', ') : 'nothing';
}

// ---- 行動の結果の文 (act.js の日本語) → 英語 ----
// 1文ずつ (「。」で区切る) 表に当てる。当たらない文は原文のまま。座標・秒は落とす (数の段階にしない物は落とす)
const N = '(\\d+)';
const W = '([^\\s。、()（）「」:]+?)';
const SENT = [
  [new RegExp(`^${W}を(?:.+?で)?${N}個掘って${N}個拾った(.*)$`), (m) => `dug ${m[2]} ${m[1]}, picked up ${m[3]}${tail(m[4])}`],
  [new RegExp(`^着いたが${W}はもう無かった$`), (m) => `arrived, but the ${m[1]} was no longer there`],
  [new RegExp(`^${W}の所に着いた$`), (m) => `arrived at ${placeName(m[1])}`],
  [new RegExp(`^素手を${W}(?:\\(.*?\\))?(?: \\S+)?に使ったが何も起きなかった$`), (m) => `used bare hand on ${m[1]}: nothing happened`],
  [new RegExp(`^${W}を${W}(?:\\(.*?\\))?(?: \\S+)?に使ったが何も起きなかった$`), (m) => `used ${m[1]} on ${m[2]}: nothing happened`],
  [new RegExp(`^${W}を使ったが何も起きなかった$`), (m) => `used ${m[1]}: nothing happened`],
  [new RegExp(`^${W}を${W}(?:\\(.*?\\))?(?: \\S+)?に使った: (.*)$`), (m) => `used ${m[1]} on ${m[2]}: ${useDetail(m[3])}`],
  [new RegExp(`^${W}を${W}に向けて使った(?:: (.*))?$`), (m) => `used ${m[1]} toward ${m[2]}${m[3] ? `: ${useDetail(m[3])}` : ''}`],
  [/^(.+?)が時間切れ$/, (m) => `${m[1]} timed out`],
  [/^時間切れ$/, () => 'timed out'],
  [/^動けなかった \(近づけなかった\)$/, () => 'could not move (got no closer for a while)'],
  [/^(.+?)が動けなかった \(近づけなかった\)$/, (m) => `${m[1]}: could not move (got no closer for a while)`],
  [new RegExp(`^手の届く高さに${W}が見えない$`), (m) => `no ${m[1]} visible within reach`],
  [new RegExp(`^${W}を拾えなかった(?:: (.*))?$`), (m) => `could not pick up ${m[1]}${m[2] ? `: ${reason(m[2])}` : ''}`],
  [new RegExp(`^${W}の下へ行けなかった: (.*)$`), (m) => `could not get under ${m[1]}: ${reason(m[2])}`],
  [new RegExp(`^${W}へ行けなかった: (.*)$`), (m) => `could not reach ${placeName(m[1])}: ${reason(m[2])}`],
  [new RegExp(`^${W}まで届かなかった \\(あと${N}m\\)$`), (m) => `did not reach ${placeName(m[1])} (${distWord(Number(m[2]))} left)`],
  [/^置ける場所が近くにない$/, () => 'no free spot nearby to place it'],
  [new RegExp(`^${W}について行ったが見失った \\(${N}m動いた\\)$`), (m) => `followed ${m[1]} but lost sight of them`],
  [new RegExp(`^${W}に${N}秒ついて行った \\(${N}m動いた、今${N}m離れている\\)$`), (m) => `followed ${m[1]} (now ${distWord(Number(m[4]))} from them)`],
  [new RegExp(`^${W}を${N}個作った$`), (m) => `made ${m[2]} ${m[1]}`],
  [new RegExp(`^${W}の材料が足りない(.*)$`), (m) => `not enough materials for ${m[1]}${/作業台/.test(m[2]) ? ' (may need a crafting_table)' : ''}`],
  [new RegExp(`^${W}を作れなかった: (.*)$`), (m) => `could not make ${m[1]}: ${reason(m[2])}`],
  [/^まだ行っていないマスの方へ(\d+)m進んだ ?(.*)$/, (m) => `walked ${distWord(Number(m[1]))} toward an unvisited area${areaTag(m[2])}`],
  [new RegExp(`^${W}へ${N}m進んだ ?(.*)$`), (m) => `walked ${distWord(Number(m[2]))} ${dirName(m[1])}${areaTag(m[3])}`],
  [new RegExp(`^${W}へ進めなかった(?:: (.*))?$`), (m) => `could not walk ${dirName(m[1])}${m[2] ? `: ${reason(m[2])}` : ''}`],
  [new RegExp(`^${W}を${N}個積んで${N}段登った(.*)$`), (m) => `stacked ${m[2]} ${m[1]} and climbed ${m[3]} blocks${tail(m[4])}`],
  [/^登れなかった(?:: (.*))?$/, (m) => `could not climb${m[1] ? `: ${reason(m[1])}` : ''}`],
  [new RegExp(`^登らなくても${W}に手が届く所に来た$`), (m) => `reached a spot where ${m[1]} is within reach without climbing`],
  [/^敵から(\d+)m離れた$/, (m) => `moved ${distWord(Number(m[1]))} away from enemies`],
  [/^逃げられなかった(?:: (.*))?$/, (m) => `could not get away${m[1] ? `: ${reason(m[1])}` : ''}`],
  [new RegExp(`^${W}を\\(-?\\d+,-?\\d+,-?\\d+\\)に置いた(.*)$`), (m) => `placed ${m[1]}`],
  [new RegExp(`^${W}を置けなかった: (.*)$`), (m) => `could not place ${m[1]}: ${reason(m[2])}`],
  [new RegExp(`^${W}を${N}個拾った$`), (m) => `picked up ${m[2]} ${m[1]}`],
  [new RegExp(`^${W}を食べた$`), (m) => `ate ${m[1]}`],
  [/^食べられなかった: (.*)$/, (m) => `could not eat: ${reason(m[1])}`],
  [new RegExp(`^${W}を手に持った$`), (m) => `now holding ${m[1]}`],
  [new RegExp(`^${W}を着た$`), (m) => `now wearing ${m[1]}`],
  [/^ここ\(.*?\)を拠点にした$/, () => 'made this spot the base'],
  [/^周りを見回した$/, () => 'looked around'],
  [/^(\d+)秒待った$/, () => 'waited a moment'],
  [new RegExp(`^${W}が${W}を${N}個(壊した|拾った)$`), (m) => `${m[1]} ${m[4] === '壊した' ? 'broke' : 'picked up'} ${m[3]} ${m[2]}`],
  [new RegExp(`^(?:${W}で|素手で)${W}を倒して${N}個拾った$`), (m) => `killed ${m[2]}${m[1] ? ` with ${m[1]}` : ' bare-handed'}, picked up ${m[3]}`],
  [new RegExp(`^(?:${W}で|素手で)${W}を倒したが何も拾えなかった$`), (m) => `killed ${m[2]} but picked up nothing`],
  [new RegExp(`^(?:${W}で|素手で)?${W}を倒せなかった\\(${N}回たたいた\\)$`), (m) => `could not kill ${m[2]} (hit it ${countWord(Number(m[3]))} times)`],
  [new RegExp(`^${W}を持っていない$`), (m) => `do not have ${m[1]}`],
  [new RegExp(`^${W}が見えない$`), (m) => `cannot see ${m[1]}`],
  [new RegExp(`^${W}に近づけなかった(.*)$`), (m) => `could not get close to ${m[1]}`],
  [new RegExp(`^${W}に手が届かない$`), (m) => `cannot reach ${m[1]}`],
  [/^「(.*)」と言った$/, (m) => `said 「${m[1]}」`],
  [/^「(.*)」と呼んだ$/, (m) => `called out 「${m[1]}」`],
  [new RegExp(`^${W}を呼べなかった$`), (m) => `could not call ${m[1]}`],
  [new RegExp(`^${W}に${W}を${N}個投げ渡した(.*)$`), (m) => `tossed ${m[3]} ${m[2]} to ${m[1]}${/地面/.test(m[4]) ? ' (it is still on the ground)' : ''}`],
  [/^寝て起きた \(夜が明けた\)$/, () => 'slept and woke up; the night is over'],
  [/^寝たが途中で起きた \(まだ夜\)$/, () => 'slept but woke up early; it is still night'],
  [/^寝たが夜は明けなかったので起きた$/, () => 'slept, but the night did not end, so woke up'],
  [/^寝られなかった: (.*)$/, (m) => `could not sleep: ${reason(m[1])}`],
  [/^ベッドが見当たらない$/, () => 'no bed in sight'],
  [/^ベッドへ行けなかった: (.*)$/, (m) => `could not reach the bed: ${reason(m[1])}`],
  [/^近くに作業台が見えない$/, () => 'no crafting_table visible nearby'],
  [/^作業台へ行けなかった: (.*)$/, (m) => `could not reach the crafting_table: ${reason(m[1])}`],
  [/^かまどが見当たらない$/, () => 'no furnace in sight'],
  [/^かまどへ行けなかった: (.*)$/, (m) => `could not reach the furnace: ${reason(m[1])}`],
  [new RegExp(`^${W}を焼いて${W}を${N}個取り出した(.*)$`), (m) => `smelted ${m[1]} and took out ${m[3]} ${m[2]}${m[4] ? ' (the rest is still inside)' : ''}`],
  [new RegExp(`^${W}を${N}個入れたが、まだ焼けていない.*$`), (m) => `put ${m[2]} ${m[1]} in; not smelted yet (left inside)`],
  [/^焼けなかった: (.*)$/, (m) => `could not smelt: ${reason(m[1])}`],
  [new RegExp(`^${W}に${W}を${N}個入れた.*$`), (m) => `put ${m[3]} ${m[2]} into ${m[1]}`],
  [new RegExp(`^${W}から${W}を${N}個取り出した.*$`), (m) => `took ${m[3]} ${m[2]} out of ${m[1]}`],
  [new RegExp(`^${W}を開けて見た \\(中身: (.*)\\)$`), (m) => `opened ${m[1]} (contents: ${m[2] === 'なし' || m[2] === '空' ? 'empty' : m[2]})`],
  [new RegExp(`^${W}を開けなかった: (.*)$`), (m) => `could not open ${m[1]}: ${reason(m[2])}`],
  [new RegExp(`^${W}から降りた$`), (m) => `got off the ${m[1]}`],
  [/^拠点の場所を知らない$/, () => 'do not know where the base is'],
  [/^逃げる相手が見えない$/, () => 'no enemy in sight to run from'],
  [new RegExp(`^${W}を持ったが、${W}は付いてこなかった.*$`), (m) => `held ${m[1]}, but ${m[2]} did not follow`],
  [new RegExp(`^${W}を持って${N}m歩いた: ${W}が${N}頭付いてきて、(.+?)の近くに${N}頭いる.*$`), (m) => `walked holding ${m[1]}: ${countWord(Number(m[4]))} ${m[3]} followed; ${countWord(Number(m[6]))} near ${placeName(m[5])}`],
  [new RegExp(`^${W}で(.+?)の周り \\(内側(\\d+x\\d+)\\) を囲った: (\\d+)か所のうち(\\d+)個置いた.*$`), (m) => `enclosed around ${placeName(m[2])} (inside ${m[3]}) with ${m[1]}: placed ${m[5]} of ${m[4]}`],
  [new RegExp(`^(.+?)の周り \\(内側(\\d+x\\d+)\\) に何も置けなかった.*$`), (m) => `could not place anything around ${placeName(m[1])} (inside ${m[2]})`],
  [new RegExp(`^${W}に聞いた:「(.*)」$`), (m) => `asked ${m[1]}; they answered 「${m[2]}」`],
  [new RegExp(`^${W}に聞いたが(.*)$`), (m) => `asked ${m[1]}, but ${/返事/.test(m[2]) ? 'got no answer' : 'they did not know'}`],
  [/^実行できない行動: (.*)$/, (m) => `cannot do the action ${m[1]}`],
];

const DIR_WORD = { north: 'north', south: 'south', east: 'east', west: 'west' };
function dirName(s) { return DIR_JA_EN[s] ? `to the ${DIR_JA_EN[s]}` : DIR_WORD[s] ? `to the ${s}` : `toward ${s}`; }
function placeName(s) { return s === '拠点' ? 'the base' : s === '自分の拠点' ? 'the base' : s === '今いる所' ? 'the current spot' : s === 'ここ' ? 'here' : s; }
function areaTag(s) { return /新しいマス/.test(s || '') ? ' (a new area)' : /行ったことのあるマス/.test(s || '') ? ' (an area visited before)' : ''; }
function tail(s) {
  const t = String(s || '');
  const out = [];
  if (/時間切れ/.test(t)) out.push('timed out');
  if (/動けなかった/.test(t)) out.push('could not move');
  const plus = t.match(/\(([a-z_]+\+\d+(?:, ?[a-z_]+\+\d+)*)\)/);
  if (plus) out.push(`also ${plus[1]}`);
  return out.length ? ` (${out.join('; ')})` : '';
}
function reason(s) {
  const t = String(s || '').trim();
  if (/時間切れ|timeout/i.test(t)) return 'timed out';
  if (/道が見つからない|No path|noPath/i.test(t)) return 'no path';
  if (/動けなかった \(近づけなかった\)/.test(t)) return 'could not move (got no closer for a while)';
  if (/動けなかった/.test(t)) return 'could not move';
  return t;
}
function useDetail(s) {
  return String(s || '').split(/、/).map((p) => {
    let m = p.match(/^隣に(\S+)ができた$/);
    if (m) return `${m[1]} appeared next to it`;
    m = p.match(/^(\S+)が(\S+)になった$/);
    if (m) return `${m[1]} became ${m[2]}`;
    m = p.match(/^持ち物 (.*)$/);
    if (m) return `inventory ${m[1]}`;
    if (/何も起きなかった/.test(p)) return 'nothing happened';
    return p;
  }).join(', ');
}

function sentenceEn(s) {
  const t = s.trim();
  if (!t) return '';
  for (const [re, f] of SENT) { const m = t.match(re); if (m) return f(m); }
  return null;
}

// 「。」で文に分ける (「」の中の「。」では分けない)
function splitSentences(t) {
  const out = []; let cur = ''; let depth = 0;
  for (const ch of t) {
    if (ch === '「') depth += 1; else if (ch === '」') depth = Math.max(0, depth - 1);
    if (ch === '。' && depth === 0) { if (cur.trim()) out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// 結果の文 → { text, translated (全部の文が当たったか) }
function msgEn(msg) {
  const parts = splitSentences(String(msg || ''));
  let all = true;
  const out = parts.map((p) => { const e = sentenceEn(p); if (e == null) { all = false; return p; } return e; });
  return { text: out.join('. '), translated: all };
}

// 行動の結果 (last_result・記憶のやったこと): "collect jungle_log: succeeded. dug 3 jungle_log, picked up 4. inventory +4 jungle_log"
function resultEn({ action, arg = '', ok, msg = '', delta = '' }) {
  const head = `${action}${arg ? ` ${arg}` : ''}: ${ok ? 'succeeded' : 'failed'}`;
  const m = msgEn(msg);
  return [head, m.text, delta ? `inventory ${delta}` : ''].filter(Boolean).join('. ');
}

// 評価語・使い方の誘導 (英語)。test で、Jev に渡す文・指示・事実に入っていないことを確かめる
const ADVICE_EN = /\b(should|must|better|best|recommend\w*|prefer\w*|priorit\w*|important|first of all|ought|wise|ideal|good idea|optimal|you need to|make sure)\b/i;

module.exports = { placeKindEn, dir8En, distWord, whereEn, countWord, healthWord, foodWord, phaseEn, dayEn, invDelta, invText, msgEn, resultEn, sentenceEn, DIR_JA_EN, DIR8_EN, ADVICE_EN, placeName };
