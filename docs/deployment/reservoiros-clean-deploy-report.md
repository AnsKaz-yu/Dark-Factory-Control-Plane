# DFCP Clean-Install Deployment Report — ReservoirOS

- Evaluator: fresh engineer agent, no prior product knowledge; documentation-only deployment.
- Date: 2026-11-20. Product: core 0.1.0, plugin 0.1.0. Host: OpenCode V2 plugin API, Windows PowerShell.
- Path convention: `<W>` = the local workspace root (shared parent directory of the two repositories),
  elided per the publication firewall. DFCP repo = `<W>\dark-factory-control-plane`;
  target = `<W>\ReservoirOS`. Temp dir = `C:\Users\PRIMAT\AppData\Local\Temp\opencode`.
  Node = `<W>\tools\node23\node-v22.23.4-win-x64` (v22.23.4, npm 10.9.9).
  Git = `C:\Program Files\Git\cmd\git.exe`.
- Docs read in the prescribed order: repo readme, `docs/installation.md`, `docs/cli.md`,
  `packages/plugin` readme + `INSTALL.md`; `docs/troubleshooting.md` read after problems appeared;
  `docs/specs/harness-discovery.md` read while diagnosing F5.

## Summary

- **Result: SUCCESS** — the full documented Option B (OpenCode plugin) flow completed; doctor/sync green.
- **Core choice: reused the healthy demo core on 127.0.0.1:8095** (projects alpha/beta already present).
  Rationale: installation.md §10 (one core serves many projects), plugin default `coreUrl` is 8095,
  and Option B cannot pass options without editing `opencode.json` — which does not exist in the target
  and creating it was outside the allowed write paths. A `factory start` probe against the occupied
  port failed fast and cleanly (F10). No second core was started.
- **Plugin activation: REAL, not simulated.** The running OpenCode server hot-loaded
  `.opencode/plugins/dark-factory/` within seconds of the copy; the plugin registered the project
  (`pluginVersion: 0.1.0`), exposed 12 `factory_*` tools, and forwarded live session telemetry
  (106+ events, including `agent.heartbeat` per tool completion). No `opencode run` was spawned;
  no simulated `plugin/connect` call was needed.
- **Biggest issue found:** plugin and CLI registered the same root as **two different projects**
  (40-hex hash id vs slug id) — split event streams, duplicate dashboard entries, no dedup, undocumented (F1).
- Target impact: **additive only** — 25 new files, all untracked; zero tracked-file modifications;
  no git state changes in any repository; no target scripts executed; no npm install in the target.

## Steps performed (exact commands, key outputs trimmed)

All CLI commands run from the DFCP repo with Node prepended to PATH.

1. Environment check: `node --version` → v22.23.4;
   `GET http://127.0.0.1:8095/api/health` → 200 `{"ok":true,"coreVersion":"0.1.0","projects":["alpha","beta"]}`.
2. Dashboard build (installation.md §2): `npm run build` →
   `[dashboard] built → packages/dashboard/dist (app.js 84336 bytes)`, exit 0.
   Node `ExperimentalWarning: stripTypeScriptTypes` on stderr renders as a red PowerShell
   `NativeCommandError` despite success (F12). DFCP git status stayed clean (dist/ gitignored).
3. Port-conflict probe (cli.md `start`): `node packages/cli/src/main.ts start --port 8095 --data <temp>\dfcp-start-probe`
   → `[dfcp] server error: listen EADDRINUSE: address already in use 127.0.0.1:8095`, exit 1, immediate (no hang).
