# Harness Discovery Specification

Discovery is a **read-only, evidence-based** investigation of a target project. It never
executes project scripts, never writes outside `.dark-factory/`, and never assumes a
predefined harness layout.

## Evidence sources (multiple, cross-checked)

1. **Configurations** — `opencode.json(c)`, `.opencode/`, CI configs, tracker configs.
2. **Code & script content** — pattern scans of workflow scripts (stage/status references),
   CI endpoint references (Jenkins URLs, etc.), merge-queue mechanics.
3. **File structure** — bounded walk (depth ≤ 3, ≤ 4000 files, skip `node_modules`, `.git`
   internals, build dirs; known export paths like `architecture/dist/model.json` checked
   explicitly even under skipped dirs).
4. **Data structure detection** — JSON/JSONL documents with task-like records
   (id/title/status fields), agent registries (entries with status/lastSeen/task),
   queue files (items with branch-like fields), custom pipe-delimited task formats.
5. **Documentation** — release plans, changelogs, roadmaps.
6. **Git metadata** — refs/heads (branch strategy), refs/tags (release evidence).
7. **Logs/feeds** — `*.jsonl` event feeds (sampled against the event contract).

Each finding is an `Evidence { kind, path, confidence: high|medium|low, snippet?, data? }`.
Filename matches alone are low/medium confidence; structure/content checks raise it.

## Detector → adapter suggestion mapping

| Evidence | Suggested adapter |
|---|---|
| `.git` | `git` |
| OpenCode config/dir | `opencode` (push; verified only after plugin connects) |
| task-like JSON/JSONL/MD | `file-task-tracker` (auto field detection) |
| custom pipe/task format | **generated** `task-lines` adapter |
| agent registry JSON | **generated** `agent-registry` adapter |
| Jenkinsfile / CI endpoint | `jenkins` (URL config required for verification) |
| `.github/workflows` | `github` (repo config required) |
| `.gitlab-ci.yml` | `gitlab` (project config required) |
| queue state file | `merge-queue-file` (field mapping configurable) |
| LikeC4 model export | `likec4` |
| event feed JSONL | `generic-events` |

## Output

`DiscoveryReport { evidences, detectedTools, suggestedAdapters (with config drafts),
capabilityDraft, agentsFound, workflowStagesFound, limitations }`.

The draft is **not** the manifest: capabilities become `supported` only after adapter probes
(see Capability Manifest Specification). Generated adapters are contract-tested in isolation
before activation.

## Economy & safety

- Bounded walk; no network during discovery; no script execution.
- Re-runs are cheap enough for periodic reconciliation; drift detection compares hashed
  evidence inventories instead of re-walking on every event.
- Credentials are never read into evidence; API adapters reference env var names only.

## Setup Agent responsibilities beyond mechanical discovery

The mechanical layer detects *what exists*; the Setup Agent (LLM) decides *semantics*:
status mappings for custom vocabularies, authoritative source selection, field mapping
refinements, and minimal integration proposals for unobservable processes. All such changes
are configuration or generated adapters inside `.dark-factory/`, versioned and reversible.
