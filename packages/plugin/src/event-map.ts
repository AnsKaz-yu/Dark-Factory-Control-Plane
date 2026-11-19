// Defensive mapping: OpenCode server events -> DFCP typed events.
// Original event semantics are preserved in payloads; unknown events become activity
// notes (never silently dropped, never fabricated into lifecycle claims).
import { createHash } from "node:crypto"

export interface DfcpEvent {
  type: string
  schemaVersion: number
  payload: Record<string, unknown>
  idempotencyKey: string
  occurredAt?: string
  source: { adapterId: string; sourceId: string; entityKind: string; authoritative: boolean; fetchedAt: string }
}

const SRC = { adapterId: "opencode", sourceId: "opencode-plugin", entityKind: "agent", authoritative: true }

function hash(s: string): string { return createHash("sha256").update(s).digest("hex").slice(0, 20) }

function now(): string { return new Date().toISOString() }

function ev(type: string, payload: Record<string, unknown>, key: string, entityKind = "agent"): DfcpEvent {
  return { type, schemaVersion: 1, payload, idempotencyKey: `oc:${key}`, source: { ...SRC, entityKind, fetchedAt: now() } }
}

/** Extract a session id from the many possible event shapes (defensive). */
export function sessionIdOf(event: Record<string, unknown>): string | null {
  const p = (event.properties ?? {}) as Record<string, unknown>
  const info = (p.info ?? {}) as Record<string, unknown>
  const part = (p.part ?? {}) as Record<string, unknown>
  const candidates = [p.sessionID, event.sessionID, info.id, part.sessionID, (p.session as Record<string, unknown> | undefined)?.id]
  for (const c of candidates) if (typeof c === "string" && c) return c
  return null
}

export const agentIdOfSession = (sessionID: string): string => `oc:${sessionID}`
export const sessionIdOfAgent = (agentId: string): string => `oc-ses:${agentId.replace(/^oc:/, "")}`

/** Map one OpenCode event to zero or more DFCP events. */
export function mapOpenCodeEvent(event: Record<string, unknown>): DfcpEvent[] {
  const type = String(event.type ?? "")
  const p = (event.properties ?? {}) as Record<string, unknown>
  const sid = sessionIdOf(event)
  const out: DfcpEvent[] = []
  const key = (suffix: string) => hash(`${type}:${sid ?? ""}:${suffix}:${JSON.stringify(p).slice(0, 400)}`)

  if (!type) return out

  if (type.startsWith("session.") && sid) {
    const agentId = agentIdOfSession(sid)
    const info = (p.info ?? {}) as Record<string, unknown>
    const title = typeof info.title === "string" ? info.title : undefined
    if (type === "session.created" || (type === "session.updated" && info.title)) {
      out.push(ev("agent.registered", { id: agentId, name: title ?? `session ${sid.slice(0, 12)}`, kind: "opencode", role: "opencode session" }, `reg:${sid}`))
      out.push(ev("session.started", { id: sessionIdOfAgent(agentId), agentId, opencodeSessionId: sid, title, model: typeof info.model === "string" ? info.model : undefined }, `ses:${sid}`, "session"))
    }
    if (type === "session.idle") {
      out.push(ev("agent.status_changed", { id: agentId, status: "waiting", evidence: "event" }, `idle:${sid}:${key("i")}`))
    }
    if (type === "session.deleted") {
      out.push(ev("session.ended", { id: sessionIdOfAgent(agentId) }, `del:${sid}`, "session"))
      out.push(ev("agent.status_changed", { id: agentId, status: "stopped", evidence: "event" }, `stop:${sid}`))
    }
    if (type === "session.error") {
      const err = (p.error ?? {}) as Record<string, unknown>
      out.push(ev("agent.error", { id: agentId, message: String(err.message ?? err.name ?? "session error") }, `err:${sid}:${key("e")}`))
    }
    if (type === "session.updated") {
      out.push(ev("agent.heartbeat", { id: agentId, note: "session updated" }, `hb:${sid}:${key("u")}`))
    }
    return out
  }

  if (type === "message.part.updated" || type === "message.updated") {
    if (sid) {
      const part = (p.part ?? {}) as Record<string, unknown>
      const tool = typeof part.tool === "string" ? part.tool : undefined
      const state = (part.state ?? {}) as Record<string, unknown>
      const status = typeof state.status === "string" ? state.status : undefined
      out.push(ev("agent.heartbeat", { id: agentIdOfSession(sid), note: tool ? `tool ${tool} ${status ?? ""}`.trim() : "message activity" }, `hb:${sid}:${key("m")}`))
      if (tool && status === "completed") {
        out.push(ev("activity.note", { text: `tool ${tool} completed`, entity: sid }, `tool:${sid}:${key("t")}`, "activity"))
      }
      if (tool && status === "error") {
        out.push(ev("agent.error", { id: agentIdOfSession(sid), message: `tool ${tool} error: ${String(state.error ?? "").slice(0, 300)}` }, `toolerr:${sid}:${key("te")}`))
      }
    }
    return out
  }

  if (type.startsWith("permission.")) {
    out.push(ev("activity.note", { text: `opencode ${type}`, entity: sid ?? undefined }, `perm:${key("p")}`, "activity"))
    return out
  }

  if (type === "file.edited") {
    out.push(ev("activity.note", { text: `file edited: ${String(p.file ?? "")}`, entity: sid ?? undefined }, `file:${key("f")}`, "activity"))
    return out
  }

  // unknown / unmapped: preserve as activity, never fabricate lifecycle meaning
  out.push(ev("activity.note", { text: `opencode event: ${type}`, entity: sid ?? undefined }, `raw:${key("r")}`, "activity"))
  return out
}

/** Tool hook (execute.after) -> heartbeat + activity note. */
export function mapToolExecution(input: { tool: string; sessionID?: string; status: string; error?: string }): DfcpEvent[] {
  const out: DfcpEvent[] = []
  const key = hash(`${input.tool}:${input.sessionID ?? ""}:${input.status}:${now()}`)
  if (input.sessionID) {
    out.push(ev("agent.heartbeat", { id: agentIdOfSession(input.sessionID), note: `tool ${input.tool} ${input.status}` }, `toolhb:${key}`))
  }
  out.push(ev("activity.note", { text: `tool ${input.tool}: ${input.status}${input.error ? " — " + input.error.slice(0, 200) : ""}`, entity: input.sessionID }, `toolact:${key}`, "activity"))
  if (input.status === "error" && input.sessionID) {
    out.push(ev("agent.error", { id: agentIdOfSession(input.sessionID), message: `tool ${input.tool}: ${input.error ?? "error"}` }, `toolerr:${key}`))
  }
  return out
}
