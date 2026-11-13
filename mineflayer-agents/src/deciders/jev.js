'use strict';
// Jev (TypeSafe System One) の decider。1回目の呼び出しに質問をまとめる:
//   next_action (Choice)  その瞬間にできる行動の一覧 ("行動:引数" を選択肢にする) から1つ
//   talk        (Noul)    今、近くの人に話しかけるべきか (高ければ 2B が発言を作る)。近くに人がいないときは聞かない
//   remember    (Score)   直前の出来事 (last_result と heard_now) を覚えておく価値 0〜4 → 記憶の大事さ
//   rel_<n>     (Score)   今聞こえた相手ごとに、その人への気持ちがどう変わったか 0〜4 → 好感
// 対象の多い行動 (collect・go_to・explore・craft など) は1回目では分類1つ ("行動:*") にまとめ、選ばれたら
// 2回目の呼び出し (target、最小限の state) で対象を選ぶ (decider.jev.twoStage。enabled: false で1段)。
// 行動の説明は state.actions に行動の種類ごとに1回だけ書き、選択肢の文は「行動の名前: label」だけにする。
// 公式の資料 (docs.typesafe.ai) の勧め: 質問は小さく分けてまとめて聞く、数の計算はさせない、英語が一番正確。
// 質問の文 (instructions) は英語。state も英語 (stateLang: 'en'、既定。'ja' で前の日本語の state)。
//   英語の state は、観察・記憶・気持ち・道筋・知識・拠点・last_result を同じ情報源から英語で作り (en.js ほか)、
//   判断に関係の薄いもの (座標・地面の草など) を削り、数は名前の付いた段階にする。人の名前・発言は原文のまま。
// 選択肢の並べ方は毎回変える (ctx.order。order.js)。記録に { seed, stream, n } と選んだ選択肢の位置を残す。
// 記録 (jev.choice): 選んだ選択肢の確率 p・1位÷2位の比 ratio・上位3つ (confidence は選択肢の数で意味が変わるので)。
// next_now (Noul): 道筋の「次」が、持ち物・見えている物で今すぐできるか。行動の選び方には使わず、記録するだけ (分析用)。
const { JevClient } = require('../jev_client');
const { estimateTokens } = require('../usage');
const { reweight } = require('../nochange');
const { reweightMult } = require('../choice_weight');
const { selectFacts, namesInView, factText } = require('../knowledge');
const { countWord } = require('../en');
const { familyKey } = require('../vocab');

const MAX_OPTIONS = 255; // Choice の選択肢の上限 (API の制約)

const REMEMBER_LEVELS = [
  'Trivial routine; not worth remembering',
  'Minor detail',
  'Somewhat useful later',
  'Important: a new place, a new way to do something, a failure to avoid, or something a person said',
  'Very important: about the goal, the base, or a person helping or harming `you`',
];
const REL_LEVELS = [
  'Much worse: hostile, insulting, or refused to help',
  'Somewhat worse',
  'No change',
  'Somewhat better: friendly or cooperative',
  'Much better: helped `you` or taught `you` something',
];

// 2段にする設定 (decider.jev.twoStage)。enabled: false で1段 (全部の選択肢を1回に並べる)
//   maxDirect: 対象がこの数以下の行動は1段目にそのまま並べる。direct の行動は数に関係なくそのまま並べる
//   summaryMax: 分類の選択肢の文に書く対象の名前の数
const TWO_STAGE_DEFAULTS = { enabled: true, maxDirect: 3, direct: ['eat', 'sleep', 'flee', 'set_base', 'ask'], summaryMax: 8 };

function twoStageCfg(opt) {
  if (opt === false) return { ...TWO_STAGE_DEFAULTS, enabled: false };
  if (opt === true || opt == null) return { ...TWO_STAGE_DEFAULTS };
  return { ...TWO_STAGE_DEFAULTS, ...opt };
}

// 分類の要約に書く対象の名前 (go_to の M番号は、何の場所かの名前にする)
function targetName(a, c) { return c.player || (a.name === 'go_to' && c.kind) || c.item || c.block || c.mob || c.id; }

// 行動の一覧 → Choice の選択肢 { key: 文 }、key → {action, arg} か {group}、行動の説明表 { 行動: 説明 }
//   選択肢の文は「行動の名前 + 対象の label」だけ。行動の説明は表 (state.actions) に1回だけ書く
//   twoStage が有効なら、対象の多い行動は分類1つ (key "行動:*") にまとめ、対象の名前の要約を付ける
// keys ("行動:引数") を行動ごとに分け、各行動から順番に1つずつ max 個まで取る (元の順に並べ直して返す)
function fairCut(keys, max) {
  const by = new Map();
  for (const k of keys) { const a = k.split(':')[0]; if (!by.has(a)) by.set(a, []); by.get(a).push(k); }
  const picked = new Set();
  for (let i = 0; picked.size < max; i++) {
    let any = false;
    for (const list of by.values()) { if (i < list.length && picked.size < max) { picked.add(list[i]); any = true; } }
    if (!any) break;
  }
  return keys.filter((k) => picked.has(k));
}

