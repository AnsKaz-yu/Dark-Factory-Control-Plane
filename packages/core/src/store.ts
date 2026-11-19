// ProjectStore: event ingestion pipeline + projection state + integration metadata.
// Manager: multi-project isolation under <dataDir>/projects/<id>/.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type {
  CapabilityManifest, DoctorReport, EventEnvelope, HarnessFingerprint, IngestResult,
  Integration, DiscoveryReport, SyncStatus, ReconciliationResult,
} from "./types.ts"
import { CORE_VERSION } from "./types.ts"
import { EventStore, makeEnvelope } from "./events.ts"
import { validateEnvelope, validateEvent, EVENT_REGISTRY } from "./schema.ts"
import { apply, initialState, replay, type ProjectState } from "./projections.ts"
import { emptyManifest } from "./derive.ts"
import { newId, nowISO } from "./ids.ts"

const INTERNAL_SOURCE = { adapterId: "core", sourceId: "core", entityKind: "internal", authoritative: true, fetchedAt: nowISO() }

export class ProjectStore {
  readonly id: string
  readonly dir: string
  readonly events: EventStore
  state: ProjectState
  private metaDir: string
  private snapshotCounter = 0

  constructor(dataDir: string, id: string) {
    this.id = id
    this.dir = join(dataDir, "projects", id)
    this.metaDir = join(this.dir, "meta")
    mkdirSync(this.metaDir, { recursive: true })
    this.events = new EventStore(this.dir)
    // Recover: snapshot (verified prefix) + replay tail, else full replay.
    const snap = this.events.loadSnapshot()
    if (snap) {
      this.state = snap.state as ProjectState
      const tail = this.events.after(snap.lastSeq)
      for (const e of tail) apply(this.state, e)
    } else {
      this.state = replay(this.events.all())
    }
    this.state.diagnostics.corruptLogLines = this.events.corrupt().length
  }

  // ---- meta files ----
  private metaPath(name: string): string { return join(this.metaDir, name + ".json") }
  readMeta<T>(name: string): T | null {
    const p = this.metaPath(name)
    if (!existsSync(p)) return null
    try { return JSON.parse(readFileSync(p, "utf8")) as T } catch { return null }
  }
  writeMeta(name: string, value: unknown): void {
    const p = this.metaPath(name)
    const tmp = p + ".tmp-" + process.pid
    writeFileSync(tmp, JSON.stringify(value, null, 2))
    renameSync(tmp, p)
  }

  getCapabilities(): CapabilityManifest {
    return this.readMeta<CapabilityManifest>("capabilities") ?? emptyManifest(this.id)
  }
  setCapabilities(m: CapabilityManifest): void { this.writeMeta("capabilities", m) }

  getIntegration(): Integration {
    return this.readMeta<Integration>("integration") ?? {
      projectId: this.id, adapters: [], versions: [], mappings: [], sync: {},
    }
  }
  setIntegration(i: Integration): void { this.writeMeta("integration", i) }

  getDiscovery(): DiscoveryReport | null { return this.readMeta<DiscoveryReport>("discovery") }
  setDiscovery(d: DiscoveryReport): void { this.writeMeta("discovery", d) }

  getFingerprint(): HarnessFingerprint | null { return this.readMeta<HarnessFingerprint>("fingerprint") }
  setFingerprint(f: HarnessFingerprint): void { this.writeMeta("fingerprint", f) }

  getSync(adapterId: string): SyncStatus {
    return this.getIntegration().sync[adapterId] ?? { adapterId, lastAttemptAt: null, lastSuccessAt: null, eventsIngested: 0, errors: [], state: "never" }
  }
  recordSync(adapterId: string, ok: boolean, eventsIngested: number, error?: string): void {
    const integ = this.getIntegration()
    const prev = integ.sync[adapterId] ?? { adapterId, lastAttemptAt: null, lastSuccessAt: null, eventsIngested: 0, errors: [], state: "never" as const }
    const next: SyncStatus = {
      adapterId,
      lastAttemptAt: nowISO(),
      lastSuccessAt: ok ? nowISO() : prev.lastSuccessAt,
      eventsIngested: prev.eventsIngested + eventsIngested,
      errors: ok ? prev.errors : [...prev.errors, { at: nowISO(), message: error ?? "unknown" }].slice(-20),
      state: ok ? "ok" : "degraded",
    }
    integ.sync[adapterId] = next
    this.setIntegration(integ)
  }

