---
status: Draft   # Draft → Approved → In progress → Done | Abandoned
created: 2026-06-16
---

# Stock Texture in Simulation Plan

## Goal

Let the user attach an image (wood grain, aluminium, MDF, or a photo of their
actual board) to the **stock definition**, and render it on the simulation stock
for a more realistic material-removal preview. The texture must look correct on
the curved/steep surfaces produced by the 3D surface operations
(`roughSurface` / `finishSurface`), not just flat 2.5D floors — so mapping is
done with **triplanar projection** from the start, not a flat top-down UV stretch.

User-visible outcome: a "Texture" control in the stock properties panel where the
user picks an image, chooses how it maps to the stock (Fit or Tile), and sees the
result draped over the stock in the simulation viewport. The image is embedded in
the `.camj` so projects stay self-contained.

## Decisions already locked (from design discussion)

- **Mapping modes:** support **both** Fit-to-stock and Tile-at-actual-size;
  **default to Fit** (zero-config — drop an image and it fills the stock).
- **Fit aspect handling:** **Cover** (uniform scale + crop), so grain never looks
  squashed.
- **Storage:** **embed** the image in the `.camj` (base64 data URL), consistent
  with `.camj` being a self-contained format.
- **Projection:** **triplanar** (Level B), blended by the per-fragment surface
  normal, so steep 3D-carved flanks don't smear.
- **Downscale on import:** images are downscaled to a max dimension of **2048px**
  (aspect preserved) before embedding, to keep `.camj` size reasonable.
- **Tile wrap:** Tile mode offers **repeat** or **mirror**
  (`MirroredRepeatWrapping`), defaulting to **mirror** — it's seam-free by
  construction and, for wood, reads as intentional book-matching. Repeat stays
  available for images that genuinely tile.

## Sequencing

**Implementation is deferred until the in-progress major restructuring work
completes** (see [`REFACTORING_Plan.md`](REFACTORING_Plan.md)); this feature will
be built on top of the restructured code. The plan stays `Draft` until then. When
picking it up, re-verify the file paths in "Files affected" against the
post-restructuring layout before starting.

## Approach

### Data model (`src/types/project.ts`)

Add an optional `texture` block to `Stock` (additive — old projects without it
are unaffected, so no migration logic is required beyond treating `undefined` as
"no texture"):

```ts
export interface StockTexture {
  /** Base64 data URL of the image, embedded in the .camj. */
  imageData: string
  /** Natural pixel dimensions, captured at load so scale math needs no decode. */
  imageWidthPx: number
  imageHeightPx: number
  mode: 'fit' | 'tile'
  /** Tile mode only: real-world width one copy of the image spans, in project units.
   *  Height is derived from the pixel aspect ratio. */
  physicalWidth?: number
  /** Tile mode only: how the image repeats. Defaults to 'mirror' (seam-free). */
  tileWrap?: 'repeat' | 'mirror'
}

export interface Stock {
  // ...existing fields...
  texture?: StockTexture | null
}
```

`defaultStock(...)` leaves `texture` undefined.

### Scale resolution (new pure helper, unit-tested)

A pure function turns the stock bounds + texture settings into the world-space
size one copy of the image spans (the value the shader needs):

```ts
// src/engine/simulation/stockTexture.ts
export function resolveTextureWorldSize(
  stockBounds: Bounds2D,
  texture: StockTexture,
): { worldSizeX: number; worldSizeY: number; wrap: 'repeat' | 'mirror' | 'clamp' }
```

- **tile:** `worldSizeX = physicalWidth`, `worldSizeY = physicalWidth / aspect`,
  `wrap = texture.tileWrap ?? 'mirror'`.
- **fit (cover):** pick the uniform scale that covers the footprint
  (`max` of the two axis ratios), so one copy covers the stock with overflow
  cropped; `wrap = 'clamp'`. Returns the covered world size centered on the stock.

