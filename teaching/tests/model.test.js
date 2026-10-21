import test from "node:test";
import assert from "node:assert/strict";
import { buildCFG, references, canonicalReg } from "../ui/model.js";
test("register aliases and read-write references", () => {
  assert.equal(canonicalReg("$16"), "$s0");
  assert.equal(canonicalReg("$s8"), "$fp");
  const refs = references(
    { "a.s": "addiu $t0,$t0,1\nsw $t0,0($sp)\n# $t0 ignored" },
    "$8",
  );
  assert.equal(refs.length, 2);
  assert.equal(refs[0].type, "读取＋写入");
  assert.equal(refs[1].type, "读取");
});
test("branch blocks include delay slot when enabled", () => {
  const instructions = [
    { address: 0, flow: "next" },
    { address: 4, flow: "branch", target: 16 },
    { address: 8, flow: "next" },
    { address: 12, flow: "next" },
    { address: 16, flow: "next" },
  ];
  let blocks = buildCFG(instructions, true);
  assert.deepEqual(
    blocks.map((b) => b.start),
    [0, 12, 16],
  );
  assert.deepEqual(blocks[0].edges, [
    { target: 16, label: "条件成立" },
    { target: 12, label: "条件不成立" },
  ]);
  blocks = buildCFG(instructions, false);
  assert.deepEqual(
    blocks.map((b) => b.start),
    [0, 8, 16],
  );
});
test("indirect transfers stay unknown instead of inventing target", () => {
  let blocks = buildCFG([
    { address: 0, flow: "indirect" },
    { address: 4, flow: "next" },
  ]);
  assert.deepEqual(blocks[0].edges, [{ target: null, label: "运行时目标" }]);
});
test("symbols are exact tokens, comments excluded", () => {
  const r = references({ "a.s": "loop:\n b loop\n b loop2\n# loop" }, "loop");
  assert.equal(r.length, 2);
  assert.equal(r[0].type, "定义");
  assert.equal(r[1].type, "控制转移");
});
