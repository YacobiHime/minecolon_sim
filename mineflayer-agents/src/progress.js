'use strict';
// 目標の手順 (goal.steps) のうち、どこまで済んだかを「自分の持ち物」と「今見えているもの」だけで判定する。
// 2B は持ち物の行を読んで手順を追うのが苦手 (原木 40 個を持ったまま原木を集め続けた) なので、
// 済んだ手順と次の手順をプログラムが書き出す。手順そのものは設定ファイルで与える (実験の設定)。
//
// steps: [{ text, doneWhen: [cond, ...] }]   cond のどれか1つが成り立てば済み
//   cond = { inventory: { "<正規表現>": 個数 } }   持ち物に、名前が一致するものが合計で個数以上
//        | { see: "<ブロック名>" }                今見えている

function invCount(inventory, pattern) {
  const re = new RegExp(pattern);
  return inventory.filter((i) => re.test(i.name)).reduce((s, i) => s + i.count, 0);
}

function condMet(cond, raw) {
  if (cond.inventory) return Object.entries(cond.inventory).every(([p, n]) => invCount(raw.inventory, p) >= n);
  if (cond.see) return raw.blocks.some((b) => b.name === cond.see);
  return false;
}

function stepStatus(steps, raw) {
  return (steps || []).map((s) => ({ text: s.text, done: (s.doneWhen || []).some((c) => condMet(c, raw)) }));
}

function progressText(steps, raw) {
  const st = stepStatus(steps, raw);
  if (!st.length) return '';
  const next = st.findIndex((s) => !s.done);
  return st.map((s, i) => `(${i + 1})${s.text}${s.done ? '…済' : i === next ? '…← 次はこれ' : ''}`).join(' ');
}

module.exports = { stepStatus, progressText, condMet };
