#!/usr/bin/env node
'use strict';
// 100人の persona を、根拠のある人のモデルから乱数の種を固定して作る (2026-11-10 ユーザー決定「人の設定は自分で考えず、根拠のある人のモデルを取り入れる。
//   年齢を分散させて増やす」)。
// 使い方: node mineflayer-agents/tools/gen_personas.js [--n 100] [--seed 20261110] [--base configs/survival_3days.json] [--out configs/survival_100.json] [--check]
//   --check: 書かずに、今の out と同じものができるかだけ確かめる (違えば終了コード 1)
// out は base の設定 (personas 以外) をそのまま写し、personas だけを作ったものに替える。base を変えたら作り直す (test/personas100.test.js が差を見つける)。
//
// ■ 年齢と性別 (personas/jp_population_2024.json)
//   総務省統計局「人口推計 (2024年10月1日現在)」第1表 (各歳・男女別の総人口)。https://www.stat.go.jp/data/jinsui/2024np/index.html
//   層: 子供 10〜14・若者 15〜29・大人 30〜64・老人 65〜89。人口比そのままだと 100人中 子供 5人・若者 16人になり、層ごとの違いを見られない。
//   層ごとに均すと人口の形が消える。そこで「各層に floor 人 (20) を必ず置き、残り (n − 4×floor = 20) を層の人口の割合で分ける (最大剰余)」にした。
//   層の中の年齢と性別は、その層の各歳・男女の人口に比例して系統抽出する (老人は女性が多い、など人口の形が残る)。
//   子供が 10 歳からなのは、性格の年齢差のデータ (Soto ら 2011) が 10 歳からしかないため (10 歳未満は推測になるので作らない)。
//   90 歳以上 (人口の 2.2%) は性格のデータが無く (川本ら 2015 は 79 歳まで)、外挿が長くなるので入れない。
// ■ 性格 (Big Five。personas/bigfive_age.json)
//   成人 (25〜79 歳): 川本ら (2015) 日本人 4,588 名の TIPI-J の年代×性別の平均と SD (Table 3) を、年代の中央 (25, 35, …, 75 歳) の値として線でつなぐ。
//     80 歳以上は 70 代の値のまま (外挿しない)。
//   10〜24 歳: 日本の大規模な規準が無いので、25 歳の値に Soto ら (2011) の年齢差 (T 得点の差 ÷ 10 = SD 単位) を足す。
//   個人の値: z = 平均 (年齢・性別) + SD 比 × (相関 R を持つ標準正規)。R は川本ら (2015) の特性間の相関 (Table 2)。
//   z は日本の成人全体 (川本ら 2015 の Table 2 の平均・SD) を基準にした標準得点。bigFive には TIPI-J の得点 (2〜14) も残す。
// ■ 気質 (0〜1) への写し方: 気質 = Φ(w·z / sqrt(wᵀRw)) (日本の成人の中での位置。成人全体なら 0〜1 に一様)
//   sociability = E                         (社交性は外向性の中核。TIPI の E 項目「活発で、外向的」)
//   empathy     = A                         (協調性は共感的関心・援助と結びつく。Graziano, Habashi, Sheese, & Tobin 2007, JPSP 93, 583-599)
//   obedience   = 0.4C + 0.4A − 0.2N        (同調・規範に沿う傾向は「安定性」A・C・情緒安定 で予測される。DeYoung, Peterson, & Higgins 2002, PAID 33, 533-552)
//   greed       = −0.7A + 0.3N              (特性としての貪欲さは協調性と負、神経症傾向と正。Mussel ら の GTM、Zeelenberg ら 2022, EJPA の総説 doi:10.1027/1015-5759/a000647)
//   bravery     = −0.55N + 0.45E            (bravery = 損害回避 (Cloninger) の逆。損害回避は N と r = .68、E と r = −.60)
//   curiosity   = O  (needs.drives.curiosity = 0.2 + 0.7 × Φ(zO))  (開放性は知的好奇心を含む)
// ■ 欲求 (needs) の人ごとの差。体の能力 (速さ・体力) はゲームで変えられないので変えない (心の側だけ)
//   性格から: safety.threshold = 0.5 − 0.08 zN、stress.k = 0.012 × (1 + 0.25 zN)  (神経症傾向 = 脅威への敏感さ・ストレス反応の大きさ。
//             Suls & Martin 2005, J. Pers. 73, 1485-1510)。つながりの速さは needs.js が sociability で既に変える (二重にしない)
//   年齢から (根拠の強さを付ける):
//     眠気 sleep.fullAfter = 30000 × (起きている時間 / 16h)。推奨の睡眠 (NSF、Hirshkowitz ら 2015, Sleep Health 1, 40-43):
//       6〜13 歳 9〜11h (中央 10h → 起きている 14h)、14〜17 歳 8〜10h (9h → 15h)、18〜64 歳 7〜9h (8h → 16h)、65 歳以上 7〜8h (7.5h → 16.5h)  [強]
//     眠くなる時刻 sleep.threshold: 夜型は約 20 歳で最も遅く、その後は年とともに朝型 (Roenneberg ら 2004, Curr. Biol. 14, R1038)。
//       15〜25 歳 0.6 (遅い)・10〜14 と 26〜64 歳 0.55 (既定)・65 歳以上 0.5 (早く眠い)  [中: 時刻の変化をしきい値で近似]
//     空腹 hunger.sensitivity: 65 歳以上 0.8 (健康な高齢者は空腹感が 25〜39% 低く、摂取量は 16〜20% 少ない。Giezenaar ら 2016, Nutrients 8, 28)  [強]
//       10〜17 歳 1.1 (成長期で体重あたりのエネルギーの要る量が大きい。日本人の食事摂取基準)  [弱]
//     夜の怖さ safety.dark・nightOutside × 1.4 (10〜14 歳。4〜12 歳の 73% が夜の怖さを持つ。Muris ら 2001, BRAT 39, 13-28)  [中]
//     つながり (65 歳以上): connection.bond 0.3 → 0.45・near 0.015 → 0.008 (年を取ると親しい少数の相手を選び、周辺の相手は減る。
//       社会情動的選択性理論 Carstensen ら 1999, Am. Psychol. 54, 165-181、English & Carstensen 2014, IJBD 38, 195-202)  [中]
//     認められたい (15〜19 歳): recognition.fullAfter 16000 → 12000 (青年期は仲間からの評価に敏感。Somerville 2013, CDPS 22, 121-127)  [中]
//     入れなかったもの: 独り言の多さ (toolVoice) は年齢差の根拠が弱い (幼児の私的発話の研究が主) ので入れず、toolwant.js が気質から出す。
//       子供の好奇心の上乗せ (Gopnik 2020 の探索の理論) も量の根拠が無いので入れない。
// ■ 名前: 明治安田生命「生まれ年別名前ベスト10」(生まれ年 = 2026 − 年齢、性別) から、生まれ年に近い年の上位の名前を引く。
//   全員の名前を一度に、年の差の和が最小になるように割り当てる (ハンガリー法。assignNames)。
//   読みは表に無いので、よくある読み (READING) をここで付けた (同じ字で別の読みもありうる)。
//   Minecraft の名前 (英字 3〜16 字)・重ならない・先頭3文字も重ならない (ほかの名前の先頭に含まれない)。
// ■ 性格の文: TIPI-J の項目の語 (小塩ら 2012) と英語版 TIPI (Gosling ら 2003) から、|z| の大きい特性を最大3つ。職業・役割の語は入れない。
//   「発想力に欠けた、平凡な」(O−) だけは人を貶める語なので「慣れたやり方を好み、新しい発想は少ない」に言い換えた。
// ■ 並び: --agents N は先頭から N 人なので、4層を順に1人ずつ交互に並べる (先頭 20 人でも層が混ざる)。

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'personas');
const TRAITS = ['E', 'A', 'C', 'N', 'O'];
const LAYERS = [
  { key: 'child', ja: '子供', from: 10, to: 14 },
  { key: 'youth', ja: '若者', from: 15, to: 29 },
  { key: 'adult', ja: '大人', from: 30, to: 64 },
  { key: 'elder', ja: '老人', from: 65, to: 89 },
];
const layerOf = (age) => LAYERS.find((l) => age >= l.from && age <= l.to) || null;