function actionOptions(actions, opts = {}) {
  const ts = opts.twoStage ? twoStageCfg(opts.twoStage) : { enabled: false };
  const en = opts.lang === 'en';
  const lab = (c) => (en && c.labelEn ? c.labelEn : c.label);
  const criteria = {};
  const map = {};
  const table = {};
  const groups = {};
  for (const a of actions) {
    if (a.argType === 'text') continue; // 発言は 2B
    table[a.name] = en && a.descEn ? a.descEn : a.desc;
    if (a.argType === 'choice') {
      const direct = !ts.enabled || a.choices.length <= ts.maxDirect || (ts.direct || []).includes(a.name);
      if (direct) {
        for (const c of a.choices) {
          const k = `${a.name}:${c.id}`;
          criteria[k] = `${a.name}: ${lab(c)}`;
          map[k] = { action: a.name, arg: c.id };
        }
      } else {
        const k = `${a.name}:*`;
        const names = [...new Set(a.choices.map((c) => targetName(a, c)))];
        const shown = names.slice(0, ts.summaryMax);
        criteria[k] = en ? `${a.name}: choose among ${countWord(a.choices.length)} targets (${shown.join(', ')}${names.length > shown.length ? ', and more' : ''})`
          : `${a.name}: ${a.choices.length}個から選ぶ (${shown.join(', ')}${names.length > shown.length ? ' ほか' : ''})`;
        map[k] = { group: a.name };
        groups[a.name] = a;
      }
    } else if (a.argType === 'number') {
      criteria[`${a.name}:3`] = en ? `${a.name}: a moment` : `${a.name}: 3秒`;
      map[`${a.name}:3`] = { action: a.name, arg: '3' };
    } else {
      criteria[a.name] = a.name;
      map[a.name] = { action: a.name, arg: '' };
    }
  }
  const all = Object.keys(criteria);
  // 上限 (MAX_OPTIONS) を超えるときは、行動の種類ごとに順番に1つずつ取る (各行動の中の並び = 近さなどの順は保つ)。
  //   前は行動の一覧の順のまま先頭から切っていたので、一覧の後ろの行動 (use_on・give など) の選択肢がまとめて落ちていた
  let keys = all.length > MAX_OPTIONS ? fairCut(all, MAX_OPTIONS) : all;
  const cut = all.length > MAX_OPTIONS ? { total: all.length, kept: keys.length } : null;
  // 並べ方を変える (opts.order = Order。記録は order)
  let order = null;
  if (opts.order) { const r = opts.order.shuffle(keys, opts.stream || 'act'); keys = r.arr; order = r.rec; }
  return { criteria: Object.fromEntries(keys.map((k) => [k, criteria[k]])), map, table, groups, order, cut };
}

const hasGoal = (ctx) => !!(ctx && ctx.goal && ctx.goal.text);

function troubledText(troubles) {
  return troubles.map((t) => (t.kind === 'stuck' ? `${t.about} (${t.lastMsg || '移動が続けて1m未満だった'})`
    : `${t.about}が分からない (${t.kind === 'noChange' ? '何度やっても何も変わらなかった' : '同じ失敗が続いた'})`)).join(' / ');
}

function troubledTextEn(troubles) {
  return troubles.map((t) => (t.kind === 'stuck' ? 'stuck: could not move from this spot (moves went under 1 m several times in a row)'
    : `${t.key}: ${t.kind === 'noChange' ? 'nothing changed however many times it was done' : 'failed again and again'}`)).join('; ');
}

// 英語の state (Jev 用)。ctx.en = { obs, mem, social, lastResult, base, hints, plan } (agent の buildContext と goalPath が作る)
//   欲求・気持ち (feelings) → 道筋 (plan) → 方針 → 自分 → 持ち物 → 見えている物 → 近くの物 → 拠点 → 行動の説明 → 知識 → 記憶 → last_result → heard_now
function buildStateEn(ctx, opts = {}) {
  const e = ctx.en || {};
  const p = ctx.persona || {};
  const st = { you: p.name };
  const pers = p.personality_en || p.personality;
  if (pers) st.personality = pers;
  if (hasGoal(ctx)) st.goal = ctx.goal.text_en || ctx.goal.text;
  if (e.social) st.feelings = e.social;
  if (e.plan) st.plan = e.plan;
  else if (ctx.progress) st.plan = ctx.progress; // goalPath 以外 (first_setting など) は日本語の文のまま
  if (ctx.policy) st.policy = ctx.policy; // 2B が書いた文 (原文のまま)
  if (ctx.role) st.role = ctx.role; // 振り返りで自分が書いた、最近よくしていること (原文のまま。division.js)
  const o = e.obs || {};
  if (o.self) st.self = o.self;
  st.inventory = o.inventory || 'nothing';
  if (o.not_placed) st.not_placed = o.not_placed; // 持っているのにまだ置いていないベッド (observe.observationEn)
  st.visible = o.visible || 'nothing notable';
  st.nearby = o.nearby || 'nobody';
  if (o.farmland) st.farmland = o.farmland; // 近くの耕地 (湿っている/乾いている・植わっている。observe.observationEn)
  if (e.base) st.base = e.base;
  if (opts.table && Object.keys(opts.table).length) st.actions = opts.table;
  if (ctx.showHints && e.hints && e.hints.length) st.knowledge = e.hints;
  st.memory = e.mem || {};
  st.last_result = e.lastResult || 'none';
  st.heard_now = ctx.raw && ctx.raw.heard && ctx.raw.heard.length ? ctx.raw.heard.map((h) => `${h.from}「${h.text}」`).join(' ') : 'none';
  if (ctx.troubles && ctx.troubles.length) st.troubled = troubledTextEn(ctx.troubles);
  // 全体チャット・取り決め・共同の目標・共有のチェスト・賛成するかを聞く提案 (board.js。agent が ctx.en.board に入れる)
  const b = e.board;
  if (b && b.state) for (const k of ['board', 'agreements', 'projects', 'shared_chests', 'broken_agreements']) if (b.state[k] && b.state[k].length) st[k] = b.state[k];
  if (b && b.open && Object.keys(b.open).length) st.open_proposals = b.open;
  // 見聞きした、ほかの人が最近よくしていること (division.js。人の名前 → 英語の言葉)
  if (e.othersDoing && Object.keys(e.othersDoing).length) st.others_doing = e.othersDoing;
  // 自分の経験 (experience.js。対象ごとに試した回数・手に入ったか・かかった時間)
  if (Array.isArray(e.experience) && e.experience.length) st.experience = e.experience;
  return st;
}

