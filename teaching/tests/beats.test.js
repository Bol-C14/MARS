import test from "node:test";
import assert from "node:assert/strict";
import { beatModel, completeWhys, groupBytes, lineSummary } from "../ui/beats.js";

const r = (number, name, value) => ({ kind: "register", number, name, value, before: value, write: false });
const w = (number, name, before, value) => ({ kind: "register", number, name, before, value, write: true });
const m = (address, width, value, write = false, before = value) => ({ kind: "memory", address, width, value, before, write });
const I = (op, binary, extra = {}) => ({ op, binary, address: 0x400000, file: "main.s", line: 3, flow: "next", ...extra });
const step = (instruction, accesses, extra = {}) => ({ instruction, accesses, nextPC: 0x400004, status: "paused", ...extra });
const R = (op, rs = 0, rt = 0, rd = 0, sa = 0, funct = 0) => (op << 26) | (rs << 21) | (rt << 16) | (rd << 11) | (sa << 6) | funct;
const plain = (parts) => parts.map((p) => (typeof p === "string" ? p : p.t)).join("");
const lines = (model) => model.beats.map((b) => plain(b.eq));

test("each beat substitutes exactly what was recorded, starting from the symbolic template", () => {
  const e = step(I("addu", R(0, 8, 9, 10, 0, 33)), [r(8, "$t0", 7), r(9, "$t1", 5), w(10, "$t2", 0, 12)]);
  const before = JSON.stringify(e), b = beatModel(e);
  assert.equal(plain(b.template), "$t2 ← $t0 + $t1");
  assert.deepEqual(lines(b), ["$t2 ← 7 + 5", "$t2 ← 12", "$t2 = 12 ✓"]);
  assert.deepEqual(b.beats[0].tokens.map((t) => [t.from, t.to]), [["reg:$t0", "code"], ["reg:$t1", "code"]]);
  assert.deepEqual(b.beats[2].tokens.map((t) => [t.from, t.to, t.kind]), [["code", "reg:$t2", "write"]]);
  assert.equal(b.summary, "$t2 = 12");
  assert.deepEqual(b.objects.map((o) => [o.id, o.before, o.after, o.write]), [["reg:$t0", 7, 7, false], ["reg:$t1", 5, 5, false], ["reg:$t2", 0, 12, true]]);
  assert.equal(JSON.stringify(e), before);
});

test("lb sign-extends with its own beat; lh shows little-endian composition", () => {
  const lb = beatModel(step(I("lb", R(32, 5, 10) | 0), [r(5, "$a1", 0x10010010), m(0x10010010, 1, 0xf0), w(10, "$t2", 0, -16)]));
  assert.deepEqual(lines(lb), ["$t2 ← 字节[ 0x10010010 ]", "$t2 ← 0xf0", "$t2 ← -16", "$t2 = -16 ✓"]);
  assert.match(lb.beats[2].caption, /最高位是 1，补 1/);
  assert.match(lb.beats[2].why, /lbu 则补 0，得到 240/);
  const lh = beatModel(step(I("lh", R(33, 4, 8) | 2), [r(4, "$a0", 0x100), m(0x102, 2, 0x1234), w(8, "$t0", 0, 0x1234)]));
  assert.deepEqual(lines(lh).slice(0, 2), ["$t0 ← 半字[ 0x00000100 + 2 ]", "$t0 ← 半字[ 0x00000102 ]"]);
  assert.match(lh.beats[2].why, /\[0x00000102\] 0x34 \[0x00000103\] 0x12 → 0x1234/);
});

test("negative offsets read as subtraction and the address beat shows the sum", () => {
  const b = beatModel(step(I("lw", R(35, 29, 8) | 0xfffc), [r(29, "$sp", 100), m(96, 4, 42), w(8, "$t0", 0, 42)]));
  assert.equal(plain(b.template), "$t0 ← 内存[ $sp − 4 ]");
  assert.match(b.beats[1].why, /\(-4\) = 0x00000060/);
});

