// Synthetic harness fixtures for isolated testing (built inside tests/.runtime/).
// Project A "alpha": standard OpenCode harness + Git + file tasks + Jenkins + queue + LikeC4.
// Project B "beta": substantially different custom harness (pipe tasks, crew registry,
//                   custom queue fields, event feed, NO OpenCode/CI/LikeC4).
// Project C "gamma": bare Git project, no harness.
import { mkdirSync, writeFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { execFileSync } from "node:child_process"

function gitBinary(): string {
  for (const c of ["git", "C:\\Program Files\\Git\\cmd\\git.exe"]) {
    try { execFileSync(c, ["--version"], { stdio: "ignore", windowsHide: true }); return c } catch { /* next */ }
  }
  throw new Error("git not available for fixture builder")
}

function w(dir: string, rel: string, content: string): void {
  const p = join(dir, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

function gitInit(dir: string): void {
  const git = gitBinary()
  const run = (args: string[]) => execFileSync(git, ["-C", dir, ...args], { stdio: "ignore", windowsHide: true })
  run(["init", "-b", "main"])
  run(["config", "user.name", "DFCP Fixture"])
  run(["config", "user.email", "fixture@dfcp.local"])
  run(["add", "-A"])
  run(["commit", "-m", "initial harness state"])
}

const ISO = "2026-11-19T08:00:00.000Z"

export function buildAlpha(dir: string): void {
  mkdirSync(dir, { recursive: true })
  w(dir, "README.md", "# Alpha — standard OpenCode harness\n")
  w(dir, "opencode.json", JSON.stringify({ plugins: ["opencode-example"], model: "test/model" }, null, 2))
  w(dir, ".opencode/agent/build.md", "---\ndescription: Builds features and fixes bugs\n---\nYou are the build agent.\n")
  w(dir, ".opencode/agent/review.md", "---\ndescription: Reviews changes for correctness\n---\nYou are the review agent.\n")
  w(dir, ".opencode/skills/tdd/SKILL.md", "---\nname: tdd\ndescription: Test-driven development\n---\nRed-green-refactor.\n")
  w(dir, "tasks.json", JSON.stringify({
    tasks: [
      { id: "E-1", title: "Platform epic", status: "in-progress", kind: "epic", priority: "P1" },
      { id: "F-1", title: "Auth feature", status: "in-progress", parent: "E-1", kind: "feature", priority: "P1" },
      { id: "T-1", title: "Login endpoint", status: "done", parent: "F-1", priority: "P0", owner: "build", estimateHours: 4, component: "api" },
      { id: "T-2", title: "Session store", status: "in-progress", parent: "F-1", blockedBy: ["T-1"], priority: "P0", owner: "build", estimateHours: 6, progress: 40, component: "api" },
      { id: "T-3", title: "UI login form", status: "ready", parent: "F-1", blockedBy: ["T-2"], priority: "P1", estimateHours: 3, component: "web" },
      { id: "T-4", title: "Rate limiting", status: "blocked", blockedBy: ["T-2"], priority: "P2", estimateHours: 2, component: "api" },
      { id: "T-5", title: "Docs", status: "ready", priority: "P3", estimateHours: 1, component: "docs" },
      { id: "T-6", title: "Perf audit", status: "done", priority: "P2", estimateHours: 2, component: "api" },
    ],
  }, null, 2))
  w(dir, "Jenkinsfile", "pipeline {\n  agent any\n  stages {\n    stage('Build') { steps { sh 'make build' } }\n    stage('Test') { steps { sh 'make test' } }\n    stage('Lint') { steps { sh 'make lint' } }\n  }\n}\n")
  w(dir, "merge-queue.json", JSON.stringify({
    items: [
      { branch: "feature/T-2", task: "T-2", agent: "build", state: "checking", enqueuedAt: ISO, checks: [{ name: "gates", status: "running" }] },
      { branch: "feature/T-6", task: "T-6", agent: "build", state: "waiting", enqueuedAt: ISO },
      { branch: "feature/T-9", task: "T-9", state: "dead-letter", reason: "rebase-conflict", enqueuedAt: ISO },
    ],
  }, null, 2))
  w(dir, "architecture/dist/model.json", JSON.stringify({
    projectId: "alpha",
    elements: {
      api: { id: "api", title: "API Gateway", kind: "container", technology: "Node" },
      web: { id: "web", title: "Web Client", kind: "container", technology: "TS" },
      db: { id: "db", title: "Database", kind: "container", technology: "SQLite" },
    },
    relations: {
      r1: { source: "web", target: "api", label: "REST" },
      r2: { source: "api", target: "db", label: "SQL" },
    },
    views: {
      containers: { id: "containers", title: "Containers", nodes: [{ id: "web" }, { id: "api" }, { id: "db" }], edges: [{ source: "web", target: "api", label: "REST" }, { source: "api", target: "db", label: "SQL" }] },
    },
  }, null, 2))
  w(dir, "RELEASE-PLAN.md", "# Release plan\n\n## v0.2\n- T-2 session store\n- T-3 UI login\n")
  w(dir, "scripts/build.sh", "#!/bin/sh\n# workflow stages: feature -> red -> implement -> green -> gates -> commit -> ci\nstage=\"implement\"\nif [ \"$stage\" = \"gates\" ]; then echo gates; fi\n")
  gitInit(dir)
  const git = gitBinary()
  execFileSync(git, ["-C", dir, "checkout", "-b", "feature/T-2"], { stdio: "ignore", windowsHide: true })
  w(dir, "src-session.txt", "session work in progress\n")
  execFileSync(git, ["-C", dir, "add", "-A"], { stdio: "ignore", windowsHide: true })
  execFileSync(git, ["-C", dir, "commit", "-m", "feat/T-2: session store wip"], { stdio: "ignore", windowsHide: true })
  execFileSync(git, ["-C", dir, "checkout", "main"], { stdio: "ignore", windowsHide: true })
}

export function buildBeta(dir: string): void {
  mkdirSync(dir, { recursive: true })
  w(dir, "README.md", "# Beta — custom multi-agent harness (no OpenCode)\n")
  w(dir, "tasks.pipe",
    "# custom task format: id | title | status | deps | estimateHours\n" +
    "T-100 | Foundations | shipped | | 8\n" +
    "T-101 | Weld the frame | coding | T-100 | 6\n" +
    "T-102 | Paint the frame | queued | T-101 | 2\n" +
    "T-103 | Inspect welds | verifying | T-101 | 1\n" +
    "T-104 | Ship it | integrating | T-102,T-103 | 1\n")
  w(dir, "crew-state.json", JSON.stringify({
    "welder-1": { status: "running", task: "T-101", lastSeen: ISO, note: "welding" },
    "painter-1": { status: "idle", task: null, lastSeen: ISO },
    "inspector-1": { status: "running", task: "T-103", lastSeen: ISO, note: "inspecting" },
  }, null, 2))
  w(dir, "events.jsonl",
    JSON.stringify({ type: "agent.heartbeat", schemaVersion: 1, payload: { id: "welder-1", taskId: "T-101", note: "arc stable" }, occurredAt: ISO, eventId: "beta-ev-1" }) + "\n" +
    JSON.stringify({ type: "activity.note", schemaVersion: 1, payload: { text: "shift started" }, occurredAt: ISO, eventId: "beta-ev-2" }) + "\n" +
    "plain log line without structure\n")
  w(dir, "merge-queue.json", JSON.stringify({
    items: [
      { ref: "feature/T-101", ticket: "T-101", phase: "gates", added: ISO },
      { ref: "feature/T-100", ticket: "T-100", phase: "done", added: ISO },
      { ref: "feature/T-999", ticket: "T-999", phase: "dead-letter", added: ISO, reason: "gate-fail" },
    ],
  }, null, 2))
  w(dir, "scripts/pipeline.sh", "#!/bin/sh\n# custom workflow: queued -> coding -> verifying -> integrating -> shipped\nphase=\"coding\"\ncase \"$phase\" in queued|coding|verifying|integrating|shipped) echo ok;; esac\n")
  gitInit(dir)
}

export function buildGamma(dir: string): void {
  mkdirSync(dir, { recursive: true })
  w(dir, "README.md", "# Gamma — bare project, no harness\n")
  w(dir, "src/main.txt", "hello\n")
  gitInit(dir)
}

export type FixtureKind = "alpha" | "beta" | "gamma"

export function buildFixture(kind: FixtureKind, dir: string): void {
  if (existsSync(join(dir, ".git"))) return // already built
  if (kind === "alpha") buildAlpha(dir)
  else if (kind === "beta") buildBeta(dir)
  else buildGamma(dir)
}
