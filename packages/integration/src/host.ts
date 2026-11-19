// Integration Host — wires discovery, adapters, capabilities, fingerprint, drift,
// reconciliation and updates into the Core API (IntegrationHost implementation).
import { join } from "node:path"
import type { IntegrationHost } from "../../core/src/api.ts"
import type { ProjectStore } from "../../core/src/store.ts"
import type { Adapter, AdapterContext, ProbeResult } from "../../adapters/src/contract.ts"
import { BUILTIN_ADAPTERS, makeContext } from "../../adapters/src/index.ts"
import type { CapabilityManifest, ReconciliationResult } from "../../core/src/types.ts"
import { CORE_VERSION } from "../../core/src/types.ts"
import { nowISO, sha256 } from "../../core/src/ids.ts"
import { discover } from "./discover.ts"
import { buildManifest, type AdapterBinding } from "./capabilities.ts"
import { takeBaseline, detectDrift } from "./fingerprint.ts"
import { planReconciliation } from "./reconcile.ts"
import { adapterStatus, updateGeneratedAdapter, updateBuiltinAdapter, rollbackAdapter } from "./updates.ts"
import { loadGeneratedAdapter, contractTestAdapter, listGeneratedAdapterFiles } from "./generator.ts"
import { ensureLayout, integrationDir, readProjectConfig, writeProjectConfig, type ProjectConfig } from "./install.ts"
import { basename } from "node:path"

export class DfcpIntegrationHost implements IntegrationHost {
  private log: string[] = []
  private logger = (msg: string) => { this.log.push(`[${nowISO()}] ${msg}`); if (this.log.length > 500) this.log.splice(0, this.log.length - 500) }

  private root(store: ProjectStore): string { return store.state.project?.root ?? "" }

  private ctxFor(store: ProjectStore, adapterId: string, config: Record<string, unknown>): AdapterContext {
    const root = this.root(store)
    return makeContext({ projectId: store.id, projectRoot: root, integrationDir: integrationDir(root), config, logger: this.logger })
  }

  /** Resolve configured adapters (builtin + generated) and probe them. */
  async resolveBindings(store: ProjectStore, probe = true): Promise<AdapterBinding[]> {
    const root = this.root(store)
    const cfg = readProjectConfig(root)
    const bindings: AdapterBinding[] = []
    for (const entry of cfg?.adapters ?? []) {
      if (entry.enabled === false) continue
      let adapter: Adapter | undefined
      try {
        if (entry.generated || entry.id.startsWith("generated:")) {
          const name = entry.id.replace(/^generated:/, "")
          const file = join(integrationDir(root), "adapters", `${name}.adapter.ts`)
          adapter = await loadGeneratedAdapter(file, sha256(JSON.stringify(entry.config)))
        } else {
          adapter = BUILTIN_ADAPTERS[entry.id]
        }
      } catch (e) {
        this.logger(`adapter ${entry.id} load failed: ${(e as Error).message}`)
        store.recordSync(entry.id, false, 0, `load failed: ${(e as Error).message}`)
        continue
      }
      if (!adapter) { this.logger(`unknown adapter id: ${entry.id}`); continue }
      const binding: AdapterBinding = { adapter, config: entry.config }
      if (probe) {
        try {
          binding.probe = await adapter.probe(this.ctxFor(store, entry.id, entry.config))
        } catch (e) {
          binding.probe = { ok: false, confidence: "inferred", detail: `probe threw: ${(e as Error).message}`, capabilities: {} }
        }
      }
      bindings.push(binding)
    }
    return bindings
  }

  private registerAdapterManifests(store: ProjectStore, bindings: AdapterBinding[]): void {
    const integ = store.getIntegration()
    for (const b of bindings) {
      const idx = integ.adapters.findIndex(a => a.id === b.adapter.manifest.id)
      if (idx >= 0) integ.adapters[idx] = b.adapter.manifest
      else integ.adapters.push(b.adapter.manifest)
    }
    store.setIntegration(integ)
  }

