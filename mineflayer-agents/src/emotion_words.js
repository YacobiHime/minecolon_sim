'use strict';
// 感情の値 (0〜10) を、LLM に渡す言葉にする (2026-11-17)。値の動き (social.js) は変えず、言葉の作り方だけを切り替える。
//   設定: social.emotions.wording = 'buckets3' | 'levels' | 'numeric' | 'cause' | 'blend'
//         または { mode, top (言葉に出す感情の数。既定 2), mood (blend で全体の気分を1行足す。既定 false) }
//   buckets3 (既定・今まで): 感情ごとに3段の決まった言い方 (social.js の EMO_WORD)。
//   levels  : 6段。段ごとに言い方を3つずつ持ち、人ごと (名前を種にした決まった選び方) に1つ選ぶ。同じ段でも人によって言い方が違う。
//   numeric : 値そのものと目盛りの説明「怒り 6.3/10 (0=平静, 5=はっきり不機嫌, 10=我を忘れる)」。
//   cause   : きっかけ (誰に何をされたか・いつ) が分かれば「5分前にBobに鉄を取られて、まだかなり腹が立っている」。分からなければ levels。
//   blend   : いちばん強い感情を levels の言い方で、2つ目を相対の強さで「とてもうれしいけれど、少し不安もある」。mood: true で全体の気分も。
// どの感情を言葉に出すか (しきい値・並べ方) はどの方式でも同じ (social.js の shownEmotions と同じ規則)。top で数だけ変えられる。
// 調べ方: tools/emotion_wording_eval.js (Minecraft を動かさずに、LLM の出力の段階のつき方・言い方のばらつき・行動への効き方を測る)。

const EMOTIONS = ['joy', 'sadness', 'anger', 'fear', 'disgust', 'surprise'];
const MODES = ['buckets3', 'levels', 'numeric', 'cause', 'blend'];
const NLEVELS = 6;

