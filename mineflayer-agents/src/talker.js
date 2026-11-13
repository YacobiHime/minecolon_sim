'use strict';
// 発言を作る 2B (Gemma 4 E2B、llama-server)。行動は Jev が決め、話すべきとき (Jev の Noul が閾値を超えたとき)
// と、人に聞かれて答えるときだけ呼ぶ。呼び出しの回数とプロンプトの長さを UsageMeter と記録に残す。
const { LLMDecider } = require('./deciders/llm');
const { KIND_ROLE } = require('./llm_provider');

const SAY_SCHEMA = { type: 'object', properties: { say: { type: 'string', maxLength: 60 } }, required: ['say'], additionalProperties: false };

// 場所の言い方の事実 (どう言うとよいかは書かない)
const PLACE_FACT = '場所の言い方: 出現地点 (全員が最初に出た所) からの方角と距離 (「出現地点から北東に120m」の形) は、誰が聞いても同じ所を指す。M1 などの番号は自分の記憶の中だけの番号。';

function personaLines(persona) {
  return [
    `あなたは Minecraft の世界にいる「${persona.name}」。${persona.personality || ''}`,
    persona.speech ? `話し方: ${persona.speech}` : '',
  ].filter(Boolean);
}

class Talker {
  constructor(opts = {}) {
    // 役ごと (talk・answer・broadcast) に LLM を持つ。opts.llm (1つ) を渡せば全部それ。
    // opts.llmOptsFor(role) で役ごとの opts (llm_provider.llmOptsFor)、無ければ opts.llmOpts を全部の役に
    const mk = (o) => new LLMDecider({ ...o, mode: 'talk', maxTokens: opts.maxTokens ?? o.maxTokens ?? 64 });
    this.llms = {};
    for (const role of ['talk', 'answer', 'broadcast']) {
      this.llms[role] = opts.llm || mk(opts.llmOptsFor ? opts.llmOptsFor(role) : { ...(opts.llmOpts || {}), role });
    }
    this.llm = this.llms.talk;
    this.meter = opts.meter || null;
    const names = [...new Set(Object.values(this.llms).map((l) => `${l.provider || 'local'}(${l.model})`))];
    // 全部 local なら今までと同じ書き方 (記録の talker)
    this.kind = names.length === 1 && (this.llm.provider || 'local') === 'local' ? `2B(${this.llm.model})`
      : names.length === 1 ? names[0] : Object.entries(this.llms).map(([r, l]) => `${r}=${l.provider}(${l.model})`).join(',');
  }

  // 話す内容を作る。ctx = { persona, goal, plan (自分のゴールと今の手順), socialText, nearText, heardText, memText, plannedAction }
  talkMessages(ctx) {
    return [
      { role: 'system', content: [...personaLines(ctx.persona), ...(ctx.goal && ctx.goal.text ? [`目標: ${ctx.goal.text}`] : []),
        PLACE_FACT,
        '近くの人に話しかける。短い日本語(30字以内)で、自分の気持ちと関係に合った言い方にする。JSON {"say":"..."} だけを出力する。'].join('\n') },
      { role: 'user', content: [
        `## 体と心・人間関係\n${ctx.socialText || 'なし'}`,
        ctx.plan ? `## 今していること\n${ctx.plan}` : '',
        `## 近くの人\n${ctx.nearText || 'なし'}`,
        `## 今聞こえた話\n${ctx.heardText || 'なし'}`,
        `## 覚えていること\n${ctx.memText || 'なし'}`,
        ctx.plannedAction ? `## これからすること\n${ctx.plannedAction}` : '',
        '話すことを JSON で。',
      ].filter(Boolean).join('\n') },
    ];
  }