  // ---- IntegrationHost: discover (full setup flow) ----
  async discover(store: ProjectStore): Promise<unknown> {
    const root = this.root(store)
    if (!root) throw new Error("project root not registered")
    ensureLayout(root)
    const report = discover(store.id, root)
    store.setDiscovery(report)

    let cfg = readProjectConfig(root)
    const generatedSpecs: import("./generator.ts").GeneratedAdapterSpec[] = []
    if (!cfg) {
      // select adapters from evidence-based suggestions (dedupe by id)
      const adapters: ProjectConfig["adapters"] = []
      const seen = new Set<string>()
      for (const s of report.suggestedAdapters) {
        if (seen.has(s.adapterId)) continue
        seen.add(s.adapterId)
        if (s.adapterId.startsWith("generated:")) {
          const c = s.config as Record<string, unknown>
          generatedSpecs.push({ name: s.adapterId.replace(/^generated:/, ""), kind: (c.kind as "agent-registry" | "task-lines") ?? "agent-registry", path: c.path as string, fields: c.fields as Record<string, string> | undefined, statusMap: c.statusMap as Record<string, string> | undefined, description: s.reason })
          continue
        }
        adapters.push({ id: s.adapterId, config: s.config ?? {} })
      }
      if (!seen.has("git") && report.detectedTools.includes("git")) adapters.unshift({ id: "git", config: {} })
      cfg = {
        projectId: store.id, name: store.state.project?.name ?? store.id, root,
        createdAt: nowISO(), productVersion: CORE_VERSION, adapters,
        permissions: { allowStructural: true, allowWrite: false, allowMaintenance: true },
        sources: {},
      }
      writeProjectConfig(root, cfg)
    }

    // materialize generated adapters for custom harness sources (contract-tested)
    const generationResults: unknown[] = []
    for (const spec of generatedSpecs) {
      generationResults.push(await this.materializeGenerated(store, spec))
    }

    const bindings = await this.resolveBindings(store, true)
    this.registerAdapterManifests(store, bindings)
    const manifest = buildManifest(store.id, bindings, report.capabilityDraft)
    store.setCapabilities(manifest)
    // declare authoritative sources
    const cfg2 = readProjectConfig(root)!
    for (const s of manifest.sources) {
      for (const cap of s.authoritativeFor) {
        if (!cfg2.sources[cap]) cfg2.sources[cap] = { authoritative: s.id, conflict: "authoritative-wins" }
      }
    }
    writeProjectConfig(root, cfg2)
    const fp = takeBaseline(store, report)
    fp.diagnosticsBaseline = store.state.diagnostics.schemaViolations + store.state.diagnostics.unknownEvents
    store.setFingerprint(fp)
    // register discovered agents (harness kind) — observation only
    for (const a of report.agentsFound) {
      if (!store.state.agents[a.name]) {
        store.emit("agent.registered", { id: a.name, name: a.name, role: a.role, kind: "harness" }, { idempotencyKey: `discover:agent:${a.name}` })
      }
    }
    return { report, manifest, adapters: bindings.map(b => ({ id: b.adapter.manifest.id, probe: b.probe })), generated: generationResults, fingerprint: fp }
  }

  /** Write + contract-test + register a generated adapter (no sync). */
  private async materializeGenerated(store: ProjectStore, spec: import("./generator.ts").GeneratedAdapterSpec): Promise<unknown> {
    const root = this.root(store)
    const { generateAdapterSource, writeGeneratedAdapter } = await import("./generator.ts")
    const source = generateAdapterSource(spec)
    const { file, checksum } = writeGeneratedAdapter(root, spec, source)
    const adapter = await loadGeneratedAdapter(file, checksum)
    const ctx = this.ctxFor(store, `generated:${spec.name}`, { path: spec.path })
    const test = await contractTestAdapter(adapter, ctx)
    if (!test.ok) return { ok: false, name: spec.name, file, errors: test.errors, activated: false }
    const cfg = readProjectConfig(root)!
    const id = `generated:${spec.name}`
    if (!cfg.adapters.some(a => a.id === id)) cfg.adapters.push({ id, config: { path: spec.path }, generated: true })
    writeProjectConfig(root, cfg)
    const integ = store.getIntegration()
    if (!integ.adapters.some(a => a.id === id)) integ.adapters.push(adapter.manifest)
    if (!integ.versions.some(v => v.adapterId === id && v.checksum === checksum)) {
      integ.versions.push({ adapterId: id, version: "1.0.0", activatedAt: nowISO(), file, checksum, status: "active" })
    }
    store.setIntegration(integ)
    return { ok: true, name: spec.name, file, activated: true, eventsValidated: test.eventCount }
  }

