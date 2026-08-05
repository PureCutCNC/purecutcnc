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

`rs274` has no macOS build and `linuxcnc-uspace` is absent from the Ubuntu
runner's sources, so CI runs it in a **Debian container** as a separate job.
That job is the only place LinuxCNC's *own* rules are applied — elsewhere,
including the `linuxcnc-dialect` case on the GRBL job, the file is judged by
GRBL's rules, which answers a different question. Locally, install
`linuxcnc-uspace` or point `RS274_BIN` at the binary.

Each validator must first accept a trivially valid program. One that rejects
it is misconfigured — wrong flags, missing tool table — not strict, and is
skipped loudly rather than reporting every case as a rejection.

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
