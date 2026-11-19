// Built-in adapter: generic file-based task tracker (JSON / JSONL / Markdown).
// Configurable field + status mapping; ORIGINAL values always preserved.
// This is the workhorse for custom harnesses with their own task state files.
import type { Adapter, AdapterContext, ProbeResult, OutboundEvent } from "./contract.ts"
import { adapterSource } from "./contract.ts"
import { hashObject } from "../../core/src/ids.ts"
import type { TaskStatus } from "../../core/src/types.ts"

const ID = "file-task-tracker"

export interface TrackerConfig {
  path: string
  format?: "json" | "jsonl" | "markdown"
  tasksPath?: string           // dot-path into JSON document, e.g. "tasks"
  fields?: Partial<Record<"id" | "title" | "status" | "priority" | "assignee" | "parent" | "deps" | "estimate" | "progress" | "component" | "description", string>>
  statusMap?: Record<string, TaskStatus>
  kindMap?: Record<string, string>
  defaultKind?: string
}

const FIELD_CANDIDATES: Record<string, string[]> = {
  id: ["id", "key", "taskId", "task_id"],
  title: ["title", "name", "summary", "text"],
  status: ["status", "state", "stage"],
  priority: ["priority", "prio"],
  assignee: ["assignee", "owner", "agent"],
  parent: ["parent", "parentId", "parent_id", "epic", "feature"],
  deps: ["dependencies", "blockedBy", "blocked_by", "deps", "dependsOn"],
  estimate: ["estimateHours", "estimate_hours", "estimate", "hours"],
  progress: ["progress", "percent", "completion"],
  component: ["component", "componentId", "module", "area"],
  description: ["description", "doc", "details", "body"],
}

const DEFAULT_STATUS_MAP: Record<string, TaskStatus> = {
  "todo": "backlog", "backlog": "backlog", "new": "backlog", "open": "backlog",
  "planning": "planning", "planned": "planning", "awaiting-approval": "planning",
  "ready": "ready", "queued": "ready", "pending": "ready", "todo-ready": "ready",
  "in-progress": "in_progress", "in_progress": "in_progress", "inprogress": "in_progress",
  "doing": "in_progress", "coding": "in_progress", "development": "in_progress",
  "implement": "in_progress", "implementing": "in_progress", "executing": "in_progress",
  "active": "in_progress", "wip": "in_progress", "started": "in_progress",
  "review": "review", "reviewing": "review", "in-review": "review", "pr": "review",
  "testing": "verification", "verifying": "verification", "verification": "verification",
  "green": "verification", "gates": "verification",
  "blocked": "blocked", "waiting": "blocked", "on-hold": "blocked",
  "integrating": "merged", "integration": "merged", "merged": "merged",
  "done": "done", "complete": "done", "completed": "done", "closed": "done",
  "shipped": "done", "released": "done", "resolved": "done", "ci": "done",
  "cancelled": "cancelled", "canceled": "cancelled", "wontfix": "cancelled",
}

function detectFields(sample: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  const keys = Object.keys(sample)
  for (const [canonical, candidates] of Object.entries(FIELD_CANDIDATES)) {
    const hit = candidates.find(c => keys.some(k => k.toLowerCase() === c.toLowerCase()))
    if (hit) out[canonical] = keys.find(k => k.toLowerCase() === hit.toLowerCase())!
  }
  return out
}

