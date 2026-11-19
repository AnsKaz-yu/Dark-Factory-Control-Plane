// Adaptive Integration Layer — integration tests on synthetic harnesses.
// Covers: discovery, capability verification, adapter selection/generation, composite
// sources, drift detection (A/B/C), reconciliation, failure isolation, updates/rollback,
// history preservation, multi-project isolation, uninstall.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { createServer, type Server } from "node:http"
import { ProjectManager } from "../../packages/core/src/store.ts"
import { DfcpIntegrationHost } from "../../packages/integration/src/host.ts"
import { detectDrift } from "../../packages/integration/src/fingerprint.ts"
import { readProjectConfig, writeProjectConfig, uninstall } from "../../packages/integration/src/install.ts"
import { writeGeneratedAdapter } from "../../packages/integration/src/generator.ts"
import { buildFixture, type FixtureKind } from "../fixtures/build.ts"
import { dashboardConfig } from "../../packages/core/src/derive.ts"
import { sha256 } from "../../packages/core/src/ids.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
const RUNTIME = join(HERE, "..", ".runtime")

function runtime(name: string): string {
  const dir = join(RUNTIME, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

function setup(kind: FixtureKind, name: string, id: string): { manager: ProjectManager; host: DfcpIntegrationHost; root: string; store: ReturnType<ProjectManager["get"]> } {
  const base = runtime(name)
  const root = join(base, id)
  // disposable fixtures: always start from a clean slate
  rmSync(root, { recursive: true, force: true })
  rmSync(join(base, "dfcp-data"), { recursive: true, force: true })
  buildFixture(kind, root)
  const manager = new ProjectManager(join(base, "dfcp-data"))
  const host = new DfcpIntegrationHost()
  const store = manager.create(id, id, root)
  return { manager, host, root, store }
}

async function fullSetup(kind: FixtureKind, name: string, id: string) {
  const s = setup(kind, name, id)
  await s.host.discover(s.store)
  await s.host.sync(s.store)
  return s
}

function mockJenkins(): Promise<{ server: Server; url: string }> {
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      const url = req.url ?? ""
      res.setHeader("Content-Type", "application/json")
      if (url.startsWith("/api/json")) {
        res.end(JSON.stringify({ jobs: [{ name: "alpha-build", url: "http://x/job/alpha-build", color: "blue" }] }))
      } else if (url.includes("/wfapi/describe")) {
        res.end(JSON.stringify({ stages: [{ name: "Build", status: "SUCCESS" }, { name: "Test", status: "SUCCESS" }, { name: "Lint", status: "IN_PROGRESS" }] }))
      } else if (url.includes("/job/alpha-build/api/json")) {
        res.end(JSON.stringify({ builds: [
          { number: 41, result: "SUCCESS", timestamp: Date.parse("2026-11-19T07:00:00Z"), duration: 300000, building: false, actions: [{ causes: [{ shortDescription: "Started by user, branch feature/T-2" }] }] },
          { number: 42, result: null, timestamp: Date.parse("2026-11-19T08:00:00Z"), duration: 0, building: true, actions: [{ causes: [{ shortDescription: "branch feature/T-3" }] }] },
        ] }))
      } else { res.statusCode = 404; res.end("{}") }
    })
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      resolve({ server, url: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}` })
    })
  })
}

// ---------- 1. Project A: standard harness ----------
test("A: discovery detects tools; setup verifies capabilities; sync ingests real data", async () => {
  const { host, store, root } = await fullSetup("alpha", "a-setup", "alpha")
  const disc = store.getDiscovery()!
  assert.ok(disc.detectedTools.includes("git"))
  assert.ok(disc.detectedTools.includes("opencode"))
  assert.ok(disc.detectedTools.includes("file-task-tracker"))
  assert.ok(disc.detectedTools.includes("jenkins"))
  assert.ok(disc.detectedTools.includes("custom-merge-queue"))
  assert.ok(disc.detectedTools.includes("likec4"))
  assert.ok(disc.evidences.length >= 8)
  assert.ok(disc.agentsFound.some(a => a.name === "build"))

  const caps = store.getCapabilities().capabilities
  assert.equal(caps.task_management.status, "supported")
  assert.equal(caps.task_management.confidence, "verified")
  assert.equal(caps.merge_queue.status, "supported")
  assert.equal(caps.architecture_map.status, "supported")
  assert.equal(caps.git_monitoring.status, "supported")
  // honest: Jenkinsfile found but no endpoint configured -> not verified as supported
  assert.notEqual(caps.ci_cd.status, "supported")
  // honest: OpenCode plugin not connected yet
  assert.equal(caps.agent_monitoring.status, "not_configured")

  // synced data
  assert.equal(Object.keys(store.state.tasks).length, 8)
  const t2 = store.state.tasks["T-2"]
  assert.equal(t2.status, "in_progress")
  assert.equal(t2.sourceStatus, "in-progress") // original preserved
  assert.equal(t2.mapping.original.id, "T-2")
  assert.deepEqual(t2.dependencies, ["T-1"])
  assert.equal(t2.parentId, "F-1")
  assert.equal(store.state.tasks["T-4"].status, "blocked")
  assert.ok(store.state.queue)
  assert.equal(store.state.queue!.entries.length, 3)
  assert.equal(store.state.queue!.entries.find(e => e.branch === "feature/T-9")!.state, "dead_letter")
  assert.ok(store.state.components.api)
  assert.ok(store.state.architecture?.available)
  assert.ok(store.state.branches["feature/T-2"])
  assert.deepEqual(store.state.branches["feature/T-2"].taskIds, ["T-2"])
  // workflow stages observed from source statuses
  assert.ok(store.state.workflowStages.some(s => s.id === "in-progress"))
  // integration dir created inside target, harness untouched
  assert.ok(existsSync(join(root, ".dark-factory", "config", "project.json")))
  assert.ok(existsSync(join(root, ".dark-factory", "generated", "install-manifest.json")))
})

test("A: plugin connection upgrades agent_monitoring; agent events flow; dashboard config reacts", async () => {
  const { host, store } = await fullSetup("alpha", "a-plugin", "alpha")
  await host.notePluginConnection(store, { pluginVersion: "0.1.0" })
  assert.equal(store.getCapabilities().capabilities.agent_monitoring.status, "supported")
  // plugin pushes events via core API (simulated)
  store.ingest([
    { type: "agent.registered", schemaVersion: 1, payload: { id: "ses-1", name: "build", kind: "opencode", role: "build agent" }, source: { adapterId: "opencode", sourceId: "opencode", entityKind: "agent", authoritative: true, fetchedAt: new Date().toISOString() } },
    { type: "session.started", schemaVersion: 1, payload: { id: "s1", agentId: "ses-1", opencodeSessionId: "ses_abc", model: "test/model" }, source: { adapterId: "opencode", sourceId: "opencode", entityKind: "session", authoritative: true, fetchedAt: new Date().toISOString() } },
    { type: "agent.status_changed", schemaVersion: 1, payload: { id: "ses-1", status: "working", taskId: "T-2", evidence: "event" }, source: { adapterId: "opencode", sourceId: "opencode", entityKind: "agent", authoritative: true, fetchedAt: new Date().toISOString() } },
  ])
  assert.equal(store.state.agents["ses-1"].status, "working")
  assert.equal(store.state.agents["ses-1"].model, "test/model")
  const cfg = dashboardConfig("alpha", "Alpha", store.getCapabilities(), store.freshness())
  const agents = cfg.sections.find(s => s.id === "agents")!
  assert.equal(agents.visible, true)
  assert.equal(agents.mode, "full")
})

test("A: Jenkins adapter against mock API — pipelines, runs, stages; capability upgrade", async () => {
  const { host, store, root } = await fullSetup("alpha", "a-jenkins", "alpha")
  const { server, url } = await mockJenkins()
  try {
    const cfg = readProjectConfig(root)!
    cfg.adapters.push({ id: "jenkins", config: { url } })
    writeProjectConfig(root, cfg)
    await host.discover(store)
    assert.equal(store.getCapabilities().capabilities.ci_cd.status, "supported")
    await host.sync(store)
    const runs = Object.values(store.state.runs)
    assert.equal(runs.length, 2)
    const r41 = runs.find(r => r.number === 41)!
    assert.equal(r41.status, "success")
    assert.equal(r41.stages.length, 3)
    assert.equal(r41.taskId, "T-2")
    const r42 = runs.find(r => r.number === 42)!
    assert.equal(r42.status, "running")
    const cfg2 = dashboardConfig("alpha", "Alpha", store.getCapabilities(), store.freshness())
    assert.equal(cfg2.sections.find(s => s.id === "pipelines")!.visible, true)
  } finally { server.close() }
})

// ---------- 2. Project B: custom harness, adapter generation ----------
test("B: unknown harness -> generated adapters; custom statuses preserved; composite sources", async () => {
  const { host, store, root } = await fullSetup("beta", "b-setup", "beta")
  const disc = store.getDiscovery()!
  assert.ok(disc.detectedTools.includes("custom-task-format"))
  assert.ok(disc.detectedTools.includes("custom-agent-registry"))
  assert.ok(!disc.detectedTools.includes("opencode"))
  // generated adapters were created + contract-tested + activated
  const genDir = join(root, ".dark-factory", "adapters")
  const genFiles = readdirSync(genDir).filter((f: string) => f.endsWith(".adapter.ts"))
  assert.ok(genFiles.length >= 2, `expected >=2 generated adapters, got ${genFiles}`)
  const caps = store.getCapabilities().capabilities
  assert.equal(caps.task_management.status, "supported")
  assert.equal(caps.agent_monitoring.status, "supported")
  assert.equal(caps.ci_cd.status, "unavailable")
  assert.equal(caps.architecture_map.status, "unavailable")
  // custom statuses normalized, originals preserved
  const t101 = store.state.tasks["T-101"]
  assert.equal(t101.sourceStatus, "coding")
  assert.equal(t101.status, "in_progress")
  assert.equal(store.state.tasks["T-104"].sourceStatus, "integrating")
  assert.equal(store.state.tasks["T-104"].status, "merged")
  assert.equal(store.state.tasks["T-100"].status, "done")
  assert.deepEqual(t101.dependencies, ["T-100"])
  assert.equal(t101.estimateHours, 6)
  // agents from custom registry
  assert.equal(store.state.agents["welder-1"].status, "working")
  assert.equal(store.state.agents["welder-1"].currentTaskId, "T-101")
  assert.equal(store.state.agents["painter-1"].status, "waiting")
  // workflow shows CUSTOM stages, not a canonical pipeline
  const wf = store.state.workflowStages.map(s => s.id)
  assert.ok(wf.includes("coding"))
  assert.ok(wf.includes("verifying"))
  assert.ok(wf.includes("shipped"))
  // event feed ingested (generic-events)
  assert.ok(store.state.recentActivity.some(e => e.eventId === "beta-ev-1" || (e.payload as Record<string, unknown>).note === "arc stable"))
  // queue: custom fields -> partial until mapping configured (honest)
  const mq = caps.merge_queue
  assert.ok(mq.status === "partial" || mq.status === "supported")
})

test("B: custom queue field mapping configured -> supported; dead-letter reasons visible", async () => {
  const { host, store, root } = await fullSetup("beta", "b-queue", "beta")
  const cfg = readProjectConfig(root)!
  const q = cfg.adapters.find(a => a.id === "merge-queue-file")!
  q.config = { ...q.config, fields: { branch: "ref", task: "ticket", state: "phase", enqueuedAt: "added" }, stateMap: { gates: "checking", done: "merged", "dead-letter": "dead_letter" } }
  writeProjectConfig(root, cfg)
  await host.discover(store)
  await host.sync(store)
  assert.equal(store.getCapabilities().capabilities.merge_queue.status, "supported")
  const entries = store.state.queue!.entries
  assert.equal(entries.find(e => e.branch === "feature/T-101")!.state, "checking")
  assert.equal(entries.find(e => e.branch === "feature/T-100")!.state, "merged")
  assert.equal(entries.find(e => e.branch === "feature/T-999")!.reason, "gate-fail")
})

// ---------- 3. Drift detection + reconciliation ----------
test("drift A: new agent definition -> detected, auto-reconciled (category A)", async () => {
  const { host, store, root } = await fullSetup("alpha", "drift-agent", "alpha")
  writeFileSync(join(root, ".opencode", "agent", "security.md"), "---\ndescription: Security reviewer\n---\nAudit.\n")
  const drift = detectDrift(store)
  assert.ok(!drift.unchanged)
  const added = drift.changes.find(c => c.kind === "agent_added")
  assert.ok(added)
  assert.equal(added!.category, "A")
  const res = await host.reconcile(store) as { actions: { target: string; applied: boolean }[] }
  const action = res.actions.find(a => a.target.startsWith("agent_added"))
  assert.ok(action?.applied)
  assert.ok(store.state.agents["security"])
  // baseline refreshed -> no drift now
  assert.ok(detectDrift(store).unchanged)
})

test("drift B: new workflow status -> mapping revisited, original preserved, history kept", async () => {
  const { host, store, root } = await fullSetup("alpha", "drift-stage", "alpha")
  const tasksPath = join(root, "tasks.json")
  const doc = JSON.parse(readFileSync(tasksPath, "utf8"))
  doc.tasks.push({ id: "T-7", title: "Security scan", status: "scanning", priority: "P1" })
  doc.tasks[2].status = "scanning" // T-1 moves to a brand-new stage
  writeFileSync(tasksPath, JSON.stringify(doc, null, 2))
  const eventsBefore = store.events.count()
  const drift = detectDrift(store)
  const stageChange = drift.changes.find(c => c.kind === "workflow_stage_added")
  assert.ok(stageChange)
  assert.equal(stageChange!.category, "B")
  const res = await host.reconcile(store) as { manifestUpdated: boolean; verified: boolean }
  assert.ok(res.manifestUpdated)
  await host.sync(store)
  const t7 = store.state.tasks["T-7"]
  assert.equal(t7.sourceStatus, "scanning")
  assert.equal(t7.status, "unknown") // unmapped -> honest unknown, NOT invented
  assert.equal(t7.mapping.confidence, "unmapped")
  assert.ok(store.getCapabilities().capabilities.task_management.limitations.some(l => l.includes("scanning")))
  // history preserved: events only grew; the modified task kept its history
  assert.ok(store.events.count() > eventsBefore)
  assert.ok(store.state.tasks["T-1"].history.length > 0)
})

test("drift C: CI config removed -> requires approval; approved -> applied", async () => {
  const { host, store, root } = await fullSetup("alpha", "drift-ci", "alpha")
  rmSync(join(root, "Jenkinsfile"))
  const drift = detectDrift(store)
  const removed = drift.changes.find(c => c.kind === "ci_removed")
  assert.ok(removed)
  assert.equal(removed!.category, "C")
  const res1 = await host.reconcile(store) as { actions: { target: string; applied: boolean; requiresApproval: boolean }[] }
  const action1 = res1.actions.find(a => a.target.startsWith("ci_removed"))
  assert.ok(action1?.requiresApproval)
  assert.ok(!action1?.applied)
  const res2 = await host.reconcile(store, { approve: [action1!.target] }) as { actions: { target: string; applied: boolean }[] }
  const action2 = res2.actions.find(a => a.target.startsWith("ci_removed"))
  assert.ok(action2?.applied)
})

test("drift: tracker data-only change is category A (economical, no structural churn)", async () => {
  const { store, root } = await fullSetup("alpha", "drift-data", "alpha")
  const p = join(root, "tasks.json")
  const doc = JSON.parse(readFileSync(p, "utf8"))
  doc.tasks[1].progress = 55 // data change only
  writeFileSync(p, JSON.stringify(doc, null, 2))
  const drift = detectDrift(store)
  const dataChange = drift.changes.find(c => c.kind === "tracker_data_changed")
  assert.ok(dataChange)
  assert.equal(dataChange!.category, "A")
  assert.ok(!drift.changes.some(c => c.category === "C"))
})

// ---------- 4. Failure isolation ----------
test("failure isolation: broken tracker degrades only its capabilities; others keep working", async () => {
  const { host, store, root } = await fullSetup("alpha", "isolation", "alpha")
  writeFileSync(join(root, "tasks.json"), "{broken json!!")
  const res = await host.sync(store) as { adapters: Record<string, { ok: boolean }> }
  assert.equal(res.adapters["file-task-tracker"].ok, false)
  assert.equal(res.adapters["git"].ok, true)
  assert.equal(res.adapters["merge-queue-file"].ok, true)
  const caps = store.getCapabilities().capabilities
  assert.equal(caps.task_management.status, "degraded")
  assert.equal(caps.git_monitoring.status, "supported")
  assert.equal(caps.merge_queue.status, "supported")
  const cfg = dashboardConfig("alpha", "Alpha", store.getCapabilities(), store.freshness())
  const tasks = cfg.sections.find(s => s.id === "tasks")!
  assert.equal(tasks.mode, "partial") // visible but flagged, not fake-operational
  assert.ok(tasks.limitations.some(l => l.includes("degraded")))
  assert.equal(cfg.sections.find(s => s.id === "merge-queue")!.mode, "full")
  // historical task data still present (never destroyed)
  assert.ok(store.state.tasks["T-1"])
})

// ---------- 5. Updates + rollback ----------
test("generated adapter update: contract-tested activation; broken update refused; rollback works", async () => {
  const { host, store, root } = await fullSetup("beta", "updates", "beta")
  const genDir = join(root, ".dark-factory", "adapters")
  const files: string[] = readdirSync(genDir).filter((f: string) => f.endsWith(".adapter.ts"))
  const taskAdapterFile = files.find(f => f.includes("tasks-pipe"))!
  const name = taskAdapterFile.replace(".adapter.ts", "")
  const adapterId = "generated:" + name
  const spec = { name, kind: "task-lines" as const, path: "tasks.pipe" }
  const original = readFileSync(join(genDir, taskAdapterFile), "utf8")
  // v2: extend status map with a new custom stage (written via the versioned writer -> history archived)
  const v2 = original.replace("const STATUS_MAP = {", 'const STATUS_MAP = {"polishing": "review",')
  assert.notEqual(v2, original)
  writeGeneratedAdapter(root, spec, v2)
  const upd = await host.adapterUpdate(store, adapterId) as { ok: boolean; version?: string; detail?: string }
  assert.ok(upd.ok, JSON.stringify(upd))
  const integ = store.getIntegration()
  const active = integ.versions.filter(v => v.adapterId === adapterId && v.status === "active")
  assert.equal(active.length, 1)
  assert.ok(integ.versions.some(v => v.adapterId === adapterId && v.status === "superseded"))
  // broken v3: emits invalid events -> contract test must refuse activation
  const broken = v2.replace('type: "task.created"', 'type: "task.bogus_type"')
  writeGeneratedAdapter(root, spec, broken)
  const upd2 = await host.adapterUpdate(store, adapterId) as { ok: boolean; detail: string }
  assert.ok(!upd2.ok)
  assert.ok(upd2.detail.includes("contract"))
  // rollback restores the previous working version (v1, archived in history/)
  const rollback = await host.rollback(store, adapterId) as { ok: boolean; detail: string }
  assert.ok(rollback.ok, rollback.detail)
  const restored = readFileSync(join(genDir, taskAdapterFile), "utf8")
  assert.equal(restored, original)
  assert.ok(!restored.includes("task.bogus_type"))
  const integ2 = store.getIntegration()
  const active2 = integ2.versions.filter(v => v.adapterId === adapterId && v.status === "active")
  assert.equal(active2.length, 1)
  assert.equal(active2[0].checksum, sha256(original))
})

// ---------- 6. History preservation + recovery ----------
test("history survives drift, reconciliation and process restart (replay)", async () => {
  const { host, store, root, manager } = await fullSetup("alpha", "history", "alpha")
  const before = store.events.count()
  writeFileSync(join(root, ".opencode", "agent", "extra.md"), "---\ndescription: Extra\n---\n")
  await host.reconcile(store)
  await host.sync(store)
  const after = store.events.count()
  assert.ok(after > before)
  const t1History = store.state.tasks["T-1"].history.length
  // restart: fresh manager over the same data dir
  const manager2 = new ProjectManager(join(runtime("history"), "dfcp-data"))
  const store2 = manager2.get("alpha")
  assert.equal(store2.events.count(), after)
  assert.equal(store2.state.tasks["T-1"].history.length, t1History)
  assert.ok(store2.state.agents["extra"])
  assert.equal(store2.state.tasks["T-2"].sourceStatus, "in-progress")
})

// ---------- 7. Bare project + multi-project isolation ----------
test("C: bare project — honest unavailable capabilities, minimal dashboard", async () => {
  const { store } = await fullSetup("gamma", "bare", "gamma")
  const caps = store.getCapabilities().capabilities
  assert.equal(caps.git_monitoring.status, "supported")
  assert.equal(caps.task_management.status, "unavailable")
  assert.equal(caps.ci_cd.status, "unavailable")
  assert.equal(caps.merge_queue.status, "unavailable")
  assert.equal(caps.agent_monitoring.status, "unavailable")
  const cfg = dashboardConfig("gamma", "Gamma", store.getCapabilities(), store.freshness())
  const visible = cfg.sections.filter(s => s.visible).map(s => s.id)
  assert.deepEqual(visible.sort(), ["activity", "integrations", "overview", "settings"].sort())
})

test("multi-project isolation: three projects, separate state/config/capabilities", async () => {
  const base = runtime("multi")
  rmSync(base, { recursive: true, force: true })
  mkdirSync(base, { recursive: true })
  const manager = new ProjectManager(join(base, "dfcp-data"))
  const host = new DfcpIntegrationHost()
  for (const [kind, id] of [["alpha", "alpha"], ["beta", "beta"], ["gamma", "gamma"]] as [FixtureKind, string][]) {
    const root = join(base, id)
    buildFixture(kind, root)
    const s = manager.create(id, id, root)
    await host.discover(s)
    await host.sync(s)
  }
  const a = manager.get("alpha"), b = manager.get("beta"), g = manager.get("gamma")
  assert.ok(a.state.tasks["T-1"])
  assert.ok(!a.state.tasks["T-101"])
  assert.ok(b.state.tasks["T-101"])
  assert.ok(!b.state.tasks["T-1"])
  assert.equal(Object.keys(g.state.tasks).length, 0)
  assert.equal(a.getCapabilities().capabilities.architecture_map.status, "supported")
  assert.equal(b.getCapabilities().capabilities.architecture_map.status, "unavailable")
  assert.equal(manager.listIds().length, 3)
})

// ---------- 8. Authoritative source strategy ----------
test("authoritative source: auxiliary tracker cannot overwrite authoritative tasks", async () => {
  const { host, store, root } = await fullSetup("alpha", "auth-src", "alpha")
  const originalTitle = store.state.tasks["T-1"].title
  // auxiliary custom-format tracker with conflicting data for T-1 + a new task T-99
  writeFileSync(join(root, "shadow.pipe"), "T-1 | HIJACKED | done | | 1\nT-99 | aux only | queued | | 1\n")
  const cfg = readProjectConfig(root)!
  cfg.sources.task_management = { authoritative: "file-task-tracker", conflict: "authoritative-wins" }
  writeProjectConfig(root, cfg)
  const gen = await host.generateAdapter(store, { name: "shadow-pipe", kind: "task-lines", path: "shadow.pipe", statusMap: { queued: "ready", done: "done" } }) as { ok: boolean }
  assert.ok(gen.ok)
  await host.sync(store)
  // T-1 must NOT be hijacked by the auxiliary source
  assert.equal(store.state.tasks["T-1"].title, originalTitle)
  assert.equal(store.state.tasks["T-1"].source.adapterId, "file-task-tracker")
  // auxiliary MAY introduce entities the authoritative source doesn't have
  assert.ok(store.state.tasks["T-99"])
  assert.equal(store.state.tasks["T-99"].source.adapterId, "generated:shadow-pipe")
  assert.equal(store.state.tasks["T-99"].source.authoritative, false)
})

// ---------- 9. Uninstall ----------
test("uninstall removes only .dark-factory; harness files intact", async () => {
  const { store, root } = await fullSetup("beta", "uninstall", "beta")
  assert.ok(existsSync(join(root, ".dark-factory")))
  const res = uninstall(root)
  assert.ok(res.removed.length > 0)
  assert.equal(res.errors.length, 0)
  assert.ok(!existsSync(join(root, ".dark-factory")))
  assert.ok(existsSync(join(root, "tasks.pipe")))
  assert.ok(existsSync(join(root, "crew-state.json")))
  assert.ok(existsSync(join(root, ".git")))
})
