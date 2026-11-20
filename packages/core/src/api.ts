// REST API + SSE. Thin handlers over ProjectStore; integration operations are injected
// (IntegrationHost) so the core stays standalone and testable without the integration layer.
import type { IncomingMessage, ServerResponse } from "node:http"
import { resolve } from "node:path"
import type { EventEnvelope, IngestResult, Task } from "./types.ts"
import { CORE_VERSION, TASK_STATUSES, PRIORITIES, TASK_KINDS } from "./types.ts"
import type { ProjectManager, ProjectStore } from "./store.ts"
import {
  buildTaskTree, componentReadiness, computeMetrics, criticalPath, dashboardConfig,
  effectiveAgentStatus, projectOverview, releaseReadiness, repoActivity, workflowView,
} from "./derive.ts"
import { nowISO } from "./ids.ts"

export interface IntegrationHost {
  discover(store: ProjectStore): Promise<unknown>
  sync(store: ProjectStore): Promise<unknown>
  reconcile(store: ProjectStore, opts?: { approve?: string[] }): Promise<unknown>
  adapterUpdate(store: ProjectStore, adapterId: string): Promise<unknown>
  adapterStatus(store: ProjectStore): unknown
  integrationDiff(store: ProjectStore): Promise<unknown>
  notePluginConnection?(store: ProjectStore, info: { pluginVersion?: string; lastEventAt?: string }): Promise<unknown>
  generateAdapter?(store: ProjectStore, spec: Record<string, unknown>): Promise<unknown>
  rollback?(store: ProjectStore, adapterId: string): Promise<unknown>
}

interface Ctx {
  req: IncomingMessage
  res: ServerResponse
  params: Record<string, string>
  query: URLSearchParams
  body: Record<string, unknown>
  manager: ProjectManager
  host: IntegrationHost | null
}

type Handler = (ctx: Ctx) => Promise<void> | void

interface Route { method: string; parts: string[]; handler: Handler }
const routes: Route[] = []
function route(method: string, pattern: string, handler: Handler): void {
  routes.push({ method, parts: pattern.split("/").filter(Boolean), handler })
}

function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data)
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(body) })
  res.end(body)
}
const ok = (ctx: Ctx, data: unknown) => json(ctx.res, 200, data)
const bad = (ctx: Ctx, msg: string, status = 400) => json(ctx.res, status, { error: msg })

function store(ctx: Ctx): ProjectStore | null {
  const id = ctx.params.id
  if (!ctx.manager.has(id)) { bad(ctx, `project not found: ${id}`, 404); return null }
  return ctx.manager.get(id)
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on("data", (c: Buffer) => {
      size += c.length
      if (size > 8 * 1024 * 1024) { reject(new Error("body too large")); req.destroy(); return }
      chunks.push(c)
    })
    req.on("end", () => {
      if (!chunks.length) return resolve({})
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))) } catch { reject(new Error("invalid JSON body")) }
    })
    req.on("error", reject)
  })
}

// ---------------- health / projects ----------------

route("GET", "/api/health", ctx => ok(ctx, { ok: true, coreVersion: CORE_VERSION, at: nowISO(), projects: ctx.manager.listIds() }))

route("GET", "/api/projects", ctx => {
  ok(ctx, ctx.manager.list().map(s => ({
    project: s.state.project, tasks: Object.keys(s.state.tasks).length,
    agents: Object.keys(s.state.agents).length, lastEventAt: s.state.lastEventAt,
    capabilitiesVerified: Object.values(s.getCapabilities().capabilities).filter(c => c.confidence === "verified").length,
  })))
})

route("POST", "/api/projects", ctx => {
  const { id, name, root } = ctx.body as { id?: string; name?: string; root?: string }
  if (!name || !root) return bad(ctx, "name and root are required")
  // Root-based dedup: one root = one project, regardless of who registers it
  // (plugin hash-id vs CLI slug must not create duplicate projects).
  const want = resolve(root)
  for (const s of ctx.manager.list()) {
    if (s.state.project && resolve(s.state.project.root) === want) {
      return ok(ctx, { project: s.state.project, dedup: true })
    }
  }
  const projectId = id ?? name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  if (!/^[a-z0-9][a-z0-9-_]*$/.test(projectId)) return bad(ctx, "id must be lowercase slug")
  const s = ctx.manager.create(projectId, name, root)
  ok(ctx, { project: s.state.project })
})

route("GET", "/api/projects/:id", ctx => {
  const s = store(ctx); if (!s) return
  ok(ctx, projectOverview(s.state, s.getCapabilities(), s.freshness()))
})

