/**
 * Security headers for the Cloudflare deploy (Batch D). Pure; used by src/server.ts.
 *
 * They are switched on by the Worker variable SPLITLAH_SECURITY_HEADERS="on", which only
 * cloudflare/wrangler.jsonc sets. Lovable's build never sees that file, so the Lovable-hosted app
 * (and its editor preview, which shows the app in an iframe) is unchanged while it stays live.
 *
 * The CSP must still let the on-device OCR run (hard rule 2: recognition stays in the browser).
 * Both engines are self-hosted (Batch 2b): Tesseract's worker, core and language files and Paddle's
 * models and runtime come from the app's own origin, and each engine runs in a same-origin Web
 * Worker (no blob: workers). So no third-party script or connect origin is needed for OCR.
 * See docs/reports/2026-11-cloudflare-deploy.md for why each directive is there.
 */

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  // 'unsafe-inline': TanStack Start renders small inline bootstrap scripts whose contents change
  // per request (no nonce support wired up yet). 'wasm-unsafe-eval': kept for WebAssembly. Both
  // engines worked without it in Chromium, but that is unverified in Firefox and Safari.
  // Never add 'unsafe-eval' here.
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  // OCR workers are started from their same-origin URLs.
  "worker-src 'self'",
  // Same-origin requests only (OCR engine and model files are self-hosted). Images are never uploaded.
  "connect-src 'self'",
  "img-src 'self' blob: data:",
  // Google Fonts stylesheet (src/routes/__root.tsx); React style attributes.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** Headers added to every response the Worker generates (the server-rendered pages). */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "X-Content-Type-Options": "nosniff",
  // same-origin: no referrer to Google Fonts, but same-origin requests keep their
  // Origin header (no-referrer would send "Origin: null" and could trip CSRF checks).
  "Referrer-Policy": "same-origin",
  // Legacy equivalent of frame-ancestors 'none'.
  "X-Frame-Options": "DENY",
  // The app needs none of these; camera stays allowed for this origin only.
  "Permissions-Policy": "camera=(self), microphone=(), geolocation=(), payment=(), usb=()",
  "Cross-Origin-Opener-Policy": "same-origin",
};

export const SECURITY_HEADERS_FLAG = "SPLITLAH_SECURITY_HEADERS";

/** True when the Worker's environment turns the headers on (cloudflare/wrangler.jsonc). */
export function securityHeadersEnabled(env: unknown): boolean {
  return (
    typeof env === "object" &&
    env !== null &&
    (env as Record<string, unknown>)[SECURITY_HEADERS_FLAG] === "on"
  );
}

/** Returns the response with the security headers set (existing values are replaced). */
export function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
