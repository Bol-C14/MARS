import { t, localized } from "./i18n/index.js";
// Instruction and purpose search (classroom 2026-10-24): find an instruction
// or a syscall service from what one wants to do — "加法", "比较大小",
// "打印字符", "右移" — or from its name. Local data only; searching never
// changes code. MARS's own instruction list fills in what is not here.
import { serviceGuide } from "./syscalls.js";

// [op, pseudo, purpose, format, formula, example, note, keywords]
// i18n: each row's texts are ins.<op>.purpose / .formula / .note / .keywords.
const TABLE = localized(() => [
  ["add", false, t("ins.add.purpose"), "add rd, rs, rt", "rd ← rs + rt", "add $t0, $t1, $t2", t("ins.add.note"), t("ins.add.keywords")],
  ["addu", false, t("ins.addu.purpose"), "addu rd, rs, rt", "rd ← rs + rt", "addu $t0, $t1, $t2", t("ins.addu.note"), t("ins.addu.keywords")],
  ["addi", false, t("ins.addi.purpose"), "addi rt, rs, imm", "rt ← rs + imm", "addi $t0, $t0, 1", t("ins.addi.note"), t("ins.addi.keywords")],
  ["addiu", false, t("ins.addiu.purpose"), "addiu rt, rs, imm", "rt ← rs + imm", "addiu $sp, $sp, -4", t("ins.addiu.note"), t("ins.addiu.keywords")],
  ["sub", false, t("ins.sub.purpose"), "sub rd, rs, rt", "rd ← rs − rt", "sub $t0, $t1, $t2", t("ins.sub.note"), t("ins.sub.keywords")],
  ["subu", false, t("ins.subu.purpose"), "subu rd, rs, rt", "rd ← rs − rt", "subu $t0, $t1, $t2", t("ins.subu.note"), t("ins.subu.keywords")],
  ["mult", false, t("ins.mult.purpose"), "mult rs, rt", "HI:LO ← rs × rt", "mult $t0, $t1", t("ins.mult.note"), t("ins.mult.keywords")],
  ["multu", false, t("ins.multu.purpose"), "multu rs, rt", "HI:LO ← rs × rt", "multu $t0, $t1", t("ins.multu.note"), t("ins.multu.keywords")],
  ["mul", false, t("ins.mul.purpose"), "mul rd, rs, rt", t("ins.mul.formula"), "mul $t0, $t1, $t2", t("ins.mul.note"), t("ins.mul.keywords")],
  ["div", false, t("ins.div.purpose"), "div rs, rt", t("ins.div.formula"), "div $t0, $t1", t("ins.div.note"), t("ins.div.keywords")],
  ["divu", false, t("ins.divu.purpose"), "divu rs, rt", t("ins.divu.formula"), "divu $t0, $t1", t("ins.divu.note"), t("ins.divu.keywords")],
  ["mfhi", false, t("ins.mfhi.purpose"), "mfhi rd", "rd ← HI", "mfhi $t0", "", t("ins.mfhi.keywords")],
  ["mflo", false, t("ins.mflo.purpose"), "mflo rd", "rd ← LO", "mflo $t0", "", t("ins.mflo.keywords")],
  ["and", false, t("ins.and.purpose"), "and rd, rs, rt", "rd ← rs & rt", "and $t0, $t1, $t2", t("ins.and.note"), t("ins.and.keywords")],
  ["andi", false, t("ins.andi.purpose"), "andi rt, rs, imm", "rt ← rs & imm", "andi $t0, $t0, 0xff", t("ins.andi.note"), t("ins.andi.keywords")],
  ["or", false, t("ins.or.purpose"), "or rd, rs, rt", "rd ← rs | rt", "or $t0, $t1, $t2", t("ins.or.note"), t("ins.or.keywords")],
  ["ori", false, t("ins.ori.purpose"), "ori rt, rs, imm", "rt ← rs | imm", "ori $t0, $zero, 5", t("ins.ori.note"), t("ins.ori.keywords")],
  ["xor", false, t("ins.xor.purpose"), "xor rd, rs, rt", "rd ← rs ^ rt", "xor $t0, $t1, $t2", t("ins.xor.note"), t("ins.xor.keywords")],
  ["xori", false, t("ins.xori.purpose"), "xori rt, rs, imm", "rt ← rs ^ imm", "xori $t0, $t0, 1", t("ins.xori.note"), t("ins.xori.keywords")],
  ["nor", false, t("ins.nor.purpose"), "nor rd, rs, rt", "rd ← ~(rs | rt)", "nor $t0, $t1, $zero", t("ins.nor.note"), t("ins.nor.keywords")],
  ["not", true, t("ins.not.purpose"), "not rd, rs", "rd ← ~rs", "not $t0, $t1", t("ins.not.note"), t("ins.not.keywords")],
  ["sll", false, t("ins.sll.purpose"), "sll rd, rt, sa", "rd ← rt << sa", "sll $t0, $t0, 2", t("ins.sll.note"), t("ins.sll.keywords")],
  ["srl", false, t("ins.srl.purpose"), "srl rd, rt, sa", "rd ← rt >>> sa", "srl $t0, $t0, 4", t("ins.srl.note"), t("ins.srl.keywords")],
  ["sra", false, t("ins.sra.purpose"), "sra rd, rt, sa", "rd ← rt >> sa", "sra $t0, $t0, 1", t("ins.sra.note"), t("ins.sra.keywords")],
  ["sllv", false, t("ins.sllv.purpose"), "sllv rd, rt, rs", t("ins.sllv.formula"), "sllv $t0, $t1, $t2", "", t("ins.sllv.keywords")],
  ["srlv", false, t("ins.srlv.purpose"), "srlv rd, rt, rs", t("ins.srlv.formula"), "srlv $t0, $t1, $t2", "", t("ins.srlv.keywords")],
  ["srav", false, t("ins.srav.purpose"), "srav rd, rt, rs", t("ins.srav.formula"), "srav $t0, $t1, $t2", "", t("ins.srav.keywords")],
  ["slt", false, t("ins.slt.purpose"), "slt rd, rs, rt", "rd ← (rs < rt) ? 1 : 0", "slt $t0, $t1, $t2", t("ins.slt.note"), t("ins.slt.keywords")],
  ["sltu", false, t("ins.sltu.purpose"), "sltu rd, rs, rt", "rd ← (rs < rt) ? 1 : 0", "sltu $t0, $t1, $t2", t("ins.sltu.note"), t("ins.sltu.keywords")],
  ["slti", false, t("ins.slti.purpose"), "slti rt, rs, imm", "rt ← (rs < imm) ? 1 : 0", "slti $t0, $t1, 10", t("ins.slti.note"), t("ins.slti.keywords")],
  ["sltiu", false, t("ins.sltiu.purpose"), "sltiu rt, rs, imm", "rt ← (rs < imm) ? 1 : 0", "sltiu $t0, $t1, 10", "", t("ins.sltiu.keywords")],
  ["beq", false, t("ins.beq.purpose"), "beq rs, rt, label", t("ins.beq.formula"), "beq $t0, $zero, done", "", t("ins.beq.keywords")],
  ["bne", false, t("ins.bne.purpose"), "bne rs, rt, label", t("ins.bne.formula"), "bne $t0, $t1, loop", "", t("ins.bne.keywords")],
  ["bgez", false, t("ins.bgez.purpose"), "bgez rs, label", t("ins.bgez.formula"), "bgez $t0, positive", "", t("ins.bgez.keywords")],
  ["bgtz", false, t("ins.bgtz.purpose"), "bgtz rs, label", t("ins.bgtz.formula"), "bgtz $t0, positive", "", t("ins.bgtz.keywords")],
  ["blez", false, t("ins.blez.purpose"), "blez rs, label", t("ins.blez.formula"), "blez $t0, done", "", t("ins.blez.keywords")],
  ["bltz", false, t("ins.bltz.purpose"), "bltz rs, label", t("ins.bltz.formula"), "bltz $t0, negative", "", t("ins.bltz.keywords")],
  ["blt", true, t("ins.blt.purpose"), "blt rs, rt, label", t("ins.blt.formula"), "blt $t0, $t1, loop", t("ins.blt.note"), t("ins.blt.keywords")],
  ["bgt", true, t("ins.bgt.purpose"), "bgt rs, rt, label", t("ins.bgt.formula"), "bgt $t0, 10, over", t("ins.bgt.note"), t("ins.bgt.keywords")],
  ["ble", true, t("ins.ble.purpose"), "ble rs, rt, label", t("ins.ble.formula"), "ble $t0, $t1, loop", t("ins.ble.note"), t("ins.ble.keywords")],
  ["bge", true, t("ins.bge.purpose"), "bge rs, rt, label", t("ins.bge.formula"), "bge $t0, $t1, done", t("ins.bge.note"), t("ins.bge.keywords")],
  ["beqz", true, t("ins.beqz.purpose"), "beqz rs, label", t("ins.beqz.formula"), "beqz $t0, done", t("ins.beqz.note"), t("ins.beqz.keywords")],
  ["bnez", true, t("ins.bnez.purpose"), "bnez rs, label", t("ins.bnez.formula"), "bnez $t0, loop", t("ins.bnez.note"), t("ins.bnez.keywords")],
  ["b", true, t("ins.b.purpose"), "b label", t("ins.b.formula"), "b loop", t("ins.b.note"), t("ins.b.keywords")],
  ["j", false, t("ins.j.purpose"), "j label", "PC ← label", "j loop", "", t("ins.j.keywords")],
  ["jal", false, t("ins.jal.purpose"), "jal label", t("ins.jal.formula"), "jal print", "", t("ins.jal.keywords")],
  ["jr", false, t("ins.jr.purpose"), "jr rs", "PC ← rs", "jr $ra", "", t("ins.jr.keywords")],
  ["jalr", false, t("ins.jalr.purpose"), "jalr rd, rs", t("ins.jalr.formula"), "jalr $t9", "", t("ins.jalr.keywords")],
  ["lw", false, t("ins.lw.purpose"), "lw rt, offset(rs)", t("ins.lw.formula"), "lw $t0, 0($sp)", t("ins.lw.note"), t("ins.lw.keywords")],
  ["sw", false, t("ins.sw.purpose"), "sw rt, offset(rs)", t("ins.sw.formula"), "sw $ra, 0($sp)", t("ins.sw.note"), t("ins.sw.keywords")],
  ["lb", false, t("ins.lb.purpose"), "lb rt, offset(rs)", t("ins.lb.formula"), "lb $t0, 0($a0)", t("ins.lb.note"), t("ins.lb.keywords")],
  ["lbu", false, t("ins.lbu.purpose"), "lbu rt, offset(rs)", t("ins.lbu.formula"), "lbu $t0, 0($a0)", t("ins.lbu.note"), t("ins.lbu.keywords")],
  ["sb", false, t("ins.sb.purpose"), "sb rt, offset(rs)", t("ins.sb.formula"), "sb $t0, 0($a0)", "", t("ins.sb.keywords")],
  ["lh", false, t("ins.lh.purpose"), "lh rt, offset(rs)", t("ins.lh.formula"), "lh $t0, 0($a0)", t("ins.lh.note"), t("ins.lh.keywords")],
  ["lhu", false, t("ins.lhu.purpose"), "lhu rt, offset(rs)", t("ins.lhu.formula"), "lhu $t0, 0($a0)", t("ins.lhu.note"), t("ins.lhu.keywords")],
  ["sh", false, t("ins.sh.purpose"), "sh rt, offset(rs)", t("ins.sh.formula"), "sh $t0, 0($a0)", t("ins.sh.note"), t("ins.sh.keywords")],
  ["lui", false, t("ins.lui.purpose"), "lui rt, imm", "rt ← imm << 16", "lui $t0, 0x1001", t("ins.lui.note"), t("ins.lui.keywords")],
  ["li", true, t("ins.li.purpose"), "li rd, imm", "rd ← imm", "li $v0, 4", t("ins.li.note"), t("ins.li.keywords")],
  ["la", true, t("ins.la.purpose"), "la rd, label", t("ins.la.formula"), "la $a0, prompt", t("ins.la.note"), t("ins.la.keywords")],
  ["move", true, t("ins.move.purpose"), "move rd, rs", "rd ← rs", "move $s0, $v0", t("ins.move.note"), t("ins.move.keywords")],
  ["neg", true, t("ins.neg.purpose"), "neg rd, rs", "rd ← −rs", "neg $t0, $t1", t("ins.neg.note"), t("ins.neg.keywords")],
  ["abs", true, t("ins.abs.purpose"), "abs rd, rs", "rd ← |rs|", "abs $t0, $t1", t("ins.abs.note"), t("ins.abs.keywords")],
  ["syscall", false, t("ins.syscall.purpose"), "syscall", t("ins.syscall.formula"), "li $v0, 1\nsyscall", t("ins.syscall.note"), t("ins.syscall.keywords")],
  ["nop", false, t("ins.nop.purpose"), "nop", t("ins.nop.formula"), "nop", t("ins.nop.note"), t("ins.nop.keywords")],
]);
// Words people use for each service, beyond its name.
const SERVICE_WORDS = localized(() => ({
  1: t("ins.service.1.keywords"),
  2: t("ins.service.2.keywords"),
  3: t("ins.service.3.keywords"),
  4: t("ins.service.4.keywords"),
  5: t("ins.service.5.keywords"),
  6: t("ins.service.6.keywords"),
  7: t("ins.service.7.keywords"),
  8: t("ins.service.8.keywords"),
  9: t("ins.service.9.keywords"),
  10: t("ins.service.10.keywords"),
  11: t("ins.service.11.keywords"),
  12: t("ins.service.12.keywords"),
  13: t("ins.service.13.keywords"),
  14: t("ins.service.14.keywords"),
  15: t("ins.service.15.keywords"),
  16: t("ins.service.16.keywords"),
  17: t("ins.service.17.keywords"),
  34: t("ins.service.34.keywords"),
  35: t("ins.service.35.keywords"),
  36: t("ins.service.36.keywords"),
}));

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
      purpose: `${name}${t("common.colon")}${does}`,
      format: [`li $v0, ${n}`, ...args.map(([r, m]) => `${r} = ${m}`), "syscall"].join("\n"),
      formula: "",
      example: "",
      note: t("ins.service.note", { n }),
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
        note: t("ins.marsOriginal"),
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

