import { type EngineActorHeaders } from "../types/contracts";
import { emitAuditLog } from "../types/audit";
import {
  type AuthActor,
  type AuthProvider,
  type AuthRequest,
  type AuthorizationRequest,
  type AuthorizationResult
} from "./provider";

export interface AuthMiddlewareRequest extends AuthRequest {
  method?: string;
  path?: string;
  headers?: Record<string, string | string[] | undefined>;
  auth?: {
    actor: AuthActor;
    actor_headers: EngineActorHeaders;
    authorization?: AuthorizationResult;
  };
}

export interface AuthMiddlewareResource {
  resource: string;
  action: string;
}

export interface AuthMiddlewareOptions {
  protected?: boolean;
  resource?: string;
  action?: string;
}

export interface AuthMiddlewareResult {
  authenticated: boolean;
  actor: AuthActor | null;
  actor_headers?: EngineActorHeaders;
  authorization?: AuthorizationResult;
  request: AuthMiddlewareRequest;
}

export interface AuthMiddlewareConfig {
  provider: AuthProvider;
  default_protected?: boolean;
}

export class AuthMiddlewareError extends Error {
  readonly status_code: number;
  readonly error_code: string;

  constructor(statusCode: number, errorCode: string, message: string) {
    super(message);
    this.name = "AuthMiddlewareError";
    this.status_code = statusCode;
    this.error_code = errorCode;
  }
}

function normalizeOptions(
  defaultProtected: boolean,
  options: AuthMiddlewareOptions | undefined
): Required<Pick<AuthMiddlewareOptions, "protected">> & AuthMiddlewareResource | null {
  const isProtected = options?.protected ?? defaultProtected;

  if (!options?.resource || !options?.action) {
    return isProtected
      ? {
          protected: isProtected,
          resource: "*",
          action: "*"
        }
      : null;
  }

  return {
    protected: isProtected,
    resource: options.resource,
    action: options.action
  };
}

function attachActorHeaders(
  request: AuthMiddlewareRequest,
  headers: EngineActorHeaders
): Record<string, string | string[] | undefined> {
  const current = request.headers ?? {};
  current["X-Actor-ID"] = headers["X-Actor-ID"];
  current["X-Actor-Permissions"] = headers["X-Actor-Permissions"];
  request.headers = current;
  return current;
}

async function authorizeAccess(
  provider: AuthProvider,
  actor: AuthActor | null,
  access: AuthorizationRequest,
  isProtected: boolean
): Promise<AuthorizationResult | undefined> {
  if (!access.resource || !access.action) {
    return undefined;
  }

  const authorization = await provider.authorize(actor, access);
  if (isProtected && !authorization.allowed) {
    throw new AuthMiddlewareError(403, "forbidden", "Authenticated actor is not authorized.");
  }

  return authorization;
}

export function createAuthMiddleware(config: AuthMiddlewareConfig) {
  if (!config?.provider) {
    throw new Error("Auth middleware requires an auth provider.");
  }

  const defaultProtected = Boolean(config.default_protected);

  return async function authMiddleware(
    request: AuthMiddlewareRequest,
    options?: AuthMiddlewareOptions
  ): Promise<AuthMiddlewareResult> {
    const effectiveRequest = request ?? {};
    const normalizedOptions = normalizeOptions(defaultProtected, options);
    const actor = await config.provider.authenticate(effectiveRequest);

    const isProtected = normalizedOptions?.protected ?? false;
    if (isProtected && !actor) {
      emitAuditLog({
        category: "auth",
        action: "middleware_authenticate",
        outcome: "deny",
        details: {
          protected: true,
          path: effectiveRequest.path ?? null,
          method: effectiveRequest.method ?? null
        }
      });
      throw new AuthMiddlewareError(401, "unauthenticated", "Protected request requires authentication.");
    }

    const authorization = normalizedOptions
      ? await authorizeAccess(config.provider, actor, normalizedOptions, isProtected)
      : undefined;

    if (!actor) {
      emitAuditLog({
        category: "auth",
        action: "middleware_authenticate",
        outcome: "success",
        details: {
          authenticated: false,
          protected: isProtected
        }
      });
      return {
        authenticated: false,
        actor: null,
        authorization,
        request: effectiveRequest
      };
    }

    const actorHeaders = config.provider.buildActorHeaders(actor);
    attachActorHeaders(effectiveRequest, actorHeaders);

    effectiveRequest.auth = {
      actor,
      actor_headers: actorHeaders,
      authorization
    };

    emitAuditLog({
      category: "auth",
      action: "middleware_authenticate",
      outcome: "success",
      actor_id: actor.actor_id,
      details: {
        authenticated: true,
        protected: isProtected,
        authorized: authorization?.allowed ?? null
      }
    });

    return {
      authenticated: true,
      actor,
      actor_headers: actorHeaders,
      authorization,
      request: effectiveRequest
    };
  };
}
