# Text Object Implementation Plan

## Goal

Introduce a persistent editable text feature instead of baking text directly into ordinary sketch features.

## Model

- Add `kind: 'text'` feature support.
- Store source text settings on the feature:
  - `text`
  - `style`
  - `fontId`
  - `size`
- Keep one internal frame rectangle in `feature.sketch.profile`.
  - This frame defines overall position and size.
  - Move/copy/resize/rotate act on the frame.
- Keep `operation`, `z_top`, and `z_bottom` on the parent text feature.
- Generate visible/CAM geometry from the text settings and the current frame.

## Scope

### TXO1
- [x] Add text feature data to the project model.

### TXO2
- [x] Create text as one feature instead of a folder of baked letter features.

### TXO3
- [x] Render text feature geometry in sketch/3D/CAM from the stored source text.

### TXO4
- [x] Add editable text properties:
  - [x] text content
  - [x] style
  - [x] built-in font choice
  - [x] shared operation
  - [x] shared Z top / bottom

### TXO5
- [~] Keep transform tools working on text through the internal frame.
  - [x] move
  - [x] copy
  - [x] resize
  - [x] rotate
  - [ ] tighten hit-testing so selection follows the actual letters instead of the invisible frame everywhere

### TXO6
- [ ] Add direct text edit action from the selected feature toolbar.

### TXO7
- [ ] Add imported custom font support (`.ttf` / `.otf`) as project assets.

## Font Strategy

Current built-in support is deterministic and compact in project files:

- projects save only the text source settings and a compact `fontId`
- built-in typeface JSON is loaded from the app bundle, not embedded into project files
- synthetic built-in variants such as italic and condensed are derived at render time from the bundled base faces

Current built-in families:

- `Simple Stroke`
- `Helvetiker`
- `Optimer`
- `Gentilis`
- `Droid Sans`
- `Droid Serif`

Current built-in variants:

- regular / bold where the bundled face provides it
- synthetic italic variants
- selected synthetic condensed variants

Later:

- allow importing font files into the project
- lazy-load non-default built-in outline families if bundle size becomes a problem
- avoid relying on arbitrary system fonts as the main saved workflow

## Notes

- Text is single-line only in this phase.
- Outline text produces closed contours.
- Skeleton text produces open engraving paths.
- The internal frame is not intended as final visible geometry; it is only the transform basis for the generated text.
