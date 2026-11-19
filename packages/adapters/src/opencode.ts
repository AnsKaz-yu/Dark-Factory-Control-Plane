// Built-in adapter: OpenCode (push source). The thin plugin forwards server events
// to the core API; this adapter represents that connection for capability accounting.
import type { Adapter, ProbeResult } from "./contract.ts"

const ID = "opencode"

export const opencodeAdapter: Adapter = {
  manifest: {
    id: ID, version: "1.0.0", kind: "builtin", title: "OpenCode",
    description: "Agent/session/tool telemetry pushed by the DFCP OpenCode plugin (event stream + tool hooks).",
    contractVersion: 1, capabilities: ["agent_monitoring", "activity_events"],
    compatibility: { core: ">=0.1.0" }, sourceStability: "official-api",
  },
  async probe(ctx): Promise<ProbeResult> {
    // Verified only when the plugin has actually registered and pushed events.
    const registeredAt = ctx.config.registeredAt as string | undefined
    const lastEventAt = ctx.config.lastEventAt as string | undefined
    if (!registeredAt) {
      return {
        ok: false, confidence: "declared", detail: "OpenCode plugin not connected yet",
        capabilities: { agent_monitoring: { status: "not_configured", limitations: ["install/connect the DFCP OpenCode plugin to verify"], events: ["agent.*", "session.*"] } },
      }
    }
    const stale = lastEventAt ? Date.now() - Date.parse(lastEventAt) > 15 * 60 * 1000 : true
    return {
      ok: true, confidence: "verified", detail: `plugin registered ${registeredAt}${lastEventAt ? `, last event ${lastEventAt}` : ""}`,
      capabilities: {
        agent_monitoring: {
          status: stale ? "stale" : "supported",
          observableStates: ["working", "waiting", "blocked", "reviewing", "completed", "failed", "stopped", "unknown"],
          events: ["agent.registered", "agent.status_changed", "agent.heartbeat", "agent.error", "session.started", "session.ended"],
          limitations: stale ? ["no plugin events recently — statuses may be outdated"] : [],
          details: { registeredAt, lastEventAt },
        },
        activity_events: { status: "supported", events: ["activity.note"] },
      },
    }
  },
  async collect() {
    return { events: [], notes: ["push source: events arrive via the OpenCode plugin -> core API"] }
  },
}
