import test from "node:test";
import assert from "node:assert/strict";
import { instructionIndex, searchInstructions } from "../ui/instruction-index.js";

const items = instructionIndex({ teq: { description: "Trap if equal", example: "teq $t1,$t2" }, add: { description: "dup" } });
const top = (q) => searchInstructions(q, items)[0];
const labels = (q, n = 5) => searchInstructions(q, items).slice(0, n).map((x) => x.label);

test("names, purposes and everyday words all find the right entry", () => {
  assert.equal(top("add").op, "add");
  assert.equal(top("加法").op.startsWith("add"), true);
  assert.ok(labels("比较大小").some((l) => ["slt", "blt", "bgt"].includes(l)), labels("比较大小").join());
  assert.equal(top("打印字符").label, "syscall 11 · 打印字符");
  assert.equal(top("读取整数").label, "syscall 5 · 读取整数");
  assert.ok(["srl", "sra"].includes(top("右移").op));
  assert.equal(top("sycall")?.op, "syscall", "a misspelling still finds it");
});

test("results say real or pseudo, and syscall services show number plus parameters", () => {
  assert.equal(top("li").pseudo, true);
  assert.equal(top("lw").pseudo, false);
  assert.match(top("打印字符").format, /li \$v0, 11\n\$a0 = 要打印字符的编码\nsyscall/);
  assert.equal(top("teq").note, "MARS 原文说明");
  assert.equal(items.filter((x) => x.op === "add").length, 1, "curated entries win over MARS duplicates");
  assert.deepEqual(searchInstructions("zzzz不存在", items), []);
});

test("a shared word is a weak match that does not compete with real answers", () => {
  const strong = (q) => searchInstructions(q, items).filter((x) => !x.weak).map((x) => x.label);
  assert.deepEqual(strong("打印字符"), ["syscall 11 · 打印字符", "syscall 4 · 打印字符串"]);
  assert.ok(!strong("读取整数").includes("lw"));
  assert.ok(searchInstructions("读取整数", items).some((x) => x.op === "lw" && x.weak), "still there, folded");
});
