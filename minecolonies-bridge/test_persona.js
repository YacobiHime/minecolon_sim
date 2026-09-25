// test_persona.js - Unit tests for personas.js + persona_daemon.js (P1).
// Pure offline: mock /status fixtures only, never touches the live bridge.
// Run: node test_persona.js  (exits 0 and prints ALL PASS when green)
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const P = require("./personas.js");
const daemon = require("./persona_daemon.js");

// Deterministic RNG (mulberry32) so statistical assertions are stable.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const templates = P.loadTemplates(path.join(__dirname, "persona_templates.json"));

function mockCitizen(id, name, extra) {
  return {
    id, name, job: "unemployed", jobStatus: "idle", saturation: 10,
    isChild: false, parents: [], children: [], siblings: [], partner: null,
    ...extra,
  };
}

let passed = 0;
function test(label, fn) {
  fn();
  passed++;
  console.log(`PASS ${label}`);
}

// ---------- templates + validation ----------

test("all 12 templates produce valid gen-0 personas", () => {
  assert.strictEqual(templates.length, 12, "expected 12 templates");
  for (const tpl of templates) {
    const p = P.assignFromTemplate(mockCitizen(1, "Test"), tpl.id, { templates });
    assert.deepStrictEqual(P.validatePersona(p), [], `template ${tpl.id} invalid`);
    assert.strictEqual(p.generation, 0);
    assert.strictEqual(p.templateId, tpl.id);
    for (const seg of Object.values(p.segments)) {
      assert.ok(!("_comment" in seg), "_comment must be stripped on assign");
    }
  }
});

test("validatePersona catches broken personas", () => {
  const p = P.assignFromTemplate(mockCitizen(2, "Broken"), "timid_farmer", { templates });
  p.segments.temperament.bravery = 1.5; // out of range
  delete p.segments.politics;
  const errs = P.validatePersona(p);
  assert.ok(errs.some((e) => e.includes("bravery")), "range error not caught");
  assert.ok(errs.some((e) => e.includes("politics")), "missing segment not caught");
});

// ---------- storage (atomic write round-trip) ----------

test("saveAll/loadAll round-trip via tmp+rename", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "persona-test-"));
  const file = path.join(dir, "personas.json");
  const store = P.emptyStore();
  P.put(store, P.assignFromTemplate(mockCitizen(7, "Alice"), "random", { templates, rng: mulberry32(1) }));
  P.saveAll(store, file);
  assert.ok(!fs.existsSync(file + ".tmp"), "tmp file left behind");
  const loaded = P.loadAll(file);
  assert.deepStrictEqual(loaded.personas, store.personas);
  assert.strictEqual(P.get(loaded, 7).name, "Alice");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- crossover ----------

function makeParents() {
  const pa = P.assignFromTemplate(mockCitizen(10, "PapaA"), "hotblooded_guard", { templates });
  const pb = P.assignFromTemplate(mockCitizen(11, "MamaB"), "timid_farmer", { templates });
  return [pa, pb];
}

test("crossover: every segment comes whole from exactly one parent", () => {
  const [pa, pb] = makeParents();
  const rng = mulberry32(42);
  for (let i = 0; i < 200; i++) {
    const { segments, segmentOrigins } = P.crossover(pa, pb, 5, 5, rng);
    for (const name of P.SEGMENT_NAMES) {
      const src = segmentOrigins[name] === "A" ? pa.segments[name] : pb.segments[name];
      assert.deepStrictEqual(segments[name], src, `segment ${name} not identical to its origin parent`);
    }
  }
});

test("crossover: happiness weighting biases segment origin (~90% at 9:1)", () => {
  const [pa, pb] = makeParents();
  const rng = mulberry32(7);
  let fromA = 0;
  let total = 0;
  for (let i = 0; i < 2000; i++) {
    const { segmentOrigins } = P.crossover(pa, pb, 9, 1, rng);
    for (const name of P.SEGMENT_NAMES) {
      total++;
      if (segmentOrigins[name] === "A") fromA++;
    }
  }
  const frac = fromA / total;
  assert.ok(Math.abs(frac - 0.9) < 0.02, `expected ~0.9 from happier parent, got ${frac.toFixed(3)}`);
});

