export const hex = (n) => "0x" + (n >>> 0).toString(16).padStart(8, "0");
export const escapeHTML = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const registerNames = [
  "zero",
  "at",
  "v0",
  "v1",
  "a0",
  "a1",
  "a2",
  "a3",
  "t0",
  "t1",
  "t2",
  "t3",
  "t4",
  "t5",
  "t6",
  "t7",
  "s0",
  "s1",
  "s2",
  "s3",
  "s4",
  "s5",
  "s6",
  "s7",
  "t8",
  "t9",
  "k0",
  "k1",
  "gp",
  "sp",
  "fp",
  "ra",
];
export function canonicalReg(token) {
  if (/^\$\d+$/.test(token)) return "$" + registerNames[Number(token.slice(1))];
  return token === "$s8" ? "$fp" : token;
}
export const services = {
  1: ["打印整数", ["$a0"], []],
  2: ["打印单精度数", ["$f12"], []],
  3: ["打印双精度数", ["$f12", "$f13"], []],
  4: ["打印以 NUL 结束的字符串", ["$a0"], []],
  5: ["读取整数", [], ["$v0"]],
  6: ["读取单精度数", [], ["$f0"]],
  7: ["读取双精度数", [], ["$f0", "$f1"]],
  8: ["读取字符串", ["$a0", "$a1"], ["memory"]],
  9: ["分配堆内存", ["$a0"], ["$v0"]],
  10: ["退出程序", [], []],
  11: ["打印字符", ["$a0"], []],
  12: ["读取字符", [], ["$v0"]],
  13: ["打开虚拟文件", ["$a0", "$a1", "$a2"], ["$v0"]],
  14: ["读取文件", ["$a0", "$a1", "$a2"], ["memory", "$v0"]],
  15: ["写入文件", ["$a0", "$a1", "$a2"], ["$v0"]],
  16: ["关闭文件", ["$a0"], []],
  17: ["退出并返回状态码", ["$a0"], []],
  34: ["打印十六进制整数", ["$a0"], []],
  35: ["打印二进制整数", ["$a0"], []],
  36: ["打印无符号整数", ["$a0"], []],
};
export const explanations = {
  addiu:
    "读取源寄存器，将 16 位立即数符号扩展后相加，写入目标。不会因有符号溢出产生异常。",
  addi: "读取源寄存器，将符号扩展后的立即数相加；有符号溢出产生异常。",
  addu: "读取两个源寄存器，相加后写入目标，不产生有符号溢出异常。",
  add: "两个源寄存器相加；有符号溢出产生异常。",
  subu: "两个源寄存器相减，写入目标，不产生有符号溢出异常。",
  lbu: "计算基址＋偏移，读取 1 字节并零扩展为 32 位。",
  lb: "读取 1 字节并符号扩展为 32 位。",
  lw: "从有效地址读取 4 字节；地址必须按 4 字节对齐。",
  sw: "将源寄存器的 4 字节内容写入基址＋偏移地址。",
  sb: "将源寄存器低 8 位写入 1 字节内存。",
  srl: "逻辑右移，左侧补 0；移出的低位丢弃。",
  sll: "逻辑左移，右侧补 0；移出的高位丢弃。",
  slti: "有符号比较：源寄存器小于符号扩展后的立即数则写入 1，否则写入 0。",
  beq: "比较两个寄存器；相等时跳转。延迟分支开启时先执行 delay slot。",
  bne: "比较两个寄存器；不相等时跳转。",
  jal: "将返回地址写入 $ra，并调用目标；返回地址受延迟分支配置影响。",
  jr: "跳转到寄存器中存储的地址；jr $ra 常用于返回。",
  syscall: "根据 $v0 的服务编号调用 MARS 服务；参数和返回值依服务而定。",
  li: "伪指令：将立即数装入寄存器，可能展开为多条实际指令。",
  la: "伪指令：加载地址；展开可能使用 $at。",
  move: "伪指令：复制寄存器内容，不清除源寄存器。",
  nop: "不修改通用寄存器或内存；程序继续执行。",
  lui: "将 16 位立即数放入目标寄存器高 16 位，低 16 位清零。",
  ori: "源寄存器与零扩展后的立即数按位或。",
};
export function role(name) {
  let n = registerNames.indexOf(name.replace("$", ""));
  return n === 0
    ? "ISA：恒为 0，写入不提交"
    : n === 1
      ? "汇编器约定：伪指令展开临时寄存器"
      : n === 2 || n === 3
        ? "调用约定：返回值；$v0 也用于 syscall 服务编号"
        : n >= 4 && n <= 7
          ? "调用约定：参数寄存器"
          : n >= 16 && n <= 23
            ? "调用约定：被调用者保存；硬件不会自动保存"
            : n === 29
              ? "调用约定：栈指针，内容通常解释为地址"
              : n === 31
                ? "调用约定：返回地址；jal 会写入"
                : n === 28
                  ? "调用约定：全局指针"
                  : n === 30
                    ? "调用约定：帧指针／保存寄存器"
                    : n === 26 || n === 27
                      ? "约定：内核保留"
                      : "调用约定：临时寄存器；跨函数调用不保证保持";
}
export function references(files, token) {
  let out = [];
  for (let [file, text] of Object.entries(files))
    text.split("\n").forEach((line, i) => {
      let code = line.split("#")[0],
        tokens = code.match(/\$\w+|[\w.]+/g) || [];
      if (!tokens.some((t) => canonicalReg(t) === canonicalReg(token))) return;
      let op = tokens[0],
        regs = tokens.filter((t) => t.startsWith("$")),
        r = canonicalReg(token),
        k = "引用";
      if (token.startsWith("$")) {
        let occurrences = regs.map(canonicalReg),
          first = occurrences[0] === r,
          read = occurrences.slice(1).includes(r);
        if (/^(sw|sb|sh|b\w*|jr|multu?|divu?|mthi|mtlo)$/.test(op)) k = "读取";
        else if (
          /^(li|la|move|l[bhw]u?|sll|srl|sra|add\w*|sub\w*|and\w*|or\w*|xor\w*|nor|slt\w*|mfhi|mflo)$/.test(
            op,
          )
        )
          k = first ? (read ? "读取＋写入" : "写入") : "读取";
        else k = "操作数（静态）";
      } else if (
        new RegExp(
          "^\\s*" + token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*:",
        ).test(code)
      )
        k = "定义";
      else if (/^(b\w*|j|jal)$/.test(op)) k = "控制转移";
      out.push({ file, line: i + 1, text: line, type: k });
    });
  return out;
}
export function buildCFG(instructions, delay = false) {
  let by = new Map(instructions.map((i) => [i.address, i])),
    leaders = new Set();
  if (instructions[0]) leaders.add(instructions[0].address);
  for (let i of instructions)
    if (i.flow !== "next") {
      if (by.has(i.target)) leaders.add(i.target);
      let next = i.address + (delay ? 8 : 4);
      if (by.has(next)) leaders.add(next);
    }
  let blocks = [],
    current;
  for (let i of instructions) {
    if (!current || leaders.has(i.address) || i.address !== current.end + 4) {
      current = {
        id: i.address,
        start: i.address,
        end: i.address,
        instructions: [],
        edges: [],
      };
      blocks.push(current);
    }
    current.instructions.push(i);
    current.end = i.address;
  }
  let owner = new Map();
  for (let b of blocks)
    for (let i of b.instructions) owner.set(i.address, b.id);
  for (let b of blocks) {
    let terminal =
      [...b.instructions].reverse().find((i) => i.flow !== "next") ||
      b.instructions.at(-1);
    let add = (address, label) => {
      if (owner.has(address))
        b.edges.push({ target: owner.get(address), label });
    };
    if (terminal.flow === "branch") {
      add(terminal.target, "条件成立");
      add(terminal.address + (delay ? 8 : 4), "条件不成立");
    } else if (terminal.flow === "jump") add(terminal.target, "跳转");
    else if (terminal.flow === "call") {
      add(terminal.target, "调用");
      add(terminal.address + (delay ? 8 : 4), "返回后");
    } else if (terminal.flow === "indirect")
      b.edges.push({ target: null, label: "运行时目标" });
    else add(b.end + 4, "顺序");
  }
  return blocks;
}
