// Event contract registry: every event type has a schema version and a payload validator.
// This is the typed boundary between adapters/plugin/API and the projections.
import type { EventEnvelope } from "./types.ts"
import { EVENT_CONTRACT_VERSION } from "./types.ts"

export interface EventTypeDef {
  type: string
  schemaVersion: number
  description: string
  validate: (p: Record<string, unknown>) => string | null // null = ok, else error
}

// ---- validator helpers ----
type P = Record<string, unknown>
const isObj = (v: unknown): v is P => typeof v === "object" && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
const isArr = (v: unknown): v is unknown[] => Array.isArray(v)

function reqStr(p: P, k: string): string | null { return isStr(p[k]) ? null : `field "${k}" must be a non-empty string` }
function optStr(p: P, k: string): string | null { return p[k] === undefined || p[k] === null || typeof p[k] === "string" ? null : `field "${k}" must be a string` }
function optNum(p: P, k: string): string | null { return p[k] === undefined || p[k] === null || isNum(p[k]) ? null : `field "${k}" must be a number` }
function reqObj(p: P, k: string): string | null { return isObj(p[k]) ? null : `field "${k}" must be an object` }
function reqArr(p: P, k: string): string | null { return isArr(p[k]) ? null : `field "${k}" must be an array` }
function oneOf(p: P, k: string, vals: readonly string[]): string | null {
  return typeof p[k] === "string" && vals.includes(p[k] as string) ? null : `field "${k}" must be one of ${vals.join("|")}`
}
function all(...checks: (string | null)[]): string | null {
  for (const c of checks) if (c) return c
  return null
}

const TASK_STATUS_VALUES = ["backlog", "planning", "ready", "in_progress", "review", "verification", "blocked", "merged", "done", "cancelled", "unknown"]
const AGENT_STATUS_VALUES = ["working", "waiting", "blocked", "reviewing", "completed", "failed", "stopped", "unknown"]
const RUN_STATUS_VALUES = ["pending", "running", "success", "failed", "cancelled", "unknown"]
const MERGE_STATE_VALUES = ["waiting", "checking", "ready", "merging", "merged", "conflict", "dead_letter", "failed"]

function validateTaskFields(p: P, requireId: boolean): string | null {
  const checks: (string | null)[] = []
  if (requireId) checks.push(reqStr(p, "id"))
  checks.push(optStr(p, "title"), optStr(p, "description"), optStr(p, "parentId"), optStr(p, "assignee"),
    optStr(p, "componentId"), optStr(p, "sourceStatus"), optStr(p, "releaseId"))
  if (p.kind !== undefined) checks.push(oneOf(p, "kind", ["epic", "feature", "task", "subtask"]))
  if (p.status !== undefined) checks.push(oneOf(p, "status", TASK_STATUS_VALUES))
  if (p.priority !== undefined) checks.push(oneOf(p, "priority", ["P0", "P1", "P2", "P3"]))
  if (p.dependencies !== undefined) {
    if (!isArr(p.dependencies)) return `field "dependencies" must be an array of task ids`
    for (const d of p.dependencies) if (!isStr(d)) return `dependencies entries must be strings`
  }
  if (p.labels !== undefined) {
    if (!isArr(p.labels)) return `field "labels" must be an array`
    for (const l of p.labels) if (!isStr(l)) return `labels entries must be strings`
  }
  if (p.acceptanceCriteria !== undefined) {
    if (!isArr(p.acceptanceCriteria)) return `field "acceptanceCriteria" must be an array`
    for (const c of p.acceptanceCriteria) {
      if (!isObj(c) || !isStr(c.text)) return `acceptanceCriteria entries need {text}`
    }
  }
  checks.push(optNum(p, "progress"), optNum(p, "estimateHours"))
  if (p.progress !== undefined && isNum(p.progress) && (p.progress < 0 || p.progress > 100)) return `progress must be 0..100`
  if (p.estimateConfidence !== undefined) checks.push(oneOf(p, "estimateConfidence", ["high", "medium", "low"]))
  if (p.mapping !== undefined && !isObj(p.mapping)) return `field "mapping" must be an object`
  if (p.links !== undefined && !isObj(p.links)) return `field "links" must be an object`
  return all(...checks)
}