// levels: 6段 × 言い方3つ
const LEVEL_JA = {
  joy: [['少しうれしい', 'ちょっと気分がいい', 'わりと機嫌がいい'], ['うれしい', '気分がいい', '心が軽い'], ['けっこううれしい', 'かなり気分がいい', 'うきうきしている'],
    ['とてもうれしい', 'すごく楽しい', '心がはずんでいる'], ['うれしくてたまらない', '大喜びしている', '顔がほころんで止まらない'], ['飛び上がるほどうれしい', 'うれしくて胸がいっぱい', 'これ以上ないほど幸せ']],
  sadness: [['少しさみしい', 'ちょっと気分が沈んでいる', '少ししょんぼりしている'], ['落ち込んでいる', '気分が沈んでいる', 'しょんぼりしている'], ['けっこう落ち込んでいる', 'かなり気が重い', '元気が出ない'],
    ['とても悲しい', 'ひどく落ち込んでいる', '胸がふさがる思い'], ['悲しくてたまらない', '泣きたいほどつらい', '何もする気が起きない'], ['絶望している', '悲しみで押しつぶされそう', '涙が止まらないほど悲しい']],
  anger: [['ちょっとむっとしている', '少し引っかかる', '少しいらっとしている'], ['いらいらしている', 'むかむかしている', '機嫌が悪い'], ['はっきり腹が立っている', 'かなりいらだっている', '不機嫌さが顔に出ている'],
    ['ひどく腹が立っている', '怒っている', '頭にきている'], ['激しく怒っている', '怒りがおさまらない', 'はらわたが煮えくり返っている'], ['我を忘れるほど怒っている', '怒りで手が震えている', '怒りで頭がいっぱい']],
  fear: [['少し不安', 'ちょっと落ち着かない', '少し心配'], ['不安', 'そわそわしている', 'びくびくしている'], ['けっこう怖い', 'かなり不安', '落ち着かなくて仕方ない'],
    ['とても怖い', '怖くて体がこわばる', 'ひどく不安'], ['怖くてたまらない', '恐ろしくて震えている', '逃げ出したいほど怖い'], ['恐怖で動けない', '怖くて頭が真っ白', '生きた心地がしない']],
  disgust: [['少しうんざりしている', 'ちょっと嫌な気分', '少し気に入らない'], ['うんざりしている', '嫌な気分', 'げんなりしている'], ['かなりうんざりしている', 'すっかり嫌気がさしている', 'げんなりしきっている'],
    ['ひどくうんざりしている', 'もう嫌でしかたない', '虫唾が走る'], ['嫌で嫌でたまらない', '吐き気がするほど嫌', '見るのも嫌'], ['耐えられないほど嫌', '嫌悪でいっぱい', '我慢の限界をこえている']],
  surprise: [['少し驚いている', 'ちょっと意外に思っている', '少しびっくりしている'], ['驚いている', 'びっくりしている', '目を丸くしている'], ['かなり驚いている', 'すっかりびっくりしている', '思わず声が出そう'],
    ['とても驚いている', 'ひどくびっくりしている', '息をのんでいる'], ['驚いて言葉が出ない', 'あっけにとられている', '腰が抜けそうなほど驚いている'], ['仰天している', '頭が真っ白になるほど驚いている', '信じられない思い']],
};
const LEVEL_EN = {
  joy: [['a little glad', 'in a slightly good mood', 'mildly pleased'], ['glad', 'in a good mood', 'light-hearted'], ['quite glad', 'cheerful', 'pretty happy'],
    ['very happy', 'really enjoying this', 'delighted'], ['overjoyed', 'thrilled', 'happy beyond words'], ['ecstatic', 'bursting with joy', 'as happy as can be']],
  sadness: [['a little lonely', 'slightly down', 'a bit glum'], ['down', 'sad', 'dispirited'], ['quite down', 'heavy-hearted', 'low on energy'],
    ['very sad', 'deeply down', 'heartsick'], ['unbearably sad', 'close to tears', 'unable to do anything'], ['in despair', 'crushed by sadness', 'grief-stricken']],
  anger: [['slightly annoyed', 'a little bothered', 'a bit irritated'], ['irritated', 'cross', 'in a bad mood'], ['clearly angry', 'quite irritated', 'visibly annoyed'],
    ['very angry', 'mad', 'fuming'], ['furious', 'unable to calm down', 'seething'], ['beside yourself with rage', 'shaking with anger', 'blind with rage']],
  fear: [['a little anxious', 'slightly uneasy', 'a bit worried'], ['anxious', 'jittery', 'nervous'], ['quite scared', 'very anxious', 'unable to settle'],
    ['very scared', 'stiff with fear', 'badly frightened'], ['terrified', 'trembling with fear', 'scared enough to run'], ['frozen with terror', 'blank with fear', 'scared out of your wits']],
  disgust: [['a little fed up', 'slightly put off', 'mildly displeased'], ['fed up', 'put off', 'disgusted'], ['quite fed up', 'thoroughly sick of it', 'repulsed'],
    ['very fed up', 'sick of everything', 'revolted'], ['unbearably disgusted', 'nauseated', 'unable to stand the sight of it'], ['at the end of your tether', 'full of loathing', 'past all tolerance']],
  surprise: [['a little surprised', 'slightly puzzled', 'mildly startled'], ['surprised', 'startled', 'wide-eyed'], ['quite surprised', 'really startled', 'taken aback'],
    ['very surprised', 'astonished', 'stunned'], ['speechless with surprise', 'dumbfounded', 'flabbergasted'], ['completely astounded', 'shocked to the core', 'unable to believe it']],
};
// numeric: 名前と目盛り (0・5・10 の意味)
const SCALE_JA = {
  joy: ['喜び', '何も感じない', 'はっきりうれしい', '最高にうれしい'], sadness: ['悲しみ', '平気', 'はっきり落ち込んでいる', '深い絶望'],
  anger: ['怒り', '平静', 'はっきり不機嫌', '我を忘れる'], fear: ['恐れ', '安心', 'はっきり怖い', '恐怖で動けない'],
  disgust: ['嫌悪', '気にならない', 'はっきり嫌', '耐えられない'], surprise: ['驚き', 'いつも通り', 'はっきり驚いた', '仰天'],
};
const SCALE_EN = {
  joy: ['joy', 'nothing', 'clearly glad', 'happiest ever'], sadness: ['sadness', 'fine', 'clearly down', 'deep despair'],
  anger: ['anger', 'calm', 'clearly annoyed', 'beside yourself'], fear: ['fear', 'safe', 'clearly scared', 'frozen with terror'],
  disgust: ['disgust', 'unbothered', 'clearly repulsed', 'unbearable'], surprise: ['surprise', 'as usual', 'clearly surprised', 'astounded'],
};
// cause・blend: 強さの副詞 (6段 × 2) と、きっかけのあとに続く「今の気持ち」
const ADV_JA = [['少し', 'ちょっと'], ['いくらか', 'やや'], ['けっこう', 'それなりに'], ['かなり', 'だいぶ'], ['ひどく', 'とても'], ['どうしようもなく', 'たまらなく']];
const ADV_EN = [['a little', 'slightly'], ['somewhat', 'rather'], ['quite', 'fairly'], ['very', 'really'], ['extremely', 'terribly'], ['overwhelmingly', 'unbearably']];
const FEEL_JA = { joy: 'うれしい', sadness: '落ち込んでいる', anger: '腹が立っている', fear: '怖い', disgust: 'うんざりしている', surprise: '驚いている' };
const FEEL_STATE_JA = { joy: '機嫌がいい', sadness: '気分が沈んでいる', anger: 'いらいらしている', fear: '不安', disgust: 'うんざりしている', surprise: '驚いている' };
const FEEL_EN = { joy: 'glad', sadness: 'down', anger: 'angry', fear: 'scared', disgust: 'fed up', surprise: 'surprised' };
// blend: 2つ目の感情の名詞
const NOUN_JA = { joy: 'うれしさ', sadness: '悲しさ', anger: 'いらだち', fear: '不安', disgust: '嫌な気分', surprise: '驚き' };
const NOUN_EN = { joy: 'gladness', sadness: 'sadness', anger: 'irritation', fear: 'worry', disgust: 'disgust', surprise: 'surprise' };

