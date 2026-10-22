import test from "node:test";
import assert from "node:assert/strict";
import { fuzzy, outline, quickOpenItems } from "../ui/search.js";

const files = {
  "main.s": ".data\nvalues: .word 7\n.text\nmain:\n la $a0, values\n jal sum\nsum:  # adds\n jr $ra\n",
  "lib/io.s": ".text\nread_loop:\n nop\n# done: not a label\n",
};
const symbols = [
  { name: "values", address: 0x10010000, data: true },
  { name: "main", address: 0x400000 },
  { name: "sum", address: 0x400010 },
  { name: "read_loop", address: 0x400100 },
];
const ctx = { files, symbols, activeFile: "main.s", commands: [{ label: "汇编工程", keys: "⌘Enter" }, { label: "专注模式", keys: "⌘K F" }] };

test("fuzzy ranks prefix over substring over subsequence and rejects misses", () => {
  assert.ok(fuzzy("su", "sum") > fuzzy("um", "sum"));
  assert.ok(fuzzy("um", "sum") > fuzzy("rl", "read_loop"));
  assert.ok(fuzzy("rl", "read_loop") >= 0);
  assert.equal(fuzzy("zz", "sum"), -1);
});

test("outline lists labels in source order, ignoring comments, with kind and address", () => {
  assert.deepEqual(outline(files, "main.s", symbols).map((x) => [x.label, x.line]), [["values", 2], ["main", 4], ["sum", 7]]);
  assert.match(outline(files, "main.s", symbols)[0].detail, /数据 · 第 2 行 · 0x10010000/);
  assert.deepEqual(outline(files, "lib/io.s", symbols).map((x) => x.label), ["read_loop"]);
});

test("plain queries search files and labels across the project", () => {
  assert.deepEqual(quickOpenItems("rl", ctx).map((x) => [x.kind, x.label]), [["symbol", "read_loop"]]);
  assert.equal(quickOpenItems("io", ctx)[0].file, "lib/io.s");
  assert.equal(quickOpenItems("", ctx).length, 6);
});

test("prefixes: > commands, @ current-file symbols, :line, file:line, 0x address", () => {
  assert.deepEqual(quickOpenItems(">专注", ctx).map((x) => [x.kind, x.label, x.detail]), [["command", "专注模式", "⌘K F"]]);
  assert.deepEqual(quickOpenItems("@", ctx).map((x) => x.label), ["values", "main", "sum"]);
  assert.deepEqual(quickOpenItems(":5", ctx).map((x) => [x.file, x.line, x.detail]), [["main.s", 5, "la $a0, values"]]);
  assert.deepEqual(quickOpenItems("io.s:2", ctx).map((x) => [x.file, x.line]), [["lib/io.s", 2]]);
  assert.deepEqual(quickOpenItems(":99", ctx), []);
  assert.deepEqual(quickOpenItems("0x400010", ctx).map((x) => [x.kind, x.address, x.detail]), [["address", 0x400010, "sum"]]);
});