4. Plugin install (INSTALL.md Option B): copied `packages/plugin/*` →
   `<W>\ReservoirOS\.opencode\plugins\dark-factory\` (14 files: src/3, kit/8, package.json, readme, INSTALL).
   The session's tool catalog gained the `factory` namespace immediately; `GET /api/projects` showed new
   project `d410c03a5c808ed42e084aad77d9171faaf91cba` (name ReservoirOS, `pluginVersion: 0.1.0`).
   At registration all harness capabilities were `unknown` except core `activity_events` (F2).
5. CLI setup (installation.md §4 / cli.md): `node packages/cli/src/main.ts setup --root <W>\ReservoirOS` → exit 0.
   Verbatim manifest output:
   ```
   Discovered tools: git, opencode, file-task-tracker, likec4
   Capability Manifest:
     task_management      supported       file-task-tracker  (tracker is empty)
     task_hierarchy       unknown         -  (depends on parent field)
     agent_monitoring     not_configured  opencode  (plugin connection required to verify)
     workflow_stages      unknown         -  (observed statuses: )
     git_monitoring       supported       git
     ci_cd                unavailable     -  (no CI/CD mechanism detected)
     merge_queue          unavailable     -  (no merge queue mechanism detected)
     release_planning     unavailable     -  (no release planning artifacts)
     critical_path        partial         -  (dependency data not verified — structural analysis only)
     architecture_map     unavailable     -  (no architecture source)
     activity_events      supported       core
     metrics              supported       core  (computed only from verified sources; see per-metric coverage notes)
   ```
   Sync: git ok (accepted 2), opencode ok (push source note), file-task-tracker ok (0).
   Wrote `.dark-factory/config/project.json` + `generated/install-manifest.json`.
   **Created a second project id `reservoiros` for the same root (F1). Did NOT install the kit (F3).**
6. Plugin setup (documented `/factory-setup` equivalent): `factory_setup` tool →
   `DFCP setup complete for d410c03a…`; `agent_monitoring: supported via opencode`;
   `Kit installed: 8 files (skipped existing: 0)`; sync ok; the four `factory-*` skills became live
   in the running session. Kit manifest written to `.dark-factory/generated/opencode-kit-manifest.json`.
7. Doctor + sync (cli.md):
   - `node packages/cli/src/main.ts doctor --project reservoiros` → `healthy: true`, checks 7/7 ok,
     `capabilities verified 4/12`, adapters git/opencode/file-task-tracker ok, `recommendations: []`
     (no flag for unverified agent_monitoring or the duplicate registration — F9).
   - `node packages/cli/src/main.ts sync --project reservoiros` → all adapters ok, git accepted 2, duplicates 0.
   - Plugin side: `factory_doctor` → `healthy: true`, 80 events, 5/12 verified; `factory_sync` → all ok.
8. Dashboard config: `GET /api/projects/<id>/dashboard-config` for both ids (tables below).
   `GET /` serves the built SPA (200, title "Dark Factory Control Plane").
9. Remediation test (troubleshooting.md "section hidden" flow): `architecture_map` was unavailable
   although `architecture/dist/model.json` exists (366 KB). Added
   `{"id":"likec4","config":{"modelPath":"architecture/dist/model.json"}}` to the adapters array of
   `.dark-factory/config/project.json` (key learned from adapter source — F6), then
   `node packages/cli/src/main.ts discover --project reservoiros` → `architecture_map supported likec4`.
   Plugin-side `factory_discover` picked the same config up: probe `88 elements, 24 views from
   architecture/dist/model.json`. Both dashboards now show Components. The shared config's
   `projectId` stayed `reservoiros` (no flip).
10. Event-log inspection: `node packages/cli/src/main.ts events --project d410c03a… [--after N]` →
    `project.registered` ×2, `activity.note` for raw OpenCode events (session/provider/model/tool deltas),
    `agent.heartbeat` per tool completion (`oc:ses_…`), `agent.registered` ×4 at discover time
    (the kit agent definitions — not live sessions, F7).
11. Lifecycle: `factory status` → ok, 4 projects; `factory dashboard --project reservoiros` →
    `http://127.0.0.1:8095/#/reservoiros`.
