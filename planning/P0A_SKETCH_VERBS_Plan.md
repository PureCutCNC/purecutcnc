---
status: Approved
created: 2026-06-24
---

# P0a Plan — Sketch-Editing Verbs (Trim / Extend)

## Goal

Add the everyday sketch-editing verbs that let users fix imported or hand-drawn
geometry in place instead of deleting and re-importing. The roadmap
(`work/cad-enhancement-roadmap.md`, P0a) calls this out as the highest-value
foundational gap: "removes the most common edit-and-reimport loop."

Scope of this plan: **trim** and **extend** only. The roadmap's other P0a verbs
are already covered — **join** exists (`mergeSelectedFeatures`), and
**split/break** is handled by the existing `add_point` (split), `disconnect`
(break at a vertex), and `delete_segment` (break with gap) tools. Each new verb
is a **two-pick sketch-edit tool** (pick subject segment → pick reference
segment, cross-feature) that mutates a feature's `SketchProfile` and commits
through the existing history/transaction path — no new feature kinds, no schema
changes.

---

## 0. Existing infrastructure to reuse (keeps starting cost low)

| Need | Already exists | Where |
|------|----------------|-------|
| Tool registration | `SketchEditTool` union + `sketchCommands` entry + `toggleSketchEditTool` | `store/types.ts:64`, `commands/sketchCommands.ts:333` |
| Pick a segment on click | `control.kind === 'segment'`, `segmentIndex`, parametric `t` | `useClickPlacement.ts:88,616` |
| Split a line at a point | `insertPointIntoProfile` / `insertFeaturePoint({kind:'segment', segmentIndex, point, t})` | `profileEdit.ts:461`, `useClickPlacement.ts:177` |
| Split an arc / bezier at a point | `splitArcSegment`, `splitBezierSegment` | `profileEdit.ts:117,93` |
| Break profile into two | `disconnectProfileAtAnchor`, `deleteSegmentFromProfile`, `profileFromOpenSegments` | `profileEdit.ts:648,605,593` |
| Extend an open endpoint | `extendOpenProfileAtStart/End` | `profileEdit.ts:134,160` |
| Line–line intersection (boolean) | `segmentsIntersect` | `project.ts:1185` |
| Richer intersection logic to reference | planar-graph intersections | `store/helpers/polygonSplit.ts` |
| Segment hit-testing | `pointNearProfile` | `hitTest.ts:64` |

**The one genuinely new geometry primitive** is a *point-returning* segment
intersection helper (line–line, line–arc, arc–arc), used by both trim and
extend. `segmentsIntersect` only returns a boolean; `polygonSplit.ts` has the
math to adapt.

---

## 1. Shared geometry — `segmentIntersections` (build first)

New `src/store/helpers/segmentIntersection.ts`:

```typescript
// All intersection points between two profile segments, with parametric
// positions on each, so trim/extend can pick the relevant one.
segmentIntersections(
  a: ResolvedSegment,   // {kind:'line'|'arc', p0, p1, center?, ...}
  b: ResolvedSegment,
): Array<{ point: Point; tA: number; tB: number }>
```

- Line–line: solve the 2×2 system; reject if parallel or outside [0,1] (segment)
  / allow beyond [0,1] for the *ray* case used by extend.
- Line–arc: substitute the line into the circle equation → 0–2 roots, filter by
  arc sweep.
- Arc–arc: circle–circle intersection, filter by both sweeps.
- Tolerance-aware (reuse the `1e-9` epsilon convention).

Unit tests are mandatory and cheap (deterministic geometry): each pair type,
parallel/no-hit, tangent, endpoint-touch, and the ray-extension variant.

---

## 2. Interaction model — two-pick (subject → reference), cross-feature

Both verbs use an explicit **two-click** flow rather than auto-finding the
nearest intersection. This removes the worst ambiguity (which intersection /
which side) by making the user name the reference, and makes **cross-feature**
fall out for free — the second pick can land on any visible feature's segment.

```
Trim:    click the segment span to REMOVE   →  click the CUTTING segment
Extend:  click the segment near the END to grow  →  click the TARGET segment
```

