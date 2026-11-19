# DFCP UX / UI Specification

## 1. Design principles

1. **Information density with hierarchy** — engineering tool, not a marketing page: compact
   tables, trees, graphs; progressive disclosure via task cards and drill-downs.
2. **Honesty everywhere** — every value is tagged by nature: `real` (observed), `computed`
   (derived), `estimated` (forecast), `missing`. Stale/degraded sources carry badges + last sync.
3. **Capability-driven navigation** — sections appear only when verified; unavailable ones are
   visible in Integrations with reasons, never as fake empty operational screens.
4. **Consistent cross-project UX** — one codebase, one design system; only configuration differs.
5. **Dark factory theme** — dark engineering theme, high-contrast status colors, monospace IDs.

## 2. Sitemap

```
/                     Overview
/tasks                Tasks (table + filters + saved views)
/tasks/tree           Task Tree (hierarchy; dependency edges shown separately)
/tasks/:id            Task Card (modal or page: fields, AC, history, links)
/agents               Agents (live status board)
/agents/:id           Agent detail (sessions, timeline, errors)
/workflow             Workflow (observed stages + transition map + WIP per stage)
/pipelines            CI/CD Pipelines (list) → /pipelines/:runId (stage/job visualization)
/merge-queue          Merge Queue (FIFO board)
/critical-path        Critical Path (dependency DAG + longest path)
/releases             Releases (list) → /releases/:id (scope + readiness)
/components           Components (tree + architecture map if available)
/metrics              Metrics (charts + coverage notes)
/activity             Activity / Events (filterable timeline)
/integrations         Integrations / Harness Health
/settings             Settings (project config, sources, permissions, views)
```

## 3. Key screens (wireframes)

### 3.1 Overview
```
┌────────────────────────────────────────────────────────────────────────────┐
│ DFCP · Project A            ● live  data: 12s ago   [Sync] [Doctor] [⚙]   │
├────────────────────────────────────────────────────────────────────────────┤
│ [Tasks 24: 6▶ 3⛔ 15✓] [Agents 3 working] [Pipeline #41 ✓] [Queue 2]      │
│ [Release v0.4: 62% ready] [Critical path: 3 tasks]                         │
├───────────────────────────────┬────────────────────────────────────────────┤
│ Now happening                 │ Blockers & alerts                          │
│ ▶ T-101 agent-2 (12m)         │ ⛔ T-104 blocked by T-101 (2d)             │
│ ▶ T-107 agent-1 (4m)          │ ⚠ jenkins adapter stale (last ok 14:02)    │
│ ⏳ queue: feature/T-99 (3m)    │ ⚠ drift detected: +1 agent → reconcile     │
├───────────────────────────────┴────────────────────────────────────────────┤
│ Release progress ████████░░░░ 62%   │ Recent activity (5) …                │
└────────────────────────────────────────────────────────────────────────────┘
```
Cards render only for verified capabilities; each card shows its source + freshness.

### 3.2 Tasks
Table: ID · Title · Kind · Status (normalized + original on hover) · Priority · Assignee ·
Component · Deps · Progress · Updated. Filter bar: status/kind/priority/assignee/component/
search; saved views dropdown; [+ New task]. Row click → Task Card:
fields, acceptance criteria checklist, dependency chips (blocker status colored), linked
branches/PRs/runs/release, mapping provenance (source, rule version, confidence), history
timeline. Actions: edit, claim, release, change status (permission-scoped).

### 3.3 Task Tree
Collapsible hierarchy Epic→Feature→Task→Subtask with rollup progress per node; search/filter
keeps ancestors of matches; dependency edges are NOT drawn here (separate Critical Path view)
— a "blocked by" chip links across the tree. Node click → Task Card.

### 3.4 Agents
Board/table: Name · Role · Status chip (working/waiting/blocked/reviewing/completed/failed/
stopped/unknown) · Current task · Session · Model · Started · Duration · Last event · Errors.
`unknown` renders gray with "no heartbeat — not proof of completion" tooltip. Evidence tag
(event/heartbeat/inferred) visible. Detail: session list + activity timeline.

### 3.5 Workflow
Horizontal stage strip built from **observed** stages (adapter mapping + real transitions):
`Planning → Ready → Development → Review → Verification → Integration → Merged → Done` is
only an example; Project B may show `queued → coding → verifying → integrating → shipped`.
WIP count per stage, transition arrows observed from events, tasks listed per stage.
If only partial stages observable → banner listing observable vs unobservable stages.

