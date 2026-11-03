'use strict';
// 発言を作る 2B (Gemma 4 E2B、llama-server)。行動は Jev が決め、話すべきとき (Jev の Noul が閾値を超えたとき)
// と、人に聞かれて答えるときだけ呼ぶ。呼び出しの回数とプロンプトの長さを UsageMeter と記録に残す。
const { LLMDecider } = require('./deciders/llm');

const SAY_SCHEMA = { type: 'object', properties: { say: { type: 'string', maxLength: 60 } }, required: ['say'], additionalProperties: false };

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

  // 話す内容を作る。ctx = { persona, goal, socialText, nearText, heardText, memText, plannedAction }
  talkMessages(ctx) {
    return [
      { role: 'system', content: [...personaLines(ctx.persona), `目標: ${ctx.goal.text}`,
        '近くの人に話しかける。短い日本語(30字以内)で、自分の気持ちと関係に合った言い方にする。JSON {"say":"..."} だけを出力する。'].join('\n') },
      { role: 'user', content: [
        `## 気持ちと人間関係\n${ctx.socialText || 'なし'}`,
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
        '人に聞かれたことに答える。下の「覚えていること」に書いてあることだけを使い、短い日本語(40字以内)で答える。',
        '書いていないことは言わない。答えが分からなければ「分からない」と言う。JSON {"say":"..."} だけを出力する。'].join('\n') },
      { role: 'user', content: `## ${ctx.from}さんの質問\n${ctx.question}\n## 覚えていること\n${ctx.memories.map((m) => `- ${m.text}`).join('\n')}\n答えを JSON で。` },
    ];
  }

  async run(kind, messages) {
    const promptChars = messages.reduce((s, m) => s + m.content.length, 0);
    const t0 = Date.now();
    let r = null;
    let error = null;
    try { r = await this.llm.complete(messages, SAY_SCHEMA); } catch (e) { error = e.message; }
    const ms = Date.now() - t0;
    let say = '';
    if (r) { const m = r.text.match(/"say"\s*:\s*"([^"]*)/); say = m ? m[1].trim() : ''; }
    const rec = { kind, promptChars, promptTokens: r ? r.promptTokens : null, completionTokens: r ? r.completionTokens : null, ms, error, rawOutput: r ? r.text : null, say };
    if (this.meter) this.meter.addTwoB(rec);
    return rec;
  }

  talk(ctx) { return this.run('talk', this.talkMessages(ctx)); }
  answer(ctx) { return this.run('answer', this.answerMessages(ctx)); }
}

module.exports = { Talker, SAY_SCHEMA };
