# Capability Manifest Specification (contract v1)

The Capability Manifest is the **verified** description of what DFCP can actually observe
in a connected project. It drives the dashboard configuration and every honesty guarantee.

## Schema

```ts
CapabilityManifest {
  projectId: string
  generatedAt: ISO
  generatorVersion: string          // core version that produced it
  contractVersion: 1
  capabilities: Record<CapabilityId, Capability>
  sources: { id, kind, description, authoritativeFor: CapabilityId[] }[]
}

Capability {
  id: CapabilityId
  status: "supported" | "partial" | "not_configured" | "unavailable" | "stale" | "degraded" | "unknown"
  source?: string                   // human-readable source (file path / provider)
  adapterId?: string                // adapter that provides it
  operations: string[]              // e.g. ["read"] or write ops exposed by the adapter
  events: string[]                  // event types the source produces
  observableStates: string[]        // e.g. source statuses, run states
  limitations: string[]             // explicit, user-visible restrictions
  completeness?: number             // 0..1 fraction of mapped/observable data
  lastSyncAt: ISO | null
  confidence: "verified" | "declared" | "inferred"
  contractVersion: 1
  details?: object                  // e.g. { observableStages, fields, taskCount }
}
```

Capability ids: `task_management`, `task_hierarchy`, `agent_monitoring`, `workflow_stages`,
`git_monitoring`, `ci_cd`, `merge_queue`, `release_planning`, `critical_path`,
`architecture_map`, `activity_events`, `metrics`.

## Status semantics

| Status | Meaning | UI behavior |
|---|---|---|
| `supported` | probe of the real interface succeeded; full observation | full section |
| `partial` | only part of the information is observable | section + limitation banner, limited fields |
| `not_configured` | mechanism exists but is not connected | hidden; reason in Integrations |
| `unavailable` | no source exists | hidden; reason in Integrations |
| `stale` | source worked but has not synced recently | visible, badged, last-good data with timestamp |
| `degraded` | source errors | visible, badged; other capabilities unaffected |
| `unknown` | not assessed yet | hidden until discovery |

## Verification rule (hard requirement)

**A capability is `supported` only after a successful adapter probe** — a real read of the
interface (parse the file, call the API, run read-only git). Finding a file is evidence for
discovery, never proof of support. Probe results carry `confidence: verified`; discovery-only
states are `declared`/`inferred`.

## Derived capabilities

- `activity_events` — always `supported` (the core event log itself).
- `metrics` — `supported`/`partial` iff task or agent data is verified; every metric carries
  a coverage note; unavailable inputs yield `null`, never fabricated numbers.
- `critical_path` — `supported` with dependencies + estimates; `partial` (structural path,
  explicitly labeled) with dependencies only; `unavailable` without dependencies.
- `task_hierarchy` — `supported` iff a parent field is observed; otherwise the Task Tree
  falls back to a flat list marked partial.

## Multi-source rule

When several adapters provide one capability, the manifest records all providers in
`sources`; the project config declares `sources.<capability>.authoritative` and a conflict
strategy (`authoritative-wins` default). Auxiliary sources may add entities but never
overwrite authoritative ones. Every record keeps `source` + `fetchedAt`.

## Lifecycle

- Produced by `factory:discover` / `factory:setup` (discovery → probes → manifest).
- `lastSyncAt` refreshed by `factory:sync`; failures degrade only the affected capabilities.
- Reconciliation rebuilds it after drift; history is never deleted.
- Stored at `<project>/.dark-factory/config/capabilities.json` (core meta) and served at
  `GET /api/projects/:id/capabilities`; dashboard config at
  `GET /api/projects/:id/dashboard-config`.
