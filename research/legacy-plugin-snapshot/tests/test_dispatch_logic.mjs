// test_dispatch_logic.mjs — тест логики диспетчера/liveness (ADR-035).
// Зеркалирует функции claimReady/priorityRank/crateKeys/agentAlive/resolverStale из index.ts.
// Запуск: node plugin/reservoiros-dashboard/tests/test_dispatch_logic.mjs
import assert from "node:assert";

// --- зеркало реализованных функций ---
function priorityRank(t) {
  const p = String(t.priority || "P2").toUpperCase();
  return p === "P0" ? 0 : p === "P1" ? 1 : p === "P3" ? 3 : 2;
}
function crateKeys(zone) {
  const out = new Set();
  for (const p of zone || []) {
    if (!p.startsWith("crates/")) continue;
    const seg = p.split("/");
    out.add(seg[1] === "physics" ? seg.slice(0, 3).join("/") : seg.slice(0, 2).join("/"));
  }
  return out;
}
function claimReady(st, zones, max) {
  const tasks = Object.values(st.tasks);
  const active = tasks.filter(t => t.status === "in-progress");
  let free = max - active.length;
  if (free <= 0) return [];
  const busy = new Set();
  for (const t of active) for (const k of crateKeys(zones[t.id])) busy.add(k);
  const ready = tasks.filter(t => t.status === "ready" && !t.review && zones[t.id] && (t.blockedBy || []).every(d => !st.tasks[d] || st.tasks[d].status === "done"));
  ready.sort((a, b) => priorityRank(a) - priorityRank(b) || String(a.id).localeCompare(String(b.id)));
  const out = [];
  for (const t of ready) {
    if (free <= 0) break;
    const keys = crateKeys(zones[t.id]);
    let overlap = false;
    for (const k of keys) if (busy.has(k)) { overlap = true; break; }
    if (overlap) continue;
    out.push({ id: t.id, agent: `auto-${t.id}` });
    for (const k of keys) busy.add(k);
    free--;
  }
  return out;
}
function resolverStale(trEntry, logMtime, now, grace = 45 * 60 * 1000) {
  let last = Date.parse(trEntry.started) || 0;
  if (trEntry.lastSeen) { const ls = Date.parse(trEntry.lastSeen); if (ls > last) last = ls; }
  if (logMtime && logMtime > last) last = logMtime;
  return now - last > grace;
}

let passed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok - " + name); } catch (e) { console.error("  FAIL - " + name + "\n    " + (e.stack || e)); process.exitCode = 1; } }
const NOW = Date.parse("2026-11-18T12:00:00Z");
const zones = {
  "T-006n": ["crates/physics/blackoil/*", "Cargo.toml", "Cargo.lock"],
  "T-006j": ["crates/physics/blackoil/*", "Cargo.toml", "Cargo.lock"],
  "T-REQ-08b": ["crates/core/*"],
  "T-API": ["crates/api/*"],
  "T-010": ["crates/physics/compositional/*"],
};
const mk = (id, status, extra = {}) => ({ id, status, blockedBy: [], ...extra });

console.log("test_dispatch_logic:");

test("priority: P0 picked before P2 even if id sorts later", () => {
  const st = { tasks: { "T-API": mk("T-API", "ready", { priority: "P2" }), "T-006n": mk("T-006n", "ready", { priority: "P0" }) } };
  const out = claimReady(st, zones, 1);
  assert.strictEqual(out[0].id, "T-006n");
});

test("zone-overlap: two blackoil tasks -> only one picked", () => {
  const st = { tasks: { "T-006n": mk("T-006n", "ready"), "T-006j": mk("T-006j", "ready") } };
  const out = claimReady(st, zones, 3);
  assert.strictEqual(out.length, 1);
});

test("distinct crates: blackoil + core + api all picked", () => {
  const st = { tasks: { "T-006n": mk("T-006n", "ready"), "T-REQ-08b": mk("T-REQ-08b", "ready"), "T-API": mk("T-API", "ready") } };
  const out = claimReady(st, zones, 3);
  assert.strictEqual(out.length, 3);
});

test("overlap with active: active blackoil blocks ready blackoil", () => {
  const st = { tasks: { "T-006n": mk("T-006n", "in-progress"), "T-006j": mk("T-006j", "ready"), "T-REQ-08b": mk("T-REQ-08b", "ready") } };
  const out = claimReady(st, zones, 3);
  const ids = out.map(o => o.id);
  assert.ok(!ids.includes("T-006j"), "blackoil ready must be skipped (active blackoil)");
  assert.ok(ids.includes("T-REQ-08b"), "core picked");
});

test("free slots limit respected", () => {
  const st = { tasks: { "T-006n": mk("T-006n", "ready"), "T-REQ-08b": mk("T-REQ-08b", "ready"), "T-API": mk("T-API", "ready") } };
  const out = claimReady(st, zones, 2);
  assert.strictEqual(out.length, 2);
});

test("deps not done -> not dispatchable", () => {
  const st = { tasks: { "T-006": mk("T-006", "in-progress"), "T-006n": mk("T-006n", "ready", { blockedBy: ["T-006"] }) } };
  const out = claimReady(st, zones, 3);
  assert.strictEqual(out.length, 0);
});

test("nested physics crates distinct (blackoil vs compositional)", () => {
  const st = { tasks: { "T-006n": mk("T-006n", "ready"), "T-010": mk("T-010", "ready") } };
  const out = claimReady(st, zones, 3);
  assert.strictEqual(out.length, 2);
});

test("resolver-liveness: recent log activity -> NOT stale (even if started long ago)", () => {
  const tr = { started: new Date(NOW - 60 * 60 * 1000).toISOString() };  // started 60min ago
  const logMtime = NOW - 5 * 60 * 1000;  // active 5min ago
  assert.strictEqual(resolverStale(tr, logMtime, NOW), false);
});

test("resolver-liveness: dead resolver (stale log+start) -> stale", () => {
  const tr = { started: new Date(NOW - 60 * 60 * 1000).toISOString() };
  const logMtime = NOW - 50 * 60 * 1000;  // no activity 50min
  assert.strictEqual(resolverStale(tr, logMtime, NOW), true);
});

test("resolver-liveness: heartbeat lastSeen keeps alive", () => {
  const tr = { started: new Date(NOW - 60 * 60 * 1000).toISOString(), lastSeen: new Date(NOW - 2 * 60 * 1000).toISOString() };
  assert.strictEqual(resolverStale(tr, null, NOW), false);
});

console.log(passed + " passed" + (process.exitCode ? " (WITH FAILURES)" : ""));
