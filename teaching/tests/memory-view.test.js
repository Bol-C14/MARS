// The memory panel's model (classroom 2026-11-04).
import test from "node:test";
import assert from "node:assert/strict";
import { parseAddress, dataSymbols, memoryRows, wordValue, memoryBar, barPosition } from "../ui/memory-view.js";

const symbols = [
  { name: "scores", address: 0x10010000, data: true, file: "main.s" },
  { name: "prompt", address: 0x10010010, data: true, file: "main.s" },
  { name: "total", address: 0x10010018, data: true, file: "" },
  { name: "main", address: 0x00400000, data: false, file: "main.s" },
];
const registers = { $sp: 0x7fffeff0, $t0: 0x10010004 };
const env = { symbols, register: (r) => registers[r] };

test("the address box takes a number, a label or register ± a constant, or off($reg)", () => {
  assert.equal(parseAddress("0x10010008", env), 0x10010008);
  assert.equal(parseAddress("268500992", env), 0x10010000);
  assert.equal(parseAddress("0x10010000+8", env), 0x10010008);
  assert.equal(parseAddress("scores", env), 0x10010000);
  assert.equal(parseAddress("scores+8", env), 0x10010008);
  assert.equal(parseAddress(" scores - 0x4 ", env), 0x1000fffc);
  assert.equal(parseAddress("$sp", env), 0x7fffeff0);
  assert.equal(parseAddress("$sp-4", env), 0x7fffefec);
  assert.equal(parseAddress("4($sp)", env), 0x7fffeff4);
  assert.equal(parseAddress("-8($t0)", env), 0x1000fffc);
  assert.equal(parseAddress("($t0)", env), 0x10010004);
});

test("anything else names no address", () => {
  for (const text of ["", "nothing", "$nope", "scores*2", "scores+$t0", "4($nope)", "scores+8+1"])
    assert.equal(parseAddress(text, env), null, text);
});

test("data symbols know their size and how they read best", () => {
  const sources = {
    "main.s": ".data\nscores: .word 1, 2, 3\n.align 2\nprompt: .asciiz \"Hi\\n\"\n",
    "stats.s": ".data\n.globl total\ntotal:\n    .space 8 # sum\n",
  };
  const list = dataSymbols(symbols, sources);
  assert.deepEqual(
    list.map((s) => [s.name, s.directive, s.size, s.view]),
    [
      ["scores", ".word", 12, "words"],
      ["prompt", ".asciiz", 4, "text"],
      ["total", ".space", 8, "bytes"],
    ],
  );
  assert.equal(list[2].end, 0x10010020);
});

const bytes = (from, values) => values.map((value, i) => ({ address: from + i, value }));

test("rows break at labels and at multiples of 8 bytes, with words only where whole", () => {
  const memory = bytes(0x10010000, [1, 0, 0, 0, 2, 0, 0, 0, 0x48, 0x69, 0, 0, 5, 0, 0, 0, 7, 0]);
  const marks = [
    { name: "a", address: 0x10010000 },
    { name: "s", address: 0x10010009 },
  ];
  const rows = memoryRows(memory, marks, "words");
  assert.deepEqual(
    rows.map((r) => (r.label ? `#${r.label.name}` : r.cells.map((c) => `${(c.address & 0xff).toString(16)}:${c.width}`).join(" "))),
    ["#a", "0:4 4:4", "8:1", "#s", "9:1 a:1 b:1 c:4", "10:1 11:1"],
  );
  assert.equal(wordValue(rows[1].cells[0].bytes), 1);
  assert.equal(wordValue([0xff, 0xff, 0xff, 0xff]), -1);
  assert.equal(wordValue([1, null, 0, 0]), null);
  assert.equal(memoryRows(memory, [], "text")[0].cells.length, 16);
  assert.ok(memoryRows(memory, [], "bytes").every((r) => r.cells.every((c) => c.width === 1)));
});

test("the bar runs the list's way, low addresses at the top, each in its own segment", () => {
  const layout = { text: 0x400000, data: 0x10010000, heap: 0x10040000, heapTop: 0x10040010, stack: 0x7fffeffc };
  const bar = memoryBar({ layout, sp: 0x7fffefe0, dataEnd: 0x10010100, textEnd: 0x400100 });
  assert.deepEqual(bar.map((s) => s.id), ["text", "data", "heap", "free", "stack"]);
  assert.ok(Math.abs(bar.reduce((n, s) => n + s.share, 0) - 1) < 1e-9);
  const at = (a) => barPosition(bar, a);
  assert.equal(at(0x400000).segment, "text");
  assert.equal(at(0x10010080).segment, "data");
  assert.equal(at(0x10040000).segment, "heap");
  assert.equal(at(0x7fffeffc).segment, "stack");
  assert.ok(at(0x400000).y < at(0x10010000).y && at(0x10010000).y < at(0x10040000).y && at(0x10040000).y < at(0x7fffefe0).y);
  assert.ok(at(0x10010010).y < at(0x10010080).y);
});

test("every address a program can look at has a place on the bar", () => {
  const layout = { text: 0x400000, data: 0x10010000, heap: 0x10040000, heapTop: 0x10040000, stack: 0x7fffeffc };
  const bar = memoryBar({ layout, sp: 0x7fffeffc, dataEnd: 0x10010100, textEnd: 0x400100 });
  const at = (a) => barPosition(bar, a);
  // Past the last label, past the code, between heap and stack, below $sp, above the stack's start.
  assert.equal(at(0x10030000).segment, "data");
  assert.equal(at(0x1000000).segment, "text");
  assert.equal(at(0x20000000).segment, "free");
  assert.equal(at(0x7fffe7ac).segment, "free");
  assert.equal(at(0x7ffff000).segment, "stack");
  const order = [0x400000, 0x400100, 0x1000000, 0x10010000, 0x10010100, 0x10030000, 0x10040000, 0x20000000, 0x7fffe7ac, 0x7fffeffc, 0x7ffff800].map((a) => at(a).y);
  assert.deepEqual(order, [...order].sort((x, y) => x - y));
  assert.ok(order.every((y) => y >= 0 && y < 1));
  assert.equal(at(0x3ff000), null);
  assert.equal(at(0x80000000), null);
  assert.deepEqual(memoryBar({}), []);
});
