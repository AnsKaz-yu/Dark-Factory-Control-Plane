# Migration Report — Legacy Dashboard Plugin → DFCP

Source: `reservoiros-dashboard` OpenCode plugin (read-only snapshots in `research/`).
Full analysis: [Reverse Engineering Report](re/legacy-plugin-reverse-engineering.md).

## 1. Migrated (as ideas, re-implemented on the new architecture)

| Legacy capability | DFCP implementation |
|---|---|
| Task graph: statuses, priorities, dependencies, per-task tests | Core domain `Task` + projections; dependency DAG separate from hierarchy; acceptance criteria added |
| Component tree + readiness rollup | `Component` + `componentReadiness` (single server-side implementation; honest nature tags) |
| Coverage/CRAP reporting | Component `metrics` (coverage/tests/crap) via `component.updated`; weighted rollups replaced by explicit per-metric coverage notes |
| Agent heartbeat registry | `Agent` + `AgentSession` with evidence tracking; stale ⇒ `unknown`, never completion |
| Merge queue view (FIFO, dead-letter) | `merge-queue-file` adapter + `MergeQueue` projection; independent Task/Pipeline/Merge states |
| LikeC4 drill-down diagrams | `likec4` adapter (optional) + Components architecture map; honest unavailable state |
| Non-destructive corruption recovery | EventStore quarantine + verified snapshots + replay (generalized, append-only) |
| Cross-process write safety lessons | Single-writer append-only log + atomic snapshot rename (locks eliminated) |
| Real-time updates | SSE with typed notifications + `lastSeq` resume (replaces ping+full-refetch) |
| Auto-unblock of dependents | Projection rule on status change (no side effects in handlers) |

## 2. Rewritten from scratch (structural root causes addressed)

| Legacy problem (root cause) | DFCP replacement |
|---|---|
| Mutable `project-state.json` (RC1) | Event-sourced log: IDs, idempotency, seq, dedup, replay, history |
| Plugin-as-application (RC2) | Standalone Core Product; plugin = thin HTTP client + event forwarder |
| Hardcoded sibling-repo paths, Windows-only (RC3) | Evidence-based discovery + adapter registry + generated adapters; cross-platform |
| `any` DTOs, duplicated server/client rollups (RC4) | Single `types.ts` + validators + contract tests; all derivation server-side |
| UI shows everything regardless of sources (RC5) | Capability Manifest → dashboard config; verified-only sections |
| Observation mixed with orchestration (RC6) | No dispatcher/auto-merge/auto-resolver in DFCP; writes are explicit permission-scoped API operations |
| Shadow worktree state, stale caches, lock sniping | Per-project isolated storage; single writer; no shared mutable document |
| Fixed ports, silent server death | Configurable port/host; explicit errors; health endpoint |
| In-memory recovery counters | Persisted diagnostics + capped retry semantics in projections |

## 3. Excluded (deliberately not migrated)

- WMI/PowerShell detached process spawning and hardcoded absolute tool paths.
- Dispatcher / auto-merge / conflict-resolver / auto-recover loops (orchestration belongs to
  the project's harness, not the observability product).
- Architect-analyst auto-task-creation from gate/oracle reports (harness-specific policy;
  in DFCP the Operations Agent creates tasks explicitly via the API).
- The 9-stage canonical loop (`feature→red→…→ci`) as an imposed workflow — DFCP shows
  **observed** stages per project.
- Dual agent registries with conflicting semantics — unified `Agent` model with source
  attribution and evidence.
- `seed.json` as a hidden initial truth — projects start empty; data comes from verified
  sources or explicit API creation.

## 4. Data migration path (for users of the legacy plugin)

Legacy state is a single JSON document; DFCP ingestion is event-based. A one-shot importer
can map `tasks{}` → `task.created` events (preserving original statuses via `sourceStatus`),
`agents{}` → `agent.registered` + `agent.status_changed`, architecture tree →
`component.updated`. History before migration is not reconstructible (the legacy format had
none) — DFCP history starts at import time. No legacy file is modified by the import.

## 5. Verification

Migration correctness is covered by the test suite (34 tests): domain/projection semantics,
adapter contracts, drift/reconciliation, update/rollback, history preservation, and full
HTTP E2E on two synthetic harnesses (standard + custom).