**Precedent (not new infrastructure):** the constraint tool already does a
two-pick anchor→reference flow (`pendingConstraint.anchor` → `.reference`,
`selectionSlice.ts`), and join/cut use phased `pendingShapeAction`. The trim/
extend controller mirrors that: a `pendingSketchEdit` with phase
`'pick-subject' | 'pick-reference'` holding the first pick until the second
click commits. Escape / re-toggling the tool cancels; a first pick is remembered
until cancelled.

**Subject vs target eligibility (open/closed rule):**
- **Pick 1 (subject — the feature being modified) = OPEN features only (MVP).**
  A closed profile has no free end, so *extend* is meaningless on it. *Trimming*
  a span out of a closed profile would **open** it into an open profile (e.g. a
  circle → an arc) — a genuinely distinct capability that **cut does NOT
  provide**: cut splits a closed feature into two *closed* features sealed along
  the cutter, it never opens one. Trim-to-open is useful but deferred for MVP to
  keep scope tight (see §8); revisit as a follow-on.
- **Pick 2 (target / cutter — reference geometry) = ANY visible feature, open or
  closed.** Extending an open line to a closed rectangle's edge, or trimming it
  where it crosses a closed feature, are both valid. Only the subject is mutated.
- Separation of concerns: **cut** divides a closed feature into closed pieces;
  **trim/extend** edit open features against any geometry.

**Cross-feature picking is the one genuinely new UI piece.** The existing
sketch-edit pick (`control.kind === 'segment'`) is scoped to the *selected*
feature. Trim/extend must hit-test segments across features. Build
`segmentHitTest(worldPoint, project, vt, { openOnly })` →
`{ featureId, segmentIndex, point, t } | null` that walks the eligible visible
features' resolved profiles (reuse `pointNearProfile` / `hitTest.ts`) —
`openOnly: true` for pick 1 (subject), `false` for pick 2 (target).

Shared mechanics (mirror `fillet`/`chamfer`):
- Toolbar button toggles the tool (`toggleSketchEditTool`), active styling.
- `useClickPlacement` routes both clicks; first sets the pending subject, second
  resolves the reference and calls the store action.
- Hover after the first pick shows a dashed **preview** of the result against the
  hovered candidate reference (extension line / removed span).
- One history transaction per completed operation → single undo step.
- Tablet: tap = click; no numeric entry.

---

## 3. Extend (subject end → target segment)

1. **Pick 1** — `segmentHitTest` returns the subject segment + click `t`; the
   click position picks **which end** grows (nearer endpoint). Capture the
   segment's outgoing direction at that end (tangent for arcs).