function validateRun(p: P): string | null {
  const base = all(reqStr(p, "id"), reqStr(p, "pipelineId"), optNum(p, "number"), optStr(p, "branch"), optStr(p, "taskId"), optStr(p, "trigger"), optStr(p, "startedAt"), optStr(p, "finishedAt"), optStr(p, "error"))
  if (base) return base
  if (p.status !== undefined) { const e = oneOf(p, "status", RUN_STATUS_VALUES); if (e) return e }
  if (p.stages !== undefined) {
    if (!isArr(p.stages)) return `stages must be an array`
    for (const s of p.stages) {
      if (!isObj(s) || !isStr(s.name)) return `stage entries need {name}`
      if (s.status !== undefined && !(typeof s.status === "string" && RUN_STATUS_VALUES.includes(s.status))) return `stage status invalid`
      if (s.jobs !== undefined && !isArr(s.jobs)) return `stage jobs must be an array`
    }
  }
  if (p.artifacts !== undefined && !isArr(p.artifacts)) return `artifacts must be an array`
  return null
}

function validateMergeEntry(p: P): string | null {
  const base = all(reqStr(p, "id"), reqStr(p, "branch"), optStr(p, "taskId"), optStr(p, "agent"), optStr(p, "reason"), optStr(p, "enqueuedAt"), optStr(p, "updatedAt"))
  if (base) return base
  if (p.state !== undefined) { const e = oneOf(p, "state", MERGE_STATE_VALUES); if (e) return e }
  if (p.position !== undefined && !isNum(p.position)) return `position must be a number`
  if (p.checks !== undefined) {
    if (!isArr(p.checks)) return `checks must be an array`
    for (const c of p.checks) if (!isObj(c) || !isStr(c.name) || !isStr(c.status)) return `check entries need {name,status}`
  }
  return null
}

