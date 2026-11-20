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

Notes on entry points & ports:
- `factory start` / `node packages/cli/src/serve.ts` run the FULL product (core + integration
  layer). `node packages/core/src/main.ts` runs the core WITHOUT the integration layer
  (discovery/sync/reconcile endpoints return 501) — use the CLI entry for normal operation.
- If port 8095 is already in use, a core is probably already running: **reuse it**
  (`factory status`, `factory setup` auto-detect a healthy core). `factory start` exits with
  a remediation hint; pass `--port <free-port>` to run a second instance (then point the
  plugin/CLI at it via `coreUrl` / `--url` / `DFCP_URL`).
- `factory stop` stops only a core started with the SAME `--data` dir (pid file lives there).
  A core started elsewhere keeps running; stop it via its own data dir or process manager.

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
  config/project.json            # adapters, permissions, authoritative sources (rootName only, no absolute paths)
  adapters/*.adapter.ts          # ONLY if project-specific adapters were generated
  adapters/history/              # previous adapter versions (rollback), only when updates happened
  generated/install-manifest.json# every tracked file (for uninstall)
  generated/opencode-kit-manifest.json  # kit files installed by the plugin path
  state/                         # adapter cursors, only for adapters that keep cursors
  diagnostics/                   # created on demand (corrupt-line quarantine etc.)
<project>/.opencode/agent/factory-*.md      # kit agents (additive, never overwritten)
<project>/.opencode/skills/factory-*/       # kit skills (additive)
<project>/.opencode/plugins/dark-factory/   # plugin copy (Option B)
<project>/.git/info/exclude                 # ".dark-factory/" appended (LOCAL-only, never published, reverted on uninstall)
```

Notes:
- The **Capability Manifest, discovery report, fingerprint and event log live in the CORE
  data dir** (`<data>/projects/<id>/`), not in the target project. The target keeps only
  integration configuration and generated adapters.
- Nothing else in the project is modified. Existing `.opencode/agent|skills` files are never
  overwritten. No tracked file is edited (including `.gitignore`); the local-only
  `.git/info/exclude` entry keeps `git status` clean. Teams that commit integration config
  should add `.dark-factory/` to `.gitignore` themselves if they prefer it published-free.
- One root = one project: the core dedups registrations by root path, so the plugin and the
  CLI can never create duplicate projects for the same directory.

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
