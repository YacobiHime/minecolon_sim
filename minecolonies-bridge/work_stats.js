// work_stats.js - samples /status repeatedly and reports, per staffed
// building, how often its workers were actually observed "working".
// A single snapshot lies (commute/sleep/leisure moments), so this takes
// SAMPLES snapshots INTERVAL_MS apart and aggregates. Buildings whose
// workers were never working across the window are the "dead workplaces"
// worth investigating (missing animals/config/demand - see colony-diag).
//
// Usage: node work_stats.js [samples] [intervalMs]
const http = require("http");

const SAMPLES = parseInt(process.argv[2] || "12", 10);
const INTERVAL_MS = parseInt(process.argv[3] || "20000", 10);
// Brief mode (WORK_STATS_BRIEF=1): print ONE machine-parseable line instead of
// the human report, so colony_watch.sh can grep the idle count out cheaply:
//   BRIEF total=<workplaces> idle=<ratio<0.2 count> <type@x,z> <type@x,z> ...
const BRIEF = process.env.WORK_STATS_BRIEF === "1";

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "localhost", port: 8089, path, method: "GET" },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve(d));
      }
    );
    req.on("error", reject);
    req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Buildings with no worker role - not "workplaces" at all.
const NO_WORKER = new Set([
  "blockhutcitizen", "blockhuttownhall", "blockhutwarehouse", "blockhuttavern",
  "blockpostbox", "blockhutgraveyard", "blockhutmysticalsite",
]);

// The single "is this citizen actually producing right now?" heuristic, shared
// with supply_bot.js's boot-time taper (production detection). A worker in the
// "working" jobStatus is on the job (not commuting/sleeping/eating/idle); a
// single snapshot is noisy, so callers aggregate it over a window.
function isCitizenWorking(c) {
  return !!c && c.jobStatus === "working";
}

async function main() {
  // key: "type@x,z" -> { type, pos, workerSamples, workingSamples, statuses: {status: n}, citizens:Set }
  const acc = new Map();
  for (let s = 0; s < SAMPLES; s++) {
    const colonies = JSON.parse(await get("/status"));
    for (const colony of colonies) {
      const byId = new Map(colony.citizens.map((c) => [c.id, c]));
      for (const b of colony.buildings) {
        if (NO_WORKER.has(b.type) || !b.operational || !(b.workers || []).length) continue;
        const key = `${b.type}@${b.x},${b.z}`;
        if (!acc.has(key)) {
          acc.set(key, { type: b.type, pos: `${b.x},${b.y},${b.z}`, level: b.level,
            workerSamples: 0, workingSamples: 0, statuses: {}, citizens: new Set() });
        }
        const a = acc.get(key);
        for (const id of b.workers) {
          const c = byId.get(id);
          if (!c) continue;
          a.workerSamples++;
          a.citizens.add(id);
          a.statuses[c.jobStatus] = (a.statuses[c.jobStatus] || 0) + 1;
          if (isCitizenWorking(c)) a.workingSamples++;
        }
      }
    }
    if (s < SAMPLES - 1) await sleep(INTERVAL_MS);
    process.stderr.write(`sample ${s + 1}/${SAMPLES}\r`);
  }

  const rows = [...acc.values()].map((a) => ({
    ...a,
    ratio: a.workerSamples ? a.workingSamples / a.workerSamples : 0,
  }));
  rows.sort((x, y) => x.ratio - y.ratio || x.type.localeCompare(y.type));

  if (BRIEF) {
    // "idle" = staffed workplace whose workers were working <20% of samples
    // (0% dead ones included). Detail lists type@x,z for each offender.
    const idle = rows.filter((r) => r.ratio < 0.2);
    const detail = idle
      .map((r) => {
        const [x, , z] = r.pos.split(",");
        return `${r.type.replace("blockhut", "")}@${x},${z}`;
      })
      .join(" ");
    console.log(`BRIEF total=${rows.length} idle=${idle.length} ${detail}`.trimEnd());
    return;
  }

  console.log(`\nwork activity over ${SAMPLES} samples x ${INTERVAL_MS / 1000}s`);
  const dead = rows.filter((r) => r.ratio === 0);
  const low = rows.filter((r) => r.ratio > 0 && r.ratio < 0.2);
  console.log(`workplaces: ${rows.length} | never-working: ${dead.length} | low(<20%): ${low.length}\n`);
  for (const r of [...dead, ...low]) {
    const st = Object.entries(r.statuses).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}:${v}`).join(" ");
    console.log(
      `${(r.ratio * 100).toFixed(0).padStart(3)}% ${r.type.replace("blockhut", "").padEnd(14)}` +
      ` lv${r.level} @(${r.pos}) workers[${[...r.citizens].join(",")}] ${st}`
    );
  }
}

// Only run the sampling CLI when invoked directly; when required as a module
// (supply_bot.js's taper reuses NO_WORKER / isCitizenWorking) do nothing.
if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { NO_WORKER, isCitizenWorking };
