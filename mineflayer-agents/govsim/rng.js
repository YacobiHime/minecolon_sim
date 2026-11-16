'use strict';
// 種を固定できる乱数 (mulberry32)。同じ種なら同じ列になる
class Rng {
  constructor(seed = 1) { this.s = (Number(seed) >>> 0) || 0x9e3779b9; }
  next() {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n) { return Math.floor(this.next() * n); }
  choice(arr) { return arr[this.int(arr.length)]; }
  weighted(arr, w) {
    const tot = w.reduce((a, b) => a + b, 0);
    if (!(tot > 0)) return this.choice(arr);
    let x = this.next() * tot;
    for (let i = 0; i < arr.length; i++) { x -= w[i]; if (x < 0) return arr[i]; }
    return arr[arr.length - 1];
  }
  shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) { const j = this.int(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
}
module.exports = { Rng };
