# INDEX — src/engine/modelRecognition/

Finds the pockets and holes of an imported model that a 2.5D operation can cut, and the solids they are cut out of (issue #1206). Pure engine code: a triangle mesh in, a list of cavities and bodies out. No project, no store, no React.

The mesh must already be **in the frame of one face**, with Z pointing at the tool. Putting a model into that frame (instance transform, orientation, a Bottom setup's turn, the Around unroll) is the caller's job. Results come back in the same frame, including arc direction.

- `types.ts` — `RecognitionMesh` in; `ModelRecognitionResult` out: `cavities` (outline as a `SketchProfile` and a plain polygon, a `circle` when round, Z span, what the walls end on, islands, whether the rim flares), `skipped` (seen but not returned, with a reason: `undercut`, `taperedWalls`, `openMesh`), `solids` (the prismatic bodies the cavities are cut out of: the same profile, outline and circle, plus a Z span, bottom first) with `skippedSolids` under the same reasons, `levelsTruncated` and `meshOpen`
- `levels.ts` — candidate levels: the Z of horizontal faces and the Z where vertical walls begin or end, clustered and capped at `MAX_LEVELS`. Between two neighbouring levels a wall is vertical all the way or not at all. Also collects the upward-facing flat triangles per level (the floors)
- `sections.ts` — a mesh section as nested loops (material, hole, island) through Clipper's even-odd rule, plus the plan-view area tests everything else is built on (`loopsMatch`, `intersectionArea`, `differenceArea`, `unionRegion`)
- `fit.ts` — a loop back into a drawing: a circle through the facet corners when they all lie on one, otherwise arcs for runs of corners on a common circle and lines for the rest
- `recognize.ts` — `recognizeCavities`: bands (a hole loop that is the same at both ends of a slab), tracks (bands joined across levels), each track's bottom and top, the reach check, islands, and the grouping of never-vertical voids. The same walk on the other kind of loop gives the solids — top-level material loops — with a stand-on check instead of the reach check. The file header states the rules
- `candidates.ts` — from a detector result to drawable candidates (slices 2 and 3): one add per solid **before** the subtract per cavity and the add per island, with lengths rounded once so the value listed is the value stored; `markAlreadyDrawn` flags a candidate that matches an existing feature (same face, operation, span and outline), which is what makes a second run safe
- `index.ts` — public exports
- `recognize.test.ts` — the detector on plates cut by Manifold: pocket, through hole, counterbore (plain and chamfered), stepped pocket, boss and chamfered boss, drill point, chamfered rim, drafted pocket, T-slot, shelf, mushroom boss, 12- and 8-sided circles, slot arcs, a missing wall triangle, inches, an off-origin rotated placement, degenerate input. Solids: a plain plate, a raised boss (stacked), a plate with holes and a pocket, a chamfered top, an overhanging cap, a round bar, inches. Its header lists the mutations each block was checked against

## Rules worth knowing before changing anything

- Tolerances are a fraction of the mesh's bounding diagonal, never an absolute length, so a part gives the same answer in mm and in inches.
- A counterbore is two cavities **stacked** at the step. A cavity's top stops where it opens into a wider cavity that is itself returned, and carries on up through a band that is not vertical (a chamfer).
- A solid ends where its straight walls end: unlike a cavity it is never carried up through a flare. Stepped parts come back stacked, bottom first.
- A wrong shape is worse than a missing one. Anything covered from above, or with material overhanging its floor, is reported in `skipped` and not returned. A body hanging over empty space is reported in `skippedSolids` as an `undercut` and not returned either.