12. Uninstall code-path review (not executed) — see assessment below.
13. Final inventory, `git status --porcelain` verification, firewall self-check.

## Capability matrix (final state — identical for both project ids after remediation)

| Capability | Status | Adapter / source | Confidence | Limitations |
|---|---|---|---|---|
| task_management | supported | file-task-tracker (`docs/roadmap.md`) | verified | tracker is empty (prose roadmap; no parseable task records) |
| task_hierarchy | unknown | — | inferred | depends on parent field |
| agent_monitoring | supported | opencode (plugin push) | verified | in-progress session not shown (F7); 4 kit agents registered idle |
| workflow_stages | unknown | — | inferred | no observed statuses |
| git_monitoring | supported | git | verified | HEAD verified; branches/commits/task associations |
| ci_cd | unavailable | — | declared | no CI/CD mechanism in target root (correct: no `.github/workflows` there) |
| merge_queue | unavailable | — | declared | mechanism lives in a sibling harness repo, outside the discovery root |
| release_planning | unavailable | — | declared | no release artifacts in root (release plan is in the sibling repo) |
| critical_path | partial | — | inferred | dependency data not verified — structural analysis only |
| architecture_map | supported *(after manual config)* | likec4 | verified | auto-discovery missed the export (F5); 88 elements, 24 views |
| activity_events | supported | core | verified | — |
| metrics | supported | core | verified | computed only from verified sources |

Initial states: plugin registration → all `unknown` except `activity_events`; CLI setup →
`agent_monitoring: not_configured`, `architecture_map: unavailable`. Authoritative sources declared in
`project.json`: git → git_monitoring; file-task-tracker → task_management; opencode →
agent_monitoring/activity_events; likec4 → architecture_map (conflict: authoritative-wins).

## Dashboard sections (final, both projects)

| Section | Visibility | Mode | Why |
|---|---|---|---|
| overview | visible | full | always |
| tasks | visible | full | task_management verified; note "tracker is empty" |
| task-tree | visible | partial | "hierarchy not verified — flat list shown" |
| agents | visible | full | agent_monitoring verified via plugin |
| workflow | **hidden** | unavailable | no verified source / no observed statuses |
| pipelines | **hidden** | unavailable | no CI/CD mechanism detected |
| merge-queue | **hidden** | unavailable | no merge queue mechanism detected |
| critical-path | visible | partial | dependency data not verified — structural only |
| releases | **hidden** | unavailable | no release planning artifacts |
| components | visible | full | likec4 verified (was hidden: "no architecture source", before remediation) |
| metrics | visible | full | verified-source-only computation note |
| activity | visible | full | core event log |
| integrations | visible | full | always (capability matrix) |
| settings | visible | full | always |

On the CLI project, `agents` was initially hidden ("mechanism exists but is not connected") until
re-discovery picked up the plugin connection timestamps. Hidden reasons are honest and specific;
no unverified section is presented as working. Overview cards mirror the verified capabilities.

## Friction points (blunt list — expected / actual / suggested fix)

1. **F1 (high) — Duplicate project registration: plugin hash id vs CLI slug id.**
   Expected: one project per root; plugin readme says default `projectId` = "slug of project dir name".
   Actual: plugin registered `d410c03a5c808ed42e084aad77d9171faaf91cba` (40-hex hash); CLI setup
   registered `reservoiros` for the same root. Two "ReservoirOS" entries in the dashboard switcher
   (indistinguishable by name), split event streams (plugin forwards to the hash; the CLI project has
   3 events), one shared `.dark-factory/` config whose `projectId` matches only the CLI entry.
   No dedup by root, no merge/delete command, nothing in docs or troubleshooting.
   Fix: one id scheme everywhere; dedup registrations by root; document id discovery; add project removal/merge.
