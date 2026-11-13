'use strict';
// Jev (TypeSafe System One) の窓口。提供元 (provider) を切り替えられる:
//   openrouter (既定): POST https://openrouter.ai/api/v1/systemone   キー OPENROUTER_API (か OPENROUTER_API_KEY) / /root/.config/openrouter.env
//   typesafe         : POST https://api.typesafe.ai/v1/systemone     キー TYPESAFE_API_KEY / /root/.config/typesafe.env
//   リクエストはどちらも { model, state, questions: { <名前>: { type: 'choice'|'score'|'noul', instructions, criteria } } }
//   レスポンス: { model, answers: { <名前>: { type, choice|score|noul, confidence?, probabilities?, legend? } }, usage: { input_tokens, output_tokens } }
//   OpenRouter はこれに id・provider ("TypeSafe")・usage.cost (US ドル) を足す。model は canonical 名 (typesafe/jev-1.14-20261014 など)。
//   モデル名: OpenRouter は jev-latest → ~typesafe/jev-latest に読み替える。版を固定するなら typesafe/jev-1.14。
// 答えの type が 'refusal' (値も確率も無い) のものは answers から外し、refusals に名前を残す (呼ぶ側は「答えが無い」として扱う)。
// 再試行: 429・529・502・503・524、402 のうち limit_source が in-flight 予算のもの (OpenRouter。Retry-After に従う)、接続の失敗。
//   402 の残高不足 (in-flight 予算以外) は再試行せず fatal を立てて返す (onFatal に登録した関数を呼ぶ。run.js が全員を止める)。
// 送る本文が LONG_CONTEXT_BYTES (32,000 バイト) を超えると OpenRouter は黙って long-context モード (遅く・精度が下がる) で走らせるので、
//   longContext: true と bodyBytes を返す (記録に残す)。
// キーはログ・記録・エラーの文に出さない。
const fs = require('fs');
const { sleep } = require('./util');

const LONG_CONTEXT_BYTES = 32000;

const JEV_PROVIDERS = {
  openrouter: {
    url: 'https://openrouter.ai/api/v1/systemone',
    urlEnv: 'OPENROUTER_SYSTEMONE_URL',
    envFile: '/root/.config/openrouter.env',
    envFileVar: 'OPENROUTER_ENV_FILE',
    keyVars: ['OPENROUTER_API', 'OPENROUTER_API_KEY'],
    // 環境変数の OPENROUTER_API_KEY はファイルより後に見る (シェルの設定に古いキーが残っていることがある。2026-11-06 に .bashrc の古いキーで 401)
    envLateVars: ['OPENROUTER_API_KEY'],
    // 任意のヘッダー (アプリの帰属。呼び出しには要らない)。公開のランキングに出さない
    headers: { 'X-OpenRouter-Title': 'minecolon_sim mineflayer-agents', 'X-OpenRouter-App-Visibility': 'hidden' },
  },
  typesafe: {
    url: 'https://api.typesafe.ai/v1/systemone',
    urlEnv: 'TYPESAFE_URL',
    envFile: '/root/.config/typesafe.env',
    envFileVar: 'TYPESAFE_ENV_FILE',
    keyVars: ['TYPESAFE_API_KEY'],
    headers: {},
  },
};
const DEFAULT_PROVIDER = 'openrouter';
const DEFAULT_URL = JEV_PROVIDERS.typesafe.url; // 前からの名前 (TypeSafe 直)

function jevProvider(name) {
  const p = JEV_PROVIDERS[name || DEFAULT_PROVIDER];
  if (!p) throw new Error(`Jev の提供元 "${name}" が分からない (${Object.keys(JEV_PROVIDERS).join(' | ')})`);
  return p;
}

// キーを読む: 環境変数 (keyVars の順。envLateVars は除く) → ファイル (envFileVar の環境変数か envFile) → 環境変数 (envLateVars)
function loadApiKey({ env = process.env, provider = 'typesafe', file } = {}) {
  const p = jevProvider(provider);
  const late = p.envLateVars || [];
  const fromEnv = (vars) => { for (const v of vars) if (env[v] && env[v].trim()) return env[v].trim(); return null; };
  const early = fromEnv(p.keyVars.filter((v) => !late.includes(v)));
  if (early) return early;
  const f = file || env[p.envFileVar] || p.envFile;
  try {
    const txt = fs.readFileSync(f, 'utf8');
    for (const v of p.keyVars) {
      const m = txt.match(new RegExp(`^\\s*(?:export\\s+)?${v}\\s*=\\s*["']?([^"'\\s]+)["']?\\s*$`, 'm'));
      if (m) return m[1];
    }
  } catch (_) { /* 無い・読めない */ }
  return fromEnv(late);
}

