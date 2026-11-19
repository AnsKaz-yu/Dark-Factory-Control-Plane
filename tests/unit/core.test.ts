// Core foundation tests: ids, event store, schema, projections, derive, API.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync, appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { newId, sha256, hashObject } from "../../packages/core/src/ids.ts"
import { EventStore, makeEnvelope } from "../../packages/core/src/events.ts"
import { validateEvent, validateEnvelope } from "../../packages/core/src/schema.ts"
import { apply, initialState, replay } from "../../packages/core/src/projections.ts"
import {
  buildTaskTree, criticalPath, releaseReadiness, dashboardConfig, effectiveAgentStatus,
  computeMetrics, emptyManifest, componentReadiness,
} from "../../packages/core/src/derive.ts"
import { ProjectManager } from "../../packages/core/src/store.ts"
import { startServer } from "../../packages/core/src/server.ts"
import type { EventEnvelope } from "../../packages/core/src/types.ts"

const SRC = { adapterId: "test", sourceId: "test", entityKind: "task", authoritative: true, fetchedAt: "2026-11-19T00:00:00Z" }

function ev(type: string, payload: Record<string, unknown>, seq: number, extra?: Partial<EventEnvelope>): EventEnvelope {
  return makeEnvelope({ projectId: "p1", type, schemaVersion: 1, payload, source: SRC, seq, ...extra })
}

function tmp(): string { return mkdtempSync(join(tmpdir(), "dfcp-test-")) }

// ---------- ids ----------
test("ids are unique and time-sortable", () => {
  const a = newId(), b = newId()
  assert.notEqual(a, b)
  assert.equal(a.length, 26)
  assert.ok(newId("ev").startsWith("ev_"))
  assert.equal(sha256("x"), sha256("x"))
  assert.equal(hashObject({ a: 1, b: 2 }), hashObject({ b: 2, a: 1 }))
})

// ---------- schema ----------
test("schema validates known events and rejects unknown/version-mismatch", () => {
  assert.equal(validateEvent("task.created", 1, { id: "T1", title: "x" }), null)
  assert.ok(validateEvent("task.created", 1, { id: "T1" })) // missing title
  assert.ok(validateEvent("no.such.event", 1, {}))
  assert.ok(validateEvent("task.created", 99, { id: "T1", title: "x" }))
  assert.ok(validateEvent("task.created", 1, { id: "T1", title: "x", status: "bogus" }))
  assert.ok(validateEvent("task.created", 1, { id: "T1", title: "x", progress: 150 }))
  assert.equal(validateEnvelope({ projectId: "p", type: "task.created", schemaVersion: 1, source: SRC }), null)
  assert.ok(validateEnvelope({ projectId: "p", type: "task.created", schemaVersion: 1 }))
})

// ---------- event store ----------
test("event store dedups by eventId and idempotencyKey, replays in order", () => {
  const dir = tmp()
  const store = new EventStore(dir)
  const e1 = ev("task.created", { id: "T1", title: "one" }, store.allocSeq(), { idempotencyKey: "k1" })
  assert.ok(store.append(e1))
  assert.ok(!store.append(e1)) // same eventId
  const e2 = ev("task.created", { id: "T2", title: "two" }, store.allocSeq(), { idempotencyKey: "k1" })
  assert.ok(!store.append(e2)) // same idempotency key
  const e3 = ev("task.updated", { id: "T1", title: "uno" }, store.allocSeq())
  assert.ok(store.append(e3))
  assert.equal(store.count(), 2)
  // reopen: full replay from log
  const store2 = new EventStore(dir)
  assert.equal(store2.count(), 2)
  assert.equal(store2.lastSeq(), e3.seq)
  assert.deepEqual(store2.after(0).map(e => e.type), ["task.created", "task.updated"])
  rmSync(dir, { recursive: true, force: true })
})

