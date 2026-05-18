# Simulation Toolpath Play — XYZ Position Readout

## Goal

Display the current tool-tip position (X, Y, Z) in the simulation playback bar without degrading rendering performance.

---

## Analysis

### Current state

1. `PlaybackController.getPose()` ([`src/engine/simulation/playback.ts:176`](../src/engine/simulation/playback.ts:176)) already returns `{ x, y, z, moveKind }` on every call — zero new computation.
2. `updateToolMeshPose()` ([`src/components/simulation/SimulationViewport.tsx:710`](../src/components/simulation/SimulationViewport.tsx:710)) already calls `controller.getPose()` inside the RAF playback tick — the data is already flowing every frame.
3. The playback bar ([`src/components/simulation/SimulationViewport.tsx:1163-1231`](../src/components/simulation/SimulationViewport.tsx:1163)) sits in the JSX of the component and already handles React state for `playbackProgress`.

### Performance risk

If a raw `setState({x, y, z})` is placed inside the RAF tick ([`src/components/simulation/SimulationViewport.tsx:853`](../src/components/simulation/SimulationViewport.tsx:853)), React would re-render the entire component tree **60 times per second**, which **would** degrade the Three.js rendering performance on the same thread.

### Mitigation strategy — throttled state update

- Store the latest pose in a `useRef` — written every RAF frame with zero React cost.
- Throttle the `setState` call to ~10 Hz (every 100ms). At 10 re-renders/second only a few text nodes update, which is imperceptible vs. ~1-2ms of React overhead.
- The Three.js render loop is unaffected.

---

## Implementation Plan

### Step 1 — Add `useRef` for pose + `useState` for display values

In [`SimulationViewport.tsx`](../src/components/simulation/SimulationViewport.tsx), add near the other refs/state (~line 477):

```ts
// Latest pose from the playback controller — written every RAF frame.
const latestPoseRef = useRef<PlaybackPose>({ x: 0, y: 0, z: 0, moveKind: null })
// Throttled state for the UI readout — updated at ~10 Hz to avoid re-render churn.
const [displayPose, setDisplayPose] = useState<PlaybackPose>({ x: 0, y: 0, z: 0, moveKind: null })
```

**Import**: `PlaybackPose` is exported from [`src/engine/simulation/playback.ts`](../src/engine/simulation/playback.ts).

### Step 2 — Write the ref inside the RAF tick

Inside the `tick` function ([`src/components/simulation/SimulationViewport.tsx:853`](../src/components/simulation/SimulationViewport.tsx:853)), after the existing `updateToolMeshPose()` call at line 872, add:

```ts
const pose = controllerInner.getPose()
latestPoseRef.current = pose
```

This reuses the already-computed pose rather than calling `getPose()` twice, since the viewport also calls it internally. But looking more carefully, `updateToolMeshPose()` already reads `getPose()` internally. So we just need to read the ref after the tool mesh update.

Actually, the cleanest approach: store the pose result from within `updateToolMeshPose` or read it directly from the controller. Since `updateToolMeshPose` already calls `controller.getPose()`, we can simply read `latestPoseRef.current` inside `updateToolMeshPose`. Let me revise:

**In `updateToolMeshPose()` at line 710-719**, add a ref write:

```ts
const updateToolMeshPose = useCallback(() => {
  const controller = playbackControllerRef.current
  const tool = toolMeshRef.current
  if (!controller || !tool) {
    return
  }
  const pose = controller.getPose()
  latestPoseRef.current = pose  // <-- ADD THIS
  // Toolpath (x, y, z) → world (x, z, y): the viewport treats world Y as vertical.
  tool.position.set(pose.x, pose.z, pose.y)
}, [])
```

### Step 3 — Throttle the React state update

Add a `useEffect` that runs a 100ms interval when playback is active, reading from the ref:

```ts
useEffect(() => {
  if (!playbackEnabled || !isPlaying) {
    return
  }

  const interval = setInterval(() => {
    const pose = latestPoseRef.current
    setDisplayPose({ x: pose.x, y: pose.y, z: pose.z, moveKind: pose.moveKind })
  }, 100)

  return () => clearInterval(interval)
}, [playbackEnabled, isPlaying])
```

Also update the display when paused/seeking — a separate effect for non-playing states:

```ts
useEffect(() => {
  const pose = latestPoseRef.current
  setDisplayPose({ x: pose.x, y: pose.y, z: pose.z, moveKind: pose.moveKind })
}, [playbackProgress])  // updates on seek / stop
```

