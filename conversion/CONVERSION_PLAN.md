# Rust Conversion Plan — PureCutCNC

This document lays out a step-by-step, low-risk migration strategy to move the project's computation and engine codebase to Rust while preserving the current web-first React UI and Tauri desktop shell.

Status: draft

## Goals
- Reimplement the numerical, geometry, and CAM engine in Rust for safety, performance, and reuse across web (WASM) and desktop (native) builds.
- Keep the existing React UI initially; call into Rust via WASM for the web and via the existing Tauri Rust layer for desktop.
- Maintain .camj compatibility and give a clear migration path for schema changes.

## Scope (what to convert)
- Core geometry primitives and operations (vectors, transforms, boolean CSG where used).
- Toolpath generation and CAM algorithms (vcarve, pocketing, waterline, trochoidal primitives) currently in src/engine and src/geometry.
- Export and simulation backends (G-code export, simulation heightfield generation).
- Diagnostics and probes in scripts/ that are engine-facing.

Not in initial scope:
- React UI components, CSS, i18n, UX flows.
- E2E Playwright tests (retain until engine parity proven).

## High-level approach
1. Implement a Rust `purecut-engine` crate that mirrors the logical boundaries in `src/engine` and `src/geometry`.
2. Add WASM build target for `purecut-engine` exposing a JS-friendly API (wasm-bindgen or wasm-pack). Keep the same JSON surface for interchange where practical.
3. Wire web app to call the WASM module (lazy-load) — minimal changes in UI call sites.
4. Integrate crate into `src-tauri` as a Rust library (Cargo workspace member) and replace any native-engine JS calls with direct function calls or a Tauri command wrapper.
5. Migrate tests: port unit tests to Rust for engine code; keep TS tests for UI.
6. Iterate on parity, benchmarks, and schema migrations; once mature, consider migrating remaining TS modules (postProcessorConverter, import) as needed.

## Phases & milestones
Phase 0 — Preparation (1–2 wks)
- Add `conversion/` and `rust/` workspace scaffolding in repo.
- Create Cargo workspace manifest, initial `purecut-engine` crate, CI WASM build job (GH Actions example).
- Write integration design doc: public API, error model, threading assumptions.

Acceptance: cargo build + wasm-pack build CI step passes; `conversion/CONVERSION_PLAN.md` present.

Phase 1 — Core primitives & serialization (2–4 wks)
- Port numeric types, Vec2/Vec3, affine transforms, bounding boxes, tolerance utilities.
- Implement camj schema serde (serde_json) read/write parity tests; ensure round-trip with existing `.camj` project files.
- Add FFI / wasm-bindgen bindings for these types.

Acceptance: Unit tests proving identical serialization for representative `.camj`; JS shim can load and call a trivial engine function.

Phase 2 — Geometry algorithms (4–8 wks)
- Port geometry algorithms used by features: offsetting, polygon operations (use or wrap a well-tested crate — see choices below), skeleton/medial-axis utilities if applicable.
- Add property-based tests and compare outputs with TS reference implementation for a suite of fixture inputs.

Acceptance: Deterministic bit-for-bit matching for a fixture suite within tolerance budget; performance benchmarks at least comparable.

Phase 3 — Toolpaths & CAM algorithms (6–12 wks)
- Port pocketing, v-carve, waterline, trochoidal passes.
- Simulation (CPU heightfield) port or make a compatibility layer calling TS until parity.
- Implement export (G-code) in Rust or keep existing exporter but validate against Rust-generated toolpaths.

Acceptance: For a set of canonical projects, Rust-generated toolpaths match existing TypeScript output to within numeric tolerance and pass existing simulation checks.

Phase 4 — Integration & CI (2–4 wks)
- Replace JS engine entrypoints with WASM on web; on desktop, call Rust crate from Tauri layer.
- Add cross-platform CI: wasm unit tests, native Rust tests, packaging checks for Tauri.
- Update build scripts (scripts/run-build.ts) to include wasm and native steps.

Acceptance: Production build artifact for web (Vite + wasm) and Tauri native builds succeed in CI.

Phase 5 — Cleanups & optional UI migration (variable)
- Migrate other JS engine-adjacent utilities to Rust where beneficial.
- If desired later, rewrite UI in a Rust-first UI stack (Dioxus, Tauri + Rust UI frameworks) — large separate project.

## Engineering decisions & recommended crate choices (open items)
- Geometry / boolean polygon ops: choose between existing Rust crates (geo, geo-booleanop, lyon for tessellation, clipper via bindings) or wrap a C++ library (Clipper/GPC/CGAL). Decision factors: precision, performance, licensing (Apache 2.0 compatible), and feature parity. Open question: do existing crates match the production polygon robustness needs (self-intersections, arcs)?

- Exact vs floating arithmetic: use f64 for parity with JS number, but consider adaptive robust predicates for topological ops. Open question: do we need exact predicates (robust library) to avoid geometry drift in boolean ops?

