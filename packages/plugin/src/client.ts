// Thin HTTP client for the DFCP Core. No business logic here.
export interface CoreClientOptions {
  baseUrl: string
  timeoutMs?: number
}

export class CoreClient {
  readonly baseUrl: string
  private timeoutMs: number

  constructor(opts: CoreClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "")
    this.timeoutMs = opts.timeoutMs ?? 30000
  }

  async request(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: unknown }> {
    try {
      const res = await fetch(this.baseUrl + path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      const text = await res.text()
      let data: unknown
      try { data = JSON.parse(text) } catch { data = text }
      return { ok: res.ok, status: res.status, data }
    } catch (e) {
      return { ok: false, status: 0, data: { error: `core unreachable at ${this.baseUrl}: ${(e as Error).message}` } }
    }
  }

  get(path: string) { return this.request("GET", path) }
  post(path: string, body?: unknown) { return this.request("POST", path, body) }
  patch(path: string, body?: unknown) { return this.request("PATCH", path, body) }

  async healthy(): Promise<boolean> {
    const r = await this.get("/api/health")
    return r.ok
  }

  async ensureProject(id: string, name: string, root: string): Promise<string | null> {
    const r = await this.post("/api/projects", { id, name, root })
    if (r.ok || r.status === 409) {
      const d = r.data as { project?: { id?: string } }
      return d.project?.id ?? id
    }
    return null
  }

  async ingest(projectId: string, events: unknown[]): Promise<{ ok: boolean; accepted?: number; error?: string }> {
    if (!events.length) return { ok: true, accepted: 0 }
    const r = await this.post(`/api/projects/${projectId}/events`, { events })
    if (!r.ok) return { ok: false, error: JSON.stringify(r.data) }
    const d = r.data as { accepted?: number }
    return { ok: true, accepted: d.accepted ?? 0 }
  }
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project"
}
