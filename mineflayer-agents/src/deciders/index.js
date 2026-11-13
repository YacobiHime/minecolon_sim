'use strict';
// decider: observe の結果と行動の一覧を受け取り、1つ選んで引数を埋める部品。
//
//   interface Decider {
//     kind: string
//     decide(ctx) -> Promise<Decision>
//   }
//   ctx      = { persona, goal, obsText, memText, actions, raw, memory }
//   Decision = { action, arg, say, rawOutput, parseOk, repaired, error?, latencyMs,
//                promptChars, promptTokens?, completionTokens? }
//
// action / arg の妥当性の確認 (一覧との突き合わせ) は decider ではなく agent が共通で行う。
// Jev のような「選択肢から選ぶ」モデルは、ctx.actions の choices を平らにして渡せばよい。
const { LLMDecider } = require('./llm');
const { SplitDecider } = require('./split');
const { ScriptedDecider, RandomDecider } = require('./mock');
const { JevDecider } = require('./jev');

// deps = { meter, jevClient, llmOpts } (実行で共有するもの)
function createDecider(cfg = {}, overrides = {}, deps = {}) {
  const type = cfg.type || 'llm';
  // deps.llmOpts: 提供元を解決した opts (llm_provider.llmOptsFor(cfg, 'act'))。無ければ decider.llm (今まで通り)
  const llmOpts = { ...(deps.llmOpts || cfg.llm || {}), ...overrides };
  if (type === 'llm') return new LLMDecider(llmOpts);
  // 行動は Jev。発言は agent が Talker (2B) で作る
  if (type === 'jev') return new JevDecider({ ...(cfg.jev || {}), meter: deps.meter, client: deps.jevClient });
  if (type === 'split') {
    // 行動担当と会話担当を分ける (どちらも LLM。行動担当は Jev などに差し替える想定)
    return new SplitDecider({
      act: new LLMDecider({ ...llmOpts, ...(cfg.act || {}), allowSay: false }),
      talk: new LLMDecider({ ...llmOpts, ...(cfg.talk || {}), mode: 'talk' }),
      talkEvery: cfg.talkEvery,
    });
  }
  if (type === 'random') return new RandomDecider(cfg);
  if (type === 'scripted') return new ScriptedDecider(cfg.script || []);
  throw new Error(`unknown decider type: ${type}`);
}

module.exports = { createDecider, LLMDecider, SplitDecider, ScriptedDecider, RandomDecider, JevDecider };
