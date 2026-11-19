// State projections: pure reducers over the event log. All business rules live here
// (single implementation — the UI never recomputes domain logic).
import type {
  Agent, AgentSession, ArchitectureMap, Branch, Commit, Component, EventEnvelope,
  MergeQueue, MergeQueueEntry, MetricSnapshot, Pipeline, PipelineRun, Project,
  PullRequest, Release, Task, TaskHistoryEntry, TaskStatus, WorkflowTransition,
} from "./types.ts"
import { nowISO } from "./ids.ts"

export interface ProjectState {
  project: Project | null
  tasks: Record<string, Task>
  agents: Record<string, Agent>
  sessions: Record<string, AgentSession>
  components: Record<string, Component>
  branches: Record<string, Branch>
  commits: Commit[]
  pullRequests: Record<string, PullRequest>
  pipelines: Record<string, Pipeline>
  runs: Record<string, PipelineRun>
  queue: MergeQueue | null
  releases: Record<string, Release>
  workflowStages: { id: string; label: string; observed: boolean }[]
  transitions: Record<string, WorkflowTransition>
  architecture: ArchitectureMap | null
  recentActivity: EventEnvelope[]
  metricSnapshots: MetricSnapshot[]
  diagnostics: { unknownEvents: number; schemaViolations: number; corruptLogLines: number; lastErrors: { at: string; message: string }[] }
  lastEventAt: string | null
}

export function initialState(): ProjectState {
  return {
    project: null, tasks: {}, agents: {}, sessions: {}, components: {}, branches: {},
    commits: [], pullRequests: {}, pipelines: {}, runs: {}, queue: null, releases: {},
    workflowStages: [], transitions: {}, architecture: null, recentActivity: [],
    metricSnapshots: [],
    diagnostics: { unknownEvents: 0, schemaViolations: 0, corruptLogLines: 0, lastErrors: [] },
    lastEventAt: null,
  }
}

const HISTORY_CAP = 100
const ACTIVITY_CAP = 300
const COMMITS_CAP = 1000
const METRICS_CAP = 500

function pushHistory(t: Task, e: EventEnvelope, field: string, from: unknown, to: unknown, actor?: string): void {
  if (JSON.stringify(from) === JSON.stringify(to)) return
  const entry: TaskHistoryEntry = { at: e.occurredAt, eventId: e.eventId, field, from, to, actor }
  t.history.push(entry)
  if (t.history.length > HISTORY_CAP) t.history.splice(0, t.history.length - HISTORY_CAP)
}

function defaultMapping(e: EventEnvelope) {
  return {
    ruleSetId: (e.payload.mapping as Record<string, unknown> | undefined)?.ruleSetId as string ?? e.source.adapterId,
    ruleSetVersion: ((e.payload.mapping as Record<string, unknown> | undefined)?.ruleSetVersion as number) ?? 1,
    confidence: ((e.payload.mapping as Record<string, unknown> | undefined)?.confidence as "exact") ?? "exact",
    original: ((e.payload.mapping as Record<string, unknown> | undefined)?.original as Record<string, unknown>) ?? {},
  }
}

function applyTaskFields(t: Task, p: Record<string, unknown>, e: EventEnvelope, actor?: string): void {
  const fields: (keyof Task)[] = ["title", "description", "kind", "parentId", "priority", "assignee", "componentId", "progress", "estimateHours", "estimateConfidence", "sourceStatus"]
  for (const f of fields) {
    if (p[f] === null) { // null clears an optional field
      if (t[f] !== undefined) { pushHistory(t, e, f, t[f], undefined, actor); (t as Record<string, unknown>)[f] = undefined }
      continue
    }
    if (p[f] !== undefined && p[f] !== t[f]) {
      pushHistory(t, e, f, t[f], p[f], actor)
      ;(t as Record<string, unknown>)[f] = p[f]
    }
  }
  if (p.dependencies !== undefined) { pushHistory(t, e, "dependencies", t.dependencies, p.dependencies, actor); t.dependencies = p.dependencies as string[] }
  if (p.labels !== undefined) { pushHistory(t, e, "labels", t.labels, p.labels, actor); t.labels = p.labels as string[] }
  if (p.acceptanceCriteria !== undefined) {
    const acs = (p.acceptanceCriteria as { id?: string; text: string; done?: boolean }[]).map((c, i) => ({ id: c.id ?? `ac${i + 1}`, text: c.text, done: c.done ?? false }))
    pushHistory(t, e, "acceptanceCriteria", t.acceptanceCriteria, acs, actor)
    t.acceptanceCriteria = acs
  }
  if (p.status !== undefined && p.status !== t.status) {
    pushHistory(t, e, "status", t.status, p.status, actor)
    t.status = p.status as TaskStatus
  }
  if (p.links !== undefined) {
    const l = p.links as Partial<Task["links"]>
    const merged = { ...t.links, ...l }
    pushHistory(t, e, "links", t.links, merged, actor)
    t.links = { branches: merged.branches ?? [], pullRequests: merged.pullRequests ?? [], pipelineRunIds: merged.pipelineRunIds ?? [], releaseId: merged.releaseId }
  }
  if (p.mapping !== undefined) t.mapping = defaultMapping(e)
  t.updatedAt = e.occurredAt
}

