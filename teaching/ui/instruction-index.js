// Instruction and purpose search (classroom 2026-10-24): find an instruction
// or a syscall service from what one wants to do — "加法", "比较大小",
// "打印字符", "右移" — or from its name. Local data only; searching never
// changes code. MARS's own instruction list fills in what is not here.
import { serviceGuide } from "./syscalls.js";

// [op, pseudo, purpose, format, formula, example, note, keywords]
const TABLE = [
  ["add", false, "两个寄存器相加", "add rd, rs, rt", "rd ← rs + rt", "add $t0, $t1, $t2", "有符号；溢出时触发异常", "加法 相加 求和 加 plus sum"],
  ["addu", false, "两个寄存器相加，不检查溢出", "addu rd, rs, rt", "rd ← rs + rt", "addu $t0, $t1, $t2", "溢出不触发异常，常用于地址和无符号数", "加法 相加 求和 无符号 地址"],
  ["addi", false, "寄存器加一个常数", "addi rt, rs, imm", "rt ← rs + imm", "addi $t0, $t0, 1", "立即数为 16 位有符号数；溢出时触发异常", "加法 加常数 自增 加一 立即数 计数"],
  ["addiu", false, "寄存器加一个常数，不检查溢出", "addiu rt, rs, imm", "rt ← rs + imm", "addiu $sp, $sp, -4", "立即数为 16 位有符号数；溢出不触发异常", "加法 加常数 自增 栈 立即数 计数"],
  ["sub", false, "两个寄存器相减", "sub rd, rs, rt", "rd ← rs − rt", "sub $t0, $t1, $t2", "有符号；溢出时触发异常", "减法 相减 差 减"],
  ["subu", false, "两个寄存器相减，不检查溢出", "subu rd, rs, rt", "rd ← rs − rt", "subu $t0, $t1, $t2", "溢出不触发异常", "减法 相减 差 无符号 取反"],
  ["mult", false, "有符号乘法，64 位结果放进 HI 和 LO", "mult rs, rt", "HI:LO ← rs × rt", "mult $t0, $t1", "高 32 位在 HI，低 32 位在 LO，用 mfhi/mflo 取出", "乘法 相乘 乘积 乘"],
  ["multu", false, "无符号乘法，64 位结果放进 HI 和 LO", "multu rs, rt", "HI:LO ← rs × rt", "multu $t0, $t1", "按无符号数相乘", "乘法 相乘 乘积 无符号"],
  ["mul", false, "乘法，只保留低 32 位", "mul rd, rs, rt", "rd ← (rs × rt) 的低 32 位", "mul $t0, $t1, $t2", "高位被丢弃，结果可能溢出而不报错", "乘法 相乘 乘积 乘"],
  ["div", false, "有符号除法：商放进 LO，余数放进 HI", "div rs, rt", "LO ← rs ÷ rt，HI ← rs 除以 rt 的余数", "div $t0, $t1", "除数为 0 时结果没有规定", "除法 相除 商 余数 取余 取模 整除"],
  ["divu", false, "无符号除法：商放进 LO，余数放进 HI", "divu rs, rt", "LO ← rs ÷ rt，HI ← 余数", "divu $t0, $t1", "按无符号数相除", "除法 相除 商 余数 无符号"],
  ["mfhi", false, "取出 HI（乘积高位或除法余数）", "mfhi rd", "rd ← HI", "mfhi $t0", "", "余数 高位 取模 hi"],
  ["mflo", false, "取出 LO（乘积低位或除法的商）", "mflo rd", "rd ← LO", "mflo $t0", "", "商 低位 乘积 lo"],
  ["and", false, "按位与", "and rd, rs, rt", "rd ← rs & rt", "and $t0, $t1, $t2", "两位都是 1 才得 1", "与 按位与 掩码 清零"],
  ["andi", false, "和常数按位与", "andi rt, rs, imm", "rt ← rs & imm", "andi $t0, $t0, 0xff", "立即数零扩展；常用来取出低几位", "与 按位与 掩码 取低位 取字节 清零"],
  ["or", false, "按位或", "or rd, rs, rt", "rd ← rs | rt", "or $t0, $t1, $t2", "有一位是 1 就得 1", "或 按位或 置位 合并"],
  ["ori", false, "和常数按位或", "ori rt, rs, imm", "rt ← rs | imm", "ori $t0, $zero, 5", "立即数零扩展", "或 按位或 置位 常数"],
  ["xor", false, "按位异或", "xor rd, rs, rt", "rd ← rs ^ rt", "xor $t0, $t1, $t2", "两位不同得 1", "异或 按位异或 翻转 比较是否相同"],
  ["xori", false, "和常数按位异或", "xori rt, rs, imm", "rt ← rs ^ imm", "xori $t0, $t0, 1", "立即数零扩展", "异或 翻转"],
  ["nor", false, "按位或非", "nor rd, rs, rt", "rd ← ~(rs | rt)", "nor $t0, $t1, $zero", "和 $zero 做 nor 就是按位取反", "或非 取反 非"],
  ["not", true, "按位取反", "not rd, rs", "rd ← ~rs", "not $t0, $t1", "伪指令：nor rd, rs, $zero", "取反 非 按位取反"],
  ["sll", false, "逻辑左移", "sll rd, rt, sa", "rd ← rt << sa", "sll $t0, $t0, 2", "右边补 0；左移 n 位相当于乘以 2ⁿ", "左移 移位 乘2 乘以2"],
  ["srl", false, "逻辑右移", "srl rd, rt, sa", "rd ← rt >>> sa", "srl $t0, $t0, 4", "左边补 0（按无符号数）", "右移 移位 除2 无符号 取高位"],
  ["sra", false, "算术右移", "sra rd, rt, sa", "rd ← rt >> sa", "sra $t0, $t0, 1", "左边补符号位（按有符号数，正负不变）", "右移 移位 除2 有符号"],
  ["sllv", false, "按寄存器给的位数左移", "sllv rd, rt, rs", "rd ← rt << (rs 的低 5 位)", "sllv $t0, $t1, $t2", "", "左移 移位 可变"],
  ["srlv", false, "按寄存器给的位数逻辑右移", "srlv rd, rt, rs", "rd ← rt >>> (rs 的低 5 位)", "srlv $t0, $t1, $t2", "", "右移 移位 可变"],
  ["srav", false, "按寄存器给的位数算术右移", "srav rd, rt, rs", "rd ← rt >> (rs 的低 5 位)", "srav $t0, $t1, $t2", "", "右移 移位 可变 有符号"],
  ["slt", false, "比较大小：小于时得 1，否则得 0", "slt rd, rs, rt", "rd ← (rs < rt) ? 1 : 0", "slt $t0, $t1, $t2", "按有符号数比较", "比较 比较大小 小于 判断 条件"],
  ["sltu", false, "按无符号数比较大小", "sltu rd, rs, rt", "rd ← (rs < rt) ? 1 : 0", "sltu $t0, $t1, $t2", "按无符号数比较", "比较 比较大小 小于 无符号"],
  ["slti", false, "和常数比较大小", "slti rt, rs, imm", "rt ← (rs < imm) ? 1 : 0", "slti $t0, $t1, 10", "按有符号数比较", "比较 比较大小 小于 常数"],
  ["sltiu", false, "和常数按无符号数比较大小", "sltiu rt, rs, imm", "rt ← (rs < imm) ? 1 : 0", "sltiu $t0, $t1, 10", "", "比较 比较大小 小于 无符号"],
  ["beq", false, "相等就跳转", "beq rs, rt, label", "若 rs == rt，跳到 label", "beq $t0, $zero, done", "", "分支 相等 等于 判断 if 跳转 条件"],
  ["bne", false, "不相等就跳转", "bne rs, rt, label", "若 rs ≠ rt，跳到 label", "bne $t0, $t1, loop", "", "分支 不等 判断 if 循环 跳转 条件"],
  ["bgez", false, "大于等于 0 就跳转", "bgez rs, label", "若 rs ≥ 0，跳到 label", "bgez $t0, positive", "", "分支 非负 判断 正数"],
  ["bgtz", false, "大于 0 就跳转", "bgtz rs, label", "若 rs > 0，跳到 label", "bgtz $t0, positive", "", "分支 正数 判断"],
  ["blez", false, "小于等于 0 就跳转", "blez rs, label", "若 rs ≤ 0，跳到 label", "blez $t0, done", "", "分支 非正 判断"],
  ["bltz", false, "小于 0 就跳转", "bltz rs, label", "若 rs < 0，跳到 label", "bltz $t0, negative", "", "分支 负数 判断"],
  ["blt", true, "比较大小：小于就跳转", "blt rs, rt, label", "若 rs < rt，跳到 label", "blt $t0, $t1, loop", "伪指令：slt + bne", "分支 比较 比较大小 小于 循环 判断"],
  ["bgt", true, "比较大小：大于就跳转", "bgt rs, rt, label", "若 rs > rt，跳到 label", "bgt $t0, 10, over", "伪指令：slt + bne", "分支 比较 比较大小 大于 判断"],
  ["ble", true, "比较大小：小于等于就跳转", "ble rs, rt, label", "若 rs ≤ rt，跳到 label", "ble $t0, $t1, loop", "伪指令：slt + beq", "分支 比较 比较大小 小于等于 判断"],
  ["bge", true, "比较大小：大于等于就跳转", "bge rs, rt, label", "若 rs ≥ rt，跳到 label", "bge $t0, $t1, done", "伪指令：slt + beq", "分支 比较 比较大小 大于等于 判断"],
  ["beqz", true, "等于 0 就跳转", "beqz rs, label", "若 rs == 0，跳到 label", "beqz $t0, done", "伪指令：beq rs, $zero, label", "分支 零 判断 为零"],
  ["bnez", true, "不等于 0 就跳转", "bnez rs, label", "若 rs ≠ 0，跳到 label", "bnez $t0, loop", "伪指令：bne rs, $zero, label", "分支 非零 循环 判断"],
  ["b", true, "无条件跳转（分支写法）", "b label", "跳到 label", "b loop", "伪指令：bgez $zero, label", "跳转 无条件 goto 循环"],
  ["j", false, "跳转到标签", "j label", "PC ← label", "j loop", "", "跳转 无条件 goto 循环"],
  ["jal", false, "调用函数：把返回地址存进 $ra 再跳转", "jal label", "$ra ← 返回地址；PC ← label", "jal print", "", "调用 函数 子程序 call 过程"],
  ["jr", false, "跳到寄存器中的地址；jr $ra 从函数返回", "jr rs", "PC ← rs", "jr $ra", "", "返回 return 函数 跳转"],
  ["jalr", false, "调用寄存器中的地址", "jalr rd, rs", "rd ← 返回地址；PC ← rs", "jalr $t9", "", "调用 函数 指针"],
  ["lw", false, "从内存读 4 字节", "lw rt, offset(rs)", "rt ← 内存[rs + offset]", "lw $t0, 0($sp)", "地址必须是 4 的倍数", "读内存 加载 load 数组 取值 读取 字"],
  ["sw", false, "把 4 字节写进内存", "sw rt, offset(rs)", "内存[rs + offset] ← rt", "sw $ra, 0($sp)", "地址必须是 4 的倍数", "写内存 存储 store 保存 数组 字"],
  ["lb", false, "从内存读 1 字节（符号扩展）", "lb rt, offset(rs)", "rt ← 字节[rs + offset]，按符号扩展", "lb $t0, 0($a0)", "最高位是 1 时补 1", "读内存 字节 字符 加载"],
  ["lbu", false, "从内存读 1 字节（零扩展）", "lbu rt, offset(rs)", "rt ← 字节[rs + offset]，高位补 0", "lbu $t0, 0($a0)", "读字符常用它", "读内存 字节 字符 字符串 加载 无符号"],
  ["sb", false, "把最低 1 字节写进内存", "sb rt, offset(rs)", "字节[rs + offset] ← rt 的低 8 位", "sb $t0, 0($a0)", "", "写内存 字节 字符 存储"],
  ["lh", false, "从内存读 2 字节（符号扩展）", "lh rt, offset(rs)", "rt ← 半字[rs + offset]", "lh $t0, 0($a0)", "地址必须是 2 的倍数", "读内存 半字 加载"],
  ["lhu", false, "从内存读 2 字节（零扩展）", "lhu rt, offset(rs)", "rt ← 半字[rs + offset]，高位补 0", "lhu $t0, 0($a0)", "地址必须是 2 的倍数", "读内存 半字 无符号"],
  ["sh", false, "把最低 2 字节写进内存", "sh rt, offset(rs)", "半字[rs + offset] ← rt 的低 16 位", "sh $t0, 0($a0)", "地址必须是 2 的倍数", "写内存 半字 存储"],
  ["lui", false, "把常数放进高 16 位", "lui rt, imm", "rt ← imm << 16", "lui $t0, 0x1001", "低 16 位清零", "高位 常数 地址 立即数"],
  ["li", true, "把常数放进寄存器", "li rd, imm", "rd ← imm", "li $v0, 4", "伪指令：按大小展开为 addiu/ori，或 lui + ori", "常数 赋值 装入 设置 立即数 初始化"],
  ["la", true, "把标签的地址放进寄存器", "la rd, label", "rd ← label 的地址", "la $a0, prompt", "伪指令：lui + ori；得到的是地址，不是内容", "地址 字符串 数组 标签 取地址"],
  ["move", true, "复制寄存器的值", "move rd, rs", "rd ← rs", "move $s0, $v0", "伪指令：addu rd, rs, $zero", "复制 赋值 拷贝 保存"],
  ["neg", true, "取相反数", "neg rd, rs", "rd ← −rs", "neg $t0, $t1", "伪指令：sub rd, $zero, rs", "相反数 负数 取负"],
  ["abs", true, "取绝对值", "abs rd, rs", "rd ← |rs|", "abs $t0, $t1", "伪指令", "绝对值 正数"],
  ["syscall", false, "系统调用：做输入、输出或退出，做什么由 $v0 的值决定", "syscall", "按 $v0 的值做对应的事", "li $v0, 1\nsyscall", "先把对应的数放进 $v0，参数放进 $a0 等", "系统调用 打印 输入 输出 读取 退出"],
  ["nop", false, "什么也不做", "nop", "（无变化）", "nop", "常放在延迟槽里", "空 占位 延迟槽"],
];
// Words people use for each service, beyond its name.
const SERVICE_WORDS = {
  1: "打印 输出 显示 整数 数字 print int printf",
  2: "打印 输出 浮点 小数",
  3: "打印 输出 浮点 小数 双精度",
  4: "打印 输出 显示 字符串 文字 一句话 print string printf",
  5: "读取 输入 键盘 整数 数字 read int scanf",
  6: "读取 输入 浮点 小数",
  7: "读取 输入 浮点 小数 双精度",
  8: "读取 输入 键盘 字符串 名字 一行 文字 read string scanf gets",
  9: "分配 内存 堆 malloc",
  10: "退出 结束 停止 exit",
  11: "打印 输出 显示 字符 一个字符 print char putchar",
  12: "读取 输入 字符 read char getchar",
  13: "打开 文件",
  14: "读取 文件",
  15: "写入 文件",
  16: "关闭 文件",
  17: "退出 结束 返回码 exit",
  34: "打印 输出 十六进制 hex",
  35: "打印 输出 二进制 binary",
  36: "打印 输出 无符号",
};

