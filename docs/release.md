# Release Documentation

## Versioning

- Product (core/adapters/integration/cli/dashboard/plugin): **semver**, currently `0.1.0`.
  All packages share the product version; the plugin declares compatibility via the V2 API.
- Event contracts: `EVENT_CONTRACT_VERSION` (envelope) + per-type `schemaVersion`.
  Breaking payload changes bump the type's schemaVersion; old versions are rejected as
  diagnostics (never silently applied).
- Capability contract: `CAPABILITY_CONTRACT_VERSION`; adapter contract: `ADAPTER_CONTRACT_VERSION`.
- Adapters version independently (`AdapterManifest.version` + version records with checksums).

## Release checklist

1. `npm test` — unit + integration + E2E green (34 tests at 0.1.0).
2. `npm run build` — dashboard bundle builds and parses (`node --check dist/app.js`).
3. `npm run docs:events` — event spec regenerated from the live registry.
4. Manual smoke: `npm start`, `factory setup` on both synthetic fixtures, dashboard sections
   match capabilities, drift/reconcile/rollback demo passes.
5. Publication firewall scan: no restricted terms in tracked content or history.
6. Tag `vX.Y.Z`; publish packages (`dfcp-core`, `dfcp-adapters`, `dfcp-integration`, `dfcp-cli`,
   `dfcp-dashboard`, `opencode-dark-factory`) — zero runtime dependencies, Node ≥ 22.18.
7. Update CHANGELOG (features/fixes/contract changes/migration notes).

## Compatibility policy

- Core API is additive within a major version; new endpoints/fields never break old clients.
- Plugin targets the OpenCode V2 plugin API (tested 1.19.5); defensive handling keeps it
  loadable on hosts lacking optional surfaces (hooks/event subscribe).
- Generated adapters are re-contract-tested on every core update path that touches them;
  failures keep the previous version active.

## Artifacts per release

- Source tag + npm packages.
- `docs/specs/event-contracts.md` regenerated.
- Test report summary (counts) in the release notes.
- Migration notes when contracts change (see [migration.md](migration.md)).

## Rollback

- Product: redeploy previous tag; data dirs are forward-compatible within a major version
  (append-only log; snapshots verified by prefix hash — an older core simply replays).
- Per-project adapters: `factory adapter:rollback` (archived versions + contract tests).