function getPath(obj: unknown, path?: string): unknown {
  if (!path) return obj
  let cur: unknown = obj
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

export function parseTasks(ctx: AdapterContext, cfg: TrackerConfig): { tasks: Record<string, unknown>[]; error?: string } {
  const raw = ctx.readText(cfg.path)
  if (raw === null) return { tasks: [], error: `file not found: ${cfg.path}` }
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw // BOM tolerance (PS 5.1 writers)
  const format = cfg.format ?? (cfg.path.endsWith(".jsonl") ? "jsonl" : cfg.path.endsWith(".md") ? "markdown" : "json")
  try {
    if (format === "jsonl") {
      const tasks = text.split("\n").filter(l => l.trim()).map(l => JSON.parse(l))
      return { tasks }
    }
    if (format === "markdown") {
      const tasks: Record<string, unknown>[] = []
      let i = 0
      for (const line of text.split("\n")) {
        const m = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line)
        if (m) {
          i++
          const idm = /^([A-Z][A-Z0-9]*-\d+|[A-Za-z0-9_-]+):\s*/.exec(m[2])
          tasks.push({ id: idm ? idm[1] : `MD-${i}`, title: idm ? m[2].slice(idm[0].length) : m[2], status: m[1] === " " ? "ready" : "done" })
        }
      }
      return { tasks }
    }
    const doc = JSON.parse(text)
    let arr = getPath(doc, cfg.tasksPath)
    if (arr === undefined && !cfg.tasksPath) {
      // auto: find first array of objects, or object-of-objects with id-like keys
      if (Array.isArray(doc)) arr = doc
      else if (typeof doc === "object" && doc !== null) {
        for (const v of Object.values(doc as Record<string, unknown>)) {
          if (Array.isArray(v) && v.length && typeof v[0] === "object") { arr = v; break }
        }
        if (arr === undefined) {
          const values = Object.values(doc as Record<string, unknown>)
          if (values.length && values.every(v => typeof v === "object" && v !== null)) {
            arr = Object.entries(doc as Record<string, unknown>).map(([k, v]) => ({ id: k, ...(v as object) }))
          }
        }
      }
    }
    if (!Array.isArray(arr)) return { tasks: [], error: "no task array found (set tasksPath)" }
    return { tasks: arr as Record<string, unknown>[] }
  } catch (e) {
    return { tasks: [], error: `parse error: ${(e as Error).message}` }
  }
}

