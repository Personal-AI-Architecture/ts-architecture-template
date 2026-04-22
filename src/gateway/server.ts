import {
  type GatewayRouteRequest,
  type GatewayRouteResponse,
  type GatewayRoutes
} from "./routes";
import { emitAuditLog } from "../types/audit";
import { toErrorDiagnostics, toSafeClientMessage } from "../types/safety";

export interface GatewayServerConfig {
  routes: GatewayRoutes;
  authenticate?: GatewayServerAuthenticator;
}

export interface GatewayServer {
  handle(request: GatewayRouteRequest): Promise<GatewayRouteResponse>;
}

interface AuthLikeResult {
  request?: GatewayRouteRequest;
}

interface AuthLikeError {
  status_code?: number;
  error_code?: string;
  message?: string;
}

export type GatewayServerAuthenticator = (
  request: GatewayRouteRequest
) => Promise<GatewayRouteRequest | AuthLikeResult>;

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isGatewayRouteRequest(value: unknown): value is GatewayRouteRequest {
  if (!isObjectLike(value)) {
    return false;
  }
  return typeof value.method === "string" && typeof value.path === "string";
}

function normalizeAuthenticatedRequest(
  fallbackRequest: GatewayRouteRequest,
  authenticated: GatewayRouteRequest | AuthLikeResult
): GatewayRouteRequest {
  if (isObjectLike(authenticated) && isGatewayRouteRequest((authenticated as AuthLikeResult).request)) {
    return (authenticated as AuthLikeResult).request as GatewayRouteRequest;
  }

  if (isGatewayRouteRequest(authenticated)) {
    return authenticated;
  }

  return fallbackRequest;
}

function authErrorToResponse(error: unknown): GatewayRouteResponse {
  const authError = error as AuthLikeError;
  const status = typeof authError?.status_code === "number" ? authError.status_code : 401;
  const code =
    typeof authError?.error_code === "string" && authError.error_code.trim().length > 0
      ? authError.error_code
      : "unauthorized";
  const message =
    typeof authError?.message === "string"
      ? toSafeClientMessage(authError.message, "Request authorization failed.")
      : "Request authorization failed.";

  return {
    status,
    headers: {
      "Content-Type": "application/json"
    },
    body: {
      error: {
        code,
        message
      }
    }
  };
}

function serverErrorToResponse(): GatewayRouteResponse {
  return {
    status: 500,
    headers: {
      "Content-Type": "application/json"
    },
    body: {
      error: {
        code: "internal_error",
        message: "Gateway request failed."
      }
    }
  };
}

export function createGatewayServer(config: GatewayServerConfig): GatewayServer {
  if (!config?.routes) {
    throw new Error("Gateway server requires configured routes.");
  }

  return {
    async handle(request: GatewayRouteRequest): Promise<GatewayRouteResponse> {
      let effectiveRequest = request;

      if (typeof config.authenticate === "function") {
        try {
          const authenticated = await config.authenticate(request);
          effectiveRequest = normalizeAuthenticatedRequest(request, authenticated);
        } catch (error) {
          emitAuditLog({
            category: "gateway",
            action: "auth_preprocessing",
            outcome: "failure",
            diagnostics: toErrorDiagnostics(error)
          });
          return authErrorToResponse(error);
        }
      }

      try {
        return await config.routes.handle(effectiveRequest);
      } catch (error) {
        emitAuditLog({
          category: "gateway",
          action: "route_failure",
          outcome: "failure",
          diagnostics: toErrorDiagnostics(error)
        });
        return serverErrorToResponse();
      }
    }
  };
}