// 気質の写し方 (重み w。z の順は TRAITS)
const TEMPERAMENT_MAP = {
  sociability: { E: 1 },
  empathy: { A: 1 },
  obedience: { C: 0.4, A: 0.4, N: -0.2 },
  greed: { A: -0.7, N: 0.3 },
  bravery: { N: -0.55, E: 0.45 },
};

// ---- 乱数 (種を固定) ----
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function normal(rng) { let u = 0; while (u === 0) u = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng()); }

// 標準正規の分布関数 (Abramowitz & Stegun 7.1.26 の erf)
function phi(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}
function cholesky(R) {
  const n = R.length; const L = R.map(() => new Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let s = R[i][j]; for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
    L[i][j] = i === j ? Math.sqrt(s) : s / L[j][j];
  }
  return L;
}
const r2 = (v) => Math.round(v * 100) / 100;
const r1 = (v) => Math.round(v * 10) / 10;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function interp(points, x) {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i]; const [x0, y0] = points[i - 1];
    if (x <= x1) return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
  }
  return points[points.length - 1][1];
}

function loadData() {
  return {
    pop: JSON.parse(fs.readFileSync(path.join(DATA, 'jp_population_2024.json'), 'utf8')),
    bf: JSON.parse(fs.readFileSync(path.join(DATA, 'bigfive_age.json'), 'utf8')),
    names: JSON.parse(fs.readFileSync(path.join(DATA, 'names_meijiyasuda.json'), 'utf8')),
  };
}

