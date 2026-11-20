# Clean-Deploy Friction Fixes (ReservoirOS evaluation follow-up)

Follow-up to `reservoiros-clean-deploy-report.md`. Every friction point below was fixed in
the product (code + docs) and covered by regression tests where applicable
(`tests/unit/deploy-fixes.test.ts`, 7 tests). Verified live against the ReservoirOS target.

| # | Friction | Fix | Verification |
|---|---|---|---|
| F1 | Plugin hash-id vs CLI slug → duplicate projects | Plugin id = slug of directory name (same as CLI); core `POST /api/projects` dedups by resolved root path and returns the existing project | unit test "F1"; live: orphan merged (332 events preserved) and removed; one `reservoiros` project |
| F2 | autoSetup appeared inert | Consequence of F1 (plugin assessed the hash-id project while CLI created the slug one). autoSetup now also treats all-`unknown` manifests as unassessed | live: agent_monitoring supported via plugin push |
| F3 | CLI setup didn't install the kit | `factory setup` now installs the kit via shared `installKit()` (additive, tracked, never overwrites) — parity with plugin path | code + kit manifest tracking |
| F4 | installation.md §5 overpromised target layout | §5 rewritten: manifest/discovery/fingerprint/log live in core data dir; target keeps config + generated adapters + cursors only | docs |
| F5 | LikeC4 export present but `architecture_map: unavailable` | Adapter + discovery unwrap `{projects:[…]}` exports; explicit candidate paths checked regardless of walk budget | unit test "F5"; live: supported (88 elements / 24 views) without manual config |
| F6 | Adapter config keys discoverable only in source | Adapter Development Guide §8: full config reference table for all built-ins | docs |
| F7 | Live session never appeared as agent | Projections auto-register agents on `agent.heartbeat` / `session.started` (heartbeat proves activity, never completion) | unit test "F7"; live: 7 agents, 2 working |
| F8 | Discovery non-determinism on large repos | Walk never descends `.git`/`.dark-factory`/`.opencode/plugins`; well-known tracker candidates checked directly; tracker read cap raised 200KB→4MB (real state was 284KB and got truncated); nested container keys (`tasks` as object-of-objects) recognized in discovery AND adapter | unit tests "F8b"; live: 206 tasks ingested with original statuses preserved |
| F8c | Re-discover kept stale empty source selection | `host.discover` source-refresh: empty/degraded probe + better discovery suggestion ⇒ config switched and re-probed (recorded, reversible) | unit test "F8c"; live: tracker switched roadmap→project-state.json, 206 tasks |
| F9 | doctor `healthy:true` with unverified agent_monitoring | doctor adds "agent monitoring verified" check + recommendation; healthy reflects it | live: 9 checks |
| F10 | EADDRINUSE without remediation hint | `serve.ts` prints reuse/`--port` guidance | code |
| F11 | Entry points / pid-file semantics unclear | installation.md §3 notes: full vs core-only entry, port reuse, `stop` scope | docs |
| F12 | ExperimentalWarning looks like an error | Documented as benign (Node type-stripping notice); exit code 0 | docs note in installation |
| F13 | Setup printed URL without project fragment | `factory setup` prints `…/#/<id>` | code |
| F14/F15 | Uninstall wording + prefix check + kit removal | Uninstall removes only manifest-tracked paths (integration dir + tracked kit/plugin additions), separator-safe prefix checks, recursive-safe removal, reverts `.git/info/exclude` patterns it added | unit test "F14/F15" |
| F16 | Absolute root paths in target JSON (publication gate risk) | `project.json` stores `rootName` only; `ensureLayout` appends `.dark-factory/` to **local-only** `.git/info/exclude` (never tracked, never published, reverted on uninstall); deployed instance sanitized | unit test "F16"; live target config clean |
| F17 | Noisy per-tool activity notes | Kept by design (full observability); documented; heartbeats coalesced per 30s window | docs |

## Live verification after fixes (ReservoirOS)

- `task_management: supported` — **206 tasks** from `project-state.json`
  (done 109, ready 78, blocked 11, planning 5, in_progress 3); original statuses
  (`awaiting-approval`, `in-progress`, …) preserved in `sourceStatus`/`mapping.original`.
- `workflow_stages` observed: done / in-progress / ready / blocked / awaiting-approval.
- `agent_monitoring: supported` — 7 agents, 2 working (live plugin push).
- `architecture_map: supported` — LikeC4, 88 elements / 24 views, auto-detected.
- `git_monitoring: supported`; `ci_cd`, `merge_queue`, `release_planning: unavailable`
  (mechanisms live in the sibling harness repo, outside the discovery root — honest limitation;
  composite cross-repo sources remain a documented v1 boundary).
- doctor: 9 checks, healthy; 4/4 adapters sync ok.
- Target integrity: only untracked additions (`.dark-factory/`, `.opencode` kit/plugin),
  zero tracked-file modifications, zero git state changes; `.git/info/exclude` keeps status clean.

## Operational note

Updating an already-loaded plugin copy requires an OpenCode service restart
(`opencode service restart`) — hot-reload of `.opencode/plugins` content is not guaranteed
by the host. Documented in plugin INSTALL.md.
