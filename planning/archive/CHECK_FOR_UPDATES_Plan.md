---
status: Done   # Draft → Approved → In progress → Done | Abandoned
created: 2026-06-02
---

# Check For Updates (User-Initiated) Plan

## Goal

Let the desktop (Tauri) user manually check whether a newer version of
PureCutCNC is available, and give the web user an About surface. The check is
**always user-initiated** — no automatic or background polling.

Scope was refined after review:

- **Web** always loads the freshly deployed bundle on start, so an update check
  is redundant there. Web gets only a new **About** dialog (version, links,
  license) — no update check.
- **Desktop** already has a **native** "About PureCutCNC" item
  (`PredefinedMenuItem::about` in `src-tauri/src/lib.rs`). We **keep that
  untouched** and add a separate, user-initiated **"Check for Updates…"** native
  menu action that reports "up to date", "a new version is available" (with an
  action to open the download page), or "couldn't check" (offline/error).

## Approach

Reuse existing infrastructure and the existing native-menu event pattern:

- **Desktop running version** comes from `@tauri-apps/api/app` `getVersion()`
  (Tauri reads it from the `package.json` version stamped at build time).
- **Desktop "latest" manifest:** the mac/win/linux deploy workflows already
  publish `downloads/{channel}/{platform}.json` (`{version, tag, releaseUrl,
  assets[]}`, channels `stable`/`snapshot`) to the pages repo. The check fetches
  `https://purecutcnc.github.io/downloads/{channel}/{platform}.json` — a
  CORS-friendly, rate-limit-free source.
- **Native menu wiring:** the Rust shell already forwards menu clicks to the
  frontend as a `"menu"` event handled by a `switch` in
  `useDesktopIntegration.ts`. Add a `"check_updates"` menu item (plus a channel
  submenu, see below) and a matching `case` — no new IPC mechanism.

Desktop flow on "Check for Updates…":
1. Read current version via `getVersion()`.
2. Detect platform from the webview `navigator.userAgent` (no OS plugin needed).
3. Fetch the channel/platform manifest; `compareVersions` against current.
4. Show the result with the **native dialog** (`@tauri-apps/plugin-dialog`):
   - up to date → `message("You're on the latest version (x.y.z).")`
   - newer available → `ask("Version x.y.z is available. Open the download
     page?")`; on confirm, open `releaseUrl`/first asset URL in the external
     browser via `@tauri-apps/plugin-opener`.
   - fetch/parse failure → `message("Couldn't check for updates. …")`.

**Release channel (stable + snapshot):** **confirmed required.** Add an
**"Update Channel"** native submenu with two `CheckMenuItem`s (Stable /
Snapshot). The choice persists in `localStorage`; on startup the frontend reads
it and sets the check state, and toggling updates both the persisted value and
the checkmarks. This is the main bit of new plumbing (accessing menu items by id
to toggle `checked`).

**Default channel:** since only snapshot desktop builds are published today
(stable release publishing isn't set up yet), the **default channel is
`snapshot`** so the check works out of the box. When the stable manifest is
absent, a stable-channel check degrades to a clear "No stable release is
published yet" message rather than a generic error. The default constant is a
one-line change to flip to `stable` once stable releases exist.

**Web About dialog:** a React modal (following existing dialog patterns, e.g.
`NewProjectDialog.tsx`) showing version (from the startup `version.json` already
loaded by `version.ts`), build date, project links, and the license line. Opened
from a new "About" entry in the existing `TopCommandBar` overflow/global menu.
Rendered only in the browser (desktop uses its native About).

## Files affected

- *(new)* `src/utils/updateCheck.ts` — `compareVersions()` semver helper,
  `UpdateResult` type, and `checkDesktopUpdate(channel)` that fetches the
  manifest and classifies the result. (Desktop-only logic; kept pure/injectable
  for testing.)
- *(new)* `src/utils/updateCheck.test.ts` — unit tests for `compareVersions`
  (patch/minor/major, prerelease `1.0.0-rc.1 < 1.0.0`, `v`-prefix, malformed)
  and result classification given injected current/latest values (no network).
- `src/platform/api.ts` — add `getAppVersion(): Promise<string>` and
  `openExternal(url: string): Promise<void>` to `PlatformApi`.
- `src/platform/desktop.ts` — implement `getAppVersion` via
  `@tauri-apps/api/app`; `openExternal` (+ the existing `revealInFileManager`
  stub, which this unblocks) via `@tauri-apps/plugin-opener`.
- `src/platform/browser.ts` — `getAppVersion` returns the web version;
  `openExternal` via `window.open(url, '_blank', 'noopener')`.
- `src/platform/useDesktopIntegration.ts` — add `case 'check_updates'` (run the
  check + native dialogs) and `case 'channel_stable' | 'channel_snapshot'`
  (persist + update checkmarks) to the existing menu `switch`; set initial
  checkmarks from persisted channel during desktop setup.
- *(new)* `src/components/about/AboutDialog.tsx` — **web** About modal.
- *(new)* `src/components/about/about.css` *(or reuse existing dialog styles)*.
- `src/components/layout/TopCommandBar.tsx` — add an "About" entry (web) to the
  existing overflow/global menu that opens the dialog.
- `src/utils/version.ts` — expose the cached startup version for the About
  dialog / `browser.getAppVersion` (small refactor; no behavior change to
  `applyVersionToTitle`).
- `src-tauri/src/lib.rs` — add the "Check for Updates…" menu item and the
  "Update Channel" submenu with two `CheckMenuItem`s; they emit through the
  existing `on_menu_event` path.
- `src-tauri/capabilities/default.json` — add `opener` plugin permissions.
- `src-tauri/Cargo.toml` — register `tauri-plugin-opener`.
- `package.json` — add `@tauri-apps/plugin-opener`.
- `INDEX.md` — note the new `src/components/about/` folder.

## Tests

- `src/utils/updateCheck.test.ts` under the existing `npm test` /
  `scripts/run-tests.ts` harness: `compareVersions` ordering incl. equality,
  prerelease precedence, `v`-prefix tolerance, malformed input; and
  classification of `checkDesktopUpdate` results from injected current/latest
  values (network fetch injected so tests stay offline).

## Open questions / risks

- **Native `CheckMenuItem` sync:** toggling/reading channel checkmarks from the
  frontend requires resolving menu items by id at runtime. Confirmed in scope
  (channel toggle is required). If runtime checkmark sync proves fiddly, the
  checkmark visuals can fall back to being set once at startup from the
  persisted value — the toggle behavior itself still works.
- **Manifest availability:** a missing channel/platform manifest degrades to the
  "couldn't check" state rather than erroring. No deploy-workflow change needed.
- **Snapshot semver compare:** prerelease tags must order correctly so a stable
  user isn't told a `-snapshot` build is "newer". Covered by tests.

## Out of scope

- Any change to the **desktop native About** dialog (kept as-is).
- An update check on **web** (redundant — always loads fresh).
- Automatic / background update checks or notifications.
- Tauri's native auto-download/-install updater (needs code-signing keys not set
  up today).
- Changes to the release/deploy GitHub workflows.
- In-app changelog rendering (link to the release page instead).
