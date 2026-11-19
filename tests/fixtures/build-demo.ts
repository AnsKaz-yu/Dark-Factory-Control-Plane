// Builds demo fixtures for the running product (inside tests/.runtime, gitignored).
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { buildFixture } from "./build.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
const base = join(HERE, "..", ".runtime", "demo")
buildFixture("alpha", join(base, "alpha"))
buildFixture("beta", join(base, "beta"))
console.log("demo fixtures ready:", base)
