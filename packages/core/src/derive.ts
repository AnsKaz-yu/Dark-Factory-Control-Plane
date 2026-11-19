// Derived computations — the ONLY place business analytics lives (server-side).
// Every result carries its data nature: real / computed / estimated / missing.
import type {
  Agent, AgentStatus, Capability, CapabilityId, CapabilityManifest, CriticalPathResult,
  DashboardConfig, DashboardSection, Freshness, MetricSnapshot, ProjectOverview,
  Release, ReleaseReadiness, Task, TaskTreeNode, WorkflowView,
} from "./types.ts"
import { CAPABILITY_IDS, CORE_VERSION } from "./types.ts"
import type { ProjectState } from "./projections.ts"
import { nowISO } from "./ids.ts"

// ---------- agents ----------

export const HEARTBEAT_STALE_MS = 10 * 60 * 1000

/** Effective status: a stale heartbeat downgrades activity to `unknown`, never to completed. */
export function effectiveAgentStatus(a: Agent, now = Date.now()): { status: AgentStatus; evidence: Agent["statusEvidence"]; stale: boolean } {
  const last = a.lastHeartbeatAt ?? a.lastEventAt
  const stale = last ? now - Date.parse(last) > HEARTBEAT_STALE_MS : true
  if ((a.status === "working" || a.status === "waiting" || a.status === "reviewing") && stale) {
    return { status: "unknown", evidence: "inferred", stale: true }
  }
  return { status: a.status, evidence: a.statusEvidence, stale }
}

// ---------- tasks ----------

/** Honest progress: done=100 (real); in-flight uses reported progress or marks estimate. */
export function taskProgress(t: Task): { value: number; nature: "real" | "estimated" | "missing" } {
  if (t.status === "done" || t.status === "merged") return { value: 100, nature: "real" }
  if (t.status === "cancelled") return { value: 0, nature: "missing" }
  if (t.status === "in_progress" || t.status === "review" || t.status === "verification") {
    if (t.progress !== undefined) return { value: t.progress, nature: "real" }
    return { value: 50, nature: "estimated" }
  }
  return { value: 0, nature: "real" }
}

export function buildTaskTree(state: ProjectState, filter?: (t: Task) => boolean): TaskTreeNode[] {
  const tasks = Object.values(state.tasks)
  const byParent = new Map<string | undefined, Task[]>()
  for (const t of tasks) {
    const key = t.parentId && state.tasks[t.parentId] ? t.parentId : undefined
    const arr = byParent.get(key) ?? []
    arr.push(t)
    byParent.set(key, arr)
  }
  const matches = (t: Task): boolean => !filter || filter(t)
  const subtreeMatches = (t: Task): boolean => matches(t) || (byParent.get(t.id) ?? []).some(subtreeMatches)
  function node(t: Task): TaskTreeNode {
    const children = (byParent.get(t.id) ?? []).filter(subtreeMatches).map(node)
    const all = [t, ...children.flatMap(c => collect(c))]
    const done = all.filter(x => x.status === "done" || x.status === "merged").length
    const inProgress = all.filter(x => x.status === "in_progress" || x.status === "review" || x.status === "verification").length
    const blocked = all.filter(x => x.status === "blocked").length
    // Progress reflects leaf work items; containers (epics/features with children)
    // derive their progress from descendants, not from their own status.
    const leaves = all.filter(x => !(byParent.get(x.id)?.length) && x.status !== "cancelled")
    const basis = leaves.length ? leaves : all.filter(x => x.status !== "cancelled")
    const progress = basis.length ? Math.round(basis.reduce((s, x) => s + taskProgress(x).value, 0) / basis.length) : 0
    return { task: t, children, rollup: { total: all.length, done, inProgress, blocked, progress } }
  }
  function collect(n: TaskTreeNode): Task[] { return [n.task, ...n.children.flatMap(collect)] }
  return (byParent.get(undefined) ?? []).filter(subtreeMatches).map(node)
}

// ---------- components ----------

