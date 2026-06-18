---
status: Done   # Draft → Approved → In progress → Done | Abandoned
created: 2026-06-17
root-caused: 2026-06-17   # P6-extraction regression; one-line fix — see "Root cause" below
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

## Root cause (confirmed via runtime instrumentation, 2026-06-17)

Logging showed the button works and the field activates, then is torn down on the same click:

```
canDimEdit=true → triggerDimensionFromCreationPanel fired → triggerDimensionEdit →
setDimensionEdit(rect) → dimensionEdit=rect/width, creationDimEditActive=TRUE  (field should show)
→ dimensionEdit=null, creationDimEditActive=false   (reset on the very next render)
```

The teardown is this effect in `SketchCanvas.tsx` (~851):

```js
useEffect(() => {
  if (selection.mode !== 'sketch_edit') {
    …
    dimEdit.setDimensionEdit(null)
  }
}, [selection.mode, dimEdit])
```

Its purpose is to clear *sketch-edit* dimension state when you **leave** sketch-edit mode. But `dimEdit` (the `useDimensionEditWorkflow` return) is a **plain object literal — not memoised** (`useDimensionEditWorkflow.ts:233`, zero `useMemo`), so it's a new reference every render. With `dimEdit` in the dep array the effect runs **every render**. During feature creation `selection.mode !== 'sketch_edit'` is true, so every render it calls `setDimensionEdit(null)` — wiping the field the creation button just set. (In sketch-edit mode the `!== 'sketch_edit'` guard is false, so it's a harmless no-op there — which is why sketch-edit dimension entry and the fillet radius entry both work.)

**It's a P6-extraction regression.** On `main` this effect's deps are `[selection.mode]` only (`SketchCanvas.tsx:1144` on `main`) — it runs only on a real mode change, so the creation field survives. The P6 SketchCanvas hook extraction changed the deps to `[selection.mode, dimEdit]` (the lint rule sees `dimEdit.*` usage and the whole unstable object got added), turning a mode-change cleanup into an every-render wipe.

## Fix

Restore main's behaviour — depend only on the primitive that gates the effect:

```js
}, [selection.mode])   // was [selection.mode, dimEdit]
```

with a `// eslint-disable-next-line react-hooks/exhaustive-deps` (the referenced `dimEdit.setDimensionEdit` / `dimEdit.*Ref` are stable across renders even though the wrapper object isn't). Small, contained, behaviour matches `main`.

## Broader flag (separate, worth a quick audit)

The same extraction pattern — putting an unstable hook-return object (`dimEdit`, `fillet`, `creation`, …) into a `useEffect`/`useCallback` dep array — could affect **other** effects in `SketchCanvas.tsx`, silently turning them into every-render effects. Recommend a focused audit grepping effect dep arrays in the extracted canvas hooks for whole-object hook deps. Track separately from this fix.

## Out of scope

The broader audit above (its own task). This doc's fix is just the one dep array.