test("event store snapshot verified against log prefix; corrupt lines quarantined", () => {
  const dir = tmp()
  const store = new EventStore(dir)
  store.append(ev("task.created", { id: "T1", title: "one" }, store.allocSeq()))
  store.saveSnapshot({ hello: "state" })
  const snap = store.loadSnapshot()
  assert.ok(snap)
  assert.deepEqual(snap!.state, { hello: "state" })
  // corrupt the log tail: append garbage line
  appendFileSync(join(dir, "events.jsonl"), "{this is not json}\n")
  const store2 = new EventStore(dir)
  assert.equal(store2.corrupt().length, 1)
  assert.equal(store2.count(), 1) // valid events intact
  // snapshot still valid (prefix unchanged)
  assert.ok(store2.loadSnapshot())
  // tamper snapshot hash -> rejected
  writeFileSync(join(dir, "snapshot.json"), JSON.stringify({ lastSeq: 1, logPrefixHash: "bogus", state: {}, takenAt: "x" }))
  assert.equal(store2.loadSnapshot(), null)
  rmSync(dir, { recursive: true, force: true })
})

// ---------- projections ----------
test("task lifecycle: create, claim, status, auto-unblock, history", () => {
  let s = initialState()
  s = apply(s, ev("task.created", { id: "A", title: "blocker" }, 1))
  s = apply(s, ev("task.created", { id: "B", title: "dependent", dependencies: ["A"] }, 2))
  assert.equal(s.tasks.B.status, "blocked")
  s = apply(s, ev("task.claimed", { id: "A", agent: "agent-1" }, 3))
  assert.equal(s.tasks.A.status, "in_progress")
  assert.equal(s.tasks.A.assignee, "agent-1")
  // claim of blocked task is not prevented at projection level (API enforces), but status stays blocked
  s = apply(s, ev("task.status_changed", { id: "A", to: "done", actor: "agent-1" }, 4))
  assert.equal(s.tasks.A.progress, 100)
  assert.equal(s.tasks.B.status, "ready") // auto-unblock
  assert.ok(s.tasks.A.history.some(h => h.field === "status" && h.to === "done"))
  assert.ok(s.transitions["in_progress->done"])
  s = apply(s, ev("task.released", { id: "B" }, 5))
  assert.equal(s.tasks.B.assignee, undefined)
  assert.equal(s.tasks.B.status, "ready")
})

test("agent heartbeat: unknown->working, stale never means completed", () => {
  let s = initialState()
  const at = { occurredAt: "2026-11-19T00:00:00Z" }
  s = apply(s, ev("agent.registered", { id: "a1", name: "worker", kind: "opencode" }, 1, at))
  assert.equal(s.agents.a1.status, "unknown")
  s = apply(s, ev("agent.heartbeat", { id: "a1", taskId: "T1" }, 2, at))
  assert.equal(s.agents.a1.status, "working")
  assert.equal(s.agents.a1.statusEvidence, "heartbeat")
  const now = Date.parse("2026-11-19T01:00:00Z")
  const eff = effectiveAgentStatus(s.agents.a1, now) // heartbeat at 00:00 -> stale
  assert.equal(eff.status, "unknown")
  assert.equal(eff.stale, true)
  // explicit completion stays completed even when stale
  s = apply(s, ev("agent.status_changed", { id: "a1", status: "completed", evidence: "event" }, 3, at))
  assert.equal(effectiveAgentStatus(s.agents.a1, now).status, "completed")
})

