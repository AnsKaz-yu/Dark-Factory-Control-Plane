import { Plugin } from "@opencode/plugin"
import { createServer, type Server } from "node:http"
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmdirSync, renameSync, readdirSync, openSync, watch, statSync, appendFileSync, type FSWatcher } from "node:fs"
import { loadStateSafe } from "./state-io.js"
import { execFileSync, spawn } from "node:child_process"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = 8091

// ---- paths ----
function resolveProject(ctx: any): string {
  if (ctx.options?.projectDir) return resolve(ctx.options.projectDir)
  const dir = ctx.location?.directory || process.cwd()
  // Task worktree: the canonical dashboard state lives in the MAIN product repo.
  // Without this, a worktree-cwd session seeds a SHADOW project-state.json and its
  // project_* writes (task_update done, report_tests) never reach the live dashboard
  // /dispatcher — the ADR-019 loop stalls (incident 2026-11-17, spawned CliAgents).
  // git-common-dir of a worktree points at <main-repo>/.git; redirect there.
  // git может отсутствовать в PATH spawned-сессий (DMTools CliAgent) — fallback на
  // абсолютный путь Git for Windows (иначе фикс молча не работает: shadow state).
  const gitCandidates = ["git", "C:\\Program Files\\Git\\cmd\\git.exe"]
  for (const git of gitCandidates) {
    try {
      const common = execFileSync(git, ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim()
      const main = dirname(common)
      if (resolve(main) !== resolve(dir) && (existsSync(join(main, "project-state.json")) || existsSync(join(main, "crates")))) return main
      break
    } catch { /* not a git repo / git unavailable — try next candidate / fall through */ }
  }
  // Fallback (incident 2026-11-17, T-003a worker): the opencode server process may
  // have no `git` on PATH even when interactive shells do — the execFileSync above
  // then silently fails and worktree sessions write a SHADOW state. A worktree's
  // `.git` is a FILE "gitdir: <main>/.git/worktrees/<name>"; derive the main repo
  // from it without any external tool.
  try {
    const gitPath = join(dir, ".git")
    if (existsSync(gitPath) && !statSync(gitPath).isDirectory()) {
      const m = readFileSync(gitPath, "utf8").match(/^gitdir:\s*(.+)\s*$/m)
      if (m) {
        const gitdir = resolve(dir, m[1].trim())
        // <main>/.git/worktrees/<name> → <main>
        const main = resolve(gitdir, "..", "..", "..")
        if (resolve(main) !== resolve(dir) && (existsSync(join(main, "project-state.json")) || existsSync(join(main, "crates")))) return main
      }
    }
  } catch { /* fall through */ }
  if (existsSync(join(dir, "project-state.json"))) return dir
  if (existsSync(join(dir, "ReservoirOS"))) return join(dir, "ReservoirOS")
  return dir
}
const statePath = (proj: string) => join(proj, "project-state.json")
const seedPath = () => join(HERE, "seed.json")

// ---- state ----
let cache: any = null
let cacheProj = ""
function loadState(proj: string): any {
  // T-STATE-SYNC/T-STATE-RECOVERY (аудит B6): BOM-tolerant парсинг + NON-DESTRUCTIVE recovery.
  // Повреждённый существующий файл сохраняется как .corrupt-<ts> backup + journal event,
  // и только затем re-seed. Молчаливый разрушительный re-seed (потеря 45+ задач, инцидент
  // T-020) устранён. Логика — в state-io.js (unit-тестируема).
  const p = statePath(proj)
  return loadStateSafe({
    exists: (x: string) => existsSync(x),
    read: (x: string) => readFileSync(x, "utf8"),
    rename: (a: string, b: string) => renameSync(a, b),
    write: (x: string, data: string) => writeFileSync(x, data, "utf8"),
    mkdirp: (x: string) => mkdirSync(dirname(x), { recursive: true }),
    seed: () => JSON.parse(readFileSync(seedPath(), "utf8")),
    journal: (entry: any) => {
      try { appendFileSync(join(dirname(p), "project-state.journal.jsonl"), JSON.stringify(entry) + "\n", "utf8") } catch { /* best-effort */ }
    },
    now: () => new Date().toISOString().replace(/[:.]/g, "-"),
  }, p)
}
function getState(proj: string): any {
  if (!cache || cacheProj !== proj) { cache = loadState(proj); cacheProj = proj }
  return cache
}
// serialized mutations (multi-agent safe)
// AUDIT 2026-11-19 (C5): CROSS-PROCESS lock (atomic mkdir + owner-PID liveness) + per-PID tmp.
// Previously: in-process promise-queue only + fixed ".tmp" -> two opencode instances (desktop +
// standalone dashboard + worktree shadows) corrupted each other's writes / lost updates / re-seed.
let queue: Promise<any> = Promise.resolve()
function acquireStateLock(proj: string): () => void {
  const lockDir = statePath(proj) + ".lock"
  const pidFile = join(lockDir, "owner")
  const deadline = Date.now() + 30000
  for (;;) {
    try {
      mkdirSync(lockDir)                 // atomic on Windows; throws if another process holds it
      try { writeFileSync(pidFile, String(process.pid), "utf8") } catch {}
      return () => { try { rmdirSync(lockDir, { recursive: true }) } catch {} }
    } catch {
      let stale = false
      try {
        const pid = parseInt(readFileSync(pidFile, "utf8"), 10)
        try { process.kill(pid, 0) } catch { stale = true }   // owner process dead
        if (Date.now() - statSync(lockDir).mtimeMs > 60000) stale = true  // PID-reuse / hung fallback
      } catch { stale = true }
      if (stale) { try { rmdirSync(lockDir, { recursive: true }) } catch {} ; continue }
      if (Date.now() > deadline) throw new Error("state lock timeout: " + lockDir)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)  // sync sleep 100ms
    }
  }
}
function mutate(proj: string, fn: (s: any) => void): Promise<any> {
  const run = queue.then(() => {
    const release = acquireStateLock(proj)
    try {
      const s = loadState(proj) // fresh read under cross-process lock
      fn(s)
      s.updated = new Date().toISOString()
      const p = statePath(proj)
      const tmp = p + ".tmp-" + process.pid   // per-PID tmp (no cross-process collision)
      writeFileSync(tmp, JSON.stringify(s, null, 2), "utf8")
      renameSync(tmp, p)
      cache = s; cacheProj = proj
      broadcast(s)
      return s
    } finally { release() }
  })
  queue = run.catch(() => {})
  return run
}

