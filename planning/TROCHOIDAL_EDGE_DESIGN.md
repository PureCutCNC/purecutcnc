---
status: current
authoritative-for: trochoidal Edge Route roughing and trochoidal Engrave — guide-domain fragmentation, clearance budget, and the pipeline stages they must bypass
last-verified: 2026-08-10
---

# Trochoidal Routing

## Purpose

Edge Route Inside and Edge Route Outside gain a second roughing strategy:
instead of one full-width offset contour, the cutter advances along the same
guide in overlapping orbits. Peak radial engagement drops, which is what lets a
hobby-class router use more of the flute length in aluminium without chatter or
spindle stall.

This document owns the geometry contract and — more importantly — the small set
of invariants that are load-bearing for safety. Everything here has a comment at
its site in the code saying so. If you are about to simplify one of them, read
this first.

## Scope

- Rough pass only. A finish pass is always a contour, on both edge kinds.
- Closed guides only.
- Region masks participate in guide-domain fragmentation via
  `resolveRegionDomainCurve` before any orbit exists.  Include regions are
  eroded by the orbit radius `(cutWidth − D)/2` so the tool centre lands on
  the region boundary; exclude regions are dilated by `cutWidth / 2` so the
  tool body clears the region.  Obstacles, tabs, and the retained wall use
  the separate `trochoidalGuideOffset` clearance.  Both follow ordered mask
  composition from `buildRegionMask`.

Both machining orders are supported — see below. The plan originally scoped
`feature_first` out; it was enabled once the two things it actually needed were
in place, which is a smaller list than "not applicable" implied.

## Geometry

With `D` the cutter diameter, `W` the trochoidal cut width, and `S` the radial
stock to leave:

```text
R           = (W - D) / 2          orbit radius of the tool centre
A           = 0.01 x D             safety allowance
guideOffset = S + W / 2 + A        guide offset from the design boundary
```

The tool centre is `guidePosition(d) + R * (cos(phase) * tangent + direction *
sin(phase) * normal)`, sampled along the guide's arc length.

`loopCount = ceil(guideLength / (advance * D))` is an integer and
`actualAdvance = guideLength / loopCount`, so position and phase meet exactly at
a closed guide's seam and leave no uncut ridge.

### Why the allowance is 1% of D and not less

The orbit is emitted as a polyline. Chords are capped at `0.1 x D` with a
36-step floor, so the worst-case sagitta — at the crossover where the floor
stops binding, `R ~= 0.573 D` — is about `0.0022 D`. The `0.01 D` allowance
covers that discretisation error with room to spare, on both cut sides:

```text
cutter centre reach toward the wall = guideOffset - R = toolRadius + S + 0.01 D
```

which is exactly `0.01 D` clear of the retained wall, inside and outside alike.
That single expression is why `guideOffset` must be computed once and reused.
Two approximations of the same clearance is how a visible seam becomes a gouge.

### Cut width bounds

`W >= 1.15 x D` is a hard floor; between `1.15` and `1.25 x D` the operation
warns. Below the floor the orbit degenerates toward a plain contour while still
paying the full per-loop move count, and continuous-curvature feed on a router
is capped near `sqrt(accel * R)` — a narrow channel throttles the feed rather
than saving time.

Above `2 x D` the operation warns (`edgeTrochoidalWidthLeavesCore`): `R` then
exceeds the tool radius, so the helical entry bore no longer overlaps its own
centre and leaves a full-stepdown core the first advancing loops must plough
through side-on. `entry.ts` caps pocket helixes at the tool radius for the same
reason; here the channel width is the user's call, so this warns rather than
clamps.

## Core design: fragment the guide, never the path

Interruptions are planned **in the guide domain, before any orbit exists**. The
forbidden set for a level is the union of tab footprints active below their
`z_top`, the retained wall, and protected Add/Model obstacles overlapping the
level's Z span — each expanded by the clearance the orbit centre needs. The
closed guide is split against that union into ordered open spans, and each span
is generated as an independently entered fragment:

```text
helical entry cavity -> stationary clearing orbit -> advancing trochoid -> stationary exit orbit
```

Transitions between fragments retract to safe Z, rapid across, and descend
through air. **No fragment ever re-enters material with a vertical plunge.**

Clipping a *generated* path instead would cut an orbit mid-loop and drop the
tool into uncleared stock at the resume point. That is the whole reason this
strategy cannot reuse the shared clippers.

### The verification backstop

