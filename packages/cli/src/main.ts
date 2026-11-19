#!/usr/bin/env node
// factory — DFCP CLI. Thin interface to the Core Product over HTTP.
// Usage: factory <command> [options]   (run `factory help` for the command list)
import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_URL = process.env.DFCP_URL ?? "http://127.0.0.1:8095"
const DEFAULT_DATA = process.env.DFCP_DATA ?? join(homedir(), ".dfcp")

function parseArgs(argv: string[]): { cmd: string; flags: Record<string, string>; pos: string[] } {
  const flags: Record<string, string> = {}
  const pos: string[] = []
  let cmd = ""
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--")) {
      const key = a.slice(2)
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true"
      flags[key] = val
    } else if (!cmd) cmd = a
    else pos.push(a)
  }
  return { cmd, flags, pos }
}

async function api(url: string, method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(url + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  })
  const text = await res.text()
  let data: unknown
  try { data = JSON.parse(text) } catch { data = text }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${typeof data === "object" ? JSON.stringify(data) : text}`)
  return data
}

async function healthy(url: string): Promise<boolean> {
  try { const r = await fetch(url + "/api/health", { signal: AbortSignal.timeout(2000) }); return r.ok } catch { return false }
}

/** Auto-start the core in the background when a command needs it. */
async function ensureCore(url: string, dataDir: string): Promise<void> {
  if (await healthy(url)) return
  const port = new URL(url).port || "8095"
  const serve = join(HERE, "serve.ts")
  const child = spawn(process.execPath, [serve, "--data", dataDir, "--port", port], {
    detached: true, stdio: "ignore", windowsHide: true,
  })
  child.unref()
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 250))
    if (await healthy(url)) return
  }
  throw new Error(`core did not become healthy at ${url}; run 'factory start' manually to see logs`)
}

function out(v: unknown): void { console.log(JSON.stringify(v, null, 2)) }

function printManifestSummary(manifest: Record<string, unknown>): void {
  const caps = manifest.capabilities as Record<string, { status: string; adapterId?: string; limitations?: string[] }>
  console.log("Capability Manifest:")
  for (const [id, c] of Object.entries(caps)) {
    const lim = c.limitations?.length ? `  (${c.limitations.join("; ")})` : ""
    console.log(`  ${id.padEnd(20)} ${c.status.padEnd(15)} ${c.adapterId ?? "-"}${lim}`)
  }
}

const HELP = `Dark Factory Control Plane — factory CLI

Usage: factory <command> [--flags]

Lifecycle:
  start [--port 8095] [--data DIR]     run the core in the foreground
  stop                                 stop the background core (pid file)
  status                               core health + registered projects

Integration:
  setup --root DIR [--name N] [--id ID]   register + discover + verify + sync a project
  discover --project ID                re-run harness discovery (read-only)
  sync --project ID                    collect from all adapters
  doctor --project ID                  integration health checks
  reconcile --project ID [--approve a,b]  drift reconciliation (A/B auto, C needs approval)
  diff --project ID                    harness drift diff + action plan (no apply)
  adapter:status --project ID          adapter versions / compatibility / sync
  adapter:update --project ID --adapter ID
  adapter:rollback --project ID --adapter ID
  adapter:generate --project ID --spec spec.json   generate + contract-test + activate
  uninstall --root DIR --yes           remove .dark-factory (tracked files only)

Work management:
  task:list --project ID [--status S] [--q TEXT]
  task:create --project ID --id T1 --title "..." [--kind task] [--deps T0,T2] [--estimate 4]
  task:get --project ID --id T1
  task:update --project ID --id T1 [--status done] [--progress 80] [--assignee agent-1]
  task:claim --project ID --id T1 --agent agent-1
  task:release --project ID --id T1
  release:create --project ID --id r1 --name v1 [--scope T1,T2]
  release:get --project ID --id r1

Observability:
  dashboard --project ID               print dashboard URL
  overview --project ID                project overview JSON
  events --project ID [--after N]      event log tail