// ---- tree helpers ----
function findNode(node: any, id: string): any {
  if (node.id === id) return node
  for (const c of node.children || []) { const r = findNode(c, id); if (r) return r }
  return null
}
function walk(node: any, fn: (n: any) => void) { fn(node); (node.children || []).forEach((c: any) => walk(c, fn)) }
// Готовность — производная от задач поддерева (своевременный автопересчёт):
//  • узел с задачами в поддереве → средний прогресс задач (done=100, иначе progress);
//  • узел без задач, но с детьми → среднее детей;
//  • лист без задач → наследует готовность ближайшего предка с задачами (иначе ручная/статус).
// Правдивый прогресс задачи: done=100; in-progress = max(reported, пол по стадии loop) —
// чтобы задача в работе не показывала 0% только потому, что агент не проставил progress.
const STAGE_FLOOR: Record<string, number> = { feature: 5, red: 20, implement: 45, green: 65, gates: 80, c4: 88, chronology: 92, commit: 96, ci: 100 }
function taskProgress(t: any): number {
  if (t.status === "done") return 100
  if (t.status === "in-progress") return Math.max(t.progress || 0, STAGE_FLOOR[t.loopStage] ?? 0)
  return 0
}
function recomputeReadiness(root: any, tasks: any): void {
  const all = Object.values(tasks || {}) as any[]
  const ids = (n: any): string[] => { let a = [n.id]; (n.children || []).forEach((c: any) => a = a.concat(ids(c))); return a }
  const avg = (ts: any[]) => Math.round(ts.reduce((a, t) => a + taskProgress(t), 0) / ts.length)
  const subTasks = (n: any) => { const set = new Set(ids(n)); return all.filter(t => set.has(t.component)) }
  function up(n: any) {
    (n.children || []).forEach(up)
    const ts = subTasks(n)
    if (ts.length) n.readiness = avg(ts)
    else if ((n.children || []).length) n.readiness = Math.round(n.children.reduce((a: number, c: any) => a + (c.readiness ?? 0), 0) / n.children.length)
  }
  function down(n: any, inh: number | null) {
    const ts = subTasks(n)
    const here = ts.length ? n.readiness : inh
    // наследование только для внутренних подмодулей (kind=code); самостоятельные узлы без задач — ручная/статус
    if (!ts.length && !(n.children || []).length && n.kind === "code") n.readiness = inh ?? n.readiness ?? (n.status === "done" ? 100 : 0)
    ;(n.children || []).forEach((c: any) => down(c, here))
  }
  up(root); down(root, null)
}
// Реестр агентов: при завершении задачи помечаем агента (ссылку на задачу сохраняем для атрибуции),
// при освобождении — открепляем. Активность на дашборде определяется статусом задачи + владельцем.
function markAgentDone(st: any, taskId: string): void {
  if (!st.agents) return
  for (const a of Object.keys(st.agents)) {
    if (st.agents[a].task === taskId) { st.agents[a].note = "completed"; st.agents[a].lastSeen = new Date().toISOString() }
  }
}
function detachAgents(st: any, taskId: string): void {
  if (!st.agents) return
  for (const a of Object.keys(st.agents)) {
    if (st.agents[a].task === taskId) { st.agents[a].task = null; st.agents[a].note = "released"; st.agents[a].lastSeen = new Date().toISOString() }
  }
}
// Агенты DMTools (CliAgent): реестр .locks/dmtools-agents.json, который пишут start-task.ps1
// (status=running при старте) и post_gate.js (done/failed после гейтов). Читаем отдельно от
// opencode-агентов (st.agents), чтобы не смешивать источники и не конкурировать за запись state.
function readDmtoolsAgents(proj: string): any[] {
  const harness = join(dirname(proj), "ReservoirOS-harness")
  const p = join(harness, ".locks", "dmtools-agents.json")
  try {
    let txt = readFileSync(p, "utf8")
    if (txt.charCodeAt(0) === 0xFEFF) txt = txt.slice(1) // PowerShell Set-Content пишет UTF-8 BOM
    const reg = JSON.parse(txt)
    return Object.entries(reg).map(([name, v]: any) => ({ name, ...(v as any), source: "dmtools" }))
  } catch { return [] }
}

// Архитектор-аналитик (механически, v2): автономное обнаружение задач из РАЗНЫХ источников
// прогресса (не только статусы модели): (1) stub/vacuous гейты и not-enforced механизмы;
// (2) непокрытые P0-требования (трассировка); (3) oracle-расхождения с эталоном (FAIL);
// (4) проваленные гейты последнего прогона; (5) отсутствующий бинарь для авто-активации oracle.
// Идемпотентно. Авто-запуск при завершении задачи (task_update done) + project_architect_review.
const MAX_FIX_ATTEMPTS = 3 // лимит итераций исправления до эскалации человеку (§6.8)
function architectReview(st: any, proj: string): string[] {
  const harness = join(dirname(proj), "ReservoirOS-harness")
  const root = dirname(proj)
  const created: string[] = []
  const mk = (id: string, title: string, component: string, req: string, doc: string, blockedBy: string[] = []) => {
    if (st.tasks[id]) return
    st.tasks[id] = { id, title, component, status: blockedBy.length ? "blocked" : "ready", loopStage: "feature", blockedBy, owner: null, requirement: req, progress: 0, doc, tests: null, auto: true }
    created.push(id)
  }
  // (1) статусы гейтов/инструментов из harness-model.json
  let model: any = null
  try { model = JSON.parse(readFileSync(join(harness, "harness-model.json"), "utf8")) } catch { /* ignore */ }
  for (const g of model?.gates || []) {
    if (g.status === "stub") mk("T-GATE-" + g.id, `Реализовать гейт ${g.id} (${g.name})`, "reservoiros.harness", "REQ-22", `Гейт ${g.id} — заглушка. ${g.note || ""}`)
    else if (g.status === "vacuous") mk("T-GATE-" + g.id, `Наполнить гейт ${g.id} реальными проверками`, "reservoiros.harness", "REQ-22", `Гейт ${g.id} проходит без реальной проверки. ${g.note || ""}`)
  }
  for (const t of model?.tools || []) {
    if (t.status === "not-enforced" && /branch protection/i.test(t.name)) {
      mk("T-BRANCH-PROTECTION", "Включить server-side branch protection (develop/master)", "reservoiros.harness", "REQ-20", "admin-API GitHub 403 для текущих токенов; нужен admin-токен или настройка UI. PR-дисциплина сейчас через merge-queue + pre-push hook.")
    }
  }
  // (2) трассировка требований: обновить отчёт и создать задачи по непокрытым P0-REQ
  let trace: any = null
  try {
    const py = join(root, "tools", "python39", "python.exe")
    if (existsSync(py)) execFileSync(py, [join(harness, "scripts", "traceability.py"), "--product", proj, "--harness", harness], { encoding: "utf8", stdio: ["ignore", "ignore", "ignore"] })
  } catch { /* отчёт может уже существовать */ }
  try { trace = JSON.parse(readFileSync(join(harness, "reports", "traceability.json"), "utf8")) } catch { /* ignore */ }
  for (const rid of trace?.summary?.uncovered_p0 || []) {
    const r = trace.requirements?.[rid] || {}
    mk("T-" + rid, `Реализовать требование ${rid}: ${r.title || ""}`, "reservoiros", rid, `Непокрытое P0-требование (авто-трассировка). Категория: ${r.category || ""}. Критерии приёмки — docs/requirements_registry.md. Изучить референсную документацию Phase 1 по домену; декомпозировать на подзадачи; TDD red-first + oracle-сверка.`)
  }
  // (3) поведенческие расхождения с эталоном (oracle FAIL) -> задачи исправления
  let suite: any = null
  try { suite = JSON.parse(readFileSync(join(harness, "oracle", "reports", "suite-report.json"), "utf8")) } catch { /* ignore */ }
  for (const o of suite?.oracles || []) {
    if (o.status === "fail") mk("T-ORACLE-" + o.name, `Исправить расхождение с эталоном: ${o.name} (${o.domain})`, "reservoiros.engine", "REQ-03/21", `Oracle-сверка FAIL по кейсу ${o.name}. Воспроизвести сценарий (Given/When/Then), определить нарушенное требование, исправить реализацию, повторить сверку + связанные регрессионные тесты. Порог домена: ${suite.thresholds?.[o.domain] ?? "default"}.`)
  }
  // (4) проваленные гейты последнего DMTools-прогона -> задачи починки
  let gr: any = null
  try { gr = JSON.parse(readFileSync(join(harness, "reports", "dmtools-gates-run.json"), "utf8")) } catch { /* ignore */ }
  for (const [gid, res] of Object.entries(gr?.gates || {})) {
    if (res === "fail") mk("T-FIX-GATE-" + gid, `Починить гейт ${gid} (fail на последнем прогоне)`, "reservoiros.harness", "REQ-22", `Гейт ${gid} = fail (reports/dmtools-gates-run.json). Диагностика + исправление; повторный прогон через DMTools. Лимит итераций ${MAX_FIX_ATTEMPTS}, затем эскалация.`)
  }
  // (5) отсутствующий бинарь для авто-активации oracle/determinism (data-driven, не hardcoded)
  const condOracle = (model?.gates || []).some((g: any) => ["G4", "G9", "G13"].includes(g.id) && g.status === "conditional")
  const hasCliTask = Object.values(st.tasks).some((t: any) => /CLI|бинарь|runner/i.test(t.title || ""))
  if (condOracle && !hasCliTask) mk("T-CLI-RUNNER", "CLI-раннер симулятора (бинарь для авто-активации G4/G9/G13)", "reservoiros.engine.core", "REQ-03/21", "Бинарь reservoiros run --deck --out --threads; авто-активация oracle/determinism гейтов при появлении.", ["T-006"])
  // ADR-040: новые gap-задачи сразу получают product-zone по component (dispatcher-ready).
  autoAssignZones(proj, st)
  return created
}

