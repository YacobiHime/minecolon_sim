'use strict';
// わだかまりのある相手への行動の候補 (2026-11-12 ユーザー決定)。bot に依存しない部品 (つなぎは conflict_agent.js)。
//   プログラムは状態 (わだかまり・殴られたこと) と選択肢を作るだけ。選ぶのは Jev (重みは掛けない)。
//   avoid_person  その相手から離れる
//   complain      文句を言う・責める
//   demand_back   取られた物を返してと求める
//   take_back     相手が置いている同じ種類の物を取り返す (所有の知識 cfg.provenance.actions が要る)
//   hit_person    殴る (cfg.conflict.aggression。1回の行動で hits 発まで。続けて選べば殺せる)
//   call_help     殴られたとき、周りに助けを求める
// 発話の行 (近くの声 hearRadius の中だけ): 【文句 相手 きっかけ】・【返して 相手 物】・【助けて 殴った人】。頭の印は機械が読み、後ろの文は確定した記録から作る。
const { relDir } = require('./util');
const { whereEn } = require('./en');
const { peopleOf } = require('./people');
const { GRUDGE_JA, GRUDGE_EN } = require('./social');

const DEFAULTS = {
  grudge: false, // A: わだかまり (好感の回復の上限・きっかけ・言葉)
  actions: false, // B: 悪い関係のときの行動の候補
  aggression: false, // 殴る (hit_person)。actions が on のときだけ効く
  threshold: 0.15, // この値以上のわだかまりのある相手に候補を出す
  nearRadius: 16, // 殴る・取り返すの相手の距離
  hits: 3, hitGapMs: 650, // 1回の hit_person で殴る数と間隔
  hitRecentTicks: 6, // 殴られてからこの判断の数のあいだ「殴られたばかり」(やり返す・逃げる・助けを呼ぶ)
  hitWindowMs: 800, hitReach: 4.5, // 殴った人の見分け: 傷を受ける直前に腕を振った、手の届く所の人
  callWaitTicks: 5, callNear: 8, // 呼んでからこの判断の数のうちに近く (callNear) に来なければ「来なかった」
  avoidDistance: 16,
  sayCooldown: 10, // 同じ相手に同じ行 (文句・返して) を続けて言わない判断の数
  cooldown: 10, // 同じ相手・同じきっかけのわだかまりを続けて足さない判断の数
  maxChoices: 4,
  speech: 'llm', // 'llm' (talker があれば確定した記録から発話を作る) | 'template'
  grudgeParams: {}, // social.js の GRUDGE_DEFAULTS への上書き (halfLife・ceilDrop・kinds など)
};

function cfgOf(c) {
  const m = { ...DEFAULTS, ...(c || {}) };
  if (c === false) { m.grudge = false; m.actions = false; m.aggression = false; }
  m.actions = !!m.actions && !!m.grudge; // 行動の候補は、わだかまりの状態が要る
  m.aggression = !!m.aggression && m.actions;
  return m;
}

const TAG = /^【(文句|返して|助けて) ([^】]*)】(.*)$/;
const NAME = /^[A-Za-z0-9_]{1,16}$/;
const WORD = /^[a-z0-9_]+$/;
function clean(s, n = 80) { return String(s || '').replace(/[【】\n\r]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n); }
const line = {
  complain: ({ target, kind }, text = '') => `【文句 ${target} ${kind}】${clean(text)}`,
  demand: ({ target, item }, text = '') => `【返して ${target} ${item}】${clean(text)}`,
  help: ({ attacker }, text = '') => `【助けて ${attacker}】${clean(text)}`,
};
function parseLine(text) {
  const m = String(text || '').match(TAG);
  if (!m) return null;
  const h = m[2].trim().split(/\s+/);
  if (!NAME.test(h[0] || '')) return null;
  if (m[1] === '文句') return WORD.test(h[1] || '') ? { type: 'complain', target: h[0], kind: h[1], text: m[3].trim() } : null;
  if (m[1] === '返して') return WORD.test(h[1] || '') ? { type: 'demand', target: h[0], item: h[1], text: m[3].trim() } : null;
  return { type: 'help', attacker: h[0], text: m[3].trim() };
}
function templateText(kind, r = {}) {
  if (kind === 'complain') return `${r.target}、${(GRUDGE_JA[r.kind] || (() => '嫌なことをされた'))(r.item)}のは嫌だった`;
  if (kind === 'demand') return `${r.target}、${r.item}を返して`;
  if (kind === 'help') return `誰か助けて、${r.attacker}に殴られた`;
  return '';
}

