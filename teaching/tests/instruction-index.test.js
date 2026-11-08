import test from "node:test";
import assert from "node:assert/strict";
import { directiveGuide, instructionIndex, searchInstructions, usageOf } from "../ui/instruction-index.js";

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

const entry = (op) => instructionIndex({}).find((x) => x.op === op);
const parts = (op, source) => Object.fromEntries(usageOf(entry(op), source).parts.map((p) => [p.name, p]));

test("beq says how it is written: two things to compare and a label", () => {
  const u = parts("beq", "loop: beq $t0, $t1, done # 相等就结束");
  assert.equal(usageOf(entry("beq")).format, "beq rs, rt, label");
  assert.deepEqual([u.rs.value, u.rt.value, u.label.value], ["$t0", "$t1", "done"]);
  assert.match(u.rs.meaning, /左边/);
  assert.match(u.rt.meaning, /右边/);
  assert.match(u.label.meaning, /条件成立时跳到/);
});

test("each operand's meaning follows from the entry, not per instruction text", () => {
  assert.match(parts("add", "add $t0, $t1, $t2").rd.meaning, /结果写入/);
  assert.match(parts("add", "add $t0, $t1, $t2").rs.meaning, /参与运算/);
  assert.match(parts("lw", "lw $t0, 8($sp)").rt.meaning, /读到的值/);
  assert.match(parts("sw", "sw $t0, 8($sp)").rt.meaning, /要写进内存/);
  assert.equal(parts("lw", "lw $t0, 8($sp)").offset.value, "8");
  assert.equal(parts("lw", "lw $t0, ($sp)").offset.value, "0");
  assert.equal(parts("lw", "lw $t0, 8($sp)").rs.value, "$sp");
  assert.match(parts("jr", "jr $ra").rs.meaning, /跳转目标地址/);
  assert.match(parts("bgez", "bgez $t0, go").rs.meaning, /和 0 比较/);
  assert.match(parts("sllv", "sllv $t0, $t1, $t2").rs.meaning, /低 5 位/);
  assert.match(parts("jal", "jal f").label.meaning, /^跳到这个标签/);
});

test("every written form has a meaning for every part", () => {
  for (const x of instructionIndex({}).filter((i) => i.kind === "instruction"))
    for (const p of usageOf(x).parts) assert.ok(p.meaning, `${x.op} ${p.name}`);
});

test("a line that does not match the form shows the form without values", () => {
  assert.equal(parts("lw", "lw $t0").rt.value, "");
  assert.equal(parts("jalr", "jalr $t9").rd.value, "");
});

test("directives are explained with how to write them", () => {
  assert.match(directiveGuide[".asciiz"][1], /\\0/);
  assert.match(directiveGuide[".word"][0], /\.word/);
});


test("operand roles stay correct in English", async () => {
  const {setLanguage} = await import("../ui/i18n/index.js");
  setLanguage("en");
  try {
    assert.match(parts("beq","beq $t0,$t1,done").rs.meaning,/comparison/);
    assert.match(parts("bgez","bgez $t0,done").rs.meaning,/compared/);
    assert.match(parts("sllv","sllv $t0,$t1,$t2").rs.meaning,/5/);
  } finally {setLanguage("zh-CN");}
});
