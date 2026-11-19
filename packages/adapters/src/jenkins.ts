// Built-in adapter: Jenkins CI (REST API; token referenced by env var name, never stored).
import type { Adapter, AdapterContext, ProbeResult, OutboundEvent } from "./contract.ts"
import { adapterSource, snapshotKey } from "./contract.ts"
import { hashObject } from "../../core/src/ids.ts"
import type { RunStatus } from "../../core/src/types.ts"

const ID = "jenkins"

export interface JenkinsConfig {
  url: string                 // e.g. http://127.0.0.1:8080
  jobs?: string[]             // limit to specific jobs; default: all
  tokenEnv?: string           // env var holding API token (optional)
  userEnv?: string            // env var holding user (optional)
}

function authHeaders(cfg: JenkinsConfig): Record<string, string> {
  const token = cfg.tokenEnv ? process.env[cfg.tokenEnv] : undefined
  const user = cfg.userEnv ? process.env[cfg.userEnv] : undefined
  if (token && user) return { Authorization: "Basic " + Buffer.from(`${user}:${token}`).toString("base64") }
  return {}
}

const STATUS_MAP: Record<string, RunStatus> = {
  SUCCESS: "success", FAILURE: "failed", UNSTABLE: "failed", ABORTED: "cancelled",
  NOT_BUILT: "pending", IN_PROGRESS: "running", PENDING: "pending",
}

async function getJson(ctx: AdapterContext, cfg: JenkinsConfig, path: string): Promise<unknown | null> {
  try {
    const res = await ctx.fetch(`${cfg.url.replace(/\/$/, "")}${path}`, { headers: authHeaders(cfg), signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    return await res.json()
  } catch { return null }
}

export const jenkinsAdapter: Adapter = {
  manifest: {
    id: ID, version: "1.0.0", kind: "builtin", title: "Jenkins",
    description: "Pipelines/runs/stages from Jenkins REST API (+ wfapi when available). Credentials via env vars only.",
    contractVersion: 1, capabilities: ["ci_cd"],
    compatibility: { core: ">=0.1.0" }, sourceStability: "official-api",
  },
  async probe(ctx): Promise<ProbeResult> {
    const cfg = ctx.config as unknown as JenkinsConfig
    if (!cfg?.url) return { ok: false, confidence: "inferred", detail: "no url configured", capabilities: { ci_cd: { status: "not_configured" } } }
    const root = await getJson(ctx, cfg, "/api/json?tree=jobs[name,url,color]")
    if (!root) return { ok: false, confidence: "inferred", detail: `Jenkins API unreachable at ${cfg.url}`, capabilities: { ci_cd: { status: "degraded", limitations: ["API unreachable"] } } }
    const jobs = (root as { jobs?: unknown[] }).jobs ?? []
    return {
      ok: true, confidence: "verified", detail: `Jenkins API verified (${jobs.length} jobs)`,
      capabilities: { ci_cd: { status: "supported", observableStates: ["pipelines", "runs", "stages (wfapi)", "jobs"], events: ["pipeline.registered", "pipeline.run_started", "pipeline.run_completed"], details: { provider: "jenkins", jobCount: jobs.length } } },
    }
  },
  async collect(ctx) {
    const cfg = ctx.config as unknown as JenkinsConfig
    const events: OutboundEvent[] = []
    const root = await getJson(ctx, cfg, "/api/json?tree=jobs[name,url,color,lastBuild[number]]") as { jobs?: { name: string; url: string }[] } | null
    if (!root?.jobs) return { events, notes: ["jenkins unreachable during collect"] }
    const jobs = cfg.jobs?.length ? root.jobs.filter(j => cfg.jobs!.includes(j.name)) : root.jobs
    for (const job of jobs) {
      events.push({ type: "pipeline.registered", schemaVersion: 1, payload: { id: `jenkins/${job.name}`, name: job.name, provider: "jenkins" }, idempotencyKey: `${ID}:pipeline:${job.name}`, source: adapterSource(ID, cfg.url) })
      const builds = await getJson(ctx, cfg, `/job/${encodeURIComponent(job.name)}/api/json?tree=builds[number,url,result,timestamp,duration,building,actions[causes[shortDescription]]]{0,15}`) as { builds?: Record<string, unknown>[] } | null
      for (const b of builds?.builds ?? []) {
        const runId = `jenkins/${job.name}#${b.number}`
        const status: RunStatus = b.building ? "running" : STATUS_MAP[String(b.result ?? "")] ?? "unknown"
        const startedAt = b.timestamp ? new Date(Number(b.timestamp)).toISOString() : undefined
        const finishedAt = !b.building && b.timestamp && b.duration ? new Date(Number(b.timestamp) + Number(b.duration)).toISOString() : undefined
        // stages via workflow API (best effort)
        let stages: { name: string; status: RunStatus; jobs: [] }[] = []
        const wf = await getJson(ctx, cfg, `/job/${encodeURIComponent(job.name)}/${b.number}/wfapi/describe`) as { stages?: { name: string; status: string }[] } | null
        if (wf?.stages) stages = wf.stages.map(s => ({ name: s.name, status: STATUS_MAP[s.status] ?? "unknown", jobs: [] }))
        const cause = ((b.actions as { causes?: { shortDescription?: string }[] }[] | undefined)?.find(a => a.causes)?.causes?.[0]?.shortDescription)
        const branch = /branch\s+([^\s,]+)/i.exec(cause ?? "")?.[1]
        const payload = {
          id: runId, pipelineId: `jenkins/${job.name}`, number: Number(b.number), status,
          startedAt, finishedAt, stages, trigger: cause, branch,
          taskId: branch ? (/^(?:feature|fix|task)[/-](.+)$/.exec(branch)?.[1]) : undefined,
        }
        events.push({
          type: status === "running" || status === "pending" ? "pipeline.run_started" : "pipeline.run_completed",
          schemaVersion: 1, payload,
          idempotencyKey: `${ID}:run:${runId}:${status}:${hashObject(stages)}`,
          source: adapterSource(ID, cfg.url),
        })
      }
    }
    return { events }
  },
}
