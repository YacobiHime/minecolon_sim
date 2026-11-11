'use strict';
// 所有を考えた行動の候補 (actions.js の listActions から呼ぶ。cfg.provenance.actions が on のときだけ)。
//   collect             天然と見ている物 (置かれた物と認識していない位置) だけ。actions.js が naturalPositions で絞る
//   dismantle_own       自分で置いた物を外す (移設・要らなくなった足場など)
//   take_placed         ほかの人の物・共同の物・共有の物・所有者の分からない置かれた物を取る (取れなくはしない)
//   ask_permission      所有者が分かっていて声の届く所にいるとき、取ってよいか聞く (緊急でなければ)
//   make_amends         取った相手に説明する・返す・元の所に戻す
//   repair_or_relocate_public  共同・共有の物を元に戻す・拠点の近くへ移す
// 候補ごとに、所有・機能損害・代わりの手段・許可の差を構造にして持ち (choice.own)、Jev には英語の事実の文 (labelEn) で見せる。
// view (ctx.own) は ownership_agent.js が作る: エージェントの知識・見えている物・欲求・性格だけから (台帳は見ない)。
const { relDir, dist3 } = require('./util');
const { whereEn } = require('./en');
const { peopleOf } = require('./people');
const O = require('./ownership');

const P = (p) => (Array.isArray(p) ? { x: p[0], y: p[1], z: p[2] } : p);
const altTextEn = (alts) => {
  const av = alts.filter((a) => a.available && a.kind !== 'ask_permission');
  if (!av.length) return 'no other source of this seen';
  return av.map((a) => ({ have_own: 'you have one yourself', craft: 'you can make one from what you have', collect_natural: `natural ${a.target} visible`, hunt: `${a.target} visible` }[a.kind] || a.kind)).join(', ');
};
const altTextJa = (alts) => {
  const av = alts.filter((a) => a.available && a.kind !== 'ask_permission');
  if (!av.length) return '代わりは見当たらない';
  return av.map((a) => ({ have_own: '自分も持っている', craft: '手持ちで作れる', collect_natural: `天然の${a.target}が見える`, hunt: `${a.target}が見える` }[a.kind] || a.kind)).join('・');
};

// 見えているブロック b の位置のうち、天然と見ている所 (collect の対象)
function naturalPositions(b, own) {
  const ps = b.positions && b.positions.length ? b.positions : [b.nearest];
  if (!own) return ps;
  return ps.filter((p) => !own.knowledge.recognized(own.dim, p, b.name));
}

// 1つの置かれた物の判断材料 (候補の文・重み・意図の記録で同じものを使う)
function infoFor(own, raw, block, pos, cls, extra = {}) {
  const people = peopleOf(raw);
  const owner = cls.owner || null;
  const ownerP = owner ? people.find((p) => p.name === owner) : null;
  const hear = own.hearRadius ?? 48;
  const ownerNear = !!(ownerP && ownerP.d <= hear);
  const permit = own.permit ? own.permit(pos) : null; // { granted: true|false, owner, tick }
  const permission = cls.category === 'own' ? 'not_applicable' : permit ? (permit.granted ? 'granted' : 'denied') : 'not_requested';
  const alts = O.alternatives(block, { ...own.altView, ownerKnown: !!owner && cls.category !== 'own', owner, ownerNear, askedRecently: own.askedRecently ? own.askedRecently(owner, block) : false });
  const harm = O.functionalHarm(block, own.harmFacts ? own.harmFacts(pos, block) : {});
  const witnesses = people.filter((p) => p.d <= (own.witnessRadius ?? 16)).length;
  const kind = cls.category === 'other' ? 'personal' : cls.category;
  const cost = O.socialCost({ kind, affinity: owner && own.affinity ? own.affinity(owner) : null, witnesses, temperament: own.temperament, permission });
  const goalRelated = !!(own.goalNames && (own.goalNames.has(block) || own.goalNames.has(O.itemOf(block))));
  const reason = O.decideReason({ action: extra.action || 'take_placed', category: cls.category, permission, block, needs: own.needs, alternatives: alts, emergencyNeed: own.cfg.emergencyNeed, goalRelated });
  const info = { block, pos: { x: pos.x, y: pos.y, z: pos.z }, category: cls.category, owner, ownerNear, source: cls.entry ? cls.entry.source : 'looks_placed', purpose: cls.entry ? cls.entry.purpose || null : null,
    permission, alternatives: alts, harm, socialCost: cost, witnesses, emergency: reason.emergency, reason, goalRelated,
    greedTrait: cls.category === 'own' || !own.temperament ? null : own.temperament.greed };
  info.weight = O.choiceWeight(info, own.cfg);
  return info;
}