2. **Pick 2** — the target segment (any feature).
3. Intersect the subject's **forward ray** (from the growing end, along its
   direction) with the target via `segmentIntersections` (ray variant). Take the
   nearest forward hit; lengthen the subject to it (line: move endpoint; arc:
   extend sweep to the hit's angle).
4. If the ray misses the target's bounds: extend to the target's **supporting
   line** (apparent intersection) — see Open Q. If it misses entirely (parallel),
   no-op with a hint.

Reuse `extendOpenProfileAtEnd/Start` for the line endpoint move where it fits.

---

## 4. Trim (subject stub → cutting segment)

1. **Pick 1** — `segmentHitTest` returns the subject segment + the click `t`.
   The click `t` marks **which stub to remove** (the piece containing the click).
2. **Pick 2** — the cutting segment (any feature).
3. `segmentIntersections(subject, cutter)` → 0–2 hits on the subject. The hit(s)
   split the subject; **remove the part that contains the click `t`**, keep the
   rest:
   - 1 hit: drop the side from the click toward the nearer end; shorten the
     subject to the hit.
   - 2 hits (arc/line-vs-arc): if the click is between them, the middle span is
     removed (subject divides → break); if outside, drop the clicked outer stub.
4. No intersection with the chosen cutter → no-op with a hint ("Cutting edge
   doesn't cross this segment").

The removed-span hover preview (red dashed) is the key usability piece.

---

## 6. Files affected

- `src/store/helpers/segmentIntersection.ts` *(new)* + `.test.ts` *(new)* —
  point-returning intersection primitive (§1).
- `src/components/canvas/hitTest.ts` — add `segmentHitTest(worldPoint, project,
  vt, { openOnly })` → `{ featureId, segmentIndex, point, t }` across visible
  features (`openOnly: true` for subject pick, `false` for target pick).
- `src/store/helpers/profileEdit.ts` — trim/extend profile transforms (shorten a
  segment to a point / lengthen to a point), if cleaner here than in the slice.
- `src/store/types.ts` — add `'trim' | 'extend'` to `SketchEditTool`; a
  `pendingSketchEdit` two-phase state (subject pick → reference pick); declare the
  new `featureGeometrySlice` actions.
- `src/store/slices/featureGeometrySlice.ts` — `trimFeatureSegment(subject,
  cutter)`, `extendFeatureEndpoint(subject, target)` — both take cross-feature
  `{featureId, segmentIndex}` refs; mutate only the subject's profile.
- `src/store/slices/selectionSlice.ts` / pending slice — the two-pick pending
  state + cancel (mirror the `pendingConstraint` anchor→reference flow).
- `src/commands/sketchCommands.ts` — command entries + toolbar wiring for `trim`
  and `extend`.
- `src/components/canvas/useClickPlacement.ts` — route BOTH clicks (subject, then
  reference) for each tool.
- `src/components/canvas/SketchCanvas.tsx` (+ `previewPrimitives.ts`) — hover
  previews: trim removed-span (red dashed), extend extension line.
- `src/assets/icons.camj` + `npm run sync-icons` — `trim`, `extend` icons.

**Interaction-layer parity checklist (lesson from R1):** every new tool must be
wired in the store action AND `useClickPlacement.ts` (both pick phases) AND the
hover/preview draw path. Handoffs must list these explicitly.

---

## 7. Slicing for handoffs

| Slice | Contents | Depends on |
|-------|----------|------------|
| **A0** | `segmentIntersection.ts` + tests (pure geometry, no UI) | — |
| **A1** | `segmentHitTest` cross-feature pick + the two-phase `pendingSketchEdit` controller + toolbar/command scaffolding (no transform yet) | — |
| **B** | Extend tool — store transform + click routing + preview | A0, A1 |
| **C** | Trim tool — store transform + click routing + removed-span preview | A0, A1 |

A0 and A1 can run in parallel; B and C depend on both. Each slice is
independently buildable and testable.

---

## 8. Out of scope

- **Join** — already shipped (`mergeSelectedFeatures`).
- **Split / Break** — already covered by existing tools: `add_point` *is* split
  (insert a vertex, stays connected); `disconnect` breaks at a vertex;
  `delete_segment` breaks with a gap. (A one-click *mid-segment* break is the only
  residual micro-gap; deferred — `add_point` + `disconnect` achieves it in two
  steps.)
- **Trim-to-open (closed subject)** — trimming a span out of a closed feature to
  open it (circle → arc). A distinct capability NOT covered by cut (which keeps
  pieces closed). Best added later as an **option on the cut operation**, not as
  part of trim/extend. Out of scope here; MVP subject is open-only.
- **Fillet/chamfer-on-trim** (auto-corner after trim) — separate enhancement.
- **Numeric/exact trim lengths** — pick-driven only; precise lengths belong to
  the P1 "direct numeric geometry edits" work.
- **Trimming/extending a *closed* profile into an invalid state** — guard: if an
  operation would leave a degenerate/zero-length profile, no-op with a hint.

---

## 9. Open questions

*Resolved:*
- **Split/Break** — dropped; covered by existing `add_point` / `disconnect` /
  `delete_segment` (user confirmed 2026-06-24).
- **Cross-feature scope** — IN for MVP. The operation mutates only the subject
  (user confirmed 2026-06-24).
- **Open/closed rule** — subject (pick 1) = open features only; target (pick 2) =
  any feature, open or closed. Closed-as-subject deferred (trim-to-open is its
  own follow-on; cut does not cover it) (user confirmed 2026-06-24).
- **Apparent intersection / which-stub** — extend to the target's supporting line
  when the ray misses its extent; trim removes the clicked part
  (user confirmed 2026-06-24).

*Manager task (not a blocker):*
- **Icons** — draw `trim` / `extend` icons via the camj flow; reuse the
  sketch-edit visual language.
