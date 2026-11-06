'use strict';
// あとでやること (展望記憶)。始めたことのうち、時間がたってから結果が出るものを覚えておく。
//   共通の形: { id, kind, pos (場所), start (始めたゲーム内の時刻 = ワールドの age、tick), dueMin・dueMax (見込みの時刻、tick), what (中身), n, ... }
//   kind: crop (作物を植えた → 育ちきる)・smelt (かまどに入れたまま → 焼き上がる)・grow_up (子どもが生まれた → 大人になる)・
//         breed_again (繁殖させた → 次に繁殖できる)
//   見込みの時刻は仕様の事実 (knowledge/facts.json の crop_time・smelt_time・mob_baby・mob_breed_cooldown) から:
//     作物: 明るい所の湿った耕地で 20〜30分、乾いた耕地ではおよそ倍。見えたときは作物の育ち (age) から見込みを直す (骨粉・湿り具合で変わる分)
//     かまど: 1個 10秒。子ども: およそ20分で大人。繁殖: 5分ほど次の繁殖ができない
//   時刻はゲーム内の時刻 (tick。20 tick = 1秒、1200 tick = 1分) で持つ。倍速 (tickrate) を変えても、ゲーム内で何分たったかは正しい。
//   モデルには言葉だけ (「M2に小麦を3本植えた (約8分前。育つのはあと15分ほど)」)。数値はここで持つ。
// 研究方針: 事実だけ。どう使うと良いか・取りに行くべきかは書かない。取りに行くかは 2B がゴールの候補から選ぶ。
const { jaName } = require('./names_ja');
const { relDir, dist3 } = require('./util');
const { whereEn } = require('./en');

const TPM = 1200; // 1分の tick
const DEFAULTS = {
  maxItems: 24, // 覚えておく数 (済んだもの・古いものから忘れる)
  cropMin: 20 * TPM, cropMax: 30 * TPM, dryFactor: 2, // crop_time の事実
  smeltPer: 200, // かまどは1個 10秒 (smelt_time の事実)
  growUp: 20 * TPM, breedAgain: 5 * TPM, // mob_baby・mob_breed_cooldown の事実
  mergeDist: 6, // 同じ種類・同じ中身で、この距離以内の所は1つにまとめる (畑の続きに植えたなど)
  seeRadius: 12, // ここまで近くにいれば、作物の育ちを見て見込みを直す
  scan: 4, // 作物を数える範囲 (場所から水平にこのマス)
  harvestDist: 10, // 作物を取った所がここまで近ければ、その作物を取ったとする
  promptMax: 4, // プロンプトに入れる数
  goalMax: 3, // ゴールの候補に出す数 (見込みの時刻の早い順)
  keepDoneTicks: 10 * TPM, // 済んだものはこのあいだ残す (記録・「取った」の言葉のため)
};

const CROP_JA = { wheat: '小麦', carrots: 'にんじん', potatoes: 'じゃがいも', beetroots: 'ビートルート' };
const CROP_ITEM = { wheat: 'wheat', carrots: 'carrot', potatoes: 'potato', beetroots: 'beetroot' };
const CROP_MAX_AGE = { wheat: 7, carrots: 7, potatoes: 7, beetroots: 3 };
const ANIMAL_JA = { cow: '牛', sheep: '羊', pig: '豚', chicken: '鶏', rabbit: 'ウサギ', horse: '馬', donkey: 'ロバ', goat: 'ヤギ', mooshroom: 'ムーシュルーム', llama: 'ラマ', turtle: 'カメ' };
const KIND_JA = { crop: '作物', smelt: 'かまど', grow_up: '動物の子ども', breed_again: '繁殖' };

const ja = (n) => CROP_JA[n] || ANIMAL_JA[n] || jaName(n) || n;

