'use strict';
// GovSim 型の記憶 (mental off / on で同じものを使う)。
//   元: simulation/persona/memory/associative_memory.py と cognition/retrieve.py。
//   元の取り出しは 新しさ (0.99^i × 0.5) + 大事さ (LLM が 1〜10 で採点、×3) + 関連 (埋め込みの cos、×2) の和の上位 k 件。
//   ここは「新しさだけ」に簡単にした (LLM の採点と埋め込みを使わない)。always (必ず入れる) の項目は元と同じく先に入れる。
//   期限 (expiration) を過ぎた項目は取り出さない。話し合いの記録 (chat) は元と同じく取り出しの対象にしない。
//   取り出した項目は作られた順 (古い順) に並べる (元と同じ)。
const DAY = 24 * 3600 * 1000;

class GovMemory {
  constructor({ expirationDays = 63 } = {}) {
    this.items = []; // { id, created: Date, text, kind: 'event'|'thought'|'chat', always, expiration: Date }
    this.expirationDays = expirationDays;
    this.seq = 0;
  }

  add(kind, text, created, { always = false, expiration = null } = {}) {
    const it = { id: this.seq++, kind, text: String(text), created: new Date(created), always: !!always,
      expiration: expiration ? new Date(expiration) : new Date(new Date(created).getTime() + this.expirationDays * DAY) };
    this.items.push(it);
    return it;
  }

  addEvent(text, created, expiration, always = true) { return this.add('event', text, created, { always, expiration }); }
  addThought(text, created, { always = false } = {}) { return this.add('thought', text, created, { always }); }
  addChat(summary, created) { return this.add('chat', summary, created, {}); }

  // now 時点の上位 k 件 (古い順)
  retrieve(now, k = 10) {
    const t = new Date(now).getTime();
    const live = this.items.filter((x) => x.kind !== 'chat' && x.expiration.getTime() > t);
    const sorted = [...live].sort((a, b) => (b.always - a.always) || (b.created - a.created) || (b.id - a.id));
    return sorted.slice(0, k).sort((a, b) => (a.created - b.created) || (a.id - b.id));
  }
}

module.exports = { GovMemory, DAY };