// ---- parallel auto-dispatch (ADR-019): fill free slots (maxParallel, default 3) with ready tasks ----
const MAX_PARALLEL = 3
// BOM-tolerant JSON read: PowerShell Set-Content -Encoding UTF8 writes a UTF-8 BOM, which breaks
// JSON.parse (auto-resolver saw empty dead-letter). Strip BOM before parsing.
function readJson(p: string): any {
  let txt = readFileSync(p, "utf8")
  if (txt.charCodeAt(0) === 0xFEFF) txt = txt.slice(1)
  return JSON.parse(txt)
}
function readZones(proj: string): Record<string, any> {
  const harness = join(dirname(proj), "ReservoirOS-harness")
  try { return JSON.parse(readFileSync(join(harness, "dashboard", "zones.json"), "utf8")).tasks || {} } catch { return {} }
}
// ADR-040: auto-zone gap-задач. Mapping component->crate (reservoiros.engine.physics.blackoil ->
// crates/physics/blackoil, проверка Cargo.toml) + авто-проставление zones при создании/диспетчеризации.
// Иначе gap-задачи без zones не диспетчеризуются (dispatcher idle). Идемпотентно (zone есть -> skip).
function componentToCrate(proj: string, component: string): string | null {
  if (!component) return null
  const c = component.replace(/^reservoiros\./, "").replace(/^engine\./, "")
  const crate = "crates/" + c.replace(/\./g, "/")
  try { if (existsSync(join(proj, crate, "Cargo.toml"))) return crate } catch { /* ignore */ }
  return null
}
function autoAssignZones(proj: string, st: any): number {
  const harness = join(dirname(proj), "ReservoirOS-harness")
  const zf = join(harness, "dashboard", "zones.json")
  let z: any = null
  try { z = JSON.parse(readFileSync(zf, "utf8")) } catch { return 0 }
  z.tasks = z.tasks || {}
  let added = 0
  for (const t of Object.values(st.tasks) as any[]) {
    if (!t || t.review || z.tasks[t.id]) continue
    const crate = componentToCrate(proj, t.component)
    if (crate) { z.tasks[t.id] = [crate + "/*", "Cargo.toml", "Cargo.lock"]; added++ }
  }
  if (added > 0) {
    const tmp = zf + ".tmp-" + process.pid
    try { writeFileSync(tmp, JSON.stringify(z, null, 2), "utf8"); renameSync(tmp, zf) } catch { /* ignore */ }
  }
  return added
}
function dispatchCfg(proj: string): { enabled: boolean; max: number; autoMerge: boolean; autoResolve: boolean; autoRecover: boolean; maxResolvers: number } {
  const harness = join(dirname(proj), "ReservoirOS-harness")
  // AUDIT 2026-11-19: return ALL pause knobs (previously only enabled/max -> autoMerge/autoResolve/
  // autoRecover/maxResolvers checks were DEAD branches; parallel.json pause had no effect).
  try {
    const c = JSON.parse(readFileSync(join(harness, ".local", "parallel.json"), "utf8"))
    return { enabled: c.enabled !== false, max: c.maxParallel || MAX_PARALLEL, autoMerge: c.autoMerge !== false, autoResolve: c.autoResolve !== false, autoRecover: c.autoRecover !== false, maxResolvers: c.maxResolvers || 2 }
  } catch { return { enabled: true, max: MAX_PARALLEL, autoMerge: true, autoResolve: true, autoRecover: true, maxResolvers: 2 } }
}
function launchTaskCli(proj: string, taskId: string, agent: string): void {
  const harness = join(dirname(proj), "ReservoirOS-harness")
  const script = join(harness, "dmtools", "scripts", "start-task.ps1")
  const ps = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
  const log = join(harness, ".locks", `dispatch-${taskId}.log`)
  // ADR-035 (T-DETACHED-LAUNCH): WMI Win32_Process.Create создаёт процесс через WmiPrvSE ВНЕ
  // job-object вызывающего -> агент переживает рестарт opencode-сервиса (ранее job object
  // KILL_ON_JOB_CLOSE убивал дерево потомков диспетчера). Лаунчер-файл с Start-Process+редирект
  // избегает quoting-проблем WMI CommandLine. Fallback: обычный Start-Process если WMI недоступен.
  const launcher = join(harness, ".locks", `dispatch-launch-${taskId}.ps1`)
  const startProc = `Start-Process -FilePath '${ps}' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${script}','-Task','${taskId}','-Agent','${agent}' -WindowStyle Hidden -RedirectStandardOutput '${log}' -RedirectStandardError '${log}.err'`
  try {
    writeFileSync(launcher, startProc + "\n", "utf8")
    const wmi = `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'powershell.exe -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File "${launcher}"'; CurrentDirectory = '${harness}' } | Out-Null`
    execFileSync(ps, ["-NoProfile", "-Command", wmi], { stdio: "ignore", windowsHide: true })
  } catch {
    try { execFileSync(ps, ["-NoProfile", "-Command", startProc], { stdio: "ignore", windowsHide: true }) } catch { /* ignore */ }
  }
}
// Зарезервировать готовые диспетчеризуемые задачи в свободные слоты (owner=auto-<id>, takeover в task_claim).
// Диспетчеризуемые: status=ready, не review, есть product-zone (zones.json tasks), зависимости done.
// ADR-035: приоритет P0<P1<P2<P3 + zone-overlap-awareness (один crate = один агент, без параллелизма
// задач одного crate — предотвращает конфликты файлов/cargo-lock; shared Cargo.toml/docs не в счёт).
function priorityRank(t: any): number {
  const p = String(t.priority || "P2").toUpperCase()
  return p === "P0" ? 0 : p === "P1" ? 1 : p === "P3" ? 3 : 2
}
function crateKeys(zone: string[] | undefined): Set<string> {
  const out = new Set<string>()
  for (const p of zone || []) {
    if (!p.startsWith("crates/")) continue   // shared-файлы (Cargo.toml/Cargo.lock/docs) — не crate-root
    const seg = p.split("/")
    const key = seg[1] === "physics" ? seg.slice(0, 3).join("/") : seg.slice(0, 2).join("/")
    out.add(key)
  }
  return out
}
function claimReady(st: any, proj: string, max: number): { id: string; agent: string }[] {
  const zones = readZones(proj)
  const tasks = Object.values(st.tasks) as any[]
  const active = tasks.filter(t => t.status === "in-progress")
  let free = max - active.length
  if (free <= 0) return []
  // crate-root'ы активных задач — не диспетчеризуем пересекающиеся с ними.
  const busy = new Set<string>()
  for (const t of active) for (const k of crateKeys(zones[t.id])) busy.add(k)
  const ready = tasks.filter(t => t.status === "ready" && !t.review && zones[t.id] && (t.blockedBy || []).every((d: string) => !st.tasks[d] || st.tasks[d].status === "done"))
  ready.sort((a, b) => priorityRank(a) - priorityRank(b) || String(a.id).localeCompare(String(b.id)))
  const out: { id: string; agent: string }[] = []
  for (const t of ready) {
    if (free <= 0) break
    const keys = crateKeys(zones[t.id])
    let overlap = false
    for (const k of keys) if (busy.has(k)) { overlap = true; break }
    if (overlap) continue   // zone-overlap: crate занят active/selected задачей — пропускаем
    const agent = `auto-${t.id}`
    t.status = "in-progress"; t.owner = agent; t.loopStage = "feature"; t.progress = Math.max(t.progress || 0, 5)
    st.agents = st.agents || {}
    st.agents[agent] = { task: t.id, note: "auto-dispatched", lastSeen: new Date().toISOString() }
    for (const k of keys) busy.add(k)
    out.push({ id: t.id, agent }); free--
  }
  return out
}
async function dispatch(proj: string, dryRun = false): Promise<string[]> {
  const cfg = dispatchCfg(proj)
  if (!cfg.enabled) return []
  let launches: { id: string; agent: string }[] = []
  if (dryRun) {
    // ADR-035: dryRun НЕ мутирует state (preview на клоне; фикс бага claim-in-dryRun).
    const clone = JSON.parse(JSON.stringify(getState(proj)))
    launches = claimReady(clone, proj, cfg.max)
  } else {
    await mutate(proj, (st) => { autoAssignZones(proj, st); launches = claimReady(st, proj, cfg.max) })
    for (const l of launches) launchTaskCli(proj, l.id, l.agent)
  }
  return launches.map(l => l.id + (dryRun ? " (dry)" : ""))
}

