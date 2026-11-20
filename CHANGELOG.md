# Changelog

## 0.1.0 — 2026-11-20

First public release of the Dark Factory Control Plane.

### Core
- Event-sourced core: append-only per-project log, idempotent ingestion (eventId +
  idempotencyKey), monotonic seq, replay, verified snapshots, corrupt-line quarantine.
- 35 typed, versioned event contracts; unknown/incompatible events quarantined as diagnostics.
- Projections: tasks (hierarchy ≠ dependencies, atomic claim/release, auto-unblock, history),
  agents (8 statuses, evidence, heartbeat auto-registration), sessions, components, git,
  pipelines, merge queue, releases, workflow transitions.
- Analytics: readiness rollups, critical path + Gantt schedule to release target (late-finish
  alert, estimated-duration flags), release readiness with evidence, metrics with coverage
  notes, repository activity (commits/events per day).
- REST API + SSE with gap-free resume; multi-project isolation; project id dedup by root +
  aliases for merged duplicates.

### Adaptive integration
- Read-only evidence-based discovery (deterministic on large repos; container-key task
  stores; LikeC4 `{projects:[…]}` exports; 4MB read cap).
- Capability Manifest with probe-verified statuses; source refresh on re-discover.
- 9 built-in adapters + contract-tested generated project adapters (versioned, rollback).
- Harness fingerprint, drift categories A/B/C, reconciliation, adapter update manager.
- Confined reversible installs: `.dark-factory/` + tracked `.opencode` additions,
  local-only `.git/info/exclude`, manifest-tracked uninstall.

### OpenCode kit
- Thin V2 plugin: event-stream + tool-hook forwarding, 12 `factory_*` tools, `/factory-*`
  commands, kit (4 agents + 4 skills) installed additively.
- Verified by a clean deployment onto a real foreign project performed by an agent that
  knew only this repository (docs/deployment/).

### Dashboard & UX
- Single-codebase capability-driven SPA, 14 sections, EN/RU (Settings selector + `?lang=`),
  SSE live updates, capture mode for deterministic screenshots.
- Gantt and repository-activity charts; honesty tags (real/computed/estimated/missing).

### Distribution & docs
- Zero runtime dependencies (Node ≥ 22.18 native TS); CLI lifecycle; CI workflow.
- Full documentation set: requirements, architecture/ADRs, UX, specs (events, capabilities,
  discovery, adapter guide, reconciliation), security, installation, CLI, plugin,
  troubleshooting, migration, release, deployment reports.
- README in EN/RU styled after ferrum; AGENT-QUICKSTART.md copy-paste deployment prompt.

### Testing
- 46 tests: 27 unit, 16 integration (two synthetic harnesses), 3 e2e over HTTP.
