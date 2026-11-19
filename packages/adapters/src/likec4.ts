// Built-in adapter: LikeC4 architecture model export (optional architecture source).
import type { Adapter, AdapterContext, ProbeResult } from "./contract.ts"
import { adapterSource, snapshotKey } from "./contract.ts"
import { hashObject } from "../../core/src/ids.ts"

const ID = "likec4"

interface LikeC4Model {
  elements?: Record<string, { id?: string; title?: string; kind?: string; technology?: string; notation?: string }> | { id: string; title?: string; kind?: string }[]
  relations?: Record<string, { source?: string; target?: string; label?: string; title?: string }> | { source: string; target: string; label?: string }[]
  views?: Record<string, { id?: string; title?: string; nodes?: { id: string }[]; edges?: { source: string; target: string; label?: string }[] }>
}

function findModel(ctx: AdapterContext): string | null {
  const configured = ctx.config.modelPath as string | undefined
  const candidates = configured ? [configured] : [
    "architecture/dist/model.json", "dist/model.json", "model.json",
    "architecture/model.json", "docs/architecture/model.json",
  ]
  for (const c of candidates) if (ctx.exists(c)) return c
  return null
}

function normalize(model: LikeC4Model) {
  const elements = Array.isArray(model.elements)
    ? model.elements.map(e => ({ id: e.id, title: e.title ?? e.id, kind: e.kind, technology: (e as Record<string, unknown>).technology as string | undefined }))
    : Object.entries(model.elements ?? {}).map(([id, e]) => ({ id: e.id ?? id, title: e.title ?? id, kind: e.kind, technology: e.technology }))
  const relations = Array.isArray(model.relations)
    ? model.relations.map(r => ({ source: r.source, target: r.target, label: r.label ?? r.title }))
    : Object.values(model.relations ?? {}).map(r => ({ source: r.source ?? "", target: r.target ?? "", label: r.label ?? r.title })).filter(r => r.source && r.target)
  const views = Object.entries(model.views ?? {}).map(([id, v]) => ({
    id: v.id ?? id, title: v.title ?? id,
    nodes: (v.nodes ?? []).map(n => n.id),
    edges: v.edges ?? [],
  }))
  return { elements, relations, views }
}

export const likec4Adapter: Adapter = {
  manifest: {
    id: ID, version: "1.0.0", kind: "builtin", title: "LikeC4",
    description: "Architecture elements/relations/views from a LikeC4 model export (model.json). Optional.",
    contractVersion: 1, capabilities: ["architecture_map"],
    compatibility: { core: ">=0.1.0" }, sourceStability: "documented-format",
  },
  async probe(ctx): Promise<ProbeResult> {
    const path = findModel(ctx)
    if (!path) return { ok: false, confidence: "inferred", detail: "no LikeC4 model export found", capabilities: { architecture_map: { status: "unavailable", limitations: ["no model.json export found"] } } }
    const raw = ctx.readText(path)
    try {
      let doc = JSON.parse(raw!)
      if (Array.isArray(doc)) doc = doc[0]
      const { elements, views } = normalize(doc)
      if (!elements.length) return { ok: false, confidence: "inferred", detail: "model has no elements", capabilities: { architecture_map: { status: "degraded", limitations: ["model export empty"] } } }
      return {
        ok: true, confidence: "verified", detail: `${elements.length} elements, ${views.length} views from ${path}`,
        capabilities: { architecture_map: { status: "supported", observableStates: ["elements", "relations", "views"], events: ["architecture.map", "component.updated"], details: { modelPath: path, elementCount: elements.length } } },
      }
    } catch (e) {
      return { ok: false, confidence: "inferred", detail: `model parse error: ${(e as Error).message}`, capabilities: { architecture_map: { status: "degraded", limitations: ["model export unreadable"] } } }
    }
  },
  async collect(ctx) {
    const path = findModel(ctx)
    if (!path) return { events: [] }
    try {
      let doc = JSON.parse(ctx.readText(path)!)
      if (Array.isArray(doc)) doc = doc[0]
      const { elements, relations, views } = normalize(doc)
      const events = [
        {
          type: "architecture.map" as const, schemaVersion: 1,
          payload: { available: true, source: `likec4:${path}`, elements, relations, views },
          idempotencyKey: snapshotKey(ID, path, hashObject({ elements, relations, views })),
          source: adapterSource(ID, path),
        },
      ]
      for (const el of elements) {
        events.push({
          type: "component.updated" as const, schemaVersion: 1,
          payload: { id: el.id, name: el.title, kind: el.kind ?? "component" },
          idempotencyKey: `${ID}:${path}:comp:${el.id}:${hashObject(el)}`,
          source: adapterSource(ID, path),
        })
      }
      return { events }
    } catch (e) { return { events: [], notes: [`likec4 collect failed: ${(e as Error).message}`] } }
  },
}
