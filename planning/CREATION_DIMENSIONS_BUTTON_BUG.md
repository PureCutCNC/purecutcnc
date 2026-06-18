---
status: Draft   # Draft → Approved → In progress → Done | Abandoned   (investigation — root cause not yet found; needs runtime diagnosis before a fix plan)
created: 2026-06-17
---

# Feature-create "Dimensions" button does nothing — investigation

> Surfaced while browser-verifying P7.4 (2026-06-17). **Not caused by P7 or P7.4** — confirmed below. Pre-existing; investigate, root-cause, then write a fix plan from [TEMPLATE.md](TEMPLATE.md) before changing code.

## Symptom

While **creating** a feature (e.g. rectangle): click the first corner so the creation panel shows "Click opposite corner or enter dimensions" with a **"Dimensions"** button. Clicking that button **does nothing** — no numeric Length/Width/Height (or Radius) field appears. Reported across feature-create shapes ("does not work on all popups for feature create"). The pending shape itself stays on the canvas.

(Distinct from the sketch-**edit** dimension entry and the fillet radius entry, both of which work.)

## Scope / provenance (what's been established)

- **Not P7 / P7.4.** P7's diff (`ae5fa48^..99ad7ca`) never touches `triggerDimensionEdit` or the creation "Dimensions" button; P7.4 is fillet-only. The creation-dimension code lives in `useCreationWorkflow.ts` (last changed in **P6 Round 7**, `556d6fb`, the creation-workflow extraction) and `SketchCanvas.tsx#triggerDimensionEdit`.
- **Either a P6-R7 extraction regression or older (possibly on `main`).** Not yet determined — see next steps.

## What's been ruled out (static read)

- **Wiring is correct on paper:** button `onClick={creation.triggerDimensionFromCreationPanel}` → `triggerDimensionEdit()` → for a rect with an anchor it calls `dimEdit.setDimensionEdit({ shape:'rect', activeField:'width', … })` unconditionally (`SketchCanvas.tsx:2225‑2238`). The panel renders the field when `creationDimEditActive = creationCanDimEdit && dimensionEdit` (`useCreationWorkflow.ts:107`), and the shell passes `dimensionEdit: dimEdit.dimensionEdit` (`SketchCanvas.tsx:599`). The "Dimensions" button only shows when `creationCanDimEdit` is true, which for a rect requires `pendingAdd.anchor` — the same condition `triggerDimensionEdit` checks. So on paper the click should populate the field.
- **Not the pointer-leave class of bug** (the one fixed in P7.4): `handlePointerLeave` does **not** null `pendingAddRef`, and nothing in the gesture/click handlers clears the pending creation. So `pendingAddRef.current` is still set when the button is clicked.

## Hypotheses to test at runtime

1. `triggerDimensionEdit()` runs but `dimEdit.setDimensionEdit(...)` doesn't stick — an effect (in `useDimensionEditWorkflow` or the `runLivePointerPreview` effect at `SketchCanvas.tsx:2210`) clears `dimensionEdit` on the same/next render.
2. `pendingAddRef.current` (the state-mirror ref read by `triggerDimensionEdit`) is somehow stale/missing `.anchor` at click time even though the React `pendingAdd` (driving the button's visibility) has it.
3. The button's `onClick` isn't firing the expected handler (stale closure / wrong binding after the P6-R7 extraction).

## Next steps

- Run the dev server + browser; instrument `triggerDimensionEdit` and `creation.triggerDimensionFromCreationPanel` (temp `console.log`) to see whether the click fires, whether `pendingAddRef.current.anchor` is present, and whether `dimEdit.dimensionEdit` flips and then gets reset. Revert instrumentation after.
- Determine P6-R7-regression vs pre-existing by checking the same flow on `main`.
- Then write a fix plan from the template and get approval before changing code.

## Out of scope (until root cause known)

No code changes yet — this is an investigation doc. The fix is a separate, approved plan.
