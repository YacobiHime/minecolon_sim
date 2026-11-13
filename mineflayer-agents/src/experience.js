'use strict';
// 経験から確実さと効率を学ぶ (2026-11-07 ユーザー決定)。bot に依存しない部品 (つなぎは goalpath.js・agent.js)。
//   ゴールの対象 (物・状態・人・場所) ごとに、自分の経験を持つ: 試した回数・達成した回数・かけた判断の数・かけた時間 (ゲーム内の tick)・諦めた理由。
//   選べる行動が無くて失敗したのも、選べるのに下手で失敗したのも、同じく「試して達成しなかった」1回に数える (特別扱い・決め打ちの除外はしない)。
//   1. 成功の見込み q (ベータ分布の事後平均): q = (k0 × m0 + 達成 + hw × 聞いた達成) ÷ (k0 + 試した + hw × 聞いた試した)
//      m0 = 事前の見込み (prior.mean)、k0 = 事前の強さ (prior.strength。何回分の経験に当たるか)
//      ゴールの点では P_実 = P × q ÷ m0 (経験が無ければ q = m0 で今までと同じ点。分業の gamma × T の項にも同じく掛ける)
//   2. 見込みの手間: 手間_経験 = (kc × 手間_planner + n × 1回あたりの判断の数 × perDecision) ÷ (kc + n)
//      (planner の見積もりと、実際にかかった判断の数の重み付き平均。n = 終わった試しの数。達成しなかった試しの判断も数える)
//   3. 言葉: 「生の鮭は3回試して、手に入らなかった (計約6分)」「パンは2回手に入れた (平均約3分)」(英語も)。数値の係数はモデルに見せない
//   4. 聞いた経験 (任意): ほかの人が「鮭は取れない」「パンが作れた」と言ったら、聞いた試し・達成として heardW の重みで足す (自分の経験より弱く)。
//      同じ人・同じ物は maxPerSpeaker 回まで。問いの形 (? で終わる) は数えない
// 研究方針: 経験の事実だけを言葉にする。「避ける」「やめる」などの評価語・指示は書かない。

const { jaName, DIRECT } = (() => { try { const m = require('./names_ja'); return { jaName: m.jaName || ((n) => n), DIRECT: m.DIRECT || {} }; } catch (_) { return { jaName: (n) => n, DIRECT: {} }; } })();

const DEFAULTS = {
  enabled: true,
  prior: { mean: 0.8, strength: 3 }, // 事前の見込み m0 と強さ k0 (何回分の経験に当たるか)
  cost: { strength: 2, perDecision: 0.25 }, // planner の見積もりの強さ kc、1判断あたりの手間 (planner の手間の単位。前回の記録で達成したゴールの 判断数 ÷ 手間 の中央値 ≈ 4)
  heard: { enabled: true, weight: 0.3, maxPerSpeaker: 2 },
  words: { maxLines: 5, ticksPerMinute: 1200 }, // ゲーム内の 1200 tick = 1分 (1日 = 20分)
  keep: 80, // 覚えておく対象の数 (古いものから忘れる)
};

const r3 = (v) => Math.round(v * 1000) / 1000;
function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function merge(a, b) { if (!isObj(a) || !isObj(b)) return b === undefined ? a : b; const o = { ...a }; for (const [k, v] of Object.entries(b)) o[k] = merge(a[k], v); return o; }

// ゴール → 経験のキー (対象ごと。数は見ない。人は渡すゴールも同じ人のキー)
function expKey(g) {
  if (!g || !g.kind || g.target == null) return null;
  return `${g.kind}:${g.target}`;
}

// 達成した (対象を手に入れた・そうなった・近くに行けた/渡せた・着いた) に数える結果
const OK_RESULTS = new Set(['done', 'planted', 'need_unmet']);
const FAIL_RESULTS = new Set(['stuck', 'unplannable']);

// 名前 (日本語の言葉) と動詞
function nameJa(kind, target, give) {
  if (kind === 'item') { const j = jaName(target); return j && j !== target ? j : target; }
  if (kind === 'person') return give ? `${target}に物を渡すこと` : `${target}の近くに行くこと`;
  if (kind === 'place') { const i = String(target).lastIndexOf('@'); return i > 0 ? `${target.slice(0, i)} (${target.slice(i + 1)})` : `${target}へ行くこと`; }
  return String(target);
}
const VERB = {
  item: { ok: '手に入れた', ng: '手に入らなかった', okEn: 'got it', ngEn: 'did not get it' },
  state: { ok: 'そうなった', ng: 'そうならなかった', okEn: 'it came about', ngEn: 'it did not come about' },
  person: { ok: 'できた', ng: 'できなかった', okEn: 'managed it', ngEn: 'did not manage it' },
  place: { ok: '着いた', ng: '着かなかった', okEn: 'got there', ngEn: 'did not get there' },
};
function nameEn(kind, target, give) {
  if (kind === 'person') return give ? `giving things to ${target}` : `getting near ${target}`;
  if (kind === 'place') return `going to ${String(target).replace(/@.*/, '')}`;
  return String(target);
}

