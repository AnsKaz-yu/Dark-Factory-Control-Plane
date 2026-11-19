// Harness Fingerprint + Drift Detection.
// Economical: hash only harness-relevant files (never business code); full re-discovery
// runs only when fingerprints change or contract violations appear.
import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import type { DiscoveryReport, DriftChange, DriftReport, HarnessFingerprint } from "../../core/src/types.ts"
import { CORE_VERSION, EVENT_CONTRACT_VERSION } from "../../core/src/types.ts"
import { hashObject, nowISO, sha256 } from "../../core/src/ids.ts"
import type { ProjectStore } from "../../core/src/store.ts"
import { discover } from "./discover.ts"

const FINGERPRINT_ROLES = new Set([
  "opencode-config", "opencode", "agent-definition", "agent-registry", "skills", "commands",
  "task-tracker", "ci", "ci-endpoint", "merge-queue", "merge-queue-script", "workflow-script",
  "architecture", "event-feed", "git-strategy", "release-planning",
])

export function takeBaseline(store: ProjectStore, report: DiscoveryReport): HarnessFingerprint {
  const root = store.state.project?.root ?? report.root
  const files = []
  for (const e of report.evidences) {
    if (!FINGERPRINT_ROLES.has(e.kind)) continue
    if (e.path.endsWith("/")) continue
    const abs = join(root, e.path)
    if (!existsSync(abs)) continue
    try { if (statSync(abs).isDirectory()) continue } catch { continue }
    try { files.push({ path: e.path, sha256: sha256(readFileSync(abs)), role: e.kind }) } catch { /* unreadable */ }
  }
  const integ = store.getIntegration()
  const caps = store.getCapabilities()
  const fp: HarnessFingerprint = {
    projectId: store.id, takenAt: nowISO(), coreVersion: CORE_VERSION,
    pluginVersion: store.state.project?.pluginVersion,
    adapterVersions: Object.fromEntries(integ.adapters.map(a => [a.id, a.version])),
    files, components: report.detectedTools,
    agents: report.agentsFound.map(a => a.name),
    integrations: integ.adapters.map(a => a.id),
    capabilityManifestHash: hashObject(caps),
    eventContractVersion: EVENT_CONTRACT_VERSION,
    mappingVersions: Object.fromEntries(integ.mappings.map(m => [m.id, m.version])),
    workflowStages: report.workflowStagesFound,
    limitations: report.limitations,
  }
  store.setFingerprint(fp)
  return fp
}

/** Drift detection: bounded read-only re-scan of harness evidence + hash comparison.
 *  Economical by construction: depth/file-capped walk, no script execution, no network;
 *  invoked periodically/on-demand — never per ingested event. */