test("crossover: zero/missing happiness falls back to 50/50", () => {
  const [pa, pb] = makeParents();
  const rng = mulberry32(13);
  let fromA = 0;
  let total = 0;
  for (let i = 0; i < 2000; i++) {
    const { segmentOrigins } = P.crossover(pa, pb, 0, 0, rng);
    for (const name of P.SEGMENT_NAMES) {
      total++;
      if (segmentOrigins[name] === "A") fromA++;
    }
  }
  const frac = fromA / total;
  assert.ok(Math.abs(frac - 0.5) < 0.03, `expected ~0.5 on zero happiness, got ${frac.toFixed(3)}`);
});

// ---------- mutation ----------

test("mutate: per-segment rate is honored (~10%), values stay in [0,1]", () => {
  const rng = mulberry32(99);
  let mutatedSegs = 0;
  let totalSegs = 0;
  for (let i = 0; i < 3000; i++) {
    const p = P.assignFromTemplate(mockCitizen(20, "Mut"), "cold_strategist", { templates });
    const mutated = P.mutate(p, 0.1, rng);
    mutatedSegs += mutated.length;
    totalSegs += P.SEGMENT_NAMES.length;
    assert.deepStrictEqual(P.validatePersona(p), [], "mutation produced invalid persona (clamp failed?)");
  }
  const rate = mutatedSegs / totalSegs;
  assert.ok(Math.abs(rate - 0.1) < 0.02, `expected mutation rate ~0.1, got ${rate.toFixed(3)}`);
});

test("mutate: rate 0 never changes anything; jobPreference swap keeps list length", () => {
  const rng = mulberry32(5);
  const p = P.assignFromTemplate(mockCitizen(21, "Frozen"), "loyal_builder", { templates });
  const before = JSON.stringify(p.segments);
  assert.deepStrictEqual(P.mutate(p, 0, rng), []);
  assert.strictEqual(JSON.stringify(p.segments), before, "rate 0 mutated something");

  // Force jobPreference mutation deterministically with rate 1 and check shape.
  for (let i = 0; i < 50; i++) {
    const q = P.assignFromTemplate(mockCitizen(22, "Swap"), "loyal_builder", { templates });
    const likedLen = q.segments.jobPreference.liked.length;
    const dislikedLen = q.segments.jobPreference.disliked.length;
    P.mutate(q, 1, rng);
    assert.strictEqual(q.segments.jobPreference.liked.length, likedLen);
    assert.strictEqual(q.segments.jobPreference.disliked.length, dislikedLen);
    for (const j of q.segments.jobPreference.liked.concat(q.segments.jobPreference.disliked)) {
      assert.ok(typeof j === "string" && j.length > 0);
    }
  }
});

// ---------- daemon: baseline assignment ----------

test("daemon: first poll assigns templates to all citizens (generation 0)", () => {
  const store = P.emptyStore();
  const state = { baselineDone: false, missingCounts: {} };
  const citizens = [mockCitizen(1, "Ann"), mockCitizen(2, "Bob"), mockCitizen(3, "Cid")];
  const { changed, events } = daemon.processStatus(store, citizens, state, { templates, rng: mulberry32(3) });
  assert.ok(changed);
  assert.strictEqual(events.filter((e) => e.event === "assign").length, 3);
  for (const c of citizens) {
    const p = P.get(store, c.id);
    assert.ok(p, `citizen ${c.id} got no persona`);
    assert.strictEqual(p.generation, 0);
    assert.deepStrictEqual(P.validatePersona(p), []);
  }
  assert.ok(state.baselineDone);
});

// ---------- daemon: birth with name->id parent resolution ----------