This is the only non-trivial math and gets the bulk of the unit tests.

### Rendering — triplanar in the heightfield shaders (`heightfieldShader.ts`)

The surface and the boundary/wall materials currently output `uColor * lighting`.
Triplanar replaces the base color:

- Add a shared **`uColorMap` sampler**, **`uTextureWorldSize` (vec2)**,
  **`uTextureOrigin` (vec2)**, and a **`uUseTexture` bool** to the surface
  material and the active wall material(s).
- Pass **world position** to the fragment shader as a varying. The surface plane
  already gives world XZ from `position`; world Y is the displaced `vHeight`. The
  wall shaders already build world positions too.
- Triplanar sample: project world pos on the XZ / XY / ZY planes using
  `worldPos / uTextureWorldSize`, sample three times, blend weights from
  `abs(normal)` (normal already computed per-fragment for the surface at
  `heightfieldShader.ts:92`, and as `vNormal` for walls).
- The existing `depthDarken` term stays, multiplying the textured base color.

Triplanar adds 3 texture fetches where there was 1 — negligible next to the 5
heightfield fetches the surface shader already does.

### Texture upload + material wiring (`gpuMesh.ts` + `SimulationViewport.tsx`)

On image import (in the panel handler), downscale the picked file to a max
dimension of 2048px (preserving aspect, via an offscreen canvas) before encoding
the data URL. The captured `imageWidthPx` / `imageHeightPx` reflect the
downscaled size.

- In `SimulationViewport`, when `stock.texture` is set, build a `THREE.Texture`
  from `imageData` once (memoised by `imageData`): `colorSpace = SRGBColorSpace`,
  `wrapS/wrapT` from the resolved `wrap` (`repeat → RepeatWrapping`,
  `mirror → MirroredRepeatWrapping`, `clamp → ClampToEdgeWrapping`),
  `generateMipmaps = true`,
  `anisotropy = renderer.capabilities.getMaxAnisotropy()`. Dispose on change/unmount.
- Compute `uTextureWorldSize` / `uTextureOrigin` from `resolveTextureWorldSize`
  using the grid's stock bounds, and feed the uniforms into the materials created
  by `gpuMesh.ts` / `heightfieldShader.ts`.
- `uUseTexture = false` when no texture → identical to today's flat-color render.

### UI — stock properties panel (`PropertiesPanel.tsx`)

In the existing stock section (near color/material, around `PropertiesPanel.tsx:548`):

- **Image picker** — `<input type="file" accept="image/*">`; on select, read as a
  data URL, capture natural px size, write `texture` via the store.
- **Mode select** — Fit / Tile.
- **Physical width field** — shown only in Tile mode, in project units.
- **Tile wrap selector** — Repeat / Mirror; shown only in Tile mode, default Mirror.
- **Clear** button — sets `texture` to null.

Gotcha to handle: the panel rebuilds the stock via `defaultStock(...)` and copies
`material` / `color` / `visible` across (e.g. `PropertiesPanel.tsx:604-607`). The
new `texture` field must be copied in every one of those rebuild sites, or editing
width/height/thickness would silently drop the texture.

### Store (`projectStore.ts` / `store/types.ts`)

`setStock` already replaces the whole stock object, so no new action is strictly
required. Optionally add a thin `setStockTexture(texture | null)` for clarity and
to keep undo/redo entries readable. Texture changes go through history like any
other stock edit.

## Files affected

- `src/types/project.ts` — add `StockTexture` interface + `Stock.texture` field; `defaultStock` leaves it undefined.
- *(new)* `src/engine/simulation/stockTexture.ts` — `resolveTextureWorldSize` pure helper.
- `src/engine/simulation/heightfieldShader.ts` — triplanar sampling + new uniforms in the surface material and the active wall material(s).
- `src/engine/simulation/gpuMesh.ts` — thread texture uniforms through material creation.
- `src/engine/simulation/index.ts` — export the new helper.
- `src/components/simulation/SimulationViewport.tsx` — build/dispose the `THREE.Texture`, resolve world size, set uniforms.
- `src/components/feature-tree/PropertiesPanel.tsx` — texture picker / mode / physical-width / clear UI; preserve `texture` across the `defaultStock` rebuild sites.
- `src/store/projectStore.ts` + `src/store/types.ts` — optional `setStockTexture` action.
- `INDEX.md` files for `src/engine/simulation/` (new file) per the maintenance rule.

