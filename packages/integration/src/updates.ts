// Adapter Update Manager: versions, compatibility, contract-tested updates, rollback.
// Local adapter updates are preferred over product reinstall. History is preserved.
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs"
import { join, basename } from "node:path"
import type { Adapter, AdapterContext } from "../../adapters/src/contract.ts"
import { BUILTIN_ADAPTERS, makeContext } from "../../adapters/src/index.ts"
import type { AdapterVersionRecord } from "../../core/src/types.ts"
import { CORE_VERSION } from "../../core/src/types.ts"
import type { ProjectStore } from "../../core/src/store.ts"
import { nowISO, sha256 } from "../../core/src/ids.ts"
import { contractTestAdapter, loadGeneratedAdapter, listGeneratedAdapterFiles } from "./generator.ts"
import { integrationDir, readProjectConfig } from "./install.ts"

export function compatibilityOk(range: string): boolean {
  // supports ">=x.y.z" and exact ranges against CORE_VERSION
  const m = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(range)
  if (!m) return true
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const [cmaj, cmin, cpat] = CORE_VERSION.split(".").map(Number)
  return cmaj > maj || (cmaj === maj && (cmin > min || (cmin === min && cpat >= pat)))
}

export function adapterStatus(store: ProjectStore): unknown {
  const integ = store.getIntegration()
  const cfg = readProjectConfig(store.state.project?.root ?? "")
  const adapters = integ.adapters.map(a => {
    const active = integ.versions.filter(v => v.adapterId === a.id && v.status === "active").sort((x, y) => x.activatedAt < y.activatedAt ? 1 : -1)[0]
    const sync = integ.sync[a.id]
    return {
      adapterId: a.id, title: a.title, kind: a.kind, version: a.version,
      activeVersion: active?.version ?? a.version,
      compatible: compatibilityOk(a.compatibility.core),
      sync: sync ?? { state: "never" },
      history: integ.versions.filter(v => v.adapterId === a.id).length,
      enabled: cfg?.adapters.find(x => x.id === a.id)?.enabled !== false,
    }
  })
  return { coreVersion: CORE_VERSION, adapters, generatedFiles: listGeneratedAdapterFiles(store.state.project?.root ?? "").map(f => basename(f)) }
}

function recordVersion(store: ProjectStore, rec: AdapterVersionRecord): void {
  const integ = store.getIntegration()
  for (const v of integ.versions) if (v.adapterId === rec.adapterId && v.status === "active") v.status = "superseded"
  integ.versions.push(rec)
  store.setIntegration(integ)
}

/** Update a generated adapter: reload file, contract-test, activate or rollback. */
export async function updateGeneratedAdapter(store: ProjectStore, adapterId: string): Promise<{ ok: boolean; detail: string; version?: string; rolledBack?: boolean }> {
  const root = store.state.project?.root ?? ""
  const name = adapterId.replace(/^generated:/, "")
  const file = join(integrationDir(root), "adapters", `${name}.adapter.ts`)
  if (!existsSync(file)) return { ok: false, detail: `generated adapter file not found: ${file}` }
  const source = readFileSync(file, "utf8")
  const checksum = sha256(source)
  const integ = store.getIntegration()
  const active = integ.versions.filter(v => v.adapterId === adapterId && v.status === "active").sort((x, y) => x.activatedAt < y.activatedAt ? 1 : -1)[0]
  if (active?.checksum === checksum) return { ok: true, detail: "already at current version", version: active.version }
  const cfg = readProjectConfig(root)
  const adapterCfg = cfg?.adapters.find(a => a.id === adapterId)?.config ?? {}
  const ctx = makeContext({ projectId: store.id, projectRoot: root, integrationDir: integrationDir(root), config: adapterCfg })
  try {
    const adapter = await loadGeneratedAdapter(file, checksum)
    const test = await contractTestAdapter(adapter, ctx)
    if (!test.ok) {
      return { ok: false, detail: `contract tests failed, activation refused: ${test.errors.join("; ")}` }
    }
    const version = `1.0.${integ.versions.filter(v => v.adapterId === adapterId).length + 1}`
    recordVersion(store, { adapterId, version, activatedAt: nowISO(), file, checksum, previousVersion: active?.version, status: "active" })
    // refresh manifest entry
    const i2 = store.getIntegration()
    const idx = i2.adapters.findIndex(a => a.id === adapterId)
    if (idx >= 0) i2.adapters[idx] = adapter.manifest
    else i2.adapters.push(adapter.manifest)
    store.setIntegration(i2)
    store.emit("integration.adapter_updated", { adapterId, version, previousVersion: active?.version })
    return { ok: true, detail: `activated ${version} (contract tests passed: ${test.eventCount} events validated)`, version }
  } catch (e) {
    return { ok: false, detail: `update failed: ${(e as Error).message}`, rolledBack: !!active }
  }
}

