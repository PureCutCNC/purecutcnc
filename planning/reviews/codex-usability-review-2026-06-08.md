# PureCutCNC Usability Review

Date: 2026-06-08
Author: Codex
**Note:** This is one of several independent model reviews the project owner is collecting to inform the next release plan. It is not a synthesis of, response to, or replacement for any other review in this folder (e.g. `PureCutCNC_Assessment_Report.md`, which was produced by a different model). Each report is meant to stand alone as a raw opinion.
Assessment tool/model: Codex coding agent, based on GPT-5
Scope: Report-only review of the PureCutCNC app concept, usability, user interaction model, and positioning in the CAD/CAM landscape. No source changes were made.

## Executive Summary

PureCutCNC has a strong and differentiated product thesis: collapse 2.5D CAD sketching and CAM intent into one feature model. That is a real idea, not just a UI rearrangement. Features carrying add/subtract intent and Z bounds directly in the sketch can make CNC work feel closer to how a machinist thinks about a part: this area is stock, this area is a pocket, this profile is cut through, this region limits machining.

The app is already much deeper than a simple hobby CAM tool. The code and docs show sketch geometry, CSG-derived 3D preview, toolpath generation, tool libraries, regions, tabs, clamps, imported STL model handling, rough/finish surface operations, simulation, G-code export, and tablet-specific interaction work.

The main product risk is not lack of capability. It is cognitive load. The app has enough surface area that a first-time user may not understand the intended flow: create or import geometry, set feature intent and depth, select compatible targets, create operations, inspect toolpaths, simulate, then export. The underlying model is elegant, but the UI still asks the user to infer too much.

## CAD/CAM Positioning

PureCutCNC sits in a useful gap between simple 2D CAM tools and full CAD/CAM systems.

Compared with tools like Carbide Create, Easel, jscut, or Kiri:Moto, PureCutCNC appears more ambitious: it has a feature tree, additive/subtractive material intent, region masks, STL-derived surface machining, 3D preview, and simulation. That gives it a more serious CAM ceiling.

Compared with Fusion 360, SolidWorks CAM, or FreeCAD Path, PureCutCNC is not trying to be a complete mechanical CAD system. That is the right constraint. The value proposition is lower ceremony for 2.5D work: draw or import the geometry, attach machining intent and depth, and produce usable CAM without the full sketch-extrude-CAM workspace pipeline.

The strongest positioning is:

- More capable than entry-level hobby CAM.
- Easier and more direct than full CAD/CAM for common 2.5D router/mill jobs.
- Browser-first and open-source, with Tauri desktop as a packaging path.
- Especially appealing to hobbyists and small shops that work from SVG/DXF/STL imports and want practical toolpaths without a heavyweight CAD subscription.

The concept is strongest when it stays focused on "CAD-aware CAM for practical CNC" rather than trying to become general-purpose CAD.

## What Works Well

The feature-as-volume model is the best idea in the app. `SketchFeature` carrying sketch geometry plus operation and Z range is the core advantage. It can remove a lot of mode-switching if the UI fully leans into it.

The workspace structure is recognizable: project tree and properties on the left, sketch/3D/simulation in the center, operations/tools on the right. That maps well to CAD/CAM expectations.

The tablet architecture is moving in the right direction. The split between `TopCommandBar` and `ToolRail` is a meaningful improvement over a single overloaded toolbar. File/view actions belong up top; geometry creation and editing belong in a rail or command surface.

The CAM operation menu has the right instinct: it provides operation descriptions, key points, example images, and disabled-state hints when the current selection is not valid. That is exactly the kind of contextual teaching this app needs.

The 3D preview and simulation are important trust surfaces. CNC users need to see not only the design but also whether the generated toolpath will cut what they expect. PureCutCNC has the right validation loop: sketch, toolpath preview, 3D model, simulation, export.

The codebase suggests real engineering discipline: strict TypeScript, isolated engine code, documented architecture, planned workflows, indexed folder maps, and testable CAM logic.

## Main Usability Risks

### 1. The Selection-First CAM Flow Is Still Too Implicit

The app often expects the user to select compatible geometry before creating an operation. The CAM panel then validates the selection and explains why an operation can or cannot be added.