  // 聞かれたことに、自分の記憶の範囲で答える。memories が空なら呼ばずに「分からない」
  answerMessages(ctx) {
    return [
      { role: 'system', content: [...personaLines(ctx.persona),
        PLACE_FACT,
        '人に聞かれたことに答える。下の「覚えていること」に書いてあることだけを使い、短い日本語(40字以内)で答える。',
        '書いていないことは言わない。答えが分からなければ「分からない」と言う。JSON {"say":"..."} だけを出力する。'].join('\n') },
      { role: 'user', content: `## ${ctx.from}さんの質問\n${ctx.question}\n## 覚えていること\n${ctx.memories.map((m) => `- ${m.text}`).join('\n')}\n答えを JSON で。` },
    ];
  }

  // 見つけた物と場所を全員に (report_find。【発見】の行)。ctx.seenText: 見えている目印・生き物と、自分からの方角・共通の呼び方
  reportFindMessages(ctx) {
    return [
      { role: 'system', content: [...personaLines(ctx.persona), PLACE_FACT,
        '見つけた物と場所を、全員に届く声で知らせる (近くにいない人にも届く)。短い日本語(50字以内)。JSON {"say":"..."} だけを出力する。'].join('\n') },
      { role: 'user', content: [...this.contextLines(ctx),
        ctx.hereText ? `## 今いる所\n${ctx.hereText}` : '',
        `## 今見えている物\n${ctx.seenText || 'なし'}`,
        '知らせることを JSON で。'].filter(Boolean).join('\n') },
    ];
  }

  // 全員に届く声 (broadcast)。ctx は talk と同じ + boardText (全体に届いた話・取り決め・共同の目標・共有のチェスト)
  broadcastMessages(ctx) {
    return [
      { role: 'system', content: [...personaLines(ctx.persona), ...(ctx.goal && ctx.goal.text ? [`目標: ${ctx.goal.text}`] : []),
        PLACE_FACT,
        '全員に届く声で話す (近くにいない人にも届く)。短い日本語(40字以内)で、自分の気持ちと関係に合った言い方にする。JSON {"say":"..."} だけを出力する。'].join('\n') },
      { role: 'user', content: [...this.contextLines(ctx), '全員に言うことを JSON で。'].filter(Boolean).join('\n') },
    ];
  }

  // 提案 (propose)。ctx.items: 物の名前の候補、ctx.chests: 共有のチェストの id、ctx.hereChest: 近くに共有でないチェストがあるか
  //   ctx.itemEffort: 物の名前 → 手間の言葉 (小/中/大。自分がその物を手に入れる道筋の手間。goalpath の候補から)
  //   共有のチェストが無い (近くのチェストも無い) ときは kind: rule を出さない
  proposeMessages(ctx) {
    const chestLine = [...(ctx.chests || []).map((c) => `${c.id}${c.text ? ` (${c.text})` : ''}`), ...(ctx.hereChest ? ['here (近くのチェスト。まだ共有ではない。提案すると共有になる)'] : [])];
    const rule = hasChest(ctx);
    const eff = ctx.itemEffort || {};
    return [
      { role: 'system', content: [...personaLines(ctx.persona), ...(ctx.goal && ctx.goal.text ? [`目標: ${ctx.goal.text}`] : []),
        PLACE_FACT,
        rule ? '全員に向けて提案を1つ書く。提案は全員に届き、聞いた人はそれぞれ賛成するかを決める。賛成が集まると、kind: rule は全員の「取り決め」に、kind: project は全員の「共同の目標」になる。'
          : '全員に向けて提案を1つ書く。提案は全員に届き、聞いた人はそれぞれ賛成するかを決める。賛成が集まると、kind: project は全員の「共同の目標」になる。',
        rule ? 'rule が物を共有のチェストに入れる取り決めなら item にその物、chest にそのチェストを書く。project が物を何個そろえる (集める・作る) 目標なら item と count を書く。当てはまらない欄は空の文字列にする。どちらでもなければ kind: other。'
          : 'project が物を何個そろえる (集める・作る) 目標なら item と count を書く。当てはまらない欄は空の文字列にする。そうでなければ kind: other。',
        'say に提案の文を短い日本語(40字以内)で書く。JSON {"kind":"...","item":"...","chest":"...","count":1,"say":"..."} だけを出力する。'].join('\n') },
      { role: 'user', content: [...this.contextLines(ctx),
        ctx.toolFacts ? `## 道具のこと (見聞きした事実)\n${ctx.toolFacts}` : '',
        `## 物の名前 (手間: 自分が手に入れるときの手間)\n${(ctx.items || []).map((n) => (eff[n] ? `${n} (手間: ${eff[n]})` : n)).join(', ') || 'なし'}`,
        rule ? `## チェスト\n${chestLine.join('\n')}` : '## チェスト\n共有のチェストはまだない',
        '提案を JSON で。'].filter(Boolean).join('\n') },
    ];
  }

