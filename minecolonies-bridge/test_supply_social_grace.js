const assert = require("assert");
const { socialHelpGraceRemaining } = require("./supply_bot.js");

const observed = new Map();
assert.strictEqual(socialHelpGraceRemaining(observed, 14, 1000, 20000), 20000);
assert.strictEqual(socialHelpGraceRemaining(observed, 14, 6000, 20000), 15000);
assert.strictEqual(socialHelpGraceRemaining(observed, 14, 21000, 20000), 0);
assert.strictEqual(socialHelpGraceRemaining(new Map(), 14, 1000, 0), 0);

console.log("ALL PASS (supply social-help grace)");