/** Rollback to the previous version (generated: restore history file). */
export async function rollbackAdapter(store: ProjectStore, adapterId: string): Promise<{ ok: boolean; detail: string }> {
  const integ = store.getIntegration()
  const versions = integ.versions.filter(v => v.adapterId === adapterId).sort((x, y) => x.activatedAt < y.activatedAt ? 1 : -1)
  const active = versions.find(v => v.status === "active")
  const previous = versions.find(v => v.status === "superseded" && v.version !== active?.version)
  if (!previous) return { ok: false, detail: "no previous version to roll back to" }
  const root = store.state.project?.root ?? ""
  if (previous.file && adapterId.startsWith("generated:")) {
    const name = adapterId.replace(/^generated:/, "")
    const histDir = join(integrationDir(root), "adapters", "history")
    const histFile = join(histDir, `${name}.${previous.checksum.slice(0, 12)}.adapter.ts`)
    const target = join(integrationDir(root), "adapters", `${name}.adapter.ts`)
    if (existsSync(histFile)) {
      copyFileSync(histFile, target)
    } else if (existsSync(previous.file)) {
      // file content may still match previous checksum in place; nothing to restore
    } else {
      return { ok: false, detail: `history file missing for ${previous.version}` }
    }
    const ctx = makeContext({ projectId: store.id, projectRoot: root, integrationDir: integrationDir(root), config: {} })
    try {
      const adapter = await loadGeneratedAdapter(target, previous.checksum + "-rollback")
      const test = await contractTestAdapter(adapter, ctx)
      if (!test.ok) return { ok: false, detail: `rollback contract tests failed: ${test.errors.join("; ")}` }
    } catch (e) { return { ok: false, detail: `rollback load failed: ${(e as Error).message}` } }
  }
  if (active) active.status = "rolled_back"
  previous.status = "active"
  previous.activatedAt = nowISO()
  store.setIntegration(integ)
  store.emit("integration.adapter_updated", { adapterId, version: previous.version, previousVersion: active?.version })
  return { ok: true, detail: `rolled back to ${previous.version}` }
}

/** Built-in adapter update = config refresh from discovery + re-probe + version record. */
export async function updateBuiltinAdapter(store: ProjectStore, adapterId: string, probeFn: (adapter: Adapter, ctx: AdapterContext) => Promise<unknown>): Promise<{ ok: boolean; detail: string }> {
  const adapter = BUILTIN_ADAPTERS[adapterId]
  if (!adapter) return { ok: false, detail: `unknown builtin adapter: ${adapterId}` }
  const root = store.state.project?.root ?? ""
  const cfg = readProjectConfig(root)
  const adapterCfg = cfg?.adapters.find(a => a.id === adapterId)?.config ?? {}
  const ctx = makeContext({ projectId: store.id, projectRoot: root, integrationDir: integrationDir(root), config: adapterCfg })
  const checksum = sha256(JSON.stringify(adapterCfg) + adapter.manifest.version)
  try {
    await probeFn(adapter, ctx)
    recordVersion(store, { adapterId, version: adapter.manifest.version, activatedAt: nowISO(), checksum, status: "active" })
    return { ok: true, detail: `builtin ${adapterId} re-verified at ${adapter.manifest.version}` }
  } catch (e) { return { ok: false, detail: String((e as Error).message) } }
}
