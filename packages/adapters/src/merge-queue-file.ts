// Built-in adapter: file-based merge queue (custom harness queues).
import type { Adapter, AdapterContext, ProbeResult } from "./contract.ts"
import { adapterSource, snapshotKey } from "./contract.ts"
import { hashObject } from "../../core/src/ids.ts"
import type { MergeEntryState } from "../../core/src/types.ts"

const ID = "merge-queue-file"

export interface QueueConfig {
  path: string
  itemsPath?: string
  stateMap?: Record<string, MergeEntryState>
  fields?: { branch?: string; task?: string; agent?: string; state?: string; reason?: string; checks?: string; enqueuedAt?: string }
}

const DEFAULT_STATE_MAP: Record<string, MergeEntryState> = {
  waiting: "waiting", queued: "waiting", pending: "waiting",
  checking: "checking", testing: "checking", gates: "checking",
  ready: "ready", approved: "ready",
  merging: "merging", "in-progress": "merging", processing: "merging",
  merged: "merged", done: "merged", complete: "merged",
  conflict: "conflict", conflicts: "conflict", "rebase-conflict": "conflict",
  "dead-letter": "dead_letter", dead_letter: "dead_letter", deadletter: "dead_letter",
  failed: "failed", "gate-fail": "failed", error: "failed",
}

function readQueue(ctx: AdapterContext, cfg: QueueConfig): { items: Record<string, unknown>[]; error?: string } {
  const raw = ctx.readText(cfg.path)
  if (raw === null) return { items: [], error: `file not found: ${cfg.path}` }
  try {
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
    const doc = JSON.parse(text)
    let items: unknown = cfg.itemsPath ? cfg.itemsPath.split(".").reduce((o: unknown, k) => (o as Record<string, unknown>)?.[k], doc) : doc
    if (!Array.isArray(items) && typeof doc === "object" && doc !== null && Array.isArray((doc as Record<string, unknown>).items)) items = (doc as Record<string, unknown>).items
    if (!Array.isArray(items)) return { items: [], error: "no queue items array found" }
    return { items: items as Record<string, unknown>[] }
  } catch (e) { return { items: [], error: `parse error: ${(e as Error).message}` } }
}

export const mergeQueueFileAdapter: Adapter = {
  manifest: {
    id: ID, version: "1.0.0", kind: "builtin", title: "File Merge Queue",
    description: "Serialized merge queue from a JSON state file (custom harness integration queues).",
    contractVersion: 1, capabilities: ["merge_queue"],
    compatibility: { core: ">=0.1.0" }, sourceStability: "documented-format",
  },
  async probe(ctx): Promise<ProbeResult> {
    const cfg = ctx.config as unknown as QueueConfig
    if (!cfg?.path) return { ok: false, confidence: "inferred", detail: "no path configured", capabilities: { merge_queue: { status: "not_configured" } } }
    const { items, error } = readQueue(ctx, cfg)
    if (error) return { ok: false, confidence: "inferred", detail: error, capabilities: { merge_queue: { status: "degraded", limitations: [error] } } }
    const f = cfg.fields ?? {}
    const branchField = f.branch ?? ["branch", "ref", "branchName"].find(k => items[0]?.[k] !== undefined) ?? "branch"
    const ok = items.length === 0 || items.every(i => typeof i[branchField] === "string")
    return {
      ok, confidence: "verified", detail: `${items.length} queue entries readable`,
      capabilities: {
        merge_queue: ok
          ? { status: "supported", observableStates: ["waiting", "checking", "ready", "merging", "merged", "conflict", "dead_letter", "failed"], events: ["merge_queue.snapshot", "merge_queue.entry_updated"], details: { entryCount: items.length } }
          : { status: "partial", limitations: ["branch field not detected on all entries"] },
      },
    }
  },
  async collect(ctx) {
    const cfg = ctx.config as unknown as QueueConfig
    const { items, error } = readQueue(ctx, cfg)
    if (error) throw new Error(`merge queue unreadable: ${error}`)
    const f = cfg.fields ?? {}
    const stateMap = { ...DEFAULT_STATE_MAP, ...cfg.stateMap }
    const pick = (configured: string | undefined, candidates: string[], fallback: string): string =>
      configured ?? candidates.find(k => items[0]?.[k] !== undefined) ?? fallback
    const branchField = pick(f.branch, ["branch", "ref", "branchName"], "branch")
    const stateField = pick(f.state, ["state", "status", "phase"], "state")
    const taskField = pick(f.task, ["task", "ticket", "taskId"], "task")
    const agentField = pick(f.agent, ["agent", "owner"], "agent")
    const reasonField = pick(f.reason, ["reason", "error"], "reason")
    const enqueuedField = pick(f.enqueuedAt, ["enqueuedAt", "added", "queuedAt"], "enqueuedAt")
    const entries = items.map((it, i) => {
      const originalState = String(it[stateField] ?? "waiting")
      const state = stateMap[originalState.toLowerCase()] ?? "waiting"
      const checks = it[f.checks ?? "checks"]
      return {
        id: String(it.id ?? it[branchField] ?? `entry-${i + 1}`),
        position: i + 1,
        branch: String(it[branchField] ?? ""),
        taskId: it[taskField] ? String(it[taskField]) : undefined,
        agent: it[agentField] ? String(it[agentField]) : undefined,
        state,
        checks: Array.isArray(checks) ? checks as { name: string; status: string }[] : [],
        enqueuedAt: String(it[enqueuedField] ?? new Date().toISOString()),
        updatedAt: new Date().toISOString(),
        reason: it[reasonField] ? String(it[reasonField]) : undefined,
        mapping: { originalState },
      }
    })
    const inFlight = entries.find(e => e.state === "merging")?.id
    return {
      events: [{
        type: "merge_queue.snapshot", schemaVersion: 1,
        payload: { id: cfg.path, entries, inFlight },
        idempotencyKey: snapshotKey(ID, cfg.path, hashObject(entries.map(e => ({ ...e, updatedAt: undefined })))),
        source: adapterSource(ID, cfg.path),
      }],
    }
  },
}
