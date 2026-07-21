import { i18nText } from "./i18n-text";

export type TransportUrlClass = "secure" | "cleartext-loopback" | "cleartext-remote" | "invalid";

export type TransportSecurityOptions = {
  /** When true, remote cleartext http/ws URLs are rejected. */
  enforceSecureRemote?: boolean;
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

type ImportMetaEnv = {
  PROD?: boolean;
  MODE?: string;
};

function readViteEnv(): ImportMetaEnv | undefined {
  try {
    return (import.meta as ImportMeta & { env?: ImportMetaEnv }).env;
  } catch {
    return undefined;
  }
}

/** Renderer production builds enforce secure remote transport. Node callers opt in via config flags. */
export function shouldEnforceSecureRemoteTransport(): boolean {
  const env = readViteEnv();
  if (env?.PROD === true) return true;
  if (env?.PROD === false) return false;
  return false;
}

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  if (LOOPBACK_HOSTS.has(host)) return true;
  // IPv4-mapped IPv6 loopback
  if (host === "0:0:0:0:0:0:0:1" || host === "0000:0000:0000:0000:0000:0000:0000:0001") return true;
  return false;
}

export function classifyTransportUrl(value: string): TransportUrlClass {
  const trimmed = value.trim();
  if (!trimmed) return "invalid";
  try {
    const url = new URL(trimmed);
    const protocol = url.protocol.toLowerCase();
    if (protocol === "https:" || protocol === "wss:") return "secure";
    if (protocol === "http:" || protocol === "ws:") {
      return isLoopbackHostname(url.hostname) ? "cleartext-loopback" : "cleartext-remote";
    }
    return "invalid";
  } catch {
    return "invalid";
  }
}

export function isTransportUrlAllowed(value: string, options: TransportSecurityOptions = {}): boolean {
  const classification = classifyTransportUrl(value);
  if (classification === "invalid") return false;
  if (classification === "secure" || classification === "cleartext-loopback") return true;
  return !(options.enforceSecureRemote ?? shouldEnforceSecureRemoteTransport());
}

export function describeTransportViolation(value: string): string {
  const classification = classifyTransportUrl(value);
  if (classification === "invalid") {
    return i18nText(
      "URL 需要是 http 或 https 开头的完整地址",
      "URL must be a full address starting with http or https",
    );
  }
  if (classification === "cleartext-remote") {
    return i18nText(
      "生产环境禁止使用远程明文 HTTP/WS。请改用 HTTPS/WSS，或通过本机隧道使用 http://127.0.0.1:...。",
      "Remote cleartext HTTP/WS is blocked in production. Use HTTPS/WSS, or a local tunnel such as http://127.0.0.1:....",
    );
  }
  return i18nText("URL 不被允许", "URL is not allowed");
}

export function assertTransportUrlAllowed(value: string, options: TransportSecurityOptions = {}): void {
  if (isTransportUrlAllowed(value, options)) return;
  throw new Error(describeTransportViolation(value));
}

export function isInsecureRemoteTransportUrl(value: string): boolean {
  return classifyTransportUrl(value) === "cleartext-remote";
}