// きっかけの言い方 (cause)。c = { kind, who, item, what }。て形 (「…て、まだ…」に続く)
const CAUSE_JA = {
  took_witnessed: (c) => `${c.who}に${c.item || '物'}を取られて`, took_told: (c) => `${c.who}に${c.item || '物'}を取られて`, took_heard: (c) => `${c.who}に${c.item || '物'}を取られたと聞いて`,
  ignored: (c) => `${c.who}に聞いたのに返事がなくて`, denied: (c) => `${c.who}に${c.item || '物'}を使わせてと頼んで断られて`, hit: (c) => `${c.who}に殴られて`, killed: (c) => `${c.who}に殺されて`,
  bed_taken: (c) => `寝ようとしたベッドを${c.who}に先に使われて`, snatched: (c) => `自分が掘った${c.item || '物'}を${c.who}に先に拾われて`, call_ignored: (c) => `${c.who}を呼んだのに来てくれなくて`,
  breach: (c) => `${c.who}に取り決めを破られて`, complained: (c) => `${c.who}に文句を言われて`,
  received: (c) => `${c.who}に${c.item || '物'}をもらって`, answered: (c) => `${c.who}にやり方を教えてもらって`, met: (c) => `${c.who}に初めて会って`, talked: (c) => `${c.who}と話せて`,
  returned: (c) => `${c.who}に取られた物を返してもらって`, repaired: (c) => `${c.who}に壊された所を直してもらって`, apology: (c) => `${c.who}に謝ってもらって`,
  rumor: (c) => `${c.who}が人の物を取ったと聞いて`, third: (c) => `${c.who}が人の物を取るのを見て`,
  fail: (c) => `${actJa(c.what)}がうまくいかなくて`, fail_repeat: (c) => `${actJa(c.what)}が何度もうまくいかなくて`, success: (c) => `${actJa(c.what)}がうまくいって`,
  death: () => '死んでしまって', slept: () => 'ぐっすり眠れて',
  // 今続いている状態 (時間は言わない)
  hunger: () => 'お腹が空いていて', sleep: () => '眠くて', greed: () => '物が足りなくて', recognition: () => '誰にも認められなくて', connection: () => 'ひとりぼっちで', care: () => '人の役に立てなくて', safety: () => '周りが危なくて',
};
const CAUSE_EN = {
  took_witnessed: (c) => `${c.who} took my ${c.item || 'thing'}`, took_told: (c) => `${c.who} took my ${c.item || 'thing'}`, took_heard: (c) => `I heard ${c.who} took my ${c.item || 'thing'}`,
  ignored: (c) => `${c.who} did not answer when I asked`, denied: (c) => `${c.who} refused to let me use their ${c.item || 'thing'}`, hit: (c) => `${c.who} hit me`, killed: (c) => `${c.who} killed me`,
  bed_taken: (c) => `${c.who} took the bed I was going to sleep in`, snatched: (c) => `${c.who} picked up the ${c.item || 'thing'} I dug`, call_ignored: (c) => `${c.who} did not come when I called`,
  breach: (c) => `${c.who} broke an agreement`, complained: (c) => `${c.who} complained at me`,
  received: (c) => `${c.who} gave me ${c.item || 'something'}`, answered: (c) => `${c.who} taught me how to do something`, met: (c) => `I met ${c.who} for the first time`, talked: (c) => `I got to talk with ${c.who}`,
  returned: (c) => `${c.who} gave back what they took`, repaired: (c) => `${c.who} repaired what they broke`, apology: (c) => `${c.who} apologised to me`,
  rumor: (c) => `I heard ${c.who} took other people's things`, third: (c) => `I saw ${c.who} take someone's things`,
  fail: (c) => `${c.what || 'what I tried'} did not work`, fail_repeat: (c) => `${c.what || 'what I tried'} kept failing`, success: (c) => `${c.what || 'what I tried'} worked`,
  death: () => 'I died', slept: () => 'I slept well',
  hunger: () => 'I am hungry', sleep: () => 'I am sleepy', greed: () => 'I do not have enough things', recognition: () => 'nobody appreciates me', connection: () => 'I am all alone', care: () => 'I cannot help anyone', safety: () => 'it is dangerous around here',
};
// 行動の名前 → 「…がうまくいかなくて」の主語
const ACTION_JA = { collect: '掘って拾うの', craft: '物を作るの', go_to: '目当ての所へ行くの', explore: '見て回るの', use_on: '道具を使うの', place: '置くの', eat: '食べるの', sleep: '寝るの',
  attack: '戦うの', give: '物を渡すの', search: '探すの', follow: 'ついて行くの', pick_up: '拾うの', smelt: '焼くの', enclose: '囲うの', pillar: '足場を積むの', hunt: '狩りをするの', build: '建てるの' };