test("sessions, components, queue, releases projections", () => {
  let s = initialState()
  s = apply(s, ev("agent.registered", { id: "a1", name: "w" }, 1))
  s = apply(s, ev("session.started", { id: "s1", agentId: "a1", opencodeSessionId: "ses_x", model: "m1" }, 2))
  assert.equal(s.agents.a1.sessionId, "s1")
  assert.equal(s.agents.a1.model, "m1")
  s = apply(s, ev("session.ended", { id: "s1" }, 3))
  assert.ok(s.sessions.s1.endedAt)
  s = apply(s, ev("component.updated", { id: "c1", name: "Core", status: "in_progress" }, 4))
  s = apply(s, ev("component.updated", { id: "c2", name: "Sub", parentId: "c1" }, 5))
  s = apply(s, ev("task.created", { id: "T1", title: "t", componentId: "c2", status: "done" }, 6))
  const r = componentReadiness(s, "c1")
  assert.equal(r.readiness, 100) // subtree rollup
  s = apply(s, ev("merge_queue.snapshot", { entries: [{ id: "e1", branch: "feature/T1", state: "waiting", taskId: "T1" }] }, 7))
  assert.equal(s.queue!.entries[0].position, 1)
  s = apply(s, ev("merge_queue.entry_updated", { id: "e1", state: "merging" }, 8))
  assert.equal(s.queue!.entries[0].state, "merging")
  s = apply(s, ev("release.created", { id: "r1", name: "v1", scopeTaskIds: ["T1"] }, 9))
  s = apply(s, ev("release.released", { id: "r1", tag: "v1.0" }, 10))
  assert.equal(s.releases.r1.status, "released")
})

test("pipeline run projection merges updates", () => {
  let s = initialState()
  s = apply(s, ev("pipeline.run_started", { id: "run1", pipelineId: "build", number: 41, status: "running", branch: "feature/T1", taskId: "T1", stages: [{ name: "compile", status: "running", jobs: [] }] }, 1))
  s = apply(s, ev("pipeline.run_completed", { id: "run1", status: "success", stages: [{ name: "compile", status: "success", jobs: [] }, { name: "test", status: "success", jobs: [] }] }, 2))
  assert.equal(s.runs.run1.status, "success")
  assert.equal(s.runs.run1.stages.length, 2)
  assert.equal(s.runs.run1.taskId, "T1")
  assert.ok(s.pipelines.build)
})

// ---------- derive ----------
test("critical path: estimates, structural fallback, cycles", () => {
  let s = initialState()
  s = apply(s, ev("task.created", { id: "A", title: "a", estimateHours: 2 }, 1))
  s = apply(s, ev("task.created", { id: "B", title: "b", dependencies: ["A"], estimateHours: 5 }, 2))
  s = apply(s, ev("task.created", { id: "C", title: "c", dependencies: ["A"], estimateHours: 1 }, 3))
  const cp = criticalPath(s)
  assert.equal(cp.nature, "computed")
  assert.deepEqual(cp.path, ["A", "B"])
  assert.equal(cp.lengthHours, 7)
  // missing estimate -> structural (null clears the field)
  s = apply(s, ev("task.updated", { id: "C", estimateHours: null }, 4))
  const cp2 = criticalPath(s)
  assert.equal(cp2.nature, "estimated")
  assert.ok(cp2.notes.some(n => n.includes("STRUCTURAL")))
  // cycle
  let sc = initialState()
  sc = apply(sc, ev("task.created", { id: "X", title: "x", dependencies: ["Y"] }, 1))
  sc = apply(sc, ev("task.created", { id: "Y", title: "y", dependencies: ["X"] }, 2))
  const cpc = criticalPath(sc)
  assert.ok(cpc.cycles.length > 0)
})

test("release readiness: verdicts and coverage honesty", () => {
  let s = initialState()
  s = apply(s, ev("task.created", { id: "A", title: "a", status: "done" }, 1))
  s = apply(s, ev("task.created", { id: "B", title: "b", dependencies: ["A"] }, 2))
  s = apply(s, ev("release.created", { id: "r1", name: "v1", scopeTaskIds: ["A", "B"] }, 3))
  const caps = emptyManifest("p1")
  const rr = releaseReadiness(s, s.releases.r1, caps)
  assert.equal(rr.verdict, "not_ready")
  assert.ok(rr.coverage.some(c => c.includes("CI not verified")))
  s = apply(s, ev("task.status_changed", { id: "B", to: "done" }, 4))
  const rr2 = releaseReadiness(s, s.releases.r1, caps)
  assert.equal(rr2.verdict, "ready")
  // empty scope -> insufficient data
  s = apply(s, ev("release.created", { id: "r2", name: "v2", scopeTaskIds: [] }, 5))
  assert.equal(releaseReadiness(s, s.releases.r2, caps).verdict, "insufficient_data")
})

