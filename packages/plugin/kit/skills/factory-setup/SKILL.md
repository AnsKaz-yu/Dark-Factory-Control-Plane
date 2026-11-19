---
name: factory-setup
description: Connect a project to Dark Factory Control Plane — read-only harness discovery, capability verification, adapter selection/generation, dashboard configuration. Trigger on factory setup, connect project, discover harness, capability manifest, adapt integration.
---

# Factory Setup

Connect the current project to DFCP by adapting to its actual harness.

## Steps
1. Ensure the core runs: `factory start` (or `node packages/cli/src/serve.ts`). Default API: http://127.0.0.1:8095.
2. `factory_setup` tool (or CLI `factory setup --root <dir>`): registers the project,
   discovers harness evidence (configs, scripts, task stores, CI, queues, architecture,
   event feeds), probes adapters, builds the Capability Manifest, syncs, installs the kit.
3. Review the manifest. `supported` = probe-verified. For gaps:
   - configure built-in adapters (paths/fields/statusMap/URLs) in `.dark-factory/config/project.json`;
   - generate adapters for custom formats (`adapter/generate` with `{name, kind, path, statusMap}`);
   - declare authoritative sources for multi-source capabilities.
4. `factory_sync` + `factory_doctor`; open `factory_dashboard`.
5. Report capabilities, limitations and minimal proposals for gaps. Never fabricate support.

## Invariants
- Read-only discovery; no project script execution.
- Writes only into `.dark-factory/` (tracked, reversible).
- Normalize common semantics; preserve original statuses; unknown → `unknown`.
- No secrets in manifests/adapters (env var names only).
