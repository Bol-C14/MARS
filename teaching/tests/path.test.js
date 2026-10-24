import test from "node:test";
import assert from "node:assert/strict";
import { layoutPath } from "../ui/path.js";

const R = (op, rs = 0, rt = 0, funct = 0) => (op << 26) | (rs << 21) | (rt << 16) | funct;
const ins = (address, line, op = "addu", flow = "next", target, binary = 0) => ({
  address, file: "main.s", line, op, flow, binary, ...(target == null ? {} : { target }),
});
const ev = (i, nextPC) => ({ instruction: i, nextPC, accesses: [] });
// Walks a list of [instruction, nextPC] as one lookahead group per source line.
const look = (pairs, stop = "window") => {
  const groups = [];
  for (const [i, next] of pairs) {
    const g = groups.at(-1);
    if (g && g.line === i.line && g.events.at(-1).nextPC === i.address) g.events.push(ev(i, next));
    else groups.push({ file: i.file, line: i.line, address: i.address, events: [ev(i, next)] });
  }
  return { groups, stop, stopAt: null, complete: true };
};

// main: li ; loop: beq $t0,$0,done ; addi ; b loop ; nop ; done: jr $ra
const P = [
  ins(0x00, 1),
  ins(0x04, 2, "beq", "branch", 0x14, R(4, 8, 0)),
  ins(0x08, 3, "addi"),
  ins(0x0c, 4, "bgez", "branch", 0x04, R(1, 0, 1)),
  ins(0x10, 5, "nop"),
  ins(0x14, 6, "jr", "indirect", undefined, R(0, 31, 0, 8)),
];
const symbols = [
  { name: "main", address: 0x00 },
  { name: "loop", address: 0x04 },
  { name: "done", address: 0x14 },
];
const [L1, L2, L3, L4, , L6] = P;
const loopTwice = look([
  [L1, 4], [L2, 8], [L3, 0xc], [L4, 4], [L2, 8], [L3, 0xc], [L4, 4], [L2, 0x14], [L6, 0x40],
]);

test("fixed window lays out blocks once and counts loop iterations", () => {
  const p = layoutPath({ lookahead: loopTwice, instructions: P, symbols, mode: "fixed", lines: 8 });
  assert.equal(p.steps.length, 8);
  assert.deepEqual(
    p.segments.map((s) => [s.label, s.iterations, s.lines.map((l) => l.line)]),
    [["main", 1, [1]], ["loop", 3, [2]], [null, 2, [3, 4]]],
  );
  assert.deepEqual(p.steps.map((s) => s.iteration), [1, 1, 1, 1, 2, 2, 2, 3]);
  assert.deepEqual(
    p.edges.map((e) => [e.from, e.to, e.kind, e.count]),
    [[0, 4, "next", 1], [4, 8, "fallthrough", 2], [8, 4, "jump", 2]],
  );
  assert.equal(p.stop.reason, "window");
  assert.ok(p.stop.truncated);
});

test("untaken direction is a single hint, never a segment; unconditional b gets none", () => {
  const p = layoutPath({ lookahead: loopTwice, instructions: P, symbols, mode: "fixed", lines: 8 });
  assert.equal(p.hints.length, 1);
  assert.deepEqual(
    [p.hints[0].line, p.hints[0].kind, p.hints[0].label, p.hints[0].target.line],
    [2, "taken", "done", 6],
  );
  assert.ok(!p.segments.some((s) => s.id === 0x14));
});

test("auto window stops at the second control decision", () => {
  const p = layoutPath({ lookahead: loopTwice, instructions: P, symbols });
  assert.deepEqual(p.steps.map((s) => s.line), [1, 2, 3, 4]);
  assert.ok(p.stop.truncated);
  assert.equal(p.stop.at.line, 2);
});

test("taken exit reports the fallthrough as the untaken hint", () => {
  const exit = look([[L2, 0x14], [L6, 0x40]], "ended");
  const p = layoutPath({ lookahead: exit, instructions: P, symbols, mode: "fixed" });
  assert.deepEqual(p.edges.map((e) => e.kind), ["taken"]);
  assert.deepEqual([p.hints[0].kind, p.hints[0].target.line], ["fallthrough", 3]);
  assert.equal(p.stop.reason, "ended");
  assert.ok(!p.stop.truncated);
});

