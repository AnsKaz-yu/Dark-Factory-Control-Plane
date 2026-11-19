// Adapter registry + context factory (restricted, read-only by default).
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { execFile, execFileSync } from "node:child_process"
import { join, resolve, isAbsolute } from "node:path"
import type { Adapter, AdapterContext } from "./contract.ts"
import { gitAdapter } from "./git.ts"
import { fileTaskTrackerAdapter } from "./file-task-tracker.ts"
import { mergeQueueFileAdapter } from "./merge-queue-file.ts"
import { likec4Adapter } from "./likec4.ts"
import { jenkinsAdapter } from "./jenkins.ts"
import { githubAdapter } from "./github.ts"
import { gitlabAdapter } from "./gitlab.ts"
import { genericEventsAdapter } from "./generic-events.ts"
import { opencodeAdapter } from "./opencode.ts"

export const BUILTIN_ADAPTERS: Record<string, Adapter> = {
  git: gitAdapter,
  "file-task-tracker": fileTaskTrackerAdapter,
  "merge-queue-file": mergeQueueFileAdapter,
  likec4: likec4Adapter,
  jenkins: jenkinsAdapter,
  github: githubAdapter,
  gitlab: gitlabAdapter,
  "generic-events": genericEventsAdapter,
  opencode: opencodeAdapter,
}

// Read-only git subcommands allowed for adapters (monitor tier). No shell involved.
const GIT_READONLY = new Set(["rev-parse", "for-each-ref", "log", "branch", "merge-base", "status", "show", "diff", "tag", "config", "ls-files", "remote"])
const GIT_DENY_FLAGS = ["--output", "--exec-path", "-c", "--git-dir", "--work-tree"]

function findGitBinary(): string {
  const candidates = ["git", "C:\\Program Files\\Git\\cmd\\git.exe", "/usr/bin/git"]
  for (const c of candidates) {
    try {
      execFileSync(c, ["--version"], { stdio: "ignore", windowsHide: true, timeout: 5000 })
      return c
    } catch { /* try next */ }
  }
  return "git"
}

let gitBinary: string | null = null

export function makeContext(opts: {
  projectId: string
  projectRoot: string
  integrationDir: string
  config?: Record<string, unknown>
  logger?: (msg: string) => void
}): AdapterContext {
  const root = resolve(opts.projectRoot)
  const confined = (p: string): string | null => {
    const abs = isAbsolute(p) ? resolve(p) : resolve(root, p)
    if (!abs.startsWith(root)) return null // adapters cannot read outside the project
    return abs
  }
  return {
    projectId: opts.projectId,
    projectRoot: root,
    integrationDir: opts.integrationDir,
    config: opts.config ?? {},
    logger: opts.logger ?? (() => {}),
    fetch: globalThis.fetch,
    readText(p) {
      const abs = confined(p)
      if (!abs || !existsSync(abs)) return null
      try { return readFileSync(abs, "utf8") } catch { return null }
    },
    exists(p) {
      const abs = confined(p)
      return abs !== null && existsSync(abs)
    },
    listDir(p) {
      const abs = confined(p)
      if (!abs) return []
      try { return readdirSync(abs) } catch { return [] }
    },
    git(args) {
      return new Promise(resolvePromise => {
        const sub = args[0]
        if (!GIT_READONLY.has(sub) || args.some(a => GIT_DENY_FLAGS.includes(a))) {
          resolvePromise({ code: 1, stdout: "", stderr: `git subcommand not allowed for adapters: ${sub}` })
          return
        }
        gitBinary ??= findGitBinary()
        execFile(gitBinary, ["-C", root, ...args], { encoding: "utf8", timeout: 15000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
          resolvePromise({ code: err ? (err as { code?: number }).code ?? 1 : 0, stdout: stdout ?? "", stderr: stderr ?? "" })
        })
      })
    },
  }
}

export * from "./contract.ts"
