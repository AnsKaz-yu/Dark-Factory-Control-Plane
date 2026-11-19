# DFCP Product Requirements

## 1. Vision

Dark Factory Control Plane is an Engineering Work Management & Observability Platform for
autonomous (agentic) software development. It combines YouTrack-style task management with
Jenkins-style pipeline observability, adds agent monitoring, release intelligence, and —
critically — an **Adaptive Integration Layer** that discovers and adapts to each project's
actual engineering harness.

**Core principle:** the Control Plane adapts to the project, never the reverse.
**Honesty principle:** only verified, observable data is shown as operational; everything else
is explicitly marked partial / not configured / unavailable / stale / degraded / unknown.

## 2. Personas

| Persona | Needs |
|---|---|
| Engineering owner / operator | Understand project state, blockers, release readiness, factory efficiency at a glance |
| Coordinator agent | Create/claim/update tasks, read authoritative state through a stable API |
| Setup engineer | Install DFCP into an arbitrary project with minimal manual configuration |
| Integration maintainer | See harness health, drift, adapter versions; apply/rollback updates safely |
| Adapter developer | Build new adapters against a documented, typed contract without touching Core |

## 3. Functional requirements

### 3.1 Core Product
- FR-C1: Standalone server; runs without OpenCode; Node ≥ 22.18; zero runtime dependencies.
- FR-C2: Event-sourced storage: append-only log, unique event IDs, idempotency keys,
  per-project sequence, dedup, replay, snapshot+replay recovery, integrity diagnostics.
- FR-C3: Typed, versioned event contracts; unknown/incompatible events are recorded as
  diagnostics, never silently dropped or applied.
- FR-C4: State projections for all domain entities; all derived computations server-side.
- FR-C5: REST API + SSE change stream with last-event-id resume.
- FR-C6: Multi-project support with isolated storage, config, capabilities and history.
- FR-C7: Authoritative source per entity; source attribution and fetch time on every record;
  explicit conflict strategy when multiple sources observe one capability.

### 3.2 Task management
- FR-T1: Create/read/update tasks via API, UI and agents; hierarchy Epic/Feature/Task/Subtask
  (tree) kept separate from the dependency graph (DAG).
- FR-T2: Normalized status + preserved original source status + mapping rule version +
  mapping confidence.
- FR-T3: Dependencies, priorities, assignees (agents/humans), acceptance criteria, labels,
  estimates (optional, with confidence), component links.
- FR-T4: Filtering, search, saved views, task card with full history, links to Git/CI/releases.
- FR-T5: Atomic claim/release semantics for agent assignment.
- FR-T6: Auto-unblock of dependents when a blocker completes (projection rule, not side effect).

### 3.3 Agent monitoring
- FR-A1: Agent registry with name, role, kind, real status, current task, OpenCode session,
  model, start time, duration, last event, errors.
- FR-A2: Statuses: working, waiting, blocked, reviewing, completed, failed, stopped, unknown.
- FR-A3: Missing heartbeat ⇒ `unknown`, never `completed`. Status evidence is tracked
  (event / heartbeat / inferred).
- FR-A4: Session linkage (OpenCode session IDs) and per-agent activity timeline.

### 3.4 Engineering observability
- FR-E1: Workflow view shows **observed** stages and transitions (from adapter mappings and
  real status-change events), not an imposed canonical pipeline.
- FR-E2: Git: branches, commits, tags, branch↔task associations.
- FR-E3: CI/CD: pipelines, runs, stages, jobs, statuses, durations, errors, retries, artifacts
  (Jenkins-like UX; Jenkins is not required).
- FR-E4: Merge queue: order, entries, checks, readiness, in-flight merge, conflicts,
  dead-letter reasons, retries, wait times. Task/Pipeline/Merge states are independent.
- FR-E5: Metrics: throughput, lead time, WIP, blocked time, agent utilization, pipeline
  success rate, queue wait — computed only from available data, with coverage notes.
- FR-E6: Activity timeline: all ingested events, filterable by entity/type/source.

### 3.5 Release intelligence
- FR-R1: Dependency graph + critical path (longest path by estimate; when estimates are
  missing, show structural critical path and mark it as such — never present forecasts as facts).
- FR-R2: Releases/milestones: scope (task set), readiness report (done/total, blockers,
  pipeline health, merge queue state), history.