// How to write an instruction, part by part (classroom 2026-10-31: "beq 是比较"
// did not say that it takes two registers and a label). The meaning of each
// operand follows from its name and the entry's formula, so no instruction
// needs its own text. `source` fills in what this line wrote for each part.
const operandsOf = (source) => {
  const code = source.replace(/#.*/, "").replace(/^\s*(?:[\w.$]+:\s*)*/, "").trim();
  const space = code.search(/\s/);
  return space < 0 ? [] : code.slice(space).split(",").map((s) => s.trim()).filter(Boolean);
};
function partMeaning(name, x, index, count) {
  const left = x.formula.split("←")[0],
    named = (text) => new RegExp(`(^|[^a-z])${name}([^a-z]|$)`).test(text);
  const branch = /^若/.test(x.formula),
    memory = /offset/.test(x.format);
  if (name === "label") {
    if (x.op === "la") return t("usage.label.address");
    return t("usage.label.target", { what: branch ? t("usage.label.branch") : t("usage.label.jump") });
  }
  if (name === "offset") return t("usage.offset");
  if (name === "imm") return t("usage.immediate");
  if (name === "sa") return t("usage.shiftAmount");
  if (branch) return count > 2 ? t("usage.compared", { side: index ? t("usage.right") : t("usage.left") }) : t("usage.comparedWithZero");
  if (memory && name === "rs") return t("usage.base");
  if (memory) return named(left) ? t("usage.loadTarget") : t("usage.storeSource");
  if (x.formula.includes(`PC ← ${name}`)) return t("usage.jumpRegister");
  if (named(left)) return t("usage.result");
  if (/低 5 位/.test(x.formula) && name === "rs") return t("usage.shiftRegister");
  return t("usage.operand");
}
export function usageOf(x, source = "") {
  const op = x.format.split(/\s/)[0],
    format = x.format.slice(op.length).trim();
  const names = format ? format.split(/,\s*/) : [],
    written = operandsOf(source),
    fits = written.length === names.length;
  const parts = [];
  names.forEach((name, i) => {
    const address = /^offset\(rs\)$/.test(name),
      value = fits ? written[i] : "";
    if (!address) return parts.push({ name, value, meaning: partMeaning(name, x, i, names.length) });
    const m = /^(.*)\((\$\w+)\)$/.exec(value);
    parts.push({ name: "offset", value: m ? m[1] || "0" : "", meaning: partMeaning("offset", x, i, names.length) });
    parts.push({ name: "rs", value: m ? m[2] : "", meaning: partMeaning("rs", x, i, names.length) });
  });
  return { format: x.format, formula: x.formula, example: x.example, parts };
}

// [how it is written, what it does]; shown like an instruction's details.
export const directiveGuide = localized(() => ({
  ".data": [".data", t("directive.data")],
  ".text": [".text", t("directive.text")],
  ".globl": [t("directive.globl.syntax"), t("directive.globl")],
  ".word": [t("directive.word.syntax"), t("directive.word")],
  ".half": [t("directive.half.syntax"), t("directive.half")],
  ".byte": [t("directive.byte.syntax"), t("directive.byte")],
  ".space": [t("directive.space.syntax"), t("directive.space")],
  ".ascii": [`${t("directive.ascii.syntax")} "${t("directive.text.word")}"`, t("directive.ascii")],
  ".asciiz": [`${t("directive.asciiz.syntax")} "${t("directive.text.word")}"`, t("directive.asciiz")],
  ".align": [".align n", t("directive.align")],
  ".float": [t("directive.float.syntax"), t("directive.float")],
  ".double": [t("directive.double.syntax"), t("directive.double")],
  ".eqv": [t("directive.eqv.syntax"), t("directive.eqv")],
  ".include": [`.include "${t("directive.include.file")}"`, t("directive.include")],
  ".macro": [t("directive.macro.syntax"), t("directive.macro")],
  ".end_macro": [".end_macro", t("directive.endMacro")],
  ".extern": [t("directive.extern.syntax"), t("directive.extern")],
  ".kdata": [".kdata", t("directive.kdata")],
  ".ktext": [".ktext", t("directive.ktext")],
}));
