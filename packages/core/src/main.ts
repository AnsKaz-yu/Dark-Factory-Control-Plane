// DFCP Core entry point.
// Usage: node packages/core/src/main.ts [--port 8095] [--host 127.0.0.1] [--data ~/.dfcp]
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { startServer } from "./server.ts"
import { CORE_VERSION } from "./types.ts"

function parseArgs(argv: string[]): Record<string, string> {
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

// Integration layer is attached by the full product entry (packages/cli or product main);
// standalone core runs with API + storage + projections only.
const { server } = startServer({ dataDir, port, host })
server.on("listening", () => {
  console.log(`[dfcp-core] v${CORE_VERSION} listening on http://${host}:${port} (data: ${dataDir})`)
})
server.on("error", (e) => {
  console.error(`[dfcp-core] server error: ${e.message}`)
  process.exit(1)
})