const actJa = (w) => (w ? ACTION_JA[w] || w : 'やろうとしたこと');
const STATE_CAUSES = new Set(['hunger', 'sleep', 'greed', 'recognition', 'connection', 'care', 'safety']);
const TICKS_PER_MIN = 1200; // Minecraft: 20 tick/秒

// 文字列から決まった数 (FNV-1a 32bit)
function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
// 人ごとに決まった選び方 (seed が同じなら同じ物)
function pick(list, seed, key) { return list[hash32(`${seed}|${key}`) % list.length]; }

// 設定を { mode, top, mood } に
function wordingConfig(w) {
  const o = typeof w === 'string' ? { mode: w } : { ...(w || {}) };
  const mode = MODES.includes(o.mode) ? o.mode : 'buckets3';
  return { mode, top: Number.isFinite(o.top) && o.top >= 1 ? Math.floor(o.top) : 2, mood: !!o.mood };
}

// 値 v を、言葉に出すしきい値 L (= [感じている, 中, 強い]) から 10 までの 6 段に
function level6(v, L) {
  const lo = L[0];
  const f = (v - lo) / Math.max(1e-9, 10 - lo);
  return Math.max(0, Math.min(NLEVELS - 1, Math.floor(f * NLEVELS)));
}
function level3(v, L) { return v >= L[2] ? 2 : v >= L[1] ? 1 : 0; }

// 言葉に出す感情 [{ e, v, L, excess }] (shownEmotions と同じ規則。数だけ top)
function shownList(emotions, levels, { byExcess = false, top = 2 } = {}) {
  return EMOTIONS.map((e) => { const L = levels(e); const v = emotions[e]; return { e, v, L, excess: v - L[0] }; })
    .filter((x) => x.v >= x.L[0])
    .sort((a, b) => (byExcess ? b.excess - a.excess : b.v - a.v)).slice(0, top);
}

