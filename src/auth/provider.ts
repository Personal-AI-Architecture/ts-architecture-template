declare const require: (id: string) => any;

const fs = require("fs").promises as {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readFile(path: string, encoding?: string): Promise<string>;
  writeFile(path: string, data: string, encoding?: string): Promise<void>;
};
const path = require("path") as {
  join(...parts: string[]): string;
};
const crypto = require("crypto") as {
  createHash(algorithm: string): {
    update(value: string, encoding?: string): { digest(encoding: string): string };
  };
};

import { type EngineActorHeaders } from "../types/contracts";
import { emitAuditLog } from "../types/audit";

export interface AuthRequest {
  headers?: Record<string, string | string[] | undefined>;
}

export interface AuthorizationRequest {
  resource: string;
  action: string;
}

export interface AuthSeedActor {
  actor_id: string;
  token: string;
  permissions: string[];
  display_name?: string;
  metadata?: Record<string, unknown>;
  disabled?: boolean;
}

export interface AuthPolicyRule {
  resource: string;
  action: string;
  required_permissions: string[];
}

interface PersistedAuthActor {
  actor_id: string;
  display_name?: string;
  permissions: string[];
  token_digest: string;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  disabled?: boolean;
}

interface PersistedAuthState {
  schema_version: number;
  initialized_at: string;
  updated_at: string;
  actors: PersistedAuthActor[];
  policies: AuthPolicyRule[];
}

export interface AuthActor {
  actor_id: string;
  permissions: string[];
  display_name?: string;
  metadata?: Record<string, unknown>;
  authenticated_at: string;
}

export interface AuthorizationResult {
  actor_id: string | null;
  resource: string;
  action: string;
  allowed: boolean;
  required_permissions: string[];
}

export interface AuthExportActor {
  actor_id: string;
  display_name?: string;
  permissions: string[];
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  disabled?: boolean;
}

export interface AuthExportPayload {
  exported_at: string;
  auth_mode: string;
  schema_version: number;
  initialized_at: string;
  updated_at: string;
  actors: AuthExportActor[];
  policies: AuthPolicyRule[];
}

export interface AuthProviderConfig {
  state_root: string;
  auth_mode?: string;
  seed_actors?: AuthSeedActor[];
  policies?: AuthPolicyRule[];
}

export interface AuthProvider {
  readonly auth_mode: string;
  authenticate(request: AuthRequest): Promise<AuthActor | null>;
  findActor(actorId: string): Promise<AuthActor | null>;
  authorize(actor: AuthActor | null, access: AuthorizationRequest): Promise<AuthorizationResult>;
  buildActorHeaders(actor: AuthActor): EngineActorHeaders;
  whoami(actor: AuthActor | null): AuthActor | null;
  exportState(): Promise<AuthExportPayload>;
}

const AUTH_DIRECTORY = "auth";
const AUTH_STATE_FILE = "state.json";
const AUTH_SCHEMA_VERSION = 1;
const DISABLED_MODE = "disabled";
const SENSITIVE_KEY_PATTERN = /(secret|token|password|credential|digest|key)$/i;

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeAuthMode(authMode: string | undefined): string {
  if (!authMode || authMode.trim().length === 0) {
    return "enforced";
  }
  return authMode.trim().toLowerCase();
}

function normalizePermissions(permissions: string[]): string[] {
  const values = new Set<string>();
  for (const permission of permissions) {
    if (typeof permission !== "string") {
      continue;
    }
    const normalized = permission.trim();
    if (normalized.length > 0) {
      values.add(normalized);
    }
  }
  return [...values].sort();
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function extractHeaderValue(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string
): string | undefined {
  if (!headers) {
    return undefined;
  }

  const targetName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== targetName) {
      continue;
    }
    if (Array.isArray(value)) {
      return value.find((candidate) => typeof candidate === "string" && candidate.trim().length > 0);
    }
    return value;
  }

  return undefined;
}

function parseBearerToken(request: AuthRequest): string | null {
  const authorization = extractHeaderValue(request.headers, "authorization");
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match && match[1].trim().length > 0) {
      return match[1].trim();
    }
  }

  const fallback = extractHeaderValue(request.headers, "x-auth-token");
  if (fallback && fallback.trim().length > 0) {
    return fallback.trim();
  }

  return null;
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeForExport(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeForExport(entry));
  }

  if (!isObjectLike(value)) {
    return value;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      continue;
    }
    sanitized[key] = sanitizeForExport(nestedValue);
  }
  return sanitized;
}

function toAuthActor(record: PersistedAuthActor): AuthActor {
  return {
    actor_id: record.actor_id,
    permissions: normalizePermissions(record.permissions),
    display_name: record.display_name,
    metadata: record.metadata,
    authenticated_at: nowIso()
  };
}

function matchesPolicy(rule: AuthPolicyRule, access: AuthorizationRequest): boolean {
  const resourceMatch = rule.resource === "*" || rule.resource === access.resource;
  const actionMatch = rule.action === "*" || rule.action === access.action;
  return resourceMatch && actionMatch;
}