export function componentReadiness(state: ProjectState, componentId: string): { readiness: number; nature: "computed" | "estimated" | "missing"; taskCount: number } {
  const ids = new Set<string>([componentId])
  let grew = true
  while (grew) {
    grew = false
    for (const c of Object.values(state.components)) {
      if (c.parentId && ids.has(c.parentId) && !ids.has(c.id)) { ids.add(c.id); grew = true }
    }
  }
  const tasks = Object.values(state.tasks).filter(t => t.componentId && ids.has(t.componentId) && t.status !== "cancelled")
  if (!tasks.length) {
    const c = state.components[componentId]
    if (c?.readiness !== undefined) return { readiness: c.readiness, nature: "computed", taskCount: 0 }
    return { readiness: 0, nature: "missing", taskCount: 0 }
  }
  let estimated = false
  const sum = tasks.reduce((s, t) => { const p = taskProgress(t); if (p.nature === "estimated") estimated = true; return s + p.value }, 0)
  return { readiness: Math.round(sum / tasks.length), nature: estimated ? "estimated" : "computed", taskCount: tasks.length }
}

// ---------- critical path ----------

export function criticalPath(state: ProjectState, scopeTaskIds?: string[]): CriticalPathResult {
  const tasks = Object.values(state.tasks).filter(t => t.status !== "cancelled" && t.status !== "done" && t.status !== "merged")
  const scoped = scopeTaskIds ? tasks.filter(t => scopeTaskIds.includes(t.id)) : tasks
  const ids = new Set(scoped.map(t => t.id))
  const edges: { from: string; to: string }[] = []
  for (const t of scoped) for (const d of t.dependencies) if (ids.has(d)) edges.push({ from: d, to: t.id })

  // cycle detection (DFS)
  const cycles: string[][] = []
  const color = new Map<string, number>()
  const stack: string[] = []
  const adj = new Map<string, string[]>()
  for (const e of edges) { const a = adj.get(e.from) ?? []; a.push(e.to); adj.set(e.from, a) }
  function dfs(u: string): void {
    color.set(u, 1); stack.push(u)
    for (const v of adj.get(u) ?? []) {
      const c = color.get(v) ?? 0
      if (c === 1) {
        const idx = stack.indexOf(v)
        cycles.push(stack.slice(idx).concat(v))
      } else if (c === 0) dfs(v)
    }
    stack.pop(); color.set(u, 2)
  }
  for (const id of ids) if ((color.get(id) ?? 0) === 0) dfs(id)

  // layers (longest dependency depth), cycle-safe via memo with visiting guard
  const layer = new Map<string, number>()
  const visiting = new Set<string>()
  function lay(id: string): number {
    if (layer.has(id)) return layer.get(id)!
    if (visiting.has(id)) return 0
    visiting.add(id)
    const deps = scoped.find(t => t.id === id)?.dependencies.filter(d => ids.has(d)) ?? []
    const l = deps.length ? Math.max(...deps.map(lay)) + 1 : 0
    visiting.delete(id)
    layer.set(id, l)
    return l
  }
  for (const id of ids) lay(id)

  // longest path by estimate when available, else structural (node count)
  const byId = new Map(scoped.map(t => [t.id, t]))
  const allEstimated = scoped.every(t => t.estimateHours !== undefined)
  const weight = (t: Task): number => allEstimated ? (t.estimateHours ?? 0) : 1
  const dist = new Map<string, number>()
  const prev = new Map<string, string | null>()
  const visiting2 = new Set<string>()
  function best(id: string): number {
    if (dist.has(id)) return dist.get(id)!
    if (visiting2.has(id)) return 0
    visiting2.add(id)
    const t = byId.get(id)!
    const deps = t.dependencies.filter(d => ids.has(d))
    let bestDep: string | null = null
    let bestVal = 0
    for (const d of deps) { const v = best(d); if (v > bestVal) { bestVal = v; bestDep = d } }
    const val = bestVal + weight(t)
    dist.set(id, val); prev.set(id, bestDep)
    visiting2.delete(id)
    return val
  }
  let endId: string | null = null
  let endVal = -1
  for (const id of ids) { const v = best(id); if (v > endVal) { endVal = v; endId = id } }
  const path: string[] = []
  let cur = endId
  while (cur) { path.unshift(cur); cur = prev.get(cur) ?? null }

  const notes: string[] = []
  let nature: CriticalPathResult["nature"] = "computed"
  if (!scoped.length) { nature = "missing"; notes.push("No open tasks in scope — nothing to schedule.") }
  else if (!allEstimated) { nature = "estimated"; notes.push("Duration estimates missing for some tasks: showing STRUCTURAL longest path (by task count), not a time forecast.") }
  if (cycles.length) { nature = "estimated"; notes.push(`Dependency cycles detected (${cycles.length}): path is approximate.`) }
  if (scoped.some(t => t.status === "blocked")) notes.push("Blocked tasks included; their wait time is not estimated.")

  return {
    nature, path, lengthHours: allEstimated && scoped.length ? endVal : undefined,
    layers: [...ids].map(id => ({ taskId: id, layer: layer.get(id) ?? 0 })),
    edges, notes, cycles,
  }
}