// ---------------- events ----------------

route("POST", "/api/projects/:id/events", ctx => {
  const s = store(ctx); if (!s) return
  const events = (ctx.body.events ?? (Array.isArray(ctx.body) ? ctx.body : null)) as Partial<EventEnvelope>[] | null
  if (!Array.isArray(events)) return bad(ctx, "body must be {events: [...]}")
  const result: IngestResult = s.ingest(events)
  ok(ctx, result)
})

route("GET", "/api/projects/:id/events", ctx => {
  const s = store(ctx); if (!s) return
  const after = Number(ctx.query.get("after") ?? 0)
  const limit = Math.min(Number(ctx.query.get("limit") ?? 200), 2000)
  const type = ctx.query.get("type")
  let evs = s.events.after(after)
  if (type) evs = evs.filter(e => e.type.startsWith(type))
  ok(ctx, { events: evs.slice(0, limit), lastSeq: s.events.lastSeq() })
})

route("GET", "/api/projects/:id/stream", ctx => {
  const s = store(ctx); if (!s) return
  const res = ctx.res
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" })
  const lastSeq = Number(ctx.query.get("lastSeq") ?? ctx.req.headers["last-event-id"] ?? 0)
  // resume: replay missed events, then go live
  for (const e of s.events.after(lastSeq)) res.write(`id: ${e.seq}\ndata: ${JSON.stringify({ seq: e.seq, type: e.type, eventId: e.eventId })}\n\n`)
  res.write(`data: ${JSON.stringify({ type: "hello", lastSeq: s.events.lastSeq() })}\n\n`)
  const off = s.events.onAppend(e => {
    try { res.write(`id: ${e.seq}\ndata: ${JSON.stringify({ seq: e.seq, type: e.type, eventId: e.eventId })}\n\n`) } catch { /* closed */ }
  })
  const ping = setInterval(() => { try { res.write(": ping\n\n") } catch { /* closed */ } }, 15000)
  ctx.req.on("close", () => { off(); clearInterval(ping) })
})

// ---------------- tasks ----------------

function taskFilter(query: URLSearchParams): (t: Task) => boolean {
  const status = query.get("status"), kind = query.get("kind"), priority = query.get("priority")
  const assignee = query.get("assignee"), component = query.get("component"), q = query.get("q")?.toLowerCase()
  return t =>
    (!status || t.status === status) && (!kind || t.kind === kind) && (!priority || t.priority === priority) &&
    (!assignee || t.assignee === assignee) && (!component || t.componentId === component) &&
    (!q || t.id.toLowerCase().includes(q) || t.title.toLowerCase().includes(q) || (t.description ?? "").toLowerCase().includes(q))
}

route("GET", "/api/projects/:id/tasks", ctx => {
  const s = store(ctx); if (!s) return
  const tasks = Object.values(s.state.tasks).filter(taskFilter(ctx.query)).sort((a, b) => a.id.localeCompare(b.id))
  ok(ctx, { tasks, total: tasks.length })
})

route("POST", "/api/projects/:id/tasks", ctx => {
  const s = store(ctx); if (!s) return
  const b = ctx.body
  if (!b.id || !b.title) return bad(ctx, "id and title required")
  if (s.state.tasks[b.id as string]) return bad(ctx, `task already exists: ${b.id}`, 409)
  if (b.status && !TASK_STATUSES.includes(b.status as never)) return bad(ctx, "invalid status")
  if (b.priority && !PRIORITIES.includes(b.priority as never)) return bad(ctx, "invalid priority")
  if (b.kind && !TASK_KINDS.includes(b.kind as never)) return bad(ctx, "invalid kind")
  try {
    s.emit("task.created", b as Record<string, unknown>, { source: { adapterId: "api", sourceId: "api", entityKind: "task", authoritative: true, fetchedAt: nowISO() } })
    ok(ctx, { task: s.state.tasks[b.id as string] })
  } catch (e) { bad(ctx, String((e as Error).message)) }
})

route("GET", "/api/projects/:id/task-tree", ctx => {
  const s = store(ctx); if (!s) return
  ok(ctx, { tree: buildTaskTree(s.state, taskFilter(ctx.query)) })
})

route("GET", "/api/projects/:id/tasks/:taskId", ctx => {
  const s = store(ctx); if (!s) return
  const t = s.state.tasks[ctx.params.taskId]
  if (!t) return bad(ctx, "task not found", 404)
  const dependents = Object.values(s.state.tasks).filter(x => x.dependencies.includes(t.id)).map(x => x.id)
  const sessions = Object.values(s.state.sessions).filter(x => x.taskIds.includes(t.id))
  ok(ctx, { task: t, dependents, sessions })
})