That is useful, but it is reactive. A user has to already know the selection-first model before the help becomes useful. This is a common CAD/CAM failure mode: the app knows exactly what is wrong, but only after the user has already tried the wrong thing.

Recommendation: expose a stronger feature-local action path. For example:

- Select a subtract feature and show "Create Pocket" or "Create Inside Route."
- Select an add/model feature and show "Create Outside Route" or "Surface Clean."
- Select an STL model and show "Create Rough Surface" and "Create Finish Surface."

This would make the collapsed CAD/CAM concept feel real in the interface.

### 2. The App Has Too Many Simultaneous Modes

The app has sketch mode, sketch edit mode, pending add, pending move/copy, pending transform, pending offset, pending shape action, pending constraint, dimension/tape tools, selection modes, center tabs, right tabs, layout variants, drawers, and simulation modes.

Powerful apps need modes, but users need clear mode ownership. Every active mode should answer:

- What am I doing now?
- What should I do next?
- How do I confirm?
- How do I cancel?
- What is selectable right now?

The reusable workflow-panel direction is the right answer. It should become the standard for all multi-step actions.

### 3. The Layout Can Feel Like a Power-User App Too Early

The panel layout is functional, but it exposes a lot of chrome immediately: feature tree, properties, operations/tools, workspace tabs, status toggles, visibility toggles, toolbars, drawers, and context menus.

That is fine for experienced users. It is not ideal for a first session.

Recommendation: keep the rich layout, but add a beginner-friendly default path. The user should not have to understand every panel to make their first pocket operation.

### 4. Regions Are Powerful But Conceptually Subtle

Regions as machining masks are a good idea, but they are not normal geometry and should not be treated like add/subtract material. The repo docs already recognize this.

The UI needs to keep reinforcing this distinction. A region is not "a thing to cut"; it is "where an operation is allowed to cut." If that mental model is unclear, users will produce surprising toolpaths.

### 5. 3D and Simulation Need to Stay User-Facing, Not Technical

Simulation detail cells, visibility modes, and selected-vs-visible operation simulation are useful controls, but they can feel technical. The user wants to know:

- Will this cut the right material?
- Will the tool hit clamps?
- Are tabs preserved?
- Is there leftover stock?
- Is the order safe?

The simulation surface should keep moving toward those practical answers.

## Recommendations

### Highest Priority

Add a guided first-run or empty-project workflow:

1. Draw or import geometry.
2. Define stock and origin.
3. Create feature intent and depth.
4. Create suggested operations.
5. Preview/simulate.
6. Export G-code.

This does not need to be heavy. Even a contextual checklist or side panel would reduce the first-use cliff.

### High Priority

Add feature-local quick operation actions. This is the biggest way to make the core concept visible. If a subtract feature already knows its depth, the app should be able to offer a pocket or inside route directly.

### High Priority

Standardize all multi-step interactions around workflow panels. Avoid one-off canvas banners, duplicated tablet controls, or hidden keyboard-only paths. The panel should own the step label, instruction, confirm/cancel, numeric inputs, and current constraints.

### Medium Priority

Introduce progressive disclosure in Properties and CAM parameters. Show the few fields most users need first, then put advanced strategy, stock-to-leave, waterline tuning, debug flags, and detailed feeds/speeds behind clear sections.

### Medium Priority

Make operation validity more visual. If an operation is disabled because selection is incompatible, show the required target type in plain language and preferably highlight compatible features.

### Medium Priority

Keep investing in tablet interaction as a first-class workflow. Tablet is not only about larger buttons. It requires visible alternatives for hover, right-click, double-click, keyboard shortcuts, drag reorder, and modifier-key selection.

## Honest Bottom Line

PureCutCNC has the bones of a strong CNC product. The concept is good, the engine depth is serious, and the architecture is more disciplined than many early-stage apps.

The gap is usability, not ambition. The app needs to make its own model more obvious. If the user has to learn the internal concepts before they can make a simple job, the product will feel complex even though the core idea is supposed to reduce complexity.

The strategic direction should be: fewer visible choices at the start, stronger contextual actions, more guided operation creation, and clearer mode panels. Keep the power, but stop making the user discover the workflow by trial and error.
