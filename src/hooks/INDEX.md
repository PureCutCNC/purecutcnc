# INDEX — src/hooks/

Shared, cross-cutting React hooks. App-generic primitives only — hooks tied to a
single feature live next to that feature (e.g. `sketch/useAxisLock.ts`,
`platform/useFileActions.ts`).

## Files
- `useStableEvent.ts` — `useStableEvent(fn)` returns a stable-identity callback whose body always reflects the latest `fn` (refreshed in `useInsertionEffect`, never during render). Replaces the `ref.current = fn` render-write anti-pattern. Exports the React-free `createStableEvent` core for unit testing.
- `useEventListener.ts` — `useWindowEvent` / `useDocumentEvent` / `useEventListener(ref, …)`: subscribe-once event-listener hooks that route the handler through `useStableEvent`, so listener effects don't re-bind on every render. Pass a **stable** options value (module const / memoized), not a fresh object literal.
- `useRafScheduler.ts` — `useRafScheduler(callback)` returns a **stable** `schedule()` that coalesces repeated calls into one `requestAnimationFrame`, runs the latest `callback` on that frame, and cancels a pending frame on unmount. Replaces ad-hoc `scheduleDraw` closures so the scheduler can be a stable effect dependency. Exports the React-free `createRafScheduler` core for unit testing.
- `usePortalPosition.ts` — `usePortalPosition(anchorRef, floatingRef, open, measure)` positions a portaled tooltip/popover from its anchor's bounding rect, recomputing on scroll/resize while `open`. Derives the **closed → null** case during render (no `setState` in an effect) and only sets state from the DOM measurement; routes `measure` through `useStableEvent`. Exports the React-free `selectPortalCoords` / `nextPortalCoords` cores for unit testing.
- `useStableEvent.test.ts` — unit tests for `createStableEvent` (stable identity, latest-fn dispatch, arg/return forwarding).
- `useRafScheduler.test.ts` — unit tests for `createRafScheduler` (frame coalescing, re-schedule after flush, latest-callback dispatch, cancellation) against a fake `requestAnimationFrame`.
- `usePortalPosition.test.ts` — unit tests for the `selectPortalCoords` (closed → null, open → measured) and `nextPortalCoords` (scroll/resize dedupe) cores.

## Conventions
- Strict TS, no `any`. Generic over the listener's event map so `type` narrows the event.
- The stable wrapper is for event handlers / effects — do not call it during render.
