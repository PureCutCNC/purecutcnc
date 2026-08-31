# GPU toolpath renderer and comparison harness — issue #683

The sketch toolpath panel offers **GPU** as its first inline toggle in production:
on selects GPU, off selects Canvas.
When Canvas repeatedly takes longer to draw toolpaths during navigation, a
non-blocking tip offers **Enable GPU** or **Not now** after the gesture ends.
Either action, or a manual renderer selection, suppresses future tips in that
browser (`purecutcnc.gpuSuggestionHandled`). Nothing switches automatically.
The bounded heuristic ignores the first navigation draw, then requires six
consecutive draws of at least 40 ms with no idle gap above 1.5 seconds (drawing
time does not count as idle). These are UX
trigger settings, not an FPS measurement or a universal toolpath-size limit.
Canvas remains the default, fallback and booklet renderer. The choice is stored
locally for this application, not in the project or undo history, and never
invalidates CAM results. GPU failures display a Canvas fallback message and
**Retry GPU** while preserving the GPU preference. GPU default enablement and
Canvas retirement need separate maintainer approval.

`REPORT.md` and `evidence.json` are historical POC evidence from PR #691; their
measurements are not new Phase 2 or production-device acceptance results.

## Run

From this worktree:

```sh
node tools/gpu-toolpath-poc/server.mjs
```

Open the printed Canvas URL in a hardware-accelerated browser; change
`?toolpathRenderer=canvas` to `?toolpathRenderer=gpu` for comparison. These
DEV-only overrides do not overwrite the stored preference. The regular
development server accepts the same overrides without the diagnostic panel.
Production builds ignore the URL override and use the normal selector.

The comparison server binds only to 127.0.0.1, port 1683 by default.
`PURECUT_GPU_POC_PORT` changes the port. Ctrl-C stops it.

1. Keep browser, viewport, DPR and display settings identical. Record the commit
   and browser GPU diagnostics separately; the harness does not infer hardware
   acceleration from successful WebGL initialization.
2. Click **Load rectangle** or **Load raster**. Select its operation in the CAM
   panel and wait for generation. These are the tracked 249,663-move rectangle
   and 882,899-move raster rendering surrogate, not a machining-safety test.
3. Use **Zoom to model**, label the capture (fit/close, directions on/off),
   click **Capture next gesture**, then Shift-drag or wheel over the sketch.
   Repeat with Directions off and at close zoom. Use an ordinary small project
   through the normal Open workflow too; label its identity.
4. Results appear in the diagnostic panel. Raw input, requestAnimationFrame and
   repaint timestamps accumulate in the DOM `script#b683-data` JSON element.
   Save it before reloading or switching the URL.
5. **Alpha swatch** compares one segment with 1,000 coincident segments and a
   crossing, at unselected alpha. It is explicitly synthetic. It temporarily
   creates an additional WebGL context; close it before measuring the app.

Capture records are observational, not CI timing assertions. An automation-paced
drag is not an unrestricted physical-device input stream. Sparse wheel events
may yield too few paint intervals for a meaningful cadence statistic. rAF
timestamps describe callback cadence; Canvas clear timestamps describe repaint
starts. Neither proves compositor presentation cadence. Do not derive FPS from
a rendering callback's duration. Settling paint delays are relative to the final
input, not proof that GPU work completed then.

The GPU canvas's `data-poc-stats` reports retained-buffer preparation count,
CPU preparation time, render submissions and first nonempty CPU submission time.
Submission time includes driver/upload submission but is **not GPU-completion
time**. Verify that preparation count stays constant across pan and zoom.

## Rendering and ownership

- Existing sketch input, navigation state and frame scheduler remain the owner.
  The GPU consumes the exact Canvas backing dimensions and similarity transform;
  no second camera control or gesture state exists.
- Original Canvas paints background/features. A transparent WebGL canvas paints
  paths and each operation's annotations in painter order; a transparent Canvas
  above it paints the remaining sketch interaction overlays.
- Full XY segments are uploaded in 65,536-segment chunks, retained by toolpath
  identity/slot-feed display data. Navigation updates uniforms, not move arrays.
- Opaque, depth-free multisampled coverage is rendered per operation/layer/feed
  bucket, then composited once with shared theme alpha and selection emphasis.
  This avoids independently accumulating alpha for overlapping segment quads.
- Shared layer declarations, feed classification and style definitions are used.
  Collision overlays remain visible even when ordinary layers are hidden.
- Removed/replaced toolpaths release geometry. Unmount disposes GPU resources and
  releases the context. Context loss hides GPU output and redraws current paths
  through Canvas; restoration retries GPU rendering. Initialization/render errors
  retain Canvas, show fallback/retry controls, and expose a diagnostic reason on
  the sketch canvas. Switching back cancels pending imports and disposes both
  overlay canvases. Hidden sketches do not submit draw work; replaced results
  release retained buffers even while hidden.

## Deliberate gaps — not a production acceptance claim

- MSAA thin-edge antialiasing is not pixel-identical to Canvas. GPU retains full
  segments while interactive Canvas uses its approved display simplification.
- Arrows and debug markers share the existing Canvas rules. One cached raster
  is uploaded and composited in the selected operation's painter slot, before
  subsequent paths. Arrow deferral/placement caching remains unchanged; debug
  markers remain visible during navigation. Final-detail restoration still has
  CPU raster/upload work; these are not GPU-instanced arrows.
- Real iPadOS Safari, native touch/pinch, high-DPI device changes, sustained
  context pressure, and repeated project/tab lifecycle stress remain unproven.
  A desktop or emulated test does not satisfy the tablet gate.
- Initial preparation is synchronous and duplicates cut geometry for feed-colour
  buckets. Capacity optimization remains separate work.
- This is a no-go for enabling GPU by default until the issue's maintainer
  review and missing fidelity/device checks are satisfied.

## Checks

```sh
npx tsx src/components/canvas/previewPrimitives.test.ts
PURECUT_E2E_ISOLATED=1 PURECUT_E2E_PORT=1684 npx playwright test e2e/toolpathVisibility.smoke.spec.ts --workers=1
npm run build
npx playwright test --config tools/gpu-toolpath-poc/playwright.production.config.ts
```

The existing workflow-UI E2E lane covers synthetic pixel checks, annotation
ordering, transforms, retained buffers, visibility/collision semantics,
application-local persistence, unchanged project/history/booklet pixels,
startup failure/retry, cancellation and context loss/restoration.
The production config owns an isolated preview server for the built `dist/`;
its normal-Open test checks that DEV seams/stats are absent and the selector
persists without the URL override. Headless runs provide correctness evidence,
not hardware performance or real iPad/high-DPI acceptance.
