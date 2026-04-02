# Sketch Preview — Browser Degradation Finding

## Symptom

Canvas preview performance is fast after a browser restart but degrades over time. Hard-reloading the page does not help — only a full browser restart restores performance. Tested on Chrome on macOS.

## Root Cause: Most Likely — Canvas Context GPU Eviction

Every time React remounts `SketchCanvas` (hot reload during dev, navigating away and back, etc.), a new `<canvas>` element is created and `getContext('2d')` is called. Chrome maintains a limit on the number of active 2D/WebGL contexts it will keep hardware-accelerated — typically around 16. Once that limit is exceeded, older contexts are evicted from the GPU and fall back to software rendering, which is dramatically slower.

A hard reload clears the JS heap but **not** Chrome's GPU process, which is shared across tabs and survives page reloads. Only a full browser restart clears it.

## Implemented Mitigation

Explicitly release the canvas context when the component unmounts:

```ts
useEffect(() => {
  const canvas = canvasRef.current
  return () => {
    if (canvas) {
      const ctx = canvas.getContext('2d')
      ctx?.reset?.()       // Chrome 99+ — forces GPU resource release
      canvas.width = 0     // Fallback: hints browser to drop the context
      canvas.height = 0
    }
  }
}, [])
```

This mitigation is now implemented in:
- [src/components/canvas/SketchCanvas.tsx](/Users/frankp/Projects/camcam/src/components/canvas/SketchCanvas.tsx)

Current status:
- unmount cleanup now cancels pending RAF
- attempts `ctx.reset()` when available
- zeros `canvas.width` / `canvas.height` as a fallback hint to release resources

This should remain treated as a mitigation, not a confirmed root-cause proof, until the slowdown is reproduced again and compared before/after.

## Other Possibilities to Rule Out

### Event Listener Leaks

If any raw `addEventListener` call is made outside of a `useEffect` with proper cleanup, each remount (especially via Vite HMR in dev) adds another listener without removing the old one. These accumulate across hot reloads. Check for any bare `addEventListener` calls in `SketchCanvas` or its children that lack corresponding cleanup.

### Vite HMR Module-Level State Leaks

If any variable at module scope (outside React) holds references to canvas contexts, RAF handles, or event listeners, HMR will accumulate them — it replaces the module but old closures can stay alive if anything still references them. The `drawFrameRef` RAF handle is safely inside React state so that one is fine. Worth auditing any module-level globals.

## How to Diagnose

Open Chrome DevTools:

- **Memory tab** → take a heap snapshot after fresh start, use app until slow, take another. If canvas contexts are the problem, you'll see a growing count of `HTMLCanvasElement` or `CanvasRenderingContext2D` objects.
- **Performance tab → Event Listeners panel** → look for duplicate listeners on the same element, which would indicate a listener leak.

## Next Steps

- Verify whether the restart-only slowdown still occurs after longer use with the mitigation in place.
- If it still occurs, capture Chrome heap snapshots and listener counts as described above.
- Try reproducing in Firefox and Safari to determine if it's Chrome-specific (GPU process architecture differs per browser).
