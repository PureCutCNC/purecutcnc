# PureCutCNC — Honest UX & Concept Review

**Date:** 2026-06-08
**Reviewer:** Claude Code (CLI), model Claude Opus 4.7 (`claude-opus-4-7`)
**Note:** This is one of several independent model reviews the project owner is collecting to inform the next release plan. It is not a synthesis of, response to, or replacement for any other review in this folder (e.g. `PureCutCNC_Assessment_Report.md`, which was produced by a different model). Each report is meant to stand alone as a raw opinion.
**Scope:** Usability, interaction model, and conceptual positioning in the broader CAD/CAM landscape. No code changes — observation only.
**Method:** Read of `README.md`, `ARCHITECTURE.md`, `AGENTS.md`, `planning/CAM_App_Design.md`, `planning/TABLET_UX_COMBINED_PLAN.md`, `planning/INDEX.md`, `TODO.md`, `RELEASE_NOTES.md`, key UI sources (`App.tsx`, `AppShell.tsx`, `Toolbar.tsx`, `CAMPanel.tsx`, `OperationAddMenu.tsx`, `FeatureTree.tsx`, `SketchCanvas.tsx` structure), and type/operation definitions.

---

## TL;DR

PureCutCNC is genuinely interesting. The central idea — **the sketch feature *is* the CAM feature** — is the single most defensible thing about the product, and it is implemented coherently from the data model up. The execution is competent: real CSG-based 3D preview, voxel simulation, a serious toolpath engine (recursive V-carve skeleton, adaptive waterline, etc.), proper import/export coverage, both web and Tauri desktop.

Where it is less convincing today is at the **edges where the user actually meets the app**: a still-incomplete tablet story, a properties/feature-tree UI that is dense for the hobbyist target, a "region" concept that is intentionally non-obvious, and a 2.5D-plus-bolted-on-3D positioning that risks confusing the audience it wants to win. The "AI as first-class via MCP" promise from the original design doc has been quietly dropped from the product, which is fine — but the marketing-style language has not been swept out everywhere, so it occasionally over-promises.

Below: what works, what doesn't, and where it sits.

---

## 1. The Core Concept — How It Sits in CAD/CAM

### 1.1 The defensible idea

Most CAM packages assume a two-step model: design geometry in CAD, then in a separate environment assign volumetric intent (extrude, pocket, etc.) and machining strategy. Fusion 360, SolidWorks CAM, MasterCAM, even Vectric to a degree, all do this.

PureCutCNC says: a 2.5D part is just a flat tree of "things with a Z range and an add/subtract sign". So **the sketch feature carries its own `z_top`, `z_bottom`, and `operation: add | subtract | region`**, and the feature tree is evaluated as a CSG sequence. From that one model you get:

- The sketch view (clipper-resolved 2D)
- The 3D preview (manifold WASM CSG → Three.js)
- The toolpath inputs (`engine/toolpaths/resolver.ts`)
- The simulation stock (voxel/heightfield removal)
- The G-code

That is a clean, honest mental model that matches how a hobbyist machinist actually thinks about a 2.5D part ("I want this pocket 6 mm deep, and this boss 3 mm proud"). It removes an entire conceptual step that beginners stumble on in Fusion. It is the right idea for the audience.

### 1.2 Landscape positioning

| Tier | Examples | PureCutCNC vs. them |
|---|---|---|
| Free hobbyist CAM (entry) | Carbide Create, Easel, jscut, Kiri:Moto, MakerCAM (defunct), OpenBuilds CAM | PureCutCNC is **more capable**: parametric features, real CSG preview, voxel sim, V-carve skeleton, surface rough/finish on STL, parametric named dimensions with formulas. These tools mostly don't have any of that. |
| Paid hobbyist/prosumer | Vectric V-Carve Desktop/Pro, MeshCAM, EstlCAM, F-Engrave | PureCutCNC is **comparable in surface area** (V-carve, pocketing, drilling, profile, surface, tabs/clamps) and **better in some places** (browser-based, free, parametric, modern simulation). Behind in: post-processor library breadth, hand-tuned strategies that have decades of polish, established user community/training. |
| Full 3-axis pro | Fusion 360 CAM, MasterCAM, HSMWorks | Not the same product. PureCutCNC has no real 3D modeling, no 4/5-axis, no adaptive 3D clearing as a primary strategy. Doesn't try to compete. |

