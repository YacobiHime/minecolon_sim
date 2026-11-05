'use strict';
// 全体チャット・提案と取り決め・共有のチェスト・共同の目標 (cfg.board)。bot に依存しない部品 (つなぎは agent.js)。
// 研究方針: 仕様・事実は見せるが、使い方は教えない。数はコードで持ち、モデルには言葉だけ (Jev には英語、2B には日本語)。
//
// プロセスをまたぐ共有: サーバーの全体チャット (bot.chat)。行の頭に【…】の印を付け、全員が同じ行を受け取って
//   それぞれの Board に同じように積む (近くの声は印なしの行。agent.onChat が印のある行を近くの声から外す)。
//   【全体】文                                  broadcast (中身は 2B)
//   【提案 id n=N rule:item>chest】文           propose。spec は rule:item>chest | project:item*count | text
//   【賛成 id】 / 【反対 id】                     vote (Jev の noul から)
//   【共有 chestId@x,y,z】                      share_chest (ここのチェストを共有にする)
//   【箱 chestId who +item n】name:count,...     共有のチェストの中身 (入れた・出した・見た)
//   【置いた item n】                            共同の目標の物を置いた
// 取り決め: 提案の時点の生きている人数 n を行に入れ、賛成 (提案者を含む) が ratio × n を超えたら成立 (全員が同じ数で数える)。
// 守ったか・破ったか: rule (物を共有のチェストに入れる) は、chest_put / chest_take から数える (agent)。
//   共有のチェストから出したことは【箱】の行で全員に届くので、提案者は「破られた」と知る (Jev の印象の質問に出す)。
const { dist3 } = require('./util');
const en = require('./en');

const DEFAULTS = {
  enabled: false,
  maxBoard: 4, // Jev の state.board に入れる全体チャットの数
  keepTicks: 8, // 全体チャットを state に出しておく判断の数
  agreeRatio: 1 / 3, // 賛成がこの割合 × 生きている人数を超えたら成立
  voteThreshold: 0.5, // Jev の noul がこれ以上なら賛成
  proposalTtlMs: 600000, // 提案の受付の長さ
  maxOpen: 2, // 1回の判断で賛成を聞く提案の数
  maxShared: 4, // 共有のチェストの数の上限 (全体)
  maxChestItems: 6, // 中身を何種類まで見せるか
  maxAgreements: 4,
  maxProjects: 3,
  maxBreaches: 2,
  breachKeepTicks: 12,
  textMax: 60, // 発言・提案の文の長さ
};

const TAG = /^【(全体|提案|賛成|反対|共有|箱|置いた)([^】]*)】(.*)$/;
const ID_RE = /^[A-Za-z0-9_-]+#\d+$/;
const CHEST_RE = /^[A-Za-z0-9_-]+-\d+$/;
const ITEM_RE = /^[a-z0-9_]+$/;

function clean(s, n = 120) { return String(s || '').replace(/[【】\n\r]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n); }
function posStr(p) { return `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`; }
function parsePos(s) { const m = String(s || '').match(/^(-?\d+),(-?\d+),(-?\d+)$/); return m ? { x: +m[1], y: +m[2], z: +m[3] } : null; }
function itemsStr(items, max = 12) { return (items || []).filter((i) => i && i.count > 0).slice(0, max).map((i) => `${i.name}:${i.count}`).join(','); }
function parseItems(s) {
  const out = [];
  for (const part of String(s || '').split(',')) { const m = part.trim().match(/^([a-z0-9_]+):(\d+)$/); if (m) out.push({ name: m[1], count: +m[2] }); }
  return out;
}

// ---- 行を作る ----
function specStr(spec) {
  if (spec && spec.type === 'rule' && spec.item && spec.chest) return `rule:${spec.item}>${spec.chest}`;
  if (spec && spec.type === 'project' && spec.item) return `project:${spec.item}*${Math.max(1, spec.count | 0 || 1)}`;
  return 'text';
}
const line = {
  say: (text) => `【全体】${clean(text)}`,
  propose: ({ id, n, spec, text }) => `【提案 ${id} n=${n} ${specStr(spec)}】${clean(text)}`,
  vote: (id, yes) => `【${yes ? '賛成' : '反対'} ${id}】`,
  share: (chestId, pos) => `【共有 ${chestId}@${posStr(pos)}】`,
  chest: (chestId, who, delta, items) => `【箱 ${chestId} ${who}${delta && delta.item ? ` ${delta.n >= 0 ? '+' : '-'}${delta.item} ${Math.abs(delta.n)}` : ''}】${itemsStr(items)}`,
  placed: (item, n = 1) => `【置いた ${item} ${n}】`,
};

