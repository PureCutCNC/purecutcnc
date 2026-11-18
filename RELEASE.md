# Release runbook

How a PureCutCNC release goes from the integration branch to the public site.
Run the steps in this order. Each step says why it sits where it does.
The maintainer decides when to publish and merges into `main`; agents prepare,
verify and report.

Written after 0.6.0 (#1230). The tracking issue for a release (for 0.6.0, #962)
holds its plan of record; this file holds only the procedure.

## 1. Merge the release into `main`

- Open one PR from `integration/X.Y.Z` into `main`. CI must be green and the
  description needs its Manual impact section (see the `manual-impact` skill).
- Before opening it, run the full e2e suite locally on an isolated server
  (`PURECUT_E2E_ISOLATED=1 PURECUT_E2E_PORT=<free port>`), and `npm run
  check:gcode`. QtPlasmaC is slow locally; let it finish rather than calling a
  timeout a failure.
- The maintainer merges.

## 2. Build the desktop RCs, after the merge

- Dispatch `deploy-windows.yml`, `deploy-macos.yml` and `deploy-linux.yml` on
  `main` with `version=X.Y.Z-rc.N`. A version with a `-` becomes the
  pre-release tag `vX.Y.Z-rc.N`. The web RC (`deploy-rc.yml`) runs on every
  push to `main` by itself.
- Check that the RC tag points at current `main` and that all four installers
  are attached (`.AppImage`, `.deb`, `.dmg`, `-setup.exe`).
- **Windows and macOS builds catch what Linux CI can't.** Their file systems
  ignore letter case, so two files that differ only in case break the build
  (#1196). `src/sourceFileCaseClash.test.ts` now guards that case; any other
  RC failure on one platform gets a fix PR into `main`, then a re-run.
- The maintainer and testers test the RC.

## 3. New work after an RC means a new RC

Anything merged into `main` after `rc.N` was built (fixes, a late feature) is
untested in a desktop build. Build `rc.N+1` from the new `main` and hand that
one to testers, rather than publishing on top of an untested build.

## 4. Draft the GitHub release

- Keep the release notes in the primary checkout's `work/` folder while they
  are drafted, because a worktree prune can delete files in a worktree.
- Before creating the draft, list everything merged into `main` since the notes
  were written (`git log --first-parent`), and add it.
- Create the draft from the notes:
  `gh release create vX.Y.Z --draft --target main --title "PureCutCNC vX.Y.Z" --notes-file <notes>`.
- A draft is visible only to maintainers who are signed in, and its URL reads
  `untagged-…` until it is published.

## 5. The maintainer publishes

Publishing creates the `vX.Y.Z` tag and starts `deploy.yml` ("Build and Deploy
to GitHub Pages"), which deploys the web app. Wait for it to succeed.

## 6. Then build the stable desktop installers

- Dispatch the three desktop workflows with `version=X.Y.Z` (no `-`).
- **Never before step 5.** A stable build also pushes the public download
  metadata (`downloads/stable/*.json`) to `PureCutCNC/purecutcnc.github.io`.
  Run early, it points the download page at a release that isn't public yet,
  and its upload step may not find the untagged draft.
- Check the release now has every installer (for 0.6.0: `.exe`, `.msi`,
  universal `.dmg`, `.AppImage`, `.deb`).

## 7. Publish the manual

The manual for a release is a stack of draft PRs in
`PureCutCNC/purecutcnc.github.io`, each based on the one before. Follow that
repo's `AGENTS.md` release playbook (hero tagline, landing copy, preview
notices), with these rules:

- **Use a docs integration branch.** Create `integration/X.Y.Z` there from its
  `main`, merge the slice PRs into it in order, then open one PR into docs
  `main` for the maintainer to merge.
- **Retarget with the API.** `gh pr edit --base` fails on these repos (a
  Projects classic GraphQL error) and changes nothing. Use
  `gh api -X PATCH repos/OWNER/REPO/pulls/N -f base=<branch>`, and the same
  call with `-F body=@file` to edit a description.
- **Check `baseRefName` before every merge.** On 0.6.0, a retarget failed
  silently and the next merge sent the first slice straight to docs `main`,
  which started a partial public deploy. A push to docs `main` deploys the
  site.
- **Trust the checks over the PR text.** A slice PR's "still to do" list goes
  stale. `npm run content:cutover` and `npm run verify:cutover` in `site/`
  must pass; they report draft pages, missing images and pending visuals.

## 8. Close out

- Comment on the release tracking issue with what shipped, then close it and
  any umbrellas that shipped with it.
- Remove the release's merged worktrees, after checking each is clean and
  merged.