export function instructionIndex(docs = {}) {
  const items = TABLE.map(([op, pseudo, purpose, format, formula, example, note, words]) => ({
    kind: "instruction",
    op,
    label: op,
    pseudo,
    purpose,
    format,
    formula,
    example,
    note,
    words,
  }));
  for (const [n, [name, does, args]] of Object.entries(serviceGuide))
    items.push({
      kind: "service",
      op: "syscall",
      service: Number(n),
      label: `syscall ${n} · ${name}`,
      name,
      pseudo: false,
      purpose: `${name}：${does}`,
      format: [`li $v0, ${n}`, ...args.map(([r, m]) => `${r} = ${m}`), "syscall"].join("\n"),
      formula: "",
      example: "",
      note: `先把 ${n} 放进 $v0，再执行 syscall`,
      words: `${name} ${SERVICE_WORDS[n] || ""}`,
    });
  // MARS's list covers the rest, in English.
  const known = new Set(TABLE.map((t) => t[0]));
  for (const [op, d] of Object.entries(docs))
    if (!known.has(op))
      items.push({
        kind: "instruction",
        op,
        label: op,
        pseudo: !!d.pseudo,
        purpose: d.description || "",
        format: d.example || "",
        formula: "",
        example: d.example || "",
        note: "MARS 原文说明",
        words: "",
      });
  return items;
}

