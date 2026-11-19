// DFCP Core — single source of truth for all domain DTOs and contracts.
// Every boundary (API, adapters, plugin, dashboard) validates against these shapes.
// Erasable TypeScript only (Node native type stripping): no enums/namespaces.

export const CORE_VERSION = "0.1.0"
export const EVENT_CONTRACT_VERSION = 1
export const CAPABILITY_CONTRACT_VERSION = 1
export const ADAPTER_CONTRACT_VERSION = 1

// ---------- shared ----------

export type ISO = string

export interface SourceRef {
  adapterId: string
  sourceId: string
  entityKind: string
  authoritative: boolean
  fetchedAt: ISO
}

export type DataNature = "real" | "computed" | "estimated" | "missing"

export interface Freshness {
  lastSyncAt: ISO | null
  lastSuccessAt: ISO | null
  stale: boolean
  degraded: boolean
  error?: string
}

// ---------- project ----------

export interface Project {
  id: string
  name: string
  root: string
  registeredAt: ISO
  coreVersion: string
  pluginVersion?: string
  description?: string
}

// ---------- tasks ----------

export const TASK_KINDS = ["epic", "feature", "task", "subtask"] as const
export type TaskKind = (typeof TASK_KINDS)[number]

export const TASK_STATUSES = [
  "backlog", "planning", "ready", "in_progress", "review", "verification",
  "blocked", "merged", "done", "cancelled", "unknown",
] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export const PRIORITIES = ["P0", "P1", "P2", "P3"] as const
export type Priority = (typeof PRIORITIES)[number]

export interface AcceptanceCriterion { id: string; text: string; done: boolean }

export interface TaskMapping {
  ruleSetId: string
  ruleSetVersion: number
  confidence: "exact" | "high" | "medium" | "low" | "unmapped"
  original: Record<string, unknown>
}

export interface TaskLinks {
  branches: string[]
  pullRequests: string[]
  pipelineRunIds: string[]
  releaseId?: string
}

export interface TaskHistoryEntry {
  at: ISO
  eventId: string
  field: string
  from: unknown
  to: unknown
  actor?: string
}

export interface Task {
  id: string
  projectId: string
  title: string
  description?: string
  kind: TaskKind
  parentId?: string
  status: TaskStatus
  sourceStatus?: string
  priority: Priority
  assignee?: string
  componentId?: string
  dependencies: string[]
  acceptanceCriteria: AcceptanceCriterion[]
  progress?: number
  estimateHours?: number
  estimateConfidence?: "high" | "medium" | "low"
  labels: string[]
  source: SourceRef
  mapping: TaskMapping
  links: TaskLinks
  createdAt: ISO
  updatedAt: ISO
  history: TaskHistoryEntry[]
}

export interface TaskTreeNode {
  task: Task
  children: TaskTreeNode[]
  rollup: { total: number; done: number; inProgress: number; blocked: number; progress: number }
}

// ---------- agents ----------

export const AGENT_STATUSES = [
  "working", "waiting", "blocked", "reviewing", "completed", "failed", "stopped", "unknown",
] as const
export type AgentStatus = (typeof AGENT_STATUSES)[number]

export type AgentKind = "opencode" | "harness" | "human" | "unknown"
export type StatusEvidence = "event" | "heartbeat" | "inferred"

export interface AgentError { at: ISO; message: string; taskId?: string }

export interface Agent {
  id: string
  projectId: string
  name: string
  role?: string
  kind: AgentKind
  status: AgentStatus
  statusEvidence: StatusEvidence
  currentTaskId?: string
  sessionId?: string
  model?: string
  startedAt?: ISO
  lastEventAt?: ISO
  lastHeartbeatAt?: ISO
  errors: AgentError[]
  source: SourceRef
}

export interface AgentSession {
  id: string
  projectId: string
  agentId: string
  opencodeSessionId?: string
  title?: string
  model?: string
  startedAt: ISO
  endedAt?: ISO
  taskIds: string[]
}

// ---------- components / architecture ----------

export interface Component {
  id: string
  projectId: string
  name: string
  parentId?: string
  kind: string
  status: "planned" | "in_progress" | "done" | "blocked" | "unknown"
  readiness?: number
  doc?: string
  source: SourceRef
  metrics?: { coverage?: number; testsPassed?: number; testsFailed?: number; testsTotal?: number; crap?: number }
}

export interface ArchitectureMap {
  available: boolean
  source?: string
  elements: { id: string; title: string; kind?: string; technology?: string }[]
  relations: { source: string; target: string; label?: string }[]
  views: { id: string; title: string; nodes: string[]; edges: { source: string; target: string; label?: string }[] }[]
  message?: string
}

// ---------- git ----------

export interface Branch {
  name: string
  headSha?: string
  lastCommitAt?: ISO
  taskIds: string[]
  merged?: boolean
  source: SourceRef
}