test("daemon: birth resolves parent NAMES to ids and inherits (gen = max+1)", () => {
  const store = P.emptyStore();
  const state = { baselineDone: false, missingCounts: {} };
  const adults = [mockCitizen(1, "Ann Smith"), mockCitizen(2, "Bob Stone"), mockCitizen(3, "Cid Reed")];
  daemon.processStatus(store, adults, state, { templates, rng: mulberry32(8) });

  const baby = mockCitizen(4, "Deb Smith", { isChild: true, parents: ["Ann Smith", "Bob Stone"] });
  const { events } = daemon.processStatus(
    store,
    adults.concat([baby]),
    state,
    { templates, rng: mulberry32(9) }
  );
  const birth = events.find((e) => e.event === "birth");
  assert.ok(birth, "no birth event");
  assert.strictEqual(birth.citizenId, 4);
  assert.deepStrictEqual(birth.parents.slice().sort(), [1, 2], "parent names not resolved to ids 1,2");
  assert.strictEqual(birth.parentsSynthesized, false);
  const child = P.get(store, 4);
  assert.strictEqual(child.generation, 1, "generation must be max(parents)+1");
  // Every non-mutated segment must equal one of the two parents' segments.
  const pa = P.get(store, 1);
  const pb = P.get(store, 2);
  for (const name of P.SEGMENT_NAMES) {
    if (child.mutatedSegments.includes(name)) continue;
    const eqA = JSON.stringify(child.segments[name]) === JSON.stringify(pa.segments[name]);
    const eqB = JSON.stringify(child.segments[name]) === JSON.stringify(pb.segments[name]);
    assert.ok(eqA || eqB, `child segment ${name} matches neither parent`);
  }
});

test("daemon: unresolvable parents -> happiness-weighted lottery, parentsSynthesized", () => {
  const store = P.emptyStore();
  const state = { baselineDone: false, missingCounts: {} };
  const adults = [
    mockCitizen(1, "Happy One", { happiness: 10 }),
    mockCitizen(2, "Sad One", { happiness: 0.1 }),
    mockCitizen(3, "Mid One", { happiness: 5 }),
  ];
  daemon.processStatus(store, adults, state, { templates, rng: mulberry32(21) });

  // Parents recorded under names that no longer exist in the colony.
  const rng = mulberry32(22);
  let happyPicked = 0;
  const RUNS = 300;
  for (let i = 0; i < RUNS; i++) {
    const s2 = JSON.parse(JSON.stringify(store));
    const st2 = { baselineDone: true, missingCounts: {} };
    const baby = mockCitizen(100, "Orphan", { isChild: true, parents: ["Ghost A", "Ghost B"] });
    const { events } = daemon.processStatus(s2, adults.concat([baby]), st2, { templates, rng });
    const birth = events.find((e) => e.event === "birth");
    assert.ok(birth, "no birth event on lottery path");
    assert.strictEqual(birth.parentsSynthesized, true);
    assert.strictEqual(birth.parents.length, 2);
    assert.ok(!birth.parents.includes(100), "baby chosen as its own parent");
    const p = P.get(s2, 100);
    assert.strictEqual(p.parentsSynthesized, true);
    if (birth.parents.includes(1)) happyPicked++;
  }
  // Citizen 1 holds 10/15.1 of the weight; it should be picked as one of the
  // two parents far more often than uniform (2/3). Loose statistical bound.
  assert.ok(happyPicked / RUNS > 0.8, `happiness weighting too weak: ${happyPicked}/${RUNS}`);
});

test("daemon: child NOT flagged isChild but with parents still inherits", () => {
  const store = P.emptyStore();
  const state = { baselineDone: false, missingCounts: {} };
  const adults = [mockCitizen(1, "Ann"), mockCitizen(2, "Bob")];
  daemon.processStatus(store, adults, state, { templates, rng: mulberry32(31) });
  const kid = mockCitizen(9, "Kid", { isChild: false, parents: ["Ann", "Bob"] });
  const { events } = daemon.processStatus(store, adults.concat([kid]), state, { templates, rng: mulberry32(32) });
  const birth = events.find((e) => e.event === "birth");
  assert.ok(birth && birth.parentsSynthesized === false);
});

// ---------- daemon: death 3-poll rule ----------

test("daemon: death confirmed only after 3 consecutive missing polls", () => {
  const store = P.emptyStore();
  const state = { baselineDone: false, missingCounts: {} };
  const all = [mockCitizen(1, "Ann"), mockCitizen(2, "Bob")];
  daemon.processStatus(store, all, state, { templates, rng: mulberry32(41) });

  const without2 = [all[0]];
  // Poll 1 & 2 missing: still alive (chunk unload tolerance).
  for (let i = 1; i <= 2; i++) {
    const { events } = daemon.processStatus(store, without2, state, { templates, rng: mulberry32(41) });
    assert.ok(!events.some((e) => e.event === "deceased"), `deceased too early (poll ${i})`);
    assert.ok(!P.get(store, 2).deceased);
  }
  // Poll 3 missing: confirmed dead, persona kept.
  const { events } = daemon.processStatus(store, without2, state, { templates, rng: mulberry32(41) });
  assert.ok(events.some((e) => e.event === "deceased" && e.citizenId === 2));
  assert.strictEqual(P.get(store, 2).deceased, true);
  assert.ok(P.get(store, 2).deceasedAt, "deceasedAt missing");
  assert.ok(P.get(store, 2), "persona must never be deleted");
});