// ---- registry ----
const defs: EventTypeDef[] = [
  { type: "project.registered", schemaVersion: 1, description: "Project registration/update", validate: p => all(reqStr(p, "name"), reqStr(p, "root"), optStr(p, "description"), optStr(p, "pluginVersion")) },
  { type: "task.created", schemaVersion: 1, description: "Task created (full fields)", validate: p => all(reqStr(p, "id"), reqStr(p, "title"), validateTaskFields(p, true)) },
  { type: "task.updated", schemaVersion: 1, description: "Task field updates", validate: p => validateTaskFields(p, true) },
  { type: "task.status_changed", schemaVersion: 1, description: "Explicit status transition", validate: p => all(reqStr(p, "id"), oneOf(p, "to", TASK_STATUS_VALUES), optStr(p, "from"), optStr(p, "sourceStatus"), optStr(p, "actor")) },
  { type: "task.claimed", schemaVersion: 1, description: "Atomic claim by agent", validate: p => all(reqStr(p, "id"), reqStr(p, "agent")) },
  { type: "task.released", schemaVersion: 1, description: "Claim released", validate: p => reqStr(p, "id") },
  { type: "task.deleted", schemaVersion: 1, description: "Task removed (kept in history log)", validate: p => reqStr(p, "id") },
  { type: "agent.registered", schemaVersion: 1, description: "Agent discovered/registered", validate: p => all(reqStr(p, "name"), optStr(p, "id"), optStr(p, "role"), p.kind === undefined ? null : oneOf(p, "kind", ["opencode", "harness", "human", "unknown"])) },
  { type: "agent.status_changed", schemaVersion: 1, description: "Agent lifecycle status", validate: p => all(reqStr(p, "id"), oneOf(p, "status", AGENT_STATUS_VALUES), optStr(p, "taskId"), optStr(p, "sessionId"), optStr(p, "model"), p.evidence === undefined ? null : oneOf(p, "evidence", ["event", "heartbeat", "inferred"])) },
  { type: "agent.heartbeat", schemaVersion: 1, description: "Activity heartbeat (never implies completion)", validate: p => all(reqStr(p, "id"), optStr(p, "taskId"), optStr(p, "note")) },
  { type: "agent.error", schemaVersion: 1, description: "Agent error observed", validate: p => all(reqStr(p, "id"), reqStr(p, "message"), optStr(p, "taskId")) },
  { type: "session.started", schemaVersion: 1, description: "Agent session started", validate: p => all(reqStr(p, "id"), reqStr(p, "agentId"), optStr(p, "opencodeSessionId"), optStr(p, "title"), optStr(p, "model")) },
  { type: "session.ended", schemaVersion: 1, description: "Agent session ended", validate: p => reqStr(p, "id") },
  { type: "component.updated", schemaVersion: 1, description: "Component upsert", validate: p => all(reqStr(p, "id"), optStr(p, "name"), optStr(p, "parentId"), optStr(p, "kind"), optStr(p, "doc"), p.status === undefined ? null : oneOf(p, "status", ["planned", "in_progress", "done", "blocked", "unknown"]), optNum(p, "readiness"), p.metrics === undefined ? null : reqObj(p, "metrics")) },
  { type: "architecture.map", schemaVersion: 1, description: "Architecture map snapshot (e.g. LikeC4 export)", validate: p => all(reqArr(p, "elements"), reqArr(p, "relations"), reqArr(p, "views"), optStr(p, "source")) },
  { type: "git.branches", schemaVersion: 1, description: "Branch snapshot", validate: p => { const e = reqArr(p, "branches"); if (e) return e; for (const b of p.branches as unknown[]) { if (!isObj(b) || !isStr(b.name)) return `branch entries need {name}` } return null } },
  { type: "git.commits", schemaVersion: 1, description: "Commit batch", validate: p => { const e = reqArr(p, "commits"); if (e) return e; for (const c of p.commits as unknown[]) { if (!isObj(c) || !isStr(c.sha) || !isStr(c.message)) return `commit entries need {sha,message}` } return null } },
  { type: "git.pr_updated", schemaVersion: 1, description: "Pull request upsert", validate: p => all(reqStr(p, "id"), reqStr(p, "title"), oneOf(p, "state", ["open", "merged", "closed"]), reqStr(p, "sourceBranch"), reqStr(p, "targetBranch"), optStr(p, "taskId"), optStr(p, "url")) },
  { type: "pipeline.registered", schemaVersion: 1, description: "Pipeline definition", validate: p => all(reqStr(p, "id"), reqStr(p, "name"), reqStr(p, "provider")) },
  { type: "pipeline.run_started", schemaVersion: 1, description: "Run started (full run object)", validate: p => validateRun(p) },
  { type: "pipeline.run_updated", schemaVersion: 1, description: "Run progress update", validate: p => all(reqStr(p, "id"), validateRun({ ...p, pipelineId: p.pipelineId ?? "x" })) },
  { type: "pipeline.run_completed", schemaVersion: 1, description: "Run finished", validate: p => all(reqStr(p, "id"), oneOf(p, "status", RUN_STATUS_VALUES), optStr(p, "finishedAt"), p.stages === undefined ? null : validateRun({ id: p.id, pipelineId: "x", stages: p.stages })) },
  { type: "merge_queue.snapshot", schemaVersion: 1, description: "Full queue snapshot", validate: p => { const e = reqArr(p, "entries"); if (e) return e; for (const it of p.entries as unknown[]) { const r = validateMergeEntry(it as P); if (r) return r } return optStr(p, "inFlight") } },
  { type: "merge_queue.entry_updated", schemaVersion: 1, description: "Single entry update", validate: p => all(reqStr(p, "id"), p.state === undefined ? null : oneOf(p, "state", MERGE_STATE_VALUES), optStr(p, "reason"), p.checks === undefined ? null : validateMergeEntry({ id: p.id, branch: "x", checks: p.checks })) },
  { type: "release.created", schemaVersion: 1, description: "Release created", validate: p => all(reqStr(p, "id"), reqStr(p, "name"), optStr(p, "tag"), optStr(p, "targetDate"), optStr(p, "notes"), p.scopeTaskIds === undefined ? null : reqArr(p, "scopeTaskIds")) },
  { type: "release.updated", schemaVersion: 1, description: "Release fields/scope update", validate: p => all(reqStr(p, "id"), optStr(p, "name"), optStr(p, "tag"), optStr(p, "targetDate"), optStr(p, "notes"), p.status === undefined ? null : oneOf(p, "status", ["planning", "in_progress", "ready", "released", "cancelled"]), p.scopeTaskIds === undefined ? null : reqArr(p, "scopeTaskIds")) },
  { type: "release.released", schemaVersion: 1, description: "Release published", validate: p => all(reqStr(p, "id"), optStr(p, "tag")) },
  { type: "workflow.stages_observed", schemaVersion: 1, description: "Observed workflow stages from harness", validate: p => { const e = reqArr(p, "stages"); if (e) return e; for (const s of p.stages as unknown[]) { if (!isObj(s) || !isStr(s.id)) return `stage entries need {id}` } return null } },
  { type: "integration.drift_detected", schemaVersion: 1, description: "Drift report recorded", validate: p => reqObj(p, "report") },
  { type: "integration.reconciled", schemaVersion: 1, description: "Reconciliation result recorded", validate: p => reqObj(p, "result") },
  { type: "integration.adapter_updated", schemaVersion: 1, description: "Adapter version activated", validate: p => all(reqStr(p, "adapterId"), reqStr(p, "version"), optStr(p, "previousVersion")) },
  { type: "integration.sync", schemaVersion: 1, description: "Adapter sync outcome", validate: p => all(reqStr(p, "adapterId"), typeof p.ok === "boolean" ? null : `ok must be boolean`, optNum(p, "eventsIngested"), optStr(p, "error")) },
  { type: "activity.note", schemaVersion: 1, description: "Free-form activity note", validate: p => all(reqStr(p, "text"), optStr(p, "entity")) },
  { type: "diagnostic.unknown_event", schemaVersion: 1, description: "Unregistered event type received", validate: p => reqObj(p, "raw") },
  { type: "diagnostic.schema_violation", schemaVersion: 1, description: "Event failed schema validation", validate: p => all(reqObj(p, "raw"), reqStr(p, "error")) },
]

