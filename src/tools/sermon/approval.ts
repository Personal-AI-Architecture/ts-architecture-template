import { type ApprovalGate, createApprovalGate } from "../../types/approval";

import { SERMON_TOOL_SOURCE } from "./outline";

const SERMON_AUTO_APPROVE_REASON =
  "Sermon outline writes are auto-approved on this single-user localhost prototype " +
  "(scoped strictly to source: 'sermon').";

export function createSermonApprovalGate(): ApprovalGate {
  return createApprovalGate({
    decide: (request) => {
      const source =
        request.metadata && typeof request.metadata.tool_source === "string"
          ? request.metadata.tool_source.trim().toLowerCase()
          : "";
      if (source === SERMON_TOOL_SOURCE) {
        return {
          approved: true,
          reason: SERMON_AUTO_APPROVE_REASON
        };
      }
      return {
        approved: false,
        reason: `Approval denied: source '${source || "(unknown)"}' is not auto-approved by the sermon-prep gate.`
      };
    }
  });
}