### 3.6 Pipelines (Jenkins-like)
Run list: # · Pipeline · Status · Branch · Task · Trigger · Duration · Started.
Run detail: stage strip (pending/running/success/failed/skipped) with durations, jobs table,
error excerpt, retries, artifacts links. Stage colors: blue=running, green=success,
red=failed, gray=not built. No CI capability → section hidden (reason in Integrations).

### 3.7 Merge Queue
FIFO board: position · branch · task · agent · state (waiting/checking/ready/merging/merged/
conflict/dead_letter/failed) · checks summary · wait time · reason. In-flight merge highlighted.
Task/Pipeline/Merge shown as three independent state chips. Dead-letter entries show reason +
retry action (if the source adapter exposes the operation). No queue integration → honest
unavailable state, not an empty fake queue.

### 3.8 Critical Path & Releases
DAG layout (layers by dependency depth), critical path highlighted; edge/task tooltips show
estimate + confidence. Missing estimates → structural longest path labeled "structural,
no duration estimates". Release page: scope table, readiness breakdown (tasks done/total,
open blockers, required checks, queue state), readiness verdict with evidence list, history.

### 3.9 Integrations / Harness Health
```
Discovered harness: OpenCode + custom file tracker + Jenkins + file merge queue + LikeC4
┌ Adapter ──────────── Version ─ Capabilities ──────── Status ─── Last sync ─┐
│ file-task-tracker    1.2.0     tasks, hierarchy      ● ok       12s ago    │
│ jenkins              1.0.1     ci_cd                 ⚠ stale    14:02      │
│ merge-queue-file     1.0.0     merge_queue           ● ok       30s ago    │
│ generated:harness-x  0.3.0     workflow, agents      ● ok       12s ago    │
└──────────────────────────────────────────────────────────────────────────┘
Capabilities matrix (status/source/limitations) · Drift log · Reconciliation result
[Discover] [Sync] [Reconcile] [Doctor] [Adapter updates: 1 available → review]
```

## 4. Design system

- Colors: bg `#0b1020`, panel `#141b2e`, line `#2a3554`, text `#e6ebf5`, muted `#93a0bd`,
  accent `#7dd3fc`. Status: ready `#06b6d4`, in_progress `#3b82f6`, review `#a855f7`,
  done/merged `#22c55e`, blocked `#ef4444`, waiting `#f59e0b`, unknown `#64748b`,
  stale `#f59e0b`, degraded `#ef4444`.
- Type: system-ui stack; IDs/SHA in ui-monospace; 12–14px body, 22px page titles.
- Components: status chip, freshness badge, capability banner, KPI card, data table,
  tree node, DAG node/edge (SVG), stage strip, timeline, modal, toast, empty/unavailable state.
- Data-nature tags: `real` (no tag), `computed` (∑), `estimated` (≈), `missing` (—).
- Interaction: hash routing; SSE live updates with visible connection state; manual refresh;
  keyboard: `/` focus search, `Esc` close modal.

## 5. Capability → UI mapping (computed server-side)

| Capability | Section(s) | supported | partial | unavailable/not_configured |
|---|---|---|---|---|
| task_management | Tasks, Task Tree, Overview cards | full | limited fields + banner | hidden; reason in Integrations |
| task_hierarchy | Task Tree | tree | flat list + note | tree hidden |
| agent_monitoring | Agents | full board | limited fields + note | hidden |
| workflow_stages | Workflow | observed stages | observable subset + banner | hidden |
| git_monitoring | Git panels, links | full | subset | hidden |
| ci_cd | Pipelines | full | runs without stages + note | hidden |
| merge_queue | Merge Queue | full | subset + note | hidden |
| critical_path | Critical Path | estimates path | structural path labeled | explanation + available part |
| release_planning | Releases | full | scope-only + note | hidden |
| architecture_map | Components map | map | tree only | tree only / honest empty |
| activity_events | Activity | full | subset | hidden |
| metrics | Metrics | computed set | available subset + coverage note | hidden |

`stale`/`degraded` keep the section visible but badge it and freeze trust (show last good data
with timestamp, never as current fact).
