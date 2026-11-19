# Adapter Update & Reconciliation Specification

## 1. Integration Baseline (Harness Fingerprint)

Taken at setup and after every reconciliation:

```ts
HarnessFingerprint {
  projectId, takenAt, coreVersion, pluginVersion?
  adapterVersions: Record<adapterId, version>
  files: { path, sha256, role }[]     // harness-relevant evidence ONLY (no business code)
  components: string[]                // detected tools/mechanisms
  agents: string[]                    // agent definition names
  integrations: string[]              // active adapter ids
  capabilityManifestHash: string
  eventContractVersion: number
  mappingVersions: Record<ruleSetId, version>
  workflowStages: string[]
  limitations: string[]
  diagnosticsBaseline?: number        // schema-violation counter at baseline time
}
```

No secrets are stored. Roles include: opencode-config, agent-definition, agent-registry,
task-tracker, custom-task-format, ci, merge-queue, workflow-script, architecture,
event-feed, git-strategy, release-planning, skills, commands.

## 2. Drift detection (economical)

`detectDrift` re-runs the bounded read-only evidence scan and compares:
- file inventory: added / removed / modified (sha256);
- agent set, workflow stage set, detected tool set;
- diagnostic counters (new schema violations / unknown events).

No change → `unchanged: true` (fast exit). It is invoked periodically/on-demand —
**never per ingested event**. No script execution, no network.

Detected change kinds include: `agent_added/removed`, `workflow_stage_added/removed`,
`tool_added/removed`, `<role>_added/removed/changed`, `tracker_data_changed`,
`event_contract_changed`, `event_contract_violation`, `no_baseline`.

## 3. Change categories

| Category | Definition | Handling |
|---|---|---|
| **A** | safe compatible: no semantics change, no new permissions, contract-compatible, tests pass | auto-apply + verify (e.g. new agent definition, tracker data refresh) |
| **B** | structural but reversible: mapping changes, new capabilities, adapter structure changes; verifiable in isolation | prepare → contract tests → diff → switch → verify → rollback ready; auto within granted `allowStructural` permission, else approval |
| **C** | breaking/high-risk: permission expansion, harness business-logic changes, source-of-truth changes, possible event/history loss, data migrations, irreversible ops | NEVER auto; plan + explicit approval (`reconcile {approve:[targets]}`) |

## 4. Reconciliation flow

1. `detectDrift` → DriftReport (recorded as `integration.drift_detected` event).
2. `planReconciliation` → actions `{action: keep|change|add|remove|recreate|verify,
   target, category, applied, requiresApproval}`.
3. Apply permitted actions:
   - agent added → register in monitoring; agent removed → mark stopped (history kept);
   - data change → sync;
   - structural → re-discover, re-probe adapters, rebuild manifest, bump mapping versions,
     sync, retake baseline.
4. Record `ReconciliationResult` (actions, manifestUpdated, adaptersUpdated, verified,
   errors) as `integration.reconciled` event + integration meta.
5. Unapproved C actions remain pending with a concrete plan.

## 5. Adapter Update Manager

- `adapter:status` — versions, active version, compatibility, sync state, history depth.
- `adapter:update`:
  - generated: reload file → **contract tests** (probe + collect + schema validation) →
    activate new version record (checksum) → archive previous in `history/` → sync →
    manifest refresh. Failed tests refuse activation; previous version stays active.
  - built-in: config refresh from discovery + re-probe + version record.
- `adapter:rollback` — restore archived previous content, re-run contract tests, switch
  version records (`rolled_back` / `active`), sync.
- Local updates preferred; the product itself is not reinstalled for adapter changes.

## 6. Failure isolation & degraded operation

- A throwing adapter degrades only its capabilities (`degraded` + error limitation);
  all other adapters continue; the dashboard keeps working.
- Stale sources keep their section visible but badged with `lastSuccessAt`; data is shown
  as last-good, never as current fact.
- Reconciliation never deletes tasks, events, histories, session links or metrics.

## 7. Data preservation & migrations

- The event log is append-only; projections rebuild from it (snapshot + verified replay).
- Mapping changes are versioned; old rules remain valid for historical records.
- Incompatible harness changes use Category C plans with explicit, reversible migration
  steps; history is preserved across all of them (tested in
  `tests/integration/adaptive.test.ts` and `tests/e2e/product.test.ts`).