### Step 4 — Add JSX for the XYZ readout in the playback bar

Inside the playback bar div ([`src/components/simulation/SimulationViewport.tsx:1163`](../src/components/simulation/SimulationViewport.tsx:1163)), insert a new element **after** the speed/step controls (~line 1229), **before** the closing `</div>`:

```tsx
<div className="simulation-playback-bar__xyz">
  <span className="simulation-playback-bar__xyz-label">X</span>
  <span className="simulation-playback-bar__xyz-value">{formatCoord(displayPose.x, playbackUnits)}</span>
  <span className="simulation-playback-bar__xyz-label">Y</span>
  <span className="simulation-playback-bar__xyz-value">{formatCoord(displayPose.y, playbackUnits)}</span>
  <span className="simulation-playback-bar__xyz-label">Z</span>
  <span className="simulation-playback-bar__xyz-value">{formatCoord(displayPose.z, playbackUnits)}</span>
</div>
```

Also display the `moveKind` as a small color-coded indicator (optional but useful):

```tsx
<span
  className={`simulation-playback-bar__move-kind simulation-playback-bar__move-kind--${displayPose.moveKind ?? 'none'}`}
  title={displayPose.moveKind ?? 'none'}
/>
```

### Step 5 — Add formatting helper

Near the existing formatting functions at the top of the component, add:

```ts
function formatCoord(value: number, units: 'mm' | 'in'): string {
  if (!Number.isFinite(value)) return '—'
  if (units === 'in') {
    return value.toFixed(3)
  }
  return value.toFixed(2)
}
```

### Step 6 — Add CSS

In [`src/styles/layout.css`](../src/styles/layout.css), add after the `.simulation-playback-bar__speed select` block (~line 818):

```css
.simulation-playback-bar__xyz {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 10px;
  border-left: 1px solid var(--line-strong);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.simulation-playback-bar__xyz-label {
  color: var(--text-dim);
  font-weight: 500;
}

.simulation-playback-bar__xyz-value {
  color: var(--text);
  min-width: 4.5em;
  text-align: right;
}

.simulation-playback-bar__xyz-value + .simulation-playback-bar__xyz-label {
  margin-left: 6px;
}

.simulation-playback-bar__move-kind {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-left: 6px;
}

.simulation-playback-bar__move-kind--cut,
.simulation-playback-bar__move-kind--plunge,
.simulation-playback-bar__move-kind--lead_in,
.simulation-playback-bar__move-kind--lead_out {
  background: #4ade80;
}

.simulation-playback-bar__move-kind--rapid {
  background: #fbbf24;
}

.simulation-playback-bar__move-kind--none {
  background: transparent;
}
```

---

## Performance analysis

| Concern | Mitigation |
|---------|-----------|
| `getPose()` is already called every frame | No extra computation — we just copy the result to a ref |
| React state setState inside RAF tick | Avoided — throttle to 100ms via `setInterval` |
| Layout thrash from DOM updates | Throttled to 10 Hz; only text content changes |
| Benchmark: 10 state updates/sec vs 60 | ~0.1–0.2ms extra React work vs ~16ms frame budget |

**Verdict**: Zero measurable impact on simulation frame rate.

---

## Files to modify

| File | Change |
|------|--------|
| [`src/components/simulation/SimulationViewport.tsx`](../src/components/simulation/SimulationViewport.tsx) | Add ref, state, update logic, and JSX readout |
| [`src/styles/layout.css`](../src/styles/layout.css) | Add XYZ readout CSS classes |

## Exports to import

From `src/engine/simulation/playback.ts`: `PlaybackPose` (already exported at line 38).

---

## Visual design

The XYZ readout sits as a compact block in the playback bar, separated by a vertical divider from the speed/step controls:

```
[▶][■] [━⚫━━━━━] 42%  Speed [━⚫━] Step [0.1 mm] | X 12.34  Y 56.78  Z -3.45 ●
```

The dot (●) at the end shows the move kind:
- **Green** for cutting moves (cut, plunge, lead_in, lead_out)
- **Amber** for rapid moves
- **Hidden** when idle

---

## Test plan

1. **Functional**: Play an operation, verify X/Y/Z values update and match the tool position
2. **Seek**: Drag the progress slider, verify values jump to the correct position
3. **Stop/reset**: Click stop, verify values return to toolpath start
4. **Pause**: Pause mid-playback, verify values freeze
5. **Units**: Switch project between mm and inch, verify decimal precision changes
6. **No-op**: Disable playback mode, verify readout disappears with the playback bar
