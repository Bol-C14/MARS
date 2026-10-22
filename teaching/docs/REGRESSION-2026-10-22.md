# Post-trial regression fixes · 2026-10-22

Base: `313c420765caf981e554b62a2531337e66ab5bf3`, branch `feature/teaching-ide`.
Scope: a small correctness pass on the A/B/C trial changes, not a new teaching model or a completed M3 release. The earlier trial used simulated students; this work does not establish real student learning outcomes.

## Changes

1. **Raw bytes in DEC have one interpretation across views.** Memory cells already showed unsigned decimal (for example, 254), while their tooltip and focus object could show `0d-2`. `kind: "bits"` now formats unsigned decimal, like addresses. Signed operands retain their signed interpretation, including byte sign extension and negative registers. No stored values or execution semantics change.
2. **Grouped memory text preserves NUL.** Previously the readable view removed all zero bytes, so `A\0B\0` appeared as `AB`. It now preserves zeros as JSON escapes (`\u0000`), including trailing zeros. Raw bytes remain visible. A memory buffer is not silently treated as a null-terminated syscall string.
3. **Focus input instructions match the current interaction.** The old “提交后按 ↓ 继续” hint contradicted both automatic input resume and the new browse-only arrow keys. It now says “提交后继续被中断的操作”. No keyboard or input execution behavior changes.
4. **Differential evidence identifies its actual environment.** The report no longer hardcodes Java 25 / macOS arm64. It records the actual OS, architecture and Java version separately from the transport description.

## Regression evidence

Two newly added semantic tests failed on the original implementation before fixes: unsigned raw byte DEC formatting, and preservation of interior/trailing NUL. Both pass after the fixes. The existing grouped-text expectation was updated to preserve the trailing zero. The committed front-end bundle was rebuilt from source.

Validation environment: Linux x86_64, Node 24.19.0, Eclipse Temurin JDK 21.0.13. JDK and package cache were placed outside the repository; no installation or changes on the user's Mac.

Final checks:
- Front-end build: passed.
- Java core integration: 21 scenarios passed.
- Front-end semantic tests: 49 passed.
- Independent upstream output comparison: 18 cases passed.
- Independent upstream step comparison: 518 snapshots passed.
- `git diff --check` and Python syntax compilation: passed.
- Browser acceptance: **not verified in this environment**. The runner skipped browser launch. An explicit attempt with the installed Chromium failed because the executor blocks required local sockets; the elevated launch path also failed before execution. No browser pass is claimed. A focused assertion for the new input hint is included but has not been executed here.

These checks cover machine compatibility and display semantics, not visual quality, keyboard interaction on a live desktop, Windows packaging, long-session memory budgets, or real classroom outcomes. Re-run `sh teaching/scripts/test.sh` in a supported browser-enabled environment before treating browser acceptance as complete.