function levelPhrase(x, { lang, seed }) {
  const lv = level6(x.v, x.L);
  return pick((lang === 'en' ? LEVEL_EN : LEVEL_JA)[x.e][lv], seed, `${x.e}:${lv}`);
}
function numericPhrase(x, { lang }) {
  const s = (lang === 'en' ? SCALE_EN : SCALE_JA)[x.e];
  const v = (Math.round(x.v * 10) / 10).toFixed(1);
  return lang === 'en' ? `${s[0]} ${v}/10 (0=${s[1]}, 5=${s[2]}, 10=${s[3]})` : `${s[0]} ${v}/10 (0=${s[1]}, 5=${s[2]}, 10=${s[3]})`;
}
function elapsedText(dt, lang) {
  const m = dt / TICKS_PER_MIN;
  if (lang === 'en') return m < 0.75 ? 'just now' : m < 1.5 ? 'a minute ago' : m < 60 ? `${Math.round(m)} minutes ago` : `about ${Math.round(m / 60)} hours ago`;
  return m < 0.75 ? 'さっき' : m < 1.5 ? '1分ほど前に' : m < 60 ? `${Math.round(m)}分前に` : `${Math.round(m / 60)}時間ほど前に`;
}
function causePhrase(x, cause, { lang, seed, now }) {
  const lv = level6(x.v, x.L);
  const f = (lang === 'en' ? CAUSE_EN : CAUSE_JA)[cause.kind];
  if (!f) return null;
  const adv = pick((lang === 'en' ? ADV_EN : ADV_JA)[lv], seed, `adv:${x.e}:${lv}`);
  const state = STATE_CAUSES.has(cause.kind);
  const dt = Number.isFinite(now) && Number.isFinite(cause.t) ? Math.max(0, now - cause.t) : null;
  if (lang === 'en') {
    const when = state || dt == null ? '' : ` ${elapsedText(dt, 'en')}`;
    const still = !state && dt != null && dt >= TICKS_PER_MIN ? 'still ' : '';
    return `${f(cause)}${when}, and I am ${still}${adv} ${FEEL_EN[x.e]}`;
  }
  const when = state || dt == null ? '' : elapsedText(dt, 'ja');
  const still = !state && dt != null && dt >= TICKS_PER_MIN ? 'まだ' : '';
  return `${when}${f(cause)}、${still}${adv}${(state ? FEEL_STATE_JA : FEEL_JA)[x.e]}`;
}
function blendPhrase(list, { lang, seed }) {
  const [a, b] = list;
  const first = levelPhrase(a, { lang, seed });
  if (!b) return first;
  const r = b.excess / Math.max(1e-9, a.excess);
  if (lang === 'en') {
    const rel = r >= 0.8 ? 'almost as much' : r >= 0.45 ? 'some' : 'a little';
    return `${first}, but with ${rel} ${NOUN_EN[b.e]} too`;
  }
  const rel = r >= 0.8 ? '同じくらい' : r >= 0.45 ? 'いくらか' : '少し';
  return `${first}けれど、${rel}${NOUN_JA[b.e]}もある`;
}
// 全体の気分 (快・不快 × 高ぶり)。base: 基準値
function moodPhrase(emotions, base, lang) {
  const d = (e) => (emotions[e] || 0) - (base[e] || 0);
  const val = d('joy') - (d('sadness') + d('anger') + d('fear') + d('disgust')) * 0.6;
  const aro = d('anger') + d('fear') + d('surprise') + d('joy') * 0.4 - d('sadness') * 0.4;
  const vi = val >= 1.5 ? 2 : val <= -1.5 ? 0 : 1;
  const ai = aro >= 3 ? 1 : 0;
  if (lang === 'en') return `overall mood: ${['dark', 'neutral', 'bright'][vi]} and ${['calm', 'agitated'][ai]}`;
  return `全体の気分: ${['暗く', 'ふつうで', '明るく'][vi]}、${['落ち着いている', '気が高ぶっている'][ai]}`;
}

// 感情の言葉の列。s = { emotions, levels(e), byExcess, wording, seed, causes (cause のときだけ), now, base, buckets (buckets3 の表) }
function emotionPhrases(s, { lang = 'ja' } = {}) {
  const w = wordingConfig(s.wording);
  const list = shownList(s.emotions, s.levels, { byExcess: s.byExcess, top: w.top });
  const seed = s.seed || '';
  if (w.mode === 'buckets3') return list.map((x) => s.buckets[x.e][level3(x.v, x.L)]);
  if (w.mode === 'levels') return list.map((x) => levelPhrase(x, { lang, seed }));
  if (w.mode === 'numeric') {
    if (!list.length) return [];
    return [lang === 'en' ? `feelings (0-10): ${list.map((x) => numericPhrase(x, { lang })).join(', ')}` : `気持ち (0〜10): ${list.map((x) => numericPhrase(x, { lang })).join('、')}`];
  }
  if (w.mode === 'cause') {
    return list.map((x) => {
      const c = s.causeOf ? s.causeOf(x.e) : null;
      return (c && causePhrase(x, c, { lang, seed, now: s.now })) || levelPhrase(x, { lang, seed });
    });
  }
  // blend: 2つずつ組にする (top が 3 以上なら 3つ目からは levels の言い方で並べる)
  const out = [];
  if (list.length) out.push(blendPhrase(list.slice(0, 2), { lang, seed }));
  for (const x of list.slice(2)) out.push(levelPhrase(x, { lang, seed }));
  if (w.mood) out.push(moodPhrase(s.emotions, s.base || {}, lang));
  return out;
}

module.exports = { emotionPhrases, wordingConfig, shownList, level6, level3, hash32, pick, causePhrase, elapsedText, moodPhrase,
  MODES, NLEVELS, LEVEL_JA, LEVEL_EN, SCALE_JA, SCALE_EN, CAUSE_JA, CAUSE_EN, STATE_CAUSES, TICKS_PER_MIN };