export const EVENT_REGISTRY: ReadonlyMap<string, EventTypeDef> = new Map(defs.map(d => [d.type, d]))

export function validateEvent(type: string, schemaVersion: number, payload: unknown): string | null {
  const def = EVENT_REGISTRY.get(type)
  if (!def) return `unknown event type: ${type}`
  if (schemaVersion !== def.schemaVersion) return `schema version mismatch for ${type}: got ${schemaVersion}, expected ${def.schemaVersion}`
  if (!isObj(payload)) return `payload must be an object`
  return def.validate(payload)
}

export function eventContractVersion(): number { return EVENT_CONTRACT_VERSION }

/** Envelope-level validation before ingestion (source attribution is mandatory). */
export function validateEnvelope(e: Partial<EventEnvelope>): string | null {
  if (!isStr(e.projectId)) return `projectId required`
  if (!isStr(e.type)) return `type required`
  if (!isNum(e.schemaVersion)) return `schemaVersion required`
  if (!isObj(e.source)) return `source (SourceRef) required`
  const s = e.source as Record<string, unknown>
  if (!isStr(s.adapterId) || !isStr(s.sourceId)) return `source.adapterId and source.sourceId required`
  if (e.occurredAt !== undefined && typeof e.occurredAt !== "string") return `occurredAt must be ISO string`
  if (e.idempotencyKey !== undefined && typeof e.idempotencyKey !== "string") return `idempotencyKey must be string`
  return null
}
