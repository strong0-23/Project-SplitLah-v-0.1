/**
 * Production guard of the dev-only phone timing page (/dev/engine-timing): it must follow the dev
 * engine switch exactly, and answer "not found" whenever the switch is not compiled in.
 */
import { isNotFound } from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { engineSwitchForBuild } from "@/lib/scan/paddle-assets";

/** Fresh copies of the modules under a given build environment. */
async function load(env: { DEV: boolean; switch: string }) {
  vi.resetModules();
  vi.stubEnv("DEV", env.DEV);
  vi.stubEnv("VITE_SPLITLAH_ENGINE_SWITCH", env.switch);
  const pages = await import("./dev-pages");
  const select = await import("@/lib/scan/engine-select");
  const { Route } = await import("@/routes/dev.engine-timing");
  const beforeLoad = Route.options.beforeLoad as unknown as () => void;
  return { pages, select, beforeLoad };
}

const BUILDS = [
  { name: "production build (no switch)", DEV: false, switch: "" },
  { name: "build of main with the switch requested (compiled as empty)", DEV: false, switch: "" },
  { name: "preview build with VITE_SPLITLAH_ENGINE_SWITCH=on", DEV: false, switch: "on" },
  { name: "build with any other value", DEV: false, switch: "yes" },
  { name: "npm run dev", DEV: true, switch: "" },
];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("dev page guard", () => {
  it.each(BUILDS)("matches the engine switch: $name", async (b) => {
    const { pages, select } = await load(b);
    expect(pages.DEV_PAGES_ENABLED).toBe(select.ENGINE_SWITCH_ENABLED);
    expect(pages.DEV_PAGES_ENABLED).toBe(b.DEV || b.switch === "on");
  });

  it("answers not found and loads nothing when the switch is off", async () => {
    const { pages, beforeLoad } = await load({ DEV: false, switch: "" });
    let thrown: unknown;
    try {
      beforeLoad();
    } catch (e) {
      thrown = e;
    }
    expect(isNotFound(thrown)).toBe(true);
    expect(pages.loadEngineTimingPage()).toBeNull();
  });

  it("opens when the switch is compiled in", async () => {
    const { beforeLoad } = await load({ DEV: false, switch: "on" });
    expect(() => beforeLoad()).not.toThrow();
  });

  it("a Workers Builds build of main never compiles the switch in", () => {
    // vite.config.ts compiles VITE_SPLITLAH_ENGINE_SWITCH as "" when this is "blocked".
    expect(engineSwitchForBuild("on", "main")).toBe("blocked");
    expect(engineSwitchForBuild("on", "engine-comparison")).toBe("on");
  });
});
