declare const require: (id: string) => any;

const asyncHooks = require("node:async_hooks") as {
  AsyncLocalStorage: new <TStore>() => {
    getStore(): TStore | undefined;
    run<TResult>(store: TStore, callback: () => TResult): TResult;
  };
};
const httpModule = require("node:http") as {
  request?: (...args: unknown[]) => unknown;
  get?: (...args: unknown[]) => unknown;
};
const httpsModule = require("node:https") as {
  request?: (...args: unknown[]) => unknown;
  get?: (...args: unknown[]) => unknown;
};

export interface OutboundNetworkPermit {
  channel: "provider" | "tool";
  operation: string;
  target: string;
}

const permitStore = new asyncHooks.AsyncLocalStorage<OutboundNetworkPermit>();
let guardInstalled = false;

function getGlobalLike(): { [key: string]: unknown } {
  return globalThis as { [key: string]: unknown };
}

function getPermit(): OutboundNetworkPermit | undefined {
  return permitStore.getStore();
}

function assertPermit(): void {
  const permit = getPermit();
  if (!permit) {
    throw new Error("Outbound network call blocked. Explicit provider/tool permit is required.");
  }
}

function wrapCallableHost(host: { [key: string]: unknown }, key: "request" | "get"): void {
  const existing = host[key];
  if (typeof existing !== "function") {
    return;
  }

  const marker = existing as { __security_wrapped__?: boolean };
  if (marker.__security_wrapped__) {
    return;
  }

  const original = existing as (...args: unknown[]) => unknown;
  const wrapped = (...args: unknown[]): unknown => {
    assertPermit();
    return original(...args);
  };

  (wrapped as { __security_wrapped__?: boolean }).__security_wrapped__ = true;
  host[key] = wrapped;
}

export function withOutboundNetworkPermit<TResult>(
  permit: OutboundNetworkPermit,
  work: () => Promise<TResult> | TResult
): Promise<TResult> | TResult {
  return permitStore.run(permit, work);
}

export function currentOutboundNetworkPermit(): OutboundNetworkPermit | undefined {
  return getPermit();
}

export function installOutboundNetworkGuard(): void {
  if (guardInstalled) {
    return;
  }

  const globalLike = getGlobalLike();
  const candidate = globalLike["fetch"];
  if (typeof candidate !== "function") {
    guardInstalled = true;
    return;
  }

  const original = candidate as (...args: unknown[]) => Promise<unknown>;
  const wrapped = async (...args: unknown[]): Promise<unknown> => {
    assertPermit();
    return original(...args);
  };

  globalLike["fetch"] = wrapped;
  wrapCallableHost(httpModule as { [key: string]: unknown }, "request");
  wrapCallableHost(httpModule as { [key: string]: unknown }, "get");
  wrapCallableHost(httpsModule as { [key: string]: unknown }, "request");
  wrapCallableHost(httpsModule as { [key: string]: unknown }, "get");
  guardInstalled = true;
}
