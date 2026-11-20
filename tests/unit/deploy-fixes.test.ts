// Regression tests for clean-deploy friction fixes (F1, F5, F7, F9, F14/F15, F16).
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { startServer } from "../../packages/core/src/server.ts"
import { DfcpIntegrationHost } from "../../packages/integration/src/host.ts"
import { apply, initialState } from "../../packages/core/src/projections.ts"
import { makeEnvelope } from "../../packages/core/src/events.ts"
import { likec4Adapter } from "../../packages/adapters/src/likec4.ts"
import { makeContext } from "../../packages/adapters/src/index.ts"
import { installKit, uninstall, ensureLayout, readProjectConfig } from "../../packages/integration/src/install.ts"
import { ProjectManager } from "../../packages/core/src/store.ts"

const SRC = { adapterId: "opencode", sourceId: "p", entityKind: "agent", authoritative: true, fetchedAt: "2026-11-20T00:00:00Z" }
const tmp = () => mkdtempSync(join(tmpdir(), "dfcp-fix-"))
function gitBinary(): string {
  for (const c of ["git", "C:\\Program Files\\Git\\cmd\\git.exe"]) {
    try { execFileSync(c, ["--version"], { stdio: "ignore", windowsHide: true }); return c } catch { /* next */ }
  }
  throw new Error("git missing")
}

