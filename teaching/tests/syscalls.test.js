import test from "node:test";
import assert from "node:assert/strict";
import { serviceAt, argumentMeaning, syscallDetail } from "../ui/syscalls.js";

const esc = (s) => String(s).replace(/</g, "&lt;");
test("the service number comes from before the call, never the overwritten $v0", () => {
  assert.deepEqual(serviceAt({ next: true, v0: 11 }), { n: 11, from: "next" });
  const event = { service: 5, accesses: [{ kind: "register", name: "$v0", write: true, value: 42 }] };
  assert.equal(serviceAt({ event, v0: 42 }).n, 5);
  const lines = ["main:", "  li $v0, 11   # print a character", "  move $a0, $t0", "  syscall"];
  assert.deepEqual(serviceAt({ lines, line: 4 }), { n: 11, from: "source" });
  assert.equal(serviceAt({ lines: ["  li $v0, 4", "loop:", "  syscall"], line: 3 }).from, "unknown", "a label may be reached from elsewhere");
  assert.equal(serviceAt({ lines: ["  li $v0, 4", "  move $v0, $t1", "  syscall"], line: 3 }).from, "unknown");
});
test("arguments are read for what they mean to the service", () => {
  assert.equal(argumentMeaning(11, "$a0", 45), "编码 45 是字符 '-'");
  assert.equal(argumentMeaning(1, "$a0", 45), "打印出来是 45");
  assert.equal(argumentMeaning(4, "$a0", 0x10010000), "这是地址，内容在内存里");
  assert.equal(argumentMeaning(11, "$a0", 10), "编码 10（\\n，不是可显示字符）");
});
test("the detail shows does, parameters, what happened and what changes", () => {
  const d = syscallDetail({ n: 11, from: "ran", values: { $a0: 45 }, event: { output: "-", accesses: [] }, esc });
  assert.match(d.title, /打印字符（服务 11）/);
  assert.match(d.html, /做什么.*需要的参数.*\$a0.*45.*字符 '-'.*发生什么.*实际输出 "-".*变化/s);
  const waiting = syscallDetail({ n: 5, from: "next", waiting: true, esc });
  assert.match(waiting.html, /正在等待输入/);
  assert.doesNotMatch(waiting.html, /\$v0 变为/);
  assert.match(syscallDetail({ n: 99, from: "next", esc }).html, /不在 MARS Trace 支持的范围内/);
  assert.match(syscallDetail({ n: null, from: "unknown", esc }).html, /要执行到这里才知道/);
});