// ゲーム内の分 (言葉)。ago: 「約8分前」/ left: 「15分ほど」
function minutesJa(t) {
  const m = Math.max(0, t / TPM);
  if (m < 1) return '1分足らず';
  if (m < 10) return `${Math.round(m)}分`;
  if (m < 90) return `${Math.round(m / 5) * 5}分`;
  return `${Math.round(m / 30) / 2}時間`;
}
function minutesEn(t) {
  const m = Math.max(0, t / TPM);
  if (m < 1) return 'less than a minute';
  if (m < 10) return `${Math.round(m)} min`;
  if (m < 90) return `${Math.round(m / 5) * 5} min`;
  return `${Math.round(m / 30) / 2} hours`;
}

function round(p) { return { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) }; }

class Prospects {
  // store: 配列を入れておく所 (memory.extra。保存・読み込みは memory と一緒)
  constructor(store = {}, cfg = {}) {
    this.cfg = { ...DEFAULTS, ...cfg };
    this.store = store;
    if (!Array.isArray(this.store.prospects)) this.store.prospects = [];
    if (!Number.isFinite(this.store.prospectSeq)) this.store.prospectSeq = 0;
  }

  get list() { return this.store.prospects; }
  open() { return this.list.filter((x) => !x.done); }

  // 見込みの時間 (tick)。[min, max]
  span(kind, what = {}, n = 1) {
    const c = this.cfg;
    if (kind === 'crop') { const f = what.wet === false ? c.dryFactor : 1; return [c.cropMin * f, c.cropMax * f]; }
    if (kind === 'smelt') { const t = c.smeltPer * Math.max(1, n); return [t, t]; }
    if (kind === 'grow_up') return [c.growUp, c.growUp];
    if (kind === 'breed_again') return [c.breedAgain, c.breedAgain];
    return [0, 0];
  }

  // 足す。同じ種類・同じ中身で近くの、済んでいないものがあれば数を足してまとめる (見込みは遅い方に広げる)。返り値 { item, merged }
  add(kind, { pos, now, n = 1, what = {}, loop = null }) {
    if (!pos || !Number.isFinite(now)) return null;
    const [a, b] = this.span(kind, what, n);
    const key = what.crop || what.input || what.animal || '';
    const near = this.open().find((x) => x.kind === kind && (x.what.crop || x.what.input || x.what.animal || '') === key && dist3(x.pos, pos) <= this.cfg.mergeDist);
    if (near) {
      near.n += n;
      near.last = now;
      if (kind === 'smelt') { const [, bb] = this.span(kind, what, near.n); near.dueMin = near.start + bb; near.dueMax = near.dueMin; } else { near.dueMax = Math.max(near.dueMax, now + b); }
      if (what.wet === false) near.what.wet = false;
      return { item: near, merged: true };
    }
    this.store.prospectSeq += 1;
    const item = { id: `L${this.store.prospectSeq}`, kind, pos: round(pos), start: now, last: now, dueMin: now + a, dueMax: now + b, n, what: { ...what }, loop, dueAt: null, done: null };
    this.list.push(item);
    this.trim(now);
    return { item, merged: false };
  }

  trim(now) {
    const c = this.cfg;
    const keep = this.list.filter((x) => !x.done || (Number.isFinite(now) && now - x.done.at <= c.keepDoneTicks));
    keep.sort((a, b) => (!!a.done - !!b.done) || (b.start - a.start));
    this.store.prospects = keep.slice(0, c.maxItems);
  }

  // 済んだ (取った・取り出した・無くなった)。返り値 記録 | null
  finish(item, { now, how, loop = null }) {
    if (!item || item.done) return null;
    item.done = { at: now, how, loop };
    return { op: 'done', id: item.id, kind: item.kind, how, what: item.what, n: item.n, pos: item.pos, sinceStartMin: round1((now - item.start) / TPM),
      afterDue: now >= item.dueMin, overdueMin: now >= item.dueMin ? round1((now - item.dueMin) / TPM) : null, loop };
  }