test("mult reports the 64-bit product; div by zero says the result is undefined", () => {
  const mult = beatModel(step(I("mult", R(0, 8, 9, 0, 0, 24)), [r(8, "$t0", -2), r(9, "$t1", 3), w(33, "hi", 0, -1), w(34, "lo", 0, -6)]));
  assert.deepEqual(lines(mult), ["HI:LO ← -2 × 3", "HI:LO ← 0xfffffffffffffffa", "HI = -1，LO = -6 ✓"]);
  const div = beatModel(step(I("div", R(0, 8, 9, 0, 0, 26)), [r(8, "$t0", 7), r(9, "$t1", 0), w(33, "hi", 0, 0), w(34, "lo", 0, 0)]));
  assert.deepEqual(lines(div), ["LO, HI ← 7 ÷ 0", "除数为 0"]);
});

test("logic and shifts show bit patterns; variable shifts use the low 5 bits", () => {
  const nor = beatModel(step(I("nor", R(0, 8, 9, 10, 0, 39)), [r(8, "$t0", 0), r(9, "$t1", 0xff), w(10, "$t2", 0, ~0xff)]));
  assert.equal(lines(nor)[0], "$t2 ← ~(0x00000000 | 0x000000ff)");
  const sllv = beatModel(step(I("sllv", R(0, 9, 8, 10, 0, 4)), [r(9, "$t1", 33), r(8, "$t0", 1), w(10, "$t2", 0, 2)]));
  assert.equal(lines(sllv)[0], "$t2 ← 0x00000001 << 1");
  assert.match(sllv.beats[1].why, /33，低 5 位为 1/);
  const andi = beatModel(step(I("andi", R(12, 8, 9) | 0xff00), [r(8, "$t0", -1), w(9, "$t1", 0, 0xff00)]));
  assert.equal(plain(andi.template), "$t1 ← $t0 & 0x0000ff00");
});

test("writes to $zero are shown as discarded", () => {
  const b = beatModel(step(I("addiu", R(9, 8, 0) | 5), [r(8, "$t0", 1)]));
  assert.equal(lines(b).at(-1), "$zero = 0 ✓");
  assert.match(b.beats.at(-1).caption, /被丢弃/);
});

test("movz explains a false condition without inventing a write", () => {
  const b = beatModel(step(I("movz", R(0, 8, 9, 10, 0, 10)), [r(8, "$t0", 5), r(9, "$t1", 1)]));
  assert.deepEqual(lines(b), ["若 1 == 0：$t2 ← 5", "不成立 → 不写入"]);
});

test("branches decide from operands and name the destination", () => {
  const program = { instructions: [{ address: 0x400004, line: 4 }, { address: 0x400010, line: 7 }], symbols: [{ name: "done", address: 0x400010 }] };
  const bne = beatModel(step(I("bne", R(5, 8, 9) | 3, { flow: "branch", target: 0x400010 }), [r(8, "$t0", 7), r(9, "$t1", 5)], { nextPC: 0x400010 }), program);
  assert.deepEqual(lines(bne), ["若 7 ≠ 5 → 跳到 done", "成立 → 跳到 done", "下一条 = done ✓"]);
  const b = beatModel(step(I("bgez", R(1, 0, 1) | 3, { flow: "branch", target: 0x400010 }), [r(0, "$zero", 0)], { nextPC: 0x400010 }), program);
  assert.deepEqual(lines(b), ["下一条 = done ✓"]);
  const link = beatModel(step(I("bltzal", R(1, 8, 16) | 3, { flow: "branch", target: 0x400010 }), [r(8, "$t0", 1), w(31, "$ra", 0, 0x400008)]), program);
  assert.deepEqual(lines(link), ["若 1 < 0 → 跳到 done", "不成立 → 继续下一条", "$ra = 0x00400008 ✓", "下一条 = 第 4 行 ✓"]);
  const delayed = beatModel(step(I("bne", R(5, 8, 9) | 3, { flow: "branch", target: 0x400010 }), [r(8, "$t0", 7), r(9, "$t1", 7)]), { ...program, delay: true });
  assert.match(delayed.beats.at(-1).why, /延迟槽/);
});