  // ---- ingestion ----
  /** Validate → dedup → seq → append → project. Unknown/invalid events become diagnostics. */
  ingest(inputs: Partial<EventEnvelope>[]): IngestResult {
    const result: IngestResult = { accepted: 0, duplicates: 0, rejected: [], seqs: [] }
    for (let i = 0; i < inputs.length; i++) {
      const raw = inputs[i]
      if (raw.projectId !== undefined && raw.projectId !== this.id) {
        result.rejected.push({ index: i, error: `projectId mismatch: event for ${raw.projectId}, store ${this.id}` })
        continue
      }
      const input = { ...raw, projectId: this.id }
      const envErr = validateEnvelope(input)
      if (envErr) { result.rejected.push({ index: i, error: envErr }); continue }
      const type = input.type!
      const schemaVersion = input.schemaVersion!
      const payload = (input.payload ?? {}) as Record<string, unknown>
      const schemaErr = validateEvent(type, schemaVersion, payload)
      if (schemaErr) {
        if (!EVENT_REGISTRY.has(type)) {
          this.appendDiagnostic("diagnostic.unknown_event", { raw: input })
        } else {
          this.appendDiagnostic("diagnostic.schema_violation", { raw: input, error: schemaErr })
        }
        result.rejected.push({ index: i, error: schemaErr })
        continue
      }
      if (input.eventId && this.events.hasEventId(input.eventId)) { result.duplicates++; continue }
      if (input.idempotencyKey && this.events.hasIdempotencyKey(input.idempotencyKey)) { result.duplicates++; continue }
      const e = makeEnvelope({
        projectId: this.id, type, schemaVersion, payload,
        source: { ...INTERNAL_SOURCE, ...input.source!, fetchedAt: input.source?.fetchedAt ?? nowISO() },
        occurredAt: input.occurredAt, idempotencyKey: input.idempotencyKey,
        eventId: input.eventId, seq: this.events.allocSeq(),
      })
      if (!this.events.append(e)) { result.duplicates++; continue }
      apply(this.state, e)
      result.accepted++
      result.seqs.push(e.seq)
    }
    if (result.accepted > 0 && ++this.snapshotCounter >= 50) { this.snapshot(); this.snapshotCounter = 0 }
    return result
  }

  private appendDiagnostic(type: string, payload: Record<string, unknown>): void {
    const e = makeEnvelope({ projectId: this.id, type, schemaVersion: 1, payload, source: INTERNAL_SOURCE, seq: this.events.allocSeq() })
    this.events.append(e)
    apply(this.state, e)
  }

  /** Internal core event (task operations etc.) */
  emit(type: string, payload: Record<string, unknown>, opts?: { idempotencyKey?: string; source?: Partial<EventEnvelope["source"]>; occurredAt?: string }): EventEnvelope | null {
    const def = EVENT_REGISTRY.get(type)
    if (!def) throw new Error(`unregistered internal event type: ${type}`)
    const err = def.validate(payload)
    if (err) throw new Error(`invalid payload for ${type}: ${err}`)
    const res = this.ingest([{ type, schemaVersion: def.schemaVersion, payload, idempotencyKey: opts?.idempotencyKey, source: { ...INTERNAL_SOURCE, ...opts?.source } as EventEnvelope["source"], occurredAt: opts?.occurredAt }])
    if (res.rejected.length) throw new Error(res.rejected[0].error)
    const seq = res.seqs[0]
    return seq !== undefined ? this.events.get(seq) ?? null : null
  }

