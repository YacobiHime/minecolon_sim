'use strict';
// その瞬間にできる行動の一覧を作る (純粋な関数) と、選ばれた引数の解決。
// 実行は act.js。LLM / Jev などの decider は、この一覧から1つ選んで arg を埋めるだけ。
const { relDir } = require('./util');
const { BUILD_MATERIAL } = require('./hut');

const HUNTABLE = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit']);

const DIRECTIONS = ['north', 'south', 'east', 'west'];
const PLACEABLE_HINT = new Set(['crafting_table', 'furnace', 'chest', 'torch']);

// 一覧の各要素: { name, desc, argType: 'choice'|'text'|'none'|'number', choices: [{id, label, ...data}] }
function listActions(raw, ctx = {}) {
  const memPlaces = ctx.memPlaces || [];
  const foods = ctx.foods || new Set();
  const placeableNames = ctx.placeable || null; // Set (bot から渡す) / null なら PLACEABLE_HINT と _planks 等
  const maxCollect = ctx.maxCollectChoices ?? 10;
  const maxReachUp = ctx.maxReachUp ?? 4;
  const goalItems = ctx.goalItems || new Set(); // 目標の物 (作れるようになったら印を付ける)
  const blocked = ctx.blocked || new Set(); // 最近続けて失敗した "action:arg" (今回は候補から外す)
  const here = raw.self.pos;
  const out = [];

  // collect: 見えていて、今の道具で掘れて、手の届く高さ (足場を積まない) にあるブロック
  const coll = raw.blocks
    .filter((b) => b.diggable && !blocked.has(`collect:${b.name}`))
    .map((b) => ({ b, reach: (b.positions && b.positions.length ? b.positions : [b.nearest]).filter((p) => p.y - Math.floor(here.y) <= maxReachUp) }))
    .filter((x) => x.reach.length)
    .sort((x, y) => (y.b.notable - x.b.notable) || (x.reach[0].d - y.reach[0].d))
    .slice(0, maxCollect)
    .map(({ b, reach }) => ({ id: b.name, label: `${b.name} ${relDir(here, reach[0])}`, block: b.name }));
  if (coll.length) out.push({ name: 'collect', desc: '見えているブロックを掘って拾う (近いものから数個)', argType: 'choice', choices: coll });

  // go_to: 見えている目印・覚えている場所・見えている人
  const go = [];
  const seenKinds = new Set();
  for (const b of raw.blocks.filter((x) => x.notable).sort((a, c) => a.nearest.d - c.nearest.d)) {
    if (b.nearest.d < 3 || blocked.has(`go_to:${b.name}`)) continue;
    go.push({ id: b.name, label: `${b.name} ${relDir(here, b.nearest)}`, pos: b.nearest, kind: b.name });
    seenKinds.add(b.name);
    if (go.length >= 5) break;
  }
  for (const p of memPlaces) {
    if ((p.d !== undefined && p.d < 3) || blocked.has(`go_to:${p.id}`)) continue;
    go.push({ id: p.id, label: p.label, pos: p.pos, kind: p.kind, fromMemory: true });
  }
  for (const e of raw.entities.filter((x) => x.kind === 'player')) {
    go.push({ id: e.name, label: `プレイヤー${e.name} ${relDir(here, e.pos)}`, pos: e.pos, player: e.name });
  }
  if (go.length) out.push({ name: 'go_to', desc: '見えている物・覚えている場所(M番号)・人のところへ歩く', argType: 'choice', choices: go });

  out.push({
    name: 'explore', desc: 'その方角へ20ブロックほど歩いて新しい場所を見る', argType: 'choice',
    choices: DIRECTIONS.filter((d) => !blocked.has(`explore:${d}`)).map((d) => ({ id: d, label: d, dir: d })),
  });

  // craft: 今の持ち物で作れるもの。作業台が見えていれば作業台が要るものも
  const craftNames = [...raw.craft.now, ...(raw.tableNearby ? raw.craft.withTable : [])];
  if (craftNames.length) {
    out.push({
      name: 'craft', desc: raw.tableNearby ? '作る (作業台が要るものは近くの作業台で)' : '作る (手元で作れるもの)', argType: 'choice',
      choices: [...new Set(craftNames)].filter((n) => !blocked.has(`craft:${n}`))
        .map((n) => ({ id: n, label: goalItems.has(n) ? `${n} 目標の物` : n, item: n, needsTable: !raw.craft.now.includes(n) })),
    });
  }

  // place: 持っているブロックを足元の近くに置く
  const pl = raw.inventory.filter((i) => (placeableNames ? placeableNames.has(i.name) : PLACEABLE_HINT.has(i.name)));
  // 作業台を持っていて近くに無いとき、置けば何が作れるようになるかを書き添える (レシピの知識。世界の状態ではない)
  const unlock = !raw.tableNearby && raw.craft.withTable.length && pl.some((i) => i.name === 'crafting_table')
    ? ` (crafting_table を置くと、その近くで ${raw.craft.withTable.join(', ')} が作れる)` : '';
  if (pl.length) out.push({ name: 'place', desc: `持っているブロックをすぐ近くに置く${unlock}`, argType: 'choice', choices: pl.map((i) => ({ id: i.name, label: `${i.name}x${i.count}`, item: i.name })) });

  // eat: 空腹で食べ物を持っているとき
  if (raw.self.food < 20) {
    const fd = raw.inventory.filter((i) => foods.has(i.name));
    if (fd.length) out.push({ name: 'eat', desc: '食べる', argType: 'choice', choices: fd.map((i) => ({ id: i.name, label: i.name, item: i.name })) });
  }

  // build: 拠点を知っていて、建てる材料を持っているとき (設計図の次の場所をプログラムが決める。座標は選ばせない)
  if (ctx.base) {
    const mats = raw.inventory.filter((i) => BUILD_MATERIAL.test(i.name));
    const hut = ctx.hut && ctx.hut.ratio != null ? ` 今${Math.round(ctx.hut.ratio * 100)}%できている` : '';
    if (mats.length) {
      out.push({ name: 'build', desc: `拠点 (${relDir(here, ctx.base)}) に小屋を建てる。決まった形に数個ずつ置く。遠ければ歩いて行く${hut}`, argType: 'choice',
        choices: mats.filter((i) => !blocked.has(`build:${i.name}`)).map((i) => ({ id: i.name, label: `${i.name}x${i.count}`, item: i.name })) });
    }
  }

  // hunt: 見えている動物 (食べ物になる)
  const seenAnimals = new Map();
  for (const e of raw.entities.filter((x) => x.kind === 'mob' && HUNTABLE.has(x.name))) if (!seenAnimals.has(e.name)) seenAnimals.set(e.name, e);
  const hunt = [...seenAnimals.values()].filter((e) => !blocked.has(`hunt:${e.name}`)).map((e) => ({ id: e.name, label: `${e.name} ${relDir(here, e.pos)}`, mob: e.name }));
  if (hunt.length) out.push({ name: 'hunt', desc: '動物を倒して肉を手に入れる (食べ物)', argType: 'choice', choices: hunt });

  // ask: 困っているとき (同じ行動が続けて失敗した) だけ。聞こえる範囲に見えている人に聞く
  const troubles = ctx.troubles || [];
  if (troubles.length) {
    const near = raw.entities.filter((x) => x.kind === 'player' && x.d <= (ctx.hearRadius ?? 24));
    if (near.length) {
      out.push({ name: 'ask', desc: `近くの人に「${troubles[0].about}」を聞く (答えを待つ)`, argType: 'choice',
        choices: near.map((e) => ({ id: e.name, label: `${e.name} ${relDir(here, e.pos)}`, player: e.name, trouble: troubles[0] })) });
    }
  }

  // 手元でできること (craft / build / place / eat) を先に並べる (小さいモデルは先頭の候補に引っぱられやすい)
  const first = ['craft', 'build', 'place', 'eat', 'hunt', 'ask'];
  const rank = (n) => (first.includes(n) ? first.indexOf(n) : first.length);
  out.sort((a, b) => rank(a.name) - rank(b.name));

  for (let i = out.length - 1; i >= 0; i--) if (out[i].argType === 'choice' && !out[i].choices.length) out.splice(i, 1);

  out.push({ name: 'say', desc: '近くの人に話しかける (arg に話す内容)', argType: 'text' });
  out.push({ name: 'look_around', desc: '立ち止まって周りを見回す', argType: 'none' });
  out.push({ name: 'wait', desc: '少し待つ (arg に秒数 1〜10)', argType: 'number' });
  return out;
}