// ---------- releases ----------

export function releaseReadiness(state: ProjectState, release: Release, caps: CapabilityManifest | null): ReleaseReadiness {
  const scope = release.scopeTaskIds.map(id => state.tasks[id]).filter(Boolean) as Task[]
  const done = scope.filter(t => t.status === "done" || t.status === "merged").length
  const blocked = scope.filter(t => t.status === "blocked").length
  const inProgress = scope.filter(t => ["in_progress", "review", "verification"].includes(t.status)).length
  const blockers: { taskId: string; reason: string }[] = []
  for (const t of scope) {
    if (t.status === "done" || t.status === "merged" || t.status === "cancelled") continue
    for (const d of t.dependencies) {
      const dep = state.tasks[d]
      if (!dep) { blockers.push({ taskId: t.id, reason: `dependency ${d} not found` }); continue }
      if (dep.status !== "done" && dep.status !== "merged" && dep.status !== "cancelled" && !release.scopeTaskIds.includes(d)) {
        blockers.push({ taskId: t.id, reason: `external dependency ${d} is ${dep.status}` })
      }
    }
    if (t.status === "blocked") blockers.push({ taskId: t.id, reason: "task is blocked" })
  }
  const checks: ReleaseReadiness["checks"] = []
  const coverage: string[] = []
  checks.push({ name: "scope tasks complete", ok: scope.length > 0 && done === scope.filter(t => t.status !== "cancelled").length, evidence: `${done}/${scope.length} done` })
  checks.push({ name: "no open blockers", ok: blockers.length === 0, evidence: blockers.length ? `${blockers.length} blockers` : "none" })
  coverage.push("task scope status")

  const ciCap = caps?.capabilities.ci_cd
  if (ciCap && (ciCap.status === "supported" || ciCap.status === "partial")) {
    const scopeRuns = Object.values(state.runs).filter(r => r.taskId && release.scopeTaskIds.includes(r.taskId))
    const lastByTask = new Map<string, typeof scopeRuns[number]>()
    for (const r of scopeRuns) { const ex = lastByTask.get(r.taskId!); if (!ex || (r.startedAt ?? "") > (ex.startedAt ?? "")) lastByTask.set(r.taskId!, r) }
    const failing = [...lastByTask.values()].filter(r => r.status === "failed")
    checks.push({ name: "scope pipelines green", ok: failing.length === 0, evidence: failing.length ? `${failing.length} failing runs` : `${lastByTask.size} runs checked` })
    coverage.push("CI runs linked to scope tasks")
  } else {
    coverage.push("CI not verified — pipeline health not assessed")
  }
  const mqCap = caps?.capabilities.merge_queue
  if (mqCap && (mqCap.status === "supported" || mqCap.status === "partial") && state.queue) {
    const pending = state.queue.entries.filter(e => e.taskId && release.scopeTaskIds.includes(e.taskId) && e.state !== "merged")
    checks.push({ name: "scope merges drained", ok: pending.length === 0, evidence: pending.length ? `${pending.length} pending` : "queue clear for scope" })
    coverage.push("merge queue for scope tasks")
  } else {
    coverage.push("merge queue not verified — integration state not assessed")
  }

  const verdict: ReleaseReadiness["verdict"] = !scope.length ? "insufficient_data" : checks.every(c => c.ok) ? "ready" : "not_ready"
  return { releaseId: release.id, verdict, nature: verdict === "insufficient_data" ? "missing" : "computed", tasks: { total: scope.length, done, blocked, inProgress }, blockers, checks, coverage }
}