// 年齢・性別ごとの Big Five の平均 (z) と SD 比
function traitNorm(bf, age, sex) {
  const ov = bf.adult.overall; const dec = bf.adult.byDecade[sex];
  const at = (a, t) => {
    const pts = Object.keys(dec).map((d) => [Number(d) + 5, dec[d][t]]); // 20 代 → 25 歳
    const m = interp(pts.map(([x, v]) => [x, v[0]]), a); const sd = interp(pts.map(([x, v]) => [x, v[1]]), a);
    return { z: (m - ov[t][0]) / ov[t][1], sdr: sd / ov[t][1] };
  };
  const out = {};
  for (const t of TRAITS) {
    if (age >= 25) { out[t] = at(age, t); continue; }
    const base = at(25, t);
    out[t] = { z: base.z + interp(bf.youth.offset[sex][t], age), sdr: base.sdr };
  }
  return out;
}

// 層の人数: 各層 floor 人 + 残りを人口の割合で (最大剰余)
function layerCounts(pop, n, floor = 20) {
  const sizes = LAYERS.map((l) => { let s = 0; for (let a = l.from; a <= l.to; a++) { const p = pop.byAge[a]; s += p.male + p.female; } return s; });
  const total = sizes.reduce((s, x) => s + x, 0);
  const rest = n - floor * LAYERS.length;
  const raw = sizes.map((s) => (rest * s) / total);
  const cnt = raw.map((x) => Math.floor(x));
  const order = raw.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0]);
  const left = rest - cnt.reduce((s, x) => s + x, 0);
  for (let k = 0; k < left; k++) cnt[order[k][1]] += 1;
  return { counts: LAYERS.map((l, i) => ({ layer: l.key, n: floor + cnt[i], share: r2((sizes[i] / total) * 100) })), sizes };
}