function ownerTextEn(i) {
  if (i.category === 'unknown') return 'placed by someone; you do not know who';
  if (i.category === 'group') return `shared by your group${i.owner ? ` (${i.owner} placed it)` : ''}`;
  if (i.category === 'public') return `shared with everyone${i.owner ? ` (${i.owner} shared it)` : ''}`;
  return `placed by ${i.owner}${i.ownerNear ? `; ${i.owner} is within earshot` : ''}`;
}
function ownerTextJa(i) {
  if (i.category === 'unknown') return '誰かが置いた物 (誰かは知らない)';
  if (i.category === 'group') return `みんなの物${i.owner ? ` (${i.owner}が置いた)` : ''}`;
  if (i.category === 'public') return `共有の物${i.owner ? ` (${i.owner}が共有にした)` : ''}`;
  return `${i.owner}が置いた物${i.ownerNear ? ` (${i.owner}は声の届く所にいる)` : ''}`;
}
function permTextEn(i) { return i.permission === 'granted' ? `; ${i.owner} said you may take it` : i.permission === 'denied' ? `; ${i.owner} said no` : ''; }
function permTextJa(i) { return i.permission === 'granted' ? `。${i.owner}は取ってよいと言った` : i.permission === 'denied' ? `。${i.owner}は断った` : ''; }