// 発言から物の名前を拾うための表 (英語の名前と日本語の名前。「生の鮭」→「鮭」も)
let JA_TO_ID = null;
function jaIndex() {
  if (JA_TO_ID) return JA_TO_ID;
  JA_TO_ID = [];
  for (const [id, ja] of Object.entries(DIRECT)) {
    JA_TO_ID.push([ja, id]);
    const short = ja.replace(/^生の/, '');
    if (short !== ja && short.length >= 1) JA_TO_ID.push([short, id]);
  }
  JA_TO_ID.sort((a, b) => b[0].length - a[0].length); // 長い名前から (「焼き鮭」を「鮭」より先に)
  return JA_TO_ID;
}
const SAID_FAIL = /取れな|とれな|捕れな|獲れな|手に入らな|無理|できな|出来な|作れな|ダメ|だめ|見つからな|失敗|うまくいかな|can'?t (get|catch|make|find)|couldn'?t|failed/i;
const SAID_OK = /取れた|とれた|捕れた|獲れた|手に入った|作れた|できた|出来た|拾えた|got (some|it|one)|made (some|it|one)|caught/i;

// 発言 → [{ item, ok }] (問いの形は数えない)
function saidExperience(text) {
  const t = String(text || '').trim();
  if (!t || /[?？]$/.test(t)) return [];
  const fail = SAID_FAIL.test(t); const ok = !fail && SAID_OK.test(t);
  if (!fail && !ok) return [];
  const items = new Set();
  let rest = t;
  for (const [ja, id] of jaIndex()) if (rest.includes(ja)) { items.add(id); rest = rest.split(ja).join(' '); }
  for (const w of t.match(/[a-z][a-z0-9_]{2,}/g) || []) if (DIRECT[w]) items.add(w);
  return [...items].map((item) => ({ item, ok }));
}

class Experience {
  constructor({ cfg = {} } = {}) {
    this.cfg = merge(DEFAULTS, cfg || {});
    this.items = {}; // key → { kind, target, give, tries, ok, decisions, gameTicks, timed, reasons: {}, last, heardTries, heardOk, heardFrom: {} }
  }

  static fromJSON(d, opts = {}) {
    const x = new Experience(opts);
    if (isObj(d) && isObj(d.items)) x.items = d.items;
    return x;
  }

  toJSON() { return { items: this.items }; }

  rec(key, g = {}) {
    if (!this.items[key]) this.items[key] = { kind: g.kind, target: g.target, give: g.give || null, tries: 0, ok: 0, decisions: 0, gameTicks: 0, timed: 0, reasons: {}, last: 0, heardTries: 0, heardOk: 0, heardFrom: {} };
    return this.items[key];
  }

  forget() {
    const keys = Object.keys(this.items);
    if (keys.length <= this.cfg.keep) return;
    keys.sort((a, b) => (this.items[a].last || 0) - (this.items[b].last || 0));
    for (const k of keys.slice(0, keys.length - this.cfg.keep)) delete this.items[k];
  }

  // ゴールの結果 (goalpath.js finish)。e = { kind, target, give, result, from, to (判断の番号), gameFrom, gameTo (ゲーム内の tick), why }
  noteResult(e) {
    if (!e || !(OK_RESULTS.has(e.result) || FAIL_RESULTS.has(e.result))) return null;
    const key = expKey(e);
    if (!key) return null;
    const r = this.rec(key, e);
    r.tries += 1;
    if (OK_RESULTS.has(e.result)) r.ok += 1;
    else r.reasons[e.result] = (r.reasons[e.result] || 0) + 1;
    if (Number.isFinite(e.from) && Number.isFinite(e.to)) r.decisions += Math.max(0, e.to - e.from);
    if (Number.isFinite(e.gameFrom) && Number.isFinite(e.gameTo) && e.gameTo >= e.gameFrom) { r.gameTicks += e.gameTo - e.gameFrom; r.timed += 1; }
    if (e.why) r.lastWhy = String(e.why).slice(0, 60);
    r.last = Number.isFinite(e.to) ? e.to : r.last;
    this.forget();
    return key;
  }

  // 聞いた発言 (近くの声・全体チャット)。返り値: 数えた [{ item, ok }]
  noteHeard(from, text, tick = 0, me = null) {
    const h = this.cfg.heard;
    if (!h.enabled || !from || from === me || from === '自分') return [];
    const out = [];
    for (const x of saidExperience(text)) {
      const r = this.rec(`item:${x.item}`, { kind: 'item', target: x.item });
      const n = r.heardFrom[from] || 0;
      if (n >= h.maxPerSpeaker) continue;
      r.heardFrom[from] = n + 1;
      r.heardTries += 1; if (x.ok) r.heardOk += 1;
      r.heardLast = { from, ok: x.ok, tick };
      r.last = Math.max(r.last || 0, tick);
      out.push(x);
    }
    if (out.length) this.forget();
    return out;
  }