  // 見込みの時刻になったもの (初めてなったときだけ)。返り値 記録の配列
  tick(now, loop = null) {
    const out = [];
    for (const x of this.open()) {
      if (x.dueAt == null && now >= x.dueMin) { x.dueAt = now; out.push({ op: 'due', id: x.id, kind: x.kind, what: x.what, n: x.n, pos: x.pos, sinceStartMin: round1((now - x.start) / TPM), loop }); }
    }
    this.trim(now);
    return out;
  }

  // 作物の様子を見る (近くにいるときだけ)。blockAt(x,y,z) でブロックを読む。
  //   全部育ちきっていれば ripeSeenAt。作物が1本も無ければ (誰かが取った・踏まれた) gone で済んだにする。途中なら age から見込みを直す
  observeCrops(blockAt, here, now, loop = null) {
    const out = [];
    if (typeof blockAt !== 'function' || !here) return out;
    const c = this.cfg;
    for (const x of this.open().filter((q) => q.kind === 'crop' && dist3(q.pos, here) <= c.seeRadius)) {
      const crop = x.what.crop;
      const max = CROP_MAX_AGE[crop] ?? 7;
      let cnt = 0; let ripe = 0; let ageSum = 0; let wet = null; let read = 0;
      for (let dx = -c.scan; dx <= c.scan; dx++) for (let dz = -c.scan; dz <= c.scan; dz++) for (let dy = -1; dy <= 1; dy++) {
        let b = null;
        try { b = blockAt(x.pos.x + dx, x.pos.y + dy, x.pos.z + dz); } catch (_) { b = null; }
        if (!b) continue;
        read += 1;
        if (b.name !== crop) continue;
        cnt += 1;
        let age = null;
        try { age = typeof b.getProperties === 'function' ? Number(b.getProperties().age) : (b.age ?? null); } catch (_) { age = null; }
        if (!Number.isFinite(age)) age = 0;
        ageSum += Math.min(age, max);
        if (age >= max) ripe += 1;
        if (wet == null) {
          let f = null;
          try { f = blockAt(x.pos.x + dx, x.pos.y + dy - 1, x.pos.z + dz); } catch (_) { f = null; }
          if (f && f.name === 'farmland') {
            let m = null;
            try { m = typeof f.getProperties === 'function' ? Number(f.getProperties().moisture) : (f.moisture ?? null); } catch (_) { m = null; }
            if (Number.isFinite(m)) wet = m === 7;
          }
        }
      }
      if (!read) continue; // 読み込まれていない
      if (!cnt) { const r = this.finish(x, { now, how: 'gone', loop }); if (r) out.push(r); continue; }
      x.seen = { at: now, count: cnt, ripe };
      if (wet != null) x.what.wet = wet;
      if (ripe >= cnt) { if (x.ripeSeenAt == null) { x.ripeSeenAt = now; out.push({ op: 'ripe_seen', id: x.id, kind: x.kind, what: x.what, n: x.n, count: cnt, sinceStartMin: round1((now - x.start) / TPM), loop }); } continue; }
      // 見込みを直す: 残りの段の割合 × 見込みの時間 (今の湿り具合で)
      const frac = 1 - ageSum / (cnt * max);
      const [a, b] = this.span('crop', x.what);
      x.dueMin = Math.round(now + frac * a); x.dueMax = Math.round(now + frac * b);
      if (x.dueAt != null && now < x.dueMin) x.dueAt = null;
    }
    return out;
  }

  // 作物を取った (持ち物の作物が増えた)。here の近くの作物のものを済んだにする
  harvested(here, gained, now, loop = null) {
    const out = [];
    for (const x of this.open().filter((q) => q.kind === 'crop' && dist3(q.pos, here) <= this.cfg.harvestDist)) {
      if ((gained[CROP_ITEM[x.what.crop]] || 0) > 0) { const r = this.finish(x, { now, how: 'harvested', loop }); if (r) out.push(r); }
    }
    return out;
  }

