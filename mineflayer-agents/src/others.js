'use strict';
// ほかの人が拾った物・壊したブロックを集める (bot に依存しない部品。つなぎは agent.js の watchOthers)。
//   拾った: サーバーの collect (誰が・どの落ちている物を・何個)。mineflayer の playerCollect と同じ元
//   壊した: ほかの人の掘っている途中の様子 (block_break_animation) が見えていたマスが空気になったとき。
//           すぐ壊れるブロック (草など) は途中の様子が来ないので、そのマスのすぐ近く (nearDist) に
//           ほかの人が1人だけ居て、自分が掘ったのでなければ、その人が壊したことにする (葉は自然に消えるので除く)
// 行動の間に近く (radius) で起きたものを、結果の文にそのまま足す (例: 「Kenがjungle_logを2個拾った」)。
//   耕した: 土・草の生えた土が耕地 (farmland) になったとき、そのマスのすぐ近くにほかの人が1人だけ居て、自分は近くにいなければ、その人が耕したことにする
//   手の物 (tool): その人が手に持っていた物 (エンティティの equipment。見えている分だけ)。分業 (division.js) の「どんな道具でしていたか」に使う
// 誘導の文は足さない (研究方針)。

const DEFAULTS = { radius: 16, nearDist: 5, progressMs: 4000, swingMs: 1500, nearestRatio: 0.6, keepMs: 300000, maxItems: 4, actions: ['collect', 'pick_up', 'attack', 'hunt'] };
const AIR = /^(air|cave_air|void_air)$/;
const SELF_DECAY = /_leaves$/; // 葉は自然に消える (人が壊したとは限らない)

const key = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

class OthersLog {
  constructor(opts = {}) {
    this.cfg = { ...DEFAULTS, ...opts };
    this.events = []; // { seq, t, who, kind: 'pickup'|'break'|'till', name, count, tool? }
    this.seq = 0;
    this.breaking = new Map(); // マス → { who, t }
    this.myDigs = new Map(); // 自分が掘ったマス → t
    this.swings = new Map(); // 人 → 最後に腕を振った t (すぐ壊れる物は掘っている途中の様子が来ないので、腕を振ったかで見分ける)
    this.lastHow = null; // 最後の noteBlockGone で壊した人を何で決めたか (progress | swing | only | nearest)
  }

  noteSwing(who, t = Date.now()) { if (who) this.swings.set(who, t); }

  push(e) {
    this.seq += 1;
    this.events.push({ seq: this.seq, ...e });
    const cut = e.t - this.cfg.keepMs;
    while (this.events.length && this.events[0].t < cut) this.events.shift();
  }

  // 近いか (自分の位置が分からないときは数える)
  near(me, pos) { return !me || !pos || d3(me, pos) <= this.cfg.radius; }

  // collect: who がほかの人で、item が落ちている物の名前のとき
  notePickup({ who, me = null, self = null, item, count = 1, pos = null, t = Date.now() }) {
    if (!who || who === self || !item) return false;
    if (!this.near(me, pos)) return false;
    this.push({ t, who, kind: 'pickup', name: item, count: Math.max(1, count | 0) });
    return true;
  }

  noteBreakProgress({ who, self = null, pos, tool = undefined, t = Date.now() }) {
    if (!who || who === self || !pos) return;
    this.breaking.set(key(pos), { who, t, tool });
  }

  noteMyDig(pos, t = Date.now()) { if (pos) this.myDigs.set(key(pos), t); }

