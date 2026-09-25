const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Q = require("./social_action_queue.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "social-actions-test-"));
const file = path.join(dir, "actions.jsonl");

Q.appendAction({ type: "help_succeeded", helperId: 1, recipientId: 2 }, file, "t1");
const first = Q.readActions(0, file);
assert.strictEqual(first.events.length, 1);
assert.strictEqual(first.events[0].ts, "t1");
assert.strictEqual(first.nextOffset, fs.statSync(file).size);

Q.appendAction({ type: "help_refused", helperId: 3, recipientId: 4 }, file, "t2");
const second = Q.readActions(first.nextOffset, file);
assert.strictEqual(second.events.length, 1);
assert.strictEqual(second.events[0].helperId, 3);
assert.strictEqual(second.nextOffset, fs.statSync(file).size);

const bounded = Q.readActions(0, file, first.nextOffset);
assert.strictEqual(bounded.events.length, 1);
assert.strictEqual(bounded.nextOffset, first.nextOffset);

const none = Q.readActions(second.nextOffset, file);
assert.deepStrictEqual(none.events, []);
assert.strictEqual(none.nextOffset, second.nextOffset);

fs.appendFileSync(file, "{\"partial\":");
const partial = Q.readActions(second.nextOffset, file);
assert.deepStrictEqual(partial.events, []);
assert.strictEqual(partial.nextOffset, second.nextOffset);

fs.rmSync(dir, { recursive: true, force: true });
console.log("ALL PASS (social action queue)");
