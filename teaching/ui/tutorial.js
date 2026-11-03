// Hands-on introduction (classroom 2026-10-24): a Hello World program that
// grows into reading a name, debugging it, finding an integer overflow, and
// adding a feature of one's own. Each step starts from a goal or a question
// and is checked against what actually happened in the IDE (files, the
// loaded program, output, breakpoints, watchpoints, the inspector, focus
// mode), never by counting clicks on "next". Hints come one at a time; the
// reference answer is shown, never typed into the student's code.
import { escapeHTML as esc } from "./model.js";

const HELLO = `.data
greeting: .asciiz "Hello!"
.text
.globl main
main:
    la $a0, greeting   # 字符串第一个字节的地址
    li $v0, 4          # $v0 = 4：打印字符串
    syscall
    li $v0, 10         # $v0 = 10：退出
    syscall`;
const NAME = `.data
greeting: .asciiz "Hello, "
bang:     .asciiz "!"
name:     .space 32         # 存放名字的缓冲区（32 字节）
.text
.globl main
main:
    la $a0, name        # 缓冲区地址
    li $a1, 32          # 最多占用 32 字节
    li $v0, 8           # $v0 = 8：读取字符串
    syscall
    la $a0, greeting
    li $v0, 4
    syscall
    la $a0, name        # 打印名字：$a0 是地址
    li $v0, 4
    syscall
    la $a0, bang
    li $v0, 4
    syscall
    li $v0, 10
    syscall`;
const OVERFLOW = `    li $t0, 0x7fffffff   # 最大的 32 位有符号整数
    addi $t0, $t0, 1     # 再加 1 会怎样？`;
const AGE = `    li $v0, 5            # $v0 = 5：读取整数，结果在 $v0
    syscall
    addi $a0, $v0, 1     # 明年的年龄
    li $v0, 1            # $v0 = 1：打印整数
    syscall`;

const traceOf = (c) => (c.state?.trace || []).filter((e) => e.step <= (c.state?.step ?? 0));
const ranFrom = (c, file) => !!c.target?.files.includes(file) && !c.dirty;
const reg = (c, name) => c.state?.registers?.find((r) => r.name === name)?.value;
const nextIsSyscall = (c, service) => {
  const p = c.state?.preview?.instruction;
  return p?.op === "syscall" && reg(c, "$v0") === service;
};

