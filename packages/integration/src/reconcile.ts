// Integration Reconciliation — decision logic (pure): drift changes -> action plan.
// Category A: safe compatible, auto-apply. B: structural reversible, auto within granted
// permissions. C: breaking/high-risk, requires explicit approval.
import type { DriftReport, ReconciliationAction, ReconciliationResult } from "../../core/src/types.ts"
import type { ProjectConfig } from "./install.ts"
import { nowISO } from "../../core/src/ids.ts"

export function planReconciliation(drift: DriftReport, config: ProjectConfig | null): ReconciliationAction[] {
  const allowStructural = config?.permissions.allowStructural !== false
  const actions: ReconciliationAction[] = []
  for (const c of drift.changes) {
    const base = { target: c.kind + ":" + c.evidence, category: c.category, detail: `${c.impact} → ${c.suggestedAction}` }
    if (c.category === "A") {
      actions.push({ ...base, action: c.kind === "agent_added" ? "add" : c.kind === "tracker_data_changed" ? "verify" : "change", applied: false, requiresApproval: false })
    } else if (c.category === "B") {
      actions.push({ ...base, action: c.kind === "agent_removed" ? "change" : "recreate", applied: false, requiresApproval: !allowStructural })
    } else {
      actions.push({ ...base, action: "recreate", applied: false, requiresApproval: true })
    }
  }
  if (!drift.changes.length) {
    actions.push({ target: "integration", category: "A", detail: "no drift; verify sync health", action: "verify", applied: false, requiresApproval: false })
  }
  return actions
}

export function emptyResult(drift: DriftReport): ReconciliationResult {
  return { at: nowISO(), drift, actions: [], manifestUpdated: false, adaptersUpdated: [], verified: false, errors: [] }
}
