---
status: current
authoritative-for: how the depth-band resolvers turn features into the region an operation clears
last-verified: 2026-09-07
---

# Band Resolver Semantics

## Purpose

`resolvePocketRegions` and `resolveInsideEdgeRegions`
([`src/engine/toolpaths/resolver.ts`](../src/engine/toolpaths/resolver.ts)) answer one
question for every depth band:

> Where, in this band, is the material that the model says is not there?

Everything downstream — pocket, V-carve, V-carve medial, inside Edge Route, and both
rest-region drafts — consumes their answer. This document owns the rule they use. It
existed only as code until issue #526, which is how a wrong answer survived unexamined
for so long.

## The void fold

The region a band clears is the **void** the boolean model leaves in that band. It is
computed by folding `expandedFeaturesInOrder` — project feature order, the same order
`buildBooleanModel` ([`src/engine/csg.ts`](../src/engine/csg.ts)) uses — over an
initially empty void:

| feature | effect on the void |
| --- | --- |
| target subtract | union, unclipped |
| qualifying non-target subtract | union, clipped to the band's material silhouette |
| add | difference |
| closed line target | resolved separately, even-odd, then unioned (issue #270 S2) |

**Order is load-bearing.** A subtract before an add means something different from one
after it: the add fills back in what the subtract carved. Any change here that stops
consuming feature order is a bug, not a simplification.

**An add reached while the void is still empty is parent material, not an island.** This
is the `resolvedPaths.length > 0` guard in the fold, and it is what stops a body add that
encloses the whole pocket from differencing the pocket away to nothing. It mirrors
`buildBooleanModel`, which likewise lets only the first `add` seed the solid. Reordering a
body add to sit after the target subtract will empty the region — correctly, because that
is what the model then describes.

## Non-target subtracts (issue #526)

A subtract that is not the operation's target still changes the solid. Before #526 the
fold applied a subtract only when it *was* a target, so the two representations disagreed:
the 3D view showed an island eaten away while the toolpath still machined around it. The
error direction was under-cutting — material left standing that is not there.

Three consequences follow from folding them in, and all three are intended:

1. **Islands shrink.** A subtract crossing an island removes that much of the island from
   the region.
2. **The boundary can open past the target.** The region is a union, so a subtract that
   breaks through the target's wall opens a channel out of it.
3. **Bands can extend past the target's Z range**, in both directions. A subtract whose
   floor is below the target's adds bands below it; one whose top is above adds bands
   above. The operation follows the void as far as it goes.

Accepted cost: a non-target subtract that has its own operation is machined twice, and the
second pass cuts air. Wasted time beats a part that comes out wrong.

### Which subtracts qualify

Discovery mirrors island discovery: expanded, closed geometry, `operation === 'subtract'`,
not a target, footprint intersecting the **target union**.

Deliberately **one hop**. A subtract that reaches the target only through another
qualifying subtract does not join. The void is connected, so a transitive closure would be
defensible, but one overlap could then walk the whole project and make the area an
operation clears unpredictable from the target the user picked.

Deliberately **no "owned by an add" exclusion**, unlike `relatedSubtractFeatures`
([`src/engine/toolpaths/modelProtection.ts`](../src/engine/toolpaths/modelProtection.ts)).
That rule exists for 3D operations, where a subtract inside an add would drag the whole
operation's Z range deeper. Here the effect is scoped to one band and one footprint, and a
pocket cut into an island is a real void inside the region.

Islands and tabs are then discovered against the **widened** union — target plus qualifying
subtracts — so an add standing in newly-opened area is still found. Widening uses the
unclipped subtract footprints: discovery is conservative across every band, and an add that
turns out not to overlap the resolved void differences nothing.

### The material silhouette

A non-target subtract's contribution is clipped to the union of the **add features standing
in that band**. Outside the model there is nothing the model says must be gone — that
material belongs to an outside profile operation — so the region does not follow a subtract
out into waste stock. Target subtracts are never clipped; that is unchanged.

`buildBooleanModel` does not include the stock: only the first `add` seeds the solid, so a
project of stock plus subtracts has no model silhouette at all. Clipping to an empty
silhouette would there silently drop every non-target subtract, so **a band with no active
add falls back to the stock footprint**.

### What the user is told

`regionExtendedBySubtractDepth` fires only when the resolved bands reach below the deepest
target. That is the one consequence a user cannot predict from the operation's own target.
Eating an island or widening the boundary is the operation simply being correct; warning on
those would leave a permanent warning on every project that has an overlapping subtract.

## Guarantee for existing projects

When no non-target subtract intersects the target union, discovery is empty and every path
above short-circuits: the resolved bands are identical to their pre-#526 values. This was
verified across all 14 fixtures in `src/engine/test-fixtures/` — the parity corpus behind
issue #675 — which produce byte-identical bands before and after.
