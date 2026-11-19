// Built-in adapter: GitHub (PRs + Actions runs). Token via env var name only.
import type { Adapter, AdapterContext, ProbeResult, OutboundEvent } from "./contract.ts"
import { adapterSource } from "./contract.ts"
import { hashObject } from "../../core/src/ids.ts"
import type { RunStatus } from "../../core/src/types.ts"

const ID = "github"

export interface GitHubConfig {
  repo: string            // owner/name
  tokenEnv?: string       // default GITHUB_TOKEN
  apiBase?: string        // default https://api.github.com
}

function headers(cfg: GitHubConfig): Record<string, string> {
  const token = process.env[cfg.tokenEnv ?? "GITHUB_TOKEN"]
  const h: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "dfcp-adapter" }
  if (token) h.Authorization = `Bearer ${token}`
  return h
}

async function getJson(ctx: AdapterContext, cfg: GitHubConfig, path: string): Promise<unknown | null> {
  try {
    const res = await ctx.fetch(`${(cfg.apiBase ?? "https://api.github.com").replace(/\/$/, "")}${path}`, { headers: headers(cfg), signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    return await res.json()
  } catch { return null }
}

const RUN_STATUS: Record<string, RunStatus> = {
  queued: "pending", in_progress: "running", completed: "success", // conclusion refined below
  success: "success", failure: "failed", cancelled: "cancelled", skipped: "cancelled",
  timed_out: "failed", action_required: "failed", neutral: "success", stale: "cancelled",
}

export const githubAdapter: Adapter = {
  manifest: {
    id: ID, version: "1.0.0", kind: "builtin", title: "GitHub",
    description: "Pull requests and Actions runs via GitHub REST API. Token referenced by env var name; never stored.",
    contractVersion: 1, capabilities: ["ci_cd", "git_monitoring"],
    compatibility: { core: ">=0.1.0" }, sourceStability: "official-api",
  },
  async probe(ctx): Promise<ProbeResult> {
    const cfg = ctx.config as unknown as GitHubConfig
    if (!cfg?.repo) return { ok: false, confidence: "inferred", detail: "no repo configured", capabilities: { ci_cd: { status: "not_configured" } } }
    const repo = await getJson(ctx, cfg, `/repos/${cfg.repo}`)
    if (!repo) return { ok: false, confidence: "inferred", detail: `GitHub repo ${cfg.repo} unreachable (auth?)`, capabilities: { ci_cd: { status: "degraded", limitations: ["repo API unreachable"] }, git_monitoring: { status: "degraded", limitations: ["repo API unreachable"] } } }
    return {
      ok: true, confidence: "verified", detail: `GitHub repo ${cfg.repo} verified`,
      capabilities: {
        ci_cd: { status: "supported", observableStates: ["workflow runs", "jobs"], events: ["pipeline.run_started", "pipeline.run_completed"], details: { provider: "github-actions" } },
        git_monitoring: { status: "partial", limitations: ["PRs only; local branches come from the git adapter"], events: ["git.pr_updated"] },
      },
    }
  },
  async collect(ctx) {
    const cfg = ctx.config as unknown as GitHubConfig
    const events: OutboundEvent[] = []
    const prs = await getJson(ctx, cfg, `/repos/${cfg.repo}/pulls?state=all&per_page=30`) as Record<string, unknown>[] | null
    for (const pr of prs ?? []) {
      const head = pr.head as { ref?: string; label?: string }
      const base = pr.base as { ref?: string }
      const taskId = /^(?:feature|fix|task)[/-](.+)$/.exec(head?.ref ?? "")?.[1]
      events.push({
        type: "git.pr_updated", schemaVersion: 1,
        payload: {
          id: `gh-pr-${pr.number}`, title: String(pr.title ?? ""), state: pr.merged_at ? "merged" : pr.state === "open" ? "open" : "closed",
          sourceBranch: head?.ref ?? "", targetBranch: base?.ref ?? "", taskId, url: pr.html_url,
          checks: [],
        },
        idempotencyKey: `${ID}:pr:${pr.number}:${pr.updated_at}:${pr.merged_at ?? ""}`,
        source: adapterSource(ID, cfg.repo),
      })
    }
    const runs = await getJson(ctx, cfg, `/repos/${cfg.repo}/actions/runs?per_page=20`) as { workflow_runs?: Record<string, unknown>[] } | null
    for (const r of runs?.workflow_runs ?? []) {
      const status: RunStatus = r.status === "completed" ? RUN_STATUS[String(r.conclusion ?? "")] ?? "unknown" : RUN_STATUS[String(r.status)] ?? "unknown"
      const runId = `gh-run-${r.id}`
      const taskId = /^(?:feature|fix|task)[/-](.+)$/.exec(String(r.head_branch ?? ""))?.[1]
      const payload = {
        id: runId, pipelineId: `gh-workflow-${r.workflow_id}`, number: Number(r.run_number ?? 0),
        status, branch: r.head_branch, taskId, trigger: r.event,
        startedAt: r.run_started_at ?? r.created_at, finishedAt: r.updated_at,
        stages: [], error: status === "failed" ? `conclusion: ${r.conclusion}` : undefined,
      }
      events.push({
        type: status === "running" || status === "pending" ? "pipeline.run_started" : "pipeline.run_completed",
        schemaVersion: 1, payload,
        idempotencyKey: `${ID}:run:${r.id}:${status}:${r.updated_at}`,
        source: adapterSource(ID, cfg.repo),
      })
    }
    return { events }
  },
}
