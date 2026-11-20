// Integration directory layout + project config + install manifest (reversible installs).
// ALL product writes into a target project are confined to .dark-factory/ and tracked.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync, copyFileSync } from "node:fs"
import { join, dirname, relative, isAbsolute, sep } from "node:path"
import { nowISO } from "../../core/src/ids.ts"

export const INTEGRATION_DIR = ".dark-factory"

export interface ProjectConfig {
  projectId: string
  name: string
  rootName: string
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
  excludeAdded?: string[]  // patterns appended to .git/info/exclude (local-only, reversible)
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
  // Local-only ignore for runtime integration state: never touches tracked files,
  // never published. Keeps `git status` clean and publication gates safe.
  const gitDir = join(root, ".git")
  if (existsSync(gitDir)) {
    const infoDir = join(gitDir, "info")
    const excludePath = join(infoDir, "exclude")
    try {
      mkdirSync(infoDir, { recursive: true })
      const current = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : ""
      const pattern = ".dark-factory/"
      if (!current.split("\n").some(l => l.trim() === pattern)) {
        writeFileSync(excludePath, current + (current.endsWith("\n") || !current ? "" : "\n") + pattern + "\n")
        manifest.excludeAdded = [...(manifest.excludeAdded ?? []), pattern]
        writeJson(manifestPath, manifest)
      }
    } catch { /* best effort; operator can add .dark-factory/ to .gitignore manually */ }
  }
  return manifest
}

/** Install the OpenCode agent/skill kit (additive, tracked, never overwrites). */
export function installKit(root: string, kitDir: string): { installed: string[]; skipped: string[] } {
  const installed: string[] = []
  const skipped: string[] = []
  if (!existsSync(kitDir)) return { installed, skipped }
  for (const sub of ["agent", "skills"]) {
    const srcDir = join(kitDir, sub)
    if (!existsSync(srcDir)) continue
    const destBase = join(root, ".opencode", sub)
    const entries = sub === "agent" ? readdirSync(srcDir).filter(f => f.endsWith(".md")) : readdirSync(srcDir)
    for (const entry of entries) {
      const src = join(srcDir, entry)
      const dest = join(destBase, entry)
      if (existsSync(dest)) { skipped.push(dest); continue }
      mkdirSync(dirname(dest), { recursive: true })
      if (sub === "agent") copyFileSync(src, dest)
      else {
        mkdirSync(dest, { recursive: true })
        for (const f of readdirSync(src)) copyFileSync(join(src, f), join(dest, f))
      }
      installed.push(dest)
      trackFile(root, dest)
    }
  }
  return { installed, skipped }
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
    const rel = isAbsolute(relPath) ? relative(root, relPath).replace(/\\/g, "/") : relPath
    if (!m.files.includes(rel)) { m.files.push(rel); writeJson(manifestPath, m) }
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

/** Uninstall: remove ONLY tracked files (integration dir + tracked kit/plugin additions).
 *  Never touches harness files or anything not listed in the install manifests. */
export function uninstall(root: string): { removed: string[]; errors: string[] } {
  const idir = integrationDir(root)
  const manifestPath = join(idir, "generated", "install-manifest.json")
  const kitManifestPath = join(idir, "generated", "opencode-kit-manifest.json")
  const removed: string[] = []
  const errors: string[] = []
  const tracked: string[] = []
  let excludeAdded: string[] = []
  for (const mp of [manifestPath, kitManifestPath]) {
    if (!existsSync(mp)) continue
    try {
      const m: InstallManifest & { files?: string[] } = JSON.parse(readFileSync(mp, "utf8"))
      tracked.push(...(m.files ?? []))
      excludeAdded = [...excludeAdded, ...(m.excludeAdded ?? [])]
    } catch (e) { errors.push(String((e as Error).message)) }
  }
  const allowed = (abs: string): boolean =>
    abs === idir || abs.startsWith(idir + sep) ||
    abs.startsWith(join(root, ".opencode", "agent") + sep) ||
    abs.startsWith(join(root, ".opencode", "skills") + sep) ||
    abs.startsWith(join(root, ".opencode", "plugins", "dark-factory") + sep)
  for (const f of tracked) {
    const abs = isAbsolute(f) ? f : join(root, f)
    if (!allowed(abs)) { errors.push(`refused to remove outside integration/kit paths: ${f}`); continue }
    try { if (existsSync(abs)) { rmSync(abs, { recursive: true, force: true }); removed.push(f) } } catch (e) { errors.push(String((e as Error).message)) }
  }
  // revert local-only git exclude patterns we added
  if (excludeAdded.length) {
    const excludePath = join(root, ".git", "info", "exclude")
    try {
      if (existsSync(excludePath)) {
        const lines = readFileSync(excludePath, "utf8").split("\n").filter(l => !excludeAdded.includes(l.trim()))
        writeFileSync(excludePath, lines.join("\n"))
      }
    } catch (e) { errors.push(String((e as Error).message)) }
  }
  try { if (existsSync(idir)) { rmSync(idir, { recursive: true, force: true }); removed.push(INTEGRATION_DIR + "/") } } catch (e) { errors.push(String((e as Error).message)) }
  return { removed, errors }
}
