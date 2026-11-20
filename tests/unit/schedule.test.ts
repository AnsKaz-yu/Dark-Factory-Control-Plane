// Schedule (Gantt) + repository activity tests.
import { test } from "node:test"
import assert from "node:assert/strict"
import { apply, initialState } from "../../packages/core/src/projections.ts"
import { criticalPath, repoActivity, WORKING_HOURS_PER_DAY } from "../../packages/core/src/derive.ts"
import { makeEnvelope } from "../../packages/core/src/events.ts"

const SRC = { adapterId: "test", sourceId: "test", entityKind: "task", authoritative: true, fetchedAt: "2026-11-20T00:00:00Z" }
function ev(type: string, payload: Record<string, unknown>, seq: number) {
  return makeEnvelope({ projectId: "p", type, schemaVersion: 1, payload, source: SRC, seq, occurredAt: "2026-11-20T00:00:00Z" })
}

test("gantt schedule: forward pass respects dependencies and estimates", () => {
  let s = initialState()
  s = apply(s, ev("task.created", { id: "A", title: "a", estimateHours: 8 }, 1))
  s = apply(s, ev("task.created", { id: "B", title: "b", dependencies: ["A"], estimateHours: 16 }, 2))
  s = apply(s, ev("task.created", { id: "C", title: "c", dependencies: ["A"], estimateHours: 4 }, 3))
  const cp = criticalPath(s, undefined, { now: Date.parse("2026-11-20T00:00:00Z") })
  assert.equal(cp.nature, "computed")
  const byId = Object.fromEntries(cp.schedule!.map(b => [b.taskId, b]))
  assert.equal(byId.A.startH, 0)
  assert.equal(byId.A.endH, 8)
  assert.equal(byId.B.startH, 8)
  assert.equal(byId.B.endH, 24)
  assert.equal(byId.C.startH, 8)
  assert.equal(byId.C.endH, 12)
  assert.equal(cp.horizonHours, 24)
  assert.deepEqual(cp.path, ["A", "B"])
  assert.ok(byId.B.onPath)
  assert.ok(!byId.C.onPath)
  assert.ok(cp.schedule!.every(b => !b.estimated))
  assert.equal(cp.workingHoursPerDay, WORKING_HOURS_PER_DAY)
  // projected finish = now + 24 working hours = 3 calendar days
  assert.equal(cp.projectedFinishAt, "2026-11-23T00:00:00.000Z")
})

test("gantt schedule: missing estimates -> placeholder durations flagged estimated", () => {
  let s = initialState()
  s = apply(s, ev("task.created", { id: "A", title: "a", estimateHours: 6 }, 1))
  s = apply(s, ev("task.created", { id: "B", title: "b", dependencies: ["A"] }, 2))
  const cp = criticalPath(s)
  assert.equal(cp.nature, "estimated")
  const b = cp.schedule!.find(x => x.taskId === "B")!
  assert.ok(b.estimated)
  assert.equal(b.endH - b.startH, 6) // mean of known estimates
  assert.ok(cp.notes.some(n => n.includes("placeholder")))
})

test("gantt schedule: release target comparison (late detection)", () => {
  let s = initialState()
  s = apply(s, ev("task.created", { id: "A", title: "a", estimateHours: 40 }, 1)) // 5 working days
  const cp = criticalPath(s, ["A"], { targetDate: "2026-11-22T00:00:00Z", now: Date.parse("2026-11-20T00:00:00Z") })
  // projected finish 2026-11-25 -> 3 calendar days late = 24 working hours
  assert.equal(cp.lateByHours, 24)
  assert.ok(cp.notes.some(n => n.includes("AFTER the release target")))
  const cp2 = criticalPath(s, ["A"], { targetDate: "2026-11-30T00:00:00Z", now: Date.parse("2026-11-20T00:00:00Z") })
  assert.ok((cp2.lateByHours ?? 0) <= 0)
})

test("repository activity: daily buckets of commits and events", () => {
  let s = initialState()
  const now = Date.parse("2026-11-20T12:00:00Z")
  const e1 = ev("git.commits", { commits: [
    { sha: "1", message: "a", at: "2026-11-20T08:00:00Z" },
    { sha: "2", message: "b", at: "2026-11-20T09:00:00Z" },
    { sha: "3", message: "c", at: "2026-11-18T09:00:00Z" },
    { sha: "4", message: "old", at: "2026-10-01T09:00:00Z" }, // outside window
  ] }, 1)
  const e2 = ev("activity.note", { text: "x" }, 2)
  s = apply(s, e1)
  s = apply(s, e2)
  const act = repoActivity(s, [e1, e2], 14, now)
  assert.equal(act.days.length, 14)
  const today = act.days.find(d => d.date === "2026-11-20")!
  assert.equal(today.commits, 2)
  assert.ok(today.events >= 1)
  const d18 = act.days.find(d => d.date === "2026-11-18")!
  assert.equal(d18.commits, 1)
  assert.equal(act.totalCommits, 3)
  assert.equal(act.nature, "computed")
  // empty repo -> missing, honest note
  const empty = repoActivity(initialState(), [], 14, now)
  assert.equal(empty.nature, "missing")
  assert.ok(empty.notes.some(n => n.includes("no commits")))
})