test("calls and returns become labelled edges between function segments", () => {
  const C = [
    ins(0x00, 1, "jal", "call", 0x0c, R(3)),
    ins(0x04, 2),
    ins(0x08, 3, "nop"),
    ins(0x0c, 4),
    ins(0x10, 5, "jr", "indirect", undefined, R(0, 31, 0, 8)),
  ];
  const p = layoutPath({
    lookahead: look([[C[0], 0x0c], [C[3], 0x10], [C[4], 0x04], [C[1], 0x08]]),
    instructions: C,
    symbols: [{ name: "f", address: 0x0c }],
    mode: "fixed",
  });
  assert.deepEqual(p.edges.map((e) => [e.from, e.to, e.label]), [[0, 0x0c, "调用"], [0x0c, 0x04, "返回"]]);
  assert.equal(p.segments[1].label, "f");
});

test("delayed branches take effect after the delay slot", () => {
  const D = [
    ins(0x00, 1),
    ins(0x04, 2, "bne", "branch", 0x00, R(5, 8, 0)),
    ins(0x08, 3, "nop"),
    ins(0x0c, 4),
  ];
  const run = look([[D[0], 4], [D[1], 8], [D[2], 0], [D[0], 4], [D[1], 8], [D[2], 0x0c], [D[3], 0x10]]);
  let p = layoutPath({ lookahead: run, instructions: D, delay: true, mode: "fixed" });
  assert.deepEqual(p.segments.map((s) => [s.id, s.iterations]), [[0, 2], [0x0c, 1]]);
  assert.deepEqual(p.edges.map((e) => [e.from, e.to, e.kind]), [[0, 0, "taken"], [0, 0x0c, "fallthrough"]]);
  assert.deepEqual(p.hints.map((h) => h.target.address).sort(), [0, 0x0c]);
  p = layoutPath({ lookahead: run, instructions: D, delay: true });
  assert.deepEqual(p.steps.map((s) => s.line), [1, 2, 3, 1, 2, 3]);
});

test("completed step joins the window; a jump just before it is still shown as a jump", () => {
  const D = [ins(0x00, 1), ins(0x04, 2, "j", "jump", 0x00, R(2)), ins(0x08, 3, "nop")];
  const p = layoutPath({
    last: { ...ev(D[2], 0x00), step: 7 },
    lookahead: look([[D[0], 4]]),
    instructions: D,
    delay: true,
    mode: "fixed",
  });
  assert.deepEqual(p.steps.map((s) => [s.index, s.predicted]), [[-1, false], [0, true]]);
  assert.deepEqual(p.edges.map((e) => e.kind), ["jump"]);
});

test("empty input yields an empty layout", () => {
  const p = layoutPath();
  assert.deepEqual([p.steps, p.segments, p.edges, p.hints], [[], [], [], []]);
});

test("the completed step includes the whole pseudo-instruction line from history", () => {
  const A = ins(0x00, 1, "lui"), B = ins(0x04, 1, "ori"), C = ins(0x08, 2);
  const history = [{ ...ev(A, 4), pc: 0, step: 1 }, { ...ev(B, 8), pc: 4, step: 2 }];
  const p = layoutPath({ last: history[1], history, lookahead: look([[C, 0xc]]), instructions: [A, B, C], mode: "fixed" });
  assert.deepEqual(p.steps[0].events.map((e) => e.instruction.op), ["lui", "ori"]);
});

test("earlier executed lines stay in the window before the completed one", () => {
  const A = ins(0x00, 1), B = ins(0x04, 2, "lui"), B2 = ins(0x08, 2, "ori"), C = ins(0x0c, 3), D = ins(0x10, 4);
  const history = [
    { ...ev(A, 4), pc: 0, step: 1 },
    { ...ev(B, 8), pc: 4, step: 2 },
    { ...ev(B2, 0xc), pc: 8, step: 3 },
    { ...ev(C, 0x10), pc: 0xc, step: 4 },
  ];
  const p = layoutPath({ last: history[3], history, lookahead: look([[D, 0x14]]), instructions: [A, B, B2, C, D], mode: "fixed" });
  assert.deepEqual(p.steps.map((s) => [s.index, s.line, s.events.length, s.predicted]),
    [[-3, 1, 1, false], [-2, 2, 2, false], [-1, 3, 1, false], [0, 4, 1, true]]);
  const two = layoutPath({ last: history[3], history, earlier: 1, lookahead: look([[D, 0x14]]), instructions: [A, B, B2, C, D], mode: "fixed" });
  assert.deepEqual(two.steps.map((s) => s.index), [-2, -1, 0]);
});
