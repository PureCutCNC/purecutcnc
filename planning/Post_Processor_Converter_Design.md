---
status: current
authoritative-for: the post-processor converter CLI's conversion report contract, supported source formats, and safety/review workflow
last-verified: 2026-07-30
---

# Post-Processor Converter Design

## Purpose

`src/postProcessorConverter/` is a standalone CLI (issue #402) that converts
an external CAM post-processor file into a PureCutCNC `MachineDefinition`
JSON — the same schema documented in
[`G-code_Export_Design.md`](G-code_Export_Design.md) — **only when the
source's relevant behavior can be represented exactly**. It never runs a
vendor post: declarative formats are parsed field-by-field, and the three
script-like formats are only ever pattern-matched as text.

This tool does not claim G-code equivalence or machining safety. Its output
is a starting point for review in the app's advanced machine-definition
editor, not an activated definition. See the CNC safety contract below.

## Architecture

```text
vendor post file (.spm/.pp/.con/.xml/.scpost/.cps/.pst)
        |
        v
format auto-detection (file extension) or an explicit --format
        |
        v
one SourceAdapter.convert() -> { overrides, findings, notes }
        |
        v
buildMachineDefinition(): overrides overlaid onto the bundled Generic
baseline (src/engine/gcode/definitions/generic.json), then Zod-validated
        |
        v
MachineDefinition JSON + ConversionReport, both written to disk
```

`src/postProcessorConverter/convert.ts` (`convertPostProcessor`) is pure —
no filesystem access — so the conversion logic is reusable outside the CLI
later if needed; only `cli.ts` touches `process.argv`/the filesystem. See
[`src/postProcessorConverter/INDEX.md`](../src/postProcessorConverter/INDEX.md)
for the file-by-file breakdown.

## Supported source formats

| Source family | Extension | Adapter strategy |
| --- | --- | --- |
| Visual Mill | `.spm` | Declarative: `SECTION_Key = value` assignments + named template blocks |
| Vectric / Estlcam | `.pp` | Declarative: `KEY = "value"` + `VAR` declarations + `begin BLOCKNAME` template sections |
| ArtCAM | `.con` | Declarative: repeated `KEY = "value"` assignment records |
| ECam | `.xml` | Declarative: a structured `<ToolMachine><Post>` XML document |
| SheetCAM | `.scpost` | Static extractor: recognizes standard `On*` Lua callbacks; never runs Lua |
| Autodesk HSM / Inventor | `.cps` | Static extractor: recognizes the standardized Autodesk post-kernel JS idioms; never runs JavaScript |
| Mastercam | `.pst` | Static extractor: reads the flat control-switch section and string-select table; the procedural postblocks are not resolved |

The four declarative adapters typically produce a fully (or near-fully)
`--strict`-safe conversion for a 3-axis mill source. The three static
extractors are expected to leave more fields `unsupported`/`omitted` —
that's the correct, honest outcome for formats whose actual G-code emission
lives behind real control flow this tool deliberately does not evaluate, not
a bug to fix by guessing harder. Mastercam in particular resolves motion
codes via an `sgXX`/`smXX` string-select table when present, but its
toolchange sequence is genuine procedural logic and is always reported
`unsupported`.

`src/postProcessorConverter/crossFormatAgreement.test.ts` converts every
adapter's fixture (all seven describe the same physical EdingCNC/USBCNC
controller, supplied by seven different CAM vendors' own post authors) and
asserts the core G/M-codes agree after normalizing formatting — catching an
adapter that misreads its own source in a way a single-fixture test can't.

## The conversion report

Every conversion produces a `ConversionReport` (`src/postProcessorConverter/types.ts`)
alongside the `MachineDefinition`. It exists so nothing is silently dropped:
every source setting an adapter considers becomes one `ConversionFinding`:

- `status` — `mapped` (carried over), `omitted` (the source doesn't declare
  this concept; PureCutCNC's generic default was kept), `unsupported` (the
  source declares behavior with no PureCutCNC equivalent), or `conflicting`
  (the source's own signals disagree, or PureCutCNC's schema can't
  distinguish a nuance the source has)
- `sourceField` / `sourceLocation` — what in the source justifies this
  finding, with a line number where practical
- `targetField` — the dot-path into `MachineDefinition`, when applicable
- `blocksStrict` — a **deliberate per-finding judgment call by the adapter**,
  not derived from `status`: would silently dropping this change the emitted
  G-code for a normal 3-axis job? An unused vendor capability or a
  formatting nuance the schema can't distinguish stays `false` even when
  `status` is `unsupported`/`conflicting`

`isStrictSafe(report)` is `true` iff no finding has `blocksStrict: true`.

## Review / import workflow

1. Run the CLI (`npm run convert-post-processor -- --input <file> --output <file>.json`).
   It always writes `<output>.report.json` and prints a human-readable report
   to stdout, whether or not the definition itself was written.
2. Read the report. `[UNSUPPORTED]`/`[CONFLICTING]` findings marked
   `[blocks --strict]` are the ones that materially affect emitted G-code;
   everything else is informational.
3. Open the output JSON in the app's **advanced machine-definition editor**
   (`src/components/machine/`) to review and, if needed, correct fields
   before selecting the machine for a real job. In-app file import is out of
   scope for this CLI (a later concern, per the issue).
4. Pass `--strict` to make the CLI itself refuse to write the definition
   when any finding would change emitted 3-axis behavior — useful in a
   pipeline where a human won't read the report before the file is used.

## CNC safety contract

This tool inherits `PROJECT.md`'s CNC safety contract in full:

- Never invents feeds, spindle speeds, tool limits, or controller
  capabilities — a field it cannot confidently derive is reported
  `omitted`/`unsupported`, not guessed.
- Never executes, `eval`s, or `require`s a vendor source file's own
  scripting/expression language (Lua, JavaScript, or Mastercam's GPP/MP
  language) — see each static extractor's `staticAnalysisOnly: true` and
  the "never execute" note in its own findings.
- The operator remains responsible for reviewing the converted definition
  and the G-code it subsequently produces before running it on a machine.
  A `--strict`-safe conversion is not a machining-safety guarantee.

## Out of scope

4-axis/5-axis, lathe/turning, plasma/THC, probing, macros, custom
kinematics, and non-XY motion planes — PureCutCNC's `MachineDefinition` is a
fixed 3-axis mill model with no fields for any of these. Sources that
configure them (e.g. the ECam/Autodesk/SheetCAM lathe and plasma fixtures)
are detected and flagged, not silently partially converted.

## Verification

`src/postProcessorConverter/adapters/*.test.ts` (one per adapter, against
real supplied vendor fixtures under `__fixtures__/`), plus
`crossFormatAgreement.test.ts` and `cli.test.ts` (argument parsing and
end-to-end file I/O, including the `--force`/`--strict` guards). `npm run
build` runs all of them as part of `npm test`.
