'use strict';
// 小さな共通関数 (bot に依存しない)

function round1(v) { return Math.round(v * 10) / 10; }

// 自分から見た相対位置を短い日本語にする。x+ = 東, z+ = 南 (Minecraft の向き)
function relDir(from, to) {
  const dx = Math.round(to.x - from.x);
  const dz = Math.round(to.z - from.z);
  const dy = Math.round(to.y - from.y);
  const parts = [];
  if (dx !== 0) parts.push(`${dx > 0 ? '東' : '西'}${Math.abs(dx)}`);
  if (dz !== 0) parts.push(`${dz > 0 ? '南' : '北'}${Math.abs(dz)}`);
  if (Math.abs(dy) >= 2) parts.push(`${dy > 0 ? '上' : '下'}${Math.abs(dy)}`);
  const dist = Math.round(Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z));
  return `${parts.join('') || 'ここ'}(${dist}m)`;
}

function dist3(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }

function timePhase(timeOfDay) {
  // 0=日の出, 6000=正午, 12000=日没, 18000=真夜中
  const t = ((timeOfDay % 24000) + 24000) % 24000;
  if (t < 1000) return '朝';
  if (t < 11000) return '昼';
  if (t < 13000) return '夕方';
  if (t < 23000) return '夜';
  return '明け方';
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// p を ms で打ち切る。打ち切ったら onTimeout() を呼んで reject する
function withTimeout(p, ms, onTimeout) {
  let timer;
  const t = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { if (onTimeout) onTimeout(); } catch (_) { /* ignore */ }
      reject(new Error(`timeout ${Math.round(ms / 1000)}s`));
    }, ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

module.exports = { round1, relDir, dist3, timePhase, sleep, withTimeout };
