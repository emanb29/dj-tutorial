import type { MiddlewareHandler } from "hono";
import type { ApiFailure } from "@shared";

export interface SameOriginPolicy {
  /** Origins of the pages that may call the API, e.g. "http://127.0.0.1:5179". */
  readonly allowedOrigins: readonly string[];
  /** `Host` values the API answers to: the allowed origins' hosts plus its own address. */
  readonly allowedHosts: readonly string[];
}

export function sameOriginPolicy(allowedOrigins: readonly string[], ownAddresses: readonly string[]): SameOriginPolicy {
  return { allowedOrigins, allowedHosts: [...allowedOrigins.map((origin) => new URL(origin).host), ...ownAddresses] };
}

const SAFE_METHODS = new Set(["GET", "HEAD"]);

function forbidden(message: string): ApiFailure {
  return { success: false, error: message, code: "forbidden" };
}

/**
 * Only the app's own pages may call the API, so other local web pages cannot spend the key or
 * read a profile. No CORS headers are ever sent. Rules, in order:
 * - a `Host` outside the allowed set is refused (stops DNS rebinding);
 * - `Sec-Fetch-Site: cross-site` or `same-site` is refused (other ports on 127.0.0.1 are same-site);
 * - an `Origin` outside the allowed set is refused, and state-changing methods must send one.
 */
export function requireSameOrigin(policy: SameOriginPolicy): MiddlewareHandler {
  const origins = new Set(policy.allowedOrigins);
  const hosts = new Set(policy.allowedHosts);
  return async (context, next) => {
    const host = context.req.header("host");
    if (host !== undefined && !hosts.has(host)) {
      return context.json(forbidden(`Requests for host "${host}" are not served. Open the app at an allowed address.`), 403);
    }
    const fetchSite = context.req.header("sec-fetch-site");
    if (fetchSite === "cross-site" || fetchSite === "same-site") {
      return context.json(forbidden("Cross-site requests are not allowed. Call the API from the app's own pages."), 403);
    }
    const origin = context.req.header("origin");
    if (origin !== undefined && !origins.has(origin)) {
      return context.json(forbidden(`Origin "${origin}" may not call this API. Use the app's own pages.`), 403);
    }
    if (origin === undefined && !SAFE_METHODS.has(context.req.method)) {
      return context.json(forbidden(`${context.req.method} requests must come from the app's pages (send an Origin header).`), 403);
    }
    await next();
    return undefined;
  };
}
