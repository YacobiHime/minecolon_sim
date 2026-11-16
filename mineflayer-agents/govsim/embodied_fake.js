'use strict';
// テスト用の偽物の world (embodied_sim.js の world の約束を、サーバー無しで満たす)。時間は仮の tick で、待つと飛ぶ。
//   池: 匹数だけ。取ると1匹減る (順番は呼ばれた順 = 先に来た人のもの)
//   見た人: 取ったとき池にいた人 (witness: 'lake')・全員 ('all')・だれも見ない ('none')
//   空腹: 月の初めに hungerPerMonth 点減り、取った魚 1匹で 2 点 (raw cod) 食べられる
class FakeWorld {
  constructor({ names, hide = 0, witness = 'lake', hungerPerMonth = 12, catchTicks = 20 } = {}) {
    this.names = names;
    this.t = 1000;
    this.fish = 0;
    this.seq = 0;
    this.where = Object.fromEntries(names.map((n) => [n, 'home']));
    this.food = Object.fromEntries(names.map((n) => [n, 20]));
    this.cod = Object.fromEntries(names.map((n) => [n, 0]));
    this.heardBy = Object.fromEntries(names.map((n) => [n, []]));
    this.hide = hide; // 見える数を本当の数より少なく (見通しの無い魚)
    this.witness = witness; this.hungerPerMonth = hungerPerMonth; this.catchTicks = catchTicks;
    this.realtime = false;
    this.commands = [];
  }

  now() { return this.t; }
  async waitUntil(tick, { onTick } = {}) { await Promise.resolve(); if (onTick) onTick(); if (this.t < tick) this.t = tick; return this.t; }
  deadlineMs() { return Infinity; }
  async pause() { await Promise.resolve(); }
  async settleChat() { await Promise.resolve(); }
  async setFish(n) { this.fish = n; this.commands.push(['set', n]); }
  async summonFish(n) { this.fish += n; this.commands.push(['summon', n]); }
  async removeFish(n) { this.fish = Math.max(0, this.fish - n); this.commands.push(['remove', n]); }
  async countFish() { return this.fish; }
  async startMonth(names) { for (const n of names) this.food[n] = Math.max(0, this.food[n] - this.hungerPerMonth); }
  async goToLake(n) { await Promise.resolve(); this.where[n] = 'lake'; this.t += 10; return true; }
  async goHome(n) { await Promise.resolve(); this.where[n] = 'home'; return true; }
  async goMeeting(n) { await Promise.resolve(); this.where[n] = 'meeting'; return true; }
  lookAtLake() { return Math.max(0, this.fish - this.hide); }
  async catchOne(n) {
    await Promise.resolve();
    if (this.fish <= 0) return { ok: false, reason: 'no_fish_visible' };
    this.fish -= 1; this.t += this.catchTicks;
    return { ok: true, fishId: ++this.seq };
  }
  witnesses(who, names) {
    if (this.witness === 'all') return names.filter((n) => n !== who);
    return this.witness === 'lake' ? names.filter((n) => n !== who && this.where[n] === 'lake') : [];
  }
  async giveCatch(n) { this.cod[n] += 1; }
  async eat(n) { let k = 0; while (this.food[n] <= 18 && this.cod[n] > 0) { this.cod[n] -= 1; this.food[n] = Math.min(20, this.food[n] + 2); k += 1; } return k; }
  chat(n, text) {
    const { chatChunks } = require('./embodied_sim');
    const parts = chatChunks(text);
    const now = Date.now();
    for (const p of parts) for (const m of this.names) this.heardBy[m].push({ from: n, text: p, t: now });
    return chatChunks(text, Infinity).join('');
  }
  heard(n) { return this.heardBy[n]; }
  position() { return null; }
  async announce(text) { this.commands.push(['announce', text]); }
  sense(n) {
    const players = this.names.filter((x) => x !== n && this.where[x] === this.where[n]).map((x) => ({ name: x, d: 3 }));
    return { time: this.t, timeOfDay: 6000, food: this.food[n], saturation: 0, health: 20, light: 15, shelter: { enclosed: false, roof: false, walls: 0 }, players, atHome: this.where[n] === 'home', invTotal: this.cod[n], invKinds: this.cod[n] ? 1 : 0 };
  }
}

module.exports = { FakeWorld };