// Each step: stage, title, goal (the question), checks [label, (ctx, memo) => bool],
// hints, answer, go: [label, action name] for "show me where".
export const STEPS = [
  {
    stage: "1 · 编写、汇编、运行",
    title: "新建 hello.s",
    goal: "第一个程序放在哪里？在左侧“文件”标签里新建一个源码文件 hello.s。",
    checks: [["工程里有 hello.s", (c) => Object.hasOwn(c.files, "hello.s")]],
    hints: ["点左侧“工程文件”旁边的 ＋ 文件。", "路径填 hello.s，扩展名必须是小写 .s。"],
    go: [["打开文件标签", "side:files"]],
  },
  {
    stage: "1 · 编写、汇编、运行",
    title: "让程序打印 Hello!",
    goal: "怎样让终端显示 Hello!？在 hello.s 里写程序，然后点“汇编”，再点“完整运行”（工具栏里两个三角的图标，F5 也可以）。",
    checks: [
      ["hello.s 已汇编并装入", (c) => ranFrom(c, "hello.s")],
      ["运行结束", (c) => ranFrom(c, "hello.s") && c.state?.status === "ended"],
      ["终端里出现 Hello!", (c) => ranFrom(c, "hello.s") && (c.state?.output || "").includes("Hello!")],
    ],
    hints: [
      "字符串放在 .data 段，用 .asciiz 写，末尾会自动补一个 \\0。",
      "打印字符串：$v0 = 4，$a0 = 字符串的地址（用 la 取得），然后 syscall。最后用 $v0 = 10 的 syscall 退出。",
    ],
    answer: HELLO,
    go: [["查“打印字符串”", "find:打印字符串"]],
  },
  {
    stage: "2 · 输入与输出",
    title: "读取名字，输出 Hello, 名字!",
    goal: "程序怎样知道你的名字？先读取一行文字，再把 Hello,、名字和 ! 依次打印出来。运行时在底部终端输入名字。",
    checks: [
      ["程序读取了一次输入", (c) => ranFrom(c, "hello.s") && traceOf(c).some((e) => e.service === 8 && e.instruction.op === "syscall" && e.status !== "waiting-input")],
      ["终端里出现 Hello, 和你输入的名字", (c) => {
        const out = c.state?.output || "", typed = (c.state?.inputEchoes || []).map((e) => e.text ?? e.value ?? "").filter(Boolean);
        return ranFrom(c, "hello.s") && out.includes("Hello, ") && typed.some((t) => out.includes(String(t).trim()));
      }],
    ],
    hints: [
      "名字要先放进内存：在 .data 里用 .space 32 留出一块缓冲区。",
      "读取字符串：$v0 = 8，$a0 = 缓冲区地址，$a1 = 最多占用的字节数。打印名字时 $a0 仍然是这个地址。",
      "你会发现 ! 跑到了下一行：读取字符串时回车也被存进了缓冲区。下一阶段用调试器看清楚。",
    ],
    answer: NAME,
    doneNote: "! 换到了下一行，是因为读取字符串时回车（\\n）也存进了缓冲区。下一阶段可以在内存里看到它。",
    go: [["查“读取字符串”", "find:读取字符串"]],
  },
  {
    stage: "3 · 断点与检查",
    title: "停在打印名字之前",
    goal: "打印名字之前，哪个寄存器决定输出什么？在打印名字的那个 syscall 行设断点，然后运行到那里。",
    checks: [
      ["设置了断点", (c) => c.breakpoints.some((b) => b.address != null)],
      ["停在一个打印字符串（$v0 = 4）的 syscall 之前", (c) => /^Breakpoint/.test(c.state?.stopReason || "") && nextIsSyscall(c, 4)],
    ],
    hints: ["点行号左边的空白处，或把光标放在那一行按 F9。", "打印名字的 syscall 前面一行是 li $v0, 4，再前面是 la $a0, name。"],
    go: [["打开断点标签", "side:stops"]],
  },
  {
    stage: "3 · 断点与检查",
    title: "看懂这个 syscall",
    goal: "悬停在 syscall 上看简短说明，再点“查看详细”（或 Cmd/Ctrl＋点击）打开右侧的详细检查。它要的参数是什么？",
    checks: [["右侧详细检查显示了这个 syscall", (c) => c.inspecting === "syscall"]],
    hints: ["详细检查里有“做什么 → 需要的参数 → 发生什么 → 变化”。", "打印字符串时，$a0 是地址，不是字符串本身。"],
    go: [["展开详细检查", "panel:context"]],
  },
  {
    stage: "3 · 断点与检查",
    title: "顺着地址找到名字",
    goal: "$a0 的值指向哪里？在寄存器面板点 $a0，选“作为地址查看”，在内存里找到你输入的名字。",
    checks: [["内存面板显示的是 $a0 指向的地方", (c) => {
      const a = reg(c, "$a0") >>> 0, base = (c.state?.memoryBase ?? -1) >>> 0;
      return a >= base && a < base + (c.state?.memory?.length || 0);
    }]],
    hints: ["寄存器面板里点 $a0，右侧详细检查会出现“作为地址查看”。", "名字后面那个 0a 字节就是回车（\\n），最后的 00 是 \\0。"],
    go: [["查看 $a0", "inspect:$a0"]],
  },
  {
    stage: "3 · 断点与检查",
    title: "在专注模式里执行它",
    goal: "执行这个 syscall 时，哪个寄存器被读、终端多了什么？打开专注模式（底部 ◎ 专注），按 Shift+↓ 执行一行。",
    checks: [["在专注模式里执行了一个 syscall", (c, memo) => memo.lensSyscall]],
    hints: ["专注模式里 ←→ 逐条看解释，? 看为什么。", "执行后终端会闪一下，表示有新的输出。"],
    go: [["打开专注模式", "focus"]],
  },
  {
    stage: "4 · 找到并修好一个错误",
    title: "让计算越界",
    goal: "在最后退出之前加上下面两行，再汇编运行。程序会怎样？读一读错误信息。",
    checks: [["程序因为溢出停下", (c, memo) => memo.overflowStep != null]],
    hints: ["把上面两行放在 li $v0, 10 之前。", "0x7fffffff 是 32 位有符号整数能表示的最大值。"],
    code: OVERFLOW,
  },
  {
    stage: "4 · 找到并修好一个错误",
    title: "看出错前的数值",
    goal: "出错的那一行执行前，$t0 是多少？按“回退”退回去，在出错的那一行打开详细检查。",
    checks: [
      ["回退到出错之前", (c, memo) => memo.overflowStep != null && (c.state?.step ?? Infinity) < memo.overflowStep],
      ["查看了那一行指令的详细检查", (c) => !!c.inspecting && !c.inspecting.startsWith("$") && c.inspecting !== "syscall"],
    ],
    hints: ["工具栏的 ↶（Shift+F9）是回退一步。", "详细检查的“执行前数值”就是答案。"],
  },
  {
    stage: "4 · 找到并修好一个错误",
    title: "用观察点找到写入",
    goal: "是哪一行把这个值写进 $t0 的？在“断点”标签添加对 $t0 的写入观察点，然后重新运行。",
    checks: [
      ["有 $t0 的写入观察点", (c) => c.watches.some((w) => w.register === "$t0" && w.access === "write")],
      ["观察点让程序停下", (c) => /^Watchpoint/.test(c.state?.stopReason || "")],
    ],
    hints: ["“观察点”旁边的 ＋，目标填 $t0，类型选写入。", "也可以在寄存器 $t0 的详细检查里点“运行到下次写入”。"],
    go: [["打开断点标签", "side:stops"]],
  },
  {
    stage: "4 · 找到并修好一个错误",
    title: "修好它，并验证结果",
    goal: "把 addi 换成 addiu 只会让它不再报错，结果却变成负数——那不是修好。把初值改成一个加 1 不会越界的数，运行到结束，确认 $t0 的结果正确。",
    checks: [["运行到结束，没有错误", (c) => c.state?.status === "ended" && !c.state?.error],
      ["$t0 的加 1 没有越界（结果等于原值 + 1）", (c, memo) => memo.fixed === true]],
    hints: ["用详细检查对比“执行前数值”和“结果”。", "例如 li $t0, 41，再加 1 应该得到 42。"],
    fail: (c, memo) => (memo.fixed === false ? "运行没有报错，但结果和“原值 + 1”不一样：溢出还在，只是被忽略了。" : ""),
  },
  {
    stage: "5 · 自己加一个功能",
    title: "读取年龄，输出明年的年龄",
    goal: "在问候之后，再读取一个整数作为年龄，打印明年的年龄。自己汇编、运行并检查。",
    checks: [["读取了一个整数，并打印出它加 1 的结果", (c) => {
      const read = traceOf(c).filter((e) => e.service === 5 && e.instruction.op === "syscall").map((e) => e.accesses.find((a) => a.write && a.name === "$v0")?.value).filter((v) => v != null);
      return read.some((n) => (c.state?.output || "").includes(String(n + 1)));
    }]],
    hints: ["读取整数：$v0 = 5，读到的数会放在 $v0。", "打印整数：$v0 = 1，要打印的数放在 $a0。"],
    answer: AGE,
    go: [["查“读取整数”", "find:读取整数"]],
  },
  {
    stage: "5 · 自己加一个功能",
    title: "导出你的工程",
    goal: "把你的程序保存到电脑：工程菜单 → 导出到电脑…，选 ZIP 或 JSON。",
    checks: [["导出了工程", (c, memo) => memo.exported]],
    hints: ["导出的文件可以重新打开，或交给老师。"],
    go: [["打开工程菜单", "menu:project"]],
  },
];

