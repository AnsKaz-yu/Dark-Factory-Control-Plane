// Harness Discovery — read-only, evidence-based investigation of a target project.
// Multiple evidence sources: configs, code content, scripts, docs, logs, file structure.
// NEVER executes project scripts. Never writes outside the integration directory.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import type { DiscoveryReport, Evidence, CapabilityId, CapabilityStatus } from "../../core/src/types.ts"
import { nowISO } from "../../core/src/ids.ts"

const SKIP_DIRS = new Set(["node_modules", ".git", "target", "dist", "build", ".next", "__pycache__", ".venv", "venv", ".cargo", "coverage", ".turbo"])
const MAX_DEPTH = 3
const MAX_FILES = 4000

interface ScanFile { rel: string; abs: string; size: number }

function walk(root: string, maxDepth = MAX_DEPTH): ScanFile[] {
  const out: ScanFile[] = []
  function rec(dir: string, depth: number): void {
    if (depth > maxDepth || out.length > MAX_FILES) return
    let entries: string[]
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      if (out.length > MAX_FILES) return
      if (name.startsWith(".") && name !== ".opencode" && name !== ".github" && name !== ".gitlab" && name !== ".dark-factory" && name !== ".git") continue
      const abs = join(dir, name)
      let st
      try { st = statSync(abs) } catch { continue }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue
        rec(abs, depth + 1)
      } else if (st.isFile() && st.size < 2 * 1024 * 1024) {
        out.push({ rel: relative(root, abs).replace(/\\/g, "/"), abs, size: st.size })
      }
    }
  }
  rec(root, 0)
  return out
}

function readSafe(abs: string, cap = 200000): string | null {
  try {
    const raw = readFileSync(abs, "utf8")
    return raw.length > cap ? raw.slice(0, cap) : raw
  } catch { return null }
}

function stripBom(t: string): string { return t.charCodeAt(0) === 0xfeff ? t.slice(1) : t }

function tryJson(t: string): unknown | null { try { return JSON.parse(stripBom(t)) } catch { return null } }

/** Detect task-like structure in a JSON document. */
function looksLikeTasks(doc: unknown): { count: number; statuses: string[]; fields: string[] } | null {
  let arr: unknown[] | null = null
  if (Array.isArray(doc)) arr = doc
  else if (doc && typeof doc === "object") {
    for (const v of Object.values(doc as Record<string, unknown>)) {
      if (Array.isArray(v) && v.length && typeof v[0] === "object" && v[0] !== null) { arr = v; break }
    }
    if (!arr) {
      const vals = Object.values(doc as Record<string, unknown>)
      if (vals.length >= 2 && vals.every(v => v && typeof v === "object")) arr = vals
    }
  }
  if (!arr || !arr.length) return null
  const sample = arr[0] as Record<string, unknown>
  const keys = Object.keys(sample).map(k => k.toLowerCase())
  const hasId = keys.some(k => ["id", "key", "taskid", "task_id"].includes(k))
  const hasTitle = keys.some(k => ["title", "name", "summary", "text"].includes(k))
  const statusKey = Object.keys(sample).find(k => ["status", "state", "stage"].includes(k.toLowerCase()))
  if (!(hasId && hasTitle) && !statusKey) return null
  const statuses = [...new Set(arr.map(t => String((t as Record<string, unknown>)[statusKey ?? "status"] ?? "")).filter(Boolean))]
  return { count: arr.length, statuses, fields: Object.keys(sample) }
}

