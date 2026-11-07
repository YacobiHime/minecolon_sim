'use strict';
// search: ゴールに向けて「探しながら歩く」(2026-11-07 ユーザー決定 1・2・4)。
//   道筋 (goalpath の planner の手順) に要る物 (掘る元のブロック・倒す生き物・畑の水) が今見えていないとき、
//   まだ行っていない方へ、周りを見ながら歩く。歩いている途中で次のどれかが見えたら移動を区切って判断に戻る (割り込み):
//     goal    道筋に出る物 (ブロック・生き物) が見えた → 見つけたブロックは場所として覚える (memory.notePlace → M番号)
//     hostile 敵が近くに来た (hostileRadius 以内)
//     called  自分の名前を呼ばれた・頼まれた・誘われた (choice_weight.isCalled)
//     person  しばらく見ていなかった人が見えた (newPersonTicks 判断のあいだ見ていない人)
//   割り込みのあと、次の判断に「このまま進む (continue)」を出す。Jev が寄り道 (見つけた物に関わる行動) か continue かを選ぶ。
//   方角は人ごとに散らす: 自分が行ったマス、見聞きして「ほかの人が行った」と分かっているマス (聞いた場所・見かけた人の居た所) を避け、
//   人ごとの好みの方角 (名前から決まる) で少しずらす。全員の踏破は見ない。
//   歩く距離は、探検の反応の強さ T (division.js の exploring。好奇心・勇敢さで θ が下がる) で minDist〜maxDist。
// 研究方針: 数値はここで持ち、モデルには言葉 (方角・遠さの段階・行ったか・誰が行ったと聞いた/見たか) だけ。評価語・誘導は書かない。
const { DIRS8, VEC, sectorOf } = require('./explore');
const { dist3 } = require('./util');
const { isCalled } = require('./choice_weight');

const SEARCH_DEFAULTS = {
  enabled: false,
  minDist: 24, maxDist: 80, // 1回の search で歩く距離 (探検の T = 0 → minDist、T = 1 → maxDist)
  choices: 3, // 方角の候補の数 (点の高い順)
  othersWeight: 1, // ほかの人が行ったと分かっているマスの引き (1 = 自分が行ったマスと同じだけ避ける)
  jitter: 0.25, // 人ごとの好みの方角の重み (同じ所から出た人がばらけるように)
  scanMs: 1000, // 歩いている間に周りを見る間隔
  hostileRadius: 12,
  newPersonTicks: 20, // この判断の数のあいだ見ていない人が見えたら「新しい人」
  continueTicks: 3, // 割り込みのあと「このまま進む」を出す判断の数
  minLeft: 8, // 残りがこれより短ければ continue を出さない
  interrupts: ['hostile', 'called', 'goal', 'person'], // 割り込みの種類 (この順に見る)
  maxNames: 12,
};

function cfgOf(c) { return { ...SEARCH_DEFAULTS, ...(c || {}) }; }

const JP = { north: '北', northeast: '北東', east: '東', southeast: '南東', south: '南', southwest: '南西', west: '西', northwest: '北西' };
const DIST_EN = (d) => (d < 20 ? 'a short way' : d < 50 ? 'a long way' : 'a very long way');