// ---- 名前 ----
// 明治安田の表の字のよくある読み (表には読みが無い)。null は Minecraft の名前に使えない (英字 3 字未満) もの
const READING = {
  弘: 'Hiroshi', 清: 'Kiyoshi', 勇: 'Isamu', 実: 'Minoru', 博: 'Hiroshi', 進: 'Susumu', 正: 'Tadashi', 茂: 'Shigeru', 隆: 'Takashi', 稔: 'Minoru',
  勉: 'Tsutomu', 勝: 'Masaru', 武: 'Takeshi', 勲: 'Isao', 功: 'Isao', 昇: 'Noboru', 昭: 'Akira', 勝利: 'Katsutoshi', 修: 'Osamu', 和夫: 'Kazuo',
  豊: 'Yutaka', 明: 'Akira', 誠: 'Makoto', 浩: 'Hiroshi', 徹: 'Toru', 浩一: 'Koichi', 浩二: 'Koji', 浩之: 'Hiroyuki', 聡: 'Satoshi', 剛: 'Tsuyoshi',
  和彦: 'Kazuhiko', 秀樹: 'Hideki', 哲也: 'Tetsuya', 直樹: 'Naoki', 達也: 'Tatsuya', 学: 'Manabu', 健一: 'Kenichi', 淳: 'Jun', 健: 'Ken', 博之: 'Hiroyuki',
  英樹: 'Hideki', 崇: 'Takashi', 大輔: 'Daisuke', 大介: 'Daisuke', 亮: 'Ryo', 竜也: 'Tatsuya', 健太郎: 'Kentaro', 洋平: 'Yohei', 健太: 'Kenta', 和也: 'Kazuya',
  翔: 'Sho', 拓也: 'Takuya', 祐介: 'Yusuke', 雄太: 'Yuta', 優: null, 翔太: 'Shota', 大樹: 'Daiki', 翔平: 'Shohei', 駿: 'Shun', 大貴: 'Daiki',
  貴大: 'Takahiro', 大輝: 'Daiki', 翼: 'Tsubasa', 大地: 'Daichi', 亮太: 'Ryota', 拓哉: 'Takuya', 雄大: 'Yudai', 拓海: 'Takumi', 直人: 'Naoto', 康平: 'Kohei',
  陸: 'Riku', 海斗: 'Kaito', 一輝: 'Kazuki', 涼太: 'Ryota', 匠: 'Takumi', 智也: 'Tomoya', 蓮: 'Ren', 優斗: 'Yuto', 竜: 'Ryu', 優太: 'Yuta',
  颯太: 'Sota', 大翔: 'Hiroto', 太陽: 'Taiyo', 悠斗: 'Yuto', 颯: 'Hayate', 輝: 'Hikaru', 大和: 'Yamato', 空: 'Sora', 陽斗: 'Haruto', 悠希: 'Yuki',
  陽向: 'Hinata', 悠人: 'Yuto', 悠太: 'Yuta', 瑛太: 'Eita', 悠真: 'Yuma', 颯真: 'Soma', 歩夢: 'Ayumu', 蒼空: 'Sora', 大雅: 'Taiga', 樹: 'Itsuki',
  陽翔: 'Haruto', 陸斗: 'Rikuto', 太一: 'Taichi', 海翔: 'Kaito', 湊: 'Minato', 龍生: 'Ryusei', 陽太: 'Hinata', 朝陽: 'Asahi', 結翔: 'Yuito', 悠翔: 'Yuto',
  悠: null, 新: 'Arata', 蒼: null, 陽大: null,
  和子: 'Kazuko', 幸子: 'Sachiko', 節子: 'Setsuko', 弘子: 'Hiroko', 久子: 'Hisako', 洋子: 'Yoko', 美智子: 'Michiko', 栄子: 'Eiko', 良子: 'Yoshiko', 美代子: 'Miyoko',
  京子: 'Kyoko', 悦子: 'Etsuko', 文子: 'Fumiko', 孝子: 'Takako', 紀子: 'Noriko', 恵子: 'Keiko', 昭子: 'Akiko', 勝子: 'Katsuko', 光子: 'Mitsuko', 信子: 'Nobuko',
  恵美子: 'Emiko', 啓子: 'Keiko', 久美子: 'Kumiko', 順子: 'Junko', 由美子: 'Yumiko', 裕子: 'Yuko', 典子: 'Noriko', 明美: 'Akemi', 智子: 'Tomoko', 浩子: 'Hiroko',
  真由美: 'Mayumi', 由美: 'Yumi', ゆかり: 'Yukari', 直美: 'Naomi', 陽子: 'Yoko', 直子: 'Naoko', 純子: 'Junko', 恵美: 'Emi', 美香: 'Mika', 香織: 'Kaori',
  恵: 'Megumi', 美穂: 'Miho', 優子: 'Yuko', 美紀: 'Miki', 裕美: 'Hiromi', めぐみ: 'Megumi', 理恵: 'Rie', 愛: null, 絵美: 'Emi', 麻美: 'Asami',
  麻衣: 'Mai', 明日香: 'Asuka', 智美: 'Tomomi', 麻衣子: 'Maiko', 友美: 'Tomomi', 彩: 'Aya', あゆみ: 'Ayumi', 舞: 'Mai', 由佳: 'Yuka', 愛美: 'Manami',
  沙織: 'Saori', 成美: 'Narumi', 瞳: 'Hitomi', 彩香: 'Ayaka', 千尋: 'Chihiro', 美咲: 'Misaki', 早紀: 'Saki', 茜: 'Akane', 桃子: 'Momoko', 里奈: 'Rina',
  萌: 'Moe', 彩花: 'Ayaka', 遥: 'Haruka', 千夏: 'Chinatsu', 葵: 'Aoi', 佳奈: 'Kana', 菜摘: 'Natsumi', 真由: 'Mayu', 楓: 'Kaede', 奈々: 'Nana',
  優花: 'Yuka', 七海: 'Nanami', 未来: 'Miku', 彩乃: 'Ayano', 玲奈: 'Rena', 亜美: 'Ami', 菜々子: 'Nanako', さくら: 'Sakura', 菜月: 'Natsuki', 美月: 'Mizuki',
  詩織: 'Shiori', 彩夏: 'Ayaka', 結衣: 'Yui', 琴音: 'Kotone', 美羽: 'Miu', 莉子: 'Riko', 美優: 'Miyu', 凜: 'Rin', 陽菜: 'Hina', 真央: 'Mao',
  花音: 'Kanon', 百花: 'Momoka', ひなた: 'Hinata', 優衣: 'Yui', 杏: null, 結菜: 'Yuna', 優奈: 'Yuna', 心優: 'Miyu', 美桜: 'Mio', 結愛: 'Yua',
  愛莉: 'Airi', 杏奈: 'Anna', 心愛: 'Kokoa', 愛菜: 'Mana', 心春: 'Koharu', 芽依: 'Mei', 美結: 'Miyu', 心咲: 'Misaki', 凛: 'Rin', 陽葵: 'Himari',
  桜: 'Sakura', 愛梨: 'Airi', 花: 'Hana', 心結: 'Miyu', 咲良: 'Sakura',
};