Global flags: --url URL (core API), --data DIR (core data directory)
`

async function main(): Promise<void> {
  const { cmd, flags } = parseArgs(process.argv.slice(2))
  const url = flags.url ?? DEFAULT_URL
  const dataDir = resolve(flags.data ?? DEFAULT_DATA)
  const project = flags.project ?? flags.id ?? ""
  const needProject = () => { if (!project) throw new Error("--project <id> required") }

  switch (cmd) {
    case "help": case "": case undefined:
      console.log(HELP); return
    case "start": {
      await import("./serve.ts")
      return
    }
    case "stop": {
      const pidFile = join(dataDir, "core.pid")
      if (!existsSync(pidFile)) { console.log("no pid file; core not running under this data dir"); return }
      const pid = Number(readFileSync(pidFile, "utf8"))
      try { process.kill(pid); console.log(`stopped core (pid ${pid})`) } catch (e) { console.log(`could not stop pid ${pid}: ${(e as Error).message}`) }
      return
    }
    case "status": {
      if (!(await healthy(url))) { console.log(`core: DOWN (${url})`); return }
      out(await api(url, "GET", "/api/health"))
      out(await api(url, "GET", "/api/projects"))
      return
    }
    case "setup": {
      const root = resolve(flags.root ?? ".")
      if (!existsSync(root)) throw new Error(`root not found: ${root}`)
      await ensureCore(url, dataDir)
      const name = flags.name ?? root.split(/[\\/]/).pop() ?? "project"
      const id = flags.id ?? name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
      await api(url, "POST", "/api/projects", { id, name, root })
      const disc = await api(url, "POST", `/api/projects/${id}/discover`) as { manifest: Record<string, unknown>; report: { detectedTools: string[]; evidences: unknown[] } }
      console.log(`Discovered tools: ${disc.report.detectedTools.join(", ") || "(none)"}`)
      printManifestSummary(disc.manifest)
      const sync = await api(url, "POST", `/api/projects/${id}/sync`)
      out({ sync })
      console.log(`\nDashboard: ${url}/  (project ${id})`)
      return
    }
    case "discover": { needProject(); await ensureCore(url, dataDir); const r = await api(url, "POST", `/api/projects/${project}/discover`) as { manifest: Record<string, unknown> }; printManifestSummary(r.manifest); return }
    case "sync": { needProject(); await ensureCore(url, dataDir); out(await api(url, "POST", `/api/projects/${project}/sync`)); return }
    case "doctor": { needProject(); await ensureCore(url, dataDir); out(await api(url, "GET", `/api/projects/${project}/doctor`)); return }
    case "reconcile": { needProject(); await ensureCore(url, dataDir); out(await api(url, "POST", `/api/projects/${project}/reconcile`, { approve: flags.approve ? flags.approve.split(",") : [] })); return }
    case "diff": { needProject(); await ensureCore(url, dataDir); out(await api(url, "GET", `/api/projects/${project}/integration/diff`)); return }
    case "adapter:status": { needProject(); await ensureCore(url, dataDir); out(await api(url, "GET", `/api/projects/${project}/adapter/status`)); return }
    case "adapter:update": { needProject(); if (!flags.adapter) throw new Error("--adapter required"); await ensureCore(url, dataDir); out(await api(url, "POST", `/api/projects/${project}/adapter/update`, { adapterId: flags.adapter })); return }
    case "adapter:rollback": { needProject(); if (!flags.adapter) throw new Error("--adapter required"); await ensureCore(url, dataDir); out(await api(url, "POST", `/api/projects/${project}/adapter/rollback`, { adapterId: flags.adapter })); return }
    case "adapter:generate": {
      needProject(); if (!flags.spec) throw new Error("--spec <json file> required")
      const spec = JSON.parse(readFileSync(resolve(flags.spec), "utf8"))
      await ensureCore(url, dataDir)
      out(await api(url, "POST", `/api/projects/${project}/adapter/generate`, spec))
      return
    }
    case "uninstall": {
      const root = resolve(flags.root ?? ".")
      if (flags.yes !== "true") throw new Error("uninstall requires --yes (removes only .dark-factory tracked files)")
      const { uninstall } = await import("../../integration/src/install.ts")
      out(uninstall(root))
      return
    }
    case "task:list": { needProject(); await ensureCore(url, dataDir); const qs = new URLSearchParams(); if (flags.status) qs.set("status", flags.status); if (flags.q) qs.set("q", flags.q); out(await api(url, "GET", `/api/projects/${project}/tasks?${qs}`)); return }
    case "task:create": {
      needProject(); await ensureCore(url, dataDir)
      if (!flags.id || !flags.title) throw new Error("--id and --title required")
      const body: Record<string, unknown> = { id: flags.id, title: flags.title }
      if (flags.kind) body.kind = flags.kind
      if (flags.deps) body.dependencies = flags.deps.split(",")
      if (flags.parent) body.parentId = flags.parent
      if (flags.estimate) body.estimateHours = Number(flags.estimate)
      if (flags.priority) body.priority = flags.priority
      if (flags.status) body.status = flags.status
      if (flags.component) body.componentId = flags.component
      out(await api(url, "POST", `/api/projects/${project}/tasks`, body))
      return
    }
    case "task:get": { needProject(); await ensureCore(url, dataDir); out(await api(url, "GET", `/api/projects/${project}/tasks/${flags.id}`)); return }
    case "task:update": {
      needProject(); await ensureCore(url, dataDir)
      const body: Record<string, unknown> = {}
      for (const k of ["status", "progress", "assignee", "priority", "title", "description", "sourceStatus"]) if (flags[k] !== undefined) body[k] = k === "progress" ? Number(flags[k]) : flags[k]
      if (flags.deps) body.dependencies = flags.deps.split(",")
      out(await api(url, "PATCH", `/api/projects/${project}/tasks/${flags.id}`, body))
      return
    }
    case "task:claim": { needProject(); await ensureCore(url, dataDir); out(await api(url, "POST", `/api/projects/${project}/tasks/${flags.id}/claim`, { agent: flags.agent })); return }
    case "task:release": { needProject(); await ensureCore(url, dataDir); out(await api(url, "POST", `/api/projects/${project}/tasks/${flags.id}/release`)); return }
    case "release:create": { needProject(); await ensureCore(url, dataDir); out(await api(url, "POST", `/api/projects/${project}/releases`, { id: flags.id, name: flags.name ?? flags.id, scopeTaskIds: flags.scope ? flags.scope.split(",") : [] })); return }
    case "release:get": { needProject(); await ensureCore(url, dataDir); out(await api(url, "GET", `/api/projects/${project}/releases/${flags.id}`)); return }
    case "dashboard": { needProject(); console.log(`${url}/#/${project}`); return }
    case "overview": { needProject(); await ensureCore(url, dataDir); out(await api(url, "GET", `/api/projects/${project}`)); return }
    case "events": { needProject(); await ensureCore(url, dataDir); out(await api(url, "GET", `/api/projects/${project}/events?after=${flags.after ?? 0}&limit=${flags.limit ?? 50}`)); return }
    default:
      console.error(`unknown command: ${cmd}\n`)
      console.log(HELP)
      process.exitCode = 1
  }
}

main().catch(e => { console.error(`factory: ${e.message}`); process.exitCode = 1 })
