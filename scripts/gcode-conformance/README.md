# G-code conformance corpus

Exports representative G-code and feeds it to **real controller interpreters**
(issue #450).

The unit tests in `src/engine/gcode/` re-derive controller rules in TypeScript.
That verifies our *belief* about the rules. These binaries are the rules — a
rejection here is the firmware's verdict, not a second opinion.

## Running

```bash
./scripts/gcode-conformance/setup-validators.sh   # once
npm run check:gcode
```

Validators are optional. With none installed the corpus is still exported and
the command succeeds, saying plainly that nothing was verified.

## What it validates

`corpus.ts` defines the cases; each states what it covers. They target the ways
arc output has actually broken: small-radius fitted arcs (the issue #447
failure), full circles, the 90° split boundary, inch output, the R dialect,
per-machine dialects, and a pure-G1 control.

## Validators

| validator | what it is | dialects |
|---|---|---|
| `grbl-gvalidate` | GRBL 1.1's own `gcode.c` built for the desktop via [grbl-sim](https://github.com/grbl/grbl-sim) | grbl, grblhal, generic, linuxcnc |
| `linuxcnc-rs274` | LinuxCNC's standalone RS-274NGC interpreter (`linuxcnc-uspace`) | linuxcnc, generic |

`rs274` is **not currently running anywhere**: it has no macOS build, and
`linuxcnc-uspace` is a Debian package absent from the Ubuntu CI runner's
sources. Reaching it needs LinuxCNC's own apt repo or a Debian container.
Until then, whether LinuxCNC's arc radius tolerance is stricter than GRBL's
remains unverified — the exporter assumes it is not (see `arcFitting.ts`).

Dialect targeting matters: GRBL rejects Mach3/UCCNC output on the `%` wrapper,
`O` program number and `N` line numbers long before reaching an arc, so a
syntax error there would say nothing about arc validity. Cases no available
interpreter can parse are reported as **not validated** rather than passed —
an unchecked case must never read as a verified one.

Mach3 and UCCNC have no offline interpreter: closed-source, Windows-only, and
line-limited demos. They stay a manual pre-release step.

## Notes

- Output lives in `.gcode-conformance/` (gitignored). `corpus/` is wiped each
  run; `validators/` persists so built binaries survive.
- Tool changes are disabled when exporting: they emit `M0`, a real program
  pause that an interpreter blocks on forever.
- The GRBL arc radius check (`0.005 mm`, `0.5 mm`, `0.1 %` of radius) is
  byte-identical in 0.9j and 1.1h — verified against both sources.
