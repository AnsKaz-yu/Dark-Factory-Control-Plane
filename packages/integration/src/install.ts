// Integration directory layout + project config + install manifest (reversible installs).
// ALL product writes into a target project are confined to .dark-factory/ and tracked.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs"
import { join, dirname } from "node:path"
import { nowISO } from "../../core/src/ids.ts"

export const INTEGRATION_DIR = ".dark-factory"

export interface ProjectConfig {
  projectId: string
  name: string
  root: string
  createdAt: string
  productVersion: string
  adapters: { id: string; config: Record<string, unknown>; enabled?: boolean; generated?: boolean }[]
  permissions: { allowStructural: boolean; allowWrite: boolean; allowMaintenance: boolean }
  sources: Record<string, { authoritative: string; auxiliary?: string[]; conflict?: "authoritative-wins" | "manual" }>
}

export interface InstallManifest {
  installedAt: string
  productVersion: string
  files: string[]      // every file created by DFCP inside the target project
  dirs: string[]
}

export function integrationDir(root: string): string { return join(root, INTEGRATION_DIR) }

export function ensureLayout(root: string): InstallManifest {
  const idir = integrationDir(root)
  const dirs = ["config", "adapters", "adapters/history", "generated", "diagnostics", "state"].map(d => join(idir, d))
  const created: string[] = []
  for (const d of dirs) if (!existsSync(d)) { mkdirSync(d, { recursive: true }); created.push(d) }
  const manifestPath = join(idir, "generated", "install-manifest.json")
  let manifest: InstallManifest
  if (existsSync(manifestPath)) {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    for (const d of created) if (!manifest.dirs.includes(d)) manifest.dirs.push(d)
  } else {
    manifest = { installedAt: nowISO(), productVersion: "0.1.0", files: [], dirs: created }
  }
  writeJson(manifestPath, manifest)
  if (!manifest.files.includes(manifestPath)) manifest.files.push(manifestPath)
  return manifest
}

export function writeJson(absPath: string, value: unknown): void {
  mkdirSync(dirname(absPath), { recursive: true })
  const tmp = absPath + ".tmp-" + process.pid
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  renameSync(tmp, absPath)
}

export function trackFile(root: string, relPath: string): void {
  const manifestPath = join(integrationDir(root), "generated", "install-manifest.json")
  if (!existsSync(manifestPath)) return
  try {
    const m: InstallManifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    if (!m.files.includes(relPath)) { m.files.push(relPath); writeJson(manifestPath, m) }
  } catch { /* best effort */ }
}

export function readProjectConfig(root: string): ProjectConfig | null {
  const p = join(integrationDir(root), "config", "project.json")
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, "utf8")) } catch { return null }
}

export function writeProjectConfig(root: string, cfg: ProjectConfig): void {
  const p = join(integrationDir(root), "config", "project.json")
  writeJson(p, cfg)
  trackFile(root, p)
}

/** Uninstall: remove ONLY tracked files/dirs. Never touches harness files. */
export function uninstall(root: string): { removed: string[]; errors: string[] } {
  const idir = integrationDir(root)
  const manifestPath = join(idir, "generated", "install-manifest.json")
  const removed: string[] = []
  const errors: string[] = []
  if (existsSync(manifestPath)) {
    try {
      const m: InstallManifest = JSON.parse(readFileSync(manifestPath, "utf8"))
      for (const f of m.files) {
        const abs = join(root, f)
        if (!abs.startsWith(idir)) { errors.push(`refused to remove outside integration dir: ${f}`); continue }
        try { if (existsSync(abs)) { rmSync(abs); removed.push(f) } } catch (e) { errors.push(String((e as Error).message)) }
      }
    } catch (e) { errors.push(String((e as Error).message)) }
  }
  try { if (existsSync(idir)) { rmSync(idir, { recursive: true, force: true }); removed.push(INTEGRATION_DIR + "/") } } catch (e) { errors.push(String((e as Error).message)) }
  return { removed, errors }
}
