// verify_suite.js - Facility verification suite, phase 1: audit what exists.
// One-shot: walks every registered building in the colony and grades it
// PASS / WARN / FAIL with a reason, so "all facilities work" stops being an
// impression and becomes a table. Phase 2 (place+build missing building
// types systematically) builds on the same checks.
//
// Usage: node verify_suite.js [--json out.json]
const http = require("http");

const BRIDGE_HOST = "localhost";
const BRIDGE_PORT = 8089;
const COLONY_ID = parseInt(process.env.COLONY_ID || "1", 10);

// Building types that have no assigned worker by design - grading them on
// staffing would be a false FAIL.
const NO_WORKER_TYPES = new Set([
  "blockhutcitizen", // residence
  "blockhuttownhall",
  "blockhutwarehouse", // staffed indirectly by couriers
  "blockhuttavern", // temporary housing, no job
  "blockpostbox",
  "blockhutgraveyard",
  "blockhutmysticalsite",
]);

// Known environment limits of this superflat world - a missing worker there
// is expected, not a regression.
const KNOWN_LIMITS = {
  blockhutminer: "superflat: no stone/ore layers, miner is a dead job here",
};

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: BRIDGE_HOST, port: BRIDGE_PORT, path, method: "GET" },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function main() {
  const status = JSON.parse((await get("/status")).body);
  const colony = status.find((c) => c.id === COLONY_ID);
  if (!colony) throw new Error(`colony ${COLONY_ID} not found`);
  const citizens = new Map(colony.citizens.map((c) => [c.id, c]));

  const results = [];
  for (const b of colony.buildings) {
    const key = `${b.type}@(${b.x},${b.y},${b.z})`;
    const r = { building: b.type, pos: [b.x, b.y, b.z], level: b.level };

    if (b.pending) {
      r.grade = "WARN";
      r.reason = "under construction (pending work order)";
      results.push(r);
      continue;
    }
    if (!b.operational) {
      r.grade = "FAIL";
      r.reason = "not operational";
      results.push(r);
      continue;
    }
    if (b.level === 0) {
      r.grade = "WARN";
      r.reason = "placed but never built (lv0)";
      results.push(r);
      continue;
    }
    if (NO_WORKER_TYPES.has(b.type)) {
      r.grade = "PASS";
      r.reason = "operational (no worker role)";
      results.push(r);
      continue;
    }

    const workers = (b.workers || []).map((id) => citizens.get(id)).filter(Boolean);
    if (workers.length === 0) {
      if (KNOWN_LIMITS[b.type]) {
        r.grade = "WARN";
        r.reason = `unstaffed - ${KNOWN_LIMITS[b.type]}`;
      } else if (
        colony.buildings.some(
          (o) => o !== b && o.type === b.type && (o.workers || []).length > 0
        )
      ) {
        // The suite verifies building TYPES work; an unstaffed duplicate of a
        // type that has a staffed sibling is spare capacity, not a failure
        // (e.g. 10 courier huts, 8 couriers - deliberate).
        r.grade = "WARN";
        r.reason = "surplus hut - type verified by a staffed sibling";
      } else {
        r.grade = "FAIL";
        r.reason = "operational but unstaffed (no worker assigned)";
      }
      results.push(r);
      continue;
    }

    // Staffed: grade on the workers' condition. jobStatus "idle" alone is
    // not failure (builders idle between orders), but sick/starving is.
    const bad = [];
    for (const w of workers) {
      if (w.sick) bad.push(`citizen ${w.id} sick (${w.disease})`);
      else if (w.saturation <= 2.5) bad.push(`citizen ${w.id} starving (sat ${w.saturation})`);
    }
    if (bad.length > 0) {
      r.grade = "FAIL";
      r.reason = bad.join("; ");
    } else {
      const working = workers.filter((w) => w.jobStatus === "working").length;
      r.grade = "PASS";
      r.reason = `staffed ${workers.length} (${working} actively working)`;
    }
    r.workers = workers.map((w) => ({ id: w.id, job: w.job, jobStatus: w.jobStatus }));
    results.push(r);
  }

  // Report
  const order = { FAIL: 0, WARN: 1, PASS: 2 };
  results.sort((a, b) => order[a.grade] - order[b.grade] || a.building.localeCompare(b.building));
  const counts = { PASS: 0, WARN: 0, FAIL: 0 };
  for (const r of results) counts[r.grade]++;
  console.log(`facility audit ${new Date().toISOString()} - colony ${COLONY_ID}`);
  console.log(`PASS ${counts.PASS} / WARN ${counts.WARN} / FAIL ${counts.FAIL} (total ${results.length})\n`);
  for (const r of results) {
    console.log(
      `${r.grade.padEnd(4)} ${r.building.replace(/^blockhut/, "").padEnd(14)} lv${r.level} @(${r.pos.join(",")}) - ${r.reason}`
    );
  }

  const jsonIdx = process.argv.indexOf("--json");
  if (jsonIdx !== -1 && process.argv[jsonIdx + 1]) {
    require("fs").writeFileSync(
      process.argv[jsonIdx + 1],
      JSON.stringify({ time: Date.now(), counts, results }, null, 2)
    );
  }
  process.exitCode = counts.FAIL > 0 ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
