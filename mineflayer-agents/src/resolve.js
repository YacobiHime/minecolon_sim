'use strict';
// 自由に書かれたゴールの名前を、マイクラの正式名 (minecraft-data 1.20.1 の名前) に直す (goalpath.js の freeform。2026-11-07 ユーザー決定)。
//   gpt-6-luna (文脈が広い) のときはゴールの物・状態・人・場所を候補の enum から選ばせず、自由に書かせる。ここで名前を直す。
//   物 (resolveItem):
//     1. 掃除: 前後の引用符・"minecraft:"・数 ("x3"・"×3"・"3個")・括弧書き (「石の斧 (stone axe)」は両方を試す)
//     2. 英語: 小文字・空白/ハイフン → "_" で正式名 (exact / normalized) → 表示名 ("Stone Axe"・"Steak" → cooked_beef。display)
//        → 種類の名前 ("planks"・"bed"・"log" → … _planks のうち 持っている > 見えている > 例に出した > 道筋の手間が小さい > oak_/white_。family)
//        → 複数形 ("torches"・"potatoes"。plural) → 1〜2文字の打ち間違い (fuzzy。いちばん近いものが1つだけのとき)
//     3. 日本語: names_ja の日本語名 (「の」・空白・中黒を除き、ひらがなはカタカナにして比べる。ja)、語尾だけ合う (「牛肉」→ 生の牛肉。ja_partial)、
//        種類の名前だけ (「板材」「ベッド」「ツルハシ」→ family)
//     直せないときは理由と近い名前 (suggestions) を返す。生き物・ブロックそのもの (持てない物) は「落とす物」を添える。
//   人 (resolvePerson)・場所 (resolvePlace)・状態 (resolveState) は下に。状態は今の型 (states.js) に当てはめ、当てはまらない文は
//   type: 'text' (済んだかを Jev の noul で聞く。goalpath.js) にする。
//   bot に依存しない。
const { index, Planner } = require('./planner');
const { jaName, WOOD, COLOR, SUFFIX } = require('./names_ja');
const states = require('./states');

const VERSION = '1.20.1';
const caches = new Map();

