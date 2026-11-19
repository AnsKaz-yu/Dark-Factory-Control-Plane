// Adapter Generator: produces project-specific adapters for custom harness sources,
// then CONTRACT-TESTS them in isolation before activation. Generated adapters are
// self-contained (no runtime imports), versioned, and rollback-able.
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { Adapter, AdapterContext, ProbeResult } from "../../adapters/src/contract.ts"
import { makeContext } from "../../adapters/src/index.ts"
import { DEFAULT_STATUS_MAP } from "../../adapters/src/file-task-tracker.ts"
import { validateEvent } from "../../core/src/schema.ts"
import { nowISO, sha256 } from "../../core/src/ids.ts"
import { integrationDir, trackFile } from "./install.ts"

export interface GeneratedAdapterSpec {
  name: string
  kind: "agent-registry" | "task-lines" | "event-mapper"
  path: string                    // source file relative to project root
  fields?: Record<string, string> // source field names
  statusMap?: Record<string, string>
  description?: string
}

const HEADER = `// DFCP generated adapter — project-specific integration.
// Self-contained: no runtime imports. Original source values are preserved in mapping.original.
// Contract: DFCP Adapter v1. Regenerate via factory:adapter:update; rollback via history/.
`

function registryAdapterSource(spec: GeneratedAdapterSpec): string {
  const f = spec.fields ?? {}
  const statusMap = JSON.stringify(spec.statusMap ?? { running: "working", done: "completed", failed: "failed", idle: "waiting", busy: "working" })
  return `${HEADER}
const PATH = ${JSON.stringify(spec.path)}
const STATUS_MAP = ${statusMap}
const F = ${JSON.stringify({ status: f.status ?? "status", task: f.task ?? "task", note: f.note ?? "note", lastSeen: f.lastSeen ?? "lastSeen", role: f.role ?? "role" })}
export default {
  manifest: {
    id: ${JSON.stringify("generated:" + spec.name)}, version: "1.0.0", kind: "generated",
    title: ${JSON.stringify(spec.description ?? "Custom agent registry adapter")},
    description: "Generated from harness contract investigation. Source: " + PATH,
    contractVersion: 1, capabilities: ["agent_monitoring"],
    compatibility: { core: ">=0.1.0" }, sourceStability: "undocumented-internal",
    riskNotes: "Reads an internal harness registry file; drift detection watches its schema.",
  },
  async probe(ctx) {
    const raw = ctx.readText(PATH)
    if (raw === null) return { ok: false, confidence: "inferred", detail: "registry file not found: " + PATH, capabilities: { agent_monitoring: { status: "unavailable", limitations: ["registry file absent"] } } }
    try {
      const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
      const doc = JSON.parse(text)
      const entries = Object.entries(doc)
      if (!entries.length) return { ok: true, confidence: "verified", detail: "registry readable (empty)", capabilities: { agent_monitoring: { status: "supported", limitations: ["registry empty"] } } }
      const sample = entries[0][1]
      if (typeof sample !== "object" || sample === null) throw new Error("entries are not objects")
      return { ok: true, confidence: "verified", detail: entries.length + " agents readable", capabilities: { agent_monitoring: { status: "supported", observableStates: ["working","waiting","blocked","reviewing","completed","failed","stopped","unknown"], events: ["agent.registered","agent.status_changed","agent.heartbeat"], details: { registryPath: PATH } } } }
    } catch (e) {
      return { ok: false, confidence: "inferred", detail: "registry parse error: " + e.message, capabilities: { agent_monitoring: { status: "degraded", limitations: ["registry unreadable"] } } }
    }
  },
  async collect(ctx) {
    const raw = ctx.readText(PATH)
    if (raw === null) return { events: [] }
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
    let doc
    try { doc = JSON.parse(text) } catch { return { events: [], notes: ["registry parse failed"] } }
    const events = []
    const src = { adapterId: "generated:" + ${JSON.stringify(spec.name)}, sourceId: PATH, entityKind: "agent", authoritative: true, fetchedAt: new Date().toISOString() }
    for (const [name, v] of Object.entries(doc)) {
      const original = v
      const status = STATUS_MAP[String(v[F.status] ?? "").toLowerCase()] ?? "unknown"
      events.push({ type: "agent.registered", schemaVersion: 1, payload: { id: name, name, role: v[F.role] ? String(v[F.role]) : undefined, kind: "harness" }, idempotencyKey: "gen:${spec.name}:reg:" + name, source: src })
      events.push({ type: "agent.status_changed", schemaVersion: 1, payload: { id: name, status, taskId: v[F.task] ? String(v[F.task]) : undefined, evidence: "event" }, idempotencyKey: "gen:${spec.name}:st:" + name + ":" + status + ":" + (v[F.task] ?? ""), source: src })
      if (v[F.lastSeen]) events.push({ type: "agent.heartbeat", schemaVersion: 1, payload: { id: name, taskId: v[F.task] ? String(v[F.task]) : undefined, note: v[F.note] ? String(v[F.note]) : undefined }, occurredAt: String(v[F.lastSeen]), idempotencyKey: "gen:${spec.name}:hb:" + name + ":" + v[F.lastSeen], source: src })
    }
    return { events }
  },
}
`
}