// ---- 行を読む ---- → { type, ... } | null (印のない行・壊れた行は null)
function parseLine(text) {
  const m = String(text || '').match(TAG);
  if (!m) return null;
  const [, tag, headRaw, body] = m;
  const head = headRaw.trim().split(/\s+/).filter(Boolean);
  if (tag === '全体') return body.trim() ? { type: 'say', text: body.trim() } : null;
  if (tag === '賛成' || tag === '反対') return ID_RE.test(head[0] || '') ? { type: 'vote', id: head[0], yes: tag === '賛成' } : null;
  if (tag === '提案') {
    const [id, nTok, specTok = 'text'] = head;
    const n = nTok && /^n=\d+$/.test(nTok) ? Number(nTok.slice(2)) : null;
    if (!ID_RE.test(id || '') || !n || !body.trim()) return null;
    let spec = { type: 'text' };
    let mm = specTok.match(/^rule:([a-z0-9_]+)>([A-Za-z0-9_-]+-\d+)$/);
    if (mm) spec = { type: 'rule', item: mm[1], chest: mm[2] };
    mm = specTok.match(/^project:([a-z0-9_]+)\*(\d+)$/);
    if (mm) spec = { type: 'project', item: mm[1], count: Math.max(1, Math.min(64, +mm[2])) };
    return { type: 'propose', id, n, spec, text: body.trim() };
  }
  if (tag === '共有') {
    const mm = (head[0] || '').match(/^([A-Za-z0-9_-]+-\d+)@(-?\d+,-?\d+,-?\d+)$/);
    return mm ? { type: 'share', chest: mm[1], pos: parsePos(mm[2]) } : null;
  }
  if (tag === '箱') {
    const [chest, who, d, n] = head;
    if (!CHEST_RE.test(chest || '') || !who) return null;
    let delta = null;
    const dm = (d || '').match(/^([+-])([a-z0-9_]+)$/);
    if (dm && /^\d+$/.test(n || '')) delta = { item: dm[2], n: (dm[1] === '-' ? -1 : 1) * Number(n) };
    return { type: 'chest', chest, who, delta, items: parseItems(body) };
  }
  if (tag === '置いた') {
    const [item, n] = head;
    return ITEM_RE.test(item || '') ? { type: 'placed', item, n: Math.max(1, Number(n) || 1) } : null;
  }
  return null;
}

// ---- 共有の板 (1人に1つ。全員が同じ行を受け取るので、ほぼ同じ中身になる) ----
class Board {
  constructor({ cfg = {}, me = null } = {}) {
    this.cfg = { ...DEFAULTS, ...cfg };
    this.me = me;
    this.seq = 0;
    this.messages = []; // { seq, t, tick, from, text, kind: 'say'|'propose', pid }
    this.proposals = new Map(); // id → { id, by, text, spec, n, t, tick, yes: Set, no: Set, status, agreedAt, placed }
    this.chests = new Map(); // chestId → { id, by, pos, items: [{name,count}], t, known }
    this.breaches = []; // 自分の提案が破られたと知ったもの { tick, who, chest, item, n, agreement }
  }

  need(p) { return Math.floor(this.cfg.agreeRatio * p.n) + 1; } // 「超えたら」: ratio × n より多い最小の数