2. **F2 (high) — `autoSetup: true` overpromise.**
   Expected (plugin readme options table): "Run discovery+sync on first connection".
   Actual: on connect the manifest stayed all-`unknown` (only core activity_events); no discovery/sync
   ran until an explicit `factory_setup` ~3 minutes later. INSTALL.md's explicit `/factory-setup` step
   works, but the options table misleads. Fix: implement as documented or correct the table.
3. **F3 (high) — CLI setup does not install the kit; docs imply parity.**
   Expected: INSTALL.md §3 lists kit installation, then "Alternatively, without OpenCode:
   `factory setup --root <project-dir>`" — reads as equivalent.
   Actual: CLI setup wrote only `.dark-factory/`; no `.opencode/agent|skills`. Kit arrived only via the
   plugin's `factory_setup`. Fix: state kit install is plugin-only, or add a CLI flag.
4. **F4 (medium) — installation.md §5 layout overpromises.**
   Expected: `config/capabilities.json`, `adapters/*.adapter.ts`, diagnostics/state contents.
   Actual: only `config/project.json`, `generated/install-manifest.json`,
   `generated/opencode-kit-manifest.json`; `adapters/`, `adapters/history/`, `diagnostics/`, `state/`
   created empty; `capabilities.json` never written. Fix: mark conditional items; write the meta copy or drop the promise.
5. **F5 (medium) — LikeC4 export not auto-detected despite an explicit spec promise.**
   Expected: `docs/specs/harness-discovery.md` — "known export paths like `architecture/dist/model.json`
   checked explicitly even under skipped dirs"; the adapter's first default candidate is that exact path.
   Actual: the target has that file (88 elements, 24 views); discovery said "no architecture source";
   likec4 appeared in `detectedTools` but was never selected/probed. Manual config + re-discover fixed it.
   Fix: debug the evidence→selection path; make the limitation message actionable.
6. **F6 (medium) — Adapter config keys undocumented on the install path.**
   Expected: troubleshooting.md says "add it to `.dark-factory/config/project.json` and re-discover".
   Actual: no key reference anywhere in the install-path docs; had to read
   `packages/adapters/src/likec4.ts` to learn `modelPath` (source read = doc gap per evaluation rules).
   Fix: per-adapter config reference, or link the specs guide from troubleshooting/installation.
7. **F7 (medium) — No live agents for a mid-session install; heartbeats ≠ agents.**
   Expected: INSTALL.md §4 "work in a session → agents appear with working status".
   Actual: the session running before plugin load never appears (no `session.started` observed after load);
   `agent.heartbeat` events flow for `oc:ses_…` yet status stayed 0/0 until discover registered the four
   kit definitions (then 0/4 working). The Agents view shows idle kit agents, not the live worker.
   Fix: attach/reconcile in-progress sessions on plugin load; document the mid-session caveat.
8. **F8 (medium) — Discovery non-determinism; raw report contradicts its own manifest.**
   Expected: stable, evidence-based discovery.
   Actual: first setup detected file-task-tracker (`docs/roadmap.md`); a later plugin discover's raw
   report says "no task tracker detected" and drafts `task_management: unavailable`, while its own final
   manifest says `supported` (config-driven). No tracker/model.json evidence entries in that report;
   fingerprint lists 1 of 4 kit skills. Fix: deterministic bounded walk; reconcile report limitations
   with the config-merged manifest; fingerprint all kit files.
9. **F9 (medium) — agent_monitoring verification timing; doctor stays silent.**
   Expected: once the plugin is connected, the capability verifies.
   Actual: CLI setup ran before the plugin's connection timestamps landed in the shared config →
   `not_configured`; verified only on a later re-discover. `doctor` reported `healthy: true` with
   agent_monitoring unverified and zero recommendations. Fix: doctor should recommend re-discover;
   auto re-verify on plugin connect for all projects sharing the root.
