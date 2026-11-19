// Built-in adapter: generic JSONL event feed (custom harness telemetry).
// Reads new lines since a persisted cursor; events may be DFCP-shaped or mapped.
import type { Adapter, AdapterContext, ProbeResult, OutboundEvent } from "./contract.ts"
import { adapterSource } from "./contract.ts"
import { sha256 } from "../../core/src/ids.ts"
import { EVENT_REGISTRY } from "../../core/src/schema.ts"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"

const ID = "generic-events"

export interface GenericEventsConfig {
  path: string
  format?: "dfcp" | "raw"     // dfcp: lines are {type,schemaVersion,payload}; raw: wrap as activity.note
}

function cursorPath(ctx: AdapterContext): string {
  return join(ctx.integrationDir, "state", `${ID}.cursor.json`)
}

function readCursor(ctx: AdapterContext): number {
  try { return JSON.parse(readFileSync(cursorPath(ctx), "utf8")).offset ?? 0 } catch { return 0 }
}

function writeCursor(ctx: AdapterContext, offset: number): void {
  const p = cursorPath(ctx)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify({ offset, at: new Date().toISOString() }))
}

export const genericEventsAdapter: Adapter = {
  manifest: {
    id: ID, version: "1.0.0", kind: "builtin", title: "Generic Event Feed",
    description: "JSONL event file produced by a custom harness (DFCP-shaped events or raw notes). Cursor-based incremental read.",
    contractVersion: 1, capabilities: ["activity_events", "agent_monitoring", "workflow_stages"],
    compatibility: { core: ">=0.1.0" }, sourceStability: "documented-format",
    riskNotes: "Contract depends on the harness event format; drift detection watches the file schema.",
  },
  async probe(ctx): Promise<ProbeResult> {
    const cfg = ctx.config as unknown as GenericEventsConfig
    if (!cfg?.path) return { ok: false, confidence: "inferred", detail: "no path configured", capabilities: { activity_events: { status: "not_configured" } } }
    const raw = ctx.readText(cfg.path)
    if (raw === null) return { ok: false, confidence: "inferred", detail: `event file not found: ${cfg.path}`, capabilities: { activity_events: { status: "unavailable", limitations: ["event file absent"] } } }
    const lines = raw.split("\n").filter(l => l.trim())
    if (!lines.length) return { ok: true, confidence: "verified", detail: "event file readable (empty)", capabilities: { activity_events: { status: "supported", limitations: ["no events yet"] } } }
    let dfcp = 0, bad = 0
    const types = new Set<string>()
    for (const line of lines.slice(-50)) {
      try {
        const e = JSON.parse(line)
        if (e.type && EVENT_REGISTRY.has(e.type)) { dfcp++; types.add(e.type) } else if (e.type) { types.add(e.type) } else bad++
      } catch { bad++ }
    }
    const sampled = Math.min(lines.length, 50)
    const caps: ProbeResult["capabilities"] = {
      activity_events: { status: "supported", observableStates: [...types], events: [...types], completeness: dfcp / sampled },
    }
    if ([...types].some(t => t.startsWith("agent."))) caps.agent_monitoring = { status: "partial", limitations: ["agent events present in feed; session linkage depends on feed content"], events: [...types].filter(t => t.startsWith("agent.")) }
    return { ok: true, confidence: "verified", detail: `${lines.length} lines, ${dfcp}/${sampled} recent lines are registered DFCP events`, capabilities: caps }
  },
  async collect(ctx) {
    const cfg = ctx.config as unknown as GenericEventsConfig
    const raw = ctx.readText(cfg.path)
    if (raw === null) return { events: [] }
    const lines = raw.split("\n")
    const offset = readCursor(ctx)
    const events: OutboundEvent[] = []
    let consumed = offset
    for (let i = offset; i < lines.length; i++) {
      const line = lines[i]
      if (!line.trim()) { consumed = i + 1; continue }
      try {
        const e = JSON.parse(line)
        if (cfg.format !== "raw" && e.type && EVENT_REGISTRY.has(e.type)) {
          events.push({
            type: e.type, schemaVersion: e.schemaVersion ?? 1, payload: e.payload ?? {},
            idempotencyKey: e.eventId ? `${ID}:${cfg.path}:${e.eventId}` : `${ID}:${cfg.path}:${i}:${sha256(line)}`,
            occurredAt: e.occurredAt,
            source: adapterSource(ID, cfg.path),
          })
        } else {
          events.push({
            type: "activity.note", schemaVersion: 1,
            payload: { text: typeof e.text === "string" ? e.text : line.slice(0, 500), entity: e.entity },
            idempotencyKey: `${ID}:${cfg.path}:${i}:${sha256(line)}`,
            occurredAt: e.at ?? e.occurredAt,
            source: adapterSource(ID, cfg.path),
          })
        }
      } catch {
        events.push({ type: "activity.note", schemaVersion: 1, payload: { text: line.slice(0, 500) }, idempotencyKey: `${ID}:${cfg.path}:${i}:${sha256(line)}`, source: adapterSource(ID, cfg.path) })
      }
      consumed = i + 1
    }
    if (consumed > offset) writeCursor(ctx, consumed)
    return { events }
  },
}
