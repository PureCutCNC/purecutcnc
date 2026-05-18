# Mirror Transform Implementation Plan

## Goal

Add a feature mirror transform that follows the existing rotate workflow:

- User pre-selects one or more features.
- User starts Mirror from the feature edit controls.
- User defines the mirror plane by clicking two points.
- The transform can either replace the selected features or preserve the originals and create one mirrored copy of each selected feature.
- Mirror does not support multiple copies.

## UX Flow

Mirror is represented as a `pendingTransform` mode alongside resize and rotate.

1. `startMirrorFeature(featureId)` captures the active feature selection the same way rotate does.
2. The canvas banner prompts for the first mirror-line point.
3. After the first point, the banner prompts for the second mirror-line point and exposes a `Keep originals` checkbox.
4. Moving the pointer previews the mirrored features using the first point and current pointer as the mirror line.
5. Clicking the second point commits immediately.

Unlike rotate, mirror has no third angle click and no copy-count prompt.

## Geometry

The mirror plane is the infinite 2D line through the two picked points.

For each transformed point:

```text
local = point - lineStart
unit = normalize(lineEnd - lineStart)
mirrored = lineStart + 2 * unit * dot(local, unit) - local
```

Profiles are transformed point-for-point. Arc and circle segments have their `clockwise` flag inverted because reflection changes handedness. Text and STL features keep their feature kind; STL silhouette paths are mirrored with the same point transform.

The feature `orientationAngle` is updated by reflecting its orientation vector across the mirror line and converting that vector back to degrees.

## State And History

`PendingTransformTool.mode` becomes `'resize' | 'rotate' | 'mirror'`.

Commit behavior:

- Replace mode: selected features are replaced with mirrored features in-place, history records one transaction, and stale constraint geometry is refreshed with the same policy used by resize.
- Preserve-originals mode: one mirrored copy per selected feature is appended and selected. Existing originals remain unchanged. There is no copy-count input.

Locked selected features block mirror startup, matching move/resize/rotate.

## Testing

Add focused transform-helper tests covering:

- Mirroring a rectangular feature across a vertical line.
- Mirroring a feature with an arc flips the arc handedness.
- Mirrored STL features mirror silhouette paths without changing mesh scale.