### 3.6 Components / architecture
- FR-K1: Component tree with status/readiness rollups; LikeC4 (or other sources) optional;
  only verified architectural data displayed.

### 3.7 Adaptive integration
- FR-I1: Read-only, evidence-based harness discovery (configs, code, scripts, docs, logs);
  no execution of project scripts during discovery.
- FR-I2: Capability Manifest with statuses supported/partial/not_configured/unavailable/
  stale/degraded/unknown; `supported` requires a successful probe of the real interface.
- FR-I3: Built-in adapters + generated project-specific adapters + composite configurations;
  adapters never modify harness business logic.
- FR-I4: Adapter generation workflow: investigate → contracts → mapping → generate →
  schema validation → unit/contract tests → isolated verification → manifest → dashboard check.
- FR-I5: Integration baseline (fingerprint) excluding secrets; drift detection economical
  (fingerprinted harness files, not business code); change categories A/B/C.
- FR-I6: Reconciliation: keep/change/add/remove/recreate/verify decisions; Category A
  auto-apply; B prepare+test+diff+switch+verify+rollback; C plan+approval.
- FR-I7: Adapter update manager: versions, compatibility, history, rollback, post-update
  sync verification. Local adapter updates preferred over product reinstall.
- FR-I8: Failure isolation: one broken adapter degrades only its capabilities; the rest of
  the dashboard keeps working; stale sources are marked with last-success time.
- FR-I9: History preservation across harness changes and migrations (versioned, reversible).

### 3.8 OpenCode integration
- FR-O1: Thin plugin: project registration, event forwarding (server event stream + tool
  hooks), agent/session registration, task↔agent linkage, commands, diagnostics triggers.
- FR-O2: Commands: setup, discover, status, task, map, sync, doctor, reconcile,
  adapter:update, adapter:status, integration:diff, dashboard.
- FR-O3: Agents: Factory Setup, Factory Operations, Factory Diagnostics, Factory Integration
  Maintenance (logical roles; may be combined where it adds no value).
- FR-O4: Installer/bootstrapper writes only into a dedicated integration directory
  (`.dark-factory/`) and declared OpenCode config points; all changes reversible, tracked
  in an install manifest; uninstall restores prior state.

### 3.9 Capability-driven UI
- FR-U1: One frontend codebase; per-project dashboard configuration computed from the
  Capability Manifest; unsupported sections hidden or shown as honest unavailable states.
- FR-U2: Partial support ⇒ partial views with explicit limitation banners; no fabricated
  values; every section distinguishes real / computed / estimated / missing data.
- FR-U3: Integrations / Harness Health screen: discovered harness, adapters + versions,
  capabilities, sync status, drift, errors, available updates, last reconciliation result.
- FR-U4: Data freshness indicators everywhere (last sync, stale/degraded badges).

### 3.10 Distribution & lifecycle
- FR-D1: Independent versioning; install/configure/discover/start/stop/status/doctor/
  reconcile/adapter-update/product-update/migrate/uninstall.
- FR-D2: CLI + standalone server; npm/git distribution; no Docker requirement for v1.

## 4. Non-functional requirements

- NFR-1: Zero runtime dependencies; Node ≥ 22.18 (native TS execution).
- NFR-2: Local-first: binds 127.0.0.1 by default; no telemetry leaving the machine.
- NFR-3: Crash-safe writes (append-only log + atomic snapshot rename); recovery never
  destroys data (backup + journal).
- NFR-4: Economical drift detection (hash-based, seconds, not full rescans per event).
- NFR-5: Test coverage: unit + contract + integration + drift + migration + e2e on synthetic
  harnesses; all tests run inside this repository.
- NFR-6: Security: least-privilege adapters, permission tiers, no secrets in manifests or
  generated adapters, no arbitrary command execution by adapters without explicit grant.

## 5. Out of scope (v1)

- Executing orchestration (dispatching agents, performing merges) — stays in the harness.
- Full LikeC4 reimplementation; bit-exact anything; cloud multi-tenant hosting; auth beyond
  localhost binding + optional token.

## 6. Acceptance demonstration (Definition of Done anchors)

Two synthetic projects (A: standard OpenCode harness with Git/tasks/CI; B: substantially
different custom harness) must demonstrate: discovery → manifest → adapter selection/
generation → dashboard configuration → event ingestion → harness change → drift detection →
reconciliation → adapter update → validation, with history preserved throughout.