export interface Commit {
  sha: string
  branch?: string
  message: string
  author?: string
  at: ISO
  taskIds: string[]
}

export interface PullRequest {
  id: string
  title: string
  state: "open" | "merged" | "closed"
  sourceBranch: string
  targetBranch: string
  taskId?: string
  url?: string
  checks: { name: string; status: string }[]
  updatedAt: ISO
  source: SourceRef
}

// ---------- CI/CD ----------

export type RunStatus = "pending" | "running" | "success" | "failed" | "cancelled" | "unknown"

export interface Pipeline { id: string; name: string; provider: string; source: SourceRef }

export interface PipelineJob { name: string; status: RunStatus; startedAt?: ISO; finishedAt?: ISO; log?: string }

export interface PipelineStage {
  name: string
  status: RunStatus
  jobs: PipelineJob[]
  startedAt?: ISO
  finishedAt?: ISO
}

export interface PipelineRun {
  id: string
  pipelineId: string
  number: number
  status: RunStatus
  branch?: string
  taskId?: string
  trigger?: string
  startedAt?: ISO
  finishedAt?: ISO
  stages: PipelineStage[]
  retries: number
  artifacts: { name: string; url?: string }[]
  error?: string
  source: SourceRef
}

// ---------- merge queue ----------

export const MERGE_ENTRY_STATES = [
  "waiting", "checking", "ready", "merging", "merged", "conflict", "dead_letter", "failed",
] as const
export type MergeEntryState = (typeof MERGE_ENTRY_STATES)[number]

export interface MergeQueueEntry {
  id: string
  position: number
  branch: string
  taskId?: string
  agent?: string
  state: MergeEntryState
  checks: { name: string; status: string }[]
  enqueuedAt: ISO
  updatedAt: ISO
  waitMs?: number
  reason?: string
  source: SourceRef
}

export interface MergeQueue {
  id: string
  entries: MergeQueueEntry[]
  inFlight?: string
  source: SourceRef
}

// ---------- workflow ----------

export interface WorkflowStage {
  id: string
  label: string
  observed: boolean
  taskCount: number
}

export interface WorkflowTransition { from: string; to: string; count: number; lastAt?: ISO }

export interface WorkflowView {
  stages: WorkflowStage[]
  transitions: WorkflowTransition[]
  observableStages: string[]
  limitations: string[]
}

// ---------- releases ----------

export type ReleaseStatus = "planning" | "in_progress" | "ready" | "released" | "cancelled"

export interface Release {
  id: string
  projectId: string
  name: string
  tag?: string
  scopeTaskIds: string[]
  status: ReleaseStatus
  targetDate?: ISO
  createdAt: ISO
  updatedAt: ISO
  releasedAt?: ISO
  notes?: string
  source: SourceRef
}

export interface ReleaseReadiness {
  releaseId: string
  verdict: "ready" | "not_ready" | "insufficient_data"
  nature: DataNature
  tasks: { total: number; done: number; blocked: number; inProgress: number }
  blockers: { taskId: string; reason: string }[]
  checks: { name: string; ok: boolean; evidence: string }[]
  coverage: string[]
}

// ---------- critical path ----------

export interface CriticalPathResult {
  nature: DataNature
  path: string[]
  lengthHours?: number
  layers: { taskId: string; layer: number }[]
  edges: { from: string; to: string }[]
  notes: string[]
  cycles: string[][]
}

// ---------- metrics ----------

export interface MetricSnapshot {
  at: ISO
  metrics: Record<string, number | null>
  coverage: Record<string, string>
}

// ---------- capabilities ----------

export const CAPABILITY_IDS = [
  "task_management", "task_hierarchy", "agent_monitoring", "workflow_stages",
  "git_monitoring", "ci_cd", "merge_queue", "release_planning", "critical_path",
  "architecture_map", "activity_events", "metrics",
] as const
export type CapabilityId = (typeof CAPABILITY_IDS)[number]

export const CAPABILITY_STATUSES = [
  "supported", "partial", "not_configured", "unavailable", "stale", "degraded", "unknown",
] as const
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number]

export interface Capability {
  id: CapabilityId
  status: CapabilityStatus
  source?: string
  adapterId?: string
  operations: string[]
  events: string[]
  observableStates: string[]
  limitations: string[]
  completeness?: number
  lastSyncAt: ISO | null
  confidence: "verified" | "declared" | "inferred"
  contractVersion: number
  details?: Record<string, unknown>
}

export interface CapabilityManifest {
  projectId: string
  generatedAt: ISO
  generatorVersion: string
  contractVersion: number
  capabilities: Record<CapabilityId, Capability>
  sources: { id: string; kind: string; description: string; authoritativeFor: string[] }[]
}

// ---------- integration / adapters ----------

export type AdapterKind = "builtin" | "generated"

export interface AdapterManifest {
  id: string
  version: string
  kind: AdapterKind
  title: string
  description: string
  contractVersion: number
  capabilities: CapabilityId[]
  compatibility: { core: string }
  sourceStability: "official-api" | "documented-format" | "undocumented-internal"
  riskNotes?: string
}