test("jalr saves the link register and jr $ra is a return", () => {
  const jalr = beatModel(step(I("jalr", R(0, 9, 0, 31, 0, 9), { flow: "call" }), [r(9, "$t1", 0x400100), w(31, "$ra", 0, 0x400004)], { nextPC: 0x400100 }));
  assert.deepEqual(lines(jalr), ["跳到 0x00400100", "$ra = 0x00400004 ✓", "下一条 = 0x00400100 ✓"]);
  const jr = beatModel(step(I("jr", R(0, 31, 0, 0, 0, 8), { flow: "indirect" }), [r(31, "$ra", 0x400004)]));
  assert.equal(jr.beats.at(-1).caption, "返回调用者。");
});

test("input syscalls stop at waiting and never invent the result", () => {
  const b = beatModel({ instruction: I("syscall", 12), service: 5, status: "waiting-input", accesses: [r(2, "$v0", 5)] });
  assert.deepEqual(lines(b), ["syscall 5 · 读取整数", "等待输入"]);
  assert.ok(!b.beats.some((x) => x.lit.some((l) => l.mode === "write")));
});

test("errors add a final beat; blocked previews explain they will not run", () => {
  const e = beatModel(step(I("lw", R(35, 0, 8) | 1), [r(0, "$zero", 0)], { error: "Runtime exception: address not word-aligned\nmore", status: "error" }));
  assert.equal(lines(e).at(-1), "执行异常");
  assert.equal(e.beats.at(-1).caption, "Runtime exception: address not word-aligned");
  const ended = beatModel({ instruction: I("addu", 0), status: "ended", accesses: [] });
  assert.deepEqual([lines(ended), ended.summary], [["程序已结束"], "程序已结束"]);
});

const at = (step, instruction, accesses, extra = {}) => ({ step, instruction, accesses, nextPC: instruction.address + 4, ...extra });

test("generated whys name the operand's role, its producer and its next reader", () => {
  const ins = I("addu", R(0, 8, 9, 10, 0, 33), { address: 0x400010, line: 5, source: "addu $t2, $t0, $t1" });
  const e = at(5, ins, [r(8, "$t0", 7), r(9, "$t1", 5), w(10, "$t2", 0, 12)]);
  const producer = at(3, I("li", R(9, 0, 8) | 7, { line: 3, source: "li $t0, 7" }), [w(8, "$t0", 0, 7)]);
  const consumer = at(8, I("move", R(0, 10, 0, 4, 0, 33), { line: 8, source: "move $a0, $t2" }), [r(10, "$t2", 12), w(4, "$a0", 0, 12)]);
  const m = completeWhys(beatModel(e), e, { before: [producer], after: [consumer] });
  assert.ok(m.beats.every((b) => b.why), "every beat answers why");
  assert.match(m.beats[0].why, /\$t0 在这里是第一个源操作数。它现在的值来自第 3 步（main.s:3 `li \$t0, 7`）/);
  assert.match(m.beats[0].why, /\$t1 在这里是第二个源操作数。最近的执行记录里没有写过它/);
  assert.match(m.beats[2].why, /结果写进 \$t2（这条指令写明的目标寄存器）。之后第 8 步（main.s:8 `move \$a0, \$t2`）会读取它/);
  const alone = completeWhys(beatModel(e), e, {});
  assert.match(alone.beats[2].why, /在窗口里之后的步骤不会再读取它/);
});

test("hand-written derivations are kept; unknown instructions still get facts", () => {
  const e = at(1, I("lb", R(32, 5, 10)), [r(5, "$a1", 0x10010010), m(0x10010010, 1, 0xf0), w(10, "$t2", 0, -16)]);
  const before = beatModel(e).beats.map((b) => b.why);
  const after = completeWhys(beatModel(e), e, {}).beats.map((b) => b.why);
  before.forEach((why, i) => why && assert.ok(after[i].startsWith(why)));
  assert.ok(after.every(Boolean));
  const odd = at(2, I("teq", R(0, 8, 9, 0, 0, 52), { description: "Trap if equal" }), [r(8, "$t0", 1), r(9, "$t1", 2)]);
  const oddModel = completeWhys(beatModel(odd), odd, { explanations: {} });
  assert.match(oddModel.beats[0].why, /\$t0 在这里是第一个源操作数/);
  const flow = at(3, I("j", R(2) | 0x100010, { flow: "jump", target: 0x400040, address: 0x400000 }), [], { nextPC: 0x400040 });
  const jm = completeWhys(beatModel(flow, { symbols: [{ name: "loop", address: 0x400040 }] }), flow, { symbols: [{ name: "loop", address: 0x400040 }] });
  assert.match(jm.beats.at(-1).why, /目标|PC）变成 0x00400040，也就是 loop/);
});