  // 受け取った行を積む。返り値: 起きたこと [{ type: 'message'|'proposal'|'vote'|'agreed'|'share'|'chest'|'breach'|'project_done'|'placed', ... }]
  receive(from, msg, { t = Date.now(), tick = 0 } = {}) {
    const out = [];
    if (!msg || !from) return out;
    if (msg.type === 'say') {
      const m = { seq: ++this.seq, t, tick, from, text: clean(msg.text, this.cfg.textMax * 2), kind: 'say' };
      this.messages.push(m); this.trim();
      out.push({ type: 'message', m });
    } else if (msg.type === 'propose') {
      if (this.proposals.has(msg.id)) return out;
      const p = { id: msg.id, by: from, text: clean(msg.text, this.cfg.textMax * 2), spec: msg.spec || { type: 'text' }, n: msg.n, t, tick, yes: new Set([from]), no: new Set(), status: 'open', agreedAt: null, placed: 0, kept: 0, broken: 0 };
      this.proposals.set(p.id, p);
      const m = { seq: ++this.seq, t, tick, from, text: p.text, kind: 'propose', pid: p.id };
      this.messages.push(m); this.trim();
      out.push({ type: 'proposal', p }, { type: 'message', m });
      out.push(...this.checkAgreed(p, t, tick));
    } else if (msg.type === 'vote') {
      const p = this.proposals.get(msg.id);
      if (!p) return out;
      // 1人1票 (言い直したら後の方)。成立したあとの票も数だけは数える
      p.yes.delete(from); p.no.delete(from);
      (msg.yes ? p.yes : p.no).add(from);
      out.push({ type: 'vote', p, from, yes: msg.yes });
      out.push(...this.checkAgreed(p, t, tick));
    } else if (msg.type === 'share') {
      if (this.chests.has(msg.chest) || !msg.pos) return out;
      if (this.chests.size >= this.cfg.maxShared) return out;
      if (this.chestAt(msg.pos)) return out; // 同じ場所は1つ
      const c = { id: msg.chest, by: from, pos: msg.pos, items: [], t, known: false };
      this.chests.set(c.id, c);
      out.push({ type: 'share', c });
    } else if (msg.type === 'chest') {
      const c = this.chests.get(msg.chest);
      if (!c) return out;
      c.items = msg.items || []; c.known = true; c.t = t;
      out.push({ type: 'chest', c, who: msg.who, delta: msg.delta });
      if (msg.delta && msg.delta.item) {
        for (const p of this.agreedRules()) {
          if (p.spec.chest !== c.id || p.spec.item !== msg.delta.item) continue;
          if (msg.delta.n >= 0) p.kept += msg.delta.n; else p.broken += -msg.delta.n;
          // 取り決めの物を、その共有のチェストから出した → 提案者が自分なら「破られた」と知る
          if (msg.delta.n < 0 && p.by === this.me && msg.who !== this.me) {
            const b = { tick, t, who: msg.who, chest: c.id, item: msg.delta.item, n: -msg.delta.n, agreement: p.id };
            this.breaches.push(b);
            if (this.breaches.length > 10) this.breaches.shift();
            out.push({ type: 'breach', b, p });
          }
        }
      }
      out.push(...this.checkProjects(t, tick));
    } else if (msg.type === 'placed') {
      for (const p of this.agreedProjects()) if (p.spec.item === msg.item && p.status === 'agreed') { p.placed += msg.n; out.push({ type: 'placed', p, who: from, n: msg.n }); }
      out.push(...this.checkProjects(t, tick));
    }
    return out;
  }

  trim() { if (this.messages.length > 60) this.messages.splice(0, this.messages.length - 60); }

  checkAgreed(p, t, tick) {
    if (p.status !== 'open' || p.yes.size < this.need(p)) return [];
    p.status = 'agreed'; p.agreedAt = t; p.agreedTick = tick;
    return [{ type: 'agreed', p }];
  }

  // 受付の時間が過ぎた提案を閉じる
  expire(t = Date.now()) {
    const out = [];
    for (const p of this.proposals.values()) if (p.status === 'open' && t - p.t > this.cfg.proposalTtlMs) { p.status = 'expired'; out.push(p); }
    return out;
  }

  agreed() { return [...this.proposals.values()].filter((p) => p.status === 'agreed' || p.status === 'done'); }
  agreedRules() { return this.agreed().filter((p) => p.spec.type === 'rule' && this.chests.has(p.spec.chest)); }
  agreedProjects() { return this.agreed().filter((p) => p.spec.type === 'project'); }

  // 共同の目標の進み: 共有のチェストにあるその物の数 + 置いた数 (count まで)
  progress(p) {
    let n = p.placed || 0;
    for (const c of this.chests.values()) for (const i of c.items) if (i.name === p.spec.item) n += i.count;
    return Math.min(p.spec.count, n);
  }

  checkProjects(t, tick) {
    const out = [];
    for (const p of this.agreedProjects()) if (p.status === 'agreed' && this.progress(p) >= p.spec.count) { p.status = 'done'; p.doneAt = t; p.doneTick = tick; out.push({ type: 'project_done', p }); }
    return out;
  }

  activeProjectItems() { return new Set(this.agreedProjects().filter((p) => p.status === 'agreed').map((p) => p.spec.item)); }

  chestAt(pos) {
    if (!pos) return null;
    for (const c of this.chests.values()) if (dist3(c.pos, pos) <= 1.01) return c; // 大きいチェスト (2マス) は隣も同じ
    return null;
  }

  nextChestId(me) {
    let k = 0;
    for (const c of this.chests.values()) { const m = c.id.match(/^(.+)-(\d+)$/); if (m && m[1] === me) k = Math.max(k, +m[2]); }
    return `${me}-${k + 1}`;
  }

