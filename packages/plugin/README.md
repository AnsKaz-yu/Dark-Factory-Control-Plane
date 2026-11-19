# opencode-dark-factory

Thin OpenCode plugin for **Dark Factory Control Plane (DFCP)**.

The plugin contains NO business logic. It:
- registers the project with the DFCP Core (`POST /api/projects`);
- forwards OpenCode server events (`ctx.event.subscribe`) and tool executions
  (`ctx.tool.hook("execute.after")`) as typed DFCP events (batched, idempotent);
- keeps agent/session linkage and heartbeats (absence of heartbeat ⇒ `unknown`, never completion);
- exposes `factory_*` tools and `/factory-*` commands as thin Core API passthroughs;
- installs the agent/skill kit into `.opencode/` (tracked, reversible);
- triggers discovery / reconciliation / diagnostics on demand.

All state, projections, analytics and capability logic live in the Core Product.

## Install

See [INSTALL.md](INSTALL.md). Quick version:

1. Start the core: `node packages/cli/src/serve.ts` (default http://127.0.0.1:8095).
2. Add the plugin to `opencode.json(c)`:
   ```jsonc
   { "plugins": [{ "package": "/absolute/path/to/packages/plugin", "options": { "coreUrl": "http://127.0.0.1:8095" } }] }
   ```
   or copy/symlink this directory into `.opencode/plugins/dark-factory/`.
3. In OpenCode run `/factory-setup` (or the `factory_setup` tool).

## Options

| Option | Default | Meaning |
|---|---|---|
| `coreUrl` | `http://127.0.0.1:8095` (or `DFCP_URL`) | Core API base URL |
| `projectId` | slug of project dir name | Override project id |
| `autoSetup` | `true` | Run discovery+sync on first connection |
| `forwardEvents` | `true` | Forward OpenCode events/tool telemetry |

## Tools (namespace `factory`)

`setup`, `discover`, `status`, `task` (list/get/create/update/claim/release), `map`,
`sync`, `doctor`, `reconcile`, `adapter_update`, `adapter_status`, `integration_diff`, `dashboard`.

## Commands

`/factory-setup`, `/factory-status`, `/factory-dashboard`, `/factory-doctor`, `/factory-sync`,
`/factory-reconcile`, `/factory <subcommand>`.

## Kit

`kit/agent/*.md` — Factory Setup / Operations / Diagnostics / Maintenance agents.
`kit/skills/*/SKILL.md` — matching skills. Installed into the target project's `.opencode/`
by `factory_setup`, tracked in `.dark-factory/generated/opencode-kit-manifest.json`.

## Requirements

OpenCode with the V2 plugin API (tested against 1.19.5), Node ≥ 22.18 for the Core.