  // 道具の不満を声に出す (toolwant.js が形を決める)。ctx.form: mutter (独り言) | near (近くの人に頼む) | all (全員に頼む)、
  //   ctx.wantItem: 欲しい物の名前、ctx.wantFacts: 自分の作業の事実と仕様 (toolwant.factsText)。どう頼むとよいかは書かない
  voiceMessages(ctx) {
    const form = ctx.form;
    const how = form === 'mutter'
      ? '誰かに向けてではなく、ひとりごとをつぶやく。近くに人がいれば聞こえることもある。短い日本語(25字以内)。'
      : form === 'all' ? '全員に届く声で頼みごとをする (近くにいない人にも届く)。短い日本語(40字以内)。'
        : `近くの人 (${ctx.nearText || 'そばの人'}) に頼みごとをする。短い日本語(30字以内)。`;
    return [
      { role: 'system', content: [...personaLines(ctx.persona), ...(ctx.goal && ctx.goal.text ? [`目標: ${ctx.goal.text}`] : []),
        `${how}自分の気持ちと関係に合った言い方にする。物の名前は英語の名前 (例 ${ctx.wantItem || 'stone_axe'}) か日本語の名前で言う。JSON {"say":"..."} だけを出力する。`].join('\n') },
      { role: 'user', content: [
        `## 体と心・人間関係\n${ctx.socialText || 'なし'}`,
        ctx.plan ? `## 今していること\n${ctx.plan}` : '',
        `## 欲しい物\n${ctx.wantItem}`,
        `## 自分の作業のこと (事実)\n${ctx.wantFacts || 'なし'}`,
        form === 'near' ? `## 近くの人\n${ctx.nearText || 'なし'}` : '',
        `## 今聞こえた話\n${ctx.heardText || 'なし'}`,
        form === 'all' ? ctx.boardText || '' : '',
        form === 'mutter' ? 'つぶやくことを JSON で。' : '言うことを JSON で。',
      ].filter(Boolean).join('\n') },
    ];
  }

  voice(ctx) { return this.run(`voice_${ctx.form}`, this.voiceMessages(ctx)); }

  contextLines(ctx) {
    return [
      `## 体と心・人間関係\n${ctx.socialText || 'なし'}`,
      ctx.plan ? `## 今していること\n${ctx.plan}` : '',
      `## 近くの人\n${ctx.nearText || 'なし'}`,
      `## 今聞こえた話\n${ctx.heardText || 'なし'}`,
      ctx.boardText || '',
      `## 覚えていること\n${ctx.memText || 'なし'}`,
    ];
  }