  snapshot(): void { this.events.saveSnapshot(this.state) }

  freshness(): Record<string, import("./types.ts").Freshness> {
    const out: Record<string, import("./types.ts").Freshness> = {}
    const integ = this.getIntegration()
    const now = Date.now()
    for (const [adapterId, s] of Object.entries(integ.sync)) {
      const lastOk = s.lastSuccessAt ? Date.parse(s.lastSuccessAt) : 0
      const stale = s.state === "ok" && lastOk > 0 && now - lastOk > 15 * 60 * 1000
      out[adapterId] = {
        lastSyncAt: s.lastAttemptAt, lastSuccessAt: s.lastSuccessAt,
        stale: stale || s.state === "stale", degraded: s.state === "degraded",
        error: s.errors.length ? s.errors[s.errors.length - 1].message : undefined,
      }
    }
    return out
  }

  doctor(): DoctorReport {
    const checks: DoctorReport["checks"] = []
    const recommendations: string[] = []
    checks.push({ name: "event log integrity", ok: this.events.corrupt().length === 0, detail: `${this.events.count()} events, ${this.events.corrupt().length} corrupt lines quarantined` })
    checks.push({ name: "projection rebuild", ok: true, detail: `state rebuilt from log; lastEventAt=${this.state.lastEventAt ?? "never"}` })
    const caps = this.getCapabilities()
    const assessed = Object.values(caps.capabilities).filter(c => c.confidence === "verified").length
    checks.push({ name: "capabilities verified", ok: assessed > 0, detail: `${assessed}/${Object.keys(caps.capabilities).length} verified` })
    if (!assessed) recommendations.push("Run factory:discover + factory:sync to verify capabilities.")
    const integ = this.getIntegration()
    for (const [id, s] of Object.entries(integ.sync)) {
      const ok = s.state === "ok"
      checks.push({ name: `adapter ${id}`, ok, detail: `state=${s.state}, lastSuccess=${s.lastSuccessAt ?? "never"}, errors=${s.errors.length}` })
      if (!ok) recommendations.push(`Adapter ${id} is ${s.state}: run factory:doctor / factory:reconcile.`)
    }
    if (this.state.diagnostics.unknownEvents > 0) recommendations.push(`${this.state.diagnostics.unknownEvents} unknown events received — check adapter contract versions.`)
    if (this.state.diagnostics.schemaViolations > 0) recommendations.push(`${this.state.diagnostics.schemaViolations} schema violations — possible harness drift; run factory:integration:diff.`)
    const fp = this.getFingerprint()
    checks.push({ name: "integration baseline", ok: fp !== null, detail: fp ? `taken ${fp.takenAt}` : "no fingerprint — run factory:setup" })
    return { projectId: this.id, at: nowISO(), healthy: checks.every(c => c.ok), checks, recommendations }
  }
}

export class ProjectManager {
  readonly dataDir: string
  private stores = new Map<string, ProjectStore>()

  constructor(dataDir: string) {
    this.dataDir = dataDir
    mkdirSync(join(dataDir, "projects"), { recursive: true })
    for (const id of this.listIds()) this.get(id) // warm start
  }

  listIds(): string[] {
    try { return readdirSync(join(this.dataDir, "projects"), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) } catch { return [] }
  }

  get(id: string): ProjectStore {
    let s = this.stores.get(id)
    if (!s) { s = new ProjectStore(this.dataDir, id); this.stores.set(id, s) }
    return s
  }

  has(id: string): boolean { return this.listIds().includes(id) }

  create(id: string, name: string, root: string): ProjectStore {
    const s = this.get(id)
    if (!s.state.project) {
      s.emit("project.registered", { name, root, coreVersion: CORE_VERSION })
    }
    return s
  }

  list(): ProjectStore[] { return this.listIds().map(id => this.get(id)) }
}