test("memory reads explain where the bytes came from", () => {
  const e = at(9, I("lw", R(35, 4, 8)), [r(4, "$a0", 0x100), m(0x100, 4, 7), w(8, "$t0", 0, 7)]);
  const store = at(4, I("sw", R(43, 4, 9), { line: 4, source: "sw $t1, 0($a0)" }), [r(4, "$a0", 0x100), r(9, "$t1", 7), m(0x100, 4, 7, true, 0)]);
  const reasons = completeWhys(beatModel(e), e, { before: [store] }).beats.map((b) => b.why).join(" ");
  assert.match(reasons, /这里的内容是第 4 步（main.s:4 `sw \$t1, 0\(\$a0\)`）写进去的/);
});

test("adjacent bytes merge into one object with readable text and raw bytes", () => {
  const objs = [
    { id: "reg:$a0", kind: "register", name: "$a0", value: 0x10010000, write: false },
    ...[72, 105, 0].map((b, i) => ({ id: "mem:" + (0x10010000 + i), kind: "memory", address: 0x10010000 + i, width: 1, value: b, after: b, write: false })),
    { id: "mem:268500996", kind: "memory", address: 0x10010004, width: 1, value: 0xff, after: 0xff, write: false },
  ];
  const g = groupBytes(objs);
  assert.deepEqual(g.map((o) => [o.kind, o.width, o.ids.length]), [["register", undefined, 1], ["memory", 3, 3], ["memory", 1, 1]]);
  assert.equal(g[1].text, '"Hi\\0"');
  assert.deepEqual(g[1].bytes, [72, 105, 0]);
});

test("output is linked to the argument that produced it and its writer", () => {
  const e = at(60, I("syscall", 12, { line: 41 }), [r(2, "$v0", 11), r(4, "$a0", 72)], { service: 11, output: "H" });
  const load = at(57, I("lbu", R(36, 16, 8), { line: 21, source: "lbu $t0, 0($s0)" }), [w(4, "$a0", 0, 72)]);
  const why = completeWhys(beatModel(e), e, { before: [load] }).beats.find((b) => b.eq.some((p) => p.t === '"H"'))?.why || "";
  assert.match(why, /控制台在这一步多了 "H"。这个 syscall 用到的 \$a0 等于 72，是第 57 步（main.s:21 `lbu \$t0, 0\(\$s0\)`）写入的/);
});

test("a pseudo-instruction line is summarized by its net effect", () => {
  const lui = at(1, I("lui", R(15, 0, 1) | 0x1001, { address: 0x400000, line: 7, basic: "lui $at,0x00001001", source: "la $a0, values" }), [w(1, "$at", 0, 0x10010000)]);
  const ori = at(2, I("ori", R(13, 1, 4), { address: 0x400004, line: 7, basic: "ori $a0,$at,0x00000000" }), [r(1, "$at", 0x10010000), w(4, "$a0", 0, 0x10010000)]);
  const m = lineSummary([lui, ori], { source: "la $a0, values" });
  assert.deepEqual(m.beats.map((b) => b.eq.map((p) => (typeof p === "string" ? p : p.t)).join("")), ["$a0 = 0x10010000 ✓"]);
  assert.match(m.beats[0].why, /伪指令，展开为：lui \$at,0x00001001；ori \$a0,\$at,0x00000000/);
  assert.deepEqual(m.objects.map((o) => [o.id, o.before, o.after]), [["reg:$a0", 0, 0x10010000]]);
  assert.equal(m.template[0], "la $a0, values");
  const blt = [
    at(3, I("slt", R(0, 8, 9, 1, 0, 42), { address: 0x400010, line: 9, basic: "slt $at,$t0,$t1" }), [r(8, "$t0", 1), r(9, "$t1", 2), w(1, "$at", 0, 1)]),
    at(4, I("bne", R(5, 1, 0) | 3, { address: 0x400014, line: 9, flow: "branch", target: 0x400024, basic: "bne $at,$zero,0x00000003" }), [r(1, "$at", 1), r(0, "$zero", 0)], { nextPC: 0x400024 }),
  ];
  const b = lineSummary(blt, { source: "blt $t0, $t1, done", symbols: [{ name: "done", address: 0x400024 }] });
  assert.deepEqual(b.beats.map((x) => x.eq.map((p) => (typeof p === "string" ? p : p.t)).join("")), ["$t0 = 1，$t1 = 2", "下一条 = done ✓"]);
});

