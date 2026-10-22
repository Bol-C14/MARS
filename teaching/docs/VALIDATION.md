# M2.5 validation — 2026-10-22

Environment: macOS arm64, OpenJDK 25, system Chrome 155 driven by Python Playwright 1.49. All checks below are run by `sh teaching/scripts/test.sh`.

| Gate | Evidence |
| --- | --- |
| Lookahead is exact and side-effect free | On array-sum, hexOut and Task1 with delayed branching off and on, the state before and after every lookahead is identical (registers, memory, output, input cursor, file handles, status), and every predicted event equals the event the following real step produces |
| Lookahead boundaries | Stops at input waits without consuming input; pseudo-instructions form one line; window size, 64-instruction limit and "ended" have explicit stop reasons |
| Source-line history and breakpoint options | Line seek back/forward; hit count N pauses before the Nth execution and stays correct after rewinding; logpoints format `{$reg}` / `{$reg:x}` and never pause |
| Core integration | 20 scenarios pass |
| Upstream compatibility (unchanged) | 18 output cases and 518 step snapshots against the unmodified upstream probe |
| Path layout | 8 tests: segments per visited block, loop iterations, edge kinds (fallthrough, taken, jump, call, return), single untaken hints, unconditional `b`, delayed branches, auto range |
| Fill-in explanations | 11 tests plus a run over all 1022 events of the three examples (21 instruction kinds, no fallbacks) |
| Keymap and quick open | 5 keymap tests (both platforms, chord, retired-key hints) and 4 quick-open tests (ranking, outline, prefixes) |
| Browser workflow | 35 checks with real key and mouse events and no page errors: earlier M1/M2 workflow, inline values, VS Code debug keys and hints, quick open and outline, Peek references, context menu, logpoint with hit count, focus mode entry by chord, beats, ↑/↓, Tab, Enter, Esc, holding ↓ (throttled, no animation backlog, narration resumes), reduced motion (conclusion shown, nothing moves), edit invalidation |

Lookahead cost on Task1: single-step request p95 1.0 ms without lookahead, 1.5 ms with an 8-line lookahead (local JSON-lines transport; not browser paint time).

Not covered: OS-level key auto-repeat is simulated with repeat-flagged key events; in the Claude desktop browser pane, Ctrl+- is taken by the host before the page sees it (verified with synthetic events instead). Classroom outcomes, Windows and packaging remain M3.

# M0–M2 validation — 2026-10-21

Environment: macOS arm64, OpenJDK 25; Java sources target release 17. Browser smoke checks ran at 1440×1000 and 1280×850. This is a local implementation milestone; cross-platform installers and classroom outcome validation remain M3.

## Completed gates

| Gate | Evidence |
| --- | --- |
| M0 real headless execution | Original `Simulator` through JSON-lines and loopback HTTP |
| Read/write event correctness | Same-value register and memory writes, register reads, memory reads, byte-width watches |
| Safe preview and reversal | Repeated preview leaves state unchanged; input waits; write and file-cursor rollback |
| Core correctness | 15 integration test scenarios pass |
| Upstream output compatibility | 18 cases: hexOut, array sum, Task1; delay off/on; missing/empty/NUL/4095/4096-byte inputs |
| Upstream step compatibility | 518 snapshots compare PC, 32 GPRs, data bytes, stack bytes and output against an independent unmodified-upstream probe |
| M1 working interface | Editing, assembly diagnostics, file navigation, value inspection, execution cards, register/memory views and actual/preview overlays |
| M2 structured debugging | Source/pseudo steps, interior pseudo breakpoint, conditions, read/write watchpoints, cross-file over/out, CFG and loop iterations |
| Frontend semantic checks | 4 tests covering aliases, read/write classification, delay-slot blocks and unknown indirect targets |
| Browser workflow | 16 interaction checks pass with no page errors or unhandled rejections |

## Browser checks

The checked workflow includes command search, integer input, output, backstep, references, multi-file loading, an actual-instruction breakpoint, load-byte execution, independent solid/dashed toggles, scaled overlay coordinates, CFG, loop history, read watchpoint, theme, edit invalidation and reassembly.

Screenshots were reviewed internally for code visibility, register and memory anchoring, and the two overlay layers. These screenshots are not part of the distributed project.

## Reproduction

Run `sh teaching/scripts/test.sh` from the repository root. Browser checks now run through `tests/browser_acceptance.py` (see above). The upstream reference is exported from commit `ac3d34ea65c3b8349c4f6c00306bade9e3fec5c9`, not the modified working tree.

The differential script writes machine-readable results to ignored `teaching/test-results/differential.json`. A short state-and-preview microbenchmark was sub-millisecond p95 on this machine; this measures local JSON-lines transport, not browser paint latency, and is not a release performance guarantee.

## Known scope

No claim is made about full MARS GUI/tool compatibility, all syscall extensions, arbitrary host file access, advanced data-dependency slicing, nonstandard stack unwinding, Windows packaging or educational learning outcomes. The README lists exact supported service and workflow boundaries.