// ---------- workflow ----------

export function workflowView(state: ProjectState, caps: CapabilityManifest | null): WorkflowView {
  const cap = caps?.capabilities.workflow_stages
  const observable = (cap?.details?.observableStages as string[] | undefined) ?? []
  const limitations = cap?.limitations ?? []
  // stages: explicit observed stages, else union of statuses seen in transitions + current
  let stages = state.workflowStages
  if (!stages.length) {
    const seen = new Set<string>()
    for (const tr of Object.values(state.transitions)) { seen.add(tr.from); seen.add(tr.to) }
    for (const t of Object.values(state.tasks)) seen.add(t.status)
    stages = [...seen].map(id => ({ id, label: id, observed: true }))
  }
  const counts = new Map<string, number>()
  for (const t of Object.values(state.tasks)) counts.set(t.status, (counts.get(t.status) ?? 0) + 1)
  return {
    stages: stages.map(s => ({ ...s, taskCount: counts.get(s.id) ?? 0 })),
    transitions: Object.values(state.transitions).sort((a, b) => b.count - a.count),
    observableStages: observable.length ? observable : stages.filter(s => s.observed).map(s => s.id),
    limitations,
  }
}

// ---------- metrics ----------

export function computeMetrics(state: ProjectState, caps: CapabilityManifest | null, now = Date.now()): MetricSnapshot {
  const metrics: Record<string, number | null> = {}
  const coverage: Record<string, string> = {}
  const tasks = Object.values(state.tasks)
  const day = 86400000
  const windowStart = now - 7 * day

  const doneLast7 = tasks.filter(t => (t.status === "done" || t.status === "merged") && t.history.some(h => h.field === "status" && (h.to === "done" || h.to === "merged") && Date.parse(h.at) >= windowStart))
  metrics.throughput_7d = doneLast7.length
  coverage.throughput_7d = "tasks reaching done/merged in last 7 days (from event history)"

  const leadTimes = tasks.filter(t => t.status === "done" || t.status === "merged").map(t => Date.parse(t.updatedAt) - Date.parse(t.createdAt)).filter(x => x >= 0)
  metrics.lead_time_hours_avg = leadTimes.length ? Math.round(leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length / 3600000 * 10) / 10 : null
  coverage.lead_time_hours_avg = leadTimes.length ? `created→done over ${leadTimes.length} completed tasks` : "no completed tasks yet"

  metrics.wip = tasks.filter(t => ["in_progress", "review", "verification"].includes(t.status)).length
  metrics.blocked = tasks.filter(t => t.status === "blocked").length
  metrics.tasks_total = tasks.length
  coverage.wip = "current snapshot"
  coverage.blocked = "current snapshot"

  const agents = Object.values(state.agents)
  const working = agents.filter(a => effectiveAgentStatus(a, now).status === "working").length
  metrics.agents_working = working
  metrics.agents_total = agents.length
  coverage.agents_working = "effective status (stale heartbeats count as unknown, not working)"

  const runs = Object.values(state.runs).sort((a, b) => (a.startedAt ?? "") < (b.startedAt ?? "") ? 1 : -1).slice(0, 20)
  const finished = runs.filter(r => r.status === "success" || r.status === "failed")
  metrics.pipeline_success_rate = finished.length ? Math.round(finished.filter(r => r.status === "success").length / finished.length * 1000) / 10 : null
  coverage.pipeline_success_rate = finished.length ? `last ${finished.length} finished runs` : "no CI runs observed"

  if (state.queue) {
    const waits = state.queue.entries.filter(e => e.waitMs !== undefined).map(e => e.waitMs!)
    metrics.queue_wait_avg_min = waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length / 60000 * 10) / 10 : null
    metrics.queue_depth = state.queue.entries.filter(e => e.state !== "merged").length
    coverage.queue_wait_avg_min = waits.length ? `${waits.length} entries with wait data` : "no wait data yet"
  } else {
    metrics.queue_wait_avg_min = null
    metrics.queue_depth = null
    coverage.queue_depth = "merge queue not observed"
  }
  return { at: nowISO(), metrics, coverage }
}

