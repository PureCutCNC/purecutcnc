---
status: Draft   # Draft → Approved → In progress → Done | Abandoned
created: 2026-06-02
---

# Check For Updates (User-Initiated) Plan

## Goal

Let the user manually check whether a newer version of PureCutCNC is available,
on both the web and desktop (Tauri) builds. The check is **always user-initiated**
— no automatic or background polling. The user-visible outcome is an **About
PureCutCNC** dialog that shows the running version and a **Check for updates**
button which reports one of: "up to date", "a new version is available"
(with an action to get it), or "couldn't check" (offline/error).

## Approach

Reuse the version infrastructure that already exists:

- **Web** is deployed to `purecutcnc.github.io/app/` and `deploy.yml` writes
  `version.json` (`{version, name, date, url}`) at the app root on every
  published release. `src/utils/version.ts` already fetches it at startup.
- **Desktop** stamps `package.json` at build time (`npm version`), and
  `tauri.conf.json` reads `version` from it, so the running version is available
  via `@tauri-apps/api/app` `getVersion()`. The mac/win/linux deploy workflows
  publish `downloads/{channel}/{platform}.json` (`{version, tag, releaseUrl,
  assets[]}`, channels `stable`/`snapshot`) to the pages repo — a CORS-friendly
  "latest release" manifest.

High-level strategy:

- Add a platform-agnostic **update-check core** with a semver comparison helper
  and a `checkForUpdate()` that resolves to a discriminated result
  (`up-to-date` | `update-available` | `offline`).
- **Web flow:** capture the startup `version.json` value as the "running"
  version; on demand, re-fetch `version.json` cache-busted (`cache: 'no-store'`)
  and compare. If the server version is newer, the loaded bundle is stale →
  offer **Reload** (`location.reload()`). Standard SPA-update pattern; reliable
  because GH Pages serves hashed asset filenames + a fresh `version.json`.
- **Desktop flow:** current version from `getVersion()`; fetch
  `https://purecutcnc.github.io/downloads/{channel}/{platform}.json`, where
  platform is detected from the webview `navigator.userAgent` (no OS plugin
  needed) and channel comes from a user setting (**stable** default, with a
  **snapshot** opt-in toggle). If newer → offer **Open download page**
  (`releaseUrl` / first asset URL) in the external browser.
- **Channel setting:** persist a `updateChannel: 'stable' | 'snapshot'`
  preference (localStorage-backed, desktop-only UI). Default `stable`.
- **External-open + version on desktop** require the
  `@tauri-apps/plugin-opener` plugin (new dep + capability entry). This is the
  same plugin the `revealInFileManager` stub in `desktop.ts` is already waiting
  on, so wiring it also unblocks that stub (will be implemented as part of this
  change since it becomes trivial).
- **UI:** a new **About PureCutCNC** dialog (version, build date, links,
  license line) containing the **Check for updates** button and result state.
  Triggered from a new entry in the existing global/overflow menu in
  `TopCommandBar`.

## Files affected

- *(new)* `src/utils/updateCheck.ts` — `compareVersions()` semver helper,
  `UpdateResult` type, `checkForUpdate(opts)` orchestrating web vs desktop.
- *(new)* `src/utils/updateCheck.test.ts` — unit tests for `compareVersions`
  and result classification (newer/older/equal, prerelease tags, malformed).
- `src/utils/version.ts` — expose the startup version value (cache it) and a
  helper to re-fetch `version.json` cache-busted; small refactor, no behavior
  change to `applyVersionToTitle`.
- `src/platform/api.ts` — add `getAppVersion(): Promise<string>` and
  `openExternal(url: string): Promise<void>` to `PlatformApi`.
- `src/platform/desktop.ts` — implement `getAppVersion` via
  `@tauri-apps/api/app` `getVersion`, `openExternal` + `revealInFileManager`
  via `@tauri-apps/plugin-opener`.
- `src/platform/browser.ts` — `getAppVersion` returns the web running version;
  `openExternal` via `window.open(url, '_blank', 'noopener')`.
- *(new)* `src/components/about/AboutDialog.tsx` — modal (follows existing
  dialog patterns, e.g. `NewProjectDialog.tsx`): shows version/build info,
  Check-for-updates button, result message + contextual action (Reload /
  Open download page), and (desktop only) the stable/snapshot channel toggle.
- *(new)* `src/components/about/about.css` (or reuse existing dialog styles) —
  minimal styling consistent with current dialogs.
- `src/components/layout/TopCommandBar.tsx` — add an "About / Check for
  updates" entry to the existing overflow/global menu that opens the dialog.
- `src/store/` (a small UI slice or existing settings location) — persist
  `updateChannel` preference. Exact location confirmed during implementation
  to match how other UI prefs are stored.
- `src-tauri/capabilities/default.json` — add the `opener` plugin permissions.
- `src-tauri/Cargo.toml` + `src-tauri/src/lib.rs` — register
  `tauri-plugin-opener`.
- `package.json` — add `@tauri-apps/plugin-opener` dependency.
- `INDEX.md` updates for any new folders (`src/components/about/`).

## Tests

- `src/utils/updateCheck.test.ts` (runs under the existing `npm test` /
  `scripts/run-tests.ts` harness): `compareVersions` ordering incl. equal,
  patch/minor/major, prerelease (`1.0.0-rc.1` < `1.0.0`), `v`-prefix
  tolerance, and malformed input; classification of `checkForUpdate` results
  given injected current/latest values (network fetch mocked/injected so the
  test stays offline).

## Open questions / risks

- **Desktop `version.json` is not present in the Tauri bundle** (only
  `deploy.yml` writes it for the web). Resolved by sourcing the desktop running
  version from `getVersion()` instead — already reflected above.
- **Pages-repo manifest availability:** the desktop check depends on
  `downloads/{channel}/{platform}.json` existing on the pages site. If a
  channel/platform manifest is missing, the check degrades to the "couldn't
  check" state rather than erroring. (No code change needed in the deploy
  workflows for this feature.)
- **Snapshot semver compare:** prerelease tags must compare correctly so a
  stable user isn't told a `-snapshot` build is "newer". Covered by tests.

## Out of scope

- Automatic / background update checks or notifications (explicitly excluded —
  feature is user-initiated only).
- Tauri's native auto-download/-install updater (would require code-signing
  keys + signed update manifests not currently set up).
- Changes to the release/deploy GitHub workflows.
- In-app changelog rendering (the dialog links to the release page instead).
