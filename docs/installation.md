# DFCP Installation Guide

## Requirements

- Node.js **≥ 22.18** (native TypeScript execution; zero runtime dependencies).
- Git (for the git adapter and fixtures).
- OpenCode with the V2 plugin API (tested: 1.19.5) — optional; the Core runs standalone.

## 1. Get the product

```bash
git clone https://github.com/AnsKaz-yu/Dark-Factory-Control-Plane.git
cd Dark-Factory-Control-Plane
```

No `npm install` needed — the product has zero runtime dependencies.

## 2. Build the dashboard

```bash
npm run build        # node packages/dashboard/build.mjs (Node type stripper)
```

## 3. Start the Core

```bash
npm start            # node packages/cli/src/serve.ts --port 8095 --data ~/.dfcp
# options: --port, --host (default 127.0.0.1), --data
```

Verify: `curl http://127.0.0.1:8095/api/health`. Dashboard: `http://127.0.0.1:8095/`.

## 4. Connect a project

### Option A — CLI (no OpenCode required)

```bash
npm run factory -- setup --root /path/to/project --name "My Project"
npm run factory -- doctor --project my-project
npm run factory -- dashboard --project my-project
```

`setup` registers the project, runs read-only discovery, verifies capabilities via probes,
selects/generates adapters, syncs data and writes `.dark-factory/` inside the target project.

### Option B — OpenCode plugin

1. Add to the project's (or global) `opencode.json(c)`:
   ```jsonc
   { "plugins": [ { "package": "/abs/path/Dark-Factory-Control-Plane/packages/plugin",
                    "options": { "coreUrl": "http://127.0.0.1:8095" } } ] }
   ```
   or place the plugin directory under `.opencode/plugins/dark-factory/`.
2. Run `/factory-setup` in OpenCode. The plugin registers the project, forwards events,
   and installs the agent/skill kit into `.opencode/`.

## 5. What gets written into the target project

```
<project>/.dark-factory/
  config/project.json            # adapters, permissions, authoritative sources
  config/capabilities.json       # (core meta copy) verified manifest
  adapters/*.adapter.ts          # generated project-specific adapters
  adapters/history/              # previous versions (rollback)
  generated/install-manifest.json# every tracked file (for uninstall)
  generated/opencode-kit-manifest.json
  diagnostics/                   # probe/drift/sync diagnostics
  state/                         # adapter cursors
```

Nothing else in the project is modified. Existing `.opencode/agent|skills` files are never
overwritten.

## 6. Verify

- `factory doctor` — integrity, verification, adapter health, baseline.
- Dashboard — only verified sections visible; Integrations shows the full capability matrix.
- Work in an OpenCode session → agents appear live.

## 7. Lifecycle commands

`install/setup · discover · sync · status · doctor · reconcile · diff · adapter:status ·
adapter:update · adapter:rollback · adapter:generate · start · stop · uninstall`
(see [CLI documentation](cli.md)).

## 8. Update the product

```bash
git pull && npm run build && npm run factory -- stop && npm start
```

Adapter/config state lives in the target project and the core data dir — product updates do
not touch integrations. Per-project adapter updates are local (`adapter:update`).

## 9. Uninstall

```bash
npm run factory -- uninstall --root /path/to/project --yes   # removes only .dark-factory/
```

Remove the plugin entry/directory and the kit files listed in the kit manifest if desired.
Core data: delete the `--data` directory.

## 10. Multiple projects

One core serves many projects; storage, config, capabilities and history are isolated per
project under `<data>/projects/<id>/`. Switch projects in the dashboard header.
