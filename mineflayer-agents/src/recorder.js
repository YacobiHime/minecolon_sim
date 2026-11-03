'use strict';
// record: 1ループ = JSONL の1行 (runs/ は .gitignore)
const fs = require('fs');
const path = require('path');

class Recorder {
  // stamp を渡すと、同じ実行の全員のファイルに同じ時刻が付く
  constructor(dir, name, stamp = null) {
    fs.mkdirSync(dir, { recursive: true });
    stamp = stamp || new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    this.file = path.join(dir, `${name}-${stamp}.jsonl`);
    this.stream = fs.createWriteStream(this.file, { flags: 'a' });
  }

  write(obj) {
    if (this.closed) return;
    this.stream.write(JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n');
  }

  close() { this.closed = true; return new Promise((r) => this.stream.end(r)); }
}

module.exports = { Recorder };
