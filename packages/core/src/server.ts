// HTTP server bootstrap: API + SSE + static dashboard. Local-first (127.0.0.1 default).
import { createServer, type Server } from "node:http"
import { existsSync, readFileSync, statSync } from "node:fs"
import { join, extname, normalize } from "node:path"
import { fileURLToPath } from "node:url"
import { ProjectManager } from "./store.ts"
import { handleApi, type IntegrationHost } from "./api.ts"
import { CORE_VERSION } from "./types.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
function dirname(p: string): string { const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")); return p.slice(0, i) }

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".map": "application/json",
}

export interface ServerOptions {
  dataDir: string
  port?: number
  host?: string
  host_integration?: IntegrationHost | null
  dashboardDir?: string
}

export function startServer(opts: ServerOptions): { server: Server; manager: ProjectManager; port: number } {
  const manager = new ProjectManager(opts.dataDir)
  const host = opts.host_integration ?? null
  const dashDir = opts.dashboardDir ?? join(HERE, "..", "..", "dashboard", "dist")
  const port = opts.port ?? 8095
  const bindHost = opts.host ?? "127.0.0.1"

  const server = createServer(async (req, res) => {
    try {
      const handled = await handleApi(req, res, manager, host)
      if (handled) return
      // static dashboard
      const url = (req.url ?? "/").split("?")[0]
      let rel = url === "/" ? "/index.html" : url
      rel = normalize(rel).replace(/^([/\\])+/, "")
      const file = join(dashDir, rel)
      if (!file.startsWith(dashDir)) { res.writeHead(403); res.end("forbidden"); return }
      if (existsSync(file) && statSync(file).isFile()) {
        const data = readFileSync(file)
        res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store", "Content-Length": data.length })
        res.end(data)
        return
      }
      // SPA fallback for hash-less routes; if no build exists, show a helpful placeholder
      const index = join(dashDir, "index.html")
      if (existsSync(index)) {
        const data = readFileSync(index)
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": data.length })
        res.end(data)
        return
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      res.end(`<!doctype html><meta charset="utf-8"><title>DFCP</title>
<body style="font-family:system-ui;background:#0b1020;color:#e6ebf5;padding:40px">
<h1>Dark Factory Control Plane ${CORE_VERSION}</h1>
<p>Core API is running. Dashboard assets are not built yet.</p>
<p>Build them with: <code>node packages/dashboard/build.mjs</code></p>
<p>API health: <a style="color:#7dd3fc" href="/api/health">/api/health</a></p></body>`)
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: String((e as Error).message ?? e) }))
    }
  })

  server.listen(port, bindHost)
  return { server, manager, port }
}