test("grouped bytes preserve interior and trailing NUL rather than joining strings", () => {
  const bytes = [65, 0, 66, 0];
  const objects = bytes.map((value, i) => ({
    id: `mem:${4096 + i}`, kind: "memory", address: 4096 + i,
    width: 1, value, write: false,
  }));
  const [group] = groupBytes(objects);
  assert.equal(group.text, '"A\\0B\\0"');
  assert.deepEqual(group.bytes, bytes);
  assert.deepEqual(objects.map(o => o.value), bytes);
});

test("merged bytes escape like ASCII mode, including quotes and line breaks", () => {
  const objects = [34, 72, 10, 9, 92, 0].map((value, i) => ({ id: `mem:${i}`, kind: "memory", address: i, width: 1, value, write: false }));
  assert.equal(groupBytes(objects)[0].text, String.raw`"\"H\n\t\\\0"`);
});

test("$zero identities read as copies, constants and compares with 0, not arithmetic", () => {
  const eqs = (m) => m.beats.map((b) => b.eq.map((p) => (typeof p === "string" ? p : p.t)).join(""));
  // move $t0, $a1  →  addu $t0, $a1, $zero
  const move = beatModel(step(I("addu", R(0, 5, 0, 8, 0, 33)), [r(5, "$a1", 0x1001000a), r(0, "$zero", 0), w(8, "$t0", 0, 0x1001000a)]));
  assert.equal(plain(move.template), "$t0 ← $a1");
  assert.deepEqual(eqs(move), ["$t0 ← 0x1001000a", "$t0 = 0x1001000a ✓"]);
  assert.match(move.beats[1].caption, /把 \$a1 的值复制到 \$t0/);
  assert.ok(!move.beats.some((b) => b.lit.some((l) => l.id === "reg:$zero")), "no $zero in the story");
  // li $a1, 0  →  addiu $a1, $zero, 0
  const li = beatModel(step(I("addiu", R(9, 0, 5) | 0), [r(0, "$zero", 0), w(5, "$a1", 0x1001000a, 0)]));
  assert.equal(plain(li.template), "$a1 ← 0");
  assert.deepEqual(eqs(li), ["$a1 = 0 ✓"]);
  assert.match(li.beats[0].caption, /把常数 0 放进 \$a1/);
  // beqz $a1, done  →  beq $a1, $zero, done
  const beqz = beatModel(step(I("beq", R(4, 5, 0) | 3, { flow: "branch", target: 0x400010 }), [r(5, "$a1", 0), r(0, "$zero", 0)]), { symbols: [{ name: "done", address: 0x400010 }] });
  assert.equal(plain(beqz.template), "若 $a1 == 0 → 跳到 done");
  assert.match(beqz.beats[1].caption, /条件 0 == 0 成立/);
  // move $v0, $zero  →  addu $v0, $zero, $zero
  const zero = beatModel(step(I("addu", R(0, 0, 0, 2, 0, 33)), [r(0, "$zero", 0), r(0, "$zero", 0), w(2, "$v0", 5, 0)]));
  assert.deepEqual(eqs(zero), ["$v0 = 0 ✓"]);
  // a real addition keeps its arithmetic
  const add = beatModel(step(I("addu", R(0, 8, 9, 10, 0, 33)), [r(8, "$t0", 7), r(9, "$t1", 5), w(10, "$t2", 0, 12)]));
  assert.equal(plain(add.template), "$t2 ← $t0 + $t1");
});

