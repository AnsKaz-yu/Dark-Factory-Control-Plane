// Built-in adapter: GitLab (pipelines + merge requests). Token via env var name only.
import type { Adapter, AdapterContext, ProbeResult, OutboundEvent } from "./contract.ts"
import { adapterSource } from "./contract.ts"
import type { RunStatus } from "../../core/src/types.ts"

const ID = "gitlab"

export interface GitLabConfig {
  project: string          // group/name or numeric id
  baseUrl?: string         // default https://gitlab.com
  tokenEnv?: string        // default GITLAB_TOKEN
}

function headers(cfg: GitLabConfig): Record<string, string> {
  const token = process.env[cfg.tokenEnv ?? "GITLAB_TOKEN"]
  return token ? { "PRIVATE-TOKEN": token } : {}
}

async function getJson(ctx: AdapterContext, cfg: GitLabConfig, path: string): Promise<unknown | null> {
  try {
    const base = (cfg.baseUrl ?? "https://gitlab.com").replace(/\/$/, "")
    const res = await ctx.fetch(`${base}/api/v4${path}`, { headers: headers(cfg), signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    return await res.json()
  } catch { return null }
}

const STATUS: Record<string, RunStatus> = {
  created: "pending", waiting_for_resource: "pending", preparing: "pending", pending: "pending",
  running: "running", success: "success", failed: "failed", canceled: "cancelled", skipped: "cancelled", manual: "pending", scheduled: "pending",
}

export const gitlabAdapter: Adapter = {
  manifest: {
    id: ID, version: "1.0.0", kind: "builtin", title: "GitLab",
    description: "Pipelines and merge requests via GitLab REST API v4. Token referenced by env var name.",
    contractVersion: 1, capabilities: ["ci_cd", "git_monitoring"],
    compatibility: { core: ">=0.1.0" }, sourceStability: "official-api",
  },
  async probe(ctx): Promise<ProbeResult> {
    const cfg = ctx.config as unknown as GitLabConfig
    if (!cfg?.project) return { ok: false, confidence: "inferred", detail: "no project configured", capabilities: { ci_cd: { status: "not_configured" } } }
    const pid = encodeURIComponent(cfg.project)
    const proj = await getJson(ctx, cfg, `/projects/${pid}`)
    if (!proj) return { ok: false, confidence: "inferred", detail: `GitLab project ${cfg.project} unreachable`, capabilities: { ci_cd: { status: "degraded", limitations: ["project API unreachable"] } } }
    return {
      ok: true, confidence: "verified", detail: `GitLab project verified`,
      capabilities: {
        ci_cd: { status: "supported", observableStates: ["pipelines", "jobs"], events: ["pipeline.run_started", "pipeline.run_completed"], details: { provider: "gitlab-ci" } },
        git_monitoring: { status: "partial", limitations: ["MRs only"], events: ["git.pr_updated"] },
      },
    }
  },
  async collect(ctx) {
    const cfg = ctx.config as unknown as GitLabConfig
    const pid = encodeURIComponent(cfg.project)
    const events: OutboundEvent[] = []
    const pipes = await getJson(ctx, cfg, `/projects/${pid}/pipelines?per_page=20`) as Record<string, unknown>[] | null
    for (const p of pipes ?? []) {
      const status = STATUS[String(p.status)] ?? "unknown"
      const runId = `gl-pipe-${p.id}`
      const taskId = /^(?:feature|fix|task)[/-](.+)$/.exec(String(p.ref ?? ""))?.[1]
      const payload = {
        id: runId, pipelineId: `gitlab/${cfg.project}`, number: Number(p.iid ?? p.id), status,
        branch: p.ref, taskId, startedAt: p.created_at, finishedAt: p.finished_at ?? p.updated_at, stages: [],
      }
      events.push({
        type: status === "running" || status === "pending" ? "pipeline.run_started" : "pipeline.run_completed",
        schemaVersion: 1, payload,
        idempotencyKey: `${ID}:pipe:${p.id}:${p.status}:${p.updated_at}`,
        source: adapterSource(ID, cfg.project),
      })
    }
    const mrs = await getJson(ctx, cfg, `/projects/${pid}/merge_requests?state=all&per_page=30`) as Record<string, unknown>[] | null
    for (const mr of mrs ?? []) {
      const taskId = /^(?:feature|fix|task)[/-](.+)$/.exec(String(mr.source_branch ?? ""))?.[1]
      events.push({
        type: "git.pr_updated", schemaVersion: 1,
        payload: {
          id: `gl-mr-${mr.iid}`, title: String(mr.title ?? ""),
          state: mr.state === "merged" ? "merged" : mr.state === "opened" ? "open" : "closed",
          sourceBranch: mr.source_branch, targetBranch: mr.target_branch, taskId, url: mr.web_url, checks: [],
        },
        idempotencyKey: `${ID}:mr:${mr.iid}:${mr.updated_at}:${mr.state}`,
        source: adapterSource(ID, cfg.project),
      })
    }
    return { events }
  },
}