  // ---- sync: collect from all adapters, isolated failures ----
  async sync(store: ProjectStore): Promise<unknown> {
    const root = this.root(store)
    const cfg = readProjectConfig(root)
    const bindings = await this.resolveBindings(store, false)
    const results: Record<string, { ok: boolean; accepted: number; duplicates: number; rejected: number; notes?: string[] }> = {}
    for (const b of bindings) {
      const adapterId = b.adapter.manifest.id
      const ctx = this.ctxFor(store, adapterId, b.config)
      try {
        const { events, notes } = await b.adapter.collect(ctx)
        // authoritative-source strategy: auxiliary adapters must not overwrite the
        // authoritative source's entities (no competing sources of truth).
        const filtered = events.filter(e => {
          if (!e.type.startsWith("task.")) return true
          const auth = cfg?.sources.task_management?.authoritative
          if (!auth || auth === adapterId) return true
          const taskId = (e.payload as Record<string, unknown>).id as string
          const existing = store.state.tasks[taskId]
          if (existing && existing.source.adapterId === auth) return false
          return true
        })
        const res = store.ingest(filtered.map(e => ({
          type: e.type, schemaVersion: e.schemaVersion, payload: e.payload,
          idempotencyKey: e.idempotencyKey, occurredAt: e.occurredAt,
          source: { adapterId, sourceId: e.source?.sourceId ?? adapterId, entityKind: e.source?.entityKind ?? "mixed", authoritative: cfg?.sources.task_management?.authoritative === adapterId || !e.type.startsWith("task."), fetchedAt: nowISO() },
        })))
        store.recordSync(adapterId, true, res.accepted)
        results[adapterId] = { ok: true, accepted: res.accepted, duplicates: res.duplicates, rejected: res.rejected.length, notes }
        // update capability freshness
        const caps = store.getCapabilities()
        let touched = false
        for (const c of Object.values(caps.capabilities)) {
          if (c.adapterId === adapterId && (c.status === "supported" || c.status === "partial" || c.status === "stale")) {
            c.lastSyncAt = nowISO()
            if (c.status === "stale") c.status = "supported"
            touched = true
          }
        }
        if (touched) store.setCapabilities(caps)
      } catch (e) {
        // failure isolation: one broken adapter never disables the rest
        store.recordSync(adapterId, false, 0, String((e as Error).message))
        results[adapterId] = { ok: false, accepted: 0, duplicates: 0, rejected: 0, notes: [String((e as Error).message)] }
        const caps = store.getCapabilities()
        for (const c of Object.values(caps.capabilities)) {
          if (c.adapterId === adapterId && c.status === "supported") { c.status = "degraded"; c.limitations = [...c.limitations, `sync error: ${(e as Error).message}`] }
        }
        store.setCapabilities(caps)
      }
    }
    store.snapshot()
    return { at: nowISO(), adapters: results }
  }

  // ---- reconcile ----
  async reconcile(store: ProjectStore, opts?: { approve?: string[] }): Promise<unknown> {
    const root = this.root(store)
    const cfg = readProjectConfig(root)
    const drift = detectDrift(store)
    store.emit("integration.drift_detected", { report: drift }, { idempotencyKey: `drift:${drift.at}:${sha256(JSON.stringify(drift.changes))}` })
    const actions = planReconciliation(drift, cfg)
    const result: ReconciliationResult = { at: nowISO(), drift, actions, manifestUpdated: false, adaptersUpdated: [], verified: false, errors: [] }
    const approved = new Set(opts?.approve ?? [])
    let needRediscover = false

    for (const action of actions) {
      if (action.requiresApproval && !approved.has(action.target)) continue
      try {
        const kind = action.target.split(":")[0]
        if (kind === "agent_added") {
          const name = action.target.split(":").slice(1).join(":").replace(/^agent definition /, "")
          store.emit("agent.registered", { id: name, name, kind: "harness" }, { idempotencyKey: `reconcile:agent:${name}:${result.at}` })
          action.applied = true
          needRediscover = true
        } else if (kind === "agent_removed") {
          const name = action.target.split(":").slice(1).join(":").replace(/^agent definition /, "").replace(/ gone$/, "")
          if (store.state.agents[name]) store.emit("agent.status_changed", { id: name, status: "stopped", evidence: "event" })
          action.applied = true
          needRediscover = true
        } else if (kind === "tracker_data_changed" || kind === "integration") {
          await this.sync(store)
          action.applied = true
        } else if (kind === "no_baseline") {
          await this.discover(store)
          action.applied = true
        } else {
          needRediscover = true
          action.applied = true
        }
      } catch (e) {
        result.errors.push(`${action.target}: ${(e as Error).message}`)
      }
    }

    if (needRediscover || actions.some(a => a.applied && a.category !== "A")) {
      // structural refresh: re-discover, re-probe, rebuild manifest, bump mapping versions
      const report = discover(store.id, root)
      store.setDiscovery(report)
      const bindings = await this.resolveBindings(store, true)
      this.registerAdapterManifests(store, bindings)
      const manifest = buildManifest(store.id, bindings, report.capabilityDraft)
      store.setCapabilities(manifest)
      result.manifestUpdated = true
      const integ = store.getIntegration()
      for (const m of integ.mappings) m.version++
      if (drift.changes.some(c => c.kind.startsWith("workflow_stage"))) {
        integ.mappings.push({ id: `status-map:${nowISO()}`, version: 1, domain: "task_status", rules: {}, preserveOriginal: true })
      }
      store.setIntegration(integ)
      await this.sync(store)
      const fp = takeBaseline(store, report)
      fp.diagnosticsBaseline = store.state.diagnostics.schemaViolations + store.state.diagnostics.unknownEvents
      store.setFingerprint(fp)
      result.verified = true
    } else if (actions.some(a => a.applied)) {
      const report = store.getDiscovery()
      if (report) {
        const fp = takeBaseline(store, report)
        fp.diagnosticsBaseline = store.state.diagnostics.schemaViolations + store.state.diagnostics.unknownEvents
        store.setFingerprint(fp)
      }
      result.verified = true
    }

    const integ = store.getIntegration()
    integ.lastReconciliation = result
    store.setIntegration(integ)
    store.emit("integration.reconciled", { result }, { idempotencyKey: `reconciled:${result.at}` })
    return result
  }

