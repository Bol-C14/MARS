# M0–M2 architecture decisions

## Baseline and execution

Upstream: `dpetersanderson/MARS`, commit `ac3d34ea65c3b8349c4f6c00306bade9e3fec5c9`.

The teaching session calls `MIPSprogram.simulateStepAtPC(null)`. Assembly, pseudo-instruction expansion, integer/FP instruction semantics, address calculation, delay slots and exception handling remain in the MARS core. The adapter restricts services with uncontrolled external side effects.

Four upstream source files contain small hooks:

- `Register.java`: read and write records, including writes of unchanged values.
- `Memory.java`: reads and writes with previous value and width.
- `DelayedBranch.java`: exact checkpoint/restore for pending control transfer.
- `SystemIO.java`: optional session-owned I/O backend. With no backend installed, the original implementation is used.

Trace capture uses an `InheritableThreadLocal` only during simulator execution. Inspection, memory display and snapshot restoration do not create fake program accesses. Preview executes through the same simulator, then reverses ordered memory writes and restores the complete machine/control/I/O checkpoint. There is no JavaScript MIPS interpreter.

## Components

| Component | Responsibility |
| --- | --- |
| `DebugSession` | Assemble project, serialize commands, run/step/break/watch, expose versioned state and derived program metadata |
| `MachineState` | GPR/HI/LO/PC, CP0/CP1/condition flags, heap, delayed branch, exit and virtual I/O checkpoint |
| `TraceHistory` | Bounded branchable history, cursor and seek application |
| `TraceHooks` | Capture instruction-origin register and memory accesses |
| `VirtualIO` | Copy-on-write file bytes, descriptors, cursors, input queue and output |
| `Server` / `Stdio` | Loopback HTTP and JSON-lines transports |
| `ui/main.js` | CodeMirror workspace, inspection and debugging interactions |
| `ui/model.js` | Display values, register conventions, conservative static references and CFG blocks |
| `ui/overlay.js` | Actual/preview relations mapped to live DOM/CodeMirror coordinates |

The API returns `protocol`, `sessionId`, `programVersion`, and `stateVersion`. Mutation commands carry program version, preventing execution of a stale assembled program. The current service intentionally owns a single machine and serializes requests. Multiple independent users require separate processes.

## Event and state contract

An event includes step, PC before/after, expanded instruction and source location, ordered read/write accesses, output delta, pending branch before/after, service number and execution outcome. Writes include both old and new values even if equal. Memory records contain address and byte width.

The UI is paused at post-step state S_n. Actual overlay = event E_n. Preview = execution of the following instruction from S_n. Input services return a waiting preview without consuming the queue. Unsupported services stay explicit. Rewinding updates memory, registers, I/O and all derived views together; stepping after rewind truncates the future branch.

## M0 decisions

- Keep Java and the original simulator; no runtime transpilation or rewritten interpreter.
- Use locally bundled CodeMirror with an HTTP workspace; packaging into a native shell remains M3.
- Default memory layout, extended assembler enabled, self-modifying code disabled; delay slots are a visible project option.
- Virtualize I/O rather than attempting to undo external filesystem writes.
- Preserve precise machine steps; source stepping groups adjacent expanded instructions but respects interior breakpoints and exceptions.
- Static CFG and reference classifications are navigational aids. Actual execution events remain authoritative.

## Deferred boundaries

The adapter is a tested M0–M2 implementation. M3 owns installer packaging, independent sessions, persisted histories, arbitrary layouts, lesson bundles, broader runtime services and long-session performance validation. `DebugSession` and the workspace controller can be split further as those capabilities grow; the upstream changes remain isolated.

## 部署入口（2026-11-08）

个人：`Server.java` 提供本机静态文件与单个 DebugSession，CheckerClient 启动独立检查进程。
教师：Caddy 提供页面与 HTTPS，`teaching/hosting/gateway.py` 按 Cookie 分配独立 Stdio JVM，检查请求进入另一 JVM。Compose 内部执行网络隔离于公网；生产网关与通用部署配置已归入主仓库。
工程草稿保存在浏览器，服务端保存执行状态。完整入口与数据生命周期见 [DEPLOYMENT.md](DEPLOYMENT.md)。

## 浏览器内核部署（TeaVM）

`ui/runtime.js` 在构建时选择 HTTP 或独立 Worker。静态版把同一 MARS Java 核心编译为 JavaScript；调试与检查各自拥有一个 Worker 内的全局状态。平台适配从原 Simulator 提取真实执行循环，并用协程在长命令中让出事件循环。完整构建、平台差异、文件生命周期与验证命令见 [BROWSER-RUNTIME.md](BROWSER-RUNTIME.md)。
