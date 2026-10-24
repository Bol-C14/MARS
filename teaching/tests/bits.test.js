import test from "node:test";
import assert from "node:assert/strict";
import { bitStory, supportsBits } from "../ui/bits.js";

const R = (op, rs = 0, rt = 0, rd = 0, sa = 0, funct = 0) => (op << 26) | (rs << 21) | (rt << 16) | (rd << 11) | (sa << 6) | funct;
const r = (number, value) => ({ kind: "register", number, name: "$" + number, value, write: false });
const w = (number, value, name = "$" + number) => ({ kind: "register", number, name, value, write: true });
const ev = (op, binary, accesses, extra = {}) => ({ instruction: { op, binary }, accesses, ...extra });
const word = (row) => row.bits.join("");

test("shifts move one bit per step and fill with zero or the sign", () => {
  const s = bitStory(ev("sll", R(0, 0, 9, 8, 2, 0), [r(9, 0x80000001), w(8, 4)]));
  assert.equal(s.steps.length, 4, "source, two moves, result");
  assert.match(s.steps[1].caption, /移出 1，右端补入 0/);
  assert.equal(word(s.steps.at(-1).rows[0]), "00000000000000000000000000000100");
  const sra = bitStory(ev("sra", R(0, 0, 9, 8, 1, 3), [r(9, -8), w(8, -4)]));
  assert.match(sra.steps[0].caption, /补符号位/);
  assert.equal(word(sra.steps.at(-1).rows[0]), "1".repeat(30) + "00");
  const srl = bitStory(ev("srl", R(0, 0, 9, 8, 1, 2), [r(9, -8), w(8, 0x7ffffffc)]));
  assert.equal(word(srl.steps.at(-1).rows[0])[0], "0");
});

test("addition shows carries and tells overflow from a dropped carry", () => {
  const s = bitStory(ev("addu", R(0, 9, 10, 8, 0, 33), [r(9, 7), r(10, 3), w(8, 10)]));
  assert.equal(s.steps.length, 10);
  assert.equal(word(s.steps.at(-1).rows[0]), (10).toString(2).padStart(32, "0"));
  assert.equal(s.steps[1].rows[2].bits.slice(28).join(""), "1110", "carries out of bits 0-2 for 7 + 3");
  const over = bitStory(ev("add", R(0, 9, 10, 8, 0, 32), [r(9, 0x7fffffff), r(10, 1)], { error: "overflow" }));
  assert.ok(over.overflow);
  assert.match(over.steps.at(-1).caption, /有符号溢出。add 检查溢出，会触发异常。这一步触发了异常/);
  const wrap = bitStory(ev("addu", R(0, 9, 10, 8, 0, 33), [r(9, -1), r(10, 1), w(8, 0)]));
  assert.ok(!wrap.overflow);
  assert.match(wrap.steps.at(-1).caption, /进位被丢弃/);
});

test("subtraction is addition of the complement; addi sign-extends", () => {
  const s = bitStory(ev("subu", R(0, 9, 10, 8, 0, 35), [r(9, 5), r(10, 7), w(8, -2)]));
  assert.match(s.steps[0].caption, /取反再加 1/);
  assert.equal(word(s.steps.at(-1).rows[0]), "1".repeat(31) + "0");
  const addi = bitStory(ev("addiu", R(9, 9, 8) | 0xffff, [r(9, 5), w(8, 4)]));
  assert.equal(word(addi.steps.at(-1).rows[0]), (4).toString(2).padStart(32, "0"));
});

test("logic, mult and div; unsupported instructions have no story", () => {
  const s = bitStory(ev("andi", R(12, 9, 8) | 0xf0, [r(9, 0xff), w(8, 0xf0)]));
  assert.equal(word(s.steps.at(-1).rows[0]), (0xf0).toString(2).padStart(32, "0"));
  const m = bitStory(ev("mult", R(0, 9, 10, 0, 0, 24), [r(9, -2), r(10, 3)]));
  assert.equal(m.steps[1].rows[1].bits.join(""), "1".repeat(32), "HI of -6");
  const d = bitStory(ev("div", R(0, 9, 10, 0, 0, 26), [r(9, 7), r(10, 2)]));
  assert.equal(parseInt(d.steps[1].rows[0].bits.join(""), 2), 3);
  assert.equal(parseInt(d.steps[1].rows[1].bits.join(""), 2), 1);
  assert.match(bitStory(ev("div", R(0, 9, 10, 0, 0, 26), [r(9, 7), r(10, 0)])).steps[0].caption, /除数为 0/);
  assert.equal(supportsBits(ev("lw", 0, [])), false);
});
