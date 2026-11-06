'use strict';
// 発言を作る 2B (Gemma 4 E2B、llama-server)。行動は Jev が決め、話すべきとき (Jev の Noul が閾値を超えたとき)
// と、人に聞かれて答えるときだけ呼ぶ。呼び出しの回数とプロンプトの長さを UsageMeter と記録に残す。
const { LLMDecider } = require('./deciders/llm');

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
    this.llm = opts.llm || new LLMDecider({ ...(opts.llmOpts || {}), mode: 'talk', maxTokens: opts.maxTokens ?? (opts.llmOpts || {}).maxTokens ?? 64 });
    this.meter = opts.meter || null;
    this.kind = `2B(${this.llm.model})`;
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
  proposeMessages(ctx) {
    const chestLine = [...(ctx.chests || []).map((c) => `${c.id}${c.text ? ` (${c.text})` : ''}`), ...(ctx.hereChest ? ['here (近くのチェスト。まだ共有ではない。提案すると共有になる)'] : [])];
    return [
      { role: 'system', content: [...personaLines(ctx.persona), ...(ctx.goal && ctx.goal.text ? [`目標: ${ctx.goal.text}`] : []),
        PLACE_FACT,
        '全員に向けて提案を1つ書く。提案は全員に届き、聞いた人はそれぞれ賛成するかを決める。賛成が集まると、kind: rule は全員の「取り決め」に、kind: project は全員の「共同の目標」になる。',
        'rule が物を共有のチェストに入れる取り決めなら item にその物、chest にそのチェストを書く。project が物を何個そろえる目標なら item と count を書く。当てはまらない欄は空の文字列にする。どちらでもなければ kind: other。',
        'say に提案の文を短い日本語(40字以内)で書く。JSON {"kind":"...","item":"...","chest":"...","count":1,"say":"..."} だけを出力する。'].join('\n') },
      { role: 'user', content: [...this.contextLines(ctx),
        `## 物の名前\n${(ctx.items || []).join(', ') || 'なし'}`,
        `## チェスト\n${chestLine.join('\n') || 'なし'}`,
        '提案を JSON で。'].filter(Boolean).join('\n') },
    ];
  }

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
    try { r = await this.llm.complete(messages, schema, kind === 'propose' ? { maxTokens: 160 } : undefined); } catch (e) { error = e.message; }
    const ms = Date.now() - t0;
    let say = '';
    if (r) { const m = r.text.match(/"say"\s*:\s*"([^"]*)/); say = m ? m[1].trim() : ''; }
    const rec = { kind, promptChars, promptTokens: r ? r.promptTokens : null, completionTokens: r ? r.completionTokens : null, ms, error, rawOutput: r ? r.text : null, say };
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

function proposeSchema(ctx) {
  const chests = ['', ...(ctx.chests || []).map((c) => c.id), ...(ctx.hereChest ? ['here'] : [])];
  return { type: 'object', properties: {
    kind: { type: 'string', enum: ['rule', 'project', 'other'] },
    item: { type: 'string', enum: ['', ...new Set(ctx.items || [])] },
    chest: { type: 'string', enum: [...new Set(chests)] },
    count: { type: 'integer', minimum: 1, maximum: 64 },
    say: { type: 'string', maxLength: 60 },
  }, required: ['kind', 'item', 'chest', 'count', 'say'], additionalProperties: false };
}

// 2B の出力 → { spec: { type: rule|project|text, item, chest, count }, text } | null。
//   rule は物とチェストが両方あるときだけ構造にする (chest: here は agent が共有にしてから id に置き換える)。project は物があるとき。ほかは文だけ
function parseProposal(text, ctx = {}) {
  let o = null;
  try { const s = String(text); o = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)); } catch (_) { return null; }
  const say = typeof o.say === 'string' ? o.say.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
  if (!say) return null;
  const items = new Set(ctx.items || []);
  const chests = new Set([...(ctx.chests || []).map((c) => c.id), ...(ctx.hereChest ? ['here'] : [])]);
  const item = typeof o.item === 'string' && items.has(o.item) ? o.item : '';
  const chest = typeof o.chest === 'string' && chests.has(o.chest) ? o.chest : '';
  if (o.kind === 'rule' && item && chest) return { spec: { type: 'rule', item, chest }, text: say };
  if (o.kind === 'project' && item) return { spec: { type: 'project', item, count: Math.max(1, Math.min(64, Math.floor(Number(o.count)) || 1)) }, text: say };
  return { spec: { type: 'text' }, text: say, kindAsked: o.kind || null };
}

module.exports = { PLACE_FACT, Talker, SAY_SCHEMA, proposeSchema, parseProposal };
