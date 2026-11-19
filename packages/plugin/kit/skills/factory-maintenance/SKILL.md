---
name: factory-maintenance
description: Maintain DFCP integrations as the harness evolves — drift reconciliation, adapter updates with contract tests, rollback, history preservation. Trigger on factory reconcile, adapter update, harness drift, integration diff, rollback adapter.
---

# Factory Maintenance

Keep the integration accurate through harness evolution; preserve all history.

## Steps
1. `factory_integration_diff` — DriftReport with categories:
   - A: auto-applied by reconciliation; verify.
   - B: prepare update → contract tests → diff → switch → verify → rollback ready.
   - C: plan + explicit user approval only.
2. Mapping updates: extend status maps, preserve originals, unmapped → unknown + limitation;
   bump versions; keep old rules for history.
3. `factory_adapter_update` (contract-tested). Failure keeps previous version active.
   Rollback: `POST /api/projects/<id>/adapter/rollback {adapterId}`.
4. `factory_sync` + `factory_doctor`; confirm manifest + dashboard sections reflect reality.
5. Verify history: event count monotonic, task histories and session links intact.
6. Summarize changes and reasons (drift/reconciliation records are stored by the Core).

## Invariants
- Local adapter updates preferred over reinstall.
- No permission expansion without approval.
- Writes confined to `.dark-factory/` unless approved.
