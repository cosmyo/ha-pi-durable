import type { Proposal } from "./documents.js";

// The model tools that file a Home permissions proposal (HomeActions.request).
// The browser shows each one's card inline, right after the tool call that
// filed it, by the controller-set `details.proposalId` of its result; the
// same list is in public/render.js (PROPOSAL_TOOLS, a test keeps them equal).
export const PROPOSAL_TOOLS = [
  "ha_propose_service",
  "ha_call_service",
  "ha_config_propose",
  "ha_registry_propose",
  "supervisor_propose",
  "ha_flow_propose",
  "list_propose",
] as const;

// A proposal tool's result: the receipt as text for the model, and the
// proposal id as details for the transcript. The id comes from the
// committed proposal, never from model or tool text.
export function proposalToolResult(proposal: Proposal) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(proposal) }],
    details: { proposalId: proposal.id },
  };
}