test("task tree keeps hierarchy separate from dependencies; rollups", () => {
  let s = initialState()
  s = apply(s, ev("task.created", { id: "E1", title: "epic", kind: "epic" }, 1))
  s = apply(s, ev("task.created", { id: "T1", title: "t1", parentId: "E1", status: "done" }, 2))
  s = apply(s, ev("task.created", { id: "T2", title: "t2", parentId: "E1", dependencies: ["T1"], status: "in_progress", progress: 40 }, 3))
  const tree = buildTaskTree(s)
  assert.equal(tree.length, 1)
  assert.equal(tree[0].task.id, "E1")
  assert.equal(tree[0].children.length, 2)
  assert.equal(tree[0].rollup.total, 3)
  assert.equal(tree[0].rollup.done, 1)
  assert.equal(tree[0].rollup.progress, Math.round((100 + 40) / 2)) // leaves only; epic derives from children
  // filter keeps ancestors
  const filtered = buildTaskTree(s, t => t.id === "T2")
  assert.equal(filtered[0].task.id, "E1")
  assert.equal(filtered[0].children.length, 1)
})

test("dashboard config is capability-driven", () => {
  const caps = emptyManifest("p1")
  caps.capabilities.task_management = { ...caps.capabilities.task_management, status: "supported", confidence: "verified" }
  caps.capabilities.ci_cd = { ...caps.capabilities.ci_cd, status: "unavailable" }
  caps.capabilities.merge_queue = { ...caps.capabilities.merge_queue, status: "partial", limitations: ["no dead-letter reasons"] }
  caps.capabilities.agent_monitoring = { ...caps.capabilities.agent_monitoring, status: "stale" }
  const cfg = dashboardConfig("p1", "P", caps, {})
  const byId = Object.fromEntries(cfg.sections.map(x => [x.id, x]))
  assert.equal(byId.tasks.visible, true)
  assert.equal(byId.tasks.mode, "full")
  assert.equal(byId.pipelines.visible, false) // unavailable -> hidden
  assert.equal(byId["merge-queue"].mode, "partial")
  assert.equal(byId.agents.mode, "partial") // stale keeps visible but degraded
  assert.ok(byId.agents.limitations.some(l => l.includes("stale")))
  assert.equal(byId.integrations.visible, true) // always visible
  // task tree fallback when hierarchy unknown but tasks supported
  assert.equal(byId["task-tree"].visible, true)
  assert.equal(byId["task-tree"].mode, "partial")
})

test("metrics compute only from available data with coverage notes", () => {
  let s = initialState()
  s = apply(s, ev("task.created", { id: "A", title: "a" }, 1))
  s = apply(s, ev("task.status_changed", { id: "A", to: "done" }, 2))
  const m = computeMetrics(s, null)
  assert.equal(m.metrics.tasks_total, 1)
  assert.equal(m.metrics.pipeline_success_rate, null)
  assert.ok(m.coverage.pipeline_success_rate.includes("no CI runs"))
  assert.equal(m.metrics.queue_depth, null)
})

// ---------- store / ingestion ----------
test("ingestion: validation, diagnostics for unknown/invalid, dedup", () => {
  const dir = tmp()
  const mgr = new ProjectManager(dir)
  const s = mgr.create("p1", "Test", dir)
  const res = s.ingest([
    { type: "task.created", schemaVersion: 1, payload: { id: "T1", title: "ok" }, source: SRC, idempotencyKey: "dup" },
    { type: "task.created", schemaVersion: 1, payload: { id: "T1", title: "ok" }, source: SRC, idempotencyKey: "dup" },
    { type: "task.created", schemaVersion: 1, payload: { id: "T1", title: "ok" }, source: SRC, idempotencyKey: "dup" },
    { type: "bogus.event", schemaVersion: 1, payload: {}, source: SRC },
    { type: "task.created", schemaVersion: 1, payload: { id: "T2" }, source: SRC }, // missing title
    { type: "task.created", schemaVersion: 1, payload: { id: "T3", title: "x" } }, // missing source
  ])
  assert.equal(res.accepted, 1)
  assert.equal(res.duplicates, 2)
  assert.equal(res.rejected.length, 3)
  assert.equal(s.state.diagnostics.unknownEvents, 1)
  assert.equal(s.state.diagnostics.schemaViolations, 1)
  assert.ok(s.state.tasks.T1)
  assert.ok(!s.state.tasks.T2)
  // reopen manager: state recovered from log
  const mgr2 = new ProjectManager(dir)
  assert.ok(mgr2.get("p1").state.tasks.T1)
  rmSync(dir, { recursive: true, force: true })
})

