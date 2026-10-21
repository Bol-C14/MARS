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

Run `sh teaching/scripts/test.sh` from the repository root. Run `tests/browser_smoke.js` with a Playwright page against the local service. The upstream reference is exported from commit `ac3d34ea65c3b8349c4f6c00306bade9e3fec5c9`, not the modified working tree.

The differential script writes machine-readable results to ignored `teaching/test-results/differential.json`. A short state-and-preview microbenchmark was sub-millisecond p95 on this machine; this measures local JSON-lines transport, not browser paint latency, and is not a release performance guarantee.

## Known scope

No claim is made about full MARS GUI/tool compatibility, all syscall extensions, arbitrary host file access, advanced data-dependency slicing, nonstandard stack unwinding, Windows packaging or educational learning outcomes. The README lists exact supported service and workflow boundaries.
