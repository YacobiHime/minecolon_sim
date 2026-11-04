'use strict';
// 使用量の記録: Jev (入力の文字数・トークン数・応答時間) と 2B (呼び出し回数・プロンプトの長さ)。
// 1回の実行 (run.js の1プロセス = 全エージェント) で1つを共有し、Jev の入力トークンの上限を持つ。
// 上限を超えたら exceeded を立てる (エージェントはそれを見て止まる)。

const JEV_USD_PER_MTOK = 0.042; // 入力 100万トークンあたり (出力は無料。docs.typesafe.ai/models、2026-11-03 確認)

// レスポンスに使用量がないときの推定: CJK (かな・漢字など) は1文字1トークン、それ以外は4文字1トークン
function estimateTokens(text) {
  const s = String(text ?? '');
  let cjk = 0;
  for (const ch of s) if (/[　-鿿가-힯＀-￯]/.test(ch)) cjk += 1;
  const other = [...s].length - cjk;
  return cjk + Math.ceil(other / 4);
}

function emptyJev() {
  return { calls: 0, errors: 0, rateLimited: 0, retries: 0, inputChars: 0, inputTokens: 0, estimatedCalls: 0, outputTokens: 0, ms: 0, questions: 0,
    byStage: {}, decisions: 0, decisionCalls: 0, decisionInputTokens: 0 };
}

function emptyTwoB() {
  return { calls: 0, errors: 0, promptChars: 0, promptTokens: 0, completionTokens: 0, ms: 0, byKind: {} };
}

class UsageMeter {
  constructor(opts = {}) {
    this.maxJevInputTokens = opts.maxJevInputTokens ?? 3000000;
    this.jev = emptyJev();
    this.twoB = emptyTwoB();
    this.exceeded = false;
    this.listeners = [];
  }

  onExceeded(fn) { this.listeners.push(fn); }

  // r = { inputChars, inputTokens|null, outputTokens|null, ms, questions, error?, rateLimited?, retries? }
  addJev(r) {
    const j = this.jev;
    j.calls += 1;
    if (r.error) j.errors += 1;
    j.rateLimited += r.rateLimited || 0;
    j.retries += r.retries || 0;
    j.inputChars += r.inputChars || 0;
    const est = r.inputTokens == null;
    const tok = est ? estimateTokens(r.inputText || '') : r.inputTokens;
    if (est && !r.error) j.estimatedCalls += 1;
    if (!r.error || !est) j.inputTokens += tok; // 失敗した呼び出しで使用量が返らないものは数えない
    j.outputTokens += r.outputTokens || 0;
    j.ms += r.ms || 0;
    j.questions += r.questions || 0;
    // 1回目 (行動の分類まで) / 2回目 (対象を選ぶ) の別
    const st = (j.byStage[r.stage || 1] = j.byStage[r.stage || 1] || { calls: 0, inputChars: 0, inputTokens: 0 });
    st.calls += 1;
    st.inputChars += r.inputChars || 0;
    if (!r.error || !est) st.inputTokens += tok;
    if (!this.exceeded && j.inputTokens >= this.maxJevInputTokens) {
      this.exceeded = true;
      for (const fn of this.listeners) { try { fn(this.summary()); } catch (_) { /* ignore */ } }
    }
    return { inputTokens: tok, estimated: est };
  }

  // 1判断 (1つの行動を決めるまで) の呼び出し数と入力トークン。r = { calls, inputTokens }
  addDecision(r) {
    const j = this.jev;
    j.decisions += 1;
    j.decisionCalls += r.calls || 0;
    j.decisionInputTokens += r.inputTokens || 0;
  }

  // r = { kind: 'talk'|'answer'|'act', promptChars, promptTokens|null, completionTokens|null, ms, error? }
  addTwoB(r) {
    const t = this.twoB;
    t.calls += 1;
    if (r.error) t.errors += 1;
    t.promptChars += r.promptChars || 0;
    t.promptTokens += r.promptTokens || 0;
    t.completionTokens += r.completionTokens || 0;
    t.ms += r.ms || 0;
    const k = (t.byKind[r.kind || 'other'] = t.byKind[r.kind || 'other'] || { calls: 0, promptChars: 0, promptTokens: 0, ms: 0 });
    k.calls += 1;
    k.promptChars += r.promptChars || 0;
    k.promptTokens += r.promptTokens || 0;
    k.ms += r.ms || 0;
  }

  summary() {
    const j = this.jev;
    return {
      jev: { ...j, avgInputTokens: j.calls ? Math.round(j.inputTokens / j.calls) : 0,
        callsPerDecision: j.decisions ? Number((j.decisionCalls / j.decisions).toFixed(3)) : null,
        inputTokensPerDecision: j.decisions ? Math.round(j.decisionInputTokens / j.decisions) : null, avgMs: j.calls ? Math.round(j.ms / j.calls) : 0, costUsd: Number(((j.inputTokens / 1e6) * JEV_USD_PER_MTOK).toFixed(6)), maxInputTokens: this.maxJevInputTokens, exceeded: this.exceeded },
      twoB: { ...this.twoB, avgPromptChars: this.twoB.calls ? Math.round(this.twoB.promptChars / this.twoB.calls) : 0 },
    };
  }
}

// 複数のプロセス (run.js --procs) の summary() を1つにまとめる。数は足し、平均・費用は足した数から出し直す
function mergeUsageSummaries(list, { maxInputTokens = null } = {}) {
  const jev = emptyJev();
  const twoB = emptyTwoB();
  let exceeded = false;
  const addInto = (dst, src) => { for (const [k, v] of Object.entries(src || {})) if (typeof v === 'number' && typeof dst[k] === 'number') dst[k] += v; };
  for (const u of list.filter(Boolean)) {
    const j = u.jev || {};
    addInto(jev, j);
    for (const [st, v] of Object.entries(j.byStage || {})) addInto((jev.byStage[st] = jev.byStage[st] || { calls: 0, inputChars: 0, inputTokens: 0 }), v);
    exceeded = exceeded || !!j.exceeded;
    const t = u.twoB || {};
    addInto(twoB, t);
    for (const [k, v] of Object.entries(t.byKind || {})) addInto((twoB.byKind[k] = twoB.byKind[k] || { calls: 0, promptChars: 0, promptTokens: 0, ms: 0 }), v);
  }
  const m = new UsageMeter({ maxJevInputTokens: maxInputTokens ?? Math.max(0, ...list.filter(Boolean).map((u) => (u.jev && u.jev.maxInputTokens) || 0)) });
  m.jev = jev;
  m.twoB = twoB;
  m.exceeded = exceeded;
  return m.summary();
}

module.exports = { UsageMeter, estimateTokens, JEV_USD_PER_MTOK, mergeUsageSummaries };