// ---------- API end-to-end ----------
test("API: register, ingest, tasks, claim conflict, overview, dashboard-config, SSE resume", async () => {
  const dir = tmp()
  const { server, port } = startServer({ dataDir: dir, port: 0 })
  await new Promise(r => server.on("listening", r))
  const addr = server.address()
  const actualPort = typeof addr === "object" && addr ? addr.port : port
  const base = `http://127.0.0.1:${actualPort}`
  try {
    const health = await (await fetch(`${base}/api/health`)).json()
    assert.ok(health.ok)
    const reg = await (await fetch(`${base}/api/projects`, { method: "POST", body: JSON.stringify({ id: "demo", name: "Demo", root: dir }) })).json()
    assert.equal(reg.project.id, "demo")
    // ingest via API
    const ing = await (await fetch(`${base}/api/projects/demo/events`, {
      method: "POST", body: JSON.stringify({ events: [
        { type: "task.created", schemaVersion: 1, payload: { id: "T1", title: "first", estimateHours: 3 }, source: SRC },
        { type: "task.created", schemaVersion: 1, payload: { id: "T2", title: "second", dependencies: ["T1"] }, source: SRC },
        { type: "agent.registered", schemaVersion: 1, payload: { id: "a1", name: "worker", kind: "opencode" }, source: SRC },
      ] }),
    })).json()
    assert.equal(ing.accepted, 3)
    // claim blocked task -> 409
    const claimBlocked = await fetch(`${base}/api/projects/demo/tasks/T2/claim`, { method: "POST", body: JSON.stringify({ agent: "a1" }) })
    assert.equal(claimBlocked.status, 409)
    // claim T1 ok
    const claim = await (await fetch(`${base}/api/projects/demo/tasks/T1/claim`, { method: "POST", body: JSON.stringify({ agent: "a1" }) })).json()
    assert.equal(claim.task.assignee, "a1")
    // double claim by other agent -> 409
    const claim2 = await fetch(`${base}/api/projects/demo/tasks/T1/claim`, { method: "POST", body: JSON.stringify({ agent: "a2" }) })
    assert.equal(claim2.status, 409)
    // complete T1 -> T2 unblocks
    await fetch(`${base}/api/projects/demo/tasks/T1`, { method: "PATCH", body: JSON.stringify({ status: "done" }) })
    const t2 = await (await fetch(`${base}/api/projects/demo/tasks/T2`)).json()
    assert.equal(t2.task.status, "ready")
    // overview + dashboard config
    const ov = await (await fetch(`${base}/api/projects/demo`)).json()
    assert.equal(ov.counts.tasks.total, 2)
    const cfg = await (await fetch(`${base}/api/projects/demo/dashboard-config`)).json()
    assert.ok(cfg.sections.length >= 10)
    // SSE resume: connect with lastSeq=0 receives existing events
    const ctrl = new AbortController()
    const sse = await fetch(`${base}/api/projects/demo/stream?lastSeq=0`, { signal: ctrl.signal })
    const reader = sse.body!.getReader()
    const { value } = await reader.read()
    const text = new TextDecoder().decode(value)
    assert.ok(text.includes("task.created"))
    ctrl.abort()
    // doctor
    const doc = await (await fetch(`${base}/api/projects/demo/doctor`)).json()
    assert.ok(Array.isArray(doc.checks))
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