export class Tutorial {
  constructor(host) {
    this.host = host;
    this.memo = {};
    this.index = 0;
    this.shown = 0;
    this.answer = false;
    document.body.insertAdjacentHTML(
      "beforeend",
      `<section id="tutorial" class="tutorial" role="complementary" aria-label="入门练习" hidden></section>`,
    );
    this.el = document.getElementById("tutorial");
    try {
      const saved = JSON.parse(localStorage.getItem("tutorial") || "null");
      if (saved?.active) {
        Object.assign(this, { index: saved.index || 0, memo: saved.memo || {}, collapsed: !!saved.collapsed });
        this.active = true;
      }
    } catch {}
  }
  save() {
    try {
      localStorage.setItem("tutorial", JSON.stringify({ active: this.active, index: this.index, memo: this.memo, collapsed: this.collapsed }));
    } catch {}
  }
  start() {
    this.active = true;
    this.index = 0;
    this.memo = {};
    this.shown = 0;
    this.answer = false;
    this.collapsed = false;
    this.save();
    this.update();
  }
  stop() {
    this.active = false;
    this.save();
    this.el.hidden = true;
  }
  // Facts the checks remember across states: an overflow happened at step N;
  // a syscall ran while focus mode was open; the fix kept arithmetic exact.
  observe(c) {
    const s = c.state;
    if (!s) return;
    const last = s.last;
    if (s.status === "error" && /overflow/i.test(s.error || last?.error || "")) this.memo.overflowStep = s.step;
    if (c.lensOpen && last?.instruction?.op === "syscall" && s.step !== this.memo.lensFrom) this.memo.lensSyscall = true;
    if (!c.lensOpen) this.memo.lensFrom = s.step;
    if (s.status === "ended" && !s.error) {
      const adds = (s.trace || []).filter((e) => /^addi?u?$/.test(e.instruction.op) && e.accesses.some((a) => a.write && a.name === "$t0"));
      const e = adds.at(-1);
      if (e) {
        const before = e.accesses.find((a) => !a.write && a.name === "$t0")?.value,
          after = e.accesses.find((a) => a.write && a.name === "$t0")?.value,
          imm = (e.instruction.binary << 16) >> 16;
        if (before != null && /i/.test(e.instruction.op)) this.memo.fixed = before + imm === after;
      }
    }
  }
  update() {
    if (!this.active) return (this.el.hidden = true);
    const c = this.host.context();
    this.observe(c);
    const step = STEPS[this.index],
      results = step.checks.map(([label, f]) => [label, !!f(c, this.memo)]),
      done = results.every(([, ok]) => ok),
      fail = step.fail?.(c, this.memo) || "";
    if (done && !this.memo["done" + this.index]) this.memo["done" + this.index] = true;
    this.save();
    this.el.hidden = false;
    this.el.classList.toggle("collapsed", !!this.collapsed);
    const progress = `${this.index + 1}/${STEPS.length}`;
    if (this.collapsed) {
      this.el.innerHTML = `<button class="tutorial-pill" data-t="expand">入门练习 ${progress}${done ? " ✓" : ""}</button>`;
    } else
      this.el.innerHTML = `<header><b>入门练习</b><span>阶段 ${esc(step.stage)} · ${progress}</span><button data-t="collapse" aria-label="收起">—</button><button data-t="exit" aria-label="退出练习">×</button></header>
      <h4>${esc(step.title)}</h4><p class="tutorial-goal">${esc(step.goal)}</p>
      <ul class="tutorial-checks">${results.map(([label, ok]) => `<li class="${ok ? "ok" : ""}">${ok ? "✓" : "○"} ${esc(label)}</li>`).join("")}</ul>
      ${fail ? `<p class="tutorial-fail" role="alert">${esc(fail)}</p>` : ""}
      ${done && step.doneNote ? `<p class="tutorial-hint">${esc(step.doneNote)}</p>` : ""}
      ${step.code ? `<pre class="tutorial-answer">${esc(step.code)}</pre>` : ""}
      ${step.hints.slice(0, this.shown).map((h, i) => `<p class="tutorial-hint">提示 ${i + 1}：${esc(h)}</p>`).join("")}
      ${this.answer && step.answer ? `<p class="tutorial-hint">参考答案（对照着自己写，不会自动填入）：</p><pre class="tutorial-answer">${esc(step.answer)}</pre>` : ""}
      <div class="tutorial-go">${(step.go || []).map(([label, action]) => `<button data-go="${esc(action)}">${esc(label)}</button>`).join("")}</div>
      <div class="tutorial-actions">${this.shown < step.hints.length ? `<button data-t="hint">${this.shown ? "再给一点提示" : "提示"}</button>` : ""}${step.answer && !this.answer ? `<button data-t="answer">参考答案</button>` : ""}<span></span><button data-t="prev" ${this.index ? "" : "disabled"}>上一步</button>${done ? `<button class="primary" data-t="next">${this.index === STEPS.length - 1 ? "完成" : "下一步"}</button>` : `<button data-t="skip" title="不检查，直接看下一步">跳过</button>`}</div>`;
    this.el.querySelectorAll("[data-t]").forEach((b) => (b.onclick = () => this.act(b.dataset.t)));
    this.el.querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => this.host.go(b.dataset.go)));
  }
  act(a) {
    if (a === "hint") this.shown++;
    else if (a === "answer") this.answer = true;
    else if (a === "collapse" || a === "expand") this.collapsed = a === "collapse";
    else if (a === "exit") return this.host.finish(false);
    else if (a === "prev" || a === "next" || a === "skip") {
      if (a === "next" && this.index === STEPS.length - 1) return this.host.finish(true);
      this.index = Math.max(0, Math.min(STEPS.length - 1, this.index + (a === "prev" ? -1 : 1)));
      this.shown = 0;
      this.answer = false;
    }
    this.save();
    this.update();
  }
}