  // 自分の行動が取り決めに合ったか: chest_put (item を chestId に入れた。chestId が null なら共有でない入れ物) / chest_take (chestId から出した)
  //   返り値 [{ p, kept: bool, how }]
  checkOwn(action, item, chestId) {
    const out = [];
    for (const p of this.agreedRules()) {
      if (p.spec.item !== item) continue;
      if (action === 'chest_put') out.push({ p, kept: chestId === p.spec.chest, how: chestId === p.spec.chest ? 'put_agreed_chest' : chestId ? 'put_other_shared_chest' : 'put_other_container' });
      if (action === 'chest_take' && chestId === p.spec.chest) out.push({ p, kept: false, how: 'took_from_agreed_chest' });
    }
    return out;
  }

  // 賛成するかをまだ決めていない、ほかの人の受付中の提案 (古い順に maxOpen まで)
  openFor(me, asked = new Set()) {
    return [...this.proposals.values()].filter((p) => p.status === 'open' && p.by !== me && !p.yes.has(me) && !p.no.has(me) && !asked.has(p.id))
      .sort((a, b) => a.t - b.t).slice(0, this.cfg.maxOpen);
  }

  // 全体チャットのうち、state に出すもの。優先: 自分の名前が出た > 自分のゴール・道筋の物の名前が出た > 関係の強い人 (中身は評価しない)
  //   names: 道筋の物の名前 (英語の名前と日本語の名前)。strength(name) → 0〜1 (関係の強さ)
  select({ me = this.me, tick = 0, names = [], strength = () => 0, max = this.cfg.maxBoard, keepTicks = this.cfg.keepTicks } = {}) {
    const cands = this.messages.filter((m) => m.from !== me && tick - m.tick <= keepTicks);
    const nm = [...new Set(names)].filter((x) => x && String(x).length >= 2);
    const scored = cands.map((m) => {
      const mine = !!me && m.text.includes(me);
      const hit = nm.find((x) => m.text.includes(x)) || null;
      const s = strength(m.from) || 0;
      const why = mine ? 'name' : hit ? 'item' : 'relation';
      return { m, why, hit, key: (mine ? 2 : 0) + (hit ? 1 : 0) + Math.max(0, Math.min(0.99, s)) };
    });
    scored.sort((a, b) => (b.key - a.key) || (b.m.seq - a.m.seq));
    return scored.slice(0, max).map((x) => ({ ...x.m, why: x.why, hit: x.hit }));
  }

  // ---- 文 (Jev の英語・2B の日本語) ----
  chestLabelEn(c) { return chestLabelEn(c.id); }
  chestLabelJa(c) { return chestLabelJa(c.id); }

  chestItemsText(c, lang = 'en') {
    if (!c.known) return lang === 'en' ? 'contents not seen yet' : '中身はまだ分からない';
    const its = c.items.filter((i) => i.count > 0).sort((a, b) => b.count - a.count);
    if (!its.length) return lang === 'en' ? 'empty' : '空';
    const shown = its.slice(0, this.cfg.maxChestItems).map((i) => `${i.name} ${i.count}`).join(', ');
    return its.length > this.cfg.maxChestItems ? `${shown}${lang === 'en' ? ', and more' : ' ほか'}` : shown;
  }

  ruleTextEn(p) {
    const c = this.chests.get(p.spec.chest);
    return `${p.spec.item} goes into ${c ? this.chestLabelEn(c) : p.spec.chest}`;
  }

  agreementEn(p) {
    const body = p.spec.type === 'rule' && this.chests.has(p.spec.chest) ? `${this.ruleTextEn(p)} 「${p.text}」` : `「${p.text}」`;
    return `${body} (proposed by ${p.by}; ${en.countWord(p.yes.size)} agreed)`;
  }

  projectEn(p) {
    const done = p.status === 'done';
    return `${p.spec.item} x${p.spec.count} (proposed by ${p.by}; ${en.countWord(p.yes.size)} agreed) — ${this.progress(p)}/${p.spec.count}${done ? ', done' : ''}`;
  }

