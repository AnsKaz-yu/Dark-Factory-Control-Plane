# Repository Isolation Report (public, sanitized)

**Date:** 2026-11-19
**Product repository:** `dark-factory-control-plane`

> Local absolute paths are recorded in a local-only copy of this report
> (`research/local-only/`, gitignored) in accordance with the project's publication policy.
> Below, `<workspace>` denotes the parent directory that contains the existing project
> repositories; it is **not** itself a git repository.

## 1. New repository

| Item | Value |
|---|---|
| Location | `<workspace>/dark-factory-control-plane` (sibling of existing repos, not nested in any worktree) |
| Git root | verified via `git rev-parse --show-toplevel` → the repository directory itself |
| Initial branch | `main` |
| Remote (development) | `https://github.com/AnsKaz-yu/Dark-Factory-Control-Plane.git` |
| Parent directory | verified **not** a git repository (no `.git`), so the new repo is independent |

## 2. Existing repositories discovered (read-only sources)

| Repository | Access mode |
|---|---|
| ReservoirOS (product repo) | read-only (directory listing, config) |
| ReservoirOS-harness (engineering harness repo) | read-only (legacy plugin sources, dashboard data) |
| ReservoirOS-harness-remediation | discovered only, not read |

Additional read-only sources: the global OpenCode config directory (installed legacy plugin
instance), the OpenCode installation (version **1.19.5**), official OpenCode plugin
documentation (opencode.ai).

## 3. Isolated research snapshots (inside this repository only)

- `research/legacy-plugin-snapshot/` — copy of the legacy dashboard plugin + harness-viz plugin
  + dashboard data files from the harness repository.
- `research/legacy-plugin-live/` — copy of the installed plugin instance from the global
  OpenCode plugins directory.

Snapshots were scanned for restricted terms before committing (none found). No secrets were
copied: credentials present in the global OpenCode config were **not** copied into this repo.

## 4. Write operations during development

All writes are confined to:

1. This repository directory (all source, tests, docs, fixtures).
2. The approved scratch temp directory (disposable probe files only).

No builds, installs, tests, formatters, or git state-changing commands were executed in any
existing repository. No dependency installation was performed in any existing project.
All integration testing uses synthetic fixtures under `tests/.runtime/` (gitignored),
built inside this repository.

## 5. Independence confirmation

- Own `.git`, source tree, tests, docs, commit history; no submodule/subtree relationship.
- No runtime dependency on any researched repository: legacy snapshots are research material
  only; product code never imports from them.
- Zero runtime dependencies (Node ≥ 22.18 native TypeScript execution).

## 6. Verification commands (reproducible)

```powershell
git -C <workspace>/dark-factory-control-plane rev-parse --show-toplevel
Test-Path <workspace>/.git                                   # False
git -C <workspace>/ReservoirOS status --porcelain            # unchanged by this work
git -C <workspace>/ReservoirOS-harness status --porcelain    # unchanged by this work
```
