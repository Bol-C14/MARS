import test from "node:test";
import assert from "node:assert/strict";
import { splitComment, nameRegisters, withOperands } from "../ui/model.js";

test("author comments are split from code; # inside strings is code", () => {
  assert.deepEqual(splitComment("  move $s0, $v0   # $s0 = bytes read"), {
    code: "move $s0, $v0",
    comment: "$s0 = bytes read",
  });
  assert.deepEqual(splitComment('msg: .asciiz "a#b"  # prompt'), {
    code: 'msg: .asciiz "a#b"',
    comment: "prompt",
  });
  assert.deepEqual(splitComment("li $v0, 10"), {
    code: "li $v0, 10",
    comment: "",
  });
});

test("machine statements use register names", () => {
  assert.equal(
    nameRegisters("addiu $2,$0,0x0000000b"),
    "addiu $v0,$zero,0x0000000b",
  );
  assert.equal(nameRegisters("lui $1,0x00001001"), "lui $at,0x00001001");
  assert.equal(nameRegisters("sw $31,4($29)"), "sw $ra,4($sp)");
});

test("MARS descriptions take this line's operands, by position, in one pass", () => {
  const d = "Branch if EQual Zero : Branch to statement at label if $t1 is equal to zero";
  assert.equal(withOperands(d, "beqz $t1,label", "loop: beqz $a1, done   # end?").text,
    "Branch if EQual Zero : Branch to statement at done if $a1 is equal to zero");
  const swap = withOperands("Set $t1 to $t2 plus $t3", "addu $t1,$t2,$t3", "addu $t2, $t3, $t1");
  assert.equal(swap.text, "Set $t2 to $t3 plus $t1");
  const lw = withOperands("Load $t1 from -100($t2); $t10 untouched", "lw $t1,-100($t2)", "lw $t0, 0($a0)");
  assert.equal(lw.text, "Load $t0 from 0($a0); $t10 untouched");
  assert.equal(withOperands(d, "beqz $t1,label", "li $v0, 10").substituted, false);
});