function taskLinesAdapterSource(spec: GeneratedAdapterSpec): string {
  // start from the standard mapping dictionary; the Setup Agent refines it per harness.
  // Unmapped statuses normalize to "unknown" with the original preserved (never invented).
  const statusMap = JSON.stringify({ ...DEFAULT_STATUS_MAP, ...spec.statusMap })
  return `${HEADER}
const PATH = ${JSON.stringify(spec.path)}
const STATUS_MAP = ${statusMap}
// Line format contract (investigated): <id> | <title> | <status> [| <deps csv> [| <estimate>]]
export default {
  manifest: {
    id: ${JSON.stringify("generated:" + spec.name)}, version: "1.0.0", kind: "generated",
    title: ${JSON.stringify(spec.description ?? "Custom line-based task tracker")},
    description: "Generated parser for a custom task file format. Source: " + PATH,
    contractVersion: 1, capabilities: ["task_management", "workflow_stages", "critical_path"],
    compatibility: { core: ">=0.1.0" }, sourceStability: "undocumented-internal",
    riskNotes: "Parses an undocumented internal format; contract tests + drift detection guard changes.",
  },
  async probe(ctx) {
    const raw = ctx.readText(PATH)
    if (raw === null) return { ok: false, confidence: "inferred", detail: "file not found", capabilities: { task_management: { status: "unavailable" } } }
    const lines = raw.split("\\n").filter(l => l.trim() && !l.startsWith("#"))
    const parsed = lines.map(l => l.split("|").map(s => s.trim()))
    const ok = parsed.length > 0 && parsed.every(p => p.length >= 3 && p[0])
    const statuses = [...new Set(parsed.map(p => p[2]))]
    return ok
      ? { ok: true, confidence: "verified", detail: parsed.length + " task lines parsed", capabilities: { task_management: { status: "supported", observableStates: statuses, details: { statuses } }, workflow_stages: { status: "supported", observableStates: statuses, details: { observableStages: statuses } }, critical_path: { status: parsed.some(p => p[3]) ? "partial" : "unavailable", limitations: ["estimates may be missing"] } } }
      : { ok: false, confidence: "inferred", detail: "line format not recognized", capabilities: { task_management: { status: "degraded", limitations: ["format changed?"] } } }
  },
  async collect(ctx) {
    const raw = ctx.readText(PATH)
    if (raw === null) return { events: [] }
    const events = []
    const src = { adapterId: "generated:" + ${JSON.stringify(spec.name)}, sourceId: PATH, entityKind: "task", authoritative: true, fetchedAt: new Date().toISOString() }
    const statuses = new Set()
    for (const line of raw.split("\\n")) {
      if (!line.trim() || line.startsWith("#")) continue
      const [id, title, status, deps, estimate] = line.split("|").map(s => s.trim())
      if (!id || !title || !status) continue
      statuses.add(status)
      const normalized = STATUS_MAP[status.toLowerCase()] ?? "unknown"
      const payload = {
        id, title, status: normalized, sourceStatus: status,
        dependencies: deps ? deps.split(",").map(s => s.trim()).filter(Boolean) : [],
        mapping: { ruleSetId: "generated:${spec.name}", ruleSetVersion: 1, confidence: STATUS_MAP[status.toLowerCase()] ? "exact" : "unmapped", original: { line } },
      }
      if (estimate && !isNaN(Number(estimate))) { payload.estimateHours = Number(estimate); payload.estimateConfidence = "medium" }
      events.push({ type: "task.created", schemaVersion: 1, payload, idempotencyKey: "gen:${spec.name}:" + id + ":" + line.trim(), source: src })
    }
    if (statuses.size) events.push({ type: "workflow.stages_observed", schemaVersion: 1, payload: { stages: [...statuses].map(s => ({ id: s, label: s, observed: true })) }, idempotencyKey: "gen:${spec.name}:stages:" + [...statuses].sort().join(","), source: src })
    return { events }
  },
}
`
}