So the slot it's targeting is real: **"more than Carbide Create, less than Fusion"**, ideally free and browser-accessible. That slot has historically been won by Vectric (paid) and Carbide (Shapeoko-tied). An open-source, browser-native entry with a fresher data model is a credible angle.

### 1.3 Where the concept gets fuzzy

- **"2.5D, but also 3D surface ops on imported STL/OBJ."** Functionally that's a fine line to walk, but it is hard to *describe*. The current README says it well in long form, but a first-time user landing on the app will either be disappointed (expecting full 3D modeling) or confused (why are there `Surface Rough` and `Surface Finish` operations on a 2.5D app?). It would help to make the boundary explicit in-app: "Import a mesh to machine its top surface — no 3D modeling here."
- **The `region` feature kind** filters where operations apply rather than defining what to machine. This is documented in `planning/REGION_FEATURE_SEMANTICS.md` precisely because it's not obvious. From a user-facing standpoint this is a leak: regions look like features (live in the feature tree, have geometry) but behave like operation parameters. Expect new users to misuse this until they get a small "regions are filters, not targets" affordance in the UI.
- **MCP / AI integration.** `ARCHITECTURE.md` is now honest ("not yet implemented"), but the older `planning/CAM_App_Design.md` still calls AI a "first-class citizen". That mismatch is fine internally but, if any of that language leaks to README/marketing, it will set the wrong expectation. Recommend keeping AI-talk out of any user-facing surface until something exists.

---

## 2. Usability — How a User Actually Touches the App

### 2.1 Interaction overview

The app is a classic three-pane CAD shell:

```
┌──────────────── Top toolbar (or left rail) ─────────────────┐
│ feature tree │     Sketch / 3D / Simulation tabs    │ CAM   │
│ + properties │     (one center surface, switched)   │ panel │
│              │                                      │ Tools │
└──────────────┴──────────────────────────────────────┴───────┘
```

A `useShellMode` hook drives a tablet variant where the right panel becomes a drawer. Both panels are user-resizable with persisted ratios in `localStorage`. Toolbar can be top or left. Workspace layout can hide L, R, or both panels. These are good ergonomic touches.

The sketch canvas is the heart of the app: it does drawing, snapping (grid/point/line/midpoint/center/feature), marquee selection, drag transforms, point-level editing, fillets, dimensions, measurement tape, backdrop tracing, and pending-action overlays (move, copy, resize, rotate, mirror, offset, join, cut, constraints). That's a lot of state in one surface — and indeed `SketchCanvas.tsx` is **6,119 lines**. More on that below.

### 2.2 What works well

- **The shell is professional.** Pane resizing, persisted layout, toolbar orientation, workspace presets, dimension/snap popovers, drawer for tablet — none of this is fancy, but it is right. Many hobbyist CAM tools fail this basic bar.
- **Operation discovery is good.** `OperationAddMenu` lets the user expand a card per operation with a short summary, key points, and an example image. That is a real onboarding asset that most CAM tools don't bother with. The "Rough / Finish / Pair" pass selector on each operation row is a clean way to surface a real choice.
- **Feature tree as drag-and-drop folder structure** plus per-folder visibility toggles for features/regions/tabs/clamps gives the user a sane way to organize a non-trivial part. Bulk visibility toggles at the root are a nice quality-of-life touch.
- **Two flavors of dimension** — parametric `NamedDimension` with formulas and CAD-style `DimensionAnnotation` anchored to geometry — is more than the hobbyist tier usually does. Letting the user write `stock_thickness - 3` is a power feature that pays for itself the first time a stock change cascades cleanly.
- **Three viewports (Sketch / 3D / Simulation) from one feature tree** is a strong feedback loop. Most hobbyist tools either skip simulation or have a separate sim tool.
- **`.camj` is one human-readable file** that opens in the app and is even used to build the icon set (`icons.camj`). That's a clever level of dogfooding and a sign the data format is real, not improvised.
- **Browser-first with optional desktop (Tauri).** Removes the install hurdle that kills many hobby tools. Tauri build gets you OS file dialogs and native chrome without redoing the UI.

