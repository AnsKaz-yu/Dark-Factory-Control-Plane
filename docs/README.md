# DFCP Documentation Index

## Product & architecture
- [Product Requirements](product-requirements.md) — personas, functional/non-functional requirements, DoD anchors.
- [Architecture](architecture.md) — C4 container/component diagrams, data model, event flow, integration architecture, deployment, ADRs.
- [UX/UI Specification](ux-ui.md) — sitemap, wireframes, design system, capability→UI mapping.

## Reverse engineering & migration
- [Legacy Plugin Reverse Engineering Report](re/legacy-plugin-reverse-engineering.md) — as-built architecture, defect catalog, root causes.
- [Repository Isolation Report](re/repository-isolation-report.md) — boundaries, read-only sources, independence confirmation.
- [Migration Report](migration.md) — migrated / rewritten / excluded, data migration path.

## Specifications
- [Event Contract Specification](specs/event-contracts.md) — envelope, guarantees, registered types (generated from code).
- [Capability Manifest Specification](specs/capability-manifest.md) — statuses, verification rule, multi-source strategy.
- [Harness Discovery Specification](specs/harness-discovery.md) — evidence sources, detectors, safety, economy.
- [Adapter Development Guide](specs/adapter-development-guide.md) — full contract for built-in & generated adapters.
- [Adapter Update & Reconciliation Specification](specs/reconciliation-and-updates.md) — fingerprint, drift, categories A/B/C, rollback.
- [Security Model](security-model.md) — permission tiers, boundaries, secrets, update safety.

## Guides
- [Installation Guide](installation.md) — requirements, core, CLI/plugin setup, lifecycle, multi-project.
- [CLI Documentation](cli.md) — every `factory` command.
- [OpenCode Plugin Documentation](../packages/plugin/README.md) + [INSTALL](../packages/plugin/INSTALL.md).
- [Integration Troubleshooting Guide](troubleshooting.md) — symptom → cause → action.
- [Release Documentation](release.md) — versioning, checklist, compatibility, rollback.

## Demonstrations & tests
- [Harness Adaptation Demonstration](demo/harness-adaptation-demo.md) — two synthetic projects, full adaptive lifecycle.
- Tests: `tests/unit` (core), `tests/integration` (adaptive layer), `tests/e2e` (product over HTTP), `tests/fixtures` (synthetic harnesses).