  // 成功の見込み q とその事前 m0 との比 (ゴールの点に掛ける)
  success(g) {
    const key = typeof g === 'string' ? g : expKey(g);
    const { mean: m0, strength: k0 } = this.cfg.prior;
    const r = key ? this.items[key] : null;
    const hw = this.cfg.heard.enabled ? this.cfg.heard.weight : 0;
    if (!r) return { q: m0, factor: 1, n: 0 };
    const q = (k0 * m0 + r.ok + hw * r.heardOk) / (k0 + r.tries + hw * r.heardTries);
    return { q: r3(q), factor: r3(q / m0), n: r.tries, ok: r.ok, heard: r.heardTries };
  }

  // 見込みの手間 (planner の見積もり cost と、実際にかかった判断の数の重み付き平均)。cost が無ければ経験だけ (経験も無ければ null)
  cost(g, cost) {
    const key = typeof g === 'string' ? g : expKey(g);
    const r = key ? this.items[key] : null;
    const { strength: kc, perDecision } = this.cfg.cost;
    if (!r || !r.tries) return Number.isFinite(cost) ? cost : null;
    const seen = (r.decisions / r.tries) * perDecision;
    if (!Number.isFinite(cost)) return r3(seen);
    return r3((kc * cost + r.tries * seen) / (kc + r.tries));
  }

  // 時間の言葉 (ゲーム内の分。無ければ判断の数)
  timeText(r, { avg = false, en = false } = {}) {
    const tpm = this.cfg.words.ticksPerMinute;
    if (r.timed > 0) {
      const ticks = avg ? r.gameTicks / r.timed : r.gameTicks * (r.tries / r.timed);
      const m = ticks / tpm;
      if (en) return `${m < 1 ? 'under 1 min' : `about ${Math.round(m)} min`} ${avg ? 'on average' : 'in total'}`;
      return `${avg ? '平均' : '計'}${m < 1 ? '1分足らず' : `約${Math.round(m)}分`}`;
    }
    const d = avg ? Math.round(r.decisions / Math.max(1, r.tries)) : r.decisions;
    return en ? `${d} decisions ${avg ? 'on average' : 'in total'}` : `${avg ? '平均' : '計'}${d}判断`;
  }

  // 1つの対象の言葉
  lineOf(key, { lang = 'ja' } = {}) {
    const r = this.items[key];
    if (!r) return '';
    const en = lang === 'en';
    const v = VERB[r.kind] || VERB.item;
    const parts = [];
    if (r.tries > 0) {
      if (r.ok === 0) parts.push(en ? `tried ${r.tries} time${r.tries > 1 ? 's' : ''}, ${v.ngEn} (${this.timeText(r, { en })})` : `${r.tries}回試して、${v.ng} (${this.timeText(r)})`);
      else if (r.ok === r.tries) parts.push(en ? `${v.okEn} ${r.ok} time${r.ok > 1 ? 's' : ''} (${this.timeText(r, { avg: true, en })})` : `${r.ok}回${v.ok} (${this.timeText(r, { avg: true })})`);
      else parts.push(en ? `tried ${r.tries} times, ${v.okEn} ${r.ok} of them (${this.timeText(r, { en })})` : `${r.tries}回試して${r.ok}回${v.ok} (${this.timeText(r)})`);
    }
    if (r.heardTries > 0 && r.heardLast) {
      // 聞いた相手 (新しい人を先に2人まで)。手に入った/入らなかったは最後に聞いた話
      const who = [r.heardLast.from, ...Object.keys(r.heardFrom || {}).filter((n) => n !== r.heardLast.from)].slice(0, 2);
      parts.push(en ? `heard from ${who.join(' and ')} that ${r.heardLast.ok ? 'it could be got' : 'it could not be got'}` : `${who.join('・')}から${r.heardLast.ok ? '手に入った' : '手に入らなかった'}と聞いた`);
    }
    if (!parts.length) return '';
    const name = en ? nameEn(r.kind, r.target, r.give) : nameJa(r.kind, r.target, r.give);
    return en ? `${name}: ${parts.join('; ')}` : `${name}は${parts.join('。')}`;
  }

  // 言葉の一覧 (新しい順に maxLines)。first: 先に出すキー (今のゴールなど)
  lines({ lang = 'ja', max = this.cfg.words.maxLines, first = [] } = {}) {
    const keys = Object.keys(this.items).filter((k) => this.items[k].tries > 0 || this.items[k].heardTries > 0)
      .sort((a, b) => (this.items[b].last || 0) - (this.items[a].last || 0));
    const order = [...first.filter((k) => keys.includes(k)), ...keys.filter((k) => !first.includes(k))];
    return order.slice(0, max).map((k) => this.lineOf(k, { lang })).filter(Boolean);
  }

  text(opts = {}) { return this.lines(opts).join('\n'); }

  // 記録用 (数値。モデルには渡さない)
  snapshot() {
    return Object.fromEntries(Object.entries(this.items).map(([k, r]) => [k, { tries: r.tries, ok: r.ok, decisions: r.decisions, gameTicks: r.gameTicks, heard: r.heardTries, heardOk: r.heardOk, ...this.success(k) }]));
  }
}

module.exports = { Experience, DEFAULTS, expKey, saidExperience, OK_RESULTS, FAIL_RESULTS };
