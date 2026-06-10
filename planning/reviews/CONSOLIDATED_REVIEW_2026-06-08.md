# PureCutCNC — Consolidated Review & Action Plan

**Date:** 2026-06-08
**Compiled from four independent model reviews:**

| # | Reviewer | Model | Source file |
|---|---|---|---|
| 1 | Claude Code (CLI) | Claude Opus 4.7 | `PureCutCNC_UX_Concept_Review_2026-06-08.md` |
| 2 | Codex | GPT-5 | `codex-usability-review-2026-06-08.md` |
| 3 | GitHub Copilot | DeepSeek V4 Pro | `usability-assessment-2026-06-08.md` |
| 4 | Gemini | — | `PureCutCNC_Assessment_Report.md` |

**Scope:** Usability, interaction model, and CAD/CAM positioning. Observation only — no code was changed by any reviewer.

---

## 1. Where the reviewers agree

All four reviews independently land on the same headline:

> **The concept is the product's strongest asset, and the engine is more capable than the product currently advertises. The gap is usability — the UI hasn't caught up to how good the idea and the engine are.**

### Consensus strengths

- **The "feature *is* the CAM operation" model is genuinely novel.** Collapsing CAD sketch + CAM intent into one `SketchFeature` (geometry + `z_top`/`z_bottom` + `add`/`subtract`/`region`) matches how a machinist actually thinks. All four call this the most defensible thing about the product.
- **The engine is serious.** Recursive V-carve skeleton, adaptive waterline, STL surface rough/finish, voxel simulation, CSG 3D preview. Three reviewers explicitly say the engine out-runs the marketing.
- **Clean architecture / real engineering discipline.** Pure (React-free) engine, Zustand slices, strict TS, structural tests, documented conventions, `.camj`-as-icon-source dogfooding.
- **Right market slot.** "More than Carbide Create, less than Fusion 360," browser-first + open source — a credible, currently-unoccupied position.

### Consensus weaknesses

The four reviews converge on a short list of recurring problems. The table below shows which reviewer raised each (a theme raised by 3–4 reviewers is high-confidence signal):

| Theme | Claude | Codex | Copilot | Gemini |
|---|:---:|:---:|:---:|:---:|
| No first-run / onboarding / guided workflow | ● | ● | ● | |
| Collapsed CAD/CAM not realized in UI (no feature-local quick ops) | ◐ | ● | ● | |
| Too many simultaneous modes / unclear "what mode am I in" | ● | ● | ● | |
| Properties panel is a wall of fields (needs progressive disclosure) | ● | ● | ● | |
| `region` concept is subtle and looks like normal geometry | ● | ● | | |
| Disabled-operation hints should be inline & visual, not just tooltips | ● | ● | ● | |
| App shell / toolbars expose too much chrome too early | ◐ | ● | ● | ◐ |
| Tablet support presented as done but still in transition | ● | ● | ◐ | ✗ |
| ~~No visible undo/redo affordance~~ — **incorrect, see note** | ● | | ● | |
| Visual error feedback weak (clamp collisions, stock/origin setup) | ◐ | ● | ● | |
| Doc/marketing-language drift (AI/MCP "first-class" is stale) | ● | | ◐ | ✗ |
| Large files (SketchCanvas/App/CAMPanel) — maintainability risk | ● | | ● | ◐ |

● = raised directly · ◐ = touched on · ✗ = contradicts (Gemini treats tablet as shipped & AI as a live "planned" feature)

> **Note on Gemini:** Its review reads as promotional and repeats claims the others flag as stale (tablet "first-class," AI/MCP as a current selling point). Treat it as the optimistic outlier, not as independent confirmation.

> **Correction (verified against source):** Claude and Copilot both claimed there are "no visible undo/redo buttons." This is **wrong** — undo/redo buttons exist in both `TopCommandBar.tsx` (line ~148) and `Toolbar.tsx` (line ~624), each with correct disabled states tied to `history.past`/`history.future`. The reviewers saw the keyboard-shortcut handlers and assumed no buttons without checking. Dropped from the action items. Worth keeping in mind that these reviews were not fully fact-checked against the code.

---

## 2. Prioritized action items

Priority is driven by **consensus × impact × effort**. Items flagged by 3–4 reviewers as the single highest-leverage move are P0.

### P0 — First-use cliff (highest leverage, do first)

