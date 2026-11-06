'use strict';
// 文を作る LLM の提供元 (provider) を切り替える。行動は Jev が選び、記憶とメンタルモデルはハーネスが持つ形はそのまま。
//   local: llama.cpp の llama-server (Gemma 4 E2B。OpenAI 互換の /v1/chat/completions)。今までの「2B」
//   luna : OpenAI の gpt-6-luna (Chat Completions)。API キーは /root/.config/luna.env の LUNA_API_KEY (無ければ OPENAI_API_KEY)
// config:
//   llm: { provider: 'local'|'luna',                         既定の提供元 (無ければ local)
//          roles: { goal, talk, reflect, answer, broadcast, act }, 役ごとの提供元 (無い役は provider)
//          providers: { local: {...}, luna: {...} },          下の PROVIDER_DEFAULTS を上書き
//          maxUsd: 上限 (US ドル。全員・全提供元の合計。超えたら止める) }
// 役: goal (ゴール選び・ゴールの案。goalpath/goalplan/selfgoal)、talk (近くの人への発言)、reflect (振り返り・方針)、
//     answer (聞かれたことへの答え)、broadcast (全体チャット・提案・【発見】)、act (decider llm/split の行動選び)
// API キーは表示・ログ・記録に出さない (エラーの文からも消す)。
const fs = require('fs');

const ROLES = ['goal', 'talk', 'reflect', 'answer', 'broadcast', 'act'];
// talker の kind → 役
const KIND_ROLE = { talk: 'talk', answer: 'answer', broadcast: 'broadcast', propose: 'broadcast', report_find: 'broadcast' };

// 料金は 100万トークンあたりの US ドル。分からないときは null (= 未設定。費用は 0 として数え、記録に「未設定」と残す)
const PROVIDER_DEFAULTS = {
  local: {
    apiStyle: 'llamacpp', // llama-server: max_tokens・json_schema (文法で縛る)・timings (処理時間)
    baseUrl: 'http://127.0.0.1:18081',
    model: 'gemma-4-e2b',
    ctxTokens: 8192, // 1スロットの文脈 (llama-server の -c ÷ -np)。promptfit の上限
    structured: 'json_schema', // json_schema | json_schema_strict (OpenAI 向けに直した schema) | json_object | none
    tokenParam: 'max_tokens',
    reasoningEffort: null,
    maxConcurrent: 0, // 0 = 抑えない (llama-server の -np が待ち行列になる)
    maxRetries: 0,
    timeoutMs: 60000,
    requireKey: false,
    pricing: { inputPerMTok: 0, cachedInputPerMTok: 0, outputPerMTok: 0, source: '自前の GPU (費用 0)' },
  },
  luna: {
    apiStyle: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-6-luna',
    // 文脈は 1,050,000 (入力の上限 922,000) だが、入力が 272K を超えると料金が上がる (入力 2倍・出力 1.5倍) ので、その手前までに抑える
    ctxTokens: 272000,
    structured: 'json_schema_strict',
    tokenParam: 'max_completion_tokens',
    // 推論の量。none | low | medium (モデルの既定) | high | xhigh | max。推論のトークンは出力の上限 (max_completion_tokens) を使うので、
    // none 以外では reasoningExtraTokens を出力の上限に足す。短い発言を作るだけなので既定は none (速い・安い)
    reasoningEffort: 'none',
    reasoningExtraTokens: 2048,
    maxConcurrent: 8, // 1プロセスの中で同時に投げる数 (--procs P なら全体で P 倍)
    maxRetries: 4, // 429・5xx・接続の失敗で待って再試行する回数
    timeoutMs: 60000,
    requireKey: true,
    apiKeyFile: '/root/.config/luna.env',
    apiKeyVars: ['LUNA_API_KEY', 'OPENAI_API_KEY'],
    // https://developers.openai.com/api/docs/models/gpt-6-luna (2026-11-06 確認): 入力 $0.10・キャッシュ済み入力 $0.01・出力 $0.50 / 100万トークン。
    // 入力が 272K トークンを超える呼び出しは入力 2倍・出力 1.5倍。推論のトークンは出力として数える (completion_tokens に含まれる)
    pricing: { inputPerMTok: 0.10, cachedInputPerMTok: 0.01, outputPerMTok: 0.50, longContext: { overTokens: 272000, inputMult: 2, outputMult: 1.5 },
      source: 'developers.openai.com/api/docs/models/gpt-6-luna (2026-11-06)' },
  },
};

// 接続の欄 (local 以外の役では decider.llm のこれらを使わない。decider.llm.baseUrl は local の窓口なので)
const CONN_KEYS = ['baseUrl', 'model', 'apiKey', 'apiStyle', 'structured', 'tokenParam', 'reasoningEffort', 'reasoningExtraTokens', 'maxConcurrent', 'maxRetries',
  'requireKey', 'apiKeyFile', 'apiKeyVars', 'pricing', 'ctxTokens', 'sendTemperature'];

function readEnvFile(file, names) {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    for (const n of names) {
      const m = txt.match(new RegExp(`^\\s*(?:export\\s+)?${n}\\s*=\\s*["']?([^"'\\s]+)["']?\\s*$`, 'm'));
      if (m) return m[1];
    }
  } catch (_) { /* 無い・読めない */ }
  return null;
}