function buildState(ctx, opts = {}) {
  if ((opts.lang || ctx.lang) === 'en') return buildStateEn(ctx, opts);
  const st = {
    you: ctx.persona.name,
    personality: ctx.persona.personality || '',
  };
  if (hasGoal(ctx)) st.goal = ctx.goal.text; // 全体の目標が無い設定 (survival_3days) では渡さない
  if (ctx.showHints && ctx.goal.hints && ctx.goal.hints.length) st.knowledge = ctx.goal.hints.join(' ');
  if (ctx.progress) st.plan = ctx.progress;
  if (ctx.policy) st.policy = ctx.policy; // 振り返りで自分が書いた方針 (reflect.js)
  st.now = ctx.obsText;
  if (opts.table && Object.keys(opts.table).length) st.actions = opts.table;
  if (ctx.socialText) st.feelings = ctx.socialText;
  st.memory = ctx.memText;
  st.last_result = ctx.lastResult || 'なし';
  st.heard_now = ctx.raw && ctx.raw.heard && ctx.raw.heard.length ? ctx.raw.heard.map((h) => `${h.from}「${h.text}」`).join(' ') : 'なし';
  if (ctx.troubles && ctx.troubles.length) st.troubled = troubledText(ctx.troubles);
  return st;
}

// 2段目の state: 目標・plan・持ち物・その行動に関係する知識・last_result だけ (memory 全文や feelings は送らない)
function buildStage2State(ctx, action, lang = 'ja') {
  if (lang === 'en') {
    const e = ctx.en || {};
    const st = { you: ctx.persona.name };
    if (hasGoal(ctx)) st.goal = ctx.goal.text_en || ctx.goal.text;
    if (e.plan) st.plan = e.plan; else if (ctx.progress) st.plan = ctx.progress;
    st.action = `${action.name}: ${action.descEn || action.desc}`;
    st.inventory = (e.obs && e.obs.inventory) || 'nothing';
    if (ctx.showHints && ctx.knowledge && ctx.knowledge.facts && ctx.knowledge.facts.length) {
      const names = namesInView({ actions: [action] });
      const fs = selectFacts(ctx.knowledge.facts, { names, actions: new Set([action.name]), max: ctx.knowledge.stage2Max ?? 4, always: false });
      if (fs.length) st.knowledge = fs.map((f) => factText(f, 'en'));
    }
    st.last_result = e.lastResult || 'none';
    const tr = (ctx.troubles || []).filter((t) => t.key.startsWith(`${action.name}:`));
    if (tr.length) st.troubled = troubledTextEn(tr);
    return st;
  }
  const inv = (ctx.raw && ctx.raw.inventory) || [];
  const counts = new Map();
  for (const i of inv) counts.set(i.name, (counts.get(i.name) || 0) + i.count);
  const st = { you: ctx.persona.name };
  if (hasGoal(ctx)) st.goal = ctx.goal.text;
  if (ctx.progress) st.plan = ctx.progress;
  st.action = `${action.name}: ${action.desc}`;
  st.inventory = counts.size ? [...counts].map(([n, c]) => `${n}x${c}`).join(', ') : 'なし';
  if (ctx.showHints && ctx.knowledge && ctx.knowledge.facts && ctx.knowledge.facts.length) {
    // その行動の名前か、その行動の対象の名前に当たる事実だけ (持ち物・always では選ばない)
    const names = namesInView({ actions: [action] });
    const fs = selectFacts(ctx.knowledge.facts, { names, actions: new Set([action.name]), max: ctx.knowledge.stage2Max ?? 4, always: false });
    if (fs.length) st.knowledge = fs.map((f) => f.text).join(' ');
  }
  st.last_result = ctx.lastResult || 'なし';
  const tr = (ctx.troubles || []).filter((t) => t.key.startsWith(`${action.name}:`));
  if (tr.length) st.troubled = troubledText(tr);
  return st;
}

function buildStage2Questions(action, ctx = null, { lang = 'ja', order = null } = {}) {
  const toward = ctx && !hasGoal(ctx) ? '`plan` if present' : '`goal` (and `plan` if present)';
  const criteria = {};
  let chs = action.choices.slice(0, MAX_OPTIONS);
  if (order) chs = order.shuffle(chs, 'act2').arr;
  for (const c of chs) criteria[c.id] = lang === 'en' && c.labelEn ? c.labelEn : c.label;
  return {
    target: {
      type: 'choice',
      instructions: `\`you\` decided to do \`action\`. Choose the target for it that best advances ${toward}. Check \`inventory\`. Do not repeat what just failed in \`last_result\` unless something changed.`,
      criteria,
    },
  };
}

