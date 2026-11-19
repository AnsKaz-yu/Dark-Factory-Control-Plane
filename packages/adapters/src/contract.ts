// Adapter contract — the typed boundary between any harness and the DFCP core.
// Adapters normalize what is common and PRESERVE original source values.
// Adapters never modify harness business logic; write operations are explicit and tiered.
import type { AdapterManifest, CapabilityId, CapabilityStatus, EventEnvelope } from "../../core/src/types.ts"

export type PermissionTier = "discovery" | "monitor" | "configure" | "write" | "maintenance"

export interface ProbeResult {
  ok: boolean
  confidence: "verified" | "declared" | "inferred"
  detail: string
  capabilities: Partial<Record<CapabilityId, {
    status: CapabilityStatus
    limitations?: string[]
    observableStates?: string[]
    details?: Record<string, unknown>
    operations?: string[]
    events?: string[]
    completeness?: number
  }>>
}

export interface AdapterContext {
  projectId: string
  projectRoot: string
  integrationDir: string
  config: Record<string, unknown>
  logger: (msg: string) => void
  fetch: typeof fetch
  /** Read-only text access, confined to projectRoot (returns null when missing). */
  readText: (path: string) => string | null
  exists: (path: string) => boolean
  listDir: (path: string) => string[]
  /** Restricted read-only git helper (whitelisted subcommands only). */
  git: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>
}

export type OutboundEvent = Pick<EventEnvelope, "type" | "schemaVersion" | "payload" | "idempotencyKey" | "occurredAt"> & {
  source?: Partial<EventEnvelope["source"]>
}

export interface OperationDef {
  name: string
  tier: PermissionTier
  description: string
  execute: (ctx: AdapterContext, input: Record<string, unknown>) => Promise<{ ok: boolean; detail: string }>
}

export interface Adapter {
  manifest: AdapterManifest
  probe(ctx: AdapterContext): Promise<ProbeResult>
  collect(ctx: AdapterContext): Promise<{ events: OutboundEvent[]; notes?: string[] }>
  subscribe?(ctx: AdapterContext, emit: (e: OutboundEvent) => void): Promise<() => void>
  operations?: Record<string, OperationDef>
}

export function adapterSource(adapterId: string, sourceId?: string): EventEnvelope["source"] {
  return { adapterId, sourceId: sourceId ?? adapterId, entityKind: "mixed", authoritative: true, fetchedAt: new Date().toISOString() }
}

/** Stable idempotency key for snapshot-style pulls: ingest only when content changes. */
export function snapshotKey(adapterId: string, domain: string, contentHash: string): string {
  return `${adapterId}:${domain}:${contentHash}`
}