/** Projection rule: a blocked task whose blockers are all done becomes ready. */
function recomputeBlocked(state: ProjectState): void {
  for (const t of Object.values(state.tasks)) {
    if (t.status === "done" || t.status === "cancelled" || t.status === "merged") continue
    const blocked = t.dependencies.some(d => {
      const dep = state.tasks[d]
      return dep !== undefined && dep.status !== "done" && dep.status !== "cancelled" && dep.status !== "merged"
    })
    if (blocked && t.status !== "in_progress" && t.status !== "blocked") {
      t.status = "blocked"
    } else if (!blocked && t.status === "blocked") {
      t.status = "ready"
    }
  }
}

function recordTransition(state: ProjectState, from: string | undefined, to: string, at: string): void {
  if (!from || from === to) return
  const key = `${from}->${to}`
  const tr = state.transitions[key] ?? { from, to, count: 0 }
  tr.count++
  tr.lastAt = at
  state.transitions[key] = tr
}

function upsertRun(state: ProjectState, p: Record<string, unknown>, e: EventEnvelope): PipelineRun {
  const id = p.id as string
  const existing = state.runs[id]
  const run: PipelineRun = existing ?? {
    id, pipelineId: (p.pipelineId as string) ?? "unknown", number: (p.number as number) ?? 0,
    status: "pending", stages: [], retries: 0, artifacts: [],
    source: { ...e.source, entityKind: "pipeline_run", fetchedAt: e.occurredAt },
  }
  for (const f of ["pipelineId", "number", "status", "branch", "taskId", "trigger", "startedAt", "finishedAt", "error"] as const) {
    if (p[f] !== undefined) (run as Record<string, unknown>)[f] = p[f]
  }
  if (p.stages !== undefined) run.stages = p.stages as PipelineRun["stages"]
  if (p.retries !== undefined) run.retries = p.retries as number
  if (p.artifacts !== undefined) run.artifacts = p.artifacts as PipelineRun["artifacts"]
  state.runs[id] = run
  if (!state.pipelines[run.pipelineId]) {
    state.pipelines[run.pipelineId] = { id: run.pipelineId, name: run.pipelineId, provider: e.source.adapterId, source: { ...e.source, entityKind: "pipeline", fetchedAt: e.occurredAt } }
  }
  return run
}

