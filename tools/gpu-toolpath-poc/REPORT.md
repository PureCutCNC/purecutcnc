# Issue #683 — bounded POC report

## Decision

**Promising desktop result; no-go for Phase 2/default enablement yet.**
Retain this opt-in demo for maintainer review. Missing tablet/context-pressure,
native touch, high-DPI hardware, complete paint-order parity and controlled
close-zoom comparisons prevent production acceptance. This report does not close
the parent issue or authorize production replacement.

Implementation: `a55a5056d60d3ac6e6e718d2968c7832802102f4`.
Measurements ran at `b4b96a0782217b2994c0263f3992e9a2bdabe31a`;
the rebase onto merged Phase 0 produced an identical source tree
(`git diff b4b96a0 a55a505` is empty). Canvas and GPU final comparisons use this
same implementation, switching only the DEV URL option.

## What was proved

The transparent GPU layer works inside the existing sketch area with its input
and view-transform owner unchanged. Full XY buffers remain resident while
panning/zooming. Shared layer membership, feed buckets and style definitions
keep Canvas/booklet output and the POC aligned.

An opaque per-layer MSAA coverage mask, composited once with both theme alpha
and operation emphasis, prevents overlap darkening. A synthetic test compares
1,000 coincident segments, a crossing and a single segment; their GPU alpha is
equal. Tests also compare Canvas/GPU layer/feed/collision pixels, transformed
locations, resize, hidden layers, retained preparation counts and empty-result
clearing. Pixel tolerance is limited to the sampled swatch; this is not whole-
image pixel equivalence.

Startup failure and forced context loss fall back to current Canvas toolpaths;
restoration resumes GPU output without changing Directions. Unmount releases
resources. These are desktop/headless correctness checks, not iPad evidence.

## Hardware and method

Maintainer-supplied Chrome Graphics Feature Status reports hardware-accelerated
Canvas, compositing, rasterization and WebGL, with:

```
ANGLE (Intel, ANGLE Metal Renderer: Intel(R) UHD Graphics 630,
Version 15.7.9 (Build 24G830))
```

Connected Chrome user agent: 151.0.0.0. Viewport 1440 × 900, DPR 1, dark theme.
Both renderers used 864 × 741 backing pixels for the rectangle and 864 × 735
for the raster (the long project title changes header height). Both operations
were selected; fit was explicitly set with **Zoom to model**.

Each row is one short automation-paced trusted Shift-drag, not a sustained human
input trial. Path in viewport CSS pixels:

```
(600,470) (620,470) (640,470) (660,470) (680,470) (700,470)
(680,490) (660,490) (640,490) (620,490) (600,470)
```

The build/test jobs started by this task were finished before final captures.
This was a shared desktop, not a controlled benchmark machine. Callback/frame
statistics include the app's other mounted panes and interaction work.
Raw records, sample counts, durations, settling events and environment are in
[evidence.json](evidence.json). See [README.md](README.md) for exact commands.
The raster pairs were captured around 01:37–01:41 UTC and the final rectangle
pairs around 12:37 UTC on August 31. Compare backends within a fixture, not
absolute costs across those separate sessions. The supplied adapter diagnostic
was not independently queried during capture.

### Comparable fit-view observations

All values below are measured milliseconds, rounded to one decimal.
“Paint gap” is the interval between sketch Canvas repaint starts during the
gesture; in GPU mode that same frame submits the GPU layer. It is not a measure
of compositor presentation or GPU completion.

| Fixture | Directions | Canvas median / p95 paint gap | GPU median / p95 paint gap | Canvas / GPU maximum rAF gap |
| --- | --- | --- | --- | --- |
| 249,663 moves | on | 519.6 / 1006.4 | 32.2 / 136.7 | 1017.4 / 134.2 |
| 249,663 moves | off | 510.1 / 559.6 | 35.0 / 43.8 | 1017.2 / 50.5 |
| 882,899 moves | on | 854.0 / 1560.5 | 50.9 / 250.5 | 1566.7 / 266.4 |
| 882,899 moves | off | 145.8 / 1693.0 | 49.9 / 99.8 | 1683.6 / 116.7 |

The low raster Canvas median with Directions off does not mean smooth
navigation: the capture contains clusters of quick redraws and long stalls,
visible in its p95 and raw timestamps. Do not infer FPS from these numbers.

GPU preparation remained at **one per loaded toolpath** through these
navigation/visibility changes. Observed CPU preparation / first nonempty
submission were 110.5 / 154.7 ms for the rectangle and 996.7 / 1106.6 ms for the
raster. The latter includes preparation and driver submission, not independently
measured GPU upload completion. Initial preparation remains a visible cost.

### Excluded and incomplete measurements

Native wheel and following close-pan traces were recorded, but visual inspection
showed different final zoom levels under differently paced wheel delivery.
They are retained in the raw file and **excluded from speed comparisons**.
Controlled identical-close-view timing remains outstanding.

Settling paint-start offsets are recorded, but they do not measure completed
final-detail rendering. Arrows/debug markers remain on Canvas, so idle restoration
still has CPU work. Small ordinary-project correctness is covered by the existing
Route A E2E fixture; its hardware timing is not measured.

## Fidelity findings and visual evidence

- The synthetic overlap check no longer accumulates alpha. It initially exposed
  lost theme alpha in GPU colour conversion; that bug was fixed before final runs.
- Shared colours, emphasis widths, feed colours, collision visibility, dash
  presence and transformed sample locations pass browser pixel checks.
- Actual raster views at close zoom show aligned path/feature structures, but
  their different zoom endpoints rule out pixel-to-pixel comparison.
- Thin-edge antialiasing is not identical. GPU draws full segments; interactive
  Canvas retains its approved simplification.
- Existing Canvas annotations sit above all GPU paths. Cross-operation
  arrow/debug order therefore differs from the original interleaved painter.
- The Playwright HTML report includes generated GPU layer-swatch, Canvas
  reference, live-sketch and actual booklet PNG attachments. Regenerate with the
  README test command; the local report is in `playwright-report/index.html`.
  Hardware-browser screenshots were also inspected during the task.

## Coverage and remaining gate

Post-rebase verification: `npm run build` passed, including all 224 test files
(zero skipped); the isolated toolpath-visibility E2E spec passed all eight tests.
`git diff --check` is clean. No production-default GPU renderer chunk is emitted.

Verified: desktop Chrome hardware lane for both large fixtures; synthetic
Canvas/GPU pixel and transform/resize checks; small ordinary-project browser
workflow; context-loss/restoration and initialization fallback; Canvas booklet
restyle; unchanged buffer preparation during navigation.

Not verified: real iPadOS Safari with all three live contexts, native touch/
pinch, actual high-DPI hardware switching, repeated project/tab lifecycle stress,
complete multi-operation paint ordering, equal-endpoint close-view performance,
and a sustained interaction trial.

Phase 2 remains gated on maintainer review. Recommend preserving the POC and
finishing those checks before considering production work, without changing the
approved Canvas snapshot/fallback decision.