**A0.1 — First-run / empty-state onboarding.**
*Raised by Claude (#2), Codex (highest priority), Copilot (#1 needle-mover).*
A cold-start user sees an empty stock + dense toolbar with no idea where to begin. Ship:
- Bundle a couple of the real `work/*.camj` parts (e.g. `LP_carving.camj`, `Cone.camj`) as sample projects.
- An **"Open an example"** CTA on the new-project / empty-state screen.
- A lightweight contextual checklist for the happy path: *draw/import → stock & origin → feature intent + depth → operation → simulate → export.* Does not need to be a heavy tour; even a dismissible side checklist closes most of the gap.

**A0.2 — Feature-local "Quick Operation" actions.**
*Raised by Codex (high), Copilot (#2 needle-mover); aligned with Claude's disabled-button critique.*
This is what makes the collapsed CAD/CAM concept *visible* in the UI. Right-click (or a button on) a feature offers contextually valid operations using its existing intent/depth:
- subtract feature → "Create Pocket" / "Create Inside Route"
- add/model feature → "Create Outside Route" / "Surface Clean"
- imported STL → "Create Rough Surface" / "Create Finish Surface"

Creates the operation with sensible defaults in one click, instead of the current select-then-hunt-the-CAM-panel flow.

### P1 — Reduce cognitive load (next release)

**A1.1 — Progressive disclosure in Properties (and CAM params).**
*Claude, Codex, Copilot.* Show the few fields most users need (name, operation, `z_top`, `z_bottom`) by default; collapse advanced strategy / stock-to-leave / waterline tuning / debug flags behind clear "Advanced" sections.

**A1.2 — Standardize multi-step interactions on workflow panels.**
*Codex (#2 risk), Claude (modal richness).* Every armed mode should answer: *what am I doing / what next / how to confirm / how to cancel / what's selectable now.* Make the `CanvasWorkflowPanel` the single pattern for all multi-step actions; retire one-off canvas banners and keyboard-only paths.

**A1.3 — Inline & visual operation-validity feedback.**
*Claude (#4), Codex, Copilot.* Promote the existing `button.hint` from tooltip to an inline note ("missing: a V-bit tool"), and highlight compatible features on the canvas when an operation is armed. Replaces the "the button is grey and I don't know why" failure.

**A1.4 — Clarify the `region` concept in-UI.**
*Claude (#3), Codex.* Regions are filters ("where an op may cut"), not geometry ("a thing to cut"). Give them a distinct visual treatment in the feature tree (dashed/badge) and a hover/inline explanation when used as an operation parameter.

**A1.5 — Finish the tablet pass before promoting tablet use.**
*Claude (#1), Codex, Copilot.* Land the `TABLET_UX_COMBINED_PLAN.md` PRs (through PR4). Until then, keep tablet/touch out of any user-facing "current capability" claims — the iPad sketch canvas is still in transition despite Gemini's framing.

### P2 — Polish & trust (quick wins + visual confidence)

**A2.1 — Visual error/collision feedback on canvas.** *Copilot (G/H), Codex.* Red-zone overlay where toolpaths intersect clamps; a WYSIWYG stock + origin + machine-axes indicator so imported SVGs map obviously to the physical machine.

**A2.2 — Simplify default layout & toolbar surface.** *Codex (#3), Copilot (A/E).* Pick one good default workspace layout; let power users opt into the variants. Consider a context-sensitive toolbar instead of `GlobalToolbar` + `CreationToolbar` + `Toolbar` + `TopCommandBar` + `ToolRail` all present at once.

**A2.3 — Edit-mode discoverability.** *Copilot, Claude.* Double-click-to-edit and keyboard-driven modes have zero discoverability; add a visual hint and/or auto tool-switching (Esc → Select).

**A2.4 — Documentation hygiene.** *Claude (#5).* Sweep stale "AI/MCP first-class" language out of `planning/CAM_App_Design.md` (mark historical) and keep one honest README + one honest architecture doc. Don't ship AI claims until something exists.

### P3 — Longer-horizon / structural (not urgent)

**A3.1 — Plan decomposition of the mega-files.** *Claude (#6), Copilot.* `SketchCanvas.tsx` (~6,100 lines), `App.tsx` (~1,350), `CAMPanel.tsx` (~2,200), `PropertiesPanel.tsx` (~1,460). Not broken, but the next major interaction mode or the tablet rewrite will be painful without splitting into focused hooks/components.

**A3.2 — Keep simulation controls user-facing, not technical.** *Codex (#5), Copilot.* Move `simulationDetailCells` and similar toward plain answers ("will it cut the right material / hit clamps / preserve tabs / leave stock?").

**A3.3 — Hold the line on scope.** *Claude (#7).* Don't chase Fusion territory (3-axis adaptive, lathe, full 3D modeler). The defensible position is exactly the gap already targeted.

---

## 3. Suggested sequencing

1. **Sprint 1 (P0):** A0.1 onboarding + bundled samples, A0.2 feature-local quick ops. These two deliver the biggest first-impression and "concept made real" gains.
2. **Sprint 2 (P1):** A1.1 progressive disclosure, A1.3 inline validity hints, A1.4 region clarity — all reduce the load that makes the app feel complex. Run the tablet PRs (A1.5) in parallel.
3. **Ongoing/cleanup:** P2 quick wins (undo buttons, doc sweep) can be slotted opportunistically; P3 structural work scheduled before the next big interaction feature.

---

## 4. One-line bottom line

**PureCutCNC is a serious 2.5D CAM tool with one genuinely good idea and an engine that out-runs its marketing — the work that matters now is making that idea obvious to a first-time user, and almost all of it is small.**
