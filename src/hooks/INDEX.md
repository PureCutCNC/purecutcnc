# INDEX — src/hooks/

Shared, cross-cutting React hooks. App-generic primitives only — hooks tied to a
single feature live next to that feature (e.g. `sketch/useAxisLock.ts`,
`platform/useFileActions.ts`).

## Files
- `useStableEvent.ts` — `useStableEvent(fn)` returns a stable-identity callback whose body always reflects the latest `fn` (refreshed in `useInsertionEffect`, never during render). Replaces the `ref.current = fn` render-write anti-pattern. Exports the React-free `createStableEvent` core for unit testing.
- `useEventListener.ts` — `useWindowEvent` / `useDocumentEvent` / `useEventListener(ref, …)`: subscribe-once event-listener hooks that route the handler through `useStableEvent`, so listener effects don't re-bind on every render. Pass a **stable** options value (module const / memoized), not a fresh object literal.
- `useRafScheduler.ts` — `useRafScheduler(callback)` returns a **stable** `schedule()` that coalesces repeated calls into one `requestAnimationFrame`, runs the latest `callback` on that frame, and cancels a pending frame on unmount. Replaces ad-hoc `scheduleDraw` closures so the scheduler can be a stable effect dependency. Exports the React-free `createRafScheduler` core for unit testing.
- `usePortalPosition.ts` — `usePortalPosition(anchorRef, floatingRef, open, measure)` positions a portaled tooltip/popover from its anchor's bounding rect, recomputing on scroll/resize while `open`. Derives the **closed → null** case during render (no `setState` in an effect) and only sets state from the DOM measurement; routes `measure` through `useStableEvent`. Exports the React-free `selectPortalCoords` / `nextPortalCoords` cores for unit testing.
- `useLocalStorageState.ts` — `useLocalStorageState(key, default, { codec?, enabled? })`: a `useState`-like hook backed by `localStorage`. SSR-safe (no-window → in-memory), lazy initial read with a parse-error/missing-key fallback to `default`, and best-effort persist-on-change. Pass a custom `codec` for non-JSON on-disk formats and `enabled: false` for an optional/absent key (in-memory only). Exports the React-free `readStoredValue` / `readFromStorage` / `writeToStorage` / `jsonStorageCodec` cores for unit testing.
- `useOutsideDismiss.ts` — `useOutsideDismiss({ open, refs, onDismiss, target? })`: dismiss an open element on a pointer-down outside it **or** on Escape, built on the subscribe-once `useDocumentEvent` / `useWindowEvent`. Accepts one ref or an array (trigger + portaled popover); listeners are inert while closed. `target` ('document' | 'window', default 'document') preserves each call site's original listener target. Exports the React-free `isOutside` / `isDismissKey` cores for unit testing.
- `useStableEvent.test.ts` — unit tests for `createStableEvent` (stable identity, latest-fn dispatch, arg/return forwarding).
- `useRafScheduler.test.ts` — unit tests for `createRafScheduler` (frame coalescing, re-schedule after flush, latest-callback dispatch, cancellation) against a fake `requestAnimationFrame`.
- `usePortalPosition.test.ts` — unit tests for the `selectPortalCoords` (closed → null, open → measured) and `nextPortalCoords` (scroll/resize dedupe) cores.
- `useLocalStorageState.test.ts` — unit tests for the `readStoredValue` / `readFromStorage` / `writeToStorage` / `jsonStorageCodec` cores (existing-value read, parse-error → default, SSR/no-storage path, throwing get/setItem, custom-codec round-trip) against a fake Storage.
- `useOutsideDismiss.test.ts` — unit tests for the `isOutside` (single/multiple containers, null refs/target) and `isDismissKey` (Escape gate) cores.

## Conventions
- Strict TS, no `any`. Generic over the listener's event map so `type` narrows the event.
- The stable wrapper is for event handlers / effects — do not call it during render.
