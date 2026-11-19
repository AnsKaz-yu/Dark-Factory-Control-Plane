# DFCP Security Model

## 1. Permission tiers

| Tier | Allowed | Examples |
|---|---|---|
| `discovery` | read-only filesystem within project root; no execution | evidence scan, structure detection |
| `monitor` | read-only APIs / whitelisted read-only git | adapter probes & collect |
| `configure` | writes confined to `.dark-factory/` | project config, generated adapters, manifests |
| `write` | explicit Core API work operations | task create/update/claim/release, releases |
| `maintenance` | adapter version switch/rollback, reconciliation | update manager (within granted permissions) |

Every adapter operation declares its tier. Adapters get `discovery`+`monitor` by default;
`configure` is used only by the integration layer inside `.dark-factory/`; `write` and
`maintenance` require explicit project-config grants (`permissions.allowWrite`,
`allowStructural`, `allowMaintenance`).

## 2. Hard boundaries

- **Read-only discovery.** No project script is ever executed during discovery or probes.
- **Confined filesystem.** AdapterContext refuses paths outside the project root.
- **Whitelisted git.** Only read-only subcommands; dangerous flags refused; no shell.
- **No arbitrary commands.** Adapters cannot spawn processes. Anything requiring execution
  is a Category C proposal needing explicit human approval.
- **Writes confined & reversible.** All product writes into a target project go to
  `.dark-factory/` and are tracked in `generated/install-manifest.json`; uninstall removes
  only tracked files. OpenCode kit files are tracked separately and never overwrite existing
  files.
- **Harness business logic is never modified** for monitoring convenience. If telemetry is
  missing, the Setup Agent proposes a minimal integration point and applies it only through
  the approved installation procedure.

## 3. Secrets

- Credentials are referenced by **env var name** in adapter config (`tokenEnv`, `userEnv`);
  values are read from the environment at call time.
- No secrets in Capability Manifests, fingerprints, generated adapters, events or logs.
- The core binds `127.0.0.1` by default; no telemetry leaves the machine.
- Optional API token for remote core access is a deployment concern (out of scope v1).

## 4. Update safety

- Category A auto-applies only compatible, tested changes.
- Category B applies within previously granted permissions, with contract tests, diff,
  verification and rollback readiness.
- Category C (permission expansion, source-of-truth changes, possible history loss,
  irreversible operations) never auto-applies; plan + explicit approval.
- Adapter updates cannot expand permissions; a generated adapter requesting new access is
  a Category C change.

## 5. Plugin boundary

The OpenCode plugin is a thin client: it forwards events and calls the Core API. It holds no
state, runs no orchestration, and performs kit installation only on explicit `factory_setup`
invocation. Host API differences are handled defensively; a missing core never crashes the
OpenCode host (retry loop, bounded buffers).

## 6. Data integrity as a security property

- Append-only log + atomic snapshot rename; corrupt lines quarantined, never destroyed.
- Idempotent ingestion prevents replay/duplicate corruption.
- Unknown/incompatible events are recorded as diagnostics and never applied — a malformed
  or hostile event cannot mutate state.
- Authoritative-source strategy prevents auxiliary sources from hijacking entities.
