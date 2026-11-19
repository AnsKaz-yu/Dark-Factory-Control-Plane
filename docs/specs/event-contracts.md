# Event Contract Specification (v1)

> Generated from `packages/core/src/schema.ts` — regenerate with `npm run docs:events`.

## Envelope

Every ingested event is wrapped in a typed envelope:

```ts
{
  eventId: string          // core-assigned ULID-like, unique per project
  idempotencyKey?: string  // source-provided dedup key (adapter + entity + revision)
  projectId: string
  type: string             // registered type, see table below
  schemaVersion: number    // per-type version; mismatch => rejected + diagnostic
  occurredAt: string       // source clock (ISO)
  ingestedAt: string       // core clock (ISO)
  seq: number              // per-project monotonic sequence, core-assigned
  source: SourceRef        // { adapterId, sourceId, entityKind, authoritative, fetchedAt }
  payload: object          // validated against the registered schema
}
```

## Processing guarantees

1. **Validation** — envelope + payload validated before anything is applied.
2. **Dedup** — by `eventId` and by `idempotencyKey`; duplicate delivery is a no-op.
3. **Ordering** — per-project `seq`; SSE clients resume with `lastSeq` (gap-free replay).
4. **Unknown types** — stored as `diagnostic.unknown_event` (raw preserved), never applied.
5. **Schema violations** — stored as `diagnostic.schema_violation` (raw + error), never applied.
6. **Replay** — projections rebuild deterministically from the log; snapshots are verified
   against a hash of the log prefix before use.
7. **Integrity** — corrupt log lines are quarantined to `diagnostics/corrupt-log-lines.jsonl`,
   never destroyed; valid events remain intact.

## Registered event types

| Type | Schema version | Description |
|---|---|---|
| `project.registered` | 1 | Project registration/update |
| `task.created` | 1 | Task created (full fields) |
| `task.updated` | 1 | Task field updates |
| `task.status_changed` | 1 | Explicit status transition |
| `task.claimed` | 1 | Atomic claim by agent |
| `task.released` | 1 | Claim released |
| `task.deleted` | 1 | Task removed (kept in history log) |
| `agent.registered` | 1 | Agent discovered/registered |
| `agent.status_changed` | 1 | Agent lifecycle status |
| `agent.heartbeat` | 1 | Activity heartbeat (never implies completion) |
| `agent.error` | 1 | Agent error observed |
| `session.started` | 1 | Agent session started |
| `session.ended` | 1 | Agent session ended |
| `component.updated` | 1 | Component upsert |
| `architecture.map` | 1 | Architecture map snapshot (e.g. LikeC4 export) |
| `git.branches` | 1 | Branch snapshot |
| `git.commits` | 1 | Commit batch |
| `git.pr_updated` | 1 | Pull request upsert |
| `pipeline.registered` | 1 | Pipeline definition |
| `pipeline.run_started` | 1 | Run started (full run object) |
| `pipeline.run_updated` | 1 | Run progress update |
| `pipeline.run_completed` | 1 | Run finished |
| `merge_queue.snapshot` | 1 | Full queue snapshot |
| `merge_queue.entry_updated` | 1 | Single entry update |
| `release.created` | 1 | Release created |
| `release.updated` | 1 | Release fields/scope update |
| `release.released` | 1 | Release published |
| `workflow.stages_observed` | 1 | Observed workflow stages from harness |
| `integration.drift_detected` | 1 | Drift report recorded |
| `integration.reconciled` | 1 | Reconciliation result recorded |
| `integration.adapter_updated` | 1 | Adapter version activated |
| `integration.sync` | 1 | Adapter sync outcome |
| `activity.note` | 1 | Free-form activity note |
| `diagnostic.unknown_event` | 1 | Unregistered event type received |
| `diagnostic.schema_violation` | 1 | Event failed schema validation |

## Source attribution

`source.authoritative` marks the declared source of truth for the entity. When several
adapters observe one capability, the project config declares the authoritative adapter
(`sources.<capability>.authoritative`, conflict strategy `authoritative-wins`): auxiliary
adapters may introduce new entities but cannot overwrite authoritative ones.

## Normalization rule

Adapters emit normalized values **and** preserve originals:
`payload.sourceStatus` + `payload.mapping { ruleSetId, ruleSetVersion, confidence, original }`.
Unmapped source statuses normalize to `unknown` with confidence `unmapped` — never invented.