  // ブロックが空気になった。players = [{ name, pos }] (自分以外)
  noteBlockGone({ pos, oldName, newName = 'air', me = null, players = [], t = Date.now() }) {
    if (!pos || !oldName || AIR.test(oldName) || !AIR.test(newName)) return null;
    if (!this.near(me, pos)) return null;
    const k = key(pos);
    const mine = this.myDigs.get(k);
    if (mine != null && t - mine <= this.cfg.progressMs) { this.myDigs.delete(k); return null; }
    let who = null; let tool; let how = null;
    const br = this.breaking.get(k);
    if (br && t - br.t <= this.cfg.progressMs) { who = br.who; tool = br.tool; how = 'progress'; }
    else if (!SELF_DECAY.test(oldName)) {
      // 掘っている途中の様子が無い (松明・作物などすぐ壊れる物): 手の届く所 (nearDist) にいる人のうち、
      //   1人だけならその人、何人もいれば直前に腕を振った人が1人ならその人、それも決まらなければ一番近い人がはっきり近いとき (nearestRatio) だけ
      //   (2026-11-10: 掘っている途中しか記録せず、持ち主が 2m 先にいても目撃が漏れていた)
      const c = { x: Math.floor(pos.x) + 0.5, y: Math.floor(pos.y) + 0.5, z: Math.floor(pos.z) + 0.5 };
      const close = players.filter((p) => p && p.pos && d3(p.pos, c) <= this.cfg.nearDist).sort((a, b) => d3(a.pos, c) - d3(b.pos, c));
      const swung = close.filter((p) => t - (this.swings.get(p.name) ?? -Infinity) <= this.cfg.swingMs);
      let pick = null;
      if (close.length === 1) { pick = close[0]; how = 'only'; } else if (swung.length === 1) { pick = swung[0]; how = 'swing'; } else if (close.length > 1 && d3(close[0].pos, c) < d3(close[1].pos, c) * this.cfg.nearestRatio) { pick = close[0]; how = 'nearest'; }
      if (pick) { who = pick.name; tool = pick.held; }
    }
    this.lastHow = how;
    if (tool === undefined && who) { const p = players.find((x) => x && x.name === who); if (p) tool = p.held; }
    this.breaking.delete(k);
    if (!who) return null;
    this.push({ t, who, kind: 'break', name: oldName, count: 1, ...(tool !== undefined ? { tool: tool || null } : {}) });
    return who;
  }

  // 土・草の生えた土が耕地になった。players = [{ name, pos, held }] (自分以外)。自分が近く (nearDist) にいるときは数えない (自分が耕したかもしれない)
  noteTill({ pos, oldName, newName, me = null, players = [], t = Date.now() }) {
    if (!pos || newName !== 'farmland' || !/^(dirt|grass_block|dirt_path|coarse_dirt|rooted_dirt)$/.test(String(oldName))) return null;
    if (!this.near(me, pos)) return null;
    const c = { x: Math.floor(pos.x) + 0.5, y: Math.floor(pos.y) + 0.5, z: Math.floor(pos.z) + 0.5 };
    if (me && d3(me, c) <= this.cfg.nearDist) return null;
    const close = players.filter((p) => p && p.pos && d3(p.pos, c) <= this.cfg.nearDist);
    if (close.length !== 1) return null;
    const p = close[0];
    this.push({ t, who: p.name, kind: 'till', name: 'farmland', count: 1, ...(p.held !== undefined ? { tool: p.held || null } : {}) });
    return p.name;
  }

  // pos のすぐ近く (dist) を、自分が ms 以内に掘ったか (落ちた物を先に拾われたかの判定)
  myDigNear(pos, { ms = 4000, dist = 3, t = Date.now() } = {}) {
    if (!pos) return false;
    for (const [k, at] of this.myDigs) {
      if (t - at > ms) continue;
      const [x, y, z] = k.split(',').map(Number);
      if (d3({ x: x + 0.5, y: y + 0.5, z: z + 0.5 }, pos) <= dist) return true;
    }
    return false;
  }

  // who が ms 以内にブロックを壊したか (壊して落ちた物を拾ったのを「もらった」と数えないため)
  brokeRecently(who, ms = 4000, t = Date.now()) { return this.events.some((e) => e.kind === 'break' && e.who === who && t - e.t <= ms); }

  mark() { return this.seq; }

  // mark の後に起きたもの (人・種類・名前ごとにまとめる。多い順に maxItems まで)
  since(mark) {
    const m = new Map();
    for (const e of this.events) {
      if (e.seq <= mark) continue;
      const k = `${e.who}|${e.kind}|${e.name}`;
      const x = m.get(k) || { who: e.who, kind: e.kind, name: e.name, count: 0, first: e.seq };
      x.count += e.count;
      m.set(k, x);
    }
    return [...m.values()].sort((a, b) => (b.count - a.count) || (a.first - b.first)).slice(0, this.cfg.maxItems)
      .map(({ who, kind, name, count }) => ({ who, kind, name, count }));
  }

  static text(list) {
    return list.map((x) => (x.kind === 'till' ? `${x.who}が土を${x.count}マス耕した` : `${x.who}が${x.name}を${x.count}個${x.kind === 'pickup' ? '拾った' : '壊した'}`)).join('。');
  }

  // 結果の文に足す (無ければそのまま)
  static appendTo(msg, list) {
    if (!list || !list.length) return msg;
    const m = String(msg || '');
    return `${m}${m && !/[。.]$/.test(m) ? '。' : ''}${OthersLog.text(list)}`;
  }
}

module.exports = { OthersLog, DEFAULTS };