// "spruce_log 東5北3(6m)" → "spruce_log(東5北3 6m)"
function choiceText(c) {
  if (c.id === c.label) return c.id;
  const rest = c.label.startsWith(c.id) ? c.label.slice(c.id.length).trim() : c.label;
  return `${c.id}(${rest.replace(/\((\d+m)\)$/, ' $1')})`;
}

// プロンプト用の行動一覧の文章
function actionsToText(actions) {
  return actions.map((a) => {
    if (a.argType === 'choice') return `- ${a.name}: ${a.desc}。arg: ${a.choices.map(choiceText).join(' | ')}`;
    if (a.argType === 'text') return `- ${a.name}: ${a.desc}`;
    if (a.argType === 'number') return `- ${a.name}: ${a.desc}`;
    return `- ${a.name}: ${a.desc}。arg は空`;
  }).join('\n');
}

// decider の出した {action, arg} を一覧と突き合わせる。
// 返り値 { ok, action, arg, choice, fixed, error }
function resolveDecision(actions, action, arg) {
  const a = actions.find((x) => x.name === String(action || '').trim().toLowerCase());
  if (!a) return { ok: false, error: `unknown action: ${action}` };
  const s = arg == null ? '' : String(arg).trim();
  if (a.argType === 'none') return { ok: true, action: a.name, arg: '' };
  if (a.argType === 'text') {
    if (!s) return { ok: false, action: a.name, error: 'say の内容が空' };
    return { ok: true, action: a.name, arg: s.slice(0, 100) };
  }
  if (a.argType === 'number') {
    const n = Number.parseFloat(s);
    const v = Number.isFinite(n) ? Math.min(10, Math.max(1, n)) : 3;
    return { ok: true, action: a.name, arg: String(v), fixed: !Number.isFinite(n) };
  }
  // choice: 完全一致 → 大文字小文字・前後の記号を無視 → 部分一致 (1つに決まるときだけ)
  const norm = (x) => String(x).toLowerCase().replace(/^minecraft:/, '').replace(/[\s"'`\[\]()]/g, '');
  let c = a.choices.find((x) => x.id === s);
  let fixed = false;
  // 一覧の表示 "id[説明]" をそのまま写したもの
  if (!c && /[\[(]/.test(s)) { c = a.choices.find((x) => x.id === s.split(/[\[(]/)[0].trim()); fixed = !!c; }
  if (!c) { c = a.choices.find((x) => norm(x.id) === norm(s)); fixed = !!c; }
  if (!c && s) {
    const hits = a.choices.filter((x) => norm(x.id).includes(norm(s)) || norm(s).includes(norm(x.id)));
    if (hits.length === 1) { c = hits[0]; fixed = true; }
  }
  if (!c) return { ok: false, action: a.name, error: `arg "${s}" は ${a.name} の候補にない` };
  return { ok: true, action: a.name, arg: c.id, choice: c, fixed };
}

module.exports = { listActions, actionsToText, resolveDecision, DIRECTIONS, HUNTABLE };