// view: { cfg, grudges: { 名前: { v, kind, item } }, hitBy: { 名前: 殴られた判断 }, tick, hearRadius, saidRecently(kind, name), takeBack: [{ player, block, pos }] }
// 返り値: 行動の一覧 (listActions の形)
function conflictActions(raw, view) {
  const out = [];
  if (!view || !view.cfg.actions) return out;
  const c = view.cfg;
  const here = raw.self.pos;
  const people = peopleOf(raw);
  const hear = view.hearRadius ?? 48;
  const recentHit = (n) => view.hitBy && view.hitBy[n] != null && view.tick - view.hitBy[n] <= c.hitRecentTicks;
  const g = (n) => (view.grudges && view.grudges[n] && view.grudges[n].v >= c.threshold ? view.grudges[n] : null);
  const foes = people.filter((p) => g(p.name) || recentHit(p.name)).sort((a, b) => a.d - b.d).slice(0, c.maxChoices);
  if (!foes.length) return out;
  const whatJa = (n) => { const x = g(n); return recentHit(n) && !(x && x.kind === 'hit') ? '殴られた' : x ? (GRUDGE_JA[x.kind] || (() => ''))(x.item) : '殴られた'; };
  const whatEn = (n) => { const x = g(n); return recentHit(n) && !(x && x.kind === 'hit') ? 'they hit you' : x ? (GRUDGE_EN[x.kind] || (() => ''))(x.item).replace(/\bmy\b/g, 'your').replace(/\bI\b/g, 'you').replace(/\bme\b/g, 'you') : 'they hit you'; };
  const lab = (p) => `${p.name} ${relDir(here, p.pos)} (${whatJa(p.name)})`;
  const labEn = (p) => `${p.name} (${whereEn(here, p.pos)}; ${whatEn(p.name)})`;
  const mk = (p, extra = {}) => ({ id: p.name, label: lab(p), labelEn: labEn(p), player: p.name, pos: p.pos, grudge: g(p.name) ? g(p.name).v : 0, kind: g(p.name) ? g(p.name).kind : 'hit', ...extra });
  out.push({ name: 'avoid_person', desc: 'その人から離れる', descEn: 'move away from that person', argType: 'choice', choices: foes.map((p) => mk(p, { from: [p.pos] })) });
  const said = (k, n) => (view.saidRecently ? view.saidRecently(k, n) : false);
  const talk = foes.filter((p) => p.d <= hear && g(p.name) && !said('complain', p.name));
  if (talk.length) out.push({ name: 'complain', desc: 'その人に、されたことへの文句を言う', descEn: 'tell that person you did not like what they did', argType: 'choice', choices: talk.map((p) => mk(p, { item: g(p.name).item || null })) });
  const dem = foes.filter((p) => p.d <= hear && g(p.name) && /^took_/.test(g(p.name).kind) && g(p.name).item && !said('demand', p.name));
  if (dem.length) out.push({ name: 'demand_back', desc: 'その人に、取られた物を返してと言う', descEn: 'tell that person to give back what they took', argType: 'choice', choices: dem.map((p) => ({ ...mk(p), id: `${p.name}:${g(p.name).item}`, item: g(p.name).item })) });
  const tb = (view.takeBack || []).filter((t) => foes.some((p) => p.name === t.player)).slice(0, c.maxChoices);
  if (tb.length) {
    out.push({ name: 'take_back', desc: 'その人が置いている物を、取られた物の代わりに取る (1個)', descEn: 'take a block that person has placed, in return for what they took (one block)', argType: 'choice',
      choices: tb.map((t) => ({ id: `${t.player}:${t.block}`, label: `${t.player}の${t.block} ${relDir(here, t.pos)}`, labelEn: `${t.player}'s ${t.block} (${whereEn(here, t.pos)})`, player: t.player, block: t.block, pos: t.pos, grudge: g(t.player) ? g(t.player).v : 0 })) });
  }
  if (c.aggression) {
    const hit = foes.filter((p) => p.d <= c.nearRadius);
    if (hit.length) out.push({ name: 'hit_person', desc: `その人を殴る (${c.hits}発まで)`, descEn: `hit that person (up to ${c.hits} blows)`, argType: 'choice', choices: hit.map((p) => mk(p, { retaliation: recentHit(p.name) })) });
  }
  const attackers = foes.filter((p) => recentHit(p.name));
  if (attackers.length && people.some((p) => p.d <= hear && !attackers.some((a) => a.name === p.name)) && !said('help', attackers[0].name)) {
    out.push({ name: 'call_help', desc: '周りの人に助けを求める', descEn: 'call to the people around for help', argType: 'choice', choices: attackers.slice(0, 1).map((p) => mk(p)) });
  }
  return out;
}

const CONFLICT_ACTIONS = ['avoid_person', 'complain', 'demand_back', 'take_back', 'hit_person', 'call_help'];

module.exports = { DEFAULTS, cfgOf, line, parseLine, templateText, conflictActions, CONFLICT_ACTIONS };