- Serialization & schema: keep `.camj` JSON schema stable. Implement compatibility layer in Rust that uses the same keys and units and emits a `compatibility` tag. Open question: should we define a stable cross-language schema crate (e.g., a JSON Schema or Rust/TS shared spec)?

- WASM bindings approach: wasm-bindgen vs wasm-pack vs wasm-bindgen + ts-bindgen. Recommendation: wasm-bindgen with generated TypeScript bindings. Open question: prefer tiny API surface (JSON in/out) vs idiomatic typed bindings (performance vs implementation complexity).

- Multi-threading & Web: WebAssembly threads are limited by browser support and require SharedArrayBuffer. Open question: do we need threaded compute in WASM for performance (and is the target audience using compatible browsers)? If yes, add detection and fallbacks.

- SIMD: consider enabling WASM SIMD for heavy numeric kernels. Open question: do we want to invest in SIMD kernels (cross-browser support)? Start without and add later based on benchmarks.

- Numerical tolerance and coordinate space: keep f64, explicit tolerance constants in a shared module; ensure Y-down vs Y-up conversions preserved per PROJECT.md safety rules.

## Testing strategy
- Side-by-side deterministic fixtures: keep a `conversion/fixtures/` set of `.camj` projects and expected toolpath dumps.
- Unit tests in Rust mirror TS tests for engine logic; property tests for polygon ops and numeric invariants.
- Regression tests: nightly CI that runs engine parity checks between TS and Rust outputs; compare toolpath metrics (segment counts, bounds, exemplar points) within tolerance.
- Performance benchmarks using criterion in Rust; compare to Node-based runs (headless script) on representative workloads.

## CI and build changes
- Add Cargo workspace file, GitHub Actions steps: cargo test, wasm-pack (or wasm-bindgen CLI) build, publish wasm artifact into Vite build.
- Modify Vite config and package.json scripts to include wasm packaging step and a fallback when wasm not available.
- Add Tauri build verifying the Rust crate is linked and used by the desktop shell.

## Migration risks & mitigations
- Geometry robustness regressions — mitigate with heavy fixture set, property tests, and optionally using battle-tested native libraries via FFI.
- API churn causing UI breakage — keep a stable JSON pass-through API and a compatibility shim during migration.
- WASM size and load time — lazy-load engine WASM only when a CAM operation is requested; use gzip/brotli; strip debug symbols and enable LTO.
- Build complexity — keep the TS UI unchanged initially and centralize new Rust CI steps to avoid breaking UI contributors.

## Timeline (coarse)
Total baseline for engine-first migration: 4–6 months for a small team (1–3 engineers) to reach parity and CI coverage; faster with C++ library reuse or bigger team.

## Acceptance criteria (for final delivery)
- The Rust engine can generate toolpaths for canonical projects and match the TS output within defined tolerances.
- WASM builds integrate into the web app and the Tauri crate calls the same Rust library for desktop.
- CI runs Rust unit tests, wasm builds, and Tauri packaging without regressions.
- Documentation updated (planning/ and ARCHITECTURE.md) describing the Rust engine boundary and migration choices.

## Tasks (initial backlog items)
- [ ] Create Cargo workspace and purecut-engine crate (scaffold).
- [ ] Add wasm-bindgen and build pipeline example with a trivial exported function.
- [ ] Port Vec2, Vec3, Transform, Box types + serde for camj.
- [ ] Establish fixtures and parity test harness (TS runner vs Rust runner comparison script).
- [ ] Evaluate polygon/boolean crates and pick strategy (pure-Rust vs bindings to Clipper/CGAL).
- [ ] Port offset/offset-pocket algorithm used by pocketing.
- [ ] Port one simple operation end-to-end (read .camj, compute toolpath, export simple G-code).
- [ ] Update Vite/build steps to bundle WASM and test lazy load.

## Open questions (must be answered before Phase 1 finishes)
1. Geometry library choice: pure Rust crates vs wrapping a C/C++ library. Constraints: license compatibility (Apache 2.0), robustness, arc support. 
2. WASM API style: JSON-in/JSON-out (simple, low friction) or typed bindings (fast, ergonomic)?
3. Threading needs for production: implement single-threaded first or require SharedArrayBuffer and pthreads for WASM? 
4. Should we expose internal structures (Vec2/Transform) to TypeScript or keep an opaque handle + serialization layer? 
5. Compatibility policy for `.camj` versions and migration strategy: version tagging policy and migration tool responsibilities.
6. Performance target: is parity with current Node-based engine acceptable, or do we aim for measurable speedups? (affects SIMD & multi-threading decisions)

## People & owners
- Engineering owner: TBD (assign a maintainer familiar with src/engine).
- Code reviewers: engine authors + TypeScript UI owner.
- Acceptance: product owner listed in PROJECT.md.

## Next steps (what I will do now)
- Create an initial Cargo workspace scaffold and `purecut-engine` crate with a trivial wasm-bindgen export and CI job (follow-up task/PR).


---

Document saved to conversion/CONVERSION_PLAN.md