// 名前 → 0〜1 (人ごとの好みの方角)
function hash01(s) {
  let h = 2166136261;
  for (const ch of String(s || '')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return (h % 100000) / 100000;
}

// 道筋 (planner の path) から、探す物の名前。primary = 道筋の次に要る物 (見えていなければ)、names = 割り込みに使う全部
//   visible: 今見えているブロック・生き物の名前の Set
function searchTargets(path, visible = new Set()) {
  if (!path || !path.ok) return null;
  const names = [];
  const add = (n) => { if (n && !names.includes(n)) names.push(n); };
  const of = (s) => {
    if (!s) return [];
    if (s.how === 'collect' || s.how === 'kill') return [s.from];
    if (s.how === 'farm' && s.water && s.water.ready === false && s.water.where !== 'visible') return ['water'];
    if (s.how === 'tree' && s.groundWhere === 'unknown' && s.ground) return [s.ground];
    return [];
  };
  const nextNames = of(path.next);
  for (const n of nextNames) add(n);
  for (const s of path.steps || []) for (const n of of(s)) add(n);
  if (!names.length) return null;
  const missing = names.filter((n) => !visible.has(n));
  if (!missing.length) return null;
  const primary = nextNames.find((n) => !visible.has(n)) || missing[0];
  return { primary, names };
}

// 探検の T → 歩く距離
function searchDistance(T, c = {}) {
  const o = cfgOf(c);
  const t = Number.isFinite(T) ? Math.max(0, Math.min(1, T)) : 0;
  return Math.round(o.minDist + (o.maxDist - o.minDist) * t);
}

// 見聞きして「ほかの人が行った」と分かっているマス: 聞いた場所 (memory.places の from) と、見かけた人の居た所 (memory.extra.othersSeen)
//   返り値 Map "cx,cz" → { heard: Set(名前), seen: Set(名前) }
function othersCells(memory, cellSize = 16) {
  const m = new Map();
  const at = (x, z) => { const k = `${Math.floor(x / cellSize)},${Math.floor(z / cellSize)}`; if (!m.has(k)) m.set(k, { heard: new Set(), seen: new Set() }); return m.get(k); };
  for (const p of (memory && memory.places) || []) if (p.from && Number.isFinite(p.x)) at(p.x, p.z).heard.add(p.from);
  for (const s of (memory && memory.extra && memory.extra.othersSeen) || []) {
    const k = `${s.cx},${s.cz}`;
    if (!m.has(k)) m.set(k, { heard: new Set(), seen: new Set() });
    m.get(k).seen.add(s.who);
  }
  return m;
}

// 見かけた人の居たマスを覚える (memory.extra.othersSeen = [{ cx, cz, who, t }]、新しい順に max 件)
function noteOthersSeen(memory, people, { cellSize = 16, tick = 0, max = 200, ttl = 400, me = null } = {}) {
  if (!memory) return;
  memory.extra = memory.extra || {};
  const list = (memory.extra.othersSeen || []).filter((s) => tick - s.t <= ttl);
  for (const p of people || []) {
    if (!p || !p.pos || p.name === me) continue;
    const cx = Math.floor(p.pos.x / cellSize); const cz = Math.floor(p.pos.z / cellSize);
    const old = list.find((s) => s.cx === cx && s.cz === cz && s.who === p.name);
    if (old) old.t = tick; else list.push({ cx, cz, who: p.name, t: tick });
  }
  list.sort((a, b) => b.t - a.t);
  memory.extra.othersSeen = list.slice(0, max);
}

// 8方位の点。dist 先までの道のりのマス (cellSize ごと) のうち、自分も行っていない・ほかの人が行ったとも分かっていない割合 + 人ごとの好み
function directionScores(here, o = {}) {
  const c = cfgOf(o);
  const size = o.cellSize || 16;
  const dist = o.dist || c.minDist;
  const own = new Map();
  for (const x of o.cells || []) if (x.n) own.set(`${x.cx},${x.cz}`, x);
  const oc = o.othersCells || new Map();
  const pref = hash01(o.name) * Math.PI * 2;
  const out = [];
  for (const [d] of DIRS8) {
    const [vx, vz] = VEC[d];
    let n = 0; let fresh = 0; let mine = 0;
    const heard = new Set(); const seen = new Set();
    const keys = new Set();
    for (let s = size; s <= dist + 1e-6; s += size) {
      const k = `${Math.floor((here.x + vx * s) / size)},${Math.floor((here.z + vz * s) / size)}`;
      if (keys.has(k)) continue;
      keys.add(k);
      n += 1;
      const isMine = own.has(k);
      const ot = oc.get(k);
      const isOthers = !!ot && (ot.heard.size + ot.seen.size) > 0;
      if (isMine) mine += 1;
      if (ot) { for (const w of ot.heard) heard.add(w); for (const w of ot.seen) seen.add(w); }
      fresh += isMine ? 0 : isOthers ? 1 - c.othersWeight : 1;
    }
    const f = n ? fresh / n : 0;
    const ang = Math.atan2(vz, vx);
    const bonus = c.jitter * (1 + Math.cos(ang - pref)) / 2;
    out.push({ dir: d, score: Math.round((f + bonus) * 1000) / 1000, fresh: Math.round(f * 1000) / 1000, mineFrac: n ? mine / n : 0, heard: [...heard], seen: [...seen] });
  }
  return out.sort((a, b) => b.score - a.score);
}

function ownText(fr) { return fr === 0 ? '行ったことなし' : fr < 0.5 ? '少し行ったことがある' : 'ほとんど行ったことがある'; }
function ownTextEn(fr) { return fr === 0 ? 'never been there' : fr < 0.5 ? 'been to a little of it' : 'been to most of it'; }
function othersText(s) {
  const t = [];
  if (s.heard.length) t.push(`${s.heard.slice(0, 3).join('・')}が言っていた場所がある`);
  if (s.seen.length) t.push(`${s.seen.slice(0, 3).join('・')}を見かけた`);
  return t.join('・');
}
function othersTextEn(s) {
  const t = [];
  if (s.heard.length) t.push(`${s.heard.slice(0, 3).join(', ')} spoke of a place that way`);
  if (s.seen.length) t.push(`saw ${s.seen.slice(0, 3).join(', ')} that way`);
  return t.join('; ');
}

// search の行動 (actions の要素) を作る。null = 出さない
//   o: { targets ({primary, names}), here, cells, othersCells, cellSize, dist, name, active (続きの状態), cfg }
function searchAction(o = {}) {
  const c = cfgOf(o.cfg);
  if (!c.enabled || !o.targets || !o.here) return null;
  const here = o.here;
  const what = o.targets.primary;
  const dist = o.dist || c.minDist;
  const choices = [];
  const act = o.active;
  if (act && act.target && act.what) {
    const left = Math.round(Math.hypot(act.target.x - here.x, act.target.z - here.z));
    if (left >= c.minLeft) {
      choices.push({ id: 'continue', label: `このまま${JP[act.dir] || act.dir}へ${act.what}を探しながら歩く (残り約${left}m)`,
        labelEn: `keep walking ${act.dir} looking for ${act.what} (${DIST_EN(left)} left)`, dir: act.dir, target: { x: act.target.x, z: act.target.z }, what: act.what, dist: left, continued: true });
    }
  }
  const sc = directionScores(here, { ...c, cells: o.cells, othersCells: o.othersCells, cellSize: o.cellSize, dist, name: o.name });
  for (const s of sc.slice(0, c.choices)) {
    const [vx, vz] = VEC[s.dir];
    const ot = othersText(s); const otEn = othersTextEn(s);
    choices.push({ id: s.dir, label: `${what}を探しながら${JP[s.dir]}へ歩く (約${dist}m・${ownText(s.mineFrac)}${ot ? `・${ot}` : ''})`,
      labelEn: `look for ${what} while walking ${s.dir}, ${DIST_EN(dist)} (${ownTextEn(s.mineFrac)}${otEn ? `; ${otEn}` : ''})`,
      dir: s.dir, target: { x: here.x + vx * dist, z: here.z + vz * dist }, what, dist, score: s.score });
  }
  if (!choices.length) return null;
  return {
    name: 'search',
    desc: '道筋に要る物を探しながら、周りを見て歩く (何か見えたら途中で止まる)',
    descEn: 'walk while looking around for something the plan needs (stops partway when something comes into view)',
    argType: 'choice', choices, names: o.targets.names,
  };
}

// ---- 歩いている間に見る (bot を使う) ----
// 今見えている物の一覧 (割り込みの候補)。watch: { names: Set, me, hostile: Set, visionRadius, hostileRadius, known: Set(人), heard: () => [], blockVisible, entityVisible }
function scanAll(bot, watch) {
  const hits = [];
  if (!bot || !bot.entity) return hits;
  const here = bot.entity.position;
  const vr = watch.visionRadius ?? 16;
  // 敵
  for (const e of Object.values(bot.entities || {})) {
    if (!e || e === bot.entity || !e.position) continue;
    const d = dist3(here, e.position);
    const nm = e.name || '';
    if (watch.hostile && watch.hostile.has(nm) && d <= (watch.hostileRadius ?? 12)) hits.push({ kind: 'hostile', what: nm, id: e.id, pos: round(e.position), d: Math.round(d) });
    else if (e.type === 'player' && e.username && e.username !== watch.me && d <= vr) hits.push({ kind: 'person', what: e.username, id: e.username, pos: round(e.position), d: Math.round(d) });
    else if (watch.names && watch.names.has(nm) && d <= vr && (!watch.entityVisible || watch.entityVisible(bot, e))) hits.push({ kind: 'goal', what: nm, id: `mob:${nm}`, mob: true, pos: round(e.position), d: Math.round(d) });
  }
  // 呼ばれた・頼まれた (近くの声の中に自分の名前)
  for (const h of (watch.heard ? watch.heard() : [])) {
    if (h && h.text && watch.me && (watch.isCalled ? watch.isCalled(h.text, watch.me) : isCalled(h.text, watch.me))) hits.push({ kind: 'called', what: h.from, id: h, text: String(h.text).slice(0, 60), d: h.d ?? null });
  }
  // 道筋に出るブロック
  if (watch.names && watch.names.size && bot.registry && typeof bot.findBlocks === 'function') {
    const ids = [...watch.names].map((n) => bot.registry.blocksByName && bot.registry.blocksByName[n]).filter(Boolean).map((b) => b.id);
    if (ids.length) {
      let ps = [];
      try { ps = bot.findBlocks({ matching: ids, maxDistance: vr, count: 16 }) || []; } catch (_) { ps = []; }
      const seenKinds = new Set();
      for (const p of ps.sort((a, b) => dist3(here, a) - dist3(here, b))) {
        let name = null;
        try { const b = bot.blockAt(p); name = b && b.name; } catch (_) { name = null; }
        if (!name || seenKinds.has(name)) continue;
        if (watch.blockVisible && !watch.blockVisible(bot, p)) continue;
        seenKinds.add(name);
        hits.push({ kind: 'goal', what: name, id: `block:${name}`, pos: { x: p.x, y: p.y, z: p.z }, d: Math.round(dist3(here, p)) });
      }
    }
  }
  return hits;
}

function round(p) { return { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 }; }

// 割り込みにする1つを選ぶ (純粋)。hits: scanAll の値、ignore: 歩き始めたときに見えていた物の id の Set、known: 最近見た人の Set
function pickInterrupt(hits, { ignore = new Set(), known = new Set(), kinds = SEARCH_DEFAULTS.interrupts } = {}) {
  for (const k of kinds) {
    const cand = hits.filter((h) => h.kind === k && !ignore.has(h.id) && !(k === 'person' && known.has(h.what)));
    if (cand.length) return cand.sort((a, b) => (a.d ?? 0) - (b.d ?? 0))[0];
  }
  return null;
}

// 割り込みの文 (日本語。en.js の表で英語にする)
function interruptText(h) {
  if (!h) return '';
  if (h.kind === 'goal') return `${h.what}が見えた`;
  if (h.kind === 'hostile') return `敵の${h.what}が見えた`;
  if (h.kind === 'called') return `${h.what}に呼ばれた`;
  if (h.kind === 'person') return `しばらく見ていなかった${h.what}が見えた`;
  return '';
}

module.exports = { SEARCH_DEFAULTS, cfgOf, hash01, searchTargets, searchDistance, othersCells, noteOthersSeen, directionScores, searchAction, scanAll, pickInterrupt, interruptText, sectorOf };
