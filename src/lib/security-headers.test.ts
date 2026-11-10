import { describe, expect, it } from "vitest";
import {
  CONTENT_SECURITY_POLICY,
  OCR_ASSET_ORIGIN,
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

  it("let the on-device OCR run: blob: workers, WebAssembly and jsDelivr model files", () => {
    expect(directive("worker-src")).toContain("blob:");
    expect(directive("script-src")).toContain("'wasm-unsafe-eval'");
    expect(directive("script-src")).toContain(OCR_ASSET_ORIGIN);
    expect(directive("connect-src")).toContain(OCR_ASSET_ORIGIN);
    expect(directive("img-src")).toContain("blob:");
    expect(directive("script-src")).not.toContain("'unsafe-eval'");
  });

  it("deny framing and lock down everything else", () => {
    expect(directive("frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive("default-src")).toBe("default-src 'self'");
    expect(directive("object-src")).toBe("object-src 'none'");
    expect(
      directive("connect-src")
        .split(" ")
        .filter((s) => s.startsWith("http")),
    ).toEqual([OCR_ASSET_ORIGIN]);
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
