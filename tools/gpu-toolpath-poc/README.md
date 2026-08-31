# GPU toolpath POC — issue #683

DEV-only experiment, not a production renderer switch. Canvas remains the normal
live renderer, the fallback and the booklet renderer. No machine-output or
project-format code changes.

## Run

From this worktree:

```sh
node tools/gpu-toolpath-poc/server.mjs
```

Open the printed Canvas URL in a hardware-accelerated browser; add
`?toolpathRenderer=gpu` for the prototype. The regular development server also
accepts that opt-in URL, without the diagnostic panel. Production builds ignore
the option and do not load the GPU POC.

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
  paths; a transparent Canvas above it paints existing annotations/interactions.
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
  retain Canvas and expose a diagnostic reason on the sketch canvas.

## Deliberate gaps — not a production acceptance claim

- MSAA thin-edge antialiasing is not pixel-identical to Canvas. GPU retains full
  segments while interactive Canvas uses its approved display simplification.
- Arrows and debug markers remain Canvas-rendered. They are deferred during
  navigation exactly as before; final-detail restoration still has CPU work.
  No GPU arrow batching has been demonstrated by this prototype.
- In multiple-operation scenes, all GPU paths precede Canvas annotations.
  Cross-operation arrow/debug paint ordering needs acceptance or correction.
- Real iPadOS Safari, native touch/pinch, high-DPI device changes, sustained
  context pressure, and repeated project/tab lifecycle stress remain unproven.
  A desktop or emulated test does not satisfy the tablet gate.
- Initial preparation is synchronous and duplicates cut geometry for feed-colour
  buckets. Capacity/resource optimization and broader visual matrix are pending.
- This is a no-go for enabling production by default until the issue's maintainer
  review and missing fidelity/device checks are satisfied.

## Checks

```sh
npx tsx src/components/canvas/previewPrimitives.test.ts
PURECUT_E2E_ISOLATED=1 PURECUT_E2E_PORT=1684 npx playwright test e2e/toolpathVisibility.smoke.spec.ts --workers=1
npm run build
```

The existing E2E lane covers the new synthetic GPU pixel checks, transform,
retained buffers, visibility/collision semantics, startup failure and context
loss/restoration. Headless runs provide correctness evidence only, not the
hardware-performance comparison.

