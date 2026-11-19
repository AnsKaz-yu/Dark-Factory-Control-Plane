// DFCP full product server: Core + Adaptive Integration Layer attached.
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { writeFileSync, mkdirSync } from "node:fs"
import { startServer } from "../../core/src/server.ts"
import { DfcpIntegrationHost } from "../../integration/src/host.ts"
import { CORE_VERSION } from "../../core/src/types.ts"

export function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2)
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true"
      out[key] = val
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const dataDir = resolve(args.data ?? join(homedir(), ".dfcp"))
const port = Number(args.port ?? 8095)
const host = args.host ?? "127.0.0.1"
mkdirSync(dataDir, { recursive: true })

const integration = new DfcpIntegrationHost()
const { server } = startServer({ dataDir, port, host, host_integration: integration })
writeFileSync(join(dataDir, "core.pid"), String(process.pid))
server.on("listening", () => {
  console.log(`[dfcp] v${CORE_VERSION} listening on http://${host}:${port} (data: ${dataDir})`)
  console.log(`[dfcp] dashboard: http://${host}:${port}/  ·  api: /api/health`)
})
server.on("error", (e) => { console.error(`[dfcp] server error: ${e.message}`); process.exit(1) })
process.on("SIGINT", () => { server.close(); process.exit(0) })
process.on("SIGTERM", () => { server.close(); process.exit(0) })