// キーを読む: 環境変数 (LUNA_API_KEY → OPENAI_API_KEY) → ファイル (LUNA_ENV_FILE か apiKeyFile)
function loadProviderKey(p, { env = process.env } = {}) {
  const vars = p.apiKeyVars || [];
  for (const v of vars) if (env[v] && env[v].trim()) return env[v].trim();
  const file = env.LUNA_ENV_FILE || p.apiKeyFile;
  return file ? readEnvFile(file, vars) : null;
}

function providerConfig(llmCfg, name) {
  const L = llmCfg || {};
  const d = PROVIDER_DEFAULTS[name];
  const user = (L.providers && L.providers[name]) || {};
  if (!d && !Object.keys(user).length) throw new Error(`LLM の提供元 "${name}" が分からない (local か luna、または llm.providers.${name} を書く)`);
  const base = d || PROVIDER_DEFAULTS[user.apiStyle === 'llamacpp' ? 'local' : 'luna'];
  return { ...base, ...user, pricing: { ...(base.pricing || {}), ...(user.pricing || {}) }, name };
}

function providerFor(cfg, role) {
  const L = (cfg && cfg.llm) || {};
  return (L.roles && L.roles[role]) || L.provider || 'local';
}

// 役 role の LLMDecider に渡す opts。extra: その役の設定 (cfg.goalPath.llm など。maxTokens・temperature)
//   local: 既定 < decider.llm < llm.providers.local < extra (今までと同じ。decider.llm.baseUrl・--llm が効く)
//   ほか : 既定 < decider.llm の接続以外 < llm.providers.<name> < extra の接続以外
function llmOptsFor(cfg, role, extra = {}) {
  const name = providerFor(cfg, role);
  const p = providerConfig(cfg && cfg.llm, name);
  const dl = (cfg && cfg.decider && cfg.decider.llm) || {};
  const strip = (o) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => !CONN_KEYS.includes(k)));
  const userP = (cfg && cfg.llm && cfg.llm.providers && cfg.llm.providers[name]) || {};
  if (name === 'local') return { ...p, ...dl, ...userP, pricing: p.pricing, ...(extra || {}), provider: name, role };
  return { ...p, ...strip(dl), ...strip(extra), provider: name, role };
}

// 使う提供元すべての API キーを確かめる。返り値 [{ provider, roles, ok, error? }]
function checkKeys(cfg, { env = process.env } = {}) {
  const used = {};
  for (const r of ROLES) (used[providerFor(cfg, r)] = used[providerFor(cfg, r)] || []).push(r);
  return Object.entries(used).map(([name, roles]) => {
    const p = providerConfig(cfg && cfg.llm, name);
    if (!p.requireKey || p.apiKey) return { provider: name, roles, ok: true };
    const k = loadProviderKey(p, { env });
    return k ? { provider: name, roles, ok: true }
      : { provider: name, roles, ok: false, error: `${name} の API キーがない (${(p.apiKeyVars || []).join(' / ')} を環境変数か ${env.LUNA_ENV_FILE || p.apiKeyFile} に)` };
  });
}

// 1回の呼び出しの費用。usage = { promptTokens, cachedTokens, completionTokens }
function costOf(pricing, u) {
  if (!pricing || pricing.inputPerMTok == null || pricing.outputPerMTok == null) return { usd: 0, priced: false };
  const prompt = u.promptTokens || 0;
  const cached = Math.min(prompt, u.cachedTokens || 0);
  const lc = pricing.longContext;
  const long = lc && prompt > lc.overTokens;
  const im = long ? lc.inputMult || 1 : 1;
  const om = long ? lc.outputMult || 1 : 1;
  const cachedRate = pricing.cachedInputPerMTok ?? pricing.inputPerMTok;
  const usd = (((prompt - cached) * pricing.inputPerMTok + cached * cachedRate) * im + (u.completionTokens || 0) * pricing.outputPerMTok * om) / 1e6;
  return { usd, priced: true };
}

// 文の中のキーらしきものを消す (サーバーのエラーの文に部分が入ることがある)
function redact(text, key) {
  let s = String(text ?? '');
  if (key) s = s.split(key).join('***');
  return s.replace(/\b(sk-[A-Za-z0-9_-]{4})[A-Za-z0-9_*-]{6,}/g, '$1***').replace(/(Bearer\s+)\S+/gi, '$1***');
}

// OpenAI の strict な構造化出力に通る形に直す。strict で使えないことがあるキーワード (文字列の長さ) を外し、
// object にはすべての property を required・additionalProperties: false にする。根が anyOf なら {value: anyOf} に包まない (呼ぶ側が object を渡す)
const DROP_KEYS = new Set(['minLength', 'maxLength']);
function strictSchema(s) {
  if (Array.isArray(s)) return s.map(strictSchema);
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (DROP_KEYS.has(k)) continue;
    if (k === 'properties') out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, strictSchema(pv)]));
    else if (k === 'anyOf' || k === 'items' || k === 'oneOf' || k === 'allOf') out[k] = strictSchema(v);
    else out[k] = v;
  }
  if (out.type === 'object' && out.properties) {
    out.required = Object.keys(out.properties);
    out.additionalProperties = false;
  }
  return out;
}

module.exports = { ROLES, KIND_ROLE, PROVIDER_DEFAULTS, CONN_KEYS, loadProviderKey, providerConfig, providerFor, llmOptsFor, checkKeys, costOf, redact, strictSchema, readEnvFile };