// 英語の state のときの質問 (state のキーが now ではなく inventory / visible / nearby)
function buildQuestionsEn(ctx, opts) {
  const q = {};
  const planObj = ctx.en && ctx.en.plan;
  q.next_action = {
    type: 'choice',
    instructions: (hasGoal(ctx) ? 'Choose the single next action for `you` that best advances `goal`. ' : 'Choose the single next action for `you`. ')
      + (!hasGoal(ctx) && ctx.en && ctx.en.social ? '`feelings` is how `you` feel in body and mind right now. ' : '')
      + (opts.hasTable ? '`actions` explains each kind of action; an option ending in "*" is a kind of action whose target is chosen next. ' : '')
      + (ctx.goalPath ? (planObj && typeof planObj === 'object'
        ? '`plan` is the goal `you` set for yourself: `plan.path` lists the things it needs ("X <- Y": X is obtained from or made of Y) and `plan.next` is the next one. '
        : '`plan` is the goal `you` set for yourself; for an item goal it lists the things it needs in order ("X n ← Y": X is obtained from or made of Y) and the next one. ')
        + (ctx.policy ? '`policy` is what `you` decided to keep doing when looking back on your days. ' : '')
        + (ctx.role ? '`role` is what `you` wrote, when looking back, about what `you` often do lately. ' : '')
        : ctx.goalPlan ? '`plan` is the goal `you` set for yourself and the step `you` are on now. '
        : ctx.selfGoal ? '`plan` is the goal `you` set for yourself and its steps. ' : ctx.progress ? '`plan` lists the steps; the step marked 「← 次はこれ」 is next. ' : '')
      + (ctx.en && ctx.en.othersDoing && Object.keys(ctx.en.othersDoing).length ? '`others_doing` is what `you` have seen or heard other people often doing lately. ' : '')
      + (ctx.en && Array.isArray(ctx.en.experience) && ctx.en.experience.length ? '`experience` is what `you` tried before as goals and how it went (and what `you` heard from others about it). ' : '')
      + (boardKeysText(ctx))
      + 'Check `inventory`, `visible`, `nearby` and `memory`. Do not repeat an action that just failed in `last_result` unless something changed.'
      + (ctx.askHint === false ? '' : ' If `troubled` is present and an ask option exists, asking a nearby player is a good choice.'),
    criteria: opts.criteria,
  };
  if (ctx.selfGoal && ctx.progress) q.goal_done = { type: 'noul', instructions: 'Has `you` already achieved the goal in `plan`, judging from `inventory`, `memory` and `last_result`?' };
  if (ctx.goalPlan && ctx.progress && /今の手順/.test(ctx.progress)) q.step_done = { type: 'noul', instructions: 'Is the current step in `plan` already done, judging from `inventory`, `memory` and `last_result`?' };
  // 道筋の次の一手が今すぐできるか (記録だけ。行動の選び方には使わない)
  if (planObj && typeof planObj === 'object' && planObj.next) {
    q.next_now = { type: 'noul', instructions: 'Can `you` carry out `plan.next` right now, using only what is in `inventory`, `visible` and `nearby`, without first getting or making anything else?' };
  }
  q.remember = { type: 'score', instructions: 'How worth remembering for `you` is what happened in `last_result` and `heard_now`?', criteria: REMEMBER_LEVELS };
  const players = (ctx.raw && ctx.raw.entities || []).filter((e) => e.kind === 'player');
  const heard = (ctx.raw && ctx.raw.heard) || [];
  if (players.length || heard.length) {
    q.talk = {
      type: 'noul',
      instructions: 'Should `you` say something out loud to a nearby player right now? Yes if someone in `heard_now` spoke to `you`, if a player just came near, '
        + (hasGoal(ctx) ? 'or if talking would help coordinate `goal` with nearby players. ' : 'or if `you` have something to say to nearby players about what `you` or they are doing or feeling. ')
        + 'No if nobody is near or there is nothing worth saying.',
    };
  }
  const speakers = [...new Set(heard.map((h) => h.from))].slice(0, opts.maxRelations ?? 3);
  speakers.forEach((name, i) => {
    q[`rel_${i}`] = { type: 'score', instructions: `How did what ${name} said in \`heard_now\` change how \`you\` feel about ${name}?`, criteria: REL_LEVELS };
  });
  // 提案に賛成するか (board.js)。open_proposals.q1 … ごとに1つ
  const b = ctx.en && ctx.en.board;
  const agreeKeys = b && b.open ? Object.keys(b.open) : [];
  for (const k of agreeKeys) q[`agree_${k}`] = { type: 'noul', instructions: `Does \`you\` agree with \`open_proposals.${k}\`?` };
  // 自分の提案した取り決めを破った人 (broken_agreements) への気持ち。既存の印象の質問と同じ段階
  const breakers = (b && b.breakers ? b.breakers : []).filter((n) => !speakers.includes(n)).slice(0, 2);
  breakers.forEach((name, i) => {
    q[`relb_${i}`] = { type: 'score', instructions: `How did what ${name} did in \`broken_agreements\` change how \`you\` feel about ${name}?`, criteria: REL_LEVELS };
  });
  return { questions: q, speakers, agreeKeys, breakers };
}

// state にある board の欄の説明 (何が入っているかだけ)
function boardKeysText(ctx) {
  const b = ctx.en && ctx.en.board;
  if (!b) return '';
  const st = b.state || {};
  const parts = [];
  if (st.board) parts.push('`board` is what people said to everyone (it reaches every person, near or far)');
  if (st.agreements || st.projects) parts.push('`agreements` and `projects` are proposals that enough people agreed to');
  if (st.shared_chests) parts.push('`shared_chests` are chests whose contents everyone can see');
  if (b.open && Object.keys(b.open).length) parts.push('`open_proposals` are proposals made to everyone that `you` have not answered yet');
  return parts.length ? `${parts.join('; ')}. ` : '';
}

