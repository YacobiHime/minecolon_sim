'use strict';
// 会話担当と行動担当を分ける構成。act が行動を選び、talk が (talkEvery 回に1回、
// または誰かの発言が聞こえたとき) 話す内容を決める。両者は並行に呼ぶ。
class SplitDecider {
  constructor({ act, talk, talkEvery = 3 }) {
    this.kind = `split(${act.kind}+${talk.kind})`;
    this.act = act;
    this.talk = talk;
    this.talkEvery = talkEvery;
    this.n = 0;
  }

  async decide(ctx) {
    this.n += 1;
    const wantTalk = (ctx.raw && ctx.raw.heard && ctx.raw.heard.length > 0) || this.n % this.talkEvery === 0;
    const t0 = Date.now();
    const [a, t] = await Promise.all([
      this.act.decide(ctx),
      wantTalk ? this.talk.decide(ctx) : Promise.resolve(null),
    ]);
    return {
      ...a,
      say: t ? t.say : '',
      talk: t ? { rawOutput: t.rawOutput, latencyMs: t.latencyMs, promptChars: t.promptChars } : null,
      latencyMs: Date.now() - t0,
    };
  }
}

module.exports = { SplitDecider };
