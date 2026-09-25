// LLM "mayor" agent for the MineColonies experiment. It never connects to
// Minecraft at all (mineflayer can't - see README.md) - instead it polls the
// Voyager Bridge mod's HTTP API for colony status and decides what to do
// next (found a colony, place a building, grow population), entirely via
// curl-style HTTP calls into the same JVM the dedicated server runs in.
const https = require("https");
const http = require("http");

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = "openai/gpt-5";
const BRIDGE_HOST = "localhost";
const BRIDGE_PORT = 8089;
const MAX_TURNS = 20;
const TURN_DELAY_MS = 4000;

// Anchor point for this run - chosen away from world spawn so MineColonies'
// spawn-protection / min-distance-from-spawn checks don't reject placement.
const ANCHOR = { x: 10, y: -60, z: 10 };

const SYSTEM_PROMPT = `You are the autonomous mayor of a Minecraft MineColonies colony. You do not see the game directly - you only get a JSON status snapshot each turn, and you act by choosing ONE action as JSON. The actual construction (turning a placed hut block into a real building) is handled automatically by the colony's own builder NPCs once it has citizens - your job is to decide WHERE buildings go, how the colony grows, and to keep builders supplied when they get stuck, not to place blocks yourself.

Available actions (respond with exactly one JSON object, nothing else):
- {"action":"place","x":<int>,"y":<int>,"z":<int>,"block":"minecolonies:blockhut<type>"} - place a hut block (e.g. blockhuttownhall, blockhutwarehouse, blockhutcitizen, blockhutbuilder, blockhutforester, blockhutsawmill). Pick coordinates near the anchor (${ANCHOR.x},${ANCHOR.y},${ANCHOR.z}) but not overlapping existing buildings (leave a few blocks of gap). Remember the coordinates you used - you'll need them again for requestBuild/openRequests/resolveRequest on that same building.
- {"action":"found","x":<int>,"y":<int>,"z":<int>,"name":"<colony name>"} - found a colony on a town hall hut block you already placed at that exact position.
- {"action":"spawnCitizen","colonyId":<int>} - grow the colony's population by one.
- {"action":"requestBuild","x":<int>,"y":<int>,"z":<int>} - queue the actual construction work order for a hut block you placed. Placing a block alone does NOT start construction - you must call this once per building, otherwise builders never touch it. A Builder's Hut can only take on work orders up to its own current level, so build/level up the Builder's Hut itself before queuing others.
- {"action":"openRequests","x":<int>,"y":<int>,"z":<int>,"citizenId":<int>} - check what a citizen working at that building still needs (material name + whether it's a crafted "textured" decorative block). Most plain material requests resolve automatically; use this when a builder seems stuck.
- {"action":"resolveRequest","x":<int>,"y":<int>,"z":<int>,"citizenId":<int>} - fulfill that citizen's oldest open request at that building. For decorative "textured" blocks the citizen must already be holding the raw materials (see giveToCitizen) or this fails.
- {"action":"giveToCitizen","colonyId":<int>,"citizenId":<int>,"item":"minecraft:<item_id>","count":<int>} - hand raw materials/tools directly to a citizen (use stone/wood tier tools for low-level workers, never iron+ - they can't use it).
- {"action":"spawnCitizen","colonyId":<int>} - grow the colony's population by one.
- {"action":"wait"} - do nothing this turn (e.g. while waiting for the colony to develop).

Rules:
- You must found a colony (place a town hall + found) before placing any other building or spawning citizens.
- Only one town hall/colony is needed for this whole run.
- After placing any building, call requestBuild on it - otherwise it sits there forever unbuilt.
- Vary the hut types you place once the colony exists, to build out a small village.
- Respond with ONLY the JSON object, no explanation, no markdown fences.`;

function httpRequest(method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: BRIDGE_HOST, port: BRIDGE_PORT, path, method },
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

function askLLM(history) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ model: MODEL, messages: history });
    const req = https.request(
      {
        hostname: "openrouter.ai",
        path: "/api/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            const reply = parsed.choices?.[0]?.message?.content?.trim();
            if (reply) resolve(reply);
            else reject(new Error("No reply: " + data));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function parseAction(reply) {
  const match = reply.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON object found in reply: " + reply);
  return JSON.parse(match[0]);
}

async function getStatus() {
  const res = await httpRequest("GET", "/status");
  return JSON.parse(res.body);
}

async function runAction(action) {
  switch (action.action) {
    case "place": {
      const path = `/place?x=${action.x}&y=${action.y}&z=${action.z}&block=${encodeURIComponent(action.block)}`;
      return httpRequest("POST", path);
    }
    case "found": {
      const path = `/found?x=${action.x}&y=${action.y}&z=${action.z}&name=${encodeURIComponent(action.name || "VoyagerColony")}`;
      return httpRequest("POST", path);
    }
    case "spawnCitizen": {
      const path = `/spawnCitizen?colonyId=${action.colonyId}`;
      return httpRequest("POST", path);
    }
    case "requestBuild": {
      const path = `/requestBuild?x=${action.x}&y=${action.y}&z=${action.z}`;
      return httpRequest("POST", path);
    }
    case "openRequests": {
      const path = `/openRequests?x=${action.x}&y=${action.y}&z=${action.z}&citizenId=${action.citizenId}`;
      return httpRequest("GET", path);
    }
    case "resolveRequest": {
      const path = `/resolveRequest?x=${action.x}&y=${action.y}&z=${action.z}&citizenId=${action.citizenId}`;
      return httpRequest("POST", path);
    }
    case "giveToCitizen": {
      const path = `/giveToCitizen?colonyId=${action.colonyId}&citizenId=${action.citizenId}&item=${encodeURIComponent(action.item)}&count=${action.count}`;
      return httpRequest("POST", path);
    }
    case "wait":
      return { status: 200, body: '{"result":"waited"}' };
    default:
      throw new Error("Unknown action: " + JSON.stringify(action));
  }
}

async function main() {
  const history = [{ role: "system", content: SYSTEM_PROMPT }];

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const colonies = await getStatus();
    const userMsg = `[STATE] turn ${turn} | anchor ${ANCHOR.x},${ANCHOR.y},${ANCHOR.z} | colonies: ${JSON.stringify(colonies)}\nWhat is your next action?`;
    console.log(`\n--- turn ${turn} ---`);
    console.log(userMsg);
    history.push({ role: "user", content: userMsg });

    let reply;
    try {
      reply = await askLLM(history.slice(0, 1).concat(history.slice(-10)));
    } catch (e) {
      console.log("LLM error:", e.message);
      await sleep(TURN_DELAY_MS);
      continue;
    }
    console.log("LLM reply:", reply);
    history.push({ role: "assistant", content: reply });

    let action;
    try {
      action = parseAction(reply);
    } catch (e) {
      console.log("Failed to parse action:", e.message);
      await sleep(TURN_DELAY_MS);
      continue;
    }

    try {
      const res = await runAction(action);
      console.log("Bridge response:", res.status, res.body);
    } catch (e) {
      console.log("Action failed:", e.message);
    }

    await sleep(TURN_DELAY_MS);
  }
  console.log("\nReached max turns, stopping.");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => console.error("FATAL", e));
