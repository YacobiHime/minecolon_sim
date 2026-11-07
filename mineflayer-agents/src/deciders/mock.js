'use strict';
// テストや比較用の decider (LLM を使わない)

// 決めた出力 (文字列 = LLM の生出力として parse する / オブジェクト = そのまま) を順に返す
class ScriptedDecider {
  constructor(script) {
    this.kind = 'scripted';
    this.script = script;
    this.i = 0;
  }

  async decide() {
    const { parseDecision } = require('../parse');
    const s = this.script[this.i % Math.max(this.script.length, 1)];
    this.i += 1;
    if (typeof s === 'string') {
      const p = parseDecision(s);
      return { rawOutput: s, ...(p.ok ? p.value : { action: null, arg: '', say: '' }), parseOk: p.ok, repaired: !!p.repaired, error: p.error, latencyMs: 0, promptChars: 0 };
    }
    return { rawOutput: JSON.stringify(s), action: s.action, arg: s.arg ?? '', say: s.say ?? '', parseOk: true, repaired: false, latencyMs: 0, promptChars: 0 };
  }
}

// 一覧から一様に選ぶ (比較の基準)。cfg.talkP (0〜1) があれば、その確率で「話す」(talkP = 1) を返す
// (Jev を使わずに 2B の発言の負荷を試すため。agent は Jev の talk と同じに扱う)
class RandomDecider {
  constructor(cfg = {}) {
    this.kind = 'random';
    this.rand = cfg.rand || Math.random;
    this.talkP = Number.isFinite(cfg.talkP) ? cfg.talkP : null;
  }

  async decide(ctx) {
    const acts = ctx.actions.filter((a) => a.name !== 'say');
    const a = acts[Math.floor(this.rand() * acts.length)];
    let arg = '';
    if (a.argType === 'choice') arg = a.choices[Math.floor(this.rand() * a.choices.length)].id;
    if (a.argType === 'number') arg = '2';
    const out = { rawOutput: null, action: a.name, arg, say: '', parseOk: true, repaired: false, latencyMs: 0, promptChars: 0 };
    if (this.talkP != null) out.talkP = this.rand() < this.talkP ? 1 : 0;
    return out;
  }
}

module.exports = { ScriptedDecider, RandomDecider };
