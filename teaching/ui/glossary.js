// Terms the IDE itself uses, with the mechanism they name (2026-10-22 trial,
// C1). Definitions say what a thing is, never what a program uses it for —
// intent comes from the program's own comments. Teachers may edit this list.
import { escapeHTML as esc } from "./model.js";

// Each definition ends with a small generic example (round-3 trial: bare
// definitions such as "基址：计算地址时用作起点的寄存器值" were still opaque).
export const glossary = {
  字节: "内存的基本单位，8 位，能表示 0–255 的一个数。例如字符 h 占 1 个字节，存的是 104。",
  地址: "内存中每个字节的编号，像门牌号。例如 0x10010000 是数据区的第一个字节。",
  有效地址:
    "一条指令真正要访问的内存地址，等于基址加偏移。例如 lw $t0, 4($s0) 中，若 $s0 = 0x10010000，有效地址就是 0x10010004。",
  伪指令:
    "汇编器提供的便捷写法，汇编时会换成一条或多条真正的机器指令。例如 move $t0, $a1 实际执行的是 addu $t0, $a1, $zero。",
  机器指令:
    "CPU 真正执行的指令，每条 32 位（4 字节）。“实际指令”视图里列出的就是它们。",
  延迟分支:
    "MIPS 的一种执行方式：跳转或分支指令后面紧跟的那一条，无论是否跳转都会先执行。例如 jal f 后面那一行会在进入 f 之前执行。",
  延迟槽:
    "开启延迟分支时，紧跟在跳转或分支指令后面、总会被执行的那个位置。程序常在这里放 nop，这样两种设置下结果相同。",
  符号扩展:
    "把较短的数扩成 32 位时，用它的最高位填满高位，负数仍然是负数。例如字节 0xf0（最高位是 1）扩成 0xfffffff0，也就是 −16。",
  零扩展:
    "把较短的数扩成 32 位时，高位一律填 0。例如字节 0xf0 扩成 0x000000f0，也就是 240。",
  小端序:
    "多字节的数在内存里，低位字节放在低地址。例如 7 存成 07 00 00 00，−2 存成 fe ff ff ff。",
  补码: "有符号整数的二进制表示：负数 −x 存成 2³² − x，所以最高位为 1 的数是负数。例如 −2 存成 0xfffffffe。",
  NUL: "值为 0 的字节，写作 \\0。字符串常用它标记结尾：读到它就表示字符串结束了。",
  立即数: "直接写在指令里的常数。例如 addiu $t0, $t0, 4 里的 4。",
  基址: "计算内存地址时用作起点的寄存器值。例如 lw $t0, 4($s0) 中 $s0 是基址。",
  偏移: "加在基址上的常数，得到要访问的地址。例如 lw $t0, 4($s0) 中 4 是偏移，0($s0) 表示偏移为 0，也就是正好在基址那里。",
  寄存器:
    "CPU 内部的 32 个存储位置，每个放 32 位，像 32 个有名字的变量。例如 $t0、$a0、$sp。",
  syscall:
    "请求运行环境（这里是 MARS）提供服务，例如输出、输入、读文件；由 $v0 的编号选择哪种服务，参数放在 $a0 等寄存器里。例如 $v0 = 11 是打印 $a0 里的字符。",
  溢出: "运算结果超出了 32 位能表示的范围。例如 0x7fffffff + 1 用有符号数表示不下。",
  对齐: "地址是访问宽度的整数倍。例如读 4 字节（lw）时地址必须是 4 的倍数，所以相邻的字之间地址差 4。",
  返回地址:
    "函数结束后要回到的那条指令的地址。jal 在跳进函数时把它存进 $ra，函数末尾的 jr $ra 再跳回去。",
  PC: "程序计数器：保存“下一条要执行的指令的地址”。每执行一条指令通常加 4；跳转就是把它改成别的地址。",
  字符编码:
    "用数字表示字符的约定：每个字符对应一个编号，内存里存的是编号。例如按 ASCII，h 的编号是 104。",
  ASCII:
    "最常用的字符编码表：0–127 各对应一个字符，例如 48 是 0、65 是 A、104 是 h、10 是换行。页脚“数值”旁的“?”里有完整的表。",
  十六进制:
    "以 16 为基数的写法，前缀 0x；每位是 0–9 或 a–f（10–15），两位正好表示一个字节。例如 0x68 = 6×16 + 8 = 104。",
  "rs 字段": "机器指令编码中的第一个寄存器字段（第 25–21 位）。",
  "rt 字段": "机器指令编码中的第二个寄存器字段（第 20–16 位）。",
  "rd 字段": "R 型指令编码中的目标寄存器字段（第 15–11 位）。",
};

const pattern = new RegExp(
  Object.keys(glossary)
    .sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|"),
  "g",
);

// Escaped HTML with the first use of each term marked; hover shows the definition.
export function glossify(text) {
  const seen = new Set();
  return esc(text).replace(pattern, (term) => {
    if (seen.has(term)) return term;
    seen.add(term);
    return `<abbr class="term" title="${esc(glossary[term])}">${term}</abbr>`;
  });
}

// Definitions of the terms a text uses, for places that cannot be hovered
// themselves (the editor tooltip follows the pointer).
export function termsIn(text) {
  return [...new Set(String(text).match(pattern) || [])].map((t) => [
    t,
    glossary[t],
  ]);
}
