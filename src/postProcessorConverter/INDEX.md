# INDEX — src/postProcessorConverter/

Standalone CLI (issue #402) that converts external CAM post-processor files
into a PureCutCNC `MachineDefinition` JSON, plus a full conversion report.
Never executes a vendor source file — declarative formats are parsed, and the
three script-like formats (SheetCAM Lua, Autodesk JS, Mastercam GPP) are only
ever pattern-matched as text. See
[`planning/Post_Processor_Converter_Design.md`](../../planning/Post_Processor_Converter_Design.md)
for the report format, supported-field reference, and the CNC-safety
limitation; run `npm run convert-post-processor -- --help` for CLI usage.

## Files

- `types.ts` — `ConversionFinding`/`ConversionReport` (the mapped/omitted/
  unsupported/conflicting ledger), `SourceAdapter`/`AdapterResult` (the
  per-format contract), `MachineDefinitionDraft` (a deep-partial
  `MachineDefinition`)
- `draft.ts` — overlays an adapter's draft onto the bundled Generic
  `MachineDefinition` baseline and validates the result; also supplies the
  conventional RS-274 fallback used when an adapter partially populates a
  nullable group (`cannedCycles`, `coolant`)
- `report.ts` — renders a `ConversionReport` as human-readable text (used by
  the CLI and suitable for a sibling `.report.txt`)
- `convert.ts` — `convertPostProcessor(fileText, filePath, options)`: resolves
  the adapter (explicit `--format` or extension auto-detect), runs it,
  assembles the definition + report. Pure — no filesystem access, so it's
  reusable by something other than the CLI later (e.g. an in-app importer,
  explicitly out of scope for this issue)
- `cli.ts` — the `tsx` entry point (`--input`, `--output`, `--format`,
  `--strict`, `--force`, `--name`, `--vendor`); the only file in this module
  that touches the filesystem or `process.argv`
- `adapters/textFormat.ts` — shared text-scanning primitives for the four
  declarative adapters (line-comment stripping, `KEY = value` assignment
  parsing, `[TOKEN]`-placeholder extraction/translation, leading-literal
  extraction)
- `adapters/index.ts` — the format registry (`ADAPTERS`, `getAdapter`,
  extension-based `detectAdapterByExtension`)
- `adapters/visualMill.ts` — Visual Mill `.spm` (named `SECTION_Key = value`
  assignments + `SECTION_NameStart`/`End` template blocks)
- `adapters/vectricEstlcam.ts` — Vectric/Estlcam `.pp` (`KEY = "value"` +
  `VAR NAME = [...]` + `begin BLOCKNAME` template sections)
- `adapters/artcam.ts` — ArtCAM `.con` (repeated `KEY = "value"` assignment
  records build ordered arrays; no template blocks)
- `adapters/ecam.ts` — ECam `.xml` (a `<ToolMachine><Post>` document shared
  between mill/lathe; parsed with `linkedom`'s `DOMParser` since this module
  runs under Node, not a browser)
- `adapters/sheetcam.ts` — SheetCAM `.scpost` (Lua `On*` callbacks; a
  balanced-block scanner finds each callback's true extent without
  evaluating the Lua)
- `adapters/autodeskCps.ts` — Autodesk HSM/Inventor `.cps` (the standardized
  Autodesk post-processor-engine JS idioms, pattern-matched, never evaluated)
- `adapters/mastercamPst.ts` — Mastercam `.pst` (a flat control-switch
  section plus an `sgXX`/`smXX` string-select table are genuinely static; the
  procedural `p*` postblocks are not resolved and are reported `unsupported`)
- `__fixtures__/<family>/` — real vendor files supplied for this issue (all
  configure the same EdingCNC/USBCNC controller from seven different CAM
  vendors' own post-processor authors), used by both the per-adapter tests
  and `crossFormatAgreement.test.ts`

## Tests

- `adapters/*.test.ts` — one per adapter, against its own fixture(s)
- `crossFormatAgreement.test.ts` — since every fixture targets the same
  physical controller, the core G/M-codes each adapter derives must agree
  after normalizing formatting differences (leading zeros); catches an
  adapter that misreads its own source in a way a single-fixture test can't.
  `motion.arcFormat` is a deliberate, asserted exception: EdingCNC accepts
  both I/J and R arc specification, and ArtCAM/Mastercam's post authors chose
  R while the rest chose I/J for this same controller
- `cli.test.ts` — argument parsing plus end-to-end file I/O (`--force`
  guards, `--strict` refusal) against a real temp directory

## Conventions

- Adapters never execute, `eval`, `Function`, or `require` source content —
  declarative formats are parsed; the three script-like formats are
  pattern-matched as text only (`staticAnalysisOnly: true`)
- Every source setting an adapter considers gets a `ConversionFinding` — a
  silently-dropped field is a bug, not an acceptable gap (the cross-format
  test and individual adapter tests exist partly to catch this)
- `blocksStrict` is a deliberate per-finding judgment call by the adapter
  (would silently dropping this change emitted G-code for a normal 3-axis
  job?), never derived automatically from `status`
- Vendor post-processor files are frequently CRLF; every adapter normalizes
  line endings first (`normalizeLineEndings` in `textFormat.ts`, or a local
  equivalent for the two adapters that don't otherwise use that module)
