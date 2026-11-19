// Dashboard build: strip TypeScript types via Node's built-in stripper (zero deps).
// Produces dist/{index.html, app.js, styles.css} served by the core.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { stripTypeScriptTypes } from "node:module"

const HERE = dirname(fileURLToPath(import.meta.url))
const dist = join(HERE, "dist")
mkdirSync(dist, { recursive: true })

const ts = readFileSync(join(HERE, "src", "app.ts"), "utf8")
const js = stripTypeScriptTypes(ts, { mode: "strip" })
writeFileSync(join(dist, "app.js"), js)
copyFileSync(join(HERE, "index.html"), join(dist, "index.html"))
copyFileSync(join(HERE, "src", "styles.css"), join(dist, "styles.css"))
console.log(`[dashboard] built → ${dist} (app.js ${js.length} bytes)`)
