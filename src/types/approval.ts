export type ApprovalMode = "enforced" | "disabled";

export interface ApprovalRequestPayload {
  approval_id: string;
  action: string;
  target: string;
  reason: string;
  requested_at: string;
  metadata?: Record<string, unknown>;
}

export interface ApprovalDecisionInput {
  approved: boolean;
  reason?: string;
  approver_id?: string;
}

export interface ApprovalResultPayload {
  approval_id: string;
  approved: boolean;
  status: "approved" | "denied";
  reason: string;
  approver_id?: string;
  resolved_at: string;
}

export interface ApprovalEvaluation {
  approval_request: ApprovalRequestPayload;
  approval_result: ApprovalResultPayload;
}

export type ApprovalDecider = (
  request: ApprovalRequestPayload
) => Promise<ApprovalDecisionInput | boolean> | ApprovalDecisionInput | boolean;

export interface ApprovalGateConfig {
  mode?: ApprovalMode;
  decide?: ApprovalDecider;
}

export interface ApprovalGate {
  evaluate(input: {
    action: string;
    target: string;
    reason: string;
    metadata?: Record<string, unknown>;
  }): Promise<ApprovalEvaluation>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function createApprovalId(): string {
  const random = Math.random().toString(16).slice(2, 10);
  return `appr_${Date.now()}_${random}`;
}

function normalizeMode(value: ApprovalMode | undefined): ApprovalMode {
  return value === "disabled" ? "disabled" : "enforced";
}

function toDecision(candidate: ApprovalDecisionInput | boolean): ApprovalDecisionInput {
  if (typeof candidate === "boolean") {
    return {
      approved: candidate
    };
  }
  return {
    approved: Boolean(candidate?.approved),
    reason: candidate?.reason,
    approver_id: candidate?.approver_id
  };
}

function createResult(
  request: ApprovalRequestPayload,
  approved: boolean,
  reason: string,
  approverId?: string
): ApprovalResultPayload {
  return {
    approval_id: request.approval_id,
    approved,
    status: approved ? "approved" : "denied",
    reason,
    approver_id: approverId,
    resolved_at: nowIso()
  };
}

export function createApprovalGate(config: ApprovalGateConfig = {}): ApprovalGate {
  const mode = normalizeMode(config.mode);
  const decide = typeof config.decide === "function" ? config.decide : undefined;

  return {
    async evaluate(input): Promise<ApprovalEvaluation> {
      const approvalRequest: ApprovalRequestPayload = {
        approval_id: createApprovalId(),
        action: input.action,
        target: input.target,
        reason: input.reason,
        requested_at: nowIso(),
        ...(input.metadata ? { metadata: input.metadata } : {})
      };

      if (mode === "disabled") {
        return {
          approval_request: approvalRequest,
          approval_result: createResult(approvalRequest, true, "Approval policy disabled.")
        };
      }

      if (!decide) {
        return {
          approval_request: approvalRequest,
          approval_result: createResult(approvalRequest, false, "Approval is required for this operation.")
        };
      }

      try {
        const decision = toDecision(await decide(approvalRequest));
        const reason = decision.reason?.trim() || (decision.approved ? "Approved by policy." : "Denied by policy.");
        return {
          approval_request: approvalRequest,
          approval_result: createResult(approvalRequest, decision.approved, reason, decision.approver_id)
        };
      } catch (error) {
        const failureReason = error instanceof Error ? error.message : String(error);
        return {
          approval_request: approvalRequest,
          approval_result: createResult(
            approvalRequest,
            false,
            failureReason.trim() || "Approval decision failed."
          )
        };
      }
    }
  };
}