// ---- auto-merge (ADR-020): drain the merge queue automatically (close the autonomous loop) ----
// dispatch -> code -> enqueue -> AUTO-MERGE -> develop advances -> unblock dependents -> dispatch.
// Without this the queue accumulates unmerged branches and the pipeline stalls (observed 17.11:
// 10 ready branches, no merge for 7h). Spawns merge-queue process detached (non-blocking); the
// merge lock serializes (one merge at a time). Skips when a merge is in progress or queue empty.
function autoMerge(proj: string): string {
  const harness = join(dirname(proj), "ReservoirOS-harness")
  const cfg = dispatchCfg(proj)
  if (cfg.autoMerge === false) return "disabled"
  const queueFile = join(harness, ".locks", "merge-queue.json")
  try {
    if (!existsSync(queueFile)) return "empty"
    const q = readJson(queueFile)
    const items = q.items || []
    if (!items.length) return "empty"
    // AUDIT 2026-11-19: the merge worker is SELF-SERIALIZING (named mutex Global\ReservoirOS-
    // MergeWorker). Do NOT inspect/rename merge.lock here — lock-sniping by plugin+watchdog+drain
    // caused the takeover storm (8 concurrent merges). A lightweight CIM liveness skip avoids
    // spawning a process that would just exit "busy"; any concurrent spawn is harmless (mutex).
    let active = 0
    try { active = parseInt(execFileSync("powershell", ["-NoProfile", "-Command", "@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'merge-queue\\.ps1' -and $_.Name -eq 'powershell.exe' }).Count"], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim()) } catch { active = 1 }
    if (active > 0) return "busy (merge in progress)"
    const script = join(harness, "scripts", "merge-queue.ps1")
    const ps = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
    const log = join(harness, ".locks", "auto-merge.log")
    const inner = `Start-Process -FilePath '${ps}' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${script}','process' -WindowStyle Hidden -RedirectStandardOutput '${log}' -RedirectStandardError '${log}.err'`
    execFileSync(ps, ["-NoProfile", "-Command", inner], { stdio: "ignore", windowsHide: true })
    return "started merge: " + items[0].branch
  } catch (e: any) { return "error: " + (e?.message || e) }
}

// ---- auto conflict-resolution (ADR-030): spawn a subagent per dead-letter branch ----
// When a branch hits dead-letter (code rebase-conflict), spawn an opencode agent that rebases,
// resolves conflicts (union Cargo/C4, integrate code), runs merge-tier gates, pushes, re-enqueues,
// and clears dead-letter/conflict-resolving trackers. Limit concurrent resolvers (default 2).
function v2Cli(): string | null {
  const cliRoot = join(process.env.APPDATA || "", "ai.opencode.desktop", "cli")
  try {
    const dirs = readdirSync(cliRoot).map(d => join(cliRoot, d)).filter(p => existsSync(join(p, "opencode-cli.exe")))
    dirs.sort().reverse()
    return dirs.length ? join(dirs[0], "opencode-cli.exe") : null
  } catch { return null }
}
function spawnConflictResolver(proj: string, item: any): boolean {
  const harness = join(dirname(proj), "ReservoirOS-harness")
  const root = dirname(proj)
  const task = item.task, branch = item.branch
  const wt = join(root, "ReservoirOS-worktrees", task)
  try {
    if (!existsSync(join(wt, ".git"))) {
      execFileSync("C:\\Program Files\\Git\\cmd\\git.exe", ["-C", proj, "worktree", "add", wt, branch], { stdio: "ignore" })
    }
    const tpl = readFileSync(join(harness, "dmtools", "prompts", "resolve_conflicts.md"), "utf8")
    const prompt = tpl.replace(/\{\{TASK\}\}/g, task).replace(/\{\{BRANCH\}\}/g, branch)
      .replace(/\{\{CONFLICTS\}\}/g, item.conflicts || "(определи по git rebase)").replace(/\{\{WORKTREE\}\}/g, wt).replace(/\{\{HARNESS\}\}/g, harness)
    const stdinFile = join(harness, ".locks", `conflict-prompt-${task}.txt`)
    writeFileSync(stdinFile, prompt, "utf8")
    const cli = v2Cli()
    if (!cli) return false
    const ps = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
    const outLog = join(harness, ".locks", `conflict-run-${task}.log`)
    const inner = `Start-Process -FilePath '${cli}' -ArgumentList 'run','--auto','--print-logs' -WorkingDirectory '${wt}' -RedirectStandardInput '${stdinFile}' -RedirectStandardOutput '${outLog}' -RedirectStandardError '${outLog}.err' -WindowStyle Hidden`
    execFileSync(ps, ["-NoProfile", "-Command", inner], { stdio: "ignore", windowsHide: true })
    return true
  } catch { return false }
}
function autoResolveConflicts(proj: string): string[] {
  const harness = join(dirname(proj), "ReservoirOS-harness")
  const cfg = dispatchCfg(proj) as any
  if (cfg.autoResolve === false) return []
  const maxResolvers = cfg.maxResolvers || 2
  let dl: any = { items: [] }
  try { dl = readJson(join(harness, ".locks", "merge-deadletter.json")) } catch { return [] }
  const trFile = join(harness, ".locks", "conflict-resolving.json")
  let tr: any = {}
  try { tr = readJson(trFile) } catch { /* ignore */ }
  const now = Date.now()
  // ADR-035 resolver-liveness: stale по ПОСЛЕДНЕЙ АКТИВНОСТИ (log mtime / heartbeat lastSeen),
  // а не fixed TTL от старта. Резолвер, ждущий гейт-мьютекс (>30 мин), НЕ stale пока пишет
  // лог/heartbeat → устраняет дубль-резолверы (T-010: stale-respawn пока первый ещё жив).
  // Grace 45 мин > максимального ожидания гейтов; мёртв/завис > grace → retry.
  const RESOLVER_GRACE = 45 * 60 * 1000
  for (const k of Object.keys(tr)) {
    let last = Date.parse(tr[k].started) || 0
    if (tr[k].lastSeen) { const ls = Date.parse(tr[k].lastSeen); if (ls > last) last = ls }
    try { const lg = statSync(join(harness, ".locks", `conflict-run-${k}.log`)).mtimeMs; if (lg > last) last = lg } catch { /* no log yet */ }
    if (now - last > RESOLVER_GRACE) delete tr[k]
  }
  const spawned: string[] = []
  let free = maxResolvers - Object.keys(tr).length
  for (const item of (dl.items || [])) {
    if (free <= 0) break
    if (tr[item.task]) continue
    // AUDIT 2026-11-19: gate-fail dead-letters need code fixes (coordinator/architect), not a
    // conflict-resolver (which rebases + re-runs gates). Only rebase-conflict items get resolvers.
    if (item.reason === "gate-fail") continue
    if (spawnConflictResolver(proj, item)) { tr[item.task] = { branch: item.branch, started: new Date().toISOString() }; spawned.push(item.task); free-- }
  }
  // AUDIT 2026-11-19 (C4): atomic per-PID tmp+rename (was direct writeFileSync -> raced with
  // resolver heartbeat/cleanup, resurrecting cleared entries -> duplicate resolvers).
  try { const tmp = trFile + ".tmp-" + process.pid; writeFileSync(tmp, JSON.stringify(tr, null, 2), "utf8"); renameSync(tmp, trFile) } catch { /* ignore */ }
  return spawned
}

// ---- auto-recovery (ADR-035, T-RECOVERY): перезапуск зависших in-progress агентов ----
// In-progress задача с мёртвым агентом (heartbeat/log stale) и работой (progress>5) -> relaunch.
// Liveness-guard исключает дубли: жив = свежий heartbeat ИЛИ mtime worker-лога < grace.
// Задача уже занимает слот (in-progress) — перезапуск не увеличивает параллелизм; batch<=2/цикл.
function agentAlive(st: any, harness: string, t: any): boolean {
  const GRACE = 20 * 60 * 1000
  const now = Date.now()
  if (t.owner && st.agents && st.agents[t.owner]) {
    const ls = Date.parse(st.agents[t.owner].lastSeen)
    if (ls && now - ls < GRACE) return true
  }
  try { if (now - statSync(join(harness, ".locks", `opencode-run-${t.id}.log`)).mtimeMs < GRACE) return true } catch { /* no log */ }
  // Недавний диспетч/рестарт (dispatch-log fresh) = агент стартует -> не рестартовать снова (anti-loop).
  try { if (now - statSync(join(harness, ".locks", `dispatch-${t.id}.log`)).mtimeMs < GRACE) return true } catch { /* no log */ }
  return false
}
const recoverCounts = new Map<string, number>()
const MAX_RECOVER = 3
function autoRecover(proj: string): string[] {
  const harness = join(dirname(proj), "ReservoirOS-harness")
  const cfg = dispatchCfg(proj)
  if (cfg.autoRecover === false) return []
  // AUDIT 2026-11-19 (C1/C10): FRESH disk read, not getState cache (stale cache resurrected
  // done/merged tasks every ~20 min). Canonical git barrier + relaunch attempts cap.
  const st = loadState(proj)
  const tasks = Object.values(st.tasks) as any[]
  const restarted: string[] = []
  for (const t of tasks) {
    if (restarted.length >= 2) break
    if (t.status !== "in-progress" || !t.owner) continue
    // Только auto-dispatched задачи (owner=auto-*): manual/solver-agent задачи не трогаем.
    if (!String(t.owner).startsWith("auto-")) continue
    if (agentAlive(st, harness, t)) { recoverCounts.delete(t.id); continue }  // жив/стартует -> не трогаем
    // canonical barrier: branch already merged into develop -> closed, do not relaunch.
    try {
      execFileSync("C:\\Program Files\\Git\\cmd\\git.exe", ["-C", proj, "merge-base", "--is-ancestor", `origin/feature/${t.id}`, "origin/develop"], { stdio: ["ignore", "ignore", "ignore"] })
      continue   // merged (exit 0) -> skip
    } catch { /* not merged / no branch -> eligible for recovery */ }
    const n = (recoverCounts.get(t.id) || 0) + 1
    recoverCounts.set(t.id, n)
    if (n > MAX_RECOVER) continue   // stop infinite relaunch loop (needs human/coordinator)
    launchTaskCli(proj, t.id, t.owner)   // start-task.ps1 enforces the canonical barrier too
    restarted.push(t.id)
  }
  return restarted
}

// ---- SSE / server ----
const clients = new Set<any>()
function broadcast(s: any) {
  const msg = `data: ${JSON.stringify({ type: "state", updated: s.updated })}\n\n`
  for (const res of clients) { try { res.write(msg) } catch { clients.delete(res) } }
}
let server: Server | null = null
let watcher: FSWatcher | null = null
function lastGitCommit(repoPath: string): string | null {
  try {
    const out = execFileSync("git", ["-C", repoPath, "log", "-1", "--format=%cI"], { encoding: "utf8" }).trim()
    return out || null
  } catch { return null }
}
// «данные от»: max(время мутации состояния, последние коммиты ReservoirOS и harness) — реальная активность агентов.
function dataUpdated(proj: string, stateUpdated: string): string {
  const harness = join(dirname(proj), "ReservoirOS-harness")
  const times = [stateUpdated, lastGitCommit(proj), lastGitCommit(harness)]
    .filter(Boolean).map(t => Date.parse(t as string)).filter(n => !isNaN(n))
  return times.length ? new Date(Math.max(...times)).toISOString() : (stateUpdated || new Date().toISOString())
}
function startServer(proj: string): number {
  if (server && server.listening) return PORT
  if (server) { try { server.close() } catch {} ; server = null }
  server = createServer((req, res) => {
    const url = (req.url || "/").split("?")[0]
    if (url === "/" || url === "/index.html") {
      const html = readFileSync(join(HERE, "dashboard.html"), "utf8")
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
      res.end(html)
    } else if (url === "/state") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
      const st = getState(proj)
      res.end(JSON.stringify({ ...st, dmtoolsAgents: readDmtoolsAgents(proj), gitUpdated: dataUpdated(proj, st.updated) }))
    } else if (url === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" })
      res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`)
      clients.add(res)
      req.on("close", () => clients.delete(res))
    } else if (url === "/diagrams" || url === "/c4") {
      // UML-диаграммы из C4-модели LikeC4 (рендер на клиенте). Если C4 нет — заглушка.
      const modelPath = join(proj, "architecture", "dist", "model.json")
      const mapping: Record<string, string[]> = {
        "reservoiros": ["c1-context", "c2-containers"],
        "reservoiros.engine": ["c3-engine"],
        "reservoiros.engine.core": ["c4-core"],
        "reservoiros.engine.solver": ["c4-solver"],
        "reservoiros.engine.physics": ["c4-physics"],
        "reservoiros.engine.io": ["c4-io"],
        "reservoiros.engine.parallel": ["c4-parallel"],
        "reservoiros.engine.gpu": ["c4-gpu"],
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
      if (existsSync(modelPath)) {
        try {
          let m = JSON.parse(readFileSync(modelPath, "utf8")); if (Array.isArray(m)) m = m[0]
          res.end(JSON.stringify({ available: true, projectId: m.projectId, views: m.views, elements: m.elements, relations: m.relations, mapping }))
        } catch { res.end(JSON.stringify({ available: false, message: "Ошибка чтения C4-модели." })) }
      } else {
        res.end(JSON.stringify({ available: false, message: "C4-документация не найдена. Если в проекте появится C4 (LikeC4), здесь появятся UML-диаграммы компонентов." }))
      }
    } else {
      res.writeHead(404); res.end("not found")
    }
  })
  server.on("error", () => { try { server?.close() } catch {} ; server = null })
  server.listen(PORT, "127.0.0.1")
  // watch state file for external edits (other agents / manual)
  try {
    watcher = watch(statePath(proj), { persistent: false }, () => {
      // AUDIT 2026-11-19: BOM-strip (PS 5.1 external writers add U+FEFF; JSON.parse threw ->
      // cache stayed stale forever -> autoRecover/dispatch acted on obsolete state - C5).
      try { let raw = readFileSync(statePath(proj), "utf8"); if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); cache = JSON.parse(raw); cacheProj = proj; broadcast(cache) } catch {}
    })
  } catch {}
  return PORT
}

export default Plugin.define({
  id: "reservoiros-dashboard",
  async setup(ctx) {
    const proj = resolveProject(ctx)
    // Надёжный запуск сервера при загрузке плагина (не только по dashboard_open),
    // чтобы дашборд не «висел» в connecting… после перезагрузки плагина.
    try { getState(proj); startServer(proj) } catch { /* сервер поднимется по dashboard_open */ }

    // Авто-диспетчер (ADR-019): периодическое заполнение свободных слотов (max 5) готовыми задачами
    // без напоминаний. Дополнительно запускается при завершении задачи (task_update done).
    let dispatchTimer: any = null
    try { dispatchTimer = setInterval(() => { dispatch(proj).catch(() => {}) }, 60000) } catch { /* ignore */ }
    // Авто-merge (ADR-020): дренировать merge-очередь автоматически (иначе pipeline стоит).
    let mergeTimer: any = null
    try { mergeTimer = setInterval(() => { try { autoMerge(proj) } catch { /* ignore */ }; try { autoResolveConflicts(proj) } catch { /* ignore */ } }, 120000) } catch { /* ignore */ }
    // Авто-восстановление (ADR-035, T-RECOVERY): перезапуск зависших агентов (liveness-guard).
    let recoverTimer: any = null
    try { recoverTimer = setInterval(() => { try { autoRecover(proj) } catch { /* ignore */ } }, 180000) } catch { /* ignore */ }

    await ctx.tool.transform((editor) => {
      editor.namespace({ name: "project", description: "ReservoirOS implementation dashboard: architecture, tasks, CRAP, coverage, real-time" })

      editor.add({
        name: "dashboard_open",
        description: "Start (if needed) and open the live ReservoirOS implementation dashboard (architecture drill-down, task graph, CRAP, test coverage, real-time multi-agent). Returns the URL.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: "project", codemode: true },
        execute: async () => {
          getState(proj)
          const port = startServer(proj)
          return { content: `Dashboard: http://127.0.0.1:${port}/\nState: ${statePath(proj)}\nОткройте URL в браузере. Real-time через SSE; обновления от всех агентов.` }
        },
      })

      editor.add({
        name: "component_update",
        description: "Update a component's implementation state: status (planned/in-progress/done), readiness %, doc, CRAP, coverage + code volume (loc/linesTotal/linesCovered). Coverage aggregates up the tree proportionally to code volume. Recomputes ancestor readiness.",
        input: {
          type: "object",
          properties: {
            id: { type: "string", description: "component id (e.g. reservoiros.engine.core)" },
            status: { type: "string", enum: ["planned", "in-progress", "done", "blocked"] },
            readiness: { type: "number", description: "0..100" },
            doc: { type: "string" },
            crap: { type: "number", description: "worst CRAP score (null if no code)" },
            coverage: { type: "number", description: "line coverage 0..100" },
            loc: { type: "number", description: "lines of code (вес для агрегации покрытия по объёму кода)" },
            linesTotal: { type: "number", description: "всего instrumented-строк (lcov LF) — точный знаменатель покрытия" },
            linesCovered: { type: "number", description: "покрыто строк (lcov LH) — точный числитель покрытия" },
          },
          required: ["id"], additionalProperties: false,
        },
        options: { namespace: "project", codemode: true },
        execute: async (input: any) => {
          const s = await mutate(proj, (st) => {
            const n = findNode(st.architecture, input.id)
            if (!n) throw new Error("component not found: " + input.id)
            if (input.status !== undefined) n.status = input.status
            if (input.readiness !== undefined) n.readiness = Math.max(0, Math.min(100, input.readiness))
            if (input.doc !== undefined) n.doc = input.doc
            if (input.crap !== undefined) n.crap = input.crap
            if (input.coverage !== undefined) n.coverage = input.coverage
            if (input.loc !== undefined) n.loc = input.loc
            if (input.linesTotal !== undefined) n.linesTotal = input.linesTotal
            if (input.linesCovered !== undefined) n.linesCovered = input.linesCovered
            recomputeReadiness(st.architecture, st.tasks)
          })
          const n = findNode(s.architecture, input.id)
          return { content: `updated ${input.id}: status=${n.status} readiness=${n.readiness}% crap=${n.crap ?? "—"} coverage=${n.coverage ?? "—"} lines=${n.linesCovered ?? "—"}/${n.linesTotal ?? n.loc ?? "—"}` }
        },
      })

      editor.add({
        name: "task_create",
        description: "Create an implementation task linked to a component, with dependencies (blockedBy) and loop stage.",
        input: {
          type: "object",
          properties: {
            id: { type: "string" }, title: { type: "string" }, component: { type: "string" },
            status: { type: "string", enum: ["awaiting-approval", "ready", "in-progress", "blocked", "done"] },
            loopStage: { type: "string" }, blockedBy: { type: "array", items: { type: "string" } },
            requirement: { type: "string" }, doc: { type: "string" }, owner: { type: "string" },
            priority: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
          },
          required: ["id", "title", "component"], additionalProperties: false,
        },
        options: { namespace: "project", codemode: true },
        execute: async (input: any) => {
          await mutate(proj, (st) => {
            st.tasks[input.id] = {
              id: input.id, title: input.title, component: input.component,
              status: input.status || "ready", loopStage: input.loopStage || "feature",
              blockedBy: input.blockedBy || [], owner: input.owner || null,
              requirement: input.requirement || "", progress: 0, doc: input.doc || "",
              priority: input.priority || "P2",
              tests: null,
            }
            recomputeReadiness(st.architecture, st.tasks)
            autoAssignZones(proj, st)   // ADR-040: zone новой задаче по component (dispatcher-ready)
          })
          return { content: `task created: ${input.id} (${input.title}) -> ${input.component}` }
        },
      })

      editor.add({
        name: "task_update",
        description: "Update a task: status, loop stage (feature/red/implement/green/gates/c4/commit/ci), owner, progress %, dependencies. Auto-unblocks dependents when done.",
        input: {
          type: "object",
          properties: {
            id: { type: "string" },
            status: { type: "string", enum: ["awaiting-approval", "ready", "in-progress", "blocked", "done"] },
            loopStage: { type: "string" }, owner: { type: "string" }, progress: { type: "number" },
            blockedBy: { type: "array", items: { type: "string" } },
            priority: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
            reason: { type: "string", description: "Причина неудачи/блокировки. При status=blocked увеличивает attempts; после 3 неудач задача эскалируется человеку (awaiting-approval)." },
          },
          required: ["id"], additionalProperties: false,
        },
        options: { namespace: "project", codemode: true },
        execute: async (input: any) => {
          const s = await mutate(proj, (st) => {
            const t = st.tasks[input.id]
            if (!t) throw new Error("task not found: " + input.id)
            if (input.status !== undefined) t.status = input.status
            if (input.loopStage !== undefined) t.loopStage = input.loopStage
            if (input.owner !== undefined) t.owner = input.owner
            if (input.progress !== undefined) t.progress = Math.max(0, Math.min(100, input.progress))
            if (input.blockedBy !== undefined) t.blockedBy = input.blockedBy
            if (input.priority !== undefined) t.priority = input.priority
            if (input.reason !== undefined) t.lastFailure = input.reason
            // Лимит итераций исправления + эскалация (§6.8): блокировка с причиной = неудачная
            // попытка; после MAX_FIX_ATTEMPTS задача требует человека (не бесконечный цикл).
            if (input.status === "blocked" && input.reason) {
              t.attempts = (t.attempts || 0) + 1
              if (t.attempts >= MAX_FIX_ATTEMPTS) { t.status = "awaiting-approval"; t.escalated = true }
            }
            // auto status from dependencies
            if (t.status !== "done" && t.status !== "awaiting-approval") {
              const blocked = (t.blockedBy || []).some((d: string) => st.tasks[d] && st.tasks[d].status !== "done")
              if (blocked && t.status !== "in-progress") t.status = "blocked"
              else if (!blocked && t.status === "blocked") t.status = "ready"
            }
            if (t.status === "done") {
              t.progress = 100; t.loopStage = "ci"; t.attempts = 0; t.escalated = false; markAgentDone(st, input.id)
              architectReview(st, proj) // архитектор-аналитик: авто-создание задач по пробелам (механически)
              // standing-задача ревью: перезапуск следующего цикла (механический recurring review)
              if (input.id === "T-ARCH-REVIEW") {
                st.tasks["T-ARCH-REVIEW"] = { id: "T-ARCH-REVIEW", title: "Архитектурное ревью плана по прогрессу", component: "reservoiros", status: "ready", loopStage: "feature", blockedBy: [], owner: null, requirement: "REQ-01", progress: 0, doc: "Ревью прогресса (дашборд/гейты/oracle): новые задачи/подзадачи/ADR где нужно. Авто-перезапуск после завершения.", tests: null, auto: true, review: true }
              }
            }
            // unblock dependents
            for (const other of Object.values(st.tasks) as any[]) {
              if ((other.blockedBy || []).includes(input.id) && other.status === "blocked") {
                const stillBlocked = other.blockedBy.some((d: string) => st.tasks[d] && st.tasks[d].status !== "done")
                if (!stillBlocked) other.status = "ready"
              }
            }
            recomputeReadiness(st.architecture, st.tasks)
          })
          const t = s.tasks[input.id]
          // Авто-очередь: завершённая задача автоматически попадает в merge-queue (гейты через DMTools + PR).
          // review-задачи (T-ARCH-REVIEW) не имеют feature-ветки — не enqueue.
          let queued = ""
          if (t.status === "done" && !t.review) {
            // Enqueue только если feature-ветка реально существует: локальные/RE-задачи
            // (напр. T-017) не имеют ветки и не должны попадать в merge-queue.
            let branchExists = false
            try { execFileSync("C:\\Program Files\\Git\\cmd\\git.exe", ["-C", proj, "rev-parse", "--verify", `feature/${input.id}`], { encoding: "utf8", stdio: ["ignore", "ignore", "ignore"] }); branchExists = true } catch {}
            if (branchExists) {
              try {
                runMQ(["enqueue", "-Branch", `feature/${input.id}`, "-Task", input.id, ...(t.owner ? ["-Agent", t.owner] : [])])
                queued = ` | auto-enqueued feature/${input.id} в merge-queue (гейты через DMTools при process)`
              } catch (e: any) { queued = ` | auto-enqueue failed: ${e?.message || e}` }
            }
          }
          // Авто-диспетчер (ADR-019): завершение задачи освобождает слот — заполнить готовыми задачами (max 5).
          if (t.status === "done") { try { const d = await dispatch(proj); if (d.length) queued += ` | auto-dispatch: ${d.join(", ")}` } catch { /* ignore */ } }
          // Авто-merge (ADR-020): завершение задачи -> enqueue -> дренировать очередь (не блокировать pipeline).
          if (t.status === "done") { try { autoMerge(proj) } catch { /* ignore */ } }
          return { content: `task ${input.id}: status=${t.status} loop=${t.loopStage} progress=${t.progress}% owner=${t.owner ?? "—"}${queued}` }
        },
      })

      editor.add({
        name: "architect_review",
        description: "Architect-analyst review (mechanical): analyze progress (gate/tool statuses from harness-model.json) and auto-create tasks for gaps (stub/vacuous gates, not-enforced mechanisms, missing prerequisites). Idempotent. Also auto-runs on task completion. Returns created tasks.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: "project", codemode: true },
        execute: async () => {
          let created: string[] = []
          await mutate(proj, (st) => { created = architectReview(st, proj) })
          return { content: created.length ? `architect-review: созданы задачи по пробелам: ${created.join(", ")}` : "architect-review: пробелов не найдено (задачи по гейтам/механизмам актуальны)" }
        },
      })

      editor.add({
        name: "dispatch",
        description: "Parallel auto-dispatcher (ADR-019): fill free slots (maxParallel from .local/parallel.json, default 3) with ready implementation tasks (zone-mapped, deps done) by launching DMTools CliAgent start-task. Auto-runs on task completion + every 60s. dryRun previews without launching.",
        input: { type: "object", properties: { dryRun: { type: "boolean" } }, additionalProperties: false },
        options: { namespace: "project", codemode: true },
        execute: async (input: any) => {
          const d = await dispatch(proj, !!input?.dryRun)
          const mx = dispatchCfg(proj).max
          return { content: d.length ? `dispatch: запущены ${d.join(", ")}` : `dispatch: свободных слотов нет или нет готовых диспетчеризуемых задач (max ${mx})` }
        },
      })

      editor.add({
        name: "task_claim",
        description: "Atomically claim a task for an agent. Succeeds ONLY if the task is unowned and ready (all blockers done). Sets in-progress + owner + heartbeat. Prevents two agents taking the same task. Throws if already claimed/blocked/done.",
        input: {
          type: "object",
          properties: { id: { type: "string" }, agent: { type: "string" } },
          required: ["id", "agent"], additionalProperties: false,
        },
        options: { namespace: "project", codemode: true },
        execute: async (input: any) => {
          let msg = ""
          await mutate(proj, (st) => {
            const t = st.tasks[input.id]
            if (!t) throw new Error("task not found: " + input.id)
            if (t.status === "done") throw new Error(`task ${input.id} already done`)
            if (t.owner && t.owner !== input.agent && t.status === "in-progress" && !String(t.owner).startsWith("auto-")) throw new Error(`task ${input.id} already claimed by ${t.owner}`)
            const blocked = (t.blockedBy || []).some((d: string) => st.tasks[d] && st.tasks[d].status !== "done")
            if (blocked) throw new Error(`task ${input.id} is blocked (dependencies not done)`)
            t.owner = input.agent; t.status = "in-progress"
            st.agents = st.agents || {}
            st.agents[input.agent] = { task: input.id, note: "claimed", lastSeen: new Date().toISOString() }
            msg = `claimed ${input.id} by ${input.agent} (in-progress)`
            recomputeReadiness(st.architecture, st.tasks)
          })
          return { content: msg }
        },
      })

      editor.add({
        name: "task_release",
        description: "Release a claimed task back to ready (or blocked if dependencies unfinished), clearing the owner, so another agent can pick it up.",
        input: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
        options: { namespace: "project", codemode: true },
        execute: async (input: any) => {
          await mutate(proj, (st) => {
            const t = st.tasks[input.id]
            if (!t) throw new Error("task not found: " + input.id)
            const blocked = (t.blockedBy || []).some((d: string) => st.tasks[d] && st.tasks[d].status !== "done")
            t.owner = null; t.status = blocked ? "blocked" : "ready"
            detachAgents(st, input.id)
            recomputeReadiness(st.architecture, st.tasks)
          })
          return { content: `released ${input.id} (owner cleared)` }
        },
      })

      editor.add({
        name: "report_tests",
        description: "Report test results for a component: line coverage %, passed/failed/total tests + code volume (linesTotal/linesCovered from lcov LF/LH, or loc). Dashboard aggregates coverage up the tree proportionally to code volume (Σ covered / Σ total lines).",
        input: {
          type: "object",
          properties: {
            id: { type: "string" }, coverage: { type: "number" },
            passed: { type: "number" }, failed: { type: "number" }, total: { type: "number" },
            loc: { type: "number", description: "lines of code (если нет точных lcov-строк)" },
            linesTotal: { type: "number", description: "всего instrumented-строк (lcov LF)" },
            linesCovered: { type: "number", description: "покрыто строк (lcov LH)" },
          },
          required: ["id"], additionalProperties: false,
        },
        options: { namespace: "project", codemode: true },
        execute: async (input: any) => {
          await mutate(proj, (st) => {
            const n = findNode(st.architecture, input.id)
            if (!n) throw new Error("component not found: " + input.id)
            n.tests = { coverage: input.coverage ?? n.tests?.coverage ?? 0, passed: input.passed ?? 0, failed: input.failed ?? 0, total: input.total ?? 0, updated: new Date().toISOString() }
            if (input.coverage !== undefined) n.coverage = input.coverage
            if (input.loc !== undefined) n.loc = input.loc
            if (input.linesTotal !== undefined) n.linesTotal = input.linesTotal
            if (input.linesCovered !== undefined) n.linesCovered = input.linesCovered
            // если известны всего строк и покрытие, но не покрытые строки — вычислить числитель
            const total = n.linesTotal ?? n.loc
            const cov = n.coverage ?? n.tests.coverage
            if (total != null && n.linesCovered == null && cov != null) n.linesCovered = Math.round(cov / 100 * total)
          })
          return { content: `tests ${input.id}: coverage=${input.coverage ?? "—"}% passed=${input.passed ?? 0} failed=${input.failed ?? 0}` }
        },
      })

      editor.add({
        name: "report_task_tests",
        description: "Report test results for a specific TASK (per-task test status): passed/failed/total + coverage % (+ optional linesTotal/linesCovered). Shows in the task modal and activity node; feeds component test rollup when the component has no own report.",
        input: {
          type: "object",
          properties: {
            taskId: { type: "string" }, coverage: { type: "number" },
            passed: { type: "number" }, failed: { type: "number" }, total: { type: "number" },
            linesTotal: { type: "number" }, linesCovered: { type: "number" },
          },
          required: ["taskId"], additionalProperties: false,
        },
        options: { namespace: "project", codemode: true },
        execute: async (input: any) => {
          await mutate(proj, (st) => {
            const t = st.tasks[input.taskId]
            if (!t) throw new Error("task not found: " + input.taskId)
            t.tests = { coverage: input.coverage ?? t.tests?.coverage ?? 0, passed: input.passed ?? 0, failed: input.failed ?? 0, total: input.total ?? 0, updated: new Date().toISOString() }
            if (input.linesTotal !== undefined) t.tests.linesTotal = input.linesTotal
            if (input.linesCovered !== undefined) t.tests.linesCovered = input.linesCovered
          })
          return { content: `task ${input.taskId} tests: passed=${input.passed ?? 0} failed=${input.failed ?? 0} total=${input.total ?? 0} coverage=${input.coverage ?? "—"}%` }
        },
      })

      editor.add({
        name: "report_crap",
        description: "Report CRAP metrics for a component (worst score + per-function list). Updates the dashboard CRAP view.",
        input: {
          type: "object",
          properties: {
            id: { type: "string" }, worst: { type: "number" },
            functions: { type: "array", items: { type: "object" } },
          },
          required: ["id", "worst"], additionalProperties: false,
        },
        options: { namespace: "project", codemode: true },
        execute: async (input: any) => {
          await mutate(proj, (st) => {
            const n = findNode(st.architecture, input.id)
            if (!n) throw new Error("component not found: " + input.id)
            n.crap = input.worst
            n.crapFunctions = input.functions || []
          })
          return { content: `CRAP ${input.id}: worst=${input.worst} (порог 30, цель 15)` }
        },
      })

      editor.add({
        name: "agent_heartbeat",
        description: "Register/refresh an active agent working on a task (for the multi-agent live view).",
        input: {
          type: "object",
          properties: { agent: { type: "string" }, task: { type: "string" }, note: { type: "string" } },
          required: ["agent"], additionalProperties: false,
        },
        options: { namespace: "project", codemode: true },
        execute: async (input: any) => {
          await mutate(proj, (st) => {
            st.agents = st.agents || {}
            st.agents[input.agent] = { task: input.task || null, note: input.note || "", lastSeen: new Date().toISOString() }
          })
          return { content: `agent ${input.agent} active on ${input.task ?? "—"}` }
        },
      })

      // merge queue (serialized integration)
      const mq = join(dirname(proj), "ReservoirOS-harness", "scripts", "merge-queue.ps1")
      const runMQ = (args: string[]) => {
        try {
          const out = execFileSync("powershell", ["-ExecutionPolicy", "Bypass", "-File", mq, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
          return { content: out.trim() }
        } catch (e: any) {
          return { content: `${e.stdout || ""}${e.stderr || ""} (exit ${e.status})`.trim() }
        }
      }
      editor.add({
        name: "merge_enqueue",
        description: "Add a feature branch to the serialized merge queue (FIFO). Merges run one at a time via merge_process (rebase + gates + optional approval).",
        input: { type: "object", properties: { branch: { type: "string" }, task: { type: "string" }, agent: { type: "string" } }, required: ["branch"], additionalProperties: false },
        options: { namespace: "project", codemode: true },
        execute: async (input: any) => runMQ(["enqueue", "-Branch", input.branch, ...(input.task ? ["-Task", input.task] : []), ...(input.agent ? ["-Agent", input.agent] : [])]),
      })
      editor.add({
        name: "merge_status",
        description: "Show the pending merge queue (FIFO order).",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: "project", codemode: true },
        execute: async () => runMQ(["status"]),
      })
      editor.add({
        name: "merge_process",
        description: "Start the merge worker (detached): rebase on develop + red-first + gates, then create & merge a GitHub PR feature->develop. Self-serializing (named mutex, one at a time). requireApproval pauses for human (H2). Returns immediately; track via merge_status / reports/merge-history.jsonl. All merges go through PRs (git-flow).",
        input: { type: "object", properties: { requireApproval: { type: "boolean" } }, additionalProperties: false },
        options: { namespace: "project", codemode: true },
        execute: async (input: any) => {
          // AUDIT 2026-11-19 (F-14): detached spawn. Previously synchronous runMQ blocked the
          // ENTIRE opencode service (all tools/SSE/timers) for the whole 20-35 min merge.
          const harness = join(dirname(proj), "ReservoirOS-harness")
          const ps = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
          const log = join(harness, ".locks", "manual-merge.log")
          const approval = input?.requireApproval ? "','-RequireApproval'" : ""
          const inner = `Start-Process -FilePath '${ps}' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${mq}','process'${approval} -WindowStyle Hidden -RedirectStandardOutput '${log}' -RedirectStandardError '${log}.err'`
          try { execFileSync(ps, ["-NoProfile", "-Command", inner], { stdio: "ignore", windowsHide: true }); return { content: "merge worker started detached (self-serializing); track: merge_status, .locks/manual-merge.log, reports/merge-history.jsonl" } }
          catch (e: any) { return { content: "merge spawn failed: " + (e?.message || e) } }
        },
      })
      editor.add({
        name: "merge_release",
        description: "Release (PUBLISH, human-gated): run full gates on develop + G6, then create & merge a GitHub PR develop->master (optional tag). master updated only at release. Prefer release_candidate first; publication requires human approval.",
        input: { type: "object", properties: { tag: { type: "string" }, requireApproval: { type: "boolean" } }, additionalProperties: false },
        options: { namespace: "project", codemode: true },
        execute: async (input: any) => runMQ(["release", ...(input?.tag ? ["-Tag", input.tag] : []), ...(input?.requireApproval ? ["-RequireApproval"] : [])]),
      })
      editor.add({
        name: "release_candidate",
        description: "Autonomously PREPARE a release candidate (NO publish/merge/push): full gates via DMTools on develop + G6 + oracle suite + build + changelog + release notes + reports/release-candidate.json + RELEASE-CANDIDATE.md. Returns readiness report. Publication stays with human (merge_release).",
        input: { type: "object", properties: { tag: { type: "string" } }, additionalProperties: false },
        options: { namespace: "project", codemode: true },
        execute: async (input: any) => runMQ(["candidate", ...(input?.tag ? ["-Tag", input.tag] : [])]),
      })
      editor.add({
        name: "resolve_conflicts",
        description: "Auto conflict-resolution (ADR-030): spawn subagents for dead-letter branches (code rebase-conflicts). Each agent rebases onto develop, resolves conflicts (union Cargo/C4, integrate code), runs merge-tier gates, pushes, re-enqueues, clears trackers. Auto-runs every 120s (max 2 concurrent). Returns spawned resolver tasks.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: "project", codemode: true },
        execute: async () => {
          const r = autoResolveConflicts(proj)
          return { content: r.length ? `resolve-conflicts: запущены резолверы: ${r.join(", ")}` : "resolve-conflicts: нет dead-letter веток или лимит резолверов занят" }
        },
      })
    })

    await ctx.command.transform((editor) => {
      editor.add({
        name: "reservoiros-dashboard",
        description: "Open the live ReservoirOS implementation dashboard",
        execute: async ({ sessionID, prompt, delivery }) => {
          getState(proj)
          const port = startServer(proj)
          await ctx.session.prompt({
            ...prompt, sessionID,
            text: `Дашборд реализации ReservoirOS запущен: http://127.0.0.1:${port}/\nОткрой его в браузере (browser.tabs.open) и кратко опиши текущее состояние (готовность, задачи, CRAP, покрытие).`,
            delivery,
          })
        },
      })
    })

    return () => { try { if (dispatchTimer) clearInterval(dispatchTimer); if (mergeTimer) clearInterval(mergeTimer); if (recoverTimer) clearInterval(recoverTimer); watcher?.close(); server?.close() } catch {} ; watcher = null; server = null; dispatchTimer = null; mergeTimer = null; recoverTimer = null }
  },
})