## Tests

- *(new)* `src/engine/simulation/stockTexture.test.ts` — `resolveTextureWorldSize`:
  - tile mode: world size from `physicalWidth` + pixel aspect; wrap defaults to
    `mirror` and honors an explicit `repeat`.
  - fit/cover: uniform scale covers footprint; wider-than-stock and taller-than-stock
    images both crop correctly; wrap = clamp; result centered.
  - square image on non-square stock; non-square image; degenerate/zero guards.
- `src/types/project` round-trip: a `.camj` with `texture` serialises/deserialises;
  a `.camj` without it still loads (undefined texture).
- `gpuMesh.test.ts` — extend to assert the surface material exposes the texture
  uniforms and that `uUseTexture` is false when no texture is provided.

Shader visual correctness is validated manually (triplanar can't be meaningfully
unit-tested), per the validation section below.

## Open questions / risks

- **Realism reality-check (the two viable routes):** convincing results come from
  either (a) one large image covering the whole stock (Fit/Cover — no seams, best
  for a photo of the actual board), or (b) a seamless tile (Tile mode — good for
  uniform materials). **Wood is the hard case for tiling**: directional grain,
  knots and color drift make plain `RepeatWrapping` show obvious seams and a
  wallpaper rhythm. Triplanar does **not** hide tile seams (it only hides
  projection stretch on steep walls). **Mirror tiling** (`MirroredRepeatWrapping`,
  the Tile-mode default) removes hard seams by construction and, for wood, reads as
  intentional book-matching — making Tile viable for carefully chosen images; the
  cost is mirror-symmetric repeats of any off-center feature (knots, stains). The
  fully seamless, zoom-independent answer for wood remains procedural/solid grain
  (Level C, out of scope). Expectation: Fit + mirror-Tile serve materials broadly;
  truly convincing arbitrary wood is a later procedural upgrade.
- **Resolution vs. the 2048px cap (tablet tradeoff):** the "big image covers the
  whole stock" route is in tension with the downscale cap — a 2048px image spread
  across a large stock looks soft when zoomed in. Raising to 4096px restores
  sharpness but ~quadruples texture VRAM (≈16MB → ≈64MB + mipmaps), which matters
  on the tablet targets. **Recommendation: keep 2048 as the tablet-safe default**
  and accept some softness on large-stock Fit, rather than per-device cap logic.
- **Triplanar seams on Tile mode** with non-seamless images — inherent; acceptable
  for grain. Documented, not solved here.
- **WebGL float-texture path unchanged** — the color map is a normal 8-bit sRGB
  texture, independent of the heightfield float texture, so no new capability risk.

## Validation

- Load a wood-grain image on rectangular stock; verify Fit fills it once (cover),
  Tile repeats at the set physical size.
- Run a 3D finishing operation and confirm grain stays consistent on steep flanks
  (the triplanar payoff) instead of streaking.
- Confirm no perf regression at 1500-cell resolution during playback.
- Confirm projects without a texture render exactly as today.

## Out of scope

- **Normal/bump mapping** for physical grain relief (only base color is textured).
- **Volumetric / procedural solid wood** (Level C) — true end-grain on cut walls.
- **Texturing the `Viewport3D` CSG preview** — this plan covers the simulation
  viewport only; the 3D preview tab keeps flat stock color (possible follow-up).
- **Per-operation or per-feature textures**, texture rotation/offset controls, and
  external (non-embedded) image references.