route("PATCH", "/api/projects/:id/tasks/:taskId", ctx => {
  const s = store(ctx); if (!s) return
  const t = s.state.tasks[ctx.params.taskId]
  if (!t) return bad(ctx, "task not found", 404)
  const b = ctx.body
  if (b.status && !TASK_STATUSES.includes(b.status as never)) return bad(ctx, "invalid status")
  try {
    if (b.status !== undefined && b.status !== t.status) {
      s.emit("task.status_changed", { id: t.id, from: t.status, to: b.status, sourceStatus: b.sourceStatus, actor: b.actor ?? "api" })
    }
    const rest = { ...b }; delete rest.status; delete rest.sourceStatus; delete rest.actor
    if (Object.keys(rest).length) s.emit("task.updated", { id: t.id, ...rest, actor: b.actor ?? "api" })
    ok(ctx, { task: s.state.tasks[t.id] })
  } catch (e) { bad(ctx, String((e as Error).message)) }
})

route("POST", "/api/projects/:id/tasks/:taskId/claim", ctx => {
  const s = store(ctx); if (!s) return
  const t = s.state.tasks[ctx.params.taskId]
  if (!t) return bad(ctx, "task not found", 404)
  const agent = ctx.body.agent as string
  if (!agent) return bad(ctx, "agent required")
  if (t.status === "done" || t.status === "cancelled") return bad(ctx, `task is ${t.status}`, 409)
  if (t.assignee && t.assignee !== agent && t.status === "in_progress") return bad(ctx, `already claimed by ${t.assignee}`, 409)
  const blocked = t.dependencies.some(d => s.state.tasks[d] && !["done", "cancelled", "merged"].includes(s.state.tasks[d].status))
  if (blocked) return bad(ctx, "task is blocked (dependencies not done)", 409)
  s.emit("task.claimed", { id: t.id, agent })
  ok(ctx, { task: s.state.tasks[t.id] })
})

route("POST", "/api/projects/:id/tasks/:taskId/release", ctx => {
  const s = store(ctx); if (!s) return
  const t = s.state.tasks[ctx.params.taskId]
  if (!t) return bad(ctx, "task not found", 404)
  s.emit("task.released", { id: t.id })
  ok(ctx, { task: s.state.tasks[t.id] })
})

// ---------------- agents / sessions ----------------

route("GET", "/api/projects/:id/agents", ctx => {
  const s = store(ctx); if (!s) return
  const agents = Object.values(s.state.agents).map(a => ({ ...a, effective: effectiveAgentStatus(a) }))
  ok(ctx, { agents })
})

route("GET", "/api/projects/:id/agents/:agentId", ctx => {
  const s = store(ctx); if (!s) return
  const a = s.state.agents[ctx.params.agentId]
  if (!a) return bad(ctx, "agent not found", 404)
  const sessions = Object.values(s.state.sessions).filter(x => x.agentId === a.id)
  const timeline = s.events.all().filter(e => (e.payload as Record<string, unknown>).id === a.id || (e.payload as Record<string, unknown>).agentId === a.id).slice(-100)
  ok(ctx, { agent: { ...a, effective: effectiveAgentStatus(a) }, sessions, timeline })
})

// ---------------- workflow / git / ci / queue ----------------

route("GET", "/api/projects/:id/workflow", ctx => {
  const s = store(ctx); if (!s) return
  ok(ctx, workflowView(s.state, s.getCapabilities()))
})

route("GET", "/api/projects/:id/git", ctx => {
  const s = store(ctx); if (!s) return
  ok(ctx, { branches: Object.values(s.state.branches), commits: s.state.commits.slice(0, 200), pullRequests: Object.values(s.state.pullRequests), activity: repoActivity(s.state, s.events.all()) })
})

route("GET", "/api/projects/:id/pipelines", ctx => {
  const s = store(ctx); if (!s) return
  const runs = Object.values(s.state.runs).sort((a, b) => (a.startedAt ?? "") < (b.startedAt ?? "") ? 1 : -1)
  ok(ctx, { pipelines: Object.values(s.state.pipelines), runs })
})

route("GET", "/api/projects/:id/pipelines/:runId", ctx => {
  const s = store(ctx); if (!s) return
  const r = s.state.runs[ctx.params.runId]
  if (!r) return bad(ctx, "run not found", 404)
  ok(ctx, { run: r })
})

