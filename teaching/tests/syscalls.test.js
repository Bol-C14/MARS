import test from "node:test";
import assert from "node:assert/strict";
import { serviceAt, argumentMeaning, syscallDetail } from "../ui/syscalls.js";

const esc = (s) => String(s).replace(/</g, "&lt;");
test("the value in $v0 comes from before the call, never the overwritten $v0", () => {
  assert.equal(serviceAt({ next: true, v0: 11 }).n, 11);
  const event = { service: 5, accesses: [{ kind: "register", name: "$v0", write: true, value: 42 }] };
  assert.equal(serviceAt({ event, v0: 42 }).n, 5);
  const lines = ["main:", "  li $v0, 11   # print a character", "  move $a0, $t0", "  syscall"];
  assert.deepEqual(serviceAt({ lines, line: 4 }).setter, { n: 11, line: 2, text: "li $v0, 11" });
  assert.equal(serviceAt({ next: true, v0: 11, lines, line: 4 }).setter.line, 2, "the same origin whatever the timing");
  assert.equal(serviceAt({ next: true, v0: 4, lines, line: 4 }).setter, null, "a different value is not credited to that line");
  assert.equal(serviceAt({ lines: ["  li $v0, 4", "loop:", "  syscall"], line: 3 }).n, null, "a label may be reached from elsewhere");
  assert.equal(serviceAt({ lines: ["  li $v0, 4", "  move $v0, $t1", "  syscall"], line: 3 }).n, null);
});
test("arguments are read for what they mean to the service", () => {
  assert.equal(argumentMeaning(11, "$a0", 45), "编码 45 是字符 '-'");
  assert.equal(argumentMeaning(1, "$a0", 45), "打印出来是 45");
  assert.equal(argumentMeaning(4, "$a0", 0x10010000), "这是地址，内容在内存里");
  assert.equal(argumentMeaning(11, "$a0", 10), "编码 10（\\n，不是可显示字符）");
});
test("the detail says which value in $v0 chose it and where it was put, without 服务号", () => {
  const d = syscallDetail({ n: 11, values: { $a0: 45 }, event: { output: "-", accesses: [] }, setter: { line: 9, text: "li $v0, 11" }, step: 7, esc });
  assert.equal(d.title, "syscall：打印字符");
  assert.match(d.html, /\$v0 = 11 选定了“打印字符”（第 9 行 li \$v0, 11 放入，第 7 步）/);
  assert.match(d.html, /做什么.*需要的参数.*\$a0.*45.*字符 '-'.*发生什么.*实际输出 "-".*变化/s);
  const waiting = syscallDetail({ n: 5, waiting: true, esc });
  assert.match(waiting.html, /正在等待输入.*\$v0 仍是 5/);
  assert.match(waiting.html, /原来的 5 被覆盖/);
  assert.doesNotMatch(waiting.html + d.html, /服务号/);
  assert.match(syscallDetail({ n: 99, esc }).html, /MARS Trace 不支持这个数/);
  assert.match(syscallDetail({ n: null, esc }).html, /要执行到这一行才知道/);
});
