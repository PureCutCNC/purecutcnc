# G-code conformance corpus

Exports representative G-code and ShopBot part files and feeds it to **real controller interpreters**
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
per-machine dialects, and a pure-G1 control. SBP cases cover mm/inch, `CG` in
both directions, two-tool changes, expanded peck drilling and the units guard.

## Validators

| validator | what it is | dialects |
|---|---|---|
| `grbl-gvalidate` | GRBL 1.1's own `gcode.c` built for the desktop via [grbl-sim](https://github.com/grbl/grbl-sim) | grbl, grblhal, generic, linuxcnc |
| `fabmo-opensbp` | pinned [FabMo-Engine](https://github.com/FabMo/FabMo-Engine) OpenSBP grammar, built with Peggy 4.0.3 | shopbot (syntax only) |
| `linuxcnc-rs274` | LinuxCNC's standalone RS-274NGC interpreter (`linuxcnc-uspace`) | linuxcnc, generic |

`rs274` has no macOS build and `linuxcnc-uspace` is absent from the Ubuntu
runner's sources, so CI runs it in a **Debian container** as a separate job.
Locally, install `linuxcnc-uspace` or point `RS274_BIN` at the binary.

**`rs274 -g` does check arc geometry, but more loosely than GRBL.** Measured
by sweeping the radius mismatch in a Debian container: it accepts up to
0.028 mm and rejects from 0.029 mm, identically at r = 10, 1 and 0.34 mm — so
the tolerance is absolute and radius-independent, roughly **5.7x looser than
GRBL's 0.005 mm**. Its error text reports both `abs_err` and `rel_err`.

This settles the question left open by #447: **GRBL is the tightest of the
controllers we can test**, so satisfying it satisfies LinuxCNC. The export
invariant in `arcFitting.ts` now rests on a measurement rather than an
assumption. LinuxCNC would *not* have rejected the block that started #447.

## Validator probes

Each validator faces three probes before its verdicts are trusted:

1. **Smoke** — a trivially valid program it must accept. One that rejects this
   is misconfigured (wrong flags, missing tool table), not strict, and is
   skipped loudly rather than reporting every case as a rejection.
2. **Arc-valid twin** — must be accepted.
3. **Arc-invalid** — the issue #447 block as the controller received it, whose
   radii disagree by 0.0106 mm. Must be rejected.

All probes are byte-identical except the G3 target, so the only variable is
arc consistency. Two questions are kept separate, because controllers differ
in *tolerance*, not just in whether they check at all:

| tier | meaning |
|---|---|
| `strict` | rejects the 0.0106 mm mismatch — at least as strict as the exporter's invariant |
| `tolerant` | checks arcs, but accepts it; would not have caught #447 |
| `syntax-only` | accepts a 1 mm error on a 10 mm radius; not judging geometry at all |

Only `strict` validators contribute to the verified count. Collapsing these
into a binary mislabels a genuinely looser controller as one that checks
nothing — which is how `rs274` was first misread here.

Dialect targeting matters: GRBL rejects Mach3/UCCNC output on the `%` wrapper,
`O` program number and `N` line numbers long before reaching an arc, so a
syntax error there would say nothing about arc validity. Cases no available
interpreter can parse are reported as **not validated** rather than passed —
an unchecked case must never read as a verified one.

Mach3 and UCCNC have no offline interpreter: closed-source, Windows-only, and
line-limited demos. They stay a manual pre-release step.

## ShopBot: FabMo OpenSBP syntax

`npm run check:gcode` also feeds eight current `.sbp` exports to FabMo's
unmodified generated grammar. Setup fetches FabMo at
`147325ca628e5b5148880b5fc3542605076935c5` and builds
`runtime/opensbp/sbp_parser.pegjs` with Peggy **4.0.3** (the version in the
upstream `parser.js` instructions). No upstream code is checked in here; it
lives under the ignored validator directory. No FabMo engine installation or
lifecycle scripts run.

The adapter uses the generated parser directly, passing each nonblank,
non-comment line and retaining original line numbers in errors. FabMo's wrapper
uses the same parser, but adds a permissive fast path and an error logger that
loads engine configuration; neither is needed to check our exports.

Before verdicts are trusted, a valid program (including both `CG` directions,
`MS`, tool and spindle macros) must parse, and two deliberately unterminated
quoted arguments, one in `CG` and one in `MS`, must fail. The focused tests also
make those mutations in an actual export and require the adapter CLI to exit 1.
Adapter tests run first in `check:gcode`, even when no validator is installed.

Locally, a missing FabMo validator is reported as unvalidated; with none of the
interpreters installed, the command exports the corpus and says nothing was
verified. An installed but broken FabMo parser fails. CI's Ubuntu conformance
job sets `FABMO_OPEN_SBP_REQUIRED=1`, so absence also fails; the parser shares
the validator cache keyed by `setup-validators.sh`. `GCODE_VALIDATOR_DIR`
selects an alternative validator root containing `fabmo-opensbp/`.

### The sole exception: `MSGBOX`

The ShopBot Programming Handbook documents `MSGBOX`, but this FabMo grammar
does not implement it. Worse, the generic two-character mnemonic rule parses
`MSGBOX(...)` as **`MS` with string arguments**. That is not evidence that the
message works. The adapter excludes only the exact emitted units-error message
(mm or inch), at the end of the `UNIT_ERROR:` footer, after the normal `END`,
with its matching units guard present and a final `END` following it. Every
excluded line is printed as **EXCEPTION**, and boundary tests reject modified
messages and misplaced/duplicated blocks. Exported bytes and the units guard
stay unchanged. This is a FabMo grammar gap, not full FabMo portability.

The tester still needs to confirm whether their SB3/SB4 displays this message
and stops without motion on a units mismatch (question recorded on #966).
The parser check does not replace the real-machine test in #962.

### Level 2 decision and limits

This is **Level 1 syntax only**. The grammar accepts bare strings as arguments;
it does not check numeric argument types, parameter arity, speeds, arc geometry,
macro availability or motion. Changing `MS,10,3` to `MS,banana,3` survives the
upstream grammar; that is outside this check's claim.

At the pinned commit, `SBPRuntime.simulateString` can generate G-code while
disconnected, but importing the runtime still loads engine configuration,
manual/driver modules, and the command loader; `C6`, `C7` and `C9` depend on the
machine's macro files. A full-program trace comparison would need that engine
and machine configuration. Stubbing those would prove a different environment,
so Level 2 is deferred as the approved issue permits. Existing SBP round-trip
unit tests remain the motion check; they are not FabMo runtime verification.

See [`fabmo-opensbp/INDEX.md`](fabmo-opensbp/INDEX.md) for the adapter files.

## Plasma: the QtPlasmaC simulator

Plasma programs are checked separately, by `npm run check:gcode:qtplasmac`
(issue #954). `rs274` cannot run QtPlasmaC's `M190` material select or read
`#<_hal[...]>`, so that check runs LinuxCNC's whole QtPlasmaC simulator
configuration in a container and judges the torch sequence from a trace of the
run. It has its own corpus, runner and workflow, and shares nothing with the
validators above: see [`qtplasmac/README.md`](qtplasmac/README.md).

## Notes

- Output lives in `.gcode-conformance/` (gitignored). `corpus/` is wiped each
  run; `validators/` persists so built binaries survive.
- Tool changes are disabled for the G-code cases: they emit `M0`, a real program
  pause that an interpreter blocks on forever.
- The GRBL arc radius check (`0.005 mm`, `0.5 mm`, `0.1 %` of radius) is
  byte-identical in 0.9j and 1.1h — verified against both sources.