route("GET", "/api/projects/:id/merge-queue", ctx => {
  const s = store(ctx); if (!s) return
  const cap = s.getCapabilities().capabilities.merge_queue
  if (!s.state.queue) return ok(ctx, { available: false, capability: cap, queue: null })
  ok(ctx, { available: true, capability: cap, queue: s.state.queue })
})

// ---------------- releases / critical path ----------------

route("GET", "/api/projects/:id/critical-path", ctx => {
  const s = store(ctx); if (!s) return
  const releaseId = ctx.query.get("releaseId")
  const release = releaseId ? s.state.releases[releaseId] : undefined
  const scope = release?.scopeTaskIds
  ok(ctx, criticalPath(s.state, scope, { targetDate: release?.targetDate }))
})

route("GET", "/api/projects/:id/releases", ctx => {
  const s = store(ctx); if (!s) return
  const caps = s.getCapabilities()
  ok(ctx, { releases: Object.values(s.state.releases).map(r => ({ ...r, readiness: releaseReadiness(s.state, r, caps) })) })
})

route("POST", "/api/projects/:id/releases", ctx => {
  const s = store(ctx); if (!s) return
  const b = ctx.body
  if (!b.id || !b.name) return bad(ctx, "id and name required")
  if (s.state.releases[b.id as string]) return bad(ctx, "release already exists", 409)
  try {
    s.emit("release.created", b as Record<string, unknown>)
    ok(ctx, { release: s.state.releases[b.id as string] })
  } catch (e) { bad(ctx, String((e as Error).message)) }
})

route("GET", "/api/projects/:id/releases/:rid", ctx => {
  const s = store(ctx); if (!s) return
  const r = s.state.releases[ctx.params.rid]
  if (!r) return bad(ctx, "release not found", 404)
  ok(ctx, { release: r, readiness: releaseReadiness(s.state, r, s.getCapabilities()), criticalPath: criticalPath(s.state, r.scopeTaskIds, { targetDate: r.targetDate }) })
})

route("PATCH", "/api/projects/:id/releases/:rid", ctx => {
  const s = store(ctx); if (!s) return
  const r = s.state.releases[ctx.params.rid]
  if (!r) return bad(ctx, "release not found", 404)
  try {
    s.emit("release.updated", { id: r.id, ...ctx.body })
    if (ctx.body.status === "released") s.emit("release.released", { id: r.id, tag: ctx.body.tag })
    ok(ctx, { release: s.state.releases[r.id] })
  } catch (e) { bad(ctx, String((e as Error).message)) }
})

// ---------------- components / architecture / metrics / activity ----------------

route("GET", "/api/projects/:id/components", ctx => {
  const s = store(ctx); if (!s) return
  const components = Object.values(s.state.components).map(c => ({ ...c, derived: componentReadiness(s.state, c.id) }))
  ok(ctx, { components })
})

route("GET", "/api/projects/:id/architecture", ctx => {
  const s = store(ctx); if (!s) return
  ok(ctx, s.state.architecture ?? { available: false, elements: [], relations: [], views: [], message: "No architecture source connected. Connect LikeC4 (or another source) via an adapter to see the component map." })
})

route("GET", "/api/projects/:id/metrics", ctx => {
  const s = store(ctx); if (!s) return
  ok(ctx, { current: computeMetrics(s.state, s.getCapabilities()), history: s.state.metricSnapshots, repoActivity: repoActivity(s.state, s.events.all()) })
})

route("GET", "/api/projects/:id/activity", ctx => {
  const s = store(ctx); if (!s) return
  const after = Number(ctx.query.get("after") ?? 0)
  const limit = Math.min(Number(ctx.query.get("limit") ?? 100), 1000)
  const type = ctx.query.get("type")
  const entity = ctx.query.get("entity")
  let evs = s.events.after(after)
  if (type) evs = evs.filter(e => e.type.startsWith(type))
  if (entity) evs = evs.filter(e => JSON.stringify(e.payload).includes(entity))
  ok(ctx, { events: evs.slice(-limit).reverse(), lastSeq: s.events.lastSeq() })
})

// ---------------- capabilities / dashboard / integration ----------------

route("GET", "/api/projects/:id/capabilities", ctx => {
  const s = store(ctx); if (!s) return
  ok(ctx, s.getCapabilities())
})

route("GET", "/api/projects/:id/dashboard-config", ctx => {
  const s = store(ctx); if (!s) return
  ok(ctx, dashboardConfig(s.id, s.state.project?.name ?? s.id, s.getCapabilities(), s.freshness()))
})