  // ---- adapter maintenance ----
  async adapterUpdate(store: ProjectStore, adapterId: string): Promise<unknown> {
    let res
    if (adapterId.startsWith("generated:")) {
      res = await updateGeneratedAdapter(store, adapterId)
    } else {
      res = await updateBuiltinAdapter(store, adapterId, async (adapter, ctx) => {
        const probe = await adapter.probe(ctx)
        if (!probe.ok) throw new Error(`probe failed: ${probe.detail}`)
        return probe
      })
    }
    if (res.ok) {
      await this.sync(store)
      // refresh manifest after update
      const bindings = await this.resolveBindings(store, true)
      const report = store.getDiscovery()
      store.setCapabilities(buildManifest(store.id, bindings, report?.capabilityDraft ?? null))
    }
    return res
  }

  adapterStatus(store: ProjectStore): unknown { return adapterStatus(store) }

  async integrationDiff(store: ProjectStore): Promise<unknown> {
    const drift = detectDrift(store)
    const cfg = readProjectConfig(this.root(store))
    return { drift, plan: planReconciliation(drift, cfg) }
  }

  async rollback(store: ProjectStore, adapterId: string): Promise<unknown> {
    const res = await rollbackAdapter(store, adapterId)
    if (res.ok) await this.sync(store)
    return res
  }

  /** Called by the plugin (via API) when it registers/pushes events. */
  async notePluginConnection(store: ProjectStore, info: { pluginVersion?: string; lastEventAt?: string }): Promise<unknown> {
    const root = this.root(store)
    const cfg = readProjectConfig(root)
    if (cfg) {
      let oc = cfg.adapters.find(a => a.id === "opencode")
      if (!oc) { oc = { id: "opencode", config: {} }; cfg.adapters.push(oc) }
      oc.config.registeredAt = (oc.config.registeredAt as string) ?? nowISO()
      oc.config.lastEventAt = info.lastEventAt ?? nowISO()
      writeProjectConfig(root, cfg)
    }
    if (info.pluginVersion && store.state.project) {
      store.emit("project.registered", { name: store.state.project.name, root, pluginVersion: info.pluginVersion, coreVersion: CORE_VERSION })
    }
    const bindings = await this.resolveBindings(store, true)
    this.registerAdapterManifests(store, bindings)
    const report = store.getDiscovery()
    store.setCapabilities(buildManifest(store.id, bindings, report?.capabilityDraft ?? null))
    return { connected: true, capabilities: store.getCapabilities().capabilities.agent_monitoring }
  }

  /** Generate + contract-test + activate a project-specific adapter (explicit API). */
  async generateAdapter(store: ProjectStore, spec: import("./generator.ts").GeneratedAdapterSpec): Promise<unknown> {
    const res = await this.materializeGenerated(store, spec) as { ok: boolean; errors?: string[] }
    if (!res.ok) return res
    await this.sync(store)
    const bindings = await this.resolveBindings(store, true)
    const report = store.getDiscovery()
    store.setCapabilities(buildManifest(store.id, bindings, report?.capabilityDraft ?? null))
    const fp = report ? takeBaseline(store, report) : null
    if (fp) { fp.diagnosticsBaseline = store.state.diagnostics.schemaViolations + store.state.diagnostics.unknownEvents; store.setFingerprint(fp) }
    return { ...res, capability: store.getCapabilities().capabilities.agent_monitoring }
  }

  recentLog(): string[] { return this.log.slice(-100) }
}
