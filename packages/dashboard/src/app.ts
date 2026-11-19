// DFCP Dashboard — single-codebase capability-driven SPA (vanilla TS, zero dependencies).
// All domain data comes from the Core API; the UI never recomputes business logic.
// Sections render only when verified by the Capability Manifest.

type Json = Record<string, any>

const $ = (id: string): HTMLElement => document.getElementById(id)!
const esc = (s: unknown): string => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string))

const STATUS_COLORS: Record<string, string> = {
  backlog: "#64748b", planning: "#f59e0b", ready: "#06b6d4", in_progress: "#3b82f6",
  review: "#a855f7", verification: "#8b5cf6", blocked: "#ef4444", merged: "#10b981",
  done: "#22c55e", cancelled: "#475569", unknown: "#64748b",
  working: "#3b82f6", waiting: "#f59e0b", reviewing: "#a855f7", completed: "#22c55e",
  failed: "#ef4444", stopped: "#475569",
  pending: "#64748b", running: "#3b82f6", success: "#22c55e",
  checking: "#f59e0b", merging: "#3b82f6", conflict: "#ef4444", dead_letter: "#dc2626",
  supported: "#22c55e", partial: "#f59e0b", not_configured: "#64748b", unavailable: "#475569",
  stale: "#f59e0b", degraded: "#ef4444",
  open: "#3b82f6", closed: "#64748b",
  planning_r: "#f59e0b", in_progress_r: "#3b82f6", ready_r: "#22c55e", released: "#10b981",
}
const color = (s: string): string => STATUS_COLORS[s] ?? "#64748b"
const chip = (s: string, label?: string): string => `<span class="chip" style="background:${color(s)}22;color:${color(s)};border:1px solid ${color(s)}55">${esc(label ?? s)}</span>`
const natureTag = (n: string): string => n === "computed" ? '<span class="nature" title="computed from verified data">∑</span>' : n === "estimated" ? '<span class="nature est" title="estimate — not a fact">≈</span>' : n === "missing" ? '<span class="nature miss" title="no data">—</span>' : ""