function buildQuestions(ctx, opts) {
  if ((opts.lang || ctx.lang) === 'en') return buildQuestionsEn(ctx, opts);
  const q = {};
  q.next_action = {
    type: 'choice',
    instructions: (hasGoal(ctx) ? 'Choose the single next action for `you` that best advances `goal`. ' : 'Choose the single next action for `you`. ')
      + (!hasGoal(ctx) && ctx.socialText ? '`feelings` is how `you` feel in body and mind right now. ' : '')
      + (opts.hasTable ? '`actions` explains each kind of action; an option ending in "*" is a kind of action whose target is chosen next. ' : '')
      + (ctx.goalPath ? '`plan` is the goal `you` set for yourself; for an item goal it lists the things it needs in order ("X n ← Y": X is obtained from or made of Y) and the next one; for a state goal it also lists the actions after the things. '
        + (ctx.policy ? '`policy` is what `you` decided to keep doing when looking back on your days. ' : '')
        : ctx.goalPlan ? '`plan` is the goal `you` set for yourself and the step `you` are on now. '
        : ctx.selfGoal ? '`plan` is the goal `you` set for yourself and its steps. ' : '`plan` lists the steps; the step marked 「← 次はこれ」 is next. ')
      + 'Check `now` (inventory and what is visible) and `memory`. Do not repeat an action that just failed in `last_result` unless something changed.'
      // help.askHint: 困ったら聞くよう後押しする一文 (first_setting では外し、無しで聞くかを観察する)
      + (ctx.askHint === false ? '' : ' If `troubled` is present and an ask option exists, asking a nearby player is a good choice.'),
    criteria: opts.criteria,
  };
  // 自分で決めた目標が済んだか (help.selfGoal)。高ければ agent が次のループで目標を書き直す
  if (ctx.selfGoal && ctx.progress) {
    q.goal_done = { type: 'noul', instructions: 'Has `you` already achieved the goal in `plan`, judging from `now`, `memory` and `last_result`?' };
  }
  // ゴールと手順 (help.goalPlan): 今の手順が済んだか。高ければ agent が次の判断の前に次の手順へ進める
  if (ctx.goalPlan && ctx.progress && /今の手順/.test(ctx.progress)) {
    q.step_done = { type: 'noul', instructions: 'Is the current step in `plan` already done, judging from `now`, `memory` and `last_result`?' };
  }
  q.remember = { type: 'score', instructions: 'How worth remembering for `you` is what happened in `last_result` and `heard_now`?', criteria: REMEMBER_LEVELS };
  const players = (ctx.raw && ctx.raw.entities || []).filter((e) => e.kind === 'player');
  const heard = (ctx.raw && ctx.raw.heard) || [];
  if (players.length || heard.length) {
    q.talk = {
      type: 'noul',
      instructions: 'Should `you` say something out loud to a nearby player right now? Yes if someone in `heard_now` spoke to `you`, if a player just came near, '
        + (hasGoal(ctx) ? 'or if talking would help coordinate `goal` with nearby players. ' : 'or if `you` have something to say to nearby players about what `you` or they are doing or feeling. ')
        + 'No if nobody is near or there is nothing worth saying.',
    };
  }
  const speakers = [...new Set(heard.map((h) => h.from))].slice(0, opts.maxRelations ?? 3);
  speakers.forEach((name, i) => {
    q[`rel_${i}`] = { type: 'score', instructions: `How did what ${name} said in \`heard_now\` change how \`you\` feel about ${name}?`, criteria: REL_LEVELS };
  });
  return { questions: q, speakers };
}

// 1回の呼び出しの記録に足すもの: 提供元 (via)・応答の id・provider (OpenRouter が足す)・費用 (usage.cost)・refusal の質問・本文の大きさ
function callInfo(r) {
  const o = { via: r.via || null };
  if (r.id) o.id = r.id;
  if (r.provider) o.provider = r.provider;
  if (r.costUsd != null) o.costUsd = r.costUsd;
  if (r.refusals && r.refusals.length) o.refusals = r.refusals;
  if (r.bodyBytes != null) o.bodyBytes = r.bodyBytes;
  if (r.longContext) o.longContext = true;
  if (r.fatal) o.fatal = true;
  return o;
}

function r3(v) { return v == null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000; }

// choice の答えから: 選んだ選択肢の確率 p・1位÷2位の比 ratio・上位3つ・選んだ選択肢の並びの位置 pos (0 = 先頭)・選択肢の数 n
function probStats(ans, keys = []) {
  const out = { pos: keys.indexOf(ans.choice), n: keys.length };
  const pr = ans.probabilities;
  if (!pr || typeof pr !== 'object') return out;
  const sorted = Object.entries(pr).filter(([, v]) => Number.isFinite(v)).sort((a, b) => b[1] - a[1]);
  if (!sorted.length) return out;
  out.p = r3(pr[ans.choice] ?? sorted[0][1]);
  const p2 = sorted[1] ? sorted[1][1] : 0;
  out.ratio = p2 > 0 ? Math.round((sorted[0][1] / p2) * 100) / 100 : null;
  out.top = sorted.slice(0, 3).map(([k, v]) => [k, r3(v)]);
  return out;
}

// 道筋の次 (planner の手順 / states の行動) の短い名前
function stepKey(s) {
  if (!s) return null;
  if (s.act) return `${s.how}${s.animal ? `:${s.animal}` : s.item ? `:${s.item}` : s.block ? `:${s.block}` : ''}`;
  return `${s.how}:${s.item}${s.from && s.from !== s.item ? `<${s.from}` : ''}`;
}