  // かまどから取り出した (furnace_take・smelt で取り出した)
  furnaceTaken(pos, now, loop = null) {
    const out = [];
    for (const x of this.open().filter((q) => q.kind === 'smelt' && dist3(q.pos, pos) <= 1.5)) { const r = this.finish(x, { now, how: 'taken', loop }); if (r) out.push(r); }
    return out;
  }

  // 場所の呼び方: 覚えている場所 (M 番号) の近くならその番号、無ければ自分からの方角
  static refJa(pos, { here = null, places = [] } = {}) {
    const m = (places || []).find((p) => p.pos && dist3(p.pos, pos) <= 4);
    if (m) return m.id;
    return here ? relDir(here, pos) : `(${pos.x}, ${pos.y}, ${pos.z})`;
  }
  static refEn(pos, { here = null, places = [] } = {}) {
    const m = (places || []).find((p) => p.pos && dist3(p.pos, pos) <= 4);
    if (m) return m.id;
    return here ? whereEn(here, pos) : `(${pos.x}, ${pos.y}, ${pos.z})`;
  }

  // 1件の文。「M2に小麦を3本植えた (約8分前。育つのはあと15分ほど)」
  textJa(x, now, opt = {}) {
    const where = Prospects.refJa(x.pos, opt);
    const ago = `約${minutesJa(now - x.start)}前`;
    const mid = (x.dueMin + x.dueMax) / 2;
    const due = now >= x.dueMin;
    if (x.kind === 'crop') {
      const st = x.done ? (x.done.how === 'harvested' ? '取った' : '見に行ったら無くなっていた')
        : x.ripeSeenAt != null ? '育ちきっているのを見た' : due ? '育っている頃' : `育つのはあと${minutesJa(mid - now)}ほど`;
      return `${where}に${ja(x.what.crop)}を${x.n}本植えた (${ago}。${st})`;
    }
    if (x.kind === 'smelt') {
      const st = x.done ? '取り出した' : due ? '焼き上がっている頃' : `焼き上がるのはあと${minutesJa(mid - now)}ほど`;
      return `${where}のかまどに${ja(x.what.input)}を${x.n}個入れた (${ago}。${st})`;
    }
    if (x.kind === 'grow_up') {
      const st = due ? '大人になっている頃' : `大人になるのはあと${minutesJa(mid - now)}ほど`;
      return `${where}で${ja(x.what.animal)}の子どもが${x.n}匹生まれた (${ago}。${st})`;
    }
    if (x.kind === 'breed_again') {
      const st = due ? '次に繁殖できる頃' : `次に繁殖できるのはあと${minutesJa(mid - now)}ほど`;
      return `${where}で${ja(x.what.animal)}に餌をやって繁殖させた (${ago}。${st})`;
    }
    return '';
  }

  textEn(x, now, opt = {}) {
    const where = Prospects.refEn(x.pos, opt);
    const ago = `about ${minutesEn(now - x.start)} ago`;
    const mid = (x.dueMin + x.dueMax) / 2;
    const due = now >= x.dueMin;
    if (x.kind === 'crop') {
      const st = x.done ? (x.done.how === 'harvested' ? 'harvested' : 'gone when checked')
        : x.ripeSeenAt != null ? 'seen fully grown' : due ? 'expected to be fully grown by now' : `expected to be fully grown in about ${minutesEn(mid - now)}`;
      return `planted ${x.n} ${x.what.crop} at ${where} (${ago}; ${st})`;
    }
    if (x.kind === 'smelt') {
      const st = x.done ? 'taken out' : due ? 'expected to be done by now' : `expected to be done in about ${minutesEn(mid - now)}`;
      return `put ${x.n} ${x.what.input} in the furnace at ${where} (${ago}; ${st})`;
    }
    if (x.kind === 'grow_up') {
      const st = due ? 'expected to be grown up by now' : `expected to grow up in about ${minutesEn(mid - now)}`;
      return `${x.n} baby ${x.what.animal} born at ${where} (${ago}; ${st})`;
    }
    if (x.kind === 'breed_again') {
      const st = due ? 'can breed again by now' : `can breed again in about ${minutesEn(mid - now)}`;
      return `bred ${x.what.animal} at ${where} (${ago}; ${st})`;
    }
    return '';
  }

