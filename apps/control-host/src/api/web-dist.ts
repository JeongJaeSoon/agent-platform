import { join, resolve, sep } from "node:path";
import type { Context } from "hono";

/*
 * The web console's built files (apps/web/dist), served by the api role when
 * WEB_DIST_DIR is set. Any path that is not a file gets index.html so the
 * client router can take it, except under the API's own prefixes: /v1/nope
 * stays a JSON 404, never a page that answers 200.
 */

const API_PREFIXES = ["/v1", "/internal"];

const SECURITY_HEADERS = {
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

// The build emits no inline script or style, so nothing needs a nonce.
const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export function isApiPath(path: string): boolean {
  return API_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

/** A file under `root` for the URL path, or null; never a path outside it. */
function fileUnder(root: string, path: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const target = resolve(join(root, decoded));
  return target.startsWith(`${root}${sep}`) ? target : null;
}

/**
 * The handler for GET and HEAD outside the API, or null when the request is
 * the API's to answer (the caller sends its own 404 then).
 */
export function createWebDistHandler(directory: string) {
  const root = resolve(directory);
  const index = join(root, "index.html");
  return async (context: Context): Promise<Response | null> => {
    const path = context.req.path;
    if (isApiPath(path)) return null;
    const target = fileUnder(root, path);
    if (target && target !== index) {
      const file = Bun.file(target);
      if (await file.exists()) {
        return new Response(file, {
          headers: {
            ...SECURITY_HEADERS,
            // Vite names everything under assets/ by content hash.
            "Cache-Control": path.startsWith("/assets/")
              ? "public, max-age=31536000, immutable"
              : "no-cache",
          },
        });
      }
    }
    // A missing hashed asset is a stale page asking for an old build; HTML in
    // its place would be parsed as script or style.
    if (path.startsWith("/assets/")) return null;
    return new Response(Bun.file(index), {
      headers: {
        ...SECURITY_HEADERS,
        "Cache-Control": "no-cache",
        "Content-Security-Policy": APP_CSP,
        "Content-Type": "text/html; charset=utf-8",
      },
    });
  };
}