// 選んだ行動が道筋の次の一手か: 'step' (その一手の行動) / 'approach' (その入手元へ近づく) / 'other' / null (道筋が無い)
function pathMatch(s, action, arg) {
  if (!s) return null;
  const a = String(arg || '');
  const fam = (x, y) => !!x && !!y && (x === y || familyKey(x) === familyKey(y));
  const src = s.from || s.item;
  if (action === 'search') return 'search'; // 探しながら歩く (search.js)。道筋の物を探す移動
  if (!s.act) {
    if (s.how === 'collect' && ((action === 'collect' && fam(a, src)) || (action === 'pick_up' && fam(a, s.item)))) return 'step';
    if (s.how === 'collect' && action === 'use_on' && fam(a.split('>')[1], src)) return 'step';
    // 人が置いた物から取る道筋 (planner の where: 'placed')。id は "torch@Miho" の形、dismantle_own は名前だけ
    if (s.how === 'collect' && (action === 'take_placed' || action === 'dismantle_own') && fam(a.split('@')[0], src)) return 'step';
    if (s.how === 'kill' && (action === 'attack' || action === 'hunt') && fam(a, src)) return 'step';
    if (s.how === 'craft' && action === 'craft' && fam(a, s.item)) return 'step';
    if (s.how === 'chest' && action === 'chest_take' && fam(a, s.item)) return 'step'; // 共有のチェストから出す (board.js)
    if (s.how === 'smelt' && ((action === 'smelt' && fam(a, s.from)) || action === 'furnace_take')) return 'step';
    if (s.how === 'farm') { // 畑: 耕す (クワを土に)・植える (種を耕地に)・取る (作物を壊す)
      const [x, y] = a.split('>');
      const yb = String(y || '').split('@')[0];
      const wr = s.water && s.water.ready === false ? s.water : null; // 耕す前に水の近くへ行く段 (水から4マス以内の耕せるマスがまだ無い)
      if (s.till > 0 && wr && action === 'go_to' && ((wr.id && a === wr.id) || a === 'water')) return 'step';
      if (s.till > 0 && wr && wr.where === 'unknown' && action === 'explore') return 'step';
      if (s.till > 0 && action === 'use_on' && /_hoe$/.test(x || '') && /^(dirt|grass_block|farmland_spot)$/.test(yb)) return 'step';
      if (s.plants > 0 && action === 'use_on' && x === s.seed && yb === 'farmland') return 'step';
      if (!(s.till > 0) && !(s.plants > 0) && action === 'collect' && a === s.crop) return 'step';
      if (action === 'go_to' && /farmland|wheat|carrots|potatoes|beetroots/.test(a)) return 'approach';
      return 'other';
    }
    if ((action === 'go_to' || action === 'pillar') && (fam(a, src) || (s.station && a === s.station))) return 'approach';
    return 'other';
  }
  const [x, y] = a.split('>');
  if (s.how === 'enclose' && action === 'enclose') return 'step';
  if (s.how === 'lure' && action === 'lure' && x === s.animal) return 'step';
  if (s.how === 'breed' && action === 'use_on' && y === s.animal) return 'step';
  if (s.how === 'till' && action === 'use_on' && /_hoe$/.test(x || '') && /^(dirt|grass_block|farmland_spot)$/.test(String(y || '').split('@')[0])) return 'step';
  if (s.how === 'water' && s.water && ((action === 'go_to' && ((s.water.id && a === s.water.id) || a === 'water')) || (s.water.where === 'unknown' && action === 'explore'))) return 'step';
  if (s.how === 'plant' && action === 'use_on' && x === s.seed && String(y || '').split('@')[0] === 'farmland') return 'step';
  if (s.how === 'place' && action === 'place' && fam(a, s.item)) return 'step';
  if (s.how === 'chest_put' && action === 'chest_put' && fam(a, s.item)) return 'step';
  if (s.how === 'find' && (action === 'explore' || (action === 'go_to' && a === s.block))) return 'step';
  if ((s.how === 'lure' || s.how === 'breed') && action === 'go_to') return 'approach';
  return 'other';
}

class JevDecider {
  constructor(opts = {}) {
    this.kind = 'jev';
    this.client = opts.client || new JevClient(opts);
    this.meter = opts.meter || null;
    this.maxRelations = opts.maxRelations ?? 3;
    this.twoStage = twoStageCfg(opts.twoStage);
    this.lang = opts.stateLang || 'en'; // Jev に渡す state の言葉 ('en' | 'ja')
  }

  // 1回の呼び出し: 送って、使用量を記録する
  async call(state, questions, stage) {
    const inputText = JSON.stringify(state) + JSON.stringify(questions);
    const r = await this.client.ask(state, questions);
    const usageIn = r.usage && Number.isFinite(r.usage.input_tokens) ? r.usage.input_tokens : null;
    const nq = Object.keys(questions).length;
    const rec = this.meter
      ? this.meter.addJev({ stage, inputChars: inputText.length, inputText, inputTokens: usageIn, outputTokens: r.usage ? r.usage.output_tokens : null, ms: r.ms, questions: nq, error: r.ok ? null : r.error, rateLimited: r.rateLimited, retries: r.retries,
        costUsd: r.costUsd, refusals: r.refusals, longContext: r.longContext, bodyBytes: r.bodyBytes, via: r.via, model: r.model, fatal: r.fatal })
      : { inputTokens: usageIn ?? estimateTokens(inputText), estimated: usageIn == null };
    return { r, inputChars: inputText.length, inputTokens: rec.inputTokens, estimated: rec.estimated };
  }

