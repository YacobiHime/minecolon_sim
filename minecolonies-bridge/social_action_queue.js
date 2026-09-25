// Append-only handoff between action daemons and the single dynamic-state
// writer (social_observer). Byte offsets make consumption crash-replayable.
const fs = require("fs");
const path = require("path");

const ACTION_FILE = process.env.SOCIAL_ACTION_FILE ||
  path.join(__dirname, "social_action_events.jsonl");

function appendAction(event, file, now) {
  const target = file || ACTION_FILE;
  const record = { ts: now || new Date().toISOString(), ...event };
  fs.appendFileSync(target, JSON.stringify(record) + "\n");
  return record;
}

function readActions(offset, file, endOffset) {
  const target = file || ACTION_FILE;
  const start = Number.isInteger(offset) && offset >= 0 ? offset : 0;
  if (!fs.existsSync(target)) return { events: [], nextOffset: start };
  const fileSize = fs.statSync(target).size;
  const size = Number.isInteger(endOffset) && endOffset >= 0
    ? Math.min(fileSize, endOffset) : fileSize;
  if (start > size) throw new Error(`social action offset ${start} exceeds file size ${size}`);
  if (start === size) return { events: [], nextOffset: size };
  const fd = fs.openSync(target, "r");
  try {
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    const completeLength = text.endsWith("\n") ? text.length : text.lastIndexOf("\n") + 1;
    if (completeLength <= 0) return { events: [], nextOffset: start };
    const complete = text.slice(0, completeLength);
    const events = complete.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    return { events, nextOffset: start + Buffer.byteLength(complete) };
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { ACTION_FILE, appendAction, readActions };
