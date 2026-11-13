# Issue #1192 handoff, slice rsx-a: re-save the bundled examples with the 0.6.0 app

Branch `fix/issue-1192-resave-examples`, based on `integration/0.6.0`. Frank approved the plan for 0.6.0 (issue #1192). The PR goes into `integration/0.6.0` with `Closes #1192`.

**Frank's rule: convert the examples with the app. Never edit the `.camj` JSON by hand or with a JSON script.**

## Task
1. **Write the re-save script.** Write `scripts/resave-examples.ts`, a Playwright script that drives the real app in the dev server. Start the server on an isolated port (`PURECUT_E2E_PORT`, never 1420). For each entry in `public/examples/manifest.json`:
   - open it the way a user does: **File → New project**, then the examples list, then the example;
   - wait until it has loaded and generated;
   - save it through the app's own Save (in the browser this is a download: capture it with Playwright's `download` event; see `src/platform/browser.ts`);
   - write the saved file over `public/examples/<file>`.

   Add `"examples:resave": "npx tsx scripts/resave-examples.ts"` to `package.json`.
2. **Write the before/after check.** Write `scripts/resave-examples-check.ts`, which must run on the old and new files. Through the app's own loader and exporter (the same functions the app uses), it records for each example:
   - the load warnings;
   - the feature and operation counts;
   - the G-code for all operations on the example's machine, or the default machine.

   It writes them to `work/1192-before.json` and `work/1192-after.json`. Run it before step 1 and after it.
3. **Run the re-save** and commit the three re-saved `.camj` files.
4. **Extend the guard.** In `src/components/project/exampleManifest.test.ts`, every bundled example must also carry `meta.projectType` and a non-empty `setups` array. Show that this fails on the old files (run it against `git show HEAD~:public/examples/...` copies) and passes on the new ones.
5. **Thumbnails:** leave the `.png` files as they are.

## Acceptance
- **Re-saved by the app:** the diff of each `.camj` holds only the fields the app adds or normalises (`meta.projectType`, `setups`, `activeSetupId`, `setupId`, `authoringFace`, plus any key order or number format the app's save applies). List anything else in your report.
- **Before and after match:**
  - zero load warnings after (and before, if there were any, list them);
  - the same counts;
  - G-code byte-identical, except the date or time line.

  Put a summary table in your report.
- `npm run build` is green.
- Run any e2e spec that opens the examples (grep `e2e/` for `examples`) with `PURECUT_E2E_ISOLATED=1`, a free port and `--workers=2`.
- Send a short report: files changed, what you ran, the table.