  // Jev の確率に、状態が変わらなかった回数の負の重み (weight^n) と、選択肢の重み (choice_weight.js。人の所へ行く・ついて行くなど) を掛けて選び直す。
  //   pens = { 選択肢の key: 回数 }、cw = { 選択肢の key: 係数 }
  static applyWeights(ans, pens, weight, cw) {
    if (!ans || !ans.probabilities) return null;
    const keys = Object.keys(ans.probabilities);
    const mult = {};
    for (const k of keys) {
      const n = (pens && pens[k]) || 0;
      const f = (n && weight != null ? Math.pow(weight, n) : 1) * (cw && cw[k] != null ? cw[k] : 1);
      if (f !== 1) mult[k] = f;
    }
    if (!Object.keys(mult).length) return null;
    const rw = reweightMult(ans.probabilities, mult);
    if (!rw) return null;
    const touchedP = keys.filter((k) => pens && pens[k]);
    const touchedW = keys.filter((k) => cw && cw[k] != null && cw[k] !== 1);
    const info = { from: rw.original, to: rw.choice, changed: rw.changed,
      pFrom: Number((ans.probabilities[rw.original] || 0).toFixed(3)), pTo: Number((rw.probs[rw.choice] || 0).toFixed(3)) };
    if (touchedP.length) { info.weight = weight; info.penalties = Object.fromEntries(touchedP.map((k) => [k, pens[k]])); }
    if (touchedW.length) info.choiceWeights = Object.fromEntries(touchedW.map((k) => [k, cw[k]]));
    return { rw, info };
  }

  // Jev の確率に、状態が変わらなかった回数だけ負の重みを掛けて選び直す。pens = { 選択肢の key: 回数 }
  static applyPenalties(ans, pens, weight) {
    if (!ans || !ans.probabilities || !Object.keys(pens).length) return null;
    const rw = reweight(ans.probabilities, (k) => k, pens, weight);
    if (!rw) return null;
    const touched = Object.keys(ans.probabilities).filter((k) => pens[k]);
    return { rw, info: { from: rw.original, to: rw.choice, changed: rw.changed, weight,
      penalties: Object.fromEntries(touched.map((k) => [k, pens[k]])),
      pFrom: Number((ans.probabilities[rw.original] || 0).toFixed(3)), pTo: Number((rw.probs[rw.choice] || 0).toFixed(3)) } };
  }