After generation, every emitted segment is re-checked against the retained wall
and the protected obstacles. If the guide-domain maths ever misses a case the
operation fails closed rather than emitting the path. The backstop is a
safety net, not the mechanism — a trip is a bug, not an expected outcome.

### Tight spots interrupt, they do not fail the job

A span that survives fragmentation but is too short to hold a safe helical entry
cavity is **skipped with a warning naming its location**; the rest of the level
still generates. Only when *no* span survives at a level does the operation fail
closed. The cut simply does not go where the tool does not fit, and the user
decides what to do with the leftover.

## Machining order

Both orders generate. `level_first` descends all targets together; `feature_first`
splits into one sub-operation per target via `perFeatureOperations` and finishes
each before starting the next.

Per-feature generation is safe on its own terms: each sub-operation fragments
and enters exactly as it would alone, and a neighbouring target is protected
because it appears in that sub-operation's `allAdditiveObstacles`. Two things
had to be added for it to be *correct* rather than merely safe:

- **The point budget is per operation, not per target.** It is created once in
  `generateEdgeRouteToolpath` and threaded into every sub-operation. Left to
  `generateEdgeRouteToolpathSingle` to create, N targets would each claim the
  full 500,000 points.
- **Multi-target generation stays atomic.** `mergeToolpathResults` concatenates
  parts and flattens warnings with no failure check, so a target that failed
  closed would be silently skipped while its neighbours were cut. Feature-first
  trochoidal therefore checks every part for a fatal warning first and refuses
  the whole operation if any target failed.

Known behavioural difference, not a defect: `level_first` unions same-depth
outside targets into one silhouette and routes around the pair, while
`feature_first` routes each target alone and treats the other as an obstacle.
Closely spaced parts can therefore skip spans (or fail) under `feature_first`
where `level_first` succeeds, because the gap between them is narrower than the
channel. That is the honest consequence of the ordering the user picked.

## Tabs

- Footprints expand by cutter radius plus the orbit's requirements, and protect
  for every level below `tab.z_top`.
- The first level crossing a tab top cuts that tab's local interval inline at
  `z_top` — never a full contour at that height.
- Deeper levels retract, rapid across the already-cleared area, and helically
  re-enter after the tab.
- Overlapping tabs use the **highest** covering top. Where a short tab overlaps
  a taller one, taking the short tab's own top would machine the taller tab
  away across the overlap. If raising the span to the tallest covering top still
  leaves part of it inside a tab that is a keep-out at that height (staggered
  overlaps), the span is skipped with its location rather than cut unsafely.
- Tabbed trochoidal operations require Helix entry; Plunge fails closed.
- Reversed or malformed tab Z ranges fail closed.

Tab footprint geometry lives in `tabs.ts` (`expandedTabFootprints`), not beside
it. Callers pass their own clearance because they answer different questions,
but the footprint shape and the offset tolerance come from one place.

### Smooth tabs are conservatively rectangular here (issue #414)

A tab may be `rect` or `smooth`. A smooth tab keeps the same rectangular
footprint but ramps Z continuously across each crossing instead of stepping —
implemented in `tabSmoothing.ts`, driven from the shared tab pass.

**Trochoidal does not ramp.** The smooth profile is measured along a connected
cut chain crossing the footprint, and trochoidal roughing has no such chain: it
fragments the guide around each tab *before* any orbit exists, cuts the tab-top
interval inline, and helically re-enters afterwards. Applying the ramp here would
mean inventing the very vertical re-entry into stock that the guide-domain design
exists to prevent.

So a smooth tab on a trochoidal Edge Route gets the rectangular treatment
described above, unchanged. That direction is the safe one — the rectangular hold
leaves *more* material than the ramp, not less.

What is **not** allowed is doing that silently. Each smooth tab on a trochoidal
operation emits `edgeTrochoidalSmoothTabFallback` naming the tab, so a user who
chose Smooth is never left believing the machine ramps when it steps. Removing
that warning while keeping the fallback is a regression, not a simplification.

## Engrave (follow_line) slot

Engrave gains a trochoidal strategy under the same geometry model, but the guide
**is** the unmodified feature centreline — there is no `guideOffset` derivation
and no `0.01 × D` allowance, because no wall is retained and there is nothing to
gouge.

Regions bound the guide with **zero** clearance in both polarities and in both
strategies, exactly as they do for the edge route: the span runs until the tool
centre reaches the region boundary, and the cutter then sweeps its half-width
past that line — `tool.radius` under direct, `cutWidth / 2` under trochoidal —
the same way a pocket's tool sweeps past the line it was clipped to.