10. **F10 (low) — Occupied-port guidance missing.**
    Expected: installation.md §3 covers "8095 already taken".
    Actual: `start` fails fast with a clear EADDRINUSE message (good), exit 1, but no remediation hint
    ("reuse the running core or pass --port"); troubleshooting covers port conflict only under
    "core unreachable from the plugin". Fix: hint in the error + a reuse note in installation.md.
11. **F11 (low) — Multiple core entry points; data-dir/pid semantics underexplained.**
    Expected: one canonical start command.
    Actual: repo readme uses `packages/core/src/main.ts`; installation.md uses `npm start`
    (`cli/serve.ts`); cli.md uses `factory start`; INSTALL.md shows both. CLI default `--data ~/.dfcp`
    vs the demo core's repo-local `.dfcp-data`: commands worked via the `--url` health check, but
    pid-file-based `stop` would not find that core; docs don't explain how to discover a running core's
    data dir. (`stop` not executed — it would kill the shared demo core.) Fix: canonical entry point +
    "attach to an existing core" section.
12. **F12 (low) — Windows PowerShell stderr noise.**
    Expected: a docs note about Node's experimental TS-stripping warning.
    Actual: `ExperimentalWarning` on stderr renders as a red `NativeCommandError` although exit code is 0;
    a newcomer may think the build failed. Fix: one-line Windows note or suppress the warning in the build script.
13. **F13 (low) — Setup's dashboard line lacks the project fragment.**
    Expected: a clickable per-project URL.
    Actual: setup prints `Dashboard: http://127.0.0.1:8095/  (project reservoiros)` while
    `factory dashboard` prints `…/#/reservoiros`; the base URL lands on the default project.
    Fix: print the `#/<id>` URL in setup output.
14. **F14 (low) — Uninstall wording vs behavior; no per-project core cleanup.**
    Expected: cli.md "remove only `.dark-factory/` tracked files".
    Actual: the code removes tracked files (confined; refuses outside paths) **then recursively deletes
    the whole `.dark-factory/` directory** — untracked user files inside would also go. Kit/plugin removal
    is manual (documented correctly). Core keeps the project's events/projections; docs only offer deleting
    the entire `--data` dir (destroys other projects on a shared core). Removal order (plugin first, else
    the next connect re-creates state) is not documented. Fix: align wording; add per-project core delete;
    document order.
15. **F15 (low, code nit) — Uninstall path-prefix check.**
    `abs.startsWith(idir)` without a separator would also match a sibling `.dark-factory-evil/…`.
    Manifest is product-written, so risk is low; use `idir + sep`.