export function generateAdapterSource(spec: GeneratedAdapterSpec): string {
  switch (spec.kind) {
    case "agent-registry": return registryAdapterSource(spec)
    case "task-lines": return taskLinesAdapterSource(spec)
    default: throw new Error(`unsupported generated adapter kind: ${spec.kind}`)
  }
}

export function writeGeneratedAdapter(root: string, spec: GeneratedAdapterSpec, source: string): { file: string; checksum: string } {
  const idir = integrationDir(root)
  const file = join(idir, "adapters", `${spec.name}.adapter.ts`)
  mkdirSync(join(idir, "adapters"), { recursive: true })
  // preserve previous version for rollback
  if (existsSync(file)) {
    const prev = readFileSync(file, "utf8")
    const hist = join(idir, "adapters", "history", `${spec.name}.${sha256(prev).slice(0, 12)}.adapter.ts`)
    mkdirSync(join(idir, "adapters", "history"), { recursive: true })
    if (!existsSync(hist)) writeFileSync(hist, prev)
  }
  writeFileSync(file, source)
  trackFile(root, file)
  return { file, checksum: sha256(source) }
}

export async function loadGeneratedAdapter(file: string, version: string): Promise<Adapter> {
  const mod = await import(pathToFileURL(file).href + `?v=${encodeURIComponent(version)}`)
  const adapter = mod.default as Adapter
  if (!adapter?.manifest?.id || typeof adapter.probe !== "function" || typeof adapter.collect !== "function") {
    throw new Error("generated adapter does not satisfy the Adapter contract")
  }
  return adapter
}

/** Contract test in isolation: probe + collect + schema validation of every emitted event. */
export async function contractTestAdapter(adapter: Adapter, ctx: AdapterContext): Promise<{ ok: boolean; errors: string[]; eventCount: number; probe: ProbeResult | null }> {
  const errors: string[] = []
  let probe: ProbeResult | null = null
  let eventCount = 0
  try {
    probe = await adapter.probe(ctx)
    if (!probe || typeof probe.ok !== "boolean") errors.push("probe() returned invalid ProbeResult")
  } catch (e) { errors.push(`probe() threw: ${(e as Error).message}`) }
  try {
    const { events } = await adapter.collect(ctx)
    eventCount = events.length
    for (const e of events) {
      const err = validateEvent(e.type, e.schemaVersion, e.payload)
      if (err) errors.push(`event ${e.type}: ${err}`)
      if (!e.idempotencyKey) errors.push(`event ${e.type}: missing idempotencyKey (dedup required)`)
    }
  } catch (e) { errors.push(`collect() threw: ${(e as Error).message}`) }
  return { ok: errors.length === 0, errors, eventCount, probe }
}

export function listGeneratedAdapterFiles(root: string): string[] {
  const dir = join(integrationDir(root), "adapters")
  try { return readdirSync(dir).filter(f => f.endsWith(".adapter.ts")).map(f => join(dir, f)) } catch { return [] }
}

export { makeContext }
