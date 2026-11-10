# Batch D: deploy from GitHub to Cloudflare (report)

**Branch:** `deploy/cloudflare` (from `main` at a53bd58). **Date:** 10 Nov 2026. **Plan:** Cloudflare free.
**Status:** ready for the owner's one-time dashboard setup (`docs/DEPLOY.md`). The live deploy is not
verified yet, because it needs the owner's Cloudflare account (§5).

## 1. Summary

`main` can now deploy to Cloudflare Workers through Cloudflare's GitHub integration (Workers Builds),
with a Preview URL for every pull request. It needs no GitHub Actions and no secrets.

- **Kept:** the existing build (`@lovable.dev/vite-tanstack-config`, nitro `cloudflare-module`
  preset). The Lovable config package stays.
- **Added:**
  - a committed Wrangler config, `cloudflare/wrangler.jsonc`;
  - security headers that still let the on-device OCR run;
  - `docs/DEPLOY.md`, with the dashboard steps.
- **Lovable:** the Lovable-hosted app is unaffected while it stays live (§2.3).
- **No changes to:** dependencies, `package.json`, the lockfile, storage, the scanner, the app UI
  or `vite.config.ts`.

## 2. What was changed

### 2.1 Build investigation

`npm run build` runs Vite plus nitro (`cloudflare-module` preset) and writes:

| Output | What it is |
|---|---|
| `.output/server/index.mjs` (+ `_libs`, `_ssr`, `_chunks`) | The Worker: nitro's Cloudflare module entry, which serves static files from the `ASSETS` binding and sends everything else to TanStack Start SSR through `src/server.ts`. Already bundled, so Wrangler deploys it with `no_bundle`. |
| `.output/public/` | Client assets (`/assets/*`, favicon, robots.txt) and a generated `_headers`. |
| `.output/server/wrangler.json` + `.wrangler/deploy/config.json` | A Wrangler config nitro generates on every build (worker name auto-derived from the git remote, `compatibility_date` = the build date), and a "redirect" file that makes a plain `wrangler deploy` use it. |

nitro's generated config isn't stable enough to deploy from: the date changes daily and the name isn't
`splitlah`. nitro also merges any root-level `wrangler.json(c)` into it, and that happens inside
Lovable's own build too (Lovable's sandbox build keeps nitro's generated deploy config switched on).

### 2.2 `cloudflare/wrangler.jsonc`

| Setting | Value | Why |
|---|---|---|
| `name` | `splitlah` | Per the brief. Workers Builds requires it to match the Worker name in the dashboard. |
| `compatibility_date` | `2026-10-23` | Pinned. It's the newest date the `workerd` bundled with Wrangler 4.154.0 supports. |
| `compatibility_flags` | `nodejs_compat` | nitro's preset relies on Node compatibility. It's the default from 2026-08-04 anyway, so it's kept explicit for clarity. |
| `main`, `no_bundle`, `rules` | `../.output/server/index.mjs`, ESM rules | Points at nitro's already-bundled Worker. |
| `assets` | `../.output/public`, binding `ASSETS` | The client build; nitro's entry calls `env.ASSETS`. |
| `workers_dev`, `preview_urls` | `true` | The free `*.workers.dev` URL, and workers.dev Preview URLs for pull requests. |
| `vars` and `previews.vars` | `SPLITLAH_SECURITY_HEADERS = "on"` | Switches on the security headers (§3). Previews don't inherit top-level vars, and `wrangler preview` requires a `previews` block. |

There are no bindings beyond `ASSETS`, no secrets and no paid features.

**Why it's in `cloudflare/` and not the repository root.** nitro searches the project root and its
parents for `wrangler.json(c)` and merges what it finds into the config it generates, including
inside Lovable's build. The wrapper also rewrites that generated file in Lovable's sandbox, which
suggests Lovable's publish reads it. A root config could therefore push `name: "splitlah"` and the
headers variable into the live Lovable deploy. In `cloudflare/`, nitro never sees it. Every
Wrangler command passes `--config cloudflare/wrangler.jsonc`. I tested that an explicit `--config`
takes priority over nitro's redirect file.

The Workers Builds docs confirm this layout works:

- The automatic "configure your project" pull request only appears when the deploy command is the
  default `npx wrangler deploy` and no config is found. With `--config`, a config is found.
- The name check is done by Wrangler on the config it loads.

### 2.3 Effect on the Lovable-hosted app

I compared a simulated Lovable sandbox build (`LOVABLE_SANDBOX=1 npm run build`) of this branch with
the same build of `main` (a53bd58):

- **Wrangler config:** neither build generates one, and neither reads `cloudflare/wrangler.jsonc`.
- **Security headers:** the code is in the branch's server bundle but **dormant**. It only runs
  when the Worker variable `SPLITLAH_SECURITY_HEADERS` is `on`, and Lovable never sets it. So Lovable
  gets no CSP and no `frame-ancestors`, and its editor preview iframe keeps working.