test("F1: root-based dedup — plugin hash-id and CLI slug resolve to one project", async () => {
  const dir = tmp()
  const root = join(dir, "proj"); mkdirSync(root, { recursive: true })
  const { server } = startServer({ dataDir: join(dir, "data"), port: 0, host_integration: new DfcpIntegrationHost() })
  await new Promise(r => server.on("listening", r))
  const port = (server.address() as { port: number }).port
  const api = async (m: string, p: string, b?: unknown) => (await fetch(`http://127.0.0.1:${port}${p}`, { method: m, headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined })).json()
  try {
    const a = await api("POST", "/api/projects", { id: "proj", name: "Proj", root })
    const b = await api("POST", "/api/projects", { id: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", name: "Proj", root })
    assert.equal(b.project.id, a.project.id)
    assert.equal(b.dedup, true)
    const list = await api("GET", "/api/projects")
    assert.equal(list.length, 1)
  } finally { server.close(); rmSync(dir, { recursive: true, force: true }) }
})

test("F1b: merged-duplicate alias keeps older clients working", async () => {
  const dir = tmp()
  const root = join(dir, "proj"); mkdirSync(root, { recursive: true })
  const { server } = startServer({ dataDir: join(dir, "data"), port: 0, host_integration: new DfcpIntegrationHost() })
  await new Promise(r => server.on("listening", r))
  const port = (server.address() as { port: number }).port
  const api = async (m: string, p: string, b?: unknown) => (await fetch(`http://127.0.0.1:${port}${p}`, { method: m, headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined })).json()
  try {
    await api("POST", "/api/projects", { id: "canon", name: "Canon", root })
    const al = await api("POST", "/api/projects/canon/aliases", { alias: "oldhashid" })
    assert.equal(al.target, "canon")
    const ov = await api("GET", "/api/projects/oldhashid")
    assert.equal(ov.project.id, "canon")
    const ing = await api("POST", "/api/projects/oldhashid/events", { events: [{ type: "activity.note", schemaVersion: 1, payload: { text: "via alias" }, source: { adapterId: "t", sourceId: "t", entityKind: "activity", authoritative: true, fetchedAt: new Date().toISOString() } }] })
    assert.equal(ing.accepted, 1)
  } finally { server.close(); rmSync(dir, { recursive: true, force: true }) }
})

test("F7: heartbeat and session.started auto-register agents unknown to the registry", () => {
  let s = initialState()
  s = apply(s, makeEnvelope({ projectId: "p", type: "agent.heartbeat", schemaVersion: 1, payload: { id: "oc:late", taskId: "T1" }, source: SRC, seq: 1 }))
  assert.ok(s.agents["oc:late"])
  assert.equal(s.agents["oc:late"].status, "working")
  assert.equal(s.agents["oc:late"].statusEvidence, "heartbeat")
  assert.equal(s.agents["oc:late"].kind, "opencode")
  s = apply(s, makeEnvelope({ projectId: "p", type: "session.started", schemaVersion: 1, payload: { id: "s2", agentId: "oc:late2", model: "m" }, source: SRC, seq: 2 }))
  assert.ok(s.agents["oc:late2"])
  assert.equal(s.agents["oc:late2"].sessionId, "s2")
})

test("F5: likec4 adapter unwraps {projects:[...]} export format", async () => {
  const dir = tmp()
  writeFileSync(join(dir, "model.json"), JSON.stringify({ projects: [{ elements: { a: { id: "a", title: "A" } }, relations: {}, views: { v: { id: "v", title: "V", nodes: [{ id: "a" }], edges: [] } } }] }))
  const ctx = makeContext({ projectId: "p", projectRoot: dir, integrationDir: join(dir, ".dark-factory"), config: { modelPath: "model.json" } })
  const probe = await likec4Adapter.probe(ctx)
  assert.ok(probe.ok)
  assert.equal(probe.capabilities.architecture_map?.status, "supported")
  const { events } = await likec4Adapter.collect(ctx)
  assert.ok(events.some(e => e.type === "architecture.map"))
  rmSync(dir, { recursive: true, force: true })
})

test("F16: ensureLayout adds local-only git exclude; project config stores no absolute root", async () => {
  const dir = tmp()
  const git = gitBinary()
  execFileSync(git, ["init", "-b", "main", dir], { stdio: "ignore", windowsHide: true })
  ensureLayout(dir)
  const exclude = readFileSync(join(dir, ".git", "info", "exclude"), "utf8")
  assert.ok(exclude.split("\n").some(l => l.trim() === ".dark-factory/"))
  const host = new DfcpIntegrationHost()
  const mgr = new ProjectManager(join(dir, "data"))
  const store = mgr.create("demo", "Demo", dir)
  await host.discover(store)
  const cfg = readProjectConfig(dir)!
  assert.equal((cfg as unknown as Record<string, unknown>).root, undefined)
  assert.equal(cfg.rootName, dir.split(/[\\/]/).filter(Boolean).pop())
  const raw = readFileSync(join(dir, ".dark-factory", "config", "project.json"), "utf8")
  assert.ok(!raw.includes(dir.replace(/\\/g, "\\\\")))
  rmSync(dir, { recursive: true, force: true })
})

test("F8b: nested container keys (tasks as object-of-objects) are detected and parsed", async () => {
  const dir = tmp()
  writeFileSync(join(dir, "project-state.json"), JSON.stringify({ schemaVersion: 1, subtitle: "x", tasks: { T1: { title: "one", status: "in-progress", blockedBy: [] }, T2: { title: "two", status: "done" } }, agents: {} }))
  const { fileTaskTrackerAdapter } = await import("../../packages/adapters/src/file-task-tracker.ts")
  const ctx = makeContext({ projectId: "p", projectRoot: dir, integrationDir: join(dir, ".dark-factory"), config: { path: "project-state.json" } })
  const probe = await fileTaskTrackerAdapter.probe(ctx)
  assert.ok(probe.ok)
  assert.equal(probe.capabilities.task_management?.status, "supported")
  assert.equal(probe.capabilities.task_management?.details?.taskCount, 2)
  const { events } = await fileTaskTrackerAdapter.collect(ctx)
  const created = events.filter(e => e.type === "task.created")
  assert.equal(created.length, 2)
  assert.ok(created.some(e => (e.payload as Record<string, unknown>).id === "T1" && (e.payload as Record<string, unknown>).sourceStatus === "in-progress"))
  rmSync(dir, { recursive: true, force: true })
})

test("F8c: re-discover refreshes a stale empty source selection to a better candidate", async () => {
  const dir = tmp()
  writeFileSync(join(dir, "tasks-old.json"), JSON.stringify({ tasks: {} }))
  writeFileSync(join(dir, "tasks-rich.json"), JSON.stringify({ tasks: { T1: { title: "one", status: "ready" }, T2: { title: "two", status: "done" } } }))
  const idir = join(dir, ".dark-factory")
  mkdirSync(join(idir, "config"), { recursive: true })
  writeFileSync(join(idir, "config", "project.json"), JSON.stringify({ projectId: "p", name: "P", rootName: "p", adapters: [{ id: "file-task-tracker", config: { path: "tasks-old.json" } }], permissions: { allowStructural: true, allowWrite: false, allowMaintenance: true }, sources: {} }))
  const host = new DfcpIntegrationHost()
  const mgr = new ProjectManager(join(dir, "data"))
  const store = mgr.create("p", "P", dir)
  const res = await host.discover(store) as { manifest: { capabilities: Record<string, { details?: { taskCount?: number } }> } }
  assert.equal(res.manifest.capabilities.task_management.details?.taskCount, 2)
  const cfg = readProjectConfig(dir)!
  assert.equal(cfg.adapters.find(a => a.id === "file-task-tracker")?.config.path, "tasks-rich.json")
  rmSync(dir, { recursive: true, force: true })
})

test("F14/F15: uninstall removes tracked kit files and reverts exclude; refuses untracked paths", () => {
  const dir = tmp()
  const git = gitBinary()
  execFileSync(git, ["init", "-b", "main", dir], { stdio: "ignore", windowsHide: true })
  writeFileSync(join(dir, "harness.txt"), "do not touch")
  ensureLayout(dir)
  const kitDir = join(dir, "kit")
  mkdirSync(join(kitDir, "agent"), { recursive: true })
  mkdirSync(join(kitDir, "skills", "factory-x"), { recursive: true })
  writeFileSync(join(kitDir, "agent", "factory-x.md"), "agent")
  writeFileSync(join(kitDir, "skills", "factory-x", "SKILL.md"), "skill")
  const kit = installKit(dir, kitDir)
  assert.equal(kit.installed.length, 2)
  assert.ok(existsSync(join(dir, ".opencode", "agent", "factory-x.md")))
  const res = uninstall(dir)
  assert.equal(res.errors.length, 0)
  assert.ok(!existsSync(join(dir, ".opencode", "agent", "factory-x.md")))
  assert.ok(!existsSync(join(dir, ".opencode", "skills", "factory-x")))
  assert.ok(!existsSync(join(dir, ".dark-factory")))
  assert.ok(existsSync(join(dir, "harness.txt")))
  const exclude = readFileSync(join(dir, ".git", "info", "exclude"), "utf8")
  assert.ok(!exclude.split("\n").some(l => l.trim() === ".dark-factory/"))
  rmSync(dir, { recursive: true, force: true })
})
