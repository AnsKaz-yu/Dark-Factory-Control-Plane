// EventStore — append-only per-project event log with dedup, replay and snapshots.
// Single writer: the core process. Crash safety: append-only writes + atomic snapshot rename.
// Integrity: corrupt log lines are quarantined (never destroyed) and reported as diagnostics.
import { appendFileSync, existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { EventEnvelope } from "./types.ts"
import { newId, nowISO, sha256 } from "./ids.ts"

export interface StoreSnapshot {
  lastSeq: number
  logPrefixHash: string
  state: unknown
  takenAt: string
}

export class EventStore {
  readonly dir: string
  readonly logPath: string
  readonly snapshotPath: string
  private events: EventEnvelope[] = []
  private bySeq = new Map<number, EventEnvelope>()
  private eventIds = new Set<string>()
  private idempotencyKeys = new Map<string, string>() // key -> eventId
  private nextSeq = 1
  private corruptLines: { line: number; raw: string; error: string }[] = []
  private listeners: ((e: EventEnvelope) => void)[] = []

  constructor(dir: string) {
    this.dir = dir
    this.logPath = join(dir, "events.jsonl")
    this.snapshotPath = join(dir, "snapshot.json")
    mkdirSync(dir, { recursive: true })
    this.load()
  }

  private load(): void {
    if (!existsSync(this.logPath)) return
    const raw = readFileSync(this.logPath, "utf8")
    const lines = raw.split("\n")
    let prefixParts: string[] = []
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line) as EventEnvelope
        if (typeof e.seq !== "number" || typeof e.eventId !== "string") throw new Error("missing seq/eventId")
        this.events.push(e)
        this.bySeq.set(e.seq, e)
        this.eventIds.add(e.eventId)
        if (e.idempotencyKey) this.idempotencyKeys.set(e.idempotencyKey, e.eventId)
        if (e.seq >= this.nextSeq) this.nextSeq = e.seq + 1
        prefixParts.push(line)
      } catch (err) {
        // Quarantine corrupt line: keep raw bytes, record diagnostic, continue.
        this.corruptLines.push({ line: i + 1, raw: line, error: String((err as Error).message) })
        try {
          mkdirSync(join(this.dir, "diagnostics"), { recursive: true })
          appendFileSync(join(this.dir, "diagnostics", "corrupt-log-lines.jsonl"),
            JSON.stringify({ at: nowISO(), line: i + 1, raw: line, error: String((err as Error).message) }) + "\n")
        } catch { /* best effort */ }
      }
    }
  }

  /** Snapshot is usable only if it covers a verified prefix of the log. */
  loadSnapshot(): StoreSnapshot | null {
    if (!existsSync(this.snapshotPath)) return null
    try {
      const snap = JSON.parse(readFileSync(this.snapshotPath, "utf8")) as StoreSnapshot
      if (typeof snap.lastSeq !== "number" || snap.lastSeq > this.events.length) return null
      const prefix = this.events.slice(0, snap.lastSeq)
      const hash = sha256(prefix.map(e => JSON.stringify(e)).join("\n"))
      if (hash !== snap.logPrefixHash) return null
      return snap
    } catch { return null }
  }

  saveSnapshot(state: unknown): void {
    const lastSeq = this.events.length ? this.events[this.events.length - 1].seq : 0
    const prefixHash = sha256(this.events.map(e => JSON.stringify(e)).join("\n"))
    const snap: StoreSnapshot = { lastSeq, logPrefixHash: prefixHash, state, takenAt: nowISO() }
    const tmp = this.snapshotPath + ".tmp-" + process.pid
    writeFileSync(tmp, JSON.stringify(snap))
    renameSync(tmp, this.snapshotPath)
  }

  hasEventId(id: string): boolean { return this.eventIds.has(id) }
  hasIdempotencyKey(key: string): boolean { return this.idempotencyKeys.has(key) }

  /** Append a fully-formed envelope. Returns false on duplicate. */
  append(e: EventEnvelope): boolean {
    if (this.eventIds.has(e.eventId)) return false
    if (e.idempotencyKey && this.idempotencyKeys.has(e.idempotencyKey)) return false
    appendFileSync(this.logPath, JSON.stringify(e) + "\n")
    this.events.push(e)
    this.bySeq.set(e.seq, e)
    this.eventIds.add(e.eventId)
    if (e.idempotencyKey) this.idempotencyKeys.set(e.idempotencyKey, e.eventId)
    if (e.seq >= this.nextSeq) this.nextSeq = e.seq + 1
    for (const l of this.listeners) { try { l(e) } catch { /* listener isolation */ } }
    return true
  }

  allocSeq(): number { return this.nextSeq++ }

  all(): readonly EventEnvelope[] { return this.events }
  after(seq: number): EventEnvelope[] { return this.events.filter(e => e.seq > seq) }
  get(seq: number): EventEnvelope | undefined { return this.bySeq.get(seq) }
  lastSeq(): number { return this.events.length ? this.events[this.events.length - 1].seq : 0 }
  count(): number { return this.events.length }
  corrupt(): readonly { line: number; raw: string; error: string }[] { return this.corruptLines }

  onAppend(l: (e: EventEnvelope) => void): () => void {
    this.listeners.push(l)
    return () => { this.listeners = this.listeners.filter(x => x !== l) }
  }

  /** Compact old diagnostics listing (never touches the log itself). */
  listDiagnostics(): string[] {
    const d = join(this.dir, "diagnostics")
    try { return readdirSync(d) } catch { return [] }
  }
}

export function makeEnvelope(input: {
  projectId: string
  type: string
  schemaVersion: number
  payload: Record<string, unknown>
  source: EventEnvelope["source"]
  occurredAt?: string
  idempotencyKey?: string
  eventId?: string
  seq?: number
}): EventEnvelope {
  return {
    eventId: input.eventId ?? newId("ev"),
    idempotencyKey: input.idempotencyKey,
    projectId: input.projectId,
    type: input.type,
    schemaVersion: input.schemaVersion,
    occurredAt: input.occurredAt ?? nowISO(),
    ingestedAt: nowISO(),
    seq: input.seq ?? 0,
    source: input.source,
    payload: input.payload,
  }
}