  // プロンプト用 (済んでいないもの + 済んだばかりのもの、見込みの早い順)
  shown(now) {
    const open = this.open().sort((a, b) => a.dueMin - b.dueMin);
    const done = this.list.filter((x) => x.done).sort((a, b) => b.done.at - a.done.at);
    return [...open, ...done].slice(0, this.cfg.promptMax);
  }
  textsJa(now, opt = {}) { return Number.isFinite(now) ? this.shown(now).map((x) => this.textJa(x, now, opt)) : []; }
  textsEn(now, opt = {}) { return Number.isFinite(now) ? this.shown(now).map((x) => this.textEn(x, now, opt)) : []; }

  // ゴールの候補 (場所の種類 later)。見込みの時刻を過ぎた、済んでいないものだけ。取りに行くかは 2B が選ぶ
  //   「小麦を取りに行く@M2」: 「M2、植えてから約25分。育っている頃」
  goalCandidates(now, opt = {}) {
    if (!Number.isFinite(now)) return [];
    const out = [];
    for (const x of this.open().filter((q) => now >= q.dueMin).sort((a, b) => a.dueMin - b.dueMin).slice(0, this.cfg.goalMax)) {
      const where = Prospects.refJa(x.pos, opt);
      const whereE = Prospects.refEn(x.pos, opt);
      const since = minutesJa(now - x.start); const sinceE = minutesEn(now - x.start);
      let name; let desc; let descEn;
      if (x.kind === 'crop') {
        name = `${ja(x.what.crop)}を取りに行く@${where}`;
        desc = `${where}、植えてから約${since}。${x.ripeSeenAt != null ? '育ちきっているのを見た' : '育っている頃'}`;
        descEn = `go get the ${x.what.crop} planted at ${whereE} (planted about ${sinceE} ago; ${x.ripeSeenAt != null ? 'seen fully grown' : 'expected to be fully grown by now'})`;
      } else if (x.kind === 'smelt') {
        name = `かまどの${ja(x.what.output || x.what.input)}を取りに行く@${where}`;
        desc = `${where}、${ja(x.what.input)}を入れてから約${since}。焼き上がっている頃`;
        descEn = `go take what was smelted in the furnace at ${whereE} (put in about ${sinceE} ago; expected to be done by now)`;
      } else {
        name = `${ja(x.what.animal)}の所へ行く@${where}`;
        desc = `${where}、${x.kind === 'grow_up' ? '子どもが生まれてから' : '繁殖させてから'}約${since}。${x.kind === 'grow_up' ? '大人になっている頃' : '次に繁殖できる頃'}`;
        descEn = `go to the ${x.what.animal} at ${whereE} (${x.kind === 'grow_up' ? 'born' : 'bred'} about ${sinceE} ago; ${x.kind === 'grow_up' ? 'expected to be grown up by now' : 'can breed again by now'})`;
      }
      if (out.some((o) => o.name === name)) name = `${name}(${x.id})`;
      out.push({ name, desc, descEn, pos: x.pos, type: 'later', laterId: x.id, laterKind: x.kind });
    }
    return out;
  }

  counts() {
    const out = {};
    for (const x of this.list) out[x.kind] = (out[x.kind] || 0) + 1;
    return out;
  }
}

function round1(v) { return Math.round(v * 10) / 10; }

module.exports = { Prospects, DEFAULTS, TPM, CROP_JA, CROP_ITEM, ANIMAL_JA, KIND_JA, minutesJa, minutesEn };