import { lineDecision } from "../ui/beats.js";
test("branch lines read as the compared values and the outcome", () => {
  const syms = { symbols: [{ name: "over10", address: 0x400040 }, { name: "done", address: 0x400024 }] };
  // bne $t0, $zero, over10 with $t0 = 3: taken
  const bne = [step(I("bne", R(5, 8, 0) | 3, { flow: "branch", target: 0x400040, source: "bne $t0, $zero, over10" }), [r(8, "$t0", 3), r(0, "$zero", 0)])];
  assert.equal(lineDecision(bne, syms), "3 ≠ 0 成立 → 跳到 over10");
  // beqz $t0 (pseudo-free) with $t0 = 3: not taken
  const beqz = [step(I("beq", R(4, 8, 0) | 3, { flow: "branch", target: 0x400040, source: "loop: beqz $t0, over10 # done?" }), [r(8, "$t0", 3), r(0, "$zero", 0)])];
  assert.equal(lineDecision(beqz, syms), "3 == 0 不成立 → 继续下一行");
  // blt $t0, $t1, done  →  slt $at,$t0,$t1 ; bne $at,$zero
  const blt = [
    step(I("slt", R(0, 8, 9, 1, 0, 42), { source: "blt $t0, $t1, done" }), [r(8, "$t0", 1), r(9, "$t1", 2), w(1, "$at", 0, 1)]),
    step(I("bne", R(5, 1, 0) | 3, { flow: "branch", target: 0x400024 }), [r(1, "$at", 1), r(0, "$zero", 0)]),
  ];
  assert.equal(lineDecision(blt, syms), "1 < 2 成立 → 跳到 done");
  // bgt $t0, 10, over10  with an immediate operand
  const bgt = [
    step(I("addi", R(8, 0, 1) | 10, { source: "bgt $t0, 10, over10" }), [w(1, "$at", 0, 10)]),
    step(I("slt", R(0, 1, 8, 1, 0, 42)), [r(1, "$at", 10), r(8, "$t0", 4), w(1, "$at", 10, 0)]),
    step(I("bne", R(5, 1, 0) | 3, { flow: "branch", target: 0x400040 }), [r(1, "$at", 0), r(0, "$zero", 0)]),
  ];
  assert.equal(lineDecision(bgt, syms), "4 > 10 不成立 → 继续下一行");
  // b loop  →  bgez $zero: always
  const b = [step(I("bgez", R(1, 0, 1) | 3, { flow: "branch", target: 0x400024, source: "b done" }), [r(0, "$zero", 0)])];
  assert.equal(lineDecision(b, syms), "→ 跳到 done");
  assert.equal(lineDecision([step(I("addu", R(0, 8, 9, 10, 0, 33)), [])]), null);
});

test("syscall lines read as the service, what it read and what it did", () => {
  const sys = (service, accesses, extra) => [step(I("syscall", 12, { source: "syscall" }), accesses, { service, ...extra })];
  const fmt = (v, name) => (name === "$a0" && v > 0x400000 ? "0x" + v.toString(16) : String(v));
  assert.equal(lineDecision(sys(4, [r(2, "$v0", 4), r(4, "$a0", 0x10010000)], { output: "Hi\n" }), { format: fmt }), '$v0 = 4 打印以 NUL 结束的字符串 · $a0 = 0x10010000 → 输出 "Hi\\n"');
  assert.equal(lineDecision(sys(5, [r(2, "$v0", 5), w(2, "$v0", 5, 42)]), { format: fmt }), "$v0 = 5 读取整数 → $v0 = 42");
  assert.equal(lineDecision(sys(5, [r(2, "$v0", 5)], { status: "waiting-input" })), "$v0 = 5 读取整数 → 等待输入");
  assert.equal(lineDecision(sys(10, [r(2, "$v0", 10)])), "$v0 = 10 退出程序 → 程序结束");
});
