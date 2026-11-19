// End-to-end product test over HTTP — exactly the surface the plugin and CLI use.
// Full flow: register → discover → verify → sync → plugin connect → event ingestion →
// task ops → dashboard config → drift → reconcile → adapter generation/update/rollback →
// releases/critical path/metrics → SSE resume → static dashboard assets.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { startServer } from "../../packages/core/src/server.ts"
import { DfcpIntegrationHost } from "../../packages/integration/src/host.ts"
import { writeGeneratedAdapter } from "../../packages/integration/src/generator.ts"
import { buildFixture } from "../fixtures/build.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
const RUNTIME = join(HERE, "..", ".runtime")
const SRC = { adapterId: "opencode", sourceId: "opencode-plugin", entityKind: "agent", authoritative: true, fetchedAt: new Date().toISOString() }

function base(name: string): string {
  const dir = join(RUNTIME, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

async function startProduct(name: string) {
  const dir = base(name)
  const host = new DfcpIntegrationHost()
  const { server } = startServer({ dataDir: join(dir, "data"), port: 0, host_integration: host })
  await new Promise(r => server.on("listening", r))
  const addr = server.address()
  const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(url + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
    const data = await res.json().catch(() => ({}))
    return { status: res.status, data }
  }
  return { dir, url, api, server, host }
}

test("E2E alpha: full product lifecycle over HTTP", async () => {
  const { dir, url, api, server } = await startProduct("e2e-alpha")
  const root = join(dir, "alpha")
  buildFixture("alpha", root)
  try {
    // 1. register (as the plugin does)
    const reg = await api("POST", "/api/projects", { id: "alpha", name: "Alpha", root })
    assert.equal(reg.status, 200)
    // 2. discover + verify
    const disc = await api("POST", "/api/projects/alpha/discover")
    assert.equal(disc.status, 200)
    assert.equal(disc.data.manifest.capabilities.task_management.status, "supported")
    assert.equal(disc.data.manifest.capabilities.merge_queue.status, "supported")
    assert.equal(disc.data.manifest.capabilities.architecture_map.status, "supported")
    // 3. sync
    const sync = await api("POST", "/api/projects/alpha/sync")
    assert.ok(sync.data.adapters["file-task-tracker"].ok)
    assert.ok(sync.data.adapters["git"].ok)
    // 4. plugin connect
    const conn = await api("POST", "/api/projects/alpha/plugin/connect", { pluginVersion: "0.1.0" })
    assert.equal(conn.data.capabilities.status, "supported")
    // 5. plugin event ingestion (session + agent lifecycle)
    const ing = await api("POST", "/api/projects/alpha/events", { events: [
      { type: "agent.registered", schemaVersion: 1, payload: { id: "oc:ses1", name: "build session", kind: "opencode" }, source: SRC, idempotencyKey: "e2e-reg-1" },
      { type: "session.started", schemaVersion: 1, payload: { id: "oc-ses:ses1", agentId: "oc:ses1", opencodeSessionId: "ses1", model: "test/model" }, source: SRC, idempotencyKey: "e2e-ses-1" },
      { type: "agent.status_changed", schemaVersion: 1, payload: { id: "oc:ses1", status: "working", taskId: "T-2", evidence: "event" }, source: SRC, idempotencyKey: "e2e-st-1" },
      { type: "agent.heartbeat", schemaVersion: 1, payload: { id: "oc:ses1", taskId: "T-2" }, source: SRC, idempotencyKey: "e2e-hb-1" },
    ] })
    assert.equal(ing.data.accepted, 4)
    // duplicate delivery is idempotent
    const dup = await api("POST", "/api/projects/alpha/events", { events: [
      { type: "agent.heartbeat", schemaVersion: 1, payload: { id: "oc:ses1", taskId: "T-2" }, source: SRC, idempotencyKey: "e2e-hb-1" },
    ] })
    assert.equal(dup.data.duplicates, 1)
    // 6. task operations (T-5 is ready and unowned; T-2 is owned by harness agent "build")
    const claim = await api("POST", "/api/projects/alpha/tasks/T-5/claim", { agent: "oc:ses1" })
    assert.equal(claim.status, 200)
    const conflict = await api("POST", "/api/projects/alpha/tasks/T-5/claim", { agent: "other" })
    assert.equal(conflict.status, 409)
    const owned = await api("POST", "/api/projects/alpha/tasks/T-2/claim", { agent: "oc:ses1" })
    assert.equal(owned.status, 409) // owned by "build" — atomic claim protection
    const done = await api("PATCH", "/api/projects/alpha/tasks/T-2", { status: "done" })
    assert.equal(done.data.task.status, "done")
    const t3 = await api("GET", "/api/projects/alpha/tasks/T-3")
    assert.equal(t3.data.task.status, "ready") // auto-unblocked
    // new task via API
    const created = await api("POST", "/api/projects/alpha/tasks", { id: "T-100", title: "E2E task", kind: "task", dependencies: ["T-3"], estimateHours: 2, acceptanceCriteria: [{ text: "works" }] })
    assert.equal(created.status, 200)
    assert.equal(created.data.task.status, "blocked")
    // 7. dashboard config reflects capabilities
    const cfg = await api("GET", "/api/projects/alpha/dashboard-config")
    const secs = Object.fromEntries(cfg.data.sections.map((s: any) => [s.id, s]))
    assert.equal(secs.tasks.visible, true)
    assert.equal(secs.agents.visible, true)
    assert.equal(secs["merge-queue"].visible, true)
    assert.equal(secs.components.visible, true)
    assert.equal(secs.pipelines.visible, false) // no CI verified
    // 8. overview / metrics / activity / critical path
    const ov = await api("GET", "/api/projects/alpha")
    assert.ok(ov.data.counts.tasks.total >= 9)
    assert.ok(ov.data.alerts.length >= 1)
    const metrics = await api("GET", "/api/projects/alpha/metrics")
    assert.equal(metrics.data.current.metrics.tasks_total, ov.data.counts.tasks.total)
    const cp = await api("GET", "/api/projects/alpha/critical-path")
    assert.ok(cp.data.layers.length > 0)
    const act = await api("GET", "/api/projects/alpha/activity?limit=10")
    assert.ok(act.data.events.length > 0)
    // 9. release + readiness
    const rel = await api("POST", "/api/projects/alpha/releases", { id: "v0.2", name: "v0.2", scopeTaskIds: ["T-3", "T-100"] })
    assert.equal(rel.status, 200)
    const rr = await api("GET", "/api/projects/alpha/releases/v0.2")
    assert.equal(rr.data.readiness.verdict, "not_ready")
    assert.ok(rr.data.readiness.coverage.some((c: string) => c.includes("CI not verified")))
    // 10. drift + reconcile (add agent definition)
    writeFileSync(join(root, ".opencode", "agent", "audit.md"), "---\ndescription: Auditor\n---\n")
    const diff = await api("GET", "/api/projects/alpha/integration/diff")
    assert.ok(diff.data.drift.changes.some((c: any) => c.kind === "agent_added"))
    const rec = await api("POST", "/api/projects/alpha/reconcile", { approve: [] })
    assert.ok(rec.data.actions.some((a: any) => a.target.startsWith("agent_added") && a.applied))
    const agents = await api("GET", "/api/projects/alpha/agents")
    assert.ok(agents.data.agents.some((a: any) => a.id === "audit"))
    // 11. SSE resume
    const ctrl = new AbortController()
    const sse = await fetch(`${url}/api/projects/alpha/stream?lastSeq=0`, { signal: ctrl.signal })
    const reader = sse.body!.getReader()
    const { value } = await reader.read()
    assert.ok(new TextDecoder().decode(value).includes("data:"))
    ctrl.abort()
    // 12. static dashboard assets
    const index = await fetch(url + "/")
    const html = await index.text()
    assert.ok(html.includes("Dark Factory Control Plane"))
    const appjs = await fetch(url + "/app.js")
    assert.equal(appjs.status, 200)
    const css = await fetch(url + "/styles.css")
    assert.equal(css.status, 200)
    // 13. doctor
    const doc = await api("GET", "/api/projects/alpha/doctor")
    assert.ok(doc.data.checks.length >= 4)
  } finally {
    server.close()
  }
})

test("E2E beta: custom harness — generation, mapping, updates, rollback over HTTP", async () => {
  const { dir, url, api, server } = await startProduct("e2e-beta")
  const root = join(dir, "beta")
  buildFixture("beta", root)
  try {
    await api("POST", "/api/projects", { id: "beta", name: "Beta", root })
    const disc = await api("POST", "/api/projects/beta/discover")
    assert.equal(disc.data.manifest.capabilities.task_management.status, "supported")
    assert.equal(disc.data.manifest.capabilities.agent_monitoring.status, "supported")
    assert.equal(disc.data.manifest.capabilities.ci_cd.status, "unavailable")
    assert.ok(disc.data.generated.length >= 2)
    assert.ok(disc.data.generated.every((g: any) => g.ok))
    await api("POST", "/api/projects/beta/sync")
    // custom statuses preserved
    const t = await api("GET", "/api/projects/beta/tasks/T-101")
    assert.equal(t.data.task.sourceStatus, "coding")
    assert.equal(t.data.task.status, "in_progress")
    // workflow shows custom stages
    const wf = await api("GET", "/api/projects/beta/workflow")
    assert.ok(wf.data.stages.some((s: any) => s.id === "verifying"))
    // dashboard: no pipelines/queue-missing honesty
    const cfg = await api("GET", "/api/projects/beta/dashboard-config")
    const secs = Object.fromEntries(cfg.data.sections.map((s: any) => [s.id, s]))
    assert.equal(secs.pipelines.visible, false)
    assert.equal(secs.tasks.visible, true)
    assert.equal(secs.agents.visible, true)
    // queue custom fields -> configure mapping via project config, then re-discover
    const cfgPath = join(root, ".dark-factory", "config", "project.json")
    const pcfg = JSON.parse(readFileSync(cfgPath, "utf8"))
    const q = pcfg.adapters.find((a: any) => a.id === "merge-queue-file")
    q.config = { ...q.config, fields: { branch: "ref", task: "ticket", state: "phase", enqueuedAt: "added" }, stateMap: { gates: "checking", done: "merged", "dead-letter": "dead_letter" } }
    writeFileSync(cfgPath, JSON.stringify(pcfg, null, 2))
    await api("POST", "/api/projects/beta/discover")
    await api("POST", "/api/projects/beta/sync")
    const mq = await api("GET", "/api/projects/beta/merge-queue")
    assert.equal(mq.data.available, true)
    assert.equal(mq.data.queue.entries.find((e: any) => e.branch === "feature/T-101").state, "checking")
    // adapter update + rollback over HTTP (versioned writer archives history)
    const genFile = join(root, ".dark-factory", "adapters", "tasks-pipe.adapter.ts")
    const original = readFileSync(genFile, "utf8")
    const spec = { name: "tasks-pipe", kind: "task-lines" as const, path: "tasks.pipe" }
    const v2 = original.replace("const STATUS_MAP = {", 'const STATUS_MAP = {"polishing": "review",')
    writeGeneratedAdapter(root, spec, v2)
    const upd = await api("POST", "/api/projects/beta/adapter/update", { adapterId: "generated:tasks-pipe" })
    assert.ok(upd.data.ok, JSON.stringify(upd.data))
    const broken = v2.replace('type: "task.created"', 'type: "task.nope"')
    writeGeneratedAdapter(root, spec, broken)
    const upd2 = await api("POST", "/api/projects/beta/adapter/update", { adapterId: "generated:tasks-pipe" })
    assert.ok(!upd2.data.ok)
    const rb = await api("POST", "/api/projects/beta/adapter/rollback", { adapterId: "generated:tasks-pipe" })
    assert.ok(rb.data.ok, JSON.stringify(rb.data))
    assert.equal(readFileSync(genFile, "utf8"), original)
    // adapter status
    const st = await api("GET", "/api/projects/beta/adapter/status")
    assert.ok(st.data.adapters.some((a: any) => a.adapterId === "generated:tasks-pipe"))
    // history preserved across everything
    const evs = await api("GET", "/api/projects/beta/events?after=0&limit=2000")
    assert.ok(evs.data.events.length > 20)
  } finally {
    server.close()
  }
})

test("E2E: unknown event types and schema violations become diagnostics, never applied", async () => {
  const { dir, api, server } = await startProduct("e2e-diag")
  const root = join(dir, "gamma")
  buildFixture("gamma", root)
  try {
    await api("POST", "/api/projects", { id: "gamma", name: "Gamma", root })
    const res = await api("POST", "/api/projects/gamma/events", { events: [
      { type: "totally.unknown", schemaVersion: 1, payload: { x: 1 }, source: SRC },
      { type: "task.created", schemaVersion: 1, payload: { id: "BAD" }, source: SRC },
      { type: "task.created", schemaVersion: 7, payload: { id: "X", title: "x" }, source: SRC },
    ] })
    assert.equal(res.data.accepted, 0)
    assert.equal(res.data.rejected.length, 3)
    const ov = await api("GET", "/api/projects/gamma")
    assert.equal(ov.data.counts.tasks.total, 0)
    assert.ok(ov.data.alerts.some((a: any) => a.message.includes("diagnostics")))
    const diag = await api("GET", "/api/projects/gamma/events?type=diagnostic.")
    assert.ok(diag.data.events.length >= 3)
  } finally {
    server.close()
  }
})
