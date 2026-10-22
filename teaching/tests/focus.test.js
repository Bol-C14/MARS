import test from "node:test";
import assert from "node:assert/strict";
import { splitComment, nameRegisters } from "../ui/model.js";

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