- **The only output difference:** `client/_headers` (from `public/_headers`). If Lovable's host
  applies it, Lovable's static files gain `X-Content-Type-Options: nosniff` and
  `Referrer-Policy: same-origin`. That's harmless: no CSP or framing rules, and documents aren't
  affected.

This is a simulation of Lovable's build; I can't run Lovable's real publish pipeline.

### 2.4 Files

| File | Change |
|---|---|
| `cloudflare/wrangler.jsonc` | New: the Worker config (§2.2). |
| `src/lib/security-headers.ts` (+ test) | New: header list, CSP and the on/off check. Pure. |
| `src/server.ts` | Applies the headers to Worker-rendered responses when the variable is `on`. Reads the Worker env from where nitro puts it (`request.runtime.cloudflare.env`, else `globalThis.__env__`). The existing error handling is unchanged. |
| `public/_headers` | New: `nosniff` + `Referrer-Policy` for static files. nitro appends its own immutable cache rule for `/assets/*`. |
| `docs/DEPLOY.md` | New: the owner's dashboard steps. |
| `AGENTS.md` | One architecture line: where the deploy config lives, and the CSP rule. |

## 3. Security headers and why each is set

Cloudflare doesn't apply `_headers` to responses generated by Worker code, and every page here is
server-rendered by the Worker. So the page headers are added in `src/server.ts`. `public/_headers`
covers static files, which bypass the Worker.

**On pages (Worker responses):**

| Header / directive | Value | Why |
|---|---|---|
| CSP `default-src` | `'self'` | Deny by default. |
| CSP `script-src` | `'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdn.jsdelivr.net` | `'wasm-unsafe-eval'`: Tesseract compiles WebAssembly. jsDelivr: Tesseract's worker `importScripts()` its worker and core scripts from it (until Batch 2b self-hosts them). `'unsafe-inline'`: TanStack Start renders three small inline bootstrap scripts whose contents change per request; nonces aren't wired up yet (§6). No `'unsafe-eval'`. |
| CSP `worker-src` | `'self' blob:` | Tesseract starts its Web Worker from a `blob:` URL. |
| CSP `connect-src` | `'self' https://cdn.jsdelivr.net` | Same-origin requests plus Tesseract's model and core downloads. The photo is never uploaded, and this also blocks sending data anywhere else. |
| CSP `img-src` | `'self' blob: data:` | Receipt previews are `blob:` URLs made in the browser. |
| CSP `style-src` / `font-src` | `'self' 'unsafe-inline' https://fonts.googleapis.com` / `'self' https://fonts.gstatic.com` | The app loads Google Fonts (`src/routes/__root.tsx`); React may write `style` attributes. |
| CSP `object-src`, `base-uri`, `form-action` | `'none'`, `'self'`, `'self'` | Standard hardening; the app uses none of these cross-origin. |
| CSP `frame-ancestors` + `X-Frame-Options` | `'none'` + `DENY` | Nobody can frame the app (clickjacking). `X-Frame-Options` covers old browsers. |
| `X-Content-Type-Options` | `nosniff` | Browsers must not guess content types. |
| `Referrer-Policy` | `same-origin` | No referrer to jsDelivr or Google Fonts. Not `no-referrer`: that makes browsers send `Origin: null` on same-origin POSTs, which TanStack Start's CSRF check could reject. |
| `Permissions-Policy` | `camera=(self), microphone=(), geolocation=(), payment=(), usb=()` | Turns off features the app doesn't use. The camera stays allowed for the app itself. |
| `Cross-Origin-Opener-Policy` | `same-origin` | Isolates the window from cross-origin pop-ups. |

**On static files (`public/_headers`):** `X-Content-Type-Options: nosniff`,
`Referrer-Policy: same-origin`, plus nitro's `cache-control: public, max-age=31536000, immutable` on
`/assets/*`.

`upgrade-insecure-requests` and HSTS are not set: `workers.dev` is already HTTPS-only, and the
directive would break the local `http://` test.

## 4. Checks (all run on this branch, 10 Nov 2026)