### 2.3 Where the usability bites

- **Sketch canvas density.** `SketchCanvas.tsx` is ~6,100 lines and orchestrates dozens of distinct interaction modes (placement of six shape types, six transforms, edit tool with point add/delete/move/fillet, six dimension types, snapping, marquee, zoom-window, tape-measure, constraint placement, backdrop transforms…). For a user, this means **modal richness**: the canvas behaves very differently depending on which pending action is armed. Users will need a strong visual indication of "what mode am I in right now?" — the toolbar buttons help, but the canvas itself does most of the talking, and the active-mode signal can get lost. The fact that `App.tsx` is 1,346 lines and `CAMPanel.tsx` is 2,191 lines suggests the same density issue in the right panels. This isn't an emergency — it's a quiet warning that the next major UX improvement requires structural simplification, not more features.
- **Properties panel.** `PropertiesPanel.tsx` is 1,460 lines, which is normal for "panel that adapts to selection kind" but suggests every kind of selection (feature / folder / dimension / tab / clamp / stock / origin / grid / backdrop / project root) renders a different form. That's correct functionally but exhausting visually. A user clicking around the tree to see "what can I change?" will get a different layout almost every time, and there is no consistent micro-pattern to anchor them.
- **Tablet support is in transition.** `planning/TABLET_UX_COMBINED_PLAN.md` is explicit: the sketch canvas was non-functional on iPad as of the plan, and a 4-PR plan is in progress. The README still pitches the app as broadly usable; tablet users will hit walls until that plan lands. **Don't promote tablet usage publicly until PR4 is in.**
- **Mode-discovery via keyboard shortcuts.** A lot of the sketch is driven by keys (Tab, L/A/S, etc.) — the tablet plan already acknowledges this needs intent labels. On desktop, the implicit knowledge required ("press Tab to enter dimension input") is a classic CAD problem and hurts first-timers. The popovers and tooltips help; a brief in-app first-run overlay would help more.
- **Region semantics.** Already mentioned. The fix is probably a tiny visual treatment in the feature tree (dashed outline icon? a "filters" badge?) plus a hover explanation. Currently regions look like first-class machined geometry.
- **Operation-target mental model.** Operations target one or more features by selection, then sometimes also a region, sometimes also a tool, sometimes also pass variants (rough/finish). Each operation has its own set of required inputs (V-bit needs a V-bit tool, edge-route-outside needs an add/model feature). Today this is enforced with disabled buttons and `button.hint` tooltips. That's fine, but the failure surface is "the button is grey and I don't know why". A more explicit "missing: a V-bit tool" inline could close that gap.
- **First-run experience.** I see no onboarding/tour/sample-project surfacing. There is an `AboutDialog`, a `NewProjectDialog`, an `ImportGeometryDialog`, but a user launching the app cold sees an empty stock with a long toolbar. Even a single "open the example part" CTA on empty state would lift first-impression usability dramatically. The `work/` folder is full of real `.camj` examples (`LP_carving.camj`, `Oldman-splash-final.camj`, `Cone.camj`) — those should be shipped as bundled samples.

### 2.4 Smaller things

