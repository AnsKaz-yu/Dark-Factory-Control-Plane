// Generates docs/specs/event-contracts.md from the live schema registry (single source of truth).
import { writeFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { EVENT_REGISTRY } from "../packages/core/src/schema.ts"
import { EVENT_CONTRACT_VERSION } from "../packages/core/src/types.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
const rows = [...EVENT_REGISTRY.values()].map(d => `| \`${d.type}\` | ${d.schemaVersion} | ${d.description} |`)
const md = `# Event Contract Specification (v${EVENT_CONTRACT_VERSION})

> Generated from \`packages/core/src/schema.ts\` — regenerate with \`npm run docs:events\`.

## Envelope

Every ingested event is wrapped in a typed envelope:

\`\`\`ts
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
\`\`\`

## Processing guarantees

1. **Validation** — envelope + payload validated before anything is applied.
2. **Dedup** — by \`eventId\` and by \`idempotencyKey\`; duplicate delivery is a no-op.
3. **Ordering** — per-project \`seq\`; SSE clients resume with \`lastSeq\` (gap-free replay).
4. **Unknown types** — stored as \`diagnostic.unknown_event\` (raw preserved), never applied.
5. **Schema violations** — stored as \`diagnostic.schema_violation\` (raw + error), never applied.
6. **Replay** — projections rebuild deterministically from the log; snapshots are verified
   against a hash of the log prefix before use.
7. **Integrity** — corrupt log lines are quarantined to \`diagnostics/corrupt-log-lines.jsonl\`,
   never destroyed; valid events remain intact.

## Registered event types

| Type | Schema version | Description |
|---|---|---|
${rows.join("\n")}

## Source attribution

\`source.authoritative\` marks the declared source of truth for the entity. When several
adapters observe one capability, the project config declares the authoritative adapter
(\`sources.<capability>.authoritative\`, conflict strategy \`authoritative-wins\`): auxiliary
adapters may introduce new entities but cannot overwrite authoritative ones.

## Normalization rule

Adapters emit normalized values **and** preserve originals:
\`payload.sourceStatus\` + \`payload.mapping { ruleSetId, ruleSetVersion, confidence, original }\`.
Unmapped source statuses normalize to \`unknown\` with confidence \`unmapped\` — never invented.
`
mkdirSync(join(HERE, "..", "docs", "specs"), { recursive: true })
writeFileSync(join(HERE, "..", "docs", "specs", "event-contracts.md"), md)
console.log(`[docs] event-contracts.md generated (${EVENT_REGISTRY.size} types)`)
