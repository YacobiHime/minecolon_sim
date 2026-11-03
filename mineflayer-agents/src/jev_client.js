'use strict';
// TypeSafe System One API (Jev) の窓口。POST https://api.typesafe.ai/v1/systemone
//   リクエスト: { model, state, questions: { <名前>: { type: 'choice'|'score'|'noul', instructions, criteria } } }
//   レスポンス: { model, answers: { <名前>: { type, choice|score|noul, confidence?, probabilities?, legend? } },
//                usage: { input_tokens, output_tokens } }
// 429 (レート制限) と 529 (混雑) は待って再試行する (retry-after があれば従う)。
// API キーは環境変数 TYPESAFE_API_KEY か、/root/.config/typesafe.env の TYPESAFE_API_KEY=... から読む。
// キーはログ・記録・エラーの文に出さない。
const fs = require('fs');
const { sleep } = require('./util');

const DEFAULT_URL = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_ENV_FILE = '/root/.config/typesafe.env';

function loadApiKey({ env = process.env, file = env.TYPESAFE_ENV_FILE || DEFAULT_ENV_FILE } = {}) {
  if (env.TYPESAFE_API_KEY) return env.TYPESAFE_API_KEY.trim();
  try {
    const txt = fs.readFileSync(file, 'utf8');
    const m = txt.match(/^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*["']?([^"'\s]+)["']?\s*$/m);
    return m ? m[1] : null;
  } catch (_) {
    return null;
  }
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

class JevClient {
  constructor(opts = {}) {
    this.url = opts.url || process.env.TYPESAFE_URL || DEFAULT_URL;
    this.model = opts.model || 'jev-latest';
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.maxRetries = opts.maxRetries ?? 4;
    this.fetch = opts.fetch || globalThis.fetch;
    this.apiKey = opts.apiKey !== undefined ? opts.apiKey : loadApiKey();
    this.sem = new Semaphore(opts.maxConcurrent ?? 8);
    this.sleep = opts.sleep || sleep;
  }

  get hasKey() { return !!this.apiKey; }

  // 返り値 { ok, answers, model, usage:{input_tokens,output_tokens}|null, ms (待ち行列を除く), queueMs, retries, rateLimited, status, error, body }
  async ask(state, questions) {
    const body = JSON.stringify({ model: this.model, state, questions });
    let retries = 0;
    let rateLimited = 0;
    const t0 = Date.now();
    await this.sem.acquire();
    const queueMs = Date.now() - t0;
    const tq = Date.now();
    try {
      for (let attempt = 0; ; attempt++) {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), this.timeoutMs);
        let res;
        try {
          res = await this.fetch(this.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
            body,
            signal: ac.signal,
          });
        } catch (e) {
          clearTimeout(timer);
          if (attempt < this.maxRetries) { retries += 1; await this.sleep(500 * 2 ** attempt); continue; }
          return { ok: false, error: `Jev 接続失敗: ${e.name === 'AbortError' ? 'timeout' : e.message}`, ms: Date.now() - tq, queueMs, retries, rateLimited, body };
        }
        clearTimeout(timer);
        if (res.status === 429 || res.status === 529) {
          if (res.status === 429) rateLimited += 1;
          if (attempt < this.maxRetries) {
            const ra = Number(res.headers && res.headers.get ? res.headers.get('retry-after') : NaN);
            retries += 1;
            await this.sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 500 * 2 ** attempt);
            continue;
          }
        }
        if (!res.ok) {
          let detail = '';
          try { detail = (await res.text()).slice(0, 300); } catch (_) { /* ignore */ }
          return { ok: false, status: res.status, error: `Jev HTTP ${res.status}: ${detail}`, ms: Date.now() - tq, queueMs, retries, rateLimited, body };
        }
        const d = await res.json();
        return { ok: true, status: res.status, answers: d.answers || {}, model: d.model, usage: d.usage || null, ms: Date.now() - tq, queueMs, retries, rateLimited, body, limits: rateHeaders(res) };
      }
    } finally {
      this.sem.release();
    }
  }
}

module.exports = { JevClient, loadApiKey, Semaphore, DEFAULT_URL };
