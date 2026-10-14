// Household roles (App options member_user_ids / guest_user_ids; never set
// by the UI or a model). Owners keep everything; members chat, use lists,
// memory and apps and may request low/medium Home changes (Ask or
// Read-only, never Full); guests are read-only. Enforced on the server:
// HomeActions (permissions, admission and dispatch), role-specific Home
// extension groups plus a run-time check inside every tool, and the HTTP
// routes. The UI only hides what a role cannot use.
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { Catalog } from "./documents.js";
import type { HouseholdRole } from "./config.js";
import { insist } from "./safety.js";
export type { HouseholdRole } from "./config.js";

// Admin and automation reads: owners only.
const OWNER_READ_TOOLS = [
  "ha_admin_read",
  "ha_config_get",
  "ha_integrations_read",
  "supervisor_read",
  "ha_automation_config",
  "ha_automation_traces",
  "ha_automation_trace_detail",
  "ha_automation_activity",
];
// Anything that proposes a change or files a suggestion: never for guests.
const WRITE_TOOLS = [
  "ha_propose_service",
  "ha_call_service",
  "ha_config_propose",
  "ha_registry_propose",
  "ha_flow_propose",
  "supervisor_propose",
  "list_propose",
  "app_create",
  "app_update",
  "suggest_memory",
  "suggest_app_change",
  "suggest_code_change",
  "world_layout_propose",
];
export const ROLE_DENIED_TOOLS: Readonly<
  Record<HouseholdRole, ReadonlySet<string>>
> = {
  owner: new Set(),
  member: new Set(OWNER_READ_TOOLS),
  guest: new Set([...OWNER_READ_TOOLS, ...WRITE_TOOLS]),
};
export function toolAllowed(role: HouseholdRole, name: string) {
  return !ROLE_DENIED_TOOLS[role].has(name);
}
// The Home extension name of each role's group.
export const ROLE_EXTENSION: Readonly<Record<HouseholdRole, string>> = {
  owner: "hearth-ha",
  member: "hearth-ha-member",
  guest: "hearth-ha-guest",
};
// Run-time check inside a tool: the session owner's CURRENT role must still
// allow it (an older session may have been configured for another role).
export function withRoleCheck<T extends ToolRegistration>(
  tool: T,
  roleOf: (owner: string) => HouseholdRole,
): T {
  return {
    ...tool,
    execute: async (args, api, context) => {
      const session = (await api.snapshot(Catalog, context))?.items.find(
        (s) => s.id === api.conversationId,
      );
      insist(
        session && toolAllowed(roleOf(session.owner), tool.name),
        "role_forbids_tool",
        403,
      );
      return tool.execute(args, api, context);
    },
  };
}
// What the UI may offer (cosmetic: every route and tool re-checks).
export function roleCapabilities(role: HouseholdRole) {
  return {
    homeWrites: role !== "guest",
    fullAccess: role === "owner",
    highRiskApproval: role === "owner",
    providerSetup: role === "owner",
    memoryWrite: role !== "guest",
    householdMemory: role !== "guest",
    appEdit: role !== "guest",
    watchers: role !== "guest",
    suggestions: role !== "guest",
    phoneApprovals: role !== "guest",
  };
}
