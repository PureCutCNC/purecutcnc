---
status: In progress   # Draft → Approved → In progress → Done | Abandoned
created: 2026-06-11
---

# Lint Batch A — Typed Boundaries Plan

> Implements **Batch A** of the accepted design in
> [`LINT_HOOK_TYPING_DEBT_Plan.md`](LINT_HOOK_TYPING_DEBT_Plan.md) (the source of
> truth). Eliminates the production `@typescript-eslint/no-explicit-any` errors
> at three geometry/import/text boundaries with small typed wrappers. No
> behavior change. Batches B–E are out of scope.

## Goal

Remove every production `any` at three boundaries — the segment-endpoint access,
the Clipper open-path API, and the font-JSON parse — replacing each with a small,
documented typed seam. Strict TS, no new `any`, no algorithm/output change. The
~20 targeted `no-explicit-any` errors across these files should be gone after the
change.

## Approach

### 1. `segmentEndPoint` helper (segment boundary)

All four `Segment` variants in `src/types/project.ts` already carry `to: Point`
(`LineSegment`, `ArcSegment`, `BezierSegment`, `CircleSegment`), so the existing
`(seg as any).to` casts are unnecessary *and* lose the intended semantic. Add:

```ts
export function segmentEndPoint(seg: Segment, profileStart: Point): Point {
  // A closed circle has no distinct end vertex — its traversal endpoint is the
  // profile start. All other segment kinds end at `to`.
  return seg.type === 'circle' ? profileStart : seg.to
}
```

**Home:** `src/types/project.ts` — this is where `Segment` is defined and where
the sibling helpers `profileVertices` / `sampleProfilePoints` already live, and
all three cast sites already import from it. This is a deliberate, lower-risk
choice over the two candidate locations floated in the parent plan
(`profilePrimitives.ts` / `geometry.ts`): co-locating with the type avoids a new
file and a cross-layer (canvas ← engine / import) import. `project.ts` already
keeps its Apache header and is indexed, so no new license header / INDEX entry.

Replace the three casts (all behavior-identical; circle is single-segment by
construction and is short-circuited before these lines, so the circle→`start`
branch is never hit in the two import sites and is exactly the existing branch in
`profilePrimitives`):

- `profilePrimitives.ts:25` — `if (seg.type === 'circle') return profile.start; return (seg as any).to` → `return segmentEndPoint(seg, profile.start)`.
- `normalize.ts:86` — `segments.map((s) => (s as any).to)` → `segments.map((s) => segmentEndPoint(s, profile.start))`.
- `dxf.ts:501` — same `segments.map(...)` replacement.

### 2. Typed Clipper open-path wrapper

The casts in `clipping.ts` / `derivedFeatures.ts` exist because the **local**
ambient declaration `src/types/clipper-lib.d.ts` (we own it) types only the
closed-path API: `ClipperLike` declares `AddPaths` but not the open-path
`AddPath`, and `ClipperStatic` omits the static `OpenPathsFromPolyTree`. Add a
new module `src/engine/clipperOpenPaths.ts` exposing exactly two functions:

```ts
addOpenSubject(clipper, path: ClipperPath): void   // clipper.AddPath(path, ptSubject, false)
openPathsFromPolyTree(tree): ClipperPath[]          // ClipperLib.Clipper.OpenPathsFromPolyTree(tree)
```

- Param/return types reuse the repo's existing `ClipperPath` (`= ClipperPoint[]`,
  `{ X, Y }[]`) from `engine/toolpaths/types.ts` — structurally identical to the
  d.ts `IntPoint`, and the idiom already used by `toClipperPath`/`fromClipperPath`.
- `clipper` param type: `InstanceType<typeof ClipperLib.Clipper>`; `tree` param:
  `InstanceType<typeof ClipperLib.PolyTree>` — both derived from the existing
  declaration, no new exported names needed.
- **Casts:** one documented cast per function (each reaches one undeclared
  runtime method), both confined to this module, each carrying a
  `// clipper-lib.d.ts omits the open-path overload …` comment. This satisfies
  the "at most one cast per wrapper" rule.

Replace the 6 call-site casts:
- `clipping.ts:177` → `addOpenSubject(clipper, flattenOpenFeatureToClipperPath(target))`
- `clipping.ts:178` → keep the typed closed-path `clipper.AddPaths([...], ptClip, true)` **or** leave as the existing `AddPath(..., true)` re-expressed without `any` (see note); `clipping.ts:186` → `openPathsFromPolyTree(polyTree)`.
- `derivedFeatures.ts:167` (open subject) → `addOpenSubject`; `:169` (closed clip in loop); `:179` → `openPathsFromPolyTree`.