route("GET", "/api/projects/:id/integrations", ctx => {
  const s = store(ctx); if (!s) return
  const integ = s.getIntegration()
  ok(ctx, { ...integ, freshness: s.freshness(), fingerprint: s.getFingerprint(), discovery: s.getDiscovery() })
})

route("GET", "/api/projects/:id/doctor", ctx => {
  const s = store(ctx); if (!s) return
  ok(ctx, s.doctor())
})

route("POST", "/api/projects/:id/discover", async ctx => {
  const s = store(ctx); if (!s) return
  if (!ctx.host) return bad(ctx, "integration layer not attached", 501)
  ok(ctx, await ctx.host.discover(s))
})

route("POST", "/api/projects/:id/sync", async ctx => {
  const s = store(ctx); if (!s) return
  if (!ctx.host) return bad(ctx, "integration layer not attached", 501)
  ok(ctx, await ctx.host.sync(s))
})

route("POST", "/api/projects/:id/reconcile", async ctx => {
  const s = store(ctx); if (!s) return
  if (!ctx.host) return bad(ctx, "integration layer not attached", 501)
  ok(ctx, await ctx.host.reconcile(s, { approve: (ctx.body.approve as string[]) ?? [] }))
})

route("POST", "/api/projects/:id/adapter/update", async ctx => {
  const s = store(ctx); if (!s) return
  if (!ctx.host) return bad(ctx, "integration layer not attached", 501)
  const adapterId = ctx.body.adapterId as string
  if (!adapterId) return bad(ctx, "adapterId required")
  ok(ctx, await ctx.host.adapterUpdate(s, adapterId))
})

route("GET", "/api/projects/:id/adapter/status", ctx => {
  const s = store(ctx); if (!s) return
  if (!ctx.host) return bad(ctx, "integration layer not attached", 501)
  ok(ctx, ctx.host.adapterStatus(s))
})

route("GET", "/api/projects/:id/integration/diff", async ctx => {
  const s = store(ctx); if (!s) return
  if (!ctx.host) return bad(ctx, "integration layer not attached", 501)
  ok(ctx, await ctx.host.integrationDiff(s))
})

route("POST", "/api/projects/:id/plugin/connect", async ctx => {
  const s = store(ctx); if (!s) return
  if (!ctx.host?.notePluginConnection) return bad(ctx, "integration layer not attached", 501)
  ok(ctx, await ctx.host.notePluginConnection(s, { pluginVersion: ctx.body.pluginVersion as string, lastEventAt: ctx.body.lastEventAt as string }))
})

route("POST", "/api/projects/:id/adapter/generate", async ctx => {
  const s = store(ctx); if (!s) return
  if (!ctx.host?.generateAdapter) return bad(ctx, "integration layer not attached", 501)
  ok(ctx, await ctx.host.generateAdapter(s, ctx.body))
})

route("POST", "/api/projects/:id/adapter/rollback", async ctx => {
  const s = store(ctx); if (!s) return
  if (!ctx.host?.rollback) return bad(ctx, "integration layer not attached", 501)
  const adapterId = ctx.body.adapterId as string
  if (!adapterId) return bad(ctx, "adapterId required")
  ok(ctx, await ctx.host.rollback(s, adapterId))
})

// ---------------- router ----------------

export async function handleApi(req: IncomingMessage, res: ServerResponse, manager: ProjectManager, host: IntegrationHost | null): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost")
  const pathname = url.pathname
  if (!pathname.startsWith("/api/")) return false
  const parts = pathname.split("/").filter(Boolean)
  for (const r of routes) {
    if (r.method !== req.method) continue
    if (r.parts.length !== parts.length) continue
    const params: Record<string, string> = {}
    let match = true
    for (let i = 0; i < r.parts.length; i++) {
      const rp = r.parts[i]
      if (rp.startsWith(":")) params[rp.slice(1)] = decodeURIComponent(parts[i])
      else if (rp !== parts[i]) { match = false; break }
    }
    if (!match) continue
    let body: Record<string, unknown> = {}
    if (req.method === "POST" || req.method === "PATCH" || req.method === "PUT") {
      try { body = await readBody(req) } catch (e) { json(res, 400, { error: String((e as Error).message) }); return true }
    }
    try {
      await r.handler({ req, res, params, query: url.searchParams, body, manager, host })
    } catch (e) {
      json(res, 500, { error: String((e as Error).message ?? e) })
    }
    return true
  }
  json(res, 404, { error: `no such API route: ${req.method} ${pathname}` })
  return true
}