// 同時に投げる数を抑える (30人が一斉に呼ぶとレート制限にかかりやすい)
class Semaphore {
  constructor(n) { this.n = Math.max(1, n); this.q = []; this.active = 0; }
  async acquire() {
    if (this.active < this.n) { this.active += 1; return; }
    await new Promise((r) => this.q.push(r));
    this.active += 1;
  }
  release() { this.active -= 1; const r = this.q.shift(); if (r) r(); }
}

// レート制限の残りを示すヘッダがあれば拾う (公式の資料には名前が書かれていない)
function rateHeaders(res) {
  const out = {};
  try {
    if (res.headers && typeof res.headers.forEach === 'function') {
      res.headers.forEach((v, k) => { if (/ratelimit|rate-limit|retry-after/i.test(k)) out[k] = v; });
    }
  } catch (_) { /* ignore */ }
  return Object.keys(out).length ? out : null;
}

function headerGet(res, name) {
  try { return res.headers && res.headers.get ? res.headers.get(name) : null; } catch (_) { return null; }
}

// 本文の limit_source (OpenRouter の 402)。どこに入っていても拾う
function limitSource(text) {
  const m = String(text || '').match(/"limit_source"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}
const isInFlightBudget = (src) => !!src && /in[_-]?flight/i.test(src);

// 文の中のキーを消す
function redact(text, key) {
  let s = String(text ?? '');
  if (key) s = s.split(key).join('***');
  return s.replace(/(Bearer\s+)\S+/gi, '$1***').replace(/\b(sk-[A-Za-z0-9_-]{4})[A-Za-z0-9_*-]{6,}/g, '$1***');
}

// refusal の答えを外す。返り値 { answers, refusals: [名前] }
function splitRefusals(answers) {
  const out = {};
  const refusals = [];
  for (const [k, v] of Object.entries(answers || {})) {
    if (v && v.type === 'refusal') refusals.push(k);
    else out[k] = v;
  }
  return { answers: out, refusals };
}

// OpenRouter は TypeSafe 直の綴り jev-1.14.0 を読み替えない (400 "Model typesafe/jev-1.14.0 does not exist"、2026-11-06)。
// jev-X.Y.0 は typesafe/jev-X.Y に直す (jev-latest・jev-1.14・typesafe/... はそのまま通る)
function openrouterModel(provider, model) {
  if (provider !== 'openrouter') return model;
  const m = String(model).match(/^jev-(\d+\.\d+)\.0$/);
  return m ? `typesafe/jev-${m[1]}` : model;
}

const RETRY_STATUS =new Set([429, 502, 503, 524, 529]);

class JevClient {
  // opts: { provider, url, model, apiKey, providers: { <name>: { url, model } }, timeoutMs, maxRetries, maxConcurrent, fetch, sleep, env }
  constructor(opts = {}) {
    const env = opts.env || process.env;
    this.provider = opts.provider || DEFAULT_PROVIDER;
    const p = jevProvider(this.provider);
    const per = (opts.providers && opts.providers[this.provider]) || {};
    this.url = per.url || opts.url || env[p.urlEnv] || p.url;
    this.model = openrouterModel(this.provider, per.model || opts.model || 'jev-latest');
    this.headers = { ...p.headers, ...(per.headers || {}) };
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.maxRetries = opts.maxRetries ?? 4;
    this.maxRetryWaitMs = opts.maxRetryWaitMs ?? 30000;
    this.fetch = opts.fetch || globalThis.fetch;
    this.apiKey = opts.apiKey !== undefined ? opts.apiKey : loadApiKey({ env, provider: this.provider });
    this.sem = new Semaphore(opts.maxConcurrent ?? 8);
    this.sleep = opts.sleep || sleep;
    this.longContextBytes = opts.longContextBytes ?? LONG_CONTEXT_BYTES;
    this.fatal = null; // 残高不足など、続けられないエラー (立ったら以後は送らない)
    this.fatalListeners = [];
    this.longContextWarned = false;
  }

  get hasKey() { return !!this.apiKey; }
  get keyHint() { const p = jevProvider(this.provider); return `${p.keyVars.join(' / ')} を環境変数か ${p.envFile} に`; }

  onFatal(fn) { this.fatalListeners.push(fn); }

  setFatal(f) {
    if (this.fatal) return;
    this.fatal = f;
    for (const fn of this.fatalListeners) { try { fn(f); } catch (_) { /* ignore */ } }
  }

  // 返り値 { ok, answers, refusals, model, id, provider, via, usage:{input_tokens,output_tokens,cost?}|null, costUsd, ms (待ち行列を除く), queueMs,
  //          retries, rateLimited, status, error, fatal?, body, bodyBytes, longContext, limits }
  async ask(state, questions) {
    const body = JSON.stringify({ model: this.model, state, questions });
    const bodyBytes = Buffer.byteLength(body, 'utf8');
    const longContext = bodyBytes > this.longContextBytes;
    if (longContext && !this.longContextWarned) {
      this.longContextWarned = true;
      console.warn(`[jev] 送る本文が ${bodyBytes} バイト (> ${this.longContextBytes})。OpenRouter では long-context モード (遅く・精度が下がる) になる`);
    }
    const common = { via: this.provider, bodyBytes, longContext, body };
    let retries = 0;
    let rateLimited = 0;
    if (this.fatal) return { ok: false, fatal: true, status: this.fatal.status, error: this.fatal.error, ms: 0, queueMs: 0, retries, rateLimited, ...common };
    const t0 = Date.now();
    await this.sem.acquire();
    const queueMs = Date.now() - t0;
    const tq = Date.now();
    const fail = (x) => ({ ok: false, ms: Date.now() - tq, queueMs, retries, rateLimited, ...common, ...x });
    try {
      for (let attempt = 0; ; attempt++) {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), this.timeoutMs);
        let res;
        try {
          res = await this.fetch(this.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...this.headers, Authorization: `Bearer ${this.apiKey}` },
            body,
            signal: ac.signal,
          });
        } catch (e) {
          clearTimeout(timer);
          if (attempt < this.maxRetries) { retries += 1; await this.sleep(500 * 2 ** attempt); continue; }
          return fail({ error: `Jev 接続失敗: ${e.name === 'AbortError' ? 'timeout' : redact(e.message, this.apiKey)}` });
        }
        clearTimeout(timer);
        let errText = null;
        let retryable = RETRY_STATUS.has(res.status);
        if (res.status === 402) {
          try { errText = await res.text(); } catch (_) { errText = ''; }
          retryable = isInFlightBudget(limitSource(errText));
        }
        if (retryable) {
          if (res.status === 429 || res.status === 402) rateLimited += 1;
          if (attempt < this.maxRetries) {
            const ra = Number(headerGet(res, 'retry-after'));
            retries += 1;
            await this.sleep(Math.min(this.maxRetryWaitMs, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 500 * 2 ** attempt));
            continue;
          }
        }
        if (!res.ok) {
          if (errText == null) { try { errText = await res.text(); } catch (_) { errText = ''; } }
          const detail = redact(String(errText).slice(0, 300), this.apiKey);
          if (res.status === 402 && !retryable) {
            const error = `Jev (${this.provider}) HTTP 402: 残高 (クレジット) が足りない、またはキーの上限に達した。止める。${detail}`;
            this.setFatal({ status: 402, error, limitSource: limitSource(errText) });
            return fail({ status: 402, fatal: true, error });
          }
          return fail({ status: res.status, error: `Jev HTTP ${res.status}: ${detail}` });
        }
        const d = await res.json();
        const { answers, refusals } = splitRefusals(d.answers);
        const usage = d.usage || null;
        const costUsd = usage && Number.isFinite(usage.cost) ? usage.cost : null;
        return { ok: true, status: res.status, answers, refusals, model: d.model, id: d.id ?? null, provider: d.provider ?? null, usage, costUsd,
          ms: Date.now() - tq, queueMs, retries, rateLimited, limits: rateHeaders(res), ...common };
      }
    } finally {
      this.sem.release();
    }
  }
}

module.exports = { JevClient, loadApiKey, Semaphore, DEFAULT_URL, DEFAULT_PROVIDER, JEV_PROVIDERS, LONG_CONTEXT_BYTES, splitRefusals, limitSource, redact, openrouterModel };