// ---------- dashboard config ----------

const SECTION_DEFS: { id: string; title: string; route: string; capability: CapabilityId | null }[] = [
  { id: "overview", title: "Overview", route: "/", capability: null },
  { id: "tasks", title: "Tasks", route: "/tasks", capability: "task_management" },
  { id: "task-tree", title: "Task Tree", route: "/tasks/tree", capability: "task_hierarchy" },
  { id: "agents", title: "Agents", route: "/agents", capability: "agent_monitoring" },
  { id: "workflow", title: "Workflow", route: "/workflow", capability: "workflow_stages" },
  { id: "pipelines", title: "CI/CD Pipelines", route: "/pipelines", capability: "ci_cd" },
  { id: "merge-queue", title: "Merge Queue", route: "/merge-queue", capability: "merge_queue" },
  { id: "critical-path", title: "Critical Path", route: "/critical-path", capability: "critical_path" },
  { id: "releases", title: "Releases", route: "/releases", capability: "release_planning" },
  { id: "components", title: "Components", route: "/components", capability: "architecture_map" },
  { id: "metrics", title: "Metrics", route: "/metrics", capability: "metrics" },
  { id: "activity", title: "Activity", route: "/activity", capability: "activity_events" },
  { id: "integrations", title: "Integrations", route: "/integrations", capability: null },
  { id: "settings", title: "Settings", route: "/settings", capability: null },
]

export function dashboardConfig(projectId: string, projectName: string, caps: CapabilityManifest | null, freshness: Record<string, Freshness>): DashboardConfig {
  const sections: DashboardSection[] = SECTION_DEFS.map(s => {
    if (!s.capability) return { ...s, visible: true, mode: "full", limitations: [] }
    const cap = caps?.capabilities[s.capability]
    if (!cap) return { ...s, visible: false, mode: "unavailable", limitations: ["capability not assessed"] }
    switch (cap.status) {
      case "supported": return { ...s, visible: true, mode: "full", limitations: cap.limitations }
      case "partial": return { ...s, visible: true, mode: "partial", limitations: cap.limitations }
      case "stale":
      case "degraded": return { ...s, visible: true, mode: "partial", limitations: [...cap.limitations, `source ${cap.status} — data may be outdated`] }
      case "not_configured": return { ...s, visible: false, mode: "unavailable", limitations: ["mechanism exists but is not connected"] }
      default: return { ...s, visible: false, mode: "unavailable", limitations: cap.limitations.length ? cap.limitations : ["no verified source"] }
    }
  })
  // Task Tree falls back to tasks capability when hierarchy itself is unavailable but tasks exist
  const tree = sections.find(s => s.id === "task-tree")!
  const tasksCap = caps?.capabilities.task_management
  if (!tree.visible && tasksCap && (tasksCap.status === "supported" || tasksCap.status === "partial")) {
    tree.visible = true; tree.mode = "partial"; tree.limitations = ["hierarchy not verified — flat list shown"]
  }
  const overviewCards = SECTION_DEFS.filter(s => s.capability && sections.find(x => x.id === s.id)?.visible)
    .map(s => ({ id: s.id, capability: s.capability!, title: s.title }))
  return { projectId, projectName, generatedAt: nowISO(), sections, overviewCards, freshness }
}

// ---------- overview ----------

