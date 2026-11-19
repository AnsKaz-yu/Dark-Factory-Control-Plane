// Built-in adapter: Git (read-only CLI via whitelisted ctx.git helper).
import type { Adapter, AdapterContext, ProbeResult } from "./contract.ts"
import { adapterSource, snapshotKey } from "./contract.ts"
import { hashObject } from "../../core/src/ids.ts"

const ID = "git"

async function defaultBranch(ctx: AdapterContext): Promise<string | null> {
  for (const b of ["main", "master", "develop"]) {
    const r = await ctx.git(["rev-parse", "--verify", b])
    if (r.code === 0) return b
  }
  return null
}

export const gitAdapter: Adapter = {
  manifest: {
    id: ID, version: "1.0.0", kind: "builtin", title: "Git",
    description: "Branches, commits and task associations from the local Git repository (read-only).",
    contractVersion: 1, capabilities: ["git_monitoring"],
    compatibility: { core: ">=0.1.0" }, sourceStability: "official-api",
  },
  async probe(ctx): Promise<ProbeResult> {
    const r = await ctx.git(["rev-parse", "--is-inside-work-tree"])
    if (r.code !== 0) return { ok: false, confidence: "inferred", detail: "not a git repository", capabilities: { git_monitoring: { status: "unavailable", limitations: ["no .git found"] } } }
    const head = await ctx.git(["rev-parse", "HEAD"])
    return {
      ok: true, confidence: "verified", detail: `git repository verified (HEAD ${head.stdout.trim().slice(0, 8)})`,
      capabilities: { git_monitoring: { status: "supported", operations: ["read"], events: ["git.branches", "git.commits"], observableStates: ["branches", "commits", "task associations"] } },
    }
  },
  async collect(ctx) {
    const events = []
    const refs = await ctx.git(["for-each-ref", "refs/heads", "--format=%(refname:short)%09%(objectname)%09%(committerdate:iso8601)"])
    if (refs.code !== 0) return { events, notes: ["git for-each-ref failed: " + refs.stderr] }
    const def = await defaultBranch(ctx)
    const taskPattern = (ctx.config.taskBranchPattern as string) ?? "^(?:feature|fix|task)[/-](.+)$"
    const re = new RegExp(taskPattern)
    const branches = []
    for (const line of refs.stdout.split("\n").filter(Boolean)) {
      const [name, sha, date] = line.split("\t")
      let merged: boolean | undefined
      if (def && name !== def) {
        const m = await ctx.git(["merge-base", "--is-ancestor", name, def])
        merged = m.code === 0
      }
      const m = re.exec(name)
      branches.push({ name, headSha: sha, lastCommitAt: date, taskIds: m ? [m[1]] : [], merged })
    }
    events.push({
      type: "git.branches", schemaVersion: 1, payload: { branches },
      idempotencyKey: snapshotKey(ID, "branches", hashObject(branches)),
      source: adapterSource(ID),
    })
    const log = await ctx.git(["log", "-50", "--format=%H%x09%aI%x09%an%x09%s"])
    if (log.code === 0) {
      const commits = log.stdout.split("\n").filter(Boolean).map(line => {
        const [sha, at, author, message] = line.split("\t")
        const m = re.exec(message) ?? /(?:^|\s)(?:task|fix|feat)[/-]([A-Za-z0-9_-]+)/i.exec(message)
        return { sha, at, author, message, taskIds: m ? [m[1]] : [] }
      })
      events.push({
        type: "git.commits", schemaVersion: 1, payload: { commits },
        idempotencyKey: snapshotKey(ID, "commits", commits[0]?.sha ?? "empty"),
        source: adapterSource(ID),
      })
    }
    return { events }
  },
}
