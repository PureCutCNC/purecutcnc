# #1103 slice ca-h: thread passes go forward; rotary operations end at 0 up

Plan change approved by Frank on 2026-11-04 (comment on #1103; it replaces #1091's "no closing turn" with a forward-only turn). Three parts, all gcode/toolpath engine; no UI beyond one export-dialog message and one machine template line.

## 1. Thread (and flute) passes never rewind A
A Thread canned shape is cut by **Follow line** on an Around (wrapped) feature: the flat toolpath is mapped onto the bar by `wrapToolpath` / `wrapPoint` (`src/engine/aroundFrame.ts`). Today every depth pass (and every start) begins at its line's own start angle, so the lifted return between passes rewinds A by the whole thread's turns. Change: for wrapped Follow-line toolpaths, the lifted return to the next pass's start uses the **forward-equivalent** angle (start angle + whole turns, the smallest one at or ahead of the A the previous pass ended at). The thread phase is unchanged (only whole turns are added), so every pass drops into the same groove. Cuts themselves keep their shape; only A offsets by whole turns. Other wrapped operations (pocket, profile, engrave on Around features) stay byte-identical unless the same open-line rule applies to them; list any you change and why.

## 2. A rotary operation ends facing 0 up, turning forward
After an operation that commands A, its final retract is followed (at the same clearance rules the opening turn already uses: machine-coordinate safe Z, #1054) by a forward-only turn to the next whole turn (`360 * ceil(lastA / 360)`; no move when already on one). Then a program comment: `A is at <value> (0 up). Zero A before the next operation.` (translated through the existing gcode comment path, if comments are localised). Applies to around-the-bar, along, wrapped and Top/Bottom bar programs alike. A borrowed-motor machine turns its borrowed axis the same way.

## 3. Zeroing A: a machine template line, or a pause
- New optional machine template line **"Zero A"** (e.g. `G10 L20 P1 A0` on GRBL/grblHAL/LinuxCNC). Empty on every bundled machine and by default. Validate it with the template rules like the other lines: it must set the A zero and must not move any axis; a moving line is refused with a clear warning.
- **Filled:** every rotary operation opens with that line (after its opening clearance retract, before its first turn), so it starts reading A0 wherever the bar is.
- **Empty:** between two rotary operations in one program, after part 2's end turn, write `M0` with the comment `Zero A at 0 up, then resume.` (use the machine's stop/pause template if it has one; ShopBot's part-file equivalent). No pause after the last rotary operation.
- Export dialog: when the program contains a rotary operation and "Zero A" is empty, show one line: start with A zeroed at 0 up; the program ends at 0 up and pauses between rotary operations for you to zero A. Locale keys in every shipped language (en, de, fr, es).
- Machine format: the new template field is persisted. Follow the repo's format rules for a new machine field (bump/migrate only if the rules require it; a missing field reads as empty). Say what you did and why.

## Tests that must bite
- Thread with 3 depth passes on an Around feature: no A decrease between passes; each pass's start angle ≡ the original start mod 360; swept reference (ca-a) finds no gouge. Mutation: restore the plain start angle → caught.
- End turn: ends on a multiple of 360, never below the last A, at clearance; already-on-a-turn emits nothing. Mutations: turn backward (rewind to 0); turn before the retract → caught.
- Zero A filled: line emitted once at the start of each rotary operation; a moving template line is refused. Empty: `M0` between two rotary operations, none after the last. Mutations: drop the M0; emit Zero A before the clearance retract → caught.
- `npm run check:gcode` on all machines; along mode and non-rotary programs byte-identical (date normalised), except the new end turn/comment for rotary programs.

## Rules (every slice)

- Approved plan: the plan comment on issue #1103 and Frank's approval comment (helix for uninterrupted full rings; forward-only arcs with safe gaps on square blanks and partial rings; keep constant-A links only where their exact conditions still hold; along-the-bar mode unchanged). Read both whole. Its line numbers refer to an older commit; `rotaryModel.ts` has changed since (#1115 split sampling into modules, #1117 added at-layer rough links), so find `generateRotaryFinish`, `generateRotaryRough`, `emitRotaryRuns`, `linkRowAt`, `linkAtLayer` and `linkAcrossAngle` by name.
- Baselines are the post-#1117 output of this branch's base (integration/0.6.0 at 6498aaf5), not older numbers.
- Any path this slice does not touch stays **byte-identical** (moves and posted G-code, normalising only the date).
- Commanded A is never wrapped modulo 360 inside an operation and never rewinds; the only closing motion is part 2's forward turn to 0 up.
- No new setting. The only UI is the export-dialog line; the only machine-format change is the "Zero A" template field.
- Fixtures: `../feat-issue-1103-continuous-a/work/` holds busto-round-stock.camj, busto-rect-stock.camj, square-to-round-test-01.camj the probes `rl-e-probe.ts` and `helix-probe.ts` (usage: `npx tsx work/rl-e-probe.ts <fixture> <op> [warmRuns] [around|along]`; ops: busto-round op0025, busto-rect op0021, square-to-round op0028). Copy them into this worktree's ignored `work/`; never commit them.
- **One heavy process at a time** (no benchmark or probe beside a test pool). Measured numbers only, saying which you measured.
- Report: changes per file; tests added; each mutation and whether it was caught; commands with exit codes; RISKS.
