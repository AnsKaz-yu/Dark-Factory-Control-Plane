# Adapter Development Guide

Adapters connect arbitrary harnesses to DFCP **without touching Core Product code**.
This guide is the complete contract for built-in and project-specific adapters.

## 1. Contract

```ts
interface Adapter {
  manifest: AdapterManifest
  probe(ctx: AdapterContext): Promise<ProbeResult>
  collect(ctx: AdapterContext): Promise<{ events: OutboundEvent[]; notes?: string[] }>
  subscribe?(ctx, emit): Promise<() => void>     // optional push sources
  operations?: Record<string, OperationDef>      // optional write ops, permission-tiered
}

AdapterManifest {
  id: string                  // "git", "jenkins", "generated:<name>"
  version: string             // adapter's own semver
  kind: "builtin" | "generated"
  title, description: string
  contractVersion: 1
  capabilities: CapabilityId[]
  compatibility: { core: ">=0.1.0" }
  sourceStability: "official-api" | "documented-format" | "undocumented-internal"
  riskNotes?: string          // REQUIRED honesty for undocumented internals
}
```

### AdapterContext (what an adapter may use)

- `readText(path)`, `exists(path)`, `listDir(path)` — **read-only, confined to the project
  root** (paths outside are refused).
- `git(args)` — whitelisted read-only subcommands only (`rev-parse`, `log`, `for-each-ref`,
  `merge-base`, `status`, `show`, `diff`, `branch`, `tag`, `config`, `ls-files`, `remote`);
  dangerous flags refused; no shell.
- `fetch` — network for official APIs; reference credentials by **env var name** in config
  (`tokenEnv`), never embed secrets.
- `config` — adapter-specific configuration from `.dark-factory/config/project.json`.
- `logger` — diagnostics sink.
- **No arbitrary command execution.** If a harness truly needs it, that is a Category C
  integration proposal requiring explicit approval — not an adapter capability.

## 2. probe() — verification, not declaration

Return `ProbeResult { ok, confidence, detail, capabilities }`. Probe must perform a REAL
read of the interface. Map each provided capability to a status with explicit limitations:

- readable + fully mapped → `supported`;
- readable but fields/statuses missing → `partial` + limitations;
- found but unreadable → `degraded`;
- absent → `unavailable`; mechanism without connection → `not_configured`.

Never return `supported` because a file exists.

## 3. collect() — normalized events with preserved originals

Emit registered event types (see `docs/specs/event-contracts.md`). Rules:

1. **Idempotency keys are mandatory** — stable per entity+revision
   (e.g. `adapter:path:taskId:hash(raw)`); snapshots use content hashes so unchanged data
   is not re-ingested.
2. **Preserve originals** — task events carry `sourceStatus` and
   `mapping { ruleSetId, ruleSetVersion, confidence, original }`.
3. **Unknown source statuses → `unknown` + confidence `unmapped`** — never invent semantics.
4. **Throw on source corruption** — the host isolates the failure, marks the capability
   `degraded`, and keeps every other adapter running.
5. Keep payloads within the registered schemas; the core rejects violations as diagnostics.

## 4. Built-in adapter checklist

- [ ] manifest with honest `sourceStability` (+ `riskNotes` for internals)
- [ ] probe performs a real read and reports limitations
- [ ] collect emits idempotent, schema-valid events with originals preserved
- [ ] configurable field/status mapping with sensible auto-detection
- [ ] contract tests against fixtures (see `tests/integration/adaptive.test.ts`)
- [ ] no writes to the harness; no secrets; no arbitrary commands

## 5. Generated (project-specific) adapters

When no built-in fits, the Setup Agent generates an adapter into
`<project>/.dark-factory/adapters/<name>.adapter.ts`:

1. investigate the source contract (format, fields, lifecycle);
2. generate self-contained TS (no runtime imports; types are stripped by Node);
3. the generator embeds the standard status dictionary + explicit overrides;
4. **contract test in isolation**: `probe()` + `collect()`; every emitted event validated
   against the core registry; missing idempotency keys fail the test;
5. only then activate (version record + checksum); previous versions archived in
   `adapters/history/` for rollback;
6. drift detection watches the source file; schema changes trigger reconciliation.

Generation API: `POST /api/projects/:id/adapter/generate` with
`{ name, kind: "agent-registry" | "task-lines", path, fields?, statusMap? }`.
Custom kinds: write the adapter file yourself following §1–§3, then
`POST /api/projects/:id/adapter/update` to contract-test and activate it.

## 6. Versioning & compatibility

- Adapters version independently of the core; `compatibility.core` is checked by the
  update manager.
- Updates are local (adapter + config), never a product reinstall.
- Every activation records `{version, checksum, file, previousVersion}`; rollback restores
  the archived content and re-runs contract tests before switching.

## 7. Composite integrations

Multiple adapters may serve one project (tasks from a custom file, agents from OpenCode,
CI from Jenkins, queue from a script's state file, architecture from LikeC4). Declare the
authoritative source per capability in project config; auxiliary adapters add but never
overwrite authoritative entities.