export function discover(projectId: string, root: string): DiscoveryReport {
  const evidences: Evidence[] = []
  const detectedTools = new Set<string>()
  const suggested: DiscoveryReport["suggestedAdapters"] = []
  const capabilityDraft: DiscoveryReport["capabilityDraft"] = {}
  const agentsFound: DiscoveryReport["agentsFound"] = []
  const workflowStages = new Set<string>()
  const limitations: string[] = []
  const files = walk(root)
  const byName = new Map(files.map(f => [f.rel.toLowerCase(), f]))
  const has = (rel: string) => byName.has(rel.toLowerCase())
  const find = (re: RegExp) => files.filter(f => re.test(f.rel))

  const ev = (kind: string, path: string, confidence: Evidence["confidence"], snippet?: string, data?: Record<string, unknown>) => {
    evidences.push({ kind, path, confidence, snippet: snippet?.slice(0, 300), data })
  }

  // ---- 1. Git ----
  if (existsSync(join(root, ".git"))) {
    detectedTools.add("git")
    ev("git", ".git", "high", "git repository present")
    capabilityDraft.git_monitoring = { status: "unknown", source: "git", notes: "probe required" }
    suggested.push({ adapterId: "git", reason: ".git directory present" })
    // branch strategy evidence from refs
    const heads = join(root, ".git", "refs", "heads")
    if (existsSync(heads)) {
      const branches: string[] = []
      const rec = (d: string, prefix: string) => {
        for (const n of readdirSync(d)) {
          const p = join(d, n)
          if (statSync(p).isDirectory()) rec(p, prefix + n + "/")
          else branches.push(prefix + n)
        }
      }
      try { rec(heads, ""); ev("git-strategy", ".git/refs/heads", "medium", branches.slice(0, 20).join(", "), { branches }) } catch { /* ignore */ }
    }
    const tags = join(root, ".git", "refs", "tags")
    if (existsSync(tags)) {
      try {
        const t = readdirSync(tags)
        if (t.length) { ev("releases", ".git/refs/tags", "medium", t.slice(0, 10).join(", "), { tags: t }); capabilityDraft.release_planning = { status: "unknown", source: "git-tags", notes: "tags exist; release mechanism to verify" } }
      } catch { /* ignore */ }
    }
  }

  // ---- 2. OpenCode configuration ----
  const ocConfig = ["opencode.json", "opencode.jsonc", ".opencode/opencode.json", ".opencode/opencode.jsonc"].find(has)
  if (ocConfig || existsSync(join(root, ".opencode"))) {
    detectedTools.add("opencode")
    ev("opencode", ocConfig ?? ".opencode/", "high", "OpenCode configuration present")
    suggested.push({ adapterId: "opencode", reason: "OpenCode config/directory present", config: {} })
    capabilityDraft.agent_monitoring = { status: "not_configured", source: "opencode", notes: "plugin connection required to verify" }
    if (ocConfig) {
      const doc = tryJson(readSafe(byName.get(ocConfig.toLowerCase())!.abs) ?? "") as Record<string, unknown> | null
      if (doc) ev("opencode-config", ocConfig, "high", undefined, { plugins: doc.plugins ?? doc.plugin, mcp: Object.keys((doc.mcp as object) ?? {}) })
    }
  }

  // ---- 3. Agent definitions (OpenCode + custom registries) ----
  const agentFiles = find(/(^|\/)(\.opencode\/agent|agent|agents)\/[^/]+\.(md|json)$/i)
  for (const f of agentFiles.slice(0, 50)) {
    const text = readSafe(f.abs) ?? ""
    const name = f.rel.split("/").pop()!.replace(/\.(md|json)$/, "")
    const role = /description:\s*(.+)/.exec(text)?.[1]?.trim()
    agentsFound.push({ name, path: f.rel, role })
    ev("agent-definition", f.rel, "high", role)
  }
  // custom agent registries: JSON with status/lastSeen/task fields (name-based AND content-based)
  const registryCandidates = [
    ...find(/(agents?|workers?|runners?|crew|team)(-registry|-state|\.lock)?\.json$/i),
    ...files.filter(f => f.rel.endsWith(".json") && f.rel.split("/").length <= 2 && !/(package|tsconfig|composer|manifest|model|opencode|project|task|backlog|queue|seed|settings|config)/i.test(f.rel)),
  ]
  const registrySeen = new Set<string>()
  for (const f of registryCandidates.slice(0, 40)) {
    if (registrySeen.has(f.rel)) continue
    registrySeen.add(f.rel)
    const doc = tryJson(readSafe(f.abs) ?? "")
    if (doc && typeof doc === "object" && !Array.isArray(doc)) {
      const vals = Object.values(doc as Record<string, unknown>)
      const registryLike = vals.length > 0 && vals.every(v => v && typeof v === "object" && ("status" in (v as object) || "lastSeen" in (v as object) || "task" in (v as object)))
      if (registryLike) {
        detectedTools.add("custom-agent-registry")
        ev("agent-registry", f.rel, "high", `${vals.length} agent entries`, { count: vals.length })
        for (const [k, v] of Object.entries(doc as Record<string, Record<string, unknown>>)) {
          if (!agentsFound.some(a => a.name === k)) agentsFound.push({ name: k, path: f.rel, role: String(v.role ?? v.note ?? "") })
        }
        suggested.push({ adapterId: `generated:${f.rel.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}`, reason: `custom agent registry ${f.rel}`, config: { kind: "agent-registry", path: f.rel } })
        capabilityDraft.agent_monitoring = { status: "unknown", source: f.rel, notes: "registry readable; generated adapter + probe required" }
      }
    }
  }

  // ---- 4. Skills / commands ----
  const skillFiles = find(/(^|\/)(\.opencode\/skills|skills)\/[^/]+\/SKILL\.md$/i)
  if (skillFiles.length) { detectedTools.add("opencode-skills"); ev("skills", skillFiles[0].rel, "high", `${skillFiles.length} skills`) }
  const commandFiles = find(/(^|\/)(\.opencode\/command|commands|\.opencode\/commands)\/[^/]+\.(md|ts|js)$/i)
  if (commandFiles.length) ev("commands", commandFiles[0].rel, "medium", `${commandFiles.length} command definitions`)

  // ---- 5. Task trackers (structure + content based) ----
  const trackerCandidates = [
    ...find(/(^|\/)(tasks?|backlog|task-state|project-state|todo|roadmap)([-_.].*)?\.(json|jsonl|md)$/i),
    ...find(/(^|\/)\.taskmaster\/.*\.json$/i),
    ...find(/(^|\/)docs\/.*tasks?\.md$/i),
  ]
  let bestTracker: { f: ScanFile; info: { count: number; statuses: string[]; fields: string[] }; format: string } | null = null
  for (const f of trackerCandidates.slice(0, 30)) {
    const text = readSafe(f.abs)
    if (!text) continue
    if (f.rel.endsWith(".md")) {
      const items = (text.match(/^\s*[-*]\s+\[[ xX]\]/gm) ?? []).length
      if (items >= 2) {
        ev("task-tracker", f.rel, "medium", `${items} markdown checklist items`)
        if (!bestTracker) bestTracker = { f, info: { count: items, statuses: ["ready", "done"], fields: ["id", "title", "status"] }, format: "markdown" }
      }
      continue
    }
    const doc = tryJson(text)
    const info = looksLikeTasks(doc)
    if (info && info.count >= 1) {
      ev("task-tracker", f.rel, "high", `${info.count} task-like records; statuses: ${info.statuses.slice(0, 12).join(", ")}`, { fields: info.fields, statuses: info.statuses })
      info.statuses.forEach(s => workflowStages.add(s))
      if (!bestTracker || info.count > bestTracker.info.count) bestTracker = { f, info, format: f.rel.endsWith(".jsonl") ? "jsonl" : "json" }
    }
  }
  if (bestTracker) {
    detectedTools.add("file-task-tracker")
    suggested.push({
      adapterId: "file-task-tracker",
      reason: `task-like records in ${bestTracker.f.rel}`,
      config: { path: bestTracker.f.rel, format: bestTracker.format },
    })
    capabilityDraft.task_management = { status: "unknown", source: bestTracker.f.rel, notes: "probe required" }
    capabilityDraft.task_hierarchy = { status: "unknown", source: bestTracker.f.rel, notes: "depends on parent field" }
    capabilityDraft.workflow_stages = { status: "unknown", source: bestTracker.f.rel, notes: `observed statuses: ${[...workflowStages].join(", ")}` }
    capabilityDraft.critical_path = { status: "unknown", source: bestTracker.f.rel, notes: "depends on dependency/estimate fields" }
  } else {
    // content-based: unrecognized structured task formats (e.g. pipe-delimited custom files)
    let customFound = false
    for (const f of files.filter(x => /\.(pipe|txt|csv|tsv)$/i.test(x.rel) && x.rel.split("/").length <= 2).slice(0, 30)) {
      const text = readSafe(f.abs, 40000)
      if (!text) continue
      const lines = text.split("\n").filter(l => l.trim() && !l.startsWith("#"))
      const pipeLines = lines.filter(l => l.split("|").length >= 3)
      if (lines.length >= 2 && pipeLines.length / lines.length > 0.7) {
        const statuses = [...new Set(pipeLines.map(l => l.split("|")[2]?.trim()).filter(Boolean))]
        detectedTools.add("custom-task-format")
        ev("custom-task-format", f.rel, "medium", `${pipeLines.length} pipe-delimited records; statuses: ${statuses.slice(0, 10).join(", ")}`, { statuses })
        statuses.forEach(s => workflowStages.add(s))
        suggested.push({
          adapterId: `generated:${f.rel.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}`,
          reason: `custom task format in ${f.rel} — adapter generation required`,
          config: { kind: "task-lines", path: f.rel },
        })
        capabilityDraft.task_management = { status: "unknown", source: f.rel, notes: "custom format; generated adapter + probe required" }
        capabilityDraft.workflow_stages = { status: "unknown", source: f.rel, notes: `observed statuses: ${statuses.join(", ")}` }
        customFound = true
        break
      }
    }
    if (!customFound) {
      capabilityDraft.task_management = { status: "unavailable", notes: "no task tracker detected" }
      limitations.push("No task tracker detected — task views will be unavailable until a source is connected.")
    }
  }

  // ---- 6. CI/CD ----
  const ghWorkflows = find(/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i)
  if (ghWorkflows.length) {
    detectedTools.add("github-actions")
    ev("ci", ghWorkflows[0].rel, "high", `${ghWorkflows.length} GitHub Actions workflows`)
    capabilityDraft.ci_cd = { status: "unknown", source: "github-actions", notes: "remote repo config required" }
  }
  if (has(".gitlab-ci.yml")) {
    detectedTools.add("gitlab-ci")
    ev("ci", ".gitlab-ci.yml", "high", "GitLab CI config")
    capabilityDraft.ci_cd = { status: "unknown", source: "gitlab-ci" }
  }
  const jenkinsfiles = find(/(^|\/)Jenkinsfile[^/]*$/i)
  if (jenkinsfiles.length) {
    detectedTools.add("jenkins")
    ev("ci", jenkinsfiles[0].rel, "high", "Jenkinsfile present")
    capabilityDraft.ci_cd = { status: "unknown", source: "jenkins", notes: "Jenkins URL config required" }
  }
  // content-based CI detection in scripts/configs
  for (const f of find(/(^|\/)(scripts?|ci|\.github|\.gitlab)\/.*\.(ps1|sh|py|mjs|js|ts|ya?ml|json)$/i).slice(0, 60)) {
    const text = readSafe(f.abs, 60000)
    if (!text) continue
    const m = /(https?:\/\/[^\s"']*jenkins[^\s"']*|localhost:8080|ci\.[a-z0-9.-]+)/i.exec(text)
    if (m && !detectedTools.has("jenkins")) {
      detectedTools.add("jenkins")
      ev("ci-endpoint", f.rel, "medium", m[0])
      suggested.push({ adapterId: "jenkins", reason: `Jenkins endpoint referenced in ${f.rel}`, config: { url: m[0].startsWith("http") ? m[0] : `http://${m[0]}` } })
      capabilityDraft.ci_cd = { status: "unknown", source: "jenkins", notes: `endpoint ${m[0]} — probe required` }
    }
  }
  if (!capabilityDraft.ci_cd) { capabilityDraft.ci_cd = { status: "unavailable", notes: "no CI/CD mechanism detected" }; limitations.push("No CI/CD detected — pipeline views unavailable.") }

  // ---- 7. Merge queue ----
  const queueFiles = find(/merge[-_]?queue.*\.json$/i)
  for (const f of queueFiles.slice(0, 5)) {
    const doc = tryJson(readSafe(f.abs) ?? "") as Record<string, unknown> | null
    const items = doc && Array.isArray(doc.items) ? doc.items : Array.isArray(doc) ? doc : null
    if (items) {
      detectedTools.add("custom-merge-queue")
      ev("merge-queue", f.rel, "high", `${items.length} queue entries`)
      suggested.push({ adapterId: "merge-queue-file", reason: `queue state file ${f.rel}`, config: { path: f.rel, itemsPath: Array.isArray(doc) ? undefined : "items" } })
      capabilityDraft.merge_queue = { status: "unknown", source: f.rel, notes: "probe required" }
      break
    }
  }
  if (!capabilityDraft.merge_queue) {
    // content-based: scripts mentioning merge queue mechanics
    const mqScripts = find(/merge[-_]?queue.*\.(ps1|sh|py|mjs|js|ts)$/i)
    if (mqScripts.length) {
      ev("merge-queue-script", mqScripts[0].rel, "medium", "merge queue script present; state file not found")
      capabilityDraft.merge_queue = { status: "not_configured", source: mqScripts[0].rel, notes: "mechanism exists but no readable state file" }
      limitations.push("Merge queue script found but no state file — monitoring not configured.")
    } else {
      capabilityDraft.merge_queue = { status: "unavailable", notes: "no merge queue mechanism detected" }
    }
  }

  // ---- 8. Release planning ----
  const releaseFiles = find(/(^|\/)(RELEASE[-_.]?PLAN|RELEASES?|CHANGELOG|release[-_]?plan)[^/]*\.(md|json|ya?ml)$/i)
  if (releaseFiles.length) {
    ev("release-planning", releaseFiles[0].rel, "medium", "release planning artifact")
    if (!capabilityDraft.release_planning) capabilityDraft.release_planning = { status: "unknown", source: releaseFiles[0].rel, notes: "artifact found; scope extraction to verify" }
  }
  if (!capabilityDraft.release_planning) capabilityDraft.release_planning = { status: "unavailable", notes: "no release planning artifacts" }

  // ---- 9. Architecture sources ----
  const c4Files = find(/\.(c4|likec4)$/i)
  const modelFiles = find(/(^|\/)(architecture\/dist\/|dist\/)?model\.json$/i)
  if (c4Files.length || modelFiles.length) {
    detectedTools.add("likec4")
    const mf = modelFiles[0]
    if (mf) {
      const doc = tryJson(readSafe(mf.abs) ?? "") as Record<string, unknown> | null
      if (doc && (doc.views || doc.elements)) {
        ev("architecture", mf.rel, "high", "LikeC4 model export with views/elements")
        suggested.push({ adapterId: "likec4", reason: `model export ${mf.rel}`, config: { modelPath: mf.rel } })
        capabilityDraft.architecture_map = { status: "unknown", source: mf.rel, notes: "probe required" }
      }
    } else {
      ev("architecture", c4Files[0].rel, "medium", "LikeC4 DSL sources; export required (likec4 build)")
      capabilityDraft.architecture_map = { status: "not_configured", source: c4Files[0].rel, notes: "DSL present, model export missing" }
    }
  }
  if (!capabilityDraft.architecture_map) capabilityDraft.architecture_map = { status: "unavailable", notes: "no architecture source" }

  // ---- 10. Event / log sources ----
  const eventFiles = find(/(^|\/)(events?|telemetry|activity)[^/]*\.jsonl$/i)
  for (const f of eventFiles.slice(0, 5)) {
    const text = readSafe(f.abs, 20000)
    if (!text) continue
    const firstLine = text.split("\n").find(l => l.trim())
    if (firstLine) {
      ev("event-feed", f.rel, "medium", firstLine.slice(0, 120))
      if (!suggested.some(s => s.adapterId === "generic-events" && (s.config as Record<string, unknown>)?.path === f.rel)) {
        suggested.push({ adapterId: "generic-events", reason: `event feed ${f.rel}`, config: { path: f.rel } })
      }
    }
  }
  capabilityDraft.activity_events = { status: "supported", source: "core", notes: "core event log is always available" }
  capabilityDraft.metrics = { status: bestTracker || agentsFound.length ? "unknown" : "unavailable", notes: "computed from available task/agent data" }

  // ---- 11. Workflow scripts (content-based stage evidence) ----
  const wfScripts = find(/(^|\/)(scripts?|workflow|dmtools)\/.*\.(ps1|sh|py|mjs|js|ts)$/i).slice(0, 40)
  for (const f of wfScripts) {
    const text = readSafe(f.abs, 80000)
    if (!text) continue
    const stageMatches = text.match(/(?:loopStage|stage|status)\s*(?:===?|==|in|:)\s*["']([a-z-]+)["']/gi) ?? []
    if (stageMatches.length >= 3) {
      ev("workflow-script", f.rel, "medium", `${stageMatches.length} stage references`)
      for (const m of stageMatches) {
        const s = /["']([a-z-]+)["']/i.exec(m)?.[1]
        if (s) workflowStages.add(s)
      }
    }
  }

  if (!agentsFound.length && !detectedTools.has("opencode")) limitations.push("No agent definitions found — agent monitoring limited until a source is connected.")
  if (!capabilityDraft.agent_monitoring) capabilityDraft.agent_monitoring = { status: "unavailable", notes: "no agent source detected" }

  return {
    projectId, root, at: nowISO(), evidences,
    detectedTools: [...detectedTools], suggestedAdapters: suggested,
    capabilityDraft, agentsFound, workflowStagesFound: [...workflowStages], limitations,
  }
}
