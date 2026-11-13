'use strict';
// 選択肢の並べ方を毎回変える (サーベイ R5: Jev は最初の選択肢に寄る・小さい LLM は位置に寄る)。
//   乱数は種 (seed) から決まる (mulberry32)。1回ごとの乱数は「人ごとの種 + 流れの名前 (stream) + 通し番号 n」から作るので、
//   記録の { seed, stream, n } と、同じ並びの入力があれば、あとで同じ並びを作り直せる (replay)。
//   enabled: false なら並べ替えない (記録は残す)。
function hash32(str) {
  // FNV-1a
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

function mulberry32(a) {
  let t = a >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// Fisher-Yates (新しい配列を返す)
function shuffleWith(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// 記録から並びを作り直す
function replay(seed, stream, n, arr) { return shuffleWith(arr, mulberry32(hash32(`${seed}:${stream}:${n}`))); }

// 実行全体の種 (config の order.seed か --seed。無ければ時刻から) → 人ごとの種
function agentSeed(runSeed, name) { return hash32(`${runSeed}:${name}`); }

class Order {
  constructor({ enabled = true, seed = 0 } = {}) {
    this.enabled = enabled !== false;
    this.seed = seed >>> 0;
    this.n = {}; // stream → 次の通し番号
  }

  // arr を並べ替える。返り値 { arr, rec: { seed, stream, n, shuffled } }
  shuffle(arr, stream) {
    const n = this.n[stream] = (this.n[stream] ?? -1) + 1;
    const rec = { seed: this.seed, stream, n, shuffled: this.enabled };
    if (!this.enabled || arr.length < 2) return { arr: [...arr], rec };
    return { arr: replay(this.seed, stream, n, arr), rec };
  }
}

// 同点のときなどに使う、その場かぎりの乱数 (記録の n と同じ決まり方)
function rngFor(seed, stream, n) { return mulberry32(hash32(`${seed}:${stream}:${n}`)); }

module.exports = { Order, hash32, mulberry32, shuffleWith, replay, agentSeed, rngFor };
