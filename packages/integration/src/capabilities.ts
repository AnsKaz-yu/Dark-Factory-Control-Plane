// Capability Manifest builder: capabilities become `supported` ONLY after a successful
// probe of the real interface. File existence alone never upgrades a capability.
import type { Adapter, ProbeResult } from "../../adapters/src/contract.ts"
import type { Capability, CapabilityId, CapabilityManifest, CapabilityStatus, DiscoveryReport } from "../../core/src/types.ts"
import { CAPABILITY_IDS, CAPABILITY_CONTRACT_VERSION, CORE_VERSION } from "../../core/src/types.ts"
import { nowISO } from "../../core/src/ids.ts"

const STATUS_RANK: Record<CapabilityStatus, number> = {
  supported: 7, partial: 6, stale: 5, degraded: 4, not_configured: 3, unknown: 2, unavailable: 1,
}

export interface AdapterBinding { adapter: Adapter; config: Record<string, unknown>; probe?: ProbeResult }

export function buildManifest(projectId: string, bindings: AdapterBinding[], draft: DiscoveryReport["capabilityDraft"] | null): CapabilityManifest {
  const capabilities = {} as Record<CapabilityId, Capability>
  const sources: CapabilityManifest["sources"] = []
  for (const id of CAPABILITY_IDS) {
    capabilities[id] = {
      id, status: "unknown", operations: [], events: [], observableStates: [],
      limitations: [], lastSyncAt: null, confidence: "inferred", contractVersion: CAPABILITY_CONTRACT_VERSION,
    }
  }
  // apply probe results (verified evidence wins)
  for (const b of bindings) {
    const probe = b.probe
    if (!probe) continue
    for (const [capId, res] of Object.entries(probe.capabilities) as [CapabilityId, NonNullable<ProbeResult["capabilities"][CapabilityId]>][]) {
      const cur = capabilities[capId]
      const better = STATUS_RANK[res.status] > STATUS_RANK[cur.status] || (STATUS_RANK[res.status] === STATUS_RANK[cur.status] && probe.confidence === "verified" && cur.confidence !== "verified")
      if (better) {
        capabilities[capId] = {
          id: capId, status: res.status, source: b.adapter.manifest.id, adapterId: b.adapter.manifest.id,
          operations: res.operations ?? [], events: res.events ?? [], observableStates: res.observableStates ?? [],
          limitations: res.limitations ?? [], completeness: res.completeness,
          lastSyncAt: probe.ok ? nowISO() : null,
          confidence: probe.ok ? probe.confidence : "inferred",
          contractVersion: CAPABILITY_CONTRACT_VERSION, details: res.details,
        }
      }
    }
    if (probe.ok) {
      sources.push({
        id: b.adapter.manifest.id, kind: b.adapter.manifest.kind, description: b.adapter.manifest.title,
        authoritativeFor: Object.entries(probe.capabilities).filter(([, r]) => r && (r.status === "supported" || r.status === "partial")).map(([k]) => k),
      })
    }
  }
  // fill gaps from discovery draft (honest unverified states)
  if (draft) {
    for (const [capId, d] of Object.entries(draft) as [CapabilityId, NonNullable<DiscoveryReport["capabilityDraft"][CapabilityId]>][]) {
      const cur = capabilities[capId]
      if (cur.confidence === "verified") continue
      if (d.status === "unavailable" || d.status === "not_configured") {
        if (STATUS_RANK[d.status] >= STATUS_RANK[cur.status] || cur.status === "unknown") {
          capabilities[capId] = { ...cur, status: d.status, source: d.source, limitations: d.notes ? [d.notes] : cur.limitations, confidence: "declared" }
        }
      } else if (cur.status === "unknown" && d.notes) {
        capabilities[capId] = { ...cur, limitations: [d.notes], source: d.source }
      }
    }
  }
  // core-owned capabilities
  capabilities.activity_events = {
    ...capabilities.activity_events, status: "supported", source: "core", adapterId: "core",
    confidence: "verified", events: ["*"], observableStates: ["event log"], lastSyncAt: nowISO(),
    limitations: [],
  }
  const tm = capabilities.task_management.status
  const am = capabilities.agent_monitoring.status
  const anyData = ["supported", "partial", "stale", "degraded"].includes(tm) || ["supported", "partial", "stale", "degraded"].includes(am)
  capabilities.metrics = {
    ...capabilities.metrics,
    status: anyData ? (tm === "supported" || am === "supported" ? "supported" : "partial") : "unavailable",
    source: "core", adapterId: "core", confidence: anyData ? "verified" : "declared",
    limitations: anyData ? ["computed only from verified sources; see per-metric coverage notes"] : ["no task/agent data verified"],
    lastSyncAt: anyData ? nowISO() : null,
  }
  // critical path honesty: needs dependencies
  const cp = capabilities.critical_path
  if (cp.status === "unknown" && (tm === "supported" || tm === "partial")) {
    capabilities.critical_path = { ...cp, status: "partial", limitations: ["dependency data not verified — structural analysis only"], confidence: "inferred" }
  }
  return { projectId, generatedAt: nowISO(), generatorVersion: CORE_VERSION, contractVersion: CAPABILITY_CONTRACT_VERSION, capabilities, sources }
}