Engrave originally dilated the region by the swept half-width, on the theory that
the cut surface should fully cover the region. That put the cut a whole cut width
past an include boundary under trochoidal, and a whole tool diameter under direct;
both were visibly wrong against the region outline on screen. The dilation was
removed in the #455 follow-up, which changed direct Engrave's region-masked output
too.

Open guides are supported here and only here — the stationary entry orbit **and**
stationary exit orbit in `buildTrochoidalContour`'s `closed: false` branch exist
for this operation. An open engrave guide gets no Clipper CCW winding
normalisation, so the cut-direction inversion logic is not the same as the edge
case and is pinned by its own test in `carving.test.ts`.

Trochoidal cannot keep the groove at tool width: `R = (W − D) / 2` requires
`W > D`, so the feature necessarily widens the groove and is really slotting.
That is why the option is labelled `Trochoidal (slot)` and carries a
channel-width readout in the CAM panel.

No tabs, no retained wall, no rest machining. The cut-width bounds, budget
rules, and the geometry contract in § Geometry apply unchanged.

## Load-bearing constraints

Each has a comment at its site pointing here.

1. **Interruptions are planned in the guide domain before any orbit exists.** The
   closed guide is split against the forbidden set (tabs, obstacles — each expanded
   by the single `trochoidalGuideOffset` clearance), region excludes (dilated by
   `cutWidth / 2` in `resolveRegionDomainCurve`), and region includes (eroded by
   `−orbitRadius` in `resolveRegionDomainCurve`). A generated orbit must never be
   clipped, and every fragment is independently helix-entered. Region masks no
   longer refuse; they participate in guide-domain fragmentation.
2. **Trochoidal must bypass the shared tab pass.** `useToolpathGeneration` calls
   `applyEdgeRouteTabs`, which returns trochoidal results untouched. The shared
   pass expands tab footprints by `toolRadius + stockToLeaveRadial` while the
   generator uses orbit-derived clearances, so once stock-to-leave is set the
   shared pass finds "unprotected" cut moves the generator placed deliberately
   and lifts them to the tab top with synthesised lead-ins.
3. **`applyClampWarnings` still runs**, unchanged, for all strategies. A wider
   channel swinging over a clamp must still warn and still auto-lift rapids.
4. **Cut direction is derived once.** A trochoid's engagement orientation comes
   from its guide winding and its orbit sense *together*. `edge.ts` resolves the
   direction once (inverted for outside, per Clipper's CCW normalisation) and
   feeds the same value to `applyContourDirection` and to the orbit. Deriving
   the orbit from `operation.cutDirection` separately double-applies the
   Y-down/Y-up inversion and reverses climb/conventional on every outside route
   — which shipped once already.

## Data model

```ts
edgeStrategy?: 'contour' | 'trochoidal'
trochoidalCutWidth?: number   // length, unit-converted
trochoidalAdvance?: number    // ratio of tool diameter, unitless
```

`stepover` is deliberately **not** overloaded for advance-per-loop: it is a
different physical quantity with a different safe range, and the overload leaks
into tool-change handling.

Both trochoidal fields are `undefined` until the user edits them. Undefined
resolves against the operation's current tool (`1.5 x D` and `0.1 x D`) at every
read, so assigning a different cutter re-derives the channel; an explicit edit
pins the value and survives tool changes. Nothing seeds them at operation
creation, because a seeded value is indistinguishable from an edited one.

A missing `edgeStrategy` normalises to `'contour'`, so existing projects are
byte-identical.

## Budgets

One shared operation budget of 500,000 generated points covers trochoidal loops,
stationary entry and exit orbits, helical entries, tab-top fragments, and
fragment transitions. Entry and operation budgets fail atomically with
structured warnings.

Warnings that refer to a place — skipped spans, unsafe tab fragments, channels
that do not fit — carry the offending XY in their params so the UI can point at
it.

## Related

- `src/engine/toolpaths/trochoidalEdge.ts` — the pure sampler
- `src/engine/toolpaths/trochoidalPath.ts` — shared entry synthesis and point budget; both integrations consume it rather than re-deriving the clearance
- `src/engine/toolpaths/guideFragments.ts` — cyclic guide splitting
- `src/engine/toolpaths/edge.ts` — integration, clearances, safety backstop
- `src/engine/toolpaths/carving.ts` — engrave integration
- #447 — arc fitting; without it this exports as raw G1
- #452 — region redesign; restores region support here