// ひらがな → カタカナ、全角英数 → 半角、「の」・空白・中黒・記号を除く
function normJa(s) {
  return String(s || '')
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))
    .replace(/[のノ\s・･、。,.\-_'"「」『』]/g, '')
    .toLowerCase();
}
function normEn(s) {
  return String(s || '').trim().toLowerCase().replace(/^minecraft:/, '').replace(/['’]s\b/g, 's').replace(/[\s\-.]+/g, '_').replace(/[^a-z0-9_]/g, '').replace(/_+/g, '_').replace(/^_|_$/g, '');
}
const hasJa = (s) => /[぀-ヿ㐀-鿿]/.test(String(s || ''));

// 日本語の生き物の名前 (状態の囲い・「生き物そのもの」の理由に使う)
const MOB_JA = { 牛: 'cow', ウシ: 'cow', 羊: 'sheep', ヒツジ: 'sheep', 豚: 'pig', ブタ: 'pig', 鶏: 'chicken', ニワトリ: 'chicken', ウサギ: 'rabbit', 兎: 'rabbit',
  ゾンビ: 'zombie', スケルトン: 'skeleton', クモ: 'spider', 蜘蛛: 'spider', クリーパー: 'creeper', 馬: 'horse', ウマ: 'horse' };

function tables(version = VERSION) {
  if (caches.has(version)) return caches.get(version);
  const ix = index(version);
  const md = ix.md;
  const items = md.itemsArray.map((it) => it.name);
  const isItem = new Set(items);
  const display = new Map(); // normEn(表示名) → [正式名]
  for (const it of md.itemsArray) { const k = normEn(it.displayName); display.set(k, [...(display.get(k) || []), it.name]); }
  const ja = new Map(); // normJa(日本語名) → [正式名]
  for (const n of items) { const j = jaName(n); if (!j) continue; const k = normJa(j); ja.set(k, [...(ja.get(k) || []), n]); }
  // 日本語の種類の名前 (語尾): 「板材」→ _planks、「ツルハシ」→ _pickaxe
  const jaSuffix = new Map(SUFFIX.map(([suf, j]) => [normJa(j), suf]));
  const blocksDrop = new Map(); // ブロック → [落とす物]
  for (const [item, srcs] of ix.blocks) for (const s of srcs) blocksDrop.set(s.block, [...(blocksDrop.get(s.block) || []), item]);
  const mobsDrop = new Map(); // 生き物 → [落とす物]
  for (const [item, ms] of ix.mobs) for (const m of ms) mobsDrop.set(m.mob, [...(mobsDrop.get(m.mob) || []), item]);
  const t = { ix, md, items, isItem, display, ja, jaSuffix, blocksDrop, mobsDrop, version };
  caches.set(version, t);
  return t;
}

function lev(a, b, max = 3) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// 名前の掃除: 数の書き方を外し、括弧書きを別の試しにする
function variantsOf(text) {
  let s = String(text ?? '').trim().replace(/^["'「『]+|["'」』]+$/g, '').trim();
  s = s.replace(/\s*(?:[x×*]\s*\d+|\d+\s*(?:個|本|枚|つ|匹|頭|マス|pcs?)?)\s*$/i, '').replace(/^\d+\s*(?:x|×|個の)?\s*/i, '').trim();
  const out = [s];
  const m = s.match(/^(.*?)\s*[（(](.*?)[)）]\s*$/);
  if (m) out.push(m[1].trim(), m[2].trim());
  for (const part of s.split(/\s*[\/／|、,]\s*/)) if (part && part !== s) out.push(part);
  return [...new Set(out.filter(Boolean))];
}

// 同じ種類の名前の中から1つ選ぶ: 持っている > 見えている > 例に出した > 道筋の手間が小さい > oak_/white_ > 先
function pick(names, prefer = {}) {
  if (names.length <= 1) return names[0] || null;
  const have = new Set(prefer.have || []); const seen = new Set(prefer.seen || []); const shown = new Set(prefer.shown || []);
  const pl = prefer.planner || null;
  const cost = (n) => { if (!pl) return Infinity; try { const c = pl.cost(n).c; return Number.isFinite(c) ? c : Infinity; } catch (_) { return Infinity; } };
  const rank = (n) => [have.has(n) ? 0 : 1, seen.has(n) ? 0 : 1, shown.has(n) ? 0 : 1, cost(n), /^(oak|white)_/.test(n) ? 0 : 1];
  const scored = names.map((n, i) => ({ n, r: rank(n), i }));
  scored.sort((a, b) => { for (let k = 0; k < a.r.length; k++) if (a.r[k] !== b.r[k]) return a.r[k] - b.r[k]; return a.i - b.i; });
  return scored[0].n;
}

function familyOf(t, s) {
  const fam = t.items.filter((n) => n.endsWith(`_${s}`));
  // 種類違い (木・色) の接頭辞だけの物に絞る ("axe" → stone_axe などは道具の材料違い。MAT は names_ja にあるが、ここでは全部を候補に)
  return fam;
}

// よく使われる言い方 (正式名の種類の名前に読み替える): "wood" は原木 (oak_wood は樹皮付きの木のブロック)
const EN_ALIAS = { wood: 'log', woods: 'log', lumber: 'planks', timber: 'log', plank: 'planks', bed: 'bed', meat: 'beef', cobble: 'cobblestone', seeds: 'wheat_seeds', seed: 'wheat_seeds' };
const JA_ALIAS = { 木: '原木', 木材: '板材', 丸太: '原木', 種: '小麦の種', 肉: '生の牛肉', 石: '丸石' };

// 英語の名前 → 正式名
function resolveEn(t, s0, prefer) {
  const s = EN_ALIAS[normEn(s0)] || normEn(s0);
  if (!s) return null;
  if (t.isItem.has(s)) return { name: s, via: s === s0 ? 'exact' : 'normalized' };
  const d = t.display.get(s);
  if (d && d.length) return { name: pick(d, prefer), via: 'display' };
  const fam = familyOf(t, s);
  if (fam.length) return { name: pick(fam, prefer), via: 'family', family: s };
  for (const [re, rep] of [[/ies$/, 'y'], [/es$/, ''], [/s$/, '']]) {
    if (!re.test(s)) continue;
    const p = s.replace(re, rep);
    if (t.isItem.has(p)) return { name: p, via: 'plural' };
    const dp = t.display.get(p);
    if (dp && dp.length) return { name: pick(dp, prefer), via: 'plural' };
    const fp = familyOf(t, p);
    if (fp.length) return { name: pick(fp, prefer), via: 'family', family: p };
  }
  return null;
}

function resolveJa(t, s0, prefer) {
  const k = normJa(JA_ALIAS[String(s0).trim()] || s0);
  if (!k) return null;
  const d = t.ja.get(k);
  if (d && d.length) return { name: pick(d, prefer), via: 'ja' };
  const suf = t.jaSuffix.get(k);
  if (suf) { const fam = t.items.filter((n) => n.endsWith(suf)); if (fam.length) return { name: pick(fam, prefer), via: 'family', family: suf.slice(1) }; }
  // 語尾が日本語名に合う (「牛肉」→ 生の牛肉)。2文字以上で、合うものの中から選ぶ
  if (k.length >= 2) {
    const hits = [];
    for (const [jk, ns] of t.ja) if (jk.endsWith(k) || (k.length >= 3 && jk.startsWith(k))) hits.push(...ns);
    if (hits.length && hits.length <= 3) return { name: pick([...new Set(hits)], prefer), via: 'ja_partial' };
  }
  return null;
}

function suggestions(t, s0, n = 3) {
  const s = normEn(s0);
  if (s) {
    const near = t.items.map((x) => ({ x, d: lev(s, x, 3) })).filter((o) => o.d <= 3).sort((a, b) => a.d - b.d).slice(0, n).map((o) => o.x);
    const part = t.items.filter((x) => s.length >= 3 && (x.includes(s) || s.includes(x) && x.length >= 4)).slice(0, n);
    return [...new Set([...near, ...part])].slice(0, n);
  }
  const k = normJa(s0);
  const out = [];
  for (const [jk, ns] of t.ja) if (k && (jk.includes(k) || k.includes(jk))) out.push(...ns);
  return [...new Set(out)].slice(0, n);
}

// text → { ok: true, name, via, from, family? } | { ok: false, why, whyEn, suggestions, mob?, block? }
//   prefer: { have: [持っている物], seen: [見えている物], shown: [例に出した物], planner }
function resolveItem(text, { version = VERSION, prefer = {} } = {}) {
  const t = tables(version);
  const from = String(text ?? '');
  for (const v of variantsOf(from)) {
    const r = hasJa(v) ? resolveJa(t, v, prefer) : resolveEn(t, v, prefer);
    if (r) return { ok: true, ...r, from };
  }
  // 打ち間違い (英語だけ。いちばん近いものが1つだけのとき)
  for (const v of variantsOf(from)) {
    if (hasJa(v)) continue;
    const s = normEn(v);
    if (s.length < 4) continue;
    const max = s.length >= 8 ? 2 : 1;
    const near = t.items.map((x) => ({ x, d: lev(s, x, max) })).filter((o) => o.d <= max).sort((a, b) => a.d - b.d);
    if (near.length && (near.length === 1 || near[0].d < near[1].d)) return { ok: true, name: near[0].x, via: 'fuzzy', from };
  }
  // 生き物・持てないブロック: 落とす物を添える
  const s = normEn(variantsOf(from)[0] || from);
  const mob = t.md.entitiesByName[s] ? s : MOB_JA[normJa(from)] || null;
  if (mob) {
    const drops = [...new Set(t.mobsDrop.get(mob) || [])].slice(0, 4);
    const pen = states.BREED_FOOD[mob] ? `、飼うなら状態 pen_${mob}` : '';
    return { ok: false, mob, why: `${mob} は生き物で、持ち物にできない (落とす物: ${drops.join('・') || 'なし'}${pen})`, whyEn: `${mob} is a mob, not an item`, suggestions: drops };
  }
  if (t.md.blocksByName[s]) {
    const drops = [...new Set(t.blocksDrop.get(s) || [])].slice(0, 4);
    return { ok: false, block: s, why: `${s} はブロックで、そのままでは持ち物にできない${drops.length ? ` (壊すと落ちる物: ${drops.join('・')})` : ''}`, whyEn: `${s} is a block that cannot be held`, suggestions: drops };
  }
  const sug = suggestions(t, from);
  return { ok: false, why: `「${from}」という物は知らない${sug.length ? ` (近い名前: ${sug.join('・')})` : ''}`, whyEn: `unknown item "${from}"`, suggestions: sug };
}

// 正式名の種類違い (木・色) のうち、道筋がたどれるもの (手間の小さい順)。たどれない物の言い換えに使う
function siblings(name, version = VERSION) {
  const t = tables(version);
  for (const p of [...Object.keys(WOOD), ...Object.keys(COLOR)].sort((a, b) => b.length - a.length)) {
    if (!name.startsWith(`${p}_`)) continue;
    const rest = name.slice(p.length + 1);
    return [...Object.keys(WOOD), ...Object.keys(COLOR)].map((q) => `${q}_${rest}`).filter((n) => n !== name && t.isItem.has(n));
  }
  return [];
}
function plannableVariant(name, planner, version = VERSION) {
  let best = null;
  for (const n of siblings(name, version)) { const c = planner.cost(n).c; if (Number.isFinite(c) && (!best || c < best.c)) best = { name: n, c }; }
  return best ? best.name : null;
}

// ---- 人 ----
// names: 知っている人の名前。返り値 { ok, name } | { ok: false, why }
function resolvePerson(text, names = []) {
  const s = String(text ?? '').trim().replace(/(さん|くん|君|ちゃん|様|san|kun)$/i, '').trim();
  const low = s.toLowerCase();
  const hit = names.find((n) => n.toLowerCase() === low) || names.find((n) => low && (low.startsWith(n.toLowerCase()) || n.toLowerCase().startsWith(low)) && low.length >= 2);
  if (hit) return { ok: true, name: hit, via: hit === text ? 'exact' : 'normalized' };
  return { ok: false, why: `「${text}」は知っている人の中にいない${names.length ? ` (知っている人: ${names.slice(0, 8).join('・')})` : ''}`, whyEn: `unknown person "${text}"` };
}

// ---- 場所 ----
const DIR_ALIAS = { north: '北', northeast: '北東', east: '東', southeast: '南東', south: '南', southwest: '南西', west: '西', northwest: '北西' };
// places: 場所の候補 (placeCandidates の形 + type: later)。mem: 覚えている場所 [{ id, kind, label, pos }] (候補に出していないものも)
//   arrived: 着いているので候補から外した場所 (拠点など)。名前が合えば「もう着いている」を理由に返す
function resolvePlace(text, places = [], mem = [], { arrived = [] } = {}) {
  const raw = String(text ?? '').trim();
  const s = raw.replace(/\s*[(（].*[)）]\s*$/, '').trim();
  const exact = places.find((p) => p.name === raw || p.name === s);
  if (exact) return { ok: true, place: exact, name: exact.name, via: 'exact' };
  const here = arrived.find((p) => p.name === raw || p.name === s);
  if (here) return { ok: false, arrived: true, why: 'もう着いている', whyEn: 'already there' };
  const low = normEn(s);
  const j = normJa(s);
  // 拠点
  if (/^(base|home|my_base|camp|near_(the_)?base|the_base)$/.test(low) || /^(自分)?(拠点|家|ホーム|ベース)(近ク|周リ|マワリ|ソバ)?$/.test(j)) {
    const b = places.find((p) => p.type === 'base');
    if (b) return { ok: true, place: b, name: b.name, via: 'alias' };
    if (arrived.some((p) => p.type === 'base')) return { ok: false, arrived: true, why: 'もう拠点に着いている', whyEn: 'already at the base' };
    return { ok: false, why: '拠点はまだない', whyEn: 'no base yet' };
  }
  // 方角 (「北」「北の方」「north」「far north」「北へ48m」)
  const dirJa = DIR_ALIAS[low.replace(/^(far_|the_|to_the_)+/, '').replace(/_(side|direction|way)$/, '')] || (j.match(/^(北東|北西|南東|南西|北|南|東|西)(方|方角|方向|ほう)?/) || [])[1];
  if (dirJa) { const p = places.find((x) => x.type === 'dir' && x.name === `${dirJa}の方`); if (p) return { ok: true, place: p, name: p.name, via: 'dir' }; }
  // M番号
  const m = s.match(/^m\s*(\d+)$/i);
  if (m) {
    const id = `M${m[1]}`;
    const p = places.find((x) => x.name === id);
    if (p) return { ok: true, place: p, name: id, via: 'normalized' };
    const q = mem.find((x) => x.id === id);
    if (q) return { ok: true, place: { name: q.id, desc: q.label, descEn: `a remembered place: ${q.kind}`, pos: q.pos, type: 'memory', kind: q.kind }, name: q.id, via: 'memory' };
  }
  // 覚えている場所の種類 (「水」「water」「村」→ その種類の M 番号のうち近いもの)。種類は物の名前 (正式名) で比べる
  const PLACE_JA = { 水: 'water', 水場: 'water', 川: 'water', 池: 'water', 溶岩: 'lava', 村: 'village' };
  const it = resolveItem(s);
  const kind = PLACE_JA[s] || (it.ok ? it.name : low);
  const memHits = [...places.filter((p) => p.type === 'memory' && p.kind === kind), ...mem.filter((q) => q.kind === kind).map((q) => ({ name: q.id, desc: q.label, descEn: `a remembered place: ${q.kind}`, pos: q.pos, type: 'memory', kind: q.kind, d: q.d }))];
  if (memHits.length) { const p = memHits.sort((a, b) => (a.d ?? 0) - (b.d ?? 0))[0]; return { ok: true, place: p, name: p.name, via: 'kind' }; }
  const later = places.find((p) => p.type === 'later' && (p.name.startsWith(s) || normJa(p.name).startsWith(j)));
  if (later) return { ok: true, place: later, name: later.name, via: 'later' };
  const names = places.map((p) => p.name);
  return { ok: false, why: `「${raw}」という場所は分からない (分かる場所: ${names.slice(0, 12).join('・')})`, whyEn: `unknown place "${raw}"` };
}

// 文を語に分ける (助詞・数・よくある語を除く)
const STOP = /^(chest|chests|barrel|in|the|a|an|of|put|store|into|near|base|have|has|get|obtain|collect|gather|some|my|i|chest|チェスト|拠点|近く|入れる|入っている|ある|いる|しまう|個|樽|箱|手|持って|持つ|集める|集めて|ている|て|近くの|草から)$/i;
function wordsOf(raw) {
  return String(raw).replace(/[()（）]/g, ' ').split(/[\s、,・にをがへでと]+|から|\d+\s*(?:個|本|枚|つ|匹|頭)?/).map((w) => w.trim()).filter((w) => w && !STOP.test(w) && !/^(手に入れ|入れ|持って|集め)/.test(w));
}

// ---- 状態 ----
// 今の型 (states.js) に当てはめる。返り値 { ok, id, state, via } | { ok: true, state: { type: 'text', text }, via: 'text' } | { ok: false, why }
//   cands: 状態の候補 (stateCandidates。shared_ の id もここから)。allowText: 当てはまらない文を text の状態にするか
function resolveState(text, { cands = [], allowText = true, version = VERSION } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, why: '状態が書かれていない' };
  const t = tables(version);
  const pid = states.parseStateId(normEn(raw));
  const validId = pid && (!pid.item || t.isItem.has(pid.item));
  const direct = cands.find((c) => c.name === raw) || (validId ? { name: normEn(raw), state: pid } : null);
  if (direct) return { ok: true, id: direct.name, state: direct.state, via: direct.name === raw ? 'exact' : 'normalized' };
  const low = raw.toLowerCase();
  const j = normJa(raw);
  const has = (re) => re.test(low) || re.test(j);
  const mobOf = () => {
    for (const a of states.PEN_ANIMALS) if (new RegExp(`\\b${a}s?\\b`).test(low)) return a;
    for (const [k, v] of Object.entries(MOB_JA)) if (raw.includes(k) && states.PEN_ANIMALS.includes(v)) return v;
    return null;
  };
  const id = (x) => ({ ok: true, id: x, state: states.parseStateId(x), via: 'keyword' });
  // 囲いの動物
  const animal = mobOf();
  if (animal && has(/pen|enclos|fence|corral|囲|柵|飼/)) return id(`pen_${animal}`);
  // 植わっている作物
  const crops = { wheat: /wheat|小麦/, carrots: /carrot|ニンジン|にんじん/, potatoes: /potato|ジャガイモ|じゃがいも/, beetroots: /beetroot|ビートルート/ };
  if (has(/plant|sow|grow|植|育|畑に/)) for (const [c, re] of Object.entries(crops)) if (re.test(low) || re.test(raw)) return id(`planted_${c}`);
  // 耕地
  if (has(/farmland|till|hydrat|耕地|耕|畑/)) return id('farmland');
  // 明かり
  if (has(/torch|light|lit|lantern|bright|明かり|明る|松明|たいまつ|ランタン/) && !has(/^light_(gray|blue)/)) return id('lit_base');
  // 拠点の囲い・壁
  if (has(/wall|enclos|fenc|囲|壁|守/) && has(/base|home|拠点|家|周り|まわり/)) return id('walled_base');
  // チェストの中身 (共有のチェストの候補が合えばそれ)
  if (has(/chest|barrel|チェスト|樽|箱/)) {
    for (const w of [raw, ...wordsOf(raw)]) {
      const r = resolveItem(w, { version });
      if (!r.ok) continue;
      const shared = cands.find((c) => c.state && c.state.type === 'shared' && c.state.item === r.name);
      if (shared && has(/shared|共有/)) return { ok: true, id: shared.name, state: shared.state, via: 'keyword' };
      return id(`chest_${r.name}`);
    }
  }
  // 物を持っている・手に入れた様子 (「小麦の種を1個手に入れている」) は物のゴールに直す (asItem)
  if (has(/手に入|持って|持つ|集め|集ま|have|obtain|collect|gather|get /)) {
    for (const w of wordsOf(raw)) { const r = resolveItem(w, { version }); if (r.ok && r.via !== 'fuzzy') return { ok: true, asItem: r.name, via: 'state_to_item' }; }
  }
  if (!allowText) return { ok: false, why: `「${raw}」は確かめられる状態の形に合わない (確かめられる状態: ${[...new Set(cands.map((c) => c.name))].slice(0, 10).join('・')})` };
  return { ok: true, state: { type: 'text', text: raw.slice(0, 80) }, via: 'text' };
}

module.exports = { resolveItem, resolvePerson, resolvePlace, resolveState, plannableVariant, siblings, normJa, normEn, variantsOf, pick, tables, lev, MOB_JA, hasJa };