export const fileTaskTrackerAdapter: Adapter = {
  manifest: {
    id: ID, version: "1.0.0", kind: "builtin", title: "File Task Tracker",
    description: "Tasks from JSON/JSONL/Markdown files with configurable field and status mapping. Preserves original values.",
    contractVersion: 1, capabilities: ["task_management", "task_hierarchy", "workflow_stages", "critical_path", "release_planning"],
    compatibility: { core: ">=0.1.0" }, sourceStability: "documented-format",
  },
  async probe(ctx): Promise<ProbeResult> {
    const cfg = ctx.config as unknown as TrackerConfig
    if (!cfg?.path) return { ok: false, confidence: "inferred", detail: "no path configured", capabilities: { task_management: { status: "not_configured", limitations: ["tracker path not configured"] } } }
    const { tasks, error } = parseTasks(ctx, cfg)
    if (error) return { ok: false, confidence: "inferred", detail: error, capabilities: { task_management: { status: "degraded", limitations: [error] } } }
    if (!tasks.length) return { ok: true, confidence: "verified", detail: "readable but empty", capabilities: { task_management: { status: "supported", limitations: ["tracker is empty"], completeness: 0 } } }
    const fields = { ...detectFields(tasks[0]), ...cfg.fields }
    if (!fields.id || !fields.title) {
      return { ok: false, confidence: "inferred", detail: "cannot map id/title fields", capabilities: { task_management: { status: "partial", limitations: ["id or title field not detected — configure fields mapping"] } } }
    }
    const hasStatus = !!fields.status
    const hasParent = !!fields.parent
    const hasDeps = !!fields.deps
    const hasEstimate = !!fields.estimate
    const statuses = [...new Set(tasks.map(t => String(t[fields.status!] ?? "")).filter(Boolean))]
    const mapped = statuses.filter(s => (cfg.statusMap ?? DEFAULT_STATUS_MAP)[s.toLowerCase()] !== undefined)
    const limitations: string[] = []
    if (!hasStatus) limitations.push("no status field — statuses unknown")
    if (statuses.length && mapped.length < statuses.length) limitations.push(`unmapped statuses: ${statuses.filter(s => !mapped.includes(s)).join(", ")}`)
    if (!hasDeps) limitations.push("no dependency field — critical path limited")
    const caps: ProbeResult["capabilities"] = {
      task_management: {
        status: hasStatus ? "supported" : "partial", limitations,
        observableStates: statuses, completeness: mapped.length && statuses.length ? mapped.length / statuses.length : 1,
        events: ["task.created", "task.updated", "task.status_changed"],
        details: { fields, statuses, taskCount: tasks.length },
      },
      task_hierarchy: hasParent
        ? { status: "supported", observableStates: ["parent/child"] }
        : { status: "partial", limitations: ["no parent field — flat list only"] },
      workflow_stages: {
        status: hasStatus ? (mapped.length === statuses.length ? "supported" : "partial") : "unavailable",
        observableStates: statuses, limitations: mapped.length < statuses.length ? ["some stages unmapped"] : [],
        details: { observableStages: statuses },
      },
      critical_path: hasDeps ? (hasEstimate ? { status: "supported" } : { status: "partial", limitations: ["dependencies present, duration estimates missing — structural path only"] }) : { status: "unavailable", limitations: ["no dependencies recorded"] },
    }
    return { ok: true, confidence: "verified", detail: `${tasks.length} tasks readable; fields ${Object.keys(fields).join(",")}`, capabilities: caps }
  },
  async collect(ctx) {
    const cfg = ctx.config as unknown as TrackerConfig
    const { tasks, error } = parseTasks(ctx, cfg)
    if (error || !tasks.length) return { events: [], notes: error ? [error] : [] }
    const fields = { ...detectFields(tasks[0]), ...cfg.fields }
    const statusMap = { ...DEFAULT_STATUS_MAP, ...cfg.statusMap }
    const events: OutboundEvent[] = []
    const statusesSeen = new Set<string>()
    for (const raw of tasks) {
      const id = String(raw[fields.id] ?? "")
      if (!id) continue
      const originalStatus = fields.status ? String(raw[fields.status] ?? "") : undefined
      if (originalStatus) statusesSeen.add(originalStatus)
      const normalized: TaskStatus = originalStatus ? (statusMap[originalStatus.toLowerCase()] ?? "unknown") : "unknown"
      const confidence = originalStatus ? (statusMap[originalStatus.toLowerCase()] ? "exact" : "unmapped") : "unmapped"
      const deps = fields.deps ? raw[fields.deps] : undefined
      const payload: Record<string, unknown> = {
        id,
        title: String(raw[fields.title] ?? id),
        status: normalized,
        sourceStatus: originalStatus,
        kind: (cfg.kindMap?.[String(raw.kind ?? "")] ?? cfg.defaultKind ?? "task") as string,
        mapping: { ruleSetId: `${ID}:${cfg.path}`, ruleSetVersion: 1, confidence, original: raw },
        dependencies: Array.isArray(deps) ? deps.map(String) : typeof deps === "string" && deps ? deps.split(/[,\s]+/).filter(Boolean) : [],
      }
      if (fields.parent && raw[fields.parent]) payload.parentId = String(raw[fields.parent])
      if (fields.priority && raw[fields.priority]) payload.priority = String(raw[fields.priority]).toUpperCase()
      if (fields.assignee && raw[fields.assignee]) payload.assignee = String(raw[fields.assignee])
      if (fields.estimate && typeof raw[fields.estimate] === "number") { payload.estimateHours = raw[fields.estimate]; payload.estimateConfidence = "medium" }
      if (fields.progress && typeof raw[fields.progress] === "number") payload.progress = raw[fields.progress]
      if (fields.component && raw[fields.component]) payload.componentId = String(raw[fields.component])
      if (fields.description && raw[fields.description]) payload.description = String(raw[fields.description])
      events.push({
        type: "task.created", schemaVersion: 1, payload,
        idempotencyKey: `${ID}:${cfg.path}:${id}:${hashObject(raw)}`,
        source: adapterSource(ID, cfg.path),
      })
    }
    if (statusesSeen.size) {
      const stages = [...statusesSeen].map(s => ({ id: s, label: s, observed: true }))
      events.push({
        type: "workflow.stages_observed", schemaVersion: 1, payload: { stages },
        idempotencyKey: `${ID}:${cfg.path}:stages:${hashObject(stages)}`,
        source: adapterSource(ID, cfg.path),
      })
    }
    return { events }
  },
}
