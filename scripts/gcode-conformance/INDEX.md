# INDEX — scripts/gcode-conformance/

- [`README.md`](README.md) — coverage, optional local validators, CI and limitations.
- [`corpus.ts`](corpus.ts) — current G-code and SBP export cases, including two-tool and expanded drilling cases.
- [`run.ts`](run.ts) — export, validator discovery, positive/negative probes and honest verdict reporting.
- [`setup-validators.sh`](setup-validators.sh) — build GRBL and the pinned external FabMo grammar.
- [`fabmo-opensbp/`](fabmo-opensbp/INDEX.md) — Level 1 SBP grammar adapter and mutation tests (#966).
- [`qtplasmac/`](qtplasmac/README.md) — separate LinuxCNC QtPlasmaC simulator check (#954).
- [`grbl-plasma/`](grbl-plasma/README.md) — sequence verdict for the G-code
  pierce path (#983), run by `npm run check:gcode`.