export function detectDrift(store: ProjectStore): DriftReport {
  const fp = store.getFingerprint()
  const root = store.state.project?.root ?? ""
  const at = nowISO()
  if (!fp) return { projectId: store.id, at, baselineAt: null, changes: [{ kind: "no_baseline", category: "B", evidence: "no integration baseline", impact: "integration not established", affectedCapabilities: [], suggestedAction: "run factory:setup" }], unchanged: false }

  const report = discover(store.id, root)
  // current harness-relevant inventory (same roles as baseline)
  const currentFiles = new Map<string, { sha: string | null; role: string }>()
  for (const e of report.evidences) {
    if (!FINGERPRINT_ROLES.has(e.kind) || e.path.endsWith("/")) continue
    const abs = join(root, e.path)
    if (!existsSync(abs)) { currentFiles.set(e.path, { sha: null, role: e.kind }); continue }
    try { if (statSync(abs).isDirectory()) continue } catch { continue }
    try { currentFiles.set(e.path, { sha: sha256(readFileSync(abs)), role: e.kind }) } catch { currentFiles.set(e.path, { sha: null, role: e.kind }) }
  }
  const changedFiles: { path: string; role: string; change: "modified" | "removed" | "added" }[] = []
  for (const f of fp.files) {
    const now = currentFiles.get(f.path)
    if (!now || now.sha === null) changedFiles.push({ path: f.path, role: f.role, change: "removed" })
    else if (now.sha !== f.sha256) changedFiles.push({ path: f.path, role: f.role, change: "modified" })
  }
  const baselinePaths = new Set(fp.files.map(f => f.path))
  for (const [path, cur] of currentFiles) {
    if (!baselinePaths.has(path)) changedFiles.push({ path, role: cur.role, change: "added" })
  }
  const violations = store.state.diagnostics.schemaViolations + store.state.diagnostics.unknownEvents
  const baselineViolations = fp.diagnosticsBaseline ?? 0
  const newViolations = violations > baselineViolations

  const prevAgents = new Set(fp.agents)
  const nowAgents = new Set(report.agentsFound.map(a => a.name))
  const prevStages = new Set(fp.workflowStages)
  const nowStages = new Set(report.workflowStagesFound)
  const prevTools = new Set(fp.components)
  const nowTools = new Set(report.detectedTools)

  if (!changedFiles.length && !newViolations &&
      prevAgents.size === nowAgents.size && [...prevAgents].every(a => nowAgents.has(a)) &&
      prevStages.size === nowStages.size && [...prevStages].every(s => nowStages.has(s)) &&
      prevTools.size === nowTools.size && [...prevTools].every(t => nowTools.has(t))) {
    return { projectId: store.id, at, baselineAt: fp.takenAt, changes: [], unchanged: true }
  }

  const changes: DriftChange[] = []
  for (const a of nowAgents) if (!prevAgents.has(a)) changes.push({ kind: "agent_added", category: "A", evidence: `agent definition ${a}`, impact: "new agent can be monitored", affectedCapabilities: ["agent_monitoring"], suggestedAction: "register agent in monitoring (automatic)" })
  for (const a of prevAgents) if (!nowAgents.has(a)) changes.push({ kind: "agent_removed", category: "B", evidence: `agent definition ${a} gone`, impact: "agent no longer defined; history preserved", affectedCapabilities: ["agent_monitoring"], suggestedAction: "mark agent stopped; keep history" })
  for (const s of nowStages) if (!prevStages.has(s)) changes.push({ kind: "workflow_stage_added", category: "B", evidence: `status/stage "${s}" appeared`, impact: "mapping must cover new stage", affectedCapabilities: ["workflow_stages", "task_management"], suggestedAction: "extend status mapping; preserve original value" })
  for (const s of prevStages) if (!nowStages.has(s)) changes.push({ kind: "workflow_stage_removed", category: "B", evidence: `status/stage "${s}" no longer observed`, impact: "mapping entry obsolete (kept for history)", affectedCapabilities: ["workflow_stages"], suggestedAction: "keep mapping for historical records" })
  for (const t of nowTools) if (!prevTools.has(t)) changes.push({ kind: "tool_added", category: "B", evidence: `tool/mechanism "${t}" appeared`, impact: "new integration source available", affectedCapabilities: [], suggestedAction: "select/generate adapter; verify capability" })
  for (const t of prevTools) if (!nowTools.has(t)) changes.push({ kind: "tool_removed", category: "C", evidence: `tool/mechanism "${t}" disappeared`, impact: "integration source gone; capability must degrade honestly", affectedCapabilities: [], suggestedAction: "re-probe; propose replacement source (approval required)" })

  for (const cf of changedFiles) {
    const affected: DriftChange["affectedCapabilities"] =
      cf.role === "task-tracker" || cf.role === "custom-task-format" ? ["task_management", "workflow_stages"] :
      cf.role.startsWith("ci") ? ["ci_cd"] :
      cf.role.startsWith("merge-queue") ? ["merge_queue"] :
      cf.role === "architecture" ? ["architecture_map"] :
      cf.role === "event-feed" ? ["activity_events", "agent_monitoring"] :
      cf.role.startsWith("agent") ? ["agent_monitoring"] :
      cf.role.startsWith("opencode") ? ["agent_monitoring"] : []
    if (cf.change === "removed") {
      changes.push({ kind: `${cf.role}_removed`, category: cf.role === "task-tracker" || cf.role.startsWith("ci") ? "C" : "B", evidence: `${cf.path} removed`, impact: "source of truth disappeared; history preserved, capability must degrade honestly", affectedCapabilities: affected, suggestedAction: "re-probe; mark capability unavailable/degraded; propose replacement source" })
    } else if (cf.change === "added") {
      if (cf.role === "agent-definition") continue // already captured via agents diff
      changes.push({ kind: `${cf.role}_added`, category: "B", evidence: `${cf.path} appeared`, impact: "new harness configuration/source", affectedCapabilities: affected, suggestedAction: "discover contracts; select/generate adapter; verify" })
    } else if (cf.role === "event-feed") {
      changes.push({ kind: "event_contract_changed", category: newViolations ? "C" : "B", evidence: `${cf.path} modified${newViolations ? " + schema violations observed" : ""}`, impact: "event schema may have changed", affectedCapabilities: affected, suggestedAction: "validate recent lines against contract; update mapping or escalate" })
    } else if (cf.role === "task-tracker") {
      const structural = changes.some(c => c.kind.startsWith("workflow_stage"))
      if (!structural) changes.push({ kind: "tracker_data_changed", category: "A", evidence: `${cf.path} content changed`, impact: "task data refresh", affectedCapabilities: affected, suggestedAction: "sync (automatic)" })
    } else {
      changes.push({ kind: `${cf.role}_changed`, category: "B", evidence: `${cf.path} modified`, impact: "harness configuration/contract changed", affectedCapabilities: affected, suggestedAction: "re-discover, re-probe adapters, update mappings" })
    }
  }
  if (newViolations && !changes.some(c => c.kind === "event_contract_changed")) {
    changes.push({ kind: "event_contract_violation", category: "B", evidence: `${violations - baselineViolations} new schema violations/unknown events`, impact: "adapter output no longer matches contract", affectedCapabilities: [], suggestedAction: "run factory:integration:diff and factory:reconcile" })
  }
  const seen = new Set<string>()
  const unique = changes.filter(c => { const k = c.kind + "|" + c.evidence; if (seen.has(k)) return false; seen.add(k); return true })
  return { projectId: store.id, at, baselineAt: fp.takenAt, changes: unique, unchanged: unique.length === 0 }
}
