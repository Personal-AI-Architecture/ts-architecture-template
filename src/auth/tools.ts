import {
  type AuthActor,
  type AuthExportPayload,
  type AuthProvider,
  type AuthRequest,
  type AuthorizationRequest,
  type AuthorizationResult
} from "./provider";

export interface AuthWhoAmIResult {
  authenticated: boolean;
  actor: AuthActor | null;
}

export interface AuthCheckInput extends AuthorizationRequest {
  request?: AuthRequest;
  actor_id?: string;
}

export interface AuthCheckResult extends AuthorizationResult {
  actor: AuthActor | null;
}

export interface AuthTools {
  auth_whoami(input?: { request?: AuthRequest }): Promise<AuthWhoAmIResult>;
  auth_check(input: AuthCheckInput): Promise<AuthCheckResult>;
  auth_export(): Promise<AuthExportPayload>;
}

export function createAuthTools(provider: AuthProvider): AuthTools {
  if (!provider) {
    throw new Error("Auth tools require an auth provider.");
  }

  async function resolveActor(input: AuthCheckInput): Promise<AuthActor | null> {
    if (input.request) {
      const actorFromRequest = await provider.authenticate(input.request);
      if (actorFromRequest) {
        return actorFromRequest;
      }
    }

    if (input.actor_id) {
      return provider.findActor(input.actor_id);
    }

    return null;
  }

  async function authWhoAmI(input: { request?: AuthRequest } = {}): Promise<AuthWhoAmIResult> {
    const actor = input.request ? await provider.authenticate(input.request) : null;
    return {
      authenticated: Boolean(actor),
      actor: provider.whoami(actor)
    };
  }

  async function authCheck(input: AuthCheckInput): Promise<AuthCheckResult> {
    if (!input?.resource || !input?.action) {
      throw new Error("auth_check requires resource and action.");
    }

    const actor = await resolveActor(input);
    const authorization = await provider.authorize(actor, {
      resource: input.resource,
      action: input.action
    });

    return {
      ...authorization,
      actor: provider.whoami(actor)
    };
  }

  async function authExport(): Promise<AuthExportPayload> {
    return provider.exportState();
  }

  return {
    auth_whoami: authWhoAmI,
    auth_check: authCheck,
    auth_export: authExport
  };
}
