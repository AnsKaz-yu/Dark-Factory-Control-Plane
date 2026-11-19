---
name: factory-operations
description: Operate DFCP task management — create/claim/update tasks, hierarchy vs dependencies, acceptance criteria, releases and readiness. Trigger on factory task, task tree, claim task, release scope, release readiness, work management.
---

# Factory Operations

Work through the typed `factory_*` tools; the Core is the system of record.

## Steps
1. `factory_status` / `factory_task {action:"list"}` — read current state first.
2. Create: stable id, title, kind, parentId (tree), dependencies (DAG), priority,
   estimateHours (+confidence), acceptanceCriteria, componentId.
3. Update statuses via the tool (history + auto-unblock are projection rules).
4. Claim/release atomically; respect 409 (owned/blocked/done).
5. `factory_map` to link branches/sessions/components/releases.
6. Releases: create scope; read readiness; `insufficient_data` ≠ ready; never present
   structural critical path as a time forecast.

## Invariants
- Hierarchy ≠ dependency graph.
- External trackers stay authoritative for their entities.
- Gaps become tasks, not silent workarounds.
