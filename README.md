# Dark Factory Control Plane (DFCP)

**Engineering Work Management & Observability Platform for autonomous development.**

[Русская версия](README.ru.md)

DFCP observes and manages the software development process of any project — tasks, agents,
workflow, Git, CI/CD, merge queues, releases and critical path — and **adapts itself to the
project's actual engineering harness** instead of forcing projects into a predefined workflow.

> Status: active development. See `docs/` for requirements, architecture and specifications.

## Key ideas

- **Core Product** — standalone event-sourced server: domain model, event ingestion, state
  projections, task management, metrics, REST API, capability-driven web dashboard. Runs
  independently of OpenCode.
- **Adaptive Integration Layer** — harness discovery, capability manifest, adapter registry
  (built-in + generated project-specific adapters), harness fingerprinting, drift detection,
  reconciliation and adapter update management with rollback.
- **OpenCode Integration Kit** — a thin plugin (event forwarding, project registration,
  commands), setup/operations/diagnostics agents and skills.
- **Capability-driven UI** — one codebase; each project's dashboard is configured from its
  verified Capability Manifest. Unsupported features are never shown as working.

## Principles

1. Normalize what is common, preserve what is project-specific.
2. Never display unverified data as fact.
3. One authoritative source per entity; explicit conflict strategy for multiple sources.
4. Observation must survive harness evolution: detect drift, reconcile, update adapters,
   keep history.
5. Zero runtime dependencies (Node.js ≥ 22.18, native TypeScript execution).

## Repository layout

```
packages/
  core/        Core Product: domain, events, projections, analytics, API, dashboard server
  adapters/    Built-in adapters (git, opencode, file-task-tracker, jenkins, github, gitlab, likec4, ...)
  integration/ Discovery, capability manifest, fingerprint, drift, reconciliation, updates
  cli/         factory CLI (setup/discover/sync/doctor/reconcile/adapter:*/...)
  plugin/      OpenCode plugin (thin) + kit/ (agents & skills installed into target projects)
  dashboard/   Capability-driven SPA (zero-dependency build via Node type stripper)
docs/          Requirements, architecture, specifications, guides, demo report
tests/         Unit / integration / e2e + synthetic harness fixtures
research/      Read-only legacy plugin snapshots + reverse engineering report
scripts/       Spec generation from live code
```

## Quick start (development)

```bash
node packages/cli/src/main.ts --help
node packages/core/src/main.ts --port 8095 --data .dfcp-data
```

Documentation index: [`docs/README.md`](docs/README.md).

## License

MIT — see [LICENSE](LICENSE).