const bigrams = (s) => {
  const t = s.replace(/\s+/g, "");
  return new Set(Array.from({ length: Math.max(0, t.length - 1) }, (_, i) => t.slice(i, i + 2)));
};
function score(item, query) {
  const q = query.trim().toLowerCase();
  if (!q) return -1;
  const op = item.op.toLowerCase();
  if (item.kind === "instruction" && op === q) return 1000;
  if (item.kind === "service" && (q === String(item.service) || q === `syscall ${item.service}` || q === item.name)) return 990;
  if (item.kind === "instruction" && op.startsWith(q)) return 900 - op.length;
  const text = `${item.label} ${item.purpose} ${item.words}`.toLowerCase();
  if (item.label.toLowerCase().includes(q)) return 800;
  if (text.includes(q)) return 700 - (item.kind === "service" ? 0 : 5);
  // Chinese phrases match inside the query ("比较大小" contains "比较");
  // English words only as whole words, so "sycall" is not "call".
  const typed = q.split(/\s+/),
    words = item.words.toLowerCase().split(/\s+/).filter((w) => w.length > 1),
    found = words.filter((w) => (/^[a-z]+$/.test(w) ? typed.includes(w) : q.includes(w)));
  // A saying that covers most of the query is a strong match; "字符" inside
  // "打印字符" only shares a word (round-4 trial: lb and sb crowded the list).
  if (found.length) {
    const cover = Math.min(1, found.reduce((s, w) => s + w.length, 0) / q.length);
    return cover >= 0.6 ? 500 + cover * 150 : 300 + cover * 100;
  }
  // A misspelt name: every typed letter appears in order in the name.
  if (/^[a-z]+$/.test(q) && item.kind === "instruction") {
    let j = 0;
    for (const c of op) if (c === q[j]) j++;
    if (j === q.length) return 450 - (op.length - q.length) * 10;
  }
  const qb = bigrams(q);
  if (qb.size) {
    const tb = bigrams(text);
    const shared = [...qb].filter((b) => tb.has(b)).length / qb.size;
    if (shared >= 0.5) return 300 + shared * 100;
  }
  return -1;
}
// Results best first; `weak` marks loose matches (a shared word or similar
// letters) that the dialog folds away whenever strong matches exist.
export const STRONG = 450;
export function searchInstructions(query, items, limit = 30) {
  return items
    .map((item) => ({ item, s: score(item, query) }))
    .filter((r) => r.s >= 0)
    .sort((a, b) => b.s - a.s || a.item.label.length - b.item.label.length)
    .slice(0, limit)
    .map((r) => ({ ...r.item, weak: r.s < STRONG }));
}