export function apply(state: ProjectState, e: EventEnvelope): ProjectState {
  const p = e.payload
  state.lastEventAt = e.occurredAt
  state.recentActivity.push(e)
  if (state.recentActivity.length > ACTIVITY_CAP) state.recentActivity.splice(0, state.recentActivity.length - ACTIVITY_CAP)

  switch (e.type) {
    case "project.registered": {
      state.project = {
        id: e.projectId, name: p.name as string, root: p.root as string,
        registeredAt: state.project?.registeredAt ?? e.occurredAt,
        coreVersion: (p.coreVersion as string) ?? state.project?.coreVersion ?? "0.1.0",
        pluginVersion: (p.pluginVersion as string) ?? state.project?.pluginVersion,
        description: (p.description as string) ?? state.project?.description,
      }
      break
    }
    case "task.created": {
      const id = p.id as string
      if (state.tasks[id]) { applyTaskFields(state.tasks[id], p, e); break }
      const t: Task = {
        id, projectId: e.projectId, title: p.title as string, description: p.description as string | undefined,
        kind: (p.kind as Task["kind"]) ?? "task", parentId: p.parentId as string | undefined,
        status: (p.status as TaskStatus) ?? "ready", sourceStatus: p.sourceStatus as string | undefined,
        priority: (p.priority as Task["priority"]) ?? "P2", assignee: p.assignee as string | undefined,
        componentId: p.componentId as string | undefined, dependencies: (p.dependencies as string[]) ?? [],
        acceptanceCriteria: ((p.acceptanceCriteria as { id?: string; text: string; done?: boolean }[]) ?? []).map((c, i) => ({ id: c.id ?? `ac${i + 1}`, text: c.text, done: c.done ?? false })),
        progress: p.progress as number | undefined, estimateHours: p.estimateHours as number | undefined,
        estimateConfidence: p.estimateConfidence as Task["estimateConfidence"],
        labels: (p.labels as string[]) ?? [],
        source: { ...e.source, entityKind: "task", fetchedAt: e.occurredAt },
        mapping: defaultMapping(e),
        links: { branches: [], pullRequests: [], pipelineRunIds: [], releaseId: p.releaseId as string | undefined },
        createdAt: e.occurredAt, updatedAt: e.occurredAt, history: [],
      }
      state.tasks[id] = t
      recomputeBlocked(state)
      break
    }
    case "task.updated": {
      const t = state.tasks[p.id as string]
      if (t) { applyTaskFields(t, p, e, p.actor as string | undefined); recomputeBlocked(state) }
      break
    }
    case "task.status_changed": {
      const t = state.tasks[p.id as string]
      if (t) {
        const from = t.status
        const to = p.to as TaskStatus
        if (from !== to) {
          pushHistory(t, e, "status", from, to, p.actor as string | undefined)
          recordTransition(state, p.from as string ?? from, to, e.occurredAt)
          t.status = to
          if (p.sourceStatus !== undefined) t.sourceStatus = p.sourceStatus as string
          if (to === "done" || to === "merged") t.progress = 100
          t.updatedAt = e.occurredAt
        }
        recomputeBlocked(state)
      }
      break
    }
    case "task.claimed": {
      const t = state.tasks[p.id as string]
      if (t && t.status !== "done" && t.status !== "cancelled") {
        pushHistory(t, e, "assignee", t.assignee, p.agent, p.agent as string)
        t.assignee = p.agent as string
        if (t.status !== "in_progress") { pushHistory(t, e, "status", t.status, "in_progress"); recordTransition(state, t.status, "in_progress", e.occurredAt); t.status = "in_progress" }
        t.updatedAt = e.occurredAt
      }
      break
    }
    case "task.released": {
      const t = state.tasks[p.id as string]
      if (t) {
        pushHistory(t, e, "assignee", t.assignee, undefined)
        t.assignee = undefined
        const blocked = t.dependencies.some(d => state.tasks[d] && state.tasks[d].status !== "done" && state.tasks[d].status !== "cancelled")
        const to = blocked ? "blocked" : "ready"
        pushHistory(t, e, "status", t.status, to)
        recordTransition(state, t.status, to, e.occurredAt)
        t.status = to
        t.updatedAt = e.occurredAt
      }
      break
    }
    case "task.deleted": {
      const t = state.tasks[p.id as string]
      if (t) { pushHistory(t, e, "deleted", false, true); delete state.tasks[p.id as string] }
      break
    }
    case "agent.registered": {
      const id = (p.id as string) ?? (p.name as string)
      const existing = state.agents[id]
      state.agents[id] = {
        id, projectId: e.projectId, name: p.name as string, role: (p.role as string) ?? existing?.role,
        kind: (p.kind as Agent["kind"]) ?? existing?.kind ?? "unknown",
        status: existing?.status ?? "unknown", statusEvidence: existing?.statusEvidence ?? "inferred",
        currentTaskId: existing?.currentTaskId, sessionId: existing?.sessionId, model: existing?.model,
        startedAt: existing?.startedAt ?? e.occurredAt, lastEventAt: e.occurredAt,
        lastHeartbeatAt: existing?.lastHeartbeatAt, errors: existing?.errors ?? [],
        source: { ...e.source, entityKind: "agent", fetchedAt: e.occurredAt },
      }
      break
    }
    case "agent.status_changed": {
      const a = state.agents[p.id as string]
      if (a) {
        a.status = p.status as Agent["status"]
        a.statusEvidence = (p.evidence as Agent["statusEvidence"]) ?? "event"
        if (p.taskId !== undefined) a.currentTaskId = (p.taskId as string) || undefined
        if (p.sessionId !== undefined) a.sessionId = (p.sessionId as string) || undefined
        if (p.model !== undefined) a.model = p.model as string
        a.lastEventAt = e.occurredAt
        if (a.status === "working" && !a.startedAt) a.startedAt = e.occurredAt
      }
      break
    }
    case "agent.heartbeat": {
      const a = state.agents[p.id as string]
      if (a) {
        a.lastHeartbeatAt = e.occurredAt
        a.lastEventAt = e.occurredAt
        if (p.taskId !== undefined) a.currentTaskId = (p.taskId as string) || undefined
        // Heartbeat proves activity, never completion: only upgrade unknown -> working.
        if (a.status === "unknown") { a.status = "working"; a.statusEvidence = "heartbeat" }
      }
      break
    }
    case "agent.error": {
      const a = state.agents[p.id as string]
      if (a) {
        a.errors.push({ at: e.occurredAt, message: p.message as string, taskId: p.taskId as string | undefined })
        if (a.errors.length > 50) a.errors.splice(0, a.errors.length - 50)
        a.lastEventAt = e.occurredAt
      }
      break
    }
    case "session.started": {
      const s: AgentSession = {
        id: p.id as string, projectId: e.projectId, agentId: p.agentId as string,
        opencodeSessionId: p.opencodeSessionId as string | undefined, title: p.title as string | undefined,
        model: p.model as string | undefined, startedAt: e.occurredAt, taskIds: [],
      }
      state.sessions[s.id] = s
      const a = state.agents[s.agentId]
      if (a) { a.sessionId = s.id; if (s.model) a.model = s.model; a.lastEventAt = e.occurredAt }
      break
    }
    case "session.ended": {
      const s = state.sessions[p.id as string]
      if (s) s.endedAt = e.occurredAt
      break
    }
    case "component.updated": {
      const id = p.id as string
      const existing = state.components[id]
      state.components[id] = {
        id, projectId: e.projectId, name: (p.name as string) ?? existing?.name ?? id,
        parentId: (p.parentId as string) ?? existing?.parentId,
        kind: (p.kind as string) ?? existing?.kind ?? "component",
        status: (p.status as Component["status"]) ?? existing?.status ?? "unknown",
        readiness: (p.readiness as number) ?? existing?.readiness,
        doc: (p.doc as string) ?? existing?.doc,
        source: { ...e.source, entityKind: "component", fetchedAt: e.occurredAt },
        metrics: (p.metrics as Component["metrics"]) ?? existing?.metrics,
      }
      break
    }
    case "architecture.map": {
      state.architecture = {
        available: true, source: p.source as string | undefined,
        elements: (p.elements as ArchitectureMap["elements"]) ?? [],
        relations: (p.relations as ArchitectureMap["relations"]) ?? [],
        views: (p.views as ArchitectureMap["views"]) ?? [],
      }
      break
    }
    case "git.branches": {
      for (const b of p.branches as { name: string; headSha?: string; lastCommitAt?: string; taskIds?: string[]; merged?: boolean }[]) {
        const existing = state.branches[b.name]
        state.branches[b.name] = {
          name: b.name, headSha: b.headSha ?? existing?.headSha, lastCommitAt: b.lastCommitAt ?? existing?.lastCommitAt,
          taskIds: b.taskIds ?? existing?.taskIds ?? [], merged: b.merged ?? existing?.merged,
          source: { ...e.source, entityKind: "branch", fetchedAt: e.occurredAt },
        }
      }
      break
    }
    case "git.commits": {
      const seen = new Set(state.commits.map(c => c.sha))
      for (const c of p.commits as Commit[]) {
        if (seen.has(c.sha)) continue
        state.commits.push({ ...c, taskIds: c.taskIds ?? [] })
        seen.add(c.sha)
      }
      state.commits.sort((a, b) => (a.at < b.at ? 1 : -1))
      if (state.commits.length > COMMITS_CAP) state.commits.splice(COMMITS_CAP)
      break
    }
    case "git.pr_updated": {
      const id = p.id as string
      const existing = state.pullRequests[id]
      state.pullRequests[id] = {
        id, title: p.title as string, state: p.state as PullRequest["state"],
        sourceBranch: p.sourceBranch as string, targetBranch: p.targetBranch as string,
        taskId: (p.taskId as string) ?? existing?.taskId, url: (p.url as string) ?? existing?.url,
        checks: (p.checks as PullRequest["checks"]) ?? existing?.checks ?? [],
        updatedAt: e.occurredAt, source: { ...e.source, entityKind: "pull_request", fetchedAt: e.occurredAt },
      }
      break
    }
    case "pipeline.registered": {
      const id = p.id as string
      state.pipelines[id] = { id, name: p.name as string, provider: p.provider as string, source: { ...e.source, entityKind: "pipeline", fetchedAt: e.occurredAt } }
      break
    }
    case "pipeline.run_started":
    case "pipeline.run_updated": {
      upsertRun(state, p, e)
      break
    }
    case "pipeline.run_completed": {
      const run = upsertRun(state, { ...p, pipelineId: p.pipelineId ?? state.runs[p.id as string]?.pipelineId ?? "unknown" }, e)
      run.status = p.status as PipelineRun["status"]
      run.finishedAt = (p.finishedAt as string) ?? e.occurredAt
      break
    }
    case "merge_queue.snapshot": {
      const entries = (p.entries as MergeQueueEntry[]).map((it, i) => ({
        ...it, position: it.position ?? i + 1,
        checks: it.checks ?? [], enqueuedAt: it.enqueuedAt ?? e.occurredAt, updatedAt: it.updatedAt ?? e.occurredAt,
        source: { ...e.source, entityKind: "merge_queue_entry", fetchedAt: e.occurredAt },
      }))
      state.queue = { id: (p.id as string) ?? "default", entries, inFlight: p.inFlight as string | undefined, source: { ...e.source, entityKind: "merge_queue", fetchedAt: e.occurredAt } }
      break
    }
    case "merge_queue.entry_updated": {
      if (state.queue) {
        const entry = state.queue.entries.find(x => x.id === p.id)
        if (entry) {
          if (p.state !== undefined) entry.state = p.state as MergeQueueEntry["state"]
          if (p.reason !== undefined) entry.reason = p.reason as string
          if (p.checks !== undefined) entry.checks = p.checks as MergeQueueEntry["checks"]
          entry.updatedAt = e.occurredAt
        }
      }
      break
    }
    case "release.created": {
      const id = p.id as string
      state.releases[id] = {
        id, projectId: e.projectId, name: p.name as string, tag: p.tag as string | undefined,
        scopeTaskIds: (p.scopeTaskIds as string[]) ?? [], status: "planning",
        targetDate: p.targetDate as string | undefined, createdAt: e.occurredAt, updatedAt: e.occurredAt,
        notes: p.notes as string | undefined, source: { ...e.source, entityKind: "release", fetchedAt: e.occurredAt },
      }
      break
    }
    case "release.updated": {
      const r = state.releases[p.id as string]
      if (r) {
        for (const f of ["name", "tag", "targetDate", "notes", "status"] as const) if (p[f] !== undefined) (r as Record<string, unknown>)[f] = p[f]
        if (p.scopeTaskIds !== undefined) r.scopeTaskIds = p.scopeTaskIds as string[]
        r.updatedAt = e.occurredAt
      }
      break
    }
    case "release.released": {
      const r = state.releases[p.id as string]
      if (r) { r.status = "released"; r.releasedAt = e.occurredAt; if (p.tag) r.tag = p.tag as string; r.updatedAt = e.occurredAt }
      break
    }
    case "workflow.stages_observed": {
      const stages = p.stages as { id: string; label?: string; observed?: boolean }[]
      state.workflowStages = stages.map(s => ({ id: s.id, label: s.label ?? s.id, observed: s.observed !== false }))
      break
    }
    case "integration.sync": {
      if (p.ok === false) {
        state.diagnostics.lastErrors.push({ at: e.occurredAt, message: `adapter ${p.adapterId}: ${p.error ?? "sync failed"}` })
        if (state.diagnostics.lastErrors.length > 50) state.diagnostics.lastErrors.splice(0, state.diagnostics.lastErrors.length - 50)
      }
      break
    }
    case "diagnostic.unknown_event": { state.diagnostics.unknownEvents++; break }
    case "diagnostic.schema_violation": { state.diagnostics.schemaViolations++; break }
    case "activity.note":
    default:
      break // activity is the log itself; notes need no projection
  }
  return state
}

export function replay(events: readonly EventEnvelope[], base?: ProjectState): ProjectState {
  const state = base ?? initialState()
  for (const e of events) apply(state, e)
  return state
}