  async run(kind, messages, schema = SAY_SCHEMA) {
    const promptChars = messages.reduce((s, m) => s + m.content.length, 0);
    const t0 = Date.now();
    let r = null;
    let error = null;
    const llm = this.llms[KIND_ROLE[kind] || 'talk'] || this.llm;
    try { r = await llm.complete(messages, schema, kind === 'propose' ? { maxTokens: 160 } : undefined); } catch (e) { error = e.message; }
    const ms = Date.now() - t0;
    let say = '';
    if (r) { const m = r.text.match(/"say"\s*:\s*"([^"]*)/); say = m ? m[1].trim() : ''; }
    const rec = { kind, provider: llm.provider || 'local', promptChars, promptTokens: r ? r.promptTokens : null, completionTokens: r ? r.completionTokens : null,
      ...(r && r.reasoningTokens ? { reasoningTokens: r.reasoningTokens } : {}), ...(r && r.costUsd ? { costUsd: r.costUsd } : {}), ms, error, rawOutput: r ? r.text : null, say };
    if (this.meter) this.meter.addTwoB(rec);
    return rec;
  }

  talk(ctx) { return this.run('talk', this.talkMessages(ctx)); }
  broadcast(ctx) { return this.run('broadcast', this.broadcastMessages(ctx)); }
  reportFind(ctx) { return this.run('report_find', this.reportFindMessages(ctx)); }
  async propose(ctx) {
    const rec = await this.run('propose', this.proposeMessages(ctx), proposeSchema(ctx));
    rec.proposal = rec.rawOutput ? parseProposal(rec.rawOutput, ctx) : null;
    if (rec.proposal) rec.say = rec.proposal.text;
    return rec;
  }
  answer(ctx) { return this.run('answer', this.answerMessages(ctx)); }
}

function hasChest(ctx) { return !!((ctx.chests && ctx.chests.length) || ctx.hereChest); }

function proposeSchema(ctx) {
  const chests = ['', ...(ctx.chests || []).map((c) => c.id), ...(ctx.hereChest ? ['here'] : [])];
  return { type: 'object', properties: {
    kind: { type: 'string', enum: hasChest(ctx) ? ['rule', 'project', 'other'] : ['project', 'other'] },
    item: { type: 'string', enum: ['', ...new Set(ctx.items || [])] },
    chest: { type: 'string', enum: [...new Set(chests)] },
    count: { type: 'integer', minimum: 1, maximum: 64 },
    say: { type: 'string', maxLength: 60 },
  }, required: ['kind', 'item', 'chest', 'count', 'say'], additionalProperties: false };
}

// 2B の出力 → { spec: { type: rule|project|text, item, chest, count }, text } | null。
//   rule は物とチェストが両方あるときだけ構造にする (chest: here は agent が共有にしてから id に置き換える)。project は物があるとき。ほかは文だけ
const GATHER = /集め|集めよ|そろえ|揃え|貯め|ためよ|作ろ|つくろ|取ろ|とろう|手に入れよ|持ち寄|みんなで.*(取|作|集)/;

function parseProposal(text, ctx = {}) {
  let o = null;
  try { const s = String(text); o = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)); } catch (_) { return null; }
  const say = typeof o.say === 'string' ? o.say.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
  if (!say) return null;
  const items = new Set(ctx.items || []);
  const chests = new Set([...(ctx.chests || []).map((c) => c.id), ...(ctx.hereChest ? ['here'] : [])]);
  const item = typeof o.item === 'string' && items.has(o.item) ? o.item : '';
  const chest = typeof o.chest === 'string' && chests.has(o.chest) ? o.chest : '';
  const count = Math.max(1, Math.min(64, Math.floor(Number(o.count)) || 1));
  if (o.kind === 'rule' && item && chest) return { spec: { type: 'rule', item, chest }, text: say };
  if (o.kind === 'project' && item) return { spec: { type: 'project', item, count }, text: say };
  // 物があって「集めよう・そろえよう・作ろう」の形 (チェストの無い rule・other) は共同の目標にする
  if (item && (o.kind === 'rule' || GATHER.test(say))) return { spec: { type: 'project', item, count }, text: say, kindAsked: o.kind || null, kindFixed: true };
  return { spec: { type: 'text' }, text: say, kindAsked: o.kind || null };
}

module.exports = { PLACE_FACT, Talker, SAY_SCHEMA, proposeSchema, parseProposal };