function fmtTime(iso?: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (isNaN(d.getTime())) return "—"
  const p = (n: number) => String(n).padStart(2, "0")
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function ago(iso?: string | null): string {
  if (!iso) return "never"
  const ms = Date.now() - Date.parse(iso)
  if (isNaN(ms)) return "—"
  if (ms < 60000) return `${Math.max(0, Math.round(ms / 1000))}s ago`
  if (ms < 3600000) return `${Math.round(ms / 60000)}m ago`
  if (ms < 86400000) return `${Math.round(ms / 3600000)}h ago`
  return `${Math.round(ms / 86400000)}d ago`
}
function dur(ms?: number | null): string {
  if (ms === undefined || ms === null || isNaN(ms)) return "—"
  const m = Math.round(ms / 60000)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

// ---------- state ----------
let PROJECTS: Json[] = []
let PID = ""
let CONFIG: Json | null = null
let SECTION = "overview"
let ES: EventSource | null = null
let lastSeq = 0
let refreshTimer: number | null = null

async function api(path: string, method = "GET", body?: unknown): Promise<Json> {
  const res = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `${res.status}`)
  return data
}

function parseHash(): { pid: string; section: string; arg?: string } {
  const h = location.hash.replace(/^#\/?/, "")
  const parts = h.split("/").filter(Boolean)
  return { pid: parts[0] ?? "", section: parts[1] ?? "overview", arg: parts[2] }
}
function nav(section: string, arg?: string): void {
  location.hash = `#/${PID}/${section}${arg ? "/" + arg : ""}`
}

// ---------- shell ----------
async function boot(): Promise<void> {
  PROJECTS = await api("/api/projects")
  const h = parseHash()
  PID = h.pid || (PROJECTS[0]?.project?.id ?? "")
  SECTION = h.section
  if (!PID) { renderNoProjects(); return }
  await loadConfig()
  renderShell()
  connectSSE()
  await renderSection()
}

function renderNoProjects(): void {
  $("app").innerHTML = `<div class="noprog"><h1>Dark Factory Control Plane</h1>
  <p>No projects registered yet.</p>
  <p>Connect a project: <code>factory setup --root &lt;project-dir&gt;</code> or install the OpenCode plugin and run <code>/factory-setup</code>.</p></div>`
}

async function loadConfig(): Promise<void> {
  CONFIG = await api(`/api/projects/${PID}/dashboard-config`)
}

function renderShell(): void {
  const sections = (CONFIG?.sections ?? []).filter((s: Json) => s.visible)
  const projOptions = PROJECTS.map(p => `<option value="${esc(p.project?.id)}" ${p.project?.id === PID ? "selected" : ""}>${esc(p.project?.name ?? p.project?.id)}</option>`).join("")
  $("app").innerHTML = `
  <header>
    <div class="brand">◆ DFCP</div>
    <select id="projSel" title="Project">${projOptions}</select>
    <span class="live off" id="live"><span class="dot"></span><span id="liveTxt">connecting…</span></span>
    <span class="hstat">data: <b id="dataAge">—</b></span>
    <button class="btn" id="refreshBtn">⟳ Refresh</button>
    <button class="btn" id="syncBtn" title="Collect from all adapters">Sync</button>
    <span class="spacer"></span>
    <span class="hstat">core <b id="coreVer">—</b></span>
  </header>
  <aside><nav id="nav">
    ${sections.map((s: Json) => `<a class="navlink ${s.id === SECTION ? "active" : ""}" data-sec="${esc(s.id)}">${esc(s.title)}${s.mode === "partial" ? ' <span class="partial-dot" title="partial support">◐</span>' : ""}</a>`).join("")}
  </nav></aside>
  <main id="main"><div class="loading">Loading…</div></main>
  <div class="modal-bg" id="modalBg"><div class="modal" id="modal"></div></div>`
  $("projSel").onchange = () => { PID = ($("projSel") as HTMLSelectElement).value; location.hash = `#/${PID}/overview` }
  $("refreshBtn").onclick = () => renderSection()
  $("syncBtn").onclick = async () => {
    $("syncBtn").textContent = "Syncing…"
    try { await api(`/api/projects/${PID}/sync`, "POST"); await renderSection() } finally { $("syncBtn").textContent = "Sync" }
  }
  $("nav").querySelectorAll(".navlink").forEach(a => (a as HTMLElement).onclick = () => nav((a as HTMLElement).dataset.sec!))
  $("modalBg").onclick = e => { if (e.target === $("modalBg")) closeModal() }
  api("/api/health").then(h => { $("coreVer").textContent = h.coreVersion }).catch(() => {})
}

function connectSSE(): void {
  ES?.close()
  try {
    ES = new EventSource(`/api/projects/${PID}/stream?lastSeq=${lastSeq}`)
    ES.onopen = () => { $("live").classList.remove("off"); $("liveTxt").textContent = "live" }
    ES.onerror = () => { $("live").classList.add("off"); $("liveTxt").textContent = "reconnecting…" }
    ES.onmessage = (m) => {
      try {
        const d = JSON.parse(m.data)
        if (d.seq) lastSeq = Math.max(lastSeq, d.seq)
        if (d.type === "hello") return
        if (refreshTimer) clearTimeout(refreshTimer)
        refreshTimer = window.setTimeout(() => renderSection(), 400)
      } catch { /* ignore */ }
    }
  } catch { $("liveTxt").textContent = "polling" }
}

function closeModal(): void { $("modalBg").classList.remove("show") }
function openModal(html: string): void { $("modal").innerHTML = `<span class="close" id="mclose">✕</span>` + html; $("modalBg").classList.add("show"); $("mclose").onclick = closeModal }

function banner(mode: string, limitations: string[]): string {
  if (mode !== "partial" || !limitations.length) return ""
  return `<div class="banner">◐ Partial support: ${limitations.map(esc).join(" · ")}</div>`
}
function sectionMeta(id: string): Json {
  return (CONFIG?.sections ?? []).find((s: Json) => s.id === id) ?? { mode: "full", limitations: [] }
}
function unavailable(id: string, title: string): string {
  const cap = CONFIG?.freshness ?? {}
  return `<h2>${esc(title)}</h2><div class="unavailable">
    <div class="big">⊘ Not available for this project</div>
    <p>This section requires a verified capability that the project's harness does not currently provide.</p>
    <p>See <a class="link" data-sec="integrations">Integrations</a> for the capability matrix and how to connect a source.</p></div>`
}

// ---------- sections ----------
async function renderSection(): Promise<void> {
  const h = parseHash()
  if (h.pid && h.pid !== PID) { PID = h.pid; await loadConfig(); renderShell(); connectSSE() }
  SECTION = h.section || "overview"
  $("nav")?.querySelectorAll(".navlink").forEach(a => a.classList.toggle("active", (a as HTMLElement).dataset.sec === SECTION))
  const main = $("main")
  main.innerHTML = `<div class="loading">Loading…</div>`
  try {
    switch (SECTION) {
      case "overview": await renderOverview(main); break
      case "tasks": await renderTasks(main); break
      case "task-tree": await renderTaskTree(main); break
      case "agents": await renderAgents(main); break
      case "workflow": await renderWorkflow(main); break
      case "pipelines": await renderPipelines(main, h.arg); break
      case "merge-queue": await renderQueue(main); break
      case "critical-path": await renderCriticalPath(main); break
      case "releases": await renderReleases(main, h.arg); break
      case "components": await renderComponents(main); break
      case "metrics": await renderMetrics(main); break
      case "activity": await renderActivity(main); break
      case "integrations": await renderIntegrations(main); break
      case "settings": await renderSettings(main); break
      default: main.innerHTML = `<div class="empty">Unknown section</div>`
    }
    $("dataAge").textContent = new Date().toLocaleTimeString()
  } catch (e) {
    main.innerHTML = `<div class="error">Error: ${esc((e as Error).message)}</div>`
  }
}

async function renderOverview(main: HTMLElement): Promise<void> {
  const ov = await api(`/api/projects/${PID}`)
  const c = ov.counts ?? {}
  const cards: string[] = []
  const visible = (id: string) => (CONFIG?.sections ?? []).some((s: Json) => s.id === id && s.visible)
  if (visible("tasks")) {
    const bs = c.tasks?.byStatus ?? {}
    cards.push(kpi("Tasks", c.tasks?.total ?? 0, `${bs.done ?? 0} done · ${bs.in_progress ?? 0} in progress · ${bs.blocked ?? 0} blocked`, "tasks"))
  }
  if (visible("agents")) cards.push(kpi("Agents", `${c.agents?.working ?? 0}/${c.agents?.total ?? 0}`, `working · ${c.agents?.unknown ?? 0} unknown`, "agents"))
  if (visible("pipelines") && c.pipelines?.lastRun) {
    const r = c.pipelines.lastRun
    cards.push(kpi("Last pipeline", `#${r.number} ${r.status}`, `${esc(r.pipelineId)} · ${ago(r.startedAt)}`, "pipelines", color(r.status)))
  }
  if (visible("merge-queue") && c.queue) cards.push(kpi("Merge queue", c.queue.waiting, c.queue.inFlight ? "merge in flight" : "idle", "merge-queue"))
  if (visible("releases") && c.releases?.active) {
    const r = c.releases.active, rd = c.releases.readiness
    cards.push(kpi(`Release ${esc(r.name)}`, rd ? `${rd.tasks.done}/${rd.tasks.total}` : "—", rd ? `readiness: ${rd.verdict}` : "", "releases", rd?.verdict === "ready" ? "#22c55e" : "#f59e0b"))
  }
  if (visible("critical-path") && ov.criticalPath?.path?.length) {
    cards.push(kpi("Critical path", ov.criticalPath.path.length, ov.criticalPath.lengthHours ? `${ov.criticalPath.lengthHours}h ${natureTag(ov.criticalPath.nature)}` : `structural ${natureTag(ov.criticalPath.nature)}`, "critical-path"))
  }
  const alerts = (ov.alerts ?? []).map((a: Json) => `<div class="alert ${esc(a.severity)}"><span class="asev">${a.severity === "error" ? "⛔" : a.severity === "warning" ? "⚠" : "ℹ"}</span> ${esc(a.message)} <span class="amuted">${ago(a.at)}</span></div>`).join("") || `<div class="empty">No alerts.</div>`
  const fresh = Object.entries(ov.freshness ?? {}).map(([id, f]: [string, any]) =>
    `<span class="fresh ${f.degraded ? "degraded" : f.stale ? "stale" : "ok"}" title="last success: ${esc(f.lastSuccessAt ?? "never")}">${esc(id)}: ${f.degraded ? "degraded" : f.stale ? "stale" : "ok"} · ${ago(f.lastSuccessAt)}</span>`).join(" ") || `<span class="empty">no adapters synced yet</span>`
  const activity = (await api(`/api/projects/${PID}/activity?limit=8`)).events ?? []
  main.innerHTML = `<h2>Overview — ${esc(ov.project?.name ?? PID)}</h2>
    <div class="kpis">${cards.join("")}</div>
    <div class="cols">
      <section><h3>Alerts & blockers</h3>${alerts}</section>
      <section><h3>Source freshness</h3><div class="freshwrap">${fresh}</div>
        <h3>Recent activity</h3>${activityTable(activity)}</section>
    </div>`
  main.querySelectorAll("[data-goto]").forEach(el => (el as HTMLElement).onclick = () => nav((el as HTMLElement).dataset.goto!))
}

function kpi(label: string, value: unknown, sub: string, goto: string, valColor?: string): string {
  return `<div class="kpi" data-goto="${esc(goto)}"><div class="lbl">${esc(label)}</div><div class="val" ${valColor ? `style="color:${valColor}"` : ""}>${value}</div><div class="sub">${sub}</div></div>`
}

function activityTable(events: Json[]): string {
  if (!events.length) return `<div class="empty">No events yet.</div>`
  return `<table><tr><th>Time</th><th>Event</th><th>Source</th><th>Detail</th></tr>
  ${events.map(e => `<tr><td class="mono">${fmtTime(e.occurredAt)}</td><td>${chip(e.type.split(".")[0], e.type)}</td><td class="mono">${esc(e.source?.adapterId ?? "?")}</td><td class="detail">${esc(JSON.stringify(e.payload).slice(0, 120))}</td></tr>`).join("")}</table>`
}

// ---------- tasks ----------
let taskFilters = { status: "", kind: "", priority: "", q: "" }

async function renderTasks(main: HTMLElement): Promise<void> {
  const meta = sectionMeta("tasks")
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(taskFilters)) if (v) qs.set(k, v)
  const { tasks } = await api(`/api/projects/${PID}/tasks?${qs}`)
  const statuses = ["", "backlog", "planning", "ready", "in_progress", "review", "verification", "blocked", "merged", "done", "cancelled", "unknown"]
  main.innerHTML = `<h2>Tasks</h2>${banner(meta.mode, meta.limitations)}
  <div class="filterbar">
    <select id="fStatus">${statuses.map(s => `<option value="${s}" ${taskFilters.status === s ? "selected" : ""}>${s || "all statuses"}</option>`).join("")}</select>
    <select id="fKind">${["", "epic", "feature", "task", "subtask"].map(s => `<option value="${s}" ${taskFilters.kind === s ? "selected" : ""}>${s || "all kinds"}</option>`).join("")}</select>
    <select id="fPriority">${["", "P0", "P1", "P2", "P3"].map(s => `<option value="${s}" ${taskFilters.priority === s ? "selected" : ""}>${s || "all priorities"}</option>`).join("")}</select>
    <input id="fQ" placeholder="search id / title…" value="${esc(taskFilters.q)}">
    <button class="btn primary" id="newTask">+ New task</button>
  </div>
  <table id="taskTable"><tr><th>ID</th><th>Title</th><th>Kind</th><th>Status</th><th>Priority</th><th>Assignee</th><th>Deps</th><th>Progress</th><th>Updated</th></tr>
  ${tasks.map((t: Json) => `<tr class="rowlink" data-task="${esc(t.id)}">
    <td class="mono">${esc(t.id)}</td><td>${esc(t.title)}</td><td>${esc(t.kind)}</td>
    <td>${chip(t.status)}${t.sourceStatus && t.sourceStatus !== t.status ? `<span class="orig" title="original source status">${esc(t.sourceStatus)}</span>` : ""}</td>
    <td>${esc(t.priority)}</td><td>${esc(t.assignee ?? "—")}</td>
    <td class="mono">${(t.dependencies ?? []).map((d: string) => esc(d)).join(", ") || "—"}</td>
    <td>${t.progress !== undefined ? t.progress + "%" : t.status === "done" ? "100%" : "—"}</td>
    <td class="mono">${fmtTime(t.updatedAt)}</td></tr>`).join("")}</table>
  ${!tasks.length ? '<div class="empty">No tasks match.</div>' : ""}`
  $("fStatus").onchange = () => { taskFilters.status = ($("fStatus") as HTMLSelectElement).value; renderTasks(main) }
  $("fKind").onchange = () => { taskFilters.kind = ($("fKind") as HTMLSelectElement).value; renderTasks(main) }
  $("fPriority").onchange = () => { taskFilters.priority = ($("fPriority") as HTMLSelectElement).value; renderTasks(main) }
  $("fQ").oninput = () => { taskFilters.q = ($("fQ") as HTMLInputElement).value; renderTasks(main) }
  $("newTask").onclick = () => taskForm()
  main.querySelectorAll("[data-task]").forEach(el => (el as HTMLElement).onclick = () => openTask((el as HTMLElement).dataset.task!))
}

function taskForm(existing?: Json): void {
  const t = existing ?? {}
  openModal(`<h3>${existing ? "Edit " + esc(t.id) : "New task"}</h3>
  <div class="form">
    ${existing ? "" : `<label>ID <input id="tId" placeholder="T-100"></label>`}
    <label>Title <input id="tTitle" value="${esc(t.title ?? "")}"></label>
    <label>Kind <select id="tKind">${["task", "epic", "feature", "subtask"].map(k => `<option ${t.kind === k ? "selected" : ""}>${k}</option>`).join("")}</select></label>
    <label>Status <select id="tStatus">${["ready", "backlog", "planning", "in_progress", "review", "verification", "blocked", "done", "cancelled"].map(k => `<option ${t.status === k ? "selected" : ""}>${k}</option>`).join("")}</select></label>
    <label>Priority <select id="tPriority">${["P0", "P1", "P2", "P3"].map(k => `<option ${(t.priority ?? "P2") === k ? "selected" : ""}>${k}</option>`).join("")}</select></label>
    <label>Parent ID <input id="tParent" value="${esc(t.parentId ?? "")}"></label>
    <label>Dependencies (csv) <input id="tDeps" value="${esc((t.dependencies ?? []).join(","))}"></label>
    <label>Estimate hours <input id="tEst" type="number" value="${t.estimateHours ?? ""}"></label>
    <label>Component <input id="tComp" value="${esc(t.componentId ?? "")}"></label>
    <label>Description <textarea id="tDesc">${esc(t.description ?? "")}</textarea></label>
    <button class="btn primary" id="tSave">${existing ? "Save" : "Create"}</button>
  </div>`)
  $("tSave").onclick = async () => {
    const body: Json = {
      title: ($("tTitle") as HTMLInputElement).value, kind: ($("tKind") as HTMLSelectElement).value,
      status: ($("tStatus") as HTMLSelectElement).value, priority: ($("tPriority") as HTMLSelectElement).value,
      parentId: ($("tParent") as HTMLInputElement).value || undefined,
      dependencies: ($("tDeps") as HTMLInputElement).value.split(",").map(s => s.trim()).filter(Boolean),
      estimateHours: ($("tEst") as HTMLInputElement).value ? Number(($("tEst") as HTMLInputElement).value) : undefined,
      componentId: ($("tComp") as HTMLInputElement).value || undefined,
      description: ($("tDesc") as HTMLTextAreaElement).value || undefined,
    }
    try {
      if (existing) await api(`/api/projects/${PID}/tasks/${t.id}`, "PATCH", body)
      else await api(`/api/projects/${PID}/tasks`, "POST", { id: ($("tId") as HTMLInputElement).value, ...body })
      closeModal(); renderSection()
    } catch (e) { alert((e as Error).message) }
  }
}

async function openTask(id: string): Promise<void> {
  const { task: t, dependents } = await api(`/api/projects/${PID}/tasks/${id}`)
  const deps = (t.dependencies ?? []).map((d: string) => `<span class="depchip" data-task="${esc(d)}">${esc(d)}</span>`).join(" ") || "—"
  const acs = (t.acceptanceCriteria ?? []).map((a: Json) => `<div class="ac ${a.done ? "done" : ""}">${a.done ? "☑" : "☐"} ${esc(a.text)}</div>`).join("") || `<div class="empty">No acceptance criteria.</div>`
  const hist = (t.history ?? []).slice(-12).reverse().map((h: Json) => `<div class="hist"><span class="mono">${fmtTime(h.at)}</span> <b>${esc(h.field)}</b>: ${esc(JSON.stringify(h.from))} → ${esc(JSON.stringify(h.to))}${h.actor ? ` <span class="amuted">by ${esc(h.actor)}</span>` : ""}</div>`).join("") || `<div class="empty">No history.</div>`
  const links = t.links ?? {}
  openModal(`<h3>${esc(t.id)} — ${esc(t.title)}</h3>
  <div class="kvgrid">
    <div><b>Status</b> ${chip(t.status)} ${t.sourceStatus ? `<span class="orig">source: ${esc(t.sourceStatus)}</span>` : ""}</div>
    <div><b>Kind</b> ${esc(t.kind)} · <b>Priority</b> ${esc(t.priority)}</div>
    <div><b>Assignee</b> ${esc(t.assignee ?? "—")}</div>
    <div><b>Component</b> ${esc(t.componentId ?? "—")}</div>
    <div><b>Progress</b> ${t.progress ?? (t.status === "done" ? 100 : 0)}% ${t.estimateHours ? `· estimate ${t.estimateHours}h (${esc(t.estimateConfidence ?? "?")})` : ""}</div>
    <div><b>Source</b> <span class="mono">${esc(t.source?.adapterId)}</span> ${t.source?.authoritative ? "(authoritative)" : "(auxiliary)"} · fetched ${ago(t.source?.fetchedAt)}</div>
    <div><b>Mapping</b> rule set <span class="mono">${esc(t.mapping?.ruleSetId)}</span> v${esc(t.mapping?.ruleSetVersion)} · confidence ${chip(t.mapping?.confidence ?? "exact")}</div>
  </div>
  <h4>Depends on</h4><div>${deps}</div>
  ${dependents?.length ? `<h4>Blocks</h4><div>${dependents.map((d: string) => `<span class="depchip" data-task="${esc(d)}">${esc(d)}</span>`).join(" ")}</div>` : ""}
  <h4>Acceptance criteria</h4>${acs}
  <h4>Links</h4><div class="mono">branches: ${(links.branches ?? []).map(esc).join(", ") || "—"} · PRs: ${(links.pullRequests ?? []).map(esc).join(", ") || "—"} · runs: ${(links.pipelineRunIds ?? []).map(esc).join(", ") || "—"} · release: ${esc(links.releaseId ?? "—")}</div>
  ${t.description ? `<h4>Description</h4><div class="doc">${esc(t.description)}</div>` : ""}
  <h4>History</h4>${hist}
  <div class="actions">
    <button class="btn" id="tEdit">Edit</button>
    <button class="btn" id="tClaim">Claim</button>
    <button class="btn" id="tRelease">Release</button>
    <select id="tStatusSel">${["ready", "in_progress", "review", "verification", "blocked", "done", "cancelled"].map(s => `<option ${t.status === s ? "selected" : ""}>${s}</option>`).join("")}</select>
    <button class="btn primary" id="tStatusGo">Set status</button>
  </div>`)
  $("tEdit").onclick = () => taskForm(t)
  $("tClaim").onclick = async () => {
    const agent = prompt("Agent name:")
    if (!agent) return
    try { await api(`/api/projects/${PID}/tasks/${id}/claim`, "POST", { agent }); closeModal(); renderSection() } catch (e) { alert((e as Error).message) }
  }
  $("tRelease").onclick = async () => { await api(`/api/projects/${PID}/tasks/${id}/release`, "POST"); closeModal(); renderSection() }
  $("tStatusGo").onclick = async () => { await api(`/api/projects/${PID}/tasks/${id}`, "PATCH", { status: ($("tStatusSel") as HTMLSelectElement).value }); closeModal(); renderSection() }
  $("modal").querySelectorAll(".depchip").forEach(el => (el as HTMLElement).onclick = () => openTask((el as HTMLElement).dataset.task!))
}

// ---------- task tree ----------
async function renderTaskTree(main: HTMLElement): Promise<void> {
  const meta = sectionMeta("task-tree")
  const { tree } = await api(`/api/projects/${PID}/task-tree`)
  function node(n: Json, depth: number): string {
    const t = n.task, r = n.rollup
    const kids = (n.children ?? []).map((c: Json) => node(c, depth + 1)).join("")
    return `<div class="tnode" style="margin-left:${depth * 18}px">
      <div class="trow rowlink" data-task="${esc(t.id)}">
        <span class="twisty">${(n.children ?? []).length ? "▾" : "·"}</span>
        ${chip(t.status)} <span class="mono tid">${esc(t.id)}</span> <span class="ttitle">${esc(t.title)}</span>
        <span class="troll">${r.done}/${r.total} done${r.blocked ? ` · <span style="color:#ef4444">${r.blocked} blocked</span>` : ""}</span>
        <span class="bar"><i style="width:${r.progress}%"></i></span><span class="tpct">${r.progress}%</span>
      </div>${kids}</div>`
  }
  main.innerHTML = `<h2>Task Tree</h2>${banner(meta.mode, meta.limitations)}
  <p class="muted">Hierarchy (epic → feature → task → subtask). Dependency graph is separate — see Critical Path.</p>
  ${tree.map((n: Json) => node(n, 0)).join("") || '<div class="empty">No tasks.</div>'}`
  main.querySelectorAll("[data-task]").forEach(el => (el as HTMLElement).onclick = () => openTask((el as HTMLElement).dataset.task!))
}

// ---------- agents ----------
async function renderAgents(main: HTMLElement): Promise<void> {
  const meta = sectionMeta("agents")
  const { agents } = await api(`/api/projects/${PID}/agents`)
  main.innerHTML = `<h2>Agents</h2>${banner(meta.mode, meta.limitations)}
  <table><tr><th>Name</th><th>Kind</th><th>Status</th><th>Evidence</th><th>Task</th><th>Session</th><th>Model</th><th>Last event</th><th>Errors</th></tr>
  ${agents.map((a: Json) => {
    const eff = a.effective ?? { status: a.status, stale: false }
    return `<tr class="rowlink" data-agent="${esc(a.id)}">
    <td><b>${esc(a.name)}</b>${a.role ? `<div class="amuted">${esc(a.role)}</div>` : ""}</td>
    <td>${esc(a.kind)}</td>
    <td>${chip(eff.status)}${eff.stale && eff.status === "unknown" ? '<span class="stalewarn" title="no recent heartbeat — absence of heartbeat is NOT proof of completion">⚠ no heartbeat</span>' : ""}</td>
    <td>${esc(eff.evidence ?? a.statusEvidence)}</td>
    <td class="mono">${esc(a.currentTaskId ?? "—")}</td>
    <td class="mono">${esc(a.sessionId ?? "—")}</td>
    <td class="mono">${esc(a.model ?? "—")}</td>
    <td class="mono">${ago(a.lastEventAt)}</td>
    <td>${a.errors?.length ? `<span style="color:#ef4444">${a.errors.length}</span>` : "0"}</td></tr>`
  }).join("")}</table>
  ${!agents.length ? '<div class="empty">No agents registered. Connect the OpenCode plugin or a harness agent source.</div>' : ""}`
  main.querySelectorAll("[data-agent]").forEach(el => (el as HTMLElement).onclick = () => openAgent((el as HTMLElement).dataset.agent!))
}

async function openAgent(id: string): Promise<void> {
  const { agent: a, sessions, timeline } = await api(`/api/projects/${PID}/agents/${id}`)
  openModal(`<h3>${esc(a.name)} <span class="mono amuted">${esc(a.id)}</span></h3>
  <div class="kvgrid">
    <div><b>Status</b> ${chip(a.effective?.status ?? a.status)} (evidence: ${esc(a.effective?.evidence ?? a.statusEvidence)})</div>
    <div><b>Kind</b> ${esc(a.kind)} · <b>Role</b> ${esc(a.role ?? "—")}</div>
    <div><b>Current task</b> ${esc(a.currentTaskId ?? "—")}</div>
    <div><b>Model</b> ${esc(a.model ?? "—")}</div>
    <div><b>Started</b> ${fmtTime(a.startedAt)} · <b>Last event</b> ${ago(a.lastEventAt)} · <b>Last heartbeat</b> ${ago(a.lastHeartbeatAt)}</div>
  </div>
  <h4>Sessions</h4>${sessions.length ? sessions.map((s: Json) => `<div class="hist"><span class="mono">${esc(s.id)}</span> ${s.opencodeSessionId ? `· oc ${esc(s.opencodeSessionId)}` : ""} · ${fmtTime(s.startedAt)} → ${s.endedAt ? fmtTime(s.endedAt) : "active"}</div>`).join("") : '<div class="empty">No sessions.</div>'}
  <h4>Errors</h4>${a.errors?.length ? a.errors.slice(-5).map((e: Json) => `<div class="alert error">${esc(e.message)} <span class="amuted">${ago(e.at)}</span></div>`).join("") : '<div class="empty">No errors.</div>'}
  <h4>Recent events</h4>${activityTable((timeline ?? []).slice(-10).reverse())}`)
}

// ---------- workflow ----------
async function renderWorkflow(main: HTMLElement): Promise<void> {
  const meta = sectionMeta("workflow")
  const wf = await api(`/api/projects/${PID}/workflow`)
  const stages = wf.stages ?? []
  const strip = stages.map((s: Json) => `<div class="wstage ${s.observed ? "" : "unobserved"}"><div class="wname">${esc(s.label)}</div><div class="wcount">${s.taskCount}</div><div class="amuted">${s.observed ? "observed" : "not observed"}</div></div>`).join(`<div class="warrow">→</div>`)
  const trs = (wf.transitions ?? []).slice(0, 20)
  main.innerHTML = `<h2>Workflow</h2>${banner(meta.mode, meta.limitations)}
  <p class="muted">Stages and transitions observed from the harness — not an imposed canonical pipeline.</p>
  <div class="wstrip">${strip || '<div class="empty">No stages observed.</div>'}</div>
  <h3>Observed transitions</h3>
  ${trs.length ? `<table><tr><th>From</th><th>To</th><th>Count</th><th>Last</th></tr>${trs.map((t: Json) => `<tr><td>${chip(t.from)}</td><td>${chip(t.to)}</td><td>${t.count}</td><td class="mono">${fmtTime(t.lastAt)}</td></tr>`).join("")}</table>` : '<div class="empty">No transitions recorded yet.</div>'}
  ${wf.observableStages?.length ? `<p class="muted">Observable stages: ${wf.observableStages.map(esc).join(", ")}</p>` : ""}`
}

// ---------- pipelines ----------
async function renderPipelines(main: HTMLElement, runId?: string): Promise<void> {
  const meta = sectionMeta("pipelines")
  if (runId) {
    const { run: r } = await api(`/api/projects/${PID}/pipelines/${runId}`)
    const stages = (r.stages ?? []).map((s: Json) => `<div class="pstage" style="border-color:${color(s.status)}"><div class="pname">${esc(s.name)}</div>${chip(s.status)}<div class="amuted">${s.startedAt ? fmtTime(s.startedAt) : ""}${s.finishedAt ? " → " + fmtTime(s.finishedAt) : ""}</div>${(s.jobs ?? []).map((j: Json) => `<div class="pjob">${esc(j.name)} ${chip(j.status)}</div>`).join("")}</div>`).join("")
    main.innerHTML = `<button class="btn" id="backRuns">← Runs</button>
    <h2>Run #${r.number} — ${esc(r.pipelineId)}</h2>${banner(meta.mode, meta.limitations)}
    <div class="kvgrid">
      <div><b>Status</b> ${chip(r.status)}</div><div><b>Branch</b> <span class="mono">${esc(r.branch ?? "—")}</span></div>
      <div><b>Task</b> ${r.taskId ? `<span class="mono link" data-task="${esc(r.taskId)}">${esc(r.taskId)}</span>` : "—"}</div>
      <div><b>Trigger</b> ${esc(r.trigger ?? "—")}</div>
      <div><b>Started</b> ${fmtTime(r.startedAt)} · <b>Finished</b> ${fmtTime(r.finishedAt)}</div>
      <div><b>Retries</b> ${r.retries ?? 0}</div>
    </div>
    ${r.error ? `<div class="alert error">${esc(r.error)}</div>` : ""}
    <h3>Stages</h3><div class="pstrip">${stages || '<div class="empty">No stage data (provider may not expose stages).</div>'}</div>
    ${(r.artifacts ?? []).length ? `<h3>Artifacts</h3>${r.artifacts.map((a: Json) => `<div>${esc(a.name)} ${a.url ? `<a href="${esc(a.url)}">link</a>` : ""}</div>`).join("")}` : ""}`
    $("backRuns").onclick = () => nav("pipelines")
    main.querySelectorAll("[data-task]").forEach(el => (el as HTMLElement).onclick = () => openTask((el as HTMLElement).dataset.task!))
    return
  }
  const { runs } = await api(`/api/projects/${PID}/pipelines`)
  main.innerHTML = `<h2>CI/CD Pipelines</h2>${banner(meta.mode, meta.limitations)}
  <table><tr><th>#</th><th>Pipeline</th><th>Status</th><th>Branch</th><th>Task</th><th>Started</th><th>Duration</th></tr>
  ${runs.map((r: Json) => `<tr class="rowlink" data-run="${esc(r.id)}"><td class="mono">${r.number}</td><td>${esc(r.pipelineId)}</td><td>${chip(r.status)}</td><td class="mono">${esc(r.branch ?? "—")}</td><td class="mono">${esc(r.taskId ?? "—")}</td><td class="mono">${fmtTime(r.startedAt)}</td><td>${r.startedAt && r.finishedAt ? dur(Date.parse(r.finishedAt) - Date.parse(r.startedAt)) : "…"}</td></tr>`).join("")}</table>
  ${!runs.length ? '<div class="empty">No pipeline runs observed.</div>' : ""}`
  main.querySelectorAll("[data-run]").forEach(el => (el as HTMLElement).onclick = () => nav("pipelines", (el as HTMLElement).dataset.run!))
}

// ---------- merge queue ----------
async function renderQueue(main: HTMLElement): Promise<void> {
  const meta = sectionMeta("merge-queue")
  const res = await api(`/api/projects/${PID}/merge-queue`)
  if (!res.available || !res.queue) {
    main.innerHTML = `<h2>Merge Queue</h2><div class="unavailable"><div class="big">⊘ No merge queue source</div>
    <p>${esc(res.capability?.limitations?.join("; ") || "The project has no verified merge queue integration.")}</p>
    <p class="muted">Task, Pipeline and Merge are independent states — this project simply has no queue mechanism connected.</p></div>`
    return
  }
  const q = res.queue
  main.innerHTML = `<h2>Merge Queue</h2>${banner(meta.mode, meta.limitations)}
  <p class="muted">FIFO order · source: <span class="mono">${esc(q.source?.adapterId)}</span> · synced ${ago(q.source?.fetchedAt)}</p>
  <table><tr><th>Pos</th><th>Branch</th><th>Task</th><th>Agent</th><th>State</th><th>Checks</th><th>Wait</th><th>Reason</th></tr>
  ${(q.entries ?? []).map((e: Json) => `<tr class="${e.state === "merging" ? "inflight" : ""}">
    <td>${e.position}</td><td class="mono">${esc(e.branch)}</td>
    <td class="mono">${e.taskId ? `<span class="link" data-task="${esc(e.taskId)}">${esc(e.taskId)}</span>` : "—"}</td>
    <td>${esc(e.agent ?? "—")}</td><td>${chip(e.state)}</td>
    <td>${(e.checks ?? []).map((c: Json) => `${esc(c.name)}:${chip(c.status)}`).join(" ") || "—"}</td>
    <td>${e.enqueuedAt ? dur(Date.now() - Date.parse(e.enqueuedAt)) : "—"}</td>
    <td class="reason">${esc(e.reason ?? "")}</td></tr>`).join("")}</table>
  ${!q.entries?.length ? '<div class="empty">Queue is empty.</div>' : ""}`
  main.querySelectorAll("[data-task]").forEach(el => (el as HTMLElement).onclick = () => openTask((el as HTMLElement).dataset.task!))
}

// ---------- critical path ----------
async function renderCriticalPath(main: HTMLElement): Promise<void> {
  const cp = await api(`/api/projects/${PID}/critical-path`)
  const { tasks } = await api(`/api/projects/${PID}/tasks`)
  const byId = new Map(tasks.map((t: Json) => [t.id, t]))
  const pathSet = new Set(cp.path ?? [])
  // layered SVG DAG
  const layers = new Map<number, string[]>()
  for (const l of cp.layers ?? []) { const a = layers.get(l.layer) ?? []; a.push(l.taskId); layers.set(l.layer, a) }
  const W = 200, H = 54, GX = 90, GY = 22
  const maxLayer = Math.max(0, ...[...layers.keys()])
  const maxRows = Math.max(1, ...[...layers.values()].map(a => a.length))
  const width = 60 + (maxLayer + 1) * (W + GX), height = 40 + maxRows * (H + GY)
  const pos = new Map<string, { x: number; y: number }>()
  for (const [l, ids] of layers) ids.forEach((id, i) => pos.set(id, { x: 30 + l * (W + GX), y: 20 + i * (H + GY) }))
  let svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
  svg += `<defs><marker id="arr" markerWidth="10" markerHeight="10" refX="8" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#94a3b8"/></marker><marker id="arrR" markerWidth="10" markerHeight="10" refX="8" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#ef4444"/></marker></defs>`
  for (const e of cp.edges ?? []) {
    const a = pos.get(e.from), b = pos.get(e.to)
    if (!a || !b) continue
    const onPath = pathSet.has(e.from) && pathSet.has(e.to)
    const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x - 4, y2 = b.y + H / 2, mx = (x1 + x2) / 2
    svg += `<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" fill="none" stroke="${onPath ? "#ef4444" : "#94a3b8"}" stroke-width="${onPath ? 2.2 : 1.3}" marker-end="url(#${onPath ? "arrR" : "arr"})" opacity="${onPath ? 1 : 0.6}"/>`
  }
  for (const [id, p] of pos) {
    const t = byId.get(id) as Json | undefined
    const onPath = pathSet.has(id)
    const c = color(t?.status ?? "unknown")
    svg += `<g class="dagNode" data-task="${esc(id)}" style="cursor:pointer"><rect x="${p.x}" y="${p.y}" width="${W}" height="${H}" rx="9" fill="#141b2e" stroke="${onPath ? "#ef4444" : c}" stroke-width="${onPath ? 2.2 : 1.4}"/>
    <text x="${p.x + 12}" y="${p.y + 20}" fill="${c}" font-size="10" font-style="italic">${esc(t?.status ?? "?")}${t?.estimateHours ? ` · ${t.estimateHours}h` : ""}</text>
    <text x="${p.x + 12}" y="${p.y + 38}" fill="#e6ebf5" font-size="12" font-weight="600">${esc(id)}</text></g>`
  }
  svg += "</svg>"
  main.innerHTML = `<h2>Critical Path</h2>
  <div class="banner ${cp.nature === "computed" ? "ok" : ""}">${natureTag(cp.nature)} ${cp.nature === "computed" ? `Longest path by duration estimates: <b>${cp.lengthHours}h</b>` : cp.nature === "estimated" ? "Structural longest path — duration estimates incomplete; this is NOT a time forecast." : "No open tasks to schedule."} ${cp.path?.length ? `Path: <span class="mono">${cp.path.map(esc).join(" → ")}</span>` : ""}</div>
  ${(cp.notes ?? []).map((n: string) => `<div class="muted">· ${esc(n)}</div>`).join("")}
  ${cp.cycles?.length ? `<div class="alert error">Dependency cycles: ${cp.cycles.map((c: string[]) => c.join("→")).map(esc).join("; ")}</div>` : ""}
  <div class="graph">${svg}</div>
  <p class="muted">Red = critical path · click a node to open the task · gray edges = non-critical dependencies</p>`
  main.querySelectorAll(".dagNode").forEach(el => (el as HTMLElement).onclick = () => openTask((el as HTMLElement).dataset.task!))
}

// ---------- releases ----------
async function renderReleases(main: HTMLElement, rid?: string): Promise<void> {
  const meta = sectionMeta("releases")
  if (rid) {
    const { release: r, readiness: rd, criticalPath: cp } = await api(`/api/projects/${PID}/releases/${rid}`)
    main.innerHTML = `<button class="btn" id="backRel">← Releases</button>
    <h2>Release ${esc(r.name)} ${r.tag ? `<span class="mono">(${esc(r.tag)})</span>` : ""}</h2>${banner(meta.mode, meta.limitations)}
    <div class="kpis">
      ${kpi("Verdict", rd.verdict, `${natureTag(rd.nature)} ${rd.tasks.done}/${rd.tasks.total} done`, "releases", rd.verdict === "ready" ? "#22c55e" : rd.verdict === "not_ready" ? "#f59e0b" : "#64748b")}
      ${kpi("Blockers", rd.blockers.length, "open", "releases")}
      ${kpi("Critical path", cp.path?.length ?? 0, cp.lengthHours ? cp.lengthHours + "h" : "structural", "critical-path")}
    </div>
    <h3>Readiness checks</h3>
    <table><tr><th>Check</th><th>Result</th><th>Evidence</th></tr>
    ${rd.checks.map((c: Json) => `<tr><td>${esc(c.name)}</td><td>${c.ok ? '<span style="color:#22c55e">✓ pass</span>' : '<span style="color:#ef4444">✗ fail</span>'}</td><td>${esc(c.evidence)}</td></tr>`).join("")}</table>
    <p class="muted">Assessed: ${rd.coverage.map(esc).join(" · ")}</p>
    ${rd.blockers.length ? `<h3>Blockers</h3>${rd.blockers.map((b: Json) => `<div class="alert warning"><span class="mono">${esc(b.taskId)}</span>: ${esc(b.reason)}</div>`).join("")}` : ""}
    <h3>Scope</h3><table><tr><th>Task</th><th>Status</th></tr>${r.scopeTaskIds.map((id: string) => `<tr class="rowlink" data-task="${esc(id)}"><td class="mono">${esc(id)}</td><td>—</td></tr>`).join("")}</table>`
    $("backRel").onclick = () => nav("releases")
    main.querySelectorAll("[data-task]").forEach(el => (el as HTMLElement).onclick = () => openTask((el as HTMLElement).dataset.task!))
    return
  }
  const { releases } = await api(`/api/projects/${PID}/releases`)
  main.innerHTML = `<h2>Releases</h2>${banner(meta.mode, meta.limitations)}
  <div class="filterbar"><button class="btn primary" id="newRel">+ New release</button></div>
  <table><tr><th>Name</th><th>Tag</th><th>Status</th><th>Scope</th><th>Readiness</th><th>Target</th></tr>
  ${releases.map((r: Json) => `<tr class="rowlink" data-rel="${esc(r.id)}"><td><b>${esc(r.name)}</b></td><td class="mono">${esc(r.tag ?? "—")}</td><td>${chip(r.status)}</td><td>${r.scopeTaskIds?.length ?? 0} tasks</td><td>${r.readiness ? chip(r.readiness.verdict === "ready" ? "success" : r.readiness.verdict === "not_ready" ? "failed" : "unknown", r.readiness.verdict) + ` ${r.readiness.tasks.done}/${r.readiness.tasks.total}` : "—"}</td><td class="mono">${fmtTime(r.targetDate)}</td></tr>`).join("")}</table>
  ${!releases.length ? '<div class="empty">No releases planned.</div>' : ""}`
  $("newRel").onclick = () => {
    openModal(`<h3>New release</h3><div class="form">
    <label>ID <input id="rId" placeholder="v0.2"></label>
    <label>Name <input id="rName" placeholder="v0.2"></label>
    <label>Scope task IDs (csv) <input id="rScope"></label>
    <button class="btn primary" id="rSave">Create</button></div>`)
    $("rSave").onclick = async () => {
      try {
        await api(`/api/projects/${PID}/releases`, "POST", { id: ($("rId") as HTMLInputElement).value, name: ($("rName") as HTMLInputElement).value, scopeTaskIds: ($("rScope") as HTMLInputElement).value.split(",").map(s => s.trim()).filter(Boolean) })
        closeModal(); renderSection()
      } catch (e) { alert((e as Error).message) }
    }
  }
  main.querySelectorAll("[data-rel]").forEach(el => (el as HTMLElement).onclick = () => nav("releases", (el as HTMLElement).dataset.rel!))
}

// ---------- components ----------
async function renderComponents(main: HTMLElement): Promise<void> {
  const meta = sectionMeta("components")
  const { components } = await api(`/api/projects/${PID}/components`)
  const arch = await api(`/api/projects/${PID}/architecture`)
  const byParent = new Map<string | undefined, Json[]>()
  for (const c of components) { const k = c.parentId ?? undefined; const a = byParent.get(k) ?? []; a.push(c); byParent.set(k, a) }
  function cnode(c: Json, depth: number): string {
    const kids = (byParent.get(c.id) ?? []).map(k => cnode(k, depth + 1)).join("")
    const d = c.derived ?? {}
    return `<div class="tnode" style="margin-left:${depth * 18}px"><div class="trow">
      ${chip(c.status)} <b>${esc(c.name)}</b> <span class="mono amuted">${esc(c.id)}</span>
      <span class="troll">${d.readiness ?? 0}% ${natureTag(d.nature ?? "missing")} · ${d.taskCount ?? 0} tasks</span>
      <span class="bar"><i style="width:${d.readiness ?? 0}%"></i></span></div>
      ${c.doc ? `<div class="doc" style="margin-left:20px">${esc(c.doc)}</div>` : ""}${kids}</div>`
  }
  let archHtml = ""
  if (arch.available && arch.views?.length) {
    const v = arch.views[0]
    const nodes = (arch.elements ?? []).filter((e: Json) => (v.nodes ?? []).includes(e.id))
    const W = 190, H = 56, GX = 120, GY = 30
    const pos = new Map<string, { x: number; y: number }>()
    nodes.forEach((n: Json, i: number) => pos.set(n.id, { x: 30 + (i % 3) * (W + GX), y: 20 + Math.floor(i / 3) * (H + GY) }))
    const width = 30 + Math.min(nodes.length, 3) * (W + GX), height = 40 + Math.ceil(nodes.length / 3) * (H + GY)
    let svg = `<svg width="${width}" height="${height}"><defs><marker id="a2" markerWidth="10" markerHeight="10" refX="8" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#7dd3fc"/></marker></defs>`
    for (const e of v.edges ?? []) {
      const a = pos.get(e.source), b = pos.get(e.target)
      if (!a || !b) continue
      svg += `<path d="M${a.x + W},${a.y + H / 2} C${a.x + W + 50},${a.y + H / 2} ${b.x - 50},${b.y + H / 2} ${b.x - 4},${b.y + H / 2}" fill="none" stroke="#7dd3fc" stroke-width="1.4" stroke-dasharray="6,4" marker-end="url(#a2)"/>`
      if (e.label) svg += `<text x="${(a.x + W + b.x) / 2}" y="${(a.y + b.y) / 2 + H / 2 - 6}" fill="#93a0bd" font-size="10" text-anchor="middle">${esc(e.label)}</text>`
    }
    for (const n of nodes) {
      const p = pos.get(n.id)!
      svg += `<rect x="${p.x}" y="${p.y}" width="${W}" height="${H}" rx="8" fill="#141b2e" stroke="#2a3554"/><text x="${p.x + 12}" y="${p.y + 22}" fill="#e6ebf5" font-size="12" font-weight="600">${esc(n.title)}</text><text x="${p.x + 12}" y="${p.y + 40}" fill="#7dd3fc" font-size="10">${esc(n.technology ?? n.kind ?? "")}</text>`
    }
    svg += "</svg>"
    archHtml = `<h3>Architecture map — ${esc(v.title)} <span class="amuted">(source: ${esc(arch.source ?? "likec4")})</span></h3><div class="graph">${svg}</div>`
  } else {
    archHtml = `<div class="unavailable"><p>⊘ ${esc(arch.message ?? "No architecture source connected.")}</p></div>`
  }
  main.innerHTML = `<h2>Components</h2>${banner(meta.mode, meta.limitations)}
  ${components.length ? components.filter((c: Json) => !c.parentId).map((c: Json) => cnode(c, 0)).join("") : '<div class="empty">No components reported.</div>'}
  ${archHtml}`
}

// ---------- metrics ----------
async function renderMetrics(main: HTMLElement): Promise<void> {
  const { current } = await api(`/api/projects/${PID}/metrics`)
  const m = current.metrics ?? {}, cov = current.coverage ?? {}
  const labels: Record<string, string> = {
    throughput_7d: "Throughput (7d)", lead_time_hours_avg: "Lead time avg (h)", wip: "WIP", blocked: "Blocked",
    tasks_total: "Tasks total", agents_working: "Agents working", agents_total: "Agents total",
    pipeline_success_rate: "Pipeline success (%)", queue_wait_avg_min: "Queue wait avg (min)", queue_depth: "Queue depth",
  }
  main.innerHTML = `<h2>Metrics</h2>
  <p class="muted">Computed only from verified data. Null = insufficient data (never fabricated). Snapshot: ${fmtTime(current.at)}</p>
  <div class="kpis">${Object.entries(m).map(([k, v]) => `<div class="kpi"><div class="lbl">${esc(labels[k] ?? k)}</div><div class="val">${v === null ? "—" : v}</div><div class="sub">${esc(cov[k] ?? "")}</div></div>`).join("")}</div>`
}

// ---------- activity ----------
async function renderActivity(main: HTMLElement): Promise<void> {
  const res = await api(`/api/projects/${PID}/activity?limit=200`)
  main.innerHTML = `<h2>Activity / Events</h2>
  <div class="filterbar"><input id="aType" placeholder="filter by type prefix (e.g. task.)"><span class="muted">${res.events.length} events · log seq ${res.lastSeq}</span></div>
  <div id="aTable">${activityTable(res.events)}</div>`
  $("aType").oninput = async () => {
    const v = ($("aType") as HTMLInputElement).value
    const r = await api(`/api/projects/${PID}/activity?limit=200&type=${encodeURIComponent(v)}`)
    $("aTable").innerHTML = activityTable(r.events)
  }
}

// ---------- integrations ----------
async function renderIntegrations(main: HTMLElement): Promise<void> {
  const integ = await api(`/api/projects/${PID}/integrations`)
  const caps = await api(`/api/projects/${PID}/capabilities`)
  const doctor = await api(`/api/projects/${PID}/doctor`)
  const adapters = integ.adapters ?? []
  const sync = integ.sync ?? {}
  const fresh = integ.freshness ?? {}
  const capRows = Object.values(caps.capabilities ?? {}).map((c: any) => `<tr>
    <td><b>${esc(c.id)}</b></td><td>${chip(c.status)}</td><td class="mono">${esc(c.adapterId ?? "—")}</td>
    <td>${esc(c.confidence)}</td><td class="mono">${ago(c.lastSyncAt)}</td>
    <td class="reason">${(c.limitations ?? []).map(esc).join("; ") || "—"}</td></tr>`).join("")
  const rec = integ.lastReconciliation
  main.innerHTML = `<h2>Integrations / Harness Health</h2>
  <div class="filterbar">
    <button class="btn" id="iDiscover">Discover</button>
    <button class="btn" id="iSync">Sync</button>
    <button class="btn" id="iReconcile">Reconcile</button>
    <button class="btn" id="iDiff">Integration diff</button>
    <span class="muted">doctor: ${doctor.healthy ? '<span style="color:#22c55e">healthy</span>' : '<span style="color:#f59e0b">issues found</span>'}</span>
  </div>
  <h3>Discovered harness</h3>
  <p class="mono">${(integ.discovery?.detectedTools ?? []).map(esc).join(" · ") || "not discovered yet"}</p>
  <h3>Adapters</h3>
  <table><tr><th>Adapter</th><th>Kind</th><th>Version</th><th>Capabilities</th><th>Sync</th><th>Last success</th><th>Errors</th></tr>
  ${adapters.map((a: Json) => {
    const s = sync[a.id] ?? {}, f = fresh[a.id] ?? {}
    return `<tr><td><b>${esc(a.id)}</b><div class="amuted">${esc(a.title)}</div></td><td>${esc(a.kind)}</td><td class="mono">${esc(a.version)}</td>
    <td class="mono">${(a.capabilities ?? []).map(esc).join(", ")}</td>
    <td>${chip(s.state ?? "never")}${f.stale ? ' <span class="stalewarn">stale</span>' : ""}</td>
    <td class="mono">${ago(s.lastSuccessAt)}</td><td>${s.errors?.length ?? 0}</td></tr>`
  }).join("")}</table>
  <h3>Capability matrix</h3>
  <table><tr><th>Capability</th><th>Status</th><th>Adapter</th><th>Confidence</th><th>Last sync</th><th>Limitations</th></tr>${capRows}</table>
  <h3>Doctor checks</h3>
  <table><tr><th>Check</th><th>Result</th><th>Detail</th></tr>
  ${doctor.checks.map((c: Json) => `<tr><td>${esc(c.name)}</td><td>${c.ok ? '<span style="color:#22c55e">✓</span>' : '<span style="color:#ef4444">✗</span>'}</td><td class="reason">${esc(c.detail)}</td></tr>`).join("")}</table>
  ${doctor.recommendations.length ? `<h3>Recommendations</h3>${doctor.recommendations.map((r: string) => `<div class="alert info">${esc(r)}</div>`).join("")}` : ""}
  ${rec ? `<h3>Last reconciliation (${fmtTime(rec.at)})</h3>
    <p class="muted">drift changes: ${rec.drift?.changes?.length ?? 0} · manifest updated: ${rec.manifestUpdated} · verified: ${rec.verified}</p>
    ${(rec.actions ?? []).map((a: Json) => `<div class="hist">${chip(a.category === "A" ? "success" : a.category === "B" ? "waiting" : "failed", "cat " + a.category)} <b>${esc(a.action)}</b> ${esc(a.target)} — ${a.applied ? "applied" : a.requiresApproval ? "needs approval" : "pending"}<div class="amuted">${esc(a.detail)}</div></div>`).join("")}` : ""}
  <div id="iResult"></div>`
  const showResult = (v: unknown) => { $("iResult").innerHTML = `<h3>Result</h3><pre class="json">${esc(JSON.stringify(v, null, 2).slice(0, 6000))}</pre>` }
  $("iDiscover").onclick = async () => showResult(await api(`/api/projects/${PID}/discover`, "POST"))
  $("iSync").onclick = async () => showResult(await api(`/api/projects/${PID}/sync`, "POST"))
  $("iReconcile").onclick = async () => showResult(await api(`/api/projects/${PID}/reconcile`, "POST", { approve: [] }))
  $("iDiff").onclick = async () => showResult(await api(`/api/projects/${PID}/integration/diff`))
}

// ---------- settings ----------
async function renderSettings(main: HTMLElement): Promise<void> {
  const ov = await api(`/api/projects/${PID}`)
  const cfg = await api(`/api/projects/${PID}/dashboard-config`)
  main.innerHTML = `<h2>Settings</h2>
  <h3>Project</h3>
  <div class="kvgrid">
    <div><b>ID</b> <span class="mono">${esc(ov.project?.id)}</span></div>
    <div><b>Name</b> ${esc(ov.project?.name)}</div>
    <div><b>Root</b> <span class="mono">${esc(ov.project?.root)}</span></div>
    <div><b>Registered</b> ${fmtTime(ov.project?.registeredAt)}</div>
    <div><b>Core version</b> ${esc(ov.project?.coreVersion)} · <b>Plugin</b> ${esc(ov.project?.pluginVersion ?? "not connected")}</div>
  </div>
  <h3>Dashboard configuration (computed from Capability Manifest)</h3>
  <pre class="json">${esc(JSON.stringify(cfg.sections.map((s: Json) => ({ id: s.id, visible: s.visible, mode: s.mode })), null, 2))}</pre>
  <p class="muted">Project integration config lives in <code>&lt;project&gt;/.dark-factory/config/project.json</code> (adapters, permissions, authoritative sources). Edit it there or via the Setup Agent; changes are tracked and reversible.</p>`
}

// ---------- router ----------
window.addEventListener("hashchange", () => renderSection())
boot().catch(e => { $("app").innerHTML = `<div class="error">Boot failed: ${esc(e.message)}</div>` })