function hasPermission(actorPermissions: Set<string>, permission: string): boolean {
  if (actorPermissions.has("*")) {
    return true;
  }

  if (actorPermissions.has(permission)) {
    return true;
  }

  const split = permission.split(":");
  if (split.length === 2) {
    const [resource] = split;
    if (actorPermissions.has(`${resource}:*`)) {
      return true;
    }
  }

  return false;
}

function normalizePolicyRules(rules: AuthPolicyRule[] | undefined): AuthPolicyRule[] {
  if (!rules) {
    return [];
  }

  return rules
    .filter(
      (rule) =>
        typeof rule?.resource === "string" &&
        rule.resource.trim().length > 0 &&
        typeof rule?.action === "string" &&
        rule.action.trim().length > 0
    )
    .map((rule) => ({
      resource: rule.resource.trim(),
      action: rule.action.trim(),
      required_permissions: normalizePermissions(rule.required_permissions ?? [])
    }));
}

function validatePersistedState(value: unknown): PersistedAuthState {
  if (!value || typeof value !== "object") {
    throw new Error("Auth state file is invalid.");
  }

  const candidate = value as PersistedAuthState;
  if (!Array.isArray(candidate.actors) || !Array.isArray(candidate.policies)) {
    throw new Error("Auth state file is missing actors/policies arrays.");
  }

  return {
    schema_version:
      typeof candidate.schema_version === "number" ? candidate.schema_version : AUTH_SCHEMA_VERSION,
    initialized_at:
      typeof candidate.initialized_at === "string" && candidate.initialized_at.length > 0
        ? candidate.initialized_at
        : nowIso(),
    updated_at:
      typeof candidate.updated_at === "string" && candidate.updated_at.length > 0
        ? candidate.updated_at
        : nowIso(),
    actors: candidate.actors
      .filter(
        (actor) =>
          typeof actor?.actor_id === "string" &&
          actor.actor_id.trim().length > 0 &&
          typeof actor?.token_digest === "string" &&
          actor.token_digest.trim().length > 0
      )
      .map((actor) => ({
        actor_id: actor.actor_id.trim(),
        display_name: actor.display_name,
        permissions: normalizePermissions(actor.permissions ?? []),
        token_digest: actor.token_digest.trim(),
        metadata: isObjectLike(actor.metadata) ? actor.metadata : undefined,
        created_at: typeof actor.created_at === "string" ? actor.created_at : nowIso(),
        updated_at: typeof actor.updated_at === "string" ? actor.updated_at : nowIso(),
        disabled: Boolean(actor.disabled)
      })),
    policies: normalizePolicyRules(candidate.policies)
  };
}

function createInitialState(config: AuthProviderConfig): PersistedAuthState {
  const timestamp = nowIso();
  const seenActorIds = new Set<string>();

  const actors = (config.seed_actors ?? []).map((seed) => {
    if (typeof seed.actor_id !== "string" || seed.actor_id.trim().length === 0) {
      throw new Error("Auth seed actors must include actor_id.");
    }
    if (typeof seed.token !== "string" || seed.token.trim().length === 0) {
      throw new Error(`Auth seed actor ${seed.actor_id} must include token.`);
    }

    const actorId = seed.actor_id.trim();
    if (seenActorIds.has(actorId)) {
      throw new Error(`Auth seed actor IDs must be unique. Duplicate: ${actorId}`);
    }
    seenActorIds.add(actorId);

    return {
      actor_id: actorId,
      display_name: seed.display_name,
      permissions: normalizePermissions(seed.permissions ?? []),
      token_digest: hashToken(seed.token.trim()),
      metadata: isObjectLike(seed.metadata) ? seed.metadata : undefined,
      created_at: timestamp,
      updated_at: timestamp,
      disabled: Boolean(seed.disabled)
    } satisfies PersistedAuthActor;
  });

  const policies = normalizePolicyRules(config.policies);

  return {
    schema_version: AUTH_SCHEMA_VERSION,
    initialized_at: timestamp,
    updated_at: timestamp,
    actors,
    policies
  };
}

