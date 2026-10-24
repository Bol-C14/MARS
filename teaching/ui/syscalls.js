// Per-service syscall teaching (classroom 2026-10-24): what a service does,
// which registers it reads and what they mean, what happens, and which
// registers or terminal change. Mechanism only; values come from the caller.
import { escapeByte } from "./radix.js";

// [name, what it does, [[register, meaning]], what happens, what changes]
export const serviceGuide = {
  1: ["打印整数", "把 $a0 的值按有符号十进制打印到终端。", [["$a0", "要打印的整数"]], "终端多出这个数的十进制写法，例如 45 打印成 45。", "终端；寄存器不变"],
  2: ["打印单精度数", "把 $f12 的单精度浮点数打印到终端。", [["$f12", "要打印的数"]], "终端多出这个数。", "终端；寄存器不变"],
  3: ["打印双精度数", "把 $f12/$f13 组成的双精度浮点数打印到终端。", [["$f12", "要打印的数（低位一半）"]], "终端多出这个数。", "终端；寄存器不变"],
  4: ["打印字符串", "从 $a0 给出的地址开始逐个字节打印，遇到值为 0 的字节（\\0）停下。", [["$a0", "字符串第一个字节的地址（不是字符串本身）"]], "终端多出这段文字；\\0 本身不打印。", "终端；寄存器不变"],
  5: ["读取整数", "等待在终端输入一个整数并按 Enter。", [], "读到的整数写入 $v0，覆盖原来的服务号 5。", "$v0（返回值）"],
  6: ["读取单精度数", "等待在终端输入一个浮点数。", [], "读到的数写入 $f0。", "$f0（返回值）"],
  7: ["读取双精度数", "等待在终端输入一个浮点数。", [], "读到的数写入 $f0/$f1。", "$f0、$f1（返回值）"],
  8: ["读取字符串", "等待在终端输入一行文字，把字符存进内存。", [["$a0", "缓冲区（存放输入的内存）第一个字节的地址"], ["$a1", "最多占用的字节数，含末尾的 \\0"]], "从 $a0 开始最多写入 $a1−1 个字符（含换行），末尾补 \\0。", "内存；寄存器不变"],
  9: ["分配堆内存", "在堆上留出 $a0 个字节。", [["$a0", "需要的字节数"]], "这块内存的起始地址写入 $v0。", "$v0（返回值）"],
  10: ["退出程序", "结束程序。", [], "程序停止，不再执行后面的指令。", "执行结束"],
  11: ["打印字符", "把 $a0 低 8 位按字符编码表当作一个字符打印。", [["$a0", "要打印字符的编码"]], "终端多出一个字符，例如 45 打印成 -（同样的 45 用服务 1 会打印成 45）。", "终端；寄存器不变"],
  12: ["读取字符", "等待在终端输入一个字符。", [], "这个字符的编码写入 $v0，覆盖原来的服务号 12。", "$v0（返回值）"],
  13: ["打开虚拟文件", "按 $a0 的文件名打开工程里的输入文件（不会访问电脑上的文件）。", [["$a0", "文件名字符串的地址"], ["$a1", "打开方式：0 读、1 写、9 追加"], ["$a2", "模式（忽略）"]], "文件描述符写入 $v0；打不开时为负数。", "$v0（返回值）"],
  14: ["读取文件", "从已打开的虚拟文件读取字节到内存。", [["$a0", "文件描述符"], ["$a1", "缓冲区地址"], ["$a2", "最多读取的字节数"]], "读到的字节数写入 $v0（0 表示读完，负数表示出错）。", "内存、$v0"],
  15: ["写入文件", "把内存中的字节写入已打开的虚拟文件。", [["$a0", "文件描述符"], ["$a1", "要写的数据地址"], ["$a2", "字节数"]], "写入的字节数写入 $v0。", "虚拟文件、$v0"],
  16: ["关闭文件", "关闭 $a0 指定的虚拟文件。", [["$a0", "文件描述符"]], "文件关闭。", "无"],
  17: ["退出并返回状态码", "结束程序，并把 $a0 作为退出码。", [["$a0", "退出码"]], "程序停止。", "执行结束"],
  34: ["打印十六进制整数", "把 $a0 按 8 位十六进制打印。", [["$a0", "要打印的整数"]], "终端多出 0x 开头的写法。", "终端；寄存器不变"],
  35: ["打印二进制整数", "把 $a0 按 32 位二进制打印。", [["$a0", "要打印的整数"]], "终端多出 32 个 0/1。", "终端；寄存器不变"],
  36: ["打印无符号整数", "把 $a0 按无符号十进制打印。", [["$a0", "要打印的整数"]], "终端多出这个数（不会是负数）。", "终端；寄存器不变"],
};
const printable = (b) => b >= 32 && b < 127;