// 名前の候補: 先頭3文字ごとの組 (組から1人だけ使える = 先頭3文字が重ならず、ほかの名前の先頭にも含まれない)
function nameGroups(names) {
  const groups = new Map();
  for (const [sexKey, sex] of [['boy', 'male'], ['girl', 'female']]) {
    for (const [y, row] of Object.entries(names[sexKey])) {
      if (!/^\d{4}$/.test(y)) continue;
      row.forEach((cell, rank) => {
        for (const k of String(cell).split(/\s+/)) {
          if (!k || k === '-' || !(k in READING)) continue;
          const r = READING[k]; if (!r || !/^[A-Za-z]{3,16}$/.test(r)) continue;
          const key = r.slice(0, 3);
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push({ kanji: k, name: r, year: Number(y), rank: rank + 1, sex });
        }
      });
    }
  }
  return [...groups.entries()].map(([key, list]) => ({ key, list }));
}

// 最小費用の割り当て (ハンガリー法。行 n ≤ 列 m)。返り値: 行 i の列
function hungarian(cost) {
  const n = cost.length; const m = cost[0].length; const INF = 1e18;
  const u = new Array(n + 1).fill(0); const v = new Array(m + 1).fill(0); const p = new Array(m + 1).fill(0); const way = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i; let j0 = 0; const minv = new Array(m + 1).fill(INF); const used = new Array(m + 1).fill(false);
    do {
      used[j0] = true; const i0 = p[j0]; let delta = INF; let j1 = 0;
      for (let j = 1; j <= m; j++) if (!used[j]) {
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const ans = new Array(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) ans[p[j] - 1] = j - 1;
  return ans;
}

// 全員の名前を一度に決める: 費用 = |その名前が上位だった年 − 生まれ年| + 順位 × 0.1 + 揺らぎ (0〜1、種で固定)。
//   その性別の名前が無い組・年の差が maxGap を超える組は使わない。先着順だと年配の女性 (「〜子」が多く先頭3文字が重なる) が足りなくなるので、全体で最小にする
function assignNames(people, names, rng, maxGap = 25) {
  const groups = nameGroups(names);
  const choice = people.map(() => []);
  const cost = people.map((p, i) => groups.map((g) => {
    const by = 2026 - p.age; let best = null;
    for (const e of g.list) {
      if (e.sex !== p.sex) continue;
      const gap = Math.abs(e.year - by); if (gap > maxGap) continue;
      const c = gap + e.rank * 0.1;
      if (!best || c < best.c) best = { c, e, gap };
    }
    choice[i].push(best);
    return best ? best.c + rng() : 1e9;
  }));
  const ans = hungarian(cost);
  return ans.map((j, i) => {
    const b = choice[i][j];
    if (!b || cost[i][j] >= 1e9) throw new Error(`名前が足りない: ${people[i].age} ${people[i].sex}`);
    return { ...b.e, gap: b.gap };
  });
}

// ---- 性格の文 ----
const ITEM_JA = {
  'E+': '活発で、外向的', 'E-': 'ひかえめで、おとなしい', 'A+': '人に気をつかう、やさしい性格', 'A-': '他人に不満をもち、もめごとを起こしやすい',
  'C+': 'しっかりしていて、自分に厳しい', 'C-': 'だらしなく、うっかりしている', 'N+': '心配性で、うろたえやすい', 'N-': '冷静で、気分が安定している',
  'O+': '新しいことが好きで、変わった考えをもつ', 'O-': '慣れたやり方を好み、新しい発想は少ない',
};
const ITEM_EN = {
  'E+': 'extraverted and enthusiastic', 'E-': 'reserved and quiet', 'A+': 'sympathetic and warm', 'A-': 'critical and quarrelsome',
  'C+': 'dependable and self-disciplined', 'C-': 'disorganized and careless', 'N+': 'anxious and easily upset', 'N-': 'calm and emotionally stable',
  'O+': 'open to new experiences, with unusual ideas', 'O-': 'conventional; prefers familiar ways',
};
function who(age, sex) {
  if (age <= 14) return sex === 'male' ? ['男の子', 'boy'] : ['女の子', 'girl'];
  if (age <= 19) return sex === 'male' ? ['少年', 'young man'] : ['少女', 'young woman'];
  return sex === 'male' ? ['男性', 'man'] : ['女性', 'woman'];
}
function personalityText(age, sex, z, maxTraits = 3) {
  const ranked = TRAITS.map((t) => [t, z[t]]).filter(([, v]) => Math.abs(v) >= 0.5).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, maxTraits);
  const [wj, we] = who(age, sex);
  const ja = [`${age}歳の${wj}。`]; const en = [`A ${age}-year-old ${we}.`];
  if (!ranked.length) { ja.push('どの面でも目立った偏りのない、ふつうの性格。'); en.push('Average on every side; no strong leanings.'); }
  for (const [t, v] of ranked) {
    const k = `${t}${v >= 0 ? '+' : '-'}`; const a = Math.abs(v);
    const [aj, ae] = a >= 1.5 ? ['とても', 'Very '] : a >= 1 ? ['', ''] : ['どちらかといえば', 'Somewhat '];
    ja.push(`${aj}${ITEM_JA[k]}。`);
    const e = ITEM_EN[k]; en.push(`${ae ? ae + e : e[0].toUpperCase() + e.slice(1)}.`);
  }
  return { ja: ja.join(''), en: en.join(' '), traits: ranked.map(([t, v]) => `${t}${v >= 0 ? '+' : '-'}`) };
}

// ---- 話し方 (年齢の層 + 性格で1〜2個) ----
function speechText(age, z) {
  const base = age <= 14 ? '子供らしいくだけた話し方。「〜だよ」「〜じゃん」など短い文'
    : age <= 19 ? '若者らしいくだけた話し方'
      : age <= 29 ? 'くだけた話し方で、知らない人には軽い丁寧語'
        : age <= 64 ? '大人の落ち着いた話し方。知らない人には丁寧語'
          : 'ゆっくりした落ち着いた話し方。少し古い言い回しが混じる';
  const mods = [];
  if (z.E >= 0.8) mods.push([z.E, 'よくしゃべり、思ったことをすぐ口に出す']);
  if (z.E <= -0.8) mods.push([-z.E, '口数が少なく、短く話す']);
  if (z.A <= -0.8) mods.push([-z.A, '言い方がぶっきらぼう']);
  if (z.A >= 0.8) mods.push([z.A, '相手を気づかう言い方']);
  if (z.N >= 0.8) mods.push([z.N, '不安になると念を押す']);
  if (z.O >= 0.8) mods.push([z.O, 'よく質問する']);
  mods.sort((a, b) => b[0] - a[0]);
  return [base, ...mods.slice(0, 2).map((m) => m[1])].join('。') + '。';
}

// ---- 欲求の人ごとの差 ----
function needsFor(age, z, curiosity) {
  const n = {}; const why = [];
  // 眠気 (推奨の睡眠時間 → 起きている時間)
  const sleepH = age <= 13 ? 10 : age <= 17 ? 9 : age <= 64 ? 8 : 7.5;
  const sleep = { fullAfter: Math.round(30000 * (24 - sleepH) / 16) };
  const thr = age >= 15 && age <= 25 ? 0.6 : age >= 65 ? 0.5 : 0.55;
  if (thr !== 0.55) sleep.threshold = thr;
  n.sleep = sleep;
  why.push(`眠気: 推奨の睡眠 ${sleepH}h${thr > 0.55 ? '・夜型' : thr < 0.55 ? '・早く眠い' : ''}`);
  // 空腹
  if (age >= 65) { n.hunger = { sensitivity: 0.8 }; why.push('空腹を感じにくい (高齢)'); } else if (age <= 17) { n.hunger = { sensitivity: 1.1 }; why.push('お腹が空きやすい (成長期)'); }
  // 不安・ストレス (神経症傾向)
  const safety = { threshold: r2(clamp(0.5 - 0.08 * z.N, 0.3, 0.7)) };
  if (age <= 14) { safety.dark = r2(0.25 * 1.4); safety.nightOutside = r2(0.2 * 1.4); why.push('夜・暗がりが怖い (子供)'); }
  n.safety = safety;
  n.stress = { k: Math.round(clamp(0.012 * (1 + 0.25 * z.N), 0.006, 0.02) * 10000) / 10000 };
  if (Math.abs(z.N) >= 0.8) why.push(z.N > 0 ? '不安・ストレスを感じやすい' : '不安・ストレスに強い');
  // つながり・認められたい
  if (age >= 65) { n.connection = { bond: 0.45, near: 0.008 }; why.push('親しい少数の人を求める (高齢)'); }
  if (age >= 15 && age <= 19) { n.recognition = { fullAfter: 12000 }; why.push('人からの評価が気になる (青年期)'); }
  n.drives = { curiosity: r2(curiosity) };
  if (curiosity >= 0.7) why.push('知らない所に行きたい'); else if (curiosity <= 0.3) why.push('知らない所への関心は薄い');
  n._comment = why.join('、');
  return n;
}

function generate({ n = 100, seed = 20261110, base } = {}) {
  const { pop, bf, names } = loadData();
  const rng = mulberry32(seed);
  const R = bf.adult.corr; const L = cholesky(R);
  const { counts } = layerCounts(pop, n);
  // 年齢と性別 (層の中で人口に比例)
  const cells = [];
  for (let a = 10; a <= 89; a++) for (const sex of ['male', 'female']) cells.push({ age: a, sex, w: pop.byAge[a][sex] });
  const people = [];
  for (const c of counts) {
    const l = LAYERS.find((x) => x.key === c.layer);
    // 男性を年齢順、続けて女性を年齢順に並べてから系統抽出する (男女が交互だと抽出の間隔と周期がそろって男女比がずれる)
    const inLayer = cells.filter((x) => x.age >= l.from && x.age <= l.to).sort((a, b) => a.sex.localeCompare(b.sex) || a.age - b.age);
    // 系統抽出: 累積人口の (k + u) / 人数 の位置の人 (u は種で決める0〜1)。年齢と男女の比が人口に近くなる (でたらめに引くより揺れが小さい)
    const total = inLayer.reduce((s, x) => s + x.w, 0); const u = rng();
    const list = [];
    for (let k = 0; k < c.n; k++) {
      let r = ((k + u) / c.n) * total; let pick = inLayer[inLayer.length - 1];
      for (const x of inLayer) { r -= x.w; if (r <= 0) { pick = x; break; } }
      list.push({ age: pick.age, sex: pick.sex, layer: l.key });
    }
    // 並びを混ぜる (--agents N で先頭から取っても、層の中の年齢が偏らない)
    for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
    people.push(list);
  }
  // 4層を交互に並べる
  const ordered = [];
  for (let i = 0; ordered.length < n; i++) for (const list of people) if (list[i]) ordered.push(list[i]);
  const usedText = new Set();
  const out = [];
  const picked = assignNames(ordered, names, rng);
  // 標準正規の乱数を層ごとに平均 0・SD 1 にそろえる (100人では層の平均がでたらめに揺れて、研究の年齢差より大きくなるため)
  const eAll = ordered.map(() => TRAITS.map(() => normal(rng)));
  for (const l of LAYERS) {
    const idxs = ordered.map((p, i) => (p.layer === l.key ? i : -1)).filter((i) => i >= 0);
    if (idxs.length < 2) continue;
    for (let t = 0; t < TRAITS.length; t++) {
      const v = idxs.map((i) => eAll[i][t]); const m = v.reduce((a, b) => a + b, 0) / v.length;
      const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1)) || 1;
      for (const i of idxs) eAll[i][t] = (eAll[i][t] - m) / sd;
    }
  }
  for (const [idx, p] of ordered.entries()) {
    const norm = traitNorm(bf, p.age, p.sex);
    const e = eAll[idx];
    const corr = L.map((row) => row.reduce((s, x, k) => s + x * e[k], 0));
    const z = {}; TRAITS.forEach((t, i) => { z[t] = norm[t].z + norm[t].sdr * corr[i]; });
    const tipi = {}; for (const t of TRAITS) tipi[t] = r1(clamp(bf.adult.overall[t][0] + z[t] * bf.adult.overall[t][1], 2, 14));
    const temperament = {};
    for (const [k, w] of Object.entries(TEMPERAMENT_MAP)) {
      const ws = TRAITS.map((t) => w[t] || 0);
      const v = ws.reduce((s, x, i) => s + x * z[TRAITS[i]], 0);
      const sd = Math.sqrt(ws.reduce((s, x, i) => s + ws.reduce((s2, y, j) => s2 + x * y * R[i][j], 0), 0));
      temperament[k] = r2(clamp(phi(v / sd), 0.02, 0.98));
    }
    const ordT = { bravery: temperament.bravery, empathy: temperament.empathy, obedience: temperament.obedience, greed: temperament.greed, sociability: temperament.sociability };
    const curiosity = 0.2 + 0.7 * phi(z.O);
    const pick = picked[idx];
    // 文 (重なれば特性を4つまで増やす)
    let txt = personalityText(p.age, p.sex, z);
    for (let k = 4; usedText.has(txt.ja) && k <= 5; k++) txt = personalityText(p.age, p.sex, z, k);
    usedText.add(txt.ja);
    out.push({
      name: pick.name,
      age: p.age,
      sex: p.sex,
      ageGroup: p.layer,
      personality: txt.ja,
      personality_en: txt.en,
      speech: speechText(p.age, z),
      temperament: ordT,
      bigFive: { _comment: 'TIPI-J の得点 (2〜14) と日本の成人を基準にした z', tipi, z: Object.fromEntries(TRAITS.map((t) => [t, r2(z[t])])) },
      needs: needsFor(p.age, z, curiosity),
      nameSource: `${pick.kanji} (${pick.year}年生まれの${pick.rank}位、生まれ年との差 ${pick.gap}年。明治安田生命)`,
    });
  }
  const cfg = JSON.parse(JSON.stringify(base));
  cfg._comment = `${n}人版 (tools/gen_personas.js で生成。種 ${seed})。personas 以外は survival_3days.json と同じ (作り直すときは base を変えてから gen_personas.js)。`
    + '年齢: 人口推計 2024 (総務省統計局) から、子供 10〜14・若者 15〜29・大人 30〜64・老人 65〜89 の各層に 20 人 + 残りを人口比で。'
    + '性格: Big Five (川本ら 2015 の TIPI-J の年代×性別、10〜24 歳は Soto ら 2011 の年齢差) → 気質・欲求。名前: 明治安田生命の生まれ年別ベスト10。'
    + ` 層の人数: ${counts.map((c) => `${LAYERS.find((l) => l.key === c.layer).ja} ${c.n}`).join('・')}。--agents N は先頭から N 人 (4層を交互に並べてある)。--- 元の説明: ${base._comment || ''}`;
  cfg.personas = out;
  return { cfg, counts };
}

function main() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) { const k = process.argv[i]; if (k.startsWith('--')) { const v = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : 'true'; args[k.slice(2)] = v; } }
  const basePath = path.resolve(ROOT, args.base || 'configs/survival_3days.json');
  const outPath = path.resolve(ROOT, args.out || 'configs/survival_100.json');
  const base = JSON.parse(fs.readFileSync(basePath, 'utf8'));
  const { cfg, counts } = generate({ n: Number(args.n || 100), seed: Number(args.seed || 20261110), base });
  const text = JSON.stringify(cfg, null, 2) + '\n';
  if (args.check) {
    const cur = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
    if (cur !== text) { console.error(`${outPath} は生成し直すと変わる (node tools/gen_personas.js で作り直す)`); process.exit(1); }
    console.log('同じ'); return;
  }
  fs.writeFileSync(outPath, text);
  console.log(`wrote ${outPath}: ${cfg.personas.length} 人 (${counts.map((c) => `${c.layer} ${c.n} (人口 ${c.share}%)`).join(', ')})`);
}

if (require.main === module) main();
module.exports = { generate, traitNorm, layerCounts, personalityText, speechText, needsFor, phi, mulberry32, TEMPERAMENT_MAP, LAYERS, layerOf, READING, loadData };