export interface AdapterVersionRecord {
  adapterId: string
  version: string
  activatedAt: ISO
  file?: string
  checksum: string
  previousVersion?: string
  status: "active" | "superseded" | "rolled_back" | "failed"
}

export interface AdapterMappingRule {
  id: string
  version: number
  domain: string
  rules: Record<string, string>
  preserveOriginal: true
}

export interface SyncStatus {
  adapterId: string
  lastAttemptAt: ISO | null
  lastSuccessAt: ISO | null
  eventsIngested: number
  errors: { at: ISO; message: string }[]
  state: "ok" | "stale" | "degraded" | "disabled" | "never"
}

export interface Integration {
  projectId: string
  adapters: AdapterManifest[]
  versions: AdapterVersionRecord[]
  mappings: AdapterMappingRule[]
  sync: Record<string, SyncStatus>
  baseline?: HarnessFingerprint
  lastReconciliation?: ReconciliationResult
}

// ---------- fingerprint / drift ----------

export interface FingerprintFile { path: string; sha256: string; role: string }

export interface HarnessFingerprint {
  projectId: string
  takenAt: ISO
  coreVersion: string
  pluginVersion?: string
  adapterVersions: Record<string, string>
  files: FingerprintFile[]
  components: string[]
  agents: string[]
  integrations: string[]
  capabilityManifestHash: string
  eventContractVersion: number
  mappingVersions: Record<string, number>
  workflowStages: string[]
  limitations: string[]
  diagnosticsBaseline?: number
}

export const DRIFT_CATEGORIES = ["A", "B", "C"] as const
export type DriftCategory = (typeof DRIFT_CATEGORIES)[number]

export interface DriftChange {
  kind: string
  category: DriftCategory
  evidence: string
  impact: string
  affectedCapabilities: CapabilityId[]
  suggestedAction: string
}

export interface DriftReport {
  projectId: string
  at: ISO
  baselineAt: ISO | null
  changes: DriftChange[]
  unchanged: boolean
}

export interface ReconciliationAction {
  action: "keep" | "change" | "add" | "remove" | "recreate" | "verify"
  target: string
  category: DriftCategory
  detail: string
  applied: boolean
  requiresApproval: boolean
}

export interface ReconciliationResult {
  at: ISO
  drift: DriftReport
  actions: ReconciliationAction[]
  manifestUpdated: boolean
  adaptersUpdated: string[]
  verified: boolean
  errors: string[]
}

// ---------- discovery ----------

export interface Evidence {
  kind: string
  path: string
  confidence: "high" | "medium" | "low"
  snippet?: string
  data?: Record<string, unknown>
}

export interface DiscoveryReport {
  projectId: string
  root: string
  at: ISO
  evidences: Evidence[]
  detectedTools: string[]
  suggestedAdapters: { adapterId: string; reason: string; config?: Record<string, unknown> }[]
  capabilityDraft: Partial<Record<CapabilityId, { status: CapabilityStatus; source?: string; notes?: string }>>
  agentsFound: { name: string; path: string; role?: string }[]
  workflowStagesFound: string[]
  limitations: string[]
}

// ---------- events ----------

export interface EventEnvelope {
  eventId: string
  idempotencyKey?: string
  projectId: string
  type: string
  schemaVersion: number
  occurredAt: ISO
  ingestedAt: ISO
  seq: number
  source: SourceRef
  payload: Record<string, unknown>
}

export interface IngestResult {
  accepted: number
  duplicates: number
  rejected: { index: number; error: string }[]
  seqs: number[]
}

// ---------- dashboard config ----------

export interface DashboardSection {
  id: string
  title: string
  route: string
  capability: CapabilityId | null
  visible: boolean
  mode: "full" | "partial" | "unavailable"
  limitations: string[]
}

export interface DashboardConfig {
  projectId: string
  projectName: string
  generatedAt: ISO
  sections: DashboardSection[]
  overviewCards: { id: string; capability: CapabilityId; title: string }[]
  freshness: Record<string, Freshness>
}

// ---------- API DTOs ----------

export interface ProjectOverview {
  project: Project
  capabilities: CapabilityManifest
  counts: {
    tasks: { total: number; byStatus: Record<string, number> }
    agents: { total: number; working: number; unknown: number }
    queue: { waiting: number; inFlight: boolean } | null
    pipelines: { lastRun: PipelineRun | null } | null
    releases: { active: Release | null; readiness: ReleaseReadiness | null } | null
  }
  criticalPath: CriticalPathResult | null
  alerts: { severity: "info" | "warning" | "error"; message: string; at: ISO }[]
  freshness: Record<string, Freshness>
}

export interface DoctorReport {
  projectId: string
  at: ISO
  healthy: boolean
  checks: { name: string; ok: boolean; detail: string }[]
  recommendations: string[]
}
