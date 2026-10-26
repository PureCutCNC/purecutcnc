# Baseline metrics — SolidCraft WP0

Generated: 2026-10-19T20:38:27.507Z
Runtime: Node v22.22.2 on win32/x64

> Timing is Node `JSON.parse` / `JSON.stringify` / `structuredClone`, not a full app load.
> `100-entry history` is `snapshotBytes × 100` — a serialized-size projection, not V8 heap usage.

## Fixtures (19)

| Fixture | File | Features | Definitions | Ops | Tools | Embedded assets | Snapshot | 100-entry history | Parse | Stringify | Clone |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| badge.camj | 68.4 KB | 20 | 19 | 4 | 2 | 0 B | 30.6 KB | 3.0 MB | 0.17 ms | 0.17 ms | 0.45 ms |
| purecutcnc.camj | 19.7 KB | 5 | 5 | 6 | 3 | 0 B | 11.0 KB | 1.1 MB | 0.04 ms | 0.03 ms | 0.09 ms |
| t-style-body.camj | 61.4 KB | 21 | 21 | 6 | 2 | 0 B | 31.2 KB | 3.0 MB | 0.15 ms | 0.17 ms | 0.36 ms |
| v-carve-skeleton-tests.camj | 60.5 KB | 50 | 0 | 12 | 1 | 0 B | 29.5 KB | 2.9 MB | 0.14 ms | 0.09 ms | 0.49 ms |
| 3d-imported-block-test3.camj | 96.1 KB | 2 | 0 | 3 | 1 | 65.8 KB | 92.3 KB | 9.0 MB | 0.04 ms | 0.09 ms | 0.07 ms |
| another-pocket-test.camj | 11.8 KB | 6 | 6 | 1 | 1 | 0 B | 5.7 KB | 566.0 KB | 0.03 ms | 0.02 ms | 0.06 ms |
| entry-helix-dense-islands.camj | 90.5 KB | 35 | 35 | 5 | 1 | 0 B | 57.1 KB | 5.6 MB | 0.29 ms | 0.49 ms | 0.89 ms |
| issue-401-cone-finish.camj | 349.8 KB | 1 | 1 | 2 | 1 | 225.2 KB | 320.5 KB | 31.3 MB | 0.33 ms | 0.86 ms | 0.75 ms |
| model-in-pocket.camj | 60.7 KB | 3 | 0 | 2 | 1 | 39.0 KB | 56.4 KB | 5.5 MB | 0.04 ms | 0.05 ms | 0.08 ms |
| pocket-feed-reduction-2.camj | 8.0 KB | 3 | 3 | 1 | 1 | 0 B | 4.0 KB | 397.5 KB | 0.02 ms | 0.01 ms | 0.08 ms |
| pocket-feed-reduction-3.camj | 9.5 KB | 4 | 4 | 1 | 1 | 0 B | 4.6 KB | 458.3 KB | 0.02 ms | 0.02 ms | 0.05 ms |
| pocket-feed-reduction-parallel-2.camj | 9.0 KB | 4 | 4 | 1 | 1 | 0 B | 4.5 KB | 447.9 KB | 0.02 ms | 0.01 ms | 0.05 ms |
| pocket-feed-reduction-parallel.camj | 7.3 KB | 3 | 3 | 1 | 1 | 0 B | 3.8 KB | 377.1 KB | 0.02 ms | 0.01 ms | 0.04 ms |
| pocket-feed-reduction.camj | 7.3 KB | 3 | 3 | 1 | 1 | 0 B | 3.7 KB | 374.7 KB | 0.01 ms | 0.01 ms | 0.04 ms |
| pocket-finish-island-leftover.camj | 7.0 KB | 2 | 2 | 2 | 2 | 0 B | 4.6 KB | 458.1 KB | 0.02 ms | 0.01 ms | 0.04 ms |
| pocket-rounded-corner-coverage.camj | 17.1 KB | 10 | 10 | 1 | 2 | 0 B | 8.6 KB | 857.0 KB | 0.04 ms | 0.03 ms | 0.08 ms |
| trochoidal-249k.camj | 7.0 KB | 1 | 1 | 1 | 1 | 0 B | 4.0 KB | 400.3 KB | 0.02 ms | 0.01 ms | 0.04 ms |
| trochoidal-raster.camj | 14.8 KB | 18 | 1 | 1 | 1 | 0 B | 8.4 KB | 843.4 KB | 0.03 ms | 0.02 ms | 0.07 ms |
| v-carve-noise-test.camj | 7.6 KB | 3 | 2 | 2 | 1 | 0 B | 4.2 KB | 423.1 KB | 0.02 ms | 0.01 ms | 0.04 ms |

## Command inventory

| Source | Labels | IDs | Activations | Shortcuts | Descriptor types |
| --- | ---: | ---: | ---: | ---: | ---: |
| src/commands/creationShapes.ts | 2 | 2 | 2 | 0 | 4 |
| src/commands/fileCommands.ts | 9 | 9 | 9 | 0 | 0 |
| src/commands/sketchCommands.ts | 3 | 3 | 4 | 0 | 13 |
| src/components/canvas/canvasShortcuts.ts | 1 | 0 | 0 | 1 | 0 |
| **Total** | **15** | **14** | **15** | **1** | **17** |

## Notes

- Fixture sizes come from the checked-in .camj files; duplicate public/dist examples are skipped by scanning distinct roots.
- Embedded asset bytes count decoded base64 strings of at least 256 characters.
- Command inventory is a static count over descriptor sources, not the runtime registry.