export function projectOverview(state: ProjectState, caps: CapabilityManifest | null, freshness: Record<string, Freshness>): ProjectOverview {
  const tasks = Object.values(state.tasks)
  const byStatus: Record<string, number> = {}
  for (const t of tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1
  const agents = Object.values(state.agents).map(a => ({ a, eff: effectiveAgentStatus(a) }))
  const runs = Object.values(state.runs).sort((a, b) => (a.startedAt ?? "") < (b.startedAt ?? "") ? 1 : -1)
  const activeRelease = Object.values(state.releases).filter(r => r.status !== "released" && r.status !== "cancelled").sort((a, b) => a.createdAt < b.createdAt ? 1 : -1)[0] ?? null
  const alerts: ProjectOverview["alerts"] = []
  const now = nowISO()
  for (const [adapterId, f] of Object.entries(freshness)) {
    if (f.degraded) alerts.push({ severity: "error", message: `adapter ${adapterId} degraded: ${f.error ?? "errors"}`, at: f.lastSyncAt ?? now })
    else if (f.stale) alerts.push({ severity: "warning", message: `adapter ${adapterId} stale (last success ${f.lastSuccessAt ?? "never"})`, at: f.lastSyncAt ?? now })
  }
  for (const t of tasks.filter(x => x.status === "blocked").slice(0, 5)) {
    alerts.push({ severity: "warning", message: `task ${t.id} blocked (${t.dependencies.join(", ") || "no deps recorded"})`, at: t.updatedAt })
  }
  for (const r of runs.slice(0, 3).filter(r => r.status === "failed")) {
    alerts.push({ severity: "error", message: `pipeline run ${r.id} failed${r.error ? ": " + r.error : ""}`, at: r.finishedAt ?? r.startedAt ?? now })
  }
  if (state.queue) for (const e of state.queue.entries.filter(x => x.state === "dead_letter" || x.state === "conflict").slice(0, 3)) {
    alerts.push({ severity: "error", message: `merge queue ${e.branch}: ${e.state}${e.reason ? " — " + e.reason : ""}`, at: e.updatedAt })
  }
  if (state.diagnostics.unknownEvents + state.diagnostics.schemaViolations > 0) {
    alerts.push({ severity: "warning", message: `event diagnostics: ${state.diagnostics.unknownEvents} unknown, ${state.diagnostics.schemaViolations} schema violations`, at: now })
  }
  const cpCap = caps?.capabilities.critical_path
  const cp = cpCap && cpCap.status !== "unavailable" && cpCap.status !== "not_configured" ? criticalPath(state) : null
  return {
    project: state.project ?? { id: "", name: "", root: "", registeredAt: now, coreVersion: CORE_VERSION },
    capabilities: caps ?? emptyManifest(state.project?.id ?? ""),
    counts: {
      tasks: { total: tasks.length, byStatus },
      agents: { total: agents.length, working: agents.filter(x => x.eff.status === "working").length, unknown: agents.filter(x => x.eff.status === "unknown").length },
      queue: state.queue ? { waiting: state.queue.entries.filter(e => e.state === "waiting" || e.state === "checking" || e.state === "ready").length, inFlight: state.queue.entries.some(e => e.state === "merging") } : null,
      pipelines: caps?.capabilities.ci_cd?.status === "unavailable" ? null : { lastRun: runs[0] ?? null },
      releases: activeRelease ? { active: activeRelease, readiness: releaseReadiness(state, activeRelease, caps) } : null,
    },
    criticalPath: cp,
    alerts,
    freshness,
  }
}

export function emptyManifest(projectId: string): CapabilityManifest {
  const capabilities = {} as CapabilityManifest["capabilities"]
  for (const id of CAPABILITY_IDS) {
    capabilities[id] = {
      id, status: "unknown", operations: [], events: [], observableStates: [],
      limitations: ["not assessed yet — run factory:discover"], lastSyncAt: null,
      confidence: "inferred", contractVersion: 1,
    }
  }
  return { projectId, generatedAt: nowISO(), generatorVersion: CORE_VERSION, contractVersion: 1, capabilities, sources: [] }
}
