---
name: factory-diagnostics
description: Diagnose DFCP integration health — stale/degraded sources, missed events, schema violations, mapping drift, adapter failures. Trigger on factory doctor, dashboard wrong, stale data, integration error, missed events, desync.
---

# Factory Diagnostics

Establish whether the Control Plane picture is trustworthy; find root causes.

## Steps
1. `factory_doctor` — integrity, projections, verification, adapter sync, baseline.
2. Freshness badges: which sources are stale/degraded, since when (lastSuccessAt).
3. `factory_integration_diff` — drift vs baseline; categories A/B/C.
4. Diagnostic events (`GET /api/projects/<id>/events?type=diagnostic.`) — unknown types and
   schema violations with raw payloads = contract drift evidence.
5. Compare source content vs dashboard for suspect capabilities; check mapping confidence
   and sourceStatus preservation.
6. Classify: staleness → sync; adapter failure → isolate + fix proposal; contract drift →
   Maintenance Agent; missing source → honest unavailable + minimal integration proposal.

## Invariants
- Read-only; never invent values.
- No heartbeat ≠ completion (status `unknown`).
- One broken adapter must not disable others.