test("daemon: reappearing citizen resets the missing counter", () => {
  const store = P.emptyStore();
  const state = { baselineDone: false, missingCounts: {} };
  const all = [mockCitizen(1, "Ann"), mockCitizen(2, "Bob")];
  daemon.processStatus(store, all, state, { templates, rng: mulberry32(51) });

  const without2 = [all[0]];
  daemon.processStatus(store, without2, state, { templates, rng: mulberry32(51) }); // miss 1
  daemon.processStatus(store, without2, state, { templates, rng: mulberry32(51) }); // miss 2
  daemon.processStatus(store, all, state, { templates, rng: mulberry32(51) });      // back (chunk reloaded)
  assert.ok(!state.missingCounts[2], "counter not reset");
  daemon.processStatus(store, without2, state, { templates, rng: mulberry32(51) }); // miss 1 again
  daemon.processStatus(store, without2, state, { templates, rng: mulberry32(51) }); // miss 2 again
  assert.ok(!P.get(store, 2).deceased, "reset counter still led to premature death");
});

test("daemon: citizen reappearing after provisional death is restored", () => {
  const store = P.emptyStore();
  const state = { baselineDone: false, missingCounts: {} };
  const all = [mockCitizen(1, "Ann"), mockCitizen(2, "Bob")];
  daemon.processStatus(store, all, state, { templates, rng: mulberry32(56) });

  const without2 = [all[0]];
  for (let i = 0; i < daemon.DEATH_CONFIRM_POLLS; i++) {
    daemon.processStatus(store, without2, state, { templates, rng: mulberry32(56) });
  }
  assert.strictEqual(P.get(store, 2).deceased, true);

  const renamed = [all[0], mockCitizen(2, "Robert")];
  const { changed, events } = daemon.processStatus(store, renamed, state, {
    templates,
    rng: mulberry32(56),
  });
  assert.strictEqual(changed, true);
  assert.ok(events.some((e) => e.event === "restored" && e.citizenId === 2));
  assert.strictEqual(P.get(store, 2).deceased, false);
  assert.strictEqual(P.get(store, 2).deceasedAt, null);
  assert.strictEqual(P.get(store, 2).name, "Robert");
});

test("daemon: live name changes synchronize without replacing persona", () => {
  const store = P.emptyStore();
  const state = { baselineDone: false, missingCounts: {} };
  const original = mockCitizen(1, "Ann");
  daemon.processStatus(store, [original], state, { templates, rng: mulberry32(57) });
  const before = JSON.parse(JSON.stringify(P.get(store, 1).segments));

  const renamed = mockCitizen(1, "Anne");
  const { changed, events } = daemon.processStatus(store, [renamed], state, {
    templates,
    rng: mulberry32(57),
  });
  assert.strictEqual(changed, true);
  assert.ok(events.some((e) => e.event === "identity_updated" && e.previousName === "Ann" && e.name === "Anne"));
  assert.strictEqual(P.get(store, 1).name, "Anne");
  assert.deepStrictEqual(P.get(store, 1).segments, before);
});

// ---------- daemon: deceased citizens don't re-trigger, no churn ----------

test("daemon: steady state produces no events and no changes", () => {
  const store = P.emptyStore();
  const state = { baselineDone: false, missingCounts: {} };
  const all = [mockCitizen(1, "Ann"), mockCitizen(2, "Bob")];
  daemon.processStatus(store, all, state, { templates, rng: mulberry32(61) });
  const { changed, events } = daemon.processStatus(store, all, state, { templates, rng: mulberry32(61) });
  assert.strictEqual(changed, false);
  assert.deepStrictEqual(events, []);
});

console.log(`\nALL PASS (${passed} tests)`);