> Note on the closed-path `(clipper as any).AddPath(..., true)` lines
> (`clipping.ts:178`, `derivedFeatures.ts:169`): these add a *single closed* clip
> path. The typed declaration only has `AddPaths` (plural). Cleanest fix is to
> call `clipper.AddPaths([path], ptClip, true)` (already typed, zero cast). I'll
> use that so all 6 sites become cast-free; the wrapper covers only the genuinely
> undeclared open-path operations.

### 3. Typed font parser wrapper

Add `src/text/fontData.ts`:

```ts
export function parseFontJson(data: unknown): Font {
  // Imported `*.typeface.json` modules are typed by their inferred JSON shape,
  // which doesn't structurally satisfy three's `FontData`; the data is a valid
  // typeface at runtime, so cast once here.
  return fontLoader.parse(data as FontData)
}
```

`Font`, `FontLoader`, and `FontData` all come from
`three/examples/jsm/loaders/FontLoader.js`. The single documented cast
`data as FontData` lives here. In `text/index.ts`, replace the 11
`fontLoader.parse(x as any)` calls with `parseFontJson(x)`, import `parseFontJson`
from `./fontData`, and drop the now-unused local `FontLoader` import/instance if
nothing else in the file uses it (verify at implementation).

## Files affected

- `src/types/project.ts` — **(edit)** add `segmentEndPoint(seg, profileStart)`.
- `src/components/canvas/profilePrimitives.ts` — **(edit)** use helper at `:25`; import it.
- `src/import/normalize.ts` — **(edit)** use helper at `:86`.
- `src/import/dxf.ts` — **(edit)** use helper at `:501`.
- *(new)* `src/engine/clipperOpenPaths.ts` — typed open-path Clipper seam (`addOpenSubject`, `openPathsFromPolyTree`); Apache header.
- `src/store/helpers/clipping.ts` — **(edit)** replace 3 casts (`:177,178,186`).
- `src/store/helpers/derivedFeatures.ts` — **(edit)** replace 3 casts (`:167,169,179`).
- *(new)* `src/text/fontData.ts` — `parseFontJson(data): Font`; Apache header.
- `src/text/index.ts` — **(edit)** replace 11 casts (`:137-147`) with `parseFontJson`.
- `src/engine/INDEX.md` — **(edit)** add `clipperOpenPaths.ts` entry.
- `src/INDEX.md` — **(edit)** note `src/text/fontData.ts` under the `text/` line (no `src/text/INDEX.md` exists).
- *(new test)* `src/types/project.test.ts` — `segmentEndPoint` line/arc/circle.
- *(new test)* `src/engine/clipperOpenPaths.test.ts` — open path clipped by closed polygon.
- *(new test)* `src/text/fontData.test.ts` — parse smoke test.

## Tests

Co-located `*.test.ts`, discovered by `scripts/run-tests.ts` (runs inside `npm test` / `npm run build`):

- **`segmentEndPoint`**: line → `to`; arc → `to`; circle → `profileStart` (not `to`).
- **Clipper open-path wrapper**: build an open polyline crossing a closed square,
  clip (intersection) via `addOpenSubject` + `openPathsFromPolyTree`, assert the
  survivor count / that the returned path is the inside portion.
- **Font parser**: `parseFontJson` on a minimal valid `FontData`-shaped object
  (empty `glyphs`) returns a `Font` with `isFont === true`. Using a hand-built
  object rather than importing a real typeface keeps the test headless-safe under
  tsx/node (no WebGL); flag if importing a real `*.typeface.json` is preferred.

## Open questions / risks

- **Clipper seam vs. extending the d.ts.** Because the Clipper typings are
  *local* (`src/types/clipper-lib.d.ts`), an alternative would be to declare
  `AddPath` + `OpenPathsFromPolyTree` there and drop all 6 casts with no new
  module. I'm following the accepted plan (named wrapper `clipperOpenPaths.ts`)
  because it gives a tested, named open-path seam; happy to switch to the d.ts
  approach if you'd rather have zero new module + zero casts.
- **`segmentEndPoint` home** = `src/types/project.ts` (justified above) rather
  than the two candidates the parent plan floated. Flag if you want it in
  `geometry.ts`/`profilePrimitives.ts` instead.
- Risk overall: very low — pure typing, no algorithm/output change. Build's
  structural tests cover toolpath/import; a browser sanity pass (one DXF import,
  one text feature) is the parent plan's suggested manual check.

## Out of scope

- Batches B/C (hook/ref hygiene), D (set-state-in-effect), E (test-fixture `any`,
  `_`-prefixed unused vars).
- The three load-bearing `eslint-disable react-hooks/exhaustive-deps` directives — left untouched.
- Any lint-rule severity changes.
