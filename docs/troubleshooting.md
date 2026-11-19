# Integration Troubleshooting Guide

Symptom → cause → action. Start with `factory doctor` and the Integrations screen.

## Dashboard shows a section as unavailable / hidden

- **Cause:** capability not verified (`unavailable`/`not_configured`/`unknown`).
- **Action:** Integrations → capability matrix shows the reason. Run `factory discover`;
  if a mechanism exists but needs config (Jenkins URL, tracker path, queue field mapping),
  add it to `.dark-factory/config/project.json` and re-discover. If the format is custom,
  generate an adapter (`adapter:generate`). Never expect a section without a verified source.

## Data looks outdated

- **Cause:** adapter `stale` (no successful sync recently) or core not syncing.
- **Action:** check freshness badges (`lastSuccessAt`); `factory sync`; if the source file
  changed format, see "schema violations" below. Stale data is shown as last-good with a
  timestamp — not as current fact.

## Adapter degraded / sync errors

- **Cause:** source unreadable (corrupt JSON, moved file, API down, auth failure).
- **Action:** `factory doctor` shows the error; fix the source or config. Other adapters
  keep working by design. For API adapters check the env var referenced by `tokenEnv`.
  BOM-prefixed files (PowerShell writers) are tolerated automatically.

## "unknown events" / "schema violations" alerts

- **Cause:** harness event contract drifted (new/changed event shapes).
- **Action:** `factory diff` → `event_contract_changed` / `event_contract_violation`;
  inspect raw payloads via `GET /api/projects/:id/events?type=diagnostic.`; update the
  adapter/mapping (`adapter:update`) or approve a Category C plan. Unknown events are
  preserved as diagnostics, never applied.

## New workflow stage shows tasks as `unknown`

- **Cause:** source status not in the mapping (honest behavior — semantics not invented).
- **Action:** extend `statusMap` in the adapter config (or generated adapter) with the
  correct normalized status; re-sync. Original values are always preserved in
  `sourceStatus`/`mapping.original`.

## Agent shows `unknown` with "no heartbeat"

- **Cause:** no recent events/heartbeats. Absence of heartbeat is NOT completion.
- **Action:** check the plugin connection (`plugin/connect`), event forwarding, session
  activity. Explicit lifecycle events override inferred status.

## Task claim returns 409

- **Cause:** task owned by another agent, blocked by dependencies, or done/cancelled.
- **Action:** read the task card (owner, blockers); release or complete blockers first.
  This is atomic-claim protection, not an error.

## Two sources disagree about a task

- **Cause:** multiple adapters observe one capability without an authoritative declaration.
- **Action:** set `sources.task_management.authoritative` in project config; auxiliary
  sources then add but never overwrite authoritative entities.

## Drift detected after harness change

- **Cause:** fingerprint mismatch (agents/stages/configs/tools changed).
- **Action:** `factory diff` to review categories; `factory reconcile` applies A/B within
  granted permissions; approve C targets explicitly. History is preserved; rollback available
  for adapter updates.

## Generated adapter update refused

- **Cause:** contract tests failed (invalid events, missing idempotency keys, probe error).
- **Action:** read the returned errors; fix the adapter source; previous version stays
  active. Use `adapter:rollback` if a bad version was activated earlier.

## Core unreachable from the plugin

- **Cause:** core not started / wrong `coreUrl` / port conflict.
- **Action:** `factory start` (or `npm start`); check `--port`; plugin retries every 15 s.
  The plugin never crashes the OpenCode host when the core is down.

## Corrupt event log line

- **Cause:** interrupted write / external tampering.
- **Action:** none needed — the line is quarantined to `diagnostics/corrupt-log-lines.jsonl`,
  valid events intact, projections rebuild. Inspect the quarantine file for forensics.