  // Jev の state に足すもの。here: 自分の位置、relationEn(name): 関係の言葉、me
  //   返り値 { state: { board, agreements, projects, shared_chests, broken_agreements }, open: { q1: 文 }, openMap: { q1: 提案の id }, breakers: [名前], shown }
  stateEn({ me = this.me, tick = 0, here = null, shown = [], open = [], relationEn = () => 'stranger', personalRel = true } = {}) {
    const st = {};
    if (shown.length) st.board = shown.map((m) => (m.kind === 'propose' ? `${m.from} proposed to everyone「${m.text}」` : `${m.from} said to everyone「${m.text}」`) + ` (${agoEn(tick - m.tick)})`);
    const ag = this.agreed().filter((p) => p.spec.type !== 'project').slice(-this.cfg.maxAgreements);
    if (ag.length) st.agreements = ag.map((p) => this.agreementEn(p));
    const pj = this.agreedProjects().slice(-this.cfg.maxProjects);
    if (pj.length) st.projects = pj.map((p) => this.projectEn(p));
    const cs = [...this.chests.values()];
    if (cs.length) {
      cs.sort((a, b) => (here ? dist3(here, a.pos) - dist3(here, b.pos) : 0));
      st.shared_chests = cs.map((c) => `${this.chestLabelEn(c)}${here ? ` (${en.whereEn(here, c.pos)})` : ''}: ${this.chestItemsText(c, 'en')}`);
    }
    const br = this.breaches.filter((b) => tick - b.tick <= this.cfg.breachKeepTicks).slice(-this.cfg.maxBreaches);
    if (br.length) st.broken_agreements = br.map((b) => { const p = this.proposals.get(b.agreement); const c = this.chests.get(b.chest); return `${b.who} took ${b.item} x${b.n} out of ${c ? this.chestLabelEn(c) : b.chest}, against your agreement「${p ? p.text : ''}」`; });
    const openOut = {}; const openMap = {};
    open.forEach((p, i) => {
      const q = `q${i + 1}`;
      const body = p.spec.type === 'rule' && this.chests.has(p.spec.chest) ? `${this.ruleTextEn(p)}「${p.text}」` : p.spec.type === 'project' ? `everyone makes or gathers ${p.spec.item} x${p.spec.count}「${p.text}」` : `「${p.text}」`;
      openOut[q] = `${p.by} proposes: ${body} (${en.countWord(p.yes.size)} agreed so far; ${personalRel ? `you and ${p.by}: ${relationEn(p.by)}` : ''})`;
      openMap[q] = p.id;
    });
    return { state: st, open: openOut, openMap, breakers: [...new Set(br.map((b) => b.who))] };
  }

  // 2B に見せる日本語 (talker・ゴール選び)
  textJa({ tick = 0, here = null, shown = [], relDir = null } = {}) {
    const lines = [];
    if (shown.length) lines.push(`## 全体に届いた話\n${shown.map((m) => `${m.from}${m.kind === 'propose' ? 'の提案' : ''}「${m.text}」`).join('\n')}`);
    const ag = this.agreed().filter((p) => p.spec.type !== 'project').slice(-this.cfg.maxAgreements);
    if (ag.length) lines.push(`## 取り決め\n${ag.map((p) => `- ${p.text} (${p.by}の提案、賛成 ${p.yes.size})`).join('\n')}`);
    const pj = this.agreedProjects().slice(-this.cfg.maxProjects);
    if (pj.length) lines.push(`## 共同の目標\n${pj.map((p) => `- ${p.spec.item} ${p.spec.count} (${p.by}の提案) — 今 ${this.progress(p)}/${p.spec.count}${p.status === 'done' ? '・達成' : ''}`).join('\n')}`);
    const cs = [...this.chests.values()];
    if (cs.length) lines.push(`## 共有のチェスト\n${cs.map((c) => `- ${c.id}${here && relDir ? ` (${relDir(here, c.pos)})` : ''}: ${this.chestItemsText(c, 'ja')}`).join('\n')}`);
    return lines.join('\n');
  }

  // 記録用の要約
  snapshot() {
    return {
      proposals: [...this.proposals.values()].map((p) => ({ id: p.id, by: p.by, text: p.text, spec: p.spec, n: p.n, need: this.need(p), yes: [...p.yes], no: [...p.no], status: p.status, progress: p.spec.type === 'project' ? this.progress(p) : null, kept: p.kept, broken: p.broken })),
      chests: [...this.chests.values()].map((c) => ({ id: c.id, by: c.by, pos: c.pos, items: c.items })),
    };
  }
}

// 共有のチェストの名前 (id "Hanako-1" → "Hanako's chest 1 (shared)" / "共有のチェスト Hanako-1")
function chestLabelEn(id) { const m = String(id).match(/^(.+)-(\d+)$/); return m ? `${m[1]}'s chest ${m[2]} (shared)` : `${id} (shared chest)`; }
function chestLabelJa(id) { return `共有のチェスト ${id}`; }
function agoEn(d) { return d <= 0 ? 'just now' : d === 1 ? 'one turn ago' : d <= 4 ? 'a few turns ago' : 'a while ago'; }

module.exports = { chestLabelEn, chestLabelJa, Board, DEFAULTS, parseLine, line, specStr, agoEn, parsePos, posStr };