async function writeState(statePath: string, state: PersistedAuthState): Promise<void> {
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function loadOrInitializeState(config: AuthProviderConfig): Promise<PersistedAuthState> {
  const authDirectory = path.join(config.state_root, AUTH_DIRECTORY);
  const statePath = path.join(authDirectory, AUTH_STATE_FILE);

  await fs.mkdir(authDirectory, { recursive: true });

  try {
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return validatePersistedState(parsed);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (!/ENOENT/i.test(reason)) {
      throw new Error(`Unable to load auth state from ${statePath}: ${reason}`);
    }

    const initial = createInitialState(config);
    await writeState(statePath, initial);
    return initial;
  }
}

function requiredPermissionsForAccess(
  policies: AuthPolicyRule[],
  access: AuthorizationRequest
): string[] {
  const fromPolicies = policies
    .filter((policy) => matchesPolicy(policy, access))
    .flatMap((policy) => policy.required_permissions);

  if (fromPolicies.length > 0) {
    return normalizePermissions(fromPolicies);
  }

  return [`${access.resource}:${access.action}`];
}

function toSanitizedExportActor(record: PersistedAuthActor): AuthExportActor {
  return {
    actor_id: record.actor_id,
    display_name: record.display_name,
    permissions: normalizePermissions(record.permissions),
    metadata: sanitizeForExport(record.metadata) as Record<string, unknown> | undefined,
    created_at: record.created_at,
    updated_at: record.updated_at,
    disabled: Boolean(record.disabled)
  };
}

function buildDisabledModeActor(): AuthActor {
  return {
    actor_id: "auth-disabled",
    display_name: "Auth Disabled",
    permissions: ["*"],
    metadata: { mode: DISABLED_MODE },
    authenticated_at: nowIso()
  };
}

export async function createAuthProvider(config: AuthProviderConfig): Promise<AuthProvider> {
  if (!config.state_root || config.state_root.trim().length === 0) {
    throw new Error("Auth provider requires a state_root path.");
  }

  const authMode = normalizeAuthMode(config.auth_mode);
  const state = await loadOrInitializeState(config);

  async function authenticate(request: AuthRequest): Promise<AuthActor | null> {
    if (authMode === DISABLED_MODE) {
      const actor = buildDisabledModeActor();
      emitAuditLog({
        category: "auth",
        action: "authenticate",
        outcome: "allow",
        actor_id: actor.actor_id,
        details: {
          auth_mode: authMode
        }
      });
      return actor;
    }

    const token = parseBearerToken(request);
    if (!token) {
      emitAuditLog({
        category: "auth",
        action: "authenticate",
        outcome: "deny",
        details: {
          reason: "missing_credentials"
        }
      });
      return null;
    }

    const tokenDigest = hashToken(token);
    const actor = state.actors.find(
      (candidate) => !candidate.disabled && candidate.token_digest === tokenDigest
    );

    if (!actor) {
      emitAuditLog({
        category: "auth",
        action: "authenticate",
        outcome: "deny",
        details: {
          reason: "invalid_credentials"
        }
      });
      return null;
    }

    const authenticated = toAuthActor(actor);
    emitAuditLog({
      category: "auth",
      action: "authenticate",
      outcome: "allow",
      actor_id: authenticated.actor_id
    });
    return authenticated;
  }

  async function findActor(actorId: string): Promise<AuthActor | null> {
    const normalized = typeof actorId === "string" ? actorId.trim() : "";
    if (!normalized) {
      return null;
    }

    const actor = state.actors.find(
      (candidate) => !candidate.disabled && candidate.actor_id === normalized
    );

    return actor ? toAuthActor(actor) : null;
  }

  async function authorize(
    actor: AuthActor | null,
    access: AuthorizationRequest
  ): Promise<AuthorizationResult> {
    const required = requiredPermissionsForAccess(state.policies, access);

    if (!actor) {
      const deniedResult = {
        actor_id: null,
        resource: access.resource,
        action: access.action,
        allowed: false,
        required_permissions: required
      };
      emitAuditLog({
        category: "auth",
        action: "authorize",
        outcome: "deny",
        details: {
          resource: access.resource,
          action: access.action,
          required_permissions: required
        }
      });
      return deniedResult;
    }

    const actorPermissionSet = new Set(normalizePermissions(actor.permissions));
    const allowed = required.some((permission) => hasPermission(actorPermissionSet, permission));

    const result = {
      actor_id: actor.actor_id,
      resource: access.resource,
      action: access.action,
      allowed,
      required_permissions: required
    };
    emitAuditLog({
      category: "auth",
      action: "authorize",
      outcome: allowed ? "allow" : "deny",
      actor_id: actor.actor_id,
      details: {
        resource: access.resource,
        action: access.action,
        required_permissions: required
      }
    });
    return result;
  }

  function buildActorHeaders(actor: AuthActor): EngineActorHeaders {
    return {
      "X-Actor-ID": actor.actor_id,
      "X-Actor-Permissions": normalizePermissions(actor.permissions).join(",")
    };
  }

  function whoami(actor: AuthActor | null): AuthActor | null {
    if (!actor) {
      return null;
    }

    return {
      actor_id: actor.actor_id,
      display_name: actor.display_name,
      permissions: normalizePermissions(actor.permissions),
      metadata: sanitizeForExport(actor.metadata) as Record<string, unknown> | undefined,
      authenticated_at: actor.authenticated_at
    };
  }

  async function exportState(): Promise<AuthExportPayload> {
    const payload = {
      exported_at: nowIso(),
      auth_mode: authMode,
      schema_version: state.schema_version,
      initialized_at: state.initialized_at,
      updated_at: state.updated_at,
      actors: state.actors.map((record) => toSanitizedExportActor(record)),
      policies: state.policies.map((policy) => ({
        resource: policy.resource,
        action: policy.action,
        required_permissions: [...policy.required_permissions]
      }))
    };
    emitAuditLog({
      category: "auth",
      action: "export",
      outcome: "success"
    });
    return payload;
  }

  return {
    auth_mode: authMode,
    authenticate,
    findActor,
    authorize,
    buildActorHeaders,
    whoami,
    exportState
  };
}