// 返り値: { actions: [...], weights: { "action:id": w }, infos: { "action:id": info } }
function ownershipActions(raw, ctx = {}) {
  const own = ctx.own;
  const out = { actions: [], weights: {}, infos: {} };
  if (!own) return out;
  const blocked = ctx.blocked || new Set();
  const here = raw.self.pos;
  const feetY = Math.floor(here.y);
  const maxUp = ctx.maxReachUp ?? 4;
  const maxN = own.cfg.maxChoices || 6;
  const people = peopleOf(raw);
  const groups = new Map(); // "block@who" → { cls, ps: [pos] }
  for (const b of raw.blocks || []) {
    if (!b.diggable) continue;
    const ps = (b.positions && b.positions.length ? b.positions : [b.nearest]).filter((p) => p.y - feetY <= maxUp);
    for (const p of ps) {
      const cls = own.knowledge.classify(own.dim, p, b.name);
      if (cls.category === 'natural') continue;
      const who = cls.category === 'own' ? 'mine' : cls.category === 'other' ? cls.owner : cls.category;
      const k = `${b.name}@${who}`;
      if (!groups.has(k)) groups.set(k, { block: b.name, cls, ps: [] });
      groups.get(k).ps.push(p);
    }
  }
  const take = []; const mine = []; const ask = [];
  for (const [k, g] of groups) {
    const p = g.ps.sort((a, c) => (a.d ?? dist3(here, a)) - (c.d ?? dist3(here, c)))[0];
    if (g.cls.category === 'own') {
      if (blocked.has(`dismantle_own:${g.block}`)) continue;
      const i = infoFor(own, raw, g.block, p, g.cls, { action: 'dismantle_own' });
      const purp = i.purpose ? ` (${i.purpose})` : '';
      mine.push({ id: g.block, label: `${g.block} ${relDir(here, p)} 自分が置いた物${purp}`, labelEn: `${g.block} (${whereEn(here, p)}; you placed it${purp})`, block: g.block, pos: i.pos, own: i, count: g.ps.length });
      continue;
    }
    const id = k;
    const i = infoFor(own, raw, g.block, p, g.cls);
    if (!blocked.has(`take_placed:${id}`)) {
      const hf = O.harmFactsEn(i.harm);
      take.push({ id, label: `${g.block} ${relDir(here, p)} ${ownerTextJa(i)}。${altTextJa(i.alternatives)}${permTextJa(i)}`,
        labelEn: `${g.block} (${whereEn(here, p)}; ${ownerTextEn(i)}${hf.length ? `; ${hf.join('; ')}` : ''}; ${altTextEn(i.alternatives)}${permTextEn(i)})`,
        block: g.block, pos: i.pos, owner: i.owner, category: i.category, own: i });
      out.weights[`take_placed:${id}`] = i.weight.w;
      out.infos[`take_placed:${id}`] = i;
    }
    // ask_permission: 所有者が分かっていて声の届く所。許可・断りをまだ受けていない。緊急でなければ (設定 askInEmergency)
    if (i.owner && (i.category === 'other' || i.category === 'group' || i.category === 'public') && i.ownerNear && i.permission === 'not_requested'
      && !(own.askedRecently && own.askedRecently(i.owner, g.block)) && (!i.emergency || own.cfg.askInEmergency)) {
      const aid = `${i.owner}:${g.block}`;
      if (!blocked.has(`ask_permission:${aid}`)) ask.push({ id: aid, label: `${i.owner}に${g.block}を使ってよいか聞く`, labelEn: `ask ${i.owner} whether you may take the ${g.block} (${whereEn(here, p)})`, player: i.owner, block: g.block, pos: i.pos, own: i });
    }
  }
  const byD = (a, c) => dist3(here, a.pos) - dist3(here, c.pos);
  if (take.length) out.actions.push({ name: 'take_placed', desc: '人が置いた物 (ほかの人の物・みんなの物・誰の物か分からない物) を掘って取る (1個)', descEn: 'dig up and take a block someone placed (someone else\'s, shared, or of unknown owner); one block', argType: 'choice', choices: take.sort(byD).slice(0, maxN) });
  if (mine.length) out.actions.push({ name: 'dismantle_own', desc: '自分で置いた物を掘って持ち物に戻す (1個)', descEn: 'dig up a block you placed yourself and take it back (one block)', argType: 'choice', choices: mine.sort(byD).slice(0, maxN) });
  if (ask.length) out.actions.push({ name: 'ask_permission', desc: '置いた人に、それを取ってよいか聞く (答えを待つ)', descEn: 'ask the person who placed something whether you may take it (waits for the answer)', argType: 'choice', choices: ask.sort(byD).slice(0, maxN) });

  // make_amends: 取った相手への説明・返す・元の所に戻す (取った記録 own.owe から)
  const am = [];
  const inv = raw.inventory || [];
  const holding = (item) => inv.some((x) => x.name === item && x.count > 0);
  const near = (name) => people.some((p) => p.name === name && p.d <= (own.hearRadius ?? 48));
  const seenExplain = new Set();
  for (const o of (own.owe || []).slice().reverse()) {
    if (o.owner && near(o.owner) && !o.explained && !seenExplain.has(o.owner) && !blocked.has(`make_amends:explain:${o.owner}`)) {
      seenExplain.add(o.owner);
      am.push({ id: `explain:${o.owner}`, label: `${o.owner}に${o.block}を取ったことを話す`, labelEn: `tell ${o.owner} that you took their ${o.block} and why`, kind: 'explain', player: o.owner, oweId: o.id });
    }
    const item = O.itemOf(o.block);
    if (o.owner && near(o.owner) && !o.returned && !o.repaired && holding(item) && !am.some((c) => c.id === `return:${o.owner}:${item}`) && !blocked.has(`make_amends:return:${o.owner}:${item}`)) {
      am.push({ id: `return:${o.owner}:${item}`, label: `${o.owner}に${item}を返す`, labelEn: `give ${o.owner} back a ${item}`, kind: 'return', player: o.owner, item, oweId: o.id });
    }
    const pos = P(o.pos);
    if (!o.returned && !o.repaired && holding(item) && dist3(here, pos) <= 24 && !blocked.has(`make_amends:repair:${o.block}@${O.pstr(o.pos)}`)) {
      const rid = `repair:${o.block}@${O.pstr(o.pos)}`;
      if (!am.some((c) => c.id === rid)) am.push({ id: rid, label: `${o.block}を取った所 ${relDir(here, pos)} に戻す`, labelEn: `put a ${item} back where you took the ${o.block} (${whereEn(here, pos)})`, kind: 'repair', item, block: o.block, pos, owner: o.owner, oweId: o.id });
    }
  }
  if (am.length) out.actions.push({ name: 'make_amends', desc: '取った物について、その人に話す・返す・元の所に戻す', descEn: 'about something you took: tell the person, give it back, or put it back where it was', argType: 'choice', choices: am.slice(0, maxN) });

  // repair_or_relocate_public: 無くなった共同・共有の物を戻す / 拠点から遠い共同・共有の設備を拠点の近くへ移す
  const rp = [];
  for (const e of own.knowledge.list()) {
    if (!(e.kind === 'group' || e.kind === 'public')) continue;
    const pos = P(e.pos);
    const item = O.itemOf(e.block);
    if (e.status === 'missing' && holding(item) && dist3(here, pos) <= 32) {
      const id = `repair:${e.block}@${O.pstr(e.pos)}`;
      if (!blocked.has(`repair_or_relocate_public:${id}`)) rp.push({ id, label: `無くなった${e.block}を元の所 ${relDir(here, pos)} に戻す`, labelEn: `put a ${item} back where the shared ${e.block} was (${whereEn(here, pos)}); it is gone now`, kind: 'repair', item, block: e.block, pos, owner: e.owner || null });
    }
    if (e.status === 'present' && own.base && O.STATION.test(e.block) && !O.CONTAINER.test(e.block) && dist3(pos, own.base) > own.cfg.relocate.minFromBase && dist3(here, pos) <= 16 && pos.y - feetY <= maxUp
      && !own.knowledge.list().some((q) => q.status === 'present' && q.block === e.block && dist3(P(q.pos), own.base) <= own.cfg.relocate.nearBase)) {
      const id = `relocate:${e.block}@${O.pstr(e.pos)}`;
      if (!blocked.has(`repair_or_relocate_public:${id}`)) {
        const i = infoFor(own, raw, e.block, pos, { category: e.kind, owner: e.owner || null, entry: e }, { action: 'repair_or_relocate_public' });
        rp.push({ id, label: `共同の${e.block} ${relDir(here, pos)} を拠点の近くへ移す`, labelEn: `move the shared ${e.block} (${whereEn(here, pos)}) to near the base (${whereEn(here, own.base)})`, kind: 'relocate', item, block: e.block, pos, owner: e.owner || null, own: i });
      }
    }
  }
  if (rp.length) out.actions.push({ name: 'repair_or_relocate_public', desc: '共同・共有の物を元の所に戻す、または拠点の近くへ移す', descEn: 'put back a shared thing that is gone, or move a shared one to near the base', argType: 'choice', choices: rp.sort(byD).slice(0, maxN) });
  return out;
}

module.exports = { ownershipActions, naturalPositions, infoFor, ownerTextEn };
