import { i18nText } from "./i18n-text";

export type TransportUrlClass = "secure" | "cleartext-loopback" | "cleartext-remote" | "invalid";

export type TransportSecurityOptions = {
  /** When true, remote cleartext http/ws URLs are rejected. */
  enforceSecureRemote?: boolean;
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Whether the renderer should reject remote cleartext HTTP/WS.
 *
 * Always false, including production builds. This is a deliberate trade-off,
 * not an oversight: the packaged app targets a lab console reachable only over
 * plain HTTP, so enforcing here would make the default deployment unusable.
 * The Settings page compensates with a persistent warning whenever a remote
 * cleartext URL is configured (see `settings.transportInsecureWarning`).
 *
 * Do not document this as "production blocks cleartext" anywhere -- it does not.
 * CLI/MCP deliberately take the opposite default and reject remote cleartext
 * unless the caller passes `--allow-insecure-http`.
 *
 * Callers that do want enforcement can pass `{ enforceSecureRemote: true }`.
 */
export function shouldEnforceSecureRemoteTransport(): boolean {
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
    // Reached from CLI/MCP, which reject remote cleartext by default. The
    // renderer never hits this branch, so the wording must not claim that the
    // desktop app blocks cleartext in production.
    return i18nText(
      "当前配置不允许远程明文 HTTP/WS。请改用 HTTPS/WSS 或本机隧道 http://127.0.0.1:...；CLI/MCP 可用 --allow-insecure-http 显式放行。",
      "Remote cleartext HTTP/WS is not allowed by the current configuration. Use HTTPS/WSS or a local tunnel such as http://127.0.0.1:...; CLI/MCP can opt in with --allow-insecure-http.",
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