- **Snap settings + dimension popover + snap popover** are good, but yet more state for the user to track. A status-bar summary of "Snap: grid + point" already exists in spirit — making it always-visible would help.
- **Status bar / version display** is web-only with a desktop About menu — sensible. The version-load is async and only appears later, which is mildly jarring on web.
- **No visible undo affordance call-out.** The store has `history` with undo/redo, but new users won't know that until they hit Ctrl+Z. A toolbar undo button is cheap.
- **TODO.md** lists half a dozen real UX papercuts (backdrop loading flicker, origin-placement lag, sketch depth legend not useful, marquee-inside-enclosing-feature). These are honest small issues and worth grouping into a focused "UX polish" PR.

---

## 3. Concept-vs-Execution: Where the App Out-runs Its Story, and Vice Versa

**Execution that outruns the story:**
- The toolpath engine is far more sophisticated than the README's casual list implies. Recursive V-carve with skeleton tracing, Z-smoothing, and retraction optimization (per release notes); adaptive waterline refinement; cumulative top-down model-shadow protection on STL roughing — this is real CAM work, not hobbyist toy code. The marketing could lean harder here without exaggerating.
- The `.camj`-as-icon-source trick and the .camj-only file format show genuine commitment to one data model. That is rare in CAD/CAM and worth talking about — it's a reliability story.

**Story that outruns the execution:**
- "AI / MCP first-class" in `planning/CAM_App_Design.md` is not in the product. Architecture doc has been updated to admit this; the older design doc should be too (or marked as historical).
- Tablet support is presented as a target but is not yet there. The plan is clear; the README shouldn't list tablet/touch as a current capability.
- The README sells the app as the front door for everything from "draw or import geometry" through "export". True for the core happy path. Less true for: 3D mesh-based parts (works but limited), large/complex DXFs ("deeper DXF coverage" is in the focus list), and tablets (in progress).

---

## 4. Recommendations (in priority order, no code asked)

1. **Land the tablet plan before promoting tablet use.** PR1–PR4 in `TABLET_UX_COMBINED_PLAN.md` are the right cuts. Until then, the iPad audience will form an opinion based on something broken.
2. **First-run / empty-state experience.** Ship a couple of `.camj` samples bundled and surface a "Open an example" button on the new-project screen. Lowest-effort, highest-impact onboarding move.
3. **Make `region` look like a filter, not a feature.** A small visual treatment in the feature tree and an inline explanation when one is used as an operation parameter would erase a recurring confusion.
4. **Inline "why is this button disabled" hints.** The information exists in the store (`button.hint`); promoting it from tooltip to inline note next to the disabled button is small work for big clarity gain.
5. **Sweep the marketing-tone documents.** The older planning doc still calls AI a first-class citizen; the older `work/PureCutCNC_Assessment_Report.md` reads like sales copy ("technically sophisticated", "high-end toolpath algorithms"). Keep one honest README and one honest architecture doc; archive the rest.
6. **Plan for `SketchCanvas` / `App` / `CAMPanel` decomposition.** Not because they are broken — they aren't — but because adding the next major interaction mode (or the tablet rewrite) without splitting them will be painful. This is a soft, near-term concern, not an emergency.
7. **Don't try to grow into Fusion territory.** The defensible position is precisely the gap PureCutCNC already targets. Adding 3-axis adaptive clearing, lathe ops, or a proper 3D modeler would dilute the one clear story the app has.

---

## 5. Bottom Line

The **concept** is the strongest part of the project. "Feature = sketch + volumetric intent" is a real idea, well executed in the data model, and it gives the app something to say in a market that mostly differentiates on pricing and machine bundles.

The **engine** is more capable than the product currently brags about.

The **user-facing surface** is competent but dense, and is in the middle of a real transition (tablet). The biggest wins available right now are not new features — they are: finish the tablet pass, soften the onboarding wall, clarify the `region` concept in-UI, and stop the marketing-language drift between docs.

If I had to summarize the project's standing in one sentence: **PureCutCNC is a serious 2.5D CAM tool with one good idea and a UI that hasn't yet caught up to how good the idea and the engine are.** That gap is closable, and most of the closing work is small.