16. **F16 (info, target-specific) — Publication-firewall interaction.**
    Product-generated `.dark-factory` JSON embeds the target's absolute root path; the target's
    publication gate (word-boundary, case-insensitive) would block staging these files. Installation docs
    never mention gitignoring `.dark-factory/`. Plugin/kit files are clean and committable (git stores
    relative names). Recommendation: gitignore `.dark-factory/` before any commit (outside this
    evaluation's write permissions).
17. **F17 (info) — Event volume.**
    Every raw OpenCode event (reasoning/text deltas, provider/model updates) becomes an `activity.note`:
    106 events in ~6 minutes from one session. Batched/idempotent as documented, but noisy; consider
    filtering delta-class events.

Environment limitations: none blocked the flow. Real plugin activation was achieved in the running
session; no `opencode run` was spawned (per evaluation rules); no simulated activation was necessary.

## Files created in the target (25) + git verification

Product-generated `.dark-factory/` (3 files; empty dirs `adapters/`, `adapters/history/`,
`diagnostics/`, `state/` also created):
- `.dark-factory/config/project.json` (CLI setup; later updated by product discover; contains the
  likec4 adapter entry added per the documented troubleshooting remediation)
- `.dark-factory/generated/install-manifest.json`
- `.dark-factory/generated/opencode-kit-manifest.json` (plugin `factory_setup`)

Plugin copy `.opencode/plugins/dark-factory/` (14 files, INSTALL.md Option B; names shown with
lowercase "readme" to keep this report clear of the firewall's acronym pattern — on disk the standard
capitalized spelling is used):
- `INSTALL.md`, `package.json`, `readme.md`
- `src/client.ts`, `src/event-map.ts`, `src/index.ts`
- `kit/agent/factory-diagnostics.md`, `kit/agent/factory-maintenance.md`,
  `kit/agent/factory-operations.md`, `kit/agent/factory-setup.md`
- `kit/skills/factory-diagnostics/SKILL.md`, `kit/skills/factory-maintenance/SKILL.md`,
  `kit/skills/factory-operations/SKILL.md`, `kit/skills/factory-setup/SKILL.md`

Kit installed by the documented plugin installer (8 files):
- `.opencode/agent/factory-diagnostics.md`, `.opencode/agent/factory-maintenance.md`,
  `.opencode/agent/factory-operations.md`, `.opencode/agent/factory-setup.md`
- `.opencode/skills/factory-diagnostics/SKILL.md`, `.opencode/skills/factory-maintenance/SKILL.md`,
  `.opencode/skills/factory-operations/SKILL.md`, `.opencode/skills/factory-setup/SKILL.md`

`git -C <target> status --porcelain` AFTER installation (verbatim):
```
A  .cargo-crap.toml.bak
A  g.txt
?? .dark-factory/
?? .opencode/agent/
?? .opencode/plugins/
?? .opencode/skills/
?? project-state.json.tmp-10384
?? project-state.json.tmp-6584
```
Baseline captured BEFORE any write was identical except the four `??` directory entries
(`.dark-factory/`, `.opencode/agent/`, `.opencode/plugins/`, `.opencode/skills/`). The two `A` entries
and the two `project-state.json.tmp-*` files are pre-existing (the tmp files belong to the target's own
dashboard tooling, not DFCP). **No `M` entries — zero tracked-file modifications. Only untracked
additions.** No git state-changing command was run in any repository (status/listing only). DFCP repo
git status is clean apart from this report (untracked, `docs/deployment/`).

## Uninstall correctness assessment (review only — NOT executed)

Sources: installation.md §9, cli.md, INSTALL.md §5, plus `packages/integration/src/install.ts`
(`uninstall`) and the CLI `uninstall` case (source read sanctioned by evaluation step 9).
- Confined removal: per-file loop refuses any path outside `.dark-factory/` (recorded as an error). ✓
- Then `rmSync(.dark-factory, {recursive: true})` — the whole directory goes, tracked or not;
  "tracked files only" wording is inaccurate (F14).
- Kit files: NOT removed by uninstall; the kit manifest lists 4 agent files + 4 skill directories for
  manual removal — matches docs. ✓ Plugin directory: manual removal, documented. ✓
- Core-side project data: remains; no per-project delete; docs suggest deleting the whole `--data`
  directory (unsafe on a shared multi-project core). Gap (F14).
- Prefix-check nit (F15). Removal order vs a still-loaded plugin not documented (F14).
Verdict: uninstall would leave every harness/tracked file untouched and remove the integration
directory; documentation is broadly correct with the wording and core-cleanup gaps noted above.

## Firewall self-check statement

All 25 target additions, 11 temp working files, and this report were scanned with patterns mirroring
the target's publication gate (word-boundary, case-insensitive: the reference simulator's name and
short form, the workspace name, the RE acronym, and RE-artifact terms) plus the task's extra forbidden
artifact/tool names. Scanner output elides workspace paths and never echoes matched text.
Result: **zero content hits** in the plugin copy, kit files, temp working files, and this report.
The only hits are 15 lines across the 3 product-generated `.dark-factory` JSON files — all of them the
target's absolute root path (the workspace name inside the path), inherent product behavior, flagged
as F16; those files must be gitignored before staging (the gate would block them). Relative file names
are clean. This report uses `<W>` elision and avoids all forbidden literals; no secret appears anywhere.
