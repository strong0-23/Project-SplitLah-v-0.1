import { describe, expect, it } from "vitest";
import {
  CONTENT_SECURITY_POLICY,
  SECURITY_HEADERS,
  securityHeadersEnabled,
  withSecurityHeaders,
} from "./security-headers";

const directive = (name: string) =>
  CONTENT_SECURITY_POLICY.split("; ").find((d) => d.startsWith(`${name} `)) ?? "";

describe("security headers (Batch D)", () => {
  it("are off unless the Worker env sets SPLITLAH_SECURITY_HEADERS=on", () => {
    expect(securityHeadersEnabled({ SPLITLAH_SECURITY_HEADERS: "on" })).toBe(true);
    for (const env of [
      undefined,
      null,
      {},
      { SPLITLAH_SECURITY_HEADERS: "off" },
      { SPLITLAH_SECURITY_HEADERS: true },
      "on",
    ])
      expect(securityHeadersEnabled(env)).toBe(false);
  });

  it("let the self-hosted on-device OCR run: same-origin workers and files, WebAssembly", () => {
    expect(directive("worker-src")).toBe("worker-src 'self'");
    expect(directive("connect-src")).toBe("connect-src 'self'");
    expect(directive("script-src")).toBe("script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'");
    // Receipt previews are blob: URLs created in the browser.
    expect(directive("img-src")).toContain("blob:");
  });

  it("allow no CDN, no blob: workers and never 'unsafe-eval'", () => {
    expect(CONTENT_SECURITY_POLICY).not.toContain("jsdelivr");
    for (const name of ["script-src", "worker-src", "connect-src", "default-src"])
      expect(directive(name)).not.toContain("blob:");
    expect(CONTENT_SECURITY_POLICY).not.toContain("'unsafe-eval'");
    // The only third-party origins left are Google Fonts (stylesheet and font files).
    const thirdParty = CONTENT_SECURITY_POLICY.split(/[ ;]+/).filter((s) => s.startsWith("http"));
    expect([...new Set(thirdParty)].sort()).toEqual([
      "https://fonts.googleapis.com",
      "https://fonts.gstatic.com",
    ]);
  });

  it("deny framing and lock down everything else", () => {
    expect(directive("frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive("default-src")).toBe("default-src 'self'");
    expect(directive("object-src")).toBe("object-src 'none'");
    expect(SECURITY_HEADERS).toMatchObject({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "X-Frame-Options": "DENY",
    });
  });

  it("adds the headers without changing status, body or existing headers", async () => {
    const original = new Response("<p>ok</p>", {
      status: 404,
      statusText: "Not Found",
      headers: { "content-type": "text/html; charset=utf-8", "x-custom": "kept" },
    });
    const res = withSecurityHeaders(original);
    expect(res.status).toBe(404);
    expect(res.statusText).toBe("Not Found");
    expect(res.headers.get("x-custom")).toBe("kept");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toBe(CONTENT_SECURITY_POLICY);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(await res.text()).toBe("<p>ok</p>");
  });
});
