// DFCP OpenCode Plugin — THIN integration layer.
// Responsibilities: project registration, event forwarding, agent/session linkage,
// factory commands/tools, kit installation. ALL business logic lives in the DFCP Core.
import { Plugin } from "@opencode/plugin"
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, copyFileSync } from "node:fs"
import { join, dirname, basename } from "node:path"
import { fileURLToPath } from "node:url"
import { CoreClient, slugify } from "./client.ts"
import { mapOpenCodeEvent, mapToolExecution, agentIdOfSession, type DfcpEvent } from "./event-map.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_VERSION = "0.1.0"
const KIT_DIR = join(HERE, "..", "kit")

export default Plugin.define({
  id: "dark-factory",
  async setup(ctx: any) {
    const options = (ctx.options ?? {}) as { coreUrl?: string; projectId?: string; autoSetup?: boolean; forwardEvents?: boolean }
    const baseUrl = options.coreUrl ?? process.env.DFCP_URL ?? "http://127.0.0.1:8095"
    const root: string = ctx.location?.directory ?? process.cwd()
    const projectId = options.projectId ? slugify(options.projectId) : slugify(ctx.location?.project?.id ?? basename(root))
    const projectName = basename(root)
    const client = new CoreClient({ baseUrl })
    const forwardEvents = options.forwardEvents !== false
    const autoSetup = options.autoSetup !== false

    let connected = false
    let disposed = false
    const abort = new AbortController()
    const batch: DfcpEvent[] = []
    const activeSessions = new Map<string, { lastActivity: number }>()
    const timers: ReturnType<typeof setInterval>[] = []

    const enqueue = (events: DfcpEvent[]) => {
      if (!forwardEvents || disposed) return
      batch.push(...events)
      if (batch.length > 200) batch.splice(0, batch.length - 200) // bounded buffer; core dedups
    }

    const flush = async () => {
      if (!connected || !batch.length) return
      const events = batch.splice(0, batch.length)
      const res = await client.ingest(projectId, events)
      if (!res.ok) {
        // re-queue on failure (bounded); never crash the host
        batch.unshift(...events.slice(-100))
      }
    }

    const connect = async (): Promise<boolean> => {
      if (!(await client.healthy())) return false
      await client.ensureProject(projectId, projectName, root)
      await client.post(`/api/projects/${projectId}/plugin/connect`, { pluginVersion: PLUGIN_VERSION })
      if (autoSetup) {
        const caps = await client.get(`/api/projects/${projectId}/capabilities`)
        const manifest = caps.data as { capabilities?: Record<string, { confidence?: string }> } | null
        const unassessed = !manifest?.capabilities || Object.values(manifest.capabilities).every(c => c.confidence === "inferred")
        if (unassessed) {
          await client.post(`/api/projects/${projectId}/discover`)
          await client.post(`/api/projects/${projectId}/sync`)
        }
      }
      connected = true
      return true
    }

    // initial connection + retry until core is up (core may start after OpenCode)
    void connect().catch(() => {})
    timers.push(setInterval(() => { if (!connected && !disposed) void connect().catch(() => {}) }, 15000))
    timers.push(setInterval(() => { void flush().catch(() => {}) }, 2000))
    // periodic connection refresh (keeps opencode capability fresh/stale honest)
    timers.push(setInterval(() => {
      if (connected && !disposed) void client.post(`/api/projects/${projectId}/plugin/connect`, { pluginVersion: PLUGIN_VERSION, lastEventAt: new Date().toISOString() }).catch(() => {})
    }, 60000))
    // heartbeats for sessions seen recently (activity proof, never completion proof)
    timers.push(setInterval(() => {
      if (!connected || disposed) return
      const now = Date.now()
      const events: DfcpEvent[] = []
      for (const [sid, info] of activeSessions) {
        if (now - info.lastActivity < 10 * 60 * 1000) {
          events.push({
            type: "agent.heartbeat", schemaVersion: 1,
            payload: { id: agentIdOfSession(sid), note: "plugin heartbeat" },
            idempotencyKey: `oc:hb:${sid}:${Math.floor(now / 30000)}`,
            source: { adapterId: "opencode", sourceId: "opencode-plugin", entityKind: "agent", authoritative: true, fetchedAt: new Date().toISOString() },
          })
        } else activeSessions.delete(sid)
      }
      enqueue(events)
    }, 30000))

    // ---- OpenCode server event stream -> DFCP events ----
    if (forwardEvents) {
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
            if (disposed) break
            const e = event as Record<string, unknown>
            const type = String(e.type ?? "")
            if (type.startsWith("session.") || type.startsWith("message.")) {
              const p = (e.properties ?? {}) as Record<string, unknown>
              const sid = (p.sessionID ?? (p.info as Record<string, unknown> | undefined)?.id ?? (p.part as Record<string, unknown> | undefined)?.sessionID) as string | undefined
              if (sid) activeSessions.set(sid, { lastActivity: Date.now() })
            }
            enqueue(mapOpenCodeEvent(e))
          }
        } catch { /* stream aborted or unavailable — plugin stays functional */ }
      })()
      // tool execution telemetry
      try {
        await ctx.tool.hook("execute.after", (event: any) => {
          enqueue(mapToolExecution({
            tool: String(event.tool ?? "unknown"),
            sessionID: event.sessionID,
            status: event.status === "error" ? "error" : "completed",
            error: event.error?.message,
          }))
        })
      } catch { /* hooks unavailable in older hosts */ }
    }

    // ---- kit installation (agents + skills into .opencode/, tracked & reversible) ----
    const installKit = (): { installed: string[]; skipped: string[] } => {
      const installed: string[] = []
      const skipped: string[] = []
      const manifestPath = join(root, ".dark-factory", "generated", "opencode-kit-manifest.json")
      const manifest: { files: string[] } = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : { files: [] }
      for (const sub of ["agent", "skills"]) {
        const srcDir = join(KIT_DIR, sub)
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
          manifest.files.push(dest)
        }
      }
      mkdirSync(dirname(manifestPath), { recursive: true })
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
      return { installed, skipped }
    }

    // ---- helpers for tools/commands ----
    const requireConnection = async (): Promise<string | null> => {
      if (!connected && !(await connect())) {
        return `DFCP core is not reachable at ${baseUrl}. Start it with: factory start (or node packages/cli/src/serve.ts).`
      }
      return null
    }
    const call = async (method: string, path: string, body?: unknown): Promise<string> => {
      const err = await requireConnection()
      if (err) return err
      const r = await client.request(method, path, body)
      return JSON.stringify(r.data, null, 2)
    }
    const summary = async (): Promise<string> => {
      const err = await requireConnection()
      if (err) return err
      const ov = await client.get(`/api/projects/${projectId}`)
      const d = ov.data as any
      if (!ov.ok) return JSON.stringify(d)
      const tasks = d.counts?.tasks ?? { total: 0, byStatus: {} }
      const agents = d.counts?.agents ?? { total: 0, working: 0 }
      const alerts = (d.alerts ?? []).slice(0, 5).map((a: any) => `[${a.severity}] ${a.message}`).join("\n")
      return `Project ${projectId}: ${tasks.total} tasks (${tasks.byStatus.done ?? 0} done, ${tasks.byStatus.in_progress ?? 0} in progress, ${tasks.byStatus.blocked ?? 0} blocked), ${agents.working}/${agents.total} agents working.\n${alerts || "No alerts."}\nDashboard: ${baseUrl}/#/${projectId}`
    }

    // ---- tools (namespace: factory) ----
    await ctx.tool.transform((editor: any) => {
      editor.namespace({ name: "factory", description: "Dark Factory Control Plane: engineering work management & observability. Thin interface to the DFCP core." })
      const add = (name: string, description: string, properties: Record<string, unknown>, required: string[], execute: (input: any) => Promise<string>) => {
        editor.add({
          name, description,
          input: { type: "object", properties, required, additionalProperties: false },
          options: { namespace: "factory", codemode: true },
          execute: async (input: any) => ({ content: await execute(input ?? {}) }),
        })
      }
      const P = { type: "string" }
      add("setup", "Register this project with DFCP, run read-only harness discovery, verify capabilities, select/generate adapters, sync data, install the agent/skill kit. Idempotent.", {}, [], async () => {
        const err = await requireConnection()
        if (err) return err
        const disc = await client.post(`/api/projects/${projectId}/discover`)
        const sync = await client.post(`/api/projects/${projectId}/sync`)
        const kit = installKit()
        const caps = await client.get(`/api/projects/${projectId}/capabilities`)
        const manifest = caps.data as any
        const lines = Object.entries(manifest?.capabilities ?? {}).map(([id, c]: [string, any]) => `${id}: ${c.status}${c.adapterId ? " via " + c.adapterId : ""}`)
        return `DFCP setup complete for ${projectId}.\nCapabilities:\n${lines.join("\n")}\nKit installed: ${kit.installed.length} files (skipped existing: ${kit.skipped.length}).\nSync: ${JSON.stringify(sync.data)}\nDashboard: ${baseUrl}/#/${projectId}`
      })
      add("discover", "Re-run read-only harness discovery and capability verification.", {}, [], () => call("POST", `/api/projects/${projectId}/discover`))
      add("status", "Project overview: tasks, agents, blockers, alerts, freshness.", {}, [], () => summary())
      add("task", "Task operations: list/get/create/update/claim/release.", {
        action: { type: "string", enum: ["list", "get", "create", "update", "claim", "release"] },
        id: P, title: P, status: P, kind: P, priority: P, assignee: P, agent: P,
        dependencies: { type: "array", items: { type: "string" } },
        parentId: P, componentId: P, estimateHours: { type: "number" }, progress: { type: "number" },
        q: P,
      }, ["action"], async (input) => {
        switch (input.action) {
          case "list": return call("GET", `/api/projects/${projectId}/tasks?q=${encodeURIComponent(input.q ?? "")}`)
          case "get": return call("GET", `/api/projects/${projectId}/tasks/${input.id}`)
          case "create": return call("POST", `/api/projects/${projectId}/tasks`, input)
          case "update": return call("PATCH", `/api/projects/${projectId}/tasks/${input.id}`, input)
          case "claim": return call("POST", `/api/projects/${projectId}/tasks/${input.id}/claim`, { agent: input.agent })
          case "release": return call("POST", `/api/projects/${projectId}/tasks/${input.id}/release`)
          default: return `unknown action: ${input.action}`
        }
      })
      add("map", "Link a task to a branch, OpenCode session, component or release.", {
        taskId: P, branch: P, sessionID: P, componentId: P, releaseId: P,
      }, ["taskId"], async (input) => {
        const links: Record<string, unknown> = {}
        if (input.branch) links.branches = [input.branch]
        if (input.releaseId) links.releaseId = input.releaseId
        const body: Record<string, unknown> = {}
        if (Object.keys(links).length) body.links = links
        if (input.componentId) body.componentId = input.componentId
        const r = await call("PATCH", `/api/projects/${projectId}/tasks/${input.taskId}`, body)
        if (input.sessionID) {
          await client.post(`/api/projects/${projectId}/events`, { events: [{
            type: "activity.note", schemaVersion: 1,
            payload: { text: `task ${input.taskId} linked to session ${input.sessionID}`, entity: input.taskId },
            idempotencyKey: `map:${input.taskId}:${input.sessionID}`,
            source: { adapterId: "opencode", sourceId: "opencode-plugin", entityKind: "activity", authoritative: true, fetchedAt: new Date().toISOString() },
          }] })
        }
        return r
      })
      add("sync", "Collect fresh data from all configured adapters (failure-isolated).", {}, [], () => call("POST", `/api/projects/${projectId}/sync`))
      add("doctor", "Integration health checks + recommendations.", {}, [], () => call("GET", `/api/projects/${projectId}/doctor`))
      add("reconcile", "Detect harness drift and reconcile the integration. Category C actions need approve targets.", {
        approve: { type: "array", items: { type: "string" } },
      }, [], (input) => call("POST", `/api/projects/${projectId}/reconcile`, { approve: input.approve ?? [] }))
      add("adapter_update", "Update an adapter (contract-tested, rollback-able).", { adapterId: P }, ["adapterId"], (input) => call("POST", `/api/projects/${projectId}/adapter/update`, { adapterId: input.adapterId }))
      add("adapter_status", "Adapter versions, compatibility, sync state.", {}, [], () => call("GET", `/api/projects/${projectId}/adapter/status`))
      add("integration_diff", "Diff current harness vs installed integration baseline (no apply).", {}, [], () => call("GET", `/api/projects/${projectId}/integration/diff`))
      add("dashboard", "Get the dashboard URL for this project.", {}, [], async () => {
        const err = await requireConnection()
        if (err) return err
        return `Dashboard: ${baseUrl}/#/${projectId}\nOpen it in a browser (browser.tabs.open). Capability-driven: only verified sections are shown.`
      })
    })

    // ---- commands ----
    await ctx.command.transform((editor: any) => {
      const cmd = (name: string, description: string, run: (text: string) => Promise<string>) => {
        editor.add({
          name, description,
          execute: async ({ sessionID, prompt, delivery }: any) => {
            const result = await run(prompt?.text ?? "")
            await ctx.session.prompt({ ...prompt, sessionID, text: result, delivery })
          },
        })
      }
      cmd("factory-setup", "DFCP: register project, discover harness, verify capabilities, install kit", async () => {
        const err = await requireConnection()
        if (err) return err
        await client.post(`/api/projects/${projectId}/discover`)
        await client.post(`/api/projects/${projectId}/sync`)
        installKit()
        return await summary()
      })
      cmd("factory-status", "DFCP: project status summary", () => summary())
      cmd("factory-dashboard", "DFCP: open the dashboard", async () => `Dashboard: ${baseUrl}/#/${projectId}\nОткрой URL в браузере (browser.tabs.open) и кратко опиши состояние проекта.`)
      cmd("factory-doctor", "DFCP: integration diagnostics", () => call("GET", `/api/projects/${projectId}/doctor`))
      cmd("factory-sync", "DFCP: sync adapters", () => call("POST", `/api/projects/${projectId}/sync`))
      cmd("factory-reconcile", "DFCP: drift reconciliation", () => call("POST", `/api/projects/${projectId}/reconcile`, { approve: [] }))
      cmd("factory", "DFCP: generic subcommand (setup|discover|status|sync|doctor|reconcile|diff|dashboard|task ...)", async (text) => {
        const sub = text.trim().split(/\s+/)[0] ?? "status"
        switch (sub) {
          case "setup": return (await client.post(`/api/projects/${projectId}/discover`)).ok ? await summary() : "discover failed"
          case "discover": return call("POST", `/api/projects/${projectId}/discover`)
          case "sync": return call("POST", `/api/projects/${projectId}/sync`)
          case "doctor": return call("GET", `/api/projects/${projectId}/doctor`)
          case "reconcile": return call("POST", `/api/projects/${projectId}/reconcile`, { approve: [] })
          case "diff": return call("GET", `/api/projects/${projectId}/integration/diff`)
          case "dashboard": return `Dashboard: ${baseUrl}/#/${projectId}`
          default: return await summary()
        }
      })
    })

    // ---- cleanup ----
    return () => {
      disposed = true
      abort.abort()
      for (const t of timers) clearInterval(t)
      void flush().catch(() => {})
    }
  },
})