  async decide(ctx) {
    const lang = this.lang;
    const { criteria, map, table, groups, order, cut } = actionOptions(ctx.actions, { twoStage: this.twoStage.enabled ? this.twoStage : false, lang, order: ctx.order || null });
    const state = buildState(ctx, { table, lang });
    const { questions, speakers, agreeKeys = [], breakers = [] } = buildQuestions(ctx, { criteria, maxRelations: this.maxRelations, hasTable: true, lang });
    const c1 = await this.call(state, questions, 1);
    const r = c1.r;
    const jev = {
      model: r.model || null, ms: r.ms, queueMs: r.queueMs, retries: r.retries, rateLimited: r.rateLimited, status: r.status ?? null,
      inputChars: c1.inputChars, inputTokens: c1.inputTokens, tokensEstimated: c1.estimated, outputTokens: r.usage ? r.usage.output_tokens : null,
      questions: Object.keys(questions), options: Object.keys(criteria).length, limits: r.limits || null, calls: 1,
      groups: Object.keys(groups), lang, ...callInfo(r),
    };
    if (order) jev.order = order;
    if (cut) jev.cut = cut; // 上限で切った (行動ごとに順番に取った)
    // 送った state と質問の全文は最初の1回だけ記録に残す (長いので)
    if (!this.loggedState) { jev.sent = { state, questions }; this.loggedState = true; }
    const base = { rawOutput: null, latencyMs: r.ms, promptChars: c1.inputChars, promptTokens: c1.inputTokens, say: '', jev };
    const finish = () => {
      base.latencyMs = jev.ms; base.promptChars = jev.inputChars; base.promptTokens = jev.inputTokens;
      if (this.meter && this.meter.addDecision) this.meter.addDecision({ calls: jev.calls, inputTokens: jev.inputTokens });
    };
    if (!r.ok) { finish(); return { ...base, action: null, arg: '', parseOk: false, repaired: false, error: r.error, ...(r.fatal ? { fatal: true } : {}) }; }
    const a = r.answers || {};
    // next_action が refusal (答えなし): 選べなかったとして、Jev の答えが無いときと同じ扱い (action: null)
    if (!a.next_action && (r.refusals || []).includes('next_action')) {
      finish();
      return { ...base, action: null, arg: '', parseOk: false, repaired: false, error: 'Jev が next_action に答えなかった (refusal)', refusal: true };
    }
    let chosen = a.next_action ? a.next_action.choice : null;
    // 状態が変わらなかった行動に負の重み (help.noChange のとき、agent が ctx.noChange を渡す)。
    // 分類の選択肢は、中の対象の回数の一番少ないもの (変わらなかったことのない対象が1つでもあれば重みなし)
    // 選択肢の重み (ctx.choiceWeights。choice_weight.js): 人の所へ行く・ついて行く・道筋に関係しない覚えた場所。分類の選択肢は、中の対象の重みの一番大きいもの
    const pens = (ctx.noChange && ctx.noChange.penalties) || {};
    const cwAll = ctx.choiceWeights || {};
    if ((ctx.noChange && Object.keys(pens).length) || Object.keys(cwAll).length) {
      const p1 = {};
      const w1 = {};
      for (const k of Object.keys(criteria)) {
        const m = map[k];
        const n = m.group ? Math.min(...groups[m.group].choices.map((c) => pens[`${m.group}:${c.id}`] || 0)) : (pens[`${m.action}:${m.arg}`] || 0);
        if (n && ctx.noChange) p1[k] = n;
        const w = m.group ? Math.max(...groups[m.group].choices.map((c) => cwAll[`${m.group}:${c.id}`] ?? 1)) : (cwAll[`${m.action}:${m.arg}`] ?? 1);
        if (w !== 1) w1[k] = w;
      }
      const x = JevDecider.applyWeights(a.next_action, p1, ctx.noChange ? ctx.noChange.weight : null, w1);
      if (x) { jev.reweight = x.info; chosen = x.rw.choice; }
    }
    jev.choice = a.next_action ? { choice: a.next_action.choice, confidence: a.next_action.confidence ?? null, ...probStats(a.next_action, Object.keys(criteria)) } : null;
    if (jev.choice && chosen && chosen !== a.next_action.choice && a.next_action.probabilities) jev.choice.pFinal = r3(a.next_action.probabilities[chosen] ?? null);
    jev.nextNowP = a.next_now ? a.next_now.noul ?? null : null;
    jev.talkP = a.talk ? a.talk.noul : null;
    jev.goalDoneP = a.goal_done ? a.goal_done.noul : null;
    jev.stepDoneP = a.step_done ? a.step_done.noul : null;
    jev.remember = a.remember ? a.remember.score : null;
    jev.relations = Object.fromEntries(speakers.map((n, i) => [n, a[`rel_${i}`] ? a[`rel_${i}`].score : null]));
    breakers.forEach((n, i) => { if (a[`relb_${i}`]) jev.relations[n] = a[`relb_${i}`].score; });
    if (agreeKeys.length) jev.agree = Object.fromEntries(agreeKeys.map((k) => [k, a[`agree_${k}`] && Number.isFinite(a[`agree_${k}`].noul) ? a[`agree_${k}`].noul : null]));
    base.rawOutput = JSON.stringify(a.next_action ? { choice: a.next_action.choice, confidence: a.next_action.confidence } : null);
    let pick = chosen && map[chosen];
    if (pick && pick.group) {
      // 2回目: 分類の中から対象を選ぶ
      const act = groups[pick.group];
      const st2 = buildStage2State(ctx, act, lang);
      const q2 = buildStage2Questions(act, ctx, { lang, order: ctx.order || null });
      const c2 = await this.call(st2, q2, 2);
      const s2 = { action: act.name, options: Object.keys(q2.target.criteria).length, inputChars: c2.inputChars, inputTokens: c2.inputTokens, tokensEstimated: c2.estimated, ms: c2.r.ms, outputTokens: c2.r.usage ? c2.r.usage.output_tokens : null, ...callInfo(c2.r) };
      if (s2.costUsd != null) jev.costUsd = Number(((jev.costUsd || 0) + s2.costUsd).toFixed(8));
      jev.calls = 2;
      jev.stage1 = { inputChars: c1.inputChars, inputTokens: c1.inputTokens, ms: r.ms };
      jev.inputChars += c2.inputChars; jev.inputTokens += c2.inputTokens; jev.ms += c2.r.ms || 0;
      jev.tokensEstimated = jev.tokensEstimated || c2.estimated;
      if (jev.outputTokens != null && s2.outputTokens != null) jev.outputTokens += s2.outputTokens;
      let id = null;
      const t = c2.r.ok && c2.r.answers ? c2.r.answers.target : null;
      if (t) {
        id = t.choice;
        s2.choice = { choice: t.choice, confidence: t.confidence ?? null, ...probStats(t, Object.keys(q2.target.criteria)) };
        if (ctx.noChange || Object.keys(cwAll).length) {
          const p2 = {};
          const w2 = {};
          for (const c of act.choices) {
            const n = pens[`${act.name}:${c.id}`]; if (n && ctx.noChange) p2[c.id] = n;
            const w = cwAll[`${act.name}:${c.id}`]; if (w != null && w !== 1) w2[c.id] = w;
          }
          const x = JevDecider.applyWeights(t, p2, ctx.noChange ? ctx.noChange.weight : null, w2);
          if (x) { s2.reweight = x.info; id = x.rw.choice; }
        }
      }
      if (!id || !act.choices.some((c) => c.id === id)) {
        // 2回目が失敗・一覧にない答え: 一覧の先頭 (近い・手元のもの) にする
        s2.error = !c2.r.ok ? c2.r.error : (c2.r.refusals || []).includes('target') ? 'Jev が target に答えなかった (refusal)' : `一覧にない対象: ${id}`;
        id = act.choices[0].id;
        s2.fallback = true;
      }
      jev.stage2 = s2;
      pick = { action: act.name, arg: id };
    }
    // 道筋の次の一手と選んだ行動が合うか (記録だけ。ctx.pathNext は goalPath の道筋の次)
    if (pick && !pick.group && ctx.pathNext !== undefined) jev.path = { next: stepKey(ctx.pathNext), nextNowP: jev.nextNowP, match: pathMatch(ctx.pathNext, pick.action, pick.arg) };
    finish();
    if (!pick) return { ...base, action: null, arg: '', parseOk: false, repaired: false, error: `Jev の選択が一覧にない: ${chosen}` };
    return { ...base, action: pick.action, arg: pick.arg, parseOk: true, repaired: false };
  }
}

module.exports = { callInfo, fairCut, probStats, pathMatch, stepKey, buildStateEn, buildQuestionsEn, JevDecider, actionOptions, buildState, buildQuestions, buildStage2State, buildStage2Questions, twoStageCfg, TWO_STAGE_DEFAULTS, REMEMBER_LEVELS, REL_LEVELS };
