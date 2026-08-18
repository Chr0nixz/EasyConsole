import { ApiClient } from "./api-client";
import { createEasyConsoleApi, formatContentRange } from "./api-factory";
import { browserRuntime } from "./runtime";
import {
  assertTransportUrlAllowed,
  describeTransportViolation,
  isTransportUrlAllowed,
  shouldEnforceSecureRemoteTransport,
} from "./transport-security";

export { createEasyConsoleApi, formatContentRange };
export type { EasyConsoleApi } from "./api-factory";

export const apiClient = new ApiClient(browserRuntime);
export const { authApi, imageApi, instanceApi, resourceApi, storageApi } = createEasyConsoleApi(apiClient);

let transportBlockReason: string | null = null;
const transportPolicyListeners = new Set<() => void>();

function notifyTransportPolicyListeners() {
  for (const listener of transportPolicyListeners) listener();
}

export function subscribeTransportPolicy(listener: () => void) {
  transportPolicyListeners.add(listener);
  return () => {
    transportPolicyListeners.delete(listener);
  };
}

export function getTransportBlockReason() {
  return transportBlockReason;
}

/** Apply API base when policy allows; otherwise record a block reason and leave the client unchanged. */
export function setApiBaseUrl(baseUrl: string): boolean {
  const enforce = shouldEnforceSecureRemoteTransport();
  if (!isTransportUrlAllowed(baseUrl, { enforceSecureRemote: enforce })) {
    transportBlockReason = describeTransportViolation(baseUrl);
    notifyTransportPolicyListeners();
    return false;
  }
  assertTransportUrlAllowed(baseUrl, { enforceSecureRemote: enforce });
  apiClient.setBaseUrl(baseUrl);
  transportBlockReason = null;
  notifyTransportPolicyListeners();
  return true;
}
