'use strict';
// record: 1ループ = JSONL の1行 (runs/ は .gitignore)
const fs = require('fs');
const path = require('path');

class Recorder {
  constructor(dir, name) {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    this.file = path.join(dir, `${name}-${stamp}.jsonl`);
    this.stream = fs.createWriteStream(this.file, { flags: 'a' });
  }

  write(obj) {
    this.stream.write(JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n');
  }

  close() { return new Promise((r) => this.stream.end(r)); }
}

module.exports = { Recorder };