| Check | Command | Result |
|---|---|---|
| Types | `npx tsc --noEmit` | ✅ clean |
| Tests | `npx vitest run` | ✅ 209/209 (205 before + 4 for the headers module) |
| Build | `npm run build` | ✅ succeeded |
| Clean build as Workers Builds does it | fresh clone, empty Bun cache, `CI=true WORKERS_CI=1`, `bun install --frozen-lockfile` (Bun 1.4.4, Cloudflare's default), `npm run build` | ✅ installed from the lockfile unchanged, in about 4 s, including the 14 packages pinned to Lovable's npm mirror; build OK |
| Wrangler dry run | `npx wrangler@4.154.0 deploy --dry-run --config cloudflare/wrangler.jsonc` | ✅ exit 0. Upload 1,720 KiB, 383 KiB gzipped. Bindings: `ASSETS`, `SPLITLAH_SECURITY_HEADERS ("on")` |
| `--config` beats nitro's redirect | dry run with and without `--config` | ✅ with `--config` our file is used; without it, Wrangler prints "Using redirected Wrangler configuration" |
| Preview command | `npx wrangler@4.154.0 preview --help` | ✅ the command exists in 4.154.0 and accepts `--config` (it has no dry run, see §5) |
| Lovable build isolation | `LOVABLE_SANDBOX=1 npm run build`, branch vs `main` | ✅ see §2.3 |
| Headers served | `wrangler dev --config cloudflare/wrangler.jsonc`, `curl -D -` | ✅ `/` and a 404 page carry the CSP and all other page headers; `/assets/*.js` and `/robots.txt` carry `nosniff`, `Referrer-Policy` and the immutable cache rule |
| Smoke test with headers on | Playwright + Chromium against `wrangler dev`, 420 px wide, synthetic rendered receipt | ✅ 9/9: load + hydrate; CSP enforced (a deliberate fetch to another origin was blocked); **scan with real Tesseract under the CSP** (4.3 s); review reads all 3 items and "Matches the receipt total exactly" (36.57); split with two people, every item assigned; summary shows both shares (29.38 + 7.19 = 36.57); **no CSP violations from the app** |
| Lint | `eslint` on the changed files | ✅ clean |

In the smoke test, jsDelivr and Google Fonts aren't reachable from the test sandbox. Tesseract's
files were served from local copies of the same packages, through request interception that keeps
their `cdn.jsdelivr.net` URLs, so the browser still applied the CSP to that origin. Font requests
were blocked, and the app fell back to system fonts.

## 5. Owner actions, and what is not verified

**Owner (once, in the dashboard):** follow `docs/DEPLOY.md`:

1. create a free Cloudflare account;
2. Workers & Pages → Create application → GitHub → import `strong0-23/Project-SplitLah-v-0.1`;
3. Worker name `splitlah`, build command `npm run build`, the pinned deploy and preview commands
   with `--config cloudflare/wrangler.jsonc`, production branch `main`, build variable
   `NODE_VERSION=22.23.4`;
4. Save and Deploy;
5. turn on Preview builds;
6. check the live URL, then retire Lovable.

Merge this PR before connecting, so the first `main` build finds the config. `DEPLOY.md` also
describes how to try it before merging.

**Not verified until the owner connects the account:**

- **The live deploy and live URL.** Account steps, GitHub app authorisation, the name check and the
  first real build all happen in the owner's account.
- **The Preview command and PR comments.** `wrangler preview` needs a Cloudflare account, so it was
  only checked to exist and accept `--config`.
- **Free-plan CPU time.** Workers Free allows 10 ms of CPU per request. Local `workerd` doesn't
  enforce it, and SSR time on Cloudflare is unmeasured. `DEPLOY.md` says how to spot an overrun
  (error 1102) and not to upgrade without deciding first.
- **Live third-party loads.** jsDelivr (Tesseract) and Google Fonts on the real site were simulated
  or blocked in the test; the CSP allows both.
- **Phones.** The smoke test ran in desktop Chromium at phone width, not on a phone.
- **Lovable's real publish.** §2.3 is a simulation of Lovable's build.

## 6. Risks and follow-ups

- **Lovable's npm mirror.** `bun.lock` pins 14 packages (tesseract.js and its dependencies) to
  `europe-west4-npm.pkg.dev/lovable-core-prod/sandbox-npm-cache`. It's publicly readable today:
  verified without credentials, and the tarball hash matches the lockfile. If Lovable ever closes
  it, Cloudflare builds will fail at install. The fix is to point those 14 lockfile entries back
  at the default registry (same versions, same hashes). That's a lockfile change, so it needs the
  owner's approval; I didn't make it now.
- **Pinned versions** (Wrangler 4.154.0, compatibility date 2026-10-23, Node 22.23.4) should be
  raised deliberately, together, after a local dry run.
- **CSP `'unsafe-inline'` for scripts.** A follow-up could wire per-request nonces into TanStack
  Start's SSR so `'unsafe-inline'` can be dropped.
- **Batch 2b self-hosting** the Tesseract and Paddle files removes jsDelivr from `script-src` and
  `connect-src`.
- **nitro is a beta** (`3.0.260603-beta`, via the Lovable config package). Its output layout could
  change on upgrade; the dry run would catch that.

## 7. Cost guard

Everything used is on the free plan: Workers Free (100,000 requests/day, 10 ms CPU), Workers Builds
Free (3,000 build minutes/month, one build at a time), Workers static assets, workers.dev URLs and
Previews (100 per Worker on Free). Nothing needed a paid plan.