// What a parameter value means for this service, e.g. 45 → '-' for service 11.
export function argumentMeaning(n, register, value) {
  if (value == null) return "";
  if (n === 11 && register === "$a0") {
    const b = value & 255;
    return printable(b) ? `编码 ${b} 是字符 '${escapeByte(b)}'` : `编码 ${b}（${escapeByte(b)}，不是可显示字符）`;
  }
  if (n === 1 && register === "$a0") return `打印出来是 ${value | 0}`;
  if (n === 36 && register === "$a0") return `打印出来是 ${value >>> 0}`;
  if ((n === 4 || n === 8 || n === 13) && register === "$a0") return "这是地址，内容在内存里";
  if ((n === 14 || n === 15) && register === "$a1") return "这是地址，内容在内存里";
  return "";
}

// The service number of a syscall line, from what is known about it, and
// where that number came from. Never the $v0 after the call: a read service
// overwrites it with the result.
//   next: the line is about to run, so the current $v0 is the service;
//   ran: the line ran, and its event kept the number from before the call;
//   source: the nearest `li $v0, N` above, within the same straight-line code.
export function serviceAt({ next, event, v0, lines = [], line = 0 }) {
  if (next) return { n: v0, from: "next" };
  if (event) return { n: event.service, from: "ran", event };
  for (let i = line - 2; i >= 0 && i >= line - 30; i--) {
    const text = lines[i].replace(/#.*/, "");
    const m = /^\s*(?:li|addiu?|ori)\s+\$(?:v0|2)\s*,\s*(?:\$(?:zero|0)\s*,\s*)?(-?(?:0x[\da-f]+|\d+))\s*$/i.exec(text);
    if (m) return { n: Number(m[1]), from: "source" };
    if (/^\s*[\w.$]+\s*:/.test(text) || /^\s*(?:j|jal|jr|jalr|b\w*)\s/.test(text) || /^\s*syscall\b/.test(text) || /\$(?:v0|2)\s*,/.test(text)) break;
  }
  return { n: null, from: "unknown" };
}
export const serviceSource = {
  next: "即将执行：服务号取自当前的 $v0",
  ran: "最近一次执行：服务号是调用前的 $v0",
  source: "按源码推测：取自上方的 li $v0, N",
  unknown: "服务号要到执行时由 $v0 决定",
};

// The detailed explanation of one syscall: what it does → its parameters with
// their values and meaning → what happened (or will) → what changes.
// `values` maps registers to the values the call reads (or null when they
// are not known yet); `event` is the recorded execution, if any.
export function syscallDetail({ n, from, values = {}, event, waiting, esc, show = String }) {
  const g = serviceGuide[n];
  const head = n == null ? "syscall · 服务号未知" : `syscall · ${g ? g[0] : "不支持的服务"}（服务 ${n}）`;
  if (n != null && !g)
    return { title: head, html: `<p>服务号 ${esc(String(n))} 不在 MARS Trace 支持的范围内（支持 ${Object.keys(serviceGuide).join("、")}），执行时会报错停下。</p>` };
  if (!g)
    return { title: head, html: `<p>syscall 按调用时 $v0 的值选择服务。这一行上方没有找到确定的 li $v0, N，要执行到这里才知道。</p>` };
  const [, does, args, effect, changes] = g;
  const arg = ([r, meaning]) => {
    const v = values[r], m = argumentMeaning(n, r, v);
    return `<li><code>${r}</code> ${esc(meaning)}${v == null ? "" : ` = <b>${esc(show(v, r))}</b>`}${m ? `<small> · ${esc(m)}</small>` : ""}</li>`;
  };
  const happened = [];
  if (waiting) happened.push("正在等待输入：请在底部终端输入后按 Enter。输入完成前 $v0 仍是服务号，不会显示虚构的结果。");
  if (event) {
    if (event.output) happened.push(`实际输出 "${esc([...event.output].map((c) => escapeByte(c.charCodeAt(0))).join(""))}"`);
    for (const a of event.accesses || [])
      if (a.write && a.kind === "register") happened.push(`${a.name} 变为 ${esc(show(a.value, a.name))}`);
    const bytes = (event.accesses || []).filter((a) => a.kind === "memory" && a.write).reduce((s, a) => s + a.width, 0);
    if (bytes) happened.push(`写入内存 ${bytes} 字节`);
    if (event.status === "waiting-input") happened.push("当时在等待输入");
  }
  return {
    title: head,
    html: `<p class="muted">${esc(serviceSource[from] || "")}</p><dl class="syscall-steps"><dt>做什么</dt><dd>${esc(does)}</dd><dt>需要的参数</dt><dd>${args.length ? `<ul>${args.map(arg).join("")}</ul>` : "无"}</dd><dt>发生什么</dt><dd>${esc(effect)}${happened.length ? `<ul>${happened.map((h) => `<li>${h}</li>`).join("")}</ul>` : ""}</dd><dt>变化</dt><dd>${esc(changes)}</dd></dl><p class="muted">调用前 $v0 是服务号；读取类服务完成后 $v0 会变成读到的结果。</p>`,
  };
}
