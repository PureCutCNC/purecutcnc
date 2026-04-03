# Text Implementation Plan

Add first-pass text authoring for engraving and derived CAM operations.

## Goals

- Support a text creation workflow directly inside CAMCAM.
- Support both `skeleton` and `outline` text styles.
- Produce normal features so text can immediately participate in:
  - `follow_line` for skeleton engraving
  - `pocket`, `edge route`, and later carve workflows for outline text
- Keep the first pass simple and robust, even if it uses only built-in fonts.

## First-pass scope

### Authoring model

- Add a `Text` creation tool to the main creation toolbar.
- Clicking it opens a small dialog for:
  - text content
  - text style: `Skeleton` or `Outline`
  - text height
  - feature operation: `Add` / `Subtract`
- After confirming the dialog, the user clicks in the sketch to place the text.

### Storage model

- First pass text does **not** stay as a special editable text object.
- Instead, placement generates normal sketch features inside a new feature folder.
- This keeps the result immediately compatible with the existing:
  - feature tree
  - move/copy/resize/rotate tools
  - visibility/lock behavior
  - CAM target selection

### Font model

- First pass uses built-in vector fonts only.
- `Skeleton`:
  - single-stroke stick font
  - generated as open line/composite profiles
- `Outline`:
  - generated from the same built-in stroke font by expanding the strokes into closed contours
  - holes are emitted as alternating contours via normal feature operations

### Character support

- First pass should cover:
  - `A-Z`
  - `0-9`
  - space
  - a few common engraving punctuation marks such as `. - _ / ?`
- Lowercase input can map to uppercase in v1.

## UX details

- Placement preview should render the full text geometry in the sketch before commit.
- The banner should explain:
  - text is ready to place
  - click to place
  - `Esc` cancels
- Created text should land in a folder named from the text string.

## Known first-pass limitations

- No persistent text object editing after creation.
- No external font loading yet.
- No typographic controls beyond size/style/operation.
- No curved text, alignment tools, or live text reflow.
- Built-in font is geometric/technical rather than typographic.

## Tracked items

### TXT1 Text tool workflow
- [x] Add `Text` button to the creation toolbar
- [x] Add text setup dialog
- [x] Add click-to-place flow in the sketch

### TXT2 Built-in font geometry
- [x] Add first-pass built-in stroke font
- [x] Generate skeleton text as open profiles
- [x] Generate outline text as closed contours

### TXT3 Feature creation integration
- [x] Create text as normal features inside a folder
- [x] Preserve requested `Add` / `Subtract` operation where valid
- [x] Select created text features after placement

### TXT4 Sketch preview
- [x] Show live preview while placing text
- [x] Add placement banner/help text

### TXT5 Follow-up work
- [ ] Persistent editable text objects
- [ ] External outline font import
- [ ] Better skeleton font coverage and typography
- [ ] Text alignment, baseline, and spacing controls
- [ ] Real text support in properties/edit flow
